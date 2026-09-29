/* OCAYORK_PERSISTENT_MAP_CACHE_V5
   Los tiles y los assets usan caches separados.
   Los tiles visitados no se borran cuando cambia la version de la app.
   Un tile cacheado se muestra al instante y se revalida en segundo plano. */
const TILE_CACHE = 'ocayork-tiles-v1';
const ASSET_CACHE = 'ocayork-assets-v2';

async function fetchFresh(request) {
  return fetch(new Request(request, { cache: 'no-cache' }));
}

async function fetchAndCacheTile(cache, request) {
  const response = await fetchFresh(request);
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

    // Solo eliminamos caches viejos de assets. Nunca hacemos poda automatica
    // de caches de tiles, incluidos los de versiones anteriores.
    await Promise.all(
      names
        .filter(name => name.startsWith('ocayork-assets-') && name !== ASSET_CACHE)
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
    event.respondWith((async () => {
      const tileCache = await caches.open(TILE_CACHE);

      // caches.match tambien encuentra tiles guardados por versiones antiguas
      // del Service Worker, evitando que el usuario pierda lo ya recorrido.
      const cached = await caches.match(request);

      if (cached) {
        if (!(await tileCache.match(request))) {
          event.waitUntil(tileCache.put(request, cached.clone()));
        }

        event.waitUntil(
          fetchAndCacheTile(tileCache, request).catch(() => null)
        );

        return cached;
      }

      return fetchAndCacheTile(tileCache, request);
    })());
    return;
  }

  if (isAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
