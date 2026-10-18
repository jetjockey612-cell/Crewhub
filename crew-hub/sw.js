// Crew Hub service worker. Bump VERSION on every release so phones drop old copies.
const VERSION = '1.3.3';
const CACHE = 'crew-hub-' + VERSION;
const CORE = ['./', 'index.html', 'crew-tools.html', 'trip-coordination.html', 'fbo-fuel.html', 'oooi.html', 'hub-trips.js', 'hero.jpg',
  'pdf.min.js', 'pdf.worker.min.js', 'icon-180.png', 'icon-512.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('crew-hub-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'version') e.source.postMessage({ version: VERSION }); });

function networkFirst(req) {
  const cached = () => caches.match(req, { ignoreSearch: true });
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => cached().then(r => { if (r && !done) { done = true; resolve(r); } }), 3000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      cached().then(r => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(networkFirst(e.request));
});
