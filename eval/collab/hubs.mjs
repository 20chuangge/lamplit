// The hubs a collaboration run talks to: test hubs this run starts (own ports, own data, removed
// afterwards), or hubs it is pointed at (--real with EVAL_HUB / EVAL_PEER). Plus the event recorder:
// every event a hub sends on /api/stream, kept with the time it came, across restarts.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** A JSON client for one hub, with its local key (the human's own app sends it too). */
export function hubClient(url, key) {
  const base = url.replace(/\/+$/, '');
  const call = async (p, { method = 'GET', body, raw = null, headers = {}, timeoutMs = 30000 } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(key ? { 'x-lamplit-local': key } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`${method} ${p}: ${res.status} ${typeof data === 'object' ? data?.error?.message || data?.message || '' : String(data).slice(0, 160)}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };
  return { url: base, key, call, get: (p) => call(p), post: (p, body) => call(p, { method: 'POST', body }), put: (p, body) => call(p, { method: 'PUT', body }), patch: (p, body) => call(p, { method: 'PATCH', body }), del: (p) => call(p, { method: 'DELETE' }) };
}

async function seedHome(target, app = REPO) {
  for (const dir of ['config', 'skills', 'public']) {
    await fsp.cp(path.join(app, dir), path.join(target, dir), { recursive: true }).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
  await fsp.mkdir(path.join(target, 'workspace'), { recursive: true });
}

/**
 * A test hub of this run: own home folder, own port (kept across a restart), never the human's data.
 * env: what this run needs (the fake model's address is set later through /api/settings).
 */
/**
 * appDir: the Lamplit checkout whose server runs (default this one) - e.g. a release candidate's, to
 * compare two builds on the same scenarios.
 */
export async function startTestHub({ name, root, env = {}, log = () => {}, appDir = REPO }) {
  const home = path.join(root, name);
  await fsp.mkdir(home, { recursive: true });
  await seedHome(home, appDir);
  const port = await freePort();
  const hub = { name, home, port, url: `http://127.0.0.1:${port}`, dataDir: path.join(home, 'data'), workspace: path.join(home, 'workspace'), child: null, test: true, stderr: '' };
  const spawnIt = async () => {
    // Nothing of the caller's Lamplit settings leaks in (smoke sets a mock model and no message gathering).
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ASSIST_|LAMPLIT_|DESK_|BROWSER_|CHROME_PATH$|ALLOW_PRIVATE$|PORT$|HOST$)/.test(k)));
    const childEnv = {
      ...inherited,
      ASSIST_HOME: home,
      ASSIST_DATA_DIR: hub.dataDir,
      ASSIST_WORKSPACE_DIR: hub.workspace,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Never the human's screen, Tailscale or network: loopback only, a VNC port nothing listens on.
      DESK_VNC_PORT: '1',
      DESK_LOCAL_VNC: '0',
      DESK_TAILSCALE_SIMULATE: '1',
      LAMPLIT_DIRECT_ALLOW_LOOPBACK: '1',
      LAMPLIT_DIRECT_BIND: '127.0.0.1',
      // The mock sites live on 127.0.0.1.
      ALLOW_PRIVATE: '1',
      ...env,
    };
    delete childEnv.ASSIST_API_KEY;
    const child = spawn(process.execPath, [path.join(appDir, 'src', 'server.mjs')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    hub.child = child;
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`hub ${name} did not start in 30 s\n${hub.stderr.slice(-2000)}`)), 30000);
      child.stdout.on('data', (c) => {
        buf += c.toString('utf8');
        for (const line of buf.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try { if (JSON.parse(t).event === 'ready') { clearTimeout(timer); resolve(); } } catch { /* partial */ }
        }
        if (buf.length > 20000) buf = buf.slice(-4000);
      });
      child.stderr.on('data', (c) => { hub.stderr += c.toString('utf8'); if (hub.stderr.length > 40000) hub.stderr = hub.stderr.slice(-20000); log(`[${name}] ${c.toString('utf8').trim().slice(0, 300)}`); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`hub ${name} exited (${code})\n${hub.stderr.slice(-2000)}`)); });
    });
    hub.key = fs.readFileSync(path.join(hub.dataDir, 'local-key'), 'utf8').trim();
    hub.token = JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'security.json'), 'utf8')).token;
    hub.api = hubClient(hub.url, hub.key);
  };
  hub.stop = async () => {
    const proc = hub.child;
    hub.child = null;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    if (await Promise.race([exited.then(() => false), sleep(5000).then(() => true)])) { proc.kill('SIGKILL'); await Promise.race([exited, sleep(2000)]); }
  };
  /** A power cut (no clean shutdown), then the same hub again on the same port and data. */
  hub.restart = async ({ hard = true } = {}) => {
    const proc = hub.child;
    hub.child = null;
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill(hard ? 'SIGKILL' : 'SIGTERM');
      await Promise.race([exited, sleep(5000)]);
    }
    await sleep(300);
    await spawnIt();
  };
  await spawnIt();
  return hub;
}

/** A hub this run is pointed at (--real): its address and local key from the environment. */
export async function attachHub({ name, url, key }) {
  const api = hubClient(url, key);
  const health = await api.get('/api/health');
  const ws = await api.get('/api/workspace').catch(() => null);
  return { name, url: api.url, key, api, test: false, dataDir: health?.dataDir || '', workspace: ws?.path || '', version: health?.version || '', stop: async () => {}, restart: null };
}

/**
 * Every event of one hub, as the page would see it. Reconnects (a restart), so nothing between is lost
 * except what the hub sent while it was down. rows: { hub, at (ms), ...event }.
 */
export function recordEvents(hub, rows, { onEvent = () => {}, path: streamPath = '/api/stream', map = (ev) => ev } = {}) {
  let stopped = false;
  let ctrl = null;
  const loop = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch(`${hub.url}${streamPath}`, { headers: { 'x-lamplit-local': hub.key, accept: 'text/event-stream' }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data) continue;
            let ev;
            try { ev = JSON.parse(data); } catch { continue; }
            const row = { hub: hub.name, at: Date.now(), ...map(ev) };
            rows.push(row);
            try { onEvent(row); } catch { /* the human's trigger must not stop the recorder */ }
          }
        }
      } catch { /* down or stopped */ }
      if (!stopped) await sleep(300);
    }
  };
  const done = loop();
  return { stop: async () => { stopped = true; ctrl?.abort(); await Promise.race([done, sleep(1000)]); } };
}

/** A fresh scratch folder for the test hubs of one run. */
export function scratchRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lamplit-collab-${tag}-`));
}
