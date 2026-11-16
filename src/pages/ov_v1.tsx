import { LazyMount } from "@/components/lazy"
import { FilterBar } from "@/components/filter-bar"
import { SendTimeChart, TemplateTable } from "@/components/analysis"
import { ErrorNote, PageHeader } from "@/components/kit"
import { ConversationDetails, LiveBadge, LivePage, MessageFunnelCard, MessageNumbers, ResponseTimeCard } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"

/** Overview v1: the layout from "Overview Page.md". Conversation details first, then the lead and message numbers, then four sections. */
export default function OverviewV1() {
  return <LivePage><Page /></LivePage>
}

function Page() {
  const { params } = useFilters()
  const { templates: _t, ...noTemplate } = params       // leads and chats are not tied to a template
  const stamp = useApi<any>("messages/kpis", params)    // only used for the "updated" time in the badge (the server answers it from its cache)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview v1" description="Chats, leads and WhatsApp messages in one place. Each number shows the count and the percentage." actions={<LiveBadge updatedAt={stamp.updatedAt} />} />
      <FilterBar kinds={["templates", "sources", "owners"]} />
      <p className="-mt-3 text-xs text-muted-foreground">Picking a template changes the message numbers only. Chats and leads do not depend on the template, and chats follow the date range only.</p>
      <ErrorNote message={stamp.error} />

      <ConversationDetails params={params} />
      <MessageNumbers params={params} noTemplate={noTemplate} />

      <LazyMount minHeight={320}>
        <div className="grid gap-4 lg:grid-cols-2">
          <ResponseTimeCard params={params} />
          <SendTimeChart params={params} />
        </div>
      </LazyMount>
      <LazyMount minHeight={300}><MessageFunnelCard params={params} /></LazyMount>
      {/* the template table compares templates with each other, so it ignores the template filter */}
      <LazyMount minHeight={400}><TemplateTable params={noTemplate} /></LazyMount>
    </div>
  )
}
