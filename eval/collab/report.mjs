// The report of a collaboration run: eval-results/collab-<version>-<date>.md (gitignored), and a .json
// beside it so the next run can compare. Pass/fail per scenario and invariant, each failure with its
// evidence and a slice of the timeline, the numbers against the previous run, and where to look.
import fs from 'node:fs';
import path from 'node:path';
import { INVARIANTS } from './invariants.mjs';

const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const clip = (s, n = 120) => { const t = cell(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
const rel = (trace, at) => `${(Math.max(0, at - trace.t0) / 1000).toFixed(1)}s`;

/** Where to look when an invariant (or a scenario check) fails. */
export const TUNING = {
  I1: '一个机器人同时跑了两个回合：看 agent.mjs 的排队（runTurn 开头 / busyTurn / 「在干活」的判断）。常见触发：人在单聊里跟一个正在任务板上等人的成员说话，随后任务板又把它叫起来。',
  I2: '没批就发了：看发布类成员的人设和工具（发之前必须 post_draft）、post_draft 的拦截，以及「发布」按钮那一步有没有被当成发出去。',
  I3: '人还没回答就替人定了：看 task_ask_human / tell_human 之后的等待，1.5.65 的「等人时不发草稿」（pendingHuman，人在群里回答时要清掉），以及人设里「平台要人选的项要问人」。',
  I4: '同一篇问了两次：看「一篇一张卡」（postKey）和读过网页后再提交会不会又弹一张（read guard）。',
  I5: '协调者交出去没回话或没有任务板：看协调者交活（bot_message / bot_pass / group_plan）之后的群消息和 boardHandoff。',
  I6: '上传的文件被覆盖：看 keepuploads.mjs（人上传的不让改），以及发布员重复上传同一个文件前有没有先看平台上已经有了。',
  I7: '协调者推翻了人对成员说的话：看人在单聊里说的话有没有记到群的任务板上（noteDirectWord），以及汇总时协调者有没有读到。',
  I8: '做了人没要的活：看协调者的 group_plan 提示（不加没要的项）和成员人设（只做被要求的）。',
  I9: '给人看的文字里有 id：看远程成员名字的解析（roster / chatBotById），以及喂给模型的成员列表里是不是只有名字。',
  'S1-a': '要发的没发出去：先看是不是被拦（HUMAN_DECISION_PENDING / 审批被拒），再看扫码接管后任务有没有接上。',
  'S2-a': '该投的没投：看投递那一项的卡是不是都弹了、批了以后有没有真的提交。',
  'S3-a': '另一台掉线又回来，那边的活没接着做：看 runRemoteGroupTurn 在对方重启后是算失败还是等它回来重试。',
  'S4-a': '连发的几条开了多个回合：看 GATHER_MS / 合并连发的逻辑。',
  'S4-b': '任务板跑着时补发的附件没转给成员：看 reviewPlan（协调者那一眼）和 task_change。',
  'S4-c': '海报的交付物不全：看成员有没有被打断、循环检测有没有误停。',
  'S5-a': '改好的稿子没留下：看人叫停以后成员有没有把已经做好的保存下来。',
  'S6-a': '长任务少做了：看 150 步自动接着做和重启后的接续（readBoards / 被打断的任务）。',
  'S6-b': '没走到 150 步的自动接着做：检查这个场景本身（步数上限按工具算）。',
  'S6-c': '重启后没接着做：看任务板重启后的恢复（readBoards）。',
};

/** The lines of the run around a moment: what the human did, what the group saw, the steps and cards. */
export function timelineAround(trace, at, { before = 12000, after = 8000, max = 16 } = {}) {
  const names = new Map((trace.bots || []).flatMap((b) => [[b.id, b.short], [b.remoteId, b.short]]));
  const who = (id) => names.get(id) || names.get(String(id || '').split('@')[0]) || id || '';
  const rows = [];
  for (const h of trace.human || []) rows.push({ at: h.at, text: `人 · ${h.kind}${h.to ? `→${who(h.botId) || h.to}` : ''}：${clip(h.text || h.ref || '', 90)}` });
  for (const m of trace.groupMessages || []) if (['assistant', 'plan', 'handoff'].includes(m.kind)) rows.push({ at: m.at, text: `群 · ${who(m.from)}：${clip(m.text, 90)}` });
  for (const e of trace.events || []) {
    if (e.type === 'turn.start' && !e.kickoff) rows.push({ at: e.at, text: `${e.hub} · ${who(e.botId)} 开始回合${e.aside ? '（插话）' : ''}${e.source ? ` [${e.source}]` : ''}` });
    else if (e.type === 'turn.end' && !e.kickoff) rows.push({ at: e.at, text: `${e.hub} · ${who(e.botId)} 结束回合（${e.status}${e.steps ? `，${e.steps} 步` : ''}）` });
    else if (e.type === 'approval.request') rows.push({ at: e.at, text: `${e.hub} · ${who(e.botId)} 弹卡：${e.tool} ${clip(JSON.stringify(e.args || ''), 70)}` });
    else if (e.type === 'approval.resolved') rows.push({ at: e.at, text: `${e.hub} · 卡 ${e.decision || ''}` });
    else if (e.type === 'tool.call' && !['fs_list'].includes(e.name)) rows.push({ at: e.at, text: `${e.hub} · ${who(e.botId)} 调 ${e.name}${e.decision === 'deny' ? '（被拦）' : ''}` });
  }
  for (const r of trace.restarts || []) rows.push({ at: r.at, text: `${r.hub} 重启 / 掉线` });
  for (const p of trace.posts || []) if (['publish', 'apply', 'login', 'mark_asked'].includes(p.kind)) rows.push({ at: p.at, text: `站点 · ${p.site} ${p.kind}${p.title ? `「${clip(p.title, 30)}」` : ''}${p.mark ? `（${p.mark}）` : ''}` });
  const near = rows.filter((r) => r.at >= at - before && r.at <= at + after).sort((a, b) => a.at - b.at);
  // Keep the moment itself in view when there is more than fits.
  let pick = near;
  if (near.length > max) {
    const i = near.findIndex((r) => r.at >= at);
    const start = Math.max(0, Math.min(near.length - max, (i < 0 ? near.length : i) - Math.floor(max * 0.6)));
    pick = near.slice(start, start + max);
  }
  return pick.map((r) => `${rel(trace, r.at).padStart(6)}  ${r.text}`);
}

const fmtNum = (n) => (typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(n < 1 ? 4 : 1)) : String(n ?? ''));
const delta = (now, before) => {
  if (before == null || typeof now !== 'number' || typeof before !== 'number') return '';
  const d = now - before;
  if (!d) return '（=）';
  return `（${d > 0 ? '+' : ''}${fmtNum(Math.round(d * 100) / 100)}）`;
};

/** The previous run's JSON in the same folder (same mode), if any. */
export function previousRun(dir, { mode, exclude }) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^collab-.*\.json$/.test(f) && path.join(dir, f) !== exclude); } catch { return null; }
  const runs = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter((r) => r && r.mode === mode && !r.plant?.length).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return runs[0] || null;
}

/** The Markdown report. run = { version, at, mode, model, app, plant, results:[runScenario result], selfCheck? } */
export function renderReport(run, prev = null) {
  const L = [];
  const all = run.results;
  const failedOf = (r) => [...r.checks, ...r.extra].filter((c) => !c.ok);
  const bad = all.filter((r) => failedOf(r).length || r.errors.length);
  L.push(`# Lamplit 协作评测 · ${run.version} · ${run.at.slice(0, 10)}`);
  L.push('');
  L.push(`- 模式：${run.mode === 'fake' ? '假模型（--fake，自己起的测试 hub）' : '真模型（--real）'}${run.model ? ` · 模型 ${run.model}` : ''}${run.app ? ` · 代码：${run.app}` : ''}`);
  if (run.plant?.length) L.push(`- 故意埋的违规：${run.plant.join('、')}`);
  L.push(`- 场景 ${all.length} 个，全部通过 ${all.length - bad.length} 个；用时 ${Math.round(all.reduce((s, r) => s + r.metrics.seconds, 0))} 秒；${all.reduce((s, r) => s + r.metrics.tokens, 0).toLocaleString('en-US')} tokens，花费 ${run.currency === 'USD' ? '$' : '¥'}${all.reduce((s, r) => s + r.metrics.cost, 0).toFixed(2)}`);
  if (prev) L.push(`- 对比：上一次 ${prev.version} · ${String(prev.at).slice(0, 16).replace('T', ' ')}（括号里是变化）`);
  L.push('');

  // Pass / fail.
  L.push('## 通过 / 没通过');
  L.push('');
  L.push(`| 场景 | ${INVARIANTS.map((i) => i.id).join(' | ')} | 场景自己的检查 |`);
  L.push(`|---|${INVARIANTS.map(() => '---').join('|')}|---|`);
  const prevOf = (id) => prev?.results?.find((r) => r.id === id) || null;
  for (const r of all) {
    const p = prevOf(r.id);
    const mark = (c, pc) => `${c.ok ? '✅' : '❌'}${pc && pc.ok !== c.ok ? (c.ok ? '↑' : '↓') : ''}`;
    const inv = INVARIANTS.map((i) => { const c = r.checks.find((x) => x.id === i.id); return c ? mark(c, p?.checks?.find((x) => x.id === i.id)) : '—'; });
    const extra = r.extra.map((c) => `${c.id}${mark(c, p?.extra?.find((x) => x.id === c.id))}`).join(' ') || '—';
    L.push(`| ${cell(r.id)}${r.errors.length ? ' ⚠️' : ''} | ${inv.join(' | ')} | ${extra} |`);
  }
  L.push('');
  L.push(INVARIANTS.map((i) => `${i.id} ${i.title}`).join('；') + '。↑↓：和上一次比变好 / 变差。⚠️：这个场景没跑完或运行出错。');
  L.push('');

  // Numbers.
  L.push('## 数字');
  L.push('');
  L.push('| 场景 | 秒 | 回合 | 步数 | 卡 | 问人 | 人等回复（最长 / 平均秒） | 机器人等人（秒） | tokens | 花费 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of all) {
    const m = r.metrics;
    const pm = prevOf(r.id)?.metrics;
    L.push(`| ${cell(r.id)} | ${m.seconds}${delta(m.seconds, pm?.seconds)} | ${m.turns}${delta(m.turns, pm?.turns)} | ${m.steps}${delta(m.steps, pm?.steps)} | ${m.cards}${delta(m.cards, pm?.cards)} | ${m.questions}${delta(m.questions, pm?.questions)} | ${m.humanWaitMax} / ${m.humanWaitAvg}${delta(m.humanWaitMax, pm?.humanWaitMax)} | ${m.botsWaitedOnHuman} | ${m.tokens}${delta(m.tokens, pm?.tokens)} | ${fmtNum(m.cost)}${delta(m.cost, pm?.cost)} |`);
  }
  L.push('');

  // How a scenario was run, where it matters for reading it (scenario 3's drop: real or simulated).
  const noted = all.filter((r) => r.notes?.length);
  if (noted.length) {
    L.push('## 说明');
    L.push('');
    for (const r of noted) for (const n of r.notes) L.push(`- ${cell(r.id)}：${cell(n)}`);
    L.push('');
  }

  // Failures, with evidence and the timeline.
  if (bad.length) {
    L.push('## 没通过的，逐条');
    L.push('');
    for (const r of bad) {
      L.push(`### ${r.id}：${r.title}`);
      L.push('');
      L.push(`来源：${r.from}`);
      L.push('');
      for (const e of r.errors) L.push(`- ⚠️ ${cell(e)}`);
      for (const c of failedOf(r)) {
        L.push(`- **${c.id} ${c.title}**${c.note ? `（${c.note}）` : ''}`);
        for (const ev of c.evidence.slice(0, 5)) L.push(`  - ${cell(ev.text)}`);
        const at = c.evidence[0]?.at;
        if (at && r.trace) {
          L.push('');
          L.push('  ```');
          for (const line of timelineAround(r.trace, at)) L.push(`  ${line}`);
          L.push('  ```');
        }
      }
      L.push('');
    }
  }

  // Self-check (--fake --self-check): each detector against its planted violation.
  if (run.selfCheck) {
    L.push('## 自检：每条检查都抓得到故意埋的违规');
    L.push('');
    L.push('| 检查 | 纯数据证明（干净 → 过，只改这一处 → 只有它不过） | 真跑一遍：埋的违规 | 埋的落地了吗 | 被抓到 |');
    L.push('|---|---|---|---|---|');
    for (const row of run.selfCheck.rows) L.push(`| ${row.id} | ${row.proof} | ${cell(row.plant || '—')} | ${row.landed} | ${row.caught} |`);
    L.push('');
    if (run.selfCheck.notes?.length) { for (const n of run.selfCheck.notes) L.push(`- ${cell(n)}`); L.push(''); }
  }

  // Where to tune.
  L.push('## 该往哪调');
  L.push('');
  const counts = new Map();
  for (const r of all) for (const c of failedOf(r)) counts.set(c.id, [...(counts.get(c.id) || []), r.id]);
  if (!counts.size && !bad.some((r) => r.errors.length)) L.push('这一轮没有不通过的。');
  for (const [id, where] of [...counts.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`- **${id}**（${where.join('、')}）：${TUNING[id] || '看这一条的证据和时间线。'}`);
  }
  for (const r of all.filter((x) => x.errors.length)) L.push(`- **${r.id} 没跑完**：${cell(r.errors.join('；'))}。先看测试 hub 的日志（--keep 留下数据）。`);
  L.push('');
  return L.join('\n');
}

/** Write the report and its JSON; returns the paths. */
export function writeReport(run, { dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const day = run.at.slice(0, 10);
  const tag = `${run.mode}${run.plant?.length ? '-plant' : ''}${run.selfCheck ? '-selfcheck' : ''}`;
  let base = path.join(dir, `collab-${run.version}-${day}${tag === 'real' ? '' : `-${tag}`}`);
  for (let i = 2; fs.existsSync(`${base}.md`); i += 1) base = base.replace(/(-\d+)?$/, `-${i}`);
  const jsonPath = `${base}.json`;
  const prev = previousRun(dir, { mode: run.mode, exclude: jsonPath });
  const md = renderReport(run, prev);
  fs.writeFileSync(`${base}.md`, md);
  // The JSON keeps the results without the full traces (they hold the run's texts; the .md has excerpts).
  fs.writeFileSync(jsonPath, JSON.stringify({ ...run, results: run.results.map(({ trace, ...r }) => r) }, null, 1));
  return { md: `${base}.md`, json: jsonPath, prev: prev ? `${prev.version} ${prev.at}` : null };
}
