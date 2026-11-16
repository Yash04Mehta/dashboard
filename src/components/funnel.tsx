import { useId, useRef, useState, type ReactNode } from "react"
import { num, pct } from "@/lib/format"

/** `drop` says in plain words what the people lost after this stage were doing */
export type Stage = { label: string; value: number; icon: ReactNode; drop?: string }

const TOP = 6, NODE_W = 6, END = 0.8
// sleek style: blue, then teal, then green, so a message that gets further looks healthier
const SHADES = ["var(--c1)", "color-mix(in oklab, var(--c1) 50%, var(--c2))", "var(--c2)", "var(--good)"]
const shade = (i: number, n: number) => SHADES[Math.min(SHADES.length - 1, n <= SHADES.length ? i : Math.round((i * (SHADES.length - 1)) / (n - 1)))]
// the full size is for a page-wide funnel; compact is for two side by side
const SIZE = { full: { W: 940, BAND: 230, DROP: 34, LEAK_L: 120, big: 16, small: 12 }, compact: { W: 640, BAND: 190, DROP: 28, LEAK_L: 64, big: 14, small: 11 } }

/**
 * Conversion funnel: one column per stage, a band that carries on to the next stage, and a fading curve below it
 * for what dropped out. The biggest drop is red (unless `highlightWorst` is off). Bar heights are proportional to each stage's value.
 * Move the pointer over it and the nearest stage lights up, the rest fade, and a card says how many got there and how many did not.
 */
export function Funnel({ stages, ariaLabel, highlightWorst = true, unit = "messages", compact = false, sleek = false }: { stages: Stage[]; ariaLabel: string; highlightWorst?: boolean; unit?: string; compact?: boolean; sleek?: boolean }) {
  const { W, BAND, DROP, LEAK_L, big, small } = SIZE[compact ? "compact" : "full"]
  const H = TOP + BAND + DROP + 10
  const id = useId().replace(/:/g, "")
  const box = useRef<HTMLDivElement>(null)
  const [hot, setHot] = useState<number | null>(null)
  const first = Math.max(1, stages[0]?.value ?? 1)
  const k = BAND / first
  const xs = stages.map((_, i) => (i * END * W) / Math.max(1, stages.length - 1))
  const hs = stages.map((s) => Math.max(2, s.value * k))
  const lost = stages.map((s, i) => (i < stages.length - 1 ? Math.max(0, s.value - stages[i + 1].value) : 0))
  const worst = lost.indexOf(Math.max(...lost))
  const last = stages.length - 1

  const aim = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width) return
    const x = ((clientX - r.left) / r.width) * W
    setHot(xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0))
  }
  const fade = (i: number) => (hot == null || hot === i ? 1 : 0.4)
  const h = hot == null ? null : stages[hot]

  return (
    <div className="overflow-x-auto">
      <div ref={box} className={compact ? "relative min-w-[480px]" : "relative min-w-[720px]"} onMouseMove={(e) => aim(e.clientX)} onClick={(e) => aim(e.clientX)} onMouseLeave={() => setHot(null)}>
        <div className="relative h-[68px]">
          {stages.map((s, i) => (
            <div key={s.label} className="absolute top-0 min-w-0 transition-opacity" style={{ left: `${(100 * xs[i]) / W}%`, opacity: fade(i) }}>
              <div className={compact ? "flex items-center gap-1 whitespace-nowrap text-xs font-medium" : "flex items-center gap-1.5 text-sm font-medium"}>{sleek ? <span className="flex size-6 items-center justify-center rounded-md" style={{ background: `color-mix(in oklab, ${shade(i, stages.length)} 16%, transparent)`, color: shade(i, stages.length) }}>{s.icon}</span> : <span className="text-muted-foreground">{s.icon}</span>}{s.label}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={compact ? "tnum text-xl font-semibold tracking-tight" : "tnum text-2xl font-semibold tracking-tight"}>{num(s.value)}</span>
                {i > 0 && (sleek ? <span className="tnum rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{pct(100 * s.value / first)}</span> : <span className="tnum text-sm text-muted-foreground">{pct(100 * s.value / first)}</span>)}
              </div>
            </div>
          ))}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={ariaLabel}>
          <defs>
            {sleek && stages.slice(1).map((s, j) => (
              <linearGradient key={`b${j}`} id={`${id}-b${j + 1}`} x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor={shade(j, stages.length)} /><stop offset="1" stopColor={shade(j + 1, stages.length)} /></linearGradient>
            ))}
            {([["bad", "var(--bad)"], ["grey", "var(--c6)"]] as const).map(([n, c]) => (
              <linearGradient key={n} id={`${id}-${n}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={c} stopOpacity={0.85} /><stop offset="1" stopColor={c} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {stages.slice(1).map((s, j) => {
            const i = j + 1
            const lit = hot === i || hot === i - 1      // the band into or out of the stage under the pointer
            return <rect key={s.label} x={xs[i - 1] + NODE_W} y={TOP} width={xs[i] - xs[i - 1] - NODE_W} height={Math.min(hs[i - 1], hs[i])} rx={sleek ? 5 : 0} fill={sleek ? `url(#${id}-b${i})` : "var(--c1)"} fillOpacity={sleek ? (hot == null ? 0.5 : lit ? 0.78 : 0.18) : hot == null ? 0.4 : lit ? 0.6 : 0.15} style={{ transition: "fill-opacity .15s" }} />
          })}
          {stages.map((s, i) => <rect key={s.label} x={xs[i]} y={TOP} width={sleek ? NODE_W + 2 : NODE_W} height={hs[i]} rx={sleek ? 4 : 1.5} fill={sleek ? shade(i, stages.length) : "var(--c1)"} opacity={fade(i)} style={{ transition: "opacity .15s" }} />)}
          {lost.map((n, i) => {
            if (!n) return null
            const x0 = xs[i] + NODE_W, y0 = TOP + Math.min(hs[i], hs[i + 1]), lh = Math.max(3, hs[i] - Math.min(hs[i], hs[i + 1])), y1 = y0 + DROP, c = x0 + LEAK_L / 2
            const isWorst = highlightWorst && i === worst
            return (
              <g key={i} opacity={fade(i)} style={{ transition: "opacity .15s" }}>
                <path d={`M${x0},${y0} C${c},${y0} ${c},${y1} ${x0 + LEAK_L},${y1} L${x0 + LEAK_L},${y1 + lh} C${c},${y1 + lh} ${c},${y0 + lh} ${x0},${y0 + lh} Z`} fill={`url(#${id}-${isWorst ? "bad" : "grey"})`} />
                <text x={x0 + LEAK_L + 10} y={y1 + lh / 2 - (stages[i].drop ? 2 : -5)} fontSize={big} fontWeight={600} fill={isWorst ? "var(--bad)" : "var(--foreground)"} className="tnum">−{num(n)}</text>
                {stages[i].drop && <text x={x0 + LEAK_L + 10} y={y1 + lh / 2 + big - 1} fontSize={small} fill="var(--muted-foreground)">{stages[i].drop}</text>}
              </g>
            )
          })}
        </svg>
        {hot != null && h && (
          <div role="status" className="pointer-events-none absolute z-10 w-60 rounded-lg border bg-popover p-3 text-sm shadow-lg"
            style={{ top: compact ? 74 : 78, left: `calc(${(100 * xs[hot]) / W}% + ${hot === last ? -14 : 20}px)`, transform: hot === last ? "translateX(-100%)" : undefined }}>
            <div className="flex items-center gap-2"><span className="h-4 w-1 rounded-full bg-[var(--c1)]" /><span className="tnum text-base font-semibold">{num(h.value)} {unit}</span></div>
            <div className="mt-1 text-muted-foreground">{h.label}</div>
            <div className="mt-2 flex flex-col gap-0.5 border-t pt-2 text-muted-foreground">
              {hot === 0 ? <span>Where everyone starts</span> : (
                <>
                  <span><b className="tnum text-foreground">{pct(stages[hot - 1].value ? (100 * h.value) / stages[hot - 1].value : null)}</b> of {stages[hot - 1].label.toLowerCase()}</span>
                  {hot > 1 && <span><b className="tnum text-foreground">{pct((100 * h.value) / first)}</b> of {stages[0].label.toLowerCase()}</span>}
                  <span><b className="tnum text-foreground">{num(Math.max(0, stages[hot - 1].value - h.value))}</b> didn't make it this far</span>
                </>
              )}
              {hot < last && lost[hot] > 0 && <span><b className="tnum text-foreground">{num(lost[hot])}</b> drop out after this{h.drop ? `: ${h.drop}` : ""}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
