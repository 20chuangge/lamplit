// 1.5.67: the phone after 1.5.66 shipped (11-24).
//   1. The phone held two logins for the cloud machine: one at an old Tailscale address (dead) and one
//      through the relay (working). It kept timing out on the dead one every minute. Now a working hub
//      answers which of the phone's other logins are its own (by their SHA-256: POST /api/phone/mine),
//      and the watcher keeps one hub per machine - the dead address is only another address of it.
//   2. After an update OPPO did not connect the phone service again until Lamplit was opened, while it
//      stayed on in the settings; a bot said 「让机器人用这部手机」"被关掉了". Now the app switches it off
//      and on (with WRITE_SECURE_SETTINGS) or shows 「Lamplit 更新好了，点一下让机器人重新接上手机」, and
//      the bots get PHONE_AGENT_RECONNECTING with the words to pass on - never "off".
//   3. The PC's 设置 → 机器 → 手机 says where the switch is, once a phone is paired.
// Nothing here talks to a real phone. Called from smoke.mjs as stages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// --- 1. which logins are this machine's (the hub) ----------------------------------------------------
export async function sameMachineChecks({ check, api, readText }) {
  const D = await import('../src/devices.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-devices-1567-'));
  try {
    const store = await D.loadDeviceStore?.(path.join(dir, 'devices.json'));
    if (store?.add) {
      const a = store.add({ name: 'phone', kind: 'phone' });
      const b = store.add({ name: 'phone again', kind: 'phone' });
      check('PH67-1 a machine knows its own logins by their SHA-256, and only those: a login of another machine, a malformed hash and the login itself (not hashed) are not its own',
        store.ownsHash(sha(a.sessionToken)) && store.ownsHash(sha(b.sessionToken).toUpperCase()) && !store.ownsHash(sha('another machine\'s login'))
        && !store.ownsHash('xyz') && !store.ownsHash(a.sessionToken) && !store.ownsHash(''), JSON.stringify(Object.keys(store)));
    } else {
      check('PH67-1 a machine knows its own logins by their SHA-256', false, 'loadDeviceStore not usable here');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Over HTTP: a phone paired here asks about two of its logins.
  const pairPhone = async () => (await api('/api/pair', {
    method: 'POST',
    body: { code: (await api('/api/pairing')).json.code, client: 'app' },
    headers: { origin: 'https://localhost', 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 14; smoke)' },
  })).json;
  const one = await pairPhone();
  const two = await pairPhone();
  try {
    const asked = await api('/api/phone/mine', {
      method: 'POST',
      body: { hashes: [sha(two.token), sha('a login of another machine'), 'not-a-hash'] },
      headers: { origin: 'https://localhost', authorization: `Bearer ${one.token}` },
    });
    const notPhone = await api('/api/phone/mine', { method: 'POST', body: { hashes: [sha(two.token)] } });
    const many = await api('/api/phone/mine', {
      method: 'POST',
      body: { hashes: Array.from({ length: 30 }, () => sha(two.token)) },
      headers: { origin: 'https://localhost', authorization: `Bearer ${one.token}` },
    });
    check('PH67-2 POST /api/phone/mine: a paired phone learns which of its other logins are this machine\'s (yes, no, no); not a phone: refused; at most 20 at a time',
      asked.status === 200 && JSON.stringify(asked.json?.mine) === '[true,false,false]'
      && notPhone.status === 403 && notPhone.json?.error?.code === 'NOT_A_PHONE'
      && many.status === 200 && many.json?.mine?.length === 20, JSON.stringify({ asked: asked.json, notPhone: notPhone.status, many: many.json?.mine?.length }));
    const view = await api('/api/phone');
    check('PH67-3 /api/phone says a phone is paired here (the PC\'s page shows where the switch is)', view.json?.phonePaired === true, JSON.stringify(view.json));
  } finally {
    for (const p of [one, two]) if (p?.device?.id) await api(`/api/devices/${p.device.id}`, { method: 'DELETE' });
  }

  const J = '../mobile/android/app/src/main/java/com/desk/assistant/';
  const watch = await readText(`${J}NightshiftWatcher.java`);
  check('PH67-4 the watcher keeps one hub per machine: the supervisor, each report thread and each stream use activeHubs() (PhoneRoutes.active); a folded hub stops its own stream',
    watch.includes('java.util.List<String> hubs = activeHubs();') && watch.includes('while (running && activeHubs().contains(hub)) {')
    && /if \(!activeHubs\(\)\.contains\(hub\)\) \{\s*Log\.i\(TAG, "not watching " \+ hub/.test(watch) && watch.includes('return PhoneRoutes.active(all, folded);'));
  check('PH67-5 from a hub that answers, the phone asks about its logins for hubs that do not answer (two missed reports), sends only their SHA-256, and folds the ones that hub calls its own into it',
    watch.includes('findSameMachine(hub, base, token);') && watch.includes('misses.getOrDefault(other, 0) < 2') && watch.includes('hashes.put(sha256Hex(theirs));')
    && watch.includes('postJson(base + "/api/phone/mine", token, body).optJSONArray("mine")') && watch.includes('row.put("sameAs", hub);') && !/hashes\.put\(theirs\)/.test(watch));
  check('PH67-6 the dead address stays as another address of the working hub (tried only when the phone can use it); what fleet sync learns later keeps the fold',
    /if \(!other\.equals\(hub\) && hub\.equals\(sameAs\(other\)\) && !out\.contains\(other\)\) out\.add\(other\);/.test(watch)
    && watch.includes('if (old != null && !str(old, "sameAs").isEmpty()) row.put("sameAs", str(old, "sameAs"));'));
}

// --- 2. connected again after an update, and what the bots are told -----------------------------------
export async function reconnectChecks({ check, readText }) {
  const PL = await import('../src/phonelink.mjs');
  const PH = await import('../src/phone.mjs');
  const bus = { emit() {}, subscribe: () => () => {} };
  const link = PL.createPhoneLink({ bus });
  link.register('dev-1', { enabled: false, listed: true, updated: true, model: 'OPPO X' });
  const why = PL.makePhoneExec({ adbPath: () => '', link }).whyGone();
  const link2 = PL.createPhoneLink({ bus });
  link2.register('dev-2', { enabled: false, listed: true, model: 'OPPO X' });
  const why2 = PL.makePhoneExec({ adbPath: () => '', link: link2 }).whyGone();
  check('PH67-7 on in the settings but not connected since an update: the bots hear "not connected yet since Lamplit was updated", that nobody turned it off, that opening Lamplit once fixes it, the words to pass on - and not to say 被关掉了',
    /not connected yet since Lamplit was updated/.test(why) && /nobody turned it off/.test(why) && /Opening Lamplit on the phone once/.test(why)
    && why.includes('「Lamplit 刚更新或重启过，机器人还没重新接上手机。在手机上打开一次 Lamplit 就好，开关不用动。」') && why.includes('不要说「被关掉了」')
    && /updated or restarted, or the system disconnected it/.test(why2) && !/is off on it|turn it on again/.test(why + why2), `${why}\n${why2}`);

  // A step answered by the app with the new code reaches the bot as it is.
  const jobs = PL.createPhoneLink({ bus: { emit: (ev) => { if (ev.type === 'phone.job') setTimeout(() => jobs.resolve(ev.jobId, 'dev-3', { ok: false, code: 'PHONE_AGENT_RECONNECTING', message: 'not connected yet' }), 5); }, subscribe: () => () => {} } });
  jobs.register('dev-3', { enabled: true, model: 'OPPO X' });
  const phone = PH.createPhone({ adb: () => 'lamplit', exec: PL.makePhoneExec({ adbPath: () => '', link: jobs }), workspaceDir: os.tmpdir() });
  let err = null;
  try { await phone.act('look', {}); } catch (e) { err = e; }
  check('PH67-8 the app\'s PHONE_AGENT_RECONNECTING reaches the bot as it is (not turned into another code)', err?.code === 'PHONE_AGENT_RECONNECTING', `${err?.code} ${err?.message}`);

  const J = '../mobile/android/app/src/main/java/com/desk/assistant/';
  const watch = await readText(`${J}NightshiftWatcher.java`);
  const keeper = await readText(`${J}AgentKeeper.java`);
  const startup = await readText(`${J}StartupReceiver.java`);
  const server = await readText('../src/server.mjs');
  check('PH67-9 the app answers a step with PHONE_AGENT_RECONNECTING (on in the settings, not connected) and PHONE_AGENT_OFF only when it is off in the settings; its message gives the words and rules out 被关掉了',
    watch.includes('reply.put("code", listed ? "PHONE_AGENT_RECONNECTING" : "PHONE_AGENT_OFF");') && watch.includes('reply.put("message", agentOffMessage(listed, AgentKeeper.reconnectingAfterUpdate(this)));')
    && watch.includes('不要说「被关掉了」') && watch.includes('body.put("updated", AgentKeeper.reconnectingAfterUpdate(this));') && server.includes('updated: body?.updated === true'));
  check('PH67-10 after an update the app notes it; on but not connected for 15 s: switched off and on once with WRITE_SECURE_SETTINGS, else a quiet notice 「Lamplit 更新好了，点一下让机器人重新接上手机」 that opens Lamplit; gone once connected',
    startup.includes('if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) AgentKeeper.noteUpdated(context);')
    && /if \(isOn\(c\)\) \{[\s\S]{0,200}reconnect\(c\);/.test(keeper) && keeper.includes('if (now - unboundSince < 15000L) return;') && keeper.includes('if (toggledFor != unboundSince && canTurnOn(c)) {')
    && keeper.includes('"Lamplit 更新好了，点一下让机器人重新接上手机"') && keeper.includes('new Intent(c, MainActivity.class)') && keeper.includes('.setOnlyAlertOnce(true)')
    && /if \(on\) \{\s*hideOffNotice\(c\);[\s\S]{0,120}hideReconnectNotice\(c\);/.test(keeper));
  check('PH67-11 the checkup says it the same way: still on, not connected yet, open Lamplit once - not "turn it on"',
    server.includes("const reconnecting = (state.phoneLink.off?.() || []).some((p) => p.listed);") && server.includes('手机上「让机器人用这部手机」还开着，只是还没重新接上（Lamplit 刚更新或重启过）。在手机上打开一次 Lamplit 就好，开关不用动。'));
}

// --- 3. the PC's page: where the switch is ------------------------------------------------------------
export async function pcHintChecks({ check, readText }) {
  const page = await readText('../public/index.html');
  const js = await readText('../public/app/main/11-machines.js');
  const en = await readText('../public/i18n-en.js');
  const hint = '「让机器人用这部手机」在手机上的 Lamplit 里打开：设置 → 机器 → 手机';
  check('PH67-12 the PC\'s 设置 → 机器 → 手机 has one line saying where 「让机器人用这部手机」 is, shown only off the phone and once a phone is paired, in English too',
    page.includes(`<div class="row-note" id="phone-agent-hint" hidden>${hint}</div>`)
    && js.includes("if ($('phone-agent-hint')) $('phone-agent-hint').hidden = onPhone || !data.phonePaired;")
    && en.includes(`"${hint}": "Turn on \\"Let bots use this phone\\" in the Lamplit app on the phone: Settings → Machines → Phone"`));
}
