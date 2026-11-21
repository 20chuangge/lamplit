'use strict';
// Lamplit page, part 4 of 12: bots - manage bots, menus, scrolling, service worker, pairing, boot, model state, sidebar list. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   bot management: rename / role / avatar / delete
   --------------------------------------------------------------------- */
/** What a bot may do, in plain words; each ability is a group of tools. */
const ABILITIES = [
  { id: 'shell', label: '执行命令', note: '运行命令、装软件', tools: ['shell'] },
  { id: 'files', label: '读写文件', note: '在工作区读、写、建文件夹', tools: ['fs_list', 'fs_read', 'fs_write', 'fs_mkdir'] },
  { id: 'delete', label: '删除文件', note: '', tools: ['fs_delete'] },
  { id: 'web', label: '上网和浏览器', note: '打开网页、抓取内容', tools: ['browser_open', 'http_fetch'] },
  { id: 'desktop', label: '操作桌面程序', note: 'Windows：在后台按按钮、填文字，不动鼠标', tools: ['desktop_ui'] },
  { id: 'phone', label: '操作手机', note: '连在这台电脑上的安卓手机：看屏幕、点、输入、打开 App', tools: ['phone'] },
  { id: 'memory', label: '记忆和技能', note: '记住你的习惯、保存做法', tools: ['memory_write', 'memory_read', 'skill_list', 'skill_read', 'skill_save'] },
  { id: 'routines', label: '定时任务', note: '', tools: ['routine_create', 'routine_list', 'routine_run'] },
  { id: 'team', label: '建机器人和群、派活', note: '', tools: ['bot_list', 'bot_message', 'bot_create', 'bot_update', 'bot_delete', 'group_create', 'group_post', 'group_list', 'group_update', 'group_delete'] },
  { id: 'settings', label: '改设置', note: '模型、主题等', tools: ['settings_get', 'settings_update', 'ui_get', 'ui_set'] },
  { id: 'machines', label: '切换机器', note: '把任务交给另一台机器', tools: ['machine_list', 'machine_switch'] },
  { id: 'codecli', label: '交给编程助手（Claude Code / Codex / Cursor / Qoder）', note: '用你的订阅额度写代码，每次都先问你', tools: ['cli_agent_run'] },
];

function renderAbilities(bot) {
  const box = $('botedit-abilities');
  if (!box) return;
  const have = new Set(bot.tools || []);
  box.innerHTML = '';
  for (const ab of ABILITIES) {
    const count = ab.tools.filter((t) => have.has(t)).length;
    const row = el('label', 'be-row');
    const text = el('span', 'be-row-text');
    text.appendChild(el('b', '', ab.label));
    if (ab.note) text.appendChild(el('small', '', ab.note));
    row.appendChild(text);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'be-switch';
    input.dataset.ability = ab.id;
    input.checked = count > 0;
    input.indeterminate = count > 0 && count < ab.tools.length;
    row.appendChild(input);
    box.appendChild(row);
  }
  $('botedit-trust').checked = Boolean(bot.policy?.autoApproveMedium);
  renderAllowed(bot);
}

/** 已记住的权限: what you said "以后都允许" to for this bot, each with 撤销. */
function renderAllowed(bot) {
  const box = $('botedit-allowed');
  if (!box) return;
  const list = Array.isArray(bot.policy?.allowed) ? bot.policy.allowed : [];
  const grants = Array.isArray(bot.policy?.phoneGrants) ? bot.policy.phoneGrants.filter((g) => !g.until || Date.parse(g.until) > Date.now()) : [];
  box.innerHTML = '';
  box.hidden = !list.length && !grants.length;
  if (!list.length && !grants.length) return;
  box.appendChild(el('div', 'be-allowed-title', '已记住的权限（不再问你）'));
  // 手机上放开的操作 (1.5.25), each with 撤销.
  const KIND = { send: '发消息', publish: '发布', agree: '点同意', delete: '删除' };
  for (const g of grants) {
    const row = el('div', 'be-allowed-row');
    row.appendChild(el('span', 'be-allowed-label', `手机「${g.app}」上${KIND[g.kind] || g.kind}${g.until ? '（今天）' : ''}`));
    const undo = el('button', 'btn small be-allowed-undo', '撤销');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const phoneGrants = (bot.policy?.phoneGrants || []).filter((x) => !(x.app === g.app && x.kind === g.kind));
        const res = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: { policy: { ...(bot.policy || {}), phoneGrants } } });
        const updated = (res && res.bot) || { ...bot, policy: { ...(bot.policy || {}), phoneGrants } };
        const index = state.bots.findIndex((b) => b.id === bot.id);
        if (index >= 0) state.bots[index] = { ...state.bots[index], ...updated };
        renderAllowed(state.bots[index] || updated);
      } catch (err) { undo.disabled = false; toast(err.message, true); }
    });
    row.appendChild(undo);
    box.appendChild(row);
  }
  for (const item of list) {
    const row = el('div', 'be-allowed-row');
    row.appendChild(el('span', 'be-allowed-label', item.label || item.key));
    const undo = el('button', 'btn small be-allowed-undo', '撤销');
    undo.type = 'button';
    undo.title = '以后这类操作又会先问你';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const allowed = list.filter((a) => a.key !== item.key);
        const res = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: { policy: { ...(bot.policy || {}), allowed } } });
        const updated = (res && res.bot) || { ...bot, policy: { ...(bot.policy || {}), allowed } };
        const index = state.bots.findIndex((b) => b.id === bot.id);
        if (index >= 0) state.bots[index] = { ...state.bots[index], ...updated };
        renderAllowed(state.bots[index] || updated);
      } catch (err) {
        undo.disabled = false;
        toast(err.message, true);
      }
    });
    row.appendChild(undo);
    box.appendChild(row);
  }
}

/** The bot's tool list after the checkboxes: groups on/off, other tools kept. */
function toolsFromAbilities(bot) {
  const next = new Set(bot.tools || []);
  for (const input of document.querySelectorAll('#botedit-abilities input[data-ability]')) {
    const ab = ABILITIES.find((a) => a.id === input.dataset.ability);
    if (!ab) continue;
    // Untouched half-on groups stay as they were.
    if (input.indeterminate) continue;
    for (const t of ab.tools) {
      if (input.checked) next.add(t);
      else next.delete(t);
    }
  }
  return [...next];
}

function openBotEdit(botId, options = {}) {
  const bot = botById(botId);
  if (!bot) return;
  closeMenus();
  closeSidebar();
  state.botEditingId = botId;
  state.deleteArmed = Boolean(options.armDelete) && !bot.primary;
  $('botedit-title').textContent = `管理助手 · ${bot.name}`;
  $('botedit-name-input').value = bot.name || '';
  $('botedit-role-input').value = bot.role || '';
  renderBotModelSelect(bot);
  renderBotVoiceSelect(bot);
  renderAbilities(bot);
  $('botedit-note').hidden = true;
  const preview = $('botedit-preview');
  preview.className = `av av-s-${avatarOf(bot).shape}`;
  preview.style.setProperty('--av-color', avatarOf(bot).color);
  preview.innerHTML = '';
  appendAvatarContent(preview, avatarOf(bot));

  // The way the 「主助理不能删」 note points to (1.5.33, C8).
  const prim = $('botedit-primary');
  if (prim) prim.hidden = Boolean(bot.primary);
  const del = $('botedit-delete');
  del.disabled = Boolean(bot.primary);
  del.textContent = state.deleteArmed ? `再点一次确认删除「${bot.name}」` : '删除这个助手';
  $('botedit-delete-note').textContent = bot.primary
    ? '主助理不能删：先把另一个助手设为主助理，再删这个。'
    : '删除会一并删掉它的记忆和对话记录，无法恢复。';

  $('botedit-sheet').classList.add('open');
  $('botedit-sheet').setAttribute('aria-hidden', 'false');
  $('botedit-scrim').classList.add('show');
  if (!isMobile()) {
    const target = options.focus === 'role' ? $('botedit-role-input') : $('botedit-name-input');
    setTimeout(() => { target.focus(); target.select(); }, 120);
  }
}

function closeBotEdit() {
  state.botEditingId = null;
  state.deleteArmed = false;
  $('botedit-sheet').classList.remove('open');
  $('botedit-sheet').setAttribute('aria-hidden', 'true');
  $('botedit-scrim').classList.remove('show');
}

async function saveBotEdit() {
  const bot = botById(state.botEditingId);
  if (!bot) return;
  const name = $('botedit-name-input').value.trim();
  const role = $('botedit-role-input').value.trim();
  if (!name) { setBotEditNote('名字不能为空。'); return; }
  const button = $('botedit-save');
  button.disabled = true;
  try {
    const tools = toolsFromAbilities(bot);
    const policy = { autoApproveMedium: $('botedit-trust').checked };
    const model = $('botedit-model')?.value || '';
    const voiceSec = $('botedit-voice-sec');
    const voiceId = voiceSec && !voiceSec.hidden ? ($('botedit-voice').value || '') : (bot.voice || '');
    const res = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: { name, role, tools, policy, model, voice: voiceId } });
    const updated = (res && res.bot) || { ...bot, name, role, tools, model, voice: voiceId, policy: { ...(bot.policy || {}), ...policy } };
    const index = state.bots.findIndex((b) => b.id === bot.id);
    if (index >= 0) state.bots[index] = { ...state.bots[index], ...updated };
    renderBots();
    renderGroups();
    if (state.botId === bot.id && !isGroupMode()) {
      $('chat-title').textContent = name;
      $('chat-sub').textContent = role || '还没有设定职责';
      renderChatAvatar(state.bots[index] || bot);
    }
    $('botedit-title').textContent = `管理助手 · ${name}`;
    setBotEditNote('');
    toast('已保存');
  } catch (err) {
    if (err.status === 401) return;
    setBotEditNote(`保存失败：${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/** Two-step delete: arm on the first click, act on the second. */
async function deleteBotFlow() {
  const bot = botById(state.botEditingId);
  if (!bot) return;
  if (bot.primary) { setBotEditNote('主助理不能删：先把另一个助手设为主助理，再删这个。'); return; }
  const button = $('botedit-delete');
  if (!state.deleteArmed) {
    state.deleteArmed = true;
    button.textContent = `再点一次确认删除「${bot.name}」`;
    return;
  }
  button.disabled = true;
  try {
    await deleteBotNow(bot);
  } catch (err) {
    state.deleteArmed = false;
    button.disabled = false;
    button.textContent = '删除这个助手';
    setBotEditNote(`删除失败：${err.message}`);
  }
}

/** 「删除」 in a bot's ⋯ menu asks once, here (1.5.33: it opened the settings sheet). */
async function confirmDeleteBot(bot) {
  if (!bot || bot.primary) return;
  const ok = await askConfirm({
    title: `删除「${bot.name}」？`,
    text: '它的对话记录和记忆会收进归档，不再出现；它等你确认的卡片会收起，定时任务会暂停。',
    confirmLabel: '删除',
  });
  if (!ok) return;
  try { await deleteBotNow(bot); } catch (err) { toast(`删除失败：${err.message}`, true); }
}

/** Make another bot the main assistant (the way to delete the one there was). */
async function makePrimary() {
  const bot = botById(state.botEditingId);
  if (!bot || bot.primary) return;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}/primary`, { method: 'POST' });
    state.bots = await api('/api/bots');
    renderBots();
    closeBotEdit();
    toast(`「${bot.name}」现在是主助理了。`);
  } catch (err) {
    setBotEditNote(`没能设为主助理：${err.message}`);
  }
}

async function deleteBotNow(bot) {
  {
    const gone = await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
    closeBotEdit();
    refreshPendingApprovals();
    state.bots = await api('/api/bots');
    await loadGroups();
    renderBots();
    if (state.botId === bot.id) {
      const next = state.bots.find((b) => b.primary) || state.bots[0];
      if (next) selectBot(next.id);
    }
    // What it left behind went with it (1.5.32): say so, so nothing looks lost.
    const c = gone?.cleared || {};
    const left = [c.turns ? '停下了它正在做的事' : '', c.approvals ? `收起了 ${c.approvals} 张等你确认的卡片` : '', c.routinesOff ? `暂停了它的 ${c.routinesOff} 个定时任务` : ''].filter(Boolean);
    toast(`已删除 ${bot.name}${left.length ? `：${left.join('，')}` : ''}`);
  }
}

function setBotEditNote(text) {
  const note = $('botedit-note');
  note.hidden = !text;
  note.textContent = text || '';
}

/* ---------------------------------------------------------------------
   small popover menus
   --------------------------------------------------------------------- */
function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('[aria-expanded="true"]').forEach((n) => {
    if (n.id === 'new-bot-btn' || n.id === 'machine-btn' || n.classList.contains('bot-more')) n.setAttribute('aria-expanded', 'false');
  });
}

function toggleMenu(node, anchor) {
  const open = !node.hidden;
  closeMenus();
  if (open) return;
  node.hidden = false;
  if (anchor) anchor.setAttribute('aria-expanded', 'true');
}

function updateNewMenu() {
  const item = $('new-group-item');
  if (!item) return;
  item.disabled = !state.groupsSupported;
  item.title = state.groupsSupported ? '' : '服务端还没有群组接口（404）';
}

function hideToast() {
  const node = $('toast');
  if (!node) return;
  clearTimeout(toast._t);
  node.className = 'toast';
}

/* The desktop app reports background work (machine updates) through here. */
window.deskNotify = (text, isError = false) => toast(String(text || ''), Boolean(isError));

function toast(text, isError = false) {
  if (!text) return; // already said another way (the local pairing dialog)
  const node = $('toast');
  node.textContent = text;
  node.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  // Longer messages stay up longer (up to 9 s) so they can be read.
  toast._t = setTimeout(() => { node.className = 'toast'; }, Math.min(9000, Math.max(3200, String(text).length * 110)));
}

/*
 * One fetch wrapper. Every failure is an Error with .status and .code.
 * A plain GET already on its way is shared, not sent again (1.5.33: opening
 * the page asked /api/health 5 times, a dozen others twice - each a few
 * hundred ms for a phone on a relay). Each caller gets its own copy.
 */
const apiInflight = new Map();
function api(path, options = {}) {
  const plainGet = !options.method || String(options.method).toUpperCase() === 'GET';
  if (!plainGet || options.body !== undefined || options.headers) return apiRequest(path, options);
  let pending = apiInflight.get(path);
  if (!pending) {
    pending = apiRequest(path, options).finally(() => apiInflight.delete(path));
    apiInflight.set(path, pending);
  }
  return pending.then((json) => (json && typeof json === 'object' ? (typeof structuredClone === 'function' ? structuredClone(json) : JSON.parse(JSON.stringify(json))) : json));
}

async function apiRequest(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['content-type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (cause) {
    const err = new Error('无法连接 Lamplit 服务，网络可能断了。');
    err.status = 0;
    err.cause = cause;
    throw err;
  }

  // A wrong code in the 「配对这个浏览器」 box is not a lost login (1.5.33: it threw the whole page out).
  // Not while the page is spending a one-time code from its address (boot): the
  // requests that start before it is spent are refused, and that is no reason
  // to show the pairing screen (1.5.39: it stayed up after pairing had worked).
  // A first visit is not a lost login (1.5.47 beginner test: 「已失效」 on a browser that had never paired).
  if (res.status === 401 && path !== '/api/pair' && !pairingFromAddress) enterAuth(pairedHereBefore() ? '这台设备的授权已失效，请重新配对。' : codeAllowedHere ? '这个浏览器还没有配对：输入配对码，或者用 Lamplit 手机 App 扫码。' : '这个浏览器还没有配对。从这个地址进来不能用 8 位配对码（为了安全）：请用 Lamplit 手机 App 扫二维码，或者在 Lamplit 桌面应用里打开这台机器。');

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }

  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `${res.status} ${res.statusText}`;
    const err = new Error(message);
    err.status = res.status;
    err.code = json && json.error ? json.error.code : undefined;
    // Only the human may decide (1.5.32): a browser on this computer without the
    // app's key gets a way to pair itself instead of a one-line refusal.
    // A request the page made by itself (options.quiet, 1.5.42 test): no box; the place that asked says it.
    if (err.code === 'LOCAL_KEY_REQUIRED' && options.quiet) { err.quiet = true; throw err; }
    if (err.code === 'LOCAL_KEY_REQUIRED') {
      if (state.auth) state.auth.authority = false;
      // Done for them once the browser is paired (1.5.33: 「再点一次刚才的按钮」 was one step too many).
      state.afterPair = { path, options };
      if ($('local-pair-why')) {
        $('local-pair-why').textContent = /^\/api\/peers\/[^/]+\/(bots|groups)$/.test(path)
          ? '在别的机器上新建助手或群组，只能在 Lamplit 应用里，或者在配对过的设备上做：这样机器人自己跑的程序没法借这台电脑去指挥别的机器。'
          : /^\/api\/peers\//.test(path)
          ? '和别的机器上的助手说话、看它的文件，只能在 Lamplit 应用里，或者在配对过的设备上：这样机器人自己跑的程序没法借这台电脑去指挥别的机器。'
          : /^\/api\/tailscale\//.test(path)
            ? '装软件、改这台电脑怎么连网，只能在 Lamplit 应用里，或者在配对过的设备上做：这样机器人自己跑的程序没法替你装、替你卸。'
            : '批准、改权限只能在 Lamplit 应用里，或者在配对过的设备上做：这样机器人自己跑的程序没法替你点「同意」。';
      }
      localPairOpen(true);
      // Said whole where the page shows it (1.5.33: 「保存失败：」 and nothing after).
      err.message = '这一步要先把这个浏览器配对一次（看弹出的对话框）。';
      err.quiet = true;
    }
    throw err;
  }
  return json;
}

/* ---------------------------------------------------------------------
   a browser on this computer, without the desktop app (1.5.32)
   --------------------------------------------------------------------- */
function localPairOpen(open) {
  const modal = $('local-pair-modal');
  const scrim = $('local-pair-scrim');
  if (!modal || !scrim) return;
  modal.classList.toggle('open', open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  scrim.classList.toggle('show', open);
  if (open) {
    $('local-pair-msg').textContent = '';
    if ($('local-pair-host')) $('local-pair-host').textContent = location.host;
    $('local-pair-code').value = '';
    if (!isMobile()) setTimeout(() => $('local-pair-code').focus(), 80);
  }
}

async function pairThisBrowser() {
  const code = normalizeCode($('local-pair-code').value);
  const msg = $('local-pair-msg');
  if (!code) { msg.textContent = '先输入配对码。'; return; }
  const button = $('local-pair-go');
  button.disabled = true;
  try {
    await api('/api/pair', { method: 'POST', body: { code, deviceName: '这台电脑上的浏览器' } });
    if (state.auth) state.auth.authority = true;
    localPairOpen(false);
    const again = state.afterPair;
    state.afterPair = null;
    if (again) {
      try {
        const res = await api(again.path, again.options);
        toast('这个浏览器配好了，刚才那一步也做完了。');
        // The card that was clicked shows what happened (1.5.40 test: it kept its buttons).
        try { again.then?.(res); } catch { /* the toast said it */ }
        refreshPendingApprovals();
      } catch (err) {
        toast(`这个浏览器配好了；刚才那一步没成功：${err.message}`, true);
      }
    } else {
      toast('这个浏览器配好了。');
    }
    if (state.settingsOpen) loadSettings().catch(() => {});
    // A chat with a bot on another machine opens now (1.5.42).
    if (remoteChatMachine()) { state.remoteStreamId = null; connectRemoteStream(); (isGroupMode() ? loadGroupMessages() : loadMessages()); loadOutbox({ render: false }).then(() => renderBots()); }
  } catch (err) {
    msg.textContent = err.status === 429 ? '试得太多次了，等一分钟再试。'
      : err.status === 401 ? '配对码不对，或者已经换了。配对码每天换一次，用过一次也会换。'
        : (err.message || '配对没成功。');
  } finally {
    button.disabled = false;
  }
}

/* Clipboard with a non-secure-context fallback (phones on plain http LAN). */
async function copyText(text, okMessage = '已复制') {
  const value = String(text ?? '');
  if (!value) return;
  try {
    if (await phoneClipWrite(value)) {
      /* done by the shell or the clipboard API */
    } else {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, value.length);
      document.execCommand('copy');
      ta.remove();
    }
    toast(okMessage);
  } catch {
    toast('复制失败，请长按选择文字', true);
  }
}

/*
 * This device's clipboard. The app shells (Android, the desktop app) offer the
 * system clipboard as window.desk.clipboardRead/Write: a machine's page is
 * plain http, where navigator.clipboard does not exist. null / false = no way.
 */
async function phoneClipRead() {
  if (typeof window.desk?.clipboardRead === 'function') {
    try { return String((await window.desk.clipboardRead()) ?? ''); } catch { /* fall through */ }
  }
  if (navigator.clipboard?.readText && window.isSecureContext) {
    try { return await navigator.clipboard.readText(); } catch { /* no permission */ }
  }
  return null;
}

async function phoneClipWrite(text) {
  if (typeof window.desk?.clipboardWrite === 'function') {
    try { if (await window.desk.clipboardWrite(String(text ?? ''))) return true; } catch { /* fall through */ }
  }
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(String(text ?? '')); return true; } catch { /* no permission */ }
  }
  return false;
}

/** The VNC clipboard message is Latin-1: anything else needs the hub's way. */
function clipFitsVnc(text) {
  return /^[\x00-\xff]*$/.test(String(text));
}

function screenClipPath() {
  const botId = state.computer?.desktop?.botId || state.computer?.botId || state.botId;
  return botId ? `/api/bots/${encodeURIComponent(botId)}/desktop/clipboard` : '';
}

/**
 * Put text on the remote screen's clipboard. Latin-1 text goes through the
 * viewer; other text (Chinese) is written there by that machine's hub. With
 * {paste}, text that clipboard cannot take is typed into the bot's browser.
 * -> {ok, lossy, typed}: lossy = it went through the viewer and lost
 *    characters; typed = it is already in (do not press Ctrl+V).
 */
async function pushRemoteClip(rfb, text, { paste = false } = {}) {
  const value = String(text ?? '');
  if (!value) return { ok: false };
  if (!clipFitsVnc(value) && screenClipPath()) {
    const res = await api(screenClipPath(), { method: 'POST', body: { text: value } }).catch(() => null);
    if (res?.ok) return { ok: true, lossy: false };
    if (paste) {
      const typed = await api(screenClipPath().replace(/clipboard$/, 'type'), { method: 'POST', body: { text: value } }).catch(() => null);
      if (typed?.ok) return { ok: true, lossy: false, typed: true };
    }
  }
  if (!rfb) return { ok: false };
  rfb.clipboardPasteFrom(value);
  return { ok: true, lossy: !clipFitsVnc(value) };
}

/** What the remote copied: the viewer's text, or the hub's when it has more. */
async function pullRemoteClip(viewerText) {
  const text = String(viewerText ?? '');
  // Characters outside Latin-1 arrive as "?": ask the hub for the real text.
  if (!text.includes('?') || !screenClipPath()) return text;
  const res = await api(screenClipPath()).catch(() => null);
  return res?.ok && res.text ? res.text : text;
}

/* ---------------------------------------------------------------------
   scroll behaviour: follow along only when the reader is at the bottom
   --------------------------------------------------------------------- */
function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (!force && !nearBottom()) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ---------------------------------------------------------------------
   service worker - only where it can actually work
   --------------------------------------------------------------------- */
function registerServiceWorker() {
  try {
    const proto = location.protocol;
    const host = location.hostname;
    const allowed = proto === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!allowed || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  } catch { /* never let PWA wiring break the UI */ }
}

/* ---------------------------------------------------------------------
   auth / pairing
   --------------------------------------------------------------------- */
let authShown = false;

function setAuthMsg(text, ok = false) {
  const node = $('auth-msg');
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('ok', Boolean(ok));
}

function enterAuth(reason) {
  if (authShown) {
    if (reason) setAuthMsg(reason);
    return;
  }
  authShown = true;
  state.settingsOpen = false;
  $('app').classList.add('is-hidden');
  $('auth-screen').hidden = false;
  const field = $('auth-url');
  if (!field.value) field.value = location.origin;
  // Inside the desktop app on another machine: a way back (1.5.6), and the
  // command that shows this machine's code on the machine itself.
  $('auth-back').hidden = !(window.desk?.useLocal && !onLocalMachine());
  setAuthMsg(reason || '');
  if (!isMobile()) setTimeout(() => $('auth-code').focus(), 80);
}

/** Can the 8-digit code be used at this address? (no through the relay, direct or the public door; /api/auth says, 1.5.47) */
let codeAllowedHere = true;

/** Was this browser signed in at this address before? (localStorage is per address) */
function pairedHereBefore() {
  try { return localStorage.getItem('lamplit.pairedHere') === '1'; } catch { return false; }
}

async function checkAuth() {
  try {
    const auth = await api('/api/auth');
    if (auth && auth.codeAllowed === false) codeAllowedHere = false;
    if (auth?.authorized) { try { localStorage.setItem('lamplit.pairedHere', '1'); } catch { /* no storage */ } }
    return auth;
  } catch (err) {
    if (err.status === 401) return { required: true, authorized: false, mode: 'pairing' };
    if (err.status === 404) return { required: false, authorized: true, supported: false };
    throw err;
  }
}

/* While a one-time code from the address is being spent (boot), a refused request is expected. */
let pairingFromAddress = false;

/* A phone can be handed a pairing code through ?pair=CODE. Consume it once, in place. */
function hasPairParam() {
  try { return Boolean(new URL(location.href).searchParams.get('pair')); } catch { return false; }
}

/** The code out of the address, unused (this page is logged in already). */
function dropPairParam() {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('pair');
    history.replaceState(null, '', url.toString());
  } catch { /* keep the address */ }
}

/** Pair with the code in the address; the cookie it sets serves this page from now on. -> paired? */
async function consumePairParam() {
  let url;
  try { url = new URL(location.href); } catch { return false; }
  const code = url.searchParams.get('pair');
  if (!code) return false;
  url.searchParams.delete('pair');
  history.replaceState(null, '', url.toString());
  try {
    await api('/api/pair', { method: 'POST', body: { code: code.replace(/\s+/g, '') } });
    return true;
  } catch {
    return false;
  }
}

function normalizeCode(raw) {
  return String(raw || '').replace(/\s+/g, '').trim();
}

/**
 * The machine this page was switched away from: `{ origin, name }` or null.
 * The phone keeps a session per origin, so going back is one navigation and no
 * credential. `fromName` is what the other side called it (hostname), so the
 * list can say "← MY-LAPTOP" instead of an IP address.
 */
function cameFromMachine() {
  try {
    const params = new URL(location.href).searchParams;
    const raw = params.get('from') || '';
    if (!raw) return null;
    const target = new URL(raw);
    if (target.origin === location.origin) return null;
    return { origin: target.origin, name: (params.get('fromName') || '').trim() };
  } catch {
    return null;
  }
}

async function connectDevice() {
  const code = normalizeCode($('auth-code').value);
  const rawUrl = $('auth-url').value.trim() || location.origin;

  if (!code) { setAuthMsg('先输入配对码。'); $('auth-code').focus(); return; }

  let target;
  try { target = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`); }
  catch { setAuthMsg('地址格式不对，例如 http://192.168.1.8:4390'); return; }

  if (target.origin !== location.origin) {
    // Different machine than this page: hand the code over and let that Desk pair us.
    try {
      const next = new URL(target.origin);
      next.searchParams.set('pair', code);
      setAuthMsg('正在前往 ' + target.origin + ' …', true);
      location.href = next.toString();
    } catch {
      setAuthMsg('这个地址打不开，检查一下是不是同一局域网。');
    }
    return;
  }

  const button = $('auth-connect');
  button.disabled = true;
  button.textContent = '连接中…';
  try {
    await api('/api/pair', { method: 'POST', body: { code } });
    setAuthMsg('配对成功，正在进入…', true);
    setTimeout(() => location.reload(), 350);
  } catch (err) {
    button.disabled = false;
    button.textContent = '连接';
    if (err.code === 'PAIR_INVALID_CODE' || err.status === 401) {
      setAuthMsg('配对码不对。配对码每天换一次，看下面「找不到配对码？」。');
    } else if (err.code === 'PAIR_CODE_NOT_ALLOWED_PUBLIC') {
      setAuthMsg('从这个地址进来不能用 8 位配对码（为了安全）：请用 Lamplit 手机 App 扫二维码，或者在 Lamplit 桌面应用里打开这台机器。');
    } else if (err.code === 'PAIR_RATE_LIMITED' || err.status === 429) {
      setAuthMsg('试得太多次了，等一分钟再试。');
    } else if (err.status === 404) {
      setAuthMsg('服务端还没有配对接口（404）。如果你就在这台电脑上，可以直接刷新试试。');
    } else {
      setAuthMsg(err.message || '配对失败，检查配对码是否过期。');
    }
  }
}

/* ---------------------------------------------------------------------
   boot
   --------------------------------------------------------------------- */
async function boot() {
  // Before anything asks the hub: requests refused while a code in the address is still to be spent are expected.
  pairingFromAddress = hasPairParam();
  initTheme();
  wireChrome();
  initTimezone();
  renderComputerPane();
  refreshMachines();
  applyLayoutPrefs();
  startScreenLoop();
  registerServiceWorker();
  setupViewport();

  let auth;
  try {
    auth = await checkAuth();
  } catch (err) {
    showFatal(err);
    return;
  }
  // A one-time code in the address (?pair=, the phone app opening a machine):
  // spent quietly before anything shows - not after the pairing screen, and no
  // reload (1.5.39: on the relay every switch showed 配对 and loaded twice).
  // Already logged in here: dropped unused.
  if (hasPairParam()) {
    if (auth.required && !auth.authorized) {
      pairingFromAddress = true;
      if (await consumePairParam()) {
        // Logged in now. Whatever started before (machine list, screens) was
        // refused: start again, once, as a logged-in page - no pairing screen shown.
        location.replace(location.href);
        return;
      }
      pairingFromAddress = false;
    } else {
      dropPairParam();
    }
  }
  pairingFromAddress = false;
  state.auth = auth;

  if (auth.required && !auth.authorized) {
    enterAuth('');
    return;
  }


  try {
    const [health, config, bots] = await Promise.all([
      api('/api/health'),
      api('/api/config'),
      api('/api/bots'),
    ]);
    state.health = health;
    state.config = config;
    state.bots = bots;
  } catch (err) {
    if (err.status === 401) return;
    showFatal(err);
    return;
  }

  const target = approvalTarget();
  // A phone opens on the home page (the list of bots): it is there before the
  // page shows, not after the settings load - meanwhile an empty chat showed (1.5.39).
  if (!target && isMobile() && state.bots.length) openSidebar();
  $('app').classList.remove('is-hidden');
  applyShellConfig();

  // Settings, the voice list and the groups do not wait for each other: on a
  // phone over a slow link every round trip is most of a second.
  // (The voice list is in before the chat renders: whether replies get "read aloud".)
  renderBots();
  await Promise.allSettled([loadSettings(), loadVoice(), loadGroups()]);
  const primary = state.bots.find((b) => b.primary) || state.bots[0];
  // A notification tap names the bot it came from: the approval card lives in
  // that transcript, so landing on the primary bot would hide the destination.
  const dest = (target && target.botId && state.bots.find((b) => b.id === target.botId)) || primary;
  if (!target && isMobile() && dest) {
    // A phone opens on the home page (the list of bots) at once; the chat
    // behind it loads meanwhile, instead of holding the home page back.
    openSidebar();
    selectBot(dest.id, { keepHome: true }).catch(() => {});
  } else if (dest) await selectBot(dest.id);
  else renderMessages();
  if (target) focusApprovalFromLink(target);
  else if (isMobile() && !dest) openSidebar();

  await Promise.allSettled([loadSkills(), loadRoutines(), loadActivity()]);
  state.ready = true;
  connectStream();
  loadAttention();
  setInterval(whenVisible(loadAttention), 60000);
  pollOtherMachines();
  setInterval(whenVisible(pollOtherMachines), 20000);
  // The other machines' waiting cards (1.5.41): every 20 s on screen, every minute
  // behind other windows, so a new one can still be announced.
  refreshInbox({ notify: false });
  let inboxTick = 0;
  setInterval(() => { inboxTick += 1; if (!document.hidden || inboxTick % 3 === 0) refreshInbox(); }, 20000);
  // The other machines' bots in this sidebar (1.5.42 一个花名册): every 20 s on screen.
  loadRoster();
  setInterval(whenVisible(loadRoster), 20000);
  // A phone with the screen off used to keep polling (and re-drawing ~1.5 MB
  // screenshots every 5s). Background tabs now stay quiet until they come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    markSeen();
    pollHealth();
    loadAttention();
    refreshInbox();
    if (state.tab === 'computer') refreshScreen();
    maybeCheckForUpdate();
  });
  window.addEventListener('focus', () => markSeen());
  pollHealth();
  setInterval(whenVisible(pollHealth), 15000);
  // Keep the server's copy fresh enough for the primary bot to answer
  // "现在是什么主题 / 在控制哪台机器" without a round trip to the browser.
  reportUiState();
  setInterval(whenVisible(reportUiState), 30000);
  deliverPendingTask();
  // 有新版本: a few seconds after start, then hourly and on coming back after
  // half an hour (the machine asks GitHub at most hourly), 1.5.0.
  setTimeout(() => checkForUpdate().catch(() => {}), 8000);
  setInterval(whenVisible(() => checkForUpdate().catch(() => {})), 60 * 60 * 1000);
}

/** Wrap a polling function so a hidden tab (phone screen off) does not poll. */
function whenVisible(fn) {
  return (...args) => {
    if (document.hidden) return;
    return fn(...args);
  };
}

function showFatal(err) {
  $('app').classList.remove('is-hidden');
  messagesEl.innerHTML = '';
  const wrap = el('div', 'empty');
  wrap.appendChild(el('h2', null, '连不上 Lamplit'));
  wrap.appendChild(el('p', null, err && err.message ? err.message : '服务没有响应。'));
  const retry = el('button', 'btn primary', '重试');
  retry.addEventListener('click', () => location.reload());
  wrap.appendChild(retry);
  messagesEl.appendChild(wrap);
}

function applyShellConfig() {
  const cfg = state.config || {};
  if ($('timezone-pill')) $('timezone-pill').textContent = timezoneLabel(effectiveTimezone());
  updateModelUi();
}

/* ---------------------------------------------------------------------
   model state: mock / configured, and what that means for the composer
   --------------------------------------------------------------------- */
function modelState() {
  const s = (state.settings && state.settings.model) || {};
  const cfg = (state.config && state.config.model) || {};
  const provider = s.provider || cfg.provider || 'mock';
  const model = s.model || cfg.model || '—';
  const hasKey = typeof s.hasKey === 'boolean' ? s.hasKey : provider !== 'mock';
  return { provider, model, hasKey, unconfigured: provider === 'mock' || hasKey === false };
}

function hasConversation() {
  return state.messages.some((m) => m.role !== 'status');
}

function composerBlocked() {
  // A bot on another machine uses that machine's model (1.5.42).
  if (remoteChatMachine()) return false;
  return state.unconfigured && !state.mockAck && !hasConversation();
}

function updateModelUi() {
  const info = modelState();
  state.unconfigured = info.unconfigured;

  const label = info.provider === 'mock' ? '演示模式' : (info.model !== '—' ? info.model : info.provider);
  // The model lives in Settings; the footer only says whether it is healthy.
  if ($('settings-btn')) $('settings-btn').title = `设置 · ${label.slice(0, 44)}${info.unconfigured ? '（未配置）' : ''}`;

  updateComposerMode();

  // about block
  const st = state.settings || {};
  const app = st.app || {};
  $('about-app').textContent = 'Lamplit';
  $('about-version').textContent = app.version || (state.config && state.config.version) || '—';
  if ($('about-update-row')) $('about-update-row').hidden = !canUpdateHere();
  const server = st.server || {};
  $('about-server').textContent = `${server.host || location.hostname}${server.port ? ':' + server.port : (location.port ? ':' + location.port : '')}`;
  refreshDoorRoute();
  renderPhoneRoad();
  syncMachineBranding();
  const authRequired = state.auth ? Boolean(state.auth.required) : Boolean(server.requireAuth);
  $('about-auth').textContent = authRequired ? '需要配对（本机除外）' : '本机：桌面应用里直接用；在浏览器里批准、改权限，要先把浏览器配对一次';
  // In the phone app (1.5.48 beginner test): 127.0.0.1:144xx is the app's own way in, not this
  // machine's address, and 「本机」 talk is about the computer. Say what matters on the phone.
  if (throughPhoneRelay()) {
    for (const id of ['about-server', 'about-origin']) { const row = $(id)?.closest('.kv'); if (row) row.hidden = true; }
    $('about-auth').textContent = '这部手机已经配对，经 Lamplit App 连到这台机器';
  }
}

function updateComposerMode() {
  const blocked = composerBlocked();
  const input = $('composer');
  input.disabled = blocked;
  $('send-btn').disabled = blocked || state.sending;
  if (blocked) {
    input.placeholder = '先接入一个模型…';
  } else if (isGroupMode()) {
    const group = groupById(state.groupId);
    const coordinator = groupCoordinator(group);
    input.placeholder = `发到「${group ? group.name : '群组'}」· 输入 @ 指定谁来回答，不指定就由 ${coordinator ? coordinator.name : '协调者'} 先答…`;
  } else {
    const title = $('chat-title').textContent || '你的助手';
    const pad = padName(title);
    input.placeholder = `给${pad}${title}${pad}发消息…`;
  }
  const far = remoteChatMachine();
  $('mock-banner').hidden = !(state.unconfigured && !blocked) || Boolean(far);
  $('composer-hint').textContent = blocked
    ? '还没接入模型 · 去左下角「设置」看看'
    : far ? `它在「${far}」上做事：要动那台电脑的操作，会先问过你` : '需要动你电脑的操作，会先问过你';
}

function refreshMockState() {
  updateModelUi();
  renderMessages();
}

/*
 * First run (1.5.8, report 7.1 #1): three steps in the empty chat.
 *   1 pick a provider - DeepSeek first, each with where to get a key
 *   2 paste the key
 *   3 Lamplit saves it, tests it and sends the first sentence
 * The demo is still one click away; Settings → 模型 has everything else.
 */
/**
 * First things to try (1.5.30): everyday work, not system reports. Shown in
 * an empty chat, and under the first exchange - the first-run guide sends
 * "你好" itself, so the empty chat with them was never seen.
 */
const STARTER_EXAMPLES = [
  ['A', '整理下载文件夹', '按类型分好，先给你看打算怎么动', '看看我的下载文件夹，按类型（图片、文档、安装包、压缩包）整理到子文件夹里。先列出你打算怎么动，等我同意再动手。'],
  ['B', '上网查资料', '给结论，附出处', '上网查一下：现在适合新手的 AI 写作工具有哪些？挑 3 个，说说各自的优缺点和价格，附上出处。'],
  ['C', '写一份东西', '邮件、通知、周报都行', '帮我写一封请假邮件：明天下午请半天假去医院，语气礼貌、简短。'],
  ['D', '每天提醒我', '到点自己跑，不用你记着', '每天早上 8 点给我一份简报：今天的天气、这台电脑的磁盘空间够不够，有异常就提醒我。'],
];

/** 「有事先找助理」 (1.5.40), with the main assistant's own name. */
function askPrimaryTip() {
  const primary = (state.bots || []).find((b) => b.primary);
  // Alone, there is nobody to hand work to (1.5.40 test: the line sounded empty).
  if ((state.bots || []).length <= 1) return `有什么事直接跟「${primary?.name || '助理'}」说就行。想要别的帮手，也跟它说一声，它会替你建好。`;
  return `不知道找谁，就跟「${primary?.name || '助理'}」说，它会交给合适的助手。`;
}

/** Under a chat's first exchange with the primary assistant: 试试这些. */
function appendStarters(visible) {
  const bot = botById(state.botId);
  if (isGroupMode() || !bot?.primary || state.showProcess) return;
  const said = visible.filter((m) => m.role === 'user').length;
  if (said > 1 || !visible.some((m) => m.role === 'assistant')) return;
  const row = el('div', 'starter-row');
  row.appendChild(el('span', 'starter-label', '试试这些：'));
  for (const [, title, , prompt] of STARTER_EXAMPLES) {
    const chip = el('button', 'starter-chip', title);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      const composer = $('composer');
      composer.value = prompt;
      autoGrow(composer);
      composer.focus();
    });
    row.appendChild(chip);
  }
  messagesEl.appendChild(row);
  // The first-run guide ends here (it sent the first sentence itself): say the one rule worth knowing.
  messagesEl.appendChild(el('div', 'starter-tip', askPrimaryTip()));
  appendIsolationAsk().catch(() => {});
}

/**
 * The last step of getting started (1.5.32), asked once, on this computer: give
 * the bots' commands a Windows account of their own. Without it a command runs
 * as the human and could read the key that lets a program decide for them.
 */
const ISOLATION_ASKED = 'lamplit.isolationAsked';
async function appendIsolationAsk() {
  if (!window.desk || !onLocalMachine()) return;
  try { if (localStorage.getItem(ISOLATION_ASKED)) return; } catch { return; }
  const policy = await api('/api/policy').catch(() => null);
  const sb = policy?.sandbox;
  if (sb?.mode !== 'windows' || !['setup', 'off'].includes(sb.state) || messagesEl.querySelector('.isolation-ask')) return;
  const done = () => { try { localStorage.setItem(ISOLATION_ASKED, '1'); } catch { /* asked again next time */ } card.remove(); };
  const card = el('div', 'isolation-ask');
  card.appendChild(el('b', '', '最后一步（可以跳过）：给机器人一个单独的账户？'));
  card.appendChild(el('span', 'row-note', '开了以后，机器人执行的命令用一个隐藏的普通账户来跑，碰不到你的个人文件夹和 Lamplit 的密钥，没法替你点「同意」。要点一次管理员确认；以后在 设置 → 边界 里也能开。'));
  const row = el('div', 'btn-row');
  const yes = el('button', 'btn tiny primary', '设置单独账户');
  yes.type = 'button';
  yes.addEventListener('click', async () => { done(); await setupRunnerAccount(); });
  const later = el('button', 'btn tiny', '以后再说');
  later.type = 'button';
  later.addEventListener('click', () => { done(); toast('好的。体检里会一直提醒这一项，在 设置 → 边界 里随时能开。'); });
  row.append(yes, later);
  card.appendChild(row);
  messagesEl.appendChild(card);
}

/** Make the lamplit-runner account (a UAC prompt on this computer). */
async function setupRunnerAccount() {
  try {
    const s = await api('/api/runner/setup', { method: 'POST', body: {} });
    if (typeof renderSandboxState === 'function') renderSandboxState(s);
    toast('在弹出的管理员确认里点「是」，几秒钟就设好。');
  } catch (err) {
    toast(err.message ? `没能开始设置：${err.message}` : '', true);
  }
}

/** 体检's 「设好密码」 (1.5.53): TightVNC gets a random password; Lamplit signs in for you from then on. */
async function secureScreen() {
  toast('如果弹出管理员确认，点「是」。');
  const r = await api('/api/desktop/secure-vnc', { method: 'POST', body: {} }).catch((err) => ({ reason: err.message }));
  toast(r?.state === 'secured' ? '屏幕密码设好了。' : `没设好：${r?.reason || r?.state || ''}`, r?.state !== 'secured');
}

const ONBOARD_PROVIDERS = ['deepseek', 'moonshot', 'zhipu', 'qwen', 'siliconflow', 'openai'];
const ONBOARD_FIRST = '你好！用两三句话介绍一下你能帮我做什么。';
const onboard = { step: 1, provider: '', error: '', busy: false };

function onboardingCard() {
  const wrap = el('div', 'empty onboard');
  // The guide starts at its top (1.5.30: the chat scrolled it to the middle, title and steps out of sight).
  requestAnimationFrame(() => { if (messagesEl.querySelector('.onboard')) messagesEl.scrollTop = 0; });
  wrap.appendChild(emptyMark());
  const steps = el('div', 'onboard-steps');
  ['选服务商', '填密钥', '试一句'].forEach((name, i) => steps.appendChild(el('span', `onboard-step${onboard.step === i + 1 ? ' on' : onboard.step > i + 1 ? ' done' : ''}`, `${i + 1} ${name}`)));
  wrap.appendChild(steps);
  const providers = (state.providers || []);
  const preset = (name) => providers.find((p) => p.name === name) || null;
  if (!state.providers) ensureProviderOptions().then(() => { if (state.unconfigured && !state.mockAck) renderMessages(); }).catch(() => {});

  if (onboard.step === 1) {
    wrap.appendChild(el('h2', null, '先接入一个模型'));
    wrap.appendChild(el('p', null, '现在用的是内置演示，回答由脚本生成，不会真的理解你的话。选一家模型服务商，填上密钥，它就开始正经干活。'));
    const choices = el('div', 'choice-list');
    ONBOARD_PROVIDERS.forEach((name, i) => {
      const p = preset(name);
      if (!p && providers.length) return;
      const label = p?.label || name;
      const desc = name === 'deepseek' ? '推荐：中文好、便宜；新账号先充几块钱就能用' : (p?.models?.[0] ? `默认模型 ${p.models[0]}` : '');
      choices.appendChild(choiceButton(String.fromCharCode(65 + i), label, desc, () => { onboard.provider = name; onboard.step = 2; onboard.error = ''; renderMessages(); }));
    });
    choices.appendChild(choiceButton('·', '先用演示模式看看', '不填任何东西，先熟悉界面和审批流程', () => {
      state.mockAck = true;
      try { sessionStorage.setItem('desk.mockAck', '1'); } catch { /* private mode */ }
      refreshMockState();
    }));
    wrap.appendChild(choices);
    const more = el('button', 'btn ghost tiny', '其他服务商、自己的地址：去设置 → 模型');
    more.type = 'button';
    more.addEventListener('click', () => openSettings('sec-model'));
    wrap.appendChild(more);
    return wrap;
  }

  const p = preset(onboard.provider) || { name: onboard.provider, label: onboard.provider, models: [], baseUrl: '' };
  wrap.appendChild(el('h2', null, `填上 ${p.label} 的密钥`));
  const how = el('p', null, `在服务商的网站登录，新建一个 API Key，复制回来贴在下面。密钥只存在这台电脑上，加密保存。${onboard.provider === 'deepseek' ? '新账号要先充值（几块钱就够用很久），否则会提示余额不足。' : ''}`);
  wrap.appendChild(how);
  if (p.keyUrl) {
    const get = el('button', 'btn tiny', `去 ${p.label} 拿密钥 ↗`);
    get.type = 'button';
    get.addEventListener('click', () => openSignInPage(p.keyUrl));
    wrap.appendChild(get);
  }
  const key = el('input', 'field onboard-key');
  key.type = 'password';
  key.placeholder = 'sk-…';
  key.autocomplete = 'off';
  key.spellcheck = false;
  wrap.appendChild(key);
  const go = el('button', 'btn primary', onboard.busy ? '正在连接…' : '连接并试一句');
  go.type = 'button';
  go.disabled = onboard.busy;
  const msg = el('div', `onboard-msg${onboard.error ? ' bad' : ''}`, onboard.error || (onboard.busy ? '保存密钥，测试连接，然后替你发第一句话…' : ''));
  const back = el('button', 'btn ghost tiny', '← 换一家');
  back.type = 'button';
  back.addEventListener('click', () => { onboard.step = 1; onboard.error = ''; renderMessages(); });
  const connect = async () => {
    const apiKey = key.value.trim();
    if (!apiKey) { onboard.error = '先把密钥贴进来。'; renderMessages(); return; }
    onboard.busy = true; onboard.error = ''; onboard.step = 3; renderMessages();
    const model = { provider: p.name, baseUrl: p.baseUrl || '', model: (p.models || [])[0] || '', apiKey };
    try {
      // Tested before it is saved: a wrong key must not replace the demo and end the guide.
      const test = await api('/api/settings/test', { method: 'POST', body: { model } });
      if (test && (test.ok === false || test.error)) throw new Error(typeof test.error === 'string' ? test.error : test.error?.message || '连不上');
      await putSettings(model);
      await loadSettings();
      try { state.config = await api('/api/config'); } catch { /* non-fatal */ }
      onboard.busy = false; onboard.step = 1;
      updateModelUi();
      renderMessages();
      // One model for every machine, as when saved in Settings.
      if (machineBridge?.local && (machineBridge.machines || []).length && window.desk?.syncModel) window.desk.syncModel().catch(() => {});
      // The first sentence, so the human sees it work.
      const composer = $('composer');
      composer.value = ONBOARD_FIRST;
      send();
    } catch (err) {
      onboard.busy = false; onboard.step = 2;
      // The machine already says what it means and what to do (1.5.30); only an unexplained one gets the old hint.
      const said = String(err.message || '');
      onboard.error = /^(密钥不对|账户没钱|请求太多|服务商|这次要发|连不上服务商|模型服务商)/.test(said)
        ? said
        : `没连上：${truncate(said || '未知原因', 160)}。检查一下密钥有没有复制全，或者换一家试试。`;
      renderMessages();
    }
  };
  go.addEventListener('click', connect);
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });
  wrap.appendChild(go);
  wrap.appendChild(msg);
  wrap.appendChild(back);
  if (!onboard.busy) setTimeout(() => key.focus(), 50);
  return wrap;
}
// end of first run

/* ---------------------------------------------------------------------
   health
   --------------------------------------------------------------------- */
async function pollHealth() {
  try {
    state.health = await api('/api/health');
    $('health-dot').className = `dot ${state.health.ok ? 'ok' : 'bad'}`;
    setConnected(true);
    const m = state.health.model || {};
    if ((state.settings && state.settings.model && state.settings.model.provider) === undefined && $('settings-btn')) {
      $('settings-btn').title = `设置 · ${m.provider === 'mock' ? '演示模式' : `${m.model || m.provider}`.slice(0, 44)}`;
    }
  } catch (err) {
    $('health-dot').className = 'dot bad';
    if (err.status === 401) return;
    // A 4xx/5xx means the machine answered: only silence counts as offline.
    if (!err.status) setConnected(false);
  }
}

/* ---------------------------------------------------------------------
   bots
   --------------------------------------------------------------------- */

/** Re-read the roster after an out-of-band change (tool call or another
 *  device). Falls back to the primary bot when the open one disappeared. */
async function refreshRoster() {
  // A change that arrives while the list is loading must not be lost (bots
  // created and deleted in quick succession left a deleted bot on screen):
  // load once more right after.
  if (state.rosterBusy) { state.rosterAgain = true; return; }
  state.rosterBusy = true;
  state.rosterAgain = false;
  try {
    const bots = await api('/api/bots');
    const before = state.bots.map((b) => b.id).join(',');
    state.bots = bots;
    if (typeof loadGroups === 'function') await loadGroups().catch(() => {});
    if (!isGroupMode() && !isRemoteId(state.botId) && !bots.some((b) => b.id === state.botId)) {
      const next = bots.find((b) => b.primary) || bots[0];
      if (next) {
        await selectBot(next.id);
        toast('当前助手已被删除，已切回 ' + next.name);
      }
    } else if (before !== bots.map((b) => b.id).join(',')) {
      renderBots();
    }
  } catch {
    /* a stale roster is not worth a toast */
  } finally {
    state.rosterBusy = false;
    if (state.rosterAgain) refreshRoster();
  }
}

function renderBots() {
  const list = $('bot-list');
  list.innerHTML = '';
  $('bot-count').textContent = String(state.bots.length);
  // Cards waiting on your other machines (1.5.41): a row on top, the inbox one tap
  // away - the phone's home list has no header with 「N 个操作等你确认」.
  const away = state.inbox?.items?.length || 0;
  if (away) {
    const row = el('button', 'inbox-row', away === 1 ? '别的机器上有 1 个操作等你确认' : `别的机器上有 ${away} 个操作等你确认`);
    row.type = 'button';
    row.addEventListener('click', () => openInbox());
    list.appendChild(row);
  }

  // 「全部机器」 (1.5.42, laid out in 1.5.43): 「最近」, then one section per machine, groups first.
  const grouped = rosterGrouped();
  const sideHead = list.parentElement?.querySelector('.side-head'); if (sideHead) sideHead.hidden = grouped;
  if ($('roster-search-wrap') && !grouped) $('roster-search-wrap').hidden = true;
  if (grouped) { renderRosterSidebar(list); filterHome(); if ($('perm-summary')) renderPermOverview(); return; }
  // The primary bot is always on top; the rest by their newest message (like a chat app).
  const when = (b) => Date.parse(b.preview?.ts || '') || 0;
  const ordered = [...state.bots].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || when(b) - when(a));
  for (const bot of ordered) list.appendChild(botRow(bot));
  filterHome();
  if ($('perm-summary')) renderPermOverview();
}

/** One of this machine's bots in the sidebar: face, name, status line, its menu. */
function botRow(bot) {
  {
    const active = !isGroupMode() && bot.id === state.botId;
    const row = el('div', `bot${active ? ' active' : ''}${bot.primary ? ' is-primary' : ''}`);
    row.dataset.bot = bot.id;
    // What it is doing, waits on or finished; its role while nothing is going on (1.5.40).
    const last = lastLine(bot);
    let line = rosterLine(`bot:${bot.id}`, { idle: bot.role || last || '还没有消息', last });
    const waiting = bot.primary && !line.kind ? othersWaitingLine(`bot:${bot.id}`) : '';
    if (waiting) line = { kind: 'needs', text: waiting };
    row.dataset.search = `${bot.name} ${bot.role || ''} ${last} ${line.text}`.toLowerCase();
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-pressed', active ? 'true' : 'false');

    const av = avatarNode(bot, 38, 'bot-av');
    av.setAttribute('role', 'img');
    av.setAttribute('aria-label', `${bot.name} 的头像，点按自定义`);
    av.title = '自定义头像';
    av.addEventListener('click', (event) => {
      // On the phone's home page the avatar is the way into the chat.
      if (isMobile()) return;
      event.stopPropagation();
      openAvatarCustomizer(bot.id);
    });

    const text = el('div', 'bot-text');
    const nameRow = el('div', 'bot-name');
    nameRow.appendChild(el('span', 'bot-name-text', bot.name));
    if (bot.primary) nameRow.appendChild(el('span', 'badge', '主'));
    text.appendChild(nameRow);
    text.appendChild(rosterLineNode(line));

    // kebab → rename / role / delete
    const more = el('button', 'bot-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', `管理 ${bot.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    const menu = el('div', 'menu bot-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const mkItem = (label, action, extra = '') => {
      const item = el('button', extra, label);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenus();
        action();
      });
      return item;
    };
    menu.appendChild(mkItem('重命名', () => openBotEdit(bot.id, { focus: 'name' })));
    menu.appendChild(mkItem('编辑职责', () => openBotEdit(bot.id, { focus: 'role' })));
    menu.appendChild(el('div', 'menu-sep'));
    const delItem = mkItem('删除', () => confirmDeleteBot(bot), 'danger');
    delItem.disabled = Boolean(bot.primary);
    delItem.title = bot.primary ? '主助理不能删' : '';
    menu.appendChild(delItem);
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu(menu, more);
    });

    row.appendChild(av);
    row.appendChild(text);
    const when = homeTime(bot.preview?.ts);
    if (when) row.appendChild(el('span', 'bot-time', when));
    const botAtt = attentionBadge(`bot:${bot.id}`);
    if (botAtt) row.appendChild(botAtt);
    row.appendChild(more);
    row.appendChild(menu);
    row.addEventListener('click', () => selectBot(bot.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectBot(bot.id);
      }
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      toggleMenu(menu, more);
    });
    return row;
  }
}

async function selectBot(id, { keepHome = false } = {}) {
  if (id !== state.botId) stopSpeaking();
  // A different bot means a different screen: always start in preview.
  const card = $('pc-screen-wrap');
  if (card) card.classList.remove('takeover');
  if ($('pc-desktop')) $('pc-desktop').textContent = '接管桌面';
  state.botId = id;
  if (state.groupId) {          // leaving a group for a 1:1 chat
    state.groupId = null;
    state.groupMessages = [];
    renderGroups();
  }
  // Picking a teammate always dismisses the drawers, on any width (not the
  // chat a phone loads behind its home page at start).
  if (!keepHome) { closeSidebar(); closePanel(); }
  const bot = botById(id);
  renderBots();
  if (!bot) return;

  renderBotHead(bot);
  // A bot on another machine: its name with the machine's (「助理 · 云服务器」, 1.5.42).
  const far = remoteOf(id);
  $('chat-title').textContent = far ? `${bot.name} · ${far.machine}` : bot.name;
  $('chat-sub').textContent = far ? remoteChatSub(bot) : (bot.role || '还没有设定职责');
  $('bot-memory-title').textContent = `${bot.name} 的记忆`;
  state.liveTurn = null;
  setWorking(false);
  refreshWorking();
  updateComposerMode();
  connectStream();
  connectRemoteStream();
  // Its own screen and its own routines, not the last chat's.
  followScreen();
  if (state.tab === 'activity') renderRoutines();
  renderDecisionStrip();

  await Promise.allSettled([loadMessages(), loadMemory()]);
  loadSkills();
  await refreshPendingApprovals();
  markSeen();
}

