#!/usr/bin/env node
/**
 * smoke-relay.mjs - the relay (第 1 步原型), checked without the internet.
 *
 * Everything runs on 127.0.0.1: a relay (hub/relay/relay.mjs), a computer's
 * link to it (src/relaylink.mjs) in front of a small test server, and clients
 * that connect through the relay the way the phone app and other machines do.
 *
 *   relayChecks({check})             SNI, certificates, multiplexing, flow
 *                                    control, limits, forged registrations, what
 *                                    the relay can see, cleanup and reconnects
 *   relayServerChecks({check, ...})  the real hub behind the relay (smoke.mjs):
 *                                    remote, never local; pairing rules
 *
 * Run alone: node scripts/smoke-relay.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { CONTROL_NAME, createLimiter, createRelay, idFromSni, makeSelfSignedCert, openTunnel, readClientHello, wsAccept, WsConn } from '../hub/relay/relay.mjs';
import { connectViaRelay, createRelayLink, relayFetch } from '../src/relaylink.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(20);
  }
}
const errorCode = (p) => p.then(() => null, (err) => err.code || err.message);
const listen = (server, host = '127.0.0.1') => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));

/** The first bytes a TLS client sends, captured from a real tls.connect. */
function captureClientHello(options) {
  return new Promise((resolve) => {
    const sink = net.createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (readClientHello(buf).state !== 'more') { s.destroy(); sink.close(); resolve(buf); }
      });
      s.on('error', () => {});
    });
    listen(sink).then((port) => {
      const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ...options });
      c.on('error', () => {});
    });
  });
}

/** A computer: a test HTTP server behind a relay link. */
function makeComputer(dataDir) {
  const big = crypto.randomBytes(4 * 1024 * 1024);
  const bigHash = crypto.createHash('sha256').update(big).digest('hex');
  const seen = [];
  const handler = (req, res) => {
    seen.push({ url: req.url, remote: req.socket.remoteAddress, encrypted: Boolean(req.socket.encrypted), viaRelay: Boolean(req.socket.viaRelay) });
    if (req.url === '/hello') { res.end('hello'); return; }
    if (req.url.startsWith('/slow')) { setTimeout(() => res.end(`slow ${req.url}`), 150); return; }
    if (req.url === '/big') { res.setHeader('content-length', big.length); res.end(big); return; }
    if (req.url === '/echo') {
      const parts = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => res.end(Buffer.concat(parts)));
      return;
    }
    res.statusCode = 404;
    res.end();
  };
  // A WebSocket echo (what the screen viewer's VNC socket looks like).
  const upgrade = (req, socket, head) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    const ws = new WsConn(socket, { head });
    ws.on('message', (m) => ws.send(m));
  };
  const link = createRelayLink({ dataDir, handler, upgrade, log: () => {}, replacedWaitMs: 1500 });
  return { link, seen, big, bigHash };
}

/** A WebSocket client over a socket that already reached the computer. */
function wsOver(socket) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      if (!/^HTTP\/1\.1 101/.test(head.toString('latin1'))) { reject(new Error('no upgrade')); return; }
      resolve(new WsConn(socket, { client: true, head: head.subarray(end + 4) }));
    };
    socket.on('data', onData);
  });
}

export async function relayChecks({ check }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-relay-'));
  const cleanup = [];
  try {
    // ---------------------------------------------------------------- SNI
    const id = 'k4j2m7p9q3r8s5t6v1w0';
    const hello = await captureClientHello({ servername: `${id}.relay.lamplit` });
    const parsed = readClientHello(hello);
    check('relay: SNI is read from a real ClientHello', parsed.state === 'ok' && parsed.sni === `${id}.relay.lamplit` && idFromSni(parsed.sni) === id, JSON.stringify(parsed));
    let partial = true;
    for (let n = 1; n < hello.length; n += 37) if (readClientHello(hello.subarray(0, n)).state !== 'more') partial = false;
    check('relay: a ClientHello cut into pieces waits for the rest', partial);
    // The same hello split across two TLS records still parses.
    const body = hello.subarray(5);
    const rec = (b) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01, b.length >> 8, b.length & 255]), b]);
    const split = Buffer.concat([rec(body.subarray(0, 40)), rec(body.subarray(40))]);
    check('relay: a ClientHello split over two records parses', readClientHello(split).sni === `${id}.relay.lamplit`);
    const noName = await captureClientHello({}); // an IP address: no SNI at all
    check('relay: no SNI reads as empty (and routes nowhere)', readClientHello(noName).state === 'ok' && readClientHello(noName).sni === '' && idFromSni('') === '');
    check('relay: plain HTTP is not a ClientHello', readClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')).state === 'bad');
    check('relay: garbage after a TLS header is refused, not crashed on', ['ok', 'bad'].includes(readClientHello(Buffer.concat([Buffer.from([0x16, 3, 1, 0, 60, 1, 0, 0, 56]), crypto.randomBytes(56)])).state));
    check('relay: names that are not ids are not routed', idFromSni('admin.relay.lamplit') === '' && idFromSni('../../etc') === '' && idFromSni('ABCDEFGHIJKLMNOPQRST.x') === '');

    // ---------------------------------------------------------- certificate
    const made = makeSelfSignedCert({ commonName: 'lamplit' });
    const x = new crypto.X509Certificate(made.cert);
    check('relay: the self-signed certificate parses and verifies', x.verify(x.publicKey) && x.fingerprint256.replace(/:/g, '').toLowerCase() === made.fingerprint);
    check('relay: the private key is EC P-256 PKCS#8', /BEGIN PRIVATE KEY/.test(made.key) && crypto.createPrivateKey(made.key).asymmetricKeyDetails?.namedCurve === 'prime256v1');

    // ---------------------------------------------------------- limiter
    const lim = createLimiter({ rate: 3, perMs: 60000 });
    check('relay: the limiter allows a burst, then refuses', [1, 2, 3].every(() => lim.take('a')) && !lim.take('a') && lim.take('b'));

    // ---------------------------------------------------------- a relay and a computer
    const relayId = makeSelfSignedCert({ commonName: 'lamplit-relay' });
    const join = crypto.randomBytes(18).toString('base64url');
    const tapped = [];
    const relay = createRelay({ identity: relayId, joinSecret: join, registryFile: path.join(tmp, 'machines.json'), tap: (tid, dir, bytes) => tapped.push({ tid, dir, bytes: Buffer.from(bytes) }), limits: { pingEveryMs: 500, deadAfterMs: 3000 } });
    const relayPort = await listen(relay.server);
    cleanup.push(() => relay.close());

    const pc = makeComputer(path.join(tmp, 'pc'));
    cleanup.push(() => pc.link.stop());
    pc.link.configure({ enabled: true, host: '127.0.0.1', port: relayPort, relayFingerprint: relayId.fingerprint, join });
    const online = await until(() => pc.link.view().state === 'online', 5000);
    check('relay: the computer registers its tunnel with the join secret', online, JSON.stringify(pc.link.view()));
    const desc = pc.link.descriptor();
    check('relay: the computer has a random id and its own certificate fingerprint', /^[a-z2-7]{26}$/.test(desc?.id || '') && /^[0-9a-f]{64}$/.test(desc?.fp || '') && desc.fp !== relayId.fingerprint);
    await until(() => fs.existsSync(path.join(tmp, 'machines.json')), 2000); // saved a moment later
    const keyFile = fs.readFileSync(path.join(tmp, 'pc', 'relay-tls', 'key.pem'), 'utf8');
    check('relay: the computer\'s private key stays in its own data folder', /PRIVATE KEY/.test(keyFile) && !fs.readFileSync(path.join(tmp, 'machines.json'), 'utf8').includes(keyFile.slice(40, 80)));
    const reg = JSON.parse(fs.readFileSync(path.join(tmp, 'machines.json'), 'utf8'));
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'pc', 'relay-link.json'), 'utf8'));
    check('relay: the relay keeps only a hash of the computer\'s key', reg[desc.id]?.keyHash && !JSON.stringify(reg).includes(cfg.key));

    // ---------------------------------------------------------- through the relay
    const target = { ...desc, host: '127.0.0.1', port: relayPort };
    const one = await relayFetch(target, '/hello');
    check('relay: a request reaches the computer through the relay', one.status === 200 && (await one.text()) === 'hello');
    const last = pc.seen.at(-1);
    check('relay: TLS ended on the computer, and it knows the request came by relay', last?.encrypted && last?.viaRelay && last?.remote === 'relay', JSON.stringify(last));

    // Many at once in one tunnel.
    const t0 = Date.now();
    const many = await Promise.all(Array.from({ length: 24 }, (_, i) => relayFetch(target, `/slow${i}`).then((r) => r.text())));
    check('relay: 24 connections at once share the one tunnel', many.every((t, i) => t === `slow /slow${i}`) && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    check('relay: those were separate connections in one tunnel', relay.tunnels.size === 1 && relay.tunnels.get(desc.id).mux.opened >= 24);

    // Flow control: 4 MB down, 1 MB up, intact.
    const bigRes = await relayFetch(target, '/big');
    const bigBody = Buffer.from(await bigRes.arrayBuffer());
    check('relay: 4 MB comes back intact (flow control)', crypto.createHash('sha256').update(bigBody).digest('hex') === pc.bigHash);
    const up = crypto.randomBytes(1024 * 1024);
    const echoed = Buffer.from(await (await relayFetch(target, '/echo', { method: 'POST', body: up })).arrayBuffer());
    check('relay: 1 MB goes up and back intact', echoed.equals(up));

    // A slow reader holds back only its own connection.
    const slowSock = await connectViaRelay(target);
    slowSock.write('GET /big HTTP/1.1\r\nHost: x\r\n\r\n');
    slowSock.pause();
    await sleep(300);
    const t1 = Date.now();
    const quick = await relayFetch(target, '/hello').then((r) => r.text());
    check('relay: a stalled download does not hold up other connections', quick === 'hello' && Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
    const pending = [...relay.tunnels.get(desc.id).mux.streams.values()].reduce((n, s) => n + s.writableLength + s.readableLength, 0);
    check('relay: the relay buffers a bounded amount for a stalled reader', pending < 2 * 1024 * 1024, `${pending} bytes`);
    slowSock.destroy();

    // WebSocket (the screen viewer) through the relay.
    const ws = await wsOver(await connectViaRelay(target));
    const reply = new Promise((resolve) => ws.once('message', (m) => resolve(m.toString())));
    ws.send(Buffer.from('frame-1'));
    check('relay: a WebSocket (VNC viewer) works through the relay', (await Promise.race([reply, sleep(2000).then(() => 'timeout')])) === 'frame-1');
    ws.close();

    // What the relay saw: TLS records only, never the plaintext.
    tapped.length = 0;
    const marker = `SECRET-${crypto.randomBytes(8).toString('hex')}`;
    const sent = await relayFetch(target, '/echo', { method: 'POST', body: marker, headers: { authorization: `Bearer ${marker}` } });
    check('relay: the marker went through', (await sent.text()) === marker);
    const all = Buffer.concat(tapped.map((t) => t.bytes));
    const records = (dir) => {
      const b = Buffer.concat(tapped.filter((t) => t.dir === dir).map((t) => t.bytes));
      let p = 0;
      while (p + 5 <= b.length) {
        if (![0x14, 0x15, 0x16, 0x17].includes(b[p]) || b[p + 1] !== 3) return false;
        p += 5 + b.readUInt16BE(p + 3);
      }
      return p === b.length && b.length > 0;
    };
    check('relay: the relay sees no plaintext (no body, no token)', all.length > 0 && !all.includes(Buffer.from(marker)) && !all.includes(Buffer.from('POST /echo')));
    check('relay: everything it passed on, both ways, is TLS records', records('up') && records('down'));

    // A wrong fingerprint: the client stops before sending anything.
    check('relay: a different certificate on the computer is refused by the client', (await errorCode(connectViaRelay({ ...target, fp: 'a'.repeat(64) }))) === 'RELAY_CERT_MISMATCH');

    // ---------------------------------------------------------- registration
    const reg1 = (over) => errorCode(openTunnel({ host: '127.0.0.1', port: relayPort, relayFingerprint: relayId.fingerprint, id: desc.id, key: crypto.randomBytes(32).toString('base64url'), ...over }).then((t) => t.mux.close()));
    check('relay: a forged registration (right id, wrong key) is refused', (await reg1({})) === 'RELAY_UNAUTHORIZED');
    check('relay: a new id without the join secret is refused', (await reg1({ id: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' })) === 'RELAY_UNAUTHORIZED');
    check('relay: a new id with a wrong join secret is refused', (await reg1({ id: 'yyyyyyyyyyyyyyyyyyyyyyyyyy', join: 'not-the-secret-at-all' })) === 'RELAY_UNAUTHORIZED');
    check('relay: a relay with another certificate is not trusted (no key sent)', (await reg1({ relayFingerprint: 'b'.repeat(64) })) === 'RELAY_CERT_MISMATCH');
    check('relay: the real tunnel survived the forgeries', pc.link.view().state === 'online' && relay.tunnels.size === 1);

    // A second tunnel with the same id and key replaces the first, which is told.
    const replacedSeen = new Promise((resolve) => {
      const t = relay.tunnels.get(desc.id);
      t.mux.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    const second = await openTunnel({ host: '127.0.0.1', port: relayPort, relayFingerprint: relayId.fingerprint, id: desc.id, key: cfg.key });
    check('relay: the same id again replaces the old tunnel', await replacedSeen);
    check('relay: the computer that was replaced knows why', await until(() => pc.link.view().state !== 'online', 2000));
    second.mux.close();
    check('relay: after the other one left, the computer is back (reconnect with backoff)', await until(() => pc.link.view().state === 'online', 8000));

    // ---------------------------------------------------------- disconnects
    relay.tunnels.get(desc.id).mux.close();
    check('relay: a dropped tunnel reconnects by itself', await until(() => pc.link.view().state === 'online' && relay.tunnels.size === 1, 8000));
    const open = await connectViaRelay(target);
    const closed = new Promise((resolve) => open.once('close', () => resolve(true)));
    pc.link.stop();
    check('relay: turning the link off closes the open connections', await Promise.race([closed, sleep(3000).then(() => false)]));
    check('relay: the relay forgets a tunnel that went away', await until(() => relay.tunnels.size === 0, 3000));
    check('relay: with the computer gone, a connection is refused at once', (await errorCode(connectViaRelay(target, { timeoutMs: 3000 }))) !== null);

    // ---------------------------------------------------------- limits
    const strict = createRelay({ identity: relayId, joinSecret: join, limits: { connBurst: 5, connPerIpPerMin: 5, missesPerIpPer10Min: 3, blockMs: 60000 } });
    const strictPort = await listen(strict.server);
    cleanup.push(() => strict.close());
    const attempt = () => new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: strictPort, servername: 'abcdefghijklmnopqrstuvwxyz.x', rejectUnauthorized: false });
      s.on('error', () => resolve('closed'));
      s.on('close', () => resolve('closed'));
    });
    for (let i = 0; i < 4; i += 1) await attempt();
    check('relay: an IP that keeps asking for unknown computers is blocked', strict.stats().blocked === 1 && strict.stats().misses >= 3, JSON.stringify(strict.stats()));
    const strict2 = createRelay({ identity: relayId, joinSecret: join, limits: { connBurst: 5, connPerIpPerMin: 5 } });
    const strict2Port = await listen(strict2.server);
    cleanup.push(() => strict2.close());
    const raw = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const s = net.connect(strict2Port, '127.0.0.1');
      s.on('error', () => {});
      s.on('close', () => resolve());
      setTimeout(() => s.destroy(), 300);
    })));
    check('relay: new connections per IP are rate limited', raw.length === 8 && strict2.stats().refused >= 3, JSON.stringify(strict2.stats()));
    const bad = await new Promise((resolve) => {
      const s = net.connect(strict2Port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\n\r\n'));
      s.on('error', () => resolve('closed'));
      s.on('close', () => resolve('closed'));
      setTimeout(() => resolve('open'), 2000);
    });
    check('relay: a connection that is not TLS is dropped', bad === 'closed');
    // The control plane answers its own name only.
    const health = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: relayPort, servername: CONTROL_NAME, rejectUnauthorized: false }, () => s.write('GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = '';
      s.on('data', (d) => { out += d; });
      s.on('close', () => resolve(out));
      s.on('error', () => resolve(out));
    });
    check('relay: the control plane answers /health', /"relay":"lamplit"/.test(health));
  } finally {
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The real hub behind a relay (called from smoke.mjs with the hub it booted).
 * `api(path, opts)` reaches the hub directly as the human's app does.
 */
export async function relayServerChecks({ check, api, makePairLink }) {
  const relayId = makeSelfSignedCert({ commonName: 'lamplit-relay' });
  const join = crypto.randomBytes(18).toString('base64url');
  const relay = createRelay({ identity: relayId, joinSecret: join });
  const relayPort = await listen(relay.server);
  try {
    const off = await api('/api/relay-link');
    check('relay link: off by default', off.status === 200 && off.body.enabled === false && off.body.descriptor === null);
    const refused = await api('/api/relay-link', { method: 'PUT', body: { enabled: true }, noLocalKey: true });
    check('relay link: a program without the app\'s key cannot turn it on', refused.status === 403);
    const half = await api('/api/relay-link', { method: 'PUT', body: { enabled: true } });
    check('relay link: it cannot be on without an address and fingerprint', half.status === 400);
    const on = await api('/api/relay-link', { method: 'PUT', body: { enabled: true, host: '127.0.0.1', port: relayPort, relayFingerprint: relayId.fingerprint, join } });
    check('relay link: turned on with the relay\'s address, fingerprint and join secret', on.status === 200 && on.body.enabled && !('join' in on.body) && !('key' in on.body), JSON.stringify(on.body));
    const up = await until(async () => (await api('/api/relay-link')).body.state === 'online', 8000);
    check('relay link: the hub\'s tunnel comes up', up);
    const desc = (await api('/api/relay-link')).body.descriptor;
    const target = { ...desc, host: '127.0.0.1', port: relayPort };

    const auth = await relayFetch(target, '/api/auth').then(async (r) => ({ status: r.status, body: await r.json() }));
    check('relay link: a request through the relay is never local', auth.status === 200 && auth.body.mode === 'none' && auth.body.required === true && auth.body.authorized === false, JSON.stringify(auth.body));
    const bots = await relayFetch(target, '/api/bots');
    check('relay link: without a token nothing is served', bots.status === 401);
    const spoof = await relayFetch(target, '/api/auth', { headers: { 'x-forwarded-for': '127.0.0.1', host: '127.0.0.1' } }).then((r) => r.json());
    check('relay link: a spoofed Host or X-Forwarded-For does not make it local', spoof.mode === 'none');
    const eight = await relayFetch(target, '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '12345678' }) });
    check('relay link: the 8-digit code is refused through the relay', eight.status === 403);

    const made = await makePairLink();
    check('relay link: the pairing link and QR carry the relay address and fingerprint', made.relay?.id === desc.id && made.relay?.fp === desc.fp && /[?&]relay=/.test(made.qr || '') && /[?&]rfp=[0-9a-f]{64}/.test(made.qr || ''), JSON.stringify(made));
    const paired = await relayFetch(target, '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: made.token, client: 'app' }) });
    const pj = await paired.json().catch(() => ({}));
    check('relay link: the one-time QR token pairs through the relay', paired.status === 200 && String(pj.token || '').length >= 16);
    check('relay link: that cookie has no Secure flag (the app page is http://127.0.0.1)', !/;\s*secure/i.test(paired.headers.get('set-cookie') || '') && /HttpOnly/i.test(paired.headers.get('set-cookie') || ''));
    const authed = await relayFetch(target, '/api/bots', { headers: { authorization: `Bearer ${pj.token}` } });
    check('relay link: with the device token the hub answers through the relay', authed.status === 200);
    const ctrl = new AbortController();
    const stream = await relayFetch(target, '/api/stream', { headers: { authorization: `Bearer ${pj.token}`, accept: 'text/event-stream' }, signal: ctrl.signal });
    check('relay link: the event stream (SSE) works through the relay', stream.status === 200 && /text\/event-stream/.test(stream.headers.get('content-type') || ''));
    ctrl.abort();
    const local = await relayFetch(target, '/api/remote/push-update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pj.token}` }, body: '{}' });
    check('relay link: local-only routes refuse a relay caller', local.status === 403);
    const machines = await api('/api/machines');
    check('relay link: the machine list carries this computer\'s relay address', machines.body?.machines?.find((m) => m.self)?.relay?.id === desc.id);

    const offAgain = await api('/api/relay-link', { method: 'PUT', body: { enabled: false } });
    check('relay link: turning it off drops the tunnel', offAgain.body.enabled === false && (await until(() => relay.tunnels.size === 0, 3000)));
  } finally {
    relay.close();
  }
}

// ---------------------------------------------------------------------------
// standalone
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok) });
    console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `  <- ${detail}` : ''}`);
  };
  relayChecks({ check })
    .catch((err) => check('relay checks ran without throwing', false, err.stack))
    .finally(() => {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\nRESULT  ${results.length - failed}/${results.length} relay checks passed`);
      process.exit(failed ? 1 : 0);
    });
}

void http;
