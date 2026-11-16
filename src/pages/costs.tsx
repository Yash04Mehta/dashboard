import { useMemo, useState, type ReactNode } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Banknote, ChevronRight, CircleHelp, Coins, Eye, IndianRupee, MessageCircle, PiggyBank, Receipt, RotateCcw, Scale, Send, TrendingDown, TriangleAlert, type LucideIcon } from "lucide-react"
import { axis } from "@/components/charts"
import { FilterBar } from "@/components/filter-bar"
import { ChartCard, ChartSkeleton, Empty, ErrorNote, PageHeader, ScoreGrid, SortableTable, type Col } from "@/components/kit"
import { TemplateDetail } from "@/components/template-detail"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApi } from "@/lib/api"
import { CATS, COLOR, LABEL, priceTemplates } from "@/lib/costs"
import { useFilters } from "@/lib/filters"
import { money, moneyCompact, num, pct, periodLabel, price } from "@/lib/format"

const MIN_SENDS = 100   // a template needs this many billed messages before "no replies" is worth flagging

function Notice({ tone = "warn", children }: { tone?: "warn" | "bad"; children: ReactNode }) {
  return (
    <div role="note" className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${tone === "bad" ? "border-bad/40 bg-bad/10" : "border-warn/40 bg-warn/10"}`}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" style={{ color: tone === "bad" ? "var(--bad)" : "var(--warn)" }} />
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  )
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>

type Tip = { key: string; name: string; text: string; amount: string; tone: "good" | "bad" | "warn" }

/** One column of the "where to save or check" card: a few templates, each opening that template's detail. */
function TipColumn({ icon: Icon, title, hint, tips, onPick }: { icon: LucideIcon; title: string; hint: string; tips: Tip[]; onPick: (name: string) => void }) {
  if (!tips.length) return null
  return (
    <div className="flex min-w-0 flex-col bg-card">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-1 text-sm font-medium"><Icon className="size-4" style={{ color: `var(--${tips[0].tone})` }} />{title}</div>
      <p className="px-4 pb-2 text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-col divide-y border-t">
        {tips.map((t) => (
          <button key={t.key} type="button" onClick={() => onPick(t.name)} className="group flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none">
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium" title={t.name}>{t.name}</span><span className="block truncate text-xs text-muted-foreground">{t.text}</span></span>
            <span className="tnum shrink-0 text-sm font-semibold" style={{ color: `var(--${t.tone})` }}>{t.amount}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </div>
  )
}

export default function Costs() {
  const { params, filters, set } = useFilters()
  const [assume, setAssume] = useState("")                        // "" = whatever the template list says
  const [over, setOver] = useState<Record<string, string>>({})    // what-if prices per category, as typed
  const [free, setFree] = useState("")                            // what-if: share of utility messages that cost nothing
  const q = useApi<any>("costs/summary", { ...params, assume: assume || undefined })
  const names = filters.templates
  const msgQ = useApi<any>(names.length ? "costs/message" : null, { templates: names.join("|") })
  const d = q.data
  const cur: string = d?.currency ?? "INR"
  const touched = assume !== "" || free !== "" || Object.values(over).some((v) => v !== "")

  const m = useMemo(() => {
    if (!d) return null
    const { rateNow, rows, byM, byC, total, base } = priceTemplates(d, over, Math.min(100, Math.max(0, Number(free) || 0)) / 100)
    const sum = (k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0)
    const months = [...byM.keys()].sort().map((k) => ({ label: periodLabel(k + "-01", "month"), ...byM.get(k) }))
    const catRows = Object.keys(byC).map((c) => {
      const mine = rows.filter((r) => r.category === c)
      const units = mine.reduce((s, r) => s + r.units, 0), replied = mine.reduce((s, r) => s + r.replied, 0), measured = mine.reduce((s, r) => s + r.measured, 0)
      return { category: c, templates: mine.length, units, rate: rateNow[c], cost: byC[c], share: total ? (100 * byC[c]) / total : 0, replyRate: measured ? (100 * replied) / measured : null, perReply: replied ? byC[c] / replied : null }
    }).sort((a, b) => b.cost - a.cost)
    const noReply = rows.filter((r) => r.units > 0 && r.replied === 0)
    const top = (list: any[], key: (r: any) => number, n = 3) => [...list].sort((a, b) => key(b) - key(a)).slice(0, n)
    const tips = {
      save: top(rows.filter((r) => r.save > 0 && r.watiDiff == null), (r) => r.save).map((r): Tip => ({ key: "s" + r.template_name, name: r.template_name, text: "if billed as Utility, not Marketing", amount: money(r.save, d.currency), tone: "good" })),
      silent: top(noReply.filter((r) => r.units >= MIN_SENDS && r.cost > 0), (r) => r.cost).map((r): Tip => ({ key: "n" + r.template_name, name: r.template_name, text: `${num(r.units)} messages, no replies`, amount: money(r.cost, d.currency), tone: "bad" })),
      check: top(rows.filter((r) => r.watiDiff != null && Math.abs(r.watiDiff) >= 1), (r) => Math.abs(r.watiDiff)).map((r): Tip => ({ key: "c" + r.template_name, name: r.template_name, text: `priced as ${LABEL[r.category]}, WATI says ${LABEL[r.watiCategory]}`, amount: (r.watiDiff > 0 ? "−" : "+") + money(Math.abs(r.watiDiff), d.currency), tone: "warn" })),
    }
    return {
      total, base, rows, months, catRows, byC, rateNow, tips, units: d.totals.units, replied: sum("replied"), read: sum("read"),
      save: sum("save"), noReply, guessed: rows.filter((r) => r.assumed).reduce((s, r) => s + r.cost, 0), guessedN: rows.filter((r) => r.assumed).length,
    }
  }, [d, over, free])

  const cfg: ChartConfig = Object.fromEntries(CATS.map((c) => [c, { label: LABEL[c], color: COLOR[c] }]))
  const usedCats = CATS.filter((c) => m?.byC[c])
  const money0 = (v: number | null | undefined) => money(v, cur)
  const share = (v: number | undefined) => (m && m.total ? (100 * (v ?? 0)) / m.total : 0)
  const pick = (name: string) => set({ templates: [name] })

  const cols: Col<any>[] = [
    { key: "template_name", header: "Template", value: (r) => r.template_name, className: "max-w-[14rem] break-all whitespace-normal" },
    { key: "category", header: "Category", value: (r) => LABEL[r.category],
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="size-2 rounded-full" style={{ background: COLOR[r.category] }} />{LABEL[r.category]}
          {r.assumed && <span className="text-xs text-muted-foreground" title="Not on your template list or in WATI's export. The category is a guess.">(guess)</span>}
          {r.fromExport && <span className="text-xs text-muted-foreground" title="Not on your template list. The category comes from WATI's template export.">(WATI)</span>}
          {r.changed && <span className="text-xs text-muted-foreground" title="The category changed. Sends before the change are priced at the old category.">(changed)</span>}
        </span>
      ) },
    { key: "units", header: "Billed", align: "right", value: (r) => r.units, render: (r) => num(r.units), hint: "Messages sent and not failed. Repeat sends of a template to the same person are included, because each one is billed." },
    { key: "perMsg", header: "Per message", align: "right", value: (r) => r.perMsg, render: (r) => (r.perMsg == null ? "—" : price(r.perMsg, cur)) },
    { key: "cost", header: "Spend", align: "right", value: (r) => r.cost, render: (r) => <b>{money0(r.cost)}</b> },
    { key: "share", header: "Share", align: "right", value: (r) => r.share, render: (r) => pct(r.share) },
    { key: "replied", header: "Replies", align: "right", value: (r) => r.replied, render: (r) => num(r.replied) },
    { key: "perReply", header: "Per reply", align: "right", value: (r) => r.perReply, render: (r) => (r.perReply == null ? <span className="text-muted-foreground">no replies</span> : money0(r.perReply)), hint: "Spend on the template divided by the replies it got. The lower, the better value." },
    { key: "perRead", header: "Per read", align: "right", value: (r) => r.perRead, render: (r) => (r.perRead == null ? "—" : money0(r.perRead)) },
    { key: "save", header: "Could save", align: "right", value: (r) => r.save, cellClass: (r) => (r.save ? "font-medium text-good" : undefined),
      render: (r) => (r.save == null ? <span className="text-muted-foreground">—</span> : money0(r.save)), hint: "For Marketing templates: what would be saved if the same messages were billed at today's Utility price. Only possible if the template qualifies as Utility with WhatsApp." },
  ]

  const catCols: Col<any>[] = [
    { key: "category", header: "Category", value: (r) => LABEL[r.category], render: (r) => <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: COLOR[r.category] }} />{LABEL[r.category]}</span> },
    { key: "templates", header: "Templates", align: "right", value: (r) => r.templates, render: (r) => num(r.templates) },
    { key: "units", header: "Billed", align: "right", value: (r) => r.units, render: (r) => num(r.units) },
    { key: "rate", header: "Price now", align: "right", value: (r) => r.rate, render: (r) => price(r.rate, cur) },
    { key: "cost", header: "Spend", align: "right", value: (r) => r.cost, render: (r) => <b>{money0(r.cost)}</b> },
    { key: "share", header: "Share", align: "right", value: (r) => r.share, render: (r) => pct(r.share) },
    { key: "replyRate", header: "Reply rate", align: "right", value: (r) => r.replyRate, render: (r) => pct(r.replyRate) },
    { key: "perReply", header: "Per reply", align: "right", value: (r) => r.perReply, render: (r) => (r.perReply == null ? "—" : money0(r.perReply)) },
  ]

  const delta = m ? m.total - m.base : 0
  const reset = () => { setOver({}); setFree(""); setAssume("") }
  const noReplySpend = m?.noReply.reduce((s: number, r: any) => s + r.cost, 0)
  const hasTips = !!m && (m.tips.save.length > 0 || m.tips.silent.length > 0 || m.tips.check.length > 0)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Costs" description="What the WhatsApp templates cost us. Every message is priced by its template's category and the price in force on the day it was sent. Pick a template to see the message it sends." />
      <FilterBar kinds={["templates", "sources", "owners"]} />
      <ErrorNote message={q.error || msgQ.error} />

      {d && d.placeholder && <Notice>The prices are <b>starting values</b>, not yet checked against your WATI invoice, so treat the money figures as rough. Put the real prices in <Code>config/rate_card.csv</Code> (add a new row with a new date whenever a price changes), then reload this page.</Notice>}
      {d && m && m.guessedN > 0 && m.guessed > 0 && <Notice><b>{money0(m.guessed)}</b> of the spend ({pct(m.total ? (100 * m.guessed) / m.total : null, 0)}) is on {m.guessedN} template{m.guessedN > 1 ? "s" : ""} that are on no list and not in WATI's export, so their category is a guess ({LABEL[d.assume]}). Add them to <Code>config/template_categories.csv</Code>. They are marked "(guess)" in the table below.</Notice>}
      {d && d.unpriced.length > 0 && <Notice tone="bad">No price is set for {d.unpriced.map((c: string) => LABEL[c]).join(", ")}, so those messages are counted as free. Add a row to <Code>config/rate_card.csv</Code>.</Notice>}
      {d && d.problems.map((p: string) => <Notice key={p} tone="bad">{p}</Notice>)}
      {msgQ.data?.problems?.map((p: string) => <Notice key={p} tone="bad">{p}</Notice>)}

      {names.length > 0 && m && (
        <TemplateDetail names={names} rows={m.rows} messages={msgQ.data?.messages} loading={msgQ.loading} cur={cur} rateNow={m.rateNow} onClear={() => set({ templates: [] })} />
      )}

      {names.length !== 1 && (   /* one template: the panel above already shows these figures */
        <>
      <ScoreGrid title="Spend" cols={5} stats={[
        { icon: Banknote, label: "Estimated spend", loading: !m, value: money0(m?.total), foot: m && `${num(m.units)} messages billed`, hint: "Billed messages times the price in force on the day they were sent. An estimate: WhatsApp bills when a message is delivered, and some free utility messages sent inside a customer's 24-hour window are not excluded." },
        { icon: Send, label: "Billed messages", loading: !m, value: num(m?.units), foot: "sent and not failed" },
        { icon: Coins, label: "Average per message", loading: !m, value: m && m.units ? price(m.total / m.units, cur) : "—", foot: "across all categories" },
        { icon: MessageCircle, label: "Cost per reply", loading: !m, value: m && m.replied ? money0(m.total / m.replied) : "—", foot: m && `${num(m.replied)} replies`, hint: "All spend divided by all replies received. The best single figure for how much a conversation starter costs." },
        { icon: Eye, label: "Cost per read", loading: !m, value: m && m.read ? money0(m.total / m.read) : "—", foot: m && `at least ${num(m.read)} reads` },
      ]} />

      <ScoreGrid title="Where the money goes" cols={5} stats={[
        { icon: Receipt, label: "Marketing spend", loading: !m, value: money0(m?.byC.MARKETING ?? 0), tone: "warn", meter: share(m?.byC.MARKETING), foot: m && `${pct(share(m.byC.MARKETING))} of all spend` },
        { icon: Scale, label: "Utility spend", loading: !m, value: money0(m?.byC.UTILITY ?? 0), meter: share(m?.byC.UTILITY), foot: m && `${pct(share(m.byC.UTILITY))} of all spend` },
        { icon: PiggyBank, label: "Could save", loading: !m, value: money0(m?.save), tone: "good", foot: "if Marketing were billed as Utility", hint: "Only possible for templates that WhatsApp would accept as Utility. This is the upper limit, not a promise." },
        { icon: TrendingDown, label: "Spend with no replies", loading: !m, value: money0(noReplySpend), tone: "bad", meter: share(noReplySpend), foot: m && `${m.noReply.length} template${m.noReply.length === 1 ? "" : "s"} got no reply` },
        { icon: CircleHelp, label: "On guessed categories", loading: !m, value: money0(m?.guessed), tone: "warn", foot: m && `${m.guessedN} template${m.guessedN === 1 ? "" : "s"} on no list` },
      ]} />
        </>
      )}

      {!names.length && hasTips && m && (
        <ChartCard title="Where to save or check" description="The templates that matter most for the bill. Click one to see its message and costs.">
          <div className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3">
            <TipColumn icon={PiggyBank} title="Could cost less" hint="Marketing templates that might qualify as Utility." tips={m.tips.save} onPick={pick} />
            <TipColumn icon={TrendingDown} title="Paying for silence" hint={`Sent ${MIN_SENDS}+ times and never answered.`} tips={m.tips.silent} onPick={pick} />
            <TipColumn icon={TriangleAlert} title="Category to check" hint="WATI reports a different category than the one used for the price." tips={m.tips.check} onPick={pick} />
          </div>
        </ChartCard>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Spend by month" description="Estimated spend each month, split by category. Month is the day the message was first sent.">
          {q.error ? null : !m ? <ChartSkeleton h={300} /> : m.months.length === 0 ? <Empty>No messages in this selection.</Empty> : (
            <ChartContainer config={cfg} className="aspect-auto h-[300px] w-full">
              <BarChart data={m.months} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={16} tick={{ fontSize: 12 }} />
                <YAxis {...axis} width={56} tickFormatter={(v) => moneyCompact(v, cur)} />
                <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const tot = payload.reduce((s, p) => s + (Number(p.value) || 0), 0)
                  return (
                    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
                      <div className="mb-1 font-medium">{label} <span className="font-normal text-muted-foreground">· {money0(tot)}</span></div>
                      {[...payload].reverse().map((p) => <div key={String(p.dataKey)} className="flex items-center gap-2 py-0.5"><span className="size-2.5 rounded-[2px]" style={{ background: p.color }} /><span className="text-muted-foreground">{LABEL[String(p.dataKey)]}</span><span className="tnum ml-auto pl-4 font-medium">{money0(Number(p.value))}</span></div>)}
                    </div>
                  )
                }} />
                {usedCats.map((c, i) => <Bar key={c} dataKey={c} stackId="a" fill={COLOR[c]} radius={i === usedCats.length - 1 ? [3, 3, 0, 0] : 0} maxBarSize={40} isAnimationActive={false} />)}
              </BarChart>
            </ChartContainer>
          )}
        </ChartCard>

        <ChartCard title="By category" description="Where the money goes, and what each category gets back in replies.">
          {q.error ? null : !m ? <ChartSkeleton h={300} /> : m.catRows.length === 0 ? <Empty>No messages in this selection.</Empty> : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={m.catRows.map((r) => `${LABEL[r.category]} ${pct(r.share)}`).join(", ")}>
                  {m.catRows.map((r) => <div key={r.category} style={{ width: `${r.share}%`, background: COLOR[r.category] }} title={`${LABEL[r.category]}: ${money0(r.cost)}`} />)}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {m.catRows.map((r) => <span key={r.category} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: COLOR[r.category] }} />{LABEL[r.category]} {pct(r.share)}</span>)}
                </div>
              </div>
              <SortableTable rows={m.catRows} cols={catCols} rowKey={(r) => r.category} initialSort="cost" maxHeight="20rem" />
              <p className="text-xs text-muted-foreground">Price now is the latest price in the rate card, or the what-if price below if you typed one. Utility and Authentication cost a fraction of Marketing, which is why a template that WhatsApp re-labels as Marketing changes the bill.</p>
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Cost by template" description="What each template actually cost, and what it got back. Click a row to see the message it sends and filter the page to that template. Click a column title to sort.">
        {q.error ? null : !m ? <ChartSkeleton h={400} /> : m.rows.length === 0 ? <Empty>No messages in this selection.</Empty> : (
          <SortableTable rows={m.rows} cols={cols} rowKey={(r) => r.template_name} initialSort="cost" maxHeight="36rem" onRowClick={(r) => pick(r.template_name)} searchText={(r) => r.template_name} searchPlaceholder="Search templates" />
        )}
      </ChartCard>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ChartCard title="What if?" description="Try a different price or assumption. Nothing is saved; this only changes the numbers on this page."
          actions={touched ? <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="size-3.5" />Reset</Button> : undefined}>
          {!d ? <ChartSkeleton h={260} /> : (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {CATS.filter((c) => c !== "SERVICE").map((c) => {
                  const list = d.rates.filter((r: any) => r.category === c)
                  const now = [...list].reverse().find((r: any) => r.effective_from <= d.asOf) ?? list[0]
                  return (
                    <label key={c} className="flex flex-col gap-1 text-sm">
                      <span className="font-medium">{LABEL[c]} price per message</span>
                      <Input type="number" min={0} step="0.001" inputMode="decimal" value={over[c] ?? ""} placeholder={now ? String(now.price) : "no price"} onChange={(e) => setOver({ ...over, [c]: e.target.value })} />
                    </label>
                  )
                })}
              </div>
              <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
                <span className="font-medium">Utility messages that are free (%)</span>
                <Input type="number" min={0} max={100} step="1" inputMode="numeric" value={free} placeholder="0" onChange={(e) => setFree(e.target.value)} />
                <span className="text-xs text-muted-foreground">A Utility template sent while the customer's 24-hour window is open is free. Enter the share you think that is.</span>
              </label>
              <div className="flex flex-col gap-1 text-sm sm:max-w-xs">
                <span className="font-medium">Templates not on your list count as</span>
                <Select value={assume || (d.fallback as string)} onValueChange={(v) => v && setAssume(v === d.fallback ? "" : v)}
                  items={CATS.filter((c) => c !== "SERVICE").map((c) => ({ value: c, label: LABEL[c] + (c === d.fallback ? " (your setting)" : "") }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} align="start">
                    {CATS.filter((c) => c !== "SERVICE").map((c) => <SelectItem key={c} value={c}>{LABEL[c]}{c === d.fallback ? " (your setting)" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {m && touched && (
                <div className="rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
                  With these changes the spend would be <b>{money0(m.total)}</b>, which is <b style={{ color: delta <= 0 ? "var(--good)" : "var(--bad)" }}>{money0(Math.abs(delta))} {delta <= 0 ? "less" : "more"}</b> than with the rate card as it stands.
                </div>
              )}
            </div>
          )}
        </ChartCard>

        <ChartCard title="Prices and categories in use" description="Where the numbers come from. Prices keep changing, so each price has a date from which it applies.">
          {!d ? <ChartSkeleton h={260} /> : (
            <div className="flex flex-col gap-3">
              <SortableTable rows={d.rates.map((r: any, i: number) => ({ ...r, id: i }))} rowKey={(r) => String(r.id)} initialSort="effective_from" initialDir="desc" maxHeight="14rem" cols={([
                { key: "category", header: "Category", value: (r) => LABEL[r.category] },
                { key: "price", header: "Per message", align: "right", value: (r) => r.price, render: (r) => price(r.price, r.currency) },
                { key: "effective_from", header: "From", value: (r) => r.effective_from },
                { key: "source", header: "Source", value: (r) => r.source, render: (r) => (r.source.toLowerCase() === "placeholder" ? <span className="font-medium" style={{ color: "var(--warn)" }}>Placeholder</span> : r.source || "—") },
              ] as Col<any>[])} />
              <ul className="flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
                <li><b className="text-foreground">Prices:</b> <Code>{d.sources.rates}</Code>. Add a row whenever WATI or WhatsApp changes a price. Messages are priced by the day they were first sent.</li>
                <li><b className="text-foreground">Categories:</b> <Code>{d.sources.categories}</Code>, then WATI's template export for any template not listed. If a template's category changes in WATI, the monitor's table records the old one and the date, and earlier sends keep the old price.</li>
                <li><b className="text-foreground">Message text:</b> {d.sources.messages ? <Code>{d.sources.messages}</Code> : "no template export found"}. Save a fresh WATI template export as <Code>data_insight/wati_templates.json</Code> to update it.</li>
                <li><b className="text-foreground">Billed messages</b> are sent messages that did not fail. WhatsApp bills on delivery, and delivery is not always reported, so unconfirmed messages are counted as delivered.</li>
              </ul>
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  )
}
