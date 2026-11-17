import { LazyMount } from "@/components/lazy"
import { FilterBar } from "@/components/filter-bar"
import { ErrorNote, PageHeader } from "@/components/kit"
import { ConversationDetails, FailureReasonsCard, LiveBadge, LivePage, MessageFunnelCard, MessageLogCard, MessageNumbers, SelectedTemplateCard, TrendCard } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"

/** Messages: the "Messages Section" from "Overview Page.md". Conversation details first, the message numbers, the funnel, then trends over the days. */
export default function Messages() {
  return <LivePage><Page /></LivePage>
}

function Page() {
  const { params } = useFilters()
  const { templates: _t, ...noTemplate } = params
  const stamp = useApi<any>("messages/kpis", params)
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Messages" description="How your WhatsApp messages and templates perform. Each number shows the count and the percentage." actions={<LiveBadge updatedAt={stamp.updatedAt} />} />
      <FilterBar kinds={["templates", "sources", "owners"]} reveal />
      <p className="text-xs text-muted-foreground">Picking a template changes the message numbers only. Chats and leads do not depend on the template, and chats follow the date range only.</p>
      <ErrorNote message={stamp.error} />

      <SelectedTemplateCard params={params} />
      <ConversationDetails params={params} />
      <MessageNumbers params={params} noTemplate={noTemplate} />
      <LazyMount minHeight={300}><MessageFunnelCard params={params} /></LazyMount>
      <LazyMount minHeight={360}><TrendCard params={params} /></LazyMount>
      <LazyMount minHeight={360}><FailureReasonsCard params={params} /></LazyMount>
      <LazyMount minHeight={500}><MessageLogCard params={params} /></LazyMount>
    </div>
  )
}
