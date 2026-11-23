// One scenario, start to end: hubs, fresh 「评测-」 bots and a group, the scripted human, the evidence,
// the nine invariants, and everything removed afterwards.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startTestHub, attachHub, recordEvents, scratchRoot } from './hubs.mjs';
import { startFakeModel } from './fakemodel.mjs';
import { peerVia } from './peer.mjs';
import { SITES } from './mocksites.mjs';
import { makeHuman, runTimeline } from './human.mjs';
import { checkAll, metricsOf } from './invariants.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts || '') || 0);
const listOf = (x, ...keys) => (Array.isArray(x) ? x : keys.map((k) => x?.[k]).find(Array.isArray) || []);
const MACHINE = { A: '评测机甲', B: '评测机乙' };

function walk(root, skip = (rel) => /^(uploads|\.|eval)(\/|$)/.test(rel)) {
  const out = [];
  const go = (dir, rel) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) go(abs, r);
      else { const st = fs.statSync(abs); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); }
    }
  };
  go(root, '');
  return out;
}

/**
 * Run one scenario. opts:
 *   mode 'fake' | 'real'; plant: Set of planted violations (fake only); mock: the mock sites;
 *   real: { hub: {url,key}, peer: {url, name} | null, model: profile id } to attach, or { settings } for test hubs with a real model;
 *   peerDrop: 'cut' (switch the other test hub off and on) | 'pause' (the first hub pauses its link to it);
 *     a machine that is not a test hub of this run is only ever paused.
 *   log; keep (leave the test hubs' folders)
 */
export async function runScenario(sc, { mode = 'fake', plant = new Set(), mock, real = null, log = () => {}, keep = false, runId = Date.now().toString(36), appDir, peerDrop = '' }) {
  const started = Date.now();
  const trace = { scenario: { id: sc.id, title: sc.title }, notes: [], t0: 0, t1: 0, events: [], approvals: [], groupMessages: [], botChats: [], posts: [], human: [], uploads: [], uploadsAfter: {}, files: [], restarts: [], bots: [], siteNames: Object.fromEntries(Object.values(SITES).map((s) => [s.id, s.name])), errors: [] };
  const hubs = {};
  const recorders = [];
  let fake = null;
  let root = null;
  let group = null;
  const attached = mode === 'real' && real?.hub;
  const out = attached ? `评测-协作/${runId}/${sc.id}/交付` : '交付';
  const env = { mode, mock, hubs, plant, out, mem: { skip: new Set(), down: new Set(), denied: new Set(), approved: {} }, botId: (short, remote) => { const b = trace.bots.find((x) => x.short === short); return remote && b?.remoteId ? b.remoteId : b?.id; } };
  try {
    // --- hubs ---
    if (attached) {
      hubs.A = await attachHub({ name: 'A', url: real.hub.url, key: real.hub.key });
      if (sc.hubs.includes('B')) {
        // The other machine only through this one (no key of its own): named as this hub knows it.
        if (!real.peer) throw new Error('这个场景要两台：设 EVAL_PEER_NAME（那台在 EVAL_HUB 的「机器」里的名字）或 EVAL_PEER（它的地址）');
        const peers = listOf(await hubs.A.api.get('/api/peers'), 'peers');
        const want = (u) => String(u || '').replace(/\/+$/, '');
        const hit = peers.find((x) => (real.peer.name && x.name === real.peer.name) || (real.peer.url && [x.url, x.tailnetUrl].map(want).includes(want(real.peer.url))));
        if (!hit) throw new Error(`EVAL_HUB 的「机器」里没有${real.peer.name ? `「${real.peer.name}」` : ` ${real.peer.url}`}：先在应用里把它加上`);
        hubs.B = peerVia(hubs.A, hit.name);
      }
    } else {
      root = scratchRoot(sc.id);
      if (mode === 'fake') {
        fake = await startFakeModel({ script: null, plant, log });
      }
      const hubEnv = mode === 'fake' ? { CHROME_PATH: path.join(root, 'no-browser.exe') } : { BROWSER_HEADLESS: '1' };
      for (const name of sc.hubs) hubs[name] = await startTestHub({ name, root, env: hubEnv, log: () => {}, ...(appDir ? { appDir } : {}) });
      for (const hub of Object.values(hubs)) {
        const settings = mode === 'fake' ? { provider: 'openai', baseUrl: fake.url, model: 'fake', apiKey: 'fake-local-only' } : real?.settings;
        if (!settings) throw new Error('--real 用测试 hub 时要给模型：EVAL_PROVIDER / EVAL_BASE_URL / EVAL_MODEL_NAME / EVAL_API_KEY');
        await hub.api.put('/api/settings', settings);
        // The fake model posts through http_fetch where a real one clicks in a browser; the read guard asks
        // before a POST after reading a page, which it never does for a click: off, so the cards match.
        if (mode === 'fake') await hub.api.put('/api/policy', { readGuard: false });
      }
      if (hubs.B) {
        await hubs.A.api.put('/api/peers', { self: { name: MACHINE.A }, peers: [{ name: MACHINE.B, url: hubs.B.url, token: hubs.B.token }] });
        await hubs.B.api.put('/api/peers', { self: { name: MACHINE.B }, peers: [{ name: MACHINE.A, url: hubs.A.url, token: hubs.A.token }] });
        // From here on the other machine is reached only through the first, as on the human's machines.
        hubs.B = peerVia(hubs.A, MACHINE.B, { testHub: hubs.B });
      }
    }
    if (hubs.B) {
      const drop = hubs.B.testHub && peerDrop !== 'pause' ? 'cut' : 'pause';
      hubs.B.drop = drop;
      if (drop === 'pause') trace.notes.push(`另一台「${hubs.B.machine}」的断线是在第一台这边模拟的：暂停这条连接（进行中的请求被切断，新请求马上失败），那台机器本身一直在跑${peerDrop === 'cut' ? '（它不是这次自己起的测试 hub，不能真的关掉）' : ''}。`);
      else trace.notes.push(`另一台「${hubs.B.machine}」是这次自己起的测试 hub：断线是真的把它关掉，过几秒再开。`);
    }
    // The other machine's name as the coordinator's hub knows it.
    const peerName = hubs.B?.machine || MACHINE.B;
    for (const hub of Object.values(hubs)) if (!hub.via) recorders.push(recordEvents(hub, trace.events));

    // --- bots and the group ---
    // Names are fixed (the timelines and checks know the bots by them). On a hub that is not ours the id is
    // given, unique to this run: a Chinese name makes no id of its own, and nothing there may be hit.
    const tag = attached ? `-${runId.slice(-4)}` : '';
    for (const [i, b] of sc.bots(mode).entries()) {
      const hub = hubs[b.hub];
      if (hub.via) {
        const bot = await hub.createBot({ name: `评测-${b.short}`, role: b.role, persona: b.persona, tools: b.tools, trusted: b.trusted, model: real?.peerModel || '' });
        trace.bots.push({ hub: b.hub, id: bot.id, name: bot.name, short: b.short, coordinator: Boolean(b.coordinator), remoteId: `${bot.id}@${peerName}` });
        continue;
      }
      const made = await hub.api.post('/api/bots', {
        name: `评测-${b.short}`, role: b.role, persona: b.persona, tools: b.tools, eval: true,
        ...(attached ? { id: `eval-${runId.slice(-6)}-${sc.id.split('-')[0]}-${i + 1}` } : {}),
        ...(b.trusted ? { policy: { autoApproveMedium: true } } : {}),
        ...(real?.model ? { model: real.model } : {}),
      });
      const bot = made.bot || made;
      if (b.trusted) await hub.api.patch(`/api/bots/${encodeURIComponent(bot.id)}`, { policy: { autoApproveMedium: true } }).catch(() => {});
      trace.bots.push({ hub: b.hub, id: bot.id, name: bot.name, short: b.short, coordinator: Boolean(b.coordinator), remoteId: b.hub !== 'A' ? `${bot.id}@${peerName}` : null });
    }
    if (hubs.B) {
      recorders.push(...hubs.B.record(trace.bots.filter((b) => b.hub === 'B').map((b) => b.id), trace.events));
      await hubs.A.api.get('/api/peers/roster?fresh=1').catch(() => {});
    }
    const coord = trace.bots.find((b) => b.coordinator);
    if (fake) fake.setScript(sc.brain(env));
    const made = await hubs.A.api.post('/api/groups', { name: `评测-${sc.id}${tag}`, members: trace.bots.map((b) => b.remoteId || b.id), coordinatorId: coord.id });
    group = { hub: 'A', id: made.group?.id || made.id };
    trace.groupId = group.id;
    trace.coordinator = { hub: 'A', id: coord.id };
    // The introductions first (every member says hello), so the run starts from a quiet group.
    const members = trace.bots.length;
    const kickoffEnd = Date.now() + (mode === 'fake' ? 20000 : 240000);
    while (Date.now() < kickoffEnd) {
      const said = new Set(trace.events.filter((e) => e.type === 'turn.end' && e.kickoff).map((e) => e.botId));
      if (said.size >= members) break;
      await sleep(300);
    }
    await sleep(500);

    // --- the human ---
    trace.t0 = Date.now();
    const run = { hubs, group, bots: trace.bots, mock, trace, coordinatorId: coord.id, speed: mode === 'real' ? 5 : 1, log };
    const h = makeHuman(run);
    const steps = sc.timeline(env).map((s) => (mode === 'real' && s.orAt != null ? { ...s, orAt: s.orAt * 20 } : s));
    const result = await runTimeline(h, { steps, policy: sc.policy, cardDelay: 1000, done: sc.done, quietMs: mode === 'real' ? 300000 : 6000, timeoutMs: (Number(process.env.EVAL_TIMEOUT_MINUTES) || (mode === 'real' ? 45 : 2)) * 60000, speed: run.speed });
    trace.errors.push(...result.errors);
    trace.timedOut = result.timedOut;
    trace.quiet = result.quiet;
    await sleep(800);
    trace.t1 = Date.now();

    // --- the evidence ---
    for (const e of trace.events) {
      if (e.type === 'approval.request' && e.approvalId) trace.approvals.push({ hub: e.hub, id: e.approvalId, botId: e.botId, toolName: e.tool, args: e.args, reason: e.reason, createdAt: e.at, turnId: e.turnId, status: 'pending', decidedAt: null });
    }
    for (const e of trace.events) {
      if ((e.type === 'approval.resolved' || e.type === 'approval.decided') && e.approvalId) {
        const c = trace.approvals.find((x) => x.id === e.approvalId && x.hub === e.hub);
        if (c && c.status === 'pending') { c.status = e.decision || e.status || 'decided'; c.decidedAt = e.at; }
      }
    }
    trace.posts = mock.records().filter((r) => r.at >= trace.t0 - 1000);
    const gm = listOf(await hubs.A.api.get(`/api/groups/${encodeURIComponent(group.id)}/messages?limit=1000`).catch(() => []), 'messages', 'items');
    trace.groupMessages = gm.map((m) => ({ hub: 'A', groupId: group.id, at: toMs(m.ts), kind: m.kind, from: m.from, to: m.to, text: m.text, turnId: m.turnId })).filter((m) => m.at >= trace.t0 - 500);
    for (const b of trace.bots) {
      const items = hubs[b.hub].via ? await hubs[b.hub].messages(b.id).catch(() => []) : listOf(await hubs[b.hub].api.get(`/api/bots/${encodeURIComponent(b.id)}/messages?limit=1000`).catch(() => []), 'items');
      for (const m of items) if (toMs(m.ts) >= trace.t0 - 500) trace.botChats.push({ hub: b.hub, botId: b.id, at: toMs(m.ts), role: m.role, text: m.text, turnId: m.turnId });
    }
    for (const [name, hub] of Object.entries(hubs)) {
      if (hub.via) {
        // That machine's workspace is not listed from here: the files the scenario expects there, looked up one by one.
        for (const rel of sc.expect.peerFiles || []) if (await hub.fileSha(rel).catch(() => null)) trace.files.push({ hub: name, path: rel, size: 0, mtime: trace.t1 });
        continue;
      }
      const base = attached ? path.join(hub.workspace || '', ...out.split('/').slice(0, -1)) : hub.workspace;
      if (base && fs.existsSync(base)) for (const f of walk(base)) trace.files.push({ hub: name, ...f, path: attached ? `交付/${f.path.replace(/^交付\//, '')}` : f.path });
    }
    for (const u of trace.uploads) {
      const hub = hubs[u.hub];
      let now = null;
      try {
        if (hub.workspace && fs.existsSync(hub.workspace)) now = sha(fs.readFileSync(path.join(hub.workspace, ...u.path.split('/'))));
      } catch { now = null; }
      trace.uploadsAfter[u.path] = now;
    }
    // Model cost of this run's bots (the usage ledger).
    const usage = { tokens: 0, cost: 0 };
    for (const [name, hub] of Object.entries(hubs)) {
      if (hub.via) { const u = await hub.usage(trace.bots.filter((x) => x.hub === name).map((x) => x.id)).catch(() => ({ tokens: 0, cost: 0 })); usage.tokens += u.tokens; usage.cost += u.cost; continue; }
      const byBot = listOf(await hub.api.get('/api/usage?days=1').catch(() => null), 'byBot');
      for (const b of trace.bots.filter((x) => x.hub === name)) {
        const row = byBot.find((r) => r.key === b.id);
        if (row) { usage.tokens += Number(row.tokens) || 0; usage.cost += Number(row.cost) || 0; }
      }
    }
    trace.usage = { tokens: usage.tokens, cost: Math.round(usage.cost * 10000) / 10000 };
    trace.expect = { ...sc.expect, deliverableDir: sc.expect.deliverableDir ? '交付/' : undefined };
  } catch (err) {
    trace.errors.push(`运行出错：${err.message}`);
    if (!trace.t0) trace.t0 = started;
    trace.t1 = Date.now();
    trace.expect = trace.expect || { ...sc.expect };
  } finally {
    for (const r of recorders) await r.stop().catch(() => {});
    // The other machine's bots, through the first (also on test hubs: the route is part of what runs).
    if (hubs.B?.via) {
      await hubs.B.pause(0).catch(() => {});
      for (const b of trace.bots.filter((x) => x.hub === 'B')) {
        await hubs.B.deleteBot(b.id).catch((err) => trace.errors.push(`清理：另一台上的「${b.name}」没删掉（${err.message}）`));
      }
    }
    // Clean up: the group, the bots (not kept for the activity log), the run's folder on an attached hub.
    if (attached) {
      if (group) await hubs.A.api.del(`/api/groups/${encodeURIComponent(group.id)}`).catch((err) => log(`! 群没删掉：${err.message}`));
      for (const b of trace.bots.filter((x) => !hubs[x.hub]?.via)) {
        await hubs[b.hub]?.api.del(`/api/bots/${encodeURIComponent(b.id)}?forget=1`).catch((err) => log(`! 机器人 ${b.name} 没删掉：${err.message}`));
      }
      for (const hub of Object.values(hubs).filter((x) => !x.via)) {
        try {
          if (hub.dataDir) for (const d of fs.readdirSync(path.join(hub.dataDir, 'deleted-bots'))) if (trace.bots.some((b) => d.startsWith(`${b.id}-`))) fs.rmSync(path.join(hub.dataDir, 'deleted-bots', d), { recursive: true, force: true });
        } catch { /* none */ }
        try { if (hub.workspace && !keep) fs.rmSync(path.join(hub.workspace, '评测-协作', runId, sc.id), { recursive: true, force: true }); } catch { /* none */ }
        for (const u of trace.uploads.filter((x) => hubs[x.hub] === hub)) {
          try { if (hub.workspace && !keep) fs.rmSync(path.join(hub.workspace, ...u.path.split('/')), { recursive: true, force: true }); } catch { /* none */ }
        }
      }
    }
    for (const hub of Object.values(hubs)) await Promise.resolve(hub.via ? hub.testHub?.stop?.() : hub.stop()).catch(() => {});
    if (fake) await fake.close().catch(() => {});
    if (root && !keep) fs.rmSync(root, { recursive: true, force: true });
    if (root && keep) log(`测试 hub 的数据留在 ${root}`);
  }
  const checks = checkAll(trace);
  const extra = sc.extra && trace.t0 && !trace.errors.some((e) => e.startsWith('运行出错')) ? (() => { try { return sc.extra(trace); } catch (err) { return [{ id: `${sc.id}-x`, title: '场景自己的检查', ok: false, evidence: [{ at: trace.t1, text: err.message }] }]; } })() : [];
  return { id: sc.id, title: sc.title, from: sc.from, plant: [...plant], checks, extra, notes: trace.notes, metrics: metricsOf(trace), errors: trace.errors, timedOut: Boolean(trace.timedOut), trace };
}
