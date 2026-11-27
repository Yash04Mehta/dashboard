import { useState } from "react"
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, XAxis, YAxis } from "recharts"
import { format, parseISO } from "date-fns"
import { Bot, CircleCheck, Clock, Coins, Hourglass, Inbox as InboxIcon, Info, MessagesSquare, PiggyBank, Reply, Send, Timer, TriangleAlert, UserCheck, UserX } from "lucide-react"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis, rowFormatter } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { LiveBadge, LivePage } from "@/components/v1"
import { Pill } from "@/components/chat-bits"
import { useSeen } from "@/components/lazy"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useReveal } from "@/lib/reveal"
import { day, duration, hourLabel, money, num, one, pct, periodLabel, ppDelta, relDelta } from "@/lib/format"

/** Chats: the WATI Inbox Analytics overview (activity tiles, status over time, status donut, volume heat map, chat length, operator performance),
 *  with what every chat cost in template messages next to it, and the chat list underneath. Built from public.wati_messages (the new webhook). */
export default function ChatsV1() {
  return <LivePage><Page /></LivePage>
}

// A chat's status is our own measure from the messages we hold. WATI's Open / Pending / Solved are ticket states the webhook does not carry.
const STATUS = {
  waiting: { label: "Needs our reply", short: "Needs our reply", color: "var(--warn)", what: "The customer wrote in the last 24 hours and nobody on our team has replied yet." },
  replied: { label: "Answered", short: "Answered", color: "var(--good)", what: "Our team replied to the customer's last message." },
  missed: { label: "Missed", short: "Missed", color: "var(--bad)", what: "The customer wrote more than 24 hours ago and nobody replied. After 24 hours a free reply is no longer possible." },
  outbound: { label: "Awaiting customer", short: "Awaiting customer", color: "var(--c2)", what: "We sent the customer a message and they have not written back." },
} as const
type StatusKey = keyof typeof STATUS
const ORDER: StatusKey[] = ["waiting", "replied", "missed", "outbound"]

// Wording rule for this page: plain words a business user understands. No WhatsApp or WATI jargon (template, window, operator, assignee).
const statusCfg: ChartConfig = Object.fromEntries(ORDER.map((k) => [k, { label: STATUS[k].label, color: STATUS[k].color }]))
const SERIES = [
  { key: "chats", label: "All chats", color: "var(--c1)" },
  { key: "replied", label: STATUS.replied.short, color: STATUS.replied.color },
  { key: "waiting", label: STATUS.waiting.short, color: STATUS.waiting.color },
  { key: "missed", label: STATUS.missed.short, color: STATUS.missed.color },
  { key: "outbound", label: STATUS.outbound.short, color: STATUS.outbound.color },
] as const
type SeriesKey = (typeof SERIES)[number]["key"]
const lineCfg: ChartConfig = Object.fromEntries(SERIES.map((s) => [s.key, { label: s.label, color: s.color }]))
const lenCfg: ChartConfig = { chats: { label: "Chats", color: "var(--c1)" }, avg_min: { label: "Average length", color: "var(--c4)" } }
const spendCfg: ChartConfig = { spend: { label: "Cost", color: "var(--c1)" }, chats: { label: "Chats", color: "var(--c4)" } }
const flowCfg: ChartConfig = { sent: { label: "Sent by us", color: "var(--c1)" }, received: { label: "Received from customers", color: "var(--good)" } }
// each message we sent counts once, at the furthest step it reached (the same rule as the message list on Messages)
const DELIVERY = [
  { key: "replied", label: "Replied", color: "var(--good)" },
  { key: "read", label: "Read", color: "var(--c1)" },
  { key: "delivered", label: "Delivered", color: "var(--c2)" },
  { key: "sent_only", label: "Sent, not delivered yet", color: "var(--muted-foreground)" },
  { key: "failed", label: "Failed", color: "var(--bad)" },
] as const
const deliveryCfg: ChartConfig = Object.fromEntries(DELIVERY.map((d) => [d.key, { label: d.label, color: d.color }]))
const TYPE_LABEL: Record<string, string> = { text: "Text", template: "Template (ready-made)", image: "Image", video: "Video", document: "Document", audio: "Voice or audio", interactive: "Buttons or list", button: "Button reply", sticker: "Sticker", location: "Location", unknown: "Not saved" }
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1)
const ViewUpdateNote = () => (
  <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm">
    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    <p className="text-muted-foreground">One setup step is missing for this card. Ask whoever looks after the database to run <code>server/sql/chats.sql</code> again (it is safe to run again). The card then fills in on its own.</p>
  </div>
)

const when = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
const StatusChip = ({ s }: { s: string }) => {
  const st = (STATUS as any)[s]
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={st?.what}><span className="size-2 rounded-full" style={{ background: st?.color }} />{st?.short ?? s}</span>
}

function Page() {
  const { params, filters, meta } = useFilters()
  const { reveal, canReveal } = useReveal()
  const [slot, setSlot] = useState<"chats" | "unassigned">("chats")
  const [by, setBy] = useState<"hour" | "weekday">("hour")
  const [shown, setShown] = useState<Record<SeriesKey, boolean>>({ chats: true, replied: true, waiting: true, missed: true, outbound: false })
  const [listStatus, setListStatus] = useState<"all" | "unassigned" | StatusKey>("all")   // "unassigned" is not a status: the customer wrote and nobody owns the chat

  const kpis = useApi<any>("chats/kpis", params)
  const cov = kpis.data?.coverage
  const [grain, setGrain] = useAutoGrain(filters.from ?? cov?.from_day, filters.to ?? cov?.to_day)
  const trend = useApi<any>("chats/trend", { ...params, grain })
  const [lowRef, low] = useSeen()   // the lower half of the page asks the server only once you scroll near it
  const dur = useApi<any>(low ? "chats/duration" : null, { ...params, grain })
  const heat = useApi<any>(low ? "chats/heatmap" : null, params)
  const ops = useApi<any>(low ? "chats/operators" : null, params)
  const cost = useApi<any>("chats/cost", { ...params, grain })
  const flow = useApi<any>(low ? "chats/flow" : null, { from: params.from, to: params.to, owners: params.owners, grain })
  const mtypes = useApi<any>(low ? "chats/message-types" : null, { from: params.from, to: params.to, owners: params.owners })
  const deliv = useApi<any>(low ? "chats/delivery" : null, { from: params.from, to: params.to, owners: params.owners })
  const wst = useApi<any>("chats/wati-status", { from: params.from, to: params.to, owners: params.owners })
  const wop = useApi<any>("chats/wati-operators", { from: params.from, to: params.to, owners: params.owners })
  const wtg = useApi<any>("chats/wati-tags", { from: params.from, to: params.to, owners: params.owners })
  const people = useApi<any>("chats/operators", { from: params.from, to: params.to })   // everyone who owns chats, for the Agent filter (not narrowed by the filter itself)
  const ownerNames: string[] = (people.data?.rows ?? []).map((r: any) => r.operator).filter((x: string) => x && x !== "Name unknown")
  const list = useApi<any>(low ? "chats/list" : null, { ...params, status: listStatus === "all" ? undefined : listStatus, reveal: reveal ? 1 : undefined })

  const setup = !!kpis.data?.setup
  const empty = !!kpis.data?.empty
  const c = kpis.data?.current, p = kpis.data?.previous
  const hasPrev = !!p && p.chats > 0
  const t = cost.data?.totals, cur = cost.data?.currency ?? "INR"
  const donut = c ? ORDER.map((k) => ({ key: k, value: c[k] })).filter((d) => d.value > 0) : []
  const trendRows = (trend.data?.rows ?? []).map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))

  const opCols: Col<any>[] = [
    { key: "operator", header: "Agent", value: (r) => r.operator, render: (r) => <span className={r.operator === "Name unknown" ? "text-muted-foreground" : "font-medium"}>{r.operator}</span> },
    { key: "chats", header: "Chats", align: "right", value: (r) => r.chats, render: (r) => num(r.chats) },
    { key: "team", header: "Replies sent", align: "right", value: (r) => r.team_msgs, render: (r) => num(r.team_msgs), hint: "Messages this person typed to customers. These are free." },
    { key: "fr", header: "Reply time", align: "right", value: (r) => r.fr_median, render: (r) => <span className="whitespace-nowrap">{duration(r.fr_median)}</span>, hint: "How long this person usually takes to reply to a customer's first message." },
    { key: "hr", header: "Replied in 1 hour", align: "right", value: (r) => r.within_hour_pct, render: (r) => pct(r.within_hour_pct), hint: "Share of this person's chats where the first reply came within an hour." },
    { key: "missed", header: "Missed", align: "right", value: (r) => r.missed, render: (r) => <span className={r.missed > 0 ? "font-medium text-bad" : undefined}>{num(r.missed)}</span> },
    { key: "tpl", header: "Auto messages", align: "right", value: (r) => r.templates, render: (r) => num(r.templates), hint: "Ready-made WhatsApp messages (such as a welcome or follow-up message) sent in this person's chats. Each one is charged." },
  ]
  const statusCols: Col<any>[] = [
    { key: "status", header: "What happened", value: (r) => STATUS[r.status as StatusKey]?.label, render: (r) => <StatusChip s={r.status} /> },
    { key: "chats", header: "Chats", align: "right", value: (r) => r.chats, render: (r) => num(r.chats) },
    { key: "units", header: "Messages charged", align: "right", value: (r) => r.units, render: (r) => num(r.units) },
    { key: "spend", header: "Cost", align: "right", value: (r) => r.spend, render: (r) => <span className="font-medium">{money(r.spend, cur)}</span> },
    { key: "per", header: "Cost per chat", align: "right", value: (r) => r.cost_per_chat, render: (r) => money(r.cost_per_chat, cur) },
  ]
  const tplCols: Col<any>[] = [
    { key: "t", header: "Message", value: (r) => r.template, render: (r) => <span className="mx-auto block max-w-[14rem] truncate font-medium" title={r.template}>{r.template}</span> },
    { key: "cat", header: "Price type", value: (r) => r.category, render: (r) => <span title={r.assumed ? "This message is not on your price-type list, so the type was guessed" : undefined}>{r.category.toLowerCase()}{r.assumed ? " (guessed)" : ""}</span>, hint: "WhatsApp charges more for marketing messages than for utility ones." },
    { key: "u", header: "Sent", align: "right", value: (r) => r.units, render: (r) => num(r.units) },
    { key: "s", header: "Cost", align: "right", value: (r) => r.spend, render: (r) => <span className="font-medium">{money(r.spend, cur)}</span> },
  ]
  const listCols: Col<any>[] = [
    { key: "customer", header: "Customer", value: (r) => r.customer, render: (r) => <span className="mx-auto block max-w-[9rem] truncate font-medium" title={r.customer}>{r.customer}</span> },
    { key: "phone", header: "Phone", value: (r) => r.phone, render: (r) => <span className="whitespace-nowrap">{r.phone}</span> },
    { key: "status", header: "Status", value: (r) => STATUS[r.status as StatusKey]?.label, render: (r) => <StatusChip s={r.status} /> },
    { key: "owner", header: "Owner", value: (r) => r.owner ?? "", render: (r) => r.owner ?? <span className={r.unassigned ? "text-warn" : "text-muted-foreground"}>{r.unassigned ? "Unknown" : "—"}</span> },
    { key: "c", header: "From customer", align: "right", value: (r) => r.cust_msgs, render: (r) => num(r.cust_msgs) },
    { key: "tm", header: "From us", align: "right", value: (r) => r.team_msgs, render: (r) => num(r.team_msgs) },
    { key: "fr", header: "Reply time", align: "right", value: (r) => r.first_response_min, render: (r) => <span className="whitespace-nowrap">{duration(r.first_response_min)}</span> },
    { key: "tp", header: "Auto messages", align: "right", value: (r) => r.templates, render: (r) => num(r.templates), hint: "Ready-made WhatsApp messages we sent in this chat. Each one is charged." },
    { key: "cost", header: "Cost", align: "right", value: (r) => r.cost, render: (r) => <span className="font-medium">{r.cost ? money(r.cost, cur) : "—"}</span> },
    { key: "last", header: "Last message", value: (r) => r.last_at, render: (r) => <span className="whitespace-nowrap">{when(r.last_at)}</span> },
  ]

  // data is not there yet: say what to do instead of showing a page of zeros
  if (setup) return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chats" description="Every WhatsApp chat and what it cost." />
      <ChartCard title="One setup step is missing" description="The database is not ready for this page yet.">
        <div className="flex flex-col gap-2 text-sm">
          <p>Ask whoever looks after the database to run <code>server/sql/chats.sql</code> once (it is safe to run again). This page then fills in on its own.</p>
          <p className="text-muted-foreground">The dashboard also has to be connected to the live database. The saved snapshot has no chat data.</p>
        </div>
      </ChartCard>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chats" description="Every WhatsApp chat: who wrote, who replied, how fast, and what it cost." actions={<LiveBadge updatedAt={kpis.updatedAt} />} />
      <FilterBar kinds={["owners"]} ownerOptions={ownerNames} ownerLabel="Agent" reveal />
      <ErrorNote message={kpis.error} />
      {empty && <ChartCard title="No chats yet" description="Nothing has been saved so far."><p className="text-sm text-muted-foreground">Chats appear here as soon as the n8n workflow “Fetch Wati Data and send to Report” saves messages.</p></ChartCard>}
      {cov && !empty && <p className="-mt-3 text-sm text-muted-foreground">Showing chats from {day(cov.from_day)} to {day(cov.to_day)}. Earlier days are not tracked yet, so they appear empty. Labels like “Needs our reply” are worked out by this dashboard from the messages we have. They are not WATI's own labels.</p>}

      {wst.data && !wst.data.available && <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">WATI's own numbers (Open, Pending, Solved, owners and tags) are not connected yet. They appear here as soon as the “WATI Status Sync” workflow is switched on.</p>}
      {wst.data?.available && (
        <div className="flex flex-col gap-4">
          <ScoreGrid cols={4} title={`WATI's own numbers${wst.data.evaluated_at ? ` (updated ${when(wst.data.evaluated_at)})` : ""}`} stats={[
            { icon: InboxIcon, label: "Open", value: num(wst.data.live.open), tone: "warn", foot: "right now", hint: "Tickets that are open in WATI right now. This is a live count and ignores the dates." },
            { icon: Hourglass, label: "Pending", value: num(wst.data.live.pending), foot: "right now", hint: "Our team replied and is waiting for the customer. This is a live count and ignores the dates." },
            { icon: CircleCheck, label: "Solved", value: num(wst.data.period.solved), tone: "good", foot: `${num(wst.data.period.solved_by_operator)} by people`, hint: "Marked solved by a person or a bot. Follows the dates." },
            { icon: Bot, label: "Solved by bot", value: num(wst.data.period.solved_by_bot), tone: "good", foot: "solved while assigned to a bot", hint: "Solved while the chat was assigned to a bot." },
            { icon: Clock, label: "Expired", value: num(wst.data.period.expired), tone: "warn", foot: "expired in these dates", hint: "More than 24 hours since the customer's last message and not marked solved. A chat counts on the day it expired (24 hours after the customer last wrote), like WATI." },
            { icon: TriangleAlert, label: "Missed", value: num(wst.data.period.missed), tone: "bad", foot: "expired, never answered", hint: "Expired in these dates, assigned to someone, and nobody ever replied. Counted on the day it expired, like WATI." },
            { icon: UserX, label: "Unassigned", value: num(wst.data.period.unassigned), tone: "warn", foot: "nobody is assigned", hint: "No agent or bot is assigned to the chat." },
            { icon: MessagesSquare, label: "Conversations", value: num(wst.data.period.total), foot: "customer wrote in these dates", hint: "Conversations where the customer wrote in the selected dates. Chats that only got a message from us are not included here: see Awaiting customer below." },
          ]} />
          <div className="grid gap-4 lg:grid-cols-5">
            <ChartCard className="lg:col-span-3" title="Team (from WATI)" description="Conversations assigned to each agent or bot, by their status in WATI. Open and Pending are right now. Expired and Missed are counted on the day the chat expired, like WATI. Assigned and Solved follow the day the customer last wrote.">
              {wop.error ? <ErrorNote message={wop.error} /> : !wop.data ? <ChartSkeleton h={200} /> : wop.data.rows.length === 0 ? <Empty>No assigned conversations in these dates.</Empty> : (
                <SortableTable rows={wop.data.rows} cols={[
                  { key: "operator", header: "Agent", value: (r: any) => r.operator, render: (r: any) => <span className="font-medium">{r.operator}{r.is_bot && <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">bot</span>}</span> },
                  { key: "assigned", header: "Assigned", align: "right", value: (r: any) => r.assigned, render: (r: any) => num(r.assigned) },
                  { key: "open", header: "Open", align: "right", value: (r: any) => r.open, render: (r: any) => num(r.open), hint: "Open right now, whatever dates are picked." },
                  { key: "pending", header: "Pending", align: "right", value: (r: any) => r.pending, render: (r: any) => num(r.pending), hint: "Pending right now, whatever dates are picked." },
                  { key: "solved", header: "Solved", align: "right", value: (r: any) => r.solved, render: (r: any) => num(r.solved) },
                  { key: "expired", header: "Expired", align: "right", value: (r: any) => r.expired, render: (r: any) => num(r.expired) },
                  { key: "missed", header: "Missed", align: "right", value: (r: any) => r.missed, render: (r: any) => <span className={r.missed > 0 ? "font-medium text-bad" : undefined}>{num(r.missed)}</span>, hint: "Expired and never answered." },
                ]} rowKey={(r: any) => r.operator} initialSort="assigned" maxHeight="20rem" exportName="wati-team" />
              )}
            </ChartCard>
            <ChartCard className="lg:col-span-2" title="Most used tags" description="The 20 tags on the most conversations in these dates.">
              {wtg.error ? <ErrorNote message={wtg.error} /> : !wtg.data ? <ChartSkeleton h={200} /> : wtg.data.rows.length === 0 ? <Empty>No tags on these conversations.</Empty> : (
                <BarList rows={wtg.data.rows.map((r: any) => ({ label: r.tag, value: r.chats, text: num(r.chats) }))} />
              )}
            </ChartCard>
          </div>
        </div>
      )}

      <ScoreGrid cols={4} title="Chat activity (our own count from the messages)" stats={[
        { icon: InboxIcon, label: "Total chats", loading: !c, value: num(c?.chats), delta: hasPrev ? { value: relDelta(c.chats, p.chats), goodWhen: "up", unit: "%" } : undefined, foot: c && `${num(c.customer_chats)} customers wrote in`, hint: "Every conversation with a customer, including chats where we sent a message and the customer has not replied yet." },
        { icon: Hourglass, label: STATUS.waiting.label, loading: !c, value: num(c?.waiting), tone: "warn", meter: c?.waiting_pct, foot: c && `${pct(c.waiting_pct)} of chats`, hint: STATUS.waiting.what },
        { icon: Reply, label: STATUS.replied.label, loading: !c, value: num(c?.replied), tone: "good", meter: c?.replied_pct, delta: hasPrev ? { value: ppDelta(c.replied_pct, p.replied_pct), goodWhen: "up" } : undefined, foot: c && `${pct(c.replied_pct)} of chats`, hint: STATUS.replied.what },
        { icon: TriangleAlert, label: STATUS.missed.label, loading: !c, value: num(c?.missed), tone: "bad", meter: c?.missed_pct, delta: hasPrev ? { value: ppDelta(c.missed_pct, p.missed_pct), goodWhen: "down" } : undefined, foot: c && `${pct(c.missed_pct)} of chats`, hint: STATUS.missed.what },
        { icon: Clock, label: "Older than 24 hours", loading: !c, value: num(c?.window_closed), tone: "warn", meter: c?.window_closed_pct, foot: c && `${pct(c.window_closed_pct)} of chats`, hint: "Chats where the customer's last message is more than 24 hours old. After 24 hours you can only send paid ready-made messages, not free replies." },
        { icon: UserX, label: "Owner unknown", loading: !c, value: num(c?.unassigned), tone: c && c.unassigned_pct > 50 ? "bad" : "warn", meter: c?.unassigned_pct, delta: hasPrev ? { value: ppDelta(c.unassigned_pct, p.unassigned_pct), goodWhen: "down" } : undefined, foot: c && `${pct(c.unassigned_pct)} of customer chats`, hint: "Customers who wrote to us where we do not know who owns the chat. WATI may still show an owner. We only find out when the automation saves it." },
        { icon: UserCheck, label: "Owner known", loading: !c, value: num(c?.assigned), tone: "good", meter: c?.assigned_pct, foot: c && `${pct(c.assigned_pct)} of customer chats`, hint: "Customers who wrote to us where we know who owns the chat." },
        { icon: Send, label: STATUS.outbound.label, loading: !c, value: num(c?.outbound), meter: c?.outbound_pct, foot: c && `${pct(c.outbound_pct)} of chats`, hint: STATUS.outbound.what },
      ]} />

      <ScoreGrid cols={4} title="Replies and cost" stats={[
        { icon: Coins, label: "Message cost", loading: !t, value: money(t?.spend, cur), foot: t && `${num(t.units)} messages charged`, hint: "What WhatsApp charges for the ready-made messages we sent. Replies our team types are free. It is an estimate from your price list, like the Costs page." },
        { icon: PiggyBank, label: "Cost per chat", loading: !t, value: money(t?.cost_per_chat, cur), foot: t && `over ${num(t.chats)} chats`, hint: "Message cost divided by the number of chats." },
        { icon: Send, label: "Cost with no reply", loading: !t, value: money(t?.no_reply_spend, cur), tone: "warn", meter: t?.no_reply_pct, foot: t && `${pct(t.no_reply_pct)} of the cost`, hint: "Money spent on messages to customers who never wrote back." },
        { icon: TriangleAlert, label: "Cost of missed chats", loading: !t, value: money(t?.missed_spend, cur), tone: "bad", meter: t?.missed_pct, foot: t && `${pct(t.missed_pct)} of the cost`, hint: "Money spent on chats where the customer wrote and nobody replied in time." },
        { icon: Timer, label: "Reply time", loading: !c, value: c?.fr_median == null ? "—" : duration(c.fr_median), delta: hasPrev && c.fr_median != null && p.fr_median != null ? { value: relDelta(c.fr_median, p.fr_median), goodWhen: "down", unit: "%" } : undefined, foot: c && (c.fr_avg == null ? "no replies yet" : `average ${duration(c.fr_avg)}`), hint: "How long a person in our team usually takes to reply to a customer's first message (chatbot replies are not counted). Shown as the typical (middle) time, so one very slow reply does not distort it." },
        { icon: Reply, label: "Replied within 1 hour", loading: !c, value: pct(c?.within_hour_pct), tone: "good", meter: c?.within_hour_pct, delta: hasPrev ? { value: ppDelta(c.within_hour_pct, p.within_hour_pct), goodWhen: "up" } : undefined, foot: c && `${num(c.within_hour)} of ${num(c.customer_chats)} customer chats`, hint: "Share of customers who got a first reply within an hour." },
        { icon: MessagesSquare, label: "Replies from our team", loading: !c, value: num(c?.team_msgs), foot: c && `${num(c.cust_msgs)} from customers${c.bot_msgs ? `, ${num(c.bot_msgs)} from the chatbot` : ""}`, hint: "Messages a person in our team typed to customers. Chatbot messages (Bot, KnowBot) are not counted here. These are free." },
        { icon: MessagesSquare, label: "Messages per chat", loading: !c, value: one(c?.msgs_per_chat), foot: c && `${num(c.messages)} messages in all`, hint: "Messages from customers, from our team and automatic ones, all together." },
      ]} />

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Chats over time" description="New chats per day, week or month. Tick the lines you want to see."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {trend.error ? <ErrorNote message={trend.error} /> : !trend.data ? <ChartSkeleton h={320} /> : (
            <div className="flex flex-col gap-3">
              <ChartContainer config={lineCfg} className="h-[260px] w-full">
                <ComposedChart data={trendRows} margin={{ left: 4, right: 12, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" {...axis} minTickGap={24} />
                  <YAxis {...axis} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(lineCfg)} />} />
                  {SERIES.filter((s) => shown[s.key]).map((s) => trendRows.length <= 3
                    ? <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                    : <Area key={s.key} dataKey={s.key} type="monotone" stroke={s.color} fill={s.color} fillOpacity={s.key === "chats" ? 0.12 : 0.04} strokeWidth={2} dot={{ r: 3, fill: s.color }} activeDot={{ r: 5 }} isAnimationActive={false} />)}
                </ComposedChart>
              </ChartContainer>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Lines to show">
                {SERIES.map((s) => <Pill key={s.key} on={shown[s.key]} color={s.color} onClick={() => setShown((v) => ({ ...v, [s.key]: !v[s.key] }))}>{s.label}</Pill>)}
              </div>
            </div>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="What happened to the chats" description="Share of all chats in the selected dates.">
          {!c ? <ChartSkeleton h={260} /> : c.chats === 0 ? <Empty>No chats in this date range.</Empty> : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative h-[200px] w-full">
                <ChartContainer config={statusCfg} className="h-full w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel formatter={rowFormatter(statusCfg)} />} />
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
                {ORDER.map((k) => (
                  <li key={k} className="flex items-center gap-2" title={STATUS[k].what}>
                    <span className="size-2.5 rounded-[2px]" style={{ background: STATUS[k].color }} />
                    <span>{STATUS[k].label}</span>
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
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Busiest times" description="When new chats start (India time). Switch between the hour of the day and the day of the week."
          actions={<Tabs value={slot} onValueChange={(v) => setSlot(v as "chats" | "unassigned")}><TabsList><TabsTrigger value="chats">All chats</TabsTrigger><TabsTrigger value="unassigned">Owner unknown</TabsTrigger></TabsList></Tabs>}>
          {heat.error ? <ErrorNote message={heat.error} /> : !heat.data ? <ChartSkeleton h={260} /> : (
            <div className="flex flex-col gap-3">
              <Tabs value={by} onValueChange={(v) => setBy(v as "hour" | "weekday")}><TabsList><TabsTrigger value="hour">By hour</TabsTrigger><TabsTrigger value="weekday">By weekday</TabsTrigger></TabsList></Tabs>
              <ChartContainer config={{ n: { label: "New chats", color: slot === "chats" ? "var(--c1)" : "var(--warn)" } }} className="h-[230px] w-full">
                <BarChart data={by === "hour"
                  ? Array.from({ length: 24 }, (_, h) => ({ label: hourLabel(h), n: (heat.data.cells as any[]).filter((c) => c.hour === h).reduce((a, c) => a + (c[slot] ?? 0), 0) }))
                  : [1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d], n: (heat.data.cells as any[]).filter((c) => c.dow === d).reduce((a, c) => a + (c[slot] ?? 0), 0) }))} margin={{ left: 4, right: 4, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" {...axis} interval={by === "hour" ? 2 : 0} />
                  <YAxis {...axis} width={36} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="n" fill="var(--color-n)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ChartContainer>
            </div>
          )}
        </ChartCard>
        <ChartCard title="How long chats last" description="Chats with more than one message: how many there were (bars) and how long they lasted on average, from first to last message (line).">
          {dur.error ? <ErrorNote message={dur.error} /> : !dur.data ? <ChartSkeleton h={260} /> : dur.data.rows.length === 0 ? <Empty>No chats with more than one message in this range.</Empty> : (
            <ChartContainer config={lenCfg} className="h-[260px] w-full">
              <ComposedChart data={dur.data.rows.map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis yAxisId="n" {...axis} width={36} allowDecimals={false} />
                <YAxis yAxisId="m" orientation="right" {...axis} width={48} tickFormatter={(v) => (v >= 1440 ? Math.round(v / 1440) + "d" : v >= 60 ? Math.round(v / 60) + "h" : v + "m")} />
                <ChartTooltip content={<ChartTooltipContent formatter={(v: any, name: any, item: any) => (
                  <div className="flex w-full items-center gap-2"><span className="size-2.5 rounded-[2px]" style={{ background: item?.color }} /><span className="text-muted-foreground">{(lenCfg as any)[name]?.label}</span><span className="ml-auto pl-3 font-mono font-medium tabular-nums text-foreground">{name === "avg_min" ? duration(v) : num(v)}</span></div>
                )} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar yAxisId="n" dataKey="chats" fill="var(--color-chats)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Line yAxisId="m" dataKey="avg_min" type="monotone" stroke="var(--color-avg_min)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Messages we sent and received" description="Messages we sent (ready-made messages and our team's replies) against messages customers sent us. This follows the dates and the Agent filter (only chats owned by the chosen agents).">
          {flow.error ? <ErrorNote message={flow.error} /> : !flow.data ? <ChartSkeleton h={260} /> : flow.data.rows.length === 0 ? <Empty>No messages in these dates.</Empty> : (
            <ChartContainer config={flowCfg} className="h-[260px] w-full">
              <ComposedChart data={flow.data.rows.map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} width={44} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent formatter={rowFormatter(flowCfg)} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="received" fill="var(--color-received)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="What happened to the messages we sent" description="Each ready-made message counted once, at the furthest step it reached.">
          {deliv.error ? <ErrorNote message={deliv.error} /> : !deliv.data ? <ChartSkeleton h={260} /> : deliv.data.needsViewUpdate ? <ViewUpdateNote /> : deliv.data.total === 0 ? <Empty>No ready-made messages in these dates.</Empty> : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative h-[200px] w-full">
                <ChartContainer config={deliveryCfg} className="h-full w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel formatter={rowFormatter(deliveryCfg)} />} />
                    <Pie data={DELIVERY.map((d) => ({ key: d.key, value: deliv.data.steps[d.key] })).filter((d) => d.value > 0)} dataKey="value" nameKey="key" innerRadius="62%" outerRadius="92%" strokeWidth={2} isAnimationActive={false}>
                      {DELIVERY.filter((d) => deliv.data.steps[d.key] > 0).map((d) => <Cell key={d.key} fill={`var(--color-${d.key})`} />)}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="tnum text-3xl font-semibold">{num(deliv.data.total)}</span>
                  <span className="text-xs text-muted-foreground">messages</span>
                </div>
              </div>
              <ul className="flex w-full flex-col gap-1.5 text-sm">
                {DELIVERY.map((d) => (
                  <li key={d.key} className="flex items-center gap-2">
                    <span className="size-2.5 rounded-[2px]" style={{ background: d.color }} />
                    <span>{d.label}</span>
                    <span className="tnum ml-auto font-medium">{num(deliv.data.steps[d.key])}</span>
                    <span className="tnum w-14 text-right text-muted-foreground">{pct(deliv.data.total ? (100 * deliv.data.steps[d.key]) / deliv.data.total : null)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Kinds of messages" description="Text, images and other kinds of messages: what we sent and what customers sent us. This follows the dates and the Agent filter (only chats owned by the chosen agents).">
        {mtypes.error ? <ErrorNote message={mtypes.error} /> : !mtypes.data ? <ChartSkeleton h={160} /> : mtypes.data.needsViewUpdate ? <ViewUpdateNote /> : mtypes.data.rows.length === 0 ? <Empty>No messages in these dates.</Empty> : (
          <SortableTable rows={mtypes.data.rows.map((r: any) => ({ ...r, label: typeLabel(r.type) }))} cols={[
            { key: "label", header: "Kind", value: (r: any) => r.label, render: (r: any) => <span className="font-medium">{r.label}</span> },
            { key: "sent", header: "Sent by us", align: "right", value: (r: any) => r.sent, render: (r: any) => num(r.sent) },
            { key: "received", header: "Received from customers", align: "right", value: (r: any) => r.received, render: (r: any) => num(r.received) },
          ]} rowKey={(r: any) => r.type} initialSort="sent" maxHeight="16rem" exportName="kinds-of-messages" />
        )}
      </ChartCard>

      <ChartCard title="Team performance" description="One row per agent who handles chats: how many, how fast they reply, and how many were missed.">
        {ops.error ? <ErrorNote message={ops.error} /> : !ops.data ? <ChartSkeleton h={200} /> : ops.data.rows.length === 0 ? <Empty>No chats with a known owner in these dates.</Empty> : (
          <SortableTable rows={ops.data.rows} cols={opCols} rowKey={(r) => r.operator} initialSort="chats" maxHeight="22rem" exportName="team-performance" />
        )}
      </ChartCard>

      {t && t.assumed_units > 0 && <p className="-mb-2 text-sm text-warn">{num(t.assumed_units)} messages use a price type we had to guess ({cost.data.assume.toLowerCase()}). Add them to config/template_categories.csv for exact costs.</p>}
      {cost.data?.placeholder && <p className="-mb-2 text-sm text-warn">The prices used here are still estimates, because the price list (config/rate_card.csv) has not been checked against your invoice. Treat every amount as approximate.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Message cost over time" description="What the ready-made messages cost (bars) and how many chats started (line). Replies from our team are free.">
          {cost.error ? <ErrorNote message={cost.error} /> : !cost.data ? <ChartSkeleton h={260} /> : cost.data.by_period.length === 0 ? <Empty>No chats in this date range.</Empty> : (
            <ChartContainer config={spendCfg} className="h-[260px] w-full">
              <ComposedChart data={cost.data.by_period.map((r: any) => ({ ...r, label: periodLabel(r.period, grain) }))} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis yAxisId="s" {...axis} width={48} tickFormatter={(v) => money(v, cur)} />
                <YAxis yAxisId="n" orientation="right" {...axis} width={40} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent formatter={(v: any, name: any, item: any) => (
                  <div className="flex w-full items-center gap-2"><span className="size-2.5 rounded-[2px]" style={{ background: item?.color }} /><span className="text-muted-foreground">{(spendCfg as any)[name]?.label}</span><span className="ml-auto pl-3 font-mono font-medium tabular-nums text-foreground">{name === "spend" ? money(v, cur) : num(v)}</span></div>
                )} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar yAxisId="s" dataKey="spend" fill="var(--color-spend)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Line yAxisId="n" dataKey="chats" type="monotone" stroke="var(--color-chats)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard title="Where the money goes" description="The cost split by what happened to the chat. “Awaiting customer” is money spent where the customer has not replied. “Missed” is money spent where nobody replied to the customer in time.">
          {cost.error ? <ErrorNote message={cost.error} /> : !cost.data ? <ChartSkeleton h={200} /> : cost.data.by_status.length === 0 ? <Empty>No chats in this date range.</Empty> : (
            <SortableTable rows={cost.data.by_status} cols={statusCols} rowKey={(r) => r.status} initialSort="spend" maxHeight="16rem" exportName="cost-by-outcome" />
          )}
        </ChartCard>
      </div>

      <ChartCard title="Cost by message" description="Which ready-made messages cost the most in these chats (top 30). Same prices as the Costs page.">
        {cost.error ? <ErrorNote message={cost.error} /> : !cost.data ? <ChartSkeleton h={200} /> : cost.data.by_template.length === 0 ? <Empty>No ready-made messages were sent in these chats.</Empty> : (
          <SortableTable rows={cost.data.by_template} cols={tplCols} rowKey={(r) => r.template} initialSort="s" maxHeight="20rem" exportName="cost-by-message" />
        )}
      </ChartCard>

      <ChartCard title="Every chat" description={`Most recent first (up to 200). ${reveal && list.data?.revealed ? "Full phone numbers are showing, so keep this screen private." : `Phone numbers show only the last 4 digits.${canReveal ? " Use the switch at the top of the page to see them." : ""}`} Cost is what the automatic messages in that chat cost.`}
        >
        {list.error ? <ErrorNote message={list.error} /> : !list.data ? <ChartSkeleton h={260} /> : (
          <SortableTable rows={list.data.rows} cols={listCols} rowKey={(r) => r.key} initialSort="last" maxHeight="30rem" exportName="chats"
            toolbar={<Tabs value={listStatus} onValueChange={(v) => setListStatus(v as "all" | "unassigned" | StatusKey)}><TabsList><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="unassigned" title="Customers who wrote to us where we do not know who owns the chat. WATI may still show an owner.">Owner unknown</TabsTrigger>{ORDER.map((k) => <TabsTrigger key={k} value={k}>{STATUS[k].short}</TabsTrigger>)}</TabsList></Tabs>}
            searchText={(r) => `${r.customer} ${r.phone} ${r.owner ?? ""}`} searchPlaceholder={reveal && list.data?.revealed ? "Search name, phone or owner" : "Search name, last 4 digits or owner"} />
        )}
      </ChartCard>

      </div>

      {!wst.data?.available && <ChartCard title="Not available yet" description="WATI's own inbox page shows these, but we do not receive them yet.">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {["Open", "Pending", "Solved", "Solved by bot", "Tags"].map((n) => <span key={n} className="rounded-full border border-dashed px-3 py-1 text-muted-foreground">{n}</span>)}
          </div>
          <p className="flex gap-2 text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" /><span>We receive every message, so who replied and how fast is real. We do not receive WATI's chat labels (Open, Pending, Solved) or tags. They arrive once the “WATI Status Sync” workflow is switched on.</span></p>
        </div>
      </ChartCard>}
    </div>
  )
}
