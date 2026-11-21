'use strict';
// Lamplit page, part 11b (between machines and wiring, which draws the first faces): the living avatar (redesign step 2) - a face that shows what its bot is doing; one animation loop for the few large faces, list faces only change.
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
   Large faces (chat header, empty chat, bot page, avatar editor) are inline
   SVG: the eyes follow the pointer, look at the composer while you type and
   at the card that waits on you, and blink now and then. One
   requestAnimationFrame loop for all of them; it stops when the faces are
   still, when the tab is hidden or the Android app goes to the background,
   and when motion is off. List faces are the
   cached face images of 02-avatars.js with other eyes: no timer, no frame.
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
}

/* ---- the large faces ---- */
let lampUid = 0;
function lampSvg(a) {
  const shape = AVATAR_SHAPES.find((s) => s.id === a.shape) || AVATAR_SHAPES[0];
  const zoom = FACE_ZOOM[a.shape] || 1;
  const ink = isLightColor(a.color) ? '#1c1a17' : '#fff';
  const id = `lamp${(lampUid += 1)}`;
  const eyes = [36.5, 55].map((x) => `<rect class="e-open" x="${x}" y="39" width="8.5" height="15" rx="4.25" fill="${ink}"/>`
    + `<path class="e-happy" d="M${x - 0.5},50 q4.75,-8 9.5,0" fill="none" stroke="${ink}" stroke-width="3.8" stroke-linecap="round"/>`
    + `<path class="e-shut" d="M${x},48 h8.5" fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round" opacity=".85"/>`
    // 卡住: the same drooping lids as the list face (02-avatars.js FACE_EYES.half)
    + FACE_EYES.half(x, ink).replace('<path ', '<path class="e-half" ').replace(/'/g, '"')).join('');
  const body = a.hasImage && a.imageUrl
    ? `<rect width="100" height="100" fill="${a.color}"/><image class="lamp-img" href="${escapeHtml(a.imageUrl)}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="100" height="100" fill="${a.color}"/><rect width="100" height="100" fill="url(#${id}l)"/>`
      + `<rect class="lamp-glow" width="100" height="100" fill="url(#${id}g)"/>`
      + `<g transform="translate(50 50) scale(${zoom}) translate(-50 -50)"><g class="eyes">${eyes}</g></g>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs>`
    + `<clipPath id="${id}c"><path d="${shape.path}"/></clipPath>`
    + `<linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>`
    + `<radialGradient id="${id}g" cx="50%" cy="38%" r="58%"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `</defs><path class="lamp-ring" d="${shape.path}" transform="translate(50 50) scale(1.12) translate(-50 -50)"/>`
    + `<g class="lamp-body"><g clip-path="url(#${id}c)">${body}</g></g></svg><i class="lamp-badge" aria-hidden="true"></i>`;
}

const lampItems = new Set();
const lampPointer = { x: -1, y: -1, t: 0 };
let lampTyping = 0;
let lampRaf = 0;
let lampLast = 0;
let lampWake = 0;
const lampSeen = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.target.lampItem) e.target.lampItem.visible = e.isIntersecting;
    lampKick();
  })
  : null;

/** Draw a living face into host (its own classes are kept in extra). */
function lampMount(host, bot, size, extra = '') {
  if (!host || !bot) return;
  const a = avatarOf(faceOf(bot));
  host.className = `av lamp-live${extra ? ` ${extra}` : ''}`;
  if (size) host.style.setProperty('--av-size', `${size}px`);
  host.style.setProperty('--av-color', a.color);
  host.dataset.shape = a.shape;
  host.toggleAttribute('data-img', Boolean(a.hasImage && a.imageUrl));
  host.innerHTML = lampSvg(a);
  // A picture that does not load gives the face back.
  host.querySelector('.lamp-img')?.addEventListener('error', () => lampMount(host, { ...bot, avatar: { ...avatarOf(bot), hasImage: false, imageUrl: '' } }, size, extra), { once: true });
  const old = host.lampItem;
  const it = {
    host,
    botId: bot.id,
    eyes: host.querySelector('.eyes'),
    open: [...host.querySelectorAll('.e-open')],
    x: old?.x || 0, y: old?.y || 0, vx: 0, vy: 0,
    blinkT: -1e9, nextBlink: performance.now() + 1200 + Math.random() * 2800,
    glance: { x: 0, y: 0, until: 0 },
    visible: true,
    doneTimer: 0,
  };
  if (old) { clearTimeout(old.doneTimer); lampItems.delete(old); }
  host.lampItem = it;
  lampItems.add(it);
  lampSeen?.observe(host);
  lampSetState(it, lampStateFor(lampBot(it) || bot), old?.host === host ? host.dataset.state : '');
  lampKick();
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
  it.nextBlink = performance.now() + 400;
  lampKick();
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

/** Where a face looks: -1..1 on each axis. */
function lampTarget(it, now) {
  const st = it.host.dataset.state;
  if (st === 'offline') return [0, 0.25];
  if (st === 'stuck') return [0, 0.35];
  if (st === 'think') return [0.55 + 0.2 * Math.sin(now / 900), -0.75];
  if (st === 'work') return [0.35 * Math.sin(now / 700), 0.65];
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
  } else if (lampPointer.x < 0 || now - lampPointer.t > 5000) {
    // Nobody moving: now and then it looks around, mostly it rests.
    if (now > it.glance.until) {
      const rest = Math.random() < 0.55;
      it.glance = { x: rest ? 0 : (Math.random() * 2 - 1) * 0.7, y: rest ? 0 : (Math.random() * 2 - 1) * 0.45, until: now + 1400 + Math.random() * 2600 };
    }
    return [it.glance.x, it.glance.y];
  }
  const dx = tx - cx;
  const dy = ty - cy;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.tanh(d / 260); // far away: a full look; close by: a little
  return [(dx / d) * k, (dy / d) * k];
}

/** A still face: the state's own look, no spring, no blink. */
function lampPose(it) {
  const st = it.host.dataset.state;
  const [x, y] = st === 'think' ? [0.5, -0.7] : st === 'work' ? [0, 0.6] : st === 'stuck' || st === 'offline' ? [0, 0.3] : [0, 0];
  it.x = x; it.y = y; it.vx = 0; it.vy = 0;
  it.eyes?.setAttribute('transform', `translate(${(x * 7).toFixed(2)} ${(y * 5).toFixed(2)})`);
  for (const e of it.open) e.style.transform = '';
}

function lampFrame(now) {
  lampRaf = 0;
  if (document.hidden || lampAppAway) return; // hidden or in the background: lampPause starts it again
  const dt = Math.min(0.05, (now - (lampLast || now)) / 1000);
  lampLast = now;
  const still = lampStill();
  let busy = false;
  let wake = Infinity;
  for (const it of lampItems) {
    if (!it.host.isConnected) { lampItems.delete(it); lampSeen?.unobserve(it.host); continue; }
    if (!it.visible || !it.eyes) continue;
    if (still) { lampPose(it); continue; }
    const [tx, ty] = lampTarget(it, now);
    // A spring: stiffness 120, damping 16 - keeps up without a wobble.
    it.vx += (120 * (tx - it.x) - 16 * it.vx) * dt;
    it.vy += (120 * (ty - it.y) - 16 * it.vy) * dt;
    it.x += it.vx * dt;
    it.y += it.vy * dt;
    const st = it.host.dataset.state;
    let s = 1;
    if (st !== 'offline') {
      // A blink every 2.5-6 s, now and then twice.
      if (now >= it.nextBlink) {
        it.blinkT = now;
        it.nextBlink = now + 2500 + Math.random() * 3500;
        if (Math.random() < 0.18) it.nextBlink = now + 260;
      }
      const b = (now - it.blinkT) / 150;
      if (b >= 0 && b < 1) s = 1 - 0.9 * Math.sin(b * Math.PI);
      wake = Math.min(wake, it.nextBlink);
      if (it.glance.until > now) wake = Math.min(wake, it.glance.until);
      if (lampPointer.t > 0 && now - lampPointer.t < 5000) wake = Math.min(wake, lampPointer.t + 5001);
    }
    it.eyes.setAttribute('transform', `translate(${(it.x * 7).toFixed(2)} ${(it.y * 5).toFixed(2)})`);
    for (const e of it.open) e.style.transform = s < 1 ? `scaleY(${s.toFixed(3)})` : '';
    if (Math.abs(it.vx) + Math.abs(it.vy) > 0.002 || Math.abs(tx - it.x) + Math.abs(ty - it.y) > 0.002 || s < 1) busy = true;
    if (st === 'think' || st === 'work') busy = true; // its eyes keep moving slowly while it works
    if (st === 'wait' || now - lampTyping < 1600) wake = Math.min(wake, now + 400);
  }
  clearTimeout(lampWake);
  if (busy) { lampRaf = requestAnimationFrame(lampFrame); return; }
  lampLast = 0;
  // Still: no loop, one alarm for the next blink or glance.
  if (wake < Infinity && !still) lampWake = setTimeout(lampKick, Math.max(16, wake - now));
}

let lampAppAway = false;
function lampKick() {
  if (!lampRaf && !document.hidden && !lampAppAway && lampItems.size) lampRaf = requestAnimationFrame(lampFrame);
}

/** Hidden tab, or the Android app in the background: nothing runs until it is back. */
function lampPause(away) {
  if (away) { cancelAnimationFrame(lampRaf); lampRaf = 0; clearTimeout(lampWake); return; }
  lampLast = 0;
  lampKick();
}

function lampApplyMotion() {
  document.documentElement.classList.toggle('lamp-still', lampStill());
  const box = $('lamp-motion');
  if (box) box.checked = lampMotionOn();
  lampKick();
}

window.addEventListener('pointermove', (e) => {
  lampPointer.x = e.clientX;
  lampPointer.y = e.clientY;
  lampPointer.t = performance.now();
  if (!lampStill()) lampKick();
}, { passive: true });
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'composer') return;
  lampTyping = performance.now();
  if (!lampStill()) lampKick();
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
