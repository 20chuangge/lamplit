/**
 * browser.mjs - real browser automation over CDP, with a persistent browser.
 *
 * The product story: the assistant runs on another machine (an idle PC or a
 * cloud VM). The user watches from their laptop/phone while the bot actually
 * drives a browser there - opens pages, clicks, types into forms, downloads a
 * file. That means a *long-lived* Chromium process with a *persistent profile*
 * (the "signed-in browser" the product sells), driven over the DevTools
 * protocol, not a throwaway headless tab per call.
 *
 * Zero dependencies: Node >= 22 ships a global WebSocket, which is all CDP needs.
 * On an older Node every tool returns a structured {code:'unsupported'} answer
 * instead of throwing.
 *
 * Why the page-level websocket and not Target.attachToTarget: one page, one
 * socket, no session ids to juggle. The browser-level socket is opened only for
 * the few Browser.* domains (downloads, close).
 *
 * Everything here returns plain objects. Infrastructure problems (no browser,
 * unsupported Node, launch failure) come back as
 *   { ok:false, error:{ code, message }, hint? }
 * so a tool call can never crash a turn.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { P, readJsonSync, writeJsonSyncAtomic, hubTmp } from './store.mjs';
import { childEnv } from './childenv.mjs';
import { MiniWebSocket } from './ws-client.mjs';
import { assertPublicUrl } from './netguard.mjs';
import { saveInside, mkdirInside, copyInside } from './safefs.mjs';

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keys browser_press and browser_type send as real key events (1.5.50, S1).
const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
};
const KEY_NAMES = Object.keys(KEYS);
const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
/** "Ctrl+End" -> {key, code, vk, text, modifiers}, or null for a key it does not know. */
export function parseKey(spec) {
  const parts = String(spec || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) return null;
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  const name = KEY_NAMES.find((k) => k.toLowerCase() === last.toLowerCase()) || (last.toLowerCase() === 'esc' ? 'Escape' : '');
  if (name) {
    const k = KEYS[name];
    return { key: k.key || name, code: k.code, vk: k.vk, text: modifiers & (1 | 2 | 4) ? '' : (k.text || ''), modifiers };
  }
  // One letter or digit, only with a modifier (Ctrl+A): plain text goes through browser_type.
  if (/^[a-z0-9]$/i.test(last) && modifiers) {
    const up = last.toUpperCase();
    return { key: last.toLowerCase(), code: /\d/.test(up) ? `Digit${up}` : `Key${up}`, vk: up.charCodeAt(0), text: '', modifiers };
  }
  return null;
}
async function pressKey(page, k) {
  if (!k) return;
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers || 0 };
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const UPLOAD_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
/**
 * Does a file box's accept="…" take every one of these files (1.5.64)? By extension (".jpg")
 * or type ("image/jpeg", "image/*"); an empty accept takes anything.
 */
export function fileBoxTakes(accept, files) {
  const tokens = String(accept || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  return (files || []).every((f) => {
    const ext = String(f).split(/[\\/]/).pop().split('.').pop().toLowerCase();
    const mime = UPLOAD_MIME[ext] || '';
    return tokens.some((t) => (t.startsWith('.') ? t.slice(1) === ext : t.endsWith('/*') ? Boolean(mime) && mime.startsWith(t.slice(0, -1)) : Boolean(mime) && t === mime));
  });
}

function errorResult(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** A name in `dir` nothing has yet: `name`, else "stem (1).ext", "stem (2).ext"… -> its path */
async function freeNameIn(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!(await fsp.lstat(candidate).catch(() => null))) return candidate;
  }
  return path.join(dir, `${stem} (${crypto.randomBytes(3).toString('hex')})${ext}`);
}

/** Staging folders of earlier downloads (data/browser-downloads/*) older than an hour: gone. */
async function clearOldStaging() {
  const root = path.join(P.dataDir, 'browser-downloads');
  const names = await fsp.readdir(root).catch(() => []);
  for (const n of names) {
    const st = await fsp.stat(path.join(root, n)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600000) await fsp.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});
  }
}

/** Keep the workspace as the only place artifacts can land. */
function resolveInWorkspace(workspaceDir, relative) {
  const abs = path.resolve(workspaceDir, relative);
  const root = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  const inside = abs === workspaceDir || abs.startsWith(root);
  return { abs, inside, rel: path.relative(workspaceDir, abs).split(path.sep).join('/') };
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// discovery: which Chromium do we drive?
// ---------------------------------------------------------------------------

/**
 * Detection order (as specified):
 *   1. CHROME_PATH override (must exist, else a clear not_configured)
 *   2. C:\Program Files\Google\Chrome\Application\chrome.exe
 *   3. C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
 *   4. %LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
 * then the usual Linux/macOS locations, so the same build runs on a VM.
 */
export function browserCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    list.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    list.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    if (process.env.LOCALAPPDATA) {
      list.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (process.env['ProgramFiles(x86)']) {
      list.push(path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  }
  // Linux / macOS (the cloud-VM half of the product)
  list.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  return list;
}

/**
 * @returns {{path: string|null, source: string, checked: string[], skipped?: string}}
 */
export function detectBrowserExecutable() {
  const override = (process.env.CHROME_PATH || '').trim();
  if (override) {
    if (fs.existsSync(override)) {
      return { path: override, source: 'CHROME_PATH', checked: [override] };
    }
    return {
      path: null,
      source: 'CHROME_PATH',
      checked: [override],
      skipped: `CHROME_PATH points at ${override}, which does not exist`,
    };
  }
  const candidates = browserCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, source: 'auto-detect', checked: candidates };
    } catch {
      /* unreadable path: keep looking */
    }
  }
  return { path: null, source: 'auto-detect', checked: candidates };
}

/** CDP needs a WebSocket. Node >= 22 has one built in; older runtimes (notably
 *  the Electron-bundled Node 20 that the desktop shell spawns) get the small
 *  RFC 6455 client in ws-client.mjs instead. */
export function browserSupport() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    return {
      supported: false,
      reason: `this is Node ${process.versions.node}; the browser driver needs Node >= 18`,
    };
  }
  return { supported: true, transport: typeof globalThis.WebSocket === 'function' ? 'native' : 'shim' };
}

export function profileDir(key = '') {
  // One profile per bot: cookies and logins must not leak between bots that are
  // supposed to be separate assistants on separate desktops.
  if (!key) return path.join(P.dataDir, 'browser-profile');
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(P.dataDir, 'browser-profiles', safe || 'bot');
}

/**
 * Where a bot's running browser is noted (pid, program), so a restarted hub
 * can stop one a crash left running (1.5.61: no port, nothing to take over). One per bot (1.5.26): with one file for all, every bot
 * took over whichever browser another bot had started - one Chrome, on that
 * other bot's screen, for everyone (11-17: 「接管屏幕」 showed an empty desktop,
 * logins seemed lost, two bots asked to log in to the same page).
 */
function stateFile(key = '') {
  const safe = String(key || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(P.dataDir, safe ? `browser-state-${safe}.json` : 'browser-state.json');
}

function installHint() {
  return (
    'Install Google Chrome, or Microsoft Edge (both are Chromium based), or point CHROME_PATH at a chrome.exe/msedge/chromium binary. ' +
    'On a headless Linux VM also install xvfb, or set BROWSER_HEADLESS=1.'
  );
}

/**
 * Launch flags. Windowed by default because the whole point is that the user
 * *watches* the bot work; headless is opt-in via BROWSER_HEADLESS=1 (and the
 * only option on a VM without a display).
 */
// ---------------------------------------------------------------------------
// Windows remote machines: show the browser on the signed-in desktop
// ---------------------------------------------------------------------------
//
// A Windows machine's hub runs in session 0 (a scheduled task), where no window
// can be seen, so its browser used to be headless and the human could not take
// over a login. When someone is signed in at the console (what the takeover
// view shows) and it is the hub's own account, the browser is started in that
// interactive session through a one-off scheduled task (/IT needs no password
// for the task owner). 1.5.61: the task starts a bridge that runs Chrome with its
// debugging pipe and dials back to the hub (launchBridged): no port.

let consoleUserCache = { at: 0, user: null };

/** "MACHINE\\user" signed in at the console, or null (cached 30 s). */
export async function windowsConsoleUser() {
  if (process.platform !== 'win32') return null;
  if (Date.now() - consoleUserCache.at < 30000) return consoleUserCache.user;
  const user = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).UserName'],
      // Slow, busy machines (a 1-core VM running Windows Update) need the time.
      { timeout: 60000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '').trim() || null));
  });
  consoleUserCache = { at: Date.now(), user };
  return user;
}

/** True when this process has no desktop of its own (Windows session 0). */
function inWindowsServiceSession() {
  return process.platform === 'win32' && !process.env.SESSIONNAME;
}

const sameAccount = (a, b) => String(a || '').split('\\').pop().toLowerCase() === String(b || '').split('\\').pop().toLowerCase();

/** Run `script` (a .cmd) in the console user's session through a scheduled task. Resolves true if the task ran. */
async function runOnWindowsDesktop(script, user) {
  const run = (cmdArgs) => new Promise((resolve) => {
    execFile('schtasks.exe', cmdArgs, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || '') }));
  });
  const made = await run(['/Create', '/F', '/TN', 'NightshiftBrowser', '/SC', 'ONCE', '/ST', '00:00', '/IT', '/RU', user, '/TR', `"${script}"`]);
  if (!made.ok) return false;
  const started = await run(['/Run', '/TN', 'NightshiftBrowser']);
  return started.ok;
}

/**
 * Chrome's command line. 1.5.61 (the verifier's N1): the DevTools protocol goes
 * over a pipe (fds 3 and 4), never a port: a debugging port has no password, and
 * a bot's own program on this machine could find it and drive the browser - which
 * runs as the hub - to read or download into Lamplit's data. (`port` is ignored.)
 */
export function buildLaunchArgs({ profileDir: profile, headless = false, wayland = false, extraArgs = [] } = {}) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Without this, navigator.webdriver is true and many sites serve a captcha.
    '--disable-blink-features=AutomationControlled',
    // Containers have a tiny /dev/shm; harmless elsewhere.
    '--disable-dev-shm-usage',
    '--no-service-autorun',
    // The bot's browser must not sign itself in with the Windows account (Edge
    // does that by default) or sync that account's passwords and history.
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,msImplicitSignin,msEdgeImplicitSignin,msSyncConsent',
    // Several bots' windows share one Windows desktop and cover each other; a
    // covered or minimised window must keep full speed for the bot driving it.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // The hub stops a bot's browser when it restarts or the desktop idles out;
    // Chromium then offers "restore pages?" on the bot's screen every time.
    '--hide-crash-restore-bubble',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu', '--hide-scrollbars');
  // A visible window otherwise carries a yellow bar across the top: "you are
  // using an unsupported command-line flag" (for the AutomationControlled one
  // above). --test-type is what test drivers pass to suppress that bar.
  else args.push('--test-type');
  // A Wayland-only screen (cage on Rocky/RHEL 10): draw natively, full screen.
  if (!headless && wayland) args.push('--ozone-platform=wayland', '--start-maximized');
  args.push(...extraArgs, 'about:blank');
  return args;
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

/**
 * One websocket, request/response by id, events by method name.
 * `closed` is the only state anyone outside checks.
 */
class CdpConnection {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    /** sessionId -> the socket of a page attached to this (browser) connection (flatten). */
    this.sessions = new Map();

    ws.addEventListener('message', (event) => this.onMessage(event));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  /**
   * The browser over the pipe Chrome was started with (1.5.61, the verifier's
   * N1): fd 3 is what it reads, fd 4 what it writes. No port is opened, so no
   * program on the machine - a bot's command included - can reach it.
   */
  static overPipe(writable, readable, { label = 'browser' } = {}) {
    return new CdpConnection(new PipeSocket(writable, readable), label);
  }

  /** A page attached with Target.attachToTarget {flatten:true}: its messages go over this connection. */
  session(sessionId, label = 'page') {
    const root = this;
    const listeners = { message: [], close: [], error: [] };
    let gone = false;
    const sock = {
      addEventListener(type, fn) { listeners[type]?.push(fn); },
      send(text) {
        if (root.closed) throw new Error('the browser connection is closed');
        const msg = JSON.parse(text);
        root.ws.send(JSON.stringify({ ...msg, sessionId }));
      },
      close() {
        if (gone) return;
        root.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 3000 }).catch(() => {});
        sock.ended();
      },
      deliver(msg) { for (const fn of listeners.message) fn({ data: msg }); },
      ended() {
        if (gone) return;
        gone = true;
        root.sessions.delete(sessionId);
        for (const fn of listeners.close) fn();
      },
    };
    this.sessions.set(sessionId, sock);
    return new CdpConnection(sock, label);
  }

  static async connect(wsUrl, { timeoutMs = 10000, label = 'cdp' } = {}) {
    // Native WebSocket when the runtime has it; the in-repo RFC 6455 client
    // otherwise (Electron's Node 20). ASSIST_WS_SHIM=1 forces the shim so the
    // test suite exercises it even on Node 24.
    const useShim = process.env.ASSIST_WS_SHIM === '1' || typeof globalThis.WebSocket !== 'function';
    const WSCtor = useShim ? MiniWebSocket : globalThis.WebSocket;
    const ws = new WSCtor(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error(`timed out connecting to ${label}`), { code: 'CDP_CONNECT_TIMEOUT' }));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`could not connect to ${label}`), { code: 'CDP_CONNECT_FAILED' }));
      });
    });
    return new CdpConnection(ws, label);
  }

  onMessage(event) {
    let msg;
    if (event.data && typeof event.data === 'object' && !Buffer.isBuffer(event.data) && !(event.data instanceof ArrayBuffer)) {
      msg = event.data; // handed on by the browser connection to a page session, already parsed
    } else {
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
    }
    // A page session's message (flatten): that page's connection handles it.
    if (msg.sessionId && this.sessions.has(msg.sessionId)) {
      this.sessions.get(msg.sessionId).deliver(msg);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) this.sessions.get(msg.params.sessionId)?.ended();
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: 'CDP_ERROR', cdp: msg.error }));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const fn of handlers) {
          try {
            fn(msg.params || {});
          } catch {
            /* a listener must never break the socket */
          }
        }
      }
    }
  }

  onClose() {
    this.closed = true;
    for (const sock of [...this.sessions.values()]) sock.ended();
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error('CDP connection closed'), { code: 'CDP_CLOSED' }));
    }
    this.pending.clear();
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error(`CDP connection (${this.label}) is closed`), { code: 'CDP_CLOSED' }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: 'CDP_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error(`could not send ${method}: ${err.message}`), { code: 'CDP_SEND_FAILED' }));
      }
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * A WebSocket-shaped object over Chrome's --remote-debugging-pipe: one JSON
 * message per write, each ended by a NUL byte, both ways (also what the
 * desktop bridge relays over its socket).
 */
class PipeSocket {
  constructor(writable, readable) {
    this.writable = writable;
    this.listeners = { message: [], close: [], error: [] };
    this.done = false;
    let buf = Buffer.alloc(0);
    readable.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let at;
      while ((at = buf.indexOf(0)) !== -1) {
        const text = buf.subarray(0, at).toString('utf8');
        buf = buf.subarray(at + 1);
        for (const fn of this.listeners.message) fn({ data: text });
      }
    });
    const end = () => {
      if (this.done) return;
      this.done = true;
      for (const fn of this.listeners.close) fn();
    };
    readable.on('end', end);
    readable.on('close', end);
    readable.on('error', end);
    writable.on?.('error', end);
    writable.on?.('close', end);
  }

  addEventListener(type, fn) { this.listeners[type]?.push(fn); }

  send(text) {
    if (this.done) throw new Error('the browser pipe is closed');
    this.writable.write(`${text}\0`);
  }

  close() {
    try { this.writable.end?.(); } catch { /* gone */ }
    if (!this.done) {
      this.done = true;
      for (const fn of this.listeners.close) fn();
    }
  }
}

/** A page the hub's tools read or type into: http(s), or the blank page (1.5.61). */
function isWebPageUrl(url) {
  return /^https?:\/\//i.test(String(url)) || url === 'about:blank' || url === '';
}

/** The environment the bot's browser starts with (1.5.61, F7/F8): childEnv, and its temp files in data/tmp. */
export function browserEnv(base = process.env, key = '') {
  const env = childEnv(base);
  if (process.platform !== 'win32') env.TMPDIR = hubTmp(`browser-${key || 'shared'}`);
  return env;
}

/** Does the browser answer on `browser` within `timeoutMs`? -> its version, or null. */
async function pipeReady(browser, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !browser.closed) {
    if (child && (child.exitCode !== null || child.signalCode)) return null;
    try {
      return await browser.send('Browser.getVersion', {}, { timeoutMs: Math.max(1000, Math.min(5000, deadline - Date.now())) });
    } catch (err) {
      if (err.code === 'CDP_CLOSED' || browser.closed) return null;
    }
    await sleep(200);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The browser on the Windows desktop through a bridge (1.5.61, F7)
// ---------------------------------------------------------------------------
//
// A hub in Windows' service session (a machine Lamplit set up, started at
// boot) puts the bot's browser on the desktop of whoever is signed in at the
// console, through a scheduled task, so the human can see and take it over. A
// scheduled task cannot hand Chrome a pipe. So the task runs a small bridge
// (src/browser-bridge.mjs) in that session: it starts Chrome with the pipe and
// dials back to the hub - the hub listens on 127.0.0.1 for one minute or two,
// for one connection that presents the one-time token. The token is in a
// ticket in data/ (which the bots' account cannot read), never on a command
// line; Chrome itself listens on nothing. A connection without the token gets
// nothing. When the bridge goes away the pipe ends: the session is closed and
// the next call starts the browser again.

const BRIDGE_WAIT_MS = 150000; // Edge took 141 s on a 1-core VM with the CPU at 100%

/**
 * Wait on 127.0.0.1 for the bridge holding `token`. -> {port, connected: Promise<{socket, pid}|null>, close()}
 * Exported for the tests (_test.bridgeListener).
 */
async function bridgeListener(token, { waitMs = BRIDGE_WAIT_MS } = {}) {
  const want = Buffer.from(token, 'utf8');
  let settle;
  const connected = new Promise((resolve) => { settle = resolve; });
  let finished = false;
  const server = net.createServer((socket) => {
    if (finished) { socket.destroy(); return; }
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const first = head.indexOf(10);
      const second = first === -1 ? -1 : head.indexOf(10, first + 1);
      if (second === -1) { if (head.length > 512) socket.destroy(); return; }
      socket.off('data', onData);
      clearTimeout(timer);
      const got = head.subarray(0, first);
      const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
      if (!ok || finished) { socket.destroy(); return; }
      finished = true;
      server.close();
      const pid = Number(head.subarray(first + 1, second).toString('utf8')) || 0;
      const rest = head.subarray(second + 1);
      socket.pause();
      if (rest.length) socket.unshift(rest);
      settle({ socket, pid });
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { finished = true; server.close(); settle(null); }, waitMs);
  timer.unref?.();
  connected.then(() => clearTimeout(timer));
  return { port: server.address().port, connected, close: () => { finished = true; try { server.close(); } catch { /* closed */ } settle(null); } };
}

/** Where the bridge is, and how the scheduled task starts it. */
const BRIDGE_SCRIPT = new URL('./browser-bridge.mjs', import.meta.url);

/**
 * Start Chrome on the console user's desktop through the bridge. -> {browser, pid} or null.
 * `start(cmdFile)`: runs the .cmd in that session (the scheduled task; tests run it directly).
 */
async function launchBridged(exe, args, { start, env = {} } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const listener = await bridgeListener(token);
  const ticket = path.join(P.dataDir, `browser-bridge-${crypto.randomBytes(8).toString('hex')}.json`);
  try {
    await fsp.mkdir(P.dataDir, { recursive: true });
    await fsp.writeFile(ticket, JSON.stringify({ port: listener.port, token, exe, args, env }), { encoding: 'utf8', mode: 0o600 });
    const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
    const script = path.join(P.dataDir, 'browser-desktop.cmd');
    // A .cmd file keeps the task's command line short (schtasks /TR is limited). The bridge
    // starts minimised, hands itself to a copy with no window and ends.
    await fsp.writeFile(script, `@echo off\r\n${process.versions.electron ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}start "" /min ${quote(process.execPath)} ${quote(fileURLToPath(BRIDGE_SCRIPT))} ${quote(ticket)}\r\n`, 'utf8');
    if (!(await start(script))) { listener.close(); return null; }
    const got = await listener.connected;
    if (!got) return null;
    const browser = new CdpConnection(new PipeSocket(got.socket, got.socket), 'browser (desktop)');
    got.socket.resume();
    return { browser, pid: got.pid, socket: got.socket };
  } finally {
    listener.close();
    await fsp.rm(ticket, { force: true }).catch(() => {}); // the bridge removes it once read; never left behind
  }
}

/** Is `pid` still the browser `exe` (a browser a crashed hub left running)? */
function stillTheBrowser(pid, exe) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const want = path.basename(String(exe || '')).toLowerCase();
  if (!want) return false;
  try {
    if (process.platform === 'linux') return path.basename(fs.readlinkSync(`/proc/${pid}/exe`)).toLowerCase().startsWith(want.replace(/\.exe$/, ''));
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      return out.toLowerCase().includes(`"${want}"`);
    }
  } catch { /* cannot tell: leave it */ }
  return false;
}

/** The --user-data-dir a command line names, or '' (quoted whole, quoted value, or bare). */
export function userDataDirOf(cmdline) {
  const s = String(cmdline || '');
  const at = s.indexOf('--user-data-dir=');
  if (at < 0) return '';
  let rest = s.slice(at + '--user-data-dir='.length);
  if (s[at - 1] === '"') return rest.slice(0, rest.indexOf('"') >= 0 ? rest.indexOf('"') : undefined);
  if (rest[0] === '"') { rest = rest.slice(1); return rest.slice(0, rest.indexOf('"') >= 0 ? rest.indexOf('"') : undefined); }
  return rest.split(/\s/)[0];
}

/** Every process of this machine: [{pid, ppid, profile}] with the --user-data-dir it names (only those that name one). */
function browserProcesses() {
  const out = [];
  if (process.platform === 'win32') {
    let text = '';
    try {
      // UTF-8 out (a profile under C:\Users\<a Chinese name> must come back as it is), and the
      // script encoded (no quoting on the way to PowerShell).
      const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"CommandLine like '%user-data-dir%'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";
      text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    } catch { return out; }
    for (const line of text.split(/\r?\n/)) {
      const [pid, ppid, ...cmd] = line.split('\t');
      const profile = userDataDirOf(cmd.join('\t'));
      if (Number(pid) && profile) out.push({ pid: Number(pid), ppid: Number(ppid) || 0, profile });
    }
  } else if (process.platform === 'linux') {
    for (const d of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
        const arg = args.find((a) => a.startsWith('--user-data-dir='));
        if (!arg) continue;
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        out.push({ pid: Number(d), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0, profile: arg.slice('--user-data-dir='.length) });
      } catch { /* gone, or not ours to read */ }
    }
  }
  return out;
}

/**
 * Stop every browser that runs on one of Lamplit's bot profiles (1.5.61, the verifier's F11):
 * `only`: those profiles; else any under data/browser-profile(s). Not this process's own.
 * An upgrade from 1.5.60 left its browser running with its debugging port open (noted with
 * pid 0 on the Windows desktop path): found by its command line, not by a noted pid or port.
 * -> pids stopped
 */
export function stopLeftoverBrowsers({ only = null } = {}) {
  const norm = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const single = norm(profileDir(''));
  const many = norm(path.join(P.dataDir, 'browser-profiles'));
  const want = only ? new Set(only.map(norm)) : null;
  const ours = (p) => (want ? want.has(norm(p)) : (norm(p) === single || norm(p).startsWith(many + path.sep)));
  // Spared: this process, and the browser this hub started itself (with its helpers).
  const own = new Set([process.pid, launchedChild?.exitCode === null ? launchedChild.pid : 0].filter(Boolean));
  const procs = browserProcesses().filter((p) => ours(p.profile) && !own.has(p.pid) && !(launchedChild?.pid && p.ppid === launchedChild.pid && own.has(launchedChild.pid)));
  const hit = new Set(procs.map((p) => p.pid));
  const roots = procs.filter((p) => !hit.has(p.ppid)); // the browser itself; its tree goes with it
  for (const p of roots) stopProcessTree(p.pid);
  if (roots.length) console.error(`[browser] stopped ${roots.length} browser(s) left running on Lamplit's bot profiles (an older Lamplit's, or a crash's)`);
  return roots.map((p) => p.pid);
}

/** At hub start, before any bot runs anything: no browser of an earlier run is left, and their notes go. */
export async function sweepLeftoverBrowsers() {
  const stopped = stopLeftoverBrowsers();
  for (const n of await fsp.readdir(P.dataDir).catch(() => [])) {
    if (/^browser-state(-[\w-]+)?\.json$/.test(n)) await fsp.rm(path.join(P.dataDir, n), { force: true }).catch(() => {});
  }
  if (stopped.length) await sleep(1000);
  return stopped;
}

function stopProcessTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// page-side expressions
// ---------------------------------------------------------------------------

/**
 * Snapshot: visible text (script/style pruned) + interactive elements with refs.
 *
 * Refs are indices into window.__assistRefs. The registry survives across
 * snapshots *within the same document*, so a ref taken earlier keeps working as
 * long as the element is still attached. After a navigation the registry is
 * gone, and every stale ref then returns a STALE_REF error that tells the model
 * to take a new snapshot - which is the behaviour we want.
 */
const SNAPSHOT_EXPRESSION = `(() => {
  const MAX_TEXT = 8000;
  const MAX_ELEMENTS = 200;

  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 120);

  const readableName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      return clean(label || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || el.name || '');
    }
    return clean(el.innerText || el.getAttribute('title') || el.value || el.getAttribute('alt') || el.name || '');
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const map = { A: 'link', BUTTON: 'button', INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',
                  TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'disclosure', FORM: 'form' };
    if (map[el.tagName]) return map[el.tagName];
    if (el.isContentEditable) return 'textbox';
    return el.tagName.toLowerCase();
  };

  const SELECTOR = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[contenteditable=""],[contenteditable="true"],[onclick]';

  if (!window.__assistRefs) window.__assistRefs = [];
  const refs = window.__assistRefs;

  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    let index = refs.indexOf(el);
    if (index === -1) {
      if (refs.length > 800) refs.length = 0;
      refs.push(el);
      index = refs.length - 1;
    }
    elements.push({
      ref: '@e' + (index + 1),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: readableName(el),
      visible: true,
      disabled: Boolean(el.disabled),
      type: el.getAttribute('type') || null,
    });
    if (elements.length >= MAX_ELEMENTS) break;
  }

  // Text: walk the live DOM, skipping code-bearing nodes and inserting newlines
  // at block boundaries. Cloning the body and reading innerText loses layout
  // information (a detached node has no CSS boxes), which glued headings to
  // paragraphs; this walker keeps the page readable.
  const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY','TD','TFOOT','TH','THEAD','TR','UL']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','IFRAME','CANVAS','OBJECT']);
  const chunks = [];
  let visited = 0;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (visited++ > 20000) return;
      if (child.nodeType === 3) { chunks.push(child.nodeValue); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (SKIP.has(tag)) continue;
      const isBlock = BLOCK.has(tag);
      if (isBlock) chunks.push('\\n');
      walk(child);
      if (isBlock) chunks.push('\\n');
    }
  };
  if (document.body) walk(document.body);
  const text = chunks.join('')
    .replace(/[ \\t\\u00a0]+/g, ' ')
    .replace(/ *\\n */g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, MAX_TEXT),
    textLength: text.length,
    textTruncated: text.length > MAX_TEXT,
    elements,
    elementCount: elements.length,
  };
})()`;

/** Build the page-side resolver for one {ref|selector} target. */
function resolveExpression({ ref, selector }) {
  const refJson = JSON.stringify(ref ?? null);
  const selJson = JSON.stringify(selector ?? null);
  return `(() => {
  const REF = ${refJson};
  const SEL = ${selJson};
  let el = null;
  if (REF) {
    const m = String(REF).match(/^@?e(\\d+)$/i);
    if (!m) return { ok: false, code: 'BAD_REF', message: 'refs look like "@e3"; got ' + REF };
    const refs = window.__assistRefs;
    if (!refs) return { ok: false, code: 'STALE_REF', message: 'this page has no snapshot registry (it navigated); run browser_snapshot again' };
    el = refs[Number(m[1]) - 1] || null;
    if (!el) return { ok: false, code: 'STALE_REF', message: 'unknown ref ' + REF + '; run browser_snapshot again' };
    if (!el.isConnected) return { ok: false, code: 'STALE_REF', message: 'the element for ' + REF + ' left the DOM (page changed); run browser_snapshot again' };
  } else if (SEL) {
    try { el = document.querySelector(SEL); } catch (e) { return { ok: false, code: 'BAD_SELECTOR', message: e.message }; }
    if (!el) return { ok: false, code: 'ELEMENT_NOT_FOUND', message: 'nothing matches selector ' + SEL };
  } else {
    return { ok: false, code: 'BAD_ARGS', message: 'pass ref or selector' };
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { ok: false, code: 'ELEMENT_NOT_VISIBLE', message: 'the element has no layout box (hidden or zero-sized)' };
  const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           tag: el.tagName.toLowerCase(), name, editable: !el.disabled && !el.readOnly,
           isContentEditable: Boolean(el.isContentEditable) };
})()`;
}

// ---------------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------------

/**
 * Test hooks. desktop: {user, start(cmdFile) -> Promise<boolean>, headless} takes the
 * Windows desktop path (the bridge) with `start` in place of the scheduled task.
 * extraArgs: more launch arguments (a test's window off the screen).
 */
export const _test = { desktop: null, extraArgs: null, bridgeListener: (...a) => bridgeListener(...a), launchBridged: (...a) => launchBridged(...a) };

/** The Chrome process this module started, if any (killed on process exit). */
let launchedChild = null;
let exitHookRegistered = false;

function ensureExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    try {
      launchedChild?.kill();
    } catch {
      /* already gone */
    }
  });
}

class BrowserManager {
  /** @param {{key?: string}} [options] key scopes the profile dir (one per bot) */
  constructor({ key = '' } = {}) {
    /** Which bot owns this browser; '' is the shared/legacy instance. */
    this.key = key;
    /** @type {null | {port:number,pid:number,child:object|null,exe:string,headless:boolean,adopted:boolean,browser:CdpConnection,page:CdpConnection,inFlight:number,lastActivity:number,pageUrl:string}} */
    this.session = null;
    this.launching = null;
    this.inFlight = 0;
    this.lastActivity = 0;
  }  // --- session lifecycle ---------------------------------------------------

  async ensureSession() {
    const session = await this._ensureSession();
    await this.syncLogins().catch(() => {});
    // A screen with a browser on it is in use (the idle reaper must not take it).
    if (this.key && process.platform === 'linux') import('./desktops.mjs').then((d) => d.touchDesktop?.(this.key)).catch(() => {});
    return session;
  }

  async _ensureSession() {
    if (this.session && this.session.page && !this.session.page.closed) return this.session;
    if (this.launching) return this.launching;
    // 1.5.61: the page went (its tab closed, the session detached) but the browser is there:
    // attach again - to the hub's own page, or a new one - instead of starting the browser
    // again (which closed the human's other tabs too).
    if (this.session?.browser && !this.session.browser.closed) {
      try {
        this.session.page = await this.attachPage(this.session.browser);
        return this.session;
      } catch { /* start it again below */ }
    }

    this.launching = this._boot().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /**
   * Shared logins (1.5.9): right after a takeover, what the human logged into
   * goes to the machine's list; otherwise a newer list comes into this browser.
   */
  async syncLogins() {
    if (!sharesLogins() || !this.session?.browser) return;
    const file = loginsFile();
    if (this.loginPending) {
      this.loginPending = false;
      const got = await this.session.browser.send('Storage.getCookies', {}, { timeoutMs: 8000 });
      const jar = readJsonSync(file, null) || { cookies: [] };
      writeJsonSyncAtomic(file, { cookies: mergeCookies(jar.cookies, got?.cookies || []), updatedAt: new Date().toISOString(), from: this.key });
      this.loginsAt = fs.statSync(file).mtimeMs;
      return;
    }
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
    if ((this.loginsAt || 0) >= mtime) return;
    const jar = readJsonSync(file, null);
    if (jar?.cookies?.length) await this.session.browser.send('Storage.setCookies', { cookies: cookieParams(jar.cookies) }, { timeoutMs: 8000 });
    this.loginsAt = mtime;
  }

  async _boot() {
    // A dead page socket means the browser went away (or crashed); drop it.
    if (this.session) await this.teardown({ keepBrowser: false, silent: true });

    const executable = detectBrowserExecutable();
    if (!executable.path) {
      // A fresh Linux machine installs Chromium in the background after setup.
      let setup = null;
      try { setup = JSON.parse(fs.readFileSync(path.join(P.dataDir, 'desktop-setup.json'), 'utf8')); } catch { /* none */ }
      if (setup?.state === 'running') {
        throw Object.assign(new Error(`这台机器的浏览器还在后台安装（${setup.detail || '准备中'}），通常再过几分钟就好；告诉用户稍后再试，先做不需要浏览器的事。`), { code: 'browser_installing' });
      }
      throw Object.assign(
        new Error(executable.skipped || `no Chromium-based browser found. ${installHint()}`),
        { code: 'not_configured', checked: executable.checked, hint: installHint() },
      );
    }
    const support = browserSupport();
    if (!support.supported) {
      throw Object.assign(new Error(`${support.reason}. Browser automation is unavailable on this runtime.`), {
        code: 'unsupported',
        hint: 'Use Node >= 22 (or the desktop app, which bundles a newer runtime).',
      });
    }

    // 1.5.61 (F7): a browser over a pipe cannot be taken over by a hub that restarted (the
    // pipe was the old hub's). One a crashed hub left running still holds the profile: it
    // is stopped (only while that pid is still that browser), then a new one starts with
    // the same profile - the logins are in the profile, not in the process.
    await this.stopLeftover();
    this.pageTargetId = '';

    let headless = process.env.BROWSER_HEADLESS === '1';
    const profile = profileDir(this.key);
    await fsp.mkdir(profile, { recursive: true });

    // Windows hub in session 0 with someone signed in at the console: put the
    // window on that desktop so the human can see it and take over (through the bridge).
    let onDesktop = false;
    const desktopUser = _test.desktop ? _test.desktop.user : (inWindowsServiceSession() ? await windowsConsoleUser().catch(() => null) : null);
    if (_test.desktop || inWindowsServiceSession()) {
      if (desktopUser && (_test.desktop || sameAccount(desktopUser, os.userInfo().username))) {
        const desktopArgs = buildLaunchArgs({ profileDir: profile, headless: Boolean(_test.desktop?.headless) });
        const start = _test.desktop ? _test.desktop.start : (script) => runOnWindowsDesktop(script, desktopUser);
        const bridged = await launchBridged(executable.path, desktopArgs, { start }).catch(() => null);
        const version = bridged ? await pipeReady(bridged.browser, 30000) : null;
        if (version) {
          const page = await this.attachPage(bridged.browser, { start: true });
          await this.watchTargets(bridged.browser, { headless: Boolean(_test.desktop?.headless) });
          await this.denyDownloads({ browser: bridged.browser, page });
          this.session = {
            pid: bridged.pid, child: null, exe: executable.path, headless: false, adopted: false, channel: 'bridge',
            display: 'console', profile, key: this.key, browser: bridged.browser, page, pageUrl: 'about:blank', onDesktop: true,
          };
          this.inFlight = 0;
          this.lastActivity = Date.now();
          await this.noteState({ pid: bridged.pid, executable: executable.path, headless: false, onDesktop: true });
          return this.session;
        }
        try { bridged?.browser.close(); } catch { /* gone */ }
      }
      // Nobody signed in (or another account), or the bridge did not come: stay invisible and say so.
      headless = true;
      onDesktop = false;
    }

    // On a Linux hub with per-bot desktops, the window must appear on THIS
    // bot's X display; otherwise every bot would paint on the same screen.
    let display = '';
    let wayland = null;
    if (!headless && process.platform === 'linux') {
      try {
        const { desktopEnv } = await import('./desktops.mjs');
        const env = desktopEnv(this.key) || {};
        display = env.DISPLAY || '';
        // Rocky/RHEL 10 screens are Wayland (cage): no X display at all.
        if (env.WAYLAND_DISPLAY) wayland = env;
      } catch { /* desktops unavailable: fall back to the inherited display */ }
    }

    const args = buildLaunchArgs({ profileDir: profile, headless, wayland: Boolean(wayland), extraArgs: _test.extraArgs || [] });
    let launchEnv = { ...process.env };
    if (wayland) {
      launchEnv = { ...process.env, ...wayland };
      delete launchEnv.DISPLAY;
      display = `wayland:${wayland.WAYLAND_DISPLAY}`;
    } else if (display) {
      launchEnv = { ...process.env, DISPLAY: display };
    }
    // 1.5.61 (F7): the browser gets what a bot's program gets - none of the hub's own
    // settings (ASSIST_MASTER_KEY, ASSIST_PROXY_SECRET...) or anything named like a key.
    // Its temporary files (the single-instance socket among them) go to data/tmp, not the
    // /tmp a Linux sandbox shares (F8).
    launchEnv = browserEnv(launchEnv, this.key);
    let stderr = '';
    let browser = null;
    const launch = () => {
      const c = spawn(executable.path, args, {
        // 3: what Chrome reads (the hub's commands), 4: what it writes (replies, events).
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: launchEnv,
      });
      c.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      });
      c.on('error', () => {});
      // If the server dies, do not leave a browser orphaned on the machine. One
      // hook for the whole process, so repeated launches cannot leak listeners.
      launchedChild = c;
      ensureExitHook();
      browser = CdpConnection.overPipe(c.stdio[3], c.stdio[4], { label: 'browser' });
      return c;
    };
    let child = launch();

    let version = await pipeReady(browser, inWindowsServiceSession() ? 120000 : 25000, child);
    if (version && wayland) {
      // Seen on Rocky 10: after the hub restarted, Chromium opened its debug
      // port and then crashed (SIGSEGV) on that compositor every time, until
      // the bot's screen was restarted. So: give it a moment; if it is gone,
      // restart the screen once and launch again.
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode !== null || child.signalCode) {
        try {
          const desk = await import('./desktops.mjs');
          desk.stopDesktop(this.key);
          await desk.ensureDesktop(this.key);
          Object.assign(launchEnv, desk.desktopEnv(this.key) || {});
        } catch { /* the relaunch below reports what is wrong */ }
        child = launch();
        version = await pipeReady(browser, 25000, child);
      }
    }
    if (!version && !inWindowsServiceSession()) {
      // One more try (1.5.21): a cold machine (seen on the Windows CI runner)
      // can take longer than 25 s. Stop the silent one and wait longer.
      try { child.kill(); } catch { /* ignore */ }
      try { browser?.close(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
      stderr = '';
      child = launch();
      version = await pipeReady(browser, 45000, child);
    }
    if (!version) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      try { browser?.close(); } catch { /* ignore */ }
      const detail = stderr.trim().split('\n').slice(-3).join(' / ');
      throw Object.assign(
        new Error(
          'Chrome started but never answered on its debugging pipe. ' +
            `Its profile may already be in use by another window (${profile}).${detail ? ` Chrome said: ${detail}` : ''}`,
        ),
        { code: 'browser_launch_failed' },
      );
    }

    const page = await this.attachPage(browser, { start: true });
    await this.watchTargets(browser, { headless });
    await this.denyDownloads({ browser, page });

    this.session = {
      pid: child.pid ?? 0,
      child,
      exe: executable.path,
      headless,
      adopted: false,
      channel: 'pipe',
      display,
      profile,
      key: this.key,
      browser,
      page,
      pageUrl: 'about:blank',
    };
    this.inFlight = 0;
    this.lastActivity = Date.now();

    await this.noteState({ pid: child.pid ?? 0, executable: executable.path, headless });

    return this.session;
  }

  /** The running browser, noted so a hub that crashed can stop it (pid, program; no port: 1.5.61). */
  async noteState(state) {
    await fsp.mkdir(P.dataDir, { recursive: true });
    await fsp.writeFile(stateFile(this.key), JSON.stringify({ ...state, channel: 'pipe', startedAt: new Date().toISOString() }, null, 2), 'utf8');
  }

  /** A browser of this bot a crashed hub left running (it holds the profile): stopped. */
  async stopLeftover() {
    let state;
    try {
      state = JSON.parse(await fsp.readFile(stateFile(this.key), 'utf8'));
    } catch {
      return;
    }
    await fsp.rm(stateFile(this.key), { force: true }).catch(() => {});
    const pid = Number(state?.pid) || 0;
    let stopped = false;
    if (pid && pid !== process.pid && stillTheBrowser(pid, state.executable)) {
      stopProcessTree(pid);
      stopped = true;
    }
    // 1.5.61 (F11): also one on this profile with no pid noted (1.5.60's desktop path: pid 0, a port).
    if (stopLeftoverBrowsers({ only: [profileDir(this.key)] }).length) stopped = true;
    if (stopped) await sleep(1000);
  }

  /**
   * Attach to the single page we drive. We keep exactly one page for the whole
   * process, so a turn can take a snapshot and then click the ref it found.
   * 1.5.61: a session over the browser's own connection (flatten), not a socket of its own.
   *
   * 1.5.61 (the verifier's section 十三): only the page the hub made itself, by its id,
   * never "the first page". A windowed Chrome takes a second `chrome.exe --user-data-dir=<same>
   * file:///<data>/…` from another program as a new tab; taking the first (newest) page on
   * a re-attach handed that file's content to the bot's next snapshot. At start the hub makes
   * a page of its own (what was there - the launch's blank tab, anything put there - is
   * closed); later, its page or, when that is gone, a new one.
   */
  async attachPage(browser, { start = false } = {}) {
    const listed = await browser.send('Target.getTargets', {}, { timeoutMs: 8000 });
    const pages = (listed?.targetInfos || []).filter((t) => t.type === 'page');
    let targetId = this.pageTargetId && pages.some((t) => t.targetId === this.pageTargetId) ? this.pageTargetId : '';
    if (!targetId) {
      const created = await browser.send('Target.createTarget', { url: 'about:blank' });
      targetId = created?.targetId || '';
      this.pageTargetId = targetId;
      if (start) for (const t of pages) if (t.targetId !== targetId) browser.send('Target.closeTarget', { targetId: t.targetId }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (!targetId) {
      throw Object.assign(new Error('the browser has no page target to drive'), { code: 'CDP_NO_PAGE' });
    }
    const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: 10000 });
    if (!attached?.sessionId) throw Object.assign(new Error('could not attach to the page'), { code: 'CDP_NO_PAGE' });

    const page = browser.session(attached.sessionId, 'page');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable', { maxTotalBufferSize: 20000000 });

    // Network bookkeeping feeds waitForIdle().
    page.on('Network.requestWillBeSent', () => {
      this.inFlight += 1;
      this.lastActivity = Date.now();
    });
    page.on('Network.loadingFinished', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActivity = Date.now();
    });
    page.on('Network.loadingFailed', () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActivity = Date.now();
    });
    return page;
  }

  async teardown({ keepBrowser = false, silent = false } = {}) {
    const session = this.session;
    this.session = null;
    if (!session) return;
    for (const conn of [session.page, session.browser]) {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }
    if (!keepBrowser) {
      if (session.child) {
        try {
          session.child.kill();
        } catch {
          /* ignore */
        }
      } else if (session.adopted) {
        // We did not launch it; do not kill a process we do not own unless the
        // caller explicitly asked to close (that path sends Browser.close).
        if (!silent) {
          /* leave it running */
        }
      }
      await fsp.rm(stateFile(this.key), { force: true }).catch(() => {});
    }
  }

  // --- page helpers --------------------------------------------------------

  async evaluateRaw(expression, { timeoutMs = 20000 } = {}) {
    const page = await this.ensurePage();
    const result = await page.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text ||
        'evaluation failed';
      return { ok: false, error: { code: 'EVAL_ERROR', message: String(message).slice(0, 500) } };
    }
    return { ok: true, value: result.result?.value ?? null, type: result.result?.type || 'undefined' };
  }

  async ensurePage({ navigating = false } = {}) {
    const session = await this.ensureSession();
    if (!session.page || session.page.closed) {
      // Page socket died but the browser is alive: re-attach once (to the hub's own page).
      session.page = await this.attachPage(session.browser);
    }
    await this.guardPage(session, { navigating });
    return session.page;
  }

  /**
   * 1.5.61 (the verifier's section 十三): before a snapshot, an eval, a screenshot, a click
   * or typing, the page must be a web page (http, https) or about:blank. Anything else
   * (file://, chrome://, view-source:...) is not read: the page is sent back to
   * about:blank, and the call says why - browser_open only ever opens http(s).
   * `navigating`: browser_open itself, which goes on from about:blank.
   */
  async guardPage(session, { navigating = false } = {}) {
    if (!this.pageTargetId) return;
    const info = await session.browser.send('Target.getTargetInfo', { targetId: this.pageTargetId }, { timeoutMs: 5000 }).catch(() => null);
    const url = String(info?.targetInfo?.url ?? '');
    if (isWebPageUrl(url)) return;
    await session.page.send('Page.navigate', { url: 'about:blank' }, { timeoutMs: 10000 }).catch(() => {});
    if (navigating) return;
    throw Object.assign(new Error(`the page was at ${url.split(':')[0] || 'an unknown'}: address, not a web page Lamplit opened, so it is not read; it is back at about:blank. Open the page again with browser_open (http or https).`), { code: 'PAGE_NOT_WEB' });
  }

  /**
   * 1.5.61 (F7): the browser says when a page appears or moves (Target.setDiscoverTargets).
   * Pages the hub did not make go: in a browser with no human at it (headless) every one
   * except what the hub's own page opened (a sign-in popup); in a window a human may take
   * over, those that are not a web page or a new tab (a file:// one handed over by another
   * program, above) - the human's own tabs stay.
   */
  async watchTargets(browser, { headless = false } = {}) {
    const police = (info) => {
      if (!info || info.type !== 'page' || !info.targetId || info.targetId === this.pageTargetId) return;
      const url = String(info.url || '');
      const ours = info.openerId && info.openerId === this.pageTargetId;
      const ok = isWebPageUrl(url) || /^(chrome|edge):\/\/(newtab|new-tab-page)\/?$/i.test(url);
      if (ok && (ours || !headless)) return;
      if (!ok || headless) {
        browser.send('Target.closeTarget', { targetId: info.targetId }, { timeoutMs: 5000 }).catch(() => {});
        console.error(`[browser] closed a page Lamplit did not open (${url.split(':')[0] || 'blank'}: ${headless ? 'no human at this browser' : 'not a web page'})`);
      }
    };
    browser.on('Target.targetCreated', (e) => police(e.targetInfo));
    browser.on('Target.targetInfoChanged', (e) => police(e.targetInfo));
    await browser.send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: 8000 }).catch(() => {});
  }

  /**
   * Wait until the page has no in-flight requests for a moment, capped.
   * SPA sites keep long-polling connections open, so the cap matters.
   */
  async waitForIdle({ timeoutMs = 8000, quietMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.inFlight <= 0 && Date.now() - this.lastActivity >= quietMs) return true;
      await sleep(80);
    }
    return false;
  }

  async waitForReadyState({ timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.evaluateRaw('document.readyState').catch(() => null);
      if (res?.ok && res.value === 'complete') return true;
      await sleep(120);
    }
    return false;
  }

  async currentLocation() {
    const res = await this.evaluateRaw('({ url: location.href, title: document.title })').catch(() => null);
    return res?.ok ? res.value : null;
  }

  async goto(url, { waitForLoad = true } = {}) {
    const page = await this.ensurePage({ navigating: true });
    this.inFlight = 0;
    this.lastActivity = Date.now();
    let nav;
    try {
      nav = await page.send('Page.navigate', { url }, { timeoutMs: 30000 });
    } catch (err) {
      return { ok: false, error: { code: 'NAVIGATION_FAILED', message: err.message } };
    }
    if (nav?.errorText) {
      return { ok: false, error: { code: 'NAVIGATION_FAILED', message: `${nav.errorText} (${url})` } };
    }
    if (waitForLoad) {
      await this.waitForReadyState({ timeoutMs: 12000 });
      await this.waitForIdle({ timeoutMs: 8000 });
      // Give client-side routers one more frame to paint.
      await sleep(120);
    }
    const location = await this.currentLocation();
    return { ok: true, url: location?.url || url, title: location?.title || '', frameId: nav?.frameId || null };
  }

  async resolveTarget(args) {
    const ref = args?.ref;
    const selector = args?.selector;
    if (!ref && !selector) {
      return { ok: false, error: { code: 'BAD_ARGS', message: 'pass either ref ("@e3") or selector ("#submit")' } };
    }
    const res = await this.evaluateRaw(resolveExpression({ ref, selector }));
    if (!res.ok) return res;
    if (!res.value?.ok) {
      return { ok: false, error: { code: res.value?.code || 'ELEMENT_NOT_FOUND', message: res.value?.message || 'could not resolve the element' } };
    }
    return { ok: true, target: res.value };
  }

  // --- tool surface --------------------------------------------------------

  /**
   * browser_open: navigate and report title/url. Keeps the old contract
   * (title/url) and adds what a real session knows.
   */
  async open(args) {
    const url = String(args?.url || '');
    if (!isHttpUrl(url)) {
      return errorResult('BROWSER_BAD_URL', `browser_open needs an absolute http(s) URL; got "${url}"`);
    }
    if (isPrivateHostname(url) && process.env.ALLOW_PRIVATE !== '1') {
      return errorResult(
        'PRIVATE_HOST_BLOCKED',
        `${new URL(url).hostname} is a private or loopback address. Set ALLOW_PRIVATE=1 to allow LAN/local addresses.`,
      );
    }
    // A public-looking name may still resolve into the home network (SEC-11).
    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err.code === 'PRIVATE_HOST_BLOCKED') return errorResult('PRIVATE_HOST_BLOCKED', err.message);
    }
    try {
      const session = await this.ensureSession();
      const nav = await this.goto(url);
      if (!nav.ok) return nav;
      session.pageUrl = nav.url;
      this.lastUrl = nav.url;
      return {
        ok: true,
        title: nav.title,
        url: nav.url,
        browser: {
          executable: session.exe,
          pid: session.pid,
          headless: session.headless,
          adopted: session.adopted,
          profile: session.profile || profileDir(this.key),
          // Which machine/display this browser is actually painting on. Without
          // it a bot cannot tell the user whether it is on the hub or the laptop.
          host: process.env.HOSTNAME || os.hostname(),
          display: session.display || process.env.DISPLAY || (process.platform === 'win32' ? 'win32' : ''),
          botId: this.key || null,
        },
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async snapshot() {
    try {
      await this.ensureSession();
      const res = await this.evaluateRaw(SNAPSHOT_EXPRESSION);
      if (!res.ok) return res;
      const page = res.value || {};
      return {
        ok: true,
        title: page.title || '',
        url: page.url || '',
        text: page.text || '',
        textLength: page.textLength ?? 0,
        textTruncated: Boolean(page.textTruncated),
        elements: Array.isArray(page.elements) ? page.elements : [],
        elementCount: page.elementCount ?? 0,
        hint: 'click/type accept a ref like "@e3"; take a new snapshot after the page changes.',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async click(args) {
    try {
      await this.ensureSession();
      const resolved = await this.resolveTarget(args);
      if (!resolved.ok) return resolved;
      const page = await this.ensurePage();
      const { x, y, tag, name } = resolved.target;

      // Real input events, not el.click(): sites that check isTrusted work.
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

      // A click can navigate or fetch; wait for the dust to settle but never
      // forever.
      await sleep(120);
      await this.waitForReadyState({ timeoutMs: 6000 });
      await this.waitForIdle({ timeoutMs: 6000 });
      const location = await this.currentLocation();

      return {
        ok: true,
        clicked: { tag, name, x, y },
        url: location?.url || '',
        title: location?.title || '',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  /**
   * Type text where the cursor is in this bot's browser: a person taking over
   * pastes Chinese, which the VNC clipboard cannot carry. Never starts a browser.
   */
  async insertAtFocus(text) {
    if (!this.session?.page || this.session.page.closed) return { ok: false, code: 'NO_BROWSER', reason: 'this bot has no browser open' };
    try {
      const page = await this.ensurePage();
      await page.send('Input.insertText', { text: String(text ?? '') });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'TYPE_FAILED', reason: err.message };
    }
  }

  /**
   * Put workspace files into a file box on the page (1.5.24). 小红书's 发布
   * page takes its pictures this way; without this the bot scripted the
   * browser's control port itself - asked every time, and it hung the page.
   * absPaths are already checked to be inside the workspace.
   */
  async upload(args, absPaths) {
    if (!Array.isArray(absPaths) || !absPaths.length) return errorResult('BAD_ARGS', 'browser_upload needs at least one file in "paths"');
    try {
      await this.ensureSession();
      const page = await this.ensurePage();
      // 1.5.64: every file box on the page - hidden ones, ones in an open dialog, in shadow DOM and in
      // same-site frames - with what it takes (accept) and the words near it. 11-23 B站's cover box was
      // a hidden image box (#1) among four others; the bot did not know which and spent ~60 steps.
      const sel = String(args?.selector || 'input[type=file]');
      const find = `(() => {
        const seen = [];
        let frameNow = '';
        const walk = (root) => {
          for (const el of root.querySelectorAll('input[type=file]')) seen.push({ el, frame: frameNow });
          for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
          for (const f of root.querySelectorAll('iframe,frame')) {
            let d = null;
            try { d = f.contentDocument; } catch { /* another site's frame */ }
            if (d) { const was = frameNow; frameNow = (was ? was + ' > ' : '') + (f.title || f.name || f.id || 'iframe'); walk(d); frameNow = was; }
          }
        };
        walk(document);
        const shown = (n) => { if (!n || !n.getBoundingClientRect) return false; const r = n.getBoundingClientRect(); const s = (n.ownerDocument.defaultView || window).getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const words = (n) => String((n && (n.innerText || n.textContent)) || '').replace(/\\s+/g, ' ').trim();
        const near = (el) => {
          const own = (el.labels && el.labels[0] && words(el.labels[0])) || el.getAttribute('aria-label') || el.title || '';
          if (own) return own.slice(0, 40);
          let n = el.parentElement;
          for (let i = 0; n && i < 4; i += 1, n = n.parentElement) { const t = words(n); if (t && t.length <= 60) return t.slice(0, 40); }
          return '';
        };
        const DIALOG = 'dialog[open],[role=dialog],[aria-modal=true],.modal,[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"],[class*="popup"],[class*="Popup"]';
        let matches = (el) => true;
        try { document.querySelector(${JSON.stringify(sel)}); matches = (el) => el.matches(${JSON.stringify(sel)}); } catch { matches = () => false; }
        window.__deskFileBoxList = seen.map((b) => b.el);
        return seen.map(({ el, frame }, index) => {
          const dlg = el.closest(DIALOG);
          return { index, accept: el.accept || '', multiple: Boolean(el.multiple), hidden: !shown(el), inDialog: Boolean(dlg && shown(dlg)), frame, label: near(el), name: el.name || el.id || '', matches: matches(el) };
        });
      })()`;
      const listed = await this.evaluateRaw(find);
      if (!listed.ok) return listed;
      const boxes = Array.isArray(listed.value) ? listed.value : [];
      const fits = (box) => fileBoxTakes(box.accept, absPaths);
      const shownList = boxes.map((b) => ({ ...b, fits: fits(b) }));
      const say = (b) => `#${b.index}${b.hidden ? ' hidden' : ''}${b.inDialog ? ' in an open dialog' : ''}${b.frame ? ` in frame ${b.frame}` : ''} accept="${b.accept || 'anything'}"${b.label ? ` near 「${b.label}」` : ''}${b.fits ? '' : ' (does not take these files)'}`;
      const listText = shownList.map(say).join('; ');
      const HIDDEN_NOTE = 'Hidden file boxes (display:none, inside a dialog, in shadow DOM or a same-site frame) are set directly by this tool - no need to click 上传 or open a file picker first.';
      if (!boxes.length) {
        return errorResult('NO_FILE_BOX', `no file box (input type=file) on this page. ${HIDDEN_NOTE} If the page builds its file box only after a click on its upload area, click that once (browser_click), then call browser_upload again.`);
      }
      const pool = args?.selector ? shownList.filter((b) => b.matches) : shownList;
      if (!pool.length) return errorResult('NO_FILE_BOX', `no file box matches selector ${sel}. The file boxes on this page: ${listText}. ${HIDDEN_NOTE}`, { boxes: shownList });
      let box = null;
      if (args?.index !== undefined && args?.index !== null && args?.index !== '') {
        box = pool[Math.max(0, Number(args.index) || 0)] || null;
        if (!box) return errorResult('NO_FILE_BOX', `no file box #${args.index}${args?.selector ? ` among those matching ${sel}` : ''}. The file boxes on this page: ${listText}. ${HIDDEN_NOTE}`, { boxes: shownList });
        if (!box.fits) return errorResult('WRONG_FILE_BOX', `file box #${box.index} takes ${box.accept}, not these files. The file boxes on this page: ${listText}. Pass the index of one that takes them.`, { boxes: shownList });
      } else {
        // Not told which: the one that takes these files - one in an open dialog first.
        const ok = pool.filter((b) => b.fits);
        if (!ok.length) return errorResult('WRONG_FILE_BOX', `no file box on this page takes these files. The file boxes: ${listText}.`, { boxes: shownList });
        const inDialog = ok.filter((b) => b.inDialog);
        const top = inDialog.length ? inDialog : ok;
        if (top.length > 1 && top.some((b) => b.accept !== top[0].accept || b.label !== top[0].label)) {
          return errorResult('WHICH_FILE_BOX', `several file boxes take these files: ${top.map(say).join('; ')}. Call browser_upload again with the index of the right one (all boxes: ${listText}). ${HIDDEN_NOTE}`, { boxes: shownList });
        }
        [box] = top;
      }
      const found = await page.send('Runtime.evaluate', { expression: `(window.__deskFileBoxList || [])[${box.index}] || null`, returnByValue: false });
      const objectId = found?.result?.objectId;
      if (!objectId) return errorResult('NO_FILE_BOX', `file box #${box.index} went away (the page changed). The file boxes were: ${listText}.`);
      await page.send('DOM.enable').catch(() => {});
      await page.send('DOM.setFileInputFiles', { files: absPaths, objectId }, { timeoutMs: 60000 });
      return { ok: true, uploaded: absPaths.length, files: absPaths.map((p) => p.split(/[\\/]/).pop()), box: { index: box.index, accept: box.accept, label: box.label, hidden: box.hidden, inDialog: box.inDialog, ...(box.frame ? { frame: box.frame } : {}) }, boxes: shownList.length, note: 'The files were handed to the page; take a browser_screenshot to see them appear (big pictures can take a few seconds).' };
    } catch (err) {
      return errorResult('UPLOAD_FAILED', err.message);
    }
  }

  async type(args) {
    const text = String(args?.text ?? '');
    if (!text) return errorResult('BAD_ARGS', 'browser_type needs a non-empty "text"');
    if (text.length > 5000) return errorResult('BAD_ARGS', 'browser_type is limited to 5000 characters');

    try {
      await this.ensureSession();
      const resolved = await this.resolveTarget(args);
      if (!resolved.ok) return resolved;
      const page = await this.ensurePage();
      const { x, y, tag, name } = resolved.target;

      // Focus through a real mouse click at the element centre, then clear and
      // insert. insertText is a single trusted-ish text input, which is what
      // modern frameworks listen for.
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      // 1.5.50 (S1): a rich editor (小红书's body, any contenteditable) keeps its
      // own model of the text: it is cleared with a real key, paragraphs are
      // typed with Enter between them, and append: true writes at the end. The
      // 发布 bot wrote a CDP script for each of these, every post.
      const probe = await this.evaluateRaw(`(() => {
        const el = document.activeElement;
        return Boolean(el && el.isContentEditable && !('value' in el && typeof el.value === 'string'));
      })()`);
      const rich = probe.ok && probe.value === true;
      const append = Boolean(args?.append);
      if (append) {
        await this.evaluateRaw(`(() => {
          const el = document.activeElement;
          if (!el) return false;
          if ('value' in el && typeof el.value === 'string') { const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* not a text box */ } return true; }
          if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
          return false;
        })()`);
      } else if (rich) {
        await this.evaluateRaw(`(() => {
          const el = document.activeElement;
          const r = document.createRange(); r.selectNodeContents(el);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          return true;
        })()`);
        await pressKey(page, parseKey('Backspace'));
      } else {
        await this.evaluateRaw(`(() => {
          const el = document.activeElement;
          if (!el) return false;
          if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
          if (el.isContentEditable) { el.textContent = ''; return true; }
          return false;
        })()`);
      }
      const before = append ? String((await this.readFieldValue()) ?? '') : '';

      if (rich && text.includes('\n')) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]) await page.send('Input.insertText', { text: lines[i] });
          if (i < lines.length - 1) await pressKey(page, parseKey('Enter'));
        }
      } else {
        await page.send('Input.insertText', { text });
      }

      // Verify, and fall back to per-character key events if the field ignored
      // insertText (some custom editors do). A rich editor's text has its own
      // line breaks, so it is compared without white space; append keeps what was there.
      let actual = await this.readFieldValue();
      const squeeze = (v) => String(v ?? '').replace(/\s+/g, '');
      if (!rich && !append && actual !== text) {
        await this.evaluateRaw(`(() => {
          const el = document.activeElement;
          if (!el) return false;
          if ('value' in el) { el.value = ''; } else if (el.isContentEditable) { el.textContent = ''; }
          return true;
        })()`);
        for (const ch of text) {
          await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
        }
        actual = await this.readFieldValue();
      }
      const matched = rich || append ? squeeze(actual) === squeeze(before + text) : actual === text;
      let submitted = false;
      if (args?.submit) {
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
        submitted = true;
        await sleep(120);
        await this.waitForReadyState({ timeoutMs: 6000 });
        await this.waitForIdle({ timeoutMs: 6000 });
      }

      const location = await this.currentLocation();
      return {
        ok: true,
        typed: { tag, name, text, ...(append ? { append: true } : {}) },
        value: actual ?? '',
        matched,
        submitted,
        url: location?.url || '',
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  /**
   * Press keys on the page (1.5.50, S1): "Enter", "Ctrl+End", or several
   * separated by spaces ("ArrowDown ArrowDown Enter"), `times` over. Goes to
   * whatever has the focus - after browser_type, that field.
   */
  async press(args) {
    const spec = String(args?.keys || '').trim();
    if (!spec) return errorResult('BAD_ARGS', `browser_press needs "keys", e.g. "Enter" or "Ctrl+End"; known keys: ${KEY_NAMES.join(', ')}`);
    const parsed = spec.split(/\s+/).map(parseKey);
    const bad = spec.split(/\s+/).filter((_, i) => !parsed[i]);
    if (bad.length) return errorResult('BAD_ARGS', `unknown key "${bad[0]}"; known keys: ${KEY_NAMES.join(', ')} (with Ctrl+ / Shift+ / Alt+ / Meta+), or one letter or digit with a modifier`);
    const times = Math.min(Math.max(Number(args?.times) || 1, 1), 20);
    try {
      await this.ensureSession();
      const page = await this.ensurePage();
      for (let t = 0; t < times; t += 1) for (const k of parsed) await pressKey(page, k);
      await sleep(150);
      await this.waitForIdle({ timeoutMs: 4000 }).catch(() => {});
      const location = await this.currentLocation();
      return { ok: true, pressed: spec, times, url: location?.url || '' };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async readFieldValue() {
    const res = await this.evaluateRaw(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      if ('value' in el && typeof el.value === 'string') return el.value;
      if (el.isContentEditable) return el.textContent || '';
      return null;
    })()`);
    return res.ok ? res.value : null;
  }

  async screenshot(args, ctx) {
    const workspaceDir = ctx?.workspaceDir || P.workspaceDir;
    try {
      await this.ensureSession();
      const page = await this.ensurePage();
      const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeoutMs: 20000 });
      if (!shot?.data) return errorResult('SCREENSHOT_FAILED', 'the browser returned no image data');
      const buffer = Buffer.from(shot.data, 'base64');

      const requested = String(args?.path || '').trim();
      const relative = requested || path.join('artifacts', `${stamp()}.png`);
      const target = resolveInWorkspace(workspaceDir, relative);
      if (!target.inside) {
        return errorResult('SCREENSHOT_PATH_OUTSIDE', `screenshots must stay inside the workspace; "${relative}" resolves to ${target.abs}`);
      }
      // Folders one level at a time, the file through the checked open (1.5.60, the verifier F1):
      // a folder on the way that is a link to the data folder writes nothing there.
      try {
        await saveInside(workspaceDir, target.abs, buffer);
      } catch (err) {
        if (err.code === 'PATH_OUTSIDE_WORKSPACE') return errorResult('SCREENSHOT_PATH_OUTSIDE', `screenshots must stay inside the workspace; "${relative}" leads outside it through a link`);
        throw err;
      }

      let viewport = null;
      try {
        const metrics = await page.send('Page.getLayoutMetrics');
        viewport = {
          width: Math.round(metrics.cssLayoutViewport?.clientWidth || 0),
          height: Math.round(metrics.cssLayoutViewport?.clientHeight || 0),
        };
      } catch {
        /* optional */
      }

      return {
        ok: true,
        path: target.rel,
        absolutePath: target.abs,
        bytes: buffer.length,
        format: 'png',
        viewport,
      };
    } catch (err) {
      return browserFailure(err);
    }
  }

  /**
   * browser_download: let the browser fetch a URL and save it under
   * workspace/downloads. This is the "bot downloads the invoice for you" path -
   * it goes through the real browser, so it carries the profile's cookies.
   */
  async download(args, ctx) {
    const url = String(args?.url || '');
    if (!isHttpUrl(url)) return errorResult('BROWSER_BAD_URL', `browser_download needs an absolute http(s) URL; got "${url}"`);
    if (isPrivateHostname(url) && process.env.ALLOW_PRIVATE !== '1') {
      return errorResult('PRIVATE_HOST_BLOCKED', `${new URL(url).hostname} is a private or loopback address (set ALLOW_PRIVATE=1 to allow it)`);
    }

    const workspaceDir = ctx?.workspaceDir || P.workspaceDir;
    const downloadDir = path.join(workspaceDir, 'downloads');
    // 1.5.60 (the verifier's F1): the browser saves into a folder of the hub's own, in the data
    // folder under a random name; the file is then COPIED into the workspace through the checked
    // open. Before, it saved straight into workspace/downloads and was renamed to the path asked
    // for: either one a link to the data folder put the page's file there (mcp.json: a command
    // the hub runs at its next start).
    const staging = path.join(P.dataDir, 'browser-downloads', crypto.randomBytes(8).toString('hex'));

    try {
      const dl = await fsp.lstat(downloadDir).catch(() => null);
      if (dl && (dl.isSymbolicLink() || !dl.isDirectory())) {
        return errorResult('DOWNLOAD_FOLDER_LINK', 'workspace/downloads is a link (or not a folder): nothing is downloaded into it');
      }
      const session = await this.ensureSession();
      await mkdirInside(workspaceDir, downloadDir);
      await clearOldStaging();
      await fsp.mkdir(staging, { recursive: true });
      const before = new Set();

      // Prefer the browser-level domain (current Chrome); fall back to the
      // older page-level one on builds that dropped it.
      let configured = false;
      try {
        await session.browser.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: staging,
          eventsEnabled: true,
        }, { timeoutMs: 8000 });
        configured = true;
      } catch {
        configured = false;
      }
      if (!configured) {
        try {
          await session.page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: staging }, { timeoutMs: 8000 });
          configured = true;
        } catch {
          configured = false;
        }
      }
      if (!configured) {
        return errorResult('DOWNLOAD_UNAVAILABLE', 'this browser refused to configure a download directory');
      }

      // Track this download through the browser's own events: they tell us the
      // filename Chrome chose and, crucially, when the file is actually complete.
      // Polling the directory alone can grab Chrome's own artifacts (it writes a
      // downloads.htm while a download is in flight).
      const tracker = { guid: null, filename: null, state: null, received: 0 };
      const startedAt = Date.now();
      const offBegin = session.browser.on('Browser.downloadWillBegin', (event) => {
        if (!tracker.guid) {
          tracker.guid = event.guid;
          tracker.filename = event.suggestedFilename || null;
        }
      });
      const offProgress = session.browser.on('Browser.downloadProgress', (event) => {
        if (event.guid === tracker.guid) {
          tracker.state = event.state;
          tracker.received = event.receivedBytes ?? 0;
        }
      });

      // Navigating to an attachment URL starts a download and Chrome reports the
      // navigation as ERR_ABORTED. That is the success case here, so only a real
      // network error is fatal.
      const page = await this.ensurePage();
      this.inFlight = 0;
      this.lastActivity = Date.now();
      const nav = await page.send('Page.navigate', { url }, { timeoutMs: 30000 }).catch((err) => ({
        errorText: err.message,
      }));

      let file = null;
      try {
        if (nav?.errorText && !/ERR_ABORTED/i.test(nav.errorText)) {
          return errorResult('NAVIGATION_FAILED', `${nav.errorText} (${url})`);
        }

        const completed = await this.waitForDownloadState(tracker, 60000);
        if (completed === 'canceled') {
          return errorResult('DOWNLOAD_CANCELED', 'the browser canceled the download');
        }
        file = await this.findDownloadedFile(staging, before, tracker.filename, completed ? 8000 : 0, startedAt);
      } finally {
        offBegin();
        offProgress();
      }

      if (!file) {
        return errorResult('DOWNLOAD_TIMEOUT', 'no file appeared in the downloads folder within 60s', {
          downloadsDir: path.relative(workspaceDir, downloadDir).split(path.sep).join('/'),
        });
      }

      const source = path.join(staging, file);
      const stat = await fsp.stat(source);

      // Where it goes: the path asked for, or downloads/<name> (a free one: "name (1).ext", as Chrome did).
      const requested = String(args?.path || '').trim();
      let target;
      if (requested) {
        target = resolveInWorkspace(workspaceDir, requested);
        if (!target.inside) {
          return errorResult('DOWNLOAD_PATH_OUTSIDE', `downloads must stay inside the workspace; "${requested}" resolves to ${target.abs}`);
        }
      } else {
        target = resolveInWorkspace(workspaceDir, path.relative(workspaceDir, await freeNameIn(downloadDir, file)));
      }
      try {
        await copyInside(workspaceDir, source, target.abs);
      } catch (err) {
        if (err.code === 'PATH_OUTSIDE_WORKSPACE') return errorResult('DOWNLOAD_PATH_OUTSIDE', `downloads must stay inside the workspace; "${target.rel}" leads outside it through a link`);
        throw err;
      }
      const finalPath = target.abs;
      const finalRel = target.rel;

      return {
        ok: true,
        path: finalRel,
        absolutePath: finalPath,
        filename: path.basename(finalPath),
        bytes: stat.size,
        url,
        downloadsDir: path.relative(workspaceDir, downloadDir).split(path.sep).join('/'),
      };
    } catch (err) {
      return browserFailure(err);
    } finally {
      // 1.5.61 (the verifier's F14): downloads are off again - one the hub did not ask for (a
      // page's own, a URL another program handed over) must not land in its staging folder.
      if (this.session) await this.denyDownloads(this.session);
      // The hub's own copy goes; a file the browser still holds is cleared on a later download.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Downloads refused (from start, and again after each browser_download). */
  async denyDownloads(session) {
    try {
      await session.browser.send('Browser.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: 8000 });
    } catch {
      await session.page?.send('Page.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: 8000 }).catch(() => {});
    }
  }

  /** Wait for the browser to say the current download finished. */
  async waitForDownloadState(tracker, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tracker.state === 'completed') return 'completed';
      if (tracker.state === 'canceled') return 'canceled';
      await sleep(100);
    }
    // No events at all (older Chromium): report 'unknown' and let the file scan
    // decide instead of failing outright.
    return tracker.guid ? 'timeout' : 'unknown';
  }

  /**
   * Find the file the browser just wrote.
   *
   * Chrome renames duplicate downloads to "name (1).ext", and it also drops its
   * own `downloads.htm` artwork into the folder, so "newest file" is not a safe
   * heuristic. We prefer the exact suggested filename, then a "stem (n).ext"
   * variant, and only fall back to the newest non-HTML file when the browser
   * gave us no name at all.
   */
  async findDownloadedFile(dir, before, expectedName, extraWaitMs = 4000, startedAt = 0) {
    const deadline = Date.now() + Math.max(extraWaitMs, 2000);
    let settled = null;

    while (Date.now() < deadline) {
      const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => !n.endsWith('.crdownload') && !before.has(n));
      let chosen = null;

      if (expectedName) {
        const exact = names.find((n) => n === expectedName);
        if (exact) chosen = exact;
        if (!chosen) {
          const stem = expectedName.replace(/\.[^.]+$/, '');
          const ext = path.extname(expectedName);
          chosen = names.find((n) => n.startsWith(`${stem} (`) && (!ext || n.endsWith(ext))) || null;
        }
        // Chromium sometimes overwrites an existing file in place instead of
        // writing "name (1).ext"; accept that file if it was touched by this call.
        if (!chosen && startedAt) {
          const info = await fsp.stat(path.join(dir, expectedName)).catch(() => null);
          if (info && info.mtimeMs >= startedAt - 1500) chosen = expectedName;
        }
      }
      if (!chosen) {
        // No name from the browser: newest non-HTML file that is not a Chrome artifact.
        const candidates = [];
        for (const name of names) {
          if (/\.html?$/i.test(name)) continue;
          const info = await fsp.stat(path.join(dir, name)).catch(() => null);
          if (info?.size > 0) candidates.push({ name, size: info.size, mtime: info.mtimeMs });
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        chosen = candidates[0]?.name || null;
      }

      if (chosen) {
        const info = await fsp.stat(path.join(dir, chosen)).catch(() => null);
        if (info?.size > 0) {
          // Accept only once the size stops changing, so we never copy a
          // half-written file.
          if (settled && settled.name === chosen && settled.size === info.size) return chosen;
          settled = { name: chosen, size: info.size };
        }
      }
      await sleep(200);
    }
    return settled?.name || null;
  }

  async evaluate(args) {
    const expression = String(args?.expression || '');
    if (!expression.trim()) return errorResult('BAD_ARGS', 'browser_eval needs an expression');
    if (expression.length > 8000) return errorResult('BAD_ARGS', 'browser_eval is limited to 8000 characters');
    try {
      await this.ensureSession();
      const res = await this.evaluateRaw(expression, { timeoutMs: 30000 });
      if (!res.ok) return res;
      return { ok: true, value: res.value, type: res.type };
    } catch (err) {
      return browserFailure(err);
    }
  }

  async close() {
    const session = this.session;
    if (!session) {
      return { ok: true, closed: false, message: 'no browser session was running' };
    }
    const pid = session.pid;
    try {
      await session.browser?.send('Browser.close', {}, { timeoutMs: 3000 });
    } catch {
      /* older builds may not answer; the kill below covers it */
    }
    this.session = null;
    for (const conn of [session.page, session.browser]) {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }
    try {
      session.child?.kill();
    } catch {
      /* ignore */
    }
    await fsp.rm(stateFile(this.key), { force: true }).catch(() => {});
    return { ok: true, closed: true, pid };
  }

  /** Where the page really is now (clicks and redirects move it). */
  async currentUrl() {
    await this.ensureSession();
    const r = await this.evaluateRaw('location.href');
    return r?.ok && r.value ? String(r.value) : (this.session?.pageUrl || '');
  }

  async status() {
    const executable = detectBrowserExecutable();
    const session = this.session;
    const running = Boolean(session && session.page && !session.page.closed);
    const out = {
      ok: true,
      running,
      pid: running ? session.pid : null,
      profileDir: session?.profile || profileDir(this.key),
      // 1.5.61 (F7): no debugging port any more - the browser is driven over a pipe.
      cdpUrl: null,
      channel: running ? (session.channel || 'pipe') : null,
      headless: running ? session.headless : process.env.BROWSER_HEADLESS === '1',
      adopted: running ? session.adopted : false,
      executable: executable.path,
      detectedBy: executable.source,
      supported: browserSupport().supported,
      pageUrl: running ? session.pageUrl : null,
      // Windows remote machines: whether the human can see (and take over) this browser.
      ...(process.platform === 'win32' && !process.env.SESSIONNAME ? { visibleOnDesktop: Boolean(session?.onDesktop), takeoverNote: session?.onDesktop ? '' : '这台 Windows 机器上没有人登录桌面（或不是同一个账号），浏览器在后台无界面运行，接管时看不到它；需要用户登录桌面后重新打开浏览器。' } : {}),
    };
    if (!running) {
      out.checked = executable.checked.slice(0, 6);
      if (!executable.path) out.hint = installHint();
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Same private-network rule as http_fetch, applied to browser URLs. */
export function isPrivateHostname(url) {
  let hostname;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

/** Turn an exception from the manager into a structured tool result. */
function browserFailure(err) {
  const code = err?.code || 'browser_failed';
  if (code === 'not_configured') {
    return errorResult('not_configured', err.message, { hint: err.hint || installHint(), checked: err.checked });
  }
  if (code === 'unsupported') {
    return errorResult('unsupported', err.message, { hint: err.hint });
  }
  return errorResult(code, err?.message || 'browser operation failed');
}

// ---------------------------------------------------------------------------
// singleton
// ---------------------------------------------------------------------------

let manager = null;
const managers = new Map();

/**
 * One browser per bot. Tool calls reuse the same page, which is what lets
 * "snapshot then click @e3" work inside a single turn. Separate bots get
 * separate browsers on separate desktops, so bot A can never see bot B's tabs.
 */
// --- one login for the whole team (1.5.9) ------------------------------------
// Each bot has its own browser profile, so on 11-16 the human had to log in to
// 小红书 once for every bot ("登录信息保存好不要每次找我登录"). On a machine
// given to the bots, a login the human makes during a takeover is copied into
// browser-logins.json (sealed like the other key files) and every bot's
// browser on that machine picks it up. The human's own computer keeps each
// bot's logins to itself.
const loginsFile = () => path.join(P.dataDir, 'browser-logins.json');
export const sharesLogins = () => process.env.DESK_MACHINE_MODE === 'remote';

/** Newer cookies replace older ones with the same name, domain and path; expired ones go. */
export function mergeCookies(old = [], incoming = [], now = Date.now() / 1000) {
  const byKey = new Map();
  const keyOf = (c) => `${c.name}|${c.domain}|${c.path || '/'}`;
  for (const c of [...old, ...incoming]) {
    if (!c?.name || !c.domain || c.partitionKey) continue;
    if (Number(c.expires) > 0 && Number(c.expires) < now) { byKey.delete(keyOf(c)); continue; }
    byKey.set(keyOf(c), c);
  }
  return [...byKey.values()].slice(-3000);
}

/** Storage.getCookies -> Storage.setCookies parameters. */
export function cookieParams(cookies = []) {
  return cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}), ...(!c.session && Number(c.expires) > 0 ? { expires: c.expires } : {}),
  }));
}

export function getBrowserManager(key = '') {
  if (!key) {
    if (!manager) manager = new BrowserManager();
    return manager;
  }
  if (!managers.has(key)) managers.set(key, new BrowserManager({ key }));
  return managers.get(key);
}

/** All live managers, for status endpoints and shutdown. */
export function browserManagers() {
  return [...(manager ? [manager] : []), ...managers.values()];
}

export { BrowserManager, CdpConnection };

// Keep the OS import used: the Linux/VM docs mention the platform explicitly.
export const platformNote = () =>
  process.platform === 'win32'
    ? 'windowed Chrome by default; set BROWSER_HEADLESS=1 for a headless run'
    : `running on ${os.platform()}; a headless VM needs BROWSER_HEADLESS=1 or xvfb`;
