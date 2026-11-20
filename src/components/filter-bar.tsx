import { useMemo, useState } from "react"
import { endOfMonth, format, parseISO, startOfMonth, subDays, subMonths } from "date-fns"
import { CalendarDays, ChevronDown, Eye, EyeOff, RotateCcw } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useReveal } from "@/lib/reveal"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { day } from "@/lib/format"

const iso = (d: Date) => format(d, "yyyy-MM-dd")

/** `counts` (optional) shows a number beside each option, e.g. how many messages each template sent. */
export function MultiSelect({ label, options, value, onChange, counts }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; counts?: Record<string, number> }) {
  const [q, setQ] = useState("")
  // ticked options first, then the rest; with counts, each group is biggest first (ties keep their original order)
  const shown = useMemo(() => {
    const clean = options.filter((o): o is string => typeof o === "string" && o.trim() !== "")   // a stray empty entry must never crash the page
    const idx = new Map(clean.map((o, i) => [o, i]))
    return clean.filter((o) => o.toLowerCase().includes(q.toLowerCase())).sort((x, y) =>
      Number(value.includes(y)) - Number(value.includes(x)) || (counts ? (counts[y] ?? 0) - (counts[x] ?? 0) : 0) || idx.get(x)! - idx.get(y)!)
  }, [options, q, value, counts])
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        {label}
        {value.length > 0 && <Badge variant="secondary" className="ml-1 px-1.5">{value.length}</Badge>}
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        {options.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label}`} />}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((o) => (
            <div key={o} role="option" aria-selected={value.includes(o)} tabIndex={0} onClick={() => toggle(o)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(o) } }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
              <Checkbox checked={value.includes(o)} tabIndex={-1} className="pointer-events-none" aria-hidden />
              <span className="truncate" title={o}>{o}</span>
              {counts && <span className="tnum ml-auto shrink-0 pl-2 text-xs text-muted-foreground" title="Messages sent in the selected dates">{(counts[o] ?? 0).toLocaleString("en-IN")}</span>}
            </div>
          ))}
          {!shown.length && <div className="px-2 py-3 text-sm text-muted-foreground">No match.</div>}
        </div>
        <div className="flex items-center justify-between border-t pt-2">
          <span className="text-xs text-muted-foreground">{value.length ? `${value.length} selected` : "All"}</span>
          <Button variant="ghost" size="xs" onClick={() => onChange([])} disabled={!value.length}>Clear</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DateRangeFilter() {
  const { meta, filters, set } = useFilters()
  const phone = useIsMobile()
  const asOf = meta?.asOf ?? iso(new Date())
  const selected: DateRange | undefined = filters.from ? { from: parseISO(filters.from), to: filters.to ? parseISO(filters.to) : undefined } : undefined
  const presets: { label: string; from?: string; to?: string }[] = [
    { label: "Today", from: asOf, to: asOf },
    { label: "Yesterday", from: iso(subDays(parseISO(asOf), 1)), to: iso(subDays(parseISO(asOf), 1)) },
    { label: "Last 7 days", from: iso(subDays(parseISO(asOf), 6)), to: asOf },
    { label: "This month", from: iso(startOfMonth(parseISO(asOf))), to: asOf },
    { label: "Last month", from: iso(startOfMonth(subMonths(parseISO(asOf), 1))), to: iso(endOfMonth(subMonths(parseISO(asOf), 1))) },
    { label: "This year", from: `${asOf.slice(0, 4)}-01-01`, to: asOf },
    { label: "All time" },
  ]
  // a chosen preset is named ("Yesterday"), anything else shows its dates ("17 Nov 2026" for one day)
  const named = presets.find((p) => p.from && p.from === filters.from && p.to === (filters.to ?? asOf))?.label
  const text = !filters.from ? "All time" : named ?? (filters.from === (filters.to ?? asOf) ? day(filters.from) : `${day(filters.from)} to ${day(filters.to ?? asOf)}`)
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <CalendarDays className="size-3.5" />
        {text}
        <ChevronDown className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-wrap gap-1 border-b p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
            {presets.map((p) => (
              <Button key={p.label} variant={(p.from ?? "") === (filters.from ?? "") && (p.to ?? "") === (filters.to ?? "") ? "secondary" : "ghost"} size="sm" className="justify-start" onClick={() => set({ from: p.from, to: p.to })}>{p.label}</Button>
            ))}
          </div>
          <Calendar
            mode="range"
            numberOfMonths={phone ? 1 : 2}
            defaultMonth={startOfMonth(subMonths(parseISO(asOf), phone ? 0 : 1))}   // always opens on the two latest months (today: Oct and Nov); older months are one click back
            selected={selected}
            onSelect={(r) => set({ from: r?.from ? iso(r.from) : undefined, to: r?.to ? iso(r.to) : r?.from ? iso(r.from) : undefined })}
            startMonth={meta ? parseISO(meta.messages.min) : undefined}
            endMonth={parseISO(asOf)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export type FilterKind = "templates" | "sources" | "owners" | "statuses"

/** The one switch that shows or hides full phone numbers and message text on this page (and keeps doing so on the next page until the browser is reloaded). */
function RevealToggle({ short = false }: { short?: boolean }) {
  const { reveal, setReveal, canReveal } = useReveal()
  if (!canReveal) return null
  return (
    <Button variant={reveal ? "secondary" : "outline"} size="sm" className={short ? "" : "w-full sm:ml-auto sm:w-auto"} aria-pressed={reveal} onClick={() => setReveal(!reveal)}
      title={reveal ? "Full phone numbers and message text are showing. Click to hide them again." : "Show full phone numbers and message text on this page. Reloading the page or logging out hides them again."}>
      {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{short ? (reveal ? "Hide numbers" : "Show numbers") : reveal ? "Hide phone numbers and messages" : "Show phone numbers and messages"}
    </Button>
  )
}

export function FilterBar({ kinds, statusOptions, statusLabel = "Status", reveal = false, ownerOptions, ownerLabel = "Owner", compact = false }: { kinds: FilterKind[]; statusOptions?: string[]; statusLabel?: string; reveal?: boolean; ownerOptions?: string[]; ownerLabel?: string; compact?: boolean }) {
  const { meta, filters, set, reset, active } = useFilters()
  // how many messages each template sent in the chosen dates, shown beside its name in the Template list
  const tc = useApi<any>(kinds.includes("templates") ? "messages/templates" : null, { from: filters.from, to: filters.to })
  const tplCounts = useMemo(() => Object.fromEntries((tc.data?.rows ?? []).map((r: any) => [r.template_name, r.attempts])), [tc.data])
  if (!meta) return null
  return (
    <div className={cn("z-10 -mx-3 flex items-center gap-2 bg-background/90 px-3 backdrop-blur", compact ? "no-scrollbar flex-nowrap overflow-x-auto py-1 [&>*]:shrink-0" : "flex-wrap border-b py-2.5 sm:-mx-4 sm:px-4 md:sticky md:top-12 md:-mx-6 md:px-6")} role="group" aria-label="Filters">
      {reveal && compact && <RevealToggle short />}   {/* phone: first in the row, so it is always on screen */}
      <DateRangeFilter />
      {kinds.includes("templates") && <MultiSelect label="Template" options={meta.templates} value={filters.templates} onChange={(v) => set({ templates: v })} counts={tc.data ? tplCounts : undefined} />}
      {kinds.includes("sources") && <MultiSelect label="Lead source" options={meta.sources} value={filters.sources} onChange={(v) => set({ sources: v })} />}
      {kinds.includes("owners") && <MultiSelect label={ownerLabel} options={ownerOptions ?? meta.owners} value={filters.owners} onChange={(v) => set({ owners: v })} />}
      {kinds.includes("statuses") && <MultiSelect label={statusLabel} options={statusOptions ?? []} value={filters.statuses} onChange={(v) => set({ statuses: v })} />}
      {active > 0 && (
        <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="size-3.5" />Reset filters</Button>
      )}
      {reveal && !compact && <RevealToggle />}
    </div>
  )
}
