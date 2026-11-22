/**
 * smoke-vnc1553.mjs - 1.5.53 (security review N2): the Windows screen asks for
 * a password, and the hub signs in for the page.
 *
 * TightVNC on 127.0.0.1:5900 had no password: a bot's own command on that
 * machine is loopback too and could see and drive the console. A mock VNC
 * server stands in for TightVNC (RFB 3.8, VNC authentication with a full and a
 * view-only password, a ServerInit once signed in): no TightVNC is installed.
 *
 *   node scripts/smoke-vnc1553.mjs [--server path/to/src/server.mjs]
 * runs the end-to-end part alone against any checkout (the code before 1.5.53
 * fails it: the page is asked for the password itself).
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A VNC server like TightVNC's: {port, auths:[{ok, as}], set({password, viewOnly}), close()}. password '' = no authentication. */
export async function mockVnc({ password: pw0 = '', viewOnly: vo0 = '', name = 'mock-console' } = {}) {
  let password = pw0;
  let viewOnly = vo0;
  const { vncResponse } = await import('../src/vncauth.mjs');
  const auths = [];
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    let buf = Buffer.alloc(0);
    let step = 'version';
    let challenge = null;
    sock.on('error', () => {});
    sock.write('RFB 003.008\n');
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (step === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from(password ? [1, 2] : [1, 1]));
          step = 'type';
        } else if (step === 'type') {
          if (buf.length < 1) return;
          const t = buf[0];
          buf = buf.subarray(1);
          if (t === 2 && password) {
            challenge = crypto.randomBytes(16);
            sock.write(challenge);
            step = 'response';
          } else if (t === 1 && !password) {
            sock.write(Buffer.from([0, 0, 0, 0]));
            auths.push({ ok: true, as: 'open' });
            step = 'init';
          } else { sock.destroy(); return; }
        } else if (step === 'response') {
          if (buf.length < 16) return;
          const got = buf.subarray(0, 16);
          buf = buf.subarray(16);
          const as = got.equals(vncResponse(password, challenge)) ? 'full' : viewOnly && got.equals(vncResponse(viewOnly, challenge)) ? 'view' : '';
          auths.push({ ok: Boolean(as), as });
          if (!as) { const why = Buffer.from('Authentication failed'); const n = Buffer.alloc(4); n.writeUInt32BE(why.length); sock.end(Buffer.concat([Buffer.from([0, 0, 0, 1]), n, why])); return; }
          sock.write(Buffer.from([0, 0, 0, 0]));
          step = 'init';
        } else if (step === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const nm = Buffer.from(name);
          const init = Buffer.alloc(24);
          init.writeUInt16BE(800, 0); init.writeUInt16BE(600, 2);
          init.writeUInt32BE(nm.length, 20);
          sock.write(Buffer.concat([init, nm]));
          step = 'done';
        } else return;
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, auths, set: (c) => { password = c.password || ''; viewOnly = c.viewOnly || ''; }, close: () => new Promise((r) => { for (const c of conns) c.destroy(); server.close(() => r()); }) };
}

/** A page's WebSocket to `url` (ws://...), as noVNC talks: -> {read(n), write(buf), close()} over the RFB bytes. */
export function wsClient(url, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-protocol': 'binary', ...headers } });
    req.on('response', (res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    req.on('error', reject);
    req.on('upgrade', (_res, sock, head) => {
      let raw = head.length ? Buffer.from(head) : Buffer.alloc(0);
      let data = Buffer.alloc(0);
      let want = null;
      let ended = false;
      const check = () => {
        if (!want) return;
        if (data.length >= want.n) { const out = data.subarray(0, want.n); data = data.subarray(want.n); const w = want; want = null; w.resolve(Buffer.from(out)); } else if (ended) { const w = want; want = null; w.reject(new Error('closed')); }
      };
      const parse = () => {
        for (;;) {
          if (raw.length < 2) return;
          let len = raw[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (raw.length < 4) return; len = raw.readUInt16BE(2); off = 4; } else if (len === 127) { if (raw.length < 10) return; len = Number(raw.readBigUInt64BE(2)); off = 10; }
          if (raw.length < off + len) return;
          const op = raw[0] & 0x0f;
          const payload = raw.subarray(off, off + len);
          raw = raw.subarray(off + len);
          if (op === 0x8) { ended = true; check(); return; }
          if (op === 0x2 || op === 0x0 || op === 0x1) data = Buffer.concat([data, payload]);
        }
      };
      sock.on('data', (c) => { raw = Buffer.concat([raw, c]); parse(); check(); });
      sock.on('close', () => { ended = true; check(); });
      sock.on('error', () => {});
      parse();
      resolve({
        read: (n) => new Promise((res, rej) => { want = { n, resolve: res, reject: rej }; check(); }),
        write: (b) => { const mask = crypto.randomBytes(4); const p = Buffer.from(b); for (let i = 0; i < p.length; i += 1) p[i] ^= mask[i & 3]; sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | p.length]), mask, p])); },
        close: () => sock.destroy(),
      });
    });
    req.end();
  });
}

/** What noVNC does up to the desktop's name, answering only "None" (it has no password). -> {types, name} */
export async function pageSession(ws) {
  const version = (await ws.read(12)).toString('latin1');
  ws.write(Buffer.from('RFB 003.008\n'));
  const n = (await ws.read(1))[0];
  const types = [...(await ws.read(n))];
  if (!types.includes(1)) return { version, types, name: '' };
  ws.write(Buffer.from([1]));
  const result = (await ws.read(4)).readUInt32BE(0);
  ws.write(Buffer.from([1])); // ClientInit: shared
  const init = await ws.read(24);
  const name = (await ws.read(init.readUInt32BE(20))).toString();
  return { version, types, result, name };
}

/** The parts that need no hub: DES, the bridge, the check, the setup step. */
export async function vncUnitChecks({ check }) {
  const V = await import('../src/vncauth.mjs');
  const L = await import('../src/localvnc.mjs');
  const { bridgeWebSocket } = await import('../src/wsbridge.mjs');
  check('VNC-1 DES is right (the FIPS textbook vector) and a stored password is what TightVNC keeps (8 bytes under the public VNC key)',
    V.desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex')).toString('hex') === '85e813540f0ab405'
    && V.vncStoredPassword('abcdefgh').length === 8 && !V.vncStoredPassword('abcdefgh').equals(Buffer.from('abcdefgh')));
  const s = V.newVncSecret();
  check('VNC-2 new passwords: three, 8 random characters each, full and view-only differ', [s.password, s.viewOnly, s.control].every((p) => /^[\x21-\x7e]{8}$/.test(p)) && s.password !== s.viewOnly && V.isVncSecret(s));

  const locked = await mockVnc({ password: s.password, viewOnly: s.viewOnly });
  const open = await mockVnc();
  const here = http.createServer();
  let vncFor = null;
  here.on('upgrade', (req, sock, head) => bridgeWebSocket(req, sock, head, { port: locked.port, vnc: vncFor }));
  await new Promise((r) => here.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${here.address().port}/ws`;
  try {
    check('VNC-3 checkVncAuth: a server that wants a password and gets it is "ok"; without it "wrong"; one that asks none is "open"',
      (await L.checkVncAuth(locked.port, s.password)) === 'ok' && (await L.checkVncAuth(locked.port, '')) === 'wrong' && (await L.checkVncAuth(locked.port, 'nottheone')) === 'wrong' && (await L.checkVncAuth(open.port, '')) === 'open');
    vncFor = { password: s.password };
    const full = await pageSession(await wsClient(url));
    check('VNC-4 through the hub\'s bridge the page is offered only "None", reaches the desktop, and never holds the password; the hub signed in with the full password',
      full.types.join() === '1' && full.result === 0 && full.name === 'mock-console' && locked.auths.at(-1)?.as === 'full', JSON.stringify({ full, auth: locked.auths.at(-1) }));
    vncFor = { password: s.viewOnly };
    const view = await pageSession(await wsClient(url));
    check('VNC-5 a view-only policy signs in with the view-only password (the VNC server itself then ignores input)', view.name === 'mock-console' && locked.auths.at(-1)?.as === 'view');
    vncFor = null;
    const raw = await pageSession(await wsClient(url));
    check('VNC-6 without the hub\'s password the page would be asked for one (VNC authentication): what a program on the machine meets at 5900', raw.types.join() === '2' && !raw.name);
    vncFor = { password: 'wrongpw1' };
    const wrong = await wsClient(url).then(() => 'opened', (e) => e.status || e.message);
    check('VNC-7 a wrong password in the hub: the upgrade is refused (502), the page is not left waiting', wrong === 502, String(wrong));
  } finally {
    here.closeAllConnections();
    here.close();
    await locked.close();
    await open.close();
  }

  // secureTightVnc with the registry and the restart stood in for: passwords made once, kept, the key locked for the service.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vnc-secure-'));
  const server = await mockVnc(); // as found: no password
  const key = crypto.randomBytes(32);
  const readBack = () => L.readVncSecret(dir, { key });
  let envSeen = null;
  let runs = 0;
  const runPs = (script, env) => { runs += 1; envSeen = env; return script.includes('Set-Acl') ? 'DESK_VNC_OK' : ''; };
  const restart = async () => server.set(readBack()); // the service restarts with what the registry now says
  try {
    const first = await L.secureTightVnc({ dataDir: dir, service: true, key, port: server.port, runPs, restart, trusted: () => 'trusted' });
    const secret = readBack();
    const fileText = fsSync.readFileSync(path.join(dir, L.SECRET_FILE), 'utf8');
    check('VNC-8 a machine found without a password gets one: made once, kept sealed in the data folder (no password in the file text), written to the service key locked to SYSTEM and Administrators, and signed in with',
      first.state === 'secured' && V.isVncSecret(secret) && !fileText.includes(secret.password) && /lamplitSealed/.test(fileText)
      && envSeen?.DESK_VNC_LOCK === '1' && /HKLM/.test(envSeen?.DESK_VNC_KEY || '') && envSeen.DESK_VNC_PW === V.vncStoredPassword(secret.password).toString('hex')
      && L.REGISTRY_SCRIPT.includes("'S-1-5-18', 'S-1-5-32-544'") && L.REGISTRY_SCRIPT.includes('SetAccessRuleProtection($true, $false)'),
      JSON.stringify({ first: first.state, why: first.reason, runs, lock: envSeen?.DESK_VNC_LOCK }));
    const again = await L.secureTightVnc({ dataDir: dir, service: true, key, port: server.port, runPs, restart, trusted: () => 'trusted' });
    check('VNC-9 at the next start (the passwords already in force) nothing is rewritten and nothing restarts', again.state === 'secured' && runs === 1 && readBack().password === secret.password, JSON.stringify({ again: again.state, runs }));
  } finally {
    await server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const setup = (await fsp.readFile(path.join(REPO, 'hub', 'setup-windows.ps1'), 'utf8')).replace(/\r\n/g, '\n');
  const localSrc = (await fsp.readFile(path.join(REPO, 'src', 'localvnc.mjs'), 'utf8')).replace(/\r\n/g, '\n');
  const winrunner = await import('../src/winrunner.mjs');
  check('VNC-10 installs never turn the password off again: the MSI and the settings enforced at every setup require it, so does this computer\'s own TightVNC; no password on a command line',
    setup.includes("'VALUE_OF_USEVNCAUTHENTICATION=1'") && !/VALUE_OF_USEVNCAUTHENTICATION=0|'UseVncAuthentication', 0/.test(setup) && setup.includes("@('UseVncAuthentication', 1), @('UseControlAuthentication', 1)")
    && !/VALUE_OF_(PASSWORD|VIEWONLYPASSWORD|CONTROLPASSWORD)=/.test(setup) && /\['UseVncAuthentication', 1\], \['UseControlAuthentication', 1\]/.test(localSrc));
  check('VNC-11 the bots\' account cannot read the passwords: the data folder is denied to it whole, the file itself only for SYSTEM, Administrators and the hub\'s account',
    winrunner.deniedDirs({ execPath: 'C:\\x\\node.exe', root: 'C:\\app', dataDir: 'C:\\app\\data' }).some((d) => d.path === 'C:\\app\\data' && d.full)
    && localSrc.includes("'/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F'"));
}

/** End to end through a real hub: its screen socket signs in for the page; 体检 says how the screen stands. */
export async function vncHubChecks({ check, serverPath = path.join(REPO, 'src', 'server.mjs'), label = '' } = {}) {
  if (process.platform !== 'win32') { console.log('SKIP  VNC-E2E (the hub uses TightVNC on Windows only)'); return; }
  const V = await import('../src/vncauth.mjs');
  const secret = V.newVncSecret();
  const mock = await mockVnc({ password: secret.password, viewOnly: secret.viewOnly });
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'vnc-hub-'));
  for (const d of ['config', 'skills', 'public']) await fsp.cp(path.join(REPO, d), path.join(home, d), { recursive: true });
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  await fsp.writeFile(path.join(home, 'data', 'tightvnc.json'), JSON.stringify(secret));
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, ASSIST_HOME: home, ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'), PORT: '0', DESK_VNC_PORT: String(mock.port), DESK_SCREEN_WATCH: '0', DESK_CLI_WATCH: '0', DESK_VNC_SECURE: '0', ASSIST_TEST: '1', DESK_VNC_TRUST_PATH: process.execPath, ASSIST_MODEL_PROVIDER: 'mock', ASSIST_MASTER_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    const ready = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('hub did not start')), 30000);
      proc.stdout.on('data', (c) => { out += c; for (const l of out.split('\n')) { try { const j = JSON.parse(l); if (j.event === 'ready') { clearTimeout(t); resolve(j); } } catch { /* partial */ } } });
      proc.on('exit', (c) => reject(new Error(`hub exited ${c}`)));
    });
    const base = `http://127.0.0.1:${ready.port}`;
    const key = fsSync.readFileSync(path.join(home, 'data', 'local-key'), 'utf8').trim();
    await new Promise((r) => setTimeout(r, 1500)); // the hub's first look at the screen port
    const page = await pageSession(await wsClient(`ws://127.0.0.1:${ready.port}/api/bots/chief/desktop/ws`, { origin: base, 'x-lamplit-local': key }));
    check(`VNC-E2E-1${label} the screen panel and 接管桌面 (the hub's own socket, also what relay, direct and another machine's hub reach) get the screen with no password asked; the hub signed in`,
      page.types.join() === '1' && page.name === 'mock-console' && mock.auths.at(-1)?.as === 'full', JSON.stringify({ types: page.types, name: page.name, auth: mock.auths.at(-1) }));
    if (!label) {
      const up = await fetch(`${base}/api/policy`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-lamplit-local': key }, body: JSON.stringify({ takeover: 'view' }) });
      const view = await pageSession(await wsClient(`ws://127.0.0.1:${ready.port}/api/bots/chief/desktop/ws`, { origin: base, 'x-lamplit-local': key }));
      check('VNC-E2E-2 with 接管 set to view-only, the hub signs in with the view-only password', up.status === 200 && view.name === 'mock-console' && mock.auths.at(-1)?.as === 'view', JSON.stringify(mock.auths.at(-1)));
      const items = (await (await fetch(`${base}/api/checkup`, { headers: { 'x-lamplit-local': key } })).json()).items || [];
      const item = items.find((i) => i.id === 'vnc');
      check('VNC-E2E-3 体检 says the screen has a password', item?.state === 'ok', JSON.stringify(item));
      // 1.5.61 (F9): the secret as Lamplit would have kept it (this test writes it directly, so it notes it too).
      const stale = JSON.stringify(V.newVncSecret());
      await fsp.writeFile(path.join(home, 'data', 'tightvnc.json'), stale);
      { const tf = path.join(home, 'data', 'trust.json'); const note = JSON.parse(fsSync.readFileSync(tf, 'utf8')); note.hashes['tightvnc.json'] = [crypto.createHash('sha256').update(stale).digest('hex')]; fsSync.writeFileSync(tf, JSON.stringify(note)); }
      const wrong = (await (await fetch(`${base}/api/checkup`, { headers: { 'x-lamplit-local': key } })).json()).items?.find((i) => i.id === 'vnc');
      check('VNC-E2E-4 体检 says so when the screen does not take Lamplit\'s password, with the one-click 「设好密码」', wrong?.state === 'warn' && wrong?.action?.kind === 'vnc', JSON.stringify(wrong));
      const program = await wsClient(`ws://127.0.0.1:${ready.port}/api/bots/chief/desktop/ws`, { origin: base }).then(() => 'opened', (e) => e.status);
      const fix = await fetch(`${base}/api/desktop/secure-vnc`, { method: 'POST' });
      check('VNC-E2E-5 a program on the machine gets neither the screen socket nor the fix route without the key', program === 403 && fix.status === 403, `${program} ${fix.status}`);
    }
  } finally {
    proc.kill();
    await mock.close();
    await new Promise((r) => setTimeout(r, 500));
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

// Alone: the end-to-end part against any checkout's server (to see the code before 1.5.53 fail it).
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const at = process.argv.indexOf('--server');
  const serverPath = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(REPO, 'src', 'server.mjs');
  let failed = 0;
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`); if (!ok) failed += 1; return ok; };
  await vncHubChecks({ check, serverPath, label: ` (${path.relative(process.cwd(), serverPath) || serverPath})` });
  process.exit(failed ? 1 : 0);
}
