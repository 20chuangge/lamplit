// 1.5.76: from 11-27, 16:28. The coordinator gave 发布 one thing to change on the phone; in the middle of it the
// model account ran dry:
//   1. the bot stopped with 「余额不足」 and never said where it was - the balance was only read when the human
//      opened the checkup;
//   2. the coordinator, woken by that, failed the same way and said the same line again;
//   3. the coordinator's line when it gave the work out promised a draft to confirm - there was none (「回读确认」
//      in the brief read as one).
// Called from smoke.mjs as a stage.
export async function fix1576Checks({ check, readText }) {
  const A = await import('../src/agent.mjs');
  const SV = await import('../src/server.mjs');
  const agent = await readText('../src/agent.mjs');
  const server = await readText('../src/server.mjs');

  // --- told before it runs out ----------------------------------------------------------------------------
  const bad = SV.balanceVerdict(3.2, 6, 'balance');
  check('BAL76-1 what counts as low: the account not usable, less than a day left at the recent pace, or under ¥2 whatever the pace; ¥50 at ¥5 a day is not, and no reading is not',
    /不能用了（余额 ¥0\.00）/.test(SV.lowBalanceText({ available: false, amount: 0 })) && bad.state === 'bad' && SV.lowBalanceText({ available: true, amount: 3.2 }, bad) === bad.text
    && /只剩 ¥1\.50，随时可能用完/.test(SV.lowBalanceText({ available: true, amount: 1.5 }, { state: 'ok', text: '' }))
    && SV.lowBalanceText({ available: true, amount: 50 }, SV.balanceVerdict(50, 5, 'balance')) === '' && SV.lowBalanceText(null) === '',
    JSON.stringify({ bad }));

  let t = 0;
  let reading = '';
  let reads = 0;
  const alerts = [];
  const watch = SV.createBalanceWatch({ read: async () => { reads += 1; if (reading === 'throw') throw new Error('HTTP 500'); return reading; }, onLow: (text) => alerts.push(text), now: () => t, gapMs: 1000, remindMs: 5000 });
  await watch.check();
  const calm = { low: watch.low, note: watch.note(), alerts: alerts.length };
  await watch.check(); // inside the gap: not read again
  const gapReads = reads;
  reading = '余额只剩 ¥1.50。'; t = 2000;
  await watch.check();
  const first = watch.note();
  const again = watch.note();
  t = 3500; await watch.check(); // still low: no second alert
  reading = 'throw'; t = 5000; await watch.check(); // the API failed: what was known stays
  const kept = watch.low;
  t = 8000; const later = watch.note(); // remindMs later: said once more
  reading = ''; t = 9500; await watch.check(); // topped up
  const cleared = { low: watch.low, note: watch.note() };
  reading = '余额只剩 ¥0.80。'; t = 11000; await watch.check();
  check('BAL76-2 the balance is looked at after work, at most once per gap; the moment it turns low the page is told once (not again while it stays low, not lost when one reading fails), the next turn the human starts hears it once and again only hours later; a top-up clears it and a new low tells again',
    calm.low === '' && calm.note === '' && calm.alerts === 0 && gapReads === 1 && first === '余额只剩 ¥1.50。' && again === '' && kept === '余额只剩 ¥1.50。' && later === '余额只剩 ¥1.50。'
    && cleared.low === '' && cleared.note === '' && alerts.length === 2 && alerts[1] === '余额只剩 ¥0.80。' && watch.note() === '余额只剩 ¥0.80。',
    JSON.stringify({ calm, gapReads, first, again, kept, later, cleared, alerts }));

  const said = [];
  const rt = { balanceNote: () => { said.push(1); return 'DeepSeek 余额只剩 ¥1.50，随时可能用完：用完后机器人会停在半路。'; } };
  const note = A.lowBalanceNote(rt, {});
  check('BAL76-3 a turn the human starts carries that line to the bot, to be said first and then work as usual; a routine, a teammate\'s request and a turn inside another do not use it up; the server wires it (after every turn that is not an aside) and only asks a real DeepSeek account',
    /（系统：DeepSeek 余额只剩 ¥1\.50/.test(note) && /先用一句话把这件事原样告诉用户/.test(note) && /然后照常做/.test(note)
    && A.lowBalanceNote(rt, { unattended: true }) === '' && A.lowBalanceNote(rt, { depth: 1 }) === '' && A.lowBalanceNote(rt, { fromBotId: 'lead' }) === '' && said.length === 1
    && A.lowBalanceNote({}, {}) === '' && A.lowBalanceNote({ balanceNote: () => { throw new Error('x'); } }, {}) === ''
    && agent.includes('+ lowBalanceNote(this, { unattended, depth, fromBotId })') && server.includes("balanceNote: () => refs.app?.balanceWatch?.note() || '',")
    && server.includes("if (ev.type === 'turn.end' && !ev.aside) state.balanceWatch.check().catch(() => {});") && server.includes("bus.emit({ type: 'balance.low', text });")
    && server.includes('if (provider === \'mock\' || !/^sk-[A-Za-z0-9]{24,}$/.test(key)) return \'\';'), note);
  const live = await readText('../public/app/main/06-live.js');
  const apps = await readText('../public/app/main/09-apps.js');
  const roster = await readText('../src/roster.mjs');
  check('BAL76-4 the page shows it as a notice and keeps it in the activity list; it is this machine\'s own account, not passed on to another machine\'s page',
    live.includes("if (ev.type === 'balance.low') {") && apps.includes("case 'balance.low':") && /'usage\.alert', 'balance\.low'/.test(roster));

  // --- a model error in the middle of work ----------------------------------------------------------------
  check('ERR76-1 a turn the model fails in after its first step says the work stopped half way and how many steps it had done (a first-step failure stays the plain line)',
    agent.includes('if (steps > 0) summary += ` 手上这件事停在了半路（已经做了 ${steps} 步），恢复后跟我说一声，我接着做。`;'));

  const mk = () => {
    const r = Object.create(A.AgentRuntime.prototype);
    const seen = { posted: [], woken: 0 };
    Object.assign(r, {
      groups: { hasAssistantMessage: async () => false },
      recordGroupMessage: async (_g, m) => { seen.posted.push(m.text); },
      busyGroupTurn: () => null,
      runGroupMessage: async () => { seen.woken += 1; },
      routeGroupMessage: async () => { seen.woken += 1; },
      bus: { emit: () => {} },
    });
    return { r, seen };
  };
  const group = { id: 'g76', members: [{ id: 'lead', name: '主理人' }, { id: 'pub', name: '发布' }] };
  const member = { id: 'pub', name: '发布' };
  const f = mk();
  await f.r.memberReported({ group, lead: { id: 'lead' }, member, result: { status: 'failed', turnId: 't1', summary: '模型出错了：账户没钱了：服务商说余额不足。 手上这件事停在了半路（已经做了 22 步），恢复后跟我说一声，我接着做。' } });
  const ok = mk();
  await ok.r.memberReported({ group, lead: { id: 'lead' }, member, result: { status: 'success', turnId: 't2', summary: 'D19 已改到 11-29 20:00。' } });
  const other = mk();
  await other.r.memberReported({ group, lead: { id: 'lead' }, member, result: { status: 'failed', turnId: 't3', summary: '小红书登录掉了，没改成。' } });
  check('ERR76-2 a member stopped by the model itself says so in the group once - the coordinator is not woken into the same error; a member that finished, or failed for a reason of the work, still wakes the coordinator for the next step',
    f.seen.posted.length === 1 && /停在了半路（已经做了 22 步）/.test(f.seen.posted[0]) && f.seen.woken === 0 && ok.seen.woken === 1 && other.seen.woken === 1 && other.seen.posted.length === 1,
    JSON.stringify({ f: f.seen, ok: ok.seen, other: other.seen }));

  // --- the hand-off line ----------------------------------------------------------------------------------
  const change = A.handoffReply([{ name: '发布', title: '把 D19 的定时改到 11-29', text: '把 D19 的定时发布从 11-28 改到 11-29，改完必须回读确认，其他不动。' }]);
  const draft = A.handoffReply([{ name: '发布', title: '发知乎', text: '写好后用 post_draft 把草稿给老板过目，再发布。' }]);
  const check1 = A.handoffReply([{ name: '文案', title: '对标题', text: '对一遍标题，回读确认没有错别字。' }]);
  check('HAND76-1 the line when work is given out promises a draft only when the brief speaks of one (post_draft, 草稿, 过目, 拍板); a brief that publishes or schedules says the human is asked once; 「回读确认」 alone promises neither',
    /发出去之前会问你一次（你说过「发」就不问）/.test(change) && !/草稿/.test(change) && /发出去之前会先把草稿给你确认/.test(draft) && /中间要你定的事会在这里问你/.test(check1), JSON.stringify({ change, draft, check1 }));
}
