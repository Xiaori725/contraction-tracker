-- Run once, as the Supabase database administrator, in a NEW project.
-- No email address or service-role secret belongs in this migration.
-- Admin setup: INSERT the two approved, lower-case email addresses into
-- private.allowed_emails(email). Existing confirmed users are enrolled too.
-- Only tracker_snapshot and tracker_change are callable by authenticated users.
BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE private.allowed_emails (
    email text PRIMARY KEY,
    CONSTRAINT allowed_email_normalized CHECK
        (email = lower(btrim(email)) AND position('@' IN email) > 1)
);

CREATE TABLE private.memberships (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    space_id uuid NOT NULL DEFAULT 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21',
    CONSTRAINT only_shared_space CHECK
        (space_id = 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21'::uuid)
);

CREATE TABLE public.contractions (
    id uuid PRIMARY KEY,
    space_id uuid NOT NULL,
    start_ms bigint NOT NULL,
    end_ms bigint,
    intensity smallint,
    version bigint NOT NULL DEFAULT 1,
    deleted_ms bigint,
    operation_id uuid NOT NULL,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT contraction_space CHECK
        (space_id = 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21'::uuid),
    CONSTRAINT contraction_start_safe CHECK
        (start_ms BETWEEN 946684800000 AND 253402300799999),
    CONSTRAINT contraction_end_safe CHECK
        (end_ms IS NULL OR (end_ms BETWEEN start_ms AND 253402300799999)),
    CONSTRAINT contraction_strength CHECK (intensity BETWEEN 1 AND 3),
    CONSTRAINT contraction_version_safe CHECK (version BETWEEN 1 AND 9007199254740991),
    CONSTRAINT contraction_deleted_safe CHECK
        (deleted_ms IS NULL OR deleted_ms BETWEEN 946684800000 AND 253402300799999)
);

CREATE UNIQUE INDEX contractions_one_active_per_space
    ON public.contractions(space_id)
    WHERE end_ms IS NULL AND deleted_ms IS NULL;
CREATE INDEX contractions_visible_order
    ON public.contractions(space_id, start_ms DESC, id DESC)
    WHERE deleted_ms IS NULL;

-- Preserve every successful operation, including operations on deleted records.
-- Never trim this log while clients may retry its operation IDs.
CREATE TABLE private.operation_log (
    space_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, operation_id),
    CONSTRAINT operation_space CHECK
        (space_id = 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21'::uuid)
);

ALTER TABLE public.contractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.allowed_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.operation_log ENABLE ROW LEVEL SECURITY;
-- Deliberately no direct-access policies. RPC owners perform authorization.
REVOKE ALL ON TABLE public.contractions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.reconcile_memberships()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21', 0));
    DELETE FROM private.memberships AS m
    WHERE NOT EXISTS (
        SELECT 1 FROM auth.users AS u
        JOIN private.allowed_emails AS a ON a.email = lower(btrim(u.email))
        WHERE u.id = m.user_id AND u.email_confirmed_at IS NOT NULL
    );
    INSERT INTO private.memberships(user_id, space_id)
    SELECT u.id, 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21'::uuid
    FROM auth.users AS u
    JOIN private.allowed_emails AS a ON a.email = lower(btrim(u.email))
    WHERE u.email_confirmed_at IS NOT NULL
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NULL;
END;
$$;

CREATE FUNCTION private.guard_allowed_emails()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21', 0));
    NEW.email := lower(btrim(NEW.email));
    IF TG_OP = 'UPDATE' THEN
        SELECT count(*) INTO v_count FROM private.allowed_emails
        WHERE email <> OLD.email AND email <> NEW.email;
    ELSE
        SELECT count(*) INTO v_count FROM private.allowed_emails
        WHERE email <> NEW.email;
    END IF;
    IF v_count >= 2 THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = '最多允许两个邮箱访问此共享记录。';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tracker_allowlist_limit
    BEFORE INSERT OR UPDATE ON private.allowed_emails
    FOR EACH ROW EXECUTE FUNCTION private.guard_allowed_emails();
CREATE TRIGGER tracker_allowlist_memberships
    AFTER INSERT OR UPDATE OR DELETE ON private.allowed_emails
    FOR EACH STATEMENT EXECUTE FUNCTION private.reconcile_memberships();
CREATE TRIGGER tracker_auth_memberships
    AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
    FOR EACH ROW EXECUTE FUNCTION private.reconcile_memberships();

-- Check authoritative auth.users every time; JWT email and stale memberships
-- alone are never sufficient. Revocation and email changes take effect at once.
CREATE FUNCTION private.require_tracker_space()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_space uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '请先登录。';
    END IF;
    SELECT m.space_id INTO v_space
    FROM private.memberships AS m
    JOIN auth.users AS u ON u.id = m.user_id
    JOIN private.allowed_emails AS a ON a.email = lower(btrim(u.email))
    WHERE m.user_id = auth.uid() AND u.email_confirmed_at IS NOT NULL;
    IF v_space IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = '当前邮箱未获得访问权限，或尚未完成邮箱验证。';
    END IF;
    RETURN v_space;
END;
$$;

CREATE FUNCTION private.json_integer(p_data jsonb, p_key text, p_required boolean)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_text text; v_number numeric;
BEGIN
    IF NOT (p_data ? p_key) OR p_data -> p_key = 'null'::jsonb THEN
        IF p_required THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '缺少整数参数：' || p_key;
        END IF;
        RETURN NULL;
    END IF;
    v_text := p_data ->> p_key;
    IF jsonb_typeof(p_data -> p_key) <> 'number'
       OR v_text !~ '^[0-9]{1,16}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '无效的整数参数：' || p_key;
    END IF;
    v_number := v_text::numeric;
    IF v_number > 9007199254740991 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '整数超出安全范围：' || p_key;
    END IF;
    RETURN v_number::bigint;
END;
$$;

CREATE FUNCTION public.tracker_snapshot(
    p_limit integer DEFAULT 50,
    p_before bigint DEFAULT NULL,
    p_before_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_space uuid; v_result jsonb;
BEGIN
    v_space := private.require_tracker_space();
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000
       OR ((p_before IS NULL) <> (p_before_id IS NULL))
       OR (p_before IS NOT NULL AND
           (p_before < 946684800000 OR p_before > 253402300799999)) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '无效的分页参数。';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(v_space::text, 0));
    PERFORM private.require_tracker_space();
    -- LAG is evaluated before filtering the cursor or limiting the page.
    -- One SQL statement gives the history and active record a common snapshot.
    WITH visible AS MATERIALIZED (
        SELECT c.id, c.start_ms, c.end_ms, c.intensity, c.version,
               c.deleted_ms, c.operation_id, c.created_by,
               lag(c.start_ms) OVER (ORDER BY c.start_ms, c.id) AS previous_start,
               lag(c.end_ms) OVER (ORDER BY c.start_ms, c.id) AS previous_end
        FROM public.contractions AS c
        WHERE c.space_id = v_space AND c.deleted_ms IS NULL
    ), candidates AS MATERIALIZED (
        SELECT * FROM visible
        WHERE end_ms IS NOT NULL
          AND (p_before IS NULL OR (start_ms, id) < (p_before, p_before_id))
        ORDER BY start_ms DESC, id DESC
        LIMIT p_limit + 1
    ), page AS MATERIALIZED (
        SELECT * FROM candidates ORDER BY start_ms DESC, id DESC LIMIT p_limit
    )
    SELECT jsonb_build_object(
        'records', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.start_ms DESC, p.id DESC)
                             FROM page AS p), '[]'::jsonb),
        'active', (SELECT to_jsonb(v) FROM visible AS v WHERE v.end_ms IS NULL),
        'next', CASE WHEN (SELECT count(*) FROM candidates) > p_limit THEN
            (SELECT jsonb_build_object('start_ms', p.start_ms, 'id', p.id)
             FROM page AS p ORDER BY p.start_ms, p.id LIMIT 1)
            ELSE NULL END,
        'server_now', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        'space_id', v_space
    ) INTO v_result;
    RETURN v_result;
END;
$$;

CREATE FUNCTION public.tracker_change(p_change jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_space uuid;
    v_user uuid;
    v_action text;
    v_id uuid;
    v_operation uuid;
    v_version bigint;
    v_start bigint;
    v_end bigint;
    v_intensity bigint;
    v_now bigint;
    v_row public.contractions%ROWTYPE;
    v_saved private.operation_log%ROWTYPE;
    v_active jsonb;
    v_response jsonb;
BEGIN
    v_space := private.require_tracker_space();
    v_user := auth.uid();
    IF p_change IS NULL OR jsonb_typeof(p_change) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '操作必须是 JSON 对象。';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_change) AS k(key)
               WHERE key NOT IN ('action','id','operation_id','version','start_ms','end_ms','intensity')) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '操作包含未知参数。';
    END IF;
    v_action := p_change ->> 'action';
    IF v_action IS NULL OR v_action NOT IN ('start','finish','strength','edit','delete') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '无效的操作类型。';
    END IF;
    IF jsonb_typeof(p_change -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_change -> 'operation_id') IS DISTINCT FROM 'string'
       OR (p_change ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (p_change ->> 'operation_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '记录和操作必须带有有效 UUID。';
    END IF;
    v_id := (p_change ->> 'id')::uuid;
    v_operation := (p_change ->> 'operation_id')::uuid;

    -- All cooperating writes serialize on the shared space, not on a user or row.
    -- This also protects overlap checks and operation-log insertions from races.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_space::text, 0));
    PERFORM private.require_tracker_space();
    v_now := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;

    SELECT * INTO v_saved FROM private.operation_log
    WHERE space_id = v_space AND operation_id = v_operation;
    IF FOUND THEN
        IF v_saved.request IS DISTINCT FROM p_change OR v_saved.requested_by IS DISTINCT FROM v_user THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409',
                MESSAGE = '此操作编号已被使用，请勿修改待重试操作的内容。';
        END IF;
        -- The original commit is acknowledged even if the record was later
        -- edited/deleted. Call snapshot after mutations for the latest state.
        RETURN v_saved.response || jsonb_build_object('replayed', true);
    END IF;

    v_start := private.json_integer(p_change, 'start_ms', v_action IN ('start','edit'));
    v_end := private.json_integer(p_change, 'end_ms', v_action IN ('finish','edit'));
    v_version := private.json_integer(p_change, 'version', v_action <> 'start');
    v_intensity := private.json_integer(p_change, 'intensity', false);
    IF v_intensity IS NOT NULL AND v_intensity NOT IN (1,2,3) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '强度必须是 1、2、3 或空值。';
    END IF;
    IF v_action = 'strength' AND NOT (p_change ? 'intensity') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '请选择强度，或明确设为空值。';
    END IF;
    IF v_version IS NOT NULL AND (v_version < 1 OR v_version >= 9007199254740991) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '无效的记录版本。';
    END IF;
    IF (v_start IS NOT NULL AND (v_start < 946684800000 OR v_start > v_now + 300000))
       OR (v_end IS NOT NULL AND (v_end < 946684800000 OR v_end > v_now + 300000)) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = '记录时间无效，或比服务器时间超前超过五分钟，请校准设备时间。';
    END IF;

    SELECT * INTO v_row FROM public.contractions
    WHERE space_id = v_space AND id = v_id;
    IF v_action = 'start' THEN
        IF FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = '此记录编号已经使用，已删除记录不能复活。';
        END IF;
        SELECT to_jsonb(c) - 'space_id' INTO v_active FROM public.contractions AS c
        WHERE c.space_id = v_space AND c.deleted_ms IS NULL AND c.end_ms IS NULL;
        IF v_active IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409',
                MESSAGE = '已有正在计时的宫缩，请刷新并继续该次计时。',
                DETAIL = jsonb_build_object('active', v_active)::text;
        END IF;
        v_end := NULL;
    ELSE
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '找不到这条记录。';
        END IF;
        IF v_row.deleted_ms IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = '这条记录已经删除，请刷新。';
        END IF;
        IF v_row.version <> v_version THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409',
                MESSAGE = '记录已在另一台设备更新，请刷新后再操作。',
                DETAIL = jsonb_build_object('record', to_jsonb(v_row) - 'space_id')::text;
        END IF;
        IF NOT (p_change ? 'intensity') THEN v_intensity := v_row.intensity; END IF;
        IF v_action = 'finish' THEN
            IF v_row.end_ms IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = '这次宫缩已经结束，请刷新。';
            END IF;
            v_start := v_row.start_ms;
        ELSIF v_action = 'edit' THEN
            IF v_row.end_ms IS NULL THEN
                RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = '请先结束计时，再修改时间。';
            END IF;
        ELSE
            v_start := v_row.start_ms;
            v_end := v_row.end_ms;
        END IF;
    END IF;

    IF v_action IN ('start','finish','edit') THEN
        IF v_end IS NOT NULL AND v_end < v_start THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '结束时间不能早于开始时间。';
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.contractions AS c
            WHERE c.space_id = v_space AND c.id <> v_id AND c.deleted_ms IS NULL
              AND int8range(c.start_ms, c.end_ms, '[)') && int8range(v_start, v_end, '[)')
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = '这段时间与另一条宫缩记录重叠，请检查时间。';
        END IF;
    END IF;

    IF v_action = 'start' THEN
        INSERT INTO public.contractions(id,space_id,start_ms,end_ms,intensity,version,operation_id,created_by)
        VALUES (v_id,v_space,v_start,NULL,v_intensity,1,v_operation,v_user)
        RETURNING * INTO v_row;
    ELSIF v_action = 'delete' THEN
        UPDATE public.contractions
        SET deleted_ms = v_now, version = version + 1, operation_id = v_operation
        WHERE space_id = v_space AND id = v_id AND version = v_version
        RETURNING * INTO v_row;
    ELSE
        UPDATE public.contractions
        SET start_ms = v_start, end_ms = v_end, intensity = v_intensity,
            version = version + 1, operation_id = v_operation
        WHERE space_id = v_space AND id = v_id AND version = v_version
        RETURNING * INTO v_row;
    END IF;
    SELECT to_jsonb(c) - 'space_id' INTO v_active FROM public.contractions AS c
    WHERE c.space_id = v_space AND c.deleted_ms IS NULL AND c.end_ms IS NULL;
    v_response := jsonb_build_object(
        'ok', true, 'record', to_jsonb(v_row) - 'space_id',
        'active', v_active, 'server_now', v_now, 'replayed', false
    );
    INSERT INTO private.operation_log(space_id,operation_id,requested_by,request,response)
    VALUES (v_space,v_operation,v_user,p_change,v_response);
    RETURN v_response;
END;
$$;

-- Functions otherwise receive PUBLIC EXECUTE by default in PostgreSQL.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tracker_snapshot(integer,bigint,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tracker_change(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_snapshot(integer,bigint,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_change(jsonb) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

COMMENT ON TABLE private.allowed_emails IS
    'Admin-only allowlist, maximum two emails. Insert actual addresses manually; never commit them.';
COMMENT ON FUNCTION public.tracker_change(jsonb) IS
    'Authenticated shared-space mutations. Retry an unchanged operation_id and payload; refresh snapshot after success.';

COMMIT;
