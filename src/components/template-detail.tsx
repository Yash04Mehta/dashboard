import { useState, type ReactNode } from "react"
import { format, parseISO } from "date-fns"
import { Coins, Eye, MessageCircle, MessageSquareText, PiggyBank, Banknote, Percent, TriangleAlert, X } from "lucide-react"
import { ChartCard, ChartSkeleton, ScoreGrid, type Stat } from "@/components/kit"
import { MessagePreview, type TemplateMessage } from "@/components/message-preview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { COLOR, LABEL } from "@/lib/costs"
import { day, money, num, one, price } from "@/lib/format"
import { cn } from "@/lib/utils"

const Dot = ({ cat }: { cat: string }) => <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: COLOR[cat] }} />

/** Says where the message text comes from, so nobody mistakes an old export for what WATI sends today. */
function source(msg?: TemplateMessage): string {
  if (msg?.from === "wati") {
    let at = ""
    try { at = msg.syncedAt ? ` Last checked with WATI on ${format(parseISO(msg.syncedAt), "d MMM, h:mm a")}.` : "" } catch { /* unreadable date: leave it out */ }
    const edits = msg.version && msg.version > 1 ? ` Edited ${msg.version - 1} time${msg.version === 2 ? "" : "s"} in WATI since we started watching.` : ""
    return `What a customer receives when this template is sent. This is WATI's current text.${at}${edits}`
  }
  if (msg?.from === "file") return "What a customer receives when this template is sent. This comes from the exported template file, not live from WATI, so it may be out of date."
  return "What a customer receives when this template is sent."
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-2.5 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0">{children}</dd></div>
}

/** Everything about the template(s) picked in the filter: the message it sends, what it costs and how it is classified. */
export function TemplateDetail({ names, rows, messages, loading, cur, rateNow, onClear }: {
  names: string[]; rows: any[]; messages?: TemplateMessage[]; loading: boolean; cur: string; rateNow: Record<string, number>; onClear: () => void
}) {
  const [pick, setPick] = useState(names[0])
  const active = names.includes(pick) ? pick : names[0]
  const r = rows.find((x) => x.template_name === active)
  const msg = messages?.find((x) => x.template_name === active)
  const wati = r?.watiCategory ?? msg?.category
  const watiDiffers = !!(r && wati && wati !== r.category && !r.changed)
  const diff = watiDiffers ? r.cost - r.units * (rateNow[wati] ?? 0) : 0
  const m = (v: number | null | undefined) => money(v, cur)

  const stats: Stat[] = [
    { icon: Banknote, label: "Cost", loading: !r && loading, value: r ? m(r.cost) : "—", foot: r && `${num(r.units)} messages charged` },
    { icon: Percent, label: "Reply rate", loading: !r && loading, value: r?.measured ? one((100 * r.replied) / r.measured) : "—", unit: r?.measured ? "%" : undefined, meter: r?.measured ? (100 * r.replied) / r.measured : null, tone: "good", foot: r && `${num(r.replied)} replies` },
    { icon: Coins, label: "Per message", loading: !r && loading, value: r?.perMsg == null ? "—" : price(r.perMsg, cur), foot: "price when it was sent" },
    { icon: MessageCircle, label: "Cost per reply", loading: !r && loading, value: r?.perReply == null ? "—" : m(r.perReply), foot: r && !r.replied ? "no replies yet" : "spend divided by replies", hint: "Spend on this template divided by the replies it got. The lower, the better value." },
    { icon: Eye, label: "Cost per read", loading: !r && loading, value: r?.perRead == null ? "—" : m(r.perRead), foot: r && `at least ${num(r.read)} reads` },
    r?.save != null
      ? { icon: PiggyBank, label: "Could save", loading: false, value: m(r.save), tone: "good", foot: "if billed as Utility", hint: "What would be saved if the same messages were billed at today's Utility price. Only possible if WhatsApp would accept this template as Utility." }
      : { icon: TriangleAlert, label: "Failed to send", loading: !r && loading, value: r ? num(r.failed) : "—", tone: r && r.failed ? "bad" : "default", foot: r && `${num(r.units + r.failed)} attempts` },
  ]

  return (
    <section className="flex flex-col gap-4" aria-label="Selected template">
      {names.length > 1 && (names.length <= 5 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Selected templates">
          {names.map((n) => (
            <button key={n} type="button" aria-pressed={n === active} onClick={() => setPick(n)}
              className={cn("rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted", n === active ? "border-foreground/30 bg-muted font-medium text-foreground" : "text-muted-foreground")}>{n}</button>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing</span>
          <Select value={active} onValueChange={(v) => v && setPick(v)} items={names.map((n) => ({ value: n, label: n }))}>
            <SelectTrigger className="w-80 max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start" className="w-auto min-w-(--anchor-width) max-w-[90vw]">
              {names.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">{names.indexOf(active) + 1} of {names.length} selected templates</span>
        </div>
      ))}
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <ChartCard className="lg:col-span-2" title="The message" description={source(msg)}
          actions={msg && !msg.missing && msg.status ? <Badge variant="outline" className={msg.status === "APPROVED" ? "text-good" : "text-warn"}>{msg.status.charAt(0) + msg.status.slice(1).toLowerCase()} in WATI</Badge> : undefined}>
          {!msg && loading ? <ChartSkeleton h={300} /> : msg ? <MessagePreview msg={msg} /> : null}
        </ChartCard>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><MessageSquareText className="size-4" /></span>
              <div className="min-w-0">
                <div className="break-all font-heading text-base leading-snug font-medium">{active}</div>
                <div className="text-sm text-muted-foreground">{r ? <><Dot cat={r.category} />{LABEL[r.category]} · {num(r.units)} messages in this selection</> : "No messages were sent with this template in the selected period."}</div>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClear}><X className="size-3.5" />Show all templates</Button>
          </div>
          <ScoreGrid cols={3} stats={stats} />

          <ChartCard title="About this template" description="How it is charged and what WATI reports for it.">
            <dl className="divide-y">
              {r && (
                <Row label="Charged as">
                  <Dot cat={r.category} />{LABEL[r.category]}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {r.assumed ? "guessed: this template is not on your list" : r.fromExport ? "from WATI's template list" : r.changed ? "type changed; earlier sends keep the old one" : "from your list"}
                  </span>
                </Row>
              )}
              <Row label="WATI price type">{wati ? <><Dot cat={wati} />{LABEL[wati]}{msg?.status && msg.status !== "APPROVED" && <span className="ml-1.5 text-xs text-warn">{msg.status.toLowerCase()}</span>}</> : <span className="text-muted-foreground">not known</span>}</Row>
              {msg && !msg.missing && <Row label="Language">{msg.language || "—"}</Row>}
              {msg && !msg.missing && (
                <Row label="Added in WATI">
                  {msg.addedInWati ? <>{day(msg.addedInWati)}{msg.addedHow === "id" && <span className="ml-1.5 text-xs text-muted-foreground" title="WATI does not send a created date. Its template id is a database id that contains the time it was made, and that is what this is read from.">read from the template id</span>}</> : <span className="text-muted-foreground">not known<span className="ml-1.5 text-xs">WATI sends only the last-edited date</span></span>}
                </Row>
              )}
              {msg && !msg.missing && <Row label="Last edited in WATI">{day(msg.lastModified)}</Row>}
              {msg?.from === "wati" && msg.firstSeen && <Row label="First seen by us">{day(msg.firstSeen)}<span className="ml-1.5 text-xs text-muted-foreground">when the sync started watching it, not when it was made</span></Row>}
              {msg?.firstSent && <Row label="First used">{day(msg.firstSent)}<span className="ml-1.5 text-xs text-muted-foreground">first message in our data</span></Row>}
              {msg?.lastSent && <Row label="Last used">{day(msg.lastSent)}{msg.totalSent != null && <span className="ml-1.5 text-xs text-muted-foreground">{num(msg.totalSent)} sent in all</span>}</Row>}
              {msg?.from === "wati" && !!msg.versions && <Row label="Edits in WATI">{msg.versions <= 1 ? "none since we started watching" : `${msg.versions - 1} (this is version ${msg.version})`}</Row>}
              {msg?.from === "wati" && msg.watiId && <Row label="WATI template id"><span className="break-all font-mono text-xs">{msg.watiId}</span></Row>}
              {msg?.header?.file && <Row label="Attachment">{msg.header.file}</Row>}
              {!!msg?.buttons?.length && <Row label="Buttons">{msg.buttons.map((b) => b.text).join(" · ")}</Row>}
            </dl>
            {!!msg?.history && msg.history.length > 1 && (
              <div className="mt-3 flex flex-col gap-1.5 text-sm">
                <div className="font-medium">Edit history</div>
                {msg.history.map((h) => (
                  <details key={h.version} className="rounded-lg border px-3 py-2">
                    <summary className="cursor-pointer">Version {h.version}{h.current && <span className="ml-1.5 text-xs text-good">current</span>}<span className="ml-2 text-muted-foreground">{h.since ? day(h.since) : "—"} to {h.until ? day(h.until) : "now"}</span></summary>
                    <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{h.body || "(empty)"}</p>
                  </details>
                ))}
              </div>
            )}
            {watiDiffers && Math.abs(diff) >= 1 && (
              <div role="note" className="mt-3 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm leading-relaxed">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" style={{ color: "var(--warn)" }} />
                <div>WATI reports this as <b>{LABEL[wati]}</b>, but the cost here uses <b>{LABEL[r.category]}</b>. If WATI is right, these sends cost about <b>{m(Math.abs(diff))} {diff > 0 ? "less" : "more"}</b> than shown. Check which one your invoice uses.</div>
              </div>
            )}
          </ChartCard>
        </div>
      </div>
    </section>
  )
}
