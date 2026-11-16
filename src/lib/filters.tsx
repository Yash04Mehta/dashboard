import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
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

  const filters: Filters = useMemo(
    () => ({ from: sp.get("from") || undefined, to: sp.get("to") || undefined, templates: split(sp.get("templates")), sources: split(sp.get("sources")), owners: split(sp.get("owners")), statuses: split(sp.get("statuses")) }),
    [sp],
  )
  const set = useCallback((patch: Partial<Filters>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        if (k === "from" || k === "to") { v ? next.set(k, v as string) : next.delete(k) }
        else if (Array.isArray(v)) { v.length ? next.set(k, v.join("|")) : next.delete(k) }
      }
      return next
    }, { replace: true })
  }, [setSp])
  const reset = useCallback(() => setSp((prev) => { const n = new URLSearchParams(prev); for (const k of ["from", "to", ...KEYS]) n.delete(k); return n }, { replace: true }), [setSp])

  const params = useMemo(() => {
    const p: Record<string, string> = {}
    if (filters.from) p.from = filters.from
    if (filters.to) p.to = filters.to
    for (const k of KEYS) if (filters[k].length) p[k] = filters[k].join("|")
    return p
  }, [filters])
  const active = (filters.from || filters.to ? 1 : 0) + KEYS.filter((k) => filters[k].length).length

  return <FiltersCtx.Provider value={{ meta, metaError, filters, params, set, reset, active }}>{children}</FiltersCtx.Provider>
}

export function useFilters() {
  const c = useContext(FiltersCtx)
  if (!c) throw new Error("useFilters outside provider")
  return c
}
