/* Offline shell for ± money.
 *
 * The app itself is cache-first so it opens instantly and works with no
 * signal. Two things must NEVER be served from cache, because a stale answer
 * is worse than no answer: the Google Sheets API (your live money data) and
 * the price feeds behind the screener (a cached quote would silently size a
 * position off yesterday's number). Those are network-only here.
 */
const CACHE_NAME = 'pm-money-v1';
const PRECACHE = ['./', './index.html', './manifest.json'];

const NETWORK_ONLY = [
  /^https:\/\/sheets\.googleapis\.com\//,
  /^https:\/\/accounts\.google\.com\//,
  /^https:\/\/oauth2\.googleapis\.com\//,
  /^https:\/\/query1\.finance\.yahoo\.com\//,
  /^https:\/\/r\.jina\.ai\//,
  /^https:\/\/api\.allorigins\.win\//,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (NETWORK_ONLY.some((re) => re.test(url))) return; // let the network handle it, or fail honestly

  event.respondWith(
    caches.match(event.request).then((hit) =>
      hit ||
      fetch(event.request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    )
  );
});
