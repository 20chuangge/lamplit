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
/**
 * 1.5.63: `net` ({resolv: {file, at}}), strict only: the sandbox gets a network of its own
 * (--unshare-net), which a helper (pasta or slirp4netns, see spawnSandboxed) joins from outside
 * and connects to the internet. This machine's loopback ports and abstract unix sockets (the
 * human's X server listens on @/tmp/.X11-unix/X0) are then out of reach; the bot's own screen
 * is a socket file, bound in as before. /etc/resolv.conf (a loopback resolver such as
 * systemd-resolved's 127.0.0.53 is the sandbox's own loopback now) is replaced by one naming
 * the helper's DNS.
 *
 * And /dev is made by hand (NET_DEV_ARGS) instead of --dev. Linux CI, two rounds: with --dev
 * bwrap maps the uid to 0, mounts devpts, then makes a second, nested user namespace; its
 * first process sits in that inner one, which does not own the network namespace, so a helper
 * joining it is refused ("setns(CLONE_NEWNET): Operation not permitted"). An outer bwrap
 * holding the network instead does not work on Ubuntu either: what bwrap runs is confined
 * (AppArmor's bwrap-userns-restrict -> unpriv_bwrap) and may not make another user namespace.
 * Without devpts there is one user namespace, which owns the network. The cost: no
 * pseudo-terminals (/dev/pts) in such a sandbox - commands run without a terminal anyway.
 */
export function netDevArgs(exists = fs.existsSync) {
  const args = ['--tmpfs', '/dev'];
  // The nodes --dev binds from the machine's /dev (bwrap's own list), the same way.
  for (const d of ['null', 'zero', 'full', 'random', 'urandom', 'tty']) if (exists(`/dev/${d}`)) args.push('--dev-bind', `/dev/${d}`, `/dev/${d}`);
  args.push('--symlink', '/proc/self/fd', '/dev/fd', '--symlink', '/proc/self/fd/0', '/dev/stdin', '--symlink', '/proc/self/fd/1', '/dev/stdout', '--symlink', '/proc/self/fd/2', '/dev/stderr', '--tmpfs', '/dev/shm');
  return args;
}
export function bwrapArgs({ mode = 'strict', root = P.root, dataDir = P.dataDir, workspaceDir, folders = [], tmpDir = '', screen = null, net = null, exists = fs.existsSync } = {}) {
  const ws = String(workspaceDir || '');
  if (mode === 'open') {
    const args = ['--unshare-pid', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
    if (dataDir && exists(dataDir)) args.push('--tmpfs', dataDir);
    return args.concat(['--chdir', ws, '--die-with-parent']);
  }
  const dev = net ? netDevArgs(exists) : ['--dev', '/dev'];
  const args = [...(net ? ['--unshare-user', '--unshare-net'] : []), '--unshare-pid', '--ro-bind', '/', '/', ...dev, '--proc', '/proc', ...(tmpDir ? ['--bind', tmpDir, '/tmp'] : ['--tmpfs', '/tmp']), '--tmpfs', '/home', '--tmpfs', '/root'];
  if (exists('/run/user')) args.push('--tmpfs', '/run/user');
  if (net?.resolv?.file && net.resolv.at) args.push('--ro-bind', net.resolv.file, net.resolv.at);
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
    await checkSandboxNet({ workspaceDir, runImpl }).catch((err) => { netStatus = { state: 'shared', helper: '', reason: `沙箱网络检查出错（${err.message}）` }; });
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
  return { ...status, mode: sandboxMode({ remote: machineMode() === 'remote', autonomous: eff.autonomous }), net: { ...netStatus } };
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
  // 1.5.63: strict mode gets a network of its own where the start-up check found a helper that
  // works. Its set-up failing later is SANDBOX_UNAVAILABLE (runShellCommand): never the shared one.
  const net = mode === 'strict' && netStatus.state === 'own' ? sandboxNet(netStatus.helper) : null;
  return { mode, args: bwrapArgs({ mode, workspaceDir, folders: policy.folders || [], tmpDir, screen, net }), env: mode === 'strict' ? (screen?.env || null) : null, screen: Boolean(screen), net: net ? { helper: net.helper, proxyPorts: net.proxyPorts } : null };
}

// ---------------------------------------------------------------------------
// The strict sandbox's own network (1.5.63)
// ---------------------------------------------------------------------------
//
// The strict bwrap makes a network namespace with only `lo` in it (--unshare-net, one user
// namespace: see netDevArgs); a helper running as the hub joins it and carries its traffic
// out through ordinary sockets of the hub (no root, nothing changed on the machine):
//
//   pasta (passt)  - Debian 12+, Ubuntu 24.04+, Fedora, RHEL / Rocky 9.5+ and 10 (podman uses it).
//                    -T/-U none: no port of this machine's loopback is mapped in, except a
//                    loopback proxy the hub's own environment names (HTTPS_PROXY=127.0.0.1:7890,
//                    say): that one port, so downloads keep working. --no-map-gw: the gateway
//                    address is not this machine. -t/-u none: nothing of the sandbox is offered
//                    outside. DNS: 169.254.1.1, forwarded to this machine's resolver.
//   slirp4netns    - older machines. --disable-host-loopback: 10.0.2.2 does not lead to this
//                    machine's loopback. DNS: 10.0.2.3. It cannot let one loopback port through,
//                    so with a loopback proxy it is not used (the network stays shared, 体检 says why).
//
// Decided once at start (checkSandboxNet): 'own' (and which helper), or 'shared' with the reason
// (体检 shows it in yellow: the bots' commands then reach this machine's local-only ports and the
// human's X server, as before 1.5.63). DESK_SANDBOX_NET=pasta|slirp4netns|shared chooses by hand.

export const PASTA_DNS = '169.254.1.1';
export const SLIRP_DNS = '10.0.2.3';
let netStatus = { state: process.platform === 'linux' ? 'unknown' : 'na', helper: '', reason: '' };
export function sandboxNetStatus() { return { ...netStatus }; }
/** For tests: set what the start-up check would have found. */
export function _setSandboxNetForTests(next) { netStatus = { state: 'unknown', helper: '', reason: '', ...next }; }

/** Loopback ports the hub's environment names as a proxy (HTTP(S)_PROXY, ALL_PROXY): the one way out some machines have. */
export function loopbackProxyPorts(env = process.env) {
  const ports = new Set();
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const v = String(env[key] || '').trim();
    if (!v) continue;
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`); } catch { continue; }
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!(host === 'localhost' || host === '::1' || /^127\./.test(host))) continue;
    const port = Number(u.port || (/^https:/i.test(u.protocol) ? 443 : /^socks/i.test(u.protocol) ? 1080 : 80));
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** The sandbox's /etc/resolv.conf: the helper's DNS, with this machine's search domains and options. */
export function resolvConfText(helper, hostText = '') {
  const keep = String(hostText || '').split(/\r?\n/).filter((l) => /^\s*(search|domain|options)\s/.test(l)).map((l) => l.trim());
  return `# Lamplit: the bots' sandbox has a network of its own (${helper})\nnameserver ${helper === 'pasta' ? PASTA_DNS : SLIRP_DNS}\n${keep.join('\n')}${keep.length ? '\n' : ''}`;
}

/** {helper, proxyPorts, resolv:{file, at}} for bwrapArgs; resolv.conf written under data/ (hidden from every sandbox). */
export function sandboxNet(helper, { dataDir = P.dataDir, env = process.env } = {}) {
  const dir = path.join(dataDir, 'sandbox-net');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `resolv-${helper}.conf`);
  let hostText = '';
  try { hostText = fs.readFileSync('/etc/resolv.conf', 'utf8'); } catch { /* none */ }
  const text = resolvConfText(helper, hostText);
  try { if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, { mode: 0o644 }); } catch { fs.writeFileSync(file, text, { mode: 0o644 }); }
  // Bound over the real file: /etc/resolv.conf is often a link (to systemd-resolved's stub).
  let at = '';
  try { at = fs.realpathSync('/etc/resolv.conf'); } catch { at = ''; }
  return { helper, proxyPorts: helper === 'pasta' ? loopbackProxyPorts(env) : [], resolv: at ? { file, at } : null };
}

/** The helper's command line for the sandbox whose first process is `pid`. -> [file, args] */
export function netHelperCommand(helper, pid, { proxyPorts = [] } = {}) {
  if (helper === 'pasta') {
    // No --pid file (an AppArmor profile may not let pasta write where the hub keeps it): the
    // process left in the background is found by its command line (pastaPidsFor).
    return ['pasta', ['--config-net', '--quiet', '--no-map-gw', '-t', 'none', '-u', 'none', '-T', proxyPorts.length ? proxyPorts.join(',') : 'none', '-U', 'none', '--dns-forward', PASTA_DNS, String(pid)]];
  }
  // fd 3: it writes "1" there when the network is up; fd 4: when the hub's end closes, it exits.
  return ['slirp4netns', ['--configure', '--mtu=65520', '--disable-host-loopback', '--ready-fd=3', '--exit-fd=4', String(pid), 'tap0']];
}

/**
 * [file, args] that run `argv` in `sandbox`: one bwrap, never one inside another (Ubuntu's
 * bwrap-userns-restrict lets what bwrap runs make no user namespace of its own). With a network
 * of its own: --info-fd 3 says the pid of the sandbox's first process (whose user and network
 * namespaces the helper joins - one user namespace, see bwrapArgs / netDevArgs); --block-fd 4:
 * it waits there until the network is up, before anything runs.
 */
export function sandboxCommand(sandbox, argv) {
  if (!sandbox?.net) return ['bwrap', [...sandbox.args, '--', ...argv]];
  return ['bwrap', ['--info-fd', '3', '--block-fd', '4', ...sandbox.args, '--', ...argv]];
}

/**
 * Start `argv` in `sandbox` (from sandboxFor). Without a network of its own this is just bwrap.
 * With one: bwrap is told (--info-fd 3) the pid of the sandbox's first process and waits
 * (--block-fd 4) before running anything; the helper is started on that pid, and only when it
 * says the network is up is bwrap let go. -> {child, ready}: `ready` rejects (code
 * SANDBOX_UNAVAILABLE) when the network could not be set up - the sandbox is then killed
 * before the command ever ran. The helper goes when the sandbox ends.
 */
export function spawnSandboxed(sandbox, argv, { cwd, env, detached = true, timeoutMs = 15000 } = {}) {
  if (!sandbox?.net) {
    const child = spawn('bwrap', [...sandbox.args, '--', ...argv], { cwd, env, detached });
    return { child, ready: Promise.resolve() };
  }
  const [file0, args0] = sandboxCommand(sandbox, argv);
  const child = spawn(file0, args0, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let helperProc = null;
  let sandboxPid = 0;
  let ended = false;
  // pasta attached by pid does not always quit when the namespace's processes are gone (it holds
  // the namespace itself): the one in the background for this sandbox is ended here.
  const stopHelper = () => {
    try { helperProc?.kill('SIGTERM'); } catch { /* gone */ }
    if (sandbox.net.helper === 'pasta' && sandboxPid) for (const pid of pastaPidsFor(sandboxPid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  };
  child.on('close', () => { ended = true; stopHelper(); });
  child.on('error', () => { ended = true; stopHelper(); });
  const fail = (why) => Object.assign(new Error(`the sandbox's own network could not be set up (${sandbox.net.helper}: ${String(why).trim().slice(0, 200)})`), { code: 'SANDBOX_UNAVAILABLE' });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err) { resolve(); return; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      stopHelper();
      reject(err);
    };
    const timer = setTimeout(() => done(fail('timed out')), timeoutMs);
    const info = child.stdio[3];
    const block = child.stdio[4];
    block?.on('error', () => {});
    info?.on('error', () => {});
    let said = '';
    child.on('close', () => done(fail(said || 'the sandbox ended before its network was up')));
    let infoText = '';
    let started = false;
    info?.on('data', (c) => {
      infoText += c;
      const m = /"child-pid"\s*:\s*(\d+)/.exec(infoText);
      if (!m || started) return;
      started = true;
      const pid = Number(m[1]);
      sandboxPid = pid;
      const [file, hargs] = netHelperCommand(sandbox.net.helper, pid, { proxyPorts: sandbox.net.proxyPorts || [] });
      const letGo = () => { if (ended) { done(fail('the sandbox ended')); return; } try { block.end('1'); done(); } catch (err) { done(fail(err.message)); } };
      try {
        helperProc = spawn(file, hargs, { stdio: sandbox.net.helper === 'pasta' ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      } catch (err) { done(fail(err.message)); return; }
      helperProc.on('error', (err) => done(fail(err.code === 'ENOENT' ? `${file} is not installed` : err.message)));
      helperProc.stderr?.on('data', (d) => { said += d; });
      if (sandbox.net.helper === 'pasta') {
        // pasta goes to the background once the namespace is configured: its first process exiting 0 is "up".
        helperProc.on('exit', (code) => {
          helperProc = null;
          if (code === 0) letGo();
          else done(fail(said || `exit ${code}`));
        });
      } else {
        helperProc.stdio[3]?.on('error', () => {});
        helperProc.stdio[4]?.on('error', () => {});
        helperProc.stdio[3]?.on('data', (d) => { if (String(d).includes('1')) letGo(); });
        helperProc.on('exit', (code) => { helperProc = null; done(fail(said || `exit ${code}`)); });
      }
    });
  });
  ready.catch(() => {});
  return { child, ready };
}

/** The pasta processes of this account started for the sandbox whose first process is `sandboxPid` (their last argument). */
export function pastaPidsFor(sandboxPid, { procDir = '/proc' } = {}) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return found; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let argv;
    try { argv = fs.readFileSync(path.join(procDir, name, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (argv.length > 1 && path.basename(argv[0]) === 'pasta' && argv[argv.length - 1] === String(sandboxPid) && argv.includes('--config-net')) found.push(Number(name));
  }
  return found;
}

/**
 * At start, after bwrap itself works (Linux): which helper gives the strict sandbox a network
 * of its own here? Installs pasta where sudo needs no password (as for bwrap), then checks that
 * a sandboxed command really is in another network namespace. -> netStatus
 */
export async function checkSandboxNet({ workspaceDir = P.workspaceDir, runImpl = run, env = process.env, probe = probeSandboxNet, platform = process.platform } = {}) {
  if (platform !== 'linux') { netStatus = { state: 'na', helper: '', reason: '' }; return netStatus; }
  const chosen = String(env.DESK_SANDBOX_NET || '').trim().toLowerCase();
  if (chosen === 'shared' || chosen === 'off' || chosen === '0') {
    netStatus = { state: 'shared', helper: '', reason: '用 DESK_SANDBOX_NET 关掉了' };
    return netStatus;
  }
  const has = async (bin) => (await runImpl('sh', ['-c', `command -v ${bin}`])).code === 0;
  let helpers = (chosen === 'pasta' || chosen === 'slirp4netns') ? [chosen] : ['pasta', 'slirp4netns'];
  let found = [];
  for (const h of helpers) if (await has(h)) found.push(h);
  if (!found.length && !chosen) {
    await runImpl('sh', ['-c', 'command -v apt-get >/dev/null && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq passt || sudo -n dnf install -y -q passt'], { timeoutMs: 180000 });
    if (await has('pasta')) found = ['pasta'];
  }
  if (!found.length) {
    netStatus = { state: 'shared', helper: '', reason: chosen ? `${chosen} 没装` : 'pasta 和 slirp4netns 都没装（sudo apt install passt，或 sudo dnf install passt，然后重启 Lamplit）' };
    return netStatus;
  }
  const proxied = loopbackProxyPorts(env);
  const tried = [];
  for (const helper of found) {
    if (helper === 'slirp4netns' && proxied.length) { tried.push(`slirp4netns 没法只放过本机的代理端口 ${proxied.join('、')}`); continue; }
    const r = await probe(helper, { workspaceDir });
    if (r.ok) { netStatus = { state: 'own', helper, reason: '' }; return netStatus; }
    tried.push(`${helper}：${r.why}`);
  }
  netStatus = { state: 'shared', helper: '', reason: tried.join('；') };
  return netStatus;
}

/** One sandboxed command through `helper`: is it in a network namespace of its own? -> {ok, why} */
export async function probeSandboxNet(helper, { workspaceDir = P.workspaceDir } = {}) {
  let host = '';
  try { host = fs.readlinkSync('/proc/self/ns/net'); } catch { return { ok: false, why: '没有 /proc' }; }
  const net = sandboxNet(helper);
  const sandbox = { mode: 'strict', args: bwrapArgs({ mode: 'strict', workspaceDir, folders: [], net }), net: { helper, proxyPorts: net.proxyPorts } };
  return new Promise((resolve) => {
    let out = '';
    let s;
    try { s = spawnSandboxed(sandbox, ['/bin/sh', '-c', 'readlink /proc/self/ns/net'], { cwd: workspaceDir, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, detached: true }); } catch (err) { resolve({ ok: false, why: err.message }); return; }
    let why = '';
    s.ready.catch((err) => { why = err.message; });
    s.child.stdout.on('data', (c) => { out += c; });
    s.child.stderr.on('data', (c) => { if (!why) why = String(c).trim().slice(0, 200); });
    s.child.on('error', (err) => resolve({ ok: false, why: err.message }));
    s.child.on('close', (code) => {
      const inside = out.trim();
      if (code === 0 && /^net:\[\d+\]$/.test(inside) && inside !== host) resolve({ ok: true, why: '' });
      else resolve({ ok: false, why: why || `退出码 ${code}` });
    });
  });
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
