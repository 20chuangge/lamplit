/**
 * smoke-sec1559.mjs - 1.5.59: the swapped-folder race on Linux (CI, run of the
 * 1.5.58 release: SEC-M7e C failed once on ubuntu-latest).
 *
 * rename(2) looks up the old name's folder and the new name's folder one after
 * the other. A bot that flips a folder on the way between the workspace and a
 * link to Lamplit's data folder can land the first lookup in the data folder
 * and the second in the workspace: the data file is moved into the workspace,
 * and the "rename back" then puts it under its own name in the real workspace
 * folder. The stress test hits that gap now and then; this one hits it every
 * time: a rename that resolves the two names exactly the way the kernel may,
 * with the flip between them.
 *
 *   SEC-M7h0  the way before 1.5.59 (names looked up by path) loses, every time
 *             - so the checks after it are not passing for nothing;
 *   SEC-M7h   Linux: through the held-open folder (/proc/self/fd/N), a file
 *             removal, a folder removal, and a folder moved to .trash and back
 *             on 撤销 leave the data folder alone, under the same flip.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'SECRET-FROM-THE-DATA-FOLDER';
const kind = process.platform === 'win32' ? 'junction' : 'dir';

/** A link (junction on Windows) at `at`, to `to`; an existing one taken away by itself first. */
function pointAt(at, to) {
  try {
    if (fs.lstatSync(at).isSymbolicLink()) { try { fs.rmdirSync(at); } catch { fs.unlinkSync(at); } }
  } catch { /* none yet */ }
  fs.symlinkSync(to, at, kind);
}

/**
 * A rename as the kernel may do it: the old name's folder looked up, then the
 * new name's - on the first call with `between()` in the gap. -> rename(from, to)
 */
function twoLookupRename({ before, between, at = 0 }) {
  let calls = 0;
  return async (from, to) => {
    const first = calls === at;
    calls += 1;
    if (first) before();
    const oldDir = fs.realpathSync.native(path.dirname(from));
    if (first) between();
    const newDir = fs.realpathSync.native(path.dirname(to));
    await fsp.rename(path.join(oldDir, path.basename(from)), path.join(newDir, path.basename(to)));
  };
}

/** ws/d -> ws/d_real (note.txt, sub/b.txt); the data folder has note.txt and sub/s.txt with the secret. */
function setUp(T) {
  const ws = path.join(T, 'ws');
  const data = path.join(T, 'data');
  for (const p of [ws, data]) fs.mkdirSync(p, { recursive: true });
  fs.mkdirSync(path.join(ws, 'd_real', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'd_real', 'note.txt'), 'harmless');
  fs.writeFileSync(path.join(ws, 'd_real', 'sub', 'b.txt'), 'harmless');
  fs.mkdirSync(path.join(data, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(data, 'note.txt'), SECRET);
  fs.writeFileSync(path.join(data, 'sub', 's.txt'), SECRET);
  pointAt(path.join(ws, 'd'), path.join(ws, 'd_real'));
  // The flip the bot makes: d to the data folder for the first lookup, back to the workspace for the second.
  const flip = { before: () => pointAt(path.join(ws, 'd'), data), between: () => pointAt(path.join(ws, 'd'), path.join(ws, 'd_real')) };
  // The data folder as it was: note.txt and sub/s.txt; or, once sub was taken away for the 撤销 case, nothing put where it was.
  const s = {};
  const dataIntact = () => {
    try {
      if (fs.readFileSync(path.join(data, 'note.txt'), 'utf8') !== SECRET) return false;
      return s.dataSubGone ? !fs.existsSync(path.join(data, 'sub')) : fs.readFileSync(path.join(data, 'sub', 's.txt'), 'utf8') === SECRET;
    } catch { return false; }
  };
  const secretInWorkspace = () => {
    let found = false;
    const walk = (p) => { let es = []; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const e of es) { const q = path.join(p, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(q); else { try { if (fs.readFileSync(q, 'utf8').includes(SECRET)) found = true; } catch { /* gone */ } } } };
    walk(ws);
    return found;
  };
  return Object.assign(s, { ws, data, flip, dataIntact, secretInWorkspace });
}

/** Links by themselves, then the rest (never recursively into what a link leads to). */
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

export async function raceChecks({ check }) {
  const T = await import('../src/trash.mjs');
  const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sec1559-'));
  const runs = [];
  try {
    // M7h0: the way before (looked up by path), under the flip.
    const before = fresh();
    runs.push(before);
    const a = setUp(before);
    T._test.setFence(null);
    T._test.setAnchor(false);
    T._test.setRawRename(twoLookupRename(a.flip));
    const said = await T.removeInside(a.ws, path.join(a.ws, 'd', 'note.txt')).then(() => 'removed', (e) => e.code || e.message);
    const lost = !a.dataIntact() && a.secretInWorkspace();
    check('SEC-M7h0 the race CI hit, made certain: with a rename that looks up its two names one after the other and the folder flipped between them, the way before 1.5.59 moves the data file into the workspace (this shows the next check is not passing for nothing)',
      lost, JSON.stringify({ said, dataIntact: a.dataIntact(), inWorkspace: a.secretInWorkspace() }));

    if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) {
      console.log('SKIP  SEC-M7h (Linux only: names reached through a held-open folder; on Windows the bots\' account does the moves, SEC-R2/R3)');
      return;
    }
    // M7h: the same flip against each move of a bot's name, through the held-open folder.
    T._test.setAnchor(undefined);
    const cases = {
      file: async (s) => T.removeInside(s.ws, path.join(s.ws, 'd', 'note.txt')),
      folder: async (s) => T.removeFolderInside(s.ws, path.join(s.ws, 'd', 'sub')),
      aside: async (s) => {
        const id = await T.snapshot({ workspaceDir: s.ws, abs: path.join(s.ws, 'd', 'sub'), rel: 'd/sub', kind: 'delete' });
        // 撤销: the move back into d/sub is its second move; there the target is what a flip would send into the data folder.
        fs.rmSync(path.join(s.data, 'sub'), { recursive: true, force: true });
        s.dataSubGone = true;
        T._test.setRawRename(twoLookupRename({ at: 1, before: s.flip.between, between: s.flip.before }));
        return T.undoChanges(s.ws, [id]);
      },
    };
    const result = {};
    for (const [name, run] of Object.entries(cases)) {
      const dir = fresh();
      runs.push(dir);
      const s = setUp(dir);
      T._test.setRawRename(twoLookupRename(s.flip));
      const said = await run(s).then((r) => (Array.isArray(r) ? (r[0]?.ok ? 'undone' : r[0]?.error) : 'done'), (e) => e.code || e.message);
      result[name] = { said, dataIntact: s.dataIntact(), inWorkspace: s.secretInWorkspace() };
    }
    const fileGone = result.file.said === 'done';
    check('SEC-M7h Linux: under that same flip, removing a file, removing a folder, and a folder moved to .trash and back on 撤销 go through the held-open folder: the data folder is untouched, nothing of it is in the workspace, and the removal still happens',
      Object.values(result).every((r) => r.dataIntact && !r.inWorkspace) && fileGone && result.folder.said === 'done' && result.aside.said === 'undone', JSON.stringify(result));
  } finally {
    T._test.setRawRename(null);
    T._test.setAnchor(undefined);
    T._test.setFence(undefined);
    for (const dir of runs) dropTestFolder(dir);
  }
}
