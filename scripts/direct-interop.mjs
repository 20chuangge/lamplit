#!/usr/bin/env node
/**
 * direct-interop.mjs - the phone's direct channel (Java, DirectChannel.java)
 * against the computer's (Node, src/direct.mjs), on this desktop.
 *
 * Compiles DirectChannel.java with scripts/java/DirectInterop.java, starts a
 * relay's STUN and a computer's direct side on 127.0.0.1 (a TLS end with its
 * own certificate and a tiny HTTP server behind it, like relaylink.mjs), and
 * runs the Java side: STUN, offer, punch, pinned TLS over a stream, 2 MB down,
 * 1 MB up, four at once, a wrong fingerprint refused - with and without loss.
 *
 * Needs a JDK (11+): LAMPLIT_JDK=<jdk folder>, JAVA_HOME, or javac on PATH.
 * Without one it says so and exits 0 (the Android build compiles the same file).
 *
 *   node scripts/direct-interop.mjs
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { createRelay, makeSelfSignedCert, shieldStream } from '../hub/relay/relay.mjs';
import { listenRelay } from './test-ports.mjs';
import { createDirectServer } from '../src/direct.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'desk', 'assistant', 'DirectChannel.java');
const HARNESS = path.join(REPO, 'scripts', 'java', 'DirectInterop.java');

function jdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of [process.env.LAMPLIT_JDK, process.env.JAVA_HOME].filter(Boolean)) {
    const p = path.join(dir, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : '';
}

let failed = 0;
let passed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

/** The 2 MB the computer sends for GET /big: the same bytes every time. */
const BIG = (() => {
  const parts = [];
  let seed = Buffer.from('lamplit-direct');
  for (let n = 0; n < 2 * 1024 * 1024; n += 32) { seed = crypto.createHash('sha256').update(seed).digest(); parts.push(seed); }
  return Buffer.concat(parts);
})();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function run(dropRate, classes) {
  const java = jdkTool('java');
  const id = 'abcdefghijklmnopqrstuvwxyz';
  const cert = makeSelfSignedCert({ commonName: 'lamplit' });
  const secureContext = tls.createSecureContext({ key: cert.key, cert: cert.cert });
  const app = http.createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-length': BIG.length }); res.end(BIG); return; }
    if (req.url === '/hash') {
      const h = crypto.createHash('sha256');
      req.on('data', (d) => h.update(d));
      req.on('end', () => { const hex = h.digest('hex'); res.writeHead(200, { 'content-length': hex.length }); res.end(hex); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const relay = createRelay({ identity: makeSelfSignedCert({ commonName: 'lamplit-relay' }), joinSecret: crypto.randomBytes(18).toString('base64url') });
  // TCP and UDP on one number, skipping one Windows keeps for UDP (test-ports.mjs, 1.5.63).
  const relayPort = await listenRelay(relay, { stun: true });
  const server = createDirectServer({
    acceptStream: (stream) => {
      const sock = new tls.TLSSocket(shieldStream(stream), { isServer: true, secureContext });
      sock.on('error', () => sock.destroy());
      sock.once('secure', () => app.emit('connection', sock));
    },
    relay: () => ({ host: '127.0.0.1', port: relayPort }),
    endpointOptions: { interfaces: () => [], ipv6: false, bindHost: '127.0.0.1' },
    allowLoopback: true,
    sessionOptions: { dropRate },
  });
  const offers = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const reply = await server.offer(JSON.parse(body), { who: 'java' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      } catch (err) {
        res.writeHead(err.code === 'DIRECT_OFF' ? 409 : 400);
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
      }
    });
  });
  const offerPort = await new Promise((r) => offers.listen(0, '127.0.0.1', () => r(offers.address().port)));
  try {
    const out = await new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const p = spawn(java, ['-Dstdout.encoding=UTF-8', '-Dfile.encoding=UTF-8', '-cp', classes, 'com.desk.assistant.DirectInterop', String(relayPort), `http://127.0.0.1:${offerPort}/`, cert.fingerprint, id, String(dropRate)], { windowsHide: true });
        let text = '';
        let err = '';
        p.stdout.on('data', (d) => { text += d; });
        p.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => p.kill(), 120000);
        p.on('close', () => { clearTimeout(timer); resolve({ text, err }); });
      });
    });
    let r = {};
    try { r = JSON.parse(out.text.trim().split(/\r?\n/).pop()); } catch { r = {}; }
    const tag = dropRate ? ` (${Math.round(dropRate * 100)}% loss both ways)` : '';
    // 1.5.48: a path to a private / loopback address is the home network: 「局域网」, not just 「直连」.
    check(`interop${tag}: the Java side asks STUN, offers, punches and is direct (over loopback: said as the local network)`, r.route === 'direct-lan', `${out.text}\n${out.err.slice(0, 2000)}`);
    if (!dropRate) {
      check('interop: the login is found through the app\'s machine rows (its main address, then its other addresses)', r.owners === 'http://192.168.1.5:14390 http://100.70.1.2:14390 http://127.0.0.1:14441' && r.owners2 === 'http://127.0.0.1:14442' && r.owners3 === 'http://127.0.0.1:14449', JSON.stringify([r.owners, r.owners2, r.owners3]));
      check('interop: a debug line without logcat says the route and state, and never an address', /中转/.test(r.debugBefore) && /直连/.test(r.debugUp) && /局域网/.test(r.debugUp) && !/\d+\.\d+\.\d+\.\d+|::/.test(`${r.debugBefore}${r.debugUp}`), JSON.stringify([r.debugBefore, r.debugUp]));
    }
    if (!/^direct/.test(r.route || '')) return;
    check(`interop${tag}: pinned TLS over a stream, 2 MB down intact`, r.bigHash === sha(BIG), r.bigHash);
    check(`interop${tag}: 1 MB up intact`, r.upHash && r.upHash === r.sentHash, `${r.upHash} vs ${r.sentHash}`);
    check(`interop${tag}: a wrong fingerprint is refused on the direct path too`, r.wrongFp === 'refused');
    check(`interop${tag}: four streams at once, each intact`, Array.isArray(r.parallel) && r.parallel.length === 4 && r.parallel.every((h) => h === sha(BIG)), JSON.stringify(r.parallel));
    check(`interop${tag}: a network change drops the direct link (back to the relay)`, r.afterReset === 'relay');
    check(`interop${tag}: the computer saw it as direct, from loopback`, server.view().up >= 1 && server.view().streams >= 7, JSON.stringify(server.view()));
  } finally {
    server.close();
    relay.close();
    offers.close();
  }
}

async function main() {
  const javac = jdkTool('javac');
  if (!javac || !jdkTool('java')) {
    console.log('direct-interop: no JDK found (set LAMPLIT_JDK or JAVA_HOME); skipped.');
    return;
  }
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-direct-interop-'));
  try {
    const built = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, SRC, HARNESS], { encoding: 'utf8' });
    check('interop: DirectChannel.java compiles with a desktop JDK (no Android classes in it)', built.status === 0, built.stderr);
    if (built.status !== 0) return;
    const keep = setInterval(() => {}, 1000);
    try {
      await run(0, classes);
      await run(0.05, classes);
    } finally {
      clearInterval(keep);
    }
  } finally {
    fs.rmSync(classes, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
}, (err) => { console.error(err); process.exit(1); });
