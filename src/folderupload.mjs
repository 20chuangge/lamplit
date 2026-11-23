/**
 * Folder upload (1.5.64): a folder the human picks or drops keeps its layout
 * under the workspace, uploads/<day>/<folder name>/…, and goes into a message
 * as one attachment item. On 11-23 fifteen launch-video files sent to a group
 * on another machine had to go as three messages (10 attachments each at most)
 * and the coordinator started on the first one, missing a file.
 *
 * The page keeps the same rules (public/app/main/05b-folder.js): what is
 * skipped, the limits, which names are refused. Here they are checked again,
 * for every file, before anything is written.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const FOLDER_MAX_FILES = 200;
export const FOLDER_MAX_BYTES = 500 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACH_MAX_ITEMS = 20;
export const TREE_LINES = 30;

/** Never uploaded from a folder: version-control and package folders, and what operating systems leave around. */
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__macosx', '$recycle.bin', 'system volume information', '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems']);
const SKIP_FILES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', '.localized', 'icon\r']);

/** Is this relative path (a/b/c.txt) one the folder upload leaves out? -> the name that is skipped, or ''. */
export function skippedPart(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const low = parts[i].toLowerCase();
    if (i < parts.length - 1 && SKIP_DIRS.has(low)) return parts[i];
    if (i === parts.length - 1 && (SKIP_FILES.has(low) || low.startsWith('._') || low.startsWith('~$'))) return parts[i];
  }
  return '';
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

/** One name in a path: refused (a reason) or fine (''). */
export function badSegment(seg) {
  const s = String(seg ?? '');
  if (!s) return 'empty name';
  if (s === '.' || s === '..') return 'leads out of the folder';
  if (BAD_CHARS.test(s)) return 'a character Windows does not allow';
  if (/[. ]$/.test(s) || /^ /.test(s)) return 'starts with a space or ends with a dot or space';
  if (RESERVED.test(s)) return 'a name Windows keeps for itself';
  if (Buffer.byteLength(s) > 200) return 'name too long';
  return '';
}

/**
 * A file's path inside the uploaded folder, as the page sends it ("素材/a.png").
 * -> the cleaned path; throws {code: 'BAD_PATH'} for anything that could lead
 * outside it or that Windows cannot store: .., absolute paths, drive letters,
 * backslashes, reserved names (CON, NUL, COM1…).
 */
export function checkRelPath(raw) {
  const rel = String(raw ?? '');
  const refuse = (why) => { throw Object.assign(new Error(`not a safe path inside the folder (${why}): ${rel.slice(0, 200)}`), { code: 'BAD_PATH', status: 400 }); };
  if (!rel) refuse('empty');
  if (rel.includes('\\')) refuse('backslash');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) refuse('absolute path');
  if (rel.length > 600) refuse('too long');
  const parts = rel.split('/');
  if (parts.length > 24) refuse('too deep');
  for (const p of parts) {
    const why = badSegment(p);
    if (why) refuse(why);
  }
  return parts.join('/');
}

/** The folder's own name, made safe to use as a folder here (never refused: it is ours to name). */
export function safeFolderName(raw) {
  let s = String(raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = 'folder';
  if (RESERVED.test(s)) s = `_${s}`;
  while (Buffer.byteLength(s) > 120) s = s.slice(0, -1);
  return s;
}

/** Is `rel` (workspace-relative) where a folder upload lives: uploads/<day>/<name>? */
export function isFolderUploadPath(rel) {
  const p = String(rel || '');
  const m = /^uploads\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(p);
  return Boolean(m) && !badSegment(m[2]);
}

/**
 * Every file under `abs` (a folder in the workspace), sorted by path, links
 * never followed. -> [{rel, size}]; stops after `max` + 1 files.
 */
export async function listFolderFiles(abs, { max = FOLDER_MAX_FILES * 5 } = {}) {
  const out = [];
  async function walk(dir, prefix) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length > max) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.isFile()) {
        const st = await fsp.lstat(path.join(dir, e.name)).catch(() => null);
        if (st?.isFile()) out.push({ rel, size: st.size });
      }
    }
  }
  await walk(abs, '');
  return out;
}

/** Is there anything at all at `abs` - a file, a folder, even a dangling link? */
export async function taken(abs) {
  return fs.existsSync(abs) || Boolean(await fsp.lstat(abs).catch(() => null));
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImageName = (name) => IMAGE.test(String(name || ''));

export function sizeText(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * A folder in the "[附件]" block: one line the page turns into a folder card,
 * then a short list of what is in it (the first TREE_LINES files), so the bot
 * knows the layout without one line per file.
 *   - uploads/2026-11-23/视频/（文件夹，15 个文件，320.0 MB）
 *     · 01-开场.mp4
 *     · 素材/封面.png
 *     …还有 3 个
 */
export function folderLines(folderPath, files) {
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  const lines = [`- ${folderPath.replace(/\/?$/, '/')}（文件夹，${files.length} 个文件，${sizeText(total)}）`];
  for (const f of files.slice(0, TREE_LINES)) lines.push(`  · ${f.rel}`);
  if (files.length > TREE_LINES) lines.push(`  …还有 ${files.length - TREE_LINES} 个`);
  return lines;
}
