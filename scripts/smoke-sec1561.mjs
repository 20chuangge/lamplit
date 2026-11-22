/**
 * smoke-sec1561.mjs - 1.5.61 security fixes (the verifier's N1 and N5, F7-F9).
 *
 *   F7  the bot's browser has no debugging port: driven over a pipe; on the Windows desktop
 *       through a bridge that dials back with a one-time token; it gets childEnv.
 *   F8  the hub's temporary files are in data/tmp; the Node.js cache is checked every time;
 *       strict sandboxes get a /tmp of their own and no /run/user; what root runs on a
 *       machine Lamplit sets up is its own checked copy.
 *   F9  the files that decide what the hub trusts carry a hash Lamplit noted when it wrote
 *       them (with and without the desktop app's key): restore-pending.json, workspace.json,
 *       and without a key the key files too.
 *
 *   node scripts/smoke-sec1561.mjs     PASS / FAIL lines, exit 1 on a FAIL
 * Each case runs in a process of its own (store.mjs fixes its folders when it loads).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ME = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(ME), '..');
const src = (name) => pathToFileURL(path.join(REPO, 'src', name)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers: who listens
/** Every pid below (and including) `roots`. */
function processTree(roots) {
  const kids = new Map();
  if (process.platform === 'win32') {
    // Windows reuses pids and keeps a dead parent's pid as ParentProcessId: a child counts only
    // when it started after its parent (else a reused pid "adopts" unrelated system processes).
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const started = new Map();
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, ticks] = line.trim().split(/\s+/).map(Number);
      if (pid) { started.set(pid, ticks || 0); rows.push([pid, ppid]); }
    }
    for (const [pid, ppid] of rows) {
      if (started.has(ppid) && started.get(pid) >= started.get(ppid)) kids.set(ppid, [...(kids.get(ppid) || []), pid]);
    }
  } else {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        kids.set(ppid, [...(kids.get(ppid) || []), Number(d)]);
      } catch { /* gone */ }
    }
  }
  const all = new Set();
  const walk = (p) => { if (all.has(p)) return; all.add(p); for (const k of kids.get(p) || []) walk(k); };
  for (const r of roots) if (r) walk(Number(r));
  return all;
}

/** TCP ports in LISTEN that belong to any of `pids` (listing only: nothing is connected to). */
function listeningPortsOf(pids) {
  const ports = [];
  if (process.platform === 'win32') {
    for (const proto of ['TCP', 'TCPv6']) {
      const out = execFileSync('netstat.exe', ['-ano', '-p', proto], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
        if (m && pids.has(Number(m[3]))) ports.push(`${m[1]}:${m[2]}`);
      }
    }
  } else {
    const inodes = new Map();
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let t = '';
      try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const l of t.split('\n').slice(1)) {
        const c = l.trim().split(/\s+/);
        if (c[3] === '0A') inodes.set(c[9], parseInt(c[1].split(':').pop(), 16));
      }
    }
    for (const pid of pids) {
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let to = '';
        try { to = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(to);
        if (m && inodes.has(m[1])) ports.push(String(inodes.get(m[1])));
      }
    }
  }
  return ports;
}

const tinySite = async () => {
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>t1561</title><p>page</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
};

// ---------------------------------------------------------------- F7: the browser
async function f7pipe() {
  const B = await import(src('browser.mjs'));
  const out = {};
  const args = B.buildLaunchArgs({ port: 9, profileDir: 'x' });
  out.args = { pipe: args.includes('--remote-debugging-pipe'), port: args.some((a) => /remote-debugging-port/.test(a)) };
  const env = B.browserEnv?.({ PATH: 'p', ASSIST_MASTER_KEY: 'k', ASSIST_PROXY_SECRET: 's', GITHUB_TOKEN: 't', DESK_VNC_PASSWORD: 'v', HOME: 'h' }, 'b1') || { ASSIST_MASTER_KEY: 'inherited' };
  out.env = { kept: env.PATH === 'p' && env.HOME === 'h', dropped: !['ASSIST_MASTER_KEY', 'ASSIST_PROXY_SECRET', 'GITHUB_TOKEN', 'DESK_VNC_PASSWORD'].some((k) => k in env), tmp: process.platform === 'win32' ? 'n/a' : String(env.TMPDIR || '').startsWith(path.join(process.env.ASSIST_DATA_DIR, 'tmp')) };
  if (!B.detectBrowserExecutable().path) return { ...out, skipped: 'no Chromium-based browser here' };
  const { createRegistry } = await import(src('tools.mjs'));
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  fs.mkdirSync(ws, { recursive: true });
  const site = await tinySite();
  const reg = createRegistry({});
  const ctx = { workspaceDir: ws, botId: 'f7', bot: { id: 'f7' } };
  const call = async (name, a = {}) => { try { return await reg.get(name).run(a, ctx); } catch (err) { return { ok: false, error: { code: err.code, message: err.message } }; } };
  try {
    const opened = await call('browser_open', { url: site.url });
    out.opened = opened.ok === true && opened.title === 't1561';
    const st = await call('browser_status');
    out.status = { channel: st.channel, cdpUrl: st.cdpUrl, pid: st.pid };
    out.ports = st.pid ? listeningPortsOf(processTree([st.pid])) : ['no pid'];
    const state = JSON.parse(fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'browser-state-f7.json'), 'utf8'));
    out.statePort = 'port' in state;
  } finally {
    await call('browser_close');
    site.server.close();
  }
  return out;
}

/** The test's stand-in for the scheduled task: runs the bridge (hidden) with the ticket the .cmd names. */
const bridges = [];
async function startBridgeDirectly(script) {
  const text = fs.readFileSync(script, 'utf8');
  const quoted = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const ticket = quoted.find((q) => /browser-bridge-[0-9a-f]+\.json$/.test(q));
  const bridge = quoted.find((q) => /browser-bridge\.mjs$/.test(q));
  if (!ticket || !bridge) return false;
  const c = spawn(process.execPath, [bridge, ticket, '--child'], { stdio: 'ignore', windowsHide: true });
  bridges.push(c);
  return true;
}

async function f7bridge() {
  const B = await import(src('browser.mjs'));
  const out = {};
  // a. a connection without the token gets nothing, and the wait goes on for the bridge.
  const token = crypto.randomBytes(32).toString('hex');
  const l = await B._test.bridgeListener(token, { waitMs: 8000 });
  const wrong = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: l.port }, () => s.write(`${'0'.repeat(64)}\n123\n{"id":1,"method":"Browser.getVersion"}\0`));
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('close', () => resolve({ closed: true, got }));
    s.on('error', () => {});
    setTimeout(() => { s.destroy(); resolve({ closed: false, got }); }, 4000);
  });
  let settled = false;
  l.connected.then((v) => { settled = v; });
  await sleep(100);
  out.wrongToken = { closedOnIt: wrong.closed, answered: wrong.got.length > 0, accepted: Boolean(settled) };
  l.close();
  if (!B.detectBrowserExecutable().path) return { ...out, skipped: 'no Chromium-based browser here' };
  // b-d. the desktop path with the bridge (the scheduled task replaced by a direct start).
  let starts = 0;
  B._test.desktop = { user: 'test', headless: true, start: async (script) => { starts += 1; return startBridgeDirectly(script); } };
  const { createRegistry } = await import(src('tools.mjs'));
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  fs.mkdirSync(ws, { recursive: true });
  const site = await tinySite();
  const reg = createRegistry({});
  const ctx = { workspaceDir: ws, botId: 'f7b', bot: { id: 'f7b' } };
  const call = async (name, a = {}) => { try { return await reg.get(name).run(a, ctx); } catch (err) { return { ok: false, error: { code: err.code, message: err.message } }; } };
  try {
    const opened = await call('browser_open', { url: site.url });
    out.opened = opened.ok === true && opened.title === 't1561';
    const st = await call('browser_status');
    out.status = { channel: st.channel, cdpUrl: st.cdpUrl, pid: st.pid };
    out.ticketsLeft = fs.readdirSync(process.env.ASSIST_DATA_DIR).filter((n) => /^browser-bridge-/.test(n)).length;
    out.ports = listeningPortsOf(processTree([st.pid, ...bridges.map((b) => b.pid)]));
    // d. the bridge goes away: the hub notices, and the next call starts it again.
    const first = bridges[bridges.length - 1];
    try { if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(first.pid), '/F'], { stdio: 'ignore', windowsHide: true }); else first.kill('SIGKILL'); } catch { /* gone */ }
    let noticed = false;
    for (let i = 0; i < 50 && !noticed; i += 1) { await sleep(200); noticed = (await call('browser_status')).running === false; }
    out.noticed = noticed;
    const again = await call('browser_open', { url: site.url });
    out.reopened = again.ok === true && again.title === 't1561';
    out.starts = starts;
    const st2 = await call('browser_status');
    out.ports2 = listeningPortsOf(processTree([st2.pid, ...bridges.map((b) => b.pid)]));
  } finally {
    await call('browser_close');
    B._test.desktop = null;
    site.server.close();
    await sleep(500);
    for (const b of bridges) { try { b.kill(); } catch { /* gone */ } }
  }
  return out;
}

// ---------------------------------------------------------------- F7: Chrome's single-instance hand-over
// The verifier's section 十三 (Windows, a windowed browser): another program runs
// `chrome.exe --user-data-dir=<the bot's profile> file:///<data>/note.txt`; the running browser
// opens it as a new tab. Then the hub re-attaches (its page connection lost; before 1.5.61 also
// every restart) and the bot's browser_snapshot must not return that file. And the hub's own
// page sent to a file:// address is not read either. Windows only (the window is off the screen).
async function f7singleton() {
  if (process.platform !== 'win32') return { skipped: 'Windows only (a windowed browser takes the hand-over there)' };
  const B = await import(src('browser.mjs'));
  const exe = B.detectBrowserExecutable().path;
  if (!exe) return { skipped: 'no Chromium-based browser here' };
  const SECRET = 'SECRET-FROM-THE-DATA-FOLDER';
  const data = process.env.ASSIST_DATA_DIR;
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
  const fileUrl = `file:///${path.join(data, 'note.txt').split(path.sep).join('/')}`;
  const OFF = ['--window-position=-32000,-32000', '--window-size=400,300'];
  const key = 'f7s';
  const profile = B.profileDir(key);
  fs.mkdirSync(profile, { recursive: true });
  const { createRegistry } = await import(src('tools.mjs'));
  const reg = createRegistry({});
  const ctx = { workspaceDir: ws, botId: key, bot: { id: key } };
  const call = async (name, a = {}) => { try { return await reg.get(name).run(a, ctx); } catch (err) { return { ok: false, error: { code: err.code, message: err.message } }; } };
  const site = await tinySite();
  const out = { pipe: B.buildLaunchArgs({ profileDir: 'x' }).includes('--remote-debugging-pipe') };
  let own = null; // before 1.5.61: the test starts "the hub's" browser itself, as the verifier did
  try {
    if (out.pipe) {
      B._test.extraArgs = OFF;
      const opened = await call('browser_open', { url: site.url });
      out.opened = opened.ok === true;
    } else {
      const port = 30000 + Math.floor(Math.random() * 20000);
      own = spawn(exe, B.buildLaunchArgs({ port, profileDir: profile, headless: false, extraArgs: OFF }), { stdio: 'ignore' });
      let up = false;
      for (let i = 0; i < 80 && !up; i += 1) { try { up = Boolean(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()); } catch { await sleep(250); } }
      fs.writeFileSync(path.join(data, `browser-state-${key}.json`), JSON.stringify({ port, pid: own.pid, executable: exe, headless: false }));
      out.opened = up;
    }
    // The hand-over: a second chrome.exe with the same profile and a data-folder file.
    out.secondLaunch = await new Promise((resolve) => {
      const c = spawn(exe, [`--user-data-dir=${profile}`, ...OFF, fileUrl], { stdio: 'ignore' });
      const timer = setTimeout(() => { try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' }); } catch { /* gone */ } resolve('still running after 10 s'); }, 10000);
      c.on('close', (code) => { clearTimeout(timer); resolve(`exited ${code}`); });
    });
    await sleep(2000);
    const mgr = B.getBrowserManager(key);
    if (out.pipe) {
      const listed = await mgr.session.browser.send('Target.getTargets');
      out.fileTabLeft = (listed.targetInfos || []).some((t) => /note\.txt/.test(t.url));
      mgr.session.page.close(); // the page connection lost: the hub attaches again
      await sleep(300);
    }
    const snap = await call('browser_snapshot');
    out.snapshotAfterReattach = JSON.stringify(snap).slice(0, 200);
    out.reattachLeaked = JSON.stringify(snap).includes(SECRET);
    out.reattachedTo = JSON.parse(JSON.stringify(snap)).title || '';
    // The hub's own page sent to file:// (nothing in Lamplit does that; the check stands anyway), before each call.
    const atFile = async () => { await mgr.session?.page?.send('Page.navigate', { url: fileUrl }).catch(() => {}); await sleep(800); };
    const after = {};
    await atFile(); after.snapshot = await call('browser_snapshot');
    await atFile(); after.eval = await call('browser_eval', { expression: 'document.body && document.body.innerText' });
    await atFile(); after.shot = await call('browser_screenshot', {});
    await atFile(); after.click = await call('browser_click', { selector: 'body' });
    out.ownPageLeaked = JSON.stringify(after.snapshot).includes(SECRET) || JSON.stringify(after.eval).includes(SECRET);
    out.ownPageRefused = [after.snapshot, after.eval, after.shot, after.click].map((r) => r?.error?.code || (r?.ok ? 'ok' : 'failed'));
    out.backToBlank = (await call('browser_status')).pageUrl;
  } finally {
    await call('browser_close');
    if (own) { try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(own.pid)], { stdio: 'ignore' }); } catch { /* gone */ } }
    if (B._test) B._test.extraArgs = null;
    site.server.close();
  }
  return out;
}

// ---------------------------------------------------------------- F11-F14 (the verifier's section 十四)
/** F11: at hub start, a browser left on a bot profile (1.5.60's, with its port) is stopped; one on any other profile is not. */
async function f11sweep() {
  const B = await import(src('browser.mjs'));
  const exe = B.detectBrowserExecutable().path;
  const out = {};
  const srv = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
  out.atStart = srv.indexOf('sweepLeftoverBrowsers()') > 0 && srv.indexOf('sweepLeftoverBrowsers()') < srv.indexOf('await noteTrustedFiles(P.dataDir)') && srv.indexOf('sweepLeftoverBrowsers()') < srv.indexOf('clearOldBotTmp()');
  out.parse = B.userDataDirOf('"C:\\a b\\chrome.exe" "--user-data-dir=C:\\x y\\p" --no-first-run') === 'C:\\x y\\p'
    && B.userDataDirOf('chrome --user-data-dir="/a b/p" x') === '/a b/p' && B.userDataDirOf('chrome --user-data-dir=/a/p --x') === '/a/p' && B.userDataDirOf('chrome --x') === '';
  if (!exe) return { ...out, skipped: 'no Chromium-based browser here' };
  const data = process.env.ASSIST_DATA_DIR;
  const botProfile = B.profileDir('old1');
  const otherProfile = path.join(process.env.ASSIST_HOME, 'someone-elses-profile');
  fs.mkdirSync(botProfile, { recursive: true });
  fs.mkdirSync(otherProfile, { recursive: true });
  const port = 30000 + Math.floor(Math.random() * 20000);
  const answers = async (p) => { try { return Boolean((await (await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl); } catch { return false; } };
  const start = (p, profile) => spawn(exe, [`--remote-debugging-port=${p}`, `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', 'about:blank'], { stdio: 'ignore', detached: true });
  const old = start(port, botProfile);
  const other = start(port + 1, otherProfile);
  for (let i = 0; i < 80 && !(await answers(port) && await answers(port + 1)); i += 1) await sleep(250);
  out.bothUp = (await answers(port)) && (await answers(port + 1));
  fs.writeFileSync(path.join(data, 'browser-state-old1.json'), JSON.stringify({ port, pid: 0, executable: exe, headless: false, onDesktop: true }));
  try {
    out.stopped = (await B.sweepLeftoverBrowsers()).length;
    await sleep(1000);
    out.oldStillAnswers = await answers(port);
    out.otherStillAnswers = await answers(port + 1);
    out.stateGone = !fs.existsSync(path.join(data, 'browser-state-old1.json'));
  } finally {
    for (const c of [old, other]) { try { if (process.platform === 'win32') execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' }); else process.kill(-c.pid); } catch { /* gone */ } }
  }
  return out;
}

/** F12-F14 by their code (x11vnc and the relay script run on Linux servers only). */
async function f12to14() {
  const out = {};
  const desk = fs.readFileSync(path.join(REPO, 'src', 'desktops.mjs'), 'utf8');
  const srv = fs.readFileSync(path.join(REPO, 'src', 'server.mjs'), 'utf8');
  const V = await import(src('vncauth.mjs'));
  out.f12 = {
    password: desk.includes("'-localhost', '-rfbauth', authFile,") && !desk.includes("'-nopw'"),
    noWebsockifyForX11: !/startViewer[\s\S]{0,2500}spawnChild\('websockify'/.test(desk.slice(desk.indexOf('const password = randomVncPassword();') - 600, desk.indexOf('const password = randomVncPassword();') + 1600)),
    hubSignsIn: srv.includes('bridgeWebSocket(req, socket, head, { port: info.vncPort, vnc: { password: viewerPassword } })'),
    notInInfo: !/viewerPassword/.test(desk.slice(desk.indexOf('function publicInfo'), desk.indexOf('function publicInfo') + 900)),
    fileFormat: V.vncStoredPassword('password').toString('hex') === 'dbd83cfd727a1458', // the standard VNC password file (x11vnc -rfbauth)
  };
  const derp = fs.readFileSync(path.join(REPO, 'hub', 'derp-linux.sh'), 'utf8');
  out.f13 = derp.includes('GOTMP=$(mktemp -d)') && /sha256sum -c -/.test(derp) && !derp.includes('/tmp/lamplit-go.tgz') && derp.indexOf('sha256sum -c') < derp.indexOf('tar -C "$BASE" -xzf "$GOTMP/go.tgz"');
  const br = fs.readFileSync(path.join(REPO, 'src', 'browser.mjs'), 'utf8');
  out.f14 = br.includes("await session.browser.send('Browser.setDownloadBehavior', { behavior: 'deny' }") && br.includes('await this.denyDownloads({ browser, page });') && br.includes('await this.denyDownloads({ browser: bridged.browser, page });') && br.includes('if (this.session) await this.denyDownloads(this.session);');
  return out;
}

// ---------------------------------------------------------------- F8: temp files, cache, sandbox, root runs
async function f8paths() {
  const data = process.env.ASSIST_DATA_DIR;
  const tmpRoot = path.join(data, 'tmp');
  const out = {};
  const { packApp, cleanupPack } = await import(src('bundle.mjs'));
  const fake = path.join(process.env.ASSIST_HOME, 'fakeapp');
  for (const d of ['src', 'public']) { fs.mkdirSync(path.join(fake, d), { recursive: true }); fs.writeFileSync(path.join(fake, d, 'x.txt'), d); }
  fs.writeFileSync(path.join(fake, 'package.json'), '{}');
  try {
    const packed = await packApp({ root: fake });
    out.pack = path.dirname(packed.file).startsWith(tmpRoot);
    cleanupPack(packed.file);
  } catch (err) { out.pack = `error: ${err.message}`; }
  const ts = fs.readFileSync(path.join(REPO, 'src', 'tailscale.mjs'), 'utf8');
  out.tailscaleKeys = ts.includes("tmpDir = hubTmp('keys'),") && !/tmpDir = os\.tmpdir\(\)/.test(ts);
  // No other place in src/ uses the system temp folder.
  const users = fs.readdirSync(path.join(REPO, 'src')).filter((n) => n.endsWith('.mjs') && /os\.tmpdir\(\)/.test(fs.readFileSync(path.join(REPO, 'src', n), 'utf8')));
  out.osTmpdirUsers = users;
  // The Node.js cache: data/tmp/cache, checked every time (fetching is made to fail: offline).
  const { nodePackage } = await import(src('remote.mjs'));
  const offline = async () => { throw new Error('offline'); };
  const big = Buffer.alloc(11 * 1024 * 1024, 7);
  const sha = crypto.createHash('sha256').update(big).digest('hex');
  const cache = path.join(tmpRoot, 'cache');
  const name = 'node-v22.999.0-linux-x64.tar.gz';
  // a bot's "Node.js" in the old place (the system's /tmp/nightshift-cache): not looked at.
  const old = path.join(os.tmpdir(), 'nightshift-cache');
  fs.mkdirSync(old, { recursive: true });
  const oldFake = path.join(old, `node-v22.998.${process.pid}-linux-x64.tar.gz`);
  fs.writeFileSync(oldFake, big);
  const fromOld = await nodePackage('linux', 'x64', { fetchImpl: offline });
  fs.rmSync(oldFake, { force: true });
  out.oldCacheIgnored = fromOld === null;
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, name), big);
  const noSum = await nodePackage('linux', 'x64', { fetchImpl: offline });
  out.noSumNotUsed = noSum === null && !fs.existsSync(path.join(cache, name));
  fs.writeFileSync(path.join(cache, name), big);
  fs.writeFileSync(path.join(cache, `${name}.sha256`), `${'0'.repeat(64)}  ${name}\n`);
  const wrongSum = await nodePackage('linux', 'x64', { fetchImpl: offline });
  out.wrongSumNotUsed = wrongSum === null && !fs.existsSync(path.join(cache, name));
  fs.writeFileSync(path.join(cache, name), big);
  fs.writeFileSync(path.join(cache, `${name}.sha256`), `${sha}  ${name}\n`);
  const good = await nodePackage('linux', 'x64', { fetchImpl: offline });
  out.goodUsed = good?.file === path.join(cache, name);
  return out;
}

async function f8root() {
  const { rootRunCommand } = await import(src('remote.mjs'));
  const out = {};
  const files = [{ at: '/tmp/a.sh', name: 'a.sh', sha256: 'a'.repeat(64) }];
  const cmd = rootRunCommand(files, (d) => `/bin/bash ${d}/a.sh`);
  out.shape = /mktemp -d/.test(cmd) && /cp -- /.test(cmd) && /sha256sum -c/.test(cmd) && /\/bin\/bash "\$d"\/a\.sh/.test(cmd) && !/bash \/tmp\/a\.sh/.test(cmd);
  const remote = fs.readFileSync(path.join(REPO, 'src', 'remote.mjs'), 'utf8');
  out.noDirectRuns = !/\/bin\/bash \/tmp\/|bash \$\{remoteScript\}|sudoPrefix\}bash \/tmp/.test(remote) && (remote.match(/rootRunCommand\(/g) || []).length >= 6;
  let threw = false;
  try { rootRunCommand([{ at: '/tmp/x', name: 'x;rm', sha256: 'a'.repeat(64) }], () => 'true'); } catch { threw = true; }
  out.badNameRefused = threw;
  // Run it for real where there is a shell with sha256sum (Linux): checked copy runs, a changed upload does not.
  if (process.platform === 'linux' && spawnSync('sha256sum', ['--version']).status === 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8root-'));
    const script = path.join(dir, 'up.sh');
    fs.writeFileSync(script, 'echo RAN-FROM-COPY\n');
    const want = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
    const okRun = spawnSync('/bin/sh', ['-c', rootRunCommand([{ at: script, name: 'up.sh', sha256: want }], (d) => `/bin/sh ${d}/up.sh`)], { encoding: 'utf8' });
    fs.writeFileSync(script, 'echo SWAPPED\n');
    const badRun = spawnSync('/bin/sh', ['-c', rootRunCommand([{ at: script, name: 'up.sh', sha256: want }], (d) => `/bin/sh ${d}/up.sh`)], { encoding: 'utf8' });
    out.real = { good: okRun.stdout.includes('RAN-FROM-COPY'), refused: badRun.status === 97 && !badRun.stdout.includes('SWAPPED') && badRun.stdout.includes('DESK_VERIFY=failed') };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** The bot's own screen in a strict sandbox (all platforms: the rules; Linux with bwrap: for real). */
async function f8screen() {
  const SB = await import(src('sandbox.mjs'));
  const out = {};
  const own = SB.botScreen('b1', { envOf: () => ({ DISPLAY: ':901' }), exists: (p) => p === '/tmp/.X11-unix/X901' });
  out.x11 = own && own.env.DISPLAY === ':901' && own.bind.join() === '/tmp/.X11-unix/X901';
  const wl = SB.botScreen('b1', { envOf: () => ({ WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/tmp/desk-wl-1000-121' }), exists: () => true });
  out.wayland = wl && wl.env.WAYLAND_DISPLAY === 'wayland-1' && wl.bind[0] === path.join('/tmp/desk-wl-1000-121', 'wayland-1');
  out.none = SB.botScreen('b1', { envOf: () => ({}), exists: () => true }) === null && SB.botScreen('b1', { envOf: () => ({ DISPLAY: ':901' }), exists: () => false }) === null;
  const args = SB.bwrapArgs({ mode: 'strict', root: '/r', dataDir: '/r/data', workspaceDir: '/r/ws', tmpDir: '/r/data/sandbox-tmp/b1', screen: own, exists: () => true });
  out.boundOnlyOwn = args.join(' ').includes('--ro-bind /tmp/.X11-unix/X901 /tmp/.X11-unix/X901') && !args.some((a) => /X11-unix\/X0|X11-unix$|ssh-|\.com\.google\.Chrome/.test(a));
  const human = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/home/u/.Xauthority', PATH: '/usr/bin' };
  const withScreen = SB.sandboxEnv(human, { mode: 'strict', env: own.env });
  const without = SB.sandboxEnv(human, { mode: 'strict', env: null });
  out.env = { withScreen: withScreen.DISPLAY === ':901' && !withScreen.WAYLAND_DISPLAY && !withScreen.XAUTHORITY, without: !('DISPLAY' in without) && !('WAYLAND_DISPLAY' in without) && without.PATH === '/usr/bin', open: SB.sandboxEnv(human, { mode: 'open' }).DISPLAY === ':0' };
  const tools = fs.readFileSync(path.join(REPO, 'src', 'tools.mjs'), 'utf8');
  out.toldWhenNone = tools.includes('This machine runs no screen for you, so a graphical program has no display here') && tools.includes('env: sandboxEnv(env, sandbox)');
  const desk = fs.readFileSync(path.join(REPO, 'src', 'desktops.mjs'), 'utf8');
  out.noAbstractSocket = desk.includes("'-nolisten', 'tcp', '-nolisten', 'local'");
  return out;
}

async function f8sandbox() {
  if (process.platform !== 'linux') return { skipped: 'Linux only' };
  if (spawnSync('bwrap', ['--version']).status !== 0) return { skipped: 'no bwrap here' };
  const { bwrapArgs, botTmp } = await import(src('sandbox.mjs'));
  const data = process.env.ASSIST_DATA_DIR;
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  fs.mkdirSync(ws, { recursive: true });
  const sh = (bot, cmd) => spawnSync('bwrap', [...bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: botTmp(bot, data) }), '--', '/bin/sh', '-c', cmd], { encoding: 'utf8', timeout: 60000 });
  const probe = sh('a', 'echo up');
  if (probe.status !== 0) return { skipped: `bwrap does not start here: ${(probe.stdout + probe.stderr).slice(0, 200)}` };
  const name = `f8-${process.pid}`;
  const hubFile = path.join('/tmp', `f8-hub-${process.pid}`);
  fs.writeFileSync(hubFile, 'HUB-SECRET', { mode: 0o600 });
  const out = {};
  sh('a', `echo kept > /tmp/${name}`);
  out.keptForSameBot = sh('a', `cat /tmp/${name}`).stdout.includes('kept');
  out.otherBotSees = sh('b', `cat /tmp/${name} 2>/dev/null`).stdout.includes('kept');
  out.realTmpHasIt = fs.existsSync(path.join('/tmp', name));
  out.hubFileSeen = sh('a', `cat ${hubFile} 2>/dev/null`).stdout.includes('HUB-SECRET');
  out.runUserEmpty = sh('a', 'ls -A /run/user 2>/dev/null | wc -l').stdout.trim() === '0';
  fs.rmSync(hubFile, { force: true });
  // The bot's own screen socket is bound in; the human's is not (two stand-in X sockets).
  const xdir = '/tmp/.X11-unix';
  try { fs.mkdirSync(xdir, { recursive: true }); } catch { /* there */ }
  const n = 900 + (process.pid % 90);
  const ownSock = path.join(xdir, `X${n}`);
  const humanSock = path.join(xdir, `X${n + 1}`);
  const servers = [];
  try {
    for (const p of [ownSock, humanSock]) {
      try { fs.rmSync(p, { force: true }); } catch { /* none */ }
      const srv = net.createServer((c) => c.end('X'));
      await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, resolve); });
      servers.push(srv);
    }
    const node = process.execPath;
    if (/^\/(home|root)\//.test(node)) out.screen = 'node is under /home here (hidden in the sandbox)';
    else {
      const probe = (p) => `${node} -e "require('net').connect('${p}').on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',()=>{console.log('NO');process.exit(0)})"`;
      const screen = { env: { DISPLAY: `:${n}` }, bind: [ownSock] };
      const run = (cmd) => new Promise((resolve) => {
        const c = spawn('bwrap', [...bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [], tmpDir: botTmp('a', data), screen }), '--', '/bin/sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        let so = ''; c.stdout.on('data', (d) => { so += d; }); c.on('close', () => resolve(so.trim()));
      });
      out.screen = { own: await run(probe(ownSock)), human: await run(probe(humanSock)) };
    }
  } catch (err) { out.screen = `could not set up: ${err.message}`; } finally {
    for (const s of servers) s.close();
    for (const p of [ownSock, humanSock]) { try { fs.rmSync(p, { force: true }); } catch { /* gone */ } }
  }
  return out;
}

// ---------------------------------------------------------------- F9: the trust note
async function f9files() {
  const store = await import(src('store.mjs'));
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  const keyed = Boolean(store.masterKey());
  const out = { keyed };
  const MCP = [{ id: 'fs', name: 'files', transport: 'stdio', command: 'npx', args: ['x'] }];
  const EVIL = [{ id: 'evil', transport: 'stdio', command: 'sh', args: ['-c', 'echo pwned'] }];
  const mcp = path.join(data, 'mcp.json');
  // From before 1.5.61: a file there before the note exists is noted as it is at the first start.
  await store.writeJsonAtomic(mcp, MCP);
  if (keyed) await store.sealSecretFiles(data);
  const noted = await store.noteTrustedFiles?.(data);
  out.note = { file: fs.existsSync(path.join(data, keyed ? (store.TRUST_SEALED_FILE || 'trust-sealed.json') : (store.TRUST_FILE || 'trust.json'))), noted };
  out.firstReads = JSON.stringify(await store.readJson(mcp, null)) === JSON.stringify(MCP);
  // Lamplit writes again: read as written.
  const MCP2 = [...MCP, { id: 'b', transport: 'stdio', command: 'y' }];
  await store.writeJsonAtomic(mcp, MCP2);
  out.rewriteReads = JSON.stringify(await store.readJson(mcp, null)) === JSON.stringify(MCP2);
  // Without a key: a key file put there by something else (none was there: noted as none) is not used.
  if (!keyed) {
    fs.writeFileSync(path.join(data, 'secrets.json'), JSON.stringify({ apiKey: 'planted' }));
    out.plantedKeyFile = { readAs: await store.readJson(path.join(data, 'secrets.json'), 'FALLBACK'), listed: store.refusedPlainFiles.get('secrets.json')?.reason };
    // ... and one replaced under Lamplit's (what the verifier's browser download could not, but say it).
    fs.writeFileSync(mcp, JSON.stringify(EVIL));
    out.replacedKeyFile = await store.readJson(mcp, 'FALLBACK');
    await store.writeJsonAtomic(mcp, MCP); // set again in Settings
    // The two key files Lamplit writes itself, not through store's writers (tightvnc.json, relay-link.json): noted too.
    const tv = path.join(data, 'tightvnc.json');
    fs.writeFileSync(tv, '{"password":"x"}\n');
    store.noteNow?.(tv);
    const srcOf = (n) => fs.readFileSync(path.join(REPO, 'src', n), 'utf8');
    out.directWriters = (await store.readJson(tv, 'FALLBACK'))?.password === 'x' && ['localvnc.mjs', 'relaylink.mjs'].every((n) => /renameSync\(`\$\{file\}\.tmp`, file\);\r?\n\s*noteNow\(file\);/.test(srcOf(n)));
    out.setAgain = { reads: JSON.stringify(await store.readJson(mcp, null)) === JSON.stringify(MCP), listed: store.refusedPlainFiles.has('mcp.json') };
  }
  // A write cut between the two notes (the hash added, then the rename, then the old one dropped).
  const vision = path.join(data, keyed ? 'restore-pending.json' : 'vision.json');
  await store.writeTextAtomic(vision, '{"v":1}\n');
  store._trust?.noteBefore(vision, '{"v":2}\n');
  out.cutBeforeRename = (await store.readJson(vision, 'FALLBACK'))?.v === 1;
  fs.writeFileSync(vision, '{"v":2}\n');
  out.cutAfterRename = (await store.readJson(vision, 'FALLBACK'))?.v === 2;
  store._trust?.noteAfter(vision, '{"v":2}\n');
  fs.writeFileSync(vision, '{"v":1}\n');
  out.oldOneDroppedAfter = (await store.readJson(vision, 'FALLBACK')) === 'FALLBACK';
  await store.writeTextAtomic(vision, '{"v":3}\n');
  if (keyed) await fs.promises.rm(vision, { force: true });
  return out;
}

async function f9restore() {
  const store = await import(src('store.mjs'));
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  await store.noteTrustedFiles?.(data); // (absent before 1.5.61: the run before the fix shows the attack)
  const backup = await import(src('backup.mjs'));
  // Planted: a "backup" staged in data/.restore that would put a bot into config/bots.
  const stage = path.join(data, '.restore', 'planted');
  fs.mkdirSync(path.join(stage, 'files', 'config', 'bots'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'plan.json'), JSON.stringify({ mode: 'replace', from: 'x' }));
  fs.writeFileSync(path.join(stage, 'secrets.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(stage, 'files', 'config', 'bots', 'planted.json'), JSON.stringify({ id: 'planted', name: 'planted' }));
  fs.writeFileSync(path.join(data, 'restore-pending.json'), JSON.stringify({ id: 'planted', dir: path.join('.restore', 'planted') }));
  const planted = await backup.applyPendingRestore();
  const out = { plantedDone: planted !== null, plantedBot: fs.existsSync(path.join(process.env.ASSIST_HOME, 'config', 'bots', 'planted.json')), listed: store.refusedPlainFiles.get('restore-pending.json')?.reason };
  // Lamplit's own (written through its writer): taken up (it reports what it could not do).
  fs.rmSync(path.join(data, 'restore-pending.json'), { force: true });
  await store.writeTextAtomic(path.join(data, 'restore-pending.json'), `${JSON.stringify({ id: 'own', dir: path.join('.restore', 'own') })}\n`);
  const own = await backup.applyPendingRestore();
  out.ownTakenUp = own !== null;
  out.pendingGone = !fs.existsSync(path.join(data, 'restore-pending.json'));
  return out;
}

/** workspace.json: phase 'plant' (note, then put one there), 'read' (a new start), 'set' (Lamplit sets it), 'reread'. */
async function f9workspace(phase) {
  const store = await import(src('store.mjs'));
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  if (phase === 'plant') {
    await store.noteTrustedFiles?.(data); // (absent before 1.5.61: the run before the fix shows the attack)
    fs.writeFileSync(store.WORKSPACE_FILE, JSON.stringify({ path: process.env.ASSIST_HOME }));
    return { planted: true };
  }
  if (phase === 'set') {
    store.writeJsonSyncAtomic(store.WORKSPACE_FILE, { path: path.join(process.env.ASSIST_HOME, 'chosen') });
    return { set: true };
  }
  return { workspaceDir: store.P.workspaceDir, defaultDir: store.DEFAULT_WORKSPACE_DIR, listed: store.refusedPlainFiles.get('workspace.json')?.reason || '' };
}

const CASES = { f11sweep, f12to14, f7pipe, f7bridge, f7singleton, f8paths, f8root, f8screen, f8sandbox, f9files, f9restore, f9workspace };

function dropFolder(dir) {
  for (let i = 0; i < 20; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}

export async function sec1561Checks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  const KEY = crypto.randomBytes(32).toString('hex');
  const run = (name, { T = null, key = '', arg = '', workspace = true, extra = {} } = {}) => {
    const home = T || fs.mkdtempSync(path.join(os.tmpdir(), `sec1561-${name}-`));
    const env = { ...process.env, ASSIST_HOME: home, ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_MASTER_KEY: key, BROWSER_HEADLESS: '1', ALLOW_PRIVATE: '1', ...extra };
    if (workspace) env.ASSIST_WORKSPACE_DIR = path.join(home, 'ws'); else delete env.ASSIST_WORKSPACE_DIR;
    if (/no-such-browser/.test(env.CHROME_PATH || '')) delete env.CHROME_PATH;
    const r = spawnSync(process.execPath, [ME, '--case', name, arg], { env, encoding: 'utf8', timeout: 600000 });
    if (!T) dropFolder(home);
    try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
  };
  const J = (o) => JSON.stringify(o).slice(0, 600);

  // F7
  const p = run('f7pipe');
  check('SEC-F7a the bot browser is started with --remote-debugging-pipe, never a debugging port', p.args?.pipe && !p.args.port, J(p));
  check('SEC-F7b the browser gets childEnv: no ASSIST_MASTER_KEY, ASSIST_PROXY_SECRET, *_TOKEN, DESK_*; its temp files in data/tmp (Linux)', p.env?.kept && p.env.dropped && p.env.tmp !== false, J(p));
  if (p.skipped) skip('SEC-F7c/d (browser)', p.skipped);
  else {
    check('SEC-F7c a running bot browser (pipe): opens pages, no 127.0.0.1 port of its process tree listens, the state file notes no port', p.opened && p.status?.channel === 'pipe' && p.status.cdpUrl === null && Array.isArray(p.ports) && p.ports.length === 0 && p.statePort === false, J(p));
  }
  const b = run('f7bridge');
  check('SEC-F7d the desktop bridge\'s wait: a connection without the one-time token is closed unanswered, and not taken', b.wrongToken?.closedOnIt && !b.wrongToken.answered && !b.wrongToken.accepted, J(b));
  if (b.skipped) skip('SEC-F7e/f (browser)', b.skipped);
  else {
    check('SEC-F7e the browser on the Windows desktop path (through the bridge): drives pages, no port of the browser or the bridge listens, the ticket is gone', b.opened && b.status?.channel === 'bridge' && b.ports?.length === 0 && b.ticketsLeft === 0, J(b));
    check('SEC-F7f the bridge goes away: the hub notices (not running), the next call starts it again through a new bridge, still no port', b.noticed && b.reopened && b.starts === 2 && b.ports2?.length === 0, J(b));
  }

  const sg = run('f7singleton', { extra: { BROWSER_HEADLESS: '' } });
  if (sg.skipped) skip('SEC-F7g/h (single-instance hand-over)', sg.skipped);
  else {
    check('SEC-F7g Chrome\'s single-instance hand-over (another program: chrome.exe --user-data-dir=<the bot\'s> file:///<data>/…): after a re-attach the bot\'s snapshot is the hub\'s own page, never that file; the file tab is closed', sg.opened && !sg.reattachLeaked && sg.fileTabLeft === false && sg.reattachedTo === 't1561', J(sg));
    check('SEC-F7h the hub\'s own page at a file:// address: snapshot, eval, screenshot and click refuse it (PAGE_NOT_WEB) and send it back to about:blank', !sg.ownPageLeaked && Array.isArray(sg.ownPageRefused) && sg.ownPageRefused.every((c) => c === 'PAGE_NOT_WEB'), J(sg));
  }

  // F11-F14
  const sw = run('f11sweep');
  check('SEC-F11a at hub start (before the trust note and any bot command) every browser left on a bot profile is stopped; --user-data-dir read quoted or bare', sw.atStart && sw.parse, J(sw));
  if (sw.skipped) skip('SEC-F11b (browser)', sw.skipped);
  else check('SEC-F11b a browser 1.5.60 left on a bot profile (its debugging port, pid 0 noted) no longer answers; a browser on a profile that is not Lamplit\'s is left alone; the old notes go', sw.bothUp && sw.stopped >= 1 && !sw.oldStillAnswers && sw.otherStillAnswers && sw.stateGone, J(sw));
  const ft = run('f12to14');
  check('SEC-F12 Linux bot screens: x11vnc asks for a password (a new one each time, in data/), the hub signs in and the page types none; no websockify; the password is never in an API answer', Object.values(ft.f12 || {}).every(Boolean), J(ft));
  check('SEC-F13 the relay server\'s Go: downloaded into mktemp -d and checked against Go\'s SHA-256 before it is unpacked', ft.f13 === true, J(ft));
  check('SEC-F14 downloads are refused from start (windowed too) and again after each browser_download', ft.f14 === true, J(ft));

  // F8
  const t = run('f8paths');
  check('SEC-F8a the hub\'s own temporary files are in data/tmp: the package for a new machine, a pasted Tailscale key; nothing in src/ uses the system temp folder', t.pack === true && t.tailscaleKeys && Array.isArray(t.osTmpdirUsers) && t.osTmpdirUsers.length === 0, J(t));
  check('SEC-F8b the Node.js package cache (data/tmp/cache) is used only while it matches its noted SHA-256; one in the old /tmp/nightshift-cache is not looked at', t.oldCacheIgnored && t.noSumNotUsed && t.wrongSumNotUsed && t.goodUsed, J(t));
  const r = run('f8root');
  check('SEC-F8c what root runs on a machine Lamplit sets up is its own checked copy (mktemp -d, cp, sha256sum -c), for every upload it runs', r.shape && r.noDirectRuns && r.badNameRefused && (!r.real || (r.real.good && r.real.refused)), J(r));
  const sc = run('f8screen');
  check('SEC-F8e strict sandbox and screens: only the bot\'s own screen socket is bound in (X11 or Wayland), its DISPLAY set; the human\'s DISPLAY, WAYLAND_DISPLAY and XAUTHORITY taken away; with no screen of its own the bot is told; the bots\' Xvfb has no abstract socket', sc.x11 && sc.wayland && sc.none && sc.boundOnlyOwn && sc.env?.withScreen && sc.env.without && sc.env.open && sc.toldWhenNone && sc.noAbstractSocket, J(sc));
  const s = run('f8sandbox');
  if (s.skipped && process.platform === 'linux' && process.env.CI) check('SEC-F8d Linux (CI): the bots\' sandbox starts here, so the /tmp checks run', false, s.skipped);
  else if (s.skipped) skip('SEC-F8d', s.skipped);
  else check('SEC-F8d Linux strict sandbox: each bot\'s own /tmp, kept between its commands, not another bot\'s, not the real /tmp; the hub\'s /tmp files and /run/user not visible', s.keptForSameBot && !s.otherBotSees && !s.realTmpHasIt && !s.hubFileSeen && s.runUserEmpty, J(s));
  if (s && !s.skipped) check('SEC-F8f Linux strict sandbox: a GUI program reaches the bot\'s own screen socket, not another display\'s (the human\'s)', typeof s.screen === 'object' ? s.screen.own === 'OPEN' && s.screen.human === 'NO' : false, J(s.screen));

  // F9
  for (const [label, key] of [['no key', ''], ['with the key', KEY]]) {
    const f = run('f9files', { key });
    const base = f.note?.file && f.firstReads && f.rewriteReads && f.cutBeforeRename && f.cutAfterRename && f.oldOneDroppedAfter;
    const keyless = key ? true : (f.plantedKeyFile?.readAs === 'FALLBACK' && f.plantedKeyFile.listed === 'changed' && f.replacedKeyFile === 'FALLBACK' && f.setAgain?.reads && !f.setAgain.listed && f.directWriters);
    check(`SEC-F9a (${label}) the trust note: made at the first start from what is there, Lamplit's own writes read back (a write cut halfway too)${key ? '' : '; a key file put there or replaced by something else is not used, set again it is'}`, base && keyless, J(f));
    const rs = run('f9restore', { key });
    check(`SEC-F9b (${label}) a restore-pending.json put in data/ by something else: no restore at start (no bot in config/bots), 体检 says so; Lamplit's own is taken up`, !rs.plantedDone && !rs.plantedBot && rs.listed === 'changed' && rs.ownTakenUp && rs.pendingGone, J(rs));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1561-ws-'));
    run('f9workspace', { T: home, key, arg: 'plant', workspace: false });
    const read = run('f9workspace', { T: home, key, arg: 'read', workspace: false });
    run('f9workspace', { T: home, key, arg: 'set', workspace: false });
    const reread = run('f9workspace', { T: home, key, arg: 'read', workspace: false });
    dropFolder(home);
    check(`SEC-F9c (${label}) a workspace.json put in data/ by something else does not move the bots' workspace (to the folder with data/ in it); set in Settings it does`, read.workspaceDir === read.defaultDir && read.listed === 'changed' && reread.workspaceDir === path.join(home, 'chosen') && !reread.listed, J({ read, reread }));
  }
}

if (process.argv[2] === '--case') {
  const out = await CASES[process.argv[3]](process.argv[4]);
  console.log(JSON.stringify(out));
  process.exit(0);
} else if (process.argv[1] && ME === path.resolve(process.argv[1])) {
  let failed = 0;
  await sec1561Checks({ check: (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`); if (!ok) failed += 1; } });
  process.exit(failed ? 1 : 0);
}
