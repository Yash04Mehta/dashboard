import { useCallback, useEffect, useState, type ReactNode } from "react"

/**
 * Lazy loading for what is below the first screen. `useSeen` turns true once an element has come near the viewport (and stays true),
 * so a page can hold back the data requests of its lower sections until somebody scrolls there.
 * Without IntersectionObserver (very old browsers) everything loads at once, as before.
 */
export function useSeen(margin = "400px"): [(el: Element | null) => void, boolean] {
  const [el, setEl] = useState<Element | null>(null)
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined")
  const ref = useCallback((node: Element | null) => setEl(node), [])
  useEffect(() => {
    if (seen || !el) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin: `${margin} 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen, margin])
  return [ref, seen]
}

/** Renders its children (and so starts their data requests) only when they are about to be scrolled into view. Until then it holds the space with a placeholder. */
export function LazyMount({ children, minHeight = 240, margin }: { children: ReactNode; minHeight?: number; margin?: string }) {
  const [ref, seen] = useSeen(margin)
  if (seen) return <>{children}</>
  return <div ref={ref} style={{ minHeight }} className="animate-pulse rounded-xl border bg-muted/30" aria-busy="true" aria-label="Loading when you scroll here" />
}
