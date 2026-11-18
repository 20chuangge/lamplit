/**
 * remote.mjs - turn a machine you can SSH into into a Desk machine.
 *
 * The human gives an address and an SSH account. We find out what the target
 * runs, upload the app and the one setup script for that OS, run it with sudo,
 * and hand back the new hub's address and pairing code. Nothing is required on
 * the target beforehand, and the SSH password is held in memory for this one
 * job only - it is never persisted or logged.
 *
 * Linux (apt and dnf/yum families) runs hub/setup-linux.sh with sudo; Windows
 * (OpenSSH server, admin account) runs hub/setup-windows.ps1.
 */

import net from 'node:net';
// The TightVNC MSI (cached here, uploaded to new Windows machines; also this computer's own screen).
import { tightVncInstaller } from './localvnc.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { uid, nowIso, P } from './store.mjs';
import { packApp, cleanupPack } from './bundle.mjs';
import { checkRelay } from './relaylink.mjs';

// ssh2 is only needed when this machine PROVISIONS another one. Importing it
// eagerly would make a freshly deployed hub crash on boot when node_modules was
// not shipped, so load it on first use instead.
let ssh2Module = null;
async function loadSsh2() {
  if (!ssh2Module) {
    try {
      ssh2Module = await import('ssh2');
    } catch {
      throw remoteError('REMOTE_NO_SSH2', '这台机器上没有 ssh2 依赖，无法再远程配置别的机器；请在 Lamplit 客户端里操作。');
    }
  }
  return ssh2Module;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPTS = {
  linux: path.join(HERE, '..', 'hub', 'setup-linux.sh'),
  windows: path.join(HERE, '..', 'hub', 'setup-windows.ps1'),
};
// The Tailscale relay in China (1.5.29): hub/derp-linux.sh, run with sudo in the background.
const RELAY_SCRIPT = path.join(HERE, '..', 'hub', 'derp-linux.sh');
export const RELAY_PORT = 33445;
// Lamplit's own relay, no Tailscale (第 1 步原型): hub/relay-linux.sh installs hub/relay/relay.mjs.
const TUNNEL_SCRIPT = path.join(HERE, '..', 'hub', 'relay-linux.sh');
const TUNNEL_PROGRAM = path.join(HERE, '..', 'hub', 'relay', 'relay.mjs');
// The Lamplit on a server joins the relay (第 2 步): hub/relay-hub-join.sh, root, settings in a file.
const TUNNEL_JOIN_SCRIPT = path.join(HERE, '..', 'hub', 'relay-hub-join.sh');
export const TUNNEL_PORT = 34443;

/**
 * Where to open a relay's port in the cloud console, in words (第 2 步). The
 * server's own firewall (ufw / firewalld) is opened by the installer; the
 * cloud's is outside the server and only its owner can change it.
 */
export function relayPortAdvice(port) {
  const p = Number(port) || TUNNEL_PORT;
  return `在云服务器控制台放行 TCP ${p}（来源 0.0.0.0/0）：腾讯云轻量应用服务器在实例详情的「防火墙」页添加规则；腾讯云 CVM（云服务器）在「安全组」的入站规则里添加；阿里云 ECS 也是「安全组」。`;
}

/**
 * Hand a Lamplit on a Linux server its relay settings over an open SSH
 * session (第 2 步): the settings go into a file only this account can read,
 * hub/relay-hub-join.sh gives them to that Lamplit on 127.0.0.1 with its local
 * key, then deletes the file. The join secret never crosses the network in
 * the clear and never appears on a command line.
 * -> 'ok' | 'none' (no Lamplit there) | 'error:<why>'
 */
async function joinHubOverSsh(client, { sudoPrefix = '', password = '', isRoot = true }, settings) {
  const id = crypto.randomBytes(6).toString('hex');
  const body = `/tmp/lamplit-relay-join-${id}.json`;
  const script = `/tmp/lamplit-relay-join-${id}.sh`;
  const put = await execStream(client, `umask 077; cat > ${body} && test -s ${body}`, { stdin: JSON.stringify(settings), endInput: true, timeoutMs: 15000 })
    .catch((err) => ({ code: 1, output: err.message }));
  if (put.code !== 0) return 'error:没能把设置交给那台服务器';
  try {
    await uploadFile(client, TUNNEL_JOIN_SCRIPT, script);
    const ran = await execStream(client, `${sudoPrefix}/bin/bash ${script} ${body}`, { stdin: isRoot ? '' : `${password}\n`, timeoutMs: 90000 });
    return (/^DESK_HUB_RELAY=(.*)$/m.exec(ran.output)?.[1] || '').trim() || `error:exit ${ran.code}`;
  } finally {
    await execStream(client, `rm -f ${body} ${script}`, { timeoutMs: 15000 }).catch(() => {});
  }
}

/** A public IPv4 address (not private, loopback or Tailscale's 100.64/10): what a relay must be reached on. */
export function isPublicIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return false;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  return true;
}
// A freshly restored machine downloads everything (Node, a desktop, a browser)
// and may be sharing its package lock with the OS's own updates: give it an hour.
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

/** Setup scripts tag their lines "[desk]"; the human only needs the words. */
const cleanLine = (text) => String(text).replace(/^\s*\[desk\]\s*/, '').replace(/^警告：/, '⚠ ');

/** A Tailscale device name from the machine's name: letters, digits, dashes (or none). */
export function tailscaleDeviceName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function remoteError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

/** Hostnames/IPs only. The value becomes an SSH target, never a shell string. */
export function assertHost(host) {
  const value = String(host ?? '').trim();
  if (!value || value.length > 253) throw remoteError('REMOTE_BAD_HOST', 'a machine address is required');
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw remoteError('REMOTE_BAD_HOST', `"${value}" is not a valid host`);
  if (value.startsWith('-')) throw remoteError('REMOTE_BAD_HOST', 'host must not start with "-"');
  return value;
}

function assertPort(value, fallback, name) {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw remoteError('REMOTE_BAD_PORT', `${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function assertCredential(value, name) {
  const text = String(value ?? '');
  if (!text) throw remoteError('REMOTE_CREDENTIALS', `${name} is required`);
  if (text.includes('\n') || text.includes('\r')) {
    throw remoteError('REMOTE_CREDENTIALS', `${name} must not contain a newline`);
  }
  return text;
}

/** One TCP reachability probe. Never throws. */
export function probeTcp(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** The machine's Tailscale IPv4 from `tailscale ip -4` (1.5.1), or ''. */
export function parseTailnetIp(output) {
  return /^(100\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/m.exec(String(output || ''))?.[1] || '';
}

/**
 * Does a Lamplit answer there over HTTP? (1.5.1) Any answer counts - an
 * unpaired machine says 401. A bare TCP connect is not enough: a cloud
 * provider's edge can accept the connection and send nothing back.
 */
export async function probeHttp(url, timeoutMs = 5000) {
  try {
    const res = await fetch(`${String(url).replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel?.().catch?.(() => {});
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The first address that answers, in the order given ('' for none). */
export async function firstAnswering(urls, probe = probeHttp) {
  for (const url of urls) {
    if (url && (await probe(url))) return url;
  }
  return '';
}

// ---------------------------------------------------------------------------
// ssh helpers
// ---------------------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** SSH errors are accurate but unreadable; say what the human can act on. */
function friendlySshError(err) {
  const message = String(err?.message || '');
  if (/authentication methods failed|All configured/i.test(message)) {
    return 'SSH 账号或密码不对，或者这个账号禁止密码登录。';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return '连不上 SSH 端口。确认机器已开机、SSH 服务在跑、端口没有写错。';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return '解析不到这个地址，检查 IP 或主机名。';
  }
  if (/timed out|ETIMEDOUT|timeout/i.test(message)) {
    return '连接 SSH 超时，检查两台机器是否在同一网络、防火墙是否放行。';
  }
  return message || '远程配置失败';
}

/**
 * Remember each machine's SSH host key the first time (SEC-10). A key that
 * changed later means another machine answers at that address (or it was
 * reinstalled): stop before the password is sent. -> {ok, first, fingerprint, message?}
 */
export function checkHostKey({ file = path.join(P.dataDir, 'known-hosts.json'), host, port = 22, key }) {
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
  const id = `${String(host).toLowerCase()}:${Number(port) || 22}`;
  let known = {};
  try { known = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first one */ }
  const saved = known[id]?.fingerprint;
  if (saved && saved !== fingerprint) {
    return { ok: false, first: false, fingerprint, message: `这台机器（${id}）的 SSH 指纹变了：以前是 ${saved}，现在是 ${fingerprint}。可能是重装过系统，也可能有人冒充它。确认是重装后，在 设置 → 机器 里删掉它再重新添加。` };
  }
  if (!saved) {
    known[id] = { fingerprint, firstSeen: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(known, null, 2));
    } catch (err) {
      console.error('[remote] could not save the SSH host key:', err.message);
    }
  }
  return { ok: true, first: !saved, fingerprint };
}

/** Forget a machine's host key (it was removed from the list, or reinstalled). */
export function forgetHostKey({ file = path.join(P.dataDir, 'known-hosts.json'), host, port = 22 }) {
  try {
    const known = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    delete known[`${String(host).toLowerCase()}:${Number(port) || 22}`];
    fs.writeFileSync(file, JSON.stringify(known, null, 2));
  } catch { /* nothing saved */ }
}

function connectSsh({ host, port, username, password }) {
  return new Promise(async (resolve, reject) => {
    const { Client } = await loadSsh2();
    const client = new Client();
    let settled = false;
    let hostCheck = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        client.end();
        reject(hostCheck && !hostCheck.ok ? remoteError('REMOTE_HOST_KEY_CHANGED', hostCheck.message) : err);
      } else {
        client.hostCheck = hostCheck;
        resolve(client);
      }
    };
    client.once('ready', () => finish(null));
    // `on`, not `once`: Windows OpenSSH resets the socket after refusing a
    // login, so a second 'error' follows the first. With no listener left,
    // Node treats it as unhandled and the whole server process dies.
    client.on('error', (err) => finish(err));
    client.connect({
      host,
      port,
      username,
      password,
      // Checked before the password goes out.
      hostVerifier: (key) => {
        hostCheck = checkHostKey({ host, port, key });
        return hostCheck.ok;
      },
      // Windows OpenSSH on a fresh VM can take 15-20 s to finish the handshake.
      readyTimeout: 45000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    });
  });
}

/**
 * Upload a local file to the target over SFTP. Used for the app tarball: piping
 * a megabyte through `exec` stdin works but is fragile on slow links.
 */
function uploadFile(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(remoteError('REMOTE_UPLOAD_FAILED', `SFTP 不可用：${err.message}`));
        return;
      }
      sftp.fastPut(localPath, remotePath, (putErr) => {
        sftp.end?.();
        if (putErr) reject(remoteError('REMOTE_UPLOAD_FAILED', `上传失败：${putErr.message}`));
        else resolve(true);
      });
    });
  });
}

/**
 * Exec one command, streaming output. `stdin` is written immediately (used for
 * the sudo password). Resolves with the exit code; throws on timeout.
 */
function execStream(client, command, { stdin = '', endInput = false, onLine = () => {}, timeoutMs = JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let output = '';
    let pending = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(remoteError('REMOTE_TIMEOUT', `那台机器上的安装超过 ${Math.round(timeoutMs / 60000)} 分钟还没结束（多半是下载太慢），它会在后台继续装完。过几分钟再点一次「连接并自动配置」，会等它装完再接着做。`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        done = true;
        reject(err);
        return;
      }
      const consume = (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        if (output.length > 200000) output = output.slice(-200000);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) onLine(line);
      };
      stream.on('data', consume);
      stream.stderr?.on('data', consume);
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (pending) onLine(pending);
        if (done) return;
        done = true;
        resolve({ code: code ?? 0, output });
      });
      if (stdin) stream.write(stdin);
      // "sudo -S" reads one line and goes on; "cat > file" waits for the end of input.
      if (endInput) stream.end();
    });
  });
}

export { execStream as _execStream };

// ---------------------------------------------------------------------------
// provisioning jobs
// ---------------------------------------------------------------------------

/**
 * Give a freshly installed hub the same model as the machine that set it up,
 * so a new machine works the moment it is added. Pairs with the install's
 * code, then PUTs the settings; the key travels once, over the LAN, to the
 * hub that will use it.
 */
async function shareModel(hubUrl, pairCode, model, voice = null, vision = null) {
  const pair = await fetch(`${hubUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (!pair.ok) throw new Error(`pair HTTP ${pair.status}`);
  const cookie = (pair.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(`${hubUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(model),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`settings HTTP ${res.status}`);
  if (voice) {
    const v = await fetch(`${hubUrl}/api/voice`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(voice),
      signal: AbortSignal.timeout(15000),
    });
    if (!v.ok) throw new Error(`voice HTTP ${v.status}`);
  }
  if (vision) {
    const v = await fetch(`${hubUrl}/api/vision`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(vision),
      signal: AbortSignal.timeout(15000),
    });
    if (!v.ok) throw new Error(`vision HTTP ${v.status}`);
  }
}

/** The relay settings to a freshly installed Windows hub, like shareModel (第 2 步). */
async function shareRelay(hubUrl, pairCode, settings) {
  const pair = await fetch(`${hubUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (!pair.ok) throw new Error(`pair HTTP ${pair.status}`);
  const cookie = (pair.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(`${hubUrl}/api/relay-link`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(settings),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
}

/**
 * The Node.js build a target needs, downloaded once on this computer (checked
 * against the official SHA-256 list) and cached, then uploaded over the LAN:
 * a fresh machine downloading 30 MB from nodejs.org is often the slowest step
 * of an install. kind: 'linux' (tar.gz) | 'win' (zip); arch: x64 | arm64.
 * Returns {file, bytes} or null (the target then downloads it itself).
 */
export async function nodePackage(kind, arch = 'x64') {
  const ext = kind === 'win' ? 'zip' : 'tar.gz';
  const dir = path.join(os.tmpdir(), 'nightshift-cache');
  await fsp.mkdir(dir, { recursive: true });
  const re = new RegExp(`^node-v22\\.[0-9.]+-${kind}-${arch}\\.${ext.replace('.', '\\.')}$`);
  const cached = (await fsp.readdir(dir).catch(() => [])).filter((n) => re.test(n)).sort().pop();
  if (cached) {
    const st = await fsp.stat(path.join(dir, cached));
    if (st.size > 10 * 1024 * 1024) return { file: path.join(dir, cached), bytes: st.size };
  }
  for (const base of ['https://npmmirror.com/mirrors/node/latest-v22.x', 'https://nodejs.org/dist/latest-v22.x']) {
    try {
      const sums = await (await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(20000) })).text();
      const line = sums.split('\n').find((l) => re.test(l.trim().split(/\s+/).pop() || ''));
      if (!line) continue;
      const [hash, name] = line.trim().split(/\s+/);
      const res = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash.toLowerCase()) continue;
      const file = path.join(dir, name);
      await fsp.writeFile(`${file}.part`, bytes);
      await fsp.rename(`${file}.part`, file);
      return { file, bytes: bytes.length };
    } catch { /* next source */ }
  }
  return null;
}

/** modelToShare: () => {provider, baseUrl, model, apiKey} | null
 *  voiceToShare: () => {baseUrl, model, apiKey} | null  (speech-to-text) */
/*  relayToShare: () => {host, port, relayFingerprint, join} | null  (Lamplit's own relay, 第 2 步)
 *  onRelayTunnel({host, port, fingerprint, join}) / onRelayRemoved({host}): this computer's relay settings */
export function createProvisioner({ modelToShare = () => null, voiceToShare = () => null, visionToShare = () => null, relayToShare = () => null, onRelayTunnel = async () => {}, onRelayRemoved = async () => {}, checkRelayImpl = checkRelay } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  const publicJob = (job) => ({
    id: job.id,
    state: job.state,
    message: job.message,
    step: job.step,
    totalSteps: job.totalSteps,
    address: job.address || '',
    os: job.os || '',
    hubPort: job.hubPort,
    hubUrl: job.hubUrl || '',
    pairCode: job.pairCode || '',
    modelShared: Boolean(job.modelShared),
    ...(job.mode ? { mode: job.mode } : {}),
    ...(job.relayJoined !== undefined ? { relayJoined: Boolean(job.relayJoined) } : {}),
    // How long each step took, to see what makes an install slow.
    timings: (job.timings || []).map((t) => ({ label: t.label, ms: t.ms })),
    desktopPending: Boolean(job.desktopPending),
    tailscale: job.tailscale || '',
    // Lamplit's relay: where it is and its certificate - never its join secret.
    ...(job.relayTunnel ? { relayTunnel: job.relayTunnel } : {}),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    log: job.log.slice(-24),
  });

  /** Start timing a phase; the previous one ends here. */
  const phase = (job, label) => {
    const now = Date.now();
    job.timings = job.timings || [];
    const last = job.timings[job.timings.length - 1];
    if (last && last.ms === undefined) last.ms = now - last.at;
    if (label) job.timings.push({ label, at: now });
  };

  const setProgress = (job, message) => {
    job.message = message;
    // The setup scripts announce their steps as "[desk] 3/7 …".
    const scriptStep = /^(?:\[desk\]\s*)?(\d+\s*\/\s*\d+\s+.+)$/.exec(String(message).trim());
    if (scriptStep) phase(job, scriptStep[1].slice(0, 40));
    const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
    if (match) {
      job.step = Number(match[1]);
      job.totalSteps = Number(match[2]);
    }
    job.log.push(message);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  /** 'linux' | 'windows' | 'unknown', from whatever shell answers. */
  async function detectOs(client) {
    const probe = await execStream(client, 'uname -s', { timeoutMs: 15000 }).catch(() => ({ code: 1, output: '' }));
    if (probe.code === 0 && /linux/i.test(probe.output)) return 'linux';
    // Git for Windows / MSYS put a uname on PATH.
    if (probe.code === 0 && /mingw|msys|cygwin|windows/i.test(probe.output)) return 'windows';
    if (probe.code === 0 && probe.output.trim()) return 'unknown';
    // Windows OpenSSH starts cmd.exe ("ver") or PowerShell (no "ver"); ask
    // powershell.exe directly, which answers from either.
    const win = await execStream(client, 'ver', { timeoutMs: 15000 }).catch(() => ({ code: 1, output: '' }));
    if (/windows/i.test(win.output)) return 'windows';
    const ps = await execStream(client, 'powershell -NoProfile -Command [Environment]::OSVersion.VersionString', { timeoutMs: 20000 })
      .catch(() => ({ code: 1, output: '' }));
    return /windows/i.test(ps.output) ? 'windows' : 'unknown';
  }

  /**
   * Windows: upload into the account's home (SFTP starts there; cmd.exe and
   * PowerShell sessions too), then run the script with Windows PowerShell.
   * The script itself refuses a non-admin account.
   */
  /** Windows: the Tailscale key into a file only administrators can read (from stdin, never a command line). -> its path or '' */
  async function putWindowsTailscaleKey(client, key) {
    const ps = "$k=[Console]::In.ReadToEnd().Trim(); $p=Join-Path $env:SystemRoot 'Temp\\desk-tailscale.key'; "
      + "Set-Content -Path $p -Value $k -NoNewline -Encoding ascii; "
      + "icacls $p /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null; "
      + "if ((Get-Item $p).Length -gt 10) { Write-Output \"KEYPATH=$p\" } else { exit 1 }";
    const put = await execStream(client, `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdin: `${key}\n`, endInput: true, timeoutMs: 30000 })
      .catch((err) => ({ code: 1, output: err.message }));
    const m = /KEYPATH=(.+)/.exec(put.output || '');
    return put.code === 0 && m ? m[1].trim() : '';
  }

  async function installWindows(client, job, packed, hubPort, { tailscaleKey = '', tailscaleName = '' } = {}) {
    await uploadFile(client, packed.file, 'desk-hub.tar.gz');
    // The desktop (TightVNC) installer comes from here, not from the target:
    // a freshly installed Windows often cannot validate tightvnc.com's
    // certificate ("未能为 SSL/TLS 安全通道建立信任关系"), and some networks
    // cannot reach it. The target still checks GlavSoft's signature.
    let vncArg = '';
    const msi = await tightVncInstaller().catch(() => null);
    if (msi) {
      setProgress(job, `上传桌面组件 TightVNC（${Math.max(1, Math.round(msi.bytes / 1024 / 1024))} MB）…`);
      await uploadFile(client, msi.file, 'desk-tightvnc.msi');
      vncArg = ' -VncMsi desk-tightvnc.msi';
    }
    let nodeArg = '';
    const nodeZip = await nodePackage('win', 'x64').catch(() => null);
    if (nodeZip) {
      setProgress(job, `上传 Node.js（${Math.max(1, Math.round(nodeZip.bytes / 1024 / 1024))} MB，目标机器不用再下载）…`);
      await uploadFile(client, nodeZip.file, 'desk-node.zip');
      nodeArg = ' -NodeZip desk-node.zip';
    }
    // PowerShell 5.1 reads a BOM-less script as the ANSI code page, which
    // garbles the Chinese progress text; ship it with a UTF-8 BOM.
    const source = await fsp.readFile(SETUP_SCRIPTS.windows);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const withBom = path.join(os.tmpdir(), `desk-setup-${process.pid}-${Date.now()}.ps1`);
    await fsp.writeFile(withBom, source.subarray(0, 3).equals(bom) ? source : Buffer.concat([bom, source]));
    try {
      await uploadFile(client, withBom, 'desk-setup.ps1');
    } finally {
      fsp.rm(withBom, { force: true }).catch(() => {});
    }
    // Optional Tailscale: the key goes in a private file first; never skipped silently.
    const windowsTailscaleArgs = async () => {
      if (!tailscaleKey) return '';
      setProgress(job, '把 Tailscale 密钥交给那台机器…');
      const keyPath = await putWindowsTailscaleKey(client, tailscaleKey);
      if (!keyPath) { job.tailscale = 'Tailscale 没装：密钥没能交给那台机器'; return ''; }
      return ` -TailscaleKeyFile "${keyPath}"${tailscaleName ? ` -TailscaleName ${tailscaleName}` : ''}`;
    };
    setProgress(job, '安装并启动（首次 2-5 分钟）…');
    return execStream(
      client,
      `powershell -NoProfile -ExecutionPolicy Bypass -File desk-setup.ps1 -Port ${Number(hubPort)} -Pkg desk-hub.tar.gz${vncArg}${nodeArg}${await windowsTailscaleArgs()}`,
      {
        onLine: (line) => {
          const text = line.trim();
          if (text && !/^DESK_/.test(text)) setProgress(job, cleanLine(text).slice(0, 300));
        },
      },
    );
  }

  async function runRelay(job, { host, sshPort, username, password, publicIp }) {
    let client = null;
    try {
      phase(job, '连接 SSH');
      setProgress(job, '正在连接 SSH…');
      client = await connectSsh({ host, port: sshPort, username, password });
      job.os = await detectOs(client);
      if (job.os !== 'linux') throw remoteError('REMOTE_UNSUPPORTED_OS', '国内中转只能装在 Linux 服务器上。');
      const identity = await execStream(client, 'id -u', { timeoutMs: 15000 });
      const isRoot = identity.output.trim().split(/\s+/).pop() === '0';
      let sudoPrefix = '';
      if (!isRoot) {
        const check = await execStream(client, "sudo -S -p '' -v", { stdin: `${password}\n`, timeoutMs: 15000 });
        if (check.code !== 0) throw remoteError('REMOTE_NO_SUDO', '这个 SSH 账号不能 sudo；请换一个管理员账号。');
        sudoPrefix = "sudo -S -p '' ";
      }
      phase(job, '上传并开始安装');
      await uploadFile(client, RELAY_SCRIPT, '/tmp/desk-derp.sh');
      // Building takes minutes: it goes on by itself after this connection ends.
      const inner = `/bin/bash /tmp/desk-derp.sh ${shellQuote(publicIp)} ${RELAY_PORT} > /var/log/lamplit-derp-setup.log 2>&1`;
      const started = await execStream(
        client,
        `${sudoPrefix}sh -c ${shellQuote(`if command -v systemd-run >/dev/null 2>&1; then systemd-run --unit=lamplit-derp-setup --collect --quiet /bin/bash -c ${shellQuote(inner)}; else nohup /bin/bash -c ${shellQuote(inner)} >/dev/null 2>&1 & fi`)}`,
        { stdin: isRoot ? '' : `${password}\n`, timeoutMs: 30000 },
      );
      if (started.code !== 0) throw remoteError('REMOTE_RELAY_FAILED', `没能开始安装中转（${cleanLine(started.output).slice(0, 160) || `exit ${started.code}`}）`);
      phase(job, null);
      job.state = 'done';
      job.message = `国内中转正在 ${publicIp} 上后台安装（约 5–10 分钟）。装好后这里会显示下一步：放行端口，把配置填进 Tailscale 后台。`;
      job.finishedAt = nowIso();
    } catch (err) {
      job.state = 'error';
      job.message = /^REMOTE_/.test(String(err?.code || '')) ? (err.message || '没能开始安装中转') : friendlySshError(err);
      job.finishedAt = nowIso();
    } finally {
      try { client?.end(); } catch { /* closed */ }
    }
  }

  /**
   * Lamplit's own relay: over SSH, as root or with sudo, install
   * hub/relay/relay.mjs as a service (a minute at most, so in the foreground)
   * and take back its certificate fingerprint and join secret. Those go
   * straight into this computer's relay settings (onRelayTunnel, which turns
   * 「通过中转连接」 on); the job the UI reads carries the address and
   * fingerprint only.
   *
   * 第 2 步: installing again keeps the join secret and the computers already
   * registered (the relay's data folder stays), and is also how the port
   * changes. A Lamplit already running on that server joins the relay itself
   * (dialing 127.0.0.1). Then this computer tries the port from outside, so a
   * cloud firewall that still drops it is said right away, with where to open it.
   * mode 'uninstall': the service, program and data go; this computer forgets it.
   */
  async function runRelayTunnel(job, { host, sshPort, username, password, publicIp, port, mode = 'install' }) {
    let client = null;
    try {
      phase(job, '连接 SSH');
      setProgress(job, '正在连接 SSH…');
      client = await connectSsh({ host, port: sshPort, username, password });
      job.os = await detectOs(client);
      if (job.os !== 'linux') throw remoteError('REMOTE_UNSUPPORTED_OS', '中转只能装在 Linux 服务器上。');
      const identity = await execStream(client, 'id -u', { timeoutMs: 15000 });
      const isRoot = identity.output.trim().split(/\s+/).pop() === '0';
      let sudoPrefix = '';
      if (!isRoot) {
        const check = await execStream(client, "sudo -S -p '' -v", { stdin: `${password}\n`, timeoutMs: 15000 });
        if (check.code !== 0) throw remoteError('REMOTE_NO_SUDO', '这个 SSH 账号不能 sudo；请换一个管理员账号。');
        sudoPrefix = "sudo -S -p '' ";
      }
      const sudo = { sudoPrefix, password, isRoot };

      if (mode === 'uninstall') {
        phase(job, '卸载');
        setProgress(job, '这台服务器上的 Lamplit 先断开中转…');
        await joinHubOverSsh(client, sudo, { enabled: false }).catch(() => 'error');
        setProgress(job, '停掉并删除中转服务…');
        await uploadFile(client, TUNNEL_SCRIPT, '/tmp/lamplit-relay-setup.sh');
        const ran = await execStream(client, `${sudoPrefix}/bin/bash /tmp/lamplit-relay-setup.sh --uninstall`, { stdin: isRoot ? '' : `${password}\n`, timeoutMs: 120000 });
        await execStream(client, 'rm -f /tmp/lamplit-relay-setup.sh', { timeoutMs: 15000 }).catch(() => {});
        const field = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(ran.output)?.[1] || '').trim();
        if (field('DESK_RELAY') !== 'removed') throw remoteError('REMOTE_RELAY_FAILED', field('DESK_RELAY_ERROR') || `没能卸载中转（exit ${ran.code}）`);
        await onRelayRemoved({ host: publicIp });
        phase(job, null);
        const oldPort = Number(field('DESK_RELAY_PORT')) || port;
        job.state = 'done';
        job.message = `中转已经卸载，这台电脑也不再连它。云服务器控制台里为 TCP ${oldPort} 加的放行规则可以删掉了。`;
        job.finishedAt = nowIso();
        return;
      }

      phase(job, '上传并安装');
      setProgress(job, '上传中转程序…');
      await uploadFile(client, TUNNEL_PROGRAM, '/tmp/lamplit-relay.mjs');
      await uploadFile(client, TUNNEL_SCRIPT, '/tmp/lamplit-relay-setup.sh');
      setProgress(job, '安装并启动中转服务…');
      const ran = await execStream(client, `${sudoPrefix}/bin/bash /tmp/lamplit-relay-setup.sh /tmp/lamplit-relay.mjs ${Number(port)}`, { stdin: isRoot ? '' : `${password}\n`, timeoutMs: 180000 });
      await execStream(client, 'rm -f /tmp/lamplit-relay.mjs /tmp/lamplit-relay-setup.sh', { timeoutMs: 15000 }).catch(() => {});
      const out = ran.output;
      const field = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1] || '').trim();
      if (field('DESK_RELAY') !== 'ready') throw remoteError('REMOTE_RELAY_FAILED', field('DESK_RELAY_ERROR') || `没能装好中转（exit ${ran.code}）`);
      const fingerprint = field('DESK_RELAY_FP');
      const join = field('DESK_RELAY_JOIN');
      if (!/^[0-9a-f]{64}$/.test(fingerprint) || join.length < 16) throw remoteError('REMOTE_RELAY_FAILED', '中转装好了，但没有拿到它的证书指纹');
      const oldPort = Number(field('DESK_RELAY_OLD_PORT')) || 0;
      phase(job, '记下中转');
      await onRelayTunnel({ host: publicIp, port: Number(port), fingerprint, join });

      // The Lamplit on this same server (added as a machine earlier) joins too.
      if (field('DESK_RELAY_HUB') === 'yes') {
        setProgress(job, '这台服务器上的 Lamplit 也连上中转…');
        const joined = await joinHubOverSsh(client, sudo, { host: publicIp, port: Number(port), relayFingerprint: fingerprint, join, dial: '127.0.0.1', enabled: true })
          .catch((err) => `error:${err.message}`);
        job.hubJoined = joined;
      }

      phase(job, '检查端口');
      setProgress(job, '从这台电脑试连中转的端口…');
      let check = await checkRelayImpl({ host: publicIp, port: Number(port), relayFingerprint: fingerprint });
      // A service that just started: one more try before calling the port closed.
      if (!check.ok && check.code === 'RELAY_UNREACHABLE') {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        check = await checkRelayImpl({ host: publicIp, port: Number(port), relayFingerprint: fingerprint });
      }
      phase(job, null);
      job.relayTunnel = { host: publicIp, port: Number(port), fingerprint, portOpen: Boolean(check.ok), ...(check.ok ? { ms: check.ms } : {}) };
      const moved = oldPort && oldPort !== Number(port)
        ? ` 端口从 ${oldPort} 换成了 ${Number(port)}：手机要在家里（同一个 Wi-Fi）打开一次 Lamplit App，或者重新扫一次码，才会记下新端口。`
        : '';
      const hubNote = job.hubJoined === 'ok' ? ' 这台服务器上的 Lamplit 也连上了中转。'
        : /^error:/.test(job.hubJoined || '') ? ` 这台服务器上的 Lamplit 没能连上中转（${job.hubJoined.slice(6)}）。` : '';
      if (check.ok) {
        job.state = 'done';
        job.message = `中转装好了（${publicIp}，TCP ${Number(port)}），这台电脑已经连上它，「通过中转连接」已打开。在 设置 → 手机和外网 里点「显示二维码」，手机 App 扫一次，出门用流量也能连回来。${moved}${hubNote}`;
      } else if (check.code === 'RELAY_CERT_MISMATCH') {
        job.state = 'warning';
        job.message = `中转装好了，但 ${publicIp}:${Number(port)} 上回答的不是它（证书对不上），可能端口被转到了别的程序。换一个端口再装一次。${hubNote}`;
      } else {
        job.state = 'warning';
        job.message = `中转装好了，「通过中转连接」也已打开，但从这台电脑连不上 ${publicIp} 的 TCP ${Number(port)}：云服务器的防火墙还没放行。${relayPortAdvice(port)}放行后点「再测一次」。${moved}${hubNote}`;
      }
      job.finishedAt = nowIso();
    } catch (err) {
      job.state = 'error';
      job.message = /^REMOTE_/.test(String(err?.code || '')) ? (err.message || '没能装好中转') : friendlySshError(err);
      job.finishedAt = nowIso();
    } finally {
      try { client?.end(); } catch { /* closed */ }
    }
  }

  async function run(job, { host, sshPort, username, password, hubPort, tailscaleKey = '', tailscaleName = '', desktop = '' }) {
    let client = null;
    try {
      phase(job, '连接 SSH');
      setProgress(job, '正在连接 SSH…');
      client = await connectSsh({ host, port: sshPort, username, password });
      if (client.hostCheck?.fingerprint) {
        job.hostFingerprint = client.hostCheck.fingerprint;
        if (client.hostCheck.first) setProgress(job, `第一次连这台机器，记下了它的 SSH 指纹 ${client.hostCheck.fingerprint}；以后指纹变了会停下来问你`);
      }

      setProgress(job, '识别系统…');
      job.os = await detectOs(client);
      if (job.os !== 'linux' && job.os !== 'windows') {
        throw remoteError('REMOTE_UNSUPPORTED_OS', '认不出这台机器的系统（不是 Linux 也不是 Windows），暂时没法自动配置。');
      }
      const windows = job.os === 'windows';

      let sudoPrefix = '';
      let isRoot = false;
      if (!windows) {
        setProgress(job, '检查 sudo 权限…');
        const identity = await execStream(client, 'id -u', { timeoutMs: 15000 });
        isRoot = identity.output.trim().split(/\s+/).pop() === '0';
        if (!isRoot) {
          const check = await execStream(client, "sudo -S -p '' -v", { stdin: `${password}\n`, timeoutMs: 15000 });
          if (check.code !== 0) {
            throw remoteError('REMOTE_NO_SUDO', '这个 SSH 账号不能 sudo；请换一个管理员账号，或先给该账号 sudo 权限。');
          }
          sudoPrefix = "sudo -S -p '' ";
        }
      }

      phase(job, '打包并上传');
      setProgress(job, '打包 Lamplit 程序…');
      const packed = await packApp();
      try {
        setProgress(job, `上传程序（${Math.max(1, Math.round(packed.bytes / 1024 / 1024))} MB）…`);
        let result;
        if (windows) {
          result = await installWindows(client, job, packed, hubPort, { tailscaleKey, tailscaleName });
        } else {
          const remotePkg = '/tmp/desk-hub.tar.gz';
          const remoteScript = '/tmp/desk-setup.sh';
          await uploadFile(client, packed.file, remotePkg);
          await uploadFile(client, SETUP_SCRIPTS.linux, remoteScript);
          let nodeArg = '';
          const machine = await execStream(client, 'uname -m', { timeoutMs: 15000 }).catch(() => ({ output: '' }));
          const arch = /aarch64|arm64/.test(machine.output) ? 'arm64' : /x86_64|amd64/.test(machine.output) ? 'x64' : '';
          const nodeTar = arch ? await nodePackage('linux', arch).catch(() => null) : null;
          if (nodeTar) {
            setProgress(job, `上传 Node.js（${Math.max(1, Math.round(nodeTar.bytes / 1024 / 1024))} MB，目标机器不用再下载）…`);
            await uploadFile(client, nodeTar.file, '/tmp/desk-node.tar.gz');
            nodeArg = ' --node /tmp/desk-node.tar.gz';
          }

          // Optional Tailscale key: written over the SSH channel into a file only
          // this account can read (never a local file, never a command line).
          let tsArg = tailscaleName ? ` --tailscale-name ${shellQuote(tailscaleName)}` : '';
          if (tailscaleKey) {
            setProgress(job, '把 Tailscale 密钥交给那台机器…');
            const put = await execStream(client, 'umask 077; cat > /tmp/desk-tailscale.key && test -s /tmp/desk-tailscale.key', { stdin: `${tailscaleKey}\n`, endInput: true, timeoutMs: 15000 })
              .catch((err) => ({ code: 1, output: err.message }));
            if (put.code === 0) tsArg += ' --tailscale-key-file /tmp/desk-tailscale.key';
            // Never skip it silently: the human asked for it.
            else job.tailscale = `Tailscale 没装：密钥没能交给那台机器（${cleanLine(String(put.output || '')).slice(0, 120) || `exit ${put.code}`}）`;
          }

          setProgress(job, '安装并启动（首次 3-10 分钟）…');
          result = await execStream(
            client,
            `${sudoPrefix}bash ${remoteScript} --port ${shellQuote(String(hubPort))} --pkg ${remotePkg}${nodeArg}${tsArg}${desktop === 'full' || desktop === 'light' ? ` --desktop ${desktop}` : ''}`,
            {
              stdin: isRoot ? '' : `${password}\n`,
              onLine: (line) => {
                const text = line.trim();
                if (text && !/^DESK_/.test(text)) setProgress(job, cleanLine(text).slice(0, 300));
              },
            },
          );
        }
        const value = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(result.output)?.[1]?.trim() || '';
        // The address the script sees may be NAT-internal (a cloud VM); the one
        // we just reached over SSH is the one this client can use.
        job.hubUrl = `http://${host}:${hubPort}`;
        job.pairCode = /^\d{6,10}$/.test(value('DESK_PAIR_CODE')) ? value('DESK_PAIR_CODE') : '';
        if (value('DESK_OS')) job.os = value('DESK_OS');
        // The script checks its own work; trust its verdict over "exit 0".
        if (result.code !== 0 || value('DESK_HUB_OK') !== '1' || !job.pairCode) {
          const said = result.output.trim().split(/\r?\n/).filter((line) => line.trim() && !/^DESK_/.test(line));
          // The reason first (which check failed), then what the script said last.
          const why = value('DESK_HUB_OK') !== '1' ? 'Lamplit 服务没能启动起来或没有应答'
            : !job.pairCode ? '服务起来了，但没读到配对码'
              : `安装脚本出错（退出码 ${result.code}）`;
          const reason = said.filter((line) => /^\[desk\]/.test(line)).slice(-2).map(cleanLine);
          const tail = (reason.length ? reason : said.slice(-3).map(cleanLine)).join(' / ');
          throw remoteError('REMOTE_HUB_FAILED', `安装失败：${why}${tail ? `。${tail}` : ''}。再点一次「连接并自动配置」会接着装（已装好的部分不会重做）。`);
        }
        // "na": Windows has no per-bot desktops yet; its bots browse headless.
        // "pending": the desktop and browser are installing in the background
        // after the Hub came up (the slow part); not a failure.
        // Windows installs Tailscale in the foreground and says how it went.
        const tsDone = /^DESK_TS=(done|failed)\s*(\S*)/m.exec(result.output || '');
        if (tailscaleKey && !job.tailscale && tsDone) {
          job.tailscale = tsDone[1] === 'done'
            ? `Tailscale 装好了${tsDone[2] ? `：${tsDone[2]}` : ''}，在外面也能连上这台机器`
            : `Tailscale 没装好（${tsDone[2] === 'key' ? '密钥不对或已用过' : tsDone[2] === 'download' ? '下载不了 Tailscale' : tsDone[2] === 'launch' ? '安装程序没能启动' : tsDone[2] || '原因不明'}）：到这台机器的 设置 → 手机和外网 里点「装上 Tailscale」再试`;
        }
        if (tailscaleKey && !job.tailscale) {
          job.tailscale = /Tailscale 在后台安装/.test(result.output)
            ? 'Tailscale 正在后台安装并加入你的网络，几分钟后这台机器会出现 100 开头的地址'
            : 'Tailscale 没装：安装脚本没有收到密钥';
        }
        if (value('DESK_DESKTOP_OK') === 'pending') job.desktopPending = true;
        else if (!['1', 'na'].includes(value('DESK_DESKTOP_OK'))) {
          job.warning = '装好了，但桌面相关的程序没装全，Bot 的屏幕会是黑的';
        }
      } finally {
        cleanupPack(packed.file);
      }

      // A cloud server is usually reachable only through Tailscale (its port
      // 4390 rightly closed to the internet), 1.5.1: ask it over SSH for its
      // 100.x address while Tailscale comes up, and keep it with the machine.
      if (tailscaleKey && !/没装/.test(job.tailscale || '')) {
        setProgress(job, '等 Tailscale 给这台机器分配地址（100 开头）…');
        const cmd = windows ? `powershell -NoProfile -Command "& 'C:\\Program Files\\Tailscale\\tailscale.exe' ip -4"` : 'tailscale ip -4 2>/dev/null';
        for (let attempt = 0; attempt < 30 && !job.tailnetUrl; attempt += 1) {
          const out = await execStream(client, cmd, { timeoutMs: 10000 }).catch(() => ({ output: '' }));
          const ip = parseTailnetIp(out.output);
          if (ip) job.tailnetUrl = `http://${ip}:${hubPort}`;
          else await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        if (job.tailnetUrl) job.tailscale = `Tailscale 装好了：${job.tailnetUrl.replace(/^http:\/\//, '').replace(/:\d+$/, '')}，在外面也能连上这台机器`;
      }

      setProgress(job, '确认这台电脑能连上它…');
      job.reachUrl = '';
      for (let attempt = 0; attempt < 10 && !job.reachUrl; attempt += 1) {
        job.reachUrl = await firstAnswering([job.hubUrl, job.tailnetUrl || '']);
        if (!job.reachUrl) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const reachable = Boolean(job.reachUrl);
      const model = reachable ? modelToShare() : null;
      if (model) {
        setProgress(job, '把模型设置同步过去…');
        try {
          await shareModel(job.reachUrl, job.pairCode, model, voiceToShare(), visionToShare());
          job.modelShared = true;
        } catch (err) {
          job.warning = job.warning || `装好了，但模型设置没同步过去（${err.message}）；切过去后在「设置 → 模型」里填一下。`;
        }
      }
      // 第 2 步: this computer uses Lamplit's relay, so the new machine does too
      // (its own id, key and certificate; the relay's address and join secret
      // from here). Linux: over this SSH session, never in the clear. Windows:
      // over HTTP like the model, when it answers. The relay server itself,
      // added as a machine, reaches its relay on 127.0.0.1.
      const relay = relayToShare();
      if (relay) {
        setProgress(job, '让这台机器也连上中转…');
        const settings = { ...relay, enabled: true, ...(relay.host === host ? { dial: '127.0.0.1' } : {}) };
        let joined = '';
        if (!windows) {
          joined = await joinHubOverSsh(client, { sudoPrefix, password, isRoot }, settings).catch((err) => `error:${err.message}`);
        } else if (reachable) {
          joined = await shareRelay(job.reachUrl, job.pairCode, settings).then(() => 'ok', (err) => `error:${err.message}`);
        }
        job.relayJoined = joined === 'ok';
        if (/^error:/.test(joined)) job.log.push(`relay: ${joined}`);
      }
      if (!reachable) {
        job.state = 'warning';
        job.message = tailscaleKey
          ? `装好了，但从这台电脑连不上 ${host}:${hubPort}，也还没等到它的 Tailscale 地址；几分钟后在机器列表里点它试试，或检查这台电脑的 Tailscale 是否在线。`
          : `装好了，但从这台电脑连不上 ${host}:${hubPort}；检查两台机器之间的防火墙或安全组（云服务器建议填 Tailscale 密钥，不用对外开放端口）。`;
      } else if (job.warning) {
        job.state = 'warning';
        job.message = job.warning;
      } else {
        job.state = 'done';
        job.message = job.desktopPending ? '已就绪；机器人的桌面和浏览器在后台继续安装（约 3–8 分钟）。' : '已就绪。';
      }
      // The Tailscale outcome is always said, and a failure makes it a warning.
      if (job.tailscale) {
        job.message = `${job.message} ${job.tailscale}。`;
        if (/没装/.test(job.tailscale) && job.state === 'done') job.state = 'warning';
        job.log.push(job.tailscale);
      }
      phase(job, null);
      job.finishedAt = nowIso();
    } catch (err) {
      job.state = 'error';
      job.message = /^REMOTE_/.test(String(err?.code || '')) ? (err.message || '远程配置失败') : friendlySshError(err);
      job.finishedAt = nowIso();
      job.log.push(`error: ${job.message}`);
    } finally {
      try { client?.end(); } catch { /* already gone */ }
    }
  }

  return {
    /**
     * Make a Linux machine the Tailscale relay in China (1.5.29): over SSH, run
     * hub/derp-linux.sh with sudo in the background (building takes minutes);
     * the machine's hub reports how it went (GET /api/relay).
     */
    startRelay(input = {}) {
      const host = assertHost(input.host);
      const sshPort = assertPort(input.sshPort, 22, 'sshPort');
      const username = assertCredential(input.username, 'SSH username');
      const password = assertCredential(input.password, 'SSH password');
      const publicIp = String(input.publicIp || host).trim();
      if (!isPublicIpv4(publicIp)) throw remoteError('REMOTE_RELAY_NEEDS_PUBLIC_IP', `中转要用这台服务器的公网 IP（${publicIp || '没填'} 不是）：在云服务器控制台里能看到`);
      const job = { id: uid('prov'), kind: 'relay', state: 'running', message: '排队中…', step: 0, totalSteps: 3, address: host, os: '', hubPort: 0, hubUrl: '', pairCode: '', startedAt: nowIso(), finishedAt: null, log: [] };
      jobs.set(job.id, job);
      runRelay(job, { host, sshPort, username, password, publicIp });
      return publicJob(job);
    },

    /** Lamplit's own relay on a Linux server: see runRelayTunnel. input.mode: 'install' (default) | 'uninstall'. */
    startRelayTunnel(input = {}) {
      const mode = input.mode === 'uninstall' ? 'uninstall' : 'install';
      const host = assertHost(input.host);
      const sshPort = assertPort(input.sshPort, 22, 'sshPort');
      const port = assertPort(input.port, TUNNEL_PORT, 'port');
      if (port < 1024) throw remoteError('REMOTE_BAD_PORT', '中转端口要在 1024–65535 之间');
      const username = assertCredential(input.username, 'SSH username');
      const password = assertCredential(input.password, 'SSH password');
      const publicIp = String(input.publicIp || host).trim();
      if (!isPublicIpv4(publicIp)) throw remoteError('REMOTE_RELAY_NEEDS_PUBLIC_IP', `中转要用这台服务器的公网 IP（${publicIp || '没填'} 不是）：在云服务器控制台里能看到`);
      const job = { id: uid('prov'), kind: 'relay-tunnel', mode, state: 'running', message: '排队中…', step: 0, totalSteps: mode === 'uninstall' ? 2 : 4, address: host, os: '', hubPort: 0, hubUrl: '', pairCode: '', startedAt: nowIso(), finishedAt: null, log: [] };
      jobs.set(job.id, job);
      runRelayTunnel(job, { host, sshPort, username, password, publicIp, port, mode });
      return publicJob(job);
    },

    start(input = {}) {
      const host = assertHost(input.host);
      const sshPort = assertPort(input.sshPort, 22, 'sshPort');
      const hubPort = assertPort(input.hubPort, 4390, 'hubPort');
      const username = assertCredential(input.username, 'SSH username');
      const password = assertCredential(input.password, 'SSH password');
      // Optional, Linux only: a Tailscale auth key (tskey-auth-…) to join the human's tailnet.
      const tailscaleKey = String(input.tailscaleKey || '').trim();
      // Only an auth key adds a device; an API access token (tskey-api-) looks alike but is refused by Tailscale.
      if (tailscaleKey && /^tskey-api-/.test(tailscaleKey)) {
        throw remoteError('REMOTE_BAD_TAILSCALE_KEY', '这是 Tailscale 的 API 访问令牌（tskey-api-），不能用来加设备：在 Tailscale 后台 Settings → Keys 里点「Generate auth key」，用 tskey-auth- 开头的那种。');
      }
      if (tailscaleKey && !/^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(tailscaleKey)) {
        throw remoteError('REMOTE_BAD_TAILSCALE_KEY', 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key（在 Tailscale 后台 Settings → Keys 里点「Generate auth key」）。');
      }

      const job = {
        id: uid('prov'),
        state: 'running',
        message: '排队中…',
        step: 0,
        totalSteps: 7,
        address: host,
        os: '',
        hubPort,
        hubUrl: '',
        pairCode: '',
        startedAt: nowIso(),
        finishedAt: null,
        log: [],
      };
      jobs.set(job.id, job);
      // Drop old finished jobs so a long-running process does not grow forever.
      for (const [id, entry] of jobs) {
        if (entry.state !== 'running' && Date.now() - Date.parse(entry.startedAt) > 60 * 60 * 1000) {
          jobs.delete(id);
        }
      }
      run(job, { host, sshPort, username, password, hubPort, tailscaleKey, tailscaleName: tailscaleDeviceName(input.name || host), desktop: input.desktop === 'full' ? 'full' : input.desktop === 'light' ? 'light' : '' });
      return publicJob(job);
    },
    get(id) {
      const job = jobs.get(String(id || ''));
      return job ? publicJob(job) : null;
    },
    list() {
      return [...jobs.values()].map(publicJob);
    },
  };
}

/**
 * What goes into the Tailscale policy file (Access controls) for a relay
 * (1.5.29). The official regions stay: Tailscale uses whichever is nearest.
 * IPv6 'none': a cloud server in China seldom has one; without it Tailscale's
 * own check reports an IPv6 error.
 */
export function derpMapFor(relay) {
  if (!relay?.host || !/^sha256-raw:[0-9a-f]{64}$/.test(String(relay.certName || ''))) return '';
  const node = { Name: '900a', RegionID: 900, HostName: relay.host, IPv4: relay.host, IPv6: 'none', DERPPort: Number(relay.port) || RELAY_PORT, STUNPort: Number(relay.stunPort) || 3478, CertName: relay.certName };
  const region = { RegionID: 900, RegionCode: 'lamplit', RegionName: 'Lamplit relay (China)', Nodes: [node] };
  return `"derpMap": ${JSON.stringify({ Regions: { 900: region } }, null, 2)},`;
}

/** `tailscale netcheck` output -> the relay regions and their distance (1.5.29; desktop/guard.mjs has the same for the app). */
export function parseNetcheckText(text) {
  const regions = [];
  for (const m of String(text || '').matchAll(/^\s*-\s*([a-z0-9-]+):\s*([\d.]+)\s*ms\s*\(([^)]*)\)/gim)) {
    regions.push({ code: m[1], ms: Math.round(Number(m[2])), name: m[3] });
  }
  return regions;
}
