// 「有什么在等你」 (1.5.45 第四步「替你想」): once a day the main assistant says,
// in a few lines, what is waiting for the human - cards to answer (on every
// machine), work done but not looked at, messages waiting for a machine that is
// off. Nothing waiting: nothing said. No model call: it is put together from
// what the hub already knows. On by default at 09:00 (the human's pick,
// 2026-11-20); Settings → 通用 turns it off or moves it.
//
//   buildNudge({cards, unread, queued}) -> text | ''
//   nudgeDue({now, settings, lastDay}) -> boolean
//   dayKey(ms) -> 'YYYY-MM-DD' (local time)

export const DEFAULT_NUDGE = { enabled: true, time: '09:00' };
const SHOW = 3; // items named per kind; the rest are counted

export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function validTime(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

/** It is past the time today and today's note has not been said (a computer that was off says it when back). */
export function nudgeDue({ now = Date.now(), settings = DEFAULT_NUDGE, lastDay = '' } = {}) {
  if (!settings?.enabled) return false;
  const time = validTime(settings.time) || DEFAULT_NUDGE.time;
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  if (d.getHours() * 60 + d.getMinutes() < h * 60 + m) return false;
  return lastDay !== dayKey(now);
}

const where = (i) => (i.machine ? `${i.machine} · ` : '');
const some = (list, fmt) => {
  const named = list.slice(0, SHOW).map(fmt).join('；');
  return list.length > SHOW ? `${named} 等 ${list.length} 个` : named;
};

/**
 * cards:  [{machine?, botName, what}]  approvals waiting (this machine's and the others')
 * unread: [{machine?, name, what?}]    chats with a result not looked at yet
 * queued: [{machine, count}]           messages waiting for a machine that is off
 */
export function buildNudge({ cards = [], unread = [], queued = [], now = Date.now() } = {}) {
  const waitingMsgs = queued.reduce((n, q) => n + (Number(q.count) || 0), 0);
  const total = cards.length + unread.length + waitingMsgs;
  if (!total) return '';
  const h = new Date(now).getHours();
  const hello = h < 11 ? '早上好' : h < 18 ? '你好' : '晚上好';
  const lines = [`${hello}，有 ${total} 件事在等你：`];
  if (cards.length) lines.push(`- ${cards.length} 张卡等你点头：${some(cards, (c) => `${where(c)}${c.botName || '助手'}「${String(c.what || '一个操作').slice(0, 30)}」`)}`);
  if (unread.length) lines.push(`- ${unread.length} 件做完了你还没看：${some(unread, (u) => `${where(u)}${u.name}${u.what ? `「${String(u.what).slice(0, 30)}」` : ''}`)}`);
  for (const q of queued.filter((x) => x.count > 0).slice(0, SHOW)) lines.push(`- ${q.count} 条消息在排队，等「${q.machine}」开机`);
  lines.push('在左边点对应的助手就能看。不想每天收到，可以在「设置 → 主动」里关掉或改时间。');
  return lines.join('\n');
}
