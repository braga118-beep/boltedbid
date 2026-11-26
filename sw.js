// BoltedBid service worker: makes BoltedBid installable and lets the app open even with a weak signal.
// Your own files are always fetched fresh when online (so updates show right away);
// the saved copy is only used when there's no connection.
const CACHE = 'boltedbid-v17';
const SHELL = ['./', './index.html', './app.html', './team.html', './team.webmanifest', './team-ios.webmanifest', './guard.js', './landing.js', './team.js', './app.js', './render.js', './data.js', './importer.js', './contract.js', './styles.css', './config.js', './plans.js', './manifest.webmanifest', './icons/icon-192.png', './vendor/supabase-2.45.4.js', './vendor/html2canvas-1.4.1.min.js', './vendor/jspdf-2.5.1.umd.min.js', './vendor/jszip-3.10.1.min.js'];
const LIBS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', (e) => {
  // Each file is saved as a plain copy, so it still works when the host shortens addresses (app.html to /app).
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.blob().then((b) => c.put(u, new Response(b, { status: 200, headers: { 'Content-Type': r.headers.get('Content-Type') || '' } }))) : null))
    .catch(() => null)))).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Libraries and fonts never change at a given version: use the saved copy first.
  if (LIBS.test(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  // Everything else from other sites (your database, photos) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // Opening a page: let the browser handle it, so moved addresses (like a new domain) forward
  // normally. The saved app only opens when there's no connection.
  if (req.mode === 'navigate') {
    const page = url.pathname.endsWith('/') ? url.pathname + 'index.html' : /\.[a-z]+$/i.test(url.pathname) ? url.pathname : url.pathname + '.html';
    e.respondWith(fetch(req).catch(() => caches.match(page).then((hit) => hit || caches.match('./app.html'))));
    return;
  }

  // The app's own files: always ask the server for the newest version, fall back to the saved copy offline.
  e.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((res) => {
        if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname + url.search, copy)); }
        return res;
      })
      .catch(() => caches.match(url.pathname + url.search).then((hit) => hit || caches.match(req, { ignoreSearch: true })).then((hit) => hit || Response.error()))
  );
});
