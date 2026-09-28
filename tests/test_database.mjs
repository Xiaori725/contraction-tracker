/**
 * Real PostgreSQL integration checks in an isolated in-memory PGlite database.
 * No Supabase account, production database, network call, or real email is used.
 *
 * Install @electric-sql/pglite in a separate test-runtime directory, then:
 * PG_TEST_RUNTIME=/absolute/path/to/node_modules/@electric-sql/pglite/dist/index.js
 * node tests/test_database.mjs
 *
 * The application does not depend on PGlite. A multi-connection Postgres test is
 * still required to stress simultaneous transactions; PGlite has one connection.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.PG_TEST_RUNTIME || '@electric-sql/pglite';
const { PGlite } = await import(isAbsolute(runtime) ? pathToFileURL(runtime).href : runtime);
const db = new PGlite();
let checks = 0;
const SPACE = 'e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21';
const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const outsider = '10000000-0000-4000-8000-000000000003';

function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
async function fails(action, expectedCode, message) {
  let caught;
  try { await action(); } catch (error) { caught = error; }
  assert.ok(caught, `${message}: expected an error`);
  assert.equal(caught.code, expectedCode, `${message}: ${caught.message}`);
  checks++;
}
async function admin() { await db.exec('RESET ROLE'); }
async function asUser(id, role = 'authenticated') {
  assert.ok(['authenticated', 'anon'].includes(role));
  await db.exec(`RESET ROLE; SET ROLE ${role};`);
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id || '']);
}
async function snapshot(limit = 50, before = null) {
  const { rows } = await db.query(
    'SELECT public.tracker_snapshot($1::integer,$2::bigint,$3::uuid) AS result',
    [limit, before?.start_ms ?? null, before?.id ?? null],
  );
  return rows[0].result;
}
async function change(payload) {
  const { rows } = await db.query('SELECT public.tracker_change($1::jsonb) AS result', [JSON.stringify(payload)]);
  return rows[0].result;
}
const op = (action, id, values = {}) => ({ action, id, operation_id: randomUUID(), ...values });

try {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      email_confirmed_at timestamptz
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
  `);
  const migration = await readFile(new URL('../supabase/migrations/001_tracker.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  checks++;

  // Users may predate the administrator's allowlist seed.
  await db.query(`INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    ($1,'parent-one@example.invalid',clock_timestamp()),
    ($2,'parent-two@example.invalid',NULL),
    ($3,'unlisted@example.invalid',clock_timestamp())`, [alice, bob, outsider]);
  await db.exec(`INSERT INTO private.allowed_emails(email)
                VALUES ('parent-one@example.invalid'),('parent-two@example.invalid')`);
  let membership = await db.query('SELECT user_id,space_id FROM private.memberships ORDER BY user_id');
  check(membership.rows, [{ user_id: alice, space_id: SPACE }], 'Only confirmed allowlisted users join');
  await fails(() => db.exec("INSERT INTO private.allowed_emails(email) VALUES ('third@example.invalid')"),
    '22023', 'A third allowed email is refused');

  await asUser(null, 'anon');
  await fails(() => snapshot(), '42501', 'Anon cannot call snapshot');
  await fails(() => change(op('start', randomUUID(), { start_ms: Date.now() })), '42501', 'Anon cannot mutate');
  await asUser(outsider);
  await fails(() => snapshot(), '42501', 'Unlisted authenticated user cannot read');
  await asUser(bob);
  await fails(() => snapshot(), '42501', 'Unconfirmed allowed email cannot read');
  await admin();
  await db.query('UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=$1', [bob]);
  await asUser(bob);
  check((await snapshot()).space_id, SPACE, 'Confirmation trigger grants shared access');
  await fails(() => db.query('SELECT * FROM public.contractions'), '42501', 'Direct SELECT is forbidden');
  await fails(() => db.query('DELETE FROM public.contractions'), '42501', 'Direct DELETE is forbidden');
  await fails(() => db.query('SELECT * FROM private.allowed_emails'), '42501', 'Allowlist is private');
  await fails(() => db.query('SELECT private.require_tracker_space()'), '42501', 'Private helpers are not callable');

  const t = Date.now() - 3 * 60 * 60 * 1000;
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  await asUser(alice);
  const startFirst = op('start', first, { start_ms: t, intensity: null });
  check((await change(startFirst)).record.version, 1, 'Start commits version 1');
  await asUser(bob);
  check((await snapshot()).active.id, first, 'Other account sees the same active contraction');
  await fails(() => change(op('start', randomUUID(), { start_ms: t + 1000 })), 'PT409', 'Only one active contraction');
  const strengthFirst = op('strength', first, { version: 1, intensity: 3 });
  check((await change(strengthFirst)).record.version, 2, 'Strength commits a new version');
  await asUser(alice);
  await fails(() => change(op('finish', first, { version: 1, end_ms: t + 45000 })), 'PT409', 'Stale finish cannot overwrite strength');
  const finishFirst = op('finish', first, { version: 2, end_ms: t + 45000 });
  let finished = await change(finishFirst);
  check([finished.record.version, finished.record.intensity, finished.active], [3, 3, null], 'Finish preserves omitted strength');
  const editFirst = op('edit', first, { version: 3, start_ms: t + 1000, end_ms: t + 46000 });
  check((await change(editFirst)).record.version, 4, 'Edit updates timestamps');
  check((await change(startFirst)).replayed, true, 'Old start retry is acknowledged after later edits');
  check((await snapshot()).records[0].version, 4, 'Retry does not roll back current data');
  await fails(() => change({ ...startFirst, start_ms: t + 50 }), 'PT409', 'Operation ID cannot be reused with changed payload');
  await fails(() => change(strengthFirst), 'PT409', 'Operation IDs remain bound to the original actor');
  await asUser(bob);
  check((await change(strengthFirst)).replayed, true, 'Historical strength retry is idempotent');
  check((await snapshot()).records[0].version, 4, 'Historical retry does not increment version');

  await change(op('start', second, { start_ms: t + 300000, intensity: 2 }));
  await change(op('finish', second, { version: 1, end_ms: t + 360000 }));
  await change(op('start', third, { start_ms: t + 600000 }));
  let page = await snapshot(1);
  check(page.records.map(r => r.id), [second], 'Page contains completed records only');
  check(page.records[0].previous_start, t + 1000, 'LAG crosses the page boundary');
  check(page.records[0].previous_end, t + 46000, 'Previous end crosses the page boundary');
  check(page.active.id, third, 'Active is returned independently of history pagination');
  check(page.next, { start_ms: t + 300000, id: second }, 'Cursor is the last returned tuple');
  const older = await snapshot(1, page.next);
  check([older.records[0].id, older.records[0].previous_start, older.next], [first, null, null], 'Older page ends cleanly');
  await fails(() => snapshot(5001), '22023', 'Oversized snapshot is rejected');
  await fails(() => db.query('SELECT public.tracker_snapshot(50, $1, NULL)', [t]), '22023', 'Partial cursor is rejected');
  await fails(() => change(op('edit', second, { version: 2, start_ms: t + 590000, end_ms: t + 610000 })),
    'PT409', 'Edit cannot overlap the active record');
  await change(op('finish', third, { version: 1, end_ms: t + 630000 }));
  await fails(() => change(op('start', randomUUID(), { start_ms: t + 320000 })), 'PT409', 'Backdated start cannot overlap history');

  await asUser(alice);
  const removeFirst = op('delete', first, { version: 4 });
  check((await change(removeFirst)).record.version, 5, 'Soft delete increments version');
  check((await change(editFirst)).replayed, true, 'Retry of edit committed before delete is acknowledged');
  check((await snapshot()).records.some(r => r.id === first), false, 'Historical retry cannot resurrect deleted record');
  check((await change(removeFirst)).replayed, true, 'Delete retry is idempotent');
  await fails(() => change(op('start', first, { start_ms: t + 900000 })), 'PT409', 'Deleted UUID cannot be reused');
  check((await snapshot()).records.find(r => r.id === second).previous_start, null, 'Deleted records are excluded before LAG');
  const clearStrength = op('strength', second, { version: 2, intensity: null });
  check((await change(clearStrength)).record.intensity, null, 'Strength may explicitly be cleared');
  await fails(() => change(op('start', randomUUID(), { start_ms: Date.now() + 3600000 })), '22023', 'Future client clock is rejected');
  await fails(() => change(op('start', randomUUID(), { start_ms: 9007199254740992 })), '22023', 'Unsafe integer is rejected');
  await fails(() => change(op('start', randomUUID(), { start_ms: t + 0.5 })), '22023', 'Fractional milliseconds are rejected');
  await fails(() => change(op('start', randomUUID(), { start_ms: t + 900000, intensity: 4 })), '22023', 'Unknown intensity is rejected');
  await fails(() => change(op('edit', second, { version: 3, start_ms: t + 400000, end_ms: t + 399999 })),
    '22023', 'Negative duration is rejected');
  await fails(() => change({ ...op('delete', second, { version: 3 }), space_id: randomUUID() }),
    '22023', 'Clients cannot choose a different space');

  // Authorization always reads current auth.users, even with the old user's JWT.
  await admin();
  await db.query("UPDATE auth.users SET email='changed@example.invalid' WHERE id=$1", [alice]);
  await asUser(alice);
  await fails(() => snapshot(), '42501', 'Email change revokes old-session access immediately');
  await admin();
  await db.exec("DELETE FROM private.allowed_emails WHERE email='parent-two@example.invalid'");
  await asUser(bob);
  await fails(() => snapshot(), '42501', 'Removing the allowlist entry revokes access');
  await admin();
  await db.exec("INSERT INTO private.allowed_emails(email) VALUES ('parent-two@example.invalid')");
  await asUser(bob);
  check((await snapshot()).records.length, 2, 'Admin reauthorization restores existing shared history');
  await admin();
  const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.contractions'::regclass");
  check(rls.rows[0].relrowsecurity, true, 'RLS is enabled on the public table');
  const logCount = await db.query('SELECT count(*)::integer AS count FROM private.operation_log');
  check(logCount.rows[0].count, 10, 'Only unique successful operations are logged');
  console.log(`PASS: ${checks} database integration checks (isolated PostgreSQL/PGlite).`);
} finally {
  await db.close();
}
