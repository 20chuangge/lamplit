// 1.5.72: how a group works together (11-25, the human's three points).
//   1. Only the coordinator spoke in the group: a member's result went back to it and it retold it.
//   2. The coordinator sat 「正在转交给同事」 for as long as the member worked.
//   3. The human's 「继续」「必须发出去」 reached the member through the coordinator, in other words.
// Now: the coordinator gives work and lets go; the member reports in the group under its own name; the
// coordinator is woken once for a next step and says nothing when there is none; and the human's words go
// to the one member at work as they were said.
// Called from smoke.mjs as a stage.
import { teamRig, say, call, sleep, until } from './smoke-group-1565.mjs';

export async function letGoChecks({ check, toolsMod, groupsMod }) {
  const agent = await import('../src/agent.mjs');

  // --- give and let go; the member reports; nothing is retold ---------------------------------------
  let pubGate = null;
  const r = await teamRig({
    toolsMod, groupsMod,
    script: async ({ who, last, messages }) => {
      if (who === 'lead') {
        if (last.includes(agent.WAKE_MARK)) return say('收到');
        return messages.some((m) => m.role === 'tool') ? say('已经交给发布了。') : call('bot_message', { botId: '发布', text: '把第 1 条发到知乎，定时明晚 20:00。' });
      }
      if (who === 'pub') { await new Promise((res) => { pubGate = res; }); return say('知乎第 1 条排好了：明晚 20:00，链接在 发布记录.md。'); }
      return say('好。');
    },
  });
  await r.rt.runGroupMessage({ group: r.group, text: '把第 1 条发了' });
  await until(() => Boolean(pubGate), 3000);
  const leadFree = !r.rt.isWorking('g65lead');
  const pubAtWork = r.rt.isWorking('g65pub');
  const mid = await r.transcript();
  pubGate();
  await until(() => r.rt.plans?.get(r.group.id)?.status === 'done' && r.calls.some((c) => c.who === 'lead' && c.last.includes(agent.WAKE_MARK)), 5000);
  await until(() => !r.rt.isWorking('g65lead'), 3000);
  await sleep(60);
  const msgs = await r.transcript();
  const leadSaid = msgs.filter((m) => m.kind === 'assistant' && m.from === 'g65lead').map((m) => m.text);
  const pubSaid = msgs.filter((m) => m.kind === 'assistant' && m.from === 'g65pub').map((m) => m.text);
  const back = msgs.filter((m) => m.kind === 'handoff' && m.from === 'g65pub');
  check('LET72-1 the coordinator gives a member work and is free at once: while the member still works the coordinator has no turn, and the group already has the one line saying who does what (做完它自己在群里说)',
    leadFree && pubAtWork && mid.filter((m) => m.kind === 'assistant' && m.from === 'g65lead').length === 1 && /^好，交给「发布」.*做完它自己在群里说/.test(mid.find((m) => m.kind === 'assistant' && m.from === 'g65lead')?.text || ''),
    JSON.stringify({ leadFree, pubAtWork, mid: mid.map((m) => `${m.kind}:${m.from}`) }));
  check('LET72-2 the member\'s result is the group\'s message, in its own words under its own name - not a folded 「发布 → 主理人」 line, not a retelling; the coordinator\'s few words after giving out and its 「收到」 are not shown',
    pubSaid.length === 1 && pubSaid[0] === '知乎第 1 条排好了：明晚 20:00，链接在 发布记录.md。' && back.length === 0
    && leadSaid.length === 1 && !leadSaid.some((t) => /已经交给发布了|收到/.test(t)),
    JSON.stringify({ leadSaid, pubSaid, back: back.length }));
  const wakes = r.calls.filter((c) => c.who === 'lead' && c.last.includes(agent.WAKE_MARK));
  check('LET72-3 the coordinator is woken once with the member\'s words, to give out a next step; the board\'s row is 做完 and the board done',
    wakes.length === 1 && wakes[0].last.includes('知乎第 1 条排好了') && r.rt.plans.get(r.group.id)?.tasks?.[0]?.status === 'done' && r.rt.plans.get(r.group.id)?.status === 'done',
    JSON.stringify({ wakes: wakes.length, plan: r.rt.plans.get(r.group.id)?.status }));
  r.done();

  // --- the human's words go to the member at work, as said ------------------------------------------
  let gate2 = null;
  const r2 = await teamRig({
    toolsMod, groupsMod,
    script: async ({ who, last, messages, n }) => {
      if (who === 'lead') {
        if (last.includes(agent.WAKE_MARK)) return say('收到');
        return messages.some((m) => m.role === 'tool') ? say('交给发布了。') : call('bot_message', { botId: '发布', text: '把第 1 条发到知乎。' });
      }
      if (who === 'pub') {
        if (n === 1) { await new Promise((res) => { gate2 = res; }); return call('fs_list', { path: '.' }); }
        return say('发好了。');
      }
      return say('好。');
    },
  });
  await r2.rt.runGroupMessage({ group: r2.group, text: '把第 1 条发了' });
  await until(() => Boolean(gate2), 3000);
  const leadCallsBefore = r2.calls.filter((c) => c.who === 'lead').length;
  const routed = await r2.rt.routeGroupMessage({ group: r2.group, text: '必须发出去', fromHuman: true });
  const named = await r2.rt.soleWorker(r2.rt.plans.get(r2.group.id), r2.group);
  gate2();
  await until(() => r2.rt.plans?.get(r2.group.id)?.status === 'done', 5000);
  await until(() => !r2.rt.isWorking('g65lead'), 3000);
  const msgs2 = await r2.transcript();
  const word = msgs2.find((m) => m.kind === 'user' && m.text === '必须发出去');
  const pubHeard = r2.calls.filter((c) => c.who === 'pub').some((c) => c.all.includes('必须发出去'));
  const leadHeardRaw = r2.calls.filter((c) => c.who === 'lead').slice(leadCallsBefore).filter((c) => !c.last.includes(agent.WAKE_MARK)).length;
  check('WORD72-1 one member is at the only open work, the coordinator is free, the human names nobody: 「必须发出去」 is in the group as theirs (to that member) and reaches the member\'s running turn word for word - no coordinator turn in between',
    routed?.toMember === 'g65pub' && routed.aside === true && word?.to === 'g65pub' && pubHeard && leadHeardRaw === 0 && named?.member?.id === 'g65pub',
    JSON.stringify({ routed, to: word?.to, pubHeard, leadHeardRaw }));
  r2.done();

  // --- still the coordinator's: a name, two at work, no board ---------------------------------------
  const rt = Object.create(agent.AgentRuntime.prototype);
  rt.active = new Map();
  const group = { id: 'g', coordinatorId: 'lead', members: [{ id: 'lead', name: '主理人' }, { id: 'pub', name: '发布' }, { id: 'far', name: '远', remote: { machine: 'x' } }] };
  const row = (owner, status) => ({ id: owner, owner, status });
  const one = rt.soleWorker({ auto: true, status: 'running', tasks: [row('pub', 'doing'), row('lead', 'done')] }, group);
  const waiting = rt.soleWorker({ auto: true, status: 'waiting', tasks: [row('pub', 'waiting_human')] }, group);
  const two = rt.soleWorker({ auto: true, status: 'running', tasks: [row('pub', 'doing'), row('lead', 'todo')] }, group);
  const planned = rt.soleWorker({ auto: false, status: 'running', tasks: [row('pub', 'doing')] }, group);
  const remote = rt.soleWorker({ auto: true, status: 'running', tasks: [row('far', 'doing')] }, group);
  rt.active.set('t9', { botId: 'lead' });
  const leading = rt.soleWorker({ auto: true, status: 'running', leadTurn: 't9', tasks: [row('pub', 'doing')] }, group);
  check('WORD72-2 only then: one open row on a hand-off board (at work or waiting for the human), its member on this machine, the coordinator not at work. Two rows open, a board the coordinator planned, a member on another machine, the coordinator still at it: the coordinator hears it as before',
    one?.member?.id === 'pub' && waiting?.member?.id === 'pub' && two === null && planned === null && remote === null && leading === null,
    JSON.stringify({ one: one?.member?.id, waiting: waiting?.member?.id, two, planned, remote, leading }));
}
