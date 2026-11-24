// 1.5.68: a round that goes on by itself knows what the rounds before it sent out.
//   11-24, TikTok运营, 「可以排」: round 1 put the video on TikTok and clicked 「预约发布」, started YouTube and ran
//   out of its 150 steps. Round 2 was handed the last 30 steps as `browser_upload()`, `browser_click()` …
//   (no file, no button, no page; the publish older than those 30), uploaded to TikTok again and scheduled a
//   second copy; round 3 uploaded to YouTube a third time. Now browser steps are handed on in words, the
//   ones that went out (★) for the whole chain, and the same file is not uploaded again to a site where
//   it was published in the same chain unless the bot says again: true.
// Nothing here opens a browser: the browser tools are stand-ins. Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TT_UP = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';
const TT_LIST = 'https://www.tiktok.com/tiktokstudio/content';
const YT_UP = 'https://studio.youtube.com/channel/UC1/videos/upload';

export async function carryChecks({ check, toolsMod, readText }) {
  const C = await import('../src/carryover.mjs');
  const A = await import('../src/agent.mjs');

  // --- CR68-1: a browser step in words ---------------------------------------------------------------
  const up = C.stepWords({ name: 'browser_upload', args: { paths: ['tiktok/drafts/縁側-金沢_15s.mp4'] }, result: { ok: true, files: ['縁側-金沢_15s.mp4'] }, page: TT_UP });
  const pub = C.stepWords({ name: 'browser_click', args: { ref: '@e37' }, result: { ok: true, clicked: { tag: 'button', name: '预约发布' }, url: TT_LIST }, page: TT_UP });
  const plain = C.stepWords({ name: 'browser_click', args: { ref: '@e9' }, result: { ok: true, clicked: { tag: 'button', name: '编辑封面' }, url: TT_UP }, page: TT_UP });
  const evalPub = C.stepWords({ name: 'browser_eval', args: { expression: "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='预约发布'&&!e.disabled);if(!b)return 'nf';b.click();return 'clicked';})()" }, result: { ok: true, value: 'clicked' }, page: TT_UP });
  const evalMiss = C.stepWords({ name: 'browser_eval', args: { expression: "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='发布');if(!b)return 'nf';b.click();return 'clicked';})()" }, result: { ok: true, value: 'nf' }, page: TT_UP });
  const evalRead = C.stepWords({ name: 'browser_eval', args: { expression: "document.querySelectorAll('input').length" }, result: { ok: true, value: 3 }, page: TT_UP });
  check('CR68-1 a browser step says which page, file and button: an upload and a click on 「预约发布」 (also by a page script that did click) went out; 「编辑封面」, a script that found nothing to click and one that only reads did not',
    up.did === '在 www.tiktok.com/tiktokstudio/upload 上传了 縁側-金沢_15s.mp4' && up.out && up.files?.[0] === '縁側-金沢_15s.mp4'
    && pub.did === '在 www.tiktok.com/tiktokstudio/upload 点了「预约发布」，页面到了 www.tiktok.com/tiktokstudio/content' && pub.out && pub.page === TT_LIST
    && !plain.out && /点了「编辑封面」/.test(plain.did) && evalPub.out && /用脚本点了「预约发布」（脚本返回 clicked）/.test(evalPub.did)
    && !evalMiss.out && evalRead.did === '' && !evalRead.out, JSON.stringify({ up, pub, evalPub: evalPub.did, evalMiss }));

  // --- CR68-2: what is handed on ---------------------------------------------------------------------
  const chain = [{ name: 'browser_open', args: { url: TT_UP }, ok: true, ...C.stepWords({ name: 'browser_open', args: { url: TT_UP }, result: { ok: true, url: TT_UP } }) },
    { name: 'browser_upload', args: { paths: ['v.mp4'] }, ok: true, ...up }, { name: 'browser_click', args: {}, ok: true, ...pub }];
  for (let i = 0; i < 200; i += 1) chain.push({ name: 'browser_click', args: {}, ok: true, ...C.stepWords({ name: 'browser_click', args: {}, result: { ok: true, clicked: { name: `选项 ${i}` }, url: YT_UP }, page: YT_UP }) });
  chain.push({ name: 'browser_eval', args: {}, ok: true, ...evalRead }, { name: 'fs_write', args: { path: 'notes/progress.md' }, ok: true }, { name: 'x_post', args: { text: 'hi' }, ok: true });
  const told = A.describeActions(chain);
  const stars = told.filter((l) => l.startsWith('★ '));
  check('CR68-2 handed on: what went out in the whole chain (★, in order, here 200 steps back), then the latest 30 other steps; a step without a line is left out; other tools keep their old line',
    stars.length === 3 && /上传了 縁側-金沢_15s\.mp4/.test(stars[0]) && /点了「预约发布」/.test(stars[1]) && stars[2] === '★ x_post(text="hi")'
    && told.length === 33 && told[0] === stars[0] && told.includes('fs_write(path="notes/progress.md")') && !told.some((l) => /选项 169/.test(l)) && told.some((l) => /选项 199/.test(l)),
    JSON.stringify(told.slice(0, 4)));
  const cont = A.continuationText({ n: 1, what: '用户交给你的事', actions: told });
  const resume = A.resumeNote({ text: '再出一个视频', status: 'max_steps', actions: told });
  check('CR68-2b the go-on and 「继续」 both say what ★ means: already out, the whole chain, not to be done again; look at the site\'s list when unsure',
    /带 ★ 的是已经往外做了的/.test(cont) && /不要再做一遍/.test(cont) && /带 ★ 的是已经往外做了的/.test(resume)
    && !/带 ★/.test(A.continuationText({ n: 1, what: 'x', actions: ['fs_write(path="a")'] })));

  // --- CR68-3: the same file to the same site, after it was published there --------------------------
  const sentBefore = [{ name: 'browser_upload', ok: true, ...up }, { name: 'browser_click', ok: true, ...C.stepWords({ name: 'browser_click', result: { clicked: { name: 'schedule' } }, page: TT_UP }) }, { name: 'browser_click', ok: true, ...pub }];
  const again = C.alreadySent(sentBefore, ['tiktok/drafts/縁側-金沢_15s.mp4'], 'https://tiktok.com/tiktokstudio/upload');
  check('CR68-3 the same file to the same site after it was published there in this chain is stopped, saying where and which button (the last one, 「预约发布」), and how to mean it (again: true)',
    /縁側-金沢_15s\.mp4 这一串活里已经在 tiktok\.com 上传过/.test(again) && /点了「预约发布」/.test(again) && /again: true/.test(again),
    again);
  check('CR68-3b not stopped: another site, another file, a site where nothing went out yet, a failed upload before',
    C.alreadySent(sentBefore, ['v/縁側-金沢_15s.mp4'], YT_UP) === '' && C.alreadySent(sentBefore, ['other.mp4'], TT_UP) === ''
    && C.alreadySent([{ name: 'browser_upload', ok: true, ...up }], ['縁側-金沢_15s.mp4'], TT_UP) === ''
    && C.alreadySent([{ name: 'browser_upload', ok: false, ...up }, { name: 'browser_click', ok: true, ...pub }], ['縁側-金沢_15s.mp4'], TT_UP) === '');

  // --- CR68-4: wired into every bot's turn -----------------------------------------------------------
  const agentSrc = await readText('../src/agent.mjs');
  const toolsSrc = await readText('../src/tools.mjs');
  check('CR68-4 every bot\'s turn: browser steps get their words and page, the page carries over a go-on, and browser_upload takes again: true',
    agentSrc.includes("const w = stepWords({ name: call.name, args: receipt.args, result: res, ok: receipt.ok, page: ctx.pageUrl });")
    && agentSrc.includes("ctx.pageUrl = [...receipts].reverse().find((r) => r.page)?.page || '';") && agentSrc.includes("if (name === 'browser_upload' && args.again !== true && ctx?.receipts) {")
    && toolsSrc.includes("again: { type: 'boolean'"));

  // --- CR68-5: the 11-24 run, end to end ------------------------------------------------------------
  const { AgentRuntime } = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-cr68-'));
  try {
    fs.writeFileSync(path.join(ws, 'v.mp4'), 'video');
    const bot = { id: 'cr68', name: 'TikTok运营', role: '发视频', persona: 'WHO:cr68', tools: ['fs_write', 'browser_open', 'browser_upload', 'browser_click'], skills: [], policy: {} };
    const page = { url: '' };
    const ran = [];
    const fake = {
      browser_open: async (a) => { page.url = a.url; return { ok: true, url: a.url, title: 'Studio' }; },
      browser_upload: async (a) => { ran.push(['upload', page.url]); return { ok: true, uploaded: 1, files: a.paths.map((p) => p.split('/').pop()) }; },
      browser_click: async (a) => { ran.push(['click', a.text]); if (a.text === '预约发布') page.url = TT_LIST; return { ok: true, clicked: { tag: 'button', name: a.text }, url: page.url }; },
    };
    const calls = [];
    const say = (content) => ({ content, toolCalls: [] });
    const call = (name, args) => ({ content: '', toolCalls: [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });
    const model = {
      provider: 'fake', model: 'fake',
      complete: async (messages) => {
        const last = String(messages[messages.length - 1]?.content || '');
        const all = messages.map((m) => String(m.content || '')).join('\n');
        const round2 = /第 1 次自动接着做/.test(all);
        calls.push({ round2, last });
        const mine = messages.filter((m) => m.role === 'tool').length;
        if (!round2) {
          // Round 1: TikTok, then busy work until the step limit.
          if (mine === 0) return call('browser_open', { url: TT_UP });
          if (mine === 1) return call('browser_upload', { paths: ['v.mp4'] });
          if (mine === 2) return call('browser_click', { text: '预约发布' });
          return call('fs_write', { path: `cr68/n-${mine}.txt`, content: 'x' });
        }
        // Round 2, as on 11-24: back to the upload page, the same video again.
        if (/ALREADY_SENT/.test(last)) return say('TikTok 那条已经排好了（11/25 18:00），没有再传。');
        if (!/tiktokstudio\/upload/.test(page.url)) return call('browser_open', { url: TT_UP });
        return call('browser_upload', { paths: ['v.mp4'] });
      },
    };
    let rtRef = null;
    const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
    const realGet = registry.get.bind(registry);
    registry.get = (name) => {
      const t = realGet(name);
      return fake[name] && t ? { ...t, run: fake[name] } : t;
    };
    const ev = [];
    const records = [];
    const rt = new AgentRuntime({
      config: { workspaceDir: ws, policy: {} }, registry, model,
      bots: { getBot: async (id) => (id === bot.id ? bot : null), listBots: async () => [bot] },
      memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
      approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request() { const p = Promise.resolve({ decision: 'approved', approval: { id: 'ap' } }); p.record = { id: 'ap' }; return p; } },
      bus: { emit: (e) => ev.push(e) },
    });
    rtRef = rt;
    rt.record = async (botId, rec) => { records.push({ botId, ...rec }); };
    rt.taskDelayMs = 20;
    const first = await rt.runTurn({ botId: bot.id, text: '可以排', source: 'chat' });
    const end = Date.now() + 15000;
    while (Date.now() < end && !records.some((r) => r.kind === 'assistant' && /没有再传/.test(r.text || ''))) await new Promise((r) => setTimeout(r, 50));
    const handed = calls.find((c) => c.round2)?.last || '';
    const uploads = ran.filter((r) => r[0] === 'upload').length;
    const stopped = records.find((r) => r.kind === 'tool' && r.name === 'browser_upload' && r.output?.error?.code === 'ALREADY_SENT');
    check('CR68-5 the 11-24 run end to end: round 1 uploads and clicks 「预约发布」, runs out of steps; round 2 is told so (★ lines), and its upload of the same video to TikTok is not run - the video went up once',
      first.status === 'max_steps' && /★ 在 www\.tiktok\.com\/tiktokstudio\/upload 上传了 v\.mp4/.test(handed) && /★ 在 www\.tiktok\.com\/tiktokstudio\/upload 点了「预约发布」/.test(handed)
      && uploads === 1 && Boolean(stopped) && records.some((r) => r.kind === 'assistant' && /没有再传/.test(r.text || '')),
      JSON.stringify({ status: first.status, uploads, stopped: Boolean(stopped), handed: handed.slice(0, 200) }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// 1.5.68: the human's 「发」 in the chat is the answer for publishing that work.
//   11-24, 发布 on the cloud: asked 「需要你拍板」, the human said 「发」; tapping 小红书's 「发布」 (the button that
//   opens a new note) still brought a card, 「风险高 · 在你的手机上做一步」. Now a publish or send tap on the phone in
//   the chain the human's 「发」 started runs unasked; paying, deleting and agreeing still ask, and a later chain asks.
export async function goChecks({ check, toolsMod }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');
  const yes = ['发', '发吧', '发！', '可以发', '可以发了', '好，发吧', '可以排', '排吧', 'ok，发', '发布吧', '就这样发'];
  const no = ['发给我看看', '先别发', '不发', '发错了', '发布记录在哪', '把图发我', '发之前给我看', '可以', '好的'];
  check('GO68-1 「发」 means go only as the whole message: 发 / 发吧 / 可以发 / 好，发吧 / 可以排 are it; 发给我看看, 先别发, 发错了, a plain 可以 or 好的 are not',
    yes.every((t) => A.GO_WORDS.test(t)) && !no.some((t) => A.GO_WORDS.test(t)), JSON.stringify({ missed: yes.filter((t) => !A.GO_WORDS.test(t)), wrong: no.filter((t) => A.GO_WORDS.test(t)) }));

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-go68-'));
  try {
    const bot = { id: 'go68', name: '发布', role: '发布', persona: 'WHO:go68', tools: ['phone'], skills: [], policy: {} };
    const tapped = [];
    const phoneStub = {
      name: 'phone', risk: () => ({ risk: 'MEDIUM' }),
      escalate: async (args) => ({ risk: 'HIGH', alwaysAsk: true, app: { pkg: 'com.xingin.xhs', label: '小红书' }, phoneKind: P.phoneStepKind(args.what), reason: `在手机的「小红书」上点「${args.what}」：可能付款、发送、发布或删除，每次都先问你` }),
      run: async (args) => { tapped.push(args.what); return { ok: true }; },
    };
    const plan = { '发': ['发布', '发布', '删除'], '先看看': ['发布'] };
    const model = {
      provider: 'fake', model: 'fake',
      complete: async (messages) => {
        const human = [...messages].reverse().find((m) => m.role === 'user' && !String(m.content).startsWith('（系统'))?.content || '';
        const key = Object.keys(plan).find((k) => String(human).trim() === k) || '';
        const n = messages.filter((m) => m.role === 'tool').length;
        const steps = plan[key] || [];
        if (n < steps.length) return { content: '', toolCalls: [{ id: `c_${n}_${Math.random().toString(36).slice(2, 6)}`, name: 'phone', arguments: { action: 'tap', what: steps[n] } }] };
        return { content: '好了。', toolCalls: [] };
      },
    };
    const cards = [];
    let rtRef = null;
    const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
    const realGet = registry.get.bind(registry);
    registry.get = (name) => (name === 'phone' ? { ...(realGet(name) || {}), ...phoneStub } : realGet(name));
    const rt = new A.AgentRuntime({
      config: { workspaceDir: ws, policy: {} }, registry, model,
      bots: { getBot: async (id) => (id === bot.id ? bot : null), listBots: async () => [bot] },
      memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
      approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request(req) { cards.push(req); const p = Promise.resolve({ decision: 'approved', approval: { id: `ap${cards.length}` } }); p.record = { id: `ap${cards.length}` }; return p; } },
      bus: { emit: () => {} },
    });
    rtRef = rt;
    rt.record = async () => {};
    await rt.runTurn({ botId: bot.id, text: '发', source: 'chat' });
    const afterGo = cards.map((c) => String(c.reason || c.args?.what || ''));
    await rt.runTurn({ botId: bot.id, text: '先看看', source: 'chat' });
    const later = cards.slice(afterGo.length);
    check('GO68-2 after the human\'s 「发」, tapping 「发布」 on the phone runs with no card (twice); 「删除」 in the same work still asks; the next message (not a go) asks again for 「发布」',
      tapped.filter((t) => t === '发布').length === 3 && afterGo.length === 1 && /删除/.test(afterGo[0]) && later.length === 1 && /发布/.test(String(later[0].reason || '')),
      JSON.stringify({ tapped, afterGo, later: later.map((c) => c.reason) }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// 1.5.68: a bot's own temp files and a finished job, as on 11-24 (TikTok运营).
//   1. `cd "…\tiktok\drafts" && del /Q kz_c1_full.png … 2>nul & dir /B …` asked: the check read the names at the
//      workspace's top (no cd), took cmd's single `&`, `2>nul`, `dir` for files, and a strip made in a `for` loop
//      (`tiktok\drafts\kz_%f_strip.png`) had never been counted as its own.
//   2. After 【需要你拍板】 a finished background job started a turn, and the checklist went on by itself: the
//      human was told the same twice more, each time with the video.
export async function ownAndQuietChecks({ check, readText }) {
  const O = await import('../src/ownfiles.mjs');
  const A = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-own68-'));
  const sep = path.sep;
  try {
    const drafts = path.join(ws, 'tiktok', 'drafts');
    const mine = new Set(['tiktok/drafts/kz_c1_full.png', 'tiktok/drafts/kz_c1_strip.png', 'tiktok/drafts/kz_video-a_strip.png', 'tiktok/drafts/_clips_test.txt']);
    const owns = (r) => mine.has(r);
    const real = `cd "${drafts}" && del /Q kz_c1_full.png kz_c1_strip.png kz_video-a_strip.png _clips_test.txt 2>nul & dir /B "縁側*" "cover.png"`;
    const ok = O.ownDeleteCommand(real, { workspaceDir: ws, owns });
    const notMine = O.ownDeleteCommand(real.replace('_clips_test.txt', 'cover.png'), { workspaceDir: ws, owns });
    const cdOut = O.ownDeleteCommand(`cd "${path.dirname(ws)}" && del /Q kz_c1_full.png`, { workspaceDir: ws, owns: () => true });
    const rel = O.ownDeleteCommand(`cd tiktok${sep}drafts && del /Q kz_c1_strip.png > nul 2>&1`, { workspaceDir: ws, owns });
    const top = O.ownDeleteCommand('del /Q kz_c1_strip.png', { workspaceDir: ws, owns });
    check('OWN68-1 the 11-24 delete of its own temp files runs: the cd into its folder is followed, cmd\'s single & starts a new part, 2>nul / > nul / 2>&1 are not files; a file not its own, a cd out of the workspace or the same name at the top still ask',
      ok.ok && /dir \/B/.test(ok.rest) && !/del /.test(ok.rest) && !notMine.ok && /cover\.png/.test(notMine.reason) && !cdOut.ok && rel.ok && !top.ok
      && O.commandParts('a 2>&1 && b &>log & c').length === 3,
      JSON.stringify({ ok, notMine, cdOut, rel, top }));

    const loop = `cd "${ws}" && for %f in (video-a video-b) do @ffmpeg -i "generated${sep}%f.mp4" "tiktok${sep}drafts${sep}kz_%f_strip.png"`;
    const folders = O.foldersNamed(loop, ws);
    const named = O.pathsNamed(`cd tiktok${sep}drafts && ffmpeg -y -i a.mp4 out${sep}b.png`, ws);
    check('OWN68-2 a name built in a loop counts its folder (tiktok/drafts) as where the step works; names after a cd are read from that folder, the cd itself is not a file',
      folders.includes('tiktok/drafts') && folders.includes('generated') && named.join() === 'tiktok/drafts/a.mp4,tiktok/drafts/out/b.png', JSON.stringify({ folders, named }));

    fs.mkdirSync(drafts, { recursive: true });
    fs.writeFileSync(path.join(drafts, 'old.png'), 'was there');
    const own = O.createOwnFiles({ workspaceDir: ws });
    await own.load();
    await new Promise((r) => setTimeout(r, 250)); // the scan allows 100 ms of clock slack before the step
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(drafts, 'kz_video-a_strip.png'), 'made by the loop');
    own.after('tt', [], new Set(), since, folders);
    check('OWN68-3 a file the loop made in that folder during the step is the bot\'s own; one that was there before is not',
      own.owns('tt', 'tiktok/drafts/kz_video-a_strip.png') && !own.owns('tt', 'tiktok/drafts/old.png'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // A finished job while it waits on the human's answer: noted for the turn their answer starts, no turn now.
  const rt = Object.create(A.AgentRuntime.prototype);
  rt.active = new Map();
  rt.bus = { emit() {} };
  let started = 0;
  rt.runTurn = () => { started += 1; return Promise.resolve({}); };
  rt.tasks = new Map([['tt', { botId: 'tt', status: 'waiting', steps: [{ title: 'x', status: 'blocked' }] }]]);
  rt.pendingHuman = new Map([['tt', { kind: 'decision', text: '这版行不行', at: Date.now() }]]);
  const held = await rt.jobFinished({ botId: 'tt', createdAt: Date.now() - 60000, line: '视频生成好了：generated/v.mp4' });
  rt.pendingHuman = new Map();
  const ran = await rt.jobFinished({ botId: 'tt', createdAt: Date.now() - 60000, line: '视频生成好了：generated/w.mp4' });
  check('QUIET68-1 a background job that finishes while the bot waits on the human\'s answer is noted for the turn the answer starts - no turn now that tells the human again; without an open question it still starts one',
    held === 'noted' && ran === 'turn' && started === 1 && (rt.jobNotes?.get('tt') || []).some((l) => /v\.mp4/.test(l)), JSON.stringify({ held, ran, started }));

  const agentSrc = await readText('../src/agent.mjs');
  check('QUIET68-2 a question to the human (tell_human) parks the bot\'s checklist when the turn ends, and only the human\'s own message (chat, Feishu) counts as their answer - a finished job does not set the checklist going',
    agentSrc.includes("this.afterTaskTurn(bot.id, status, waitingFor || (live.waitingFor === 'decision' ? 'decision' : null), { fromHuman: HUMAN_SOURCES.has(source), toolsRun, redirectedAt })"));

  const css = await readText('../public/app/style.css');
  check('VID68-1 a video played in the chat fits the window: at most 70% of its height (a 9:16 clip at 520 px wide stood about 920 px tall)',
    css.includes('.att-video.playing .att-video-stage video { height: auto; max-height: min(70vh, 640px); object-fit: contain; }'));
}
