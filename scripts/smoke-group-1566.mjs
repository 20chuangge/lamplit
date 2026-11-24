// 1.5.66: what the real-model collaboration eval on 1.5.65 found (eval notes, section 十一). Two fixes:
//   G66-1 a member that asked the human with a blocking tell_human keeps its task-board item waiting
//         (not done): the answer - in the group, in the member's own chat, or for a member on another
//         machine - sends it back to that item (s1: 发布 asked about the video mark, the item was marked
//         done, and the answer went to a new coordinator turn);
//   G66-2 a turn that ends saying 「到了上限 / 被打断 / 我接着做」 with steps to spare is told once to go on,
//         and a board item whose turn still says so goes on (counted toward the same cap) instead of being
//         marked done (s6: 123 of 150 steps, 131 of 160 pages, marked done).
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
// IDs used here start with g66 so they never clash with other scenarios.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// A small real team: the runtime's own loop, a scripted model, the real tools.
async function teamRig({ toolsMod, groupsMod, script, approve = () => 'approved' }) {
  const { AgentRuntime } = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g66-'));
  const bots = new Map([
    ['g66lead', { id: 'g66lead', name: '主理人', role: '协调', persona: 'WHO:lead', tools: ['fs_list', 'fs_read', 'bot_message'], skills: [], policy: {} }],
    ['g66pub', { id: 'g66pub', name: '发布', role: '发布', persona: 'WHO:pub', tools: ['fs_list', 'fs_write'], skills: [], policy: {} }],
  ]);
  const group = { id: `g66g_${Math.random().toString(36).slice(2, 8)}`, name: 'g66 内容组', coordinatorId: 'g66lead', members: [...bots.values()].map(({ id, name, role, tools }) => ({ id, name, role, tools })) };
  const ev = [];
  const calls = [];
  const cards = [];
  const records = [];
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
  rt.record = async (botId, rec) => { records.push({ botId, ...rec }); };
  rt.gatherMs = 0;
  rt.ackMs = 100;
  rt.taskDelayMs = 50;
  rt.groupForRun = async (id) => (id === group.id ? { group } : null);
  const listGroups = async () => [{ id: group.id, name: group.name, coordinatorId: group.coordinatorId, members: group.members.map((m) => m.id) }];
  rt.groups = { ...groupsMod, listGroups };
  const turns = (botId) => {
    const out = new Map();
    for (const e of ev) {
      if (e.botId !== botId || e.aside || !e.turnId) continue;
      if (e.type === 'turn.start') out.set(e.turnId, { turnId: e.turnId, source: e.source, start: e.at, end: null, text: e.text });
      if (e.type === 'turn.end' && out.has(e.turnId)) Object.assign(out.get(e.turnId), { end: e.at, status: e.status, steps: e.steps, summary: e.summary });
    }
    return [...out.values()];
  };
  const done = () => fs.rmSync(ws, { recursive: true, force: true });
  return { rt, ev, calls, cards, records, group, ws, bots, turns, done };
}

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = `c_${Math.random().toString(36).slice(2, 8)}`) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });
const tools = (messages) => messages.filter((m) => m.role === 'tool');
const QUESTION = '视频标记选哪个？「AI 生成」还是「无需标记」？';

// ---------------------------------------------------------------------------
// G66-1: a member waiting on its question keeps its board item waiting
// ---------------------------------------------------------------------------
export async function waitingChecks({ check, toolsMod, groupsMod, readText }) {
  /** 发布 asks about the video mark; with the answer it drafts the post (a card) and reports. */
  const pubScript = (answered) => ({ who, last, all, messages }) => {
    if (who === 'lead' && /任务板做完了/.test(last)) return say('甲站发好了。');
    if (who === 'lead') return call('group_plan', { tasks: [{ title: '在甲站发第 1 条视频', owner: '发布', brief: '发之前确认视频标记' }] });
    if (who !== 'pub') return say('好。');
    if (answered.test(all)) {
      const t = tools(messages);
      if (!t.length) return call('post_draft', { channel: '甲站', title: '第一次打开', body: '正文' });
      return say(/HUMAN_DECISION_PENDING/.test(String(t[t.length - 1].content || '')) ? '还在等你回答。' : '甲站第 1 条发好了，视频标记选了「无需标记」。');
    }
    return tools(messages).length ? say('已经问你视频标记选哪个了，等你回答再发。') : call('tell_human', { text: QUESTION });
  };

  // 1. The eval's s1, in the group: the item waits with the question; the answer in the group sends 发布 back to it.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: pubScript(/用户的回答：选「无需标记」/) });
    await r.rt.routeGroupMessage({ group: r.group, text: '发甲站第一条', turnId: 'turn_g66_s1', fromHuman: true });
    const plan = await until(() => { const p = r.rt.plans?.get(r.group.id); return p?.status === 'waiting' ? p : null; }, 5000);
    const row = plan?.tasks?.[0];
    const before = { status: row?.status, question: row?.question, summed: r.calls.filter((c) => c.who === 'lead' && /任务板做完了/.test(c.last)).length, pending: r.rt.pendingFor('g66pub')?.kind };
    const turnRec = r.records.find((x) => x.kind === 'turn' && x.botId === 'g66pub');
    const took = await r.rt.answerBoard(r.group, '选「无需标记」');
    await until(() => r.rt.plans.get(r.group.id)?.status === 'done', 5000);
    const after = r.rt.plans.get(r.group.id);
    const resumed = r.calls.find((c) => c.who === 'pub' && /你之前问过用户：视频标记选哪个/.test(c.all) && /用户的回答：选「无需标记」/.test(c.all));
    const posts = r.ev.filter((e) => e.type === 'tool.result' && e.name === 'post_draft');
    check('G66-1a a board item whose member asked the human (blocking tell_human) and ended its turn stays 等用户回复 with that question - not done, no summing-up - and the answer in the group sends that member back to it: it drafts the post on a card (not refused) and the board ends done, summed up once',
      before.status === 'waiting_human' && before.question === QUESTION && before.summed === 0 && before.pending === 'decision' && took === true
      && Boolean(resumed) && r.cards.length === 1 && posts.length === 1 && posts[0].ok !== false
      && after?.status === 'done' && after.tasks[0].status === 'done' && /无需标记/.test(after.tasks[0].result || '')
      && r.calls.filter((c) => c.who === 'lead' && /任务板做完了/.test(c.last)).length === 1,
      JSON.stringify({ before, took, resumed: Boolean(resumed), cards: r.cards.length, status: after?.status, row: after?.tasks?.[0]?.status, result: after?.tasks?.[0]?.result }));
    check('G66-1b the turn itself says what it stopped for: its result carries waitingFor decision and the question, and so does its record (which another machine reads)',
      turnRec?.waitingFor === 'decision' && turnRec.waitingText === QUESTION, JSON.stringify(turnRec && { waitingFor: turnRec.waitingFor, waitingText: turnRec.waitingText }));
    r.done();
  }

  // 2. Answered while that turn still runs (a word into it): the turn does not end as waiting; the item is done.
  {
    let release = null;
    const r = await teamRig({
      toolsMod, groupsMod,
      script: async ({ who, last, all, messages }) => {
        if (who === 'lead' && /任务板做完了/.test(last)) return say('甲站发好了。');
        if (who === 'lead') return call('group_plan', { tasks: [{ title: '在甲站发第 1 条视频', owner: '发布', brief: '' }] });
        if (who !== 'pub') return say('好。');
        const t = tools(messages);
        if (!t.length) return call('tell_human', { text: QUESTION });
        if (t.length === 1) { await new Promise((resolve) => { release = resolve; }); return call('fs_write', { path: 'g66/甲站.txt', content: 'x' }); }
        return say(/无需标记/.test(all) ? '甲站第 1 条发好了，按你说的选了「无需标记」。' : '甲站发好了。');
      },
    });
    await r.rt.routeGroupMessage({ group: r.group, text: '发甲站第一条', turnId: 'turn_g66_mid', fromHuman: true });
    await until(() => release, 5000);
    const busy = r.rt.busyTurn('g66pub', { any: true });
    await r.rt.aside({ botId: 'g66pub', text: '选「无需标记」', busy, source: 'chat' });
    release();
    await until(() => r.rt.plans.get(r.group.id)?.status === 'done', 5000);
    const row = r.rt.plans.get(r.group.id)?.tasks?.[0];
    check('G66-1c answered while that turn still ran (a word into it): the turn does not end as waiting for the human, the item is done and the question is closed',
      row?.status === 'done' && r.rt.pendingFor('g66pub') === null && !r.ev.some((e) => e.type === 'turn.end' && e.botId === 'g66pub' && e.waitingFor),
      JSON.stringify({ row: row?.status, pending: r.rt.pendingFor('g66pub'), result: row?.result }));
    r.done();
  }

  // 3. Answered in the member's own chat (the page, or Feishu): the answer goes to the item; no second turn beside it.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: pubScript(/用户的回答：选「无需标记」/) });
    await r.rt.routeGroupMessage({ group: r.group, text: '发甲站第一条', turnId: 'turn_g66_chat', fromHuman: true });
    await until(() => r.rt.plans?.get(r.group.id)?.status === 'waiting', 5000);
    const got = await r.rt.answerInChat('g66pub', '选「无需标记」', { turnId: 'turn_g66_chat_answer', source: 'chat' });
    await until(() => r.rt.plans.get(r.group.id)?.status === 'done', 5000);
    const after = r.rt.plans.get(r.group.id);
    const chatTurns = r.turns('g66pub').filter((t) => t.source === 'chat');
    const said = r.records.filter((x) => x.botId === 'g66pub' && x.turnId === 'turn_g66_chat_answer').map((x) => x.kind);
    const transcript = await groupsMod.readGroupMessages(r.group.id, { limit: 200 });
    const none = await r.rt.answerInChat('g66pub', '今天天气怎么样', { source: 'chat' });
    const [server, feishu] = await Promise.all([readText('../src/server.mjs'), readText('../src/feishu.mjs')]);
    check('G66-1d answered in the member\'s own chat: the answer goes to its waiting item (the chat shows the message and one line saying where it went on), that member goes back to the item on the board and it ends done - no chat turn beside it; with nothing waiting, a chat message is just a chat message',
      Boolean(got) && /任务板上「在甲站发第 1 条视频」/.test(got.text) && after?.status === 'done' && after.tasks[0].answer === '选「无需标记」' && /无需标记/.test(after.tasks[0].result || '')
      && chatTurns.length === 0 && said.join() === 'user,assistant' && transcript.some((m) => m.kind === 'user' && /单聊里回答/.test(m.text || '')) && none === null
      && r.cards.length === 1,
      JSON.stringify({ got: got?.text, status: after?.status, answer: after?.tasks?.[0]?.answer, chatTurns: chatTurns.length, said, none }));
    check('G66-1e the page\'s chat route and Feishu both offer the message to a waiting item first - before it would start a turn or go into one at work',
      /answerInChat\?\.\(bot\.id, text, \{ turnId, source: 'chat' \}\)[\s\S]{0,200}if \(toBoard\) return[\s\S]{0,200}const busyNow = /.test(server)
      && /answerInChat\?\.\(id, full, \{ turnId, source: 'feishu' \}\)[\s\S]{0,200}if \(toBoard\)[\s\S]{0,200}const busy = o\.runtime\.busyTurn/.test(feishu));
    r.done();
  }

  // 4. A member on another machine asks there: the item waits here; the answer goes there with the item, marked as theirs.
  {
    const sent = [];
    const r = await teamRig({ toolsMod, groupsMod, script: ({ who, last }) => (who === 'lead' && /任务板做完了/.test(last) ? say('甲站发好了。') : say('好。')) });
    const far = { id: 'g66far', name: '远端发布', role: '发布', remote: { machine: '另一台', botId: 'bot-far' } };
    const group = { ...r.group, members: [...r.group.members, far] };
    let n = 0;
    r.rt.getPeers = () => ({
      find: () => ({ name: '另一台' }),
      json: async (_peer, method, _p, opts = {}) => {
        if (method === 'POST') { sent.push(opts.body); n += 1; return { turnId: `turn_g66far_${n}` }; }
        return n === 1
          ? [{ turnId: `turn_g66far_${n}`, role: 'assistant', text: '我问了你视频标记选哪个，等你回答。' }, { turnId: `turn_g66far_${n}`, role: 'status', status: 'success', waitingFor: 'decision', waitingText: QUESTION }]
          : [{ turnId: `turn_g66far_${n}`, role: 'assistant', text: '甲站第 1 条发好了。' }, { turnId: `turn_g66far_${n}`, role: 'status', status: 'success' }];
      },
    });
    const now = new Date().toISOString();
    const plan = { id: `plan_g66_far_${Date.now()}`, groupId: group.id, request: '发甲站', coordinatorId: 'g66lead', status: 'running', createdAt: now, updatedAt: now,
      tasks: [{ id: 't1', title: '在甲站发第 1 条视频', owner: 'g66far', brief: '', deliverable: '', needs: [], status: 'todo', question: '', answer: '', result: '' }] };
    await r.rt.boardChanged(plan);
    await r.rt.runPlan(group, plan);
    const waited = { status: plan.status, row: plan.tasks[0].status, question: plan.tasks[0].question };
    const took = await r.rt.answerBoard(group, '选「无需标记」');
    await until(() => r.rt.plans.get(group.id)?.status === 'done', 9000);
    const [server, cross] = await Promise.all([readText('../src/server.mjs'), readText('../src/crossmachine.mjs')]);
    check('G66-1f a member on another machine that asked the human there: the item here waits with its question (not done); the answer in the group goes there with the item, marked as the human\'s answer, and the board ends done - that machine\'s turn record and its messages route carry what it stopped for',
      waited.status === 'waiting' && waited.row === 'waiting_human' && waited.question === QUESTION && took === true && sent.length === 2
      && sent[1]?.handoff?.answered === true && /用户的回答：选「无需标记」/.test(sent[1]?.text || '') && r.rt.plans.get(group.id)?.status === 'done'
      && /waitingFor: record\.waitingFor/.test(server) && /waitingFor: String\(done\.waitingFor\)/.test(cross),
      JSON.stringify({ waited, took, sent: sent.length, answered: sent[1]?.handoff?.answered, status: r.rt.plans.get(group.id)?.status }));
    r.done();
  }
}

// ---------------------------------------------------------------------------
// G66-2: 「到了上限，我接着做」 with steps to spare goes on; a plain result still finishes
// ---------------------------------------------------------------------------
export async function goOnChecks({ check, toolsMod, groupsMod }) {
  const A = await import('../src/agent.mjs');
  const NOT_DONE = '这一轮又遇到单轮步数上限，做到第 3 条就被打断，我继续往下做。';

  // 0. The wording, in Chinese and English: narrow on purpose.
  {
    const yes = [NOT_DONE, '还剩 29 条，我接着做。', 'I hit the step limit at page 131; I will continue in the next turn.', '做到一半被系统打断了。'];
    const no = ['全部 160 条都整理好了，文件在 out/list.md。', '上一轮因为步数上限被打断，这一轮接着做完了，共 160 条。', '做完了。如果还要继续，告诉我就行。',
      '我接着做完了第二部分，全部 160 条已完成。', '甲站发好了；乙站登录失败，没发成。', '需要的话我可以接着整理剩下的。', 'Done: all 160 pages are in out/list.md.', 'All done. Let me know if you want me to continue with more.'];
    const wrongYes = yes.filter((t) => !A.saysNotDone(t));
    const wrongNo = no.filter((t) => A.saysNotDone(t));
    check('G66-2a 「没做完，我接着做」 is read narrowly: hit the limit / cut off / will go on is it; a plain result, a result that mentions an earlier cut-off, a failure report and an offer to go on are not (Chinese and English)',
      wrongYes.length === 0 && wrongNo.length === 0, JSON.stringify({ wrongYes, wrongNo }));
  }

  // 1. In the turn: it stops at step 3 saying it hit the limit - told once that it did not, it goes on and finishes.
  {
    let nudge = '';
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, messages }) => {
        if (who !== 'pub') return say('好。');
        if (/没到 \d+ 步的上限/.test(last)) nudge = last;
        const t = tools(messages).length;
        if (t < 3) return call('fs_write', { path: `g66/row-${t}.txt`, content: 'x' });
        if (!nudge) return say(NOT_DONE);
        if (t < 6) return call('fs_write', { path: `g66/row-${t}.txt`, content: 'x' });
        return say('6 条都整理好了，在 g66/ 下。');
      },
    });
    const res = await r.rt.runTurn({ botId: 'g66pub', text: '把 6 条整理好', source: 'chat' });
    const retracted = r.ev.filter((e) => e.type === 'message.retract' && e.botId === 'g66pub').length;
    // 1.5.67: every bot has 150 steps a turn.
    check('G66-2b a turn that ends at step 4 of 150 saying 「到了上限……我接着做」 is told once that it has steps left and was not cut off; it goes on, and the turn ends with the real result',
      res.status === 'success' && /这一回合才做了 4 步，没到 150 步的上限/.test(nudge) && retracted === 1 && /6 条都整理好了/.test(res.summary) && !res.notDone && res.steps < 150,
      JSON.stringify({ status: res.status, steps: res.steps, summary: res.summary, nudge: nudge.slice(0, 60), retracted }));
    r.done();
  }

  // 2. On the board: the turn still says it will go on after that - the item goes on in a new turn instead of being marked done.
  {
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, all, messages }) => {
        if (who === 'lead' && /任务板做完了/.test(last)) return say('160 条都整理好了。');
        if (who === 'lead') return call('group_plan', { tasks: [{ title: '整理 160 条', owner: '发布', brief: '整理成一份清单' }] });
        if (who !== 'pub') return say('好。');
        if (!tools(messages).length) return call('fs_write', { path: `g66/part-${Math.random().toString(36).slice(2, 6)}.txt`, content: 'x' });
        return say(/上一轮还没做完就停了/.test(all) ? '全部 160 条都整理好了，在 g66/list.md。' : '做到第 131 条，还剩 29 条，我接着做。');
      },
    });
    await r.rt.routeGroupMessage({ group: r.group, text: '把 160 条整理好', turnId: 'turn_g66_long', fromHuman: true });
    await until(() => r.rt.plans?.get(r.group.id)?.status === 'done', 6000);
    const plan = r.rt.plans.get(r.group.id);
    const ts = r.turns('g66pub');
    const went = r.calls.find((c) => c.who === 'pub' && /第 1 次自动接着做/.test(c.all));
    check('G66-2c a board item whose turn ends 「还剩 29 条，我接着做」 (under the step limit, after the nudge) is not marked done: it goes on in a new turn, told it stopped before the limit, and ends done with the real result',
      ts.length === 2 && Boolean(went) && /上一轮还没做完就停了（没到步数上限）/.test(went.all) && plan?.tasks?.[0]?.status === 'done' && /全部 160 条/.test(plan.tasks[0].result || ''),
      JSON.stringify({ turns: ts.length, went: Boolean(went), row: plan?.tasks?.[0]?.status, result: plan?.tasks?.[0]?.result }));
    r.done();
  }

  // 3. A plain result finishes the item at once: one turn, no nudge.
  {
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, messages }) => {
        if (who === 'lead' && /任务板做完了/.test(last)) return say('好了。');
        if (who === 'lead') return call('group_plan', { tasks: [{ title: '整理 6 条', owner: '发布', brief: '' }] });
        if (who !== 'pub') return say('好。');
        return tools(messages).length ? say('6 条都整理好了，在 g66/list.md。需要的话我可以接着整理下一批。') : call('fs_write', { path: 'g66/list.md', content: 'x' });
      },
    });
    await r.rt.routeGroupMessage({ group: r.group, text: '把 6 条整理好', turnId: 'turn_g66_plain', fromHuman: true });
    await until(() => r.rt.plans?.get(r.group.id)?.status === 'done', 5000);
    const plan = r.rt.plans.get(r.group.id);
    check('G66-2d a plain 「做完了，结果在…」 (even with an offer to go on) still finishes the item at once: one turn, no nudge, done',
      r.turns('g66pub').length === 1 && !r.ev.some((e) => e.type === 'message.retract' && e.botId === 'g66pub') && plan?.tasks?.[0]?.status === 'done',
      JSON.stringify({ turns: r.turns('g66pub').length, row: plan?.tasks?.[0]?.status }));
    r.done();
  }

  // 4. It never stops saying it will go on: the same cap as the step limit's (6 more turns), then not done - the coordinator sees it.
  {
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, messages }) => {
        if (who === 'lead' && /任务板做完了/.test(last)) return say('还没做完。');
        if (who === 'lead') return call('group_plan', { tasks: [{ title: '整理 160 条', owner: '发布', brief: '' }] });
        if (who !== 'pub') return say('好。');
        return tools(messages).length ? say('还剩一些，我接着做。') : call('fs_write', { path: `g66/p-${Math.random().toString(36).slice(2, 6)}.txt`, content: 'x' });
      },
    });
    await r.rt.routeGroupMessage({ group: r.group, text: '把 160 条整理好', turnId: 'turn_g66_cap', fromHuman: true });
    await until(() => r.rt.plans?.get(r.group.id)?.status === 'done', 9000);
    const plan = r.rt.plans.get(r.group.id);
    check('G66-2e a turn that keeps saying 「我接着做」 goes on at most 6 more times (the step limit\'s cap), then the item is 没做成 with what it last said - never marked done',
      r.turns('g66pub').length === 7 && plan?.tasks?.[0]?.status === 'failed' && /自动接着做到次数用完，还是没做完/.test(plan.tasks[0].result || ''),
      JSON.stringify({ turns: r.turns('g66pub').length, row: plan?.tasks?.[0]?.status, result: plan?.tasks?.[0]?.result }));
    r.done();
  }

  // 5. Near the end it is told how many steps are left - once - and the go-on message no longer invites 「被打断了」.
  {
    let toldAt = -1;
    let told = 0;
    const r = await teamRig({
      toolsMod, groupsMod,
      script: ({ who, last, messages }) => {
        if (who !== 'pub') return say('好。');
        const t = tools(messages).length;
        if (/这一回合还能再走 10 步（上限 150 步）/.test(last)) { told += 1; if (toldAt < 0) toldAt = t; }
        return t >= 142 ? say('142 份都写好了。') : call('fs_write', { path: `g66/s-${t}.txt`, content: 'x' });
      },
    });
    const res = await r.rt.runTurn({ botId: 'g66pub', text: '写 142 份', source: 'chat' });
    const limit = A.continuationText({ n: 1, what: '任务板上交给你的「整理」' });
    const stopped = A.continuationText({ n: 1, what: '任务板上交给你的「整理」', why: 'stopped' });
    check('G66-2f with 10 steps left it is told so, once (「还能再走 10 步（上限 150 步）……不要提前停下」); the go-on message says the steps were used up or it stopped early - never 「被打断了」 - and asks not to stop saying so',
      res.status === 'success' && told === 1 && toldAt === 140
      && !/被打断了。/.test(limit) && /上一轮的步数用完了/.test(limit) && /上一轮还没做完就停了/.test(stopped) && /不要中途停下来说「到了上限」「被打断了」「我接着做」/.test(limit),
      JSON.stringify({ status: res.status, told, toldAt, steps: res.steps }));
    r.done();
  }
}

/**
 * 「以后都允许」 seen by the turn that is waiting (1.5.66): the human allowed a connected app's step
 * for good on the first card, yet the same turn's next two edits asked again (3 cards for 3 Notion
 * edits), because the server saved the rule after the turn already held its copy of the bot.
 */
export async function alwaysNowChecks({ check, readText }) {
  const A = await import('../src/approvals.mjs');
  const q = new A.ApprovalQueue({ timeoutMs: 60000 });
  const remember = { key: 'mcp__m1__notion-update-page', label: 'mcp__m1__notion-update-page' };
  const ask = (rem) => {
    const waiting = q.request({ turnId: 't66', botId: 'b66', toolName: 'mcp__m1__notion-update-page', args: { page_id: 'p' }, risk: 'MEDIUM', reason: 'test', remember: rem });
    return { waiting, id: [...q.records.keys()].at(-1) };
  };
  const a = ask(remember);
  q.decide(a.id, 'approve', '', 'human', { always: true });
  const ra = await a.waiting;
  const b = ask(remember);
  q.decide(b.id, 'approve', '', 'human');
  const rb = await b.waiting;
  const c = ask(null);
  q.decide(c.id, 'approve', '', 'human', { always: true });
  const rc = await c.waiting;
  const d = ask(remember);
  q.decide(d.id, 'deny', '', 'human', { always: true });
  const rd = await d.waiting;
  check('G66-3a 「以后都允许」 on a card that offered it reaches the waiting turn with the answer (alwaysAllowed); 「允许这一次」, a card without the offer, or 不要 do not',
    ra.approval?.alwaysAllowed === true && !rb.approval?.alwaysAllowed && !rc.approval?.alwaysAllowed && !rd.approval?.alwaysAllowed,
    JSON.stringify([ra.approval?.alwaysAllowed, rb.approval?.alwaysAllowed, rc.approval?.alwaysAllowed, rd.approval?.alwaysAllowed]));

  const agent = await readText('../src/agent.mjs');
  const server = await readText('../src/server.mjs');
  check('G66-3b the turn adds the rule to its own copy of the bot at once (the same key the server saves), so its next step of the same kind runs unasked; the page passes 「以后都允许」 to the queue',
    /if \(offered && resolution\.decision === 'approved' && resolution\.approval\?\.alwaysAllowed && !isRemembered\(bot, offered\.key\)\) \{\s*bot\.policy = \{ \.\.\.\(bot\.policy \|\| \{\}\), allowed: \[\.\.\.\(bot\.policy\?\.allowed \|\| \[\]\), \{ \.\.\.offered, at: /.test(agent)
    && server.includes("chain: body?.chain === true, always: body?.always === true }"));
}

/**
 * A bot that kept waking itself (1.5.66): X 账号管家 watched work\k8sgpt-lab, wrote its own scripts
 * there while waiting for the human, and each new file woke it again - 17 turns in 11 minutes.
 */
export async function watchSelfChecks({ check }) {
  const BS = String.fromCharCode(92); // Windows paths, as the bot gives them
  const IN = await import('../src/initiative.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g66-watch-'));
  let clock = Date.parse('2026-11-24T04:30:00Z');
  let files = ['01-env.sh'];
  const turns = [];
  const bus = { subs: [], subscribe(fn) { this.subs.push(fn); return () => {}; }, emit(e) { this.subs.forEach((fn) => fn(e)); } };
  const layer = IN.createInitiative({ file: path.join(tmp, 'initiative.json'), bus, now: () => clock, primaryId: () => 'chief', say: async () => {}, runTurn: async (o) => { turns.push(o); return {}; }, waiting: async () => ({ cards: [], unread: [], queued: [] }), listDir: async () => files });
  await layer.load();
  await layer.addWatch({ botId: 'x', path: ['work', 'k8sgpt-lab'].join(BS), about: '日志一出现就读' });
  await layer.tick();

  // The bot writes its own script into the folder (relative path, forward slashes, and a full path).
  bus.emit({ type: 'tool.result', botId: 'x', name: 'fs_write', ok: true, args: JSON.stringify({ path: 'work/k8sgpt-lab/03-diag.sh' }), result: {} });
  bus.emit({ type: 'tool.result', botId: 'x', name: 'fs_write', ok: true, args: { path: ['D:', 'ai', 'Lamplit', 'work', 'k8sgpt-lab', '结果记录.md'].join(BS) }, result: {} });
  bus.emit({ type: 'tool.result', botId: 'other', name: 'fs_write', ok: true, args: { path: 'work/k8sgpt-lab/from-other.md' }, result: {} });
  files = ['01-env.sh', '03-diag.sh', '结果记录.md'];
  clock += 61 * 1000;
  await layer.tick();
  const afterOwn = turns.length;
  check('G66-4a a file the watching bot wrote itself into the folder does not wake it (relative or full path)', afterOwn === 0, JSON.stringify(turns.map((t) => t.text.slice(0, 60))));

  files = [...files, 'log-01.txt', 'from-other.md'];
  clock += 61 * 1000;
  await layer.tick();
  const t1 = turns.at(-1);
  check('G66-4b a file the human (or another bot) put there still wakes it, naming only those files, and the turn is told its own files are not news and not to start new work while it waits for the human',
    turns.length === 1 && /log-01\.txt/.test(t1.text) && /from-other\.md/.test(t1.text) && !/03-diag\.sh/.test(t1.text) && /你自己写的文件不算新情况/.test(t1.text) && /不要趁等待做新的活/.test(t1.text), JSON.stringify(t1));

  files = [...files, 'log-02.txt'];
  clock += 61 * 1000;
  await layer.tick();
  const soon = turns.length;
  clock += 5 * 60 * 1000;
  await layer.tick();
  check('G66-4c a second new file within 5 minutes waits (is not lost): it wakes the bot once the 5 minutes are over',
    soon === 1 && turns.length === 2 && /log-02\.txt/.test(turns.at(-1).text), JSON.stringify(turns.map((t) => t.text.slice(0, 50))));

  // Woken often: at most 6 times an hour by itself; the 7th waits for the hour to pass.
  for (let i = 0; i < 6; i += 1) { files = [...files, `more-${i}.txt`]; clock += 5 * 60 * 1000 + 1000; await layer.tick(); }
  const inHour = turns.length;
  clock += 40 * 60 * 1000;
  await layer.tick();
  check('G66-4d a bot wakes itself at most 6 times an hour; what came in the meantime wakes it later, not lost',
    inHour <= 7 && turns.length === inHour + 1 && /more-5\.txt/.test(turns.at(-1).text), `${inHour} → ${turns.length}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
