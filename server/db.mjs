// Database adapter.
//   No DATABASE_URL  -> CSV mode: loads the exports in DATA_DIR into an in-memory Postgres (PGlite). Nothing leaves this machine.
//   DATABASE_URL set (or PGHOST + PGUSER + PGPASSWORD + PGDATABASE, the same fields Navicat asks for) -> live mode: connects read-only to your Postgres. The views must exist (see README).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SERVERLESS = process.env.AQ_SERVERLESS === '1'   // running as a Netlify Function (set by netlify/functions/api.mjs)
const readSql = (f) => fs.readFileSync(path.join(here, 'sql', f), 'utf8')
const CSV_TABLES = ['lead_insight', 'opportunity_insight', 'wati_message_log', 'wati_message_pivot', 'wati_sessions']

const normalise = (v) => (typeof v === 'bigint' ? Number(v) : v)
const normRows = (rows) => rows.map((r) => { const o = {}; for (const k in r) o[k] = normalise(r[k]); return o })

const DDL = `
create table lead_insight (lead_id varchar primary key, owner_id varchar, customer_name varchar, customer_number varchar, lead_status varchar, lead_source varchar, lead_manager_name varchar, page_url text, welcome_message int, first_follow_up_message_after24hr int, when_lead_converted_into_nurturing int, when_lead_converted_into_unqualified int, when_lead_converted_into_not_connected int, "1st_follow_up_message" int, "2nd_follow_up_message" int, "3rd_follow_up_message" int, created_at timestamp, updated_at timestamp);
create table opportunity_insight (opportunity_id varchar primary key, owner_id varchar, customer_name varchar, customer_number varchar, opportunity_status varchar, opportunity_manager_name varchar, lead_manager_name varchar, send_salesman_details_to_customer int, send_customer_details_to_salesperson int, "1st_follow_up_message_after_48hr" int, "2nd_follow_up_message_after_24hr" int, "1st_follow_up_message" int, "2nd_follow_up_message" int, "3rd_follow_up_message" int, created_at timestamp, updated_at timestamp, follow_up_message_to_salesperson_after_24hr int, opportunity_won int, opportunity_loss int);
create table wati_message_log (id bigint primary key, wati_event_id text unique, whatsapp_message_id text, event_type text, is_owner boolean, wa_id text, sender_name text, message_type text, message_text text, list_reply_title text, conversation_id text, operator_email text, message_created_at timestamptz, received_at timestamptz, n8n_execution_id text, raw_payload jsonb);
create table wati_message_pivot (id int primary key, phone_no varchar, whatsappmessageid varchar, template_name varchar, templatemessagesent_v2 int, delivered int, sentmessageread_v2 int, sentmessagereplied_v2 int, templatemessagefailed int, created_at timestamp, updated_at timestamp, created_at_ist timestamp, updated_at_ist timestamp, constraint unique_phone_template unique (phone_no, template_name));
create table wati_sessions (id varchar primary key, phone_number varchar, last_user_message_time timestamptz, session_expiry_time timestamptz);`

/** Connection settings for live mode, or null for CSV mode. Either one DATABASE_URL, or the separate fields a tool like Navicat shows (no URL, no escaping of symbols in the password). */
export function liveConfig() {
  const e = process.env
  if (e.DATABASE_URL) return { connectionString: e.DATABASE_URL }
  if (e.PGHOST && e.PGUSER) return { host: e.PGHOST, port: Number(e.PGPORT || 5432), database: e.PGDATABASE || 'postgres', user: e.PGUSER, password: e.PGPASSWORD }
  return null
}

export async function connect() {
  if (liveConfig()) {
    const pg = (await import('pg')).default
    pg.types.setTypeParser(20, (v) => Number(v))     // bigint
    pg.types.setTypeParser(1700, (v) => Number(v))   // numeric
    // Speed: the database is far away (about 0.14 s per round trip), so every trip counts.
    //  - Connections stay open for 30 minutes when idle (they used to close after 10 s, so every burst of requests paid for new secure connections) and 8 can work at once.
    //  - READ ONLY is a setting of the connection itself (sent when it opens: default_transaction_read_only) instead of wrapping every query in begin ... commit,
    //    which cost 3 round trips per query instead of 1. The database still refuses every write. This is proved below before the server starts answering,
    //    and the login itself (dashboard_ro) can only read anyway.
    if (process.env.AQ_WORKER === '1') {
      // Cloudflare Worker: a connection cannot be shared between requests, so each query opens its own.
      const query = async (sql, args = []) => {
        const c = new pg.Client({ ...liveConfig(), ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } })
        await c.connect()
        try { await c.query('begin read only'); const r = await c.query(sql, args); await c.query('commit'); return r.rows }
        finally { c.end().catch(() => {}) }
      }
      // No queries here: a Worker request must never wait on work another request started. The database clock is UTC, so "today" is worked out locally.
      return { mode: 'live', query, MSG: 'reporting.v_message_rows', get asOf() { return new Date().toISOString().slice(0, 10) }, cacheMs: 60_000 }
    }
    const pool = new pg.Pool({
      ...liveConfig(),
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      options: '-c default_transaction_read_only=on',
      // Netlify Function: every warm copy of the function has its own pool, so keep it small (a page asks for many things at once, and many copies may run) and let idle ones go.
      max: SERVERLESS ? 3 : 8, idleTimeoutMillis: SERVERLESS ? 10_000 : 30 * 60_000, connectionTimeoutMillis: 30_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000,
    })
    pool.on('error', (e) => console.error('[db] idle connection dropped:', e.message))
    const query = async (sql, args = []) => (await pool.query(sql, args)).rows
    try { await query('select 1 from reporting.v_leads limit 1'); await query('select 1 from reporting.v_message_rows limit 1') }
    catch (e) { throw new Error('Live mode: the reporting views are missing or not readable (' + e.message + '). Run server/sql/reporting_views.sql and server/sql/app.sql first.') }
    // proof that writes are refused on a pooled connection: creating a temporary table must fail with a read-only error
    let refused = false
    try { await query('create temp table _aq_readonly_probe (a int)') } catch (e) { refused = /read-only/i.test(e.message) }
    if (!refused) throw new Error('Live mode stopped: the database connection is not read-only. The dashboard must never be able to write.')
    const [{ d }] = await query('select current_date::text as d')
    const live = { mode: 'live', query, MSG: 'reporting.v_message_rows', asOf: d, cacheMs: 60_000 }
    // keep "today" right when the server runs for days, and keep a few connections open so the first page load does not pay for them
    if (!SERVERLESS) {   // (a function is frozen between requests: no timers, and a cold start must not pay for extra connections)
      setInterval(async () => { try { live.asOf = (await query('select current_date::text as d'))[0].d } catch { /* keep the old date */ } }, 10 * 60_000).unref()
      await Promise.all(Array.from({ length: 6 }, () => query('select 1').catch(() => {})))
    }
    return live
  }

  // The CSV files hold real customer data and are never part of a hosted copy, so a Netlify Function needs a live database.
  if (SERVERLESS) throw new Error('No database is set. Add DATABASE_URL (or PGHOST, PGUSER, PGPASSWORD, PGDATABASE) in Netlify > Site configuration > Environment variables.')
  const PGLITE = '@electric-sql/pglite'   // named in a variable so the Netlify bundler does not pull this large library into the function
  const { PGlite } = await import(PGLITE)
  const dir = path.resolve(process.env.DATA_DIR || path.join(root, '..', 'data_insight'))
  const missing = CSV_TABLES.filter((t) => !fs.existsSync(path.join(dir, t + '.csv')))
  if (missing.length) throw new Error(`CSV mode: missing ${missing.map((m) => m + '.csv').join(', ')} in ${dir}. Set DATA_DIR or DATABASE_URL.`)
  const db = new PGlite()
  await db.exec(DDL)
  for (const t of CSV_TABLES) {
    await db.exec("set datestyle = 'ISO, DMY'")
    await db.query(`copy ${t} from '/dev/blob' with (format csv, header true)`, [], { blob: new Blob([fs.readFileSync(path.join(dir, t + '.csv'))]) })
  }
  await db.exec(readSql('reporting_views.sql'))
  await db.exec(readSql('app.sql'))
  // materialise the message view once: it is a snapshot, and every chart reads it
  await db.exec(`create table app_msg as select * from reporting.v_message_rows;
    create index on app_msg (first_sent_date); create index on app_msg (template_name); create index on app_msg (phone10); analyze app_msg;`)
  const query = async (sql, args = []) => normRows((await db.query(sql, args)).rows)
  const [{ d }] = await query('select max(updated_at_ist)::date::text as d from public.wati_message_pivot')
  return { mode: 'csv', query, MSG: 'app_msg', asOf: d, cacheMs: Infinity, dir }
}
