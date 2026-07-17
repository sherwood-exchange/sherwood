// Sherwood PWA service worker: installable + offline app shell. Hashed build assets are
// cached immutably; stable-URL assets (token logos, icons, tokenlist) are network-first so
// updates propagate without a version bump. NEVER caches relayer/points/rpc API calls.
const CACHE = "sherwood-v3";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // cross-origin (e.g. direct RPC): pass through
  // API routes proxied on the same origin — never cache.
  if (url.pathname.startsWith("/relayer") || url.pathname.startsWith("/points") || url.pathname.startsWith("/rpc")) return;

  // App navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/index.html").then((r) => r || caches.match("/"))));
    return;
  }

  // Content-hashed build assets + circuit artifacts: cache-first (URL changes on update).
  if (/^\/(assets|circuits)\//.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Stable-URL static assets (token logos, app icons, tokenlist, fonts): network-first so a
  // changed file (e.g. a fixed logo) is picked up immediately; fall back to cache offline.
  if (/\.(png|jpg|jpeg|svg|mp4|webmanifest|woff2?)$/.test(url.pathname) || url.pathname === "/tokenlist.json") {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
