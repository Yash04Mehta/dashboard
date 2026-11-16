// What the WhatsApp templates cost. Read-only: it reads two small config files (and, if present, an export of the
// Template Category Monitor's table) and multiplies the messages actually sent by the price in force on the send date.
//
//   config/rate_card.csv           category, price, currency, effective_from, source, note   (one row per price; add a row when a price changes)
//   config/template_categories.csv template_name, category, source                          ("*" row = guess for templates not listed)
//   ../data_insight/wati_template_status.csv  optional export of public.wati_template_status. Its rows win over the file above,
//                                  and previous_category + last_changed_at are used so sends before a category change are priced as before.
//   ../data_insight/wati_templates.json  optional fresh WATI "get message templates" response; else config/template_messages.json (same shape).
//                                  Gives each template's message text (shown on the page) and, for templates on neither list above, its category.
//
// A message is billed when it is sent and not failed, so the unit is the "sent" counter (repeat sends included), not the
// "followed" base that the rates use. First-send date decides the price for all sends of a person-and-template pair.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const FILES = {
  rates: path.resolve(here, '..', 'config', 'rate_card.csv'),
  cats: path.resolve(here, '..', 'config', 'template_categories.csv'),
  status: path.resolve(here, '..', '..', 'data_insight', 'wati_template_status.csv'),
  messagesFresh: path.resolve(here, '..', '..', 'data_insight', 'wati_templates.json'),
  messages: path.resolve(here, '..', 'config', 'template_messages.json'),
}
export const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE']

/** changes whenever a config file does, so the server's response cache does not serve old prices */
export const configStamp = () => Object.values(FILES).map((f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }).join('-')

function parseCsv(text) {
  const rows = []
  let row = [], f = '', q = false
  text = text.replace(/^﻿/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x !== '')) rows.push(row); row = [] }
    else f += c
  }
  if (f !== '' || row.length) { row.push(f); if (row.some((x) => x !== '')) rows.push(row) }
  const [head, ...body] = rows
  if (!head) return []
  const keys = head.map((h) => h.trim().toLowerCase())
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])))
}
const readCsv = (file) => { try { return { found: true, rows: parseCsv(fs.readFileSync(file, 'utf8')) } } catch (e) { return e.code === 'ENOENT' ? { found: false, rows: [] } : { found: true, rows: [], error: e.message } } }

/** 2026-10-23, 2026-10-23T12:00:00Z or 23/10/2026 12:54:15+00 -> 2026-10-23, else null */
function toDate(s) {
  const t = String(s ?? '').trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t)
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}
const cat = (v) => String(v ?? '').trim().toUpperCase()

/** message text of every template, from the WATI export. Company-written text, no customer data. Re-read only when the file changes. */
let msgCache = { key: '', value: null }
export function loadMessages() {
  const file = [FILES.messagesFresh, FILES.messages].find((f) => fs.existsSync(f))
  if (!file) return { found: false, map: new Map(), source: null, problems: [] }
  const key = file + fs.statSync(file).mtimeMs
  if (msgCache.key === key) return msgCache.value
  const value = { found: true, map: new Map(), source: path.relative(path.resolve(here, '..'), file).split(path.sep).join('/'), problems: [] }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    const pages = Array.isArray(j) ? j : [j]
    for (const t of pages.flatMap((pg) => pg?.messageTemplates ?? [])) {
      if (!t?.elementName) continue
      value.map.set(t.elementName, {
        template_name: t.elementName, category: cat(t.category), status: t.status || '', language: t.language?.value || '', lastModified: toDate(t.lastModified),
        header: t.header ? { kind: t.header.typeString || '', text: t.header.text || '', file: t.header.mediaFromPC || '' } : null,
        body: t.bodyOriginal || t.body || '', footer: t.footer || '',
        buttons: (t.buttons ?? []).map((b) => ({ type: b.type || '', text: b.parameter?.text || '', url: b.parameter?.url || '', phone: b.parameter?.phoneNumber || '' })),
        params: (t.customParams ?? []).map((p) => p.paramName).filter(Boolean),
      })
    }
  } catch (e) { value.problems.push(`${path.basename(file)} could not be read: ${e.message}`) }
  msgCache = { key, value }
  return value
}

export function loadConfig() {
  const problems = []
  const rc = readCsv(FILES.rates), cc = readCsv(FILES.cats), sc = readCsv(FILES.status)
  for (const [name, r] of [['rate_card.csv', rc], ['template_categories.csv', cc], ['wati_template_status.csv', sc]]) if (r.error) problems.push(`${name} could not be read: ${r.error}`)
  if (!rc.found) problems.push('config/rate_card.csv is missing, so no prices are known and every cost is zero.')

  const rates = []
  for (const r of rc.rows) {
    const c = cat(r.category), price = Number(r.price), date = toDate(r.effective_from)
    if (!CATEGORIES.includes(c) || r.price === '' || !Number.isFinite(price) || price < 0 || !date) { problems.push(`rate_card.csv: skipped a row it could not read (${r.category || 'no category'}, ${r.price || 'no price'}, ${r.effective_from || 'no date'}).`); continue }
    rates.push({ category: c, price, currency: (r.currency || 'INR').toUpperCase(), effective_from: date, source: r.source || '', note: r.note || '' })
  }
  rates.sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0))
  const currency = rates[0]?.currency ?? 'INR'
  if (rates.some((r) => r.currency !== currency)) problems.push(`rate_card.csv mixes currencies. Only ${currency} is used for totals, so make them all the same.`)

  const templates = new Map()
  let fallback = 'MARKETING'
  for (const r of cc.rows) {
    const c = cat(r.category)
    if (!CATEGORIES.includes(c)) { problems.push(`template_categories.csv: "${r.category}" is not a category (use ${CATEGORIES.join(', ')}); row for ${r.template_name || 'no name'} skipped.`); continue }
    if (r.template_name === '*') fallback = c
    else if (r.template_name) templates.set(r.template_name, { category: c, previous: null, changedAt: null, source: r.source || 'template_categories.csv' })
  }
  for (const r of sc.rows) {
    const c = cat(r.category)
    if (!r.template_name || !CATEGORIES.includes(c)) continue          // NOT_FOUND templates have no category
    const prev = cat(r.previous_category)
    templates.set(r.template_name, { category: c, previous: CATEGORIES.includes(prev) ? prev : null, changedAt: toDate(r.last_changed_at), source: 'wati_template_status.csv' })
  }
  const msgs = loadMessages()
  problems.push(...msgs.problems)
  for (const [n, m] of msgs.map) if (!templates.has(n) && CATEGORIES.includes(m.category)) templates.set(n, { category: m.category, previous: null, changedAt: null, source: 'WATI template export', fromExport: true })
  return { rates, currency, templates, fallback, problems, msgs, found: { rates: rc.found, categories: cc.found, status: sc.found } }
}

const categoryOn = (t, d) => (t.previous && t.changedAt && d < t.changedAt ? t.previous : t.category)
const r4 = (v) => Math.round(v * 10000) / 10000

/** WATI's creation date for a template, if its answer has one (the export we have shows only lastModified). Tries the usual field names. */
const CREATED_KEYS = ['created', 'createdAt', 'createdDate', 'dateCreated', 'createdOn', 'creationDate', 'creationTime', 'created_at']
function createdOf(raw) {
  let p = raw
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { return null } }
  if (!p || typeof p !== 'object') return null
  for (const k of CREATED_KEYS) { const d = toDate(p[k]); if (d) return d }
  return null
}
/** WATI's template id is a 24-character database id whose first 8 hex digits are the creation time in seconds. On your 391 templates every one decodes to a believable
 *  date (22 Feb 2025 to 2 Nov 2026) and none is later than the template's last-edited date. Returns the India-time date, or null if the id is not that shape. */
function createdFromId(id) {
  const s = String(id ?? '')
  if (!/^[0-9a-f]{24}$/i.test(s)) return null
  const ms = parseInt(s.slice(0, 8), 16) * 1000
  if (!(ms > Date.parse('2019-01-01') && ms < Date.now() + 86400000)) return null
  return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10)
}

/** the day the template was added in WATI: a created field if WATI sent one, else decoded from its id (and says which) */
const addedOf = (r) => { const f = createdOf(r.raw); if (f) return { addedInWati: f, addedHow: 'field' }; const d = createdFromId(r.wati_template_id); return d ? { addedInWati: d, addedHow: 'id' } : { addedInWati: null, addedHow: null } }

/** Prices one template send by name and date with the same rate card and category rules as the Costs page (used by Chats). */
export function makePricer(assumeParam) {
  const cfg = loadConfig()
  const assume = CATEGORIES.includes(cat(assumeParam)) ? cat(assumeParam) : cfg.fallback
  const byCat = {}
  for (const r of cfg.rates) (byCat[r.category] ??= []).push(r)
  const rateOn = (c, d) => { const list = byCat[c]; if (!list) return null; let hit = list[0]; for (const r of list) if (r.effective_from <= d) hit = r; return hit }
  const usedRates = new Set(), unpriced = new Set()
  return {
    currency: cfg.currency, assume, problems: cfg.problems,
    price(template, d) {
      const known = cfg.templates.get(template)
      const category = known ? categoryOn(known, d) : assume
      const rate = rateOn(category, d)
      if (rate) usedRates.add(rate); else unpriced.add(category)
      return { category, price: rate ? rate.price : 0, assumed: !known }
    },
    flags: () => ({ placeholder: [...usedRates].some((r) => r.source.toLowerCase() === 'placeholder'), unpriced: [...unpriced] }),
  }
}

export function makeCosts({ Q, MSG, msgWhere, asOf }) {
  async function costsSummary(q) {
    const cfg = loadConfig()
    const assume = CATEGORIES.includes(cat(q.assume)) ? cat(q.assume) : cfg.fallback
    const byCat = {}
    for (const r of cfg.rates) (byCat[r.category] ??= []).push(r)
    const rateOn = (c, d) => { const list = byCat[c]; if (!list) return null; let hit = list[0]; for (const r of list) if (r.effective_from <= d) hit = r; return hit }

    const w = msgWhere(q)
    const rows = await Q(`select m.template_name, m.first_sent_date::text as d, coalesce(sum(m.sent),0)::int as units, coalesce(sum(m.failed),0)::int as failed, coalesce(sum(m.measured_attempts),0)::int as measured,
        coalesce(sum(least(m.delivered_adj, m.measured_attempts)),0)::int as delivered, coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied
      from ${MSG} m ${w.sql} group by 1, 2`, w.args)

    const lines = new Map(), tpl = new Map(), usedRates = new Set()
    for (const r of rows) {
      if (!r.template_name) continue
      const d = r.d ?? asOf
      const known = cfg.templates.get(r.template_name)
      const c = known ? categoryOn(known, d) : assume
      const rate = rateOn(c, d)
      const price = rate ? rate.price : 0
      if (rate) usedRates.add(rate)
      const key = `${r.template_name}|${d.slice(0, 7)}|${c}|${price}`
      const l = lines.get(key) ?? { template: r.template_name, month: d.slice(0, 7), category: c, assumed: !known, rate: price, units: 0 }
      l.units += r.units
      lines.set(key, l)
      const t = tpl.get(r.template_name) ?? { template_name: r.template_name, units: 0, failed: 0, measured: 0, delivered: 0, read: 0, replied: 0, byCategory: {}, assumed: !known, source: known ? known.source : null, fromExport: !!known?.fromExport, watiCategory: cfg.msgs.map.get(r.template_name)?.category || null, watiStatus: cfg.msgs.map.get(r.template_name)?.status || null, changed: !!(known && known.previous && known.changedAt) }
      for (const k of ['units', 'failed', 'measured', 'delivered', 'read', 'replied']) t[k] += r[k]
      t.byCategory[c] = (t.byCategory[c] ?? 0) + r.units
      tpl.set(r.template_name, t)
    }

    const templates = [...tpl.values()].map(({ byCategory, ...t }) => ({ ...t, category: Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0][0], categories: Object.keys(byCategory) }))
      .sort((a, b) => b.units - a.units)
    const outLines = [...lines.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.template < b.template ? -1 : 1))
    const by = {}
    let units = 0, cost = 0, assumedUnits = 0, assumedCost = 0
    for (const l of outLines) {
      const c = l.units * l.rate
      units += l.units; cost += c
      if (l.assumed) { assumedUnits += l.units; assumedCost += c }
      const b = (by[l.category] ??= { category: l.category, units: 0, cost: 0 })
      b.units += l.units; b.cost += c
    }
    return {
      currency: cfg.currency, asOf, assume, fallback: cfg.fallback,
      rates: cfg.rates, lines: outLines.map((l) => ({ ...l, rate: r4(l.rate) })), templates,
      totals: { units, cost: Math.round(cost * 100) / 100, assumed_units: assumedUnits, assumed_cost: Math.round(assumedCost * 100) / 100, by_category: Object.values(by).map((b) => ({ ...b, cost: Math.round(b.cost * 100) / 100 })).sort((a, b) => b.cost - a.cost) },
      placeholder: [...usedRates].some((r) => r.source.toLowerCase() === 'placeholder'),
      unpriced: [...new Set(outLines.filter((l) => !byCat[l.category]).map((l) => l.category))],
      problems: cfg.problems,
      sources: { messages: cfg.msgs.source, rates: 'config/rate_card.csv', categories: cfg.found.status ? 'data_insight/wati_template_status.csv, then config/template_categories.csv' : 'config/template_categories.csv' },
    }
  }
  /** the message each selected template sends: GET costs/message?templates=a|b
   *  First choice is WATI's own current text, kept in the database by the n8n "WATI Template Sync" workflow (view reporting.v_templates, refreshed every 6 hours).
   *  If that view is missing or does not know the template, the exported file is used instead and the entry says so (from: 'file'). Template text is company-written: no customer data. */
  async function costsMessage(q) {
    const m = loadMessages()
    const names = String(q.templates ?? '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 12)
    const live = new Map()
    if (names.length) {
      let rows = []
      try {
        rows = await Q(`select template_name, language, category, status, body, header_type, header_text, header_media, footer, buttons, params, content_version, content_versions_seen,
            to_char(wati_last_modified, 'YYYY-MM-DD') as last_modified, to_char(last_seen_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') as synced_at,
            to_char(first_seen_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as first_seen, wati_template_id, raw
          from reporting.v_templates where template_name = any($1::text[]) order by (language like 'en%') desc, language`, [names])
      } catch { /* the sync is not set up in this database: fall back to the file */ }
      for (const r of rows) {
        if (live.has(r.template_name)) continue   // one language per name: English first
        live.set(r.template_name, {
          template_name: r.template_name, from: 'wati', category: cat(r.category), status: r.status || '', language: r.language || '', lastModified: r.last_modified,
          header: r.header_type || r.header_text || r.header_media ? { kind: r.header_type || '', text: r.header_text || '', file: r.header_media || '' } : null,
          body: r.body || '', footer: r.footer || '',
          buttons: (Array.isArray(r.buttons) ? r.buttons : []).map((b) => ({ type: b.type || '', text: b.text || '', url: b.url || '', phone: b.phone || '' })),
          params: r.params ?? [], version: r.content_version, versions: r.content_versions_seen, syncedAt: r.synced_at,
          firstSeen: r.first_seen, watiId: r.wati_template_id, ...addedOf(r),
        })
      }
    }
    const messages = names.map((n) => live.get(n) ?? (m.map.has(n) ? { ...m.map.get(n), from: 'file' } : { template_name: n, missing: true }))
    // when the template was really used, from our own message data (all time, whatever the date filter says)
    const usage = new Map(), history = new Map()
    if (names.length) {
      try {
        for (const r of await Q(`select template_name, to_char(min(first_sent_date), 'YYYY-MM-DD') as first_sent, to_char(max(first_sent_date), 'YYYY-MM-DD') as last_sent, coalesce(sum(sent), 0)::int as total_sent
          from ${MSG} where template_name = any($1::text[]) group by 1`, [names])) usage.set(r.template_name, r)
      } catch { /* no message data to read */ }
      try {
        for (const r of await Q(`select template_name, content_version as version, to_char(valid_from at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as since, to_char(valid_to at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as until, is_current, body
          from reporting.v_template_versions where template_name = any($1::text[]) order by template_name, content_version desc`, [names])) {
          const l = history.get(r.template_name) ?? []; if (l.length < 20) l.push({ version: r.version, since: r.since, until: r.until, current: r.is_current, body: r.body || '' }); history.set(r.template_name, l)
        }
      } catch { /* the sync is not set up: no history */ }
    }
    for (const x of messages) { if (x.missing) continue; const u = usage.get(x.template_name); if (u) Object.assign(x, { firstSent: u.first_sent, lastSent: u.last_sent, totalSent: u.total_sent }); if (history.has(x.template_name)) x.history = history.get(x.template_name) }
    return { found: m.found || live.size > 0, live: live.size > 0, source: live.size > 0 ? 'WATI, synced into the database' : m.source, problems: m.problems, messages }
  }
  return { 'costs/summary': costsSummary, 'costs/message': costsMessage }
}
