// Cloudflare Worker: serves the built web app (dist/, via static assets) and runs the same Express API as server/index.mjs for /api/*.
// Secrets (set from .env with `wrangler secret bulk`): PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSL (or DATABASE_URL), AUTH_PGUSER, AUTH_PGPASSWORD (logins table, see server/auth.mjs), SESSION_SECRET, optional ALLOW_REVEAL.
import { env } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'

const PORT = 8080
const handler = httpServerHandler({ port: PORT })

const problems = () => [
  !(env.DATABASE_URL || (env.PGHOST && env.PGUSER)) && 'DATABASE_URL (or PGHOST, PGUSER, PGPASSWORD, PGDATABASE)',
  !(env.PGHOST && env.AUTH_PGUSER && env.AUTH_PGPASSWORD) && 'AUTH_PGUSER and AUTH_PGPASSWORD (the login database account)',
  (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) && 'SESSION_SECRET (at least 32 random characters)',
].filter(Boolean)

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

let ready
const boot = async () => {
  process.env.AQ_SERVERLESS = '1'
  process.env.AQ_WORKER = '1'
  process.env.AQ_CONFIG_DIR = '/bundle/config'
  for (const k of ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSL', 'AUTH_PGUSER', 'AUTH_PGPASSWORD', 'SESSION_SECRET', 'ALLOW_REVEAL']) if (env[k]) process.env[k] = env[k]
  process.env.ALLOW_REVEAL ||= 'true'
  const { app } = await import('../server/index.mjs')
  await new Promise((resolve, reject) => { const s = app.listen(PORT); s.once('listening', resolve); s.once('error', reject) })
}

export default {
  async fetch(request, workerEnv, ctx) {
    const missing = problems()
    if (missing.length) return json(503, { error: 'This site is not set up yet. Missing: ' + missing.join('; ') + '.' })
    try {
      ready ||= boot()
      await ready
    } catch (e) {
      ready = undefined
      console.error('[api boot]', e.message)
      return json(500, { error: e.message })
    }
    const u = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-proto', u.protocol.replace(':', ''))
    headers.set('x-nf-client-connection-ip', request.headers.get('cf-connecting-ip') || '')   // the trusted caller address the server reads in serverless mode
    return handler.fetch(new Request(request, { headers }), workerEnv, ctx)
  },
}
