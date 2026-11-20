// One path to change a bot by talking (1.5.45 第四步「替你想」, the human: 「要可复用的呀」).
// 「让策略以后只看北京的岗位」, 「文案以后用绿色头像」, 「早报改成 9 点」: the main
// assistant changes that bot - on its own machine too. Every change is the same:
// a card with what changes (+ added, - removed, ~ before → after), the human's
// yes, then it is done, and it can be undone. What was there before is kept here.
//
// What can be changed (each part says how to read it, plan it and write it back):
//   role      the job line                           ~ before → after
//   rules     the persona, as lines                  + / -
//   skills    the skills it may use                  + / -
//   avatar    colour and shape                       ~ before → after
//   routines  a routine of that bot: time, on/off    ~ before → after
// A future part plugs in by adding its read / plan / write here.
//
//   planAdjust(bot, changes, {routines}) -> {before, after, lines, roleChange?}
//   createAdjustments({file}) -> {record, get, list, markUndone}
//   undoAdjust(store, id, {getBot, updateBot, listRoutines?, updateRoutine?}) -> {ok, adjustment}

import { readJson, writeJsonAtomic, uid } from './store.mjs';

const KEEP = 50;
const adjError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const lineOf = (s) => String(s || '').replace(/\r/g, '').trim();
const same = (a, b) => lineOf(a).replace(/[。.！!；;，,\s]+$/u, '') === lineOf(b).replace(/[。.！!；;，,\s]+$/u, '');
const strs = (v) => (Array.isArray(v) ? v : []).map(lineOf).filter(Boolean);

/** A schedule in words where it is a simple one (「30 8 * * *」 -> 「每天 8:30」). */
export function scheduleWords(s) {
  const t = String(s || '').trim();
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|6,0)$/.exec(t);
  if (!m) return t;
  const when = `${Number(m[2])}:${String(m[1]).padStart(2, '0')}`;
  return `${m[3] === '*' ? '每天' : m[3] === '1-5' ? '工作日' : '周末'} ${when}`;
}

/**
 * The change, worked out before the card. Throws ADJUST_NOTHING / ADJUST_NO_SUCH_RULE / ADJUST_NO_SUCH_ROUTINE.
 * changes: {role?, addRules?, removeRules?, addSkills?, removeSkills?, avatar?: {color?, shape?}, routine?: {id|name, schedule?, enabled?}}
 */
export function planAdjust(bot, changes = {}, { routines = [] } = {}) {
  const { role, addRules = [], removeRules = [], addSkills = [], removeSkills = [], avatar = null, routine = null } = changes || {};
  const before = { role: String(bot?.role || ''), persona: String(bot?.persona || '') };
  const after = { ...before };
  const diff = [];

  // rules: the persona as lines
  let lines = before.persona.replace(/\r/g, '').split('\n');
  for (const r of strs(removeRules)) {
    const at = lines.findIndex((l) => same(l, r) || (lineOf(l).length > 4 && lineOf(l).includes(r) && r.length >= Math.min(8, lineOf(l).length)));
    if (at < 0) throw adjError('ADJUST_NO_SUCH_RULE', `「${bot?.name || '它'}」的规则里没有「${r.slice(0, 60)}」这一行。现在的规则：${before.persona.slice(0, 400) || '（空）'}`);
    diff.push({ op: '-', text: lineOf(lines[at]) });
    lines.splice(at, 1);
  }
  for (const r of strs(addRules)) {
    if (lines.some((l) => same(l, r))) continue;
    lines.push(r.slice(0, 300));
    diff.push({ op: '+', text: r.slice(0, 300) });
  }
  while (lines.length && !lineOf(lines[lines.length - 1])) lines.pop();
  after.persona = lines.join('\n');

  // role
  const roleText = role === undefined || role === null ? null : lineOf(role).slice(0, 200);
  let roleChange = null;
  if (roleText && roleText !== before.role) { after.role = roleText; roleChange = { from: before.role, to: roleText }; }

  // skills
  const addS = strs(addSkills);
  const remS = strs(removeSkills);
  if (addS.length || remS.length) {
    const had = strs(bot?.skills);
    before.skills = had;
    let next = had.filter((s) => !remS.includes(s));
    for (const s of remS) if (had.includes(s)) diff.push({ op: '-', text: `技能：${s}` });
    for (const s of addS) if (!next.includes(s)) { next = [...next, s]; diff.push({ op: '+', text: `技能：${s}` }); }
    after.skills = next;
    if (JSON.stringify(next) === JSON.stringify(had)) { delete before.skills; delete after.skills; }
  }

  // avatar
  if (avatar && typeof avatar === 'object') {
    const cur = { shape: String(bot?.avatar?.shape || ''), color: String(bot?.avatar?.color || '') };
    const next = { ...cur };
    if (avatar.color && /^#[0-9a-f]{3,8}$/i.test(avatar.color) && avatar.color.toLowerCase() !== cur.color.toLowerCase()) { next.color = avatar.color; diff.push({ op: '~', label: '头像颜色', from: cur.color, to: avatar.color }); }
    if (avatar.shape && /^[a-z][a-z-]{0,23}$/.test(avatar.shape) && avatar.shape !== cur.shape) { next.shape = avatar.shape; diff.push({ op: '~', label: '头像形状', from: cur.shape, to: avatar.shape }); }
    if (next.color !== cur.color || next.shape !== cur.shape) { before.avatar = cur; after.avatar = next; }
  }

  // a routine of this bot
  if (routine && typeof routine === 'object') {
    const want = lineOf(routine.id || routine.name).toLowerCase();
    const mine = (routines || []).filter((r) => !bot?.id || r.botId === bot.id);
    const r = mine.find((x) => String(x.id).toLowerCase() === want) || mine.find((x) => String(x.name).toLowerCase() === want) || mine.find((x) => String(x.name).toLowerCase().includes(want));
    if (!r) throw adjError('ADJUST_NO_SUCH_ROUTINE', `「${bot?.name || '它'}」没有叫「${routine.id || routine.name}」的定时任务；它有：${mine.map((x) => x.name).join('、') || '（没有）'}`);
    const was = { id: r.id, name: r.name, schedule: String(r.schedule || ''), enabled: r.enabled !== false };
    const now = { ...was };
    if (routine.schedule && lineOf(routine.schedule) !== was.schedule) { now.schedule = lineOf(routine.schedule).slice(0, 60); diff.push({ op: '~', label: `定时任务「${r.name}」的时间`, from: scheduleWords(was.schedule), to: now.schedule }); }
    if (typeof routine.enabled === 'boolean' && routine.enabled !== was.enabled) { now.enabled = routine.enabled; diff.push({ op: '~', label: `定时任务「${r.name}」`, from: was.enabled ? '开' : '关', to: routine.enabled ? '开' : '关' }); }
    if (now.schedule !== was.schedule || now.enabled !== was.enabled) { before.routines = [was]; after.routines = [now]; }
  }

  if (!diff.length && !roleChange) throw adjError('ADJUST_NOTHING', '没有要改的：和现在一样。');
  if (after.persona.length > 4000) throw adjError('ADJUST_TOO_LONG', '规则太长了（最多 4000 字），先删掉几条再加。');
  return { before, after, lines: diff, ...(roleChange ? { roleChange } : {}) };
}

/** The bot fields a plan writes (routines are written apart). */
export function botPatchOf(side) {
  const p = { role: side.role, persona: side.persona };
  if (side.skills) p.skills = side.skills;
  if (side.avatar) p.avatar = Object.fromEntries(Object.entries(side.avatar).filter(([, v]) => v));
  return p;
}

export function createAdjustments({ file } = {}) {
  let list = null;
  async function load() {
    if (list) return list;
    const raw = await readJson(file, []).catch(() => []);
    list = Array.isArray(raw) ? raw : [];
    return list;
  }
  return {
    load,
    /** -> id. The newest first in list(). */
    async record({ machine = '', botId, botName = '', before, after, summary = '', lines = [], roleChange = null, by = '' }) {
      await load();
      const item = { id: uid('adj'), at: new Date().toISOString(), machine: String(machine || ''), botId: String(botId), botName: String(botName || botId), before, after, summary: String(summary || '').slice(0, 200), lines: lines.slice(0, 40), ...(roleChange ? { roleChange } : {}), ...(by ? { by } : {}) };
      list.unshift(item);
      list = list.slice(0, KEEP);
      await writeJsonAtomic(file, list);
      return item.id;
    },
    get(id) { return (list || []).find((a) => a.id === id) || null; },
    list() { return [...(list || [])]; },
    async markUndone(id) {
      await load();
      const a = list.find((x) => x.id === id);
      if (a) { a.undoneAt = new Date().toISOString(); await writeJsonAtomic(file, list); }
      return a;
    },
  };
}

/**
 * Put a bot back as it was before one change - every part of it. Done once; if
 * it was changed again since (by hand or another change), it is said so and
 * nothing is overwritten. The functions reach the bot where it lives.
 */
export async function undoAdjust(store, id, { getBot, updateBot, listRoutines = null, updateRoutine = null }) {
  await store.load();
  const a = store.get(id);
  if (!a) throw adjError('ADJUST_NOT_FOUND', '找不到这次修改了（只留最近 50 次）。', 404);
  if (a.undoneAt) throw adjError('ADJUST_ALREADY_UNDONE', `这次修改已经撤销过了（${a.undoneAt.slice(0, 16).replace('T', ' ')}）。`, 409);
  const bot = await getBot(a.botId);
  if (!bot) throw adjError('ADJUST_BOT_GONE', `「${a.botName}」已经不在了，没法撤销。`, 404);
  const changedSince = () => adjError('ADJUST_CHANGED_SINCE', `「${a.botName}」在这之后又被改过，直接撤销会把后来的改动也冲掉，所以没有动。要改回去，跟助理说具体改哪一项。`, 409);
  const norm = (s) => String(s || '').replace(/\r/g, '');
  if (String(bot.role || '') !== String(a.after.role || '') || norm(bot.persona) !== norm(a.after.persona)) throw changedSince();
  if (a.after.skills && JSON.stringify(strs(bot.skills)) !== JSON.stringify(a.after.skills)) throw changedSince();
  if (a.after.avatar && String(bot.avatar?.color || '').toLowerCase() !== String(a.after.avatar.color || '').toLowerCase()) throw changedSince();
  let current = [];
  if (a.after.routines?.length) {
    if (!listRoutines || !updateRoutine) throw adjError('ADJUST_NO_ROUTINES', '这里改不了定时任务，没有撤销。', 400);
    current = await listRoutines(a.botId);
    for (const r of a.after.routines) {
      const live = current.find((x) => x.id === r.id);
      if (!live) throw adjError('ADJUST_ROUTINE_GONE', `定时任务「${r.name}」已经不在了，没法撤销。`, 404);
      if (String(live.schedule) !== String(r.schedule) && scheduleWords(live.schedule) !== r.schedule) throw changedSince();
      if ((live.enabled !== false) !== r.enabled) throw changedSince();
    }
  }
  await updateBot(a.botId, botPatchOf(a.before));
  for (const r of a.before.routines || []) await updateRoutine(r.id, { schedule: r.schedule, enabled: r.enabled });
  await store.markUndone(id);
  return { ok: true, adjustment: store.get(id) };
}
