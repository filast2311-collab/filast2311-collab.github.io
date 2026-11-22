// Offline support for Krokly. Bump comes from the page hash, so each build refreshes the cache.
const CACHE = "krokly-69f0b820c7";
const ASR_CACHE = "asr-46a227bcaf"; // модель розпізнавання: власний кеш, живе між оновленнями, міняється лише з моделлю
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/apple-touch-icon.png", "./icons/favicon-32.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./fonts/manrope-cyrillic-400-normal.woff2", "./fonts/manrope-cyrillic-500-normal.woff2", "./fonts/manrope-cyrillic-600-normal.woff2", "./fonts/manrope-cyrillic-700-normal.woff2", "./fonts/manrope-cyrillic-800-normal.woff2", "./fonts/manrope-latin-400-normal.woff2", "./fonts/manrope-latin-500-normal.woff2", "./fonts/manrope-latin-600-normal.woff2", "./fonts/manrope-latin-700-normal.woff2", "./fonts/manrope-latin-800-normal.woff2", "./fonts/manrope-latin-ext-400-normal.woff2", "./fonts/manrope-latin-ext-500-normal.woff2", "./fonts/manrope-latin-ext-600-normal.woff2", "./fonts/manrope-latin-ext-700-normal.woff2", "./fonts/manrope-latin-ext-800-normal.woff2", "./fonts/montserrat-alternates-cyrillic-600-normal.woff2", "./fonts/montserrat-alternates-cyrillic-700-normal.woff2", "./fonts/montserrat-alternates-cyrillic-800-normal.woff2", "./fonts/montserrat-alternates-latin-600-normal.woff2", "./fonts/montserrat-alternates-latin-700-normal.woff2", "./fonts/montserrat-alternates-latin-800-normal.woff2", "./fonts/montserrat-alternates-latin-ext-600-normal.woff2", "./fonts/montserrat-alternates-latin-ext-700-normal.woff2", "./fonts/montserrat-alternates-latin-ext-800-normal.woff2"];
// Ізоляція сторінки (COOP/COEP). GitHub Pages таких заголовків не ставить, тож їх додає service worker.
// З ними браузер дає SharedArrayBuffer, і розпізнавання мовлення на телефоні рахує кількома потоками, а не одним.
// Сторінка нічого не вбудовує з інших сайтів, тож require-corp нічого не ламає.
function iso(res) {
  if (!res || !res.status || res.type === "opaque" || res.type === "opaqueredirect") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener("install", e => {
  // cache: "reload" — не брати сторінку з HTTP-кешу браузера (GitHub Pages дає max-age=600)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith("krokly-") && k !== CACHE) || (k.startsWith("asr-") && k !== ASR_CACHE)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/version.json")) return; // always straight from the network
  if (req.mode === "navigate") {
    // fresh page when online (no-cache: always revalidate, so an update shows on the next open), cached page when offline;
    // only the app page itself is kept as the offline copy (a reminder .ics also arrives as a navigation)
    e.respondWith(fetch(req.url, { cache: "no-cache" }).then(res => {
      if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); }
      return res;
    })
      .catch(() => caches.match("./index.html")).then(iso));
    return;
  }
  if (req.headers.has("range")) return;
  if (url.pathname.includes("/asr/") && !url.pathname.endsWith("/worker.js")) {
    e.respondWith(caches.open(ASR_CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.status === 200) c.put(req, res.clone());
      return res;
    }))).then(iso));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })).then(iso));
});
