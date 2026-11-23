#!/usr/bin/env node
/**
 * eval-collab.mjs - the group-collaboration eval (1.5.65): six scenarios from what the user's
 * content group really ran into, a scripted human, mock platform sites, nine invariants.
 *
 *   node scripts/eval-collab.mjs --fake                 all six, scripted fake model, own test hubs
 *   node scripts/eval-collab.mjs --fake --only s1,s3    some of them
 *   node scripts/eval-collab.mjs --fake --plant two-cards[,contradict]   with planted violations
 *   node scripts/eval-collab.mjs --fake --self-check    the harness checks itself (what smoke runs)
 *   node scripts/eval-collab.mjs --fake --app <dir>     the test hubs run another checkout's code
 *
 *   node scripts/eval-collab.mjs --real                 a real model on hubs you point it at:
 *        EVAL_HUB=http://127.0.0.1:<port>  EVAL_LOCAL_KEY=<that hub's data/local-key>
 *        EVAL_PEER=http://…  EVAL_PEER_KEY=…      (scenario 3 only: a second machine the first knows)
 *        --model <profile id>                     the 评测 bots use this model (Settings → 模型)
 *   node scripts/eval-collab.mjs --real --test-hubs     a real model on this run's own test hubs:
 *        EVAL_PROVIDER, EVAL_BASE_URL, EVAL_MODEL_NAME, EVAL_API_KEY
 *
 *   --keep      leave the test hubs' folders (and an attached hub's run folder) for a look
 *   --verbose   print every model call and human step
 *   --out <dir> where the report goes (default eval-results/, gitignored)
 *
 * The bots are 「评测-」 bots made fresh per scenario (eval: true, apart on the cost page) and
 * deleted afterwards with their group. The mock sites listen on 127.0.0.1 only (EVAL_MOCK_HOST to
 * change); a hub must allow private addresses (ALLOW_PRIVATE=1) for its bots to reach them - the
 * test hubs do. Nothing here ever touches a real platform.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSites } from '../eval/collab/mocksites.mjs';
import { SCENARIOS, PLANTS } from '../eval/collab/scenarios.mjs';
import { runScenario } from '../eval/collab/run.mjs';
import { runSelfCheck } from '../eval/collab/selfcheck.mjs';
import { writeReport } from '../eval/collab/report.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] || '' : ''; };
const fail = (msg) => { console.error(msg); process.exit(2); };

const mode = flag('--real') ? 'real' : flag('--fake') ? 'fake' : '';
if (!mode) fail('要说跑哪种：--fake（假模型，自己起测试 hub）或 --real（真模型）。用法见文件开头。');
const verbose = flag('--verbose');
const log = (s) => { if (verbose) console.log(`  ${s}`); };
const outDir = path.resolve(opt('--out') || path.join(REPO, 'eval-results'));
const appDir = opt('--app') ? path.resolve(opt('--app')) : null;
if (appDir && !fs.existsSync(path.join(appDir, 'src', 'server.mjs'))) fail(`--app ${appDir}：那里没有 src/server.mjs`);
const plant = new Set(opt('--plant').split(',').map((s) => s.trim()).filter(Boolean));
for (const p of plant) if (!PLANTS[p]) fail(`没有这种埋法：${p}（有：${Object.keys(PLANTS).join('、')}）`);
if (plant.size && mode !== 'fake') fail('--plant 只用在 --fake');

const only = opt('--only') ? opt('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
const pick = SCENARIOS.filter((s) => !only || only.some((o) => s.id === o || s.id.startsWith(`${o}-`)));
// A planted run goes to the scenario its plants live in.
const scenarios = plant.size && !only ? SCENARIOS.filter((s) => [...plant].some((p) => PLANTS[p].scenario === s.id)) : pick;
if (!scenarios.length) fail(`没有这些场景：${only?.join(',')}（有：${SCENARIOS.map((s) => s.id).join('、')}）`);

// --real: where and with which model. Never a hub found on its own: only the one named.
let real = null;
if (mode === 'real') {
  if (flag('--test-hubs')) {
    const need = ['EVAL_PROVIDER', 'EVAL_BASE_URL', 'EVAL_MODEL_NAME', 'EVAL_API_KEY'].filter((k) => !process.env[k]);
    if (need.length) fail(`--real --test-hubs 要这些环境变量：${need.join('、')}`);
    real = { settings: { provider: process.env.EVAL_PROVIDER, baseUrl: process.env.EVAL_BASE_URL, model: process.env.EVAL_MODEL_NAME, apiKey: process.env.EVAL_API_KEY } };
  } else {
    if (!process.env.EVAL_HUB) fail('--real 要 EVAL_HUB（和 EVAL_LOCAL_KEY）：评测只跑在你明确指定的 hub 上。');
    real = {
      hub: { url: process.env.EVAL_HUB.replace(/\/+$/, ''), key: process.env.EVAL_LOCAL_KEY || '' },
      peer: process.env.EVAL_PEER ? { url: process.env.EVAL_PEER.replace(/\/+$/, ''), key: process.env.EVAL_PEER_KEY || '' } : null,
      model: opt('--model') || process.env.EVAL_MODEL || '',
    };
    if (!real.hub.key) fail('EVAL_LOCAL_KEY 没设：那台 hub 的 data/local-key（评测替人点审批卡要用它）。');
  }
}

const version = await (async () => {
  if (real?.hub) {
    try { const r = await fetch(`${real.hub.url}/api/health`, { headers: { 'x-lamplit-local': real.hub.key } }); return (await r.json()).version || '?'; } catch { return '?'; }
  }
  try { return JSON.parse(fs.readFileSync(path.join(appDir || REPO, 'package.json'), 'utf8')).version; } catch { return '?'; }
})();
const model = mode === 'fake' ? 'fake' : real?.settings?.model || real?.model || '（那台 hub 的默认模型）';

const mock = await startMockSites({ host: process.env.EVAL_MOCK_HOST || '127.0.0.1', port: Number(process.env.EVAL_MOCK_PORT) || 0 });
console.log(`协作评测 · Lamplit ${version} · ${mode === 'fake' ? '假模型' : `真模型 ${model}`}${appDir ? ` · 代码 ${appDir}` : ''} · 模拟站点 ${mock.url}`);

const run = { version, at: new Date().toISOString(), mode, model, app: appDir ? path.basename(appDir) : '', plant: [...plant], currency: 'CNY', results: [] };
let exitCode = 0;
try {
  if (flag('--self-check')) {
    if (mode !== 'fake') fail('--self-check 只用在 --fake');
    const sc = await runSelfCheck({ mock, appDir: appDir || undefined, log: (s) => console.log(`- ${s}`), runLog: log });
    for (const p of sc.proofs) console.log(`  证明 ${p.id}：${p.ok ? '✅' : `❌ ${p.detail}`}`);
    for (const p of sc.plants) console.log(`  埋 ${p.plant} → ${p.catches}：${p.landed ? (p.caught ? '落地了，抓到了 ✅' : `落地了，没抓到 ❌ ${p.detail}`) : '没落地（这一版上没发生）'}`);
    run.results = sc.clean;
    run.selfCheck = { rows: sc.rows, notes: sc.notes };
    exitCode = sc.ok ? 0 : 1;
    console.log(sc.ok ? '自检通过：每条检查都被证明能抓到它该抓的。' : '自检没通过：见上面 ❌。');
  } else {
    for (const sc of scenarios) {
      process.stdout.write(`- ${sc.id} ${sc.title} … `);
      const r = await runScenario(sc, { mode, plant, mock, real, appDir: appDir || undefined, log, keep: flag('--keep'), runId: run.at.replace(/[-:.TZ]/g, '').slice(0, 14) });
      mock.reset();
      run.results.push(r);
      const bad = [...r.checks, ...r.extra].filter((c) => !c.ok);
      console.log(`${bad.length || r.errors.length ? '❌' : '✅'} ${r.metrics.seconds}s，${r.metrics.cards} 张卡，${r.metrics.tokens} tokens${bad.length ? `；没过：${bad.map((c) => c.id).join('、')}` : ''}${r.errors.length ? `；${r.errors.join('；')}` : ''}`);
    }
    exitCode = run.results.every((r) => r.errors.length === 0 && [...r.checks, ...r.extra].every((c) => c.ok)) ? 0 : 1;
  }
} finally {
  await mock.close();
}
const written = writeReport(run, { dir: outDir });
console.log(`报告：${path.relative(REPO, written.md)}${written.prev ? `（和 ${written.prev} 比）` : ''}`);
process.exit(exitCode);
