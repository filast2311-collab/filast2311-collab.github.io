// Offline support for Krokly. Bump comes from the page hash, so each build refreshes the cache.
const CACHE = "krokly-e2cfca1cc6";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/apple-touch-icon.png", "./icons/favicon-32.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./fonts/onest-cyrillic-400-normal.woff2", "./fonts/onest-cyrillic-500-normal.woff2", "./fonts/onest-cyrillic-600-normal.woff2", "./fonts/onest-cyrillic-700-normal.woff2", "./fonts/onest-latin-400-normal.woff2", "./fonts/onest-latin-500-normal.woff2", "./fonts/onest-latin-600-normal.woff2", "./fonts/onest-latin-700-normal.woff2", "./fonts/onest-latin-ext-400-normal.woff2", "./fonts/onest-latin-ext-500-normal.woff2", "./fonts/onest-latin-ext-600-normal.woff2", "./fonts/onest-latin-ext-700-normal.woff2", "./fonts/unbounded-cyrillic-600-normal.woff2", "./fonts/unbounded-cyrillic-800-normal.woff2", "./fonts/unbounded-latin-600-normal.woff2", "./fonts/unbounded-latin-800-normal.woff2", "./fonts/unbounded-latin-ext-600-normal.woff2", "./fonts/unbounded-latin-ext-800-normal.woff2"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("krokly-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // fresh page when online, cached page when offline
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return res; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  if (req.headers.has("range")) return;
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
