import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { ChartColumn, Table2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { axis } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, SortableTable, type Col } from "@/components/kit"
import { useApi, type Params } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { duration, num, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

const LIMIT_FAILED = 5          // same limit as the Messages page: failed share (%) above which a template turns red
const MIN_TEMPLATE = 200        // a template needs this many followed messages to be judged
const MIN_CELL = 50             // a weekday-and-hour slot needs this many messages before its rate is shown
const MIN_BEST = 300            // ...and this many before it can be named a best slot, so a lucky small slot does not win

type Tone = "bad" | "warn" | "good" | "mute"
const TONE: Record<Tone, string> = { bad: "var(--bad)", warn: "var(--warn)", good: "var(--good)", mute: "var(--muted-foreground)" }

/* ---------------- template map ---------------- */
function judge(r: any, all: { delivered: number; read: number; replied: number }): { label: string; tone: Tone } | null {
  if (r.measured < MIN_TEMPLATE) return null
  if (r.failed_pct > LIMIT_FAILED) return { label: "Many failures", tone: "bad" }
  if (r.measured >= 500 && r.delivered_pct < 0.75 * all.delivered) return { label: "Poor delivery", tone: "warn" }
  if (r.read_pct >= all.read && r.replied_pct < 0.5 * all.replied) return { label: "Read, rarely replied", tone: "warn" }
  if (r.replied_pct >= 1.5 * all.replied) return { label: "Strong replies", tone: "good" }
  return null
}

export function TemplateTable({ params }: { params: Params }) {
  const { set } = useFilters()
  const tpl = useApi<any>("messages/templates", params)

  const view = useMemo(() => {
    const rows: any[] = tpl.data?.rows ?? []
    const sum = (k: string) => rows.reduce((s, r) => s + r[k], 0)
    const m = sum("measured")
    const all = { delivered: m ? (100 * sum("delivered")) / m : 0, read: m ? (100 * sum("read")) / m : 0, replied: m ? (100 * sum("replied")) / m : 0 }
    const points = rows.map((r) => ({ ...r, small: r.measured < MIN_TEMPLATE, flag: judge(r, all) }))
    return { all, points, small: points.filter((r) => r.small).length }
  }, [tpl.data])

  const cols: Col<any>[] = [
    { key: "template_name", header: "Template", value: (r) => r.template_name, className: "max-w-[10rem] whitespace-normal break-all" },
    { key: "measured", header: "Messages", align: "right", value: (r) => r.measured, render: (r) => num(r.measured) },
    { key: "read_pct", header: "Read", align: "right", value: (r) => r.read_pct, render: (r) => pct(r.read_pct) },
    { key: "replied_pct", header: "Replied", align: "right", value: (r) => r.replied_pct, render: (r) => pct(r.replied_pct) },
    { key: "flag", header: "Why", value: (r) => r.flag?.label ?? (r.small ? "Too few messages" : ""), className: "whitespace-nowrap",
      render: (r) => r.flag ? <span className="font-medium" style={{ color: TONE[r.flag.tone as Tone] }}>{r.flag.label}</span> : r.small ? <span className="text-muted-foreground">Too few messages</span> : <span className="text-muted-foreground">—</span> },
  ]

  return (
    <ChartCard title="Templates" description={tpl.data ? `All ${view.points.length} templates. Average: ${pct(view.all.read)} read, ${pct(view.all.replied)} replied. Click a row to filter the page to that template. Each person counts once per template.` : "Click a row to filter the page to that template."}>
      {tpl.error ? <ErrorNote message={tpl.error} /> : !tpl.data ? <ChartSkeleton h={420} /> : view.points.length === 0 ? <Empty>No templates were sent in this selection.</Empty> : (
        <div className="flex flex-col gap-2">
          <SortableTable rows={view.points} cols={cols} rowKey={(r) => r.template_name} initialSort="measured" maxHeight="17rem" onRowClick={(r) => set({ templates: [r.template_name] })} searchText={(r) => r.template_name} searchPlaceholder="Search templates" />
          <ul className="mt-1 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
            <li><span className="font-medium" style={{ color: TONE.bad }}>Many failures</span>: over {LIMIT_FAILED}% failed.</li>
            <li><span className="font-medium" style={{ color: TONE.warn }}>Poor delivery</span>: a quarter below average.</li>
            <li><span className="font-medium" style={{ color: TONE.warn }}>Read, rarely replied</span>: read like average, replied under half as often.</li>
            <li><span className="font-medium" style={{ color: TONE.good }}>Strong replies</span>: 1.5 times the average.</li>
            <li className="sm:col-span-2">{view.small} templates have fewer than {MIN_TEMPLATE} messages and are not judged.</li>
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

/* ---------------- response time and pipeline age ---------------- */
const BUCKETS = ["Under 5 min", "5 to 60 min", "1 to 6 hours", "6 to 24 hours", "1 to 3 days", "Over 3 days"]
const AGE_COLOR = ["var(--c1)", "var(--c1)", "var(--warn)", "var(--bad)"]

/** Two follow-up questions that the headline numbers leave open: how fast do customers respond, and how stale is the pipeline */
export function ResponseAndAging({ params, oppParams }: { params: Params; oppParams: Params }) {
  const [tab, setTab] = useState<"reply" | "read" | "age">("reply")
  const rt = useApi<any>("messages/reply-time", params)
  const age = useApi<any>("opps/aging", oppParams)
  const kind = tab === "age" ? null : tab

  const body = () => {
    if (kind) {
      if (rt.error) return <ErrorNote message={rt.error} />
      if (!rt.data) return <ChartSkeleton h={300} />
      const d = rt.data[kind]
      if (!d.total) return <Empty>No messages in this group for these filters.</Empty>
      return (
        <div className="flex h-full flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold">{duration(d.median_min)}</div><div className="text-xs text-muted-foreground">{kind === "reply" ? "half reply faster than this" : "half were last touched sooner"}</div></div>
            <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold">{pct(d.within_day_pct, 0)}</div><div className="text-xs text-muted-foreground">within a day</div></div>
            <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold">{num(d.total)}</div><div className="text-xs text-muted-foreground">messages</div></div>
          </div>
          <div className="flex flex-1 flex-col justify-center"><BarList rows={d.buckets.map((b: any) => ({ label: BUCKETS[b.ord - 1], value: b.share ?? 0, text: `${pct(b.share, 1)} · ${num(b.n)}` }))} max={100}
            colorFor={() => (kind === "reply" ? "var(--good)" : "var(--c1)")} /></div>
          <p className="mt-auto text-xs text-muted-foreground">An estimate: the time from our message to the last action the customer took on it. Only messages sent once to a person are counted.</p>
        </div>
      )
    }
    if (age.error) return <ErrorNote message={age.error} />
    if (!age.data) return <ChartSkeleton h={300} />
    const rows: { bucket: string; opportunities: number }[] = age.data.rows
    const total = rows.reduce((t, r) => t + r.opportunities, 0)
    const old = rows.slice(2).reduce((t, r) => t + r.opportunities, 0)
    if (!total) return <Empty>No opportunities are waiting at New.</Empty>
    return (
      <div className="flex h-full flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold">{num(total)}</div><div className="text-xs text-muted-foreground">still at New</div></div>
          <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold" style={{ color: "var(--bad)" }}>{num(old)}</div><div className="text-xs text-muted-foreground">older than 30 days</div></div>
          <div className="rounded-lg border px-3 py-2.5"><div className="tnum text-2xl font-semibold">{pct(100 * old / total, 0)}</div><div className="text-xs text-muted-foreground">of them are old</div></div>
        </div>
        <div className="flex flex-1 flex-col justify-center"><BarList rows={rows.map((r) => ({ label: r.bucket.charAt(0).toUpperCase() + r.bucket.slice(1), value: r.opportunities, text: `${num(r.opportunities)} · ${pct(100 * r.opportunities / total, 1)}` }))} colorFor={(_, i) => AGE_COLOR[i] ?? "var(--c1)"} /></div>
        <p className="mt-auto text-xs text-muted-foreground">Age is counted from the day the opportunity was created. The date filter does not apply here, because this is the pipeline as it stands today. Lead owner and status filters do.</p>
      </div>
    )
  }

  return (
    <ChartCard title={tab === "age" ? "How old are the open opportunities" : "How long customers take to respond"}
      description={tab === "age" ? "Opportunities still at status New, by how long they have been waiting." : "How quickly customers answer or open a message after we send it."}
      actions={<Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}><TabsList><TabsTrigger value="reply">Replies</TabsTrigger><TabsTrigger value="read">Read, no reply</TabsTrigger><TabsTrigger value="age">Pipeline age</TabsTrigger></TabsList></Tabs>}>
      {body()}
    </ChartCard>
  )
}

/* ---------------- best time to send ---------------- */
type TimeMetric = "measured" | "read_pct" | "replied_pct" | "all"
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DOW = [1, 2, 3, 4, 5, 6, 0]    // database weekday numbers (0 = Sunday) in Monday-first order
const METRIC: Record<TimeMetric, { label: string; color: string }> = {
  measured: { label: "Messages sent", color: "var(--c1)" },
  read_pct: { label: "Read rate", color: "var(--c1)" },
  replied_pct: { label: "Reply rate", color: "var(--good)" },
  all: { label: "All three", color: "var(--c1)" },   // messages as bars, read and reply rate as lines
}
const clock = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`

export function SendTimeChart({ params }: { params: Params }) {
  const [metric, setMetric] = useState<TimeMetric>("measured")
  const [day, setDay] = useState("All")
  const [view, setView] = useState<"chart" | "table">("chart")
  const hm = useApi<any>("messages/heatmap", params)
  const all = metric === "all"
  const isRate = metric === "read_pct" || metric === "replied_pct"
  const rank = all ? "measured" : metric      // what "best" is judged on; in the combined view that is volume

  const hours = useMemo(() => {
    const rows = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: clock(h), n: 0, read: 0, replied: 0 }))
    for (const c of hm.data?.cells ?? []) if (day === "All" || DAYS[DOW.indexOf(c.dow)] === day) { const r = rows[c.hour]; r.n += c.measured; r.read += c.read; r.replied += c.replied }
    const rate = (n: number, v: number) => (n >= MIN_CELL ? Math.round((1000 * v) / n) / 10 : null)
    return rows.map((r) => ({ ...r, measured: r.n, read_pct: rate(r.n, r.read), replied_pct: rate(r.n, r.replied) }))
  }, [hm.data, day])

  const total = hours.reduce((t, r) => t + r.n, 0)
  const best = useMemo(() => {
    const pool = hours.filter((r) => (isRate ? r.n >= MIN_BEST && r[rank] != null : r.n > 0))
    return pool.length ? pool.reduce((a, b) => ((b[rank] ?? 0) > (a[rank] ?? 0) ? b : a)) : null
  }, [hours, rank, isRate])
  const fmt = (v: number | null) => (v == null ? "—" : isRate ? pct(v) : num(v))
  const who = day === "All" ? "" : ` on ${day}s`
  const sub = !total ? "No messages in this selection" : !best ? `${num(total)} messages${who} · not enough in any hour to compare rates`
    : isRate ? `${num(total)} messages${who} · ${METRIC[metric].label.toLowerCase()} is highest around ${clock(best.hour)} (${pct(best[metric])})` : `${num(total)} messages${who} · busiest around ${clock(best.hour)}${all ? ", with read and reply rate alongside" : ""}`

  const cfg: ChartConfig = all
    ? { measured: { label: "Messages sent", color: METRIC.measured.color }, read_pct: { label: "Read rate", color: "var(--c2)" }, replied_pct: { label: "Reply rate", color: METRIC.replied_pct.color } }
    : { [metric]: { label: METRIC[metric].label, color: METRIC[metric].color } }
  const cols: Col<any>[] = [
    { key: "hour", header: "Time", value: (r) => r.hour, render: (r) => r.label },
    { key: "measured", header: "Messages", align: "right", value: (r) => r.n, render: (r) => num(r.n) },
    { key: "read_pct", header: "Read", align: "right", value: (r) => r.read_pct, render: (r) => pct(r.read_pct) },
    { key: "replied_pct", header: "Replied", align: "right", value: (r) => r.replied_pct, render: (r) => pct(r.replied_pct) },
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><ChartColumn className="size-4" /></span>
          <div className="min-w-0 flex-1"><CardTitle>Best time to send</CardTitle><CardDescription>{sub}. Times are India time.</CardDescription></div>
          <div className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5" role="group" aria-label="Show as">
            {([["chart", ChartColumn, "Chart"], ["table", Table2, "Table"]] as const).map(([k, Icon, label]) => (
              <button key={k} type="button" aria-pressed={view === k} aria-label={label} title={label} onClick={() => setView(k)} className={cn("rounded-md p-1.5 text-muted-foreground", view === k && "bg-background text-foreground shadow-sm")}><Icon className="size-4" /></button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={metric} onValueChange={(v) => setMetric(v as TimeMetric)}><TabsList>{(Object.keys(METRIC) as TimeMetric[]).map((m) => <TabsTrigger key={m} value={m}>{METRIC[m].label}</TabsTrigger>)}</TabsList></Tabs>
          <Tabs value={day} onValueChange={setDay}><TabsList><TabsTrigger value="All">All days</TabsTrigger>{DAYS.map((d) => <TabsTrigger key={d} value={d}>{d}</TabsTrigger>)}</TabsList></Tabs>
        </div>
        {hm.error ? <ErrorNote message={hm.error} /> : !hm.data ? <ChartSkeleton h={300} /> : view === "table" ? (
          <SortableTable rows={hours.filter((r) => r.n > 0)} cols={cols} rowKey={(r) => String(r.hour)} initialSort="hour" initialDir="asc" maxHeight="22rem" />
        ) : all ? (
          <ChartContainer config={cfg} className="aspect-auto h-[300px] w-full">
            <ComposedChart data={hours} margin={{ left: 0, right: 0, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} interval={2} tick={{ fontSize: 12 }} />
              <YAxis yAxisId="n" {...axis} width={48} domain={[0, "auto"]} tickFormatter={(v) => (v >= 1000 ? v / 1000 + "k" : v)} />
              <YAxis yAxisId="r" orientation="right" {...axis} width={44} domain={[0, "auto"]} tickFormatter={(v) => v + "%"} />
              <ChartTooltip cursor={false} content={({ active, payload }) => {
                const r = active && (payload?.[0]?.payload as any)
                if (!r) return null
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="mb-1 font-medium">{r.label}{day === "All" ? "" : `, ${day}`}</div>
                    <div className="tnum text-muted-foreground">{num(r.n)} messages</div>
                    {r.n >= MIN_CELL ? <div className="tnum text-muted-foreground">read {pct(r.read_pct)} · replied {pct(r.replied_pct)}</div> : r.n > 0 && <div className="text-muted-foreground">too few to show rates</div>}
                  </div>
                )
              }} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar yAxisId="n" dataKey="measured" fill="var(--color-measured)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={30} isAnimationActive={false} />
              <Line yAxisId="r" dataKey="read_pct" type="monotone" stroke="var(--color-read_pct)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
              <Line yAxisId="r" dataKey="replied_pct" type="monotone" stroke="var(--color-replied_pct)" strokeWidth={2} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <ChartContainer config={cfg} className="aspect-auto h-[300px] w-full">
            <BarChart data={hours} margin={{ left: 0, right: 8, top: 8 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} interval={2} tick={{ fontSize: 12 }} />
              <YAxis {...axis} width={isRate ? 44 : 48} domain={[0, "auto"]} tickFormatter={(v) => (isRate ? v + "%" : v >= 1000 ? v / 1000 + "k" : v)} />
              <ChartTooltip cursor={false} content={({ active, payload }) => {
                const r = active && (payload?.[0]?.payload as any)
                if (!r) return null
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="mb-1 font-medium">{r.label}{day === "All" ? "" : `, ${day}`}</div>
                    <div className="tnum text-muted-foreground">{num(r.n)} messages</div>
                    {r.n >= MIN_CELL ? <div className="tnum text-muted-foreground">read {pct(r.read_pct)} · replied {pct(r.replied_pct)}</div> : r.n > 0 && <div className="text-muted-foreground">too few to show rates</div>}
                  </div>
                )
              }} />
              <Bar dataKey={metric} fill={METRIC[metric].color} radius={[4, 4, 0, 0]} maxBarSize={30} background={{ fill: "var(--muted)", fillOpacity: 0.45, radius: 4 }} isAnimationActive={false} />
            </BarChart>
          </ChartContainer>
        )}
        {(isRate || all) && view === "chart" && <p className="-mt-2 text-xs text-muted-foreground">A rate is only shown for an hour with at least {MIN_CELL} messages{all ? ", so the lines can have gaps. Bars use the left scale, lines the right one" : `, and only hours with at least ${MIN_BEST} messages can be named the best`}.</p>}
      </CardContent>
    </Card>
  )
}

/* ---------------- team scorecard ---------------- */
// Lead owners and opportunity owners are mostly different people, so they get a tab each instead of one merged table.
export function TeamScorecard({ params }: { params: Params }) {
  const [who, setWho] = useState<"leads" | "opps">("leads")
  const leads = useApi<any>("leads/owners", params)
  const opps = useApi<any>("opps/owners", params)

  const leadCols: Col<any>[] = [
    { key: "owner", header: "Lead owner", value: (r) => r.owner },
    { key: "leads", header: "Leads", align: "right", value: (r) => r.leads, render: (r) => num(r.leads) },
    { key: "welcome_pct", header: "Welcome sent", align: "right", value: (r) => r.welcome_pct, render: (r) => pct(r.welcome_pct), hint: "Share of this owner's leads that got the welcome message." },
    { key: "followup_24h_pct", header: "24-hour follow-up", align: "right", value: (r) => r.followup_24h_pct, render: (r) => pct(r.followup_24h_pct) },
    { key: "qualified", header: "Qualified now", align: "right", value: (r) => r.qualified, render: (r) => num(r.qualified), hint: "Leads whose current status is Qualified." },
    { key: "to_nurturing", header: "Moved to nurturing", align: "right", value: (r) => r.to_nurturing, render: (r) => num(r.to_nurturing) },
    { key: "to_not_connected", header: "Moved to not connected", align: "right", value: (r) => r.to_not_connected, render: (r) => num(r.to_not_connected) },
    { key: "to_unqualified", header: "Moved to unqualified", align: "right", value: (r) => r.to_unqualified, render: (r) => num(r.to_unqualified) },
  ]
  const oppCols: Col<any>[] = [
    { key: "owner", header: "Opportunity owner", value: (r) => r.owner },
    { key: "opportunities", header: "Opportunities", align: "right", value: (r) => r.opportunities, render: (r) => num(r.opportunities) },
    { key: "won", header: "Won", align: "right", value: (r) => r.won, render: (r) => num(r.won) },
    { key: "lost", header: "Lost", align: "right", value: (r) => r.lost, render: (r) => num(r.lost) },
    { key: "win_rate", header: "Win rate", align: "right", value: (r) => r.win_rate, hint: "Won divided by won plus lost. Open opportunities are not counted, so a small number of closed deals can give a very high or low rate.",
      render: (r) => r.win_rate == null ? "—" : <span className="inline-flex items-center justify-end gap-2"><span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${r.win_rate}%`, background: "var(--good)" }} /></span>{pct(r.win_rate)}</span> },
    { key: "stale_new", header: "Gone quiet", align: "right", value: (r) => r.stale_new, render: (r) => num(r.stale_new), cellClass: (r) => (r.stale_new > 0 ? "font-medium text-warn" : undefined), hint: "Opportunities still at status New after more than 30 days. They are probably forgotten." },
  ]
  const cur = who === "leads" ? leads : opps

  return (
    <ChartCard title="Team scorecard" description={who === "leads" ? "How each lead owner is doing with their leads. Click a column title to sort." : "How each salesperson is doing with their opportunities. Click a column title to sort."}
      actions={<Tabs value={who} onValueChange={(v) => setWho(v as "leads" | "opps")}><TabsList><TabsTrigger value="leads">Lead owners</TabsTrigger><TabsTrigger value="opps">Opportunity owners</TabsTrigger></TabsList></Tabs>}>
      {cur.error ? <ErrorNote message={cur.error} /> : !cur.data ? <ChartSkeleton h={200} /> : who === "leads" ? (
        <SortableTable key="leads" rows={cur.data.rows} cols={leadCols} rowKey={(r) => r.owner} initialSort="leads" maxHeight="26rem" searchText={(r) => r.owner} searchPlaceholder="Search owners" />
      ) : (
        <SortableTable key="opps" rows={cur.data.rows} cols={oppCols} rowKey={(r) => r.owner} initialSort="opportunities" maxHeight="26rem" searchText={(r) => r.owner} searchPlaceholder="Search owners" />
      )}
    </ChartCard>
  )
}
