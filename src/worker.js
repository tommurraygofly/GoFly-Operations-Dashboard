// GoFly Ops Worker.
// Serves the dashboard from ./public, plus one small API route:
//   GET /api/wx?ids=YBSU  ->  latest METAR and TAF from aviationweather.gov, cached for 2 minutes.
// Fetching on the server avoids browser cross-site (CORS) limits and keeps the request rate low.
// The whole site, including this route, sits behind Cloudflare Access.

const WX_SOURCE = 'https://aviationweather.gov/api/data';
const WX_TTL = 120; // seconds

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/wx') return weather(url, ctx);
    return env.ASSETS.fetch(request);
  }
};

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
