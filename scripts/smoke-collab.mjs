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

export async function collabSelfChecks({ check }) {
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
    const always = ['overwrite-upload', 'extra-work', 'contradict', 'remote-id', 'apply-unasked'];
    const missed = always.filter((n) => !sc.plants.find((p) => p.plant === n)?.landed);
    check('COLLAB-5 the plants nothing in the product stands in the way of (an overwrite, extra files, a contradiction, an id in the text, an application without a card) always land',
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
