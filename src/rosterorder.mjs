// The sidebar's pins (1.5.61, the user's choice: the hybrid). Pinned chats stay on top in the
// order the human put them (the primary bot pinned unless taken off: unpinned); the rest go
// by latest activity, in the page. Kept on this hub (data/roster-order.json), so every
// device shows the same pins.
//
//   { pinned: [key], unpinned: [key], order: { section: [pinned key, in order] } }
//   key      bot:<id> | group:<id> | bot:<id>@<machine> | group:<id>@<machine>
//   section  groups | machine:self | machine:<name>

import path from 'node:path';

import { P, readJson, writeJsonAtomic } from './store.mjs';

export const ORDER_LIMITS = { sections: 60, keys: 400, keyLength: 200 };

const KEY = /^(bot|group):\S{1,190}$/;
const SECTION = /^(groups|machine:\S.{0,79})$/;

/** Only what the sidebar can use: known shapes, no duplicates, bounded sizes. */
export function normalizeOrder(raw) {
  const keys = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => k.length <= ORDER_LIMITS.keyLength && KEY.test(k)))].slice(0, ORDER_LIMITS.keys);
  const src = raw && typeof raw === 'object' && raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order) ? raw.order : {};
  const order = {};
  for (const [section, list] of Object.entries(src).slice(0, ORDER_LIMITS.sections)) {
    if (SECTION.test(section)) order[section] = keys(list);
  }
  return { pinned: keys(raw?.pinned), unpinned: keys(raw?.unpinned), order };
}

export function orderFile() {
  return path.join(P.dataDir, 'roster-order.json');
}

export async function readOrder(file = orderFile()) {
  return normalizeOrder(await readJson(file, {}));
}

/** Written whole, through the store's atomic writer (tmp file + rename). */
export async function writeOrder(raw, file = orderFile()) {
  const value = normalizeOrder(raw);
  await writeJsonAtomic(file, { ...value, updatedAt: new Date().toISOString() });
  return value;
}
