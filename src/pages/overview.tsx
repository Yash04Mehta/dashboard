import { LazyMount } from "@/components/lazy"
import type { ReactNode } from "react"
import { CheckCheck, CircleCheck, CircleHelp, CircleX, Clock, Eye, Filter, FolderOpen, Hand, Hourglass, ListChecks, MessageCircle, Percent, Phone, PhoneOff, Repeat, Send, Tag, Target, Timer, Trophy, TriangleAlert, Users, ShieldCheck, Zap } from "lucide-react"
import { ResponseAndAging, SendTimeChart, TeamScorecard, TemplateTable } from "@/components/analysis"
import { FilterBar } from "@/components/filter-bar"
import { Funnel } from "@/components/funnel"
import { AttentionList, GlancePanel } from "@/components/glance"
import { ChartCard, ChartSkeleton, ErrorNote, PageHeader, ScoreGrid, useAutoGrain } from "@/components/kit"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { duration, num, pct, periodLabel, ppDelta } from "@/lib/format"

const one = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1))
const ic = "size-4"
const MIN_PREV = { messages: 100, leads: 30, closed: 30 }   // a previous period smaller than this is too thin to compare against

function FunnelCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Filter className="size-4" /></span>
          <div className="min-w-0"><CardTitle>{title}</CardTitle><CardDescription>{subtitle}</CardDescription></div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export default function Overview() {
  const { params, filters } = useFilters()
  const [grain] = useAutoGrain(filters.from, filters.to)
  const { templates: _t, ...noTemplate } = params       // leads and opportunities are not tied to a template
  const mk = useApi<any>("messages/kpis", params)
  const lk = useApi<any>("leads/kpis", noTemplate)
  const ok = useApi<any>("opps/kpis", noTemplate)
  const rt = useApi<any>("messages/reply-time", params)
  const mt = useApi<any>("messages/trend", { ...params, grain })
  const lt = useApi<any>("leads/trend", { ...noTemplate, grain })
  const ot = useApi<any>("opps/trend", { ...noTemplate, grain })

  const m = mk.data?.current, mp = mk.data?.previous?.measured >= MIN_PREV.messages ? mk.data.previous : undefined
  const l = lk.data?.current, lp = lk.data?.previous?.leads >= MIN_PREV.leads ? lk.data.previous : undefined
  const o = ok.data?.current, op = ok.data?.previous && ok.data.previous.won + ok.data.previous.lost >= MIN_PREV.closed ? ok.data.previous : undefined
  const closed = o ? o.won + o.lost : 0
  const reply = rt.data?.reply
  const unconfirmed = m ? Math.max(0, m.measured - m.delivered_adj - m.failed) : 0
  const up = (a?: number | null, b?: number | null) => (b === undefined ? undefined : { value: ppDelta(a, b), goodWhen: "up" as const })
  const down = (a?: number | null, b?: number | null) => (b === undefined ? undefined : { value: ppDelta(a, b), goodWhen: "down" as const })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="The key numbers at a glance. Pick a date range to see a different period; arrows compare with the period just before it." />
      <FilterBar kinds={["templates", "sources", "owners"]} />
      <p className="-mt-3 text-xs text-muted-foreground">A template changes the WhatsApp numbers only. Leads and opportunities are not tied to a template. Lead source and owner narrow everything they apply to.</p>
      <ErrorNote message={mk.error || lk.error || ok.error || rt.error} />

      <ScoreGrid title="Leads" cols={4} stats={[
        { icon: Users, label: "Leads", loading: !l, value: num(l?.leads), foot: l && `${num(l.people)} different phone numbers` },
        { icon: Phone, label: "Different people", loading: !l, value: num(l?.people), foot: "distinct phone numbers", hint: "Leads whose phone number was replaced by text cannot be counted here." },
        { icon: Hand, label: "Welcome message", loading: !l, value: one(l?.welcome_pct), unit: "%", meter: l?.welcome_pct, foot: l && `${num(l.welcome)} leads got one`, delta: up(l?.welcome_pct, lp?.welcome_pct) },
        { icon: Clock, label: "24-hour follow-up", loading: !l, value: one(l?.followup_24h_pct), unit: "%", meter: l?.followup_24h_pct, foot: l && `${num(l.followup_24h)} leads got one`, delta: up(l?.followup_24h_pct, lp?.followup_24h_pct) },
        { icon: ListChecks, label: "1st task follow-up", loading: !l, value: one(l?.task1_pct), unit: "%", meter: l?.task1_pct, foot: l && `${num(l.task1)} leads`, delta: up(l?.task1_pct, lp?.task1_pct) },
        { icon: ListChecks, label: "2nd task follow-up", loading: !l, value: one(l?.task2_pct), unit: "%", meter: l?.task2_pct, foot: l && `${num(l.task2)} leads`, delta: up(l?.task2_pct, lp?.task2_pct) },
        { icon: ListChecks, label: "3rd task follow-up", loading: !l, value: one(l?.task3_pct), unit: "%", meter: l?.task3_pct, foot: l && `${num(l.task3)} leads`, delta: up(l?.task3_pct, lp?.task3_pct) },
        { icon: Hourglass, label: "No welcome message", loading: !l, value: num(l && l.leads - l.welcome), tone: "bad", foot: l && `${pct(l.leads ? (100 * (l.leads - l.welcome)) / l.leads : null)} of leads` },
      ]} />

      <ScoreGrid title="WhatsApp messages" cols={3} stats={[
        { icon: Send, label: "Messages tracked", loading: !m, value: num(m?.measured), foot: m && `${num(m.attempts)} sent in total`,
          hint: "WhatsApp messages whose outcome we can follow. Repeat sends of the same template to the same person are left out." },
        { icon: Repeat, label: "Repeat sends left out", loading: !m, value: num(m?.unmeasured), foot: m && `${pct(m.unmeasured_pct)} of all sends`, hint: "Only the first send of a template to a person can be followed, so repeats are not counted in the rates." },
        { icon: CheckCheck, label: "Delivered", loading: !m, value: one(m?.delivered_pct), unit: "%", meter: m?.delivered_pct, foot: m && `at least ${num(m.delivered_adj)} messages`, delta: up(m?.delivered_pct, mp?.delivered_pct),
          hint: "A minimum: WhatsApp does not always report delivery, so the real figure is likely higher." },
        { icon: Eye, label: "Read", loading: !m, value: one(m?.read_pct), unit: "%", meter: m?.read_pct, foot: m && `at least ${num(m.read_adj)} messages`, delta: up(m?.read_pct, mp?.read_pct) },
        { icon: MessageCircle, label: "Replied", loading: !m, value: one(m?.replied_pct), unit: "%", meter: m?.replied_pct, tone: "good", foot: m && `${num(m.replied)} messages`, delta: up(m?.replied_pct, mp?.replied_pct) },
        { icon: TriangleAlert, label: "Failed to send", loading: !m, value: one(m?.failed_pct), unit: "%", meter: m?.failed_pct, tone: "bad", foot: m && `${num(m.failed)} messages`, delta: down(m?.failed_pct, mp?.failed_pct) },
        { icon: CircleHelp, label: "No delivery confirmation", loading: !m, value: one(m && m.measured ? (100 * unconfirmed) / m.measured : null), unit: "%", meter: m && m.measured ? (100 * unconfirmed) / m.measured : null, tone: "warn", foot: m && `${num(unconfirmed)} messages`,
          hint: "WhatsApp never told us what happened to these. Many were probably delivered, because the tracking misses events." },
        { icon: Zap, label: "Replies within a day", loading: !rt.data, value: one(reply?.within_day_pct), unit: "%", meter: reply?.within_day_pct, tone: "good", foot: reply && `of ${num(reply.total)} replies`, hint: "An estimate: time from our message to the last action the customer took on it." },
        { icon: Timer, label: "Typical time to reply", loading: !rt.data, value: duration(reply?.median_min), foot: "half reply faster than this", hint: "An estimate. WhatsApp does not give an exact reply time." },
      ]} />

      <ScoreGrid title="Opportunities" cols={4} stats={[
        { icon: Target, label: "Opportunities", loading: !o, value: num(o?.opportunities), foot: o && `${num(o.open)} still open` },
        { icon: FolderOpen, label: "Still open", loading: !o, value: num(o?.open), foot: o && `${pct(o.opportunities ? (100 * o.open) / o.opportunities : null)} of all` },
        { icon: CircleCheck, label: "Closed", loading: !o, value: num(closed), foot: o && `${pct(o.opportunities ? (100 * closed) / o.opportunities : null)} of all` },
        { icon: Trophy, label: "Deals won", loading: !o, value: num(o?.won), tone: "good", foot: o && `of ${num(closed)} closed deals` },
        { icon: CircleX, label: "Deals lost", loading: !o, value: num(o?.lost), tone: "bad", foot: o && `${pct(closed ? (100 * o.lost) / closed : null)} of closed deals` },
        { icon: Percent, label: "Win rate", loading: !o, value: one(o?.win_rate), unit: "%", meter: o?.win_rate, tone: "good", foot: "of closed deals", delta: up(o?.win_rate, op?.win_rate) },
        { icon: Tag, label: "Still at New", loading: !o, value: num(o?.new_total), foot: o && `${pct(o.opportunities ? (100 * o.new_total) / o.opportunities : null)} of all` },
        { icon: Hourglass, label: "Gone quiet", loading: !o, value: num(o?.stale_new), tone: "warn", foot: o && `New for over ${o.staleDays} days`, hint: "Opportunities still at status New after a long time. They are probably forgotten." },
      ]} />

      <ScoreGrid title="Data quality" cols={4} stats={[
        { icon: Tag, label: "Lead source known", loading: !l, value: one(l?.source_known_pct), unit: "%", meter: l?.source_known_pct, tone: l && l.source_known_pct < 60 ? "warn" : "good", foot: l && `${num(l.source_overwritten)} overwritten by a status` },
        { icon: Phone, label: "Phone number intact", loading: !l, value: one(l?.phone_intact_pct), unit: "%", meter: l?.phone_intact_pct, tone: l && l.phone_intact_pct < 80 ? "warn" : "good", foot: l && `${num(l.phone_overwritten)} replaced by text`, hint: "Leads whose phone number was replaced by text cannot be linked to their WhatsApp messages." },
        { icon: PhoneOff, label: "Phone number missing", loading: !l, value: num(l?.phone_empty), tone: "warn", foot: l && `${pct(l.leads ? (100 * l.phone_empty) / l.leads : null)} of leads` },
        { icon: CircleHelp, label: "Status flags disagree", loading: !o, value: num(o?.flag_mismatch), tone: "warn", foot: "opportunities", hint: "The won and lost flags disagree with the status on these. The dashboard uses the status." },
      ]} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <GlancePanel icon={Users} title="Leads" loading={!l} grainWord={grain} big={num(l?.leads)} caption={l && `new leads · ${num(l.people)} different phone numbers`}
          data={(lt.data?.rows ?? []).map((r: any) => ({ label: periodLabel(r.period, grain), leads: r.leads, welcome: r.welcome }))}
          series={[{ key: "leads", label: "New leads", color: "var(--c1)" }, { key: "welcome", label: "Got a welcome message", color: "var(--good)" }]}
          rows={[
            { label: "Got a welcome message", value: `${one(l?.welcome_pct)}%`, meter: l?.welcome_pct, delta: up(l?.welcome_pct, lp?.welcome_pct) },
            { label: "Followed up within 24 hours", value: `${one(l?.followup_24h_pct)}%`, meter: l?.followup_24h_pct, delta: up(l?.followup_24h_pct, lp?.followup_24h_pct) },
            { label: "Welcome messages sent", value: num(l?.welcome) },
            { label: "Phone number on file", value: `${one(l?.phone_intact_pct)}%`, meter: l?.phone_intact_pct, hint: "Leads whose phone number is a real number. The rest cannot be matched to WhatsApp messages." },
          ]} />
        <GlancePanel icon={MessageCircle} title="WhatsApp messages" loading={!m} grainWord={grain} big={num(m?.measured)} caption={m && `messages followed · ${num(m.attempts)} sent in total`}
          data={(mt.data?.rows ?? []).map((r: any) => ({ label: periodLabel(r.period, grain), measured: r.measured, read: r.read, replied: r.replied }))}
          series={[{ key: "measured", label: "Followed", color: "var(--c1)" }, { key: "read", label: "Read", color: "var(--c2)" }, { key: "replied", label: "Replied", color: "var(--good)" }]}
          rows={[
            { label: "Delivered", value: `${one(m?.delivered_pct)}%`, meter: m?.delivered_pct, delta: up(m?.delivered_pct, mp?.delivered_pct), hint: "A minimum: WhatsApp does not always report delivery, so the real figure is likely higher." },
            { label: "Read", value: `${one(m?.read_pct)}%`, meter: m?.read_pct, delta: up(m?.read_pct, mp?.read_pct) },
            { label: "Replied", value: `${one(m?.replied_pct)}%`, meter: m?.replied_pct, tone: "good", delta: up(m?.replied_pct, mp?.replied_pct) },
            { label: "Failed to send", value: `${one(m?.failed_pct)}%`, meter: m?.failed_pct, tone: "bad", delta: down(m?.failed_pct, mp?.failed_pct) },
          ]} />
        <GlancePanel icon={Target} title="Opportunities" loading={!o} grainWord={grain} big={num(o?.opportunities)} caption={o && `opened · ${num(o.open)} still open`}
          data={(ot.data?.rows ?? []).map((r: any) => ({ label: periodLabel(r.period, grain), opportunities: r.opportunities, won: r.won, lost: r.lost }))}
          series={[{ key: "opportunities", label: "Opened", color: "var(--c1)" }, { key: "won", label: "Won", color: "var(--good)" }, { key: "lost", label: "Lost", color: "var(--bad)" }]}
          rows={[
            { label: "Win rate", value: `${one(o?.win_rate)}%`, meter: o?.win_rate, tone: "good", delta: up(o?.win_rate, op?.win_rate), hint: "Won divided by won plus lost. Open opportunities are not counted." },
            { label: "Deals won", value: num(o?.won), tone: "good" },
            { label: "Deals lost", value: num(o?.lost), tone: "bad" },
            { label: `Gone quiet (New for over ${o?.staleDays ?? 30} days)`, value: num(o?.stale_new) },
          ]} />
      </div>

      <ChartCard title="Worth acting on" description="Things that probably need someone's attention. Each one opens the page with the details.">
        <AttentionList loading={!l || !m || !o} items={[
          { icon: Hand, count: l && l.leads - l.welcome, text: "leads never got a welcome message", to: "/leads", tone: "warn" },
          { icon: Clock, count: l && l.leads - l.followup_24h, text: "leads got no follow-up within 24 hours", to: "/leads", tone: "warn" },
          { icon: TriangleAlert, count: m?.failed, text: "WhatsApp messages failed to send", to: "/messages", tone: "bad" },
          { icon: Target, count: o?.stale_new, text: `opportunities stuck at New for over ${o?.staleDays ?? 30} days`, to: "/opportunities", tone: "bad" },
        ]} />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
      <FunnelCard title="Message funnel" subtitle={m && `${num(m.measured)} followed → ${num(m.replied)} replied · ${pct(m.measured ? (100 * m.replied) / m.measured : null)} end to end`}>
        {!m ? <ChartSkeleton h={260} /> : !m.measured ? <p className="py-10 text-center text-sm text-muted-foreground">No messages were tracked in this period.</p> : (
          <Funnel compact ariaLabel={`Of ${num(m.measured)} messages followed, ${num(m.delivered_adj)} were delivered, ${num(m.read_adj)} read and ${num(m.replied)} replied.`}
            stages={[
              { label: "Messages followed", value: m.measured, icon: <Send className={ic} />, drop: "failed or never confirmed" },
              { label: "Delivered", value: m.delivered_adj, icon: <CheckCheck className={ic} />, drop: "delivered, not read" },
              { label: "Read", value: m.read_adj, icon: <Eye className={ic} />, drop: "read, no reply" },
              { label: "Replied", value: m.replied, icon: <MessageCircle className={ic} /> },
            ]} />
        )}
      </FunnelCard>

      <FunnelCard title="Opportunity funnel" subtitle={o && `${num(o.opportunities)} opened → ${num(o.won)} won · ${pct(o.opportunities ? (100 * o.won) / o.opportunities : null)} end to end`}>
        {!o ? <ChartSkeleton h={260} /> : !o.opportunities ? <p className="py-10 text-center text-sm text-muted-foreground">No opportunities were opened in this period.</p> : (
          <Funnel compact highlightWorst={false} unit="opportunities" ariaLabel={`Of ${num(o.opportunities)} opportunities, ${num(closed)} have closed and ${num(o.won)} were won.`}
            stages={[
              { label: "Opportunities opened", value: o.opportunities, icon: <Target className={ic} />, drop: "still open" },
              { label: "Closed", value: closed, icon: <CircleCheck className={ic} />, drop: "lost" },
              { label: "Won", value: o.won, icon: <Trophy className={ic} /> },
            ]} />
        )}
      </FunnelCard>
      </div>

      {/* the template table compares templates with each other, so it ignores the template filter */}
      <LazyMount minHeight={400}>
        <div className="grid gap-4 lg:grid-cols-2">
          <TemplateTable params={noTemplate} />
          <ResponseAndAging params={params} oppParams={noTemplate} />
        </div>
      </LazyMount>
      <LazyMount minHeight={320}><SendTimeChart params={params} /></LazyMount>
      <LazyMount minHeight={320}><TeamScorecard params={noTemplate} /></LazyMount>
    </div>
  )
}
