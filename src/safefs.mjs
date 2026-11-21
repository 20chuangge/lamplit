/**
 * safefs.mjs - open a file in the workspace, then make sure what was opened
 * is in the workspace (1.5.54, security review M7).
 *
 * The checks before (SEC-18: realpath of the name) and the read or write
 * after were two steps. A bot writes in the workspace; between the two it
 * could swap a file (or a folder on the way) for a link or junction to
 * Lamplit's data folder, and the hub - which can read that folder, the bots'
 * account cannot - read or wrote there for it. Now the file is opened first
 * and the open handle is compared with what its name leads to: the same file
 * (device and file id), and inside the workspace. A swap before the open is
 * caught by the realpath; a swap after it changes what the name leads to, not
 * what was opened.
 *
 *   openInside(root, abs, flags)  -> FileHandle (throws code PATH_OUTSIDE_WORKSPACE)
 *   readInside(root, abs, enc?)    -> Buffer | string
 *   writeInside(root, abs, data, {append}) -> undefined
 *   statInside(root, abs)          -> {fh, stat} for streaming (the caller closes fh)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { realPathOf } from './realpath.mjs';

const cmp = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
const outside = (abs) => Object.assign(new Error(`path resolves outside the shared workspace (${abs})`), { code: 'PATH_OUTSIDE_WORKSPACE', status: 400 });

/** Is `real` the root or below it (both real paths)? */
export function isBelow(realRoot, real) {
  const root = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return cmp(real) === cmp(realRoot) || cmp(real).startsWith(cmp(root));
}

/** Open `abs` with `flags` and check the handle is the file its name leads to, inside `root`. -> FileHandle */
export async function openInside(root, abs, flags = 'r', mode = 0o666) {
  // O_NOFOLLOW where the system has it: a last part that is a link is refused at the open.
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const flagBits = typeof flags === 'number' ? flags : ({
    r: fs.constants.O_RDONLY,
    'r+': fs.constants.O_RDWR,
    w: fs.constants.O_WRONLY | fs.constants.O_CREAT,
    a: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
  }[flags] ?? fs.constants.O_RDONLY);
  let fh;
  try {
    fh = await fsp.open(abs, flagBits | noFollow, mode);
  } catch (err) {
    if (err.code === 'ELOOP') throw outside(abs);
    throw err;
  }
  try {
    await checkHandle(root, abs, fh);
    return fh;
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

/** Is the open handle `fh` the file `abs` leads to, inside `root`? Throws PATH_OUTSIDE_WORKSPACE when not. */
async function checkHandle(root, abs, fh) {
  const realRoot = realPathOf(root);
  const mine = await fh.stat({ bigint: true });
  // Linux: the kernel says where the handle really is.
  if (process.platform === 'linux') {
    let where = '';
    try { where = fs.readlinkSync(`/proc/self/fd/${fh.fd}`); } catch { /* no /proc: as on other systems */ }
    if (where) {
      if (!isBelow(realRoot, where)) throw outside(abs);
      return;
    }
  }
  // Elsewhere (Windows has no handle-to-path call in Node): what the name leads to must be
  // inside, be the opened file, and still lead to the same place when asked again - a
  // name that flips between the asks is refused.
  const same = (s) => s.dev === mine.dev && s.ino === mine.ino;
  // The real path itself, never a fallback: while a link is being swapped the lookup can fail for a
  // moment, and the name as written (with the link still in it) must not pass for "inside".
  const strictReal = () => { try { return fs.realpathSync.native(abs); } catch { throw outside(abs); } };
  const real = strictReal();
  if (!isBelow(realRoot, real) || !same(await fsp.stat(real, { bigint: true }))) throw outside(abs);
  const again = strictReal();
  if (cmp(again) !== cmp(real) || !same(await fsp.stat(again, { bigint: true }))) throw outside(abs);
}

/** Read a file in the workspace, checked (see the top). */
export async function readInside(root, abs, encoding = null) {
  const fh = await openInside(root, abs, 'r');
  try { return await fh.readFile(encoding ? { encoding } : {}); } finally { await fh.close().catch(() => {}); }
}

/**
 * Open a file in the workspace for writing, never making one outside: an existing
 * file is opened as it is (nothing changed before the check); a new one is made
 * only after its folder was checked, and only if nothing is there (O_EXCL).
 */
async function openForWrite(root, abs, append) {
  const c = fs.constants;
  try {
    return await openInside(root, abs, c.O_WRONLY | (append ? c.O_APPEND : 0));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!isBelow(realPathOf(root), realPathOf(path.dirname(abs)))) throw outside(abs);
  // Made new (O_EXCL: nothing was there), then checked. Refused (a link swapped in between):
  // the empty file just made is taken away again - only while its name still leads to it.
  const fh = await fsp.open(abs, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (append ? c.O_APPEND : 0));
  const made = await fh.stat({ bigint: true });
  try {
    await checkHandle(root, abs, fh);
    return fh;
  } catch (err) {
    await fh.close().catch(() => {});
    // A swapped link may lead elsewhere for a moment: look again briefly; anything else is left alone.
    for (let i = 0; i < 100; i += 1) {
      try {
        const now = fs.statSync(abs, { bigint: true });
        if (now.dev === made.dev && now.ino === made.ino && now.size === 0n) { fs.unlinkSync(abs); break; }
      } catch { /* not there right now */ }
      await new Promise((r) => setTimeout(r, 2));
    }
    throw err;
  }
}

/** Write (or append to) a file in the workspace, checked before anything is changed: emptied only after the check. */
export async function writeInside(root, abs, data, { append = false } = {}) {
  const fh = await openForWrite(root, abs, append);
  try {
    if (!append) await fh.truncate(0);
    await fh.writeFile(data, typeof data === 'string' ? { encoding: 'utf8' } : {});
  } finally {
    await fh.close().catch(() => {});
  }
}

/** A checked handle and its stat, for streaming a file out (the caller closes fh). */
export async function statInside(root, abs) {
  const fh = await openInside(root, abs, 'r');
  try {
    return { fh, stat: await fh.stat() };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}
