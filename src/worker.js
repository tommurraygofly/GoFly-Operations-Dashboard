// GoFly Ops Worker.
// Serves the dashboard from ./public, plus two API routes:
//   GET /api/wx?ids=YBSU   latest METAR and TAF from aviationweather.gov, cached for 2 minutes.
//   GET/POST /api/sync     shared records in the D1 database (binding DB), so everyone sees the same data.
// The whole site sits behind Cloudflare Access. /api/sync only accepts requests that carry an
// Access identity, and records each change against the signed-in email.

const WX_SOURCE = 'https://aviationweather.gov/api/data';
const WX_TTL = 120; // seconds

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/wx') return weather(url, ctx);
    if (url.pathname === '/api/sync') return sync(request, env, url);
    return env.ASSETS.fetch(request);
  }
};

/* ---------- Shared records (D1) ----------
   One row per record: (coll, id) -> JSON data. Deletes are kept as tombstones (deleted = 1)
   so other devices learn about them. updated_at is server time in ms; clients ask for
   everything changed since their last sync. Last write wins per record. */
const COLLS = new Set(['aircraft', 'maintenance', 'defects', 'fuelReadings', 'fuelOrders', 'fuelIssues', 'instructors', 'tasks', 'settings']);
const MAX_CHANGES = 500, MAX_RECORD = 200000;
let schemaReady = false;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS records (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at INTEGER NOT NULL, updated_by TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (coll, id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS records_updated ON records (updated_at)')
  ]);
  schemaReady = true;
}

async function sync(request, env, url) {
  if (!env.DB) return json({ error: 'Shared database not connected' }, 503);
  const user = await identity(request, env);
  if (!user) return json({ error: 'Sign in through Cloudflare Access' }, 401);
  await ensureSchema(env.DB);

  if (request.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const now = Date.now();
    const rows = await env.DB.prepare('SELECT coll, id, data, updated_at, updated_by, deleted FROM records WHERE updated_at > ?1').bind(since).all();
    return json({ now, user, records: (rows.results || []).map(r => ({ coll: r.coll, id: r.id, data: r.deleted ? null : r.data, updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: !!r.deleted })) });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
    const changes = Array.isArray(body && body.changes) ? body.changes : null;
    if (!changes || changes.length > MAX_CHANGES) return json({ error: 'Send 1 to 500 changes' }, 400);
    const now = Date.now(), stmts = [];
    for (const c of changes) {
      if (!c || !COLLS.has(c.coll) || typeof c.id !== 'string' || !c.id || c.id.length > 100) return json({ error: 'Bad change' }, 400);
      const data = c.data == null ? null : JSON.stringify(c.data);
      if (data && data.length > MAX_RECORD) return json({ error: 'Record too large' }, 413);
      stmts.push(env.DB.prepare(
        'INSERT INTO records (coll, id, data, updated_at, updated_by, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
        'ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted'
      ).bind(c.coll, c.id, data, now, user, data == null ? 1 : 0));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ now, user, applied: stmts.length });
  }
  return json({ error: 'Method not allowed' }, 405);
}

/* Who is signed in. Cloudflare Access adds a signed token (Cf-Access-Jwt-Assertion) to every
   request it lets through. If ACCESS_TEAM_DOMAIN (e.g. gofly.cloudflareaccess.com) and ACCESS_AUD
   (the application's Audience tag) are set as Worker variables, the token's signature is checked
   too; otherwise the Worker relies on Access sitting in front of the site. */
async function identity(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(b64text(parts[0])); payload = JSON.parse(b64text(parts[1])); } catch (e) { return null; }
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!(await verifySignature(parts, header, env.ACCESS_TEAM_DOMAIN))) return null;
  }
  return String(payload.email || request.headers.get('Cf-Access-Authenticated-User-Email') || '').toLowerCase() || null;
}
const b64bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const b64text = s => new TextDecoder().decode(b64bytes(s));
let certCache = { at: 0, keys: [] };
async function verifySignature(parts, header, team) {
  if (Date.now() - certCache.at > 3600e3) {
    const r = await fetch(`https://${team.replace(/^https?:\/\//, '').replace(/\/$/, '')}/cdn-cgi/access/certs`);
    if (!r.ok) return false;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
}

async function getJSON(path) {
  const res = await fetch(`${WX_SOURCE}/${path}`, {
    headers: { 'User-Agent': 'GoFly-Ops-Dashboard', Accept: 'application/json' },
    cf: { cacheTtl: WX_TTL, cacheEverything: true }
  });
  if (res.status === 204) return [];          // no data for this station right now
  if (!res.ok) throw new Error(`aviationweather.gov returned ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

async function weather(url, ctx) {
  const id = (url.searchParams.get('ids') || 'YBSU').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'YBSU';
  const cache = caches.default;
  const key = new Request(`https://gofly-ops.cache/wx/${id}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let body, status = 200;
  try {
    const [metars, tafs] = await Promise.all([
      getJSON(`metar?ids=${id}&format=json&hours=3`),
      getJSON(`taf?ids=${id}&format=json`)
    ]);
    // Newest first
    metars.sort((a, b) => (b.obsTime || 0) - (a.obsTime || 0));
    tafs.sort((a, b) => String(b.issueTime || '').localeCompare(String(a.issueTime || '')));
    body = { id, source: 'aviationweather.gov', fetchedAt: new Date().toISOString(), metar: metars[0] || null, taf: tafs[0] || null };
  } catch (e) {
    status = 502;
    body = { id, error: String(e && e.message || e), fetchedAt: new Date().toISOString() };
  }
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `private, max-age=${status === 200 ? WX_TTL : 0}` }
  });
  if (status === 200) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${WX_TTL}` } })));
  return res;
}
