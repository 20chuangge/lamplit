// 1.5.61: redesign step 5 and the sidebar the user chose. 「群组」 on top with where its members are;
// bots per machine, pinned on top in the order the human put them and the rest by latest activity, still
// while you look (pins kept on the hub); the first run says hello with two ways on and ends in 「第一件事」;
// a settings home with 4 groups; 连接应用 recommends from your assistants, in plain grey letter blocks;
// the machine menu says how this computer reaches each machine.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

export async function step5Checks({ check, readText }) {
  const page = await readText('../public/index.html');
  const order = await readText('../public/app/main/04c-order.js');
  const groups = await readText('../public/app/main/03-groups.js');
  const bots = await readText('../public/app/main/04-bots.js');
  const home = await readText('../public/app/main/08b-settings-home.js');
  const apps = await readText('../public/app/main/09-apps.js');
  const roster = await readText('../src/roster.mjs');

  // --- groups: their own section on top, with where their members are -----------
  const where = (peerRoster) => new Function('state', `${fnSource(order, 'machineOffline')}; ${fnSource(order, 'groupMachines')}; ${fnSource(order, 'groupWhereLine')}; ${fnSource(order, 'groupOfflineMembers')}; return { groupWhereLine, groupOfflineMembers };`)({ peerRoster });
  const W = where([{ machine: '腾讯云', online: true }, { machine: '书房电脑', online: true }]).groupWhereLine;
  const m = (...ids) => ids.map((id) => ({ id }));
  const local = W(m('a', 'b'), '客厅电脑');
  const cross = W(m('chief', 's1@腾讯云'), '客厅电脑');
  const twoRemote = W(m('p1@腾讯云', 'j1@书房电脑'), '腾讯云'); // a group on 腾讯云 with a member on 书房电脑
  // 书房电脑 off: a member there is marked; the host's own state is the row's (「所在机器离线」), not marked twice.
  const off = where([{ machine: '腾讯云', online: true }, { machine: '书房电脑', online: false }]);
  const memberOff = off.groupWhereLine(m('p1@腾讯云', 'j1@书房电脑'), '腾讯云');
  const hostOff = off.groupWhereLine(m('j1@书房电脑', 'j2@书房电脑'), '书房电脑');
  const away = off.groupOfflineMembers(m('p1@腾讯云', 'j1@书房电脑'), '腾讯云');
  check('G1 a group\'s line says where its members are: on this machine only, across two machines, on two other machines (「2 位成员 · 腾讯云 + 书房电脑」); a member\'s machine that is off says so (「书房电脑（离线）」)',
    local === '2 位成员 · 客厅电脑' && cross === '2 位成员 · 客厅电脑 + 腾讯云' && twoRemote === '2 位成员 · 腾讯云 + 书房电脑'
    && memberOff === '2 位成员 · 腾讯云 + 书房电脑（离线）' && hostOff === '2 位成员 · 书房电脑' && JSON.stringify(away) === '["书房电脑"]'
    && groups.includes('const idle = members.length ? groupWhereLine(members, machineDisplayName())') && groups.includes('const where = members.length ? groupWhereLine(members, m.machine) :'),
    JSON.stringify([local, cross, twoRemote, memberOff, hostOff]));
  check('G3 an open group whose machine is off says so at the top and does not ask for a first message (it says messages wait); one with a member on a machine that is off says which',
    groups.includes("wrap.appendChild(el('h2', null, '所在机器离线'));") && groups.includes('现在发的消息会先存着，连上后再送过去。')
    && groups.includes("$('chat-sub').textContent = hostOff ? `所在机器离线 · ${OFFLINE_WORDS}`") && groups.includes("away.join('、')}离线，那里的成员这会儿用不了")
    && groups.includes("$('chat-sub').classList.toggle('off', hostOff || away.length > 0);"));
  check('G2 「群组」 is its own section on top, every machine\'s groups in it (not under the machine that hosts them); a group whose machine is off fades and says 「所在机器离线」; bots below, this machine first, the others by name, offline ones last',
    groups.includes("const groups = machines.flatMap((m) => m.groups);") && groups.indexOf("el('span', 'rh-name', '群组')") < groups.indexOf("// The bots, per machine: this one first, then by name, offline ones last.")
    && groups.includes("const order = [self, ...others.sort((a, b) => Number(b.online) - Number(a.online) || a.machine.localeCompare(b.machine, 'zh'))];")
    && groups.includes("{ kind: '', text: where ? `所在机器离线 · ${where}` : '所在机器离线' }") && page.includes('.group.remote.off { opacity: 0.55; }')
    && bots.includes('renderRosterSidebar(list, { single: !grouped });'));

  // --- the hybrid order (the user's choice): pinned on top by hand, the rest by latest activity ---
  // The whole part runs here with a stub page around it (no list on screen: nothing to hold).
  let renders = 0;
  let animated = 0;
  let reduce = false;
  const page4c = (ro) => {
    const st = { rosterOrder: ro, activityAt: {} };
    const api = new Function('state', '$', 'api', 'toast', 'renderBots', 'el', 'closeMenus', 'toggleMenu', 'document', 'window', 'requestAnimationFrame', 'CSS',
      `${order.replace(/^'use strict';/, '')}\nreturn { sortSection, rosterFreeze, catchUpOrder, reorderRoster, reducedMotion, noteActivity, isPinnedItem, settled: () => { rosterFirstDrawn = 1; }, opened: () => { rosterFirstDrawn = 0; } };`);
    const P = api(st, () => null, async () => ({}), () => {}, () => { renders += 1; P.sortSection('machine:self', P.items); }, () => ({}), () => {}, () => {},
      { addEventListener() {}, querySelectorAll: () => [] }, { matchMedia: () => ({ matches: reduce }) }, (f) => f(), { escape: (s) => s });
    st.rosterOrder = ro; // after the part has set its default
    P.state = st;
    P.settled(); // long after the page opened (O7 checks the opening)
    return P;
  };
  const ITEMS = [
    { key: 'bot:p', primary: true, createdAt: '2026-01-01', ts: 50 }, { key: 'bot:a', ts: 100 }, { key: 'bot:b', ts: 300 },
    { key: 'bot:c', ts: 10 }, { key: 'bot:d', ts: 200 },
  ];
  const run = (P) => P.sortSection('machine:self', P.items).map((i) => i.key).join(',');
  const A = page4c({ pinned: ['bot:c'], unpinned: [], order: { 'machine:self': ['bot:c', 'bot:p'] } });
  A.items = ITEMS;
  const first = run(A);
  const B = page4c({ pinned: [], unpinned: [], order: {} });
  B.items = ITEMS;
  const plain = run(B);
  const C = page4c({ pinned: [], unpinned: ['bot:p'], order: {} });
  C.items = ITEMS;
  const offPrimary = run(C);
  check('O1 pinned rows stay on top in the order the human put them (here 「c」 dragged above the primary bot); the primary bot is pinned until taken off; the rest by latest activity, newest first',
    first === 'bot:c,bot:p,bot:b,bot:d,bot:a' && plain === 'bot:p,bot:b,bot:d,bot:a,bot:c' && offPrimary === 'bot:b,bot:d,bot:a,bot:p,bot:c',
    JSON.stringify({ first, plain, offPrimary }));
  // Activity: a new card or a finished result moves a chat up, as it happens.
  const D = page4c({ pinned: [], unpinned: [], order: {} });
  D.items = ITEMS;
  run(D);
  D.noteActivity({ 'bot:c': {} }, { 'bot:c': { needsYou: true } });
  renders = 0;
  // Looking at the list: nothing moves.
  D.rosterFreeze.pointer = true;
  const held = run(D);
  const heldAgain = run(D);
  const rendersWhileHeld = renders;
  // The pointer has gone and the 1.5 s are over: one reorder, and only one.
  D.rosterFreeze.pointer = false;
  D.rosterFreeze.until = 0;
  D.catchUpOrder();
  const after = D.rosterFreeze.shown['machine:self'].join(',');
  D.catchUpOrder();
  check('O2 no moving while you look: with the pointer over the list (or a touch, a scroll, a pending click, or within 1.5 s of them) the rows stay where they are; then the list changes once - exactly one reorder - with the chat that has a new card on top of the rest',
    held === 'bot:p,bot:b,bot:d,bot:a,bot:c' && heldAgain === held && rendersWhileHeld === 0 && D.rosterFreeze.waiting === false
    && after === 'bot:p,bot:c,bot:b,bot:d,bot:a' && D.rosterFreeze.reorders === 1 && renders === 1
    && order.includes('const FREEZE_MS = 1500;') && order.includes("list.addEventListener('touchstart', () => { rosterFreeze.touch = true; }") && order.includes("rosterFreeze.pending = true;")
    && order.includes("document.addEventListener('scroll', (e) => {"),
    JSON.stringify({ held, after, reorders: D.rosterFreeze.reorders, renders }));
  reduce = true;
  const E = page4c({ pinned: [], unpinned: [], order: {} });
  check('O3 the one reorder slides each row from where it was (a short move, so nothing jumps); with reduced motion, no slide at all',
    E.reducedMotion() === true && order.includes("if (reducedMotion()) return;") && order.indexOf('if (reducedMotion()) return;') < order.indexOf("row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }]")
    && order.includes("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches"));
  reduce = false;
  // Opening (or reloading) the page: what is unread already is where things stand, not news; and rows that
  // come in over the first moments are drawn where they belong, not held and then moved.
  const G = page4c({ pinned: [], unpinned: [], order: {} });
  G.opened();
  G.items = ITEMS.slice(0, 3);
  const firstDraw = run(G);
  G.noteActivity({}, { 'bot:c': { unread: true } }, 'here'); // the first look at this hub's cards
  G.noteActivity({}, { 'bot:d': { unread: true } }, 'peers'); // and at the other machines'
  G.items = ITEMS; // the other machines' rows arrive
  const settledDraw = run(G);
  const waitedOnOpen = G.rosterFreeze.waiting;
  G.noteActivity({}, { 'bot:c': { needsYou: true } }, 'here'); // later: real news
  G.settled();
  run(G);
  const heldLater = G.rosterFreeze.waiting;
  check('O7 opening the page: unread chats keep their real time order (the first look is not news), rows arriving in the first moments go straight where they belong (no hold, no second move); the pins seen last are kept in the browser so the first draw is already right; later news is held as usual',
    firstDraw === 'bot:p,bot:b,bot:a' && settledDraw === 'bot:p,bot:b,bot:d,bot:a,bot:c' && waitedOnOpen === false && heldLater === true
    && order.includes("const ROSTER_ORDER_CACHE = 'lamplit.rosterOrder';") && order.includes('state.rosterOrder = cachedRosterOrder();')
    && page.includes("noteActivity(prevItems, state.attention?.items, 'here');") && page.includes("noteActivity(prevAttention, state.peerAttention, 'peers');"),
    JSON.stringify({ firstDraw, settledDraw, waitedOnOpen, heldLater }));

  // --- pins, kept on the hub ---------------------------------------------------------
  const RO = await import('../src/rosterorder.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-order-'));
  const file = path.join(dir, 'roster-order.json');
  const saved = await RO.writeOrder({ pinned: ['bot:x', 'not a key', 'group:g@腾讯云', 'bot:x'], unpinned: ['bot:chief'], order: { groups: ['group:g', 'group:g'], 'machine:self': ['bot:a'], evil: ['bot:z'] } }, file);
  const back = await RO.readOrder(file);
  fs.rmSync(dir, { recursive: true, force: true });
  const server = await readText('../src/server.mjs');
  check('O4 pins and their order are kept on the hub (data/roster-order.json, written atomically; the primary bot taken off is 「unpinned」): only known keys and sections, no duplicates; read back the same; every device sees it (GET / PUT /api/roster-order, and a change is announced)',
    JSON.stringify(saved) === JSON.stringify(back) && JSON.stringify(back.pinned) === JSON.stringify(['bot:x', 'group:g@腾讯云']) && JSON.stringify(back.unpinned) === JSON.stringify(['bot:chief'])
    && JSON.stringify(back.order) === JSON.stringify({ groups: ['group:g'], 'machine:self': ['bot:a'] })
    && server.includes("route('GET', /^\\/api\\/roster-order$/, async () => readOrder());") && server.includes("state.bus.emit({ type: 'settings.changed', section: 'roster-order' });")
    && page.includes("if (section === 'roster-order') { loadRosterOrder(); return; }") && order.includes("api('/api/roster-order', { method: 'PUT', body: state.rosterOrder })"),
    JSON.stringify(back));
  check('O5 moving rows: any row drags (a mouse after a few pixels; a finger after holding half a second, holding without moving opens its menu) and lands among the pinned ones - one not pinned is pinned where it is dropped, and says so; Alt+↑ / Alt+↓ or the menu (置顶 / 取消置顶, 上移 / 下移) for a pinned row, a line in the menu of one that is not on why; a drag is not a click; a change made by hand shows at once',
    order.includes("if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;") && order.includes('}, 450);')
    && order.includes("const items = [item(pinned ? '取消置顶' : '置顶', () => togglePin(row))];") && order.includes("items.push(item('上移',")
    && order.includes("items.push(el('div', 'menu-note', '没置顶的按最新动静排；置顶后（或直接拖到上面）就能自己排。'));")
    && order.includes("row.addEventListener('click', (event) => { if (row.dataset.dragged) { event.stopImmediatePropagation(); event.preventDefault(); } }, true);")
    && order.includes('placePinned(row, before);') && order.includes("if (pinnedNow) toast('已置顶，放在这里了');") && !order.includes('if (!pinned) return;') && !order.includes('sameBand')
    && order.includes('rosterFreeze.force = true;')
    && !groups.includes('ts(b) - ts(a)') && !bots.includes('when(b) - when(a)') && page.includes("noteActivity(prevItems, state.attention?.items, 'here');"));
  check('O6 a pinned row shows a small pin you can read (「已置顶」 as its label and tooltip), not a grey dot; a pin change that did not reach the hub says so and is sent again when the hub is back, not overwritten by the hub\'s old copy',
    order.includes("mark.setAttribute('aria-label', '已置顶');") && order.includes("row.querySelector('.bot-name-text')?.after(pinMark());")
    && page.includes('.pin-mark { flex: none;') && !page.includes('.bot.pinned .bot-name-text::after')
    && order.includes('if (rosterOrderUnsaved) { putRosterOrder(); return; }') && order.includes("toast('置顶的顺序还没存上：连上机器后会再存一次。', true)"));

  // --- first run ------------------------------------------------------------------------
  check('F1 first run: the face says hello and offers two ways on - 「先看看演示（不用填任何东西）」 first, 「接上我自己的模型」 - with three promises; then three providers, DeepSeek recommended with why, the rest under 「更多」; the key with where to get it',
    bots.includes("const onboard = { step: 0, provider: '', error: '', busy: false, more: false, justConnected: false, reopened: false };")
    && bots.includes("el('button', 'btn primary onboard-look', '先看看演示（不用填任何东西）')") && bots.includes("el('button', 'btn onboard-mine', '接上我自己的模型')")
    && bots.includes("for (const s of ['要动东西先问你', '数据在你自己电脑上', '随时能停下'])")
    && bots.includes("const ONBOARD_PROVIDERS = ['deepseek', 'moonshot', 'qwen'];") && bots.includes("const ONBOARD_MORE = ['zhipu', 'siliconflow', 'openai'];")
    && bots.includes('去哪拿？去 ${p.label} 拿密钥 ↗'));
  check('F1 connected: four 「第一件事」 to tap, each starts at once, or 「先不用，我自己看看」 - not a sentence sent for you, not an empty box',
    bots.includes("wrap.appendChild(el('h2', null, '接好了。先让我做第一件事？'));") && bots.includes('onboard.justConnected = true;') && !bots.includes('ONBOARD_FIRST')
    && page.includes('if (onboard.justConnected && !remoteChatMachine()) return firstThingsCard();') && bots.includes("el('button', 'btn ghost tiny', '先不用，我自己看看')"));
  const model = await readText('../src/model.mjs');
  check('F2 「接入真实模型」 from the demo opens the first run\'s three brains under the chat (not settings\' list of 21) while no model is connected; the demo\'s answers no longer end with a second 「接入模型后」',
    page.includes("$('mock-banner-btn').addEventListener('click', connectRealModel);") && bots.includes("Object.assign(onboard, { step: 1, error: '', more: false, reopened: true });")
    && bots.includes("if (!state.unconfigured) { openSettings('sec-model'); return; }")
    && page.includes('if (visible.length && onboard.reopened && state.unconfigured && !state.mockAck && !remoteChatMachine()) messagesEl.appendChild(onboardingCard());')
    && model.includes("const DEMO_END = '（这是演示脚本写好的回答。）';"));

  // --- the settings home ------------------------------------------------------------------
  const groupsOf = [...home.matchAll(/^ {2}\['([^']+)', \[/gm)].map((x) => x[1]);
  check('H1 settings opens on a home (on a computer; a phone keeps its list): is all well and what it cost, then 4 groups; each page in plain words, one line on what it is, and its value now (「会改东西就问」, 「1 台离线」 in amber)',
    JSON.stringify(groupsOf) === JSON.stringify(['助手怎么干活', '安全', '连接', '外观和系统'])
    && page.includes('data-set-target="sec-home">设置首页</button>') && page.includes('data-set-target="sec-run">什么时候先问你</button>') && page.includes('data-set-target="sec-bounds">能碰哪些地方</button>')
    && page.includes('data-set-target="sec-audit">做过什么</button>') && page.includes('data-set-target="sec-usage">花了多少钱</button>') && page.includes('<section class="dsec" id="sec-home"></section>')
    && page.includes("const targetId = section || (isMobile() ? 'sec-model' : 'sec-home');") && home.includes("return off ? { text: `${off} 台离线`, warn: true }"), JSON.stringify(groupsOf));
  check('H2 what needs a look is named and opens its page (「还没接模型 →」 to 模型, 「书房电脑关着 →」 to 机器); no public address under the machine\'s name',
    home.includes("issues.push(['还没接模型', 'sec-model']);") && home.includes("issues.push([`${off.join('、')}关着`, 'sec-machines']);") && home.includes("go.addEventListener('click', () => setSettingsNav(target));")
    && page.includes("return '外网'; // a public name or address is not put on screen either") && page.includes('|| /\\.localhost$/.test(h)) return \'这台电脑\';'));

  // --- 连接应用 -------------------------------------------------------------------------------
  const R = new Function('state', 'appIsOn', 'isRemoteId', `const APP_HINTS = ${/const APP_HINTS = (\[[\s\S]*?\n\]);/.exec(apps)?.[1] || '[]'};${fnSource(apps, 'mcpRecommendations')}; return mcpRecommendations;`);
  const catalog = ['feishu', 'email', 'baidu-pan', 'x', 'github'].map((id) => ({ id }));
  const remoteId = (id) => String(id).includes('@');
  const recs = R({ bots: [{ id: 'w', name: '周报', role: '每周写周报' }, { id: 'j', name: '求职助手', role: '看面试邀请' }, { id: 'v@书房电脑', name: '剪辑', role: '' }], peerRoster: [{ bots: [{ id: 'p', name: '发布', role: '发到 X' }] }] }, (a) => a.id === 'email', remoteId)(catalog);
  const recsHere = R({ bots: [{ id: 'v', name: '剪辑', role: '' }] }, () => false, remoteId)(catalog);
  check('A1 连接应用: 「为你推荐」 from this machine\'s assistants (an app connected here does not serve those elsewhere), each with why (「「周报」可以直接发到飞书群」), not the ones connected already; every app a plain grey letter block, one button',
    JSON.stringify(recs.map((r) => `${r.app.id}:${r.why}`)) === JSON.stringify(['feishu:「周报」可以直接发到飞书群'])
    && JSON.stringify(recsHere.map((r) => r.app.id)) === JSON.stringify(['baidu-pan'])
    && apps.includes("head.appendChild(el('b', null, '为你推荐'));") && !apps.includes("badge.style.background = app.color") && page.includes('.mcp-badge, .mcp-badge.has-icon { background: var(--panel-3) !important;'),
    JSON.stringify(recs.map((r) => r.why)));

  // --- the machine menu: how this computer reaches each machine -----------------------------
  // The hub notes the way each answer came (no probe of its own): an address on the LAN, over
  // Tailscale, a public one, or through the relay - directly or not.
  const { createPeers } = await import('../src/peers.mjs');
  const { createRoster } = await import('../src/roster.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-route-'));
  const ok = () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  const ways = {};
  for (const [label, url, extra] of [['lan', 'http://192.168.1.20:14390', {}], ['tailscale', 'http://100.101.102.103:14390', {}], ['public', 'https://lamplit.example.com', {}]]) {
    const ps = createPeers({ file: path.join(tmp, `${label}.json`), fetchImpl: async () => ok() });
    await ps.set([{ name: 'M', url, token: 'token-123456789', ...extra }]);
    await ps.json(ps.find('M'), 'GET', '/api/bots');
    ways[label] = ps.way('M');
  }
  for (const [label, direct] of [['relay', false], ['direct', true]]) {
    const ps = createPeers({ file: path.join(tmp, `${label}.json`), fetchImpl: async () => { throw new Error('down'); }, relayFetchImpl: async () => { const r = ok(); if (direct) Object.defineProperty(r, 'viaDirect', { value: true }); return r; } });
    await ps.set([{ name: 'M', url: 'http://192.168.1.20:14390', relay: { host: 'relay.example.com', port: 7443, id: 'ab12cd34ef56ab12', fp: 'a'.repeat(64) }, token: 'token-123456789' }]);
    await ps.json(ps.find('M'), 'GET', '/api/bots');
    ways[label] = ps.way('M');
  }
  // The roster passes it on with how long the answer took, and when a machine that is off was last seen.
  let up = true;
  const fakePeers = {
    list: () => [{ name: '书房电脑' }],
    find: (name) => ({ name }),
    json: async () => { if (!up) throw new Error('down'); await new Promise((r) => setTimeout(r, 5)); return []; },
    way: () => ({ kind: 'lan', address: '192.168.1.20' }),
  };
  const rs = createRoster({ peers: fakePeers, cacheFile: path.join(tmp, 'roster.json'), outboxFile: path.join(tmp, 'outbox.json') });
  const rOn = (await rs.list({ fresh: true }))[0];
  up = false;
  const rOff = (await rs.list({ fresh: true }))[0];
  fs.rmSync(tmp, { recursive: true, force: true });
  // The page puts it in words.
  const machines = await readText('../public/app/main/11-machines.js');
  const words = (peerRoster) => new Function('state', 'fmtWhen', 'escapeHtml', `${fnSource(machines, 'machineRouteParts')}; ${fnSource(machines, 'routeLineHtml')}; return { machineRouteParts, routeLineHtml };`)({ peerRoster }, () => '3小时前', (s) => s);
  const W2 = words([
    { machine: 'L', online: true, way: { kind: 'lan', address: '192.168.1.20' }, ms: 12 },
    { machine: 'T', online: true, way: { kind: 'tailscale', address: '100.101.102.103' } },
    { machine: 'R', online: true, way: { kind: 'relay' }, ms: 140 },
    { machine: 'D', online: true, way: { kind: 'direct' } },
    { machine: 'O', online: false, seenAt: '2026-11-22T06:00:00Z' },
  ]);
  const lines = ['L', 'T', 'R', 'D', 'O'].map((n) => W2.machineRouteParts(n).join(' · '));
  check('R1 the machine menu says how this computer reaches each machine now - 「局域网 · 192.168.1.20 · 12 ms」, 「Tailscale · 100.x」, 「中转」, 「直连」 - from the way the hub\'s own requests went (no probe of its own), and 「离线 · 上次在线 …」 for one that is off; 「这台电脑」 for this one; not the machine\'s note; the name on a line of its own, never cut short',
    JSON.stringify(ways) === JSON.stringify({ lan: { kind: 'lan', address: '192.168.1.20' }, tailscale: { kind: 'tailscale', address: '100.101.102.103' }, public: { kind: 'public', address: 'lamplit.example.com' }, relay: { kind: 'relay' }, direct: { kind: 'direct' } })
    && rOn.online === true && rOn.way?.kind === 'lan' && rOn.ms >= 1 && rOff.online === false && !rOff.way && !rOff.ms && Boolean(Date.parse(rOff.seenAt))
    && JSON.stringify(lines) === JSON.stringify(['局域网 · 192.168.1.20 · 12 ms', 'Tailscale · 100.101.102.103', '中转 · 140 ms', '直连', '离线 · 上次在线 3小时前'])
    && W2.routeLineHtml(['局域网', '192.168.1.20']) === '<span>局域网</span> · <span>192.168.1.20</span>'
    && machines.includes("const mine = here ? '这台电脑' : selfSub();") && machines.includes("meta: machineOverviewHtml(m.name, { note: false })") && !/machineOverviewHtml\(m\.name\)(?!,)/.test(machines)
    && machines.includes("const parts = machineBridge.local ? machineRouteParts(m.name) : [];")
    && page.includes('#machine-menu .mm-item .mm-sub { flex: 1 0 100%;') && page.includes('#machine-menu .mm-item b { flex: 1 1 auto; min-width: 0; overflow: visible; text-overflow: clip;')
    && groups.includes('const sig = (list) => JSON.stringify((list || []).map(({ ms, ...m }) => m));'),
    JSON.stringify({ ways, on: { way: rOn.way, ms: rOn.ms }, off: { seenAt: rOff.seenAt }, lines }));
}
