// runner-probe.cs - what a program on the bots' desktop can reach of the hub's (1.5.63, F11).
// Compiled by scripts/smoke-runner1563.mjs with Windows' own C# compiler; it only looks:
// it types nothing and sends nothing but one WM_COPYDATA to the test's own message window
// (the way a second chrome.exe hands its command line to the running browser), and, only with
// LAMPLIT_PROBE_CLIP=1, a marker on its own window station's clipboard.
//   probe.exe <marker> <messageWindowClass> <messageWindowTitle> <hubWinsta> <hubDesktop> [<x> <y>]
// Output: one JSON line.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

static class Probe {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, ref CopyData l, uint f, uint t, out IntPtr r);
  [StructLayout(LayoutKind.Sequential)] struct CopyData { public IntPtr dwData; public int cbData; public IntPtr lpData; }
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, IntPtr fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder b, int n, out int need);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenWindowStation(string n, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenDesktop(string n, uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);

  static string Name(IntPtr h) { StringBuilder b = new StringBuilder(256); int n; GetUserObjectInformation(h, 2, b, 512, out n); return b.ToString(); }
  static string J(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
    return b.Append('"').ToString();
  }
  static string ReadClipboard() {
    if (!OpenClipboard(IntPtr.Zero)) return null;
    try {
      IntPtr h = GetClipboardData(13);
      if (h == IntPtr.Zero) return "";
      IntPtr p = GlobalLock(h);
      try { return Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); }
    } finally { CloseClipboard(); }
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
    string marker = a[0], cls = a[1], title = a[2], hubWinsta = a[3], hubDesktop = a[4];
    var o = new List<string>();
    o.Add("\"account\":" + J(WindowsIdentity.GetCurrent().Name));
    o.Add("\"winsta\":" + J(Name(GetProcessWindowStation())));
    o.Add("\"desktop\":" + J(Name(GetThreadDesktop(GetCurrentThreadId()))));
    // 1. The hub's windows (visible or not) by their title.
    int all = 0; bool saw = false;
    EnumWindows((h, l) => { all++; StringBuilder t = new StringBuilder(300); GetWindowText(h, t, 300); if (t.ToString().Contains(marker)) saw = true; return true; }, IntPtr.Zero);
    o.Add("\"windows\":" + all);
    o.Add("\"sawMarkerWindow\":" + (saw ? "true" : "false"));
    // 2. Chrome's hand-off: find the running browser's message window by class and profile path, send it a command line.
    IntPtr mw = FindWindowEx(new IntPtr(-3), IntPtr.Zero, cls, title);
    o.Add("\"messageWindowFound\":" + (mw != IntPtr.Zero ? "true" : "false"));
    bool delivered = false;
    if (mw != IntPtr.Zero) {
      byte[] b = Encoding.Unicode.GetBytes("file:///C:/probe-" + marker + "\0");
      CopyData cd = new CopyData(); cd.dwData = new IntPtr(0x4C50); cd.cbData = b.Length; cd.lpData = Marshal.AllocHGlobal(b.Length);
      Marshal.Copy(b, 0, cd.lpData, b.Length);
      IntPtr r;
      delivered = SendMessageTimeout(mw, 0x4A, IntPtr.Zero, ref cd, 2, 2000, out r) != IntPtr.Zero;
    }
    o.Add("\"copyDataDelivered\":" + (delivered ? "true" : "false"));
    // 3. The foreground window: whose is it?
    IntPtr fg = GetForegroundWindow(); StringBuilder ft = new StringBuilder(300); if (fg != IntPtr.Zero) GetWindowText(fg, ft, 300);
    o.Add("\"foregroundIsHubs\":" + (ft.ToString().Contains(marker) ? "true" : "false"));
    // 4. The clipboard: the hub's marker there? Then leave one of ours for the hub to look for.
    string clip = ReadClipboard();
    o.Add("\"clipboardOpened\":" + (clip != null ? "true" : "false"));
    o.Add("\"clipboardHasHubMarker\":" + (clip != null && clip.Contains(marker) ? "true" : "false"));
    // Only where asked (LAMPLIT_PROBE_CLIP=1): a test run on someone's own computer never touches a clipboard they use.
    if (Environment.GetEnvironmentVariable("LAMPLIT_PROBE_CLIP") == "1") o.Add("\"clipboardWritten\":" + (WriteClipboard("bots-" + marker) ? "true" : "false"));
    // 5. A low-level keyboard hook: set and removed at once (it hooks only this desktop's input).
    IntPtr hook = SetWindowsHookEx(13, GetModuleHandle(null), GetModuleHandle(null), 0);
    o.Add("\"keyboardHookSet\":" + (hook != IntPtr.Zero ? "true" : "false"));
    if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
    // 6. Getting onto the hub's window station and desktop.
    IntPtr ws = OpenWindowStation(hubWinsta, false, 0x0001 | 0x0002 | 0x0004 | 0x0100);
    o.Add("\"openedHubWinsta\":" + (ws != IntPtr.Zero ? "true" : "false"));
    bool openedDesk = false;
    if (ws != IntPtr.Zero) {
      IntPtr before = GetProcessWindowStation();
      if (SetProcessWindowStation(ws)) {
        IntPtr d = OpenDesktop(hubDesktop, 0, false, 0x0001 | 0x0002 | 0x0008 | 0x0040);
        openedDesk = d != IntPtr.Zero;
        if (openedDesk) CloseDesktop(d);
        SetProcessWindowStation(before);
      }
      CloseWindowStation(ws);
    }
    o.Add("\"openedHubDesktop\":" + (openedDesk ? "true" : "false"));
    // 7. The screen: one pixel where the hub painted its window (CI only).
    if (a.Length >= 7) {
      IntPtr dc = GetDC(IntPtr.Zero);
      o.Add("\"pixel\":" + (dc == IntPtr.Zero ? "null" : J(GetPixel(dc, int.Parse(a[5]), int.Parse(a[6])).ToString("x6"))));
    }
    Console.WriteLine("{" + string.Join(",", o.ToArray()) + "}");
    return 0;
  }
}
