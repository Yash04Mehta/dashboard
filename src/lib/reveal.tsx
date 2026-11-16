import { createContext, useContext, useState, type ReactNode } from "react"
import { useFilters } from "@/lib/filters"

/** One "show phone numbers and messages" switch for the whole app. It lives in the filter bar at the top of a page and every card on the page follows it.
 *  Kept in memory only: reloading the page hides everything again, and it is never stored in the address or the browser. The server still decides
 *  (ALLOW_REVEAL): on a screen that cannot reveal, canReveal is false and the switch is not shown. */
const Ctx = createContext<{ reveal: boolean; setReveal: (v: boolean) => void }>({ reveal: false, setReveal: () => {} })

export function RevealProvider({ children }: { children: ReactNode }) {
  const [reveal, setReveal] = useState(false)
  return <Ctx.Provider value={{ reveal, setReveal }}>{children}</Ctx.Provider>
}

export function useReveal() {
  const { meta } = useFilters()
  const { reveal, setReveal } = useContext(Ctx)
  const canReveal = !!meta?.canReveal
  return { reveal: reveal && canReveal, setReveal, canReveal }
}
