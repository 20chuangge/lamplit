/**
 * backup.mjs - one file that holds everything this machine's Lamplit knows (1.5.54).
 *
 * A computer that dies took the bots, their memory, the chat history, the
 * routines and the keys with it. The keys are sealed with a master key Windows
 * keeps for that one computer (store.mjs SEALED_FILES), so a copied data
 * folder opens nothing on another one. A backup is made for that:
 *
 *   LAMPLIT-BACKUP 1\n          what it is, and its format
 *   {header}\n                  counts, when, which machine, how it is locked (no names)
 *   ciphertext                  gzip of the entries, AES-256-GCM
 *   tag (16 bytes)              covers the two lines above too (AAD)
 *   length (8 bytes) LAMPLIT-END  how long the ciphertext is, and the end mark:
 *                               a file cut short is told before any password
 *
 * The key comes from a password the human sets (scrypt). Without it nothing
 * in the file reads: not a key, not a name, not a line of chat. The keys go
 * in opened (here, with this computer's master key) and are sealed again on
 * restore with the master key of the computer it is restored on; the vault's
 * own key is re-wrapped the same way, and on a merge the vault's entries are
 * re-encrypted with the vault key already there.
 *
 * Entries: config/…, skills/…, data/… (only the names classifyDataName lets
 * in), secret/<name> (key files, opened), desktop/machines.json and
 * view-prefs.json (the desktop app's machine list and look), workspace/… (if
 * asked). Pairings, logins to other machines, relay join secrets and anything
 * only valid on this computer stay out (NOT_INCLUDED says so on screen).
 *
 * Restoring stages the whole file first (and checks it: password, then the
 * tag), backs up what is here (恢复前自动备份, same password), and applies the
 * staged files at the next start, before anything is loaded - so nothing
 * running writes over what was just restored.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { P, readJson, writeJsonAtomic, writeFileAtomic, writeTextAtomic, masterKey, sealText, openSealed, plainRefused, untrusted, noteNow, nowIso } from './store.mjs';
import { unwrapVaultKey, wrapVaultKey } from './vault.mjs';

export const BACKUP_FORMAT = 1;
export const BACKUP_EXT = '.lamplit';
const MAGIC = 'LAMPLIT-BACKUP';
const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const MIN_PASSWORD = 8;
const MAX_HEADER = 64 * 1024;
const MAX_SECRET_BYTES = 16 * 1024 * 1024;
const END_MARK = Buffer.from('LAMPLIT-END', 'latin1');
const TRAILER = 16 + 8 + END_MARK.length; // tag, ciphertext length, end mark

const stateFile = () => path.join(P.dataDir, 'backup.json');
const keyFile = () => path.join(P.dataDir, 'backup-key.json');
const restoreDir = () => path.join(P.dataDir, '.restore');
const pendingFile = () => path.join(P.dataDir, 'restore-pending.json');
/** Where 恢复前自动备份 goes when no automatic-backup folder is set. */
export const defaultBackupDir = () => path.join(P.root, 'backups');

function backupError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const DAMAGED = () => backupError(400, 'BACKUP_DAMAGED', '这个备份文件坏了（不完整，或者被改过），没法恢复。换一个备份文件试试。');

// ---------------------------------------------------------------------------
// what goes in
// ---------------------------------------------------------------------------

/** Folders in data/ that go in whole. */
const DATA_DIRS = new Set(['memory', 'sessions', 'groups', 'avatars', 'deleted-bots']);
/** Files in data/ that go in as they are. */
const DATA_FILES = new Set([
  'routines.json', 'audit.jsonl', 'usage.jsonl', 'usage-settings.json', 'usage-budget.json', 'usage-alert.json', 'balance-history.json',
  'machine.json', 'machine-notes.json', 'initiative.json', 'bot-adjustments.json', 'former-bot-names.json', 'feishu-apps.json',
  'cliagents.json', 'attention.json', 'known-hosts.json', 'roster-order.json',
]);
/** Key files: opened here, sealed again where they are restored. */
const SECRET_FILES = new Set(['secrets.json', 'voice.json', 'media.json', 'vision.json', 'feishu.json', 'mcp.json', 'x-account.json', 'browser-logins.json', 'model-keys.json']);
const SECRET_PATTERNS = [/^feishu-app-[\w.-]+\.json$/];
/**
 * Left out on purpose. Pairings and tokens: phones and other machines pair
 * again. Relay secrets: a join is tied to this machine. The rest only means
 * something on this computer (its paths, its Windows account, its screen,
 * work in flight, the browser profiles Chrome locks to this computer).
 * The TightVNC passwords (tightvnc.json, 1.5.53) match this computer's own
 * TightVNC registry key, so they are not carried: on another computer they
 * would be wrong, and the hub would sign in to its screen with them. There
 * 体检's 「设好密码」 makes new ones; a restore here never touches the file
 * (vnc-secure-*.ps1 and vnc-control-*.txt hand it over for a few seconds to
 * the elevated script and to tvnserver's control commands).
 * The undo records (undo/, 1.5.54) point at this computer's workspace and the
 * copies kept beside them, so they stay here too.
 */
const SKIPPED = new Set([
  'security.json', 'devices.json', 'local-key', 'master.key', 'peers.json', 'peer-token.json', 'peer-rosters.json', 'peer-outbox.json',
  'relay-link.json', 'relay.json', 'relay-tls', 'tls', 'funnel.json', 'public-port.json', 'relay-update.json',
  'runner.json', 'runner', 'desktop.json', 'desktop-setup.json', 'vnc.json', 'desktops.passwd', 'phone.json', 'workspace.json',
  'screen.png', 'screen.json', 'turns', 'pending.json', 'browser-profile', 'browser-profiles', 'browser-state.json', 'browser-desktop.cmd',
  'tightvnc.json', 'undo', 'video-jobs.json', 'wire.jsonl', 'backup.json', 'backup-key.json', 'restore-pending.json', '.restore', 'lamplit-update.json', '.update',
  // 1.5.60: which key files this computer's key covers (sealed with it), and the browser's own download folder.
  'sealing.json', 'browser-downloads',
  // 1.5.61: what Lamplit last wrote in the files that decide what it trusts (F9), its own temporary files and the bots' own /tmp (F8).
  'trust.json', 'trust-sealed.json', 'tmp', 'sandbox-tmp',
  // A bot screen's VNC password (made new each time someone watches).
  'desktop-vnc',
]);
const SKIPPED_PATTERNS = [/^browser-state-[\w.-]+\.json$/, /^browser-bridge-[\w.-]+\.json$/, /^vnc-secure-/, /^vnc-control-/, /\.tmp$/, /\.partial(-\d+)?$/];

/** 'dir' | 'file' | 'secret' | 'vault' | 'vault-key' | 'skip', or null for a name this version does not know. */
export function classifyDataName(name) {
  const n = String(name || '');
  if (n === 'vault.json') return 'vault';
  if (n === 'vault.key') return 'vault-key';
  if (SECRET_FILES.has(n) || SECRET_PATTERNS.some((re) => re.test(n))) return 'secret';
  if (DATA_DIRS.has(n)) return 'dir';
  if (DATA_FILES.has(n)) return 'file';
  if (SKIPPED.has(n) || SKIPPED_PATTERNS.some((re) => re.test(n))) return 'skip';
  return null;
}

/** What a backup does not hold, said on the backup and restore screens. */
export const NOT_INCLUDED = [
  { key: 'devices', text: '配对过的手机和浏览器：恢复后在 设置 → 手机和外网 里重新配对一次。' },
  { key: 'machines', text: '和其他机器的连接：机器列表会恢复，但每台机器要在 设置 → 机器 里重新连一次。其他机器上的东西各自备份。' },
  { key: 'relay', text: '中转的加入信息：它绑在原来那台电脑上，换电脑后在 设置 → 手机和外网 里重新加入。' },
  { key: 'network', text: '「允许手机连接」、防火墙、Tailscale 这些电脑自己的设置：在新电脑上重新打开。' },
  { key: 'browser', text: '每个助手自己浏览器里登录过的网站：要重新登录一次（浏览器把登录锁在原来那台电脑上）。' },
  { key: 'runner', text: 'Windows 上给助手单独开的低权限账户：在新电脑上会重新建。' },
  { key: 'workspacePath', text: '自己选过的工作区位置：文件放回这台的工作区；想换位置，到设置里重新选。' },
  { key: 'screen', text: 'Windows 屏幕（TightVNC）的密码：它跟着这台电脑的屏幕服务，新电脑上到 设置 → 体检 点「设好密码」，Lamplit 会重新设一个。' },
  { key: 'schedule', text: '自动备份的设置和它的密码：每台电脑各自设。' },
];

/** A friendly name for each key file, for the restore screen. */
const SECRET_LABELS = {
  'secrets.json': '模型钥匙', 'model-keys.json': '其他模型的钥匙', 'voice.json': '语音输入', 'vision.json': '识图', 'media.json': '生成图片和视频',
  'feishu.json': '飞书', 'mcp.json': '连接的应用', 'x-account.json': 'X（推特）', 'browser-logins.json': '共用的网站登录', 'vault.key': '保险箱',
};
const secretLabel = (name) => SECRET_LABELS[name] || (/^feishu-app-/.test(name) ? '助手自己的飞书应用' : name);

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

export function checkPassword(password) {
  const p = String(password ?? '');
  if (p.length < MIN_PASSWORD) throw backupError(400, 'BACKUP_PASSWORD_SHORT', `备份密码至少 ${MIN_PASSWORD} 位。要记住它：恢复时要用，忘了就打不开。`);
  if (p.length > 1024) throw backupError(400, 'BACKUP_PASSWORD_LONG', '密码太长了');
  return p;
}

function goodKdf(kdf) {
  const N = Number(kdf?.N);
  const r = Number(kdf?.r);
  const p = Number(kdf?.p);
  return kdf?.name === 'scrypt' && Number.isInteger(Math.log2(N)) && N >= 2 ** 14 && N <= 2 ** 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4 && typeof kdf.salt === 'string';
}

/** {enc: the AES key, check: a value that tells a wrong password from a damaged file}. */
export async function deriveKeys(password, kdf) {
  if (!goodKdf(kdf)) throw DAMAGED();
  const out = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), Buffer.from(kdf.salt, 'base64'), 64, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 16 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return { kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt }, enc: out.subarray(0, 32), check: crypto.createHash('sha256').update(out.subarray(32)).digest('base64').slice(0, 22) };
}

export async function newKeys(password) {
  return deriveKeys(checkPassword(password), { ...KDF, salt: crypto.randomBytes(16).toString('base64') });
}

// ---------------------------------------------------------------------------
// walking what is here
// ---------------------------------------------------------------------------

const slash = (p) => p.split(path.sep).join('/');

async function walk(dir, prefix, out, { skipDirs = new Set(), limit = Infinity } = {}) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (out.length >= limit) return;
    const abs = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue; // never follow a link out
    if (d.isDirectory()) {
      if (skipDirs.has(d.name)) continue;
      await walk(abs, `${prefix}${d.name}/`, out, { skipDirs, limit });
    } else if (d.isFile() && !/\.tmp$/.test(d.name)) {
      out.push({ p: `${prefix}${d.name}`, abs });
    }
  }
}

const WORKSPACE_SKIP = new Set(['.browser-profile']);

/** How big the workspace is: {path, files, bytes, partial} (stops after capMs or capFiles). */
export async function workspaceSize({ capFiles = 200000, capMs = 4000 } = {}) {
  const start = Date.now();
  let files = 0;
  let bytes = 0;
  let partial = false;
  const stack = [P.workspaceDir];
  while (stack.length) {
    if (files >= capFiles || Date.now() - start > capMs) { partial = true; break; }
    const dir = stack.pop();
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of list) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!WORKSPACE_SKIP.has(d.name)) stack.push(abs); continue; }
      if (!d.isFile()) continue;
      files += 1;
      try { bytes += (await fsp.stat(abs)).size; } catch { /* gone */ }
    }
  }
  return { path: P.workspaceDir, files, bytes, partial };
}

/** The opened text of a key file, or null when this computer cannot open it. */
async function openKeyFile(abs) {
  const raw = await fsp.readFile(abs, 'utf8');
  if (untrusted(abs, raw)) return null; // 1.5.61 (F9): not what Lamplit wrote there, not carried into a backup
  let value;
  try { value = JSON.parse(raw); } catch { return raw; }
  // A plain key file this computer's key already covers is not Lamplit's (1.5.60, F6): not carried into a backup either.
  if (!value || typeof value !== 'object' || !value.lamplitSealed) return plainRefused(abs, value) ? null : raw;
  return openSealed(value);
}

/**
 * Everything that goes in: [{p, abs} | {p, data}], plus the counts for the
 * header and what could not be opened. `workspace`: false, true (all of it),
 * or a Set of workspace-relative paths (the files a restore will replace).
 */
export async function collectEntries({ workspace = false } = {}) {
  const entries = [];
  const warnings = [];
  const unknown = [];
  await walk(P.configDir, 'config/', entries);
  await walk(P.skillsDir, 'skills/', entries);
  let names = [];
  try { names = (await fsp.readdir(P.dataDir, { withFileTypes: true })).filter((d) => !d.isSymbolicLink()); } catch { /* no data yet */ }
  let vaultKeyOk = true;
  for (const d of names) {
    const kind = classifyDataName(d.name);
    const abs = path.join(P.dataDir, d.name);
    if (kind === 'dir' && d.isDirectory()) await walk(abs, `data/${d.name}/`, entries);
    else if ((kind === 'file' || kind === 'vault') && d.isFile()) entries.push({ p: `data/${d.name}`, abs });
    else if (kind === 'secret' && d.isFile()) {
      const text = await openKeyFile(abs).catch(() => null);
      if (text === null) warnings.push(`${secretLabel(d.name)}（${d.name}）在这台电脑上打不开，没放进备份`);
      else entries.push({ p: `secret/${d.name}`, data: Buffer.from(text, 'utf8') });
    } else if (kind === 'vault-key' && d.isFile()) {
      const raw = unwrapVaultKey(await fsp.readFile(abs).catch(() => null));
      if (raw) entries.push({ p: 'secret/vault.key', data: raw });
      else { vaultKeyOk = false; warnings.push('保险箱的钥匙在这台电脑上打不开，保险箱没放进备份'); }
    } else if (kind === null) unknown.push(d.name);
  }
  // A vault whose key does not open here is no use anywhere: leave it out too.
  if (!vaultKeyOk) {
    const i = entries.findIndex((e) => e.p === 'data/vault.json');
    if (i >= 0) entries.splice(i, 1);
  }
  for (const name of ['machines.json', 'view-prefs.json']) {
    const abs = path.join(P.root, name);
    if (fs.existsSync(abs)) entries.push({ p: `desktop/${name}`, abs });
  }
  if (workspace) {
    const ws = [];
    await walk(P.workspaceDir, 'workspace/', ws, { skipDirs: WORKSPACE_SKIP });
    entries.push(...(workspace instanceof Set ? ws.filter((e) => workspace.has(e.p.slice('workspace/'.length))) : ws));
  }
  return { entries, warnings, unknown };
}

async function jsonOf(entry) {
  try { return JSON.parse(entry.data ? entry.data.toString('utf8') : await fsp.readFile(entry.abs, 'utf8')); } catch { return null; }
}

/** Counts (no names) for the header and the screens. */
export async function countEntries(entries) {
  const n = (re) => entries.filter((e) => re.test(e.p)).length;
  const find = (p) => entries.find((e) => e.p === p);
  const routines = find('data/routines.json') ? (await jsonOf(find('data/routines.json')))?.routines?.length || 0 : 0;
  const vault = find('data/vault.json') && find('secret/vault.key') ? (await jsonOf(find('data/vault.json')))?.entries?.length || 0 : 0;
  let workspaceBytes = 0;
  const ws = entries.filter((e) => e.p.startsWith('workspace/'));
  for (const e of ws) { try { workspaceBytes += (await fsp.stat(e.abs)).size; } catch { /* gone */ } }
  return {
    bots: n(/^config\/bots\/[^/]+\.json$/),
    groups: n(/^data\/groups\/[^/]+\.json$/),
    routines,
    memory: n(/^data\/memory\/.+\.md$/),
    sessions: n(/^data\/sessions\/[^/]+\.jsonl$/),
    skills: n(/^skills\/.+\.md$/),
    vault,
    secrets: n(/^secret\/(?!vault\.key$)/),
    workspaceFiles: ws.length,
    workspaceBytes,
  };
}

// ---------------------------------------------------------------------------
// writing a backup
// ---------------------------------------------------------------------------

async function* frames(entries, warnings) {
  for (const e of entries) {
    let handle = null;
    let size = 0;
    if (e.data) size = e.data.length;
    else {
      try {
        handle = await fsp.open(e.abs, 'r');
        size = (await handle.stat()).size;
      } catch {
        await handle?.close().catch(() => {});
        warnings.push(`读不了：${e.p}`);
        continue;
      }
    }
    const head = Buffer.from(JSON.stringify({ p: e.p, n: size }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    yield Buffer.concat([len, head]);
    if (e.data) { yield e.data; continue; }
    try {
      let sent = 0;
      const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)));
      while (sent < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - sent), sent);
        if (!bytesRead) break;
        sent += bytesRead;
        yield Buffer.from(buf.subarray(0, bytesRead));
      }
      // The file got shorter while it was read: the frame still says `size`.
      if (sent < size) { warnings.push(`读的时候变短了：${e.p}`); yield Buffer.alloc(size - sent); }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  yield Buffer.alloc(4); // a zero length: the end
}

function headerBytes(header) {
  return Buffer.from(`${MAGIC} ${BACKUP_FORMAT}\n${JSON.stringify(header)}\n`, 'utf8');
}

/**
 * Write one backup to `to` (via a .partial file, renamed at the end).
 * keys: from newKeys(password) or kept (automatic, 恢复前自动备份).
 * -> {file, bytes, counts, warnings, header}
 */
export async function writeBackup({ to, keys, workspace = false, kind = 'manual', appVersion = '', machine = '' }) {
  const { entries, warnings, unknown } = await collectEntries({ workspace });
  const counts = await countEntries(entries);
  const iv = crypto.randomBytes(12);
  const header = {
    format: BACKUP_FORMAT,
    app: 'Lamplit',
    appVersion,
    createdAt: nowIso(),
    machine: String(machine || '').slice(0, 60),
    kind,
    includesWorkspace: Boolean(workspace),
    counts,
    kdf: keys.kdf,
    check: keys.check,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ...(unknown.length ? { unknownLeftOut: unknown.length } : {}),
  };
  const head = headerBytes(header);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.partial-${process.pid}`;
  try {
    await fsp.writeFile(tmp, head);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
    cipher.setAAD(head);
    const written = [];
    await pipeline(Readable.from(frames(entries, written)), zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(tmp, { flags: 'a' }));
    warnings.push(...written);
    const ctLength = (await fsp.stat(tmp)).size - head.length;
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(ctLength));
    await fsp.appendFile(tmp, Buffer.concat([cipher.getAuthTag(), len, END_MARK]));
    await renameOver(tmp, to);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const bytes = (await fsp.stat(to)).size;
  return { file: to, bytes, counts, warnings, header };
}

async function renameOver(from, to) {
  for (let i = 0; i < 5; i += 1) {
    try { await fsp.rename(from, to); return; } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(err.code) || i === 4) throw err;
      await new Promise((r) => setTimeout(r, 30 * (i + 1)));
    }
  }
}

/** 20261121-153005, local time. */
export function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim().slice(0, 40);

/** A name nothing has yet in that folder: Lamplit-备份-客厅电脑-20261121-153005.lamplit */
export function freeName(dir, base) {
  let name = `${base}${BACKUP_EXT}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = `${base}-${i}${BACKUP_EXT}`;
  return name;
}
export const manualName = (machine) => `Lamplit-备份${safeName(machine) ? `-${safeName(machine)}` : ''}-${stamp()}`;

// ---------------------------------------------------------------------------
// reading one
// ---------------------------------------------------------------------------

/** The two plain lines: -> {header, head (Buffer), offset, size}. Refuses what is not a backup, or newer. */
export async function readHeader(file) {
  let handle;
  try { handle = await fsp.open(file, 'r'); } catch { throw backupError(400, 'BACKUP_NOT_FOUND', '找不到这个备份文件'); }
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(Math.min(size, MAX_HEADER));
    await handle.read(buf, 0, buf.length, 0);
    const text = buf.toString('latin1');
    if (!text.startsWith(`${MAGIC} `)) throw backupError(400, 'BACKUP_NOT_A_BACKUP', '这不是 Lamplit 的备份文件（应该是 .lamplit 结尾、用「备份到文件」做的）。');
    const nl1 = text.indexOf('\n');
    const format = Number(text.slice(MAGIC.length + 1, nl1 < 0 ? 40 : nl1).trim());
    if (nl1 < 0 || !Number.isInteger(format) || format < 1) throw DAMAGED();
    const nl2 = text.indexOf('\n', nl1 + 1);
    let header = null;
    try { header = JSON.parse(buf.subarray(nl1 + 1, nl2 < 0 ? undefined : nl2).toString('utf8')); } catch { /* below */ }
    if (format > BACKUP_FORMAT) {
      const v = header?.appVersion ? `（Lamplit ${String(header.appVersion).slice(0, 20)}）` : '';
      throw backupError(400, 'BACKUP_TOO_NEW', `这个备份是更新版本的 Lamplit${v}做的，这台的 Lamplit 读不了。先把这台更新到最新版（设置 → 关于 → 检查更新），再恢复。`);
    }
    if (nl2 < 0 || !header || typeof header !== 'object' || size < nl2 + 1 + TRAILER) throw DAMAGED();
    // The end: a file cut short (a copy that stopped half way) is refused here, before the password.
    const tail = Buffer.alloc(TRAILER);
    await handle.read(tail, 0, TRAILER, size - TRAILER);
    const offset = nl2 + 1;
    if (!tail.subarray(24).equals(END_MARK) || Number(tail.readBigUInt64BE(16)) !== size - offset - TRAILER) throw DAMAGED();
    return { header, head: buf.subarray(0, offset), offset, size, tag: tail.subarray(0, 16), ctEnd: size - TRAILER };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** What the screens show before the password: no names, just what and when. */
export function summary(header) {
  return {
    format: header.format,
    appVersion: header.appVersion || '',
    createdAt: header.createdAt || '',
    machine: header.machine || '',
    kind: header.kind || 'manual',
    includesWorkspace: Boolean(header.includesWorkspace),
    counts: header.counts || {},
  };
}

const LOGICAL = /^(config|skills|data|secret|desktop|workspace)\/[^\u0000]+$/;
/** A path from the file, or null when it could escape (or is not ours). */
function safeLogical(p) {
  if (typeof p !== 'string' || p.length > 1000 || !LOGICAL.test(p) || p.includes('\\')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || /^[a-zA-Z]:$/.test(s))) return null;
  if (parts[0] === 'secret') {
    const kind = parts.length === 2 ? classifyDataName(parts[1]) : null;
    return kind === 'secret' || kind === 'vault-key' ? p : null;
  }
  if (parts[0] === 'data') {
    const kind = classifyDataName(parts[1]);
    if (kind === 'dir' ? parts.length < 3 : !(['file', 'vault'].includes(kind) && parts.length === 2)) return null;
  }
  if (parts[0] === 'desktop' && !(parts.length === 2 && ['machines.json', 'view-prefs.json'].includes(parts[1]))) return null;
  return p;
}

/** Takes the decrypted, gunzipped frames apart into a folder (keys into memory). */
class FrameSink extends Writable {
  constructor(dir) {
    super();
    this.dir = dir;
    this.buf = Buffer.alloc(0);
    this.need = 4;
    this.stage = 'len';
    this.cur = null;
    this.left = 0;
    this.ended = false;
    this.files = [];
    this.secrets = new Map();
  }

  async take(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.ended) { if (this.buf.length) throw DAMAGED(); return; }
      if (this.stage === 'body') {
        if (!this.buf.length && this.left) return;
        const part = this.buf.subarray(0, this.left);
        this.buf = this.buf.subarray(part.length);
        this.left -= part.length;
        if (this.cur.handle) await this.cur.handle.write(part);
        else this.cur.chunks.push(part);
        if (this.left) return;
        if (this.cur.handle) await this.cur.handle.close();
        else this.secrets.set(this.cur.p.slice('secret/'.length), Buffer.concat(this.cur.chunks));
        this.files.push({ p: this.cur.p, n: this.cur.n });
        this.cur = null;
        this.stage = 'len';
        this.need = 4;
        continue;
      }
      if (this.buf.length < this.need) return;
      if (this.stage === 'len') {
        const n = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        if (n === 0) { this.ended = true; continue; }
        if (n > 4096) throw DAMAGED();
        this.stage = 'head';
        this.need = n;
        continue;
      }
      // head
      let meta;
      try { meta = JSON.parse(this.buf.subarray(0, this.need).toString('utf8')); } catch { throw DAMAGED(); }
      this.buf = this.buf.subarray(this.need);
      const p = safeLogical(meta?.p);
      const n = Number(meta?.n);
      if (!p || !Number.isSafeInteger(n) || n < 0) throw DAMAGED();
      if (p.startsWith('secret/')) {
        if (n > MAX_SECRET_BYTES) throw DAMAGED();
        this.cur = { p, n, chunks: [] };
      } else {
        const abs = path.join(this.dir, ...p.split('/'));
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        this.cur = { p, n, handle: await fsp.open(abs, 'w') };
      }
      this.left = n;
      this.stage = 'body';
      if (!n) continue;
    }
  }

  _write(chunk, _enc, done) { this.take(chunk).then(() => done(), done); }

  _final(done) {
    if (!this.ended || this.stage !== 'len') return done(DAMAGED());
    done();
  }

  _destroy(err, done) {
    this.cur?.handle?.close().catch(() => {});
    done(err);
  }
}

/** Check the password, decrypt and check the whole file into `dir`. -> {header, keys, files, secrets} */
export async function openBackup(file, password, dir) {
  const { header, head, offset, tag, ctEnd } = await readHeader(file);
  if (header.cipher !== 'aes-256-gcm' || typeof header.iv !== 'string' || typeof header.check !== 'string') throw DAMAGED();
  const keys = await deriveKeys(String(password ?? ''), header.kdf);
  if (keys.check !== header.check) throw backupError(400, 'BACKUP_WRONG_PASSWORD', '密码不对。要用做这个备份时设的那个密码。');
  let decipher;
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(head);
    decipher.setAuthTag(tag);
  } catch { throw DAMAGED(); }
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const sink = new FrameSink(dir);
  try {
    const source = ctEnd > offset ? fs.createReadStream(file, { start: offset, end: ctEnd - 1 }) : Readable.from([]);
    await pipeline(source, decipher, zlib.createGunzip(), sink);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err?.code === 'BACKUP_DAMAGED' || /auth|unable to authenticate|unexpected end|incorrect header|invalid|zlib|Z_/i.test(String(err?.message || '')) || err?.code?.startsWith?.('Z_') || err?.code === 'ERR_CRYPTO_INVALID_STATE') throw DAMAGED();
    throw err;
  }
  return { header, keys, files: sink.files, secrets: sink.secrets };
}

// ---------------------------------------------------------------------------
// what is here now
// ---------------------------------------------------------------------------

/** Counts of what is here, and whether it is still as installed (one bot, nothing said). */
export async function currentState() {
  const { entries } = await collectEntries({ workspace: false });
  const counts = await countEntries(entries);
  const fresh = counts.bots <= 1 && counts.sessions === 0 && counts.groups === 0 && counts.routines === 0 && counts.memory === 0 && counts.vault === 0;
  return { counts, fresh };
}

// ---------------------------------------------------------------------------
// backup.json: last backup, schedule, last restore
// ---------------------------------------------------------------------------

export async function loadState() {
  const raw = await readJson(stateFile(), {});
  return raw && typeof raw === 'object' ? raw : {};
}
export async function saveState(patch) {
  const next = { ...(await loadState()), ...patch, updatedAt: nowIso() };
  await writeJsonAtomic(stateFile(), next);
  return next;
}

/** The kept key for automatic backups (sealed: backup-key.json is in SEALED_FILES). */
export async function keptKeys() {
  const raw = await readJson(keyFile(), null);
  if (!raw?.enc || !raw?.kdf || !raw?.check) return null;
  return { kdf: raw.kdf, enc: Buffer.from(raw.enc, 'base64'), check: raw.check };
}
export async function keepKeys(keys) {
  await writeJsonAtomic(keyFile(), { kdf: keys.kdf, enc: keys.enc.toString('base64'), check: keys.check, savedAt: nowIso() });
  try { await fsp.chmod(keyFile(), 0o600); } catch { /* Windows */ }
}
export async function forgetKeys() {
  await fsp.rm(keyFile(), { force: true });
}

/** A folder the human picked: absolute, makeable, writable, not Lamplit's own data or the bots' workspace. */
export function checkFolder(raw) {
  const dir = String(raw || '').trim();
  if (!dir || !path.isAbsolute(dir)) throw backupError(400, 'BACKUP_BAD_FOLDER', '选一个文件夹（要完整的路径，比如 D:\\备份）');
  const abs = path.resolve(dir);
  const inside = (a, b) => { const x = path.resolve(a).toLowerCase(); const y = path.resolve(b).toLowerCase(); return x === y || x.startsWith(y + path.sep); };
  if (inside(abs, P.dataDir)) throw backupError(400, 'BACKUP_BAD_FOLDER', '不能放在 Lamplit 自己的数据文件夹里');
  if (inside(abs, P.workspaceDir)) throw backupError(400, 'BACKUP_BAD_FOLDER', '不能放在助手们的工作区里（助手能改那里的文件）');
  try {
    fs.mkdirSync(abs, { recursive: true });
    const probe = path.join(abs, `.lamplit-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw backupError(400, 'BACKUP_FOLDER_NOT_WRITABLE', `这个文件夹建不了或写不进去：${err.message}`);
  }
  return abs;
}

/** A file path the desktop app's save dialog gave: a .lamplit file in a folder checkFolder accepts. */
export function checkSavePath(raw) {
  const file = String(raw || '').trim();
  if (!file || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== BACKUP_EXT) throw backupError(400, 'BACKUP_BAD_PATH', '备份文件要以 .lamplit 结尾');
  checkFolder(path.dirname(file));
  return path.resolve(file);
}

const AUTO_PREFIX = 'Lamplit-自动备份-';
const PRE_PREFIX = 'Lamplit-恢复前自动备份-';

/** Keep the newest `keep` automatic backups in `dir` (only files with our own name). -> removed names */
export async function pruneAuto(dir, keep) {
  const n = Math.max(1, Math.min(100, Number(keep) || 7));
  const mine = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith(BACKUP_EXT)).sort();
  const gone = mine.slice(0, Math.max(0, mine.length - n));
  for (const f of gone) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
  return gone;
}

/** One automatic backup now, with the kept key. */
export async function runAutoBackup({ appVersion, machine }) {
  const st = await loadState();
  const sched = st.schedule || {};
  const keys = await keptKeys();
  if (!sched.folder || !keys) throw backupError(400, 'BACKUP_NOT_SCHEDULED', '自动备份还没设好（要选文件夹和设密码）');
  const at = nowIso();
  try {
    const dir = checkFolder(sched.folder);
    const name = freeName(dir, `${AUTO_PREFIX}${stamp()}`);
    const out = await writeBackup({ to: path.join(dir, name), keys, workspace: Boolean(sched.includeWorkspace), kind: 'auto', appVersion, machine });
    const removed = await pruneAuto(dir, sched.keep);
    const done = { at, ok: true, file: out.file, bytes: out.bytes, warnings: out.warnings.slice(0, 10) };
    await saveState({ schedule: { ...sched, lastAuto: done }, lastBackup: { at, bytes: out.bytes, kind: 'auto', file: out.file } });
    return { ...done, removed: removed.length };
  } catch (err) {
    await saveState({ schedule: { ...sched, lastAuto: { at, ok: false, error: String(err.message || err).slice(0, 300) } } });
    throw err;
  }
}

/** Every 10 minutes: is an automatic backup due? (Also a minute after start.) */
export function startScheduler({ info, log = () => {} }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const st = await loadState();
      const s = st.schedule;
      if (!s?.enabled || !s.folder) return;
      const every = Math.max(1, Math.min(24 * 30, Number(s.everyHours) || 24)) * 3600 * 1000;
      const last = Date.parse(s.lastAuto?.at || '') || 0;
      // A failed one is tried again after an hour, not every 10 minutes.
      const wait = s.lastAuto && !s.lastAuto.ok ? Math.min(every, 3600 * 1000) : every;
      if (Date.now() - last < wait) return;
      await runAutoBackup(info());
      log('automatic backup written');
    } catch (err) {
      log(`automatic backup failed: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 60 * 1000);
  const timer = setInterval(tick, 10 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ---------------------------------------------------------------------------
// restoring: stage, then apply at the next start
// ---------------------------------------------------------------------------

const staged = new Map(); // id -> {dir, header, keys, files, secrets, at}
const STAGE_TTL = 60 * 60 * 1000;

function dropOld() {
  for (const [id, s] of staged) {
    if (Date.now() - s.at > STAGE_TTL) { staged.delete(id); fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {}); }
  }
}

/** Where an upload goes (inside data/, which bots' file tools cannot reach). */
export async function uploadTarget() {
  await fsp.mkdir(restoreDir(), { recursive: true });
  const id = `up_${crypto.randomBytes(8).toString('hex')}`;
  return { id, file: path.join(restoreDir(), `${id}${BACKUP_EXT}`) };
}
export function uploadFile(id) {
  if (!/^up_[0-9a-f]{16}$/.test(String(id || ''))) return null;
  const file = path.join(restoreDir(), `${id}${BACKUP_EXT}`);
  return fs.existsSync(file) ? file : null;
}

async function readBots(dir) {
  const botsDir = path.join(dir, 'config', 'bots');
  const out = [];
  for (const f of await fsp.readdir(botsDir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try { const b = JSON.parse(await fsp.readFile(path.join(botsDir, f), 'utf8')); out.push({ id: b.id || f.slice(0, -5), name: String(b.name || f.slice(0, -5)) }); } catch { /* not a bot */ }
  }
  return out;
}

/** Open (password), check and stage a backup. -> what the restore screen shows. */
export async function inspect(file, password) {
  dropOld();
  const id = `rs_${crypto.randomBytes(8).toString('hex')}`;
  const dir = path.join(restoreDir(), id);
  const opened = await openBackup(file, password, path.join(dir, 'files'));
  staged.set(id, { dir, at: Date.now(), ...opened });
  const bots = await readBots(path.join(dir, 'files'));
  const ws = opened.files.filter((f) => f.p.startsWith('workspace/'));
  return {
    id,
    backup: summary(opened.header),
    contents: {
      bots: bots.map((b) => b.name),
      counts: opened.header.counts || {},
      secrets: [...opened.secrets.keys()].map(secretLabel),
      workspace: { files: ws.length, bytes: ws.reduce((a, f) => a + f.n, 0) },
      machines: opened.files.some((f) => f.p === 'desktop/machines.json'),
    },
    current: await currentState(),
    notIncluded: NOT_INCLUDED,
  };
}

export async function cancel(id) {
  const s = staged.get(id);
  staged.delete(id);
  if (s) await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

/**
 * The human said yes: back up what is here (恢复前自动备份, same password),
 * leave the staged keys sealed for the next start, mark it pending.
 * -> {preBackup:{file}}; the caller restarts the hub.
 */
export async function prepareApply(id, { mode, workspace = false, appVersion = '', machine = '' }) {
  const s = staged.get(id);
  if (!s) throw backupError(404, 'RESTORE_EXPIRED', '这个备份已经关掉了（打开太久，或者 Lamplit 重启过）。重新选一次备份文件。');
  if (mode !== 'replace' && mode !== 'merge') throw backupError(400, 'RESTORE_BAD_MODE', '选「换成备份里的」还是「合并」');
  const wsFiles = s.files.filter((f) => f.p.startsWith('workspace/')).map((f) => f.p.slice('workspace/'.length));
  const useWorkspace = Boolean(workspace) && wsFiles.length > 0;
  // What would be written over in the workspace goes in the copy from before (replace only).
  const wsOver = useWorkspace && mode === 'replace' ? new Set(wsFiles.filter((r) => fs.existsSync(path.join(P.workspaceDir, ...r.split('/'))))) : false;
  const st = await loadState();
  const folder = (() => { try { return st.schedule?.folder ? checkFolder(st.schedule.folder) : null; } catch { return null; } })() || defaultBackupDir();
  await fsp.mkdir(folder, { recursive: true });
  const pre = await writeBackup({ to: path.join(folder, freeName(folder, `${PRE_PREFIX}${stamp()}`)), keys: s.keys, workspace: wsOver && wsOver.size ? wsOver : false, kind: 'pre-restore', appVersion, machine });
  // The keys wait for the next start sealed with this computer's master key (plain only where every key file is plain anyway).
  const secrets = Object.fromEntries([...s.secrets].map(([k, v]) => [k, v.toString('base64')]));
  const mk = masterKey();
  await writeTextAtomic(path.join(s.dir, 'secrets.json'), mk ? sealText(JSON.stringify(secrets), mk) : `${JSON.stringify(secrets)}\n`);
  const plan = { id, mode, workspace: useWorkspace, preBackup: pre.file, from: summary(s.header), at: nowIso() };
  await writeTextAtomic(path.join(s.dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await writeTextAtomic(pendingFile(), `${JSON.stringify({ id, dir: path.relative(P.dataDir, s.dir) })}\n`);
  staged.delete(id); // its folder stays until the next start applies it
  return { preBackup: { file: pre.file, bytes: pre.bytes } };
}

// --- applying (at start) ----------------------------------------------------------

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.rename(from, to); } catch {
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true }).catch(() => {});
  }
  noteNow(to); // 1.5.61 (F9): a file Lamplit restored into data/ is Lamplit's
}

async function listStaged(root) {
  const out = [];
  await walk(root, '', out);
  return out.map((e) => e.p);
}

const vaultOpen = (key, box) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
};
const vaultSeal = (key, value) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
};

/**
 * At start, before anything is loaded: put a staged restore in place.
 *   replace - bots, skills, memory, chats, groups, avatars become the backup's;
 *             every other file the backup has replaces the one here; files it
 *             does not have stay.
 *   merge   - what is here stays; only what is not here is added (bots by id
 *             and name, with their chats and memory; routines by id; vault
 *             entries by name, re-encrypted with the vault key here).
 * The workspace (if asked) is only ever written to, never cleared.
 * -> the result (also kept in backup.json lastRestore), or null when nothing waits.
 */
export async function applyPendingRestore() {
  let pending;
  try {
    const raw = await fsp.readFile(pendingFile(), 'utf8');
    // 1.5.61 (F9): a restore-pending.json Lamplit did not write (the restore it names would rewrite config/, data/ and the workspace) is not done.
    if (untrusted(pendingFile(), raw)) return null;
    pending = JSON.parse(raw);
  } catch { return null; }
  const dir = path.resolve(P.dataDir, String(pending?.dir || ''));
  const problems = [];
  let plan = null;
  const restored = { bots: 0, files: 0, secrets: 0, vault: 0, routines: 0, workspaceFiles: 0, kept: 0 };
  try {
    if (!dir.startsWith(path.resolve(restoreDir()) + path.sep)) throw new Error('restore folder outside data/.restore');
    plan = JSON.parse(await fsp.readFile(path.join(dir, 'plan.json'), 'utf8'));
    const rawSecrets = await fsp.readFile(path.join(dir, 'secrets.json'), 'utf8');
    let secretsJson = JSON.parse(rawSecrets);
    if (secretsJson?.lamplitSealed) secretsJson = JSON.parse(openSealed(secretsJson) || 'null');
    if (!secretsJson) throw new Error('the staged keys cannot be opened with this computer\'s master key');
    const secrets = new Map(Object.entries(secretsJson).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    const files = path.join(dir, 'files');
    const all = await listStaged(files);
    const merge = plan.mode === 'merge';
    const target = (p) => {
      const [top, ...rest] = p.split('/');
      const base = { config: P.configDir, skills: P.skillsDir, data: P.dataDir, desktop: P.root, workspace: P.workspaceDir }[top];
      return base ? path.join(base, ...rest) : null;
    };
    const put = async (p) => { await moveFile(path.join(files, ...p.split('/')), target(p)); restored.files += 1; };

    // Bots: which come in (merge: new id and a name not taken here).
    const botFiles = all.filter((p) => /^config\/bots\/[^/]+\.json$/.test(p));
    const hereBots = [];
    for (const f of await fsp.readdir(P.botsDir).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try { const b = JSON.parse(await fsp.readFile(path.join(P.botsDir, f), 'utf8')); hereBots.push({ id: b.id || f.slice(0, -5), name: String(b.name || '') }); } catch { /* skip */ }
    }
    const incoming = new Set();
    for (const p of botFiles) {
      let b = {};
      try { b = JSON.parse(await fsp.readFile(path.join(files, ...p.split('/')), 'utf8')); } catch { /* by file name */ }
      const id = b.id || path.basename(p, '.json');
      if (merge && hereBots.some((h) => h.id === id || (b.name && h.name === b.name))) { restored.kept += 1; continue; }
      incoming.add(id);
    }
    const idOf = (name) => name.replace(/\.(jsonl|json|png|jpe?g|webp|gif|md)$/i, '');
    const followsBot = (p) => {
      const m = /^data\/(sessions|avatars)\/([^/]+)$/.exec(p) || /^data\/memory\/([^/]+)\/.+$/.exec(p);
      if (!m) return null;
      return m.length === 3 ? idOf(m[2]) : m[1];
    };

    // replace: the folders that become the backup's are emptied first (they are in 恢复前自动备份).
    if (!merge) {
      for (const d of [P.botsDir, P.skillsDir, P.memoryDir, P.sessionsDir, P.groupsDir, P.avatarsDir, path.join(P.dataDir, 'deleted-bots')]) {
        await fsp.rm(d, { recursive: true, force: true }).catch((err) => problems.push(`清不掉 ${path.basename(d)}：${err.message}`));
        await fsp.mkdir(d, { recursive: true }).catch(() => {});
      }
    }

    for (const p of all) {
      if (p === 'data/routines.json' || p === 'data/vault.json' || p === 'desktop/machines.json') continue; // below
      if (p.startsWith('workspace/') && !plan.workspace) continue;
      const to = target(p);
      if (!to) continue;
      if (/^config\/bots\//.test(p)) {
        const id = path.basename(p, '.json');
        let real = id;
        try { real = JSON.parse(await fsp.readFile(path.join(files, ...p.split('/')), 'utf8')).id || id; } catch { /* by name */ }
        if (!incoming.has(real)) continue;
        await put(p);
        restored.bots += 1;
        continue;
      }
      const botId = followsBot(p);
      if (merge && botId !== null) {
        if (!incoming.has(botId) || fs.existsSync(to)) { restored.kept += 1; continue; }
        await put(p);
        continue;
      }
      if (merge && fs.existsSync(to)) { restored.kept += 1; continue; }
      await put(p);
      if (p.startsWith('workspace/')) restored.workspaceFiles += 1;
    }

    // Routines: replace takes the backup's list; merge adds the ones whose id is not here.
    if (all.includes('data/routines.json')) {
      const theirs = JSON.parse(await fsp.readFile(path.join(files, 'data', 'routines.json'), 'utf8'))?.routines || [];
      const ours = merge ? (await readJson(P.routinesFile, { routines: [] }))?.routines || [] : [];
      const add = theirs.filter((r) => r?.id && !ours.some((o) => o.id === r.id));
      await writeJsonAtomic(P.routinesFile, { routines: [...ours, ...add] });
      restored.routines = add.length;
    }

    // Machines (the desktop app's list): merged by address either way - nothing in it is a secret.
    if (all.includes('desktop/machines.json')) {
      const theirs = JSON.parse(await fsp.readFile(path.join(files, 'desktop', 'machines.json'), 'utf8'));
      let ours = [];
      try { ours = JSON.parse(await fsp.readFile(path.join(P.root, 'machines.json'), 'utf8')); } catch { /* none */ }
      const list = [...(Array.isArray(ours) ? ours : [])];
      for (const m of Array.isArray(theirs) ? theirs : []) if (m?.url && !list.some((o) => o.url === m.url)) list.push(m);
      await writeTextAtomic(path.join(P.root, 'machines.json'), `${JSON.stringify(list, null, 2)}\n`);
    }

    // Key files: sealed again with this computer's master key (writeJsonAtomic does it for SEALED_FILES).
    for (const [name, bytes] of secrets) {
      if (name === 'vault.key') continue;
      const to = path.join(P.dataDir, name);
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); } catch { problems.push(`${secretLabel(name)} 读不了，没恢复`); continue; }
      try {
        if (name === 'model-keys.json' && merge) {
          const here = (await readJson(to, {})) || {};
          await writeJsonAtomic(to, { ...value, ...here });
        } else if (merge && fs.existsSync(to)) {
          // What is here stays - also a key file this computer cannot open (it is not ours to throw away).
          restored.kept += 1;
          continue;
        } else {
          await writeJsonAtomic(to, value);
        }
        restored.secrets += 1;
      } catch (err) {
        problems.push(`${secretLabel(name)} 没写进去：${err.message}`);
      }
    }

    // The vault: its key is wrapped again here; on a merge, entries are re-encrypted with the key already here.
    const theirKey = secrets.get('vault.key');
    if (theirKey?.length === 32 && all.includes('data/vault.json')) {
      const theirs = JSON.parse(await fsp.readFile(path.join(files, 'data', 'vault.json'), 'utf8'))?.entries || [];
      const keyHere = path.join(P.dataDir, 'vault.key');
      const ours = (await readJson(path.join(P.dataDir, 'vault.json'), null))?.entries || [];
      if (!merge || !ours.length) {
        await writeFileAtomic(keyHere, wrapVaultKey(theirKey));
        await writeJsonAtomic(path.join(P.dataDir, 'vault.json'), { entries: theirs, updatedAt: nowIso() });
        restored.vault = theirs.length;
      } else {
        const ourKey = unwrapVaultKey(await fsp.readFile(keyHere).catch(() => null));
        if (!ourKey) problems.push('这台的保险箱打不开，备份里的保险箱没有合并进来');
        else {
          const next = [...ours];
          for (const e of theirs) {
            if (next.some((o) => String(o.name).toLowerCase() === String(e.name).toLowerCase())) { restored.kept += 1; continue; }
            try {
              const fields = {};
              for (const [label, b] of Object.entries(e.fields || {})) fields[label] = vaultSeal(ourKey, vaultOpen(theirKey, b));
              next.push({ ...e, fields });
              restored.vault += 1;
            } catch { problems.push(`保险箱里「${e.name}」打不开，没合并`); }
          }
          await writeJsonAtomic(path.join(P.dataDir, 'vault.json'), { entries: next, updatedAt: nowIso() });
        }
      }
    }
  } catch (err) {
    problems.push(`恢复没做完：${err.message}`);
  }
  const result = { at: nowIso(), ok: !problems.some((p) => p.startsWith('恢复没做完')), mode: plan?.mode || null, from: plan?.from || null, preBackup: plan?.preBackup || null, restored, problems: problems.slice(0, 20) };
  await fsp.rm(pendingFile(), { force: true }).catch(() => {});
  noteNow(pendingFile());
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await saveState({ lastRestore: result }).catch(() => {});
  return result;
}

/** At start: staging and uploads left from before (not the one waiting) go. */
export async function cleanRestoreLeftovers() {
  const keep = (() => { try { return path.basename(JSON.parse(fs.readFileSync(pendingFile(), 'utf8')).dir || ''); } catch { return ''; } })();
  for (const name of await fsp.readdir(restoreDir()).catch(() => [])) {
    if (name !== keep) await fsp.rm(path.join(restoreDir(), name), { recursive: true, force: true }).catch(() => {});
  }
}
