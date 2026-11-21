// The initiative layer (1.5.45 第四步「替你想」, the human: 「要可复用的呀」).
//
// One place decides when a bot speaks up without being asked. Anything can
// hand it something to say; the layer decides when it is said:
//
//   triggers   a time (the daily note), an event (push: a card waiting long,
//              a machine back, a queued message delivered, a routine that
//              failed, …), a bot's own follow-up (addFollowUp) or a folder it
//              watches (addWatch)
//   rules      only when there is something; several at once are one message
//              (a minute's merge window); at most N a day per bot (the rest
//              waits for the next day); quiet hours if the human set them;
//              a bot or an event switched off says nothing
//   outputs    say(botId, text, {notify}) - a message in that bot's chat and,
//              when the window is not in front, a notification. A follow-up or a
//              watched folder runs a short turn of that bot instead (runTurn):
//              what it sends out still goes through the outgoing gate (drafts).
//
// The human's choices (2026-11-20): the main assistant leads - events are said
// by it; another bot speaks only for its own follow-ups, watched folders and
// routines. No quiet hours by default; 3 a day per bot; notify when the window
// is not in front; the daily 「有什么在等你」 at 09:00.
//
// A future feature plugs in with push({kind, botId?, text, key?}) - and, if it
// is a new kind of event, one line in EVENT_KINDS (and its English name in the
// settings page). Everything else is here.

import { readJson, writeJsonAtomic, uid } from './store.mjs';
import { buildNudge, dayKey, validTime } from './nudge.mjs';

/** Events the layer knows; each can be switched off in 设置 → 主动. */
export const EVENT_KINDS = ['card_waiting', 'machine_back', 'outbox_sent', 'routine_failed'];

export const DEFAULT_INITIATIVE = {
  leader: 'primary',
  bots: {}, // botId -> false when switched off (absent = on)
  quiet: { on: false, from: '22:00', to: '08:00' },
  maxPerDay: 3,
  notify: true,
  events: { card_waiting: true, machine_back: true, outbox_sent: true, routine_failed: true },
  cardWaitMinutes: 60,
  daily: { enabled: true, time: '09:00' },
};

const MERGE_MS = 60 * 1000;
const WATCH_EVERY_MS = 60 * 1000;
const MAX_FOLLOWUPS = 50;
const MAX_WATCHES = 20;
/** Kinds a bot other than the main assistant speaks for itself. */
const OWN_KINDS = new Set(['routine_failed', 'follow_up', 'watch']);

const minutesOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

/** Inside the quiet hours (which may run past midnight)? */
export function inQuiet(quiet, ms) {
  if (!quiet?.on) return false;
  const from = minutesOf(validTime(quiet.from) || '22:00');
  const to = minutesOf(validTime(quiet.to) || '08:00');
  const d = new Date(ms);
  const now = d.getHours() * 60 + d.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

function mergeText(items) {
  if (items.length === 1) return items[0].text;
  // The daily note stays as it is; the rest under it.
  const daily = items.find((i) => i.kind === 'daily');
  if (daily) {
    const rest = items.filter((i) => i !== daily);
    return [daily.text, '另外：', ...rest.map((i) => `- ${String(i.text).replace(/\n+/g, ' ')}`)].join('\n');
  }
  return [`有 ${items.length} 件事告诉你：`, ...items.map((i) => `- ${String(i.text).replace(/\n+/g, ' ')}`)].join('\n');
}

export function createInitiative({ file, bus = null, now = () => Date.now(), primaryId = () => 'chief', say, runTurn = null, waiting = null, listDir = null } = {}) {
  let data = null; // {settings, counts:{botId:{day,n}}, lastDaily, pending:{botId:[item]}, followUps:[], watches:[], cardsSaid:{}}

  async function load() {
    if (data) return data;
    const raw = await readJson(file, {}).catch(() => ({}));
    data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    data.settings = merge(DEFAULT_INITIATIVE, data.settings || {});
    for (const k of ['counts', 'pending', 'cardsSaid']) if (!data[k] || typeof data[k] !== 'object') data[k] = {};
    for (const k of ['followUps', 'watches']) if (!Array.isArray(data[k])) data[k] = [];
    if (bus?.subscribe) bus.subscribe(onEvent);
    return data;
  }
  const save = () => writeJsonAtomic(file, data).catch(() => {});

  function merge(base, over) {
    const out = { ...base, ...over };
    for (const k of ['quiet', 'events', 'daily', 'bots']) out[k] = { ...(base[k] || {}), ...((over || {})[k] || {}) };
    return out;
  }

  const settings = () => JSON.parse(JSON.stringify(data?.settings || DEFAULT_INITIATIVE));
  const botOn = (botId) => data.settings.bots[botId] !== false;
  const leader = () => primaryId() || 'chief';

  /** Something to say. Events go to the main assistant unless it is the bot's own business. */
  function push({ kind = 'event', botId = '', text, key = '' } = {}) {
    if (!data || !String(text || '').trim()) return false;
    if (EVENT_KINDS.includes(kind) && data.settings.events[kind] === false) return false;
    const who = botId && OWN_KINDS.has(kind) ? botId : leader();
    if (!botOn(who)) return false;
    const list = data.pending[who] || (data.pending[who] = []);
    if (key && list.some((i) => i.key === key)) return false;
    list.push({ kind, text: String(text).slice(0, 400), at: now(), ...(key ? { key } : {}) });
    void save();
    return true;
  }

  /** Say what waits for a bot, merged, if the rules let it. */
  async function flush(botId, { force = false } = {}) {
    const list = data.pending[botId] || [];
    if (!list.length) return false;
    if (!botOn(botId)) { delete data.pending[botId]; await save(); return false; }
    if (!force && now() - Math.min(...list.map((i) => i.at)) < MERGE_MS) return false;
    if (inQuiet(data.settings.quiet, now())) return false;
    const today = dayKey(now());
    const c = data.counts[botId]?.day === today ? data.counts[botId] : { day: today, n: 0 };
    if (c.n >= data.settings.maxPerDay) return false;
    data.counts[botId] = { day: today, n: c.n + 1 };
    delete data.pending[botId];
    await save();
    const kind = list.length === 1 ? list[0].kind : 'merged';
    await say(botId, mergeText(list), { kind, notify: data.settings.notify, source: 'initiative' });
    return true;
  }

  // When your page was last open here, not through another machine (1.5.54, walkthrough 3.7: a cloud
  // machine just linked sent its own 「有什么在等你」 about the study's assistant). The daily note comes
  // from a machine you opened in the last week; once you open one, it comes that day.
  const SEEN_FOR_MS = 7 * 24 * 3600 * 1000;
  async function dailyTick() {
    const d = data.settings.daily;
    if (!d?.enabled || !waiting) return;
    const t = now();
    if (!data.seenAt || t - data.seenAt > SEEN_FOR_MS) return;
    const today = dayKey(t);
    if (data.lastDaily === today) return;
    const at = new Date(t);
    if (at.getHours() * 60 + at.getMinutes() < minutesOf(validTime(d.time) || '09:00')) return;
    data.lastDaily = today; // marked first: a failure below does not repeat it every minute
    await save();
    const text = buildNudge({ ...(await waiting()), now: t });
    if (!text) return;
    const who = leader();
    if (!botOn(who)) return;
    // Said at once; what was already waiting for the main assistant joins it (one message). It counts like any other.
    data.pending[who] = [...(data.pending[who] || []), { kind: 'daily', text, at: t }];
    await flush(who, { force: true });
  }

  async function followUpTick() {
    const due = data.followUps.filter((f) => !f.done && f.at <= now());
    for (const f of due) {
      f.done = true;
      await save();
      if (!botOn(f.botId) || !runTurn) continue;
      await runTurn({
        botId: f.botId,
        source: 'followup',
        text: `（你之前约好的回头看，系统按时叫你）${f.about}\n先去看一眼实际情况再说。如果没有值得告诉人的新情况，只回复「没有变化」四个字，别的都不要写。`,
      }).catch(() => {});
    }
    if (data.followUps.length > MAX_FOLLOWUPS) data.followUps = data.followUps.filter((f) => !f.done).slice(-MAX_FOLLOWUPS);
  }

  async function watchTick() {
    if (!listDir) return;
    for (const w of data.watches) {
      if (now() - (w.checkedAt || 0) < WATCH_EVERY_MS) continue;
      w.checkedAt = now();
      let names;
      try { names = await listDir(w.path); } catch { continue; }
      const fresh = names.filter((n) => !w.seen.includes(n));
      w.seen = [...new Set([...w.seen, ...names])].slice(-2000);
      await save();
      if (!fresh.length || !botOn(w.botId) || !runTurn) continue;
      await runTurn({
        botId: w.botId,
        source: 'watch',
        text: `（你盯着的文件夹「${w.path}」里出现了新文件：${fresh.slice(0, 20).join('、')}${fresh.length > 20 ? ` 等 ${fresh.length} 个` : ''}）${w.about}\n如果没有值得告诉人的，只回复「没有变化」四个字。`,
      }).catch(() => {});
    }
  }

  // Events from the hub's bus that the layer turns into words itself.
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'peer.outbox' && ev.state === 'sent' && ev.machine) {
      push({ kind: 'outbox_sent', text: `之前排队等「${ev.machine}」的消息已经交过去了`, key: `outbox:${ev.machine}` });
    }
  }

  return {
    load,
    settings,
    push,
    pending: (botId) => [...(data?.pending?.[botId] || [])],
    followUps: () => [...(data?.followUps || [])],
    watches: () => (data?.watches || []).map(({ seen, ...w }) => w),

    async update(patch = {}) {
      await load();
      const s = data.settings;
      if (patch.bots && typeof patch.bots === 'object') for (const [id, on] of Object.entries(patch.bots)) { if (/^[\w.@-]{1,120}$/.test(id)) { if (on === false) s.bots[id] = false; else delete s.bots[id]; } }
      if (patch.quiet && typeof patch.quiet === 'object') {
        if (typeof patch.quiet.on === 'boolean') s.quiet.on = patch.quiet.on;
        for (const k of ['from', 'to']) if (patch.quiet[k] !== undefined) { const v = validTime(patch.quiet[k]); if (!v) throw Object.assign(new Error('时间写成 22:00 这样'), { code: 'INITIATIVE_BAD_TIME', status: 400 }); s.quiet[k] = v; }
      }
      if (patch.maxPerDay !== undefined) { const n = Math.round(Number(patch.maxPerDay)); if (!(n >= 1 && n <= 20)) throw Object.assign(new Error('每天最多几条：1 到 20'), { code: 'INITIATIVE_BAD_MAX', status: 400 }); s.maxPerDay = n; }
      if (typeof patch.notify === 'boolean') s.notify = patch.notify;
      if (patch.events && typeof patch.events === 'object') for (const k of EVENT_KINDS) if (typeof patch.events[k] === 'boolean') s.events[k] = patch.events[k];
      if (patch.cardWaitMinutes !== undefined) s.cardWaitMinutes = Math.min(Math.max(Math.round(Number(patch.cardWaitMinutes)) || 60, 5), 24 * 60);
      if (patch.daily && typeof patch.daily === 'object') {
        if (typeof patch.daily.enabled === 'boolean') s.daily.enabled = patch.daily.enabled;
        if (patch.daily.time !== undefined) {
          const v = validTime(patch.daily.time);
          if (!v) throw Object.assign(new Error('时间写成 09:00 这样'), { code: 'NUDGE_BAD_TIME', status: 400 });
          // Moved: today's note can still come at the new time.
          if (v !== s.daily.time) delete data.lastDaily;
          s.daily.time = v;
        }
      }
      await save();
      return settings();
    },

    /** A bot comes back by itself later (「明天提醒他看结果」). */
    async addFollowUp({ botId, at, about, by = '' }) {
      await load();
      const when = Number(at);
      if (!botId || !Number.isFinite(when)) throw Object.assign(new Error('follow-up needs a bot and a time'), { code: 'FOLLOWUP_INVALID', status: 400 });
      const open = data.followUps.filter((f) => !f.done && f.botId === botId);
      if (open.length >= 10) throw Object.assign(new Error('这个助手已经约了 10 件回头看的事，先等它们到点'), { code: 'FOLLOWUP_FULL', status: 400 });
      const f = { id: uid('fu'), botId: String(botId), at: when, about: String(about || '').slice(0, 300), ...(by ? { by } : {}), createdAt: new Date(now()).toISOString() };
      data.followUps.push(f);
      await save();
      return f;
    },

    async cancelFollowUp(id) {
      await load();
      const f = data.followUps.find((x) => x.id === id);
      if (f) { f.done = true; f.cancelled = true; await save(); }
      return f || null;
    },

    /** A bot watches a folder: a new file there wakes it. What is there now does not count. */
    async addWatch({ botId, path, about }) {
      await load();
      if (data.watches.filter((w) => w.botId === botId).length >= 5) throw Object.assign(new Error('一个助手最多盯 5 个文件夹'), { code: 'WATCH_FULL', status: 400 });
      if (data.watches.length >= MAX_WATCHES) throw Object.assign(new Error('盯着的文件夹太多了'), { code: 'WATCH_FULL', status: 400 });
      const existing = data.watches.find((w) => w.botId === botId && w.path === path);
      const seen = listDir ? await listDir(path).catch(() => []) : [];
      if (existing) { existing.about = String(about || '').slice(0, 300); existing.seen = seen; await save(); return { ...existing, seen: undefined }; }
      const w = { id: uid('watch'), botId: String(botId), path: String(path), about: String(about || '').slice(0, 300), seen, checkedAt: now() };
      data.watches.push(w);
      await save();
      return { id: w.id, botId: w.botId, path: w.path, about: w.about };
    },

    async removeWatch(id) {
      await load();
      const n = data.watches.length;
      data.watches = data.watches.filter((w) => w.id !== id);
      if (data.watches.length !== n) await save();
      return data.watches.length !== n;
    },

    /** A card answered or gone: it may be mentioned again if it ever waits again (it will not). */
    cardSaid(id) { return Boolean(data?.cardsSaid?.[id]); },
    async markCardSaid(id) { data.cardsSaid[id] = now(); const keep = Object.entries(data.cardsSaid).sort((a, b) => b[1] - a[1]).slice(0, 300); data.cardsSaid = Object.fromEntries(keep); await save(); },

    /** Your page opened here (not through another machine): this machine may say the daily note. */
    async seenHere() {
      await load();
      const t = now();
      if (data.seenAt && t - data.seenAt < 3600 * 1000) { data.seenAt = t; return; }
      data.seenAt = t;
      await save();
    },

    /** Once a minute: the daily note, follow-ups, watched folders, then what waits to be said. */
    async tick() {
      await load();
      await dailyTick();
      await followUpTick();
      await watchTick();
      for (const botId of Object.keys(data.pending)) await flush(botId);
    },
  };
}
