// 1.5.68: a chat opens with its conversation, however many steps the last task took.
//   On 11-24 TikTok运营 took 316 steps on YouTube Studio after the human said 「可以排」. The chat read the
//   last 200 records, all of them steps; with steps hidden the page showed only the greeting, and the
//   human asked where the chat had gone. Now `limit` counts lines of the conversation and the steps
//   between them come along, capped separately; a step the chat draws is never dropped.
// Called from smoke.mjs as a stage.
import fs from 'node:fs';
import path from 'node:path';

const line = (kind, text, turnId = 't') => ({ kind, text, turnId, ts: '2026-11-24T11:00:00Z' });
const step = (name = 'browser_eval', turnId = 't', extra = {}) => ({ kind: 'tool', name, args: {}, ok: true, turnId, ts: '2026-11-24T11:01:00Z', output: { ok: true }, ...extra });

export async function chatWindowChecks({ check, api, readText }) {
  const { chatWindow, CHAT_WINDOW_STEPS } = await import('../src/chatwindow.mjs');
  const SRV = await import('../src/server.mjs');

  // --- CW68-1: the 11-24 chat ----------------------------------------------------------------------
  const chat = [];
  for (let i = 0; i < 20; i += 1) chat.push(line('user', `ask ${i}`, `t${i}`), step('fs_read', `t${i}`), line('assistant', `answer ${i}`, `t${i}`));
  chat.push(line('user', '可以排', 'tlast'));
  for (let i = 0; i < 316; i += 1) chat.push(step('browser_eval', 'tlast'));
  const oldWay = chat.slice(-200);
  const got = chatWindow(chat, 200);
  const lines = got.filter((r) => r.kind !== 'tool');
  check('CW68-1 316 steps after 「可以排」 no longer push the conversation out: the human\'s last words and every earlier line are there (the last 200 records had none); the newest 200 steps come along',
    oldWay.every((r) => r.kind === 'tool') && lines.length === 41 && lines.at(-1).text === '可以排' && lines[0].text === 'ask 0'
    && got.filter((r) => r.kind === 'tool').length === 200 && got.at(-1) === chat.at(-1), JSON.stringify({ lines: lines.length, steps: got.length - lines.length }));

  // --- CW68-2: limit counts lines ------------------------------------------------------------------
  const long = [];
  for (let i = 0; i < 300; i += 1) long.push(line(i % 2 ? 'assistant' : 'user', `l${i}`, `t${i}`), step('shell', `t${i}`), step('fs_list', `t${i}`));
  const fifty = chatWindow(long, 50, { maxSteps: 1000 });
  check('CW68-2 the limit counts lines of the conversation, oldest kept line first, with the steps between them',
    fifty.filter((r) => r.kind !== 'tool').length === 50 && fifty[0].text === 'l250' && fifty.length === 150 && chatWindow(long, 5000, { maxSteps: 1000 }).length === long.length,
    JSON.stringify({ n: fifty.length, first: fifty[0]?.text }));

  // --- CW68-3: steps are capped, cards stay --------------------------------------------------------
  const big = [line('user', 'go', 'tb'), line('approval', '', 'tb'), step('shell', 'tb', { marker: 'after-card' }), step('request_login', 'tb', { marker: 'card' }), step('fs_write', 'tb', { marker: 'undo', output: { undo: 'u1', path: 'a.txt' } })];
  big[1] = { kind: 'approval', toolName: 'shell', turnId: 'tb', ts: big[1].ts };
  for (let i = 0; i < 1000; i += 1) big.push(step('browser_click', 'tb'));
  big.push(line('assistant', 'done', 'tb'));
  const capped = chatWindow(big, 200, { keepStep: SRV.drawnStep });
  const marks = capped.filter((r) => r.marker).map((r) => r.marker);
  check(`CW68-3 one task of 1000 steps: the newest ${CHAT_WINDOW_STEPS} come along, the older ones the chat never draws are left out; the step after an answered card, a card and 「改了 N 个文件」 stay`,
    CHAT_WINDOW_STEPS === 200 && capped.filter((r) => r.kind === 'tool' && !r.marker).length === 200 && marks.join() === 'after-card,card,undo'
    && capped[0].text === 'go' && capped[1].kind === 'approval' && capped[2].marker === 'after-card' && capped.at(-1).text === 'done', JSON.stringify(marks));

  // --- CW68-4: which steps the chat draws ----------------------------------------------------------
  const ap = { kind: 'approval', toolName: 'shell', turnId: 'x' };
  check('CW68-4 the steps kept past the cap are the ones the chat draws: right after its own card (same step, same turn), a takeover or login card, a file change with an undo, an answer from another machine; a plain step is not',
    SRV.drawnStep(step('shell', 'x'), ap) && !SRV.drawnStep(step('fs_read', 'x'), ap) && !SRV.drawnStep(step('shell', 'y'), ap)
    && SRV.drawnStep(step('request_takeover'), null) && SRV.drawnStep(step('bot_adjust'), null) && SRV.drawnStep(step('fs_move', 't', { output: { undo: 'u' } }), null)
    && SRV.drawnStep(step('bot_message', 't', { output: { machine: 'cloud', text: 'hi' } }), null) && !SRV.drawnStep(step('bot_message', 't', { output: { text: 'hi' } }), null)
    && !SRV.drawnStep(step('browser_eval'), line('user', 'x')));

  // --- CW68-5: the real routes ---------------------------------------------------------------------
  const src = await readText('../src/server.mjs');
  check('CW68-5 a bot\'s chat and a group\'s chat both open by lines of the conversation',
    src.includes('const items = chatWindow(records, limit, { keepStep: drawnStep }).map((record, index) => toMessageItem(record, index));')
    && src.includes('const messages = chatWindow(await groups.readGroupMessages(group.id, { limit: 0 }), limit);') && !src.includes('records.slice(-limit)'));

  const made = await api('/api/bots', { method: 'POST', body: { name: '评测-cw68', role: '评测用的临时机器人', eval: true } });
  const botId = made.json?.bot?.id || made.json?.id;
  try {
    let compact = [];
    let full = [];
    if (botId && process.env.ASSIST_DATA_DIR) {
      const file = path.join(process.env.ASSIST_DATA_DIR, 'sessions', `${botId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, chat.map((r) => JSON.stringify(r)).join('\n') + '\n');
      compact = (await api(`/api/bots/${encodeURIComponent(botId)}/messages?limit=200&compact=1`)).json || [];
      full = (await api(`/api/bots/${encodeURIComponent(botId)}/messages?limit=200`)).json || [];
    }
    const said = compact.filter((m) => m.role === 'user' || m.role === 'assistant');
    check('CW68-6 over HTTP, the 11-24 chat with steps hidden shows the whole conversation (from the first line to 「可以排」), and with steps shown carries the newest 200 steps',
      said.length >= 41 && said.some((m) => m.text === '可以排') && said.some((m) => m.text === 'ask 0') && full.filter((m) => m.role === 'tool').length === 200 && full.some((m) => m.text === '可以排'),
      JSON.stringify({ botId, said: said.length, full: full.length }));
  } finally {
    if (botId) await api(`/api/bots/${encodeURIComponent(botId)}?forget=1`, { method: 'DELETE' }).catch(() => {});
  }
}
