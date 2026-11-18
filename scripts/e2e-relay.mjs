#!/usr/bin/env node
/**
 * e2e-relay.mjs - the relay end to end on this computer (第 1 步原型).
 *
 * Starts, all on 127.0.0.1 and in temporary folders that are deleted after:
 *   - the relay program itself (hub/relay/relay.mjs, as its own process),
 *   - two Lamplit hubs "A" and "B" (demo model),
 * then acts as the phone app does through its relay forwarder: pairs with A
 * through the relay, chats, follows the event stream, decides an approval;
 * and as the machines do: A shares the relay with B, learns B's relay address,
 * and reaches B through the relay alone. Prints timings and bytes.
 *
 *   node scripts/e2e-relay.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { relayFetch } from '../src/relaylink.mjs';
import { createPeers } from '../src/peers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-e2e-relay-'));
const procs = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(ok ? `PASS  ${name}` : `FAIL  ${name}${detail ? `  <- ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

function startProcess(args, env = {}) {
  const proc = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.push(proc);
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-6000); });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no ready line in 25 s\n${err}`)), 25000);
    proc.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const j = JSON.parse(line.trim());
          if (j.event === 'ready') { clearTimeout(timer); resolve({ proc, ready: j }); }
        } catch { /* not yet */ }
      }
    });
    proc.on('exit', (code) => reject(new Error(`exited ${code}\n${err}`)));
  });
}

async function startHub(name) {
  const home = path.join(tmp, name);
  for (const dir of ['config', 'skills', 'public', 'workspace']) fs.cpSync(path.join(REPO, dir), path.join(home, dir), { recursive: true });
  fs.cpSync(path.join(REPO, 'scripts', 'fixtures', 'bots'), path.join(home, 'config', 'bots'), { recursive: true });
  const { proc, ready } = await startProcess([path.join(REPO, 'src', 'server.mjs')], {
    ASSIST_HOME: home, ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'),
    ASSIST_MODEL_PROVIDER: 'mock', PORT: '0', HOST: '127.0.0.1', DESK_VNC_PORT: '1', ASSIST_PUBLIC_PORT: '24391',
    CHROME_PATH: path.join(home, 'no-browser.exe'),
  });
  const key = fs.readFileSync(path.join(home, 'data', 'local-key'), 'utf8').trim();
  const api = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`${ready.url}${p}`, { method, headers: { 'x-lamplit-local': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { name, home, url: ready.url, api, proc };
}

/** An SSE reader over a relay Response. */
function events(res) {
  const list = [];
  const waiters = [];
  (async () => {
    const reader = res.body.getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      text += Buffer.from(value).toString('utf8');
      let i;
      while ((i = text.indexOf('\n\n')) >= 0) {
        const block = text.slice(0, i);
        text = text.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { const e = JSON.parse(line.slice(6)); list.push(e); waiters.forEach((w) => w()); } catch { /* skip */ }
        }
      }
    }
  })();
  return {
    list,
    async waitFor(pred, ms = 15000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = list.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error('event did not come');
        await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
      }
    },
  };
}

async function main() {
  // --- the relay ---------------------------------------------------------------
  const relayData = path.join(tmp, 'relay');
  const relay = await startProcess([path.join(REPO, 'hub', 'relay', 'relay.mjs'), '--port', '0', '--host', '127.0.0.1', '--data', relayData]);
  const relayPort = relay.ready.port;
  const relayFp = relay.ready.fingerprint;
  const join = fs.readFileSync(path.join(relayData, 'join-secret'), 'utf8').trim();
  check('relay process starts and prints its certificate fingerprint', relayPort > 0 && /^[0-9a-f]{64}$/.test(relayFp));

  const A = await startHub('A');
  const B = await startHub('B');
  check('two Lamplit hubs started (loopback only, no LAN, no Tailscale)', Boolean(A.url && B.url));

  // --- computer A on the relay -------------------------------------------------
  const on = await A.api('/api/relay-link', { method: 'PUT', body: { enabled: true, host: '127.0.0.1', port: relayPort, relayFingerprint: relayFp, join } });
  check('A: 通过中转连接 turned on', on.status === 200 && on.body.enabled, JSON.stringify(on.body));
  check('A: tunnel online', await until(async () => (await A.api('/api/relay-link')).body.state === 'online'));
  const descA = (await A.api('/api/relay-link')).body.descriptor;

  // --- the phone, through the relay ------------------------------------------
  const link = (await A.api('/api/pairing/link', { method: 'POST' })).body;
  check('A: a pairing code exists with only the relay (no LAN)', Boolean(link?.qr && link.relay?.id === descA.id), JSON.stringify(link));
  const qr = new URL(link.qr);
  check('A: the QR code carries relay=, rid= and rfp=, and a placeholder origin', qr.hostname.endsWith('.relay.invalid') && qr.searchParams.get('relay') === `127.0.0.1:${relayPort}` && qr.searchParams.get('rfp') === descA.fp);
  const phone = (p, init = {}) => relayFetch(descA, p, init);
  const paired = await (await phone('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link.token, client: 'app', deviceName: 'e2e phone' }) })).json();
  check('phone: paired through the relay', String(paired.token || '').length >= 16);
  const auth = { authorization: `Bearer ${paired.token}` };

  // Latency: a small request, direct vs through the relay (both on this computer).
  const time = async (fn, n = 20) => { const t = []; for (let i = 0; i < n; i += 1) { const s = process.hrtime.bigint(); await fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); } t.sort((a, b) => a - b); return t[Math.floor(n / 2)]; };
  const direct = await time(() => fetch(`${A.url}/api/health`).then((r) => r.text()));
  const viaRelay = await time(() => phone('/api/health', { headers: auth }).then((r) => r.text()));
  console.log(`      /api/health median: direct ${direct.toFixed(1)} ms, through the relay ${viaRelay.toFixed(1)} ms (new TLS connection each time)`);

  const ctrl = new AbortController();
  const chiefStream = events(await phone('/api/stream?botId=chief', { headers: { ...auth, accept: 'text/event-stream' }, signal: ctrl.signal }));
  const stream = events(await phone('/api/stream?botId=ops', { headers: { ...auth, accept: 'text/event-stream' }, signal: ctrl.signal }));
  const sent = await (await phone('/api/bots/chief/message', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好，经过中转' }) })).json();
  check('phone: chat message accepted through the relay', Boolean(sent.turnId), JSON.stringify(sent));
  const ended = await chiefStream.waitFor((e) => e.type === 'turn.end' && e.turnId === sent.turnId).catch(() => null);
  check('phone: the turn finishes and the event stream says so', ended?.status === 'success', JSON.stringify(ended));
  const ask = await (await phone('/api/bots/ops/message', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Write a note outside the workspace: relay' }) })).json();
  const request = await stream.waitFor((e) => e.type === 'approval.request').catch(() => null);
  check('phone: an approval card arrives over the relay', Boolean(request?.approvalId));
  const decided = await phone(`/api/approvals/${request?.approvalId}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', note: 'e2e via relay' }) });
  check('phone: the approval is decided through the relay', decided.status === 200);
  const after = await stream.waitFor((e) => e.type === 'turn.end' && e.turnId === ask.turnId).catch(() => null);
  check('phone: the turn goes on after the approval', after?.status === 'success');
  ctrl.abort();
  const page = await phone('/', { headers: auth });
  const html = await page.text();
  check('phone: the app page itself loads through the relay', page.status === 200 && /<html/i.test(html));

  // Reconnect: the relay restarts, A comes back by itself.
  relay.proc.kill();
  await sleep(500);
  const relay2 = await startProcess([path.join(REPO, 'hub', 'relay', 'relay.mjs'), '--port', String(relayPort), '--host', '127.0.0.1', '--data', relayData]);
  const t0 = Date.now();
  const back = await until(async () => (await A.api('/api/relay-link')).body.state === 'online', 70000);
  check(`A: after the relay restarted, the tunnel came back by itself (${((Date.now() - t0) / 1000).toFixed(1)} s)`, back && relay2.ready.fingerprint === relayFp);
  const again = await phone('/api/auth', { headers: auth }).then((r) => r.json());
  check('phone: the same login works after the reconnect', again.authorized === true && again.mode === 'token');

  // --- machine to machine (3.6) -------------------------------------------------
  const bLink = (await B.api('/api/pairing/link', { method: 'POST' })).body;
  void bLink; // B has no LAN and no relay yet: pair A with B over loopback the way the desktop does
  const bCode = await fetch(`${B.url}/api/pairing`, { headers: { 'x-lamplit-local': fs.readFileSync(path.join(B.home, 'data', 'local-key'), 'utf8').trim() } }).then((r) => r.json());
  const bPair = await fetch(`${B.url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bCode.code, client: 'app', deviceName: 'A' }) }).then((r) => r.json());
  check('B: A holds a token for B', String(bPair.token || '').length >= 16);
  await A.api('/api/peers', { method: 'PUT', body: { peers: [{ name: 'B', url: B.url, token: bPair.token }] } });
  // 「让其他机器也用这个中转」 sends B these settings over the machines' link.
  // Here both hubs are on one computer, so B counts A's loopback call as "a
  // program on this computer" and refuses it - on real machines it comes from
  // a LAN or Tailscale address with A's token. So: check the refusal, then
  // hand B the same settings the way the share would.
  const shared = await A.api('/api/relay-link/share', { method: 'POST' });
  check('A → B: the share asks B (refused here only because both are on one computer)', shared.status === 200 && shared.body?.machines?.length === 1, JSON.stringify(shared.body));
  const bOn = await B.api('/api/relay-link', { method: 'PUT', body: { enabled: true, host: '127.0.0.1', port: relayPort, relayFingerprint: relayFp, join } });
  check('B: 通过中转连接 turned on with A\'s relay', bOn.status === 200 && bOn.body.enabled);
  check('B: tunnel online', await until(async () => (await B.api('/api/relay-link')).body.state === 'online'));
  const descB = (await B.api('/api/relay-link')).body.descriptor;
  check('B: its own id and certificate, not A\'s', descB && descB.id !== descA.id && descB.fp !== descA.fp);
  // A learns B's relay address, then B's direct address goes dead.
  check('A: learned B\'s relay address', await until(async () => (await A.api('/api/peers')).body.peers?.[0]?.relay?.id === descB.id, 10000));
  await A.api('/api/peers', { method: 'PUT', body: { peers: [{ name: 'B', url: 'http://127.0.0.1:9', token: bPair.token }] } });
  const peers = (await A.api('/api/peers')).body.peers;
  check('A: B\'s relay address survives a new machine list without it', peers?.[0]?.relay?.id === descB.id);
  const t1 = Date.now();
  const machines = (await A.api('/api/machines')).body.machines;
  check('A → B: B is online through the relay alone', machines.find((m) => m.name === 'B')?.online === true, JSON.stringify(machines));
  const handoff = await A.api('/api/machines/B/handoff', { method: 'POST' });
  check(`A → B: a call to B goes through the relay (${Date.now() - t1} ms incl. the dead address)`, handoff.status === 200 && handoff.body?.ok && handoff.body.relay?.id === descB.id && /[?&]pair=/.test(handoff.body.url || ''), JSON.stringify(handoff.body));
  const roster = await A.api('/api/peers/pages');
  check('A → B: a read from B through the relay', roster.status === 200 && Array.isArray(roster.body?.machines), JSON.stringify(roster.body).slice(0, 200));

  // Group work across machines (crossmachine.mjs) is peers.json/call: the same
  // calls, made here with a peer list whose only working address is the relay.
  const peersFile = path.join(tmp, 'peers-test.json');
  fs.writeFileSync(peersFile, JSON.stringify([{ name: 'B', url: 'http://127.0.0.1:9', token: bPair.token, relay: descB }]));
  const peersMod = createPeers({ file: peersFile });
  await peersMod.load();
  const peerB = peersMod.find('B');
  const t2 = Date.now();
  const work = await peersMod.json(peerB, 'POST', '/api/bots/chief/message', { body: { text: '从 A 派来的活（经过中转）' }, timeoutMs: 20000 }).catch((e) => ({ error: e.message }));
  check(`A → B: a bot on B takes a task through the relay (${Date.now() - t2} ms)`, Boolean(work.turnId), JSON.stringify(work));
  const reply = await until(async () => {
    const m = await peersMod.json(peerB, 'GET', '/api/bots/chief/messages?limit=20', { timeoutMs: 10000 });
    return (m.messages || m || []).some((x) => x.role === 'assistant');
  }, 15000);
  check('A → B: and its answer is read back through the relay', reply);
  fs.mkdirSync(path.join(B.home, 'workspace'), { recursive: true });
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const up = await peersMod.json(peerB, 'PUT', '/api/workspace/file?path=relay-test.bin', { raw: bytes, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: 60000 }).catch((e) => ({ error: e.message }));
  const down = await peersMod.call(peerB, 'GET', '/api/workspace/file?path=relay-test.bin', { timeoutMs: 60000 }).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b)).catch(() => Buffer.alloc(0));
  check('A → B: a 2 MB file goes to B and back through the relay (moving work between machines)', !up.error && down.equals(bytes), JSON.stringify(up).slice(0, 200));

  // --- bytes and cleanup --------------------------------------------------------
  const va = (await A.api('/api/relay-link')).body;
  console.log(`      A through the relay: ${va.connections} connections, in ${va.bytesIn} B, out ${va.bytesOut} B (since the last reconnect)`);
  const offA = await A.api('/api/relay-link', { method: 'PUT', body: { enabled: false } });
  check('A: turned off', offA.body.enabled === false && (await until(async () => (await phone('/api/health').then(() => false, () => true)), 5000)));
}

main()
  .catch((err) => check('e2e ran without throwing', false, err.stack))
  .finally(async () => {
    for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
    await sleep(800);
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r).length;
    console.log(`\nRESULT  ${results.length - failed}/${results.length} end-to-end checks passed`);
    process.exit(failed ? 1 : 0);
  });
