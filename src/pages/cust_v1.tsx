import { LiveBadge, LivePage } from "@/components/v1"
import { CustomerLookup } from "@/pages/customers"

/** Customer lookup v1: the same customer lookup as the Customer lookup page, inside the live reports group. On the live database the customer you have open
 *  refreshes by itself every minute, and the badge says when it last did. Phone numbers stay masked unless the switch on the customer is turned on. */
export default function CustomerLookupV1() {
  return <LivePage><CustomerLookup title="Customer lookup v1" badge={(t) => <LiveBadge updatedAt={t} />} /></LivePage>
}
