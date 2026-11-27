// 1.5.77: what 1.5.75 left open. A line that only asks while a board runs is answered from the board and
// changes nothing - but an order worded as a question (「能不能把标题改短点？」) was taken for one too.
// Called from smoke.mjs as a stage.
export async function fix1577Checks({ check, readText }) {
  const A = await import('../src/agent.mjs');
  const asks = ['发了吗', '到哪一步了？', '好了没', '现在怎么样了', '发了没有', '标题改好了吗', '图出完了吗？', '还要多久', '几点发？', '可以了吗'];
  const orders = ['能不能把标题改短点？', '可以换一张封面吗', '把定时改到后天？', '帮我看看正文有没有错别字？', '标题改成秋天可以吗', '能否提前到 18:00？', '先别发，行不行',
    '不要用这张图好吗', '麻烦把第三张图删掉？', '要不换个选题？', '能发到视频号吗？', '把话题去掉吧？'];
  const got = { asks: asks.filter((t) => !A.isAsking(t)), orders: orders.filter((t) => A.isAsking(t)) };
  check('ASK77-1 an order worded as a question (能不能…、可以…吗、把…改…？、帮我…、…改成…可以吗、要不…) is not taken for a question about progress: it goes the old way, where the board can be changed; plain questions (发了吗、标题改好了吗、还要多久、可以了吗) still are',
    got.asks.length === 0 && got.orders.length === 0, JSON.stringify(got));

  const rig = (reply) => {
    const rt = Object.create(A.AgentRuntime.prototype);
    const seen = { calls: [], changed: [] };
    Object.assign(rt, {
      bots: { getBot: async () => ({ id: 'lead', name: '主理人', role: '' }) },
      modelFor: async () => ({ provider: 'x', model: 'y', complete: async (messages, opts) => { seen.calls.push({ messages, opts }); return reply; } }),
      bus: { emit: () => {} },
      getApp: () => ({ settings: { timezone: 'Asia/Shanghai' } }),
      recordGroupMessage: async () => {},
      changeTask: async ({ args }) => { seen.changed.push(args); return '把新要求告诉了文案（第 1 项）'; },
    });
    return { rt, seen };
  };
  const group = { id: 'g77', name: '内容组', members: [{ id: 'lead', name: '主理人' }, { id: 'copy', name: '文案' }] };
  const plan = { id: 'p1', coordinatorId: 'lead', request: '发后天的小红书', tasks: [{ id: 't1', title: '写文案', owner: 'copy', status: 'doing', startedAt: new Date().toISOString() }] };
  const o = rig({ content: '', toolCalls: [{ name: 'task_change', id: 'c1', arguments: { action: 'note', task: 1, reason: '标题改短一点' } }] });
  const oa = await o.rt.reviewPlan({ group, plan, texts: ['能不能把标题改短点？'], turnId: 't' });
  const sys = o.seen.calls[0]?.messages[0].content || '';
  check('ASK77-2 「能不能把标题改短点？」 while a board runs: the coordinator gets the tool to change the board and the note reaches the owner - it is not just answered',
    o.seen.changed.length === 1 && Array.isArray(o.seen.calls[0]?.opts?.tools) && /判断它对任务板有没有影响/.test(sys) && !/他在问，不是在提新要求/.test(sys) && /告诉了文案/.test(oa.text), JSON.stringify({ oa, changed: o.seen.changed }));

  // --- a machine just added is paired without the human typing a code -----------------------------------
  // 11-27: 「添加机器」 with the account and password of a new server went through, 「切换到这台机器」 opened
  // 「连接你的 Lamplit」. The install had paired with the installer's code to send the model settings over,
  // the hub spent that code (a typed code works once), and the desktop app's own pairing with it was refused.
  const R = await import('../src/remote.mjs');
  const hub = { code: '11112222', n: 0, sessions: new Set(), calls: [] };
  const fakeFetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    hub.calls.push(`${opts.method || 'GET'} ${path}`);
    const reply = (status, json, headers = {}) => ({ ok: status < 300, status, json: async () => json, headers: { get: (k) => headers[k.toLowerCase()] || null } });
    if (path === '/api/pair') {
      const sent = JSON.parse(opts.body).code;
      if (sent !== hub.code) return reply(401, { error: { code: 'PAIR_INVALID_CODE' } });
      hub.n += 1;
      hub.code = `3333444${hub.n}`; // spent once: a new one at once
      const s = `s${hub.n}`;
      hub.sessions.add(s);
      return reply(200, { ok: true }, { 'set-cookie': `desk_session_4390=${s}; Path=/; HttpOnly` });
    }
    if (path === '/api/pairing') {
      const s = /desk_session_4390=([^;]+)/.exec(opts.headers?.cookie || '')?.[1];
      return hub.sessions.has(s) ? reply(200, { url: 'http://x', code: hub.code }) : reply(401, {});
    }
    return reply(404, {});
  };
  const job = { pairCode: '11112222' };
  const cookie = await R.pairForSetup('http://new.example:4390', job.pairCode, (next) => { job.pairCode = next; }, fakeFetch);
  // What the desktop app does next: pair with the code the job now holds.
  const desktop = await fakeFetch('http://new.example:4390/api/pair', { method: 'POST', body: JSON.stringify({ code: job.pairCode }) });
  const stale = await fakeFetch('http://new.example:4390/api/pair', { method: 'POST', body: JSON.stringify({ code: '11112222' }) });
  let bad = '';
  await R.pairForSetup('http://new.example:4390', '00000000', () => { bad = 'called'; }, fakeFetch).catch((err) => { bad = err.message; });
  const remote = await readText('../src/remote.mjs');
  const shell = await readText('../desktop/main.mjs');
  const page = await readText('../public/app/main/11-machines.js');
  check('PAIR77-1 the install pairs with the installer\'s code to send the settings over, which spends it: it reads the hub\'s next code at once and the job hands that one to the desktop app, whose own pairing then goes through (the first code no longer does); a refused code fails loudly',
    cookie === 'desk_session_4390=s1' && job.pairCode === '33334441' && desktop.ok && !stale.ok && bad === 'pair HTTP 401'
    && hub.calls.slice(0, 2).join() === 'POST /api/pair,GET /api/pairing',
    JSON.stringify({ cookie, job, desktop: desktop.status, stale: stale.status, bad, calls: hub.calls }));
  check('PAIR77-2 both settings hand-overs of an install give the next code back to the job (model, and the relay on Windows); the desktop app waits 15 s for a far machine and writes a refusal in its log; the page says pairing is left to do when it is',
    remote.includes('visionToShare(), (next) => { job.pairCode = next; });') && remote.includes('shareRelay(job.reachUrl, job.pairCode, settings, (next) => { job.pairCode = next; })')
    && remote.split('await pairForSetup(hubUrl, pairCode, onCode)').length === 3
    && shell.includes('if (!res.ok) { bootLog(`pair ${url} refused: HTTP ${res.status}`); return false; }')
    && page.includes("escapeHtml('没能自动配对，切过去时填这个配对码：')"));
}
