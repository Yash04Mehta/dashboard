/** One CSV cell. Text that starts with = + - @ would be read as a formula by Excel, so it gets a quote in front; long digit strings (phone numbers) are kept as text. */
export const csvCell = (v: unknown): string => {
  let t = v == null ? "" : String(v)
  if (/^\d{10,}$/.test(t)) return `="${t}"`
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** Downloads a CSV file made in the browser (with a byte-order mark so Excel reads Hindi names correctly). Nothing is sent anywhere. */
export function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const text = "\uFEFF" + [head, ...rows].map((l) => l.map(csvCell).join(",")).join("\r\n")
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
