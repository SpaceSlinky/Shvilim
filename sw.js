/* Service Worker: שומר את האפליקציה, הספריות והגופנים לשימוש אופליין.
   נתוני המפה עצמם נשמרים ב-IndexedDB (ראו app.js).
   קבצי האפליקציה: מוגשים מהמטמון ומתעדכנים ברקע. ספריות וגופנים מ-CDN: מהמטמון בלבד אחרי הפעם הראשונה. */
const CACHE = 'shvilim-v60';
const SHELL = ['./', 'index.html', 'style.css', 'geo.js', 'osm.js', 'router.js', 'elev.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/noto-sans-hebrew-hebrew.woff2', 'fonts/noto-sans-hebrew-latin.woff2', 'fonts/noto-sans-hebrew-latin-ext.woff2'];
const CDN = [
  'https://unpkg.com/maplibre-gl@5.15.0/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@5.15.0/dist/maplibre-gl.js',
  'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js',
];
const CDN_HOSTS = ['unpkg.com', 'protomaps.github.io', 's3.amazonaws.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(CDN.map((u) => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: sameOrigin });
    if (hit && !sameOrigin) return hit; // קבצי CDN עם גרסה קבועה – אין צורך לעדכן
    const update = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(update); return hit; }
    const res = await update;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  })());
});
