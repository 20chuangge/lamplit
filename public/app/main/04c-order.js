'use strict';
// Lamplit page, part 4c: the sidebar's order (1.5.61, the user's choice: the hybrid) - pinned rows on top in the order the human put them (the primary bot pinned by default), everything else by latest activity like a messenger; and nothing moves while you are looking: with the pointer over the list, a touch or a scroll going on, a click pending, or within 1.5 s of them, the order holds, then changes once with a short move (none with reduced motion). Pins and their order are kept on the hub (GET / PUT /api/roster-order) so every device shows the same. Parts share one scope and load in order (scripts/check-page-parts.mjs).

// The last pins seen, kept in this browser: the list is drawn right the first time, before the hub
// answers (1.5.61 beginner test, round 2: on opening it moved twice in half a second).
const ROSTER_ORDER_CACHE = 'lamplit.rosterOrder';
function cachedRosterOrder() {
  try {
    const got = JSON.parse(localStorage.getItem(ROSTER_ORDER_CACHE) || 'null');
    const list = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === 'string') : []);
    if (got && typeof got === 'object') return { pinned: list(got.pinned), unpinned: list(got.unpinned), order: got.order && typeof got.order === 'object' ? got.order : {} };
  } catch { /* none, or private mode */ }
  return { pinned: [], unpinned: [], order: {} };
}
function cacheRosterOrder() {
  try { localStorage.setItem(ROSTER_ORDER_CACHE, JSON.stringify(state.rosterOrder)); } catch { /* private mode */ }
}
state.rosterOrder = cachedRosterOrder();

/** The hub's pins; the list is drawn again only when they changed. */
async function loadRosterOrder() {
  // A change that did not reach the hub (it was restarting, 1.5.61 beginner test) is sent again, not overwritten.
  if (rosterOrderUnsaved) { putRosterOrder(); return; }
  let got;
  try { got = await api('/api/roster-order', { quiet: true }); } catch { return; /* an older hub: only the primary pinned */ }
  const list = (x) => (Array.isArray(x) ? x : []);
  const next = { pinned: list(got?.pinned), unpinned: list(got?.unpinned), order: got?.order && typeof got.order === 'object' ? got.order : {} };
  if (JSON.stringify(next) === JSON.stringify(state.rosterOrder)) return;
  state.rosterOrder = next;
  cacheRosterOrder();
  rosterOrderChanged();
}

let rosterOrderTimer = null;
let rosterOrderUnsaved = false;
function putRosterOrder() {
  rosterOrderUnsaved = true;
  api('/api/roster-order', { method: 'PUT', body: state.rosterOrder }).then(() => { rosterOrderUnsaved = false; })
    .catch(() => toast('置顶的顺序还没存上：连上机器后会再存一次。', true));
}
function saveRosterOrder() {
  cacheRosterOrder();
  clearTimeout(rosterOrderTimer);
  rosterOrderUnsaved = true;
  rosterOrderTimer = setTimeout(putRosterOrder, 200);
}

/** Pinned: put there by the human, or the primary bot unless the human took it off. */
function isPinnedItem(it) {
  const o = state.rosterOrder;
  return (o.pinned || []).includes(it.key) || (Boolean(it.primary) && !(o.unpinned || []).includes(it.key));
}

/* --- latest activity -------------------------------------------------------- */
// When a chat last did something the human cares about: its newest message (preview), a message
// waiting for its machine (outbox), and - noted here as they happen - a new card, finished work,
// a step stuck. The newest first, like a messenger.
state.activityAt = state.activityAt || {};

/** Attention moved on for some chats: note when (a new card, a result, a failure). */
const activityBaseline = new Set();
function noteActivity(before = {}, after = {}, source = '') {
  // The first look from a source (this hub's cards, the other machines') is where things stand, not news:
  // on a reload every unread chat came out as 「just now」, out of time order (1.5.61 beginner test, round 2).
  if (source && !activityBaseline.has(source)) { activityBaseline.add(source); return; }
  const now = Date.now();
  for (const [key, item] of Object.entries(after || {})) {
    const was = before?.[key] || {};
    if ((item?.needsYou && !was.needsYou) || (item?.asking && !was.asking) || (item?.unread && !was.unread) || (item?.failed && !was.failed)) state.activityAt[key] = now;
  }
}

function activityOf(it) {
  return Math.max(Number(it.ts) || 0, state.activityAt[it.key] || 0);
}

/* --- holding still while you look ------------------------------------------- */
const rosterFreeze = { pointer: false, touch: false, pending: false, until: 0, timer: null, shown: {}, waiting: false, applying: false, force: false, reorders: 0, installed: false };
const FREEZE_MS = 1500;
// Opening the page: rows come in over a moment (this machine's, then the others' with their groups);
// they are drawn straight where they belong, not held and then moved (round 2: two moves in half a second).
const SETTLE_MS = 2500;
let rosterFirstDrawn = 0;

/** The list holds its order: the pointer over it, a touch, a click pending, or just after any of them or a scroll. */
function rosterFrozen() {
  return rosterFreeze.pointer || rosterFreeze.touch || rosterFreeze.pending || Date.now() < rosterFreeze.until;
}

/** Something ended (the pointer left, a finger lifted, a scroll, a click): hold 1.5 s more, then catch up once. */
function holdThenCatchUp() {
  rosterFreeze.until = Date.now() + FREEZE_MS;
  clearTimeout(rosterFreeze.timer);
  rosterFreeze.timer = setTimeout(catchUpOrder, FREEZE_MS + 50);
}

/** After the hold: if the order is behind, change it now - once. */
function catchUpOrder() {
  if (!rosterFreeze.waiting) return;
  if (rosterFrozen()) { holdThenCatchUp(); return; }
  rosterFreeze.waiting = false;
  reorderRoster();
}

/** The human changed pins or moved a row: shown at once, whatever is going on. */
function rosterOrderChanged() {
  rosterFreeze.force = true;
  try { renderBots(); } finally { rosterFreeze.force = false; }
}

function reducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** One reorder: drawn in the new order, each row sliding from where it was (no slide with reduced motion). */
function reorderRoster() {
  const list = $('bot-list');
  const rowsNow = () => [...(list?.querySelectorAll('[data-order-key]') || [])];
  const was = new Map(rowsNow().map((r) => [`${r.dataset.section}|${r.dataset.orderKey}`, r.getBoundingClientRect().top]));
  rosterFreeze.applying = true;
  try { renderBots(); } finally { rosterFreeze.applying = false; }
  rosterFreeze.reorders += 1;
  if (reducedMotion()) return;
  for (const row of rowsNow()) {
    const top = was.get(`${row.dataset.section}|${row.dataset.orderKey}`);
    if (top === undefined) continue;
    const dy = top - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 1 || typeof row.animate !== 'function') continue;
    row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
}

/** Once: what counts as looking at the list. */
function installRosterFreeze() {
  const list = $('bot-list');
  if (!list || rosterFreeze.installed) return;
  rosterFreeze.installed = true;
  list.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') rosterFreeze.pointer = true; });
  list.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { rosterFreeze.pointer = false; holdThenCatchUp(); } });
  list.addEventListener('touchstart', () => { rosterFreeze.touch = true; }, { passive: true, capture: true });
  const lifted = () => { rosterFreeze.touch = false; holdThenCatchUp(); };
  list.addEventListener('touchend', lifted, { capture: true });
  list.addEventListener('touchcancel', lifted, { capture: true });
  // A press on a row: wait for its click (or for the press to come to nothing).
  list.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-order-key]')) return;
    rosterFreeze.pending = true;
    const done = () => { if (!rosterFreeze.pending) return; rosterFreeze.pending = false; holdThenCatchUp(); };
    list.addEventListener('click', done, { once: true, capture: true });
    document.addEventListener('pointerup', () => setTimeout(done, 400), { once: true });
    document.addEventListener('pointercancel', done, { once: true });
  }, { capture: true });
  // A scroll of the list (or of the page around it, on a phone).
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t === document || t === document.scrollingElement || (t.contains && t.contains(list))) holdThenCatchUp();
  }, { capture: true, passive: true });
}

/**
 * [{key, primary?, createdAt?, ts?}] in the section's order: the pinned ones in the order the
 * human put them, then the rest by latest activity. While the list holds still, rows stay where
 * they are (one that is new goes to the end of its part) and the change waits for catchUpOrder().
 */
function sortSection(section, items) {
  installRosterFreeze();
  if (!rosterFirstDrawn) rosterFirstDrawn = Date.now();
  const settling = Date.now() - rosterFirstDrawn < SETTLE_MS && !rosterFrozen();
  const manual = state.rosterOrder.order?.[section] || [];
  const made = (it) => Date.parse(it.createdAt || '') || Number.MAX_SAFE_INTEGER;
  const pinned = items.filter(isPinnedItem).sort((a, b) => {
    const ia = manual.includes(a.key) ? manual.indexOf(a.key) : 1e6;
    const ib = manual.includes(b.key) ? manual.indexOf(b.key) : 1e6;
    return ia - ib || Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || made(a) - made(b);
  });
  const rest = items.filter((it) => !isPinnedItem(it)).sort((a, b) => activityOf(b) - activityOf(a) || made(a) - made(b));
  const natural = [...pinned, ...rest];
  const shown = rosterFreeze.shown[section];
  const same = (list) => Boolean(shown) && list.map((i) => i.key).join('\n') === shown.join('\n');
  let result = natural;
  if (shown && !rosterFreeze.applying && !rosterFreeze.force && !settling && !same(natural)) {
    // Not now: keep the rows where they are; catch up once, when nobody is looking.
    const at = new Map(shown.map((k, i) => [k, i]));
    const keep = (list) => list.slice().sort((a, b) => (at.has(a.key) ? at.get(a.key) : 1e6) - (at.has(b.key) ? at.get(b.key) : 1e6));
    result = [...keep(pinned), ...keep(rest)];
    rosterFreeze.waiting = true;
    if (!rosterFrozen()) { clearTimeout(rosterFreeze.timer); rosterFreeze.timer = setTimeout(catchUpOrder, 60); }
  }
  rosterFreeze.shown[section] = result.map((i) => i.key);
  return result;
}

/* --- a group's second line: how many, and on which machines ---------------- */
/** A machine of the sidebar that does not answer now (this one always does). */
function machineOffline(name) {
  const m = (state.peerRoster || []).find((x) => x.machine === name);
  return Boolean(m && !m.online);
}

/** The machines a group's members are on, the host first. Ids are 「id@machine」 for members elsewhere. */
function groupMachines(members, host) {
  const machines = [host];
  for (const b of members) {
    const id = String(b.id || '');
    const at = id.lastIndexOf('@');
    const where = at > 0 ? id.slice(at + 1) : host;
    if (where && !machines.includes(where)) machines.push(where);
  }
  return machines.filter(Boolean);
}

/**
 * 「4 位成员 · Windows 电脑 + 腾讯云」; a member's machine that is off says so:
 * 「2 位成员 · 腾讯云 + 书房电脑（离线）」 (1.5.61 beginner test: it did not show). The host's own
 * state is the row's (「所在机器离线」), so it is not marked here.
 */
function groupWhereLine(members, host) {
  const names = groupMachines(members, host).map((m) => (m !== host && machineOffline(m) ? `${m}（离线）` : m));
  return `${members.length} 位成员 · ${names.join(' + ')}`;
}

/** Machines of a group's members that are off, its host aside. */
function groupOfflineMembers(members, host) {
  return groupMachines(members, host).filter((m) => m !== host && machineOffline(m));
}

/** A group's line: what waits or works, or where it is - a finished result is the row's dot, not its line. */
function groupLine(line, idle) {
  return line.kind === 'unread' ? { kind: '', text: idle } : line;
}

/* --- moving a pinned row ---------------------------------------------------- */
/** The rows of one section, as drawn (with their keys). */
function sectionRows(section) {
  return [...document.querySelectorAll('#bot-list [data-order-key]')].filter((r) => r.dataset.section === section);
}

/** The pinned rows' order as they now stand: saved, and the list drawn again at once. */
function commitSection(section, keys) {
  state.rosterOrder.order = { ...(state.rosterOrder.order || {}), [section]: keys };
  saveRosterOrder();
  rosterOrderChanged();
}

/** One step up (-1) or down (+1) among the pinned rows; true when it moved. */
function moveRowBy(row, step) {
  const rows = sectionRows(row.dataset.section).filter((r) => r.dataset.pinned === '1');
  const i = rows.indexOf(row);
  const j = i + step;
  if (i < 0 || j < 0 || j >= rows.length) return false;
  const keys = rows.map((r) => r.dataset.orderKey);
  [keys[i], keys[j]] = [keys[j], keys[i]];
  const key = row.dataset.orderKey;
  commitSection(row.dataset.section, keys);
  // The keys stay with the row that was moved.
  requestAnimationFrame(() => document.querySelector(`#bot-list [data-order-key="${CSS.escape(key)}"]`)?.focus());
  return true;
}

/** 置顶 / 取消置顶: a pinned row goes last of the pinned ones; the primary bot can be taken off too. */
function togglePin(row) {
  const key = row.dataset.orderKey;
  const section = row.dataset.section;
  const was = row.dataset.pinned === '1';
  const o = state.rosterOrder;
  o.pinned = (o.pinned || []).filter((k) => k !== key);
  o.unpinned = (o.unpinned || []).filter((k) => k !== key);
  if (row.dataset.primary === '1') { if (was) o.unpinned.push(key); }
  else if (!was) o.pinned.push(key);
  if (!was) {
    const pinnedNow = sectionRows(section).filter((r) => r.dataset.pinned === '1').map((r) => r.dataset.orderKey).filter((k) => k !== key);
    o.order = { ...(o.order || {}), [section]: [...pinnedNow, key] };
  }
  saveRosterOrder();
  rosterOrderChanged();
  toast(was ? '已取消置顶' : '已置顶');
}

/** 置顶 / 上移 / 下移 at the top of a row's menu (its own menu, or a new ⋯ one). */
function addOrderMenu(row) {
  let menu = row.querySelector(':scope > .bot-menu');
  let more = row.querySelector(':scope > .bot-more');
  if (!menu) {
    more = el('button', 'bot-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', `排序：${row.querySelector('.bot-name-text')?.textContent || ''}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    menu = el('div', 'menu bot-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    more.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(menu, more); });
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); toggleMenu(menu, more); });
    row.append(more, menu);
  }
  const item = (label, action) => {
    const b = el('button', 'order-item', label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', (event) => { event.stopPropagation(); closeMenus(); action(); });
    return b;
  };
  const pinned = row.dataset.pinned === '1';
  const items = [item(pinned ? '取消置顶' : '置顶', () => togglePin(row))];
  if (pinned) {
    items.push(item('上移', () => { if (!moveRowBy(row, -1)) toast('已经在最上面了'); }));
    items.push(item('下移', () => { if (!moveRowBy(row, 1)) toast('已经在最下面了'); }));
  } else {
    // Why it has no 上移 / 下移 (1.5.61 beginner test: nothing said it had to be pinned first).
    items.push(el('div', 'menu-note', '没置顶的按最新动静排；置顶后（或直接拖到上面）就能自己排。'));
  }
  const sep = menu.children.length ? el('div', 'menu-sep') : null;
  menu.prepend(...items, ...(sep ? [sep] : []));
  return { menu, more };
}

/** The pin after a pinned row's name: a small pin you can read (1.5.61 beginner test: a grey dot said nothing). */
function pinMark() {
  const mark = el('span', 'pin-mark');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', '已置顶');
  mark.title = '已置顶';
  return mark;
}

/** Put a row among the pinned ones of its section, before `before` (or last); pinned if it was not. */
function placePinned(row, before) {
  const key = row.dataset.orderKey;
  const section = row.dataset.section;
  const keys = sectionRows(section).filter((r) => r.dataset.pinned === '1').map((r) => r.dataset.orderKey).filter((k) => k !== key);
  const at = before ? keys.indexOf(before.dataset.orderKey) : -1;
  keys.splice(at >= 0 ? at : keys.length, 0, key);
  const pinnedNow = row.dataset.pinned !== '1';
  if (pinnedNow) {
    const o = state.rosterOrder;
    if (row.dataset.primary === '1') o.unpinned = (o.unpinned || []).filter((k) => k !== key);
    else o.pinned = [...(o.pinned || []).filter((k) => k !== key), key];
  }
  commitSection(section, keys);
  if (pinnedNow) toast('已置顶，放在这里了');
}

/**
 * A row in the list: its menu (置顶 / 取消置顶, and 上移 / 下移 when pinned). Any row drags
 * (a mouse after a few pixels; a finger after holding it half a second - holding without
 * moving opens its menu) and lands among the pinned ones: a row that was not pinned is pinned
 * where it is dropped (1.5.61 beginner test: an unpinned row did not move and nothing said why).
 * A pinned row also moves with Alt+↑ / Alt+↓.
 */
function armRowOrder(row, { key, section, primary = false, pinned = false }) {
  row.dataset.orderKey = key;
  row.dataset.section = section;
  if (primary) row.dataset.primary = '1';
  if (pinned) {
    row.dataset.pinned = '1';
    row.classList.add('pinned');
    row.querySelector('.bot-name-text')?.after(pinMark());
  }
  const { menu, more } = addOrderMenu(row);
  row.setAttribute('aria-roledescription', '可拖动排序');
  row.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    if (row.dataset.pinned !== '1') { toast('没置顶的按最新动静排：先置顶，才能自己排。'); return; }
    moveRowBy(row, event.key === 'ArrowUp' ? -1 : 1);
  });
  // Dragging: a mouse through pointer events; a finger through touch events (once a finger
  // moves, the browser takes pointer events for scrolling - 1.5.61: a held row never moved).
  let press = null;
  const lift = () => {
    press.dragging = true;
    row.classList.add('dragging');
    press.line = el('div', 'order-drop');
    row.after(press.line);
  };
  const stop = () => {
    if (!press) return;
    clearTimeout(press.timer);
    row.classList.remove('dragging', 'lifting');
    row.style.transform = '';
    press.line?.remove();
    press = null;
  };
  const follow = (y) => {
    row.style.transform = `translateY(${y - press.y}px)`;
    // Where it would land: among the pinned rows, before the first whose middle is below the finger or pointer.
    const rows = sectionRows(section).filter((r) => r !== row && r.dataset.pinned === '1');
    const before = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    press.before = before || null;
    const last = rows[rows.length - 1];
    if (before) before.before(press.line);
    else if (last) last.after(press.line);
    else sectionRows(section).find((r) => r !== row)?.before(press.line); // nothing pinned here yet: the top
  };
  const drop = () => {
    const { before } = press;
    stop();
    row.dataset.dragged = '1';
    setTimeout(() => { delete row.dataset.dragged; }, 400);
    placePinned(row, before);
  };
  const skip = (target) => target.closest('.bot-more, .menu, .av, .stack');
  // A mouse: a few pixels of movement start the drag.
  row.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || skip(event.target)) return;
    press = { y: event.clientY, dragging: false };
    const onMove = (e) => {
      if (!press) return;
      if (!press.dragging) { if (Math.abs(e.clientY - press.y) < 6) return; lift(); }
      follow(e.clientY);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      if (press?.dragging) drop(); else stop();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  });
  // A finger: hold half a second, then move; held and let go without moving, its menu.
  row.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || skip(event.target)) return;
    const t = event.touches[0];
    press = { x: t.clientX, y: t.clientY, dragging: false };
    press.timer = setTimeout(() => {
      if (!press) return;
      row.classList.add('lifting');
      lift();
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* fine */ } }
    }, 450);
  }, { passive: true });
  row.addEventListener('touchmove', (event) => {
    if (!press) return;
    const t = event.touches[0];
    if (!press.dragging) {
      // Moved before the hold: a scroll, not a drag.
      if (Math.abs(t.clientY - press.y) > 8 || Math.abs(t.clientX - press.x) > 8) stop();
      return;
    }
    event.preventDefault();
    press.moved = press.moved || Math.abs(t.clientY - press.y) > 8;
    follow(t.clientY);
  }, { passive: false });
  row.addEventListener('touchend', (event) => {
    if (!press) return;
    if (!press.dragging) { stop(); return; }
    event.preventDefault();
    if (press.moved) { drop(); return; }
    // Held without moving: its menu.
    stop();
    row.dataset.dragged = '1';
    setTimeout(() => { delete row.dataset.dragged; }, 400);
    toggleMenu(menu, more);
  });
  row.addEventListener('touchcancel', () => stop());
  // A drag (or a hold) is not a click on the row.
  row.addEventListener('click', (event) => { if (row.dataset.dragged) { event.stopImmediatePropagation(); event.preventDefault(); } }, true);
}
