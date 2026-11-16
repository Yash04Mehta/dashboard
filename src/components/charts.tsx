import type { ChartConfig } from "@/components/ui/chart"

export const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)"]

/** tooltip row with swatch, name and value (keeps the colour dot that a custom formatter would otherwise drop) */
export const rowFormatter = (config: ChartConfig, suffix = "") => (value: any, name: any, item: any) => (
  <div className="flex w-full items-center gap-2">
    <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item?.color ?? item?.payload?.fill }} />
    <span className="text-muted-foreground">{(config as any)[name]?.label ?? name}</span>
    <span className="ml-auto pl-3 font-mono font-medium tabular-nums text-foreground">{value == null ? "—" : typeof value === "number" ? value.toLocaleString("en-US") + suffix : value + suffix}</span>
  </div>
)

export const axis = { tickLine: false, axisLine: false, tickMargin: 8, style: { fontSize: 12 } } as const
