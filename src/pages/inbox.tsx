import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, XAxis, YAxis } from "recharts"
import { differenceInCalendarDays, format, parseISO, subDays } from "date-fns"
import { Clock, Download, Hourglass, Inbox as InboxIcon, Info, MessagesSquare, UserCheck, Users, UserX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis, rowFormatter } from "@/components/charts"
import { ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { useSeen } from "@/components/lazy"
import { api, useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useReveal } from "@/lib/reveal"
import { day, duration, hourLabel, num, one, pct, periodLabel, ppDelta, relDelta } from "@/lib/format"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const when = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
/** one CSV cell. Text starting with = + - @ would be read as a formula by Excel, so it gets a quote in front. */
const cell = (v: unknown) => { let t = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
const waited =(h: number) => (h < 1 ? "under an hour" : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`)

const cfg: ChartConfig = { assigned: { label: "Assigned", color: "var(--c1)" }, unassigned: { label: "Unassigned", color: "var(--warn)" } }
const durCfg: ChartConfig = { chats: { label: "Chats", color: "var(--c1)" }, avg_min: { label: "Average length", color: "var(--c4)" } }
const SERIES = [
  { key: "total", label: "All chats", color: "var(--c2)" },
  { key: "assigned", label: "Assigned", color: "var(--c1)" },
  { key: "unassigned", label: "Unassigned", color: "var(--warn)" },
] as const
type SeriesKey = (typeof SERIES)[number]["key"]
const lineCfg: ChartConfig = Object.fromEntries(SERIES.flatMap((s) => [[s.key, { label: s.label, color: s.color }], ["prev_" + s.key, { label: s.label + " (before)", color: s.color }]]))

/** weekday x hour grid, shaded by count */
export function Heat({ cells, kind }: { cells: any[]; kind: "chats" | "unassigned" }) {
  const order = [1, 2, 3, 4, 5, 6, 0]   // Monday first
  const get = (d: number, h: number) => cells.find((c) => c.dow === d && c.hour === h)?.[kind] ?? 0
  const max = Math.max(1, ...cells.map((c) => c[kind]))
  const color = kind === "chats" ? "var(--c1)" : "var(--warn)"
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[2.2rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-muted-foreground">
        <span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="overflow-visible whitespace-nowrap">{h % 6 === 0 ? hourLabel(h) : ""}</span>)}
      </div>
      {order.map((d) => (
        <div key={d} className="grid grid-cols-[2.2rem_repeat(24,minmax(0,1fr))] items-center gap-[2px]">
          <span className="text-xs text-muted-foreground">{WEEKDAYS[d]}</span>
          {Array.from({ length: 24 }, (_, h) => { const n = get(d, h); return <span key={h} title={`${WEEKDAYS[d]} ${hourLabel(h)}: ${n} chat${n === 1 ? "" : "s"}`} className="aspect-square rounded-[3px] bg-muted/50" style={n ? { background: color, opacity: 0.2 + 0.8 * (n / max) } : undefined} /> })}
        </div>
      ))}
      <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">Few<span className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(to right, color-mix(in oklab, ${color} 20%, transparent), ${color})` }} />Most: {max} in one hour</div>
    </div>
  )
}

/** a small on/off pill, used for the chart's series and the compare switch */
export function Pill({ on, onClick, color, children, disabled, title }: { on: boolean; onClick: () => void; color?: string; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} title={title} onClick={onClick}
      className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50", on ? "border-foreground/30 bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
      {color && <span className="size-2.5 rounded-[2px] border" style={{ background: on ? color : "transparent", borderColor: color }} />}
      {children}
    </button>
  )
}

export default function Inbox() {
  const { params, filters, meta } = useFilters()
  const { reveal } = useReveal()
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string>()
  const [slot, setSlot] = useState<"hours" | "weekdays">("hours")
  const [shown, setShown] = useState<Record<SeriesKey, boolean>>({ total: true, assigned: true, unassigned: true })
  const [compare, setCompare] = useState(false)
  const kpis = useApi<any>("inbox/kpis", params)
  const cov = kpis.data?.coverage
  const [grain, setGrain] = useAutoGrain(filters.from ?? cov?.from_day, filters.to ?? cov?.to_day)   // with no range picked, size the grain to what the log covers
  const trend = useApi<any>("inbox/trend", { ...params, grain })
  const [lowRef, low] = useSeen()   // the lower half of the page asks the server only once you scroll near it
  const ops = useApi<any>(low ? "inbox/operators" : null, params)
  const byTime = useApi<any>(low ? "inbox/by-time" : null, params)
  const waiting = useApi<any>(low ? "inbox/waiting" : null, { ...params, reveal: reveal ? 1 : undefined })
  const dur = useApi<any>(low ? "inbox/duration" : null, { ...params, grain })
  const heat = useApi<any>(low ? "inbox/heatmap" : null, params)
  const [heatKind, setHeatKind] = useState<"chats" | "unassigned">("chats")
  const c = kpis.data?.current, p = kpis.data?.previous
  const hasPrev = !!p && p.chats > 0

  const prevRange = useMemo(() => {
    if (!filters.from || !filters.to) return null
    const a = parseISO(filters.from), len = differenceInCalendarDays(parseISO(filters.to), a) + 1, to = subDays(a, 1)
    return { from: format(subDays(to, len - 1), "yyyy-MM-dd"), to: format(to, "yyyy-MM-dd") }
  }, [filters.from, filters.to])
  const prevTrend = useApi<any>(compare && prevRange ? "inbox/trend" : null, { ...params, ...prevRange, grain })
  const trendRows = (trend.data?.rows ?? []).map((r: any, i: number) => {
    const b = compare && prevRange ? prevTrend.data?.rows?.[i] : null   // lined up by position: day 1 against day 1 of the period before
    return { label: periodLabel(r.period, grain), total: r.chats, assigned: r.assigned, unassigned: r.unassigned, prev_total: b?.chats, prev_assigned: b?.assigned, prev_unassigned: b?.unassigned }
  })
  const timeRows = useMemo(() => (byTime.data?.[slot] ?? []).map((r: any) => ({ ...r, label: slot === "hours" ? hourLabel(r.k) : WEEKDAYS[r.k] })), [byTime.data, slot])
  const donut = c ? [{ key: "assigned", value: c.assigned }, { key: "unassigned", value: c.unassigned }] : []
  const assignedTotal = (ops.data?.rows ?? []).reduce((s: number, r: any) => s + r.chats, 0)

  const opCols: Col<any>[] = [
    { key: "operator", header: "Team member", value: (r) => r.operator, render: (r) => <span className={r.operator === "Name not recorded" ? "text-muted-foreground" : "font-medium"}>{r.operator}</span> },
    { key: "chats", header: "Chats", align: "right", value: (r) => r.chats, render: (r) => num(r.chats) },
    { key: "share", header: "Share of assigned", align: "right", value: (r) => r.chats, render: (r) => pct(assignedTotal ? (100 * r.chats) / assignedTotal : null) },
  ]
  /** Downloads every waiting chat (not just the 200 on screen) as a CSV. Full numbers only while "Show phone numbers" is on. */
  const exportCsv = async () => {
    setExporting(true); setExportErr(undefined)
    try {
      const d = await api<any>("inbox/waiting", { ...params, reveal: reveal ? 1 : undefined, limit: 5000 })
      const head = ["Customer", "Phone", "Messages", "First message", "Latest message", "Waiting (hours)"]
      const body = d.rows.map((r: any) => [
        cell(r.customer),
        d.revealed && r.phone ? `="${r.phone}"` : cell(r.phone),   // ="..." keeps Excel from turning the number into 9.19E+11
        cell(r.msgs), cell(r.first_at?.replace("T", " ")), cell(r.last_at?.replace("T", " ")), cell(r.age_hours),
      ])
      const text = "﻿" + [head.map(cell), ...body].map((l) => l.join(",")).join("\r\n")   // BOM so Excel reads Hindi names correctly
      const a = document.createElement("a")
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
      a.download = `chats-waiting-${format(new Date(), "yyyy-MM-dd")}${d.revealed ? "" : "-masked"}.csv`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e: any) { setExportErr(e.message) } finally { setExporting(false) }
  }
  const canReveal = !!meta?.canReveal && waiting.data?.canReveal !== false
  const waitCols: Col<any>[] = [
    { key: "customer", header: "Customer", value: (r) => r.customer, render: (r) => <span className="block max-w-[8.5rem] truncate font-medium" title={r.customer}>{r.customer}</span> },
    { key: "phone", header: "Phone", value: (r) => r.phone, render: (r) => <span className="whitespace-nowrap">{r.phone}</span> },
    { key: "msgs", header: "Messages", align: "right", value: (r) => r.msgs, render: (r) => <span className={r.msgs > 1 ? "font-medium text-warn" : undefined}>{num(r.msgs)}</span>, hint: "Messages the customer has sent in this chat. More than one means they wrote again and still nobody picked it up." },
    { key: "last", header: "Latest message", value: (r) => r.last_at, render: (r) => <span className="whitespace-nowrap">{when(r.last_at)}</span> },
    { key: "age", header: "Waiting", align: "right", value: (r) => r.age_hours, render: (r) => <span className="whitespace-nowrap">{waited(r.age_hours)}</span>, hint: "Time from the customer's first message to the newest message in the log." },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Inbox" description="Who owns each WhatsApp chat. A chat is one conversation in the WATI inbox. Unassigned means nobody on the team has taken it yet." />
      <FilterBar kinds={[]} reveal />
      <ErrorNote message={kpis.error} />
      {cov && <p className="-mt-3 text-sm text-muted-foreground">The chat log covers {day(cov.from_day)} to {day(cov.to_day)}. Earlier days are not in it, so figures outside that range show as empty, not zero.</p>}

      <ScoreGrid cols={4} stats={[
        { icon: InboxIcon, label: "Chats", loading: !c, value: num(c?.chats), delta: hasPrev ? { value: relDelta(c.chats, p.chats), goodWhen: "up", unit: "%" } : undefined, foot: c && `${num(c.customers)} customers wrote in` },
        { icon: UserCheck, label: "Assigned", loading: !c, value: num(c?.assigned), tone: "good", meter: c?.assigned_pct, delta: hasPrev ? { value: ppDelta(c.assigned_pct, p.assigned_pct), goodWhen: "up" } : undefined, foot: c && `${pct(c.assigned_pct)} of chats`, hint: "A chat counts as assigned when a team member was its owner at the customer's latest message." },
        { icon: UserX, label: "Unassigned", loading: !c, value: num(c?.unassigned), tone: c && c.unassigned_pct > 50 ? "bad" : "warn", meter: c?.unassigned_pct, delta: hasPrev ? { value: ppDelta(c.unassigned_pct, p.unassigned_pct), goodWhen: "down" } : undefined, foot: c && `${pct(c.unassigned_pct)} of chats`, hint: "Nobody on the team owned these chats when the customer last wrote. The log only records customer messages, so a chat assigned after the customer's last message still shows here. The real figure can be lower." },
        { icon: Hourglass, label: "Wrote again, no owner", loading: !c, value: num(c?.unassigned_repeat), tone: "bad", meter: c && c.unassigned ? (100 * c.unassigned_repeat) / c.unassigned : null, foot: c && `${pct(c.unassigned ? (100 * c.unassigned_repeat) / c.unassigned : null)} of unassigned`, hint: "Customers who sent more than one message and still had no owner. These are the ones most likely to be left waiting." },
        { icon: Clock, label: "Customer window closed", loading: !c, value: num(c?.window_closed), tone: "warn", meter: c?.window_closed_pct, foot: c && `${pct(c.window_closed_pct)} of chats`, hint: "The customer's last message was more than 24 hours before the newest message in the log. After that WhatsApp only allows paid template messages, not free replies. This is our own measure, not WATI's Expired count." },
        { icon: UserX, label: "Missed chances", loading: !c, value: num(c?.unassigned_closed), tone: "bad", meter: c?.unassigned_closed_pct, foot: c && `${pct(c.unassigned_closed_pct)} of unassigned`, hint: "Customers who wrote, were never picked up, and can no longer be answered for free. These are the missed chances." },
        { icon: Users, label: "Team members with chats", loading: !c, value: num(c?.operators), foot: "took at least one chat" },
        { icon: MessagesSquare, label: "Messages per chat", loading: !c, value: one(c?.msgs_per_chat), foot: c && `${num(c.messages)} customer messages` },
      ]} />

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Chats over time" description="Tick the lines you want to see. Hover a point for the exact numbers."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {trend.error ? <ErrorNote message={trend.error} /> : !trend.data ? <ChartSkeleton h={320} /> : (
            <div className="flex flex-col gap-3">
              <ChartContainer config={lineCfg} className="h-[260px] w-full">
                <ComposedChart data={trendRows} margin={{ left: 4, right: 12, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" {...axis} minTickGap={24} />
                  <YAxis {...axis} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(lineCfg)} />} />
                  {SERIES.filter((s) => shown[s.key]).map((s) => <Area key={s.key} dataKey={s.key} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.1} strokeWidth={2} dot={{ r: 3, fill: s.color }} activeDot={{ r: 5 }} isAnimationActive={false} />)}
                  {compare && prevRange && SERIES.filter((s) => shown[s.key]).map((s) => <Line key={"prev_" + s.key} dataKey={"prev_" + s.key} type="monotone" stroke={s.color} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />)}
                </ComposedChart>
              </ChartContainer>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Lines to show">
                {SERIES.map((s) => <Pill key={s.key} on={shown[s.key]} color={s.color} onClick={() => setShown((v) => ({ ...v, [s.key]: !v[s.key] }))}>{s.label}</Pill>)}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                <Pill on={compare && !!prevRange} disabled={!prevRange} onClick={() => setCompare((v) => !v)} title={prevRange ? undefined : "Pick a date range first, then this compares it with the period before"}>Compare with previous period</Pill>
              </div>
            </div>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="Assigned or not" description="Share of all chats in this selection.">
          {!c ? <ChartSkeleton h={260} /> : c.chats === 0 ? <Empty>No chats in this date range.</Empty> : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative h-[200px] w-full">
                <ChartContainer config={cfg} className="h-full w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel formatter={rowFormatter(cfg)} />} />
                    <Pie data={donut} dataKey="value" nameKey="key" innerRadius="62%" outerRadius="92%" strokeWidth={2} isAnimationActive={false}>
                      {donut.map((d) => <Cell key={d.key} fill={`var(--color-${d.key})`} />)}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="tnum text-3xl font-semibold">{num(c.chats)}</span>
                  <span className="text-xs text-muted-foreground">chats</span>
                </div>
              </div>
              <ul className="flex w-full flex-col gap-1.5 text-sm">
                {(["assigned", "unassigned"] as const).map((k) => (
                  <li key={k} className="flex items-center gap-2">
                    <span className="size-2.5 rounded-[2px]" style={{ background: `var(--color-${k})` }} />
                    <span>{cfg[k].label}</span>
                    <span className="tnum ml-auto font-medium">{num(c[k])}</span>
                    <span className="tnum w-14 text-right text-muted-foreground">{pct(c[`${k}_pct`])}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ChartCard>
      </div>

      <div ref={lowRef} className="flex flex-col gap-6">
      <ChartCard title="When chats start" description="New chats by the hour or weekday of the customer's first message (India time). The amber part is chats nobody owned."
        actions={<Tabs value={slot} onValueChange={(v) => setSlot(v as "hours" | "weekdays")}><TabsList><TabsTrigger value="hours">By hour</TabsTrigger><TabsTrigger value="weekdays">By weekday</TabsTrigger></TabsList></Tabs>}>
        {byTime.error ? <ErrorNote message={byTime.error} /> : !byTime.data ? <ChartSkeleton h={240} /> : (
          <ChartContainer config={cfg} className="h-[240px] w-full">
            <BarChart data={timeRows} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} interval={slot === "hours" ? 1 : 0} />
              <YAxis {...axis} width={40} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(cfg)} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar isAnimationActive={false} dataKey="assigned" stackId="a" fill="var(--color-assigned)" />
              <Bar isAnimationActive={false} dataKey="unassigned" stackId="a" fill="var(--color-unassigned)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="How long chats run" description="Chats where the customer wrote more than once: how many there were (bars) and the average time between their first and last message (line). Single-message chats have no length.">
          {dur.error ? <ErrorNote message={dur.error} /> : !dur.data ? <ChartSkeleton h={260} /> : dur.data.rows.length === 0 ? <Empty>No chats with more than one message in this range.</Empty> : (
            <ChartContainer config={durCfg} className="h-[260px] w-full">
              <ComposedChart data={dur.data.rows.map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis yAxisId="n" {...axis} width={36} allowDecimals={false} />
                <YAxis yAxisId="m" orientation="right" {...axis} width={48} tickFormatter={(v) => (v >= 1440 ? Math.round(v / 1440) + "d" : v >= 60 ? Math.round(v / 60) + "h" : v + "m")} />
                <ChartTooltip content={<ChartTooltipContent formatter={(v: any, name: any, item: any) => (
                  <div className="flex w-full items-center gap-2"><span className="size-2.5 rounded-[2px]" style={{ background: item?.color }} /><span className="text-muted-foreground">{(durCfg as any)[name]?.label}</span><span className="ml-auto pl-3 font-mono font-medium tabular-nums text-foreground">{name === "avg_min" ? duration(v) : num(v)}</span></div>
                )} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar yAxisId="n" dataKey="chats" fill="var(--color-chats)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Line yAxisId="m" dataKey="avg_min" type="monotone" stroke="var(--color-avg_min)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard title="Busiest times" description="New chats by weekday and hour (India time). Darker means more."
          actions={<Tabs value={heatKind} onValueChange={(v) => setHeatKind(v as "chats" | "unassigned")}><TabsList><TabsTrigger value="chats">All chats</TabsTrigger><TabsTrigger value="unassigned">Unassigned</TabsTrigger></TabsList></Tabs>}>
          {heat.error ? <ErrorNote message={heat.error} /> : !heat.data ? <ChartSkeleton h={260} /> : <Heat cells={heat.data.cells} kind={heatKind} />}
        </ChartCard>
      </div>

      <ChartCard title="WATI figures we cannot show yet" description="WATI's own Inbox Analytics page also counts these. They are not in the data this dashboard receives.">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {["Open", "Pending", "Solved", "Solved by bot", "Missed", "Tags", "Operator performance"].map((n) => <span key={n} className="rounded-full border border-dashed px-3 py-1 text-muted-foreground">{n}</span>)}
          </div>
          <p className="flex gap-2 text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" /><span>The chat log only keeps what customers send. WATI's ticket status changes, tags and the team's own replies are never written to it. To get them, the n8n workflow that feeds the log also needs to save WATI's "ticket status changed", "ticket assigned" and "message sent by team" events. Once they are saved, these cards and the exact assigned time can appear here.</span></p>
        </div>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-2" title="Who has the assigned chats" description="Chats by current owner.">
          {ops.error ? <ErrorNote message={ops.error} /> : !ops.data ? <ChartSkeleton h={240} /> : ops.data.rows.length === 0 ? <Empty>No assigned chats in this date range.</Empty> : (
            <SortableTable rows={ops.data.rows} cols={opCols} rowKey={(r) => r.operator} initialSort="chats" maxHeight="22rem" />
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-3" title="Chats waiting for someone" description={reveal && waiting.data?.revealed ? "Unassigned chats, longest waiting first. Full phone numbers are showing, so keep this screen and any export private. Showing up to 200." : "Unassigned chats, longest waiting first. Phone numbers are hidden except the last four digits. Showing up to 200."}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting || !waiting.data?.rows?.length} title={reveal && canReveal ? "Downloads every waiting chat, with full phone numbers" : "Downloads every waiting chat. Phone numbers stay hidden unless you switch them on at the top of the page first."}><Download className="size-3.5" />{exporting ? "Preparing…" : "Export CSV"}</Button>
            </div>
          }>
          {exportErr && <div className="mb-3"><ErrorNote message={exportErr} /></div>}
          {waiting.error ? <ErrorNote message={waiting.error} /> : !waiting.data ? <ChartSkeleton h={240} /> : waiting.data.rows.length === 0 ? <Empty>Every chat in this range has an owner.</Empty> : (
            <SortableTable rows={waiting.data.rows} cols={waitCols} rowKey={(r) => r.key} initialSort="age" maxHeight="22rem" searchText={(r) => `${r.customer} ${r.phone}`} searchPlaceholder={reveal && waiting.data?.revealed ? "Search name or phone number" : "Search name or last 4 digits"} />
          )}
        </ChartCard>
      </div>
      </div>
    </div>
  )
}
