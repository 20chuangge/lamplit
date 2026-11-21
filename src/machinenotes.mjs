// What each machine is good for (1.5.45 第四步「替你想」). The main assistant
// keeps one line per machine - 「腾讯云：一直开着，跑发布和筛岗」 - and picks the
// machine for a job itself, so the human only says what to do.
//
// A new machine gets a line written from what is known about it (always on or
// not, its bots and their jobs). Once the human (or the assistant, when the
// human said so) writes one, that line wins and is not written over.
// `confirmed`: the human said yes to the first hand-off to that machine; from
// then on hand-offs go without a card (the human's choice, 2026-11-20).
//
//   createMachineNotes({file}) -> {load, all, get, set, autoFill, confirm, remove}
//   suggestNote({alwaysOn, personal}) -> one short line (no bot list, 1.5.51)
//   machinesPrompt({notes, roster, here}) -> lines for the main assistant's prompt

import { readJson, writeJsonAtomic } from './store.mjs';

const MAX_NOTE = 200;
const clean = (s, n = MAX_NOTE) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A first line for a machine: whether it stays on, whether it has the human's files.
 * Its bots are not listed (1.5.51): the sidebar shows them, and the prompt lists them
 * by machine anyway. Nothing known: '' (the page says 「还没写」).
 */
export function suggestNote({ alwaysOn = false, personal = false } = {}) {
  const parts = [];
  if (alwaysOn) parts.push('一直开着，适合定时任务和长时间跑的活');
  if (personal) parts.push('你的电脑，有你的个人文件');
  return clean(parts.join('；'));
}

export function createMachineNotes({ file } = {}) {
  let notes = null; // name -> {note, by: 'auto'|'human'|'assistant', confirmed?, at}

  async function load() {
    if (notes) return notes;
    const raw = await readJson(file, {}).catch(() => ({}));
    notes = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return notes;
  }
  const save = () => writeJsonAtomic(file, notes);
  const key = (name) => clean(name, 60);

  return {
    load,
    all() { return JSON.parse(JSON.stringify(notes || {})); },
    get(name) { return (notes || {})[key(name)] || null; },

    /** The human's or the assistant's words for a machine. */
    async set(name, note, by = 'human') {
      await load();
      const k = key(name);
      if (!k) throw Object.assign(new Error('哪台机器？'), { code: 'MACHINE_REQUIRED', status: 400 });
      const text = clean(note);
      if (!text) {
        // Cleared: the line is written from what is known again next time.
        if (notes[k]) { const { confirmed } = notes[k]; notes[k] = { note: '', by: 'auto', ...(confirmed ? { confirmed } : {}), at: new Date().toISOString() }; }
      } else notes[k] = { ...(notes[k] || {}), note: text, by: by === 'assistant' ? 'assistant' : 'human', at: new Date().toISOString() };
      await save();
      return notes[k] || null;
    },

    /** Written from what is known - only where nobody wrote one. */
    async autoFill(name, note) {
      await load();
      const k = key(name);
      if (!k) return null;
      const cur = notes[k];
      if (cur && cur.by !== 'auto') return cur;
      const text = clean(note);
      // An older automatic line (1.5.45 listed the bots) is replaced, or cleared when nothing is known now.
      if (!text) {
        if (cur?.note) { notes[k] = { ...cur, note: '', at: new Date().toISOString() }; await save(); }
        return notes[k] || null;
      }
      if (cur?.note === text) return cur;
      notes[k] = { ...(cur || {}), note: text, by: 'auto', at: new Date().toISOString() };
      await save();
      return notes[k];
    },

    /** The human said yes to the first hand-off to this machine. */
    async confirm(name) {
      await load();
      const k = key(name);
      notes[k] = { note: '', by: 'auto', ...(notes[k] || {}), confirmed: true };
      await save();
      return notes[k];
    },

    /** Something was handed to that machine (1.5.45): kept as what runs there, newest first, a few. */
    async noteRan(name, { bot = '', task = '' } = {}) {
      await load();
      const k = key(name);
      if (!k || !String(task).trim()) return null;
      const cur = notes[k] || { note: '', by: 'auto' };
      const ran = [{ at: new Date().toISOString(), bot: clean(bot, 30), task: clean(task, 60) }, ...(cur.ran || [])].slice(0, 8);
      notes[k] = { ...cur, ran };
      await save();
      return notes[k];
    },

    /** What is known about the machine itself: always on, whose it is, its apps, how it is reached. */
    async setFacts(name, facts = {}) {
      await load();
      const k = key(name);
      if (!k) return null;
      const cur = notes[k] || { note: '', by: 'auto' };
      const f = { ...(cur.facts || {}) };
      if (typeof facts.alwaysOn === 'boolean') f.alwaysOn = facts.alwaysOn;
      if (facts.kind === 'yours' || facts.kind === 'bots') f.kind = facts.kind;
      if (Array.isArray(facts.apps)) f.apps = facts.apps.map((a) => clean(a, 30)).filter(Boolean).slice(0, 12);
      if (typeof facts.reach === 'string') f.reach = clean(facts.reach, 30);
      if (JSON.stringify(f) === JSON.stringify(cur.facts || {})) return cur;
      notes[k] = { ...cur, facts: f };
      await save();
      return notes[k];
    },

    async remove(name) {
      await load();
      delete notes[key(name)];
      await save();
    },
  };
}

/** The rest of a machine's profile, for the prompt: always on, its apps, how reached, what ran there. */
function profileWords(p = {}) {
  const f = p.facts || {};
  const bits = [];
  if (f.alwaysOn) bits.push('always on');
  if (f.kind === 'yours') bits.push("the human's own computer (their files)");
  if (f.kind === 'bots') bits.push('given to the bots');
  if (f.apps?.length) bits.push(`apps: ${f.apps.join(', ')}`);
  if (f.reach) bits.push(`reached over ${f.reach}`);
  if (p.ran?.length) bits.push(`跑过 (ran there lately): ${p.ran.slice(0, 4).map((r) => `${r.bot ? `${r.bot}: ` : ''}${r.task}`).join('; ')}`);
  return bits.length ? `. ${bits.join('; ')}` : '';
}

/**
 * The main assistant's 「你的机器」: each machine, whether it answers, what it is
 * good for, its bots (name, id, job). Names only - no addresses. Then how to pick.
 */
export function machinesPrompt({ notes = {}, roster = [], here = '' } = {}) {
  if (!Array.isArray(roster) || !roster.length) return [];
  const lines = ['## Your machines (you pick where work runs)'];
  if (here) {
    const n = notes[here]?.note;
    // (its profile below, like the others')
    lines.push(`- ${here} (this machine, where this chat runs)${n ? ` - 适合：${n}` : ''}`);
  }
  for (const m of roster) {
    const p = notes[m.machine] || {};
    const state = m.online ? 'answers now' : 'off now (关着/连不上): a task waits and is sent when it is back';
    const bots = (m.bots || []).slice(0, 12).map((b) => `${b.name}（${b.id}）${b.role ? `: ${clean(b.role, 60)}` : ''}`).join('; ');
    lines.push(`- ${m.machine} (${state})${p.note ? ` - 适合：${p.note}` : ''}${bots ? `. Bots: ${bots}` : ''}${profileWords(p)}`);
  }
  lines.push(
    'How to pick, when the human just says what to do:',
    '1. The machine they name. 2. Else the machine whose 「适合」 line or one of whose bots\' jobs fits the work best. 3. Work on the human\'s own files stays on the machine that has them; work that must keep running or run on a schedule goes to a machine that is always on. 4. Not sure: do it here, or ask in one short question.',
    'Hand it over with machine_switch (machine, and bot when one bot there fits; task = the whole instruction, it does not see this chat; why = one short reason) - or, to wait for the answer, bot_message with its machine. The window stays here. Then tell the human in one sentence where it went and why, e.g. 「交给腾讯云上的「策略」了，它管筛岗。」 The first hand-off to a machine shows the human a card; after their yes the next ones go without one.',
    'When the human says what a machine is for (「以后腾讯云专门跑发布」), save it with machine_note and say so.',
    '',
  );
  return lines;
}
