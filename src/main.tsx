import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import "./index.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppLayout } from "@/components/app-layout"
import { AuthGate } from "@/lib/auth"
import { FiltersProvider } from "@/lib/filters"
import { RefreshProvider } from "@/components/refresh"
import { RevealProvider } from "@/lib/reveal"
const Overview = lazy(() => import("@/pages/overview"))
const Messages = lazy(() => import("@/pages/messages"))
const Chats = lazy(() => import("@/pages/chats"))
const Agents = lazy(() => import("@/pages/agents"))
const Chatbots = lazy(() => import("@/pages/chatbots"))
const Customers = lazy(() => import("@/pages/customers"))

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider delay={150}>
        <AuthGate>
        <RefreshProvider>
        <FiltersProvider>
          <RevealProvider>
          <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Overview />} />
              <Route path="messages" element={<Messages />} />
              <Route path="chats" element={<Chats />} />
              <Route path="agents" element={<Agents />} />
              <Route path="chatbots" element={<Chatbots />} />
              <Route path="customers" element={<Customers />} />
              {/* old "v1" addresses still work for bookmarks */}
              <Route path="ov_v1" element={<Navigate to="/" replace />} />
              <Route path="mes_v1" element={<Navigate to="/messages" replace />} />
              <Route path="chats_v1" element={<Navigate to="/chats" replace />} />
              <Route path="cust_v1" element={<Navigate to="/customers" replace />} />
              <Route path="*" element={<Overview />} />
            </Route>
          </Routes>
          </Suspense>
          </RevealProvider>
        </FiltersProvider>
        </RefreshProvider>
        </AuthGate>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
