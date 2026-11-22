'use strict';
// Lamplit page, part 3 of 12: groups - the bots on other machines (one roster), sidebar groups, confirm dialog, group transcript, task board, new group. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   groups
   The server may not have /api/groups yet: every call degrades to a quiet
   note instead of an error, and the 1:1 UI keeps working untouched.
   --------------------------------------------------------------------- */
function isGroupMode() {
  return Boolean(state.groupId);
}

function botById(id) {
  // "id@machine": a bot on another machine, from the roster (1.5.42).
  return state.bots.find((b) => b.id === id) || (String(id || '').includes('@') ? remoteBotById(id) : null) || null;
}

function groupById(id) {
  if (String(id || '').includes('@')) return remoteGroupById(id);
  return state.groups.find((g) => g.id === id) || null;
}

/** A member of the open group by id - also one that lives on another machine ("botId@machine"). */
function groupMemberById(id) {
  const group = groupById(state.groupId);
  // In another machine's group a member is "id@machine" here, plain "id" in its events (1.5.43).
  const there = group?.remote ? `${id}@${group.remote.machine}` : '';
  const m = (group?.members || []).find((x) => x && typeof x === 'object' && (x.id === id || (there && x.id === there)));
  return m ? { ...m, name: m.name || id } : null;
}

/** Members arrive as bot-shaped objects, but tolerate a bare id array too. */
function groupMembers(group) {
  if (!group) return [];
  return (group.members || [])
    .map((member) => (typeof member === 'string' ? botById(member) : member))
    .filter(Boolean);
}

/** Coordinator may arrive as `coordinatorId` (string), as a `coordinator`
 *  object, or be implied by member order. All three resolve here. */
function groupCoordinator(group) {
  const members = groupMembers(group);
  if (!members.length) return null;
  const explicit = group.coordinator;
  if (explicit && typeof explicit === 'object') {
    const match = members.find((b) => b.id === explicit.id);
    if (match) return match;
    if (explicit.id) return explicit;
  }
  const id = typeof explicit === 'string' ? explicit : group.coordinatorId;
  return members.find((b) => b.id === id) || members[0];
}

/**
 * A member with its own face (1.5.44 test: members from other machines were
 * default purple in a group's stack): this machine's bot, or the roster's.
 */
function faceOf(b) {
  if (!b || b.avatar) return b;
  const far = remoteOf(b.id);
  const own = far && far.machine === (selfMachineName || '') ? state.bots.find((x) => x.id === far.botId) : null;
  const known = own || botById(b.id);
  return known?.avatar ? { ...b, avatar: known.avatar } : b;
}

function stackOf(bots, size = 30, onPick = null, max = 3) {
  const stack = el('div', 'stack');
  for (const bot of bots.slice(0, max)) {
    const cell = el('div', 'stack-cell');
    const av = avatarNode(faceOf(bot), size);
    if (onPick) {
      av.style.cursor = 'pointer';
      av.title = `${bot.name} 的私聊`;
      av.addEventListener('click', (event) => { event.stopPropagation(); onPick(bot); });
    }
    cell.appendChild(av);
    stack.appendChild(cell);
  }
  if (bots.length > max) {
    const cell = el('div', 'stack-cell');
    cell.appendChild(el('span', 'stack-more', `+${bots.length - max}`));
    stack.appendChild(cell);
  }
  return stack;
}

async function loadGroups() {
  try {
    const groups = await api('/api/groups');
    state.groups = Array.isArray(groups) ? groups : (groups && groups.groups) || [];
    state.groupsSupported = true;
  } catch (err) {
    state.groups = [];
    state.groupsSupported = err.status !== 404;
    if (err.status && err.status !== 404 && err.status !== 401) {
      console.warn('groups unavailable', err.message);
    }
  }
  renderGroups();
  updateNewMenu();
}

function renderGroups() {
  const list = $('group-list');
  if (!list) return;
  list.innerHTML = '';
  $('group-count').textContent = String(state.groups.length);
  $('groups-hint').hidden = state.groupsSupported;
  // Empty sections are noise. With no groups, the "+" menu is the only entry
  // point the sidebar needs; the header comes back as soon as one exists.
  const section = $('groups-section');
  if (section) section.hidden = state.groups.length === 0 && state.groupsSupported;
  // 「全部机器」 (1.5.43): the groups are in their machine's section of the list above.
  if (rosterGrouped()) { if (section) section.hidden = true; list.innerHTML = ''; renderBots(); return; }
  for (const group of state.groups) list.appendChild(groupRow(group));
}

/** One of this machine's groups in the sidebar. */
function groupRow(group) {
  {
    const members = groupMembers(group);
    const row = el('div', `group${group.id === state.groupId ? ' active' : ''}`);
    row.dataset.group = group.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.appendChild(stackOf(members, 30, (bot) => openBotDm(bot.id), 2));

    const text = el('div', 'bot-text');
    const nameRow = el('div', 'bot-name');
    nameRow.appendChild(el('span', 'bot-name-text', group.name || '未命名群组'));
    text.appendChild(nameRow);
    // The same line a bot has (1.5.40); with nothing going on, who is in the group.
    const last = lastLine(group);
    const line = rosterLine(`group:${group.id}`, {
      idle: members.length ? `${members.length} 位成员 · ${members.map((b) => b.name).join('、')}` : (last || '还没有消息'),
      last,
      group: true,
    });
    row.dataset.search = `${group.name || ''} ${members.map((b) => b.name).join(' ')} ${last} ${line.text}`.toLowerCase();
    text.appendChild(rosterLineNode(line));
    row.appendChild(text);
    const groupAtt = attentionBadge(`group:${group.id}`);
    if (groupAtt) row.appendChild(groupAtt);

    // ⋯ / right-click: the same management a bot row has
    const more = el('button', 'bot-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', `管理 ${group.name || '群组'}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'menu bot-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const mkItem = (label, action, extra = '') => {
      const item = el('button', extra, label);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', (event) => { event.stopPropagation(); closeMenus(); action(); });
      return item;
    };
    menu.appendChild(mkItem('编辑群组', () => openGroupModal(group.id)));
    menu.appendChild(el('div', 'menu-sep'));
    menu.appendChild(mkItem('删除', () => deleteGroup(group.id), 'danger'));
    more.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(menu, more); });
    row.appendChild(more);
    row.appendChild(menu);

    row.addEventListener('click', () => openGroup(group.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openGroup(group.id); }
    });
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); toggleMenu(menu, more); });
    return row;
  }
}

function renderGroupHead(group) {
  const members = groupMembers(group);
  const coordinator = groupCoordinator(group);
  $('chat-avatar').hidden = true;
  $('chat-stack').hidden = false;
  const stack = $('chat-stack');
  stack.innerHTML = '';
  for (const bot of members) {
    const cell = el('div', 'stack-cell');
    const av = avatarNode(bot, 30);
    av.title = `${bot.name} · 打开私聊`;
    av.addEventListener('click', (event) => { event.stopPropagation(); openBotDm(bot.id); });
    cell.appendChild(av);
    stack.appendChild(cell);
  }
  $('chat-title').textContent = group.name || '未命名群组';
  $('chat-sub').textContent = coordinator
    ? `${members.length} 位成员 · 协调者 ${coordinator.name}`
    : `${members.length} 位成员`;
  // Members and delete live in the group's details (click the title).
  $('group-members-pill').hidden = true;
  if ($('group-delete-btn')) $('group-delete-btn').hidden = true;
}

function renderBotHead(bot) {
  $('chat-avatar').hidden = false;
  $('chat-stack').hidden = true;
  $('group-members-pill').hidden = true;
  if ($('group-delete-btn')) $('group-delete-btn').hidden = true;
  if (bot) renderChatAvatar(bot);
}

/* ---------------------------------------------------------------------
   destructive confirmation: one small modal, one promise
   --------------------------------------------------------------------- */
let confirmResolve = null;
function askConfirm({ title = '确认删除', text = '', confirmLabel = '删除' } = {}) {
  if (confirmResolve) confirmResolve(false);
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = confirmLabel;
  $('confirm-ok').classList.add('danger');
  $('confirm-input').hidden = true;
  $('confirm-modal').classList.add('open');
  $('confirm-modal').setAttribute('aria-hidden', 'false');
  $('confirm-scrim').classList.add('show');
  return new Promise((resolve) => { confirmResolve = resolve; });
}

/**
 * Ask for one line of text in the same small dialog. The browser prompt does
 * nothing in the desktop app (Electron has no prompt), so this is the one to
 * use. -> the text, or null when cancelled.
 */
async function askText({ title = '', text = '', value = '', placeholder = '', confirmLabel = '确定' } = {}) {
  if (confirmResolve) confirmResolve(false);
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = confirmLabel;
  $('confirm-ok').classList.remove('danger');
  const input = $('confirm-input');
  input.hidden = false;
  input.value = value;
  input.placeholder = placeholder;
  $('confirm-modal').classList.add('open');
  $('confirm-modal').setAttribute('aria-hidden', 'false');
  $('confirm-scrim').classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 50);
  const ok = await new Promise((resolve) => { confirmResolve = resolve; });
  input.hidden = true;
  return ok ? input.value : null;
}

function settleConfirm(value) {
  $('confirm-modal').classList.remove('open');
  $('confirm-modal').setAttribute('aria-hidden', 'true');
  $('confirm-scrim').classList.remove('show');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

function deleteCurrentGroup() {
  return deleteGroup(state.groupId);
}

async function deleteGroup(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  const ok = await askConfirm({
    title: '删除这个群组？',
    text: `「${group.name}」的群聊记录会一起删掉，无法恢复。助手本身和它们的私聊都还在。`,
    confirmLabel: '删除群组',
  });
  if (!ok) return;
  try {
    await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
    closeGroupModal();
    const wasOpen = state.groupId === group.id;
    if (wasOpen) {
      state.groupId = null;
      state.groupMessages = [];
    }
    await loadGroups();
    if (wasOpen) {
      const primary = state.bots.find((b) => b.primary) || state.bots[0];
      if (primary) await selectBot(primary.id);
      renderMessages();
      connectStream();
    }
    toast('群组已删除');
  } catch (err) {
    if (err.status === 401) return;
    toast(err.status === 404 ? '服务端还没有删除群组的接口（404）' : `删除失败：${err.message}`, true);
  }
}

async function openGroup(id) {
  const group = groupById(id);
  if (!group) return;
  if (id !== state.groupId) stopSpeaking();
  state.groupId = id;
  state.pcPinned = null;
  state.pcFollow = null;
  state.liveTurn = null;
  const fromHome = document.body.classList.contains('m-home'); // a back step on a phone (1.5.56)
  closeSidebar();
  closePanel();
  if (fromHome) chatNav.entered();
  renderBots();
  renderGroups();
  renderGroupHead(group);
  updateApprovalsPill(); // its members' cards only (1.5.59)
  updateComposerMode();
  // The group's screen, its members' routines, what it waits on you for.
  followScreen();
  if (state.tab === 'activity') renderRoutines();
  renderDecisionStrip();
  await loadGroupMessages();
  connectStream();
  connectRemoteStream();
  markSeen();
}

function openBotDm(id) {
  if (state.groupId) {
    state.groupId = null;
    state.groupMessages = [];
    renderGroups();
    renderBotHead(botById(id));
  }
  selectBot(id);
}

async function loadGroupMessages() {
  if (!state.groupId) return;
  const groupId = state.groupId;
  // What this browser had for the group, at once (1.5.28); the machine's answer replaces it.
  const cacheKey = `group:${groupId}`;
  const cached = chatCacheGet(cacheKey);
  if (cached) { state.groupMessages = cached; renderMessages(); }
  try {
    const items = await api(isRemoteId(groupId) ? remoteGroupApi(groupId, '/messages?limit=200') : `/api/groups/${encodeURIComponent(groupId)}/messages?limit=200`);
    if (state.groupId !== groupId) return;
    const fresh = Array.isArray(items) ? items : (items && items.messages) || [];
    if (!chatCachePut(cacheKey, fresh) && cached && cached.length === fresh.length) return;
    state.groupMessages = fresh;
  } catch (err) {
    if (err.status === 401) return;
    // Another machine's group that cannot be read now: said in words (1.5.43).
    if (isRemoteId(groupId)) { if (err.code === 'LOCAL_KEY_REQUIRED' && state.groupId === groupId) showPairNeeded(groupId); if (err.code !== 'LOCAL_KEY_REQUIRED' && state.groupId === groupId) { if (!cached) { state.groupMessages = []; renderMessages(); } else appendQueuedMessages(); showRemoteDown(err.status === 404 ? `「${remoteOf(groupId).machine}」上没有这个群了` : LINK_DOWN_WORDS); } return; }
    if (err.status === 404) {
      state.groupMessages = [];
      toast('服务端还没提供群组消息接口（404）', true);
    } else {
      toast(`无法加载群聊：${err.message}`, true);
      return;
    }
  }
  renderMessages();
}

/* ---------------------------------------------------------------------
   group transcript: every bot message says who said it
   --------------------------------------------------------------------- */
function senderOf(item) {
  if (!item) return null;
  if (item.from && item.from !== 'user') {
    const far = groupMemberById(item.from);
    if (far && isRemoteId(state.groupId)) return far; // its own member, not this machine's bot of that id
    // A member deleted since: its name from the history, never its id (1.5.41: 「bot-ioeiz8」).
    return botById(item.from) || far || { id: item.from, name: item.name || (item.from.includes('@') ? item.from : '已删除的助手') };
  }
  if (item.botId) return (isRemoteId(state.groupId) && groupMemberById(item.botId)) || botById(item.botId) || { id: item.botId, name: item.name || '已删除的助手' };
  return null;
}

function groupSenderRow(sender, contentNode) {
  const row = el('div', 'row gbot');
  const av = sender && sender.name ? avatarNode(sender, 26) : null;
  if (av) row.appendChild(av);
  else row.appendChild(el('span', 'av g-empty'));
  const block = el('div', 'g-block');
  block.appendChild(el('div', 'g-name', (sender && sender.name) || '助手'));
  if (contentNode) block.appendChild(contentNode);
  row.appendChild(block);
  return row;
}

function renderGroupMessages() {
  messagesEl.innerHTML = ''; messagesEl.dataset.chat = '';
  const filtered = state.groupMessages.filter(
    (m) => m && m.kind !== 'status' && (state.showProcess || m.kind !== 'tool' || isActionCard(m.name || m.tool)),
  );
  // Same reason as the 1:1 view: one voice should read as one bubble.
  const items = [];
  for (const item of filtered) {
    const prev = items[items.length - 1];
    const sameVoice = prev
      && prev.kind === 'assistant' && item.kind === 'assistant'
      && prev.from === item.from && prev.turnId && prev.turnId === item.turnId;
    if (sameVoice) {
      prev.text = `${prev.text || ''}\n\n${item.text || ''}`.trim();
      prev.ts = item.ts || prev.ts;
      continue;
    }
    items.push({ ...item });
  }
  // A hand-over is done once the one who took it has spoken and is not at it any more.
  const working = Boolean(state.attention?.items?.[`group:${state.groupId}`]?.working);
  items.forEach((item, i) => {
    if (item.kind !== 'handoff') return;
    // A report back to whoever handed the work over closes that hand-over; it has no state of its own.
    const asked = items.slice(0, i).reverse().find((m) => m.kind === 'handoff' && m.from === item.to && m.to === item.from && !m.reported);
    if (asked) { asked.reported = true; asked.handoffState = 'done'; return; }
    item.handoffState = handoffProgress(items.slice(i + 1), {
      working,
      replied: (m) => (m.kind || 'assistant') === 'assistant' && m.from === item.to,
      again: (m) => m.kind === 'handoff' && m.to === item.to,
    });
  });

  if (!items.length) {
    const wrap = el('div', 'empty');
    wrap.appendChild(el('h2', null, '群聊还没开始'));
    wrap.appendChild(el('p', null, '在这里发第一条消息，协调者会分配给合适的成员。'));
    messagesEl.appendChild(wrap);
  } else {
    let lastDay = '';
    for (const item of items) {
      const day = item.ts ? dayKey(item.ts) : '';
      if (day && day !== lastDay) { messagesEl.appendChild(daySeparator(item.ts)); lastDay = day; }
      try {
        messagesEl.appendChild(renderGroupItem(item));
      } catch (err) {
        console.error('group render failed', err);
      }
    }
  }
  appendQueuedMessages(); // another machine's group: what waits for that machine (1.5.43 test)
  updateComposerMode();
  scrollToBottom(true);
}

/* ---------------------------------------------------------------------
   group task board: who does what, live
   --------------------------------------------------------------------- */
const PLAN_STATUS = {
  todo: ['待开始', 'todo'], doing: ['进行中', 'doing'], waiting_human: ['等你回复', 'ask'], done: ['完成', 'done'],
  failed: ['没做成', 'fail'], skipped: ['跳过', 'skip'], stopped: ['已停止', 'skip'],
};
state.plans = state.plans || new Map();

/** The card for a task board; filled from the hub, then kept current by group.plan events. */
function planCard(planId, fallbackText = '') {
  const card = el('div', 'plan-card');
  card.dataset.plan = planId;
  card.appendChild(el('div', 'plan-head', isGroupMode() ? '任务板' : '任务'));
  if (fallbackText) card.appendChild(el('div', 'plan-fallback', fallbackText));
  const known = state.plans.get(planId);
  const url = isGroupMode() && state.groupId ? (isRemoteId(state.groupId) ? remoteGroupApi(state.groupId, `/plans/${encodeURIComponent(planId)}`) : `/api/groups/${encodeURIComponent(state.groupId)}/plans/${encodeURIComponent(planId)}`)
    : state.botId ? (isRemoteId(state.botId) ? remoteApi(state.botId, `/plans/${encodeURIComponent(planId)}`) : `/api/bots/${encodeURIComponent(state.botId)}/plans/${encodeURIComponent(planId)}`) : '';
  if (known) fillPlanCard(card, known);
  else if (url) {
    api(url)
      .then((r) => { if (r?.plan) { state.plans.set(planId, r.plan); fillPlanCard(card, r.plan); } })
      .catch(() => {});
  }
  return card;
}

/** A moved task's progress on the machine it went to: planId -> {at, plan?, failed?} (1.2.168). */
const movedLive = new Map();

function planOverall(plan) {
  return plan.status === 'done' ? '已完成' : plan.status === 'waiting' ? '等你回复' : plan.status === 'stopped' ? '已停止'
    : plan.status === 'stalled' ? '停下了，等你说继续' : plan.status === 'replaced' ? '已换成新计划'
    : plan.status === 'moved' ? (plan.endNote || '已搬到别的机器') : '进行中';
}

/**
 * A task moved to another machine stops here, so its own steps freeze at the
 * moment it left. The card shows the task as it is over there instead,
 * asking that machine (through this one) at most every 30 seconds.
 */
function fillMovedPlanCard(card, plan) {
  const m = plan.movedTo;
  const hit = movedLive.get(plan.id);
  const doneHere = plan.tasks.filter((t) => t.status === 'done').length;
  const foot = el('div', 'plan-moved-foot');
  // Its chat over there opens here (1.5.42): no window switch.
  if (m.botId && m.machine) {
    const go = el('button', 'btn tiny', `打开「${m.machine}」上的对话`);
    go.type = 'button';
    go.addEventListener('click', () => selectBot(`${m.botId}@${m.machine}`));
    foot.appendChild(go);
  }
  if (hit?.plan) {
    const there = hit.plan;
    const done = there.tasks.filter((t) => t.status === 'done').length;
    const now = there.tasks.find((t) => t.status === 'doing');
    const at = now ? `，正在做第 ${there.tasks.indexOf(now) + 1} 步` : '';
    fillPlanCard(card, there, { label: `在「${m.machine}」那边：${done}/${there.tasks.length} · ${planOverall(there)}${at}`, live: there.status === 'running', foot });
  } else {
    const label = hit?.failed ? `搬走时 ${doneHere}/${plan.tasks.length} · 现在连不上「${m.machine}」` : `搬走时 ${doneHere}/${plan.tasks.length} · 正在问「${m.machine}」…`;
    fillPlanCard(card, plan, { label, foot });
  }
  if (hit && Date.now() - hit.at < 30000) return;
  movedLive.set(plan.id, { ...hit, at: Date.now() });
  api(`/api/peers/${encodeURIComponent(plan.movedTo.machine)}/bots/${encodeURIComponent(plan.movedTo.botId)}/plans/${encodeURIComponent(plan.movedTo.planId)}`)
    .then((r) => movedLive.set(plan.id, { at: Date.now(), plan: r?.plan || null, failed: !r?.plan }))
    .catch(() => movedLive.set(plan.id, { at: Date.now(), plan: hit?.plan || null, failed: !hit?.plan }))
    .then(() => { if (card.isConnected) fillMovedPlanCard(card, plan); });
}

/**
 * A group's board in one line (1.5.40): "4 件事：2 件做完，1 件在做，1 件等你".
 * Each count is its own piece, so the English page can say it its own way.
 */
function planSummary(plan) {
  const count = (...states) => plan.tasks.filter((t) => states.includes(t.status)).length;
  const line = el('span', 'plan-sum');
  line.appendChild(el('span', 'plan-sum-total', `${plan.tasks.length} 件事：`));
  const parts = [
    [count('done'), 'done', (n) => `${n} 件做完`], [count('doing'), 'doing', (n) => `${n} 件在做`],
    [count('waiting_human'), 'ask', (n) => `${n} 件等你`], [count('todo'), 'todo', (n) => `${n} 件还没开始`],
    [count('failed'), 'fail', (n) => `${n} 件没做成`], [count('skipped', 'stopped'), 'skip', (n) => `${n} 件跳过`],
  ];
  for (const [n, kind, say] of parts) if (n) line.appendChild(el('span', `plan-sum-part st-${kind}`, say(n)));
  return line;
}

/** Boards the human opened stay open while the page lives (the card is redrawn on every change). */
const planOpened = new Set();

function fillPlanCard(card, plan, view = null) {
  if (!view && plan.status === 'moved' && plan.movedTo?.planId && plan.movedTo?.machine) { fillMovedPlanCard(card, plan); return; }
  card.innerHTML = '';
  const solo = plan.kind === 'task';
  const done = plan.tasks.filter((t) => t.status === 'done').length;
  const bar = el('div', 'plan-bar');
  const fill = el('i');
  fill.style.width = `${plan.tasks.length ? Math.round((done / plan.tasks.length) * 100) : 0}%`;
  bar.appendChild(fill);
  // A group's board is one line until it is opened: who has which task is a click away (1.5.40).
  const fold = solo ? null : el('details', 'plan-fold');
  const host = fold || card;
  if (fold) {
    fold.open = planOpened.has(plan.id);
    fold.addEventListener('toggle', () => { if (fold.open) planOpened.add(plan.id); else planOpened.delete(plan.id); });
    const head = el('summary', 'plan-head');
    head.title = '点开看每一件归谁';
    head.appendChild(el('span', 'plan-title', '任务板'));
    head.appendChild(planSummary(plan));
    fold.appendChild(head);
    fold.appendChild(bar);
    card.appendChild(fold);
  } else {
    const head = el('div', 'plan-head');
    head.appendChild(el('span', 'plan-title', `任务：${plan.goal || ''}`));
    const live = view ? view.live : plan.status === 'running';
    head.appendChild(el('span', `plan-progress${live ? ' live' : ''}`, view?.label || `${done}/${plan.tasks.length} · ${planOverall(plan)}`));
    card.appendChild(head);
    card.appendChild(bar);
  }
  const members = groupMembersForCard();
  plan.tasks.forEach((t, i) => {
    const row = el('details', `plan-task st-${(PLAN_STATUS[t.status] || PLAN_STATUS.todo)[1]}`);
    const sum = el('summary');
    const who = members.get(t.owner);
    if (!solo) sum.appendChild(who ? avatarNode(who, 22) : el('span', 'av g-empty'));
    const text = el('span', 'plan-task-text');
    text.appendChild(el('b', '', `${i + 1}. ${t.title}`));
    if (!solo) text.appendChild(el('small', '', `${who?.name || t.owner}${t.needs?.length ? ` · 等第 ${t.needs.map((n) => n.slice(1)).join('、')} 项` : ''}`));
    sum.appendChild(text);
    sum.appendChild(el('span', 'plan-chip', (PLAN_STATUS[t.status] || PLAN_STATUS.todo)[0]));
    row.appendChild(sum);
    const body = el('div', 'plan-task-body');
    if (t.brief) body.appendChild(el('div', '', t.brief));
    if (t.question) body.appendChild(el('div', 'plan-q', `问你：${t.question}${t.answer ? `\n你答：${t.answer}` : ''}`));
    if (t.result) body.appendChild(el('div', 'plan-result', t.result));
    if (body.childNodes.length) row.appendChild(body);
    host.appendChild(row);
  });
  if (view?.foot?.childNodes.length) card.appendChild(view.foot);
}

/** How a hand-over stands, from what came after it: 'done', 'doing' or '' (not known). */
function handoffProgress(later, { working, replied, again }) {
  return later.some(replied) && (later.some(again) || !working) ? 'done' : working ? 'doing' : '';
}

/**
 * Work one bot passed to another, as one line (1.5.40): "助理 → 小笔：写周报 · 做完了".
 * What was said is a click away: the human reads results, not hand-overs.
 * state: 'done' | 'doing' | '' (not known)
 */
function handoffRow({ sender, target, text, state: progress = '', ts = '' }) {
  const fold = el('details', 'handoff-line');
  const head = el('summary');
  head.title = '点开看原话';
  if (sender?.name) head.appendChild(avatarNode(sender, 18));
  // Each name on its own, so the English page says "Assistant", as everywhere else (1.5.41).
  const who = el('span', 'handoff-who');
  who.appendChild(el('span', null, sender?.name || '助手'));
  who.appendChild(document.createTextNode(' → '));
  who.appendChild(el('span', null, target?.name || ''));
  head.appendChild(who);
  const gist = truncate(plainPreview(String(text || '')), 40);
  if (gist) head.appendChild(el('span', 'handoff-gist no-i18n', `：${gist}`));
  if (progress) head.appendChild(el('span', `handoff-state ${progress}`, progress === 'done' ? '做完了' : '在做'));
  fold.appendChild(head);
  const bubble = el('div', 'bubble');
  fillBubble(bubble, text || '', false, sender?.id, false);
  if (ts) bubble.title = fmtClock(ts);
  fold.appendChild(bubble);
  const row = el('div', 'row handoff');
  row.appendChild(fold);
  return row;
}

/** Group members by id (local bots and the far ones), for avatars and names on the card. */
function groupMembersForCard() {
  const map = new Map();
  for (const b of state.bots || []) map.set(b.id, b);
  const g = (state.groups || []).find((x) => x.id === state.groupId);
  for (const m of g?.members || []) if (!map.has(m.id)) map.set(m.id, m);
  return map;
}

function onPlanEvent(plan) {
  if (!plan?.id) return;
  state.plans.set(plan.id, plan);
  for (const card of document.querySelectorAll(`.plan-card[data-plan="${cssEscape(plan.id)}"]`)) fillPlanCard(card, plan);
}

function renderGroupItem(item) {
  const kind = item.kind || (item.from === 'user' ? 'user' : 'message');
  if (kind === 'user' || item.from === 'user') {
    return userRow({ text: item.text || '', ts: item.ts });
  }
  const sender = senderOf(item);
  if (kind === 'plan' && item.planId) {
    return groupSenderRow(sender, planCard(item.planId, item.text));
  }
  if (kind === 'tool') {
    return groupSenderRow(sender, toolChip({
      name: item.name || item.tool || 'tool',
      args: safeParse(item.args),
      output: item.output ?? item.result,
      risk: item.risk,
      ok: item.ok !== false,
      ts: item.ts,
    }));
  }
  if (kind === 'handoff') {
    // One bot giving another a piece of the work (1.2.164): "数据匠 → 图表师".
    const target = item.to ? (botById(item.to) || groupMemberById(item.to) || { id: item.to, name: item.to }) : null;
    // One line; the words are behind a click (1.5.40; two folded lines since 1.5.28).
    return handoffRow({ sender, target, text: item.text || '', state: item.handoffState || '', ts: item.ts });
  }
  if (kind === 'approval') {
    return groupSenderRow(sender, buildApprovalCard({
      approvalId: item.approvalId || item.id,
      tool: item.tool || item.name,
      risk: item.risk,
      reason: item.reason,
      args: safeParse(item.args),
      decision: item.decision,
      note: item.note,
      ...cardExtras(item),
    }));
  }
  const bubble = el('div', `bubble${item.system ? ' system' : ''}`);
  fillBubble(bubble, item.text || '', item.system, sender?.id);
  return groupSenderRow(sender, bubble);
}

/* ---------------------------------------------------------------------
   create group
   --------------------------------------------------------------------- */
/** New group, or (with an id) the group's details: name, members, coordinator. */
function openGroupModal(groupId = null) {
  // Another machine's group is changed on that machine (1.5.43).
  if (isRemoteId(groupId)) { toast(`这个群在「${remoteOf(groupId).machine}」上：要改名字或成员，在左上角切到那台再改。`); return; }
  closeMenus();
  if (!state.groupsSupported) {
    toast('服务端还没有群组接口（404）', true);
    return;
  }
  const group = groupId ? groupById(groupId) : null;
  // Bots on the human's other machines (they can join; the coordinator stays here).
  state.remoteBots = state.remoteBots || [];
  api('/api/peers/bots').then((r) => {
    state.remoteBots = (r.machines || []).flatMap((m) => (m.bots || []).map((b) => ({ id: `${b.id}@${m.machine}`, name: b.name, role: b.role, machine: m.machine })));
    if ($('group-modal').classList.contains('open')) renderGroupModal();
  }).catch(() => {});
  state.groupDraft = group
    ? {
      id: group.id,
      name: group.name || '',
      members: groupMembers(group).map((b) => b.id),
      coordinatorId: groupCoordinator(group)?.id || null,
    }
    : { name: '', members: [], coordinatorId: null };
  state.groupDraft.machineFilter = 'all';
  state.groupDraft.where = '';
  state.groupDraft.pinned = [...state.groupDraft.members];
  $('group-title').textContent = group ? '群组详情' : '新建群组';
  $('group-create').textContent = group ? '保存' : '创建群组';
  $('group-delete').hidden = !group;
  $('group-name').value = state.groupDraft.name;
  $('group-note').hidden = true;
  // A new group can also be asked for in words (1.5.40): the main assistant makes it.
  const primary = state.bots.find((b) => b.primary);
  // The other machines' bots can be members too (1.5.42 test: 「只有一位」 under a list of them).
  const others = [...state.bots.filter((b) => !b.primary).map((b) => b.name), ...(state.peerRoster || []).flatMap((m) => (m.bots || []).map((b) => `${m.machine}的${b.name}`))];
  const tip = $('group-tip');
  if (tip) {
    tip.hidden = Boolean(group) || !primary;
    // With fewer helpers the example names who there is, not 「某某」 (1.5.40 test).
    tip.textContent = !primary ? ''
      : others.length >= 2 ? `不想自己选？直接对「${primary.name}」说：「拉个群，让${others[0]}和${others[1]}一起做…」，它会替你建好。`
        : others.length === 1 ? `不想自己选？直接对「${primary.name}」说：「拉个群，你和${others[0]}一起做…」，它会替你建好。`
          : `现在只有「${primary.name}」一位助手，群里至少要两位。想要别的帮手，直接对它说「帮我新建一个写文案的助手」，它会替你建好。`;
  }
  renderGroupModal();
  $('group-modal').classList.add('open');
  $('group-modal').setAttribute('aria-hidden', 'false');
  $('group-scrim').classList.add('show');
  if (!isMobile()) setTimeout(() => $('group-name').focus(), 120);
}

function closeGroupModal() {
  $('group-modal').classList.remove('open');
  $('group-modal').setAttribute('aria-hidden', 'true');
  $('group-scrim').classList.remove('show');
}

/** Machines the member list can be narrowed to: this one, and each with bots on offer (1.2.168). */
function renderGroupMachineFilter(farBots) {
  const row = $('group-machine-filter');
  if (!row) return;
  const draft = state.groupDraft;
  const machines = [...new Set(farBots.map((b) => b.machine).filter(Boolean))];
  row.innerHTML = '';
  row.hidden = !machines.length;
  if (!machines.length) { draft.machineFilter = 'all'; return; }
  if (draft.machineFilter !== 'all' && draft.machineFilter !== 'here' && !machines.includes(draft.machineFilter)) draft.machineFilter = 'all';
  const here = onLocalMachine() ? '本机' : machineDisplayName();
  for (const [key, label] of [['all', '全部'], ['here', here], ...machines.map((m) => [m, m])]) {
    const chip = el('button', `coord-chip${(draft.machineFilter || 'all') === key ? ' on' : ''}`, label);
    chip.type = 'button';
    chip.addEventListener('click', () => { state.groupDraft.machineFilter = key; renderGroupModal(); });
    row.appendChild(chip);
  }
}

function renderGroupModal() {
  const draft = state.groupDraft;
  const grid = $('group-member-grid');
  grid.innerHTML = '';
  renderGroupWhere();
  // Members on other machines: already in this group, or offered by the machines reachable now.
  const farKnown = new Map((state.remoteBots || []).map((b) => [b.id, b]));
  for (const m of (groupById(draft.id)?.members || [])) if (m?.machine && !farKnown.has(m.id)) farKnown.set(m.id, m);
  renderGroupMachineFilter([...farKnown.values()]);
  const filter = draft.machineFilter || 'all';
  // Chosen members always show, first (as chosen when the dialog opened, so a
  // card does not jump while you click); the others by the machine picked.
  const shown = (bot) => draft.members.includes(bot.id) || filter === 'all' || (filter === 'here' ? !bot.machine : bot.machine === filter);
  const pinned = new Set(draft.pinned || []);
  // Each with its own face, as in the sidebar (1.5.44 test: all purple squares).
  const face = (b) => { const r = remoteBotById(b.id); return r?.avatar ? { ...b, avatar: r.avatar } : b; };
  const all = [...state.bots.map((b) => ({ ...b, machine: '' })), ...[...farKnown.values()].map(face)];
  const list = [...all.filter((b) => pinned.has(b.id)), ...all.filter((b) => !pinned.has(b.id))].filter(shown);
  for (const bot of list) {
    const on = draft.members.includes(bot.id);
    const card = el('button', `member-card${on ? ' on' : ''}`);
    card.type = 'button';
    card.disabled = !on && draft.members.length >= 6;
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.appendChild(avatarNode(bot, 36));
    const text = el('div', 'mc-text');
    text.appendChild(el('div', 'mc-name', bot.name));
    text.appendChild(el('div', 'mc-role', bot.machine ? `在「${bot.machine}」上${bot.role ? ` · ${bot.role}` : ''}` : (bot.role || '—')));
    card.appendChild(text);
    card.addEventListener('click', () => toggleGroupMember(bot.id));
    grid.appendChild(card);
  }

  $('group-member-count').textContent = `${draft.members.length}/6`;

  const coord = $('group-coord-row');
  coord.innerHTML = '';
  // The coordinator is on the machine the group lives on (1.5.44).
  const chosen = draft.members.filter(onGroupMachine).map((id) => botById(id)).filter(Boolean);
  // Members, but none on the group's machine: say that, not 「先选成员」 (1.5.44).
  if (!chosen.length && !(draft.members.length >= 2)) {
    coord.appendChild(el('span', 'muted tiny', draft.members.length && draft.where ? `至少要有一位「${draft.where}」上的助手来协调。` : '先选成员，再选协调者。'));
  }
  for (const bot of chosen) {
    const chip = el('button', `coord-chip${draft.coordinatorId === bot.id ? ' on' : ''}`);
    chip.type = 'button';
    chip.appendChild(avatarNode(bot, 22));
    chip.appendChild(el('span', null, bot.name));
    chip.addEventListener('click', () => {
      state.groupDraft.coordinatorId = bot.id;
      renderGroupModal();
    });
    coord.appendChild(chip);
  }

  const hasLocal = draft.members.some(onGroupMachine);
  const valid = draft.name.trim().length > 0 && draft.members.length >= 2 && hasLocal;
  if (draft.members.length >= 2 && !hasLocal) coord.appendChild(el('span', 'muted tiny', draft.where ? `至少要有一位「${draft.where}」上的助手来协调。` : '至少要有一位这台机器上的机器人来协调。'));
  $('group-create').disabled = !valid;
  $('group-name').value = draft.name;
}

function toggleGroupMember(botId) {
  const draft = state.groupDraft;
  const index = draft.members.indexOf(botId);
  if (index >= 0) {
    draft.members.splice(index, 1);
    if (draft.coordinatorId === botId) draft.coordinatorId = draft.members.find(onGroupMachine) || null;
  } else {
    if (draft.members.length >= 6) { toast('一个群最多 6 位成员', true); return; }
    draft.members.push(botId);
    if (!draft.coordinatorId && onGroupMachine(botId)) draft.coordinatorId = botId;
  }
  renderGroupModal();
}

async function createGroup() {
  const draft = state.groupDraft;
  const name = draft.name.trim();
  if (!name) { showGroupNote('给这个群起个名字。'); return; }
  if (draft.members.length < 2) { showGroupNote('至少选 2 位成员。'); return; }
  const button = $('group-create');
  button.disabled = true;
  if (draft.id) {
    try {
      await api(`/api/groups/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        body: { name, members: draft.members, coordinatorId: draft.coordinatorId || draft.members.find((id) => !String(id).includes('@')) },
      });
      closeGroupModal();
      await loadGroups();
      if (state.groupId === draft.id) {
        const group = groupById(draft.id);
        if (group) renderGroupHead(group);
      }
      toast('群组已保存');
    } catch (err) {
      if (err.status !== 401) showGroupNote(`保存失败：${err.message}`);
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (draft.where) { await createGroupThere(draft, name, button); return; }
  try {
    const res = await api('/api/groups', {
      method: 'POST',
      body: { name, members: draft.members, coordinatorId: draft.coordinatorId || draft.members.find((id) => !String(id).includes('@')) },
    });
    const group = (res && (res.group || res)) || null;
    closeGroupModal();
    await loadGroups();
    const id = group && group.id;
    if (id) openGroup(id);
    else if (state.groups.length) openGroup(state.groups[state.groups.length - 1].id);
    toast('群组已创建');
  } catch (err) {
    if (err.status === 401) return;
    showGroupNote(err.status === 404
      ? '服务端还没有群组接口（404），眼下的版本还不支持建群。'
      : `创建失败：${err.message}`);
  } finally {
    button.disabled = false;
  }
}

function showGroupNote(text) {
  const note = $('group-note');
  note.hidden = !text;
  note.textContent = text || '';
}

/* ---------------------------------------------------------------------
   one roster (1.5.42 第三步「一个花名册」)
   「全部机器」, the default view: this window stays on this computer and the
   sidebar lists every machine's bots, grouped by machine. A bot on another
   machine is "id@machine" (the name a group's remote member has) and is
   talked to here: this computer's hub reads its chat from there, passes the
   message on and brings its progress back. Its chat stays on its machine.
   Picking one machine in the top left still shows only that machine.
   --------------------------------------------------------------------- */
const OFFLINE_WORDS = '它那台电脑现在连不上，开机后我接着做';
/** Steps of a checklist or a group board, in words for the working line (1.5.42 test: 「正在task_plan…」). */
const INTERNAL_TOOL_WORDS = { task_plan: '列任务清单', task_step: '更新任务进度', task_end: '收尾', task_handoff: '把这一项交给别人', task_ask_human: '问你一个问题', task_ask_member: '问同事', group_plan: '排群里的分工' };
const LINK_DOWN_WORDS = '连不上了，连上后接着看结果';
state.view = (() => {
  // A machine picked by name in the top-left menu opens 「只看这台」 (?view=one, 1.5.44:
  // 腾讯云 opened in 全部机器 from its own side), and stays so in this tab;
  // ?view=all (the way home) is 全部机器 again.
  let asked = '';
  try {
    const url = new URL(location.href);
    asked = url.searchParams.get('view') || '';
    if (asked) { url.searchParams.delete('view'); history.replaceState(history.state, '', url.toString()); }
    if (asked === 'one') sessionStorage.setItem('lamplit.single', '1');
    if (asked === 'all') sessionStorage.removeItem('lamplit.single');
  } catch { /* an address without it */ }
  // A pick made before the window moved to this computer ("只看这台"); one time only.
  try {
    const v = sessionStorage.getItem('lamplit.view'); sessionStorage.removeItem('lamplit.view');
    return v === 'local' || sessionStorage.getItem('lamplit.single') === '1' ? 'local' : 'all';
  } catch { return asked === 'one' ? 'local' : 'all'; }
})();
/** This page is a machine opened by name from another one (1.5.44): 「全部机器」 is back there. */
function singleVisit() {
  try { return sessionStorage.getItem('lamplit.single') === '1'; } catch { return false; }
}
/** Is there a way back to the machine this one was opened from? (the phone app's, or the page's `from`) */
function canGoHome() {
  return typeof window.NightshiftShell?.openMachine === 'function' || Boolean(cameFromMachine());
}
/** 「全部机器」 on a machine opened by name: back to the home machine, in 全部机器 (1.5.44). */
function goHomeAll() {
  try { sessionStorage.removeItem('lamplit.single'); } catch { /* fine */ }
  // The phone app knows its home machine and the best way there now.
  try { if (window.NightshiftShell?.openMachine?.('@home')) return true; } catch { /* old app */ }
  const back = cameFromMachine();
  if (!back) return false;
  const next = new URL(back.origin);
  next.searchParams.set('view', 'all');
  location.assign(next.toString());
  return true;
}
state.peerRoster = [];
state.peerAttention = {};
state.outbox = [];

function isRemoteId(id) { return typeof id === 'string' && id.includes('@'); }
function remoteOf(id) {
  if (!isRemoteId(id)) return null;
  const at = id.lastIndexOf('@');
  return { botId: id.slice(0, at), machine: id.slice(at + 1) };
}
/** This hub's route for a bot on another machine: /api/peers/<machine>/bots/<id><rest>. */
function remoteApi(id, rest = '') {
  const far = remoteOf(id);
  return `/api/peers/${encodeURIComponent(far.machine)}/bots/${encodeURIComponent(far.botId)}${rest}`;
}
/** This hub's route for a group on another machine (1.5.43): /api/peers/<machine>/groups/<id><rest>. */
function remoteGroupApi(id, rest = '') {
  const far = remoteOf(id);
  return `/api/peers/${encodeURIComponent(far.machine)}/groups/${encodeURIComponent(far.botId)}${rest}`;
}
/** The machine of the chat on screen (a bot's or, 1.5.43, a group's) when it is another machine, else ''. */
function remoteChatMachine() {
  if (isGroupMode()) return isRemoteId(state.groupId) ? remoteOf(state.groupId).machine : '';
  return isRemoteId(state.botId) ? remoteOf(state.botId).machine : '';
}
/** 「撤销」 of a turn: here, or on the machine of the chat on screen. */
function chatUndoUrl() {
  if (!remoteChatMachine()) return '/api/undo';
  if (!isGroupMode()) return remoteApi(state.botId, '/undo');
  const group = groupById(state.groupId);
  return remoteApi(group?.coordinatorId || groupMembers(group)[0]?.id || `x@${remoteChatMachine()}`, '/undo');
}
/** A file a reply names: from this machine, or from the machine the chat's bot is on. */
function chatFileUrl(path) {
  const machine = remoteChatMachine();
  return machine ? remoteFileUrl(machine, path) : `/api/workspace/file?path=${encodeURIComponent(path)}`;
}
function chatStatUrl(path) {
  if (!remoteChatMachine()) return `/api/workspace/stat?path=${encodeURIComponent(path)}`;
  return isGroupMode() ? remoteGroupApi(state.groupId, `/stat?path=${encodeURIComponent(path)}`) : remoteApi(state.botId, `/stat?path=${encodeURIComponent(path)}`);
}

/** A bot on another machine as the page draws it (name, role, its machine, whether that answers). */
function remoteBotById(id) {
  const far = remoteOf(id);
  if (!far) return null;
  const m = (state.peerRoster || []).find((x) => x.machine === far.machine);
  const b = m?.bots?.find((x) => x.id === far.botId);
  if (!b) return null;
  return { id, name: b.name, role: b.role || '', primary: Boolean(b.primary), mainThere: Boolean(b.primary), preview: b.preview || null, ...(b.avatar ? { avatar: b.avatar } : {}), remote: { machine: far.machine, botId: far.botId, online: Boolean(m.online) } };
}

/**
 * A group on another machine as the page draws it (1.5.43): its members as
 * "id@machine" (each opens its own chat here), the coordinator likewise.
 */
function remoteGroupById(id) {
  const far = remoteOf(id);
  if (!far) return null;
  const m = (state.peerRoster || []).find((x) => x.machine === far.machine);
  const g = m?.groups?.find((x) => x.id === far.botId);
  if (!g) return null;
  const there = (mid) => (String(mid).includes('@') ? String(mid) : `${mid}@${far.machine}`);
  return {
    id,
    name: g.name,
    coordinatorId: g.coordinatorId ? there(g.coordinatorId) : '',
    members: (g.members || []).map((x) => ({ ...x, id: there(x.id) })),
    preview: g.preview || null,
    remote: { machine: far.machine, groupId: far.botId, online: Boolean(m.online) },
  };
}

/*
 * 「建在哪台？」 (1.5.44): in 「全部机器」 a new bot or group can be made on any
 * other machine that answers now; this machine is the default. A group lives
 * on the machine chosen, its members can be on any. In 「只看这台」 nothing changes.
 */
function whereMachines() {
  if (!rosterGrouped()) return [];
  return (state.peerRoster || []).filter((m) => m.online).map((m) => m.machine);
}
const hereWords = () => `这台（${machineDisplayName()}）`;
/** The new-bot form's choice: shown only when there is another machine to choose. */
function fillBotWhere() {
  const sel = $('new-bot-where');
  if (!sel) return;
  const machines = whereMachines();
  $('new-bot-where-row').hidden = !machines.length;
  sel.innerHTML = '';
  for (const [value, label] of [['', hereWords()], ...machines.map((m) => [m, m])]) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    sel.appendChild(opt);
  }
}
/** Is this member on the machine the new group lives on? */
function onGroupMachine(id) {
  const where = state.groupDraft?.where || '';
  return where ? String(id).endsWith(`@${where}`) : !String(id).includes('@');
}
function renderGroupWhere() {
  const draft = state.groupDraft;
  const row = $('group-where-row');
  if (!row) return;
  const machines = draft.id ? [] : whereMachines();
  if (draft.where && !machines.includes(draft.where)) draft.where = '';
  row.hidden = $('group-where-label').hidden = !machines.length;
  row.innerHTML = '';
  for (const [key, label] of [['', hereWords()], ...machines.map((m) => [m, m])]) {
    const chip = el('button', `coord-chip${(draft.where || '') === key ? ' on' : ''}`, label);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      draft.where = key;
      if (draft.coordinatorId && !onGroupMachine(draft.coordinatorId)) draft.coordinatorId = draft.members.find(onGroupMachine) || null;
      renderGroupModal();
    });
    row.appendChild(chip);
  }
  if (draft.where) row.appendChild(el('span', 'muted tiny', `群建在「${draft.where}」上。别的机器上的助手也能进群，前提是「${draft.where}」的机器列表里有那台机器。`));
}
/** Made on another machine (also once the browser is paired): the form goes, the new one opens. */
async function botMadeThere(where, res) {
  $('bot-form').classList.remove('open');
  $('new-bot-name').value = ''; $('new-bot-role').value = '';
  await loadRoster({ fresh: true });
  if (res?.bot?.id && botById(res.bot.id)) selectBot(res.bot.id);
  toast(`助手已建在「${where}」上`);
}
async function groupMadeThere(where, res) {
  closeGroupModal();
  await loadRoster({ fresh: true });
  if (res?.group?.id && groupById(res.group.id)) openGroup(res.group.id);
  toast(`群组已建在「${where}」上`);
}
/** A new group made on another machine, through this hub; then it opens here. */
async function createGroupThere(draft, name, button) {
  const where = draft.where;
  try {
    const res = await api(`/api/peers/${encodeURIComponent(where)}/groups`, {
      method: 'POST',
      body: { name, members: draft.members, coordinatorId: draft.coordinatorId || draft.members.find(onGroupMachine) },
    });
    await groupMadeThere(where, res);
  } catch (err) {
    if (err.code === 'LOCAL_KEY_REQUIRED' && state.afterPair) state.afterPair.then = (res) => groupMadeThere(where, res);
    if (err.status === 401 || err.code === 'LOCAL_KEY_REQUIRED') return;
    showGroupNote(err.code === 'MEMBER_NOT_REACHABLE' ? err.message : `在「${where}」上没建成：${err.message}。也可以在左上角切到「${where}」再建。`);
  } finally {
    button.disabled = false;
  }
}

/** 「全部机器」 with other machines to show. */
function rosterGrouped() {
  // The desktop app showing one other machine's own window: only that machine.
  const single = Boolean(machineBridge && !machineBridge.local);
  return state.view === 'all' && !single && (state.peerRoster || []).length > 0;
}

async function loadRoster({ fresh = false } = {}) {
  let data;
  try { data = await api(`/api/peers/roster${fresh ? '?fresh=1' : ''}`); } catch { return; }
  const before = JSON.stringify(state.peerRoster);
  state.peerRoster = Array.isArray(data?.machines) ? data.machines : [];
  state.peerAttention = Object.assign({}, ...state.peerRoster.map((m) => m.attention || {}));
  if (state.peerRoster.some((m) => m.queued)) await loadOutbox({ render: false });
  else state.outbox = [];
  if (before !== JSON.stringify(state.peerRoster)) {
    renderBots();
    refreshChatTitle();
    syncMachineBranding();
    // The chat on screen: its machine came back, or went away.
    const far = remoteOf(state.botId);
    if (far && !isGroupMode()) {
      const bot = botById(state.botId);
      if (bot) { $('chat-sub').textContent = remoteChatSub(bot); $('chat-sub').classList.toggle('off', Boolean(bot.remote && !bot.remote.online)); }
    }
  }
  // What the sidebar says is what the chat says, on every look (1.5.42 test: grey name, no line in the chat).
  const open = isGroupMode() ? (isRemoteId(state.groupId) ? groupById(state.groupId) : null) : (isRemoteId(state.botId) ? botById(state.botId) : null);
  if (open?.remote && !open.remote.online) showRemoteDown();
  else if (open?.remote && messagesEl.querySelector('.link-down-line')) { hideRemoteDown(); loadMessages(); }
}

/** The messages waiting here for a machine that is off (only the human may see them). */
async function loadOutbox({ render = true } = {}) {
  try { state.outbox = (await api('/api/peers/outbox', { quiet: true }))?.items || []; } catch { state.outbox = []; }
  if (render) { renderBots(); if (remoteChatMachine()) (isGroupMode() ? loadGroupMessages() : loadMessages()); }
}

/** Under the chat's title: its machine's state, in words. */
function remoteChatSub(bot) {
  if (!bot?.remote) return bot?.role || '';
  if (!bot.remote.online) return `离线 · ${OFFLINE_WORDS}`;
  return bot.role || `在「${bot.remote.machine}」上`;
}

/*
 * 「全部机器」's sidebar (1.5.43; redesign step 4, 1.5.59): one section per machine
 * that folds (remembered per machine), an online dot in its heading, its groups
 * first, then its bots. 「最近」 is gone (it listed the same chats twice): the
 * filters on top (「N 件等你」 / 「N 个在做」) find what matters. Folded, its row says
 * what is in it and what waits. Over ten chats, a search box finds one on any machine.
 */
const SEARCH_FROM = 10;
const COLLAPSED_KEY = 'lamplit.roster.collapsed';
function collapsedMachines() {
  try { const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function setCollapsed(machine, on) {
  const all = collapsedMachines();
  if (on) all[machine] = true; else delete all[machine];
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(all)); } catch { /* this time only */ }
}

/** Every chat of every machine, as the sidebar lists them. */
function rosterChats() {
  const here = machineDisplayName();
  const ts = (x) => Date.parse(x?.preview?.ts || '') || 0;
  const machines = [{
    machine: here,
    self: true,
    online: true,
    groups: (state.groups || []).map((g) => ({ kind: 'group', id: g.id, key: `group:${g.id}`, ts: ts(g), row: () => groupRow(g) })),
    bots: [...state.bots].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || ts(b) - ts(a))
      .map((b) => ({ kind: 'bot', id: b.id, key: `bot:${b.id}`, ts: ts(b), row: () => botRow(b) })),
  }];
  for (const m of state.peerRoster || []) {
    machines.push({
      machine: m.machine,
      self: false,
      online: Boolean(m.online),
      // A message waiting for that machine counts as the chat's latest (1.5.43 test: 「最近」 left it out until it went).
      groups: (m.groups || []).map((g) => ({ kind: 'group', id: `${g.id}@${m.machine}`, key: `group:${g.id}@${m.machine}`, ts: Math.max(ts(g), waitingAt(m.machine, '', g.id)), row: () => remoteGroupRow(m, g) })),
      bots: [...(m.bots || [])].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || ts(b) - ts(a))
        .map((b) => ({ kind: 'bot', id: `${b.id}@${m.machine}`, key: `bot:${b.id}@${m.machine}`, ts: Math.max(ts(b), waitingAt(m.machine, b.id, '')), row: () => remoteBotRow(m, b) })),
    });
  }
  return machines;
}

/** When the newest message waiting here for that machine was written (0: none). */
function waitingAt(machine, botId, groupId) {
  return Math.max(0, ...(state.outbox || []).filter((q) => q.machine === machine && (groupId ? q.groupId === groupId : !q.groupId && q.botId === botId)).map((q) => Date.parse(q.at) || 0));
}

/** How many of a machine's chats wait on the human. */
function waitingIn(items) {
  return items.filter((i) => { const it = attentionItem(i.key); return it?.needsYou || it?.asking; }).length;
}

function renderRosterSidebar(list) {
  const machines = rosterChats();
  const all = machines.flatMap((m) => [...m.groups, ...m.bots].map((i) => ({ ...i, machine: m.machine })));
  $('bot-count').textContent = String(all.length);
  const wrap = $('roster-search-wrap');
  if (wrap) wrap.hidden = all.length <= SEARCH_FROM;
  const folded = collapsedMachines();
  for (const m of machines) {
    const items = [...m.groups, ...m.bots];
    const sec = el('div', `roster-sec machine${folded[m.machine] ? ' collapsed' : ''}${m.online ? '' : ' off'}`);
    sec.dataset.machine = m.machine;
    const head = el('button', 'roster-head machine-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', folded[m.machine] ? 'false' : 'true');
    head.appendChild(el('span', 'rh-caret', folded[m.machine] ? '▸' : '▾'));
    // Online or not, at a glance (1.5.59): a green dot, or a grey one.
    const dot = el('i', `rh-dot ${m.online ? 'on' : 'off'}`);
    dot.setAttribute('aria-label', m.online ? '在线' : '离线');
    head.appendChild(dot);
    head.appendChild(el('span', 'rh-name', m.machine));
    if (m.self) head.appendChild(el('span', 'rh-tag', '· 这台'));
    if (!m.online && !folded[m.machine]) head.appendChild(el('span', 'rh-tag off', '离线')); // folded, the summary says it (once)
    const waits = waitingIn(items);
    // Folded, the row says what is inside and what waits (「2 群 · 9 个 · 1 件事等你」).
    const summary = !m.online ? '离线'
      : [m.groups.length ? `${m.groups.length} 群` : '', `${m.bots.length} 个`, waits ? `${waits} 件事等你` : ''].filter(Boolean).join(' · ');
    // Open, what waits there first (1.5.59), else how many: the name keeps its room in a narrow list.
    const open = m.online && waits ? `${waits} 件等你` : `${items.length} 个`;
    head.appendChild(el('span', `rh-count${waits && m.online ? ' needs' : ''}`, folded[m.machine] ? summary : open));
    head.title = m.self ? `${m.machine}：你正在用的这台电脑` : m.online ? `「${m.machine}」上的助手和群组：点开就聊，不用切换窗口` : `「${m.machine}」现在连不上。给它的助手发消息，开机后会接着做。`;
    head.addEventListener('click', () => { setCollapsed(m.machine, !sec.classList.contains('collapsed')); renderBots(); });
    sec.appendChild(head);
    const body = el('div', 'roster-body');
    for (const item of items) body.appendChild(item.row());
    if (!items.length) body.appendChild(el('div', 'roster-empty', m.self ? '还没有助手' : '还不知道它上面有哪些助手'));
    sec.appendChild(body);
    list.appendChild(sec);
  }
}

/** A bot on another machine, in the sidebar. */
function remoteBotRow(m, b) {
  const id = `${b.id}@${m.machine}`;
  const bot = remoteBotById(id) || { id, name: b.name, role: b.role || '' };
  const active = !isGroupMode() && state.botId === id;
  const row = el('div', `bot remote${active ? ' active' : ''}${m.online ? '' : ' off'}`);
  row.dataset.bot = id;
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('aria-pressed', active ? 'true' : 'false');
  const av = avatarNode(bot, 38, 'bot-av');
  lampMarkRow(av, bot, { key: `bot:${id}`, online: m.online });
  av.setAttribute('role', 'img');
  av.setAttribute('aria-label', `${bot.name} 的头像`);
  const text = el('div', 'bot-text');
  const nameRow = el('div', 'bot-name');
  nameRow.appendChild(el('span', 'bot-name-text', bot.name));
  if (b.primary) nameRow.appendChild(el('span', 'badge', '主'));
  if (!m.online) nameRow.appendChild(el('span', 'bot-off-tag', '离线'));
  text.appendChild(nameRow);
  const last = b.preview?.text ? truncate(plainPreview(b.preview.text), 60) : '';
  const waiting = (state.outbox || []).filter((q) => q.machine === m.machine && !q.groupId && (q.botId === b.id || (!q.botId && b.primary))).length;
  const line = waiting
    ? { kind: 'needs', text: `有 ${waiting} 条消息等它那台电脑开机` }
    : m.online ? rosterLine(`bot:${id}`, { idle: bot.role || last || '还没有消息', last }) : { kind: '', text: bot.role || '那台电脑现在连不上' };
  text.appendChild(rosterLineNode(line));
  row.dataset.search = `${bot.name} ${bot.role || ''} ${m.machine} ${last}`.toLowerCase();
  row.appendChild(av);
  row.appendChild(text);
  const when = m.online ? homeTime(b.preview?.ts) : '';
  if (when) row.appendChild(el('span', 'bot-time', when));
  const badge = m.online ? attentionBadge(`bot:${id}`) : null;
  if (badge) row.appendChild(badge);
  row.addEventListener('click', () => selectBot(id));
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectBot(id); } });
  return row;
}

/** A group on another machine, in the sidebar (1.5.43). */
function remoteGroupRow(m, g) {
  const id = `${g.id}@${m.machine}`;
  const group = remoteGroupById(id) || { id, name: g.name, members: [] };
  const members = groupMembers(group);
  const row = el('div', `group remote${state.groupId === id ? ' active' : ''}${m.online ? '' : ' off'}`);
  row.dataset.group = id;
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.appendChild(stackOf(members, 30, null, 2));
  const text = el('div', 'bot-text');
  const nameRow = el('div', 'bot-name');
  nameRow.appendChild(el('span', 'bot-name-text', g.name || '未命名群组'));
  if (!m.online) nameRow.appendChild(el('span', 'bot-off-tag', '离线'));
  text.appendChild(nameRow);
  const last = g.preview?.text ? truncate(plainPreview(g.preview.text), 60) : '';
  const waiting = (state.outbox || []).filter((q) => q.machine === m.machine && q.groupId === g.id).length;
  const line = waiting
    ? { kind: 'needs', text: `有 ${waiting} 条消息等它那台电脑开机` }
    : m.online ? rosterLine(`group:${id}`, { idle: members.length ? `${members.length} 位成员 · ${members.map((b) => b.name).join('、')}` : (last || '还没有消息'), last, group: true })
      : { kind: '', text: '那台电脑现在连不上' };
  text.appendChild(rosterLineNode(line));
  row.dataset.search = `${g.name || ''} ${members.map((b) => b.name).join(' ')} ${m.machine} ${last}`.toLowerCase();
  row.appendChild(text);
  const badge = m.online ? attentionBadge(`group:${id}`) : null;
  if (badge) row.appendChild(badge);
  row.addEventListener('click', () => openGroup(id));
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openGroup(id); } });
  return row;
}

/** The messages waiting for this chat's machine, under the chat: what was written, and why it waits. */
function appendQueuedMessages() {
  const far = remoteOf(isGroupMode() ? state.groupId : state.botId);
  if (!far) return;
  const bot = isGroupMode() ? null : botById(state.botId);
  const mine = (state.outbox || []).filter((q) => q.machine === far.machine && (isGroupMode() ? q.groupId === far.botId : !q.groupId && (q.botId === far.botId || (!q.botId && bot?.mainThere))));
  for (const old of messagesEl.querySelectorAll('.queued-row, .queued-line')) old.remove();
  if (mine.length) messagesEl.querySelector('.link-down-line')?.remove();
  for (const q of mine) {
    if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
    const row = userRow({ text: q.text, ts: q.at });
    row.classList.add('queued-row');
    messagesEl.appendChild(row);
    const line = el('div', 'status-line queued-line');
    line.appendChild(el('span', null, OFFLINE_WORDS));
    const undo = el('button', 'btn ghost tiny', '不发了');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await api(`/api/peers/outbox/${encodeURIComponent(q.id)}`, { method: 'DELETE' });
        toast('这条不发了');
      } catch (err) { toast(err.message, true); }
      await loadOutbox();
    });
    line.appendChild(undo);
    messagesEl.appendChild(line);
  }
}

/** The local hub said what happened to a waiting message: sent once the machine was back, or not. */
function onOutboxEvent(ev) {
  if (ev.state === 'failed' && ev.text) toast(ev.text, true);
  const open = isGroupMode() ? state.groupId : state.botId;
  if (ev.state === 'sent' && (isGroupMode() ? ev.groupId : ev.botId) === open) {
    toast('那台电脑连上了，刚才的消息已经交给它');
    // Its answer is on its way: the live link may still be coming back, so read the chat meanwhile.
    state.remoteStreamId = null; connectRemoteStream(); watchRemoteReply(open);
  }
  loadOutbox().then(() => loadRoster()).catch(() => {});
}

/**
 * The chat of a bot on another machine is on screen already: keep it as it is
 * (what came live since the last load is newer than the saved copy) when its
 * machine is off (1.5.42 test: the last turn vanished from the chat).
 */
function remoteChatOnScreen(botId) {
  return isRemoteId(botId) && !isGroupMode() && messagesEl?.dataset.chat === botId && Boolean(messagesEl.firstChild);
}

/** A remote chat could not be read: its machine is off (or the bot is gone). Said in words; true when handled. */
function remoteChatFailed(botId, err, cached) {
  if (state.botId !== botId) return true;
  if (err.code === 'LOCAL_KEY_REQUIRED') { showPairNeeded(botId); return true; } // never the last chat's messages under this one's name
  // Not the last chat's messages under this one's name: what is known here (what waits for it).
  if (remoteChatOnScreen(botId)) appendQueuedMessages();
  else if (!cached) { state.messages = []; renderMessages(); }
  showRemoteDown(err.status === 404 ? `「${remoteOf(botId).machine}」上没有这个助手了` : LINK_DOWN_WORDS);
  return true;
}

/**
 * This browser may not read a chat of another machine (not paired, or its pairing was lost - 1.5.43
 * test: the last chat stayed on screen under this one's name and sending failed without a word):
 * the screen is emptied and says what to do, with the pairing button.
 */
function showPairNeeded(id) {
  const machine = remoteOf(id)?.machine || '那台机器';
  if (isGroupMode()) state.groupMessages = []; else state.messages = [];
  messagesEl.innerHTML = ''; messagesEl.dataset.chat = '';
  const line = el('div', 'status-line pair-needed-line');
  line.appendChild(el('span', null, `这个浏览器还没配对（或者配对失效了），看不到「${machine}」上的对话。配对一次就好。`));
  line.appendChild(pairButton(() => { state.remoteStreamId = null; connectRemoteStream(); (isGroupMode() ? loadGroupMessages() : loadMessages()); }));
  messagesEl.appendChild(line);
  hideTyping();
}

/** The chat's machine does not answer: one plain line, no error (it goes on there, or when it is back). */
function showRemoteDown(text = LINK_DOWN_WORDS) {
  if (text === LINK_DOWN_WORDS && messagesEl.querySelector('.queued-line')) return; // the waiting message says it already
  let line = messagesEl.querySelector('.link-down-line');
  if (!line) {
    line = el('div', 'status-line link-down-line');
    messagesEl.appendChild(line);
  }
  line.textContent = text;
  hideTyping();
  scrollToBottom(true);
}
function hideRemoteDown() {
  messagesEl?.querySelector('.link-down-line')?.remove();
}

/** That bot's events, live, through this hub (a second stream next to this machine's own). */
function connectRemoteStream() {
  const group = isGroupMode();
  const id = group ? (isRemoteId(state.groupId) ? state.groupId : '') : (isRemoteId(state.botId) ? state.botId : '');
  if (state.remoteStream && state.remoteStreamId === id) return;
  if (state.remoteStream) { state.remoteStream.close(); state.remoteStream = null; }
  state.remoteStreamId = id;
  if (!id) return;
  const far = remoteOf(id);
  let es;
  try { es = new EventSource(group ? remoteGroupApi(id, '/stream') : remoteApi(id, '/stream')); } catch { return; }
  state.remoteStream = es;
  es.onmessage = (event) => {
    let ev;
    try { ev = JSON.parse(event.data); } catch { return; }
    if (state.remoteStreamId !== id || (group ? state.groupId : state.botId) !== id) return;
    if (ev.type === 'peer.link') {
      if (ev.state === 'down') { showRemoteDown(LINK_DOWN_WORDS); setWorking(false); }
      else if (ev.state === 'refused') showRemoteDown(ev.text || LINK_DOWN_WORDS);
      else { hideRemoteDown(); if (group) loadGroupMessages(); else { loadMessages(); refreshWorking(); } loadRoster(); }
      return;
    }
    // Its sidebar line follows (1.5.42 test); seen here, it is not 「新」 there (1.5.43 test: a blue dot stayed).
    if (ev.type === 'turn.end') { clearInterval(state.remoteReplyWatch); if (document.visibilityState === 'visible') markSeen(); setTimeout(() => loadRoster(), 1200); }
    // Its cards are answered through the inbox: the card says which machine (1.5.41).
    if (ev.type === 'approval.request') {
      ev.from = { machine: far.machine, botName: group ? (groupMemberById(ev.botId)?.name || ev.botName || '') : (botById(id)?.name || '') };
      refreshInbox({ notify: false });
    }
    handleEvent(ev);
  };
  es.onerror = () => {
    // Refused (not paired) or this hub went away: EventSource gives up on a refusal. Try again in a
    // while, as long as this chat is open (1.5.43 test: after pairing or a drop the replies never came).
    if (es.readyState === 2 && state.remoteStreamId === id) {
      state.remoteStream = null; state.remoteStreamId = '';
      clearTimeout(state.remoteStreamRetry);
      state.remoteStreamRetry = setTimeout(() => { if ((group ? state.groupId : state.botId) === id) connectRemoteStream(); }, 8000);
    }
  };
}

/**
 * A reply is due in the remote chat on screen (its message just went out after the machine came
 * back): read the chat every few seconds for a while, whatever the live link does.
 */
function watchRemoteReply(id) {
  clearInterval(state.remoteReplyWatch);
  let left = 30;
  state.remoteReplyWatch = setInterval(() => {
    const open = isGroupMode() ? state.groupId : state.botId;
    if (open !== id || (left -= 1) < 0) { clearInterval(state.remoteReplyWatch); return; }
    (isGroupMode() ? loadGroupMessages() : loadMessages()).catch?.(() => {});
  }, 4000);
}

/** A bot on another machine: its waiting cards, from the inbox, answered through it. */
function appendRemoteCards() {
  const far = remoteOf(state.botId);
  if (!far) return;
  for (const item of state.inbox?.items || []) {
    if (item.machine !== far.machine || item.botId !== far.botId) continue;
    if (messagesEl.querySelector(`[data-approval="${CSS.escape(item.id)}"]`)) continue;
    appendApprovalCard(inboxCardData(item));
  }
}

function renderRemoteMemoryNote() {
  const far = remoteOf(state.botId);
  const note = `它的记忆在「${far?.machine || '那台机器'}」上。想看或者改，切到那台机器（左上角）再看。`;
  $('memory-title').textContent = '记忆';
  $('bot-memory-path').textContent = '';
  $('shared-path').textContent = '';
  $('bot-memory-pre').textContent = note;
  $('shared-pre').textContent = note;
}

/**
 * Whose screen the 电脑 tab shows (1.5.58): the other machine's name for a bot
 * there (全部机器), else this page's machine. 11-22: the cloud machine's screen
 * was labelled 「实时画面 · Windows 电脑」.
 */
function screenMachineName() {
  return state.computer?.remote?.machine || machineDisplayName();
}

/** A remote bot's screen: through this hub's desktop relay; control is asked for first. */
async function loadRemoteComputer(id) {
  const far = remoteOf(id);
  if ($('pc-screen')) $('pc-screen').style.display = 'none'; // nothing of this computer while that machine answers
  if ($('pc-screen-note')) { $('pc-screen-note').textContent = '正在打开屏幕…'; $('pc-screen-note').style.display = 'block'; }
  let data = null;
  try { data = await api(remoteApi(id, '/desktop'), { quiet: true }); } catch (err) {
    state.computer = { desktop: { running: false, url: null }, remote: far, locked: err.code === 'LOCAL_KEY_REQUIRED',
      note: err.code === 'LOCAL_KEY_REQUIRED' ? `「${far.machine}」上的屏幕，要先把这个浏览器配对一次才能看。` : `「${far.machine}」现在连不上，看不到它的屏幕。` };
    syncViewer();
    refreshScreen();
    $('pc-stats').innerHTML = `<div class="row-note">${escapeHtml(err.code === 'LOCAL_KEY_REQUIRED' ? `「${far.machine}」上的屏幕，要先把这个浏览器配对一次才能看。` : `「${far.machine}」现在连不上，看不到它的屏幕。`)}</div>`;
    if (err.code === 'LOCAL_KEY_REQUIRED') $('pc-stats').appendChild(pairButton(() => loadComputer()));
    $('pc-procs').innerHTML = '';
    return;
  }
  const url = data?.desktop?.url || null;
  state.computer = { desktop: { ...(data?.desktop || {}), url, perBot: Boolean(url) }, remote: far };
  if (url) {
    const card = $('pc-screen-wrap');
    if (card) card.classList.remove('takeover');
    syncViewer();
    if ($('pc-screen-note')) $('pc-screen-note').style.display = 'none';
    $('pc-stats').innerHTML = `<div class="row-note">${escapeHtml(`这是「${far.machine}」上的屏幕，经这台电脑转过来。要动手操作，点「接管桌面」，会先问你。`)}</div>`;
    $('pc-procs').innerHTML = '';
    return;
  }
  state.computer.note = `这个助手在「${far.machine}」上。它那台电脑现在没有能看的屏幕（助手用到浏览器或桌面时才有）。`;
  syncViewer();
  refreshScreen();
  $('pc-stats').innerHTML = `<div class="row-note">${escapeHtml(state.computer.note)}</div>`;
  $('pc-procs').innerHTML = '';
}

/** Is the panel's screen information about this bot of another machine (not the last one's, not this computer's)? */
function screenIsFor(id) {
  const far = remoteOf(id);
  const had = state.computer?.remote;
  return Boolean(far && had && had.machine === far.machine && had.botId === far.botId);
}

/** A 「配对这个浏览器」 button; after pairing, then() runs (the thing that needed it). */
function pairButton(then) {
  const btn = el('button', 'btn tiny', '配对这个浏览器');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    state.afterPair = { path: '/api/auth', options: {}, then };
    if ($('local-pair-why')) $('local-pair-why').textContent = '和别的机器上的助手说话、看它的文件，只能在 Lamplit 应用里，或者在配对过的设备上：这样机器人自己跑的程序没法借这台电脑去指挥别的机器。';
    localPairOpen(true);
  });
  return btn;
}

/**
 * A file of another machine (a picture, a video) that this browser may not
 * fetch yet (not paired, 1.5.42 test: it just vanished): say where it is and
 * offer pairing, once per message.
 */
document.addEventListener('error', (event) => {
  const node = event.target;
  const src = node?.currentSrc || node?.src || '';
  const m = /\/api\/peers\/([^/]+)\/file\?/.exec(src);
  if (!m || !(node instanceof HTMLImageElement || node instanceof HTMLVideoElement)) return;
  let machine = m[1];
  try { machine = decodeURIComponent(machine); } catch { /* as it came */ }
  const list = node.closest('.att-list');
  fetch(src, { method: 'GET', credentials: 'same-origin' }).then((r) => {
    r.body?.cancel?.();
    if (r.status !== 403 || !list || list.querySelector('.att-locked')) return;
    list.appendChild(lockedNote(machine, () => renderMessages()));
  }).catch(() => {});
}, true);

function lockedNote(machine, then) {
  const note = el('div', 'att-locked row-note', `这个文件在「${machine}」上，先把这个浏览器配对一次才能看。`);
  note.appendChild(pairButton(then));
  return note;
}

/**
 * A group member on another machine: the files its answer named were fetched
 * here (crossmachine.fetchedNote). The chat shows one card each, the copy here,
 * and not the note with its long paths (1.5.42 test); the model still reads it.
 */
const FETCHED_NOTE = /\n*（「([^」]+)」上的这些文件已经取回这台机器：([^）]*)）\s*$/;
function withoutFetchedNote(raw) {
  return String(raw ?? '').replace(FETCHED_NOTE, '');
}
function fetchedHere(raw, files) {
  const m = FETCHED_NOTE.exec(String(raw ?? ''));
  if (!m) return files;
  const map = new Map(m[2].split('；').map((pair) => pair.split(' → ').map((x) => x.trim())).filter((p) => p.length === 2));
  return files.map((f) => (map.has(f.path) ? { ...f, path: map.get(f.path) } : f));
}

/** The switcher: 「全部机器」, one machine alone, or another machine's own window. */
function pickMachineRow(item) {
  if (item.classList.contains('current')) return;
  const view = item.dataset.view || '';
  const url = item.dataset.machine;
  const here = url === undefined || url === '';
  if (view === 'all' && !machineBridge && singleVisit() && goHomeAll()) return;
  if (view && here && (!machineBridge || machineBridge.local)) { setRosterView(view); return; }
  // The window moves to this computer: the pick waits for it there.
  if (view) { try { sessionStorage.setItem('lamplit.view', view); } catch { /* 全部机器 then */ } }
  switchMachine(url || '');
}
function setRosterView(view) {
  state.view = view === 'local' ? 'local' : 'all';
  if (state.view === 'all') { try { sessionStorage.removeItem('lamplit.single'); } catch { /* fine */ } }
  // 「只看这台」 with a chat of another machine on screen: back to this machine's main assistant.
  if (state.view === 'local' && isRemoteId(state.botId)) {
    const primary = state.bots.find((b) => b.primary) || state.bots[0];
    if (primary) selectBot(primary.id);
  }
  renderBots();
  renderGroups(); // this machine's groups have their own section again (1.5.43 test: they vanished)
  syncMachineBranding();
  renderMachineMenu();
  toast(state.view === 'all' ? '全部机器：每台机器上的助手都在左边' : `只看「${machineDisplayName()}」`);
}

/*
 * 「出门在外，怎么连上它？」 when adding a machine (1.5.43, the paused relay plan's
 * 「三种方式」): only at home (the default), Tailscale (its key), our own relay
 * (the one set up in 设置 → 手机和外网), or Lamplit's relay - not yet.
 */
function resetOutsideChoice() {
  const home = document.querySelector('input[name="vnc-outside"][value="home"]');
  if (home) home.checked = true;
  if ($('vnc-ts-key')) $('vnc-ts-key').value = '';
  syncOutsideChoice();
  // Whether this computer has a relay to share: said on the choice itself.
  api('/api/relay-link').then((view) => {
    const has = Boolean(view?.hasJoin && view?.host);
    const relay = document.querySelector('input[name="vnc-outside"][value="relay"]');
    if (relay) relay.disabled = !has;
    if ($('vnc-relay-note')) $('vnc-relay-note').textContent = has ? '用你在「设置 → 手机和外网」里装好的中转，新机器装好后自动连上' : '这台电脑还没装自建中转：先在「设置 → 手机和外网」里装好，再回来选它';
  }).catch(() => {});
}
function syncOutsideChoice() {
  const way = document.querySelector('input[name="vnc-outside"]:checked')?.value || 'home';
  if ($('vnc-ts')) $('vnc-ts').hidden = way !== 'tailscale';
  // This computer needs Tailscale too, or the new machine is out of reach from here (1.5.54, walkthrough 5.2).
  const here = $('vnc-ts-here');
  if (!here) return;
  here.hidden = true;
  if (way !== 'tailscale') return;
  api('/api/tailscale').then((t) => {
    if (t?.state === 'running') return;
    here.textContent = '这台电脑还没连上 Tailscale：先在 设置 → 手机和外网 里装好并登录，不然加好以后从这里也连不上它。';
    here.hidden = false;
  }).catch(() => {});
}
/** The choice as the setup takes it: {options} or {error}. */
function outsideChoice() {
  const way = document.querySelector('input[name="vnc-outside"]:checked')?.value || 'home';
  if (way !== 'tailscale') return { options: { outside: way === 'relay' ? 'relay' : 'home' } };
  const key = $('vnc-ts-key')?.value.trim() || '';
  if (!key) return { error: '选了 Tailscale，还要贴一个 Tailscale 密钥（tskey-auth- 开头）。不想用的话，选「只在家里用」。' };
  if (/^tskey-api-/.test(key)) return { error: '这是 API 访问令牌（tskey-api-），不能用来加设备：在 Tailscale 后台 Settings → Keys 里点「Generate auth key」，用 tskey-auth- 开头的那种。' };
  if (!/^tskey-auth-/.test(key)) return { error: 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key。' };
  return { options: { outside: 'tailscale', tailscaleKey: key } };
}

/*
 * Tailscale, the way the relay card works (1.5.43): one click to install here,
 * log in on Tailscale's own page (the link opens on the device in your hand),
 * one click to remove it, and 「让其他机器也用 Tailscale」 - each machine then
 * shows its own login link, or joins at once with a pasted auth key (used once,
 * never kept). Every step asks first.
 */
const TS_STATE_WORDS = { missing: '没装', 'needs-login': '要登录', starting: '启动中', running: '已连上', stopped: '没在运行' };
const TS_UNINSTALL_WORDS = '会删掉这台机器上的 Tailscale 程序，这台就不在你的 Tailscale 网络里了。你的 Tailscale 账号和其他机器都不受影响；这台机器在 Tailscale 后台的记录要你自己在 login.tailscale.com 删。';
const tsOpened = new Set(); // login links already opened for the human
let tsCardTimer = null;

/** Ask first; a step that is not destructive gets a plain button, not a red one. */
async function askStep(title, text, label, { danger = false } = {}) {
  const answer = askConfirm({ title, text, confirmLabel: label });
  if (!danger) $('confirm-ok')?.classList.remove('danger');
  return answer;
}

async function renderTailscaleCard() {
  const box = $('tsx-box');
  if (!box) return;
  clearTimeout(tsCardTimer);
  let t;
  try { t = await api('/api/tailscale'); } catch { return; }
  const busy = t.job?.state === 'running';
  const chip = $('tsx-chip');
  if (chip) {
    chip.textContent = busy ? (t.job.kind === 'uninstall' ? '正在卸载…' : '正在安装…') : (TS_STATE_WORDS[t.state] || '—');
    chip.className = `relay-chip${t.state === 'running' && !busy ? ' ok' : ''}`;
  }
  const lines = [];
  if (busy) lines.push(t.job.detail || '正在进行…');
  else if (t.job?.state === 'failed') lines.push(t.job.detail || '上次没成功');
  if (t.state === 'running') lines.push(t.address ? `这台的 Tailscale 地址：${t.address}。${t.url ? `Lamplit 已经认出它：${t.url}` : 'Lamplit 过一会儿会认出它。'}` : '已连上。');
  if (t.state === 'needs-login' && !busy) lines.push('装好了，还要登录：点「登录 Tailscale」，在打开的 Tailscale 页面里用你的账号登录。登录完这里会变成「已连上」。');
  if (t.state === 'stopped' && t.installed && !busy) lines.push('装好了，但没在运行：点「登录 Tailscale」把它连上。');
  $('tsx-status').textContent = lines.join('\n');
  const byhand = $('tsx-byhand');
  if (byhand) {
    byhand.innerHTML = '';
    byhand.hidden = t.installed || t.can?.install !== false;
    if (!byhand.hidden) {
      byhand.appendChild(el('div', null, t.can.words || '这台电脑要你自己装 Tailscale。'));
      if (t.can.byHand) byhand.appendChild(el('code', 'tsx-cmd', t.can.byHand));
    }
  }
  $('tsx-install').hidden = busy || t.installed || t.can?.install === false;
  $('tsx-login').hidden = busy || !t.installed || t.state === 'running';
  $('tsx-uninstall').hidden = busy || !t.installed;
  // The login link: opened once on this device, and kept as a button.
  if (t.loginUrl && !tsOpened.has(t.loginUrl)) { tsOpened.add(t.loginUrl); openLinkHere(t.loginUrl); }
  renderTailscaleMachines().catch(() => {});
  if (busy || t.state === 'needs-login' || t.state === 'starting') tsCardTimer = setTimeout(() => { if (box.offsetParent) renderTailscaleCard(); }, 3000);
}

async function renderTailscaleMachines() {
  const list = $('tsx-machines');
  if (!list) return;
  let data;
  try { data = await api('/api/tailscale/machines'); } catch { return; }
  const rows = data?.machines || [];
  list.innerHTML = '';
  if (!rows.length) { list.appendChild(el('div', 'row-note', '还没有其他机器。')); return; }
  for (const m of rows) {
    const row = el('div', 'tsx-machine');
    row.appendChild(el('b', null, m.machine));
    const busy = m.job?.state === 'running';
    const words = m.error ? m.error
      : busy ? (m.job.detail || '正在安装…')
        : m.job?.state === 'failed' ? (m.job.detail || '没装好')
          : m.state === 'running' ? (m.address ? `已连上 · ${m.address}` : '已连上')
            : m.state === 'needs-login' ? '装好了，还要登录'
              : m.installed ? '装好了，没在运行' : '没装';
    row.appendChild(el('span', `tsx-words${m.state === 'running' ? ' ok' : ''}`, words));
    if (m.loginUrl) {
      const go = el('button', 'btn tiny', '打开它的登录页');
      go.type = 'button';
      go.addEventListener('click', () => openLinkHere(m.loginUrl));
      row.appendChild(go);
    }
    list.appendChild(row);
  }
  // Each machine's own line says where it stands now: the 「开始装了」 from the share goes (1.5.43 test).
  if (!rows.some((m) => m.job?.state === 'running') && $('tsx-share-state')) $('tsx-share-state').textContent = '';
  if (rows.some((m) => m.job?.state === 'running' || m.state === 'needs-login')) setTimeout(() => { if (list.offsetParent) renderTailscaleMachines(); }, 4000);
}

async function installTailscaleHere() {
  const win = /Windows/i.test(navigator.userAgent);
  if (!(await askStep('在这台电脑上装 Tailscale？', `${win ? 'Windows 会弹出「是否允许此应用更改你的设备」，点「是」。' : ''}装好后会打开 Tailscale 的登录页，用你的 Tailscale 账号登录就行。`, '装上'))) return;
  try {
    await api('/api/tailscale/install', { method: 'POST', body: {} });
  } catch (err) { if (!err.quiet) toast(err.message, true); }
  renderTailscaleCard();
}
async function loginTailscaleHere() {
  try {
    const out = await api('/api/tailscale/login', { method: 'POST', body: {} });
    if (out?.loginUrl) { tsOpened.add(out.loginUrl); openLinkHere(out.loginUrl); } else toast('正在要登录链接，稍等几秒…');
  } catch (err) { if (!err.quiet) toast(err.message, true); }
  setTimeout(renderTailscaleCard, 1500);
}
async function uninstallTailscaleHere() {
  if (!(await askStep('卸载这台电脑上的 Tailscale？', TS_UNINSTALL_WORDS, '卸载', { danger: true }))) return;
  try {
    await api('/api/tailscale/uninstall', { method: 'POST', body: {} });
  } catch (err) { if (!err.quiet) toast(err.message, true); }
  renderTailscaleCard();
}
async function shareTailscale() {
  const key = $('tsx-key')?.value.trim() || '';
  if (key && !/^tskey-auth-/.test(key)) { toast(/^tskey-api-/.test(key) ? '这是 API 访问令牌，不是 Auth key：在 Tailscale 后台点「Generate auth key」' : 'Tailscale 密钥应该是 tskey-auth- 开头的 Auth key', true); return; }
  const text = key
    ? '每台机器都会装上 Tailscale，并用你贴的密钥直接加入你的网络。密钥只用这一次，不保存。'
    : '每台机器都会装上 Tailscale，装好后下面会出现它自己的登录链接，一台台点开、用你的账号登录。';
  if (!(await askStep('让其他机器也用 Tailscale？', text, '开始'))) return;
  const say = $('tsx-share-state');
  if (say) say.textContent = '正在告诉其他机器…';
  try {
    const out = await api('/api/tailscale/share', { method: 'POST', body: key ? { authKey: key } : {} });
    if ($('tsx-key')) $('tsx-key').value = '';
    const list = out?.machines || [];
    if (say) say.textContent = list.length ? list.map((m) => (m.ok ? `「${m.machine}」：开始装了` : `「${m.machine}」：没成功（${m.error || ''}）`)).join('\n') : '还没有其他机器。';
  } catch (err) { if (say) say.textContent = err.message; }
  setTimeout(() => renderTailscaleMachines().catch(() => {}), 2000);
}

/*
 * A turn's changed files (1.5.43, the user's own chat): small words in the
 * reply's action row (「改了 2 个文件」, next to 朗读), the names and 撤销 behind
 * a click, and 撤销 asks first. A name like 「-p」 (a folder Windows' cmd made
 * for `mkdir -p`) is never listed, and never put back.
 */
function optionLikeName(name) { return /^-/.test(String(name || '')); }

function changesChip(turnId, all) {
  const changes = (all || []).filter((c) => !String(c.path || '').split(/[\\/]/).some(optionLikeName));
  if (!changes.length) return null;
  // The file's name only, on Windows too (1.5.33: 「演示\下载\周报.docx」).
  const names = [...new Set(changes.map((c) => c.path.split(/[\\/]/).pop()))];
  const deleted = changes.filter((c) => c.kind === 'delete').length;
  const what = deleted && deleted === changes.length ? '删了' : deleted ? '改动了' : '改了';
  const wrap = el('span', 'changes-wrap');
  // Undone (here or from a card's receipt): said on the line too (1.5.58 beginner test).
  const chip = el('button', 'changes-chip', state.undone.has(turnId) ? `${what} ${names.length} 个文件，已撤销` : `${what} ${names.length} 个文件`);
  chip.type = 'button';
  chip.title = '看这一轮改了哪些文件；7 天内可以撤销';
  const pop = el('div', 'changes-pop');
  pop.hidden = true;
  pop.appendChild(el('div', 'changes-names', truncate(names.join('、'), 240)));
  const done = state.undone.has(turnId);
  const btn = el('button', 'btn ghost tiny', done ? '已撤销' : '撤销');
  btn.type = 'button';
  btn.disabled = done;
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const label = names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 个文件`;
    if (!(await askStep(`把 ${label} 恢复成这一轮之前的样子？`, '这一轮对这些文件做的改动会撤掉，文件回到这一轮之前的样子（7 天内有效）。', '恢复'))) return;
    btn.disabled = true;
    try {
      const res = await api(chatUndoUrl(), { method: 'POST', body: { ids: changes.map((c) => c.id) } });
      const failed = (res.results || []).filter((r) => !r.ok);
      const already = failed.length > 0 && failed.every((f) => /已经撤销过/.test(f.error || '')); // after a reload the button is back (1.5.41 test)
      if (failed.length === (res.results || []).length && !already) throw new Error(failed[0]?.error || '没能撤销');
      state.undone.add(turnId); btn.textContent = '已撤销';
      for (const card of messagesEl.querySelectorAll('.att-doc')) card.recheck?.(); // a file undone says so (1.5.41)
      toast(already ? '这一轮的改动已经撤销过了' : failed.length ? `撤销了一部分：${failed.map((f) => `${f.path || f.id}（${f.error}）`).join('；')}` : '已恢复成这一轮之前的样子');
    } catch (err) {
      btn.disabled = false;
      toast(`没能撤销：${err.message}`, true);
    }
  });
  pop.appendChild(btn);
  chip.addEventListener('click', (event) => { event.stopPropagation(); pop.hidden = !pop.hidden; });
  wrap.appendChild(chip);
  wrap.appendChild(pop);
  return wrap;
}

/** Put it under the reply it belongs to: in the bubble's action row, next to 朗读. */
function placeChanges(node) {
  if (!node) return;
  const bubble = messagesEl.lastElementChild?.querySelector?.('.bubble');
  if (!bubble) { const line = el('div', 'changes-line'); line.appendChild(node); messagesEl.appendChild(line); return; }
  let row = bubble.querySelector('.bubble-actions');
  if (!row) {
    row = el('div', 'bubble-actions');
    const speak = [...bubble.children].find((c) => c.classList?.contains('speak-btn'));
    if (speak) row.appendChild(speak);
    bubble.appendChild(row);
  }
  row.appendChild(node);
}
