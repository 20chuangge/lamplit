/**
 * store.mjs - the single place that knows where bytes live.
 *
 * Everything else in the app talks to this module instead of joining paths
 * itself, so a "home directory" override (ASSIST_HOME) moves the whole
 * installation in one go. That is what the smoke test uses: it copies
 * config/, skills/ and public/ into a temp directory, points ASSIST_HOME at it,
 * and then runs the real server binary against throw-away state.
 *
 * Persistence choices, deliberately boring:
 *   - JSON (+ atomic tmp+rename) for things we mutate as a whole (bots, routines, config)
 *   - JSONL append-only for things we only ever add to (sessions, audit)
 *   - Markdown for memory and skills, because a human is supposed to be able
 *     to open them in an editor and understand them.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Installation root. Overridable so tests / demos never touch real state. */
export const ROOT = process.env.ASSIST_HOME
  ? path.resolve(process.env.ASSIST_HOME)
  : path.resolve(SRC_DIR, '..');

function pickDir(envName, fallback) {
  const raw = process.env[envName];
  return raw && raw.trim() ? path.resolve(raw.trim()) : path.join(ROOT, fallback);
}

const DATA_DIR = pickDir('ASSIST_DATA_DIR', 'data');

/** Where the bots' shared workspace lives by default (no setting, no env). */
export const DEFAULT_WORKSPACE_DIR = path.join(ROOT, 'workspace');
/** The human's own workspace folder (data/workspace.json {path}), set in
 *  settings and read once at start; ASSIST_WORKSPACE_DIR still wins (tests). */
export const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json');
function chosenWorkspace() {
  try {
    const raw = fs.readFileSync(WORKSPACE_FILE, 'utf8');
    // 1.5.61 (F9): a workspace.json Lamplit did not write does not move the bots' workspace.
    // (Read while this module loads: the note is checked with hoisted functions only.)
    if (noteRefuses(DATA_DIR, 'workspace.json', raw)) { chosenWorkspace.refused = WORKSPACE_FILE; return ''; }
    const p = String(JSON.parse(raw).path || '').trim();
    return p && path.isAbsolute(p) ? path.resolve(p) : '';
  } catch {
    return '';
  }
}

export const P = {
  root: ROOT,
  configDir: path.join(ROOT, 'config'),
  botsDir: path.join(ROOT, 'config', 'bots'),
  assistantConfig: path.join(ROOT, 'config', 'assistant.json'),
  // Product settings (provider / baseUrl / model). No secrets in this file.
  settingsFile: path.join(ROOT, 'config', 'settings.json'),
  skillsDir: path.join(ROOT, 'skills'),
  publicDir: path.join(ROOT, 'public'),
  workspaceDir: process.env.ASSIST_WORKSPACE_DIR?.trim() ? path.resolve(process.env.ASSIST_WORKSPACE_DIR.trim()) : (chosenWorkspace() || DEFAULT_WORKSPACE_DIR),
  dataDir: DATA_DIR,
  memoryDir: path.join(DATA_DIR, 'memory'),
  sessionsDir: path.join(DATA_DIR, 'sessions'),
  // Uploaded bot avatars, one file per bot: data/avatars/<botId>.<png|jpg|webp>.
  avatarsDir: path.join(DATA_DIR, 'avatars'),
  // Group chats: data/groups/<id>.json is the roster, <id>.jsonl the transcript.
  groupsDir: path.join(DATA_DIR, 'groups'),
  auditFile: path.join(DATA_DIR, 'audit.jsonl'),
  routinesFile: path.join(DATA_DIR, 'routines.json'),
  // Secrets live next to the data, never in config/ and never in an API response.
  secretsFile: path.join(DATA_DIR, 'secrets.json'),
  // Remote-access token + pairing code, generated on first boot.
  securityFile: path.join(DATA_DIR, 'security.json'),
  // Phones and other devices that paired with this hub (Settings -> 手机和外网).
  // Each one carries its own session token, so one can be revoked without
  // logging out everything else.
  devicesFile: path.join(DATA_DIR, 'devices.json'),
  // Approvals that were still waiting for a human (crash recovery).
  pendingFile: path.join(DATA_DIR, 'pending.json'),
  // One file per turn, so an interrupted process can be explained after a restart.
  turnsDir: path.join(DATA_DIR, 'turns'),
};

/** Create every directory the app expects. Idempotent. */
export async function ensureDirs() {
  const dirs = [
    P.configDir,
    P.botsDir,
    P.skillsDir,
    P.workspaceDir,
    P.dataDir,
    P.memoryDir,
    P.sessionsDir,
    P.avatarsDir,
    P.groupsDir,
    P.turnsDir,
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/** Short, readable ids: ap_9f3c1a2b4d5e (approval), turn_..., etc. */
export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * Write via tmp + rename so a crash mid-write cannot leave a half-file behind.
 * Windows can throw EPERM/EBUSY when a virus scanner holds the target open for
 * a few ms, so we retry the rename a handful of times before giving up.
 *
 * `data` may be a string (with `encoding`, default utf8) or a Buffer - avatar
 * uploads are binary, and they deserve the same no-half-file guarantee.
 */
export async function writeFileAtomic(file, data, encoding = null) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data, encoding);
  noteBefore(file, data);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      noteAfter(file, data);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}

export async function writeTextAtomic(file, text) {
  return writeFileAtomic(file, text, 'utf8');
}


export async function appendText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, text, 'utf8');
}

// ---------------------------------------------------------------------------
// JSON (whole-document) storage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Keys at rest (SEC-14)
// ---------------------------------------------------------------------------
//
// The desktop app keeps a master key in Windows' own protected storage (DPAPI,
// via Electron safeStorage) and hands it over as ASSIST_MASTER_KEY. With it,
// the files that hold keys are written encrypted (AES-256-GCM): copied to
// another computer, data/ alone opens nothing. Without it (a hub started from
// the command line, a Linux machine) they stay plain, as before.

/** Files that hold a model / voice / app key or a connected app's token. */
export const SEALED_FILES = new Set(['secrets.json', 'voice.json', 'media.json', 'vision.json', 'feishu.json', 'mcp.json', 'runner.json', 'browser-logins.json', 'x-account.json', 'backup-key.json',
  // 1.5.54 (review L6): this hub's master token and pairing code, the other machines' tokens, the relay's key and join secret.
  'security.json', 'peers.json', 'relay-link.json', 'tightvnc.json']);

/** Is  sealed with a key this process does not have (started without the desktop app)? Such a file is never overwritten. */
export function sealedButLocked(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(value?.lamplitSealed) && openSealed(value) === null;
  } catch {
    return false;
  }
}

export function masterKey() {
  const hex = String(process.env.ASSIST_MASTER_KEY || '').trim();
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

export function sealText(text, key = masterKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${JSON.stringify({ lamplitSealed: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })}\n`;
}

/** The plain text of a sealed box, or null (no key, another key, damaged). */
export function openSealed(box, key = masterKey()) {
  if (!key || !box?.lamplitSealed) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plain key files once the key is here (1.5.60, F6)
// ---------------------------------------------------------------------------
//
// With a master key every key file is written sealed. A plain one then is not
// Lamplit's: put there by something else (the verifier's 1.5.59 attack: a
// browser download planted a plain mcp.json, whose commands the hub runs at
// its next start, outside the sandbox). So it is not used. But plain files are
// also how every key file started (before the desktop app had a key, before a
// name joined SEALED_FILES): those are sealed once, at start, and then the
// name is "covered". data/sealing.json, sealed itself (so it cannot be made
// up), lists the covered names; a plain file under a covered name is refused
// - left as it is, unused, and named in 体检 (refusedPlainFiles).

export const SEALING_FILE = 'sealing.json';
const sealingCache = new Map();
/** The names `key` has brought over in `dir` (a Set; empty without a key or a record it opens). */
function coveredNames(dir, key = masterKey()) {
  if (!key) return new Set();
  const file = path.join(dir, SEALING_FILE);
  let st;
  try { st = fs.statSync(file); } catch { return new Set(); }
  const known = sealingCache.get(file);
  if (known && known.mtimeMs === st.mtimeMs && known.size === st.size && known.key.equals(key)) return known.names;
  let names = new Set();
  try {
    const text = openSealed(JSON.parse(fs.readFileSync(file, 'utf8')), key);
    if (text) names = new Set(JSON.parse(text).names || []);
  } catch { /* none it opens */ }
  sealingCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key, names });
  return names;
}

/** Plain key files refused since start: name -> {file, at}. */
export const refusedPlainFiles = new Map();

/** Is `value` (read from `file`) a plain copy of a key file this key already covers? Then it is not used. */
export function plainRefused(file, value) {
  const name = path.basename(file);
  if (!SEALED_FILES.has(name) || !masterKey()) return false;
  if (value && typeof value === 'object' && value.lamplitSealed) return false;
  if (!coveredNames(path.dirname(file)).has(name)) return false;
  if (!refusedPlainFiles.has(name)) {
    refusedPlainFiles.set(name, { file, at: new Date().toISOString(), reason: 'plain' });
    console.error(`[store] ${name} is not encrypted although this computer's key covers it: Lamplit did not write it, so it is not used (体检 says so)`);
  }
  return true;
}
if (chosenWorkspace.refused) refusedPlainFiles.set('workspace.json', { file: chosenWorkspace.refused, at: new Date().toISOString(), reason: 'changed' });

// ---------------------------------------------------------------------------
// Files that decide what the hub trusts, with or without a key (1.5.61, F9)
// ---------------------------------------------------------------------------
//
// F6 refuses a plain key file once the desktop app's key covers it; a hub with
// no key (a Linux server, start-hub) had nothing: a file put in data/ by
// something else (the verifier's 1.5.60 attack: the hub's own browser told to
// download there) was used. Two more files decide a lot and are not key files,
// so they stay plain even with a key: restore-pending.json (at its next start
// the hub restores the "backup" it names into config/, data/ and the workspace)
// and workspace.json (where the bots' workspace is).
//
// Now Lamplit notes the sha256 of what it last wrote under each such name (null:
// it made none). At read, a file other than noted is not used and 体检 says so.
// The note: data/trust.json, or with a key data/trust-sealed.json (sealed, so it
// cannot be made up; it covers the two plain names, F6 covers the key files).
// It starts at the first 1.5.61 start from the files there (trusted once, as
// F6's first sealing). Neither note can be replaced by what is left to an
// attacker in data/: making a new (empty) file, never replacing one.

const EXTRA_TRUST = ['restore-pending.json', 'workspace.json'];
export const TRUST_FILE = 'trust.json';
export const TRUST_SEALED_FILE = 'trust-sealed.json';

/** Is `name` noted? `key`: with a key the key files are F6's. */
function tracked(name, key = masterKey()) {
  return EXTRA_TRUST.includes(name) || (!key && SEALED_FILES.has(name));
}
const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function trackedFile(file, key = masterKey()) {
  const abs = path.resolve(String(file));
  return sameDir(path.dirname(abs), path.resolve(DATA_DIR)) && tracked(path.basename(abs), key) ? path.basename(abs) : '';
}
function sha256Of(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

// Hoisted (function declarations): chosenWorkspace() asks while the module loads.
/** The note this mode reads in `dir` ({hashes}), or null when there is none yet. sealed: the key's. */
function readNote(dir, sealed = Boolean(masterKey())) {
  const file = path.join(dir, sealed ? 'trust-sealed.json' : 'trust.json');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cache = (readNote.cache ||= new Map());
  const known = cache.get(file);
  const key = sealed ? masterKey() : null;
  if (known && known.mtimeMs === st.mtimeMs && known.size === st.size && String(known.key) === String(key?.toString('hex'))) return known.note;
  let note = null;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (sealed) text = openSealed(JSON.parse(text), key);
    const value = text ? JSON.parse(text) : null;
    if (value && typeof value.hashes === 'object' && value.hashes) note = value;
  } catch { /* none it can read */ }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key: key?.toString('hex'), note });
  return note;
}
/** Does the note say Lamplit did not write `raw` as `name`? */
function noteRefuses(dir, name, raw) {
  const note = readNote(dir);
  if (!note || !Object.prototype.hasOwnProperty.call(note.hashes, name)) return false; // not noted yet: the first start notes it
  const ok = note.hashes[name];
  return !(Array.isArray(ok) && ok.includes(sha256Of(raw)));
}
function writeNote(dir, note, sealed) {
  const file = path.join(dir, sealed ? TRUST_SEALED_FILE : TRUST_FILE);
  const text = sealed ? sealText(JSON.stringify(note)) : `${JSON.stringify(note, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  readNote.cache?.delete(file);
}
/** Change what the notes there say about `name` (each note that exists; the sealed one only with the key). */
function changeNotes(name, change) {
  for (const sealed of [false, true]) {
    if (sealed && !masterKey()) continue;
    if (!sealed && !tracked(name, null)) continue;
    const note = readNote(DATA_DIR, sealed);
    if (!note) continue;
    const next = { ...note, hashes: { ...note.hashes, [name]: change(note.hashes[name]) }, at: new Date().toISOString() };
    try { writeNote(DATA_DIR, next, sealed); } catch (err) { console.error(`[store] could not note ${name}: ${err.message}`); }
  }
}
// Lamplit writes: the new hash is noted before the rename (the old one stays, so a crash in
// between leaves a file the note still knows), and alone after it.
function noteBefore(file, data) {
  const name = trackedFile(file, null);
  if (name) changeNotes(name, (was) => [...new Set([...(Array.isArray(was) ? was : []), sha256Of(data)])].slice(-3));
}
function noteAfter(file, data) {
  const name = trackedFile(file, null);
  if (!name) return;
  changeNotes(name, () => [sha256Of(data)]);
  if (refusedPlainFiles.get(name)?.reason === 'changed') refusedPlainFiles.delete(name);
}
/** For the tests: the two halves of a write's noting (smoke-sec1561 SEC-F9a). */
export const _trust = { noteBefore: (file, data) => noteBefore(file, data), noteAfter: (file, data) => noteAfter(file, data) };

/** Lamplit took `file` away (or put it there other than through these writers): note what is there now. */
export function noteNow(file) {
  const name = trackedFile(file, null);
  if (!name) return;
  let raw = null;
  try { raw = fs.readFileSync(file); } catch { /* gone */ }
  changeNotes(name, () => (raw === null ? null : [sha256Of(raw)]));
  if (raw !== null && refusedPlainFiles.get(name)?.reason === 'changed') refusedPlainFiles.delete(name);
}

/** Is `raw`, read from `file`, other than what Lamplit last wrote there? Then it is not used (named in 体检). */
export function untrusted(file, raw) {
  const name = trackedFile(file);
  if (!name || !noteRefuses(path.resolve(DATA_DIR), name, raw)) return false;
  if (!refusedPlainFiles.has(name)) {
    refusedPlainFiles.set(name, { file: path.resolve(file), at: new Date().toISOString(), reason: 'changed' });
    console.error(`[store] ${name} is not what Lamplit last wrote there: something else put it in the data folder, so it is not used (体检 says so)`);
  }
  return true;
}

/**
 * At start: the note for this mode, made from the files there now where it has
 * no word yet about a name (the first 1.5.61 start; a name a later version
 * adds). -> names newly noted
 */
export async function noteTrustedFiles(dir = DATA_DIR) {
  const key = masterKey();
  const sealed = Boolean(key);
  const note = readNote(dir, sealed) || { hashes: {} };
  const names = [...EXTRA_TRUST, ...(sealed ? [] : SEALED_FILES)];
  const added = [];
  const hashes = { ...note.hashes };
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(hashes, name)) continue;
    let raw = null;
    try { raw = await fsp.readFile(path.join(dir, name)); } catch { /* not there: Lamplit made none */ }
    hashes[name] = raw === null ? null : [sha256Of(raw)];
    added.push(name);
  }
  if (added.length || !readNote(dir, sealed)) {
    await fsp.mkdir(dir, { recursive: true });
    writeNote(dir, { hashes, at: new Date().toISOString() }, sealed);
  }
  return added;
}

/**
 * The hub's own temporary files (1.5.61, the verifier's F8): never the
 * system's temp folder, which on Linux is the bots' too (strict and open
 * sandboxes share it, as the same account). data/tmp/<sub>, which every
 * sandbox hides. -> its path
 */
export function hubTmp(sub = '') {
  const dir = sub ? path.join(DATA_DIR, 'tmp', String(sub).replace(/[^a-zA-Z0-9_.-]/g, '_')) : path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** At start: what is in data/tmp older than `maxAgeMs` goes (a crash's leftovers). */
export async function clearOldHubTmp(maxAgeMs = 24 * 3600 * 1000) {
  const root = path.join(DATA_DIR, 'tmp');
  for (const sub of await fsp.readdir(root).catch(() => [])) {
    const dir = path.join(root, sub);
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      const st = await fsp.lstat(path.join(dir, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

const sealedWarned = new Set();
/** Parsed JSON, opening a sealed file; `undefined` when it cannot be opened (or is a refused plain key file). */
function parseMaybeSealed(file, raw) {
  if (untrusted(file, raw)) return undefined; // 1.5.61 (F9)
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !value.lamplitSealed) return plainRefused(file, value) ? undefined : value;
  const text = openSealed(value);
  if (text === null) {
    if (!sealedWarned.has(file)) {
      sealedWarned.add(file);
      console.error(`[store] ${path.basename(file)} is encrypted with a key this app does not have (copied from another computer, or started without the desktop app); treating it as empty and leaving the file as it is`);
    }
    return undefined;
  }
  return JSON.parse(text);
}

function jsonTextFor(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const key = SEALED_FILES.has(path.basename(file)) ? masterKey() : null;
  return key ? sealText(text, key) : text;
}

/**
 * At start: seal the key files still written in plain text (before 1.2.156,
 * or before the desktop app had a master key). Each one is read back and
 * checked before it replaces the plain file. -> names sealed
 */
export async function sealSecretFiles(dir) {
  const key = masterKey();
  const done = [];
  if (!key) return done;
  // 1.5.60 (F6): only names this key has not covered yet are brought over; a plain file under a
  // covered name is refused (plainRefused), not sealed - sealing it would make it Lamplit's.
  const covered = coveredNames(dir, key);
  for (const name of SEALED_FILES) {
    const file = path.join(dir, name);
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    if (!value || typeof value !== 'object' || value.lamplitSealed) continue;
    if (covered.has(name)) { plainRefused(file, value); continue; }
    const sealed = sealText(raw, key);
    if (openSealed(JSON.parse(sealed), key) !== raw) continue; // never replace what cannot be read back
    await writeTextAtomic(file, sealed);
    done.push(name);
  }
  // Every name is covered from now on (the ones not there yet too: a key file Lamplit makes later is written sealed).
  if ([...SEALED_FILES].some((n) => !covered.has(n))) {
    await writeTextAtomic(path.join(dir, SEALING_FILE), sealText(JSON.stringify({ names: [...SEALED_FILES], at: new Date().toISOString() }), key));
  }
  return done;
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    const value = parseMaybeSealed(file, raw);
    return value === undefined ? fallback : value;
  } catch (err) {
    // A corrupt config file should degrade to the fallback, not take the server
    // down; the caller decides whether that is fatal.
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

/**
 * A sealed file this app cannot open (no master key, or another computer's or
 * the desktop app's key) is never written over: that would throw away its keys.
 * 1.5.54 verifier (L6): with a wrong key it was overwritten too.
 */
function refuseLockedSeal(file) {
  if (SEALED_FILES.has(path.basename(file)) && sealedButLocked(file)) {
    throw Object.assign(new Error(`${path.basename(file)} is encrypted; open Lamplit from the desktop app to change it`), { code: 'SEALED_NO_KEY', status: 409 });
  }
}

export async function writeJsonAtomic(file, value) {
  refuseLockedSeal(file);
  await writeTextAtomic(file, jsonTextFor(file, value));
  if (masterKey()) refusedPlainFiles.delete(path.basename(file)); // written sealed again by Lamplit itself
}

/**
 * Synchronous atomic JSON write.
 *
 * Crash-recovery bookkeeping (pending approvals, per-turn status) uses this on
 * purpose: the whole point is that the bytes are on disk *before* the process
 * can die, so an async fire-and-forget write is not good enough. The files are
 * tiny (a handful of records), so the blocking cost is irrelevant.
 */
export function writeJsonSyncAtomic(file, value) {
  refuseLockedSeal(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = jsonTextFor(file, value);
  fs.writeFileSync(tmp, text, 'utf8');
  noteBefore(file, text);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      noteAfter(file, text);
      if (masterKey()) refusedPlainFiles.delete(path.basename(file));
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      // Windows: a scanner or another handle can hold the target for a few ms.
      const waitUntil = Date.now() + 20 * (attempt + 1);
      while (Date.now() < waitUntil) {
        /* tiny synchronous backoff */
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  throw lastErr;
}

export function readJsonSync(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    const value = parseMaybeSealed(file, raw);
    return value === undefined ? fallback : value;
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSONL append-only storage (sessions + audit)
// ---------------------------------------------------------------------------

export async function appendJsonl(file, record) {
  await appendText(file, `${JSON.stringify(record)}\n`);
}

/**
 * Read a JSONL file. Malformed lines (a torn write, a hand-edited file) are
 * skipped rather than thrown so one bad line cannot brick a conversation.
 */
export async function readJsonl(file, { limit = 0 } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip torn line */
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/** Last `n` records, cheaper to reason about than reading everything. */
export async function tailJsonl(file, n) {
  return readJsonl(file, { limit: n });
}

/**
 * Read only the *end* of a JSONL file.
 *
 * A session log grows forever, and the sidebar only wants the last meaningful
 * line, so slurping a multi-megabyte transcript to answer "what did this bot say
 * last" is the wrong shape of work. We stat the file, read the last
 * `windowBytes`, drop the first (possibly halved) line, and grow the window
 * when it contains no complete, parseable line at all (one giant tool output
 * can be wider than the window).
 *
 * Records come back oldest-first, like readJsonl; malformed lines are skipped.
 * `maxBytes` is the point where we give up rather than read the whole file.
 */
export async function readJsonlTail(file, { windowBytes = 32 * 1024, maxBytes = 2 * 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  try {
    const { size } = await handle.stat();
    if (!size) return [];

    let window = Math.min(size, Math.max(1, windowBytes));
    const cap = Math.min(size, Math.max(window, maxBytes));
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');

      if (start > 0) {
        // The window probably started mid-line; that fragment is not a record.
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }

      const records = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          /* a torn line, or the tail of a line we did not read from the top */
        }
      }

      // Stop when we have something to look at, when the window is the whole
      // file, or when we have hit the byte budget.
      if (records.length || start === 0 || window >= cap) return records;
      window = Math.min(cap, window * 2);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}


export async function listFiles(dir, filter = () => true) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter(filter).sort();
}

export function sessionFile(botId) {
  // Bot ids are slugs we generate; still, never let one escape the sessions dir.
  const safe = String(botId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.sessionsDir, `${safe}.jsonl`);
}

/** One JSON file per turn: data/turns/turn_<id>.json (crash-recovery record). */
export function turnFile(turnId) {
  const safe = String(turnId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(P.turnsDir, `${safe}.json`);
}

// ---------------------------------------------------------------------------
// In-process event bus (feeds SSE; kept in-process on purpose)
// ---------------------------------------------------------------------------

/**
 * Minimal pub/sub for agent events. The server subscribes and forwards to SSE
 * clients; the UI's Activity tab reads the same stream. We keep a small ring
 * buffer so a browser tab that connects mid-turn still sees recent context.
 */
export class EventBus {
  constructor({ bufferSize = 200 } = {}) {
    this.subscribers = new Set();
    this.buffer = [];
    this.bufferSize = bufferSize;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event) {
    const stamped = { ts: nowIso(), ...event };
    this.buffer.push(stamped);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const fn of this.subscribers) {
      try {
        fn(stamped);
      } catch {
        /* a broken subscriber must never break an agent turn */
      }
    }
    return stamped;
  }

  recent(limit = 50) {
    return this.buffer.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append one audit record. Every approval decision, every tool run and every
 * routine execution lands here; it is the answer to "why did it do that?".
 */
export async function audit(record) {
  const stamped = { ts: nowIso(), ...record };
  try {
    await appendJsonl(P.auditFile, stamped);
  } catch (err) {
    // Never let logging take down a turn.
    console.error('[audit] write failed:', err.message);
  }
  return stamped;
}

export async function readAudit({ limit = 100 } = {}) {
  const all = await readJsonl(P.auditFile);
  return all.slice(-limit).reverse();
}
