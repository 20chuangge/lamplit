// Sidebar status: which bot or group is working, needs the human, or has a
// result the human has not looked at yet.
//
// Keys are "bot:<id>" (a 1:1 chat) or "group:<id>". Everything is derived
// from the event bus, so the tracker never has to be told about a turn:
//   working   turn.start .. turn.end (in memory: a restart ends every turn)
//   needsYou  an approval card is open, or the turn ended waiting for a login
//             or a takeover (kept until that chat's next turn starts)
//   unread    a turn ended after the human last looked at that chat
//   failed    the last turn ended stuck (the model failed, an error or a timeout,
//             the day's budget, no progress, the step limit), kept until that
//             chat's next turn starts
//             (redesign step 2: the avatar's 出错了 face)
// "Looked at" is POST /api/attention/seen from whichever window shows the chat,
// so a phone and the desktop agree. Seen times and waits survive a restart.
//
// The line under each name (1.5.40) says what that is, from the same events:
//   doing  the step of its checklist or task board and how far it is, else the
//          request it is working on, else the tool it is running
//   ask    the step an open approval card asks about
//   asking the question a step of its checklist or board waits on the human for

import fsp from 'node:fs/promises';

/** Turn endings that mean it got stuck (not a stop the human asked for, not a wait). */
export const STUCK_STATUSES = new Set(['failed', 'error', 'timeout', 'budget', 'stalled', 'max_steps']);

const keyOf = (ev) => (ev.groupId ? `group:${ev.groupId}` : ev.botId ? `bot:${ev.botId}` : null);

/** What a turn was asked, as one short line; nothing for the runtime's own notes ("（任务继续…"). */
export function requestLine(text) {
  let t = String(text || '').split('\n\n[附件]')[0].replace(/\s+/g, ' ').trim();
  const quoted = /用户原话[：:]\s*「?(.+?)」?[）)]?$/.exec(t);
  if (quoted) t = quoted[1].trim();
  if (!t || /^[（(]/.test(t)) return '';
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** A checklist or a group's board, as the status line needs it; null once it is over. */
export function planProgress(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!tasks.length || !['running', 'waiting'].includes(plan.status)) return null;
  const count = (...states) => tasks.filter((t) => states.includes(t.status)).length;
  const now = tasks.find((t) => t.status === 'doing') || tasks.find((t) => t.status === 'waiting_human') || tasks.find((t) => t.status === 'todo');
  const blocked = tasks.find((t) => t.status === 'waiting_human');
  return {
    step: String(now?.title || plan.goal || '').slice(0, 80),
    done: count('done', 'skipped'),
    total: tasks.length,
    // Being worked through now. A list parked for the human (a question, or a card a new
    // message closed) is not what the bot is doing: its steps are not shown as progress.
    live: plan.status === 'running',
    ...(blocked ? { waiting: count('waiting_human'), question: String(blocked.question || blocked.title || '').replace(/\s+/g, ' ').slice(0, 160) } : {}),
    // A bot's own checklist parked on the human (a card a new message closed, a
    // question in its reply) with no step marked as the question (1.5.41).
    ...(!blocked && plan.status === 'waiting' ? { held: true } : {}),
  };
}

export function createAttention({ file, bus, pending = null }) {
  const working = new Map();      // key -> Set(turnId)
  const approvals = new Map();    // approvalId -> key
  const prevResult = new Map();   // key -> result time before the last turn ended
  const asks = new Map();         // approvalId -> {tool, botId, botName, count?}
  const doing = new Map();        // key -> {text, tool} of the work in progress
  const plans = new Map();        // key -> planProgress() of its open checklist / board
  let saved = { seen: {}, result: {}, waiting: {}, failed: {} };
  let saveTimer = null;
  let changeTimer = null;

  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fsp.writeFile(file, JSON.stringify(saved, null, 2), 'utf8').catch(() => {});
    }, 300);
    if (typeof saveTimer?.unref === 'function') saveTimer.unref();
  };

  // Several events land in the same instant (turn.end + message): one notice.
  const changed = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => bus.emit({ type: 'attention.changed' }), 150);
    if (typeof changeTimer?.unref === 'function') changeTimer.unref();
  };

  /**
   * The cards still open, from the approval queue itself when there is one
   * (1.5.41): a card that outlived a restart had no event here, so the header
   * said 「1 个操作等你确认」 and no bot in the list was marked; and a card
   * answered without an event (after a restart, a routine's) stays marked no longer.
   */
  function syncApprovals() {
    if (typeof pending !== 'function') return;
    let live;
    try { live = pending() || []; } catch { return; }
    const ids = new Set(live.map((r) => r.id));
    for (const id of [...approvals.keys()]) if (!ids.has(id)) { approvals.delete(id); asks.delete(id); }
    for (const r of live) {
      if (!r?.id || !r.botId || approvals.has(r.id)) continue;
      approvals.set(r.id, r.groupId ? `group:${r.groupId}` : `bot:${r.botId}`);
      asks.set(r.id, { tool: String(r.toolName || ''), botId: r.botId, botName: '' });
    }
  }

  /** A bot or group was deleted: drop what it left behind. */
  function forget(key) {
    delete saved.seen[key];
    delete saved.result[key];
    delete saved.waiting[key];
    delete saved.failed[key];
    working.delete(key);
    doing.delete(key);
    plans.delete(key);
    for (const [id, k] of approvals) if (k === key) { approvals.delete(id); asks.delete(id); }
    persist();
    changed();
  }

  function onEvent(ev) {
    if (!ev || ev.type === 'attention.changed') return;
    const key = keyOf(ev);
    switch (ev.type) {
      case 'turn.start': {
        if (!key) return;
        if (!working.has(key)) working.set(key, new Set());
        working.get(key).add(ev.turnId || 'turn');
        // The first turn's request names the work; an answer in passing does not replace it.
        if (!ev.aside && !doing.get(key)?.text) doing.set(key, { ...doing.get(key), text: requestLine(ev.text) });
        // The human answered (or something else started a turn here): the
        // wait for a login or a takeover is over.
        if (saved.waiting[key] || saved.failed[key]) { delete saved.waiting[key]; delete saved.failed[key]; persist(); }
        changed();
        break;
      }
      case 'turn.end': {
        if (!key) return;
        const set = working.get(key);
        if (set) { set.delete(ev.turnId || 'turn'); if (!set.size) working.delete(key); }
        if (!working.has(key)) doing.delete(key);
        // A turn a teammate handed to another bot is still that bot's result.
        prevResult.set(key, saved.result[key] || 0);
        saved.result[key] = Date.parse(ev.ts) || Date.now();
        if (ev.waitingFor) saved.waiting[key] = { kind: ev.waitingFor, text: String(ev.waitingText || ev.summary || '').slice(0, 300) };
        // The chat's last turn is what its face shows: stuck, or fine again.
        if (!working.has(key)) {
          if (STUCK_STATUSES.has(ev.status)) saved.failed[key] = { status: ev.status };
          else delete saved.failed[key];
        }
        persist();
        changed();
        break;
      }
      case 'approval.request':
        if (!key || !ev.approvalId) return;
        approvals.set(ev.approvalId, key);
        asks.set(ev.approvalId, { tool: String(ev.tool || ''), botId: ev.botId || '', botName: ev.botName || '', ...(ev.batch?.commands?.length > 1 ? { count: ev.batch.commands.length } : {}) });
        changed();
        break;
      case 'approval.decided':
      case 'approval.resolved':
        asks.delete(ev.approvalId);
        if (ev.approvalId && approvals.delete(ev.approvalId)) changed();
        break;
      case 'tool.call': {
        // Only when the line has nothing better to say (no checklist, no request).
        if (!key || !working.has(key)) return;
        const d = doing.get(key) || {};
        if (d.tool === ev.name) return;
        doing.set(key, { ...d, tool: String(ev.name || '') });
        if (!d.text && !plans.has(key)) changed();
        break;
      }
      case 'bot.plan':
      case 'group.plan': {
        const planKey = ev.type === 'group.plan' ? (ev.groupId ? `group:${ev.groupId}` : null) : (ev.botId ? `bot:${ev.botId}` : null);
        if (!planKey) return;
        const next = planProgress(ev.plan);
        const before = JSON.stringify(plans.get(planKey) || null);
        if (next) plans.set(planKey, next); else plans.delete(planKey);
        if (before !== JSON.stringify(next)) changed();
        break;
      }
      case 'roster.changed':
        // A deleted bot or group must not keep a badge on the sidebar.
        if (ev.action === 'delete' && key) { forget(key); break; }
        changed();
        break;
      default:
        break;
    }
  }

  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        saved = { seen: data.seen || {}, result: data.result || {}, waiting: data.waiting || {}, failed: data.failed || {} };
      } catch { /* first run */ }
      bus.subscribe(onEvent);
    },

    /** -> {items: {key: {working, needsYou, unread, failed?, waiting?, doing?, ask?, asking?}}, needsYou, unread, working} */
    snapshot() {
      syncApprovals();
      const asking = [...plans].filter(([, p]) => p.waiting || p.held).map(([k]) => k);
      const keys = new Set([...working.keys(), ...approvals.values(), ...Object.keys(saved.waiting), ...Object.keys(saved.result), ...Object.keys(saved.failed), ...asking]);
      const items = {};
      const totals = { needsYou: 0, unread: 0, working: 0 };
      for (const key of keys) {
        const open = [...approvals.values()].filter((k) => k === key).length;
        const item = {
          working: working.has(key),
          needsYou: open > 0 || Boolean(saved.waiting[key]),
          unread: (saved.result[key] || 0) > (saved.seen[key] || 0),
        };
        if (open) item.approvals = open;
        if (saved.waiting[key]) item.waiting = saved.waiting[key];
        if (saved.failed[key] && !item.working) item.failed = saved.failed[key];
        // A step that waits for the human's answer: said on the line (not counted as needsYou).
        const plan = plans.get(key);
        if (plan?.waiting) item.asking = { question: plan.question || '', count: plan.waiting };
        // A parked checklist of its own waits on your reply - unless the bot is busy with something else now.
        else if (plan?.held && !working.has(key)) item.asking = { question: '', count: 1 };
        if (!item.working && !item.needsYou && !item.unread && !item.asking && !item.failed) continue;
        if (open) {
          const [firstId] = [...approvals].find(([, k]) => k === key) || [];
          if (asks.has(firstId)) item.ask = asks.get(firstId);
        }
        if (item.working) {
          // The checklist's step only while the list is being worked through (a parked one is not what it does now).
          const { question, waiting, live, ...progress } = plan || {};
          const d = { ...(live ? { ...progress, ...(waiting ? { waiting } : {}) } : {}), ...(doing.get(key)?.text ? { text: doing.get(key).text } : {}), ...(doing.get(key)?.tool ? { tool: doing.get(key).tool } : {}) };
          if (Object.keys(d).length) item.doing = d;
        }
        items[key] = item;
        if (item.needsYou) totals.needsYou += 1;
        if (item.unread) totals.unread += 1;
        if (item.working) totals.working += 1;
      }
      return { items, ...totals };
    },

    /** The human is looking at this chat now. */
    seen(key) {
      if (!/^(bot|group):[\w.-]{1,80}$/.test(String(key || ''))) return false;
      const before = (saved.result[key] || 0) > (saved.seen[key] || 0);
      saved.seen[key] = Date.now();
      persist();
      if (before) changed();
      return true;
    },

    forget,

    /** The last turn there had nothing new (a quiet routine run): no "new result" for it. */
    quiet(key) {
      if (!prevResult.has(key)) return false;
      const before = (saved.result[key] || 0) > (saved.seen[key] || 0);
      saved.result[key] = prevResult.get(key);
      if (!saved.result[key]) delete saved.result[key];
      persist();
      if (before) changed();
      return true;
    },

    /** Drop every key that is not a live bot or group (left from older versions). */
    prune(liveKeys) {
      const live = new Set(liveKeys);
      const stale = new Set([...Object.keys(saved.seen), ...Object.keys(saved.result), ...Object.keys(saved.waiting), ...Object.keys(saved.failed)].filter((k) => !live.has(k)));
      for (const key of stale) forget(key);
      return stale.size;
    },
  };
}
