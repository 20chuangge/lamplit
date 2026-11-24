// 1.5.67: three fixes the human approved on 2026-11-24 (「按建议」), from the collaboration eval on 1.5.66.
//   G67-1 files another machine's member names come back only as the result of work (or when asked for) -
//         never for a group's introductions, and not a file it only names as context (11-24: an introduction
//         on the other machine named 口播稿.md and bank.md, and the PC copied both into from-machines/);
//   G67-2 a board item whose machine dropped mid-way is not redone by itself: 「被打断」, the coordinator asks
//         「…断开了，要我让它重做吗？」, and only the human's yes redoes it (the eval's S3-a);
//   G67-3 a connected app's tool on cards, receipts and the remembered lists by its app and title
//         (「Notion · 更新页面」), not `mcp__m2c4a5__notion-update-page`; the stored key stays the same.
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
// IDs used here start with g67 so they never clash with other scenarios.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(20);
  }
}

// A small real team: the runtime's own loop, a scripted model, the real tools.
async function teamRig({ toolsMod, groupsMod, script }) {
  const { AgentRuntime } = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g67-'));
  const bots = new Map([
    ['g67lead', { id: 'g67lead', name: '主理人', role: '协调', persona: 'WHO:lead', tools: ['fs_list', 'fs_read', 'bot_message'], skills: [], policy: {} }],
    ['g67pub', { id: 'g67pub', name: '发布', role: '发布', persona: 'WHO:pub', tools: ['fs_list', 'fs_write'], skills: [], policy: {} }],
  ]);
  const group = { id: `g67g_${Math.random().toString(36).slice(2, 8)}`, name: 'g67 内容组', coordinatorId: 'g67lead', members: [...bots.values()].map(({ id, name, role, tools }) => ({ id, name, role, tools })) };
  const ev = [];
  const calls = [];
  const cards = [];
  const model = {
    provider: 'fake', model: 'fake',
    complete: async (messages) => {
      const sys = String(messages[0]?.content || '');
      const who = /WHO:(\w+)/.exec(sys)?.[1] || '?';
      const last = String(messages[messages.length - 1]?.content || '');
      const all = messages.map((m) => String(m.content || '')).join('\n');
      calls.push({ who, last, all, at: Date.now() });
      return script({ who, last, all, messages });
    },
  };
  const approvals = {
    cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [],
    request(req) {
      cards.push(req);
      const p = Promise.resolve({ decision: 'approved', approval: { id: `ap_${cards.length}` } });
      p.record = { id: `ap_${cards.length}` };
      return p;
    },
  };
  let rtRef = null;
  const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
  const rt = new AgentRuntime({
    config: { workspaceDir: ws, policy: {} }, registry, model,
    bots: { getBot: async (id) => bots.get(id) || [...bots.values()].find((b) => b.name === id) || null, listBots: async () => [...bots.values()] },
    groups: groupsMod, memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
    approvals, bus: { emit: (e) => ev.push({ ...e, at: Date.now() }) },
  });
  rtRef = rt;
  rt.record = async () => {};
  rt.gatherMs = 0;
  rt.ackMs = 100;
  rt.taskDelayMs = 50;
  rt.groupForRun = async (id) => (id === group.id ? { group } : null);
  rt.groups = { ...groupsMod, listGroups: async () => [{ id: group.id, name: group.name, coordinatorId: group.coordinatorId, members: group.members.map((m) => m.id) }] };
  const done = () => fs.rmSync(ws, { recursive: true, force: true });
  return { rt, ev, calls, cards, group, ws, bots, registry, done };
}

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = `c_${Math.random().toString(36).slice(2, 8)}`) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });

/**
 * Another machine, faked: one turn per POST; `turn(n)` gives that turn's messages (or throws: out of reach).
 * Its workspace: `files` {path: mtimeMs}; `stat` false = an older machine that gives no times.
 */
function fakePeer({ turn, files = {}, stat = true, started = Date.now() }) {
  const log = { posts: [], stats: [], gets: [] };
  let n = 0;
  const peers = {
    find: () => ({ name: '另一台' }),
    json: async (_peer, method, p, opts = {}) => {
      if (method === 'POST') { log.posts.push(opts.body); n += 1; return { turnId: `turn_g67far_${n}` }; }
      if (p.startsWith('/api/workspace/stat')) {
        const rel = decodeURIComponent(p.split('path=')[1] || '');
        log.stats.push(rel);
        return stat ? (rel in files ? { exists: true, size: 1, mtimeMs: files[rel] } : { exists: false }) : (rel in files ? { exists: true, size: 1 } : { exists: false });
      }
      return turn(n, `turn_g67far_${n}`, stat ? new Date(started).toISOString() : null);
    },
    call: async (_peer, _method, p) => {
      const rel = decodeURIComponent(p.split('path=')[1] || '');
      log.gets.push(rel);
      return rel in files ? { ok: true, arrayBuffer: async () => new TextEncoder().encode(`内容 ${rel}`).buffer } : { ok: false };
    },
  };
  return { peers, log };
}

// ---------------------------------------------------------------------------
// G67-1: files from another machine come back only as the result of work
// ---------------------------------------------------------------------------
export async function fetchChecks({ check, toolsMod, groupsMod, readText }) {
  const { askPeerBot, asksForFiles } = await import('../src/crossmachine.mjs');
  const now = Date.now();
  const files = { 'scripts/2026-11-24-三期口播稿.md': now - 86400000, 'topics/bank.md': now - 3600000, '交付/选题.md': now + 5000 };
  const reply = '我是选题，负责出视频选题。之前的口播稿在 scripts/2026-11-24-三期口播稿.md，选题库在 topics/bank.md。';
  const workReply = '三个选题写好了：交付/选题.md，参考了 topics/bank.md。';
  const msgs = (text, extra = {}) => (_n, id, startedAt) => [{ turnId: id, role: 'assistant', text }, { turnId: id, role: 'status', status: 'success', ...(startedAt ? { startedAt } : {}), ...extra }];

  // 1. A group's introductions: nothing comes back, nothing is even looked up.
  {
    const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
    const far = { id: 'g67far', name: '选题', role: '选题', remote: { machine: '另一台', botId: 'bot-far' } };
    const group = { ...r.group, members: [...r.group.members, far] };
    const peer = fakePeer({ turn: msgs(reply), files, started: now });
    r.rt.getPeers = () => peer.peers;
    const res = await r.rt.runRemoteGroupTurn({ group, member: far, text: '（这个群刚建好）请用一两句话向大家介绍：你在这个群里负责什么。', role: 'speaker', kickoff: true });
    const copied = fs.existsSync(path.join(r.ws, 'from-machines'));
    const said = (await groupsMod.readGroupMessages(group.id, { limit: 50 })).find((m) => m.from === 'g67far');
    check('G67-1a a member on another machine introducing itself in a new group names two files there: neither is looked up or copied to this machine, and its line in the group says nothing was fetched',
      res.status === 'success' && peer.log.gets.length === 0 && peer.log.stats.length === 0 && !copied && !/已经取回/.test(said?.text || ''),
      JSON.stringify({ gets: peer.log.gets, stats: peer.log.stats, copied, said: said?.text }));
    r.done();
  }

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-g67f-'));
  try {
    // 2. Work: what this turn made comes back; a file it names as context (made before the turn) stays there.
    const work = fakePeer({ turn: msgs(workReply), files, started: now });
    const got = await askPeerBot(work.peers, { name: '另一台' }, { botId: 'bot-far', text: '（任务板）出三个选题', askedText: '出三个选题', workspaceDir: ws, pollMs: 5 });
    check('G67-1b work handed to it: the file its turn made (交付/选题.md) comes back; topics/bank.md, named as what it read and older than the turn, stays on that machine',
      got.fetched.map((f) => f.from).join() === '交付/选题.md' && !work.log.gets.includes('topics/bank.md'),
      JSON.stringify({ fetched: got.fetched, gets: work.log.gets }));

    // 3. Asked for: the human wants that file - it comes back though it is older.
    const asked = fakePeer({ turn: msgs('选题库在 topics/bank.md，发过来了。'), files, started: now });
    const got2 = await askPeerBot(asked.peers, { name: '另一台' }, { botId: 'bot-far', text: '把选题库发我', workspaceDir: ws, pollMs: 5 });
    const named = fakePeer({ turn: msgs('看了 topics/bank.md，里面有 40 个。'), files, started: now });
    const got3 = await askPeerBot(named.peers, { name: '另一台' }, { botId: 'bot-far', text: 'topics/bank.md 里有几个选题？', workspaceDir: ws, pollMs: 5 });
    check('G67-1c a file the human asked for (「把选题库发我」) or named in the request comes back although it was there before the turn',
      got2.fetched.map((f) => f.from).join() === 'topics/bank.md' && got3.fetched.map((f) => f.from).join() === 'topics/bank.md'
      && asksForFiles('把选题库发我') && asksForFiles('send me the report') && !asksForFiles('出三个选题') && !asksForFiles('大家好，介绍一下自己'),
      JSON.stringify({ asked: got2.fetched, named: got3.fetched }));

    // 4. A machine on an older Lamplit (no times): as before, what the answer names comes back.
    const old = fakePeer({ turn: msgs(workReply), files, stat: false, started: now });
    const got4 = await askPeerBot(old.peers, { name: '另一台' }, { botId: 'bot-far', text: '出三个选题', workspaceDir: ws, pollMs: 5 });
    check('G67-1d a machine on an older Lamplit (its turn says no start time, its files no times) keeps the old way: what the answer names comes back',
      got4.fetched.map((f) => f.from).sort().join() === ['topics/bank.md', '交付/选题.md'].sort().join(), JSON.stringify(got4.fetched));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }

  const [server, agent] = await Promise.all([readText('../src/server.mjs'), readText('../src/agent.mjs')]);
  check('G67-1e this machine tells others what they need: a file\'s change time (workspace stat) and a turn\'s start (its status line); a group\'s introductions ask for nothing back',
    server.includes('{ exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs) }') && server.includes('...(record.startedAt ? { startedAt: record.startedAt } : {})')
    && agent.includes('...(kickoff ? { bring: false } : {}),') && agent.includes('askedText: String(text || \'\'),'));
}

// ---------------------------------------------------------------------------
// G67-2: an item cut off by a dropped machine waits for the human's yes
// ---------------------------------------------------------------------------
export async function cutOffChecks({ check, toolsMod, groupsMod, readText }) {
  const A = await import('../src/agent.mjs');
  /** A board with one item for 选题 on the other machine; its first turn there is cut off by a restart. */
  const boardRig = async ({ afterCut }) => {
    const r = await teamRig({ toolsMod, groupsMod, script: ({ who, last }) => (who === 'lead' && /任务板做完了/.test(last) ? say('选题都好了。') : say('好。')) });
    const far = { id: 'g67far', name: '选题', role: '选题', remote: { machine: '另一台', botId: 'bot-far' } };
    const group = { ...r.group, members: [...r.group.members, far] };
    let polls = 0;
    const peer = fakePeer({
      started: Date.now(),
      turn: (n, id, startedAt) => {
        if (n === 1) {
          polls += 1;
          if (polls <= 2) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'PEER_DOWN' });
          return [{ turnId: id, role: 'assistant', text: '应用重启时这一轮被打断了，没有做完，也不会自动重做。' }, { turnId: id, role: 'status', status: 'needs_attention', recovered: true, startedAt }];
        }
        return afterCut(id, startedAt);
      },
    });
    r.rt.getPeers = () => peer.peers;
    const now = new Date().toISOString();
    const plan = { id: `plan_g67_${Math.random().toString(36).slice(2, 8)}`, groupId: group.id, request: '出三个选题', coordinatorId: 'g67lead', status: 'running', createdAt: now, updatedAt: now,
      tasks: [{ id: 't1', title: '出三个选题', owner: 'g67far', brief: '', deliverable: '', needs: [], status: 'todo', question: '', answer: '', result: '' }] };
    await r.rt.boardChanged(plan);
    await r.rt.runPlan(group, plan);
    return { r, group, plan, peer };
  };

  // 1. Cut off: 被打断, the coordinator asks, nothing is redone; a reply that is not yes/no does not answer it.
  {
    const { r, group, plan, peer } = await boardRig({ afterCut: (id, startedAt) => [{ turnId: id, role: 'assistant', text: '三个选题写好了。' }, { turnId: id, role: 'status', status: 'success', startedAt }] });
    const row = plan.tasks[0];
    const before = { status: plan.status, row: row.status, cut: row.cut?.machine, q: row.question, result: row.result, posts: peer.log.posts.length };
    const asked = (await groupsMod.readGroupMessages(group.id, { limit: 50 })).filter((m) => m.from === 'g67lead' && /断开了，要我让它重做吗/.test(m.text || ''));
    const notice = r.ev.find((e) => e.type === 'human.notice' && /断开了/.test(e.text || ''));
    check('G67-2a a board item whose machine dropped while it worked (that machine restarted) is not redone by itself: it is 被打断 with the reason, the coordinator asks in the group 「「选题」在做「出三个选题」的时候和「另一台」断开了，要我让它重做吗？」, and the phone is told',
      before.status === 'waiting' && before.row === 'waiting_human' && before.cut === '另一台' && /「选题」在做的时候和「另一台」断开了，要我让它重做吗？/.test(before.q)
      && /连接断了/.test(before.result) && before.posts === 1 && asked.length === 1 && /「选题」在做「出三个选题」的时候和「另一台」断开了/.test(asked[0].text) && Boolean(notice),
      JSON.stringify({ before, asked: asked.map((m) => m.text), notice: Boolean(notice) }));
    const other = await r.rt.answerBoard(group, '乙站今天别发');
    check('G67-2b a word in the group that is not a yes or no (「乙站今天别发」) does not answer it: the item keeps waiting and nothing is redone',
      other === false && plan.tasks[0].status === 'waiting_human' && peer.log.posts.length === 1, JSON.stringify({ other, row: plan.tasks[0].status, posts: peer.log.posts.length }));
    const took = await r.rt.answerBoard(group, '重做');
    await until(() => r.rt.plans.get(group.id)?.status === 'done', 12000);
    const again = peer.log.posts[1];
    check('G67-2c the human\'s 「重做」 redoes it: the member there is told it was cut off and to go on from what is written (not as an answer to a question of its own), and the board ends done',
      took === true && peer.log.posts.length === 2 && /用户让你重做/.test(again?.text || '') && !/你之前问过用户/.test(again?.text || '') && again?.handoff?.answered !== true
      && r.rt.plans.get(group.id)?.status === 'done' && r.rt.plans.get(group.id)?.tasks?.[0]?.status === 'done' && !r.rt.plans.get(group.id)?.tasks?.[0]?.cut,
      JSON.stringify({ took, posts: peer.log.posts.length, text: String(again?.text || '').slice(0, 80), status: r.rt.plans.get(group.id)?.status }));
    r.done();
  }

  // 2. 「不用了」: skipped, nothing redone, the board goes on to its end.
  {
    const { r, group, plan, peer } = await boardRig({ afterCut: () => { throw new Error('must not run again'); } });
    const took = await r.rt.answerBoard(group, '不用了');
    await until(() => r.rt.plans.get(group.id)?.status === 'done', 6000);
    check('G67-2d the human\'s 「不用了」: the item is skipped (你说不用重做), nothing is redone, and the board goes on to its end',
      took === true && plan.tasks[0].status === 'skipped' && /你说不用重做/.test(plan.tasks[0].result) && peer.log.posts.length === 1 && r.rt.plans.get(group.id)?.status === 'done',
      JSON.stringify({ took, row: plan.tasks[0].status, result: plan.tasks[0].result, posts: peer.log.posts.length, status: r.rt.plans.get(group.id)?.status }));
    r.done();
  }

  // 3. Out of reach to the end, and what counts as a yes or a no.
  {
    const { askPeerBot } = await import('../src/crossmachine.mjs');
    const gone = fakePeer({ turn: () => { throw new Error('connect ECONNREFUSED'); } });
    const err = await askPeerBot(gone.peers, { name: '另一台' }, { botId: 'bot-far', text: '出三个选题', pollMs: 5, timeoutMs: 60 }).catch((e) => e);
    const blip = fakePeer({ turn: (() => { let k = 0; return (_n, id) => { k += 1; if (k === 1) throw new Error('timeout'); return [{ turnId: id, role: 'assistant', text: '没做成：网站打不开。' }, { turnId: id, role: 'status', status: 'failed' }]; }; })() });
    const failed = await askPeerBot(blip.peers, { name: '另一台' }, { botId: 'bot-far', text: '出三个选题', pollMs: 5 });
    const yes = ['重做', '好的，重做吧', '嗯', '可以', 'ok'].map((t) => A.redoAnswer(t));
    const no = ['不用了', '先别', '算了吧', '不要重做了'].map((t) => A.redoAnswer(t));
    const neither = ['乙站今天别发', '要不要先看看？', '它做到哪了'].map((t) => A.redoAnswer(t));
    check('G67-2e a machine that never comes back within the wait is cut off too (not 没做成 at the work); a turn that failed there on its own after a short blip is not; 「重做」「嗯」 are yes, 「不用了」「先别」 no, a question or anything else neither',
      err?.code === 'PEER_TIMEOUT' && err.lost === true && !failed.interrupted && failed.status === 'failed'
      && yes.every((x) => x === 'yes') && no.every((x) => x === 'no') && neither.every((x) => x === ''),
      JSON.stringify({ err: err?.code, lost: err?.lost, blip: failed.interrupted, yes, no, neither }));
  }

  const [page, en] = await Promise.all([readText('../public/app/main/03-groups.js'), readText('../public/i18n-en.js')]);
  check('G67-2f the board shows such an item as 「被打断」 (with the question and the reason under it), in English too',
    page.includes("t.cut && t.status === 'waiting_human' ? '被打断'") && en.includes('"被打断": "Cut off"'));
}

// ---------------------------------------------------------------------------
// G67-3: a connected app's tool by its app and title
// ---------------------------------------------------------------------------
/** Top-level page functions by name, as source. */
function pageFn(src, name) {
  const m = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\r?\\n`).exec(src);
  return m ? m[0] : '';
}

export async function mcpNameChecks({ check, toolsMod, groupsMod, readText }) {
  const M = await import('../src/mcp.mjs');
  check('G67-3a a connected app\'s tool reads 「Notion · 更新页面」 with its own title (title, or annotations.title), else 「Notion · notion update page」 - never mcp__…',
    M.mcpToolLabel({ server: 'Notion', tool: 'notion-update-page', title: '更新页面' }) === 'Notion · 更新页面'
    && M.mcpToolLabel({ server: 'Notion', tool: 'notion-update-page' }) === 'Notion · notion update page'
    && M.mcpToolLabel({ server: 'GitHub', tool: 'createIssue' }) === 'GitHub · create Issue'
    && M.mcpToolTitle({ annotations: { title: '更新页面' } }) === '更新页面' && M.mcpToolTitle({ title: ' 建议 ' }) === '建议' && M.mcpToolTitle({}) === '');

  // On a card: what it asks and what 「以后都允许」 covers; the key stays the tool's name.
  {
    const NAME = 'mcp__m2c4a5__notion-update-page';
    const r = await teamRig({ toolsMod, groupsMod, script: ({ who, messages }) => (who === 'pub' && !messages.some((m) => m.role === 'tool') ? call(NAME, { page: 'p1' }) : say('好了。')) });
    r.registry.tools.set(NAME, { name: NAME, description: '［Notion］更新页面', risk: () => ({ risk: 'LOW' }), parameters: { type: 'object', properties: { page: { type: 'string' } } },
      mcp: { serverId: 'm2c4a5', server: 'Notion', tool: 'notion-update-page', title: '更新页面', readOnly: false }, run: async () => ({ ok: true }) });
    r.registry.mcpGate = () => true;
    r.registry.mcpTrust = () => ({ server: 'Notion', tool: 'notion-update-page', trust: 'ask', readOnly: false });
    await r.rt.runTurn({ botId: 'g67pub', text: '更新那一页', source: 'chat' });
    const card = r.cards[0];
    check('G67-3b the card for a connected app\'s tool says 用「Notion · 更新页面」 and 「以后都允许」 covers 用「Notion · 更新页面」 - no mcp__ id; the rule\'s key is still the tool\'s name, so rules saved before keep working',
      Boolean(card) && /用「Notion · 更新页面」/.test(card.reason || '') && !/mcp__/.test(card.reason || '')
      && card.remember?.key === NAME && card.remember?.label === '用「Notion · 更新页面」',
      JSON.stringify({ reason: card?.reason, remember: card?.remember }));
    r.done();
  }

  // The page: the card's heading, a rule saved before (its label was the raw name), and the lists.
  {
    const [chat, cards, bots, live, en, mcp] = await Promise.all(['../public/app/main/05-chat.js', '../public/app/main/07b-cards.js', '../public/app/main/04-bots.js', '../public/app/main/06-live.js', '../public/i18n-en.js', '../src/mcp.mjs'].map((f) => readText(f)));
    const src = ['mcpToolHuman', 'mcpToolText'].map((n) => pageFn(chat, n)).join('\n') + ['rememberWords', 'rememberedLabel'].map((n) => pageFn(cards, n)).join('\n');
    // eslint-disable-next-line no-new-func
    const make = new Function('mcpUi', 'commandWords', 'cardFileName', `${src}\nreturn { mcpToolHuman, mcpToolText, rememberWords, rememberedLabel };`);
    const ui = { servers: [{ id: 'm2c4a5', name: 'Notion', tools: [{ name: 'notion-update-page', title: '更新页面' }] }] };
    const P = make(ui, () => ({ kind: 'run' }), (x) => x);
    const bare = make({ servers: [] }, () => ({ kind: 'run' }), (x) => x);
    const NAME = 'mcp__m2c4a5__notion-update-page';
    const heading = P.mcpToolText(NAME);
    const old = P.rememberWords({ key: NAME, label: NAME });
    const fresh = bare.rememberWords({ key: NAME, label: '用「Notion · 更新页面」' });
    check('G67-3c on the page: the card says 「Notion · 更新页面」 (想用「Notion」：更新页面); a rule saved before with the raw name as its label now reads 用「Notion · 更新页面」; another machine\'s app this page does not know still reads without mcp__; shell and file rules keep their own words',
      heading?.label === '「Notion · 更新页面」' && heading.title === '想用「Notion」：更新页面' && old === '用「Notion · 更新页面」' && fresh === '用「Notion · 更新页面」'
      && bare.mcpToolText(NAME)?.label === '「连接的应用 · notion update page」' && !/mcp__/.test(bare.rememberWords({ key: NAME, label: NAME }))
      && P.rememberedLabel({ key: 'shell:git', label: '用 git 运行命令' }) === '用 git 运行命令' && P.rememberedLabel({ key: NAME, label: NAME }) === '用「Notion · 更新页面」',
      JSON.stringify({ heading, old, fresh, bare: bare.rememberWords({ key: NAME, label: NAME }) }));
    // The toast after 「以后都允许」 says the hub's own label of the rule just made - the new words (G67-3b).
    check('G67-3d every place a remembered rule shows uses those words: the card\'s 「以后都允许」 line and receipt, its toast (the hub\'s label), the assistant\'s 已记住的权限 and 设置 → 审批; the page gets the tools\' titles from the app; new words are in English too',
      (bots.match(/rememberedLine\(bot, rememberedLabel\(item\), \{ key: item\.key \}/g) || []).length === 2 && live.includes('toast(`好的，以后${res.remembered.label}都不再问你')
      && live.includes('rememberWords(data.remember)') && cards.includes('const label = rememberWords(remember);')
      && mcp.includes('tools: (l?.tools || []).map((t) => ({ name: t.name, ...(mcpToolTitle(t) ? { title: mcpToolTitle(t) } : {})')
      && en.includes('"想用「{0}」：{1}"') && en.includes('"用「{0}」"') && en.includes('"「{0}」"'));
  }
}
