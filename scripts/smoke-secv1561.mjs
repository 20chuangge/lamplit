/**
 * smoke-secv1561.mjs - the verifier's attacks on 1.5.61 (section 十四 of its report), taken
 * into the smoke (F11 closes U1, F14 U2; X1a waits for the sandbox's own network: next batch).
 *
 *   U1  (both, needs Chromium) the upgrade: a browser 1.5.60 left running (its own debugging
 *       port; noted with pid 0, as its desktop browser was) is stopped, and the new one starts.
 *   U2  (both, needs Chromium) after the hub's own browser_download, a download the hub did
 *       not ask for (a page, a second chrome.exe handing a URL over) does not land in the data
 *       folder (the browser's download folder is left at the hub's staging folder).
 *   X1  (Linux, bwrap + Xvfb) a display that listens on the abstract socket (the default for
 *       Xorg / Xwayland: the human's screen) is reachable from the bots' sandbox through the
 *       shared network namespace, /tmp being private or not; one started with
 *       -nolisten local (the bots' own, 1.5.61) is not.
 *   X2  (Linux, bwrap) one bot's /tmp is not another's, and the hub's data/tmp is hidden.
 *
 *   node scripts/smoke-secv1561.mjs     PASS / FAIL / SKIP lines, exit 1 on a FAIL
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeTcpPorts } from './test-ports.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserSetup(T) {
  const b = await import('../src/browser.mjs');
  const exe = b.detectBrowserExecutable().path;
  if (!exe) return null;
  const { createRegistry } = await import('../src/tools.mjs');
  const ws = path.join(T, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(process.env.ASSIST_DATA_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dl')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="mcp.json"' }); res.end('[{"id":"evil"}]'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>t</title><p>page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const reg = createRegistry({});
  const ctx = { workspaceDir: ws, botId: 'bot1', bot: { id: 'bot1' } };
  const call = async (name, args = {}) => { try { return await reg.get(name).run(args, ctx); } catch (err) { return { ok: false, error: { code: err.code, message: err.message } }; } };
  return { b, exe, ws, server, origin: `http://127.0.0.1:${server.address().port}`, call };
}

// ---------------------------------------------------------------- U1
async function u1(T) {
  const s = await browserSetup(T);
  if (!s) return { skipped: 'no Chromium-based browser here' };
  const data = process.env.ASSIST_DATA_DIR;
  const profile = s.b.profileDir('bot1');
  fs.mkdirSync(profile, { recursive: true });
  // A port the system hands out (not one Windows keeps for itself, 1.5.63: test-ports.mjs).
  const port = await freeTcpPorts(1);
  const old = spawn(s.exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const answers = async () => { try { return Boolean((await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl); } catch { return false; } };
  let up = false;
  for (let i = 0; i < 80 && !up; i += 1) { up = await answers(); if (!up) await sleep(250); }
  fs.writeFileSync(path.join(data, 'browser-state-bot1.json'), JSON.stringify({ port, pid: 0, executable: s.exe, headless: false, onDesktop: true }));
  const out = { oldUp: up };
  try {
    const opened = await s.call('browser_open', { url: `${s.origin}/after-upgrade` });
    out.newOpen = opened.ok === true;
    out.newError = opened.error?.code;
    out.oldPortStillAnswers = await answers();
  } finally {
    await s.call('browser_close');
    s.server.close();
    try { process.kill(old.pid); } catch { /* gone */ }
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(old.pid)], { windowsHide: true });
  }
  return out;
}

// ---------------------------------------------------------------- U2
async function u2(T) {
  const s = await browserSetup(T);
  if (!s) return { skipped: 'no Chromium-based browser here' };
  const data = process.env.ASSIST_DATA_DIR;
  const out = {};
  try {
    out.open = (await s.call('browser_open', { url: `${s.origin}/own` })).ok === true;
    out.hubDownload = (await s.call('browser_download', { url: `${s.origin}/dl?hub` })).ok === true;
    // A download the hub did not ask for: the page itself starts one (as a second chrome.exe's URL would).
    await s.call('browser_eval', { expression: `(() => { const a = document.createElement('a'); a.href = '${s.origin}/dl?unasked'; a.download = 'mcp.json'; document.body.appendChild(a); a.click(); return 1; })()` });
    await sleep(4000);
    const found = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/browser-profile/.test(p)) walk(p); } else if (/^mcp.*\.json$/.test(e.name)) found.push(path.relative(data, p)); } };
    walk(data);
    out.inData = found;
  } finally {
    await s.call('browser_close');
    s.server.close();
  }
  return out;
}

// ---------------------------------------------------------------- X1 / X2 (Linux)
function bwrapOk() { return process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0; }
const X_PROBE = String.raw`
const net = require('node:net');
const [n] = process.argv.slice(2);
const s = net.connect('\0/tmp/.X11-unix/X' + n);
const done = (v) => { console.log(JSON.stringify(v)); process.exit(0); };
s.on('connect', () => { const b = Buffer.alloc(12); b.write('l', 0); b.writeUInt16LE(11, 2); b.writeUInt16LE(0, 4); s.write(b); });
s.on('data', (d) => done({ connected: true, accepted: d[0] === 1 }));
s.on('error', (e) => done({ connected: false, code: e.code }));
setTimeout(() => done({ connected: true, noReply: true }), 4000);
`;
async function x1(T) {
  if (!bwrapOk()) return { skipped: 'Linux with bwrap only' };
  if (spawnSync('sh', ['-c', 'command -v Xvfb']).status !== 0) return { skipped: 'no Xvfb here' };
  const { bwrapArgs } = await import('../src/sandbox.mjs');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const human = 170 + Math.floor(Math.random() * 20);
  const bot = human + 30;
  const xs = [
    spawn('Xvfb', [`:${human}`, '-nolisten', 'tcp'], { stdio: 'ignore' }), // as Xorg / Xwayland listen by default
    spawn('Xvfb', [`:${bot}`, '-nolisten', 'tcp', '-nolisten', 'local'], { stdio: 'ignore' }), // the bots' own (1.5.61)
  ];
  await sleep(2500);
  const probe = path.join(ws, 'xprobe.cjs');
  fs.writeFileSync(probe, X_PROBE);
  const args = bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: '' });
  const inSandbox = (n) => { const r = spawnSync('bwrap', [...args, '--', process.execPath, probe, String(n)], { encoding: 'utf8', timeout: 20000 }); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { failed: (r.stdout + r.stderr).slice(-300) }; } };
  const out = { human: inSandbox(human), bot: inSandbox(bot), filesystemSocketVisible: spawnSync('bwrap', [...args, '--', '/bin/sh', '-c', `test -e /tmp/.X11-unix/X${human} && echo yes`], { encoding: 'utf8' }).stdout.includes('yes') };
  for (const x of xs) { try { x.kill(); } catch { /* gone */ } }
  return out;
}
async function x2(T) {
  if (!bwrapOk()) return { skipped: 'Linux with bwrap only' };
  const { bwrapArgs, botTmp } = await import('../src/sandbox.mjs');
  const { hubTmp } = await import('../src/store.mjs');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(hubTmp('keys'), 'k.key'), 'SECRET');
  const forBot = (id) => bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: botTmp(id, data) });
  const sh = (id, cmd) => spawnSync('bwrap', [...forBot(id), '--', '/bin/sh', '-c', cmd], { encoding: 'utf8', timeout: 20000 });
  const w = sh('a', 'echo mine > /tmp/a-file && echo ok');
  if (!w.stdout.includes('ok')) return { skipped: `bwrap does not start here: ${(w.stdout + w.stderr).slice(0, 200)}` };
  return {
    aKeeps: sh('a', 'cat /tmp/a-file').stdout.includes('mine'),
    bSeesA: sh('b', 'cat /tmp/a-file 2>/dev/null').stdout.includes('mine'),
    hubTmpSeen: sh('a', `cat '${path.join(data, 'tmp', 'keys', 'k.key')}' 2>/dev/null`).stdout.includes('SECRET'),
    hostTmpSeen: (() => { const f = path.join(os.tmpdir(), `secv1561-host-${process.pid}`); fs.writeFileSync(f, 'HOST'); const r = sh('a', `cat '${f}' 2>/dev/null`).stdout.includes('HOST'); fs.rmSync(f, { force: true }); return r; })(),
  };
}

const CASES = { u1, u2, x1, x2 };

export async function verifyChecks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  const me = fileURLToPath(import.meta.url);
  const run = (name) => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), `secv1561-${name}-`));
    try {
      const env = { ...process.env, ASSIST_HOME: T, ASSIST_DATA_DIR: path.join(T, 'data'), ASSIST_WORKSPACE_DIR: path.join(T, 'ws'), ASSIST_MASTER_KEY: '', BROWSER_HEADLESS: '1', ALLOW_PRIVATE: '1' };
      if (/no-such-browser/.test(env.CHROME_PATH || '')) delete env.CHROME_PATH;
      const r = spawnSync(process.execPath, [me, '--case', name, T], { env, encoding: 'utf8', timeout: 300000 });
      try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
    } finally { for (let i = 0; i < 20; i += 1) { try { fs.rmSync(T, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } } }
  };
  const r1 = run('u1');
  if (r1.skipped) skip('SECV-U1', r1.skipped);
  else {
    check('SECV-U1a after an upgrade, a browser 1.5.60 left running with its debugging port (noted with pid 0) no longer answers on that port', r1.oldUp && !r1.oldPortStillAnswers, JSON.stringify(r1));
    check('SECV-U1b ... and the new browser starts (that old one held the profile)', r1.newOpen, JSON.stringify(r1));
  }
  const r2 = run('u2');
  if (r2.skipped) skip('SECV-U2', r2.skipped);
  else check('SECV-U2 after a browser_download, a download the hub did not ask for does not land in the data folder', r2.open && r2.hubDownload && r2.inData?.length === 0, JSON.stringify(r2));
  const x1r = run('x1');
  if (x1r.skipped) skip('SECV-X1', x1r.skipped);
  else {
    // X1a: the human's own X server listens on the abstract socket too; only a network namespace
    // of the sandbox's own (or Landlock's abstract-socket scope) closes it - next batch. Reported, not failed.
    console.log(`NOTE  SECV-X1a Linux: from the bots' sandbox, a display that listens on the abstract socket (as the human's Xorg / Xwayland do) cannot be reached: ${!x1r.human?.connected ? 'yes' : 'NO'} (next batch: the sandbox's own network)  ${JSON.stringify(x1r)}`);
    check('SECV-X1b Linux: ... a bot display started with -nolisten local cannot be reached either, nor its socket file seen', !x1r.bot?.connected && !x1r.filesystemSocketVisible, JSON.stringify(x1r));
  }
  const x2r = run('x2');
  if (x2r.skipped) skip('SECV-X2', x2r.skipped);
  else check('SECV-X2 Linux: a bot keeps its own /tmp, another bot does not see it, and neither sees data/tmp or the machine\'s /tmp', x2r.aKeeps && !x2r.bSeesA && !x2r.hubTmpSeen && !x2r.hostTmpSeen, JSON.stringify(x2r));
}

if (process.argv[2] === '--case') {
  const out = await CASES[process.argv[3]](process.argv[4]);
  console.log(JSON.stringify(out));
  process.exit(0);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let failed = 0;
  await verifyChecks({ check: (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`); if (!ok) failed += 1; } });
  process.exit(failed ? 1 : 0);
}
