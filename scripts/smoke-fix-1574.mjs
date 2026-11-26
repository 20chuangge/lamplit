// 1.5.74: from the second full run (11-25, 23:21). A note went from topic to a scheduled post again, and:
//   1. with no draft shown, the phone asked twice for one piece of work - switching 「定时发布」 on, then the
//      button that submits it;
//   2. the two cards showed in the group while they waited, and were gone after leaving the group and
//      coming back: an answered card was kept only in the member's own chat.
// Called from smoke.mjs as a stage.
export async function fix1574Checks({ check, toolsMod, groupsMod, readText }) {
  const T = await import('./ask-table.mjs');
  const lines = await T.runTable({ toolsMod });
  const row = (what) => lines.find((l) => l.what.includes(what));
  const once = row('这件事你刚允许过「定时发布」');
  const pay = row('这件事你刚允许过「发布」');
  const agent = await readText('../src/agent.mjs');
  check('ONCE74-1 one piece of work asks once: after a yes on a publish or send tap on the phone the next such tap of that work runs (at every level); a payment after it still asks',
    once && once.careful === false && once.standard === false && once.auto === false && pay && pay.careful === true && pay.auto === true
    && agent.includes("if (name === 'phone' && riskInfo.alwaysAsk && ['publish', 'send'].includes(riskInfo.phoneKind) && resolution.decision === 'approved') {"),
    JSON.stringify({ once, pay }));

  const gid = `g74_${Math.random().toString(36).slice(2, 8)}`;
  const saved = await groupsMod.appendGroupMessage(gid, {
    kind: 'approval', from: 'pub', name: 'phone', turnId: 't1', approvalId: 'ap_1', risk: 'HIGH', reason: '在手机的「小红书」上点「定时发布」', decision: 'approved', note: '', args: '{"action":"tap","target":"定时发布"}',
  });
  const back = (await groupsMod.readGroupMessages(gid, { limit: 10 })).find((m) => m.kind === 'approval');
  const pub = groupsMod.publicGroupMessage(saved);
  const plain = groupsMod.publicGroupMessage(await groupsMod.appendGroupMessage(gid, { kind: 'assistant', from: 'pub', text: '好', risk: 'HIGH', decision: 'approved' }));
  await groupsMod.deleteGroupMessages?.(gid).catch?.(() => {});
  const page = await readText('../public/app/main/03-groups.js');
  check('CARD74-1 a member\'s card answered during a group\'s work is kept in the group\'s own record (who, which step, why it asked, what the human said) and drawn from there after a reload; other kinds of message carry none of those fields',
    back?.from === 'pub' && back.name === 'phone' && back.approvalId === 'ap_1' && back.decision === 'approved' && /定时发布/.test(back.reason) && pub.risk === 'HIGH' && /定时发布/.test(pub.args)
    && plain.risk === undefined && plain.decision === undefined
    && agent.includes("kind: 'approval', from: bot.id, name, turnId, approvalId: resolution.approval?.id || request?.id || '',") && agent.includes('if (ctx.group?.id) {')
    && page.includes("if (kind === 'approval') {") && page.includes('decision: item.decision,'),
    JSON.stringify({ back, plain }));
}
