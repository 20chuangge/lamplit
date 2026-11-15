'use strict';
// Lamplit page, part 3 of 12: groups - sidebar groups, confirm dialog, group transcript, task board, new group. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   groups
   The server may not have /api/groups yet: every call degrades to a quiet
   note instead of an error, and the 1:1 UI keeps working untouched.
   --------------------------------------------------------------------- */
function isGroupMode() {
  return Boolean(state.groupId);
}

function botById(id) {
  return state.bots.find((b) => b.id === id) || null;
}

function groupById(id) {
  return state.groups.find((g) => g.id === id) || null;
}

/** A member of the open group by id - also one that lives on another machine ("botId@machine"). */
function groupMemberById(id) {
  const group = groupById(state.groupId);
  const m = (group?.members || []).find((x) => x && typeof x === 'object' && x.id === id);
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

function stackOf(bots, size = 30, onPick = null, max = 3) {
  const stack = el('div', 'stack');
  for (const bot of bots.slice(0, max)) {
    const cell = el('div', 'stack-cell');
    const av = avatarNode(bot, size);
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

  for (const group of state.groups) {
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
    const preview = (group.preview && group.preview.text && plainPreview(group.preview.text))
      || (members.length ? `${members.length} 位成员 · ${members.map((b) => b.name).join('、')}` : '还没有消息');
    text.appendChild(el('div', 'bot-preview', preview));
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
    list.appendChild(row);
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
  closeSidebar();
  closePanel();
  renderBots();
  renderGroups();
  renderGroupHead(group);
  updateComposerMode();
  await loadGroupMessages();
  connectStream();
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
  try {
    const items = await api(`/api/groups/${encodeURIComponent(groupId)}/messages?limit=200`);
    if (state.groupId !== groupId) return;
    state.groupMessages = Array.isArray(items) ? items : (items && items.messages) || [];
  } catch (err) {
    if (err.status === 401) return;
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
    return botById(item.from) || far || { id: item.from, name: item.name || item.from };
  }
  if (item.botId) return botById(item.botId) || { id: item.botId, name: item.name || item.botId };
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
  messagesEl.innerHTML = '';
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
  const url = isGroupMode() && state.groupId ? `/api/groups/${encodeURIComponent(state.groupId)}/plans/${encodeURIComponent(planId)}`
    : state.botId ? `/api/bots/${encodeURIComponent(state.botId)}/plans/${encodeURIComponent(planId)}` : '';
  if (known) fillPlanCard(card, known);
  else if (url) {
    api(url)
      .then((r) => { if (r?.plan) { state.plans.set(planId, r.plan); fillPlanCard(card, r.plan); } })
      .catch(() => {});
  }
  return card;
}

function fillPlanCard(card, plan) {
  card.innerHTML = '';
  const solo = plan.kind === 'task';
  const done = plan.tasks.filter((t) => t.status === 'done').length;
  const head = el('div', 'plan-head');
  head.appendChild(el('span', 'plan-title', solo ? `任务：${plan.goal || ''}` : '任务板'));
  const overall = plan.status === 'done' ? '已完成' : plan.status === 'waiting' ? '等你回复' : plan.status === 'stopped' ? '已停止'
    : plan.status === 'stalled' ? '停下了，等你说继续' : plan.status === 'replaced' ? '已换成新计划' : '进行中';
  head.appendChild(el('span', `plan-progress${plan.status === 'running' ? ' live' : ''}`, `${done}/${plan.tasks.length} · ${overall}`));
  card.appendChild(head);
  const bar = el('div', 'plan-bar');
  const fill = el('i');
  fill.style.width = `${plan.tasks.length ? Math.round((done / plan.tasks.length) * 100) : 0}%`;
  bar.appendChild(fill);
  card.appendChild(bar);
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
    card.appendChild(row);
  });
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
  if (kind === 'approval') {
    return groupSenderRow(sender, buildApprovalCard({
      approvalId: item.approvalId || item.id,
      tool: item.tool || item.name,
      risk: item.risk,
      reason: item.reason,
      args: safeParse(item.args),
      decision: item.decision,
      note: item.note,
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
  $('group-title').textContent = group ? '群组详情' : '新建群组';
  $('group-create').textContent = group ? '保存' : '创建群组';
  $('group-delete').hidden = !group;
  $('group-name').value = state.groupDraft.name;
  $('group-note').hidden = true;
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

function renderGroupModal() {
  const draft = state.groupDraft;
  const grid = $('group-member-grid');
  grid.innerHTML = '';
  for (const bot of state.bots) {
    const on = draft.members.includes(bot.id);
    const card = el('button', `member-card${on ? ' on' : ''}`);
    card.type = 'button';
    card.disabled = !on && draft.members.length >= 6;
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.appendChild(avatarNode(bot, 36));
    const text = el('div', 'mc-text');
    text.appendChild(el('div', 'mc-name', bot.name));
    text.appendChild(el('div', 'mc-role', bot.role || '—'));
    card.appendChild(text);
    card.addEventListener('click', () => toggleGroupMember(bot.id));
    grid.appendChild(card);
  }
  // Members on other machines: already in this group, or offered by the machines reachable now.
  const farKnown = new Map((state.remoteBots || []).map((b) => [b.id, b]));
  for (const m of (groupById(draft.id)?.members || [])) if (m?.machine && !farKnown.has(m.id)) farKnown.set(m.id, m);
  for (const bot of farKnown.values()) {
    const on = draft.members.includes(bot.id);
    const card = el('button', `member-card${on ? ' on' : ''}`);
    card.type = 'button';
    card.disabled = !on && draft.members.length >= 6;
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    card.appendChild(avatarNode(bot, 36));
    const text = el('div', 'mc-text');
    text.appendChild(el('div', 'mc-name', bot.name));
    text.appendChild(el('div', 'mc-role', `在「${bot.machine}」上${bot.role ? ` · ${bot.role}` : ''}`));
    card.appendChild(text);
    card.addEventListener('click', () => toggleGroupMember(bot.id));
    grid.appendChild(card);
  }

  $('group-member-count').textContent = `${draft.members.length}/6`;

  const coord = $('group-coord-row');
  coord.innerHTML = '';
  const chosen = draft.members.map((id) => botById(id)).filter(Boolean);
  if (!chosen.length) {
    coord.appendChild(el('span', 'muted tiny', '先选成员，再选协调者。'));
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

  const hasLocal = draft.members.some((id) => !String(id).includes('@'));
  const valid = draft.name.trim().length > 0 && draft.members.length >= 2 && hasLocal;
  if (draft.members.length >= 2 && !hasLocal) coord.appendChild(el('span', 'muted tiny', '至少要有一位这台机器上的机器人来协调。'));
  $('group-create').disabled = !valid;
  $('group-name').value = draft.name;
}

function toggleGroupMember(botId) {
  const draft = state.groupDraft;
  const index = draft.members.indexOf(botId);
  if (index >= 0) {
    draft.members.splice(index, 1);
    if (draft.coordinatorId === botId) draft.coordinatorId = draft.members.find((id) => !String(id).includes('@')) || null;
  } else {
    if (draft.members.length >= 6) { toast('一个群最多 6 位成员', true); return; }
    draft.members.push(botId);
    if (!draft.coordinatorId && !String(botId).includes('@')) draft.coordinatorId = botId;
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

