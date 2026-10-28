// Keeps the app's files on the phone so it opens instantly and works on bad event Wi-Fi.
// Each deploy stamps a new VERSION (see .github/workflows/scout-deploy.yml); the app
// then shows "Update ready" and switches over when the person taps it.
const VERSION = "__VERSION__";
const CACHE = `scout-${VERSION}`;
const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";
const FILES = [
  "./", "app.js", "fb.js", "board.js", "profile.js", "vendor/qrcode.js", "firebase-config.js", "style.css", "field.webp", "field-pushback.webp",
  "icon.svg", "icon-180.png", "icon-512.png", "manifest.webmanifest",
  "fonts/barlow-400.woff2", "fonts/barlow-500.woff2", "fonts/barlow-600.woff2", "fonts/barlow-sc-600.woff2", "fonts/barlow-sc-700.woff2",
  `${SDK}firebase-app.js`, `${SDK}firebase-auth.js`, `${SDK}firebase-firestore.js`,
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  // Don't take over until the person says so (the app shows an "Update ready" card).
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

// "Queue now" alerts from the sync job (Web Push). Tapping one opens the match in the app.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch { d = { title: e.data?.text() || "19109M Scout" }; }
  e.waitUntil(self.registration.showNotification(d.title || "19109M Scout", {
    body: d.body || "", tag: d.tag, renotify: true, requireInteraction: true, icon: "icon-180.png", badge: "icon-180.png",
    vibrate: [300, 120, 300, 120, 300], data: { url: d.url || "#/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(`./${e.notification.data?.url || "#/"}`, self.registration.scope).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = open[0];
    if (w) { await w.focus(); return w.navigate ? w.navigate(url).catch(() => w.postMessage({ go: url })) : w.postMessage({ go: url }); }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const ours = url.origin === location.origin;
  if (!ours && !req.url.startsWith(SDK)) return; // Firestore, auth and VEX Events go straight to the network
  if (ours && (url.pathname.startsWith("/__/") || url.pathname.endsWith("/sw.js"))) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Page loads: the network first, so the page always opens and is never a stale copy;
    // the saved app shell only when the network is down or slower than 3 seconds.
    if (req.mode === "navigate") {
      const net = fetch(req).then(res => {
        if (res.ok && !res.redirected) cache.put("./", res.clone());
        return res;
      });
      try {
        const res = await Promise.race([net, new Promise((_, no) => setTimeout(no, 3000))]);
        if (res.ok) return res;
      } catch {}
      const shell = await cache.match("./");
      return shell && !shell.redirected ? shell : net;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && ours) cache.put(req, res.clone());
    return res;
  })());
});
