// Aquant Insight server: JSON API + the built web app. Listens on this machine only (it serves customer data).
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { connect } from './db.mjs'
import { makeApi } from './queries.mjs'
import { makeReport } from './report.mjs'
import { htmlToPdf } from './pdf.mjs'
import { configStamp } from './costs.mjs'
import { authInDb, getUser, setPassword, checkPassword, stampOf } from './auth.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(path.resolve(here, '..', '.env')) } catch { /* no .env file: CSV mode with defaults */ }
const dist = path.resolve(here, '..', 'dist')
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
// Netlify Function mode (set by netlify/functions/api.mjs): no port, no static files (Netlify serves dist/), no warm-up timers, and the app is exported instead of listening.
const SERVERLESS = process.env.AQ_SERVERLESS === '1'
// Cloudflare Worker: work started by one request cannot be awaited by another, so no shared in-flight answers and no background refreshes.
const WORKER = process.env.AQ_WORKER === '1'
// the caller's address, for the "10 wrong tries" lock. On Netlify only the header Netlify itself sets can be trusted (the others can be typed by anyone).
const clientIp = (req) => String((SERVERLESS ? req.headers['x-nf-client-connection-ip'] : req.headers['cf-connecting-ip']) || req.socket.remoteAddress || '')

console.log('Aquant Insight: loading data ...')
const t0 = Date.now()
const ctx = await connect()
console.log(`Data ready in ${((Date.now() - t0) / 1000).toFixed(1)}s  (${ctx.mode} mode, data as of ${ctx.asOf})`)
const api = makeApi(ctx)
api['report/data'] = makeReport(api, ctx)   // everything the downloadable report shows, in one call (reuses the functions above)

const app = express()
app.disable('x-powered-by')

// refuse requests that do not address this machine by name (blocks DNS-rebinding style access)
app.use((req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0]
  const viaTunnel = process.env.TUNNEL === '1' && host.endsWith('.trycloudflare.com') // opt-in: share.bat only
  if (!SERVERLESS && HOST === '127.0.0.1' && !viaTunnel && !['127.0.0.1', 'localhost'].includes(host)) return res.status(403).json({ error: 'Forbidden host' })
  next()
})

// Optional password (share_secure.bat sets DASH_PASSWORD). When set, EVERY request needs it (browser login box, any user name). Off by default.
const DASH_PASSWORD = process.env.DASH_PASSWORD || ''
if (DASH_PASSWORD) {
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest()
  const want = sha(DASH_PASSWORD)
  const fails = new Map()   // ip -> { n, until }: 10 wrong tries locks that address for 10 minutes
  app.use((req, res, next) => {
    const ip = clientIp(req)
    const f = fails.get(ip)
    if (f && f.n >= 10 && Date.now() < f.until) return res.status(429).type('text').send('Too many wrong passwords. Try again in 10 minutes.')
    const m = /^Basic (.+)$/i.exec(String(req.headers.authorization || ''))
    const given = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':') : null
    if (given !== null && crypto.timingSafeEqual(sha(given), want)) { fails.delete(ip); return next() }
    if (given !== null) fails.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 600000 })
    res.setHeader('WWW-Authenticate', 'Basic realm="Aquant Insight", charset="UTF-8"')
    res.setHeader('Cache-Control', 'no-store')
    res.status(401).type('text').send('Password needed.')
  })
}

// ---- Login ----
// Accounts live in the database (server/auth.mjs: table dashboard_auth.users). Without a database login for it (running on your own computer) one account comes from
// DEMO_USER / DEMO_PASS (admin / pass@123 by default).
// POST /api/login checks the user name and password and sets a SIGNED session cookie (HttpOnly) that names the user. It lasts 8 hours, or 30 days when "Remember me" is ticked.
// The cookie also carries a fingerprint of the stored password, so changing a password (POST /api/password) ends that user's other sessions within 5 minutes.
// Every other /api route needs that cookie. The web app itself (the page and its scripts) is public so the login screen can load; it holds no data.
const DEMO_USER = process.env.DEMO_USER || 'admin'
const DEMO_PASS = process.env.DEMO_PASS || 'pass@123'
const SESSION_MS = 8 * 3600 * 1000, REMEMBER_MS = 30 * 24 * 3600 * 1000
const secretFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.session_secret')
const sessionSecret = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  try { const v = fs.readFileSync(secretFile, 'utf8').trim(); if (v.length >= 32) return v } catch { /* first start: make one */ }
  const v = crypto.randomBytes(48).toString('hex')
  try { fs.writeFileSync(secretFile, v, { mode: 0o600 }) } catch { /* read-only folder: sessions then last until the next restart */ }
  return v
})()
const signKey = crypto.createHmac('sha256', sessionSecret).update(authInDb() ? 'db-logins-v1' : DEMO_USER + ':' + DEMO_PASS).digest()
const sign = (body) => crypto.createHmac('sha256', signKey).update(body).digest('hex')
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')
const makeToken = (ms, user, stamp) => { const body = [Date.now() + ms, b64u(user), stamp, crypto.randomBytes(12).toString('hex')].join('.'); return body + '.' + sign(body) }
const revoked = new Set()    // tokens signed out since this server started (a restart forgets them; they still end at their own expiry)
const loginFails = new Map() // ip -> { n, until }: 10 wrong tries lock that address for 10 minutes
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest()
const same = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b))
const cookieOf = (req, name) => { for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()) } return '' }
/** the session in the cookie ({ user, stamp }) when it is signed by us and not expired, else null */
const sessionOf = (req) => {
  const t = cookieOf(req, 'aq_session'), p = t.split('.')
  if (p.length !== 5 || revoked.has(t) || !/^[0-9a-f]+$/.test(p[4])) return null
  const want = sign(p.slice(0, 4).join('.'))
  if (want.length !== p[4].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(p[4]))) return null
  if (!(Number(p[0]) > Date.now())) return null
  return { user: Buffer.from(p[1], 'base64url').toString('utf8'), stamp: p[2] }
}
// password fingerprints from the database, re-read at most every 5 minutes per user (each request reads for itself: nothing is shared between requests)
const stamps = new Map()     // user -> { at, stamp }
const loggedIn = async (req) => {
  const s = sessionOf(req)
  if (!s) return null
  if (!authInDb()) return s.user === DEMO_USER ? s : null
  let c = stamps.get(s.user)
  if (!c || Date.now() - c.at > 5 * 60_000) { const u = await getUser(s.user); c = { at: Date.now(), stamp: u ? stampOf(u.password_hash) : null }; stamps.set(s.user, c) }
  return c.stamp && c.stamp === s.stamp ? s : null
}
/** the account for these two values, or null */
const checkLogin = async (username, password) => {
  if (!authInDb()) return same(username, DEMO_USER) && same(password, DEMO_PASS) ? { user: DEMO_USER, stamp: 'local' } : null
  const u = await getUser(username)
  if (!u || !checkPassword(password, u.password_hash)) return null
  const stamp = stampOf(u.password_hash)
  stamps.set(u.username, { at: Date.now(), stamp })
  return { user: u.username, stamp }
}
const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https'
const setCookie = (req, res, v, maxAge) => res.setHeader('Set-Cookie', `aq_session=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`)
const tooMany = (ip) => { const f = loginFails.get(ip); return f && f.n >= 10 && Date.now() < f.until }
const failed = (ip) => { const f = loginFails.get(ip); loginFails.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 600000 }) }

app.get('/api/session', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try { const s = await loggedIn(req); res.json({ authenticated: !!s, user: s?.user ?? null, canChangePassword: authInDb() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
app.post('/api/login', express.json({ limit: '2kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const ip = clientIp(req)
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many wrong tries. Please wait 10 minutes.' })
  const { username, password, remember } = req.body || {}
  try {
    const s = typeof username === 'string' && typeof password === 'string' && username.length <= 200 && password.length <= 200 ? await checkLogin(username, password) : null
    if (!s) { failed(ip); return res.status(401).json({ error: 'Wrong user name or password.' }) }
    loginFails.delete(ip)
    const ms = remember === true ? REMEMBER_MS : SESSION_MS
    setCookie(req, res, makeToken(ms, s.user, s.stamp), ms / 1000)
    res.json({ authenticated: true, user: s.user })
  } catch (e) { console.error('[login]', e.message); res.status(500).json({ error: 'Login is not available right now. Please try again.' }) }
})
app.post('/api/logout', (req, res) => { revoked.add(cookieOf(req, 'aq_session')); setCookie(req, res, '', 0); res.json({ authenticated: false }) })
app.use('/api', async (req, res, next) => {
  try { const s = await loggedIn(req); if (s) { req.aqUser = s.user; return next() } } catch (e) { console.error('[session]', e.message); return res.status(500).json({ error: 'Login check failed. Please try again.' }) }
  res.setHeader('Cache-Control', 'no-store'); res.status(401).json({ error: 'Please log in first.' })
})
// Change your own password: needs the current one. Accounts are never created or removed here.
app.post('/api/password', express.json({ limit: '2kb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (!authInDb()) return res.status(400).json({ error: 'Passwords can only be changed on the hosted site.' })
  const ip = clientIp(req)
  if (tooMany(ip)) return res.status(429).json({ error: 'Too many wrong tries. Please wait 10 minutes.' })
  const { current, next } = req.body || {}
  if (typeof current !== 'string' || typeof next !== 'string') return res.status(400).json({ error: 'Fill in both passwords.' })
  if (next.length < 8 || next.length > 200) return res.status(400).json({ error: 'The new password needs at least 8 characters.' })
  if (next === current) return res.status(400).json({ error: 'The new password is the same as the current one.' })
  try {
    if (!(await checkLogin(req.aqUser, current))) { failed(ip); return res.status(401).json({ error: 'The current password is wrong.' }) }
    await setPassword(req.aqUser, next)
    const u = await getUser(req.aqUser), stamp = stampOf(u.password_hash)
    stamps.set(req.aqUser, { at: Date.now(), stamp })
    const old = cookieOf(req, 'aq_session')
    revoked.add(old)
    const left = Math.max(60, Math.round((Number(old.split('.')[0]) - Date.now()) / 1000))
    setCookie(req, res, makeToken(left * 1000, req.aqUser, stamp), left)   // this browser stays logged in; the user's other sessions end
    res.json({ ok: true })
  } catch (e) { console.error('[password]', e.message); res.status(500).json({ error: 'Could not change the password. Please try again.' }) }
})

// Report as a PDF. The page sends the report HTML it just built (totals only); this answers with the PDF. The custom header makes other websites unable to call it.
app.post('/api/report/pdf', express.text({ type: 'text/html', limit: '8mb' }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.headers['x-aquant'] !== '1') return res.status(403).json({ error: 'Not allowed' })
    const html = typeof req.body === 'string' ? req.body : ''
    if (!/^<!doctype html>/i.test(html) || !html.includes('name="report-file"')) return res.status(400).json({ error: 'That is not a report page' })
    const pdf = await htmlToPdf(html)
    res.setHeader('Content-Type', 'application/pdf')
    res.send(pdf)
  } catch (e) {
    console.error('[report/pdf]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ---- Answer cache (speed) ----
//  - The key ignores the order of the parameters, so the same question always finds its answer.
//  - The same question asked twice at once is worked out once ("in flight" sharing).
//  - Live mode: an answer up to 5 minutes old is shown AT ONCE while a fresh one is fetched in the background (stale-while-revalidate); the page's own
//    refresh (every minute on the live pages) then shows the fresh one. Older than that, or "Refresh" pressed (the _ parameter), waits for the database.
//  - A cached answer is never older than cacheMs + one refresh cycle in the normal case. Snapshot (CSV) mode never expires.
const cache = new Map()      // key -> { at, body }
const inflight = new Map()   // key -> promise
const STALE_MS = ctx.mode === 'live' ? 5 * 60_000 : Infinity
let lastUse = Date.now()
const keyOf = (name, query) => {
  const p = Object.keys(query).filter((k) => k !== '_').sort().map((k) => `${k}=${typeof query[k] === 'string' ? query[k] : JSON.stringify(query[k])}`).join('&')
  const pricey = name.startsWith('costs/') || name === 'chats/cost' || name === 'chats/list'   // prices live in config files that can change while the server runs
  return `${name}?${p}${pricey ? '#' + configStamp() : ''}`
}
const compute = (key, name, handler, query) => {
  if (!WORKER && inflight.has(key)) return inflight.get(key)
  const t0 = performance.now()
  const p = (async () => handler(query))().then((body) => {
    if (process.env.TIMING === '1') console.log(`[timing] ${key.slice(0, 150)} ${Math.round(performance.now() - t0)} ms`)
    if (cache.size > 800) cache.clear()
    cache.set(key, { at: Date.now(), body })
    return body
  }).finally(() => inflight.delete(key))
  if (!WORKER) inflight.set(key, p)
  return p
}
app.use('/api', async (req, res) => {
  const name = req.path.replace(/^\//, '')
  const handler = api[name]
  res.setHeader('Cache-Control', 'no-store')
  if (!handler) return res.status(404).json({ error: `Unknown endpoint: ${name}` })
  try {
    lastUse = Date.now()
    const key = keyOf(name, req.query)
    const hit = cache.get(key), age = hit ? Date.now() - hit.at : Infinity
    const bypass = req.query._ !== undefined   // the Refresh button: wait for fresh numbers
    if (hit && !bypass && age < ctx.cacheMs) return res.json(hit.body)
    if (!WORKER && hit && !bypass && age < STALE_MS) { compute(key, name, handler, req.query).catch((e) => console.error(`[${name}] background refresh:`, e.message)); return res.json(hit.body) }
    res.json(await compute(key, name, handler, req.query))
  } catch (e) {
    console.error(`[${name}]`, e.message)
    res.status(500).json({ error: e.message })
  }
})

if (SERVERLESS) {
  // Netlify serves the built web app itself (see netlify.toml); this function answers /api only
} else if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist))
  app.use((req, res) => res.sendFile(path.join(dist, 'index.html')))
} else {
  app.get('/', (_req, res) => res.type('text').send('API is running. Run "npm run build" to build the web app, or "npm run dev" for development.'))
}

// ---- Warm-up (live mode): get the first screen of every page ready before anyone asks ----
// The pages open on yesterday, so the requests they make for yesterday are worked out when the server starts and again every 4 minutes while the dashboard is in use
// (the last 30 minutes), which keeps them inside the 5-minute window above. Four at a time, so real requests are never stuck behind them. Nothing is written anywhere.
const warmJobs = () => {
  const y = new Date(Date.parse(ctx.asOf + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
  const d = { from: y, to: y }, g = { from: y, to: y, grain: 'day' }
  return [
    ['meta', {}],
    // Overview and Messages
    ['messages/kpis', d], ['leads/kpis', d], ['chats/wati-status', d], ['messages/templates', d], ['messages/reply-time', d], ['messages/heatmap', d],
    ['messages/trend', g], ['messages/fail-reasons', d], ['messages/log', { ...d, limit: '25', page: '1' }],
    // Chats
    ['chats/kpis', d], ['chats/list', d], ['chats/cost', g], ['chats/operators', d], ['chats/trend', g], ['chats/wati-operators', d], ['chats/wati-tags', d],
    ['chats/duration', g], ['chats/heatmap', d], ['chats/flow', g], ['chats/message-types', d], ['chats/delivery', d],
    // Agents
    ['agents/overview', g],
  ].filter(([name]) => api[name])
}
async function warm() {
  const jobs = warmJobs()
  let i = 0
  const worker = async () => { while (i < jobs.length) { const [name, q] = jobs[i++]; try { await compute(keyOf(name, q), name, api[name], q) } catch { /* a failed warm-up just means that page loads normally */ } } }
  await Promise.all([worker(), worker(), worker(), worker()])
}

if (!SERVERLESS) {
  app.listen(PORT, HOST, () => {
    console.log(`Open http://localhost:${PORT}  (Ctrl+C to stop)`)
    if (ctx.mode === 'live') {
      const t = Date.now()
      warm().then(() => console.log(`First screens ready in ${((Date.now() - t) / 1000).toFixed(1)}s`))
      setInterval(() => { if (Date.now() - lastUse < 30 * 60_000) warm() }, 4 * 60_000).unref()
    }
  })
}
export { app }
