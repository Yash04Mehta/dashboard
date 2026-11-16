import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChevronRight, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { axis, rowFormatter } from "@/components/charts"
import { DeltaChip, InfoTip, type Delta } from "@/components/kit"
import { num } from "@/lib/format"

const TONE = { good: "var(--good)", bad: "var(--bad)", default: "var(--c1)" } as const

export type GlanceRow = { label: string; value: ReactNode; meter?: number | null; tone?: keyof typeof TONE; delta?: Delta; hint?: ReactNode }
export type GlanceSeries = { key: string; label: string; color: string }

/** One topic at a glance: the headline number, a trend line, then a few supporting figures with meters. */
export function GlancePanel({ icon: Icon, title, big, caption, loading, data, series, rows, grainWord }: {
  icon: LucideIcon; title: string; big?: ReactNode; caption?: ReactNode; loading?: boolean
  data: Record<string, any>[]; series: GlanceSeries[]; rows: GlanceRow[]; grainWord: string
}) {
  const cfg: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
  return (
    <Card className="min-w-0">
      <CardContent className="flex h-full flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Icon className="size-4" /></span>
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div>
          {loading ? <Skeleton className="h-10 w-32" /> : <div className="tnum text-4xl font-semibold tracking-tight">{big}</div>}
          <div className="mt-1 min-h-5 text-sm text-muted-foreground">{caption}</div>
        </div>

        <div>
          {data.length < 2 ? (
            <div className="flex h-[130px] items-center justify-center rounded-lg border border-dashed px-4 text-center text-xs text-muted-foreground">{loading ? "" : `Pick a longer date range to see the ${grainWord}-by-${grainWord} trend.`}</div>
          ) : (
            <ChartContainer config={cfg} className="aspect-auto h-[130px] w-full">
              <AreaChart data={data} margin={{ left: 0, right: 4, top: 6, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} tickMargin={6} interval="preserveStartEnd" minTickGap={28} tick={{ fontSize: 11 }} />
                <YAxis hide domain={[0, "auto"]} />
                <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(cfg)} />} />
                {series.map((s) => <Area key={s.key} dataKey={s.key} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.1} strokeWidth={2} dot={false} isAnimationActive={false} />)}
              </AreaChart>
            </ChartContainer>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />{s.label}</span>)}
          </div>
        </div>

        <div className="mt-auto flex flex-col divide-y border-t">
          {rows.map((r) => (
            <div key={r.label} className="py-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><span className="truncate">{r.label}</span>{r.hint && <InfoTip>{r.hint}</InfoTip>}</span>
                <span className="flex shrink-0 items-baseline gap-2">{loading ? <Skeleton className="h-5 w-14" /> : <><DeltaChip delta={r.delta} /><span className="tnum font-semibold" style={{ color: r.tone && r.tone !== "default" ? TONE[r.tone] : undefined }}>{r.value}</span></>}</span>
              </div>
              {r.meter != null && !loading && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, r.meter))}%`, background: TONE[r.tone ?? "default"] }} /></div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export type Attention = { icon: LucideIcon; count?: number; text: string; to: string; tone?: "bad" | "warn" }

/** A short list of things somebody should probably act on. Each row opens the page with the details, keeping the filters. */
export function AttentionList({ items, loading }: { items: Attention[]; loading?: boolean }) {
  const { search } = useLocation()
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
      {items.map((it) => (
        <Link key={it.text} to={{ pathname: it.to, search }} className="group flex items-center gap-3 bg-card px-4 py-3.5 transition-colors hover:bg-muted/60">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40" style={{ color: it.tone === "bad" ? "var(--bad)" : "var(--warn)" }}><it.icon className="size-4" /></span>
          <span className="min-w-0 flex-1 text-sm">
            {loading || it.count == null ? <Skeleton className="h-5 w-16" /> : <span className="tnum mr-1.5 text-lg font-semibold">{num(it.count)}</span>}
            <span className="text-muted-foreground">{it.text}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      ))}
    </div>
  )
}
