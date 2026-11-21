#!/usr/bin/env node
/**
 * eval.mjs - run the evaluation set (eval/tasks.mjs) on this computer's
 * Lamplit, with its real model (1.5.6, report 8.4).
 *
 *   npm run eval                     all 25 tasks (20 everyday + 5 hard)
 *   npm run eval -- --only f1-sort,m2-reply
 *   npm run eval -- --hard           only the hard ones (eval/hard.mjs)
 *   npm run eval -- --verbose        print each round's reply of a task that failed
 *   npm run eval -- --record         also write the result into docs/EVAL.md
 *   npm run eval -- --keep           leave the task folders for a look
 *   npm run eval -- --model <id>     the evaluation bots use this model (Settings → 模型 → 其他模型),
 *                                    e.g. one with a separate key, so the runs are not paid
 *                                    from the everyday key (also EVAL_MODEL=<id>; 1.5.50)
 *
 * The bots are made as evaluation bots (eval: true): their calls show on the
 * cost page as 评测, apart, and are not counted in the daily pace or the
 * checkup's 「还能用几天」 (1.5.50).
 *
 * Each task gets a fresh bot (its own memory, its own line in the usage
 * ledger) with the everyday tools in EVAL_TOOLS, a fresh folder under
 * workspace/eval/<run>/<task>, and one message. While it works, the runner
 * answers its approval cards the way a careful person would (eval/lib.mjs
 * judgeApproval) and counts every card as one intervention. Then the task's
 * check looks at the folder, the bot's routines and its answer. Afterwards
 * the bots, their routines and the folders are removed.
 *
 * Hard tasks (1.5.14) may need the human mid-way: after each reply the
 * runner asks the task what the human says back (task.human), sends it as a
 * new message, and waits again - up to three rounds. Each answer counts as
 * one "问人"; the check sees every round's reply and the files after it.
 *
 * The hub: the desktop app's (%APPDATA%/Desk/port.json), or EVAL_HUB. It must
 * be this computer: the runner reads and writes the workspace on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS as EVERYDAY, EVAL_TOOLS } from '../eval/tasks.mjs';
import { HARD_TASKS } from '../eval/hard.mjs';
import { viewOf, norm, judgeApproval, summarize, renderRecord, levelWords } from '../eval/lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const TURN_LIMIT_MS = Number(process.env.EVAL_TURN_SECONDS || 360) * 1000;
// A model of its own for the evaluation bots (a profile id from Settings → 模型), so a separate key pays (1.5.50).
const EVAL_MODEL = String(opt('--model') || process.env.EVAL_MODEL || '').trim();

function hubUrl() {
  if (process.env.EVAL_HUB) return process.env.EVAL_HUB.replace(/\/+$/, '');
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(appData, 'Desk', 'port.json'), 'utf8'));
    return `http://127.0.0.1:${port}`;
  } catch {
    return 'http://127.0.0.1:4390';
  }
}
const HUB = hubUrl();
// The runner stands in for the human: it answers approval cards, which takes the
// local key the desktop app sends (1.5.27). It lives next to port.json.
const LOCAL_KEY = (() => {
  if (process.env.EVAL_LOCAL_KEY) return process.env.EVAL_LOCAL_KEY;
  try { return fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Desk', 'data', 'local-key'), 'utf8').trim(); } catch { return ''; }
})();
const api = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(HUB + p, { method, headers: { 'content-type': 'application/json', ...(LOCAL_KEY ? { 'x-lamplit-local': LOCAL_KEY } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${typeof data === 'object' ? data?.error?.message || data?.message || '' : String(data).slice(0, 120)}`);
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listOf = (x, ...keys) => (Array.isArray(x) ? x : keys.map((k) => x?.[k]).find(Array.isArray) || []);

function diskFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

async function runTask(task, { runDir, wsRoot }) {
  const rel = `${runDir}/${task.id}`;
  const abs = path.join(wsRoot, ...rel.split('/'));
  const started = Date.now();
  const result = { id: task.id, title: task.title, kind: task.kind, ok: false, why: '', interventions: 0, asks: 0, cards: [], tokens: 0, cost: 0, seconds: 0 };
  let bot = null;
  let truth = null;
  let usageBefore = { tokens: 0, cost: 0 };
  let usageAfter = null;
  try {
    if (task.truth) {
      try { truth = await task.truth(); } catch (err) { result.why = `取核对数据失败（${err.message}），这题不算`; result.skipped = true; return result; }
    }
    fs.mkdirSync(abs, { recursive: true });
    for (const [f, text] of Object.entries(task.files || {})) {
      const p = path.join(abs, ...norm(f).split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    // A bot's id comes from its name, so an earlier run's bot had the same one:
    // count only what this run adds.
    const usageOf = async (id) => listOf(await api('/api/usage?days=2').catch(() => null), 'byBot').find((b) => b.key === id) || { tokens: 0, cost: 0 };
    const made = await api('/api/bots', { method: 'POST', body: { name: `评测-${task.id}`, role: '评测用的临时机器人，跑完就删', tools: EVAL_TOOLS, eval: true, ...(EVAL_MODEL ? { model: EVAL_MODEL } : {}) } });
    bot = made.bot || made;
    usageBefore = await usageOf(bot.id);
    usageAfter = () => usageOf(bot.id);
    for (const r of task.setupRoutines || []) await api('/api/routines', { method: 'POST', body: { ...r, botId: bot.id } });

    const answered = new Set();
    const replies = [];
    const rounds = [];
    let status = null;
    let say = task.prompt(rel);
    for (let round = 0; say && round < 4; round += 1) {
    const sent = await api(`/api/bots/${encodeURIComponent(bot.id)}/message`, { method: 'POST', body: { text: say } });
    const turnId = sent.turnId;
    const turnStarted = Date.now();
    let mine = [];
    status = null;
    while (!status) {
      await sleep(2000);
      for (const card of listOf(await api(`/api/approvals?status=pending&botId=${encodeURIComponent(bot.id)}&limit=20`), 'approvals', 'items')) {
        if (answered.has(card.id) || card.botId !== bot.id) continue;
        answered.add(card.id);
        const decision = judgeApproval(card, rel);
        result.interventions += 1;
        result.cards.push(`${card.toolName}:${decision}`);
        if (decision === 'deny') console.log(`
  拒绝了：${card.toolName} ${JSON.stringify(card.args || {}).slice(0, 160)}`);
        await api(`/api/approvals/${encodeURIComponent(card.id)}`, { method: 'POST', body: { decision, note: decision === 'deny' ? '评测：这一步超出了任务范围' : '' } }).catch(() => {});
      }
      mine = listOf(await api(`/api/bots/${encodeURIComponent(bot.id)}/messages?limit=200`), 'items').filter((m) => m.turnId === turnId);
      status = mine.find((m) => m.role === 'status');
      if (!status && Date.now() - turnStarted > TURN_LIMIT_MS) {
        await api(`/api/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
        result.why = `超过 ${TURN_LIMIT_MS / 1000} 秒没做完`;
        break;
      }
    }
    replies.push(mine.filter((m) => m.role === 'assistant').map((m) => m.text || '').join('\n'));
    rounds.push(diskFiles(abs));
    if (!status) break;
    say = round < 3 && task.human ? String(task.human(replies[round], round) || '') : '';
    if (say) result.asks += 1;
    }
    const reply = replies.join('\n');
    result.replies = replies;
    const routines = listOf(await api('/api/routines'), 'routines').filter((r) => r.botId === bot.id);
    if (status) {
      const view = viewOf({
        read: (f) => { try { return fs.readFileSync(path.join(abs, ...f.split('/')), 'utf8'); } catch { return null; } },
        files: () => diskFiles(abs),
        routines,
        reply,
        truth,
        replies,
        rounds,
      });
      const verdict = await task.check(view);
      result.ok = verdict.ok;
      result.why = verdict.ok ? '' : verdict.why;
      if (status.status !== 'success' && !verdict.ok) result.why = `${result.why}（回合：${status.status}）`;
    }
  } catch (err) {
    result.why = `运行出错：${err.message}`;
  } finally {
    result.seconds = (Date.now() - started) / 1000;
    if (bot) {
      if (usageAfter) {
        const after = await usageAfter();
        result.tokens = Math.max(0, after.tokens - usageBefore.tokens);
        result.cost = Math.max(0, Math.round((after.cost - usageBefore.cost) * 10000) / 10000);
      }
      for (const r of listOf(await api('/api/routines').catch(() => []), 'routines')) {
        if (r.botId === bot.id) await api(`/api/routines/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => {});
      }
      // ?forget=1: a test bot's name is not kept for the activity log (1.5.34).
      await api(`/api/bots/${encodeURIComponent(bot.id)}?forget=1`, { method: 'DELETE' }).catch((err) => console.warn(`  ! 机器人 ${bot.id} 没删掉：${err.message}`));
      // Deleting a bot keeps its history in data/deleted-bots (1.5.15); an evaluation bot's is not worth keeping.
      try {
        const kept = path.join(DATA_DIR, 'deleted-bots');
        for (const d of fs.readdirSync(kept)) if (d.startsWith(`${bot.id}-`)) fs.rmSync(path.join(kept, d), { recursive: true, force: true });
      } catch { /* none */ }
    }
  }
  return result;
}

const only = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;
const TASKS = [...EVERYDAY, ...HARD_TASKS];
const tasks = TASKS.filter((t) => (!only || only.has(t.id)) && (!flag('--hard') || t.kind === 'hard'));
if (!tasks.length) { console.error('没有要跑的任务'); process.exit(1); }

const health = await api('/api/health');
const DATA_DIR = health?.dataDir || '';
const settings = await api('/api/settings');
const model = settings?.model?.model || '';
const ws = await api('/api/workspace');
const wsRoot = ws.path;
if (!wsRoot || !fs.existsSync(wsRoot)) { console.error(`工作区 ${wsRoot} 不在这台电脑上：评测只能跑本机的 Lamplit`); process.exit(1); }
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const runDir = `eval/${runId}`;
const version = health?.version || JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
// The approval level decides how many cards come up (1.5.52, F2): said at the top and in the record.
const policy = await api('/api/policy').catch(() => null);
const level = policy?.level || policy?.effective?.level || '';
console.log(`评测 ${tasks.length} 题 · Lamplit ${version} · 模型 ${model || '（未知）'} · 审批档 ${levelWords(level)}`);

const results = [];
try {
  for (const task of tasks) {
    process.stdout.write(`- ${task.id} ${task.title} … `);
    const r = await runTask(task, { runDir, wsRoot });
    results.push(r);
    if (flag('--verbose') && !r.ok && r.replies) r.replies.forEach((t, i) => console.log(`    第 ${i + 1} 轮回复：${String(t).replace(/\s+/g, ' ').slice(0, 600)}`));
    console.log(`${r.skipped ? '跳过' : r.ok ? '✅' : '❌'} ${Math.round(r.seconds)}s，干预 ${r.interventions}${r.asks ? `，问人 ${r.asks}` : ''}${r.cards.length ? `（${r.cards.join(' ')}）` : ''}，${r.tokens} tokens${r.why ? `；${r.why}` : ''}`);
  }
} finally {
  if (!flag('--keep')) fs.rmSync(path.join(wsRoot, 'eval', runId), { recursive: true, force: true });
  // The undo copies the bots' writes and deletes left in .trash (1.5.8): this run's only.
  try {
    for (const day of fs.readdirSync(path.join(wsRoot, '.trash'))) {
      const dayDir = path.join(wsRoot, '.trash', day);
      for (const f of fs.readdirSync(dayDir).filter((n) => n.endsWith('.json'))) {
        let rel = '';
        try { rel = JSON.parse(fs.readFileSync(path.join(dayDir, f), 'utf8')).rel || ''; } catch { /* not ours */ }
        if (!rel.startsWith(`${runDir}/`)) continue;
        fs.rmSync(path.join(dayDir, f), { force: true });
        fs.rmSync(path.join(dayDir, f.replace(/\.json$/, '')), { recursive: true, force: true });
      }
      if (!fs.readdirSync(dayDir).length) fs.rmSync(dayDir, { recursive: true, force: true });
    }
    if (!fs.readdirSync(path.join(wsRoot, '.trash')).length) fs.rmSync(path.join(wsRoot, '.trash'), { recursive: true, force: true });
  } catch { /* no trash */ }
  const evalRoot = path.join(wsRoot, 'eval');
  try { if (!flag('--keep') && !fs.readdirSync(evalRoot).length) fs.rmSync(evalRoot, { recursive: true, force: true }); } catch { /* gone */ }
}

const counted = results.filter((r) => !r.skipped);
const s = summarize(counted);
const usage = await api('/api/usage?days=1').catch(() => null);
console.log(`\n成功 ${s.passed}/${s.total}（${s.rate}%），人工干预 ${s.interventions} 次${s.asks ? `，中途问人 ${s.asks} 次` : ''}，${s.tokens} tokens，花费 ${s.cost || '未定价'}，用时 ${Math.round(s.seconds / 60)} 分钟`);
if (flag('--record')) {
  const skipped = results.filter((r) => r.skipped).map((r) => r.id);
  const note = [only || flag('--hard') ? `只跑了 ${tasks.length} 题。` : '', skipped.length ? `${skipped.join('、')} 取不到核对数据，没算。` : ''].join('');
  const day = new Date().toLocaleDateString('sv-SE');
  const doc = path.join(REPO, 'docs', 'EVAL.md');
  const text = fs.readFileSync(doc, 'utf8');
  const marker = '<!-- results: newest first -->';
  const record = renderRecord({ version, day, model, currency: usage?.currency || 'CNY', results: counted, note, level });
  fs.writeFileSync(doc, text.includes(marker) ? text.replace(marker, `${marker}\n\n${record}`) : `${text}\n${record}`);
  console.log(`已写入 docs/EVAL.md`);
}
