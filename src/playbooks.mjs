// How a job was done on a site or in an app, kept for the next time (1.5.68).
//
// 11-24: TikTok运营 spent 110 of its 412 browser steps finding out how TikTok Studio and YouTube Studio work -
// reading the page's structure, hunting for the button - and 发布 searched old notes for 「小红书定时发布怎么点」.
// Both had done the same job the day before. Now, when a piece of work that sent something out there ends well,
// the steps that got it done are kept per place (a site's host, a phone app), on this machine, for every bot;
// the next time any bot opens that place, the result of opening it carries them.
//
//   placeOf(url) / appPlace(pkg)        the key
//   buildPlaybooks(receipts)            -> [{place, lines, cost}] from a finished chain's receipts
//   createPlaybooks({file})             -> {load, get, keep, list, forget}

import { readJson, writeJsonAtomic } from './store.mjs';

const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINES = 40;
const MAX_PLACES = 200;

export function placeOf(url) {
  try { return new URL(String(url)).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
export const appPlace = (pkg) => (pkg ? `app:${String(pkg)}` : '');

/** What was typed is that day's content, not the way: the line keeps the box, not the words. */
const noContent = (line) => String(line).replace(/里输入了「[^」]*」/g, '里输入了内容').replace(/^★ /, '');

/**
 * The places of a chain where something went out, each with the steps taken there up to the last one that
 * went out. cost: how many steps the place took in all (failed ones and the ones without a line too).
 */
export function buildPlaybooks(receipts) {
  const by = new Map();
  for (const r of receipts || []) {
    if (!r?.place) continue;
    const p = by.get(r.place) || { place: r.place, steps: [], cost: 0 };
    p.cost += 1;
    if (r.ok !== false && r.did) p.steps.push({ line: noContent(r.did), out: r.out === true });
    by.set(r.place, p);
  }
  const out = [];
  for (const p of by.values()) {
    const last = p.steps.map((s) => s.out).lastIndexOf(true);
    if (last < 0) continue;
    const lines = [];
    for (const s of p.steps.slice(0, last + 1)) if (lines[lines.length - 1] !== s.line) lines.push(s.line);
    if (lines.length < 2) continue;
    out.push({ place: p.place, lines: lines.slice(-MAX_LINES), cost: p.cost });
  }
  return out;
}

export function createPlaybooks({ file = null, now = () => Date.now() } = {}) {
  const data = {};
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const raw = file ? await readJson(file, {}).catch(() => ({})) : {};
    for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (v && Array.isArray(v.lines) && now() - Number(v.at || 0) < KEEP_MS) data[k] = v;
    }
  };
  const save = () => (file ? writeJsonAtomic(file, data).catch(() => {}) : Promise.resolve());
  return {
    load,
    get(place) { return (place && data[place]) || null; },
    list() { return Object.entries(data).map(([place, v]) => ({ place, ...v })); },
    /**
     * Keep this way of doing it - unless a shorter one is already kept and still fresh (a run that went round
     * in circles does not replace a clean one; after 30 days the newer one wins, the site may have changed).
     */
    async keep({ place, lines, cost = 0, botName = '' }) {
      await load();
      if (!place || !Array.isArray(lines) || lines.length < 2) return false;
      const old = data[place];
      if (old && now() - Number(old.at || 0) < FRESH_MS && old.lines.length < lines.length) return false;
      data[place] = { lines: lines.slice(-MAX_LINES).map((l) => String(l).slice(0, 200)), cost, by: String(botName).slice(0, 40), at: now() };
      const keys = Object.keys(data);
      if (keys.length > MAX_PLACES) for (const k of keys.sort((a, b) => data[a].at - data[b].at).slice(0, keys.length - MAX_PLACES)) delete data[k];
      await save();
      return true;
    },
    async forget(place) { await load(); if (data[place]) { delete data[place]; await save(); } },
  };
}

/** What a bot is handed when it opens a place with a kept way. */
export function playbookNote(pb) {
  const day = new Date(pb.at).toISOString().slice(0, 10);
  return {
    note: `上次（${day}${pb.by ? `，${pb.by}` : ''}）在这里把事情做成时走过的步骤，系统记录。同样的事照着做，不用重新摸索页面结构；页面和这里写的不一样时，以页面为准。里面的内容（标题、正文、时间）是那一次的，这一次用这一次的。`,
    steps: pb.lines,
  };
}
