// 1.5.68: fewer steps for the same job - for every bot.
//   11-24: 发布 took 341 steps to put one 小红书 note up (260 on the phone; 98 of them a look right after a tap,
//   18 to tick 9 pictures), TikTok运营 557 to schedule one video on two sites (92 a snapshot right after an action,
//   110 finding out how the pages work - again). Now:
//     1. a step returns the screen / the page after it;
//     2. several steps on one screen or page go in one call (phone action "steps", browser_steps);
//     3. the steps that got a job done on a site or in an app are kept, and handed over when it is opened again.
//   Also here: a card's counters (「评论 0」) are not a button; 「没有变化」 from a look-back is not a chat message.
// No phone and no browser: both are stand-ins. Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function fewerStepsChecks({ check, toolsMod, readText }) {
  const P = await import('../src/phone.mjs');
  const C = await import('../src/carryover.mjs');
  const B = await import('../src/playbooks.mjs');
  const A = await import('../src/agent.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-steps68-'));
  try {
    // --- a stand-in phone ---------------------------------------------------------------------------
    const acts = [];
    let labels = {};
    const phone = {
      act: async (action, a) => {
        acts.push([action, a.index ?? a.what ?? a.key ?? a.text ?? '']);
        if (action === 'look') return { screenshot: 'phone/s.jpg', app: 'com.xingin.xhs', appName: '小红书', elements: [{ i: 0, text: '下一步' }] };
        if (action === 'tap' && a.what === '坏的') { const e = new Error('nothing there'); e.code = 'PHONE_NO_TARGET'; throw e; }
        return { done: true, ...(action === 'tap' ? { tapped: labels[a.index] || a.what || '' } : {}), app: 'com.xingin.xhs' };
      },
      labelFor: (a) => ({ label: labels[a.index] || a.what || a.target || '', app: 'com.xingin.xhs', clearsBox: false }),
      focusedBox: async () => ({ search: false, app: 'com.xingin.xhs' }),
    };
    const reg = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getPhone: () => phone, phoneSettleMs: 0, phoneStepGapMs: 0 });
    const tool = reg.get('phone');
    const ctx = { workspaceDir: ws, bot: { id: 'b' } };

    // 1. the screen after a step
    const tap = await tool.run({ action: 'tap', index: 3 }, ctx);
    const look = await tool.run({ action: 'look' }, ctx);
    check('STEP68-1 a phone tap returns the screen after it (what a look gives), told not to look again; a look itself is unchanged',
      tap.done === true && tap.screen?.elements?.[0]?.text === '下一步' && /do not look again/.test(tap.note || '') && !look.screen && look.elements?.length === 1
      && acts.map((a) => a[0]).join() === 'tap,look,look', JSON.stringify(acts));

    // 2. several steps in one call
    acts.length = 0;
    const nine = await tool.run({ action: 'steps', steps: Array.from({ length: 9 }, (_, i) => ({ action: 'tap', x: 100 + i, y: 449, what: `第${i + 1}张勾选圈` })) }, ctx);
    const stop = await tool.run({ action: 'steps', steps: [{ action: 'tap', what: '好的' }, { action: 'tap', what: '坏的' }, { action: 'tap', what: '不该点到' }] }, ctx);
    check('STEP68-2 ticking 9 pictures is ONE step: nine taps, one screen read at the end; it stops at the first step that fails and says which, with the screen as it is',
      nine.done === 9 && nine.of === 9 && nine.screen?.app === 'com.xingin.xhs' && acts.filter((a) => a[0] === 'tap' && /勾选圈/.test(a[1])).length === 9
      && acts.slice(0, 10).filter((a) => a[0] === 'look').length === 1 && stop.done === 1 && stop.stoppedAt?.step === 2 && !acts.some((a) => a[1] === '不该点到') && Boolean(stop.screen),
      JSON.stringify({ nine: nine.done, stop: stop.stoppedAt }));

    labels = { 1: '选项一', 2: '发布笔记' };
    const plain = await tool.escalate({ action: 'steps', steps: [{ action: 'tap', index: 1 }, { action: 'key', key: 'back' }] }, ctx);
    const hard = await tool.escalate({ action: 'steps', steps: [{ action: 'tap', index: 1 }, { action: 'tap', index: 2 }] }, ctx);
    check('STEP68-3 steps are judged one by one: ordinary taps are an ordinary phone step; one that publishes makes the whole call a publish step (asked, or run on the human\'s 「发」, as alone)',
      plain.risk === 'MEDIUM' && !plain.alwaysAsk && /连着做 2 步/.test(plain.reason) && hard.alwaysAsk === true && hard.phoneKind === 'publish' && /发布笔记/.test(hard.reason),
      JSON.stringify({ plain, hard }));

    // a card's counters are not a button
    labels = { 5: '最新笔记, 下班后能交给AI的8件活｜一件一句话, 观看 4, 赞 0, 评论 0', 6: '评论', 7: '定时发布', 8: '删除 2 张' };
    const card = await tool.escalate({ action: 'tap', index: 5 }, ctx);
    const yes = [6, 7, 8].map((i) => i);
    const asked = [];
    for (const i of yes) asked.push((await tool.escalate({ action: 'tap', index: i }, ctx)).alwaysAsk === true);
    check('STEP68-4 opening a note whose card reads 「…, 赞 0, 评论 0」 is an ordinary tap (11-24: it asked as a comment and stopped the 20:05 check); the buttons 「评论」「定时发布」「删除 2 张」 still ask; 「已发布」「12 条评论」「回复 5」 are a post\'s state',
      card.risk === 'MEDIUM' && !card.alwaysAsk && asked.every(Boolean)
      && !['已发布 · 3 天前', '12 条评论', '回复 5', '发布于 11-24'].some((w) => P.SENSITIVE_TAP.test(P.tapWords(w))) && P.SENSITIVE_TAP.test(P.tapWords('写评论')),
      JSON.stringify({ card, asked }));

    // --- a stand-in browser -------------------------------------------------------------------------
    const src = await readText('../src/tools.mjs');
    check('STEP68-5 a click, typing, a key and an upload return the page after them (the snapshot\'s content, fresh refs); browser_steps does several in one call and comes with browser_open like the other page tools',
      src.includes('run: async (args, ctx) => withPage(browserManager(ctx), await browserManager(ctx).click(args)),') && src.includes('withPage(browserManager(ctx), await browserManager(ctx).type(args))')
      && src.includes('withPage(browserManager(ctx), await browserManager(ctx).press(args))') && src.includes('withPage(browserManager(ctx), await browserManager(ctx).upload(args, abs))')
      && Boolean(reg.get('browser_steps')) && reg.isGranted({ tools: ['browser_open'] }, 'browser_steps') && !reg.isGranted({ tools: ['fs_read'] }, 'browser_steps'));

    const w = C.stepWords({ name: 'browser_steps', args: { steps: [{ do: 'type', ref: '@e4', text: '標題' }, { do: 'click', ref: '@e9' }] },
      result: { ok: true, steps: [{ step: 1, do: 'type', typed: { name: '标题' } }, { step: 2, do: 'click', clicked: { name: '预约发布' }, url: 'https://www.tiktok.com/tiktokstudio/content' }], url: 'https://www.tiktok.com/tiktokstudio/content' }, page: 'https://www.tiktok.com/tiktokstudio/upload' });
    const pw = C.stepWords({ name: 'phone', args: { action: 'tap', index: 2 }, result: { done: true, tapped: '发布笔记', screen: { app: 'com.xingin.xhs' } }, page: 'https://a.example/x' });
    const pcard = C.stepWords({ name: 'phone', args: { action: 'tap', index: 5 }, result: { done: true, tapped: '最新笔记, 评论 0', screen: { app: 'com.xingin.xhs' } } });
    check('STEP68-6 what is handed to a go-on covers them too: browser_steps in one line, out when one of its clicks publishes; a phone tap on 「发布笔记」 is out, filed under its app, and leaves the browser\'s page alone; a note card is not out',
      /在「标题」里输入了「標題」，点了「预约发布」/.test(w.did) && w.out && /^在手机「小红书」点了「发布笔记」$/.test(pw.did) && pw.out && pw.place === 'app:com.xingin.xhs' && pw.page === 'https://a.example/x' && !pcard.out,
      JSON.stringify({ w: w.did, pw, pcard: pcard.out }));

    // --- 3. the way it was done, kept ---------------------------------------------------------------
    const receipts = [
      { name: 'browser_open', ok: true, did: '打开了 www.tiktok.com/tiktokstudio/upload', out: false, place: 'tiktok.com' },
      { name: 'browser_eval', ok: true, did: '', out: false, place: 'tiktok.com' },
      { name: 'browser_upload', ok: true, did: '在 www.tiktok.com/tiktokstudio/upload 上传了 v.mp4', out: true, place: 'tiktok.com' },
      { name: 'browser_click', ok: false, did: '', out: false, place: 'tiktok.com' },
      { name: 'browser_type', ok: true, did: '在 www.tiktok.com/tiktokstudio/upload 在「描述」里输入了「この朝の音、聞こえる？」', out: false, place: 'tiktok.com' },
      { name: 'browser_click', ok: true, did: '在 www.tiktok.com/tiktokstudio/upload 点了「预约发布」', out: true, place: 'tiktok.com' },
      { name: 'browser_open', ok: true, did: '打开了 www.tiktok.com/tiktokstudio/content', out: false, place: 'tiktok.com' },
      { name: 'browser_open', ok: true, did: '打开了 example.com', out: false, place: 'example.com' },
      { name: 'fs_write', ok: true },
    ];
    const made = B.buildPlaybooks(receipts);
    check('STEP68-7 from a finished piece of work: only places where something went out, the steps up to the last one that did, in order; failed steps and steps without a line left out, what was typed left out (the box stays); how many steps it cost',
      made.length === 1 && made[0].place === 'tiktok.com' && made[0].lines.length === 4 && made[0].cost === 7 && /里输入了内容$/.test(made[0].lines[2]) && !made[0].lines.join().includes('聞こえる')
      && /点了「预约发布」$/.test(made[0].lines[3]), JSON.stringify(made));

    let t = Date.UTC(2026, 10, 24);
    const file = path.join(ws, 'playbooks.json');
    const store = B.createPlaybooks({ file, now: () => t });
    const first = await store.keep({ ...made[0], botName: 'TikTok运营' });
    const longer = await store.keep({ place: 'tiktok.com', lines: ['a', 'b', 'c', 'd', 'e', 'f'], cost: 300 });
    const shorter = await store.keep({ place: 'tiktok.com', lines: ['a', 'b', 'c'], cost: 12 });
    t += 31 * 24 * 3600 * 1000;
    const later = await store.keep({ place: 'tiktok.com', lines: ['a', 'b', 'c', 'd', 'e', 'f'], cost: 300 });
    const again = B.createPlaybooks({ file, now: () => t });
    await again.load();
    t += 91 * 24 * 3600 * 1000;
    const old = B.createPlaybooks({ file, now: () => t });
    await old.load();
    check('STEP68-8 kept per place on this machine: a longer way does not replace a shorter fresh one, a shorter one does, after 30 days the newer wins; it survives a restart and is dropped after 90 days',
      first && !longer && shorter && later && again.get('tiktok.com')?.lines.length === 6 && !old.get('tiktok.com') && B.placeOf('https://www.TikTok.com/x?y=1') === 'tiktok.com' && B.appPlace('com.xingin.xhs') === 'app:com.xingin.xhs');

    // end to end: a bot publishes on a site; the next bot that opens it is handed the way
    const page = { url: '' };
    const fake = {
      browser_open: async (a) => { page.url = a.url; return { ok: true, url: a.url, title: 'Studio' }; },
      browser_upload: async (a) => ({ ok: true, uploaded: 1, files: a.paths.map((p) => p.split('/').pop()), url: page.url }),
      browser_click: async (a) => ({ ok: true, clicked: { tag: 'button', name: a.selector }, url: page.url }),
    };
    fs.writeFileSync(path.join(ws, 'v.mp4'), 'video');
    const bots = new Map([['one', { id: 'one', name: '甲', role: '发', persona: 'WHO:one', tools: ['browser_open'], skills: [], policy: {} }], ['two', { id: 'two', name: '乙', role: '发', persona: 'WHO:two', tools: ['browser_open'], skills: [], policy: {} }]]);
    const seen = [];
    const call = (name, args) => ({ content: '', toolCalls: [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });
    const model = {
      provider: 'fake', model: 'fake',
      complete: async (messages) => {
        const who = /WHO:(\w+)/.exec(String(messages[0]?.content || ''))?.[1];
        const n = messages.filter((m) => m.role === 'tool').length;
        if (n) seen.push({ who, last: String(messages[messages.length - 1]?.content || '') });
        if (who === 'one') {
          if (n === 0) return call('browser_open', { url: 'https://studio.example.com/upload' });
          if (n === 1) return call('browser_upload', { paths: ['v.mp4'] });
          if (n === 2) return call('browser_click', { selector: '发布' });
          return { content: '发好了。', toolCalls: [] };
        }
        if (n === 0) return call('browser_open', { url: 'https://studio.example.com/upload' });
        return { content: '看到了。', toolCalls: [] };
      },
    };
    let rtRef = null;
    const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
    const realGet = registry.get.bind(registry);
    registry.get = (name) => { const tl = realGet(name); return fake[name] && tl ? { ...tl, run: fake[name] } : tl; };
    const rt = new A.AgentRuntime({
      config: { workspaceDir: ws, policy: {} }, registry, model,
      bots: { getBot: async (id) => bots.get(id) || null, listBots: async () => [...bots.values()] },
      memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
      approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request() { const p = Promise.resolve({ decision: 'approved', approval: { id: 'ap' } }); p.record = { id: 'ap' }; return p; } },
      bus: { emit() {} },
    });
    rtRef = rt;
    rt.record = async () => {};
    rt.playbooks = B.createPlaybooks({ file: path.join(ws, 'pb2.json') });
    await rt.runTurn({ botId: 'one', text: '发这条视频', source: 'chat' });
    const end = Date.now() + 3000;
    while (Date.now() < end && !rt.playbooks.get('studio.example.com')) await new Promise((r) => setTimeout(r, 30));
    const firstOpen = seen.find((s) => s.who === 'one')?.last || '';
    await rt.runTurn({ botId: 'two', text: '也发一条', source: 'chat' });
    const secondOpen = seen.find((s) => s.who === 'two')?.last || '';
    check('STEP68-9 end to end: a bot uploads and clicks 「发布」 on a site and the work ends well - the way is kept; the first time nothing was handed over, the next bot that opens the site gets it with the result (lastTime: whose, when, the steps)',
      !/lastTime/.test(firstOpen) && /lastTime/.test(secondOpen) && /上传了 v\.mp4/.test(secondOpen) && /点了「发布」/.test(secondOpen) && /甲/.test(secondOpen) && /以页面为准/.test(secondOpen),
      JSON.stringify({ kept: rt.playbooks.get('studio.example.com'), second: secondOpen.slice(0, 200) }));

    // the rule in every bot's prompt, the trimming, 「没有变化」
    const agentSrc = await readText('../src/agent.mjs');
    const msgs = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 6; i += 1) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `p${i}`, type: 'function', function: { name: 'phone', arguments: JSON.stringify({ action: 'tap', index: i }) } }] }, { role: 'tool', tool_call_id: `p${i}`, content: `screen${i} ${'x'.repeat(3000)}` });
    }
    A.trimOldToolOutputs(msgs, { batch: 1 });
    const outs = msgs.filter((m) => m.role === 'tool');
    check('STEP68-10 every bot is told so (few steps: go on from the returned screen, several actions in one call, follow lastTime); old screens carried by taps are trimmed like old looks (the last 2 stay whole), so the extra content does not pile up',
      agentSrc.includes("'- Few steps (1.5.68):") && outs.slice(0, 4).every((m) => /earlier output trimmed/.test(m.content)) && outs.slice(4).every((m) => m.content.length > 3000));
    check('STEP68-11 「没有变化」 from a look-back or a watched folder is not a message in the chat (the turn\'s status has it; the bot\'s attention mark is still cleared); from a human\'s own question it is an answer like any other',
      A.NOTHING_NEW.test('没有变化') && A.NOTHING_NEW.test('「没有变化」。') && !A.NOTHING_NEW.test('没有变化，但 D15 还在审核')
      && agentSrc.includes("const nothingNew = (source === 'followup' || source === 'watch') && !response.toolCalls?.length && NOTHING_NEW.test(String(response.content || '').trim());")
      && (await readText('../src/server.mjs')).includes("NO_CHANGE.test(texts.join('\\n').trim() || String(result?.summary || '').trim())"));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
