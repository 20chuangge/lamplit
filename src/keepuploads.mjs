// What the human uploaded stays as they sent it (1.5.64).
//
// 11-23, in the user's content group: a member made a new cover and saved it
// over the human's own upload of that cover (uploads/<day>/…-封面.jpg),
// with ffmpeg in a shell step, without a word. A bot never silently replaces a
// file under uploads/ that it did not make: its new content goes under a new
// name next to it ("…-<bot name>.jpg"), the original stays, and the tool result tells
// the bot to say so (the human reads the new name in its reply).
//
// Why a new name and not a question: it never stops the work (a group's board
// would wait on a card for something with a safe answer), nothing is lost, and
// the human still decides which file to use.
//
// fs_write is turned to the new name before it writes. Other steps that can
// write a file (a shell command, a coding agent, a download) are checked around
// the step: each upload the step names is copied aside first; if it changed,
// the new content moves to the new name and the original comes back.
// A delete is not handled here: fs_delete moves to the trash (撤销 for 7 days).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hubTmp } from './store.mjs';

/** Steps that may write a file named in their arguments (fs_write is turned aside before it runs). */
export const WRITERS = new Set(['shell', 'cli_agent_run', 'browser_download', 'file_fetch', 'desktop_ui', 'mcp_call']);
/** Bigger files are not copied aside (an upload is at most 25 MB; this leaves room). */
const KEEP_MAX_BYTES = 64 * 1024 * 1024;

/** Files a bot made under uploads/ in this process (its own, so not turned aside again). */
export const BOT_MADE = new Set();

const slash = (p) => String(p || '').replace(/\\/g, '/');

/** "uploads/…" paths named anywhere in a step's arguments (relative, or absolute inside the workspace). */
export function uploadPathsIn(args, workspaceDir = '') {
  const strings = [];
  const walk = (v, depth = 0) => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object' && depth < 4) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(args);
  const root = workspaceDir ? slash(path.resolve(workspaceDir)).replace(/\/$/, '').toLowerCase() : '';
  const out = new Set();
  for (const text of strings) {
    const flat = slash(text);
    for (const m of flat.matchAll(/(uploads\/[^\s"'<>|*?]+?\.[A-Za-z0-9]{1,8})(?=$|[\s"',;)\]}])/g)) {
      const before = flat.slice(0, m.index);
      const prev = before.slice(-1);
      // "/…/workspace/uploads/x.jpg" counts only inside this workspace; "./uploads/x.jpg" too.
      if (prev === '/') {
        if (!before.endsWith('./') && !(root && before.toLowerCase().endsWith(`${root}/`))) continue;
      } else if (prev && !/[\s"'=(:>]/.test(prev)) continue;
      out.add(m[1]);
    }
  }
  return [...out].slice(0, 20);
}

/** Is this workspace path one the human uploaded (under uploads/, not made by a bot here)? */
export function isHumanUpload(rel, botMade = BOT_MADE) {
  const r = slash(rel).replace(/^\.\//, '');
  return /^uploads\//.test(r) && !botMade.has(r);
}

/** A name next to it that is free: "封面.jpg" -> "封面-画师.jpg", then "封面-画师-2.jpg". */
export function freeNameFor(abs, label = '') {
  const ext = path.extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  const tag = String(label || '新').replace(/[\\/:*?"<>|\s]/g, '').slice(0, 20) || '新';
  for (let i = 1; i < 1000; i += 1) {
    const next = `${stem}-${tag}${i > 1 ? `-${i}` : ''}${ext}`;
    if (!fs.existsSync(next)) return next;
  }
  return `${stem}-${tag}-${Date.now()}${ext}`;
}

/** What the bot is told when its write went to a new name (it says so in its reply). */
export function keptNote(original, savedAs) {
  return `「${original}」是用户上传的原件，没有被覆盖：你写的新内容存成了「${savedAs}」。回复里用新文件名，并告诉用户原件还在、新的叫什么。以后不要往用户上传的文件上写。`;
}

/**
 * fs_write onto a human upload: write it under a new name instead (append: a
 * copy of the original first, then the new text after it). -> the path to use
 * and what happened, or null when the write is not onto an upload.
 */
export function turnWriteAside({ workspaceDir, rel, append = false, label = '', botMade = BOT_MADE }) {
  const r = slash(rel).replace(/^\.\//, '');
  if (!isHumanUpload(r, botMade)) return null;
  const abs = path.resolve(workspaceDir, r);
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (!stat.isFile()) return null;
  const next = freeNameFor(abs, label);
  if (append) fs.copyFileSync(abs, next);
  const savedAs = slash(path.relative(path.resolve(workspaceDir), next));
  botMade.add(savedAs);
  return { path: savedAs, kept: { original: r, savedAs, note: keptNote(r, savedAs) } };
}

/** Before a step that may write: copy aside each upload it names. -> what to check after it. */
export async function keepBefore({ workspaceDir, args, botMade = BOT_MADE }) {
  const kept = [];
  for (const rel of uploadPathsIn(args, workspaceDir)) {
    if (!isHumanUpload(rel, botMade)) continue;
    const abs = path.resolve(workspaceDir, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > KEEP_MAX_BYTES) continue;
    // The hub's own temp folder (data/tmp, which every sandbox hides): never the system's, a bot's too (1.5.61 F8).
    const dir = await fsp.mkdtemp(path.join(hubTmp('keep'), 'k-'));
    const copy = path.join(dir, path.basename(abs));
    try { await fsp.copyFile(abs, copy); } catch { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); continue; }
    kept.push({ rel, abs, copy, dir, size: st.size, mtimeMs: st.mtimeMs });
  }
  return kept;
}

const sameBytes = async (a, b) => {
  const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return x.equals(y);
};

/**
 * After the step: an upload whose bytes changed gets its original back, and the
 * new bytes move to a free name next to it. -> [{original, savedAs, note}]
 */
export async function restoreAfter({ workspaceDir, kept = [], label = '', botMade = BOT_MADE }) {
  const moved = [];
  for (const k of kept) {
    try {
      const st = await fsp.stat(k.abs).catch(() => null);
      // Gone (deleted or moved by the step): not ours to undo here - nothing silently replaced it.
      if (st?.isFile() && !(st.size === k.size && st.mtimeMs === k.mtimeMs && await sameBytes(k.abs, k.copy))) {
        const next = freeNameFor(k.abs, label);
        await fsp.rename(k.abs, next).catch(async () => { await fsp.copyFile(k.abs, next); });
        await fsp.copyFile(k.copy, k.abs);
        const savedAs = slash(path.relative(path.resolve(workspaceDir), next));
        botMade.add(savedAs);
        moved.push({ original: k.rel, savedAs, note: keptNote(k.rel, savedAs) });
      }
    } catch { /* the step's own result still stands */ }
    await fsp.rm(k.dir, { recursive: true, force: true }).catch(() => {});
  }
  return moved;
}
