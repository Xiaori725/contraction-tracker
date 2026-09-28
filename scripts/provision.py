"""Administrator-only setup. Never import this script from the running app.

All credentials are read from environment variables or hidden prompts.
Private data/setup codes are written only under the git-ignored private folder.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import getpass
import html
import json
import os
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import SPACE_ID  # noqa: E402
from supabase import ClientOptions, create_client  # noqa: E402


def secret(name: str) -> str:
    value = os.environ.get(name) or getpass.getpass(f"{name}（隐藏输入）: ")
    if not value:
        raise ValueError(f"Missing {name}")
    return value


def import_legacy(conn, filename: Path) -> int:
    payload = json.loads(filename.read_text(encoding="utf-8"))
    records = payload.get("records") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        raise ValueError("The import file must contain a records array")
    count = 0
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (SPACE_ID,))
        for row in records:
            record_id, operation_id = str(UUID(row["id"])), str(UUID(row["operation_id"]))
            fields = (row["start_ms"], row.get("end_ms"), row.get("intensity"), row["version"], row.get("deleted_ms"), operation_id)
            found = conn.execute("SELECT start_ms,end_ms,intensity,version,deleted_ms,operation_id::text FROM public.contractions WHERE id=%s", (record_id,)).fetchone()
            if found:
                if tuple(found) != fields:
                    raise ValueError(f"Record {record_id} differs from the existing destination; nothing was overwritten")
                continue
            conn.execute("""INSERT INTO public.contractions
                (id,space_id,start_ms,end_ms,intensity,version,deleted_ms,operation_id,created_by)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,NULL)""", (record_id, SPACE_ID, *fields))
            count += 1
    return count


def setup_codes(url: str, emails: list[str], app_url: str, reset: bool) -> Path:
    admin = create_client(url, secret("SUPABASE_SERVICE_ROLE_KEY"), options=ClientOptions(auto_refresh_token=False, persist_session=False))
    wanted = set(emails)
    existing = {}
    for page in range(1, 101):
        users = admin.auth.admin.list_users(page=page, per_page=100)
        for user in users:
            if (user.email or "").lower() in wanted:
                existing[user.email.lower()] = user
        if len(users) < 100 or wanted.issubset(existing):
            break
    codes = []
    for email in emails:
        if email in existing and not reset:
            print(f"账号已存在，保留原密码：{email}（需要新设置码时使用 --reset-codes）")
            continue
        if email not in existing:
            # No email is sent by create_user. A random password is not needed.
            admin.auth.admin.create_user({"email": email, "email_confirm": True})
        response = admin.auth.admin.generate_link({"type": "recovery", "email": email})
        codes.append((email, response.properties.hashed_token))
    target = ROOT / "private" / ("password-setup-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".html")
    target.parent.mkdir(exist_ok=True)
    sections = "".join(f"<article><h2>{html.escape(email)}</h2><p>一次性设置码：</p><code>{html.escape(code)}</code></article>" for email, code in codes)
    body = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer"><title>一刻 · 首次设置密码</title>
    <style>body{{font:16px/1.7 system-ui;max-width:680px;margin:40px auto;padding:0 20px;color:#163446}}article{{padding:18px;border:1px solid #cbdde2;border-radius:12px;margin:18px 0}}h2{{font-size:18px}}code{{overflow-wrap:anywhere;user-select:all}}a{{color:#006d77}}</style>
    <h1>一刻 · 首次设置密码</h1><p>仅将各自的设置码交给对应使用者；不要上传 GitHub 或公开转发。</p>
    <p>打开 <a href="{html.escape(app_url, quote=True)}">宫缩记录器</a>，展开“首次使用 / 重新设置密码”，输入邮箱与设置码，自行设置密码。</p>
    {sections}<p>设置码一次性使用，有效期由 Supabase 的 Email OTP Expiration 配置决定，默认通常为一小时。过期可由管理员重新生成。生成时间：{datetime.now(timezone.utc).isoformat()}</p></html>"""
    target.write_text(body, encoding="utf-8")
    return target


def main():
    parser = argparse.ArgumentParser(description="Initialize this tracker's dedicated Supabase project")
    parser.add_argument("--email", action="append", required=True, help="The two approved email addresses, each passed once")
    parser.add_argument("--apply-schema", action="store_true")
    parser.add_argument("--import-records", type=Path)
    parser.add_argument("--create-codes", action="store_true")
    parser.add_argument("--reset-codes", action="store_true", help="Explicitly issue new password-setting codes for existing users")
    parser.add_argument("--app-url", default="http://localhost:8501")
    args = parser.parse_args()
    emails = sorted({email.strip().lower() for email in args.email})
    if len(emails) != 2 or any("@" not in email for email in emails):
        parser.error("Pass exactly two distinct email addresses")
    import psycopg
    # Session pooler/5432 is suitable for hosts without IPv6. TLS is required.
    with psycopg.connect(secret("SUPABASE_DB_URL"), sslmode="require", connect_timeout=20, autocommit=True) as conn:
        if args.apply_schema:
            exists = conn.execute("SELECT to_regclass('public.contractions')").fetchone()[0]
            if exists:
                raise ValueError("Destination already has contractions; refusing to replace an existing schema")
            conn.execute((ROOT / "supabase/migrations/001_tracker.sql").read_text(encoding="utf-8"))
        with conn.transaction():
            existing = {row[0] for row in conn.execute("SELECT email FROM private.allowed_emails")}
            if existing - set(emails):
                raise ValueError("This project has a different allowlist; no access changes were made")
            for email in emails:
                conn.execute("INSERT INTO private.allowed_emails(email) VALUES(%s) ON CONFLICT DO NOTHING", (email,))
        if args.import_records:
            print(f"已导入 {import_legacy(conn, args.import_records)} 条记录（相同编号不会重复导入）。")
    if args.create_codes or args.reset_codes:
        url = os.environ.get("SUPABASE_URL") or input("SUPABASE_URL: ").strip()
        if not url.startswith("https://"):
            raise ValueError("Supabase URL must use HTTPS")
        filename = setup_codes(url, emails, args.app_url, args.reset_codes)
        print(f"设置码已保存在私有文件：{filename}")
    print("完成。管理员密钥与数据库连接串不要填写到线上应用的 Secrets 中。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never echo request URLs, authorization values, or provider tracebacks.
        print(f"设置未完成（{type(error).__name__}）。请检查项目配置和权限后重试。", file=sys.stderr)
        sys.exit(1)
