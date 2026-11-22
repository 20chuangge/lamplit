// Tailscale, the way the relay card works (1.5.43): one click to install on
// this machine, one to log it in, one to remove it, and one to set it up on
// the other machines in the list. Logging in is the human's step: Tailscale
// prints a login link, the page opens it on the device in their hand, and
// Lamplit never sees their Tailscale password. An auth key the human pastes
// (to join without a login) is used once and never stored, logged or put in
// a URL or on a command line: it goes to a file only this account can read,
// and Tailscale reads it from there ("--auth-key=file:").
//
//   createTailscale({platform, remoteMode, run, spawn, simulate, hubDir})
//     .status()                 -> {installed, state, address, loginUrl, job, can}
//     .install({authKey})       -> job      (background; then logs in)
//     .login()                  -> {loginUrl}
//     .uninstall()              -> job
//
// state: 'missing' | 'needs-login' | 'starting' | 'running' | 'stopped'

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

import { hubTmp } from './store.mjs';

/** A Tailscale login link, and nothing else, is ever shown or opened. */
const LOGIN_URL_RE = /^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.%-]{1,300}$/;
export function safeLoginUrl(raw) {
  const u = String(raw || '').trim();
  return LOGIN_URL_RE.test(u) ? u : '';
}
/** The login link in what `tailscale up` printed. */
export function loginUrlIn(text) {
  const m = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.%-]{1,300}/.exec(String(text || ''));
  return m ? safeLoginUrl(m[0]) : '';
}

/** `tailscale status --json`, as the card needs it. */
export function parseStatus(json) {
  const backend = String(json?.BackendState || '');
  const state = backend === 'Running' ? 'running'
    : backend === 'NeedsLogin' || backend === 'NeedsMachineAuth' ? 'needs-login'
      : backend === 'Starting' ? 'starting' : 'stopped';
  const ips = Array.isArray(json?.Self?.TailscaleIPs) ? json.Self.TailscaleIPs : (Array.isArray(json?.TailscaleIPs) ? json.TailscaleIPs : []);
  const address = ips.find((ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(String(ip))) || '';
  return { installed: true, state, address: state === 'running' ? address : '', loginUrl: state === 'needs-login' ? safeLoginUrl(json?.AuthURL) : '' };
}

/** A one-time key: tskey-auth-…, never an API token. -> '' when good, else why not. */
export function authKeyProblem(key) {
  const k = String(key || '').trim();
  if (/^tskey-api-/.test(k)) return '这是 API 访问令牌（tskey-api-），不能用来加设备：在 Tailscale 后台 Settings → Keys 里点「Generate auth key」，用 tskey-auth- 开头的那种。';
  if (!/^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(k)) return 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key（在 Tailscale 后台 Settings → Keys 里点「Generate auth key」）。';
  return '';
}

/**
 * How Tailscale goes on (and comes off) this machine.
 *  - Windows: winget (it asks for administrator rights itself when it needs them);
 *    a machine given to the bots runs as an administrator already: the hub's script.
 *  - Linux: the official install script, with sudo that needs no password (a
 *    machine given to the bots has it); otherwise the human runs one line.
 *  - macOS and the rest: the app from tailscale.com - said plainly.
 */
export function installPlan({ platform, remoteMode, sudoOk }) {
  if (platform === 'win32') return remoteMode ? { kind: 'hub-script' } : { kind: 'winget', argv: ['winget', 'install', '--id', 'tailscale.tailscale', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'] };
  if (platform === 'linux') {
    if (remoteMode) return { kind: 'hub-script' };
    if (sudoOk) return { kind: 'sudo-script', argv: ['sudo', '-n', 'sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh && systemctl enable --now tailscaled'] };
    return { kind: 'terminal', command: 'curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up', words: '这台电脑装软件要你的管理员密码：打开终端，运行下面这行，按提示输入密码并登录。' };
  }
  return { kind: 'manual', words: '这台电脑请从 tailscale.com/download 下载 Tailscale 安装，打开后用你的账号登录。' };
}
export function uninstallPlan({ platform, remoteMode, sudoOk }) {
  if (platform === 'win32') {
    if (!remoteMode) return { kind: 'winget', argv: ['winget', 'uninstall', '--id', 'tailscale.tailscale', '-e', '--silent'] };
    return { kind: 'powershell', argv: ['powershell.exe', '-NoProfile', '-Command', "$p = Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'Tailscale' } | Select-Object -First 1; if ($p) { Start-Process msiexec.exe -ArgumentList '/x', $p.PSChildName, '/quiet', '/norestart' -Wait } else { exit 3 }"] };
  }
  if (platform === 'linux' && (remoteMode || sudoOk)) {
    return { kind: 'sudo-script', argv: ['sudo', '-n', 'sh', '-c', 'tailscale down 2>/dev/null; if command -v apt-get >/dev/null; then apt-get remove -y tailscale; elif command -v dnf >/dev/null; then dnf remove -y tailscale; else yum remove -y tailscale; fi'] };
  }
  if (platform === 'linux') return { kind: 'terminal', command: 'sudo tailscale down; sudo apt-get remove -y tailscale || sudo dnf remove -y tailscale', words: '这台电脑删软件要你的管理员密码：打开终端，运行下面这行。' };
  return { kind: 'manual', words: '这台电脑请在系统里像删别的软件一样删掉 Tailscale。' };
}

/** What removing it does, in words (said before the human confirms). */
export const UNINSTALL_WORDS = '会删掉这台机器上的 Tailscale 程序，这台就不在你的 Tailscale 网络里了。你的 Tailscale 账号和其他机器都不受影响；这台机器在 Tailscale 后台的记录要你自己在 login.tailscale.com 删。';

function defaultRun(cmd, args, { timeoutMs = 20000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = nodeSpawn(cmd, args, { windowsHide: true }); } catch (err) { resolve({ code: -1, stdout: '', stderr: err.message, missing: true }); return; }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
    child.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message, missing: err.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== null) { try { child.stdin.end(input); } catch { /* closed */ } }
  });
}

export function createTailscale({
  platform = process.platform,
  remoteMode = process.env.DESK_MACHINE_MODE === 'remote',
  run = defaultRun,
  spawn = nodeSpawn,
  simulate = /^(1|true|yes)$/i.test(String(process.env.DESK_TAILSCALE_SIMULATE || '')),
  hubDir = '',
  cli = () => 'tailscale',
  name = () => '',
  // 1.5.61 (F8): a pasted key waits in data/tmp, never in the system's /tmp (the bots' too on Linux).
  tmpDir = hubTmp('keys'),
} = {}) {
  let job = { kind: '', state: 'idle', detail: '' };
  let login = { url: '', at: 0, child: null };
  // The test switch (DESK_TAILSCALE_SIMULATE=1): nothing is installed; the card
  // walks through what a real machine would show. Never on by default.
  const sim = { installed: false, state: 'missing', address: '', loginAt: 0 };

  const setJob = (kind, state, detail = '') => { job = { kind, state, detail, at: Date.now() }; };

  async function sudoOk() {
    if (platform !== 'linux' || remoteMode) return remoteMode;
    const r = await run('sudo', ['-n', 'true'], { timeoutMs: 5000 });
    return r.code === 0;
  }

  async function status() {
    if (simulate) {
      if (sim.state === 'needs-login' && sim.loginAt && Date.now() - sim.loginAt > 8000) { sim.state = 'running'; sim.address = '100.64.0.9'; }
      return { installed: sim.installed, state: sim.state, address: sim.address, loginUrl: sim.state === 'needs-login' && sim.loginAt ? 'https://login.tailscale.com/a/simulated' : '', job, simulated: true };
    }
    const r = await run(cli(), ['status', '--json'], { timeoutMs: 8000 });
    if (r.missing) return { installed: false, state: 'missing', address: '', loginUrl: '', job };
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* not json */ }
    if (!parsed) {
      // Installed, but its service is not up (or an old CLI): the words of the CLI decide.
      const text = `${r.stdout}\n${r.stderr}`;
      return { installed: true, state: /Logged out|NeedsLogin|not logged in/i.test(text) ? 'needs-login' : 'stopped', address: '', loginUrl: login.url, job };
    }
    const s = parseStatus(parsed);
    return { ...s, loginUrl: s.loginUrl || (s.state === 'needs-login' ? login.url : ''), job };
  }

  /** Start `tailscale up`; the login link it prints is what the human opens. */
  async function startLogin({ keyFile = '' } = {}) {
    if (simulate) {
      if (keyFile) { sim.state = 'running'; sim.address = '100.64.0.9'; try { fs.unlinkSync(keyFile); } catch { /* gone */ } return { loginUrl: '' }; }
      sim.state = 'needs-login'; sim.loginAt = Date.now();
      return { loginUrl: 'https://login.tailscale.com/a/simulated' };
    }
    const host = String(name() || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    const args = ['up', ...(keyFile ? [`--auth-key=file:${keyFile}`] : []), ...(platform === 'win32' ? ['--unattended'] : []), ...(host ? [`--hostname=${host}`] : [])];
    const linuxRoot = platform === 'linux' && (await sudoOk());
    const operator = platform === 'linux' && !remoteMode ? [`--operator=${os.userInfo().username}`] : [];
    const [cmd, argv] = linuxRoot ? ['sudo', ['-n', cli(), ...args, ...operator]] : [cli(), args];
    try { login.child?.kill(); } catch { /* gone */ }
    login = { url: '', at: Date.now(), child: null };
    let child;
    try { child = spawn(cmd, argv, { windowsHide: true }); } catch (err) { return { error: err.message }; }
    login.child = child;
    const grab = (d) => { const u = loginUrlIn(String(d)); if (u) login.url = u; };
    child.stdout?.on('data', grab);
    child.stderr?.on('data', grab);
    child.on('error', () => {});
    child.on('close', () => { login.child = null; if (keyFile) { try { fs.unlinkSync(keyFile); } catch { /* gone */ } } });
    // Logging in may take the human a while; after 15 minutes the link is stale anyway.
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15 * 60 * 1000).unref?.();
    // The link comes within a few seconds; the page asks status() again after that.
    for (let i = 0; i < 40 && !login.url && login.child; i += 1) await new Promise((r) => setTimeout(r, 250));
    return { loginUrl: login.url };
  }

  /** A pasted key goes to a file only this account can read, never anywhere else. */
  function keyToFile(key) {
    const file = path.join(tmpDir, `desk-tailscale-${crypto.randomBytes(6).toString('hex')}.key`);
    fs.writeFileSync(file, `${String(key).trim()}\n`, { mode: 0o600 });
    // Gone in 20 minutes at the latest, whatever happens.
    setTimeout(() => { try { fs.unlinkSync(file); } catch { /* used */ } }, 20 * 60 * 1000).unref?.();
    return file;
  }

  async function install({ authKey = '' } = {}) {
    if (authKey && authKeyProblem(authKey)) throw Object.assign(new Error(authKeyProblem(authKey)), { code: 'TS_BAD_KEY' });
    if (job.state === 'running') throw Object.assign(new Error('已经在做了，稍等'), { code: 'TS_RUNNING' });
    if (simulate) {
      setJob('install', 'running', '正在安装 Tailscale…');
      setTimeout(async () => { sim.installed = true; sim.state = 'stopped'; setJob('install', 'done', '装好了'); await startLogin(authKey ? { keyFile: keyToFile(authKey) } : {}); }, 3000).unref?.();
      return job;
    }
    const plan = installPlan({ platform, remoteMode, sudoOk: await sudoOk() });
    if (plan.kind === 'terminal' || plan.kind === 'manual') throw Object.assign(new Error(plan.words), { code: 'TS_BY_HAND', command: plan.command || '' });
    setJob('install', 'running', platform === 'win32' && !remoteMode ? '正在安装 Tailscale：Windows 可能弹出「是否允许此应用更改你的设备」，点「是」。' : '正在安装 Tailscale，通常 1–3 分钟…');
    const keyFile = authKey ? keyToFile(authKey) : '';
    (async () => {
      let ok = false;
      if (plan.kind === 'hub-script') {
        const script = path.join(hubDir, platform === 'win32' ? 'tailscale-windows.ps1' : 'tailscale-linux.sh');
        // The hub's scripts install and, with a key, join; without one, only install.
        const r = platform === 'win32'
          ? await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-KeyFile', keyFile || '-'], { timeoutMs: 20 * 60 * 1000 })
          : await run('sudo', ['-n', '/bin/bash', script, keyFile || '-', String(name() || '')], { timeoutMs: 20 * 60 * 1000 });
        ok = r.code === 0;
        if (!ok) setJob('install', 'failed', /download/.test(`${r.stdout}${r.stderr}`) ? '下载不了 Tailscale（这台机器连不上 tailscale.com？）' : '没装好，再点一次试试；还不行就到那台机器上手动装');
      } else {
        const r = await run(plan.argv[0], plan.argv.slice(1), { timeoutMs: 20 * 60 * 1000 });
        ok = r.code === 0 || /already installed|已安装/i.test(`${r.stdout}${r.stderr}`);
        if (!ok) setJob('install', 'failed', r.missing ? (platform === 'win32' ? '这台电脑没有 winget：从 tailscale.com/download 下载安装' : '这台电脑缺少安装工具') : /cancel|denied|1223|拒绝/i.test(`${r.stdout}${r.stderr}`) ? '没给管理员权限，没装。再点一次，弹出提示时点「是」。' : '没装好，再点一次试试；还不行就从 tailscale.com/download 下载安装');
      }
      if (!ok) { if (keyFile) { try { fs.unlinkSync(keyFile); } catch { /* gone */ } } return; }
      setJob('install', 'done', '装好了');
      const now = await status();
      if (now.state !== 'running') await startLogin(keyFile ? { keyFile } : {});
      else if (keyFile) { try { fs.unlinkSync(keyFile); } catch { /* gone */ } }
    })().catch(() => setJob('install', 'failed', '没装好，再点一次试试'));
    return job;
  }

  async function uninstall() {
    if (job.state === 'running') throw Object.assign(new Error('已经在做了，稍等'), { code: 'TS_RUNNING' });
    if (simulate) {
      setJob('uninstall', 'running', '正在删掉 Tailscale…');
      setTimeout(() => { Object.assign(sim, { installed: false, state: 'missing', address: '', loginAt: 0 }); setJob('uninstall', 'done', '删掉了'); }, 2000).unref?.();
      return job;
    }
    const plan = uninstallPlan({ platform, remoteMode, sudoOk: await sudoOk() });
    if (plan.kind === 'terminal' || plan.kind === 'manual') throw Object.assign(new Error(plan.words), { code: 'TS_BY_HAND', command: plan.command || '' });
    setJob('uninstall', 'running', platform === 'win32' && !remoteMode ? '正在删掉 Tailscale：Windows 可能弹出提示，点「是」。' : '正在删掉 Tailscale…');
    try { login.child?.kill(); } catch { /* gone */ }
    (async () => {
      const r = await run(plan.argv[0], plan.argv.slice(1), { timeoutMs: 10 * 60 * 1000 });
      if (r.code === 0) setJob('uninstall', 'done', '删掉了');
      else setJob('uninstall', 'failed', /cancel|denied|1223|拒绝/i.test(`${r.stdout}${r.stderr}`) ? '没给管理员权限，没删。' : '没删掉，再点一次试试；还不行就在系统里像删别的软件一样删掉它');
    })().catch(() => setJob('uninstall', 'failed', '没删掉'));
    return job;
  }

  return {
    status,
    install,
    uninstall,
    login: () => (simulate ? startLogin() : startLogin()),
    can: async () => {
      const p = installPlan({ platform, remoteMode, sudoOk: await sudoOk() });
      return { install: !['terminal', 'manual'].includes(p.kind), byHand: p.command || '', words: p.words || '' };
    },
  };
}
