import { useEffect, useState, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { AlertTriangle, Check, Copy, Info, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ChartCard, Empty, ErrorNote, KpiCard, PageHeader, SortableTable, type Col } from "@/components/kit"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { dateTime, day, num, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

const outcome = (m: any) => (m.replied > 0 ? "Replied" : m.read > 0 ? "Read" : m.delivered > 0 ? "Delivered" : m.failed > 0 ? "Failed" : "No status yet")
const outcomeTone = (o: string) => (o === "Replied" || o === "Read" ? "text-good" : o === "Failed" ? "text-bad" : o === "Delivered" ? "text-foreground" : "text-muted-foreground")
const KIND_COLOR: Record<string, string> = { lead: "var(--c1)", opportunity: "var(--good)", message: "var(--c3)", chat: "var(--c2)" }

export default function Customers() {
  return <CustomerLookup title="Customer lookup" />
}

/** The customer lookup. Customer lookup v1 (/cust_v1) shows the same page inside the live reports group: it passes a title and a live badge. */
export function CustomerLookup({ title, badge }: { title: string; badge?: (updatedAt?: number) => ReactNode }) {
  const { meta } = useFilters()
  const [sp, setSp] = useSearchParams()
  const key = sp.get("key") || ""
  const [q, setQ] = useState(sp.get("q") || "")
  const [dq, setDq] = useState(q)
  const [reveal, setReveal] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { setSp((p) => { const n = new URLSearchParams(p); dq ? n.set("q", dq) : n.delete("q"); return n }, { replace: true }) }, [dq, setSp])
  useEffect(() => setReveal(false), [key])

  const search = useApi<any>(dq.length >= 2 ? "customers/search" : null, { q: dq })
  const detail = useApi<any>(key ? "customers/detail" : null, { key, reveal: reveal ? 1 : undefined })
  const d = detail.data && !detail.data.error && detail.data.key === key ? detail.data : undefined
  const choose = (k: string) => setSp((p) => { const n = new URLSearchParams(p); n.set("key", k); return n })
  const copy = async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard refused */ } }

  const msgCols: Col<any>[] = [
    { key: "template", header: "Template", value: (r) => r.template, className: "max-w-[12rem] truncate" },
    { key: "first_sent", header: "First sent", value: (r) => r.first_sent, render: (r) => dateTime(r.first_sent) },
    { key: "outcome", header: "Outcome", value: (r) => outcome(r), render: (r) => <span className={cn("font-medium", outcomeTone(outcome(r)))}>{outcome(r)}</span> },
    { key: "attempts", header: "Times sent", align: "right", value: (r) => r.attempts, render: (r) => (r.unmeasured ? <span>{num(r.attempts)} <span className="text-warn">({num(r.unmeasured)} not tracked)</span></span> : num(r.attempts)), hint: "How many times this template was sent to this number. Repeat sends are not tracked." },
    { key: "last_event", header: "Last update", value: (r) => r.last_event, render: (r) => dateTime(r.last_event) },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description="Find one customer by phone digits, name, lead id or opportunity id, and see everything known about them: their lead, opportunity, WhatsApp messages and a timeline." actions={badge?.(detail.updatedAt ?? search.updatedAt)} />
      <div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ---- search ---- */}
        <Card className="lg:sticky lg:top-16">
          <CardContent className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Last 4+ digits, name or id" className="pl-8 pr-8" aria-label="Search customers" />
              {q && <button type="button" onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search"><X className="size-3.5" /></button>}
            </div>
            {dq.length < 2 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">Type at least 2 characters. For a phone number, 4 or more digits find it, with or without the country code. Names match any part.</p>
            ) : search.error ? <ErrorNote message={search.error} /> : !search.data ? (
              <div className="flex flex-col gap-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
            ) : search.data.results.length === 0 ? <Empty>No customer matches “{dq}”.</Empty> : (
              <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto" aria-label="Search results">
                {search.data.results.map((r: any) => (
                  <li key={r.key}>
                    <button type="button" onClick={() => choose(r.key)} className={cn("flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted", r.key === key && "border-primary bg-muted")}>
                      <span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.name}</span><span className="shrink-0 text-xs text-muted-foreground">{day(r.last)}</span></span>
                      <span className="text-xs text-muted-foreground">{r.hasPhone ? r.phone : "No usable phone"}{r.owner ? ` · ${r.owner}` : ""}</span>
                      <span className="flex flex-wrap gap-1">
                        {r.leads > 0 && <Badge variant="secondary">{r.leads} lead{r.leads > 1 ? "s" : ""}</Badge>}
                        {r.opps > 0 && <Badge variant="secondary">{r.opps} opportunit{r.opps > 1 ? "ies" : "y"}</Badge>}
                        {r.templates > 0 && <Badge variant="secondary">{r.templates} template{r.templates > 1 ? "s" : ""}</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- detail ---- */}
        <div className="flex min-w-0 flex-col gap-4">
          {!key ? (
            <Card><CardContent className="flex flex-col gap-2 py-10 text-center text-sm text-muted-foreground">
              <p className="text-base font-medium text-foreground">Pick a customer to see their full picture</p>
              <p>Search on the left, or click any row in the Leads or Opportunities lists.</p>
              <p className="text-xs">Phone numbers are shown masked. Use the switch on a customer to reveal the full number.</p>
            </CardContent></Card>
          ) : detail.error && !d ? <ErrorNote message={detail.error} /> : detail.data?.error ? <Empty>{detail.data.error}</Empty> : !d ? (
            <div className="flex flex-col gap-4"><Skeleton className="h-28" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
          ) : (
            <>
              <Card><CardContent className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-semibold tracking-tight">{d.name}</h2>
                  <div className="tnum mt-1 text-sm text-muted-foreground">{d.hasPhone ? d.phone : "No usable phone number"}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{d.leads.length} lead{d.leads.length === 1 ? "" : "s"}</Badge>
                    <Badge variant="secondary">{d.opportunities.length} opportunit{d.opportunities.length === 1 ? "y" : "ies"}</Badge>
                    <Badge variant="secondary">{d.totals.templates} template{d.totals.templates === 1 ? "" : "s"} received</Badge>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {d.canReveal && d.hasPhone && (
                    <div className="flex items-center gap-2"><Label htmlFor="reveal" className="text-xs text-muted-foreground">Show full phone and message text</Label><Switch id="reveal" checked={reveal} onCheckedChange={setReveal} /></div>
                  )}
                  <Button variant="outline" size="sm" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? "Link copied" : "Copy link"}</Button>
                </div>
              </CardContent></Card>

              {d.notes.length > 0 && (
                <div className="flex flex-col gap-2" aria-label="Notes about this customer's data">
                  {d.notes.map((n: any, i: number) => (
                    <div key={i} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", n.tone === "warn" ? "border-warn/50 bg-warn/10" : "bg-muted/40")}>
                      {n.tone === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                      <span>{n.text}</span>
                    </div>
                  ))}
                </div>
              )}

              {d.messages.length > 0 && (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <KpiCard label="Messages followed" value={num(d.totals.measured)} sub={`${num(d.totals.attempts)} sent`} />
                  <KpiCard label="Delivered" value={pct(d.totals.measured ? (100 * d.totals.delivered) / d.totals.measured : null)} sub={`${num(d.totals.delivered)} messages`} />
                  <KpiCard label="Read" value={pct(d.totals.measured ? (100 * d.totals.read) / d.totals.measured : null)} sub={`${num(d.totals.read)} messages`} />
                  <KpiCard label="Replied" value={num(d.totals.replied)} tone={d.totals.replied > 0 ? "good" : undefined} sub="Customer replies" />
                  <KpiCard label="Failed" value={num(d.totals.failed)} tone={d.totals.failed > 0 ? "bad" : undefined} sub="Could not be delivered" />
                </div>
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                {d.leads.map((l: any) => (
                  <ChartCard key={l.lead_id} title="Lead" description={`Created ${dateTime(l.created)}`}>
                    <Facts rows={[["Source", l.sourceOverwritten ? <span className="text-warn">Unknown (overwritten by a status)</span> : l.source], ["Status now", l.status], ["Owner", l.owner], ["Phone on lead", l.phoneOverwritten ? <span className="text-warn">Replaced by text</span> : l.phone], ["Last updated", dateTime(l.updated)], ["Landing page", l.page || "—"]]} />
                    <Steps steps={l.steps} />
                    {l.moves.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Passed through: {l.moves.join(", ")}</p>}
                  </ChartCard>
                ))}
                {d.opportunities.map((o: any) => (
                  <ChartCard key={o.opportunity_id} title="Opportunity" description={`Created ${dateTime(o.created)}`}>
                    <Facts rows={[["Status", <Badge key="s" variant="outline" style={{ color: /won/i.test(o.status) ? "var(--good)" : /lost/i.test(o.status) ? "var(--bad)" : undefined }}>{o.status}</Badge>], ["Owner", o.owner], ["Last updated", dateTime(o.updated)]]} />
                    <Steps steps={o.steps} />
                  </ChartCard>
                ))}
                {!d.leads.length && !d.opportunities.length && <Empty>No lead or opportunity records for this number.</Empty>}
              </div>

              {d.messages.length > 0 && (
                <ChartCard title="WhatsApp templates sent to this customer" description="One row per template. Outcome is the furthest step reached.">
                  <SortableTable rows={d.messages} cols={msgCols} rowKey={(r) => r.template} initialSort="first_sent" maxHeight="22rem" />
                </ChartCard>
              )}

              {(d.sessions.length > 0 || d.chat.length > 0) && (
                <ChartCard title="Messages from the customer" description="Customer replies and chats recorded since the message log started. The agent side is not logged.">
                  {d.sessions.length > 0 && <p className="mb-3 text-sm text-muted-foreground">{d.sessions.length} conversation window{d.sessions.length > 1 ? "s" : ""}. Latest customer message: {dateTime(d.sessions[0].last_customer_message)}, window closes {dateTime(d.sessions[0].window_closes)}.</p>}
                  {d.chat.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {d.chat.slice(0, 12).map((c: any, i: number) => (
                        <li key={i} className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
                          <span className="tnum w-36 shrink-0 text-xs text-muted-foreground">{dateTime(c.at)}</span>
                          <Badge variant="secondary">{c.type}</Badge>
                          <span className="min-w-0 break-words">{c.text !== null ? (c.text || <span className="text-muted-foreground">(no text)</span>) : <span className="text-muted-foreground">Text hidden. Switch on “Show full phone and message text” above to read it.</span>}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-sm text-muted-foreground">No chat messages recorded.</p>}
                </ChartCard>
              )}

              {d.timeline.length > 0 && (
                <ChartCard title="Timeline" description="Dated events, newest first. The follow-up steps above have no timestamps in the database, so they are not placed here.">
                  <ol className="relative ml-2 flex flex-col gap-3 border-l pl-5">
                    {d.timeline.map((e: any, i: number) => (
                      <li key={i} className="relative text-sm">
                        <span className="absolute -left-[1.62rem] top-1.5 size-2.5 rounded-full ring-4 ring-card" style={{ background: KIND_COLOR[e.kind] ?? "var(--c6)" }} />
                        <div className="tnum text-xs text-muted-foreground">{dateTime(e.at)}</div>
                        <div>{e.text}</div>
                      </li>
                    ))}
                  </ol>
                </ChartCard>
              )}
            </>
          )}
        </div>
      </div>
      {meta?.mode === "csv" && <p className="text-xs text-muted-foreground">This is a snapshot, so it shows the customer as of {day(meta.asOf)}.</p>}
    </div>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>))}
    </dl>
  )
}

function Steps({ steps }: { steps: { label: string; done: boolean }[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Follow-up steps">
      {steps.map((s) => (
        <li key={s.label} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", s.done ? "border-good/40 bg-good/10 text-good" : "text-muted-foreground")}>
          {s.done ? <Check className="size-3" /> : <X className="size-3 opacity-60" />}{s.label}
        </li>
      ))}
    </ul>
  )
}
