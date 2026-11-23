// 1.5.65: what the 1.5.64 acceptance run with the user's content group found on 11-23 (on their cloud hub,
// driven from the PC in 全部机器). Five fixes:
//   G65-1 one bot never runs two working turns at once: a hand-off (also one from a group), a board task,
//         a routine, another machine's hand-off or a continuation waits for the turn at work; a question to
//         the human left open is seen, and nothing goes out before they answer; one post = one approval card;
//   G65-2 the coordinator stays visible: a hand-off puts a row on the group's 任务板 (one board, extended)
//         and the human gets one line saying who does what next and what they will be asked for;
//   G65-3 what the human tells a member in its own chat reaches the coordinator (the row, its next turn);
//   G65-4 a hand-off's sender in a remote bot's own chat shows by name and face, not as a raw id;
//   G65-5 the coordinator does not have members make deliverables nobody asked for.
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
// IDs used here start with g65 so they never clash with other scenarios.
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
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\r?\\n`).exec(src);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// A small real team: the runtime's own loop, a scripted model, the real tools
// ---------------------------------------------------------------------------
async function teamRig({ toolsMod, groupsMod, script, approve = () => 'approved' }) {
  const { AgentRuntime } = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g65-'));
  const bots = new Map([
    ['g65lead', { id: 'g65lead', name: '主理人', role: '协调', persona: 'WHO:lead', tools: ['fs_list', 'fs_read', 'bot_message'], skills: [], policy: {} }],
    ['g65pub', { id: 'g65pub', name: '发布', role: '发布', persona: 'WHO:pub', tools: ['fs_list', 'fs_write'], skills: [], policy: {} }],
    ['g65copy', { id: 'g65copy', name: '文案', role: '文案', persona: 'WHO:copy', tools: ['fs_list', 'fs_write'], skills: [], policy: {} }],
  ]);
  const group = { id: `g65g_${Math.random().toString(36).slice(2, 8)}`, name: 'g65 内容组', coordinatorId: 'g65lead', members: [...bots.values()].map(({ id, name, role, tools }) => ({ id, name, role, tools })) };
  const ev = [];
  const calls = [];
  const cards = [];
  const model = {
    provider: 'fake', model: 'fake',
    complete: async (messages, opts = {}) => {
      const sys = String(messages[0]?.content || '');
      const who = /WHO:(\w+)/.exec(sys)?.[1] || (/群「.*」的协调者/.test(sys) ? 'review' : /不能用任何工具/.test(sys) ? 'aside' : '?');
      const last = String(messages[messages.length - 1]?.content || '');
      const all = messages.map((m) => String(m.content || '')).join('\n');
      calls.push({ who, last, all, at: Date.now() });
      return script({ who, last, all, messages, opts, n: calls.filter((c) => c.who === who).length });
    },
  };
  const approvals = {
    cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [],
    request(req) {
      cards.push(req);
      const p = Promise.resolve({ decision: approve(req), approval: { id: `ap_${cards.length}` } });
      p.record = { id: `ap_${cards.length}` };
      return p;
    },
  };
  let rtRef = null;
  const rt = new AgentRuntime({
    config: { workspaceDir: ws, policy: {} }, registry: toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef }), model,
    bots: { getBot: async (id) => bots.get(id) || [...bots.values()].find((b) => b.name === id) || null, listBots: async () => [...bots.values()] },
    groups: groupsMod, memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
    approvals, bus: { emit: (e) => ev.push({ ...e, at: Date.now() }) },
  });
  rtRef = rt;
  rt.record = async () => {};
  rt.gatherMs = 0;
  rt.ackMs = 100;
  rt.taskDelayMs = 50;
  // The group this runtime knows (bot_message finds it as the coordinator's group).
  rt.groupForRun = async (id) => (id === group.id ? { group } : null);
  const listGroups = async () => [{ id: group.id, name: group.name, coordinatorId: group.coordinatorId, members: group.members.map((m) => m.id) }];
  rt.groups = { ...groupsMod, listGroups };
  const transcript = async () => groupsMod.readGroupMessages(group.id, { limit: 500 });
  const turns = (botId) => {
    const out = new Map();
    for (const e of ev) {
      if (e.botId !== botId || e.aside || !e.turnId) continue;
      if (e.type === 'turn.start') out.set(e.turnId, { turnId: e.turnId, source: e.source, start: e.at, end: null, text: e.text });
      if (e.type === 'turn.end' && out.has(e.turnId)) out.get(e.turnId).end = e.at;
    }
    return [...out.values()];
  };
  const done = () => fs.rmSync(ws, { recursive: true, force: true });
  return { rt, ev, calls, cards, group, ws, bots, transcript, turns, done };
}

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = `c_${Math.random().toString(36).slice(2, 8)}`) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });
const overlap = (a, b) => a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);

// ---------------------------------------------------------------------------
// G65-1: one working turn per bot; an open question is respected; one card per post
// ---------------------------------------------------------------------------
export async function oneTurnChecks({ check, toolsMod, groupsMod }) {
  const agent = await import('../src/agent.mjs');
  // The 11-23 run: 发布 publishes to 知乎 in its own chat (「我弄好了，继续」); 主理人, in the group, hands it a
  // second job 「先看视频号」. 发布's first turn ends asking the human which 视频标记 (tell_human).
  let handoffSaw = '';
  let pubDraftResult = null;
  const rig = await teamRig({
    toolsMod, groupsMod,
    script: async ({ who, last, all, n, messages }) => {
      if (who === 'lead') return /交接结果|reply/.test(last) || messages.some((m) => m.role === 'tool') ? say('发布那边在等你选视频标记。') : call('bot_message', { botId: '发布', text: '老板确认：先看视频号，再发知乎。每条点发布前先 post_draft 给老板看。' });
      if (who === 'pub' && /我弄好了，继续/.test(all) && !/先看视频号/.test(all)) {
        await sleep(80);
        const mine = messages.filter((m) => m.role === 'tool').length;
        if (mine < 4) return call('fs_write', { path: `g65/zhihu-${mine}.txt`, content: 'x' });
        if (mine === 4) return call('tell_human', { text: '知乎要选「添加视频标记」：含 AI 生成内容 / 含虚构演绎内容，你选哪个？' });
        return say('等你选视频标记。');
      }
      if (who === 'pub') {
        handoffSaw = all;
        const tried = messages.filter((m) => m.role === 'tool');
        if (!tried.length) return call('post_draft', { channel: '知乎', title: '第一次打开', body: '正文' });
        pubDraftResult = String(tried[tried.length - 1].content || '');
        return say('知乎这条在等老板选视频标记，他回了我就接着做。');
      }
      return say('好。');
    },
  });
  const chat = rig.rt.runTurn({ botId: 'g65pub', text: '我弄好了，继续', source: 'chat' });
  await until(() => rig.rt.workingTurn('g65pub'), 3000);
  const lead = rig.rt.runGroupMessage({ group: rig.group, text: '好的，就这样，就先发第一天的' });
  await until(() => rig.ev.some((e) => e.type === 'tool.progress' && /等发布忙完/.test(e.text || '')), 3000);
  // While the chat turn runs, the hand-off has not started: only one working turn of 发布 at any moment.
  const midway = [...rig.rt.active.values()].filter((i) => i.botId === 'g65pub' && i.working).length;
  await chat;
  await lead;
  await until(() => rig.turns('g65pub').every((t) => t.end), 5000);
  const ts = rig.turns('g65pub');
  const [first, second] = ts;
  check('G65-1a a hand-off from the group (主理人 → 发布, member role) while 发布 is publishing in its own chat does NOT start beside it: it waits (「等发布忙完手上的事…」) and starts after the first turn ends - never two working turns of one bot',
    midway === 1 && ts.length === 2 && first.source === 'chat' && second.source === 'bot' && !overlap(first, second) && second.start >= first.end,
    JSON.stringify({ midway, ts: ts.map((t) => ({ s: t.source, start: t.start - ts[0].start, end: t.end - ts[0].start })) }));
  check('G65-1b the hand-off turn is told a question to the human is still open (what it asked, not to decide it, not the step that waits on it) and that the human\'s own words win over a teammate\'s',
    /你上一件事停在等用户拍板/.test(handoffSaw) && /含 AI 生成内容/.test(handoffSaw) && /不要替他选/.test(handoffSaw) && handoffSaw.includes(agent.HUMAN_FIRST_NOTE),
    handoffSaw.slice(-400));
  check('G65-1c while that question is open, the hand-off turn shows nothing to go out: post_draft answers HUMAN_DECISION_PENDING and no card is raised',
    /HUMAN_DECISION_PENDING/.test(pubDraftResult || '') && rig.cards.length === 0, JSON.stringify({ pubDraftResult: String(pubDraftResult).slice(0, 160), cards: rig.cards.length }));
  // The human answers in 发布's chat: the question is closed, the next job may go out (after the post is shown).
  rig.rt.humanSpoke('g65pub');
  check('G65-1d once the human writes to the bot (its chat, Feishu, or the group) the open question is closed',
    rig.rt.pendingFor('g65pub') === null && agent.PENDING_HUMAN_MS === 24 * 3600 * 1000);
  rig.done();

  // Every way a turn starts for a bot already at work waits: a teammate's hand-off, one from a group, a board
  // task, a routine, another machine's hand-off, a continuation, a follow-up, a video report. The human's
  // words and the group's own talk (coordinator, @mentioned) do not wait.
  const ways = [
    { name: 'bot_message', o: { source: 'bot', fromBotId: 'g65lead', depth: 1 } },
    { name: 'bot_pass', o: { source: 'bot', fromBotId: 'g65lead', depth: 1, passHops: 1 } },
    { name: 'group member hand-off', o: { source: 'bot', fromBotId: 'g65lead', depth: 1, group: 'G', groupRole: 'member' } },
    { name: 'group board task', o: { source: 'group', group: 'G', groupRole: 'task', recordUser: false } },
    { name: 'routine', o: { source: 'routine' } },
    { name: 'another machine', o: { source: 'peer', depth: 1, fromBotId: '腾讯云的主理人' } },
    { name: 'continuation (150 steps)', o: { source: 'task', recordUser: false } },
    { name: 'follow-up', o: { source: 'followup' } },
    { name: 'video report', o: { source: 'media' } },
  ];
  const free = [
    { name: 'the human (chat)', o: { source: 'chat' } },
    { name: 'group coordinator', o: { source: 'group', group: 'G', groupRole: 'coordinator', recordUser: false } },
    { name: '@mentioned in the group', o: { source: 'group', group: 'G', groupRole: 'speaker', recordUser: false } },
  ];
  const rows = [];
  for (const way of [...ways, ...free]) {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    r.rt.active.set('turn_g65_busy', { controller: new AbortController(), botId: 'g65pub', task: '发知乎', startedAt: Date.now(), steps: 3, inbox: [], depth: 0, working: true });
    const o = { ...way.o, ...(way.o.group ? { group: r.group } : {}) };
    const run = r.rt.runTurn({ botId: 'g65pub', text: `g65 ${way.name}`, ...o });
    await sleep(150);
    const early = r.calls.length;
    r.rt.active.delete('turn_g65_busy');
    r.rt.wakeBot('g65pub');
    const res = await run;
    rows.push({ name: way.name, waited: early === 0, ran: r.calls.length > 0 && res.status === 'success' });
    r.done();
  }
  check('G65-1e every way a job reaches a bot at work waits until that turn ends, then runs: bot_message, bot_pass, a hand-off from the group, a board task, a routine, another machine, a continuation, a follow-up, a video report',
    rows.slice(0, ways.length).every((x) => x.waited && x.ran), JSON.stringify(rows.slice(0, ways.length)));
  check('G65-1f the human\'s own message and the group\'s talk (the coordinator, an @mentioned member) never wait behind it (the human\'s words go into the running turn, see G65-1h)',
    rows.slice(ways.length).every((x) => !x.waited && x.ran), JSON.stringify(rows.slice(ways.length)));

  // Waiting would deadlock, or the bot stays at work too long: the job does not start beside it; it says why.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    r.rt.active.set('turn_g65_busy', { controller: new AbortController(), botId: 'g65pub', task: '发知乎，选视频标记', startedAt: Date.now(), inbox: [], depth: 0, working: true });
    const off = r.rt.noteWaiting('g65pub', 'g65lead');
    const cyc = await r.rt.runTurn({ botId: 'g65pub', text: '再看看视频号', source: 'bot', fromBotId: 'g65lead', depth: 1 });
    off();
    r.rt.queueMs = 200;
    const slow = await r.rt.runTurn({ botId: 'g65pub', text: '定时检查', source: 'routine' });
    check('G65-1g a job that would deadlock (the bot at work waits on the sender) or that waited past its limit does not run beside the turn at work: status busy, the reason in words, the model never called',
      cyc.status === 'busy' && /在等你的结果/.test(cyc.summary) && slow.status === 'busy' && /一直在忙另一件事（发知乎，选视频标记…）/.test(slow.summary) && r.calls.length === 0,
      JSON.stringify({ cyc, slow, calls: r.calls.length }));
    r.done();
  }

  // The human writes to a bot whose work came from the group (a board task / a member hand-off): the words go
  // INTO that turn (an aside), not a second turn - before 1.5.65 group work did not count as busy.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    const t = { controller: new AbortController(), botId: 'g65pub', task: '（群的任务板）发知乎', startedAt: Date.now(), steps: 2, inbox: [], depth: 0, group: true, groupId: r.group.id, working: true };
    r.rt.active.set('turn_g65_task', t);
    const busy = r.rt.busyTurn('g65pub', { any: true });
    const coordTalk = { controller: new AbortController(), botId: 'g65lead', task: '群里说话', startedAt: Date.now(), inbox: [], depth: 0, group: true, groupId: r.group.id, working: false };
    r.rt.active.set('turn_g65_lead', coordTalk);
    await r.rt.aside({ botId: 'g65pub', text: '视频号先跳过', turnId: 'turn_g65_aside', busy, source: 'chat' });
    const leadBusy = r.rt.busyTurn('g65lead', { any: true });
    // An @mention in the group of a member at work: into its turn too.
    r.rt.active.delete('turn_g65_lead');
    await r.rt.runGroupMessage({ group: r.group, text: '@发布 封面换成第二张' });
    check('G65-1h the human\'s words to a member busy with group work go into that turn (no second turn), and so does an @mention of it in the group; a coordinator\'s group talk is not counted as busy work',
      busy?.turnId === 'turn_g65_task' && t.inbox.includes('视频号先跳过') && t.inbox.includes('@发布 封面换成第二张') && leadBusy === null
      && !r.ev.some((e) => e.type === 'turn.start' && !e.aside && e.botId === 'g65pub'),
      JSON.stringify({ inbox: t.inbox, started: r.ev.filter((e) => e.type === 'turn.start').map((e) => `${e.botId}:${e.aside ? 'aside' : 'turn'}`) }));
    r.rt.active.delete('turn_g65_task');
    r.done();
  }

  // A takeover left open: a routine for that bot hears of it; once the human writes, it does not.
  {
    const seen = [];
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, all, messages }) => {
        if (who !== 'pub') return say('好。');
        if (/发视频号/.test(last) && !messages.some((m) => m.role === 'tool')) return call('request_takeover', { reason: '在打开的视频号助手页面扫码登录' });
        if (/发视频号/.test(all)) return say('等你扫码。');
        seen.push(all);
        return say('检查完了。');
      },
    });
    const a = await r.rt.runTurn({ botId: 'g65pub', text: '发视频号', source: 'chat' });
    await r.rt.runTurn({ botId: 'g65pub', text: '每天检查一次后台', source: 'routine' });
    r.rt.humanSpoke('g65pub');
    await r.rt.runTurn({ botId: 'g65pub', text: '每天检查一次后台', source: 'routine' });
    check('G65-1i a turn that ended on the takeover card leaves a question open: the next job (a routine) is told 「等用户接管屏幕」 and to leave it to them; after the human writes, the next one is not',
      a.waitingFor === 'takeover' && /等用户接管屏幕（扫码或登录）/.test(seen[0] || '') && /扫码登录/.test(seen[0] || '') && seen.length === 2 && !/等用户接管屏幕/.test(seen[1] || ''),
      JSON.stringify({ a: a.waitingFor, seen: seen.map((s) => s.slice(-160)) }));
    r.done();
  }
}

export async function onePostChecks({ check, toolsMod, groupsMod }) {
  const agent = await import('../src/agent.mjs');
  const k = (c, t = '第一次打开', b = '正文') => agent.postKey('b', { channel: c, title: t, body: b });
  check('G65-1j one post, however its channel is written: 「知乎（视频）」 = 「知乎」 = 「知乎 」; another title, text or platform is another post',
    k('知乎（视频）') === k('知乎') && k('知乎 ') === k('知乎') && k('知乎(视频)') === k('知乎') && k('知乎', '第一次打开 ') === k('知乎')
    && k('视频号') !== k('知乎') && k('知乎', '另一个标题') !== k('知乎') && k('知乎', '第一次打开', '别的正文') !== k('知乎'));
  // 发布 shows 「知乎（视频）」, the human edits the body and presses 发送; later a hand-off turn shows the same post as
  // 「知乎」: no second card - it gets the human's version, told it was approved already.
  const results = [];
  const r = await teamRig({
    toolsMod, groupsMod,
    approve: () => 'approved',
    script: ({ who, last, messages }) => {
      if (who !== 'pub') return say('好。');
      const tool = messages.filter((m) => m.role === 'tool');
      if (!tool.length) {
        if (/第一轮/.test(last)) return call('post_draft', { channel: '知乎（视频）', title: '第一次打开', body: '正文' });
        if (/第二轮/.test(last)) return call('post_draft', { channel: '知乎', title: '第一次打开', body: '正文' });
        if (/第三轮/.test(last)) return call('post_draft', { channel: '知乎', title: '第一次打开', body: '换了一段正文' });
      }
      results.push(String(tool[tool.length - 1]?.content || ''));
      return say('好。');
    },
  });
  await r.rt.runTurn({ botId: 'g65pub', text: '第一轮：发知乎', source: 'chat' });
  await r.rt.runTurn({ botId: 'g65pub', text: '第二轮：主理人说发知乎', source: 'bot', fromBotId: 'g65lead', depth: 1 });
  const afterSame = r.cards.length;
  await r.rt.runTurn({ botId: 'g65pub', text: '第三轮：发知乎', source: 'chat' });
  check('G65-1k one post = one approval: the same post shown again by another turn (「知乎」 after 「知乎（视频）」) raises no second card and gets the first answer, said so (「已经给用户看过、用户点了发送…如果它已经发出去了，就不要再发一次」); a changed text is a new card',
    afterSame === 1 && r.cards.length === 2 && /samePost/.test(results[1] || '') && /如果它已经发出去了，就不要再发一次/.test(results[1] || '') && !/samePost/.test(results[0] || '') && !/samePost/.test(results[2] || ''),
    JSON.stringify({ afterSame, cards: r.cards.length, results: results.map((x) => x.slice(0, 120)) }));
  r.done();
  // Turned down once: shown again, it is turned down without a card.
  const r2 = await teamRig({
    toolsMod, groupsMod, approve: () => 'denied',
    script: ({ who, messages }) => {
      if (who !== 'pub') return say('好。');
      const tool = messages.filter((m) => m.role === 'tool');
      if (!tool.length) return call('post_draft', { channel: '知乎', title: '第一次打开', body: '正文' });
      results.push(String(tool[tool.length - 1]?.content || ''));
      return say('不发了。');
    },
  });
  results.length = 0;
  await r2.rt.runTurn({ botId: 'g65pub', text: '发知乎', source: 'chat' });
  await r2.rt.runTurn({ botId: 'g65pub', text: '再发一次知乎', source: 'routine' });
  check('G65-1l a post the human turned down, shown again, is turned down again without a second card',
    r2.cards.length === 1 && /APPROVAL_DENIED/.test(results[0] || '') && /already turned this same post down/.test(results[1] || ''),
    JSON.stringify({ cards: r2.cards.length, results: results.map((x) => x.slice(0, 100)) }));
  r2.done();
}

// ---------------------------------------------------------------------------
// G65-2: the coordinator stays visible - a board from its hand-offs, one line to the human
// ---------------------------------------------------------------------------
export async function boardChecks({ check, toolsMod, groupsMod }) {
  const agent = await import('../src/agent.mjs');
  const { loadPlan } = await import('../src/plans.mjs');
  let round = 0;
  const r = await teamRig({
    toolsMod, groupsMod,
    script: async ({ who, last, messages }) => {
      if (who === 'lead') {
        const tool = messages.filter((m) => m.role === 'tool').length;
        if (round === 1) {
          if (tool === 0) return call('bot_message', { botId: '发布', text: '今天只发第 1 条到知乎。发出去之前先 post_draft 给老板确认。' });
          if (tool === 1) return call('bot_pass', { botId: '文案', text: '把第 2 条的标题也对一遍' });
          return say('第 1 条在等知乎扫码，文案在对第 2 条标题。');
        }
        if (tool === 0) return call('bot_message', { botId: '发布', text: '老板扫好码了，接着发知乎第 1 条' });
        return say('知乎第 1 条发好了。');
      }
      if (who === 'pub') {
        if (/接着发知乎/.test(last)) return say('知乎第 1 条发好了：链接在 发布记录.md');
        return messages.some((m) => m.role === 'tool') ? say('等你扫码。') : call('request_takeover', { reason: '在打开的知乎页面扫码登录' });
      }
      if (who === 'copy') { await sleep(150); return say('第 2 条标题对好了。'); }
      return say('好。');
    },
  });
  round = 1;
  await r.rt.runGroupMessage({ group: r.group, text: '好的，就这样，就先发第一天的' });
  await until(() => r.rt.plans?.get(r.group.id)?.tasks?.every((t) => t.status !== 'doing' && t.status !== 'todo'), 5000);
  await sleep(50);
  const plan = r.rt.plans.get(r.group.id);
  const msgs = await r.transcript();
  const planMsgs = msgs.filter((m) => m.kind === 'plan');
  const replies = msgs.filter((m) => m.kind === 'assistant' && m.from === 'g65lead');
  const hand = replies.find((m) => /^好，交给/.test(m.text || ''));
  check('G65-2a the coordinator hands work out and the group gets ONE 任务板 built from its hand-offs: one row per member task (发布 等你回复 for its takeover, 文案 做完), no board per message',
    plan?.auto === true && planMsgs.length === 1 && planMsgs[0].planId === plan.id && plan.tasks.length === 2
    && plan.tasks[0].owner === 'g65pub' && plan.tasks[0].status === 'waiting_human' && /扫码登录/.test(plan.tasks[0].question || '')
    && plan.tasks[1].owner === 'g65copy' && plan.tasks[1].status === 'done' && plan.status === 'waiting',
    JSON.stringify({ status: plan?.status, tasks: plan?.tasks?.map((t) => `${t.title}:${t.owner}:${t.status}`), planMsgs: planMsgs.length }));
  check('G65-2b the human always gets one short line the moment work is given out - who does what next and their part (「发出去之前会先把草稿给你确认」) - once per coordinator turn, and its final answer still comes after',
    Boolean(hand) && hand.text.startsWith('好，交给「发布」今天只发第 1 条到知乎。进度在任务板上') && /发出去之前会先把草稿给你确认/.test(hand.text) && /任务板/.test(hand.text)
    && replies.filter((m) => /^好，交给/.test(m.text || '')).length === 1 && replies.some((m) => m.text === '第 1 条在等知乎扫码，文案在对第 2 条标题。')
    && msgs.indexOf(hand) < msgs.indexOf(replies.find((m) => m.text === '第 1 条在等知乎扫码，文案在对第 2 条标题。')),
    JSON.stringify(replies.map((m) => m.text)));
  // The human answers in the group: the coordinator (a new turn) hands 发布 the rest - the same row, the same board.
  round = 2;
  const took = await r.rt.answerBoard(r.group, '扫好了');
  await r.rt.runGroupMessage({ group: r.group, text: '扫好了' });
  await until(() => r.rt.plans.get(r.group.id)?.status === 'done', 5000);
  const after = r.rt.plans.get(r.group.id);
  const saved = await loadPlan(after.id);
  const msgs2 = await r.transcript();
  check('G65-2c the next hand-off to the same member extends the open board: its row goes 等你回复 → 做完, still one board, the board ends 已完成 (saved too)',
    took === false && after.id === plan.id && after.tasks.length === 2 && after.tasks[0].status === 'done' && /知乎第 1 条发好了/.test(after.tasks[0].result || '')
    && saved?.status === 'done' && msgs2.filter((m) => m.kind === 'plan').length === 1,
    JSON.stringify({ took, status: after.status, tasks: after.tasks.map((t) => `${t.owner}:${t.status}`) }));
  check('G65-2d the line names each member and what the human will be asked for, from the hand-off\'s own words (扫码 → 接管屏幕, 确认 → 草稿)',
    /要登录时会弹「接管屏幕」请你扫码/.test(agent.handoffReply([{ name: '发布', title: '发视频号', text: '没登录就弹接管让老板扫码' }]))
    && /中间要你定的事会在这里问你/.test(agent.handoffReply([{ name: '文案', title: '对标题', text: '对一遍标题' }]))
    && agent.handoffTitle('改一下今天的活，按新版来：\n1) 素材全部换新文件夹') === '改一下今天的活，按新版来');
  r.done();

  // A board the coordinator planned itself (group_plan) is not given extra rows by hand-offs.
  const plain = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
  plain.rt.plans = new Map([[plain.group.id, { id: 'plan_g65_x', groupId: plain.group.id, status: 'running', tasks: [{ id: 't1', owner: 'g65pub', status: 'doing', title: 'x' }] }]]);
  const none = await plain.rt.boardHandoff({ ctx: { bot: { id: 'g65lead', name: '主理人' }, group: { ...plain.group, role: 'coordinator' }, groupTurn: true, turnId: 'turn_g65_l' }, target: { id: 'g65copy', name: '文案' }, text: '对标题' });
  check('G65-2e a running board the coordinator planned (group_plan) already shows the work: hand-offs add no rows to it', none === null && plain.rt.plans.get(plain.group.id).tasks.length === 1);
  plain.done();
}

// ---------------------------------------------------------------------------
// G65-3: what the human tells a member directly reaches the coordinator
// ---------------------------------------------------------------------------
export async function directWordChecks({ check, toolsMod, groupsMod, readText }) {
  let leadSaw = '';
  let release = null;
  const r = await teamRig({
    toolsMod, groupsMod,
    script: async ({ who, last, all, messages }) => {
      if (who === 'lead') {
        const tool = messages.filter((m) => m.role === 'tool').length;
        if (/第二件/.test(all)) { leadSaw = all; return say('好，发布只发知乎。'); }
        return tool ? say('发布发完了。') : call('bot_message', { botId: '发布', text: '先发视频号，再发知乎' });
      }
      if (who === 'pub') {
        if (!messages.some((m) => m.role === 'tool')) return call('fs_write', { path: 'g65/pub.txt', content: 'x' });
        await new Promise((resolve) => { release = resolve; });
        return say('视频号跳过了，知乎发好了。');
      }
      return say('好。');
    },
  });
  const run = r.rt.runGroupMessage({ group: r.group, text: '开始发' });
  await until(() => release, 5000);
  // In 发布's own chat, the human: 「视频号先跳过」 (the page calls noteDirectWord, then the words go into the running turn).
  const noted = await r.rt.noteDirectWord('g65pub', '视频号先跳过');
  const busy = r.rt.busyTurn('g65pub', { any: true });
  await r.rt.aside({ botId: 'g65pub', text: '视频号先跳过', busy, source: 'chat' });
  const plan = r.rt.plans.get(r.group.id);
  const row = plan?.tasks?.[0];
  const leadLive = [...r.rt.active.values()].find((i) => i.botId === 'g65lead');
  const inLead = (leadLive?.inbox || []).some((x) => x?.kind === 'direct' && x.text === '视频号先跳过' && x.member === '发布');
  const inPub = (r.rt.active.get(busy?.turnId)?.inbox || []).includes('视频号先跳过') && busy?.from === 'g65lead';
  release();
  await run;
  check('G65-3a the human tells a member with work on the board something in its own chat: the row keeps it (「你在单聊里说」 on the board) and the coordinator\'s running turn hears it before its next step',
    noted === 1 && row?.said?.[0]?.text === '视频号先跳过' && inLead && inPub,
    JSON.stringify({ noted, said: row?.said, inLead, inPub }));
  const leadMsgs = r.calls.filter((c) => c.who === 'lead');
  check('G65-3b the coordinator\'s next model step reads it as the human\'s word that wins (「用户刚在「发布」的单聊里直接对它说：「视频号先跳过」…不要和这句话冲突」)',
    leadMsgs.some((c) => /用户刚在「发布」的单聊里直接对它说：「视频号先跳过」/.test(c.all) && /不要和这句话冲突/.test(c.all)), JSON.stringify(leadMsgs.map((c) => c.last.slice(0, 80))));
  // The board is still open (发布 waits for the human): a new message in the group - the coordinator sees the board with the human's words.
  const p = r.rt.plans.get(r.group.id);
  p.tasks[0].status = 'waiting_human';
  p.status = 'waiting';
  await r.rt.runGroupMessage({ group: r.group, text: '第二件：接着发' });
  check('G65-3c a later coordinator turn starts with the board in front of it, with what the human told the member directly and that it wins',
    /群里的任务板现在这样/.test(leadSaw) && /用户在单聊里直接对发布说：「视频号先跳过」/.test(leadSaw) && /不要再让成员做用户已经叫停或跳过的事/.test(leadSaw), leadSaw.slice(-300));
  const groupsSrc = await readText('../public/app/main/03-groups.js');
  const serverSrc = await readText('../src/server.mjs');
  const feishuSrc = await readText('../src/feishu.mjs');
  check('G65-3d the page shows it on the board row (「你在单聊里说：…」); the chat route and Feishu both note it before routing the message',
    groupsSrc.includes("for (const s of t.said || []) body.appendChild(el('div', 'plan-q plan-said', `你在单聊里说：${s.text}`));")
    && serverSrc.includes('state.runtime.noteDirectWord?.(bot.id, text, { turnId: busyNow ? null : turnId })') && feishuSrc.includes('o.runtime.noteDirectWord?.(id, full'));
  r.done();
}

// ---------------------------------------------------------------------------
// G65-4: two hubs - a hand-off's sender in a remote bot's own chat, by name and face
// ---------------------------------------------------------------------------
export async function remoteSenderChecks({ check, readText, api, rawFetch, startServerChild, stopProcess, seedHome }) {
  const farHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-g65far-'));
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
    const make = async (name, color) => {
      const made = (await bApi('/api/bots', { method: 'POST', body: { name, role: `${name}的活` } })).json;
      const id = made?.bot?.id || made?.id;
      await bApi(`/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: { avatar: { shape: 'hex', color } } });
      return id;
    };
    const lead = await make('主理人', '#0ea5e9');
    const pub = await make('发布', '#16a34a');
    // ops over there is 剪辑: a plain id that is also a bot here - the chat must never show this machine's ops for it.
    await bApi('/api/bots/ops', { method: 'PATCH', body: { name: '剪辑', avatar: { shape: 'hex', color: '#a16207' } } });
    await bApi('/api/groups', { method: 'POST', body: { name: 'g65 内容组', members: [lead, pub, 'ops'], coordinatorId: lead } });
    // Hand-offs in 发布's own chat there, as that machine's runtime writes them (plain ids).
    const sess = path.join(farHome, 'data', 'sessions', `${pub}.jsonl`);
    fs.mkdirSync(path.dirname(sess), { recursive: true });
    const now = new Date().toISOString();
    fs.appendFileSync(sess, [
      { ts: now, kind: 'user', text: '今天只发第 1 条', turnId: 'turn_g65_h1', source: 'bot', from: lead },
      { ts: now, kind: 'assistant', text: '好的', turnId: 'turn_g65_h1', final: true },
      { ts: now, kind: 'user', text: '片头剪好了', turnId: 'turn_g65_h2', source: 'bot', from: 'ops' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    await api('/api/peers', { method: 'PUT', body: { self: { name: '客厅电脑' }, peers: [{ name: M, url: B, token: bToken }] } });
    const roster = (await api('/api/peers/roster?fresh=1')).json;
    const got = (await api(`/api/peers/${enc}/bots/${encodeURIComponent(pub)}/messages?limit=50`)).json;
    const items = Array.isArray(got) ? got : got?.messages || [];
    const hereBots = (await api('/api/bots')).json;
    const list = Array.isArray(hereBots) ? hereBots : hereBots?.bots || [];

    const groupsSrc = await readText('../public/app/main/03-groups.js');
    const avatarsSrc = await readText('../public/app/main/02-avatars.js');
    const chatSrc = await readText('../public/app/main/05-chat.js');
    const names = ['botById', 'isRemoteId', 'remoteOf', 'remoteBotById', 'faceOf'];
    const body = [...names.map((n) => fnSource(groupsSrc, n)), fnSource(chatSrc, 'chatBotById'), fnSource(avatarsSrc, 'avatarOf')].join('\n');
    const state = { bots: list, groups: [], botId: `${pub}@${M}`, peerRoster: roster?.machines || [] };
    const page = new Function('state', 'selfMachineName', 'SHAPE_IDS', 'LEGACY_SHAPES', 'AVATAR_DEFAULT', `${body}\nreturn { chatBotById, avatarOf };`)(
      state, '客厅电脑', new Set(['circle', 'hex', 'blob', 'square']), {}, { shape: 'circle', color: '#7c6cf0' });
    const h1 = items.find((m) => m.turnId === 'turn_g65_h1' && m.role === 'user');
    const h2 = items.find((m) => m.turnId === 'turn_g65_h2' && m.role === 'user');
    const s1 = page.chatBotById(h1?.fromBot);
    const s2 = page.chatBotById(h2?.fromBot);
    const hereOps = list.find((b) => b.id === 'ops');
    check('G65-4a 全部机器, 发布\'s own chat on 腾讯云 opened from here: the hand-off line reads 「主理人 → 发布」 with 主理人\'s own colour, never 「bot-… → 发布」',
      h1?.fromBot === lead && s1?.name === '主理人' && s1.id === `${lead}@${M}` && page.avatarOf(s1).color === '#0ea5e9',
      JSON.stringify({ from: h1?.fromBot, s1 }));
    check('G65-4b a sender whose plain id is also a bot on this machine (ops) is the one over there (剪辑, its colour), not this machine\'s',
      h2?.fromBot === 'ops' && s2?.name === '剪辑' && page.avatarOf(s2).color === '#a16207' && (!hereOps || hereOps.name !== '剪辑'),
      JSON.stringify({ s2, here: hereOps?.name }));
    // Not in the roster's bot list but in one of that machine's groups: still its name, from the group's members.
    const st2 = { ...state, peerRoster: (roster?.machines || []).map((m) => (m.machine === M ? { ...m, bots: (m.bots || []).filter((b) => b.id !== lead), groups: [{ id: 'g', name: 'g', members: [{ id: lead, name: '主理人' }] }] } : m)) };
    const page2 = new Function('state', 'selfMachineName', 'SHAPE_IDS', 'LEGACY_SHAPES', 'AVATAR_DEFAULT', `${body}\nreturn { chatBotById };`)(state && st2, '客厅电脑', new Set(['circle']), {}, { shape: 'circle', color: '#7c6cf0' });
    const local = new Function('state', 'selfMachineName', 'SHAPE_IDS', 'LEGACY_SHAPES', 'AVATAR_DEFAULT', `${body}\nreturn { chatBotById };`)({ ...state, botId: 'ops' }, '客厅电脑', new Set(['circle']), {}, { shape: 'circle', color: '#7c6cf0' });
    check('G65-4c through that machine\'s group members when its roster does not list the bot; in a chat on this machine a plain id is this machine\'s bot as before',
      page2.chatBotById(lead)?.name === '主理人' && local.chatBotById('ops')?.id === 'ops' && local.chatBotById('ops')?.name === hereOps?.name,
      JSON.stringify({ viaGroup: page2.chatBotById(lead), local: local.chatBotById('ops')?.name }));
    check('G65-4d the hand-off row and a bot_message card in the chat both use it',
      chatSrc.includes('const sender = chatBotById(item.fromBot) || { id: item.fromBot, name: item.fromBot };') && chatSrc.includes('const target = chatBotById(args.botId);'));
  } finally {
    if (far) await stopProcess(far.child).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// G65-5: only what the human asked for
// ---------------------------------------------------------------------------
export async function scopeChecks({ check, readText }) {
  const src = await readText('../src/agent.mjs');
  check('G65-5 the coordinator\'s prompt: no extra deliverables nobody asked for (per-platform versions, rewrites, copies), the human\'s material used as given - word for word when they said so - and hand-offs go on the 任务板 by themselves',
    src.includes('Only what the human asked for: do not have members make extra deliverables (per-platform versions, rewrites, extra copies, summaries, reports) the human did not ask for.')
    && src.includes('the members use it as given - word for word when the human said so - and do not remake it')
    && src.includes('Work you hand a member with bot_message or bot_pass goes on the group\\\'s 任务板 by itself'));
}

// ---------------------------------------------------------------------------
// G65-6: the page shows the board and the line while the coordinator still works; the hold re-checks
// ---------------------------------------------------------------------------
export async function pageChecks({ check, readText }) {
  const live = await readText('../public/app/main/06-live.js');
  const groups = await readText('../public/app/main/03-groups.js');
  const server = await readText('../src/server.mjs');
  check('G65-6a a board, a hand-off line or the coordinator\'s line written into the open group while its turn still runs is drawn at once (the group is read again; the 「正在转交给同事…」 line stays) - not only when the turn ends, minutes later',
    live.includes("if (ev.type === 'group.message' && isGroupMode() && ev.groupId === state.groupId && ['plan', 'handoff', 'assistant'].includes(ev.message?.kind) && !state.liveTurn?.bubble) {")
    && live.includes("loadGroupMessages().then(() => { if (typing && !messagesEl.contains(typing)) { messagesEl.appendChild(typing); scrollToBottom(); } })"));
  check('G65-6b a board still open when last seen is asked again when drawn (another machine\'s board sends no events while its chat is not on screen); a finished one is drawn from what the browser has',
    groups.includes("if (url && (!known || known.status === 'running' || known.status === 'waiting')) {"));
  check('G65-6c messages held a moment (the burst hold) go into a turn that started meanwhile (a hand-off, a routine) instead of a second turn beside it',
    server.includes('const busyThen = !h && state.runtime.busyTurn?.(bot.id, { any: true });') && server.includes("return state.runtime.aside({ botId: bot.id, text: parts.length > 1 ? joinParts(parts) : parts[0]"));
}

// ---------------------------------------------------------------------------
// G65-7: every line in the chat list sits in the 760 px chat column, with its own indent
// ---------------------------------------------------------------------------
/** The CSS rules (selector, body) of a stylesheet, flattened out of @media blocks, in file order. */
function cssRules(css) {
  const out = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j += 1) { if (text[j] === '{') depth += 1; else if (text[j] === '}') depth -= 1; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) out.push({ selector: head, body, media });
      i = j;
    }
  };
  walk(src, '');
  return out;
}

export async function columnChecks({ check, readText, browserMod, toolsMod, skip }) {
  const css = await readText('../public/app/style.css');
  const rules = cssRules(css);
  const onList = rules.filter((r) => r.selector.split(',').some((s) => s.trim() === '.messages'));
  const padders = onList.filter((r) => /(^|;)\s*padding(-left|-right)?\s*:/.test(r.body));
  const last = padders[padders.length - 1];
  check('G65-7a the chat column is the list\'s own side padding - max(the layout\'s padding, half of what is left beside 760 px) - in the last rule that sets the list\'s padding, so it wins at every width',
    Boolean(last) && !last.media && /--chat-col:\s*760px/.test(last.body)
    && last.body.includes('padding-left: max(var(--msg-pad, 24px), calc((100% - var(--chat-col)) / 2))')
    && last.body.includes('padding-right: max(var(--msg-pad, 24px), calc((100% - var(--chat-col)) / 2))'), last?.body);
  const missing = padders.slice(0, -1).filter((r) => !/--msg-pad\s*:/.test(r.body));
  check('G65-7b every layout that sets the list\'s side padding (wide, ≤1100, phone ≤860, ≤420) gives it as --msg-pad too, so the narrow paddings still hold',
    padders.length >= 8 && missing.length === 0, JSON.stringify(missing.map((r) => `${r.media} ${r.body.trim().slice(0, 60)}`)));
  // A line of the list must never be pulled back out to the edge (a negative side margin, or absolute placing).
  const children = rules.filter((r) => /\.messages\s*>/.test(r.selector));
  const outward = children.filter((r) => /margin(-left|-right)?\s*:[^;]*-\d/.test(r.body) || /position\s*:\s*(absolute|fixed)/.test(r.body));
  check('G65-7c no rule for the list\'s lines pulls one out of the column (negative side margin, absolute or fixed): nothing in the chat is meant to span the full width',
    outward.length === 0, JSON.stringify(outward.map((r) => r.selector)));

  // Rendered: the real stylesheet, a chat list with every kind of line the page puts there - and one it does not know.
  const savedChrome = process.env.CHROME_PATH;
  delete process.env.CHROME_PATH;
  const found = browserMod.detectBrowserExecutable().path;
  if (savedChrome !== undefined) process.env.CHROME_PATH = savedChrome;
  if (!found) { skip('G65-7d..e (a real browser)', 'no Chromium-based browser on this machine'); return; }
  const LINES = [
    ['row', '<div class="bubble">一条回复</div>'],
    ['row user', '<div class="bubble">你说的话</div>'],
    ['next-steps', '<button class="next-step first">好</button><button class="next-step">先不用</button>'],
    ['changes-line', '<span>改了 2 个文件</span>'],
    ['video-jobs', '<div class="video-job">视频生成中</div>'],
    ['status-line queued-line', '<span>等那台机器开机</span>'],
    ['status-line link-down-line', '<span>连不上</span>'],
    ['status-line pair-needed-line', '<span>还没配对</span>'],
    ['status-line upload-progress', '正在传 0/3…'],
    ['onboard', '<h2>先接一个模型</h2>'],
    ['starter-row', '<button class="btn">试试这些</button>'],
    ['starter-tip', '找不到合适的就问助理'],
    ['day-sep', '11月23日周一 18:30'],
    ['routine-run', '<div class="routine-run-line">定时任务</div>'],
    ['isolation-ask', '<b>给机器人一个单独的账户？</b>'],
    ['typing-row', '<span class="typing-label">正在处理…</span>'],
    ['g65-a-new-kind-of-line', '以后新加的一种行'],
  ];
  const list = LINES.map(([cls, html]) => `<div class="${cls}" data-k="${cls}">${html}</div>`).join('')
    + '<details class="chip" data-k="chip"><summary>工具</summary></details><details class="handoff-line" data-k="handoff-line"><summary>主理人 → 发布</summary></details>';
  const pane = (w) => `<div class="pane" style="width:${w}px;height:1600px;display:flex;flex-direction:column"><div class="messages" style="overflow:visible">${list}</div></div>`;
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body style="margin:0">${pane(1400)}${pane(800)}${pane(560)}</body></html>`;
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); res.end(css); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g65col-'));
  const saved = { chrome: process.env.CHROME_PATH, headless: process.env.BROWSER_HEADLESS, priv: process.env.ALLOW_PRIVATE };
  process.env.BROWSER_HEADLESS = '1';
  process.env.ALLOW_PRIVATE = '1'; // the test page is on loopback
  delete process.env.CHROME_PATH;
  const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {} });
  const ctx = { workspaceDir: ws, bot: { id: 'g65column' }, turnId: 'g65-column' };
  const run = (name, args = {}) => registry.get(name).run(args, ctx);
  try {
    await run('browser_open', { url: `http://127.0.0.1:${server.address().port}/` });
    const measure = `(() => ({ phone: matchMedia('(max-width: 860px)').matches, vw: innerWidth, panes: [...document.querySelectorAll('.messages')].map((m) => {
      const r = m.getBoundingClientRect(); const s = getComputedStyle(m);
      const left = r.left + parseFloat(s.paddingLeft); const right = r.right - parseFloat(s.paddingRight);
      return { width: Math.round(r.width), col: Math.round(right - left), lines: [...m.children].map((c) => { const b = c.getBoundingClientRect(); return { k: c.dataset.k, l: Math.round(b.left - left), r: Math.round(right - b.right), w: Math.round(b.width) }; }) };
    }) }))()`;
    let got = null;
    await until(async () => { got = (await browserMod.getBrowserManager('g65column').evaluateRaw(measure)).value; return got?.panes?.length === 3 && got.panes[0].col > 0; }, 8000);
    const [wide, mid, narrow] = got?.panes || [];
    // The avatar indent of 「好」「先不用」: 46 px, none in the phone layout (≤860 px, its own rule) - whichever this browser window is.
    const indent = got?.phone ? 0 : 46;
    const out = (p) => (p?.lines || []).filter((x) => x.l < -1 || x.r < -1);
    const at = (p, k) => p?.lines?.find((x) => x.k === k);
    check('G65-7d rendered with the real stylesheet in a wide window (1400 px): the column is 760 px in the middle, and every line - replies, 「好」「先不用」, 「改了 N 个文件」, video jobs, waiting / link-down / pair / upload lines, the first-run card, 「试试这些」 and its tip, day markers, a scheduled run, the account card, the typing line, a tool chip, a hand-off line, and a kind of line the page does not have yet - starts and ends inside it',
      wide?.col >= 750 && wide.col <= 760 && out(wide).length === 0 && at(wide, 'g65-a-new-kind-of-line')?.l === 0 && at(wide, 'next-steps')?.l === indent && at(wide, 'changes-line')?.l === 44 && at(wide, 'row')?.w === wide.col,
      JSON.stringify({ vw: got?.vw, phone: got?.phone, col: wide?.col, out: out(wide), next: at(wide, 'next-steps'), unknown: at(wide, 'g65-a-new-kind-of-line') }));
    check('G65-7e in a narrower window (800 / 560 px) the column is the list minus its own padding, every line still inside it, and 「好」「先不用」 keep their 46 px avatar indent inside it (the phone layout, ≤860 px, drops it by its own rule)',
      mid?.col > 700 && mid.col <= 760 && out(mid).length === 0 && narrow?.col < 560 && out(narrow).length === 0 && at(mid, 'next-steps')?.l === indent && at(narrow, 'next-steps')?.l === indent
      && /@media \(max-width: 860px\) \{ \.next-steps \{ margin-left: 0; \}/.test(css),
      JSON.stringify({ vw: got?.vw, phone: got?.phone, mid: { col: mid?.col, out: out(mid) }, narrow: { col: narrow?.col, out: out(narrow) } }));
  } finally {
    await run('browser_close').catch(() => {});
    server.close();
    for (const [k, v] of [['CHROME_PATH', saved.chrome], ['BROWSER_HEADLESS', saved.headless], ['ALLOW_PRIVATE', saved.priv]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// G65-8: every way the human answers closes the open question - once
// (the collaboration eval: after 「扫好了」 in the group every post_draft of 发布 was refused)
// ---------------------------------------------------------------------------
export async function answerChecks({ check, toolsMod, groupsMod, readText }) {
  /** Counts the times the open question was really closed (true), not just looked at. */
  const spy = (rt) => {
    const closed = [];
    const spoke = rt.humanSpoke.bind(rt);
    rt.humanSpoke = (id) => { const r = spoke(id); if (r) closed.push(id); return r; };
    return closed;
  };
  const ask = (rt, botId = 'g65pub', turnId = 'turn_g65_q') => {
    rt.pendingHuman = rt.pendingHuman || new Map();
    rt.pendingHuman.set(botId, { kind: 'takeover', text: '需要你接管屏幕：在打开的知乎页面扫码登录', turnId, at: Date.now() });
  };

  // 1. In the member's own chat (the page, the phone's page): a new turn, or into the turn at work. 「我弄好了，继续」 is that message.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    const closed = spy(r.rt);
    ask(r.rt);
    await r.rt.runTurn({ botId: 'g65pub', text: '我弄好了，继续', source: 'chat' });
    const viaTurn = r.rt.pendingFor('g65pub') === null && closed.length === 1;
    ask(r.rt);
    const busy = { controller: new AbortController(), botId: 'g65pub', task: '发知乎', startedAt: Date.now(), inbox: [], depth: 1, working: true };
    r.rt.active.set('turn_g65_work', busy);
    await r.rt.aside({ botId: 'g65pub', text: '扫好了', busy, source: 'chat' });
    r.rt.active.delete('turn_g65_work');
    const viaAside = r.rt.pendingFor('g65pub') === null && closed.length === 2;
    const chat = await readText('../public/app/main/05-chat.js');
    const settings = await readText('../public/app/main/08-settings.js');
    check('G65-8a in the member\'s own chat - a new turn, or a word into the turn at work - the open question closes, once each; the takeover card\'s 「我弄好了，继续」 (in the chat and in the full-window view) is that same message',
      viaTurn && viaAside && /input\.value = '我弄好了，继续';\s*await send\(\);/.test(chat) && /input\.value = '我弄好了，继续';\s*await send\(\);/.test(settings),
      JSON.stringify({ viaTurn, viaAside, closed }));
    r.done();
  }

  // 2. On a card: a scheduled run stopped on an approval card; the human answers that card (page, phone, Feishu, another machine).
  {
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, messages }) => (who === 'pub' && !messages.some((m) => m.role === 'tool') ? call('post_draft', { channel: '知乎', title: '第一次打开', body: '正文' }) : say('停在确认卡上了。')),
    });
    r.rt.approvals.request = (req) => { r.cards.push(req); const p = Promise.resolve({ decision: 'needs_approval', approval: { id: 'ap_g65_card' } }); p.record = { id: 'ap_g65_card' }; return p; };
    const res = await r.rt.runTurn({ botId: 'g65pub', text: '定时发知乎', source: 'routine', unattended: true });
    const opened = r.rt.pendingFor('g65pub');
    const other = r.rt.humanAnswered('g65pub', { turnId: 'turn_g65_someother' });
    const first = r.rt.humanAnswered('g65pub', { turnId: res.turnId });
    const again = r.rt.humanAnswered('g65pub', { turnId: res.turnId });
    const server = await readText('../src/server.mjs');
    check('G65-8b a scheduled run stopped on its card leaves the question open (确认「…」); answering THAT card closes it, exactly once - another card of the bot does not; the page / phone / another machine\'s route and Feishu\'s both do it',
      res.status === 'needs_approval' && opened?.kind === 'approval' && opened.turnId === res.turnId && other === false && first === true && again === false
      && server.includes('state.runtime.humanAnswered?.(record.botId, { turnId: record.turnId });') && /runtime\.humanAnswered\?\.\(record\.botId, \{ turnId: record\.turnId \}\);\s*bus\.emit\(\{ type: 'approval\.decided'/.test(server),
      JSON.stringify({ status: res.status, opened, other, first, again }));
    r.done();
  }

  // 3. In the group, the eval's case: a board task raises the takeover; 「扫好了」 in the group; the member goes on and its post is shown.
  {
    let drafted = '';
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, all, messages }) => {
        if (who === 'lead' && /任务板做完了/.test(last)) return say('发好了。');
        // The later word in the group (8d) is only answered - no new board that would ask the human again.
        if (who === 'lead' && /视频号也可以发了/.test(last)) return say('好，记下了。');
        if (who === 'lead') return call('group_plan', { tasks: [{ title: '在知乎发第 1 条', owner: '发布', brief: '登录后发' }] });
        if (who === 'pub' && /用户的回答：扫好了/.test(all)) {
          const tool = messages.filter((m) => m.role === 'tool');
          if (!tool.length) return call('post_draft', { channel: '知乎', title: '第一次打开', body: '正文' });
          drafted = String(tool[tool.length - 1].content || '');
          return say('知乎第 1 条发出去了。');
        }
        if (who === 'pub') return messages.some((m) => m.role === 'tool') ? say('等你扫码。') : call('request_takeover', { reason: '在打开的知乎页面扫码登录' });
        return say('好。');
      },
    });
    const closed = spy(r.rt);
    await r.rt.routeGroupMessage({ group: r.group, text: '先发第一条', turnId: 'turn_g65_board', fromHuman: true });
    const plan = await until(() => { const p = r.rt.plans?.get(r.group.id); return p?.status === 'waiting' ? p : null; }, 5000);
    const before = r.rt.pendingFor('g65pub');
    const took = await r.rt.answerBoard(r.group, '扫好了');
    await until(() => r.rt.plans.get(r.group.id)?.status === 'done', 5000);
    check('G65-8c in the group (the eval\'s case): a board task stops on the takeover, the human says 「扫好了」 in the group - that closes the question, once; the member goes back to it and its post_draft is shown on a card (not HUMAN_DECISION_PENDING) and the board ends done',
      Boolean(plan) && before?.kind === 'takeover' && took === true && closed.filter((id) => id === 'g65pub').length === 1 && r.cards.length === 1
      && /"approved":true/.test(drafted) && !/HUMAN_DECISION_PENDING/.test(drafted) && r.rt.plans.get(r.group.id)?.status === 'done',
      JSON.stringify({ before: before?.kind, took, closed, cards: r.cards.length, drafted: drafted.slice(0, 120), status: r.rt.plans.get(r.group.id)?.status }));
    // Not on a board: any word of the human in the group closes its members' questions - once, also when it is held a moment.
    ask(r.rt);
    closed.length = 0;
    r.rt.gatherMs = 150;
    await r.rt.routeGroupMessage({ group: r.group, text: '视频号也可以发了', turnId: 'turn_g65_g2', fromHuman: true });
    await until(() => r.ev.some((e) => e.type === 'turn.end' && e.turnId === 'turn_g65_g2'), 4000);
    check('G65-8d a word in the group off the board closes its members\' questions once - not again when the message comes back after the short hold',
      r.rt.pendingFor('g65pub') === null && closed.filter((id) => id === 'g65pub').length === 1, JSON.stringify(closed));
    r.done();
  }

  // 4. From the phone: its app uses the page's routes (1-3 above); Feishu is its own way in.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    const closed = spy(r.rt);
    ask(r.rt);
    await r.rt.runTurn({ botId: 'g65pub', text: '扫好了', source: 'feishu' });
    const viaTurn = r.rt.pendingFor('g65pub') === null && closed.length === 1;
    ask(r.rt);
    const busy = { controller: new AbortController(), botId: 'g65pub', task: '发知乎', startedAt: Date.now(), inbox: [], depth: 1, working: true };
    r.rt.active.set('turn_g65_work', busy);
    await r.rt.aside({ botId: 'g65pub', text: '扫好了', busy, source: 'feishu' });
    r.rt.active.delete('turn_g65_work');
    check('G65-8e from the phone in Feishu - a new turn or a word into the turn at work - the question closes, once each (the phone app itself uses the same routes as the page)',
      viaTurn && r.rt.pendingFor('g65pub') === null && closed.length === 2, JSON.stringify(closed));
    r.done();
  }

  // 5. Through another machine: the group lives here, the member there. The answer goes along with its task.
  {
    const sent = [];
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last }) => (who === 'lead' && /任务板做完了/.test(last) ? say('发好了。') : say('好。')),
    });
    const far = { id: 'g65far', name: '远端发布', role: '发布', remote: { machine: '腾讯云', botId: 'bot-far' } };
    const group = { ...r.group, members: [...r.group.members, far] };
    let n = 0;
    r.rt.getPeers = () => ({
      find: () => ({ name: '腾讯云' }),
      json: async (_peer, method, p, opts = {}) => {
        if (method === 'POST') { sent.push(opts.body); n += 1; return { turnId: `turn_far_${n}` }; }
        return [{ turnId: `turn_far_${n}`, role: 'assistant', text: '知乎第 1 条发出去了。' }, { turnId: `turn_far_${n}`, role: 'status', status: 'success' }];
      },
    });
    const plan = { id: `plan_g65_far_${Date.now()}`, groupId: group.id, request: '发知乎', coordinatorId: 'g65lead', status: 'waiting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tasks: [{ id: 't1', title: '在知乎发第 1 条', owner: 'g65far', brief: '', deliverable: '', needs: [], status: 'waiting_human', question: '需要你接管屏幕：扫码登录', answer: '', result: '' }] };
    await r.rt.boardChanged(plan);
    const took = await r.rt.answerBoard(group, '扫好了');
    await until(() => r.rt.plans.get(group.id)?.status === 'done', 9000);
    const server = await readText('../src/server.mjs');
    check('G65-8f a member on another machine: 「扫好了」 in the group goes to that machine with the task, marked as the human\'s answer (handoff.answered), once - and that machine\'s route closes the question when it sees it',
      took === true && sent.length === 1 && sent[0]?.handoff?.answered === true && /用户的回答：扫好了/.test(sent[0]?.text || '') && r.rt.plans.get(group.id)?.status === 'done'
      && server.includes('if (h?.answered === true) state.runtime.humanSpoke?.(bot.id);'),
      JSON.stringify({ took, sent: sent.map((b) => ({ answered: b?.handoff?.answered, text: String(b?.text || '').slice(0, 60) })), status: r.rt.plans.get(group.id)?.status }));
    r.done();
  }
}

// ---------------------------------------------------------------------------
// G65-9: 「这一轮都允许」, sends approved by destination, and stopping after two failed sends
// (11-23 20:13-20:15: 发布 tried seven file hosts, a card each - 「这些东西我审批一次就好了，为什么一直让我审批」)
// ---------------------------------------------------------------------------
/** A team whose 发布 can run commands (stubbed: nothing really runs or goes out); `answer(req)` is the human. */
async function chainRig({ toolsMod, groupsMod, script, answer = () => ({ decision: 'approved' }), shellOut = () => ({ ok: true, exitCode: 0, stdout: 'https://tmpfiles.org/dl/1/a.png' }) }) {
  const r = await teamRig({ toolsMod, groupsMod, script });
  for (const id of ['g65pub', 'g65copy']) r.bots.get(id).tools = [...r.bots.get(id).tools, 'shell'];
  const ran = [];
  r.rt.registry.get('shell').run = async (args) => { ran.push(String(args.command)); return shellOut(String(args.command), ran.length); };
  r.rt.approvals.request = (req) => {
    r.cards.push(req);
    const a = answer(req) || { decision: 'approved' };
    const p = Promise.resolve({ decision: a.decision, approval: { id: `ap_${r.cards.length}`, ...(a.chain && req.chainScope ? { chainAllowed: true } : {}) } });
    p.record = { id: `ap_${r.cards.length}` };
    return p;
  };
  return { ...r, ran };
}
const steps = (list) => ({ who, messages }) => {
  if (who !== 'pub' && who !== 'copy') return say('好。');
  const i = messages.filter((m) => m.role === 'tool').length;
  return i < list.length ? call(list[i][0], list[i][1]) : say('做完了。');
};

export async function chainChecks({ check, toolsMod, groupsMod, readText }) {
  const agent = await import('../src/agent.mjs');
  const { sendDestination } = await import('../src/drafts.mjs');
  const { ApprovalQueue } = await import('../src/approvals.mjs');

  // a. The same kind of step, for the rest of the turn chain - not another bot, not a later turn.
  {
    let continued = false;
    const r = await chainRig({
      toolsMod, groupsMod,
      answer: (req) => ({ decision: 'approved', chain: req.args?.command === 'mkdir a' }),
      script: ({ who, messages, all }) => {
        if (who === 'copy') return steps([['shell', { command: 'mkdir z' }]])({ who, messages });
        if (who !== 'pub') return say('好。');
        const i = messages.filter((m) => m.role === 'tool').length;
        if (/第 1 次自动接着做/.test(all)) { continued = true; return i === 0 ? call('shell', { command: 'mkdir c' }) : say('三个目录都建好了。'); }
        if (/再建一个/.test(all)) return i === 0 ? call('shell', { command: 'mkdir d' }) : say('好了。');
        // The first turn: two of the same kind, then busy work up to the step limit (80) - it goes on by itself.
        if (i === 0) return call('shell', { command: 'mkdir a' });
        if (i === 1) return call('shell', { command: 'mkdir b' });
        return call('fs_list', { path: `x${i}` });
      },
    });
    const first = await r.rt.runTurn({ botId: 'g65pub', text: '建三个目录', source: 'chat' });
    await until(() => continued && r.ev.some((e) => e.type === 'turn.end' && e.botId === 'g65pub' && e.source === 'task'), 8000);
    const inFirst = r.cards.map((c) => c.args?.command);
    const offered = r.cards[0]?.chainScope;
    await r.rt.runTurn({ botId: 'g65copy', text: '建目录', source: 'chat' });
    const otherBot = r.cards.length;
    await r.rt.runTurn({ botId: 'g65pub', text: '再建一个', source: 'chat' });
    const later = r.cards.length;
    check('G65-9a 「这一轮都允许」 on a command card covers the same kind of step (same program, same risk) for the rest of the turn chain - also the turn that goes on by itself after the step limit - and nothing else: another bot asks, a later turn asks, and the chain\'s answer is gone when it ends',
      first.status === 'max_steps' && continued && inFirst.length === 1 && inFirst[0] === 'mkdir a' && r.ran.includes('mkdir b') && r.ran.includes('mkdir c')
      && offered?.keys?.length === 1 && /mkdir/.test(offered.label + offered.keys[0]) && otherBot === 2 && r.cards[1]?.args?.command === 'mkdir z' && later === 3 && r.cards[2]?.args?.command === 'mkdir d'
      && ![...(r.rt.chainGrants?.keys() || [])].includes(first.chainId),
      JSON.stringify({ status: first.status, continued, cards: r.cards.map((c) => c.args?.command), ran: r.ran, offered }));
    r.done();
  }

  // b. A send: what leaves and where, in words; the answer covers that host; a new host asks again.
  {
    const up = (host, files = ['图01.png', '图02.png']) => ({ command: `cd xhs && ${files.map((f) => `curl -s -m 60 -F "file=@${f}" https://${host}/api/v1/upload`).join('; ')}` });
    const r = await chainRig({
      toolsMod, groupsMod,
      answer: (req) => ({ decision: 'approved', chain: /tmpfiles/.test(req.args?.command || '') }),
      script: steps([['shell', up('tmpfiles.org')], ['shell', up('tmpfiles.org', ['图03.png'])], ['shell', up('catbox.moe')], ['shell', { command: 'for u in "https://envs.sh" "https://x0.at"; do curl -s -F "file=@a.png" "$u"; done' }]]),
    });
    await r.rt.runTurn({ botId: 'g65pub', text: '把九张图传上去', source: 'chat' });
    const [c1, c2, c3] = r.cards;
    check('G65-9b a send\'s card says what leaves and where (「要把这 2 张图传到 tmpfiles.org，谁有链接都能看」) and offers 「这一轮都允许」 for that host; after it, more to tmpfiles.org goes unasked, catbox.moe asks again, and a loop whose address is a variable asks with no offer',
      r.cards.length === 3 && c1.send?.text === '要把这 2 张图传到 tmpfiles.org，谁有链接都能看' && c1.chainScope?.keys?.[0] === 'send:tmpfiles.org' && /往 tmpfiles\.org 发东西/.test(c1.chainScope.label)
      && r.ran.length === 4 && /catbox\.moe/.test(c2.args?.command) && c2.chainScope?.keys?.[0] === 'send:catbox.moe' && /\$u/.test(c3.args?.command) && !c3.chainScope && !c3.send,
      JSON.stringify({ cards: r.cards.map((c) => ({ cmd: String(c.args?.command).slice(0, 50), send: c.send?.text, scope: c.chainScope?.keys })), ran: r.ran.length }));
    check('G65-9c what a send is read as: files and pictures counted, a public file host said so, data to an API said plainly; a proxy, hidden options, a mixed mail/socket line or a variable address is not read (it keeps asking every time)',
      sendDestination('shell', up('catbox.moe', ['a.zip'])).text === '要把这 1 个文件传到 catbox.moe，谁有链接都能看'
      && sendDestination('http_fetch', { url: 'https://hooks.example.com/x', method: 'POST' }).text === '要把一段数据发到 hooks.example.com，发过去以后就在那边了'
      && sendDestination('shell', { command: 'curl -x http://p:1 -F f=@a https://tmpfiles.org/' }) === null
      && sendDestination('shell', { command: 'curl -K cfg https://tmpfiles.org/' }) === null
      && sendDestination('shell', { command: 'curl -d a=1 https://tmpfiles.org/ ; nc evil.example 80' }) === null
      && sendDestination('shell', { command: 'curl -s https://tmpfiles.org/' }) === null);
    r.done();
  }

  // c. Never where a card asks every time for another reason; a post's channel is its destination.
  {
    const r = await chainRig({
      toolsMod, groupsMod,
      answer: (req) => ({ decision: 'approved', chain: req.toolName === 'post_draft' }),
      script: steps([['shell', { command: 'adb shell input tap 10 10' }], ['post_draft', { channel: '知乎（视频）', title: '第一次打开', body: '正文' }], ['post_draft', { channel: '知乎', title: '第二篇', body: '另一段正文' }], ['post_draft', { channel: '视频号', title: '第一次打开', body: '正文' }]]),
    });
    await r.rt.runTurn({ botId: 'g65pub', text: '发吧', source: 'chat' });
    const [adb, post1, post3] = r.cards;
    check('G65-9d not offered where a card asks every time for another reason (here adb; the danger list, secrets, the human\'s rules, a connected app, the read guard and 谨慎 are the same rule in code); for post_draft the destination is the channel: 「知乎（视频）」 covers another 知乎 post in the turn, 视频号 asks again',
      r.cards.length === 3 && adb.toolName === 'shell' && !adb.chainScope && post1.chainScope?.keys?.[0] === 'post:知乎' && /发到「知乎（视频）」/.test(post1.chainScope.label)
      && post3.args?.channel === '视频号',
      JSON.stringify(r.cards.map((c) => ({ tool: c.toolName, scope: c.chainScope?.keys, ch: c.args?.channel }))));
    r.done();
  }

  // d. The answer itself: only on a card that offered it, with a yes; kept in the record and the audit.
  {
    const audits = [];
    const q = new ApprovalQueue({ onAudit: (rec) => audits.push(rec), timeoutMs: 60000, persist: false });
    const a = q.request({ turnId: 't1', botId: 'b', toolName: 'shell', args: { command: 'mkdir a' }, risk: 'MEDIUM', reason: 'x', chainScope: { keys: ['shell:mkdir|MEDIUM'], label: '用 mkdir 运行命令' } });
    const b = q.request({ turnId: 't1', botId: 'b', toolName: 'shell', args: { command: 'rm -rf x' }, risk: 'HIGH', reason: 'x' });
    const c = q.request({ turnId: 't1', botId: 'b', toolName: 'shell', args: { command: 'mkdir b' }, risk: 'MEDIUM', reason: 'x', chainScope: { keys: ['shell:mkdir|MEDIUM'], label: 'm' } });
    q.decide(a.record.id, 'approve', '', 'human', { chain: true });
    q.decide(b.record.id, 'approve', '', 'human', { chain: true });
    q.decide(c.record.id, 'deny', '', 'human', { chain: true });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    const agentSrc = await readText('../src/agent.mjs');
    check('G65-9e 「这一轮都允许」 counts only on a card that offered it and only with a yes; the record and the audit keep it, and each step it lets run later is audited as tool.chain_allowed',
      ra.approval?.chainAllowed === true && !rb.approval?.chainAllowed && !rc.approval?.chainAllowed && rb.decision === 'approved'
      && audits.some((x) => x.kind === 'approval.resolved' && x.chainAllowed === true && x.id === a.record.id)
      && agentSrc.includes("await audit({ kind: 'tool.chain_allowed', botId: bot.id, turnId, chainId: ctx.chainId, tool: name, keys: chainOffer.keys, label: chainOffer.label });"),
      JSON.stringify({ a: ra.approval?.chainAllowed, b: rb.approval?.chainAllowed, c: rc.approval?.chainAllowed }));
  }

  // e. Two failed sends in a turn: the second result says to stop and ask the human.
  {
    const outs = ['uploads disabled because of spam', '<html><body><h1>502 Bad Gateway</h1>', '--catbox--\n\n--oshi--\n'];
    let saw = [];
    const r = await chainRig({
      toolsMod, groupsMod, answer: () => ({ decision: 'approved' }),
      shellOut: (cmd, n) => ({ ok: true, exitCode: 0, stdout: outs[n - 1] || '' }),
      script: ({ who, messages }) => {
        if (who !== 'pub') return say('好。');
        const tool = messages.filter((m) => m.role === 'tool');
        saw = tool.map((m) => String(m.content || ''));
        const hosts = ['tmpfiles.org', 'uguu.se', 'catbox.moe'];
        return tool.length < 3 ? call('shell', { command: `curl -s -F "file=@a.png" https://${hosts[tool.length]}/upload` }) : say('停下了。');
      },
    });
    await r.rt.runTurn({ botId: 'g65pub', text: '把图传上去', source: 'chat' });
    check('G65-9f a failed send (「uploads disabled」, an error page, nothing back) counts; after the second one in a turn the result tells the bot to stop trying other services and ask the human with tell_human - the first does not; the shell tool says so too',
      saw.length === 3 && !/stopSending/.test(saw[0]) && /stopSending/.test(saw[1]) && /tell_human/.test(saw[1]) && /stopSending/.test(saw[2])
      && agent.sendFailed(true, { ok: true, exitCode: 0, stdout: '--catbox--\n\n' }) && !agent.sendFailed(true, { ok: true, exitCode: 0, stdout: 'https://tmpfiles.org/dl/1/a.png' })
      && agent.sendFailed(false, { error: { code: 'X' } }) && agent.sendFailed(true, { timedOut: true })
      && /if sending out fails twice for the same goal, do not try other services one after another - stop and tell the human \(tell_human\)/.test(await readText('../src/tools.mjs')),
      JSON.stringify(saw.map((s) => s.slice(0, 80))));
    r.done();
  }

  // f. The page: the button, what it covers, the send's headline, the receipt; the answer reaches the hub (also through another machine).
  {
    const live = await readText('../public/app/main/06-live.js');
    const cards = await readText('../public/app/main/07b-cards.js');
    const server = await readText('../src/server.mjs');
    check('G65-9g the card offers 「这一轮都允许」 only when the hub does, says before the click what it covers and that it ends with the turn, heads a send with what leaves and where, and the answered card (live and from the history) says 「这一轮都允许：…」; the answer goes to the hub as chain, also passed on from another machine',
      live.includes("const turnWide = chainScope ? el('button', 'btn approval-chain', '这一轮都允许') : null;")
      && live.includes("「这一轮都允许」：这一轮里再${chainScope.label}不再问你${data.send ? '，换了别的地方照样问' : ''}；这一轮做完就失效。")
      && live.includes("card.appendChild(el('div', 'approval-title', data.send?.text || cardTitle(data, info, many)));")
      && live.includes("...(chain ? { chain: true } : {})") && cards.includes('这一轮都允许：这一轮里再${scope.label}不再问你，这一轮做完就失效')
      && cards.includes('if (good && data.chainAllowed && data.chainScope) wrap.appendChild(chainRow(data.chainScope));')
      && server.includes("edits, chain: body?.chain === true });") && server.includes("...(body?.chain === true ? { chain: true } : {})"));
  }
}
