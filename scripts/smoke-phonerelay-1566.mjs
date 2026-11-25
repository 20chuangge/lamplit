// 1.5.66: the phone reaches a machine through the relay when the address it paired at is dead.
// Seen 11-23: the phone was paired with the cloud machine at a Tailscale address the machine no longer had;
// Tailscale was off on the phone; it tried that address every minute (22 timeouts in 25 min) and never the
// relay, because it knew machines by address only. The bots on the cloud then lost the phone and were told
// 「让机器人用这部手机」 was off, so one sent the human to battery settings. Now:
//   - PhoneRoutes.java matches a machine by its relay id, then an address, then its name, and keeps the relay
//     as the way when the paired address is out of reach (run here on a desktop JDK, like direct-interop.mjs);
//   - fleet sync refreshes a paired machine's addresses and relay instead of pairing it a second time;
//   - the relay forwarder tries again when the relay closed the handshake (the machine was restarting);
//   - the bots are told plainly: not connected to this machine (last seen N min ago), or the system
//     disconnected the service - never "the human turned it off" when the setting is still on.
// Nothing here talks to a real phone. Called from smoke.mjs as stages.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'desk', 'assistant');

function jdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of [process.env.LAMPLIT_JDK, process.env.JAVA_HOME].filter(Boolean)) {
    const p = path.join(dir, 'bin', exe);
    if (fs.existsSync(p)) return p;
  }
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : '';
}

/** A top-level function of a script, as source (two-space indented, as in launcher.js). */
function nestedFn(src, name) {
  const m = new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`).exec(src);
  return m ? m[0] : '';
}

// --- PhoneRoutes.java on a desktop JDK --------------------------------------------------------------
export async function routeChecks({ check, skip }) {
  const javac = jdkTool('javac');
  const java = jdkTool('java');
  if (!javac || !java) {
    skip('PR66-1 PhoneRoutes.java on a desktop JDK', 'no JDK: set LAMPLIT_JDK or JAVA_HOME (the Android build compiles the same file)');
    return;
  }
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-phoneroutes-'));
  try {
    const built = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, path.join(JAVA, 'PhoneRoutes.java'), path.join(REPO, 'scripts', 'java', 'PhoneRoutesCheck.java')], { encoding: 'utf8' });
    check('PR66-1 PhoneRoutes.java compiles with a desktop JDK (no Android classes in it)', built.status === 0, built.stderr);
    if (built.status !== 0) return;
    const ran = spawnSync(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', classes, 'com.desk.assistant.PhoneRoutesCheck'], { encoding: 'utf8' });
    let r = {};
    try { r = JSON.parse(ran.stdout); } catch { /* checked below */ }
    const OLD_TS = 'http://100.64.0.1:4390';
    const RELAY = 'http://127.0.0.1:14441';
    check('PR66-2 the machine paired at an address it no longer has is found by name in another machine\'s list (the 11-23 case), by its relay id, or by an address in common',
      r.staleByName === OLD_TS && r.byRelayId === OLD_TS && r.byAddress === OLD_TS, `${ran.stdout}\n${ran.stderr}`);
    check('PR66-3 a name is not enough when it could be another machine: two machines of that name, another relay id, its login refused there before, a row named after its address, a hub that is another machine of the list',
      r.nameTwiceInList === null && r.nameButAnotherRelayId === null && r.refusedByName === null && r.addressLabelIsNoName === null && r.nameOnAnotherMachinesAddress === null
      && r.nameKeys === '|cafe||cloud', JSON.stringify(r));
    check('PR66-4 at home nothing changes: the PC\'s LAN address is used after one quick probe (none at all without a relay)',
      r.homeWay === 'http://192.168.50.10:4390' && r.homeProbes === 'http://192.168.50.10:4390' && r.homeNoRelayWay === 'http://192.168.50.10:4390' && r.homeNoRelayProbes === 0, JSON.stringify(r));
    check('PR66-5 Tailscale off: straight to the relay, no Tailscale address probed; the relay stays the way while it does not answer yet (not the dead address)',
      r.awayWay === RELAY && r.awayProbes === RELAY && r.relayDownWay === RELAY, JSON.stringify(r));
    check('PR66-6 Tailscale on: the machine\'s newer Tailscale address before the relay; nothing answering with Tailscale on keeps the paired address (as before)',
      r.newTailnetWay === 'http://100.64.0.2:4390' && r.tailscaleOnNothingAnswers === OLD_TS, JSON.stringify(r));
    check('PR66-7 the order stays: the same Wi-Fi first, another Wi-Fi\'s LAN address skipped, a phone paired through the relay stays on it, a public http address is never a way (the login would go in the clear)',
      r.sameWifiWay === 'http://192.168.50.20:4390' && r.otherWifiLanSkipped === `${RELAY}|${RELAY}` && r.pairedAtRelay === `${RELAY}|0` && r.publicNotUsed === `${OLD_TS}|0`, JSON.stringify(r));
    // 1.5.67: one hub per machine (PhoneRoutes.active).
    const PC = 'http://192.168.50.10:4390';
    check('PH67-0 one hub per machine: a dead login folded into its working hub is not watched on its own; back on its own when that hub loses its login; folds that loop or chain do not hide a hub that is not folded',
      r.activeFolded === `${PC},${RELAY}` && r.activeTargetGone === `${PC},${OLD_TS}` && r.activeLoop === `${PC},${OLD_TS},${RELAY}`
      && r.activeChain === `${PC},${RELAY}` && r.activeNone === `${PC},${OLD_TS},${RELAY}`, JSON.stringify(r));
  } finally {
    fs.rmSync(classes, { recursive: true, force: true });
  }
}

// --- what the bots are told (the hub) ---------------------------------------------------------------
export async function hubMessageChecks({ check, readText }) {
  const PL = await import('../src/phonelink.mjs');
  const PH = await import('../src/phone.mjs');
  const bus = { emit() {}, subscribe: () => () => {} };
  const realNow = Date.now;
  try {
    // Gone for more than 150 s.
    const link = PL.createPhoneLink({ bus, freshMs: 150000 });
    link.register('dev-cloud', { enabled: true, model: 'OPPO X', phoneId: 'ph_1' });
    Date.now = () => realNow() + 6 * 60000;
    const exec = PL.makePhoneExec({ adbPath: () => '', link });
    const why = exec.whyGone();
    const phone = PH.createPhone({ adb: () => 'lamplit', exec, workspaceDir: os.tmpdir() });
    const st = await phone.act('status', {});
    let lookErr = null;
    try { await phone.act('look', {}); } catch (err) { lookErr = err; }
    check('PR66-8 a phone not heard from for over 150 s reads as "not connected to this machine right now (last seen N min ago)", says the app retries through the relay and what the human can do - not "screen off", not a setting to change',
      why.includes('is not connected to this machine right now (last seen 6 min ago)') && why.includes('through the relay') && why.includes('open Lamplit on the phone once')
      && !/screen is probably off|put Lamplit to sleep|keep running in the background|is off on it/.test(why), why);
    check('PR66-9 status with no phone says why instead of a bare "no devices"; a step says the same with PHONE_NOT_CONNECTED',
      Array.isArray(st.devices) && st.devices.length === 0 && /not connected to this machine right now/.test(st.note || '')
      && lookErr?.code === 'PHONE_NOT_CONNECTED' && /not connected to this machine right now \(last seen 6 min ago\)/.test(lookErr.message), JSON.stringify({ st, code: lookErr?.code, msg: lookErr?.message }));
    Date.now = realNow;

    // The same phone, back through another of its logins: not "not connected".
    const two = PL.createPhoneLink({ bus, freshMs: 150000 });
    two.register('dev-old', { enabled: true, model: 'OPPO X', phoneId: 'ph_1' });
    Date.now = () => realNow() + 6 * 60000;
    two.register('dev-relay', { enabled: false, listed: true, model: 'OPPO X', phoneId: 'ph_1' });
    const twoWhy = PL.makePhoneExec({ adbPath: () => '', link: two }).whyGone();
    Date.now = realNow;
    check('PR66-10 the service disconnected by the system (still on in its settings): said as such - "the human did not turn it off", open Lamplit or switch it off and on; a stale second login of the same phone does not hide it',
      /still switched on/.test(twoWhy) && /not connected yet/.test(twoWhy) && /nobody turned it off/.test(twoWhy) /* 1.5.67 wording */ && !/not connected to this machine/.test(twoWhy), twoWhy);

    const off = PL.createPhoneLink({ bus });
    off.register('dev-off', { enabled: false, listed: false, model: 'OPPO X' });
    const offWhy = PL.makePhoneExec({ adbPath: () => '', link: off }).whyGone();
    check('PR66-11 switched off for real (not in the system settings): still "is off on it ... turn it on again"',
      offWhy.includes('is off on it') && offWhy.includes('turn it on again') && !/disconnected/.test(offWhy), offWhy);

    const slow = PL.createPhoneLink({ bus, jobTimeoutMs: 30 });
    slow.register('dev-slow', { enabled: true, model: 'OPPO X' });
    let slowErr = null;
    try { await slow.request('dev-slow', 'window', {}); } catch (err) { slowErr = err; }
    check('PR66-12 a step not answered in time: PHONE_NOT_ANSWERING says the connection to this machine dropped and the app reconnects by itself - not "screen off / Lamplit stopped"',
      slowErr?.code === 'PHONE_NOT_ANSWERING' && /connection to this machine/.test(slowErr.message) && /reconnects by itself/.test(slowErr.message) && !/screen may be off|stopped in the background/.test(slowErr.message), slowErr?.message);

    const server = await readText('../src/server.mjs');
    check('PR66-13 the hub keeps what the app reports about the system setting (listed), only when it says true',
      server.includes('listed: body?.listed === true'));
  } finally {
    Date.now = realNow;
  }
}

// --- the Android app (built, not run here) ----------------------------------------------------------
export async function appChecks({ check, readText }) {
  const J = '../mobile/android/app/src/main/java/com/desk/assistant/';
  const watch = await readText(`${J}NightshiftWatcher.java`);
  const relay = await readText(`${J}RelayLinks.java`);
  const hints = await readText(`${J}NetHints.java`);
  check('PR66-14 fleet sync goes the way that works now, learns the answering machine from its own row, and refreshes a machine already paired (by identity) instead of pairing it again; only ways the phone can use now are tried for a new one',
    watch.includes('String base = via(hub);\n            JSONObject list = new JSONObject(get(base + "/api/machines", token));')
    && /if \(machine\.optBoolean\("self"\)\) \{\s*learn\(hub, m\);/.test(watch)
    && /String same = PhoneRoutes\.match\(m, paired, fleet\);\s*if \(same != null\) \{\s*learn\(same, m\);/.test(watch)
    && watch.includes('if (RelayLinks.isRelayLocal(target) || NetHints.mayReach(target)) targets.add(target);')
    && watch.includes('String door = handoff(base, token, name);'));
  check('PR66-15 what was learned is kept apart from the page\'s list, replaces the old addresses, and is used for the way (stream, report, step answers - the answer\'s fallback too)',
    watch.includes('private static final String LEARNED = "lamplit_machines";') && watch.includes('for (String u : learnedAddresses(hub)) if (!out.contains(u)) out.add(u);')
    && watch.includes('String best = PhoneRoutes.pick(hub, addressesOf(hub), net);')
    && watch.includes('postJson(via(hub) + "/api/phone/agent", token, body);') && watch.includes('postJson(via(hub) + "/api/phone/jobs/" + jobId, token, reply);')
    && /forgetRoute\(hub\);\s*postJson\(via\(hub\) \+ "\/api\/phone\/jobs\/" \+ jobId, token, short_\);/.test(watch) && !watch.includes('postJson(hub + "/api/phone/jobs/"'));
  check('PR66-16 a login turned away at an address learned by name does not delete the login: that address is dropped (refused) and the machine may be paired anew',
    /learnedAddresses\(hub\)\.contains\(base\) && !appAddresses\(hub\)\.contains\(base\)\) \{[\s\S]{0,600}refuseLearned\(hub\);\s*return false;/.test(watch)
    && watch.includes('if (row.optBoolean("refused")) k.refusedByName = true;'));
  check('PR66-17 through the relay the probe waits for TLS (6 s, was 2.5 s), and the phone says whether the system still lists its service',
    watch.includes('conn.setReadTimeout(RelayLinks.isRelayLocal(base) ? 6000 : 2500);') && watch.includes('body.put("listed", agentListed());')
    && hints.includes('static boolean isTailnetUrl(String url)'));
  check('PR66-18 PHONE_AGENT_OFF only when the service is not connected, and then worded by the system setting: "disconnected by the system, open Lamplit or switch it off and on" vs "turn it on"',
    watch.includes('reply.put("code", listed ? "PHONE_AGENT_RECONNECTING" : "PHONE_AGENT_OFF");') /* 1.5.67: its own code when on in the settings */
    && watch.includes('nobody turned it off') && watch.includes('return "「让机器人用这部手机」 is off on the phone: ask the human to turn it on in Lamplit (设置 → 机器 → 手机). "')
    && watch.includes('return AgentKeeper.isOn(this);'));
  check('PR66-19 the relay closed the handshake (its machine had no tunnel yet, as 6 s after the PC restarted): tried again after 1 s and 2.5 s; another certificate or an unreachable relay is not retried',
    relay.includes('static final long[] RELAY_RETRY_MS = { 1000L, 2500L };') && relay.includes('outer = throughRelay(ssl, host, port, id);')
    && /plain\.connect\(new InetSocketAddress\(host, port\), 10000\);\s*\} catch \(Exception err\) \{\s*closeQuietly\(plain\);\s*throw err;/.test(relay)
    && /contains\("not the computer you paired with"\)\) throw err;/.test(relay) && relay.includes('Thread.sleep(RELAY_RETRY_MS[attempt]);'));

  // The page's list (launcher.js): a row whose machine changed every address is found by its name.
  const launcher = await readText('../mobile/shell/launcher.js');
  const src = nestedFn(launcher, 'sameNamedRow');
  let named = () => [];
  try { named = new Function(`${src}; return sameNamedRow;`)(); } catch { /* checked below */ }
  const PC = 'http://192.168.50.10:4390';
  const machines = [
    { name: '书房电脑', url: PC, self: true },
    { name: '腾讯云', url: 'http://203.0.113.10:4390', tailnetUrl: 'http://100.64.0.2:4390', relay: { id: 'x' } },
  ];
  const rows = [{ url: PC, name: '书房电脑' }, { url: 'http://100.64.0.1:4390', name: '腾讯云', alt: [] }];
  const hit = named(rows, machines[1], machines, PC);
  const twice = named(rows, machines[1], [...machines, { name: '腾讯云', url: 'http://203.0.113.11:4390' }], PC);
  const twoRows = named([...rows, { url: 'http://100.64.0.9:4390', name: '腾讯云' }], machines[1], machines, PC);
  const onPc = named([{ url: PC, name: '书房电脑' }, { url: 'http://100.64.0.1:4390', name: '腾讯云', alt: [PC] }], machines[1], machines, PC);
  check('PR66-20 the app\'s machine list folds the cloud\'s fresh addresses and relay into the row it holds a login for, by name, only when that is safe (one machine and one row of that name, no address of another machine)',
    Boolean(src) && hit.length === 1 && hit[0].url === 'http://100.64.0.1:4390' && twice.length === 0 && twoRows.length === 0 && onPc.length === 0
    && launcher.includes('if (!matches.length) matches = sameNamedRow(list, machine, data.machines, entry.url);'), JSON.stringify({ hit, twice, twoRows, onPc }));
}
