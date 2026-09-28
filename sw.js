/* OCAYORK_PERSISTENT_MAP_CACHE
   Conserva todos los tiles visitados. No hay poda intencional por cantidad.
   Los tiles cacheados se muestran al instante y se revalidan en segundo plano. */
const CACHE = 'ocayork-map-v4-persistent';

async function fetchAndCache(cache, request) {
  const response = await fetch(new Request(request, { cache: 'no-cache' }));
  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.startsWith('image/')) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(name => name.startsWith('ocayork-map-') && name !== CACHE)
        .map(name => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname.toLowerCase();
  const isTile = path.endsWith('.webp') || path.includes('/tiles/');
  const isAsset = /\.(js|css|png|jpg|jpeg|svg|woff2?)$/.test(path);

  if (isTile) {
    const cachePromise = caches.open(CACHE);
    const cachedPromise = cachePromise.then(cache => cache.match(request));

    const revalidatePromise = Promise.all([cachePromise, cachedPromise])
      .then(async ([cache, cached]) => {
        if (!cached) return;
        try {
          await fetchAndCache(cache, request);
        } catch {
          // El tile cacheado sigue disponible aunque la red falle.
        }
      });

    event.waitUntil(revalidatePromise);

    event.respondWith(
      Promise.all([cachePromise, cachedPromise]).then(async ([cache, cached]) => {
        if (cached) return cached;
        return fetchAndCache(cache, request);
      })
    );
    return;
  }

  if (isAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
