// Checks reporting.v_message_sends (sql/message_sends.sql) and the Messages endpoints that read it, plus the chatbot rule on the Chats page,
// against a tiny made-up database. Needs no server and no real data:   node server/test_messages.mjs
// In-memory Postgres (PGlite). Every expected number below was worked out by hand. Nothing is read from or written to the real database.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { makeApi } from './queries.mjs'
import { DDL } from './db.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sql = (f) => fs.readFileSync(path.join(here, 'sql', f), 'utf8')
let pass = 0, fail = 0
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x))
const eq = (name, got, want) => {
  const ok = canon(got) === canon(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))

const db = new PGlite()
await db.exec(DDL)
await db.exec(`create table public.wati_messages (wati_id text primary key, direction text, phone_no text, template_name text, sender_name text, conversation_id text, ticket_id text,
  operator_email text, operator_name text, assignee_id text, sent_at timestamptz, received_at timestamptz, failed_at timestamptz, message_type text, delivered_at timestamptz, read_at timestamptz, replied_at timestamptz);`)
await db.exec(sql('reporting_views.sql'))
await db.exec(sql('app.sql'))
await db.exec(sql('message_sends.sql'))
await db.exec(sql('message_sends.sql'))   // safe to run twice
const Q = async (s, args = []) => (await db.query(s, args)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))
const api = makeApi({ query: Q, MSG: 'reporting.v_message_sends', mode: 'test', asOf: '2026-11-14' })

// Phones: A 9811111111 (a lead, source Web, owner Asha), B 9822222222, C 9833333333, D 9844444444 (no leads)
await db.exec(`
insert into lead_insight (lead_id, customer_name, customer_number, lead_status, lead_source, lead_manager_name, created_at, updated_at) values
  ('L1', 'Asha Customer', '+919811111111', 'New', 'Web', 'Asha', '2026-11-09 10:00', '2026-11-09 10:00');
-- the pivot (old source). Rows dated before 13 Nov are used; the 13 Nov row is NOT (wati_messages covers that day).
insert into wati_message_pivot (id, phone_no, whatsappmessageid, template_name, templatemessagesent_v2, delivered, sentmessageread_v2, sentmessagereplied_v2, templatemessagefailed, created_at_ist, updated_at_ist) values
  (1, '919811111111', 'p1', 't1', 3, 1, 1, 0, 0, '2026-11-10 10:00', '2026-11-11 09:00'),   -- A got t1 three times: 1 measured, 2 not followed
  (2, '919822222222', 'p2', 't1', 0, 0, 0, 0, 1, '2026-11-10 11:00', '2026-11-10 11:01'),   -- B: failed
  (3, '919833333333', 'p3', 't2', 1, 1, 0, 0, 0, '2026-11-12 09:00', '2026-11-12 09:05'),   -- C on 12 Nov (partial first day of wati_messages): from the pivot
  (4, '919811111111', 'p4', 't2', 2, 2, 1, 0, 0, '2026-11-13 10:00', '2026-11-14 10:05');   -- 13 Nov: wati_messages has it, so this row is left out
-- wati_messages (new source): first template on 12 Nov 08:00 IST, so the first full day is 13 Nov
insert into public.wati_messages (wati_id, direction, phone_no, template_name, sent_at, delivered_at, read_at, replied_at, failed_at) values
  ('w0', 'template', '919811111111', 't2', '2026-11-12 08:00+05:30', null, null, null, null),                                  -- 12 Nov: before the cut-off, left out
  ('w1', 'template', '919811111111', 't2', '2026-11-13 10:00+05:30', '2026-11-13 10:01+05:30', '2026-11-13 11:00+05:30', null, null),
  ('w2', 'template', '919811111111', 't2', '2026-11-14 10:00+05:30', '2026-11-14 10:05+05:30', null, null, null),            -- a repeat send: counted on its own day
  ('w3', 'template', '919822222222', 't1', '2026-11-14 12:00+05:30', '2026-11-14 12:02+05:30', null, null, '2026-11-14 12:01+05:30'),   -- failed (a late delivered event gives no credit)
  ('w4', 'template', '919844444444', 't1', '2026-11-14 18:20+00', null, null, null, null),                                     -- 23:50 IST on 14 Nov (UTC is 14 Nov 18:20)
  ('w5', 'template', '919844444444', 't1', '2026-11-14 18:40+00', null, null, null, null),                                     -- 00:10 IST on 15 Nov
  ('s1', 'session', '919811111111', null, '2026-11-14 10:30+05:30', null, null, null, null);                                     -- a team message, not a template
`)

const cut = (await Q(`select min(first_sent_date)::text as min, count(*)::int as n from reporting.v_message_sends`))[0]
eq('view: 3 pivot rows before 13 Nov + 5 template messages from 13 Nov (w0 before the cut-off, the session message and the 13 Nov pivot row are left out)', cut, { min: '2026-11-10', n: 8 })

const k = (await api['messages/kpis']({ from: '2026-11-13', to: '2026-11-14' })).current
eq('13-14 Nov: every message sent counts once, on its own day (w1, w2, w3, w4)', pick(k, ['measured', 'attempts', 'unmeasured', 'sent', 'failed', 'delivered_adj', 'read_adj', 'replied']),
  { measured: 4, attempts: 4, unmeasured: 0, sent: 3, failed: 1, delivered_adj: 2, read_adj: 1, replied: 0 })

const old = (await api['messages/kpis']({ from: '2026-11-10', to: '2026-11-12' })).current
eq('10-12 Nov: the pivot as before (A counted once of 3, B failed, C)', pick(old, ['measured', 'attempts', 'unmeasured', 'failed', 'delivered_adj']), { measured: 3, attempts: 5, unmeasured: 2, failed: 1, delivered_adj: 2 })

const tr = await api['messages/trend']({ from: '2026-11-10', to: '2026-11-15', grain: 'day' })
eq('trend by India day (w4 at 23:50 IST stays on 14 Nov, w5 at 00:10 IST is on 15 Nov)', tr.rows.map((r) => [r.period, r.measured, r.failed]),
  [['2026-11-10', 2, 1], ['2026-11-12', 1, 0], ['2026-11-13', 1, 0], ['2026-11-14', 3, 1], ['2026-11-15', 1, 0]])

const web = (await api['messages/kpis']({ from: '2026-11-13', to: '2026-11-14', sources: 'Web' })).current
eq('lead source filter: only A has a lead (source Web): w1 and w2', web.measured, 2)

const tpl = await api['messages/templates']({ from: '2026-11-13', to: '2026-11-14' })
eq('templates table, 13-14 Nov', tpl.rows.map((r) => [r.template_name, r.measured, r.delivered, r.failed]).sort(), [['t1', 2, 0, 1], ['t2', 2, 2, 0]])

const cust = await api['customers/detail']({ key: 'p:9811111111' })
eq('customer A: one line per template (t1 from the pivot, t2 = two sends from WATI)', cust.messages.map((m) => [m.template, m.attempts, m.measured, m.delivered, m.read]).sort(),
  [['t1', 3, 1, 1, 1], ['t2', 2, 2, 2, 1]])
eq('customer A: totals', pick(cust.totals, ['templates', 'attempts', 'measured', 'unmeasured']), { templates: 2, attempts: 5, measured: 3, unmeasured: 2 })

const costs = await api['costs/summary']({ from: '2026-11-13', to: '2026-11-14' })
eq('costs: only messages that did not fail are charged (w1, w2, w4)', costs.templates?.reduce((s, t) => s + t.units, 0) ?? costs.rows?.reduce((s, t) => s + t.units, 0), 3)

// ---- failed sends with no template name (WATI error 100, "missing information"): they are counted, labelled, and never put an empty entry into a filter list.
// (An empty entry in the template list crashed the whole page on 20 Nov 2026: the page lowercases every entry.)
await db.exec(`insert into public.wati_messages (wati_id, direction, phone_no, template_name, sent_at, delivered_at, read_at, replied_at, failed_at) values
  ('n1', 'template', '919877777777', null,  null,                        null, null, null, '2026-11-14 13:01+05:30'),
  ('n2', 'template', '919877777777', '   ', '2026-11-14 13:05+05:30',    null, null, null, '2026-11-14 13:06+05:30')`)
eq('no-name sends: both are in the view under one clear label', await Q(`select template_name, count(*)::int as n from reporting.v_message_sends where template_name like '(unknown%' group by 1`), [{ template_name: '(unknown template)', n: 2 }])
eq('no-name sends: no row of the view has an empty template name', (await Q(`select count(*)::int as n from reporting.v_message_sends where template_name is null or btrim(template_name) = ''`))[0].n, 0)
const kN = (await api['messages/kpis']({ from: '2026-11-13', to: '2026-11-14' })).current
eq('13-14 Nov: the two no-name failed sends are counted too (4 + 2 messages, 1 + 2 failed)', pick(kN, ['measured', 'failed']), { measured: 6, failed: 3 })
const mt = await api['meta']()
eq('filter lists: the template list has the label and no empty entry', [mt.templates.includes('(unknown template)'), mt.templates.some((v) => v == null || String(v).trim() === '')], [true, false])
eq('filter lists: sources, statuses and owners have no empty entry either', [mt.sources, mt.leadStatuses, mt.owners, mt.oppStatuses].map((a) => a.some((v) => v == null || String(v).trim() === '')), [false, false, false, false])
// the same view as it was BEFORE the fix would have produced the empty entry: prove the test can see it
await db.exec(`create temp view v_old_shape as select (case when btrim(coalesce(w.template_name, '')) = '' then null else w.template_name end) as template_name from public.wati_messages w where w.direction = 'template'`)
eq('sanity: without the label the same data does contain an empty template name', (await Q(`select count(*)::int as n from v_old_shape where template_name is null`))[0].n >= 2, true)

// ---- Chats page: chatbot messages are not team replies
await db.exec(sql('chats.sql'))
await db.exec(`delete from public.wati_messages;
insert into public.wati_messages (wati_id, direction, phone_no, ticket_id, operator_name, received_at, sent_at) values
  ('c1', 'inbound', '919855555555', 'T1', null,       now() - interval '3 hours', null),
  ('c2', 'session', '919855555555', 'T1', 'Bot',      null, now() - interval '3 hours' + interval '10 seconds'),
  ('c3', 'session', '919855555555', 'T1', 'KnowBot',  null, now() - interval '3 hours' + interval '20 seconds'),
  ('c4', 'session', '919855555555', 'T1', 'Priya Nair', null, now() - interval '2 hours'),
  ('c5', 'inbound', '919866666666', 'T2', null,       now() - interval '5 hours', null),
  ('c6', 'session', '919866666666', 'T2', 'Bot',      null, now() - interval '5 hours' + interval '15 seconds');`)
const ck = (await api['chats/kpis']({})).current
eq('chats: 1 team reply (Priya), 3 chatbot messages (Bot, KnowBot), 2 customer messages', pick(ck, ['team_msgs', 'bot_msgs', 'cust_msgs']), { team_msgs: 1, bot_msgs: 3, cust_msgs: 2 })
eq('chats: reply time is Priya\'s (60 min after the customer), not the bot\'s 10 seconds; the bot-only chat has no reply time', pick(ck, ['answered', 'fr_median']), { answered: 1, fr_median: 60 })
eq('chats: a chat answered only by the bot still counts as replied (the customer got an answer)', ck.replied, 2)
const list = await api['chats/list']({})
const t1 = list.rows?.find((r) => r.team_msgs === 1)
eq('chat list: the person who replied is Priya, not the bot', t1?.owner, 'Priya Nair')

console.log(`\n${pass} passed, ${fail} failed`)
await db.close()
process.exit(fail ? 1 : 0)
