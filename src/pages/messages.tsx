import { LazyMount } from "@/components/lazy"
import { FilterBar } from "@/components/filter-bar"
import { ErrorNote, PageHeader } from "@/components/kit"
import { FailureReasonsCard, LiveBadge, LivePage, MessageCostStrip, MessageLogCard, SelectedTemplateCard, TrendCard } from "@/components/v1"
import { useApi } from "@/lib/api"
import { useFilters } from "@/lib/filters"
import { useIsMobile } from "@/hooks/use-mobile"
import { MessagesPhone } from "@/components/phone-messages"

/** Messages: what is not on Overview: cost, trends over the days, failure reasons and the full message list. The numbers, funnel, send times and template table are on Overview. */
export default function Messages() {
  return <LivePage><Page /></LivePage>
}

function Page() {
  const { params } = useFilters()
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
      <p className="text-xs text-muted-foreground">Picking a template changes the message numbers only. Message numbers and the funnel are on Overview.</p>
      <ErrorNote message={stamp.error} />

      <SelectedTemplateCard params={params} />
      <LazyMount minHeight={120}><MessageCostStrip params={params} /></LazyMount>
      <LazyMount minHeight={360}><TrendCard params={params} /></LazyMount>
      <LazyMount minHeight={360}><FailureReasonsCard params={params} /></LazyMount>
      <LazyMount minHeight={500}><MessageLogCard params={params} /></LazyMount>
    </div>
  )
}
