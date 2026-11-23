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
// account's password (CreateProcessWithLogonW), passes the output through, and
// puts the command in a job object: when the step is stopped or times out and
// Lamplit ends lamplit-run.exe, everything the command started ends with it.
//
// Where it runs (1.5.63, F11): not on the human's desktop. Until 1.5.62 Windows
// put the account's programs on WinSta0\Default, next to the human's own, where
// they could list the human's windows, send them keys and messages, read the
// clipboard and set a keyboard hook. Now lamplit-run.exe starts the command on a
// desktop of the bots' own ("lamplit-bots-<random>"), in the window station
// Windows keeps for this logon session instead of the interactive WinSta0: its
// own windows, hooks, clipboard and (blank) screen. Programs a bot opens there
// are not on the human's screen (nor in the live view); desktop_ui reaches them
// through the account (winui.mjs). If that desktop cannot be made, nothing runs:
// 体检 says so (state 'blocked'), and no command falls back to the human's
// desktop or account.
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
import { childEnv } from './childenv.mjs';

export const RUNNER_USER = 'lamplit-runner';
const runnerFile = () => path.join(P.dataDir, 'runner.json');
const runnerDir = () => path.join(P.dataDir, 'runner');
export const helperExe = () => path.join(runnerDir(), 'lamplit-run.exe');
export const RUNNER_HOME = path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'Lamplit', 'runner-home');

// --- the helper ------------------------------------------------------------------

export const HELPER_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// lamplit-run.exe (Lamplit 1.5.7; the bots' own desktop 1.5.63): run one command as another local account.
// stdin, one base64 (UTF-8) value per line: user, password, working folder,
// command, then NAME=value environment lines until an empty line.
//
// 1.5.63 (F11): the command no longer joins the human's window station and desktop
// (WinSta0\Default). It starts on a desktop of the bots' own, in a window station
// that is not the human's interactive one. A window station has its own clipboard,
// atoms and screen; a desktop its own windows and hooks. So the account's programs
// cannot list, message, hook or capture the human's windows, nor read their
// clipboard. With lpDesktop set, CreateProcessWithLogonW adds no rights for the
// account to the human's window station either. If the bots' desktop cannot be
// made, nothing runs (LAMPLIT_RUNNER_DESKTOP), never on the human's desktop.
static class LamplitRun {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr p1, p2, p3, p4; }
  const uint KILL_ON_JOB_CLOSE = 0x2000;

  [StructLayout(LayoutKind.Sequential)] struct SecAttr { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcInfo { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SecAttr sa);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecAttr sa);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buf, int len, out int need);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h, int type, int what, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo")] static extern uint GetSecurityInfoDacl(IntPtr h, int type, int what, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr h, int type, uint what, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll")] static extern int GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, int rev, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecAttr sa, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags,
    string app, StringBuilder cmd, int flags, IntPtr env, string cwd, ref StartupInfo si, out ProcInfo pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    int flags, IntPtr env, string cwd, ref StartupInfo si, out ProcInfo pi);

  const int SE_WINDOW_OBJECT = 7, OWNER_INFO = 1, DACL_INFO = 4;
  const uint PROTECTED_DACL = 0x80000000;
  // The account's rights. Window station: everything but listing (WINSTA_ENUMDESKTOPS, 1) and making
  // (WINSTA_CREATEDESKTOP, 8) desktops, so it can neither find nor take the bots' desktop's name;
  // plus READ_CONTROL. The bots' desktop: everything (0x1FF) plus READ_CONTROL. Never WRITE_DAC or
  // WRITE_OWNER: it cannot open either to anyone else.
  const int RUNNER_WINSTA = 0x20376;
  const string RUNNER_DESKTOP = "0x201FF";
  const uint WINSTA_OPEN = 0x37F | 0x20000 | 0x40000; // all, READ_CONTROL, WRITE_DAC
  const uint ALL_ACCESS = 0x10000000; // GENERIC_ALL
  const int CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
  const int STARTF_USESTDHANDLES = 0x100;
  const uint STATUS_DLL_INIT_FAILED = 0xC0000142;

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
  class Refused : Exception { public Refused(string m) : base(m) { } }
  static string Win32(string what) { int e = Marshal.GetLastWin32Error(); return what + ": " + new System.ComponentModel.Win32Exception(e).Message + " (" + e + ")"; }
  static string Win32(string what, uint e) { return what + ": " + new System.ComponentModel.Win32Exception((int)e).Message + " (" + e + ")"; }

  // --- the bots' window station and desktop ------------------------------------------

  static SecurityIdentifier OwnerOf(IntPtr h) {
    IntPtr owner, sd;
    if (GetSecurityInfo(h, SE_WINDOW_OBJECT, OWNER_INFO, out owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd) != 0) return null;
    try { return new SecurityIdentifier(owner); } finally { LocalFree(sd); }
  }
  static string NameOf(IntPtr h) {
    StringBuilder b = new StringBuilder(256); int need;
    return GetUserObjectInformation(h, 2, b, 512, out need) ? b.ToString() : "";
  }
  static SecAttr Attr(string sddl, out IntPtr sd) {
    uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, out size)) throw new Refused(Win32("security descriptor"));
    SecAttr sa = new SecAttr(); sa.nLength = Marshal.SizeOf(typeof(SecAttr)); sa.lpSecurityDescriptor = sd; sa.bInheritHandle = false;
    return sa;
  }
  /** Our own desktop: exactly this access list. */
  static void SetDacl(IntPtr h, string sddl) {
    IntPtr sd;
    Attr(sddl, out sd);
    try {
      bool present, defaulted; IntPtr dacl;
      GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted);
      uint r = SetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_INFO | PROTECTED_DACL, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (r != 0) throw new Refused(Win32("SetSecurityInfo", r));
    } finally { LocalFree(sd); }
  }
  /** A window station that is not ours alone: one allow entry for the account, every entry already there kept. */
  static void EnsureAce(IntPtr h, SecurityIdentifier who, int mask) {
    IntPtr dacl, sd;
    uint r = GetSecurityInfoDacl(h, SE_WINDOW_OBJECT, DACL_INFO, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd);
    if (r != 0) throw new Refused(Win32("reading the window station's access list", r));
    RawSecurityDescriptor raw;
    try {
      byte[] b = new byte[GetSecurityDescriptorLength(sd)];
      Marshal.Copy(sd, b, 0, b.Length);
      raw = new RawSecurityDescriptor(b, 0);
    } finally { LocalFree(sd); }
    RawAcl acl = raw.DiscretionaryAcl ?? new RawAcl(2, 1);
    int at = 0;
    for (int i = 0; i < acl.Count; i++) {
      CommonAce a = acl[i] as CommonAce;
      if (a == null) continue;
      if (a.AceQualifier == AceQualifier.AccessDenied) at = i + 1;
      if (a.AceQualifier == AceQualifier.AccessAllowed && a.SecurityIdentifier.Equals(who) && (a.AceFlags & AceFlags.InheritOnly) == 0 && (a.AccessMask & mask) == mask) return;
    }
    acl.InsertAce(at, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, mask, who, false, null));
    byte[] bin = new byte[acl.BinaryLength];
    acl.GetBinaryForm(bin, 0);
    GCHandle pin = GCHandle.Alloc(bin, GCHandleType.Pinned);
    try {
      r = SetSecurityInfo(h, SE_WINDOW_OBJECT, DACL_INFO, IntPtr.Zero, IntPtr.Zero, pin.AddrOfPinnedObject(), IntPtr.Zero);
      if (r != 0) throw new Refused(Win32("SetSecurityInfo", r));
    } finally { pin.Free(); }
  }

  /** The bots' desktop's name, kept next to this program in Lamplit's data (the account cannot read it). */
  static string NameFile() { return Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "lamplit-run.desktop"); }
  static string NewName() {
    byte[] b = new byte[8];
    new System.Security.Cryptography.RNGCryptoServiceProvider().GetBytes(b);
    string n = "lamplit-bots-" + BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    File.WriteAllText(NameFile(), n);
    return n;
  }
  static string CurrentName() {
    try { string n = File.ReadAllText(NameFile()).Trim(); if (n.StartsWith("lamplit-bots-") && n.Length < 64) return n; } catch { }
    return NewName();
  }

  /**
   * The bots' window station and desktop -> "winsta\desktop"; the handles stay open until this
   * program ends (then Windows keeps them while a program the account started is still on them).
   *
   * Window station: an ordinary account may not make one under a name of its choosing, so it is the
   * one Windows keeps for this logon session (CreateWindowStation with no name: "Service-0x0-<id>$",
   * the one Chromium-based programs put their sandboxed processes in). Never WinSta0, the human's
   * interactive one: its clipboard, atoms and screen are not the human's. When it is new it gets a
   * copy of the current window station's access list (as Chromium does); the account gets one entry
   * of its own and nothing else there changes. Its owner is not checked: no one else can make a window
   * station under that name, and a hub running as a service (an added machine) is in one Windows made.
   *
   * Desktop: Lamplit's own, under a random name kept in Lamplit's data; its access list the human,
   * SYSTEM and the account. A desktop of that name that someone else made is never used: a new name
   * is picked.
   */
  static string MakeDesktop(SecurityIdentifier runner, out IntPtr ws, out IntPtr desk) {
    WindowsIdentity me = WindowsIdentity.GetCurrent();
    SecurityIdentifier owner = me.Owner ?? me.User;
    string deskSddl = "D:P(A;;GA;;;SY)(A;;GA;;;" + me.User.Value + ")" + (runner == null ? "" : "(A;;" + RUNNER_DESKTOP + ";;;" + runner.Value + ")");
    IntPtr curDacl, curSd;
    bool copied = GetSecurityInfoDacl(GetProcessWindowStation(), SE_WINDOW_OBJECT, DACL_INFO, IntPtr.Zero, IntPtr.Zero, out curDacl, IntPtr.Zero, out curSd) == 0;
    SecAttr wsa = new SecAttr(); wsa.nLength = Marshal.SizeOf(typeof(SecAttr)); wsa.lpSecurityDescriptor = copied ? curSd : IntPtr.Zero;
    // With the right to change its access list if we may; a window station Windows made for a service may not give that.
    string err = null;
    ws = IntPtr.Zero;
    foreach (uint access in new uint[] { WINSTA_OPEN, 0x37F | 0x20000 }) {
      ws = CreateWindowStation(null, 0, access, ref wsa);
      if (ws != IntPtr.Zero) break;
      err = Win32("CreateWindowStation");
    }
    if (copied) LocalFree(curSd);
    if (ws == IntPtr.Zero) throw new Refused(err);
    string wsName = NameOf(ws);
    if (wsName.Length == 0 || string.Equals(wsName, "WinSta0", StringComparison.OrdinalIgnoreCase)) throw new Refused("Windows offered the human's own window station (" + wsName + ")");
    if (runner != null) EnsureAce(ws, runner, RUNNER_WINSTA);
    string name = CurrentName();
    for (int attempt = 0; ; attempt++) {
      IntPtr before = GetProcessWindowStation();
      if (!SetProcessWindowStation(ws)) throw new Refused(Win32("SetProcessWindowStation"));
      IntPtr sd;
      SecAttr sa = Attr(deskSddl, out sd);
      try {
        desk = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, ALL_ACCESS, ref sa);
        err = desk == IntPtr.Zero ? Win32("CreateDesktop") : null;
      } finally { SetProcessWindowStation(before); LocalFree(sd); }
      if (desk == IntPtr.Zero) throw new Refused(err);
      SecurityIdentifier d = OwnerOf(desk);
      if (d != null && d.Equals(owner)) break;
      CloseDesktop(desk);
      if (attempt >= 2) throw new Refused("a desktop named like the bots' is held by someone else");
      name = NewName();
    }
    SetDacl(desk, deskSddl);
    return wsName + "\\" + name;
  }

  static SecurityIdentifier AccountSid(string user) {
    try { return (SecurityIdentifier)new NTAccount(Environment.MachineName, user).Translate(typeof(SecurityIdentifier)); } catch { }
    try { return (SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier)); } catch { }
    throw new Exception("there is no account named " + user);
  }

  static IntPtr EnvBlock(SortedDictionary<string, string> env) {
    StringBuilder b = new StringBuilder();
    foreach (KeyValuePair<string, string> kv in env) b.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
    b.Append('\0');
    return Marshal.StringToHGlobalUni(b.ToString());
  }
  /** A pipe whose one end the command gets (inheritable) and whose other end stays here. */
  static void Pipe(out IntPtr ours, out IntPtr theirs, bool theyRead) {
    SecAttr sa = new SecAttr(); sa.nLength = Marshal.SizeOf(typeof(SecAttr)); sa.bInheritHandle = true;
    IntPtr r, w;
    if (!CreatePipe(out r, out w, ref sa, 0)) throw new Exception(Win32("CreatePipe"));
    ours = theyRead ? w : r;
    theirs = theyRead ? r : w;
    SetHandleInformation(ours, 1, 0);
  }

  static int Main(string[] args) {
    // --as-me: the same launch on the bots' desktop, as the account running this program (Lamplit's
    // own checks on a computer without a second account; never a bot's command).
    bool asMe = Array.IndexOf(args, "--as-me") >= 0;
    // --say-where: say which window station and desktop it ran on (Lamplit's check of the account).
    bool sayWhere = Array.IndexOf(args, "--say-where") >= 0;
    TextReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string user = Next(input), pass = Next(input), cwd = Next(input), command = Next(input);
    SortedDictionary<string, string> env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    string line;
    while ((line = input.ReadLine()) != null && line.Length > 0) {
      string kv = Encoding.UTF8.GetString(Convert.FromBase64String(line));
      int i = kv.IndexOf('=');
      if (i > 0) env[kv.Substring(0, i)] = kv.Substring(i + 1);
    }
    // This program's own stdin/stdout/stderr are not the command's (only the pipes below are).
    for (int s = -10; s >= -12; s--) SetHandleInformation(GetStdHandle(s), 1, 0);

    SecurityIdentifier runner = null;
    if (!asMe) {
      try { runner = AccountSid(user); } catch (Exception e) { Say("LAMPLIT_RUNNER_START: " + e.Message); return 250; }
    }
    IntPtr ws, desk;
    string where;
    try { where = MakeDesktop(runner, out ws, out desk); }
    catch (Exception e) { Say("LAMPLIT_RUNNER_DESKTOP: nothing ran - the bots' own Windows desktop could not be set up (" + e.Message + ")"); return 251; }
    if (sayWhere) Say("LAMPLIT_RUNNER_ON " + where);

    string cmdExe = Environment.ExpandEnvironmentVariables("%SystemRoot%\\System32\\cmd.exe");
    StringBuilder cmdLine = new StringBuilder("\"" + cmdExe + "\" /d /s /c \"chcp 65001>nul & " + command + "\"");
    IntPtr inR, inW, outR, outW, errR, errW;
    Pipe(out inW, out inR, true);
    Pipe(out outR, out outW, false);
    Pipe(out errR, out errW, false);
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(typeof(StartupInfo));
    si.lpDesktop = where;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = inR; si.hStdOutput = outW; si.hStdError = errW;
    IntPtr block = EnvBlock(env);
    int flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
    ProcInfo pi;
    bool ok = asMe
      ? CreateProcess(cmdExe, cmdLine, IntPtr.Zero, IntPtr.Zero, true, flags, block, cwd, ref si, out pi)
      : CreateProcessWithLogonW(user, ".", pass, 0, cmdExe, cmdLine, flags, block, cwd, ref si, out pi);
    string startErr = ok ? null : Win32(asMe ? "CreateProcess" : "CreateProcessWithLogonW");
    pass = null;
    Marshal.FreeHGlobal(block);
    CloseHandle(inR); CloseHandle(outW); CloseHandle(errW);
    CloseHandle(inW); // the command reads nothing (as before)
    if (!ok) { Say("LAMPLIT_RUNNER_START: " + startErr); CloseHandle(outR); CloseHandle(errR); return 250; }
    // In the job before it runs a single instruction: everything it starts ends when this program is ended (stop, timeout).
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Limit(job, KILL_ON_JOB_CLOSE);
    if (!AssignProcessToJobObject(job, pi.hProcess)) { Say("LAMPLIT_RUNNER_START: " + Win32("AssignProcessToJobObject")); TerminateProcess(pi.hProcess, 250); return 250; }
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    FileStream so = new FileStream(new SafeFileHandle(outR, true), FileAccess.Read, 4096, false);
    FileStream se = new FileStream(new SafeFileHandle(errR, true), FileAccess.Read, 4096, false);
    Thread o = new Thread(() => Pump(so, Console.OpenStandardOutput()));
    Thread e2 = new Thread(() => Pump(se, Console.OpenStandardError()));
    o.IsBackground = true;
    e2.IsBackground = true;
    o.Start();
    e2.Start();
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hProcess);
    // Ended on its own: a program it left running in the background keeps running.
    if (!o.Join(1500) || !e2.Join(500)) Say("LAMPLIT_RUNNER_LINGERING");
    if (code == STATUS_DLL_INIT_FAILED) Say("LAMPLIT_RUNNER_DESKTOP: nothing ran - the command could not start on the bots' own Windows desktop (0xC0000142)");
    Limit(job, 0);
    GC.KeepAlive(ws);
    GC.KeepAlive(desk);
    return (int)code;
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
async function runAs(command, cwd, args = []) {
  const runner = readRunner();
  const env = runnerEnv({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec }, { home: runner.home || RUNNER_HOME, tools: toolDirs() });
  return run(helperExe(), args, { input: helperPayload({ user: runner.user, password: runner.password, cwd, command, env }) });
}

/**
 * What the check's output says (1.5.63) -> {state, reason, where}. 'on' needs all of: the account
 * ran it, Lamplit's data hidden from it, the workspace writable, and it ran on the bots' own
 * desktop (lamplit-run.exe --say-where), never on WinSta0. 'blocked': the account is there but
 * the bots' desktop could not be made, so nothing runs (no command falls back to the human).
 */
export function readCheck(out = '', user = RUNNER_USER) {
  const text = String(out).replace(/\r/g, '');
  const refused = (/^LAMPLIT_RUNNER_DESKTOP: (.*)$/m.exec(text) || [])[1];
  if (refused) return { state: 'blocked', reason: `给机器人单独开的桌面建不起来，机器人的命令现在都不会运行（${refused.replace(/^nothing ran - /, '').trim().slice(0, 200)}）`, where: '' };
  const where = ((/^LAMPLIT_RUNNER_ON (.+)$/m.exec(text) || [])[1] || '').trim();
  const who = new RegExp(`\\\\${user}\\b`, 'i').test(text);
  const ownDesktop = /^[^\\]+\\lamplit-bots-[0-9a-f]+$/i.test(where) && !/^winsta0\\/i.test(where);
  if (who && ownDesktop && /DATA-HIDDEN/.test(text) && /WORKSPACE-OK/.test(text)) return { state: 'on', reason: '', where };
  const said = text.replace(/^LAMPLIT_RUNNER_ON .*$/m, '').replace(/LAMPLIT_RUNNER_START:\s*/, '').trim().split('\n').pop().slice(0, 200);
  return {
    state: 'off',
    where,
    reason: !who ? `用这个账户启动不了命令（${said}）` : /DATA-VISIBLE/.test(text) ? '这个账户读得到 Lamplit 的数据'
      : !/WORKSPACE-OK/.test(text) ? '这个账户写不了工作区' : `命令没有跑在机器人自己的桌面上（${where || '不知道在哪'}）`,
  };
}

let checkedAt = 0;

/** The check: as the account, Lamplit's data must not be readable, the workspace writable, and it runs on the bots' own desktop. */
export async function checkRunner({ workspaceDir = P.workspaceDir, secret = P.securityFile } = {}) {
  checkedAt = Date.now();
  if (process.platform !== 'win32') { status = { state: 'na', reason: '' }; return status; }
  if (!readRunner()) { status = { state: 'setup', reason: '' }; return status; }
  try {
    await ensureHelper();
    const probe = path.join(workspaceDir, `.lamplit-runner-probe-${process.pid}`);
    const r = await runAs(`whoami & (type "${secret}" >nul 2>&1 && echo DATA-VISIBLE || echo DATA-HIDDEN) & (echo x>"${probe}" && del "${probe}" && echo WORKSPACE-OK)`, workspaceDir, ['--say-where']);
    const { state, reason } = readCheck(r.out, readRunner()?.user || RUNNER_USER);
    status = { state, reason };
  } catch (err) {
    status = { state: 'off', reason: err.message };
  }
  return status;
}

/**
 * Commands go through the account when it is on - and when it is set up but its desktop could not
 * be made ('blocked'): lamplit-run.exe then refuses each one, so nothing runs as the human or on
 * their desktop. A blocked state is looked at again at most once a minute (it may have cleared).
 */
function throughAccount() {
  if (status.state === 'blocked' && Date.now() - checkedAt > 60000) checkRunner().catch(() => {});
  return status.state === 'on' || status.state === 'blocked';
}

export function runnerStatus() {
  return { ...status, user: RUNNER_USER };
}

/** Does this command run as the account? */
export function runsAsRunner({ platform = process.platform, command = '', unfenced = false } = {}) {
  if (platform !== 'win32' || unfenced) return false;
  return !SUDO.test(String(command));
}

/**
 * desktop_ui on the bots' own desktop (1.5.63): {exe, input} that runs the UI Automation script
 * there as the account, or null when commands do not go through the account. The script and the
 * request travel in environment variables (extraEnv); the command line is fixed and short.
 */
export function uiRunnerFor(extraEnv = {}, bootEncoded = '') {
  if (process.platform !== 'win32' || !/^[A-Za-z0-9+/=]+$/.test(bootEncoded) || !throughAccount()) return null;
  const runner = readRunner();
  if (!runner) return null;
  const ps = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = runnerEnv({ ...childEnv(), ...extraEnv }, { home: runner.home || RUNNER_HOME, tools: toolDirs() });
  const command = `"${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${bootEncoded}`;
  // Its own home as the folder: always there for it (the workspace need not be).
  return { exe: helperExe(), input: helperPayload({ user: runner.user, password: runner.password, cwd: runner.home || RUNNER_HOME, command, env }) };
}

/** For one shell step: {exe, input} to run, or null (runs as the human: the account is not set up, or its check failed). */
export function runnerFor(command, ctx = {}, baseEnv = {}) {
  if (!throughAccount()) return null;
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
  if (process.platform !== 'win32' || !throughAccount()) return null;
  const runner = readRunner();
  if (!runner) return null;
  return async (from, to) => {
    const env = runnerEnv(fencedMoveEnv(from, to), { home: runner.home || RUNNER_HOME });
    const input = helperPayload({ user: runner.user, password: runner.password, cwd: path.resolve(String(workspaceDir)), command: FENCED_MOVE, env });
    const r = await run(helperExe(), [], { input, timeoutMs: 30000 });
    if (r.code !== 0) throw Object.assign(new Error(`moving as ${RUNNER_USER} was refused: ${String(r.out).trim().slice(-200)}`), { code: 'EFENCE' });
  };
}

/**
 * Removing a taken-out workspace folder AS the account (1.5.60, the verifier's F2):
 * a recursive removal goes by name, so a folder inside it swapped for a junction
 * to the data folder could lead the hub's own removal there. As lamplit-runner
 * Windows refuses every name in the data folder; rmdir /s does not follow
 * junctions either. -> async (dir), or null when the account is not on.
 */
export const FENCED_REMOVE = 'rmdir /s /q "%LAMPLIT_FROM%"';
export function fencedRemover(workspaceDir = P.workspaceDir) {
  if (process.platform !== 'win32' || !throughAccount()) return null;
  const runner = readRunner();
  if (!runner) return null;
  return async (dir) => {
    const env = runnerEnv(fencedMoveEnv(dir, ''), { home: runner.home || RUNNER_HOME });
    const input = helperPayload({ user: runner.user, password: runner.password, cwd: path.resolve(String(workspaceDir)), command: FENCED_REMOVE, env });
    const r = await run(helperExe(), [], { input, timeoutMs: 120000 });
    if (r.code !== 0 || fs.existsSync(dir)) throw Object.assign(new Error(`removing as ${RUNNER_USER} was refused: ${String(r.out).trim().slice(-200)}`), { code: 'EFENCE' });
  };
}

// setStatus also counts as a fresh check, so a test's 'blocked' never starts a real one.
export const _test = { setStatus: (s) => { status = s; checkedAt = Date.now(); }, osHome: os.homedir };
