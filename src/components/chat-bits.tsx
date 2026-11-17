import { cn } from "@/lib/utils"
import { hourLabel } from "@/lib/format"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** weekday x hour grid, shaded by count */
export function Heat({ cells, kind }: { cells: any[]; kind: "chats" | "unassigned" }) {
  const order = [1, 2, 3, 4, 5, 6, 0]   // Monday first
  const get = (d: number, h: number) => cells.find((c) => c.dow === d && c.hour === h)?.[kind] ?? 0
  const max = Math.max(1, ...cells.map((c) => c[kind]))
  const color = kind === "chats" ? "var(--c1)" : "var(--warn)"
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[2.2rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-muted-foreground">
        <span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="overflow-visible whitespace-nowrap">{h % 6 === 0 ? hourLabel(h) : ""}</span>)}
      </div>
      {order.map((d) => (
        <div key={d} className="grid grid-cols-[2.2rem_repeat(24,minmax(0,1fr))] items-center gap-[2px]">
          <span className="text-xs text-muted-foreground">{WEEKDAYS[d]}</span>
          {Array.from({ length: 24 }, (_, h) => { const n = get(d, h); return <span key={h} title={`${WEEKDAYS[d]} ${hourLabel(h)}: ${n} chat${n === 1 ? "" : "s"}`} className="aspect-square rounded-[3px] bg-muted/50" style={n ? { background: color, opacity: 0.2 + 0.8 * (n / max) } : undefined} /> })}
        </div>
      ))}
      <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">Few<span className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(to right, color-mix(in oklab, ${color} 20%, transparent), ${color})` }} />Most: {max} in one hour</div>
    </div>
  )
}

/** a small on/off pill, used for the chart's series and the compare switch */
export function Pill({ on, onClick, color, children, disabled, title }: { on: boolean; onClick: () => void; color?: string; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} title={title} onClick={onClick}
      className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50", on ? "border-foreground/30 bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
      {color && <span className="size-2.5 rounded-[2px] border" style={{ background: on ? color : "transparent", borderColor: color }} />}
      {children}
    </button>
  )
}
