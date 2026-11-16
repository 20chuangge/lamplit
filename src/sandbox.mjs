// The bots' commands in a sandbox on Linux (1.5.3, report 7.2 #1).
//
// A shell step runs as `bwrap … -- /bin/sh -c <command>` (bubblewrap):
//
//   strict - the human's own Linux computer, or any machine not set to 放手:
//            the system read-only, /home and /root empty, Lamplit's folder
//            empty; the workspace (read-write) and the opened folders
//            (read-only or read-write, as set) come back. /tmp is shared.
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

const under = (p, dir) => p === dir || p.startsWith(`${dir.replace(/\/+$/, '')}/`);

/** The bwrap arguments before `--`. */
export function bwrapArgs({ mode = 'strict', root = P.root, dataDir = P.dataDir, workspaceDir, folders = [], exists = fs.existsSync } = {}) {
  const ws = String(workspaceDir || '');
  if (mode === 'open') {
    const args = ['--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
    if (dataDir && exists(dataDir)) args.push('--tmpfs', dataDir);
    return args.concat(['--chdir', ws, '--die-with-parent']);
  }
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', '/tmp', '/tmp', '--tmpfs', '/home', '--tmpfs', '/root'];
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

// The check: $1 must not be visible (one of Lamplit's own files), $2 (the workspace) writable.
export const PROBE_SCRIPT = '[ ! -e "$1" ] && [ -w "$2" ] && echo sandbox-ok';

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
  const tryIt = () => runImpl('bwrap', [...args, '--', '/bin/sh', '-c', PROBE_SCRIPT, 'probe', secret, workspaceDir]);
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
  return { mode, args: bwrapArgs({ mode, workspaceDir, folders: policy.folders || [] }) };
}
