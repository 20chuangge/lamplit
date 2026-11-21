// The bots' commands under their own Windows account (1.5.7, report 7.2 #2).
//
// On Linux a shell step runs in bubblewrap (src/sandbox.mjs). Windows has no
// such tool, so Lamplit makes a plain local account, lamplit-runner (member of
// Users only, hidden from the sign-in screen, a random password kept sealed in
// data/runner.json), and a shell step runs as that account:
//
//   lamplit-run.exe  <- one JSON-less request on stdin (base64 lines)
//     cmd.exe /d /s /c "chcp 65001>nul & <command>"   as lamplit-runner
//
// lamplit-run.exe is compiled here from the C# below with the compiler that
// comes with Windows (.NET Framework csc.exe). It starts the command with the
// account's password (CreateProcessWithLogonW through .NET), passes the output
// through, and puts the command in a job object: when the step is stopped or
// times out and Lamplit ends lamplit-run.exe, everything the command started
// ends with it.
//
// What the account sees: Windows keeps every user's folder (C:\Users\<name>)
// to its owner, so Lamplit's data (keys, pairing tokens, the vault) and the
// human's own files there are out of reach. Lamplit grants it the workspace
// (modify), the opened folders (read, or modify when set writable), and the
// program folders of tools installed inside the human's user folder (Python,
// ffmpeg: read and run); it denies it Lamplit's program and data folders.
// Other drives keep Windows' defaults (on D: every account may read and write).
//
// Setting the account up needs an administrator once (a UAC prompt); the
// grants afterwards do not (the human owns those folders). Outside the
// account: sudo-like commands (runas, Start-Process -Verb RunAs) and a step
// the human - or the primary bot's full trust - let past the fence.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { P, readJsonSync, writeJsonSyncAtomic } from './store.mjs';
import { SUDO } from './boundary.mjs';

export const RUNNER_USER = 'lamplit-runner';
const runnerFile = () => path.join(P.dataDir, 'runner.json');
const runnerDir = () => path.join(P.dataDir, 'runner');
export const helperExe = () => path.join(runnerDir(), 'lamplit-run.exe');
export const RUNNER_HOME = path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'Lamplit', 'runner-home');

// --- the helper ------------------------------------------------------------------

export const HELPER_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Threading;

// lamplit-run.exe (Lamplit 1.5.7): run one command as another local account.
// stdin, one base64 (UTF-8) value per line: user, password, working folder,
// command, then NAME=value environment lines until an empty line.
static class LamplitRun {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr p1, p2, p3, p4; }
  const uint KILL_ON_JOB_CLOSE = 0x2000;

  static string Next(TextReader r) {
    string s = r.ReadLine();
    return string.IsNullOrEmpty(s) ? "" : Encoding.UTF8.GetString(Convert.FromBase64String(s));
  }
  static void Limit(IntPtr job, uint flags) {
    Extended x = new Extended();
    x.Basic.LimitFlags = flags;
    int len = Marshal.SizeOf(typeof(Extended));
    IntPtr p = Marshal.AllocHGlobal(len);
    Marshal.StructureToPtr(x, p, false);
    SetInformationJobObject(job, 9, p, (uint)len);
    Marshal.FreeHGlobal(p);
  }
  static void Pump(Stream from, Stream to) {
    byte[] buf = new byte[8192];
    int n;
    try { while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); } } catch { }
  }
  static void Say(string text) {
    byte[] b = Encoding.UTF8.GetBytes(text + "\n");
    Stream e = Console.OpenStandardError();
    e.Write(b, 0, b.Length);
    e.Flush();
  }

  static int Main() {
    TextReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string user = Next(input), pass = Next(input), cwd = Next(input), command = Next(input);
    ProcessStartInfo psi = new ProcessStartInfo(Environment.ExpandEnvironmentVariables("%SystemRoot%\\System32\\cmd.exe"), "/d /s /c \"chcp 65001>nul & " + command + "\"");
    psi.UserName = user;
    psi.Domain = ".";
    SecureString secret = new SecureString();
    foreach (char ch in pass) secret.AppendChar(ch);
    psi.Password = secret;
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.LoadUserProfile = false;
    psi.WorkingDirectory = cwd;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.EnvironmentVariables.Clear();
    string line;
    while ((line = input.ReadLine()) != null && line.Length > 0) {
      string kv = Encoding.UTF8.GetString(Convert.FromBase64String(line));
      int i = kv.IndexOf('=');
      if (i > 0) psi.EnvironmentVariables[kv.Substring(0, i)] = kv.Substring(i + 1);
    }
    // Everything the command starts ends when this program is ended (stop, timeout).
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Limit(job, KILL_ON_JOB_CLOSE);
    Process child;
    try { child = Process.Start(psi); }
    catch (Exception e) { Say("LAMPLIT_RUNNER_START: " + e.Message); return 250; }
    AssignProcessToJobObject(job, child.Handle);
    child.StandardInput.Close();
    Thread o = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
    Thread e2 = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
    o.Start();
    e2.Start();
    child.WaitForExit();
    // Ended on its own: a program it left running in the background keeps running.
    if (!o.Join(1500) || !e2.Join(500)) Say("LAMPLIT_RUNNER_LINGERING");
    Limit(job, 0);
    return child.ExitCode;
  }
}
`;

/** The request lamplit-run.exe reads on stdin. */
export function helperPayload({ user = RUNNER_USER, password, cwd, command, env = {} }) {
  const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
  const lines = [b64(user), b64(password), b64(cwd), b64(command)];
  for (const [k, v] of Object.entries(env)) if (k && v !== undefined && !k.includes('=')) lines.push(b64(`${k}=${v}`));
  return `${lines.join('\n')}\n\n`;
}

/** The C# compiler that comes with Windows, or ''. */
export function findCsc(windir = process.env.WINDIR || 'C:\\Windows', exists = fs.existsSync) {
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.win32.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (exists(p)) return p;
  }
  return '';
}

// --- what the account may use ------------------------------------------------------

const lower = (p) => path.win32.resolve(String(p || '')).toLowerCase();
const inside = (p, dir) => { const a = lower(p); const b = lower(dir); return a === b || a.startsWith(b.endsWith('\\') ? b : `${b}\\`); };

/**
 * Program folders of tools installed inside the human's user folder that are
 * on PATH (Python, ffmpeg, uv...): the account may read and run those, and
 * nothing else there. -> [{dir, pathDir}]
 */
export function toolDirs(pathEnv = process.env.PATH || '', localAppData = process.env.LOCALAPPDATA || '') {
  if (!localAppData) return [];
  const roots = [path.win32.join(localAppData, 'Programs'), path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Packages')];
  const out = new Map();
  for (const raw of String(pathEnv).split(';')) {
    const entry = raw.trim().replace(/[\\/]+$/, '');
    if (!entry) continue;
    for (const root of roots) {
      if (!inside(entry, root) || lower(entry) === lower(root)) continue;
      const rel = path.win32.relative(root, entry).split(/[\\/]/)[0];
      const dir = path.win32.join(root, rel);
      if (!out.has(lower(dir))) out.set(lower(dir), { dir, pathDirs: [] });
      out.get(lower(dir)).pathDirs.push(entry);
    }
  }
  return [...out.values()];
}

/**
 * The account's environment: the hub's cleaned one, with its home, profile
 * and temp folders in RUNNER_HOME (it cannot write the human's), and PATH as
 * the human's minus the folders it cannot open (the human's user folder, other
 * than the tool folders granted).
 */
export function runnerEnv(base = {}, { home = RUNNER_HOME, userProfile = process.env.USERPROFILE || '', tools = [] } = {}) {
  const env = { ...base };
  const granted = tools.flatMap((t) => t.pathDirs || []);
  const keepDir = (d) => !userProfile || !inside(d, userProfile) || granted.some((g) => lower(g) === lower(d.replace(/[\\/]+$/, '')));
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  env[pathKey] = String(env[pathKey] || '').split(';').filter((d) => d.trim() && keepDir(d.trim())).join(';');
  for (const k of Object.keys(env)) if (/^(USERPROFILE|HOME|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|TEMP|TMP|USERNAME|ONEDRIVE.*)$/i.test(k)) delete env[k];
  Object.assign(env, {
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(home, 'AppData', 'Local'),
    TEMP: path.win32.join(home, 'Temp'),
    TMP: path.win32.join(home, 'Temp'),
    USERNAME: RUNNER_USER,
  });
  return env;
}

/**
 * icacls calls that keep the account's access right, run as the human (who
 * owns these folders). -> [[...args]]
 */
export function grantPlan({ user = RUNNER_USER, workspace, folders = [], tools = [], denied = [], previous = [] }) {
  const want = new Map();
  if (workspace) want.set(lower(workspace), { path: workspace, right: 'M' });
  for (const f of folders || []) if (f?.path && /^[a-z]:\\/i.test(f.path)) want.set(lower(f.path), { path: f.path, right: f.write ? 'M' : 'RX' });
  for (const t of tools) if (!want.has(lower(t.dir))) want.set(lower(t.dir), { path: t.dir, right: 'RX' });
  const plan = [];
  // Taken back: folders no longer open.
  for (const p of previous) if (!want.has(lower(p)) && !denied.some((d) => lower(d.path) === lower(p))) plan.push([p, '/remove:g', user]);
  for (const g of want.values()) plan.push([g.path, '/grant:r', `${user}:(OI)(CI)${g.right}`]);
  // Lamplit's own program and data: never (a deny wins over Windows' defaults on D:).
  for (const d of denied) plan.push([d.path, '/deny', d.full ? `${user}:(OI)(CI)F` : `${user}:(OI)(CI)(W,D,DC,WDAC,WO)`]);
  return { plan, granted: [...want.values()].map((g) => g.path) };
}

// --- set up (once, as an administrator) -----------------------------------------------

/** The PowerShell the UAC prompt runs: make or refresh the account. Values come from a file. */
export const SETUP_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0] | ConvertFrom-Json
$out = @{ ok = $false }
try {
  $pw = ConvertTo-SecureString $cfg.password -AsPlainText -Force
  if (Get-LocalUser -Name $cfg.user -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $cfg.user -Password $pw -PasswordNeverExpires $true -AccountNeverExpires
    Enable-LocalUser -Name $cfg.user
  } else {
    New-LocalUser -Name $cfg.user -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'Lamplit: runs the bots commands' | Out-Null
  }
  # Users (S-1-5-32-545) only, never Administrators (S-1-5-32-544).
  try { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $cfg.user } catch { }
  try { Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $cfg.user } catch { }
  # Not on the sign-in screen.
  $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  New-Item -Path $k -Force | Out-Null
  New-ItemProperty -Path $k -Name $cfg.user -Value 0 -PropertyType DWord -Force | Out-Null
  # Its home, temp and caches: the account and the human, nobody else.
  New-Item -ItemType Directory -Force -Path $cfg.home | Out-Null
  & icacls $cfg.home /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $cfg.owner + ':(OI)(CI)F') ($cfg.user + ':(OI)(CI)M') | Out-Null
  $out.ok = $true
} catch { $out.error = $_.Exception.Message }
$out | ConvertTo-Json | Set-Content -LiteralPath $cfg.result -Encoding UTF8
`;

let status = { state: process.platform === 'win32' ? 'unknown' : 'na', reason: '' };
let setupJob = null;

export function readRunner() {
  const r = readJsonSync(runnerFile(), null);
  return r && r.user && r.password ? r : null;
}

function run(file, args, { input = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { resolve({ code: -1, out: err.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

/** Compile lamplit-run.exe when it is missing or older than this source. */
export async function ensureHelper() {
  const exe = helperExe();
  const hash = crypto.createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 16);
  const stamp = path.join(runnerDir(), 'lamplit-run.hash');
  const have = (() => { try { return fs.readFileSync(stamp, 'utf8').trim(); } catch { return ''; } })();
  if (fs.existsSync(exe) && have === hash) return exe;
  const csc = findCsc();
  if (!csc) throw new Error('这台电脑上没有找到 Windows 自带的 C# 编译器（.NET Framework 4）');
  fs.mkdirSync(runnerDir(), { recursive: true });
  const src = path.join(runnerDir(), 'lamplit-run.cs');
  fs.writeFileSync(src, HELPER_SOURCE);
  const r = await run(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, src]);
  if (r.code !== 0 || !fs.existsSync(exe)) throw new Error(`编译 lamplit-run.exe 失败：${r.out.trim().split('\n').slice(-2).join(' ')}`);
  fs.writeFileSync(stamp, hash);
  return exe;
}

/** The human's account SID (owner of the runner's home). */
async function mySid() {
  const r = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
  return (r.out.match(/S-1-5-[\d-]+/) || [])[0] || '';
}

/**
 * Lamplit's data (nothing at all, wherever it is) and its program (no
 * writing: a changed server file would run as the human next start).
 */
export function deniedDirs({ execPath = process.execPath, root = P.root, dataDir = P.dataDir } = {}) {
  const dirs = [{ path: dataDir, full: true }];
  // The installed app; resources/server (root) is inside it.
  if (/\\lamplit\.exe$/i.test(execPath)) dirs.push({ path: path.win32.dirname(execPath), full: false });
  if (!dirs.some((d) => inside(root, d.path))) dirs.push({ path: root, full: false });
  return dirs;
}

/** Bring the account's folder access in line with the workspace and the opened folders. */
export async function syncGrants(policy = {}, { workspaceDir = P.workspaceDir, onlyIfChanged = false } = {}) {
  const runner = readRunner();
  if (process.platform !== 'win32' || !runner) return null;
  const tools = toolDirs();
  const denied = deniedDirs();
  const { plan, granted } = grantPlan({ workspace: workspaceDir, folders: policy.folders || [], tools, denied, previous: runner.granted || [] });
  // At start: icacls walks every file below, so only when something changed.
  const key = (list) => list.map(lower).sort().join('|');
  if (onlyIfChanged && key(granted) === key(runner.granted || []) && key(denied.map((d) => d.path)) === key(runner.denied || [])) return { granted, failed: [], skipped: true };
  const failed = [];
  for (const args of plan) {
    const r = await run('icacls', [...args, '/Q'], { timeoutMs: 300000 });
    if (r.code !== 0) failed.push(`${args[0]}：${r.out.trim().split('\n').pop()}`);
  }
  writeJsonSyncAtomic(runnerFile(), { ...runner, granted, denied: denied.map((d) => d.path), tools: tools.map((t) => t.dir) });
  return { granted, failed };
}

/**
 * Make the account (a UAC prompt on this computer), compile the helper, grant
 * the folders, then check it. Runs in the background; status() follows it.
 */
export function setupRunner(policy, { workspaceDir = P.workspaceDir } = {}) {
  if (process.platform !== 'win32') throw Object.assign(new Error('只有 Windows 需要单独的账户'), { status: 400, code: 'NOT_WINDOWS' });
  if (setupJob) return status;
  status = { state: 'setting-up', reason: '' };
  setupJob = (async () => {
    const work = runnerDir();
    fs.mkdirSync(work, { recursive: true });
    const cfgFile = path.join(work, 'setup.json');
    const resultFile = path.join(work, 'setup-result.json');
    const scriptFile = path.join(work, 'setup.ps1');
    try {
      await ensureHelper();
      const password = `Lp-${crypto.randomBytes(18).toString('base64url')}9!`;
      const owner = await mySid();
      if (!owner) throw new Error('读不到你的账户');
      fs.rmSync(resultFile, { force: true });
      fs.writeFileSync(scriptFile, `\uFEFF${SETUP_SCRIPT}`);
      // The password is in this file only while the prompt is up; data/ is the human's alone.
      fs.writeFileSync(cfgFile, JSON.stringify({ user: RUNNER_USER, password, home: RUNNER_HOME, owner, result: resultFile }));
      // Already an administrator (a machine added for the bots, 1.5.9): run it
      // directly - there is no screen for a UAC prompt in its service session.
      const r = await isElevated()
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, cfgFile], { timeoutMs: 300000 })
        : await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${scriptFile}"','"${cfgFile}"')`], { timeoutMs: 300000 });
      fs.rmSync(cfgFile, { force: true });
      let result = null;
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* none */ }
      if (!result) throw new Error(/cancel|取消/i.test(r.out) ? '你取消了管理员确认' : `没有完成（${r.out.trim().split('\n').pop() || '管理员确认没有通过'}）`);
      if (!result.ok) throw new Error(result.error || '建账户失败');
      writeJsonSyncAtomic(runnerFile(), { user: RUNNER_USER, password, home: RUNNER_HOME, createdAt: new Date().toISOString(), granted: [] });
      await syncGrants(policy, { workspaceDir });
      await checkRunner({ workspaceDir });
    } catch (err) {
      status = { state: 'setup', reason: err.message };
    } finally {
      fs.rmSync(cfgFile, { force: true });
      fs.rmSync(resultFile, { force: true });
      setupJob = null;
    }
  })();
  return status;
}

/** Is this process an administrator already (a Windows machine added remotely runs so)? */
export async function isElevated() {
  if (process.platform !== 'win32') return false;
  const r = await run('net', ['session'], { timeoutMs: 10000 });
  return r.code === 0;
}

/**
 * A Windows machine Lamplit set up for the bots (1.5.9): its hub runs as an
 * administrator, so the account is made at start, with no prompt and no one
 * at the screen. Before this, the bots' commands there ran as an administrator.
 */
export async function autoSetupOnHub(policy, { workspaceDir = P.workspaceDir, remote = process.env.DESK_MACHINE_MODE === 'remote' } = {}) {
  if (process.platform !== 'win32' || !remote || readRunner()) return false;
  if (!(await isElevated())) return false;
  setupRunner(policy, { workspaceDir });
  return true;
}

/**
 * Run one command as the account -> {code, out} (the checks; the shell tool
 * goes through runnerFor + tools.mjs).
 */
async function runAs(command, cwd) {
  const runner = readRunner();
  const env = runnerEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec }, { home: runner.home || RUNNER_HOME, tools: toolDirs() });
  return run(helperExe(), [], { input: helperPayload({ user: runner.user, password: runner.password, cwd, command, env }) });
}

/** The check: as the account, Lamplit's data must not be readable and the workspace writable. */
export async function checkRunner({ workspaceDir = P.workspaceDir, secret = P.securityFile } = {}) {
  if (process.platform !== 'win32') { status = { state: 'na', reason: '' }; return status; }
  if (!readRunner()) { status = { state: 'setup', reason: '' }; return status; }
  try {
    await ensureHelper();
    const probe = path.join(workspaceDir, `.lamplit-runner-probe-${process.pid}`);
    const r = await runAs(`whoami & (type "${secret}" >nul 2>&1 && echo DATA-VISIBLE || echo DATA-HIDDEN) & (echo x>"${probe}" && del "${probe}" && echo WORKSPACE-OK)`, workspaceDir);
    const who = new RegExp(`\\\\${RUNNER_USER}\\b`, 'i').test(r.out);
    if (who && /DATA-HIDDEN/.test(r.out) && /WORKSPACE-OK/.test(r.out)) status = { state: 'on', reason: '' };
    else {
      const said = r.out.replace(/LAMPLIT_RUNNER_START:\s*/, '').trim().split('\n').pop().slice(0, 200);
      status = { state: 'off', reason: !who ? `用这个账户启动不了命令（${said}）` : /DATA-VISIBLE/.test(r.out) ? '这个账户读得到 Lamplit 的数据' : '这个账户写不了工作区' };
    }
  } catch (err) {
    status = { state: 'off', reason: err.message };
  }
  return status;
}

export function runnerStatus() {
  return { ...status, user: RUNNER_USER };
}

/** Does this command run as the account? */
export function runsAsRunner({ platform = process.platform, command = '', unfenced = false } = {}) {
  if (platform !== 'win32' || unfenced) return false;
  return !SUDO.test(String(command));
}

/** For one shell step: {exe, input} to run, or null (runs as the human, as before). */
export function runnerFor(command, ctx = {}, baseEnv = {}) {
  if (status.state !== 'on') return null;
  if (!runsAsRunner({ command, unfenced: Boolean(ctx.shellUnfenced) })) return null;
  const runner = readRunner();
  if (!runner) return null;
  const cwd = path.resolve(String(ctx.workspaceDir || P.workspaceDir));
  const env = runnerEnv(baseEnv, { home: runner.home || RUNNER_HOME, tools: toolDirs() });
  return { exe: helperExe(), input: helperPayload({ user: runner.user, password: runner.password, cwd, command, env }) };
}

/**
 * Moving a workspace file or folder AS the account (1.5.55, the verifier's
 * second 1.5.54 round). Windows resolves a move's two names one after the
 * other, so a bot that keeps swapping a folder on the way for a junction to
 * Lamplit's data folder could get the hub (which can reach that folder) to
 * move a data file into the workspace. Done as lamplit-runner, Windows' own
 * access check refuses every name that leads into the data folder, however
 * the names are resolved. The names go in environment variables, never into
 * the command line (a name may hold %, &, ^). -> async (from, to), or null
 * when the account is not on (then the bots run as the human and see the data
 * folder anyway: there is no line to keep).
 */
export const FENCED_MOVE = 'move "%LAMPLIT_FROM%" "%LAMPLIT_TO%" >nul';
export function fencedMoveEnv(from, to) {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return { SystemRoot: root, ComSpec: path.win32.join(root, 'System32', 'cmd.exe'), PATH: path.win32.join(root, 'System32'), LAMPLIT_FROM: from, LAMPLIT_TO: to };
}
export function fencedMover(workspaceDir = P.workspaceDir) {
  if (process.platform !== 'win32' || status.state !== 'on') return null;
  const runner = readRunner();
  if (!runner) return null;
  return async (from, to) => {
    const env = runnerEnv(fencedMoveEnv(from, to), { home: runner.home || RUNNER_HOME });
    const input = helperPayload({ user: runner.user, password: runner.password, cwd: path.resolve(String(workspaceDir)), command: FENCED_MOVE, env });
    const r = await run(helperExe(), [], { input, timeoutMs: 30000 });
    if (r.code !== 0) throw Object.assign(new Error(`moving as ${RUNNER_USER} was refused: ${String(r.out).trim().slice(-200)}`), { code: 'EFENCE' });
  };
}

export const _test = { setStatus: (s) => { status = s; }, osHome: os.homedir };
