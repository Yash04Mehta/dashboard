import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { format, parseISO } from "date-fns"
import { Bot, CircleCheck, Info, Sparkles, Users } from "lucide-react"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilterBar } from "@/components/filter-bar"
import { axis } from "@/components/charts"
import { BarList, ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, useAutoGrain, type Col, type Grain } from "@/components/kit"
import { LiveBadge, LivePage } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { hourLabel, num, pct, periodLabel } from "@/lib/format"

/**
 * Chatbots: which chatbot is used, how often per day, and what customers answered (see server/chatbots.mjs for where each number comes from).
 * Three sources, each shown on its own: what the WATI bots sent, the Delhi chatbot's own log of customers and answers, and WATI's "chatbot started" events.
 */
export default function Chatbots() {
  return <LivePage><Page /></LivePage>
}

// one colour and one chart key per chatbot ("flow"), the same everywhere on the page
const FLOWS: Record<string, { key: string; color: string; what: string }> = {
  "Delhi chatbot": { key: "delhi", color: "var(--c1)", what: "The question flow that starts after the Delhi opening message: kind of solution, products, timeline, then the customer's own question." },
  "Welcome bot": { key: "welcome", color: "var(--c2)", what: "The general welcome message a customer gets when they write to us first." },
  "KnowBot (AI assistant)": { key: "knowbot", color: "var(--c3)", what: "The AI assistant that answers product questions in WATI." },
  "Other bot messages": { key: "other", color: "var(--c4)", what: "A bot message whose wording is not one we recognise yet, so it cannot be put under a chatbot." },
}
const flowKey = (f: string) => FLOWS[f]?.key ?? "other"
const TIER_COLOR: Record<string, string> = { Hot: "var(--good)", "Hot + Query": "var(--good)", Warm: "var(--warn)", Cold: "var(--c1)", Unqualified: "var(--bad)" }

const when = (s?: string | null) => { try { return s ? format(parseISO(s), "d MMM, h:mm a") : "—" } catch { return s ?? "—" } }
const dash = (v?: string | null) => v || "—"
const SetupNote = ({ what }: { what: string }) => (
  <div className="flex flex-col gap-2 text-sm"><p>{what} needs one setup step: run <code>server/sql/chatbots.sql</code> once in the database (as the admin). It adds four read-only views with no phone numbers and no message text.</p></div>
)

function Page() {
  const { params, filters } = useFilters()
  const [grain, setGrain] = useAutoGrain(filters.from, filters.to)
  const ov = useApi<any>("chatbots/overview", { from: params.from, to: params.to, grain })
  const d = ov.data
  const w = d?.wati, dl = d?.delhi, tr = d?.triggers
  const allSetup = !!d && w?.setup && dl?.setup && tr?.setup

  const flows: any[] = w && !w.setup ? w.flows : []
  const sumChats = flows.reduce((a, f) => a + f.chats, 0)
  const flowRows = flows.map((f) => ({ ...f, share: sumChats ? Math.round((1000 * f.chats) / sumChats) / 10 : null, per_day: f.days ? Math.round((10 * f.chats) / f.days) / 10 : null }))
  const flowOf = (name: string) => flows.find((f) => f.flow === name)

  // the per-day chart: one row per period, one column per chatbot
  const periods: string[] = w && !w.setup ? [...new Set<string>(w.trend.map((r: any) => r.period))].sort() : []
  const trendRows = periods.map((p) => {
    const row: any = { period: p, label: periodLabel(p, grain) }
    for (const r of w.trend) if (r.period === p) row[flowKey(r.flow)] = r.chats
    return row
  })
  const present = Object.entries(FLOWS).filter(([name]) => flows.some((f) => f.flow === name))
  const trendCfg: ChartConfig = Object.fromEntries(present.map(([name, f]) => [f.key, { label: name, color: f.color }]))
  const hourRows = w && !w.setup ? w.hours.map((r: any) => ({ ...r, label: hourLabel(r.hour) })) : []
  const hourCfg: ChartConfig = { chats: { label: "Customers", color: "var(--c1)" } }

  const flowCols: Col<any>[] = [
    { key: "flow", header: "Chatbot", value: (r) => r.flow, render: (r) => <span className="inline-flex items-center gap-2 font-medium" title={FLOWS[r.flow]?.what}><span className="size-2.5 rounded-full" style={{ background: FLOWS[r.flow]?.color }} />{r.flow}</span> },
    { key: "chats", header: "Customers", align: "right", value: (r) => r.chats, render: (r) => num(r.chats), hint: "Different customers (chats) this chatbot sent at least one message to in these dates." },
    { key: "share", header: "Share", align: "right", value: (r) => r.share, render: (r) => pct(r.share, 0), hint: "This chatbot's share of all bot conversations. A customer who met two chatbots is counted for both, so the shares are of the total of the rows." },
    { key: "msgs", header: "Bot messages", align: "right", value: (r) => r.msgs, render: (r) => num(r.msgs) },
    { key: "days", header: "Days used", align: "right", value: (r) => r.days, render: (r) => num(r.days), hint: "Days in these dates on which this chatbot sent something." },
    { key: "per_day", header: "Customers per day used", align: "right", value: (r) => r.per_day, render: (r) => (r.per_day == null ? "—" : r.per_day.toFixed(1)) },
    { key: "last", header: "Last used", value: (r) => r.last_at, render: (r) => <span className="whitespace-nowrap">{when(r.last_at)}</span> },
  ]
  const comboCols: Col<any>[] = [
    { key: "solution", header: "Kind of solution", value: (r) => r.solution ?? "", render: (r) => dash(r.solution) },
    { key: "products", header: "Products", value: (r) => r.products ?? "", render: (r) => dash(r.products), hint: "Only asked when the customer wants specific products." },
    { key: "timeline", header: "Timeline", value: (r) => r.timeline ?? "", render: (r) => dash(r.timeline) },
    { key: "tier", header: "Lead tier it led to", value: (r) => r.tier ?? "", render: (r) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: TIER_COLOR[r.tier] ?? "var(--muted-foreground)" }} />{r.tier ?? "No tier yet"}</span> },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers) },
    { key: "share", header: "Share of those who answered", align: "right", value: (r) => r.share, render: (r) => pct(r.share, 0) },
    { key: "q", header: "Asked their own question", align: "right", value: (r) => r.asked_question, render: (r) => num(r.asked_question) },
  ]
  const stepCols: Col<any>[] = [
    { key: "flow", header: "Chatbot", value: (r) => r.flow, render: (r) => <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: FLOWS[r.flow]?.color }} />{r.flow}</span> },
    { key: "step", header: "What the bot sent", value: (r) => r.step, render: (r) => r.step },
    { key: "chats", header: "Customers", align: "right", value: (r) => r.chats, render: (r) => num(r.chats) },
    { key: "msgs", header: "Messages", align: "right", value: (r) => r.msgs, render: (r) => num(r.msgs) },
  ]
  const trigCols: Col<any>[] = [
    { key: "name", header: "Chatbot", value: (r) => r.name ?? r.chatbot_id, render: (r) => (r.name ? <span className="font-medium">{r.name}</span> : <span className="font-mono text-xs" title="WATI only sends the id. Add it to config/chatbots.csv to show a name.">{r.chatbot_id}</span>) },
    { key: "triggers", header: "Times started", align: "right", value: (r) => r.triggers, render: (r) => num(r.triggers), hint: "How many times a customer's reply or button press started this chatbot." },
    { key: "customers", header: "Customers", align: "right", value: (r) => r.customers, render: (r) => num(r.customers), hint: "Different customers per day, added up over the days." },
    { key: "first", header: "First seen", value: (r) => r.first_day, render: (r) => r.first_day ?? "—" },
    { key: "last", header: "Last seen", value: (r) => r.last_day, render: (r) => r.last_day ?? "—" },
  ]

  if (allSetup) return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chatbots" description="Which chatbot is used, how often, and what customers answered." />
      <ChartCard title="One setup step is missing" description="The database is not ready for this page yet."><SetupNote what="This page" /></ChartCard>
    </div>
  )

  const dt = dl && !dl.setup ? dl.total : null
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Chatbots" description="Which chatbot is used, how many customers it talks to each day, and what customers answer." actions={<LiveBadge updatedAt={ov.updatedAt} />} />
      <FilterBar kinds={[]} />
      <ErrorNote message={ov.error} />

      <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <details className="min-w-0 text-muted-foreground">
          <summary className="cursor-pointer select-none text-foreground">Where do these numbers come from?</summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            <p><b className="text-foreground">What the WATI bots sent.</b> Every message a bot sent in WATI (the operator called “Bot” or “KnowBot”). We tell the chatbots apart by what the message says, so a new bot message shows as “Other” until it is added. {w && !w.setup && w.data_from ? `Saved since ${w.data_from}.` : ""}</p>
            <p><b className="text-foreground">The Delhi chatbot's own log.</b> One row per step a customer took, kept by the n8n workflow. A customer is dated by the day they first appear in it. The answers are the latest ones recorded for that customer. {dl && !dl.setup && dl.data_from ? `Saved since ${dl.data_from}.` : ""}</p>
            <p><b className="text-foreground">Chatbots WATI started.</b> WATI's own “chatbot started” event. It only names a chatbot by an id, and we only save it since {tr && !tr.setup && tr.since ? tr.since : "25 Nov 2026"}.</p>
            <p>A customer is counted once per chatbot per day. “Bot messages” counts every message. Nothing here shows phone numbers or what customers typed.</p>
          </div>
        </details>
      </div>

      <ScoreGrid cols={4} title="Chatbots in these dates" stats={[
        { icon: Users, label: "Customers a bot talked with", loading: !d, value: w?.setup ? "—" : num(w?.total.chats), foot: w && !w.setup && `${num(w.total.msgs)} bot ${w.total.msgs === 1 ? "message" : "messages"} · ${num(w.total.days)} ${w.total.days === 1 ? "day" : "days"}`, hint: "Different customers (chats) that got at least one message from any WATI bot." },
        { icon: Bot, label: "Delhi chatbot customers", loading: !d, value: dt ? num(dt.customers) : "—", foot: dt && `${num(dt.opening_sent)} got the opening message`, hint: "Customers who appear in the Delhi chatbot's log, dated by the day they first appear." },
        { icon: CircleCheck, label: "Answered the Delhi chatbot", loading: !d, value: dt ? num(dt.answered) : "—", tone: "good", meter: dt?.answered_pct, foot: dt && `${pct(dt.answered_pct)} of its customers`, hint: "Customers who answered at least one of the chatbot's questions (or said they are not interested)." },
        { icon: Sparkles, label: "KnowBot (AI assistant)", loading: !d, value: w?.setup ? "—" : num(flowOf("KnowBot (AI assistant)")?.chats ?? 0), foot: w && !w.setup && `${num(flowOf("KnowBot (AI assistant)")?.msgs ?? 0)} ${(flowOf("KnowBot (AI assistant)")?.msgs ?? 0) === 1 ? "answer" : "answers"} sent`, hint: FLOWS["KnowBot (AI assistant)"].what },
      ]} />

      <ChartCard title="Which chatbot is used most" description="Customers each chatbot talked to in these dates. Hover over a name for what the chatbot is.">
        {!d ? <ChartSkeleton h={200} /> : w.setup ? <SetupNote what="This card" /> : flowRows.length === 0 ? <Empty>No bot messages in these dates.</Empty> : (
          <div className="flex flex-col gap-5">
            <BarList rows={flowRows.map((f) => ({ label: f.flow, value: f.chats, text: `${num(f.chats)} customers · ${pct(f.share, 0)}` }))} colorFor={(r) => FLOWS[r.label]?.color ?? "var(--c1)"} />
            <SortableTable rows={flowRows} cols={flowCols} rowKey={(r: any) => r.flow} initialSort="chats" maxHeight="14rem" exportName="chatbots" />
          </div>
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Customers per chatbot over time" description="Different customers each chatbot talked to, per day, week or month."
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
        <ChartCard className="lg:col-span-2" title="When customers meet a bot" description="Customers a bot talked to, by the hour of the day (India time).">
          {!d ? <ChartSkeleton h={260} /> : w.setup ? <SetupNote what="This card" /> : hourRows.every((r: any) => !r.chats) ? <Empty>No bot messages in these dates.</Empty> : (
            <ChartContainer config={hourCfg} className="h-[260px] w-full">
              <BarChart data={hourRows} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} interval={2} />
                <YAxis {...axis} width={36} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="chats" fill="var(--color-chats)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="How far customers get in the Delhi chatbot" description="Of the customers who appear in the Delhi chatbot's log. “Never answered” are the ones the 24-hour cold check gave up on.">
          {!d ? <ChartSkeleton h={220} /> : dl.setup ? <SetupNote what="This card" /> : !dt.customers ? <Empty>No Delhi chatbot customers in these dates.</Empty> : (
            <BarList max={dt.customers} rows={[
              { label: "Got the opening message", value: dt.opening_sent }, { label: "Answered a question", value: dt.answered }, { label: "Chose a kind of solution", value: dt.solution },
              { label: "Gave a timeline", value: dt.timeline }, { label: "Asked their own question", value: dt.asked_question }, { label: "Never answered", value: dt.no_reply },
            ].map((r) => ({ ...r, text: `${num(r.value)} · ${pct(dt.customers ? (100 * r.value) / dt.customers : null, 0)}` }))}
              colorFor={(r) => (r.label === "Never answered" ? "var(--c1)" : r.label === "Asked their own question" ? "var(--good)" : "var(--c2)")} />
          )}
        </ChartCard>
        <ChartCard title="Lead tier the Delhi chatbot gave" description="The tier the chatbot put each customer in, from their latest answers. Hot + Query means they also asked a question.">
          {!d ? <ChartSkeleton h={220} /> : dl.setup ? <SetupNote what="This card" /> : dl.tiers.length === 0 ? <Empty>No Delhi chatbot customers in these dates.</Empty> : (
            <BarList max={Math.max(1, ...dl.tiers.map((x: any) => x.n))} rows={dl.tiers.map((x: any) => ({ label: x.tier, value: x.n, text: `${num(x.n)} · ${pct(dt.customers ? (100 * x.n) / dt.customers : null, 0)}` }))} colorFor={(r) => TIER_COLOR[r.label] ?? "var(--muted-foreground)"} />
          )}
        </ChartCard>
      </div>

      <ChartCard title="What customers answered" description="One answer per customer: their latest. Only customers who got far enough to be asked are counted.">
        {!d ? <ChartSkeleton h={200} /> : dl.setup ? <SetupNote what="This card" /> : (
          <div className="grid gap-6 md:grid-cols-3">
            {([["Kind of solution", dl.answers.solution], ["Products", dl.answers.products], ["Timeline", dl.answers.timeline]] as const).map(([title, rows]) => (
              <div key={title} className="flex flex-col gap-2.5">
                <h3 className="text-sm font-medium">{title}</h3>
                {rows.length === 0 ? <p className="text-sm text-muted-foreground">No answers yet.</p> : <BarList rows={rows.map((x: any) => ({ label: x.v, value: x.n, text: num(x.n) }))} />}
              </div>
            ))}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Answer combinations" description="Each row is one combination of answers (kind of solution, products, timeline) and the lead tier it led to, with how many customers chose it. Only customers who answered are counted.">
        {!d ? <ChartSkeleton h={240} /> : dl.setup ? <SetupNote what="This card" /> : dl.combos.length === 0 ? <Empty>No customers answered in these dates.</Empty> : (
          <SortableTable rows={dl.combos} cols={comboCols} rowKey={(r: any) => [r.solution, r.products, r.timeline, r.tier].join("|")} initialSort="customers" maxHeight="26rem" exportName="chatbot-combinations" />
        )}
      </ChartCard>

      <ChartCard title="What each bot sent" description="The step of each chatbot, recognised from the bot's own wording. Customers = different customers who got that step.">
        {!d ? <ChartSkeleton h={200} /> : w.setup ? <SetupNote what="This card" /> : w.steps.length === 0 ? <Empty>No bot messages in these dates.</Empty> : (
          <SortableTable rows={w.steps} cols={stepCols} rowKey={(r: any) => r.flow + "|" + r.step} initialSort="chats" maxHeight="22rem" exportName="chatbot-steps" />
        )}
      </ChartCard>

      <ChartCard title="Chatbot flows WATI started" description={`WATI says which chatbot a customer's reply or button started, but only by an id. We save this since ${tr && !tr.setup && tr.since ? tr.since : "25 Nov 2026"}, so earlier days are empty. To show a name instead of the id, add a line “id,name” to config/chatbots.csv.`}>
        {!d ? <ChartSkeleton h={160} /> : tr.setup ? <SetupNote what="This card" /> : tr.rows.length === 0 ? <Empty>No chatbot was started in these dates (or they are before {tr.since ?? "25 Nov 2026"}).</Empty> : (
          <SortableTable rows={tr.rows} cols={trigCols} rowKey={(r: any) => r.chatbot_id} initialSort="triggers" maxHeight="16rem" exportName="chatbot-flows" />
        )}
      </ChartCard>
    </div>
  )
}
