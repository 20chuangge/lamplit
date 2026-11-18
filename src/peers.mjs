// Other machines this hub can work with directly ("peers"). The desktop client
// knows every machine and holds a pairing token for each; it hands each hub the
// list of the others (name, LAN and Tailscale address, token). Hubs then talk
// to each other without the client: a bot here can hand work to a bot there
// and move files, even while the laptop is closed.
//
// data/peers.json [{name, url, tailnetUrl, relay?, token}] - tokens never leave through
// any route. This computer's own hub listens on loopback only, so other
// machines cannot call into it; it can still call out to them.

import fsp from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './store.mjs';
import { cleanDescriptor, relayFetch } from './relaylink.mjs';

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');

/**
 * A machine nobody named, by its hostname: a VM's "ubuntu-VMware-Virtual-
 * Platform" becomes "ubuntu", and Windows' made-up "DESKTOP-…" / "LAPTOP-…"
 * becomes "Windows 电脑" (1.2.168: Rocky listed the computer as "LAPTOP-…").
 */
export function friendlyHostname(hostname) {
  const h = String(hostname || '').trim();
  if (/^(DESKTOP|LAPTOP)-[A-Z0-9]{4,}$/i.test(h)) return 'Windows 电脑';
  return /^(.*?)-(vmware|virtualbox|virtual|platform)/i.exec(h)?.[1] || h;
}

/** A peer's relay address as a candidate base ("relay:<id>"), next to its URLs. */
const relayBase = (peer) => (peer?.relay ? `relay:${peer.relay.id}` : '');

export function createPeers({ file, fetchImpl = fetch, relayFetchImpl = relayFetch } = {}) {
  let peers = [];
  const rosters = new Map(); // name -> {at, bots}

  async function save() {
    await writeJsonAtomic(file, peers);
    try { await fsp.chmod(file, 0o600); } catch { /* Windows */ }
  }

  /** The peer a bot means: by machine name (any case, partial ok) or address. */
  function find(ref) {
    const r = String(ref || '').trim().toLowerCase();
    if (!r) return null;
    return peers.find((p) => p.name.toLowerCase() === r || clean(p.url).toLowerCase() === clean(r))
      || peers.find((p) => p.name.toLowerCase().includes(r) || r.includes(p.name.toLowerCase()))
      || null;
  }

  // The address that answered last, per machine (1.5.28): tried first next
  // time. A LAN address that cannot be reached from here (another network) made
  // every call wait for its timeout before trying the Tailscale one.
  const lastGood = new Map();

  /** One request to a peer: the address that worked last, else its LAN address, then its Tailscale address.
   *  `base` forces a single address (the machine list probes both in parallel). */
  async function call(peer, method, path, { body, raw, headers = {}, timeoutMs = 20000, signal, base, noRelay = false } = {}) {
    let lastErr = null;
    // The relay comes last (第 1 步原型): it works from anywhere, but it is the long way.
    const known = [peer.url, peer.tailnetUrl, noRelay ? '' : relayBase(peer)].filter(Boolean);
    if (base && typeof base === 'object') base = relayBase(peer) || undefined;
    const good = lastGood.get(peer.name);
    const bases = base ? [base] : (good && known.includes(good) ? [good, ...known.filter((b) => b !== good)] : known);
    for (const candidate of bases) {
      try {
        const send = candidate.startsWith('relay:') ? (_u, init) => relayFetchImpl(peer.relay, path, init) : fetchImpl;
        const res = await send(`${clean(candidate)}${path}`, {
          method,
          headers: { authorization: `Bearer ${peer.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`「${peer.name}」不认这台机器的凭据（需要在 Lamplit 客户端里重新配对那台机器）`), { code: 'PEER_UNAUTHORIZED' });
        if (known.includes(candidate)) lastGood.set(peer.name, candidate);
        // Which way it went (第 2 步: the desktop app says "through the relay").
        if (candidate.startsWith('relay:')) {
          try { Object.defineProperty(res, 'viaRelay', { value: true }); } catch { /* frozen */ }
        }
        return res;
      } catch (err) {
        if (err.code === 'PEER_UNAUTHORIZED' || signal?.aborted) throw err;
        lastErr = err;
      }
    }
    throw Object.assign(new Error(`连不上「${peer.name}」（${lastErr?.message || '没有可用地址'}）`), { code: 'PEER_UNREACHABLE' });
  }

  async function json(peer, method, path, opts) {
    const res = await call(peer, method, path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `「${peer.name}」返回 ${res.status}`), { code: data?.error?.code || 'PEER_ERROR' });
    return data;
  }

  return {
    async load() {
      const raw = await readJson(file, []);
      peers = Array.isArray(raw)
        ? raw.filter((p) => p && p.name && p.url && p.token).map((p) => {
          const relay = cleanDescriptor(p.relay);
          const { relay: _drop, ...rest } = p;
          return relay ? { ...rest, relay } : rest;
        })
        : [];
    },

    /** Replace the list (the desktop client sends it). */
    async set(list) {
      const before = new Map(peers.map((p) => [p.name, p]));
      peers = (Array.isArray(list) ? list : []).slice(0, 30).map((p) => {
        const name = String(p?.name || '').trim().slice(0, 60);
        // A relay address learned earlier stays when the list does not carry one.
        const relay = cleanDescriptor(p?.relay) || before.get(name)?.relay || null;
        return { name, url: clean(p?.url), tailnetUrl: clean(p?.tailnetUrl), ...(relay ? { relay } : {}), token: String(p?.token || '').trim() };
      }).filter((p) => p.name && /^https?:\/\//.test(p.url) && /^[A-Za-z0-9._~-]{8,200}$/.test(p.token));
      rosters.clear();
      await save();
      return this.list();
    },

    /** What a route or a bot may see: never the tokens. */
    list() {
      return peers.map((p) => ({ name: p.name, url: p.url, tailnetUrl: p.tailnetUrl || '', ...(p.relay ? { relay: p.relay } : {}) }));
    },

    /**
     * Ask every machine for its relay address while it is reachable (at home,
     * on Tailscale), so it can still be reached through the relay later. A
     * machine that turned its relay off is forgotten there too.
     */
    async learnRelays() {
      let changed = false;
      await Promise.all(peers.map(async (p) => {
        try {
          const res = await call(p, 'GET', '/api/relay-link', { timeoutMs: 6000 });
          if (!res.ok) return;
          const view = await res.json().catch(() => null);
          if (!view || typeof view !== 'object' || !('descriptor' in view)) return;
          const relay = cleanDescriptor(view.descriptor);
          if (JSON.stringify(relay || null) !== JSON.stringify(p.relay || null)) {
            if (relay) p.relay = relay; else delete p.relay;
            changed = true;
          }
        } catch { /* off or away: keep what we knew */ }
      }));
      if (changed) await save();
      return changed;
    },

    find,
    call,
    json,

    /** The bots on every peer (cached 5 min; unreachable peers are skipped). */
    async rosters({ fresh = false } = {}) {
      const out = [];
      await Promise.all(peers.map(async (p) => {
        const hit = rosters.get(p.name);
        if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) { out.push({ machine: p.name, bots: hit.bots }); return; }
        try {
          const data = await json(p, 'GET', '/api/bots', { timeoutMs: 5000 });
          const bots = (data.bots || data || []).map((b) => ({ id: b.id, name: b.name, role: b.role || '', primary: Boolean(b.primary) }));
          rosters.set(p.name, { at: Date.now(), bots });
          out.push({ machine: p.name, bots });
        } catch { /* off or away */ }
      }));
      return out;
    },
  };
}
