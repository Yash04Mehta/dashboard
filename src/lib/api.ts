import { createContext, useContext, useEffect, useRef, useState } from "react"

/** How often (ms) data hooks below this provider fetch again by themselves. 0 = never. The live pages set it; the others leave it off. */
export const RefreshContext = createContext(0)

/** Goes up by one each time the user (or the 30 minute timer) asks for fresh numbers. Every data hook fetches again when it changes. */
export const RefreshVersionContext = createContext(0)

export type Params = Record<string, string | number | boolean | undefined | null>

export async function api<T = any>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v))
  const r = await fetch(`/api/${path}${qs.toString() ? "?" + qs : ""}`, { signal })
  // A request that is cancelled while its body is still arriving (the page changed its filter or day/week/month setting) must stay a cancellation.
  // It used to be turned into an empty answer, which made a page read .rows of nothing and go blank.
  let j: any = null
  try { j = await r.json() } catch (e: any) { if (e?.name === "AbortError") throw e }
  if (r.status === 401) window.dispatchEvent(new Event("aq-unauth"))   // the login ended: AuthGate shows the login screen again
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`)
  if (j === null) throw new Error("The server sent an answer the page could not read. Press Refresh to try again.")
  return j
}

export type ApiState<T> = { data?: T; error?: string; loading: boolean; updatedAt?: number }

/** Fetches while keeping the previous result on screen, so filters feel instant. Pass null to skip. */
export function useApi<T = any>(path: string | null, params: Params = {}): ApiState<T> {
  const refreshMs = useContext(RefreshContext)
  const version = useContext(RefreshVersionContext)
  const [tick, setTick] = useState(0)
  const key = path ? path + "?" + JSON.stringify(params) + "#" + tick + "." + version : ""
  const [state, setState] = useState<ApiState<T>>({ loading: !!path })
  const last = useRef<T | undefined>(undefined)
  const upd = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!refreshMs || !path) return
    const id = setInterval(() => { if (!document.hidden) setTick((t) => t + 1) }, refreshMs)
    return () => clearInterval(id)
  }, [refreshMs, path])
  useEffect(() => {
    if (!path) { setState({ loading: false }); return }
    const ac = new AbortController()
    setState({ data: last.current, loading: true, updatedAt: upd.current })
    api<T>(path, version > 0 ? { ...params, _: version } : params, ac.signal)   // _ makes the server skip its cached answer
      .then((data) => { if (ac.signal.aborted) return; last.current = data; upd.current = Date.now(); setState({ data, loading: false, updatedAt: upd.current }) })
      .catch((e) => { if (e.name !== "AbortError" && !ac.signal.aborted) setState({ data: last.current, error: e.message, loading: false, updatedAt: upd.current }) })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}
