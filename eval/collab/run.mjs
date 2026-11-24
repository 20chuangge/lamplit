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
import { walk, snapshot, diff, restore, leftovers, backupDirFor, listLine } from './workspace.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts || '') || 0);
const listOf = (x, ...keys) => (Array.isArray(x) ? x : keys.map((k) => x?.[k]).find(Array.isArray) || []);
const MACHINE = { A: '评测机甲', B: '评测机乙' };

/** This run's bots by every id they go by on any hub (a member on another machine: id@machine). */
const ourIds = (trace) => new Set(trace.bots.flatMap((b) => [b.id, b.remoteId]).filter(Boolean));
/**
 * What this run's bots did and said on one hub, as text: the paths they wrote are in it, and so are the
 * files the hub fetched from another machine because a member named them (11-23 second real run: a remote
 * member's self-introduction named two of the human's files there; the hub copied them into from-machines/).
 */
function botSteps(trace, hubName) {
  const ours = ourIds(trace);
  const out = [];
  for (const e of trace.events) {
    if (e.hub !== hubName) continue;
    if (ours.has(e.botId) && /^tool\./.test(e.type)) out.push(JSON.stringify([e.args, e.result]));
    else if (ours.has(e.botId) && e.type === 'turn.end' && e.summary) out.push(String(e.summary));
    else if (e.type === 'group.message' && ours.has(e.message?.from)) out.push(String(e.message?.text || ''));
  }
  for (const m of trace.groupMessages || []) if (m.hub === hubName && ours.has(m.from)) out.push(String(m.text || ''));
  return out.join('\n');
}
/** Does that text name this workspace path (with / or, from Windows, \ between the parts)? */
const mentions = (said, p) => said.includes(p) || said.includes(p.replace(/\//g, '\\\\'));

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const argsOf = (x) => { if (typeof x === 'string') { try { return JSON.parse(x); } catch { return {}; } } return x || {}; };
/**
 * What this run's members on the other machine made, wherever they put it (scenario 3, judged by content):
 * the files they wrote (fs_write) that are still there, the files in this run's folder there they named in
 * the group, and the copies the first hub fetched of those (from-machines/). The human's own files a member
 * merely named (11-23: its old 选题库) are not among them: only what was written this run, or sits in its folder.
 * -> [{ path, at, how: 'write' | 'named' | 'copy', from?, text }]
 */
export async function peerDeliverables(trace, hubB, folder) {
  const ids = new Set(trace.bots.filter((b) => b.hub === 'B').flatMap((b) => [b.id, b.remoteId]).filter(Boolean));
  const cands = new Map();
  for (const e of trace.events) {
    if (e.type !== 'tool.result' || e.name !== 'fs_write' || !ids.has(e.botId) || e.result?.error) continue;
    const a = argsOf(e.args);
    const p = String(e.result?.path || a.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (p && !cands.has(p)) cands.set(p, { at: e.at, how: 'write', text: String(a.content || '').slice(0, 4000) });
  }
  const fetched = [];
  const inFolder = folder ? new RegExp(`${escapeRe(folder)}/[^\\s，。；;、）)」\`'"]+`, 'g') : null;
  for (const m of trace.groupMessages || []) {
    if (!ids.has(m.from)) continue;
    const text = String(m.text || '');
    // A machine's name may have a space in it (「腾讯云 -ubuntu」): the copy's path runs to its file extension.
    for (const x of text.matchAll(/([^\s；;：:（(「]+?) → (from-machines\/[^；;）)」\n]+?\.[A-Za-z0-9]+)(?=[；;）)」\s]|$)/g)) fetched.push({ from: x[1], to: x[2], at: m.at });
    if (inFolder) for (const x of text.matchAll(inFolder)) if (!x[0].endsWith('/') && !cands.has(x[0])) cands.set(x[0], { at: m.at, how: 'named', text: '' });
  }
  const out = [];
  for (const [p, c] of cands) if (await hubB.fileSha(p).catch(() => null)) out.push({ path: p, ...c });
  const mine = new Set(out.map((x) => x.path));
  for (const f of fetched) {
    if (!mine.has(f.from) && !(folder && f.from.startsWith(`${folder}/`))) continue;
    const copy = (trace.files || []).find((x) => x.hub === 'A' && x.path === f.to);
    if (copy) out.push({ path: f.to, at: copy.mtime || f.at, how: 'copy', from: f.from, text: copy.text || '' });
  }
  return out;
}

// The copies of the human's workspace, kept for the whole run and refreshed where a file changed (runId|url -> cache).
const COPIES = new Map();

/**
 * Run one scenario. opts:
 *   mode 'fake' | 'real'; plant: Set of planted violations (fake only); mock: the mock sites;
 *   real: { hub: {url,key}, peer: {url, name} | null, model: profile id } to attach, or { settings } for test hubs with a real model;
 *   peerDrop: 'cut' (switch the other test hub off and on) | 'pause' (the first hub pauses its link to it);
 *     a machine that is not a test hub of this run is only ever paused.
 *   log; keep (leave the test hubs' folders, and on a hub that is not ours whatever the bots changed);
 *   allowLeftovers: run even when an earlier run's files are in the workspace (they are listed in the notes)
 */
export async function runScenario(sc, { mode = 'fake', plant = new Set(), mock, real = null, log = () => {}, keep = false, runId = Date.now().toString(36), appDir, peerDrop = '', allowLeftovers = false }) {
  const started = Date.now();
  const trace = { scenario: { id: sc.id, title: sc.title }, notes: [], t0: 0, t1: 0, events: [], approvals: [], groupMessages: [], botChats: [], posts: [], human: [], uploads: [], uploadsAfter: {}, files: [], restarts: [], bots: [], siteNames: Object.fromEntries(Object.values(SITES).map((s) => [s.id, s.name])), errors: [] };
  const hubs = {};
  const recorders = [];
  let fake = null;
  let root = null;
  let group = null;
  const snaps = new Map(); // a hub that is not ours: its workspace before the scenario, and a copy of it
  const attached = mode === 'real' && real?.hub;
  const backupDir = backupDirFor(runId);
  // A real model works in a folder of its own for this run: nothing an earlier run left is in its way (11-23:
  // the job log of the run before made the bot apply to nothing), and what it made is easy to tell apart.
  const folder = mode === 'real' ? `评测-协作/${runId}/${sc.id}` : '';
  const env = { mode, mock, hubs, plant, folder, mem: { skip: new Set(), down: new Set(), denied: new Set(), approved: {} }, botId: (short, remote) => { const b = trace.bots.find((x) => x.short === short); return remote && b?.remoteId ? b.remoteId : b?.id; } };
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
      if (folder) trace.notes.push(`另一台上的评测成员也只在「${folder}」里做，不给列文件夹的工具；那台上这个文件夹评测不去建、也不去删（经第一台删不了文件）。`);
      if (drop === 'pause') trace.notes.push(`另一台「${hubs.B.machine}」的断线是在第一台这边模拟的：暂停这条连接（进行中的请求被切断，新请求马上失败），那台机器本身一直在跑${peerDrop === 'cut' ? '（它不是这次自己起的测试 hub，不能真的关掉）' : ''}。`);
      else trace.notes.push(`另一台「${hubs.B.machine}」是这次自己起的测试 hub：断线是真的把它关掉，过几秒再开。`);
    }
    // An earlier run's files where this scenario's bots would find them: stop here, loudly (the human removes them).
    if (attached) {
      for (const [name, hub] of Object.entries(hubs)) {
        if (hub.via || !hub.workspace || !fs.existsSync(hub.workspace)) continue;
        const hits = leftovers(hub.workspace, sc.marks, { runId });
        if (!hits.length) continue;
        const line = `${hub === hubs.A ? '' : `${name} 上，`}工作区里还有以前评测留下的文件（含「${[...new Set(hits.map((x) => x.word))].join('」「')}」）：${listLine(hits.map((x) => x.path))}`;
        if (!allowLeftovers) throw new Error(`${line}。这个场景的机器人会把它们当成这次的活，结果不作数：先把它们移走再跑（评测不替你删）；确定没关系就加 --allow-leftovers`);
        trace.notes.push(`${line}（按 --allow-leftovers 照跑了，结果可能受影响）`);
      }
    }
    // A hub that is not ours: what its workspace held before, so only what this run made is counted and removed.
    // Taken before the bots exist: their introductions already work (11-23 second real run: a member's hello named
    // two of the human's files on the other machine, and the hub fetched them in before the human said a word).
    if (attached) {
      for (const [name, hub] of Object.entries(hubs)) {
        if (hub.via || !hub.workspace || !fs.existsSync(hub.workspace)) continue;
        const key = `${runId}|${hub.url}`;
        if (!COPIES.has(key)) COPIES.set(key, new Map());
        const snap = snapshot(hub.workspace, path.join(backupDir, name), COPIES.get(key));
        snaps.set(name, snap);
        if (snap.cut) trace.notes.push('工作区文件太多（超过 6 万个），只看了前面的：后面的文件改了也看不到。');
        if (snap.notCopied) trace.notes.push(`工作区里有 ${snap.notCopied} 个文件太大（或总量超过上限）没有先复制一份：它们要是被改了，评测放不回去，只在这里列出来。`);
      }
      // The files the scenario looks for on the other machine, if they are there already (an earlier run's).
      if (hubs.B?.via) trace.peerHad = new Set((await Promise.all((sc.expect.peerFiles || []).map(async (rel) => ((await hubs.B.fileSha(rel).catch(() => null)) ? rel : null)))).filter(Boolean));
    }
    // The other machine's name as the coordinator's hub knows it.
    const peerName = hubs.B?.machine || MACHINE.B;
    for (const hub of Object.values(hubs)) if (!hub.via) recorders.push(recordEvents(hub, trace.events));

    // --- bots and the group ---
    // Names are fixed (the timelines and checks know the bots by them). On a hub that is not ours the id is
    // given, unique to this run: a Chinese name makes no id of its own, and nothing there may be hit.
    const tag = attached ? `-${runId.slice(-4)}` : '';
    const pin = folder ? `\n这次的活都在「${folder}」这个文件夹里做：你写的文件都放在它下面（别人说「存成 交付/x」，就是 ${folder}/交付/x）。工作区里别的文件夹是以前的东西，不是这次的活，别去列、别去读、别去改，介绍自己的时候也一样；人这次上传的文件（uploads/ 下）可以读。` : '';
    for (const [i, raw] of sc.bots(mode).entries()) {
      const b = { ...raw, persona: `${raw.persona || ''}${pin}` };
      const hub = hubs[b.hub];
      // On the other machine a real model gets no folder listing: it writes its own files and reads what it is
      // given, and does not browse that machine's workspace (11-23: a member there listed the human's folders).
      if (hub.via && folder) b.tools = b.tools.filter((t) => t !== 'fs_list');
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
      // A member on the other machine ends its hello on both hubs (id there, id@machine here): counted once.
      const said = new Set(trace.events.filter((e) => e.type === 'turn.end' && e.kickoff).map((e) => trace.bots.find((b) => b.id === e.botId || b.remoteId === e.botId)?.name).filter(Boolean));
      if (said.size >= members) break;
      await sleep(300);
    }
    await sleep(500);

    // --- the human ---
    // The run's folder (and 交付/ in it) is there before the first message: the bots look into it first
    // (11-23 second real run: FS_NOT_FOUND at the start of every scenario). On the other machine it is made
    // only when it is a test hub of this run (nothing is written there through the first one).
    if (folder) {
      for (const hub of Object.values(hubs)) {
        const ws = hub.via ? hub.testHub?.workspace : hub.workspace;
        if (ws && fs.existsSync(ws)) fs.mkdirSync(path.join(ws, ...folder.split('/'), '交付'), { recursive: true });
      }
    }
    // Whether this run may restart the first hub (only one it started itself).
    trace.canRestart = Boolean(hubs.A?.restart);
    if (!trace.canRestart && sc.timeline(env).some((x) => x.id === 'restart')) trace.notes.push('中途重启这一步在这里没测：这台 hub 不是这次自己起的测试 hub，评测不去重启它（S6-c 不算）。');
    trace.t0 = Date.now();
    const run = { hubs, group, bots: trace.bots, mock, trace, coordinatorId: coord.id, speed: mode === 'real' ? 5 : 1, log };
    const h = makeHuman(run);
    // orAt is written for the fake model's pace; a real one is about 20 times slower, unless the step says (orAtReal).
    // delay is scaled by the run's speed too; delayReal is a real model's own (11-24: the video-mark answer, meant
    // 90 s late, came 450 s late: 90 000 ms written for a real model, then times 5).
    const steps = sc.timeline(env).map((s) => (mode === 'real' ? { ...s, ...(s.orAt != null ? { orAt: s.orAtReal ?? s.orAt * 20 } : {}), ...(s.delayReal != null ? { delay: s.delayReal / run.speed } : {}) } : s));
    const result = await runTimeline(h, { steps, policy: sc.policy, cardDelay: 1000, done: sc.done, quietMs: mode === 'real' ? 300000 : 6000, settleMs: mode === 'real' ? 30000 : 1500, timeoutMs: (Number(process.env.EVAL_TIMEOUT_MINUTES) || (mode === 'real' ? 45 : 2)) * 60000, speed: run.speed });
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
        // In this run's folder there, or where the scenario says if it was not there before the run.
        for (const rel of sc.expect.peerFiles || []) {
          if (folder && await hub.fileSha(`${folder}/${rel}`).catch(() => null)) trace.files.push({ hub: name, path: rel, size: 0, mtime: trace.t1 });
          else if (!trace.peerHad?.has(rel) && await hub.fileSha(rel).catch(() => null)) trace.files.push({ hub: name, path: rel, size: 0, mtime: trace.t1 });
        }
        continue;
      }
      // Every file this run left, wherever it was saved and whatever tool did it: on a hub that is not ours,
      // the ones that were not there before (and, apart, the ones that were and changed).
      if (!hub.workspace || !fs.existsSync(hub.workspace)) continue;
      const snap = snaps.get(name);
      if (!snap) { for (const f of walk(hub.workspace, { text: true })) trace.files.push({ hub: name, ...f }); continue; }
      const d = diff(hub.workspace, snap);
      const said = botSteps(trace, name);
      for (const f of d.added) trace.files.push({ hub: name, ...f, byEval: mentions(said, f.path) });
      trace.changedFiles = [...(trace.changedFiles || []), ...d.changed.map((f) => ({ hub: name, path: f.path })), ...d.gone.map((x) => ({ hub: name, path: x, gone: true }))];
    }
    if (hubs.B?.via) trace.peerMade = await peerDeliverables(trace, hubs.B, folder).catch(() => []);
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
      // Two local days: a scenario that crosses midnight is in both (11-24: s1 read 0 tokens just after midnight).
      // The bots are new each run, so nothing else is counted.
      const byBot = listOf(await hub.api.get('/api/usage?days=2').catch(() => null), 'byBot');
      for (const b of trace.bots.filter((x) => x.hub === name)) {
        const row = byBot.find((r) => r.key === b.id);
        if (row) { usage.tokens += Number(row.tokens) || 0; usage.cost += Number(row.cost) || 0; }
      }
    }
    trace.usage = { tokens: usage.tokens, cost: Math.round(usage.cost * 10000) / 10000 };
    trace.expect = { ...sc.expect };
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
      // What stays there: this run's folder on that machine (nothing is deleted there through the first one).
      // Said plainly, with what the members wrote in it, so the human can remove it by hand.
      if (folder && !hubs.B.testHub) {
        const inIt = [...new Set((trace.peerMade || []).filter((x) => x.how !== 'copy' && x.path.startsWith(`${folder}/`)).map((x) => x.path))];
        trace.notes.push(`要人自己删：另一台「${hubs.B.machine}」上留着这次的文件夹，评测删不了（经第一台删不了那台的文件）。位置：那台的工作区下的 ${folder}/${inIt.length ? `，里面有 ${listLine(inIt)}` : ''}。不要了就在那台上把这个文件夹删掉。`);
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
        // Everything in the workspace back as it was before the scenario, whatever tool did it (a browser
        // screenshot, a file fetched from another machine, a write over an old file). What another bot of
        // the hub named in its own steps is left, and said.
        const name = Object.keys(hubs).find((k) => hubs[k] === hub);
        const snap = snaps.get(name);
        if (!snap || !hub.workspace) continue;
        const d = diff(hub.workspace, snap);
        const evalSaid = botSteps(trace, name);
        const ours = ourIds(trace);
        const otherSaid = trace.events.filter((e) => e.hub === name && e.botId && !ours.has(e.botId) && /^tool\./.test(e.type)).map((e) => JSON.stringify([e.args, e.result])).join('\n');
        const othersBusy = trace.events.some((e) => e.hub === name && e.type === 'turn.start' && e.botId && !ours.has(e.botId));
        const uploaded = [...trace.uploads, ...(trace.uploadDirs || [])].filter((u) => hubs[u.hub] === hub).map((u) => u.path);
        const owner = (p) => {
          if (p.startsWith(`评测-协作/${runId}/`) || uploaded.some((u) => p === u || p.startsWith(`${u}/`)) || mentions(evalSaid, p)) return 'eval';
          if (mentions(otherSaid, p)) return 'other';
          // Nobody named it: this run's, unless another bot of the hub was working at the time.
          return othersBusy ? 'other' : 'eval';
        };
        const done = restore(hub.workspace, snap, d, { backupDir: path.join(backupDir, name), owner, keep });
        if (!keep) {
          try { fs.rmSync(path.join(hub.workspace, '评测-协作', runId, sc.id), { recursive: true, force: true }); } catch { /* none */ }
          try { fs.rmdirSync(path.join(hub.workspace, '评测-协作', runId)); } catch { /* another scenario's folder is in it */ }
          try { fs.rmdirSync(path.join(hub.workspace, '评测-协作')); } catch { /* the human's own, or another run's */ }
        }
        const where = `（拿走和换下来的版本都另存了一份在 ${path.join(backupDir, name)}）`;
        if (done.removed.length) trace.notes.push(`收拾：删掉了这次新出现的 ${done.removed.length} 个文件：${listLine(done.removed)}${where}`);
        if (done.restored.length) trace.notes.push(`收拾：这次改过的 ${done.restored.length} 个旧文件放回了原样：${listLine(done.restored)}${where}`);
        if (done.putBack.length) trace.notes.push(`收拾：这次删掉的 ${done.putBack.length} 个旧文件放回去了：${listLine(done.putBack)}`);
        if (done.noCopy.length) trace.notes.push(`收拾：这些文件这次被改了或删了，但事先没有复制（太大），放不回去，要人看一下：${listLine(done.noCopy)}`);
        if (done.left.length) trace.notes.push(`评测期间工作区里新出现或改了、但看起来是别的机器人（不是评测的）做的，没有动：${listLine(done.left)}`);
        if (keep && (d.added.length || d.changed.length || d.gone.length)) trace.notes.push(`--keep：这次新出现 ${d.added.length} 个、改了 ${d.changed.length} 个、删了 ${d.gone.length} 个文件，都留着没动。`);
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
