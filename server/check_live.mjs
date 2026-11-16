// Checks that the live database is ready for the dashboard. Read-only: it only runs SELECTs inside a read-only transaction.
// Usage:  node server/check_live.mjs        (reads the login from .env; the address and password are never printed)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveConfig } from './db.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(path.resolve(here, '..', '.env')) } catch { /* no .env file */ }
if (!liveConfig()) {
  console.log('No database login found in .env. Fill in PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD (the same fields Navicat shows), or DATABASE_URL, then run this again.')
  process.exit(1)
}

const pg = (await import('pg')).default
pg.types.setTypeParser(20, (v) => Number(v))
const pool = new pg.Pool({ ...liveConfig(), ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 })

let bad = 0
const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? 'OK  ' : 'FIX '} ${text}`) }
const one = async (client, sql) => { try { await client.query('savepoint s'); const r = (await client.query(sql)).rows[0]; await client.query('release savepoint s'); return { r } } catch (e) { await client.query('rollback to savepoint s'); return { e: e.message } } }

let client
try {
  client = await pool.connect()
} catch (e) {
  console.log('Could not connect:', e.message.replace(/postgres(ql)?:\/\/\S+/g, '(address hidden)'))
  console.log('Check the address, the password, and that the database accepts connections from this computer (Supabase: use the "Session pooler" address).')
  process.exit(1)
}
try {
  await client.query('begin read only')
  console.log('Connected (read-only). Checking what the dashboard needs:\n')
  const who = await one(client, 'select current_user as u')
  say(true, `logged in as ${who.r.u}`)

  const checks = [
    ['the leads view (reporting.v_leads)', 'select count(*)::int as n from reporting.v_leads', (r) => `${r.n} leads`],
    ['the opportunities view (reporting.v_opps)', 'select count(*)::int as n from reporting.v_opps', (r) => `${r.n} opportunities`],
    ['the message view (reporting.v_message_rows)', 'select count(*)::int as n, max(last_event_at_ist)::text as latest from reporting.v_message_rows', (r) => `${r.n} message rows, latest update ${r.latest}`],
    ['the chat log (public.wati_message_log)', "select count(*)::int as n, to_char(max(message_created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') as latest, count(*) filter (where raw_payload->>'ticketId' is not null)::int as tickets from public.wati_message_log", (r) => `${r.n} messages, newest ${r.latest} India time, ${r.tickets} with a chat id (needed for the Inbox)`],
    ['the sessions table (public.wati_sessions)', 'select count(*)::int as n from public.wati_sessions', (r) => `${r.n} sessions`],
  ]
  for (const [name, sql, fmt] of checks) {
    const x = await one(client, sql)
    if (x.e) say(false, `${name}: ${x.e}`)
    else say(true, `${name}: ${fmt(x.r)}`)
  }

  const fresh = await one(client, "select extract(epoch from (now() - max(message_created_at))) / 3600 as hours from public.wati_message_log")
  if (fresh.r) {
    const h = Number(fresh.r.hours)
    say(h < 24, h < 24 ? `the newest chat message is ${h.toFixed(1)} hours old, so the WATI feed is flowing` : `the newest chat message is ${(h / 24).toFixed(1)} days old: the WATI feed into n8n looks stopped. Check the webhook in WATI and the n8n workflow "Assign User in WATI".`)
  }
  const priv = await one(client, "select has_table_privilege(current_user, 'public.wati_message_log', 'INSERT,UPDATE,DELETE') as can_write, (select rolsuper from pg_roles where rolname = current_user) as is_super")
  if (priv.r) say(!priv.r.can_write && !priv.r.is_super, priv.r.can_write || priv.r.is_super ? 'this login can change data. Use the read-only login (dashboard_ro) from the README. The dashboard never writes, but the login should not be able to either.' : 'the login cannot change data (read-only), as it should be')
} finally {
  try { await client.query('rollback') } catch { /* ignore */ }
  client.release(); await pool.end()
}
console.log(bad ? `\n${bad} thing(s) to fix. The README section "Connecting the live database" has the exact commands.` : '\nAll good. Start the dashboard; the badge in the corner will say "Live database".')
process.exit(bad ? 1 : 0)
