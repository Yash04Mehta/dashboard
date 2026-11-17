import { LiveBadge, LivePage } from "@/components/v1"
import { CustomerLookup } from "@/components/customer-lookup"

/** Customer lookup: on the live database the customer you have open refreshes by itself every minute, and the badge says when it last did.
 *  Phone numbers stay masked unless the switch on the customer is turned on. */
export default function Customers() {
  return <LivePage><CustomerLookup title="Customer lookup" badge={(t) => <LiveBadge updatedAt={t} />} /></LivePage>
}
