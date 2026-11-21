// 1.5.55: after an update the page always gets the new scripts and styles; the service worker only
// answers a navigation it cannot reach with the offline page. And status codes show in words.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import vm from 'node:vm';

/** Run public/sw.js against fake caches and a fake network. */
function loadWorker(src, { network = true } = {}) {
  const listeners = {};
  const stores = new Map([['lamplit-v3', new Map([['/app/main/01-core.js', 'old script']])]]);
  const store = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const caches = {
    open: async (name) => ({
      addAll: async (list) => { for (const u of list) store(name).set(u, `cached ${u}`); },
      put: async (req, res) => { store(name).set(typeof req === 'string' ? req : new URL(req.url).pathname, res); },
    }),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req) => { const p = typeof req === 'string' ? req : new URL(req.url).pathname; for (const s of stores.values()) if (s.has(p)) return s.get(p); return undefined; },
  };
  const fetched = [];
  const self = {
    location: new URL('http://127.0.0.1:4390/sw.js'),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const ctx = {
    self, caches, URL, Promise, Response: { error: () => 'error' },
    fetch: async (req) => { fetched.push(typeof req === 'string' ? req : req.url); if (!network) throw new TypeError('Failed to fetch'); return 'network'; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const fire = async (type, extra = {}) => {
    let waited = null;
    let answered;
    const ev = { ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { answered = p; } };
    listeners[type]?.(ev);
    if (waited) await waited;
    return answered === undefined ? undefined : await answered;
  };
  const request = (path, mode = 'cors', method = 'GET') => ({ request: { url: `http://127.0.0.1:4390${path}`, mode, method } });
  return { fire, request, stores, fetched };
}

export async function swChecks({ check, readText, rawFetch, base }) {
  const pkg = JSON.parse(await readText('../package.json'));
  const raw = await readText('../public/sw.js');
  const page = await readText('../public/index.html');
  const offline = `${await readText('../public/offline.html')}\n${await readText('../public/offline.js')}`;
  const server = await readText('../src/server.mjs');

  // --- the worker the server hands out carries the app's version
  const res = await rawFetch(`${base}/sw.js`);
  const served = await res.text();
  check('SW1 /sw.js comes with this version of Lamplit in its cache name (a new version is a new worker and drops the old cache); no-cache, so the browser always asks',
    res.ok && served.includes(`lamplit-${pkg.version}`) && !served.includes('__LAMPLIT_VERSION__') && raw.includes('__LAMPLIT_VERSION__')
    && /no-cache/.test(res.headers.get('cache-control') || ''), `${res.status} ${res.headers.get('cache-control')} ${served.slice(0, 0)}`);

  // --- install, activate, fetch
  {
    const w = loadWorker(served);
    await w.fire('install');
    const mine = w.stores.get(`lamplit-${pkg.version}`);
    const kept = mine ? [...mine.keys()] : [];
    await w.fire('activate');
    check('SW2 install keeps only what the offline page needs (offline.html, offline.js, the icon; no app scripts or styles); activate drops every older cache (the 1.5.54 「lamplit-v3」 with its old scripts)',
      kept.includes('/offline.html') && kept.includes('/offline.js') && !kept.some((k) => /^\/app\/|index\.html|^\/$/.test(k)) && !w.stores.has('lamplit-v3') && w.stores.has(`lamplit-${pkg.version}`), JSON.stringify(kept));
    const script = await w.fire('fetch', w.request('/app/main/01-core.js', 'no-cors'));
    const style = await w.fire('fetch', w.request('/app/style.css', 'no-cors'));
    const apiCall = await w.fire('fetch', w.request('/api/bots'));
    const stream = await w.fire('fetch', w.request('/api/stream?botId=chief'));
    const nav = await w.fire('fetch', w.request('/', 'navigate'));
    check('SW3 scripts, styles and every /api call are left to the network and the browser (the worker does not answer them, so it can never hand out an old copy); a page load goes to the network',
      script === undefined && style === undefined && apiCall === undefined && stream === undefined && nav === 'network', JSON.stringify({ script, style, apiCall, stream, nav }));
    const off = loadWorker(served, { network: false });
    await off.fire('install');
    const navOff = await off.fire('fetch', off.request('/', 'navigate'));
    const scriptOff = await off.fire('fetch', off.request('/app/main/01-core.js', 'no-cors'));
    const ownOff = await off.fire('fetch', off.request('/offline.js', 'no-cors'));
    const iconOff = await off.fire('fetch', off.request('/icons/icon-192.png', 'no-cors'));
    check('SW4 with no network a page load shows offline.html (never an old cached app page), with its own script and icon from the cache; an app script is still not answered from a cache',
      navOff === 'cached /offline.html' && ownOff === 'cached /offline.js' && iconOff === 'cached /icons/icon-192.png' && scriptOff === undefined, JSON.stringify({ navOff, ownOff, iconOff, scriptOff }));
  }

  // --- the offline page heals a worker that cannot reach the network; the page registers it with care
  check('SW5 offline.html asks the hub itself (/api/health, never through the worker); if the hub answers, the worker was the problem: it is removed, remembered, and the page loads again; it says Lamplit, not Desk',
    offline.includes("fetch('/api/health', { cache: 'no-store' })") && offline.includes("sessionStorage.getItem('lamplit.offlineBounce')") && offline.includes('getRegistrations()') && offline.includes("localStorage.setItem('lamplit.noSw'")
    && offline.includes('location.replace(') && !/Desk/.test(offline));
  check('SW6 the page registers the worker without the HTTP cache (updateViaCache: none), not where it failed before (lamplit.noSw), and reloads once when a new worker takes over a page an old one served',
    page.includes("navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })") && page.includes("localStorage.getItem('lamplit.noSw')")
    && page.includes("navigator.serviceWorker.addEventListener('controllerchange'") && page.includes("sessionStorage.getItem('lamplit.swReloaded')"));
  const A = await import('../src/auth.mjs');
  check('SW8 offline.js loads before pairing like offline.html (the worker caches it for a browser not yet paired)', A.isPublicShellPath('/offline.js') && A.isPublicShellPath('/offline.html') && A.isPublicShellPath('/sw.js'));
  check('SW7 the server fills the version into sw.js and sends it with no-cache; API answers are no-store',
    server.includes("relative === 'sw.js'") && server.includes("replaceAll('__LAMPLIT_VERSION__', VERSION") && server.includes("'cache-control': 'no-store',"));

  // --- status codes and notes in words (the approval-timeout card showed 「timeout」 and an English note)
  check('ST1 every status an approval or a run can end with has Chinese words (timeout, expired, dismissed, needs_approval, budget, error, stopped …); the English UI gets English from the dictionary',
    ['timeout: ', 'expired: ', 'dismissed: ', 'needs_approval: ', 'budget: ', 'error: ', 'stopped: ', 'stalled: ', 'needs_attention: '].every((k) => page.includes(`  ${k}'`) || page.includes(` ${k}'`))
    && page.includes('function statusWords(status)') && page.includes('return STATUS_WORDS[key] ||'));
  check('ST2 the notes Lamplit writes on a closed card come in words: 「no response within the approval window」, 「approval window expired after a restart」 are never shown raw; 备注 goes through the same words',
    page.includes(".replace(/\\bno response within the approval window\\b/gi,") && page.includes(".replace(/\\bapproval window expired after a restart\\b/gi,")
    && page.includes('`备注：${reasonLabel(data.note)}`') && page.includes('`备注：${reasonLabel(note)}`'));
  check('ST3 a card that timed out says so (「等太久没人点，这一步没做。」), not 「它已经收到「不要做」」',
    page.includes("data.decision === 'timeout' ? '等太久没人点，这一步没做。'"));
}
