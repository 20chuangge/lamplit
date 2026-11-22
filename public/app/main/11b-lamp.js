'use strict';
// Lamplit page, part 11b (between machines and wiring, which draws the first faces): the living avatar (redesign step 2) - a face that shows what its bot is doing; CSS moves it on its own layers, no frame loop.
/* ---------------------------------------------------------------------
   The seven states of the design study (交付/Lamplit-界面设计调研.md §3.3),
   from what the page already knows (attention and the link):
     idle     nothing going on
     think    a turn is running, no tool yet        eyes up, breathes
     work     a turn is running a tool or a list    eyes down, the lamp glows
     wait     an approval, a decision or a question waits on the human
              violet ring and badge, looks at the card
     done     a new result (in the list: not looked at yet; on the open
              chat: for 2.6 s after a turn ends)    happy eyes, a hop
     stuck    the last turn ended in an error, the budget, no progress or
              the step limit (attention.failed)    half-shut eyes, red badge
     offline  the machine does not answer   eyes shut, lamp off, grey, row faded
   Large faces (chat header, empty chat, bot page, avatar editor): the eyes
   follow the pointer, look at the composer while you type and at the card
   that waits on you, and blink now and then - CSS transforms and opacity on
   layers of their own, no frame loop (see lampSvg). Timers stop when the tab
   is hidden, the Android app is in the background or motion is off. List
   faces are the cached face images of 02-avatars.js with other eyes; one page
   timer makes one row blink now and then.
   Motion is off when the system asks for less motion or 外观 → 头像动起来
   is off (this device only): the state still shows, nothing moves.
   --------------------------------------------------------------------- */
const LAMP_MOTION_KEY = 'desk.lampMotion';
const LAMP_EYES = { idle: 'open', think: 'up', work: 'down', wait: 'open', done: 'happy', stuck: 'half', offline: 'shut' };

/** One state from a chat's attention item and where its bot lives. Pure (smoke tests it). */
function lampStateOf(item, { online = true, linkDown = false, onScreen = false } = {}) {
  if (!online || linkDown) return 'offline';
  if (item?.needsYou || item?.asking) return 'wait';
  if (item?.working) return item.doing?.tool || item.doing?.total ? 'work' : 'think';
  if (item?.failed) return 'stuck';
  if (item?.unread && !onScreen) return 'done';
  return 'idle';
}

/** A bot's state now. A bot on another machine carries remote.online. */
function lampStateFor(bot, { key = '', online } = {}) {
  if (!bot) return 'idle';
  const k = key || `bot:${bot.id}`;
  const remote = bot.remote || null;
  return lampStateOf(attentionItem(k), {
    online: online !== undefined ? Boolean(online) : !remote || remote.online !== false,
    linkDown: Boolean(state.conn?.offline),
    onScreen: k === currentChatKey(),
  });
}

function lampMotionOn() {
  try { return localStorage.getItem(LAMP_MOTION_KEY) !== 'off'; } catch { return true; }
}
const lampReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
function lampStill() {
  return lampReduce.matches || !lampMotionOn();
}

/* ---- the list: another face image, no frames ---- */
function lampMarkRow(av, bot, opts = {}) {
  if (!av || !bot) return;
  const st = lampStateFor(bot, opts);
  av.dataset.lamp = st;
  const face = av.querySelector('.av-face');
  const a = avatarOf(faceOf(bot));
  if (face) face.style.backgroundImage = faceSvg(a.color, FACE_ZOOM[a.shape] || 1, LAMP_EYES[st]);
  // 1.5.57: the shut-eyes face a row shows when it blinks (lampRowBlink below, style.css .av.lamp-blink).
  av.style.setProperty('--lamp-shut', faceSvg(a.color, FACE_ZOOM[a.shape] || 1, 'shut'));
}

/* The list blinks: every 3.5-8 s one idle (or waiting) row in view blinks once - a 0.22 s CSS
   animation on that row only. One timer for the page, none per row, no frames in between.
   (1.5.57: an endless 9 s blink on every row kept the desktop app drawing frames all the time,
   about 7% of a core with 30 rows; this costs one short animation now and then.) */
let lampBlinkTimer = 0;
function lampRowBlinkSoon() {
  clearTimeout(lampBlinkTimer);
  lampBlinkTimer = 0;
  if (document.hidden || lampAppAway || lampStill()) return;
  lampBlinkTimer = setTimeout(lampRowBlink, 3500 + Math.random() * 4500);
}
function lampRowBlink() {
  lampBlinkTimer = 0;
  const list = document.getElementById('bot-list');
  const box = list?.getBoundingClientRect();
  const rows = box ? [...list.querySelectorAll('.bot-av[data-lamp="idle"]:not(.has-image), .bot-av[data-lamp="wait"]:not(.has-image)')]
    .filter((av) => { const r = av.getBoundingClientRect(); return r.height && r.bottom > box.top && r.top < box.bottom; }) : [];
  const av = rows[Math.floor(Math.random() * rows.length)];
  if (av) {
    av.classList.remove('lamp-blink');
    void av.offsetWidth; // the same row may blink again
    av.classList.add('lamp-blink');
    av.addEventListener('animationend', () => av.classList.remove('lamp-blink'), { once: true });
  }
  lampRowBlinkSoon();
}

/** How far the eyes move at a full look, in face units (100 = the face's width): small faces
    move a larger share, so a 40 px header face looks around visibly (1.5.57: at 30 px it was 2 px). */
function lampReach(size) {
  const n = Number(size) || 40;
  return n <= 44 ? 13 : n <= 64 ? 11.5 : 10;
}

/* ---- the large faces ----
   Layers, so that nothing is ever repainted while a face lives (1.5.57: an SVG whose eyes moved
   was redrawn every frame - 8% of a core at rest in the desktop app, 39% with the pointer moving):
     .lamp-face   the body: colour, light, picture - an SVG drawn once
     .lamp-glow   the lamp inside: an HTML layer, only its opacity changes
     .lamp-eyes   the eyes: an HTML layer, only its transform changes (a CSS transition does the
                  easing); open eyes blink with transform: scaleY; the happy / half / shut eyes
                  are a small SVG inside it, shown by state
     .lamp-ring-wrap  the ring outside the shape: only its opacity changes
   No frame loop: the pointer sets where the eyes go (at most ~12 times a second, only near the
   face), one page timer fires the odd glance or blink, CSS animates. */
let lampUid = 0;
function lampSvg(a) {
  const shape = AVATAR_SHAPES.find((s) => s.id === a.shape) || AVATAR_SHAPES[0];
  const zoom = FACE_ZOOM[a.shape] || 1;
  const id = `lamp${(lampUid += 1)}`;
  const picture = Boolean(a.hasImage && a.imageUrl);
  const body = picture
    ? `<rect width="100" height="100" fill="${a.color}"/><image class="lamp-img" href="${escapeHtml(a.imageUrl)}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="100" height="100" fill="${a.color}"/><rect width="100" height="100" fill="url(#${id}l)"/>`;
  const alt = [36.5, 55].map((x) => `<path class="e-happy" d="M${x - 0.5},50 q4.75,-8 9.5,0" fill="none" stroke="currentColor" stroke-width="3.8" stroke-linecap="round"/>`
    + `<path class="e-shut" d="M${x},48 h8.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" opacity=".85"/>`
    // 卡住: the same drooping lids as the list face (02-avatars.js FACE_EYES.half)
    + FACE_EYES.half(x, 'currentColor').replace('<path ', '<path class="e-half" ').replace(/'/g, '"')).join('');
  const eyes = picture ? '' : `<span class="lamp-eyes-clip"><span class="lamp-eyes"><i class="lamp-eye l"></i><i class="lamp-eye r"></i>`
    + `<svg class="lamp-eyes-alt" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g transform="translate(50 50) scale(${zoom}) translate(-50 -50)">${alt}</g></svg></span></span>`;
  return `<svg class="lamp-face" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs>`
    + `<clipPath id="${id}c"><path d="${shape.path}"/></clipPath>`
    + `<linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>`
    + `</defs><g clip-path="url(#${id}c)">${body}</g></svg>`
    + (picture ? '' : '<span class="lamp-glow"></span>')
    + eyes
    + `<span class="lamp-ring-wrap"><svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path class="lamp-ring" d="${shape.path}" transform="translate(50 50) scale(1.12) translate(-50 -50)"/></svg></span>`
    + `<i class="lamp-badge" aria-hidden="true"></i>`;
}

const lampItems = new Set();
const lampPointer = { x: -1, y: -1, t: 0, out: true };
let lampTyping = 0;
let lampGazeAt = 0;
let lampGazeTimer = 0;
let lampIdleTimer = 0;
let lampAppAway = false;
const lampSeen = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.target.lampItem) e.target.lampItem.visible = e.isIntersecting;
  })
  : null;

/** Draw a living face into host (its own classes are kept in extra). */
function lampMount(host, bot, size, extra = '') {
  if (!host || !bot) return;
  const a = avatarOf(faceOf(bot));
  // av-s-<shape> gives the shape's mask as --av-mask (the host itself is not masked: .av.lamp-live).
  host.className = `av lamp-live av-s-${a.shape}${extra ? ` ${extra}` : ''}`;
  if (size) host.style.setProperty('--av-size', `${size}px`);
  host.style.setProperty('--av-color', a.color);
  const px = Number(size) || host.getBoundingClientRect().width || 40;
  host.style.setProperty('--lamp-zoom', String(FACE_ZOOM[a.shape] || 1));
  host.style.setProperty('--lamp-r', `${((lampReach(px) * px) / 100).toFixed(2)}px`); // a full look, in px
  host.style.setProperty('--lamp-blink-ms', `${px <= 44 ? 190 : 150}ms`); // a small face blinks a little slower
  host.style.color = isLightColor(a.color) ? '#1c1a17' : '#fff'; // the eyes' ink, like the list face's
  host.dataset.shape = a.shape;
  host.toggleAttribute('data-img', Boolean(a.hasImage && a.imageUrl));
  host.innerHTML = lampSvg(a);
  // A picture that does not load gives the face back.
  host.querySelector('.lamp-img')?.addEventListener('error', () => lampMount(host, { ...bot, avatar: { ...avatarOf(bot), hasImage: false, imageUrl: '' } }, size, extra), { once: true });
  const old = host.lampItem;
  const it = {
    host,
    botId: bot.id,
    reach: lampReach(px),
    eyes: host.querySelector('.lamp-eyes'),
    look: '',
    visible: true,
    doneTimer: 0,
  };
  if (old) { clearTimeout(old.doneTimer); lampItems.delete(old); }
  host.lampItem = it;
  lampItems.add(it);
  lampSeen?.observe(host);
  lampSetState(it, lampStateFor(lampBot(it) || bot), old?.host === host ? host.dataset.state : '');
  lampIdleSoon();
}

function lampBot(it) {
  return botById(it.botId) || (typeof remoteBotById === 'function' ? remoteBotById(it.botId) : null);
}

function lampSetState(it, next, prev = it.host.dataset.state || '') {
  // The open chat's turn just ended well: a moment of 做完了 before it rests.
  const key = `bot:${it.botId}`;
  if ((prev === 'work' || prev === 'think') && next === 'idle' && key === currentChatKey()) {
    next = 'done';
    clearTimeout(it.doneTimer);
    it.doneTimer = setTimeout(() => { it.doneTimer = 0; if (it.host.isConnected) lampSetState(it, lampStateFor(lampBot(it))); }, 2600);
  }
  if (it.doneTimer && next === 'idle') return; // let the moment finish
  if (prev === next) return;
  it.host.dataset.state = next;
  if (next === 'done' && !lampStill()) {
    it.host.classList.remove('lamp-hop');
    void it.host.offsetWidth; // restart the hop
    it.host.classList.add('lamp-hop');
  }
  lampGaze(it); // a state that waits on you looks at the card; the others take their pose from CSS
}

/** Attention, the link or the model changed: every face says it again. */
function lampRefresh() {
  // The list: the same rows, other face images (no redraw of the list).
  for (const row of document.querySelectorAll('#bot-list .bot[data-bot]')) {
    const id = row.dataset.bot;
    const bot = botById(id) || remoteBotById(id);
    const av = row.querySelector('.bot-av');
    if (bot && av) lampMarkRow(av, bot, row.classList.contains('remote') ? { key: `bot:${id}`, online: !row.classList.contains('off') } : {});
  }
  for (const it of lampItems) {
    if (!it.host.isConnected) { lampItems.delete(it); lampSeen?.unobserve(it.host); continue; }
    const bot = lampBot(it);
    if (bot) lampSetState(it, lampStateFor(bot));
  }
}

/** Where a face looks, -1..1 on each axis; null = it does not follow (its state has a pose of its own). */
function lampTarget(it, now) {
  const st = it.host.dataset.state;
  if (st !== 'idle' && st !== 'wait') return null;
  const r = it.host.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let tx = lampPointer.x;
  let ty = lampPointer.y;
  const card = st === 'wait' ? document.querySelector('.messages .approval.pending, #decision-strip:not([hidden]), .takeover-card') : null;
  const field = now - lampTyping < 1600 ? $('composer') : null;
  const at = (card && card.getClientRects().length ? card : null) || (field && field.getClientRects().length ? field : null);
  if (at) {
    const fr = at.getBoundingClientRect();
    tx = fr.left + Math.min(fr.width / 2, 140);
    ty = fr.top + Math.min(fr.height / 2, 60);
  } else if (lampPointer.out || lampPointer.x < 0) {
    return [0, 0]; // the pointer left the window: it looks ahead
  }
  const dx = tx - cx;
  const dy = ty - cy;
  const d = Math.hypot(dx, dy) || 1;
  if (!at && d > 900) return [0, 0]; // far away: it stops following
  const k = Math.tanh(d / 260); // far: a full look; close by: a little
  return [(dx / d) * k, (dy / d) * k];
}

/** Point a face's eyes: one transform; the CSS transition eases it on the compositor. */
function lampLook(it, x, y) {
  if (!it.eyes) return;
  // In steps of 1/20 of a full look: a pointer that barely moved changes nothing.
  x = Math.round(x * 20) / 20;
  y = Math.round(y * 20) / 20;
  const value = x || y ? `translate(calc(var(--lamp-r) * ${x.toFixed(3)}), calc(var(--lamp-r) * ${(y * 0.7).toFixed(3)}))` : '';
  if (value === it.look) return;
  it.look = value;
  it.eyes.style.transform = value;
}

function lampGaze(it, now = performance.now()) {
  if (!it.eyes) return;
  if (lampStill() || !it.visible) { lampLook(it, 0, 0); return; }
  const t = lampTarget(it, now);
  if (t) lampLook(it, t[0], t[1]); else lampLook(it, 0, 0); // posed states: CSS moves the eyes
}

/** The pointer moved: the faces look, at most ~12 times a second (the CSS transition fills in), and only while it is near. */
function lampGazeSoon() {
  if (lampGazeTimer || lampStill() || document.hidden || lampAppAway) return;
  const wait = Math.max(0, 80 - (performance.now() - lampGazeAt));
  lampGazeTimer = setTimeout(() => {
    lampGazeTimer = 0;
    lampGazeAt = performance.now();
    for (const it of lampItems) if (it.host.isConnected) lampGaze(it, lampGazeAt);
  }, wait);
}

/* Nobody moving: now and then one face glances or blinks - a CSS transition or a CSS animation,
   fired by this one timer for the whole page. Nothing runs in between. */
function lampIdleSoon() {
  clearTimeout(lampIdleTimer);
  lampIdleTimer = 0;
  if (document.hidden || lampAppAway || lampStill() || !lampItems.size) return;
  lampIdleTimer = setTimeout(lampIdle, 4000 + Math.random() * 5000);
}
function lampIdle() {
  lampIdleTimer = 0;
  const now = performance.now();
  const faces = [...lampItems].filter((it) => it.host.isConnected && it.visible && it.eyes && it.host.dataset.state !== 'offline');
  const it = faces[Math.floor(Math.random() * faces.length)];
  if (it) {
    const quiet = lampPointer.out || now - lampPointer.t > 5000;
    if (quiet && it.host.dataset.state === 'idle' && Math.random() < 0.35) {
      // a glance, then back to rest on the next turn of this timer
      const away = it.look === '' ? [(Math.random() * 2 - 1) * 0.7, (Math.random() * 2 - 1) * 0.45] : [0, 0];
      lampLook(it, away[0], away[1]);
    } else {
      it.host.classList.remove('lamp-blinking');
      void it.host.offsetWidth; // the same face may blink again
      it.host.classList.add('lamp-blinking');
      it.eyes.addEventListener('animationend', () => it.host.classList.remove('lamp-blinking'), { once: true });
    }
  }
  lampIdleSoon();
}

/** Hidden tab, or the Android app in the background: nothing runs until it is back. */
function lampPause(away) {
  if (away) {
    clearTimeout(lampIdleTimer); lampIdleTimer = 0;
    clearTimeout(lampGazeTimer); lampGazeTimer = 0;
    clearTimeout(lampBlinkTimer); lampBlinkTimer = 0;
    return;
  }
  lampIdleSoon();
  lampRowBlinkSoon();
}

function lampApplyMotion() {
  document.documentElement.classList.toggle('lamp-still', lampStill());
  const box = $('lamp-motion');
  if (box) box.checked = lampMotionOn();
  for (const it of lampItems) lampGaze(it); // still: eyes back to rest
  lampIdleSoon();
  lampRowBlinkSoon(); // motion off: no more row blinks
}

window.addEventListener('pointermove', (e) => {
  lampPointer.x = e.clientX;
  lampPointer.y = e.clientY;
  lampPointer.t = performance.now();
  lampPointer.out = false;
  lampGazeSoon();
}, { passive: true });
document.addEventListener('pointerout', (e) => {
  if (e.relatedTarget) return;
  lampPointer.out = true; // left the window
  lampGazeSoon();
});
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'composer') return;
  lampTyping = performance.now();
  lampGazeSoon();
}, true);
document.addEventListener('visibilitychange', () => lampPause(document.hidden));
// Capacitor (the Android app): its App plugin says when the app leaves and comes back.
try {
  window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => { lampAppAway = !isActive; lampPause(lampAppAway); });
} catch { /* not in the app */ }
document.addEventListener('pause', () => { lampAppAway = true; lampPause(true); });
document.addEventListener('resume', () => { lampAppAway = false; lampPause(false); });
lampReduce.addEventListener?.('change', lampApplyMotion);
$('lamp-motion')?.addEventListener('change', (event) => {
  try { localStorage.setItem(LAMP_MOTION_KEY, event.target.checked ? 'on' : 'off'); } catch { /* private mode */ }
  lampApplyMotion();
});
lampApplyMotion();
