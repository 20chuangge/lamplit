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
    const cachedPrice = value?.cached === '' || value?.cached == null ? NaN : Number(value.cached);
    prices[name] = {
      in: round(inPrice), out: round(outPrice),
      ...(Number.isFinite(cachedPrice) && cachedPrice >= 0 ? { cached: round(cachedPrice) } : {}),
      // 1.5.29: the prices are peak prices; outside the peak hours they are half (DeepSeek's rule).
      ...(value?.peak ? { peak: true } : {}),
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
  return total ? { prompt, completion, total, cached } : null;
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

/** The prices on DeepSeek's site (November 2026, peak; off-peak is half) - offered, never applied by themselves. */
export const KNOWN_PRICES = [
  { match: /^deepseek-(v[\d.]+-)?flash/i, price: { in: 2, cached: 0.04, out: 8, peak: true } },
  { match: /^deepseek-(v[\d.]+-)?pro/i, price: { in: 9, cached: 0.3, out: 27, peak: true } },
];
export function knownPrice(model) {
  return KNOWN_PRICES.find((k) => k.match.test(String(model || '')))?.price || null;
}

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
export async function recordUsage({ botId = '', botName = '', provider = '', model = '', usage = null, source = '', routineId = '' } = {}) {
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
    source: String(source || '').slice(0, 20),
    ...(routineId ? { routineId: String(routineId).slice(0, 40) } : {}),
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
  const totals = { tokens: 0, prompt: 0, completion: 0, cached: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 };
  const bump = (map, key, r, cost, tokens) => {
    const entry = map.get(key) || {
      key, tokens: 0, prompt: 0, completion: 0, cached: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0,
    };
    entry.calls += 1;
    if (r.botName && map === byBot) entry.name = r.botName;
    if (tokens == null) entry.callsWithoutUsage += 1;
    else {
      entry.tokens += tokens;
      entry.prompt += Number(r.prompt) || 0;
      entry.cached += Number(r.cached) || 0;
      entry.completion += Number(r.completion) || 0;
      if (cost == null) entry.unpricedTokens += tokens;
      else entry.cost += cost;
    }
    map.set(key, entry);
  };
  for (const r of records) {
    const tokens = Number.isFinite(r.total) ? Number(r.total) : null;
    const price = settings.prices?.[r.model];
    const cost = tokens != null ? recordCost(r, price) : null;
    totals.calls += 1;
    if (tokens == null) totals.callsWithoutUsage += 1;
    else {
      totals.tokens += tokens;
      totals.prompt += Number(r.prompt) || 0;
      totals.cached += Number(r.cached) || 0;
      totals.completion += Number(r.completion) || 0;
      if (cost == null) totals.unpricedTokens += tokens;
      else totals.cost += cost;
    }
    bump(byBot, r.botId || '—', r, cost, tokens);
    bump(byDay, r.day, r, cost, tokens);
    bump(byModel, r.model || '(未知)', r, cost, tokens);
    if (r.routineId) bump(byRoutine, r.routineId, r, cost, tokens);
  }
  // hitRate: the share of input served from the prompt cache (null before 1.5.28 records).
  const finish = (entry) => ({ ...entry, cost: round(entry.cost), hitRate: entry.prompt && entry.cached ? round(entry.cached / entry.prompt, 3) : 0 });
  return {
    totals: finish(totals),
    byBot: [...byBot.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
    byDay: [...byDay.values()].map(finish).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byModel: [...byModel.values()].map(finish).sort((a, b) => b.tokens - a.tokens),
    byRoutine: [...byRoutine.values()].map(finish).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
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
    byBot.set(r.botId, (byBot.get(r.botId) || 0) + (recordCost(r, settings.prices?.[r.model]) || 0));
  }
  spent = { day, byBot };
  return byBot;
}
function addSpent(record) {
  if (!spent.byBot || spent.day !== record.day) return;
  const cost = recordCost(record, readUsageSettings().prices?.[record.model]) || 0;
  spent.byBot.set(record.botId, (spent.byBot.get(record.botId) || 0) + cost);
}
/** Prices changed: count today again with the new ones. */
export function forgetSpent() { spent = { day: '', byBot: null }; }

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
