import { format, parseISO } from "date-fns"

export const nf = new Intl.NumberFormat("en-US")
export const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(v))
export const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${v.toFixed(digits)}%`)
export const one = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1))
export const compact = (v: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)

export function day(s?: string | null) {
  if (!s) return "—"
  try { return format(parseISO(s.slice(0, 10)), "d MMM yyyy") } catch { return s }
}
export function dayShort(s?: string | null) {
  if (!s) return "—"
  try { return format(parseISO(s.slice(0, 10)), "d MMM") } catch { return s }
}
export function dateTime(s?: string | null) {
  if (!s) return "—"
  try { return format(parseISO(s), "d MMM yyyy, HH:mm") } catch { return s }
}
export function periodLabel(s: string, grain: string) {
  try {
    const d = parseISO(s)
    if (grain === "month") return format(d, "MMM yy")
    if (grain === "week") return format(d, "d MMM")
    return format(d, "d MMM")
  } catch { return s }
}
/** change in percentage points between two rates, or null */
export const ppDelta = (a?: number | null, b?: number | null) => (a == null || b == null ? null : Math.round((a - b) * 10) / 10)
export const relDelta = (a?: number | null, b?: number | null) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10)
/** minutes as a short human duration: "12 min", "3.4 hours", "2.1 days" */
export function duration(min: number | null | undefined) {
  if (min == null) return "—"
  if (min < 1) return "under a minute"
  if (min < 60) return `${Math.round(min)} min`
  const unit = (v: number, one: string) => { const s = v.toFixed(1).replace(/\.0$/, ""); return `${s} ${s === "1" ? one : one + "s"}` }
  if (min < 1440) return unit(min / 60, "hour")
  return unit(min / 1440, "day")
}
export const hourLabel = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`)

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" }
const sym = (cur: string) => SYMBOL[cur] ?? cur + " "
/** an amount of money; small amounts keep paise, big ones are whole rupees */
export const money = (v: number | null | undefined, cur = "INR") => (v == null ? "—" : `${v < 0 ? "−" : ""}${sym(cur)}${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`)
/** a price per message, which is a fraction of a rupee */
export const price = (v: number, cur = "INR") => `${sym(cur)}${v.toLocaleString("en-IN", { maximumFractionDigits: 4 })}`
export const moneyCompact = (v: number, cur = "INR") => `${sym(cur)}${new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`
