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

const here = path.dirname(fileURLToPath(import.meta.url))
try { process.loadEnvFile(path.resolve(here, '..', '.env')) } catch { /* no .env file: CSV mode with defaults */ }
const dist = path.resolve(here, '..', 'dist')
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'

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
  if (HOST === '127.0.0.1' && !viaTunnel && !['127.0.0.1', 'localhost'].includes(host)) return res.status(403).json({ error: 'Forbidden host' })
  next()
})

// Optional password (share_secure.bat sets DASH_PASSWORD). When set, EVERY request needs it (browser login box, any user name). Off by default.
const DASH_PASSWORD = process.env.DASH_PASSWORD || ''
if (DASH_PASSWORD) {
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest()
  const want = sha(DASH_PASSWORD)
  const fails = new Map()   // ip -> { n, until }: 10 wrong tries locks that address for 10 minutes
  app.use((req, res, next) => {
    const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '')
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

const cache = new Map()
app.use('/api', async (req, res) => {
  const name = req.path.replace(/^\//, '')
  const handler = api[name]
  res.setHeader('Cache-Control', 'no-store')
  if (!handler) return res.status(404).json({ error: `Unknown endpoint: ${name}` })
  try {
    const key = name.startsWith('costs/') || name === 'chats/cost' || name === 'chats/list' ? req.originalUrl + '#' + configStamp() : req.originalUrl   // prices live in config files that can change while the server runs
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ctx.cacheMs) return res.json(hit.body)
    const body = await handler(req.query)
    if (cache.size > 500) cache.clear()
    cache.set(key, { at: Date.now(), body })
    res.json(body)
  } catch (e) {
    console.error(`[${name}]`, e.message)
    res.status(500).json({ error: e.message })
  }
})

if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist))
  app.use((req, res) => res.sendFile(path.join(dist, 'index.html')))
} else {
  app.get('/', (_req, res) => res.type('text').send('API is running. Run "npm run build" to build the web app, or "npm run dev" for development.'))
}

app.listen(PORT, HOST, () => console.log(`Open http://localhost:${PORT}  (Ctrl+C to stop)`))
