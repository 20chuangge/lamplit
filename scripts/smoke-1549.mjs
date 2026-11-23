/**
 * smoke-1549.mjs - 1.5.49: why direct fails on a real Windows PC, and video cards.
 *
 *   directBlockerChecks({check})            firewall verdict and fix plan (UDP too),
 *                                           a proxy's TUN adapter, why a punch failed
 *   videoChecks({check, base, keyDir})      byte ranges for workspace files (here and
 *                                           through another machine), the video card
 *   relayVersionChecks({check})             RELAY_VERSION raised whenever relay.mjs changes
 *   oldRelayChecks({check})                 a 1.5.47 relay (no seenIp): the hint is just unknown
 *
 * Everything with mocks: this computer's firewall and Clash are never touched.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firewallPlan, firewallVerdict } from '../desktop/guard.mjs';
import { addressHint, proxyTunInterfaces } from '../src/direct.mjs';
import { createSimNet, simStun } from './direct-simnet.mjs';
import { stunAnswer } from '../hub/relay/relay.mjs';
import { createDirectDialer, createDirectServer } from '../src/direct.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

export async function directBlockerChecks({ check }) {
  // --- Windows Firewall, as found on the user's PC (11-20) ---------------------
  const EVEN = 'Evenlight - AI bots that put your idle computers to work';
  const OURS = 'Lamplit phone access (local network + Tailscale)';
  const found = {
    rules: [
      { action: 'Block', profile: 'Public', protocol: 'UDP', name: EVEN },
      { action: 'Block', profile: 'Public', protocol: 'TCP', name: EVEN },
      { action: 'Allow', profile: 'Any', protocol: 'TCP', name: OURS },
    ],
    ours: true,
    networks: ['Public'],
  };
  const v = firewallVerdict(found);
  check('firewall: the user\'s PC as found - UDP (direct) is blocked on the Public network, and nothing allows it', v.udp?.blocked === true && v.udp.allowed === false && v.udp.ok === false, JSON.stringify(v));
  check('firewall: a Block rule beats an Allow on the same network, so the phone\'s LAN TCP is blocked there too', v.tcp?.blocked === true && v.ok === false);
  check('firewall: the stale rules from the old app name are named (to be removed)', JSON.stringify(v.staleBlocks) === JSON.stringify([`${EVEN}（UDP，公用网络）`, `${EVEN}（TCP，公用网络）`]), JSON.stringify(v.staleBlocks));
  const plan = firewallPlan(v);
  check('firewall fix: before the UAC prompt it lists exactly what changes - remove those two, allow TCP from LAN/Tailscale, allow UDP for direct',
    plan.length === 4 && /删掉/.test(plan[0]) && plan[0].includes(EVEN) && /UDP/.test(plan[0]) && /删掉/.test(plan[1]) && /TCP/.test(plan[2]) && /局域网/.test(plan[2]) && /UDP/.test(plan[3]) && /直连/.test(plan[3]), JSON.stringify(plan));
  const fixed = firewallVerdict({ rules: [{ action: 'Allow', profile: 'Any', protocol: 'TCP', name: OURS }, { action: 'Allow', profile: 'Any', protocol: 'UDP', name: 'Lamplit direct (UDP)' }], ours: true, networks: ['Public'] });
  check('firewall: after the fix, TCP and UDP are both open and nothing is left to do', fixed.ok && fixed.udp.ok && fixed.staleBlocks.length === 0 && firewallPlan(fixed).length === 0, JSON.stringify(fixed));
  const legacy = firewallVerdict({ block: ['Public'], allow: [], networks: ['Public'] });
  check('firewall: the old report shape still reads (TCP), UDP unknown', legacy.blocked === true && legacy.ok === false && legacy.udp?.known === false);
  const main = read('desktop/main.mjs');
  check('firewall fix: it now also allows UDP for Lamplit on every network (direct), and still removes this program\'s Block rules (1.5.54: only those Windows made for Lamplit, not the user\'s own)',
    /-Protocol UDP -Profile Any/.test(main) && main.includes("Where-Object { $_.Action -eq 'Block' -and $_.DisplayName -match '^(Lamplit|Evenlight|Nightshift)' } | Remove-NetFirewallRule") && /Get-NetFirewallPortFilter/.test(main));
  const page = (read('public/app/main/11-machines.js') + read('public/app/main/11a-network.js')) + read('public/app/main/08-settings.js');
  check('firewall: 体检 checks UDP when direct is on, and the fix asks first with the list of changes', /fw\.udp/.test(page) && /firewallPlan|plan\.join/.test(page) && /window\.confirm\(/.test(page));

  // --- a proxy's TUN (Clash Verge / mihomo) ------------------------------------
  const tun = proxyTunInterfaces({
    Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    Meta: [{ address: '198.18.0.1', family: 'IPv4', internal: false }],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  });
  check('proxy: a Clash/mihomo TUN adapter is noticed (by name or by its 198.18/15 address)', JSON.stringify(tun) === JSON.stringify(['Meta']), JSON.stringify(tun));
  const hintSrc = read('public/app/main/08-settings.js') + read('src/server.mjs');
  check('proxy: the hint names the rule that worked for Tailscale on this PC - PROCESS-NAME,Lamplit.exe,DIRECT at the top of the Clash rules - and says to restart Lamplit',
    (hintSrc.match(/在 Clash 规则的最前面加一条 PROCESS-NAME,Lamplit\.exe,DIRECT，保存后重启 Lamplit/g) || []).length === 2);
  check('proxy: an ordinary PC has none', proxyTunInterfaces({ Ethernet: [{ address: '192.168.1.20', family: 'IPv4' }], 'Wi-Fi': [{ address: '10.0.0.5', family: 'IPv4' }] }).length === 0);
  check('proxy: STUN saw another address than the relay saw for the tunnel: one of them went through a proxy',
    addressHint({ stunIp: '203.0.113.9', seenIp: '198.51.100.7' }) === 'differ' && addressHint({ stunIp: '203.0.113.9', seenIp: '203.0.113.9' }) === 'same' && addressHint({ stunIp: '203.0.113.9', seenIp: '' }) === 'unknown' && addressHint({ stunIp: '2001:db8::1', seenIp: '203.0.113.9' }) === 'unknown');

  // --- why a punch failed, per side --------------------------------------------
  {
    // The computer's UDP is blocked (its firewall): the phone's probes never arrive.
    const net = createSimNet({ latencyMs: 3 });
    simStun(net, '198.51.100.1', 34443, stunAnswer);
    const pcNat = net.nat('203.0.113.40', 'full');
    pcNat.blocked = true;
    const pcHost = net.host('192.168.1.5', { nat: pcNat });
    const phoneHost = net.host('203.0.113.41');
    const server = createDirectServer({ acceptStream: () => {}, relay: () => ({ host: '198.51.100.1', port: 34443 }), endpointOptions: { createSocket: () => pcHost.createSocket(), interfaces: () => [{ address: '192.168.1.5', family: 'IPv4' }], ipv6: false }, sessionOptions: { punchMs: 1200 } });
    const dialer = createDirectDialer({ offer: (_d, body) => server.offer(body, { who: 'phone' }), endpointOptions: { createSocket: () => phoneHost.createSocket(), interfaces: () => [{ address: '203.0.113.41', family: 'IPv4' }], ipv6: false }, sessionOptions: { punchMs: 1200 } });
    const keep = setInterval(() => {}, 1000);
    try {
      await dialer.kick({ host: '198.51.100.1', port: 34443, id: 'abcdefghijklmnop0123', fp: 'a'.repeat(64) });
      await new Promise((r) => setTimeout(r, 400));
      const why = server.view().lastFailure;
      check('punch failure, the computer\'s side: says no probe of the other side arrived, and to which kinds of address it sent', /^punch:/.test(why) && /no probe arrived/.test(why) && /host/.test(why), why);
      const phoneWhy = dialer.info('abcdefghijklmnop0123').reason;
      check('punch failure, the phone\'s side: says the same in its own terms', /^punch:/.test(phoneWhy) && /no probe arrived/.test(phoneWhy) && /srflx|host/.test(phoneWhy), phoneWhy);
    } finally {
      clearInterval(keep);
      dialer.close();
      server.close();
    }
  }
  const java = read('mobile/android/app/src/main/java/com/desk/assistant/DirectChannel.java');
  check('punch failure: the phone app keeps the same detail (did anything arrive), for 关于 → 手机到这台', /no probe arrived/.test(java) && /probes arrived/.test(java) && /对方的探测包一个也没到/.test(java));
}

export async function videoChecks({ check, base, keyDir }) {
  const key = fs.readFileSync(path.join(keyDir, 'local-key'), 'utf8').trim();
  const H = { 'x-lamplit-local': key };
  const bytes = crypto.createHash('sha512').update('clip').digest();
  const clip = Buffer.concat(Array.from({ length: 64 }, () => bytes)); // 4096 bytes
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('lamplit-case-dev-landscape-zh.mp4') }, body: clip });
  const upJson = await up.json();
  const url = `${base}/api/workspace/file?path=${encodeURIComponent(upJson.path)}`;
  const part = await fetch(url, { headers: { ...H, range: 'bytes=100-199' } });
  const partBody = Buffer.from(await part.arrayBuffer());
  check('video: a byte range of a workspace file (seeking, the first frame without the whole file) answers 206 with exactly those bytes',
    part.status === 206 && part.headers.get('content-range') === 'bytes 100-199/4096' && partBody.equals(clip.subarray(100, 200)) && part.headers.get('accept-ranges') === 'bytes', `${part.status} ${part.headers.get('content-range')}`);
  check('video: it is served as video, inline (a <video> may play it)', /^video\/mp4/.test(part.headers.get('content-type') || '') && /inline/.test(part.headers.get('content-disposition') || ''));
  const open = await fetch(url, { headers: { ...H, range: 'bytes=4000-' } });
  check('video: an open-ended range runs to the end', open.status === 206 && open.headers.get('content-range') === 'bytes 4000-4095/4096' && Buffer.from(await open.arrayBuffer()).length === 96);
  const whole = await fetch(url, { headers: H });
  check('video: without a range, the whole file, saying ranges are accepted', whole.status === 200 && Buffer.from(await whole.arrayBuffer()).equals(clip) && whole.headers.get('accept-ranges') === 'bytes');
  const past = await fetch(url, { headers: { ...H, range: 'bytes=9000-9100' } });
  check('video: a range past the end is 416', past.status === 416);

  // Through another machine (the peer link): the range goes along, 206 comes back.
  const token = JSON.parse(fs.readFileSync(path.join(keyDir, 'security.json'), 'utf8')).token;
  await fetch(`${base}/api/peers`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ peers: [{ name: 'other', url: base, token }] }) });
  const far = await fetch(`${base}/api/peers/other/file?path=${encodeURIComponent(upJson.path)}`, { headers: { ...H, range: 'bytes=10-19' } });
  const farBody = Buffer.from(await far.arrayBuffer());
  check('video: from another machine (pairing rules as before), ranges work too', far.status === 206 && far.headers.get('content-range') === 'bytes 10-19/4096' && farBody.equals(clip.subarray(10, 20)), `${far.status} ${far.headers.get('content-range')}`);
  await fetch(`${base}/api/peers`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ peers: [] }) });

  // The card (page code): attachments that are videos are cards with a frame, play and duration.
  // 1.5.64: splitAttachments moved to 05b-folder.js (folder upload); its match is named m.
  const chat = read('public/app/main/05b-folder.js');
  const media = read('public/app/main/10-computer.js');
  check('video card: an attached .mp4 / .webm / .mov is a video (not a generic file)', /video: m\[2\] === '文件' && \/\\\.\(mp4\|webm\|mov\|m4v\)\$\/i\.test\(m\[1\]\)/.test(chat), 'splitAttachments');
  check('video card: a first frame as poster, a play button and the duration; tap plays inline with the native controls (full screen there)',
    /function videoCard\(/.test(media) && /#t=0\.1/.test(media) && /att-video-play/.test(media) && /att-video-dur/.test(media) && /v\.controls = true/.test(media) && /v\.play\(\)/.test(media));
  check('video card: no frame readable -> a clear 「视频」 card, still downloadable', /att-video-fallback/.test(media) && media.includes("'视频'"));
  check('video card: a file that lives on another machine is fetched from there (findElsewhere), as for pictures', /findElsewhere\(file\.path\)/.test(media));
}

/**
 * RELAY_VERSION goes up whenever relay.mjs changes (1.5.49 review): a relay
 * takes only a newer version, so new code under an old number never arrives.
 */
export async function relayVersionChecks({ check }) {
  const { relayVersionProblems, relayCodeHash, relayVersionIn } = await import('../src/relayupdate.mjs');
  const { RELAY_VERSION } = await import('../hub/relay/relay.mjs');
  const code = read('hub/relay/relay.mjs');
  const record = JSON.parse(read('scripts/relay-versions.json'));
  // The last release's relay, when git has it (a shallow CI checkout may not): the record alone then.
  let base = '';
  try {
    const { execFileSync } = await import('node:child_process');
    base = execFileSync('git', ['show', 'origin/main:hub/relay/relay.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  } catch { /* no git, or no origin/main */ }
  const problems = relayVersionProblems({ code, record, base });
  check(`relay version: relay.mjs is recorded under its RELAY_VERSION (${RELAY_VERSION}), raised since the last release if the code changed${base ? '' : ' (no origin/main here: the record only)'}`, problems.length === 0, problems.join(' | '));
  check('relay version: the version in the file is what the module exports', relayVersionIn(code) === RELAY_VERSION);
  // The rule itself, on made-up code.
  const v1 = "export const RELAY_VERSION = '1.5.47';\nconst a = 1;\n";
  const rec1 = { versions: [{ version: '1.5.47', sha256: relayCodeHash(v1) }] };
  const changed = v1.replace('a = 1', 'a = 2');
  const bumped = changed.replace("'1.5.47'", "'1.5.49'");
  const rec2 = { versions: [...rec1.versions, { version: '1.5.49', sha256: relayCodeHash(bumped) }] };
  check('relay version rule: unchanged code under its recorded version passes; CRLF line endings are the same code', relayVersionProblems({ code: v1, record: rec1, base: v1 }).length === 0 && relayVersionProblems({ code: v1.replace(/\n/g, '\r\n'), record: rec1, base: v1 }).length === 0);
  const forgot = relayVersionProblems({ code: changed, record: rec1, base: v1 });
  check('relay version rule: changed code under the old RELAY_VERSION fails, and says what to set and record', forgot.length === 2 && forgot[0].includes('above 1.5.47') && forgot[0].includes(relayCodeHash(changed)) && /not above/.test(forgot[1]), forgot.join(' | '));
  check('relay version rule: a raised RELAY_VERSION without a new record entry fails', relayVersionProblems({ code: bumped, record: rec1, base: v1 }).length === 1);
  check('relay version rule: raised and recorded passes', relayVersionProblems({ code: bumped, record: rec2, base: v1 }).length === 0);
  check('relay version rule: a record entry edited to the new hash without raising the version fails (git still has the last release)',
    relayVersionProblems({ code: changed, record: { versions: [{ version: '1.5.47', sha256: relayCodeHash(changed) }] }, base: v1 }).length === 1);
  check('relay version rule: a record whose versions do not go up fails', relayVersionProblems({ code: bumped, record: { versions: [rec2.versions[1], { ...rec1.versions[0] }, rec2.versions[1]] } }).some((p) => /not newer/.test(p)));
  const sign = read('scripts/sign-update.mjs');
  check('relay version: the release signs the relay as RELAY_VERSION (not the app version) and refuses to sign when the record or version is off',
    sign.includes('makeRelayManifest({ version: RELAY_VERSION,') && sign.includes('relayVersionProblems({ code: relayBytes.toString') && sign.includes('compareRelayVersions(RELAY_VERSION, appVersion) > 0') && !sign.includes('makeRelayManifest({ version: appVersion'));
}

/**
 * A relay from 1.5.47/1.5.48 (no seenIp in relay-info) with this hub (1.5.49
 * review): the address comparison is just unknown - no error, no proxy hint.
 * The real 1.5.47 relay.mjs from git when there; else today's with seenIp taken out.
 */
export async function oldRelayChecks({ check }) {
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { createRelayLink } = await import('../src/relaylink.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-oldrelay-'));
  let oldCode = '';
  let from = 'git a22d543 (1.5.47)';
  try {
    const { execFileSync } = await import('node:child_process');
    oldCode = execFileSync('git', ['show', 'a22d543:hub/relay/relay.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  } catch { /* shallow checkout */ }
  if (!/RELAY_VERSION = '1\.5\.47'/.test(oldCode) || /seenIp/.test(oldCode)) {
    oldCode = read('hub/relay/relay.mjs').replace(', seenIp: ip });', ' });').replace(/RELAY_VERSION = '[^']+'/, "RELAY_VERSION = '1.5.47'");
    from = "today's relay without seenIp";
  }
  fs.writeFileSync(path.join(tmp, 'relay.mjs'), oldCode);
  const oldRelay = await import(pathToFileURL(path.join(tmp, 'relay.mjs')).href);
  const newRelay = await import('../hub/relay/relay.mjs');
  const errors = [];
  const run = async (R, label) => {
    const id = R.makeSelfSignedCert({ commonName: 'lamplit-relay' });
    const join = crypto.randomBytes(18).toString('base64url');
    const relay = R.createRelay({ identity: id, joinSecret: join, updater: R.createRelayUpdater({ running: { version: '1.5.47', sha256: '0'.repeat(64) }, stateDir: path.join(tmp, `state-${label}`), minIntervalMs: 0 }) });
    // TCP and UDP on the same number: Windows keeps some UDP ports for itself (bind EACCES), so another one
    // is tried, and what was opened is closed when it fails - the TCP server left listening kept the whole
    // smoke run from ever exiting after its result (1.5.62).
    let port = 0;
    for (let tries = 1; ; tries += 1) {
      port = await new Promise((r) => relay.server.listen(0, '127.0.0.1', () => r(relay.server.address().port)));
      try {
        await relay.listenStun(port, '127.0.0.1');
        break;
      } catch (err) {
        await new Promise((r) => relay.server.close(() => r()));
        if (tries >= 5) { relay.close(); throw err; }
      }
    }
    const link = createRelayLink({ dataDir: path.join(tmp, `hub-${label}`), handler: (_q, s) => s.end('hub'), log: (line) => { if (/error|TypeError|undefined/i.test(line)) errors.push(`${label}: ${line}`); }, relayUpdate: () => null });
    try {
      link.configure({ enabled: true, host: '127.0.0.1', port, relayFingerprint: id.fingerprint, join });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !(link.view().state === 'online' && link.view().relay?.version)) await new Promise((r) => setTimeout(r, 20));
      const stun = await link.probeStun().catch((err) => { errors.push(`${label} probeStun: ${err.message}`); return 'no'; });
      const v = link.view();
      return { online: v.state === 'online', relay: v.relay, stun, hint: v.direct?.addressHint, keys: Object.keys(v.relay || {}) };
    } finally {
      link.stop();
      link.closeDirect?.();
      relay.close();
    }
  };
  try {
    const old = await run(oldRelay, 'old');
    const cur = await run(newRelay, 'new');
    check(`old relay (${from}): the hub connects, hears its version, and STUN works`, old.online && old.relay?.version === '1.5.47' && old.stun !== 'no', JSON.stringify(old));
    check('old relay: with no seenIp, the address comparison is just "unknown" (no error, nothing wrong said)', old.hint === 'unknown' && errors.length === 0, `${JSON.stringify(old)} ${errors.join(' | ')}`);
    check('new relay on the same machine: it reports where the tunnel came from, and it matches STUN ("same")', cur.online && cur.hint === 'same', JSON.stringify(cur));
    check('neither view shows the relay-seen address itself (only the comparison)', !old.keys.includes('seenIp') && !cur.keys.includes('seenIp'));
    const page = read('public/app/main/08-settings.js');
    const server = read('src/server.mjs');
    check('old relay: the proxy hint needs a TUN adapter or addresses that differ - "unknown" alone says nothing (page and 体检)',
      (page.match(/if \(tun \|\| d\.addressHint === 'differ'\)/g) || []).length === 1 && (server.match(/if \(tun \|\| d\.addressHint === 'differ'\)/g) || []).length === 1 && !/addressHint === 'unknown'|addressHint !== 'same'/.test(page + server));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
