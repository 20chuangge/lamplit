/* launcher.js — the Desk mobile shell (launchpad).
 *
 * Job: remember which Desk hub this phone talks to, check that it answers, and
 * then open the hub's own UI at the top level of the WebView.
 *
 * Two decisions worth knowing about:
 *
 * 1. Top-level navigation, not an iframe. The hub authenticates a phone with an
 *    HttpOnly SameSite=Lax cookie (`desk_session`, set by POST /api/pair). A
 *    cross-site iframe never sends that cookie (the top-level site would be
 *    `localhost`, the frame `192.168.x.x`), so the UI inside a frame would sit
 *    on its pairing screen forever. A top-level navigation is first-party: same
 *    cookie rules as the desktop browser, and the hub needs no CORS support.
 *
 * 2. No token in Preferences. The session token is HttpOnly — page script can
 *    never read it, and the hub sends no CORS headers, so this launchpad cannot
 *    hold it either. What it stores is the hub URL; the hub's own pairing screen
 *    owns the credential. Typing the pairing code here just deep-links to
 *    `/?pair=CODE`, which the hub's UI consumes first-party.
 *
 * No bundler, no imports: native Capacitor injects `window.Capacitor.Plugins`,
 * and a plain-browser preview of www/ falls back to localStorage.
 */
(() => {
  'use strict';

  // home (1.5.44): the machine the app opens into, in 「全部机器」 - the last one
  // picked from this list, not one a page opened by name (those are 「只看这台」).
  const KEYS = { hub: 'desk.hubUrl', hubs: 'desk.hubs', home: 'desk.homeHub', bot: 'desk.botId', tokenFor: (hub) => `desk.token:${hub}` };
  const PROBE_TIMEOUT_MS = 4500;
  const LONG_PRESS_MS = 550;

  const $ = (id) => document.getElementById(id);
  const dom = {
    screens: {
      connect: $('connect'),
      connected: $('connected'),
      booting: $('booting'),
      offline: $('offline'),
    },
    connectForm: $('connect-form'),
    connectError: $('connect-error'),
    connectBtn: $('connect-btn'),
    hubUrl: $('hub-url'),
    hubCode: $('hub-code'),
    pasteBtn: $('paste-btn'),
    scanBtn: $('scan-btn'),
    previewBtn: $('preview-btn'),
    machines: $('machines'),
    connectBack: $('connect-back'),
    machineList: $('machine-list'),
    currentHub: $('current-hub'),
    currentStatus: $('current-status'),
    shellVersion: $('shell-version'),
    openBtn: $('open-btn'),
    changeBtn: $('change-btn'),
    forgetBtn: $('forget-btn'),
    bootingText: $('booting-text'),
    bootingUrl: $('booting-url'),
    bootingCancel: $('booting-cancel'),
    offlineDetail: $('offline-detail'),
    offlineUrl: $('offline-url'),
    offlineRetry: $('offline-retry'),
    offlineChange: $('offline-change'),
    foot: $('foot'),
  };

  // ---------------------------------------------------------------- platform
  const cap = window.Capacitor || null;
  const plugins = (cap && cap.Plugins) || {};
  const prefs = plugins.Preferences || null;
  const app = plugins.App || null;
  const scanner = plugins.BarcodeScanner || null;
  const isNative = Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  /** @capacitor/preferences on device, localStorage when previewing in a browser. */
  const rawStore = {
    async get(key) {
      if (prefs) {
        try {
          const res = await prefs.get({ key });
          if (res && typeof res.value === 'string') return res.value;
        } catch (err) {
          console.warn('[desk] Preferences.get failed, falling back', err);
        }
      }
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (prefs) {
        try {
          await prefs.set({ key, value });
          return;
        } catch (err) {
          console.warn('[desk] Preferences.set failed, falling back', err);
        }
      }
      try {
        window.localStorage.setItem(key, value);
      } catch (err) {
        console.warn('[desk] localStorage unavailable', err);
      }
    },
    async remove(key) {
      if (prefs) {
        try {
          await prefs.remove({ key });
        } catch (err) {
          console.warn('[desk] Preferences.remove failed', err);
        }
      }
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  /*
   * Device tokens are kept sealed with the phone's Keystore (SEC-16): the app's
   * files hold "tb1:..." instead of a usable token. The native bridge seals and
   * opens them, for this page only. A plain token from before is sealed the
   * first time it is read. In a browser preview (no bridge) nothing changes.
   */
  const isTokenKey = (key) => String(key).startsWith('desk.token:');
  const tokenBox = () => (window.NightshiftShell && typeof window.NightshiftShell.sealToken === 'function' ? window.NightshiftShell : null);
  const store = {
    async get(key) {
      const value = await rawStore.get(key);
      if (!isTokenKey(key) || !value) return value;
      if (value.startsWith('tb1:')) {
        if (!tokenBox()) return null;
        return window.NightshiftShell.openToken(value) || null;
      }
      if (tokenBox()) {
        const sealed = window.NightshiftShell.sealToken(value);
        if (sealed && sealed.startsWith('tb1:')) await rawStore.set(key, sealed);
      }
      return value;
    },
    async set(key, value) {
      if (isTokenKey(key) && value && tokenBox()) {
        const sealed = window.NightshiftShell.sealToken(value);
        // Sealing not possible on this phone: keep it as before rather than lose the pairing.
        if (sealed && sealed.startsWith('tb1:')) return rawStore.set(key, sealed);
      }
      return rawStore.set(key, value);
    },
    remove: (key) => rawStore.remove(key),
  };

  /*
   * At start, seal every token still kept as plain text, including ones for
   * addresses no longer in the machine list (they are never read, so sealing
   * on first read would leave them plain forever). Each is checked to open
   * back to the same token before it replaces the plain one.
   */
  async function sealPlainTokens() {
    if (!tokenBox() || !prefs || typeof prefs.keys !== 'function') return 0;
    let keys = [];
    try {
      const res = await prefs.keys();
      keys = (res && Array.isArray(res.keys)) ? res.keys : [];
    } catch (err) {
      console.warn('[desk] Preferences.keys failed', err);
      return 0;
    }
    let sealedCount = 0;
    for (const key of keys.filter(isTokenKey)) {
      const value = await rawStore.get(key);
      if (!value || value.startsWith('tb1:')) continue;
      const sealed = window.NightshiftShell.sealToken(value);
      if (!sealed || !sealed.startsWith('tb1:') || window.NightshiftShell.openToken(sealed) !== value) continue;
      await rawStore.set(key, sealed);
      sealedCount += 1;
    }
    return sealedCount;
  }

  // ------------------------------------------------------------------- state
  const state = {
    view: 'connect',
    hub: '',
    info: null,
    probeId: 0,
  };

  function show(view) {
    state.view = view;
    for (const [name, node] of Object.entries(dom.screens)) node.hidden = name !== view;
  }

  function setError(message) {
    if (!message) {
      dom.connectError.textContent = '';
      dom.connectError.classList.remove('show');
      return;
    }
    dom.connectError.textContent = message;
    dom.connectError.classList.add('show');
  }

  // ------------------------------------------------------------------- utils
  /** "192.168.1.23:4390" -> "http://192.168.1.23:4390"; validates scheme + path. */
  function normalizeHub(raw) {
    let text = String(raw || '').trim();
    if (!text) throw new Error('先填 Hub 地址。');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`"${raw}" 不是合法地址。示例：http://192.168.1.23:4390`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只支持 http:// 或 https:// 的 Hub。');
    }
    if (!url.hostname) throw new Error('这个地址里没有主机名。');

    // The Desk UI calls absolute paths (`/api/health`, `/api/stream`, ...), so a
    // hub behind a path prefix cannot work. Fail loudly rather than half-work.
    if (url.pathname.replace(/\/+$/, '')) {
      throw new Error('请填 Hub 根地址、不要带路径，例如 http://192.168.1.23:4390');
    }
    return url.origin;
  }

  function hubUrlFor(hub, code) {
    if (!code) return `${hub}/`;
    return `${hub}/?pair=${encodeURIComponent(String(code).replace(/\s+/g, ''))}`;
  }

  // ---------------------------------------------------------- saved machines
  /** This phone only stores hub URLs; the credential stays in the hub's cookie. */
  function hostLabel(hub) {
    try {
      return new URL(hub).host;
    } catch {
      return hub;
    }
  }

  async function readHubs() {
    try {
      const raw = JSON.parse((await store.get(KEYS.hubs)) || '[]');
      if (Array.isArray(raw)) {
        const list = raw.filter((h) => h && typeof h.url === 'string');
        if (list.length) return list;
      }
    } catch {
      /* corrupt list: fall through to the single-hub key */
    }
    // Older installs (and the very first pairing) only have one hub URL.
    const single = await store.get(KEYS.hub);
    return single ? [{ url: single, name: hostLabel(single) }] : [];
  }

  async function rememberHub(hub, alt) {
    const all = await readHubs();
    // Keep what the row already knows (its name, its other address, the hub it came from).
    const old = all.find((h) => h.url === hub) || {};
    const hubs = all.filter((h) => h.url !== hub);
    const row = { ...old, url: hub, name: old.name || hostLabel(hub), lastUsedAt: new Date().toISOString() };
    if (Array.isArray(alt) && alt.length) row.alt = [...new Set([...(old.alt || []), ...alt])].filter((u) => u !== hub);
    hubs.unshift(row);
    await store.set(KEYS.hubs, JSON.stringify(hubs.slice(0, 12)));
    await store.set(KEYS.hub, hub);
  }

  /** Rename a remembered hub in place (the hub told us its hostname). */
  async function rememberHubNamed(hub, name) {
    const hubs = await readHubs();
    const next = hubs.map((h) => (h.url === hub ? { ...h, name } : h));
    await store.set(KEYS.hubs, JSON.stringify(next));
  }

  /**
   * One row per machine, from the rows alone: rows that share any address are
   * the same machine. Seen: a row saved from a pairing code (its main address
   * the public https one, the others in alt) next to a row another hub taught
   * us; and a row left behind when a computer's LAN address changed. The row
   * with a login (the most recently used one) stays and takes every address;
   * `via` follows a folded address to the row that now holds it.
   * -> {list, moves: [[fromUrl, toUrl]]}: logins to carry over to the kept row.
   */
  function foldRows(rows, hasToken) {
    const addrs = (h) => [h.url, ...(h.alt || [])];
    const groups = [];
    rows.forEach((row, i) => {
      const mine = new Set(addrs(row));
      const hit = groups.filter((g) => g.some((j) => addrs(rows[j]).some((u) => mine.has(u))));
      if (!hit.length) { groups.push([i]); return; }
      hit[0].push(i);
      for (const g of hit.slice(1)) { hit[0].push(...g); g.length = 0; }
    });
    const keptFor = new Map();
    const out = [];
    const moves = [];
    for (const g of groups.filter((x) => x.length).sort((a, b) => Math.min(...a) - Math.min(...b))) {
      const members = g.slice().sort((a, b) => a - b).map((i) => ({ row: rows[i], token: Boolean(hasToken[i]) }));
      const rank = (m) => (m.token ? 2 : 0) + (m.row.lastUsedAt ? 1 : 0);
      let keep = members[0];
      for (const m of members) {
        if (rank(m) > rank(keep) || (rank(m) === rank(keep) && String(m.row.lastUsedAt || '') > String(keep.row.lastUsedAt || ''))) keep = m;
      }
      const all = [...new Set(members.flatMap((m) => addrs(m.row)))];
      const row = { ...keep.row, alt: all.filter((u) => u !== keep.row.url) };
      if (!row.name) row.name = members.map((m) => m.row.name).find(Boolean) || row.name;
      if (!keep.token) {
        const donor = members.find((m) => m.token);
        if (donor) moves.push([donor.row.url, row.url]);
      }
      all.forEach((u) => keptFor.set(u, row.url));
      out.push(row);
    }
    for (const row of out) {
      if (!row.via) continue;
      const to = keptFor.get(row.via);
      if (to === row.url) { delete row.via; delete row.viaName; } else if (to) row.via = to;
    }
    return { list: out, moves };
  }

  async function foldDuplicateRows() {
    // The prototype app saved a relay-only code's placeholder (…relay.invalid) as
    // a machine that is never online: drop it, and it from any row's addresses.
    const dead = (u) => { try { return /\.relay\.invalid$/i.test(new URL(u).hostname); } catch { return false; } };
    const stored = await readHubs();
    const rows = stored.filter((h) => !dead(h.url)).map((h) => (h.alt?.some(dead) ? { ...h, alt: h.alt.filter((u) => !dead(u)) } : h));
    const hasToken = await Promise.all(rows.map((h) => store.get(KEYS.tokenFor(h.url)).then(Boolean).catch(() => false)));
    const { list, moves } = foldRows(rows, hasToken);
    for (const [from, to] of moves) {
      const token = await store.get(KEYS.tokenFor(from)).catch(() => null);
      if (token) await store.set(KEYS.tokenFor(to), token);
    }
    if (JSON.stringify(list) !== JSON.stringify(stored)) await store.set(KEYS.hubs, JSON.stringify(list.slice(0, 12)));
  }

  /**
   * A machine's public https address (Funnel) is not in the hub's list: keep it.
   * A hub older than 1.2.94 lists itself without its Tailscale address: when
   * the list has none, keep the one the row had.
   */
  function withPublic(urls, old, self) {
    const tailnet = (u) => /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u);
    const pub = (old || []).filter((u) => /^https:/i.test(u) || (tailnet(u) && !urls.some(tailnet)));
    return [...new Set([...urls, ...pub])].filter((u) => u !== self);
  }

  /**
   * The row of a machine none of whose addresses the row has any more (1.5.66:
   * the cloud's Tailscale address changed; the phone kept the old one and never
   * learned its relay). Matched by name, only when it is safe: one machine in
   * the hub's list has that name, one row (not the hub's own) has it, and that
   * row shares no address with another machine of the list.
   */
  function sameNamedRow(list, machine, machines, hubUrl) {
    const key = (n) => String(n || '').trim().toLowerCase();
    const want = key(machine.name);
    if (!want || (machines || []).filter((m) => key(m?.name) === want).length !== 1) return [];
    const named = list.filter((h) => key(h.name) === want && h.url !== hubUrl);
    if (named.length !== 1) return [];
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    const addrs = new Set([named[0].url, ...(named[0].alt || [])].map(strip));
    const another = (machines || []).some((m) => m && m !== machine && [m.url, m.tailnetUrl].map(strip).some((u) => u && addrs.has(u)));
    return another ? [] : named;
  }

  /**
   * Fold in the machines the hub knows about (its peers). The phone has only
   * paired with some of them; the rest still belong in this list, with the hub
   * that can hand out an entry ("via").
   *
   * One row per machine: a machine has a LAN and a Tailscale address, and the
   * phone may have saved either (or both, as two rows). The hub's name for it
   * always wins - it is the name given when the machine was added, so an old
   * hostname like "localhost.localdomain" goes away. Rows this hub taught us
   * that it no longer lists (an old address) are dropped.
   */
  async function mergePeerMachines() {
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    for (const entry of await readHubs()) {
      const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
      if (!token) continue;
      let data;
      try {
        // The address that answered last (the row's label), not always the saved
        // one: away from home that is the relay, and the LAN one only timed out (1.5.39).
        const base = entry.best && [entry.url, ...(entry.alt || [])].includes(entry.best) ? entry.best : entry.url;
        const res = await fetch(base + '/api/machines', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        data = await res.json();
      } catch {
        continue; // offline hub: nothing to learn from it
      }
      let list = await readHubs();
      const before = JSON.stringify(list);
      const listed = new Set();
      for (const machine of data?.machines || []) {
        const urls = [machine.tailnetUrl, machine.url, relayLocal(machine.relay)].map(strip).filter(Boolean);
        if (machine.self) {
          // The hub itself: its own name for the row we opened it by.
          for (const h of list) {
            if (!(urls.includes(h.url) || h.url === entry.url)) continue;
            if (machine.name) h.name = machine.name;
            if (urls.length) h.alt = withPublic(urls, h.alt, h.url);
          }
          continue;
        }
        if (!urls.length) continue;
        urls.forEach((u) => listed.add(u));
        let matches = list.filter((h) => urls.includes(h.url) || (h.alt || []).some((u) => urls.includes(u)));
        if (!matches.length) matches = sameNamedRow(list, machine, data.machines, entry.url);
        if (!matches.length) {
          // A tailnet address works from anywhere; the LAN one may not be routable.
          list.push({ url: urls[0], alt: urls.slice(1), name: machine.name, via: entry.url, viaName: entry.name || hostLabel(entry.url) });
          continue;
        }
        // Keep the row this phone holds a login for; fold the others into it.
        let keep = matches[0];
        for (const m of matches) {
          if (await store.get(KEYS.tokenFor(m.url)).catch(() => null)) { keep = m; break; }
        }
        if (machine.name) keep.name = machine.name;
        keep.alt = withPublic(urls, matches.flatMap((m) => [m.url, ...(m.alt || [])]), keep.url);
        if (!keep.via && keep.url !== entry.url) { keep.via = entry.url; keep.viaName = entry.name || hostLabel(entry.url); }
        list = list.filter((h) => h === keep || !matches.includes(h));
      }
      // Learned from this hub but no longer in its list: an old address.
      list = list.filter((h) => !(h.via === entry.url && !listed.has(h.url) && !(h.alt || []).some((u) => listed.has(u))));
      if (JSON.stringify(list) !== before) {
        await store.set(KEYS.hubs, JSON.stringify(list.slice(0, 12)));
        await renderMachines();
      }
    }
  }

  async function forgetHub(hub) {
    const hubs = (await readHubs()).filter((h) => h.url !== hub);
    await store.set(KEYS.hubs, JSON.stringify(hubs));
    await store.remove(KEYS.tokenFor(hub)).catch(() => {});
    // Deleting the machine that was opened last must not leave the app without
    // a current one: the next launch would show the empty "connect" form even
    // though other machines are still saved. The next one in the list takes over.
    if ((await store.get(KEYS.hub)) === hub) {
      if (hubs.length) await store.set(KEYS.hub, hubs[0].url);
      else await store.remove(KEYS.hub);
    }
  }

  /** "全部忘记": every saved machine and its login on this phone. */
  async function forgetAllHubs() {
    for (const h of await readHubs()) await store.remove(KEYS.tokenFor(h.url)).catch(() => {});
    await store.remove(KEYS.hubs);
    await store.remove(KEYS.hub);
  }

  // ---------------------------------------------------------------- the relay (第 1 步原型)
  /*
   * A computer reached through the Lamplit relay, without Tailscale. The app
   * runs a small forwarder per computer on 127.0.0.1:14440-14499 (RelayLinks
   * on Android): it opens TLS through the relay to that computer and trusts
   * only the certificate fingerprint the pairing code carried. So such a
   * computer's address here is http://127.0.0.1:<port>.
   */
  const RELAY_PORTS = [14440, 14499];
  // A probe through the relay slower than this is shown as 「中转 · 较慢」 in the list.
  const RELAY_SLOW_MS = 1500;
  function isRelayLocal(raw) {
    try {
      const u = new URL(raw);
      const port = Number(u.port);
      return u.hostname === '127.0.0.1' && port >= RELAY_PORTS[0] && port <= RELAY_PORTS[1];
    } catch {
      return false;
    }
  }
  /** {host, port, id, fp} -> the local address for it ('' without the app's bridge or a bad address). */
  function relayLocal(relay) {
    const shell = globalThis.NightshiftShell;
    if (!relay || !shell || typeof shell.relayLocal !== 'function') return '';
    try {
      return String(shell.relayLocal(String(relay.host || ''), Number(relay.port) || 0, String(relay.id || ''), String(relay.fp || '')) || '');
    } catch {
      return '';
    }
  }
  /** 直连 (1.5.46): 'direct' when the app reaches this forwarder's computer directly, else 'relay' or ''. */
  function relayRoute(raw) {
    const shell = globalThis.NightshiftShell;
    if (!shell || typeof shell.relayRoute !== 'function' || !isRelayLocal(raw)) return '';
    try {
      return String(shell.relayRoute(String(raw)) || '');
    } catch {
      return '';
    }
  }
  /** relay=host:port&rid=…&rfp=… in a pairing code -> the local address ('' when absent). */
  function relayFromCode(url) {
    const where = url.searchParams.get('relay') || '';
    const cut = where.lastIndexOf(':');
    if (!where || cut < 1) return '';
    return relayLocal({ host: where.slice(0, cut).replace(/^\[|\]$/g, ''), port: Number(where.slice(cut + 1)), id: url.searchParams.get('rid'), fp: url.searchParams.get('rfp') });
  }

  /** How this phone reaches a machine, in words: 局域网 / Tailscale / 中转 / 外网. */
  function linkKind(raw) {
    let host = '';
    try { host = new URL(raw).hostname; } catch { return raw; }
    // 127.0.0.1:14440-14499 is the app's own relay forwarder (RelayLinks).
    const port = Number(new URL(raw).port);
    if (host === '127.0.0.1' && port >= 14440 && port <= 14499) return '中转';
    if (/\.ts\.net$/i.test(host)) return raw.startsWith('https:') ? '外网' : 'Tailscale';
    const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 100 && b >= 64 && b <= 127) return 'Tailscale';
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return '局域网';
    }
    if (host === 'localhost') return '局域网';
    return '外网';
  }

  /**
   * The row's label. The public address goes through Tailscale's relay
   * (measured from a phone: ~0.6 s a request, 12 s for the first one, against
   * ~40 ms over Tailscale), so when the machine also has a Tailscale address,
   * say that turning Tailscale on is faster.
   */
  function linkLabel(best, entry) {
    const kind = linkKind(best);
    if (kind !== '外网') return kind;
    const hasTailnet = [entry.url, ...(entry.alt || [])].some((u) => linkKind(u) === 'Tailscale');
    return hasTailnet ? '外网 · 开 Tailscale 更快' : kind;
  }

  /** Tap a machine to go in; long press offers to forget. */
  async function renderMachines() {
    if (!dom.machines || !dom.machineList) return;
    await foldDuplicateRows();
    const hubs = await readHubs();
    dom.machines.hidden = hubs.length === 0;
    dom.machineList.textContent = '';
    for (const entry of hubs) {
      const row = document.createElement('div');
      row.className = 'machine';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.url = entry.url;

      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('div');
      name.className = 'n';
      name.textContent = entry.name || hostLabel(entry.url);
      const url = document.createElement('div');
      url.className = 'u';
      // How it was reached last time, until this check says otherwise.
      url.textContent = linkLabel(entry.best || entry.url, entry);
      url.title = entry.best || entry.url;
      who.append(name, url);

      const tag = document.createElement('span');
      // The list is redrawn every 15 s: keep what the last check said instead
      // of flashing 检测中 (and a slow answer must not read as 离线 meanwhile).
      const known = renderMachines.lastUp?.get(entry.url);
      tag.className = `pill${known === true ? '' : ' warn'}`;
      tag.textContent = known === true ? '在线' : known === 'behind' ? '仅电脑可达' : known === false ? '离线' : '检测中';
      if (known === true) dot.classList.add('up');
      row.append(dot, who, tag);

      let timer = null;
      let longPressed = false;
      row.addEventListener('pointerdown', () => {
        longPressed = false;
        timer = setTimeout(async () => {
          timer = null;
          longPressed = true;
          // eslint-disable-next-line no-alert
          const ok = window.confirm(`从列表里删掉「${entry.url}」？\n电脑上的 Lamplit 不受影响。`);
          if (!ok) return;
          await forgetHub(entry.url);
          await renderMachines();
        }, LONG_PRESS_MS);
      });
      const cancel = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      row.addEventListener('pointerup', cancel);
      row.addEventListener('pointercancel', cancel);
      row.addEventListener('pointerleave', cancel);
      row.addEventListener('click', () => {
        if (longPressed) {
          longPressed = false;
          return;
        }
        // Home is a machine this app paired with itself (1.5.48: tapping the cloud
        // server, learned from the computer, made it home and 全部机器 came from there).
        // A machine learned from another one opens as 只看这台.
        if (!entry.via) void store.set(KEYS.home, entry.url).catch(() => {});
        void enterMachine(entry, tag, { view: entry.via ? 'one' : 'all' });
      });

      dom.machineList.appendChild(row);
      // Show which ones answer right now, without blocking the render.
      // Either address counts: a VM's LAN address is often only reachable from
      // the computer, while its Tailscale one answers the phone.
      // The label says how the phone reaches it right now (局域网 at home,
      // Tailscale elsewhere), not which address happened to be saved first.
      const anyUp = async () => {
        const best = await bestAddress([entry.url, ...(entry.alt || [])]);
        // Through the relay and slow to answer (a weak signal, a far relay): say so.
        // Timed on its own: the other addresses' probes run out their timeouts away from home.
        let slow = false;
        if (best && linkKind(best) === '中转') {
          const started = Date.now();
          slow = !(await probe(best, RELAY_SLOW_MS * 4)) || Date.now() - started > RELAY_SLOW_MS;
        }
        if (best) { url.textContent = slow ? '中转 · 较慢' : linkLabel(best, entry); url.title = best; }
        // 直连 (1.5.46): the first connection through the relay starts a try at
        // going direct (a few seconds); say so here once it worked.
        // 1.5.48: a direct path inside the home network (the same Wi-Fi) is 局域网.
        const roadWords = () => (relayRoute(best) === 'direct-lan' ? '局域网' : relayRoute(best) === 'direct' ? '直连' : '');
        if (best && roadWords()) url.textContent = roadWords();
        else if (best && linkKind(best) === '中转') {
          setTimeout(() => { if (url.isConnected && roadWords()) url.textContent = roadWords(); }, 10000);
        }
        if (best && best !== entry.best) {
          // Remember it for the next time this list opens.
          const all = await readHubs();
          const row = all.find((h) => h.url === entry.url);
          if (row) { row.best = best; await store.set(KEYS.hubs, JSON.stringify(all)); }
        }
        return Boolean(best);
      };
      void anyUp().then(async (up) => {
        if (!renderMachines.lastUp) renderMachines.lastUp = new Map();
        renderMachines.lastUp.set(entry.url, up);
        if (!row.isConnected) return; // redrawn meanwhile
        dot.classList.toggle('up', up);
        tag.className = `pill${up ? '' : ' warn'}`;
        tag.textContent = up ? '在线' : '离线';
        if (!up) {
          // Not off: it lives behind the computer that told us about it (a VM on
          // that computer's private network). Say so instead of "离线".
          if (await behindVia(entry)) { tag.textContent = '仅电脑可达'; renderMachines.lastUp.set(entry.url, 'behind'); }
          return;
        }
        // A hub we hold a token for can tell us its own name (hostname), which
        // is nicer in this list than an address.
        const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
        if (!token) return;
        try {
          const res = await fetch(`${entry.url}/api/machines`, { headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) return;
          const data = await res.json();
          const mine = (data?.machines || []).find((m) => m.self);
          if (mine?.name && mine.name !== name.textContent) {
            name.textContent = mine.name;
            await rememberHubNamed(entry.url, mine.name);
          }
        } catch {
          /* keep the address */
        }
      });
    }
  }

  /**
   * Enter a machine. The full web UI is what the desktop shows, so that is what
   * opens - but the WebView needs its own session cookie there. If this phone
   * already holds a device token for that hub, trade it for a one-time pairing
   * link so the UI opens *inside*, not on its pairing screen.
   */
  /** Resolve a hub's own name (hostname) when all we stored was its address. */
  async function resolveMachineName(entry) {
    const looksLikeAddress = (name) => !name || /^[\d.]+(:\d+)?$/.test(name) || /^\[/.test(name);
    if (entry.name && !looksLikeAddress(entry.name)) return entry.name;
    const token = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
    if (!token) return entry.name || '';
    try {
      const res = await fetch(`${entry.url}/api/machines`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        const mine = (data?.machines || []).find((m) => m.self);
        if (mine?.name) {
          await rememberHubNamed(entry.url, mine.name);
          return mine.name;
        }
      }
    } catch {
      /* keep what we have */
    }
    return entry.name || '';
  }

  /**
   * Where did we come from? The target's machine switcher shows that machine as
   * an ordinary row, so coming in from the phone's home hub must say so - the
   * two hubs know each other only in one direction.
   */
  async function originFor(targetUrl) {
    const hubs = await readHubs();
    const via = hubs.find((h) => h.url === targetUrl)?.via;
    if (via) {
      const entry = hubs.find((h) => h.url === via) || { url: via, name: '' };
      return { url: via, name: await resolveMachineName(entry) };
    }
    const token = await store.get(KEYS.tokenFor(targetUrl)).catch(() => null);
    for (const entry of hubs) {
      if (entry.url === targetUrl) continue;
      const other = await store.get(KEYS.tokenFor(entry.url)).catch(() => null);
      if (!other) continue;
      // Prefer a hub that also has a token for us: the target can talk back.
      if (!token) {
        return { url: entry.url, name: await resolveMachineName(entry) };
      }
    }
    return null;
  }

  /** Append the "you came from here" hint the target's switcher renders. */
  /** How the machine's page opens (1.5.44): 'all' = 全部机器 (home), 'one' = 只看这台 (picked by name). */
  function withView(target, view) {
    if (!view) return target;
    try {
      const url = new URL(target);
      url.searchParams.set('view', view);
      return url.toString();
    } catch {
      return target;
    }
  }

  function withOrigin(target, origin) {
    if (!origin) return target;
    try {
      const url = new URL(target);
      url.searchParams.set('from', origin.url);
      if (origin.name) url.searchParams.set('fromName', origin.name);
      return url.toString();
    } catch {
      return target;
    }
  }

  /**
   * A machine this phone cannot reach while the computer that listed it can:
   * a VM on that computer's private (NAT) network, with no Tailscale address.
   */
  async function behindVia(entry) {
    if (!entry.via || entry.via === entry.url) return false;
    const urls = [entry.url, ...(entry.alt || [])];
    if (urls.some((u) => linkKind(u) !== '局域网')) return false;
    return probe(entry.via);
  }

  async function enterMachine(entry, tag, { view = '', quiet = false } = {}) {
    // Same network: LAN. Elsewhere: Tailscale. The phone decides, every time.
    let hub = (await bestAddress([entry.url, ...(entry.alt || [])])) || entry.url;
    let up = hub !== entry.url || (await probe(hub));
    if (!up) {
      // A Tailscale address needs a moment after the VPN comes up; one retry
      // beats telling the user a machine is off when it is not.
      await new Promise((r) => setTimeout(r, 700));
      up = await probe(hub);
    }
    // Opening by itself at start (1.5.44): a machine that does not answer means the list, no box.
    if (!up && quiet) return false;
    if (!up && (await behindVia(entry))) {
      if (tag) {
        tag.className = 'pill warn';
        tag.textContent = '仅电脑可达';
      }
      // eslint-disable-next-line no-alert
      window.alert(
        `「${entry.name || hub}」开着，但它在「${entry.viaName || '那台电脑'}」的内部网络里（例如虚拟机的 NAT 网卡），手机直接连不到。

` +
          '在这台机器上装 Tailscale 并登录同一个账号，它就会有一个手机也能连的地址，回到这里刷新即可。',
      );
      return;
    }
    if (!up) {
      if (tag) {
        tag.className = 'pill warn';
        tag.textContent = '离线';
      }
      // eslint-disable-next-line no-alert
      window.alert(`「${entry.name || hub}」现在连不上（关机、休眠或不在同一个网络）。`);
      return;
    }
    // The row stays under its own address even when the other one answered;
    // a login is the machine's, whichever address carries it.
    await rememberHub(entry.url);
    let token = (await store.get(KEYS.tokenFor(hub))) || (await store.get(KEYS.tokenFor(entry.url)));
    // Whoever we came through gets a row in the target's switcher.
    const origin = await originFor(hub);
    if (token) {
      try {
        const res = await fetch(`${hub}/api/pairing/link`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 401 || res.status === 403) {
          // That login is gone there (replaced by a newer one from this phone,
          // or removed): forget it and get a fresh door from the machine that
          // told us about this one, instead of landing on the pairing page (1.5.39).
          for (const key of [KEYS.tokenFor(hub), KEYS.tokenFor(entry.url)]) {
            if ((await store.get(key).catch(() => null)) === token) await store.remove(key).catch(() => {});
          }
          token = '';
        } else if (res.ok) {
          const made = await res.json();
          const links = Array.isArray(made?.links) ? made.links : [];
          // Through the relay the computer cannot know this phone's local
          // address: the one-time token goes to the address we just reached.
          const pairOf = (u) => { try { return new URL(u).searchParams.get('pair') || ''; } catch { return ''; } };
          const relayToken = isRelayLocal(hub) ? made?.token || pairOf(made?.qr) || pairOf(made?.url) : '';
          const target = (relayToken && `${hub}/?pair=${encodeURIComponent(relayToken)}`) || (await pickReachableLink(links, safeOrigin(hub))) || made?.url;
          if (target) {
            await store.set(KEYS.hub, hub);
            window.location.assign(withView(withOrigin(target, origin), view));
            return true;
          }
        }
      } catch {
        /* fall back to the plain address below */
      }
    }
    if (!token && entry.via) {
      // Never paired with this machine directly: the hub that told us about it
      // can hand out a one-time door (its own credential never leaves the hub).
      // The door is single-use, so spend it on the *app* pairing first (that is
      // what the background watcher needs), then mint a fresh link for the
      // WebView's own cookie.
      try {
        // The machine that told us about this one, by whichever of its addresses
        // answers now: away from home its LAN address does not, its relay one does (1.5.38).
        const viaRow = (await readHubs()).find((h) => h.url === entry.via);
        const viaBase = (viaRow && (await bestAddress([viaRow.url, ...(viaRow.alt || [])]))) || entry.via;
        const res = await fetch(`${viaBase}/api/machines/${encodeURIComponent(entry.name || '')}/handoff`, {
          method: 'POST',
          headers: { authorization: `Bearer ${(await store.get(KEYS.tokenFor(entry.via))) || ''}` },
        });
        if (res.ok) {
          const made = await res.json();
          const door = made?.url ? new URL(made.url) : null;
          const code = door?.searchParams.get('pair') || '';
          if (door && code) {
            let token = '';
            try {
              const paired = await pairWithHub(hub, code);
              token = paired.token || '';
              if (token) await store.set(KEYS.tokenFor(hub), token);
            } catch {
              /* fall back to the door itself for the WebView */
            }
            let target = made.url;
            if (token) {
              try {
                const minted = await fetch(`${hub}/api/pairing/link`, {
                  method: 'POST',
                  headers: { authorization: `Bearer ${token}` },
                });
                if (minted.ok) {
                  const fresh = await minted.json();
                  const links = Array.isArray(fresh?.links) ? fresh.links : [];
                  const relayToken = isRelayLocal(hub) ? fresh?.token || '' : '';
                  target = (relayToken && `${hub}/?pair=${encodeURIComponent(relayToken)}`) || (await pickReachableLink(links, safeOrigin(hub))) || fresh?.url || target;
                }
              } catch {
                /* keep the original door */
              }
            }
            await store.set(KEYS.hub, hub);
            window.location.assign(withView(withOrigin(target, origin), view));
            return true;
          }
        }
      } catch {
        /* fall through */
      }
    }
    await store.set(KEYS.hub, hub);
    window.location.assign(withView(withOrigin(`${hub}/`, origin), view));
    return true;
  }

  /**
   * The machine the app opens into (1.5.44): 「全部机器」 is the default, so the
   * bots show at once instead of the list first. The home machine (the last one
   * picked from the list), else the last opened, else the first saved. Only on
   * a cold start: the Back key and 「返回 App 的机器列表」 come here for the list.
   */
  async function homeEntry() {
    const all = await readHubs();
    if (!all.length) return null;
    // Only a machine this app paired with itself (no `via`) is home; an older
    // install whose home became a learned machine comes back to its own (1.5.48).
    const own = all.filter((h) => !h.via);
    const saved = own.length ? own : all;
    const home = (await store.get(KEYS.home).catch(() => '')) || state.hub || '';
    return saved.find((h) => h.url === home) || saved.find((h) => h.url === state.hub) || saved[0];
  }
  async function openHome() {
    const entry = await homeEntry();
    if (!entry) return false;
    show('booting');
    dom.bootingText.textContent = `正在打开「${entry.name || hostLabel(entry.url)}」…`;
    dom.bootingUrl.textContent = '';
    // The same fast route choice as a tap (1.5.39); not there: the list says why.
    const opened = await enterMachine(entry, null, { view: 'all', quiet: true }).catch(() => false);
    if (opened) return true;
    // Home is off (1.5.69; 11-25: the PC shut down and 「全部机器」 was gone - only one machine at a time could be
    // opened): any machine that answers shows 全部机器, with the ones that are off listed as off. Home stays home.
    for (const other of (await readHubs()).filter((h) => h.url !== entry.url)) {
      dom.bootingText.textContent = `「${entry.name || hostLabel(entry.url)}」没开，正在打开「${other.name || hostLabel(other.url)}」…`;
      if (await enterMachine(other, null, { view: 'all', quiet: true }).catch(() => false)) return true;
    }
    return false;
  }

  /**
   * Reachability probe. `no-cors` is deliberate: the hub sends no CORS headers,
   * so a normal fetch could never read a response. An opaque fetch still proves
   * a live HTTP listener, which is all "is it up?" needs. /api/auth is used
   * because it is the one API path that answers without a credential.
   */
  async function probe(hub, timeoutMs = PROBE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`${hub}/api/auth`, {
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The address to use right now, decided by the phone: every address is
   * probed at once, and of those that answer the closest wins - LAN (same
   * network), then Tailscale, then the public one. '' when none answers.
   */
  async function bestAddress(urls) {
    const all = [...new Set((urls || []).filter(Boolean))];
    if (!all.length) return '';
    // Only the routes this phone can use now (1.5.39): no Tailscale address while
    // its Tailscale is off, no LAN address off that LAN. They only timed out
    // (4.5 s each, 5-10 s per switch on a hotspot). Nothing left: try them all.
    const usable = all.filter(mayUseNow);
    const list = usable.length ? usable : all;
    // The relay is the long way round, but a domestic one is still shorter than Funnel's.
    const kindRank = { '局域网': 0, Tailscale: 1, '中转': 2, '外网': 3 };
    const up = await firstAnswers(list, kindRank);
    if (!up.some(Boolean)) {
      // A Tailscale connection that goes through a relay (DERP) can need more
      // than the first few seconds to answer: one longer try before "离线".
      const slow = list.filter((u) => linkKind(u) !== '局域网');
      const again = await Promise.all(slow.map((u) => probe(u, 10000)));
      slow.forEach((u, i) => { if (again[i]) up[list.indexOf(u)] = true; });
    }
    const ok = list.filter((_, i) => up[i]);
    ok.sort((a, b) => (kindRank[linkKind(a)] ?? 3) - (kindRank[linkKind(b)] ?? 3));
    return ok[0] || '';
  }

  /**
   * Probe every address at once, but do not wait for the slow ones: as soon as
   * one answers, give the better-ranked ones still out GRACE_MS more, then stop.
   * -> [true|false per address] (false also for "still waiting").
   */
  const GRACE_MS = 800;
  function firstAnswers(list, kindRank) {
    return new Promise((resolve) => {
      const up = list.map(() => false);
      const settled = list.map(() => false);
      let left = list.length;
      let timer = null;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(up); } };
      const rank = (u) => kindRank[linkKind(u)] ?? 3;
      list.forEach((u, i) => {
        probe(u).then((ok) => {
          if (done) return;
          up[i] = ok;
          settled[i] = true;
          left -= 1;
          if (left === 0) { finish(); return; }
          const best = list.reduce((r, v, j) => (up[j] ? Math.min(r, rank(v)) : r), 99);
          if (best === 99) return;
          // Nothing better-ranked is still out: done now.
          if (list.every((v, j) => settled[j] || rank(v) >= best)) { finish(); return; }
          if (!timer) timer = setTimeout(finish, GRACE_MS);
        });
      });
    });
  }

  /** The phone's own network (NetHints in the app), re-read at most every 10 s. */
  function netHints() {
    const shell = globalThis.NightshiftShell;
    if (!shell || typeof shell.networkHints !== 'function') return null;
    if (netHints.cache && Date.now() - netHints.at < 10000) return netHints.cache;
    try {
      const raw = shell.networkHints();
      netHints.cache = raw ? JSON.parse(raw) : null;
    } catch {
      netHints.cache = null;
    }
    netHints.at = Date.now();
    return netHints.cache;
  }

  const ipToInt = (ip) => ip.split('.').reduce((n, p) => ((n << 8) | (Number(p) & 255)) >>> 0, 0);

  /** Can this phone use `url` right now: Tailscale only with Tailscale on, a LAN address only on that LAN. */
  function mayUseNow(url) {
    const hints = netHints();
    if (!hints) return true;
    let u;
    try { u = new URL(url); } catch { return true; }
    const kind = linkKind(url);
    if (kind === 'Tailscale') return Boolean(hints.tailscale);
    const host = u.hostname;
    if (kind === '局域网' && /^(10|172|192)\.\d+\.\d+\.\d+$/.test(host)) {
      return (hints.lan || []).some((cidr) => {
        const [ip, bits] = String(cidr).split('/');
        const b = Math.max(8, Math.min(32, Number(bits) || 24));
        const mask = b === 32 ? 0xffffffff : (0xffffffff << (32 - b)) >>> 0;
        return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(host) & mask) >>> 0);
      });
    }
    return true;
  }

  async function loadInfo() {
    try {
      const res = await fetch('shell-info.json', { cache: 'no-store' });
      if (res.ok) state.info = await res.json();
    } catch {
      state.info = null;
    }
    return state.info;
  }

  function shellLabel() {
    const info = state.info;
    if (!info) return '未知';
    const when = String(info.builtAt || '').replace('T', ' ').replace(/\..*$/, '');
    return `v${info.shellVersion} · ${when} UTC`;
  }

  function setStatus(text, tone) {
    if (!dom.currentStatus) return;
    dom.currentStatus.textContent = text;
    dom.currentStatus.className = `pill${tone === 'warn' ? ' warn' : ''}`;
  }

  // ---------------------------------------------------------------- screens
  function showConnect(prefill) {
    setError('');
    // With machines already saved, "添加机器" must have a way back to the list.
    void readHubs().then((hubs) => { if (dom.connectBack) dom.connectBack.hidden = hubs.length === 0; });
    dom.hubUrl.value = prefill !== undefined ? prefill : state.hub || '';
    dom.hubCode.value = '';
    show('connect');
    if (!prefill && !state.hub) dom.hubUrl.focus();
  }

  function showConnected() {
    // The app opens on the machine list: every hub this phone has paired with,
    // with its live state, so a switched-off computer is obvious instead of a
    // dead button.
    if (dom.currentHub) dom.currentHub.textContent = state.hub || '—';
    if (dom.shellVersion) dom.shellVersion.textContent = shellLabel();
    if (dom.currentStatus) setStatus('检测中…', 'warn');
    show('connected');
    void renderMachines().then(() => mergePeerMachines());
    void syncThemeFromHub();
    void refreshStatus();
    // Keep the online/offline tags honest while this screen is open.
    if (showConnected._timer) clearInterval(showConnected._timer);
    showConnected._timer = setInterval(() => {
      if (state.view === 'connected') void renderMachines();
    }, 15000);
  }

  function showOffline(reason) {
    dom.offlineDetail.textContent =
      reason || 'Hub 没有响应。App 本身没问题，只是看不见你那台电脑。';
    dom.offlineUrl.textContent = state.hub || '—';
    show('offline');
  }

  /** Ask the hub whether it is there, and update the pill without blocking the UI. */
  async function refreshStatus() {
    const id = ++state.probeId;
    const hub = state.hub;
    if (!hub) return;
    const up = await probe(hub);
    if (id !== state.probeId || state.view !== 'connected') return;
    setStatus(up ? '在线' : '连不上', up ? 'ok' : 'warn');
  }

  // ------------------------------------------------------------------ actions
  /**
   * Pair this phone with a hub from the app itself, and keep the device token.
   * The app's own screen (app.html) then talks to the HTTP API directly with
   * `Authorization: Bearer <token>` - no cookie, no cross-site cookie rules.
   */
  async function pairWithHub(hub, code) {
    const res = await fetch(`${hub}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client: 'app' }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new Error('配对码不对，或者这个链接已经过期了。');
    if (res.status === 409) throw new Error('这台电脑还没有打开「允许手机连接」。');
    if (!res.ok || !data?.token) {
      throw new Error((data && data.error && data.error.message) || `配对失败（${res.status}）`);
    }
    return data;
  }

  /**
   * A hub hands out one link per address (LAN + Tailscale); the phone can often
   * reach only one of them (a VMware LAN address is not routable from the phone).
   * Probing beats guessing: take the first link that answers.
   */
  function safeOrigin(u) { try { return new URL(u).origin; } catch { return ''; } }

  async function pickReachableLink(links, preferOrigin = '') {
    // The hub lists its public (Funnel) address first, for phones that have
    // nothing else. A phone that just reached it directly must stay on that
    // address: the public one goes round through the internet, is slower, and
    // its one-time link failed there. Order: the address in use, LAN,
    // Tailscale, public last.
    const rank = (l) => {
      let origin = '';
      try { origin = new URL(l.url).origin; } catch { /* ranked last */ }
      if (preferOrigin && origin === preferOrigin) return 0;
      return { lan: 1, tailnet: 2, public: 3 }[l.kind] ?? 2;
    };
    const usable = (links || []).filter((l) => l && typeof l.url === 'string').sort((a, b) => rank(a) - rank(b));
    for (const link of usable) {
      let origin;
      try {
        origin = new URL(link.url).origin;
      } catch {
        continue;
      }
      if (await probe(origin)) return link.url;
    }
    return usable[0]?.url || '';
  }

  /** Pair (when a code came with it) and go into that machine's full UI. */
  async function openChat(hub, code) {
    show('booting');
    dom.bootingText.textContent = code ? '正在配对…' : '正在打开 Lamplit…';
    dom.bootingUrl.textContent = hub;
    state.hub = hub;
    const up = await probe(hub);
    if (state.view !== 'booting') return; // user cancelled
    if (!up) {
      showOffline(`${hub} 没有响应。`);
      return;
    }
    if (code) {
      const paired = await pairWithHub(hub, code);
      await store.set(KEYS.tokenFor(hub), paired.token);
      if (paired.device?.id) await store.set('desk.deviceId', paired.device.id);
    } else if (!(await store.get(KEYS.tokenFor(hub)))) {
      // No token yet: the hub's own UI has the pairing form.
      await store.set(KEYS.hub, hub);
      window.location.assign(hubUrlFor(hub, ''));
      return;
    }
    await enterMachine({ url: hub, name: state.machineName || hostLabel(hub) });
  }

  /** A pair link from the computer's QR code: https://host:port/?pair=TOKEN */
  async function connectFromScan(raw) {
    let text = String(raw || '').trim();
    // A relay-only code starts with words for older apps (第 2 步): the link follows them.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const link = /https?:\/\/\S+/i.exec(text)?.[0];
      if (link && /[?&]relay=/.test(link)) text = link;
    }
    if (!text) {
      setError('没扫到内容，再试一次。');
      return;
    }
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
      setError(`这个码不是 Lamplit 的连接码：${text.slice(0, 80)}`);
      return;
    }
    // The code carries every address of the machine (alt=): use the one this
    // phone reaches now, keep the others for later (home vs. away).
    const all = [url.origin];
    for (const alt of url.searchParams.getAll('alt')) {
      try { all.push(new URL(alt).origin); } catch { /* skip */ }
    }
    // Through the relay: a computer with no other address puts a placeholder first.
    const viaRelay = relayFromCode(url);
    if (viaRelay) all.push(viaRelay);
    if (/\.relay\.invalid$/i.test(url.hostname)) all.shift();
    if (!all.length) {
      setError('这个码要经过中转，但这个 App 版本还不会走中转：更新 App 后再扫。');
      return;
    }
    const hub = (await bestAddress(all)) || all[0];
    const token = url.searchParams.get('pair') || '';
    await rememberHub(hub, all.filter((u) => u !== hub));
    await renderMachines();
    try {
      await openChat(hub, token);
    } catch (err) {
      setError(err.message || String(err));
      showConnect(hub);
    }
  }

  /**
   * The MLKit scanner ships as a Google module that the OS downloads on demand.
   * On phones without Google Play services (very common in China) that download
   * never succeeds, so check first and say so instead of throwing an English
   * stack at the user.
   */
  async function ensureBarcodeModule() {
    if (!scanner) return false;
    try {
      const check = scanner.isGoogleBarcodeScannerModuleAvailable;
      if (typeof check === 'function') {
        const state = await check.call(scanner);
        if (state && state.available) return true;
      } else {
        return true; // older plugin: no module split, just scan
      }
      if (typeof scanner.installGoogleBarcodeScannerModule === 'function') {
        await scanner.installGoogleBarcodeScannerModule.call(scanner);
        const again = typeof check === 'function' ? await check.call(scanner) : null;
        return Boolean(again && again.available);
      }
    } catch (err) {
      console.warn('[desk] barcode module unavailable', err);
    }
    return false;
  }

  /** jsQR, loaded the first time the camera scanner is used. */
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'jsqr.js';
      tag.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR did not load')));
      tag.onerror = () => reject(new Error('jsQR did not load'));
      document.head.appendChild(tag);
    });
  }

  /**
   * Scan with the camera inside the app: the WebView's camera + jsQR. Works on
   * phones without Google Play services, where the ML Kit module never downloads.
   * -> the QR text, or '' when the human cancels.
   */
  async function cameraScan() {
    const view = document.getElementById('scan-view');
    const video = document.getElementById('scan-video');
    const status = document.getElementById('scan-status');
    const jsQR = await loadJsQR();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (err) {
      throw new Error(/NotAllowed|Permission/i.test(String(err && (err.name || err.message))) ? 'NO_CAMERA_PERMISSION' : String((err && err.message) || err));
    }
    view.hidden = false;
    status.textContent = '对准电脑上「设置 → 手机和外网」里的二维码';
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return new Promise((resolve) => {
      let done = false;
      // The phone's back key closes the camera: it goes back over this entry
      // instead of leaving the page with the camera still running.
      history.pushState({ scan: true }, '');
      const onBack = () => finish('', true);
      window.addEventListener('popstate', onBack);
      const finish = (value, fromBack = false) => {
        if (done) return;
        done = true;
        window.removeEventListener('popstate', onBack);
        if (!fromBack && history.state && history.state.scan) history.back();
        stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
        view.hidden = true;
        resolve(value);
      };
      document.getElementById('scan-cancel').onclick = () => finish('');
      const tick = () => {
        if (done) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          // The middle of the picture, scaled down: fast enough on a mid-range phone.
          const side = Math.min(w, h);
          const size = Math.min(side, 720);
          canvas.width = size;
          canvas.height = size;
          ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
          const found = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' });
          if (found && found.data) { finish(found.data); return; }
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  async function scanToConnect() {
    setError('');
    if (dom.scanBtn) dom.scanBtn.disabled = true;
    try {
      // Google's scanner when this phone has it (faster, better in low light);
      // otherwise the camera inside the app.
      let useGoogle = false;
      if (scanner) {
        const permission = await scanner.requestPermissions().catch(() => null);
        if (permission && permission.camera !== 'granted' && permission.camera !== 'limited') {
          setError('没有相机权限，扫不了码。到系统设置里给 Lamplit 打开「相机」再试一次。');
          return;
        }
        useGoogle = await ensureBarcodeModule().catch(() => false);
      }
      if (!useGoogle) {
        const text = await cameraScan();
        if (!text) { setError('扫码已取消。'); return; }
        await connectFromScan(text);
        return;
      }
      const result = await scanner.scan({ formats: ['QR_CODE'] });
      const value = result?.barcodes?.[0]?.rawValue || '';
      await connectFromScan(value);
    } catch (err) {
      const message = String(err?.message || err || '');
      if (message === 'NO_CAMERA_PERMISSION') {
        setError('没有相机权限，扫不了码。到系统设置里给 Lamplit 打开「相机」再试一次。');
        return;
      }
      if (/barcode scanner module/i.test(message)) {
        setError(
          '这台手机的扫码组件还没装好（需要 Google 条码扫描模块，国内机型通常下载不到）。\n' +
            '下面直接填地址也能连，或者在手机浏览器里打开电脑上那个二维码链接。',
        );
        dom.hubUrl?.focus();
        return;
      }
      setError(
        /cancel/i.test(message)
          ? '扫码已取消。'
          : `扫码没成功：${message}\n如果一直这样，手动填电脑上显示的地址也能连。`,
      );
    } finally {
      if (dom.scanBtn) dom.scanBtn.disabled = false;
    }
  }

  async function connectFromForm() {
    setError('');
    let hub;
    try {
      hub = normalizeHub(dom.hubUrl.value);
    } catch (err) {
      setError(err.message);
      return;
    }
    const code = dom.hubCode.value.trim();
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = '连接中…';
    try {
      const up = await probe(hub);
      if (!up) {
        state.hub = hub;
        showOffline(
          `${hub} 没有响应。\n确认那边 Lamplit 是用 ASSIST_ALLOW_REMOTE=1 HOST=0.0.0.0 起的，` +
            '手机和电脑在同一个网络，防火墙放行了这个端口。',
        );
        return;
      }
      await rememberHub(hub);
      dom.hubCode.value = '';
      await renderMachines();
      await openChat(hub, code);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      dom.connectBtn.disabled = false;
      dom.connectBtn.textContent = '连接并打开';
    }
  }

  // ------------------------------------------------------------------- wiring
  dom.connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void connectFromForm();
  });

  dom.scanBtn.addEventListener('click', () => {
    void scanToConnect();
  });

  dom.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        dom.hubUrl.value = text.trim();
        setError('');
      }
    } catch {
      dom.hubUrl.focus();
    }
  });

  dom.previewBtn.addEventListener('click', () => {
    // The bundled copy of public/ (www/ui). No hub, so no data — it is there to
    // prove what the shell packaged, not to be useful.
    window.location.assign('ui/index.html');
  });

  dom.openBtn?.addEventListener('click', () => {
    if (state.hub) void openChat(state.hub, '');
  });

  dom.changeBtn.addEventListener('click', () => showConnect(state.hub));

  // ---------------------------------------------------------------- appearance
  // One setting, not two: 设置 → 外观 on the hub (dark / light / 跟随系统) is the
  // truth. The hub reports it to /api/ui/state, the shell mirrors it, and with
  // "跟随系统" (or nothing chosen yet) the phone decides.
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let hubTheme = 'system';

  function paintTheme() {
    const dark = hubTheme === 'dark' || (hubTheme !== 'light' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = hubTheme;
    try {
      localStorage.setItem('desk.hubTheme', hubTheme);
    } catch {
      /* private mode */
    }
  }

  async function syncThemeFromHub() {
    const hubs = await readHubs();
    const order = [state.hub, ...hubs.map((h) => h.url)].filter(Boolean);
    for (const url of order) {
      const token = await store.get(KEYS.tokenFor(url)).catch(() => null);
      if (!token) continue;
      try {
        const res = await fetch(`${url}/api/ui/state`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const data = await res.json();
        const theme = data?.theme;
        hubTheme = theme === 'dark' || theme === 'light' ? theme : 'system';
        paintTheme();
        return;
      } catch {
        /* try the next hub */
      }
    }
    // No hub answered: the device setting is all there is.
    hubTheme = 'system';
    paintTheme();
  }

  darkQuery.addEventListener?.('change', () => {
    if (hubTheme !== 'dark' && hubTheme !== 'light') paintTheme();
  });
  paintTheme();

  dom.forgetBtn.addEventListener('click', async () => {
    const count = (await readHubs()).length;
    if (count && !window.confirm(`忘记这台手机上保存的全部 ${count} 台机器？
电脑上的 Lamplit 不受影响，以后要重新配对。`)) return;
    await forgetAllHubs();
    state.hub = '';
    dom.connectForm.reset();
    await renderMachines();
    showConnect('');
  });

  dom.bootingCancel.addEventListener('click', () => {
    if (state.hub) showConnected();
    else showConnect('');
  });

  dom.offlineRetry.addEventListener('click', () => {
    if (state.hub) void openChat(state.hub, '');
    else showConnect('');
  });
  dom.offlineChange.addEventListener('click', () => showConnect(state.hub));
  dom.connectBack?.addEventListener('click', () => showConnected());

  // -------------------------------------------------------------------- boot
  async function boot() {
    await loadInfo();
    dom.foot.textContent = `Lamplit mobile · ${shellLabel()}${isNative ? '' : ' · web preview'}`;
    if (dom.scanBtn) dom.scanBtn.hidden = false;
    try {
      await sealPlainTokens();
    } catch (err) {
      console.warn('[desk] sealing saved tokens failed', err);
    }

    const hub = await store.get(KEYS.hub);
    if (hub) {
      try {
        state.hub = normalizeHub(hub);
      } catch {
        state.hub = '';
      }
    }
    // Any saved machine means the list, not the empty form: the "last opened"
    // key can be gone (its machine was deleted) while others are still saved.
    const saved = await readHubs();
    if (!state.hub && saved.length) {
      state.hub = saved[0].url;
      await store.set(KEYS.hub, state.hub);
    }
    await renderMachines();
    // A machine's page asked to open another machine (NightshiftShell.openMachine,
    // 1.5.37): it could not reach that one itself - only the relay goes there.
    const open = /^#open=(.+)$/.exec(window.location.hash || '');
    if (open) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      const name = (() => { try { return decodeURIComponent(open[1]); } catch { return ''; } })();
      // 「全部机器」 on a machine opened by name (1.5.44): home, in 全部机器.
      if (name === '@home') {
        if (await openHome()) return;
        showConnected();
        return;
      }
      // Already in the list: open it now. Learning the list again first asked
      // every machine at every address, the dead ones too (1.5.39: seconds).
      let entry = name ? (await readHubs()).find((h) => h.name === name) : null;
      if (!entry && name) {
        await mergePeerMachines().catch(() => {});
        entry = (await readHubs()).find((h) => h.name === name) || null;
      }
      if (entry) {
        // The machine whose page asked is home, unless one was picked from the list (1.5.44).
        if (state.hub && !(await store.get(KEYS.home).catch(() => '')) && !(await readHubs()).find((h) => h.url === state.hub)?.via) await store.set(KEYS.home, state.hub).catch(() => {});
        // Not the list (1.5.39: it flashed on every switch): say where we are going.
        show('booting');
        dom.bootingText.textContent = `正在打开「${entry.name || hostLabel(entry.url)}」…`;
        dom.bootingUrl.textContent = '';
        // Still here a while later (it did not open): back to the list, which says why.
        void enterMachine(entry, null, { view: 'one' }).catch(() => {}).finally(() => setTimeout(() => {
          if (state.view === 'booting') showConnected();
        }, 3000));
        return;
      }
    }
    // A cold start opens the home machine in 「全部机器」 (1.5.44); the list only
    // when it does not answer, or later in this run (Back, 返回 App 的机器列表).
    let started = false;
    try { started = sessionStorage.getItem('desk.started') === '1'; sessionStorage.setItem('desk.started', '1'); } catch { started = true; }
    if (!started && state.hub && (await openHome())) return;
    if (state.hub) {
      showConnected();
      return;
    }
    showConnect('');
  }

  // The app came back to the foreground and the launchpad is showing: re-check.
  if (app && typeof app.addListener === 'function') {
    app.addListener('appStateChange', ({ isActive }) => {
      if (isActive && state.view === 'connected') void refreshStatus();
    });
  }

  boot().catch((err) => {
    console.error('[desk] boot failed', err);
    showConnect('');
    setError(`外壳启动失败：${err && err.message ? err.message : err}`);
  });

  // Exposed for `npm run check:shell` and for `chrome://inspect` on a device.
  window.__deskShell = {
    isNative,
    plugins: Object.keys(plugins),
    normalizeHub,
    state: () => ({ view: state.view, hub: state.hub, info: state.info }),
  };})();
