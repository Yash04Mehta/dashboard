import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

/**
 * Column lines and drag-to-resize for a table, like a spreadsheet: drag the line at the right edge of a header to make that column wider or narrower,
 * double-click it to go back to the automatic width. The first render lets the browser size the columns; their widths are then measured and kept
 * (table-layout fixed), so dragging one column changes only that column. Widths last until the page is reloaded.
 * Use: `const rs = useColResize(cols.length, ready)`, then `<Table ref={rs.ref} style={rs.style}>{rs.colgroup}`, a `{rs.handle(i)}` inside each header cell
 * (give it `relative`) and `rs.line` on header and body cells.
 */
export function useColResize(n: number, ready = true) {
  const ref = useRef<HTMLTableElement>(null)
  const [w, setW] = useState<number[] | null>(null)
  useLayoutEffect(() => {
    if (!ready || !ref.current || (w && w.length === n)) return
    const ths = Array.from(ref.current.querySelectorAll<HTMLElement>("thead tr:first-child > th"))
    if (ths.length === n) setW(ths.map((t) => Math.max(60, Math.round(t.getBoundingClientRect().width))))
  })
  const startDrag = useCallback((i: number, e: React.PointerEvent) => {
    if (!w) return
    e.preventDefault(); e.stopPropagation()
    const x0 = e.clientX, w0 = w[i]
    const move = (ev: PointerEvent) => setW((cur) => (cur ? cur.map((v, k) => (k === i ? Math.max(60, Math.round(w0 + ev.clientX - x0)) : v)) : cur))
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; document.body.style.userSelect = "" }
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up)
  }, [w])
  const reset = useCallback(() => setW(null), [])
  const style: CSSProperties | undefined = w ? { tableLayout: "fixed", width: w.reduce((a, b) => a + b, 0), minWidth: "100%" } : undefined
  const colgroup: ReactNode = w ? <colgroup>{w.map((v, i) => <col key={i} style={{ width: v }} />)}</colgroup> : null
  const handle = (i: number): ReactNode => (
    <span role="separator" aria-orientation="vertical" aria-label="Drag to change the column width. Double-click to reset all columns." title="Drag to resize · double-click to reset"
      onPointerDown={(e) => startDrag(i, e)} onDoubleClick={reset} onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 z-20 flex h-full w-2.5 cursor-col-resize touch-none select-none justify-end hover:bg-primary/20 active:bg-primary/30" />
  )
  return { ref, style, colgroup, handle, line: "border-r border-border last:border-r-0", fixed: !!w }
}
