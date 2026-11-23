/**
 * winui.mjs - work desktop programs on Windows without the real mouse.
 *
 * Windows Home/Pro has one interactive desktop, so bots cannot each get a
 * screen of their own the way they do on Linux. What they can do is drive
 * programs through UI Automation (the accessibility API): press a button, set
 * a text box, read what a window says. None of that moves the pointer or takes
 * the keyboard focus from the human, and several bots can do it at once in
 * different windows.
 *
 * Zero dependencies: Windows PowerShell + the UIAutomationClient assembly.
 * The request goes in as base64 JSON in an environment variable and the
 * script is passed as -EncodedCommand, so nothing a model writes is ever
 * parsed as PowerShell.
 *
 * Two desktops (1.5.63, F11): with the bots' own account on (命令隔离), a
 * program a bot starts with the shell tool opens on the bots' own hidden
 * desktop, not the human's. desktop_ui then looks there too, through the
 * account (winrunner.mjs uiRunnerFor, the same lamplit-run.exe): "windows"
 * lists both, each window with desktop 'bots' or 'yours'; the other actions
 * look on the bots' desktop first, then on the human's.
 */

import { spawn } from 'node:child_process';
import { uiRunnerFor } from './winrunner.mjs';

export const WINUI_ACTIONS = ['windows', 'controls', 'click', 'type', 'read'];

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# Session 0 is where services run: no desktop, no windows to see.
# (Not for the bots' own desktop, 1.5.63: that one is where their programs are, in any session.)
if ((Get-Process -Id $PID).SessionId -eq 0 -and $env:DESK_WINUI_BOTS -ne '1') { throw "NO_DESKTOP" }
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DESK_WINUI)) | ConvertFrom-Json

# The bots' own hidden desktop (1.5.63): UI Automation sees nothing there (its desktop root is
# empty and it cannot reach the programs' providers off the input desktop, seen on Windows 11 and
# Server). The older accessibility interface (MSAA, oleacc) works, so this desktop is worked
# through it: top-level windows by EnumWindows, their controls by IAccessible.
if ($env:DESK_WINUI_BOTS -eq '1') {
  Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using Accessibility;
public static class LamplitBotsUi {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  // Not IsWindowVisible: off the input desktop it says false for every window (the desktop itself counts as hidden).
  static bool Shown(IntPtr h) { return (GetWindowLong(h, -16) & 0x10000000) != 0 && (GetWindowLong(h, -20) & 0x80) == 0; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object o);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible p, int start, int count, [Out] object[] kids, out int got);
  [DllImport("oleacc.dll")] static extern int WindowFromAccessibleObject(IAccessible a, out IntPtr h);
  [DllImport("oleacc.dll", CharSet = CharSet.Unicode)] static extern uint GetRoleText(uint role, StringBuilder s, uint n);
  public class Win { public string title; public uint pid; public IntPtr hwnd; }
  public class Node { public IAccessible acc; public object child; public string name; public string type; public int role; public bool enabled; public bool readOnly; public string value; }

  static string Title(IntPtr h) { StringBuilder b = new StringBuilder(512); GetWindowText(h, b, 512); return b.ToString(); }
  public static Win[] Windows() {
    List<Win> r = new List<Win>();
    EnumWindows((h, l) => { if (Shown(h)) { string t = Title(h); if (t.Length > 0) { uint pid; GetWindowThreadProcessId(h, out pid); Win w = new Win(); w.title = t; w.pid = pid; w.hwnd = h; r.Add(w); } } return true; }, IntPtr.Zero);
    return r.ToArray();
  }
  public static Win Find(string title) {
    Win[] all = Windows();
    foreach (Win w in all) if (w.title == title) return w;
    foreach (Win w in all) if (w.title.ToLowerInvariant().Contains((title ?? "").ToLowerInvariant())) return w;
    throw new Exception("NO_WINDOW");
  }
  static T Try<T>(Func<T> f, T fallback) { try { return f(); } catch { return fallback; } }
  static Node Make(IAccessible acc, object child) {
    Node n = new Node(); n.acc = acc; n.child = child;
    n.name = Try(() => acc.get_accName(child), null) ?? "";
    n.value = Try(() => acc.get_accValue(child), null) ?? "";
    object role = Try<object>(() => acc.get_accRole(child), null);
    n.role = role is int ? (int)role : 0;
    StringBuilder rt = new StringBuilder(64); if (n.role > 0) GetRoleText((uint)n.role, rt, 64); n.type = rt.ToString();
    object st = Try<object>(() => acc.get_accState(child), null);
    int s = st is int ? (int)st : 0;
    n.enabled = (s & 0x1) == 0; n.readOnly = (s & 0x40) != 0;
    return n;
  }
  static void Walk(IAccessible acc, List<Node> outList, int depth, int max) {
    if (outList.Count >= max || depth > 12) return;
    int count = Try(() => acc.accChildCount, 0);
    if (count <= 0) return;
    object[] kids = new object[count]; int got;
    if (AccessibleChildren(acc, 0, count, kids, out got) != 0) return;
    for (int i = 0; i < got && outList.Count < max; i++) {
      IAccessible k = kids[i] as IAccessible;
      Node n = k != null ? Make(k, 0) : kids[i] is int ? Make(acc, kids[i]) : null;
      if (n == null) continue;
      // A window's frame (title bar 1, scroll bar 3, size grip 4, its system menu bar 2): not the program's own controls.
      if (n.role == 1 || n.role == 3 || n.role == 4 || (n.role == 2 && depth > 0)) continue;
      // Bare containers (a child window 9, its client area 10): looked into, not listed.
      if (n.role != 9 && n.role != 10) outList.Add(n);
      if (k != null) Walk(k, outList, depth + 1, max);
    }
  }
  static void From(IntPtr hwnd, uint objid, List<Node> r, int max) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o;
    if (AccessibleObjectFromWindow(hwnd, objid, ref iid, out o) == 0 && o is IAccessible) Walk((IAccessible)o, r, objid == 0xFFFFFFFD ? 1 : 0, max);
  }
  /** The program's own controls: its menu bar (OBJID_MENU), then its client area (OBJID_CLIENT). */
  public static Node[] Nodes(IntPtr hwnd, int max) {
    List<Node> r = new List<Node>();
    From(hwnd, 0xFFFFFFFD, r, max);
    From(hwnd, 0xFFFFFFFC, r, max);
    return r.ToArray();
  }
  static bool Acts(Node n) { return Try(() => n.acc.get_accDefaultAction(n.child), null) != null; }
  public static Node Control(IntPtr hwnd, string target) {
    Node[] all = Nodes(hwnd, 2000);
    string t = (target ?? "").ToLowerInvariant();
    // Of the same name, one that does something first (a button over its label).
    foreach (Node n in all) if (n.name == target && Acts(n)) return n;
    foreach (Node n in all) if (n.name == target) return n;
    foreach (Node n in all) if (n.name.Length > 0 && n.name.ToLowerInvariant().Contains(t) && Acts(n)) return n;
    foreach (Node n in all) if (n.name.Length > 0 && n.name.ToLowerInvariant().Contains(t)) return n;
    throw new Exception("NO_CONTROL");
  }
  public static Node Click(IntPtr hwnd, string target) {
    Node n = Control(hwnd, target);
    try { n.acc.accDoDefaultAction(n.child); } catch { throw new Exception("NO_CLICK"); }
    return n;
  }
  public static Node Type(IntPtr hwnd, string target, string text) {
    Node n = null;
    if (!string.IsNullOrEmpty(target)) n = Control(hwnd, target);
    else { foreach (Node x in Nodes(hwnd, 2000)) if (x.role == 42 && x.enabled && !x.readOnly) { n = x; break; } }
    if (n == null) throw new Exception("NO_CONTROL");
    if (n.readOnly) throw new Exception("NO_TYPE");
    try { n.acc.set_accValue(n.child, text); if (Try(() => n.acc.get_accValue(n.child), null) == text) return n; } catch { }
    // A plain edit box: its own window takes the text.
    IntPtr h; if (n.child is int && (int)n.child == 0 && WindowFromAccessibleObject(n.acc, out h) == 0 && h != IntPtr.Zero && h != hwnd) { SendMessage(h, 0x000C, IntPtr.Zero, text); return n; }
    throw new Exception("NO_TYPE");
  }
}
'@
  $B = [LamplitBotsUi]
  $Info = { param($n) [ordered]@{ name = $n.name; type = $n.type; id = ''; enabled = $n.enabled } }
  $res = $null
  switch ($req.action) {
    'windows' { $res = @{ windows = @($B::Windows() | ForEach-Object { [ordered]@{ title = $_.title; pid = $_.pid } }) } }
    'controls' { $w = $B::Find($req.window); $res = @{ window = $w.title; controls = @($B::Nodes($w.hwnd, 400) | Where-Object { $_.name } | Select-Object -First 200 | ForEach-Object { & $Info $_ }) } }
    'click' { $w = $B::Find($req.window); $res = @{ clicked = (& $Info ($B::Click($w.hwnd, [string]$req.target))) } }
    'type' { $w = $B::Find($req.window); $res = @{ typed = (& $Info ($B::Type($w.hwnd, [string]$req.target, [string]$req.text))); length = ([string]$req.text).Length } }
    'read' {
      $w = $B::Find($req.window)
      $parts = @(); foreach ($n in $B::Nodes($w.hwnd, 2000)) { if ($n.value) { $parts += $n.value } elseif ($n.name) { $parts += $n.name } }
      $text = ($parts | Select-Object -Unique) -join [Environment]::NewLine
      if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) }
      $res = @{ window = $w.title; text = $text }
    }
    default { throw "BAD_ACTION" }
  }
  $res | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition
$root = $A::RootElement

function Info($e) {
  $c = $e.Current
  [ordered]@{ name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); id = $c.AutomationId; enabled = $c.IsEnabled }
}
function Win([string]$title) {
  $all = $root.FindAll($Scope::Children, $Any)
  foreach ($w in $all) { if ($w.Current.Name -eq $title) { return $w } }
  foreach ($w in $all) { if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($title.ToLower())) { return $w } }
  throw "NO_WINDOW"
}
function Find($w, [string]$target) {
  $all = $w.FindAll($Scope::Descendants, $Any)
  foreach ($e in $all) { $c = $e.Current; if ($c.AutomationId -eq $target -or $c.Name -eq $target) { return $e } }
  foreach ($e in $all) { $n = $e.Current.Name; if ($n -and $n.ToLower().Contains($target.ToLower())) { return $e } }
  throw "NO_CONTROL"
}
function Pattern($e, $p) {
  $o = $null
  if ($e.TryGetCurrentPattern($p, [ref]$o)) { return $o }
  return $null
}

$res = $null
switch ($req.action) {
  'windows' {
    $out = @()
    foreach ($w in $root.FindAll($Scope::Children, $Any)) {
      if ($w.Current.Name) { $out += [ordered]@{ title = $w.Current.Name; pid = $w.Current.ProcessId } }
    }
    $res = @{ windows = $out }
  }
  'controls' {
    $w = Win $req.window
    $out = @()
    foreach ($e in $w.FindAll($Scope::Descendants, $Any)) {
      $i = Info $e
      if ($i.name -or $i.id) { $out += $i; if ($out.Count -ge 200) { break } }
    }
    $res = @{ window = $w.Current.Name; controls = $out }
  }
  'click' {
    $e = Find (Win $req.window) $req.target
    $p = Pattern $e ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($p) { $p.Invoke() } else {
      $p = Pattern $e ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($p) { $p.Toggle() } else {
        $p = Pattern $e ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($p) { $p.Select() } else {
          $p = Pattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
          if ($p) { $p.Expand() } else { throw "NO_CLICK" }
        }
      }
    }
    $res = @{ clicked = (Info $e) }
  }
  'type' {
    $w = Win $req.window
    if ($req.target) { $e = Find $w $req.target } else {
      $e = $null
      foreach ($x in $w.FindAll($Scope::Descendants, $Any)) {
        if ((Pattern $x ([System.Windows.Automation.ValuePattern]::Pattern)) -and $x.Current.IsEnabled) { $e = $x; break }
      }
      if (-not $e) { throw "NO_CONTROL" }
    }
    $p = Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not $p -or $p.Current.IsReadOnly) { throw "NO_TYPE" }
    $p.SetValue([string]$req.text)
    $res = @{ typed = (Info $e); length = ([string]$req.text).Length }
  }
  'read' {
    $w = Win $req.window
    $parts = @()
    foreach ($e in $w.FindAll($Scope::Descendants, $Any)) {
      $v = Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      $t = if ($v) { $v.Current.Value } else { $e.Current.Name }
      if ($t) { $parts += $t }
    }
    $text = ($parts | Select-Object -Unique) -join [Environment]::NewLine
    if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) }
    $res = @{ window = $w.Current.Name; text = $text }
  }
  default { throw "BAD_ACTION" }
}
$res | ConvertTo-Json -Depth 5 -Compress
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');
/** The script for the bots' desktop: in an environment variable, run by a short fixed command line. */
export const SCRIPT_B64 = Buffer.from(SCRIPT, 'utf8').toString('base64');
export const BOOT_ENCODED = Buffer.from('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DESK_WINUI_SCRIPT))))', 'utf16le').toString('base64');

const MESSAGES = {
  NO_WINDOW: (r) => `找不到标题里含「${r.window}」的窗口。先用 windows 列出现在打开的窗口。`,
  NO_CONTROL: (r) => `窗口里找不到「${r.target || '可以输入的地方'}」。先用 controls 看看这个窗口里有哪些按钮和输入框。`,
  NO_CLICK: (r) => `「${r.target}」不支持在后台点击（这个程序没有提供无障碍接口）。`,
  NO_TYPE: (r) => `「${r.target || '这个输入框'}」不支持在后台输入，或者是只读的。`,
  BAD_ACTION: (r) => `不认识的操作：${r.action}`,
  NO_DESKTOP: () => '这台 Windows 的 Lamplit 在后台服务里运行，看不到桌面上的窗口。要操作桌面程序，请在登录后的桌面上运行 Lamplit。',
};

/**
 * Run one UI Automation request. -> parsed JSON result.
 * Throws an Error whose message is meant for the model (and the human).
 */
export async function runWinUi(request, { timeoutMs = 20000, signal, spawnImpl = spawn, bots = uiRunnerFor } = {}) {
  if (process.platform !== 'win32' && !spawnImpl.fake) {
    throw new Error('只有 Windows 机器能用这个工具；Linux 上每个机器人有自己的屏幕。');
  }
  const req = { ...request };
  if (!WINUI_ACTIONS.includes(req.action)) throw new Error(MESSAGES.BAD_ACTION(req));
  const encoded = Buffer.from(JSON.stringify(req), 'utf8').toString('base64');
  const theirs = typeof bots === 'function'
    ? bots({ DESK_WINUI: encoded, DESK_WINUI_SCRIPT: SCRIPT_B64, DESK_WINUI_BOTS: '1' }, BOOT_ENCODED) : null;
  const opts = { timeoutMs, signal, spawnImpl };
  if (!theirs) return once(req, encoded, null, opts);
  if (req.action === 'windows') {
    const [mine, botsOwn] = await Promise.allSettled([once(req, encoded, null, opts), once(req, encoded, theirs, opts)]);
    const list = (r, desktop) => (r.status === 'fulfilled' ? [].concat(r.value?.windows || []).map((w) => ({ ...w, desktop })) : []);
    const botsList = list(botsOwn, 'bots');
    const windows = [...botsList, ...list(mine, 'yours')];
    if (mine.status === 'rejected' && botsOwn.status === 'rejected') throw botsOwn.reason;
    // Always said how the bots' own desktop stands: looked and empty is not the same as could not look.
    return {
      windows,
      note: "desktop 'bots': programs your shell commands opened, on your own hidden desktop (the human does not see them); 'yours': the human's screen.",
      botsDesktop: botsOwn.status === 'rejected' ? `could not look there: ${botsOwn.reason.message}`
        : botsList.length ? `${botsList.length} window(s) open there` : 'nothing open there now (start a program with the shell tool first)',
    };
  }
  try {
    return { ...(await once(req, encoded, theirs, opts)), desktop: 'bots' };
  } catch (err) {
    if (err.code !== 'NO_WINDOW') throw err;
  }
  return { ...(await once(req, encoded, null, opts)), desktop: 'yours' };
}

/** One request on one desktop: the human's (runner null, as the hub) or the bots' (through lamplit-run.exe). */
function once(req, encoded, runner, { timeoutMs, signal, spawnImpl }) {
  // A hub running as a background service (session 0) sees no windows at all:
  // the script asks Windows for its own session and says NO_DESKTOP (an
  // environment variable such as SESSIONNAME is missing for perfectly normal
  // launches too, so it cannot tell).
  return new Promise((resolve, reject) => {
    const child = runner
      ? spawnImpl(runner.exe, runner.args || [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], {
        env: { ...process.env, DESK_WINUI: encoded },
        windowsHide: true,
      });
    if (runner) { child.stdin?.on?.('error', () => {}); child.stdin?.end?.(runner.input); }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error('桌面程序没有在 20 秒内响应。')); }, timeoutMs);
    const abort = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener?.('abort', abort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      if (code === 0) {
        try { resolve(JSON.parse(out.trim() || '{}')); } catch { reject(new Error(`桌面程序返回了看不懂的结果：${out.slice(0, 200)}`)); }
        return;
      }
      // PowerShell reports errors as CLIXML on stderr: keep the message lines only.
      if (err.includes('CLIXML')) {
        err = (err.match(/<S S="Error">([^<]*)<\/S>/g) || []).map((x) => x.replace(/<\/?S[^>]*>/g, '')).join('').replace(/_x000D__x000A_/g, '\n');
      }
      // lamplit-run.exe's own words (the bots' desktop): nothing ran there.
      const helper = /^LAMPLIT_RUNNER_(?:DESKTOP|START): (.*)$/m.exec(err);
      if (runner && helper) { reject(Object.assign(new Error(`机器人自己的桌面现在用不了：${helper[1].trim().slice(0, 200)}`), { code: 'BOTS_DESKTOP' })); return; }
      const key = Object.keys(MESSAGES).find((k) => err.includes(k) || out.includes(k));
      reject(Object.assign(new Error(key ? MESSAGES[key](req) : `操作桌面程序失败：${(err || out).trim().split('\n')[0].slice(0, 300)}`), { code: key || 'FAILED' }));
    });
  });
}
