// The scripted human of the group-collaboration eval. It does what the user did in real use, through
// the hub's own APIs (the ones the page and the phone call): writes in the group or straight to a
// member, sends bursts, uploads files and folders late, answers or refuses cards, finishes a takeover,
// answers a question late on purpose, changes its mind.
//
// A scenario's timeline is a list of steps; each fires once (or each time, with repeat) when its
// trigger matches: an event the hubs sent (a takeover card went up, a member started its task, a
// question was asked), another step having run, or a time since the start - the fallback.
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * h = makeHuman(run): run = { hubs: {name: hub}, group: {hub, id}, bots: [{hub, id, name, short}], mock, events, trace, speed, log }
 * speed: how long the human takes to react, as a factor (fake runs are quick, real runs human-paced).
 */
export function makeHuman(run) {
  const { trace } = run;
  const note = (row) => { const r = { at: Date.now(), ...row }; trace.human.push(r); run.log?.(`[human] ${row.kind}${row.to ? `→${row.to}` : ''} ${String(row.text || row.ref || '').slice(0, 80)}`); return r; };
  const botOf = (short) => {
    const b = run.bots.find((x) => x.short === short || x.name === short);
    if (!b) throw new Error(`no bot ${short}`);
    return b;
  };
  const hubOf = (name) => run.hubs[name];
  // A card on the other machine is answered through the first one's 待办 inbox, as the app does.
  const answerCard = (card, body) => {
    const hub = hubOf(card.hub);
    return hub.via ? hub.answer(card.approvalId, body.decision, body.note ? { note: body.note } : body.edits ? { edits: body.edits } : {}) : hub.api.post(`/api/approvals/${encodeURIComponent(card.approvalId)}`, body);
  };
  const h = {
    run,
    sleep: (ms) => sleep(ms * (run.speed || 1)),
    /** Write in the group (as the page does). */
    async group(text, { attachments, step } = {}) {
      const g = run.group;
      const res = await hubOf(g.hub).api.post(`/api/groups/${encodeURIComponent(g.id)}/message`, { text, ...(attachments?.length ? { attachments } : {}) });
      note({ kind: 'group', text, attachments: attachments?.map((a) => a.path), step, turnId: res?.turnId, routed: res });
      return res;
    },
    /** Write straight to one member, in its own chat (on its own machine). */
    async direct(short, text, { step } = {}) {
      const b = botOf(short);
      const res = await hubOf(b.hub).api.post(`/api/bots/${encodeURIComponent(b.id)}/message`, { text });
      note({ kind: 'direct', to: b.name, botId: b.id, hub: b.hub, text, step, turnId: res?.turnId, routed: res });
      return res;
    },
    /** Upload one file (bytes or text) to a hub, as the chat's attach button does; returns the attachment. */
    async upload(name, content, { hub = run.group.hub } = {}) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      const res = await hubOf(hub).api.call('/api/uploads', { method: 'POST', raw: bytes, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } });
      trace.uploads.push({ hub, path: res.path, sha: sha(bytes) });
      note({ kind: 'upload', ref: res.path });
      return { path: res.path };
    },
    /** Upload a folder {rel: content} (1.5.64 folder upload); returns the attachment (the folder). */
    async uploadFolder(name, files, { hub = run.group.hub } = {}) {
      const api = hubOf(hub).api;
      const folder = await api.post('/api/uploads/folder', { name });
      for (const [rel, content] of Object.entries(files)) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        const res = await api.call('/api/uploads', { method: 'POST', raw: bytes, headers: { 'content-type': 'application/octet-stream', 'x-folder': encodeURIComponent(folder.path), 'x-rel-path': encodeURIComponent(rel), 'x-file-name': encodeURIComponent(rel.split('/').pop()) } });
        trace.uploads.push({ hub, path: res.path, sha: sha(bytes) });
      }
      trace.uploadDirs = [...(trace.uploadDirs || []), { hub, path: folder.path }];
      note({ kind: 'upload', ref: `${folder.path}/（${Object.keys(files).length} 个文件）` });
      return { path: folder.path };
    },
    /** Answer an approval card. */
    async approve(card, { edits, step } = {}) {
      await answerCard(card, { decision: 'approve', ...(edits ? { edits } : {}) }).catch((err) => run.log?.(`[human] approve failed: ${err.message}`));
      note({ kind: 'approve', ref: `${card.tool} ${String(JSON.stringify(card.args || '')).slice(0, 80)}`, step, approvalId: card.approvalId });
    },
    async deny(card, reason = '', { step } = {}) {
      await answerCard(card, { decision: 'deny', note: reason }).catch((err) => run.log?.(`[human] deny failed: ${err.message}`));
      note({ kind: 'deny', ref: `${card.tool} ${String(JSON.stringify(card.args || '')).slice(0, 80)}`, text: reason, step, approvalId: card.approvalId });
    },
    /** Finish a takeover: scan the QR code on the mock site (the human's phone does that). */
    async scan(site, { step } = {}) {
      run.mock.login(site);
      note({ kind: 'takeover', ref: `扫码登录 ${site}`, step });
    },
    async restartHub(name, { step } = {}) {
      const hub = hubOf(name);
      if (!hub.restart) throw new Error(`hub ${name} cannot be restarted from here (not a test hub)`);
      trace.restarts.push({ hub: name, at: Date.now() });
      note({ kind: 'restart', ref: name, step });
      await hub.restart();
    },
    /**
     * The other machine goes away. Reached through the first hub (peer.mjs): a test hub of this run is
     * switched off ('cut'); any other is only cut off from the first hub for a while ('pause').
     */
    async stopHub(name, { step } = {}) {
      const hub = hubOf(name);
      if (hub.via && hub.drop !== 'cut') {
        note({ kind: 'hub-down', ref: `${name}（第一台暂停连接）`, step });
        await hub.pause(300);
        return;
      }
      trace.restarts.push({ hub: name, at: Date.now() });
      note({ kind: 'hub-down', ref: name, step });
      await (hub.via ? hub.testHub : hub).stop();
    },
    async startHub(name, { step } = {}) {
      const hub = hubOf(name);
      if (hub.via && hub.drop !== 'cut') {
        note({ kind: 'hub-up', ref: `${name}（第一台恢复连接）`, step });
        await hub.pause(0);
        return;
      }
      note({ kind: 'hub-up', ref: name, step });
      await (hub.via ? hub.testHub : hub).restart({ hard: false });
    },
    botOf,
  };
  return h;
}

/**
 * Run a timeline until done() says so or the time is up. Steps:
 *   { id, on: (event, h) => bool | event-like, after: 'stepId', at: ms, delay: ms, repeat: bool, do: async (h, event) => {} }
 * on: fires on a recorded event (checked as they arrive); at: ms after the start (also the fallback of
 * an `on` step that never fired, when `orAt` is set); after: once another step has run (+delay).
 * Approval cards no step takes are answered by policy(card) -> 'approve' | 'deny' | null, after cardDelay.
 * settleMs: after the human's last word the hubs get this long to take it up, and any turn it started must end,
 * before done() may end the run (11-23 real run: done() was already true while the human's answer to the
 * video mark was on its way; the run ended 0.2 s after it, and what the answer would have started never ran).
 */
export async function runTimeline(h, { steps, policy, cardDelay = 1000, done, timeoutMs, speed = 1, quietMs = 0, settleMs = 0 }) {
  let lastCount = -1;
  let lastEventAt = Date.now();
  let quiet = false;
  const run = h.run;
  const t0 = Date.now();
  const fired = new Map(); // id -> count
  const ran = new Map();   // id -> time it finished
  const busy = new Set();
  const handledCards = new Set();
  let seen = 0;
  const errors = [];
  const fire = (step, ev) => {
    if (busy.has(step.id) && !step.repeat) return;
    fired.set(step.id, (fired.get(step.id) || 0) + 1);
    busy.add(step.id);
    const go = async () => {
      if (step.delay) await sleep(step.delay * speed);
      try { await step.do(h, ev); } catch (err) { errors.push(`${step.id}: ${err.message}`); run.log?.(`[human] step ${step.id} failed: ${err.message}`); }
      ran.set(step.id, Date.now());
      busy.delete(step.id);
    };
    go();
  };
  for (;;) {
    const now = Date.now();
    const events = run.trace.events;
    // Event-triggered steps and cards, over what arrived since the last look.
    for (; seen < events.length; seen += 1) {
      const ev = events[seen];
      for (const step of steps) {
        if (!step.on || (!step.repeat && fired.get(step.id))) continue;
        if (step.max && (fired.get(step.id) || 0) >= step.max) continue;
        let hit = false;
        try { hit = step.on(ev, h); } catch { hit = false; }
        if (hit) fire(step, ev);
      }
      if (ev.type === 'approval.request' && ev.approvalId && !handledCards.has(ev.approvalId)) {
        handledCards.add(ev.approvalId);
        const taken = steps.some((s) => s.card && s.card(ev, h));
        if (!taken && policy) {
          const decision = policy(ev, h);
          if (decision) {
            sleep(cardDelay * speed).then(() => (decision === 'deny' ? h.deny(ev, '评测：这一步不在任务范围内') : h.approve(ev)));
          }
        }
      }
    }
    // Time and order. `at` is as written (a burst is a burst at any speed); orAt comes scaled by the caller.
    for (const step of steps) {
      if (fired.get(step.id)) continue;
      if (step.at != null && !step.on && now - t0 >= step.at) fire(step);
      else if (step.on && step.orAt != null && now - t0 >= step.orAt) { run.log?.(`[human] ${step.id}: event did not come, going by the clock`); fire(step); }
      else if (step.after && ran.has(step.after) && now - ran.get(step.after) >= (step.afterDelay || 0) * speed) fire(step);
    }
    let finished = false;
    try { finished = Boolean(await done(h)); } catch { finished = false; }
    const spoke = run.trace.human.reduce((m, x) => Math.max(m, x.at || 0), 0);
    if (finished && !busy.size && now - spoke >= settleMs && !openTurns(events, spoke)) break;
    // Nothing more will happen: every step that must run ran, no turn is open, no card waits, and the hubs
    // have been quiet a while (a run whose board never came - the scenario's checks say what is missing).
    if (events.length !== lastCount) { lastCount = events.length; lastEventAt = now; }
    // The human's last word counts as something happening (11-24: after a long quiet the late answer came,
    // and the run took itself as over 1 s later, before anything could take the answer up).
    if (quietMs && now - lastEventAt > quietMs && now - spoke >= settleMs && !busy.size && steps.every((s) => s.repeat || s.optional || fired.get(s.id)) && !openTurns(events) && !openCards(events)) {
      run.log?.(`[human] quiet for ${Math.round(quietMs / 1000)} s: taking the run as over`);
      quiet = true;
      break;
    }
    if (now - t0 > timeoutMs) { errors.push(`时间到了（${Math.round(timeoutMs / 1000)} 秒）还没做完`); break; }
    await sleep(200);
  }
  return { errors, quiet, fired: Object.fromEntries(fired), timedOut: errors.some((e) => e.startsWith('时间到了')) };
}

/** A turn started (at or after `since`) and not ended (a hub that went down ended its own). */
function openTurns(events, since = 0) {
  const open = new Map();
  for (const e of events) {
    if (e.type === 'turn.start' && e.turnId && (e.at || 0) >= since) open.set(`${e.hub}|${e.turnId}`, e.hub);
    else if (e.type === 'turn.end' && e.turnId) open.delete(`${e.hub}|${e.turnId}`);
  }
  return open.size > 0;
}
function openCards(events) {
  const asked = new Set(events.filter((e) => e.type === 'approval.request' && e.approvalId).map((e) => e.approvalId));
  for (const e of events) if (e.type === 'approval.resolved' || e.type === 'approval.decided') asked.delete(e.approvalId);
  return asked.size > 0;
}
