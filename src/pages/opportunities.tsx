import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { CircleX, FolderOpen, Hourglass, Percent, Target, Trophy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis, rowFormatter } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { PagedList, type PagedCol } from "@/components/paged-list"
import { LazyMount, useSeen } from "@/components/lazy"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { dayShort, num, one, pct, periodLabel, ppDelta } from "@/lib/format"

const statusTone = (s: string) => (/won/i.test(s) ? "var(--good)" : /lost/i.test(s) ? "var(--bad)" : "var(--c1)")

export default function Opportunities() {
  const { params, meta, filters } = useFilters()
  const nav = useNavigate()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to, "week")
  const kpis = useApi<any>("opps/kpis", params)
  const trend = useApi<any>("opps/trend", { ...params, grain })
  const [lowRef, low] = useSeen()   // the lower half of the page asks the server only once you scroll near it
  const sts = useApi<any>("opps/statuses", params)
  const own = useApi<any>(low ? "opps/owners" : null, params)
  const aging = useApi<any>(low ? "opps/aging" : null, params)
  const c = kpis.data?.current, p = kpis.data?.previous
  const stale = meta?.staleDays ?? 30

  const cfg: ChartConfig = { open: { label: "Open", color: "var(--c1)" }, won: { label: "Won", color: "var(--good)" }, lost: { label: "Lost", color: "var(--bad)" } }
  const rows = (trend.data?.rows ?? []).map((r: any) => ({ label: periodLabel(r.period, grain), open: r.open, won: r.won, lost: r.lost }))

  const ownerCols: Col<any>[] = [
    { key: "owner", header: "Owner", value: (r) => r.owner },
    { key: "opportunities", header: "Opportunities", align: "right", value: (r) => r.opportunities, render: (r) => num(r.opportunities) },
    { key: "won", header: "Won", align: "right", value: (r) => r.won, render: (r) => num(r.won) },
    { key: "lost", header: "Lost", align: "right", value: (r) => r.lost, render: (r) => num(r.lost) },
    { key: "win_rate", header: "Win rate", align: "right", value: (r) => r.win_rate, render: (r) => pct(r.win_rate), hint: "Won divided by won plus lost. Open opportunities are not counted." },
    { key: "stale_new", header: "Stale New", align: "right", value: (r) => r.stale_new, render: (r) => num(r.stale_new), cellClass: (r) => (r.stale_new > 0 ? "text-warn font-medium" : undefined), hint: `Opportunities still at status New after more than ${stale} days. They are probably forgotten.` },
  ]
  const listCols: PagedCol[] = [
    { key: "name", header: "Name", sort: "name", render: (r) => <span className="font-medium">{r.customer_name || "(no name)"}</span> },
    { key: "phone", header: "Phone", render: (r) => r.phone },
    { key: "status", header: "Status", sort: "status", render: (r) => <Badge variant="outline" style={{ color: statusTone(r.opportunity_status) }}>{r.opportunity_status}</Badge> },
    { key: "owner", header: "Owner", sort: "owner", render: (r) => r.opp_owner },
    { key: "created", header: "Created", sort: "created", render: (r) => dayShort(r.created_date) },
    { key: "updated", header: "Last updated", render: (r) => dayShort(r.updated_at) },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Opportunities" description="The sales pipeline: what is open, won and lost, who is closing, and which opportunities have gone quiet. Won and lost are counted from the status, not the flag columns." />
      <FilterBar kinds={["owners", "statuses"]} statusOptions={meta?.oppStatuses} statusLabel="Status" />
      <ErrorNote message={kpis.error} />

      <ScoreGrid cols={3} stats={[
        { icon: Target, label: "Opportunities", loading: !c, value: num(c?.opportunities), delta: p ? { value: p.opportunities ? Math.round((1000 * (c.opportunities - p.opportunities)) / p.opportunities) / 10 : null, goodWhen: "up", unit: "%" } : undefined, foot: "opened in this period" },
        { icon: FolderOpen, label: "Open", loading: !c, value: num(c?.open), foot: "Not won or lost yet" },
        { icon: Trophy, label: "Won", loading: !c, value: num(c?.won), tone: "good", foot: c && `of ${num(c.won + c.lost)} closed` },
        { icon: CircleX, label: "Lost", loading: !c, value: num(c?.lost), tone: "bad", foot: c && `of ${num(c.won + c.lost)} closed` },
        { icon: Percent, label: "Win rate", loading: !c, value: one(c?.win_rate), unit: "%", meter: c?.win_rate, tone: "good", delta: p ? { value: ppDelta(c?.win_rate, p.win_rate), goodWhen: "up" } : undefined, foot: "Of closed deals", hint: "Won divided by won plus lost." },
        { icon: Hourglass, label: `New over ${stale} days`, loading: !c, value: num(c?.stale_new), tone: c && c.stale_new > 0 ? "warn" : "default", foot: c && `of ${num(c.new_total)} still New`, hint: "Opportunities still at status New after more than a month, so likely forgotten." },
      ]} />

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Opportunities created" description="By the month they were created, split by where they stand now."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {trend.loading && !trend.data ? <ChartSkeleton /> : (
            <ChartContainer config={cfg} className="h-[260px] w-full">
              <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} width={44} />
                <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(cfg)} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar isAnimationActive={false} dataKey="won" stackId="a" fill="var(--color-won)" />
                <Bar isAnimationActive={false} dataKey="lost" stackId="a" fill="var(--color-lost)" />
                <Bar isAnimationActive={false} dataKey="open" stackId="a" fill="var(--color-open)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="Status now" description="Where the opportunities in this selection stand.">
          {sts.error ? <ErrorNote message={sts.error} /> : !sts.data ? <ChartSkeleton h={200} /> : (
            <BarList rows={sts.data.rows.map((r: any) => ({ label: r.label, value: r.opportunities, text: `${num(r.opportunities)}  ·  ${pct(r.share)}` }))} colorFor={(r) => statusTone(r.label)} />
          )}
        </ChartCard>
      </div>

      <div ref={lowRef} className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-2" title="How long New opportunities have waited" description="Age of opportunities still at status New. Ignores the date filter, because it is about what is open today.">
          {aging.error ? <ErrorNote message={aging.error} /> : !aging.data ? <ChartSkeleton h={160} /> : (
            <BarList rows={aging.data.rows.map((r: any) => ({ label: r.bucket, value: r.opportunities, text: num(r.opportunities) }))} colorFor={(_, i) => ["var(--c2)", "var(--c3)", "var(--warn)", "var(--bad)"][i] ?? "var(--c1)"} />
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-3" title="By owner" description="Who is closing, and who has opportunities going stale.">
          {own.error ? <ErrorNote message={own.error} /> : !own.data ? <ChartSkeleton /> : <SortableTable rows={own.data.rows} cols={ownerCols} rowKey={(r) => r.owner} initialSort="opportunities" maxHeight="20rem" />}
        </ChartCard>
      </div>

      <ChartCard title="All opportunities" description="Search by name, phone digits or opportunity id. Click a row for that customer's full picture.">
        <LazyMount minHeight={400}><PagedList endpoint="opps/list" params={params} cols={listCols} rowKey={(r) => r.opportunity_id} placeholder="Search name, phone digits or opportunity id" onRow={(r) => nav(`/customers?key=${encodeURIComponent(r.key)}`)} /></LazyMount>
      </ChartCard>
      </div>
    </div>
  )
}
