import { useColResize } from "@/components/col-resize"
import { useEffect, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorNote, STICKY_HEAD } from "@/components/kit"
import { useApi } from "@/lib/api"
import { num } from "@/lib/format"
import { cn } from "@/lib/utils"

export type PagedCol = { key: string; header: string; sort?: string; render: (r: any) => ReactNode; className?: string }

/** A server-paged, searchable, sortable list. Clicking a row opens that customer. */
export function PagedList({ endpoint, params, cols, onRow, placeholder, rowKey }: {
  endpoint: string
  params: Record<string, string>
  cols: PagedCol[]
  onRow: (r: any) => void
  placeholder: string
  rowKey: (r: any) => string
}) {
  const [q, setQ] = useState("")
  const [dq, setDq] = useState("")
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState("created")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const pkey = JSON.stringify(params)
  useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => setPage(1), [pkey])
  const { data, error, loading } = useApi<any>(endpoint, { ...params, q: dq, page, pageSize: 25, sort, dir })
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 25))
  const click = (s?: string) => { if (!s) return; if (s === sort) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(s); setDir(s === "created" ? "desc" : "asc") } setPage(1) }

  const rs = useColResize(cols.length, !!data?.rows?.length)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-start">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={placeholder} />
        </div>
      </div>
      <ErrorNote message={error} />
      <div className={cn("max-h-[34rem] overflow-auto rounded-lg border transition-opacity", loading && "opacity-60")}>
        <Table ref={rs.ref} style={rs.style}>
          {rs.colgroup}
          <TableHeader className={STICKY_HEAD}>
            <TableRow>
              {cols.map((c, i) => (
                <TableHead key={c.key} className={cn("relative whitespace-nowrap text-center", rs.line)} aria-sort={c.sort && c.sort === sort ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                  {c.sort ? (
                    <button type="button" onClick={() => click(c.sort)} className="relative inline-flex items-center gap-1 font-medium hover:text-foreground">
                      {c.header}{sort === c.sort && <span className={"absolute left-full top-1/2 ml-1 inline-flex -translate-y-1/2"}>{dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}</span>}
                    </button>
                  ) : c.header}
                  {rs.handle(i)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data && Array.from({ length: 6 }).map((_, i) => <TableRow key={i}>{cols.map((c) => <TableCell key={c.key}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)}
            {data?.rows.map((r: any) => (
              <TableRow key={rowKey(r)} className="cursor-pointer" onClick={() => onRow(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onRow(r) }}>
                {cols.map((c) => <TableCell key={c.key} className={cn("tnum overflow-hidden text-ellipsis text-center", rs.line, c.className)}>{c.render(r)}</TableCell>)}
              </TableRow>
            ))}
            {data && !data.rows.length && <TableRow><TableCell colSpan={cols.length} className="py-8 text-center text-muted-foreground">Nothing matches.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{data ? `${num(total ? (page - 1) * 25 + 1 : 0)} to ${num(Math.min(page * 25, total))} of ${num(total)}` : ""}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft /></Button>
          <span className="px-2">Page {page} of {num(pages)}</span>
          <Button variant="outline" size="icon-sm" onClick={() => setPage(page + 1)} disabled={page >= pages} aria-label="Next page"><ChevronRight /></Button>
        </div>
      </div>
    </div>
  )
}

export function Dots({ items }: { items: { label: string; done: boolean }[] }) {
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={items.map((i) => `${i.label}: ${i.done ? "done" : "not done"}`).join(", ")}>
      {items.map((i) => <span key={i.label} title={`${i.label}: ${i.done ? "done" : "not done"}`} className={cn("size-2.5 rounded-full", i.done ? "bg-good" : "bg-muted-foreground/25")} />)}
    </span>
  )
}
