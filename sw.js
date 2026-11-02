// VYRA service worker: makes the app installable and lets the shell
// open instantly. Live stuff (websocket, /config) always goes to the network.
const CACHE = 'vyra-v2'; // new name: the activate step below deletes older caches (vyra-v1, gremlin-den-v1)
// Everything the first screen needs, so VYRA opens instantly. (Maskable + Apple icons are fetched by
// the phone itself at install time, so they are not preloaded here.)
const SHELL = ['/', '/style.css', '/app.js', '/auth.js', '/account.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/config' || url.pathname === '/healthz') return;

  // Network first (so updates show up right away), cached copy if offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
