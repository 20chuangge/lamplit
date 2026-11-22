// File changes a bot makes in the workspace can be undone (1.5.8, report 7.1 #6).
//
// Before fs_write overwrites or appends to a file, the old file is kept; before
// fs_delete, a file is kept and removed, a folder is moved aside. A new file is
// only noted. Undoing puts the old file back, a deleted one back where it was,
// or removes a file the bot created. Days older than 7 are cleared. Commands
// (shell) are not covered: what a command changes is not known in advance.
//
// 1.5.54 (the 11-21 review's M7, as the verifier found it): the bot writes in
// the workspace, so nothing it can touch may steer the hub. Before, the record
// and the kept copy lived in workspace/.trash, and every step went by name: a
// bot that swapped a folder for a link to Lamplit's data folder between the
// check and the copy, move or undo got the hub to copy a secret into .trash,
// move data files out, or write over them on 撤销. Now:
//   - the records and kept files are in the data folder (<data>/undo), which the
//     bots' account cannot read or change;
//   - a file is read, written and removed through a handle checked to be the
//     file in the workspace (safefs.mjs); a removal is a move to a name only
//     this step knows, the moved file compared with the checked one before it
//     goes - anything else that was moved is set aside in the data folder;
//   - a folder is still moved aside inside the workspace (.trash, its own
//     content), the move checked the same way; undoing moves it back.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { P } from './store.mjs';
import { spawn, spawnSync } from 'node:child_process';

import { openInside, writeInside, isBelow, mkdirInside } from './safefs.mjs';
import { realPathOf } from './realpath.mjs';
import { fencedMover, fencedRemover } from './winrunner.mjs';

export const TRASH_DIR = '.trash';
export const KEEP_DAYS = 7;
const MAX_COPY_BYTES = 50 * 1024 * 1024;

const dayOf = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
/** Where records and kept files live: Lamplit's data folder, out of the bots' reach. */
const storeRoot = () => path.join(P.dataDir, 'undo');

function locate(id) {
  if (!/^\d{8}-[a-z0-9]+$/.test(String(id || ''))) return null;
  const dayDir = path.join(storeRoot(), id.slice(0, 8));
  return { manifest: path.join(dayDir, `${id}.json`), store: path.join(dayDir, id) };
}

const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

const pause = () => new Promise((r) => setTimeout(r, 2));
const outsideErr = (message) => Object.assign(new Error(message), { code: 'PATH_OUTSIDE_WORKSPACE' });
const randomName = (prefix) => `${prefix}${crypto.randomBytes(8).toString('hex')}`;

/**
 * Put a file or folder that was renamed to `tempName` back under `name`, wherever
 * it is: in the data folder (the one place worth taking from), found by its
 * random name. -> whether it was found.
 */
async function putBackInData(tempName, name) {
  const stack = [P.dataDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === tempName) {
        // Never over a file of the same name (one made since would be lost): then it stays under the random name.
        if (!fs.existsSync(path.join(dir, name))) await fsp.rename(path.join(dir, tempName), path.join(dir, name)).catch(() => {});
        return true;
      }
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(dir, e.name));
    }
  }
  return false;
}

/**
 * Take `abs` out of its place, checked against `want` (what a checked handle or
 * lstat said it is). First a rename to a random name in its OWN folder: one
 * rename resolves both names through the same folder, so whatever it hits -
 * even through a link swapped in - stays in the folder it is in. Then: the
 * random name is ours if it is the checked thing; anything else is renamed
 * back. A random name exists in one place only, so the next steps by that name
 * cannot reach anything else. -> the random name's path, or throws.
 *
 * 1.5.55 (the verifier's second 1.5.54 round): Windows resolves a rename's two
 * names one after the other, not through one folder, and a junction is made as
 * an empty real folder first; 3 in 30000 swapped renames moved a data file
 * into the workspace. So when the bots have their own account, every move of
 * a name the bot chose is done AS that account (winrunner.mjs fencedMover):
 * Windows refuses it any name that leads into the data folder. The checks
 * below stay, for what the account may move (another workspace file swapped in).
 */
let fenceForTests = undefined;
let anchorForTests = undefined;
// The system's rename, one call per move (tests put in one that resolves the two names the way a kernel may).
let rawRename = (a, b) => fsp.rename(a, b);
export const _test = {
  setFence: (fn) => { fenceForTests = fn; },
  putBackInData: (tempName, name) => putBackInData(tempName, name),
  setAnchor: (on) => { anchorForTests = on; },
  setRawRename: (fn) => { rawRename = fn || ((a, b) => fsp.rename(a, b)); },
};
const moverFor = (ws) => (fenceForTests !== undefined ? fenceForTests : fencedMover(ws));

/**
 * 1.5.59 (CI, Linux): rename(2) looks up the old name's folder and the new
 * name's folder one after the other too, so the same swap worked there: a data
 * file moved into the workspace, and the rename back put it in the real
 * workspace folder. On Linux a folder can be held open and its names reached
 * through the open folder itself (/proc/self/fd/N/name): both names of a move
 * then lead to that one folder, checked to be in the workspace, however the
 * names on the way are swapped afterwards. -> {at(name), close()}
 */
// Tests can play a Linux without /proc (F3) on any system.
let noProcForTests = false;
const onLinux = () => process.platform === 'linux' || noProcForTests;
const anchorsWork = () => !noProcForTests && process.platform === 'linux' && fs.existsSync('/proc/self/fd');
function openFolderInside(ws, dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  let where = '';
  try { where = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* checked below */ }
  if (!where || !isBelow(realPathOf(ws), where)) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    throw outsideErr('path resolves outside the shared workspace');
  }
  let open = true;
  return { fd, at: (name) => `/proc/self/fd/${fd}/${name}`, close: () => { if (open) { open = false; try { fs.closeSync(fd); } catch { /* closed */ } } } };
}

/**
 * 1.5.60 (the verifier's F2): a taken-out folder was then removed by Node's
 * recursive rm, which goes by path - lstat a child, then list it by name: a
 * child swapped for a link to the data folder in between led the hub's rm in
 * there. GNU rm walks relative to folders it holds open and never follows a
 * link; it gets the held-open folder as its fd 3, so even the start of its
 * path cannot be swapped. -> resolves when `name` (in the folder `fd`) is gone
 */
let gnuRm = null;
const hasGnuRm = () => {
  if (gnuRm === null) { const r = spawnSync('rm', ['--version'], { encoding: 'utf8' }); gnuRm = r.status === 0 && /GNU coreutils/.test(String(r.stdout || '')); }
  return gnuRm;
};
function rmUnder(fd, name) {
  return new Promise((resolve, reject) => {
    if (!hasGnuRm()) { reject(Object.assign(new Error('这台机器上没有 GNU 的 rm：Lamplit 没法稳妥地删掉这个文件夹，所以没删'), { code: 'PATH_UNCHECKABLE' })); return; }
    if (!name || /[\\/]/.test(name)) { reject(new Error(`not a name: ${name}`)); return; }
    let said = '';
    const child = spawn('rm', ['-rf', '--', `/proc/self/fd/3/${name}`], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    child.stderr.on('data', (c) => { said += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`rm: ${said.trim().slice(-200)}`), { code: 'ERMFAIL' }))));
  });
}
let removeFenceForTests = undefined;
_test.setRemoveFence = (fn) => { removeFenceForTests = fn; };
_test.hasGnuRm = () => hasGnuRm();
_test.setNoProc = (on) => { noProcForTests = Boolean(on); };
const removerFor = (ws) => (removeFenceForTests !== undefined ? removeFenceForTests : fencedRemover(ws));

/** Remove a taken-out folder: through the held-open folder (Linux), as the bots' account (Windows), else by its random name. */
async function removeTree(out, ws) {
  if (out.removeTree) return out.removeTree();
  const fenced = removerFor(ws);
  return onRandomName(out.temp, (p) => (fenced ? fenced(p) : fsp.rm(p, { recursive: true, force: false })));
}

/** 1.5.60 (F3): Linux without /proc/self/fd (a container, a chroot): no way to check, so a bot's name is not moved. */
const uncheckable = () => Object.assign(new Error('这台机器没有 /proc（容器或 chroot 里）：Lamplit 没法确认它在工作区里，所以没动'), { code: 'PATH_UNCHECKABLE' });

/** takeOut through the held-open folder (Linux): one folder for both names, nothing to wait for. */
async function takeOutAnchored(abs, want, ws) {
  const here = openFolderInside(ws, path.dirname(abs));
  try {
    const src = here.at(path.basename(abs));
    const tempName = randomName('.lamplit-out-');
    const temp = here.at(tempName);
    await rawRename(src, temp);
    const got = await fsp.lstat(temp, { bigint: true }).catch(() => null);
    if (got && sameFile(want, got) && !got.isSymbolicLink()) {
      // The second move (a folder into .trash, or back on 撤销): its target's folder held open and checked too.
      const move = async (from, to) => {
        const there = openFolderInside(ws, path.dirname(to));
        try { await rawRename(from, there.at(path.basename(to))); } finally { there.close(); }
      };
      // Refused later (1.5.60, F4): back under its own name through the same held-open folder.
      const restore = () => rawRename(temp, src);
      return { temp, move, restore, removeTree: () => rmUnder(here.fd, tempName), close: here.close };
    }
    // Something else was there (the bot swapped the file itself): back under its name, in this same folder.
    if (got) await rawRename(temp, src).catch(() => {});
    throw outsideErr('the path changed while it was being removed: nothing was removed');
  } catch (err) {
    here.close();
    throw err;
  }
}

async function takeOut(abs, want, ws) {
  const fenced = moverFor(ws);
  if (!fenced) {
    if (anchorForTests !== undefined ? anchorForTests : anchorsWork()) return takeOutAnchored(abs, want, ws);
    // No /proc/self/fd on Linux: refused, never the way by name (1.5.60, F3). Tests may ask for that way on purpose.
    if (anchorForTests === undefined && onLinux()) throw uncheckable();
  }
  const name = path.basename(abs);
  const tempName = randomName('.lamplit-out-');
  const temp = path.join(path.dirname(abs), tempName);
  const move = fenced || rawRename;
  await move(abs, temp);
  for (let i = 0; i < 1000; i += 1) {
    const got = await fsp.lstat(temp, { bigint: true }).catch(() => null);
    if (got && sameFile(want, got) && !got.isSymbolicLink()) return { temp, move, restore: () => move(temp, abs), close: () => {} };
    if (got) {
      // Not what was checked (a link was swapped in on the way): back under its own name, in its own folder.
      try { await move(temp, abs); throw outsideErr('the path changed while it was being removed: nothing was removed'); } catch (err) { if (err.code === 'PATH_OUTSIDE_WORKSPACE') throw err; }
    }
    // Where the name leads right now is not where it is (a folder on the way is swapped): wait.
    await pause();
  }
  // Never seen again where its name leads: if it is in the data folder, it goes back there
  // (only possible without the bots' account: as that account nothing there can be moved).
  if (!fenced) await putBackInData(tempName, name);
  throw outsideErr('the path changed while it was being removed: nothing was removed');
}

/** Do `step(temp)` on a random name until it works (a swapped folder on the way only makes it fail). */
async function onRandomName(temp, step) {
  let last = null;
  for (let i = 0; i < 1000; i += 1) {
    try { return await step(temp); } catch (err) { last = err; if (err.code !== 'ENOENT') throw err; }
    await pause();
  }
  throw last;
}

/**
 * Remove a file of the workspace, checked: open it (the checked handle says
 * which file it is), take it out (see takeOut), delete it by its random name.
 */
export async function removeInside(ws, abs) {
  const fh = await openInside(ws, abs, 'r');
  const want = await fh.stat({ bigint: true });
  await fh.close();
  const out = await takeOut(abs, want, ws);
  try { await onRandomName(out.temp, (p) => fsp.unlink(p)); } finally { out.close(); }
}

/** Remove a folder of the workspace: taken out (checked), then removed by its random name. */
export async function removeFolderInside(ws, abs) {
  const before = await fsp.lstat(abs, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory() || !isBelow(realPathOf(ws), realPathOf(abs))) throw outsideErr('path resolves outside the shared workspace');
  const out = await takeOut(abs, before, ws);
  try { await removeTree(out, ws); } finally { out.close(); }
}

/** Move a folder of the workspace into its .trash place, checked the same way: taken out first, then moved by its random name. */
async function moveFolderAside(ws, target, kept) {
  const before = await fsp.lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory() || !isBelow(realPathOf(ws), realPathOf(target))) throw outsideErr('path resolves outside the shared workspace');
  // 1.5.60 (F4): .trash/<day>/<id> made one level at a time and checked - a .trash that is a link
  // to the data folder is refused before anything is made there or moved at all.
  await mkdirInside(ws, path.dirname(kept));
  // The second move too: as the account when there is one (a swapped .trash must not lead it into the data folder).
  const out = await takeOut(target, before, ws);
  try {
    await onRandomName(out.temp, (p) => out.move(p, kept));
  } catch (err) {
    // Refused on the way: back under its own name, not left under the random one.
    await out.restore().catch(() => {});
    throw err;
  } finally {
    out.close();
  }
}

/**
 * Keep what is there before a change -> the change's id, or null (outside the
 * workspace, in the trash itself, or too big to copy).
 */
export async function snapshot({ workspaceDir, abs, rel, kind, botId = '' }) {
  const ws = path.resolve(workspaceDir);
  const target = path.resolve(abs);
  if (!inside(target, ws) || target === ws || inside(target, path.join(ws, TRASH_DIR)) || /^\.lamplit-out-/.test(path.basename(target))) return null;
  const stat = await fsp.lstat(target).catch(() => null);
  if (kind === 'delete' && !stat) return null;
  if (stat && kind !== 'delete' && (stat.isDirectory() || stat.size > MAX_COPY_BYTES)) return null;
  const id = `${dayOf()}-${crypto.randomBytes(5).toString('hex')}`;
  const where = locate(id);
  await fsp.mkdir(where.store, { recursive: true });
  const isDir = Boolean(stat?.isDirectory());
  let folder = '';
  if (stat && isDir) {
    // A folder (deleted): moved aside inside the workspace, checked; undo moves it back.
    folder = path.join(TRASH_DIR, id.slice(0, 8), id, path.basename(target));
    await moveFolderAside(ws, target, path.join(ws, folder));
  } else if (stat) {
    // A file: its bytes kept in the data folder, read through the checked handle.
    const fh = await openInside(ws, target, 'r');
    try {
      const info = await fh.stat();
      if (info.size > MAX_COPY_BYTES) {
        // Too big to keep: a delete still goes through the checked removal, without an undo.
        await fsp.rm(where.store, { recursive: true, force: true });
        await fh.close().catch(() => {});
        if (kind === 'delete') await removeInside(ws, target);
        return null;
      }
      await fsp.writeFile(path.join(where.store, 'content'), await fh.readFile());
    } finally {
      await fh.close().catch(() => {});
    }
    if (kind === 'delete') await removeInside(ws, target);
  }
  const manifest = { id, at: new Date().toISOString(), ws, kind, rel: String(rel || path.relative(ws, target)).replace(/\\/g, '/'), existed: Boolean(stat), isDir, ...(folder ? { folder: folder.replace(/\\/g, '/') } : {}), botId, undone: false };
  await fsp.writeFile(where.manifest, JSON.stringify(manifest, null, 2));
  return id;
}

/** Undo changes, newest first -> [{id, ok, path, error}] */
export async function undoChanges(workspaceDir, ids = []) {
  const ws = path.resolve(workspaceDir);
  const out = [];
  for (const id of [...ids].reverse()) {
    const where = locate(id);
    let m = null;
    try { m = where && JSON.parse(await fsp.readFile(where.manifest, 'utf8')); } catch { /* none */ }
    if (!m) { out.push({ id, ok: false, error: '找不到这次改动的备份（超过 7 天会自动清掉）' }); continue; }
    if (m.undone) { out.push({ id, ok: false, path: m.rel, error: '已经撤销过了' }); continue; }
    if (m.ws && path.resolve(m.ws) !== ws) { out.push({ id, ok: false, path: m.rel, error: '这次改动是在另一个工作区里做的' }); continue; }
    const target = path.resolve(ws, m.rel);
    if (!inside(target, ws) || target === ws) { out.push({ id, ok: false, error: '路径不在工作区里' }); continue; }
    try {
      if (m.kind === 'delete' && m.isDir) {
        if (fs.existsSync(target)) throw new Error('原来的位置已经有同名的文件或文件夹');
        const kept = path.resolve(ws, m.folder || '');
        if (!inside(kept, path.join(ws, TRASH_DIR))) throw new Error('找不到这次改动的备份');
        await mkdirInside(ws, path.dirname(target)); // checked level by level (1.5.60, F4)
        await moveFolderAside(ws, kept, target);
      } else if (m.kind === 'delete' || m.existed) {
        if (m.kind === 'delete' && fs.existsSync(target)) throw new Error('原来的位置已经有同名的文件或文件夹');
        await mkdirInside(ws, path.dirname(target)); // checked level by level (1.5.60, F4)
        await writeInside(ws, target, await fsp.readFile(path.join(where.store, 'content')));
      } else if (fs.existsSync(target)) {
        await removeInside(ws, target);
      }
      m.undone = true;
      m.undoneAt = new Date().toISOString();
      await fsp.writeFile(where.manifest, JSON.stringify(m, null, 2));
      out.push({ id, ok: true, path: m.rel });
    } catch (err) {
      out.push({ id, ok: false, path: m.rel, error: err.code === 'PATH_OUTSIDE_WORKSPACE' ? '路径不在工作区里' : err.message });
    }
  }
  return out.reverse();
}

/** Clear days older than `days`: the records in the data folder, and folders moved aside in the workspace. */
export async function pruneTrash(workspaceDir, days = KEEP_DAYS) {
  const cutoff = dayOf(new Date(Date.now() - days * 24 * 3600 * 1000));
  let removed = 0;
  const old = async (root) => { try { return (await fsp.readdir(root)).filter((n) => /^\d{8}$/.test(n) && n < cutoff); } catch { return []; } };
  // The records in the data folder: the hub's own, by name.
  for (const name of await old(storeRoot())) {
    await fsp.rm(path.join(storeRoot(), name), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  // The workspace's .trash (1.5.60, F2): a bot can swap anything in it, so never Node's rm by path -
  // GNU rm through the held-open .trash on Linux, the bots' account on Windows. A .trash that is a
  // link is left alone, and so is everything on a Linux without /proc (F3).
  const ws = path.resolve(workspaceDir);
  const trash = path.join(ws, TRASH_DIR);
  const st = await fsp.lstat(trash).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return removed;
  const names = await old(trash);
  if (!names.length) return removed;
  if (anchorForTests !== undefined ? anchorForTests : anchorsWork()) {
    let here;
    try { here = openFolderInside(ws, trash); } catch { return removed; }
    try {
      for (const name of names) await rmUnder(here.fd, name).then(() => { removed += 1; }, () => {});
    } finally {
      here.close();
    }
    return removed;
  }
  if (onLinux() && anchorForTests === undefined) return removed;
  const fenced = removerFor(ws);
  for (const name of names) {
    await (fenced ? fenced(path.join(trash, name)) : fsp.rm(path.join(trash, name), { recursive: true, force: true })).then(() => { removed += 1; }, () => {});
  }
  return removed;
}
