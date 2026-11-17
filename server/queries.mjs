// Every number the dashboard shows comes from one of these queries. All read-only.
// Filters arrive as query-string values: from, to (YYYY-MM-DD), and '|'-separated lists: templates, sources, owners, statuses.
import { makeCosts } from './costs.mjs'
import { makeChats } from './chats.mjs'
import { makeAgents } from './agents.mjs'
import { PHONE_SQL, NAME_SQL, NAMES_CTE } from './validate.mjs'

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const LIST = (v) => (v == null || v === '' ? [] : String(v).split('|').map((s) => s.trim()).filter(Boolean))
const GRAINS = new Set(['day', 'week', 'month'])
const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null)
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
const MASK = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d ? '•••••• ' + d.slice(-4) : String(v ?? '') }
const NAME = (n) => (n == null ? n : String(n).replace(/\+?\d[\d ()-]{6,}\d/g, (m) => MASK(m)))   // a phone number sitting in a name field
const TS = (c) => `to_char(${c}, 'YYYY-MM-DD"T"HH24:MI:SS')`
const STALE_DAYS = 30

function where(query, { date, lists = {}, extra = [] }) {
  const args = []
  const parts = [...extra]
  const ph = (v) => { args.push(v); return '$' + args.length }
  if (date && isDate(query.from)) parts.push(`${date} >= ${ph(query.from)}::date`)
  if (date && isDate(query.to)) parts.push(`${date} <= ${ph(query.to)}::date`)
  for (const [expr, key] of Object.entries(lists)) {
    const v = LIST(query[key])
    if (v.length) parts.push(`${expr} = any(${ph(v)}::text[])`)
  }
  return { sql: parts.length ? 'where ' + parts.join(' and ') : '', args, ph }
}
/** Keeps the biggest `n` rows and folds the rest into one "All others (k)" row, so a table always adds up to the total shown next to it
 *  (a plain `limit` used to drop the tail silently: 6 opportunities of 1,575 went missing from the owner table). Rows must already be sorted. */
function capRows(rows, n, label, sums, other = 'All others') {
  if (rows.length <= n) return rows
  const tail = rows.slice(n)
  const o = { [label]: `${other} (${tail.length})`, isOther: true }
  for (const k of sums) o[k] = tail.reduce((s, r) => s + (r[k] || 0), 0)
  return [...rows.slice(0, n), o]
}
const noDates = (q) => ({ ...q, from: undefined, to: undefined })
function prevWindow(q) {
  if (!isDate(q.from) || !isDate(q.to)) return null
  const len = daysBetween(q.from, q.to) + 1
  const to = addDays(q.from, -1)
  return { from: addDays(to, -(len - 1)), to }
}

export function makeApi(ctx) {
  const Q = ctx.query
  const MSG = ctx.MSG
  const reveal = (q) => process.env.ALLOW_REVEAL !== 'false' && (q.reveal === '1' || q.reveal === 'true')
  const SRC = "coalesce(m.lead_source,'(no matching lead)')"
  const OWN = "coalesce(m.lead_manager_name,'(no matching lead)')"
  const msgWhere = (q, extra) => where(q, { date: 'm.first_sent_date', extra, lists: { [SRC]: 'sources', [OWN]: 'owners', 'm.template_name': 'templates' } })
  const leadWhere = (q, extra) => where(q, { date: 'l.created_date', extra, lists: { 'l.lead_source': 'sources', 'l.lead_owner': 'owners', 'l.lead_status': 'statuses' } })
  const oppWhere = (q, extra) => where(q, { date: 'o.created_date', extra, lists: { 'o.opportunity_status': 'statuses', 'o.opp_owner': 'owners' } })
  const grain = (q) => (GRAINS.has(q.grain) ? q.grain : 'month')

  // ---------- messages ----------
  async function msgTotals(q) {
    const w = msgWhere(q)
    const [r] = await Q(`select count(*)::int as pairs, coalesce(sum(m.measured_attempts),0)::int as measured, coalesce(sum(m.attempts_est),0)::int as attempts,
        coalesce(sum(m.unmeasured_sends),0)::int as unmeasured, coalesce(sum(m.sent),0)::int as sent, coalesce(sum(m.failed),0)::int as failed,
        coalesce(sum(m.delivered_raw),0)::int as delivered_raw, coalesce(sum(least(m.delivered_adj, m.measured_attempts)),0)::int as delivered_adj,
        coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read_adj, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied
      from ${MSG} m ${w.sql}`, w.args)
    return {
      ...r,
      delivered_pct: pct(r.delivered_adj, r.measured), read_pct: pct(r.read_adj, r.measured), replied_pct: pct(r.replied, r.measured),
      failed_pct: pct(r.failed, r.measured), unmeasured_pct: pct(r.unmeasured, r.attempts), delivered_pct_old_method: pct(r.delivered_raw, r.sent),
    }
  }
  const messagesKpis = async (q) => {
    const pw = prevWindow(q)
    return { current: await msgTotals(q), previous: pw ? await msgTotals({ ...q, ...pw }) : null, previousWindow: pw }
  }
  async function messagesTrend(q) {
    const g = grain(q); const w = msgWhere(q)
    const rows = await Q(`select to_char(date_trunc('${g}', m.first_sent_date), 'YYYY-MM-DD') as period, coalesce(sum(m.measured_attempts),0)::int as measured,
        coalesce(sum(least(m.delivered_adj, m.measured_attempts)),0)::int as delivered, coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied, coalesce(sum(m.failed),0)::int as failed
      from ${MSG} m ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows: rows.map((r) => ({ ...r, delivered_pct: pct(r.delivered, r.measured), read_pct: pct(r.read, r.measured), replied_pct: pct(r.replied, r.measured), failed_pct: pct(r.failed, r.measured) })) }
  }
  async function messagesTemplates(q) {
    const w = msgWhere(q)
    const rows = await Q(`select m.template_name, coalesce(sum(m.measured_attempts),0)::int as measured, coalesce(sum(m.attempts_est),0)::int as attempts, coalesce(sum(m.unmeasured_sends),0)::int as unmeasured,
        coalesce(sum(least(m.delivered_adj, m.measured_attempts)),0)::int as delivered, coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied, coalesce(sum(m.failed),0)::int as failed
      from ${MSG} m ${w.sql} group by 1 order by 3 desc`, w.args)
    // safety net: the sums above are already limited to one per person and template, so a rate cannot pass 100%
    const c100 = (n) => (n == null ? n : Math.min(100, n))
    return { rows: rows.map((r) => ({ ...r, capped: r.read > r.measured || r.replied > r.measured || r.delivered > r.measured, delivered_pct: c100(pct(r.delivered, r.measured)), read_pct: c100(pct(r.read, r.measured)), replied_pct: c100(pct(r.replied, r.measured)), failed_pct: pct(r.failed, r.measured), unmeasured_pct: pct(r.unmeasured, r.attempts) })) }
  }
  async function messagesFailures(q) {
    const w = msgWhere(q)
    const rows = await Q(`with base as (select m.template_name, m.first_sent_date, m.failed, m.measured_attempts from ${MSG} m ${w.sql}),
        top as (select template_name from base group by 1 order by sum(failed) desc limit 6)
      select b.template_name, to_char(date_trunc('month', b.first_sent_date), 'YYYY-MM') as month, sum(b.failed)::int as failed, sum(b.measured_attempts)::int as measured
      from base b where b.template_name in (select template_name from top) group by 1, 2 order by 2`, w.args)
    return { rows: rows.map((r) => ({ ...r, failed_pct: pct(r.failed, r.measured) })) }
  }
  async function messagesBreakdown(q) {
    const w = msgWhere(q)
    const expr = q.by === 'owner' ? OWN : SRC
    const rows = await Q(`select ${expr} as label, coalesce(sum(m.measured_attempts),0)::int as measured, coalesce(sum(least(m.delivered_adj, m.measured_attempts)),0)::int as delivered, coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read,
        coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied, coalesce(sum(m.failed),0)::int as failed
      from ${MSG} m ${w.sql} group by 1 order by 2 desc`, w.args)
    const shown = capRows(rows, 40, 'label', ['measured', 'delivered', 'read', 'replied', 'failed'])
    const c100 = (n) => (n == null ? n : Math.min(100, n))   // same 100% cap as the templates table
    return { by: q.by === 'owner' ? 'owner' : 'source', rows: shown.map((r) => ({ ...r, delivered_pct: c100(pct(r.delivered, r.measured)), read_pct: c100(pct(r.read, r.measured)), replied_pct: c100(pct(r.replied, r.measured)), failed_pct: pct(r.failed, r.measured) })) }
  }

  // Time from the first send to the last status update on that message. There is no reply timestamp, so for a replied
  // message this is the closest measure of "how long the customer took to reply". Single sends only, so a later resend cannot stretch it.
  const BUCKET = (c) => `case when ${c} < 5 then 1 when ${c} < 60 then 2 when ${c} < 360 then 3 when ${c} < 1440 then 4 when ${c} < 4320 then 5 else 6 end`
  async function messagesReplyTime(q) {
    const w = msgWhere(q, ['m.sent <= 1', 'm.read_adj > 0'])
    const mins = `(extract(epoch from (m.last_event_at_ist - m.first_sent_at_ist)) / 60.0)`
    const kind = `case when m.replied > 0 then 'reply' else 'read' end`
    const rows = await Q(`select ${kind} as kind, ${BUCKET(mins)} as ord, count(*)::int as n from ${MSG} m ${w.sql} group by 1, 2 order by 1, 2`, w.args)
    const med = await Q(`select ${kind} as kind, round((percentile_cont(0.5) within group (order by ${mins}))::numeric, 1)::float as median_min from ${MSG} m ${w.sql} group by 1`, w.args)
    const out = {}
    for (const k of ['reply', 'read']) {
      const mine = rows.filter((r) => r.kind === k); const total = mine.reduce((s, r) => s + r.n, 0)
      const buckets = [1, 2, 3, 4, 5, 6].map((ord) => { const n = mine.find((r) => r.ord === ord)?.n ?? 0; return { ord, n, share: pct(n, total) } })
      out[k] = { total, buckets, median_min: med.find((r) => r.kind === k)?.median_min ?? null, within_day_pct: pct(buckets.slice(0, 4).reduce((s, b) => s + b.n, 0), total) }
    }
    return out
  }
  // When messages go out (India time) and how they perform. Dated by the first send, like everything on the message pages.
  async function messagesByTime(q) {
    const w = msgWhere(q)
    const run = async (expr, size) => {
      const rows = await Q(`select ${expr}::int as k, coalesce(sum(m.measured_attempts),0)::int as measured, coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied
        from ${MSG} m ${w.sql} group by 1 order by 1`, w.args)
      return Array.from({ length: size }, (_, k) => { const r = rows.find((x) => x.k === k) ?? { measured: 0, read: 0, replied: 0 }; return { k, measured: r.measured, read_pct: pct(r.read, r.measured), replied_pct: pct(r.replied, r.measured) } })
    }
    return { hours: await run('extract(hour from m.first_sent_at_ist)', 24), weekdays: await run('extract(dow from m.first_sent_at_ist)', 7) }   // weekday 0 = Sunday
  }

  // Weekday x hour grid (India time, by first send). Only cells that have messages are returned; weekday 0 = Sunday.
  async function messagesHeatmap(q) {
    const w = msgWhere(q)
    const rows = await Q(`select extract(dow from m.first_sent_at_ist)::int as dow, extract(hour from m.first_sent_at_ist)::int as hour, coalesce(sum(m.measured_attempts),0)::int as measured,
        coalesce(sum(least(m.read_adj, m.measured_attempts)),0)::int as read, coalesce(sum(least(m.replied, m.measured_attempts)),0)::int as replied
      from ${MSG} m ${w.sql} group by 1, 2 order by 1, 2`, w.args)
    return { cells: rows.map((r) => ({ ...r, read_pct: pct(r.read, r.measured), replied_pct: pct(r.replied, r.measured) })) }
  }

  // ---------- leads ----------
  async function leadTotals(q) {
    const w = leadWhere(q)
    const [r] = await Q(`select count(*)::int as leads, count(distinct nullif(l.phone10,''))::int as people, coalesce(sum(l.welcome),0)::int as welcome, coalesce(sum(l.followup_24h),0)::int as followup_24h,
        coalesce(sum(l.task1),0)::int as task1, coalesce(sum(l.task2),0)::int as task2, coalesce(sum(l.task3),0)::int as task3,
        count(*) filter (where l.source_overwritten)::int as source_overwritten, count(*) filter (where l.phone_overwritten)::int as phone_overwritten, count(*) filter (where l.phone_empty)::int as phone_empty
      from reporting.v_leads l ${w.sql}`, w.args)
    return { ...r, welcome_pct: pct(r.welcome, r.leads), followup_24h_pct: pct(r.followup_24h, r.leads), task1_pct: pct(r.task1, r.leads), task2_pct: pct(r.task2, r.leads), task3_pct: pct(r.task3, r.leads),
      source_known_pct: pct(r.leads - r.source_overwritten, r.leads), phone_intact_pct: pct(r.leads - r.phone_overwritten - r.phone_empty, r.leads) }
  }
  const leadsKpis = async (q) => { const pw = prevWindow(q); return { current: await leadTotals(q), previous: pw ? await leadTotals({ ...q, ...pw }) : null } }
  async function leadsTrend(q) {
    const g = grain(q); const w = leadWhere(q)
    const rows = await Q(`select to_char(date_trunc('${g}', l.created_date), 'YYYY-MM-DD') as period, count(*)::int as leads, coalesce(sum(l.welcome),0)::int as welcome
      from reporting.v_leads l ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }
  async function leadsGroup(q, col) {
    const w = leadWhere(q)
    const all = await Q(`select l.${col} as label, count(*)::int as leads from reporting.v_leads l ${w.sql} group by 1 order by 2 desc`, w.args)
    const total = all.reduce((s, r) => s + r.leads, 0)   // of everything, so the shares stay right when the tail is folded into "All others"
    return { rows: capRows(all, 30, 'label', ['leads']).map((r) => ({ ...r, share: pct(r.leads, total) })) }
  }
  async function leadsOwners(q) {
    const w = leadWhere(q)
    const rows = await Q(`select l.lead_owner as owner, count(*)::int as leads, coalesce(sum(l.welcome),0)::int as welcome, coalesce(sum(l.followup_24h),0)::int as followup_24h,
        coalesce(sum(l.to_nurturing),0)::int as to_nurturing, coalesce(sum(l.to_not_connected),0)::int as to_not_connected, coalesce(sum(l.to_unqualified),0)::int as to_unqualified,
        count(*) filter (where l.lead_status = 'Qualified')::int as qualified
      from reporting.v_leads l ${w.sql} group by 1 order by 2 desc`, w.args)
    const shown = capRows(rows, 40, 'owner', ['leads', 'welcome', 'followup_24h', 'to_nurturing', 'to_not_connected', 'to_unqualified', 'qualified'])
    return { rows: shown.map((r) => ({ ...r, welcome_pct: pct(r.welcome, r.leads), followup_24h_pct: pct(r.followup_24h, r.leads) })) }
  }
  async function leadsCoverage(q) {
    const w = leadWhere(noDates(q))
    const rows = await Q(`select to_char(date_trunc('month', l.created_date), 'YYYY-MM') as month, count(*)::int as leads, coalesce(sum(l.welcome),0)::int as welcome, coalesce(sum(l.followup_24h),0)::int as followup_24h
      from reporting.v_leads l ${w.sql} group by 1 order by 1`, w.args)
    return { rows: rows.map((r) => ({ ...r, welcome_pct: pct(r.welcome, r.leads), followup_24h_pct: pct(r.followup_24h, r.leads) })) }
  }
  const SORT_LEADS = { created: 'l.created_at', name: 'l.customer_name', owner: 'l.lead_owner', status: 'l.lead_status', source: 'l.lead_source' }
  async function leadsList(q) {
    const w = leadWhere(q)
    let sql = w.sql
    const text = String(q.q || '').trim()
    if (text) {
      const digits = text.replace(/\D/g, '')
      const conds = [`l.customer_name ilike '%' || ${w.ph(text)} || '%'`, `l.lead_id ilike ${w.ph(text)} || '%'`]
      if (digits.length >= 4) conds.push(`position(${w.ph(digits)} in regexp_replace(coalesce(l.customer_number,''), '\\D', '', 'g')) > 0`)
      sql += (sql ? ' and ' : 'where ') + '(' + conds.join(' or ') + ')'
    }
    const size = Math.min(100, Math.max(5, Number(q.pageSize) || 25)); const page = Math.max(1, Number(q.page) || 1)
    const order = `${SORT_LEADS[q.sort] || SORT_LEADS.created} ${q.dir === 'asc' ? 'asc' : 'desc'} nulls last`
    const [{ n }] = await Q(`select count(*)::int as n from reporting.v_leads l ${sql}`, w.args)
    const rows = await Q(`select l.lead_id, l.customer_name, l.customer_number, l.phone10, l.lead_source, l.lead_status, l.lead_owner, l.created_date::text as created_date,
        l.welcome, l.followup_24h, l.task1, l.task2, l.task3, l.phone_overwritten, l.source_overwritten
      from reporting.v_leads l ${sql} order by ${order} limit ${size} offset ${(page - 1) * size}`, w.args)
    return { total: n, page, pageSize: size, rows: rows.map((r) => ({ ...r, customer_name: NAME(r.customer_name), key: r.phone10 ? 'p:' + r.phone10 : 'l:' + r.lead_id, phone: MASK(r.customer_number), customer_number: undefined })) }
  }

  // ---------- opportunities ----------
  const AGE = (n) => `(${n}::date - o.created_date)`
  async function oppTotals(q) {
    const w = oppWhere(q); const asOf = w.ph(ctx.asOf)
    const [r] = await Q(`select count(*)::int as opportunities, count(*) filter (where o.opportunity_status ilike 'closed won')::int as won, count(*) filter (where o.opportunity_status ilike 'closed lost')::int as lost,
        count(*) filter (where o.opportunity_status = 'New')::int as new_total, count(*) filter (where o.opportunity_status = 'New' and ${AGE(asOf)} > ${STALE_DAYS})::int as stale_new,
        count(*) filter (where (o.opportunity_status ilike 'closed won' and o.won_flag <> 1) or (o.opportunity_status ilike 'closed lost' and o.loss_flag <> 1)
          or (o.opportunity_status not ilike 'closed won' and o.won_flag = 1) or (o.opportunity_status not ilike 'closed lost' and o.loss_flag = 1))::int as flag_mismatch
      from reporting.v_opps o ${w.sql}`, w.args)
    return { ...r, open: r.opportunities - r.won - r.lost, win_rate: pct(r.won, r.won + r.lost), staleDays: STALE_DAYS }
  }
  const oppsKpis = async (q) => { const pw = prevWindow(q); return { current: await oppTotals(q), previous: pw ? await oppTotals({ ...q, ...pw }) : null } }
  async function oppsTrend(q) {
    const g = grain(q); const w = oppWhere(q)
    const rows = await Q(`select to_char(date_trunc('${g}', o.created_date), 'YYYY-MM-DD') as period, count(*)::int as opportunities,
        count(*) filter (where o.opportunity_status ilike 'closed won')::int as won, count(*) filter (where o.opportunity_status ilike 'closed lost')::int as lost
      from reporting.v_opps o ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows: rows.map((r) => ({ ...r, open: r.opportunities - r.won - r.lost })) }
  }
  async function oppsStatuses(q) {
    const w = oppWhere(q)
    const rows = await Q(`select o.opportunity_status as label, count(*)::int as opportunities from reporting.v_opps o ${w.sql} group by 1 order by 2 desc`, w.args)
    const total = rows.reduce((s, r) => s + r.opportunities, 0)
    return { rows: rows.map((r) => ({ ...r, share: pct(r.opportunities, total) })) }
  }
  async function oppsOwners(q) {
    const w = oppWhere(q); const asOf = w.ph(ctx.asOf)
    const rows = await Q(`select o.opp_owner as owner, count(*)::int as opportunities, count(*) filter (where o.opportunity_status ilike 'closed won')::int as won, count(*) filter (where o.opportunity_status ilike 'closed lost')::int as lost,
        count(*) filter (where o.opportunity_status = 'New')::int as new_total, count(*) filter (where o.opportunity_status = 'New' and ${AGE(asOf)} > ${STALE_DAYS})::int as stale_new
      from reporting.v_opps o ${w.sql} group by 1 order by 2 desc`, w.args)
    const shown = capRows(rows, 40, 'owner', ['opportunities', 'won', 'lost', 'new_total', 'stale_new'])
    return { rows: shown.map((r) => ({ ...r, win_rate: pct(r.won, r.won + r.lost) })) }
  }
  async function oppsAging(q) {
    const w = oppWhere(noDates(q), [`o.opportunity_status = 'New'`]); const asOf = w.ph(ctx.asOf)
    const rows = await Q(`select case when ${AGE(asOf)} <= 7 then '1. up to 7 days' when ${AGE(asOf)} <= 30 then '2. 8 to 30 days' when ${AGE(asOf)} <= 90 then '3. 31 to 90 days' else '4. over 90 days' end as bucket, count(*)::int as opportunities
      from reporting.v_opps o ${w.sql} group by 1 order by 1`, w.args)
    return { rows: rows.map((r) => ({ bucket: r.bucket.slice(3), opportunities: r.opportunities })) }
  }
  const SORT_OPPS = { created: 'o.created_at', name: 'o.customer_name', owner: 'o.opp_owner', status: 'o.opportunity_status' }
  async function oppsList(q) {
    const w = oppWhere(q); let sql = w.sql
    const text = String(q.q || '').trim()
    if (text) {
      const digits = text.replace(/\D/g, '')
      const conds = [`o.customer_name ilike '%' || ${w.ph(text)} || '%'`, `o.opportunity_id ilike ${w.ph(text)} || '%'`]
      if (digits.length >= 4) conds.push(`position(${w.ph(digits)} in regexp_replace(coalesce(o.customer_number,''), '\\D', '', 'g')) > 0`)
      sql += (sql ? ' and ' : 'where ') + '(' + conds.join(' or ') + ')'
    }
    const size = Math.min(100, Math.max(5, Number(q.pageSize) || 25)); const page = Math.max(1, Number(q.page) || 1)
    const order = `${SORT_OPPS[q.sort] || SORT_OPPS.created} ${q.dir === 'asc' ? 'asc' : 'desc'} nulls last`
    const [{ n }] = await Q(`select count(*)::int as n from reporting.v_opps o ${sql}`, w.args)
    const rows = await Q(`select o.opportunity_id, o.customer_name, o.customer_number, o.phone10, o.opportunity_status, o.opp_owner, o.created_date::text as created_date, ${TS('o.updated_at')} as updated_at
      from reporting.v_opps o ${sql} order by ${order} limit ${size} offset ${(page - 1) * size}`, w.args)
    return { total: n, page, pageSize: size, rows: rows.map((r) => ({ ...r, customer_name: NAME(r.customer_name), key: r.phone10 ? 'p:' + r.phone10 : 'o:' + r.opportunity_id, phone: MASK(r.customer_number), customer_number: undefined })) }
  }

  // ---------- customers ----------
  async function customersSearch(q) {
    const text = String(q.q || '').trim()
    if (text.length < 2) return { results: [] }
    const digits = text.replace(/\D/g, '')
    const numeric = digits.length >= 4 && digits.length >= text.replace(/\s/g, '').length * 0.6
    let leads = [], opps = [], phones = []
    if (numeric) {
      leads = await Q(`select lead_id, customer_name, phone10, lead_owner, created_date::text as d from reporting.v_leads where position($1 in regexp_replace(coalesce(customer_number,''), '\\D', '', 'g')) > 0 order by created_at desc limit 60`, [digits])
      opps = await Q(`select opportunity_id, customer_name, phone10, opp_owner, created_date::text as d from reporting.v_opps where position($1 in regexp_replace(coalesce(customer_number,''), '\\D', '', 'g')) > 0 order by created_at desc limit 60`, [digits])
      phones = await Q(`select distinct phone10 from ${MSG} where position($1 in regexp_replace(phone_no, '\\D', '', 'g')) > 0 limit 40`, [digits])
    } else {
      leads = await Q(`select lead_id, customer_name, phone10, lead_owner, created_date::text as d from reporting.v_leads where customer_name ilike '%' || $1 || '%' or lead_id ilike $1 || '%' order by created_at desc limit 60`, [text])
      opps = await Q(`select opportunity_id, customer_name, phone10, opp_owner, created_date::text as d from reporting.v_opps where customer_name ilike '%' || $1 || '%' or opportunity_id ilike $1 || '%' order by created_at desc limit 60`, [text])
    }
    const map = new Map()
    const touch = (key, init) => { if (!map.has(key)) map.set(key, { key, name: '', phone10: '', owner: '', last: '', ...init }); return map.get(key) }
    for (const r of leads) { const e = touch(r.phone10 ? 'p:' + r.phone10 : 'l:' + r.lead_id, { phone10: r.phone10 }); e.name ||= NAME(r.customer_name) || ''; e.owner ||= r.lead_owner; if (r.d > e.last) e.last = r.d }
    for (const r of opps) { const e = touch(r.phone10 ? 'p:' + r.phone10 : 'o:' + r.opportunity_id, { phone10: r.phone10 }); e.name ||= NAME(r.customer_name) || ''; e.owner ||= r.opp_owner; if (r.d > e.last) e.last = r.d }
    for (const r of phones) if (r.phone10) touch('p:' + r.phone10, { phone10: r.phone10 })
    const picked = [...map.values()].sort((a, b) => (b.last || '').localeCompare(a.last || '')).slice(0, 25)
    const p10 = picked.map((e) => e.phone10).filter(Boolean)
    const counts = { leads: {}, opps: {}, msgs: {} }
    if (p10.length) {
      for (const r of await Q(`select phone10, count(*)::int as n from reporting.v_leads where phone10 = any($1::text[]) group by 1`, [p10])) counts.leads[r.phone10] = r.n
      for (const r of await Q(`select phone10, count(*)::int as n from reporting.v_opps where phone10 = any($1::text[]) group by 1`, [p10])) counts.opps[r.phone10] = r.n
      for (const r of await Q(`select phone10, count(*)::int as templates, sum(attempts_est)::int as attempts from ${MSG} where phone10 = any($1::text[]) group by 1`, [p10])) counts.msgs[r.phone10] = r
    }
    return { results: picked.map((e) => ({
      key: e.key, name: e.name || '(no name)', owner: e.owner, last: e.last, hasPhone: !!e.phone10, phone: e.phone10 ? MASK(e.phone10) : '',
      leads: e.phone10 ? counts.leads[e.phone10] || 0 : e.key.startsWith('l:') ? 1 : 0, opps: e.phone10 ? counts.opps[e.phone10] || 0 : e.key.startsWith('o:') ? 1 : 0,
      templates: e.phone10 ? counts.msgs[e.phone10]?.templates || 0 : 0, attempts: e.phone10 ? counts.msgs[e.phone10]?.attempts || 0 : 0,
    })) }
  }

  async function customerDetail(q) {
    const key = String(q.key || '')
    const kind = key.slice(0, 1), id = key.slice(2)
    if (!['p', 'l', 'o'].includes(kind) || !id) return { error: 'Unknown customer key' }
    const show = reveal(q)
    const phoneOut = (v) => (show ? String(v ?? '') : MASK(v))
    const nameOut = (v) => (show ? v : NAME(v))
    let phone10 = kind === 'p' ? id : ''
    let leads = [], opps = []
    if (kind === 'l') { leads = await Q(`select *, ${TS('created_at')} as created_ts, ${TS('updated_at')} as updated_ts from reporting.v_leads where lead_id = $1`, [id]); phone10 = leads[0]?.phone10 || '' }
    if (kind === 'o') { opps = await Q(`select *, ${TS('created_at')} as created_ts, ${TS('updated_at')} as updated_ts from reporting.v_opps where opportunity_id = $1`, [id]); phone10 = opps[0]?.phone10 || '' }
    if (phone10) {
      leads = await Q(`select *, ${TS('created_at')} as created_ts, ${TS('updated_at')} as updated_ts from reporting.v_leads where phone10 = $1 order by created_at desc`, [phone10])
      opps = await Q(`select *, ${TS('created_at')} as created_ts, ${TS('updated_at')} as updated_ts from reporting.v_opps where phone10 = $1 order by created_at desc`, [phone10])
    }
    const msgs = phone10 ? await Q(`select m.template_name, m.attempts_est, m.measured_attempts, m.unmeasured_sends, m.delivered_adj, m.read_adj, m.replied, m.failed, ${TS('m.first_sent_at_ist')} as first_sent, ${TS('m.last_event_at_ist')} as last_event from ${MSG} m where m.phone10 = $1 order by m.first_sent_at_ist desc`, [phone10]) : []
    const sessions = phone10 ? await Q(`select ${TS('last_user_message_time at time zone \'Asia/Kolkata\'')} as last_customer_message, ${TS('session_expiry_time at time zone \'Asia/Kolkata\'')} as window_closes from public.wati_sessions where reporting.phone10(phone_number) = $1 order by last_user_message_time desc`, [phone10]) : []
    const chat = phone10 ? await Q(`select ${TS('message_created_at at time zone \'Asia/Kolkata\'')} as at, message_type, is_owner, operator_email, message_text from public.wati_message_log where reporting.phone10(wa_id) = $1 order by message_created_at desc limit 40`, [phone10]) : []

    const leadOut = leads.map((l) => ({ lead_id: l.lead_id, name: nameOut(l.customer_name), phone: phoneOut(l.customer_number), phoneOverwritten: l.phone_overwritten, source: l.lead_source, sourceOverwritten: l.source_overwritten, status: l.lead_status, owner: l.lead_owner,
      created: l.created_ts, updated: l.updated_ts, page: l.page_url || '',
      steps: [['Welcome message', l.welcome], ['24-hour follow-up', l.followup_24h], ['1st task follow-up', l.task1], ['2nd task follow-up', l.task2], ['3rd task follow-up', l.task3]].map(([label, v]) => ({ label, done: v === 1 })),
      moves: [['Nurturing', l.to_nurturing], ['Not connected', l.to_not_connected], ['Unqualified', l.to_unqualified]].filter(([, v]) => v === 1).map(([label]) => label) }))
    const oppOut = opps.map((o) => ({ opportunity_id: o.opportunity_id, name: nameOut(o.customer_name), status: o.opportunity_status, owner: o.opp_owner, created: o.created_ts, updated: o.updated_ts,
      steps: [['Customer details sent to salesperson', o.details_to_salesperson], ['Salesperson details sent to customer', o.details_to_customer], ['48-hour customer follow-up', o.followup_48h], ['24-hour customer follow-up', o.followup_24h]].map(([label, v]) => ({ label, done: v === 1 })) }))
    const totals = msgs.reduce((t, r) => ({ templates: t.templates + 1, attempts: t.attempts + r.attempts_est, measured: t.measured + r.measured_attempts, delivered: t.delivered + Math.min(r.delivered_adj, r.measured_attempts), read: t.read + Math.min(r.read_adj, r.measured_attempts), replied: t.replied + Math.min(r.replied, r.measured_attempts), failed: t.failed + r.failed, unmeasured: t.unmeasured + r.unmeasured_sends }), { templates: 0, attempts: 0, measured: 0, delivered: 0, read: 0, replied: 0, failed: 0, unmeasured: 0 })

    const notes = []
    if (!phone10) notes.push({ tone: 'warn', text: kind === 'l' ? "This lead's phone number was replaced by text in the database, so its WhatsApp messages cannot be linked yet. A Salesforce backfill restores it." : 'No usable phone number on this record, so its WhatsApp messages cannot be linked.' })
    if (leads.length > 1) notes.push({ tone: 'info', text: `This phone number is on ${leads.length} leads.` })
    if (leads.some((l) => l.source_overwritten)) notes.push({ tone: 'warn', text: 'The real lead source was overwritten by a status. It shows as unknown and needs restoring from Salesforce.' })
    if (totals.unmeasured > 0) notes.push({ tone: 'info', text: `${totals.unmeasured} repeat send${totals.unmeasured > 1 ? 's' : ''} to this number cannot be followed: only the first message of a template is tracked.` })
    if (phone10 && !msgs.length) notes.push({ tone: 'info', text: 'No WhatsApp template messages are recorded for this number.' })

    const events = []
    for (const l of leadOut) { if (l.created) events.push({ at: l.created, kind: 'lead', text: `Lead created, source ${l.sourceOverwritten ? 'unknown' : l.source}, owner ${l.owner}` }); if (l.updated && l.updated !== l.created) events.push({ at: l.updated, kind: 'lead', text: `Lead last updated, status ${l.status}` }) }
    for (const o of oppOut) { if (o.created) events.push({ at: o.created, kind: 'opportunity', text: `Opportunity created (owner ${o.owner})` }); if (o.updated && o.updated !== o.created) events.push({ at: o.updated, kind: 'opportunity', text: `Opportunity last updated, status ${o.status}` }) }
    for (const m of msgs) { if (m.first_sent) events.push({ at: m.first_sent, kind: 'message', text: `${m.template_name} first sent${m.failed ? ' (failed)' : ''}` }); if (m.last_event && m.last_event !== m.first_sent) events.push({ at: m.last_event, kind: 'message', text: `${m.template_name} last status update${m.replied ? ': customer replied' : m.read_adj ? ': read' : m.delivered_adj ? ': delivered' : ''}` }) }
    for (const s of sessions) events.push({ at: s.last_customer_message, kind: 'chat', text: 'Customer wrote in WhatsApp' })
    events.sort((a, b) => b.at.localeCompare(a.at))

    const name = leadOut[0]?.name || oppOut[0]?.name || ''
    return {
      key, name: name || '(no name)', phone: phone10 ? phoneOut(phone10) : '', hasPhone: !!phone10, revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false',
      leads: leadOut, opportunities: oppOut, messages: msgs.map((m) => ({ template: m.template_name, attempts: m.attempts_est, measured: m.measured_attempts, unmeasured: m.unmeasured_sends, delivered: m.delivered_adj, read: m.read_adj, replied: m.replied, failed: m.failed, first_sent: m.first_sent, last_event: m.last_event })),
      totals, sessions, chat: chat.map((c) => ({ at: c.at, type: c.message_type, fromTeam: c.is_owner === true, operator: c.operator_email || '', text: show ? c.message_text || '' : null, hasText: !!c.message_text })),
      notes, timeline: events.slice(0, 60),
    }
  }

  // ---------- health ----------
  async function healthFeed(q) {
    const args = []; const parts = []
    if (isDate(q.from)) { args.push(q.from); parts.push(`day >= $${args.length}::date`) }
    if (isDate(q.to)) { args.push(q.to); parts.push(`day <= $${args.length}::date`) }
    const rows = await Q(`select day::text as day, leads_created, welcome_flags, opps_created, pairs_first_sent, pivot_rows_touched, sessions, feed_gap_suspected from reporting.v_feed_health ${parts.length ? 'where ' + parts.join(' and ') : ''} order by day`, args)
    return { rows }
  }
  async function healthGaps() {
    const rows = await Q(`with z as (select day, (pivot_rows_touched = 0) as zero from reporting.v_feed_health),
        g as (select day, zero, day - (row_number() over (partition by zero order by day))::int as grp from z)
      select min(day)::text as from_day, max(day)::text as to_day, count(*)::int as days from g where zero group by grp having count(*) >= 3 order by 1`)
    return { rows }
  }
  async function healthFacts() {
    const [h] = await Q(`select * from reporting.v_data_health`)
    const [t] = await Q(`select (select count(*) from reporting.v_leads)::int as leads, (select coalesce(sum(attempts_est),0) from ${MSG})::int as attempts`)
    const rows = [
      { id: 'source', label: 'Leads whose source was overwritten with a status', count: h.leads_source_overwritten_by_status, of: t.leads, severity: 'high', fix: 'Fix workflow #7 (Task Created Automation), then restore Lead_Source__c from Salesforce.' },
      { id: 'phone', label: 'Leads whose phone number was overwritten by text', count: h.leads_phone_overwritten_by_text, of: t.leads, severity: 'high', fix: 'Fix workflow #7, then restore Mobile__c from Salesforce. Until then these leads cannot be linked to their messages.' },
      { id: 'delivered', label: 'Message rows where Read is higher than Delivered', count: h.rows_read_more_than_delivered, of: h.pivot_rows, severity: 'medium', fix: 'Use the adjusted delivered figure. Find out why DELIVERED events are missing (WATI webhook or workflow #15).' },
      { id: 'repeat', label: 'Sends whose status events are dropped (repeat sends)', count: h.sends_with_dropped_status_events, of: t.attempts, severity: 'medium', fix: 'Log one row per message (see the spec) so repeat sends can be followed.' },
      { id: 'names', label: 'Leads whose name looks like a phone number', count: h.leads_name_looks_like_phone, of: t.leads, severity: 'low', fix: 'Same cause as the phone overwrite; restore from Salesforce.' },
      { id: 'welcome', label: 'Leads without a welcome message flag', count: h.leads_without_welcome_flag, of: t.leads, severity: 'medium', fix: 'Ask the Salesforce admin why the welcome Flow does not fire for some leads (many have no source).' },
      { id: 'agent', label: 'Agent messages in the chat log', count: h.owner_messages_logged, of: h.inbound_log_rows, severity: 'info', fix: 'None are logged, so reply time cannot be measured. Enable the WATI webhook event for agent messages.' },
    ]
    return { rows, raw: h }
  }

  // ---------- inbox: who owns each WhatsApp chat ----------
  // A chat is one WATI ticket. It counts as assigned when its latest customer message carries an owner (assignedId in the webhook payload).
  // The log holds customer messages only, so an assignment made after the customer's last message is invisible: unassigned can be overstated.
  // Dated by the chat's first message (India time). Staff names are not customer data; customer phones are masked.
  const CHATS = `with m as (
      select coalesce(raw_payload->>'ticketId', conversation_id, wa_id) as ticket, wa_id, sender_name, message_created_at at time zone 'Asia/Kolkata' as at,
             nullif(raw_payload->>'assignedId', '') as aid, nullif(coalesce(nullif(raw_payload->>'operatorName', ''), operator_email), '') as op
      from public.wati_message_log where coalesce(event_type, 'message') = 'message' and is_owner is not true),
    names as (select aid, max(op) as op from m where aid is not null group by aid),
    c as (select ticket, min(at) as first_at, max(at) as last_at, count(*)::int as msgs, (array_agg(wa_id order by at desc))[1] as wa_id,
            (array_agg(sender_name order by at desc))[1] as customer, (array_agg(aid order by at desc))[1] as aid from m group by ticket),
    ch as (select c.*, c.first_at::date as d, (c.aid is not null) as assigned, coalesce(n.op, case when c.aid is not null then 'Name not recorded' end) as operator
           from c left join names n on n.aid = c.aid)`
  const inboxWhere = (q, extra) => where(q, { date: 'ch.d', extra })
  async function inboxTotals(q) {
    const w = inboxWhere(q)
    const [r] = await Q(`${CHATS} select count(*)::int as chats, count(*) filter (where assigned)::int as assigned, count(*) filter (where not assigned)::int as unassigned,
        count(*) filter (where not assigned and msgs > 1)::int as unassigned_repeat, coalesce(sum(msgs), 0)::int as messages,
        count(*) filter (where ch.last_at < (select max(at) from m) - interval '24 hours')::int as window_closed,
        count(*) filter (where not assigned and ch.last_at < (select max(at) from m) - interval '24 hours')::int as unassigned_closed,
        count(distinct wa_id)::int as customers, count(distinct operator)::int as operators from ch ${w.sql}`, w.args)
    return { ...r, assigned_pct: pct(r.assigned, r.chats), unassigned_pct: pct(r.unassigned, r.chats), window_closed_pct: pct(r.window_closed, r.chats), unassigned_closed_pct: pct(r.unassigned_closed, r.unassigned), msgs_per_chat: r.chats ? Math.round((10 * r.messages) / r.chats) / 10 : null }
  }
  async function inboxKpis(q) {
    const pw = prevWindow(q)
    const [cov] = await Q(`select to_char(min(message_created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as from_day, to_char(max(message_created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as to_day from public.wati_message_log`)
    return { current: await inboxTotals(q), previous: pw ? await inboxTotals({ ...q, ...pw }) : null, coverage: cov }
  }
  async function inboxTrend(q) {
    const g = grain(q); const w = inboxWhere(q)
    const rows = await Q(`${CHATS} select to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as chats, count(*) filter (where assigned)::int as assigned, count(*) filter (where not assigned)::int as unassigned
      from ch ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }
  async function inboxOperators(q) {
    const w = inboxWhere(q, ['ch.assigned'])
    const rows = await Q(`${CHATS} select ch.operator as operator, count(*)::int as chats, coalesce(sum(ch.msgs), 0)::int as messages, ${TS('max(ch.last_at)')} as last_active
      from ch ${w.sql} group by 1 order by 2 desc, 1`, w.args)
    return { rows }
  }
  // When chats start (India time, by first message) and how many of them nobody has taken. Weekday 0 = Sunday.
  async function inboxByTime(q) {
    const w = inboxWhere(q)
    const run = async (expr, size) => {
      const rows = await Q(`${CHATS} select ${expr}::int as k, count(*)::int as chats, count(*) filter (where not assigned)::int as unassigned from ch ${w.sql} group by 1`, w.args)
      return Array.from({ length: size }, (_, k) => { const r = rows.find((x) => x.k === k) ?? { chats: 0, unassigned: 0 }; return { k, chats: r.chats, assigned: r.chats - r.unassigned, unassigned: r.unassigned } })
    }
    return { hours: await run('extract(hour from ch.first_at)', 24), weekdays: await run('extract(dow from ch.first_at)', 7) }
  }
  // How long a chat ran: first to last customer message. Only chats with 2+ messages have a length. Per period: how many such chats and their total and average minutes.
  async function inboxDuration(q) {
    const g = grain(q); const w = inboxWhere(q, ['ch.msgs > 1'])
    const rows = await Q(`${CHATS} select to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as chats,
        round(sum(extract(epoch from (ch.last_at - ch.first_at)) / 60.0)::numeric, 0)::float as total_min,
        round(avg(extract(epoch from (ch.last_at - ch.first_at)) / 60.0)::numeric, 0)::float as avg_min
      from ch ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }
  // Weekday x hour grid of new chats (India time). Only cells with chats are returned; weekday 0 = Sunday.
  async function inboxHeatmap(q) {
    const w = inboxWhere(q)
    const rows = await Q(`${CHATS} select extract(dow from ch.first_at)::int as dow, extract(hour from ch.first_at)::int as hour, count(*)::int as chats, count(*) filter (where not assigned)::int as unassigned
      from ch ${w.sql} group by 1, 2 order by 1, 2`, w.args)
    return { cells: rows }
  }
  // Chats nobody has taken, oldest first. Age runs to the newest message in the log. Capped at 200.
  // Phones and names are masked unless the caller asks with reveal=1 and ALLOW_REVEAL is not false (same gate as the customer page). limit lets the CSV export fetch every waiting chat (max 5000); the table asks for 200.
  async function inboxWaiting(q) {
    const w = inboxWhere(q, ['not ch.assigned'])
    const show = reveal(q)
    const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 200))
    const rows = await Q(`${CHATS} select ch.ticket, ch.wa_id, ch.customer, ch.msgs, ${TS('ch.first_at')} as first_at, ${TS('ch.last_at')} as last_at,
        round((extract(epoch from ((select max(at) from m) - ch.first_at)) / 3600.0)::numeric, 1)::float as age_hours
      from ch ${w.sql} order by ch.first_at limit ${limit}`, w.args)
    return {
      revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', limit,
      rows: rows.map((r) => ({ key: r.ticket, customer: (show ? (r.customer == null ? '' : String(r.customer).trim()) : NAME(r.customer)) || '(no name)', phone: show ? (String(r.wa_id ?? '').replace(/\D/g, '')) : MASK(r.wa_id), msgs: r.msgs, first_at: r.first_at, last_at: r.last_at, age_hours: r.age_hours })),
    }
  }

  // ---------- why messages failed ----------
  // Needs the failure events that n8n saves in public.wati_status_events (read through reporting.v_failure_events and v_message_timeline).
  // Until that is switched on this answers capturing: false. The reason's field name in WATI's payload is not known for certain,
  // so several likely names are tried, and when none match the field names found are returned so the right one can be added here.
  const REASON_KEYS = ['failedDetail', 'failedReason', 'failureReason', 'failedMessage', 'errorMessage', 'errorDetail', 'error', 'reason', 'detail']
  const CODE_KEYS = ['failedCode', 'errorCode', 'code']
  const asText = (v) => (v == null ? '' : typeof v === 'object' ? asText(v.message ?? v.title ?? v.detail ?? v.details ?? v.error_data?.details ?? '') : String(v)).trim()
  function failureReason(raw) {
    let p = raw; if (typeof p === 'string') { try { p = JSON.parse(p) } catch { return null } }
    if (!p || typeof p !== 'object') return null
    let why = ''; for (const k of REASON_KEYS) { why = asText(p[k]); if (why) break }
    let code = ''; for (const k of CODE_KEYS) { code = asText(p[k]); if (code) break }
    const label = [code, why].filter(Boolean).join(' · ').replace(/\d{7,}/g, '…').slice(0, 140)   // a phone number inside a reason is masked
    return label || null
  }
  async function messagesFailReasons(q) {
    let t
    try { [t] = await Q(`select count(*)::int as events, to_char(min(coalesce(sent_at, failed_at) at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as since from reporting.v_message_timeline`) }
    catch { return { capturing: false } }   // the events views are not installed yet
    if (!t.events) return { capturing: false }
    const w = where(q, { date: 'f.d', lists: { 'f.template_name': 'templates' } })
    const rows = await Q(`select f.template_name, f.raw_payload from (select template_name, raw_payload, (received_at at time zone 'Asia/Kolkata')::date as d from reporting.v_failure_events) f ${w.sql} limit 50000`, w.args)
    const byReason = new Map(), byTpl = new Map(), keys = new Map()
    let withReason = 0
    for (const r of rows) {
      const label = failureReason(r.raw_payload)
      const tpl = r.template_name || '(template unknown)'
      const e = byTpl.get(tpl) ?? { template_name: tpl, failed: 0, reasons: new Map() }; e.failed++; byTpl.set(tpl, e)
      if (label) { withReason++; byReason.set(label, (byReason.get(label) ?? 0) + 1); e.reasons.set(label, (e.reasons.get(label) ?? 0) + 1) }
      else { let p = r.raw_payload; if (typeof p === 'string') { try { p = JSON.parse(p) } catch { p = null } } for (const k of Object.keys(p ?? {})) keys.set(k, (keys.get(k) ?? 0) + 1) }
    }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    const [all] = await Q(`select count(*)::int as n from reporting.v_failure_events`)
    return {
      capturing: true, since: t.since, failed_events: rows.length, all_failed: all.n, with_reason: withReason,
      reasons: top(byReason, 60).map(([reason, n]) => ({ reason, n, share: pct(n, withReason) })),
      by_template: [...byTpl.values()].sort((a, b) => b.failed - a.failed).slice(0, 30).map((e) => ({ template_name: e.template_name, failed: e.failed, top_reason: top(e.reasons, 1)[0]?.[0] ?? null, reasons: top(e.reasons, 8).map(([reason, n]) => ({ reason, n })) })),
      payload_keys: withReason === 0 && rows.length ? top(keys, 20).map(([key, n]) => ({ key, n })) : [],
    }
  }

  // ---------- every message we sent, and why it failed ----------
  // One row per message, from reporting.v_message_log (built from the events n8n saves). Only messages saved since the save step started are in it.
  // Phones are masked and the message text is left out unless the caller asks with reveal=1 and ALLOW_REVEAL is not false (same gate as the customer page).
  // limit lets the CSV export fetch up to 5000 rows; the table asks for 25 per page.
  // Whether the failure-events view exists. Asked at most every 5 minutes (it used to be a database round trip on every request).
  let rejectedProbe = { ok: null, at: 0 }
  async function hasRejected() {
    if (rejectedProbe.ok !== null && Date.now() - rejectedProbe.at < 300_000) return rejectedProbe.ok
    let ok = true
    try { await Q(`select 1 from reporting.v_failure_events limit 1`) } catch { ok = false }
    rejectedProbe = { ok, at: Date.now() }
    return ok
  }
  async function messagesLog(q) {
    const show = reveal(q)
    const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 25)), page = Math.max(1, parseInt(q.page, 10) || 1)
    const digits = show ? String(q.search ?? '').replace(/\D/g, '') : ''
    // WATI sometimes refuses a template before WhatsApp ever sees it ("Missing information..."). Those failures have no WhatsApp message id,
    // no phone and no template name, so v_message_log (one row per message id) drops them while the failure-reasons card still counts them.
    // They are added here from v_failure_events, keyed by WATI's own localMessageId, so the list and the card agree. Needs no database change.
    const withRejected = await hasRejected()
    const src = `select whatsapp_message_id, wa_id, template_name, message_text, sent_at, delivered_at, read_at, replied_at, failed_at, failed_code, failed_detail from reporting.v_message_log`
      + (withRejected ? ` union all
        select 'wati-local:' || coalesce(nullif(e.raw_payload->>'localMessageId', ''), md5(e.raw_payload::text)), null::text, e.template_name, null::text,
          null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz, e.received_at, e.raw_payload->>'failedCode', e.raw_payload->>'failedDetail'
        from reporting.v_failure_events e where e.whatsapp_message_id is null` : '')
    const base = `(select l.*, coalesce(l.sent_at, l.failed_at) as at_utc, (coalesce(l.sent_at, l.failed_at) at time zone 'Asia/Kolkata')::date as d,
        case when l.failed_at is not null then 'failed' when l.replied_at is not null then 'replied' when l.read_at is not null then 'read' when l.delivered_at is not null then 'delivered' else 'sent' end as status,
        ${PHONE_SQL('l.wa_id')} as ph_issue, ${NAME_SQL('nm.name')} as name_issue   -- regex checks on the number and on the lead's name (server/validate.mjs)
      from lg l left join nm on nm.phone10 = right(regexp_replace(l.wa_id, '\\D', '', 'g'), 10)) f`
    const mk = (lists) => {
      const w = where(q, { date: 'f.d', lists })
      if (digits.length >= 4) w.sql += (w.sql ? ' and ' : 'where ') + `f.wa_id like ${w.ph('%' + digits + '%')}`
      return w
    }
    const wAll = mk({ 'f.template_name': 'templates' }), wRows = mk({ 'f.template_name': 'templates', 'f.status': 'status' })
    const IST = (c) => TS(`${c} at time zone 'Asia/Kolkata'`)
    const pickedStatus = LIST(q.status)
    const focusCond = pickedStatus.length ? `status = any(${wAll.ph(pickedStatus)}::text[])` : 'true'   // the summary follows the selected status button
    // Three independent queries, run at the same time (they used to run one after another, and the totals read the whole log six times):
    //  1. since: the first day in the log (also tells us when the view is missing or empty)
    //  2. the button counts and the summary, from ONE pass over the filtered log (button counts ignore the selected status; the summary follows it)
    //  3. the page of rows
    const [tRes, aggRes, rowsRes] = await Promise.allSettled([
      Q(`select count(*)::int as n, to_char(min(coalesce(sent_at, failed_at) at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as since from reporting.v_message_log`),
      // b = the log for the date and template filters (gives the counts on the status buttons); p = b narrowed to the selected status button (the summary under the buttons)
      Q(`with lg as materialized (${src}), ${NAMES_CTE('lg')}, b as materialized (select f.status, f.wa_id, f.template_name, f.failed_code, f.failed_detail, f.at_utc, f.sent_at, f.delivered_at, f.read_at, f.replied_at, f.failed_at, f.ph_issue, f.name_issue from ${base} ${wAll.sql}),
        p as (select * from b where ${focusCond}),
        lagq as (select extract(epoch from ((case status when 'replied' then replied_at when 'read' then read_at when 'delivered' then delivered_at when 'failed' then failed_at end) - sent_at)) / 60.0 as m from p where sent_at is not null)
        select
          (select coalesce(json_object_agg(status, n), '{}'::json) from (select status, count(*)::int as n from b group by 1) x) as counts,
          (select count(*)::int from p) as focus_n,
          (select count(distinct wa_id)::int from p) as people,
          (select count(distinct template_name)::int from p) as templates,
          (select coalesce(json_agg(x), '[]'::json) from (select template_name as name, count(*)::int as n from p where template_name is not null group by 1 order by 2 desc, 1 limit 5) x) as top_templates,
          (select coalesce(json_agg(x), '[]'::json) from (select failed_code as code, max(failed_detail) as detail, count(*)::int as n from p where status = 'failed' group by 1 order by 3 desc, 1 limit 4) x) as failures,
          (select percentile_cont(0.5) within group (order by m) from lagq where m >= 0) as lag_median,
          (select percentile_cont(0.9) within group (order by m) from lagq where m >= 0) as lag_p90,
          (select count(*)::int from lagq where m >= 0) as lag_n,
          (select count(*)::int from p where status = 'sent' and at_utc > now() - interval '1 hour') as sent_recent,
          (select count(*)::int from p where status = 'sent' and at_utc <= now() - interval '24 hours') as sent_old`, wAll.args),
      Q(`with lg as materialized (${src}), ${NAMES_CTE('lg')} select f.whatsapp_message_id as id, f.template_name, f.wa_id, f.status, f.failed_code, f.failed_detail, f.message_text, f.ph_issue, f.name_issue, length(regexp_replace(coalesce(f.wa_id, ''), '\D', '', 'g')) as ph_len,
          ${IST('f.at_utc')} as at, ${IST('f.sent_at')} as sent_at, ${IST('f.delivered_at')} as delivered_at, ${IST('f.read_at')} as read_at, ${IST('f.replied_at')} as replied_at, ${IST('f.failed_at')} as failed_at
        from ${base} ${wRows.sql} order by f.at_utc desc, f.whatsapp_message_id limit ${limit} offset ${(page - 1) * limit}`, wRows.args),
    ])
    if (tRes.status === 'rejected') return { capturing: false, setup: true }   // the view is not installed yet
    const t = tRes.value[0]
    if (!t.n) return { capturing: false }
    if (aggRes.status === 'rejected') throw aggRes.reason
    if (rowsRes.status === 'rejected') throw rowsRes.reason
    const agg = aggRes.value[0], rows = rowsRes.value
    const counts = Object.entries(agg.counts ?? {}).map(([status, n]) => ({ status, n }))
    // Customer names for the "WhatsApp message sent to <name> (<number>)" line: from the Salesforce lead or opportunity with the same phone number (newest wins,
    // a "name" that is really a phone number is ignored). Only looked up, and only sent, when the caller has switched reveal on: a name is personal data, like the number.
    const nameOf = new Map()
    const need = show ? [...new Set(rows.map((r) => String(r.wa_id ?? '').replace(/\D/g, '').slice(-10)).filter((p) => p.length === 10))] : []
    if (need.length) {
      try {
        const found = await Q(`select phone10, name from (
            select phone10, customer_name as name, created_at as at from reporting.v_leads where phone10 = any($1::text[])
            union all select phone10, customer_name, created_at from reporting.v_opps where phone10 = any($1::text[])) x
          where coalesce(trim(name), '') <> '' and name !~ '^[0-9+ ()-]{7,}$' order by at desc nulls last`, [need])
        for (const f of found) if (!nameOf.has(f.phone10)) nameOf.set(f.phone10, String(f.name).trim())
      } catch { /* the lead views are not there: the line then shows the number only */ }
    }
    const by = Object.fromEntries(counts.map((c) => [c.status, c.n]))
    const picked = LIST(q.status), total = picked.length ? picked.reduce((s, k) => s + (by[k] ?? 0), 0) : counts.reduce((s, c) => s + c.n, 0)   // the same filters as the rows, so no second count query
    return {
      capturing: true, since: t.since, revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', total, page, limit,
      // Summary of the selected status button (all statuses when none is selected), for the same date and template filters
      summary: {
        status: pickedStatus.length === 1 ? pickedStatus[0] : 'all', n: agg.focus_n ?? 0,
        people: agg.people ?? 0, templates: agg.templates ?? 0,
        topTemplates: (agg.top_templates ?? []).map((t) => ({ name: t.name, n: t.n })),
        // the most common failure codes with a sample wording, for the "why" part (the page groups them into plain-English causes)
        failures: (agg.failures ?? []).map((f) => ({ reason: [asText(f.code), asText(f.detail)].filter(Boolean).join(' · ').replace(/\d{7,}/g, '…').slice(0, 140) || null, n: f.n })),
        // how long the last step took after sending (minutes): the typical message and the slow end (9 in 10 are quicker). Only meaningful for one status.
        lag: agg.lag_n ? { median: Number(agg.lag_median), p90: Number(agg.lag_p90), n: agg.lag_n } : null,
        // messages with no delivery news at all: how many are very recent (probably still on their way) and how many are over a day old
        sentRecent: agg.sent_recent ?? 0, sentOld: agg.sent_old ?? 0,
      },
      counts: { all: counts.reduce((s, c) => s + c.n, 0), failed: by.failed ?? 0, replied: by.replied ?? 0, read: by.read ?? 0, delivered: by.delivered ?? 0, sent: by.sent ?? 0 },
      rows: rows.map((r) => ({
        id: r.id, at: r.at, template: r.template_name || '(template unknown)', status: r.status,
        phone: show ? String(r.wa_id ?? '').replace(/\D/g, '') : MASK(r.wa_id),
        name: show ? nameOf.get(String(r.wa_id ?? '').replace(/\D/g, '').slice(-10)) ?? null : undefined,
        times: { sent: r.sent_at, delivered: r.delivered_at, read: r.read_at, replied: r.replied_at, failed: r.failed_at },
        reason: r.status === 'failed' ? ([asText(r.failed_code), asText(r.failed_detail)].filter(Boolean).join(' · ').replace(/\d{7,}/g, '…').slice(0, 140) || null) : null,
        phone_issue: r.ph_issue ?? null, phone_digits: r.ph_len ?? null, name_issue: r.name_issue && r.name_issue !== 'ok' ? r.name_issue : null,
        has_text: !!r.message_text, text: show ? r.message_text ?? null : undefined,
        rejected: String(r.id).startsWith('wati-local:'),   // refused by WATI before it reached WhatsApp: no WhatsApp id, phone or template saved
      })),
    }
  }

  // ---------- meta ----------
  async function meta() {
    // all seven lookups at once (they used to run one after another, which made the first screen wait for the sum of them)
    const [[mr], [lr], [or], tRows, sRows, lsRows, oRows, osRows] = await Promise.all([
      Q(`select min(first_sent_date)::text as min, max(first_sent_date)::text as max from ${MSG}`),
      Q(`select min(created_date)::text as min, max(created_date)::text as max from reporting.v_leads`),
      Q(`select min(created_date)::text as min, max(created_date)::text as max from reporting.v_opps`),
      Q(`select template_name as v from ${MSG} group by 1 order by sum(attempts_est) desc`),
      Q(`select lead_source as v from reporting.v_leads group by 1 order by count(*) desc`),
      Q(`select lead_status as v from reporting.v_leads group by 1 order by count(*) desc`),
      Q(`select v from (select lead_owner as v, count(*) n from reporting.v_leads group by 1 union all select opp_owner, count(*) from reporting.v_opps group by 1) t group by v order by sum(n) desc`),
      Q(`select opportunity_status as v from reporting.v_opps group by 1 order by count(*) desc`),
    ])
    const [templates, sources, leadStatuses, owners, oppStatuses] = [tRows, sRows, lsRows, oRows, osRows].map((rows) => rows.map((r) => r.v))
    return { mode: ctx.mode, asOf: ctx.asOf, messages: mr, leads: lr, opportunities: or, templates, sources: [...sources, '(no matching lead)'], owners, leadStatuses, oppStatuses, staleDays: STALE_DAYS, canReveal: process.env.ALLOW_REVEAL !== 'false' }
  }

  return {
    meta,
    'messages/kpis': messagesKpis, 'messages/trend': messagesTrend, 'messages/templates': messagesTemplates, 'messages/failures': messagesFailures, 'messages/breakdown': messagesBreakdown, 'messages/reply-time': messagesReplyTime, 'messages/by-time': messagesByTime, 'messages/fail-reasons': messagesFailReasons, 'messages/log': messagesLog, 'messages/heatmap': messagesHeatmap,
    'leads/kpis': leadsKpis, 'leads/trend': leadsTrend, 'leads/sources': (q) => leadsGroup(q, 'lead_source'), 'leads/statuses': (q) => leadsGroup(q, 'lead_status'),
    'leads/owners': leadsOwners, 'leads/coverage': leadsCoverage, 'leads/list': leadsList,
    'opps/kpis': oppsKpis, 'opps/trend': oppsTrend, 'opps/statuses': oppsStatuses, 'opps/owners': oppsOwners, 'opps/aging': oppsAging, 'opps/list': oppsList,
    'customers/search': customersSearch, 'customers/detail': customerDetail,
    ...makeCosts({ Q, MSG, msgWhere, asOf: ctx.asOf }),
    ...makeChats({ Q, where, MASK, NAME, TS, pct, grain, prevWindow, reveal }),
    ...makeAgents({ Q, where, MASK, NAME, TS, pct, grain, prevWindow, reveal }),
    'inbox/kpis': inboxKpis, 'inbox/trend': inboxTrend, 'inbox/operators': inboxOperators, 'inbox/by-time': inboxByTime, 'inbox/duration': inboxDuration, 'inbox/heatmap': inboxHeatmap, 'inbox/waiting': inboxWaiting,
    'health/feed': healthFeed, 'health/gaps': healthGaps, 'health/facts': healthFacts,
  }
}
