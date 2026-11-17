import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { format, parseISO, subDays } from "date-fns"
import { useApi } from "@/lib/api"

export type Meta = {
  mode: "csv" | "live"
  asOf: string
  messages: { min: string; max: string }
  leads: { min: string; max: string }
  opportunities: { min: string; max: string }
  templates: string[]
  sources: string[]
  owners: string[]
  leadStatuses: string[]
  oppStatuses: string[]
  staleDays: number
  canReveal: boolean
}

export type Filters = { from?: string; to?: string; templates: string[]; sources: string[]; owners: string[]; statuses: string[] }
const KEYS = ["templates", "sources", "owners", "statuses"] as const
const split = (v: string | null) => (v ? v.split("|").filter(Boolean) : [])

type Ctx = {
  meta?: Meta
  metaError?: string
  filters: Filters
  params: Record<string, string>
  set: (patch: Partial<Filters>) => void
  reset: () => void
  active: number
}
const FiltersCtx = createContext<Ctx | null>(null)

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [sp, setSp] = useSearchParams()
  const { data: meta, error: metaError } = useApi<Meta>("meta")

  // Every page opens on YESTERDAY unless the address says otherwise. "All time" is an explicit choice, kept as range=all (no dates alone means "not chosen yet").
  const yesterday = useMemo(() => (meta?.asOf ? format(subDays(parseISO(meta.asOf), 1), "yyyy-MM-dd") : undefined), [meta?.asOf])
  const filters: Filters = useMemo(() => {
    let from = sp.get("from") || undefined, to = sp.get("to") || undefined
    if (!from && !to && sp.get("range") !== "all" && yesterday) { from = yesterday; to = yesterday }
    return { from, to, templates: split(sp.get("templates")), sources: split(sp.get("sources")), owners: split(sp.get("owners")), statuses: split(sp.get("statuses")) }
  }, [sp, yesterday])
  const set = useCallback((patch: Partial<Filters>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev)
      if ("from" in patch || "to" in patch) {
        patch.from ? next.set("from", patch.from) : next.delete("from")
        patch.to ? next.set("to", patch.to) : next.delete("to")
        if (patch.from || patch.to) next.delete("range"); else next.set("range", "all")   // no dates picked = All time, on purpose
      }
      for (const [k, v] of Object.entries(patch)) {
        if (Array.isArray(v)) { v.length ? next.set(k, v.join("|")) : next.delete(k) }
      }
      return next
    }, { replace: true })
  }, [setSp])
  const reset = useCallback(() => setSp((prev) => { const n = new URLSearchParams(prev); for (const k of ["from", "to", "range", ...KEYS]) n.delete(k); return n }, { replace: true }), [setSp])

  const params = useMemo(() => {
    const p: Record<string, string> = {}
    if (filters.from) p.from = filters.from
    if (filters.to) p.to = filters.to
    for (const k of KEYS) if (filters[k].length) p[k] = filters[k].join("|")
    return p
  }, [filters])
  const isYesterday = !!yesterday && filters.from === yesterday && filters.to === yesterday
  const active = (isYesterday ? 0 : 1) + KEYS.filter((k) => filters[k].length).length   // yesterday is the starting point, so it does not count as a filter you set

  return <FiltersCtx.Provider value={{ meta, metaError, filters, params, set, reset, active }}>{children}</FiltersCtx.Provider>
}

export function useFilters() {
  const c = useContext(FiltersCtx)
  if (!c) throw new Error("useFilters outside provider")
  return c
}
