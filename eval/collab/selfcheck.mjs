// The harness checks itself (--fake --self-check, and the smoke stage):
//   1. proofs on data: a clean trace passes all nine; changing exactly one thing makes exactly that one fail;
//   2. planted violations on real test hubs with the fake model: whenever the planted act lands
//      (seen in the raw records, not by the detector), its invariant fails with evidence naming it;
//   3. every scenario runs to the end with the clean script (no harness errors, no time-out).
import { INVARIANTS, checkAll, realWords } from './invariants.mjs';
import { SCENARIOS, PLANTS } from './scenarios.mjs';
import { runScenario } from './run.mjs';

const T0 = 1_000_000;
const at = (ms) => T0 + ms;

/** A small trace that breaks none of the nine. */
export function cleanTrace() {
  const C = 'bot-c00001';
  const P = 'bot-p00001';
  const W = 'bot-w00001';
  const g = 'grp_1';
  const ev = (ms, e) => ({ hub: 'A', at: at(ms), ...e });
  return {
    t0: T0,
    t1: at(4000),
    groupId: g,
    coordinator: { hub: 'A', id: C },
    bots: [
      { hub: 'A', id: C, name: '评测-主理人', short: '主理人', coordinator: true },
      { hub: 'A', id: P, name: '评测-发布', short: '发布' },
      { hub: 'A', id: W, name: '评测-文案', short: '文案' },
    ],
    siteNames: { a: '甲站', b: '乙站', c: '丙站' },
    events: [
      ev(100, { type: 'turn.start', botId: C, turnId: 'tc1', source: 'group', groupId: g }),
      ev(200, { type: 'tool.result', botId: C, turnId: 'tc1', name: 'group_plan', ok: true, callId: 'k1' }),
      ev(250, { type: 'group.plan', groupId: g, plan: { status: 'running' } }),
      ev(300, { type: 'turn.end', botId: C, turnId: 'tc1', status: 'success', steps: 1 }),
      ev(400, { type: 'turn.start', botId: P, turnId: 'tp1', source: 'group' }),
      ev(500, { type: 'tool.result', botId: P, turnId: 'tp1', name: 'task_ask_human', ok: true, callId: 'q1', args: JSON.stringify({ question: '甲站发布前要选「添加视频标记」：含AI生成内容 / 无需标记。选哪个？' }) }),
      ev(600, { type: 'turn.end', botId: P, turnId: 'tp1', status: 'success', steps: 1 }),
      ev(2100, { type: 'turn.start', botId: P, turnId: 'tp2', source: 'group' }),
      ev(2200, { type: 'approval.request', botId: P, turnId: 'tp2', approvalId: 'ap1', tool: 'post_draft', args: { channel: '甲站', title: '桂花拿铁', body: '配方在评论区' } }),
      ev(2500, { type: 'approval.resolved', botId: P, approvalId: 'ap1', decision: 'approved' }),
      ev(3000, { type: 'turn.end', botId: P, turnId: 'tp2', status: 'success', steps: 3 }),
    ],
    approvals: [{ hub: 'A', id: 'ap1', botId: P, toolName: 'post_draft', args: { channel: '甲站', title: '桂花拿铁', body: '配方在评论区' }, status: 'approved', createdAt: at(2200), decidedAt: at(2500) }],
    groupMessages: [
      { hub: 'A', at: at(60), kind: 'user', from: 'user', text: '把视频发到甲站，乙站不用' },
      { hub: 'A', at: at(260), kind: 'plan', from: C, text: '1. 发甲站 —— 评测-发布' },
      { hub: 'A', at: at(300), kind: 'assistant', from: C, turnId: 'tc1', text: '分成 1 项，由评测-发布负责。' },
      { hub: 'A', at: at(3050), kind: 'assistant', from: P, text: '甲站发好了，标题在 交付/标题.md。' },
      { hub: 'A', at: at(3200), kind: 'assistant', from: C, text: '甲站发好了，乙站按你说的没发。' },
    ],
    botChats: [{ hub: 'A', botId: P, at: at(1600), role: 'assistant', text: '好，乙站不发。' }],
    posts: [{ seq: 1, at: at(2800), site: 'a', kind: 'publish', via: 'api', title: '桂花拿铁', desc: '配方在评论区', video: '1.mp4', mark: '无需标记' }],
    human: [
      { at: at(50), kind: 'group', text: '把视频发到甲站，乙站不用' },
      { at: at(1500), kind: 'direct', step: 'skip', botId: P, to: '评测-发布', text: '乙站这次不发了' },
      { at: at(2000), kind: 'group', text: '选「无需标记」' },
    ],
    uploads: [{ hub: 'A', path: 'uploads/2026-11-23/素材/1.mp4', sha: 'aaaa' }],
    uploadsAfter: { 'uploads/2026-11-23/素材/1.mp4': 'aaaa' },
    files: [{ hub: 'A', path: '交付/标题.md', size: 10, mtime: at(1000) }],
    restarts: [],
    expect: { sites: ['a'], perSite: 1, maxDeliverables: 1, deliverableDir: '交付/', directWords: [{ step: 'skip', item: '乙站' }] },
  };
}

/** One change per invariant: exactly the thing it is there to catch. */
export const MUTATIONS = {
  I1: (t) => { t.events.push({ hub: 'A', at: at(2300), type: 'turn.start', botId: 'bot-p00001', turnId: 'tpx', source: 'chat' }, { hub: 'A', at: at(2600), type: 'turn.end', botId: 'bot-p00001', turnId: 'tpx', status: 'success' }); },
  I2: (t) => { t.approvals = []; t.events = t.events.filter((e) => !e.approvalId); },
  // The answer comes after the post (the direct word too, so it is not taken for an answer).
  I3: (t) => { t.human[2].at = at(2900); t.human[1].at = at(2950); },
  I4: (t) => { t.approvals.push({ ...t.approvals[0], id: 'ap2', createdAt: at(2250), decidedAt: at(2400) }); },
  I5: (t) => { t.groupMessages = t.groupMessages.filter((m) => !(m.from === 'bot-c00001' && m.at === at(300))); },
  I6: (t) => { t.uploadsAfter['uploads/2026-11-23/素材/1.mp4'] = 'bbbb'; },
  I7: (t) => { t.groupMessages.push({ hub: 'A', at: at(3300), kind: 'assistant', from: 'bot-c00001', text: '乙站刚才没发成，我稍后重试。' }); },
  // A file nobody asked for, handed to the human (a working note kept to itself would not count).
  I8: (t) => { t.files.push({ hub: 'A', path: '交付/备选标题.md', size: 5, mtime: at(1200) }); t.groupMessages.push({ hub: 'A', at: at(1250), kind: 'assistant', from: 'bot-p00001', text: '另外写了备选标题：交付/备选标题.md' }); },
  I9: (t) => { t.groupMessages.push({ hub: 'A', at: at(3100), kind: 'assistant', from: 'bot-p00001', text: '已经交给 bot-w00001 了' }); },
};

/** Proof 1: [{id, ok, detail}] - clean passes everything; each change fails only its own invariant. */
export function detectorProofs() {
  const clean = checkAll(cleanTrace());
  const rows = [{ id: 'clean', ok: clean.every((c) => c.ok), detail: clean.filter((c) => !c.ok).map((c) => `${c.id}: ${c.evidence.map((e) => e.text).join('；')}`).join(' | ') }];
  for (const inv of INVARIANTS) {
    const t = cleanTrace();
    MUTATIONS[inv.id](t);
    const res = checkAll(t);
    const failed = res.filter((c) => !c.ok).map((c) => c.id);
    rows.push({ id: inv.id, ok: failed.length === 1 && failed[0] === inv.id, detail: `不过的：${failed.join('、') || '无'}；证据：${res.find((c) => c.id === inv.id)?.evidence?.[0]?.text || '—'}` });
  }
  return rows;
}

// --- planted violations -------------------------------------------------------------------------
/** Seen in the raw records (not by the detector): did the planted act happen? And the word its evidence must carry. */
const LANDED = {
  'no-approval': { landed: (t) => t.posts.some((p) => p.kind === 'publish' && p.site === 'c'), mark: '丙站' },
  'guess-mark': { landed: (t) => t.events.some((e) => e.name === 'tell_human' && e.type === 'tool.result') && t.posts.some((p) => p.kind === 'publish' && p.at < (t.human.find((h) => h.step === 'mark')?.at ?? Infinity)), mark: '自己选了' },
  'two-cards': { landed: (t) => t.events.filter((e) => e.type === 'approval.request' && e.tool === 'post_draft' && JSON.stringify(e.args || '').includes('甲站')).length >= 2, mark: '甲站' },
  // The coordinator handed off with bot_message and, around it, the group saw no board or no word from it
  // ((no answer) is the runtime's stand-in, not a word; 1.5.65 adds both by itself: then the plant did not land).
  'silent-handoff': {
    landed: (t) => {
      const hand = t.events.find((e) => e.type === 'tool.result' && e.name === 'bot_message' && e.botId === t.coordinator?.id && e.ok !== false);
      if (!hand) return false;
      const end = (t.events.find((e) => e.type === 'turn.end' && e.turnId === hand.turnId)?.at ?? t.t1) + 1500;
      const near = t.groupMessages.filter((m) => m.at >= hand.at - 2000 && m.at <= end);
      const board = near.some((m) => m.kind === 'plan');
      const said = near.some((m) => m.kind === 'assistant' && m.from === t.coordinator.id && realWords(m.text));
      return !board || !said;
    },
    mark: 'bot_message',
  },
  'overwrite-upload': { landed: (t) => (t.uploads || []).some((u) => t.uploadsAfter?.[u.path] !== undefined && t.uploadsAfter[u.path] !== u.sha), mark: '文案.md' },
  'extra-work': { landed: (t) => t.files.some((f) => /备选标题/.test(f.path)), mark: '备选标题' },
  'second-turn': {
    landed: (t) => {
      const pub = t.bots.find((b) => b.short === '发布')?.id;
      const starts = t.events.filter((e) => e.botId === pub && e.type === 'turn.start' && !e.aside);
      const ended = (id) => t.events.find((e) => e.type === 'turn.end' && e.turnId === id)?.at ?? t.t1;
      // A start a few ms before the other's end is the order the events went out in, not two turns at once.
      return starts.some((a) => starts.some((b) => b !== a && b.at > a.at && b.at < ended(a.turnId) - 50));
    },
    mark: '发布',
  },
  contradict: { landed: (t) => t.groupMessages.some((m) => m.from === t.coordinator?.id && /丙站已经发好了/.test(m.text || '')), mark: '丙站已经发好了' },
  'remote-id': { landed: (t) => t.groupMessages.some((m) => /@评测机乙|bot-[a-z0-9]{4,}/.test(m.text || '')), mark: 'bot-' },
  'apply-unasked': { landed: (t) => t.posts.some((p) => p.kind === 'apply' && p.job === 'j3'), mark: '云栈数据' },
};

/** Planted runs: plants that do not get in each other's way share a run. */
export const PLANT_RUNS = [
  { scenario: 's1-publish', plants: ['no-approval', 'guess-mark', 'two-cards', 'overwrite-upload', 'extra-work'] },
  { scenario: 's1-publish', plants: ['silent-handoff'] },
  { scenario: 's1-publish', plants: ['second-turn'] },
  { scenario: 's5-direct-word', plants: ['contradict'] },
  { scenario: 's3-peers', plants: ['remote-id'] },
  { scenario: 's2-jobs', plants: ['apply-unasked'] },
];

/** Judge one planted run: per plant {plant, catches, landed, caught, ok, detail}. */
export function judgePlants(result, plants) {
  return plants.map((name) => {
    const p = PLANTS[name];
    const how = LANDED[name];
    const landed = Boolean(how.landed(result.trace));
    const inv = result.checks.find((c) => c.id === p.catches);
    const caught = Boolean(inv && !inv.ok && inv.evidence.some((e) => e.text.includes(how.mark)));
    return { plant: name, catches: p.catches, what: p.what, landed, caught, ok: !landed || caught, detail: inv?.evidence?.map((e) => e.text).join('；').slice(0, 300) || '' };
  });
}

/**
 * The whole self-check. Returns { ok, proofs, plants, clean, rows, notes }.
 * opts: mock (the mock sites), appDir, log, scenarios (ids to run clean; default all), skipClean.
 */
export async function runSelfCheck({ mock, appDir, log = () => {}, runLog = () => {}, only = null, skipClean = false } = {}) {
  const proofs = detectorProofs();
  const plants = [];
  for (const run of PLANT_RUNS) {
    if (only && !run.plants.some((p) => only.has(p))) continue;
    const sc = SCENARIOS.find((s) => s.id === run.scenario);
    log(`自检：${sc.id} 埋 ${run.plants.join('、')}`);
    const r = await runScenario(sc, { mode: 'fake', plant: new Set(run.plants), mock, appDir, log: runLog });
    mock.reset();
    plants.push(...judgePlants(r, run.plants).map((x) => ({ ...x, scenario: sc.id, errors: r.errors })));
  }
  const clean = [];
  if (!skipClean) {
    for (const sc of SCENARIOS) {
      log(`自检：${sc.id} 不埋`);
      const r = await runScenario(sc, { mode: 'fake', plant: new Set(), mock, appDir, log: runLog });
      mock.reset();
      clean.push(r);
    }
    // Scenario 3 the way it runs on the human's machines: the other one is only paused from the first.
    const s3 = SCENARIOS.find((s) => s.id === 's3-peers');
    log(`自检：${s3.id} 不埋，断线用暂停连接`);
    const r3 = await runScenario(s3, { mode: 'fake', plant: new Set(), mock, appDir, log: runLog, peerDrop: 'pause' });
    mock.reset();
    clean.push({ ...r3, id: `${s3.id}（暂停连接）` });
  }
  const rows = INVARIANTS.map((inv) => {
    const proof = proofs.find((x) => x.id === inv.id);
    const mine = plants.filter((x) => x.catches === inv.id);
    return {
      id: `${inv.id} ${inv.title}`,
      proof: proof?.ok ? '✅' : `❌ ${proof?.detail || ''}`,
      plant: mine.map((x) => `${x.plant}：${x.what}`).join('；'),
      landed: mine.length ? mine.map((x) => (x.landed ? '是' : '没有（这一版上没发生）')).join('、') : '—',
      caught: mine.length ? mine.map((x) => (x.landed ? (x.caught ? '✅' : '❌') : '—')).join('、') : '—',
    };
  });
  const notes = [];
  if (!proofs[0].ok) notes.push(`干净的数据也有不过的：${proofs[0].detail}`);
  for (const x of plants.filter((p) => !p.landed)) notes.push(`${x.plant} 这次没落地（这一版上没发生：产品挡住了，或前面的步骤没走到），${x.catches} 只靠纯数据证明。`);
  for (const x of plants.filter((p) => p.errors?.length)) notes.push(`${x.scenario}（埋 ${x.plant}）运行时：${x.errors.join('；')}`);
  for (const r of clean.filter((c) => c.errors.length)) notes.push(`${r.id} 不埋跑的时候：${r.errors.join('；')}`);
  const harnessOk = proofs.every((x) => x.ok) && plants.every((x) => x.ok) && clean.every((r) => !r.errors.length);
  return { ok: harnessOk, proofs, plants, clean, rows, notes };
}
