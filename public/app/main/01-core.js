'use strict';
// Lamplit page, part 1 of 12: core - state, DOM helpers, theme, time zone, small helpers. Parts share one scope and load in order (scripts/check-page-parts.mjs).

/* --- names instead of ids (1.5.9) -------------------------------------------
   A reply may still say "群 g-ab12cd", "rt_0123456789ab" or "`5 20 * * *`":
   on screen those become the group's, the bot's and the task's names, and the
   time in words. */
function scheduleText(expr) {
  const s = String(expr || '').trim();
  const every = /^every\s+(\d+)\s*(minutes?|mins?|m|hours?|h)$/i.exec(s);
  if (every) return `每 ${every[1]} ${/^h/i.test(every[2]) ? '小时' : '分钟'}`;
  const f = s.split(/\s+/);
  if (f.length !== 5) return s;
  const [mi, h, dom, mon, dow] = f;
  if (!/^\d{1,2}$/.test(mi) || dom !== '*' || mon !== '*' || !h.split(',').every((x) => /^\d{1,2}$/.test(x))) return s;
  const times = h.split(',').map((x) => `${x.padStart(2, '0')}:${mi.padStart(2, '0')}`).join('、');
  const week = '日一二三四五六日';
  const days = dow === '*' ? '每天'
    : /^(1-5|mon-fri)$/i.test(dow) ? '工作日'
      : /^(0,6|6,0|sat,sun)$/i.test(dow) ? '周末'
        : /^[0-7](,[0-7])*$/.test(dow) ? `每周${dow.split(',').map((d) => week[Number(d)]).join('、')}` : '';
  return days ? `${days} ${times}` : s;
}

function humanizeIds(text) {
  let t = String(text || '');
  if (!/\b(g-[a-z0-9]{6}|bot-[a-z0-9]{6}|rt_[0-9a-f]{12})\b|`[^`\n]*\*[^`\n]*`/.test(t)) return t;
  // This machine's lists first; then the other machines' names (1.5.19): a reply
  // here may name a group, bot or task that lives on another machine.
  const far = state.peerNames || { groups: {}, bots: {}, routines: {} };
  const groupName = (id) => (state.groups || []).find((g) => g.id === id)?.name || far.groups[id];
  const botName = (id) => (state.bots || []).find((b) => b.id === id)?.name || far.bots[id];
  const routineName = (id) => (state.routines || []).find((r) => r.id === id)?.name || far.routines[id];
  if (/\brt_[0-9a-f]{12}\b/.test(t) && !state.routines && !humanizeIds.loading) {
    humanizeIds.loading = true;
    api('/api/routines').then((r) => { state.routines = r; if (typeof renderMessages === 'function') renderMessages(); }).catch(() => {});
  }
  const unknown = [...t.matchAll(/\b(g-[a-z0-9]{6}|bot-[a-z0-9]{6}|rt_[0-9a-f]{12})\b/g)].some(([, id]) => !groupName(id) && !botName(id) && !routineName(id));
  if (unknown && !state.peerNames && !humanizeIds.farLoading) {
    humanizeIds.farLoading = true;
    api('/api/peers/names').then((n) => { state.peerNames = n; if (typeof renderMessages === 'function') renderMessages(); }).catch(() => {});
  }
  // 「name」 needs no spaces around it ("群 g-ab12cd 已公告" -> "群「小红书项目群」已公告").
  t = t.replace(/ ?`?\b(g-[a-z0-9]{6})\b`? ?/g, (m, id) => (groupName(id) ? `「${groupName(id)}」` : m));
  t = t.replace(/`?\b(bot-[a-z0-9]{6})\b`?/g, (m, id) => botName(id) || m);
  t = t.replace(/ ?`?\b(rt_[0-9a-f]{12})\b`? ?/g, (m, id) => (routineName(id) ? `「${routineName(id)}」` : m));
  return t.replace(/`([^`\n]+)`/g, (m, inner) => { const h = scheduleText(inner); return h !== inner ? h : m; });
}

/* =====================================================================
   Desk - front end
   No framework, no build step: plain DOM + fetch + one EventSource.
   State is one object; every render is explicit.
   ===================================================================== */

const state = {
  auth: null,           // { required, authorized, mode }  (null = unknown / unsupported)
  settings: null,       // GET /api/settings (may not exist yet)
  settingsError: null,
  pairing: null,        // { url, code }
  config: null,
  health: null,
  // Grok-Bot parity defaults: no process noise in the transcript, no work
  // panel until asked. Both persisted so a power user can turn them on once.
  showProcess: (() => { try { return localStorage.getItem('desk.showProcess') === '1'; } catch { return false; } })(),
  panelOpen: (() => { try { return localStorage.getItem('desk.panelOpen') === '1'; } catch { return false; } })(),
  bots: [],
  botId: null,
  messages: [],
  activities: [],
  approvals: [],
  routines: [],
  skills: [],
  stream: null,
  seenEvents: new Set(),
  liveTurn: null,
  tab: 'computer',
  sending: false,
  unconfigured: false,
  mockAck: false,
  settingsOpen: false,
  pendingPair: null,
  avatarBotId: null,
  groups: [],            // [{ id, name, members:[botId], coordinatorId, preview }]
  groupsSupported: true,
  groupId: null,         // null => 1:1 with botId
  groupMessages: [],
  groupDraft: { name: '', members: [], coordinatorId: null },
  botEditingId: null,
  deleteArmed: false,
};

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const mqMobile = window.matchMedia('(max-width: 860px)');
const isMobile = () => mqMobile.matches;

/* ---------------------------------------------------------------------
   appearance: dark / light / follow the system.
   The head script already set data-theme before paint; this keeps the
   controls, the meta colour and the system listener in sync.
   --------------------------------------------------------------------- */
const THEME_KEY = 'desk.theme';
const THEME_LABELS = { dark: '深色', light: '浅色', system: '跟随系统' };
const THEME_GLYPHS = { dark: '☾', light: '☀', system: '◐' };
const mqLight = window.matchMedia('(prefers-color-scheme: light)');

function themePref() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  } catch { /* private mode */ }
  return 'system';
}

function resolvedTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  return mqLight.matches ? 'light' : 'dark';
}

function applyTheme(pref, { persist = false } = {}) {
  const next = THEME_LABELS[pref] ? pref : 'system';
  const resolved = resolvedTheme(next);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = next;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0a0a0a');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    // Every machine's page shows the same 外观 (theme.js, 1.3.2).
    if (window.deskViewPrefs) window.deskViewPrefs.set({ theme: next });
    if (typeof reportUiState === 'function') reportUiState();
  }
  if ($('theme-btn-glyph')) $('theme-btn-glyph').textContent = THEME_GLYPHS[next];
  if ($('theme-btn-label')) $('theme-btn-label').textContent = THEME_LABELS[next];
  if ($('theme-btn')) $('theme-btn').title = `外观：${THEME_LABELS[next]}（点击切换）`;
  document.querySelectorAll('[data-lang-choice]').forEach((node) => {
    const on = node.dataset.langChoice === (window.deskI18n?.pref || 'system');
    node.classList.toggle('active', on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
    node.addEventListener('click', () => {
      if (node.dataset.langChoice !== window.deskI18n?.pref) window.deskI18n?.setPref(node.dataset.langChoice);
    });
  });
  document.querySelectorAll('[data-theme-choice]').forEach((node) => {
    const on = node.dataset.themeChoice === next;
    node.classList.toggle('active', on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function cycleTheme() {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  applyTheme(next, { persist: true });
  toast(`外观：${THEME_LABELS[next]}`);
}

function initTheme() {
  applyTheme(themePref());
  mqLight.addEventListener?.('change', () => {
    if (themePref() === 'system') applyTheme('system');
  });
  $('theme-btn')?.addEventListener('click', cycleTheme);
  document.querySelectorAll('[data-theme-choice]').forEach((node) => {
    node.addEventListener('click', () => applyTheme(node.dataset.themeChoice, { persist: true }));
  });
}

/* ---------------------------------------------------------------------
   timezone: the human can follow this device, follow the controlled
   machine, or pick an IANA zone by hand. The effective zone is also pushed
   to the server so routines and logs agree with what the UI shows.
   --------------------------------------------------------------------- */
const TZ_KEY = 'desk.timezone';
const COMMON_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
  'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function timezonePref() {
  try {
    const raw = JSON.parse(localStorage.getItem(TZ_KEY) || 'null');
    if (raw && ['local', 'target', 'manual'].includes(raw.mode)) {
      return { mode: raw.mode, value: String(raw.value || localTimezone()) };
    }
  } catch { /* private mode / old value */ }
  return { mode: 'local', value: localTimezone() };
}

function effectiveTimezone() {
  const pref = timezonePref();
  if (pref.mode === 'manual') return pref.value || localTimezone();
  if (pref.mode === 'target' && state.computer?.host?.timezone) return state.computer.host.timezone;
  return localTimezone();
}

function timezoneLabel(zone) {
  if (!zone) return '—';
  try {
    const now = new Date();
    const name = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || '';
    return name ? `${zone}（${name.replace('GMT', 'UTC')}）` : zone;
  } catch {
    return zone;
  }
}

function renderTimezoneOptions() {
  const select = $('tz-select');
  if (!select) return;
  const zones = new Set(COMMON_TIMEZONES);
  try {
    for (const zone of Intl.supportedValuesOf('timeZone')) zones.add(zone);
  } catch { /* older engine: the common list is enough */ }
  zones.add(effectiveTimezone());
  const current = timezonePref().value;
  select.innerHTML = [...zones].sort().map((zone) => (
    `<option value="${escapeHtml(zone)}">${escapeHtml(timezoneLabel(zone))}</option>`
  )).join('');
  select.value = [...zones].includes(current) ? current : effectiveTimezone();
}

function syncTimezoneUi() {
  const pref = timezonePref();
  const zone = effectiveTimezone();
  document.querySelectorAll('[data-tz-mode]').forEach((node) => {
    const on = node.dataset.tzMode === pref.mode;
    node.classList.toggle('active', on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if ($('tz-select')) {
    $('tz-select').hidden = pref.mode !== 'manual';
    if (!$('tz-select').hidden) $('tz-select').value = pref.value;
  }
  if ($('timezone-pill')) $('timezone-pill').textContent = timezoneLabel(zone);
  if ($('tz-note')) {
    if (pref.mode === 'target' && !state.computer?.host?.timezone) {
      $('tz-note').textContent = `还读不到「${machineDisplayName()}」的时区，先按这台设备的 ${localTimezone()} 走。`;
    } else if (pref.mode === 'target') {
      $('tz-note').textContent = `跟着「${machineDisplayName()}」走：${zone}`;
    } else {
      $('tz-note').textContent = `当前时区：${zone}`;
    }
  }
}

let tzPushTimer = null;
function pushTimezoneToServer(zone) {
  clearTimeout(tzPushTimer);
  tzPushTimer = setTimeout(async () => {
    const current = (state.settings && state.settings.timezone) || (state.config && state.config.timezone);
    if (current === zone) return;
    try {
      const saved = await api('/api/settings', { method: 'PUT', body: { timezone: zone } });
      if (saved && saved.model && state.settings) state.settings.timezone = saved.timezone || zone;
      if (state.config) state.config.timezone = zone;
    } catch { /* the server may be an older build; the UI still shows the choice */ }
  }, 250);
}

function applyTimezone({ persist = false, push = true } = {}) {
  const pref = timezonePref();
  if (persist) {
    try { localStorage.setItem(TZ_KEY, JSON.stringify(pref)); } catch { /* private mode */ }
  }
  const zone = effectiveTimezone();
  syncTimezoneUi();
  if (push) pushTimezoneToServer(zone);
  if (typeof reportUiState === 'function') reportUiState();
  return zone;
}

function setTimezoneMode(mode) {
  const pref = timezonePref();
  if (!['local', 'target', 'manual'].includes(mode)) return;
  pref.mode = mode;
  if (mode === 'manual' && !pref.value) pref.value = effectiveTimezone();
  try { localStorage.setItem(TZ_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
  applyTimezone({ push: true });
}

function initTimezone() {
  renderTimezoneOptions();
  document.querySelectorAll('[data-tz-mode]').forEach((node) => {
    node.addEventListener('click', () => setTimezoneMode(node.dataset.tzMode));
  });
  $('tz-select')?.addEventListener('change', () => {
    const pref = timezonePref();
    pref.mode = 'manual';
    pref.value = $('tz-select').value;
    // applyTimezone() re-reads localStorage, so persist the new choice first.
    try { localStorage.setItem(TZ_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
    applyTimezone({ persist: true, push: true });
  });
  applyTimezone({ push: false });
}

/* ---------------------------------------------------------------------
   small helpers
   --------------------------------------------------------------------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const RISK_LABELS = { LOW: '低', MEDIUM: '中', HIGH: '高' };
function riskLabel(risk) {
  if (!risk) return '';
  return RISK_LABELS[String(risk).toUpperCase()] || String(risk);
}

const DECISION_LABELS = {
  approved: '已批准', approve: '已批准',
  denied: '已拒绝', deny: '已拒绝',
  auto: '自动通过', ask: '待批准', pending: '待批准',
};
function decisionLabel(decision) {
  if (!decision) return '';
  return DECISION_LABELS[String(decision).toLowerCase()] || String(decision);
}

/** The policy engine explains itself in English; these phrases are part of
 *  the chrome, not model output, so they get a Chinese rendering. Unknown
 *  reasons pass through untouched rather than being mangled. */
function reasonLabel(reason) {
  if (!reason) return '';
  return String(reason)
    .replace(/\blow-risk tool\b/g, '这是一个低风险操作')
    .replace(/\bmedium-risk tool\b/g, '这是一个中风险操作')
    .replace(/\bhigh-risk tool\b/g, '这是一个高风险操作')
    .replace(/;\s*auto-approved \(autonomous mode\)/g, '；完全自主模式已自动通过')
    .replace(/;\s*auto-approved by policy/g, '；按策略自动通过')
    .replace(/(.+?) is not granted to this bot/g, '这个助手没有「$1」的执行权限')
    .replace(/command matches danger denylist \((.*?)\)/g, '命令命中危险黑名单（$1）')
    .replace(/path resolves outside the shared workspace \((.*?)\)/g, '要动的文件不在共享工作区里（$1）')
    .replace(/\bapproval timed out\b/gi, '等太久没确认，已经自动取消')
    .replace(/\bturn cancelled\b/gi, '这一轮被取消了')
    .replace(/\bserver shutting down\b/gi, '服务先关掉了');
}

function fmtClock(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const units = [['天', 86400000], ['小时', 3600000], ['分钟', 60000], ['秒', 1000]];
  for (const [label, ms] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff >= 0 ? `${n}${label}后` : `${n}${label}前`;
    }
  }
  return '刚刚';
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function safeParse(value) {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch { return { raw: value }; }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Long words fold (1.5.28): a reply longer than a few lines shows its start and
 * a 「展开」; a message one bot sent another shows two lines. Nothing is cut -
 * the whole text is there behind the button.
 * mode: 'long' (a reply), 'line' (between bots), false (never).
 */
const FOLD_LONG_AT = 260;
const FOLD_LINE_AT = 70;
function foldBubble(bubble, text, mode = 'long') {
  if (!mode || !bubble) return;
  const size = String(text || '').replace(/[*#>`_\-|]/g, '').replace(/\s+/g, ' ').trim().length;
  if (size <= (mode === 'line' ? FOLD_LINE_AT : FOLD_LONG_AT)) return;
  const body = el('div', 'bubble-body');
  while (bubble.firstChild) body.appendChild(bubble.firstChild);
  bubble.appendChild(body);
  bubble.classList.add('folded', mode === 'line' ? 'fold-line' : 'fold-long');
  const btn = el('button', 'fold-btn', '展开');
  btn.type = 'button';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = bubble.classList.toggle('unfolded');
    btn.textContent = open ? '收起' : '展开';
  });
  bubble.appendChild(btn);
}

/**
 * The last messages of each chat, kept in this browser (1.5.28): switching to
 * a chat shows them at once, then the machine's answer replaces them. Per
 * address, so each machine has its own; at most 12 chats, 80 messages each.
 */
const CHAT_CACHE = 'lamplit.chats.v1';
function chatCacheAll() {
  try { return JSON.parse(localStorage.getItem(CHAT_CACHE) || '{}') || {}; } catch { return {}; }
}
function chatCacheGet(key) {
  const hit = chatCacheAll()[key];
  return Array.isArray(hit?.items) ? hit.items : null;
}
/** Keep `items` for `key`; false when they are the same as what was kept (nothing to redraw). */
function chatCachePut(key, items) {
  const list = Array.isArray(items) ? items.slice(-80) : [];
  const all = chatCacheAll();
  if (all[key] && JSON.stringify(all[key].items) === JSON.stringify(list) && list.length === (items || []).length) return false;
  all[key] = { at: Date.now(), items: list };
  const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  for (const k of keys.slice(12)) delete all[k];
  try { localStorage.setItem(CHAT_CACHE, JSON.stringify(all)); } catch { /* full or private: no cache */ }
  return true;
}
