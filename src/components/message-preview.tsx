import { useState } from "react"
import { Check, Copy, ExternalLink, FileText, Image as ImageIcon, Phone, Reply, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/kit"

export type TemplateMessage = {
  template_name: string
  missing?: boolean
  category?: string
  status?: string
  language?: string
  lastModified?: string | null
  header?: { kind: string; text: string; file: string } | null
  body?: string
  footer?: string
  buttons?: { type: string; text: string; url: string; phone: string }[]
  params?: string[]
  from?: "wati" | "file"            // wati = current text from WATI (synced into the database); file = the exported template file
  syncedAt?: string | null          // when the sync last confirmed this text with WATI (India time)
  version?: number                  // which version of the text this is (1 = never edited since we started watching)
  versions?: number                 // how many versions we have seen
  firstSeen?: string | null         // the day our sync first saw the template (NOT its creation day in WATI)
  watiId?: string | null
  addedInWati?: string | null       // the day the template was added in WATI
  addedHow?: "field" | "id" | null  // field = WATI sent a created date; id = worked out from the template's id (it holds the creation time)
  firstSent?: string | null         // first / last message sent with it, and how many, from our own message data
  lastSent?: string | null
  totalSent?: number
  history?: { version: number; since: string | null; until: string | null; current: boolean; body: string }[]
}

const TOKEN = /(\{\{[^}]+\}\}|\*[^*\n]+\*)/g

/** {{Name}} becomes a highlighted slot, *text* is bold (WhatsApp's own markup) */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN).map((part, i) => {
        if (/^\{\{.+\}\}$/.test(part)) return <span key={i} className="rounded bg-c1/15 px-1 py-px font-medium text-c1" title="Filled in with the customer's or the owner's details when the message is sent">{part.slice(2, -2)}</span>
        if (/^\*.+\*$/.test(part)) return <b key={i}>{part.slice(1, -1)}</b>
        return part
      })}
    </>
  )
}

const HEAD_ICON: Record<string, typeof FileText> = { document: FileText, image: ImageIcon, video: Video }

/** The message as the customer sees it: header, text, footer and buttons. Names of the details filled in per customer are highlighted. */
export function MessagePreview({ msg }: { msg: TemplateMessage }) {
  const [copied, setCopied] = useState(false)
  if (msg.missing) return <Empty>WATI's message for this template is not in the database yet. Once the “WATI Template Sync” workflow has run, it shows here by itself. Until then, saving WATI's template export as <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">data_insight/wati_templates.json</code> also works.</Empty>
  const body = (msg.body ?? "").replace(/\r\n?/g, "\n").trim()
  const head = msg.header
  const HeadIcon = head ? HEAD_ICON[head.kind] : undefined
  const copy = async () => {
    try { await navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border bg-muted/40 p-4">
        <div className="mx-auto flex max-w-sm flex-col gap-1.5">
          <div className="rounded-lg rounded-tl-none border bg-card px-3 py-2.5 text-sm leading-relaxed shadow-sm">
            {head && (head.text ? <div className="mb-1.5 font-semibold">{head.text}</div> : HeadIcon && (
              <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground"><HeadIcon className="size-4 shrink-0" /><span className="truncate">{head.file || head.kind}</span></div>
            ))}
            <div className="whitespace-pre-wrap break-words"><Rich text={body} /></div>
            {msg.footer && <div className="mt-1.5 text-xs text-muted-foreground">{msg.footer}</div>}
          </div>
          {msg.buttons?.map((b, i) => {
            const Icon = b.url ? ExternalLink : b.phone ? Phone : Reply
            return <div key={i} className="flex items-center justify-center gap-1.5 rounded-lg border bg-card px-3 py-2 text-sm font-medium text-c1 shadow-sm"><Icon className="size-3.5" />{b.text}</div>
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{msg.params?.length ? <>Filled in for each customer: {msg.params.join(", ")}</> : "No details are filled in per customer."}</span>
        <Button variant="ghost" size="sm" onClick={copy}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy text"}</Button>
      </div>
    </div>
  )
}
