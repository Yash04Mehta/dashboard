import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckCheck, Eye, MessageCircle, Repeat, Send, TriangleAlert } from "lucide-react"
import { FilterBar } from "@/components/filter-bar"
import { axis, PALETTE, rowFormatter } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { Funnel } from "@/components/funnel"
import { FailureReasonsCard } from "@/components/v1"
import { useSeen } from "@/components/lazy"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { duration, hourLabel, num, one, pct, periodLabel, ppDelta } from "@/lib/format"

const LIMIT_FAILED = 5          // failed share (%) above which a template or group turns red
const MIN_FOLLOWED = { day: 20, week: 50, month: 100 } as const

type View = "delivery" | "outcomes" | "volume"
type Metric = "measured" | "read_pct" | "replied_pct" | "all"

const MIN_SLOT = 100            // messages a time slot needs before its rate is shown
const BUCKETS = ["Under 5 min", "5 to 60 min", "1 to 6 hours", "6 to 24 hours", "1 to 3 days", "Over 3 days"]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const METRICS: Record<Metric, { label: string; text: string }> = {
  measured: { label: "Messages sent", text: "How many messages go out" },
  read_pct: { label: "Read rate", text: "Share of messages that get read" },
  replied_pct: { label: "Reply rate", text: "Share of messages that get a reply" },
  all: { label: "All three", text: "Messages sent as bars, read and reply rate as lines" },
}

export default function Messages() {
  const { params, set, filters } = useFilters()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to)
  const [view, setView] = useState<View>("delivery")
  const [by, setBy] = useState<"source" | "owner">("source")
  const [rtKind, setRtKind] = useState<"reply" | "read">("reply")
  const [slot, setSlot] = useState<"hour" | "weekday">("hour")
  const [metric, setMetric] = useState<Metric>("replied_pct")

  const kpis = useApi<any>("messages/kpis", params)
  const trend = useApi<any>("messages/trend", { ...params, grain })
  const [lowRef, low] = useSeen()   // the lower half of the page asks the server only once you scroll near it
  const tpl = useApi<any>(low ? "messages/templates" : null, params)
  const fail = useApi<any>(low ? "messages/failures" : null, params)
  const brk = useApi<any>(low ? "messages/breakdown" : null, { ...params, by })
  const rt = useApi<any>(low ? "messages/reply-time" : null, params)
  const bt = useApi<any>(low ? "messages/by-time" : null, params)

  const c = kpis.data?.current, p = kpis.data?.previous
  const hasData = c && c.measured > 0

  const funnel = useMemo(() => {
    if (!c) return []
    const rows = [
      { label: "Messages followed", value: c.measured },
      { label: "Delivered", value: c.delivered_adj },
      { label: "Read", value: c.read_adj },
      { label: "Replied", value: c.replied },
    ]
    let worst = -1, loss = 0
    rows.forEach((r, i) => { if (i > 0) { const l = rows[i - 1].value - r.value; if (l > loss) { loss = l; worst = i } } })
    return rows.map((r, i) => ({ ...r, text: `${num(r.value)}  ·  ${pct(c.measured ? (100 * r.value) / c.measured : null)}`, worst: i === worst }))
  }, [c])

  const worstStep = useMemo(() => {
    const i = funnel.findIndex((r) => r.worst)
    return i > 0 ? { from: funnel[i - 1].label.toLowerCase(), to: funnel[i].label.toLowerCase(), lost: funnel[i - 1].value - funnel[i].value } : null
  }, [funnel])

  const replyRows = useMemo(() => (rt.data?.[rtKind]?.buckets ?? []).map((b: any) => ({ label: BUCKETS[b.ord - 1], share: b.share ?? 0, n: b.n })), [rt.data, rtKind])
  const timeRows = useMemo(() => {
    const src: any[] = (slot === "hour" ? bt.data?.hours : WEEK_ORDER.map((k) => bt.data?.weekdays?.[k])) ?? []
    return src.filter(Boolean).map((r) => ({ label: slot === "hour" ? hourLabel(r.k) : WEEKDAYS[r.k], measured: r.measured, read_pct: r.measured >= MIN_SLOT ? r.read_pct : null, replied_pct: r.measured >= MIN_SLOT ? r.replied_pct : null }))
  }, [bt.data, slot])
  const bestSlot = useMemo(() => {
    if (metric === "measured" || metric === "all") return null
    const ok = timeRows.filter((r: any) => r[metric] != null)
    return ok.length ? ok.reduce((a: any, b: any) => (b[metric] > a[metric] ? b : a)) : null
  }, [timeRows, metric])

  const trendRows = useMemo(() => {
    const min = MIN_FOLLOWED[grain]
    return (trend.data?.rows ?? []).map((r: any) => {
      const ok = r.measured >= min
      return { label: periodLabel(r.period, grain), measured: r.measured, delivered_pct: ok ? r.delivered_pct : null, read_pct: ok ? r.read_pct : null, replied_pct: ok ? r.replied_pct : null, failed_pct: ok ? r.failed_pct : null }
    })
  }, [trend.data, grain])

  const failChart = useMemo(() => {
    const rows = fail.data?.rows ?? []
    const names: string[] = [...new Set<string>(rows.map((r: any) => r.template_name))]
    const months: string[] = [...new Set<string>(rows.map((r: any) => r.month))].sort()
    const config: ChartConfig = {}
    names.forEach((n, i) => { config["t" + i] = { label: n, color: PALETTE[i % PALETTE.length] } })
    const data = months.map((m) => {
      const o: Record<string, any> = { label: periodLabel(m + "-01", "month") }
      names.forEach((n, i) => { const r = rows.find((x: any) => x.template_name === n && x.month === m); o["t" + i] = r && r.measured >= 50 ? r.failed_pct : null })
      return o
    })
    return { config, data, names }
  }, [fail.data])

  const tplCols: Col<any>[] = [
    { key: "template_name", header: "Template", value: (r) => r.template_name, className: "max-w-[16rem] truncate" },
    { key: "measured", header: "Messages", align: "right", value: (r) => r.measured, render: (r) => num(r.measured), hint: "Messages whose delivery can be followed (sent plus failed, repeat sends excluded)." },
    { key: "delivered_pct", header: "Delivered", align: "right", value: (r) => r.delivered_pct, render: (r) => pct(r.delivered_pct) },
    { key: "read_pct", header: "Read", align: "right", value: (r) => r.read_pct, render: (r) => pct(r.read_pct) },
    { key: "replied_pct", header: "Replied", align: "right", value: (r) => r.replied_pct, render: (r) => pct(r.replied_pct) },
    { key: "failed_pct", header: "Failed", align: "right", value: (r) => r.failed_pct, render: (r) => pct(r.failed_pct), cellClass: (r) => (r.failed_pct > LIMIT_FAILED ? "font-medium text-bad" : undefined) },
    { key: "unmeasured_pct", header: "Not followed", align: "right", value: (r) => r.unmeasured_pct, render: (r) => pct(r.unmeasured_pct), hint: "Share of sends whose status events are dropped (the same person got the same template again)." },
  ]
  const brkCols: Col<any>[] = [
    { key: "label", header: by === "source" ? "Lead source" : "Owner", value: (r) => r.label },
    { key: "measured", header: "Messages", align: "right", value: (r) => r.measured, render: (r) => num(r.measured) },
    { key: "delivered_pct", header: "Delivered", align: "right", value: (r) => r.delivered_pct, render: (r) => pct(r.delivered_pct) },
    { key: "read_pct", header: "Read", align: "right", value: (r) => r.read_pct, render: (r) => pct(r.read_pct) },
    { key: "replied_pct", header: "Replied", align: "right", value: (r) => r.replied_pct, render: (r) => pct(r.replied_pct) },
    { key: "failed_pct", header: "Failed", align: "right", value: (r) => r.failed_pct, render: (r) => pct(r.failed_pct), cellClass: (r) => (r.failed_pct > LIMIT_FAILED ? "font-medium text-bad" : undefined) },
  ]

  const rateConfig: ChartConfig = { delivered_pct: { label: "Delivered", color: "var(--c1)" }, read_pct: { label: "Read", color: "var(--c2)" }, replied_pct: { label: "Replied", color: "var(--c3)" }, failed_pct: { label: "Failed", color: "var(--c4)" }, measured: { label: "Messages followed", color: "var(--c1)" } }
  const lineKeys = view === "delivery" ? ["delivered_pct", "read_pct"] : ["replied_pct", "failed_pct"]
  const showDots = trendRows.length <= 24
  const rtConfig: ChartConfig = { share: { label: rtKind === "reply" ? "Replies" : "Read, no reply", color: rtKind === "reply" ? "var(--good)" : "var(--c1)" } }
  const timeConfig: ChartConfig = metric === "all"
    ? { measured: { label: "Messages sent", color: "var(--c1)" }, read_pct: { label: "Read rate", color: "var(--c2)" }, replied_pct: { label: "Reply rate", color: "var(--good)" } }
    : { [metric]: { label: METRICS[metric].label, color: metric === "replied_pct" ? "var(--good)" : "var(--c1)" } }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Messages" description="How your WhatsApp templates perform. Rates only count messages whose delivery can be followed, so they are not distorted by missing status events." />
      <FilterBar kinds={["templates", "sources", "owners"]} />
      <ErrorNote message={kpis.error} />

      <ScoreGrid cols={3} stats={[
        { icon: Send, label: "Messages followed", loading: !c, value: num(c?.measured), foot: c && `${num(c.attempts)} sent in total`, hint: "Sent plus failed, minus repeat sends to the same person and template, whose status events are not recorded." },
        { icon: CheckCheck, label: "Delivered", loading: !c, value: one(c?.delivered_pct), unit: "%", meter: c?.delivered_pct, delta: p ? { value: ppDelta(c?.delivered_pct, p.delivered_pct), goodWhen: "up" } : undefined,
          foot: c && `Old method: ${pct(c.delivered_pct_old_method)}`, hint: "At least this share was delivered. The raw delivered counter misses most events, so the highest of delivered, read and replied is used." },
        { icon: Eye, label: "Read", loading: !c, value: one(c?.read_pct), unit: "%", meter: c?.read_pct, delta: p ? { value: ppDelta(c?.read_pct, p.read_pct), goodWhen: "up" } : undefined, foot: c && `at least ${num(c.read_adj)} messages` },
        { icon: MessageCircle, label: "Replied", loading: !c, value: one(c?.replied_pct), unit: "%", meter: c?.replied_pct, tone: "good", delta: p ? { value: ppDelta(c?.replied_pct, p.replied_pct), goodWhen: "up" } : undefined, foot: c && `${num(c.replied)} messages` },
        { icon: TriangleAlert, label: "Failed", loading: !c, value: one(c?.failed_pct), unit: "%", meter: c?.failed_pct, tone: c && c.failed_pct > LIMIT_FAILED ? "bad" : "default", delta: p ? { value: ppDelta(c?.failed_pct, p.failed_pct), goodWhen: "down" } : undefined, foot: c && `${num(c.failed)} messages` },
        { icon: Repeat, label: "Not followed", loading: !c, value: one(c?.unmeasured_pct), unit: "%", meter: c?.unmeasured_pct, foot: c && `${num(c.unmeasured)} repeat sends`, hint: "Repeat sends of the same template to the same number. Only the first one is tracked today." },
      ]} />

      {c && !hasData ? <Empty>No messages match these filters. Widen the date range or clear a filter.</Empty> : (
        <>
          <div className="grid gap-4 lg:grid-cols-5">
            <ChartCard className="lg:col-span-2" title="Where messages drop off" description="Share of followed messages reaching each step. The biggest drop is red.">
              {!c ? <ChartSkeleton h={160} /> : (
                <>
                  <BarList rows={funnel} colorFor={(_, i) => (funnel[i].worst ? "var(--bad)" : "var(--c1)")} />
                  <p className="mt-5 rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
                    Out of every 100 messages we followed, about <b>{Math.round(c.delivered_pct)}</b> were delivered, <b>{Math.round(c.read_pct)}</b> were read and <b>{c.replied_pct?.toFixed(1)}</b> got a reply.
                    {worstStep && <> The biggest drop is from <b>{worstStep.from}</b> to <b>{worstStep.to}</b>: {num(worstStep.lost)} messages stopped there.</>}
                  </p>
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Delivered and read are minimums. WhatsApp does not always report them, so the real figures are likely higher.</p>
                </>
              )}
            </ChartCard>
            <ChartCard className="lg:col-span-3" title="Trend"
              description={view === "volume" ? "Messages followed per period." : "Months or days with too few messages are left blank on purpose."}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Tabs value={view} onValueChange={(v) => setView(v as View)}><TabsList><TabsTrigger value="delivery">Delivery</TabsTrigger><TabsTrigger value="outcomes">Replies and failures</TabsTrigger><TabsTrigger value="volume">Volume</TabsTrigger></TabsList></Tabs>
                  <Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>
                </div>
              }>
              {trend.loading && !trend.data ? <ChartSkeleton /> : (
                <ChartContainer config={rateConfig} className="h-[260px] w-full">
                  {view === "volume" ? (
                    <BarChart data={trendRows} margin={{ left: 4, right: 8, top: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" {...axis} minTickGap={24} />
                      <YAxis {...axis} width={48} tickFormatter={(v) => (v >= 1000 ? v / 1000 + "k" : v)} />
                      <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(rateConfig)} />} />
                      <Bar isAnimationActive={false} dataKey="measured" fill="var(--color-measured)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  ) : (
                    <LineChart data={trendRows} margin={{ left: 4, right: 8, top: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" {...axis} minTickGap={24} />
                      <YAxis {...axis} width={44} domain={view === "delivery" ? [0, 100] : [0, "auto"]} tickFormatter={(v) => v + "%"} />
                      <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(rateConfig, "%")} />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      {lineKeys.map((k) => <Line key={k} dataKey={k} type="linear" stroke={`var(--color-${k})`} strokeWidth={2} dot={showDots ? { r: 2.5 } : false} connectNulls={false} isAnimationActive={false} />)}
                    </LineChart>
                  )}
                </ChartContainer>
              )}
            </ChartCard>
          </div>

          <div ref={lowRef} className="flex flex-col gap-6">
          <ChartCard title="How a message travels" description="Each column is a step. The band is what carried on to the next step; the curve below it is what dropped out.">
            {!c ? <ChartSkeleton h={300} /> : (
              <>
                <Funnel ariaLabel={`Of ${num(c.measured)} messages followed, ${num(c.delivered_adj)} were delivered, ${num(c.read_adj)} read and ${num(c.replied)} replied.`}
                  stages={[
                    { label: "Messages followed", value: c.measured, icon: <Send className="size-4" />, drop: "failed or never confirmed" },
                    { label: "Delivered", value: c.delivered_adj, icon: <CheckCheck className="size-4" />, drop: "delivered, not read" },
                    { label: "Read", value: c.read_adj, icon: <Eye className="size-4" />, drop: "read, no reply" },
                    { label: "Replied", value: c.replied, icon: <MessageCircle className="size-4" /> },
                  ]} />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Of the {num(c.measured - c.delivered_adj)} messages that dropped out before delivery, {num(c.failed)} failed outright. The rest have no delivery confirmation: WhatsApp never told us what happened, and many were probably delivered because the tracking misses events.
                </p>
              </>
            )}
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="How long customers take to respond" description="Time from our message to the customer's last action on it. An estimate: WhatsApp does not give an exact reply time."
              actions={<Tabs value={rtKind} onValueChange={(v) => setRtKind(v as "reply" | "read")}><TabsList><TabsTrigger value="reply">Replies</TabsTrigger><TabsTrigger value="read">Read, no reply</TabsTrigger></TabsList></Tabs>}>
              {rt.error ? <ErrorNote message={rt.error} /> : !rt.data ? <ChartSkeleton /> : rt.data[rtKind].total === 0 ? <Empty>No messages in this group for these filters.</Empty> : (
                <>
                  <p className="mb-3 text-sm">
                    Half of {rtKind === "reply" ? "replies arrive" : "these messages were last touched"} within <b>{duration(rt.data[rtKind].median_min)}</b>, and <b>{pct(rt.data[rtKind].within_day_pct, 0)}</b> within a day.
                    <span className="text-muted-foreground"> Based on {num(rt.data[rtKind].total)} messages.</span>
                  </p>
                  <ChartContainer config={rtConfig} className="h-[230px] w-full">
                    <BarChart data={replyRows} margin={{ left: 4, right: 8, top: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" {...axis} interval={0} tick={{ fontSize: 11 }} />
                      <YAxis {...axis} width={44} tickFormatter={(v) => v + "%"} />
                      <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(rtConfig, "%")} />} />
                      <Bar isAnimationActive={false} dataKey="share" fill="var(--color-share)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                </>
              )}
            </ChartCard>

            <ChartCard title="When messages go out and how they land" description={bestSlot ? `${METRICS[metric].label} is highest at ${bestSlot.label} (${pct(bestSlot[metric as Exclude<Metric, "all">])}). Times are India time.` : `${METRICS[metric].text}, by ${slot === "hour" ? "hour of the day" : "day of the week"}. Times are India time.`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}><TabsList>{(Object.keys(METRICS) as Metric[]).map((m) => <TabsTrigger key={m} value={m}>{METRICS[m].label}</TabsTrigger>)}</TabsList></Tabs>
                  <Tabs value={slot} onValueChange={(v) => setSlot(v as "hour" | "weekday")}><TabsList><TabsTrigger value="hour">Hour</TabsTrigger><TabsTrigger value="weekday">Weekday</TabsTrigger></TabsList></Tabs>
                </div>
              }>
              {bt.error ? <ErrorNote message={bt.error} /> : !bt.data ? <ChartSkeleton /> : (
                metric === "all" ? (
                <ChartContainer config={timeConfig} className="h-[260px] w-full">
                  <ComposedChart data={timeRows} margin={{ left: 4, right: 0, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" {...axis} minTickGap={slot === "hour" ? 8 : 0} interval={slot === "hour" ? "preserveStartEnd" : 0} tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="n" {...axis} width={48} tickFormatter={(v) => (v >= 1000 ? v / 1000 + "k" : v)} />
                    <YAxis yAxisId="r" orientation="right" {...axis} width={44} domain={[0, "auto"]} tickFormatter={(v) => v + "%"} />
                    <ChartTooltip content={<ChartTooltipContent formatter={(value, name, item) => rowFormatter(timeConfig, name === "measured" ? "" : "%")(value, name, item)} />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar yAxisId="n" isAnimationActive={false} dataKey="measured" fill="var(--color-measured)" fillOpacity={0.35} radius={[3, 3, 0, 0]} />
                    <Line yAxisId="r" dataKey="read_pct" type="monotone" stroke="var(--color-read_pct)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
                    <Line yAxisId="r" dataKey="replied_pct" type="monotone" stroke="var(--color-replied_pct)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
                  </ComposedChart>
                </ChartContainer>
                ) : (
                <ChartContainer config={timeConfig} className="h-[260px] w-full">
                  <BarChart data={timeRows} margin={{ left: 4, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" {...axis} minTickGap={slot === "hour" ? 8 : 0} interval={slot === "hour" ? "preserveStartEnd" : 0} tick={{ fontSize: 11 }} />
                    <YAxis {...axis} width={48} tickFormatter={(v) => (metric === "measured" ? (v >= 1000 ? v / 1000 + "k" : v) : v + "%")} />
                    <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(timeConfig, metric === "measured" ? "" : "%")} />} />
                    <Bar isAnimationActive={false} dataKey={metric} fill={`var(--color-${metric})`} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartContainer>
                )
              )}
            </ChartCard>
          </div>

          <ChartCard title="Templates" description="Click a row to filter this whole page to that template. Failed turns red when it passes the limit we set. Each person counts once per template, so a rate cannot pass 100%."
            actions={<span className="text-xs text-muted-foreground">{tpl.data ? `${tpl.data.rows.length} templates` : ""}</span>}>
            {tpl.error ? <ErrorNote message={tpl.error} /> : !tpl.data ? <ChartSkeleton /> : (
              <SortableTable rows={tpl.data.rows} cols={tplCols} rowKey={(r) => r.template_name} initialSort="measured" searchText={(r) => r.template_name} searchPlaceholder="Search templates" maxHeight="30rem"
                onRowClick={(r) => set({ templates: [r.template_name] })} />
            )}
          </ChartCard>

          <div className="grid gap-4">
            <FailureReasonsCard params={params} />
            <ChartCard title="Failure rate by month" description="The six templates with the most failures. Failures come in bursts rather than steadily.">
              {fail.error ? <ErrorNote message={fail.error} /> : !fail.data ? <ChartSkeleton /> : failChart.data.length === 0 ? <Empty>No failures in this selection.</Empty> : (
                <ChartContainer config={failChart.config} className="h-[280px] w-full">
                  <LineChart data={failChart.data} margin={{ left: 4, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" {...axis} minTickGap={20} />
                    <YAxis {...axis} width={44} tickFormatter={(v) => v + "%"} />
                    <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(failChart.config, "%")} />} />
                    {failChart.names.map((_, i) => <Line key={i} dataKey={"t" + i} type="linear" stroke={`var(--color-t${i})`} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />)}
                  </LineChart>
                </ChartContainer>
              )}
              {failChart.names.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {failChart.names.map((n, i) => <li key={n} className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px]" style={{ background: PALETTE[i % PALETTE.length] }} />{n}</li>)}
                </ul>
              )}
            </ChartCard>

            <ChartCard title="Who it reaches" description={by === "source" ? "Rates by the lead's source. Messages to numbers that are not leads are grouped separately." : "Rates by the lead's owner."}
              actions={<Tabs value={by} onValueChange={(v) => setBy(v as "source" | "owner")}><TabsList><TabsTrigger value="source">Lead source</TabsTrigger><TabsTrigger value="owner">Owner</TabsTrigger></TabsList></Tabs>}>
              {brk.error ? <ErrorNote message={brk.error} /> : !brk.data ? <ChartSkeleton /> : (
                <SortableTable rows={brk.data.rows} cols={brkCols} rowKey={(r) => r.label} initialSort="measured" maxHeight="22rem" />
              )}
            </ChartCard>
          </div>

          </div>
          <details className="rounded-xl border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">How these numbers are defined</summary>
            <dl className="mt-3 grid gap-x-8 gap-y-3 md:grid-cols-2">
              <div><dt className="font-medium">Messages followed</dt><dd className="text-muted-foreground">Sent plus failed, minus repeat sends. When the same template goes to the same number again, only the first message is tracked, so the later ones cannot be followed.</dd></div>
              <div><dt className="font-medium">Delivered, read</dt><dd className="text-muted-foreground">The highest of the delivered, read and replied counters for each row. A message that was read or replied to must have been delivered, and the raw delivered counter misses many events. These are lower bounds.</dd></div>
              <div><dt className="font-medium">Dates</dt><dd className="text-muted-foreground">A message is dated by its first send to that person for that template. This is the same rule the earlier dashboard used.</dd></div>
              <div><dt className="font-medium">Compared with the previous period</dt><dd className="text-muted-foreground">When a date range is set, each rate is compared with the same number of days just before it. Green is better, red is worse.</dd></div>
            </dl>
          </details>
        </>
      )}
    </div>
  )
}
