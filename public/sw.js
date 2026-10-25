const CACHE_VERSION = 'erp-static-v0.1.0-erp006';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './erp-mark.svg', './runtime-manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('erp-static-') && key !== CACHE_VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok || response.type === 'opaque') return response;
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)));
    return response;
  }).catch(() => request.mode === 'navigate' ? caches.match('./index.html') : undefined)));
});
