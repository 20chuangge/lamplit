'use strict';
// Lamplit page, part 4b: the sidebar of redesign step 4 (1.5.59) - 「N 件等你」 / 「N 个在做」 filters, the line of a bot whose card waits, each machine in a few words, and the header's count for the chat on screen. Parts share one scope and load in order (scripts/check-page-parts.mjs).

/* --- which rows wait, which work ------------------------------------------ */
/** The chat a sidebar row stands for, as attention keys it: bot:<id> or group:<id> (remote ids carry @machine). */
function rowKey(row) {
  if (row?.dataset?.bot) return `bot:${row.dataset.bot}`;
  if (row?.dataset?.group) return `group:${row.dataset.group}`;
  return '';
}

/** Waits on you: a card to answer, a question, a login, the screen to take over. */
function chatWaits(item) {
  return Boolean(item?.needsYou || item?.asking);
}

/** At work and not waiting on you. */
function chatWorks(item) {
  return Boolean(item?.working) && !chatWaits(item);
}

function rosterFilterMatch(key, filter) {
  const item = attentionItem(key);
  if (filter === 'needs') return chatWaits(item);
  if (filter === 'working') return chatWorks(item);
  return true;
}

/**
 * On top of the list: 「N 件等你」 and 「N 个在做」. A tap shows only those rows,
 * another tap shows all again (in place of 「最近」, which listed the same chats twice).
 */
function renderRosterFilters(list) {
  const rows = [...list.querySelectorAll('.bot, .group')];
  const keys = [...new Set(rows.map(rowKey).filter(Boolean))];
  if (keys.length < 2) { state.rosterFilter = ''; return; }
  const needs = keys.filter((k) => rosterFilterMatch(k, 'needs')).length;
  const working = keys.filter((k) => rosterFilterMatch(k, 'working')).length;
  // Nothing left of what it showed (answered, finished): the whole list again.
  if ((state.rosterFilter === 'needs' && !needs) || (state.rosterFilter === 'working' && !working)) state.rosterFilter = '';
  const bar = el('div', 'roster-filters');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '只看一部分');
  for (const [kind, n] of [['needs', needs], ['working', working]]) {
    const on = state.rosterFilter === kind;
    const b = el('button', `roster-filter ${kind}${on ? ' on' : ''}${n ? '' : ' none'}`, kind === 'needs' ? `${n} 件等你` : `${n} 个在做`);
    // On, it is filled and ends in ✕: pressed at a glance, and how to show all again without a hover (1.5.59 beginner test).
    if (on) b.appendChild(el('span', 'rf-clear', '✕'));
    b.type = 'button';
    b.disabled = !n;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? '再点一下：显示全部' : kind === 'needs' ? '只看等你点头、等你回复的' : '只看正在做事的';
    b.addEventListener('click', () => {
      state.rosterFilter = state.rosterFilter === kind ? '' : kind;
      renderBots();
    });
    bar.appendChild(b);
  }
  const after = list.querySelector('.inbox-row');
  list.insertBefore(bar, after ? after.nextSibling : list.firstChild);
}

/* --- the line of a bot whose card waits: what the card asks ---------------- */
/** The open card of a bot (this machine's or, by bot:<id>@<machine>, another's), as the card's own headline. */
function waitingCardTitle(key) {
  const m = /^bot:(.+)$/.exec(String(key || ''));
  if (!m) return '';
  const far = remoteOf(m[1]);
  const a = far
    ? (state.inbox?.items || []).find((i) => i.machine === far.machine && i.botId === far.botId && i.status !== 'awaiting_human')
    : (state.approvals || []).find((x) => x.botId === m[1] && x.status !== 'awaiting_human');
  if (!a) return '';
  const data = { tool: a.toolName, args: safeParse(a.args), risk: a.risk, ...cardExtras(a), ...(a.batch ? { batch: a.batch } : {}) };
  const many = Array.isArray(a.batch?.commands) && a.batch.commands.length > 1 ? a.batch.commands : null;
  try {
    return cardTitle(data, thinkCardInfo(data) || describeTool(data.tool, data.args), many);
  } catch {
    return '';
  }
}

/* --- each machine in a few words (the machine menu) ------------------------- */
/** A machine's bots and what waits or works there, from the roster; null when it is not known. */
function machineTally(name) {
  const m = rosterChats().find((x) => x.machine === name);
  if (!m) return null;
  const items = [...m.groups, ...m.bots];
  return {
    online: m.online,
    bots: m.bots.length,
    needs: m.online ? items.filter((i) => chatWaits(attentionItem(i.key))).length : 0,
    working: m.online ? items.filter((i) => chatWorks(attentionItem(i.key))).length : 0,
  };
}

/** 「家里一直开着的电脑…」 and 「13 个助手 · 2 件等你 · 1 个在做」 for one machine. */
function machineOverview(name) {
  const t = machineTally(name);
  const note = machineNotesUi?.notes?.[name]?.note || '';
  const counts = t ? [`${t.bots} 个助手`, t.needs ? `${t.needs} 件等你` : '', t.working ? `${t.working} 个在做` : ''].filter(Boolean).join(' · ') : '';
  return { note: note ? shortNote(note, 26) : '', counts, online: t ? t.online : true };
}

/** The menu row's second line: what it is for, then its bots and what waits there. */
function machineOverviewHtml(name) {
  const o = machineOverview(name);
  const parts = [o.note, o.counts].filter(Boolean);
  return parts.length ? `<small class="mm-meta">${escapeHtml(parts.join(' · '))}</small>` : '';
}

/* --- the header's 「N 个操作等你确认」: the chat on screen only -------------- */
/** The open cards of the chat on screen: its bot's, or the group's members' (this machine's and, from the inbox, another's). */
function openChatApprovals() {
  // A routine's parked card counts too, as before: it waits for a 「现在跑一次」.
  const here = state.approvals || [];
  const away = state.inbox?.items || [];
  const idOf = (i) => `${i.botId}@${i.machine}`;
  if (isGroupMode()) {
    const group = groupById(state.groupId);
    const ids = new Set(groupMembers(group).map((b) => b.id));
    return { local: here.filter((a) => ids.has(a.botId)), remote: away.filter((i) => ids.has(idOf(i))) };
  }
  const id = state.botId || '';
  if (isRemoteId(id)) return { local: [], remote: away.filter((i) => idOf(i) === id) };
  return { local: here.filter((a) => a.botId === id), remote: [] };
}
