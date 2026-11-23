/**
 * smoke-runner1563.mjs - 1.5.63 (F11): the bots' Windows account no longer shares the human's desktop.
 *
 * Until 1.5.62 lamplit-run.exe started a command as lamplit-runner without naming a desktop, so
 * Windows put it on WinSta0\Default next to the human's programs (and gave the account rights there):
 * it could list their windows, send them messages and keys, read the clipboard, set a keyboard hook,
 * and hand Chrome a command line. Now the command starts on a desktop of the bots' own
 * (lamplit-bots-<random>) in the window station Windows keeps for the logon session, not WinSta0.
 *
 *   RD1  the helper's source: a desktop of its own, no rights added on the human's, nothing runs when it fails
 *   RD2  the check's verdict: on only on the bots' desktop; 'blocked' when it cannot be made; commands then
 *        still go through the account (and are refused), never to the human
 *   RD3  (Windows) the helper compiles and, as this account (--as-me), runs a command on the bots' desktop:
 *        output, Chinese, exit code as before
 *   RD4  (Windows) from there a probe cannot see this test's window nor Chrome's kind of message window,
 *        cannot send it WM_COPYDATA, and its clipboard is not this desktop's. Control: the same probe started
 *        normally does see and reach them (so the probe would notice).
 *   RD5  (Windows) when the bots' desktop cannot be made, the command does not run (251)
 *   RD6  desktop_ui: with the account on, windows on both desktops; the other actions try the bots' first
 *   RD7  wiring: 体检, the settings box, English
 *   RD8  (CI only: GitHub Actions on Windows with LAMPLIT_CI_RUNNER_ACCOUNT=1) a throwaway local account
 *        runs the probe through the real path: none of the human's windows, message window, clipboard,
 *        foreground window, screen, window station or desktop; the 1.5.62 way (control) does reach them;
 *        Lamplit's own check says 'on'; a program it opens shows up for desktop_ui on the bots' desktop.
 *        It makes and removes a Windows account, so it never runs anywhere else.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const UNB64 = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

function compile(csc, src, out) {
  const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${out}`, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`csc ${path.basename(src)}: ${(r.stdout || r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  return out;
}

/** Run a program, its stdin given -> {code, out, err, raw (stdout's bytes)}. */
function runExe(exe, args, input, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const chunks = [];
    let err = '';
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    const done = (code, extra = '') => { clearTimeout(timer); const raw = Buffer.concat(chunks); resolve({ code, out: raw.toString('utf8'), err: err + extra, raw }); };
    child.stdout.on('data', (c) => { chunks.push(c); });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => done(-1, e.message));
    child.on('close', (code) => done(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const jsonLine = (text) => {
  const line = String(text).split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
};

/** The hub's side (runner-target.cs): a window and a message window to look for, answers on stdin. */
function startTarget(exe, args) {
  const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = [];
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiting.shift();
      if (w) w(line);
    }
  });
  const next = (timeoutMs = 60000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(''), timeoutMs);
    waiting.push((line) => { clearTimeout(t); resolve(line); });
  });
  return {
    ready: next(20000).then((line) => (line.startsWith('READY ') ? JSON.parse(line.slice(6)) : null)),
    ask: async (line, timeoutMs) => { const p = next(timeoutMs); child.stdin.write(`${line}\n`); return p; },
    stop: () => { try { child.stdin.end('quit\n'); } catch { /* gone */ } setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 3000).unref(); },
  };
}

export async function runnerDesktopChecks({ check, skip, readText }) {
  const W = await import('../src/winrunner.mjs');
  const src = W.HELPER_SOURCE;

  // RD1: what the helper does, by its source.
  check('RD1 helper: a desktop of the bots\' own in the logon session\'s window station (never WinSta0), named at random and kept in Lamplit\'s data, the account\'s one entry without listing or making desktops',
    src.includes('ws = CreateWindowStation(null, 0, access, ref wsa);') && src.includes('string.Equals(wsName, "WinSta0", StringComparison.OrdinalIgnoreCase)')
    && src.includes('"lamplit-bots-"') && src.includes('"lamplit-run.desktop"') && src.includes('const int RUNNER_WINSTA = 0x20376;')
    && (0x20376 & 0x1) === 0 && (0x20376 & 0x8) === 0 && (0x20376 & 0x40000) === 0 && src.includes('EnsureAce(ws, runner, RUNNER_WINSTA)'));
  check('RD1 helper: the command starts with lpDesktop set (so Windows adds no rights on the human\'s), suspended until it is in the job, and nothing runs when the desktop cannot be made',
    src.includes('si.lpDesktop = where;') && src.includes('CreateProcessWithLogonW(user, ".", pass, 0, cmdExe, cmdLine, flags, block, cwd, ref si, out pi)')
    && src.includes('CREATE_SUSPENDED') && src.indexOf('AssignProcessToJobObject(job, pi.hProcess)') < src.indexOf('ResumeThread(pi.hThread)')
    && /catch \(Exception e\) \{ Say\("LAMPLIT_RUNNER_DESKTOP: nothing ran[^;]*; return 251; \}/.test(src) && !src.includes('psi.Password'));
  check('RD1 helper: a desktop of that name someone else made is never used, and its access list is the human, SYSTEM and the account only',
    src.includes('if (d != null && d.Equals(owner)) break;') && src.includes('name = NewName();') && src.includes('"D:P(A;;GA;;;SY)(A;;GA;;;" + me.User.Value + ")"'));

  // RD2: the check's verdict.
  const bs = '\\';
  const ok = W.readCheck(`LAMPLIT_RUNNER_ON Service-0x0-1a2b$${bs}lamplit-bots-0011aabb\r\nPC${bs}lamplit-runner\r\nDATA-HIDDEN\r\nWORKSPACE-OK\r\n`);
  const onHumans = W.readCheck(`LAMPLIT_RUNNER_ON WinSta0${bs}lamplit-bots-0011aabb\nPC${bs}lamplit-runner\nDATA-HIDDEN\nWORKSPACE-OK`);
  const oldHelper = W.readCheck(`PC${bs}lamplit-runner\nDATA-HIDDEN\nWORKSPACE-OK`);
  const blocked = W.readCheck("LAMPLIT_RUNNER_DESKTOP: nothing ran - the bots' own Windows desktop could not be set up (CreateDesktop: x (8))");
  check('RD2 the check: on only when it ran on the bots\' own desktop; WinSta0 or no word of where (a 1.5.62 helper) is off; a desktop that cannot be made is blocked, said in plain words',
    ok.state === 'on' && onHumans.state === 'off' && oldHelper.state === 'off' && /自己的桌面/.test(oldHelper.reason) && blocked.state === 'blocked' && /都不会运行/.test(blocked.reason) && blocked.reason.includes('CreateDesktop'),
    JSON.stringify({ ok, onHumans, oldHelper, blocked }));
  const P = (await import('../src/store.mjs')).P;
  const runnerJson = path.join(P.dataDir, 'runner.json');
  const hadRunner = fs.existsSync(runnerJson);
  if (!hadRunner) {
    const { writeJsonSyncAtomic } = await import('../src/store.mjs');
    writeJsonSyncAtomic(runnerJson, { user: 'lamplit-test-nobody', password: 'not-a-real-one', home: path.join(os.tmpdir(), 'rd2-home'), granted: [] });
    try {
      W._test.setStatus({ state: 'blocked', reason: 'x' });
      const r = process.platform === 'win32' ? W.runnerFor('dir', { workspaceDir: os.tmpdir() }, {}) : 'n/a';
      W._test.setStatus({ state: 'off', reason: 'x' });
      const off = process.platform === 'win32' ? W.runnerFor('dir', { workspaceDir: os.tmpdir() }, {}) : null;
      check('RD2 blocked: a command still goes through lamplit-run.exe (which refuses it), never to the human; off (account not working) as before',
        process.platform !== 'win32' || (r && /lamplit-run\.exe$/.test(r.exe) && off === null));
    } finally {
      W._test.setStatus({ state: process.platform === 'win32' ? 'unknown' : 'na', reason: '' });
      fs.rmSync(runnerJson, { force: true });
    }
  } else skip('RD2 blocked routing', 'a runner.json is already in this data folder');

  // RD6: desktop_ui on two desktops (fake processes).
  const U = await import('../src/winui.mjs');
  const { EventEmitter } = await import('node:events');
  const calls = [];
  const fake = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = '';
    child.stdin = { on: () => {}, end: (s) => { input = s || ''; } };
    setTimeout(() => {
      const viaBots = cmd === 'helper.exe';
      const req = JSON.parse(UNB64(viaBots ? JSON.parse(input).DESK_WINUI : opts.env.DESK_WINUI));
      calls.push({ viaBots, action: req.action, window: req.window });
      if (req.action === 'windows') child.stdout.emit('data', JSON.stringify({ windows: [{ title: viaBots ? '无标题 - 记事本' : '你的微信', pid: viaBots ? 2 : 1 }] }));
      else if (viaBots && req.window !== '记事本') { child.stderr.emit('data', '#< CLIXML <S S="Error">NO_WINDOW_x000D__x000A_</S>'); child.emit('close', 1); return; }
      else child.stdout.emit('data', JSON.stringify({ window: req.window, text: viaBots ? 'bots' : 'yours' }));
      child.emit('close', 0);
    }, 5);
    return child;
  };
  fake.fake = true;
  const botsRoute = (env, boot) => ({ exe: 'helper.exe', input: JSON.stringify({ ...env, boot }) });
  const both = await U.runWinUi({ action: 'windows' }, { spawnImpl: fake, bots: botsRoute });
  const inBots = await U.runWinUi({ action: 'read', window: '记事本' }, { spawnImpl: fake, bots: botsRoute });
  const inYours = await U.runWinUi({ action: 'read', window: '微信' }, { spawnImpl: fake, bots: botsRoute });
  const humanOnly = await U.runWinUi({ action: 'read', window: '微信' }, { spawnImpl: fake, bots: () => null });
  check('RD6 desktop_ui: with the account on, "windows" lists the bots\' desktop and the human\'s, each marked; read/click/type look on the bots\' first, then the human\'s; without it only the human\'s, as before',
    both.windows.length === 2 && both.windows[0].desktop === 'bots' && both.windows[1].desktop === 'yours'
    && inBots.text === 'bots' && inBots.desktop === 'bots' && inYours.text === 'yours' && inYours.desktop === 'yours' && humanOnly.text === 'yours',
    JSON.stringify({ both, inBots, inYours, calls }));
  check('RD6 desktop_ui on the bots\' desktop: the request and the script travel in environment variables, the command line is fixed (nothing a model writes is parsed as PowerShell)',
    /^[A-Za-z0-9+/=]+$/.test(U.BOOT_ENCODED) && UNB64(U.SCRIPT_B64).includes("DESK_WINUI_ANY_SESSION -ne '1'")
    && (await readText('../src/winrunner.mjs')).includes('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${bootEncoded}'));

  // RD7: what the human sees.
  const server = await readText('../src/server.mjs');
  const apps = await readText('../public/app/main/09-apps.js');
  const en = await readText('../public/i18n-en.js');
  check('RD7 体检 and 设置 → 命令隔离: on says the hidden desktop; blocked says nothing runs and never as you; both in English too',
    server.includes("sb.state === 'blocked'") && server.includes("checkupItem('isolation', '命令隔离', 'bad', `机器人的命令现在都不会运行：")
    && apps.includes("else if (state === 'blocked') box.textContent = `机器人的命令现在都不会运行：") && apps.includes('它打开的程序也不会出现在你的屏幕上')
    && en.includes('"机器人的命令现在都不会运行：{0}。不会改用你的账户或你的桌面去跑。重启电脑通常就好了。"')
    && en.includes('在它自己的隐藏桌面上：碰不到你的个人文件夹和 Lamplit 的密钥，也看不到你的窗口、剪贴板和键盘。'));

  if (process.platform !== 'win32') {
    for (const id of ['RD3', 'RD4', 'RD5', 'RD8']) skip(`${id} the bots' desktop on Windows`, 'Windows only');
    return;
  }
  const csc = W.findCsc();
  if (!csc) { skip('RD3-RD8', 'no C# compiler from .NET Framework 4 on this machine'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner1563-'));
  try {
    // RD3: the helper itself, as this account.
    fs.writeFileSync(path.join(dir, 'lamplit-run.cs'), src);
    const helper = compile(csc, path.join(dir, 'lamplit-run.cs'), path.join(dir, 'lamplit-run.exe'));
    const probe = compile(csc, path.join(HERE, 'runner-probe.cs'), path.join(dir, 'probe.exe'));
    const target = compile(csc, path.join(HERE, 'runner-target.cs'), path.join(dir, 'target.exe'));
    const sysEnv = { SystemRoot: process.env.SystemRoot, windir: process.env.windir || process.env.SystemRoot, ComSpec: process.env.ComSpec, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
    const payload = (command, env = {}, user = 'me', password = '') => W.helperPayload({ user, password, cwd: dir, command, env: { ...sysEnv, ...env } });
    const r3 = await runExe(helper, ['--as-me', '--say-where'], payload('echo lamplit-rd3 灯窗 中文 & exit /b 7'));
    // The same command run the plain way: byte for byte the same output, whatever the code page (cmd's echo writes the ANSI one, which may turn the Chinese into '?'; tools.mjs decodes it). The ASCII marker is there on any locale.
    const direct = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"chcp 65001>nul & echo lamplit-rd3 灯窗 中文 & exit /b 7"'], { windowsVerbatimArguments: true, windowsHide: true });
    const where = ((/^LAMPLIT_RUNNER_ON (.+)$/m.exec(r3.err) || [])[1] || '').trim();
    check('RD3 as this account (--as-me) on the bots\' desktop: output (Chinese too) and the exit code come back as before; it ran on lamplit-bots-* outside WinSta0',
      r3.code === 7 && r3.raw.equals(direct.stdout) && r3.raw.includes('lamplit-rd3') && /^[^\\]+\\lamplit-bots-[0-9a-f]{16}$/.test(where) && !/^winsta0\\/i.test(where),
      JSON.stringify({ code: r3.code, out: r3.raw.toString('hex'), direct: direct.stdout.toString('hex'), where }));
    const r3b = await runExe(helper, ['--as-me', '--say-where'], payload('exit /b 0'));
    check('RD3 the same desktop for the next command (a program a bot left open is still there for desktop_ui)', r3b.err.includes(`LAMPLIT_RUNNER_ON ${where}`), r3b.err);

    // RD4: the probe on the bots' desktop vs. this test's windows.
    const marker = `lamplit-probe-${crypto.randomBytes(6).toString('hex')}`;
    const msgTitle = `C:\\lamplit-probe\\${marker}`;
    const t = startTarget(target, [marker, 'Chrome_MessageWindow', msgTitle]);
    const ready = await t.ready;
    if (!ready?.window || !ready?.messageWindow) { check('RD4 the test\'s windows were made', false, JSON.stringify(ready)); t.stop(); }
    else {
      const probeCmd = `"${probe}" ${marker} Chrome_MessageWindow "${msgTitle}" "${ready.winsta}" "${ready.desktop}"`;
      const r4 = await runExe(helper, ['--as-me'], payload(probeCmd, { LAMPLIT_PROBE_CLIP: '1' }));
      const seen = jsonLine(r4.out) || {};
      const clip = UNB64((await t.ask('clip')).replace(/^CLIP /, ''));
      check('RD4 from the bots\' desktop: not one window of this desktop (by title), no Chrome-style message window, no WM_COPYDATA to it, not its foreground window',
        seen.winsta && seen.winsta !== ready.winsta && /^lamplit-bots-/.test(seen.desktop) && seen.sawMarkerWindow === false && seen.messageWindowFound === false
        && seen.copyDataDelivered === false && seen.foregroundIsHubs === false, JSON.stringify({ seen, ready, err: r4.err.slice(0, 300) }));
      check('RD4 the clipboard: what a program writes on the bots\' desktop is not on this desktop\'s clipboard (each window station has its own)',
        seen.clipboardWritten === true && !clip.includes(`bots-${marker}`), JSON.stringify({ clipboardWritten: seen.clipboardWritten }));
      // Control: started normally (on this desktop), the same probe sees and reaches them. No clipboard here.
      const ctl = spawnSync(probe, [marker, 'Chrome_MessageWindow', msgTitle, ready.winsta, ready.desktop], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LAMPLIT_PROBE_CLIP: '' } });
      const ctlSeen = jsonLine(ctl.stdout) || {};
      const bye = JSON.parse((await t.ask('quit')).replace(/^BYE /, '') || '{}');
      check('RD4 control: the same probe on this desktop does find the window and the message window and delivers WM_COPYDATA (so the probe would notice a shared desktop)',
        ctlSeen.sawMarkerWindow === true && ctlSeen.messageWindowFound === true && ctlSeen.copyDataDelivered === true && bye.copyDataReceived === 1, JSON.stringify({ ctlSeen, bye }));
    }

    // RD5: no desktop, nothing runs.
    const dir5 = path.join(dir, 'broken');
    fs.mkdirSync(path.join(dir5, 'lamplit-run.desktop'), { recursive: true }); // where the name file goes: a folder
    fs.copyFileSync(helper, path.join(dir5, 'lamplit-run.exe'));
    const ran = path.join(dir, 'ran.txt');
    const r5 = await runExe(path.join(dir5, 'lamplit-run.exe'), ['--as-me'], payload(`echo x>"${ran}"`));
    check('RD5 when the bots\' desktop cannot be made: refused (251) with LAMPLIT_RUNNER_DESKTOP, and the command did not run',
      r5.code === 251 && /^LAMPLIT_RUNNER_DESKTOP: nothing ran/m.test(r5.err) && !fs.existsSync(ran), JSON.stringify(r5));

    // RD8: a real second account. CI only.
    if (process.env.LAMPLIT_CI_RUNNER_ACCOUNT === '1' && process.env.GITHUB_ACTIONS === 'true') await ciAccountChecks({ check, W, helper, probe, target, sysEnv });
    else skip('RD8 a throwaway Windows account through the real path', 'CI only: GitHub Actions on Windows with LAMPLIT_CI_RUNNER_ACCOUNT=1 (it makes and removes a local account)');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a program may still hold it */ }
  }
}

function ps(script, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** RD8: a throwaway local account on a CI machine (an administrator there), the real launch path. */
async function ciAccountChecks({ check, W, helper, probe, target, sysEnv }) {
  const user = `lamplit-ci-${crypto.randomBytes(3).toString('hex')}`;
  const password = `Lp-${crypto.randomBytes(18).toString('base64url')}9!`;
  const box = path.join(process.env.SystemDrive || 'C:', `lamplit-ci-${crypto.randomBytes(4).toString('hex')}`);
  const made = ps("$ErrorActionPreference='Stop'; New-LocalUser -Name $env:LU -Password (ConvertTo-SecureString $env:LP -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires | Out-Null; Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $env:LU; (Get-LocalUser -Name $env:LU).SID.Value", { LU: user, LP: password });
  const sid = (made.out.match(/S-1-5-21-[\d-]+/) || [])[0];
  if (made.code !== 0 || !sid) { check('RD8 a throwaway account was made', false, made.out.slice(0, 300)); return; }
  const P = (await import('../src/store.mjs')).P;
  const { writeJsonSyncAtomic } = await import('../src/store.mjs');
  const runnerJson = path.join(P.dataDir, 'runner.json');
  let t = null;
  try {
    // Its folder: the probe, a workspace, a home - the account may change them (as Lamplit grants the workspace).
    const ws = path.join(box, 'workspace');
    const home = path.join(box, 'home');
    for (const d of [ws, path.join(home, 'Temp'), path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
    const probeHere = path.join(box, 'probe.exe');
    fs.copyFileSync(probe, probeHere);
    spawnSync('icacls', [box, '/grant', `${user}:(OI)(CI)M`, '/Q'], { windowsHide: true });
    const env = W.runnerEnv({ ...sysEnv }, { home, userProfile: process.env.USERPROFILE || '' });
    const viaHelper = (command, extra = {}) => runExe(helper, ['--say-where'], W.helperPayload({ user, password, cwd: ws, command, env: { ...env, ...extra } }), 120000);

    const marker = `lamplit-probe-${crypto.randomBytes(6).toString('hex')}`;
    const msgTitle = `C:\\lamplit-probe\\${marker}`;
    t = startTarget(target, [marker, 'Chrome_MessageWindow', msgTitle, '--winsta0', '--visible', '--clipboard']);
    const ready = await t.ready;
    console.log(`      RD8 the hub's side: ${JSON.stringify(ready)}`);
    if (!ready?.window) { check('RD8 the test\'s windows were made', false, JSON.stringify(ready)); return; }
    const probeCmd = `"${probeHere}" ${marker} Chrome_MessageWindow "${msgTitle}" "${ready.winsta}" "${ready.desktop}" ${ready.x} ${ready.y}`;
    const sameWinsta = (seen) => String(seen.winsta || '').toLowerCase() === String(ready.winsta).toLowerCase();
    // A signed-in human's programs are on WinSta0. If this CI runner could not put the hub's side there
    // (a service that may not), the hub's side is in the service's own window station, which is the
    // one the bots get too: the window-station checks (clipboard) then say nothing and are skipped.
    const hubInteractive = /^winsta0$/i.test(ready.winsta);
    if (!hubInteractive) console.log(`SKIP  RD8 window-station checks (the hub's side is on ${ready.winsta}, not WinSta0: no signed-in desktop to compare with)`);

    // The new path.
    const r1 = await viaHelper(probeCmd, { LAMPLIT_PROBE_CLIP: '1' });
    const a = jsonLine(r1.out) || {};
    console.log(`      RD8 new path: ${JSON.stringify(a)} ${r1.err.split('\n')[0]}`);
    check('RD8a as the account, through lamplit-run.exe: it is that account, on lamplit-bots-*, in another window station than the hub\'s',
      String(a.account || '').toLowerCase().endsWith(`\\${user}`) && /^lamplit-bots-/.test(a.desktop || '') && (!hubInteractive || !sameWinsta(a)) && !/^winsta0$/i.test(a.winsta || ''), JSON.stringify({ a, err: r1.err.slice(0, 400) }));
    check('RD8a none of the hub\'s windows, no Chrome-style message window and no WM_COPYDATA to it, not the foreground window, not the hub\'s clipboard',
      a.sawMarkerWindow === false && a.messageWindowFound === false && a.copyDataDelivered === false && a.foregroundIsHubs === false && (!hubInteractive || a.clipboardHasHubMarker === false), JSON.stringify(a));
    check('RD8a it cannot get onto the hub\'s window station and desktop (so no keyboard hook, message or screenshot there either)',
      !(a.openedHubWinsta && a.openedHubDesktop), JSON.stringify(a));
    if (ready.pixel === '0000ff') check('RD8a the screen: where the hub painted red, the account\'s screen is not', a.pixel !== '0000ff', JSON.stringify({ a: a.pixel, hub: ready.pixel }));
    else console.log(`SKIP  RD8a the screen (the hub's own screen does not show its square here: ${ready.pixel || 'no screen'})`);
    const clip = UNB64((await t.ask('clip')).replace(/^CLIP /, ''));
    if (hubInteractive) check('RD8b what the account writes on its clipboard is not on the hub\'s', !clip.includes(`bots-${marker}`) && clip.includes(marker), JSON.stringify({ clip: clip.slice(0, 80) }));

    // Control: the way 1.5.62 started it (.NET, no desktop named) does reach the hub's desktop.
    const old = await t.ask(`old ${B64(user)} ${B64(password)} ${B64(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'))} ${B64(`/d /s /c "${probeCmd}"`)} ${B64(ws)}`, 120000);
    const o = jsonLine(UNB64(old.replace(/^OLD /, ''))) || {};
    console.log(`      RD8 1.5.62 way: ${JSON.stringify(o)}`);
    check('RD8c control: started the 1.5.62 way, the same account is on the hub\'s desktop and sees its window (this is F11; the probe notices it)',
      o.sawMarkerWindow === true && o.desktop === ready.desktop, JSON.stringify(o));
    const acl = (await t.ask(`acl ${B64(sid)}`)).replace(/^ACL /, '');
    console.log(`      RD8 the hub's window station after the 1.5.62 way: ${acl} (entries Windows added: for the account itself, or for that one logon)`);
    const r2 = await viaHelper(probeCmd);
    const b = jsonLine(r2.out) || {};
    check('RD8d after a 1.5.62-way start (an update from 1.5.62 without a restart), a new command still cannot get onto the hub\'s window station and desktop',
      !(b.openedHubWinsta && b.openedHubDesktop) && b.sawMarkerWindow === false, JSON.stringify(b));

    // Lamplit's own check, and a program it opens, seen by desktop_ui on the bots' desktop.
    writeJsonSyncAtomic(runnerJson, { user, password, home, granted: [] });
    const st = await W.checkRunner({ workspaceDir: ws });
    check('RD8e Lamplit\'s own check with this account: on (its data hidden, the workspace writable, on the bots\' own desktop)', st.state === 'on', JSON.stringify(st));
    // A window of its own (a plain WinForms form, titled with a marker), left open in the background.
    const formTitle = `lamplit-form-${crypto.randomBytes(4).toString('hex')}`;
    const opened = await viaHelper(`start "" powershell.exe -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${formTitle}'; [Windows.Forms.Application]::Run($f)" & ping -n 6 127.0.0.1 >nul & echo started`);
    const U = await import('../src/winui.mjs');
    let listed = null;
    try { listed = await U.runWinUi({ action: 'windows' }, { timeoutMs: 60000 }); } catch (err) { listed = { error: err.message }; }
    const titled = (desk) => (listed?.windows || []).filter((w) => w.desktop === desk && String(w.title || '').includes(formTitle));
    check('RD8f a window the account opened is on the bots\' desktop for desktop_ui (UI Automation there, as the account), and not on the hub\'s',
      /started/.test(opened.out) && titled('bots').length === 1 && titled('yours').length === 0, JSON.stringify({ listed, opened: opened.out.slice(0, 200) }));
    let read = null;
    try { read = await U.runWinUi({ action: 'controls', window: formTitle }, { timeoutMs: 60000 }); } catch (err) { read = { error: err.message }; }
    check('RD8f desktop_ui works that window there (controls, as the account on the bots\' desktop)', read?.desktop === 'bots' && String(read?.window || '').includes(formTitle), JSON.stringify(read));
  } finally {
    t?.stop();
    fs.rmSync(runnerJson, { force: true });
    W._test.setStatus({ state: 'unknown', reason: '' });
    spawnSync('taskkill', ['/f', '/im', '*', '/fi', `USERNAME eq ${user}`], { windowsHide: true });
    ps('Remove-LocalUser -Name $env:LU', { LU: user });
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { /* still held */ }
  }
}
