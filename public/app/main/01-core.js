'use strict';
// Lamplit page, part 1 of 12: core - state, DOM helpers, theme, time zone, small helpers. Parts share one scope and load in order (scripts/check-page-parts.mjs).

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

