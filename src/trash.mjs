// File changes a bot makes in the workspace can be undone (1.5.8, report 7.1 #6).
//
// Before fs_write overwrites or appends to a file, the old file is copied to
// workspace/.trash/<day>/<id>/; before fs_delete, the file or folder is moved
// there (so a delete is a move, and as cheap). A new file is only noted. Each
// change has a manifest, <day>/<id>.json. Undoing puts the old file back,
// moves a deleted one back where it was, or removes a file the bot created.
// Days older than 7 are cleared. Commands (shell) are not covered: what a
// command changes is not known in advance.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const TRASH_DIR = '.trash';
export const KEEP_DAYS = 7;
const MAX_COPY_BYTES = 50 * 1024 * 1024;

const dayOf = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function locate(workspaceDir, id) {
  if (!/^\d{8}-[a-z0-9]+$/.test(String(id || ''))) return null;
  const dayDir = path.join(workspaceDir, TRASH_DIR, id.slice(0, 8));
  return { manifest: path.join(dayDir, `${id}.json`), store: path.join(dayDir, id) };
}

/**
 * Keep what is there before a change -> the change's id, or null (outside the
 * workspace, in the trash itself, or too big to copy).
 */
export async function snapshot({ workspaceDir, abs, rel, kind, botId = '' }) {
  const ws = path.resolve(workspaceDir);
  const target = path.resolve(abs);
  if (!inside(target, ws) || target === ws || inside(target, path.join(ws, TRASH_DIR))) return null;
  const stat = await fsp.lstat(target).catch(() => null);
  if (kind === 'delete' && !stat) return null;
  if (stat && kind !== 'delete' && (stat.isDirectory() || stat.size > MAX_COPY_BYTES)) return null;
  const id = `${dayOf()}-${crypto.randomBytes(5).toString('hex')}`;
  const where = locate(ws, id);
  await fsp.mkdir(where.store, { recursive: true });
  const kept = path.join(where.store, path.basename(target));
  if (stat) {
    if (kind === 'delete') await fsp.rename(target, kept);
    else await fsp.copyFile(target, kept);
  }
  const manifest = { id, at: new Date().toISOString(), kind, rel: String(rel || path.relative(ws, target)).replace(/\\/g, '/'), existed: Boolean(stat), isDir: Boolean(stat?.isDirectory()), botId, undone: false };
  await fsp.writeFile(where.manifest, JSON.stringify(manifest, null, 2));
  return id;
}

/** Undo changes, newest first -> [{id, ok, path, error}] */
export async function undoChanges(workspaceDir, ids = []) {
  const ws = path.resolve(workspaceDir);
  const out = [];
  for (const id of [...ids].reverse()) {
    const where = locate(ws, id);
    let m = null;
    try { m = where && JSON.parse(await fsp.readFile(where.manifest, 'utf8')); } catch { /* none */ }
    if (!m) { out.push({ id, ok: false, error: '找不到这次改动的备份（超过 7 天会自动清掉）' }); continue; }
    if (m.undone) { out.push({ id, ok: false, path: m.rel, error: '已经撤销过了' }); continue; }
    const target = path.resolve(ws, m.rel);
    if (!inside(target, ws)) { out.push({ id, ok: false, error: '路径不在工作区里' }); continue; }
    const kept = path.join(where.store, path.basename(target));
    try {
      if (m.kind === 'delete') {
        if (fs.existsSync(target)) throw new Error('原来的位置已经有同名的文件或文件夹');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rename(kept, target);
      } else if (m.existed) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(kept, target);
      } else {
        await fsp.rm(target, { force: true });
      }
      m.undone = true;
      m.undoneAt = new Date().toISOString();
      await fsp.writeFile(where.manifest, JSON.stringify(m, null, 2));
      out.push({ id, ok: true, path: m.rel });
    } catch (err) {
      out.push({ id, ok: false, path: m.rel, error: err.message });
    }
  }
  return out.reverse();
}

/** Clear days older than `days`. */
export async function pruneTrash(workspaceDir, days = KEEP_DAYS) {
  const root = path.join(path.resolve(workspaceDir), TRASH_DIR);
  const cutoff = dayOf(new Date(Date.now() - days * 24 * 3600 * 1000));
  let names = [];
  try { names = await fsp.readdir(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (/^\d{8}$/.test(name) && name < cutoff) {
      await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}
