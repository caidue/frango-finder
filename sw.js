// Keeps the app shell available offline. Restaurant lookups always go to the
// network; only this site's own files are cached.
const CACHE = 'frango-shell-v3';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'chicken.jpeg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache straight away and refresh the copy in the background, so a
// new version shows up on the launch after next.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.url.split('?')[0]; // one cached copy per file, whatever the query
      const cached = await cache.match(key);
      // 'no-cache' makes the browser check with the server instead of trusting
      // its own HTTP cache, so a new version is picked up straight away.
      const fresh = fetch(key, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
