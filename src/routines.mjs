/**
 * routines.mjs - "run this instruction with this bot on this schedule".
 *
 * Two schedule shapes:
 *   "every 30 minutes"      fixed interval
 *   "0 9 * * 1-5"           5-field cron (minute hour day-of-month month day-of-week)
 *
 * Timezones matter, so cron fields are interpreted in the routine's own IANA
 * timezone via Intl - no dependency, no UTC-only hand-wave. The tick loop runs
 * every 20s and only fires routines whose nextRun has passed, so a machine that
 * was asleep catches up on the next tick rather than replaying history.
 *
 * Unattended runs are deliberately stricter: a routine that hits a HIGH-risk
 * tool does not wait for a human for ten minutes. It parks the approval card,
 * ends the run as "needs_approval", and says so in the chat.
 */

import { P, readJson, writeJsonAtomic, uid, nowIso } from './store.mjs';
import { isPeakTime } from './usage.mjs';

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function cronError(message) {
  // A schedule typed wrong is the request's fault (400, 1.5.32: it was a 500 in English).
  // The parser's own words stay for the logs; the person reads how to write it (1.5.33: an English line was in the middle).
  const err = new Error('时间的写法不对。可以这样写：每天 9:00、工作日 8:30、每周五 18:00、每月 1 号 10:00、每 30 分钟、每 2 小时；也认 cron（0 8 * * 1-5）和 once 2026-12-01 09:00（只跑一次）。');
  err.detail = message;
  err.code = 'CRON_INVALID';
  err.status = 400;
  return err;
}

/**
 * Parse one cron field into a Set of integers.
 * Supports: *, N, a-b, a-b/n, * /n, N/n, and comma lists. Names allowed for
 * month (jan..dec) and day-of-week (sun..sat).
 */
export function parseCronField(expr, { min, max, names = null, field = 'field' } = {}) {
  const raw = String(expr || '').trim();
  if (!raw) throw cronError(`cron ${field} is empty`);

  const values = new Set();
  for (const part of raw.split(',')) {
    const chunk = part.trim();
    if (!chunk) throw cronError(`cron ${field} has an empty list item`);

    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw cronError(`cron ${field} has a bad step "${stepPart}"`);

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = valueOf(a, { names, field });
      hi = valueOf(b, { names, field });
    } else {
      lo = valueOf(rangePart, { names, field });
      // "5/15" means every 15 starting at 5, i.e. 5-max.
      hi = stepPart === undefined ? lo : max;
    }

    if (lo < min || hi > max || lo > hi) {
      throw cronError(`cron ${field} "${chunk}" is out of range (${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw cronError(`cron ${field} matched nothing`);
  return values;
}

function valueOf(token, { names, field }) {
  const lower = String(token || '').toLowerCase().trim();
  if (names) {
    const idx = names.indexOf(lower);
    if (idx !== -1) return field === 'month' ? idx + 1 : idx;
  }
  const num = Number(lower);
  if (!Number.isInteger(num)) throw cronError(`cron ${field} has a non-numeric value "${token}"`);
  return num;
}

/** Parse a full 5-field expression. Throws {code:'CRON_INVALID'} on nonsense. */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw cronError(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    kind: 'cron',
    expression: parts.join(' '),
    minutes: parseCronField(minute, { min: 0, max: 59, field: 'minute' }),
    hours: parseCronField(hour, { min: 0, max: 23, field: 'hour' }),
    days: parseCronField(dom, { min: 1, max: 31, field: 'day-of-month' }),
    months: parseCronField(month, { min: 1, max: 12, names: MONTH_NAMES, field: 'month' }),
    // 7 is an accepted alias for Sunday.
    weekdays: new Set([...parseCronField(dow, { min: 0, max: 7, names: DOW_NAMES, field: 'weekday' })].map((d) => (d === 7 ? 0 : d))),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** Parse "every N minutes|hours|seconds" into a normalized interval. */
export function parseInterval(spec) {
  const m = String(spec || '')
    .trim()
    .match(/^every\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)$/i);
  if (!m) {
    throw cronError('interval schedules look like "every 30 minutes" or "every 2 hours"');
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) throw cronError('interval must be a positive number');
  const unit = m[2].toLowerCase();
  const unitMs = unit.startsWith('s') ? 1000 : unit.startsWith('h') ? 3600000 : 60000;
  const intervalMs = n * unitMs;
  if (intervalMs < 5000) throw cronError('interval must be at least 5 seconds');
  return { kind: 'interval', intervalMs, expression: `every ${n} ${unit.startsWith('s') ? 'seconds' : unit.startsWith('h') ? 'hours' : 'minutes'}` };
}

/**
 * "once 2026-11-17 18:05" (1.2.166): one run at that wall-clock time in the
 * routine's timezone, then the routine switches itself off. Before this a
 * reminder for one day had to be a yearly cron (选题, 11-15).
 */
export function parseOnce(spec) {
  const m = String(spec || '').trim().match(/^(?:once|at)\s+(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/i);
  if (!m) throw cronError('a single run looks like "once 2026-11-17 18:05"');
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw cronError(`"${spec}" is not a real date and time`);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return { kind: 'once', year, month, day, hour, minute, expression: `once ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}` };
}

/**
 * A time said the way people say it (1.5.33): 每天 9:00, 每天早上9点半, 工作日 8:30,
 * 周末 10点, 每周一、三、五 18:00, 每月 1 号 10:00, 每 30 分钟, 每隔 2 小时, 每小时.
 * -> the same in the forms below ("every 30 minutes", a cron line), or null.
 */
export function chineseSchedule(spec) {
  const s = String(spec || '').trim().replace(/\s+/g, ' ');
  if (!/[\u4e00-\u9fff]/.test(s)) return null;
  const num = (t) => {
    const cn = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (/^\d+$/.test(t)) return Number(t);
    if (/^十([一二三四五六七八九])?$/.test(t)) return 10 + (cn[t[1]] || 0);
    if (/^([一二三四五六七八九])十([一二三四五六七八九])?$/.test(t)) return cn[t[0]] * 10 + (cn[t[2]] || 0);
    return cn[t] ?? NaN;
  };
  const every = /^每(?:隔)?\s*([\d一二两三四五六七八九十]+)?\s*(分钟|小时|个小时)$/.exec(s);
  if (every) {
    const n = every[1] ? num(every[1]) : 1;
    return Number.isInteger(n) && n > 0 ? `every ${n} ${every[2] === '分钟' ? 'minutes' : 'hours'}` : null;
  }
  // The time of day: 9:00, 9：30, 9点, 9点半, 9点15(分), with 早上/上午/中午/下午/晚上 in front.
  const t = /(早上|上午|中午|下午|晚上|傍晚|凌晨)?\s*([\d一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|[\d一二三四五六七八九十]{1,3})?\s*分?)/.exec(s);
  if (!t) return null;
  let hour = num(t[2]);
  const minute = t[3] !== undefined ? Number(t[3]) : t[4] === '半' ? 30 : t[4] ? num(t[4]) : 0;
  if (/下午|晚上|傍晚/.test(t[1] || '') && hour < 12) hour += 12;
  if (t[1] === '中午' && hour < 11) hour += 12;
  if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) return null;
  const day = s.slice(0, t.index);
  const wk = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  let dom = '*';
  let dow = '*';
  const month = /每月\s*([\d一二三四五六七八九十]{1,3})\s*[号日]/.exec(day);
  const weekly = /(?:每周|每星期|每个?礼拜|周|星期)([一二三四五六日天、，,和及\s]+)/.exec(day);
  if (month) {
    const d = num(month[1]);
    if (!(d >= 1 && d <= 31)) return null;
    dom = String(d);
  } else if (/工作日|周一到周五|星期一到星期五/.test(day)) dow = '1-5';
  else if (/周末|星期六日|周六日/.test(day)) dow = '0,6';
  else if (weekly) {
    const days = [...weekly[1]].filter((c) => c in wk).map((c) => wk[c]);
    if (!days.length) return null;
    dow = [...new Set(days)].sort((a, b) => a - b).join(',');
  } else if (!/每天|每日|天天|每晚|每早|^\s*(早上|上午|中午|下午|晚上|傍晚|凌晨)?\s*$/.test(day)) return null;
  return `${minute} ${hour} ${dom} * ${dow}`;
}

/** Accepts either shape and returns a normalized schedule descriptor. */
export function parseSchedule(spec) {
  let text = String(spec || '').trim();
  if (!text) throw cronError('schedule is required');
  text = chineseSchedule(text) || text;
  if (/[\u4e00-\u9fff]/.test(text)) throw cronError(`not understood: ${text}`);
  if (/^every\b/i.test(text)) return parseInterval(text);
  if (/^(once|at)\b/i.test(text)) return parseOnce(text);
  return parseCron(text);
}

// ---------------------------------------------------------------------------
// Timezone-aware time math
// ---------------------------------------------------------------------------

const formatterCache = new Map();

function formatterFor(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone) {
  // Intl accepts undefined and silently falls back to the machine timezone, so
  // an explicit non-empty string check comes first.
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a given timezone. */
export function tzParts(ts, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl renders midnight as 24 in some ICU builds; normalize it.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of a timezone at a given instant: localWallClock - utc. */
function tzOffsetMs(ts, timeZone) {
  const p = tzParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Convert a naive wall-clock instant (ms, as if it were UTC) to a real UTC
 * instant. Two passes handle DST edges well enough for scheduling.
 */
function localToUtc(naiveMs, timeZone) {
  const offset = tzOffsetMs(naiveMs, timeZone);
  let utc = naiveMs - offset;
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = naiveMs - offset2;
  return utc;
}

/**
 * Next fire time for a schedule, strictly after `fromTs`.
 * Returns epoch ms, or null if nothing matches within ~1 year.
 */
export function nextRunFor(schedule, fromTs, timeZone = 'UTC') {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const from = Number(fromTs) || Date.now();

  if (schedule.kind === 'interval') {
    return from + schedule.intervalMs;
  }
  if (schedule.kind === 'once') {
    const at = localToUtc(Date.UTC(schedule.year, schedule.month - 1, schedule.day, schedule.hour, schedule.minute), tz);
    return at > from ? at : null;
  }

  // Start at the next wall-clock minute in the target timezone.
  const p = tzParts(from, tz);
  let naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) + 60000;

  const MAX_MINUTES = 366 * 24 * 60;
  for (let i = 0; i < MAX_MINUTES; i += 1) {
    const probe = new Date(naive);
    const month = probe.getUTCMonth() + 1;
    const day = probe.getUTCDate();
    const hour = probe.getUTCHours();
    const minute = probe.getUTCMinutes();
    const weekday = probe.getUTCDay();

    if (!schedule.months.has(month)) {
      // Jump to the first minute of the next month.
      naive = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 1, 0, 0);
      continue;
    }

    const dayOk = dayMatches(schedule, day, weekday);
    if (!dayOk) {
      // Skip the whole day; big win for "0 9 * * 1" style schedules.
      naive = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate() + 1, 0, 0);
      continue;
    }

    if (!schedule.hours.has(hour)) {
      naive = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), hour + 1, 0);
      continue;
    }

    if (!schedule.minutes.has(minute)) {
      naive += 60000;
      continue;
    }

    const utc = localToUtc(naive, tz);
    if (utc > from) return utc;
    naive += 60000;
  }
  return null;
}

/** Vixie cron semantics: when both dom and dow are restricted, either may match. */
function dayMatches(schedule, day, weekday) {
  const domOk = schedule.days.has(day);
  const dowOk = schedule.weekdays.has(weekday);
  if (schedule.domRestricted && schedule.dowRestricted) return domOk || dowOk;
  if (schedule.domRestricted) return domOk;
  if (schedule.dowRestricted) return dowOk;
  return true;
}

/**
 * The off-peak option (1.5.50, S2): DeepSeek's peak hours are weekdays 9-12 and
 * 14-18 Beijing time (usage.mjs isPeakTime); the rest is half price. A run due
 * in them moves to the next off-peak start - 12:00 or 18:00 the same day. ms -> ms.
 */
export function offPeakAfter(ms) {
  if (!Number.isFinite(ms) || !isPeakTime(new Date(ms).toISOString())) return ms;
  const bj = new Date(ms + 8 * 3600 * 1000);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const target = minutes < 720 ? 12 : 18;
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), target, 0) - 8 * 3600 * 1000;
}

/** The next run of a schedule, moved out of the peak hours when it asks for that (schedule.offPeak). */
export function nextRunAt(schedule, fromTs, timeZone = 'UTC') {
  const next = nextRunFor(schedule, fromTs, timeZone);
  return next && schedule?.offPeak ? offPeakAfter(next) : next;
}

export function describeSchedule(schedule) {
  if (schedule.kind === 'interval' || schedule.kind === 'once') return schedule.expression;
  return `cron ${schedule.expression}`;
}

// ---------------------------------------------------------------------------
// Routine store + scheduler
// ---------------------------------------------------------------------------

export class RoutineStore {
  /**
   * @param {object} opts
   * @param {object} opts.config        assistant config (timezone default, policy)
   * @param {Function} opts.runner      async (routine) => {status, summary, turnId}
   */
  constructor({ config, runner, tickMs = 20000 } = {}) {
    this.config = config || {};
    this.runner = runner || (async () => ({ status: 'failed', summary: 'no runner configured' }));
    this.tickMs = tickMs;
    this.routines = [];
    this.timer = null;
    this.busy = false;
    this.loaded = false;
  }

  async load() {
    const raw = await readJson(P.routinesFile, { routines: [] });
    const list = Array.isArray(raw) ? raw : raw?.routines || [];
    this.routines = list.map((r) => this.normalize(r));
    this.loaded = true;
    return this.routines;
  }

  async persist() {
    await writeJsonAtomic(P.routinesFile, { routines: this.routines });
  }

  normalize(raw) {
    const scheduleText = raw.schedule || 'every 60 minutes';
    let parsed;
    try {
      parsed = parseSchedule(scheduleText);
    } catch {
      parsed = { kind: 'interval', intervalMs: 3600000, expression: 'every 60 minutes' };
    }
    const timezone = isValidTimeZone(raw.timezone) ? raw.timezone : this.defaultTimezone();
    const routine = {
      id: raw.id || uid('rt'),
      botId: raw.botId || 'chief',
      name: raw.name || 'Untitled routine',
      instruction: raw.instruction || '',
      schedule: parsed.expression,
      kind: parsed.kind,
      intervalMs: parsed.intervalMs || null,
      cron: parsed.kind === 'cron' ? parsed.expression : null,
      timezone,
      enabled: raw.enabled !== false,
      createdAt: raw.createdAt || nowIso(),
      updatedAt: raw.updatedAt || nowIso(),
      lastRun: raw.lastRun || null,
      nextRun: raw.nextRun || null,
      lastStatus: raw.lastStatus || null,
      runs: Array.isArray(raw.runs) ? raw.runs.slice(-20) : [],
      ...routineOptions(raw),
      lastReport: raw.lastReport ? String(raw.lastReport).slice(0, 2000) : '',
    };
    if (routine.enabled && !routine.nextRun) {
      const next = nextRunAt({ ...parsed, offPeak: routine.offPeak }, Date.now(), timezone);
      routine.nextRun = next ? new Date(next).toISOString() : null;
    }
    return routine;
  }

  defaultTimezone() {
    return isValidTimeZone(this.config.timezone) ? this.config.timezone : 'UTC';
  }

  list() {
    return [...this.routines].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.routines.find((r) => r.id === id) || null;
  }

  async create(input = {}) {
    if (!input.instruction || !String(input.instruction).trim()) {
      throw httpError(400, 'ROUTINE_INVALID', 'a routine needs an instruction');
    }
    const parsed = parseSchedule(input.schedule || 'every 60 minutes');
    const timezone = isValidTimeZone(input.timezone) ? input.timezone : this.defaultTimezone();
    const next = nextRunAt({ ...parsed, offPeak: Boolean(input.offPeak) }, Date.now(), timezone);

    const routine = {
      id: uid('rt'),
      botId: input.botId || 'chief',
      name: String(input.name || 'Untitled routine').slice(0, 120),
      instruction: String(input.instruction),
      schedule: parsed.expression,
      kind: parsed.kind,
      intervalMs: parsed.intervalMs || null,
      cron: parsed.kind === 'cron' ? parsed.expression : null,
      timezone,
      enabled: input.enabled !== false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastRun: null,
      nextRun: next ? new Date(next).toISOString() : null,
      lastStatus: null,
      runs: [],
      ...routineOptions(input),
      lastReport: '',
    };
    this.routines.push(routine);
    await this.persist();
    return routine;
  }

  async update(id, patch = {}) {
    const routine = this.get(id);
    if (!routine) throw httpError(404, 'ROUTINE_NOT_FOUND', `no routine with id "${id}"`);

    if (patch.schedule && patch.schedule !== routine.schedule) {
      const parsed = parseSchedule(patch.schedule);
      routine.schedule = parsed.expression;
      routine.kind = parsed.kind;
      routine.intervalMs = parsed.intervalMs || null;
      routine.cron = parsed.kind === 'cron' ? parsed.expression : null;
    }
    if (patch.timezone !== undefined) {
      if (!isValidTimeZone(patch.timezone)) throw httpError(400, 'ROUTINE_INVALID', `unknown timezone "${patch.timezone}"`);
      routine.timezone = patch.timezone;
    }
    if (patch.name !== undefined) routine.name = String(patch.name).slice(0, 120);
    if (patch.instruction !== undefined) routine.instruction = String(patch.instruction);
    if (patch.botId !== undefined) routine.botId = String(patch.botId);
    if (patch.enabled !== undefined) routine.enabled = Boolean(patch.enabled);
    if (patch.onlyChanges !== undefined) routine.onlyChanges = Boolean(patch.onlyChanges);
    if (patch.pushFeishu !== undefined) routine.pushFeishu = Boolean(patch.pushFeishu);
    if (patch.offPeak !== undefined) routine.offPeak = Boolean(patch.offPeak);

    // Recompute the next fire time whenever the timing or the enabled flag moves.
    const parsed = parseSchedule(routine.schedule);
    routine.updatedAt = nowIso();
    routine.nextRun = routine.enabled ? isoOrNull(nextRunAt({ ...parsed, offPeak: routine.offPeak }, Date.now(), routine.timezone)) : null;

    await this.persist();
    return routine;
  }

  async remove(id) {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) throw httpError(404, 'ROUTINE_NOT_FOUND', `no routine with id "${id}"`);
    await this.persist();
    return { id, deleted: true };
  }

  /**
   * Run a routine right now ("Test" in the UI). Always unattended semantics: the
   * whole point of the Test button is to check what happens while you are away.
   */
  async runNow(id, { trigger = 'test' } = {}) {
    const routine = this.get(id);
    if (!routine) throw httpError(404, 'ROUTINE_NOT_FOUND', `no routine with id "${id}"`);
    return this.fire(routine, trigger);
  }

  /** The routine whose run was this turn (a card it left behind points at it). */
  findByTurn(turnId) {
    if (!turnId) return null;
    return this.routines.find((r) => (r.runs || []).some((run) => run.turnId === turnId)) || null;
  }

  /** Execute one routine and record the outcome. Never throws at the caller. */
  async fire(routine, trigger = 'schedule') {
    const run = {
      id: uid('run'),
      trigger,
      startedAt: nowIso(),
      endedAt: null,
      status: 'running',
      summary: '',
      turnId: null,
    };

    const parsed = parseSchedule(routine.schedule);
    routine.lastRun = run.startedAt;
    // Anchor on "now" rather than the missed slot so a sleeping machine does not
    // queue up a burst of catch-up runs.
    routine.nextRun = routine.enabled ? isoOrNull(nextRunAt({ ...parsed, offPeak: routine.offPeak }, Date.now(), routine.timezone)) : null;

    try {
      // "现在跑一次（我看着）" (1.3.2): the human is there, so its asks wait for them.
      const result = await this.runner(routine, { attended: trigger === 'watched' });
      run.status = result?.status === 'success' ? 'success' : result?.status === 'needs_approval' ? 'needs_approval' : 'failed';
      run.summary = String(result?.summary || '');
      run.turnId = result?.turnId || null;
      // "Only tell me when something changed": a run with nothing new stays quiet.
      if (result?.quiet) run.quiet = true;
      else if (result?.report) routine.lastReport = String(result.report).slice(0, 2000);
    } catch (err) {
      run.status = 'failed';
      run.summary = `routine crashed: ${err.message}`;
    } finally {
      run.endedAt = nowIso();
      routine.lastStatus = run.status;
      // A single run is done once its time came: off, nothing left to delete.
      if (routine.kind === 'once' && trigger === 'schedule') {
        routine.enabled = false;
        routine.nextRun = null;
      }
      routine.runs.push(run);
      if (routine.runs.length > 20) routine.runs = routine.runs.slice(-20);
      routine.updatedAt = nowIso();
      await this.persist().catch(() => {});
    }
    return { routine, run };
  }

  /** Start the 20s tick loop. Unref'd so it never keeps a headless process alive. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[routines] tick failed:', err.message));
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fire everything that is due. Re-entrancy guarded: one tick at a time. */
  async tick(now = Date.now()) {
    if (this.busy) return [];
    this.busy = true;
    const fired = [];
    try {
      for (const routine of this.routines) {
        if (!routine.enabled) continue;
        const due = routine.nextRun ? Date.parse(routine.nextRun) : NaN;
        if (!Number.isFinite(due)) {
          const parsed = parseSchedule(routine.schedule);
          routine.nextRun = isoOrNull(nextRunAt({ ...parsed, offPeak: routine.offPeak }, now, routine.timezone));
          // A single run whose time has passed has nothing left to do.
          if (!routine.nextRun && parsed.kind === 'once') routine.enabled = false;
          continue;
        }
        if (due <= now) {
          fired.push(await this.fire(routine, 'schedule'));
        }
      }
      if (fired.length === 0) {
        // Persist any nextRun repairs lazily; skip a write on quiet ticks.
        const needsRepair = this.routines.some((r) => r.enabled && !r.nextRun);
        if (needsRepair) await this.persist();
      }
    } finally {
      this.busy = false;
    }
    return fired;
  }
}

/** Options a routine may carry: notify only on change, also send to Feishu, a built-in preset. */
function routineOptions(raw = {}) {
  return {
    onlyChanges: Boolean(raw.onlyChanges),
    pushFeishu: Boolean(raw.pushFeishu),
    // Wait for the off-peak hours (1.5.50, S2): off unless the human turns it on.
    offPeak: Boolean(raw.offPeak),
    ...(raw.preset === 'briefing' ? { preset: 'briefing' } : {}),
  };
}

function isoOrNull(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
