import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { format, parseISO } from "date-fns"
import { Bot, CircleCheck, Sparkles, Users } from "lucide-react"
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
import { hourLabel, num, pct, periodLabel } from "@/lib/format"

/**
 * Chatbots: which chatbot customers meet, how many customers each one talks to, what they answered, and the past conversations behind the numbers.
 * Three words only: CUSTOMER (one person, counted once per chatbot per day), MESSAGE (one message a bot sent) and CHATBOT (which bot). See server/chatbots.mjs.
 */
export default function Chatbots() {
  return <LivePage><Page /></LivePage>
}

// one colour and one chart key per chatbot, the same everywhere on the page
const FLOWS: Record<string, { key: string; color: string; what: string }> = {
  "Delhi chatbot": { key: "delhi", color: "var(--c1)", what: "The question flow that starts after the Delhi opening message: kind of solution, products, timeline, then the customer's own question." },
  "Welcome bot": { key: "welcome", color: "var(--c2)", what: "The general welcome message a customer gets when they write to us first." },
  "KnowBot (AI assistant)": { key: "knowbot", color: "var(--c3)", what: "The AI assistant that answers product questions in WATI." },
  "Other bot messages": { key: "other", color: "var(--c4)", what: "A bot message whose wording we do not recognise yet, so it cannot be put under a chatbot." },
}
const flowKey = (f: string) => FLOWS[f]?.key ?? "other"
const TIER_COLOR: Record<string, string> = { Hot: "var(--good)", "Hot + Query": "var(--good)", Warm: "var(--warn)", Cold: "var(--c1)", Unqualified: "var(--bad)" }
// what the bot did, in plain words
const STEP: Record<string, string> = {
  "Asked: solution": "Asked the kind of solution", "Asked: products": "Asked which products", "Asked: timeline": "Asked the timeline", "Asked: their question": "Invited their question",
  "Question received": "Got their question", "Requirement noted": "Noted the requirement", "Closed: not interested": "Closed: not interested", Goodbye: "Said goodbye", Welcome: "Sent the welcome", "AI answer": "AI answered",
}

const when = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
const dash = (v?: string | null) => v || "—"
const one = (n: number, a: string, b: string) => `${num(n)} ${n === 1 ? a : b}`
const SetupNote = ({ what }: { what: string }) => (
  <div className="flex flex-col gap-2 text-sm"><p>{what} needs one setup step: run <code>server/sql/chatbots.sql</code> once in the database (as the admin). It adds read-only views with no message text.</p></div>
)

function Page() {
  const { params, filters, set } = useFilters()
  const { reveal } = useReveal()
  const [sp] = useSearchParams()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to)
  const [pick, setPick] = useState<string>("all")
  const [lowRef, low] = useSeen()   // the conversation list at the bottom is asked for only when you scroll near it

  // Every other page opens on yesterday, which would hide the past. This one opens on All time unless the address already says which dates.
  useEffect(() => { if (!sp.get("from") && !sp.get("to") && !sp.get("range")) set({ from: undefined, to: undefined }) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const ov = useApi<any>("chatbots/overview", { from: params.from, to: params.to, grain })
  const list = useApi<any>(low ? "chatbots/chats" : null, { from: params.from, to: params.to, flow: pick === "all" ? undefined : pick, reveal: reveal ? 1 : undefined, limit: 200 })
  const d = ov.data
  const w = d?.wati, dl = d?.delhi, tr = d?.triggers
  const allSetup = !!d && w?.setup && dl?.setup && tr?.setup

  const flows: any[] = w && !w.setup ? w.flows : []
  const flowRows = flows.map((f) => ({ ...f, per_day: f.days ? Math.round((10 * f.customers) / f.days) / 10 : null }))
  const flowOf = (name: string) => flows.find((f) => f.flow === name)
  const knowbot = flowOf("KnowBot (AI assistant)")

  // the per-day chart: one row per period, one column per chatbot
  const periods: string[] = w && !w.setup ? [...new Set<string>(w.trend.map((r: any) => r.period))].sort() : []
  const trendRows = periods.map((p) => {
    const row: any = { period: p, label: periodLabel(p, grain) }
    for (const r of w.trend) if (r.period === p) row[flowKey(r.flow)] = r.customers
    return row
  })
  const present = Object.entries(FLOWS).filter(([name]) => flows.some((f) => f.flow === name))
  const trendCfg: ChartConfig = Object.fromEntries(present.map(([name, f]) => [f.key, { label: name, color: f.color }]))
  const hourRows = w && !w.setup ? w.hours.map((r: any) => ({ ...r, label: hourLabel(r.hour) })) : []
  const hourCfg: ChartConfig = { customers: { label: "Customers", color: "var(--c1)" } }

  const flowCols: Col<any>[] = [
    { key: "flow", header: "Chatbot", value: (r) => r.flow, render: (r) => <span className="inline-flex items-center gap-2 font-medium" title={FLOWS[r.flow]?.what}><span className="size-2.5 rounded-full" style={{ background: FLOWS[r.flow]?.color }} />{r.flow}</span> },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers), hint: "Different people this chatbot sent at least one message to." },
    { key: "msgs", header: "Messages", align: "right", value: (r) => r.msgs, render: (r) => num(r.msgs), hint: "Every message this chatbot sent." },
    { key: "days", header: "Days used", align: "right", value: (r) => r.days, render: (r) => num(r.days), hint: "Days on which this chatbot sent something." },
    { key: "per_day", header: "Customers per day", align: "right", value: (r) => r.per_day, render: (r) => (r.per_day == null ? "—" : r.per_day.toFixed(1)), hint: "On the days it was used: customers divided by days used." },
    { key: "last", header: "Last used", value: (r) => r.last_at, render: (r) => <span className="whitespace-nowrap">{when(r.last_at)}</span> },
  ]
  const comboCols: Col<any>[] = [
    { key: "solution", header: "Kind of solution", value: (r) => r.solution ?? "", render: (r) => dash(r.solution) },
    { key: "products", header: "Products", value: (r) => r.products ?? "", render: (r) => dash(r.products), hint: "Only asked when the customer wants specific products." },
    { key: "timeline", header: "Timeline", value: (r) => r.timeline ?? "", render: (r) => dash(r.timeline) },
    { key: "tier", header: "Lead tier", value: (r) => r.tier ?? "", render: (r) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: TIER_COLOR[r.tier] ?? "var(--muted-foreground)" }} />{r.tier ?? "No tier yet"}</span> },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers) },
    { key: "share", header: "Of those who answered", align: "right", value: (r) => r.share, render: (r) => pct(r.share, 0) },
    { key: "q", header: "Also asked a question", align: "right", value: (r) => r.asked_question, render: (r) => num(r.asked_question) },
  ]
  const stepCols: Col<any>[] = [
    { key: "flow", header: "Chatbot", value: (r) => r.flow, render: (r) => <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: FLOWS[r.flow]?.color }} />{r.flow}</span> },
    { key: "step", header: "What the bot sent", value: (r) => r.step, render: (r) => STEP[r.step] ?? r.step },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers) },
    { key: "msgs", header: "Messages", align: "right", value: (r) => r.msgs, render: (r) => num(r.msgs) },
  ]
  const trigCols: Col<any>[] = [
    { key: "name", header: "Chatbot", value: (r) => r.name ?? r.chatbot_id, render: (r) => (r.name ? <span className="font-medium">{r.name}</span> : <span className="font-mono text-xs" title="WATI only sends the id. Add it to config/chatbots.csv to show a name.">{r.chatbot_id}</span>) },
    { key: "triggers", header: "Times started", align: "right", value: (r) => r.triggers, render: (r) => num(r.triggers), hint: "How many times a customer's reply or button press started this chatbot." },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers), hint: "Different customers per day, added up over the days." },
    { key: "first", header: "First seen", value: (r) => r.first_day, render: (r) => r.first_day ?? "—" },
    { key: "last", header: "Last seen", value: (r) => r.last_day, render: (r) => r.last_day ?? "—" },
  ]
  const pastCols: Col<any>[] = [
    { key: "when", header: "Last message", value: (r) => r.last_at, render: (r) => <span className="whitespace-nowrap">{when(r.last_at)}</span> },
    { key: "customer", header: "Customer", value: (r) => r.name ?? r.phone ?? "", render: (r) => <span className="whitespace-nowrap">{r.name ? <><span className="font-medium">{r.name}</span> <span className="text-muted-foreground">{r.phone}</span></> : r.phone ?? "Unknown"}</span> },
    { key: "flow", header: "Chatbot", value: (r) => r.flow, render: (r) => <span className="inline-flex items-center gap-2 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: FLOWS[r.flow]?.color }} />{r.flow}</span> },
    { key: "steps", header: "What the bot did", value: (r) => r.steps.length, render: (r) => <span className="block max-w-[16rem] whitespace-normal text-muted-foreground">{r.steps.map((s: string) => STEP[s] ?? s).join(" → ")}</span>, hint: "The steps the bot went through with this customer, in order." },
    { key: "msgs", header: "Messages", align: "right", value: (r) => r.msgs, render: (r) => num(r.msgs) },
    { key: "answers", header: "What they answered", value: (r) => r.solution ?? "", render: (r) => <span className="block max-w-[14rem] whitespace-normal">{r.delhi ? ([r.solution, r.products, r.timeline].filter(Boolean).join(" · ") || "—") + (r.asked_question ? " · asked a question" : "") : "—"}</span>, hint: "Delhi chatbot only: the latest answers recorded for this customer." },
    { key: "tier", header: "Lead tier", value: (r) => r.tier ?? "", render: (r) => (r.tier ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: TIER_COLOR[r.tier] ?? "var(--muted-foreground)" }} />{r.tier}</span> : "—") },
  ]

  if (allSetup) return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chatbots" description="Which chatbot customers meet, and what they answer." />
      <ChartCard title="One setup step is missing" description="The database is not ready for this page yet."><SetupNote what="This page" /></ChartCard>
    </div>
  )

  const dt = dl && !dl.setup ? dl.total : null
  const since = [w && !w.setup && w.data_from ? `bot messages since ${w.data_from}` : null, dl && !dl.setup && dl.data_from ? `Delhi chatbot log since ${dl.data_from}` : null].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chatbots" description="Which chatbot customers meet, how many customers each one talks to, and what they answer." actions={<LiveBadge updatedAt={ov.updatedAt} />} />
      <FilterBar kinds={[]} reveal />
      <ErrorNote message={ov.error} />

      <div className="grid gap-x-8 gap-y-2 rounded-lg border border-dashed p-3 text-sm sm:grid-cols-3">
        <p><b>Customer</b> <span className="text-muted-foreground">= one person. Counted once per chatbot per day.</span></p>
        <p><b>Message</b> <span className="text-muted-foreground">= one message a bot sent. One customer can get several.</span></p>
        <p><b>Chatbot</b> <span className="text-muted-foreground">= which bot it was: Delhi chatbot, Welcome bot or KnowBot.</span></p>
        {since && <p className="text-xs text-muted-foreground sm:col-span-3">Our history starts: {since}. Older chats are in WATI but were not saved here.</p>}
      </div>

      <ScoreGrid cols={4} title="In the dates picked above" stats={[
        { icon: Users, label: "Customers a bot talked to", loading: !d, value: w?.setup ? "—" : num(w?.total.customers), foot: w && !w.setup && one(w.total.msgs, "message", "messages") + " sent", hint: "Different people who got at least one message from any chatbot." },
        { icon: Bot, label: "Delhi: customers contacted", loading: !d, value: dt ? num(dt.customers) : "—", foot: dt && "people who got the Delhi opening message", hint: "Everyone in the Delhi chatbot's log. Each got the opening message, then the chatbot waits for an answer." },
        { icon: CircleCheck, label: "Delhi: customers answered", loading: !d, value: dt ? num(dt.answered) : "—", tone: "good", meter: dt?.answered_pct, foot: dt && `${pct(dt.answered_pct)} of the customers contacted`, hint: "Customers who answered at least one question (or said they are not interested)." },
        { icon: Sparkles, label: "KnowBot: customers", loading: !d, value: w?.setup ? "—" : num(knowbot?.customers ?? 0), foot: w && !w.setup && one(knowbot?.msgs ?? 0, "answer", "answers") + " sent", hint: FLOWS["KnowBot (AI assistant)"].what },
      ]} />

      <ChartCard title="Which chatbot is used most" description="Customers each chatbot talked to. Hover over a name to see what the chatbot is. A customer who met two chatbots is counted for both.">
        {!d ? <ChartSkeleton h={200} /> : w.setup ? <SetupNote what="This card" /> : flowRows.length === 0 ? <Empty>No bot messages in these dates.</Empty> : (
          <div className="flex flex-col gap-5">
            <BarList rows={flowRows.map((f) => ({ label: f.flow, value: f.customers, text: `${one(f.customers, "customer", "customers")} · ${one(f.msgs, "message", "messages")}` }))} colorFor={(r) => FLOWS[r.label]?.color ?? "var(--c1)"} />
            <SortableTable rows={flowRows} cols={flowCols} rowKey={(r: any) => r.flow} initialSort="customers" maxHeight="14rem" exportName="chatbots" />
          </div>
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Customers per chatbot over time" description="How many customers each chatbot talked to, per day, week or month."
          actions={<Tabs value={grain} onValueChange={(v) => setGrain(v as Grain)}><TabsList><TabsTrigger value="day">Day</TabsTrigger><TabsTrigger value="week">Week</TabsTrigger><TabsTrigger value="month">Month</TabsTrigger></TabsList></Tabs>}>
          {!d ? <ChartSkeleton h={260} /> : w.setup ? <SetupNote what="This card" /> : trendRows.length === 0 ? <Empty>No bot messages in these dates.</Empty> : (
            <ChartContainer config={trendCfg} className="h-[260px] w-full">
              <BarChart data={trendRows} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} width={36} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                {present.map(([name, f], i) => <Bar key={name} dataKey={f.key} stackId="a" fill={`var(--color-${f.key})`} isAnimationActive={false} radius={i === present.length - 1 ? [3, 3, 0, 0] : 0} />)}
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="What time of day" description="Customers a bot talked to, by the hour (India time).">
          {!d ? <ChartSkeleton h={260} /> : w.setup ? <SetupNote what="This card" /> : hourRows.every((r: any) => !r.customers) ? <Empty>No bot messages in these dates.</Empty> : (
            <ChartContainer config={hourCfg} className="h-[260px] w-full">
              <BarChart data={hourRows} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} interval={2} />
                <YAxis {...axis} width={36} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="customers" fill="var(--color-customers)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Delhi chatbot: how far customers get" description="Of the customers contacted. “No reply” means they never answered and the 24-hour check gave up on them.">
          {!d ? <ChartSkeleton h={220} /> : dl.setup ? <SetupNote what="This card" /> : !dt.customers ? <Empty>No Delhi chatbot customers in these dates.</Empty> : (
            <BarList max={dt.customers} rows={[
              { label: "Got the opening message", value: dt.opening_sent }, { label: "Answered a question", value: dt.answered }, { label: "Chose a kind of solution", value: dt.solution },
              { label: "Gave a timeline", value: dt.timeline }, { label: "Also asked their own question", value: dt.asked_question }, { label: "No reply", value: dt.no_reply },
            ].map((r) => ({ ...r, text: `${num(r.value)} · ${pct(dt.customers ? (100 * r.value) / dt.customers : null, 0)}` }))}
              colorFor={(r) => (r.label === "No reply" ? "var(--c1)" : r.label === "Also asked their own question" ? "var(--good)" : "var(--c2)")} />
          )}
        </ChartCard>
        <ChartCard title="Delhi chatbot: lead tier given" description="The tier the chatbot put each customer in, from their latest answers. Hot + Query means they also asked a question.">
          {!d ? <ChartSkeleton h={220} /> : dl.setup ? <SetupNote what="This card" /> : dl.tiers.length === 0 ? <Empty>No Delhi chatbot customers in these dates.</Empty> : (
            <BarList max={Math.max(1, ...dl.tiers.map((x: any) => x.n))} rows={dl.tiers.map((x: any) => ({ label: x.tier, value: x.n, text: `${num(x.n)} · ${pct(dt.customers ? (100 * x.n) / dt.customers : null, 0)}` }))} colorFor={(r) => TIER_COLOR[r.label] ?? "var(--muted-foreground)"} />
          )}
        </ChartCard>
      </div>

      <ChartCard title="Delhi chatbot: what customers answered" description="One answer per customer: their latest. Only customers who got far enough to be asked are counted.">
        {!d ? <ChartSkeleton h={200} /> : dl.setup ? <SetupNote what="This card" /> : (
          <div className="grid gap-6 md:grid-cols-3">
            {([["Kind of solution", dl.answers.solution], ["Products", dl.answers.products], ["Timeline", dl.answers.timeline]] as const).map(([title, rows]) => (
              <div key={title} className="flex flex-col gap-2.5">
                <h3 className="text-sm font-medium">{title}</h3>
                {rows.length === 0 ? <p className="text-sm text-muted-foreground">No answers yet.</p> : <BarList rows={rows.map((x: any) => ({ label: x.v, value: x.n, text: one(x.n, "customer", "customers") }))} />}
              </div>
            ))}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Delhi chatbot: answer combinations" description="Each row is one combination of answers (kind of solution, products, timeline), the lead tier it led to, and how many customers chose it. A row of dashes with Unqualified means the customer said they are not interested.">
        {!d ? <ChartSkeleton h={240} /> : dl.setup ? <SetupNote what="This card" /> : dl.combos.length === 0 ? <Empty>No customers answered in these dates.</Empty> : (
          <SortableTable rows={dl.combos} cols={comboCols} rowKey={(r: any) => [r.solution, r.products, r.timeline, r.tier].join("|")} initialSort="customers" maxHeight="26rem" exportName="chatbot-combinations" />
        )}
      </ChartCard>

      <div ref={lowRef}>
        <ChartCard title="Past conversations" description="One row per customer per chatbot, newest first (up to 200). Phone numbers and names stay hidden unless you switch them on at the top of the page. What customers typed is never shown."
          actions={<div className="flex flex-wrap gap-2" role="group" aria-label="Show conversations with">
            <Pill on={pick === "all"} onClick={() => setPick("all")}>All</Pill>
            {Object.entries(FLOWS).filter(([n]) => n !== "Other bot messages").map(([n, f]) => <Pill key={n} on={pick === n} color={f.color} title={f.what} onClick={() => setPick(n)}>{n}</Pill>)}
          </div>}>
          {list.error && !list.data ? <ErrorNote message={list.error} /> : !list.data ? <ChartSkeleton h={260} /> : list.data.setup ? <SetupNote what="This list" /> : list.data.rows.length === 0 ? <Empty>No conversations like that in these dates.</Empty> : (
            <div className="flex flex-col gap-2">
              <SortableTable rows={list.data.rows.map((r: any, i: number) => ({ ...r, id: i }))} cols={pastCols} rowKey={(r: any) => r.id} initialSort="when" maxHeight="30rem" exportName="chatbot-conversations" />
              {list.data.total > list.data.rows.length && <p className="text-xs text-muted-foreground">Showing the newest {num(list.data.rows.length)} of {num(list.data.total)}. Pick fewer dates to see the rest.</p>}
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="What each chatbot sent" description="Each step of each chatbot, recognised from the bot's own wording. Customers = different people who got that step.">
        {!d ? <ChartSkeleton h={200} /> : w.setup ? <SetupNote what="This card" /> : w.steps.length === 0 ? <Empty>No bot messages in these dates.</Empty> : (
          <SortableTable rows={w.steps} cols={stepCols} rowKey={(r: any) => r.flow + "|" + r.step} initialSort="customers" maxHeight="22rem" exportName="chatbot-steps" />
        )}
      </ChartCard>

      <ChartCard title="Chatbots WATI started" description={`WATI says which chatbot a customer's reply or button started, but only by an id. We save this since ${tr && !tr.setup && tr.since ? tr.since : "25 Nov 2026"}, so earlier days are empty. To show a name instead of the id, add a line “id,name” to config/chatbots.csv.`}>
        {!d ? <ChartSkeleton h={160} /> : tr.setup ? <SetupNote what="This card" /> : tr.rows.length === 0 ? <Empty>No chatbot was started in these dates (or they are before {tr.since ?? "25 Nov 2026"}).</Empty> : (
          <SortableTable rows={tr.rows} cols={trigCols} rowKey={(r: any) => r.chatbot_id} initialSort="triggers" maxHeight="16rem" exportName="chatbot-flows" />
        )}
      </ChartCard>
    </div>
  )
}
