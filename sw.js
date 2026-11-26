// Offline support for Krokly. Bump comes from the page hash, so each build refreshes the cache.
const CACHE = "krokly-b62e77c521";
const ASR_CACHE = "asr-46a227bcaf"; // модель розпізнавання: власний кеш, живе між оновленнями, міняється лише з моделлю
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/apple-touch-icon.png", "./icons/favicon-32.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./fonts/FixelDisplay-Bold.woff2", "./fonts/FixelDisplay-ExtraBold.woff2", "./fonts/FixelDisplay-SemiBold.woff2", "./fonts/FixelText-Bold.woff2", "./fonts/FixelText-ExtraBold.woff2", "./fonts/FixelText-Medium.woff2", "./fonts/FixelText-Regular.woff2", "./fonts/FixelText-SemiBold.woff2"];
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
// щоденне нагадування з asr-worker (push.js): показуємо, а дотик відкриває застосунок
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Krokly", { body: d.body || "Кілька хвилин англійської?", icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: "krokly-daily", data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
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
