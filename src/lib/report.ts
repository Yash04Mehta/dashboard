// Builds the downloadable report: ONE self-contained HTML file (no network, no scripts that fetch, fonts from the reader's own computer) that opens in any browser,
// prints cleanly on A4 and saves as a PDF from the browser's Print dialog. Everything in it comes from GET /api/report/data (server/report.mjs), which reuses the
// dashboard's own queries, so the report and the screens show the same numbers. The report holds totals only: no phone numbers, customer names or message text.
//
// Layout follows the two tools the team already reads:
//   WATI "Inbox Analytics" / "Message Insights":  conversation status tiles, status mix, message funnel and delivery, team table, trends
//   Salesforce lead and opportunity dashboards:    headline tiles, "by source / status / owner" breakdowns, pipeline by stage, win rate, ageing
import { classify, bucketOf, BUCKETS, BUCKET_ORDER, type BucketId } from "@/lib/fail-reasons"

export type ReportData = any   // the JSON from /api/report/data

// ---------- small helpers ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const n0 = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : Math.round(v).toLocaleString("en-US"))
const p1 = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : `${(Math.round(v * 10) / 10).toFixed(1)}%`)
const p0 = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "—" : `${Math.round(v)}%`)
const share = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null)
const dLong = (s?: string | null) => { if (!s) return "—"; const [y, m, d] = s.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}` }
const range = (a: string, b: string) => (a === b ? dLong(a) : `${dLong(a)} to ${dLong(b)}`)
const mins = (m: number | null | undefined) => (m == null ? "—" : m < 1 ? "under a minute" : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1).replace(/\.0$/, "")} hours` : `${(m / 1440).toFixed(1).replace(/\.0$/, "")} days`)
const clock = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`)
const periodLabel = (iso: string, grain: string) => { const [y, m, d] = iso.split("-").map(Number); return grain === "month" ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : `${d} ${MONTHS[m - 1]}` }
const cleanLabel = (s: string) => (s === "(no matching lead)" ? "Not linked to a lead" : s === "(unknown: overwritten by status)" ? "Source not recorded" : s === "(none)" ? "Not set" : s === "(unassigned)" ? "Unassigned" : s)

const MIN_PREV = { messages: 100, leads: 30, closed: 30 }    // a previous period smaller than this is too thin to compare with (same rule as the Overview page)
const MIN_TEMPLATE = 200                                       // a template needs this many tracked messages to be judged
const MIN_CELL = 50, MIN_BEST = 300                            // an hour needs MIN_CELL messages to show a rate, MIN_BEST to be named the best
const MIN_PERIOD = { day: 20, week: 50, month: 100 } as Record<string, number>

const C = { ink: "#17212e", muted: "#5b6878", line: "#e2e7ee", soft: "#f3f6f9", brand: "#0b6b6f", brand2: "#2f8f93", blue: "#2c6fbb", good: "#1d9a5f", bad: "#d24545", warn: "#d38a06", violet: "#6f5bd1", grey: "#9aa6b4" }
const BUCKET_COLOR: Record<BucketId, string> = { ours: C.warn, whatsapp: C.violet, customer: "#2a8cab", unclear: C.grey }

// ---------- comparison chips ----------
type Good = "up" | "down" | "none"
function chip(cur: number | null | undefined, prev: number | null | undefined, kind: "pp" | "rel", good: Good = "up"): string {
  if (cur == null || prev == null) return ""
  let d: number, txt: string
  if (kind === "pp") { d = Math.round((cur - prev) * 10) / 10; txt = `${Math.abs(d).toFixed(1)} pts` }
  else { if (prev === 0) return ""; d = Math.round(((cur - prev) / prev) * 1000) / 10; txt = `${Math.abs(d).toFixed(1)}%` }
  if (d === 0) return `<span class="chip flat">no change</span>`
  const better = good === "none" ? null : (d > 0) === (good === "up")
  const cls = better == null ? "flat" : better ? "up" : "down"
  return `<span class="chip ${cls}">${d > 0 ? "▲" : "▼"} ${txt}</span>`
}

// ---------- building blocks ----------
function tile(label: string, value: string, sub = "", extra = "", tone = ""): string {
  return `<div class="tile ${tone}"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ""}${extra ? `<div class="tc">${extra}</div>` : ""}</div>`
}
function note(html: string, tone: "info" | "warn" = "info"): string { return `<div class="note ${tone}">${html}</div>` }
function card(title: string, body: string, sub = "", cls = ""): string {
  return `<div class="card ${cls}"><h3>${esc(title)}</h3>${sub ? `<p class="sub">${sub}</p>` : ""}${body}</div>`
}
function section(n: number, title: string, intro: string, body: string): string {
  // the heading, its intro and the first row of tiles are kept together, so a heading is never left alone at the bottom of a page
  const i = body.search(/<div class="(card|two)[ "]/), head = i > 0 ? body.slice(0, i) : "", rest = i > 0 ? body.slice(i) : body
  return `<section class="sec" id="s${n}"><div class="keep"><h2>${n ? `<span class="num">${n}</span>` : ""}${esc(title)}</h2>${intro ? `<p class="intro">${intro}</p>` : ""}${head}</div>${rest}</section>`
}
function table(head: { t: string; num?: boolean }[], rows: string[][], opts: { foot?: string[]; cls?: string } = {}): string {
  const th = head.map((h) => `<th class="${h.num ? "r" : ""}">${esc(h.t)}</th>`).join("")
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${head[i]?.num ? "r" : ""}">${c}</td>`).join("")}</tr>`).join("")
  const ft = opts.foot ? `<tfoot><tr>${opts.foot.map((c, i) => `<td class="${head[i]?.num ? "r" : ""}">${c}</td>`).join("")}</tr></tfoot>` : ""
  return `<div class="tw"><table class="${opts.cls ?? ""}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${ft}</table></div>`
}
/** horizontal bars: one row per item, bar length against the largest, with count and share */
function hbars(items: { label: string; value: number; color?: string; note?: string }[], total: number, color = C.brand2): string {
  if (!items.length) return `<p class="empty">Nothing to show for this period.</p>`
  const max = Math.max(1, ...items.map((i) => i.value))
  return `<div class="hb">${items.map((i) => `<div class="hr"><div class="hl" title="${esc(i.label)}">${esc(i.label)}</div><div class="hbar"><span style="width:${Math.max(0.8, (100 * i.value) / max)}%;background:${i.color ?? color}"></span></div><div class="hv"><b>${n0(i.value)}</b><i>${p1(share(i.value, total))}</i></div>${i.note ? `<div class="hn">${esc(i.note)}</div>` : ""}</div>`).join("")}</div>`
}
/** folds the tail of a sorted list into one "All other" row so a table still adds up to its total (a row the server already folded is merged in too) */
function fold(rows: any[], n: number, label: string, sums: string[], other: string): any[] {
  const real = rows.filter((r) => !r.isOther)
  const tail = [...real.slice(n), ...rows.filter((r) => r.isOther)]
  if (!tail.length) return real
  const o: any = { [label]: other, folded: true }
  for (const k of sums) o[k] = tail.reduce((t, r) => t + (r[k] || 0), 0)
  return [...real.slice(0, n), o]
}

// ---------- SVG charts ----------
type Series = { name: string; color: string; values: (number | null)[] }
/** Grouped bars (left scale) and an optional line in % (right scale). Labels thin out so they never overlap. */
function chartSvg(labels: string[], bars: Series[], line?: Series & { max?: number }, H = 230): string {
  const W = 720, L = 46, R = line ? 44 : 10, T = 22, B = 30
  const iw = W - L - R, ih = H - T - B, n = labels.length
  if (!n) return `<p class="empty">No data in this period.</p>`
  const maxBar = Math.max(1, ...bars.flatMap((s) => s.values.map((v) => v ?? 0)))
  // four equal steps with round numbers (10, 20, 30, 40), never 13, 25, 38
  const raw = maxBar / 4, pw = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pw
  const tickStep = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 && pw >= 10 ? 2.5 : f <= 5 ? 5 : 10) * pw)
  const top = tickStep * 4, band = iw / n, bw = Math.max(1.5, Math.min(26, (band * 0.72) / bars.length))
  const y = (v: number) => T + ih - (v / top) * ih
  const labelW = String(n0(maxBar)).length * 5.6 + 2   // rough width of the longest number
  const showVals = bars.length === 1 ? labelW <= band - 2 : labelW <= bw + 3
  let g = ""
  for (let i = 0; i <= 4; i++) { const v = (top * i) / 4, yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${C.line}"/><text x="${L - 6}" y="${yy + 3.5}" text-anchor="end" class="ax">${n0(v)}</text>` }
  bars.forEach((s, si) => s.values.forEach((v, i) => {
    if (v == null) return
    const x = L + i * band + (band - bw * bars.length) / 2 + si * bw, yy = y(v)
    g += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${(bw - 0.6).toFixed(1)}" height="${Math.max(0, T + ih - yy).toFixed(1)}" fill="${s.color}" rx="1.5"><title>${esc(labels[i])}: ${esc(s.name)} ${n0(v)}</title></rect>`
    // the number on top of the bar, when it fits without touching its neighbour
    if (showVals && !(v === 0 && bars.length > 1)) g += `<text x="${(x + (bw - 0.6) / 2).toFixed(1)}" y="${(yy - 3.5).toFixed(1)}" text-anchor="middle" class="vl">${n0(v)}</text>`
  }))
  const step = Math.max(1, Math.ceil(n / 12))
  labels.forEach((lb, i) => { if (i % step === 0) g += `<text x="${(L + i * band + band / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="ax">${esc(lb)}</text>` })
  if (line) {
    const lm = line.max ?? Math.max(8, Math.ceil(Math.max(...line.values.map((v) => v ?? 0)) * 1.2 / 4) * 4)   // a multiple of 4, so the four steps are whole numbers
    const ly = (v: number) => T + ih - (v / lm) * ih
    for (let i = 0; i <= 4; i++) g += `<text x="${W - R + 6}" y="${T + ih - (ih * i) / 4 + 3.5}" class="ax" fill="${line.color}">${Math.round((lm * i) / 4)}%</text>`
    let d = "", pen = false
    line.values.forEach((v, i) => { if (v == null) { pen = false; return } const px = L + i * band + band / 2; d += `${pen ? "L" : "M"}${px.toFixed(1)},${ly(v).toFixed(1)} `; pen = true })
    g += `<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2.2" stroke-linejoin="round"/>`
    line.values.forEach((v, i) => { if (v != null && n <= 45) g += `<circle cx="${(L + i * band + band / 2).toFixed(1)}" cy="${ly(v).toFixed(1)}" r="2.6" fill="${line.color}"><title>${esc(labels[i])}: ${esc(line.name)} ${p1(v)}</title></circle>${n <= 14 ? `<text x="${(L + i * band + band / 2).toFixed(1)}" y="${(ly(v) - 7).toFixed(1)}" text-anchor="middle" class="vl lv" fill="${line.color}">${p1(v)}</text>` : ""}` })
  }
  const legend = [...bars, ...(line ? [line] : [])].map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Chart">${g}</svg><div class="legend">${legend}</div>`
}
function donut(parts: { label: string; value: number; color: string }[], centre: string, centreSub: string): string {
  const total = parts.reduce((s, p) => s + p.value, 0)
  if (!total) return `<p class="empty">No conversations in this period.</p>`
  const r = 52, c = 2 * Math.PI * r
  let off = 0, arcs = ""
  for (const p of parts) { if (!p.value) continue; const len = (p.value / total) * c; arcs += `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${p.color}" stroke-width="20" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"><title>${esc(p.label)}: ${n0(p.value)}</title></circle>`; off += len }
  const legend = parts.filter((p) => p.value).map((p) => `<li><i style="background:${p.color}"></i><span>${esc(p.label)}</span><b>${n0(p.value)}</b><em>${p0(share(p.value, total))}</em></li>`).join("")
  return `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="Status mix">${arcs}<text x="70" y="68" text-anchor="middle" class="dc">${esc(centre)}</text><text x="70" y="84" text-anchor="middle" class="ds">${esc(centreSub)}</text></svg><ul>${legend}</ul></div>`
}
/** Flowchart, left to right: every box is a part of the box its arrow comes from. */
function flow(m: { measured: number; delivered: number; failed: number; noConf: number; read: number; notRead: number; replied: number; noReply: number }, col: Record<string, string>): string {
  const BW = 156, BH = 58, GAP = 32, P = 70
  const X = [0, 1, 2, 3].map((i) => i * (BW + GAP))
  type Box = { id: string; col: number; cy: number; label: string; value: number; sub: string; fill: string; dark?: boolean }
  const cyReplied = 30, cyNoReply = cyReplied + P, cyRead = (cyReplied + cyNoReply) / 2
  const cyNotRead = cyRead + 110, cyDel = (cyRead + cyNotRead) / 2
  const cyFail = cyDel + 85, cyNoConf = cyFail + P, cyTrk = (cyDel + cyNoConf) / 2
  const pc = (v: number, base: number) => `${p1(share(v, base))} of `
  const boxes: Box[] = [
    { id: "trk", col: 0, cy: cyTrk, label: "Messages tracked", value: m.measured, sub: "messages we can follow", fill: col.brand },
    { id: "del", col: 1, cy: cyDel, label: "Delivered", value: m.delivered, sub: pc(m.delivered, m.measured) + "tracked", fill: col.brand2 },
    { id: "fail", col: 1, cy: cyFail, label: "Failed", value: m.failed, sub: pc(m.failed, m.measured) + "tracked", fill: col.bad },
    { id: "nc", col: 1, cy: cyNoConf, label: "No confirmation", value: m.noConf, sub: pc(m.noConf, m.measured) + "tracked", fill: col.warn },
    { id: "read", col: 2, cy: cyRead, label: "Read", value: m.read, sub: pc(m.read, m.delivered) + "delivered", fill: col.blue },
    { id: "nr", col: 2, cy: cyNotRead, label: "Not read yet", value: m.notRead, sub: pc(m.notRead, m.delivered) + "delivered", fill: "#e3e9f0", dark: true },
    { id: "rep", col: 3, cy: cyReplied, label: "Replied", value: m.replied, sub: pc(m.replied, m.read) + "read", fill: col.good },
    { id: "nrp", col: 3, cy: cyNoReply, label: "No reply", value: m.noReply, sub: pc(m.noReply, m.read) + "read", fill: "#e3e9f0", dark: true },
  ]
  const by = Object.fromEntries(boxes.map((b) => [b.id, b]))
  const links: [string, string][] = [["trk", "del"], ["trk", "fail"], ["trk", "nc"], ["del", "read"], ["del", "nr"], ["read", "rep"], ["read", "nrp"]]
  const H = cyNoConf + BH / 2 + 6
  const edges = links.map(([f, t]) => {
    const a = by[f], b = by[t], x1 = X[a.col] + BW, x2 = X[b.col] - 3, xm = (x1 + x2) / 2
    return `<path d="M${x1} ${a.cy.toFixed(1)} C${xm} ${a.cy.toFixed(1)},${xm} ${b.cy.toFixed(1)},${x2} ${b.cy.toFixed(1)}" fill="none" stroke="#8a9bad" stroke-width="1.6" marker-end="url(#fa)"/>`
  }).join("")
  const nodes = boxes.map((b) => {
    const x = X[b.col], y = b.cy - BH / 2, tc = b.dark ? "#1f2a37" : "#fff"
    return `<g><rect x="${x}" y="${y.toFixed(1)}" width="${BW}" height="${BH}" rx="9" fill="${b.fill}"/>`
      + `<text x="${x + 10}" y="${(y + 16).toFixed(1)}" class="fl" fill="${tc}">${esc(b.label)}</text>`
      + `<text x="${x + 10}" y="${(y + 37).toFixed(1)}" class="fv" fill="${tc}">${n0(b.value)}</text>`
      + `<text x="${x + 10}" y="${(y + 51).toFixed(1)}" class="fs" fill="${tc}">${esc(b.sub)}</text></g>`
  }).join("")
  const W = X[3] + BW
  return `<svg class="flow" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Flowchart of how tracked messages split into delivered, failed, read and replied"><defs><marker id="fa" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#8a9bad"/></marker></defs>${edges}${nodes}</svg>`
}

// ---------- the report ----------
export function renderReport(d: ReportData): string {
  const per = d.period, prv = d.previous
  const mk = d.messages.kpis, m = mk?.current, mpRaw = mk?.previous
  const lk = d.leads.kpis, l = lk?.current, lpRaw = lk?.previous
  const ok = d.opps.kpis, o = ok?.current, opRaw = ok?.previous
  const ws = d.chats.watiStatus, ck = d.chats.kpis, cc = ck?.current
  // WATI's "Total conversations" is Open + Pending + Solved + Expired (checked against WATI's own screen: 15 + 0 + 3 + 80 = 98). Missed and Unassigned overlap with those, so they are not added.
  // The server's own "period.total" counts customers who wrote in the dates, a different basis from Expired (counted on the day the 24 hours ended), so it is not used for percentages.
  const wTotal = ws?.available ? ws.live.open + ws.live.pending + ws.period.solved + ws.period.expired : 0
  const grainWord = d.grain === "day" ? "day" : d.grain === "week" ? "week" : "month"
  // Salesforce data is complete for every day, so a day with nothing in it is a real zero and is drawn (the server leaves empty days out)
  const fillDays = (rows: any[], zero: Record<string, number>): any[] => {
    if (d.grain !== "day" || !rows.length) return rows
    const by = new Map(rows.map((r) => [String(r.period).slice(0, 10), r]))
    const out: any[] = []
    for (let t = Date.parse(`${per.from}T00:00:00Z`); t <= Date.parse(`${per.to}T00:00:00Z`) && out.length < 60; t += 864e5) { const k = new Date(t).toISOString().slice(0, 10); out.push(by.get(k) ?? { ...zero, period: k }) }
    return out
  }
  // a template sent again and again to the same people can have more confirmations than tracked messages; a rate above 100% is never shown
  let capped = false
  const cap = (v: number | null): number | null => { if (v != null && v > 100) { capped = true; return 100 } return v }
  const CAPNOTE = () => (capped ? " Rates are capped at 100%: repeat sends can bring more confirmations than tracked messages." : "")

  // A WhatsApp comparison is only fair when neither period overlaps a gap in the WhatsApp feed and the earlier period is big enough.
  const gapAny = d.gaps.now.length > 0 || d.gaps.previous.length > 0
  const mp = !gapAny && mpRaw && mpRaw.measured >= MIN_PREV.messages ? mpRaw : null
  const lp = lpRaw && lpRaw.leads >= MIN_PREV.leads ? lpRaw : null
  const op = opRaw && opRaw.won + opRaw.lost >= MIN_PREV.closed ? opRaw : null
  const closed = o ? o.won + o.lost : 0

  // ---- failure reasons grouped by who can fix them ----
  const fr = d.messages.failReasons
  const failBuckets: Record<BucketId, number> = { ours: 0, whatsapp: 0, customer: 0, unclear: 0 }
  const failTop: { label: string; code: string | null; bucket: BucketId; n: number }[] = []
  if (fr?.capturing && fr.reasons?.length) {
    const byLabel = new Map<string, { label: string; code: string | null; bucket: BucketId; n: number }>()
    for (const r of fr.reasons as { reason: string; n: number }[]) {
      const c = classify(r.reason), b = bucketOf(c.group.id)
      failBuckets[b] += r.n
      const k = c.label, e = byLabel.get(k) ?? { label: c.label, code: c.code, bucket: b, n: 0 }; e.n += r.n; byLabel.set(k, e)
    }
    failTop.push(...[...byLabel.values()].sort((a, b) => b.n - a.n))
  }
  const failTotal = BUCKET_ORDER.reduce((s, b) => s + failBuckets[b], 0)

  // ---- best time to send ----
  const hours: any[] = (d.messages.byTime?.hours ?? []).map((h: any) => ({ ...h, hour: h.k }))
  const hoursOk = hours.filter((h) => h.measured >= MIN_BEST && h.replied_pct != null)
  const bestHour = hoursOk.length > 1 ? hoursOk.reduce((a, b) => (b.replied_pct > a.replied_pct ? b : a)) : null

  // ---- chats: WATI-style tiles ----
  const chatsPartialNote = d.chat.partial ? note(`Our own chat records start on <b>${dLong(d.chat.from)}</b>, so any day before that has no chat data of ours. WATI's status figures below come from WATI itself.`, "warn") : ""
  let chatsBody = chatsPartialNote
  if (ws?.available) {
    const p = ws.period
    chatsBody += `<div class="tiles t4">${[
      tile("Total conversations", n0(wTotal), "open + pending + solved + expired"),
      tile("Open now", n0(ws.live.open), "right now"),
      tile("Pending now", n0(ws.live.pending), "right now"),
      tile("Solved", n0(p.solved), `${p0(share(p.solved, wTotal))} of total`, "", "good"),
      tile("Solved by bot", n0(p.solved_by_bot), "part of Solved"),
      tile("Expired", n0(p.expired), `${p0(share(p.expired, wTotal))} of total`),
      tile("Missed", n0(p.missed), `${p0(share(p.missed, p.expired))} of expired`, "", p.missed > 0 ? "bad" : ""),
      tile("Unassigned", n0(p.unassigned), "no owner in WATI", "", p.unassigned > 0 ? "warn" : ""),
    ].join("")}</div>`
    chatsBody += `<div class="two wide-r">${card("How conversations ended", donut([
      { label: "Solved", value: p.solved, color: C.good }, { label: "Expired: window closed, not solved", value: p.expired, color: C.bad }, { label: "Open now", value: ws.live.open, color: C.blue }, { label: "Pending now", value: ws.live.pending, color: C.warn },
    ], n0(wTotal), "conversations"), "Solved + Expired + Open + Pending = Total. Missed is part of Expired.")}${chatTeam(d)}</div>`
  } else {
    chatsBody += note(`WATI's own conversation status (Open, Pending, Solved, Expired, Missed) is <b>not available</b> yet: the WATI Status Sync workflow has not saved data. The figures below are our own count from the chat records.`, "warn")
  }
  if (cc && cc.customer_chats > 0) {
    chatsBody += `<div class="tiles t3">${[
      tile("Chats with messages", n0(cc.chats), `${n0(cc.customer_chats)} where the customer wrote`),
      tile("Reply speed", cc.fr_median == null ? "—" : mins(cc.fr_median), "typical time for the team to reply", cc.answered ? `${n0(cc.answered)} chats were answered` : ""),
      tile("Answered within an hour", p0(cc.within_hour_pct), `${n0(cc.within_hour)} of ${n0(cc.customer_chats)} customer chats`),
    ].join("")}</div>`
    const rows: any[] = (d.chats.trend ?? []).map((r: any) => ({ label: periodLabel(r.period, d.grain), customer: r.waiting + r.replied + r.missed, outbound: r.outbound }))
    if (rows.length > 1) chatsBody += card(`Chats started per ${grainWord}`, chartSvg(rows.map((r) => r.label), [{ name: "Customer wrote in", color: C.brand, values: rows.map((r) => r.customer) }, { name: "We messaged, customer did not write", color: "#b9c4d0", values: rows.map((r) => r.outbound) }], undefined, 150))
  } else if (!ws?.available) chatsBody += `<p class="empty">No chat records in this period.</p>`

  // ---- messages ----
  let msgBody = ""
  if (!m) msgBody = note("The WhatsApp message figures could not be loaded for this report.", "warn")
  else {
    if (gapAny) msgBody += note(`<b>Comparison with the previous period is switched off for WhatsApp.</b> The WhatsApp data feed was silent ${[...d.gaps.now, ...d.gaps.previous].map((g: any) => `${dLong(g.from)} to ${dLong(g.to)}`).filter((v, i, a) => a.indexOf(v) === i).join(" and ")}, which overlaps ${d.gaps.now.length ? "this period" : ""}${d.gaps.now.length && d.gaps.previous.length ? " and " : ""}${d.gaps.previous.length ? "the one before" : ""}. Counts for those days are missing, so a comparison would mislead.`, "warn")
    const mpv = (a: number | null, b: number | undefined, good: Good) => (mp ? chip(a, b, "pp", good) : "")
    const noConf = Math.max(0, m.measured - m.delivered_adj - m.failed)
    const notRead = Math.max(0, m.delivered_adj - m.read_adj), noReply = Math.max(0, m.read_adj - m.replied)
    msgBody += `<p class="grp">Every tracked message ends in one of three ways. These three add up to the tracked total.</p><div class="tiles t4">${[
      tile("Messages tracked", n0(m.measured), m.unmeasured ? `${n0(m.attempts)} sent in all; ${n0(m.unmeasured)} older repeat sends cannot be followed` : "every message sent, on the day it was sent"),
      tile("Delivered", n0(m.delivered_adj), `${p1(m.delivered_pct)} of tracked · reached the phone`, mpv(m.delivered_pct, mp?.delivered_pct, "up")),
      tile("Failed to send", n0(m.failed), `${p1(m.failed_pct)} of tracked · WhatsApp refused them`, mpv(m.failed_pct, mp?.failed_pct, "down"), m.failed_pct > 5 ? "bad" : ""),
      tile("No confirmation", n0(noConf), `${p1(share(noConf, m.measured))} of tracked · no status came back; many were probably delivered`, "", "warn"),
    ].join("")}</div>`
    msgBody += `<p class="grp">Of the delivered messages (a smaller step each time):</p><div class="tiles t2">${[
      tile("Read", n0(m.read_adj), `part of Delivered · ${p1(share(m.read_adj, m.delivered_adj))} of delivered · ${p1(m.read_pct)} of tracked`, mpv(m.read_pct, mp?.read_pct, "up")),
      tile("Replied", n0(m.replied), `part of Read · ${p1(share(m.replied, m.read_adj))} of read · ${p1(m.replied_pct)} of tracked`, mpv(m.replied_pct, mp?.replied_pct, "up"), "good"),
    ].join("")}</div>`
    msgBody += card("How the messages add up", flow({ measured: m.measured, delivered: m.delivered_adj, failed: m.failed, noConf, read: m.read_adj, notRead, replied: m.replied, noReply }, C as any),
      "Read it from left to right. Each box is a part of the box its arrow comes from, so the boxes after an arrow add up to the one before it. Delivered and read are minimums.")

    // trend
    const tr: any[] = d.messages.trend ?? []
    if (tr.length) {
      const min = MIN_PERIOD[d.grain] ?? 20
      const rows = tr.map((r) => ({ label: periodLabel(r.period, d.grain), measured: r.measured, rate: r.measured >= min ? r.replied_pct : null }))
      const skipped = rows.filter((r) => r.rate == null).length
      msgBody += card(`Messages and reply rate by ${grainWord}`, chartSvg(rows.map((r) => r.label), [{ name: "Messages tracked", color: "#b5c9d9", values: rows.map((r) => r.measured) }], { name: "Reply rate", color: C.good, values: rows.map((r) => r.rate) }),
        skipped ? `${skipped} of ${rows.length} ${grainWord}s had fewer than ${min} messages, so their reply rate is left out (the line has gaps there).` : `Every ${grainWord} shown had at least ${min} messages.`)
    }

    // templates (placed after "best time / reply speed" so the first page of this part fills up)
    let tplCard = ""
    const tpl: any[] = d.messages.templates ?? []
    if (tpl.length) {
      const shown = fold(tpl, 12, "template_name", ["measured", "attempts", "unmeasured", "delivered", "read", "replied", "failed"], "All other templates")
      const rate = (r: any, k: string) => cap(share(r[k], r.measured))
      const rowsH = shown.map((r: any) => {
        const small = !r.folded && r.measured < MIN_TEMPLATE
        const fail = rate(r, "failed")
        return [`${esc(r.template_name)}${small ? ` <span class="tag">few messages</span>` : ""}`, n0(r.measured), p1(rate(r, "delivered")), p1(rate(r, "read")), p1(rate(r, "replied")), `<span class="${fail != null && fail > 5 && r.measured >= 20 ? "bad-t" : ""}">${p1(fail)}</span>`]
      })
      const tot = { measured: m.measured }
      tplCard = card("Templates compared", table([{ t: "Template" }, { t: "Messages", num: true }, { t: "Delivered", num: true }, { t: "Read", num: true }, { t: "Replied", num: true }, { t: "Failed", num: true }], rowsH,
        { foot: ["All templates", n0(tot.measured), p1(m.delivered_pct), p1(m.read_pct), p1(m.replied_pct), p1(m.failed_pct)] }), `The ${Math.min(12, tpl.length)} busiest templates, then the rest together. Templates with under ${MIN_TEMPLATE} messages are too few to judge. Failed rates above 5% are in red.${CAPNOTE()}`, "split")
    }

    // when to send + response time
    const rt = d.messages.replyTime?.reply
    const hourBars = hours.map((h: any) => ({ label: String(h.hour), rate: h.measured >= MIN_CELL ? h.replied_pct : null, n: h.measured }))
    const hourSvg = hours.length && hours.some((h: any) => h.measured > 0) ? hourChart(hourBars, bestHour?.hour ?? null) : `<p class="empty">No messages in this period.</p>`
    const RT = ["Under 5 min", "5 to 60 min", "1 to 6 hours", "6 to 24 hours", "1 to 3 days", "Over 3 days"]
    const rtItems = rt?.total ? (rt.buckets as any[]).map((b) => ({ label: RT[b.ord - 1], value: b.n })) : []
    msgBody += `<div class="two">${card("Best time to send", hourSvg, bestHour ? `Reply rate by the hour the message was sent (India time). Highest around <b>${clock(bestHour.hour)}</b> (${p1(bestHour.replied_pct)}). Hours with under ${MIN_CELL} messages are left blank.` : `Reply rate by the hour the message was sent (India time). No best hour is named: an hour needs at least ${MIN_BEST} messages for a fair comparison, and none reached that in this period. Bars are left blank for hours with under ${MIN_CELL} messages.`)}${card("How fast customers reply", rtItems.length ? hbars(rtItems, rt.total, C.good) : `<p class="empty">Not enough replies in this period.</p>`, rt?.total ? `Half of the replies came within <b>${mins(rt.median_min)}</b>, and <b>${p0(rt.within_day_pct)}</b> within a day. An estimate from ${n0(rt.total)} messages: WhatsApp gives no exact reply time.` : "")}</div>`
    msgBody += tplCard

    // failures
    if (m.failed > 0) {
      let fb = ""
      if (failTotal) {
        fb = `<div class="fb3">${BUCKET_ORDER.filter((b) => b !== "unclear" || failBuckets.unclear > 0).map((b) => `<div class="fbx" style="border-top-color:${BUCKET_COLOR[b]}"><div class="fbn">${n0(failBuckets[b])} <small>${p0(share(failBuckets[b], failTotal))}</small></div><div class="fbt">${esc(BUCKETS[b].title)}</div><div class="fbd">${esc(BUCKETS[b].todo)}</div></div>`).join("")}</div>`
        fb += table([{ t: "What WATI reported" }, { t: "Who can fix it" }, { t: "Messages", num: true }], failTop.slice(0, 8).map((r) => [`${esc(r.label)}${r.code ? ` <span class="code">${esc(r.code)}</span>` : ""}`, `<span style="color:${BUCKET_COLOR[r.bucket]}">${esc(BUCKETS[r.bucket].title)}</span>`, n0(r.n)]))
      } else fb = `<p class="empty">Failure reasons are not being recorded for this period.</p>`
      const since = fr?.capturing ? `Reasons are recorded from ${dLong(fr.since)}; earlier failures have no reason. ${n0(fr.with_reason)} of the ${n0(fr.failed_events)} failures in this period have one.` : "Failure reasons are not being saved yet."
      msgBody += card("Why messages failed", fb, since)
    }

    // by owner and by source
    const own = fold(d.messages.byOwner ?? [], 8, "label", ["measured", "delivered", "read", "replied", "failed"], "All other owners")
    const src = fold(d.messages.bySource ?? [], 8, "label", ["measured", "delivered", "read", "replied", "failed"], "All other sources")
    const bt = (rows: any[]) => table([{ t: "" }, { t: "Messages", num: true }, { t: "Read", num: true }, { t: "Replied", num: true }, { t: "Failed", num: true }], rows.map((r) => [esc(cleanLabel(r.label ?? "")), n0(r.measured), p1(cap(share(r.read, r.measured))), p1(cap(share(r.replied, r.measured))), p1(cap(share(r.failed, r.measured)))]))
    if (own.length || src.length) { const bo = own.length ? bt(own) : "", bs = src.length ? bt(src) : ""; msgBody += `<div class="two">${own.length ? card("By lead owner", bo, `The owner of the lead the message went to. “Not linked to a lead” = the message’s phone number matched no lead record, so its owner is unknown.${CAPNOTE()}`) : ""}${src.length ? card("By lead source", bs, `Source is not recorded for many leads. “Not linked to a lead” = the message’s phone number matched no lead record, so its source is unknown.${CAPNOTE()}`) : ""}</div>` }
  }

  // ---- leads (Salesforce style) ----
  let leadBody = ""
  if (!l) leadBody = note("The lead figures could not be loaded for this report.", "warn")
  else {
    const lpv = (a: number | null, b: number | undefined, good: Good = "up") => (lp ? chip(a, b, "pp", good) : "")
    leadBody += `<div class="tiles t4">${[
      tile("Lead records", n0(l.leads), "created in this period", lp ? chip(l.leads, lp.leads, "rel", "none") : ""),
      tile("Different phone numbers", n0(l.people), `${n0(l.phone_overwritten + l.phone_empty)} leads have no usable number, so cannot be counted here`),
      tile("Welcome message", p1(l.welcome_pct), `${n0(l.welcome)} leads`, lpv(l.welcome_pct, lp?.welcome_pct)),
      tile("24-hour follow-up", p1(l.followup_24h_pct), `${n0(l.followup_24h)} leads`, lpv(l.followup_24h_pct, lp?.followup_24h_pct), l.followup_24h_pct < 50 ? "warn" : ""),
      tile("1st task follow-up", p1(l.task1_pct), `${n0(l.task1)} leads`, lpv(l.task1_pct, lp?.task1_pct)),
      tile("2nd task follow-up", p1(l.task2_pct), `${n0(l.task2)} leads`, lpv(l.task2_pct, lp?.task2_pct)),
      tile("3rd task follow-up", p1(l.task3_pct), `${n0(l.task3)} leads`, lpv(l.task3_pct, lp?.task3_pct)),
      tile("No welcome message", n0(l.leads - l.welcome), `${p1(share(l.leads - l.welcome, l.leads))} of leads`, "", l.leads - l.welcome > 0 ? "warn" : ""),
    ].join("")}</div>`
    const lt: any[] = fillDays(d.leads.trend ?? [], { leads: 0, welcome: 0 })
    if (lt.length) leadBody += card(`New leads per ${grainWord}`, chartSvg(lt.map((r) => periodLabel(r.period, d.grain)), [{ name: "New leads", color: C.blue, values: lt.map((r) => r.leads) }, { name: "Got a welcome message", color: C.good, values: lt.map((r) => r.welcome) }]))
    const srcRows = (d.leads.sources ?? []).map((r: any) => ({ label: cleanLabel(r.label), value: r.leads, color: r.label === "(unknown: overwritten by status)" ? "#c8d0da" : C.blue }))
    const stRows = (d.leads.statuses ?? []).map((r: any) => ({ label: cleanLabel(r.label), value: r.leads, color: r.label === "Qualified" ? C.good : r.label === "Unqualified" ? C.bad : C.violet }))
    leadBody += `<div class="two">${card("Leads by source", hbars(srcRows.slice(0, 10), l.leads), `${p0(100 - (l.source_known_pct ?? 0))} of leads have no recorded source (grey): the real source was overwritten. Treat the source split as a guide only.`)}${card("Leads by status", hbars(stRows.slice(0, 10), l.leads), "Where each lead stands in Salesforce today.")}</div>`
    const lo = fold(d.leads.owners ?? [], 12, "owner", ["leads", "welcome", "followup_24h", "qualified"], "All other owners")
    if (lo.length) leadBody += card("Leads by owner", table([{ t: "Owner" }, { t: "Leads", num: true }, { t: "Welcome", num: true }, { t: "24h follow-up", num: true }, { t: "Qualified", num: true }],
      lo.map((r: any) => [esc(cleanLabel(r.owner)), n0(r.leads), p1(share(r.welcome, r.leads)), p1(share(r.followup_24h, r.leads)), n0(r.qualified)]), { foot: ["All owners", n0(l.leads), p1(l.welcome_pct), p1(l.followup_24h_pct), n0((d.leads.statuses ?? []).find((s: any) => s.label === "Qualified")?.leads ?? 0)] }))
  }

  // ---- opportunities (Salesforce style) ----
  let oppBody = ""
  if (!o) oppBody = note("The opportunity figures could not be loaded for this report.", "warn")
  else {
    oppBody += `<div class="tiles t4">${[
      tile("Opportunities", n0(o.opportunities), "created in this period", op && opRaw ? chip(o.opportunities, opRaw.opportunities, "rel", "none") : ""),
      tile("Still open", n0(o.open), `${p1(share(o.open, o.opportunities))} of all`),
      tile("Deals won", n0(o.won), `of ${n0(closed)} closed deals`, "", "good"),
      tile("Deals lost", n0(o.lost), `${p1(share(o.lost, closed))} of closed deals`, "", "bad"),
      tile("Win rate", p1(o.win_rate), "won ÷ (won + lost)", op ? chip(o.win_rate, op.win_rate, "pp", "up") : "", "good"),
      tile("Still at New", n0(o.new_total), `${p1(share(o.new_total, o.opportunities))} of all`),
      tile("Gone quiet", n0(o.stale_new), `at New for over ${o.staleDays} days`, "", o.stale_new > 0 ? "warn" : ""),
      tile("Status flags disagree", n0(o.flag_mismatch), "won/lost flag differs from status (status is used)", "", o.flag_mismatch > 0 ? "warn" : ""),
    ].join("")}</div>`
    const ot: any[] = fillDays(d.opps.trend ?? [], { opportunities: 0, won: 0, lost: 0 })
    if (ot.length) oppBody += card(`Opportunities per ${grainWord}`, chartSvg(ot.map((r) => periodLabel(r.period, d.grain)), [{ name: "Opened", color: C.blue, values: ot.map((r) => r.opportunities) }, { name: "Won", color: C.good, values: ot.map((r) => r.won) }, { name: "Lost", color: C.bad, values: ot.map((r) => r.lost) }]), "Grouped by the day the opportunity was created, so a deal won later is counted in the period it opened.")
    const stages = (d.opps.statuses ?? []).map((r: any) => ({ label: r.label, value: r.opportunities, color: /won/i.test(r.label) ? C.good : /lost/i.test(r.label) ? C.bad : C.blue }))
    const ag = d.opps.aging ?? []
    const agTotal = ag.reduce((s: number, r: any) => s + r.opportunities, 0)
    oppBody += `<div class="two">${card("Pipeline by stage", hbars(stages, o.opportunities), "How many opportunities from this period sit at each stage today.")}${card("How long opportunities have sat at New", hbars(ag.map((r: any, i: number) => ({ label: r.bucket, value: r.opportunities, color: [C.good, C.brand2, C.warn, C.bad][i] ?? C.grey })), agTotal), "All opportunities still at New as of today, whatever date they were created. Not limited to the period above.")}</div>`
    const oo = fold(d.opps.owners ?? [], 12, "owner", ["opportunities", "won", "lost", "new_total", "stale_new"], "All other owners")
    if (oo.length) oppBody += card("Opportunities by owner", table([{ t: "Owner" }, { t: "Opened", num: true }, { t: "Won", num: true }, { t: "Lost", num: true }, { t: "Win rate", num: true }, { t: "Gone quiet", num: true }],
      oo.map((r: any) => [esc(cleanLabel(r.owner)), n0(r.opportunities), n0(r.won), n0(r.lost), p1(share(r.won, r.won + r.lost)), n0(r.stale_new)]), { foot: ["All owners", n0(o.opportunities), n0(o.won), n0(o.lost), p1(o.win_rate), n0(o.stale_new)] }), "Win rate is won ÷ (won + lost); open deals are not counted.")
  }

  // Only a real problem is shown on page 1: a part of the report that could not be loaded, or an accuracy check that failed.
  // (The checks themselves always run; when all pass nothing is printed.)
  const problems: string[] = []
  for (const e of d.errors ?? []) problems.push(`A part of this report could not be loaded (${esc(e.name)}), so some numbers are missing.`)
  const passed = d.checks.filter((c: any) => c.pass).length
  for (const c of d.checks.filter((c: any) => !c.pass)) problems.push(`An internal check did not add up: ${esc(c.label)} (expected ${esc(String(c.expected))}, found ${esc(String(c.actual))}). Treat the related numbers with care.`)

  const glossary = [
    ["Messages tracked", "WhatsApp template messages whose outcome we can follow. Each person counts once per template (the first message). Repeat sends to the same person are left out of the rates."],
    ["Delivered, Read, Replied", "Each is a part of the one before. Replied is part of Read, and Read is part of Delivered (a read message was also delivered). Delivered + Failed + No confirmation = Messages tracked. Delivered and read are minimums, because WhatsApp does not always report them."],
    ["Replied", "The customer answered that message."],
    ["Failed to send", "WhatsApp refused the message. The reason (when recorded) is shown under “Why messages failed”."],
    ["Conversation (chat)", "One thread with a customer. “Missed” means the customer wrote, the 24-hour window ended, and nobody on the team replied (WATI's definition)."],
    ["Lead, Opportunity", "Records in Salesforce. A lead becomes an opportunity when a salesperson takes it on."],
    ["Win rate", "Deals won divided by deals won plus lost. Open deals are not counted."],
    ["Gone quiet", "An opportunity still at status New after more than 30 days."],
    ["Dates", "WhatsApp messages are dated by the first send to that person for that template. Leads and opportunities by the day they were created. Times are India time."],
    ["Previous period", `The ${per.days} days just before this report (${range(prv.from, prv.to)}). Arrows show the change; they are left out when the earlier period is too small or has missing data.`],
  ]

  const filters = [
    d.filters.templates.length ? `Templates: ${d.filters.templates.map(esc).join(", ")}` : "", d.filters.sources.length ? `Lead sources: ${d.filters.sources.map((s: string) => esc(cleanLabel(s))).join(", ")}` : "", d.filters.owners.length ? `Owners: ${d.filters.owners.map(esc).join(", ")}` : "",
  ].filter(Boolean)
  const generated = new Date(d.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
  const fileName = `Aquant-report_${per.from}_to_${per.to}.html`

  const lpv0 = (a: number | null, b: number | undefined) => (lp ? chip(a, b, "pp", "up") : "")
  // ---- at a glance: score cards, one row per area ----
  const gt = (label: string, value: string, sub = "", extra = "", tone = "") => tile(label, value, sub, extra, tone)
  const row = (title: string, cards: string[]) => `<h3 class="fh">${esc(title)}</h3><div class="tiles t5 glance">${cards.join("")}</div>`
  const rows: string[] = []
  if (m) {
    rows.push(row("WhatsApp messages", [
      gt("Messages tracked", n0(m.measured), "first sends we can follow"),
      gt("Delivered", n0(m.delivered_adj), `${p1(m.delivered_pct)} of tracked`, mp ? chip(m.delivered_pct, mp.delivered_pct, "pp", "up") : ""),
      gt("Read", n0(m.read_adj), `${p1(m.read_pct)} of tracked`, mp ? chip(m.read_pct, mp.read_pct, "pp", "up") : ""),
      gt("Replied", n0(m.replied), `${p1(m.replied_pct)} of tracked`, mp ? chip(m.replied_pct, mp.replied_pct, "pp", "up") : "", "good"),
      gt("Failed to send", n0(m.failed), `${p1(m.failed_pct)} of tracked`, mp ? chip(m.failed_pct, mp.failed_pct, "pp", "down") : "", m.failed_pct > 5 ? "bad" : ""),
    ]))
  }
  if (ws?.available) {
    const p = ws.period
    rows.push(row("Conversations (WATI)", [
      gt("Total conversations", n0(wTotal), "open + pending + solved + expired"),
      gt("Solved", n0(p.solved), `${p0(share(p.solved, wTotal))} of total`, "", "good"),
      gt("Expired", n0(p.expired), `${p0(share(p.expired, wTotal))} of total`),
      gt("Missed", n0(p.missed), `${p0(share(p.missed, p.expired))} of expired`, "", p.missed > 0 ? "bad" : ""),
      gt("Open now", n0(ws.live.open), "right now"),
    ]))
  } else if (cc) {
    rows.push(row("Conversations (our chat records)", [
      gt("Chats with messages", n0(cc.chats), "chat threads"),
      gt("Customer wrote in", n0(cc.customer_chats), `${p0(cc.customer_pct)} of chats`),
      gt("Reply speed", cc.fr_median == null ? "—" : mins(cc.fr_median), "typical team reply"),
      gt("Answered within an hour", p0(cc.within_hour_pct), `${n0(cc.within_hour)} of ${n0(cc.customer_chats)} chats`),
    ]))
  }
  if (l) rows.push(row("Leads (Salesforce)", [
    gt("Leads", n0(l.leads), "created in this period", lp ? chip(l.leads, lp.leads, "rel", "none") : ""),
    gt("Welcome message", p1(l.welcome_pct), `${n0(l.welcome)} leads`, lpv0(l.welcome_pct, lp?.welcome_pct)),
    gt("24-hour follow-up", p1(l.followup_24h_pct), `${n0(l.followup_24h)} leads`, lpv0(l.followup_24h_pct, lp?.followup_24h_pct), l.followup_24h_pct < 50 ? "warn" : ""),
    gt("1st task follow-up", p1(l.task1_pct), `${n0(l.task1)} leads`, lpv0(l.task1_pct, lp?.task1_pct)),
    gt("Unique people", n0(l.people), "different phone numbers"),
  ]))
  if (o) rows.push(row("Opportunities (Salesforce)", [
    gt("Opportunities", n0(o.opportunities), "created in this period", op && opRaw ? chip(o.opportunities, opRaw.opportunities, "rel", "none") : ""),
    gt("Deals won", n0(o.won), `of ${n0(closed)} closed deals`, "", "good"),
    gt("Deals lost", n0(o.lost), `${p1(share(o.lost, closed))} of closed deals`, "", "bad"),
    gt("Win rate", p1(o.win_rate), "won ÷ (won + lost)", op ? chip(o.win_rate, op.win_rate, "pp", "up") : "", "good"),
    gt("Still open", n0(o.open), `${p1(share(o.open, o.opportunities))} of all`),
  ]))
  const glance = rows.join("")

  const body = [
    `<header class="cover"><div class="brand"><span class="logo">A</span><div><div class="bn">Aquant India</div><div class="bs">WhatsApp and sales performance report</div></div></div>
      <h1>${esc(range(per.from, per.to))}</h1>
      <div class="meta"><span>${per.days} ${per.days === 1 ? "day" : "days"}</span><span>Compared with ${esc(range(prv.from, prv.to))}</span><span>Generated ${esc(generated)} (India time)</span><span>${d.mode === "live" ? "Live database" : `Snapshot as of ${esc(dLong(d.asOf))}`}</span></div>
      ${filters.length ? `<div class="filters"><b>Filters applied.</b> ${filters.join(" · ")}. <i>Templates narrow the WhatsApp message figures only; leads, opportunities and chats are not tied to a template.</i></div>` : ""}</header>`,
    section(0, "At a glance", "", glance
      + (problems.length ? problems.map((t) => note(`<b>Please note.</b> ${t}`, "warn")).join("") : "")),
    section(1, "Conversations", `Who wrote to us and how those chats ended. Modelled on WATI's Inbox Analytics: status tiles, how conversations ended, and the team.`, chatsBody),
    section(2, "WhatsApp messages", `The template messages we sent and what happened to them. Modelled on WATI's message insights: sent, delivered, read, replied and failed, with the funnel and trends.`, msgBody),
    section(3, "Leads", `New leads from Salesforce and how well we followed up. Laid out like a Salesforce lead dashboard: headline numbers, then by source, status and owner.`, leadBody),
    section(4, "Opportunities", `Deals from Salesforce: how many opened, how many closed, and where the rest are stuck. Laid out like a Salesforce opportunity dashboard: pipeline by stage, win rate and owner.`, oppBody),
    section(5, "How to read this report", "", `<dl class="gl">${glossary.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`),
    `<footer>Aquant India · generated ${esc(generated)} · Totals only: this file holds no phone numbers, customer names or message text.</footer>`,
  ].join("\n")

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="report-file" content="${esc(fileName)}"><title>Aquant report · ${esc(range(per.from, per.to))}</title><style>${CSS}</style></head><body>
<div class="bar noprint"><span>Aquant report · ${esc(range(per.from, per.to))}<small class="tip">For a PDF: in the print window choose “Save as PDF”, set Margins to <b>Default</b> and tick <b>Background graphics</b>.</small></span><div><button type="button" onclick="dl()">Download file</button><button type="button" class="pri" onclick="window.print()">Save as PDF / Print</button></div></div>
<main>${body}</main>
<script>function dl(){var m=document.querySelector('meta[name=report-file]');var b=new Blob(['<!doctype html>\\n'+document.documentElement.outerHTML],{type:'text/html'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=m?m.content:'report.html';document.body.appendChild(a);a.click();a.remove()}</script>
</body></html>`
}

function hourChart(rows: { label: string; rate: number | null; n: number }[], best: number | null): string {
  const W = 460, H = 220, L = 38, R = 6, T = 12, B = 28, iw = W - L - R, ih = H - T - B, band = iw / 24
  const mx = Math.max(5, Math.ceil(Math.max(...rows.map((r) => r.rate ?? 0)) * 1.2 / 2) * 2)
  let g = ""
  for (let i = 0; i <= 4; i++) { const v = (mx * i) / 4, yy = T + ih - (ih * i) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${C.line}"/><text x="${L - 6}" y="${yy + 3.5}" text-anchor="end" class="ax">${Math.round(v)}%</text>` }
  rows.forEach((r, i) => {
    const x = L + i * band + band * 0.14, w = band * 0.72
    if (r.rate == null) g += `<rect x="${x.toFixed(1)}" y="${T + ih - 2}" width="${w.toFixed(1)}" height="2" fill="${C.line}"><title>${clock(i)}: ${n0(r.n)} messages, too few for a rate</title></rect>`
    else { const h = (r.rate / mx) * ih; g += `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${i === best ? C.good : "#8fc1c3"}" rx="2"><title>${clock(i)}: ${p1(r.rate)} replied (${n0(r.n)} messages)</title></rect>${r.rate > 0 ? `<text x="${(x + w / 2).toFixed(1)}" y="${(T + ih - h - 2.5).toFixed(1)}" text-anchor="middle" class="vl sm">${(Math.round(r.rate * 10) / 10).toString()}</text>` : ""}` }
    if (i % 3 === 0) g += `<text x="${(L + i * band + band / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" class="ax">${clock(i).replace(" ", "")}</text>`
  })
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Reply rate by hour sent">${g}</svg>`
}

function chatTeam(d: ReportData): string {
  const ops = d.chats.operators
  if (!ops?.available || !ops.rows?.length) return card("Team", `<p class="empty">No team data yet.</p>`)
  const rows = (ops.rows as any[]).slice(0, 10)
  return card("Team", table([{ t: "Team member" }, { t: "Assigned", num: true }, { t: "Solved", num: true }, { t: "Missed", num: true }, { t: "Open", num: true }],
    rows.map((r) => [`${esc((r.operator ?? "").trim() || "Unknown")}${r.is_bot ? ` <span class="tag">bot</span>` : ""}`, n0(r.assigned), n0(r.solved), `<span class="${r.missed > 0 ? "bad-t" : ""}">${n0(r.missed)}</span>`, n0(r.open)]), { cls: "nm" }),
    `Conversations by owner in WATI.${(ops.rows as any[]).length > 10 ? ` ${(ops.rows as any[]).length - 10} more team ${(ops.rows as any[]).length - 10 === 1 ? "member is" : "members are"} not shown.` : ""} Missed = the window closed with no reply.`)
}

const CSS = `
:root{--ink:${C.ink};--muted:${C.muted};--line:${C.line};--soft:${C.soft};--brand:${C.brand};--good:${C.good};--bad:${C.bad};--warn:${C.warn}}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#eef1f5;color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:18px 18px 40px}
.bar{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 18px;background:#fff;border-bottom:1px solid var(--line);font-weight:600}
.bar button{font:inherit;font-weight:600;padding:7px 14px;border:1px solid #c9d2dc;background:#fff;border-radius:8px;cursor:pointer;margin-left:8px}.bar button.pri{background:var(--brand);border-color:var(--brand);color:#fff}
.cover{background:linear-gradient(135deg,#0b5f63,#14868a);color:#fff;border-radius:16px;padding:26px 28px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}.logo{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:#fff;color:var(--brand);font-weight:800;font-size:20px}
.bn{font-weight:700;font-size:16px}.bs{opacity:.85;font-size:13px}
.cover h1{margin:18px 0 8px;font-size:30px;letter-spacing:-.4px;line-height:1.15}
.meta{display:flex;flex-wrap:wrap;gap:8px}.meta span{background:rgba(255,255,255,.16);border-radius:99px;padding:3px 11px;font-size:12.5px}
.filters{margin-top:12px;font-size:12.5px;background:rgba(0,0,0,.14);border-radius:8px;padding:8px 10px}
.sec{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}
.sec h2{margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px;break-after:avoid}
.num{display:inline-grid;place-items:center;min-width:26px;height:26px;border-radius:8px;background:var(--brand);color:#fff;font-size:13px}
.intro{margin:0 0 14px;color:var(--muted)}
h3{margin:0 0 2px;font-size:14.5px;break-after:avoid}.fh{margin:16px 0 8px;font-size:15px}
.sub{margin:0 0 10px;color:var(--muted);font-size:12.5px}
.tiles{display:grid;gap:10px;margin:12px 0}.t3{grid-template-columns:repeat(3,1fr)}.t4{grid-template-columns:repeat(4,1fr)}.t2{grid-template-columns:repeat(2,1fr)}.t5{grid-template-columns:repeat(5,1fr)}.grp{margin:12px 0 -4px;font-size:12px;font-weight:600;color:var(--muted)}
.tile{border:1px solid var(--line);border-radius:12px;padding:11px 13px;background:#fff;border-left:4px solid #b8c4d1;break-inside:avoid}
.tile.good{border-left-color:var(--good)}.tile.bad{border-left-color:var(--bad)}.tile.warn{border-left-color:var(--warn)}
.tl{font-size:12px;color:var(--muted);font-weight:600}.tv{font-size:24px;font-weight:700;letter-spacing:-.4px;line-height:1.2;margin-top:2px}.tv small{font-size:13px;color:var(--muted);font-weight:600}
.ts{font-size:11.5px;color:var(--muted);margin-top:2px;line-height:1.35}.tc{margin-top:5px}.vs{font-size:11px;color:var(--muted)}
.glance .tile{border-left-width:0;border-top:4px solid var(--brand);background:var(--soft)}.glance .tv{font-size:24px}.glance .ts{font-size:11px}.dq.small{font-size:12px;color:#3b4656}
.chip{display:inline-block;border-radius:99px;padding:1px 8px;font-size:11.5px;font-weight:700}.chip.up{background:#e1f5ea;color:#13774a}.chip.down{background:#fde7e7;color:#b52f2f}.chip.flat{background:#eceff3;color:var(--muted)}
.finds{list-style:none;margin:0;padding:0;display:grid;gap:8px}.finds li{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-radius:10px;background:var(--soft);break-inside:avoid}
.dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--brand2)}.finds .good .dot{background:var(--good)}.finds .watch .dot{background:var(--warn)}.finds .bad .dot{background:var(--bad)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0;align-items:stretch}.two>.card{margin:0}
.card{border:1px solid var(--line);border-radius:12px;padding:14px 15px;margin:14px 0;break-inside:avoid}
.note{border-radius:10px;padding:9px 12px;margin:10px 0;font-size:13px}.note.info{background:#e9f2fb;border:1px solid #cfe1f3}.note.warn{background:#fff4de;border:1px solid #f1dcae}
.empty{color:var(--muted);font-style:italic;margin:6px 0}
.tw{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12.8px}th{text-align:center;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;border-bottom:2px solid var(--line);padding:6px 8px}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;text-align:center}tr{break-inside:avoid}.r{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}tfoot td{font-weight:700;border-top:2px solid var(--line);border-bottom:0;background:var(--soft)}
.tag{font-size:10.5px;background:#eceff3;color:var(--muted);border-radius:6px;padding:0 6px;margin-left:4px;white-space:nowrap}.code{font-family:Consolas,monospace;font-size:11px;background:#eceff3;border-radius:5px;padding:0 5px;color:var(--muted)}
.bad-t{color:var(--bad);font-weight:700}.ok{color:var(--good);font-weight:700}
.chart{width:100%;height:auto;display:block}.ax{font-size:10.5px;fill:#6a7686}.vl{font-size:9.5px;font-weight:600;fill:#2f3b4a;paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-linejoin:round}.vl.sm{font-size:7.5px;stroke-width:2px}.vl.lv{font-weight:700}.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px}
.hb{display:grid;gap:7px}.hr{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:8px;align-items:center}.hl{font-size:12.8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar{height:11px;background:var(--soft);border-radius:99px;overflow:hidden}.hbar span{display:block;height:100%;border-radius:99px}.hv{font-size:12.5px;white-space:nowrap;text-align:right}.hv i{font-style:normal;color:var(--muted);margin-left:6px;font-size:11.5px}.hn{grid-column:2/4;font-size:11.5px;color:var(--muted)}
.flow{display:block;width:100%;height:auto}.fl{font-size:12px;font-weight:600}.fv{font-size:17px;font-weight:700}.fs{font-size:10px;opacity:.92}
.fn{display:grid;gap:3px}.fr{display:grid;grid-template-columns:110px 1fr auto;gap:10px;align-items:center}.fl{font-weight:600;font-size:13px}.fb{height:24px;background:var(--soft);border-radius:7px;overflow:hidden}.fb span{display:block;height:100%;border-radius:7px}.fv{white-space:nowrap;font-size:13px;text-align:right}.fv i{font-style:normal;color:var(--muted);margin-left:6px;font-size:11.5px}
.fd{margin-left:120px;font-size:11.5px;color:var(--bad);padding:1px 0}.fd span{color:var(--muted)}
.donut{display:flex;gap:14px;align-items:center}.donut svg{width:150px;flex:none}.dc{font-size:22px;font-weight:700;fill:var(--ink)}.ds{font-size:9px;fill:#6a7686}
.donut ul{list-style:none;margin:0;padding:0;display:grid;gap:5px;flex:1;font-size:12.8px}.donut li{display:grid;grid-template-columns:12px 1fr auto 40px;gap:6px;align-items:center}.donut li i{width:10px;height:10px;border-radius:3px}.donut li em{font-style:normal;color:var(--muted);text-align:right}
.fb3{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0 12px}.fbx{border:1px solid var(--line);border-top:4px solid;border-radius:10px;padding:9px 11px;break-inside:avoid}.fbn{font-size:22px;font-weight:700}.fbn small{font-size:12.5px;color:var(--muted)}.fbt{font-weight:600;font-size:13px}.fbd{font-size:11.5px;color:var(--muted);margin-top:3px}
.dq{margin:0;padding-left:20px;display:grid;gap:8px}.gl{display:grid;grid-template-columns:170px 1fr;gap:6px 16px;margin:0}.gl dt{font-weight:700}.gl dd{margin:0;color:var(--muted)}
footer{text-align:center;color:var(--muted);font-size:12px;padding:10px}
@media screen and (max-width:760px){.t3,.t4,.t5{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}.cover h1{font-size:24px}.gl{grid-template-columns:1fr}}
.tip{display:block;font-weight:400;font-size:12px;color:var(--muted);margin-top:1px}
.chk td{font-size:12px}.two.wide-r{grid-template-columns:5fr 7fr}.two.wide-r .donut{flex-direction:column;align-items:stretch}.two.wide-r .donut svg{width:140px;margin:0 auto}.nm td:first-child{white-space:nowrap}
@media print{
@page{size:A4;margin:11mm 11mm 15mm;@bottom-left{content:"Aquant India · WhatsApp and sales report";font:9px "Segoe UI",Arial,sans-serif;color:#6a7686}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px "Segoe UI",Arial,sans-serif;color:#6a7686}}
body{background:#fff;font-size:12.5px;line-height:1.42}
.noprint{display:none!important}
main{max-width:none;padding:0 3mm}
.cover{border-radius:10px;padding:14px 18px;margin-bottom:12px}.cover h1{font-size:27px;margin:12px 0 6px}
.sec{border:0;border-radius:0;padding:0;margin:0}
.sec h2{border-bottom:2px solid var(--brand);padding-bottom:6px;margin-bottom:6px;font-size:19px}
.intro{margin-bottom:8px}
#s1,#s5{break-before:page}
#s2,#s3,#s4,#s6{margin-top:18px}
.keep{break-inside:avoid}
.sec h2,.intro,h3,.sub{break-after:avoid}
.tiles,.two,.fb3,.card,.tile,.finds li,.fbx,.note,.donut,.fn{break-inside:avoid}
.card.split{break-inside:auto}.tw{overflow:visible}thead{display:table-header-group}tr{break-inside:avoid}
.tiles{margin:8px 0;gap:7px}.t5 .tv{font-size:22px}.two{gap:9px;margin:9px 0}.card{padding:11px 13px;margin:9px 0}.two>.card{margin:0}
.tile{padding:8px 11px}.tv{font-size:21px}.glance .tv{font-size:26px}
table{font-size:12px}th,td{padding:4px 7px}
.finds{gap:6px}.finds li{padding:7px 11px}.glance.tiles{margin:6px 0}.glance .tile{padding:7px 10px}.fh{margin:11px 0 5px}.dq.small{gap:3px}
.gl{gap:4px 14px;font-size:12px}.dq{gap:5px}.dq li{break-inside:avoid}
.chk th,.chk td{padding:2px 7px;font-size:11px;line-height:1.3}
.sub{margin-bottom:7px}
footer{padding-top:12px;font-size:10.5px}
}
`
