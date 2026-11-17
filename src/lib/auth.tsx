import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { LockKeyhole } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Demo login. The server keeps the session (a cookie); the page only asks "am I logged in?" and shows the login screen when not. */
type Ctx = { logout: () => void; hasLogin: boolean }
const AuthCtx = createContext<Ctx>({ logout: () => {}, hasLogin: false })
export const useAuth = () => useContext(AuthCtx)

export const UNAUTH_EVENT = "aq-unauth"

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "in" | "out">("checking")
  const [hasLogin, setHasLogin] = useState(true)
  const [notice, setNotice] = useState<string>()   // a hosted copy that is not set up yet says what is missing (503), instead of only failing at the first login

  useEffect(() => {
    const ac = new AbortController()
    fetch("/api/session", { signal: ac.signal })
      .then(async (r) => {
        if (r.status === 404) { setHasLogin(false); setState("in"); return }   // an older server with no login: nothing to ask for
        const j = await r.json().catch(() => null)
        if (r.status === 503 && j?.error) setNotice(j.error)
        setState(j?.authenticated ? "in" : "out")
      })
      .catch((e) => { if (e?.name !== "AbortError") setState("out") })
    return () => ac.abort()
  }, [])
  // any data request that comes back "log in first" (session ended, server restarted) sends the user back to the login screen
  useEffect(() => {
    const out = () => setState("out")
    window.addEventListener(UNAUTH_EVENT, out)
    return () => window.removeEventListener(UNAUTH_EVENT, out)
  }, [])

  const logout = useCallback(() => { fetch("/api/logout", { method: "POST" }).finally(() => setState("out")) }, [])

  if (state === "checking") return <div className="p-8 text-sm text-muted-foreground">Loading…</div>
  if (state === "out") return <LoginPage onDone={() => setState("in")} notice={notice} />
  return <AuthCtx.Provider value={{ logout, hasLogin }}>{children}</AuthCtx.Provider>
}

function LoginPage({ onDone, notice }: { onDone: () => void; notice?: string }) {
  const [user, setUser] = useState("")
  const [pass, setPass] = useState("")
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(notice)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(undefined)
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user.trim(), password: pass, remember }) })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `Login failed (${r.status})`)
      onDone()
    } catch (err: any) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm" aria-label="Log in">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">A</div>
          <div className="leading-tight">
            <div className="text-base font-semibold">Aquant Insight</div>
            <div className="text-xs text-muted-foreground">WhatsApp, leads, opportunities</div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="aq-user">User name</Label>
          <Input id="aq-user" autoFocus autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="aq-pass">Password</Label>
          <Input id="aq-pass" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-primary" />Remember me on this computer for 30 days</label>
        {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
        <Button type="submit" disabled={busy || !user.trim() || !pass}><LockKeyhole className="size-4" />{busy ? "Checking…" : "Log in"}</Button>
      </form>
    </div>
  )
}
