// Checks that the "message" shown for a selected template comes from WATI's synced copy in the database, and from the exported file only as a fallback:
//   node server/test_template_message.mjs
// Runs the real ../../sent_messages/sent_messages.sql and template_versions.sql (including sync_wati_templates()) in an in-memory Postgres (PGlite),
// feeds it a WATI-shaped getMessageTemplates response and reads the result through GET costs/message. No server, no real data, nothing is written anywhere else.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { makeApi } from './queries.mjs'
import { loadMessages } from './costs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sentSql = path.resolve(here, '..', '..', 'sent_messages')
let pass = 0, fail = 0
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x))
const eq = (name, got, want) => { const ok = canon(got) === canon(want); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${canon(got)}\n        want ${canon(want)}`}`) }
const api = (db, MSG = 'unused') => makeApi({ query: async (sql, args = []) => (await db.query(sql, args)).rows, MSG, mode: 'test', asOf: '2026-01-01' })
const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)

const fileName = [...loadMessages().map.keys()][0]
if (!fileName) { console.log('The exported template file has no templates, so the fallback cannot be tested'); process.exit(1) }

// ---- 1. the sync is not set up: the exported file answers, and says so
{
  const db = new PGlite(); await db.exec('create schema reporting;')
  const r = await api(db)['costs/message']({ templates: fileName })
  eq('no sync in the database: the file answers and is labelled as the file', [r.live, r.messages[0].from, !!r.messages[0].body], [false, 'file', true])
  await db.close()
}

// ---- 2. the sync is set up
const db = new PGlite()
await db.exec(`create schema reporting;
  create table public.wati_status_events (id bigserial primary key, event_key text unique, whatsapp_message_id text, event_type text, wa_id text, template_id text, template_name text, received_at timestamptz not null default now(), raw_payload jsonb);`)
await db.exec(fs.readFileSync(path.join(sentSql, 'sent_messages.sql'), 'utf8'))
await db.exec(fs.readFileSync(path.join(sentSql, 'template_versions.sql'), 'utf8'))

await db.exec(`create table msgs (template_name text, first_sent_date date, sent int);
  insert into msgs values ('tpl_alpha', '2026-10-05', 3), ('tpl_alpha', '2026-10-20', 2), ('tpl_beta', '2026-10-12', 7);`)
const alpha = { id: '1', created: '2026-10-01T09:00:00Z', elementName: 'tpl_alpha', category: 'marketing', status: 'APPROVED', language: { value: 'en' }, lastModified: '2026-11-01T10:00:00Z', bodyOriginal: 'Hi {{CustomerName}}, your quote is ready.',
  footer: 'Aquant', header: { typeString: 'Text', text: 'Hello' }, buttons: [{ type: 'URL', parameter: { text: 'Open', url: 'https://example.com' } }], customParams: [{ paramName: 'CustomerName' }] }
const idFor = (iso) => Math.floor(Date.parse(iso) / 1000).toString(16).padStart(8, '0') + '0123456789abcdef'   // 8 hex digits of time + 16 more, like WATI's ids
const gamma = { id: idFor('2026-09-15T09:00:00Z'), elementName: 'tpl_gamma', category: 'MARKETING', status: 'APPROVED', language: { value: 'en' }, bodyOriginal: 'Gamma text.' }
const beta = { id: '2', elementName: 'tpl_beta', category: 'UTILITY', status: 'APPROVED', language: { value: 'en' }, bodyOriginal: 'Your order has shipped.' }
const sync = async (list) => (await db.query('select * from public.sync_wati_templates($1::jsonb)', [JSON.stringify({ messageTemplates: list })])).rows[0]
eq('first sync: 3 templates seen, 3 new, 0 new versions', await sync([alpha, beta, gamma]), { templates_seen: 3, new_templates: 3, new_versions: 0 })

const a = api(db, 'msgs')
const r1 = await a['costs/message']({ templates: `tpl_alpha|tpl_beta|${fileName}|tpl_nowhere|tpl_gamma` })
const gam = r1.messages[4]
eq('live: the answer says it came from WATI', [r1.live, /WATI/.test(r1.source)], [true, true])
const [m1, m2, m3, m4] = r1.messages
eq('alpha: text, footer and header exactly as written in WATI', [m1.from, m1.body, m1.footer, m1.header], ['wati', 'Hi {{CustomerName}}, your quote is ready.', 'Aquant', { kind: 'Text', text: 'Hello', file: '' }])
eq('alpha: category, status, language, last edited', [m1.category, m1.status, m1.language, m1.lastModified], ['MARKETING', 'APPROVED', 'en', '2026-11-01'])
eq('alpha: button and variable names', [m1.buttons, m1.params], [[{ type: 'URL', text: 'Open', url: 'https://example.com', phone: '' }], ['CustomerName']])
eq('alpha: version 1 and a sync time', [m1.version, typeof m1.syncedAt], [1, 'string'])
eq('beta: from WATI, no header, no buttons', [m2.from, m2.body, m2.header, m2.buttons], ['wati', 'Your order has shipped.', null, []])
eq('a template the sync does not know falls back to the file and is labelled so', [m3.from, !!m3.body], ['file', true])
eq('a template in neither place is reported missing', m4, { template_name: 'tpl_nowhere', missing: true })

// ---- details around the message: when it was added, first seen, first and last used
eq('alpha: added in WATI (from the created field WATI sent), first seen by us (today), WATI id', [m1.addedInWati, m1.firstSeen, m1.watiId], ['2026-10-01', todayIst(), '1'])
eq('beta: no created field and an id that is not a time-stamped id, so no date is shown', [m2.addedInWati, m2.addedHow], [null, null])
eq('alpha: a created field from WATI wins and is marked as a field', m1.addedHow, 'field')
eq('gamma: no created field, so the date is read from the id and marked as such', [gam.addedInWati, gam.addedHow], ['2026-09-15', 'id'])
eq('alpha: first used, last used and total sent from our own message data (all time)', [m1.firstSent, m1.lastSent, m1.totalSent], ['2026-10-05', '2026-10-20', 5])
eq('beta: usage', [m2.firstSent, m2.lastSent, m2.totalSent], ['2026-10-12', '2026-10-12', 7])
eq('a template with a single version has a one-entry history', m1.history.map((h) => [h.version, h.current]), [[1, true]])

// ---- 3. someone edits the template in WATI: the next sync is what the dashboard shows
eq('second sync with an edited text: 1 new version', await sync([{ ...alpha, bodyOriginal: 'Hi {{CustomerName}}, your NEW quote is ready.' }, beta, gamma]), { templates_seen: 3, new_templates: 0, new_versions: 1 })
const [e1] = (await a['costs/message']({ templates: 'tpl_alpha' })).messages
eq('after the edit: the new text, version 2, two versions seen', [e1.body, e1.version, e1.versions], ['Hi {{CustomerName}}, your NEW quote is ready.', 2, 2])
eq('edit history: newest first, old text kept, old version closed today', e1.history.map((h) => [h.version, h.current, h.body, h.until]), [[2, true, 'Hi {{CustomerName}}, your NEW quote is ready.', null], [1, false, 'Hi {{CustomerName}}, your quote is ready.', todayIst()]])
eq('a sync with nothing changed makes no new version', await sync([{ ...alpha, bodyOriginal: 'Hi {{CustomerName}}, your NEW quote is ready.' }, beta, gamma]), { templates_seen: 3, new_templates: 0, new_versions: 0 })

await db.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
