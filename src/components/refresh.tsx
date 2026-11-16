// One place for "get fresh numbers": a Refresh button in the top bar, and an automatic refresh every 30 minutes.
// A refresh does not reload the page: every figure is fetched again (and the server is asked to skip its short-lived cache),
// so the filters, tabs and scroll position stay exactly as they are.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { format } from "date-fns"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RefreshVersionContext } from "@/lib/api"
import { cn } from "@/lib/utils"

export const AUTO_REFRESH_MS = 30 * 60 * 1000

const Ctrl = createContext<{ refresh: () => void; at: number } | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)
  const [at, setAt] = useState(() => Date.now())
  const atRef = useRef(at)
  const refresh = useCallback(() => { const now = Date.now(); atRef.current = now; setAt(now); setVersion((v) => v + 1) }, [])
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) refresh() }, AUTO_REFRESH_MS)
    // a tab that sat in the background does not tick; catch up when it comes back
    const back = () => { if (!document.hidden && Date.now() - atRef.current >= AUTO_REFRESH_MS) refresh() }
    document.addEventListener("visibilitychange", back)
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", back) }
  }, [refresh])
  const value = useMemo(() => ({ refresh, at }), [refresh, at])
  return <Ctrl.Provider value={value}><RefreshVersionContext.Provider value={version}>{children}</RefreshVersionContext.Provider></Ctrl.Provider>
}

export function RefreshButton() {
  const c = useContext(Ctrl)
  const [spin, setSpin] = useState(false)
  if (!c) return null
  const click = () => { c.refresh(); setSpin(true); setTimeout(() => setSpin(false), 1200) }
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden text-xs text-muted-foreground sm:inline">Updated {format(c.at, "HH:mm")}</span>
      <Button variant="ghost" size="sm" onClick={click} title="Get the latest numbers now. This page also refreshes by itself every 30 minutes." aria-label="Refresh the numbers">
        <RefreshCw className={cn("size-4", spin && "animate-spin")} /><span className="hidden sm:inline">Refresh</span>
      </Button>
    </div>
  )
}
