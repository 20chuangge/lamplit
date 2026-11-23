// 1.5.65: the group-collaboration eval checks itself (scripts/eval-collab.mjs --fake --self-check).
// Not a test of the product's collaboration (that is the eval's own report): a test that the eval's
// nine detectors catch what they are there to catch, that a planted violation which lands is always
// caught, and that each of the six scenarios runs to its end on this build with the fake model.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import { startMockSites, SITES } from '../eval/collab/mocksites.mjs';
import { readCall } from '../eval/collab/fakemodel.mjs';
import { runSelfCheck } from '../eval/collab/selfcheck.mjs';
import { INVARIANTS } from '../eval/collab/invariants.mjs';
import { SCENARIOS } from '../eval/collab/scenarios.mjs';

const rawFetch = (...a) => globalThis.fetch(...a);

/**
 * The two routes the eval needs on the human's other machine (1.5.65), on two test hubs:
 *   DELETE /api/peers/:m/bots/:id  only an evaluation bot (eval: true and 「评测-」), only the human, never passed on;
 *   POST   /api/peers/:m/pause     the first hub acts as if that machine were gone, the human only, memory only.
 */
export async function peerRouteChecks({ check }) {
  const { startTestHub, scratchRoot } = await import('../eval/collab/hubs.mjs');
  const fs = await import('node:fs');
  const root = scratchRoot('peerroutes');
  let A = null;
  let B = null;
  try {
    A = await startTestHub({ name: 'A', root });
    B = await startTestHub({ name: 'B', root });
    await A.api.put('/api/peers', { self: { name: '甲机' }, peers: [{ name: '乙机', url: B.url, token: B.token }] });
    const m = encodeURIComponent('乙机');
    const call = async (p, { method = 'GET', body, headers = {}, key = A.key } = {}) => {
      const r = await rawFetch(`${A.url}${p}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-lamplit-local': key } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, json };
    };
    const made = await call(`/api/peers/${m}/bots`, { method: 'POST', body: { name: '评测-选题', role: 'x', eval: true } });
    const evalId = String(made.json?.bot?.id || '').split('@')[0];
    const there = async (id) => (await B.api.get(`/api/bots/${encodeURIComponent(id)}`).catch(() => null))?.bot || null;
    const evalBot = await there(evalId);
    const plain = (await B.api.post('/api/bots', { name: '日常助手', role: 'x' })).bot;
    const fake = (await B.api.post('/api/bots', { name: '评测-冒充', role: 'x' })).bot; // the name, not the flag
    const marked = (await B.api.post('/api/bots', { name: '日常-带标记', role: 'x', eval: true })).bot; // the flag, not the name
    const delPlain = await call(`/api/peers/${m}/bots/${plain.id}`, { method: 'DELETE' });
    const delFake = await call(`/api/peers/${m}/bots/${fake.id}`, { method: 'DELETE' });
    const delMarked = await call(`/api/peers/${m}/bots/${marked.id}`, { method: 'DELETE' });
    const delHub = await call(`/api/peers/${m}/bots/${evalId}`, { method: 'DELETE', key: '', headers: { authorization: `Bearer ${A.token}` } });
    const delVia = await call(`/api/peers/${m}/bots/${evalId}`, { method: 'DELETE', headers: { 'x-lamplit-via': '1' } });
    const delNoKey = await call(`/api/peers/${m}/bots/${evalId}`, { method: 'DELETE', key: '' });
    const stillAll = Boolean(await there(plain.id)) && Boolean(await there(fake.id)) && Boolean(await there(marked.id)) && Boolean(await there(evalId));
    const delOk = await call(`/api/peers/${m}/bots/${evalId}`, { method: 'DELETE' });
    check('PEER-1 an evaluation bot made on another machine through this one (eval: true) is deleted through this one; a bot that is not one - no flag, or not named 「评测-」 - is refused (NOT_EVAL_BOT) and stays',
      made.status === 200 && evalBot?.eval === true && delPlain.status === 403 && delPlain.json?.error?.code === 'NOT_EVAL_BOT' && delFake.status === 403 && delMarked.status === 403
      && stillAll && delOk.status === 200 && !(await there(evalId)),
      JSON.stringify({ made: made.status, evalFlag: evalBot?.eval, plain: delPlain.status, fake: delFake.status, marked: delMarked.status, ok: delOk.status }));
    check('PEER-2 … only the human: another hub\'s token is refused (HUMAN_ONLY), a call passed on is never passed on again (NOT_PASSED_ON), no key at all is refused',
      delHub.status === 403 && delHub.json?.error?.code === 'HUMAN_ONLY' && delVia.status === 403 && delVia.json?.error?.code === 'NOT_PASSED_ON' && [401, 403].includes(delNoKey.status),
      JSON.stringify({ hub: [delHub.status, delHub.json?.error?.code], via: [delVia.status, delVia.json?.error?.code], noKey: delNoKey.status }));

    // The pause: calls to that machine fail at once; an open one is cut; 0 resumes; the human only.
    const before = await call(`/api/peers/${m}/bots/${plain.id}/messages?limit=5`);
    const slow = rawFetch(`${A.url}/api/peers/${m}/bots/${plain.id}/stream`, { headers: { 'x-lamplit-local': A.key } }).then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      const end = Date.now() + 8000;
      while (Date.now() < end) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); if (/peer\.link[^\n]*down/.test(text)) break; }
      reader.cancel().catch(() => {});
      return text;
    });
    await new Promise((r) => setTimeout(r, 600));
    const paused = await call(`/api/peers/${m}/pause`, { method: 'POST', body: { seconds: 30 } });
    const t0 = Date.now();
    const during = await call(`/api/peers/${m}/bots/${plain.id}/messages?limit=5`);
    const fast = Date.now() - t0;
    const streamText = await slow;
    const byHub = await call(`/api/peers/${m}/pause`, { method: 'POST', body: { seconds: 0 }, key: '', headers: { authorization: `Bearer ${A.token}` } });
    const nobody = await call(`/api/peers/${encodeURIComponent('没有这台')}/pause`, { method: 'POST', body: { seconds: 5 } });
    const resumed = await call(`/api/peers/${m}/pause`, { method: 'POST', body: { seconds: 0 } });
    const after = await call(`/api/peers/${m}/bots/${plain.id}/messages?limit=5`);
    check('PEER-3 pausing the link to another machine: calls to it fail at once (PEER_UNREACHABLE), a stream open through this hub is told the link is down, 0 resumes it; that machine itself was never touched',
      before.status === 200 && paused.status === 200 && paused.json?.paused === true && during.status === 502 && during.json?.error?.code === 'PEER_UNREACHABLE' && fast < 2000
      && /peer\.link[^\n]*down/.test(streamText) && resumed.status === 200 && resumed.json?.paused === false && after.status === 200 && B.child?.exitCode === null,
      JSON.stringify({ before: before.status, paused: paused.json, during: [during.status, during.json?.error?.code, fast], stream: /down/.test(streamText), resumed: resumed.json, after: after.status }));
    check('PEER-4 … the human only (another hub\'s token: HUMAN_ONLY), a machine that is not paired: 404; at most 5 minutes, memory only',
      byHub.status === 403 && byHub.json?.error?.code === 'HUMAN_ONLY' && nobody.status === 404 && fs.readFileSync(new URL('../src/peers.mjs', import.meta.url), 'utf8').includes('Math.min(Number(ms) || 0, 5 * 60 * 1000)'),
      JSON.stringify({ byHub: [byHub.status, byHub.json?.error?.code], nobody: nobody.status }));
  } finally {
    if (A) await A.stop().catch(() => {});
    if (B) await B.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function collabSelfChecks({ check }) {
  // The routes the eval uses on the human's other machine, first.
  await peerRouteChecks({ check });
  // The mock sites: the flows that broke in real use, recorded server-side.
  const mock = await startMockSites();
  try {
    const post = async (p, body) => { const r = await rawFetch(`${mock.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    const wall = await post('/api/a/upload', { file: '1.mp4', kind: 'video' });
    const page = await (await rawFetch(`${mock.url}/a/login`)).text();
    mock.login('a');
    const up = await post('/api/a/upload', { file: '1.mp4', kind: 'video' });
    const noMark = await post('/api/a/publish', { title: 'T', video: '1.mp4' });
    const ok = await post('/api/a/publish', { title: 'T', video: '1.mp4', mark: '无需标记' });
    const down = await post('/api/b/upload', { file: '1.mp4' });
    const again = await post('/api/a/upload', { file: '1.mp4', kind: 'video' });
    const upload = await (await rawFetch(`${mock.url}/a/upload`)).text();
    const apply = await post('/api/jobs/j1/apply', { name: 'x', cv: 'y' });
    const recs = mock.records();
    check('COLLAB-1 mock sites: 甲站 is behind 扫码登录 until the human scans; publish asks for 「添加视频标记」 first and records exactly what went out; 乙站 is 暂时无法使用; a second upload of the same file is recorded as an overwrite; the job board takes 投递',
      wall.status === 401 && /扫码登录/.test(page) && /扫一扫/.test(page) && up.status === 200 && noMark.status === 409 && noMark.json.dialog === '添加视频标记'
      && ok.status === 200 && down.status === 503 && again.json.note && apply.status === 200
      && recs.some((r) => r.kind === 'publish' && r.site === 'a' && r.title === 'T' && r.mark === '无需标记') && recs.some((r) => r.kind === 'upload' && r.overwrote) && recs.some((r) => r.kind === 'apply' && r.job === 'j1'),
      JSON.stringify({ wall: wall.status, noMark: noMark.status, ok: ok.status, down: down.status, kinds: recs.map((r) => r.kind) }));
    check('COLLAB-2 the upload page has a hidden file box, another one in the cover dialog, title and description, and the 「添加视频标记」 dialog before 发布; only 127.0.0.1',
      /<input id="vf" type="file"[^>]*class="hide"/.test(upload) && /role="dialog" aria-label="设置封面"[\s\S]*type="file"[^>]*display:none/.test(upload) && /id="title"/.test(upload) && /id="desc"/.test(upload)
      && /aria-label="添加视频标记"/.test(upload) && mock.url.startsWith('http://127.0.0.1:') && Object.values(SITES).filter((s) => s.down).length === 1);
    mock.reset();

    // The fake model reads who asks and what kind of call it is from what the hub sends.
    const member = readCall({ messages: [{ role: 'system', content: 'You are 评测-发布, 发布.' }, { role: 'user', content: '（群「x」的任务板）用户的原始请求：发视频' }, { role: 'assistant', tool_calls: [{ function: { name: 'http_fetch', arguments: '{"url":"u"}' } }] }, { role: 'tool', content: '{"status":401}' }, { role: 'user', content: '（你干活时，用户又发来一条消息，已经先简短回过他了：）\n乙站不发了' }], tools: [{ function: { name: 'http_fetch' } }] });
    const review = readCall({ messages: [{ role: 'system', content: '你是群「x」的协调者「评测-主理人」。' }, { role: 'user', content: '参考图' }], tools: [{ function: { name: 'task_change' } }] });
    check('COLLAB-3 the fake model knows the bot (评测-发布 → 发布), a board task, its own steps, and the human\'s word pushed in mid-turn as a note (not a new task); the coordinator\'s one-look is a review',
      member.who === '发布' && member.kind === 'task' && member.step === 1 && member.notes.length === 1 && /乙站不发了/.test(member.notes[0]) && review.who === '主理人' && review.kind === 'review',
      JSON.stringify({ member: { who: member.who, kind: member.kind, step: member.step, notes: member.notes.length }, review: review.kind }));

    // The self-check proper: proofs, plants, clean runs.
    const sc = await runSelfCheck({ mock });
    check('COLLAB-4 on data: a clean trace passes all nine invariants',
      sc.proofs[0].ok, sc.proofs[0].detail);
    for (const inv of INVARIANTS) {
      const p = sc.proofs.find((x) => x.id === inv.id);
      check(`COLLAB-4 ${inv.id} (${inv.title}): changing only what it is there to catch makes it - and only it - fail`, p?.ok, p?.detail);
    }
    for (const p of sc.plants) {
      check(`COLLAB-5 planted ${p.plant} (${p.what}) in ${p.scenario}: ${p.landed ? 'it landed and' : 'it did not happen on this build (the product stopped it, or an earlier step did not get there);'} ${p.catches} ${p.landed ? 'catches it with evidence naming it' : 'is proven on data only'}`,
        p.ok, JSON.stringify({ landed: p.landed, caught: p.caught, detail: p.detail, errors: p.errors }));
    }
    // The plants no product guard stands in the way of must always land - else the harness, not the product, broke.
    const always = ['extra-work', 'contradict', 'remote-id', 'apply-unasked'];
    const missed = always.filter((n) => !sc.plants.find((p) => p.plant === n)?.landed);
    check('COLLAB-5 the plants nothing in the product stands in the way of (extra files, a contradiction, an id in the text, an application without a card) always land',
      !missed.length, `missed: ${missed.join(', ') || '-'}; all: ${sc.plants.map((p) => `${p.plant}:${p.landed}`).join(', ')}`);
    for (const r of sc.clean) {
      check(`COLLAB-6 ${r.id} runs to its end with the clean fake script (hubs, bots, group, the human's timeline, the evidence, clean-up) - its invariants are the product's result, reported, not asserted here`,
        !r.errors.length && !r.timedOut, JSON.stringify({ errors: r.errors, failed: [...r.checks, ...r.extra].filter((c) => !c.ok).map((c) => c.id) }));
    }
    check('COLLAB-7 six scenarios, nine invariants, each scenario from a real run',
      SCENARIOS.length === 6 && INVARIANTS.length === 9 && SCENARIOS.every((s) => s.from && s.timeline && s.brain && s.expect));
  } finally {
    await mock.close();
  }
}
