// 1.5.64: what the user's content group ran into on 11-23 (on their cloud hub, driven from
// the PC in 全部机器). Six fixes:
//   G64-1 another machine's group draws its members by name and face (task board, hand-off, sender);
//   G64-2 messages sent in a row start one turn (a short hold while more keep coming);
//   G64-3 the human's words during a running board reach the coordinator, which can stop or
//         redirect a member's step (task_change) - not whichever member happened to be busy;
//   G64-4 a bot never silently writes over a file the human uploaded (a new name next to it);
//   G64-5 a busy bot answers a burst once: 「收到，这一步做完就看。」, no quoting;
//   G64-6 a login page that needs the human: the bot raises the takeover card and the board waits.
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
// IDs used here start with g64 so they never clash with other scenarios.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** A top-level function of a source file, as source. */
function fnSource(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

const GROUP_FNS = ['isGroupMode', 'botById', 'groupById', 'groupMemberById', 'groupMembers', 'faceOf', 'isRemoteId', 'remoteOf', 'remoteBotById', 'remoteGroupById', 'groupMembersForCard', 'groupFace', 'senderOf'];

/** The page's member lookups (03-groups.js) over a given state, without a DOM. */
function pageLookups(groupsSrc, avatarsSrc, state) {
  const body = GROUP_FNS.map((n) => fnSource(groupsSrc, n)).filter(Boolean).join('\n');
  const avatarOf = fnSource(avatarsSrc, 'avatarOf');
  const api = new Function('state', 'selfMachineName', 'SHAPE_IDS', 'LEGACY_SHAPES', 'AVATAR_DEFAULT',
    `${body}\n${avatarOf}\nreturn { ${GROUP_FNS.filter((n) => fnSource(groupsSrc, n)).join(', ')}, avatarOf };`);
  return api(state, '客厅电脑', new Set(['circle', 'hex', 'blob', 'square']), {}, { shape: 'circle', color: '#7c6cf0' });
}

// ---------------------------------------------------------------------------
// G64-1: two hubs - a group with a board and a hand-off on 腾讯云, opened from here in 全部机器
// ---------------------------------------------------------------------------
export async function remoteGroupFaceChecks({ check, readText, api, rawFetch, startServerChild, stopProcess, seedHome }) {
  const farHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-g64far-'));
  await seedHome(farHome);
  let far = null;
  const M = '腾讯云';
  const enc = encodeURIComponent(M);
  try {
    far = await startServerChild(farHome, { ASSIST_DATA_DIR: path.join(farHome, 'data'), ASSIST_WORKSPACE_DIR: path.join(farHome, 'workspace') });
    const B = far.url;
    const bKey = fs.readFileSync(path.join(farHome, 'data', 'local-key'), 'utf8').trim();
    const bToken = JSON.parse(fs.readFileSync(path.join(farHome, 'data', 'security.json'), 'utf8')).token;
    const bApi = async (p, { method = 'GET', body } = {}) => {
      const res = await rawFetch(`${B}${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-lamplit-local': bKey }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    // On 腾讯云: 组长 (coordinator), 发布 and 画师, each with its own colour; ops there is renamed so that
    // a member's plain id is also a bot id here (ops) - the page must not show this machine's ops for it.
    const make = async (name, color) => {
      const made = (await bApi('/api/bots', { method: 'POST', body: { name, role: `${name}的活` } })).json;
      const id = made?.bot?.id || made?.id;
      await bApi(`/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: { avatar: { shape: 'hex', color } } });
      return id;
    };
    const lead = await make('组长', '#0ea5e9');
    const pub = await make('发布', '#16a34a');
    const art = await make('画师', '#db2777');
    await bApi('/api/bots/ops', { method: 'PATCH', body: { name: '剪辑', avatar: { shape: 'hex', color: '#a16207' } } });
    const grp = (await bApi('/api/groups', { method: 'POST', body: { name: 'g64 测试组', members: [lead, pub, art, 'ops'], coordinatorId: lead } })).json?.group;
    const gid = grp?.id;
    // Its board and a hand-off, as that machine's runtime writes them (plain ids).
    const dataB = path.join(farHome, 'data');
    const planId = 'plan_g64_far';
    const tasks = [
      { id: 't1', title: '上传清单', owner: pub, brief: '', deliverable: '', needs: [], status: 'done', result: '清单在 交付/上传清单.md' },
      { id: 't2', title: '补一张封面', owner: art, brief: '', deliverable: '', needs: [], status: 'doing', result: '' },
      { id: 't3', title: '剪片头', owner: 'ops', brief: '', deliverable: '', needs: [], status: 'todo', result: '' },
    ];
    fs.mkdirSync(path.join(dataB, 'groups', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(dataB, 'groups', 'plans', `${planId}.json`), JSON.stringify({ id: planId, groupId: gid, request: '发视频', coordinatorId: lead, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks }));
    const lines = [
      { id: 'm_g64_1', ts: new Date().toISOString(), kind: 'user', from: 'user', text: '按顺序一天一条' },
      { id: 'm_g64_2', ts: new Date().toISOString(), kind: 'plan', from: lead, planId, text: '1. 上传清单 —— 发布' },
      { id: 'm_g64_3', ts: new Date().toISOString(), kind: 'handoff', from: lead, to: pub, text: '今天发第 1 条' },
      { id: 'm_g64_4', ts: new Date().toISOString(), kind: 'assistant', from: art, text: '封面做好了 @发布' },
    ];
    fs.appendFileSync(path.join(dataB, 'groups', `${gid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    // This hub (客厅电脑) knows 腾讯云; the page reads the roster, the transcript and the board through here.
    await api('/api/peers', { method: 'PUT', body: { self: { name: '客厅电脑' }, peers: [{ name: M, url: B, token: bToken }] } });
    const roster = (await api('/api/peers/roster?fresh=1')).json;
    const msgs = (await api(`/api/peers/${enc}/groups/${encodeURIComponent(gid)}/messages?limit=50`)).json;
    const plan = (await api(`/api/peers/${enc}/groups/${encodeURIComponent(gid)}/plans/${planId}`)).json?.plan;
    const hereBots = (await api('/api/bots')).json;
    const list = Array.isArray(hereBots) ? hereBots : hereBots?.bots || [];
    const items = Array.isArray(msgs) ? msgs : msgs?.messages || [];

    const groupsSrc = await readText('../public/app/main/03-groups.js');
    const avatarsSrc = await readText('../public/app/main/02-avatars.js');
    const state = { bots: list, groups: [], groupId: `${gid}@${M}`, peerRoster: roster?.machines || [] };
    const page = pageLookups(groupsSrc, avatarsSrc, state);
    const board = page.groupMembersForCard();
    const rows = (plan?.tasks || []).map((t) => { const who = board.get(t.owner); return { owner: t.owner, name: who?.name || t.owner, color: page.avatarOf(page.faceOf(who)).color }; });
    const hand = items.find((m) => m.kind === 'handoff');
    const sender = page.senderOf(hand || {});
    const target = page.groupFace(hand?.to);
    const said = page.senderOf(items.find((m) => m.kind === 'assistant') || {});
    check('G64-1a 全部机器, another machine\'s group: each task board row says the member\'s name (发布 / 画师 / 剪辑), never its id there (bot-…), with that member\'s own colour - also when this machine has a bot of the same id (ops)',
      rows.length === 3 && rows[0].name === '发布' && rows[1].name === '画师' && rows[2].name === '剪辑'
      && rows[0].color === '#16a34a' && rows[1].color === '#db2777' && rows[2].color === '#a16207' && list.some((b) => b.id === 'ops'),
      JSON.stringify({ rows, roster: (roster?.machines || []).map((m) => ({ m: m.machine, groups: (m.groups || []).length })) }));
    check('G64-1b the hand-off line reads 组长 → 发布 with the coordinator\'s face, and a member\'s message is signed with its name and face',
      sender?.name === '组长' && target?.name === '发布' && page.avatarOf(page.faceOf(sender)).color === '#0ea5e9' && said?.name === '画师' && page.avatarOf(page.faceOf(said)).color === '#db2777',
      JSON.stringify({ sender, target, said }));

    // That machine answered with its bots but not its groups this time (a slow look: /api/groups timed out).
    const thin = { ...state, peerRoster: (state.peerRoster || []).map((m) => (m.machine === M ? { ...m, groups: [] } : m)) };
    const page2 = pageLookups(groupsSrc, avatarsSrc, thin);
    const board2 = page2.groupMembersForCard();
    const sender2 = page2.senderOf(hand || {});
    check('G64-1e even when that machine\'s group list did not come this time, the board and the hand-off still name the members (from its list of bots), never an id',
      board2.get(pub)?.name === '发布' && board2.get(art)?.name === '画师' && sender2?.name === '组长' && page2.groupFace(hand?.to)?.name === '发布',
      JSON.stringify({ pub: board2.get(pub)?.name, sender2: sender2?.name }));

    // The same page code from before (1.5.63) shows the bug the user saw: ids on the board.
    const { execFileSync } = await import('node:child_process');
    let old = '';
    try { old = execFileSync('git', ['show', '4edba73:public/app/main/03-groups.js'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n'); } catch { /* a shallow checkout: skipped */ }
    if (old && !old.includes('function groupFace(')) {
      const before = pageLookups(old, avatarsSrc, state);
      const oldBoard = before.groupMembersForCard();
      check('G64-1c (the bug as it was) the 1.5.63 page code gives ids for that board: what the user\'s screenshots showed',
        !oldBoard.get(pub) && !oldBoard.get(art), JSON.stringify({ pub: oldBoard.get(pub) || null }));
    }
    const live = await readText('../public/app/main/06-live.js');
    const chat = await readText('../public/app/main/05-chat.js');
    check('G64-1d the working line and @mentions in another machine\'s group use its members too (not only this machine\'s bots)',
      live.includes('const bot = groupFace(botId);') && chat.includes('groupMembers(groupById(state.groupId))') && chat.includes('const bot = people.find((b) => b && b.name === m[1]);'));
  } finally {
    if (far) await stopProcess(far.child).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// A small real group: the runtime's own loop, a scripted model, the real tools
// ---------------------------------------------------------------------------
async function groupRig({ toolsMod, groupsMod, script, gather = {}, approvals = null }) {
  const { AgentRuntime } = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g64-'));
  const bots = new Map([
    ['g64lead', { id: 'g64lead', name: '组长', role: '协调', persona: 'WHO:lead', tools: ['fs_list', 'fs_read'], skills: [], policy: {} }],
    ['g64pub', { id: 'g64pub', name: '发布', role: '发布', persona: 'WHO:pub', tools: ['fs_list', 'fs_write', 'request_takeover'], skills: [], policy: {} }],
    ['g64art', { id: 'g64art', name: '画师', role: '画师', persona: 'WHO:art', tools: ['fs_list', 'fs_write', 'shell'], skills: [], policy: { autoApproveMedium: true } }],
  ]);
  const group = { id: `g64g_${Math.random().toString(36).slice(2, 8)}`, name: 'g64 测试组', coordinatorId: 'g64lead', members: [...bots.values()].map(({ id, name, role, tools }) => ({ id, name, role, tools })) };
  const ev = [];
  const calls = [];
  const model = {
    provider: 'fake', model: 'fake',
    complete: async (messages, opts = {}) => {
      const sys = String(messages[0]?.content || '');
      const who = /WHO:(\w+)/.exec(sys)?.[1] || (/群「.*」的协调者/.test(sys) ? 'review' : /不能用任何工具/.test(sys) ? 'aside' : '?');
      const last = String(messages[messages.length - 1]?.content || '');
      calls.push({ who, last, tools: (opts.tools || []).map((t) => t.function?.name || t.name) });
      return script({ who, last, messages, opts, n: calls.filter((c) => c.who === who).length });
    },
  };
  const rt = new AgentRuntime({
    config: { workspaceDir: ws, policy: {} }, registry: toolsMod.createRegistry({ workspaceDir: ws, config: {} }), model,
    bots: { getBot: async (id) => bots.get(id) || null, listBots: async () => [...bots.values()] },
    groups: groupsMod, memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
    approvals: approvals || { cancelForTurn() {}, pendingForTurn: () => [], request: () => Promise.resolve({ decision: 'approved' }) },
    bus: { emit: (e) => ev.push(e) },
  });
  rt.record = async () => {};
  Object.assign(rt, gather);
  const transcript = async () => groupsMod.readGroupMessages(group.id, { limit: 500 });
  const done = () => fs.rmSync(ws, { recursive: true, force: true });
  return { rt, ev, calls, group, ws, bots, transcript, done };
}

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = `c_${Math.random().toString(36).slice(2, 8)}`) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });

// ---------------------------------------------------------------------------
// G64-2: three messages in a row, one turn
// ---------------------------------------------------------------------------
export async function burstChecks({ check, toolsMod, groupsMod, startServerChild, stopProcess, seedHome, rawFetch }) {
  const agent = await import('../src/agent.mjs');
  {
    const rig = await groupRig({ toolsMod, groupsMod, gather: { gatherMs: 300, gatherFilesMs: 600, gatherMaxMs: 3000 }, script: ({ who }) => (who === 'lead' ? say('收到，三条都看到了。') : say('好。')) });
    const t0 = Date.now();
    const a = await rig.rt.routeGroupMessage({ group: rig.group, text: '文案写好了（见附件）\n\n[附件] 都在共享工作区里：\n- uploads/2026-11-23/1.mp4（文件）', turnId: 'turn_g64_a', fromHuman: true, files: true });
    await sleep(250);
    const b = await rig.rt.routeGroupMessage({ group: rig.group, text: '（见附件）\n\n[附件] 都在共享工作区里：\n- uploads/2026-11-23/6.mp4（文件）', turnId: 'turn_g64_b', fromHuman: true, files: true });
    await sleep(250);
    const c = await rig.rt.routeGroupMessage({ group: rig.group, text: '按顺序一天一条', turnId: 'turn_g64_c', fromHuman: true });
    await until(async () => rig.ev.some((e) => e.type === 'turn.end' && !e.aside && e.botId === 'g64lead'), 5000);
    const started = rig.ev.filter((e) => e.type === 'turn.start' && !e.aside);
    const firstStart = rig.calls.findIndex((x) => x.who === 'lead');
    const leadSaw = rig.calls.find((x) => x.who === 'lead')?.last || '';
    const users = (await rig.transcript()).filter((m) => m.kind === 'user');
    check('G64-2a three messages sent within a few seconds (text with files, more files, 「按顺序一天一条」) start ONE coordinator turn that reads all three, after the last one - not a turn on the first',
      started.length === 1 && started[0].turnId === 'turn_g64_a' && a.turnId === 'turn_g64_a' && b.folded && c.folded && b.turnId === 'turn_g64_a' && firstStart >= 0
      && /连着发了 3 条消息/.test(leadSaw) && leadSaw.includes('【第 3 条】\n按顺序一天一条') && rig.calls.filter((x) => x.who === 'lead').length === 1,
      JSON.stringify({ started: started.map((e) => e.turnId), a, b, c, leadSaw: leadSaw.slice(0, 120) }));
    check('G64-2b each message stays its own bubble in the group, in order, under the one turn',
      users.length === 3 && users[2].text === '按顺序一天一条' && users.every((m) => m.turnId === 'turn_g64_a'), JSON.stringify(users.map((m) => m.text.slice(0, 12))));
    rig.done();
    void t0;
  }
  {
    // A lone message waits only the short hold; with the setting at 0 it starts at once.
    const rig = await groupRig({ toolsMod, groupsMod, gather: { gatherMs: 300, gatherFilesMs: 600, gatherMaxMs: 3000 }, script: () => say('好。') });
    const t0 = Date.now();
    await rig.rt.routeGroupMessage({ group: rig.group, text: '先发第一条', turnId: 'turn_g64_lone', fromHuman: true });
    await until(() => rig.ev.some((e) => e.type === 'turn.start' && !e.aside), 3000);
    const waited = Date.now() - t0;
    const rig0 = await groupRig({ toolsMod, groupsMod, gather: { gatherMs: 0 }, script: () => say('好。') });
    const t1 = Date.now();
    await rig0.rt.routeGroupMessage({ group: rig0.group, text: '先发第一条', turnId: 'turn_g64_now', fromHuman: true });
    const atOnce = await until(() => rig0.ev.some((e) => e.type === 'turn.start' && e.turnId === 'turn_g64_now'), 2000) && Date.now() - t1 < 250;
    check('G64-2c a lone message is held only the short wait (here 0.3 s; the product waits 2.5 s, 4 s after files, never over 10 s), and with LAMPLIT_GATHER_MS=0 it starts at once',
      waited >= 280 && waited < 1500 && atOnce && agent.GATHER_MS === 2500 && agent.GATHER_FILES_MS === 4000 && agent.GATHER_MAX_MS === 10000, JSON.stringify({ waited, atOnce }));
    rig.done();
    rig0.done();
  }
  // The real route on a hub with the hold on: two messages to a bot in a row are one turn; a voice call and a
  // hand-off from another machine are never held.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-g64hold-'));
  await seedHome(home);
  let hub = null;
  try {
    hub = await startServerChild(home, { ASSIST_DATA_DIR: path.join(home, 'data'), ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'), LAMPLIT_GATHER_MS: '700' });
    const key = fs.readFileSync(path.join(home, 'data', 'local-key'), 'utf8').trim();
    const post = async (p, body) => { const r = await rawFetch(`${hub.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lamplit-local': key }, body: JSON.stringify(body) }); return r.json().catch(() => null); };
    const get = async (p) => (await rawFetch(`${hub.url}${p}`, { headers: { 'x-lamplit-local': key } })).json().catch(() => null);
    const one = await post('/api/bots/chief/message', { text: '你好' });
    const two = await post('/api/bots/chief/message', { text: '介绍一下你自己' });
    await until(async () => (await get('/api/bots/chief/messages?limit=20') || []).some((m) => m.role === 'assistant' && m.turnId === one?.turnId), 15000);
    const rows = (await get('/api/bots/chief/messages?limit=20')) || [];
    const mine = rows.filter((m) => m.role === 'user' && (m.text === '你好' || m.text === '介绍一下你自己'));
    const voice = await post('/api/bots/chief/message', { text: '在吗', voiceCall: true });
    const voiceStarted = await until(async () => ((await get('/api/turns')) || []).some((t) => t.turnId === voice?.turnId || t.id === voice?.turnId)
      || ((await get('/api/bots/chief/messages?limit=30')) || []).some((m) => m.turnId === voice?.turnId && m.role === 'user'), 600);
    check('G64-2d on a real hub (hold 0.7 s): two messages to a bot in a row answer with the same turn (the second says folded), both are in the chat as sent, one reply; a voice call is never held',
      one?.turnId && two?.turnId === one.turnId && two.folded === true && mine.length === 2 && mine.every((m) => m.turnId === one.turnId)
      && rows.filter((m) => m.role === 'assistant' && m.turnId === one.turnId).length >= 1 && Boolean(voiceStarted),
      JSON.stringify({ one, two, mine: mine.map((m) => m.turnId), voiceStarted }));
  } finally {
    if (hub) await stopProcess(hub.child).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// G64-3: the human's word during a running board reaches the coordinator
// ---------------------------------------------------------------------------
export async function midPlanChecks({ check, toolsMod, groupsMod }) {
  const { loadPlan } = await import('../src/plans.mjs');
  // 画师 works on the cover step by step (each step a small file) until it is stopped; 发布 takes a few steps too.
  let artSaw = [];
  const rig = await groupRig({
    toolsMod, groupsMod, gather: { gatherMs: 0, ackMs: 200 },
    script: async ({ who, last, n, messages }) => {
      if (who === 'lead' && /任务板做完了/.test(last)) return say(`汇总：${/任务板进行中，用户在群里又说了/.test(last) ? '用了你给的封面' : '照原计划'}。`);
      if (who === 'lead') return call('group_plan', { tasks: [{ title: '上传清单', owner: '发布', brief: '列清单' }, { title: '补一张封面', owner: '画师', brief: '做封面' }] });
      if (who === 'review') return { content: '好，第 2 项不用做了，封面就用你发的。', toolCalls: [{ id: 'tc1', name: 'task_change', arguments: { action: 'stop', task: 2, reason: '用户自己发来了封面' } }] };
      if (who === 'pub') { await sleep(120); return n < 6 ? call('fs_write', { path: `g64/pub-${n}.txt`, content: 'x' }) : say('清单做好了：g64/pub-5.txt'); }
      if (who === 'art') { artSaw = messages.map((m) => String(m.content || '')); await sleep(120); return n < 60 ? call('fs_write', { path: `g64/art-${n}.txt`, content: 'x' }) : say('封面做好了'); }
      return say('好。');
    },
  });
  const run = rig.rt.routeGroupMessage({ group: rig.group, text: '发布前把素材准备好', turnId: 'turn_g64_plan', fromHuman: true });
  await run;
  // Both members are at work: the human sends the cover.
  await until(() => rig.rt.busyTurn?.('g64art', { any: true }) || [...rig.rt.active.values()].some((i) => i.botId === 'g64art'), 5000);
  await until(() => [...rig.rt.active.values()].some((i) => i.botId === 'g64pub'), 3000);
  const cover = '（见附件）\n\n[附件] 都在共享工作区里：\n- uploads/2026-11-23/5-封面.jpg（图片，100 KB）';
  const routed = await rig.rt.routeGroupMessage({ group: rig.group, text: cover, turnId: 'turn_g64_cover', fromHuman: true, files: true });
  const plan = rig.rt.plans.get(rig.group.id);
  // The board on disk (written just after the one in memory).
  await until(async () => plan?.status === 'done' && (await loadPlan(plan.id))?.status === 'done', 8000);
  const saved = await loadPlan(plan.id);
  const msgs = await rig.transcript();
  const asides = rig.ev.filter((e) => e.type === 'message' && e.aside);
  const review = rig.calls.find((c) => c.who === 'review');
  check('G64-3a a message while the board runs goes to the coordinator (one look with task_change only), not into whichever member is busy: 发布 gets nothing, no member answers in passing',
    routed?.plan === true && Boolean(review) && review.tools.length === 1 && review.tools[0] === 'task_change'
    && asides.length === 1 && asides[0].botId === 'g64lead' && !rig.calls.some((c) => c.who === 'aside'),
    JSON.stringify({ routed, asides: asides.map((e) => `${e.botId}:${e.text}`), review }));
  const t2 = saved?.tasks?.[1];
  check('G64-3b the coordinator stopped 画师\'s now-needless step at once: its turn was cancelled, the board says 「协调者停掉了这一项：用户自己发来了封面」, the rest went on and the board finished',
    t2?.status === 'skipped' && /协调者停掉了这一项：用户自己发来了封面/.test(t2.result || '') && saved.tasks[0].status === 'done' && saved.status === 'done'
    && rig.calls.filter((c) => c.who === 'art').length < 60,
    JSON.stringify({ t2, status: saved?.status, tasks: saved?.tasks?.map((t) => `${t.title}:${t.status}:${String(t.result || '').slice(0, 60)}`), calls: rig.calls.map((c) => c.who).join(','), errors: rig.ev.filter((e) => e.type === 'error').map((e) => e.message).slice(0, 3) }));
  const sum = rig.calls.find((c) => c.who === 'lead' && /任务板做完了/.test(c.last));
  check('G64-3c what the human said is kept on the board (updates) and the final summary is told it; the coordinator\'s reply is posted once in the group, the human\'s message once',
    saved?.updates?.length === 1 && saved.updates[0].text === cover && /任务板进行中，用户在群里又说了/.test(sum?.last || '')
    && msgs.filter((m) => m.kind === 'user' && m.text === cover).length === 1 && msgs.filter((m) => m.kind === 'assistant' && m.from === 'g64lead' && /第 2 项不用做了/.test(m.text)).length === 1,
    JSON.stringify({ updates: saved?.updates, sum: (sum?.last || '').slice(0, 80) }));
  rig.done();
  void artSaw;

  // note: a new requirement reaches the member at work before its next step; add: a new task starts.
  let pubSaw = '';
  const rig2 = await groupRig({
    toolsMod, groupsMod, gather: { gatherMs: 0, ackMs: 100 },
    script: async ({ who, last, n, messages }) => {
      if (who === 'lead' && /任务板做完了/.test(last)) return say('汇总好了。');
      if (who === 'lead') return call('group_plan', { tasks: [{ title: '写标题', owner: '发布', brief: '写 7 条标题' }] });
      if (who === 'review') return { content: '好。', toolCalls: [
        { id: 'n1', name: 'task_change', arguments: { action: 'note', task: 1, reason: '标题都控制在 20 字以内' } },
        { id: 'n2', name: 'task_change', arguments: { action: 'add', title: '补一张竖版封面', owner: '画师', brief: '9:16' } },
      ] };
      if (who === 'pub') { const joined = messages.map((m) => String(m.content || '')).join('\n'); if (/协调者「组长」在你做这一项时转来新情况/.test(joined)) { pubSaw = joined; return say('标题都改到 20 字以内了。'); } await sleep(100); return n < 40 ? call('fs_write', { path: `g64/t-${n}.txt`, content: 'x' }) : say('写好了'); }
      if (who === 'art') return say('竖版封面做好了：g64/v.jpg');
      return say('好。');
    },
  });
  await rig2.rt.routeGroupMessage({ group: rig2.group, text: '写标题', turnId: 'turn_g64_n', fromHuman: true });
  await until(() => [...rig2.rt.active.values()].some((i) => i.botId === 'g64pub'), 5000);
  await rig2.rt.routeGroupMessage({ group: rig2.group, text: '标题都别超过 20 字，再加一张竖版封面', turnId: 'turn_g64_n2', fromHuman: true });
  const p2 = rig2.rt.plans.get(rig2.group.id);
  await until(() => p2?.status === 'done', 8000);
  check('G64-3d task_change note reaches the member at work before its next step (「协调者「组长」在你做这一项时转来新情况」), and add puts a new task on the board that runs',
    /标题都控制在 20 字以内/.test(pubSaw) && p2.tasks.length === 2 && p2.tasks[1].title === '补一张竖版封面' && p2.tasks[1].owner === 'g64art' && p2.tasks[1].status === 'done' && p2.status === 'done',
    JSON.stringify({ tasks: p2?.tasks?.map((t) => `${t.title}:${t.status}`), saw: Boolean(pubSaw) }));
  rig2.done();
}

// ---------------------------------------------------------------------------
// G64-4: the human's upload is never written over
// ---------------------------------------------------------------------------
export async function uploadKeepChecks({ check, toolsMod, groupsMod, readText }) {
  const keep = await import('../src/keepuploads.mjs');
  const rig = await groupRig({
    toolsMod, groupsMod, gather: { gatherMs: 0 },
    script: ({ who, n }) => {
      if (who !== 'art') return say('好。');
      // 1: ffmpeg-like overwrite of the upload in a shell step; 2: fs_write onto it; 3: its own new file, twice.
      if (n === 1) return call('shell', { command: 'node -e "require(\'fs\').writeFileSync(\'uploads/2026-11-23/5-封面.jpg\', \'NEW-BY-SHELL\')"' });
      if (n === 2) return call('fs_write', { path: 'uploads/2026-11-23/5-封面.jpg', content: 'NEW-BY-WRITE' });
      if (n === 3) return call('fs_write', { path: 'uploads/2026-11-23/art-own.txt', content: 'one' });
      if (n === 4) return call('fs_write', { path: 'uploads/2026-11-23/art-own.txt', content: 'two' });
      return say('封面做好了。');
    },
  });
  const up = path.join(rig.ws, 'uploads', '2026-11-23');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, '5-封面.jpg'), 'ORIGINAL');
  const res = await rig.rt.runTurn({ botId: 'g64art', text: '补一张封面', source: 'group', group: rig.group, groupRole: 'task', recordUser: false });
  const results = rig.ev.filter((e) => e.type === 'tool.result' && e.botId === 'g64art');
  const shellRes = results.find((e) => e.name === 'shell');
  const writes = results.filter((e) => e.name === 'fs_write');
  const files = fs.readdirSync(up).sort();
  const read = (f) => fs.readFileSync(path.join(up, f), 'utf8');
  check('G64-4a a shell step that writes over the human\'s upload (as 画师\'s ffmpeg did): the original comes back, the new bytes are kept as 「5-封面-画师.jpg」, and the bot is told to say so',
    res.status === 'success' && read('5-封面.jpg') === 'ORIGINAL' && files.includes('5-封面-画师.jpg') && read('5-封面-画师.jpg') === 'NEW-BY-SHELL'
    && shellRes?.result?.uploadKept?.savedAs === 'uploads/2026-11-23/5-封面-画师.jpg' && /是用户上传的原件，没有被覆盖/.test(shellRes.result.uploadKept.note || ''),
    JSON.stringify({ files, shell: shellRes?.result?.uploadKept || shellRes?.result }));
  check('G64-4b fs_write onto the upload writes a new name next to it (「5-封面-画师-2.jpg」) and says so; a file the bot made there itself it may write again',
    String(writes[0]?.result?.path || '').replace(/\\/g, '/') === 'uploads/2026-11-23/5-封面-画师-2.jpg' && /没有被覆盖/.test(writes[0]?.result?.uploadKept?.note || ''),
    JSON.stringify(writes.map((w) => w.result?.path)));
  check('G64-4c … the upload still holds the human\'s bytes, the new one the bot\'s, and the bot\'s own file was overwritten in place (not turned aside)',
    read('5-封面.jpg') === 'ORIGINAL' && read('5-封面-画师-2.jpg') === 'NEW-BY-WRITE' && writes[0]?.result?.uploadKept?.original === 'uploads/2026-11-23/5-封面.jpg'
    && read('art-own.txt') === 'two' && !writes[2]?.result?.uploadKept && !files.some((f) => /art-own-/.test(f)),
    JSON.stringify({ files }));
  check('G64-4d which paths count: an upload named relatively, as ./uploads/…, or absolute inside the workspace - not one in another folder\'s uploads/',
    keep.uploadPathsIn({ command: 'ffmpeg -y -i a.mp4 uploads/2026-11-23/x.jpg' }, rig.ws).join() === 'uploads/2026-11-23/x.jpg'
    && keep.uploadPathsIn({ command: `cp a.jpg "${path.join(rig.ws, 'uploads', '2026-11-23', 'y.jpg')}"` }, rig.ws).join() === 'uploads/2026-11-23/y.jpg'
    && keep.uploadPathsIn({ command: 'cp a.jpg ./uploads/z.png' }, rig.ws).join() === 'uploads/z.png'
    && keep.uploadPathsIn({ command: 'cp a.jpg /tmp/other/uploads/q.jpg' }, rig.ws).length === 0
    && keep.WRITERS.has('shell') && !keep.WRITERS.has('fs_delete'));
  const agentSrc = await readText('../src/agent.mjs');
  check('G64-4e wiring: every step that may write is checked around the step (shell, coding agents, downloads); fs_write turns aside before it writes',
    agentSrc.includes('const keptUploads = WRITERS.has(name) ? await keepBefore(') && (await readText('../src/tools.mjs')).includes('const aside = r.named && r.inWorkspace ? turnWriteAside('));
  rig.done();
}

// ---------------------------------------------------------------------------
// G64-5: a busy bot answers a burst once
// ---------------------------------------------------------------------------
export async function busyReplyChecks({ check, toolsMod, groupsMod }) {
  const agent = await import('../src/agent.mjs');
  const rig = await groupRig({ toolsMod, groupsMod, gather: { gatherMs: 0, ackMs: 300 }, script: ({ who }) => (who === 'aside' ? say('[组长] 在列上传清单，已经 40 秒。') : say('好。')) });
  const busy = { controller: new AbortController(), botId: 'g64lead', task: '清单写好了：[清单.md](交付/视频/清单.md)。里面有……', startedAt: Date.now() - 40000, steps: 3, step: { name: 'fs_read', args: {}, startedAt: Date.now() - 2000 }, last: '', inbox: [], depth: 0, group: true, groupId: rig.group.id };
  rig.rt.active.set('turn_g64_busy', busy);
  const gBusy = rig.rt.busyGroupTurn(rig.group.id);
  const files = '（见附件）\n\n[附件] 都在共享工作区里：\n- uploads/2026-11-23/6.mp4（文件，6.4 MB）';
  const [r1, r2] = await Promise.all([
    rig.rt.routeGroupMessage({ group: rig.group, text: files, turnId: 'turn_g64_x1', fromHuman: true, files: true }),
    (async () => { await sleep(120); return rig.rt.routeGroupMessage({ group: rig.group, text: '按顺序一天一条', turnId: 'turn_g64_x2', fromHuman: true }); })(),
  ]);
  await until(() => rig.ev.some((e) => e.type === 'turn.end' && e.aside), 3000);
  await sleep(400);
  const answers = rig.ev.filter((e) => e.type === 'message' && e.aside);
  const msgs = await rig.transcript();
  check('G64-5a two messages to a busy coordinator within a moment: ONE reply, 「收到，这一步做完就看。」 - no quoting of the task, no model call for a message that asks nothing; both reach the running turn and the group',
    gBusy?.turnId === 'turn_g64_busy' && r1.aside && r2.aside && answers.length === 1 && answers[0].text === agent.BUSY_ACK && agent.BUSY_ACK === '收到，这一步做完就看。'
    && !rig.calls.some((c) => c.who === 'aside') && busy.inbox.length === 2 && busy.inbox[1] === '按顺序一天一条'
    && msgs.filter((m) => m.kind === 'user').length === 2 && msgs.filter((m) => m.kind === 'assistant').length === 1 && !/清单写好了/.test(answers[0].text),
    JSON.stringify({ answers: answers.map((e) => e.text), inbox: busy.inbox.length, calls: rig.calls.map((c) => c.who) }));
  rig.ev.length = 0;
  await rig.rt.routeGroupMessage({ group: rig.group, text: '做到哪一步了', turnId: 'turn_g64_x3', fromHuman: true });
  await until(() => rig.ev.some((e) => e.type === 'turn.end' && e.aside), 3000);
  const q = rig.ev.filter((e) => e.type === 'message' && e.aside);
  check('G64-5b a question while it works still gets a real answer from what it is doing - once, and without its own 「[组长]」 tag copied from the group',
    q.length === 1 && q[0].text === '在列上传清单，已经 40 秒。' && rig.calls.filter((c) => c.who === 'aside').length === 1, JSON.stringify(q.map((e) => e.text)));
  check('G64-5c what counts as a question: progress, why, 吗/呢, a question mark - not files or a new requirement',
    agent.asksSomething('做到哪一步了') && agent.asksSomething('为什么这么慢呀') && agent.asksSomething('进度怎么样') && agent.asksSomething('好了吗') && agent.asksSomething('要多久？')
    && !agent.asksSomething('按顺序一天一条') && !agent.asksSomething(files) && !agent.asksSomething('先发第一条'));
  rig.rt.active.delete('turn_g64_busy');
  rig.done();
}

// ---------------------------------------------------------------------------
// G64-6: a login only the human can pass
// ---------------------------------------------------------------------------
export async function loginWallChecks({ check, toolsMod, groupsMod, readText }) {
  const { loginWallOf, withLoginWall } = toolsMod;
  const walls = [
    loginWallOf({ url: 'https://passport.bilibili.com/login?gourl=https%3A%2F%2Fmember.bilibili.com', title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili' }),
    loginWallOf({ url: 'https://channels.weixin.qq.com/login.html', title: '视频号助手' }),
    loginWallOf({ url: 'https://www.zhihu.com/signin?next=%2Fcreator', title: '知乎 - 有问题，就会有答案' }),
    loginWallOf({ url: 'https://example.com/creator', title: '创作中心', text: '请使用微信扫一扫登录' }),
    loginWallOf({ url: 'https://example.com/a', title: '账号登录' }),
  ];
  const open = [
    loginWallOf({ url: 'https://www.bilibili.com/', title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', text: '首页 番剧 直播 登录 投稿' }),
    loginWallOf({ url: 'https://member.bilibili.com/platform/upload/video/frame', title: '创作中心 - 哔哩哔哩', text: '上传视频 登录设备管理' }),
    loginWallOf({ url: 'https://example.com/logout', title: '再见' }),
  ];
  const tagged = withLoginWall({ ok: true, url: 'https://passport.bilibili.com/login', title: '登录' });
  check('G64-6a a page that stops at a login the human must pass is recognised (B站 passport, 视频号 login, 知乎 signin, 扫一扫 text, a 「账号登录」 title); a site\'s ordinary pages with a 「登录」 link are not',
    walls.every(Boolean) && walls[3].kind === 'qr' && open.every((w) => w === null) && /现在就调用 request_takeover/.test(tagged.loginWall?.note || '') && withLoginWall({ ok: false, error: 'x' }).loginWall === undefined,
    JSON.stringify({ walls, open }));
  const agentSrc = await readText('../src/agent.mjs');
  const toolsSrc = await readText('../src/tools.mjs');
  check('G64-6b browser_open and browser_snapshot carry the hint; the takeover rules say: hand over the moment you hit it, never end the turn with a report that a site needs a login',
    toolsSrc.includes('return withLoginWall(await browserManager(ctx).open(args));') && toolsSrc.includes('run: async (_args, ctx) => withLoginWall(await browserManager(ctx).snapshot()),')
    && agentSrc.includes('Never end your turn with a report that a site needs a login'));

  // On the board: 发布 raises the takeover card; the board waits for the human; 「好了」 sends it back to work.
  const { loadPlan } = await import('../src/plans.mjs');
  let back = '';
  const rig = await groupRig({
    toolsMod, groupsMod, gather: { gatherMs: 0, ackMs: 100 },
    script: ({ who, last, n }) => {
      if (who === 'lead' && /任务板做完了/.test(last)) return say('发好了。');
      if (who === 'lead') return call('group_plan', { tasks: [{ title: '在 B 站发第 1 条', owner: '发布', brief: '登录后上传' }] });
      if (who === 'pub' && /用户的回答：好了/.test(last)) { back = last; return say('已经发出去了。'); }
      if (who === 'pub') return n === 1 ? call('request_takeover', { reason: '在打开的 B 站页面扫码登录' }) : say('等你扫码。');
      return say('好。');
    },
  });
  await rig.rt.routeGroupMessage({ group: rig.group, text: '先发第一条', turnId: 'turn_g64_login', fromHuman: true });
  const plan = await until(() => { const p = rig.rt.plans?.get(rig.group.id); return p?.status === 'waiting' ? p : null; }, 5000);
  const card = rig.ev.find((e) => e.type === 'tool.result' && e.name === 'request_takeover');
  const waiting = plan?.tasks?.[0];
  check('G64-6c in a group\'s board the takeover card goes up and the task WAITS for the human (等你回复, the board too) instead of being called done with 「等你接管屏幕」 as its result',
    Boolean(card) && card.groupId === rig.group.id && waiting?.status === 'waiting_human' && /需要你接管屏幕：在打开的 B 站页面扫码登录/.test(waiting.question || '') && plan.status === 'waiting',
    JSON.stringify({ card: Boolean(card), waiting, status: plan?.status }));
  const took = await rig.rt.answerBoard(rig.group, '好了');
  await until(async () => (await loadPlan(plan.id))?.status === 'done', 5000);
  const saved = await loadPlan(plan.id);
  check('G64-6d after the human logs in and says 「好了」 in the group, 发布 goes back to the same task and finishes it; the board ends done',
    took === true && /用户的回答：好了/.test(back) && saved?.tasks?.[0]?.status === 'done' && saved.status === 'done', JSON.stringify({ took, status: saved?.status, task: saved?.tasks?.[0]?.status }));
  rig.done();
}

// ---------------------------------------------------------------------------
// G64-7: 「改了 N 个文件」 sits under the turn's own reply, in the chat column
// ---------------------------------------------------------------------------
/** A few DOM nodes, enough for placeChanges (no browser). */
function fakeDom() {
  const node = (cls = '') => {
    const n = { className: cls, children: [], parent: null };
    n.classList = { contains: (c) => n.className.split(/\s+/).includes(c) };
    n.appendChild = (c) => { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c); return c; };
    Object.defineProperty(n, 'lastElementChild', { get: () => n.children[n.children.length - 1] || null });
    n.querySelector = (sel) => {
      const want = sel.replace(/^\./, '');
      const walk = (x) => { for (const c of x.children) { if (c.classList.contains(want)) return c; const d = walk(c); if (d) return d; } return null; };
      return walk(n);
    };
    return n;
  };
  return { node, el: (_tag, cls) => node(cls || '') };
}

export async function changesLineChecks({ check, readText }) {
  const groupsSrc = await readText('../public/app/main/03-groups.js');
  const chatSrc = await readText('../public/app/main/05-chat.js');
  const css = await readText('../public/app/style.css');
  const { node, el } = fakeDom();
  const placeIn = (messagesEl) => new Function('messagesEl', 'el', `${fnSource(groupsSrc, 'placeChanges')}; return placeChanges;`)(messagesEl, el);
  // A bot's turn on another machine: its reply (it wrote a file), then the 接管屏幕 card it raised, drawn after it.
  const messagesEl = node('messages');
  const reply = messagesEl.appendChild(node('row bot'));
  reply.appendChild(node('bubble'));
  const card = messagesEl.appendChild(node('row bot takeover'));
  card.appendChild(node('takeover-card'));
  const line = node('changes-wrap');
  placeIn(messagesEl)(line, reply);
  const underReply = line.parent?.classList.contains('bubble-actions') && line.parent.parent === reply.children[0];
  // No reply in that turn at all: a line of its own - never inside the human's own bubble.
  const m2 = node('messages');
  const mine = m2.appendChild(node('row user'));
  mine.appendChild(node('bubble'));
  const lone = node('changes-wrap');
  placeIn(m2)(lone);
  check('G64-7a a turn that changed a file and then raised 接管屏幕: 「改了 1 个文件」 goes under that turn\'s own reply (its action row), not after the card',
    underReply && !card.querySelector('.changes-wrap') && chatSrc.includes('placeChanges(changesLine(item.turnId, changesByTurn.get(item.turnId)), replyOfTurn.get(item.turnId));'),
    JSON.stringify({ parent: line.parent?.className }));
  check('G64-7b with no reply to sit under it is a line of its own (never in the human\'s bubble), and that line is in the chat column (760 px, centred, indented like the replies)',
    lone.parent?.className === 'changes-line' && !mine.querySelector('.changes-wrap')
    // 1.5.65: the column itself is the list's side padding (checked for every line in smoke-group-1565.mjs, G65-7).
    && /\.changes-line \{ display: flex; align-items: center; gap: 8px; margin: 2px 0 10px 44px;/.test(css) && css.includes('padding-left: max(var(--msg-pad, 24px), calc((100% - var(--chat-col)) / 2));'));
}

// ---------------------------------------------------------------------------
// G64-8: browser_upload finds the hidden file box in a dialog by itself
// ---------------------------------------------------------------------------
export async function uploadBoxChecks({ check, toolsMod, browserMod, skip }) {
  const { fileBoxTakes } = browserMod;
  check('G64-8a which box takes which file: accept by extension or type, image/* too; an empty accept takes anything',
    fileBoxTakes('image/png, image/jpeg', ['a/cover.jpg']) && !fileBoxTakes('image/png, image/jpeg', ['a/v.mp4']) && fileBoxTakes('.mp4,.flv,.mov', ['v.mp4'])
    && !fileBoxTakes('.mp4,.flv', ['c.jpg']) && fileBoxTakes('image/*', ['c.webp']) && fileBoxTakes('', ['x.bin']) && !fileBoxTakes('.zip', ['c.jpg', 'd.zip']));
  const toolsSrc = fs.readFileSync(path.join(REPO, 'src', 'tools.mjs'), 'utf8');
  check('G64-8b the tool says hidden file boxes are set directly (no clicking 上传, no screen coordinates), and lists the boxes when it cannot tell which',
    toolsSrc.includes('Hidden file boxes (display:none, inside an open dialog, in shadow DOM or a same-site frame) are set directly') && toolsSrc.includes("throw toolError('OUTSIDE_WORKSPACE'"));
  // The harness points CHROME_PATH at nothing (smoke.mjs): find the real browser the way the product does.
  const savedChrome = process.env.CHROME_PATH;
  delete process.env.CHROME_PATH;
  const found = browserMod.detectBrowserExecutable().path;
  if (savedChrome !== undefined) process.env.CHROME_PATH = savedChrome;
  if (!found) { skip('G64-8c..e (a real browser)', 'no Chromium-based browser on this machine'); return; }
  const http = await import('node:http');
  // Like a video site's upload page: a video box first, then the cover dialog with a hidden image box; a same-site frame with a .zip box.
  const PAGE = `<!doctype html><html><head><title>g64 upload</title><style>.modal{position:fixed;top:40px;left:40px;width:300px;height:200px;background:#fff;border:1px solid #888}</style></head><body>
<p>上传视频 <input type="file" id="video" accept=".mp4,.flv,.mov"></p>
<div class="modal" role="dialog"><p>拖拽图片或点击上传</p><input type="file" id="cover" accept="image/png, image/jpeg" style="display:none"></div>
<iframe id="extra" title="附件" src="/frame"></iframe>
<p id="got">none</p>
<script>for (const id of ['video', 'cover']) document.getElementById(id).addEventListener('change', (e) => { document.getElementById('got').textContent = id + ':' + e.target.files[0].name; });</script>
</body></html>`;
  const FRAME = '<!doctype html><html><body><label>资料包 <input type="file" id="zip" accept=".zip"></label><p id="fgot">none</p><script>document.getElementById("zip").addEventListener("change", (e) => { document.getElementById("fgot").textContent = e.target.files[0].name; });</script></body></html>';
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url === '/frame' ? FRAME : PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g64up-'));
  fs.mkdirSync(path.join(ws, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'uploads', 'cover.jpg'), Buffer.from('ffd8ffe000104a464946', 'hex'));
  fs.writeFileSync(path.join(ws, 'uploads', 'pack.zip'), 'PK');
  const saved = { chrome: process.env.CHROME_PATH, headless: process.env.BROWSER_HEADLESS, priv: process.env.ALLOW_PRIVATE };
  process.env.BROWSER_HEADLESS = '1';
  process.env.ALLOW_PRIVATE = '1'; // the test page is on loopback
  delete process.env.CHROME_PATH;
  const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {} });
  const ctx = { workspaceDir: ws, bot: { id: 'g64upload' }, turnId: 'g64-upload' };
  const call = (name, args = {}) => registry.get(name).run(args, ctx);
  const got = async (expr) => (await browserMod.getBrowserManager('g64upload').evaluateRaw(expr)).value;
  try {
    const opened = await call('browser_open', { url: `http://127.0.0.1:${server.address().port}/` });
    await until(async () => (await got('document.getElementById("extra").contentDocument && document.getElementById("extra").contentDocument.getElementById("zip") ? 1 : 0')) === 1, 5000);
    const cover = await call('browser_upload', { paths: ['uploads/cover.jpg'] });
    const coverGot = await until(async () => ((await got('document.getElementById("got").textContent')) === 'cover:cover.jpg' ? 'cover:cover.jpg' : ''), 3000);
    check('G64-8c a cover picture with no index goes into the hidden image box inside the open dialog (not the video box before it), without a click - the result says which box',
      opened?.ok !== false && cover.ok === true && cover.box?.index === 1 && cover.box.hidden === true && cover.box.inDialog === true && coverGot === 'cover:cover.jpg',
      JSON.stringify({ cover, coverGot }));
    const wrong = await call('browser_upload', { paths: ['uploads/cover.jpg'], index: 0 });
    check('G64-8d the wrong box by number (the video box) changes nothing and lists every box - index, accept, hidden, in a dialog, the frame, nearby words',
      wrong.ok === false && wrong.error?.code === 'WRONG_FILE_BOX' && /#1 hidden in an open dialog accept="image\/png, image\/jpeg"/.test(wrong.error.message) && /#2 in frame 附件 accept="\.zip" near 「资料包」/.test(wrong.error.message)
      && /#0 accept="\.mp4,\.flv,\.mov" near 「上传视频」/.test(wrong.error.message) && Array.isArray(wrong.boxes) && wrong.boxes.length === 3,
      JSON.stringify(wrong.error || wrong));
    const pack = await call('browser_upload', { paths: ['uploads/pack.zip'] });
    const packGot = await until(async () => ((await got('document.getElementById("extra").contentDocument.getElementById("fgot").textContent')) === 'pack.zip' ? 'pack.zip' : ''), 3000);
    let outside = null;
    try { outside = await call('browser_upload', { paths: ['../outside.jpg'] }); } catch (err) { outside = { code: err.code }; }
    check('G64-8e a box inside a same-site frame is found too; files outside the workspace are still refused before anything reaches the page',
      pack.ok === true && pack.box?.frame === '附件' && packGot === 'pack.zip' && outside?.code === 'OUTSIDE_WORKSPACE', JSON.stringify({ pack, packGot, outside }));
  } finally {
    await call('browser_close').catch(() => {});
    server.close();
    for (const [k, v] of [['CHROME_PATH', saved.chrome], ['BROWSER_HEADLESS', saved.headless], ['ALLOW_PRIVATE', saved.priv]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
