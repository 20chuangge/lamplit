// The evaluation set's helpers (1.5.6): how a task's result is looked at, how
// the runner answers approval cards, and how a run is summed up and written
// down. Pure, so the smoke test checks them without a model.

/** Normalise a relative path: forward slashes, no leading ./ or slash. */
export const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * What a check sees of a task folder, in memory (the smoke test):
 *   read(rel) -> text | null, exists(rel), list(rel) -> names directly inside,
 *   files() -> every file path, reply (the bot's answer), routines, truth.
 */
export function memoryView({ files = {}, remove = [], routines = [], reply = '', truth = null, replies = null, rounds = [] } = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) map.set(norm(k), String(v));
  for (const k of remove) map.delete(norm(k));
  return viewOf({
    read: (rel) => (map.has(norm(rel)) ? map.get(norm(rel)) : null),
    files: () => [...map.keys()].sort(),
    routines,
    reply: replies ? replies.join('\n') : reply,
    truth,
    replies: replies || [reply],
    rounds,
  });
}

/**
 * The same view over any {read, files} source (the runner uses the disk).
 * replies: the bot's answer in each round (a hard task may answer it back);
 * rounds: the files after each round.
 */
export function viewOf({ read, files, routines = [], reply = '', truth = null, replies = null, rounds = [] }) {
  const all = () => files().map(norm);
  return {
    read: (rel) => read(norm(rel)),
    exists: (rel) => {
      const p = norm(rel);
      return all().some((f) => f === p || f.startsWith(`${p}/`));
    },
    list: (rel = '') => {
      const p = norm(rel);
      const pre = p ? `${p}/` : '';
      return [...new Set(all().filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length).split('/')[0]))].sort();
    },
    files: all,
    routines,
    reply: String(reply || ''),
    truth,
    replies: (replies || [reply]).map((r) => String(r || '')),
    rounds: rounds.map((list) => list.map(norm)),
  };
}

/** Rows of a small CSV (comma or tab, quotes, BOM), header row included. */
export function csvRows(text) {
  const rows = [];
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const sep = raw.includes('\t') && !raw.includes(',') ? '\t' : ',';
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (c === '"') {
        if (q && raw[i + 1] === '"') { cur += '"'; i += 1; } else q = !q;
      } else if (c === sep && !q) { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

/** Numbers in a text ("1,280.50" -> 1280.5), for amounts written either way. */
export function numbersIn(text) {
  return (String(text || '').match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, '')));
}
export const hasNumber = (text, n) => numbersIn(text).some((x) => Math.abs(x - n) < 0.005);

/** Does a cron line mean "at hh:mm" on these weekdays ('*' = every day)? */
export function cronIs(expr, { minute, hour, days = '*' }) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [m, h, dom, mon, dow] = f;
  if (Number(m) !== minute || Number(h) !== hour || dom !== '*' || mon !== '*') return false;
  const d = dow.toLowerCase();
  if (days === '*') return d === '*' || d === '0-6' || d === '1-7' || d === 'sun-sat' || d === 'mon-sun';
  if (days === 'weekdays') return ['1-5', 'mon-fri', '1,2,3,4,5', 'mon,tue,wed,thu,fri'].includes(d);
  return d === days;
}

export const pass = () => ({ ok: true, why: '' });
export const fail = (why) => ({ ok: false, why });

// --- approval cards -----------------------------------------------------------
// The runner stands in for the person: it says yes to what a careful person
// would let a bot do for these tasks, and no to the rest. Every card counts as
// one intervention either way: a card is the human being asked.

const READ_ONLY = new Set(['fs_list', 'fs_read', 'http_fetch', 'memory_read', 'skill_list', 'skill_read', 'routine_list', 'bot_list']);
const EVERYDAY = new Set(['fs_write', 'fs_mkdir', 'fs_delete', 'memory_write', 'routine_create', 'routine_update', 'routine_delete', 'page_save']);

/** 'approve' | 'deny' for one approval card of a task working in `dir`. */
export function judgeApproval(card, dir) {
  const tool = String(card?.toolName || card?.tool || '');
  const args = card?.args || {};
  const home = norm(dir);
  const inside = (p) => {
    const n = norm(p);
    return n === home || n.startsWith(`${home}/`) || n.includes(`/${home}/`) || n.endsWith(`/${home}`);
  };
  if (READ_ONLY.has(tool)) return 'approve';
  if (EVERYDAY.has(tool)) {
    const p = args.path || args.to || args.from || '';
    return !p || inside(p) || tool.startsWith('routine_') || tool.startsWith('memory_') || tool === 'page_save' ? 'approve' : 'deny';
  }
  if (tool === 'shell') {
    const cmd = String(args.command || '').replace(/\\/g, '/');
    // Climbing out of the folder, the system, or rights: no.
    if (/\.\.\/|\.\.$|\bsudo\b|\bformat\b|reg(\.exe)?\s+(add|delete)|Set-ExecutionPolicy|shutdown|curl\s|wget\s|Invoke-WebRequest/i.test(cmd)) return 'deny';
    return cmd.includes(home) ? 'approve' : 'deny';
  }
  return 'deny';
}

// --- a run, summed up -----------------------------------------------------------

export function summarize(results) {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const add = (k) => results.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    total,
    passed,
    rate: total ? Math.round((passed / total) * 100) : 0,
    interventions: add('interventions'),
    asks: add('asks'),
    tokens: add('tokens'),
    cost: Math.round(add('cost') * 10000) / 10000,
    seconds: Math.round(add('seconds')),
  };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/** The docs/EVAL.md section for one run (no paths, no names: the file is public). */
export function renderRecord({ version, day, model, currency = 'CNY', results, note = '' }) {
  const s = summarize(results);
  const money = currency === 'USD' ? '$' : '¥';
  const lines = [
    `## ${version} · ${day} · ${cell(model) || '（模型未知）'}`,
    '',
    `成功 **${s.passed}/${s.total}**（${s.rate}%），人工干预 ${s.interventions} 次${s.asks ? `，中途问人 ${s.asks} 次` : ''}，${s.tokens.toLocaleString('en-US')} tokens，花费 ${s.cost ? `${money}${s.cost.toFixed(2)}` : '未定价'}，用时 ${Math.round(s.seconds / 60)} 分钟。`,
    ...(note ? ['', cell(note)] : []),
    '',
    '| 任务 | 内容 | 结果 | 干预 | tokens | 秒 | 说明 |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${cell(r.id)} | ${cell(r.title)} | ${r.ok ? '✅' : '❌'} | ${r.interventions || 0} | ${r.tokens || 0} | ${Math.round(r.seconds || 0)} | ${cell(r.why).slice(0, 120)} |`),
    '',
  ];
  return lines.join('\n');
}
