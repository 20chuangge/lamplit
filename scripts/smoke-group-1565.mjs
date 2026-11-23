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
