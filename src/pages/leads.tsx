import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Clock, Hand, Phone, Tag, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis, rowFormatter } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { Dots, PagedList, type PagedCol } from "@/components/paged-list"
import { LazyMount, useSeen } from "@/components/lazy"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { dayShort, num, one, pct, periodLabel, ppDelta } from "@/lib/format"

const UNKNOWN = "(unknown: overwritten by status)"

export default function Leads() {
  const { params, meta, filters } = useFilters()
  const nav = useNavigate()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to)
  const kpis = useApi<any>("leads/kpis", params)
  const trend = useApi<any>("leads/trend", { ...params, grain })
  const src = useApi<any>("leads/sources", params)
  const [lowRef, low] = useSeen()   // the lower half of the page asks the server only once you scroll near it
  const sts = useApi<any>(low ? "leads/statuses" : null, params)
  const own = useApi<any>(low ? "leads/owners" : null, params)
  const cov = useApi<any>(low ? "leads/coverage" : null, params)
  const c = kpis.data?.current, p = kpis.data?.previous

  const journey = useMemo(() => !c ? [] : [
    { label: "Welcome message", value: c.welcome }, { label: "24-hour follow-up", value: c.followup_24h },
    { label: "1st task follow-up", value: c.task1 }, { label: "2nd task follow-up", value: c.task2 }, { label: "3rd task follow-up", value: c.task3 },
  ].map((r) => ({ ...r, text: `${num(r.value)}  ·  ${pct(c.leads ? (100 * r.value) / c.leads : null)}` })), [c])

  const trendCfg: ChartConfig = { leads: { label: "New leads", color: "var(--c1)" }, welcome: { label: "Welcome sent", color: "var(--c2)" } }
  const trendRows = (trend.data?.rows ?? []).map((r: any) => ({ label: periodLabel(r.period, grain), leads: r.leads, welcome: r.welcome }))
  const covCfg: ChartConfig = { welcome_pct: { label: "Welcome sent", color: "var(--c1)" }, followup_24h_pct: { label: "24-hour follow-up", color: "var(--c2)" } }
  const covRows = (cov.data?.rows ?? []).map((r: any) => ({ ...r, label: periodLabel(r.month + "-01", "month") }))

  const ownerCols: Col<any>[] = [
    { key: "owner", header: "Owner", value: (r) => r.owner },
    { key: "leads", header: "Leads", align: "right", value: (r) => r.leads, render: (r) => num(r.leads) },
    { key: "welcome_pct", header: "Welcome sent", align: "right", value: (r) => r.welcome_pct, render: (r) => pct(r.welcome_pct) },
    { key: "followup_24h_pct", header: "24h follow-up", align: "right", value: (r) => r.followup_24h_pct, render: (r) => pct(r.followup_24h_pct) },
    { key: "to_nurturing", header: "Nurturing", align: "right", value: (r) => r.to_nurturing, render: (r) => num(r.to_nurturing), hint: "Leads that passed through the Nurturing status." },
    { key: "to_not_connected", header: "Not connected", align: "right", value: (r) => r.to_not_connected, render: (r) => num(r.to_not_connected) },
    { key: "to_unqualified", header: "Unqualified", align: "right", value: (r) => r.to_unqualified, render: (r) => num(r.to_unqualified) },
    { key: "qualified", header: "Qualified now", align: "right", value: (r) => r.qualified, render: (r) => num(r.qualified) },
  ]
  const listCols: PagedCol[] = [
    { key: "name", header: "Name", sort: "name", render: (r) => <span className="font-medium">{r.customer_name || "(no name)"}</span> },
    { key: "phone", header: "Phone", render: (r) => r.phone_overwritten ? <Badge variant="outline" className="text-warn">overwritten</Badge> : r.phone },
    { key: "source", header: "Source", sort: "source", render: (r) => r.source_overwritten ? <span className="text-warn" title="The real source was overwritten by a status">unknown</span> : r.lead_source },
    { key: "status", header: "Status", sort: "status", render: (r) => r.lead_status },
    { key: "owner", header: "Owner", sort: "owner", render: (r) => r.lead_owner },
    { key: "created", header: "Created", sort: "created", render: (r) => dayShort(r.created_date) },
    { key: "journey", header: "Journey", render: (r) => <Dots items={[{ label: "Welcome", done: r.welcome === 1 }, { label: "24-hour follow-up", done: r.followup_24h === 1 }, { label: "1st task", done: r.task1 === 1 }, { label: "2nd task", done: r.task2 === 1 }, { label: "3rd task", done: r.task3 === 1 }]} /> },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Leads" description="Where leads come from, who they are assigned to, and whether each one went through the follow-up steps. Open any lead to see that customer's full picture." />
      <FilterBar kinds={["sources", "owners", "statuses"]} statusOptions={meta?.leadStatuses} statusLabel="Lead status" />
      <ErrorNote message={kpis.error} />

      <ScoreGrid cols={3} stats={[
        { icon: Users, label: "Leads", loading: !c, value: num(c?.leads), delta: p ? { value: p.leads ? Math.round((1000 * (c.leads - p.leads)) / p.leads) / 10 : null, goodWhen: "up", unit: "%" } : undefined, foot: "created in this period" },
        { icon: Phone, label: "People", loading: !c, value: num(c?.people), foot: "distinct phone numbers", hint: "Some people appear as several leads. Only leads with a usable phone number are counted." },
        { icon: Hand, label: "Welcome sent", loading: !c, value: one(c?.welcome_pct), unit: "%", meter: c?.welcome_pct, delta: p ? { value: ppDelta(c?.welcome_pct, p.welcome_pct), goodWhen: "up" } : undefined, foot: c && `${num(c.welcome)} leads` },
        { icon: Clock, label: "24-hour follow-up", loading: !c, value: one(c?.followup_24h_pct), unit: "%", meter: c?.followup_24h_pct, delta: p ? { value: ppDelta(c?.followup_24h_pct, p.followup_24h_pct), goodWhen: "up" } : undefined, foot: c && `${num(c.followup_24h)} leads` },
        { icon: Tag, label: "Source known", loading: !c, value: one(c?.source_known_pct), unit: "%", meter: c?.source_known_pct, tone: c && c.source_known_pct < 60 ? "warn" : "default", foot: c && `${num(c.source_overwritten)} overwritten`, hint: "The real lead source was replaced by a status for many leads (workflow #7). It must be restored from Salesforce." },
        { icon: Phone, label: "Phone intact", loading: !c, value: one(c?.phone_intact_pct), unit: "%", meter: c?.phone_intact_pct, tone: c && c.phone_intact_pct < 80 ? "warn" : "default", foot: c && `${num(c.phone_overwritten)} replaced by text`, hint: "Leads whose phone number was replaced by text cannot be linked to their WhatsApp messages." },
      ]} />

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="New leads over time" description="Leads created, and how many got the welcome message."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {trend.loading && !trend.data ? <ChartSkeleton /> : (
            <ChartContainer config={trendCfg} className="h-[260px] w-full">
              <BarChart data={trendRows} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} width={44} />
                <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(trendCfg)} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar isAnimationActive={false} dataKey="leads" fill="var(--color-leads)" radius={[3, 3, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="welcome" fill="var(--color-welcome)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="Where leads came from" description="The amber bar is leads whose real source was overwritten. It must be restored from Salesforce.">
          {src.error ? <ErrorNote message={src.error} /> : !src.data ? <ChartSkeleton h={200} /> : (
            <BarList rows={src.data.rows.slice(0, 8).map((r: any) => ({ label: r.label, value: r.leads, text: `${num(r.leads)}  ·  ${pct(r.share)}` }))} colorFor={(r) => (r.label === UNKNOWN ? "var(--warn)" : "var(--c1)")} />
          )}
        </ChartCard>
      </div>

      <div ref={lowRef} className="flex flex-col gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Lead status now" description="Current status of the leads in this selection.">
          {sts.error ? <ErrorNote message={sts.error} /> : !sts.data ? <ChartSkeleton h={180} /> : <BarList rows={sts.data.rows.map((r: any) => ({ label: r.label, value: r.leads, text: `${num(r.leads)}  ·  ${pct(r.share)}` }))} colorFor={() => "var(--c2)"} />}
        </ChartCard>
        <ChartCard title="Follow-up journey" description="How many leads reached each step. Each lead should get the welcome message, then the follow-ups.">
          {!c ? <ChartSkeleton h={180} /> : <BarList max={c.leads} rows={journey} colorFor={() => "var(--c1)"} />}
        </ChartCard>
      </div>

      <ChartCard title="Welcome and follow-up coverage by month" description="Share of each month's new leads that got the message. Dips mean leads were created without the welcome flow running. This chart ignores the date filter.">
        {cov.error ? <ErrorNote message={cov.error} /> : !cov.data ? <ChartSkeleton /> : (
          <ChartContainer config={covCfg} className="h-[250px] w-full">
            <LineChart data={covRows} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} width={44} domain={[0, 100]} tickFormatter={(v) => v + "%"} />
              <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(covCfg, "%")} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Line dataKey="welcome_pct" type="linear" stroke="var(--color-welcome_pct)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
              <Line dataKey="followup_24h_pct" type="linear" stroke="var(--color-followup_24h_pct)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        )}
      </ChartCard>

      <ChartCard title="By owner" description="Leads, follow-up coverage and how many moved through each status.">
        {own.error ? <ErrorNote message={own.error} /> : !own.data ? <ChartSkeleton /> : <SortableTable rows={own.data.rows} cols={ownerCols} rowKey={(r) => r.owner} initialSort="leads" maxHeight="24rem" />}
      </ChartCard>

      <ChartCard title="All leads" description="Search by name, phone digits or lead id. Click a row for that customer's full picture. Dots show the journey: welcome, 24-hour, then tasks 1 to 3.">
        <LazyMount minHeight={400}><PagedList endpoint="leads/list" params={params} cols={listCols} rowKey={(r) => r.key + r.lead_id} placeholder="Search name, phone digits or lead id" onRow={(r) => nav(`/customers?key=${encodeURIComponent(r.key)}`)} /></LazyMount>
      </ChartCard>
      </div>
    </div>
  )
}
