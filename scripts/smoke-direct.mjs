#!/usr/bin/env node
/**
 * smoke-direct.mjs - 直连 (1.5.46), checked without the internet.
 *
 *   directChecks({check})             the relay's STUN answer, the channel's
 *                                     encryption, delivery under loss and
 *                                     reordering, hole punching through every
 *                                     kind of NAT (a pretend network,
 *                                     scripts/direct-simnet.mjs), fallback
 *   directServerChecks({check, ...})  the real hub behind a relay, a paired
 *                                     device going direct over loopback UDP:
 *                                     only paired devices, still remote,
 *                                     still pinned, the relay never sees the
 *                                     addresses (smoke.mjs runs this)
 *
 * Run alone: node scripts/smoke-direct.mjs
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Duplex } from 'node:stream';

import { createPeers } from '../src/peers.mjs';

import { createRelay, makeSelfSignedCert, parseStunAnswer, stunAnswer, stunRequest } from '../hub/relay/relay.mjs';
import { listenRelay } from './test-ports.mjs';
import {
  MAX_PACKET, ReplayWindow, cleanCandidates, createDirectDialer, createDirectServer, deriveKeys, openPacket, sealPacket,
} from '../src/direct.mjs';
import { checkRelay, connectViaRelay, relayFetch } from '../src/relaylink.mjs';
import { createSimNet, simStun } from './direct-simnet.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(20);
  }
}

/** A UDP socket on loopback that collects what it hears. */
function udpProbe() {
  const s = dgram.createSocket('udp4');
  const got = [];
  s.on('message', (m, r) => got.push({ m, r }));
  return new Promise((resolve) => s.bind(0, '127.0.0.1', () => resolve({ s, got, port: s.address().port })));
}

/** An echo server for streams: what comes in goes back (the computer's side in the channel tests). */
function echoStreams(stream) {
  stream.on('data', (d) => stream.write(d));
  stream.on('end', () => stream.end());
  stream.on('error', () => {});
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Write `bytes` into a stream and read the same amount back. */
function roundTrip(stream, bytes, ms = 20000) {
  return new Promise((resolve) => {
    const back = [];
    let n = 0;
    const timer = setTimeout(() => resolve({ ok: false, got: n }), ms);
    stream.on('data', (d) => {
      back.push(d);
      n += d.length;
      if (n >= bytes.length) { clearTimeout(timer); resolve({ ok: sha(Buffer.concat(back).subarray(0, bytes.length)) === sha(bytes), got: n }); }
    });
    stream.on('error', () => {});
    stream.write(bytes);
  });
}

// ---------------------------------------------------------------------------
// The pretend network: a relay (STUN), a computer and a phone behind NATs
// ---------------------------------------------------------------------------

const RELAY_IP = '198.51.100.1';
const RELAY_PORT = 34443;

/** A computer (server side) and a phone (dialer) on a simulated network. */
function simPair(net, { pcIp, pcNat, phoneIp, phoneNat, session = {}, dialer = {} }) {
  const pcHost = net.host(pcIp, { nat: pcNat });
  const phoneHost = net.host(phoneIp, { nat: phoneNat });
  const accepted = [];
  const server = createDirectServer({
    acceptStream: (s) => { accepted.push(s); echoStreams(s); },
    relay: () => ({ host: RELAY_IP, port: RELAY_PORT }),
    enabled: () => true,
    endpointOptions: { createSocket: () => pcHost.createSocket('udp4'), interfaces: () => [{ address: pcIp, family: 'IPv4', internal: false }], ipv6: false },
    sessionOptions: session,
  });
  const d = createDirectDialer({
    // In the app this goes through the relay inside pinned TLS; here, straight to the computer.
    offer: (_desc, body) => server.offer(body, { who: 'phone' }),
    endpointOptions: { createSocket: () => phoneHost.createSocket('udp4'), interfaces: () => [{ address: phoneIp, family: 'IPv4', internal: false }], ipv6: false },
    sessionOptions: session,
    ...dialer,
  });
  const desc = { host: RELAY_IP, port: RELAY_PORT, id: 'abcdefghijklmnop0123', fp: 'a'.repeat(64) };
  return { server, dialer: d, desc, accepted, pcHost, phoneHost, close: () => { d.close(); server.close(); } };
}

/**
 * 1.5.48 (the user's phone): what the app and the page SAY about the road, and
 * which machine is home. Read from the sources (the phone app is not runnable here).
 */
export function phoneLabelChecks({ check }) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const machines = (read('public/app/main/11-machines.js') + read('public/app/main/11a-network.js'));
  const launcher = read('mobile/shell/launcher.js');
  const relayLinks = read('mobile/android/app/src/main/java/com/desk/assistant/RelayLinks.java');
  check('phone: 「全部机器」 is titled 全部机器 in the app too (not only on the computer itself), with 「N 台 · 这台是 …」',
    !/const grouped = local && rosterGrouped\(\)/.test(machines) && /const grouped = rosterGrouped\(\) && !singleVisit\(\)/.test(machines) && machines.includes('grouped ? `${(state.peerRoster || []).length + 1} 台 · 这台是 ${name}`'));
  // The user's phone showed the desktop window's menu rows (「Windows 电脑 — 这台电脑 · 只看这台」): only
  // window.desk.listMachines (Electron's preload) leads there; the app's shim has none, and the page refuses it in the app anyway.
  const shim = read('mobile/android/app/src/main/java/com/desk/assistant/MainActivity.java');
  check('phone: inside the app the page never takes the desktop window\'s machine menu (no 「这台电脑」 rows there)',
    !/listMachines/.test(shim) && machines.includes('machineBridge = window.NightshiftShell ? null : (await window.desk?.listMachines?.()) || null;')
    && /rows\.push\(\{ url: '', view: 'local'[^\n]*这台电脑 · 只看这台/.test(machines) && machines.indexOf("这台电脑 · 只看这台") > machines.indexOf('const others = machineBridge.machines'));
  check('phone: 「只看这台」 in the app says the road too (「Windows · 只看这台 · 局域网」), not just 只看这台 (1.5.48 beginner test)',
    machines.includes("singleVisit() && '只看这台', (!singleVisit() || throughPhoneRelay() || state.doorRoute) && pageRouteWords()"));
  check('phone: 关于 in the app hides the app\'s own way in (127.0.0.1:144xx) and says the phone is paired',
    read('public/app/main/04-bots.js').includes("for (const id of ['about-server', 'about-origin'])") && read('public/app/main/04-bots.js').includes('这部手机已经配对，经 Lamplit App 连到这台机器'));
  check('phone: a LAN path found by punching is said as 局域网, a direct one as 直连 (the page and the app list)',
    machines.includes("phoneRelayRoute(location.origin) === 'direct-lan'") && launcher.includes("relayRoute(best) === 'direct-lan' ? '局域网'"));
  check('phone: only a machine this app paired with itself becomes home (a machine learned from another one opens 只看这台)',
    launcher.includes('if (!entry.via) void store.set(KEYS.home, entry.url)') && launcher.includes("view: entry.via ? 'one' : 'all'") && launcher.includes('.filter((h) => !h.via)'));
  check('phone: the forwarder finds the login under the machine\'s main address (desk.hubs rows), not only under 127.0.0.1:144xx',
    relayLinks.includes('DirectChannel.tokenOwners(base,') && relayLinks.includes('"desk.hubs"'));
}

export async function directChecks({ check }) {
  // The channel's timers do not hold the process open (the hub does that); a test must.
  const keep = setInterval(() => {}, 1000);
  try {
    await directChecksInner({ check });
  } finally {
    clearInterval(keep);
  }
}

async function directChecksInner({ check }) {
  // --- the relay as STUN server -------------------------------------------
  {
    const { buf, txid } = stunRequest();
    const rinfo = { address: '203.0.113.7', port: 51234, family: 'IPv4' };
    const answer = stunAnswer(buf, rinfo);
    const mapped = answer && parseStunAnswer(answer, txid);
    check('STUN: the relay tells a caller the address and port it sees', mapped?.address === '203.0.113.7' && mapped?.port === 51234, JSON.stringify(mapped));
    check('STUN: the answer is never larger than the question (no amplification)', answer && answer.length <= buf.length, `${answer?.length} > ${buf.length}`);
    const v6 = stunAnswer(buf, { address: '2001:db8::7', port: 4000, family: 'IPv6' });
    const m6 = v6 && parseStunAnswer(v6, txid);
    check('STUN: IPv6 callers too, still no larger than the question', m6?.address === '2001:db8::7' && m6?.port === 4000 && v6.length <= buf.length, JSON.stringify(m6));
    check('STUN: a bare 20-byte request (anyone\'s STUN client) gets no answer', stunAnswer(buf.subarray(0, 20).fill(0, 2, 4), rinfo) === null);
    check('STUN: junk and our own channel packets get no answer', stunAnswer(Buffer.from('hello world, not stun at all, really'), rinfo) === null && stunAnswer(Buffer.alloc(60, 0xd1), rinfo) === null);
    check('STUN: an answer for another question is not taken', parseStunAnswer(answer, crypto.randomBytes(12)) === null);
  }
  {
    const relayId = makeSelfSignedCert({ commonName: 'lamplit-relay' });
    const relay = createRelay({ identity: relayId, joinSecret: crypto.randomBytes(18).toString('base64url'), limits: { stunPerIpPerMin: 60, stunBurst: 20 } });
    // TCP and UDP on one number: a number Windows keeps for UDP is skipped (test-ports.mjs, 1.5.63).
    const port = await listenRelay(relay, { stun: true });
    try {
      const probe = await udpProbe();
      const { buf, txid } = stunRequest();
      probe.s.send(buf, port, '127.0.0.1');
      await until(() => probe.got.length >= 1, 2000);
      const seen = probe.got[0] && parseStunAnswer(probe.got[0].m, txid);
      check('STUN: the relay answers on UDP, same port number as its TCP', seen?.address === '127.0.0.1' && seen?.port === probe.port, JSON.stringify(seen));
      const health = await checkRelay({ host: '127.0.0.1', port, relayFingerprint: relayId.fingerprint });
      check('STUN: the relay\'s health says it can answer (a new relay, not an old one)', health.ok && health.stun === true, JSON.stringify(health));
      probe.got.length = 0;
      for (let i = 0; i < 80; i += 1) probe.s.send(stunRequest().buf, port, '127.0.0.1');
      await sleep(300);
      check('STUN: a flood from one address is cut down to the limit', probe.got.length > 0 && probe.got.length <= 25, `${probe.got.length} answers`);
      probe.s.close();
    } finally {
      relay.close();
    }
  }

  // --- the channel's encryption --------------------------------------------
  {
    const sid = crypto.randomBytes(8);
    const a = crypto.randomBytes(32);
    const b = crypto.randomBytes(32);
    const k = deriveKeys(a, b, sid);
    const k2 = deriveKeys(a, b, sid);
    check('channel keys: both sides derive the same two keys, one per direction', k.c2s.equals(k2.c2s) && k.s2c.equals(k2.s2c) && !k.c2s.equals(k.s2c) && k.c2s.length === 32);
    const pkt = sealPacket(k.c2s, sid, 7, Buffer.from('hello'));
    const opened = openPacket(k.c2s, pkt);
    check('channel: a sealed packet opens with the right key', opened?.counter === 7 && opened.plain.toString() === 'hello' && pkt.length <= MAX_PACKET);
    check('channel: the address-free header shows only a session number and a counter', pkt[0] === 0xd1 && pkt.subarray(1, 9).equals(sid) && !pkt.includes(Buffer.from('hello')));
    const bent = Buffer.from(pkt);
    bent[bent.length - 20] ^= 1;
    check('channel: one changed bit and the packet is thrown away', openPacket(k.c2s, bent) === null);
    const head = Buffer.from(pkt);
    head[12] ^= 1;
    check('channel: a changed counter in the header is caught too', openPacket(k.c2s, head) === null);
    check('channel: the other direction\'s key cannot open it', openPacket(k.s2c, pkt) === null && openPacket(crypto.randomBytes(32), pkt) === null);
    const w = new ReplayWindow();
    const seq = [1, 2, 3, 5, 4, 5, 3, 2000, 1500, 900, 1999, 2000];
    const took = seq.map((n) => w.accept(n));
    check('channel: a replayed packet is refused, late ones inside the window are taken', JSON.stringify(took) === JSON.stringify([true, true, true, true, true, false, false, true, true, false, true, false]), JSON.stringify(took));
  }

  // --- candidates -----------------------------------------------------------
  {
    const raw = [
      { a: '203.0.113.9', p: 4000, k: 'srflx' }, { a: '192.168.1.20', p: 5000 }, { a: '2001:db8::1', p: 6000 },
      { a: '0.0.0.0', p: 1 }, { a: '224.0.0.1', p: 2 }, { a: '255.255.255.255', p: 3 }, { a: '127.0.0.1', p: 4 },
      { a: 'example.com', p: 5 }, { a: '10.0.0.1', p: 0 }, { a: '10.0.0.2', p: 70000 }, { a: 'fe80::1', p: 7 }, { a: 'ff02::1', p: 8 },
    ];
    const clean = cleanCandidates(raw);
    check('candidates: only real addresses (no 0.0.0.0, broadcast, multicast, loopback, names, link-local, bad ports)', clean.length === 3 && clean.map((c) => c.address).join() === '203.0.113.9,192.168.1.20,2001:db8::1', JSON.stringify(clean));
    const many = cleanCandidates(Array.from({ length: 30 }, (_, i) => ({ a: `198.51.100.${i + 2}`, p: 1000 + i })));
    check('candidates: at most 8 addresses per side (the computer never sprays packets)', many.length === 8);
    check('candidates: loopback only when a test allows it', cleanCandidates([{ a: '127.0.0.1', p: 9 }], { allowLoopback: true }).length === 1);
  }

  // --- delivery: loss, reordering, jitter -----------------------------------
  {
    const net = createSimNet({ latencyMs: 15, jitterMs: 10, loss: 0.05, reorder: 0.05, seed: 7 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const p = simPair(net, { pcIp: '203.0.113.20', pcNat: null, phoneIp: '203.0.113.30', phoneNat: null });
    try {
      const route = await p.dialer.kick(p.desc);
      check('direct: two public hosts connect directly', route === 'direct' && p.dialer.route(p.desc.id) === 'direct', JSON.stringify(p.dialer.info(p.desc.id)));
      const big = crypto.randomBytes(3 * 1024 * 1024);
      const s1 = p.dialer.stream(p.desc);
      const s2 = p.dialer.stream(p.desc);
      const [r1, r2] = await Promise.all([roundTrip(s1, big, 60000), roundTrip(s2, crypto.randomBytes(200 * 1024), 60000)]);
      check('direct: 3 MB out and back intact with 5% loss, reordering and jitter', r1.ok, `got ${r1.got}`);
      check('direct: two streams at once in one channel, each intact', r2.ok && p.accepted.length >= 2, `got ${r2.got}`);
      check('direct: the computer marks streams that came this way (never its own loopback)', p.accepted.every((s) => s.meta?.direct === true && s.meta?.ip === '203.0.113.30'), JSON.stringify(p.accepted.map((s) => s.meta)));
      const view = p.server.view();
      check('direct: the computer counts sessions and streams for Settings', view.up >= 1 && view.streams >= 2 && view.stun === 'yes', JSON.stringify(view));
    } finally {
      p.close();
    }
  }

  // --- hole punching through every kind of NAT ------------------------------
  {
    const kinds = ['full', 'restricted', 'port', 'symmetric'];
    const expect = (a, b) => !((a === 'symmetric' && (b === 'symmetric' || b === 'port')) || (b === 'symmetric' && a === 'port'));
    const results = await Promise.all(kinds.flatMap((pk, i) => kinds.map(async (fk, j) => {
      const net = createSimNet({ latencyMs: 10, seed: 11 + i * 4 + j });
      simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
      const pcNat = net.nat(`203.0.113.${100 + i * 4 + j}`, pk);
      const phoneNat = net.nat(`100.80.${i}.${j + 1}`, fk);
      const p = simPair(net, { pcIp: '192.168.1.5', pcNat, phoneIp: '10.20.30.40', phoneNat, session: { punchMs: 2500 } });
      try {
        const route = await p.dialer.kick(p.desc);
        let works = route === 'direct';
        if (works) works = (await roundTrip(p.dialer.stream(p.desc), crypto.randomBytes(5000), 5000)).ok;
        return { pk, fk, works, want: expect(pk, fk), info: p.dialer.info(p.desc.id) };
      } finally {
        p.close();
      }
    })));
    const wrong = results.filter((r) => r.works !== r.want);
    check('punching: every NAT pair behaves as expected (cone with cone works; symmetric with port-restricted or symmetric stays on the relay)', wrong.length === 0, JSON.stringify(wrong));
    const failed = results.find((r) => !r.want);
    check('punching: a pair that cannot punch says so quietly (route relay, a reason, a later retry)', failed && failed.info.route === 'relay' && /punch/.test(failed.info.reason || '') && failed.info.nextTry > Date.now(), JSON.stringify(failed?.info));
  }
  {
    // One home: the phone on the same Wi-Fi reaches the computer on its LAN address even behind a symmetric NAT.
    const net = createSimNet({ latencyMs: 2 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const home = net.nat('203.0.113.50', 'symmetric');
    const p = simPair(net, { pcIp: '192.168.1.5', pcNat: home, phoneIp: '192.168.1.9', phoneNat: home, session: { punchMs: 2000 } });
    try {
      const route = await p.dialer.kick(p.desc);
      check('punching: on the same Wi-Fi the LAN address works, whatever the router', route === 'direct' && p.accepted.length === 0 && p.dialer.info(p.desc.id).remote?.address === '192.168.1.5', JSON.stringify(p.dialer.info(p.desc.id)));
    } finally {
      p.close();
    }
  }
  {
    // UDP blocked on the phone's network (some offices): nothing direct, no error, the relay goes on.
    const net = createSimNet({ latencyMs: 5 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const office = net.nat('203.0.113.60', 'full');
    office.blocked = true;
    const p = simPair(net, { pcIp: '203.0.113.61', pcNat: null, phoneIp: '10.1.1.1', phoneNat: office, session: { punchMs: 1500 } });
    try {
      const route = await p.dialer.kick(p.desc);
      check('fallback: UDP blocked -> stays on the relay, nothing thrown', route === 'relay' && p.dialer.stream(p.desc) === null);
      const again = await p.dialer.kick(p.desc);
      check('fallback: no new attempt before the retry time (1 min, then 5, then 15)', again === 'relay' && p.dialer.info(p.desc.id).failures === 1);
      p.dialer.reset();
      check('fallback: a network change clears the wait, the next connection tries again', p.dialer.info(p.desc.id).nextTry === 0);
    } finally {
      p.close();
    }
  }
  {
    // Up, then the path dies (the phone walked out of Wi-Fi): back to the relay, by itself.
    const net = createSimNet({ latencyMs: 5 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const p = simPair(net, { pcIp: '203.0.113.70', pcNat: null, phoneIp: '203.0.113.71', phoneNat: null, session: { punchMs: 1500, pingMs: 200, deadMs: 1200 } });
    try {
      await p.dialer.kick(p.desc);
      const s = p.dialer.stream(p.desc);
      const before = await roundTrip(s, Buffer.from('ping'), 3000);
      net.set({ loss: 1 });
      const fell = await until(() => p.dialer.route(p.desc.id) === 'relay', 4000);
      check('fallback: a dead path is noticed by its heartbeat and dropped (new connections use the relay)', before.ok && fell && p.dialer.stream(p.desc) === null);
      check('fallback: the computer drops it too', await until(() => p.server.view().sessions === 0, 4000), JSON.stringify(p.server.view()));
      check('fallback: after a working direct link died, the next try comes soon (not in 15 minutes)', p.dialer.info(p.desc.id).nextTry - Date.now() < 15000, JSON.stringify(p.dialer.info(p.desc.id)));
    } finally {
      p.close();
    }
  }
  {
    // The phone's NAT gives it a new outside port mid-way (it does, after idling): the channel follows.
    const net = createSimNet({ latencyMs: 5 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const nat = net.nat('203.0.113.80', 'full');
    const p = simPair(net, { pcIp: '203.0.113.81', pcNat: null, phoneIp: '10.9.9.9', phoneNat: nat, session: { punchMs: 1500 } });
    try {
      await p.dialer.kick(p.desc);
      const s = p.dialer.stream(p.desc);
      await roundTrip(s, Buffer.from('one'), 3000);
      nat.out.clear(); // the next packet leaves from a new outside port
      const after = await roundTrip(s, crypto.randomBytes(30000), 5000);
      check('roaming: a new outside port mid-way, the computer follows it (like WireGuard)', after.ok, JSON.stringify(after));
    } finally {
      p.close();
    }
  }
  {
    // Strangers and the computer itself cannot use the channel.
    const net = createSimNet({ latencyMs: 2 });
    simStun(net, RELAY_IP, RELAY_PORT, stunAnswer);
    const p = simPair(net, { pcIp: '203.0.113.90', pcNat: null, phoneIp: '203.0.113.91', phoneNat: null, session: { punchMs: 1500 } });
    try {
      await p.dialer.kick(p.desc);
      const sid = Buffer.from(p.dialer.info(p.desc.id).sid, 'hex');
      const stranger = net.host('203.0.113.99').createSocket('udp4');
      stranger.bind(7777);
      const port = p.server.view().port;
      for (let i = 0; i < 50; i += 1) {
        stranger.send(sealPacket(crypto.randomBytes(32), sid, 1000 + i, Buffer.from([0x03])), port, '203.0.113.90');
        stranger.send(crypto.randomBytes(200), port, '203.0.113.90');
      }
      await sleep(100);
      const still = await roundTrip(p.dialer.stream(p.desc), Buffer.from('still mine'), 3000);
      check('security: forged packets (right session, wrong key) and junk are ignored; the path does not move to the stranger', still.ok && p.dialer.info(p.desc.id).remote?.address === '203.0.113.90' && p.server.view().remotes.every((r) => r === '203.0.113.91'), JSON.stringify(p.server.view()));
      const muxes = p.server.muxes();
      const pushed = muxes[0].open({});
      const reset = await new Promise((resolve) => { pushed.on('close', () => resolve(true)); pushed.on('error', () => {}); setTimeout(() => resolve(false), 2000); });
      check('security: the computer cannot open a connection into the phone (only the phone opens)', reset);
      let bad = '';
      try { await p.server.offer({ v: 1, sid: 'zz', half: 'x', cands: [] }, { who: 'x' }); } catch (err) { bad = err.code; }
      check('security: a malformed offer is refused', bad === 'DIRECT_BAD_OFFER');
      const codes = [];
      for (let i = 0; i < 14; i += 1) {
        try {
          await p.server.offer({ v: 1, sid: crypto.randomBytes(8).toString('hex'), half: crypto.randomBytes(32).toString('base64url'), cands: [] }, { who: 'eager' });
          codes.push('ok');
        } catch (err) { codes.push(err.code); }
      }
      check('security: even a paired device gets only a few tries a minute (each one makes the computer send probes)', codes.filter((c) => c === 'ok').length === 12 && codes.slice(12).every((c) => c === 'DIRECT_BUSY'), JSON.stringify(codes));
      check('security: and at most 4 sessions per device at once (older ones close)', p.server.view().sessions <= 5, JSON.stringify(p.server.view()));
      await sleep(1800);
      const v = p.server.view();
      check('status: after an earlier success, a later failed try is what Settings and 体检 say (the latest, not the first)', v.up >= 1 && v.last === 'failed', JSON.stringify(v));
    } finally {
      p.close();
    }
  }
}

// ---------------------------------------------------------------------------
// The real hub (run from smoke.mjs): paired devices only, still remote
// ---------------------------------------------------------------------------

export async function directServerChecks({ check, api, makePairLink }) {
  const keep = setInterval(() => {}, 1000);
  try {
    await directServerChecksInner({ check, api, makePairLink });
  } finally {
    clearInterval(keep);
  }
}

async function directServerChecksInner({ check, api, makePairLink }) {
  const relayId = makeSelfSignedCert({ commonName: 'lamplit-relay' });
  const join = crypto.randomBytes(18).toString('base64url');
  const seen = [];
  const relay = createRelay({ identity: relayId, joinSecret: join, tap: (_id, _dir, bytes) => seen.push(Buffer.from(bytes)) });
  // Its STUN starts later on the same number: one UDP can have too (test-ports.mjs, 1.5.63).
  const relayPort = await listenRelay(relay);
  let dialer = null;
  try {
    const on = await api('/api/relay-link', { method: 'PUT', body: { enabled: true, host: '127.0.0.1', port: relayPort, relayFingerprint: relayId.fingerprint, join } });
    check('direct (hub): the relay link is on, and 「先试直连」 is on by default', on.status === 200 && on.body.direct?.enabled === true, JSON.stringify(on.body.direct));
    await until(async () => (await api('/api/relay-link')).body.state === 'online', 8000);
    // A relay from before 1.5.46 (no STUN): 体检 says to update it, as a note, not a problem.
    const old = ((await api('/api/checkup')).body.items || []).find((it) => it.id === 'direct');
    check('direct (hub): with an old relay, 体检 says it works through the relay, and how to update it for direct (a note, not a problem)', old?.state === 'info' && /^现在都走中转，能用/.test(old.text) && /中转要更新一次/.test(old.text) && /重装/.test(old.text) && new RegExp(`UDP ${relayPort}`).test(old.text), JSON.stringify(old));
    const oldCard = (await api('/api/relay-link?probe=1')).body.direct;
    check('direct (hub): a relay without STUN is named as old (update it), not as a firewall problem', oldCard?.stun === 'no' && oldCard.stunCause === 'old', JSON.stringify(oldCard));
    // A new relay whose UDP the cloud firewall still drops: card and 体检 both say only the firewall rule is missing (1.5.47 beginner test).
    let firewall = true;
    await relay.listenStun(relayPort, '127.0.0.1', { drop: () => firewall });
    const fwCard = (await api('/api/relay-link?probe=1')).body.direct;
    const fwItem = ((await api('/api/checkup')).body.items || []).find((it) => it.id === 'direct');
    check('direct (hub): UDP dropped by a firewall in front of a new relay: card and 体检 say to add the firewall rule, not to reinstall', fwCard?.stun === 'no' && fwCard.stunCause === 'firewall' && /还差一步/.test(fwItem?.text || '') && !/重装/.test(fwItem?.text || ''), JSON.stringify({ fwCard, fwItem }));
    firewall = false;
    // The human opened UDP in the firewall (here: the relay answers now) and looks again (1.5.47):
    // the card when opened, then 「重新体检」. Neither may repeat the old 'no'.
    // A relay that cannot update itself (here: no updater, like one from before 1.5.47 that never answers):
    // the card and 体检 say one last manual 「重装」 is needed, as a note.
    const seen1546 = (await api('/api/relay-link')).body.relay;
    const upd = ((await api('/api/checkup')).body.items || []).find((it) => it.id === 'relay-update');
    check('relay update (hub): a relay that does not update itself is named as such: one last 「重装」, then it updates with Lamplit', seen1546?.auto === false && upd?.state === 'info' && /最后一次手动/.test(upd.text), JSON.stringify({ seen1546, upd }));
    const asked0 = relay.stats().stun;
    const again = ((await api('/api/checkup')).body.items || []).find((it) => it.id === 'direct');
    check('direct (hub): 「重新体检」 asks the relay again: once its UDP answers, 体检 no longer says it cannot', again && !/要更新一次|还差一步/.test(again.text) && again.state !== 'bad' && relay.stats().stun > asked0, JSON.stringify(again));
    const asked1 = relay.stats().stun;
    const card = (await api('/api/relay-link?probe=1')).body;
    check('direct (hub): the relay card asks the relay again when opened (not an old answer)', card.direct?.stun === 'yes' && relay.stats().stun > asked1, JSON.stringify(card.direct));
    const asked2 = relay.stats().stun;
    await api('/api/relay-link');
    check('direct (hub): the card\'s 15 s refresh does not ask the relay each time (cheap)', relay.stats().stun === asked2);
    const desc = { ...(await api('/api/relay-link')).body.descriptor, host: '127.0.0.1', port: relayPort };
    const made = await makePairLink();
    const paired = await relayFetch(desc, '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: made.token, client: 'app' }) });
    const token = (await paired.json()).token;

    const sid = crypto.randomBytes(8).toString('hex');
    const half = crypto.randomBytes(32).toString('base64url');
    const anon = await relayFetch(desc, '/api/direct/offer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, sid, half, cands: [{ a: '127.0.0.1', p: 9 }] }) });
    check('direct (hub): without a device token nobody can ask for direct (the relay cannot introduce strangers)', anon.status === 401);

    let offeredBody = '';
    dialer = createDirectDialer({
      allowLoopback: true,
      endpointOptions: { interfaces: () => [], ipv6: false, bindHost: '127.0.0.1' },
      offer: async (d, body) => {
        offeredBody = JSON.stringify(body);
        const res = await relayFetch(d, '/api/direct/offer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: offeredBody });
        if (!res.ok) throw Object.assign(new Error(`offer HTTP ${res.status}`), { code: 'DIRECT_OFFER_FAILED' });
        return res.json();
      },
    });
    seen.length = 0;
    const route = await dialer.kick(desc);
    check('direct (hub): a paired device punches through to the hub over UDP', route === 'direct', JSON.stringify(dialer.info(desc.id)));
    const relayBytes = Buffer.concat(seen);
    const cand = JSON.parse(offeredBody).cands[0];
    check('direct (hub): the relay never sees the addresses or the key half (only TLS ciphertext crossed it)', relayBytes.length > 0 && !relayBytes.includes(Buffer.from(JSON.parse(offeredBody).half)) && !relayBytes.includes(Buffer.from(String(cand.p))) && !relayBytes.includes(Buffer.from('cands')));

    // 1.5.48: which device holds a direct session, by name and kind, never by address.
    // The computer counts a session once the device's SELECT arrives, a moment after the
    // device itself says "direct" (CI on Linux asked in between): wait for that, briefly.
    const held = await until(async () => {
      const d = (await api('/api/relay-link')).body.direct;
      return d?.holders?.length ? d : null;
    }, 3000) || (await api('/api/relay-link')).body.direct;
    check('direct (hub): Settings says WHO is connected directly (a named device, no address)', Array.isArray(held?.holders) && held.holders.length >= 1 && held.holders.every((h) => h.name && h.kind && !/\d+\.\d+\.\d+\.\d+|::/.test(JSON.stringify(h))), JSON.stringify(held?.holders));

    const viaDirect = (p, init = {}) => relayFetch(desc, p, { ...init, direct: dialer });
    seen.length = 0;
    const r1 = await viaDirect('/api/direct/route', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    check('direct (hub): the hub knows a request came directly (for 「直连」 in the list)', r1.route === 'direct', JSON.stringify(r1));
    check('direct (hub): that request did not go through the relay', seen.length === 0);
    const a = await viaDirect('/api/auth').then((r) => r.json());
    const localAuth = (await api('/api/auth')).body;
    check('direct (hub): /api/auth tells the page the 8-digit code cannot be used through the relay or direct (so it does not offer it), and can at the computer', a.codeAllowed === false && localAuth?.codeAllowed === true, JSON.stringify({ a, localAuth }));
    check('direct (hub): a direct request is still remote: not the human at the computer', a.mode === 'none' && a.authorized === false, JSON.stringify(a));
    const bots = await viaDirect('/api/bots');
    check('direct (hub): without a token nothing is served directly either', bots.status === 401);
    const eight = await viaDirect('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '12345678' }) });
    check('direct (hub): the 8-digit code is refused directly too', eight.status === 403);
    const localOnly = await viaDirect('/api/remote/push-update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    check('direct (hub): local-only routes refuse a direct caller', localOnly.status === 403);
    const ok = await viaDirect('/api/bots', { headers: { authorization: `Bearer ${token}` } });
    check('direct (hub): with the device token the hub answers directly', ok.status === 200);

    // A direct path that went quiet (the computer restarted): this connection
    // goes through the relay after a short wait, and the link is dropped so the next ones do not wait.
    let dropped = '';
    const silent = { stream: () => new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }), drop: (id) => { dropped = id; }, kick: async () => 'relay' };
    const t0 = Date.now();
    const viaRelayAfterStall = await connectViaRelay(desc, { direct: silent }).then((s) => { s.destroy(); return !s.viaDirect; }, () => false);
    check('fallback (hub): a direct path that stopped answering costs one connection a few seconds, then the relay; the link is dropped', viaRelayAfterStall && dropped === desc.id && Date.now() - t0 < 9000, `${Date.now() - t0} ms, dropped ${dropped}`);

    let pinned = '';
    try { await connectViaRelay({ ...desc, fp: 'b'.repeat(64) }, { direct: dialer }); } catch (err) { pinned = err.code; }
    check('direct (hub): the computer\'s certificate is still pinned on the direct path', pinned === 'RELAY_CERT_MISMATCH', pinned);

    const view = (await api('/api/relay-link')).body;
    check('direct (hub): Settings shows the direct link (sessions, connections, the relay answers STUN)', view.direct?.up >= 1 && view.direct?.streams >= 1 && view.direct?.stun === 'yes', JSON.stringify(view.direct));
    const checkup = (await api('/api/checkup')).body;
    const item = (checkup.items || []).find((it) => it.id === 'direct');
    check('direct (hub): 体检 has a 「直连」 line, never red', item && item.state !== 'bad' && item.state !== 'warn', JSON.stringify(item));

    // Another of the owner's machines reaching this hub only through the relay (peers.mjs).
    const peersFile = path.join(os.tmpdir(), `lamplit-direct-peers-${process.pid}.json`);
    const peers = createPeers({ file: peersFile, directWanted: () => true, directOptions: { allowLoopback: true, endpointOptions: { interfaces: () => [], ipv6: false, bindHost: '127.0.0.1' } } });
    try {
      await peers.set([{ name: 'home', url: 'http://127.0.0.1:9', token, relay: desc }]);
      const peer = peers.find('home');
      const first = await peers.call(peer, 'GET', '/api/health', { timeoutMs: 8000 });
      await first.text();
      const wentDirect = await until(() => peers.directRoute(peer) === 'direct', 10000);
      const second = await peers.call(peer, 'GET', '/api/health', { timeoutMs: 8000 });
      await second.text();
      check('direct (machines): a machine reached through the relay goes direct from the next call on', first.viaRelay && wentDirect && second.viaDirect === true && second.ok);
    } finally {
      peers.resetDirect();
      fs.rmSync(peersFile, { force: true });
    }

    // 1.5.48: on the relay's own server (its tunnel dials 127.0.0.1) 「中转」 is the road on purpose: the page is told so.
    const notHere = (await api('/api/direct/route')).body;
    await api('/api/relay-link', { method: 'PUT', body: { dial: '127.0.0.1' } });
    const here = (await api('/api/direct/route')).body;
    await api('/api/relay-link', { method: 'PUT', body: { dial: '' } });
    await until(async () => (await api('/api/relay-link')).body.state === 'online', 8000);
    check('relay host: a machine that is the relay\'s own server tells its pages so (「经中转（中转就在这台上）」), others do not', here?.relayHere === true && notHere?.relayHere === false, JSON.stringify({ here, notHere }));

    // The desktop window on a machine only the relay reaches (1.5.47): its loopback door goes direct too.
    await api('/api/peers', { method: 'PUT', body: { peers: [{ name: 'far', url: 'http://127.0.0.1:9', token, relay: desc }] } });
    const door = await api('/api/remote/relay-door', { method: 'POST', body: { url: 'http://127.0.0.1:9' } });
    let doorRoutes = [];
    if (door.status === 200) {
      for (let i = 0; i < 12 && !doorRoutes.includes('direct'); i += 1) {
        // A new connection each time (no keep-alive): each one picks its road anew.
        const r = await new Promise((resolve) => {
          http.get(`${door.body.url}/api/direct/route`, { agent: false, headers: { authorization: `Bearer ${token}` } }, (res) => {
            let t = '';
            res.on('data', (d) => { t += d; });
            res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve({}); } });
          }).on('error', () => resolve({}));
        });
        doorRoutes.push(r.route);
        await sleep(400);
      }
    }
    check('direct (desktop window): a machine only the relay reaches opens through its door, first through the relay, then directly', door.status === 200 && doorRoutes[0] === 'relay' && doorRoutes.includes('direct'), JSON.stringify({ door, doorRoutes }));
    await api('/api/peers', { method: 'PUT', body: { peers: [] } });

    const off = await api('/api/relay-link', { method: 'PUT', body: { direct: false } });
    check('direct (hub): 「先试直连」 can be turned off; open direct links close', off.status === 200 && off.body.direct?.enabled === false && (await until(() => dialer.route(desc.id) === 'relay', 6000)));
    const refused = await relayFetch(desc, '/api/direct/offer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ v: 1, sid, half, cands: [] }) });
    check('direct (hub): when off, offers are refused (the relay keeps working)', refused.status === 409);
    const still = await relayFetch(desc, '/api/bots', { headers: { authorization: `Bearer ${token}` }, direct: dialer });
    check('direct (hub): with direct gone, the same call falls back to the relay by itself', still.status === 200);
    await api('/api/relay-link', { method: 'PUT', body: { direct: true } });
    await api('/api/relay-link', { method: 'PUT', body: { enabled: false } });
  } finally {
    dialer?.close();
    relay.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };
  directChecks({ check }).then(() => {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}
