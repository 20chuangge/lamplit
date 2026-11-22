/**
 * smoke-secv1560.mjs - the verifier's attacks after 1.5.59 (sec-verify-1553's smoke-secv1559.mjs,
 * section 十一 of its report), folded into the smoke suite in 1.5.60.
 *
 *   writeChecks   V3-V6: the writes by name (F1) and the sandbox's /proc (F5) - in the smoke now.
 *   verifyChecks  all of them; V1 and V2 (the folder removal and .trash, F2-F4 in trash.mjs)
 *                 join the smoke with those fixes.
 *
 *   V1  (Linux; Windows with junctions) folder removal: the folder is taken out through the
 *       held-open folder, but then removed by Node's recursive rm by path. rm lstat()s a
 *       child, then readdir()s / lstat()s its entries by path: a child flipped to a link to
 *       the data folder in between leads the hub's rm into the data folder.
 *   V2  (Linux) .trash made a link to the data folder before a folder delete: refused, and
 *       nothing made in the data folder, the folder back under its own name.
 *   V3  (both, needs Chromium) browser_screenshot / browser_download check the path by name
 *       only (resolveInWorkspace): a folder on the way that is a link writes into the data folder.
 *   V4  (both) bringFilesBack (files a bot on another machine names in its answer) writes
 *       by name into from-machines/<machine>/<day>: that folder a link -> into the data folder.
 *   V5  (both) an MCP image result lands in mcp/<day>: that folder a link -> into the data folder.
 *
 * Each case runs in its own child program (P.* come from the environment at import).
 *   node scripts/smoke-secv1559.mjs            all cases, PASS / FAIL lines, exit 1 on a FAIL
 *   SECV_N=300 SECV_FILL=2000                  rounds and filler files for V1
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'SECRET-FROM-THE-DATA-FOLDER';
const kind = process.platform === 'win32' ? 'junction' : 'dir';
const linkAt = (at, to) => fs.symlinkSync(to, at, kind);
const dropLink = (p) => { try { fs.rmdirSync(p); } catch { try { fs.unlinkSync(p); } catch { /* gone */ } } };

/** Links by themselves, then the rest (never into what a link leads to). */
function dropTestFolder(dir) {
  const walk = (p) => {
    let es = [];
    try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const q = path.join(p, e.name);
      let st = null;
      try { st = fs.lstatSync(q); } catch { continue; }
      if (st.isSymbolicLink()) dropLink(q); else if (st.isDirectory()) walk(q);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

const dataNames = (data) => fs.readdirSync(data).filter((n) => n !== 'undo' && n !== 'browser-profile').sort();

// ---------------------------------------------------------------- V1
async function v1(T) {
  const { removeFolderInside, _test } = await import('../src/trash.mjs');
  _test.setFence(null); // the bots' own account on Windows is not there in a test: the hub's own rename
  const { spawn } = await import('node:child_process');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  const N = Number(process.env.SECV_N || 120);
  const FILL = Number(process.env.SECV_FILL || 800);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  // The flipper: every folder in ws/d (the folder itself, or its random name once taken out) gets
  // its child x flipped between the real folder and a link to the data folder.
  const code = `
    const fs = require('fs'), path = require('path');
    const [d, data, kind] = process.argv.slice(1);
    for (;;) {
      let names = [];
      try { names = fs.readdirSync(d); } catch {}
      for (const n of names) {
        const x = path.join(d, n, 'x'), hold = path.join(d, n, 'x_hold');
        try {
          if (fs.lstatSync(x).isSymbolicLink()) { try { fs.rmdirSync(x); } catch { fs.unlinkSync(x); } fs.renameSync(hold, x); }
          else { fs.renameSync(x, hold); fs.symlinkSync(data, x, kind); }
        } catch {}
      }
    }`;
  let hits = 0;
  let errors = 0;
  for (let i = 0; i < N; i += 1) {
    const d = path.join(ws, 'd');
    if (fs.existsSync(d)) dropTestFolder(d);
    fs.mkdirSync(path.join(d, 'sub', 'x'), { recursive: true });
    // In x: the data folder's names (as a bot can learn them from the source) and many others, so rm takes its time.
    fs.writeFileSync(path.join(d, 'sub', 'x', 'note.txt'), 'harmless');
    fs.writeFileSync(path.join(d, 'sub', 'x', 'bots.json'), 'harmless');
    for (let k = 0; k < FILL; k += 1) fs.writeFileSync(path.join(d, 'sub', 'x', `f${k}`), '');
    fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
    fs.writeFileSync(path.join(data, 'bots.json'), SECRET);
    const flipper = spawn(process.execPath, ['-e', code, d, data, kind], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 30));
    try { await removeFolderInside(ws, path.join(d, 'sub')); } catch { errors += 1; }
    flipper.kill();
    await new Promise((r) => flipper.once('exit', r));
    const lost = ['note.txt', 'bots.json'].filter((n) => { try { return fs.readFileSync(path.join(data, n), 'utf8') !== SECRET; } catch { return true; } });
    if (lost.length) hits += 1;
  }
  dropTestFolder(ws);
  return { rounds: N, roundsWithDataFilesDeleted: hits, refused: errors };
}

// ---------------------------------------------------------------- V2
async function v2(T) {
  const { createRegistry } = await import('../src/tools.mjs');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(path.join(ws, 'd2'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'd2', 'a.txt'), 'harmless');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
  linkAt(path.join(ws, '.trash'), data);
  const before = dataNames(data);
  const reg = createRegistry({});
  let said = 'done';
  try { await reg.get('fs_delete').run({ path: 'd2', recursive: true }, { workspaceDir: ws, botId: 'bot1', bot: { id: 'bot1' } }); } catch (err) { said = err.code || err.message; }
  const after = dataNames(data);
  const out = { said, madeInData: after.filter((n) => !before.includes(n)), d2Back: fs.existsSync(path.join(ws, 'd2', 'a.txt')), leftUnderRandomName: fs.readdirSync(ws).filter((n) => n.startsWith('.lamplit-out-')) };
  dropTestFolder(ws);
  return out;
}

// ---------------------------------------------------------------- V3
async function v3(T) {
  const { createRegistry } = await import('../src/tools.mjs');
  const browserMod = await import('../src/browser.mjs');
  if (!browserMod.detectBrowserExecutable().path) return { skipped: 'no Chromium-based browser here' };
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const EVIL = JSON.stringify([{ id: 'evil', name: 'evil', transport: 'stdio', command: 'sh', args: ['-c', 'echo pwned'] }]);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/mcp.json')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="mcp.json"' }); res.end(EVIL); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>t</title><p>page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const reg = createRegistry({});
  const ctx = { workspaceDir: ws, botId: 'bot1', bot: { id: 'bot1' } };
  const call = async (name, args = {}) => { try { return await reg.get(name).run(args, ctx); } catch (err) { return { ok: false, error: { code: err.code, message: err.message } }; } };
  const out = {};
  try {
    linkAt(path.join(ws, 'd'), data);
    await call('browser_open', { url: `${origin}/` });
    const shot = await call('browser_screenshot', { path: 'd/shot.png' });
    out.screenshot = { ok: shot.ok, code: shot.error?.code, inData: fs.existsSync(path.join(data, 'shot.png')) };
    const dl = await call('browser_download', { url: `${origin}/mcp.json`, path: 'd/mcp.json' });
    out.downloadPath = { ok: dl.ok, code: dl.error?.code, inData: fs.existsSync(path.join(data, 'mcp.json')) && fs.readFileSync(path.join(data, 'mcp.json'), 'utf8') === EVIL };
    try { fs.rmSync(path.join(data, 'mcp.json'), { force: true }); } catch { /* none */ }
    // downloads itself a link: Chrome writes straight into it.
    fs.rmSync(path.join(ws, 'downloads'), { recursive: true, force: true });
    linkAt(path.join(ws, 'downloads'), data);
    const dl2 = await call('browser_download', { url: `${origin}/mcp.json?2` });
    out.downloadsFolder = { ok: dl2.ok, code: dl2.error?.code, inData: fs.existsSync(path.join(data, 'mcp.json')) };
  } finally {
    await call('browser_close');
    server.close();
  }
  dropTestFolder(ws);
  return out;
}

// ---------------------------------------------------------------- V4, V5
async function v45(T) {
  const { bringFilesBack } = await import('../src/crossmachine.mjs');
  const { toolResultForBot } = await import('../src/mcp.mjs');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ws, 'from-machines', 'B'), { recursive: true });
  linkAt(path.join(ws, 'from-machines', 'B', day), data);
  fs.mkdirSync(path.join(ws, 'mcp'), { recursive: true });
  linkAt(path.join(ws, 'mcp', day), data);
  const before = dataNames(data);
  const peers = { call: async () => new Response('[{"id":"evil","transport":"stdio","command":"sh"}]') };
  let fetched = [];
  try { fetched = await bringFilesBack(peers, { name: 'B' }, '结果在 out/mcp.json 里', ws); } catch { /* refused */ }
  const v4 = { fetched, inData: fs.existsSync(path.join(data, 'mcp.json')) };
  try { await toolResultForBot({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] }, { workspaceDir: ws, serverId: 'x' }); } catch { /* refused */ }
  const v5 = { madeInData: dataNames(data).filter((n) => !before.includes(n) && n !== 'mcp.json') };
  dropTestFolder(ws);
  return { v4, v5 };
}

// ---------------------------------------------------------------- V6 (Linux, bwrap)
// The sandbox hides the data folder with a tmpfs, but mounts a /proc of the hub's own pid
// namespace (no --unshare-pid) as the same user: /proc/<hub pid>/root is the hub's root.
async function v6(T) {
  const { bwrapArgs } = await import('../src/sandbox.mjs');
  const ws = path.join(T, 'ws');
  const data = process.env.ASSIST_DATA_DIR;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
  if (spawnSync('bwrap', ['--version']).status !== 0) return { skipped: 'no bwrap here' };
  const args = bwrapArgs({ mode: 'strict', root: '', dataDir: data, workspaceDir: ws, folders: [] });
  const sh = (cmd) => spawnSync('bwrap', [...args, '--', '/bin/sh', '-c', cmd], { encoding: 'utf8', timeout: 20000 });
  const direct = sh(`cat '${data}/note.txt' 2>&1`);
  if (direct.status !== 0 && /bwrap:/.test(direct.stdout + direct.stderr)) return { skipped: `bwrap does not start here: ${(direct.stdout + direct.stderr).slice(0, 200)}` };
  const viaRoot = sh(`cat '/proc/${process.pid}/root${data}/note.txt' 2>&1`);
  const viaFd = sh(`for f in /proc/${process.pid}/fd/*; do :; done; ls /proc/${process.pid}/ >/dev/null 2>&1 && echo SEES-HUB`);
  dropTestFolder(ws);
  return { direct: direct.stdout.includes(SECRET), viaProcRoot: viaRoot.stdout.includes(SECRET), seesHubProcess: viaFd.stdout.includes('SEES-HUB') };
}

const CASES = { v1, v2, v3, v45, v6 };

export async function verifyChecks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  const me = fileURLToPath(import.meta.url);
  const run = (name) => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), `secv1559-${name}-`));
    try {
      const r = spawnSync(process.execPath, [me, '--case', name, T], {
        env: { ...process.env, ASSIST_HOME: T, ASSIST_DATA_DIR: path.join(T, 'data'), ASSIST_WORKSPACE_DIR: path.join(T, 'ws'), ASSIST_MASTER_KEY: '', BROWSER_HEADLESS: '1', ALLOW_PRIVATE: '1' },
        encoding: 'utf8', timeout: 600000,
      });
      try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
    } finally { for (let i = 0; i < 20; i += 1) { try { dropTestFolder(T); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } } }
  };
  const r1 = run('v1');
  check('SECV-1 a folder removed while a folder inside it flips to a link to the data folder: no data file is deleted (the recursive rm after the take-out goes by path)', r1.roundsWithDataFilesDeleted === 0, JSON.stringify(r1));
  if (process.platform === 'linux') {
    const r2 = run('v2');
    check('SECV-2 Linux: .trash a link to the data folder: the folder delete is refused, nothing is made in the data folder, the folder is back under its name', r2.said !== 'done' && r2.madeInData.length === 0 && r2.d2Back && r2.leftUnderRandomName.length === 0, JSON.stringify(r2));
  } else skip('SECV-2', 'Linux only: on Windows that move goes through the bots\' account');
  const r3 = run('v3');
  if (r3.skipped) skip('SECV-3', r3.skipped);
  else {
    check('SECV-3a browser_screenshot into a folder that is a link to the data folder writes nothing there', !r3.screenshot?.inData, JSON.stringify(r3.screenshot));
    check('SECV-3b browser_download with a path through such a folder writes nothing there (mcp.json would be a command the hub runs)', !r3.downloadPath?.inData, JSON.stringify(r3.downloadPath));
    check('SECV-3c browser_download with workspace/downloads itself a link: nothing lands in the data folder', !r3.downloadsFolder?.inData, JSON.stringify(r3.downloadsFolder));
  }
  const r45 = run('v45');
  check('SECV-4 files brought back from another machine into from-machines/<machine>/<day> that is a link: nothing written in the data folder', r45.v4 && !r45.v4.inData, JSON.stringify(r45));
  check('SECV-5 an MCP image saved into mcp/<day> that is a link: nothing written in the data folder', r45.v5 && r45.v5.madeInData.length === 0, JSON.stringify(r45));
  sandboxCheck({ check, skip, run });
}

/** V6: on CI (bubblewrap installed there, see ci.yml) it must run; elsewhere a machine without bwrap skips it. */
function sandboxCheck({ check, skip, run }) {
  if (process.platform === 'linux') {
    const r6 = run('v6');
    if (r6.skipped && process.env.CI) check('SECV-6 Linux (CI): the bots\' sandbox starts here, so the next check runs', false, r6.skipped);
    else if (r6.skipped) skip('SECV-6', r6.skipped);
    else check('SECV-6 Linux: a command in the bots\' sandbox reads the data folder neither directly nor through /proc/<hub pid>/root, and does not see the hub\'s process', !r6.direct && !r6.viaProcRoot && !r6.seesHubProcess, JSON.stringify(r6));
  } else skip('SECV-6', 'Linux only (bwrap)');
}

/** The smoke points CHROME_PATH at a browser that is not there (so no test starts the real one by chance); V3 needs the real one, as the smoke's own browser stage does. */
function childEnvFor() {
  const env = { ...process.env };
  if (/no-such-browser/.test(env.CHROME_PATH || '')) delete env.CHROME_PATH;
  return env;
}

/** The cases this smoke runs now (1.5.60): V3, V4, V5 (writes by name, F1) and V6 (the sandbox's /proc, F5). */
export async function writeChecks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  const me = fileURLToPath(import.meta.url);
  const run = (name) => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), `secv1560-${name}-`));
    try {
      const r = spawnSync(process.execPath, [me, '--case', name, T], {
        env: { ...childEnvFor(), ASSIST_HOME: T, ASSIST_DATA_DIR: path.join(T, 'data'), ASSIST_WORKSPACE_DIR: path.join(T, 'ws'), ASSIST_MASTER_KEY: '', BROWSER_HEADLESS: '1', ALLOW_PRIVATE: '1' },
        encoding: 'utf8', timeout: 600000,
      });
      try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
    } finally { for (let i = 0; i < 20; i += 1) { try { dropTestFolder(T); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } } }
  };
  const r3 = run('v3');
  if (r3.skipped) skip('SECV-3', r3.skipped);
  else {
    check('SECV-3a browser_screenshot into a folder that is a link to the data folder writes nothing there', r3.screenshot && !r3.screenshot.inData, JSON.stringify(r3));
    check('SECV-3b browser_download with a path through such a folder writes nothing there (mcp.json would be a command the hub runs)', r3.downloadPath && !r3.downloadPath.inData, JSON.stringify(r3));
    check('SECV-3c browser_download with workspace/downloads itself a link: nothing lands in the data folder', r3.downloadsFolder && !r3.downloadsFolder.inData, JSON.stringify(r3));
  }
  const r45 = run('v45');
  check('SECV-4 files brought back from another machine into from-machines/<machine>/<day> that is a link: nothing written in the data folder', r45.v4 && !r45.v4.inData, JSON.stringify(r45));
  check('SECV-5 an MCP image saved into mcp/<day> that is a link: nothing written in the data folder', r45.v5 && r45.v5.madeInData.length === 0, JSON.stringify(r45));
  sandboxCheck({ check, skip, run });
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

/** V1, V2 (the folder removal and .trash: F2-F4 in trash.mjs): Linux, on CI. On Windows those moves and removals are the bots' account's (SEC-R2/R3, SEC-F2). */
export async function trashVerifyChecks({ check, skip = (n, why) => console.log(`SKIP  ${n} (${why})`) }) {
  if (process.platform !== 'linux') { skip('SECV-1, SECV-2', 'Linux only here: on Windows the bots\' account does these moves and removals'); return; }
  const me = fileURLToPath(import.meta.url);
  const run = (name) => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), `secv1560-${name}-`));
    try {
      const r = spawnSync(process.execPath, [me, '--case', name, T], { env: { ...process.env, ASSIST_HOME: T, ASSIST_DATA_DIR: path.join(T, 'data'), ASSIST_WORKSPACE_DIR: path.join(T, 'ws'), ASSIST_MASTER_KEY: '' }, encoding: 'utf8', timeout: 600000 });
      try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { failedToRun: `${r.stdout}${r.stderr}`.slice(-800) }; }
    } finally { dropTestFolder(T); }
  };
  const r1 = run('v1');
  check('SECV-1 a folder removed while a folder inside it flips to a link to the data folder: no data file is deleted', r1.roundsWithDataFilesDeleted === 0, JSON.stringify(r1));
  const r2 = run('v2');
  check('SECV-2 Linux: .trash a link to the data folder: the folder delete is refused, nothing is made in the data folder, the folder is back under its name', r2.said !== 'done' && r2.madeInData?.length === 0 && r2.d2Back && r2.leftUnderRandomName?.length === 0, JSON.stringify(r2));
}
