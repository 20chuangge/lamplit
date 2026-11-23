// runner-target.cs - the hub's side of scripts/smoke-runner1563.mjs (1.5.63, F11): a window and a
// Chrome-style message window for runner-probe.cs to look for, and (CI only) a marker on the
// clipboard and a painted square on the screen.
//   target.exe <marker> <messageWindowClass> <messageWindowTitle> [--winsta0] [--visible] [--clipboard]
// --winsta0: when this runs as a service (CI), first move onto WinSta0\Default, where a signed-in
// human's programs are. Prints "READY {json}", then answers lines on stdin:
//   old <b64 user> <b64 password> <b64 program> <b64 arguments> <b64 folder>  -> OLD <b64 output>
//       (a program as that account the way lamplit-run.exe 1.5.62 started it: .NET, no desktop named)
//   clip -> CLIP <b64 clipboard text>      acl <b64 sid> -> ACL {json}      quit -> BYE {json}
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Target {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WndClass {
    public int cbSize; public uint style; public WndProc lpfnWndProc; public int cbClsExtra, cbWndExtra;
    public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string lpszMenuName, lpszClassName; public IntPtr hIconSm;
  }
  [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassEx(ref WndClass c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMessage(out Msg m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg m);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DispatchMessage(ref Msg m);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr h);
  [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint c);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder b, int n, out int need);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenWindowStation(string n, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenDesktop(string n, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectSecurity(IntPtr h, ref int si, byte[] sd, int len, out int need);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);

  static int copyData = 0;
  static WndProc proc = Proc;
  static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) { if (m == 0x4A) { Interlocked.Increment(ref copyData); return new IntPtr(1); } return DefWindowProc(h, m, w, l); }
  static string Name(IntPtr h) { StringBuilder b = new StringBuilder(256); int n; GetUserObjectInformation(h, 2, b, 512, out n); return b.ToString(); }
  static string B(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? "")); }
  static string U(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }
  static string J(string s) {
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s ?? "") { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
    return b.Append('"').ToString();
  }
  static string ReadClipboard() {
    if (!OpenClipboard(IntPtr.Zero)) return null;
    try { IntPtr h = GetClipboardData(13); if (h == IntPtr.Zero) return ""; IntPtr p = GlobalLock(h); try { return Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); } }
    finally { CloseClipboard(); }
  }
  static bool WriteClipboard(string text) {
    if (!OpenClipboard(IntPtr.Zero)) return false;
    try {
      EmptyClipboard();
      byte[] b = Encoding.Unicode.GetBytes(text + "\0");
      IntPtr h = GlobalAlloc(2, (UIntPtr)b.Length);
      Marshal.Copy(b, 0, GlobalLock(h), b.Length);
      GlobalUnlock(h);
      return SetClipboardData(13, h) != IntPtr.Zero;
    } finally { CloseClipboard(); }
  }

  static int Main(string[] a) {
    string marker = a[0], cls = a[1], title = a[2];
    bool toWinsta0 = Array.IndexOf(a, "--winsta0") >= 0, visible = Array.IndexOf(a, "--visible") >= 0, clip = Array.IndexOf(a, "--clipboard") >= 0;
    bool moved = false;
    IntPtr desk = GetThreadDesktop(GetCurrentThreadId());
    if (toWinsta0 && !string.Equals(Name(GetProcessWindowStation()), "WinSta0", StringComparison.OrdinalIgnoreCase)) {
      IntPtr ws = OpenWindowStation("WinSta0", false, 0x37F | 0x20000);
      if (ws == IntPtr.Zero) ws = OpenWindowStation("WinSta0", false, 0x166 | 0x20000);
      if (ws != IntPtr.Zero && SetProcessWindowStation(ws)) {
        IntPtr d = OpenDesktop("Default", 0, false, 0x1C7 | 0x20000);
        if (d != IntPtr.Zero && SetThreadDesktop(d)) { desk = d; moved = true; }
      }
    }
    IntPtr top = IntPtr.Zero, msgWin = IntPtr.Zero;
    ManualResetEvent ready = new ManualResetEvent(false);
    IntPtr uiDesk = desk;
    Thread ui = new Thread(() => {
      SetThreadDesktop(uiDesk);
      IntPtr inst = GetModuleHandle(null);
      WndClass c = new WndClass(); c.cbSize = Marshal.SizeOf(typeof(WndClass)); c.lpfnWndProc = proc; c.hInstance = inst;
      c.hbrBackground = CreateSolidBrush(0x0000FF); c.lpszClassName = "LamplitProbeTop";
      RegisterClassEx(ref c);
      WndClass m = new WndClass(); m.cbSize = Marshal.SizeOf(typeof(WndClass)); m.lpfnWndProc = proc; m.hInstance = inst; m.lpszClassName = cls;
      RegisterClassEx(ref m);
      // WS_POPUP (| WS_VISIBLE), WS_EX_TOPMOST | WS_EX_TOOLWINDOW
      top = CreateWindowEx(0x8 | 0x80, "LamplitProbeTop", marker, 0x80000000 | (visible ? 0x10000000u : 0u), 40, 40, 200, 200, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
      if (visible) { UpdateWindow(top); SetForegroundWindow(top); }
      msgWin = CreateWindowEx(0, cls, title, 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, inst, IntPtr.Zero);
      ready.Set();
      Msg msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    });
    ui.IsBackground = true;
    ui.Start();
    ready.WaitOne();
    Thread.Sleep(visible ? 800 : 50);
    bool clipSet = clip && WriteClipboard(marker);
    string pixel = "";
    if (visible) { IntPtr dc = GetDC(IntPtr.Zero); if (dc != IntPtr.Zero) pixel = GetPixel(dc, 100, 100).ToString("x6"); }
    Console.WriteLine("READY {\"winsta\":" + J(Name(GetProcessWindowStation())) + ",\"desktop\":" + J(Name(desk)) + ",\"moved\":" + (moved ? "true" : "false")
      + ",\"window\":" + (top != IntPtr.Zero ? "true" : "false") + ",\"messageWindow\":" + (msgWin != IntPtr.Zero ? "true" : "false")
      + ",\"clipboardSet\":" + (clipSet ? "true" : "false") + ",\"pixel\":" + J(pixel) + ",\"x\":100,\"y\":100}");
    string line;
    while ((line = Console.ReadLine()) != null) {
      string[] p = line.Split(' ');
      if (p[0] == "old") {
        string output;
        try {
          ProcessStartInfo psi = new ProcessStartInfo(U(p[3]), U(p[4]));
          psi.UserName = U(p[1]); psi.Domain = ".";
          SecureString s = new SecureString(); foreach (char ch in U(p[2])) s.AppendChar(ch); psi.Password = s;
          psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.LoadUserProfile = false; psi.WorkingDirectory = U(p[5]);
          psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
          psi.EnvironmentVariables["LAMPLIT_PROBE_CLIP"] = "1";
          Process child = Process.Start(psi);
          output = child.StandardOutput.ReadToEnd() + child.StandardError.ReadToEnd();
          child.WaitForExit();
        } catch (Exception e) { output = "START FAILED: " + e.Message; }
        Console.WriteLine("OLD " + B(output));
      } else if (p[0] == "clip") {
        Console.WriteLine("CLIP " + B(ReadClipboard()));
      } else if (p[0] == "acl") {
        SecurityIdentifier who = new SecurityIdentifier(U(p[1]));
        int si = 4, need; byte[] b = new byte[0];
        GetUserObjectSecurity(GetProcessWindowStation(), ref si, null, 0, out need);
        b = new byte[Math.Max(need, 1)];
        bool ok = GetUserObjectSecurity(GetProcessWindowStation(), ref si, b, b.Length, out need);
        int account = 0, logon = 0;
        if (ok) foreach (GenericAce g in new RawSecurityDescriptor(b, 0).DiscretionaryAcl) {
          KnownAce k = g as KnownAce; if (k == null) continue;
          if (k.SecurityIdentifier.Equals(who)) account++;
          else if (k.SecurityIdentifier.Value.StartsWith("S-1-5-5-")) logon++;
        }
        Console.WriteLine("ACL {\"read\":" + (ok ? "true" : "false") + ",\"accountEntries\":" + account + ",\"logonSidEntries\":" + logon + "}");
      } else if (p[0] == "quit") {
        Console.WriteLine("BYE {\"copyDataReceived\":" + copyData + "}");
        return 0;
      }
    }
    return 0;
  }
}
