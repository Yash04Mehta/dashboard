// "Export report" button in the top bar. Builds the report (src/lib/report.ts) for the date range and filters currently chosen and downloads it as a PDF.
// With no dates chosen it covers the last 30 days. The PDF is made on this computer by the server (it prints the report page with the Edge or Chrome that is installed here).
// If that is not possible, the report opens as a page instead, where "Save as PDF / Print" does the same job.
// The report holds totals only (no phone numbers or message text), so it is not behind the reveal switch. Nothing is sent anywhere outside this computer.
import { useState } from "react"
import { FileDown, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { renderReport } from "@/lib/report"

function save(blob: Blob, name: string) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob); a.download = name
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

export function ExportReportButton() {
  const { params, meta } = useFilters()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = async () => {
    setBusy(true); setError(undefined)
    try {
      const data = await api("report/data", { ...params, _: Date.now() })   // _ skips the server's short-lived cache, so the report is always current
      const html = renderReport(data)
      const base = `Aquant-report_${data.period.from}_to_${data.period.to}`
      try {
        const r = await fetch("/api/report/pdf", { method: "POST", headers: { "Content-Type": "text/html", "X-Aquant": "1" }, body: html })
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `PDF request failed (${r.status})`)
        save(await r.blob(), `${base}.pdf`)
      } catch (e: any) {   // no PDF maker on this server (old server still running, or no Edge/Chrome): open the report page instead
        const tab = window.open("", "_blank")
        if (tab) { tab.document.open(); tab.document.write(html); tab.document.close() }
        else save(new Blob([html], { type: "text/html;charset=utf-8" }), `${base}.html`)
        setError("PDF could not be made automatically, so the report page was opened instead. " + (e?.message || ""))
      }
    } catch (e: any) {
      setError(e?.message || "The report could not be made.")
    } finally { setBusy(false) }
  }

  const when = params.from || params.to ? "for the dates and filters chosen" : "for the last 30 days (choose dates to change this)"
  return (
    <div className="flex items-center gap-1.5">
      {error && <span role="alert" className="max-w-56 truncate text-xs text-bad" title={error}>{error}</span>}
      <Button variant="outline" size="sm" onClick={run} disabled={busy || !meta} title={`Download a PDF report ${when}.`}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <FileDown className="size-4" />}<span className="hidden sm:inline">{busy ? "Preparing PDF…" : "Export report"}</span>
      </Button>
    </div>
  )
}
