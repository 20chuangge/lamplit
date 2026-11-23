// 1.5.58: redesign step 3 - cards you answer. Plain headlines, a risk tag, up to three lines of
// what will happen, buttons that say where things go, honest receipts with 撤销 only where an undo
// exists, next steps after a reply, replies together, Enter / Esc on the focused card.
// Display only: the first two checks pin that the approval decisions did not move.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// The fixed set of tool calls and what the hub said about them at 89f8d71 (1.5.57, before the redesign).
const VERDICT_CASES = {
  classify: [
    ['shell', { command: 'ls -la' }, { baseRisk: 'MEDIUM' }],
    ['shell', { command: 'rm -rf /' }, { baseRisk: 'MEDIUM' }],
    ['shell', { command: 'rm -rf /' }, { baseRisk: 'MEDIUM', autoApproveAll: true }],
    ['shell', { command: 'Format-Volume -DriveLetter D' }, { baseRisk: 'MEDIUM', autoApproveMedium: true }],
    ['shell', { command: 'git status' }, { baseRisk: 'MEDIUM', autoApproveMedium: true }],
    ['shell', { command: 'Move-Item .\\下载\\*.msi .\\旧安装包\\' }, { baseRisk: 'MEDIUM' }],
    ['fs_delete', { path: '旧报告.docx' }, { baseRisk: 'MEDIUM' }],
    ['fs_delete', { path: 'C:/Windows/x' }, { baseRisk: 'HIGH' }],
    ['fs_delete', { path: 'C:/Windows/x' }, { baseRisk: 'HIGH', autoApproveAll: true }],
    ['fs_write', { path: 'a.md', content: 'x' }, { baseRisk: 'LOW' }],
    ['post_draft', { channel: '小红书', body: 'x' }, { baseRisk: 'HIGH' }],
    ['x_post', { text: 'x' }, { baseRisk: 'HIGH', autoApproveMedium: true }],
    ['machine_switch', { machine: '腾讯云', task: 'x' }, { baseRisk: 'MEDIUM' }],
    ['bot_adjust', { bot: '策略', addRules: ['x'] }, { baseRisk: 'MEDIUM', autoApproveMedium: true }],
    ['shell', { command: 'ls' }, { baseRisk: 'MEDIUM', granted: false }],
    ['image_generate', { prompt: 'x' }, { baseRisk: 'MEDIUM' }],
  ],
  medium: [
    { careful: true, autonomous: true, trusted: true, toolName: 'shell', args: { command: 'ls' } },
    { careful: false, autonomous: true, trusted: false, toolName: 'shell', args: { command: 'rm x' } },
    { careful: false, autonomous: false, trusted: false, toolName: 'fs_delete', args: { path: 'x' } },
    { careful: false, autonomous: false, trusted: true, toolName: 'shell', args: { command: 'ls -la' } },
    { careful: false, autonomous: false, trusted: true, toolName: 'shell', args: { command: 'rm x' } },
    { careful: false, autonomous: false, trusted: true, toolName: 'fs_delete', args: { path: 'x' } },
  ],
  remember: [
    ['shell', { command: 'cd x && python3 run.py' }],
    ['shell', { command: 'git status && node x.js | grep a' }],
    ['shell', { command: 'Move-Item a b' }],
    ['fs_delete', { path: 'sub/旧报告.docx' }],
    ['post_draft', { channel: '小红书', body: 'x' }],
    ['shell', { command: '' }],
  ],
  authority: [
    ['POST', '/api/approvals/abc'], ['POST', '/api/inbox/m/abc'], ['PATCH', '/api/bots/chief'], ['GET', '/api/health'],
    ['GET', '/api/auth'], ['POST', '/api/pair'], ['GET', '/api/approvals'], ['POST', '/api/adjustments/x/undo'],
  ],
  boundary: [
    ['fs_delete', { path: '旧报告.docx' }, { policy: {} }],
    ['fs_delete', { path: '../outside.txt' }, { policy: {} }],
    ['fs_delete', { path: '../outside.txt' }, { policy: { outside: 'deny' } }],
    ['shell', { command: 'sudo rm x' }, { policy: {} }],
    ['shell', { command: 'ls' }, { policy: {} }],
    ['fs_write', { path: '../x.txt', content: 'y' }, { policy: {}, autonomous: true, remote: true }],
  ],
  levels: [{}, { level: 'careful' }, { level: 'auto' }, { autoApproveAll: true }, { level: 'nonsense' }],
};
const VERDICTS_1557 = {"classify":[{"risk":"MEDIUM","decision":"ask","reason":"medium-risk tool"},
  {"risk":"HIGH","decision":"ask","reason":"command matches danger denylist (rm\\s+-rf, \\brm\\s+(?:-{1,2}[a-z-]+\\s+)*-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive)\\b)"},
  {"risk":"HIGH","decision":"ask","reason":"command matches danger denylist (rm\\s+-rf, \\brm\\s+(?:-{1,2}[a-z-]+\\s+)*-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive)\\b)"},
  {"risk":"MEDIUM","decision":"auto","reason":"medium-risk tool; auto-approved by policy"},
  {"risk":"MEDIUM","decision":"auto","reason":"medium-risk tool; auto-approved by policy"},
  {"risk":"MEDIUM","decision":"ask","reason":"medium-risk tool"},
  {"risk":"MEDIUM","decision":"ask","reason":"medium-risk tool"},
  {"risk":"HIGH","decision":"ask","reason":"high-risk tool"},
  {"risk":"HIGH","decision":"auto","reason":"high-risk tool; auto-approved (autonomous mode)"},
  {"risk":"LOW","decision":"auto","reason":"low-risk tool"},
  {"risk":"HIGH","decision":"ask","reason":"high-risk tool"},
  {"risk":"HIGH","decision":"ask","reason":"high-risk tool"},
  {"risk":"MEDIUM","decision":"ask","reason":"medium-risk tool"},
  {"risk":"MEDIUM","decision":"auto","reason":"medium-risk tool; auto-approved by policy"},
  {"risk":"HIGH","decision":"deny","reason":"shell is not granted to this bot"},
  {"risk":"MEDIUM","decision":"ask","reason":"medium-risk tool"}],"medium":[false,true,false,true,false,true],"remember":[{"key":"shell:python3","label":"用 python3 运行命令","runsCode":true},
  {"key":"shell:git","label":"用 git 运行命令","also":["shell:node"]},
  {"key":"shell:move-item","label":"用 move-item 运行命令"},
  {"key":"fs_delete:<ws>/sub","label":"在 <ws>/sub 里删文件"},
  {"key":"post_draft","label":"post_draft"},null],"authority":[true,true,true,false,false,false,true,true],"boundary":[null,{"decision":"ask","code":"FOLDER_NOT_OPEN"},
  {"decision":"deny","code":"FOLDER_NOT_OPEN"},
  {"decision":"ask","code":"SUDO_ASKS"},null,null],"levels":[{"level":"standard","autonomous":false,"careful":false,"builtin":29},
  {"level":"careful","autonomous":false,"careful":true,"builtin":29},
  {"level":"auto","autonomous":true,"careful":false,"builtin":29},
  {"level":"auto","autonomous":true,"careful":false,"builtin":29},
  {"level":"standard","autonomous":false,"careful":false,"builtin":29}],"defaultDeny":29};

/** Every verdict for the fixed set, from the hub's own functions (paths and the folder taken out). */
async function verdicts() {
  const A = await import('../src/approvals.mjs');
  const Au = await import('../src/auth.mjs');
  const B = await import('../src/boundary.mjs');
  const ws = process.platform === 'win32' ? 'C:\\lamplit-verdict-ws' : '/tmp/lamplit-verdict-ws';
  const C = VERDICT_CASES;
  return {
    classify: C.classify.map(([n, a, p]) => A.classify(n, a, p)),
    medium: C.medium.map((x) => A.mediumRunsUnasked(x)),
    remember: C.remember.map(([n, a]) => {
      const k = A.permissionKey(n, a, { workspaceDir: ws });
      const plain = (s) => String(s).replace(ws.toLowerCase(), '<ws>').replace(ws, '<ws>').replace(/\\/g, '/');
      return k && { ...k, key: plain(k.key), label: plain(k.label) };
    }),
    authority: C.authority.map(([m, p]) => Au.isAuthorityRequest(m, p)),
    boundary: C.boundary.map(([n, a, o]) => { const r = B.checkBoundary(n, a, { workspaceDir: ws, ...o }); return r ? { decision: r.decision, code: r.code || null } : null; }),
    levels: C.levels.map((p) => { const e = A.effectivePolicy(p); return { level: e.level, autonomous: e.autonomous, careful: e.careful, builtin: e.builtinDeny.length }; }),
    defaultDeny: A.DEFAULT_DENY_PATTERNS.length,
  };
}

export async function cards1558Checks({ check, readText }) {
  const page = await readText('../public/index.html');
  const cards = await readText('../public/app/main/07b-cards.js');

  // --- the decisions did not move -------------------------------------
  const now = await verdicts();
  const diff = Object.keys(VERDICTS_1557).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(VERDICTS_1557[k]));
  check('C1 approval decisions unchanged: for a fixed set of tool calls, classify (risk, ask/auto/deny, reason), mediumRunsUnasked, 以后都允许\'s permission keys, isAuthorityRequest, the boundary and the approval levels say exactly what they said at 1.5.57',
    diff.length === 0, diff.join(', '));
  // 1.5.65: decide() takes one more argument, chain (「这一轮都允许」), sent as { chain: true } - the only change.
  const pinned = { decide: '68353dc3bdde41a2', decideParked: '223fb42b0ce5e7d4', approvalPath: '72643c97d35aa25d', dropAnswered: 'cc22422bad437ca2' };
  const moved = Object.entries(pinned).filter(([n, h]) => sha(fnSource(page, n)) !== h).map(([n]) => n);
  check('C2 the page sends the same answers: decide, decideParked, approvalPath and dropAnswered are byte for byte as at 1.5.57, and the card\'s three buttons call decide with the same arguments',
    moved.length === 0
    && page.includes("decide(data.approvalId, 'approve', note.value, card, allow, reject, null, data.draft ? draftEdits(card, data) : null)")
    && page.includes("decide(data.approvalId, 'approve', note.value, card, allow, reject, data.remember);")
    && page.includes("reject.addEventListener('click', () => decide(data.approvalId, 'deny', note.value, card, allow, reject));"), moved.join(', '));

  // --- the words, from fixed templates ---------------------------------
  const C = new Function('window', 'truncate', 'safeArgs', 'thinkButtons', 'el',
    `${cards}\nreturn { commandWords, cardTitle, nextStepChoices, cardKindWords, cardLines, isReplyDraft, draftYes, cardWords, draftTitle, rememberWords };`)(
    {}, (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s)),
    (a) => (a && typeof a === 'object' ? a : {}), () => null, () => null);
  const t = (cmd) => C.commandWords(cmd).title;
  check('C3 a command without a purpose gets a plain headline from its program and paths (a fixed table, no model): move, delete, a script, a look',
    t('Move-Item .\\下载\\*.msi .\\旧安装包\\') === '把「下载」里所有 .msi 文件移到「旧安装包」' && t('rm -rf build') === '删除「build」' && t('del *') === '删除这里的所有东西'
    && t('cd tools && python3 run.py --fast') === '用 python3 运行「run.py」' && C.commandWords('ls -la').kind === 'look'
    && t('frobnicate --x') === '运行一条命令（frobnicate）',
    JSON.stringify([t('Move-Item .\\下载\\*.msi .\\旧安装包\\'), t('rm -rf build'), t('cd tools && python3 run.py --fast')]));
  const info = { title: '想删除一个文件或文件夹', facts: [['文件', '旧报告.docx']], impact: '' };
  check('C3 the headline says what happens (「删除「旧报告.docx」」, not 「想删除一个文件或文件夹」); a purpose the bot wrote only names the card, the program actually run is said under it',
    C.cardTitle({ tool: 'fs_delete', args: { path: 'sub/旧报告.docx' } }, info) === '删除「旧报告.docx」'
    && C.cardTitle({ tool: 'shell', args: { command: 'rm -rf x', purpose: '清理' } }, { title: '清理', facts: [] }) === '清理'
    && C.cardLines({ tool: 'shell', args: { command: 'rm -rf x', purpose: '清理' }, risk: 'HIGH' }, { title: '清理', facts: [], impact: 'i' })[0] === '实际要做的：删除「x」');
  const lines = C.cardLines({ tool: 'fs_delete', args: { path: 'a.txt', recursive: true }, risk: 'MEDIUM' }, { facts: [], impact: '' });
  check('C4 「它会做什么」: at most three lines; a delete in the workspace says it can usually be undone for 7 days, outside it says it cannot',
    lines.length <= 3 && lines.some((l) => /7 天内一般能撤销/.test(l))
    && C.cardLines({ tool: 'fs_delete', args: { path: '/etc/x' }, risk: 'HIGH' }, { facts: [], impact: '' }).some((l) => /没法撤销/.test(l))
    && cards.includes("if (lines.length >= 2) break;") && cards.includes('return lines.slice(0, 3);'), JSON.stringify(lines));
  check('C4 the risk tag is green / amber / red for the hub\'s own LOW / MEDIUM / HIGH, with what kind of step it is',
    cards.includes("const CARD_RISK = { LOW: ['ok', '风险低'], MEDIUM: ['warn', '风险中'], HIGH: ['danger', '风险高'] };")
    && C.cardKindWords({ tool: 'shell', args: { command: 'ls' } }, true) === '只是查看' && C.cardKindWords({ tool: 'fs_delete', args: {} }, false) === '会删东西'
    && page.includes('.approval-risk.ok {') && page.includes('.approval-risk.warn {') && page.includes('.approval-risk.danger {'));
  const words = C.cardWords({ tool: 'shell' }, null);
  check('C5 buttons say where things go: 允许这一次 / 发到小红书 / 发出这封邮件 / 回复 / 交过去, and 不要 as plain text - never 确定, never a bare 发送; the command is under 技术细节',
    words.yes === '允许这一次' && words.no === '不要'
    && C.draftYes({ channel: '小红书' }) === '发到小红书' && C.draftYes({ channel: '邮件' }) === '发出这封邮件' && C.draftYes({ channel: '小红书评论 · 回复 @a' }) === '回复'
    && page.includes("if (data.handoff) return { yes: '交过去'") && !/'(确定|发送)'/.test(cards) && !page.includes("yes: '发送'")
    && page.includes("'要运行的命令'") && !page.includes("'看详情'") && page.includes('.approval-buttons .btn.approval-reject'));

  // --- receipts: what actually happened --------------------------------
  check('C6 honest receipts: a post the bot publishes afterwards reads 「已定稿：它现在…去发」, 「已经发到」 only after the step ran, a failure says 没发出去 / 没做成; never 「已发送」',
    cards.includes("const done = edited ? '已定稿（你改过）' : '已定稿';") && cards.includes('它现在照框里的字去「${draftPlace(data.draft)}」发')
    && cards.includes('已经发到「${draftPlace(data.draft)}」') && cards.includes('没发出去：${msg}') && !/['`]已发送/.test(cards)
    && page.includes("settleFromResult(ev); // an answered card says what the step did") && cards.includes("card.dataset.decision !== 'approve'"));
  check('C6 撤销 only where an undo exists: a file the step changed (its undo id, the same undo as 「改了 N 个文件」), and 「以后都允许」 (taken off the bot\'s remembered list, as in its settings)',
    cards.includes('const undo = out.undo ? fileUndoButton(out.undo, name, data.turnId) : null;') && cards.includes("api(chatUndoUrl(), { method: 'POST', body: { ids: [id] } })")
    && cards.includes('.filter((a) => a.key !== remember.key);') && cards.includes("card.dataset.always === '1' && data.remember?.key"));
  const SRV = await import('../src/server.mjs');
  const slim = SRV.compactChat([
    { role: 'approval', tool: 'shell', turnId: 't1', approvalId: 'a1' }, { role: 'tool', name: 'shell', ok: false, turnId: 't1', id: 'x', output: { error: { message: 'no such file' }, stdout: 'y'.repeat(900) } },
    { role: 'tool', name: 'shell', ok: false, turnId: 't1', id: 'y', output: { error: { message: 'not after a card' } } },
    { role: 'approval', tool: 'post_draft', turnId: 't2', approvalId: 'a2' }, { role: 'tool', name: 'post_draft', ok: true, turnId: 't2', id: 'z', output: { approved: true, body: 'b'.repeat(900) } },
  ]);
  check('C6 after a reload the receipt comes from the history: the step right after an answered card stays in the compact chat, slim (ok, or its error\'s words), other steps are still left out; else it says what you answered',
    cards.includes("if (m.role === 'tool' && m.name === data.tool) return m;") && page.includes('actions.appendChild(historyReceipt(data));')
    && slim.length === 4 && slim[1].afterCard && slim[1].ok === false && slim[1].output.error.message === 'no such file' && !slim[1].output.stdout
    && slim[3].afterCard && slim[3].ok === true && JSON.stringify(slim[3].output) === '{}' && !slim.some((m) => m.id === 'y'), JSON.stringify(slim));

  // --- next steps, replies together, keys ------------------------------
  check('C7 next steps after a reply: read off the reply (the short choices it ends with, or 好 / 先不用 for a yes-or-no question), at most 4, the first one suggested (violet border); only while nothing runs',
    JSON.stringify(C.nextStepChoices('你想怎么处理？\n1. 移到回收站\n2. 打包成一个压缩文件\n3. 先不动')) === JSON.stringify(['移到回收站', '打包成一个压缩文件', '先不动'])
    && JSON.stringify(C.nextStepChoices('要不要我早上 9 点提醒你？')) === JSON.stringify(['好', '先不用'])
    && C.nextStepChoices('好了。').length === 0 && C.nextStepChoices('选哪个？\n1. a\n2. b\n3. c\n4. d\n5. e').length === 0
    && page.includes('.next-step.first { border-color: var(--accent);') && page.includes('showNextSteps(); // under the newest reply'));
  check('C8 a group of replies: in 「等你确认」, one line each with its own 「回复」 and 「全部回复（N）」, each answered through decide like its card; the boxes can be edited in place',
    cards.includes('`全部回复（${open.length}）`') && cards.includes("return decide(row.dataset.approval, 'approve', '', row, btn, null, null, edits);")
    && C.isReplyDraft({ kind: 'reply' }) && C.isReplyDraft({ channel: '小红书评论 · 回复 @a' }) && !C.isReplyDraft({ channel: '小红书' })
    && page.includes('const group = replyGroup();'));
  // The desktop app, 11-22: a video card and its 下载 / 打开位置 row ran ~37 px past the bubble (its width came from the window, not the bubble).
  check('C11 attachment cards fit inside the reply bubble: the video is at most the bubble\'s width (not the window\'s), every card in the list may shrink, the name ellipsizes and the 下载 / 打开位置 buttons keep their size',
    page.includes('.bubble .att-video { width: min(520px, calc(100vw - 64px)); max-width: 100%; box-sizing: border-box; }')
    && page.includes('.bubble .att-list > * { min-width: 0; max-width: 100%; box-sizing: border-box; }')
    && page.includes('.bubble .att-video-bar { min-width: 0; max-width: 100%; }') && page.includes('.bubble .att-video-bar .att-act { flex: none; }')
    && /\.att-video-name \{ flex: 1; min-width: 0;[^}]*text-overflow: ellipsis; \}/.test(page)
    && page.lastIndexOf('.bubble .att-video {') > page.lastIndexOf('.att-video { width: min(520px, calc(100vw - 64px)); max-width: none; }'));
  // 1.5.58 beginner test: what it said back.
  check('C12 beginner test: 「以后都允许」 in words (「以后在工作区里删文件」, 「移动文件的命令（程序：move-item）」), never the folder\'s whole path; after 撤销 the receipt says it was put back and the turn\'s line follows',
    C.rememberWords({ key: 'fs_delete:c:\\users\\x\\lamplit\\workspace', label: '在 C:\\Users\\x\\Lamplit\\workspace 里删文件' }) === '在工作区里删文件'
    && C.rememberWords({ key: 'fs_write:c:/w/workspace/notes' }) === '在「notes」文件夹里写文件'
    && C.rememberWords({ key: 'shell:move-item', label: '用 move-item 运行命令' }) === '移动文件的命令（程序：move-item）'
    && page.includes('都不再问${still}。`) : null;') && page.includes('以后${rememberWords(data.remember)}都不再问')
    && cards.includes("删掉后又恢复了") && cards.includes('state.undone.add(turnId);') && cards.includes("kind === 'undone' ? '↺'"));
  // The coordinator after the beginner test: the colour is always the hub's level, look-only commands too (a client guess can be wrong).
  check('C13 beginner test: the risk colour is always the hub\'s level, a look-only command included (「只是查看 · 风险中」, never a client-side green); a command only the page guesses looks says 「应该只是查看」; 「没有要改的」 is not a red failure; known errors in words',
    !cards.includes("el('span', 'approval-risk ok', '只是查看')") && cards.includes("const tag = el('span', `approval-risk ${level[0]}`, words ? `${words} · ${level[1]}` : level[1]);")
    && C.cardKindWords({ tool: 'shell', args: { command: 'ls' } }, true) === '只是查看' && C.cardKindWords({ tool: 'shell', args: { command: 'ls' } }, false) === '应该只是查看'
    && page.includes("const nothing = !item.pending && !item.ok && item.output?.error?.code === 'ADJUST_NOTHING';")
    && cards.includes("FS_NOT_FOUND: '找不到这个文件，可能已经删了或改了名'"));
  check('C14 beginner test: next steps mark a suggestion only when there is one (好 for a yes-or-no, or the choice the reply recommends); a group of replies shows what each answers and has 「不回这条」',
    cards.includes("const pick = choices[0] === '好' ? 0 : choices.findIndex((c) => /推荐|建议/.test(c));")
    && cards.includes("decide(row.dataset.approval, 'deny', '', row, go, skip)") && cards.includes('原评论：'));
  check('C9 Enter = the main button, Esc = 不要 on the focused card (not while typing in a box); a new card takes the keys only when nothing else has focus',
    cards.includes("if (e.key === 'Enter' && e.target === card && !main.disabled)") && cards.includes("else if (e.key === 'Escape' && !typing && !no.disabled)")
    && cards.includes("(!active || active === document.body)") && page.includes('actions.appendChild(armCardKeys(card, allow, reject));'));
  check('C10 queued fixes: 「等你点头…」 sits under the card it is about after a reload, and 「试试这些」 is not drawn while the first thing is still at work (it landed mid-chat)',
    /messagesEl\.appendChild\(card\);\n  \}\n  \/\/ 「等你点头…」[^\n]*\n  keepTypingLast\(\);/.test(page)
    && page.includes("if (state.attention?.items?.[currentChatKey()]?.working) return;\n  const row = el('div', 'starter-row');")
    && page.includes("messagesEl.querySelectorAll('.starter-row, .starter-tip, .next-steps').forEach((n) => n.remove());"));

  // --- 1.5.58: 「同一个操作原样重复了 3 次」 counts only steps that ran --------------------------
  {
    const { AgentRuntime } = await import('../src/agent.mjs');
    const toolsMod = await import('../src/tools.mjs');
    const { NEW_MESSAGE_NOTE } = await import('../src/approvals.mjs');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-1558-'));
    // One turn with a scripted model: `calls` the same step n times, then a plain answer; `answers` resolve its cards in order.
    const turn = async ({ tool, args, times, answers = [] }) => {
      let n = 0;
      let asked = 0;
      const model = { provider: 'fake', model: 'fake', complete: async () => {
        n += 1;
        return n <= times ? { content: '', toolCalls: [{ id: `c${n}`, name: tool, arguments: args }] } : { content: '好的。' };
      } };
      const bot = { id: `rep-${tool}-${times}-${answers.join('')}`, name: '测', role: '', tools: ['fs_delete', 'fs_list'], skills: [], policy: {} };
      const ev = [];
      const rt = new AgentRuntime({ config: { workspaceDir: ws, policy: {} }, registry: toolsMod.createRegistry({ workspaceDir: ws, config: {} }), model,
        bots: { getBot: async () => bot, listBots: async () => [bot] }, memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
        approvals: { cancelForTurn() {}, request: () => { const a = answers[asked++] || 'approved'; return Promise.resolve(a === 'superseded' ? { decision: 'denied', note: NEW_MESSAGE_NOTE } : { decision: a }); } },
        bus: { emit: (e) => ev.push(e) } });
      rt.record = async () => {};
      fs.writeFileSync(path.join(ws, 'r.txt'), 'x');
      const res = await rt.runTurn({ botId: bot.id, text: '删掉 r.txt' });
      const stuck = ev.some((e) => e.type === 'message' && /原样重复了 3 次/.test(e.text || ''));
      return { status: res.status, stuck, asked, n };
    };
    const twice = await turn({ tool: 'fs_delete', args: { path: 'r.txt' }, times: 3, answers: ['superseded', 'superseded', 'approved'] });
    const deny = await turn({ tool: 'fs_delete', args: { path: 'r.txt' }, times: 1, answers: ['denied'] });
    const denyAgain = await turn({ tool: 'fs_delete', args: { path: 'r.txt' }, times: 3, answers: ['denied', 'denied', 'denied'] });
    const expired = await turn({ tool: 'fs_delete', args: { path: 'r.txt' }, times: 3, answers: ['timeout', 'timeout', 'approved'] });
    const ran = await turn({ tool: 'fs_list', args: { path: '.' }, times: 3 });
    const agent = await readText('../src/agent.mjs');
    check('C15 the same message sent twice while its card waited, then 允许: not 「卡住了」 (the two cards written past never ran); a card left to expire does not count either',
      twice.status === 'success' && !twice.stuck && twice.asked === 3 && expired.status === 'success' && !expired.stuck, JSON.stringify({ twice, expired }));
    check('C15 a card answered 不要 ends the turn cleanly: not stuck and not failed, even when the bot asks the same thing again after each 不要',
      deny.status === 'success' && !deny.stuck && denyAgain.status === 'success' && !denyAgain.stuck, JSON.stringify({ deny, denyAgain }));
    check('C15 real repeats still stop: the same step run three times in a row stops at 3 (max_steps, 「同一个操作原样重复了 3 次」), as before; only the not-run answers are left out',
      ran.status === 'max_steps' && ran.stuck && ran.n === 3
      && agent.includes('if (!outcome?.notRun) {') && agent.includes("return { notRun: true }; // not a repeat of anything (1.5.58)"), JSON.stringify(ran));
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
