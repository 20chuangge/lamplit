#!/usr/bin/env node
/**
 * relay.mjs - the Lamplit relay (第 1 步原型). Node only, no dependencies.
 *
 * What it is: a server with a public address that a computer at home connects
 * OUT to (a WebSocket over TLS, "the tunnel"), so a phone or another machine
 * outside can reach that computer without Tailscale and without touching the
 * router.
 *
 * What it never does: decrypt. A phone opens TLS to `<computer id>.<anything>`
 * on the relay's port; the relay reads only the server name (SNI) in the TLS
 * ClientHello, finds that computer's tunnel and copies the encrypted bytes into
 * it. The TLS session ends on the computer, whose private key never leaves it.
 * The relay sees who connected when and how many bytes - not chats, files,
 * screens or tokens.
 *
 * One port, two kinds of traffic, told apart by SNI:
 *   SNI = "lamplit-relay"   the control plane: TLS ends here (the relay's own
 *                           self-signed certificate, pinned by the computers),
 *                           GET /tunnel upgrades to the tunnel WebSocket.
 *   SNI = "<id>.<suffix>"   passed through, untouched, to computer <id>.
 *
 * Who may hold a tunnel: a computer proves its id with its own key. The first
 * time an id is seen it must also present the join secret made when this relay
 * was installed (only the owner's machines have it); after that the key alone.
 * One tunnel per id: a new one replaces the old, which is told so.
 *
 * Run:  node relay.mjs [--port 34443] [--host 0.0.0.0] [--data ./relay-data]
 * Prints one JSON line {event:"ready", port, fingerprint} on stdout.
 *
 * The same file is a library for the computer's side (src/relaylink.mjs) and
 * for the tests: the SNI reader, the WebSocket framing, the stream multiplexer
 * and the certificate maker are exported.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

export const CONTROL_NAME = 'lamplit-relay';
/** A computer id: random, lower-case letters and digits, long enough not to be guessed. */
export const ID_RE = /^[a-z0-9]{16,40}$/;
export const DEFAULT_PORT = 34443;

// ===========================================================================
// SNI: the server name in a TLS ClientHello, without decrypting anything
// ===========================================================================

const MAX_HELLO_BYTES = 16 * 1024 + 5 * 4; // a ClientHello fits one or a few records

/**
 * Read the server name out of the first bytes of a TLS connection.
 * -> {state:'more'} need more bytes | {state:'ok', sni:string|''} | {state:'bad', why}
 * Only looks, never consumes: the caller forwards the same bytes untouched.
 */
export function readClientHello(buf) {
  if (!buf || !buf.length) return { state: 'more' };
  if (buf[0] !== 0x16) return { state: 'bad', why: 'not a TLS handshake' };
  // Collect the handshake bytes from as many records as needed.
  const parts = [];
  let offset = 0;
  let have = 0;
  let need = -1;
  while (true) {
    if (buf.length < offset + 5) return buf.length > MAX_HELLO_BYTES ? { state: 'bad', why: 'too long' } : { state: 'more' };
    if (buf[offset] !== 0x16) return { state: 'bad', why: 'not a handshake record' };
    if (buf[offset + 1] !== 0x03) return { state: 'bad', why: 'not TLS' };
    const len = buf.readUInt16BE(offset + 3);
    if (len === 0 || len > 16384 + 2048) return { state: 'bad', why: 'bad record length' };
    if (buf.length < offset + 5 + len) return buf.length > MAX_HELLO_BYTES ? { state: 'bad', why: 'too long' } : { state: 'more' };
    parts.push(buf.subarray(offset + 5, offset + 5 + len));
    have += len;
    offset += 5 + len;
    if (need < 0 && have >= 4) {
      const hs = Buffer.concat(parts);
      if (hs[0] !== 0x01) return { state: 'bad', why: 'not a ClientHello' };
      need = 4 + hs.readUIntBE(1, 3);
      if (need > MAX_HELLO_BYTES) return { state: 'bad', why: 'hello too long' };
    }
    if (need >= 0 && have >= need) break;
    if (offset >= buf.length) return { state: 'more' };
  }
  const hello = Buffer.concat(parts).subarray(4, need);
  try {
    return { state: 'ok', sni: sniFromHello(hello) };
  } catch {
    return { state: 'bad', why: 'malformed ClientHello' };
  }
}

function sniFromHello(h) {
  let p = 0;
  const take = (n) => {
    if (p + n > h.length) throw new Error('short');
    const out = h.subarray(p, p + n);
    p += n;
    return out;
  };
  take(2); // client version
  take(32); // random
  take(take(1)[0]); // session id
  take(take(2).readUInt16BE(0)); // cipher suites
  take(take(1)[0]); // compression methods
  if (p === h.length) return ''; // no extensions at all
  const extEnd = p + 2 + take(2).readUInt16BE(0);
  if (extEnd > h.length) throw new Error('short');
  while (p + 4 <= extEnd) {
    const type = take(2).readUInt16BE(0);
    const body = take(take(2).readUInt16BE(0));
    if (type !== 0) continue; // server_name
    let q = 2; // list length
    while (q + 3 <= body.length) {
      const nameType = body[q];
      const len = body.readUInt16BE(q + 1);
      const name = body.subarray(q + 3, q + 3 + len);
      if (name.length !== len) throw new Error('short');
      if (nameType === 0) {
        const text = name.toString('latin1').toLowerCase();
        return /^[a-z0-9.-]{1,253}$/.test(text) ? text : '';
      }
      q += 3 + len;
    }
  }
  return '';
}

/** "abc123….relay.example" -> "abc123…" when it is a well-formed id, else ''. */
export function idFromSni(sni) {
  const first = String(sni || '').split('.')[0];
  return ID_RE.test(first) ? first : '';
}

// ===========================================================================
// A self-signed certificate (ECDSA P-256), made with node:crypto alone
// ===========================================================================

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...body) => {
  const content = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
};
const derSeq = (...b) => der(0x30, ...b);
function derOid(text) {
  const parts = text.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const n of parts.slice(2)) {
    const chunk = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) { chunk.unshift(0x80 | (v & 0x7f)); v = Math.floor(v / 128); }
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}
function derTime(date) {
  const y = date.getUTCFullYear();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tail = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return y < 2050 ? der(0x17, Buffer.from(`${pad(y % 100)}${tail}`)) : der(0x18, Buffer.from(`${pad(y, 4)}${tail}`));
}

/** -> {key, cert} PEM strings and the certificate's SHA-256 fingerprint (hex, lower case). */
export function makeSelfSignedCert({ commonName = 'lamplit', days = 3650 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const algorithm = derSeq(derOid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = derSeq(der(0x31, derSeq(derOid('2.5.4.3'), der(0x0c, Buffer.from(String(commonName).slice(0, 60), 'utf8')))));
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const tbs = derSeq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    algorithm,
    name,
    derSeq(derTime(now), derTime(until)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = derSeq(tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    fingerprint: crypto.createHash('sha256').update(certDer).digest('hex'),
  };
}

/** SHA-256 of a certificate (PEM, or a peer certificate object), hex lower case. */
export function certFingerprint(input) {
  if (input && typeof input === 'object' && input.raw) return crypto.createHash('sha256').update(input.raw).digest('hex');
  const x = new crypto.X509Certificate(input);
  return x.fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Load key.pem + cert.pem from a folder, making them the first time (private key mode 600). */
export function loadOrMakeIdentity(dir, commonName = 'lamplit') {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    return { key, cert, fingerprint: certFingerprint(cert) };
  } catch { /* make one */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const made = makeSelfSignedCert({ commonName });
  fs.writeFileSync(keyFile, made.key, { mode: 0o600 });
  fs.writeFileSync(certFile, made.cert, { mode: 0o644 });
  return made;
}

export const safeEqualText = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

// ===========================================================================
// WebSocket (RFC 6455), binary messages only - just enough for the tunnel
// ===========================================================================

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const wsAccept = (key) => crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
const MAX_WS_MESSAGE = 1024 * 1024;

/** One WebSocket over an open socket. Emits 'message'(Buffer), 'pong', 'close'. */
export class WsConn extends EventEmitter {
  constructor(socket, { client = false, head = null } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.partsLen = 0;
    this.closed = false;
    this.lastHeard = Date.now();
    this.setMaxListeners(0); // every stream of a full tunnel waits for 'drain'
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._gone());
    socket.on('error', () => this._gone());
    socket.on('drain', () => this.emit('drain'));
    if (head && head.length) this._data(head);
  }

  get needDrain() {
    return Boolean(this.socket.writableNeedDrain);
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, (this.client ? 0x80 : 0) | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = (this.client ? 0x80 : 0) | 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = (this.client ? 0x80 : 0) | 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    if (!this.client) return Buffer.concat([header, payload]);
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) body[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, body]);
  }

  send(payload) {
    if (this.closed) return false;
    return this.socket.write(this._frame(0x2, payload));
  }

  ping() {
    if (!this.closed) this.socket.write(this._frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try { this.socket.write(this._frame(0x8, body)); } catch { /* gone */ }
    try { this.socket.end(); } catch { /* gone */ }
    setTimeout(() => this.socket.destroy(), 2000).unref?.();
    this._gone();
  }

  _gone() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  _data(chunk) {
    this.lastHeard = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let p = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); p = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_MESSAGE)) return this._gone();
        len = Number(big); p = 10;
      }
      // A server only takes masked frames, a client only unmasked ones.
      if (masked === this.client) return this._gone();
      if (len > MAX_WS_MESSAGE) return this._gone();
      const maskAt = p;
      if (masked) p += 4;
      if (b.length < p + len) return;
      let payload = b.subarray(p, p + len);
      if (masked) {
        const mask = b.subarray(maskAt, maskAt + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = b.subarray(p + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(this._frame(0xa, payload)); continue; }
      if (opcode === 0xa) { this.emit('pong'); continue; }
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.parts.push(Buffer.from(payload));
        this.partsLen += payload.length;
        if (this.partsLen > MAX_WS_MESSAGE) return this._gone();
        if (fin) {
          const message = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
          this.parts = [];
          this.partsLen = 0;
          this.emit('message', message);
        }
        continue;
      }
      return this._gone(); // unknown opcode
    }
  }
}

// ===========================================================================
// Many connections in one tunnel (stream multiplexer with flow control)
// ===========================================================================
//
// Each WebSocket message: [type:1][stream id:4][payload]
//   OPEN 1   relay -> computer, payload JSON {ip}: a new connection arrived
//   DATA 2   bytes of that connection
//   END  3   the sender will write no more (half close)
//   RST  4   the connection is gone, both ways
//   WIN  5   payload u32: the receiver consumed that many more bytes
//   CTL  9   stream 0, payload JSON: {type:'replaced'} and the like
//
// Flow control: a sender may have at most WINDOW bytes in flight per stream;
// the receiver gives credit back as its side consumes them. A slow phone
// therefore holds back only its own connection, never the whole tunnel.

export const T = { OPEN: 1, DATA: 2, END: 3, RST: 4, WIN: 5, CTL: 9 };
export const WINDOW = 256 * 1024;
const CHUNK = 32 * 1024;
const CREDIT_STEP = 32 * 1024;

function frame(type, id, payload = Buffer.alloc(0)) {
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32BE(id >>> 0, 1);
  return Buffer.concat([head, payload]);
}

export class MuxStream extends Duplex {
  constructor(mux, id, meta = {}) {
    super({ allowHalfOpen: true, highWaterMark: 64 * 1024 });
    this.mux = mux;
    this.id = id;
    this.meta = meta;
    this.credit = WINDOW; // what we may still send
    this.owed = 0; // consumed but not yet credited back
    this.unread = 0; // received and not handed on yet (guards against a peer that ignores credit)
    this.pending = null;
    this.remoteGone = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  _write(chunk, _enc, cb) {
    this.pending = { chunk, cb };
    this._flushOut();
  }

  _flushOut() {
    const job = this.pending;
    if (!job) return;
    if (this.destroyed || this.remoteGone) { this.pending = null; job.cb(new Error('stream closed')); return; }
    while (job.chunk.length && this.credit > 0) {
      const n = Math.min(job.chunk.length, this.credit, CHUNK);
      this.mux._send(frame(T.DATA, this.id, job.chunk.subarray(0, n)));
      this.credit -= n;
      this.bytesOut += n;
      this.mux.bytesOut += n;
      job.chunk = job.chunk.subarray(n);
    }
    if (job.chunk.length) return; // wait for WIN
    this.pending = null;
    // The tunnel itself is full: hold this writer until it drains.
    if (this.mux.ws.needDrain) this.mux.ws.once('drain', () => job.cb());
    else job.cb();
  }

  _final(cb) {
    if (!this.remoteGone) this.mux._send(frame(T.END, this.id));
    cb();
  }

  _read() {
    if (this.owed > 0) this._credit(true);
  }

  _credit(force = false) {
    if (this.remoteGone || this.destroyed) return;
    if (this.owed >= CREDIT_STEP || (force && this.owed > 0)) {
      const body = Buffer.allocUnsafe(4);
      body.writeUInt32BE(this.owed, 0);
      this.mux._send(frame(T.WIN, this.id, body));
      this.owed = 0;
    }
  }

  _incoming(data) {
    this.bytesIn += data.length;
    this.mux.bytesIn += data.length;
    this.unread += data.length;
    if (this.unread > WINDOW * 2) { this.destroy(new Error('peer ignored flow control')); return; }
    const more = this.push(data);
    this.unread -= data.length;
    this.owed += data.length;
    if (more) this._credit();
  }

  _destroy(err, cb) {
    if (!this.remoteGone && !this.mux.closed) this.mux._send(frame(T.RST, this.id));
    this.remoteGone = true;
    this.mux.streams.delete(this.id);
    if (this.pending) { const job = this.pending; this.pending = null; job.cb(err || new Error('stream closed')); }
    cb(err);
  }
}

/** A tunnel's streams over one WsConn. 'stream'(MuxStream) on the side that accepts; 'control'(obj); 'close'. */
export class Mux extends EventEmitter {
  constructor(ws, { maxStreams = 512 } = {}) {
    super();
    this.ws = ws;
    this.streams = new Map();
    this.nextId = 1;
    this.closed = false;
    this.maxStreams = maxStreams;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.opened = 0;
    ws.on('message', (m) => this._message(m));
    ws.on('close', () => this._closed());
  }

  _send(buf) {
    if (!this.closed) this.ws.send(buf);
  }

  /** Open a stream to the other side (the relay does this when a phone connects). */
  open(meta = {}) {
    const id = this.nextId;
    this.nextId = (this.nextId % 0xfffffff0) + 1;
    const stream = new MuxStream(this, id, meta);
    this.streams.set(id, stream);
    this.opened += 1;
    this._send(frame(T.OPEN, id, Buffer.from(JSON.stringify(meta))));
    return stream;
  }

  control(obj) {
    this._send(frame(T.CTL, 0, Buffer.from(JSON.stringify(obj))));
  }

  _message(m) {
    if (m.length < 5) return;
    const type = m[0];
    const id = m.readUInt32BE(1);
    const body = m.subarray(5);
    if (type === T.CTL) {
      try { this.emit('control', JSON.parse(body.toString('utf8'))); } catch { /* ignore */ }
      return;
    }
    if (type === T.OPEN) {
      if (!this.listenerCount('stream') || this.streams.has(id) || this.streams.size >= this.maxStreams) {
        this._send(frame(T.RST, id));
        return;
      }
      let meta = {};
      try { meta = JSON.parse(body.toString('utf8')) || {}; } catch { /* none */ }
      const stream = new MuxStream(this, id, meta);
      this.streams.set(id, stream);
      this.opened += 1;
      this.emit('stream', stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === T.DATA) stream._incoming(body);
    else if (type === T.END) stream.push(null);
    else if (type === T.RST) { stream.remoteGone = true; stream.destroy(); }
    else if (type === T.WIN && body.length >= 4) { stream.credit += body.readUInt32BE(0); stream._flushOut(); }
  }

  close() {
    this.ws.close();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) { s.remoteGone = true; s.destroy(); }
    this.streams.clear();
    this.emit('close');
  }
}

// ===========================================================================
// Limits
// ===========================================================================

/** Token bucket per key: `rate` events per `perMs`, bursts up to `burst`. */
export function createLimiter({ rate, perMs, burst = rate, maxKeys = 50000 }) {
  const buckets = new Map();
  return {
    take(key, n = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        b = { tokens: burst, at: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) * rate) / perMs);
      b.at = now;
      if (b.tokens < n) return false;
      b.tokens -= n;
      return true;
    },
    size: () => buckets.size,
  };
}

export const DEFAULT_LIMITS = {
  helloTimeoutMs: 10000,
  connPerIpPerMin: 240, // a page load opens a handful; a VNC reconnect a few more
  connBurst: 60,
  maxConnPerIp: 96,
  maxStreamsPerTunnel: 512,
  maxTunnels: 2000,
  registerPerIpPerMin: 12,
  missesPerIpPer10Min: 40, // connections to ids that have no tunnel (scanning)
  authFailuresPerIpPer10Min: 6,
  blockMs: 10 * 60 * 1000,
  pingEveryMs: 20000,
  deadAfterMs: 60000,
};

// ===========================================================================
// The relay
// ===========================================================================

const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

/** A stream that yields `head` and then whatever `socket` reads (unshift does not reach a TLS wrap). */
function replay(socket, head) {
  const d = new Duplex({
    read() { socket.resume(); },
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
    destroy(err, cb) { socket.destroy(); cb(err); },
  });
  d.push(head);
  socket.on('data', (c) => { if (!d.push(c)) socket.pause(); });
  socket.on('end', () => d.push(null));
  socket.on('close', () => d.destroy());
  socket.resume();
  return d;
}

/**
 * createRelay({identity:{key,cert}, joinSecret, registryFile?, limits?, log?, tap?})
 *   -> {server: net.Server, tunnels, stats(), close()}
 * server.listen(port, host) is the caller's. `tap(id, 'up'|'down', bytes)` sees
 * every passed-through chunk - the tests use it to show they are ciphertext.
 */
export function createRelay({ identity, joinSecret, registryFile = '', limits = {}, log = () => {}, tap = null } = {}) {
  if (!identity?.key || !identity?.cert) throw new Error('relay needs a TLS identity for its control plane');
  if (!joinSecret || String(joinSecret).length < 16) throw new Error('relay needs a join secret (16+ chars)');
  const L = { ...DEFAULT_LIMITS, ...limits };
  const tunnels = new Map(); // id -> {mux, ws, since, ip}
  const perIp = new Map(); // ip -> open connections
  const blocked = new Map(); // ip -> until
  const connLimiter = createLimiter({ rate: L.connPerIpPerMin, perMs: 60000, burst: L.connBurst });
  const registerLimiter = createLimiter({ rate: L.registerPerIpPerMin, perMs: 60000 });
  const missLimiter = createLimiter({ rate: L.missesPerIpPer10Min, perMs: 600000 });
  const failLimiter = createLimiter({ rate: L.authFailuresPerIpPer10Min, perMs: 600000 });
  const counters = { connections: 0, refused: 0, misses: 0, authFailures: 0, replaced: 0, bytesUp: 0, bytesDown: 0 };

  // id -> {keyHash, createdAt, lastSeen}. Only hashes of the machines' keys.
  let registry = {};
  if (registryFile) {
    try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')) || {}; } catch { registry = {}; }
  }
  let saveTimer = null;
  const saveRegistry = () => {
    if (!registryFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify(registry, null, 1), { mode: 0o600 });
        fs.renameSync(`${registryFile}.tmp`, registryFile);
      } catch (err) { log(`registry not saved: ${err.message}`); }
    }, 200);
  };

  const isBlocked = (ip) => {
    const until = blocked.get(ip);
    if (!until) return false;
    if (Date.now() < until) return true;
    blocked.delete(ip);
    return false;
  };
  const block = (ip, why) => {
    blocked.set(ip, Date.now() + L.blockMs);
    log(`blocked ${ip} for ${Math.round(L.blockMs / 60000)} min: ${why}`);
  };

  // --- control plane: TLS ends here, GET /tunnel upgrades ----------------------
  // TLS for the control plane ends here (finishTls), then this plain server reads HTTP.
  const secureContext = tls.createSecureContext({ key: identity.key, cert: identity.cert });
  const control = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, relay: 'lamplit', tunnels: tunnels.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  control.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  control.on('upgrade', (req, socket, head) => {
    const ip = cleanIp(req.socket.relayIp || req.socket.remoteAddress);
    const refuse = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => socket.destroy());
    if (req.url !== '/tunnel' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse(404, 'Not Found');
    if (!registerLimiter.take(ip)) return refuse(429, 'Too Many Requests');
    const id = String(req.headers['x-lamplit-id'] || '').trim();
    const key = String(req.headers.authorization || '').replace(/^bearer\s+/i, '').trim();
    const join = String(req.headers['x-lamplit-join'] || '').trim();
    const wsKey = String(req.headers['sec-websocket-key'] || '');
    if (!ID_RE.test(id) || key.length < 32 || !wsKey) return refuse(400, 'Bad Request');
    const known = registry[id];
    let ok = false;
    if (known) ok = safeEqualText(sha256(key), known.keyHash);
    else if (safeEqualText(join, joinSecret)) {
      registry[id] = { keyHash: sha256(key), createdAt: new Date().toISOString() };
      ok = true;
    }
    if (!ok) {
      counters.authFailures += 1;
      if (!failLimiter.take(ip)) block(ip, 'too many failed registrations');
      log(`refused a tunnel for ${id.slice(0, 6)}… from ${ip}: ${known ? 'wrong key' : 'not a member'}`);
      return refuse(401, 'Unauthorized');
    }
    if (!known && tunnels.size >= L.maxTunnels) return refuse(503, 'Service Unavailable');
    registry[id].lastSeen = new Date().toISOString();
    saveRegistry();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(wsKey)}\r\n\r\n`);
    const ws = new WsConn(socket, { head });
    const mux = new Mux(ws, { maxStreams: L.maxStreamsPerTunnel });
    const old = tunnels.get(id);
    if (old) {
      // Same id, newer tunnel: the old one is told why it goes, then dropped.
      counters.replaced += 1;
      try { old.mux.control({ type: 'replaced', at: new Date().toISOString() }); } catch { /* gone */ }
      setTimeout(() => old.mux.close(), 100).unref?.();
    }
    const entry = { id, mux, ws, ip, since: Date.now() };
    tunnels.set(id, entry);
    log(`tunnel up: ${id.slice(0, 6)}… from ${ip}${old ? ' (replaced the old one)' : ''}`);
    mux.control({ type: 'hello', id });
    const beat = setInterval(() => {
      if (Date.now() - ws.lastHeard > L.deadAfterMs) { log(`tunnel ${id.slice(0, 6)}… silent, dropped`); mux.close(); return; }
      ws.ping();
    }, L.pingEveryMs);
    beat.unref?.();
    mux.on('close', () => {
      clearInterval(beat);
      if (tunnels.get(id) === entry) tunnels.delete(id);
      counters.bytesUp += mux.bytesIn;
      counters.bytesDown += mux.bytesOut;
      log(`tunnel down: ${id.slice(0, 6)}… after ${Math.round((Date.now() - entry.since) / 1000)} s, ${mux.opened} connections, in ${mux.bytesIn} B, out ${mux.bytesOut} B`);
    });
  });

  // --- every TCP connection: read the SNI, then decide ------------------------
  const server = net.createServer({ pauseOnConnect: false }, (socket) => {
    const ip = cleanIp(socket.remoteAddress);
    counters.connections += 1;
    if (isBlocked(ip) || !connLimiter.take(ip) || (perIp.get(ip) || 0) >= L.maxConnPerIp) {
      counters.refused += 1;
      socket.destroy();
      return;
    }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    socket.once('close', () => {
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    });
    socket.on('error', () => socket.destroy());
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), L.helloTimeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const hello = readClientHello(buf);
      if (hello.state === 'more') return;
      socket.removeListener('data', onData);
      clearTimeout(timer);
      socket.pause();
      if (hello.state !== 'ok') { socket.destroy(); return; }
      route(socket, ip, hello.sni, buf);
    };
    socket.on('data', onData);
  });

  function route(socket, ip, sni, hello) {
    if (sni === CONTROL_NAME) {
      // The ClientHello was read already: replay it in front of the rest.
      const t = new tls.TLSSocket(replay(socket, hello), { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      const timer = setTimeout(() => t.destroy(), L.helloTimeoutMs);
      t.on('error', () => t.destroy());
      t.once('secure', () => {
        clearTimeout(timer);
        t.relayIp = ip;
        control.emit('connection', t);
      });
      t.once('close', () => { clearTimeout(timer); socket.destroy(); });
      return;
    }
    const id = idFromSni(sni);
    const tunnel = id ? tunnels.get(id) : null;
    if (!tunnel) {
      counters.misses += 1;
      if (!missLimiter.take(ip)) block(ip, 'too many connections to unknown computers');
      socket.destroy();
      return;
    }
    let stream;
    try { stream = tunnel.mux.open({ ip }); } catch { socket.destroy(); return; }
    if (tunnel.mux.streams.size > L.maxStreamsPerTunnel) { stream.destroy(); socket.destroy(); return; }
    // The bytes already read (the ClientHello) go first, untouched.
    if (tap) {
      tap(id, 'up', hello);
      socket.on('data', (c) => tap(id, 'up', c));
      stream.on('data', (c) => tap(id, 'down', c));
    }
    stream.write(hello);
    socket.pipe(stream);
    stream.pipe(socket);
    socket.resume();
    const done = () => { socket.destroy(); stream.destroy(); };
    socket.on('close', done);
    stream.on('close', done);
    stream.on('error', () => {});
  }

  return {
    server,
    tunnels,
    registry: () => ({ ...registry }),
    stats: () => ({ ...counters, tunnels: tunnels.size, ips: perIp.size, blocked: blocked.size }),
    close() {
      for (const t of tunnels.values()) t.mux.close();
      server.close();
    },
  };
}

// ===========================================================================
// The computer's side: open a tunnel (used by src/relaylink.mjs and the tests)
// ===========================================================================

/**
 * Connect to a relay's control plane, pin its certificate, upgrade to the
 * tunnel WebSocket. -> Promise<{mux, ws, socket}>; rejects with err.code
 * RELAY_CERT_MISMATCH / RELAY_UNAUTHORIZED / RELAY_REFUSED / RELAY_UNREACHABLE.
 */
export function openTunnel({ host, port = DEFAULT_PORT, relayFingerprint, id, key, join = '', timeoutMs = 15000, tlsConnect } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* gone */ }
      reject(Object.assign(new Error(message), { code }));
    };
    const connect = tlsConnect || ((opts, cb) => import('node:tls').then((tls) => tls.connect(opts, cb)));
    let socket = null;
    const timer = setTimeout(() => fail('RELAY_UNREACHABLE', 'relay did not answer in time'), timeoutMs);
    Promise.resolve(connect({ host, port, servername: CONTROL_NAME, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      // Pin before a single byte of ours goes out: the join secret and the key
      // travel only to the relay that was installed.
      const cert = socket.getPeerCertificate();
      const fp = cert && cert.raw ? certFingerprint(cert) : '';
      if (!relayFingerprint || fp !== String(relayFingerprint).toLowerCase()) return fail('RELAY_CERT_MISMATCH', 'the relay presented a different certificate');
      const wsKey = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /tunnel HTTP/1.1\r\nHost: ${CONTROL_NAME}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\nX-Lamplit-Id: ${id}\r\n` +
          `Authorization: Bearer ${key}\r\n${join ? `X-Lamplit-Join: ${join}\r\n` : ''}\r\n`,
      );
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { if (head.length > 8192) fail('RELAY_REFUSED', 'bad answer'); return; }
        socket.removeListener('data', onData);
        const text = head.subarray(0, end).toString('latin1');
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] || 0);
        if (status === 401) return fail('RELAY_UNAUTHORIZED', 'the relay does not accept this computer (key or join secret)');
        if (status !== 101) return fail('RELAY_REFUSED', `the relay answered ${status || 'something else'}`);
        const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(text)?.[1];
        if (accept !== wsAccept(wsKey)) return fail('RELAY_REFUSED', 'bad WebSocket answer');
        clearTimeout(timer);
        settled = true;
        const ws = new WsConn(socket, { client: true, head: head.subarray(end + 4) });
        resolve({ ws, mux: new Mux(ws), socket });
      };
      socket.on('data', onData);
    })).then((s) => {
      socket = s;
      socket.on('error', (err) => fail('RELAY_UNREACHABLE', err.message));
      socket.on('close', () => fail('RELAY_UNREACHABLE', 'connection closed'));
    }, (err) => fail('RELAY_UNREACHABLE', err.message));
  });
}

// ===========================================================================
// main
// ===========================================================================

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

async function main() {
  const port = Number(arg('port', process.env.LAMPLIT_RELAY_PORT || DEFAULT_PORT));
  const host = arg('host', process.env.LAMPLIT_RELAY_HOST || '0.0.0.0');
  const dataDir = path.resolve(arg('data', process.env.LAMPLIT_RELAY_DATA || path.join(process.cwd(), 'relay-data')));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const identity = loadOrMakeIdentity(path.join(dataDir, 'tls'), 'lamplit-relay');
  const joinFile = path.join(dataDir, 'join-secret');
  let joinSecret = '';
  try { joinSecret = fs.readFileSync(joinFile, 'utf8').trim(); } catch { /* make one */ }
  if (joinSecret.length < 16) {
    joinSecret = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(joinFile, `${joinSecret}\n`, { mode: 0o600 });
  }
  const log = (line) => console.error(`[relay] ${new Date().toISOString()} ${line}`);
  const relay = createRelay({ identity, joinSecret, registryFile: path.join(dataDir, 'machines.json'), log });
  relay.server.on('error', (err) => { log(`listen failed: ${err.message}`); process.exit(1); });
  relay.server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'ready', port: relay.server.address().port, fingerprint: identity.fingerprint }));
    log(`listening on ${host}:${relay.server.address().port}; certificate ${identity.fingerprint}`);
  });
  setInterval(() => {
    const s = relay.stats();
    log(`tunnels ${s.tunnels}, connections ${s.connections}, refused ${s.refused}, misses ${s.misses}, auth failures ${s.authFailures}, blocked ${s.blocked}`);
  }, 30 * 60 * 1000).unref();
  const stop = () => { relay.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
