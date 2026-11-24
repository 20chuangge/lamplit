// Files a bot made itself (1.5.67; the human, 11-24: "I give a task and get the result. How you get
// there isn't my business; don't keep asking me to approve").
//
// 11-24 06:20-06:39, the TikTok bot: four cards, each for `del /Q` of its own temp files - the danger list
// asks for `del /q`, `rmdir /s`, `rm -rf` and `Remove-Item -Recurse` every time, with no 「以后都允许」.
// A bot's own work in the workspace now runs: deleting, moving or overwriting what it made itself.
//
// What counts as its own: a path it created inside the workspace - an fs_write / fs_mkdir of something
// that was not there, a path a command names that the command brought into being, a file a step made
// (its creation time after the step began) - and everything under a folder it made. Kept per bot in
// data/own-files.json for two weeks. Never its own: anything under uploads/ (the human's), anything that
// was there before, the workspace itself or anything outside it.
//
//   ownDeleteCommand(command, {workspaceDir, owns}) -> {ok, rest, reason}  a delete / move of own files only
//   createOwnFiles({file, workspaceDir}) -> {note, owns, forget, before, after, fromResult}

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.mjs';

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PER_BOT = 3000;
const WIN = process.platform === 'win32';

const slash = (p) => String(p || '').replace(/\\/g, '/');

/**
 * The path rules of a workspace, by its own form (1.5.67; the release CI on Linux: a model writes `tmp67\a.png` on a
 * Linux hub too). A Windows workspace (C:\…, \\server\…) uses Windows rules; any other uses POSIX rules - with `\`
 * read as a separator there as well. -> {P, win}
 */
const WIN_ABS = /^[A-Za-z]:[\\/]|^\\\\/;
export function pathRules(workspaceDir) {
  const win = WIN_ABS.test(String(workspaceDir || ''));
  return { P: win ? path.win32 : path.posix, win };
}

/**
 * A place a command or a step names, absolute in the workspace's own rules (`\` and `/` both separate), or null for
 * one that cannot be there: a Windows place (C:\…) named on a POSIX workspace.
 */
export function placeIn(workspaceDir, p) {
  if (!workspaceDir || p === undefined || p === null || p === '') return null;
  const { P, win } = pathRules(workspaceDir);
  const raw = String(p);
  if (!win && WIN_ABS.test(raw)) return null;
  return P.resolve(win ? workspaceDir : slash(workspaceDir), win ? raw : slash(raw));
}

/** A workspace-relative path ("tmp/a.png"), or null for the workspace itself or anything outside it. */
export function relIn(workspaceDir, p) {
  const abs = placeIn(workspaceDir, p);
  if (!abs) return null;
  const { P, win } = pathRules(workspaceDir);
  const rel = P.relative(P.resolve(win ? workspaceDir : slash(workspaceDir)), abs);
  if (!rel || rel.startsWith('..') || P.isAbsolute(rel)) return null;
  return slash(rel);
}
const keyOf = (rel) => (WIN ? rel.toLowerCase() : rel);

/** The words of a command line, quotes taken off ("a b" stays one word). */
function words(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const DELETE = /^(del|erase|rd|rmdir|rm|remove-item|ri)$/i;
const MOVE = /^(move|mv|move-item|mi|ren|rename|rename-item)$/i;
const CHANGES_DIR = /(^|\s)(cd|chdir|pushd|popd|set-location|sl)(\s|$)/i;

/**
 * The parts of a command line, run one after another: `&&`, `||`, `;`, a new line, and cmd's single `&`
 * (1.5.68; 11-24, TikTok: `del /Q … 2>nul & dir /B …` was read as one delete with `&` and `dir` as files).
 * `2>&1` and `&>` are redirections, not a new part.
 */
export function commandParts(text) {
  return String(text || '').split(/&&|\|\||;|\r?\n|(?<![>&|])&(?![&>])/);
}

/** The words of one part, without redirections (`2>nul`, `> out.txt`, `2>&1`, `< in.txt`): those are not its paths. */
function partWords(part) {
  const w = words(part);
  const out = [];
  for (let i = 0; i < w.length; i += 1) {
    const x = w[i];
    if (/^(\d|&)?>>?&\d$/.test(x)) continue; // 2>&1
    if (/^(\d|&)?>>?$|^<$/.test(x)) { i += 1; continue; } // `> out.txt`: the target is the next word
    if (/^(\d|&)?>>?\S|^<\S/.test(x)) continue; // 2>nul, >out.txt
    out.push(x);
  }
  return out;
}

/** The folder a part changes to (cd, cd /d, pushd, Set-Location): '' when it is not one, null when it cannot be told. */
function cdTarget(w) {
  const prog = String(w[0] || '').toLowerCase();
  if (prog === 'popd') return null;
  if (!/^(cd|chdir|pushd|set-location|sl)$/.test(prog)) return '';
  const args = w.slice(1).filter((x) => !/^\/d$/i.test(x) && !/^-(path|literalpath)$/i.test(x));
  return args.length === 1 ? args[0] : null;
}

/**
 * A command's parts with the folder each one runs in (1.5.68: `cd tiktok\drafts && del /Q a.png` deletes
 * tiktok/drafts/a.png, not a.png at the top). -> [{part, w, cd?, at(p) -> absolute place or null}] or {bad: reason}.
 * A cd out of the workspace, or one that cannot be told, stops it.
 */
function walkParts(text, workspaceDir) {
  const { P, win } = pathRules(workspaceDir);
  const root = P.resolve(win ? workspaceDir : slash(workspaceDir));
  let cwd = root;
  const at = (from) => (p) => {
    const raw = String(p ?? '');
    if (!raw || (!win && WIN_ABS.test(raw))) return null;
    return P.resolve(from, win ? raw : slash(raw));
  };
  const out = [];
  for (const part of commandParts(text)) {
    const w = partWords(part);
    if (!w.length) continue;
    const cd = cdTarget(w);
    if (cd === null) return { bad: 'changes folder' };
    if (cd) {
      const to = at(cwd)(cd);
      if (!to || (to !== root && !relIn(workspaceDir, to))) return { bad: 'changes folder out of the workspace' };
      cwd = to;
      out.push({ part, w, cd: true, at: at(cwd) });
      continue;
    }
    if (CHANGES_DIR.test(part)) return { bad: 'changes folder' };
    out.push({ part, w, at: at(cwd) });
  }
  return out;
}

/**
 * A command whose deletes and moves touch only files this bot made (1.5.67). -> {ok, rest, reason}
 *   ok: there is at least one delete/move and every path in them is the bot's own;
 *   rest: the command without those parts (the danger list is held against what is left).
 * Not ok - it asks as before - when it pipes, uses a variable, changes to a folder outside the workspace, names a
 * path outside the workspace, or a wildcard whose folder the bot did not make. A `cd` inside the workspace is
 * followed (1.5.68).
 */
export function ownDeleteCommand(command, { workspaceDir = '', owns = () => false, anywhere = null } = {}) {
  const text = String(command || '');
  if (!text.trim() || !workspaceDir) return { ok: false, reason: 'empty' };
  if (/(^|[^|])\|([^|]|$)/.test(text) || /`|\$\(|%[A-Za-z_]+%|(^|[\s"'])~/.test(text)) return { ok: false, reason: 'pipe or variable' };
  const walked = walkParts(text, workspaceDir);
  if (walked.bad) return { ok: false, reason: walked.bad };
  // 放手 (1.5.67): any path that is not a dangerous place (dangerousPlace) - the human's files too, as the level says.
  if (anywhere) return anyDeleteCommand(walked, workspaceDir, anywhere);
  const rest = [];
  let touched = 0;
  for (const { part, w, at, cd } of walked) {
    const prog = w[0].replace(/\.exe$/i, '');
    const del = DELETE.test(prog);
    const move = MOVE.test(prog);
    if (cd || (!del && !move)) { rest.push(part); continue; }
    const targets = w.slice(1).filter((x) => !/^(\/[a-z]|--?[a-z][\w-]*)$/i.test(x)).flatMap((x) => (/^(remove|move|rename)-item$|^ri$|^mi$/i.test(prog) ? x.split(',') : [x])).filter(Boolean);
    if (!targets.length) return { ok: false, reason: 'no target' };
    const relOf = (t) => { const abs = at(t.replace(/[\\/]+$/, '')); return abs ? relIn(workspaceDir, abs) : null; };
    // A move's last word is where it goes: inside the workspace, and not over something that is not its own.
    const sources = move && targets.length > 1 ? targets.slice(0, -1) : targets;
    if (move && targets.length > 1) {
      const to = relOf(targets[targets.length - 1]);
      if (!to || to.startsWith('uploads/')) return { ok: false, reason: 'moves out' };
      if (fs.existsSync(path.resolve(workspaceDir, to)) && !fs.statSync(path.resolve(workspaceDir, to)).isDirectory() && !owns(to)) return { ok: false, reason: 'over a file not its own' };
    }
    for (const t of sources) {
      if (/[$%`]/.test(t)) return { ok: false, reason: 'variable' };
      const rel = relOf(t);
      if (!rel || rel.startsWith('uploads/') || rel === 'uploads') return { ok: false, reason: `not its own: ${t}` };
      if (/[*?]/.test(rel)) {
        // A wildcard only inside a folder the bot made itself: it cannot reach anything else.
        const dir = path.posix.dirname(rel);
        if (dir === '.' || /[*?]/.test(dir) || !owns(dir)) return { ok: false, reason: `wildcard outside its own folder: ${t}` };
      } else if (!owns(rel)) return { ok: false, reason: `not its own: ${t}` };
    }
    touched += 1;
  }
  return touched ? { ok: true, rest: rest.join(' && ') } : { ok: false, reason: 'no delete or move' };
}

/** The deletes and moves of a command at 放手: every path (and a wildcard's folder) must be allowed by `ok(abs)`. */
function anyDeleteCommand(walked, workspaceDir, ok) {
  const rest = [];
  let touched = 0;
  const { P } = pathRules(workspaceDir);
  for (const { part, w, at, cd } of walked) {
    const prog = w[0].replace(/\.exe$/i, '');
    if (cd || (!DELETE.test(prog) && !MOVE.test(prog))) { rest.push(part); continue; }
    const targets = w.slice(1).filter((x) => !/^(\/[a-z]|--?[a-z][\w-]*)$/i.test(x)).flatMap((x) => (/^(remove|move|rename)-item$|^ri$|^mi$/i.test(prog) ? x.split(',') : [x])).filter(Boolean);
    if (!targets.length) return { ok: false, reason: 'no target' };
    for (const t of targets) {
      // In the workspace's own rules, `\` and `/` alike; a Windows place on a POSIX workspace cannot be judged: it asks.
      const abs = at(t.replace(/[\\/]+$/, ''));
      if (!abs) return { ok: false, reason: `not a place here: ${t}` };
      const wild = /[*?]/.test(abs);
      if (wild && /[*?]/.test(P.dirname(abs))) return { ok: false, reason: `wildcard in a folder name: ${t}` };
      if (!ok(wild ? P.dirname(abs) : abs, { wildcard: wild })) return { ok: false, reason: `dangerous place: ${t}` };
    }
    touched += 1;
  }
  return touched ? { ok: true, rest: rest.join(' && ') } : { ok: false, reason: 'no delete or move' };
}

/**
 * A place where a delete or a move is truly dangerous at any level (1.5.67): a drive or the filesystem's root,
 * the workspace itself or a folder above it, the home folder (and above) or one of its top folders (Desktop,
 * Documents, Downloads…), the system's folders, Lamplit's own data. A wildcard's folder may not be any of these.
 */
export function dangerousPlace(abs, { workspaceDir = '', dataDir = '', home = process.env.USERPROFILE || process.env.HOME || '' } = {}) {
  // The workspace's own path rules (1.5.67: Windows paths on Windows, POSIX on a Linux hub - `\` read as `/` there).
  const { P, win } = workspaceDir ? pathRules(workspaceDir) : { P: path, win: WIN };
  const norm = (p) => { const r = P.resolve(win ? String(p) : slash(p)).replace(/[\\/]+$/, ''); return win ? r.toLowerCase() : r; };
  if (!win && WIN_ABS.test(String(abs))) return true; // a Windows place on a POSIX machine: not judged, so not let through
  const a = norm(abs);
  const within = (p, root) => Boolean(root) && (p === root || p.startsWith(`${root}${P.sep}`));
  if (P.parse(norm(abs) || P.sep).root.replace(/[\\/]+$/, '').toLowerCase() === a.toLowerCase() || a === '') return true;
  const ws = workspaceDir ? norm(workspaceDir) : '';
  if (ws && within(ws, a)) return true; // the workspace itself, or above it
  if (home) {
    const h = norm(home);
    if (within(h, a)) return true; // the home folder, or above it
    if (norm(P.dirname(a)) === h && !(ws && within(a, ws) && a !== ws)) return true; // Desktop, Documents, Downloads…
  }
  if (dataDir && within(a, norm(dataDir))) return true;
  const system = win
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/lib64', '/var', '/opt', '/System', '/Library', '/Applications', '/dev', '/proc', '/sys'];
  return system.some((s) => within(a, norm(s)));
}

/** Workspace paths a command names (to see afterwards which of them it brought into being), after any cd (1.5.68). */
export function pathsNamed(command, workspaceDir) {
  const out = new Set();
  const walked = workspaceDir ? walkParts(command, workspaceDir) : { bad: 'no workspace' };
  const list = walked.bad ? [{ w: words(command), at: (p) => placeIn(workspaceDir, p) }] : walked;
  for (const { w, at, cd } of list) {
    if (cd) continue; // the folder it goes to is not a file it makes
    for (const x of w) {
      if (!x || /^(\/[a-z]|-)/i.test(x) || /[*?$%`<>|]/.test(x) || !/[\\/.]/.test(x)) continue;
      const abs = at(x.replace(/^[^=]+=(?=\S)/, ''));
      const rel = abs ? relIn(workspaceDir, abs) : null;
      if (rel && !rel.startsWith('uploads/')) out.add(rel);
    }
  }
  return [...out].slice(0, 40);
}

/**
 * Folders a command works in (1.5.68): where it cd's to, and the folder of a name it builds - `tiktok\drafts\kz_%f.png`
 * in a `for` loop (11-24: that strip was not counted as the bot's own, and deleting it asked). A file born there
 * during the step is the bot's.
 */
export function foldersNamed(command, workspaceDir) {
  const out = new Set();
  const walked = workspaceDir ? walkParts(command, workspaceDir) : { bad: 'no workspace' };
  if (walked.bad) return [];
  for (const { w, at, cd } of walked) {
    if (cd) { const rel = relIn(workspaceDir, at('.')); if (rel && !rel.startsWith('uploads')) out.add(rel); continue; }
    for (const x of w) {
      const m = /^(.*)[\\/][^\\/]*[%*?$][^\\/]*$/.exec(x || '');
      if (!m || /[%*?$`]/.test(m[1])) continue;
      const abs = at(m[1]);
      const rel = abs ? relIn(workspaceDir, abs) : null;
      if (rel && !rel.startsWith('uploads')) out.add(rel);
    }
  }
  return [...out].slice(0, 10);
}

export function createOwnFiles({ file = null, workspaceDir = '' } = {}) {
  let made = {};
  let loaded = false;
  let saving = null;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const raw = file ? await readJson(file, {}).catch(() => ({})) : {};
    const cutoff = Date.now() - KEEP_MS;
    for (const [bot, list] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      made[bot] = Object.fromEntries(Object.entries(list || {}).filter(([, at]) => Number(at) > cutoff));
    }
  };
  const save = () => {
    if (!file || saving) return;
    saving = setTimeout(() => { saving = null; writeJsonAtomic(file, made).catch(() => {}); }, 300);
    saving.unref?.();
  };
  const api = {
    load,
    /** The bot made this (workspace-relative or absolute inside the workspace). */
    note(botId, p) {
      const rel = relIn(workspaceDir, p);
      if (!botId || !rel || rel.startsWith('uploads/') || rel === 'uploads') return false;
      const mine = made[botId] || (made[botId] = {});
      mine[keyOf(rel)] = Date.now();
      const keys = Object.keys(mine);
      if (keys.length > MAX_PER_BOT) for (const k of keys.sort((a, b) => mine[a] - mine[b]).slice(0, keys.length - MAX_PER_BOT)) delete mine[k];
      save();
      return true;
    },
    /** Did the bot make this path, or a folder it is in? */
    owns(botId, rel) {
      const mine = made[botId];
      if (!mine || !rel || String(rel).startsWith('uploads/')) return false;
      let k = keyOf(slash(rel).replace(/\/+$/, ''));
      for (;;) {
        if (mine[k]) return true;
        const up = path.posix.dirname(k);
        if (!up || up === '.' || up === k) return false;
        k = up;
      }
    },
    forget(botId, rel) {
      if (made[botId]?.[keyOf(rel)]) { delete made[botId][keyOf(rel)]; save(); }
    },
    /** Before a step: which of the paths it names are there already. */
    before(rels) {
      return new Set(rels.filter((r) => fs.existsSync(path.resolve(workspaceDir, r))));
    },
    /**
     * After a step: what it named and brought into being is the bot's; so is a file it made (creation time
     * after `since`) in a folder it names, or in the workspace's top folder - one level, a few hundred entries.
     */
    after(botId, rels, existed, since, folders = []) {
      for (const r of rels) if (!existed.has(r) && fs.existsSync(path.resolve(workspaceDir, r))) api.note(botId, r);
      const dirs = new Set(['', ...folders]);
      for (const r of rels) {
        const abs = path.resolve(workspaceDir, r);
        const st = fs.statSync(abs, { throwIfNoEntry: false });
        dirs.add(st?.isDirectory() ? r : path.posix.dirname(r) === '.' ? '' : path.posix.dirname(r));
      }
      for (const d of [...dirs].slice(0, 10)) {
        let entries = [];
        try { entries = fs.readdirSync(path.resolve(workspaceDir, d || '.')).slice(0, 400); } catch { continue; }
        for (const e of entries) {
          const rel = d ? `${d}/${e}` : e;
          const st = fs.statSync(path.resolve(workspaceDir, rel), { throwIfNoEntry: false });
          if (st && st.birthtimeMs > 0 && st.birthtimeMs >= since - 100) api.note(botId, rel);
        }
      }
    },
    /** Paths in a step's result (a picture made, a file saved) that came into being during the step. */
    fromResult(botId, result, since) {
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
      for (const m of String(text).slice(0, 20000).matchAll(/[\w.\-一-鿿/\\:]+\.[A-Za-z0-9]{1,6}/g)) {
        const rel = relIn(workspaceDir, m[0].replace(/\\\\/g, '\\'));
        if (!rel) continue;
        const st = fs.statSync(path.resolve(workspaceDir, rel), { throwIfNoEntry: false });
        if (st && st.birthtimeMs > 0 && st.birthtimeMs >= since - 100) api.note(botId, rel);
      }
    },
  };
  return api;
}
