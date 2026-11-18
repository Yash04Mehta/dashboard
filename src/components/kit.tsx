import { useColResize } from "@/components/col-resize"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Info, Search, type LucideIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { downloadCsv } from "@/lib/csv"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type Grain = "day" | "week" | "month"

/** Picks day, week or month from the length of the chosen date range; the user can override until the range changes. */
export function useAutoGrain(from?: string, to?: string, min: Grain = "day") {
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : Infinity
  let auto: Grain = days <= 45 ? "day" : days <= 200 ? "week" : "month"
  if (min === "week" && auto === "day") auto = "week"
  const [picked, setPicked] = useState<Grain | null>(null)
  useEffect(() => setPicked(null), [auto])
  return [picked ?? auto, (g: Grain) => setPicked(g)] as const
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}

export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-help text-muted-foreground" />}>
        <Info className="size-3.5" aria-label="More information" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  )
}

export type Delta = { value: number | null; goodWhen: "up" | "down"; unit?: string; label?: string }

export function KpiCard({ label, value, sub, delta, tone, hint, loading }: { label: string; value: ReactNode; sub?: ReactNode; delta?: Delta; tone?: "bad" | "warn" | "good"; hint?: ReactNode; loading?: boolean }) {
  const d = delta?.value
  const good = d == null || d === 0 ? null : (d > 0) === (delta!.goodWhen === "up")
  return (
    <Card size="sm" className="min-w-0">
      <CardContent className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="truncate">{label}</span>
          {hint && <InfoTip>{hint}</InfoTip>}
        </div>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className={cn("tnum text-3xl font-semibold tracking-tight", tone === "bad" && "text-bad", tone === "warn" && "text-warn", tone === "good" && "text-good")}>{value}</div>
        )}
        <div className="flex min-h-5 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {sub && <span>{sub}</span>}
          {d != null && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", good === true && "text-good", good === false && "text-bad")}>
              {d > 0 ? <ArrowUp className="size-3" /> : d < 0 ? <ArrowDown className="size-3" /> : null}
              {d > 0 ? "+" : ""}{d}{delta?.unit ?? " pts"} {delta?.label ?? "vs previous period"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** coloured arrow and change in points (or `unit`) against the previous period; empty when there is no change to show */
export function DeltaChip({ delta }: { delta?: Delta }) {
  const d = delta?.value
  if (d == null || d === 0) return null
  const good = (d > 0) === (delta!.goodWhen === "up")
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-good" : "text-bad")}>
      {d > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}{d > 0 ? "+" : ""}{d}{delta?.unit ?? " pts"}
    </span>
  )
}

const TONE = { good: "var(--good)", bad: "var(--bad)", warn: "var(--warn)", default: "var(--c1)" } as const

export type Stat = { icon: LucideIcon; label: string; value: ReactNode; unit?: string; meter?: number | null; tone?: keyof typeof TONE; foot?: ReactNode; delta?: Delta; hint?: ReactNode; loading?: boolean }

const COLS = {
  3: "sm:grid-cols-2 xl:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
} as const

/** Big-number card: icon chip and label, value with optional unit and meter, and a shaded footer line. */
export function MetricCard({ icon: Icon, label, value, unit, meter, tone = "default", foot, delta, hint, loading }: Stat) {
  return (
    <Card className="min-w-0 gap-0 py-0 transition-[translate,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-lg hover:shadow-black/10 hover:ring-foreground/20 focus-within:-translate-y-1 focus-within:shadow-lg dark:hover:shadow-black/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:focus-within:translate-y-0">
      <CardContent className="flex flex-col gap-2 px-3 py-3 sm:px-4 sm:py-4">
        <div className="flex items-center gap-2 sm:gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/40 sm:size-8" style={{ color: TONE[tone] }}><Icon className="size-3.5 sm:size-4" /></span>
          <span className="text-xs font-medium leading-tight sm:truncate sm:text-sm">{label}</span>
          {hint && <InfoTip>{hint}</InfoTip>}
        </div>
        {loading ? <Skeleton className="h-9 w-28" /> : (
          <div className="tnum flex flex-wrap items-baseline gap-x-1 text-2xl font-semibold tracking-tight sm:text-3xl">{value}{unit && <span className="text-base font-normal text-muted-foreground">{unit}</span>}</div>
        )}
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden={meter == null} style={{ visibility: meter == null ? "hidden" : "visible" }}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, meter ?? 0))}%`, background: TONE[tone] }} />
        </div>
      </CardContent>
      <CardFooter className="min-h-10 flex-wrap gap-x-3 gap-y-0.5 px-3 py-2.5 text-xs text-muted-foreground sm:px-4 sm:text-sm">
        {foot && <span>{foot}</span>}
        <DeltaChip delta={delta} />
      </CardFooter>
    </Card>
  )
}

/** The one way every page lays out its figures: an optional small heading, then floating MetricCards in an even grid (pick `cols` so the last row is full). */
export function ScoreGrid({ title, stats, cols = 4 }: { title?: ReactNode; stats: Stat[]; cols?: keyof typeof COLS }) {
  return (
    <section className="flex flex-col gap-3">
      {title && <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>}
      {/* phones: two cards per row (the odd last one spans both), so the figures are not a mile-long column */}
      <div className={cn("grid grid-cols-2 gap-3 sm:gap-4 [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1", COLS[cols])}>{stats.map((st) => <MetricCard key={st.label} {...st} />)}</div>
    </section>
  )
}

export function ChartCard({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 flex-1">{children}</CardContent>
    </Card>
  )
}

export function ChartSkeleton({ h = 240 }: { h?: number }) {
  return <Skeleton style={{ height: h }} className="w-full" />
}

export function ErrorNote({ message }: { message?: string }) {
  if (!message) return null
  return <div role="alert" className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">Could not load this: {message}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>
}

/* ---------------- sortable table ---------------- */
export type Col<T> = {
  key: string
  header: ReactNode
  align?: "left" | "right"
  value: (r: T) => string | number | null | undefined
  render?: (r: T) => ReactNode
  cellClass?: (r: T) => string | undefined
  hint?: ReactNode
  className?: string
}

/** The filter row (search box and any `toolbar` filters) is left-aligned and stays put above the table; every column, the first too, is centred; the header row sticks to the top of the scroll box, so only the rows move. */
export const STICKY_HEAD = "sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]"

export function SortableTable<T>({ rows, cols, rowKey, initialSort, initialDir = "desc", maxHeight = "26rem", onRowClick, searchText, searchPlaceholder, footer, toolbar, exportName }: {
  rows: T[]
  cols: Col<T>[]
  rowKey: (r: T) => string
  initialSort?: string
  initialDir?: "asc" | "desc"
  maxHeight?: string
  onRowClick?: (r: T) => void
  searchText?: (r: T) => string
  searchPlaceholder?: string
  footer?: ReactNode
  toolbar?: ReactNode
  exportName?: string   // file name for the Export CSV button (the date is added)
}) {
  const [sort, setSort] = useState(initialSort ?? cols[0].key)
  const [dir, setDir] = useState<"asc" | "desc">(initialDir)
  const [q, setQ] = useState("")
  const shown = useMemo(() => {
    const col = cols.find((c) => c.key === sort) ?? cols[0]
    const f = q && searchText ? rows.filter((r) => searchText(r).toLowerCase().includes(q.toLowerCase())) : rows
    return [...f].sort((a, b) => {
      const x = col.value(a), y = col.value(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))
      return dir === "asc" ? c : -c
    })
  }, [rows, cols, sort, dir, q, searchText])
  const click = (k: string) => { if (k === sort) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(k); setDir("desc") } }
  const rs = useColResize(cols.length, rows.length > 0)
  return (
    <div className="flex flex-col gap-3">
      {(searchText || toolbar) && (
        <div className="flex flex-wrap items-center justify-start gap-3">
          {toolbar}
          {searchText && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder ?? "Search"} className="pl-8" aria-label={searchPlaceholder ?? "Search"} />
            </div>
          )}
        </div>
      )}
      <div className="overflow-auto rounded-lg border" style={{ maxHeight }}>
        <Table ref={rs.ref} style={rs.style} className="min-w-[34rem]">
          {rs.colgroup}
          <TableHeader className={STICKY_HEAD}>
            <TableRow>
              {cols.map((c, i) => (
                <TableHead key={c.key} className={cn("relative whitespace-nowrap text-center", rs.line, c.className)} aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => click(c.key)} className={cn("relative inline-flex items-center gap-1 font-medium hover:text-foreground")}>
                    {c.header}
                    <span className={"absolute left-full top-1/2 ml-1 inline-flex -translate-y-1/2 items-center gap-1"}>
                      {c.hint && <InfoTip>{c.hint}</InfoTip>}
                      {sort === c.key ? (dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ChevronsUpDown className="size-3 opacity-40" />}
                    </span>
                  </button>
                  {rs.handle(i)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn(onRowClick && "cursor-pointer")}>
                {cols.map((c) => (
                  <TableCell key={c.key} className={cn("tnum overflow-hidden text-ellipsis text-center", rs.line, c.cellClass?.(r), c.className)}>{c.render ? c.render(r) : (c.value(r) ?? "—")}</TableCell>
                ))}
              </TableRow>
            ))}
            {!shown.length && <TableRow><TableCell colSpan={cols.length} className="py-8 text-center text-muted-foreground">Nothing matches.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{shown.length} {shown.length === 1 ? "row" : "rows"}</span>
        <Button variant="outline" size="sm" disabled={!shown.length} title="Download the rows shown above as a CSV file (phone numbers stay masked unless you have switched them on)"
          onClick={() => downloadCsv(exportName ?? "table", cols.map((c) => (typeof c.header === "string" ? c.header : c.key)), shown.map((r) => cols.map((c) => c.value(r))))}>
          <Download className="size-3.5" />Export CSV
        </Button>
      </div>
      {footer}
    </div>
  )
}

/* horizontal bar list, used for mixes and funnels */
export function BarList({ rows, valueLabel, max, colorFor }: { rows: { label: string; value: number; text?: string }[]; valueLabel?: (r: { label: string; value: number }) => string; max?: number; colorFor?: (r: { label: string; value: number }, i: number) => string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r, i) => (
        <div key={r.label} className="grid grid-cols-[minmax(6rem,11rem)_1fr] items-center gap-3 text-sm">
          <div className="truncate" title={r.label}>{r.label}</div>
          <div className="relative h-6 overflow-hidden rounded bg-muted">
            <div className="h-full rounded" style={{ width: `${Math.max(1, (100 * r.value) / top)}%`, background: colorFor?.(r, i) ?? "var(--c1)" }} />
            <span className="tnum absolute inset-y-0 left-2 flex items-center text-xs font-medium text-foreground mix-blend-normal">{r.text ?? valueLabel?.(r) ?? r.value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
