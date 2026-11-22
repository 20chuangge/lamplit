// 1.5.59: redesign step 4 - the sidebar and 全部机器. Filters 「N 件等你」 / 「N 个在做」 in place of
// 「最近」, one section per machine with an online dot, a status line from the real state, an offline
// machine faded, each machine in a few words, the header's count for the chat on screen only;
// and 11-machines.js split at its cap (11a-network.js), nothing changed.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

export async function sidebar1559Checks({ check, readText }) {
  const page = await readText('../public/index.html');
  const side = await readText('../public/app/main/04b-sidebar.js');
  const settings = await readText('../public/app/main/08-settings.js');
  const machines = await readText('../public/app/main/11-machines.js');
  const network = await readText('../public/app/main/11a-network.js');
  const PS = await import('./page-source.mjs');

  // --- the split, first and alone ------------------------------------------
  check('S0 11-machines.js split at its cap: 网络诊断, the two relays and 体检 moved to 11a-network.js unchanged, loaded right after it; both well under 2 000 lines',
    PS.MAIN_PARTS.indexOf('app/main/11a-network.js') === PS.MAIN_PARTS.indexOf('app/main/11-machines.js') + 1
    && network.includes('网络诊断 (1.5.28)') && network.includes('国内中转 (1.5.29)') && network.includes('体检 (1.5.30)') && !machines.includes('网络诊断 (1.5.28)')
    && machines.split('\n').length < 1700 && network.split('\n').length < 600 && PS.MAIN_PARTS.includes('app/main/04b-sidebar.js'));

  // --- the filters ------------------------------------------------------------
  const items = { 'bot:a': { needsYou: true, working: true }, 'bot:b': { working: true }, 'bot:c': { asking: { question: '?' } }, 'bot:d': { unread: true }, 'bot:e@云': { working: true } };
  const F = new Function('attentionItem', `${fnSource(side, 'chatWaits')}${fnSource(side, 'chatWorks')}${fnSource(side, 'rosterFilterMatch')}; return { rosterFilterMatch };`)((k) => items[k] || null);
  const keys = Object.keys(items).concat('bot:idle');
  const needs = keys.filter((k) => F.rosterFilterMatch(k, 'needs'));
  const working = keys.filter((k) => F.rosterFilterMatch(k, 'working'));
  check('S1 filters 「N 件等你」 / 「N 个在做」: waiting means a card, a question, a login or a takeover (needs you or asking); working means at work and not waiting; another machine\'s chats count too',
    JSON.stringify(needs) === JSON.stringify(['bot:a', 'bot:c']) && JSON.stringify(working) === JSON.stringify(['bot:b', 'bot:e@云'])
    && side.includes("kind === 'needs' ? `${n} 件等你` : `${n} 个在做`") && side.includes("state.rosterFilter = state.rosterFilter === kind ? '' : kind;"),
    JSON.stringify({ needs, working }));
  check('S1 a filter shows only those rows (with the search on top), hides machines left empty, and clears itself when nothing is left; 「最近」 is gone',
    page.includes("(Boolean(only) && Boolean(row.closest('#bot-list')) && !rosterFilterMatch(rowKey(row), only))")
    && page.includes("sec.hidden = Boolean(q || only) && !sec.querySelector('.bot:not([hidden]), .group:not([hidden])');")
    && side.includes("if ((state.rosterFilter === 'needs' && !needs) || (state.rosterFilter === 'working' && !working)) state.rosterFilter = '';")
    && !page.includes("'roster-sec recent'") && !page.includes('RECENT_FROM') && page.includes('renderRosterFilters(list); filterHome();'));

  // --- the status line ----------------------------------------------------------
  const att = {
    'bot:wait': { needsYou: true, ask: { tool: 'fs_delete' } },
    'bot:work': { working: true, doing: { text: '上传 B 站视频' } },
    'bot:steps': { working: true, doing: { step: '上传 B 站视频', done: 5, total: 8 } },
    'bot:done': { unread: true },
    'bot:fail': { failed: { status: 'failed' } },
  };
  const L = new Function('attentionItem', 'truncate', 'plainPreview', 'TOOL_TEXT', 'mcpToolText', 'toolNameLabel', 'statusWords', 'currentChatKey', 'waitingCardTitle',
    `${fnSource(settings, 'rosterLine')}${fnSource(settings, 'stuckLine')}; return rosterLine;`)(
    (k) => att[k] || null, (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s)), (s) => String(s), { fs_delete: { label: '删除文件' } },
    () => null, (n) => n, (s) => s, () => '', (k) => (k === 'bot:wait' ? '删除「旧报告.docx」' : ''));
  const line = (k, o = {}) => L(k, { idle: '职责：每天筛岗', ...o });
  check('S2 each row\'s line comes from the real state: 「等你点头：删除「旧报告.docx」」 (the card\'s own headline), 「在做：…」 (with n/m of its checklist), 「做完了：…」, 「出错了，没做完」; idle, its job',
    line('bot:wait').text === '等你点头：删除「旧报告.docx」' && line('bot:work').text === '在做：上传 B 站视频'
    && line('bot:steps').text === '上传 B 站视频' && line('bot:steps').tail === '5/8'
    && line('bot:done', { last: '筛好了 12 个' }).text === '做完了：筛好了 12 个' && line('bot:fail').text === '出错了，没做完'
    && line('bot:idle').text === '职责：每天筛岗' && line('bot:idle').kind === ''
    && side.includes("? (state.inbox?.items || []).find((i) => i.machine === far.machine && i.botId === far.botId && i.status !== 'awaiting_human')"),
    JSON.stringify(['bot:wait', 'bot:work', 'bot:done', 'bot:fail'].map((k) => line(k, { last: 'x' }).text)));

  // --- machines -----------------------------------------------------------------
  check('S3 grouped by machine only: each heading has an online dot (green, grey when off); an offline machine\'s whole section fades and its faces close their eyes (step 2)',
    page.includes("const dot = el('i', `rh-dot ${m.online ? 'on' : 'off'}`);") && page.includes('.roster-sec.machine.off .roster-body, .roster-sec.machine.off .rh-name { opacity: 0.55; }')
    && page.includes('.roster-head .rh-dot.off {') && page.includes("lampMarkRow(av, bot, { key: `bot:${id}`, online: m.online });"));
  const O = new Function('rosterChats', 'attentionItem', 'machineNotesUi', 'shortNote', 'escapeHtml',
    `${fnSource(side, 'chatWaits')}${fnSource(side, 'chatWorks')}${fnSource(side, 'machineTally')}${fnSource(side, 'machineOverview')}; return machineOverview;`)(
    () => [{ machine: '客厅电脑', online: true, groups: [], bots: [{ key: 'bot:a' }, { key: 'bot:b' }, { key: 'bot:x' }] }, { machine: '腾讯云', online: false, groups: [], bots: [{ key: 'bot:e@云' }] }],
    (k) => items[k] || null, { notes: { 客厅电脑: { note: '家里一直开着的电脑' } } }, (s) => s, (s) => s);
  const here = O('客厅电脑');
  const far = O('腾讯云');
  check('S4 each machine in a few words (the machine menu): what it is for, how many bots, what waits and works there; an offline machine counts nothing as waiting or working; the way there (局域网 / 直连 / 中转) as before',
    here.note === '家里一直开着的电脑' && here.counts === '3 个助手 · 1 件等你 · 1 个在做' && far.counts === '1 个助手' && far.online === false
    && machines.includes('meta: machineOverviewHtml(m.name), dot: true') && machines.includes('void routeWords(m).then((words) =>'),
    JSON.stringify({ here, far }));

  // --- the header's count ---------------------------------------------------------
  const st = {
    approvals: [{ id: '1', botId: 'a' }, { id: '2', botId: 'b' }, { id: '3', botId: 'c' }],
    inbox: { items: [{ id: '9', botId: 's', machine: '云' }, { id: '8', botId: 't', machine: '云' }] },
    botId: 'a', groupId: null,
  };
  const H = new Function('state', 'isGroupMode', 'groupById', 'groupMembers', 'isRemoteId', `${fnSource(side, 'openChatApprovals')}; return openChatApprovals;`);
  const count = (s) => { const r = H(s, () => Boolean(s.groupId), () => ({ members: ['b', 'c', 's@云'] }), (g) => g.members.map((id) => ({ id })), (id) => String(id).includes('@'))(); return r.local.length + r.remote.length; };
  check('S5 the header\'s 「N 个操作等你确认」 counts the chat on screen only: its bot\'s cards, a group\'s members\' (here and on other machines), a bot on another machine its own - not the whole machine',
    count(st) === 1 && count({ ...st, botId: 'zzz' }) === 0 && count({ ...st, botId: 's@云' }) === 1 && count({ ...st, groupId: 'g' }) === 3
    && page.includes('const { local, remote } = openChatApprovals();') && page.includes("updateApprovalsPill(); // its members' cards only (1.5.59)"),
    JSON.stringify([count(st), count({ ...st, botId: 's@云' }), count({ ...st, groupId: 'g' })]));

  // --- after the beginner test --------------------------------------------------------
  const W = new Function('state', `${fnSource(settings, 'othersWaitingLine')}; return othersWaitingLine;`);
  const others = (items2) => W({ attention: { items: items2 } })('bot:chief');
  check('S6 beginner test: the main assistant\'s line does not say 「其余都在正常跑」 while another got stuck; a filter that is on is filled and ends in ✕ (no hover on a phone); the line has no hint repeating its words',
    others({ 'bot:a': { needsYou: true }, 'bot:b': { failed: { status: 'failed' } }, 'bot:c': { working: true } }) === '1 件事等你，1 个出错了'
    && others({ 'bot:a': { needsYou: true }, 'bot:c': { working: true } }) === '1 件事等你，其余都在正常跑'
    && side.includes("if (on) b.appendChild(el('span', 'rf-clear', '✕'));") && page.includes('.roster-filter.on, .roster-filter.working.on, .roster-filter.needs.on:not(.none) { background: var(--accent-solid);')
    && settings.includes("if (card) return { kind: 'needs', text: `等你点头：${card}` };") && settings.includes("hint: '上一次' }"));
  check('S6 beginner test: what waits may take two lines in the list; the filters stay on top of a phone\'s list; one 「!」 per row; a bot on a machine that is off says so under its name on a phone and on top of its empty chat; the menu greys an offline machine\'s dot and does not say 「连不上」 next to 离线',
    page.includes('.bot-preview.st-needs .bp-text { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2;') && page.includes('.roster-filters { position: sticky; top: 0;')
    && page.includes('.bot:has(.bot-av[data-lamp="wait"]) > .att.needs') && page.includes('.chat-head .sub.off { display: block;')
    && page.includes("card.prepend(el('div', 'status-line link-down-line', `离线 · ${OFFLINE_WORDS}`));") && machines.includes("<i class=\"mm-dot ${off ? 'off' : 'on'}\"></i>")
    && machines.includes("!m.online && words === '连不上' ? '' : words"));
}
