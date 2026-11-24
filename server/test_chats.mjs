// Checks the Chats v1 endpoints against a tiny made-up database. Needs no server and no real data:
//   node server/test_chats.mjs
// It builds public.wati_messages in an in-memory Postgres (PGlite), loads server/sql/chats.sql, inserts 7 chats whose numbers were worked out by hand
// (times are relative to now, so it passes on any day), and compares every figure. Nothing is read from or written to the real database.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { makeApi } from './queries.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x))
const eq = (name, got, want) => {
  const ok = canon(got) === canon(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const near = (name, got, want, tol = 0.011) => { const ok = Math.abs(got - want) <= tol; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${got}, want ${want})`}`) }

async function fresh() {
  const db = new PGlite()
  await db.exec(`create schema reporting;
    create function reporting.phone10(p text) returns text language sql immutable as $$ select right(regexp_replace(coalesce(p, ''), '\\D', '', 'g'), 10) $$;`)
  return db
}
const api = (db) => makeApi({ query: async (sql, args = []) => (await db.query(sql, args)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))), MSG: 'unused', mode: 'test', asOf: '2026-01-01' })

// ---- 1. view not installed: every chats endpoint says so instead of failing
{
  const db = await fresh(); const a = api(db)
  eq('setup: kpis without the view', await a['chats/kpis']({}), { setup: true })
  eq('setup: list without the view', await a['chats/list']({}), { setup: true })
  await db.close()
}

// ---- 2. the made-up chats
const db = await fresh()
await db.exec(`create table public.wati_messages (wati_id text primary key, direction text, phone_no text, template_name text, sender_name text, conversation_id text, ticket_id text,
  operator_email text, operator_name text, assignee_id text, sent_at timestamptz, received_at timestamptz, failed_at timestamptz, message_type text, delivered_at timestamptz, read_at timestamptz, replied_at timestamptz);`)
await db.exec(fs.readFileSync(path.join(here, 'sql', 'chats.sql'), 'utf8'))
const ago = (x) => `now() - interval '${x}'`
await db.exec(`insert into public.wati_messages (wati_id, direction, phone_no, template_name, sender_name, ticket_id, operator_name, assignee_id, sent_at, received_at, failed_at) values
  -- A: customer wrote 30 min ago, Priya answered 10 minutes later, she owns it            -> replied, assigned, first response 10 min
  ('a1', 'inbound',  '919800000001', null, 'Asha K',   'tA', null,    'a1', null, ${ago('30 minutes')}, null),
  ('a2', 'session',  '919800000001', null, null,       'tA', 'Priya', 'a1', ${ago('20 minutes')}, null, null),
  -- B: customer wrote 2 h ago, nobody answered, no owner                                  -> waiting, unassigned
  ('b1', 'inbound',  '919800000002', null, 'Bhavin',   'tB', null,    null, null, ${ago('2 hours')}, null),
  -- C: customer wrote 3 days ago, nobody answered                                         -> missed, unassigned, window closed
  ('c1', 'inbound',  '919800000003', null, 'Chitra',   'tC', null,    null, null, ${ago('3 days')}, null),
  -- D: only a template went out, the customer never wrote                                 -> outbound, one billed template
  ('d1', 'template', '919800000004', 'welcome_message', null, 'tD', null, null, ${ago('1 hour')}, null, null),
  -- E: template (billed) + a second template that failed (not billed) + customer + Rahul replying 10 min later
  ('e1', 'template', '919800000005', 'loss_message', null, 'tE', null, null, ${ago('5 hours')}, null, null),
  ('e2', 'template', '919800000005', 'loss_message', null, 'tE', null, null, null, null, ${ago('5 hours')}),
  ('e3', 'inbound',  '919800000005', null, 'Esha',     'tE', null,    'a2', null, ${ago('4 hours')}, null),
  ('e4', 'session',  '919800000005', null, null,       'tE', 'Rahul', 'a2', ${ago('3 hours 50 minutes')}, null, null),
  -- F: customer wrote 5 days ago, Priya answered 3 hours later                            -> replied, window closed, first response 180 min
  ('f1', 'inbound',  '919800000006', null, 'Farah',    'tF', null,    'a1', null, ${ago('5 days')}, null),
  ('f2', 'session',  '919800000006', null, null,       'tF', 'Priya', 'a1', ${ago('5 days')} + interval '3 hours', null, null);
  -- G: a template with neither ticket nor conversation id: the view groups it by phone and day -> outbound
  insert into public.wati_messages (wati_id, direction, phone_no, template_name, sent_at) values ('g1', 'template', '919811111111', 'welcome_message', ${ago('90 minutes')});`)
const a = api(db)

const k = await a['chats/kpis']({})
eq('kpis: coverage counts every message row', k.coverage.messages, 12)
const c = k.current
eq('chats', c.chats, 7)
eq('customer chats (the customer wrote)', c.customer_chats, 5)
eq('waiting / replied / missed / outbound', [c.waiting, c.replied, c.missed, c.outbound], [1, 3, 1, 2])
eq('window closed (customer chats whose last message is over 24 h old)', c.window_closed, 2)
eq('assigned / unassigned (customer chats only)', [c.assigned, c.unassigned], [3, 2])
eq('customer / team / template messages', [c.cust_msgs, c.team_msgs, c.templates], [5, 3, 3])
eq('all messages and messages per chat', [c.messages, c.msgs_per_chat], [12, 1.7])
eq('answered chats and replies within 1 h', [c.answered, c.within_hour, c.within_hour_pct], [3, 2, 40])
eq('first response: median and average (minutes)', [c.fr_median, c.fr_avg], [10, 66.7])
eq('shares of all chats (replied, outbound)', [c.replied_pct, c.outbound_pct], [42.9, 28.6])
eq('previous period is empty without a date range', k.previous, null)

const t = await a['chats/trend']({ grain: 'month' })
eq('trend: totals add up to the chat count', t.rows.reduce((s, r) => s + r.chats, 0), 7)
eq('trend: statuses add up to the chat count', t.rows.reduce((s, r) => s + r.waiting + r.replied + r.missed + r.outbound, 0), 7)

const ops = (await a['chats/operators']({})).rows
eq('operators: names and chat counts', ops.map((r) => [r.operator, r.chats]), [['Priya', 2], ['Rahul', 1]])
const priya = ops.find((r) => r.operator === 'Priya'), rahul = ops.find((r) => r.operator === 'Rahul')
eq('operator Priya: team msgs, median first response, within 1 h %', [priya.team_msgs, priya.fr_median, priya.within_hour_pct], [2, 95, 50])
eq('operator Rahul: median first response, within 1 h %', [rahul.fr_median, rahul.within_hour_pct], [10, 100])

const heat = (await a['chats/heatmap']({})).cells
eq('heatmap: every chat sits in one cell', heat.reduce((s, x) => s + x.chats, 0), 7)
const dur = (await a['chats/duration']({ grain: 'month' })).rows
eq('duration: chats with 2+ messages (A, E, F)', dur.reduce((s, r) => s + r.chats, 0), 3)

const cost = await a['chats/cost']({ grain: 'month' })
eq('cost: billed templates (the failed one is free)', cost.totals.units, 3)
eq('cost: chats counted', cost.totals.chats, 7)
eq('cost: units by status', Object.fromEntries(cost.by_status.map((s) => [s.status, s.units])), { outbound: 2, replied: 1, waiting: 0, missed: 0 })
near('cost: spend equals the sum over templates', cost.totals.spend, cost.by_template.reduce((s, x) => s + x.spend, 0))
near('cost: spend equals the sum over statuses', cost.totals.spend, cost.by_status.reduce((s, x) => s + x.spend, 0))
near('cost: cost per chat is spend / chats', cost.totals.cost_per_chat, cost.totals.spend / 7)
near('cost: spend on chats the customer never wrote in', cost.totals.no_reply_spend, cost.by_status.find((s) => s.status === 'outbound').spend)

const list = await a['chats/list']({})
eq('list: all chats, newest activity first (G is the one grouped by phone and day)', list.rows.map((r) => (r.key.startsWith('p:9811111111:') ? 'G' : r.key)), ['tA', 'tD', 'G', 'tB', 'tE', 'tC', 'tF'])
eq('list: phone masked by default', list.rows.find((r) => r.key === 'tA').phone, '•••••• 0001')
eq('list: no message text is ever returned', list.rows.some((r) => 'text' in r || 'message_text' in r), false)
eq('list: chat A is replied, owned by Priya, first response 10 min', (({ status, owner, first_response_min }) => [status, owner, first_response_min])(list.rows.find((r) => r.key === 'tA')), ['replied', 'Priya', 10])
eq('list: chat B is waiting and unassigned', (({ status, unassigned }) => [status, unassigned])(list.rows.find((r) => r.key === 'tB')), ['waiting', true])
eq('list: chat C is missed', list.rows.find((r) => r.key === 'tC').status, 'missed')
eq('list: chat D has a cost, chat A has none', [list.rows.find((r) => r.key === 'tD').cost > 0, list.rows.find((r) => r.key === 'tA').cost], [true, 0])
eq('list: the failed template adds no cost (E costs the same as one loss_message)', list.rows.find((r) => r.key === 'tE').templates, 1)
eq('list: phone shown only with reveal=1', (await a['chats/list']({ reveal: '1' })).rows.find((r) => r.key === 'tA').phone, '9800000001')
eq('list: status filter', (await a['chats/list']({ status: 'waiting|missed' })).rows.map((r) => r.key).sort(), ['tB', 'tC'])
const un = await a['chats/list']({ status: 'unassigned' })
eq('list: Unassigned filter = customer chats nobody owns (B waiting, C missed), not template-only chats', un.rows.map((r) => r.key).sort(), ['tB', 'tC'])
eq('list: the Unassigned filter agrees with the Unassigned tile', [un.rows.length, c.unassigned], [2, 2])
eq('list: Unassigned rows are flagged unassigned and have no owner', un.rows.every((r) => r.unassigned === true && r.owner == null), true)
const ist2 = new Date(Date.now() - 3 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10)   // the India-time day of chat C
eq('list: Unassigned filter respects the date range', (await a['chats/list']({ status: 'unassigned', from: ist2, to: ist2 })).rows.map((r) => r.key), ['tC'])

// ---- 3. a date range: the day of chat C (3 days ago, India time) holds only C
const ist = new Date(Date.now() - 3 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10)
const day = (await a['chats/kpis']({ from: ist, to: ist })).current
eq('date range: that one day has 1 chat and it is missed', [day.chats, day.missed], [1, 1])

// ---- 4. owners saved by the n8n step "Save assignment" (sql/assignments.sql)
await db.exec(fs.readFileSync(path.join(here, 'sql', 'assignments.sql'), 'utf8'))
await db.exec(`insert into public.wati_chat_assignments (wa_id, operator_email, operator_name, assigned_at) values
  -- chat B (customer wrote 2 h ago): an older assignment, then the latest one, both minutes after the customer wrote -> the latest wins
  ('+919800000002', 'old.owner@example.com',  'Old Owner',       now() - interval '1 hour 58 minutes'),
  ('+919800000002', 'christopher@example.com', 'Christopher Das', now() - interval '1 hour 55 minutes'),
  -- chat C (customer wrote 3 days ago): an assignment made only yesterday belongs to a LATER chat, not this one -> C stays without an owner
  ('+919800000003', 'late@example.com', 'Late Owner', now() - interval '1 day'),
  -- chat D is template-only (the customer never wrote): an owner does not make it a customer chat
  ('+919800000004', 'someone@example.com', null, now() - interval '50 minutes'),
  -- a number with no chat at all
  ('+919899999999', 'nobody@example.com', 'No Chat', now())`)
const a2 = api(db)   // a new API object, because the old one remembers (for a minute) that the assignments view was missing
const k2 = await a2['chats/kpis']({})
eq('owners: the new view is detected', k2.owners_from_assignments, true)
eq('owners: chat B (assigned by n8n minutes after the customer wrote) now counts as assigned: assigned 3 -> 4, unassigned 2 -> 1', [k2.current.assigned, k2.current.unassigned], [4, 1])
const l2 = await a2['chats/list']({})
const rowB = l2.rows.find((r) => r.key === 'tB'), rowC = l2.rows.find((r) => r.key === 'tC'), rowD = l2.rows.find((r) => r.key === 'tD')
eq('owners: B shows the latest assignment (Christopher Das), is still waiting, and is not unassigned', [rowB.owner, rowB.status, rowB.unassigned], ['Christopher Das', 'waiting', false])
eq('owners: C is still without an owner (the only assignment is from a later day)', [rowC.owner, rowC.unassigned], [null, true])
eq('owners: D (template only) is not turned into an assigned customer chat', [rowD.assigned, rowD.unassigned], [false, false])
eq('owners: a template-only chat shows no owner even if the same number was assigned (so the owner filter and the team table agree)', rowD.owner, null)
eq('owners: the Unassigned filter now lists only C', (await a2['chats/list']({ status: 'unassigned' })).rows.map((r) => r.key), ['tC'])
eq('owners: operator table now has Christopher Das with 1 chat', (await a2['chats/operators']({})).rows.filter((r) => r.operator === 'Christopher Das').map((r) => r.chats), [1])
eq('owners: the Waiting rows with an owner are chat B only', (await a2['chats/list']({ status: 'waiting' })).rows.map((r) => [r.key, r.owner]), [['tB', 'Christopher Das']])
// an assignment with no name falls back to the email
await db.exec(`insert into public.wati_chat_assignments (wa_id, operator_email, assigned_at) values ('+919800000003', 'nameless@example.com', now() - interval '2 days 23 hours 30 minutes')`)   // 30 minutes after the customer wrote
const a3 = api(db)
eq('owners: an assignment without a name shows the email', (await a3['chats/list']({})).rows.find((r) => r.key === 'tC').owner, 'nameless@example.com')

// ---- 5. names for chats where only we have messaged (WhatsApp gives a name only when the customer writes)
await db.exec(`create table public.lead_insight (lead_id text, customer_name text, customer_number text, created_at timestamp);
  create table public.opportunity_insight (opportunity_id text, customer_name text, customer_number text, created_at timestamp);
  create view reporting.v_leads as select lead_id, customer_name, reporting.phone10(customer_number) as phone10, created_at from public.lead_insight;
  create view reporting.v_opps as select opportunity_id, customer_name, reporting.phone10(customer_number) as phone10, created_at from public.opportunity_insight;
  insert into public.lead_insight values
    ('l1', 'Old Name',     '9800000004',  '2026-01-01'),   -- chat D (template only): two leads, the newest name wins
    ('l2', 'Dee Lead',     '+919800000004', '2026-06-01'),
    ('l3', '9800000004',   '9800000004',  '2026-07-01'),   -- a "name" that is really a phone number is ignored
    ('l4', 'Wrong Name',   '9800000001',  '2026-06-01');   -- chat A: the customer's own WhatsApp name (Asha K) must stay
  insert into public.opportunity_insight values ('o1', 'Gita Opportunity', '9811111111', '2026-05-01');   -- chat G (template only, no lead): named from the opportunity
  insert into public.wati_messages (wati_id, direction, phone_no, template_name, ticket_id, sent_at) values ('h1', 'template', '919822222222', 'welcome_message', 'tH', now() - interval '10 minutes');   -- chat H: nobody knows this number`)
const a4 = api(db)
const nm = Object.fromEntries((await a4['chats/list']({})).rows.map((r) => [r.key.startsWith('p:9811111111:') ? 'tG' : r.key, r.customer]))
eq('names: the customer\'s own WhatsApp name always wins (chat A)', nm.tA, 'Asha K')
eq('names: a template-only chat takes the NEWEST lead name and skips the phone-number "name" (chat D)', nm.tD, 'Dee Lead')
eq('names: with no lead, the opportunity name is used (chat G)', nm.tG, 'Gita Opportunity')
eq('names: nobody known for the number -> "Name unknown" (chat H)', nm.tH, 'Name unknown')
eq('names: masked view keeps lead names but hides phone-like names', (await a4['chats/list']({ reveal: '1' })).rows.find((r) => r.key === 'tD').customer, 'Dee Lead')

// ---- 6. WATI-style message charts and the team member filter
await db.exec(`insert into public.wati_messages (wati_id, direction, phone_no, template_name, message_type, ticket_id, sent_at, received_at, delivered_at, read_at, replied_at, failed_at) values
  ('z1', 'session',  '919877777777', null,              'image',    'tZ', now() - interval '30 minutes', null, null, null, null, null),
  ('z2', 'inbound',  '919877777777', null,              'image',    'tZ', null, now() - interval '29 minutes', null, null, null, null),
  ('z3', 'template', '919877777777', 'welcome_message', 'template', 'tZ', now() - interval '28 minutes', null, now() - interval '27 minutes', null, null, null),                                                    -- delivered
  ('z4', 'template', '919877777778', 'welcome_message', 'template', 'tY', now() - interval '28 minutes', null, now() - interval '27 minutes', now() - interval '26 minutes', null, null),                     -- read
  ('z5', 'template', '919877777779', 'welcome_message', 'template', 'tX', now() - interval '28 minutes', null, now() - interval '27 minutes', now() - interval '26 minutes', now() - interval '25 minutes', null), -- replied
  ('z6', 'template', '919877777780', 'welcome_message', 'template', 'tW', null, null, null, null, null, now() - interval '28 minutes'),                                                                       -- failed
  ('z7', 'template', '919877777781', 'welcome_message', 'template', 'tV', now() - interval '28 minutes', null, null, null, null, null)                                                                        -- sent only`)
const a5 = api(db)
const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0)
const fl = await a5['chats/flow']({ grain: 'month' })
// everything saved so far: 12 sent (7 templates + 3 earlier team replies + z1... counted below), 6 received, 2 failed
eq('flow: sent = templates that did not fail (4 earlier + z3 z4 z5 z7) + team replies (3 earlier + z1) = 12', sum(fl.rows, 'sent'), 12)
eq('flow: received = customer messages (5 earlier + z2) = 6', sum(fl.rows, 'received'), 6)
eq('flow: failed templates (e2, z6) = 2', sum(fl.rows, 'failed'), 2)
const flDay = await a5['chats/flow']({ grain: 'day', from: ist2, to: ist2 })
eq('flow: the one day of chat C holds only its one customer message', [sum(flDay.rows, 'sent'), sum(flDay.rows, 'received')], [0, 1])
const ty = (await a5['chats/message-types']({})).rows
const tyBy = Object.fromEntries(ty.map((r) => [r.type, [r.sent, r.received]]))
eq('types: image 1 sent + 1 received, template 4 sent, everything older has no type ("unknown": 7 sent, 5 received)', tyBy, { image: [1, 1], template: [4, 0], unknown: [7, 5] })
eq('types: the kinds add up to the same totals as the flow chart', [sum(ty, 'sent'), sum(ty, 'received')], [12, 6])
const dv = await a5['chats/delivery']({})
eq('delivery: 10 template messages, each counted once at its furthest step', [dv.total, dv.steps], [10, { failed: 2, replied: 1, read: 1, delivered: 1, sent_only: 5 }])
eq('delivery: the steps add up to the total', Object.values(dv.steps).reduce((t, v) => t + v, 0), dv.total)
eq('owners filter: Priya owns chats A and F', (await a5['chats/kpis']({ owners: 'Priya' })).current.chats, 2)
eq('owners filter: Priya or Rahul = 3 chats', (await a5['chats/kpis']({ owners: 'Priya|Rahul' })).current.chats, 3)
eq('owners filter: someone with no chats = 0', (await a5['chats/kpis']({ owners: 'Nobody Here' })).current.chats, 0)
eq('owners filter: the chat list follows it too', (await a5['chats/list']({ owners: 'Christopher Das' })).rows.map((r) => r.key), ['tB'])
eq('owners filter: the team table lists only the chosen person', (await a5['chats/operators']({ owners: 'Rahul' })).rows.map((r) => r.operator), ['Rahul'])

// ---- 7. WATI's own status, owners and tags (sql/wati_status.sql): the sync functions and the three cards that read them
const a6 = api(db)
eq('WATI status: before any sync the cards say "not available" instead of failing', [(await a6['chats/wati-status']({})).available, (await a6['chats/wati-operators']({})).available], [false, false])
await db.exec(fs.readFileSync(path.join(here, 'sql', 'wati_status.sql'), 'utf8'))
const a7 = api(db)
eq('WATI status: installed but empty is still "not available"', (await a7['chats/wati-status']({})).available, false)
const ago7 = (h) => new Date(Date.now() - h * 3600000).toISOString()
const conv = (id, status, assignee, o = {}) => ({ conversation_id: id, contact_id: 'ct-' + id, channel: { id: 'default', type: 'whatsapp' }, status, assignee_id: assignee, assignment: assignee ? 'assigned' : 'unassigned', tags: [], last_customer_message_at: ago7(o.h ?? 2), reply_state: 'awaiting_business', last_effective_reply_at: null, evaluated_at: ago7(0), ...o.extra })
const sync = async (items) => (await db.query('select * from public.sync_wati_conversations($1::jsonb)', [JSON.stringify({ items, page: { has_more: false } })])).rows[0]
await db.query('select * from public.sync_wati_operators($1::jsonb)', [JSON.stringify({ result: [
  { id: 'op1', fullName: 'Priya Nair', firstName: 'Priya', email: 'Priya@Example.com', roles: ['Operator'], isBot: false },
  { id: 'bot1', fullName: 'Chatbot', email: '', roles: [], isBot: true, botType: 'Flow' }] })])
const first = await sync([
  conv('c1', 'open', 'op1', { h: 2, extra: { tags: [{ id: 't1', name: 'Hot' }] } }),
  conv('c2', 'pending', 'op1', { h: 3, extra: { reply_state: 'replied', last_effective_reply_at: ago7(2), tags: [{ id: 't1', name: 'Hot' }, { id: 't2', name: 'Quote' }] } }),
  conv('c3', 'solved', 'bot1', { h: 5 }),
  conv('c4', 'solved', 'op1', { h: 6 }),
  conv('c5', 'expired', 'op1', { h: 30 }),                                                                              // expired, owned, never answered -> missed
  conv('c6', 'expired', 'op1', { h: 31, extra: { reply_state: 'replied', last_effective_reply_at: ago7(29) } }),          // expired but answered -> not missed
  conv('c7', 'expired', null, { h: 40 }),                                                                               // expired, unassigned
  conv('c8', 'open', null, { h: 1 }),                                                                                   // open, unassigned
  conv('c9', 'solved', 'op1', { h: 72 }),                                                                               // 3 days ago
  conv('c9', 'solved', 'op1', { h: 72 }),                                                                               // the same conversation twice in one page: counted once
])
eq('sync: 9 conversations received (the duplicate is dropped), 9 new, 0 changed', first, { received: 9, new_conversations: 9, changed: 0 })
const st = await a7['chats/wati-status']({})
eq('status: live Open and Pending (all conversations, ignoring the dates)', [st.available, st.live], [true, { open: 2, pending: 1 }])
eq('status: solved 3 (1 by the bot, 2 by people), expired 3, missed 1 (owned, expired, never answered), unassigned 2, total 9', st.period, { total: 9, solved: 3, solved_by_bot: 1, solved_by_operator: 2, expired: 3, missed: 1, unassigned: 2 })
const stDay = await a7['chats/wati-status']({ from: ist2, to: ist2 })
eq('status: the day of c9 (3 days ago) holds only that one solved conversation; live counts stay', [stDay.period.total, stDay.period.solved, stDay.live], [1, 1, { open: 2, pending: 1 }])
const wo = (await a7['chats/wati-operators']({})).rows
eq('team: Priya Nair owns 6 conversations (1 open, 1 pending, 2 solved, 2 expired, 1 missed)', wo.find((r) => r.operator === 'Priya Nair'), { operator: 'Priya Nair', is_bot: false, assigned: 6, open: 1, pending: 1, solved: 2, expired: 2, missed: 1 })
const woDay = (await a7['chats/wati-operators']({ from: ist2, to: ist2 })).rows
eq('team: on the day of c9 only (3 days ago) Priya has 1 assigned and 1 solved, but her Open and Pending are still right now (1 and 1)', woDay.find((r) => r.operator === 'Priya Nair'), { operator: 'Priya Nair', is_bot: false, assigned: 1, solved: 1, expired: 0, missed: 0, open: 1, pending: 1 })
eq('team: the bot is listed as a bot with 1 solved', wo.find((r) => r.operator === 'Chatbot'), { operator: 'Chatbot', is_bot: true, assigned: 1, open: 0, pending: 0, solved: 1, expired: 0, missed: 0 })
eq('team: unassigned conversations belong to nobody', wo.reduce((t, r) => t + r.assigned, 0), 7)
eq('tags: Hot 2, Quote 1, busiest first', (await a7['chats/wati-tags']({})).rows, [{ tag: 'Hot', chats: 2 }, { tag: 'Quote', chats: 1 }])
// a second sync: c1 becomes pending, c10 appears, nothing else changes
const second = await sync([conv('c1', 'pending', 'op1', { h: 2 }), conv('c10', 'open', 'op1', { h: 1 }), conv('c8', 'open', null, { h: 1 })])
eq('sync again: 3 received, 1 new (c10), 1 changed (c1 moved to pending), c8 unchanged', second, { received: 3, new_conversations: 1, changed: 1 })
eq('history: 9 first sightings + c1 changing + c10 appearing = 11 lines', Number((await db.query('select count(*)::int as n from public.wati_conversation_status_log')).rows[0].n), 11)
eq('history: c1 has two lines, open then pending', (await db.query(`select status from public.wati_conversation_status_log where conversation_id = 'c1' order by id`)).rows.map((r) => r.status), ['open', 'pending'])
const st2 = await a7['chats/wati-status']({})
eq('status after the change: live Open 2 (c8, c10), Pending 2 (c1, c2)', st2.live, { open: 2, pending: 2 })
const third = await sync([conv('c11', 'broadcast', 'op1', { h: 4 })])
eq('sync: a broadcast conversation (we messaged, no reply) is new', third, { received: 1, new_conversations: 1, changed: 0 })
const st3 = await a7['chats/wati-status']({})
eq('status: a broadcast conversation (we messaged, no reply) is left out of every number: total stays 10 (9 + c10)', [st3.period.solved, st3.period.expired, st3.period.unassigned, st3.period.total], [3, 3, 2, 10])
eq('status: a broadcast conversation owned by a person is not counted for that person either', (await a7['chats/wati-operators']({})).rows.find((r) => r.operator === 'Priya Nair').assigned, 7)
// WATI's owner is the first source of a chat's owner (matched by the conversation id on the messages)
await db.exec(`update public.wati_messages set conversation_id = 'c2' where ticket_id = 'tD'; update public.wati_messages set conversation_id = 'c3' where ticket_id = 'tB'; update public.wati_messages set conversation_id = 'c7' where ticket_id = 'tC'`)
const a8 = api(db)
const wl = (await a8['chats/list']({ limit: 50 })).rows
const own = (key) => { const r = wl.find((x) => x.key === key); return [r.owner, r.assigned] }
eq('WATI owner: an outbound chat (customer never wrote) shows the owner WATI has, but does not count as an owner-known customer chat', own('tD'), ['Priya Nair', false])
eq('WATI owner: a waiting chat with no owner in the messages gets the owner from WATI (a bot is shown by its name)', own('tB'), ['Chatbot', true])
eq('WATI owner: WATI says nobody owns it -> the owner we already knew (saved assignment) stays', own('tC'), ['nameless@example.com', true])
eq('WATI owner: a chat without a WATI match keeps the owner the messages show', own('tA'), ['Priya', true])
eq('WATI owner: the Owner known tile counts the chat WATI assigned (tB) on top of A, C, E, F', (await a8['chats/kpis']({})).current.assigned, 5)
let bad = null
try { await db.query('select * from public.sync_wati_conversations($1::jsonb)', [JSON.stringify({ nope: 1 })]) } catch (e) { bad = e.message }
eq('sync: an answer that is not WATI\'s conversation list is refused with a clear message', /no items array/.test(bad ?? ''), true)

// c12: customer wrote 72 h ago, so it expired 48 h ago: counted on the day it expired, not on the day the customer wrote
await sync([conv('c12', 'expired', 'op1', { h: 72 })])
const istExp = new Date(Date.now() - 48 * 3600000 + 5.5 * 3600000).toISOString().slice(0, 10), istWrote = new Date(Date.now() - 72 * 3600000 + 5.5 * 3600000).toISOString().slice(0, 10)
const xDay = await a7['chats/wati-status']({ from: istExp, to: istExp })
eq('expiry day: the chat that expired 48 h ago counts as Expired and Missed on that day', [xDay.period.expired, xDay.period.missed], [1, 1])
if (istWrote !== istExp) eq('expiry day: it does not count as Expired on the day the customer wrote', (await a7['chats/wati-status']({ from: istWrote, to: istWrote })).period.expired, 0)
eq('expiry day: Priya\'s Expired and Missed on that day are 1 and 1', (await a7['chats/wati-operators']({ from: istExp, to: istExp })).rows.find((r) => r.operator === 'Priya Nair'), { operator: 'Priya Nair', is_bot: false, assigned: 0, solved: 0, expired: 1, missed: 1, open: 1, pending: 2 })

// ---- 8. "Right now" (the Team Inbox filters) and the chats behind each number
// Now: c1 pending, c2 pending, c3/c4/c9 solved, c5/c6/c7/c12 expired, c8/c10 open, c11 broadcast (owned). c13 is a broadcast nobody owns (we messaged, they never wrote).
await sync([conv('c13', 'broadcast', null, { h: 6 })])
const rnOf = (s) => { const { open, pending, expired, unassigned, unassigned_customer } = s.right_now; return { open, pending, expired, unassigned, unassigned_customer } }   // the original five figures (section 10 checks the newer ones)
const rn = await a7['chats/wati-status']({})
eq('right now: Open 2 (c8, c10), Pending 2 (c1, c2), Expired 4 (c5, c6, c7, c12), Unassigned 3 (c7, c8, and the broadcast c13), 2 without the broadcast',
  rnOf(rn), { open: 2, pending: 2, expired: 4, unassigned: 3, unassigned_customer: 2 })
eq('right now: it says when WATI\'s status was saved', typeof rn.right_now.as_of === 'string' && rn.right_now.as_of.length >= 16, true)
const WIDE = { from: '2000-01-01', to: '2100-01-01' }
eq('right now: a date range that covers everything shows the whole inbox', rnOf(await a7['chats/wati-status'](WIDE)), rnOf(rn))
eq('right now: it follows the date range: on the day c9 and c12 were last written there is nothing open, pending or unassigned', rnOf(await a7['chats/wati-status']({ from: ist2, to: ist2 })),
  { open: 0, pending: 0, expired: 0, unassigned: 0, unassigned_customer: 0 })
// c7 (unassigned, expired) last wrote 40 h ago: it shares that India day with "48 h ago" only at some times of day, so the expected figure is worked out from the clock
const istOfH = (h) => new Date(Date.now() - h * 3600000 + 5.5 * 3600000).toISOString().slice(0, 10), c7Today = istOfH(40) === istExp ? 1 : 0
eq('right now: Expired follows the day the chat expired (c12 expired 48 h ago), the others follow the day the customer last wrote (c7 only if it last wrote that day)', rnOf(await a7['chats/wati-status']({ from: istExp, to: istExp })),
  { open: 0, pending: 0, expired: 1, unassigned: c7Today, unassigned_customer: c7Today })
eq('right now: the existing Open and Pending figures are unchanged', rn.live, { open: 2, pending: 2 })
eq('right now: the Agent filter applies (Priya Nair: 1 open, 2 pending, 3 expired, and nothing is unassigned to her)', rnOf(await a7['chats/wati-status']({ owners: 'Priya Nair' })),
  { open: 1, pending: 2, expired: 3, unassigned: 0, unassigned_customer: 0 })
const keysOf = async (state, extra = {}) => (await a7['chats/wati-list']({ state, ...extra }))
eq('list: Open is c8 and c10', (await keysOf('open')).rows.map((r) => r.key).sort(), ['c10', 'c8'])
eq('list: Pending is c1 and c2', (await keysOf('pending')).rows.map((r) => r.key).sort(), ['c1', 'c2'])
eq('list: Expired is c12, c5, c6, c7', (await keysOf('expired')).rows.map((r) => r.key).sort(), ['c12', 'c5', 'c6', 'c7'])
eq('list: Unassigned is c13, c7, c8 (it includes the broadcast nobody owns)', (await keysOf('unassigned')).rows.map((r) => r.key).sort(), ['c13', 'c7', 'c8'])
for (const s of ['open', 'pending', 'expired', 'unassigned']) eq(`list: the ${s} list is as long as its tile`, (await keysOf(s)).total, { open: rn.right_now.open, pending: rn.right_now.pending, expired: rn.right_now.expired, unassigned: rn.right_now.unassigned }[s])
const ex = (await keysOf('expired')).rows, ex5 = ex.find((r) => r.key === 'c5'), ex7 = ex.find((r) => r.key === 'c7')
eq('list: an owned chat shows its owner, status and assignment', [ex5.owner, ex5.owner_is_bot, ex5.status, ex5.assignment], ['Priya Nair', false, 'expired', 'assigned'])
eq('list: an unowned chat has no owner', [ex7.owner, ex7.assignment], [null, 'unassigned'])
eq('list: the newest customer message comes first', (await keysOf('expired')).rows.map((r) => r.last_wrote), [...(await keysOf('expired')).rows.map((r) => r.last_wrote)].sort().reverse())
eq('list: the customer name shows, the phone number is masked', [ex7.customer, ex7.phone, (await keysOf('expired')).revealed], ['Chitra', '•••••• 0003', false])
eq('list: with reveal the phone number shows', ((await keysOf('expired', { reveal: '1' })).rows.find((r) => r.key === 'c7') ?? {}).phone, '9800000003')
eq('list: a chat with no saved messages has no phone and an honest name', [ex5.customer, ex5.phone], ['Name unknown', ''])
eq('list: the Agent filter applies', (await keysOf('expired', { owners: 'Priya Nair' })).rows.map((r) => r.key).sort(), ['c12', 'c5', 'c6'])
eq('list: the limit applies but the total stays', [(await keysOf('expired', { limit: 2 })).rows.length, (await keysOf('expired', { limit: 2 })).total], [2, 4])
eq('list: an unknown state is refused, not run', [(await keysOf('solved')).rows, (await keysOf("open' or '1'='1")).state], [[], null])

// ---- 9. the same tiles and lists follow the page's Lead source filter (matched by phone number) and the date range
// Phones come from the messages saved for a conversation: c7 = Chitra (9800000003), c3 = Bhavin (9800000002), c2 = 9800000004. Every other conversation has no saved message.
await db.exec(`alter table public.lead_insight add column lead_source text;
  create or replace view reporting.v_leads as select lead_id, customer_name, reporting.phone10(customer_number) as phone10, created_at, coalesce(nullif(lead_source, ''), '(none)') as lead_source from public.lead_insight;
  insert into public.lead_insight values ('l10', 'Chitra Lead', '9800000003', '2026-08-01', 'Website'), ('l11', 'Bhavin Lead', '9800000002', '2026-08-01', 'Instagram'),
    ('l12', 'Older Chitra', '9800000003', '2026-01-01', 'Referral')`)   // l12 is older than l10: the newest lead with that phone number decides
const a9 = api(db)
eq('source filter: Website = only c7 (Chitra: expired and unassigned)', rnOf(await a9['chats/wati-status']({ sources: 'Website' })), { open: 0, pending: 0, expired: 1, unassigned: 1, unassigned_customer: 1 })
eq('source filter: the newest lead with the phone number decides (not the older Referral)', rnOf(await a9['chats/wati-status']({ sources: 'Referral' })), { open: 0, pending: 0, expired: 0, unassigned: 0, unassigned_customer: 0 })
eq('source filter: two sources add up (Website c7 + Instagram c3, which is solved)', rnOf(await a9['chats/wati-status']({ sources: 'Website|Instagram' })), { open: 0, pending: 0, expired: 1, unassigned: 1, unassigned_customer: 1 })
eq('source filter: "(no matching lead)" = every conversation without a lead (all but c7, c3 and c2)', rnOf(await a9['chats/wati-status']({ sources: '(no matching lead)' })),
  { open: 2, pending: 1, expired: 3, unassigned: 2, unassigned_customer: 1 })
eq('source filter: it combines with the Agent filter (Priya Nair, no lead: her 3 expired chats)', rnOf(await a9['chats/wati-status']({ sources: '(no matching lead)', owners: 'Priya Nair' })),
  { open: 1, pending: 1, expired: 3, unassigned: 0, unassigned_customer: 0 })
eq('source filter: with no source picked nothing changes', rnOf(await a9['chats/wati-status']({})), rnOf(rn))
eq('source filter: the list follows it (expired + Website = c7)', (await a9['chats/wati-list']({ state: 'expired', sources: 'Website' })).rows.map((r) => r.key), ['c7'])
eq('source filter: the list follows it (expired + no lead = c12, c5, c6)', (await a9['chats/wati-list']({ state: 'expired', sources: '(no matching lead)' })).rows.map((r) => r.key).sort(), ['c12', 'c5', 'c6'])
eq('source filter: the list total matches the tile', (await a9['chats/wati-list']({ state: 'expired', sources: '(no matching lead)' })).total, 3)
eq('date filter: the Expired list follows the day the chat expired (c12 only)', (await a9['chats/wati-list']({ state: 'expired', from: istExp, to: istExp })).rows.map((r) => r.key), ['c12'])
eq('date filter: the Open list on a day with nothing open is empty, with a total of 0', [(await a9['chats/wati-list']({ state: 'open', from: ist2, to: ist2 })).rows.length, (await a9['chats/wati-list']({ state: 'open', from: ist2, to: ist2 })).total], [0, 0])
eq('date filter: a covering range gives the whole list', (await a9['chats/wati-list']({ state: 'open', ...WIDE })).rows.map((r) => r.key).sort(), ['c10', 'c8'])
eq('the other numbers on the page are not affected by the new filters', [(await a9['chats/wati-status']({ sources: 'Website' })).live, (await a9['chats/wati-status']({ sources: 'Website' })).period.total], [(await a9['chats/wati-status']({})).live, (await a9['chats/wati-status']({})).period.total])

// ---- 10. status as it is NOW (24 h by the clock), who still needs a reply, bot-held chats, and the "who followed up" groups
// c14: stored as Open, but the customer wrote 30 h ago, so its 24 hours are up: it counts as Expired without waiting for WATI's next sync.
// c15: the chatbot holds it (WATI says "unassigned", the owner is the bot), customer wrote 1 h ago, nobody answered.
await sync([conv('c14', 'open', 'op1', { h: 30 }), conv('c15', 'open', 'bot1', { h: 1, extra: { assignment: 'unassigned' } })])
const rn10 = await a7['chats/wati-status']({})
eq('clock expiry: c14 (stored Open, 30 h old) is not counted as Open or Pending any more', [rn10.live, rn10.right_now.open, rn10.right_now.pending], [{ open: 3, pending: 2 }, 3, 2])
eq('clock expiry: it is counted as Expired (c5, c6, c7, c12, c14)', rn10.right_now.expired, 5)
eq('clock expiry: the Expired list shows it with the status "expired"', (await keysOf('expired')).rows.filter((r) => r.key === 'c14').map((r) => r.status), ['expired'])
eq('clock expiry: a chat expired by the clock cannot be listed as Open', (await keysOf('open')).rows.map((r) => r.key).sort(), ['c10', 'c15', 'c8'])
eq('needs reply: open or pending and no PERSON has answered the latest message (c1, c8, c10, c15; c2 was answered by a person)', (await keysOf('needs_reply')).rows.map((r) => r.key).sort(), ['c1', 'c10', 'c15', 'c8'])
eq('needs reply: the tile equals its list', [rn10.right_now.needs_reply, (await keysOf('needs_reply')).total], [4, 4])
eq('unassigned split: 4 with no owner in all (c7, c8, c13, c15), 3 are customers (c7, c8, c15): 1 held by the bot, 2 with nobody',
  [rn10.right_now.unassigned, rn10.right_now.unassigned_customer, rn10.right_now.unassigned_bot, rn10.right_now.unassigned_nobody], [4, 3, 1, 2])
eq('bot-held list: only c15 (the broadcast nobody owns is not a customer waiting)', (await keysOf('bot_held')).rows.map((r) => [r.key, r.owner, r.owner_is_bot]), [['c15', 'Chatbot', true]])
const w8 = (await keysOf('open')).rows.find((r) => r.key === 'c8').waiting_min
eq('lists: each row says how many minutes ago the customer last wrote (c8 wrote 1 h ago)', [Number.isInteger(w8), w8 >= 59 && w8 <= 63], [true, true])
eq('the period tile is not changed by clock expiry: solved still 3', (await a7['chats/wati-status']({})).period.solved, 3)

// who followed up: needs the Salesforce views, so before they exist it says so
eq('follow-up: without the Salesforce columns it says so instead of failing', await a7['chats/follow-up']({}), { available: false, needsSalesforceView: true })
await db.exec(`insert into public.wati_messages (wati_id, direction, phone_no, sender_name, conversation_id, received_at) values
  ('p1', 'inbound', '919800000011', 'P One', 'c1', now()), ('p8', 'inbound', '919800000018', 'P Eight', 'c8', now()),
  ('p14', 'inbound', '919800000014', 'P Fourteen', 'c14', now()), ('p15', 'inbound', '919800000015', 'P Fifteen', 'c15', now());
  drop view if exists reporting.v_leads cascade; drop view if exists reporting.v_opps cascade;
  create table sf_leads (lead_id text, customer_name text, phone10 text, created_at timestamptz, lead_source text, lead_status text, task1 int, task2 int, task3 int, to_nurturing int, to_not_connected int, to_unqualified int);
  create view reporting.v_leads as select * from sf_leads;
  insert into sf_leads values ('s1', 'One', '9800000011', now(), 'Website', 'New', 1, 0, 0, 0, 0, 0),            -- still New, but a follow-up task exists -> worked
    ('s14', 'Fourteen', '9800000014', now(), 'Website', 'Not Connected', 0, 0, 0, 0, 0, 0),                          -- status moved on (they called, no answer) -> worked
    ('s15', 'Fifteen', '9800000015', now(), 'Website', 'New', 0, 0, 0, 0, 0, 0);                                    -- New and nothing else -> untouched
  create view reporting.v_opps as select 'o1'::text as opportunity_id, '9800000018'::text as phone10;           -- c8 has an opportunity -> worked`)
const a10 = api(db)
const fu = await a10['chats/follow-up']({})
eq('follow-up: 13 customer chats = 2 replied + 3 followed up elsewhere + 3 untouched + 5 cannot tell (template-only chats left out)', fu, { available: true, total: 13, replied: 2, elsewhere: 3, untouched: 3, unknown: 5 })
eq('follow-up: the four groups add up to the total', fu.replied + fu.elsewhere + fu.untouched + fu.unknown, fu.total)
const fuKeys = async (g, extra = {}) => (await a10['chats/wati-list']({ state: g, ...extra })).rows.map((r) => r.key).sort()
eq('follow-up list: replied = c2, c6 (a person answered)', await fuKeys('fu_replied'), ['c2', 'c6'])
eq('follow-up list: followed up elsewhere = c1 (task), c14 (status moved), c8 (opportunity)', await fuKeys('fu_elsewhere'), ['c1', 'c14', 'c8'])
eq('follow-up list: untouched = c15 (still New), c3 and c7 (no lead at all)', await fuKeys('fu_untouched'), ['c15', 'c3', 'c7'])
eq('follow-up list: cannot tell = the chats with no saved phone number', await fuKeys('fu_unknown'), ['c10', 'c12', 'c4', 'c5', 'c9'])
eq('follow-up list: each list is as long as its number', [(await a10['chats/wati-list']({ state: 'fu_untouched' })).total, (await a10['chats/wati-list']({ state: 'fu_elsewhere' })).total], [fu.untouched, fu.elsewhere])
eq('follow-up: the Agent filter applies (Priya Nair owns c1, c4, c5, c6, c9, c10, c12, c14, c2)', (await a10['chats/follow-up']({ owners: 'Priya Nair' })).total, 9)
eq('follow-up: a day with no chats is all zeros', await a10['chats/follow-up']({ from: '2000-01-01', to: '2000-01-02' }), { available: true, total: 0, replied: 0, elsewhere: 0, untouched: 0, unknown: 0 })

await db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
