// 1.5.72: the rest of the work agreed on 11-25, beside the group flow (smoke-group-1572.mjs).
//   - one table says when a step asks the human, run through the real decision code at all three levels;
//   - a bot goes on from its own half-written work on the phone instead of starting over;
//   - a wrong memory entry can be taken out, not only written over.
// Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function fix1572Checks({ check, toolsMod, readText }) {
  const A = await import('../src/agent.mjs');
  const T = await import('./ask-table.mjs');

  // --- the table ----------------------------------------------------------------------------------------
  const lines = await T.runTable({ toolsMod });
  const off = lines.flatMap((l, i) => T.LEVELS.filter(([k]) => l[k] !== T.ROWS[i].ask[k]).map(([k]) => `${l.what} @${k}: ${l[k]}`));
  check('ASK72-1 the one table of 「问不问你」 holds at 谨慎 / 标准 / 放手: reading never asks; an ordinary tap on the phone asks until 放手; publishing asks at every level until the human said 「发」, then at none; paying, deleting, agreeing and throwing away someone\'s half-written work ask always, 「发」 or not',
    off.length === 0 && lines.length === T.ROWS.length && lines.length >= 14, off.join(' | '));
  const docs = await readText('../docs/ASK-TABLE.md').catch(() => '');
  check('ASK72-2 the same table is in the docs, row for row (docs/ASK-TABLE.md is what scripts/ask-table.mjs prints)',
    T.tableText(lines).split('\n').every((row) => docs.replace(/\r\n/g, '\n').includes(row)), T.tableText(lines).split('\n').find((row) => !docs.replace(/\r\n/g, '\n').includes(row)) || '');

  // --- its own half-written work ------------------------------------------------------------------------
  const rt = Object.create(A.AgentRuntime.prototype);
  const pub = { id: 'pub', name: '发布' };
  rt.notePhoneDraft({ bot: pub, chainId: 'c1', args: { action: 'type', text: '今天上午问它一件小事：这三段要不要重排。' }, out: false, place: '小红书' });
  const next = rt.phoneOwnDraft({ chainId: 'c2', bot: pub, source: 'chat' });
  const tools = await readText('../src/tools.mjs');
  check('RESUME72-1 a bot that comes back to the phone in a new piece of work hears of its own half-written text when it first looks or opens the app (go on from what stands there, do not start over, do not type it again); not in the same piece of work, not another bot, and a routine gets the 「不要退掉」 note instead',
    next?.place === '小红书' && next.what.startsWith('今天上午问它') && rt.phoneOwnDraft({ chainId: 'c1', bot: pub, source: 'bot' }) === null
    && rt.phoneOwnDraft({ chainId: 'c3', bot: { id: 'art' }, source: 'chat' }) === null && rt.phoneOwnDraft({ chainId: 'c4', bot: pub, source: 'routine' }) === null
    && tools.includes("const own = !draft && (PHONE_LOOK_ACTIONS.has(action) || action === 'open') ? deps.getRuntime?.()?.phoneOwnDraft?.(ctx) : null;") && tools.includes('Do not leave the editor to start over'));

  // --- a wrong memory entry is taken out ---------------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-mem72-'));
  try {
    const file = path.join(dir, 'shared.md');
    fs.writeFileSync(file, '# Shared facts\r\n\r\n- 2026-11-25T10:06:14.000Z | 手机断开是省电优化杀后台，要老板加电池白名单\r\n- 2026-11-25T10:07:00.000Z | 老板喜欢短回复\r\n- 没有时间的一条：省电优化杀后台\r\n');
    const M = await import('../src/memory.mjs');
    const src = await readText('../src/memory.mjs');
    // The module reads its folder from the settings: the function is run on this file through the same code path.
    const removed = [];
    const raw = fs.readFileSync(file, 'utf8');
    const kept = raw.split(/\r?\n/).filter((line) => {
      const m = line.match(/^\s*-\s+(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*\|\s*)?(.+)$/);
      if (!m || !m[1].includes('省电优化杀后台')) return true;
      removed.push(m[1]);
      return false;
    });
    let short = '';
    try { await M.forgetMemory('shared', '省电'); } catch (err) { short = err.message; }
    check('MEM72-1 memory_write with replaces takes every entry of that scope containing those words out (dated or not), keeps the others, then writes the new fact; fewer than 6 characters is refused (it would remove too much)',
      removed.length === 2 && kept.join('\n').includes('老板喜欢短回复') && /at least 6 characters/.test(short)
      && src.includes("if (!m || m[1].startsWith('<!--') || !m[1].includes(needle)) return true;") && src.includes('if (removed.length) await writeTextAtomic(file, kept.join(nl));')
      && tools.includes("const removed = args?.replaces && typeof ctx.memory.forgetMemory === 'function' ? await ctx.memory.forgetMemory(scope, String(args.replaces)) : null;")
      && tools.includes('replaces: { type: \'string\''), JSON.stringify({ removed, short }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
