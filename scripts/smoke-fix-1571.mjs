// 1.5.71: from the first run on 1.5.70 (11-25, 20:02). The phone no longer dropped - 54 steps, nine pictures,
// title, text checked letter by letter - and then:
//   1. three taps on the same spot (each removed the topic that had moved up into it) were taken for a loop
//      and the turn was stopped;
//   2. five seconds later the 20:05 routine found the phone on that page, pressed back and tapped 「退出」;
//   3. earlier that evening a bot had told the human the cause was "省电优化杀后台" - its own guess, saved to
//      the shared memory and passed on by the coordinator as a finding.
// Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function fix1571Checks({ check, toolsMod, readText }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');

  // --- 1. a repeat is the same step with the same screen after it -------------------------------------
  const m = (r) => A.screenMark('phone', r);
  check('REP71-1 the mark of a step on a screen: other words on the screen = another mark; a file name that only counts time = the same; other tools have none',
    m({ screen: [{ text: '#职场冷知识' }] }) !== m({ screen: [{ text: '#五中全会' }] })
    && m({ screen: [{ text: 'a' }], path: 'screen-1795608198255.jpg' }) === m({ screen: [{ text: 'a' }], path: 'screen-1795608199999.jpg' })
    && A.screenMark('shell', { stdout: 'x' }) === '' && A.screenMark('browser_click', { page: 'a' }) !== A.screenMark('browser_click', { page: 'b' }));

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-fix71-'));
  try {
    const run = async ({ screens }) => {
      let n = 0;
      const said = [];
      const bot = { id: 'pub', name: '发布', role: '发布', persona: 'p', tools: ['phone'], skills: [], policy: {} };
      const phoneStub = {
        name: 'phone', risk: () => ({ risk: 'LOW' }), escalate: async () => null,
        run: async (_args, ctx) => { const r = { tapped: 'x', screen: [{ text: screens[Math.min(n, screens.length - 1)] }] }; n += 1; ctx.stepResult = r; return r; },
      };
      const model = { provider: 'fake', model: 'fake', complete: async (messages) => {
        const k = messages.filter((x) => x.role === 'tool').length;
        if (k < 5) return { content: '', toolCalls: [{ id: `c${k}`, name: 'phone', arguments: { action: 'tap', index: 14 } }] };
        return { content: '好了。', toolCalls: [] };
      } };
      let rtRef = null;
      const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
      const realGet = registry.get.bind(registry);
      registry.get = (name) => (name === 'phone' ? { ...(realGet(name) || {}), ...phoneStub } : realGet(name));
      const rt = new A.AgentRuntime({
        config: { workspaceDir: ws, policy: {} }, registry, model,
        bots: { getBot: async () => bot, listBots: async () => [bot] }, groups: { listGroups: async () => [] },
        memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
        approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request() { const p = Promise.resolve({ decision: 'approved', approval: { id: 'a' } }); p.record = { id: 'a' }; return p; } },
        bus: { emit() {} },
      });
      rtRef = rt;
      rt.humanGoFile = path.join(ws, 'go.json');
      rt.record = async (_id, rec) => { if (rec?.kind === 'assistant') said.push(String(rec.text || '')); };
      rt.queueMs = 50;
      const out = await rt.runTurn({ botId: 'pub', text: '把多出来的话题删掉', source: 'chat' });
      return { taps: n, stuck: said.some((t) => t.includes('原样重复了 3 次')), status: out?.status };
    };
    const moving = await run({ screens: ['#a #b #c', '#b #c', '#c', '', ''] });
    const frozen = await run({ screens: ['#a #b #c'] });
    check('REP71-2 the same tap five times while the screen changes each time (a topic removed, the next one moves up) is not a loop; the same tap on a screen that stays as it is still stops after three',
      moving.taps === 5 && !moving.stuck && frozen.taps === 3 && frozen.stuck, JSON.stringify({ moving, frozen }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // --- 2. what is half written on the phone -----------------------------------------------------------
  const rt = Object.create(A.AgentRuntime.prototype);
  const pub = { id: 'pub', name: '发布' };
  rt.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'type', text: '今天上午问它一件小事：这三段要不要重排。' }, out: false, place: '小红书' });
  const same = rt.phoneDraftFor({ chainId: 'c1', bot: pub, source: 'group' });
  const human = rt.phoneDraftFor({ chainId: 'c2', bot: pub, source: 'chat' });
  const routine = rt.phoneDraftFor({ chainId: 'c3', bot: pub, source: 'routine' });
  const other = rt.phoneDraftFor({ chainId: 'c4', bot: { id: 'art', name: '美术' }, source: 'chat' });
  rt.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'type', text: 'AI工具', submit: true }, out: false, place: '小红书' }); // a search: nothing new
  const still = Boolean(rt.phoneDraftFor({ chainId: 'c3', bot: pub, source: 'routine' }));
  const saved = Object.create(A.AgentRuntime.prototype);
  saved.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'type', text: '一段写了一半的正文内容' }, out: false, place: '小红书' });
  saved.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'tap', target: '存草稿' }, out: false, place: '小红书' });
  const sent = Object.create(A.AgentRuntime.prototype);
  sent.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'type', text: '一段写了一半的正文内容' }, out: false, place: '小红书' });
  sent.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'tap', target: '发布笔记' }, out: true, place: '小红书' });
  const old = Object.create(A.AgentRuntime.prototype);
  old.phoneDraft = { botId: 'pub', botName: '发布', chainId: 'c1', place: '小红书', at: Date.now() - 4 * 3600 * 1000, what: 'x' };
  check('DRAFT71-1 text typed into an app on the phone is remembered as half written (who, which app, when): free for the same piece of work and for the bot\'s own turn with the human; held against a routine of the same bot and against another bot; gone once it went out, was saved as a draft, or after three hours',
    same === null && human === null && routine?.botName === '发布' && routine.place === '小红书' && routine.what.startsWith('今天上午问它') && other?.botId === 'pub' && still
    && !saved.phoneDraftFor({ chainId: 'c9', bot: pub, source: 'routine' }) && !sent.phoneDraftFor({ chainId: 'c9', bot: pub, source: 'routine' }) && !old.phoneDraftFor({ chainId: 'c9', bot: pub, source: 'routine' }),
    JSON.stringify({ same, human, routine, other, still }));

  const tools = await readText('../src/tools.mjs');
  check('DRAFT71-2 while it is held, a tap on 「退出」「放弃」「不保存」 asks first, every time, and says whose work it would throw away; every phone result tells the bot so (unfinished) - 「返回」「取消」「存草稿」 are not such taps',
    ['退出', '放弃编辑', '不保存', '清空'].every((w) => P.DISCARD_WORDS.test(w)) && !['返回', '取消', '存草稿', '完成', '下一步'].some((w) => P.DISCARD_WORDS.test(w))
    && tools.includes("const draft = action === 'tap' ? deps.getRuntime?.()?.phoneDraftFor?.(ctx) : null;") && tools.includes("return { risk: RISK.HIGH, alwaysAsk: true, app, phoneKind: 'delete', reason:")
    && tools.includes('填到一半的内容') && tools.includes('unfinished: `「${draft.botName}」 left something half written in') && tools.includes('return PHONE_ACT_ACTIONS.has(action) ? screenAfter(out) : told(out);'));

  // --- 3. facts, not guesses ---------------------------------------------------------------------------
  const agent = await readText('../src/agent.mjs');
  const watcher = await readText('../mobile/android/app/src/main/java/com/desk/assistant/NightshiftWatcher.java');
  check('FACT71-1 every bot is told: a cause comes from a tool result or a file, else 「原因还不知道」; a guess is said as a guess, never makes the human change a setting, never goes into memory; a teammate\'s 「可能」 stays 「可能」. memory_write says so too, and the phone\'s "off" says what is not known',
    agent.includes("'- Why something failed (1.5.71): say only what a tool result or a file says.") && agent.includes('「我猜是…，没验证」') && agent.includes('never save it with memory_write') && agent.includes("keep their 「可能」 a 「可能」")
    && tools.includes('never the cause you guessed for a failure') && watcher.includes('Why it is off is not known from here') && watcher.includes('do not name a cause'));
}
