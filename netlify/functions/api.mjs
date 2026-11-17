// Netlify Function: runs the same Express app as server/index.mjs, for every /api/* request (netlify.toml sends /api/* here).
// Netlify serves the built web app (dist/) by itself. This function holds the login and the database connection.
//
// A public site must not start with the demo defaults or without the database, so the function refuses to answer (503 + a plain message) until Netlify has:
//   DATABASE_URL (or PGHOST + PGUSER + PGPASSWORD + PGDATABASE)   a READ-ONLY login (dashboard_ro)
//   DEMO_USER, DEMO_PASS     your own login for the site (the defaults are public in the repo, so the default password is refused)
//   SESSION_SECRET           any long random text (each function copy must sign the login cookie the same way)
// Phone numbers and message text can only be revealed if you also set ALLOW_REVEAL=true; it is off here by default.
import serverless from 'serverless-http'

process.env.AQ_SERVERLESS = '1'
process.env.AQ_CONFIG_DIR ||= `${process.env.LAMBDA_TASK_ROOT || process.cwd()}/config`   // netlify.toml ships config/ next to the function
process.env.ALLOW_REVEAL ||= 'false'

const hasDb = () => !!(process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGUSER))
const problems = () => [
  !hasDb() && 'DATABASE_URL (or PGHOST, PGUSER, PGPASSWORD, PGDATABASE)',
  (!process.env.DEMO_PASS || process.env.DEMO_PASS === 'pass@123') && 'DEMO_PASS (your own password, not the default)',
  !process.env.DEMO_USER && 'DEMO_USER',
  (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) && 'SESSION_SECRET (at least 32 random characters)',
].filter(Boolean)

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) })

// serverless-http puts the raw body (a Buffer) on req.body and its fake request cannot be read as a stream, so Express's own body parsers never see it (the login would always fail).
// Express's parsers skip a body that is already there, so decode it here the way they would: JSON for /api/login, text for /api/report/pdf.
const decodeBody = (req) => {
  const raw = req.body, type = String(req.headers['content-type'] || '')
  if (!Buffer.isBuffer(raw)) return
  if (/^application\/json/i.test(type)) { try { req.body = JSON.parse(raw.toString('utf8')) } catch { req.body = {} } }
  else if (/^text\//i.test(type)) req.body = raw.toString('utf8')
  else delete req.body
}

let ready   // the app is created on the first request and kept while this copy of the function stays warm
export const handler = async (event, context) => {
  const missing = problems()
  if (missing.length) return json(503, { error: 'This site is not set up yet. In Netlify > Site configuration > Environment variables, add: ' + missing.join('; ') + '.' })
  try {
    ready ||= import('../../server/index.mjs').then((m) => serverless(m.app, { request: decodeBody }))
    // Netlify can hand over either the original address (/api/x) or the function address (/.netlify/functions/api/x): make it /api/x either way
    let p = String(event.path || '/').replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '')
    if (!p.startsWith('/api')) p = '/api' + (p.startsWith('/') ? p : '/' + p)
    return await (await ready)({ ...event, path: p }, context)
  } catch (e) {
    ready = undefined   // try again from scratch on the next request (for example when the database was briefly unreachable)
    console.error('[api]', e.message)
    return json(500, { error: e.message })
  }
}
