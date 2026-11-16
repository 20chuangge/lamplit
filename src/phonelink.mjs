// The phone without the cable (1.4.0).
//
// The Lamplit app on the phone keeps an event stream open to every machine it
// is paired with (NightshiftWatcher, for notifications). With the human's
// 「让机器人用这部手机」 on (an accessibility service), it also says so to each
// machine (POST /api/phone/agent) and does phone steps sent to it:
//
//   machine --(event stream: {type:'phone.job', to:<deviceId>, jobId, action, args})--> phone
//   phone   --(POST /api/phone/jobs/:jobId {ok, result | code, message})-------------> machine
//
// makePhoneExec() puts that behind the same commands src/phone.mjs gives adb,
// so every rule there (asking first, the lock, password boxes, paying or
// posting always asking) holds for both. A phone from the app is the serial
// "lamplit:<deviceId>"; anything else goes to the real adb.

import { execFile } from 'node:child_process';

const PREFIX = 'lamplit:';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createPhoneLink({ bus, jobTimeoutMs = 25000, freshMs = 90000 } = {}) {
  const phones = new Map(); // deviceId -> {enabled, model, name, at}
  const waiting = new Map(); // jobId -> {deviceId, resolve, reject, timer}
  let seq = 0;

  return {
    /** The app says whether this phone may be used (every 30 s and on connecting). */
    register(deviceId, { enabled = false, model = '', name = '', sdk = 0, phoneId = '' } = {}) {
      if (!deviceId) return;
      phones.set(String(deviceId), { enabled: Boolean(enabled), model: String(model || '').slice(0, 60), name: String(name || '').slice(0, 60), sdk: Number(sdk) || 0, phoneId: String(phoneId || '').slice(0, 64), at: Date.now() });
    },

    /** Phones that can be used now: turned on and heard from lately. */
    list() {
      const now = Date.now();
      // One phone paired here through two addresses (LAN and Tailscale) has two
      // device tokens: it is still one phone - the one heard from last (1.4.1).
      const byPhone = new Map();
      for (const [deviceId, p] of phones) {
        if (!p.enabled || now - p.at > freshMs) continue;
        const key = p.phoneId || deviceId;
        const seen = byPhone.get(key);
        if (!seen || p.at >= seen.p.at) byPhone.set(key, { deviceId, p });
      }
      return [...byPhone.values()].map(({ deviceId, p }) => ({ deviceId, serial: `${PREFIX}${deviceId}`, model: p.model || p.name || '手机', name: p.name }));
    },

    /** Send one step to one phone and wait for its answer. */
    request(deviceId, action, args = {}, { timeoutMs = jobTimeoutMs } = {}) {
      const jobId = `job_${Date.now().toString(36)}_${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(jobId);
          reject(fail('PHONE_NOT_ANSWERING', 'the phone did not answer: its screen may be off with Lamplit stopped in the background, or it lost the network. Ask the human to open Lamplit on the phone, then try again.'));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        waiting.set(jobId, { deviceId: String(deviceId), resolve, reject, timer });
        bus.emit({ type: 'phone.job', to: String(deviceId), jobId, action, args });
      });
    },

    /** The phone's answer. Only the phone the step went to may answer it. */
    resolve(jobId, deviceId, body = {}) {
      const w = waiting.get(jobId);
      if (!w || w.deviceId !== String(deviceId)) return false;
      waiting.delete(jobId);
      clearTimeout(w.timer);
      if (body.ok) w.resolve(body.result || {});
      else w.reject(fail(String(body.code || 'PHONE_FAILED'), String(body.message || 'the phone could not do that step').slice(0, 400)));
      return true;
    },
  };
}

function runAdb(file, args, { timeout = 20000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve({ stdout });
    });
  });
}

/** `input text` escaping undone: %s is a space, a backslash quotes the next character. */
function unescapeInputText(s) {
  return String(s || '').replace(/%s/g, ' ').replace(/\\(.)/g, '$1');
}

/**
 * The commands src/phone.mjs runs, for both kinds of phone: adb for a phone on
 * the cable, the app (through the link) for "lamplit:<deviceId>".
 */
export function makePhoneExec({ adbPath = () => '', link, adbExec = runAdb }) {
  const typed = new Map(); // deviceId -> text waiting for the paste key

  async function adbDevices() {
    const adb = adbPath();
    if (!adb) return '';
    try {
      const { stdout } = await adbExec(adb, ['devices', '-l'], { timeout: 10000 });
      return String(stdout || '');
    } catch {
      return '';
    }
  }

  async function app(deviceId, rest, opts = {}) {
    const ask = (action, args, more) => link.request(deviceId, action, args, more);
    const [a, b, c, d] = rest;
    if (a === 'shell' && b === 'dumpsys' && c === 'window') {
      const w = await ask('window', {});
      return { stdout: `  mCurrentFocus=Window{1 u0 ${w.app || 'unknown'}/app}\n    isKeyguardShowing=${w.locked ? 'true' : 'false'}\n` };
    }
    if (a === 'exec-out' && b === 'uiautomator') return { stdout: String((await ask('ui', {}, { timeoutMs: 30000 })).xml || '') };
    if (a === 'exec-out' && b === 'screencap') {
      // The human's live view (1.5.0): the phone's log says "watched" once, not a line a second.
      const shot = await ask('screenshot', opts.watch ? { watch: true } : {}, { timeoutMs: 40000 });
      const bytes = Buffer.from(String(shot.image || shot.png || ''), 'base64');
      return { stdout: opts.binary ? bytes : bytes.toString('latin1') };
    }
    if (a === 'shell' && b === 'input') {
      if (c === 'tap') { await ask('tap', { x: Number(d), y: Number(rest[4]) }); return { stdout: '' }; }
      if (c === 'swipe') {
        const [x1, y1, x2, y2, ms] = rest.slice(3).map(Number);
        await ask('swipe', { x1, y1, x2, y2, ms: ms || 350 });
        return { stdout: '' };
      }
      if (c === 'text') { await ask('type', { text: unescapeInputText(rest.slice(3).join(' ')) }); return { stdout: '' }; }
      if (c === 'keyevent') {
        const code = Number(d);
        // The paste after Chinese: the app types the text straight into the box instead.
        if (code === 279 && typed.has(deviceId)) {
          const text = typed.get(deviceId);
          typed.delete(deviceId);
          await ask('type', { text });
          return { stdout: '' };
        }
        await ask('key', { code });
        return { stdout: '' };
      }
    }
    if (a === 'shell' && b === 'content' && c === 'call') {
      const method = rest[rest.indexOf('--method') + 1];
      if (method === 'type') typed.set(deviceId, Buffer.from(String(rest[rest.indexOf('--arg') + 1] || ''), 'base64').toString('utf8'));
      return { stdout: 'Result: Bundle[{ok=true}]\n' };
    }
    if (a === 'shell' && b === 'am' && c === 'start') return { stdout: 'Status: ok\n' };
    if (a === 'shell' && b === 'pm' && c === 'path') return { stdout: (await ask('installed', { pkg: d })).installed ? `package:/app/${d}\n` : '' };
    if (a === 'shell' && b === 'pm' && c === 'list') return { stdout: ((await ask('apps', {})).apps || []).map((p) => `package:${p}`).join('\n') };
    if (a === 'shell' && b === 'monkey') { await ask('open', { pkg: rest[rest.indexOf('-p') + 1] }); return { stdout: '' }; }
    if (a === 'shell' && b === 'wm' && c === 'size') {
      const s = await ask('size', {});
      return { stdout: `Physical size: ${s.w || 1080}x${s.h || 2400}\n` };
    }
    throw fail('PHONE_FAILED', `the Lamplit app cannot do "${rest.join(' ').slice(0, 60)}"`);
  }

  return async function exec(_file, args, opts = {}) {
    if (args[0] === 'devices') {
      const fromAdb = await adbDevices();
      const viaApp = link.list();
      // One phone both on the cable and with the app on is listed once (the app),
      // or every step would stop to ask "which phone?".
      const appModels = viaApp.map((p) => String(p.model || '').toLowerCase().replace(/[\s_]+/g, ' ').trim());
      const lines = fromAdb.split(/\r?\n/).slice(1).filter((l) => l.trim()).filter((l) => {
        const model = (/\bmodel:(\S+)/.exec(l)?.[1] || '').toLowerCase().replace(/_/g, ' ').trim();
        return !model || !appModels.some((m) => m === model || m.endsWith(` ${model}`));
      });
      for (const p of viaApp) lines.push(`${p.serial}   device product:lamplit model:${String(p.model).replace(/\s+/g, '_')} transport_id:0`);
      return { stdout: `List of devices attached\n${lines.join('\n')}\n` };
    }
    if (args[0] === '-s' && String(args[1] || '').startsWith(PREFIX)) return app(String(args[1]).slice(PREFIX.length), args.slice(2), opts);
    const adb = adbPath();
    if (!adb) throw fail('ADB_NOT_FOUND', 'no phone on a cable here (adb is not installed) and no phone with Lamplit\'s 「让机器人用这部手机」 turned on');
    return adbExec(adb, args, opts);
  };
}
