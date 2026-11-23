// The other machine of scenario 3, reached only through the first hub - the way the human reaches it
// from the app. No key of that machine is needed (the human's cloud server keeps its own on itself):
//   bots        POST/PATCH /api/peers/:m/bots…   made there (eval: true), tools and trust set there
//               DELETE /api/peers/:m/bots/:id    removed there (only an evaluation bot, 1.5.65)
//   events      GET /api/peers/:m/bots/:id/stream   each evaluation bot's, as the page follows them
//   chats       GET /api/peers/:m/bots/:id/messages
//   cards       POST /api/inbox/:m/:id            answered there, as the 待办 inbox does
//   files       GET /api/peers/:m/file?path=      the deliverables the scenario expects
//   cost        GET /api/peers/usage
//   a drop      POST /api/peers/:m/pause {seconds} the first hub acts as if that machine were gone
//               (the calls in flight are cut, new ones fail) - the machine itself keeps running.
import crypto from 'node:crypto';
import { recordEvents } from './hubs.mjs';

const enc = encodeURIComponent;
const listOf = (x, ...keys) => (Array.isArray(x) ? x : keys.map((k) => x?.[k]).find(Array.isArray) || []);

/** A handle on machine `machine` (its name as hub A knows it) that only ever talks to hub A. */
export function peerVia(hubA, machine, { testHub = null } = {}) {
  const p = (s) => `/api/peers/${enc(machine)}${s}`;
  const local = (id) => String(id || '').replace(new RegExp(`@${machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
  return {
    name: 'B',
    via: true,
    machine,
    test: Boolean(testHub),
    /** The test hub behind it (scenario 3 with --fake): only to switch it off and on, never to talk to. */
    testHub,
    url: hubA.url,
    key: hubA.key,
    async createBot({ name, role, persona, tools, trusted, model }) {
      const made = await hubA.api.post(p('/bots'), { name, role, persona, eval: true });
      const id = local(made?.bot?.id);
      if (!id) throw new Error(`「${machine}」上没建成「${name}」`);
      await hubA.api.patch(p(`/bots/${enc(id)}`), { tools, ...(trusted ? { policy: { autoApproveMedium: true } } : {}), ...(model ? { model } : {}) });
      return { id, name: made.bot.name || name };
    },
    deleteBot: (id) => hubA.api.del(p(`/bots/${enc(id)}`)),
    async messages(id) { return listOf(await hubA.api.get(p(`/bots/${enc(id)}/messages?limit=1000`)), 'items'); },
    answer: (approvalId, decision, extra = {}) => hubA.api.post(`/api/inbox/${enc(machine)}/${enc(approvalId)}`, { decision, ...extra }),
    /** sha of a file in that machine's workspace, or null when it is not there. */
    async fileSha(rel) {
      const res = await fetch(`${hubA.url}${p(`/file?path=${enc(rel)}`)}`, { headers: { 'x-lamplit-local': hubA.key }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
      return crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex').slice(0, 16);
    },
    async usage(ids) {
      const all = listOf(await hubA.api.get('/api/peers/usage?days=2').catch(() => null), 'machines');
      const rows = all.find((m) => m.machine === machine)?.byBot || [];
      return ids.reduce((s, id) => { const r = rows.find((x) => x.key === id); return { tokens: s.tokens + (Number(r?.tokens) || 0), cost: s.cost + (Number(r?.cost) || 0) }; }, { tokens: 0, cost: 0 });
    },
    pause: (seconds) => hubA.api.post(p('/pause'), { seconds }),
    /** Each bot's events, recorded as hub B's, with the bot's own id there. */
    record(ids, rows) {
      return ids.map((id) => recordEvents({ name: 'B', url: hubA.url, key: hubA.key }, rows, {
        path: p(`/bots/${enc(id)}/stream`),
        map: (ev) => (ev.type === 'peer.link' ? { ...ev, botId: id } : { ...ev, botId: local(ev.botId) }),
      }));
    },
  };
}
