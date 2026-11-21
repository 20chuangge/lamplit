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

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
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
    this.endSent = true;
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
    // Credit is given back only as data is consumed: more than that waiting
    // here means the other side ignores flow control.
    if (this.readableLength > WINDOW * 2) { this.destroy(new Error('peer ignored flow control')); return; }
    const more = this.push(data);
    this.owed += data.length;
    if (more) this._credit();
  }

  _destroy(err, cb) {
    // Both sides said END: a clean close, nothing to reset. Anything else
    // (an error, a side that went away) resets the other end.
    const clean = this.endSent && this.endReceived && !err;
    if (!clean && !this.remoteGone && !this.mux.closed) this.mux._send(frame(T.RST, this.id));
    this.remoteGone = true;
    this.mux.streams.delete(this.id);
    if (this.pending) { const job = this.pending; this.pending = null; job.cb(err || new Error('stream closed')); }
    cb(err);
  }
}

/**
 * What a TLS socket wraps instead of the stream itself. A TLSSocket that is
 * destroyed destroys the stream under it, and a MuxStream destroyed with bytes
 * still waiting for credit drops them - the tail of a response that ended with
 * "Connection: close" (seen on the first real relay). Through the shield, a
 * destroy becomes "send what is left, then close".
 */
export function shieldStream(stream, { lingerMs = 30000 } = {}) {
  const shield = new Duplex({
    allowHalfOpen: true,
    read() { stream.resume(); },
    write(chunk, _enc, cb) { stream.write(chunk, (err) => cb(err && !stream.destroyed ? err : null)); },
    final(cb) { stream.end(); cb(); },
    destroy(err, cb) {
      if (!stream.destroyed) {
        stream.end();
        stream.resume();
        setTimeout(() => stream.destroy(), lingerMs).unref?.();
      }
      cb(err);
    },
  });
  stream.on('data', (d) => { if (!shield.push(d)) stream.pause(); });
  stream.on('end', () => shield.push(null));
  stream.on('close', () => shield.destroy());
  stream.on('error', () => {});
  return shield;
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
    else if (type === T.END) { stream.endReceived = true; stream.push(null); }
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

// ===========================================================================
// STUN (1.5.46 直连): "at which address and port do you see me?"
// ===========================================================================
//
// Before two of the owner's devices try to reach each other directly (src/
// direct.mjs), each asks the relay this over UDP, on the same port number as
// the relay's TCP. Only RFC 5389 Binding Requests are answered, with one
// XOR-MAPPED-ADDRESS; nothing is stored or forwarded. A request must be at
// least as long as the longest answer (Lamplit pads it with PADDING), so the
// relay can never be used to send anyone more bytes than it was sent.

const STUN_MAGIC = 0x2112a442;
const STUN_ANSWER_MAX = 20 + 4 + 20; // header + XOR-MAPPED-ADDRESS for IPv6
export const STUN_REQUEST_BYTES = STUN_ANSWER_MAX;

/** A padded Binding Request. -> {buf, txid} */
export function stunRequest(txid = crypto.randomBytes(12)) {
  const buf = Buffer.alloc(STUN_REQUEST_BYTES);
  buf.writeUInt16BE(0x0001, 0); // Binding Request
  buf.writeUInt16BE(STUN_REQUEST_BYTES - 20, 2);
  buf.writeUInt32BE(STUN_MAGIC, 4);
  txid.copy(buf, 8, 0, 12);
  buf.writeUInt16BE(0x0026, 20); // PADDING (RFC 5780), zeros
  buf.writeUInt16BE(STUN_REQUEST_BYTES - 24, 22);
  return { buf, txid: buf.subarray(8, 20) };
}

/** Does this datagram look like STUN (and not a 直连 packet)? */
export function isStun(buf) {
  return Boolean(buf) && buf.length >= 20 && (buf[0] & 0xc0) === 0 && buf.readUInt32BE(4) === STUN_MAGIC && buf.readUInt16BE(2) === buf.length - 20;
}

function xorAddress(address, port, txid) {
  const v6 = net.isIPv6(address);
  const body = Buffer.alloc(v6 ? 20 : 8);
  body[1] = v6 ? 0x02 : 0x01;
  body.writeUInt16BE((port ^ (STUN_MAGIC >>> 16)) & 0xffff, 2);
  const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txid]);
  const raw = v6 ? ipv6Bytes(address) : Buffer.from(address.split('.').map(Number));
  for (let i = 0; i < raw.length; i += 1) body[4 + i] = raw[i] ^ key[i];
  return body;
}

function ipv6Bytes(text) {
  const [head, tail = ''] = String(text).split('::');
  const part = (s) => (s ? s.split(':') : []);
  const h = part(head);
  const t = part(tail);
  const words = String(text).includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  words.slice(0, 8).forEach((w, i) => out.writeUInt16BE(parseInt(w, 16) || 0, i * 2));
  return out;
}

function ipv6Text(buf) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push(buf.readUInt16BE(i).toString(16));
  // Shorten the longest run of zeros, the way net and the OS print it.
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== '0') { i += 1; continue; }
    let j = i;
    while (j < 8 && words[j] === '0') j += 1;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return words.join(':');
  return `${words.slice(0, best).join(':')}::${words.slice(best + bestLen).join(':')}`;
}

/** The relay's answer to one datagram from rinfo, or null (not a padded Binding Request). */
export function stunAnswer(buf, rinfo) {
  if (!isStun(buf) || buf.readUInt16BE(0) !== 0x0001 || buf.length < STUN_REQUEST_BYTES) return null;
  const address = String(rinfo?.address || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (!net.isIP(address) || !(rinfo.port > 0)) return null;
  const txid = buf.subarray(8, 20);
  const value = xorAddress(address, rinfo.port, txid);
  const out = Buffer.alloc(20 + 4 + value.length);
  out.writeUInt16BE(0x0101, 0); // Binding Success
  out.writeUInt16BE(4 + value.length, 2);
  out.writeUInt32BE(STUN_MAGIC, 4);
  txid.copy(out, 8);
  out.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
  out.writeUInt16BE(value.length, 22);
  value.copy(out, 24);
  return out;
}

/** The address in an answer to the request with this txid -> {address, port} | null. */
export function parseStunAnswer(buf, txid) {
  if (!isStun(buf) || buf.readUInt16BE(0) !== 0x0101 || !txid || !buf.subarray(8, 20).equals(Buffer.from(txid))) return null;
  let p = 20;
  while (p + 4 <= buf.length) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const v = buf.subarray(p + 4, p + 4 + len);
    if (v.length !== len) return null;
    if (type === 0x0020 && len >= 8) {
      const port = v.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
      const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), buf.subarray(8, 20)]);
      const n = v[1] === 0x02 ? 16 : 4;
      if (len < 4 + n) return null;
      const raw = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) raw[i] = v[4 + i] ^ key[i];
      return { address: n === 4 ? Array.from(raw).join('.') : ipv6Text(raw), port };
    }
    p += 4 + len + ((4 - (len % 4)) % 4);
  }
  return null;
}

export const DEFAULT_LIMITS = {
  helloTimeoutMs: 10000,
  stunPerIpPerMin: 120, // a phone asks once per try; a few phones behind one carrier NAT more
  stunBurst: 30,
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

// ===========================================================================
// Updating itself, safely (1.5.47)
// ===========================================================================
//
// This relay runs only code signed with Lamplit's release key. Trust chain:
//   - the private key stays on the computer that builds releases;
//     scripts/sign-update.mjs signs "lamplit-relay-update v1\n<version>\n<sha256>\n"
//     for the relay.mjs it ships (relay-update.json next to it);
//   - the public key below came here with this file, installed over SSH into
//     /opt (root-owned); src/selfupdate.mjs holds the same key (a smoke check);
//   - a registered computer only SAYS it has a newer version (relay-hello, no
//     code). The relay fetches the file through that computer's own tunnel and
//     checks version (newer, never seen failing), size, hash and signature;
//     whoever carries the bytes cannot change what runs;
//   - the supervisor (this file, from /opt) checks the signature again before
//     every start and rolls back a version that does not come up.
// Settings, join secret and registered computers live in the data folder and
// are never touched. Anything needing root (the service file) still needs 「重装」.

export const RELAY_VERSION = '1.5.51';
/** Lamplit's release key (Ed25519, SPKI DER, base64) - equal to UPDATE_PUBLIC_KEYS in src/selfupdate.mjs. */
export const RELAY_UPDATE_KEYS = ['MCowBQYDK2VwAyEA4GZ8GzzbeRaLOSrj9YgUcZ7JKoIbczSLfVv5XSot9ms='];
const MAX_RELAY_CODE = 2 * 1024 * 1024;
const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** What the release key signs for a relay version (never the same bytes as an app package). */
export function relayUpdateMessage(version, sha256) {
  return Buffer.from(`lamplit-relay-update v1\n${version}\n${sha256}\n`, 'utf8');
}

/** -1 / 0 / 1 for dotted versions. */
export function compareRelayVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Is `bytes` the relay.mjs the release key signed in `manifest` {v:1, version, sha256, signature}? */
export function verifyRelayUpdate(manifest, bytes, keys = RELAY_UPDATE_KEYS) {
  if (!manifest || manifest.v !== 1 || !VERSION_RE.test(String(manifest.version)) || !/^[0-9a-f]{64}$/.test(String(manifest.sha256))) return false;
  if (!bytes || !bytes.length || bytes.length > MAX_RELAY_CODE || sha256Bytes(bytes) !== manifest.sha256) return false;
  const sig = Buffer.from(String(manifest.signature || ''), 'base64');
  if (sig.length !== 64) return false;
  const message = relayUpdateMessage(manifest.version, manifest.sha256);
  return keys.some((k) => {
    try {
      return crypto.verify(null, message, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig);
    } catch {
      return false;
    }
  });
}

// The book: data/updates.json {current, previous, bad:[versions], last:{ok, version, at, reason?}}
//   current/previous: {version, sha256, signature} of a staged file (null = the one in /opt)
function readBook(stateDir) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(stateDir, 'updates.json'), 'utf8'));
    return { current: null, previous: null, bad: [], last: null, ...b, bad: Array.isArray(b.bad) ? b.bad.slice(-20) : [] };
  } catch {
    return { current: null, previous: null, bad: [], last: null };
  }
}

function writeBook(stateDir, book) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'updates.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(book, null, 1), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const stagedFile = (stateDir, version) => path.join(stateDir, 'updates', version, 'relay.mjs');
/** What a staged version that ended before it was ready printed last (1.5.50): written by the child itself. */
const failureNote = (stateDir, version) => path.join(stateDir, 'updates', version, 'start-failure.txt');

/**
 * Why a version did not start, fit to show on the computer (1.5.50): the last
 * ~20 lines of what it printed, at most 2000 characters, addresses taken out
 * (the relay's log names the computers' IPs). Times and versions stay.
 */
export function relayFailureDetail(text) {
  const scrubbed = String(text || '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/(?:::ffff:)?<ip>/gi, '<ip>')
    .replace(/[0-9a-fA-F:]*:[0-9a-fA-F:]*:[0-9a-fA-F:]*/g, (m) => (net.isIPv6(m) ? '<ip>' : m));
  const lines = scrubbed.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-20);
  let out = lines.join('\n');
  if (out.length > 2000) out = `…${out.slice(-1999)}`;
  return out;
}

/**
 * A GET to the computer behind `entry` through its own tunnel: a stream the
 * relay opens itself, TLS to the computer. The computer's certificate is not
 * what makes the bytes trusted - the signature is - so it is not pinned here.
 */
function fetchViaTunnel(entry, urlPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(err); else resolve(value); };
    const stream = entry.mux.open({ ip: 'relay-update' });
    const sock = tls.connect({ socket: stream, servername: `${entry.id}.relay.lamplit`, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    sock.on('error', (err) => finish(err));
    const req = http.request({ createConnection: () => sock, path: urlPath, method: 'GET', headers: { host: `${entry.id}.relay.lamplit`, connection: 'close' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); finish(new Error(`HTTP ${res.statusCode}`)); return; }
      const parts = [];
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n > maxBytes) { req.destroy(); finish(new Error('too large')); return; }
        parts.push(d);
      });
      res.on('end', () => finish(null, Buffer.concat(parts)));
      res.on('error', (err) => finish(err));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('no answer in time')); }, 30000);
    req.on('error', (err) => finish(err));
    req.end();
  });
}

/**
 * createRelayUpdater({running:{version, sha256}, stateDir, keys?, onStaged(version), minIntervalMs?, log?})
 *   offer(from, {version, sha256})  a computer's nudge; from = {id, fetch(path, max), tell?()}
 *   install(manifest, bytes)        check and stage (also used by the tests)
 *   confirmRunning()                this version is up: last = {ok:true} if it is the newest tried (1.5.51)
 *   status()                        {version, sha256, auto, fetching, last}
 */
export function createRelayUpdater({ running, stateDir, keys = RELAY_UPDATE_KEYS, onStaged = () => {}, minIntervalMs = 10 * 60 * 1000, log = () => {} }) {
  let fetching = false;
  let lastFetchAt = 0;
  let last = readBook(stateDir).last;
  // A version that failed to start may have left its own note (1.5.50) - the supervisor
  // in /opt may be one from before it kept the child's last lines. Kept in the book:
  // the folder goes when the next version is staged.
  if (last && !last.ok && !last.detail && /^\d+\.\d+\.\d+$/.test(String(last.version))) {
    try {
      const detail = relayFailureDetail(fs.readFileSync(failureNote(stateDir, last.version), 'utf8'));
      if (detail) {
        last = { ...last, detail };
        const book = readBook(stateDir);
        if (book.last && book.last.version === last.version && !book.last.ok) { book.last = last; writeBook(stateDir, book); }
      }
    } catch { /* no note */ }
  }

  const remember = (result) => {
    last = { ...result, at: new Date().toISOString() };
    const book = readBook(stateDir);
    book.last = last;
    writeBook(stateDir, book);
  };

  async function install(manifest, bytes) {
    const refuse = (reason) => Object.assign(new Error(reason), { reason });
    if (!manifest || compareRelayVersions(manifest.version, running.version) <= 0) throw refuse('不是更新的版本，没有换');
    if (!verifyRelayUpdate(manifest, bytes, keys)) throw refuse('签名对不上，没有换（中转只运行 Lamplit 签过名的程序）');
    const book = readBook(stateDir);
    if (book.bad.includes(manifest.version)) throw refuse(`${manifest.version} 以前没能正常启动，不再试`);
    const file = stagedFile(stateDir, manifest.version);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    // "Previous" is what runs now: a staged version, or (null) the one in /opt.
    book.previous = book.current && book.current.version === running.version ? book.current : null;
    book.current = { v: 1, version: manifest.version, sha256: manifest.sha256, signature: manifest.signature };
    writeBook(stateDir, book);
    // Only the current and previous staged versions stay on disk.
    const keep = new Set([book.current.version, book.previous?.version].filter(Boolean));
    try {
      for (const v of fs.readdirSync(path.join(stateDir, 'updates'))) if (!keep.has(v)) fs.rmSync(path.join(stateDir, 'updates', v), { recursive: true, force: true });
    } catch { /* nothing to tidy */ }
    log(`relay ${manifest.version} checked (signature, hash, size) and staged`);
    onStaged(manifest.version);
    return manifest.version;
  }

  function offer(from, msg) {
    const version = String(msg?.version || '');
    const sha = String(msg?.sha256 || '');
    // Quietly ignored: not newer, the same code, known bad, busy, asked too recently.
    if (!VERSION_RE.test(version) || compareRelayVersions(version, running.version) <= 0 || sha === running.sha256) return;
    const book = readBook(stateDir);
    if (book.bad.includes(version) || book.current?.version === version) return;
    if (fetching || Date.now() - lastFetchAt < minIntervalMs) return;
    fetching = true;
    lastFetchAt = Date.now();
    (async () => {
      try {
        const manifest = JSON.parse((await from.fetch('/api/relay-update', 16 * 1024)).toString('utf8'));
        const bytes = await from.fetch('/api/relay-update/relay.mjs', MAX_RELAY_CODE + 1);
        await install(manifest, bytes);
      } catch (err) {
        remember({ ok: false, version, reason: err.reason || `没能从电脑取到新版（${err.message}）` });
        log(`relay ${version} not taken: ${last.reason}`);
      } finally {
        fetching = false;
        try { from.tell?.(); } catch { /* tunnel gone */ }
      }
    })();
  }

  /**
   * This version is up (1.5.51): a newer-or-same version than the last result's
   * replaces it with {ok:true}. 11-21: the 1.5.50 relay kept saying "1.5.49 did
   * not start" - the book was read once, before the supervisor's "runs fine".
   * A version rolled back to (older than the failed one) leaves the failure.
   * A fresh install that never updated says nothing.
   */
  function confirmRunning() {
    const book = readBook(stateDir);
    const prior = book.last;
    const updated = book.current?.version === running.version;
    if (prior ? (prior.ok && prior.version === running.version) || compareRelayVersions(running.version, prior.version) < 0 : !updated) return;
    book.last = { ok: true, version: running.version, at: new Date().toISOString() };
    writeBook(stateDir, book);
    last = book.last;
    log(`relay ${running.version} is up; the last update result says so`);
  }

  return {
    offer,
    install,
    confirmRunning,
    // The book as it is now (1.5.51), not as it was at start: the supervisor writes it too.
    status: () => ({ version: running.version, sha256: running.sha256, auto: true, fetching, last: readBook(stateDir).last ?? last }),
  };
}

/** What to start: a staged, signed, newer version not known bad - else the one in /opt. Checked at every start. */
export function chooseCode({ stateDir, builtin, keys = RELAY_UPDATE_KEYS }) {
  const book = readBook(stateDir);
  const c = book.current;
  if (c && !book.bad.includes(c.version) && compareRelayVersions(c.version, builtin.version) > 0) {
    try {
      const file = stagedFile(stateDir, c.version);
      if (verifyRelayUpdate({ ...c, v: 1 }, fs.readFileSync(file), keys)) return { file, version: c.version, sha256: c.sha256, updated: true };
    } catch { /* missing: the builtin */ }
  }
  return { ...builtin, updated: false };
}

/**
 * Keep a relay running (the service's own process). A started version must
 * print its ready line within readyMs and live settleMs; an updated one that
 * does not is marked bad and the one before it starts instead. Exit 75 means
 * "an update is staged": start again at once.
 */
export function runSupervisor({ stateDir, builtin, keys = RELAY_UPDATE_KEYS, spawnChild, readyMs = 30000, settleMs = 60000, restartDelayMs = 3000, log = () => {} }) {
  let stopped = false;
  let child = null;
  let timer = null;

  function rollback(pick, why, tail = '') {
    const book = readBook(stateDir);
    book.bad = [...new Set([...book.bad, pick.version])];
    const back = book.previous && book.previous.version !== pick.version ? book.previous : null;
    book.current = back;
    book.previous = null;
    // Said plainly on the computer (1.5.47 beginner test: the technical cause read like programmer talk); the cause goes to the log.
    // What it printed last goes along (1.5.50: 11-21 the real failure said nothing), addresses taken out.
    book.last = { ok: false, version: pick.version, at: new Date().toISOString(), reason: `新版本 ${pick.version} 没能正常启动，已退回 ${back ? back.version : builtin.version}`, detail: relayFailureDetail(tail || why), };
    writeBook(stateDir, book);
    log(`${book.last.reason} (${why})`);
  }

  function start() {
    if (stopped) return;
    const pick = chooseCode({ stateDir, builtin, keys });
    let ready = false;
    let settled = false;
    let out = '';
    let tail = ''; // the end of everything it printed, for the reason when it fails (1.5.50)
    let settleTimer = null;
    const c = spawnChild(pick);
    child = c;
    const keepTail = (d) => { tail = (tail + d).slice(-6000); };
    c.stdout?.on('data', keepTail);
    c.stderr?.on('data', keepTail);
    const readyTimer = setTimeout(() => { if (!ready) { log(`relay ${pick.version} did not say ready`); c.kill(); } }, readyMs);
    c.stdout?.on('data', (d) => {
      if (ready) return;
      out = (out + d).slice(-8192);
      if (!/"event"\s*:\s*"ready"/.test(out)) return;
      ready = true;
      clearTimeout(readyTimer);
      settleTimer = setTimeout(() => {
        settled = true;
        if (!pick.updated) return;
        const book = readBook(stateDir);
        if (book.last?.ok && book.last.version === pick.version) return;
        book.last = { ok: true, version: pick.version, at: new Date().toISOString() };
        writeBook(stateDir, book);
        log(`relay ${pick.version} is running fine`);
      }, settleMs);
    });
    c.on('exit', (code) => {
      clearTimeout(readyTimer);
      clearTimeout(settleTimer);
      child = null;
      if (stopped) return;
      if (code === 75) { timer = setTimeout(start, 10); return; }
      if (pick.updated && !settled) {
        const why = ready ? 'exited soon after starting' : 'never said ready';
        rollback(pick, why, `${tail}
(${why}, exit code ${code})`);
      }
      timer = setTimeout(start, restartDelayMs);
    });
  }

  start();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* gone */ }
    },
  };
}

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
export function createRelay({ identity, joinSecret, registryFile = '', limits = {}, log = () => {}, tap = null, updater: updaterIn = null } = {}) {
  let updater = updaterIn;
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
  const stunLimiter = createLimiter({ rate: L.stunPerIpPerMin, perMs: 60000, burst: L.stunBurst });
  const counters = { connections: 0, refused: 0, misses: 0, authFailures: 0, replaced: 0, bytesUp: 0, bytesDown: 0, stun: 0 };
  let stunSocket = null;

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
      res.end(JSON.stringify({ ok: true, relay: 'lamplit', tunnels: tunnels.size, stun: Boolean(stunSocket), version: updater?.status().version || RELAY_VERSION, auto: Boolean(updater) }));
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
    // 1.5.47: the computer says hello back with what relay version it has (a
    // nudge: no code). The answer is what this relay runs and how its last
    // update went; a newer offer makes the updater fetch it through this tunnel.
    // seenIp (1.5.49): the address this tunnel came from - the computer compares it with its STUN answer (a proxy in between?).
    const tell = () => mux.control({ type: 'relay-info', ...(updater ? updater.status() : { version: RELAY_VERSION, auto: false }), seenIp: ip });
    let nudges = 0;
    mux.on('control', (msg) => {
      if (msg?.type !== 'relay-hello' || (nudges += 1) > 20) return;
      tell();
      const offer = msg.offer;
      if (updater && offer && typeof offer === 'object') {
        updater.offer({ id, fetch: (p, max) => fetchViaTunnel(entry, p, max), tell }, { type: 'relay-version', version: offer.version, sha256: offer.sha256 });
      }
    });
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
      // A computer that registered here but is away right now (restarting, asleep,
      // updating) is not a scan: its id is 130 random bits only its own devices
      // know. Seen 1.5.39: a phone retrying while its computers restarted was
      // blocked for 10 minutes. Only ids never seen here count toward the block.
      if (id && registry[id]) {
        counters.offline = (counters.offline || 0) + 1;
        socket.destroy();
        return;
      }
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
    // The phone went away: drop the stream. The stream ended: let the phone
    // socket send what it still holds first (a response cut short otherwise).
    socket.on('close', () => stream.destroy());
    stream.on('close', () => {
      if (socket.destroyed) return;
      if (stream.readableEnded) socket.end(); else socket.destroy();
      setTimeout(() => socket.destroy(), 30000).unref?.();
    });
    stream.on('error', () => {});
  }

  /** STUN on UDP port `port` (1.5.46 直连). Resolves when bound; rejects if the port is taken. */
  // `drop()` (tests only): act as if a cloud firewall in front dropped the UDP.
  function listenStun(port, host = '0.0.0.0', { drop = () => false } = {}) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: net.isIPv6(host) ? 'udp6' : 'udp4' });
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => {
        if (drop()) return;
        const ip = cleanIp(rinfo.address);
        if (isBlocked(ip) || !stunLimiter.take(ip)) return;
        const out = stunAnswer(msg, rinfo);
        if (!out) return;
        counters.stun += 1;
        sock.send(out, rinfo.port, rinfo.address);
      });
      sock.bind(port, host, () => {
        sock.removeListener('error', reject);
        sock.on('error', (err) => log(`stun: ${err.message}`));
        stunSocket = sock;
        resolve(sock.address().port);
      });
    });
  }

  return {
    server,
    tunnels,
    listenStun,
    /** Tests: swap the updater (a new one per case). */
    setUpdater(u) { updater = u; },
    registry: () => ({ ...registry }),
    stats: () => ({ ...counters, tunnels: tunnels.size, ips: perIp.size, blocked: blocked.size, stunOn: Boolean(stunSocket) }),
    close() {
      for (const t of tunnels.values()) t.mux.close();
      server.close();
      try { stunSocket?.close(); } catch { /* closed */ }
      stunSocket = null;
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

/**
 * Started as a service (no --serve): the supervisor (1.5.47). It runs the
 * relay as a child - this very file, or a signed newer version staged in the
 * data folder - and rolls back one that does not come up. This part is the
 * copy installed over SSH into /opt (root-owned): keep it small.
 */
function supervise(dataDir) {
  const log = (line) => console.error(`[relay-supervisor] ${new Date().toISOString()} ${line}`);
  const self = fileURLToPath(import.meta.url);
  const builtin = { file: self, version: RELAY_VERSION, sha256: sha256Bytes(fs.readFileSync(self)) };
  const passArgs = process.argv.slice(2);
  const sup = runSupervisor({
    stateDir: dataDir,
    builtin,
    log,
    spawnChild: (pick) => {
      log(`starting relay ${pick.version}${pick.updated ? ' (updated, signature checked)' : ''}`);
      // stdin is a pipe the child watches: when this process dies (even killed hard), the child goes too.
      const c = spawn(process.execPath, [pick.file, '--serve', ...passArgs], {
        env: { ...process.env, LAMPLIT_RELAY_RUNNING: JSON.stringify({ version: pick.version, sha256: pick.sha256 }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      c.stdout.on('data', (d) => process.stdout.write(d));
      c.stderr.on('data', (d) => process.stderr.write(d));
      c.on('error', (err) => log(`could not start: ${err.message}`));
      return c;
    },
  });
  const stop = () => { sup.stop(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Under the supervisor (1.5.50): if this run ends before it says ready, leave the
 * end of what it printed next to the staged file. The supervisor in /opt may be
 * one that keeps nothing (1.5.47-1.5.49); the next relay that runs reads the note
 * (createRelayUpdater) and the computer shows it. The builtin has no folder there:
 * nothing is written. Returns "it is up": stop keeping and noting.
 */
function noteStartFailure(dataDir, version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) return () => {};
  let tail = '';
  let up = false;
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { tail = (tail + chunk).slice(-6000); return write(chunk, ...rest); };
  process.on('exit', (code) => {
    if (up) return;
    try { fs.writeFileSync(failureNote(dataDir, version), relayFailureDetail(`${tail}\n(exited before it was ready, code ${code})`), { mode: 0o600 }); } catch { /* the builtin, or no room */ }
  });
  return () => { up = true; process.stderr.write = write; tail = ''; };
}

async function main() {
  const port = Number(arg('port', process.env.LAMPLIT_RELAY_PORT || DEFAULT_PORT));
  const host = arg('host', process.env.LAMPLIT_RELAY_HOST || '0.0.0.0');
  const dataDir = path.resolve(arg('data', process.env.LAMPLIT_RELAY_DATA || path.join(process.cwd(), 'relay-data')));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!process.argv.includes('--serve')) { supervise(dataDir); return; }
  // Under the supervisor: what runs, and the updater; gone when the supervisor is.
  let running = null;
  try { running = JSON.parse(process.env.LAMPLIT_RELAY_RUNNING || 'null'); } catch { running = null; }
  if (running) {
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
    process.stdin.resume();
  }
  const startedFine = running ? noteStartFailure(dataDir, running.version) : () => {};
  const identity = loadOrMakeIdentity(path.join(dataDir, 'tls'), 'lamplit-relay');
  const joinFile = path.join(dataDir, 'join-secret');
  let joinSecret = '';
  try { joinSecret = fs.readFileSync(joinFile, 'utf8').trim(); } catch { /* make one */ }
  if (joinSecret.length < 16) {
    joinSecret = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(joinFile, `${joinSecret}\n`, { mode: 0o600 });
  }
  const log = (line) => console.error(`[relay] ${new Date().toISOString()} ${line}`);
  let relay = null;
  // A staged update: close the tunnels (the computers reconnect in a second), exit 75, the supervisor starts it.
  const updater = running && /^\d+\.\d+\.\d+$/.test(String(running.version)) && /^[0-9a-f]{64}$/.test(String(running.sha256))
    ? createRelayUpdater({ running, stateDir: dataDir, log, onStaged: (v) => { log(`relay ${v} staged; restarting into it`); setTimeout(() => { relay?.close(); process.exit(75); }, 1000); } })
    : null;
  relay = createRelay({ identity, joinSecret, registryFile: path.join(dataDir, 'machines.json'), log, updater });
  relay.server.on('error', (err) => { log(`listen failed: ${err.message}`); process.exit(1); });
  relay.server.listen(port, host, async () => {
    const bound = relay.server.address().port;
    // STUN on the same port number, UDP (1.5.46 直连). Without it everything still works through the relay.
    let stun = false;
    try { await relay.listenStun(bound, host); stun = true; } catch (err) { log(`STUN (UDP ${bound}) not started: ${err.message}`); }
    console.log(JSON.stringify({ event: 'ready', port: bound, fingerprint: identity.fingerprint, stun }));
    startedFine();
    // Said at once (1.5.51): computers connecting from now on hear "updated to x", not an older failure.
    try { updater?.confirmRunning(); } catch (err) { log(`could not note the update result: ${err.message}`); }
    log(`listening on ${host}:${bound} (TCP${stun ? ' + UDP for STUN' : ''}); certificate ${identity.fingerprint}`);
  });
  setInterval(() => {
    const s = relay.stats();
    log(`tunnels ${s.tunnels}, connections ${s.connections}, refused ${s.refused}, misses ${s.misses}, auth failures ${s.authFailures}, blocked ${s.blocked}`);
  }, 30 * 60 * 1000).unref();
  const stop = () => { relay.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Is this file what node was asked to run? Both sides with links resolved (1.5.50):
 * node resolves them for the main file, and with DynamicUser the data folder
 * /var/lib/lamplit-relay is a link to /var/lib/private/lamplit-relay - a staged
 * version started from there compared unequal, never ran main() and exited at
 * once (11-21: the first real update, 1.5.47 -> 1.5.49, rolled back).
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(me);
  } catch {
    return path.resolve(process.argv[1]) === me;
  }
}

if (isMainModule()) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
