// GoFly Ops Worker.
// Serves the dashboard from ./public, plus two API routes:
//   GET  /api/wx           latest YBSU METAR and TAF from aviationweather.gov, cached for 2 minutes.
//   POST /api/login        team PIN + one of the named users -> a 12-hour session token.
//   POST /api/logout       ends that session.
//   GET/POST /api/sync     shared records in the D1 database (binding DB). Needs a session token.
//   POST /api/files        store a photo (defects); GET/DELETE /api/files/<id>. Needs a session token.
//   GET  /api/weekly-brief the weekly email (fuel, aircraft hours, forecasts). Needs the BRIEF_KEY
//                          header (Google Apps Script in tools/weekly-email.gs) or a session token.
// The PIN is the only lock (no Cloudflare Access), so:
//   - the PIN is never in this code: it's the Cloudflare secret GOFLY_PIN. If it isn't set, nobody
//     can sign in;
//   - wrong PINs are counted in D1: 8 from one address in 15 minutes, or 40 overall in an hour,
//     locks sign-in for a while;
//   - the PIN is only sent once; sync uses a random session token held in memory by the page.

const WX_SOURCE = 'https://aviationweather.gov/api/data';
const WX_TTL = 120; // seconds

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/wx') return weather(ctx);
    if (url.pathname === '/api/login') return login(request, env);
    if (url.pathname === '/api/logout') return logout(request, env);
    if (url.pathname === '/api/sync') return sync(request, env, url);
    if (url.pathname === '/api/files' || url.pathname.startsWith('/api/files/')) return files(request, env, url);
    if (url.pathname === '/api/weekly-brief') return weeklyBrief(request, env, url);
    return env.ASSETS.fetch(request);
  }
};

/* ---------- Shared records (D1) ----------
   One row per record: (coll, id) -> JSON data. Deletes are kept as tombstones (deleted = 1)
   so other devices learn about them. updated_at is server time in ms; clients ask for
   everything changed since their last sync.
   Changes are merged field by field: each change carries the copy the device last saw (base),
   and only the fields the device actually changed are written over the current record. So a
   device with an old copy can't put back old values for fields someone else has since changed.
   Pages that don't send base (older versions still open somewhere) are asked to reload. */
const SYNC_V = 2;
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
function mergeRecord(cur, base, data) {
  if (data == null) return null;                                   // delete
  if (!cur || !base || typeof cur !== 'object' || typeof base !== 'object') return data;
  const out = { ...cur };
  new Set([...Object.keys(base), ...Object.keys(data)]).forEach(k => {
    if (same(base[k], data[k])) return;                            // this device didn't change it
    if (k in data) out[k] = data[k]; else delete out[k];
  });
  return out;
}
const COLLS = new Set(['aircraft', 'maintenance', 'defects', 'fuelReadings', 'fuelOrders', 'fuelIssues', 'instructors', 'tasks', 'documents', 'settings']);
const MAX_CHANGES = 500, MAX_RECORD = 200000;
let schemaReady = false;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS records (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated_at INTEGER NOT NULL, updated_by TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (coll, id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS records_updated ON records (updated_at)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS login_fails (ip TEXT NOT NULL, at INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS login_fails_at ON login_fails (at)'),
    db.prepare('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, created_by TEXT)')
  ]);
  schemaReady = true;
}

/* ---------- Sign-in: shared PIN + name -> session ---------- */
const NAMES = ['Tom', 'Damien', 'Anne-Maree'];
const SESSION_MS = 12 * 3600e3;
const pause = ms => new Promise(r => setTimeout(r, ms));
function sameText(a, b) {  // compare without leaking how many characters matched
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
async function login(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.DB) return json({ error: 'Shared database not connected' }, 503);
  if (!env.GOFLY_PIN) return json({ error: 'The PIN hasn’t been set up in Cloudflare yet (secret GOFLY_PIN).', setup: true }, 503);
  await ensureSchema(env.DB);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
  const [mine, all] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ?1 AND at > ?2').bind(ip, now - 15 * 60e3),
    env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE at > ?1').bind(now - 3600e3)
  ]);
  if (mine.results[0].n >= 8 || all.results[0].n >= 40) { await pause(800); return json({ error: 'Too many wrong PINs. Sign-in is paused for 15 minutes.', locked: true }, 429); }
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
  if (!b || !NAMES.includes(b.name) || !sameText(String(b.pin || ''), String(env.GOFLY_PIN))) {
    await env.DB.prepare('INSERT INTO login_fails (ip, at) VALUES (?1, ?2)').bind(ip, now).run();
    await pause(800);
    return json({ error: 'Incorrect PIN' }, 401);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token, name, expires) VALUES (?1, ?2, ?3)').bind(token, b.name, now + SESSION_MS),
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(now),
    env.DB.prepare('DELETE FROM login_fails WHERE at < ?1').bind(now - 24 * 3600e3)
  ]);
  return json({ ok: true, name: b.name, token, expires: now + SESSION_MS });
}
const bearer = request => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
async function logout(request, env) {
  if (request.method !== 'POST' || !env.DB) return json({ ok: true });
  const t = bearer(request);
  if (t) { await ensureSchema(env.DB); await env.DB.prepare('DELETE FROM sessions WHERE token = ?1').bind(t).run(); }
  return json({ ok: true });
}

async function sessionUser(request, env) {
  const t = bearer(request);
  const ses = t && /^[0-9a-f]{64}$/.test(t) ? await env.DB.prepare('SELECT name, expires FROM sessions WHERE token = ?1').bind(t).first() : null;
  return ses && ses.expires >= Date.now() ? ses.name : null;
}

/* ---------- Photos (defects) ----------
   Stored in D1 as base64 text, already resized on the phone to roughly 100-400 KB.
   Only signed-in people can upload or view them. */
const MAX_PHOTO_B64 = 1500000; // about 1.1 MB of image
async function files(request, env, url) {
  if (!env.DB) return json({ error: 'Shared database not connected' }, 503);
  await ensureSchema(env.DB);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: 'Signed out. Sign in again.', expired: true }, 401);
  const id = url.pathname.slice('/api/files/'.length);
  if (request.method === 'POST' && url.pathname === '/api/files') {
    let b; try { b = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
    const type = String(b && b.type || '');
    const data = String(b && b.data || '');
    if (!/^image\/(jpeg|png|webp)$/.test(type) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({ error: 'Send a JPEG, PNG or WebP image' }, 400);
    if (data.length > MAX_PHOTO_B64) return json({ error: 'Photo too large' }, 413);
    const newId = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT INTO files (id, type, data, size, created, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(newId, type, data, Math.round(data.length * 3 / 4), Date.now(), user).run();
    return json({ id: newId });
  }
  if (!/^[0-9a-f]{24}$/.test(id)) return json({ error: 'Not found' }, 404);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT type, data FROM files WHERE id = ?1').bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': row.type, 'Cache-Control': 'private, max-age=86400' } });
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function sync(request, env, url) {
  if (!env.DB) return json({ error: 'Shared database not connected' }, 503);
  await ensureSchema(env.DB);
  const user = await sessionUser(request, env);
  if (!user) return json({ error: 'Signed out. Sign in again.', expired: true }, 401);
  // If Access token checking is switched on (ACCESS_TEAM_DOMAIN + ACCESS_AUD), require it too.
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && !(await identity(request, env))) return json({ error: 'Sign in through Cloudflare Access' }, 401);

  if (request.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const now = Date.now();
    const rows = await env.DB.prepare('SELECT coll, id, data, updated_at, updated_by, deleted FROM records WHERE updated_at > ?1').bind(since).all();
    return json({ now, user, records: (rows.results || []).map(r => ({ coll: r.coll, id: r.id, data: r.deleted ? null : r.data, updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: !!r.deleted })) });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
    if (!body || body.v !== SYNC_V) return json({ error: 'This page is out of date. Reload it to keep syncing.', reload: true }, 409);
    const changes = Array.isArray(body.changes) ? body.changes : null;
    if (!changes || changes.length > MAX_CHANGES) return json({ error: 'Send 1 to 500 changes' }, 400);
    for (const c of changes) {
      if (!c || !COLLS.has(c.coll) || typeof c.id !== 'string' || !c.id || c.id.length > 100) return json({ error: 'Bad change' }, 400);
    }
    // Current copies of the records being changed
    const cur = new Map();
    const sel = changes.map(c => env.DB.prepare('SELECT coll, id, data, deleted FROM records WHERE coll = ?1 AND id = ?2').bind(c.coll, c.id));
    for (let i = 0; i < sel.length; i += 50) {
      (await env.DB.batch(sel.slice(i, i + 50))).forEach(r => (r.results || []).forEach(row => {
        if (!row.deleted && row.data) { try { cur.set(row.coll + '/' + row.id, JSON.parse(row.data)); } catch (e) {} }
      }));
    }
    const now = Date.now(), stmts = [], merged = [];
    for (const c of changes) {
      const m = mergeRecord(cur.get(c.coll + '/' + c.id), c.base, c.data);
      const data = m == null ? null : JSON.stringify(m);
      if (data && data.length > MAX_RECORD) return json({ error: 'Record too large' }, 413);
      merged.push({ coll: c.coll, id: c.id, data });
      stmts.push(env.DB.prepare(
        'INSERT INTO records (coll, id, data, updated_at, updated_by, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
        'ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted'
      ).bind(c.coll, c.id, data, now, user, data == null ? 1 : 0));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ now, user, applied: stmts.length, merged });
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

async function weather(ctx) {
  const id = 'YBSU';  // only YBSU, so the public route can't be used to fetch other stations
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

/* ---------- Weekly email brief ----------
   GET /api/weekly-brief builds the weekly email from the shared records: the IOR fuel tank
   (level, average daily burn, order forecast) and each aircraft's hours, average hours a week
   and maintenance forecast. Two ways in:
   - The Google Apps Script in tools/weekly-email.gs (Tom's Gmail sends it). It sends the header
     X-Brief-Key, which must match the Cloudflare secret BRIEF_KEY (at least 24 characters).
     It asks every morning; "send" is true only on the day chosen in Data & settings, or with
     ?force=1 (the script's test).
   - A signed-in session (Bearer token): the preview in Data & settings.
   Example records are left out. The forecasts copy the dashboard's own (learnRate, fuelBurn,
   fuelForecast, hourItemFor and maintForecast in public/index.html): keep them in step. */
const TZ = 'Australia/Brisbane', DAY_MS = 864e5;
const AIRCRAFT_IDS = ['7788', '1675', '8582', '8515', '8514'];
const AC_AVAIL = { serviceable: 'Available', restricted: 'Available with restrictions', maintenance: 'In maintenance', unserviceable: 'Unserviceable' };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const bneToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayT = iso => Date.parse(iso + 'T00:00:00Z');
const addDays = (iso, n) => new Date(dayT(iso) + n * DAY_MS).toISOString().slice(0, 10);
const fmtDate = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const fmtWk = iso => `${new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short' }).format(new Date(iso + 'T00:00:00Z'))} ${fmtDate(iso)}`;
const fmtL = n => n == null || isNaN(n) ? '—' : Math.round(Number(n)).toLocaleString('en-AU') + ' L';
const fmtH = n => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseEmails = t => String(t || '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 30);

function learnRate(points, dir) {
  let wSum = 0, rSum = 0, n = 0, span = 0;
  const now = Date.now();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], days = (b.t - a.t) / DAY_MS;
    if (days <= 0) continue;
    const dv = (b.v - a.v) * dir;
    if (dv < 0) continue;
    const w = Math.pow(0.5, Math.max(0, now - b.t) / DAY_MS / 30) * Math.min(days, 14);
    rSum += w * dv / days; wSum += w; n++; span += days;
  }
  if (!n || !wSum) return null;
  return { rate: rSum / wSum, n, span, conf: n >= 3 && span >= 7 ? 'good' : 'early' };
}

async function loadShared(env) {
  const S = { settings: {}, aircraft: [], maintenance: [], fuelReadings: [], fuelOrders: [], instructors: [], documents: [], defects: [] };
  const rows = await env.DB.prepare("SELECT coll, data FROM records WHERE deleted = 0 AND coll IN ('settings', 'aircraft', 'maintenance', 'fuelReadings', 'fuelOrders', 'instructors', 'documents', 'defects')").all();
  (rows.results || []).forEach(r => {
    let d; try { d = JSON.parse(r.data); } catch (e) { return; }
    if (!d || d.example) return;
    if (r.coll === 'settings') S.settings = d; else S[r.coll].push(d);
  });
  S.settings = { hoursAmber: 50, fuelOrderAt: 1000, tankCapacity: 5000, fuelThreshold: 1500, weeklyEmailOn: 'yes', weeklyEmailDay: '1', weeklyEmailTo: '', weeklyEmailAhead: 14, ...S.settings };
  return S;
}

/* Due soon: instructor checks and expiries, aircraft registration and insurance, documents and
   dated maintenance, due within the look-ahead (default 14 days) or already overdue. Same rules
   as the page (spDue, renewDue, renewalName, instExpiries, acExpiries, documents, upcoming). */
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
function dueList(S, today, ahead) {
  const st = S.settings, out = [];
  const daysTo = iso => Math.round((dayT(iso) - dayT(today)) / DAY_MS);
  const add = (date, what, kind) => {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const d = daysTo(date); if (d <= ahead) out.push({ date, d, what, kind });
  };
  const senior = g => ['senior', 'supervising', 'dcfi', 'cfi'].includes(g);
  S.instructors.filter(p => !p.archived).forEach(p => {
    if (!['dcfi', 'cfi'].includes(p.grade)) {
      const sp = p.lastCheck ? (['senior', 'supervising'].includes(p.grade) ? addMonths(p.lastCheck, Number(st.cxSeniorMonths) || 6) : addDays(p.lastCheck, Number(st.spDays) || 90)) : (p.nextCheck || null);
      add(sp, `${p.name}: currency check`, 'Instructor');
    }
    const months = ['dcfi', 'cfi'].includes(p.grade) ? (Number(st.renewChiefMonths) || 24) : senior(p.grade) ? (Number(st.renewSeniorMonths) || 12) : (Number(st.renewJuniorMonths) || 24);
    add(p.renewalExpiry || (p.lastRenewal && p.grade ? addMonths(p.lastRenewal, months) : null), `${p.name}: ${senior(p.grade) ? 'SI flight review' : 'instructor renewal'}`, 'Instructor');
    [['raausExpiry', 'RAAus membership'], ['medicalExpiry', 'CASA medical'], ['firstAidExpiry', 'first aid'], ['cprExpiry', 'CPR']].forEach(([k, l]) => add(p[k], `${p.name}: ${l}`, 'Instructor'));
    (Array.isArray(p.quals) ? p.quals : []).forEach(q => add(q && q.expiry, `${p.name}: ${(q && q.label) || 'other expiry'}`, 'Instructor'));
  });
  S.aircraft.filter(a => !a.archived).forEach(a => {
    add(a.regoExpiry, `${a.ident} registration`, 'Aircraft');
    if (a.insuranceNA !== 'yes') add(a.insuranceExpiry, `${a.ident} insurance`, 'Aircraft');
  });
  const ident = id => (S.aircraft.find(a => a.id === id) || {}).ident || '';
  S.maintenance.filter(m => !m.archived && m.status !== 'done').forEach(m => add(m.dueDate, `${ident(m.aircraftId)} ${m.title || 'maintenance'}`.trim(), 'Maintenance'));
  S.documents.filter(d => !d.archived).forEach(d => add(d.date, `${d.title || 'Document'}${d.kind === 'expiry' ? ' expires' : ' review'}`, 'Document'));
  return out.sort((a, b) => a.d - b.d || a.what.localeCompare(b.what));
}
/* Not entered yet: information the dashboard flags as missing, grouped by instructor, aircraft
   or document, so gaps get filled. Same rules as the page (missing = mandatory and blank). */
function missingList(S) {
  const out = [], push = (who, items) => { if (items.length) out.push({ who, items }); };
  const senior = g => ['senior', 'supervising', 'dcfi', 'cfi'].includes(g);
  S.instructors.filter(p => !p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(p => {
    const m = [];
    if (!p.grade) m.push('instructor grade');
    if (!p.raausExpiry) m.push('RAAus membership expiry');
    if (!p.medicalExpiry) m.push('CASA medical expiry');
    if (!['dcfi', 'cfi'].includes(p.grade) && !p.lastCheck && !p.nextCheck) m.push('last currency check');
    if (p.grade && !p.renewalExpiry && !p.lastRenewal) m.push(senior(p.grade) ? 'last SI flight review' : 'last instructor renewal');
    push(p.name || 'Instructor', m);
  });
  const ord = a => { const i = AIRCRAFT_IDS.indexOf(a.ident); return i < 0 ? 99 : i; };
  S.aircraft.filter(a => !a.archived).sort((a, b) => ord(a) - ord(b)).forEach(a => {
    const m = [];
    if (!a.regoExpiry) m.push('registration expiry');
    if (a.insuranceNA !== 'yes' && !a.insuranceExpiry) m.push('insurance expiry');
    const open = S.maintenance.filter(x => x.aircraftId === a.id && !x.archived && x.status !== 'done');
    if (open.some(x => x.fixed === '100hr' && x.dueHours == null)) m.push('100-hourly due hours');
    const needs = new Set(open.filter(x => x.dueHours != null && ['engine', 'air'].includes(x.counter)).map(x => x.counter));
    if (needs.has('engine') && a.engineHours == null) m.push('engine hours');
    if (needs.has('air') && a.airTime == null) m.push('air time');
    push(a.ident, m);
  });
  S.documents.filter(d => !d.archived && !d.date).forEach(d => push(d.title || 'Document', [d.kind === 'expiry' ? 'expiry date' : 'next review date']));
  return out;
}
const STALE_DAYS = 7;   // flying aircraft whose hours haven't been updated for longer get a note

const SEV_NAME = { grounding: 'grounding', urgent: 'urgent', semi: 'semi-urgent', nil: 'nil effect' };

function briefData(S, today) {
  const st = S.settings, daysTo = iso => Math.round((dayT(iso) - dayT(today)) / DAY_MS);
  // Fuel
  const readings = S.fuelReadings.filter(r => !r.archived && r.date && r.litres != null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const latest = readings[readings.length - 1] || null;
  const byDay = new Map(); readings.forEach(r => byDay.set(r.date, Number(r.litres)));
  const pts = [...byDay].map(([d, v]) => ({ t: dayT(d), v }));
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], days = (b.t - a.t) / DAY_MS;
    if (days > 0 && b.v <= a.v) segs.push({ t0: a.t, t1: b.t, days, used: a.v - b.v });
  }
  const avg = from => {
    let used = 0, days = 0;
    segs.forEach(sg => { if (sg.t1 <= from) return; const f = (sg.t1 - Math.max(sg.t0, from)) / (sg.t1 - sg.t0); used += sg.used * f; days += sg.days * f; });
    return days >= 1 ? used / days : null;
  };
  const L = learnRate(pts, -1);
  let burn = null;
  if (segs.length) {
    const total = segs.reduce((x, s) => x + s.used, 0), totalDays = segs.reduce((x, s) => x + s.days, 0);
    burn = { learned: L ? L.rate : total / totalDays, early: !L || L.conf === 'early', d7: avg(dayT(today) - 7 * DAY_MS), d30: avg(dayT(today) - 30 * DAY_MS) };
  }
  let fc = null;
  if (latest && L && L.rate >= 1) {
    const target = Number(st.fuelOrderAt ?? 1000), since = Math.max(0, -daysTo(latest.date));
    const estNow = Math.max(0, latest.litres - L.rate * since);
    const orderDate = addDays(latest.date, Math.floor(Math.max(0, latest.litres - target) / L.rate));
    fc = { rate: L.rate, estNow, target, orderDate, dLeft: Math.max(0, daysTo(orderDate)), past: estNow <= target, daysOfFuel: Math.floor(estNow / L.rate) };
  }
  const order = S.fuelOrders.filter(o => !o.archived && !['delivered', 'cancelled', 'draft'].includes(o.status))
    .sort((a, b) => String(a.confirmedDate || a.requestedDate || '9').localeCompare(String(b.confirmedDate || b.requestedDate || '9')))[0] || null;
  const fuel = { latest, burn, fc, order, max: Number(st.tankCapacity) || 5000, reorder: Number(st.fuelThreshold) || 1500,
    low: !!(latest && latest.litres < Number(st.fuelThreshold)), readings: pts.length };

  // Aircraft
  const amber = Number(st.hoursAmber ?? 50);
  const ord = a => { const i = AIRCRAFT_IDS.indexOf(a.ident); return i < 0 ? 99 : i; };
  const aircraft = S.aircraft.filter(a => !a.archived).sort((a, b) => ord(a) - ord(b) || String(a.ident).localeCompare(String(b.ident))).map(ac => {
    const cv = c => c === 'air' ? ac.airTime : c === 'engine' ? ac.engineHours : null;
    const items = S.maintenance.filter(m => m.aircraftId === ac.id && !m.archived && m.status !== 'done' && m.counter !== 'none' && m.dueHours != null)
      .map(m => { const cur = cv(m.counter); return { m, rem: cur == null ? null : Math.round((m.dueHours - cur) * 10) / 10 }; })
      .filter(x => x.rem != null).sort((a, b) => a.rem - b.rem);
    const next = items[0] || null;
    const fixedNoHours = !next && S.maintenance.some(m => m.aircraftId === ac.id && m.fixed === '100hr' && !m.archived);
    const key = next && next.m.counter === 'air' ? 'a' : 'e';
    const log = (Array.isArray(ac.hoursLog) ? ac.hoursLog : []).filter(x => x && x.d && x[key] != null).sort((a, b) => a.d.localeCompare(b.d));
    const R = learnRate(log.map(x => ({ t: dayT(x.d), v: Number(x[key]) })), 1);
    const perWeek = R && R.rate >= 0.01 ? R.rate * 7 : null;
    let f = null;
    if (next && perWeek) {
      const since = log.length ? Math.max(0, -daysTo(log[log.length - 1].d)) : 0;
      const remNow = next.rem - R.rate * since;
      f = { remNow, dueDate: addDays(today, Math.max(0, Math.round(remNow / R.rate))), bookDate: addDays(today, Math.max(0, Math.round((remNow - amber) / R.rate))), bookNow: remNow <= amber };
    }
    const allLog = (Array.isArray(ac.hoursLog) ? ac.hoursLog : []).filter(x => x && x.d && (x.e != null || x.a != null)).map(x => x.d).sort();
    const lastAny = allLog.length ? allLog[allLog.length - 1] : null;
    const flying = !ac.status || ['serviceable', 'restricted'].includes(ac.status);
    const stale = flying && (ac.engineHours != null || ac.airTime != null || next) ? (lastAny ? Math.max(0, -daysTo(lastAny)) : -1) : 0;
    return { ident: ac.ident, type: ac.type || '', status: AC_AVAIL[ac.status] || '', engine: ac.engineHours ?? null, air: ac.airTime ?? null,
      staleDays: stale === -1 || stale > STALE_DAYS ? stale : 0, lastAny,
      updated: log.length ? log[log.length - 1].d : null, fixedNoHours, perWeek, perWeekKey: key, early: !R || R.conf === 'early', next, f,
      booked: !!(next && ['booked', 'progress'].includes(next.m.status)), bookingDate: next ? next.m.bookingDate || null : null,
      defects: S.defects.filter(d => d.aircraftId === ac.id && !d.archived && d.status !== 'closed') };
  });
  const ahead = Math.max(1, Math.min(60, Number(st.weeklyEmailAhead) || 14));
  return { today, fuel, aircraft, amber, red: Number(st.hoursRed ?? 20), ahead, due: dueList(S, today, ahead), missing: missingList(S) };
}

function briefEmail(B) {
  const O = '#F15A26', INK = '#111111', MUT = '#666666', LINE = '#e4e4e4';
  const pill = (txt, bg, fg) => `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:700">${escH(txt)}</span>`;
  const red = t => pill(t, '#fde8e8', '#b42318'), amb = t => pill(t, '#fdeee6', '#b54708'), grn = t => pill(t, '#e7f6ec', '#1b7a3d'), gry = t => pill(t, '#f0f0f0', '#555555');
  const h2 = t => `<h2 style="margin:26px 0 10px;font:800 italic 18px/1.2 Arial,Helvetica,sans-serif;text-transform:uppercase;letter-spacing:.02em;color:${INK};border-bottom:2px solid ${O};padding-bottom:6px">${escH(t)}</h2>`;
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:${MUT};font-size:14px;vertical-align:top;white-space:nowrap">${escH(k)}</td><td style="padding:6px 0;font-size:14px;color:${INK}">${v}</td></tr>`;
  const T = [], F = B.fuel;
  const title = `GoFly weekly brief · ${fmtWk(B.today)}`;
  T.push(title, '');

  // Due soon (and overdue)
  let dueH = h2(`Overdue and due in the next ${B.ahead} days`);
  T.push(`OVERDUE AND DUE IN THE NEXT ${B.ahead} DAYS`);
  if (!B.due.length) { dueH += `<p style="font-size:14px;color:${MUT};margin:0">Nothing due: no instructor checks, expiries, documents or dated maintenance in the next ${B.ahead} days.</p>`; T.push('Nothing due.'); }
  else {
    dueH += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${B.due.map(x => {
      const when = x.d < 0 ? red(`Overdue ${plural(-x.d, 'day')}`) : x.d === 0 ? red('Today') : x.d <= 7 ? amb(`In ${plural(x.d, 'day')}`) : gry(`In ${plural(x.d, 'day')}`);
      return `<tr><td style="padding:7px 10px 7px 0;border-bottom:1px solid ${LINE};font-size:14px;white-space:nowrap;vertical-align:top;color:${INK}">${escH(fmtWk(x.date))}</td>
        <td style="padding:7px 10px 7px 0;border-bottom:1px solid ${LINE};font-size:14px;vertical-align:top;color:${INK}">${escH(x.what)}<br><span style="font-size:12px;color:${MUT}">${escH(x.kind)}</span></td>
        <td style="padding:7px 0;border-bottom:1px solid ${LINE};text-align:right;vertical-align:top;white-space:nowrap">${when}</td></tr>`;
    }).join('')}</table>`;
    B.due.forEach(x => T.push(`${fmtWk(x.date)}  ${x.what} (${x.kind}) · ${x.d < 0 ? 'OVERDUE ' + plural(-x.d, 'day') : x.d === 0 ? 'today' : 'in ' + plural(x.d, 'day')}`));
  }
  T.push('');

  // Fuel
  let fuelH = h2('IOR fuel tank');
  T.push('IOR FUEL TANK');
  if (!F.latest) { fuelH += `<p style="color:${MUT};font-size:14px">No fuel readings logged yet.</p>`; T.push('No fuel readings logged yet.'); }
  else {
    const pct = Math.round(F.latest.litres / F.max * 100);
    fuelH += `<p style="margin:0 0 4px;font:700 34px/1.1 Arial,Helvetica,sans-serif;color:${INK}">${escH(fmtL(F.latest.litres))} <span style="font-size:14px;font-weight:400;color:${MUT}">${pct}% of ${escH(fmtL(F.max))} max</span></p>
      <p style="margin:0 0 10px;font-size:13px;color:${MUT}">Last reading ${escH(fmtWk(F.latest.date))}${F.latest.updatedBy ? ' by ' + escH(F.latest.updatedBy) : ''} ${F.low ? red('Low stock') : grn('Above reorder level')}</p>`;
    T.push(`Level: ${fmtL(F.latest.litres)} (${pct}% of ${fmtL(F.max)}), read ${fmtWk(F.latest.date)}${F.low ? ' · LOW STOCK' : ''}`);
    const rows = [];
    if (F.burn) {
      rows.push(row('Average daily use', `<b>~${escH(fmtL(F.burn.learned))} a day</b> (last 7 days ${escH(F.burn.d7 == null ? '—' : fmtL(F.burn.d7))}, last 30 days ${escH(F.burn.d30 == null ? '—' : fmtL(F.burn.d30))})${F.burn.early ? ' <span style="color:#666">early estimate</span>' : ''}`));
      T.push(`Average daily use: ~${fmtL(F.burn.learned)} a day (7 days ${F.burn.d7 == null ? '—' : fmtL(F.burn.d7)}, 30 days ${F.burn.d30 == null ? '—' : fmtL(F.burn.d30)})`);
    } else { rows.push(row('Average daily use', 'Needs at least two readings a few days apart')); T.push('Average daily use: needs at least two readings a few days apart'); }
    if (F.fc) {
      rows.push(row('Estimated now', `~${escH(fmtL(F.fc.estNow))}, about ${escH(plural(F.fc.daysOfFuel, 'day'))} of fuel at this rate`));
      const w = F.order && (F.order.confirmedDate || F.order.requestedDate);
      const atArr = w ? F.fc.estNow - F.fc.rate * Math.max(0, Math.round((dayT(w) - dayT(B.today)) / DAY_MS)) : null;
      const o = F.order ? (w ? (atArr > 0 ? `Already ordered: about ${fmtL(atArr)} left when it arrives ${fmtWk(w)}` : `Already ordered, but the tank may run low before it arrives ${fmtWk(w)}`) : 'Already ordered')
        : F.fc.past ? `Now: already at or below ${fmtL(F.fc.target)}` : `Around ${fmtWk(F.fc.orderDate)} (in ${plural(F.fc.dLeft, 'day')}), when it reaches about ${fmtL(F.fc.target)}`;
      rows.push(row('Order fuel', escH(o)));
      T.push(`Estimated now: ~${fmtL(F.fc.estNow)}, about ${plural(F.fc.daysOfFuel, 'day')} of fuel`, `Order fuel: ${o}`);
    }
    if (F.order) {
      const w = F.order.confirmedDate || F.order.requestedDate;
      const txt = `${fmtL(F.order.litres)} ${F.order.status === 'confirmed' || F.order.confirmedDate ? 'confirmed' : 'ordered'}${w ? ' for ' + fmtWk(w) : ''}`;
      rows.push(row('Open order', escH(txt))); T.push('Open order: ' + txt);
    }
    fuelH += `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`;
  }
  T.push('');

  // Aircraft
  let acH = h2('Aircraft hours and maintenance');
  T.push('AIRCRAFT HOURS AND MAINTENANCE');
  const fleetWk = B.aircraft.reduce((s, a) => s + (a.perWeekKey === 'e' && a.perWeek ? a.perWeek : 0), 0);
  B.aircraft.forEach(a => {
    const cnt = a.next ? (a.next.m.counter === 'air' ? 'air time' : 'engine hours') : 'engine hours';
    let st = '', stT = '';
    if (!a.next) { stT = a.fixedNoHours ? '100-hourly due hours not entered' : 'No hour-based item entered'; st = gry(stT); }
    else {
      const r1 = a.next.rem;      // from the last hours entered, same as the dashboard
      st = r1 < 0 ? red(`${fmtH(-r1)} hrs overdue`) : r1 <= B.red ? red(`${fmtH(r1)} hrs left`) : r1 <= B.amber ? amb(`${fmtH(r1)} hrs left`) : grn(`${fmtH(r1)} hrs left`);
      stT = r1 < 0 ? `${fmtH(-r1)} hrs overdue` : `${fmtH(r1)} hrs left`;
    }
    const est = a.f && Math.abs(a.f.remNow - a.next.rem) >= 0.1 ? `About ${a.f.remNow < 0 ? fmtH(-a.f.remNow) + ' hrs over' : fmtH(a.f.remNow) + ' hrs left'} by now (estimate). ` : '';
    const dueTxt = a.f && a.f.remNow <= 0 ? 'Past its due hours' : a.f ? `Due around ${fmtWk(a.f.dueDate)}` : '';
    const fcTxt = !a.next ? '' : !a.f ? 'Forecast: needs more hours updates' : est + (a.booked ? `${dueTxt} · already ${a.next.m.status === 'progress' ? 'in progress' : 'booked'}${a.bookingDate ? ' (' + fmtDate(a.bookingDate) + ')' : ''}`
      : a.f.bookNow ? `${dueTxt} · book now` : `${dueTxt} · book by ${fmtWk(a.f.bookDate)}`);
    acH += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${LINE};border-left:4px solid ${O};border-radius:8px;margin:0 0 10px">
      <tr><td style="padding:10px 12px">
        <div style="font:800 italic 20px/1.1 Arial,Helvetica,sans-serif;color:${INK}">${escH(a.ident)} <span style="font:400 13px Arial,Helvetica,sans-serif;color:${MUT}">${escH([a.type, a.status].filter(Boolean).join(' · '))}</span></div>
        <div style="font-size:14px;color:${INK};margin-top:6px">Engine hours <b>${escH(fmtH(a.engine))}</b> · Air time <b>${escH(fmtH(a.air))}</b>${a.updated ? ` <span style="color:${MUT}">(updated ${escH(fmtDate(a.updated))})</span>` : ''}</div>
        ${a.staleDays ? `<div style="margin-top:6px">${amb(a.staleDays < 0 ? 'Hours not updated in the dashboard yet' : `Hours not updated for ${plural(a.staleDays, 'day')}`)} <span style="font-size:13px;color:${MUT}">Update them so the forecast stays accurate.</span></div>` : ''}
        <div style="font-size:14px;color:${INK};margin-top:4px">Average <b>${a.perWeek ? '~' + escH(fmtH(a.perWeek)) + ' hrs a week' : '—'}</b> <span style="color:${MUT}">${a.perWeek ? escH(a.perWeekKey === 'a' ? 'air time' : 'engine hours') + (a.early ? ', early estimate' : '') : 'needs more hours updates'}</span></div>
        <div style="font-size:14px;color:${INK};margin-top:4px">${a.next ? `${escH(a.next.m.title || 'Maintenance')} <span style="color:${MUT}">(${escH(cnt)}, due at ${escH(fmtH(a.next.m.dueHours))})</span> ` : ''}${st}</div>
        ${fcTxt ? `<div style="font-size:13px;color:${MUT};margin-top:4px">${escH(fcTxt)}</div>` : ''}
        ${a.defects.length ? `<div style="font-size:14px;color:${INK};margin-top:6px">Open defects: ${a.defects.map(d => `${d.severity === 'grounding' || d.severity === 'urgent' ? red(SEV_NAME[d.severity]) : d.severity === 'semi' ? amb(SEV_NAME[d.severity]) : gry(SEV_NAME[d.severity] || 'severity not set')} ${escH(String(d.description || '').slice(0, 80))}`).join('<br>')}</div>` : ''}
      </td></tr></table>`;
    T.push(`${a.ident}${a.status ? ' (' + a.status + ')' : ''}: engine ${fmtH(a.engine)}, air time ${fmtH(a.air)}${a.updated ? ', updated ' + fmtDate(a.updated) : ''}`,
      `  Average: ${a.perWeek ? '~' + fmtH(a.perWeek) + ' hrs a week' : 'needs more hours updates'}`,
      a.next ? `  ${a.next.m.title || 'Maintenance'} (${cnt}, due at ${fmtH(a.next.m.dueHours)}): ${stT}` : `  ${stT}`);
    if (fcTxt) T.push('  ' + fcTxt);
    if (a.staleDays) T.push(`  ${a.staleDays < 0 ? 'Hours not updated in the dashboard yet' : 'Hours not updated for ' + plural(a.staleDays, 'day')}: update them so the forecast stays accurate.`);
    a.defects.forEach(d => T.push(`  Open defect (${SEV_NAME[d.severity] || 'severity not set'}): ${String(d.description || '').slice(0, 80)}`));
  });
  if (fleetWk) { acH += `<p style="font-size:13px;color:${MUT};margin:4px 0 0">Fleet total ~${escH(fmtH(fleetWk))} engine hours a week.</p>`; T.push(`Fleet total ~${fmtH(fleetWk)} engine hours a week.`); }
  let misH = '';
  if (B.missing.length) {
    misH = h2('Not entered yet');
    misH += `<p style="font-size:13px;color:${MUT};margin:0 0 8px">Add these in the dashboard so nothing is missed.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${B.missing.map(x =>
      `<tr><td style="padding:6px 10px 6px 0;border-bottom:1px dashed ${LINE};font-size:14px;font-weight:700;vertical-align:top;white-space:nowrap;color:${INK}">${escH(x.who)}</td><td style="padding:6px 0;border-bottom:1px dashed ${LINE};font-size:14px;color:${INK}">${escH(x.items.join(', '))}</td></tr>`).join('')}</table>`;
    T.push('', 'NOT ENTERED YET');
    B.missing.forEach(x => T.push(`${x.who}: ${x.items.join(', ')}`));
  }
  const foot = `Forecasts are a guide only, learned from the fuel readings and hours updates logged in the dashboard. They are not a maintenance release or a requirement. Hours left are from the last hours update; the estimate allows for average use since then. Built from the GoFly Operations Dashboard on ${fmtDate(B.today)}.`;
  T.push('', foot);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#000000;padding:16px 20px"><span style="font:800 italic 22px/1 Arial,Helvetica,sans-serif;color:${O}">GOFLY</span> <span style="font:700 italic 14px/1 Arial,Helvetica,sans-serif;color:#ffffff;letter-spacing:.12em;text-transform:uppercase;margin-left:6px">Operations · Weekly brief</span>
<div style="color:#bbbbbb;font-size:13px;margin-top:6px">${escH(fmtWk(B.today))}</div></td></tr>
<tr><td style="padding:4px 20px 20px">${dueH}${fuelH}${acH}${misH}<p style="font-size:12px;line-height:1.5;color:${MUT};margin:22px 0 0;border-top:1px solid ${LINE};padding-top:10px">${escH(foot)}</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: title, html, text: T.join('\n') };
}

async function weeklyBrief(request, env, url) {
  if (!env.DB) return json({ error: 'Shared database not connected' }, 503);
  await ensureSchema(env.DB);
  const key = request.headers.get('X-Brief-Key');
  if (key != null) {
    if (!env.BRIEF_KEY || String(env.BRIEF_KEY).length < 24) return json({ error: 'Weekly email isn’t set up: add the Cloudflare secret BRIEF_KEY (at least 24 characters).' }, 503);
    if (!sameText(key, String(env.BRIEF_KEY))) { await pause(800); return json({ error: 'Wrong key' }, 401); }
  } else if (!(await sessionUser(request, env))) return json({ error: 'Signed out. Sign in again.', expired: true }, 401);
  const S = await loadShared(env), today = bneToday();
  const to = parseEmails(S.settings.weeklyEmailTo), day = Number(S.settings.weeklyEmailDay ?? 1);
  const isDay = new Date(today + 'T00:00:00Z').getUTCDay() === day, on = S.settings.weeklyEmailOn !== 'no';
  const force = url.searchParams.get('force') === '1';
  const send = to.length > 0 && (force || (on && isDay));
  const reason = !to.length ? 'No email addresses entered in Data & settings' : !on ? 'Weekly email is turned off in Data & settings'
    : !isDay ? `Sends on ${DAY_NAMES[day] || 'the chosen day'}` : 'Sending today';
  return json({ ok: true, date: today, send, reason, to, day: DAY_NAMES[day] || '', ...briefEmail(briefData(S, today)) });
}
