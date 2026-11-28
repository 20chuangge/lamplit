// 1.5.79: from the fifth post (11-28, 16:34), which did not go smoothly, and what the human said after it.
//   1. 选题 asked for a takeover in the group; the card's button opened the coordinator's screen, and asked
//      「接管…的屏幕？」 again although the bot was waiting for exactly that;
//   2. typing a search word in 小红书 on the phone asked the human as if it were a message, and the bot then
//      cleared the search history - a delete, another card;
//   3. the question the board waited on (「D19 让位还是 D21 挪到 11-30」) stood at the end of three long reports;
//   4. the board had no order: three tasks started at once, two of them before the topic they needed existed;
//   5. a machine short of memory or disk says so - and so does another machine's low balance, on the page
//      that shows every machine (its own events never reached that page).
// Called from smoke.mjs as a stage.
export async function fix1579Checks({ check, readText }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');
  const SV = await import('../src/server.mjs');
  const agent = await readText('../src/agent.mjs');
  const server = await readText('../src/server.mjs');
  const roster = await readText('../src/roster.mjs');
  const chat = await readText('../public/app/main/05-chat.js');
  const settings = await readText('../public/app/main/08-settings.js');
  const machines = await readText('../public/app/main/11-machines.js');
  const live = await readText('../public/app/main/06-live.js');
  const groupsPage = await readText('../public/app/main/03-groups.js');

  check('TAKE79-1 the 「接管屏幕」 button on a member\'s card opens that member\'s screen (in a group the panel is pinned to it first), and does not ask 「接管…的屏幕？」 again - the bot asked for it; opening another machine\'s screen by hand still asks',
    chat.includes("popupTakeover(item.from || '', true)") && settings.includes('async function popupTakeover(botId = \'\', asked = false) {')
    && settings.includes('state.pcPinned = botId;') && settings.includes('await openDesktopViewer({ asked });')
    && machines.includes('async function openDesktopViewer({ asked = false } = {}) {') && machines.includes('if (far && !asked && !(await askConfirm('));

  // --- the search box -----------------------------------------------------------------------------------
  const box = { editable: true, focused: true, id: 'com.x:id/edit', text: '让AI动手', desc: '', bounds: [120, 80, 900, 160], x: 510, y: 120 };
  const row = (text, y = 120, extra = {}) => ({ text, desc: '', id: '', x: 980, y, bounds: [940, y - 30, 1040, y + 30], clickable: true, ...extra });
  const named = { ...box, id: 'com.x:id/search_edit' };
  check('SEARCH79-1 enter in a box that names itself a search is a search; a box that says nothing is one when a 「搜索」 button stands in its row - not when 「发送」 does, not when 「搜索」 is elsewhere on the screen, and not without a box',
    P.isSearchBox(named, []) === true && P.isSearchBox(box, [row('搜索')]) === true && P.isSearchBox(box, [row('取消'), row('搜索')]) === true
    && P.isSearchBox(box, [row('搜索'), row('发送')]) === false && P.isSearchBox(box, [row('搜索', 900)]) === false && P.isSearchBox(box, []) === false
    && P.isSearchBox(null, [row('搜索')]) === false && P.isSearchBox({ ...box, bounds: undefined }, [row('搜索')]) === false,
    JSON.stringify([P.isSearchBox(box, [row('搜索')]), P.isSearchBox(box, [row('搜索'), row('发送')]), P.isSearchBox(box, [row('搜索', 900)])]));
  check('SEARCH79-2 the phone tool asks the screen (not only the box) whether enter is a search, and a bot with the phone is told to leave it as it found it: no clearing of search history, lists, caches or drafts unless asked',
    (await readText('../src/phone.mjs')).includes('search: isSearchBox(box, ui.nodes)') && /do not clear search history, recent lists, caches, notifications or drafts/.test(agent));

  // --- the board asks once ------------------------------------------------------------------------------
  const names = new Map([['copy', '文案'], ['topic', '选题']]);
  const one = A.boardAskLine([{ status: 'done' }, { status: 'waiting_human', owner: 'copy', question: '11-29 20:00 被 D19 占着：\nD19 让位，还是 D21 挪到 11-30？' }], names);
  const two = A.boardAskLine([{ status: 'waiting_human', owner: 'copy', question: '用哪个标题？' }, { status: 'waiting_human', owner: 'topic', question: '要不要加数据？' }], names);
  const card = A.boardAskLine([{ status: 'waiting_human', owner: 'topic', question: '需要你接管屏幕登录', takeover: 'takeover' }], names);
  check('ASKONCE79-1 a board that stops on a question for the human says it once, on its own line, under the coordinator\'s name: who asks and what (one question, or a numbered list); a wait that has its own card (a login, a takeover) is not repeated; the same line is not said twice',
    /^现在卡在一件要你定的事上（文案问的）：11-29 20:00 被 D19 占着： D19 让位，还是 D21 挪到 11-30？\n你回一句，我们就接着做。$/.test(one)
    && /^现在卡在 2 件要你定的事上/.test(two) && /1\. 文案问：用哪个标题？\n2\. 选题问：要不要加数据？$/.test(two) && card === '' && A.boardAskLine([], names) === ''
    && agent.includes('if (line && plan.askedLine !== line) {') && agent.includes("await this.recordGroupMessage(group.id, { kind: 'assistant', from: plan.coordinatorId, text: line })"),
    JSON.stringify({ one, two, card }));

  // --- a board with no order ----------------------------------------------------------------------------
  const t = (needs) => ({ title: 'x', owner: 'a', brief: 'b', ...(needs ? { needs } : {}) });
  check('ORDER79-1 a board of several tasks where none needs another is sent back once with why (they would all start at the same moment); with an order, with independent: true, or with a single task it goes through; the planning tool says a task that uses another\'s work must list it',
    A.noOrderAtAll({ tasks: [t(), t(), t()] }) === true && A.noOrderAtAll({ tasks: [t(), t([1])] }) === false && A.noOrderAtAll({ tasks: [t(), t()], independent: true }) === false
    && A.noOrderAtAll({ tasks: [t()] }) === false && A.noOrderAtAll({}) === false
    && agent.includes("result = { error: { code: 'NO_ORDER',") && agent.includes('!(this.orderAsked ||= new Set()).has(turnId)') && /MUST list it here, or both start at once/.test(agent) && agent.includes('independent: { type: \'boolean\''));

  // --- room on the machine, and notices across machines -------------------------------------------------
  const ok = SV.lowResourceText({ memFreeMB: 4000, memTotalMB: 16000, diskFreeGB: 80, diskTotalGB: 500 }, false);
  const mem1 = SV.lowResourceText({ memFreeMB: 200, memTotalMB: 16000, diskFreeGB: 80, diskTotalGB: 500 }, false);
  const mem2 = SV.lowResourceText({ memFreeMB: 200, memTotalMB: 16000, diskFreeGB: 80, diskTotalGB: 500 }, mem1.memLow);
  const disk = SV.lowResourceText({ memFreeMB: 4000, memTotalMB: 16000, diskFreeGB: 1.2, diskTotalGB: 40 }, false);
  const pct = SV.lowResourceText({ memFreeMB: 4000, memTotalMB: 16000, diskFreeGB: 10, diskTotalGB: 500 }, false);
  const none = SV.lowResourceText({ memFreeMB: 4000, memTotalMB: 16000 }, false);
  check('ROOM79-1 a machine says when it runs out of room: memory low on two readings in a row (one busy moment is not a shortage), the disk under 2 GB or under 3 %; with room left, or without a disk reading, it says nothing',
    ok.text === '' && mem1.text === '' && mem1.memLow === true && /内存快用完了（剩 200 MB）/.test(mem2.text) && /磁盘快满了（剩 1\.2 GB）/.test(disk.text) && /磁盘快满了（剩 10\.0 GB）/.test(pct.text) && none.text === ''
    && /机器人会变慢甚至做到一半停下/.test(mem2.text),
    JSON.stringify({ mem1, mem2, disk, pct }));
  check('ROOM79-2 the reading is taken every 5 minutes and told once (the page, the activity list); every machine\'s own warnings - no room, a low balance - travel with the roster to the page that shows all machines, which says each once with the machine\'s name',
    server.includes("onLow: (text) => { bus.emit({ type: 'machine.low', text });") && server.includes('setInterval(() => state.resourceWatch.check().catch(() => {}), 5 * 60 * 1000).unref();')
    && server.includes('notices: state.machineNotices?.() || []') && server.includes('[state.balanceWatch?.low, state.resourceWatch?.low].filter(Boolean)')
    && roster.includes('const notices = (Array.isArray(att?.notices) ? att.notices : []).slice(0, 4)') && roster.includes('...(row.notices?.length ? { notices: row.notices } : {})')
    && live.includes('function showMachineNotices(machines) {') && live.includes("toast(`「${m.machine}」${text}`, true);") && live.includes("if (ev.type === 'machine.low') {")
    && groupsPage.includes('showMachineNotices(state.peerRoster);'));

  // --- one missed answer is not "off" -------------------------------------------------------------------
  // The human, 11-28: 「执行任务时，有时云服务器上的 bot 会连接不上，不过很快就会自己恢复」. A machine at work is asked
  // every 3 s and given 5 s; one slow answer marked it off and wiped its bots' status until the next ask.
  const RO = await import('../src/roster.mjs');
  const good = { online: true, okAt: 1000, at: 1000, bots: [{ id: 'b' }], attention: { 'bot:b@far': { working: true } } };
  const miss1 = RO.rowAfterMiss(good, 4000);
  const miss2 = RO.rowAfterMiss(miss1, 9000);
  const gone = RO.rowAfterMiss(miss2, 1000 + RO.ROSTER_GRACE_MS + 1);
  check('GRACE79-1 another machine that misses an answer stays as it was last seen - online, its bots and what they are doing - until the misses span 25 s; then it is off, as before; a machine never seen, already off, or refusing the connection (not just slow) gets no grace; a miss and a slow answer are written to the log',
    miss1?.online === true && miss1.misses === 1 && miss1.at === 4000 && miss1.attention['bot:b@far'].working === true && miss2?.misses === 2 && gone === null
    && RO.rowAfterMiss(null, 4000) === null && RO.rowAfterMiss({ online: false, okAt: 1000 }, 4000) === null && RO.rowAfterMiss({ online: true }, 4000) === null && RO.ROSTER_GRACE_MS === 25000
    && roster.includes('if (kept) { live.set(name, kept); return kept; }') && roster.includes('const kept = slow ? rowAfterMiss(live.get(name)) : null;') && roster.includes('okAt: now, notices }') && roster.includes('did not answer (') && roster.includes('answered in ${ms} ms'),
    JSON.stringify({ miss1: miss1 && { online: miss1.online, misses: miss1.misses }, gone }));

  // --- bot_pass from the coordinator reports in the group ----------------------------------------------
  const tools = await readText('../src/tools.mjs');
  check('PASS79-1 the coordinator of a group passing work on with bot_pass in its own group turn lets go the same way as with bot_message: the member works with the group around it and its words are the group\'s message; bot_pass anywhere else (a pipeline between two bots) stays as it was',
    tools.includes("runtime.letGo({ ctx, target, text: String(args?.text || ''), turnId: board.turnId, chain: [ctx.bot.id], budget: ctx.handoffBudget || { left: MAX_HANDOFFS } });")
    && tools.includes('reports in the group under its own name when done') && tools.split("ctx.group && ctx.groupTurn && ctx.group.coordinatorId === ctx.bot.id && typeof runtime.letGo === 'function'").length === 3
    && tools.includes('passed this to you and is not waiting for your reply'));

  // --- further back in a chat ---------------------------------------------------------------------------
  // The human, 11-28: 「每个群或者 bot 的聊天记录为什么不全呢？…之前的聊天记录都可以留着，翻找都可以找到」. The
  // machine kept every line; the page asked for the last 200 and nothing led further back.
  const W = await import('../src/chatwindow.mjs');
  const lines = Array.from({ length: 700 }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `m${i + 1}` }));
  const index = await readText('../public/index.html');
  check('BACK79-1 a chat opens on its last 200 lines; scrolled to the top a button asks for 300 more of the same list (no gap to stitch), up to 5000, and the machine gives as many as are asked (the cap was 1000); with nothing further back the button goes and says so; the line being read stays where it is',
    W.chatWindow(lines, 200).length === 200 && W.chatWindow(lines, 200)[0].text === 'm501' && W.chatWindow(lines, 500)[0].text === 'm201' && W.chatWindow(lines, 5000).length === 700
    && SV.CHAT_LINES_MAX === 5000 && server.split("Math.min(Number(query.get('limit')) || 200, CHAT_LINES_MAX)").length === 5 && !server.includes("|| 200, 1000)")
    && chat.includes('messages?limit=${chatLimit(`bot:${botId}`)}') && groupsPage.includes('/messages?limit=${chatLimit(cacheKey)}')
    && live.includes('const CHAT_LINES_STEP = 300;') && live.includes('const CHAT_LINES_CAP = 5000;') && live.includes("if (shownCount() <= had) { earlierDone.add(key); toast('没有更早的消息了'); }")
    && live.includes('const fromEnd = at >= 0 ? was.length - at : 0;') && live.includes("messagesEl.addEventListener('scroll', syncEarlierButton, { passive: true });")
    && index.includes('<button class="earlier-btn" id="earlier-btn" type="button" hidden>加载更早的消息</button>') && (await readText('../public/app/style.css')).includes('.earlier-btn[hidden] { display: none; }'));
}
