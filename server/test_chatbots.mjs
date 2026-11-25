// Checks the Chatbots page endpoint against a tiny made-up database. Needs no server and no real data:
//   node server/test_chatbots.mjs
// The database (server/fixtures_chatbots.mjs) is an in-memory Postgres (PGlite) with public.wati_messages, public.delhi_bot_log and public.wati_status_events, loads
// server/sql/chats.sql and server/sql/chatbots.sql, and holds 5 Delhi chatbot customers, 3 bot chats and 3 "chatbot triggered" events whose numbers were worked out by hand.
// Nothing is read from or written to the real database.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// the names file is read from AQ_CONFIG_DIR: point it at a temp folder with one made-up id
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'aqbots-'))
fs.writeFileSync(path.join(cfg, 'chatbots.csv'), '# test\nchatbot_id,name\nbotA,Delhi yes button\n')
process.env.AQ_CONFIG_DIR = cfg
const { makeApi } = await import('./queries.mjs')
const { emptyDb, chatbotFixture } = await import('./fixtures_chatbots.mjs')

let pass = 0, fail = 0
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x))
const eq = (name, got, want) => {
  const ok = canon(got) === canon(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}
const api = (db) => makeApi({ query: async (sql, args = []) => (await db.query(sql, args)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))) })

// ---- 1. views not installed: every part says so instead of failing
{
  const db = await emptyDb()
  const r = await api(db)['chatbots/overview']({})
  eq('setup: nothing installed', { w: r.wati, d: r.delhi, t: r.triggers }, { w: { setup: true }, d: { setup: true }, t: { setup: true } })
  await db.close()
}

// ---- 2. the made-up data
const db = await chatbotFixture()
const r = await api(db)['chatbots/overview']({})
const w = r.wati, d = r.delhi, t = r.triggers

// WATI bots
eq('bots: customers and messages per chatbot', w.flows.map((f) => [f.flow, f.customers, f.msgs]).sort(), [['Delhi chatbot', 2, 4], ['KnowBot (AI assistant)', 1, 1], ['Welcome bot', 1, 1]])
eq('bots: all bots together count a customer once', { customers: w.total.customers, msgs: w.total.msgs }, { customers: 3, msgs: 6 })
eq('bots: a person\'s reply is not a bot message (Delhi chatbot = 4 messages, not 5)', w.flows.find((f) => f.flow === 'Delhi chatbot').msgs, 4)
eq('bots: Delhi chatbot steps', w.steps.filter((s) => s.flow === 'Delhi chatbot').map((s) => [s.step, s.customers]).sort(), [['Asked: solution', 2], ['Asked: timeline', 1], ['Requirement noted', 1]])
eq('bots: a text that starts with spaces is still recognised (requirement noted)', w.steps.find((s) => s.step === 'Requirement noted')?.msgs, 1)
eq('bots: welcome text with a line break is recognised', w.steps.find((s) => s.step === 'Welcome')?.msgs, 1)
eq('bots: per period rows add up', w.trend.reduce((a, x) => a + x.msgs, 0), 6)
eq('bots: per period customers (one per chatbot per day)', w.trend.reduce((a, x) => a + x.customers, 0), 4)
eq('bots: 24 hour list', w.hours.length, 24)

// Delhi chatbot
eq('delhi: customers (the bad phone is left out)', d.total.customers, 5)
eq('delhi: opening sent / answered', [d.total.opening_sent, d.total.answered], [5, 3])
eq('delhi: chose a solution / products / timeline / asked a question', [d.total.solution, d.total.products, d.total.timeline, d.total.asked_question], [2, 1, 2, 1])
eq('delhi: never answered (cold)', d.total.no_reply, 1)
eq('delhi: answered share', d.total.answered_pct, 60)
eq('delhi: tiers', d.tiers.map((x) => [x.tier, x.n]).sort(), [['Cold', 1], ['Hot + Query', 1], ['No tier yet', 1], ['Unqualified', 1], ['Warm', 1]])
eq('delhi: solution answers', d.answers.solution.map((x) => [x.v, x.n]).sort(), [['Complete solution', 1], ['Specific products', 1]])
eq('delhi: products answers', d.answers.products.map((x) => [x.v, x.n]), [['Showers', 1]])
eq('delhi: timeline answers', d.answers.timeline.map((x) => [x.v, x.n]), [['Within a month', 2]])
eq('delhi: combinations (answered customers only; each is 1 of 3)', d.combos.map((x) => [x.solution, x.products, x.timeline, x.tier, x.customers, x.share]).sort((a, b) => String(a[3]).localeCompare(String(b[3]))), [
  ['Specific products', 'Showers', 'Within a month', 'Hot + Query', 1, 33.3], [null, null, null, 'Unqualified', 1, 33.3], ['Complete solution', null, 'Within a month', 'Warm', 1, 33.3]])
eq('delhi: question text is not exposed', JSON.stringify(r).includes('small bathroom'), false)
eq('delhi: events and last event', [d.events, typeof d.last_event], [12, 'string'])
eq('delhi: per period customers add up', d.trend.reduce((a, x) => a + x.customers, 0), 5)

// WATI chatbot triggers
eq('triggers: each event counted once (two variants of e1), customers once a day', t.rows.map((x) => [x.chatbot_id, x.triggers, x.customers, x.name]).sort(), [['botA', 2, 1, 'Delhi yes button'], ['botB', 1, 1, null]])
eq('triggers: other events are ignored', t.rows.reduce((a, x) => a + x.triggers, 0), 3)

// the past conversations behind the numbers
{
  const L = await api(db)['chatbots/chats']({})
  eq('list: one row per customer per chatbot, newest first', L.rows.map((x) => [x.flow, x.msgs]).sort(), [['Delhi chatbot', 1], ['Delhi chatbot', 3], ['KnowBot (AI assistant)', 1], ['Welcome bot', 1]])
  eq('list: total', L.total, 4)
  const a = L.rows.find((x) => x.flow === 'Delhi chatbot' && x.msgs === 3), b = L.rows.find((x) => x.flow === 'Delhi chatbot' && x.msgs === 1)
  eq('list: steps in order, each once', a.steps, ['Asked: solution', 'Asked: timeline', 'Requirement noted'])
  eq('list: what the Delhi customer answered', [a.solution, a.products, a.timeline, a.tier, a.asked_question], ['Complete solution', null, 'Within a month', 'Warm', false])
  eq('list: second customer asked a question and is Hot + Query', [b.solution, b.products, b.tier, b.asked_question], ['Specific products', 'Showers', 'Hot + Query', true])
  eq('list: other chatbots have no Delhi answers', L.rows.filter((x) => x.flow !== 'Delhi chatbot').map((x) => [x.delhi, x.tier]), [[false, null], [false, null]])
  eq('list: numbers are masked, names are not sent', [L.revealed, L.rows.every((x) => x.phone && !x.phone.includes('9800000001') && x.name === null)], [false, true])
  const R = await api(db)['chatbots/chats']({ reveal: '1' })
  eq('list: with reveal the number is shown', [R.revealed, R.rows.some((x) => x.phone === '9800000001')], [true, true])
  const K = await api(db)['chatbots/chats']({ flow: 'KnowBot (AI assistant)' })
  eq('list: filter by chatbot', K.rows.map((x) => x.flow), ['KnowBot (AI assistant)'])
  eq('list: question text is not exposed', JSON.stringify(L).includes('small bathroom'), false)
}

// an installed copy from before phone10 was added: the page says what to run instead of failing
{
  const old = await chatbotFixture()
  await old.exec("drop view reporting.v_chatbot_messages; create view reporting.v_chatbot_messages as select wati_id, chat_key, at_ist, at_ist::date as day, 'Bot'::text as bot, 'x'::text as step, 'Delhi chatbot'::text as flow from reporting.v_chat_messages where false;")
  const o = await api(old)['chatbots/overview']({}), l = await api(old)['chatbots/chats']({})
  eq('old view without phone10: the overview still answers (customers counted by chat), only the list needs the new SQL', [o.wati.setup === undefined, !!o.delhi.total, !!o.triggers.rows], [true, true, true])
  eq('old view without phone10: list says setup', l.setup, true)
  await old.close()
}

// a date range with nothing in it
const none = await api(db)['chatbots/overview']({ from: '2020-01-01', to: '2020-01-02' })
eq('no data in range: zeros, not errors', [none.delhi.total.customers, none.wati.total.customers, none.triggers.rows.length], [0, 0, 0])

console.log(`\n${pass} passed, ${fail} failed`)
fs.rmSync(cfg, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
