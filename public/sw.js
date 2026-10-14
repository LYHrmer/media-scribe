const CACHE = 'tingxie-static-v0.5.0';
function usableAsset(response) {
  // Static hosts and security checks can return an HTML page at an asset URL.
  // Never retain that page as JavaScript, CSS, an image, or the WASM runtime.
  return response?.ok && !/(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') || '');
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith('tingxie-static-') && key !== CACHE) await caches.delete(key);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.protocol !== 'https:') return;
  // User files are decoded from local ArrayBuffers, never fetched or cached here.
  if (!request.mode.includes('navigate') && !/\.(?:js|css|mjs|wasm|svg|ico)$/.test(url.pathname)) return;
  event.respondWith((async () => {
    let cache;
    try { cache = await caches.open(CACHE); } catch { return fetch(request); }
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request);
        if (response.ok) {
          try { await cache.put(request, response.clone()); } catch { /* Storage is optional. */ }
        }
        return response;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    }
    const cached = await cache.match(request);
    if (usableAsset(cached)) return cached;
    if (cached) {
      try { await cache.delete(request); } catch { /* Storage is optional. */ }
    }
    const response = await fetch(request);
    if (usableAsset(response)) {
      try { await cache.put(request, response.clone()); } catch { /* Quota does not block recognition. */ }
    }
    return response;
  })());
});
