/* Lamplit service worker - the offline page only (1.5.55).
 *
 * Up to 1.5.54 it answered every script and style "network first, the cache when
 * offline", under one cache name ('lamplit-v3') that never changed with the app.
 * Where its own fetches failed (an embedded browser, a flaky phone link) it handed
 * out whatever it had cached - an older version's scripts next to the new page.
 *
 * Now:
 *  - it answers page loads (navigations) only: the network, or offline.html when
 *    the network is not there. It never serves an app page, script or style from
 *    a cache, so after an update the browser always fetches the new files (the
 *    server sends them with no-cache and an ETag).
 *  - /api (requests, the event stream) is never touched.
 *  - the cache name carries the app's version (the server fills it in), so a new
 *    version is a new worker, and activating it drops every older cache.
 *  - offline.html checks the hub directly; if the hub answers, this worker was the
 *    problem: the page removes it and loads again (see offline.html).
 *
 * Only registered on https or localhost: LAN http:// is not a secure context.
 */
const VERSION = 'lamplit-__LAMPLIT_VERSION__';
const OFFLINE = ['/offline.html', '/offline.js', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(OFFLINE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Page loads, and the offline page's own few files. Every other script, style,
  // image and every /api call goes to the network as if there were no worker:
  // nothing of the app can be old.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()));
  } else if (OFFLINE.includes(url.pathname)) {
    event.respondWith(fetch(req).catch(async () => (await caches.match(url.pathname)) || Response.error()));
  }
});
