// One roster (1.5.42 第三步「一个花名册」): the bots on the human's other machines
// sit in this window's sidebar, grouped by machine, and are talked to from here.
//
// This hub only passes things on. A remote bot's chat stays on its own machine
// (nothing is copied here for keeping); this hub reads it from there, hands the
// human's message over and brings the bot's progress back as it happens. It
// talks to the other machine exactly as a group's remote member does: through
// the peer link (peers.call / peers.json) with that machine's own token, and
// every call it passes on is marked, so no machine passes it on again.
//
// Only the human may drive a bot over there through this hub: the routes are
// "authority" routes (auth.mjs isAuthorityRequest), like answering a card.
//
//   roster.list({fresh})            -> [{machine, online, bots, attention, queued}]
//   roster.send(peer, botId, msg)   -> {turnId} (throws PEER_UNREACHABLE when it is off)
//   roster.deliver({...})           -> {turnId} | {queued, queueId, message}
//   roster.outbox.list() / remove(id) / flush()
//   roster.pipeStream(peer, botId, req, res)   that bot's events, live, as SSE

import fsp from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './store.mjs';

/** What the human reads when a message waits for a machine that is off. */
export const OFFLINE_WORDS = '它那台电脑现在连不上，开机后我接着做';
/** What a chat says when the link to its machine drops mid-turn. */
export const LINK_DOWN_WORDS = '连不上了，连上后接着看结果';
/** The header a hub sets on a call it passes on (auth.mjs VIA_HEADER). */
const VIA = 'x-lamplit-via';

/** A bot id as the routes take it: no slashes, no dots-only parts. */
export function cleanBotId(raw) {
  let id = String(raw || '');
  try { id = decodeURIComponent(id); } catch { return ''; }
  return /^[\w.-]{1,80}$/.test(id) && !/^\.+$/.test(id) ? id : '';
}

/** Events that belong to the machine over there, not to the chat on screen here. */
const NOT_PASSED = new Set(['ui.command', 'settings.changed', 'roster.changed', 'feishu.changed', 'attention.changed', 'usage.alert', 'balance.low', 'machine.low', 'inbox.changed']);

/**
 * One event from that machine's stream as this window sees it: only the
 * chosen bot's, tagged with the machine, its id made "id@machine" (the same
 * name a group's remote member has). Anything else is dropped (null).
 */
export function tagRemoteEvent(ev, machine, botId) {
  if (!ev || typeof ev !== 'object' || NOT_PASSED.has(ev.type)) return null;
  if (ev.to) return null; // a phone step meant for one device over there
  if (ev.botId !== botId) return null;
  return { ...ev, botId: `${botId}@${machine}`, machine };
}

/**
 * A group's event from that machine (1.5.43): only that group's, its id made
 * "id@machine". Its members keep their ids there; the page reads them against
 * the group's own member list, never as this machine's bots.
 */
export function tagRemoteGroupEvent(ev, machine, groupId) {
  if (!ev || typeof ev !== 'object' || NOT_PASSED.has(ev.type)) return null;
  if (ev.to) return null;
  if (ev.groupId !== groupId) return null;
  return { ...ev, groupId: `${groupId}@${machine}`, machine };
}

/**
 * A bot's avatar from another machine, safe to draw here (1.5.43): a known
 * kind of shape, a colour, and a picture only through this hub - never an
 * address the other machine names. Anything else is dropped.
 */
export function safeAvatar(raw, machine, botId) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (typeof raw.shape === 'string' && /^[a-z][a-z-]{0,23}$/.test(raw.shape)) out.shape = raw.shape;
  if (typeof raw.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.color)) out.color = raw.color;
  const id = cleanBotId(botId);
  if ((raw.hasImage || raw.imageUrl) && id) {
    out.hasImage = true;
    out.imageUrl = `/api/peers/${encodeURIComponent(machine)}/avatar/${encodeURIComponent(id)}`;
  }
  return Object.keys(out).length ? out : null;
}

/** How long a machine's answer is kept: 15 s; 3 s while something there works or waits (1.5.62). */
export const ROSTER_KEEP_MS = 15000;
export const ROSTER_QUICK_MS = 3000;
/**
 * One missed answer is not "off" (1.5.79). A machine at work is asked every 3 s and given 5 s to answer; one
 * slow answer marked it 离线 and wiped its bots' status until the next ask - 「执行任务时云服务器上的 bot 有时连接
 * 不上，很快自己恢复」. It stays as it was last seen until the misses span this long.
 */
export const ROSTER_GRACE_MS = 25000;
/** After a miss: the row to show - the last good one (within the grace), or off. */
export function rowAfterMiss(last, now = Date.now(), graceMs = ROSTER_GRACE_MS) {
  if (last?.online && Number.isFinite(last.okAt) && now - last.okAt < graceMs) return { ...last, at: now, misses: (last.misses || 0) + 1 };
  return null;
}
/** Something on that machine is under way or waits for the human: worth asking again soon. */
export function rosterBusy(row) {
  return Boolean(row?.online) && Object.values(row?.attention || {}).some((i) => i && (i.working || i.needsYou || i.asking));
}

const isUnreachable = (err) => err?.code === 'PEER_UNREACHABLE' || err?.code === 'PEER_PROXY_ERROR';

/** What an older Lamplit (before 1.5.64) takes in one message. */
const OLD_ATTACH_MAX = 10;
const NOTE_LINES = 30;

/** A folder an older Lamplit could not keep: where its files went instead. */
export function flatNote(machine, folderName, flat) {
  const lines = flat.slice(0, NOTE_LINES).map((f) => `- ${f.path}（原来是 ${folderName}/${f.rel}）`);
  if (flat.length > NOTE_LINES) lines.push(`…还有 ${flat.length - NOTE_LINES} 个，也在 ${String(flat[0]?.path || 'uploads/').replace(/[^/]+$/, '')} 里`);
  return `（文件夹「${folderName}」：「${machine}」上的 Lamplit 版本较旧，不能保留文件夹结构，${flat.length} 个文件平放在共享工作区里：\n${lines.join('\n')}）`;
}

/** Attachments an older Lamplit could not take in one message: named in the text. */
export function overflowNote(machine, rest) {
  return `（「${machine}」上的 Lamplit 版本较旧，一条消息最多收 ${OLD_ATTACH_MAX} 个附件；另外 ${rest.length} 个也已传到共享工作区：\n${rest.map((a) => `- ${a.path}`).join('\n')}）`;
}

export function createRoster({ peers, bus = null, cacheFile, outboxFile, readUpload = null, listUpload = null, audit = async () => {}, selfName = () => '', streamIdleMs = 45000 } = {}) {
  // machine -> {at, online, bots, attention}; bots outlive a machine going away.
  const live = new Map();
  let known = {}; // machine -> {bots:[{id,name,role,primary}]} kept on disk for machines that are off
  let loaded = false;
  let inflight = null;
  let queue = [];

  async function load() {
    if (loaded) return;
    loaded = true;
    const raw = await readJson(cacheFile, {}).catch(() => ({}));
    known = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const q = await readJson(outboxFile, []).catch(() => []);
    queue = Array.isArray(q) ? q.filter((i) => i && i.id && i.machine && typeof i.text === 'string') : [];
  }
  const saveKnown = () => writeJsonAtomic(cacheFile, known).catch(() => {});
  const saveQueue = async () => {
    await writeJsonAtomic(outboxFile, queue).catch(() => {});
    try { await fsp.chmod(outboxFile, 0o600); } catch { /* Windows */ }
  };

  // createdAt (1.5.61): the sidebar lists a machine's bots in the order they were made, never by the latest message.
  const slimBot = (b) => ({ id: String(b.id), name: String(b.name || b.id).slice(0, 80), role: String(b.role || '').slice(0, 200), primary: Boolean(b.primary), ...(b.createdAt ? { createdAt: String(b.createdAt).slice(0, 40) } : {}), ...(b.avatar ? { avatar: b.avatar } : {}) });
  const slimPreview = (p) => (p && typeof p === 'object' ? { preview: { ts: String(p.ts || ''), role: String(p.role || ''), text: String(p.text || '').slice(0, 200) } } : {});
  /** A group of that machine: its name and members (their ids there), the coordinator, the last line. */
  const slimGroup = (g, machine) => ({
    id: String(g.id),
    name: String(g.name || '未命名群组').slice(0, 80),
    coordinatorId: String(g.coordinatorId || ''),
    ...(g.createdAt ? { createdAt: String(g.createdAt).slice(0, 40) } : {}),
    members: (Array.isArray(g.members) ? g.members : []).filter((m) => m && typeof m === 'object' && m.id).slice(0, 12).map((m) => {
      const avatar = safeAvatar(m.avatar, machine, m.id);
      return { id: String(m.id), name: String(m.name || m.id).slice(0, 80), role: String(m.role || '').slice(0, 200), ...(avatar ? { avatar } : {}) };
    }),
    ...slimPreview(g.preview),
  });

  async function askOne(name) {
    const peer = peers.find(name);
    if (!peer) return null;
    try {
      // How long its list took to come: the machine menu's latency, from a request made anyway (1.5.61).
      const asked = Date.now();
      let ms = 0;
      const [data, att, grp] = await Promise.all([
        peers.json(peer, 'GET', '/api/bots', { timeoutMs: 5000 }).then((d) => { ms = Date.now() - asked; return d; }),
        peers.json(peer, 'GET', '/api/attention', { timeoutMs: 5000 }).catch(() => null),
        peers.json(peer, 'GET', '/api/groups', { timeoutMs: 5000 }).catch(() => []),
      ]);
      const list = (Array.isArray(data) ? data : data?.bots || []).filter((b) => b && b.id);
      // Each bot's own face (1.5.43), drawn safely here.
      const bots = list.map((b) => ({ ...slimBot({ ...b, avatar: safeAvatar(b.avatar, name, b.id) }), ...slimPreview(b.preview) }));
      const groups = (Array.isArray(grp) ? grp : grp?.groups || []).filter((g) => g && g.id).slice(0, 50).map((g) => slimGroup(g, name));
      // The status lines (1.5.40) of that machine's bots and groups, under their names here.
      const attention = {};
      for (const [key, item] of Object.entries(att?.items || {})) {
        const m = /^(bot|group):(.+)$/.exec(key);
        if (!m || !item || typeof item !== 'object') continue;
        if (m[1] === 'bot' ? bots.some((b) => b.id === m[2]) : groups.some((g) => g.id === m[2])) attention[`${m[1]}:${m[2]}@${name}`] = item;
      }
      const now = Date.now();
      // That machine's own warnings (1.5.79): a low balance or no room left over there is said here too.
      const notices = (Array.isArray(att?.notices) ? att.notices : []).slice(0, 4).map((t) => String(t).slice(0, 300)).filter(Boolean);
      const row = { at: now, online: true, bots, groups, attention, ms, seenAt: now, okAt: now, notices };
      if (ms > 3000) console.warn(`[roster] 「${name}」 answered in ${ms} ms`);
      live.set(name, row);
      const slim = { bots: bots.map(slimBot), groups: groups.map(({ preview, ...g }) => g) };
      // When it was last seen is kept too (「离线 · 上次在线 …」 after a restart), written at most every 10 minutes.
      const { seenAt: seenBefore = 0, ...knownBefore } = known[name] || {};
      if (JSON.stringify(knownBefore) !== JSON.stringify(slim) || now - seenBefore > 10 * 60 * 1000) { known[name] = { ...slim, seenAt: now }; void saveKnown(); }
      return row;
    } catch (err) {
      // Only a slow answer gets the grace: a machine that refuses the connection is off now.
      const slow = /timeout|timed out|aborted/i.test(String(err?.message || err));
      const kept = slow ? rowAfterMiss(live.get(name)) : null;
      console.warn(`[roster] 「${name}」 did not answer (${String(err?.message || err).slice(0, 120)})${kept ? `; miss ${kept.misses}, shown as it was` : '; shown as off'}`);
      if (kept) { live.set(name, kept); return kept; }
      const was = live.get(name) || known[name] || {};
      // Their last lines stay (1.5.43 test: its bots dropped out of 「最近」 while it was off).
      const seenAt = live.get(name)?.seenAt || known[name]?.seenAt || 0;
      const row = { at: Date.now(), online: false, bots: (was.bots || []).map((b) => ({ ...slimBot(b), ...slimPreview(b.preview) })), groups: was.groups || [], attention: {}, seenAt };
      live.set(name, row);
      return row;
    }
  }

  /**
   * Every other machine, with its bots - the ones it had when it is off.
   * What is asked is kept 15 s; 3 s for a machine where something works or
   * waits, or for everyone when the page says something may start soon
   * (`quick`: the human just sent something) - a 10 s job there lit up
   * nothing at 15-20 s (1.5.62).
   */
  async function list({ fresh = false, quick = false } = {}) {
    await load();
    const names = peers.list().map((p) => p.name);
    const maxAge = (row) => (quick || rosterBusy(row) ? ROSTER_QUICK_MS : ROSTER_KEEP_MS);
    const stale = names.filter((n) => fresh || !live.has(n) || Date.now() - live.get(n).at > maxAge(live.get(n)));
    if (stale.length) {
      if (!inflight || fresh) inflight = Promise.all(stale.map(askOne)).finally(() => { inflight = null; });
      await inflight;
    }
    const out = names.map((machine) => {
      const row = live.get(machine) || { online: false, bots: (known[machine]?.bots || []), groups: known[machine]?.groups || [], attention: {}, seenAt: known[machine]?.seenAt || 0 };
      const queued = queue.filter((i) => i.machine === machine).length;
      // How this machine reaches it now (the way its last answer came, and how long that took), or when it was last seen (1.5.61, the machine menu).
      const way = row.online ? peers.way?.(machine) || null : null;
      const reach = row.online ? { ...(way ? { way } : {}), ...(row.ms ? { ms: row.ms } : {}) } : { ...(row.seenAt ? { seenAt: new Date(row.seenAt).toISOString() } : {}) };
      return { machine, online: Boolean(row.online), bots: row.bots, groups: row.groups || [], attention: row.attention || {}, ...(row.notices?.length ? { notices: row.notices } : {}), ...reach, ...(queued ? { queued } : {}) };
    });
    // A machine that is back gets what waited for it.
    if (out.some((m) => m.online && m.queued)) void flush().catch(() => {});
    return out;
  }

  const isOnline = (machine) => Boolean(live.get(machine)?.online);
  const primaryOf = (machine) => (live.get(machine)?.bots || known[machine]?.bots || []).find((b) => b.primary)?.id || '';

  /**
   * Hand the human's message (or a bot's hand-off) to a bot over there: its
   * attachments go to that machine first and are named by their path there.
   * Only text, attachments and a hand-off's limits go over.
   */
  async function send(peer, botId, { text, attachments = [], handoff = null, groupId = '', tag = '' } = {}) {
    if (!botId && !groupId) {
      // A hand-off to "that machine" (machine_switch): its main assistant.
      const data = await peers.json(peer, 'GET', '/api/bots', { timeoutMs: 8000 });
      botId = (Array.isArray(data) ? data : data?.bots || []).find((b) => b.primary)?.id || '';
      if (!botId) throw Object.assign(new Error(`「${peer.name}」上没有主助理`), { code: 'BOT_NOT_FOUND' });
    }
    const { carried, notes } = await carryAttachments(peer, attachments, { tag });
    let words = String(text || '') + (notes.length ? `${text ? '\n\n' : ''}${notes.join('\n\n')}` : '');
    const post = (list) => (groupId
      ? peers.json(peer, 'POST', `/api/groups/${encodeURIComponent(groupId)}/message`, {
        body: { text: words, ...(list.length ? { attachments: list } : {}) },
        headers: { [VIA]: '1' },
        timeoutMs: 20000,
      }).then((sent) => ({ ...sent, groupId }))
      : peers.json(peer, 'POST', `/api/bots/${encodeURIComponent(botId)}/message`, {
        body: { text: words, ...(list.length ? { attachments: list } : {}), ...(handoff ? { handoff } : {}) },
        headers: { [VIA]: '1' },
        timeoutMs: 20000,
      }).then((out) => ({ ...out, botId })));
    try {
      return await post(carried);
    } catch (err) {
      // An older Lamplit takes 10 attachments at most (1.5.64 takes 20): the rest are named in the text.
      if (err?.code !== 'TOO_MANY_ATTACHMENTS' || carried.length <= OLD_ATTACH_MAX) throw err;
      words += `${words ? '\n\n' : ''}${overflowNote(peer.name, carried.slice(OLD_ATTACH_MAX))}`;
      return post(carried.slice(0, OLD_ATTACH_MAX));
    }
  }

  /**
   * The attachments, onto that machine first (1.5.64: folders too). A file goes
   * as it always did; a folder keeps its layout there (POST /api/uploads/folder,
   * then each file with x-folder / x-rel-path), one item in the message. An
   * older Lamplit there has no folder uploads (404): its files go flat into
   * that day's uploads, named in a note in the text instead.
   * Progress, for the page's 「正在传 12/40…」: {type:'peer.upload', tag, done, total}.
   */
  async function carryAttachments(peer, attachments, { tag = '' } = {}) {
    const carried = [];
    const notes = [];
    if (!readUpload || !attachments.length) return { carried, notes };
    const plan = [];
    for (const a of attachments) plan.push({ a, folder: listUpload ? await listUpload(a.path) : null });
    const total = plan.reduce((n, p) => n + (p.folder ? p.folder.files.length : 1), 0);
    let done = 0;
    let told = 0;
    const tell = () => {
      // Not every file of a big folder: a line a second or so, and the last one.
      if (total < 2 || (done > 0 && done < total && Date.now() - told < 700)) return;
      told = Date.now();
      bus?.emit({ type: 'peer.upload', machine: peer.name, ...(tag ? { tag } : {}), done, total });
    };
    const upload = async (rel, extra = {}) => {
      const file = await readUpload(rel);
      const up = await peers.json(peer, 'POST', '/api/uploads', { raw: file.bytes, headers: { 'x-file-name': encodeURIComponent(file.name), ...extra, [VIA]: '1' }, timeoutMs: 120000 });
      done += 1;
      tell();
      return up;
    };
    tell();
    for (const { a, folder } of plan) {
      if (!folder) {
        const up = await upload(a.path);
        if (up?.path) carried.push({ path: up.path });
        continue;
      }
      const base = String(a.path).replace(/\/$/, '');
      let made = null;
      try {
        made = await peers.json(peer, 'POST', '/api/uploads/folder', { body: { name: folder.name }, headers: { [VIA]: '1' }, timeoutMs: 20000 });
      } catch (err) {
        if (err?.code !== 'NOT_FOUND') throw err;
      }
      if (made?.path) {
        for (const f of folder.files) await upload(`${base}/${f.rel}`, { 'x-folder': encodeURIComponent(made.path), 'x-rel-path': encodeURIComponent(f.rel) });
        carried.push({ path: made.path });
        continue;
      }
      // An older Lamplit there: flat, with a note.
      const flat = [];
      for (const f of folder.files) {
        const up = await upload(`${base}/${f.rel}`);
        if (up?.path) flat.push({ rel: f.rel, path: up.path });
      }
      notes.push(flatNote(peer.name, folder.name, flat));
    }
    return { carried, notes };
  }

  /** Send now, or keep it here until that machine answers (it is off). */
  async function deliver({ machine, botId, groupId = '', text, attachments = [], from = null, tag = '' }) {
    await load();
    const peer = peers.find(machine);
    if (!peer) throw Object.assign(new Error('没有这台机器（可能已经从「机器」里删掉了）'), { code: 'PEER_NOT_FOUND' });
    const handoff = from ? { depth: 1, chain: [from.botId || 'bot'], budgetLeft: 6, from: { bot: from.name || '', machine: selfName() } } : null;
    // Messages already waiting go first: their order is the human's order.
    if (!queue.some((i) => i.machine === peer.name)) {
      try {
        return await send(peer, botId, { text, attachments, handoff, groupId, tag });
      } catch (err) {
        if (!isUnreachable(err)) throw err;
      }
    }
    if (queue.length >= 100 || queue.filter((i) => i.machine === peer.name && i.botId === botId && (i.groupId || '') === groupId).length >= 20) {
      throw Object.assign(new Error(`「${peer.name}」连不上，等它的消息已经太多了，先别再发`), { code: 'OUTBOX_FULL' });
    }
    const item = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      machine: peer.name,
      botId: botId || '',
      ...(groupId ? { groupId } : {}),
      text: String(text || ''),
      ...(attachments.length ? { attachments: attachments.map((a) => ({ path: a.path })) } : {}),
      ...(from ? { from: { botId: String(from.botId || ''), name: String(from.name || '') } } : {}),
      at: new Date().toISOString(),
    };
    queue.push(item);
    await saveQueue();
    if (live.has(peer.name)) live.get(peer.name).online = false;
    await audit({ kind: 'peer.queued', machine: peer.name, botId: item.botId, queueId: item.id });
    bus?.emit({ type: 'peer.outbox', machine: peer.name, botId: item.botId ? `${item.botId}@${peer.name}` : '', ...(groupId ? { groupId: `${groupId}@${peer.name}` } : {}), queueId: item.id, state: 'queued' });
    void flush().catch(() => {});
    return { queued: true, queueId: item.id, message: OFFLINE_WORDS, machine: peer.name, botId: item.botId, ...(groupId ? { groupId } : {}) };
  }

  let flushing = null;
  /** Send what waits, in order, per machine; a machine still off keeps its messages. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await load();
      let sent = 0;
      const off = new Set();
      for (const item of [...queue]) {
        if (off.has(item.machine)) continue;
        const peer = peers.find(item.machine);
        if (!peer || peer.name !== item.machine) { off.add(item.machine); continue; }
        try {
          const handoff = item.from ? { depth: 1, chain: [item.from.botId || 'bot'], budgetLeft: 6, from: { bot: item.from.name || '', machine: selfName() } } : null;
          const out = await send(peer, item.botId, { text: item.text, attachments: item.attachments || [], handoff, groupId: item.groupId || '' });
          queue = queue.filter((i) => i.id !== item.id);
          await saveQueue();
          sent += 1;
          await audit({ kind: 'peer.delivered', machine: item.machine, botId: out.botId, queueId: item.id, turnId: out.turnId || null });
          bus?.emit({ type: 'peer.outbox', machine: item.machine, botId: out.botId ? `${out.botId}@${item.machine}` : '', ...(item.groupId ? { groupId: `${item.groupId}@${item.machine}` } : {}), queueId: item.id, turnId: out.turnId || '', state: 'sent' });
        } catch (err) {
          if (isUnreachable(err)) { off.add(item.machine); continue; }
          // That bot is gone, or the machine refuses: the human is told, the message is not lost silently.
          queue = queue.filter((i) => i.id !== item.id);
          await saveQueue();
          await audit({ kind: 'peer.undelivered', machine: item.machine, botId: item.botId, queueId: item.id, error: err.message });
          bus?.emit({ type: 'peer.outbox', machine: item.machine, botId: item.botId ? `${item.botId}@${item.machine}` : '', queueId: item.id, state: 'failed', text: `没能交给「${item.machine}」：${err.message}` });
        }
      }
      return { sent, waiting: queue.length };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /**
   * That bot's events, as they happen there, passed to this window (SSE).
   * The link dropping is said in plain words; this keeps trying, and says so
   * when it is back (the window then reloads the chat: the turn went on there).
   */
  async function pipeStream(peer, botId, req, res, { groupId = '' } = {}) {
    const who = groupId ? { groupId: `${groupId}@${peer.name}` } : { botId: `${botId}@${peer.name}` };
    const query = groupId ? `groupId=${encodeURIComponent(groupId)}` : `botId=${encodeURIComponent(botId)}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n: connected\n\n');
    let closed = false;
    const controller = new AbortController();
    const write = (ev) => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { closed = true; }
    };
    const heartbeat = setInterval(() => { if (!closed) { try { res.write(`: ping ${Date.now()}\n\n`); } catch { closed = true; } } }, 15000);
    heartbeat.unref?.();
    const stop = () => { closed = true; clearInterval(heartbeat); controller.abort(); };
    req.on('close', stop);
    res.on('close', stop);
    let down = false;
    let wasUp = false;
    while (!closed) {
      // One try: given up when that machine says nothing for a while (it pings every 15 s).
      // A machine switched off or cut from the network leaves the link silent, not closed (1.5.42 test).
      const attempt = new AbortController();
      const onStop = () => attempt.abort();
      controller.signal.addEventListener('abort', onStop, { once: true });
      let heard = Date.now();
      const watchdog = setInterval(() => { if (Date.now() - heard > streamIdleMs) attempt.abort(); }, Math.min(5000, Math.max(100, Math.floor(streamIdleMs / 4))));
      watchdog.unref?.();
      try {
        const up = await peers.call(peer, 'GET', `/api/stream?${query}`, { headers: { accept: 'text/event-stream', [VIA]: '1' }, timeoutMs: 6 * 3600 * 1000, signal: attempt.signal });
        if (!up.ok || !up.body) { await up.body?.cancel?.().catch(() => {}); throw Object.assign(new Error(`HTTP ${up.status}`), { code: 'PEER_UNREACHABLE' }); }
        if (down || wasUp) write({ type: 'peer.link', state: 'up', machine: peer.name, ...who });
        down = false;
        wasUp = true;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of up.body) {
          if (closed) break;
          heard = Date.now();
          buffer += decoder.decode(chunk, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let ev;
              try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
              const out = groupId ? tagRemoteGroupEvent(ev, peer.name, groupId) : tagRemoteEvent(ev, peer.name, botId);
              if (out) write(out);
            }
          }
          if (buffer.length > 1024 * 1024) buffer = '';
        }
        if (closed) break;
        throw Object.assign(new Error('stream ended'), { code: 'PEER_UNREACHABLE' });
      } catch (err) {
        if (closed) break;
        if (err?.code === 'PEER_UNAUTHORIZED') {
          write({ type: 'peer.link', state: 'refused', machine: peer.name, ...who, text: err.message });
          break;
        }
        if (!down) write({ type: 'peer.link', state: 'down', machine: peer.name, ...who, text: LINK_DOWN_WORDS });
        down = true;
      } finally {
        clearInterval(watchdog);
        controller.signal.removeEventListener('abort', onStop);
      }
      await new Promise((r) => setTimeout(r, down ? 5000 : 1000).unref?.());
    }
    stop();
    try { res.end(); } catch { /* gone */ }
  }

  return {
    load,
    list,
    isOnline,
    primaryOf,
    send,
    deliver,
    flush,
    pipeStream,
    outbox: {
      list: async () => { await load(); return queue.map((i) => ({ ...i })); },
      async remove(id) {
        await load();
        const hit = queue.find((i) => i.id === id);
        if (!hit) return null;
        queue = queue.filter((i) => i.id !== id);
        await saveQueue();
        bus?.emit({ type: 'peer.outbox', machine: hit.machine, botId: hit.botId ? `${hit.botId}@${hit.machine}` : '', queueId: id, state: 'removed' });
        return hit;
      },
      flush,
    },
    selfName,
  };
}
