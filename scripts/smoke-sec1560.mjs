/**
 * smoke-sec1560.mjs - 1.5.60 security batch, from sec-verify-1553's section 十一.
 *
 *   F1  writes into the workspace by name with only a lexical check: a folder on the way (or the
 *       file's own name) that is a link to the data folder put the file there - a page's mcp.json,
 *       whose commands the hub runs at its next start. Now: folders made one level at a time and
 *       checked (mkdirInside), files written and copied through the checked open (saveInside,
 *       copyInside), downloads staged in a hub-only folder and copied in. The verifier's own
 *       attacks are in smoke-secv1560.mjs (SECV-3..5); here the pieces and the server's routes.
 *   F5  the bots' sandbox gets its own pid namespace (SECV-6 runs it for real on Linux CI).
 *   F6  with a master key, a plain copy of a key file whose name the key already covers is refused.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'SECRET-FROM-THE-DATA-FOLDER';
const kind = process.platform === 'win32' ? 'junction' : 'dir';
const linkAt = (at, to) => fs.symlinkSync(to, at, kind);

/** Links by themselves, then the rest (never into what a link leads to). */
function dropTestFolder(dir) {
  const walk = (p) => {
    let es = [];
    try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const q = path.join(p, e.name);
      let st = null;
      try { st = fs.lstatSync(q); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.rmdirSync(q); } catch { try { fs.unlinkSync(q); } catch { /* left */ } } } else if (st.isDirectory()) walk(q);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

const codeOf = (p) => p.then(() => 'done', (e) => e.code || e.message);

/** F1: the checked folder-making, saving and copying. */
export async function fsChecks({ check }) {
  const S = await import('../src/safefs.mjs');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1560-fs-'));
  try {
    const ws = path.join(T, 'ws');
    const data = path.join(T, 'data');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'mcp.json'), SECRET);
    linkAt(path.join(ws, 'j'), data);
    const dataNames = () => fs.readdirSync(data).sort().join();
    const before = dataNames();

    const deep = await codeOf(S.mkdirInside(ws, path.join(ws, 'j', 'a', 'b')));
    fs.mkdirSync(path.join(ws, 'real', 'in'), { recursive: true });
    linkAt(path.join(ws, 'inner'), path.join(ws, 'real'));
    const inner = await codeOf(S.mkdirInside(ws, path.join(ws, 'inner', 'x', 'y')));
    const plain = await codeOf(S.mkdirInside(ws, path.join(ws, 'p', 'q', 'r')));
    check('SEC-F1a folders are made one level at a time: a level that is a link to outside is refused and nothing is made there; a link that stays inside, and plain folders, are fine',
      deep === 'PATH_OUTSIDE_WORKSPACE' && dataNames() === before && inner === 'done' && fs.existsSync(path.join(ws, 'real', 'x', 'y')) && plain === 'done' && fs.statSync(path.join(ws, 'p', 'q', 'r')).isDirectory(),
      JSON.stringify({ deep, inner, plain, data: dataNames() }));

    const over = await codeOf(S.saveInside(ws, path.join(ws, 'j', 'mcp.json'), '[{"command":"evil"}]'));
    const fresh = await codeOf(S.saveInside(ws, path.join(ws, 'j', 'new.json'), 'x'));
    const fine = await codeOf(S.saveInside(ws, path.join(ws, 'out', 'day', 'a.txt'), 'hello'));
    check('SEC-F1b a save through such a folder neither replaces a data file (mcp.json) nor makes a new one there; a save into the workspace works',
      over === 'PATH_OUTSIDE_WORKSPACE' && fresh === 'PATH_OUTSIDE_WORKSPACE' && fs.readFileSync(path.join(data, 'mcp.json'), 'utf8') === SECRET && dataNames() === before
      && fine === 'done' && fs.readFileSync(path.join(ws, 'out', 'day', 'a.txt'), 'utf8') === 'hello', JSON.stringify({ over, fresh, fine }));

    const staged = path.join(T, 'staged.bin');
    fs.writeFileSync(staged, Buffer.alloc(300000, 7));
    const copyOut = await codeOf(S.copyInside(ws, staged, path.join(ws, 'j', 'mcp.json')));
    const copyIn = await S.copyInside(ws, staged, path.join(ws, 'downloads', 'big.bin')).catch((e) => e.code);
    check('SEC-F1c a copy into the workspace (how a download arrives now) streams through the checked open: into the workspace it works, through a link to outside it is refused',
      copyOut === 'PATH_OUTSIDE_WORKSPACE' && fs.readFileSync(path.join(data, 'mcp.json'), 'utf8') === SECRET && copyIn === 300000 && fs.statSync(path.join(ws, 'downloads', 'big.bin')).size === 300000,
      JSON.stringify({ copyOut, copyIn }));
  } finally {
    dropTestFolder(T);
  }
}

/** F1 at the server: files another machine puts here, and uploads. */
export async function routeChecks({ check, apiRaw, workspace }) {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1560-outside-'));
  const made = [];
  try {
    fs.writeFileSync(path.join(outside, 'mcp.json'), SECRET);
    const link = path.join(workspace, 'sec1560-link');
    linkAt(link, outside);
    made.push(link);
    const put = (rel, body) => apiRaw(`/api/workspace/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: Buffer.from(body), contentType: 'application/octet-stream' });
    const over = await put('sec1560-link/mcp.json', '[{"command":"evil"}]');
    const fresh = await put('sec1560-link/sub/new.json', 'x');
    const ok = await put('sec1560-put/a.txt', 'hello');
    check('SEC-F1d PUT /api/workspace/file (another machine\'s file) through a link to outside: refused, nothing there replaced or made; into the workspace it works',
      over.status === 400 && fresh.status === 400 && fs.readFileSync(path.join(outside, 'mcp.json'), 'utf8') === SECRET && fs.readdirSync(outside).join() === 'mcp.json'
      && ok.status === 200 && fs.readFileSync(path.join(workspace, 'sec1560-put', 'a.txt'), 'utf8') === 'hello',
      JSON.stringify({ over: over.status, fresh: fresh.status, ok: ok.status, outside: fs.readdirSync(outside) }));

    // A name taken by a link that leads nowhere is not "free": the new name is checked too.
    let dangling = 'skipped';
    try {
      fs.writeFileSync(path.join(workspace, 'sec1560-put', 'b.txt'), 'theirs');
      fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(workspace, 'sec1560-put', 'b（来自 X）.txt'), 'file');
      const again = await apiRaw(`/api/workspace/file?path=${encodeURIComponent('sec1560-put/b.txt')}&from=X`, { method: 'PUT', body: Buffer.from('mine'), contentType: 'application/octet-stream' });
      dangling = { status: again.status, path: again.json?.path, planted: fs.existsSync(path.join(outside, 'planted.txt')) };
    } catch (err) { dangling = `skipped (${err.code})`; }
    if (typeof dangling === 'string') console.log(`SKIP  SEC-F1e (this account may not make file links: ${dangling})`);
    else {
      check('SEC-F1e PUT /api/workspace/file: when the "(来自 …)" name is a planted link to outside, another name is taken and nothing is written where the link leads',
        dangling.status === 200 && !dangling.planted && /b（来自 X-2）\.txt$/.test(dangling.path || ''), JSON.stringify(dangling));
    }

    // uploads/<day> a link to outside.
    const day = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(workspace, 'uploads', day);
    const aside = `${dayDir}-sec1560-aside`;
    const had = fs.existsSync(dayDir);
    if (had) fs.renameSync(dayDir, aside);
    fs.mkdirSync(path.join(workspace, 'uploads'), { recursive: true });
    linkAt(dayDir, outside);
    let up;
    try {
      up = await apiRaw('/api/uploads', { method: 'POST', body: Buffer.from('[{"command":"evil"}]'), contentType: 'application/octet-stream' });
    } finally {
      try { fs.rmdirSync(dayDir); } catch { fs.unlinkSync(dayDir); }
      if (had) fs.renameSync(aside, dayDir);
    }
    check('SEC-F1f an upload while uploads/<day> is a link to outside: refused, nothing written there',
      up.status === 400 && fs.readdirSync(outside).join() === 'mcp.json', JSON.stringify({ status: up.status, outside: fs.readdirSync(outside) }));
  } finally {
    for (const l of made) { try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch { /* gone */ } } }
    fs.rmSync(path.join(workspace, 'sec1560-put'), { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

/** F1 everywhere else that saves into the workspace: through the checked helpers, not by name. */
export async function siteChecks({ check, readText }) {
  const sites = {
    'browser.mjs': ['await saveInside(workspaceDir, target.abs, buffer);', 'await copyInside(workspaceDir, source, target.abs);', "return errorResult('DOWNLOAD_FOLDER_LINK'", "path.join(P.dataDir, 'browser-downloads'"],
    'crossmachine.mjs': ['await saveInside(workspaceDir, path.join(workspaceDir, to), bytes);', 'const bytes = await readInside(workspaceDir, abs);'],
    'mail.mjs': ['await saveInside(workspaceDir, path.join(workspaceDir, dir, safe), a.data);'],
    'phone.mjs': ['await saveInside(workspaceDir, abs, bytes);'],
    'mcp.mjs': ["await saveInside(workspaceDir, path.join(workspaceDir, rel), Buffer.from(c.data, 'base64'));"],
    'media.mjs': ['await saveInside(workspaceDir, path.join(workspaceDir, rel), bytes);'],
    'pages.mjs': ['await saveInside(workspaceDir, file, body);', 'await saveInside(workspaceDir, metaFile,'],
    'cliagents.mjs': ['await mkdirInside(workspaceDir, dir);', 'fs.createWriteStream(logFile, { fd: await openWriteInside(workspaceDir, logFile) })'],
    'feishu.mjs': ['await saveInside(o.workspaceDir, path.join(o.workspaceDir, rel), bytes);'],
    'tools.mjs': ['if (r.named) await mkdirInside(ctx.workspaceDir, path.dirname(r.abs))', 'if (r.named) await mkdirInside(ctx.workspaceDir, r.abs)', 'await mkdirInside(ctx.workspaceDir, path.dirname(dest.abs)); await writeInside(ctx.workspaceDir, dest.abs, bytes);'],
    'server.mjs': ['await mkdirInside(state.workspaceDir, dir)', 'await writeInside(state.workspaceDir, path.join(dir, candidate), bytes)', 'await writeInside(state.workspaceDir, target, bytes)', 'const old = await readInside(state.workspaceDir, abs)'],
  };
  const missing = [];
  for (const [file, needles] of Object.entries(sites)) {
    const src = await readText(`../src/${file}`);
    for (const n of needles) if (!src.includes(n)) missing.push(`${file}: ${n}`);
  }
  const browser = await readText('../src/browser.mjs');
  check('SEC-F1g every other save into the workspace goes through the checked helpers: browser screenshot and download (staged in the data folder, copied in, a downloads link refused), files from other machines (both ways), mail attachments, the phone\'s screenshot, MCP images, generated media, pages, CLI agents\' task and log, Feishu images, the bots\' file tools, uploads',
    !missing.length && !browser.includes('moveFileWithRetry') && !/downloadPath:\s*downloadDir/.test(browser), JSON.stringify(missing));
}

/** F5: the sandbox's own pid namespace. */
export async function sandboxArgChecks({ check }) {
  const SB = await import('../src/sandbox.mjs');
  const base = { root: '/home/u/desk-hub', dataDir: '/home/u/desk-hub/data', workspaceDir: '/home/u/desk-hub/workspace', exists: () => true, folders: [] };
  const strict = SB.bwrapArgs({ ...base, mode: 'strict' });
  const open = SB.bwrapArgs({ ...base, mode: 'open' });
  let probeArgs = null;
  const fake = async (file, args) => { if (file === 'bwrap' && args[0] === '--version') return { code: 0, out: 'bwrap 0.9' }; if (file === 'bwrap') { probeArgs = args; return { code: 0, out: 'sandbox-ok\n' }; } return { code: 0, out: '' }; };
  if (process.platform === 'linux') await SB.checkSandbox({ workspaceDir: '/tmp', secret: '/nonexistent', runImpl: fake });
  check('SEC-F5 the bots\' sandbox has its own pid namespace in both modes (no /proc/<pid>/root of the hub or another process of the account), and the start check looks through the hub\'s /proc entry too',
    strict.includes('--unshare-pid') && open.includes('--unshare-pid') && SB.PROBE_SCRIPT.includes('[ ! -e "/proc/$3/root$1" ]')
    && (process.platform !== 'linux' || (probeArgs && probeArgs[probeArgs.length - 1] === String(process.pid))), JSON.stringify({ strict, open, probeArgs }));
}

/** F6: plain copies of key files once the key covers their names. */
export async function sealChecks({ check, readText }) {
  const S = await import('../src/store.mjs');
  const V = await import('../src/localvnc.mjs');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1560-seal-'));
  const keep = process.env.ASSIST_MASTER_KEY;
  const out = {};
  try {
    const mcp = path.join(T, 'mcp.json');
    const legit = JSON.stringify([{ id: 'notes', transport: 'stdio', command: 'node', args: ['notes.js'] }]);
    const evil = JSON.stringify([{ id: 'evil', transport: 'stdio', command: 'sh', args: ['-c', 'echo pwned'] }]);
    // Without a key (a hub started on its own, Linux): plain is the way, as before.
    delete process.env.ASSIST_MASTER_KEY;
    fs.writeFileSync(mcp, legit);
    out.noKey = (await S.readJson(mcp, null))?.[0]?.id;
    // The first run with a key: what is there is brought over (sealed), then every name is covered.
    process.env.ASSIST_MASTER_KEY = '33'.repeat(32);
    out.firstRun = await S.sealSecretFiles(T);
    out.firstSealed = JSON.parse(fs.readFileSync(mcp, 'utf8')).lamplitSealed === 1 && (await S.readJson(mcp, null))?.[0]?.id === 'notes';
    out.record = fs.existsSync(path.join(T, S.SEALING_FILE)) && JSON.parse(fs.readFileSync(path.join(T, S.SEALING_FILE), 'utf8')).lamplitSealed === 1;
    // Then a plain one appears (the verifier's planted mcp.json): not used, not sealed, said in 体检.
    fs.writeFileSync(mcp, evil);
    out.planted = await S.readJson(mcp, 'refused');
    out.plantedSync = S.readJsonSync(mcp, 'refused');
    out.notSealed = !(await S.sealSecretFiles(T)).includes('mcp.json') && !JSON.parse(fs.readFileSync(mcp, 'utf8')).lamplitSealed;
    out.listed = S.refusedPlainFiles.has('mcp.json');
    // The same for a key file read by its own module (the screen's passwords).
    fs.writeFileSync(path.join(T, 'tightvnc.json'), JSON.stringify({ password: 'abcd1234', control: 'efgh5678' }));
    out.vnc = V.readVncSecret(T, { key: Buffer.from('33'.repeat(32), 'hex') });
    // Lamplit writing it again (sealed) makes it Lamplit's again.
    await S.writeJsonAtomic(mcp, JSON.parse(legit));
    out.rewritten = (await S.readJson(mcp, null))?.[0]?.id === 'notes' && !S.refusedPlainFiles.has('mcp.json');
    // A name the record does not cover yet (an older record): brought over once, like an upgrade.
    fs.writeFileSync(path.join(T, S.SEALING_FILE), S.sealText(JSON.stringify({ names: [...S.SEALED_FILES].filter((n) => n !== 'feishu.json') }), Buffer.from('33'.repeat(32), 'hex')));
    fs.writeFileSync(path.join(T, 'feishu.json'), JSON.stringify({ appId: 'cli_x' }));
    out.newName = (await S.sealSecretFiles(T)).includes('feishu.json') && (await S.readJson(path.join(T, 'feishu.json'), null))?.appId === 'cli_x';
    // A record made up without the key opens nothing: everything is brought over as on a first run.
    fs.writeFileSync(path.join(T, S.SEALING_FILE), JSON.stringify({ names: [] }));
  } finally {
    if (keep === undefined) delete process.env.ASSIST_MASTER_KEY; else process.env.ASSIST_MASTER_KEY = keep;
    S.refusedPlainFiles.clear();
    fs.rmSync(T, { recursive: true, force: true });
  }
  const server = await readText('../src/server.mjs');
  const backup = await readText('../src/backup.mjs');
  check('SEC-F6a without a key plain key files work as before; the first run with a key seals what is there and records (sealed) that every name is covered',
    out.noKey === 'notes' && out.firstRun.includes('mcp.json') && out.firstSealed && out.record, JSON.stringify(out));
  check('SEC-F6b after that a plain mcp.json (or tightvnc.json) is refused - not used, not sealed into Lamplit\'s - and 体检 names it; Lamplit saving it again makes it usable; a name not covered yet is brought over once',
    out.planted === 'refused' && out.plantedSync === 'refused' && out.notSealed && out.listed && out.vnc === null && out.rewritten && out.newName
    && server.includes("checkupItem('sealed-files', '密钥文件', 'bad'") && backup.includes("plainRefused(abs, value) ? null : raw") && backup.includes("'sealing.json', 'browser-downloads',"),
    JSON.stringify(out));
}

/** F2-F4: the taken-out folder and .trash (trash.mjs). */
export async function trashChecks({ check }) {
  const T = await import('../src/trash.mjs');
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'sec1560-trash-'));
  const ws = path.join(D, 'ws');
  const outside = path.join(D, 'outside');
  try {
    fs.mkdirSync(path.join(ws, 'd2', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'd2', 'a.txt'), 'harmless');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'note.txt'), SECRET);
    T._test.setFence(null);
    if (process.platform !== 'linux') T._test.setAnchor(false); // Windows without the bots' account: the hub's own moves

    // F4: .trash a link to outside: the folder delete is refused before anything is made there or moved.
    linkAt(path.join(ws, '.trash'), outside);
    const said = await T.snapshot({ workspaceDir: ws, abs: path.join(ws, 'd2'), rel: 'd2', kind: 'delete' }).then(() => 'done', (e) => e.code || e.message);
    const f4 = { said, outside: fs.readdirSync(outside), back: fs.existsSync(path.join(ws, 'd2', 'a.txt')), random: fs.readdirSync(ws).filter((n) => n.startsWith('.lamplit-out-')) };
    check('SEC-F4 .trash a link to outside: a folder delete is refused, nothing is made where it leads, the folder stays under its own name (none left under a random one)',
      f4.said === 'PATH_OUTSIDE_WORKSPACE' && f4.outside.join() === 'note.txt' && f4.back && !f4.random.length, JSON.stringify(f4));
    try { fs.rmdirSync(path.join(ws, '.trash')); } catch { fs.unlinkSync(path.join(ws, '.trash')); }

    // F3: a Linux without /proc/self/fd: refused, not done the way by name.
    T._test.setAnchor(undefined);
    T._test.setNoProc(true);
    fs.writeFileSync(path.join(ws, 'gone.txt'), 'x');
    const noProc = await T.removeInside(ws, path.join(ws, 'gone.txt')).then(() => 'removed', (e) => e.code);
    const noProcFolder = await T.removeFolderInside(ws, path.join(ws, 'd2')).then(() => 'removed', (e) => e.code);
    T._test.setNoProc(false);
    if (process.platform !== 'linux') T._test.setAnchor(false);
    const safefs = await fsp.readFile(new URL('../src/safefs.mjs', import.meta.url), 'utf8');
    check('SEC-F3 no /proc/self/fd on Linux: removing a file or a folder a bot named is refused (never the way by name), and the checked open refuses too',
      noProc === 'PATH_UNCHECKABLE' && noProcFolder === 'PATH_UNCHECKABLE' && fs.existsSync(path.join(ws, 'gone.txt')) && fs.existsSync(path.join(ws, 'd2', 'a.txt'))
      && safefs.includes('this system has no /proc: Lamplit cannot check where'), JSON.stringify({ noProc, noProcFolder }));

    // F2 (wiring): the taken-out folder and old .trash days are removed through the held-open folder
    // on Linux (GNU rm), through the bots' account on Windows - never Node's rm by path there.
    if (process.platform === 'linux') {
      await T.removeFolderInside(ws, path.join(ws, 'd2'));
      check('SEC-F2 Linux: a folder is removed by GNU rm through the held-open folder (it walks by open folders, follows no link)', T._test.hasGnuRm() && !fs.existsSync(path.join(ws, 'd2')));
    } else {
      const removed = [];
      T._test.setRemoveFence(async (p) => { removed.push(p); await fsp.rm(p, { recursive: true, force: true }); });
      await T.removeFolderInside(ws, path.join(ws, 'd2'));
      fs.mkdirSync(path.join(ws, '.trash', '20000101', 'x'), { recursive: true });
      const pruned = await T.pruneTrash(ws);
      T._test.setRemoveFence(undefined);
      check('SEC-F2 Windows: with the bots\' account on, a taken-out folder and an old .trash day are removed as that account (rmdir /s does not follow junctions)',
        removed.length === 2 && /\.lamplit-out-/.test(path.basename(removed[0])) && path.basename(removed[1]) === '20000101' && pruned >= 1 && !fs.existsSync(path.join(ws, 'd2')),
        JSON.stringify({ removed, pruned }));
    }
  } finally {
    T._test.setFence(undefined);
    T._test.setAnchor(undefined);
    T._test.setNoProc(false);
    T._test.setRemoveFence(undefined);
    dropTestFolder(D);
  }
}
