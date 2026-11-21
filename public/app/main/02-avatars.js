'use strict';
// Lamplit page, part 2 of 12: avatars - faces, shapes, avatar nodes. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   avatars
   Fifteen silhouettes drawn for Desk (not Grok Bot's set). Each path lives
   in a 100x100 viewBox; one CSS mask per shape is generated from this array,
   so the sidebar, the chat header and the customizer all clip identically.
   --------------------------------------------------------------------- */
function rosettePath(lobes, base, amp, steps = 144) {
  const pts = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const r = base + amp * Math.cos(lobes * t);
    pts.push(`${(50 + r * Math.sin(t)).toFixed(1)},${(50 - r * Math.cos(t)).toFixed(1)}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** An irregular amoeba: several sine harmonics so no two lobes match. */
function blobPath(steps = 160) {
  const pts = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const r = 33 + 8 * Math.cos(3 * t + 0.7) + 4.5 * Math.cos(5 * t + 1.9) + 2.2 * Math.cos(7 * t + 0.3);
    pts.push(`${(50 + r * Math.sin(t)).toFixed(1)},${(50 - r * Math.cos(t)).toFixed(1)}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** A regular polygon with rounded corners (quadratic joins), centred at 50,50. */
function roundedPolygon(sides, radius, corner, rotate = -90) {
  const pts = [];
  for (let i = 0; i < sides; i += 1) {
    const a = ((rotate + (360 / sides) * i) * Math.PI) / 180;
    pts.push([50 + radius * Math.cos(a), 50 + radius * Math.sin(a)]);
  }
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const side = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const t = Math.min(0.45, corner / side);
  let d = '';
  for (let i = 0; i < sides; i += 1) {
    const prev = pts[(i + sides - 1) % sides];
    const cur = pts[i];
    const next = pts[(i + 1) % sides];
    const a = lerp(cur, prev, t);
    const b = lerp(cur, next, t);
    d += `${i ? ' L' : 'M'}${a[0].toFixed(1)},${a[1].toFixed(1)} Q${cur[0].toFixed(1)},${cur[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
  }
  return `${d} Z`;
}

/* The picker shows a short, calm set. Older shapes (picker:false) still
   render for bots that use them, drawn as their nearest calm sibling. */
const AVATAR_SHAPES = [
  { id: 'squircle', label: '方圆', path: 'M30,3 H70 C85,3 97,15 97,30 V70 C97,85 85,97 70,97 H30 C15,97 3,85 3,70 V30 C3,15 15,3 30,3 Z' },
  { id: 'circle', label: '圆形', path: 'M50,3 A47,47 0 1 1 49.99,3 Z' },
  { id: 'blob', label: '有机', path: blobPath() },
  { id: 'star', label: '星芒', path: rosettePath(5, 40, 8) },
  { id: 'flower', label: '花瓣', path: rosettePath(6, 41, 6) },
  { id: 'hex', label: '六边', path: roundedPolygon(6, 49, 14, 0) },
  { id: 'octagon', label: '八边', picker: false, path: roundedPolygon(8, 49, 10, -22.5) },
  { id: 'diamond', label: '菱形', path: roundedPolygon(4, 50, 16) },
  { id: 'arch', label: '拱形', path: 'M5,98 V47 A45,45 0 0 1 95,47 V98 Z' },
  { id: 'leaf', label: '叶片', path: 'M12,88 C12,44 40,12 88,12 C88,56 60,88 12,88 Z' },
  { id: 'gem', label: '宝石', picker: false, path: 'M28,10 H72 L96,40 L50,96 L4,40 Z' },
  { id: 'wave', label: '波浪', picker: false, path: 'M4,24 C4,12 12,4 24,4 H76 C88,4 96,12 96,24 V80 C86,90 72,94 58,88 C46,83 36,94 24,94 C15,94 8,88 4,82 Z' },
  { id: 'ring', label: '圆环', picker: false, path: 'M50,2 A48,48 0 1 1 49.99,2 Z M50,88 A6.5,6.5 0 1 0 50.01,88 Z' },
  { id: 'drop', label: '水滴', path: 'M50,3 C50,3 88,44 88,62 C88,82 71,98 50,98 C29,98 12,82 12,62 C12,44 50,3 50,3 Z' },
  { id: 'chip', label: '芯片', picker: false, path: 'M20,8 H80 C87,8 92,13 92,20 V80 C92,87 87,92 80,92 H20 C13,92 8,87 8,80 V20 C8,13 13,8 20,8 Z M21,-4 H36 V19 H21 Z M64,-4 H79 V19 H64 Z M21,81 H36 V104 H21 Z M64,81 H79 V104 H64 Z' },
];

/* Muted, slightly dusty tones: they sit well on both themes and never shout. */
/* Muted, slightly dusty tones: they sit well on both themes and never shout
   (the first palette, chosen again by the user over gray and pastel ones). */
const AVATAR_COLORS = [
  '#7c6cf0', '#5b7bea', '#3d9be0', '#2bab9c', '#4cae6e', '#d79b3a', '#e0744f', '#d65c7a', '#a46ad8', '#6b7280',
];

const AVATAR_DEFAULT = { shape: 'squircle', color: '#7c6cf0' };
const SHAPE_IDS = new Set(AVATAR_SHAPES.map((s) => s.id));
const LEGACY_SHAPES = { octagon: 'hex', gem: 'diamond', wave: 'squircle', ring: 'circle', chip: 'squircle' };
const PICKER_SHAPES = AVATAR_SHAPES.filter((shape) => shape.picker !== false);

/* ---------------------------------------------------------------------
   The face: the bot's colour as a soft top-lit plate and two rounded eyes.
   Flat, quiet, legible at 24px. No mouth, no letters, no 3D clay.
   --------------------------------------------------------------------- */
const faceCache = new Map();

/** Narrow silhouettes would crop centred eyes; shrink them per shape. */
const FACE_ZOOM = { star: 0.86, flower: 0.9, leaf: 0.78, diamond: 0.84, drop: 0.92, arch: 0.96 };

/** Relative luminance above ~0.45: dark eyes read better than white ones. */
function isLightColor(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
}

/* Eyes for a state (redesign step 2), drawn once per colour and cached: a list
   of avatars changes its face, never animates it. open / up (thinking) /
   down (working) / happy (done) / half (stuck) / shut (offline, no model). */
const FACE_EYES = {
  open: (x, ink) => `<rect x='${x}' y='39' width='8.5' height='15' rx='4.25' fill='#000' opacity='.16' transform='translate(0 1.6)'/>`
    + `<rect x='${x}' y='39' width='8.5' height='15' rx='4.25' fill='${ink}'/>`,
  up: (x, ink) => `<rect x='${x + 2.5}' y='35' width='8.5' height='15' rx='4.25' fill='${ink}'/>`,
  down: (x, ink) => `<rect x='${x}' y='43' width='8.5' height='13' rx='4.25' fill='${ink}'/>`,
  happy: (x, ink) => `<path d='M${x - 0.5},50 q4.75,-8 9.5,0' fill='none' stroke='${ink}' stroke-width='3.8' stroke-linecap='round'/>`,
  // 卡住: drooping lids, the outer corner lower - reads as "not right" even at 38 px.
  half: (x, ink) => (x < 50
    ? `<path d='M${x - 1},48.5 L${x + 9.5},44.5 L${x + 9.5},50 Q${x + 9.5},55.5 ${x + 4.25},55.5 Q${x - 1},55.5 ${x - 1},50 Z' fill='${ink}'/>`
    : `<path d='M${x - 1},44.5 L${x + 9.5},48.5 L${x + 9.5},50 Q${x + 9.5},55.5 ${x + 4.25},55.5 Q${x - 1},55.5 ${x - 1},50 Z' fill='${ink}'/>`),
  shut: (x, ink) => `<path d='M${x},48 h8.5' fill='none' stroke='${ink}' stroke-width='3.4' stroke-linecap='round' opacity='.85'/>`,
};

function faceSvg(color, zoom = 1, eyes = 'open') {
  const look = FACE_EYES[eyes] ? eyes : 'open';
  const key = `${String(color || AVATAR_DEFAULT.color).trim().toLowerCase()}@${zoom}${look === 'open' ? '' : `:${look}`}`;
  const cached = faceCache.get(key);
  if (cached) return cached;
  const bg = /^#[0-9a-f]{3,8}$/.test(String(color || '').trim().toLowerCase())
    ? String(color).trim().toLowerCase()
    : AVATAR_DEFAULT.color;
  const ink = isLightColor(bg) ? '#1c1a17' : '#fff';
  const eye = (x) => FACE_EYES[look](x, ink);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs>`
    + `<linearGradient id='l' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='.26'/><stop offset='.55' stop-color='#fff' stop-opacity='0'/><stop offset='1' stop-color='#000' stop-opacity='.16'/></linearGradient>`
    + `</defs>`
    + `<rect width='100' height='100' fill='${bg}'/>`
    + `<rect width='100' height='100' fill='url(#l)'/>`
    + `<g transform='translate(50 50) scale(${zoom}) translate(-50 -50)'>${eye(36.5)}${eye(55)}</g>`
    + `</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  faceCache.set(key, url);
  faceCache.set(`${key}:raw`, svg);
  return url;
}

function faceLayer(color, shape) {
  const span = el('span', 'av-face');
  span.style.backgroundImage = faceSvg(color, FACE_ZOOM[shape] || 1);
  return span;
}

function installAvatarStyles() {
  const rules = AVATAR_SHAPES.map(({ id, path }) => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>`
      + `<path fill='white' fill-rule='evenodd' d='${path}'/></svg>`;
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    // --av-mask: the same shape for a face layer, when the ring of 「等你」 sits outside it (11b-lamp.js).
    return `.av-s-${id}{-webkit-mask-image:${url};mask-image:${url};--av-mask:${url}}`;
  });
  try {
    const style = document.createElement('style');
    style.id = 'avatar-shapes';
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  } catch { /* masks are progressive enhancement: a plain coloured block still shows */ }
}

/** bot.avatar from the server, with the legacy avatarColor as the fallback. */
function avatarOf(bot) {
  const raw = (bot && bot.avatar) || {};
  const known = SHAPE_IDS.has(raw.shape) ? raw.shape : AVATAR_DEFAULT.shape;
  const shape = LEGACY_SHAPES[known] || known;
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.color)
    ? raw.color
    : (bot && bot.avatarColor) || AVATAR_DEFAULT.color;
  const hasImage = Boolean(raw.hasImage || raw.imageUrl);
  const imageUrl = raw.imageUrl
    || (hasImage && bot && bot.id ? `/api/bots/${encodeURIComponent(bot.id)}/avatar` : '');
  return { shape, color, hasImage, imageUrl };
}

function setAvatarLocal(bot, patch) {
  if (!bot) return;
  bot.avatar = { ...avatarOf(bot), ...patch };
  renderBots();
  const current = botById(state.botId);
  if (current && current.id === bot.id) renderChatAvatar(current);
  if (state.avatarBotId === bot.id) renderCustomizerPreview();
}

/** Face first, uploaded image on top. A transparent PNG must not show the face
    through it, so `.has-image` hides the face until the image loads; a broken
    image removes itself and the face comes back. */
function appendAvatarContent(node, a) {
  node.appendChild(faceLayer(a.color, a.shape));
  if (a.hasImage && a.imageUrl) {
    node.classList.add('has-image');
    const img = document.createElement('img');
    img.className = 'av-img';
    img.alt = '';
    img.decoding = 'async';
    img.src = a.imageUrl;
    img.addEventListener('error', () => { img.remove(); node.classList.remove('has-image'); });
    node.appendChild(img);
  }
}

/** One avatar node for the sidebar / anything static. */
function avatarNode(bot, size = 52, className = '') {
  // A member from another machine wears its own face everywhere (1.5.44 test: the chat's title stack stayed purple).
  const a = avatarOf(faceOf(bot));
  const node = el('span', `av av-s-${a.shape}${className ? ` ${className}` : ''}`);
  node.style.setProperty('--av-size', `${size}px`);
  node.style.setProperty('--av-color', a.color);
  appendAvatarContent(node, a);
  return node;
}

function renderChatAvatar(bot) {
  const host = $('chat-avatar');
  if (!host || !bot) return;
  // A living face (14-lamp.js): it looks around and shows what the bot is doing.
  lampMount(host, bot, 30, 'chat-avatar');
  host.setAttribute('aria-label', `更换 ${bot.name} 的头像`);
  host.title = `更换 ${bot.name} 的头像`;
}

/** A space around Latin names reads better inside a Chinese sentence. */
function padName(name) {
  return /^[A-Za-z0-9]/.test(String(name || '')) ? ' ' : '';
}

/** Last-message preview for the sidebar row; role when there is nothing yet. */
/** Like a messenger's list: the time today (下午5:57), yesterday, the weekday this week, else the date. */
function homeTime(ts) {
  const t = ts ? new Date(ts) : null;
  if (!t || Number.isNaN(t.getTime())) return '';
  const lang = window.deskI18n?.lang === 'en' ? 'en' : 'zh-CN';
  const now = new Date();
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86400000);
  try {
    if (days === 0) return t.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', hour12: true });
    if (days === 1) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-1, 'day');
    if (days > 1 && days < 7) return t.toLocaleDateString(lang, { weekday: 'long' });
    return t.toLocaleDateString(lang, { month: 'numeric', day: 'numeric' });
  } catch { return ''; }
}

/** The home page's search: bots and groups whose name, role or last message match. */
function filterHome() {
  const q = String($('home-search')?.value || $('roster-search')?.value || '').trim().toLowerCase();
  for (const row of document.querySelectorAll('#bot-list .bot, #bot-list .group, #group-list .group')) {
    const hay = row.dataset.search || row.textContent.toLowerCase();
    row.hidden = Boolean(q) && !hay.includes(q);
  }
  // 「全部机器」 (1.5.43): a search looks inside folded machines too; 「最近」 and empty machines step aside.
  for (const sec of document.querySelectorAll('#bot-list .roster-sec')) {
    sec.classList.toggle('searching', Boolean(q));
    sec.hidden = Boolean(q) && (sec.classList.contains('recent') || !sec.querySelector('.bot:not([hidden]), .group:not([hidden])'));
  }
}

function previewText(bot) {
  return lastLine(bot) || (bot && bot.role) || '还没有消息';
}

/** The last message of a bot or group as one plain line; '' when there is none. */
function lastLine(thing) {
  const p = thing && thing.preview;
  const text = p && typeof p.text === 'string' ? p.text.replace(/\s+/g, ' ').trim() : '';
  return text ? plainPreview(text) : '';
}

/** A sidebar preview is one line of plain text: the reply's **bold**, `code`, # titles and list marks dropped. */
function plainPreview(text) {
  // Names, not ids, here too (1.5.11: the list showed "rt_aa77… 更新成…").
  return humanizeIds(String(text || ''))
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/__([^_]*)__/g, '$1').replace(/\*\*/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

