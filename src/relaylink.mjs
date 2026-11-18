// relaylink.mjs - this computer's side of the Lamplit relay (第 1 步原型).
//
// With 「通过中转连接」 on (off by default), the hub keeps one tunnel open to a
// relay (hub/relay/relay.mjs): an outgoing WebSocket over TLS, so the router
// needs nothing. Every connection a phone or another machine makes to
// `<this computer's id>.<anything>` on the relay arrives here as a stream of
// still-encrypted bytes. TLS ends HERE, with a self-signed certificate whose
// private key never leaves this computer (data/relay-tls/key.pem); the phone
// trusts it by its fingerprint, handed over when pairing. The relay can count
// bytes but cannot read them.
//
// Everything that arrives this way is remote: it goes to the same handler as
// the public (Funnel) socket, flagged viaPublic + viaRelay, so it never counts
// as "the human at this computer", the 8-digit code is refused, and a device
// token or one-time QR token is required - exactly like the public door.
//
// data/relay-link.json {enabled, host, port, relayFingerprint, join, id, key}
//   id   this computer's random name on the relay (in the phone's address)
//   key  its secret for holding that name; join: the relay's member secret
//   dial where the tunnel connects when that differs from the address phones
//        use (第 2 步: the Lamplit on the relay server itself dials 127.0.0.1)
// Both secrets stay in this file (mode 600) and only ever go to the pinned relay.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';

import { CONTROL_NAME, DEFAULT_PORT, ID_RE, certFingerprint, loadOrMakeIdentity, openTunnel, shieldStream } from '../hub/relay/relay.mjs';

/**
 * Is the relay at host:port there, and is it the one installed (its
 * certificate)? From this computer; nothing is sent but a health request.
 * -> {ok:true, ms, tunnels} | {ok:false, code, message}
 *   RELAY_UNREACHABLE    no answer: off, or the cloud firewall drops the port
 *   RELAY_CERT_MISMATCH  something else answers there
 */
export function checkRelay({ host, port, relayFingerprint, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let socket = null;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* gone */ }
      resolve(out);
    };
    timer = setTimeout(() => finish({ ok: false, code: 'RELAY_UNREACHABLE', message: 'no answer in time' }), timeoutMs);
    socket = tls.connect({ host, port: Number(port) || DEFAULT_PORT, servername: CONTROL_NAME, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.raw || certFingerprint(cert) !== String(relayFingerprint || '').toLowerCase()) {
        finish({ ok: false, code: 'RELAY_CERT_MISMATCH', message: 'something else answers on that port' });
        return;
      }
      socket.write(`GET /health HTTP/1.1\r\nHost: ${CONTROL_NAME}\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.on('data', (d) => {
      text += d;
      // The body may come chunked: look for the fields, not for clean JSON.
      const body = text.slice(text.indexOf('\r\n\r\n') + 4);
      if (/"relay"\s*:\s*"lamplit"/.test(body) && /"tunnels"\s*:\s*\d+/.test(body)) {
        finish({ ok: true, ms: Date.now() - started, tunnels: Number(/"tunnels"\s*:\s*(\d+)/.exec(body)[1]) });
      }
    });
    socket.on('error', (err) => finish({ ok: false, code: 'RELAY_UNREACHABLE', message: err.message }));
    socket.on('close', () => finish({ ok: false, code: 'RELAY_UNREACHABLE', message: 'connection closed' }));
  });
}

export const RELAY_SNI_SUFFIX = 'relay.lamplit';
const FP_RE = /^[0-9a-f]{64}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$|^\[?[0-9a-f:]+\]?$/i;

const isLoopbackIp = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip || ''));

/** The address a phone or another machine uses: {host, port, id, fp}. */
export function cleanDescriptor(d) {
  if (!d || typeof d !== 'object') return null;
  const host = String(d.host || '').trim().toLowerCase();
  const port = Number(d.port);
  const id = String(d.id || '').trim().toLowerCase();
  const fp = String(d.fp || '').trim().toLowerCase().replace(/:/g, '');
  if (!HOST_RE.test(host) || !(port > 0 && port < 65536) || !ID_RE.test(id) || !FP_RE.test(fp)) return null;
  return { host, port, id, fp };
}

/** Name this computer by when connecting through the relay. */
export const relayServerName = (id) => `${id}.${RELAY_SNI_SUFFIX}`;

/**
 * A TLS connection to computer `desc.id` through its relay, its certificate
 * checked against desc.fp BEFORE anything of ours is sent.
 */
export function connectViaRelay(desc, { timeoutMs = 10000 } = {}) {
  const d = cleanDescriptor(desc);
  if (!d) return Promise.reject(Object.assign(new Error('not a relay address'), { code: 'RELAY_BAD_ADDRESS' }));
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: d.host, port: d.port, servername: relayServerName(d.id), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('relay: no answer'), { code: 'RELAY_UNREACHABLE' })); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      if (!cert?.raw || certFingerprint(cert) !== d.fp) {
        socket.destroy();
        reject(Object.assign(new Error('that computer presented a different certificate'), { code: 'RELAY_CERT_MISMATCH' }));
        return;
      }
      resolve(socket);
    });
    // After the handshake an error belongs to whoever uses the socket; before it, it is ours.
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err?.code ? err : Object.assign(new Error(err?.message || 'relay connection failed'), { code: 'RELAY_UNREACHABLE' }));
    });
  });
}

/**
 * fetch() for a machine reached through the relay: same call shape, returns a
 * real Response. The request is written only after the certificate matched.
 */
export function relayFetch(desc, urlPath, { method = 'GET', headers = {}, body, signal } = {}) {
  const d = cleanDescriptor(desc);
  if (!d) return Promise.reject(Object.assign(new Error('not a relay address'), { code: 'RELAY_BAD_ADDRESS' }));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
    const plain = {};
    for (const [k, v] of headers instanceof Headers ? headers.entries() : Object.entries(headers || {})) if (v !== undefined) plain[k] = v;
    plain.host = relayServerName(d.id);
    const req = http.request({
      method,
      path: urlPath,
      headers: plain,
      createConnection: (_opts, cb) => { connectViaRelay(d).then((s) => cb(null, s), (err) => cb(err)); },
    });
    const abort = () => req.destroy(signal.reason || new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', (err) => { signal?.removeEventListener('abort', abort); reject(err); });
    req.on('response', (res) => {
      const out = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        try { out.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* skip odd header */ }
      }
      const status = res.statusCode || 502;
      const noBody = method === 'HEAD' || status === 204 || status === 304;
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage, headers: out }));
    });
    if (body === undefined || body === null) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(body);
    else if (typeof body.getReader === 'function') Readable.fromWeb(body).pipe(req);
    else if (typeof body.pipe === 'function') body.pipe(req);
    else req.end(String(body));
  });
}

/**
 * A plain-HTTP door on this computer's loopback to a machine behind the relay
 * (1.5.36: the desktop window opens a machine that only the relay reaches).
 * Each connection to host:port becomes a pinned TLS connection through the
 * relay (connectViaRelay), bytes copied both ways - what the phone app's
 * forwarder does. Each machine gets its own loopback address (127.0.0.2, .3 …)
 * so cookies of different machines never mix. Whoever uses the door still
 * needs that machine's login: through the relay it treats every request as remote.
 * -> Promise<{url, host, port, close()}>
 */
export function openRelayForwarder(desc, { host = '127.0.0.2', port = 0 } = {}) {
  const d = cleanDescriptor(desc);
  if (!d) return Promise.reject(Object.assign(new Error('not a relay address'), { code: 'RELAY_BAD_ADDRESS' }));
  const server = net.createServer({ allowHalfOpen: true }, (inner) => {
    inner.on('error', () => {});
    inner.pause();
    connectViaRelay(d).then((outer) => {
      outer.on('error', () => inner.destroy());
      inner.on('error', () => outer.destroy());
      inner.pipe(outer);
      outer.pipe(inner);
      inner.resume();
    }, () => inner.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({ url: `http://${host}:${p}`, host, port: p, close: () => server.close() });
    });
  });
}

// ---------------------------------------------------------------------------
// The link: settings, the tunnel, and the TLS end of every relayed connection
// ---------------------------------------------------------------------------

export function createRelayLink({ dataDir, handler, upgrade, log = (line) => console.error(`[relay-link] ${line}`), openTunnelImpl = openTunnel, replacedWaitMs = 60000 } = {}) {
  const file = path.join(dataDir, 'relay-link.json');
  let cfg = readConfig();
  let identity = null;
  let secureContext = null;
  let wanted = false;
  let tunnel = null;
  let retryTimer = null;
  let attempt = 0;
  const status = { state: 'off', error: '', since: null, connectedAt: null, lastError: null, connections: 0, bytesIn: 0, bytesOut: 0, replaced: false };

  // The relayed requests are served by this http server: it never listens,
  // it is handed TLS sockets that already finished their handshake here.
  const server = http.createServer(handler);
  if (upgrade) server.on('upgrade', upgrade);
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });

  function readConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function saveConfig() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  }

  function ensureIdentity() {
    if (identity) return identity;
    identity = loadOrMakeIdentity(path.join(dataDir, 'relay-tls'), 'lamplit');
    secureContext = tls.createSecureContext({ key: identity.key, cert: identity.cert });
    return identity;
  }

  function ensureMachineSecrets() {
    let changed = false;
    if (!ID_RE.test(String(cfg.id || ''))) {
      // 26 base32 characters: 130 random bits, lower case, DNS-label safe.
      const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
      cfg.id = Array.from(crypto.randomBytes(26), (b) => alphabet[b & 31]).join('');
      changed = true;
    }
    if (String(cfg.key || '').length < 32) {
      cfg.key = crypto.randomBytes(32).toString('base64url');
      changed = true;
    }
    if (changed) saveConfig();
  }

  const configured = () => Boolean(cfg.host && cfg.port && FP_RE.test(String(cfg.relayFingerprint || '')));

  /** One relayed connection: finish TLS here, then hand it to the hub's handler. */
  function acceptStream(stream) {
    ensureIdentity();
    status.connections += 1;
    const ip = String(stream.meta?.ip || '');
    // Never loopback: whatever the relay says, this is somebody remote.
    const shown = net.isIP(ip) && !isLoopbackIp(ip) ? ip : 'relay';
    const sock = new tls.TLSSocket(shieldStream(stream), { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => sock.destroy(), 15000);
    sock.on('error', () => sock.destroy());
    stream.on('error', () => {});
    sock.once('secure', () => {
      clearTimeout(timer);
      Object.defineProperty(sock, 'remoteAddress', { value: shown, configurable: true });
      Object.defineProperty(sock, 'remotePort', { value: 0, configurable: true });
      sock.viaRelay = true;
      server.emit('connection', sock);
    });
    // The hub is done with this connection: the shield sends what is left, then closes.
    sock.once('close', () => clearTimeout(timer));
  }

  function schedule(ms) {
    clearTimeout(retryTimer);
    if (!wanted) return;
    retryTimer = setTimeout(connect, ms);
    retryTimer.unref?.();
  }

  /** Backoff: 1, 2, 4 … 60 s (with jitter); an auth or certificate problem waits 5 min. */
  function backoff(code) {
    attempt += 1;
    if (code === 'RELAY_UNAUTHORIZED' || code === 'RELAY_CERT_MISMATCH') return 5 * 60 * 1000;
    if (status.replaced) return replacedWaitMs;
    const base = Math.min(60000, 1000 * 2 ** Math.min(attempt - 1, 6));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  let connecting = false;
  async function connect() {
    if (!wanted || tunnel || connecting) return;
    if (!configured()) { status.state = 'unconfigured'; return; }
    connecting = true;
    try {
      await connectOnce();
    } finally {
      connecting = false;
    }
  }

  async function connectOnce() {
    ensureIdentity();
    ensureMachineSecrets();
    status.state = 'connecting';
    try {
      const t = await openTunnelImpl({ host: cfg.dial || cfg.host, port: Number(cfg.port) || DEFAULT_PORT, relayFingerprint: cfg.relayFingerprint, id: cfg.id, key: cfg.key, join: cfg.join || '' });
      if (!wanted) { t.mux.close(); return; }
      tunnel = t;
      const upAt = Date.now();
      status.state = 'online';
      status.error = '';
      status.replaced = false;
      status.connectedAt = new Date().toISOString();
      log(`tunnel up to ${cfg.host}:${cfg.port} as ${cfg.id.slice(0, 6)}…`);
      t.mux.on('stream', acceptStream);
      t.mux.on('control', (msg) => {
        if (msg?.type === 'replaced') {
          // Another computer holds this id now (a copied data folder?): back off.
          status.replaced = true;
          log('another tunnel with this id replaced ours');
        }
      });
      // The client pings too: a NAT that silently dropped the connection is noticed.
      const beat = setInterval(() => {
        if (Date.now() - t.ws.lastHeard > 60000) { t.mux.close(); return; }
        t.ws.ping();
      }, 25000);
      beat.unref?.();
      t.mux.on('close', () => {
        clearInterval(beat);
        status.bytesIn += t.mux.bytesIn;
        status.bytesOut += t.mux.bytesOut;
        tunnel = null;
        if (!wanted) { status.state = 'off'; return; }
        status.state = 'connecting';
        // A tunnel that stayed up a while starts the backoff over.
        if (Date.now() - upAt > 30000) attempt = 0;
        log('tunnel closed; reconnecting');
        schedule(backoff(status.replaced ? 'replaced' : ''));
      });
    } catch (err) {
      status.state = 'error';
      status.error = err.code || 'RELAY_UNREACHABLE';
      status.lastError = { code: status.error, message: err.message, at: new Date().toISOString() };
      log(`tunnel failed: ${err.code || ''} ${err.message}`);
      schedule(backoff(err.code));
    }
  }

  function start() {
    wanted = Boolean(cfg.enabled);
    if (!wanted) { status.state = 'off'; return; }
    status.since = new Date().toISOString();
    attempt = 0;
    connect();
  }

  function stop() {
    wanted = false;
    clearTimeout(retryTimer);
    if (tunnel) tunnel.mux.close();
    tunnel = null;
    status.state = 'off';
  }

  return {
    server,
    start,
    stop,
    acceptStream,
    /** What Settings shows (no secrets). */
    view() {
      return {
        enabled: Boolean(cfg.enabled),
        host: cfg.host || '',
        port: Number(cfg.port) || DEFAULT_PORT,
        relayFingerprint: cfg.relayFingerprint || '',
        hasJoin: Boolean(cfg.join),
        dial: cfg.dial || '',
        id: cfg.id || '',
        fingerprint: cfg.id ? ensureIdentity().fingerprint : '',
        state: status.state,
        error: status.error,
        lastError: status.lastError,
        connectedAt: status.connectedAt,
        connections: status.connections,
        bytesIn: status.bytesIn + (tunnel?.mux.bytesIn || 0),
        bytesOut: status.bytesOut + (tunnel?.mux.bytesOut || 0),
      };
    },
    /** What another of the owner's machines needs to join the same relay (secret: only for the share route). */
    shareable() {
      if (!configured() || !cfg.join) return null;
      return { host: cfg.host, port: Number(cfg.port), relayFingerprint: cfg.relayFingerprint, join: cfg.join };
    },
    /** How a phone or a machine reaches this computer: null while off. */
    descriptor() {
      if (!cfg.enabled || !configured() || !ID_RE.test(String(cfg.id || ''))) return null;
      return { host: cfg.host, port: Number(cfg.port), id: cfg.id, fp: ensureIdentity().fingerprint };
    },
    /** Waiting out the backoff (the port was just opened): try now. */
    retryNow() {
      if (!wanted || tunnel || connecting) return;
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    },
    /** Can this computer reach its relay now? (checkRelay with the settings here) */
    check() {
      if (!configured()) return Promise.resolve({ ok: false, code: 'RELAY_NOT_CONFIGURED', message: 'no relay set up' });
      return checkRelay({ host: cfg.dial || cfg.host, port: cfg.port, relayFingerprint: cfg.relayFingerprint });
    },
    /**
     * Forget the relay (it was uninstalled): off, its address and join secret
     * gone. This computer's own id, key and certificate stay, so a phone that
     * paired before still knows it when a relay comes back.
     */
    forget() {
      stop();
      const { host: _h, port: _p, relayFingerprint: _f, join: _j, dial: _d, ...rest } = cfg;
      cfg = { ...rest, enabled: false, updatedAt: new Date().toISOString() };
      saveConfig();
      status.state = 'off';
      status.error = '';
      status.lastError = null;
      return this.view();
    },
    /** Change the settings; secrets that are not given are kept. Restarts the tunnel. */
    configure(patch = {}) {
      const next = { ...cfg };
      if (patch.dial !== undefined) {
        const dial = String(patch.dial || '').trim().toLowerCase();
        if (dial && !HOST_RE.test(dial)) throw Object.assign(new Error('relay dial host is not a host name or IP'), { code: 'RELAY_BAD_HOST' });
        next.dial = dial;
      }
      if (patch.host !== undefined) {
        const host = String(patch.host || '').trim().toLowerCase();
        if (host && !HOST_RE.test(host)) throw Object.assign(new Error('relay host is not a host name or IP'), { code: 'RELAY_BAD_HOST' });
        next.host = host;
      }
      if (patch.port !== undefined) {
        const port = Number(patch.port);
        if (!(port > 0 && port < 65536)) throw Object.assign(new Error('relay port must be 1-65535'), { code: 'RELAY_BAD_PORT' });
        next.port = port;
      }
      if (patch.relayFingerprint !== undefined) {
        const fp = String(patch.relayFingerprint || '').trim().toLowerCase().replace(/:/g, '');
        if (fp && !FP_RE.test(fp)) throw Object.assign(new Error('relay fingerprint must be 64 hex characters'), { code: 'RELAY_BAD_FINGERPRINT' });
        next.relayFingerprint = fp;
      }
      if (patch.join !== undefined && String(patch.join).trim()) next.join = String(patch.join).trim().slice(0, 200);
      if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
      if (next.enabled && !(next.host && next.port && FP_RE.test(String(next.relayFingerprint || '')))) {
        throw Object.assign(new Error('fill in the relay address and its fingerprint first'), { code: 'RELAY_NOT_CONFIGURED' });
      }
      const moved = next.host !== cfg.host || next.port !== cfg.port || next.relayFingerprint !== cfg.relayFingerprint || next.join !== cfg.join || (next.dial || '') !== (cfg.dial || '');
      cfg = { ...next, updatedAt: new Date().toISOString() };
      if (cfg.enabled) { ensureIdentity(); ensureMachineSecrets(); }
      saveConfig();
      if (moved || !cfg.enabled) stop();
      if (cfg.enabled && !tunnel) start();
      return this.view();
    },
  };
}

export const RELAY_CONTROL_NAME = CONTROL_NAME;
