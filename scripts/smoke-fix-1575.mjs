// 1.5.75: from the third full run (11-27, 14:52). 「重新选题，发后天的小红书，使用app」:
//   1. the board was planned for 11-28 - no prompt held today's date, the coordinator counted on from the
//      last post in the history;
//   2. (from the first run) 「发了吗」 on a running board was answered 「好，把新要求告诉了发布」;
//   3. (from the first two runs) 1 and 0 of 6 topics went in: the app's panel listed only the hot ones.
// Called from smoke.mjs as a stage.
export async function fix1575Checks({ check, readText }) {
  const A = await import('../src/agent.mjs');
  const agent = await readText('../src/agent.mjs');

  // --- the date -----------------------------------------------------------------------------------------
  const at = new Date('2026-11-27T06:52:59Z');
  const line = A.todayLine('Asia/Shanghai', at);
  const late = A.todayLine('Asia/Shanghai', new Date('2026-12-31T17:30:00Z')); // 01:30 on Jan 1 in Shanghai
  const bad = A.todayLine('Not/AZone', at);
  check('DATE75-1 a prompt says what day it is in the app\'s timezone, with tomorrow and the day after spelled out (11-27 周五 → 后天 = 2026-11-29 周日), across a year\'s end, and an unknown timezone falls back to the machine\'s instead of failing',
    /Today is 2026-11-27 周五 \(Asia\/Shanghai\)/.test(line) && /明天 = 2026-11-28 周六/.test(line) && /后天 = 2026-11-29 周日/.test(line) && /never from the dates of earlier work/.test(line)
    && /Today is 2027-01-01 周五/.test(late) && /后天 = 2027-01-03 周日/.test(late) && /^Today is \d{4}-\d{2}-\d{2} 周/.test(bad), JSON.stringify({ line, late, bad }));
  check('DATE75-2 it is in every bot\'s system prompt (day only, so the prompt changes once a day) and in the coordinator\'s look at its running board',
    agent.includes("      bot.persona || '',\n      todayLine(this.appTimeZone()),".replace(/\n/g, agent.includes('\r\n') ? '\r\n' : '\n')) && agent.split('todayLine(this.appTimeZone())').length === 3);

  // --- asking on a running board ------------------------------------------------------------------------
  const asks = ['发了吗', '到哪一步了？', '好了没', '现在怎么样了', '发了没有'];
  const tells = ['视频号先跳过', '标题改成秋天', 'D19 发后天的', '不要用这张图'];
  check('ASK75-1 a short line that only asks (「发了吗」「到哪一步了？」) is told from one that tells (「视频号先跳过」)',
    asks.every(A.isAsking) && !tells.some(A.isAsking) && !A.isAsking('') && !A.isAsking(`${'很长的一段话'.repeat(12)}吗`), JSON.stringify({ asks: asks.map(A.isAsking), tells: tells.map(A.isAsking) }));

  const rig = (reply) => {
    const rt = Object.create(A.AgentRuntime.prototype);
    const seen = { calls: [], said: [], changed: [] };
    Object.assign(rt, {
      bots: { getBot: async () => ({ id: 'lead', name: '主理人', role: '' }) },
      modelFor: async () => ({ provider: 'x', model: 'y', complete: async (messages, opts) => { seen.calls.push({ messages, opts }); return reply; } }),
      bus: { emit: () => {} },
      getApp: () => ({ settings: { timezone: 'Asia/Shanghai' } }),
      recordGroupMessage: async (_g, m) => { seen.said.push(m.text); },
      changeTask: async ({ args }) => { seen.changed.push(args); return '把新要求告诉了发布（第 2 项）'; },
    });
    return { rt, seen };
  };
  const group = { id: 'g75', name: '内容组', members: [{ id: 'lead', name: '主理人' }, { id: 'pub', name: '发布' }, { id: 'art', name: '美术' }] };
  const plan = () => ({ id: 'p1', coordinatorId: 'lead', request: '发后天的小红书', tasks: [
    { id: 't1', title: '出图', owner: 'art', status: 'done', result: '九张图在 xhs/图 里' },
    { id: 't2', title: '手机定时发布', owner: 'pub', status: 'doing', startedAt: new Date().toISOString() },
  ] });
  const note = { name: 'task_change', id: 'c1', arguments: { action: 'note', task: 2, reason: '发了吗' } };

  const q = rig({ content: '', toolCalls: [note] });
  const qa = await q.rt.reviewPlan({ group, plan: plan(), texts: ['发了吗'], turnId: 't' });
  const qSys = q.seen.calls[0]?.messages[0].content || '';
  check('ASK75-2 「发了吗」 while a board runs: the coordinator is told the human is asking and to answer from the board (what is done with its result, what is being done), gets no tool to change the board, and nothing on the board changes - even when the model tries; with no words from the model the answer is where the board stands, never 「把新要求告诉了…」',
    q.seen.changed.length === 0 && !q.seen.calls[0]?.opts?.tools && /他在问，不是在提新要求/.test(qSys) && /结果：九张图在 xhs\/图 里/.test(qSys) && /Today is \d{4}/.test(qSys)
    && /第 1 项「出图」做完了（美术）；第 2 项「手机定时发布」正在做（发布）/.test(qa.text) && !/告诉了/.test(qa.text) && q.seen.said[0] === qa.text, JSON.stringify({ qa, changed: q.seen.changed }));

  const q2 = rig({ content: '图已经出完，发布正在手机上排定时，还没发出去。', toolCalls: [] });
  const qa2 = await q2.rt.reviewPlan({ group, plan: plan(), texts: ['发了吗'], turnId: 't' });
  const t = rig({ content: '', toolCalls: [{ ...note, arguments: { action: 'note', task: 2, reason: '改成后天 11-29 20:00' } }] });
  const ta = await t.rt.reviewPlan({ group, plan: plan(), texts: ['是后天，不是明天'], turnId: 't' });
  const tSys = t.seen.calls[0]?.messages[0].content || '';
  check('ASK75-3 the model\'s own answer to a question is what the group reads; words that tell (「是后天，不是明天」) still go the old way - the board can be changed, and the coordinator is told the human\'s day wins over the one on the board',
    qa2.text === '图已经出完，发布正在手机上排定时，还没发出去。' && t.seen.changed.length === 1 && Array.isArray(t.seen.calls[0]?.opts?.tools) && /以用户的话为准/.test(tSys) && /判断它对任务板有没有影响/.test(tSys) && /告诉了发布/.test(ta.text),
    JSON.stringify({ qa2, ta, changed: t.seen.changed }));

  // --- topics on the phone ------------------------------------------------------------------------------
  check('TOPIC75-1 a bot with the phone is told how a topic goes in (type # and the word at the end of the text, tap the suggestion that reads the same; a hot-topics panel is not the way; with no suggestion take the typed text out and say which are missing)',
    /A topic \(hashtag\) in a phone app: at the end of the text type # and the word, look, and tap the suggestion that reads the same/.test(agent) && /delete what you typed for it, go on, and say which topics are not in/.test(agent));
}
