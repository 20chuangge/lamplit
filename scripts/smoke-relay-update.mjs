#!/usr/bin/env node
/**
 * smoke-relay-update.mjs - the relay updates itself, safely (1.5.47).
 *
 * A relay runs only code signed with Lamplit's release key: a registered
 * computer says "I have relay x" (a nudge, no code); the relay fetches the
 * signed file through that computer's own tunnel, checks signature, hash,
 * version and size, stages it in its data folder and restarts; a supervisor
 * re-checks the signature before every start and rolls back a version that
 * does not come up. All on 127.0.0.1 with a throwaway key.
 *
 *   relayUpdateChecks({check})   signing, refusals, fetch over the tunnel,
 *                                staging, choosing what to run, rollback
 *
 * Run alone: node scripts/smoke-relay-update.mjs
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELAY_UPDATE_KEYS, RELAY_VERSION, chooseCode, createRelay, createRelayUpdater, makeSelfSignedCert, runSupervisor, verifyRelayUpdate,
} from '../hub/relay/relay.mjs';
import { createRelayLink } from '../src/relaylink.mjs';
import { makeRelayManifest, readRelayUpdate } from '../src/relayupdate.mjs';
import { UPDATE_PUBLIC_KEYS } from '../src/selfupdate.mjs';

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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function testKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** A fake child process for the supervisor: prints ready (or not), exits when told. */
function fakeChild({ ready = true, exitAfterMs = 0, code = 0 } = {}) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; setTimeout(() => c.emit('exit', null, 'SIGTERM'), 5); };
  if (ready) setTimeout(() => c.stdout.emit('data', Buffer.from(`${JSON.stringify({ event: 'ready', port: 1 })}\n`)), 20);
  if (exitAfterMs) setTimeout(() => c.emit('exit', code, null), exitAfterMs);
  return c;
}

export async function relayUpdateChecks({ check }) {
  const keep = setInterval(() => {}, 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-relay-update-'));
  try {
    await inner({ check, tmp });
  } finally {
    clearInterval(keep);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function inner({ check, tmp }) {
  const k = testKeys();
  const other = testKeys();
  const keys = [k.pub];

  // --- what is signed, and what is refused -------------------------------------
  check('relay update: the relay trusts exactly the release key Lamplit itself trusts (one key, two copies kept equal)', JSON.stringify(RELAY_UPDATE_KEYS) === JSON.stringify(UPDATE_PUBLIC_KEYS));
  const code = Buffer.from('// relay 1.5.48\nconsole.log("new relay");\n');
  const m = makeRelayManifest({ version: '1.5.48', bytes: code, privateKey: k.privateKey });
  check('relay update: a signed manifest says version, file hash and signature, nothing else', m.v === 1 && m.version === '1.5.48' && m.sha256 === sha(code) && Buffer.from(m.signature, 'base64').length === 64 && Object.keys(m).sort().join() === 'sha256,signature,v,version');
  check('relay update: the right file with the right signature is accepted', verifyRelayUpdate(m, code, keys) === true);
  check('relay update: one changed byte in the file is refused', verifyRelayUpdate(m, Buffer.concat([code, Buffer.from(' ')]), keys) === false);
  check('relay update: signed by another key is refused', verifyRelayUpdate(makeRelayManifest({ version: '1.5.48', bytes: code, privateKey: other.privateKey }), code, keys) === false);
  check('relay update: a different version number than the one signed is refused', verifyRelayUpdate({ ...m, version: '1.5.99' }, code, keys) === false);
  const rawSig = crypto.sign(null, code, k.privateKey).toString('base64');
  check('relay update: an app-package style signature (over the bytes alone) is not a relay signature', verifyRelayUpdate({ ...m, signature: rawSig }, code, keys) === false);
  check('relay update: not a plain x.y.z version is refused', verifyRelayUpdate(makeRelayManifest({ version: '1.5.48-evil', bytes: code, privateKey: k.privateKey }), code, keys) === false);
  const huge = Buffer.alloc(3 * 1024 * 1024, 32);
  check('relay update: more than 2 MB is refused', verifyRelayUpdate(makeRelayManifest({ version: '1.5.48', bytes: huge, privateKey: k.privateKey }), huge, keys) === false);
  check('relay update: the release key in this repo does not accept a throwaway key\'s signature', verifyRelayUpdate(m, code) === false);

  // --- the computer's side: what it offers ---------------------------------------
  const root = path.join(tmp, 'app');
  fs.mkdirSync(path.join(root, 'hub', 'relay'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub', 'relay', 'relay.mjs'), code);
  check('relay update: a computer without a signed relay file offers nothing (a checkout, a dev build)', readRelayUpdate(root) === null);
  fs.writeFileSync(path.join(root, 'hub', 'relay', 'relay-update.json'), JSON.stringify(m));
  const offered = readRelayUpdate(root);
  check('relay update: with the manifest next to relay.mjs, the computer offers that version', offered?.manifest.version === '1.5.48' && offered.bytes.equals(code));
  fs.writeFileSync(path.join(root, 'hub', 'relay', 'relay.mjs'), Buffer.concat([code, Buffer.from('//x')]));
  check('relay update: a manifest that does not match the file next to it is not offered', readRelayUpdate(root) === null);

  // --- end to end: nudge, fetch through the tunnel, check, stage -----------------
  const running = Buffer.from('// relay 1.5.47 (running)\n');
  const stateDir = path.join(tmp, 'relay-state');
  let staged = null;
  const updater = createRelayUpdater({ running: { version: '1.5.47', sha256: sha(running) }, stateDir, keys, onStaged: (v) => { staged = v; }, minIntervalMs: 0 });
  const relayId = makeSelfSignedCert({ commonName: 'lamplit-relay' });
  const join = crypto.randomBytes(18).toString('base64url');
  const relay = createRelay({ identity: relayId, joinSecret: join, updater });
  const port = await new Promise((r) => relay.server.listen(0, '127.0.0.1', () => r(relay.server.address().port)));
  let source = { manifest: m, bytes: code };
  const link = createRelayLink({ dataDir: path.join(tmp, 'hub'), handler: (_req, res) => res.end('hub'), log: () => {}, relayUpdate: () => source });
  try {
    link.configure({ enabled: true, host: '127.0.0.1', port, relayFingerprint: relayId.fingerprint, join });
    const up = await until(() => link.view().state === 'online', 5000);
    check('relay update: the computer\'s tunnel comes up', up);
    const got = await until(() => staged, 5000);
    check('relay update: nudged by the computer, the relay fetches the signed file through that tunnel and stages it', got === '1.5.48' && fs.readFileSync(path.join(stateDir, 'updates', '1.5.48', 'relay.mjs')).equals(code), JSON.stringify(updater.status()));
    const book = JSON.parse(fs.readFileSync(path.join(stateDir, 'updates.json'), 'utf8'));
    check('relay update: it remembers the new version as current and what ran before as previous', book.current?.version === '1.5.48' && book.current.sha256 === sha(code) && book.previous === null, JSON.stringify(book));
    check('relay update: the computer hears the relay\'s version and that it updates itself', await until(() => link.view().relay?.version === '1.5.47' && link.view().relay?.auto === true, 3000), JSON.stringify(link.view().relay));
    check('relay update: the relay says what it can offer to show (version, last result) and the computer sees what it offered', link.view().relayUpdate?.version === '1.5.48');

    // Refusals: each one leaves the staged state alone and says why.
    const fresh = () => createRelayUpdater({ running: { version: '1.5.47', sha256: sha(running) }, stateDir: path.join(tmp, `s-${crypto.randomBytes(3).toString('hex')}`), keys, onStaged: (v) => { staged = v; }, minIntervalMs: 0 });
    const tryWith = async (u, src) => {
      staged = null;
      source = src;
      relay.setUpdater(u);
      link.stop();
      link.start();
      await until(() => link.view().state === 'online', 5000);
      await until(() => u.status().last || staged, 3000);
      return u.status();
    };
    const badSig = await tryWith(fresh(), { manifest: makeRelayManifest({ version: '1.5.48', bytes: code, privateKey: other.privateKey }), bytes: code });
    check('relay update: a file signed by another key is refused, nothing staged, and the reason is kept for the computer', staged === null && badSig.last?.ok === false && /签名/.test(badSig.last.reason), JSON.stringify(badSig));
    const swapped = await tryWith(fresh(), { manifest: m, bytes: Buffer.from('// not what was signed') });
    check('relay update: a computer handing over other bytes than the signed ones is refused', staged === null && swapped.last?.ok === false, JSON.stringify(swapped));
    const older = await tryWith(fresh(), { manifest: makeRelayManifest({ version: '1.5.40', bytes: code, privateKey: k.privateKey }), bytes: code });
    check('relay update: an older signed version is never taken (no going back to an old relay)', staged === null && !older.last?.ok, JSON.stringify(older));
    const same = await tryWith(fresh(), { manifest: makeRelayManifest({ version: '1.5.49', bytes: running, privateKey: k.privateKey }), bytes: running });
    check('relay update: the same code under a newer number is not downloaded again', staged === null && !same.fetching, JSON.stringify(same));
    const slow = createRelayUpdater({ running: { version: '1.5.47', sha256: sha(running) }, stateDir: path.join(tmp, 'slow'), keys, onStaged: () => {}, minIntervalMs: 60000 });
    let fetches = 0;
    slow.offer({ id: 'x', fetch: async () => { fetches += 1; throw new Error('offline'); } }, { type: 'relay-version', version: '1.5.48', sha256: sha(code) });
    slow.offer({ id: 'x', fetch: async () => { fetches += 1; throw new Error('offline'); } }, { type: 'relay-version', version: '1.5.48', sha256: sha(code) });
    await sleep(50);
    check('relay update: a computer that keeps nudging gets at most one fetch per interval', fetches === 1);
  } finally {
    link.stop();
    link.closeDirect?.();
    relay.close();
  }

  // --- what to run, at every start ---------------------------------------------
  const builtin = { file: path.join(tmp, 'opt-relay.mjs'), version: '1.5.47', sha256: sha(running) };
  fs.writeFileSync(builtin.file, running);
  const pick = chooseCode({ stateDir, builtin, keys });
  check('supervisor: a staged, signed, newer version is what starts', pick.version === '1.5.48' && pick.updated === true && pick.file.endsWith(path.join('1.5.48', 'relay.mjs')));
  fs.appendFileSync(path.join(stateDir, 'updates', '1.5.48', 'relay.mjs'), '// changed on disk');
  check('supervisor: a staged file changed on disk afterwards is not run (the signature is checked before every start)', chooseCode({ stateDir, builtin, keys }).updated === false);
  fs.writeFileSync(path.join(stateDir, 'updates', '1.5.48', 'relay.mjs'), code);
  check('supervisor: the release key, not a throwaway one, is what a real relay checks against', chooseCode({ stateDir, builtin }).updated === false);
  check('supervisor: a builtin newer than the staged one (a later 「重装」) wins', chooseCode({ stateDir, builtin: { ...builtin, version: '1.5.50' }, keys }).updated === false);

  // Rollback: the new one never says ready.
  const starts = [];
  const sup = runSupervisor({
    stateDir, builtin, keys, readyMs: 300, settleMs: 600, restartDelayMs: 20, log: () => {},
    spawnChild: (p) => { starts.push(p.version); return p.version === '1.5.48' ? fakeChild({ ready: false }) : fakeChild({ ready: true }); },
  });
  await until(() => starts.length >= 2, 4000);
  const book2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'updates.json'), 'utf8'));
  check('supervisor: a new version that does not come up is rolled back to the one before', starts[0] === '1.5.48' && starts[1] === '1.5.47', JSON.stringify(starts));
  check('supervisor: it is remembered as bad (never started again) and the reason is plain', (book2.bad || []).includes('1.5.48') && book2.last?.ok === false && /没能正常启动/.test(book2.last.reason) && /1\.5\.47/.test(book2.last.reason), JSON.stringify(book2));
  await sleep(200);
  check('supervisor: the rolled-back relay keeps running (no restart loop)', starts.length === 2, JSON.stringify(starts));
  sup.stop();

  // A good update: stage, child exits 75, the new one starts and stays.
  const state2 = path.join(tmp, 'relay-state-2');
  const u2 = createRelayUpdater({ running: { version: '1.5.47', sha256: sha(running) }, stateDir: state2, keys, onStaged: () => {}, minIntervalMs: 0 });
  await u2.install(m, code);
  const starts2 = [];
  let first = true;
  const sup2 = runSupervisor({
    stateDir: state2, builtin, keys, readyMs: 300, settleMs: 300, restartDelayMs: 20, log: () => {},
    spawnChild: (p) => { starts2.push(p.version); const c = fakeChild({ ready: true, exitAfterMs: first ? 100 : 0, code: 75 }); first = false; return c; },
  });
  await until(() => starts2.length >= 2, 3000);
  await sleep(500);
  const book3 = JSON.parse(fs.readFileSync(path.join(state2, 'updates.json'), 'utf8'));
  check('supervisor: after a staged update the relay restarts into it, and it stays', starts2.join() === '1.5.48,1.5.48' && book3.last?.ok === true && book3.last.version === '1.5.48', JSON.stringify({ starts2, book3 }));
  sup2.stop();

  // --- the real thing: the service is a supervisor with the relay as its child --
  const { spawn } = await import('node:child_process');
  const dataDir = path.join(tmp, 'real');
  const proc = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'relay', 'relay.mjs'), '--port', '0', '--host', '127.0.0.1', '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', () => {});
  const ready = await until(() => { try { return JSON.parse(out.split('\n').find((l) => l.includes('"ready"')) || 'null'); } catch { return null; } }, 15000);
  check('service: started as a service, the relay comes up under its supervisor and says ready', ready?.port > 0, out);
  if (ready?.port) {
    const { checkRelay } = await import('../src/relaylink.mjs');
    const health = await checkRelay({ host: '127.0.0.1', port: ready.port, relayFingerprint: ready.fingerprint });
    check('service: its health says which version runs and that it updates itself', health.ok && health.version === RELAY_VERSION && health.auto === true, JSON.stringify(health));
    proc.kill();
    const net = await import('node:net');
    const gone = await until(() => new Promise((resolve) => {
      const s = net.connect(ready.port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(true));
    }), 8000);
    check('service: stopping the service (even killed hard) takes the relay child with it', gone);
  } else proc.kill();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };
  relayUpdateChecks({ check }).then(() => {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}
