// Caching proxy for the GeckoTerminal API. The free tier is ~30 req/min PER IP — and in
// production every user's chart request leaves from this VPS's IP, so raw proxying melts the
// quota instantly. This service makes the quota communal instead:
//   - in-memory TTL cache per URL (charts/stats are the same for every user)
//   - single-flight: concurrent requests for one URL share one upstream fetch
//   - paced upstream queue (one request per GAP_MS) so we never trip the limiter
//   - stale-while-error: on 429/5xx, serve the last good body (up to STALE_MS old)
// Zero dependencies (Node 22 global fetch).
import http from "node:http";

const UPSTREAM = process.env.GT_UPSTREAM || "https://api.geckoterminal.com";
const PORT = Number(process.env.PORT || 8796);
const GAP_MS = Number(process.env.GT_GAP_MS || 2100);   // ≈28/min worst case
const STALE_MS = Number(process.env.GT_STALE_MS || 60 * 60_000);

// TTLs by endpoint shape — charts move hourly, socials basically never.
function ttlFor(path) {
  if (path.includes("/ohlcv/")) return 90_000;
  if (path.includes("/trades")) return 45_000;
  if (path.includes("/info")) return 30 * 60_000;
  return 60_000; // pools / tokens / networks
}

const cache = new Map(); // url -> { t, status, body }  (only 200s are stored)
const inflight = new Map(); // url -> Promise<{status, body}>
const queue = [];
let pumping = false, last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchPaced(url) {
  let p = inflight.get(url);
  if (p) return p;
  p = new Promise((resolve) => { queue.push({ url, resolve }); pump(); });
  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  return p;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const wait = GAP_MS - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        let r = await fetch(UPSTREAM + job.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        for (let i = 0; i < 2 && r.status === 429; i++) { // brief in-place backoff
          await sleep(2500 * (i + 1));
          last = Date.now();
          r = await fetch(UPSTREAM + job.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        }
        job.resolve({ status: r.status, body: Buffer.from(await r.arrayBuffer()) });
      } catch {
        job.resolve({ status: 502, body: Buffer.from('{"error":"upstream unreachable"}') });
      }
    }
  } finally { pumping = false; }
}

// drop expired entries occasionally so memory stays bounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.t > STALE_MS) cache.delete(k);
}, 5 * 60_000).unref();

const HDR = { "content-type": "application/json", "access-control-allow-origin": "*" };

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200, HDR); return res.end('{"ok":true}'); }
  if (req.method !== "GET" || !req.url.startsWith("/api/v2/")) { res.writeHead(404, HDR); return res.end('{"error":"not found"}'); }

  const url = req.url;
  const ttl = ttlFor(url);
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.t < ttl) {
    res.writeHead(200, { ...HDR, "x-cache": "hit", age: String(Math.round((now - hit.t) / 1000)) });
    return res.end(hit.body);
  }

  const r = await fetchPaced(url);
  if (r.status === 200) {
    cache.set(url, { t: Date.now(), status: 200, body: r.body });
    res.writeHead(200, { ...HDR, "x-cache": "miss" });
    return res.end(r.body);
  }
  // upstream unhappy (usually 429) — a stale chart beats no chart
  if (hit && now - hit.t < STALE_MS) {
    res.writeHead(200, { ...HDR, "x-cache": "stale", age: String(Math.round((now - hit.t) / 1000)) });
    return res.end(hit.body);
  }
  res.writeHead(r.status, HDR);
  res.end(r.body);
});

server.listen(PORT, () => console.log(`gt-proxy → ${UPSTREAM} on :${PORT} (gap ${GAP_MS}ms)`));
