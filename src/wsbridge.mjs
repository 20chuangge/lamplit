/**
 * wsbridge.mjs - a WebSocket <-> TCP bridge, enough for noVNC to reach a VNC
 * server. Linux hubs use websockify for this; Windows has none, so the hub
 * does it itself (RFC 6455: handshake, masked client frames, unmasked binary
 * server frames, ping/pong, close). The VNC stream is a byte stream, so
 * fragmented messages are forwarded as they arrive.
 *
 * With `vnc: {password}` (1.5.53, Windows: TightVNC asks for a password) the
 * hub does the VNC authentication itself before it answers the upgrade, then
 * offers the page RFB security "None": the page never holds the password, and
 * a program on the machine that reaches 127.0.0.1:5900 directly is asked for it.
 */

import crypto from 'node:crypto';
import net from 'node:net';

import { chunkReader, rfbClientHandshake } from './vncauth.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(payload, opcode = 0x2) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** A 32-bit big-endian number. */
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

/**
 * Take over an HTTP upgrade (already authorised by the caller) and connect it
 * to host:port. Returns false when the request is not a WebSocket handshake.
 * vnc: {password} - authenticate to the VNC server here (see the top).
 */
export function bridgeWebSocket(req, socket, head, { host = '127.0.0.1', port, vnc = null, timeoutMs = 15000 }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
  const protocol = offered.includes('binary') ? 'binary' : '';

  const upstream = net.connect(port, host);
  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let open = false;
  let closed = false;
  // 'pipe': bytes go straight through. With vnc: 'server' (the hub signs in to
  // VNC), then 'page' (the page is told: no password), then 'pipe'.
  let phase = vnc ? 'server' : 'pipe';
  const fromServer = chunkReader();
  const fromPage = chunkReader();

  const close = () => {
    if (closed) return;
    closed = true;
    fromServer.end();
    fromPage.end();
    try { if (open) socket.end(frame(Buffer.alloc(0), 0x8)); } catch { /* gone */ }
    socket.destroy();
    upstream.destroy();
  };
  const refuse = () => {
    if (!open) { try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ } }
    close();
  };
  const toServer = (payload) => { if (phase === 'pipe') upstream.write(payload); else fromPage.push(payload); };

  const pump = () => {
    // Parse as many complete client frames as are buffered.
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let len = pending[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (pending.length < 4) return;
        len = pending.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (pending.length < 10) return;
        len = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + len) return;
      const payload = Buffer.from(pending.subarray(offset, offset + len));
      if (masked) {
        const mask = pending.subarray(maskAt, maskAt + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      pending = pending.subarray(offset + len);
      if (opcode === 0x8) { close(); return; }
      if (opcode === 0x9) { socket.write(frame(payload, 0xa)); continue; }
      if (opcode === 0xa) continue;
      toServer(payload); // text, binary or continuation: bytes for VNC
    }
  };

  const answerUpgrade = () => {
    open = true;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
      '',
      '',
    ].join('\r\n'));
    pump();
  };

  /** The hub signs in to VNC, then plays the server's part of the handshake for the page with security None. */
  async function signInFirst() {
    const timer = setTimeout(refuse, timeoutMs);
    try {
      await rfbClientHandshake({ read: (n) => fromServer.read(n), write: (b) => upstream.write(b) }, { password: vnc.password || '' });
      phase = 'page';
      answerUpgrade();
      socket.write(frame(Buffer.from('RFB 003.008\n', 'latin1')));
      const minor = Number(/^RFB 003\.00(\d)\n$/.exec((await fromPage.read(12)).toString('latin1'))?.[1] || 8);
      if (minor < 7) socket.write(frame(u32(1)));
      else {
        socket.write(frame(Buffer.from([1, 1])));
        await fromPage.read(1);
        if (minor >= 8) socket.write(frame(u32(0)));
      }
      phase = 'pipe';
      const fromPageRest = fromPage.rest();
      if (fromPageRest.length) upstream.write(fromPageRest);
      const fromServerRest = fromServer.rest();
      if (fromServerRest.length) socket.write(frame(fromServerRest));
    } catch (err) {
      if (err?.code && err.code !== 'VNC_CLOSED') console.error(`[desktop] VNC sign-in failed: ${err.code}`);
      refuse();
    } finally {
      clearTimeout(timer);
    }
  }

  upstream.on('connect', () => { if (vnc) signInFirst(); else answerUpgrade(); });
  upstream.on('data', (chunk) => { if (phase === 'pipe') socket.write(frame(chunk)); else fromServer.push(chunk); });
  upstream.on('error', refuse);
  upstream.on('close', close);
  socket.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (open) pump();
  });
  socket.on('error', close);
  socket.on('close', close);
  return true;
}
