// 1.5.62: five small things the launch-video recording found. The card's 「一起看这 N 条回复」 counts
// itself; the other machines' bots are looked at every few seconds while something there works or waits
// (slow when idle); 设置 → 审批 lists every 「以后都允许」 by assistant with 撤销; the settings home's cost
// says it is this machine's and opens 成本 at just that; a new group's self-introductions are not counted
// as unseen work in the daily note.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A top-level function of a page part, as source (default arguments may hold calls). */
function fnSource(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

export async function fixes1562Checks({ check, readText }) {
  const page = await readText('../public/index.html');
  const cards = await readText('../public/app/main/07b-cards.js');
  const groupsJs = await readText('../public/app/main/03-groups.js');
  const bots = await readText('../public/app/main/04-bots.js');
  const live = await readText('../public/app/main/06-live.js');
  const apps = await readText('../public/app/main/09-apps.js');
  const home = await readText('../public/app/main/08b-settings-home.js');
  const server = await readText('../src/server.mjs');
  const agent = await readText('../src/agent.mjs');

  // --- 1. 「一起看这 N 条回复」 counts the card it is on ------------------------------------------
  const el = (tag, cls, text) => ({ tag, cls, textContent: text, addEventListener() {} });
  const hint = (waiting) => new Function('el', 'waitingReplies', 'isReplyDraft', 'openInbox', `${fnSource(cards, 'replyGroupHint')}; return replyGroupHint;`)(el, () => waiting, (d) => Boolean(d), () => {});
  const draft = { channel: '邮件' };
  const notYet = hint([{ id: 'a' }, { id: 'b' }])({ approvalId: 'c', draft });   // three waiting, this card not in the list yet
  const inList = hint([{ id: 'a' }, { id: 'b' }, { id: 'c' }])({ approvalId: 'c', draft });
  const alone = hint([])({ approvalId: 'c', draft });
  const oneOther = hint([{ id: 'a', machine: '书房电脑' }])({ approvalId: 'c', draft });
  check('FIX1 a reply card\'s 「一起看这 N 条回复」 counts the card itself, also when it is drawn before it reaches the list (three waiting said 「2 条」); one card alone shows no link',
    notYet?.textContent === '一起看这 3 条回复' && inList?.textContent === '一起看这 3 条回复' && alone === null && oneOther?.textContent === '一起看这 2 条回复',
    JSON.stringify([notYet?.textContent, inList?.textContent, alone, oneOther?.textContent]));

  // --- 2. the other machines: often while something there works or waits, slowly when idle ----------
  const { createRoster, rosterBusy, ROSTER_KEEP_MS, ROSTER_QUICK_MS } = await import('../src/roster.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-pace-'));
  const realNow = Date.now;
  let asks = 0;
  let busy = false;
  const fakePeers = {
    list: () => [{ name: '书房电脑' }],
    find: (name) => ({ name }),
    json: async (_peer, _method, p) => {
      if (p === '/api/bots') { asks += 1; return [{ id: 'b1', name: '剪辑' }]; }
      if (p === '/api/attention') return { items: busy ? { 'bot:b1': { working: true } } : {} };
      return [];
    },
    way: () => null,
  };
  let paced = {};
  try {
    let t = realNow();
    Date.now = () => t;
    const rs = createRoster({ peers: fakePeers, cacheFile: path.join(tmp, 'roster.json'), outboxFile: path.join(tmp, 'outbox.json') });
    await rs.list(); // asked (1)
    t += 4000; await rs.list(); // idle: kept 15 s, not asked
    const idle = asks;
    await rs.list({ quick: true }); // the page says something may start: asked (2)
    const quick = asks;
    busy = true;
    t += 1000; await rs.list({ fresh: true }); // now working there (3)
    t += 3500; await rs.list(); // busy: kept 3 s only, asked (4)
    const whileBusy = asks;
    paced = { idle, quick, whileBusy };
  } finally {
    Date.now = realNow;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The page's pace.
  const pace = (st, pokedAt = 0, now = 100000) => new Function('state', 'Date', `const rosterPace = { pokedAt: ${pokedAt} }; ${fnSource(groupsJs, 'rosterBusyHere')}; ${fnSource(groupsJs, 'rosterFast')}; return rosterFast();`)(st, { now: () => now });
  const one = [{ machine: '书房电脑', online: true }];
  const fastWorking = pace({ peerRoster: one, peerAttention: { 'bot:b1@书房电脑': { working: true } } });
  const fastWaiting = pace({ peerRoster: one, peerAttention: { 'bot:b1@书房电脑': { needsYou: true } } });
  const slowIdle = pace({ peerRoster: one, peerAttention: { 'bot:b1@书房电脑': { unread: true } } });
  const fastPoked = pace({ peerRoster: one, peerAttention: {} }, 100000 - 30000);
  const slowLater = pace({ peerRoster: one, peerAttention: {} }, 100000 - 70000);
  const slowAlone = pace({ peerRoster: [], peerAttention: {} }, 100000 - 1000);
  check('FIX2 the other machines\' bots: looked at every 4 s while something there works or waits, or for a minute after the human sent something; every 20 s when idle, none while hidden; the hub keeps their answer 3 s then (15 s otherwise)',
    JSON.stringify(paced) === JSON.stringify({ idle: 1, quick: 2, whileBusy: 4 }) && ROSTER_KEEP_MS === 15000 && ROSTER_QUICK_MS === 3000
    && rosterBusy({ online: true, attention: { k: { asking: { count: 1 } } } }) && !rosterBusy({ online: false, attention: { k: { working: true } } }) && !rosterBusy({ online: true, attention: { k: { unread: true } } })
    && fastWorking && fastWaiting && !slowIdle && fastPoked && !slowLater && !slowAlone
    && groupsJs.includes('const ROSTER_FAST_MS = 4000;') && groupsJs.includes('const ROSTER_SLOW_MS = 20000;')
    && groupsJs.includes('function scheduleRoster(ms = document.hidden || !rosterFast() ? ROSTER_SLOW_MS : ROSTER_FAST_MS) {') && groupsJs.includes("if (!document.hidden) await loadRoster({ quick: rosterFast() }).catch(() => {});")
    && groupsJs.includes("fresh ? '?fresh=1' : quick ? '?quick=1' : ''") && !bots.includes('setInterval(whenVisible(loadRoster), 20000)') && bots.includes('loadRoster().finally(() => scheduleRoster());')
    && live.includes('pokeRoster(); // what this starts may run on another machine') && server.includes("quick: query.get('quick') === '1'"),
    JSON.stringify({ paced, fastWorking, fastWaiting, slowIdle, fastPoked, slowLater, slowAlone }));

  // --- 3. 设置 → 审批 lists every 「以后都允许」, by assistant, with the same 撤销 ---------------------
  const calls = [];
  const st = { bots: [{ id: 'w', name: '周报', policy: { level: 'x', allowed: [{ key: 'send_email', label: '发邮件' }, { key: 'shell:git', label: '运行 git' }], phoneGrants: [{ app: '微信', kind: 'send' }] } }] };
  // botApiUrl (1.5.63): the address of a bot's settings, here or passed on to its machine.
  const R = new Function('state', 'api', 'botApiUrl', `${fnSource(bots, 'rememberedOf')}; ${fnSource(bots, 'revokeRemembered')}; return { rememberedOf, revokeRemembered };`)(st, async (url, opts) => { calls.push([url, opts]); return null; }, (id) => `/api/bots/${encodeURIComponent(id)}`);
  const before = R.rememberedOf(st.bots[0]);
  const after = await R.revokeRemembered(st.bots[0], { key: 'send_email' });
  const afterGrant = await R.revokeRemembered(after, { grant: { app: '微信', kind: 'send' } });
  const sec = (id) => (page.match(new RegExp(`<section class="dsec" id="${id}">[\\s\\S]*?</section>`)) || [''])[0];
  check('FIX3 设置 → 审批 lists every 「以后都允许」 of this machine\'s assistants by assistant, each with 撤销 - the same PATCH of the bot\'s policy as its own page (rules are made and enforced as before); revoking keeps the other rules and settings',
    before.allowed.length === 2 && before.grants.length === 1
    && calls.length === 2 && calls[0][0] === '/api/bots/w' && calls[0][1].method === 'PATCH'
    && JSON.stringify(calls[0][1].body.policy) === JSON.stringify({ level: 'x', allowed: [{ key: 'shell:git', label: '运行 git' }], phoneGrants: [{ app: '微信', kind: 'send' }] })
    && JSON.stringify(calls[1][1].body.policy.phoneGrants) === '[]' && afterGrant.policy.allowed.length === 1 && st.bots[0].policy.phoneGrants.length === 0
    && sec('sec-run').includes('<div class="remembered-all" id="remembered-all"></div>') && sec('sec-run').includes('>以后都允许的</div>')
    && bots.includes("for (const bot of (state.bots || []).filter((b) => !isRemoteId(b.id))) {") && bots.includes("group.appendChild(el('div', 'be-allowed-title', bot.name));")
    && bots.includes("renderRememberedAll(); // 设置 → 审批 shows the same") && apps.includes('renderRememberedAll(); // 「以后都允许的」')
    && bots.includes("for (const item of allowed) box.appendChild(rememberedLine(bot, item.label || item.key, { key: item.key }, renderAllowed));"),
    JSON.stringify(calls.map((c) => c[1].body.policy)));

  // --- 4. the settings home's cost: this machine's, and it opens 成本 at just that --------------------
  const went = [];
  const st4 = { usageScope: 'all', usageDays: 7 };
  new Function('state', '$', 'setSettingsNav', 'loadUsage', `${fnSource(home, 'openUsageHere')}; return openUsageHere;`)(st4, () => null, (id) => went.push(id), (d) => { went.push(`load:${d}`); return Promise.resolve(); })();
  check('FIX4 the settings home\'s cost says it is this computer\'s (「这台电脑最近 30 天」, 「这台 30 天 ¥…」) and opens 成本 at this machine and 30 days, so the two numbers match (it opened on all machines and 7 days)',
    st4.usageScope === 'here' && st4.usageDays === 30 && JSON.stringify(went) === JSON.stringify(['sec-usage', 'load:30'])
    && home.includes("spent.appendChild(el('span', null, '这台电脑最近 30 天'));") && home.includes('spent.addEventListener(\'click\', openUsageHere);')
    && home.includes('return u ? { text: `这台 30 天 ${moneyWords(u)}` } : null;') && home.includes("target === 'sec-usage' ? openUsageHere : () => setSettingsNav(target)")
    && home.includes("api('/api/usage?days=30')"),
    JSON.stringify({ st4, went }));

  // --- 5. a new group's self-introductions are not unseen work in the daily note -----------------------
  const { createAttention } = await import('../src/attention.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-intro-'));
  let intro = {};
  try {
    let onEvent = null;
    const bus = { emit() {}, subscribe(fn) { onEvent = fn; } };
    const att = createAttention({ file: path.join(dir, 'attention.json'), bus });
    await att.load();
    const ts = (s) => new Date(Date.now() + s * 1000).toISOString();
    // A member introduces itself in a new group: its turn lands in its own chat (bot:m1).
    onEvent({ type: 'turn.start', botId: 'm1', turnId: 'k1', kickoff: true, text: '介绍一下' });
    onEvent({ type: 'turn.end', botId: 'm1', turnId: 'k1', kickoff: true, status: 'success', ts: ts(1) });
    onEvent({ type: 'turn.start', botId: 'm2', turnId: 'w1', text: '写周报' });
    onEvent({ type: 'turn.end', botId: 'm2', turnId: 'w1', status: 'success', ts: ts(2) });
    const first = att.snapshot().items;
    // Real work later in m1's chat: counted again.
    onEvent({ type: 'turn.start', botId: 'm1', turnId: 'w2', text: '剪个视频' });
    onEvent({ type: 'turn.end', botId: 'm1', turnId: 'w2', status: 'success', ts: ts(3) });
    const later = att.snapshot().items['bot:m1'];
    await new Promise((r) => setTimeout(r, 400)); // saved after 300 ms
    const again = createAttention({ file: path.join(dir, 'attention.json'), bus: { emit() {}, subscribe() {} } });
    await again.load();
    intro = { m1: first['bot:m1'], m2: first['bot:m2'], later, reloaded: again.snapshot().items['bot:m1'] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check('FIX5 a new group\'s self-introductions are not 「做完了你还没看」 in the daily note (a new machine\'s first note counted them): the turn says it is one, attention marks that result, the note skips it here and on the other machines; real work after it counts again; the sidebar still marks the chat',
    intro.m1?.unread === true && intro.m1?.intro === true && intro.m2?.unread === true && !intro.m2?.intro && intro.later?.unread === true && !intro.later?.intro && !intro.reloaded?.intro
    && agent.includes('...(kickoff ? { kickoff: true } : {}),')
    && (server.match(/if \(!item\.unread \|\| item\.working \|\| item\.needsYou \|\| item\.intro\) continue;/g) || []).length === 2,
    JSON.stringify(intro));
}
