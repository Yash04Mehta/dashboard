export const CATS = ["MARKETING", "UTILITY", "AUTHENTICATION", "SERVICE"] as const
export const LABEL: Record<string, string> = { MARKETING: "Marketing", UTILITY: "Utility", AUTHENTICATION: "Authentication", SERVICE: "Service" }
export const COLOR: Record<string, string> = { MARKETING: "var(--c3)", UTILITY: "var(--c1)", AUTHENTICATION: "var(--c2)", SERVICE: "var(--c6)" }

/**
 * Prices every template from a costs/summary answer. Shared by the Costs page (which adds what-if prices and a free-utility share)
 * and by the template panel on Messages v1 (which uses the plain prices).
 * `over` = typed what-if price per category ("" or missing = use the rate card), `f` = share of utility messages that cost nothing (0 to 1).
 */
export function priceTemplates(d: any, over: Record<string, string> = {}, f = 0) {
  const ovr = (c: string, base: number) => { const v = over[c]; const n = v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) && n >= 0 ? n : base }
  const nowRate = (c: string) => {
    const list = d.rates.filter((r: any) => r.category === c)
    const r = [...list].reverse().find((x: any) => x.effective_from <= d.asOf) ?? list[0]
    return ovr(c, r ? r.price : 0)
  }
  const rateNow: Record<string, number> = Object.fromEntries(CATS.map((c) => [c, nowRate(c)]))
  const byT = new Map<string, any>(d.templates.map((t: any) => [t.template_name, { ...t, cost: 0, base: 0 }]))
  const byM = new Map<string, Record<string, number>>()
  const byC: Record<string, number> = {}
  let total = 0, base = 0
  for (const l of d.lines) {
    const c = l.units * ovr(l.category, l.rate) * (l.category === "UTILITY" ? 1 - f : 1)
    total += c; base += l.units * l.rate
    const t = byT.get(l.template); t.cost += c; t.base += l.units * l.rate
    const mm = byM.get(l.month) ?? {}; mm[l.category] = (mm[l.category] ?? 0) + c; byM.set(l.month, mm)
    byC[l.category] = (byC[l.category] ?? 0) + c
  }
  const rows = [...byT.values()].map((t) => {
    const ifUtility = t.category === "MARKETING" ? t.units * rateNow.UTILITY * (1 - f) : null
    const w = t.watiCategory && t.watiCategory !== t.category && !t.changed && !t.assumed ? t.watiCategory : null   // WATI reports a different category than the one used for pricing
    const watiDiff = w ? t.cost - t.units * rateNow[w] * (w === "UTILITY" ? 1 - f : 1) : null
    return { ...t, share: total ? (100 * t.cost) / total : 0, perMsg: t.units ? t.cost / t.units : null, perReply: t.replied ? t.cost / t.replied : null, perRead: t.read ? t.cost / t.read : null,
      ifUtility, save: ifUtility == null ? null : Math.max(0, t.cost - ifUtility), watiDiff }
  })
  return { rateNow, rows, byM, byC, total, base }
}
