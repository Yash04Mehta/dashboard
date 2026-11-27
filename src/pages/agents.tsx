import { useState } from "react"
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { format, parseISO } from "date-fns"
import { Bot, CircleCheck, Clock, Headset, Hourglass, Info, Timer, TriangleAlert, Users, Zap } from "lucide-react"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { LiveBadge, LivePage } from "@/components/v1"
import { Pill } from "@/components/chat-bits"
import { useSeen } from "@/components/lazy"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useReveal } from "@/lib/reveal"
import { day, duration, hourLabel, num, pct, periodLabel, ppDelta, relDelta } from "@/lib/format"

/**
 * Agents: the people who handle the WhatsApp chats. Who got which chats, how many they answered, how many ran out of time unanswered, and how long customers waited.
 * Reply time comes from WATI's own record plus the team replies our workflow saved, and every figure says how many chats it rests on (see agents.mjs for the rules).
 */
export default function Agents() {
  return <LivePage><Page /></LivePage>
}

// the outcome of a chat, from WATI's reply state. Plain words, no WhatsApp or WATI jargon.
const OUTCOME = {
  answered: { label: "Answered", color: "var(--good)", what: "The customer's latest message has been answered by a person." },
  waiting: { label: "Waiting for us", color: "var(--warn)", what: "The customer's latest message has no reply yet, and the 24 hours have not run out. A free reply is still possible." },
  missed: { label: "Missed", color: "var(--bad)", what: "The customer's latest message never got a reply and 24 hours have passed, so a free reply is no longer possible." },
  bot: { label: "Answered by a bot", color: "var(--c2)", what: "A bot answered the latest message, not the assigned person." },
} as const
// whose turn it is, shown on each chat. If the customer is waiting for a reply it is "Waiting for us"; once a person or a bot has replied it is "Waiting for customer".
const STATE = {
  waiting_us: { label: "Waiting for us", color: "var(--warn)", what: "The customer wrote and nobody has replied yet, and the 24 hours have not run out. The next move is ours." },
  waiting_customer: { label: "Waiting for customer", color: "var(--c1)", what: "A person or a bot has replied and we are waiting for the customer to write back." },
  solved: { label: "Solved", color: "var(--good)", what: "Closed in WATI." },
  missed: { label: "Missed", color: "var(--bad)", what: OUTCOME.missed.what },
} as const
type StateKey = keyof typeof STATE
const SRC_LABEL: Record<string, string> = { messages: "Our saved message", wati: "WATI's record" }
const LOW = 5   // fewer measured replies than this is only a rough guide

const when = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
const Chip = ({ k }: { k: string }) => {
  const o = (STATE as any)[k]
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={o?.what}><span className="size-2 rounded-full" style={{ background: o?.color }} />{o?.label ?? k}</span>
}
/** a reply time with the number of chats it rests on, so a figure from 2 chats does not look as solid as one from 40 */
const Timed = ({ min, n }: { min?: number | null; n: number }) => (
  <span className="whitespace-nowrap" title={n < LOW ? `Only ${n} measured ${n === 1 ? "reply" : "replies"}: treat this as a rough guide.` : `${n} measured replies`}>
    {min == null ? "—" : duration(min)}<span className={n < LOW ? "ml-1 text-xs text-warn" : "ml-1 text-xs text-muted-foreground"}>({n})</span>
  </span>
)

const trendCfg: ChartConfig = { chats: { label: "Chats", color: "var(--c1)" }, median: { label: "Typical reply time", color: "var(--warn)" } }
const minAxis = (v: number) => (v >= 1440 ? Math.round(v / 1440) + "d" : v >= 60 ? Math.round(v / 60) + "h" : v + "m")
const tip = (cfg: ChartConfig) => (v: any, name: any, item: any) => (
  <div className="flex w-full items-center gap-2"><span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item?.color }} /><span className="text-muted-foreground">{(cfg as any)[name]?.label ?? name}</span>
    <span className="ml-auto pl-3 font-mono font-medium tabular-nums text-foreground">{v == null ? "—" : name === "median" ? duration(v) : num(v)}</span></div>
)

function Page() {
  const { params, filters, set } = useFilters()
  const { reveal } = useReveal()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to)
  const [outcome, setOutcome] = useState<"all" | StateKey>("all")
  const [lowRef, low] = useSeen()   // the chat list at the bottom is asked for only when you scroll near it

  const base = { from: params.from, to: params.to, owners: params.owners }
  const ov = useApi<any>("agents/overview", { ...base, grain })
  const list = useApi<any>(low ? "agents/chats" : null, { ...base, status: outcome === "all" ? undefined : outcome, reveal: reveal ? 1 : undefined, limit: 200 })

  const d = ov.data
  const setup = !!d?.setup
  const t = d?.team, p = d?.previous, cov = d?.coverage
  const hasPrev = !!p && p.chats > 0
  const agentNames: string[] = (d?.agents ?? []).map((a: any) => a.agent)
  const selected: string[] = filters.owners
  const trendRows = (d?.trend ?? []).map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))
  const hourRows = (d?.hours ?? []).map((r: any) => ({ ...r, label: hourLabel(r.hour) }))
  const pick = (name: string) => set({ owners: selected.length === 1 && selected[0] === name ? [] : [name] })

  const cols: Col<any>[] = [
    { key: "agent", header: "Agent", value: (r) => r.agent, render: (r) => <span className={selected.includes(r.agent) ? "font-semibold text-primary" : "font-medium"}>{r.agent}</span> },
    { key: "chats", header: "Chats", align: "right", value: (r) => r.chats, render: (r) => num(r.chats), hint: "Conversations assigned to this agent where the customer wrote in the selected dates (dated by the customer's last message)." },
    { key: "answered", header: "Answered", align: "right", value: (r) => r.answered_pct, render: (r) => <span title={`${num(r.answered)} of ${num(r.chats)} chats`}>{num(r.answered)} <span className="text-muted-foreground">· {pct(r.answered_pct, 0)}</span></span>, hint: OUTCOME.answered.what },
    { key: "missed", header: "Missed", align: "right", value: (r) => r.missed, render: (r) => <span className={r.missed > 0 ? "font-medium text-bad" : undefined} title={`${pct(r.missed_pct)} of this agent's chats`}>{num(r.missed)} <span className="font-normal text-muted-foreground">· {pct(r.missed_pct, 0)}</span></span>, hint: OUTCOME.missed.what },
    { key: "waiting", header: "Waiting for us", align: "right", value: (r) => r.waiting, render: (r) => num(r.waiting), hint: STATE.waiting_us.what },
    { key: "waiting_customer", header: "Waiting for customer", align: "right", value: (r) => r.waiting_customer, render: (r) => num(r.waiting_customer), hint: STATE.waiting_customer.what },
    { key: "median", header: "Typical reply", align: "right", value: (r) => r.median, render: (r) => <Timed min={r.median} n={r.measured} />, hint: "The middle reply time: half of this agent's replies were quicker, half slower. One very slow reply does not distort it. The number in brackets is how many replies it rests on." },
    { key: "w60", header: "Within 1 hour", align: "right", value: (r) => r.within_60_pct, render: (r) => (r.measured ? pct(r.within_60_pct, 0) : "—"), hint: "Share of measured replies that came within an hour." },
    { key: "open", header: "Open now", align: "right", value: (r) => r.open + r.pending, render: (r) => <span title={`${r.open} open, ${r.pending} pending`}>{num(r.open + r.pending)}</span>, hint: "Chats open or pending in WATI right now, whatever dates are picked." },
    { key: "solved", header: "Solved", align: "right", value: (r) => r.solved, render: (r) => num(r.solved), hint: "Chats this agent marked solved in WATI." },
  ]
  const listCols: Col<any>[] = [
    { key: "customer", header: "Customer", value: (r) => r.customer, render: (r) => <span className="mx-auto block max-w-[10rem] truncate font-medium" title={r.customer}>{r.customer}</span> },
    { key: "phone", header: "Phone", value: (r) => r.phone ?? "", render: (r) => <span className="whitespace-nowrap">{r.phone ?? "—"}</span> },
    { key: "owner", header: "Agent", value: (r) => r.owner, render: (r) => <span className="whitespace-nowrap">{r.owner}{r.is_bot && <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">bot</span>}</span> },
    { key: "state", header: "Chat state", value: (r) => (STATE as any)[r.state]?.label, render: (r) => <Chip k={r.state} />, hint: "Whose turn it is. Waiting for us: the customer wrote and nobody has replied. Waiting for customer: a person or a bot has replied and we are waiting for them to write back." },
    { key: "wrote", header: "Customer wrote", value: (r) => r.wait_from ?? r.cust_last, render: (r) => <span className="whitespace-nowrap">{when(r.wait_from ?? r.cust_last)}</span>, hint: "When the customer's message was sent. For a reply measured from our saved messages this is their first message; otherwise their last." },
    { key: "replied", header: "Replied", value: (r) => r.reply_at, render: (r) => <span className="whitespace-nowrap">{when(r.reply_at)}</span> },
    { key: "rt", header: "Reply time", align: "right", value: (r) => r.rt, render: (r) => <span className="whitespace-nowrap">{r.rt == null ? "—" : duration(r.rt)}</span> },
    { key: "src", header: "Measured from", value: (r) => SRC_LABEL[r.src] ?? "", render: (r) => <span className="whitespace-nowrap text-muted-foreground">{SRC_LABEL[r.src] ?? "—"}</span>, hint: "Our saved message = the exact time of the customer's first message and the first reply a person typed. WATI's record = the customer's last message and WATI's own reply time, used when we did not save the reply." },
  ]
  const botCols: Col<any>[] = [
    { key: "agent", header: "Bot", value: (r) => r.agent, render: (r) => <span className="font-medium">{r.agent}</span> },
    { key: "chats", header: "Chats", align: "right", value: (r) => r.chats, render: (r) => num(r.chats) },
    { key: "answered", header: "Answered", align: "right", value: (r) => r.answered, render: (r) => num(r.answered) },
    { key: "missed", header: "Missed", align: "right", value: (r) => r.missed, render: (r) => num(r.missed) },
    { key: "median", header: "Typical reply", align: "right", value: (r) => r.median, render: (r) => <Timed min={r.median} n={r.measured} /> },
  ]

  if (setup) return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Agents" description="Who handles your WhatsApp chats and how fast they reply." />
      <ChartCard title="One setup step is missing" description="The database is not ready for this page yet.">
        <div className="flex flex-col gap-2 text-sm">
          <p>This page needs WATI's own conversation data (the “WATI Status Sync” workflow) and the saved chat messages (<code>server/sql/chats.sql</code>). The dashboard also has to be connected to the live database: the saved snapshot has no agent data.</p>
        </div>
      </ChartCard>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Agents" description="Who handles your WhatsApp chats, how many they answer, and how long customers wait for a reply." actions={<LiveBadge updatedAt={ov.updatedAt} />} />
      <FilterBar kinds={["owners"]} ownerOptions={agentNames} ownerLabel="Agent" reveal />
      <ErrorNote message={ov.error} />

      {cov && (
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p>
              <span className="font-medium">How much this rests on: </span>
              reply times are measured for <b className="tnum">{num(cov.human_measured)}</b> of <b className="tnum">{num(cov.human_chats)}</b> chats assigned to people
              ({num(cov.human_from_messages)} from our saved messages, {num(cov.human_from_wati)} from WATI's own record). The rest have not been answered by a person.
              {cov.no_owner > 0 && <> {num(cov.no_owner)} chats have no owner and are left out.</>}
            </p>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer select-none text-foreground">How is reply time measured?</summary>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <p><b className="text-foreground">Reply time</b> is how long the customer waited, from their message to the first reply a person gave. It is real clock time, nights and weekends included (the “When customers wrote” chart shows which hours are slow). Bots are counted separately and never added to a person's numbers.</p>
                <p><b className="text-foreground">Two sources, used together.</b> Where we saved the team's reply, the time is exact: the customer's first message to the first reply a person typed. Where we did not, we use WATI's own record of when the chat was answered, measured from the customer's last message. When we checked on 16 Nov 2026, the two agreed within 2 minutes on all 18 chats that had both. The “Measured from” column in the list at the bottom shows which one each chat used.</p>
                <p><b className="text-foreground">Why not just our saved messages?</b> The workflow has saved only {num(cov.team_msgs)} team replies against {num(cov.cust_msgs)} customer messages ({day(cov.messages_from)} to {day(cov.messages_to)}). That is too few to measure with, which is also why “Replies typed” undercounts what agents really sent. Saving every agent reply in the n8n workflow would make this page exact.</p>
                <p><b className="text-foreground">Chats</b> are WATI conversations, dated by the day the customer last wrote, owned by the person WATI shows as assigned now. WATI's records start on {day(cov.wati_from)} and our saved messages on {day(cov.messages_from)}. “Missed” means the customer's latest message never got a reply and 24 hours passed. A chat answered earlier whose newer message got no reply counts as not answered, but its earlier reply time still counts. {d?.evaluated_at ? `WATI data last refreshed ${when(d.evaluated_at)} India time.` : ""}</p>
              </div>
            </details>
          </div>
        </div>
      )}

      {selected.length > 0 && <p className="-mt-3 text-sm text-muted-foreground">Showing {selected.join(", ")} only in the numbers and charts below. The agent table always lists everyone: click a row again to show all agents.</p>}

      <ScoreGrid cols={4} title={selected.length ? "Selected agents" : "The whole team (people only, bots left out)"} stats={[
        { icon: Users, label: "Agents", loading: !t, value: num(t?.agents), foot: t && `${num(t.chats)} chats between them`, hint: "People who have chats assigned to them in these dates." },
        { icon: Headset, label: "Chats assigned", loading: !t, value: num(t?.chats), delta: hasPrev ? { value: relDelta(t.chats, p.chats), goodWhen: "up", unit: "%" } : undefined, foot: t && `${num(t.waiting)} waiting for us · ${num(t.waiting_customer)} waiting for the customer`, hint: "Conversations where the customer wrote in these dates and a person is assigned." },
        { icon: CircleCheck, label: "Answered", loading: !t, value: num(t?.answered), tone: "good", meter: t?.answered_pct, delta: hasPrev ? { value: ppDelta(t.answered_pct, p.answered_pct), goodWhen: "up" } : undefined, foot: t && `${pct(t.answered_pct)} of chats`, hint: OUTCOME.answered.what },
        { icon: TriangleAlert, label: "Missed", loading: !t, value: num(t?.missed), tone: "bad", meter: t?.missed_pct, delta: hasPrev ? { value: ppDelta(t.missed_pct, p.missed_pct), goodWhen: "down" } : undefined, foot: t && `${pct(t.missed_pct)} of chats`, hint: OUTCOME.missed.what },
        { icon: Timer, label: "Typical reply time", loading: !t, value: t?.median == null ? "—" : duration(t.median), delta: hasPrev && t.median != null && p.median != null ? { value: relDelta(t.median, p.median), goodWhen: "down", unit: "%" } : undefined, foot: t && (t.measured ? `average ${duration(t.avg)} · from ${num(t.measured)} replies${t.measured < LOW ? " (few)" : ""}` : "no replies measured yet"), hint: "Half of the replies were quicker than this and half slower. Shown as the middle value so one very slow reply does not distort it." },
        { icon: Hourglass, label: "Slowest 1 in 10", loading: !t, value: t?.p90 == null ? "—" : duration(t.p90), tone: t && t.p90 > 1440 ? "warn" : "default", foot: t && (t.measured ? `slowest reply ${duration(t.slowest)}` : undefined), hint: "9 in 10 replies were quicker than this. It shows how bad the slow end is." },
        { icon: Zap, label: "Replied within 5 minutes", loading: !t, value: t?.measured ? pct(t.within_5_pct) : "—", tone: "good", meter: t?.within_5_pct, delta: hasPrev && p.measured ? { value: ppDelta(t.within_5_pct, p.within_5_pct), goodWhen: "up" } : undefined, foot: t && `${num(t.within_5)} of ${num(t.measured)} measured replies`, hint: "Share of the measured replies that came within 5 minutes." },
        { icon: Clock, label: "Replied within 1 hour", loading: !t, value: t?.measured ? pct(t.within_60_pct) : "—", tone: "good", meter: t?.within_60_pct, delta: hasPrev && p.measured ? { value: ppDelta(t.within_60_pct, p.within_60_pct), goodWhen: "up" } : undefined, foot: t && `${num(t.within_60)} of ${num(t.measured)} measured replies`, hint: "Share of the measured replies that came within an hour." },
      ]} />

      <ChartCard title="Agents" description="Everyone who has chats assigned in these dates. Click a row to look at one agent in the numbers and charts on this page. Click again to go back to everyone.">
        {ov.error && !d ? <ErrorNote message={ov.error} /> : !d ? <ChartSkeleton h={240} /> : d.agents.length === 0 ? <Empty>No chats are assigned to people in these dates.</Empty> : (
          <SortableTable rows={d.agents} cols={cols} rowKey={(r: any) => r.agent} initialSort="chats" maxHeight="26rem" exportName="agents" onRowClick={(r: any) => pick(r.agent)} />
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-2" title="How long customers waited" description="Every measured reply, grouped by how long the customer waited.">
          {!d ? <ChartSkeleton h={260} /> : d.distribution.every((x: any) => x.n === 0) ? <Empty>No replies were measured in these dates.</Empty> : (
            <BarList rows={d.distribution.map((x: any) => ({ label: x.label, value: x.n, text: `${num(x.n)} · ${pct(t?.measured ? (100 * x.n) / t.measured : null, 0)}` }))}
              colorFor={(_, i) => ["var(--good)", "var(--good)", "var(--c2)", "var(--warn)", "var(--warn)", "var(--bad)", "var(--bad)"][i]} />
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-3" title="Chats and reply time over time" description="New chats (bars) and the typical reply time (line) per day, week or month."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {!d ? <ChartSkeleton h={260} /> : trendRows.length === 0 ? <Empty>No chats in these dates.</Empty> : (
            <ChartContainer config={trendCfg} className="h-[260px] w-full">
              <ComposedChart data={trendRows} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis yAxisId="n" {...axis} width={36} allowDecimals={false} />
                <YAxis yAxisId="m" orientation="right" {...axis} width={44} tickFormatter={minAxis} />
                <ChartTooltip content={<ChartTooltipContent formatter={tip(trendCfg)} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar yAxisId="n" dataKey="chats" fill="var(--color-chats)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Line yAxisId="m" dataKey="median" type="monotone" stroke="var(--color-median)" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </ChartCard>
      </div>

      <ChartCard title="When customers wrote" description="Chats by the hour the customer wrote (India time, bars) and the typical reply time for that hour (line). Slow hours show where customers wait longest. Nothing is adjusted for office hours.">
        {!d ? <ChartSkeleton h={260} /> : hourRows.every((r: any) => !r.chats) ? <Empty>No chats in these dates.</Empty> : (
          <ChartContainer config={trendCfg} className="h-[260px] w-full">
            <ComposedChart data={hourRows} margin={{ left: 4, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...axis} interval={1} />
              <YAxis yAxisId="n" {...axis} width={36} allowDecimals={false} />
              <YAxis yAxisId="m" orientation="right" {...axis} width={44} tickFormatter={minAxis} />
              <ChartTooltip content={<ChartTooltipContent formatter={tip(trendCfg)} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar yAxisId="n" dataKey="chats" fill="var(--color-chats)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Line yAxisId="m" dataKey="median" type="monotone" stroke="var(--color-median)" strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
        )}
      </ChartCard>

      {d && d.bots.length > 0 && (
        <ChartCard title="Bots" description="Chats assigned to a bot. They are shown here and never added to a person's numbers above. Missed means the customer's latest message got no reply from the bot either." actions={<Bot className="size-4 text-muted-foreground" />}>
          <SortableTable rows={d.bots} cols={botCols} rowKey={(r: any) => r.agent} initialSort="chats" maxHeight="12rem" exportName="bots" />
        </ChartCard>
      )}

      <div ref={lowRef}>
        <ChartCard title="The chats behind these numbers" description="Newest first, up to 200. Check any figure above against the chats it comes from. Phone numbers stay masked unless you switch them on at the top of the page."
          actions={<div className="flex flex-wrap gap-2" role="group" aria-label="Show chats that were">
            <Pill on={outcome === "all"} onClick={() => setOutcome("all")}>All</Pill>
            {(["waiting_us", "waiting_customer", "solved", "missed"] as StateKey[]).map((k) => <Pill key={k} on={outcome === k} color={STATE[k].color} title={STATE[k].what} onClick={() => setOutcome(k)}>{STATE[k].label}</Pill>)}
          </div>}>
          {list.error && !list.data ? <ErrorNote message={list.error} /> : !list.data ? <ChartSkeleton h={260} /> : list.data.rows.length === 0 ? <Empty>No chats like that in these dates.</Empty> : (
            <SortableTable rows={list.data.rows} cols={listCols} rowKey={(r: any) => r.id} initialSort="wrote" maxHeight="30rem" exportName="agent-chats" />
          )}
        </ChartCard>
      </div>
    </div>
  )
}
