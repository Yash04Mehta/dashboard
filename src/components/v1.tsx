// Building blocks shared by the live pages (Overview = /, Messages = /messages). They follow the layout in "Overview Page.md".
// Everything here reads the same endpoints as the other pages, so the figures are identical and work in CSV and live mode alike.
import { useColResize } from "@/components/col-resize"
import { useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { format, parseISO } from "date-fns"
import { ArrowRight, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Download, Eye, EyeOff, Hourglass, Inbox as InboxIcon, Info, MessageCircle, Search, Send, ShieldAlert, TriangleAlert, UserCheck, Users, UserX, Wrench } from "lucide-react"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Funnel } from "@/components/funnel"
import { TemplateDetail } from "@/components/template-detail"
import { axis, rowFormatter } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, ScoreGrid, SortableTable, STICKY_HEAD, type Col, type Grain, useAutoGrain } from "@/components/kit"
import { RefreshContext, api, useApi, type Params } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useReveal } from "@/lib/reveal"
import { day, duration, num, one, pct, periodLabel, ppDelta } from "@/lib/format"
import { BUCKETS as FAIL_BUCKETS, BUCKET_ORDER, GROUPS, bucketOf, classify, classifyMsg, type BucketId, type FailGroupId } from "@/lib/fail-reasons"
import { nameIssue, phoneIssue } from "@/lib/validate"
import { priceTemplates } from "@/lib/costs"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"

const LIVE_REFRESH_MS = 60_000      // matches the server's 60 s answer cache in live mode
const RESPONSE_BUCKETS = ["Under 5 min", "5 to 60 min", "1 to 6 hours", "6 to 24 hours", "1 to 3 days", "Over 3 days"]
const MIN_FOLLOWED = { day: 20, week: 50, month: 100 } as const

/** Wraps a page so every number on it refreshes by itself once the live database is connected. In snapshot mode nothing refreshes. */
export function LivePage({ children }: { children: ReactNode }) {
  const { meta } = useFilters()
  return <RefreshContext.Provider value={meta?.mode === "live" ? LIVE_REFRESH_MS : 0}>{children}</RefreshContext.Provider>
}

/** Says where the numbers come from: live database (with the time of the last refresh) or a snapshot. */
export function LiveBadge({ updatedAt }: { updatedAt?: number }) {
  const { meta } = useFilters()
  if (!meta) return null
  const live = meta.mode === "live"
  return (
    <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm" title={live ? "Numbers refresh by themselves every minute." : "These numbers come from the exported files. Connect the live database (see the README) and this page then refreshes by itself every minute."}>
      <span className={live ? "size-2 animate-pulse rounded-full bg-good" : "size-2 rounded-full bg-warn"} />
      {live ? <span>Live{updatedAt ? ` · updated ${format(updatedAt, "HH:mm:ss")}` : ""}</span> : <span className="text-muted-foreground">Snapshot · data as of {day(meta.asOf)}</span>}
    </div>
  )
}

/** Number and percentage side by side: the count is the big figure, the share follows it. */
const withShare = (n?: number | null, p?: number | null) => ({ value: num(n), unit: p == null ? undefined : ` · ${one(p)}%` })

/**
 * 1. "Leads conversation details" (WATI tickets). Only the date range applies to chats, so only it is passed on.
 * Uses WATI's own conversation status (Open, Solved, Expired, Missed, Unassigned) when the WATI Status Sync has saved it. That is the same source and the same
 * definitions as WATI's Inbox Analytics, so the numbers match WATI. Only when it has not does this fall back to the older chat log, which cannot see an owner
 * assigned after the customer's last message and so overstates "owner unknown".
 */
export function ConversationDetails({ params }: { params: Params }) {
  const dates = { from: params.from, to: params.to }
  const ws = useApi<any>("chats/wati-status", dates)
  const legacy = useApi<any>(ws.data && !ws.data.available ? "inbox/kpis" : null, dates)
  const w = ws.data?.available ? ws.data : null
  const chatSearch = (() => { const q = new URLSearchParams(); if (params.from) q.set("from", String(params.from)); if (params.to) q.set("to", String(params.to)); const t = q.toString(); return t ? "?" + t : "" })()   // the date range goes with you
  const link = <Link to={{ pathname: "/chats", search: chatSearch }} className="inline-flex items-center gap-1 text-foreground hover:underline">See all chats <ArrowRight className="size-3.5" /></Link>
  if (w) {
    const p = w.period, of = (n: number) => withShare(n, p.total ? Math.round((1000 * n) / p.total) / 10 : null)
    return (
      <div className="flex flex-col gap-2">
        <ScoreGrid cols={4}
          title={<span className="flex flex-wrap items-center justify-between gap-2"><span>Chats with customers</span>{link}</span>}
          stats={[
            { icon: InboxIcon, label: "Chats", loading: false, value: num(p.total), foot: "customers who wrote in", hint: "One chat is one conversation with a customer who wrote to us, as WATI counts it. Messages we sent that nobody answered are not included." },
            { icon: UserCheck, label: "Solved", loading: false, ...of(p.solved), tone: "good", foot: `${num(p.solved_by_bot)} by the bot` },
            { icon: Hourglass, label: "Open or pending now", loading: false, value: num(w.live.open + w.live.pending), foot: `${num(w.live.open)} open, ${num(w.live.pending)} pending`, hint: "Right now, so this ignores the date range." },
            { icon: UserX, label: "Missed", loading: false, ...of(p.missed), tone: p.missed > 0 ? "bad" : "default", foot: "no reply before the 24 hours ended", hint: "WATI's Missed: the chat had an owner, the customer's 24-hour window ended, and nobody replied. Chats owned by the bot are included." },
          ]} />
        <p className="text-xs text-muted-foreground">From WATI's own conversation status, saved {w.evaluated_at ? "at " + w.evaluated_at.slice(11, 16) + " India time" : "regularly"}. Unassigned: {num(p.unassigned)}. Expired: {num(p.expired)} ({pct(p.total ? (100 * p.expired) / p.total : null, 0)}).</p>
      </div>
    )
  }
  const q = legacy
  const c = q.data?.current, p = q.data?.previous
  const prev = p && p.chats > 0 ? p : undefined
  const cov = q.data?.coverage
  return (
    <div className="flex flex-col gap-2">
      <ScoreGrid cols={4}
        title={<span className="flex flex-wrap items-center justify-between gap-2"><span>Chats with customers</span>{link}</span>}
        stats={[
          { icon: InboxIcon, label: "Chats", loading: !c, value: num(c?.chats), foot: c && `${num(c.customers)} customers wrote in`, hint: "One chat is one conversation with a customer." },
          { icon: UserCheck, label: "Owner known", loading: !c, ...withShare(c?.assigned, c?.assigned_pct), tone: "good", meter: c?.assigned_pct, delta: prev ? { value: ppDelta(c?.assigned_pct, prev.assigned_pct), goodWhen: "up" } : undefined, foot: c && "someone on our team owns it" },
          { icon: UserX, label: "Owner unknown", loading: !c, ...withShare(c?.unassigned, c?.unassigned_pct), tone: "warn", meter: c?.unassigned_pct, delta: prev ? { value: ppDelta(c?.unassigned_pct, prev.unassigned_pct), goodWhen: "down" } : undefined, foot: c && "we do not know who owns it", hint: "From the older chat log, which cannot see an owner assigned after the customer's last message, so this is probably much too high. WATI's own status is not available yet (the WATI Status Sync has not saved data)." },
          { icon: Hourglass, label: "Wrote again", loading: !c, value: num(c?.unassigned_repeat), tone: "warn", meter: c && c.unassigned ? (100 * c.unassigned_repeat) / c.unassigned : null, foot: c && `${pct(c.unassigned ? (100 * c.unassigned_repeat) / c.unassigned : null)} of the owner-unknown chats`, hint: "Customers who sent more than one message where we still do not know who owns the chat." },
        ]} />
      {ws.error || q.error ? <ErrorNote message={ws.error || q.error} /> : c && c.chats === 0 && cov && <p className="text-xs text-muted-foreground">No chats in this date range. The chat log covers {day(cov.from_day)} to {day(cov.to_day)}.</p>}
    </div>
  )
}

/** 2 to 7. Total leads (unique), messages sent, delivered, read, replied, failed to send. Each shows the number and the percentage together. */
export function MessageNumbers({ params, noTemplate }: { params: Params; noTemplate: Params }) {
  const mk = useApi<any>("messages/kpis", params)
  const lk = useApi<any>("leads/kpis", noTemplate)
  const m = mk.data?.current, mp = mk.data?.previous?.measured >= 100 ? mk.data.previous : undefined
  const l = lk.data?.current
  const d = (a?: number | null, b?: number | null, goodWhen: "up" | "down" = "up") => (mp ? { value: ppDelta(a, b), goodWhen } : undefined)
  return (
    <>
      <ErrorNote message={mk.error || lk.error} />
      <ScoreGrid cols={3} title="Leads and WhatsApp messages" stats={[
        { icon: Users, label: "Total leads (unique)", loading: !l, value: num(l?.people), foot: l && `${num(l.leads)} lead records`, hint: "Each phone number counts once, even if the person has several leads. Leads without a usable phone number cannot be counted." },
        { icon: Send, label: "Total messages sent", loading: !m, value: num(m?.measured), foot: m && `${num(m.attempts)} messages in all, including repeats`, hint: "Each person counts once per template, for the first message they got. Repeat messages to the same person are left out here, so the percentages next to the numbers below add up. The list at the bottom of the Messages page counts every message, so it can be higher." },
        { icon: CheckCheck, label: "Total delivered", loading: !m, ...withShare(m?.delivered_adj, m?.delivered_pct), meter: m?.delivered_pct, delta: d(m?.delivered_pct, mp?.delivered_pct), foot: m && "at least this many", hint: "At least this many: WhatsApp does not always report delivery, so the real number is probably higher." },
        { icon: Eye, label: "Total read", loading: !m, ...withShare(m?.read_adj, m?.read_pct), meter: m?.read_pct, delta: d(m?.read_pct, mp?.read_pct), foot: m && "at least this many" },
        { icon: MessageCircle, label: "Total replied", loading: !m, ...withShare(m?.replied, m?.replied_pct), meter: m?.replied_pct, tone: "good", delta: d(m?.replied_pct, mp?.replied_pct), foot: m && "customers who answered" },
        { icon: TriangleAlert, label: "Failed to send", loading: !m, ...withShare(m?.failed, m?.failed_pct), meter: m?.failed_pct, tone: m && m.failed_pct > 5 ? "bad" : "default", delta: d(m?.failed_pct, mp?.failed_pct, "down"), foot: m && "WhatsApp refused them" },
      ]} />
    </>
  )
}

/** Funnel colours in WhatsApp's order, clear but not neon: steel grey for sent, emerald for delivered, a proper blue for read, deep teal for replied. */
const WA_COLORS = ["#8a97a8", "#2e9d6b", "#3b82d6", "#0f766e"]

/** Message funnel, full width: the flowing funnel (a band for what carries on, a fading curve for what drops out), in its sleek style. */
export function MessageFunnelCard({ params }: { params: Params }) {
  const mk = useApi<any>("messages/kpis", params)
  const c = mk.data?.current
  return (
    <ChartCard title="Message funnel" description="Each column is a step. The wide band is how many carried on to the next step; the curve below shows how many dropped out. Hover over (or tap) a step for details.">
      {!c ? <ChartSkeleton h={300} /> : !c.measured ? <Empty>No messages were tracked in this period.</Empty> : (
        <>
          <Funnel sleek colors={WA_COLORS} ariaLabel={`Of ${num(c.measured)} messages, ${num(c.delivered_adj)} were delivered, ${num(c.read_adj)} read and ${num(c.replied)} replied.`}
            stages={[
              { label: "Messages sent", value: c.measured, icon: <Send className="size-4" />, drop: "failed or never confirmed" },
              { label: "Delivered", value: c.delivered_adj, icon: <CheckCheck className="size-4" />, drop: "delivered, not read" },
              { label: "Read", value: c.read_adj, icon: <Eye className="size-4" />, drop: "read, no reply" },
              { label: "Replied", value: c.replied, icon: <MessageCircle className="size-4" /> },
            ]} />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Delivered and read are at least these numbers. WhatsApp does not always report them, so the real figures are probably higher.</p>
        </>
      )}
    </ChartCard>
  )
}

/**
 * When a template is picked (Template filter), shows what the Costs page shows for it: the message, its spend and reply figures, and how it is priced.
 * Nothing shows when no template is picked. The figures come from the same pricing as the Costs page (priceTemplates).
 */
export function SelectedTemplateCard({ params }: { params: Params }) {
  const { filters, set } = useFilters()
  const names = filters.templates
  const sum = useApi<any>(names.length ? "costs/summary" : null, params)
  const msgQ = useApi<any>(names.length ? "costs/message" : null, { templates: names.join("|") })
  const d = sum.data
  const priced = useMemo(() => (d ? priceTemplates(d) : null), [d])
  if (!names.length) return null
  return (
    <div className="flex flex-col gap-3">
      <ErrorNote message={sum.error || msgQ.error} />
      {d?.placeholder && <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--warn)" }} /><span>The costs use <b>estimated prices</b> that have not been checked against your WATI invoice, so treat them as approximate.</span></p>}
      <TemplateDetail names={names} rows={priced?.rows ?? []} messages={msgQ.data?.messages} loading={sum.loading || msgQ.loading} cur={d?.currency ?? "INR"} rateNow={priced?.rateNow ?? {}} onClear={() => set({ templates: [] })} />
    </div>
  )
}

/** Customer response time: how long customers take to answer a message. */
export function ResponseTimeCard({ params }: { params: Params }) {
  const phone = useIsMobile()   // on a phone the six bucket names do not fit side by side, so they are tilted
  const [kind, setKind] = useState<"reply" | "read">("reply")
  const rt = useApi<any>("messages/reply-time", params)
  const rows = useMemo(() => (rt.data?.[kind]?.buckets ?? []).map((b: any) => ({ label: RESPONSE_BUCKETS[b.ord - 1], share: b.share ?? 0 })), [rt.data, kind])
  const cfg: ChartConfig = { share: { label: kind === "reply" ? "Replies" : "Read, no reply", color: kind === "reply" ? "var(--good)" : "var(--c1)" } }
  return (
    <ChartCard title="Customer response time" description="How long customers take to respond after we message them. This is an estimate, because WhatsApp does not give exact times."
      actions={<Tabs value={kind} onValueChange={(v) => setKind(v as "reply" | "read")}><TabsList><TabsTrigger value="reply">Replies</TabsTrigger><TabsTrigger value="read">Read, no reply</TabsTrigger></TabsList></Tabs>}>
      {rt.error ? <ErrorNote message={rt.error} /> : !rt.data ? <ChartSkeleton /> : rt.data[kind].total === 0 ? <Empty>No messages in this group for these filters.</Empty> : (
        <>
          <p className="mb-3 text-sm">
            Half of {kind === "reply" ? "replies arrive" : "these messages were last read"} within <b>{duration(rt.data[kind].median_min)}</b>, and <b>{pct(rt.data[kind].within_day_pct, 0)}</b> within a day.
            <span className="text-muted-foreground"> Based on {num(rt.data[kind].total)} messages.</span>
          </p>
          <ChartContainer config={cfg} className="h-[230px] w-full">
            <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} interval={0} tick={{ fontSize: 11 }} {...(phone ? { angle: -40, textAnchor: "end", height: 58 } : {})} />
              <YAxis {...axis} width={44} tickFormatter={(v) => v + "%"} />
              <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(cfg, "%")} />} />
              <Bar isAnimationActive={false} dataKey="share" fill="var(--color-share)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </>
      )}
    </ChartCard>
  )
}

type Metric = "replied" | "read" | "delivered" | "failed"
const METRICS: { key: Metric; label: string; color: string; good: "up" | "down"; ask: string }[] = [
  { key: "replied", label: "Replied", color: "var(--good)", good: "up", ask: "How many customers answered" },
  { key: "read", label: "Read", color: "var(--c2)", good: "up", ask: "How many customers opened it" },
  { key: "delivered", label: "Delivered", color: "var(--c1)", good: "up", ask: "How many reached the phone" },
  { key: "failed", label: "Failed", color: "var(--bad)", good: "down", ask: "How many WhatsApp refused" },
]
const longPeriod = (s: string, grain: Grain) => {
  try { const d = parseISO(s); return grain === "month" ? format(d, "MMMM yyyy") : grain === "week" ? "Week of " + format(d, "d MMM yyyy") : format(d, "EEE d MMM yyyy") } catch { return s }
}
const unitName = { day: "day", week: "week", month: "month" } as const

/**
 * Trends: pick ONE measure at a time and see it as a single line, with how many messages went out as grey bars behind it.
 * Periods with too few messages have no reliable rate, so the line skips them (and says how many it skipped).
 */
export function TrendCard({ params }: { params: Params }) {
  const [grain, setGrain] = useAutoGrain(params.from as string | undefined, params.to as string | undefined)
  const [metric, setMetric] = useState<Metric>("replied")
  const id = useId().replace(/:/g, "")
  const trend = useApi<any>("messages/trend", { ...params, grain })
  const min = MIN_FOLLOWED[grain]
  const M = METRICS.find((m) => m.key === metric)!

  const { rows, totals, skipped } = useMemo(() => {
    const src: any[] = trend.data?.rows ?? []
    const t = { measured: 0, delivered: 0, read: 0, replied: 0, failed: 0 }
    for (const r of src) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k] ?? 0
    const rows = src.map((r) => {
      const ok = r.measured >= min
      return { label: periodLabel(r.period, grain), full: longPeriod(r.period, grain), ok, measured: r.measured, delivered: r.delivered, read: r.read, replied: r.replied, failed: r.failed,
        delivered_pct: ok ? r.delivered_pct : null, read_pct: ok ? r.read_pct : null, replied_pct: ok ? r.replied_pct : null, failed_pct: ok ? r.failed_pct : null }
    })
    return { rows, totals: t, skipped: rows.filter((r) => !r.ok).length }
  }, [trend.data, grain, min])

  const key = `${metric}_pct` as const
  const good = rows.filter((r) => r.ok)
  const avg = totals.measured ? (100 * totals[metric]) / totals.measured : null
  const latest = good[good.length - 1]
  const best = good.length > 1 ? good.reduce((a, b) => ((b as any)[key] > (a as any)[key] ? b : a)) : null
  const worst = good.length > 1 ? good.reduce((a, b) => ((b as any)[key] < (a as any)[key] ? b : a)) : null
  const [hi, lo] = M.good === "up" ? [best, worst] : [worst, best]   // "highest" and "lowest" in the order that reads well
  const cfg: ChartConfig = { rate: { label: M.label, color: M.color }, measured: { label: "Messages sent", color: "var(--c6)" } }

  const tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const r = payload[0].payload
    return (
      <div className="min-w-48 rounded-lg border bg-popover px-3 py-2.5 text-sm shadow-lg">
        <div className="font-medium">{r.full}</div>
        <div className="mt-1.5 flex items-center justify-between gap-6"><span className="text-muted-foreground">Messages sent</span><span className="tnum font-medium">{num(r.measured)}</span></div>
        {r.ok ? (
          <div className="mt-1 flex items-center justify-between gap-6"><span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-2 rounded-full" style={{ background: M.color }} />{M.label}</span><span className="tnum font-medium">{num(r[metric])} · {pct(r[key])}</span></div>
        ) : <div className="mt-1.5 max-w-52 text-xs text-muted-foreground">Too few messages ({num(r.measured)}, under {min}) for a reliable rate, so none is drawn.</div>}
      </div>
    )
  }

  return (
    <ChartCard title="Trends over time" description="Pick one measure and follow it. The line is the share of messages; the grey bars are how many messages went out."
      actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">By day</TabsTrigger><TabsTrigger value="week">By week</TabsTrigger><TabsTrigger value="month">By month</TabsTrigger></TabsList></Tabs>}>
      {trend.error ? <ErrorNote message={trend.error} /> : !trend.data ? <ChartSkeleton h={380} /> : !rows.length ? <Empty>No messages were tracked in this period.</Empty> : (
        <div className="flex flex-col gap-4">
          {/* 1. choose what to look at */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label="Measure to chart">
            {METRICS.map((m) => {
              const overall = totals.measured ? (100 * totals[m.key]) / totals.measured : null
              const on = m.key === metric
              return (
                <button key={m.key} type="button" aria-pressed={on} onClick={() => setMetric(m.key)}
                  className={cn("flex flex-col gap-1 rounded-xl border p-3 text-left transition-all hover:bg-muted/50", on ? "bg-muted/60 shadow-sm" : "opacity-80")} style={on ? { borderColor: m.color, boxShadow: `inset 0 0 0 1px ${m.color}` } : undefined}>
                  <span className="flex items-center gap-2 text-sm font-medium"><span className="size-2.5 rounded-full" style={{ background: m.color }} />{m.label}</span>
                  <span className="tnum text-2xl font-semibold tracking-tight">{pct(overall)}</span>
                  <span className="text-xs text-muted-foreground">{m.ask}, over this whole period</span>
                </button>
              )
            })}
          </div>

          {/* 2. say what the chart shows, in words */}
          <p className="text-sm leading-relaxed">
            {good.length === 0
              ? <span className="text-muted-foreground">No {unitName[grain]} here has {min}+ messages, so there is no reliable rate to chart. Try “By week” or “By month”.</span>
              : <>
                  <b>{M.label}:</b> {pct(avg)} on average.
                  {latest && <> The latest {unitName[grain]} with enough messages ({latest.label}) was <b>{pct((latest as any)[key])}</b>{avg != null && (latest as any)[key] != null && Math.abs((latest as any)[key] - avg) >= 0.5 ? <>, <span style={{ color: ((latest as any)[key] > avg) === (M.good === "up") ? "var(--good)" : "var(--bad)" }}>{Math.abs(Math.round(((latest as any)[key] - avg) * 10) / 10)} points {(latest as any)[key] > avg ? "above" : "below"} average</span></> : <>, about average</>}.</>}
                  {hi && lo && hi !== lo && <span className="text-muted-foreground"> {M.good === "up" ? "Best" : "Lowest"}: {hi.label} ({pct((hi as any)[key])}). {M.good === "up" ? "Weakest" : "Highest"}: {lo.label} ({pct((lo as any)[key])}).</span>}
                </>}
          </p>

          {/* 3. the chart */}
          <ChartContainer config={cfg} className="h-[320px] w-full">
            <ComposedChart data={rows.map((r) => ({ ...r, rate: (r as any)[key] }))} margin={{ left: 4, right: 8, top: 16 }}>
              <defs>
                <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={M.color} stopOpacity={0.28} /><stop offset="1" stopColor={M.color} stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={28} />
              <YAxis yAxisId="rate" {...axis} width={44} domain={[0, (max: number) => Math.max(10, Math.ceil((max * 1.15) / 5) * 5)]} tickFormatter={(v) => v + "%"} />
              <YAxis yAxisId="vol" hide orientation="right" domain={[0, (max: number) => Math.max(1, max * 3.5)]} />
              <ChartTooltip content={tip} cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }} />
              <Bar yAxisId="vol" dataKey="measured" fill="var(--c6)" fillOpacity={0.22} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              {avg != null && good.length > 0 && <ReferenceLine yAxisId="rate" y={avg} stroke="var(--muted-foreground)" strokeDasharray="5 4" strokeOpacity={0.7} label={{ value: `Average ${pct(avg)}`, position: "insideTopRight", fontSize: 11, fill: "var(--muted-foreground)" }} />}
              <Area yAxisId="rate" dataKey="rate" type="monotone" stroke={M.color} strokeWidth={2.5} fill={`url(#${id}-fill)`} connectNulls={false} isAnimationActive={false}
                dot={good.length <= 40 ? { r: 3.5, fill: M.color, stroke: "var(--card)", strokeWidth: 1.5 } : false} activeDot={{ r: 5.5, stroke: "var(--card)", strokeWidth: 2 }} />
            </ComposedChart>
          </ChartContainer>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {skipped > 0
              ? <>{skipped} of {rows.length} {unitName[grain]}s had fewer than {min} messages, so their rate is left out (the line has gaps there). Their grey bars still show how many went out.</>
              : <>Every {unitName[grain]} shown had at least {min} messages.</>}
            {" "}Delivered and read are at least these numbers, because WhatsApp does not always report them.
          </p>
        </div>
      )}
    </ChartCard>
  )
}

/**
 * Why messages failed, as three questions: is it ours to fix, WhatsApp's call, or the customer's side?
 * Pick one of the cards to see what it means, what to do, the exact reasons WATI gave and which templates are hit.
 * Needs n8n to save the failure events (see HAND_OFF_FOR_SENIOR.md, step 5).
 */
const BUCKET_ICON = { ours: Wrench, whatsapp: ShieldAlert, customer: UserX, unclear: CircleHelp } as const
type FailModel = { buckets: Map<BucketId, { n: number; items: Map<string, any> }>; tpl: Map<BucketId, { name: string; n: number }[]>; total: number }

export function FailureReasonsCard({ params }: { params: Params }) {
  const q = useApi<any>("messages/fail-reasons", params)
  const d = q.data
  const [pick, setPick] = useState<BucketId | null>(null)

  const model = useMemo<FailModel | null>(() => {
    if (!d?.reasons) return null
    const buckets: FailModel["buckets"] = new Map()
    for (const r of d.reasons as { reason: string; n: number }[]) {
      const c = classify(r.reason), id = bucketOf(c.group.id)
      const b = buckets.get(id) ?? { n: 0, items: new Map() }
      b.n += r.n
      const it = b.items.get(c.label) ?? { label: c.label, code: c.code, group: c.group.title, groupId: c.group.id, n: 0 }
      it.n += r.n; b.items.set(c.label, it); buckets.set(id, b)
    }
    // which templates are hit by each bucket
    const tpl: FailModel["tpl"] = new Map()
    for (const t of (d.by_template ?? []) as any[]) {
      const per = new Map<BucketId, number>()
      for (const r of (t.reasons ?? []) as { reason: string; n: number }[]) { const id = bucketOf(classify(r.reason).group.id); per.set(id, (per.get(id) ?? 0) + r.n) }
      for (const [id, n] of per) tpl.set(id, [...(tpl.get(id) ?? []), { name: t.template_name, n }])
    }
    for (const list of tpl.values()) list.sort((a, b) => b.n - a.n)
    return { buckets, tpl, total: [...buckets.values()].reduce((s, b) => s + b.n, 0) }
  }, [d])

  const shown = BUCKET_ORDER.filter((id) => id === "ours" || id === "whatsapp" || id === "customer" || model?.buckets.has(id))
  const biggest = model ? [...model.buckets.entries()].sort((a, b) => b[1].n - a[1].n)[0]?.[0] : undefined
  const sel: BucketId = pick && model?.buckets.has(pick) ? pick : biggest ?? "ours"
  const ours = model?.buckets.get("ours")?.n ?? 0

  return (
    <ChartCard title="Why messages failed" description="The reason WhatsApp gave for each failed message, sorted by who can do something about it. Only failures saved since the reasons started being kept have a reason.">
      {q.error ? <ErrorNote message={q.error} /> : !d ? <ChartSkeleton h={200} /> : !d.capturing ? (
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1.5">
            <p className="font-medium">Failure reasons are not being saved yet, so there is nothing to show here.</p>
            <p className="text-muted-foreground">WATI sends the reason with every failed message, but the n8n workflow only marks the message as failed and drops the reason. One extra step in that workflow saves it, and this card then fills in on its own. The steps are in <code>HAND_OFF_FOR_SENIOR.md</code>, section 5.</p>
          </div>
        </div>
      ) : d.failed_events === 0 ? <Empty>{d.all_failed > 0 ? `None of the ${num(d.all_failed)} failed message${d.all_failed === 1 ? "" : "s"} saved since ${day(d.since)} match the filters above. Clear a filter (Reset filters) to see ${d.all_failed === 1 ? "it" : "them"}.` : `No failed messages have been saved since ${day(d.since)}.`}</Empty> : d.with_reason === 0 || !model ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">{num(d.failed_events)} failed messages are saved, but the reason was not found in them.</p>
          <p className="text-muted-foreground">The field that holds the reason has a name this dashboard does not know yet. Send this list of field names to whoever maintains the dashboard: <span className="font-mono text-xs">{d.payload_keys.map((k: any) => k.key).join(", ")}</span></p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* 1. the headline */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="tnum text-4xl font-semibold tracking-tight">{num(d.failed_events)}</span>
            <span className="text-sm text-muted-foreground">
              messages failed since {day(d.since)}.
              {ours > 0 && <> <b className="text-foreground">{pct((100 * ours) / model.total, 0)}</b> of them are on our side and can be fixed.</>}
              {d.with_reason < d.failed_events && <> {num(d.failed_events - d.with_reason)} had no reason recorded.</>}
            </span>
          </div>

          {/* 2. who is responsible: pick one */}
          <div className={cn("grid gap-3", shown.length > 3 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3")} role="group" aria-label="Cause of failure">
            {shown.map((id) => {
              const B = FAIL_BUCKETS[id], n = model.buckets.get(id)?.n ?? 0, on = id === sel, Icon = BUCKET_ICON[id]
              return (
                <button key={id} type="button" aria-pressed={on} onClick={() => setPick(id)} disabled={!n}
                  className={cn("flex flex-col gap-2 rounded-xl border p-4 text-left transition-all enabled:hover:bg-muted/50 disabled:opacity-50", on && "bg-muted/60 shadow-sm")} style={on ? { borderColor: B.color, boxShadow: `inset 0 0 0 1px ${B.color}` } : undefined}>
                  <span className="flex items-center gap-2 text-sm font-medium"><span className="flex size-7 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${B.color} 18%, transparent)`, color: B.color }}><Icon className="size-4" /></span>{B.title}</span>
                  <span className="flex items-baseline gap-2"><span className="tnum text-3xl font-semibold tracking-tight">{num(n)}</span><span className="tnum text-sm text-muted-foreground">{pct((100 * n) / model.total, 0)}</span></span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${(100 * n) / model.total}%`, background: B.color }} /></span>
                  <span className="text-xs text-muted-foreground">{B.tagline}</span>
                </button>
              )
            })}
          </div>

          {/* 3. the answer for the picked card */}
          <FailureDetail id={sel} model={model} />
        </div>
      )}
    </ChartCard>
  )
}

function FailureDetail({ id, model }: { id: BucketId; model: FailModel }) {
  const B = FAIL_BUCKETS[id], b = model.buckets.get(id)
  if (!b) return null
  const items = [...b.items.values()].sort((a, c) => c.n - a.n)
  const tpls = model.tpl.get(id) ?? []
  const topT = Math.max(1, ...tpls.map((t) => t.n))
  // for "ours" the fix depends on which kind of problem it was, so list each kind once
  const kinds = id === "ours" ? [...new Set(items.map((i) => i.groupId as FailGroupId))].map((g) => GROUPS[g]) : []
  return (
    <div className="grid gap-5 rounded-xl border p-4 lg:grid-cols-2" style={{ borderLeft: `4px solid ${B.color}` }}>
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-sm leading-relaxed"><span className="font-medium">What it means. </span><span className="text-muted-foreground">{B.means}</span></p>
        <div className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-relaxed">
          <div className="font-medium">What to do</div>
          {kinds.length ? (
            <ul className="mt-1.5 flex flex-col gap-1.5">{kinds.map((k) => <li key={k.id}><b>{k.title}.</b> <span className="text-muted-foreground">{k.todo}</span></li>)}</ul>
          ) : <p className="mt-0.5 text-muted-foreground">{B.todo}</p>}
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Exactly what WATI said</div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {items.slice(0, 8).map((it) => (
              <li key={it.label} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">{it.label}{id === "ours" && <span className="ml-1.5 text-xs text-muted-foreground">· {it.group}</span>}{it.code && <span className="ml-1.5 rounded bg-muted px-1 py-px font-mono text-[11px] text-muted-foreground">{it.code}</span>}</span>
                <span className="tnum shrink-0 font-medium">{num(it.n)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">Templates affected</div>
        {tpls.length ? (
          <div className="flex flex-col gap-2">
            {tpls.slice(0, 8).map((t) => (
              <div key={t.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
                <span className="truncate" title={t.name}>{t.name}</span><span className="tnum font-medium">{num(t.n)}</span>
                <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${(100 * t.n) / topT}%`, background: B.color }} /></span>
              </div>
            ))}
            {tpls.length > 8 && <span className="text-xs text-muted-foreground">and {tpls.length - 8} more</span>}
          </div>
        ) : <p className="text-sm text-muted-foreground">No template is recorded for these failures.</p>}
      </div>
    </div>
  )
}

/**
 * Every message we sent to a customer, one row each: when, which template, who to, what happened to it, and why it failed.
 * Click a row to read the message and see the full story. The message text and full numbers stay hidden until "Show numbers and messages" is pressed.
 * Needs the events n8n saves (the "Save status event" step), so it only lists messages from the day that started.
 */
const LOG_STATUS = [
  { id: "all", label: "All" }, { id: "failed", label: "Failed" }, { id: "replied", label: "Replied" },
  { id: "read", label: "Read" }, { id: "delivered", label: "Delivered" }, { id: "sent", label: "Sent only" },
] as const
const LOG_STYLE: Record<string, { label: string; cls: string }> = {
  failed: { label: "Failed", cls: "bg-bad/15 text-bad" }, replied: { label: "Replied", cls: "bg-good/15 text-good" },
  read: { label: "Read", cls: "bg-c1/15 text-c1" }, delivered: { label: "Delivered", cls: "bg-c2/15 text-c2" }, sent: { label: "Sent", cls: "bg-muted text-muted-foreground" },
}
const whenAt = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
/**
 * The plain sentence for a row, the way an activity feed would say it: "WhatsApp message sent to Asha Verma (+919800000000)".
 * The name and full number appear only when reveal is on; otherwise it reads "WhatsApp message sent to •••••• 1234". A message WATI refused has no number saved.
 */
const activityLine = (r: any, revealed: boolean) => {
  const digits = String(r.phone ?? "").replace(/\D/g, "")
  const number = !r.phone ? "" : revealed && digits ? "+" + digits : String(r.phone)
  const who = number ? (revealed && r.name ? `${r.name} (${number})` : number) : "a customer (number not saved)"
  return r.status === "failed" ? `WhatsApp message to ${who} failed` : `WhatsApp message sent to ${who}`
}
/** one CSV cell. Text starting with = + - @ would be read as a formula by Excel, so it gets a quote in front. */
const csvCell =(v: unknown) => { let t = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }

function LogDetail({ r, revealed, canReveal }: { r: any; revealed: boolean; canReveal: boolean }) {
  const c = classifyMsg(r)
  const pi = phoneIssue(r.phone_issue), ni = nameIssue(r.name_issue)
  const B = c ? FAIL_BUCKETS[bucketOf(c.group.id)] : null
  const steps = ([["Sent", r.times.sent], ["Delivered", r.times.delivered], ["Read", r.times.read], ["Replied", r.times.replied], ["Failed", r.times.failed]] as const).filter(([, t]) => t)
  return (
    <div className="grid gap-5 p-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="text-xs font-medium text-muted-foreground">The message the customer got</div>
        {revealed ? (r.text
          ? <div className="max-w-md whitespace-pre-wrap break-words rounded-lg rounded-tl-none border bg-card px-3 py-2.5 text-sm leading-relaxed shadow-sm">{r.text.replace(/\r\n?/g, "\n").trim()}</div>
          : <p className="text-sm text-muted-foreground">The wording of this message was not saved. That happens when it was sent before saving started, or when WATI never confirmed the send.</p>)
          : <p className="text-sm text-muted-foreground">Hidden, because it contains the customer's name and details. {canReveal ? "Use the “Show phone numbers and messages” switch at the top of the page to read it." : "It cannot be shown on this screen."}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">What happened</div>
          <ol className="flex flex-col gap-1">{steps.map(([k, t]) => <li key={k} className="flex items-baseline gap-3"><span className={cn("w-20 shrink-0 font-medium", k === "Failed" && "text-bad")}>{k}</span><span className="tnum text-muted-foreground">{whenAt(t as string)}</span></li>)}</ol>
          {r.rejected
            ? <p className="mt-1.5 text-xs text-muted-foreground">WATI refused this message before it reached WhatsApp, so no WhatsApp message id, phone number, template name or wording was saved for it. Only the time and the reason are known.</p>
            : !r.times.sent && r.status === "failed" && <p className="mt-1.5 text-xs text-muted-foreground">The “sent” record for this message was not saved, so only the failure time is known.</p>}
        </div>
        {c && B && (
          <div className="rounded-lg border-l-4 bg-muted/60 px-3 py-2.5 leading-relaxed" style={{ borderColor: B.color }}>
            <div className="font-medium">{c.because ? `Why it failed: most likely because ${c.because}` : <>Why it failed: {c.label}</>}{c.code && <span className="ml-1.5 rounded bg-background px-1 py-px font-mono text-[11px] text-muted-foreground">{c.code}</span>}</div>
            <div className="mt-0.5 text-xs" style={{ color: B.color }}>{B.title}</div>
            {c.via && <p className="mt-1 text-xs text-muted-foreground">WhatsApp itself reported: “{c.via}”{c.code ? ` (${c.code})` : ""}</p>}
            <p className="mt-1.5 text-muted-foreground">{pi ? pi.means : c.group.means}</p>
            <p className="mt-1.5"><b>What to do. </b><span className="text-muted-foreground">{pi ? pi.todo : c.group.todo}</span></p>
          </div>
        )}
        {!c && pi && (
          <div className="rounded-lg border-l-4 bg-muted/60 px-3 py-2.5 leading-relaxed" style={{ borderColor: "var(--warn)" }}>
            <div className="font-medium">Number check: {pi.label}</div>
            <p className="mt-1.5 text-muted-foreground">{pi.means} This message was not reported as failed, but {r.status === "sent" ? "that may be why nothing came back" : "a number like this usually does not get through"}.</p>
            <p className="mt-1.5"><b>What to do. </b><span className="text-muted-foreground">{pi.todo}</span></p>
          </div>
        )}
        {ni && (
          <div className="rounded-lg border-l-4 bg-muted/60 px-3 py-2.5 leading-relaxed" style={{ borderColor: "var(--c4)" }}>
            <div className="font-medium">Name check: {ni.label}</div>
            <p className="mt-1.5 text-muted-foreground">{ni.means} A wrong name does not stop WhatsApp delivering the message.</p>
            <p className="mt-1.5"><b>What to do. </b><span className="text-muted-foreground">{ni.todo}</span></p>
          </div>
        )}
      </div>
    </div>
  )
}

/** What each status button means, in plain words. Used for the summary and as the tooltip on the buttons. */
const STATUS_MEANING: Record<string, string> = {
  replied: "The customer answered.",
  read: "The customer opened it but has not replied.",
  delivered: "It reached the customer's phone, but there is no sign it was opened. Some may have been read by customers who have read receipts switched off.",
  sent: "WhatsApp took the message, but nothing came back about it: it may still be on its way, the phone may be off, or WATI never reported it. Delivery is not always reported, so some of these did arrive.",
  failed: "It was never sent.",
}
const STATUS_HINT: Record<string, string> = {
  replied: "These customers answered, so they are your warmest group and worth a call.",
  read: "They opened it and went quiet: a good group for a follow-up call or message.",
  delivered: "Not opened yet. Many open it later, so look again in a day.",
  sent: "Anything under an hour old may still get its report. Older ones are unlikely to.",
}
const STATUS_NAME: Record<string, string> = { all: "All messages", failed: "Failed messages", replied: "Replied messages", read: "Read messages (not replied)", delivered: "Delivered messages (not read)", sent: "Sent-only messages" }
const LAG_LABEL: Record<string, string> = { replied: "Typical time to reply", read: "Typical time to read", delivered: "Typical time to arrive", failed: "Typical time to fail" }

/**
 * The summary under the status buttons of "Every message we sent". It describes the messages the selected button shows, for the date and template filters
 * at the top of the page: All gives the whole picture, Failed gives why they failed, Replied / Read / Delivered / Sent only give what that group is, how fast it
 * happened and which templates it came from. It reads the same response as the table, so it costs no extra request.
 */
function StatusSummary({ data, params }: { data: any; params: Params }) {
  const c = data.counts, s = data.summary
  if (!c?.all || !s) return null
  const st: string = s.status ?? "all", n: number = s.n ?? 0
  const from = params.from ? String(params.from) : "", to = params.to ? String(params.to) : from
  const when = !from ? "all dates" : from === to ? day(from) : `${day(from)} to ${day(to)}`
  const picked = params.templates ? String(params.templates).split("|").filter(Boolean) : []
  const what = picked.length === 0 ? "all templates" : picked.length === 1 ? picked[0] : `${picked.length} templates`
  const ignored = [params.sources ? "lead source" : "", params.owners ? "owner" : ""].filter(Boolean)
  const share = (x: number, of = c.all) => pct(of ? (100 * x) / of : null)
  const reached = c.delivered + c.read + c.replied, readUp = c.read + c.replied
  const plural = (k: number, one: string, many = one + "s") => `${num(k)} ${k === 1 ? one : many}`

  // why messages failed: the most common codes, grouped into plain causes, each with its share of the failures
  const causes = new Map<string, { label: string; n: number; bucket: BucketId; todo: string }>()
  for (const f of (s.failures ?? []) as { reason: string | null; n: number }[]) {
    const k = classify(f.reason), key = k.group.id + "|" + k.label, prev = causes.get(key)
    causes.set(key, { label: k.label, n: (prev?.n ?? 0) + f.n, bucket: bucketOf(k.group.id), todo: k.group.todo })
  }
  const causeList = [...causes.values()].sort((a, b) => b.n - a.n)
  const failN = st === "all" ? c.failed : n
  const otherFail = Math.max(0, failN - causeList.reduce((t, x) => t + x.n, 0))
  const top = causeList[0]
  const tpls = (s.topTemplates ?? []) as { name: string; n: number }[]
  const lag = s.lag as { median: number; p90: number; n: number } | null
  const inTime = (m: number) => (m < 1 ? "in under a minute" : `within ${duration(m)}`)

  let sentence: string
  if (st === "all") {
    sentence = `${plural(c.all, "message")} went to ${plural(s.people, "customer")}. ${share(reached)} reached the phone, ${share(readUp)} were read and ${share(c.replied)} got a reply. `
      + (c.failed ? `${share(c.failed)} (${num(c.failed)}) failed${top ? `, mostly “${top.label}” (${share(top.n)} of all messages)` : ""}.` : "None failed.")
      + (c.sent ? ` ${plural(c.sent, "message")} (${share(c.sent)}) ${c.sent === 1 ? "has" : "have"} no delivery news yet${s.sentRecent ? `, ${num(s.sentRecent)} of them sent in the last hour so may still be on the way` : ""}.` : "")
  } else if (st === "failed") {
    sentence = `${plural(n, "message")} failed, which is ${share(n)} of all ${num(c.all)} messages, across ${plural(s.people, "customer")}. `
      + (top ? `The biggest cause is “${top.label}”: ${num(top.n)} of them (${share(top.n, n)}). ` : "")
      + (lag ? `When a message failed it was typically ${duration(lag.median)} after sending.` : "")
  } else if (st === "replied") {
    sentence = `${plural(n, "customer reply", "customer replies")} to ${num(c.all)} messages (${share(n)}), from ${plural(s.people, "customer")}. `
      + (lag ? `The typical reply came ${duration(lag.median)} after the message was sent, and 9 in 10 came ${inTime(lag.p90)}.` : "")
  } else if (st === "read") {
    sentence = `${plural(n, "message")} (${share(n)} of all) were opened but not answered, for ${plural(s.people, "customer")}. `
      + (lag ? `They were typically read ${duration(lag.median)} after sending, and 9 in 10 ${inTime(lag.p90)}.` : "")
  } else if (st === "delivered") {
    sentence = `${plural(n, "message")} (${share(n)} of all) reached the phone but show no sign of being opened, for ${plural(s.people, "customer")}. `
      + (lag ? `They typically arrived ${duration(lag.median)} after sending.` : "")
  } else {
    sentence = `${plural(n, "message")} (${share(n)} of all) have no delivery news, for ${plural(s.people, "customer")}. `
      + (n ? `${num(s.sentRecent)} ${s.sentRecent === 1 ? "was" : "were"} sent in the last hour and ${num(s.sentOld)} ${s.sentOld === 1 ? "is" : "are"} over a day old.` : "")
  }

  type Tile = { label: string; value: string; sub: string; tone?: string; wide?: boolean; small?: boolean }
  const topT = tpls[0]
  const busiest: Tile = { label: st === "all" ? "Busiest template" : "Top template", value: topT?.name ?? "—", sub: topT ? `${num(topT.n)} messages${s.templates > 1 ? ` · ${num(s.templates)} templates` : ""}` : "", small: true, wide: true }
  const tiles: Tile[] = st === "all" ? [
    { label: "Messages", value: num(c.all), sub: `to ${num(s.people)} customers` },
    { label: "Reached the phone", value: share(reached), sub: `${num(reached)} messages` },
    { label: "Read", value: share(readUp), sub: `${num(readUp)} messages` },
    { label: "Replied", value: share(c.replied), sub: `${num(c.replied)} messages`, tone: "good" },
    { label: "Failed", value: share(c.failed), sub: `${num(c.failed)} messages`, tone: c.failed / c.all > 0.05 ? "bad" : "" },
    busiest,
  ] : [
    { label: "Messages", value: num(n), sub: `${share(n)} of all ${num(c.all)}`, tone: st === "failed" && n ? "bad" : st === "replied" ? "good" : "" },
    { label: "Customers", value: num(s.people), sub: `${plural(s.templates, "template")}` },
    ...(lag && LAG_LABEL[st] ? [{ label: LAG_LABEL[st], value: duration(lag.median), sub: `9 in 10 ${inTime(lag.p90)}` }] : []),
    ...(st === "sent" ? [{ label: "Sent in the last hour", value: num(s.sentRecent), sub: "may still be on the way" }, { label: "Over a day old", value: num(s.sentOld), sub: "probably no report" }] : []),
    busiest,
  ]
  const stages = [
    { id: "replied", label: "Replied", n: c.replied, dot: "bg-good" },
    { id: "read", label: "Read", n: c.read, dot: "bg-c1" },
    { id: "delivered", label: "Delivered", n: c.delivered, dot: "bg-c2" },
    { id: "sent", label: "Sent only", n: c.sent, dot: "bg-muted-foreground" },
    { id: "failed", label: "Failed", n: c.failed, dot: "bg-bad" },
  ]

  const reasons = (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">Why messages failed</div>
      {!failN ? <p className="text-sm text-muted-foreground">No message failed in this selection.</p> : (
        <ul className="flex flex-col gap-2 text-sm">
          {causeList.map((x) => (
            <li key={x.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
              <span className="min-w-0"><span className="font-medium">{x.label}</span>
                <span className="block text-xs text-muted-foreground"><span style={{ color: FAIL_BUCKETS[x.bucket].color }}>{FAIL_BUCKETS[x.bucket].title}</span> · {x.todo}</span>
              </span>
              <span className="tnum text-right"><b>{num(x.n)}</b><span className="block text-xs text-muted-foreground">{share(x.n, failN)} of failures</span></span>
            </li>
          ))}
          {otherFail > 0 && <li className="flex items-baseline justify-between gap-3 text-muted-foreground"><span>Other reasons</span><span className="tnum">{num(otherFail)} · {share(otherFail, failN)}</span></li>}
        </ul>
      )}
    </div>
  )
  const templatesPanel = (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{st === "failed" ? "Templates with the most failures" : `Templates with the most ${st === "sent" ? "sent-only" : st} messages`}</div>
      {!tpls.length ? <p className="text-sm text-muted-foreground">No template is recorded for these messages.</p> : (
        <ul className="flex flex-col gap-2 text-sm">
          {tpls.map((t) => (
            <li key={t.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
              <span className="truncate" title={t.name}>{t.name}</span><span className="tnum"><b>{num(t.n)}</b> <span className="text-muted-foreground">· {share(t.n, n)}</span></span>
              <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-c1" style={{ width: `${(100 * t.n) / Math.max(1, tpls[0].n)}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  const meaning = (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">What this means</div>
      <p className="text-sm">{STATUS_MEANING[st]}</p>
      {STATUS_HINT[st] && <p className="mt-2 text-sm text-muted-foreground">{STATUS_HINT[st]}</p>}
    </div>
  )

  return (
    <section className="rounded-lg border bg-muted/20 p-3" aria-label={`Summary of ${STATUS_NAME[st] ?? "messages"}`}>
      <p className="text-sm font-medium">{STATUS_NAME[st] ?? "Messages"}: summary for {when}, {what}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{sentence}</p>
      {ignored.length > 0 && <p className="mt-1 text-xs text-muted-foreground">The {ignored.join(" and ")} filter does not apply to the message list, so it does not change this summary.</p>}
      <div className="mt-2.5 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(10.5rem, 1fr))" }}>
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-md border bg-card px-3 py-2" style={t.wide ? { gridColumn: "span 2" } : undefined}>
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className={cn("tnum truncate font-semibold tracking-tight", t.small ? "text-sm leading-7" : "text-xl", t.tone === "good" && "text-good", t.tone === "bad" && "text-bad")} title={t.small ? String(t.value) : undefined}>{t.value}</div>
            <div className="truncate text-xs text-muted-foreground" title={t.sub}>{t.sub}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {st === "all" ? (
          <>
            <div className="rounded-md border bg-card p-3">
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Where each message stopped (each counted once, at the furthest step it reached)</div>
              <ul className="flex flex-col gap-2 text-sm">
                {stages.map((r) => (
                  <li key={r.id} className="grid grid-cols-[0.6rem_6rem_minmax(0,1fr)] items-baseline gap-x-2">
                    <span className={cn("mt-1.5 size-2 self-start rounded-full", r.dot)} />
                    <span className="font-medium">{r.label}</span>
                    <span><b className="tnum">{num(r.n)}</b> <span className="tnum text-muted-foreground">· {share(r.n)}</span>
                      <span className="block text-xs leading-snug text-muted-foreground">{r.id === "failed" ? "It was never sent. The reasons are on the right." : STATUS_MEANING[r.id]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {reasons}
          </>
        ) : st === "failed" ? <>{reasons}{templatesPanel}</> : <>{meaning}{templatesPanel}</>}
      </div>
    </section>
  )
}

export function MessageLogCard({ params }: { params: Params }) {
  const phone = useIsMobile()   // on a phone the six-column table is shown as one card per message
  const { meta } = useFilters()
  const [status, setStatus] = useState<string>("all")
  const { reveal } = useReveal()
  const [q, setQ] = useState("")
  const [dq, setDq] = useState("")
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string>()
  const pkey = JSON.stringify(params)
  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { setPage(1); setOpen(null) }, [pkey, status, reveal])
  const ask = { ...params, status: status === "all" ? undefined : status, reveal: reveal ? 1 : undefined, search: reveal && dq ? dq : undefined }
  const d = useApi<any>("messages/log", { ...ask, page, limit: 25 })
  const data = d.data
  const rs = useColResize(6, !!data?.rows?.length)
  const canReveal = !!meta?.canReveal && data?.canReveal !== false
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 25))
  const first = data?.total ? (page - 1) * 25 + 1 : 0

  /** Downloads every message that matches the filters (up to 5000), with the failure reason. Numbers and message text only while they are shown. */
  const exportCsv = async () => {
    setExporting(true); setExportErr(undefined)
    try {
      const x = await api<any>("messages/log", { ...ask, page: 1, limit: 5000 })
      const head = ["Sent (India time)", "Template", "Phone", "Result", "Delivered", "Read", "Replied", "Failure code", "Failure reason", "Who can fix it", "Number check", "Name check", ...(x.revealed ? ["Message"] : [])]
      const body = x.rows.map((r: any) => {
        const c = classifyMsg(r)
        return [
          csvCell(r.at?.replace("T", " ")), csvCell(r.template), x.revealed && r.phone ? `="${r.phone}"` : csvCell(r.phone), csvCell(LOG_STYLE[r.status]?.label ?? r.status),   // ="..." keeps Excel from turning the number into 9.19E+11
          csvCell(r.times.delivered?.replace("T", " ")), csvCell(r.times.read?.replace("T", " ")), csvCell(r.times.replied?.replace("T", " ")),
          csvCell(c?.code), csvCell(c?.label), csvCell(c ? FAIL_BUCKETS[bucketOf(c.group.id)].title : ""), csvCell(phoneIssue(r.phone_issue)?.label), csvCell(nameIssue(r.name_issue)?.label), ...(x.revealed ? [csvCell(r.text)] : []),
        ]
      })
      const text = "﻿" + [head.map(csvCell), ...body].map((l: string[]) => l.join(",")).join("\r\n")   // BOM so Excel reads Hindi names correctly
      const a = document.createElement("a")
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
      a.download = `messages-${format(new Date(), "yyyy-MM-dd")}${x.revealed ? "" : "-masked"}.csv`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e: any) { setExportErr(e.message) } finally { setExporting(false) }
  }

  return (
    <ChartCard title="Every message we sent" description={data?.capturing ? `Every message we sent, newest first, with what happened to it and why it failed. ${canReveal ? "Use the “Show phone numbers and messages” switch at the top of the page to read the text. " : ""}Click a row to see the full story. Messages are saved from ${day(data.since)} on, so earlier ones are not listed. This list counts every message, so it can be higher than the numbers at the top, which count each person once per template.` : "Each message sent to a customer, with what happened to it and why it failed."}
>
      {d.error ? <ErrorNote message={d.error} /> : !data ? <ChartSkeleton h={260} /> : !data.capturing ? (
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex flex-col gap-1.5">
            <p className="font-medium">{data.setup ? "The message list needs one more database step." : "No messages have been saved yet."}</p>
            <p className="text-muted-foreground">{data.setup ? <>Ask whoever looks after the database to run <code>server/sql/LIVE_SETUP.sql</code> again (it is safe to repeat). It adds the view this list reads, and this card then fills in on its own.</> : <>The n8n workflow has to save WATI's status events first (the “Save status event” step in <code>HAND_OFF_FOR_SENIOR.md</code>, section 5). Messages show up here from the moment it is switched on.</>}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-wrap items-center justify-center gap-2" role="group" aria-label="Show messages that were">
            {LOG_STATUS.map((s) => {
              const n = data.counts[s.id], on = status === s.id
              return (
                <button key={s.id} type="button" aria-pressed={on} onClick={() => setStatus(s.id)} title={s.id === "all" ? "Every message in this selection." : STATUS_MEANING[s.id]}
                  className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors", on ? "border-foreground/30 bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50", s.id === "failed" && n > 0 && !on && "text-bad")}>
                  {s.label}<span className="tnum text-xs text-muted-foreground">{num(n)}</span>
                </button>
              )
            })}
            {reveal && canReveal && (
              <div className="relative w-full max-w-xs sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by phone number" className="pl-8" aria-label="Search by phone number" />
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={exportCsv} disabled={exporting || !data.total} title={reveal && canReveal ? "Downloads every matching message, with full numbers and the message text" : "Downloads every matching message. Numbers and text stay hidden unless you switch them on at the top of the page first."}><Download className="size-3.5" />{exporting ? "Preparing…" : "Export CSV"}</Button>
          </div>
          <p className="-mt-2 text-center text-xs text-muted-foreground">Each message is counted once, at the furthest step it reached. “Delivered” means delivered but not yet read. “Sent only” means WhatsApp took the message but no delivery news came back (still on its way, phone off, or not reported). Hover a button for more.</p>
          <StatusSummary data={data} params={params} />
          {exportErr && <ErrorNote message={exportErr} />}
          {data.rows.length === 0 ? <Empty>{status === "all" ? "No messages in this date range." : "No messages like that in this date range."}</Empty> : (
            phone ? (
              <div className={cn("flex flex-col divide-y rounded-lg border transition-opacity", d.loading && "opacity-60")}>
                {data.rows.map((r: any) => {
                  const st = LOG_STYLE[r.status] ?? LOG_STYLE.sent, isOpen = open === r.id
                  const c = classifyMsg(r), B = c ? FAIL_BUCKETS[bucketOf(c.group.id)] : null
                  const warn = [phoneIssue(r.phone_issue)?.label && `Number: ${phoneIssue(r.phone_issue)!.label}`, nameIssue(r.name_issue)?.label && `Name: ${nameIssue(r.name_issue)!.label}`].filter(Boolean).join(". ")
                  return (
                    <div key={r.id} tabIndex={0} role="button" aria-expanded={isOpen} className={cn("cursor-pointer px-3 py-2.5 text-left", isOpen && "bg-muted/40")} onClick={() => setOpen(isOpen ? null : r.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : r.id) } }}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-all text-sm font-medium">{r.template}</span>
                        <span className={cn("inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium", st.cls)}>{st.label}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"><ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} aria-hidden />{whenAt(r.at)} · {r.phone || "—"}{warn && <TriangleAlert className="size-3.5 text-warn" aria-label={warn}><title>{warn}</title></TriangleAlert>}</div>
                      <div className="mt-1 text-sm">{activityLine(r, !!data.revealed)}</div>
                      {c && B && <div className="mt-1 text-xs"><span style={{ color: B.color }}>{B.title}</span> · {c.because ? `Most likely because ${c.because}.` : c.label}</div>}
                      {isOpen && <div className="-mx-3 mt-2 border-t bg-muted/20" onClick={(e) => e.stopPropagation()}><LogDetail r={r} revealed={!!data.revealed} canReveal={canReveal} /></div>}
                    </div>
                  )
                })}
              </div>
            ) :
            <div className={cn("max-h-[34rem] overflow-auto rounded-lg border transition-opacity", d.loading && "opacity-60")}>
              <Table ref={rs.ref} style={rs.style}>
                {rs.colgroup}
                <TableHeader className={STICKY_HEAD}>
                  <TableRow>
                    {["Sent", "Template", "To", "Activity", "What happened", "Why it failed"].map((t, i) => <TableHead key={t} className={cn("relative whitespace-nowrap text-center", rs.line)}>{t}{rs.handle(i)}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r: any) => {
                    const st = LOG_STYLE[r.status] ?? LOG_STYLE.sent, isOpen = open === r.id
                    const c = classifyMsg(r), B = c ? FAIL_BUCKETS[bucketOf(c.group.id)] : null
                    const warn = [phoneIssue(r.phone_issue)?.label && `Number: ${phoneIssue(r.phone_issue)!.label}`, nameIssue(r.name_issue)?.label && `Name: ${nameIssue(r.name_issue)!.label}`].filter(Boolean).join(". ")
                    return [
                      <TableRow key={r.id} tabIndex={0} aria-expanded={isOpen} className={cn("cursor-pointer", isOpen && "bg-muted/40")} onClick={() => setOpen(isOpen ? null : r.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : r.id) } }}>
                        <TableCell className={cn("whitespace-nowrap text-center overflow-hidden text-ellipsis", rs.line)}><ChevronRight className={cn("mr-1 inline size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden />{whenAt(r.at)}</TableCell>
                        <TableCell className={cn("text-center overflow-hidden text-ellipsis", rs.line)}><span className="mx-auto block max-w-[16rem] truncate font-medium" title={r.template}>{r.template}</span></TableCell>
                        <TableCell className={cn("whitespace-nowrap text-center overflow-hidden text-ellipsis", rs.line)}>{r.phone || "—"}{warn && <TriangleAlert className="ml-1.5 inline size-3.5 text-warn" aria-label={warn}><title>{warn}</title></TriangleAlert>}</TableCell>
                        <TableCell className={cn("text-center overflow-hidden text-ellipsis", rs.line)}><span className="mx-auto block max-w-[26rem] truncate" title={activityLine(r, !!data.revealed)}>{activityLine(r, !!data.revealed)}</span></TableCell>
                        <TableCell className={cn("text-center overflow-hidden text-ellipsis", rs.line)}><span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium", st.cls)}>{st.label}</span></TableCell>
                        <TableCell className={cn("text-center overflow-hidden text-ellipsis", rs.line)}>{c && B ? (c.because
                          ? <span className="mx-auto flex max-w-[22rem] flex-col whitespace-normal text-center"><span>Most likely because {c.because}.</span><span className="text-xs text-muted-foreground">WhatsApp said: {c.via}</span></span>
                          : <span className="flex flex-col"><span>{c.label}</span><span className="text-xs" style={{ color: B.color }}>{B.title}</span></span>)
                        : <span className="text-muted-foreground">—</span>}</TableCell>
                      </TableRow>,
                      isOpen && <TableRow key={r.id + "-detail"} className="bg-muted/20 hover:bg-muted/20"><TableCell colSpan={6} className="whitespace-normal p-0"><LogDetail r={r} revealed={!!data.revealed} canReveal={canReveal} /></TableCell></TableRow>,
                    ]
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {data.total > 25 && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <span className="tnum">Showing {num(first)} to {num(Math.min(page * 25, data.total))} of {num(data.total)}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-3.5" />Previous</Button>
                <span className="tnum">Page {page} of {pages}</span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next<ChevronRight className="size-3.5" /></Button>
              </div>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  )
}
