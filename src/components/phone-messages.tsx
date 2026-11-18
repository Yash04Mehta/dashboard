// The Messages page as a phone screen: one thing at a time behind four tabs, instead of one very long page.
// Summary = the headline numbers, Trends = how they move, Failures = why messages failed, Messages = the list. Every tab reuses the same cards and
// endpoints as the desktop page, so the figures are identical. Only the active tab is on screen, so only its data is fetched.
import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, ErrorNote } from "@/components/kit"
import { FailureReasonsCard, LiveBadge, MessageLogCard, SelectedTemplateCard, TrendCard } from "@/components/v1"
import { useApi, type Params } from "@/lib/api"
import { num, one } from "@/lib/format"
import { cn } from "@/lib/utils"

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "trends", label: "Trends" },
  { id: "failures", label: "Failures" },
  { id: "messages", label: "Messages" },
] as const
type TabId = (typeof TABS)[number]["id"]

// the same colours as the message funnel (WhatsApp's own order), so a colour means the same thing everywhere
const DELIVERED = "#2e9d6b", READ = "#3b82d6", REPLIED = "#0f766e", FAILED = "#e0685c"

export function MessagesPhone({ params, updatedAt }: { params: Params; updatedAt?: number }) {
  const [tab, setTab] = useState<TabId>("summary")
  const go = (t: TabId) => { setTab(t); window.scrollTo({ top: 0 }) }   // a new tab starts at its top
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Messages sections" className="no-scrollbar sticky top-12 z-10 -mx-3 flex gap-1.5 overflow-x-auto bg-background/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}
            className={cn("flex-1 whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium transition-colors", tab === t.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground active:bg-muted/70")}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <>
          <SelectedTemplateCard params={params} />
          <Headline params={params} />
          <ChatsStrip params={params} />
          <div className="flex justify-center pt-1"><LiveBadge updatedAt={updatedAt} /></div>
        </>
      )}
      {tab === "trends" && <TrendCard params={params} />}
      {tab === "failures" && <FailureReasonsCard params={params} />}
      {tab === "messages" && <MessageLogCard params={params} />}
    </div>
  )
}

/** The big number (messages sent) and the four steps after it, each with its count, its share and a bar: the funnel as a list that fits a phone. */
function Headline({ params }: { params: Params }) {
  const mk = useApi<any>("messages/kpis", params)
  const c = mk.data?.current
  const rows: { label: string; n?: number; p?: number | null; color: string }[] = [
    { label: "Delivered", n: c?.delivered_adj, p: c?.delivered_pct, color: DELIVERED },
    { label: "Read", n: c?.read_adj, p: c?.read_pct, color: READ },
    { label: "Replied", n: c?.replied, p: c?.replied_pct, color: REPLIED },
    { label: "Failed", n: c?.failed, p: c?.failed_pct, color: FAILED },
  ]
  return (
    <section className="rounded-xl border bg-card p-4" aria-label="Message numbers">
      <ErrorNote message={mk.error} />
      {!c ? <div className="flex flex-col gap-3"><Skeleton className="h-12 w-40" /><Skeleton className="h-28 w-full" /></div> : !c.measured ? <Empty>No messages were tracked in this period.</Empty> : (
        <>
          <div className="text-sm text-muted-foreground">Messages sent</div>
          <div className="tnum text-4xl font-semibold tracking-tight">{num(c.measured)}</div>
          <div className="text-xs text-muted-foreground">{num(c.attempts)} in all, including repeats</div>
          <div className="mt-4 flex flex-col gap-3.5">
            {rows.map((r) => (
              <div key={r.label}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{r.label}</span>
                  <span className="tnum text-sm"><b className="text-base font-semibold">{num(r.n)}</b><span className="ml-1.5 text-muted-foreground">{r.p == null ? "" : `${one(r.p)}%`}</span></span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, r.p ?? 0))}%`, background: r.color }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Delivered and read are at least these numbers: WhatsApp does not always report them.</p>
        </>
      )}
    </section>
  )
}

/** Four small chat figures from WATI's own conversation status, with a link to all chats. Nothing shows when WATI's status has not been saved yet. */
function ChatsStrip({ params }: { params: Params }) {
  const dates = { from: params.from, to: params.to }
  const ws = useApi<any>("chats/wati-status", dates)
  const w = ws.data?.available ? ws.data : null
  if (!w) return null
  const q = new URLSearchParams(); if (params.from) q.set("from", String(params.from)); if (params.to) q.set("to", String(params.to))
  const stats: [string, ReactNode][] = [["Chats", num(w.period.total)], ["Solved", num(w.period.solved)], ["Open now", num(w.live.open + w.live.pending)], ["Missed", num(w.period.missed)]]
  return (
    <section className="rounded-xl border bg-card p-4" aria-label="Chats with customers">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Chats with customers</h2>
        <Link to={{ pathname: "/chats", search: q.toString() ? "?" + q.toString() : "" }} className="inline-flex items-center gap-1 text-sm">See all <ArrowRight className="size-3.5" /></Link>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {stats.map(([label, v]) => (
          <div key={label}>
            <div className="tnum text-xl font-semibold">{v}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
