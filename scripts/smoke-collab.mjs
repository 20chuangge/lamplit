// 1.5.65: the group-collaboration eval checks itself (scripts/eval-collab.mjs --fake --self-check).
// Not a test of the product's collaboration (that is the eval's own report): a test that the eval's
// nine detectors catch what they are there to catch, that a planted violation which lands is always
// caught, and that each of the six scenarios runs to its end on this build with the fake model.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import { startMockSites, SITES } from '../eval/collab/mocksites.mjs';
import { readCall } from '../eval/collab/fakemodel.mjs';
import { runSelfCheck } from '../eval/collab/selfcheck.mjs';
import { INVARIANTS, checkNoExtraWork } from '../eval/collab/invariants.mjs';
import { SCENARIOS } from '../eval/collab/scenarios.mjs';
import fs from 'node:fs';
import { snapshot, diff, restore, leftovers } from '../eval/collab/workspace.mjs';
import { runTimeline } from '../eval/collab/human.mjs';

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

    // The chain of scenario 6: one page at a time, the next code only on the page before it.
    const chain = mock.chain(5);
    const startPage = await (await rawFetch(chain.start)).text();
    const first = await (await rawFetch(`${mock.url}/chain/${chain.names[0]}`)).text();
    const lastPage = await (await rawFetch(`${mock.url}/chain/${chain.names[4]}`)).text();
    const guess = await rawFetch(`${mock.url}/chain/aaaaaaaa`);
    const reads = mock.records().filter((r) => r.kind === 'chain');
    check('COLLAB-8 scenario 6\'s chain: the start page names only the first page, each page only the next (random codes, new each run), the last says so, a guessed code is 404, every page read is recorded',
      startPage.includes(chain.names[0]) && !startPage.includes(chain.names[1]) && first.includes(chain.names[1]) && !first.includes(chain.names[2]) && /最后一页/.test(lastPage)
      && guess.status === 404 && reads.length === 2 && reads[0].i === 1 && new Set(chain.names).size === 5 && mock.chain(5).names[0] !== chain.names[0],
      JSON.stringify({ reads: reads.map((r) => r.i), guess: guess.status }));
    mock.reset();

    // A hub the run is pointed at: its workspace is put back after a scenario, whatever tool changed it.
    {
      const os = await import('node:os');
      const path = await import('node:path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-ws-'));
      const ws = path.join(tmp, 'ws');
      const W = (...x) => path.join(ws, ...x);
      fs.mkdirSync(W('old'), { recursive: true });
      fs.mkdirSync(W('uploads', 'd'), { recursive: true });
      fs.writeFileSync(W('old', 'a.md'), '原来的 a');
      fs.writeFileSync(W('old', 'b.md'), '原来的 b');
      fs.writeFileSync(W('old', 'c.md'), '原来的 c');
      fs.writeFileSync(W('uploads', 'd', '简历.md'), '评测用户');
      const lefts = leftovers(ws, ['评测用户', '桂花拿铁']);
      fs.writeFileSync(W('old', 'log.md'), '桂花拿铁 发过了');
      const lefts2 = leftovers(ws, ['评测用户', '桂花拿铁']);
      const snap = snapshot(ws, path.join(tmp, 'backup'));
      fs.writeFileSync(W('old', 'a.md'), '评测改过');
      fs.rmSync(W('old', 'b.md'));
      fs.mkdirSync(W('eval', '丙站'), { recursive: true });
      fs.writeFileSync(W('eval', '丙站', 'shot.png'), Buffer.alloc(10, 1));
      fs.writeFileSync(W('old', 'c.md'), '别的机器人改的');
      const d = diff(ws, snap);
      const done = restore(ws, snap, d, { backupDir: path.join(tmp, 'backup'), owner: (x) => (x === 'old/c.md' ? 'other' : 'eval') });
      check('COLLAB-9 a workspace not ours: an earlier run\'s file with the scenario\'s words is found (uploads aside); after the scenario a new file (a screenshot no bot named too) is removed and kept in the backup, a file written over and one removed are put back, what another bot did is left and said, the folders the run made are gone',
        lefts.length === 0 && lefts2.length === 1 && lefts2[0].path === 'old/log.md'
        && fs.readFileSync(W('old', 'a.md'), 'utf8') === '原来的 a' && fs.readFileSync(W('old', 'b.md'), 'utf8') === '原来的 b' && fs.readFileSync(W('old', 'c.md'), 'utf8') === '别的机器人改的'
        && !fs.existsSync(W('eval')) && fs.existsSync(path.join(tmp, 'backup', 'removed', 'eval', '丙站', 'shot.png'))
        && done.removed.length === 1 && done.restored.length === 1 && done.putBack.length === 1 && done.left.join() === 'old/c.md',
        JSON.stringify({ lefts: lefts.length, lefts2, done }));
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // After the human's last word the hubs get time to take it up (11-23: the run ended 0.2 s after the answer).
    {
      const trace = { events: [], human: [] };
      const t = Date.now();
      await runTimeline({ run: { trace } }, { steps: [{ id: 'answer', at: 0, do: () => { trace.human.push({ at: Date.now(), step: 'answer' }); } }], done: () => true, timeoutMs: 5000, settleMs: 600 });
      const waited = Date.now() - t;
      const trace2 = { events: [], human: [] };
      const t2 = Date.now();
      await runTimeline({ run: { trace: trace2 } }, { steps: [{ id: 'answer', at: 0, do: () => { trace2.human.push({ at: Date.now(), step: 'answer' }); trace2.events.push({ type: 'turn.start', turnId: 'x', at: Date.now() }); setTimeout(() => trace2.events.push({ type: 'turn.end', turnId: 'x', at: Date.now() }), 1200); } }], done: () => true, timeoutMs: 5000, settleMs: 300 });
      const waited2 = Date.now() - t2;
      // The quiet rule too (11-24: a late answer after a long quiet, and the run took itself as over 1 s later).
      const trace3 = { events: [], human: [] };
      const t3 = Date.now();
      const r3 = await runTimeline({ run: { trace: trace3 } }, { steps: [{ id: 'late', at: 0, delay: 500, do: () => { trace3.human.push({ at: Date.now(), step: 'late' }); } }], done: () => false, timeoutMs: 5000, quietMs: 100, settleMs: 600 });
      const waited3 = Date.now() - t3;
      check('COLLAB-10 a run whose work looks done still waits after the human\'s last word (settleMs), and for a turn that word started to end; so does a run that has been quiet a long time',
        waited >= 600 && waited < 2000 && waited2 >= 1200 && waited2 < 3000 && r3.quiet && waited3 >= 1100 && waited3 < 2500, JSON.stringify({ waited, waited2, waited3 }));
    }

    // The report's name: the local day the run started, then -2, -3 (11-24: 「collab-1.5.65-2026-11-2」).
    {
      const os = await import('node:os');
      const path = await import('node:path');
      const { writeReport, localDay } = await import('../eval/collab/report.mjs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-rep-'));
      const run = { version: '0.0.0', at: new Date(2026, 10, 23, 23, 58).toISOString(), mode: 'real', model: '', app: '', plant: [], currency: 'CNY', results: [] };
      const names = [writeReport(run, { dir }), writeReport(run, { dir })].map((w) => path.basename(w.md));
      fs.rmSync(dir, { recursive: true, force: true });
      check('COLLAB-12 a report is named by the local day its run started, a second one that day gets -2 after the whole date',
        names[0] === 'collab-0.0.0-2026-11-23.md' && names[1] === 'collab-0.0.0-2026-11-23-2.md' && localDay(run.at) === '2026-11-23', JSON.stringify(names));
    }

    // The material and what counts (11-23 second real run): real media, deliverables are what reaches the
    // human, and a question the script never answers is the script's gap.
    {
      const fx = (n) => fs.readFileSync(new URL(`../eval/collab/fixtures/${n}`, import.meta.url));
      const jpg = fx('cover.jpg');
      const mp4 = fx('clip.mp4');
      const png = fx('ref.png');
      const media = jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.at(-2) === 0xff && jpg.at(-1) === 0xd9 && mp4.toString('latin1', 4, 8) === 'ftyp' && mp4.includes('avc1') && png.toString('latin1', 1, 4) === 'PNG'
        && [jpg, mp4, png].every((b) => b.length > 2000 && b.length < 64 * 1024);
      const base = { t0: 0, t1: 10, bots: [{ id: 'b1', name: '评测-文案' }], events: [], botChats: [], expect: { maxDeliverables: 1 },
        files: [{ hub: 'A', path: '评测-协作/r/s/交付/标题.md', mtime: 5 }, { hub: 'A', path: '评测-协作/r/s/笔记/想法.md', mtime: 5 }, { hub: 'A', path: 'pages/预览.html', mtime: 5 }] };
      const said = { ...base, groupMessages: [{ kind: 'assistant', from: 'b1', text: '标题在 交付/标题.md' }] };
      const i8 = checkNoExtraWork(said);
      const { SCENARIOS: all } = await import('../eval/collab/scenarios.mjs');
      const s2 = all.find((x) => x.id === 's2-jobs');
      const gapTrace = { t0: 0, t1: 10, bots: [{ id: 'b2', name: '评测-求职' }], posts: [], files: [], groupMessages: [], botChats: [], siteNames: {}, human: [{ at: 1, kind: 'group', text: '投吧' }],
        events: [{ hub: 'A', at: 3, type: 'tool.call', name: 'tell_human', botId: 'b2', callId: 'c1', args: { text: '简历太薄，补这 4 条：工作经历、项目……', blocking: false } }] };
      const gap = s2.extra(gapTrace)[0];
      const answered = s2.extra({ ...gapTrace, human: [...gapTrace.human, { at: 5, kind: 'group', text: '没有更多了' }] })[0];
      check('COLLAB-11 the media are real and small (a JPEG cover, an MP4 clip, a PNG); I8 counts what a bot names to the human and the pages it published, not its own notes; work stopped on a question the script never answers is a gap in the script (➖), answered and still not done is a fail',
        media && i8.ok === false && /2 个文件/.test(i8.note) && gap.skipped === true && /剧本缺口/.test(gap.note) && answered.ok === false && !answered.skipped,
        JSON.stringify({ media, i8: i8.note, gap: gap.note, answered: answered.ok }));
    }

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
