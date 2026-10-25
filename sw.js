/* Service worker: la app funciona sin conexión. Subí CACHE a v2, v3... cuando publiques cambios. */
const CACHE = 'insumos-v1';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'js/core.js', 'js/app.js',
  'vendor/bootstrap.min.css', 'vendor/fuse.min.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      const red = fetch(req).then(function (res) {
        if (res && res.ok) { const copia = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copia); }); }
        return res;
      }).catch(function () { return hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined); });
      return hit || red;
    })
  );
});
