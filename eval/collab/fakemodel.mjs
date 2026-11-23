// The scripted fake model for `eval-collab --fake`: an OpenAI-compatible endpoint on 127.0.0.1 that
// the test hubs use as their model. No network, no key. It works out which bot is asking (from the
// system prompt the hub builds) and what kind of call it is, and hands that to the scenario's script,
// which answers with words or tool calls. A planted violation is just a script that misbehaves.
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (c) => (Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : String(c ?? ''));

/** What the hub asked, in the terms a scenario script uses. */
export function readCall(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  const offered = (body?.tools || []).map((t) => t?.function?.name || t?.name).filter(Boolean);
  // What the human said while the turn ran is pushed in as a user message (agent.mjs inbox): the turn's
  // own prompt is the last user message that is not one of those notes.
  const isNote = (m) => m.role === 'user' && /^（(你干活时|协调者「|你在等用户)/.test(textOf(m.content));
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i].role === 'user' && !isNote(msgs[i])) { lastUserIdx = i; break; }
  const last = lastUserIdx >= 0 ? textOf(msgs[lastUserIdx].content) : '';
  const after = lastUserIdx >= 0 ? msgs.slice(lastUserIdx + 1) : [];
  const notes = after.filter(isNote).map((m) => textOf(m.content));
  const results = after.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
  const calls = after.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((c) => ({ name: c.function?.name, args: (() => { try { return JSON.parse(c.function?.arguments || '{}'); } catch { return {}; } })() })));
  const review = /的协调者「([^」]+)」/.exec(sys);
  const you = /You are ([^,\n]+),/.exec(sys);
  const name = (review?.[1] || you?.[1] || '').trim();
  let kind = 'turn';
  if (!offered.length) kind = 'aside';
  else if (review && offered.length <= 2 && offered.includes('task_change')) kind = 'review';
  else if (/（这个群刚建好）/.test(last)) kind = 'kickoff';
  else if (/（任务板做完了）/.test(last)) kind = 'summary';
  else if (/的任务板）用户的原始请求/.test(last)) kind = 'task';
  const history = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
  return { sys, name, who: name.replace(/^评测-/, ''), kind, offered, last, notes, results, lastResult: results[results.length - 1] || '', calls, step: calls.length, history, messages: msgs };
}

export const say = (content, extra = {}) => ({ content, ...extra });
export const call = (name, args, extra = {}) => ({ calls: [{ name, args }], ...extra });

/**
 * Start the fake model. script(ctx) -> {content} | {calls:[{name,args}]} | Promise of it; ctx also has
 * plant (the set of planted violations of this run) and calls(): the log of every call so far.
 */
export async function startFakeModel({ script, plant = new Set(), log = () => {} } = {}) {
  const seen = [];
  let current = script;
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* none */ }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fake' }] })); return; }
    const ctx = readCall(body);
    ctx.plant = plant;
    ctx.n = seen.filter((s) => s.who === ctx.who && s.kind === ctx.kind).length + 1;
    ctx.log = seen;
    let d;
    try { d = (current && (await current(ctx))) || say('好的。'); } catch (err) { d = say(`（假模型脚本出错：${err.message}）`); }
    if (d.delay) await sleep(d.delay);
    seen.push({ at: Date.now(), who: ctx.who, kind: ctx.kind, step: ctx.step, last: ctx.last.slice(0, 200), out: d.calls ? d.calls.map((c) => c.name).join(',') : `say:${String(d.content || '').slice(0, 60)}` });
    log(`[fake] ${ctx.who || '?'}/${ctx.kind}#${ctx.step} -> ${seen[seen.length - 1].out}`);
    const id = `call_${(++seq).toString(36)}`;
    const toolCalls = (d.calls || []).map((c, i) => ({ id: `${id}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
    const usage = { prompt_tokens: Math.round(JSON.stringify(body.messages || []).length / 4), completion_tokens: Math.round(JSON.stringify(d).length / 4) };
    const finish = toolCalls.length ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = toolCalls.length ? { role: 'assistant', tool_calls: toolCalls.map((t, index) => ({ index, ...t })) } : { role: 'assistant', content: d.content || '' };
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, choices: [{ index: 0, message: toolCalls.length ? { role: 'assistant', content: '', tool_calls: toolCalls } : { role: 'assistant', content: d.content || '' }, finish_reason: finish }], usage }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    url,
    seen,
    setScript: (s) => { current = s; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
