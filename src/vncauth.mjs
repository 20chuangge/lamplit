/**
 * vncauth.mjs - the VNC password (1.5.53, security review N2).
 *
 * Windows machines show their screen through TightVNC on 127.0.0.1:5900. It
 * had no password: "only loopback" kept the network out, but a bot's own
 * command on that machine is loopback too, and could see and drive the
 * console. Now TightVNC asks for a password (RFB "VNC authentication", RFC
 * 6143 7.2.2), its control commands (tvnserver -controlservice -connect ...)
 * ask for an administrative one, and the hub answers for the page: the page
 * itself never learns the password (see wsbridge.mjs).
 *
 * VNC authentication is DES over a 16-byte challenge with the password (8
 * characters at most) as the key, each key byte bit-reversed. TightVNC keeps
 * its passwords in the registry DES-encrypted under a fixed, public key (an
 * obfuscation, not a protection: the registry key itself is locked instead).
 * DES is written out here: Node's OpenSSL 3 has it only in the legacy
 * provider, and the hub must work on every Node and Electron it runs on.
 */
import crypto from 'node:crypto';

// --- DES (FIPS 46-3), encryption of single 8-byte blocks ----------------------

const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

const bitsOf = (buf) => { const out = []; for (const b of buf) for (let i = 7; i >= 0; i -= 1) out.push((b >> i) & 1); return out; };
const bytesOf = (bits) => { const out = Buffer.alloc(bits.length / 8); bits.forEach((v, i) => { out[i >> 3] |= v << (7 - (i & 7)); }); return out; };
const permute = (bits, table) => table.map((n) => bits[n - 1]);

function subkeys(key8) {
  const k = permute(bitsOf(key8), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  const keys = [];
  for (const s of SHIFTS) {
    c = c.slice(s).concat(c.slice(0, s));
    d = d.slice(s).concat(d.slice(0, s));
    keys.push(permute(c.concat(d), PC2));
  }
  return keys;
}

/** DES-encrypt one 8-byte block with an 8-byte key (standard bit order). */
export function desEncryptBlock(key8, block8) {
  const keys = subkeys(key8);
  const b = permute(bitsOf(block8), IP);
  let l = b.slice(0, 32);
  let r = b.slice(32);
  for (const k of keys) {
    const x = permute(r, E).map((v, i) => v ^ k[i]);
    const out = [];
    for (let s = 0; s < 8; s += 1) {
      const six = x.slice(s * 6, s * 6 + 6);
      const row = (six[0] << 1) | six[5];
      const col = (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4];
      const v = S[s][row * 16 + col];
      out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const f = permute(out, P);
    [l, r] = [r, l.map((v, i) => v ^ f[i])];
  }
  return bytesOf(permute(r.concat(l), FP));
}

// --- VNC ----------------------------------------------------------------------

const reverseBits = (b) => { let r = 0; for (let i = 0; i < 8; i += 1) r |= ((b >> i) & 1) << (7 - i); return r; };
/** The 8 key bytes a VNC password stands for (zero-padded, cut at 8). */
const passwordBytes = (password) => { const k = Buffer.alloc(8); Buffer.from(String(password || ''), 'latin1').copy(k, 0, 0, 8); return k; };

/** The answer to a VNC authentication challenge (16 bytes). */
export function vncResponse(password, challenge) {
  const key = Buffer.from(passwordBytes(password).map(reverseBits));
  return Buffer.concat([desEncryptBlock(key, challenge.subarray(0, 8)), desEncryptBlock(key, challenge.subarray(8, 16))]);
}

/** The fixed key VNC servers keep stored passwords under (public; already in DES bit order). */
export const VNC_STORE_KEY = Buffer.from('e84ad660c4721ae0', 'hex');
/** A password as TightVNC keeps it in the registry: 8 bytes, REG_BINARY. */
export function vncStoredPassword(password) {
  return desEncryptBlock(VNC_STORE_KEY, passwordBytes(password));
}

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@^_~';
/** A random 8-character password (what VNC authentication can use: 8 is its limit). */
export function randomVncPassword() {
  return Array.from(crypto.randomBytes(8), (b) => CHARS[b % CHARS.length]).join('');
}

/** Three different passwords: full control, view only, and TightVNC's administrative one. */
export function newVncSecret() {
  const secret = { password: randomVncPassword(), viewOnly: randomVncPassword(), control: randomVncPassword() };
  while (secret.viewOnly === secret.password) secret.viewOnly = randomVncPassword();
  return { v: 1, ...secret, createdAt: new Date().toISOString() };
}

export const isVncSecret = (s) => Boolean(s && typeof s.password === 'string' && s.password.length >= 6 && typeof s.viewOnly === 'string' && typeof s.control === 'string');

/**
 * The client half of an RFB handshake up to the point a viewer would send
 * ClientInit, on a byte source: `read(n)` -> Promise<Buffer> of exactly n
 * bytes, `write(buf)`. VNC authentication with `password`, or None when the
 * server offers only that. -> {security: 1|2} ; throws {code} on refusal.
 */
export async function rfbClientHandshake({ read, write }, { password = '' } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const version = (await read(12)).toString('latin1');
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
  if (!m) throw fail('VNC_NOT_RFB', 'not a VNC server');
  const minor = Number(m[1]) > 3 ? 8 : Math.min(8, Number(m[2]));
  write(Buffer.from(minor >= 8 ? 'RFB 003.008\n' : minor === 7 ? 'RFB 003.007\n' : 'RFB 003.003\n', 'latin1'));
  let type;
  if (minor >= 7) {
    const n = (await read(1))[0];
    if (!n) throw fail('VNC_REFUSED', (await read((await read(4)).readUInt32BE(0))).toString('utf8'));
    const types = [...(await read(n))];
    type = types.includes(2) && password ? 2 : types.includes(1) ? 1 : 0;
    if (!type) throw fail('VNC_NO_SECURITY', types.includes(2) ? 'the VNC server wants a password and none is set up' : 'no security type in common');
    write(Buffer.from([type]));
  } else {
    type = (await read(4)).readUInt32BE(0);
    if (type === 0) throw fail('VNC_REFUSED', (await read((await read(4)).readUInt32BE(0))).toString('utf8'));
    if (type === 2 && !password) throw fail('VNC_NO_SECURITY', 'the VNC server wants a password and none is set up');
  }
  if (type === 2) write(vncResponse(password, await read(16)));
  if (type === 2 || minor >= 8) {
    const result = (await read(4)).readUInt32BE(0);
    if (result !== 0) {
      let why = 'wrong VNC password';
      if (minor >= 8) { try { why = (await read((await read(4)).readUInt32BE(0))).toString('utf8') || why; } catch { /* closed */ } }
      throw fail('VNC_AUTH_FAILED', why);
    }
  }
  return { security: type };
}

/** A reader over a stream of chunks: read(n) resolves with exactly n bytes; rest() gives what is left over. */
export function chunkReader() {
  let buf = Buffer.alloc(0);
  let want = null;
  let ended = null;
  const check = () => {
    if (!want) return;
    if (buf.length >= want.n) { const out = buf.subarray(0, want.n); buf = buf.subarray(want.n); const w = want; want = null; w.resolve(Buffer.from(out)); return; }
    if (ended) { const w = want; want = null; w.reject(ended); }
  };
  return {
    push(chunk) { buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk); check(); },
    end(err = Object.assign(new Error('closed'), { code: 'VNC_CLOSED' })) { ended = err; check(); },
    read(n) { return new Promise((resolve, reject) => { want = { n, resolve, reject }; check(); }); },
    rest() { const out = buf; buf = Buffer.alloc(0); return out; },
  };
}
