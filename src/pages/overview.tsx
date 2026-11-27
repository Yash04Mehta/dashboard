import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { LazyMount } from "@/components/lazy"
import { FilterBar } from "@/components/filter-bar"
import { SendTimeChart, TemplateTable } from "@/components/analysis"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ErrorNote, PageHeader } from "@/components/kit"
import { ConversationDetails, LiveBadge, LivePage, MessageFunnelCard, MessageNumbers } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"

/** Overview: what needs attention first. Chats in three tabs (right now, who followed up, how the dates went), then the lead and message numbers, send times, funnel and template table.
 *  The Messages page holds only what is not here (trends, failures, cost, the full list). */
export default function Overview() {
  return <LivePage><Page /></LivePage>
}

function Page() {
  const { params } = useFilters()
  const { templates: _t, ...noTemplate } = params       // leads and chats are not tied to a template
  const [tab, setTab] = useState<"now" | "followup" | "summary">("now")
  const stamp = useApi<any>("messages/kpis", params)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="What needs your attention: leads, chats and the messages behind them." actions={<LiveBadge updatedAt={stamp.updatedAt} />} />
      <FilterBar kinds={["templates", "sources", "owners"]} />
      <ErrorNote message={stamp.error} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="now">Right now</TabsTrigger>
              <TabsTrigger value="followup">Who followed up</TabsTrigger>
              <TabsTrigger value="summary">Chats in these dates</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex items-center gap-4 text-sm">
            <Link to="/chats" className="inline-flex items-center gap-1 hover:underline">All chats <ArrowRight className="size-3.5" /></Link>
            <Link to="/messages" className="inline-flex items-center gap-1 hover:underline">Messages page <ArrowRight className="size-3.5" /></Link>
          </span>
        </div>
        <ConversationDetails params={params} part={tab} />
      </section>

      <MessageNumbers params={params} noTemplate={noTemplate} />
      <LazyMount minHeight={320}><SendTimeChart params={params} /></LazyMount>
      <LazyMount minHeight={300}><MessageFunnelCard params={params} /></LazyMount>
      {/* the template table compares templates with each other, so it ignores the template filter */}
      <LazyMount minHeight={400}><TemplateTable params={noTemplate} /></LazyMount>
    </div>
  )
}
