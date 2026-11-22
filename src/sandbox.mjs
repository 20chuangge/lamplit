// The bots' commands in a sandbox on Linux (1.5.3, report 7.2 #1).
//
// A shell step runs as `bwrap … -- /bin/sh -c <command>` (bubblewrap):
//
//   strict - the human's own Linux computer, or any machine not set to 放手:
//            the system read-only, /home and /root empty, Lamplit's folder
//            empty; the workspace (read-write) and the opened folders
//            (read-only or read-write, as set) come back. /tmp is the bot's
//            own (1.5.61), /run/user empty: no screen or login session of
//            the human's (or the hub's) is reachable from inside.
//   open   - a machine given to the bots and set to 放手: everything as it
//            was, except Lamplit's data (keys, pairing tokens, the vault),
//            which is an empty folder.
//
// Outside the sandbox: Windows (not yet), sudo (it needs real privileges and
// follows the machine's sudo setting), and a step the human - or the primary
// bot's full trust - let past the fence (it names a place the sandbox hides).
// The machine checks once that bwrap starts and really hides the data before
// using it; until then, or when it cannot, commands run as before and
// Settings → 审批 says why.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { P } from './store.mjs';
import { effectivePolicy, machineMode } from './approvals.mjs';
import { SUDO } from './boundary.mjs';
import { runnerStatus } from './winrunner.mjs';
import { desktopEnv } from './desktops.mjs';

const under = (p, dir) => p === dir || p.startsWith(`${dir.replace(/\/+$/, '')}/`);

/**
 * The bwrap arguments before `--`.
 *
 * 1.5.60 (the verifier's F5): --unshare-pid in both modes. Without it the /proc
 * mounted inside is the machine's own: every process of the same account (the
 * hub, its browser, the desktop app) is there, and /proc/<pid>/root of any of
 * them is the real file system - the data folder with it, under the tmpfs that
 * was meant to hide it. In its own pid namespace a command sees only its own
 * processes. The cost: a program a command leaves running in the background
 * ends when the command ends (bwrap is that namespace's first process).
 */
/**
 * 1.5.61 (the verifier's N5, F8): strict mode no longer binds the real /tmp. That one is
 * shared by everything of this account: the hub's own files, the human's ssh-agent
 * socket (/tmp/ssh-*), their screen (/tmp/.X11-unix), a running Chrome's single-instance
 * socket. `tmpDir` (the bot's own folder under data/sandbox-tmp, which the sandbox hides
 * otherwise) becomes /tmp, so files stay from one command to the next; without one, an
 * empty tmpfs. /run/user (the login session's D-Bus - systemd-run --user starts a program
 * outside any sandbox - keyring, Wayland) is an empty tmpfs. `screen` (botScreen): the
 * socket of the bot's own screen (its Xvfb display, or its cage's Wayland socket) is bound
 * back in, read-only - so a graphical program a command starts opens there; never the
 * human's display, an ssh-agent or a browser's single-instance socket.
 */
export function bwrapArgs({ mode = 'strict', root = P.root, dataDir = P.dataDir, workspaceDir, folders = [], tmpDir = '', screen = null, exists = fs.existsSync } = {}) {
  const ws = String(workspaceDir || '');
  if (mode === 'open') {
    const args = ['--unshare-pid', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
    if (dataDir && exists(dataDir)) args.push('--tmpfs', dataDir);
    return args.concat(['--chdir', ws, '--die-with-parent']);
  }
  const args = ['--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...(tmpDir ? ['--bind', tmpDir, '/tmp'] : ['--tmpfs', '/tmp']), '--tmpfs', '/home', '--tmpfs', '/root'];
  if (exists('/run/user')) args.push('--tmpfs', '/run/user');
  for (const sock of screen?.bind || []) args.push('--ro-bind', sock, sock);
  const homes = (p) => under(p, '/home') || under(p, '/root');
  if (root && !homes(root) && exists(root)) args.push('--tmpfs', root);
  if (dataDir && !homes(dataDir) && !(root && under(dataDir, root)) && exists(dataDir)) args.push('--tmpfs', dataDir);
  if (ws) args.push('--bind', ws, ws);
  for (const f of folders || []) {
    const p = String(f?.path || '');
    if (!p.startsWith('/') || !exists(p) || under(p, ws)) continue;
    args.push(f.write ? '--bind' : '--ro-bind', p, p);
  }
  return args.concat(['--chdir', ws, '--die-with-parent']);
}

/** Does this command run in the sandbox? */
export function runsInside({ platform = process.platform, command = '', unfenced = false } = {}) {
  if (platform !== 'linux') return false;
  if (unfenced) return false;
  return !SUDO.test(String(command));
}

export function sandboxMode({ remote = false, autonomous = false } = {}) {
  return remote && autonomous ? 'open' : 'strict';
}

// Ubuntu 23.10+ lets no ordinary program make a user namespace (AppArmor),
// and bwrap needs one. Ubuntu's own way for a sandboxing program: a profile
// that allows that to /usr/bin/bwrap only (1.5.3, the human agreed 11-16).
export const APPARMOR_FILE = '/etc/apparmor.d/bwrap';
export const APPARMOR_PROFILE = [
  'abi <abi/4.0>,',
  'include <tunables/global>',
  '',
  'profile bwrap /usr/bin/bwrap flags=(unconfined) {',
  '  userns,',
  '',
  '  include if exists <local/bwrap>',
  '}',
];
/** The shell line that writes and loads it (run as root). */
export function apparmorInstallCommand() {
  return `printf '%s\\n' ${APPARMOR_PROFILE.map((l) => `'${l}'`).join(' ')} > ${APPARMOR_FILE} && apparmor_parser -r ${APPARMOR_FILE}`;
}

// The check: $1 must not be visible (one of Lamplit's own files), not even through the hub's own
// /proc entry ($3: its pid; 1.5.60, F5), and $2 (the workspace) writable.
export const PROBE_SCRIPT = '[ ! -e "$1" ] && [ ! -e "/proc/$3/root$1" ] && [ -w "$2" ] && echo sandbox-ok';

let status = { state: process.platform === 'linux' ? 'unknown' : 'na', reason: '' };

function run(file, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { resolve({ code: -1, out: err.message }); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message, missing: err.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * Once at start (Linux): is bwrap there (if not, install it where sudo needs
 * no password), and does it hide Lamplit's data while the workspace stays
 * writable? -> the status Settings shows.
 */
export async function checkSandbox({ workspaceDir = P.workspaceDir, secret = P.securityFile, runImpl = run } = {}) {
  if (process.platform !== 'linux') { status = { state: 'na', reason: '' }; return status; }
  let found = await runImpl('bwrap', ['--version']);
  if (found.missing || found.code !== 0) {
    // A machine Lamplit set up may install it itself; nothing waits for a password.
    await runImpl('sh', ['-c', 'command -v apt-get >/dev/null && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap || sudo -n dnf install -y -q bubblewrap || sudo -n yum install -y -q bubblewrap'], { timeoutMs: 180000 });
    found = await runImpl('bwrap', ['--version']);
    if (found.missing || found.code !== 0) {
      status = { state: 'off', reason: 'bubblewrap 没装（在这台机器上运行 sudo apt install bubblewrap，或 sudo dnf install bubblewrap，然后重启 Lamplit）' };
      return status;
    }
  }
  const args = bwrapArgs({ mode: 'strict', workspaceDir, folders: [] });
  const tryIt = () => runImpl('bwrap', [...args, '--', '/bin/sh', '-c', PROBE_SCRIPT, 'probe', secret, workspaceDir, String(process.pid)]);
  let probe = await tryIt();
  const blocked = (p) => /namespace|Operation not permitted|setting up uid map|Permission denied/i.test(String(p.out || ''));
  if (!(probe.code === 0 && /sandbox-ok/.test(probe.out)) && blocked(probe)) {
    // Ubuntu's AppArmor rule: allow it for bwrap only, where sudo needs no password.
    await runImpl('sudo', ['-n', 'sh', '-c', `[ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null && ${apparmorInstallCommand()}`], { timeoutMs: 30000 });
    probe = await tryIt();
  }
  if (probe.code === 0 && /sandbox-ok/.test(probe.out)) {
    status = { state: 'on', reason: '' };
  } else {
    const said = String(probe.out || '').trim().split('\n').pop().slice(0, 200);
    status = { state: 'off', reason: blocked(probe)
      ? `系统不允许普通用户建沙箱（${said}）。Ubuntu 上用 sudo 把只给 bwrap 的 AppArmor 规则写进 ${APPARMOR_FILE} 并加载（apparmor_parser -r ${APPARMOR_FILE}），然后重启 Lamplit`
      : `沙箱没能按预期工作（${said || `退出码 ${probe.code}`}）` };
  }
  return status;
}

/** For GET /api/policy: {state:'on'|'off'|'na'|'unknown', reason, mode}. */
export function sandboxStatus(policy = null) {
  // Windows (1.5.7): a separate low-privilege account instead of bwrap.
  if (process.platform === 'win32') return { ...runnerStatus(), mode: 'windows' };
  const eff = effectivePolicy(policy || {});
  return { ...status, mode: sandboxMode({ remote: machineMode() === 'remote', autonomous: eff.autonomous }) };
}

/** The sandbox for one shell step, or null (runs as before). */
export function sandboxFor(command, ctx = {}) {
  if (status.state !== 'on') return null;
  if (!runsInside({ command, unfenced: Boolean(ctx.shellUnfenced) })) return null;
  const policy = ctx.config?.policy || {};
  const eff = effectivePolicy(policy);
  const mode = sandboxMode({ remote: machineMode() === 'remote', autonomous: eff.autonomous });
  const workspaceDir = path.resolve(String(ctx.workspaceDir || P.workspaceDir));
  const botId = ctx.botId || ctx.bot?.id;
  const tmpDir = mode === 'strict' ? botTmp(botId) : '';
  // Strict: the bot's own screen, or none (then DISPLAY and WAYLAND_DISPLAY are taken away).
  const screen = mode === 'strict' ? botScreen(botId) : null;
  return { mode, args: bwrapArgs({ mode, workspaceDir, folders: policy.folders || [], tmpDir, screen }), env: mode === 'strict' ? (screen?.env || null) : null, screen: Boolean(screen) };
}

/**
 * The bot's own screen (1.5.61): {env, bind} with the socket to bind into its sandbox, or
 * null when this machine runs no screen for it (desktops.mjs: Xvfb :120+, or cage).
 */
export function botScreen(botId, { envOf = desktopEnv, exists = fs.existsSync } = {}) {
  let e = {};
  try { e = (botId && envOf(botId)) || {}; } catch { e = {}; }
  if (e.WAYLAND_DISPLAY && e.XDG_RUNTIME_DIR) {
    const sock = path.join(e.XDG_RUNTIME_DIR, e.WAYLAND_DISPLAY);
    if (exists(sock)) return { env: { WAYLAND_DISPLAY: e.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR }, bind: [sock] };
  }
  const m = /^:(\d+)$/.exec(String(e.DISPLAY || ''));
  if (m) {
    const sock = `/tmp/.X11-unix/X${m[1]}`;
    if (exists(sock)) return { env: { DISPLAY: e.DISPLAY }, bind: [sock] };
  }
  return null;
}

/** The environment of a command in that sandbox: the bot's own screen, or no display at all (strict). */
export function sandboxEnv(base, sandbox) {
  const env = { ...base };
  if (sandbox?.mode !== 'strict') return env;
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.XAUTHORITY;
  return { ...env, ...(sandbox.env || {}) };
}

/** A bot's own /tmp in strict mode: data/sandbox-tmp/<bot> (mode 700), hidden from every other sandbox. */
export function botTmp(botId = '', dataDir = P.dataDir) {
  const dir = path.join(dataDir, 'sandbox-tmp', String(botId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'shared');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * At start, before any command runs: what the bots left in their /tmp more than `maxAgeMs`
 * ago goes. fsp.rm takes a link away and never follows it (and no command of a bot is
 * running yet to swap anything).
 */
export async function clearOldBotTmp(maxAgeMs = 7 * 24 * 3600 * 1000, dataDir = P.dataDir) {
  const root = path.join(dataDir, 'sandbox-tmp');
  for (const bot of await fs.promises.readdir(root).catch(() => [])) {
    const dir = path.join(root, bot);
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      const st = await fs.promises.lstat(path.join(dir, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) await fs.promises.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
