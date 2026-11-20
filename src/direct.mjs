// direct.mjs - 直连 (1.5.46): a phone (or another of the owner's machines)
// and this computer talk over UDP directly when they can, instead of through
// the relay.
//
// How the two find each other (hole punching), with no extra service:
//   1. Each asks the relay "at which address do you see me?" (STUN, relay.mjs).
//   2. The dialing side sends its addresses ("candidates") and half a key to the
//      computer through the relay, INSIDE the TLS connection that is pinned to
//      the computer's certificate - the relay sees ciphertext only. The route
//      needs a paired device's token, so the relay can never introduce a
//      stranger (POST /api/direct/offer in server.mjs).
//   3. Both send small encrypted probes to each other's addresses at once. The
//      first probe answered picks the path; each router has seen its own side
//      send first, so it lets the other's packets in.
//   4. Nothing answered within a few seconds (both behind symmetric NAT, UDP
//      blocked): nothing changes, the relay keeps carrying everything.
//
// The channel: every datagram is AES-256-GCM sealed with a key both halves
// made (HKDF), one key per direction, a counter as nonce and a replay window.
// Inside it: reliable, ordered delivery (sequence numbers, ACK + SACK,
// retransmission, slow start and AIMD) carrying the SAME stream multiplexer
// the relay tunnel uses (relay.mjs Mux). Each stream carries the SAME TLS as
// through the relay, pinned to the computer's certificate, ending in the same
// handler, counted as remote. So direct changes the road, not who may do what.
//
// The phone app does the dialing side in Java (DirectChannel.java), byte for
// byte the same protocol; scripts/smoke-direct.mjs and the Java interop test
// keep the two in step.
//
// Datagram: 0xD1 | session id (8) | counter (8, big-endian) | AES-GCM(type | body) | tag (16)
//   PROBE 0x01 nonce(8)        PROBE_ACK 0x02 nonce(8)     SELECT 0x03
//   DATA 0x10 seq(4) bytes     ACK 0x11 next(4) window(2) n(1) [from(4) to(4)]*n   (to: exclusive)
//   PING 0x20 time(4)          PONG 0x21 time(4)           CLOSE 0x30
// The byte stream carries messages as [length (4)][Mux frame].

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';

import { Mux, isStun, parseStunAnswer, stunRequest } from '../hub/relay/relay.mjs';

export const MAGIC = 0xd1;
const HEADER = 17;
const TAG = 16;
/** Fits the smallest IPv6 path (1280) with room for the IP and UDP headers. */
export const MAX_PACKET = 1232;
const MSS = MAX_PACKET - HEADER - TAG - 1 - 4;
export const PT = { PROBE: 0x01, PROBE_ACK: 0x02, SELECT: 0x03, DATA: 0x10, ACK: 0x11, PING: 0x20, PONG: 0x21, CLOSE: 0x30 };
const KEY_INFO = Buffer.from('lamplit-direct v1');
const MAX_MESSAGE = 2 * 1024 * 1024;
const RECV_WINDOW = 2048; // packets held out of order (about 2.4 MB)
const MAX_CANDIDATES = 8;

export const DEFAULT_SESSION = {
  punchMs: 8000, // give up punching after this
  probeEveryMs: 200,
  pingMs: 10000, // a heartbeat keeps the routers' mappings alive (mobile NATs forget UDP in ~30 s)
  deadMs: 25000, // nothing heard this long: the path is gone
  idleMs: 5 * 60 * 1000, // no streams this long: close (the next connection punches again)
};

// ---------------------------------------------------------------------------
// Keys and sealing
// ---------------------------------------------------------------------------

/** Both halves (32 bytes each) and the session id -> {c2s, s2c}: one key per direction. */
export function deriveKeys(clientHalf, serverHalf, sid) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([clientHalf, serverHalf]), sid, KEY_INFO, 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32, 64) };
}

function nonceFor(counter) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  return iv;
}

export function sealPacket(key, sid, counter, plain) {
  const header = Buffer.alloc(HEADER);
  header[0] = MAGIC;
  sid.copy(header, 1, 0, 8);
  header.writeBigUInt64BE(BigInt(counter), 9);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(counter));
  c.setAAD(header);
  const body = c.update(plain);
  c.final();
  return Buffer.concat([header, body, c.getAuthTag()]);
}

/** -> {counter, plain} or null (not ours, changed on the way, wrong key). */
export function openPacket(key, packet) {
  if (!packet || packet.length < HEADER + TAG + 1 || packet[0] !== MAGIC) return null;
  const counter = Number(packet.readBigUInt64BE(9));
  if (!Number.isSafeInteger(counter)) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(counter));
    d.setAAD(packet.subarray(0, HEADER));
    d.setAuthTag(packet.subarray(packet.length - TAG));
    const plain = Buffer.concat([d.update(packet.subarray(HEADER, packet.length - TAG)), d.final()]);
    return { counter, plain };
  } catch {
    return null;
  }
}

/** Counters seen recently: each one is taken once; older than the window, never. */
export class ReplayWindow {
  constructor(size = 1024) {
    this.size = size;
    this.max = -1;
    this.seen = new Uint8Array(size);
  }

  accept(n) {
    if (n > this.max) {
      if (n - this.max >= this.size) this.seen.fill(0);
      else for (let i = this.max + 1; i <= n; i += 1) this.seen[i % this.size] = 0;
      this.max = n;
      this.seen[n % this.size] = 1;
      return true;
    }
    if (this.max - n >= this.size || this.seen[n % this.size]) return false;
    this.seen[n % this.size] = 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function v4Bad(a) {
  const p = a.split('.').map(Number);
  return p[0] === 0 || p[0] >= 224 || (p[0] === 169 && p[1] === 254);
}

/**
 * Addresses the other side gave -> [{address, port}], at most 8. Never
 * 0.0.0.0, broadcast, multicast, link-local or a name; loopback only in tests.
 */
export function cleanCandidates(list, { allowLoopback = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_CANDIDATES) break;
    const address = String(c?.a ?? c?.address ?? '').trim().toLowerCase();
    const port = Number(c?.p ?? c?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const kind = net.isIP(address);
    if (!kind) continue;
    if (kind === 4 && (v4Bad(address) || (!allowLoopback && address.startsWith('127.')))) continue;
    if (kind === 6 && (/^(::|::1)$/.test(address) ? !(allowLoopback && address === '::1') : /^(fe[89ab]|ff)/.test(address))) continue;
    const key = `${address}|${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, port });
  }
  return out;
}

/** This machine's own addresses worth offering: LAN IPv4, global or LAN IPv6. Not Tailscale's, not Clash's TUN. */
export function localAddresses(interfaces = os.networkInterfaces) {
  const out = [];
  const all = typeof interfaces === 'function' ? interfaces() : interfaces;
  const list = Array.isArray(all) ? all : Object.values(all || {}).flat();
  for (const a of list) {
    if (!a || a.internal) continue;
    const address = String(a.address || '').toLowerCase();
    const fam = a.family === 6 || a.family === 'IPv6' ? 6 : 4;
    if (fam === 4) {
      const p = address.split('.').map(Number);
      if (p.length !== 4 || v4Bad(address) || p[0] === 127) continue;
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) continue; // Tailscale / carrier NAT: never reachable this way
      if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) continue; // Clash and other TUN proxies
    } else if (!/^[23]|^f[cd]/.test(address)) continue; // global, or a home ULA
    out.push({ address, family: fam });
  }
  return out.slice(0, 6);
}

// ---------------------------------------------------------------------------
// One UDP endpoint (a socket per address family), many sessions
// ---------------------------------------------------------------------------

export class DirectEndpoint extends EventEmitter {
  constructor({ createSocket = (type) => dgram.createSocket({ type }), interfaces = os.networkInterfaces, ipv6 = true, bindHost = '' } = {}) {
    super();
    this.createSocket = createSocket;
    this.interfaces = interfaces;
    this.ipv6 = ipv6;
    this.bindHost = bindHost;
    this.sockets = {};
    this.sessions = new Map();
    this.stunWaits = new Map();
    this.closed = false;
  }

  async bind() {
    if (this.sockets.v4) return;
    const open = (type, host) => new Promise((resolve) => {
      let s;
      try { s = this.createSocket(type); } catch { resolve(null); return; }
      s.once('error', () => resolve(null));
      s.on('message', (m, r) => this._message(m, r));
      try {
        const done = () => { s.removeAllListeners('error'); s.on('error', () => {}); s.unref?.(); resolve(s); };
        if (host) s.bind(0, host, done); else s.bind(0, done);
      } catch { resolve(null); }
    });
    this.sockets.v4 = await open('udp4', this.bindHost && net.isIPv4(this.bindHost) ? this.bindHost : '');
    if (!this.sockets.v4) throw Object.assign(new Error('no UDP socket'), { code: 'DIRECT_NO_SOCKET' });
    if (this.ipv6) this.sockets.v6 = await open('udp6', '');
  }

  get port() { return this.sockets.v4?.address().port || 0; }

  get port6() { try { return this.sockets.v6?.address().port || 0; } catch { return 0; } }

  sendTo(buf, to) {
    const s = net.isIPv6(to.address) ? this.sockets.v6 : this.sockets.v4;
    if (!s || this.closed) return;
    try { s.send(buf, to.port, to.address); } catch { /* gone */ }
  }

  _message(msg, rinfo) {
    const from = { address: String(rinfo.address).replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1'), port: rinfo.port };
    if (msg.length && msg[0] === MAGIC) {
      if (msg.length < HEADER + TAG + 1) return;
      const s = this.sessions.get(msg.subarray(1, 9).toString('hex'));
      if (s) s._receive(msg, from);
      return;
    }
    if (isStun(msg)) {
      const txid = msg.subarray(8, 20).toString('hex');
      const wait = this.stunWaits.get(txid);
      if (!wait) return;
      const got = parseStunAnswer(msg, msg.subarray(8, 20));
      if (got) { this.stunWaits.delete(txid); wait(got); }
    }
  }

  /** Ask a relay's STUN which outside address this endpoint has. -> {address, port} | null */
  stun(host, port, { timeoutMs = 1500, tries = 3 } = {}) {
    return new Promise((resolve) => {
      const { buf, txid } = stunRequest();
      const key = Buffer.from(txid).toString('hex');
      let n = 0;
      let timer = null;
      const done = (v) => { clearTimeout(timer); this.stunWaits.delete(key); resolve(v); };
      this.stunWaits.set(key, done);
      const send = () => {
        if (!this.stunWaits.has(key)) return;
        if (n >= tries) { done(null); return; }
        n += 1;
        try { this.sockets.v4.send(buf, Number(port), host); } catch { /* resolve below */ }
        timer = setTimeout(send, Math.round(timeoutMs / tries));
        timer.unref?.();
      };
      send();
    });
  }

  /** This endpoint's candidates: its LAN addresses, then the outside one STUN gave. */
  candidates(outside) {
    const out = [];
    for (const a of localAddresses(this.interfaces)) {
      const port = a.family === 6 ? this.port6 : this.port;
      if (port) out.push({ a: a.address, p: port, k: 'host' });
    }
    if (outside?.address) out.push({ a: outside.address, p: outside.port, k: 'srflx' });
    return out.slice(0, MAX_CANDIDATES);
  }

  createSession(opts) {
    const s = new DirectSession(this, opts);
    this.sessions.set(s.sidHex, s);
    s.once('close', () => { if (this.sessions.get(s.sidHex) === s) this.sessions.delete(s.sidHex); });
    return s;
  }

  close() {
    if (this.closed) return;
    for (const s of [...this.sessions.values()]) s.close('closed');
    this.closed = true;
    for (const s of Object.values(this.sockets)) { try { s?.close(); } catch { /* closed */ } }
    this.sockets = {};
  }
}

// ---------------------------------------------------------------------------
// One session: punching, then a reliable message channel (WsConn-shaped for Mux)
// ---------------------------------------------------------------------------

const now = () => Date.now();

export class DirectSession extends EventEmitter {
  /**
   * {sid: Buffer(8), role: 'client'|'server', sendKey, recvKey, candidates: [{address, port}], options}
   */
  constructor(endpoint, { sid, role, sendKey, recvKey, candidates = [], options = {} }) {
    super();
    this.setMaxListeners(0); // every stream of a busy channel waits for 'drain'
    this.endpoint = endpoint;
    this.sid = sid;
    this.sidHex = sid.toString('hex');
    this.role = role;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.cands = candidates;
    this.o = { ...DEFAULT_SESSION, ...options };
    this.state = 'punching';
    this.remote = null;
    this.reason = '';
    this.counter = 0;
    this.window = new ReplayWindow();
    this.heard = false; // any authentic packet at all
    this.lastHeard = now();
    this.lastSent = now();
    this.startedAt = now();
    this.upAt = 0;
    this.nonce = crypto.randomBytes(8);
    // sending
    this.queue = [];
    this.queued = 0;
    this.nextSeq = 0;
    this.inflight = new Map(); // seq -> {data, sentAt, tries}
    this.inflightBytes = 0;
    this.cwnd = 16;
    this.ssthresh = 512;
    this.peerWindow = 256;
    this.recoverUntil = 0;
    this.srtt = 0;
    this.rttvar = 0;
    this.rto = 1000;
    this.drainWanted = false;
    // receiving
    this.expected = 0;
    this.rbuf = new Map();
    this.ackOwed = 0;
    this.ackAt = 0;
    this.inBuf = Buffer.alloc(0);
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.idleSince = now();
    this.timer = setInterval(() => this._tick(), 20);
    this.timer.unref?.();
    this._probe();
  }

  // --- WsConn shape (what Mux uses) ------------------------------------------

  get needDrain() {
    const full = this.queued + this.inflightBytes > 1024 * 1024;
    if (full) this.drainWanted = true;
    return full;
  }

  send(message) {
    if (this.state === 'closed') return false;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(message.length, 0);
    this.queue.push(head, message);
    this.queued += 4 + message.length;
    this._pump();
    return !this.needDrain;
  }

  ping() { this._raw(PT.PING, this._time()); }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    if (this.remote) { this._raw(PT.CLOSE); this._raw(PT.CLOSE); }
    this.state = 'closed';
    this.reason = this.reason || reason;
    clearInterval(this.timer);
    this.inflight.clear();
    this.queue = [];
    this.emit('close', this.reason);
  }

  // --- packets ---------------------------------------------------------------

  _time() {
    const b = Buffer.alloc(4);
    b.writeUInt32BE((now() - this.startedAt) >>> 0, 0);
    return b;
  }

  _raw(type, body = Buffer.alloc(0), to = this.remote) {
    if (!to || this.state === 'closed') return;
    const plain = Buffer.concat([Buffer.from([type]), body]);
    const packet = sealPacket(this.sendKey, this.sid, this.counter++, plain);
    this.lastSent = now();
    if (this.o.dropRate && Math.random() < this.o.dropRate) return; // tests: a lossy path
    this.endpoint.sendTo(packet, to);
  }

  _probeBody() {
    return Buffer.concat([this.nonce, Buffer.from([this.role === 'client' ? 1 : 0])]);
  }

  _probe() {
    if (this.state !== 'punching') return;
    const body = this._probeBody();
    for (const c of this.cands) this._raw(PT.PROBE, body, c);
    this.nextProbe = now() + this.o.probeEveryMs;
  }

  _up(to) {
    this.remote = to;
    this.state = 'up';
    this.upAt = now();
    this.idleSince = now();
    this.emit('up', to);
    this._pump();
  }

  _receive(packet, from) {
    if (this.state === 'closed') return;
    const opened = openPacket(this.recvKey, packet);
    if (!opened) return;
    const newest = opened.counter > this.window.max;
    if (!this.window.accept(opened.counter)) return;
    this.heard = true;
    this.lastHeard = now();
    const type = opened.plain[0];
    const body = opened.plain.subarray(1);
    if (type === PT.PROBE) {
      if (body.length >= 8) this._raw(PT.PROBE_ACK, body.subarray(0, 8), from);
      // A probe from an address the other side never listed: its router gave it
      // a new port for us (symmetric NAT). Probe back there too ("peer-reflexive").
      if (this.state === 'punching' && this.cands.length < MAX_CANDIDATES + 4 && !this.cands.some((c) => c.address === from.address && c.port === from.port)) {
        this.cands.push(from);
        this._raw(PT.PROBE, this._probeBody(), from);
      }
      return;
    }
    if (type === PT.PROBE_ACK) {
      // The dialing side picks the path: the first of its probes answered.
      if (this.role === 'client' && this.state === 'punching' && body.subarray(0, 8).equals(this.nonce)) {
        this._up(from);
        for (let i = 0; i < 3; i += 1) setTimeout(() => this._raw(PT.SELECT), i * 100).unref?.();
      }
      return;
    }
    if (type === PT.CLOSE) { this.close('closed by the other side'); return; }
    // Anything else: the path is chosen. The computer takes it from the first such
    // packet; later, the newest authentic packet's address wins (a NAT that
    // gave the phone a new port, a phone that changed network inside one NAT).
    if (this.state === 'punching') {
      if (this.role === 'client') return;
      this._up(from);
    } else if (newest && (from.address !== this.remote.address || from.port !== this.remote.port)) {
      this.remote = from;
    }
    if (type === PT.SELECT) return;
    if (type === PT.PING) { this._raw(PT.PONG, body.subarray(0, 4)); return; }
    if (type === PT.PONG) return;
    if (type === PT.DATA && body.length >= 4) { this._data(body.readUInt32BE(0), body.subarray(4)); return; }
    if (type === PT.ACK && body.length >= 7) this._ack(body);
  }

  // --- sending: window, retransmission ---------------------------------------

  _take(n) {
    const parts = [];
    let left = n;
    while (left > 0 && this.queue.length) {
      const head = this.queue[0];
      if (head.length <= left) { parts.push(head); this.queue.shift(); left -= head.length; } else { parts.push(head.subarray(0, left)); this.queue[0] = head.subarray(left); left = 0; }
    }
    const out = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.queued -= out.length;
    return out;
  }

  _pump() {
    if (this.state !== 'up') return;
    while (this.queued > 0 && this.inflight.size < Math.min(Math.floor(this.cwnd), this.peerWindow)) {
      const data = this._take(MSS);
      const seq = this.nextSeq++;
      this.inflight.set(seq, { data, sentAt: now(), tries: 0 });
      this.inflightBytes += data.length;
      this._sendData(seq, data);
    }
  }

  _sendData(seq, data) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq >>> 0, 0);
    this._raw(PT.DATA, Buffer.concat([head, data]));
    this.bytesOut += data.length;
  }

  _acked(seq, entry, t, sample) {
    this.inflight.delete(seq);
    this.inflightBytes -= entry.data.length;
    if (this.cwnd < this.ssthresh) this.cwnd += 1; else this.cwnd += 1 / this.cwnd;
    if (this.cwnd > 4096) this.cwnd = 4096;
    if (sample && entry.tries === 0) {
      const r = t - entry.sentAt;
      if (!this.srtt) { this.srtt = r; this.rttvar = r / 2; } else {
        this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
        this.srtt = 0.875 * this.srtt + 0.125 * r;
      }
      this.rto = Math.min(4000, Math.max(200, this.srtt + 4 * this.rttvar));
    }
  }

  _ack(body) {
    const t = now();
    const next = body.readUInt32BE(0);
    this.peerWindow = Math.max(1, body.readUInt16BE(4));
    const n = Math.min(body[6], Math.floor((body.length - 7) / 8));
    let highest = -1;
    let highestSent = 0;
    const take = (seq) => {
      const e = this.inflight.get(seq);
      if (!e) return;
      if (seq > highest) { highest = seq; highestSent = e.sentAt; }
      this._acked(seq, e, t, true);
    };
    for (const seq of [...this.inflight.keys()]) {
      if (seq >= next) break;
      take(seq);
    }
    for (let i = 0; i < n; i += 1) {
      const from = body.readUInt32BE(7 + i * 8);
      const to = body.readUInt32BE(11 + i * 8);
      for (let s = from; s < to && s - from < RECV_WINDOW; s += 1) take(s);
    }
    // Fast retransmit: anything three below a packet that arrived, sent before it, was lost.
    if (highest >= 0) {
      for (const [seq, e] of this.inflight) {
        if (seq + 3 > highest) break;
        if (e.sentAt >= highestSent) continue;
        this._lost(seq);
        e.sentAt = t;
        e.tries += 1;
        this._sendData(seq, e.data);
      }
    }
    this._pump();
    if (this.drainWanted && !this.needDrain) { this.drainWanted = false; this.emit('drain'); }
  }

  _lost(seq) {
    if (seq < this.recoverUntil) return; // one cut per window
    this.ssthresh = Math.max(this.cwnd / 2, 4);
    this.cwnd = this.ssthresh;
    this.recoverUntil = this.nextSeq;
  }

  // --- receiving --------------------------------------------------------------

  _data(seq, data) {
    if (seq < this.expected || this.rbuf.has(seq)) { this.ackOwed = 2; this._sendAck(); return; }
    if (seq >= this.expected + RECV_WINDOW) return;
    this.rbuf.set(seq, data);
    const inOrder = seq === this.expected;
    while (this.rbuf.has(this.expected)) {
      const d = this.rbuf.get(this.expected);
      this.rbuf.delete(this.expected);
      this.expected += 1;
      this._deliver(d);
      if (this.state === 'closed') return;
    }
    this.ackOwed += 1;
    if (!inOrder || this.ackOwed >= 2) this._sendAck();
    else if (!this.ackAt) this.ackAt = now() + 10;
  }

  _sendAck() {
    this.ackOwed = 0;
    this.ackAt = 0;
    const ranges = [];
    if (this.rbuf.size) {
      const keys = [...this.rbuf.keys()].sort((a, b) => a - b);
      let from = keys[0];
      let prev = keys[0];
      for (let i = 1; i <= keys.length && ranges.length < 16; i += 1) {
        if (i < keys.length && keys[i] === prev + 1) { prev = keys[i]; continue; }
        ranges.push([from, prev + 1]);
        if (i < keys.length) { from = keys[i]; prev = keys[i]; }
      }
    }
    const body = Buffer.alloc(7 + ranges.length * 8);
    body.writeUInt32BE(this.expected >>> 0, 0);
    body.writeUInt16BE(Math.max(1, Math.min(0xffff, RECV_WINDOW - this.rbuf.size)), 4);
    body[6] = ranges.length;
    ranges.forEach(([f, t], i) => { body.writeUInt32BE(f >>> 0, 7 + i * 8); body.writeUInt32BE(t >>> 0, 11 + i * 8); });
    this._raw(PT.ACK, body);
  }

  _deliver(data) {
    this.bytesIn += data.length;
    this.inBuf = this.inBuf.length ? Buffer.concat([this.inBuf, data]) : data;
    while (this.inBuf.length >= 4) {
      const len = this.inBuf.readUInt32BE(0);
      if (len > MAX_MESSAGE) { this.close('message too large'); return; }
      if (this.inBuf.length < 4 + len) return;
      const msg = Buffer.from(this.inBuf.subarray(4, 4 + len));
      this.inBuf = this.inBuf.subarray(4 + len);
      this.emit('message', msg);
      if (this.state === 'closed') return;
    }
  }

  // --- the clock --------------------------------------------------------------

  _tick() {
    const t = now();
    if (this.state === 'punching') {
      if (t - this.startedAt > this.o.punchMs) {
        this.reason = this.heard ? 'punch: heard the other side but no path both ways' : 'punch: nothing came back (NAT or firewall)';
        this.close(this.reason);
        return;
      }
      if (t >= this.nextProbe) this._probe();
      return;
    }
    if (this.state !== 'up') return;
    if (t - this.lastHeard > this.o.deadMs) { this.close('timeout: nothing heard'); return; }
    if (this.ackAt && t >= this.ackAt) this._sendAck();
    // Retransmit what waited longer than the RTO (oldest first).
    let n = 0;
    for (const [seq, e] of this.inflight) {
      if (n >= 32) break;
      if (t - e.sentAt < this.rto * 2 ** Math.min(e.tries, 4)) continue;
      if (e.tries >= 12) { this.close('timeout: no acknowledgement'); return; }
      if (seq >= this.recoverUntil) { this.ssthresh = Math.max(this.cwnd / 2, 4); this.cwnd = 4; this.recoverUntil = this.nextSeq; }
      e.sentAt = t;
      e.tries += 1;
      n += 1;
      this._sendData(seq, e.data);
    }
    if (t - this.lastSent > this.o.pingMs || (t - this.lastHeard > this.o.pingMs && t - this.lastSent > 1000)) this.ping();
  }
}

// ---------------------------------------------------------------------------
// The computer's side: answer offers from paired devices, accept their streams
// ---------------------------------------------------------------------------

const SID_RE = /^[0-9a-f]{16}$/;
const halfFrom = (text) => {
  const b = Buffer.from(String(text || ''), 'base64url');
  return b.length === 32 ? b : null;
};

/**
 * createDirectServer({acceptStream(stream), relay: () => {host, port} | null,
 *   enabled: () => bool, endpointOptions, allowLoopback, sessionOptions, maxSessions, log})
 * acceptStream gets each stream a device opens, meta {ip, direct: true}: the
 * relay link's own TLS end (relaylink.mjs), so it is the same as through the relay.
 */
export function createDirectServer({ acceptStream, relay = () => null, enabled = () => true, endpointOptions = {}, allowLoopback = false, sessionOptions = {}, maxSessions = 32, maxPerDevice = 4, offersPerMinute = 12, log = () => {} } = {}) {
  let endpoint = null;
  const offerTimes = new Map(); // who -> recent offer times
  let binding = null;
  let outside = { at: 0, value: null };
  let stunState = 'unknown';
  const live = new Map(); // sidHex -> {session, mux, who, at}
  const stats = { offers: 0, up: 0, failed: 0, streams: 0, bytesIn: 0, bytesOut: 0, lastFailure: '' };

  async function ensureEndpoint() {
    if (endpoint && !endpoint.closed) return endpoint;
    if (!binding) {
      binding = (async () => {
        const e = new DirectEndpoint(endpointOptions);
        await e.bind();
        endpoint = e;
        return e;
      })().finally(() => { binding = null; });
    }
    return binding;
  }

  async function outsideAddress(e) {
    const r = relay();
    if (!r?.host) { stunState = 'unknown'; return null; }
    if (outside.value && Date.now() - outside.at < 30000) return outside.value;
    const got = await e.stun(r.host, r.port);
    // UDP just started getting through (the firewall was opened): failures from before say nothing about now.
    if (got && stunState === 'no' && stats.last === 'failed') stats.last = '';
    stunState = got ? 'yes' : 'no';
    outside = { at: Date.now(), value: got };
    return got;
  }

  function closeOne(sidHex, why) {
    const l = live.get(sidHex);
    if (l) l.session.close(why);
  }

  async function offer(body, { who = '' } = {}) {
    if (!enabled()) throw Object.assign(new Error('direct connections are off on this computer'), { code: 'DIRECT_OFF' });
    const sid = String(body?.sid || '').toLowerCase();
    const half = halfFrom(body?.half);
    const cands = cleanCandidates(body?.cands, { allowLoopback });
    if (body?.v !== 1 || !SID_RE.test(sid) || !half) throw Object.assign(new Error('not a direct offer'), { code: 'DIRECT_BAD_OFFER' });
    if (live.has(sid)) throw Object.assign(new Error('that session exists'), { code: 'DIRECT_BAD_OFFER' });
    // Even a paired device gets a few tries a minute: each one makes this computer send probes.
    const recent = (offerTimes.get(who) || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= offersPerMinute) throw Object.assign(new Error('too many direct attempts; wait a minute'), { code: 'DIRECT_BUSY' });
    recent.push(Date.now());
    offerTimes.set(who, recent);
    if (offerTimes.size > 256) offerTimes.delete(offerTimes.keys().next().value);
    stats.offers += 1;
    // Room for this one: the same device's oldest goes first, then anyone's oldest.
    const mine = [...live.entries()].filter(([, l]) => l.who === who).sort((a, b) => a[1].at - b[1].at);
    while (mine.length >= maxPerDevice) closeOne(mine.shift()[0], 'replaced by a newer one');
    const all = [...live.entries()].sort((a, b) => a[1].at - b[1].at);
    while (all.length >= maxSessions) closeOne(all.shift()[0], 'too many sessions');
    const e = await ensureEndpoint();
    const out = await outsideAddress(e);
    const mineHalf = crypto.randomBytes(32);
    const sidBuf = Buffer.from(sid, 'hex');
    const keys = deriveKeys(half, mineHalf, sidBuf);
    const session = e.createSession({ sid: sidBuf, role: 'server', sendKey: keys.s2c, recvKey: keys.c2s, candidates: cands, options: sessionOptions });
    const mux = new Mux(session);
    const entry = { session, mux, who, at: Date.now() };
    live.set(sid, entry);
    mux.on('stream', (stream) => {
      // Whatever the device wrote in OPEN, this side says where it came from.
      stream.meta = { ip: session.remote?.address || '', direct: true };
      stats.streams += 1;
      session.idleSince = 0;
      stream.once('close', () => { if (!mux.streams.size) session.idleSince = Date.now(); });
      acceptStream(stream);
    });
    session.once('up', () => { stats.up += 1; stats.last = 'up'; log(`direct: a device is connected directly (${session.remote.address.includes(':') ? 'IPv6' : 'IPv4'})`); });
    session.once('close', (why) => {
      if (live.get(sid) === entry) live.delete(sid);
      stats.bytesIn += session.bytesIn;
      stats.bytesOut += session.bytesOut;
      if (!session.upAt) { stats.failed += 1; stats.lastFailure = why; stats.last = 'failed'; }
    });
    return { v: 1, sid, half: mineHalf.toString('base64url'), cands: e.candidates(out) };
  }

  // Idle sessions close (the phone's next connection punches again).
  const sweep = setInterval(() => {
    for (const [sid, l] of live) {
      const idleMs = l.session.o.idleMs;
      if (l.session.state === 'up' && l.session.idleSince && Date.now() - l.session.idleSince > idleMs) closeOne(sid, 'idle');
    }
  }, 30000);
  sweep.unref?.();

  return {
    offer,
    closeAll(why = 'turned off') { for (const sid of [...live.keys()]) closeOne(sid, why); },
    muxes: () => [...live.values()].map((l) => l.mux),
    view() {
      const sessions = [...live.values()];
      return {
        enabled: Boolean(enabled()),
        stun: stunState,
        port: endpoint?.port || 0,
        sessions: sessions.length,
        active: sessions.filter((l) => l.session.state === 'up').length,
        remotes: sessions.filter((l) => l.session.remote).map((l) => l.session.remote.address),
        offers: stats.offers,
        up: stats.up,
        failed: stats.failed,
        lastFailure: stats.lastFailure,
        // How the latest try ended: 'up' | 'failed' | '' (none yet). The UI says the latest, not the first.
        last: stats.last || '',
        streams: stats.streams,
        bytesIn: stats.bytesIn + sessions.reduce((n, l) => n + l.session.bytesIn, 0),
        bytesOut: stats.bytesOut + sessions.reduce((n, l) => n + l.session.bytesOut, 0),
      };
    },
    /** Forget the cached outside address (the network or the relay changed). */
    forgetOutside() { outside = { at: 0, value: null }; },
    /** Ask the relay's STUN now (体检). -> 'yes' | 'no' | 'unknown' */
    async probeStun() {
      try {
        const e = await ensureEndpoint();
        outside = { at: 0, value: null };
        await outsideAddress(e);
      } catch { stunState = 'no'; }
      return stunState;
    },
    close() {
      clearInterval(sweep);
      for (const sid of [...live.keys()]) closeOne(sid, 'closed');
      endpoint?.close();
      endpoint = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The dialing side (another machine; the tests; the phone does it in Java)
// ---------------------------------------------------------------------------

export const RETRY_MS = [60000, 5 * 60000, 15 * 60000];

/**
 * createDirectDialer({offer: async (desc, body) => reply, endpointOptions,
 *   allowLoopback, sessionOptions, retryMs, log})
 *   kick(desc)   try now unless waiting to retry -> 'direct' | 'relay'
 *   stream(desc) a new stream over the direct channel, or null (use the relay)
 *   route(id), info(id), reset() (the network changed), close()
 */
export function createDirectDialer({ offer, endpointOptions = {}, allowLoopback = false, sessionOptions = {}, retryMs = RETRY_MS, log = () => {} } = {}) {
  const links = new Map(); // id -> {state, session, mux, endpoint, failures, nextTry, reason, pending}

  const link = (id) => {
    let l = links.get(id);
    if (!l) { l = { state: 'relay', failures: 0, nextTry: 0, reason: '' }; links.set(id, l); }
    return l;
  };

  function failed(l, why) {
    l.state = 'relay';
    l.reason = why;
    l.failures += 1;
    l.nextTry = Date.now() + retryMs[Math.min(l.failures - 1, retryMs.length - 1)];
  }

  async function attempt(desc, l) {
    const endpoint = new DirectEndpoint(endpointOptions);
    try {
      await endpoint.bind();
      const out = await endpoint.stun(desc.host, desc.port);
      const sid = crypto.randomBytes(8);
      const half = crypto.randomBytes(32);
      const reply = await offer(desc, { v: 1, sid: sid.toString('hex'), half: half.toString('base64url'), cands: endpoint.candidates(out) });
      const theirs = halfFrom(reply?.half);
      if (!theirs || reply.sid !== sid.toString('hex')) throw Object.assign(new Error('the computer did not take the offer'), { code: 'DIRECT_BAD_REPLY' });
      const keys = deriveKeys(half, theirs, sid);
      const cands = cleanCandidates(reply.cands, { allowLoopback });
      const session = endpoint.createSession({ sid, role: 'client', sendKey: keys.c2s, recvKey: keys.s2c, candidates: cands, options: sessionOptions });
      const ok = await new Promise((resolve) => { session.once('up', () => resolve(true)); session.once('close', () => resolve(false)); });
      if (!ok) { endpoint.close(); failed(l, session.reason || 'punch failed'); return 'relay'; }
      l.state = 'direct';
      l.session = session;
      l.endpoint = endpoint;
      l.mux = new Mux(session); // no 'stream' listener: the computer cannot open streams here
      l.reason = '';
      l.sid = sid.toString('hex');
      const upAt = Date.now();
      session.once('close', (why) => {
        endpoint.close();
        if (l.session !== session) return;
        l.session = null;
        l.mux = null;
        l.state = 'relay';
        l.reason = why;
        // A link that worked and then died (walked out of Wi-Fi): try again soon,
        // a bit later when it died right away (a flaky path).
        l.failures = 0;
        l.nextTry = Date.now() + (Date.now() - upAt > 10000 ? 5000 : 10000);
      });
      log(`direct: connected to ${desc.id.slice(0, 6)}…`);
      return 'direct';
    } catch (err) {
      endpoint.close();
      // Off over there (or the relay's own server): ask again only after the longest wait.
      if (err.code === 'DIRECT_OFF') { l.failures = retryMs.length - 1; failed(l, 'off on the computer'); } else failed(l, `offer: ${err.message}`);
      return 'relay';
    }
  }

  return {
    kick(desc) {
      const l = link(desc.id);
      if (l.state === 'direct') return Promise.resolve('direct');
      if (l.pending) return l.pending;
      if (Date.now() < l.nextTry) return Promise.resolve('relay');
      l.pending = attempt(desc, l).finally(() => { l.pending = null; });
      return l.pending;
    },
    stream(desc) {
      const l = links.get(desc.id);
      if (!l || l.state !== 'direct' || !l.mux || l.mux.closed) return null;
      return l.mux.open({});
    },
    route: (id) => links.get(id)?.state || 'relay',
    info(id) {
      const l = links.get(id);
      if (!l) return { route: 'relay', failures: 0, nextTry: 0, reason: '' };
      return { route: l.state, failures: l.failures, nextTry: l.nextTry, reason: l.reason, sid: l.sid || '', remote: l.session?.remote || null };
    },
    /** A connection over it stalled (the computer restarted, the path died quietly): drop it now, not after the heartbeat. */
    drop(id, why = 'stalled') {
      const l = links.get(id);
      if (l?.session) l.session.close(why);
    },
    /** The network changed: drop direct links, forget the waits. */
    reset() {
      for (const l of links.values()) {
        l.failures = 0;
        l.nextTry = 0;
        const s = l.session;
        if (s) { l.session = null; l.mux = null; l.state = 'relay'; s.close('network changed'); }
      }
    },
    close() {
      for (const l of links.values()) { l.session?.close('closed'); l.endpoint?.close(); }
      links.clear();
    },
  };
}
