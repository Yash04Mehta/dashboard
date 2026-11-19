import { useEffect, useState } from "react"
import { NavLink, Outlet, useLocation } from "react-router-dom"
import { Activity, Headset, LogOut, MessageSquare, MessagesSquare, Moon, Sun, UserSearch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { RefreshButton } from "@/components/refresh"
import { ExportReportButton } from "@/components/export-report"
import { ChangePasswordButton, useAuth } from "@/lib/auth"
import { useFilters } from "@/lib/filters"
import { day } from "@/lib/format"

// the four live pages ("range" carries an explicit "All time" from page to page; without it every page opens on yesterday)
const NAV = [
  { to: "/", label: "Overview", icon: Activity, keep: ["from", "to", "range", "templates", "sources", "owners"], title: "Overview" },
  { to: "/messages", label: "Messages", icon: MessageSquare, keep: ["from", "to", "range", "templates", "sources", "owners"], title: "Messages" },
  { to: "/chats", label: "Chats", icon: MessagesSquare, keep: ["from", "to", "range"], title: "Chats" },
  { to: "/agents", label: "Agents", icon: Headset, keep: ["from", "to", "range"], title: "Agents" },
  { to: "/customers", label: "Customer lookup", icon: UserSearch, keep: [], title: "Customer lookup" },
]

function ThemeToggle() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem("aq-theme") } catch { /* storage unavailable */ }
    const start = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches
    setDark(start); document.documentElement.classList.toggle("dark", start)
  }, [])
  const flip = () => {
    const next = !dark
    setDark(next); document.documentElement.classList.toggle("dark", next)
    try { localStorage.setItem("aq-theme", next ? "dark" : "light") } catch { /* ignore */ }
  }
  return (
    <Button variant="ghost" size="icon" onClick={flip} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

/** The menu list. On a phone the menu is a slide-over sheet, so choosing a page also closes it. */
function NavList({ current, linkSearch }: { current: (typeof NAV)[number]; linkSearch: (keep: string[]) => string }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      {NAV.map((n) => (
        <SidebarMenuItem key={n.to}>
          <SidebarMenuButton isActive={n === current} render={<NavLink to={{ pathname: n.to, search: linkSearch(n.keep) }} onClick={() => setOpenMobile(false)} />}>
            <n.icon />
            <span>{n.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

export function AppLayout() {
  const { meta, metaError } = useFilters()
  const { logout, hasLogin } = useAuth()
  const loc = useLocation()
  const params = new URLSearchParams(loc.search)
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])   // a new page starts at its top, not where the last one was scrolled to
  const current = NAV.find((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to))) ?? NAV[0]
  const linkSearch = (keep: string[]) => { const p = new URLSearchParams(); for (const k of keep) if (params.get(k)) p.set(k, params.get(k)!); const s = p.toString(); return s ? "?" + s : "" }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">A</div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Aquant Insight</div>
              <div className="text-xs text-muted-foreground">WhatsApp, leads, opportunities</div>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Reports</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavList current={current} linkSearch={linkSearch} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-1 px-4 py-3 text-xs text-muted-foreground">
          {meta ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={meta.mode === "live" ? "default" : "secondary"}>{meta.mode === "live" ? "Live database" : "Snapshot"}</Badge>
              </div>
              <div>{meta.mode === "live" ? "Read-only connection" : `Data as of ${day(meta.asOf)}`}</div>
            </>
          ) : <Skeleton className="h-4 w-24" />}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-x-clip">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-1.5 border-b bg-background/85 px-3 backdrop-blur sm:gap-2 sm:px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <span className="min-w-0 truncate text-sm font-medium">{current.title}</span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1"><ExportReportButton /><RefreshButton /><ThemeToggle />{hasLogin && <ChangePasswordButton />}{hasLogin && <Button variant="ghost" size="sm" onClick={logout} aria-label="Log out" title="Log out"><LogOut className="size-4" /><span className="hidden sm:inline">Log out</span></Button>}</div>
        </header>
        <div className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-5 p-3 sm:gap-6 sm:p-4 md:p-6">
          {metaError ? (
            <div role="alert" className="rounded-lg border border-bad/40 bg-bad/10 p-4 text-sm text-bad">
              The server could not load the data: {metaError}. Check that it is running (npm start) and look at its window for the reason.
            </div>
          ) : !meta ? (
            <div className="flex flex-col gap-4"><Skeleton className="h-9 w-64" /><Skeleton className="h-24 w-full" /><Skeleton className="h-72 w-full" /></div>
          ) : <Outlet />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
