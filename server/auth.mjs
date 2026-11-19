// Logins kept in the database: table dashboard_auth.users (user name + password hash). Nothing else in the database is touched.
// The site connects with its own login (AUTH_PGUSER / AUTH_PGPASSWORD) that can only READ that table and UPDATE a password. It cannot add or remove accounts:
// that is done by hand by the database owner. Same host, port, database and SSL setting as the data connection (PGHOST ...).
// Without AUTH_PGUSER (running on your own computer) the old single login from DEMO_USER / DEMO_PASS is used instead.
import crypto from 'node:crypto'

const ITER = 100_000
export const authInDb = () => !!(process.env.AUTH_PGUSER && process.env.AUTH_PGPASSWORD && process.env.PGHOST)

async function q(sql, args) {
  const pg = (await import('pg')).default
  const e = process.env
  const c = new pg.Client({ host: e.PGHOST, port: Number(e.PGPORT || 5432), database: e.PGDATABASE || 'postgres', user: e.AUTH_PGUSER, password: e.AUTH_PGPASSWORD, ssl: e.PGSSL === 'disable' ? false : { rejectUnauthorized: false } })
  await c.connect()
  try { return (await c.query(sql, args)).rows } finally { c.end().catch(() => {}) }
}

export const getUser = async (username) => (await q('select username, password_hash from dashboard_auth.users where username = $1', [username]))[0] || null
export const setPassword = async (username, password) => {
  const rows = await q('update dashboard_auth.users set password_hash = $2, updated_at = now() where username = $1 returning username', [username, hashPassword(password)])
  if (!rows.length) throw new Error('Account not found.')
}

/** pbkdf2$sha256$<iterations>$<salt>$<hash> */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  return ['pbkdf2', 'sha256', ITER, salt.toString('base64'), crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256').toString('base64')].join('$')
}
export function checkPassword(password, stored) {
  const [kind, digest, iter, salt, hash] = String(stored || '').split('$')
  if (kind !== 'pbkdf2' || digest !== 'sha256') return false
  const want = Buffer.from(hash, 'base64')
  const got = crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'base64'), Number(iter), want.length, 'sha256')
  return want.length > 0 && crypto.timingSafeEqual(want, got)
}
/** short fingerprint of the stored hash: it goes into the session cookie, so a password change ends that user's other sessions */
export const stampOf = (stored) => crypto.createHash('sha256').update(String(stored)).digest('hex').slice(0, 16)
