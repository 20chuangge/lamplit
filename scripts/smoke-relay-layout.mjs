#!/usr/bin/env node
/**
 * smoke-relay-layout.mjs - the relay updating itself in the real server layout (1.5.50).
 *
 * 11-21, the first real self-update (1.5.47 -> 1.5.49 on the user's server)
 * rolled back: "新版本 1.5.49 没能正常启动". The service (hub/relay-linux.sh)
 * runs /opt/lamplit-relay/relay.mjs --data /var/lib/lamplit-relay with
 * DynamicUser=yes, and there /var/lib/lamplit-relay is a link to
 * /var/lib/private/lamplit-relay. The staged version runs from under that link;
 * Node resolves the link for the main file, so "am I the file node was asked
 * to run?" said no, main() never ran and the child exited at once.
 *
 * Here: the supervisor from an "/opt"-like folder (read-only), the state folder
 * through a link (a junction on Windows), another working directory, the staged
 * file with CRLF and with LF. The real relay.mjs with a throwaway key in place of
 * the release key - the only change - so the real supervisor and child run.
 *
 *   relayLayoutChecks({check})
 *
 * Run alone: node scripts/smoke-relay-layout.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRelayUpdater, relayFailureDetail } from '../hub/relay/relay.mjs';
import { makeRelayManifest } from '../src/relayupdate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'hub', 'relay', 'relay.mjs'), 'utf8').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(25);
  }
}

// The "am I main?" line before the fix (1.5.47-1.5.49): what the server ran.
const OLD_GUARD = 'if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {';

/** relay.mjs as a test build: our key instead of the release key, a given version, LF or CRLF, optionally the old guard. */
function build(pub, version, { crlf = false, oldGuard = false, extra = '' } = {}) {
  let s = SOURCE.replace(/export const RELAY_UPDATE_KEYS = \[[^\]]*\];/, `export const RELAY_UPDATE_KEYS = ['${pub}'];`)
    .replace(/export const RELAY_VERSION = '[^']+';/, `export const RELAY_VERSION = '${version}';`);
  if (oldGuard) s = s.replace(/\nif \(isMainModule\(\)\) \{/, `\n${OLD_GUARD}`);
  const after = "  const startedFine = running ? noteStartFailure(dataDir, running.version) : () => {};\n";
  if (extra) {
    if (!s.includes(after)) throw new Error('relay.mjs: the start-failure note line moved');
    s = s.replace(after, `${after}${extra}\n`);
  }
  return Buffer.from(crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
}

/** The server's folders: /opt (supervisor), /var/lib/private/<x> and a link to it, a cwd elsewhere. */
function layout(tmp, name) {
  const opt = path.join(tmp, name, 'opt', 'lamplit-relay');
  const priv = path.join(tmp, name, 'var', 'lib', 'private', 'lamplit-relay');
  const link = path.join(tmp, name, 'var', 'lib', 'lamplit-relay');
  const cwd = path.join(tmp, name, 'cwd');
  for (const d of [opt, priv, cwd]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(priv, link, 'junction');
  return { opt, priv, link, cwd };
}

/** Stage `bytes` as `version` the way a running relay does (signature checked), into the state folder through the link. */
async function stage(dirs, privateKey, pub, version, bytes, runningVersion = '1.5.47') {
  const u = createRelayUpdater({ running: { version: runningVersion, sha256: '0'.repeat(64) }, stateDir: dirs.link, keys: [pub], minIntervalMs: 0 });
  return u.install(makeRelayManifest({ version, bytes, privateKey }), bytes);
}

/** Start the service as systemd does: node /opt/.../relay.mjs --port --data <link>, from another cwd. */
function startService(dirs) {
  const proc = spawn(process.execPath, [path.join(dirs.opt, 'relay.mjs'), '--port', '0', '--host', '127.0.0.1', '--data', dirs.link], { cwd: dirs.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const run = { proc, out: '', err: '' };
  proc.stdout.on('data', (d) => { run.out += d; });
  proc.stderr.on('data', (d) => { run.err += d; });
  return run;
}

async function stopService(run) {
  if (run.proc.exitCode !== null) return;
  const gone = new Promise((r) => run.proc.once('exit', r));
  run.proc.kill();
  await Promise.race([gone, sleep(5000)]);
}

const book = (dirs) => { try { return JSON.parse(fs.readFileSync(path.join(dirs.priv, 'updates.json'), 'utf8')); } catch { return null; } };
const readyLine = (run) => { try { return JSON.parse(run.out.split('\n').find((l) => l.includes('"ready"')) || 'null'); } catch { return null; } };
const startedAs = (run, v) => run.err.includes(`starting relay ${v} (updated`);

export async function relayLayoutChecks({ check }) {
  const keep = setInterval(() => {}, 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-relay-layout-'));
  const runs = [];
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const NEXT = '1.5.50';

    // --- what the server ran: 1.5.47 in /opt, 1.5.49 staged (the old guard) ----------
    const a = layout(tmp, 'as-found');
    fs.writeFileSync(path.join(a.opt, 'relay.mjs'), build(pub, '1.5.47', { oldGuard: true, crlf: true }));
    fs.chmodSync(path.join(a.opt, 'relay.mjs'), 0o444);
    await stage(a, privateKey, pub, '1.5.49', build(pub, '1.5.49', { oldGuard: true, crlf: true }));
    check('layout: the staged file sits in the state folder, reached through the link (as with DynamicUser)', fs.existsSync(path.join(a.priv, 'updates', '1.5.49', 'relay.mjs')) && fs.realpathSync(path.join(a.link, 'updates')) !== path.join(a.link, 'updates'));
    const r1 = startService(a);
    runs.push(r1);
    await until(() => (book(a)?.bad || []).includes('1.5.49') && readyLine(r1), 20000);
    const b1 = book(a);
    check('as found on the server: the 1.5.49 child started from under the link never came up, and was rolled back to 1.5.47 (the bug, reproduced)',
      startedAs(r1, '1.5.49') && (b1?.bad || []).includes('1.5.49') && b1?.last?.ok === false && /1\.5\.47/.test(b1.last.reason) && readyLine(r1)?.port > 0, JSON.stringify({ b1, err: r1.err.slice(-800) }));
    await stopService(r1);

    // --- the fix, in the same folders: 1.5.50 is a new version, not the bad one -----------
    await stage(a, privateKey, pub, NEXT, build(pub, NEXT, { crlf: true }));
    const b2 = book(a);
    check('the bad list holds exactly 1.5.49: 1.5.50 is staged as current (CRLF file)', b2?.current?.version === NEXT && JSON.stringify(b2.bad) === '["1.5.49"]', JSON.stringify(b2));
    const r2 = startService(a);
    runs.push(r2);
    const up2 = await until(() => readyLine(r2), 20000);
    await sleep(800);
    check(`fixed: under the old 1.5.47 supervisor from /opt, ${NEXT} staged under the link comes up and stays (CRLF)`,
      up2?.port > 0 && startedAs(r2, NEXT) && !(book(a)?.bad || []).includes(NEXT) && r2.proc.exitCode === null, JSON.stringify({ b: book(a), err: r2.err.slice(-800) }));
    if (up2?.port) {
      const { checkRelay } = await import('../src/relaylink.mjs');
      const health = await checkRelay({ host: '127.0.0.1', port: up2.port, relayFingerprint: up2.fingerprint });
      check(`fixed: its health says ${NEXT} runs and updates itself`, health.ok && health.version === NEXT && health.auto === true, JSON.stringify(health));
    }
    await stopService(r2);

    // --- LF file, a fresh state folder, today's supervisor in /opt --------------------
    const c = layout(tmp, 'lf');
    fs.writeFileSync(path.join(c.opt, 'relay.mjs'), build(pub, '1.5.47'));
    fs.chmodSync(path.join(c.opt, 'relay.mjs'), 0o444);
    await stage(c, privateKey, pub, NEXT, build(pub, NEXT));
    const r3 = startService(c);
    runs.push(r3);
    const up3 = await until(() => readyLine(r3), 20000);
    await sleep(800);
    check(`fixed: ${NEXT} staged under the link comes up (LF file, today's supervisor)`, up3?.port > 0 && startedAs(r3, NEXT) && !(book(c)?.bad || []).includes(NEXT), JSON.stringify({ b: book(c), err: r3.err.slice(-800) }));
    await stopService(r3);

    // --- why a version failed: said on the computer, addresses taken out ----------------
    const d = layout(tmp, 'why');
    fs.writeFileSync(path.join(d.opt, 'relay.mjs'), build(pub, '1.5.47'));
    const boom = "  if (process.argv.includes('--serve') && process.env.LAMPLIT_RELAY_RUNNING?.includes('1.5.51')) { console.error('[relay] cannot reach 203.0.113.77:443 or [2001:db8::7]:443'); throw new Error('boom from 198.51.100.4'); }";
    await stage(d, privateKey, pub, '1.5.51', build(pub, '1.5.51', { extra: boom }));
    const r4 = startService(d);
    runs.push(r4);
    await until(() => (book(d)?.bad || []).includes('1.5.51') && readyLine(r4), 20000);
    const b4 = book(d);
    const detail = String(b4?.last?.detail || '');
    check('why: a version that fails to start is rolled back, and the book keeps the end of what it printed', (b4?.bad || []).includes('1.5.51') && /boom/.test(detail) && /cannot reach/.test(detail), JSON.stringify(b4));
    check('why: no addresses in what is kept (IPv4, IPv6, with ports)', detail.length > 0 && !/203\.0\.113|198\.51\.100|2001:db8/.test(detail) && /<ip>/.test(detail), detail);
    check('why: at most about 20 lines, and short', detail.split('\n').length <= 20 && detail.length <= 2000, String(detail.split('\n').length));
    // The computer hears it: the relay that runs again (1.5.47 in /opt) reports the book's last result over the tunnel.
    const up4 = readyLine(r4);
    if (up4?.port) {
      const { createRelayLink } = await import('../src/relaylink.mjs');
      const join = fs.readFileSync(path.join(d.priv, 'join-secret'), 'utf8').trim();
      const link = createRelayLink({ dataDir: path.join(tmp, 'why-hub'), handler: (_q, s) => s.end('hub'), log: () => {}, relayUpdate: () => null });
      try {
        link.configure({ enabled: true, host: '127.0.0.1', port: up4.port, relayFingerprint: up4.fingerprint, join, direct: false });
        const heard = await until(() => link.view().relay?.last?.detail, 8000);
        const last = link.view().relay?.last || {};
        check('why: the computer gets the reason and the detail through the tunnel (no addresses)', Boolean(heard) && last.ok === false && /1\.5\.51/.test(last.reason) && /boom/.test(last.detail) && !/203\.0\.113|198\.51\.100|2001:db8/.test(last.detail), JSON.stringify(link.view().relay));
      } finally {
        link.stop();
        link.closeDirect?.();
      }
    } else check('why: the computer gets the reason and the detail through the tunnel (no addresses)', false, 'the rolled-back relay did not come up');
    await stopService(r4);

    // The bad list blocks that exact version only: a nudge for 1.5.49 is ignored, one for 1.5.50 is fetched.
    const fetched = [];
    fs.mkdirSync(path.join(tmp, 'bad-only'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bad-only', 'updates.json'), JSON.stringify({ current: null, previous: null, bad: ['1.5.49'], last: { ok: false, version: '1.5.49', reason: 'x' } }));
    const from = { id: 'pc', fetch: async (p) => { fetched.push(p); throw new Error('test'); }, tell: () => {} };
    const u2 = createRelayUpdater({ running: { version: '1.5.47', sha256: '0'.repeat(64) }, stateDir: path.join(tmp, 'bad-only'), keys: [pub], minIntervalMs: 0 });
    u2.offer(from, { version: '1.5.49', sha256: 'a'.repeat(64) });
    await sleep(50);
    const ignoredBad = fetched.length === 0;
    u2.offer(from, { version: NEXT, sha256: 'b'.repeat(64) });
    await until(() => fetched.length > 0, 2000);
    check(`bad list: a nudge for the failed 1.5.49 is ignored; one for ${NEXT} is fetched`, ignoredBad && fetched[0] === '/api/relay-update', JSON.stringify(fetched));

    // The card: a failed version is said, with 「看原因」 folded under it - unless a newer one is on its way.
    const page = fs.readFileSync(path.join(ROOT, 'public', 'app', 'main', '08-settings.js'), 'utf8');
    const words = new Function(`${page.match(/function relayUpdateWords\(view\) \{[\s\S]*?\n\}/)[0].replace(/\r\n/g, '\n')}; return relayUpdateWords;`)();
    const failed = { ok: false, version: '1.5.49', reason: '新版本 1.5.49 没能正常启动，已退回 1.5.47', detail: 'x' };
    check('card: the failed version is said while nothing newer is offered',
      /没有更新/.test(words({ relay: { version: '1.5.47', auto: true, last: failed }, relayUpdate: { version: '1.5.49' } })));
    check(`card: once ${NEXT} is offered, it says the update is coming instead of the old failure`,
      /会自己更新到 1\.5\.50/.test(words({ relay: { version: '1.5.47', auto: true, last: failed }, relayUpdate: { version: NEXT } })) && /正在更新到 1\.5\.50/.test(words({ relay: { version: '1.5.47', auto: true, fetching: true, last: failed }, relayUpdate: { version: NEXT } })));
    const machines = fs.readFileSync(path.join(ROOT, 'public', 'app', 'main', '11-machines.js'), 'utf8');
    check('card: 「看原因」 shows the detail folded, only for a failed update', page.includes("box.appendChild(el('summary', '', '看原因（中转最后打印的几行）'));") && page.includes("box.appendChild(el('pre', '', last.detail));") && machines.includes('const whyNode = relayFailureNode(view);'));

    // The same, when the supervisor in /opt is the old one (no detail of its own): the
    // failed child leaves its own note, and the next relay that runs reports it.
    const e = layout(tmp, 'why-old-supervisor');
    fs.writeFileSync(path.join(e.opt, 'relay.mjs'), build(pub, '1.5.47', { oldGuard: true }).toString('utf8').replace(/detail: relayFailureDetail\([^)]*\), /, ''));
    await stage(e, privateKey, pub, '1.5.51', build(pub, '1.5.51', { extra: boom }));
    const r5 = startService(e);
    runs.push(r5);
    await until(() => (book(e)?.bad || []).includes('1.5.51') && readyLine(r5), 20000);
    await stopService(r5);
    const after = createRelayUpdater({ running: { version: NEXT, sha256: '0'.repeat(64) }, stateDir: e.link, keys: [pub], minIntervalMs: 0 });
    const said = String(after.status().last?.detail || '');
    check('why (old supervisor): the failed child\'s own note is picked up by the next relay and shown, without addresses', /boom/.test(said) && !/198\.51\.100|203\.0\.113/.test(said), JSON.stringify(after.status().last));
    check('why: the address scrubber keeps times and versions', relayFailureDetail('2026-11-21T03:39:04.123Z relay 1.5.49 at 10.0.0.5:7443 and ::ffff:192.0.2.1') === '2026-11-21T03:39:04.123Z relay 1.5.49 at <ip>:7443 and <ip>');
  } finally {
    for (const r of runs) await stopService(r).catch(() => {});
    clearInterval(keep);
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };
  relayLayoutChecks({ check }).then(() => {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}
