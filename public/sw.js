/* Desk service worker - shell only.
 *
 *  - never touch /api (SSE + polling must always hit the network)
 *  - navigations: network first, fall back to the cached shell, then offline.html
 *  - static assets: network first, the cache only when offline (cache first
 *    showed the old icon after the rename until a second reload)
 *
 * Only registered on https or localhost: LAN http:// is not a secure context.
 */
// A new name drops every older cache once (activate below).
const VERSION = 'lamplit-v3';
const SHELL = [
  '/', '/index.html', '/manifest.json', '/offline.html',
  // The page's parts (ENG-04): without them the cached page is a blank shell.
  // (Only paths that load before pairing: one refused file and addAll keeps nothing.)
  '/app/theme.js', '/app/lang.js', '/app/style.css', '/app/diag.js',
  // The page script, split by feature (scripts/page-source.mjs MAIN_PARTS).
  '/app/main/01-core.js', '/app/main/02-avatars.js', '/app/main/03-groups.js', '/app/main/04-bots.js',
  '/app/main/05-chat.js', '/app/main/06-live.js', '/app/main/07-skills-routines.js', '/app/main/08-settings.js',
  '/app/main/09-apps.js', '/app/main/10-computer.js', '/app/main/11-machines.js', '/app/main/12-wiring.js', '/app/main/13-backup.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
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
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || Response.error()),
  );
});
