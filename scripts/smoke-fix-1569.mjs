// 1.5.69: from the first day on 1.5.68 (11-25).
//   1. 「让机器人用这部手机」 went off four times in ten minutes on an OPPO: the system took the service out of the
//      enabled list while Lamplit ran, the service was told (onUnbind), took it for the human's wish and never
//      turned it back on. Only with the system's settings in front is it the human's hand.
//   2. 「发」 said to the coordinator (or in the group) did not count for 发布, whose tap on 「发布」 asked again.
//   3. This computer reached the cloud only through the relay, yet waited 7 s on two dead addresses every time.
//   4. A group showed nothing while its members worked in their own chats.
//   5. With the home computer off, the phone app had no 「全部机器」.
//   6. A page named before it was made stayed 「哪台机器上都找不到」.
// Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function fix1569Checks({ check, toolsMod, readText }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');
  const S = await import('../src/server.mjs');

  // --- 1. the phone's switch ---------------------------------------------------------------------------
  const svc = await readText('../mobile/android/app/src/main/java/com/desk/assistant/PhoneAgentService.java');
  const unbind = svc.slice(svc.indexOf('public boolean onUnbind'), svc.indexOf('static volatile String frontPackage'));
  check('KEEP69-1 the phone service going off is the human\'s wish only with the system\'s settings in front; otherwise (a cleaner, the system) the wish stays and it is turned back on in a moment',
    unbind.includes('if (isSettingsApp(frontPackage)) {\n            AgentKeeper.setWanted(this, false);'.replace(/\n/g, svc.includes('\r\n') ? '\r\n' : '\n'))
    && unbind.includes('postDelayed(() -> AgentKeeper.ensure(app), 2500)') && (unbind.match(/setWanted\(this, false\)/g) || []).length === 1
    && svc.includes('event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED') && svc.includes('p.equals("com.android.settings") || p.endsWith(".settings")')
    && svc.includes('void stopByHuman() {'));

  // --- 2. 「发」 for the bots that share a group -----------------------------------------------------------
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-fix69-'));
  try {
    const mk = (id, name) => ({ id, name, role: name, persona: `WHO:${id}`, tools: ['phone'], skills: [], policy: {} });
    const bots = new Map([['lead', mk('lead', '主理人')], ['pub', mk('pub', '发布')], ['solo', mk('solo', '路人')]]);
    const tapped = [];
    const phoneStub = {
      name: 'phone', risk: () => ({ risk: 'MEDIUM' }),
      escalate: async (args) => ({ risk: 'HIGH', alwaysAsk: true, app: { pkg: 'com.xingin.xhs', label: '小红书' }, phoneKind: P.phoneStepKind(args.what), reason: `在手机的「小红书」上点「${args.what}」` }),
      run: async (args) => { tapped.push(args.what); return { ok: true }; },
    };
    const model = {
      provider: 'fake', model: 'fake',
      complete: async (messages) => {
        const who = /WHO:(\w+)/.exec(String(messages[0]?.content || ''))?.[1];
        const n = messages.filter((m) => m.role === 'tool').length;
        if (who !== 'lead' && n === 0) return { content: '', toolCalls: [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name: 'phone', arguments: { action: 'tap', what: '发布' } }] };
        return { content: '好。', toolCalls: [] };
      },
    };
    const cards = [];
    let rtRef = null;
    const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
    const realGet = registry.get.bind(registry);
    registry.get = (name) => (name === 'phone' ? { ...(realGet(name) || {}), ...phoneStub } : realGet(name));
    const rt = new A.AgentRuntime({
      config: { workspaceDir: ws, policy: {} }, registry, model,
      bots: { getBot: async (id) => bots.get(id) || null, listBots: async () => [...bots.values()] },
      groups: { listGroups: async () => [{ id: 'g1', name: '内容组', coordinatorId: 'lead', members: ['lead', 'pub', 'far@cloud'] }] },
      memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
      approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request(req) { cards.push(req); const p = Promise.resolve({ decision: 'approved', approval: { id: `ap${cards.length}` } }); p.record = { id: `ap${cards.length}` }; return p; } },
      bus: { emit() {} },
    });
    rtRef = rt;
    rt.record = async () => {};
    rt.queueMs = 50;
    await rt.runTurn({ botId: 'pub', text: '老板已回「发」，去提交', source: 'bot', fromBotId: 'lead' });
    const before = cards.length;
    await rt.runTurn({ botId: 'lead', text: '发', source: 'chat' });
    await rt.runTurn({ botId: 'pub', text: '老板已回「发」，去提交', source: 'bot', fromBotId: 'lead' });
    const afterGo = cards.length - before;
    await rt.runTurn({ botId: 'solo', text: '去发一下', source: 'bot', fromBotId: 'lead' });
    const solo = cards.length - before - afterGo;
    await rt.runTurn({ botId: 'lead', text: '等一下，先别发', source: 'chat' });
    await rt.runTurn({ botId: 'pub', text: '接着提交', source: 'bot', fromBotId: 'lead' });
    const afterStop = cards.length - before - afterGo - solo;
    check('GO69-1 「发」 the human said to the coordinator counts for the member that publishes: before it, a bot\'s 「老板已回『发』」 alone still asks (1 card); after it, none; a bot outside the group still asks; 「先别发」 takes it back',
      before === 1 && afterGo === 0 && solo === 1 && afterStop === 1 && tapped.length === 4, JSON.stringify({ before, afterGo, solo, afterStop, tapped }));

    rt.humanGo = new Map();
    rt.noteHumanGo('可以发了', ['a', 'b']);
    const got = Boolean(rt.humanGoFor('a')) && Boolean(rt.humanGoFor('b'));
    rt.noteHumanGo('继续', ['a']);
    const kept = Boolean(rt.humanGoFor('a'));
    const late = rt.humanGoFor('a', Date.now() + 3 * 3600 * 1000);
    check('GO69-2 said in a group it counts for the members; a message that is neither go nor stop (「继续」) changes nothing; it lasts two hours',
      got && kept && late === null && A.STOP_GO_WORDS.test('先别发') && !A.STOP_GO_WORDS.test('已经好了')
      && (await readText('../src/agent.mjs')).includes("if (fromHuman && !wasHeld) this.noteHumanGo(text, (group.members || []).filter((m) => !m.remote).map((m) => m.id || m));"));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --- 3. the way that worked last time --------------------------------------------------------------
  const desk = await readText('../desktop/main.mjs');
  check('ROUTE69-1 the desktop app uses the way to a machine that worked last time for 5 minutes (checked that it still answers) before trying the direct addresses again',
    desk.includes('if (kept && kept.base !== url && await probeHub(kept.base)) {')
    && desk.includes('return keepRoute(url, await findRoute(url));') && desk.includes('const ROUTE_KEEP_MS = 5 * 60 * 1000;'));

  // --- 4. who is at work in a group -----------------------------------------------------------------
  const active = new Map([
    ['t1', { botId: 'art', working: true, steps: 12, startedAt: Date.now() - 60000, step: { name: 'image_view' } }],
    ['t2', { botId: 'pub', working: false, steps: 1, startedAt: Date.now() }],
    ['t3', { botId: 'pub', working: true, steps: 5, startedAt: Date.now() - 5000, step: null }],
    ['t4', { botId: 'other', working: true, steps: 9, startedAt: Date.now() }],
  ]);
  const list = S.groupWorking(active, new Set(['art', 'pub', 'idle']), new Map([['art', '美术'], ['pub', '发布']]));
  const page = await readText('../public/index.html');
  const side = await readText('../public/app/main/04b-sidebar.js');
  const srv = await readText('../src/server.mjs');
  check('WORK69-1 a group\'s members at work, wherever the turn runs (a hand-off in the member\'s own chat too): name, the step in words, how many steps; one line per member, others left out',
    list.length === 2 && list[0].name === '美术' && list[0].steps === 12 && list[0].tool === 'image_view' && list[0].since >= 59 && list[1].botId === 'pub' && list[1].steps === 5 && list[1].tool === '',
    JSON.stringify(list));
  check('WORK69-2 the group on screen shows them above the box (avatar, name, step; a tap opens the member\'s chat), asked every few seconds, also for a group on another machine; when someone finishes the messages are read again at once',
    page.includes('<div class="group-working" id="group-working" hidden></div>') && side.includes("remoteGroupApi(gid, '/working')") && side.includes('state.groupWorkingTimer = setInterval(tick, 3000);')
    && side.includes("if (state.groupWorkingIds && state.groupWorkingIds !== ids && !state.liveTurn?.bubble) loadGroupMessages()") && side.includes('chip.addEventListener(\'click\', () => openBotDm(member.id));')
    && (await readText('../public/app/main/03-groups.js')).includes('  watchGroupWorking();') && srv.includes('\\/groups\\/(?<gid>[^/]+)\\/working$/'));

  // --- 5. 全部机器 with home off; 6. a page not made yet -----------------------------------------------
  const launcher = await readText('../mobile/shell/launcher.js');
  check('HOME69-1 the phone app, home computer off: any machine that answers opens in 全部机器 (home stays home)',
    launcher.includes("for (const other of (await readHubs()).filter((h) => h.url !== entry.url)) {") && launcher.includes("if (await enterMachine(other, null, { view: 'all', quiet: true }).catch(() => false)) return true;"));
  const chat = await readText('../public/app/main/05-chat.js');
  check('PAGE69-1 a page named before it was made says so and is looked for again later (not 「哪台机器上都找不到」 for good)',
    chat.includes("'页面 · 现在还找不到，可能还没生成'") && chat.includes('if (!r.machine) setTimeout(() => elsewhere.delete(path), 20000);') && !chat.includes('哪台机器上都找不到'));
}
