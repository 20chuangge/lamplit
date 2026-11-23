// The workspace of a hub the run did not start (the human's own): what was there before a scenario, a
// copy of it to put back, and afterwards every file that is new, changed or gone - whatever tool did it
// (fs_write, a browser screenshot, a file fetched from another machine).
//
// The rule after a scenario: what this run's bots made is removed, what they changed is put back, what
// they removed is put back. Each removed or replaced version is first copied to the run's backup folder
// (outside the workspace), so nothing is lost. A file another bot of the hub named in its own steps is
// left alone and said; so is a file too big to have been copied before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEXT_FILE = /\.(txt|md|json|csv|html?|ya?ml|ps1|py|m?js|sh|log|xml)$/i;
const SKIP = /^(node_modules)(\/|$)/;
const MAX_COPY = 8 * 1024 * 1024;       // one file: bigger ones are only watched (size and time)
const MAX_TOTAL = 600 * 1024 * 1024;    // the whole copy

const abs = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * Every file under root (hidden folders and node_modules aside), at most `cap`:
 * [{path, size, mtime, text?}] with .dirs (the folders) and .cut (hit the cap).
 * text: the text of small text files (what a deliverable says; a leftover's marks).
 */
export function walk(root, { cap = 60000, text = false, textMax = 64 * 1024 } = {}) {
  const out = [];
  const dirs = new Set();
  let cut = false;
  const go = (dir, rel) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= cap) { cut = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r) || e.name.startsWith('.')) continue;
      const a = path.join(dir, e.name);
      if (e.isDirectory()) { dirs.add(r); go(a, r); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(a); } catch { continue; }
      const row = { path: r, size: st.size, mtime: st.mtimeMs };
      if (text && TEXT_FILE.test(e.name) && st.size <= textMax) { try { row.text = fs.readFileSync(a, 'utf8'); } catch { /* gone */ } }
      out.push(row);
    }
  };
  go(root, '');
  return Object.assign(out, { dirs, cut });
}

/** The run's backup folder (outside every workspace): before/ the copies, removed/ and replaced/ what was taken out. */
export function backupDirFor(runId) {
  return path.join(os.tmpdir(), 'lamplit-collab-eval', String(runId));
}

/**
 * Before a scenario: what the workspace holds, and a copy of every file small enough. The copy is kept
 * for the whole run and refreshed only where a file changed since (cache: one per run and hub).
 * Returns { files: Map path -> {size, mtime, copy|null}, dirs, cut, notCopied }.
 */
export function snapshot(root, backupDir, cache = new Map()) {
  const rows = walk(root);
  const files = new Map();
  let total = [...cache.values()].reduce((s, c) => s + (c.copy ? c.size : 0), 0);
  let notCopied = 0;
  for (const f of rows) {
    const had = cache.get(f.path);
    let copy = had && had.size === f.size && had.mtime === f.mtime ? had.copy : null;
    if (!copy && f.size <= MAX_COPY && total + f.size <= MAX_TOTAL) {
      const to = abs(path.join(backupDir, 'before'), f.path);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs(root, f.path), to);
        copy = to;
        total += f.size;
      } catch { copy = null; }
    }
    if (!copy) notCopied += 1;
    const row = { size: f.size, mtime: f.mtime, copy };
    cache.set(f.path, row);
    files.set(f.path, row);
  }
  return { files, dirs: rows.dirs, cut: rows.cut, notCopied };
}

/**
 * After a scenario: what is new, changed or gone since the snapshot.
 * Returns { added: [row], changed: [row], gone: [path] } (rows from walk, with text).
 */
export function diff(root, snap) {
  const now = walk(root, { text: true });
  const seen = new Set(now.map((f) => f.path));
  const added = [];
  const changed = [];
  for (const f of now) {
    const was = snap.files.get(f.path);
    // Not there before: new, whatever its time says (a copy may keep the time of its source).
    if (!was) { added.push(f); continue; }
    if (was.size !== f.size || was.mtime !== f.mtime) changed.push(f);
  }
  const gone = [...snap.files.keys()].filter((p) => !seen.has(p));
  return { added, changed, gone, dirs: now.dirs, cut: now.cut };
}

/**
 * Put the workspace back. owner(path) -> 'eval' | 'other': whose the change is ('other': a bot of the hub
 * that is not this run's named it in its own steps). Returns what was done, for the report.
 */
export function restore(root, snap, d, { backupDir, owner = () => 'eval', keep = false }) {
  const done = { removed: [], restored: [], putBack: [], left: [], noCopy: [] };
  if (keep) return done;
  const save = (rel, kind) => {
    const to = abs(path.join(backupDir, kind), rel);
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(abs(root, rel), to); return true; } catch { return false; }
  };
  for (const f of d.added) {
    if (owner(f.path) !== 'eval') { done.left.push(f.path); continue; }
    if (!save(f.path, 'removed')) { done.left.push(f.path); continue; }
    try { fs.rmSync(abs(root, f.path), { force: true }); done.removed.push(f.path); } catch { done.left.push(f.path); }
  }
  for (const f of d.changed) {
    if (owner(f.path) !== 'eval') { done.left.push(f.path); continue; }
    const was = snap.files.get(f.path);
    if (!was?.copy) { done.noCopy.push(f.path); continue; }
    save(f.path, 'replaced');
    try {
      fs.copyFileSync(was.copy, abs(root, f.path));
      fs.utimesSync(abs(root, f.path), new Date(was.mtime), new Date(was.mtime));
      done.restored.push(f.path);
    } catch { done.noCopy.push(f.path); }
  }
  for (const rel of d.gone) {
    const was = snap.files.get(rel);
    if (!was?.copy) { done.noCopy.push(rel); continue; }
    try {
      fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
      fs.copyFileSync(was.copy, abs(root, rel));
      fs.utimesSync(abs(root, rel), new Date(was.mtime), new Date(was.mtime));
      done.putBack.push(rel);
    } catch { done.noCopy.push(rel); }
  }
  // Folders this scenario made, once empty (deepest first).
  const newDirs = [...walk(root).dirs].filter((x) => !snap.dirs.has(x)).sort((a, b) => b.length - a.length);
  for (const x of newDirs) { try { fs.rmdirSync(abs(root, x)); } catch { /* something else is in it */ } }
  return done;
}

/**
 * Before a scenario: files an earlier run left that this scenario's bots could take for their own work
 * (11-23: a job log from the run before made the bot apply to nothing). marks: words only this scenario's
 * material has. The human's uploads and this run's own folder are not looked at.
 */
export function leftovers(root, marks, { runId } = {}) {
  if (!marks?.length) return [];
  const hits = [];
  for (const f of walk(root, { text: true, textMax: 256 * 1024 })) {
    if (/^uploads\//.test(f.path)) continue;
    if (runId && f.path.startsWith(`评测-协作/${runId}/`)) continue;
    const word = marks.find((m) => f.path.includes(m) || (f.text && f.text.includes(m)));
    if (word) hits.push({ path: f.path, word });
  }
  return hits;
}

/** Each path once, at most n, as one line. */
export function listLine(paths, n = 12) {
  const u = [...new Set(paths)];
  return `${u.slice(0, n).join('、')}${u.length > n ? ` 等 ${u.length} 个` : ''}`;
}
