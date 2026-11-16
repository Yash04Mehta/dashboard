// Data for the downloadable report (GET /api/report/data). One call collects everything the report shows, for one date range and one set of filters.
// It does not run its own maths: every figure comes from the same query functions the dashboard pages use, so the report and the screens cannot disagree.
// What it adds: the previous period's dates, which data gaps touch each period, and a block of self-checks (do the tables add up to the totals?).
// Read-only. Aggregates only: no phone numbers, no customer names and no message text ever enter the report.
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
const sum = (rows, k) => (rows ?? []).reduce((s, r) => s + (Number(r[k]) || 0), 0)
const overlapDays = (a1, a2, b1, b2) => Math.max(0, daysBetween(a1 > b1 ? a1 : b1, a2 < b2 ? a2 : b2) + 1)

export function makeReport(api, ctx) {
  return async function reportData(q) {
    const to = isDate(q.to) ? q.to : ctx.asOf
    let from = isDate(q.from) ? q.from : addDays(to, -29)
    if (from > to) from = to
    const days = daysBetween(from, to) + 1
    const grain = days <= 45 ? 'day' : days <= 200 ? 'week' : 'month'   // same rule as the dashboard's day/week/month switch
    const prev = { from: addDays(from, -days), to: addDays(from, -1) }

    const f = { from, to }
    for (const k of ['templates', 'sources', 'owners']) if (q[k]) f[k] = q[k]
    const { templates: _t, ...noTpl } = f            // leads, opportunities and chats are not tied to a template
    const dates = { from, to }                       // chats follow the date range only

    const errors = []
    const S = async (name, params) => {
      try { return await api[name](params) }
      catch (e) { errors.push({ name, message: String(e.message || e).slice(0, 200) }); return null }
    }
    const [mk, mtr, mtpl, msrc, mown, mrt, mbt, mfail, mdel, lk, ltr, lsrc, lst, lown, ok, otr, ost, oown, oage, ck, cws, cop, ctr, gaps] = await Promise.all([
      S('messages/kpis', f), S('messages/trend', { ...f, grain }), S('messages/templates', f), S('messages/breakdown', { ...f, by: 'source' }), S('messages/breakdown', { ...f, by: 'owner' }),
      S('messages/reply-time', f), S('messages/by-time', f), S('messages/fail-reasons', f), S('chats/delivery', dates),
      S('leads/kpis', noTpl), S('leads/trend', { ...noTpl, grain }), S('leads/sources', noTpl), S('leads/statuses', noTpl), S('leads/owners', noTpl),
      S('opps/kpis', noTpl), S('opps/trend', { ...noTpl, grain }), S('opps/statuses', noTpl), S('opps/owners', noTpl), S('opps/aging', noTpl),
      S('chats/kpis', dates), S('chats/wati-status', dates), S('chats/wati-operators', dates), S('chats/trend', { ...dates, grain }),
      S('health/gaps', {}),
    ])

    // ---- data gaps (days with no WhatsApp activity at all) and whether each period touches one ----
    const gapRows = (gaps?.rows ?? []).map((g) => ({ from: g.from_day, to: g.to_day, days: g.days }))
    const gapIn = (a, b) => gapRows.map((g) => ({ ...g, overlap: overlapDays(a, b, g.from, g.to) })).filter((g) => g.overlap > 0)
    const gapsNow = gapIn(from, to), gapsPrev = gapIn(prev.from, prev.to)

    // ---- chat coverage: the new chat tables start on a known day; earlier days have no chat data ----
    const chatFrom = ck?.coverage?.from_day ?? null
    const chatPartial = !!chatFrom && from < chatFrom

    // ---- self-checks: every table must add up to the number printed next to it ----
    const checks = []
    const chk = (area, label, expected, actual) => { if (expected != null && actual != null) checks.push({ area, label, expected, actual, pass: expected === actual }) }
    const m = mk?.current
    if (m) {
      for (const [lab, key, src] of [['Messages tracked', 'measured', 'measured'], ['Delivered', 'delivered', 'delivered_adj'], ['Read', 'read', 'read_adj'], ['Replied', 'replied', 'replied'], ['Failed', 'failed', 'failed']]) {
        if (mtpl) chk('WhatsApp', `${lab}: template table adds up to the total`, m[src], sum(mtpl.rows, key))
        if (mtr) chk('WhatsApp', `${lab}: trend adds up to the total`, m[src], sum(mtr.rows, key))
      }
      if (msrc) chk('WhatsApp', 'Messages tracked: lead-source table adds up to the total', m.measured, sum(msrc.rows, 'measured'))
      if (mown) chk('WhatsApp', 'Messages tracked: owner table adds up to the total', m.measured, sum(mown.rows, 'measured'))
      checks.push({ area: 'WhatsApp', label: 'Funnel only narrows: tracked ≥ delivered ≥ read ≥ replied', expected: 'yes', actual: m.measured >= m.delivered_adj && m.delivered_adj >= m.read_adj && m.read_adj >= m.replied ? 'yes' : 'no', pass: m.measured >= m.delivered_adj && m.delivered_adj >= m.read_adj && m.read_adj >= m.replied })
      chk('WhatsApp', 'All sends minus repeats equals messages tracked', m.attempts - m.unmeasured, m.measured)
    }
    const l = lk?.current
    if (l) {
      if (lsrc) chk('Leads', 'Leads: source table adds up to the total', l.leads, sum(lsrc.rows, 'leads'))
      if (lst) chk('Leads', 'Leads: status table adds up to the total', l.leads, sum(lst.rows, 'leads'))
      if (lown) chk('Leads', 'Leads: owner table adds up to the total', l.leads, sum(lown.rows, 'leads'))
      if (ltr) chk('Leads', 'Leads: trend adds up to the total', l.leads, sum(ltr.rows, 'leads'))
    }
    const o = ok?.current
    if (o) {
      if (ost) chk('Opportunities', 'Opportunities: status table adds up to the total', o.opportunities, sum(ost.rows, 'opportunities'))
      if (oown) chk('Opportunities', 'Opportunities: owner table adds up to the total', o.opportunities, sum(oown.rows, 'opportunities'))
      if (oown) chk('Opportunities', 'Deals won: owner table adds up to the total', o.won, sum(oown.rows, 'won'))
      if (otr) chk('Opportunities', 'Opportunities: trend adds up to the total', o.opportunities, sum(otr.rows, 'opportunities'))
      chk('Opportunities', 'Open + won + lost equals all opportunities', o.opportunities, o.open + o.won + o.lost)
    }

    return {
      generatedAt: new Date().toISOString(), mode: ctx.mode, asOf: ctx.asOf, grain,
      period: { from, to, days }, previous: prev,
      filters: { templates: f.templates ? String(f.templates).split('|') : [], sources: f.sources ? String(f.sources).split('|') : [], owners: f.owners ? String(f.owners).split('|') : [] },
      gaps: { all: gapRows, now: gapsNow, previous: gapsPrev },
      chat: { from: chatFrom, partial: chatPartial },
      messages: { kpis: mk, trend: mtr?.rows ?? null, templates: mtpl?.rows ?? null, bySource: msrc?.rows ?? null, byOwner: mown?.rows ?? null, replyTime: mrt, byTime: mbt, failReasons: mfail, delivery: mdel },
      leads: { kpis: lk, trend: ltr?.rows ?? null, sources: lsrc?.rows ?? null, statuses: lst?.rows ?? null, owners: lown?.rows ?? null },
      opps: { kpis: ok, trend: otr?.rows ?? null, statuses: ost?.rows ?? null, owners: oown?.rows ?? null, aging: oage?.rows ?? null },
      chats: { kpis: ck, watiStatus: cws, operators: cop, trend: ctr?.rows ?? null },
      checks, errors,
    }
  }
}
