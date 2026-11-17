// Netlify Function (current format, ES module): runs the same Express app as server/index.mjs for every /api/* request.
// Netlify serves the built web app (dist/) by itself. This function holds the login and the database connection.
//
// How: the Express app is started once per warm copy of the function on a private port of this machine (127.0.0.1, not reachable from outside), and each
// request that Netlify hands over is passed to it and its answer handed back. That keeps Express, its body parsing and its cookies exactly as they are locally.
//
// A public site must not start with the demo defaults or without the database, so the function refuses to answer (503 + a plain message) until Netlify has:
//   DATABASE_URL (or PGHOST + PGUSER + PGPASSWORD + PGDATABASE)   a READ-ONLY login (dashboard_ro)
//   DEMO_USER, DEMO_PASS     your own login for the site (the defaults are public in the repo, so the default password is refused)
//   SESSION_SECRET           any long random text (each function copy must sign the login cookie the same way)
// Phone numbers and message text can only be revealed if you also set ALLOW_REVEAL=true; it is off here by default.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

export const config = { path: '/api/*' }

process.env.AQ_SERVERLESS = '1'
process.env.ALLOW_REVEAL ||= 'false'
// where netlify.toml ships config/ (rate card, template list): the first place that has it
process.env.AQ_CONFIG_DIR ||= [process.env.LAMBDA_TASK_ROOT, process.cwd(), '/var/task'].filter(Boolean).map((d) => path.join(d, 'config')).find((d) => fs.existsSync(path.join(d, 'rate_card.csv'))) || path.join(process.cwd(), 'config')

const hasDb = () => !!(process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGUSER))
const problems = () => [
  !hasDb() && 'DATABASE_URL (or PGHOST, PGUSER, PGPASSWORD, PGDATABASE)',
  (!process.env.DEMO_PASS || process.env.DEMO_PASS === 'pass@123') && 'DEMO_PASS (your own password, not the default)',
  !process.env.DEMO_USER && 'DEMO_USER',
  (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) && 'SESSION_SECRET (at least 32 random characters)',
].filter(Boolean)

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

let ready   // the port of the private Express server, created on the first request and kept while this copy of the function stays warm
const boot = async () => {
  const { app } = await import('../../server/index.mjs')
  const server = http.createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

export default async (req) => {
  const missing = problems()
  if (missing.length) return json(503, { error: 'This site is not set up yet. In Netlify > Site configuration > Environment variables, add: ' + missing.join('; ') + '.' })
  try {
    ready ||= boot()
    const port = await ready
    const u = new URL(req.url)
    const headers = new Headers(req.headers)
    headers.set('x-forwarded-proto', u.protocol.replace(':', ''))   // the login cookie is marked Secure when the page came over https
    headers.delete('host')
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    const r = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: req.method, headers, body: hasBody ? Buffer.from(await req.arrayBuffer()) : undefined, redirect: 'manual' })
    const out = new Headers(r.headers)
    out.delete('transfer-encoding'); out.delete('content-encoding'); out.delete('content-length')   // the body below is already decoded and sized by Response
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out })
  } catch (e) {
    ready = undefined   // start again from scratch on the next request (for example when the database was briefly unreachable)
    console.error('[api]', e.message)
    return json(500, { error: e.message })
  }
}
