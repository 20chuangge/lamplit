/**
 * Token usage ledger and cost estimates.
 *
 * One JSONL line per model call, aggregated on read. Prices are per million
 * tokens and live in data/usage-settings.json (1.5.28: input that hit the
 * provider's prompt cache has its own, much lower price - `cached`); an unpriced model still counts
 * tokens but contributes no money, so the UI can say what is missing instead
 * of inventing a number. A daily money threshold writes one audit entry per
 * day (data/usage-alert.json remembers the day, so it cannot spam).
 */
import path from 'node:path';
import { P, nowIso, readJsonl, readJsonSync, appendJsonl, writeJsonSyncAtomic } from './store.mjs';

const ledgerFile = () => path.join(P.dataDir, 'usage.jsonl');
const settingsFile = () => path.join(P.dataDir, 'usage-settings.json');
const alertFile = () => path.join(P.dataDir, 'usage-alert.json');
const budgetFile = () => path.join(P.dataDir, 'usage-budget.json');

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cleanSettings(raw) {
  const prices = {};
  for (const [model, value] of Object.entries(raw?.prices || {})) {
    const name = String(model || '').trim().slice(0, 80);
    if (!name) continue;
    const inPrice = Number(value?.in);
    const outPrice = Number(value?.out);
    if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice) || inPrice < 0 || outPrice < 0) continue;
    let cachedPrice = value?.cached === '' || value?.cached == null ? NaN : Number(value.cached);
    let peak = value?.peak === true;
    // 1.5.50 (B1): a price saved by hand before 1.5.29 that is the site's own
    // (same input and output price) had no peak flag, so every call on that
    // machine was counted at the peak price (the cloud read ¥6.18 for ¥3.3).
    // The site's price is the site's rule: its cached price and peak hours.
    const known = knownPrice(name);
    // Only when the price never said (peak absent): the human may untick it on purpose (peak: false, kept).
    if (known && value?.peak === undefined && inPrice === known.in && outPrice === known.out && (!Number.isFinite(cachedPrice) || cachedPrice === known.cached)) {
      cachedPrice = known.cached;
      peak = Boolean(known.peak);
    }
    prices[name] = {
      in: round(inPrice), out: round(outPrice),
      ...(Number.isFinite(cachedPrice) && cachedPrice >= 0 ? { cached: round(cachedPrice) } : {}),
      // 1.5.29: the prices are peak prices; outside the peak hours they are half (DeepSeek's rule).
      ...(peak ? { peak: true } : value?.peak === false ? { peak: false } : {}),
    };
  }
  const limit = Number(raw?.dailyAlert);
  const budget = Number(raw?.botDailyBudget);
  return {
    currency: raw?.currency === 'USD' ? 'USD' : 'CNY',
    prices,
    dailyAlert: Number.isFinite(limit) && limit > 0 ? limit : 0,
    // 1.5.28: what one assistant may spend in a day before it stops and asks (0 = no limit).
    botDailyBudget: Number.isFinite(budget) && budget > 0 ? round(budget, 4) : 0,
  };
}

export function readUsageSettings() {
  return cleanSettings(readJsonSync(settingsFile(), null));
}

/** Today's alert, when one was already raised (null otherwise). */
export function readUsageAlert() {
  const alert = readJsonSync(alertFile(), null);
  return alert && alert.day === localDay() ? alert : null;
}

/**
 * Write the corrected prices back once (1.5.50, B1), so the file says what is
 * counted. Called when the server starts; changes nothing when nothing is off.
 * -> true when the file was rewritten.
 */
export async function fixHandPrices() {
  const raw = readJsonSync(settingsFile(), null);
  if (!raw?.prices) return false;
  const clean = cleanSettings(raw);
  const changed = Object.entries(clean.prices).some(([model, p]) => {
    const was = raw.prices[model] || {};
    return Boolean(was.peak) !== Boolean(p.peak) || (p.cached != null && (was.cached == null || was.cached === ''));
  });
  if (!changed) return false;
  writeJsonSyncAtomic(settingsFile(), { ...raw, prices: { ...raw.prices, ...clean.prices } });
  forgetSpent();
  return true;
}

export async function saveUsageSettings(patch = {}) {
  const current = readUsageSettings();
  const next = cleanSettings({
    currency: patch.currency ?? current.currency,
    prices: patch.prices ?? current.prices,
    dailyAlert: patch.dailyAlert ?? current.dailyAlert,
    botDailyBudget: patch.botDailyBudget ?? current.botDailyBudget,
  });
  writeJsonSyncAtomic(settingsFile(), next);
  return next;
}

/**
 * Input tokens the provider served from its prompt cache: DeepSeek reports
 * prompt_cache_hit_tokens, OpenAI-style gateways prompt_tokens_details.cached_tokens.
 */
export function cachedTokensOf(usage) {
  if (!usage) return 0;
  const n = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const total = Math.max(prompt + completion, Number(usage.total_tokens) || 0);
  const cached = Math.min(prompt, cachedTokensOf(usage));
  // 1.5.50 (S5): the part of the output spent thinking (DeepSeek and OpenAI-style gateways).
  // null when the provider does not say (then the call is left out of the thinking share).
  const said = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens;
  const reasoning = said == null ? null : Math.min(completion, Math.max(0, Number(said) || 0));
  return total ? { prompt, completion, total, cached, reasoning } : null;
}

/**
 * DeepSeek's peak hours (1.5.29): Beijing time, Monday to Friday, 9:00-12:00
 * and 14:00-18:00; the rest is off-peak at half price. China's public
 * holidays are off-peak too - not known here, so those weekdays count as peak
 * (the estimate errs high).
 */
export function isPeakTime(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return true;
  const bj = new Date(t + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

/** The prices on DeepSeek's site (November 2026, peak; off-peak is half). Used when no price is set (1.5.33: 「未设单价」 until 填官网价 was clicked); a price set by hand wins. */
export const KNOWN_PRICES = [
  { match: /^deepseek-(v[\d.]+-)?flash/i, price: { in: 2, cached: 0.04, out: 8, peak: true } },
  { match: /^deepseek-(v[\d.]+-)?pro/i, price: { in: 9, cached: 0.3, out: 27, peak: true } },
];
export function knownPrice(model) {
  return KNOWN_PRICES.find((k) => k.match.test(String(model || '')))?.price || null;
}

/** The price a record is counted at: the one set by hand, else the provider's own (KNOWN_PRICES). */
export function priceOf(settings, model) {
  return settings?.prices?.[model] || knownPrice(model);
}

/** Demo mode's scripted answers cost nothing and are not counted (1.5.33: 326K "tokens" looked like money spent). */
// The self-test runs on the demo model and counts it on purpose (ASSIST_COUNT_DEMO_USAGE=1).
/**
 * An evaluation run (1.5.50, B2): its bot was made with eval: true, or - older
 * lines - is named 评测-… or has a task id for an id (h1-venue-ask). Real money,
 * but not the human's own use: the daily pace and the checkup leave it out.
 */
export const isEvalRecord = (r) => r?.eval === true || /^评测-/.test(String(r?.botName || '')) || /^[a-z]\d{1,2}-[a-z0-9-]+$/.test(String(r?.botId || ''));

export const isDemoRecord = (r) => process.env.ASSIST_COUNT_DEMO_USAGE !== '1' && (r?.provider === 'mock' || r?.model === 'scripted-planner');

/** Money for one record at a price; cached input at its own price (the input price when none is set). */
export function recordCost(r, price) {
  if (!price || !Number.isFinite(r?.total)) return null;
  const prompt = Number(r.prompt) || 0;
  const cached = Math.min(prompt, Number(r.cached) || 0);
  const cachedPrice = Number.isFinite(price.cached) ? price.cached : price.in;
  const factor = price.peak && !isPeakTime(r.ts) ? 0.5 : 1;
  return (factor * ((prompt - cached) * price.in + cached * cachedPrice + (Number(r.completion) || 0) * price.out)) / 1_000_000;
}

/**
 * Append one call. A provider that reports no usage still gets a line, with
 * null tokens: the call happened, but inventing a token count would make the
 * estimate a lie. Returns the record.
 */
export async function recordUsage({ botId = '', botName = '', provider = '', model = '', usage = null, source = '', routineId = '', eval: isEval = false } = {}) {
  const counts = normalizeUsage(usage);
  const record = {
    ts: nowIso(),
    day: localDay(),
    botId: String(botId || ''),
    // The name too (1.5.29): a deleted assistant was only an id on the cost page.
    ...(botName ? { botName: String(botName).slice(0, 60) } : {}),
    provider: String(provider || ''),
    model: String(model || ''),
    prompt: counts ? counts.prompt : null,
    completion: counts ? counts.completion : null,
    total: counts ? counts.total : null,
    cached: counts ? counts.cached : null,
    ...(counts && counts.reasoning != null ? { reasoning: counts.reasoning } : {}),
    source: String(source || '').slice(0, 20),
    ...(routineId ? { routineId: String(routineId).slice(0, 40) } : {}),
    ...(isEval ? { eval: true } : {}),
  };
  await appendJsonl(ledgerFile(), record);
  return record;
}

export async function readUsageRecords() {
  return readJsonl(ledgerFile());
}

/** Records for the last `days` local days (today included). */
export function recentRecords(records, days = 30) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const first = new Date();
  first.setDate(first.getDate() - (span - 1));
  const from = localDay(first);
  return records.filter((r) => r.day >= from);
}

export function summarizeUsage(records, settings = readUsageSettings()) {
  const byBot = new Map();
  const byDay = new Map();
  const byModel = new Map();
  const byRoutine = new Map();
  const bySource = new Map();
  const evalSum = new Map();
  // reasoningOf: the output of the calls that said how much of it was thinking (the share's denominator).
  const totals = { tokens: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, reasoningOf: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 };
  const bump = (map, key, r, cost, tokens) => {
    const entry = map.get(key) || {
      key, tokens: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, reasoningOf: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0,
    };
    // An evaluation bot's row says so (the cost page folds it into 评测, 1.5.50).
    if (map === byBot && isEvalRecord(r)) entry.eval = true;
    entry.calls += 1;
    if (r.botName && map === byBot) entry.name = r.botName;
    if (tokens == null) entry.callsWithoutUsage += 1;
    else {
      entry.tokens += tokens;
      entry.prompt += Number(r.prompt) || 0;
      entry.cached += Number(r.cached) || 0;
      entry.completion += Number(r.completion) || 0;
      entry.reasoning += Number(r.reasoning) || 0;
      if (r.reasoning != null) entry.reasoningOf += Number(r.completion) || 0;
      if (cost == null) entry.unpricedTokens += tokens;
      else entry.cost += cost;
    }
    map.set(key, entry);
  };
  for (const r of records) {
    if (isDemoRecord(r)) continue; // older demo-mode lines
    const tokens = Number.isFinite(r.total) ? Number(r.total) : null;
    const price = priceOf(settings, r.model);
    const cost = tokens != null ? recordCost(r, price) : null;
    totals.calls += 1;
    if (tokens == null) totals.callsWithoutUsage += 1;
    else {
      totals.tokens += tokens;
      totals.prompt += Number(r.prompt) || 0;
      totals.cached += Number(r.cached) || 0;
      totals.completion += Number(r.completion) || 0;
      totals.reasoning += Number(r.reasoning) || 0;
      if (r.reasoning != null) totals.reasoningOf += Number(r.completion) || 0;
      if (cost == null) totals.unpricedTokens += tokens;
      else totals.cost += cost;
    }
    bump(byBot, r.botId || '—', r, cost, tokens);
    bump(byDay, r.day, r, cost, tokens);
    bump(byModel, r.model || '(未知)', r, cost, tokens);
    if (r.routineId) bump(byRoutine, r.routineId, r, cost, tokens);
    // 1.5.50: what kind of call (chat, routine, vision, rule, translate, check …), and evaluation apart.
    bump(bySource, r.source || 'chat', r, cost, tokens);
    if (isEvalRecord(r)) bump(evalSum, 'eval', r, cost, tokens);
  }
  // hitRate: the share of input served from the prompt cache (null before 1.5.28 records).
  const finish = (entry) => ({ ...entry, cost: round(entry.cost), hitRate: entry.prompt && entry.cached ? round(entry.cached / entry.prompt, 3) : 0 });
  return {
    totals: finish(totals),
    byBot: [...byBot.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
    byDay: [...byDay.values()].map(finish).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byModel: [...byModel.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
    byRoutine: [...byRoutine.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    bySource: [...bySource.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    eval: finish(evalSum.get('eval') || { key: 'eval', tokens: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, reasoningOf: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 }),
  };
}

/**
 * Today's spend per assistant, kept in memory (1.5.28): read from the ledger
 * once a day, then added to as calls are recorded, so the budget check before
 * every step does not reread the whole file.
 */
let spent = { day: '', byBot: null };
async function spentMap() {
  const day = localDay();
  if (spent.day === day && spent.byBot) return spent.byBot;
  const settings = readUsageSettings();
  const byBot = new Map();
  for (const r of await readUsageRecords()) {
    if (r.day !== day) continue;
    byBot.set(r.botId, (byBot.get(r.botId) || 0) + (recordCost(r, priceOf(settings, r.model)) || 0));
  }
  spent = { day, byBot };
  return byBot;
}
function addSpent(record) {
  if (!spent.byBot || spent.day !== record.day) return;
  const cost = recordCost(record, priceOf(readUsageSettings(), record.model)) || 0;
  spent.byBot.set(record.botId, (spent.byBot.get(record.botId) || 0) + cost);
}
/** Prices changed: count today again with the new ones. */
export function forgetSpent() { spent = { day: '', byBot: null }; }

/**
 * What a day costs at the recent pace (1.5.30), from records that say how much
 * input hit the cache - older ones priced every input token at the full price
 * and read twice the bill. Whole days first (their average); with only today,
 * today so far scaled to 24 hours once 3 hours have passed. -> {perDay, basis, days}
 *
 * 1.5.50: evaluation runs are left out (B2); every calendar day from the first
 * one counted to yesterday counts, spent or not (B3: a quiet day is a cheap day,
 * not a missing one); the day the cache data began - half of it without - is
 * not taken as a whole day when later days are there (B4).
 */
export function spendRate(records, settings = readUsageSettings(), now = new Date()) {
  const today = localDay(now);
  const byDay = new Map();
  const startedMidDay = new Set();
  for (const r of records) {
    if (isDemoRecord(r) || isEvalRecord(r)) continue;
    if (r.cached == null) { startedMidDay.add(r.day); continue; }
    const cost = recordCost(r, priceOf(settings, r.model));
    if (cost == null) continue;
    byDay.set(r.day, (byDay.get(r.day) || 0) + cost);
  }
  const days = [...byDay.keys()].filter((day) => day < today).sort();
  if (days.length) {
    const first = startedMidDay.has(days[0]) && days.length > 1 ? days[1] : days[0];
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const span = (x, y) => Math.round((Date.parse(`${y}T00:00:00Z`) - Date.parse(`${x}T00:00:00Z`)) / 86400000) + 1;
    const n = Math.max(1, span(first, localDay(yesterday)));
    const total = days.filter((day) => day >= first).reduce((sum, day) => sum + byDay.get(day), 0);
    if (total > 0) return { perDay: round(total / n, 2), basis: 'days', days: n };
  }
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const hours = (now - midnight) / 3600000;
  const spentToday = byDay.get(today) || 0;
  if (hours >= 3 && spentToday > 0) return { perDay: round((spentToday / hours) * 24, 2), basis: 'today', days: 0 };
  return { perDay: 0, basis: 'none', days: 0 };
}

/**
 * The balance as the provider says it, kept per reading (1.5.50). The 11-14..20
 * bill showed spend Lamplit cannot see: other keys on the same account (another
 * app, a test key) and evaluation runs. The drop of the balance itself is what
 * makes it run out, so 「还能用几天」 uses it once two readings are a day apart.
 */
const balanceFile = () => path.join(P.dataDir, 'balance-history.json');
export function readBalanceHistory() {
  const raw = readJsonSync(balanceFile(), null);
  return Array.isArray(raw?.readings) ? raw.readings.filter((r) => Number.isFinite(r?.at) && Number.isFinite(r?.amount)) : [];
}
/** Note a reading; one per hour is enough (a newer one in the same hour replaces it). */
export function noteBalance(amount, now = Date.now(), history = readBalanceHistory()) {
  if (!Number.isFinite(Number(amount))) return history;
  const list = history.slice();
  if (list.length && now - list[list.length - 1].at < 3600 * 1000) list.pop();
  list.push({ at: now, amount: round(Number(amount), 4) });
  const kept = list.slice(-120);
  try { writeJsonSyncAtomic(balanceFile(), { readings: kept }); } catch { /* optional */ }
  return kept;
}
/**
 * What a day costs by the balance's own drop: from the newest reading back to
 * the oldest one since the last top-up (a reading higher than the one before),
 * within 7 days, at least 20 hours apart. -> {perDay, hours} or null.
 */
export function balancePace(history = readBalanceHistory(), now = Date.now()) {
  const list = history.filter((r) => r.at <= now && now - r.at <= 7 * 24 * 3600 * 1000).sort((a, b) => a.at - b.at);
  if (list.length < 2) return null;
  let start = list.length - 1;
  while (start > 0 && list[start - 1].amount >= list[start].amount - 0.005) start -= 1;
  const first = list[start];
  const last = list[list.length - 1];
  const hours = (last.at - first.at) / 3600000;
  if (hours < 20 || first.amount <= last.amount) return null;
  return { perDay: round(((first.amount - last.amount) / hours) * 24, 2), hours: Math.round(hours) };
}

/** One assistant's estimated spend today (priced models only). */
export async function botCostToday(botId) {
  return round((await spentMap()).get(botId) || 0, 4);
}

/** What the human let this assistant spend today beyond the budget (each "再放行" adds one budget). */
export function budgetAllowance(botId) {
  const saved = readJsonSync(budgetFile(), null);
  return saved && saved.day === localDay() ? Number(saved.extra?.[botId]) || 0 : 0;
}
export function allowMore(botId, amount) {
  const day = localDay();
  const saved = readJsonSync(budgetFile(), null);
  const extra = saved && saved.day === day ? { ...(saved.extra || {}) } : {};
  extra[botId] = round((Number(extra[botId]) || 0) + Math.max(0, Number(amount) || 0), 4);
  writeJsonSyncAtomic(budgetFile(), { day, extra });
  return extra[botId];
}

/**
 * Is this assistant over its daily budget? -> null, or {spent, limit, budget}.
 * No budget set, or no prices to count money with: never over.
 */
export async function overBudget(botId, settings = readUsageSettings()) {
  if (!settings.botDailyBudget) return null;
  const used = await botCostToday(botId);
  const limit = settings.botDailyBudget + budgetAllowance(botId);
  return used >= limit ? { spent: round(used, 4), limit: round(limit, 4), budget: settings.botDailyBudget, currency: settings.currency } : null;
}

/**
 * Record a call and raise the once-a-day cost alert when the local day's
 * estimate first crosses the threshold. Money only counts for priced models.
 */
export async function noteUsage(entry, { audit = async () => {}, bus = null } = {}) {
  if (isDemoRecord(entry)) return null;
  const record = await recordUsage(entry);
  if (!record) return null;
  addSpent(record);
  const settings = readUsageSettings();
  if (!settings.dailyAlert) return record;
  const records = recentRecords(await readUsageRecords(), 1).filter((r) => r.day === record.day);
  const today = summarizeUsage(records, settings).totals;
  if (today.cost < settings.dailyAlert) return record;
  const previous = readJsonSync(alertFile(), null);
  if (previous?.day === record.day) return record;
  writeJsonSyncAtomic(alertFile(), { day: record.day, cost: today.cost, limit: settings.dailyAlert });
  await audit({ kind: 'usage.alert', day: record.day, cost: today.cost, limit: settings.dailyAlert, currency: settings.currency });
  bus?.emit({ type: 'usage.alert', day: record.day, cost: today.cost, limit: settings.dailyAlert, currency: settings.currency });
  return record;
}
