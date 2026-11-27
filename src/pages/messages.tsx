import { LazyMount } from "@/components/lazy"
import { SendTimeChart, TemplateTable } from "@/components/analysis"
import { FilterBar } from "@/components/filter-bar"
import { ErrorNote, PageHeader } from "@/components/kit"
import { FailureReasonsCard, LiveBadge, LivePage, MessageCostStrip, MessageFunnelCard, MessageLogCard, MessageNumbers, SelectedTemplateCard, TrendCard } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useIsMobile } from "@/hooks/use-mobile"
import { MessagesPhone } from "@/components/phone-messages"

/** Messages: everything about the template messages (numbers, funnel, cost, trends, best send times, templates, failures, the full list). Chats and leads live on Overview. */
export default function Messages() {
  return <LivePage><Page /></LivePage>
}

function Page() {
  const { params } = useFilters()
  const { templates: _t, ...noTemplate } = params
  const stamp = useApi<any>("messages/kpis", params)
  const phone = useIsMobile()
  // phone: filters as one swipeable row, then the tabbed screen (see components/phone-messages.tsx)
  if (phone) return (
    <div className="flex flex-col gap-2">
      <FilterBar kinds={["templates", "sources", "owners"]} reveal compact />
      <ErrorNote message={stamp.error} />
      <MessagesPhone params={params} updatedAt={stamp.updatedAt} />
    </div>
  )
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Messages" description="How your WhatsApp messages and templates perform. Each number shows the count and the percentage." actions={<LiveBadge updatedAt={stamp.updatedAt} />} />
      <FilterBar kinds={["templates", "sources", "owners"]} reveal />
      <p className="text-xs text-muted-foreground">Picking a template changes the message numbers only. The template table always compares all templates.</p>
      <ErrorNote message={stamp.error} />

      <SelectedTemplateCard params={params} />
      <MessageNumbers params={params} noTemplate={noTemplate} leads={false} />
      <LazyMount minHeight={300}><MessageFunnelCard params={params} /></LazyMount>
      <LazyMount minHeight={120}><MessageCostStrip params={params} /></LazyMount>
      <LazyMount minHeight={360}><TrendCard params={params} /></LazyMount>
      <LazyMount minHeight={320}><SendTimeChart params={params} /></LazyMount>
      {/* the template table compares templates with each other, so it ignores the template filter */}
      <LazyMount minHeight={400}><TemplateTable params={noTemplate} /></LazyMount>
      <LazyMount minHeight={360}><FailureReasonsCard params={params} /></LazyMount>
      <LazyMount minHeight={500}><MessageLogCard params={params} /></LazyMount>
    </div>
  )
}
