import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import "./index.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppLayout } from "@/components/app-layout"
import { FiltersProvider } from "@/lib/filters"
import { RefreshProvider } from "@/components/refresh"
import { RevealProvider } from "@/lib/reveal"
const Overview = lazy(() => import("@/pages/overview"))
const Messages = lazy(() => import("@/pages/messages"))
const Costs = lazy(() => import("@/pages/costs"))
const Inbox = lazy(() => import("@/pages/inbox"))
const Leads = lazy(() => import("@/pages/leads"))
const Opportunities = lazy(() => import("@/pages/opportunities"))
const Customers = lazy(() => import("@/pages/customers"))
const OverviewV1 = lazy(() => import("@/pages/ov_v1"))
const MessagesV1 = lazy(() => import("@/pages/mes_v1"))
const ChatsV1 = lazy(() => import("@/pages/chats_v1"))
const CustomerLookupV1 = lazy(() => import("@/pages/cust_v1"))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider delay={150}>
        <RefreshProvider>
        <FiltersProvider>
          <RevealProvider>
          <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Overview />} />
              <Route path="messages" element={<Messages />} />
              <Route path="costs" element={<Costs />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="leads" element={<Leads />} />
              <Route path="opportunities" element={<Opportunities />} />
              <Route path="customers" element={<Customers />} />
              <Route path="ov_v1" element={<OverviewV1 />} />
              <Route path="mes_v1" element={<MessagesV1 />} />
              <Route path="chats_v1" element={<ChatsV1 />} />
              <Route path="cust_v1" element={<CustomerLookupV1 />} />
              <Route path="*" element={<Overview />} />
            </Route>
          </Routes>
          </Suspense>
          </RevealProvider>
        </FiltersProvider>
        </RefreshProvider>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
