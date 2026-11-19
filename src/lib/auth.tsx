import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Eye, EyeOff, KeyRound, LockKeyhole } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** Demo login. The server keeps the session (a cookie); the page only asks "am I logged in?" and shows the login screen when not. */
type Ctx = { logout: () => void; hasLogin: boolean; user: string | null; canChangePassword: boolean }
const AuthCtx = createContext<Ctx>({ logout: () => {}, hasLogin: false, user: null, canChangePassword: false })
export const useAuth = () => useContext(AuthCtx)

export const UNAUTH_EVENT = "aq-unauth"

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "in" | "out">("checking")
  const [hasLogin, setHasLogin] = useState(true)
  const [user, setUser] = useState<string | null>(null)
  const [canChangePassword, setCanChange] = useState(false)
  const [notice, setNotice] = useState<string>()   // a hosted copy that is not set up yet says what is missing (503), instead of only failing at the first login

  useEffect(() => {
    const ac = new AbortController()
    fetch("/api/session", { signal: ac.signal })
      .then(async (r) => {
        if (r.status === 404) { setHasLogin(false); setState("in"); return }   // an older server with no login: nothing to ask for
        const j = await r.json().catch(() => null)
        if (r.status === 503 && j?.error) setNotice(j.error)
        setUser(j?.user ?? null); setCanChange(!!j?.canChangePassword)
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
  if (state === "out") return <LoginPage onDone={(u) => { setUser(u); setState("in") }} notice={notice} />
  return <AuthCtx.Provider value={{ logout, hasLogin, user, canChangePassword }}>{children}</AuthCtx.Provider>
}

/** a password box with an eye button that shows or hides what is typed */
function PasswordInput({ id, value, onChange, autoComplete, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} className="pr-10" />
      <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} title={show ? "Hide password" : "Show password"} aria-pressed={show}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

/** top-bar button: change your own password (needs the current one) */
export function ChangePasswordButton() {
  const { user, canChangePassword } = useAuth()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState(false)
  if (!canChangePassword) return null

  const reset = () => { setCurrent(""); setNext(""); setAgain(""); setError(undefined); setDone(false); setBusy(false) }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== again) { setError("The two new passwords are not the same."); return }
    if (next.length < 8) { setError("The new password needs at least 8 characters."); return }
    setBusy(true); setError(undefined)
    try {
      const r = await fetch("/api/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, next }) })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || `Could not change the password (${r.status})`)
      setDone(true); setCurrent(""); setNext(""); setAgain("")
    } catch (err: any) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => { reset(); setOpen(true) }} aria-label="Change password" title="Change password"><KeyRound className="size-4" /><span className="hidden lg:inline">Password</span></Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>{user ? <>For <span className="font-medium text-foreground">{user}</span>. </> : null}Your other devices are logged out within 5 minutes.</DialogDescription>
          </DialogHeader>
          {done ? (
            <div className="flex flex-col gap-3">
              <p role="status" className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm">Password changed.</p>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5"><Label htmlFor="aq-cur">Current password</Label><PasswordInput id="aq-cur" autoFocus autoComplete="current-password" value={current} onChange={setCurrent} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="aq-new">New password (8 or more characters)</Label><PasswordInput id="aq-new" autoComplete="new-password" value={next} onChange={setNext} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="aq-again">New password again</Label><PasswordInput id="aq-again" autoComplete="new-password" value={again} onChange={setAgain} /></div>
              {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
              <Button type="submit" disabled={busy || !current || !next || !again}>{busy ? "Saving…" : "Change password"}</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function LoginPage({ onDone, notice }: { onDone: (user: string | null) => void; notice?: string }) {
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
      onDone(j?.user ?? null)
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
          <PasswordInput id="aq-pass" autoComplete="current-password" value={pass} onChange={setPass} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-primary" />Remember me on this computer for 30 days</label>
        {error && <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
        <Button type="submit" disabled={busy || !user.trim() || !pass}><LockKeyhole className="size-4" />{busy ? "Checking…" : "Log in"}</Button>
      </form>
    </div>
  )
}
