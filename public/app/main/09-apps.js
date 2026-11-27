'use strict';
// Lamplit page, part 9 of 12: connected apps (MCP). Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   连接应用 (MCP): servers whose tools the bots can use
   --------------------------------------------------------------------- */
const mcpUi = { servers: [], presets: [] };
const MCP_SECRET_RE = /\$\{([^}]{1,40})\}/g;
const MCP_STATE_TEXT = { ready: '已连接', connecting: '连接中…', failed: '连接失败', off: '已停用', idle: '还没连接' };

async function loadMcp() {
  let data;
  let cat;
  try {
    [data, cat] = await Promise.all([api('/api/mcp'), api('/api/mcp/catalog')]);
  } catch {
    if ($('mcp-catalog')) $('mcp-catalog').textContent = '这台机器的 Lamplit 版本太旧，还不支持连接应用。';
    return;
  }
  mcpUi.servers = data.servers || [];
  mcpUi.presets = data.presets || [];
  mcpUi.apps = cat.apps || [];
  renderMcp();
  fillMcpPresets();
  loadXCard().catch(() => { /* older server: no X card */ });
}

function mcpLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function mcpPairs(text, sep) {
  const out = {};
  for (const line of mcpLines(text)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function mcpSecretNamesInForm() {
  const all = [$('mcp-args').value, $('mcp-env').value, $('mcp-url').value, $('mcp-headers').value].join('\n');
  return [...new Set([...all.matchAll(MCP_SECRET_RE)].map((m) => m[1].trim()))];
}

function renderMcpSecretInputs() {
  const box = $('mcp-secrets');
  if (!box) return;
  const want = mcpSecretNamesInForm();
  const keep = {};
  box.querySelectorAll('input[data-secret]').forEach((i) => { keep[i.dataset.secret] = i.value; });
  box.innerHTML = '';
  for (const name of want) {
    const label = el('label', 'lbl', `密钥：${name}`);
    const input = document.createElement('input');
    input.className = 'field';
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.dataset.secret = name;
    input.value = keep[name] || '';
    box.append(label, input);
  }
}

function fillMcpPresets() {
  const sel = $('mcp-preset');
  if (!sel || sel.options.length) return;
  sel.appendChild(new Option('自己填', ''));
  for (const p of mcpUi.presets) sel.appendChild(new Option(p.name, p.id));
}

function applyMcpPreset(id) {
  const p = mcpUi.presets.find((x) => x.id === id);
  $('mcp-preset-note').textContent = p?.note || '';
  if (!p) return;
  $('mcp-name').value = p.name;
  $('mcp-transport').value = p.transport;
  $('mcp-command').value = p.command || '';
  $('mcp-args').value = (p.args || []).join('\n');
  $('mcp-env').value = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  $('mcp-url').value = p.url || '';
  $('mcp-headers').value = Object.entries(p.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  syncMcpTransport();
  renderMcpSecretInputs();
}

function syncMcpTransport() {
  const http = $('mcp-transport').value === 'http';
  $('mcp-stdio-box').hidden = http;
  $('mcp-http-box').hidden = !http;
}

async function saveMcp() {
  const transport = $('mcp-transport').value;
  const secrets = {};
  $('mcp-secrets').querySelectorAll('input[data-secret]').forEach((i) => { if (i.value) secrets[i.dataset.secret] = i.value; });
  const missing = mcpSecretNamesInForm().filter((n) => !secrets[n]);
  if (missing.length) { toast(`还没填密钥：${missing.join('、')}`, true); return; }
  const body = {
    name: $('mcp-name').value.trim(),
    transport,
    command: $('mcp-command').value.trim(),
    args: mcpLines($('mcp-args').value),
    env: mcpPairs($('mcp-env').value, '='),
    url: $('mcp-url').value.trim(),
    headers: mcpPairs($('mcp-headers').value, ':'),
    secrets,
  };
  const btn = $('mcp-save');
  btn.disabled = true;
  try {
    await api('/api/mcp', { method: 'POST', body });
    toast(`已添加「${body.name || 'MCP'}」，正在连接（第一次可能要下载，稍等）`);
    ['mcp-name', 'mcp-command', 'mcp-args', 'mcp-env', 'mcp-url', 'mcp-headers'].forEach((x) => { $(x).value = ''; });
    $('mcp-preset').value = '';
    $('mcp-preset-note').textContent = '';
    $('mcp-secrets').innerHTML = '';
    $('mcp-add').open = false;
    await loadMcp();
  } catch (err) {
    toast(`添加失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function patchMcp(id, body, okText) {
  try {
    await api(`/api/mcp/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    if (okText) toast(okText);
    await loadMcp();
  } catch (err) { toast(`保存失败：${err.message}`, true); }
}

/** What a connected server's row says on the right. */
/** Connected means switched on (1.5.51): a switched-off app reads 「已停用」 and is not counted, filtered or listed first as connected. */
function mcpIsOn(srv) {
  return Boolean(srv) && srv.enabled !== false && srv.state !== 'off';
}

function mcpStateLabel(srv) {
  if (!srv) return '';
  if (srv.state === 'ready') return `✓ 已连接`;
  if (srv.state === 'needs_auth') return '需要重新授权';
  if (srv.state === 'connecting') return '连接中…';
  if (srv.state === 'failed') return '连接失败';
  if (srv.state === 'off') return '已停用';
  return '还没连接';
}

/** The settings of one connected server: on/off, ask or always, which bots, keys, tools. */
function mcpServerPanel(s) {
  const box = el('div', 'mcp-app-body');
  if (s.state === 'ready') box.appendChild(el('div', 'row-note', `已连接 · ${s.tools.length} 个工具`));
  if ((s.state === 'failed' || s.state === 'needs_auth') && s.error) box.appendChild(el('div', 'row-note mcp-warn', `原因：${s.error}`));
  const onLbl = el('label', 'row-note');
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = s.enabled;
  onLbl.append(on, document.createTextNode(' 启用'));
  on.addEventListener('change', () => patchMcp(s.id, { enabled: on.checked }, on.checked ? `已启用「${s.name}」` : `已停用「${s.name}」`));
  const trust = document.createElement('select');
  trust.className = 'field';
  trust.append(new Option('每次调用前先问我（只读的不问）', 'ask'), new Option('始终允许，不用问', 'always'));
  trust.value = s.trust;
  trust.addEventListener('change', () => patchMcp(s.id, { trust: trust.value }, trust.value === 'always' ? `「${s.name}」的工具以后不再问你` : `「${s.name}」的工具每次先问你`));
  const who = document.createElement('select');
  who.className = 'field';
  who.appendChild(new Option('所有机器人都能用', 'all'));
  for (const b of state.bots || []) who.appendChild(new Option(`只给「${b.name}」`, b.id));
  who.value = s.bots === 'all' ? 'all' : (Array.isArray(s.bots) && s.bots[0]) || 'all';
  who.addEventListener('change', () => patchMcp(s.id, { bots: who.value === 'all' ? 'all' : [who.value] }, '已保存'));
  box.append(onLbl, el('label', 'lbl', '要不要先问你'), trust, el('label', 'lbl', '哪些机器人能用'), who);
  if (s.catalogId === 'email') box.appendChild(mailboxList(s));
  else if (s.secrets.length) {
    const sec = el('details', 'vault-add');
    sec.appendChild(el('summary', '', '更新密钥'));
    const inputs = s.secrets.map((name) => {
      const i = document.createElement('input');
      i.className = 'field';
      i.type = 'password';
      i.autocomplete = 'new-password';
      i.placeholder = `${name}（留空不改）`;
      i.dataset.secret = name;
      sec.appendChild(i);
      return i;
    });
    const save = el('button', 'btn primary tiny', '保存并重新连接');
    save.type = 'button';
    save.addEventListener('click', () => {
      const secrets = {};
      for (const i of inputs) if (i.value) secrets[i.dataset.secret] = i.value;
      if (!Object.keys(secrets).length) { toast('没有要改的内容'); return; }
      patchMcp(s.id, { secrets }, '已更新密钥，正在重新连接');
    });
    sec.appendChild(save);
    box.appendChild(sec);
  }
  if (s.tools.length) {
    const tools = el('details', 'vault-add');
    tools.appendChild(el('summary', '', `它提供的工具（${s.tools.length} 个）`));
    for (const t of s.tools) {
      const line = el('div', 'row-note');
      line.appendChild(el('b', '', t.name));
      line.appendChild(document.createTextNode(`${t.readOnly ? '（只读）' : ''}：${t.description}`));
      tools.appendChild(line);
    }
    box.appendChild(tools);
  }
  const row = el('div', 'btn-row');
  const test = el('button', 'btn tiny', s.oauth && s.state === 'needs_auth' ? '重新授权' : '重新连接');
  test.type = 'button';
  const del = el('button', 'btn tiny danger', s.catalogId ? '只在这台断开' : '断开并删除');
  del.type = 'button';
  row.append(test);
  if (s.catalogId && s.state === 'ready') {
    const sync = el('button', 'btn tiny', '同步到其他机器');
    sync.type = 'button';
    sync.title = '在其他机器上也连上它（Notion 这类要登录的，每台机器登录一次）';
    sync.addEventListener('click', () => syncMcpApp({ id: s.catalogId, name: s.name }, sync));
    row.append(sync);
  }
  row.append(del);
  // A catalog app is connected on every machine by default: disconnecting can be everywhere too.
  let delAll = null;
  if (s.catalogId) {
    delAll = el('button', 'btn tiny danger', '在所有机器上断开');
    delAll.type = 'button';
    row.append(delAll);
  }
  box.appendChild(row);
  test.addEventListener('click', async () => {
    if (s.oauth && s.state === 'needs_auth' && s.catalogId) { connectMcpApp({ id: s.catalogId, name: s.name, auth: 'oauth' }, {}, null, { here: true }); return; }
    test.disabled = true;
    test.textContent = '连接中…';
    try {
      const r = await api(`/api/mcp/${encodeURIComponent(s.id)}/test`, { method: 'POST' });
      const srv = r.server || {};
      toast(srv.state === 'ready' ? `「${s.name}」连上了，${srv.tools.length} 个工具` : `「${s.name}」没连上：${srv.error || srv.state}`, srv.state !== 'ready');
    } catch (err) { toast(`连接失败：${err.message}`, true); }
    await loadMcp();
  });
  del.addEventListener('click', async () => {
    if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '再点一次断开'; return; }
    try { await api(`/api/mcp/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); toast(`已断开「${s.name}」`); loadMcp(); } catch (err) { toast(`删除失败：${err.message}`, true); }
  });
  delAll?.addEventListener('click', async () => {
    if (!delAll.dataset.armed) { delAll.dataset.armed = '1'; delAll.textContent = '再点一次，所有机器都断开'; return; }
    delAll.disabled = true;
    try {
      const out = await api(`/api/mcp/${encodeURIComponent(s.id)}?everywhere=1`, { method: 'DELETE' });
      const failed = (out.peers || []).filter((p) => !p.ok);
      toast(failed.length ? `已在这台断开「${s.name}」；${failed.map((p) => `${p.machine}：${p.message}`).join('；')}` : `已在所有机器上断开「${s.name}」`, Boolean(failed.length));
    } catch (err) { toast(`删除失败：${err.message}`, true); }
    loadMcp();
  });
  return box;
}

/** A URL in the device's own browser: the app shells' native call, else a new tab. */
async function openSignInPage(url) {
  if (typeof window.desk?.openExternal === 'function') {
    try { if (await window.desk.openExternal(url)) return true; } catch { /* fall back */ }
  }
  try { window.open(url, '_blank', 'noopener'); } catch { /* a blocked pop-up: the row has the link */ }
  return true;
}

/** This computer's own hub (desktop app on another machine): apps send a sign-in back only to https or loopback. */
function mcpRelay() {
  const u = String(machineBridge?.localUrl || '');
  return !onLocalMachine() && /^http:\/\/127\.0\.0\.1:\d+$/.test(u) ? u : '';
}

/** After connecting on the other machines: open their sign-in pages, say what happened. */
async function reportMcpPeers(app, peers) {
  if (!Array.isArray(peers) || !peers.length) return;
  const signIns = peers.filter((p) => p.ok && p.authorizeUrl);
  for (const p of signIns) await openSignInPage(p.authorizeUrl);
  if (signIns.length) mcpUi.peerSignIns = signIns.map((p) => ({ app: app.id, machine: p.machine, url: p.authorizeUrl }));
  const done = peers.filter((p) => p.ok && !p.authorizeUrl).map((p) => p.machine);
  const failed = peers.filter((p) => !p.ok);
  const parts = [];
  if (done.length) parts.push(`已同步到 ${done.join('、')}`);
  if (signIns.length) parts.push(`${signIns.map((p) => p.machine).join('、')} 要各登录一次（已在浏览器打开）`);
  if (failed.length) parts.push(`${failed.map((p) => `${p.machine}：${p.message}`).join('；')}`);
  toast(`「${app.name}」${parts.join('；')}`, Boolean(failed.length));
}

/** 「同步到其他机器」 for an app connected here. */
async function syncMcpApp(app, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  try {
    const out = await api(`/api/mcp/catalog/${encodeURIComponent(app.id)}/sync`, { method: 'POST', body: { relay: mcpRelay() || (onLocalMachine() ? location.origin : '') } });
    if (!out.peers?.length) toast('没有其他机器（在「设置 → 机器」里添加）');
    else await reportMcpPeers(app, out.peers);
  } catch (err) { toast(`同步失败：${err.message}`, true); }
  if (btn) { btn.disabled = false; btn.textContent = '同步到其他机器'; }
  await loadMcp();
}

/** 「连接」 on a catalog app. Token / Feishu details come from the row's own inputs.
 *  It connects on every machine (the others too), unless `here` is set. */
async function connectMcpApp(app, extra = {}, btn = null, { here = false } = {}) {
  if (btn) { btn.disabled = true; btn.textContent = '连接中…'; }
  try {
    const out = await api(`/api/mcp/catalog/${encodeURIComponent(app.id)}/connect`, { method: 'POST', body: { origin: location.origin, relay: mcpRelay(), everywhere: !here, ...extra } });
    if (out.authorizeUrl) {
      // The app's own sign-in page, in this device's browser (the computer's
      // or the phone's); it comes back to this machine when done. This window
      // never goes there itself: the row keeps a link in case nothing opened.
      mcpUi.signIn = { app: app.id, url: out.authorizeUrl };
      await openSignInPage(out.authorizeUrl);
      toast(`在浏览器里登录「${app.name}」并点允许，完成后回到这里`);
    } else {
      toast(`正在连接「${app.name}」${app.auth !== 'oauth' && app.auth !== 'mail' ? '（第一次会下载它，稍等）' : ''}`);
    }
    mcpUi.open = app.id;
    // The other machines: after this one's own note, so it is the one you see.
    if (out.peers?.length) setTimeout(() => reportMcpPeers(app, out.peers), out.authorizeUrl ? 2500 : 0);
  } catch (err) {
    toast(`连接失败：${err.message}`, true);
  }
  await loadMcp();
}

/** The 邮箱 form: address, code, and (for mailboxes Lamplit does not know) servers. `go` adds it. */
function mailboxFields(box, app, go) {
  const field = (ph, type = 'text') => {
    const i = document.createElement('input');
    i.className = 'field';
    i.type = type;
    i.placeholder = ph;
    i.autocomplete = type === 'password' ? 'new-password' : 'off';
    return i;
  };
  const email = field('邮箱地址，比如 name@qq.com', 'email');
  const pass = field('授权码（不是登录密码）', 'password');
  box.append(email, pass);
  const more = document.createElement('details');
  more.className = 'mcp-more';
  more.appendChild(el('summary', '', '其他邮箱：填收发信服务器'));
  const imap = field('收信 IMAP，比如 imap.example.com:993');
  const smtp = field('发信 SMTP，比如 smtp.example.com:465');
  more.append(imap, smtp);
  box.appendChild(more);
  go.addEventListener('click', () => {
    if (!email.value.trim() || !pass.value.trim()) { toast('先填邮箱地址和授权码', true); return; }
    connectMcpApp(app, { fields: { EMAIL: email.value.trim(), PASS: pass.value.trim(), IMAP: imap.value.trim(), SMTP: smtp.value.trim() } }, go);
  });
}

/** 邮箱 once connected: its mailboxes (each can go), and room for one more. */
function mailboxList(s) {
  const wrap = el('div', 'mcp-mailboxes');
  wrap.appendChild(el('label', 'lbl', `已连接的邮箱（${(s.mailboxes || []).length} 个）`));
  (s.mailboxes || []).forEach((addr, i) => {
    const row = el('div', 'mcp-mailbox');
    row.appendChild(el('span', '', `${addr}${i === 0 ? '（默认）' : ''}`));
    const rm = el('button', 'btn tiny danger', '移除');
    rm.type = 'button';
    rm.addEventListener('click', async () => {
      if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = '再点一次移除'; return; }
      try {
        const out = await api('/api/mcp/mailbox/remove', { method: 'POST', body: { email: addr, everywhere: true } });
        const failed = (out.peers || []).filter((p) => !p.ok);
        toast(failed.length ? `已移除 ${addr}；${failed.map((p) => `${p.machine}：${p.message}`).join('；')}` : `已移除 ${addr}`, Boolean(failed.length));
      } catch (err) { toast(`移除失败：${err.message}`, true); }
      loadMcp();
    });
    row.appendChild(rm);
    wrap.appendChild(row);
  });
  const add = el('details', 'vault-add');
  add.appendChild(el('summary', '', '再加一个邮箱'));
  const app = (mcpUi.apps || []).find((a) => a.id === 'email') || { id: 'email', name: '邮箱', auth: 'mail' };
  const go = el('button', 'btn primary tiny', '添加');
  go.type = 'button';
  mailboxFields(add, app, go);
  const row = el('div', 'btn-row');
  row.appendChild(go);
  add.appendChild(row);
  wrap.appendChild(add);
  return wrap;
}

/** Under an app that is not connected yet: what 「连接」 needs. */
function mcpConnectForm(app) {
  const box = el('div', 'mcp-app-body');
  box.appendChild(el('div', 'row-note', app.help || ''));
  // What it can do to your files, said before 「连接」 (Blender, 1.5.54).
  if (app.warn) box.appendChild(el('div', 'row-note warn-note', app.warn));
  const go = el('button', 'btn primary tiny', '连接');
  go.type = 'button';
  if (app.auth === 'token') {
    if (app.tokenUrl) {
      const a = el('a', '', app.tokenLabel || '去建一个 token ↗');
      a.href = app.tokenUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      box.appendChild(a);
    }
    const tok = document.createElement('input');
    tok.className = 'field';
    tok.type = 'password';
    tok.autocomplete = 'new-password';
    tok.placeholder = '粘贴 token';
    box.appendChild(tok);
    go.addEventListener('click', () => {
      if (!tok.value.trim()) { toast('先把 token 贴进来', true); return; }
      connectMcpApp(app, { token: tok.value.trim() }, go, { here: app.local });
    });
  } else if (app.auth === 'fields') {
    // Several values (1.5.12): an id and a secret, a key and its region, an address and a token.
    if (app.tokenUrl) {
      const a = el('a', '', app.tokenLabel || '去拿 ↗');
      a.href = app.tokenUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      box.appendChild(a);
    }
    const inputs = (app.fields || []).map((f) => {
      let input;
      if (f.options) {
        input = document.createElement('select');
        input.className = 'field';
        for (const [value, label] of f.options) { const o = document.createElement('option'); o.value = value; o.textContent = label; input.appendChild(o); }
      } else {
        input = document.createElement('input');
        input.className = 'field';
        input.type = f.secret ? 'password' : 'text';
        input.autocomplete = f.secret ? 'new-password' : 'off';
        input.placeholder = f.placeholder || f.label;
      }
      input.setAttribute('aria-label', f.label);
      const label = el('label', 'mcp-field', f.label);
      label.appendChild(input);
      box.appendChild(label);
      return [f, input];
    });
    go.addEventListener('click', () => {
      const empty = inputs.filter(([f, input]) => !f.options && !input.value.trim()).map(([f]) => f.label);
      if (empty.length) { toast(`先填好：${empty.join('、')}`, true); return; }
      connectMcpApp(app, { fields: Object.fromEntries(inputs.map(([f, input]) => [f.key, input.value.trim()])) }, go, { here: app.local });
    });
  } else if (app.auth === 'mail') {
    mailboxFields(box, app, go);
  } else if (app.auth === 'feishu') {
    const id = document.createElement('input');
    id.className = 'field';
    id.placeholder = 'App ID（已在「设置 → 飞书」填过就留空）';
    id.autocomplete = 'off';
    const secret = document.createElement('input');
    secret.className = 'field';
    secret.type = 'password';
    secret.autocomplete = 'new-password';
    secret.placeholder = 'App Secret（同上）';
    box.append(id, secret);
    go.addEventListener('click', () => connectMcpApp(app, { appId: id.value.trim(), appSecret: secret.value.trim() }, go));
  } else {
    go.addEventListener('click', () => connectMcpApp(app, {}, go, { here: app.local }));
  }
  if (app.local) box.appendChild(el('div', 'row-note', '它连的是这台电脑上的程序，所以只在这台机器上连接，不会同步到别的机器。'));
  const row = el('div', 'btn-row');
  row.appendChild(go);
  box.appendChild(row);
  return box;
}

/*
 * 连接应用 (1.5.12): a grid of tiles - the app's mark, its name, one line on
 * what it does, connected or not - with the categories as chips above. A tile
 * opens in place across the whole row: how to connect, or what is connected.
 */
function mcpTile(app) {
  const srv = app.server;
  const card = el('div', `mcp-app${mcpUi.open === app.id ? ' open' : ''}${appIsOn(app) ? ' on' : ''}`);
  const head = el('button', 'mcp-app-head');
  head.type = 'button';
  // 1.5.62: each app's own icon again, as in 1.5.60 (step 5 had made them grey letter blocks, which nobody asked for).
  const badge = el('div', 'mcp-badge', app.badge || app.name.slice(0, 1));
  badge.style.background = app.color || '#5b6474';
  if (String(app.badge || '').length >= 3) badge.classList.add('small');
  // The app's own mark, white on its colour; the letters stay for apps without one.
  if (app.icon) {
    badge.textContent = '';
    badge.classList.add('has-icon');
    const mark = el('span', 'mcp-mark');
    // On the element itself: a url() inside a CSS variable would resolve against style.css's folder.
    mark.style.webkitMaskImage = `url("${app.icon}")`;
    mark.style.maskImage = `url("${app.icon}")`;
    badge.appendChild(mark);
  }
  const meta = el('div', 'mcp-app-meta');
  meta.appendChild(el('b', '', app.name));
  meta.appendChild(el('small', '', app.desc || ''));
  // Recommended: why, from the assistants you have.
  if (app.why) meta.appendChild(el('small', 'mcp-why', app.why));
  head.append(badge, meta);
  const xs = app.detail === 'x' ? xTileState(srv) : null;
  const status = xs
    ? el('span', `mcp-state ${xs.cls}`, xs.text)
    : srv
      ? el('span', `mcp-state ${srv.state === 'ready' ? 'ok' : srv.state === 'needs_auth' || srv.state === 'failed' ? 'warn' : ''}`, mcpStateLabel(srv))
      : el('span', 'mcp-state', app.local ? '连接 · 本机' : '连接');
  head.appendChild(status);
  card.appendChild(head);
  if (mcpUi.open === app.id) {
    // X (1.5.52): its two parts, posting and searching, in its own detail.
    const body = app.detail === 'x' ? renderXDetail(app) : srv ? mcpServerPanel(srv) : mcpConnectForm(app);
    // Waiting for a sign-in: a link to the page, for when the browser did not open.
    if (mcpUi.signIn?.app === app.id && srv?.state === 'needs_auth') {
      const link = el('a', '', '浏览器没打开？点这里去登录 ↗');
      link.href = mcpUi.signIn.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.addEventListener('click', (e) => { e.preventDefault(); openSignInPage(mcpUi.signIn.url); });
      body.prepend(link);
    }
    card.appendChild(body);
  }
  head.addEventListener('click', () => {
    // One click is enough when there is nothing to type: an OAuth sign-in.
    if (!srv && app.auth === 'oauth' && mcpUi.open !== app.id) { mcpUi.open = app.id; connectMcpApp(app, {}, null); return; }
    mcpUi.open = mcpUi.open === app.id ? '' : app.id;
    renderMcp();
  });
  return card;
}

/** Connected, the same rule for every tile (1.5.51); X counts when either of its parts is on (1.5.52). */
function appIsOn(a) {
  return a.detail === 'x' ? xConnectedCount() > 0 : mcpIsOn(a.server);
}

/** Search: one Latin letter finds apps by a word that starts with it (「x」 is X, not MiniMax). */
function appMatches(a, q) {
  if (!q) return true;
  if (/^[a-z]$/.test(q)) return new RegExp(`(^|[^a-z])${q}`).test(String(a.name || '').toLowerCase());
  return `${a.name} ${a.desc} ${a.category}`.toLowerCase().includes(q);
}

function renderMcp() {
  const list = $('mcp-catalog');
  if (!list) return;
  list.innerHTML = '';
  const q = String($('mcp-search')?.value || '').trim().toLowerCase();
  const custom = mcpUi.servers.filter((s) => !s.catalogId).map((s) => ({ id: `custom-${s.id}`, name: s.name, category: '自己添加的', badge: s.name.slice(0, 1).toUpperCase(), color: '#7a5af8', desc: s.transport !== 'stdio' ? hostOfUrl(s.url) : s.command, auth: 'custom', server: s }));
  const all = [...(mcpUi.apps || []), ...custom];
  const connected = all.filter(appIsOn);
  const cats = ['全部', ...(connected.length ? ['已连接'] : []), ...new Set(all.map((a) => a.category))];
  if (!cats.includes(mcpUi.cat)) mcpUi.cat = '全部';
  const chips = el('div', 'mcp-chips');
  for (const cat of cats) {
    const chip = el('button', `chip-btn${mcpUi.cat === cat ? ' on' : ''}`, cat === '已连接' ? `已连接 ${connected.length}` : cat);
    chip.type = 'button';
    chip.addEventListener('click', () => { mcpUi.cat = cat; renderMcp(); });
    chips.appendChild(chip);
  }
  list.appendChild(chips);
  const apps = all.filter((a) => (mcpUi.cat === '全部' || (mcpUi.cat === '已连接' ? appIsOn(a) : a.category === mcpUi.cat))
    && appMatches(a, q));
  if (!apps.length) { list.appendChild(el('div', 'row-note', q ? '没有找到。目录里没有的，可以在下面自己添加。' : '还没有接任何应用。')); return; }
  // Switched on first, then the ones switched off, then the rest.
  const rank = (a) => (appIsOn(a) ? 0 : a.server || (a.detail === 'x' && xUi.view?.configured) ? 1 : 2);
  apps.sort((x, y) => rank(x) - rank(y));
  // 为你推荐 (1.5.61): not a chart of popular apps - what the assistants you have would use, each with why.
  const recs = mcpUi.cat === '全部' && !q ? mcpRecommendations(apps) : [];
  if (recs.length) {
    const head = el('div', 'mcp-sec-head');
    head.appendChild(el('b', null, '为你推荐'));
    head.appendChild(el('small', null, '按你的助手挑的'));
    list.appendChild(head);
    const rec = el('div', 'mcp-grid mcp-rec');
    recs.forEach((r) => rec.appendChild(mcpTile({ ...r.app, why: r.why })));
    list.appendChild(rec);
    const all = el('div', 'mcp-sec-head');
    all.appendChild(el('b', null, '全部应用'));
    all.appendChild(el('small', null, `${apps.length - recs.length} 个`));
    list.appendChild(all);
  }
  const grid = el('div', 'mcp-grid');
  apps.filter((a) => !recs.some((r) => r.app.id === a.id)).forEach((app) => grid.appendChild(mcpTile(app)));
  list.appendChild(grid);
}

/**
 * 为你推荐: an app that a bot of yours plainly needs, from the words of its name and job
 * (「周报」 -> 飞书, 「求职」 -> 邮箱, 「剪辑」 -> 网盘); not connected yet; at most 4.
 */
const APP_HINTS = [
  ['feishu', /周报|日报|飞书|群聊|通知|同事/, (n) => `「${n}」可以直接发到飞书群`],
  ['email', /邮件|邮箱|求职|面试|简历|招聘|客户/, (n) => `「${n}」能自动看邮件、回邮件`],
  ['baidu-pan', /素材|网盘|剪辑|照片|备份/, (n) => `「${n}」的素材可以从网盘取`],
  ['x', /小红书|发布|运营|推特|帖子|社媒/, (n) => `「${n}」的内容也能发到 X`],
  ['github', /代码|开发|程序|仓库|编程/, (n) => `「${n}」能看仓库、提问题`],
  ['notion', /笔记|知识库|文档/, (n) => `「${n}」能读写你的笔记`],
  ['amap', /旅行|出行|路线|地图/, (n) => `「${n}」能查地点、算路线`],
  ['dingtalk', /钉钉|考勤/, (n) => `「${n}」能在钉钉里发消息`],
];
function mcpRecommendations(apps) {
  // This machine's bots only: an app connected here serves them, not those elsewhere (1.5.61 beginner test).
  const bots = (state.bots || []).filter((b) => !isRemoteId(b.id));
  const out = [];
  for (const [id, words, why] of APP_HINTS) {
    const app = apps.find((a) => a.id === id);
    if (!app || appIsOn(app)) continue;
    const bot = bots.find((b) => words.test(`${b.name || ''} ${b.role || ''}`));
    if (!bot) continue;
    out.push({ app, why: why(bot.name) });
    if (out.length >= 4) break;
  }
  return out;
}

function setupMcpForm() {
  if (!$('mcp-preset')) return;
  $('mcp-preset').addEventListener('change', (e) => applyMcpPreset(e.target.value));
  $('mcp-search')?.addEventListener('input', renderMcp);
  $('mcp-transport').addEventListener('change', syncMcpTransport);
  for (const id of ['mcp-args', 'mcp-env', 'mcp-url', 'mcp-headers']) $(id).addEventListener('input', renderMcpSecretInputs);
  $('mcp-save').addEventListener('click', saveMcp);
}

function hostOfUrl(u) {
  try { return new URL(u).hostname; } catch { return String(u || ''); }
}

async function saveNewVaultEntry() {
  const name = $('vault-new-name').value.trim();
  const values = {};
  if ($('vault-new-user').value) values['账号'] = $('vault-new-user').value;
  if ($('vault-new-pass').value) values['密码'] = $('vault-new-pass').value;
  if (!name || !Object.keys(values).length) { toast('填上名字和至少一项', true); return; }
  try {
    await api('/api/vault', { method: 'POST', body: { name, site: $('vault-new-site').value.trim(), values } });
    ['vault-new-name', 'vault-new-site', 'vault-new-user', 'vault-new-pass'].forEach((id) => { $(id).value = ''; });
    toast(`已存进保险箱：${name}`);
    loadVault();
  } catch (err) { toast(`保存失败：${err.message}`, true); }
}

/** The bot asked for a login: a form whose values go to the vault, never the chat. */
function loginCard(item) {
  const args = safeArgs(item.args) || {};
  const name = String(args.name || '这个网站');
  const fields = (Array.isArray(args.fields) && args.fields.length ? args.fields : ['账号', '密码']).map(String);
  const card = el('div', 'takeover-card login-card');
  card.appendChild(el('div', 'takeover-title', `登录「${name}」`));
  if (args.site) card.appendChild(el('div', 'row-note', hostOfUrl(args.site)));
  const done = () => {
    card.querySelectorAll('input, .btn-row').forEach((n) => n.remove());
    card.appendChild(el('div', 'login-saved', '✓ 已存进保险箱，机器人会用它登录'));
  };
  const inputs = fields.map((label) => {
    const input = document.createElement('input');
    input.className = 'field';
    input.placeholder = label;
    input.dataset.label = label;
    input.autocomplete = 'off';
    if (isSecretLabel(label)) { input.type = 'password'; input.autocomplete = 'new-password'; }
    card.appendChild(input);
    return input;
  });
  const row = el('div', 'btn-row');
  const save = el('button', 'btn primary', '保存并继续');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const values = {};
    for (const i of inputs) if (i.value) values[i.dataset.label] = i.value;
    if (!Object.keys(values).length) { toast('先填写', true); return; }
    save.disabled = true;
    try {
      await api('/api/vault', { method: 'POST', body: { name, site: args.site || '', values } });
      inputs.forEach((i) => { i.value = ''; });
      done();
      loadVault().catch(() => {});
      const input = $('composer');
      input.value = `已把「${name}」的登录信息存进保险箱，继续`;
      await send();
    } catch (err) {
      save.disabled = false;
      toast(`保存失败：${err.message}`, true);
    }
  });
  const self = el('button', 'btn', '我自己接管屏幕登录');
  self.type = 'button';
  self.addEventListener('click', () => popupTakeover());
  row.appendChild(save);
  row.appendChild(self);
  card.appendChild(row);
  card.appendChild(el('div', 'row-note', '填的内容加密存在这台机器上，不会出现在聊天里，也不会发给 AI 模型。'));
  // Already saved (after a reload, or saved in settings): show that instead of the form.
  const check = (entries) => { if ((entries || []).some((e) => e.name === name)) done(); };
  if (state.vault) check(state.vault); else loadVault().then(check).catch(() => {});
  return card;
}

/* --- activity log (Settings > 操作记录) -------------------------------------- */
let auditView = 'important';

function auditTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function auditLine(r) {
  const who = botById(r.botId)?.name || r.botName || r.botId || '';
  // Closed by Lamplit, not by you (1.5.33): a deleted bot's cards, a stopped turn's.
  const cancelled = r.by === 'system' && /^已取消/.test(String(r.note || ''));
  const what = (tool, args) => {
    const info = describeTool(tool, args);
    return info.detail ? `${info.label}：${truncate(info.detail, 60)}` : info.label;
  };
  const risk = { LOW: '低', MEDIUM: '中', HIGH: '高' }[r.risk] || '';
  switch (r.kind) {
    case 'tool.run':
      return { icon: '•', text: `${who} ${what(r.tool, r.args)}`, tag: r.decision === 'auto' ? '自动' : '已批准', risk, bad: r.ok === false };
    case 'approval.resolved':
      return { icon: r.status === 'approved' ? '✓' : '✕', text: `${who} 请求 ${what(r.toolName, r.args)}`, tag: cancelled ? '已取消' : { approved: '你批准了', denied: '你拒绝了', timeout: '没人处理，超时', dismissed: '已收起' }[r.status] || r.status, risk, bad: r.status !== 'approved' && !cancelled, note: cancelled ? r.note : reasonLabel(r.reason) };
    case 'tool.approval_denied':
      return { icon: '✕', text: `${who} ${what(r.tool, r.args)}`, tag: '被拒绝', risk, bad: true };
    case 'tool.denied':
      return { icon: '⛔', text: `${who} 想 ${what(r.tool, r.args)}`, tag: '被拦下', bad: true, note: reasonLabel(r.reason) };
    case 'feishu.changed':
      return { icon: '💬', text: r.enabled ? `飞书已启用（${r.appId}）` : '飞书已关闭', tag: '飞书' };
    case 'feishu.unpaired':
      return { icon: '💬', text: '飞书解除了一个配对', tag: '飞书' };
    case 'vault.saved':
      return { icon: '🔐', text: `保险箱存了「${r.name}」（${(r.fields || []).join('、')}）`, tag: '保险箱' };
    case 'vault.deleted':
      return { icon: '🔐', text: '保险箱删了一条', tag: '保险箱' };
    case 'desktop.takeover':
      return { icon: '🖥', text: who ? `接管了 ${who} 的桌面` : '接管了桌面', tag: r.mode === 'view' ? '只能看' : '能看能控', note: r.from ? `来自 ${r.from}` : '' };
    case 'balance.low':
      return { icon: '💰', text: String(r.text || '模型账户余额快用完了'), tag: '成本', bad: true };
    case 'usage.alert': {
      const symbol = r.currency === 'USD' ? '$' : '¥';
      return { icon: '💰', text: `今日估算 ${symbol}${(Number(r.cost) || 0).toFixed(2)} 超过提醒线 ${symbol}${(Number(r.limit) || 0).toFixed(2)}`, tag: '成本', bad: true };
    }
    case 'usage.settings':
      return { icon: '💰', text: `成本设置：${(r.models || []).length} 个模型单价${r.dailyAlert ? `，每日提醒 ${r.dailyAlert}` : ''}`, tag: '成本' };
    case 'policy.changed': {
      const c = r.change || {};
      const names = { careful: '谨慎', standard: '标准', auto: '放手' };
      const parts = [];
      if (c.level) parts.push(`审批级别改为「${names[c.level] || c.level}」`);
      if (c.takeover) parts.push(`接管桌面改为「${c.takeover === 'view' ? '只能看' : '能看能控'}」`);
      if (c.addRule) parts.push(`加了规则「${c.addRule.text}」（${c.addRule.action === 'allow' ? '直接做' : '先问我'}）`);
      if (c.removeRule) parts.push('删了一条规则');
      if (c.addDeny) parts.push(`禁止命令「${c.addDeny}」`);
      if (c.removeDeny) parts.push('删了一条禁止的命令');
      if (c.autoApproveAll !== undefined) parts.push(c.autoApproveAll ? '改为放手' : '改为标准');
      return { icon: '⚙', text: parts.join('；') || '改了权限设置', tag: '权限' };
    }
    case 'bot.abilities': {
      const label = (tools) => [...new Set((tools || []).map((t) => (ABILITIES.find((a) => a.tools.includes(t)) || {}).label || t))].join('、');
      const parts = [];
      if (r.added?.length) parts.push(`加上：${label(r.added)}`);
      if (r.removed?.length) parts.push(`去掉：${label(r.removed)}`);
      if (r.trusted !== undefined) parts.push(r.trusted ? '常规操作直接做' : '常规操作要先问');
      return { icon: '⚙', text: `${who} 的能力 ${parts.join('；')}`, tag: '能力' };
    }
    default:
      return null;
  }
}

async function loadAudit() {
  const list = $('audit-list');
  if (!list) return;
  list.innerHTML = '<div class="row-note">正在读取…</div>';
  let rows = [];
  try { rows = await api(`/api/audit?view=${auditView}&limit=200`); } catch (err) { list.innerHTML = ''; list.appendChild(el('div', 'row-note', `读不到记录：${err.message}`)); return; }
  list.innerHTML = '';
  const lines = (rows || []).map((r) => [r, auditLine(r)]).filter(([, l]) => l);
  if (!lines.length) { list.appendChild(el('div', 'row-note', '这里还没有记录。')); return; }
  for (const [r, l] of lines) {
    const row = el('div', `audit-row${l.bad ? ' bad' : ''}`);
    row.appendChild(el('span', 'audit-time', auditTime(r.ts)));
    row.appendChild(el('span', 'audit-icon', l.icon));
    const body = el('span', 'audit-text');
    body.appendChild(el('span', '', l.text));
    if (l.note) body.appendChild(el('small', '', l.note));
    row.appendChild(body);
    if (l.risk) row.appendChild(el('span', `audit-risk r-${r.risk}`, `${l.risk}风险`));
    if (l.tag) row.appendChild(el('span', 'audit-tag', l.tag));
    list.appendChild(row);
  }
}

async function loadPolicy() {
  const policy = await api('/api/policy');
  renderPolicy(policy);
}

function renderPolicy(policy) {
  state.policy = policy;
  const level = policy?.level || (policy?.autoApproveAll ? 'auto' : 'standard');
  document.querySelectorAll('input[name="approval-level"]').forEach((r) => { r.checked = r.value === level; });
  document.querySelectorAll('input[name="takeover-mode"]').forEach((r) => { r.checked = r.value === (policy?.takeover || 'control'); });
  document.querySelectorAll('input[name="generate-mode"]').forEach((r) => { r.checked = r.value === (policy?.generate || 'level'); });
  const box = $('auto-approve-all');
  if (box) box.checked = level === 'auto';
  if ($('policy-note')) {
    $('policy-note').textContent = policy?.mode === 'remote'
      ? '这是一台远程机器，默认「放手」：机器人在工作区里做事不用逐条问你；开放文件夹以外的位置和 sudo 仍然先问你。'
      : '这台电脑上，机器人做事前要不要先问你。每台机器单独设置。';
  }
  const rules = $('rule-list');
  if (rules) {
    rules.innerHTML = '';
    for (const rule of policy?.rules || []) {
      const row = el('div', 'rule-item');
      row.appendChild(el('span', `rule-badge ${rule.action}`, rule.action === 'allow' ? '直接做' : '先问我'));
      row.appendChild(el('span', 'rule-text', rule.text));
      const x = el('button', 'att-x', '移除');
      x.type = 'button';
      x.addEventListener('click', () => savePolicy({ removeRule: rule.id }, '已移除'));
      row.appendChild(x);
      rules.appendChild(row);
    }
    if (!(policy?.rules || []).length) rules.appendChild(el('div', 'row-note', '还没有规则。'));
  }
  renderFolders(policy);
  const list = $('deny-list');
  if (list) {
    list.innerHTML = '';
    for (const item of policy?.extraDeny || []) {
      const row = el('div', 'deny-item');
      row.appendChild(el('code', '', item.text));
      const x = el('button', 'att-x', '移除');
      x.type = 'button';
      x.addEventListener('click', () => savePolicy({ removeDeny: item.id }, '已移除'));
      row.appendChild(x);
      list.appendChild(row);
    }
  }
  renderPermOverview();
}

/* The workspace can live anywhere the human likes. The hub reads it at
   start, so a change restarts it (a few seconds); files already in the old
   folder stay there. */
async function changeWorkspace(current, platform) {
  let info = null;
  try { info = await api('/api/workspace'); } catch { toast('这台机器的 Lamplit 版本太旧，还不能换工作区', true); return; }
  const hint = platform === 'win32' ? '比如 D:\\Lamplit 工作区' : '比如 /home/me/workspace';
  const answer = await askText({
    title: '更改工作区位置',
    text: `填一个文件夹的完整路径（${hint}）。所有机器人都能在这里读写，别选放着重要资料的文件夹；原来工作区里的文件不会自动搬过去；换完 Lamplit 会重启几秒钟。留空 = 回到默认位置（${info.defaultPath}）。`,
    value: current,
    placeholder: hint,
    confirmLabel: '更改并重启',
  });
  if (answer === null) return;
  const next = answer.trim();
  if (next === current) return;
  try {
    const r = await api('/api/workspace', { method: 'PUT', body: { path: next } });
    if (!r.restarting) { toast('工作区没有变化'); return; }
    toast(`工作区改到 ${r.path}，Lamplit 正在重启…`);
    setTimeout(() => location.reload(), 6000);
  } catch (err) {
    toast(`换工作区失败：${err.message}`, true);
  }
}

function renderFolders(policy) {
  const box = $('folder-list');
  if (!box) return;
  box.innerHTML = '';
  const row = (title, sub, actions = []) => {
    const r = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const t = el('div', 'vault-title');
    t.appendChild(el('b', '', title));
    t.appendChild(el('small', '', sub));
    head.appendChild(t);
    actions.forEach((a) => head.appendChild(a));
    r.appendChild(head);
    box.appendChild(r);
  };
  const move = el('button', 'btn tiny', '更改位置');
  move.type = 'button';
  move.addEventListener('click', () => changeWorkspace(policy?.workspace || '', policy?.platform).catch(() => {}));
  row('工作区', `${policy?.workspace || ''} · 读写 · 所有机器人共用，生成的文件都放在这里`, [move]);
  for (const f of policy?.folders || []) {
    const mode = el('button', 'btn tiny', f.write ? '改成只读' : '允许写入');
    mode.type = 'button';
    mode.addEventListener('click', () => savePolicy({ folderWrite: { id: f.id, write: !f.write } }, '已保存'));
    const del = el('button', 'btn tiny danger', '移除');
    del.type = 'button';
    del.addEventListener('click', () => savePolicy({ removeFolder: f.id }, '已移除'));
    row(f.path.split(/[\\/]/).filter(Boolean).pop() || f.path, `${f.path} · ${f.write ? '读写' : '只读'}`, [mode, del]);
  }
  if ($('folder-input') && !$('folder-input').placeholder.includes('：')) {
    $('folder-input').placeholder = policy?.platform === 'win32' ? '这台机器上的完整路径，比如：D:/资料' : '这台机器上的完整路径，比如：/home/me/docs';
  }
  if ($('folder-outside')) $('folder-outside').value = policy?.outside || 'ask';
  if ($('sudo-mode')) $('sudo-mode').value = policy?.sudo || 'ask';
  // Windows has no sudo: said as 管理员权限 (1.5.54, walkthrough 6.4).
  const win = state.computer?.host?.platform === 'win32';
  if ($('sudo-head')) $('sudo-head').textContent = win ? '管理员权限' : '管理员权限（sudo）';
  if ($('sudo-note')) $('sudo-note').textContent = win ? '以管理员身份运行之类的命令，默认每次都先问你。' : '用 sudo、以管理员身份运行之类的命令，默认每次都先问你。';
  if ($('trust-primary')) $('trust-primary').checked = Boolean(policy?.trustPrimary);
  if ($('read-guard')) $('read-guard').checked = policy?.readGuard === true; // off unless turned on (1.5.67)
  renderSandboxState(policy?.sandbox);
}

async function savePolicy(next, okText = '') {
  try {
    const saved = await api('/api/policy', { method: 'PUT', body: next });
    renderPolicy(saved);
    const names = { careful: '谨慎', standard: '标准', auto: '放手' };
    toast(okText || (next.level ? `已改为「${names[saved.level] || saved.level}」` : '已保存'));
    return saved;
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
    loadPolicy().catch(() => {});
    return null;
  }
}

/* One page: what each bot may do, what the machine's approval boundary is.
   The strict preset tightens the boundary only — it never strips a bot's
   tools, which would silently break work the human already delegated. */
const PERM_CAPS = [
  { label: '执行命令', tools: ['shell'], risk: 'shell' },
  { label: '写文件', tools: ['fs_write', 'fs_mkdir'], risk: 'medium' },
  { label: '删文件', tools: ['fs_delete'], risk: 'high' },
  { label: '发消息', tools: ['bot_message', 'group_post'], risk: 'medium' },
  { label: '发文件', tools: ['file_send'], risk: 'medium' },
  { label: '生成媒体', tools: ['image_generate', 'video_generate'], risk: 'media' },
  { label: '切机器', tools: ['machine_switch'], risk: 'medium' },
  { label: '浏览器', tools: ['browser_open', 'browser_click', 'browser_type'], risk: 'medium' },
  { label: '桌面程序', tools: ['desktop_ui'], risk: 'medium' },
  { label: '手机', tools: ['phone'], risk: 'medium' },
];
const PERM_LEVEL = { careful: '谨慎', standard: '标准', auto: '放手' };

/** What a granted capability actually does under this machine level. Mirrors
 *  src/approvals.mjs: careful asks for everything, standard asks above LOW
 *  unless the bot is trusted, auto runs it; generation has its own switch. */
function permDecision(cap, bot, policy) {
  const level = policy.level || (policy.autoApproveAll ? 'auto' : 'standard');
  if (cap.risk === 'media') {
    const mode = policy.generate || 'level';
    if (mode === 'ask') return 'ask';
    if (mode === 'auto') return 'auto';
    return level === 'auto' ? 'auto' : 'ask';
  }
  if (level === 'careful') return 'ask';
  if (level === 'auto') return 'auto';
  if (cap.risk === 'high') return 'ask';
  // Mirrors mediumRunsUnasked in src/approvals.mjs: at 标准 a trusted bot's
  // commands that only look run unasked; ones that may change things ask.
  if (cap.risk === 'shell') return bot.policy?.autoApproveMedium ? 'look' : 'ask';
  return bot.policy?.autoApproveMedium ? 'auto' : 'ask';
}

function renderPermOverview() {
  const summary = $('perm-summary');
  const table = $('perm-table');
  if (!summary || !table || !state.policy) return;
  const policy = state.policy;
  const level = policy.level || (policy.autoApproveAll ? 'auto' : 'standard');
  const chips = [
    ['审批级别', PERM_LEVEL[level] || level, level === 'auto'],
    ['接管桌面', policy.takeover === 'view' ? '只能看' : '能看能控', false],
    ['生成媒体', { level: '跟随级别', ask: '每次先问', auto: '直接生成' }[policy.generate] || '跟随级别', policy.generate === 'auto'],
    // 其他位置 and sudo are set in 边界, said there (1.5.54, walkthrough 6.4).
    ...(policy.trustPrimary ? [['主助理', '完全信任', true]] : []),
    ...(policy.readGuard === false ? [['读过网页后', '不再先问', true]] : []),
    ['我的规则', `${(policy.rules || []).length} 条`, false],
    ['禁止命令', `${(policy.extraDeny || []).length} 条自定义`, false],
  ];
  renderRememberedAll(); // 「以后都允许的」, further down the same page (1.5.62)
  summary.innerHTML = '';
  for (const [key, value, warn] of chips) {
    const chip = el('span', `perm-chip${warn ? ' warn' : ''}`);
    chip.appendChild(el('span', '', key));
    chip.appendChild(el('b', '', value));
    summary.appendChild(chip);
  }
  const bots = Array.isArray(state.bots) ? state.bots : [];
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  head.innerHTML = '';
  const headRow = document.createElement('tr');
  headRow.appendChild(el('th', '', '机器人'));
  for (const cap of PERM_CAPS) headRow.appendChild(el('th', '', cap.label));
  head.appendChild(headRow);
  body.innerHTML = '';
  for (const bot of bots) {
    const row = document.createElement('tr');
    row.appendChild(el('td', '', bot.name || bot.id));
    const tools = new Set(Array.isArray(bot.tools) ? bot.tools : []);
    for (const cap of PERM_CAPS) {
      const granted = cap.tools.some((name) => tools.has(name));
      if (!granted) { row.appendChild(el('td', 'off', '—')); continue; }
      const decision = permDecision(cap, bot, policy);
      const cell = el('td', decision === 'auto' ? 'on' : 'ask', decision === 'auto' ? '✓' : decision === 'look' ? '只看不问' : '问');
      if (decision === 'look') cell.title = '列出、查看类命令直接做；会改东西的命令先问你';
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  if (!bots.length) {
    const row = document.createElement('tr');
    const cell = el('td', 'row-note', '还没有机器人');
    cell.colSpan = PERM_CAPS.length + 1;
    row.appendChild(cell);
    body.appendChild(row);
  }
  const strictEnough = level === 'careful' && policy.generate === 'ask' &&
    policy.outside === 'deny' && policy.sudo === 'ask' && policy.takeover === 'view' && !policy.trustPrimary;
  const note = $('perm-strict-note');
  if (note) note.hidden = strictEnough;
  const button = $('perm-strict');
  if (button) button.disabled = strictEnough;
}

/** 设置 → 边界 → 命令隔离 (1.5.3): are the bots' commands in a sandbox here? */
function renderSandboxState(s) {
  const box = $('sandbox-state');
  if (!box) return;
  const state = s?.state || 'na';
  box.classList.toggle('warn-note', state === 'off');
  const setup = $('runner-setup');
  if (setup) setup.hidden = !(s?.mode === 'windows' && (state === 'setup' || state === 'off'));
  if (s?.mode === 'windows') {
    clearTimeout(renderSandboxState.poll);
    box.classList.toggle('warn-note', state === 'off' || state === 'setup' || state === 'blocked');
    if (state === 'on') box.textContent = '已开启：机器人执行的命令用单独的 Windows 账户 lamplit-runner 来跑，看不到你的用户文件夹（C:\\Users\\你），包括 Lamplit 自己的数据（密钥、配对凭据、保险箱）；工作区和开放的文件夹照常可用，Python、ffmpeg 这类装在你用户文件夹里的工具可以运行。其他磁盘（比如 D 盘）按 Windows 默认，所有账户都能读写。命令跑在它自己的隐藏桌面上，看不到你的窗口、剪贴板和键盘；它打开的程序也不会出现在你的屏幕上。以管理员身份运行的命令、你批准越过边界的那一步，用你自己的账户。';
    else if (state === 'blocked') box.textContent = `机器人的命令现在都不会运行：${s.reason || '给机器人单独开的桌面建不起来'}。不会改用你的账户或你的桌面去跑。重启电脑通常就好了。`;
    else if (state === 'setting-up') { box.textContent = '正在设置：在弹出的管理员确认里点「是」…'; renderSandboxState.poll = setTimeout(() => loadPolicy().catch(() => {}), 2500); }
    else if (state === 'unknown') { box.textContent = '正在检查单独账户…'; renderSandboxState.poll = setTimeout(() => loadPolicy().catch(() => {}), 3000); }
    else if (state === 'setup') box.textContent = `机器人跑命令时用的是你的账户。点「设置单独账户」，让它用一个单独的账户（lamplit-runner），更安全；会弹一次管理员确认。${s.reason ? `上次没成功：${s.reason}。` : ''}`;
    else box.textContent = `没有生效：${s.reason || '原因不明'}。命令照常用你自己的账户运行。可以再点一次「设置单独账户」。`;
    return;
  }
  if (state === 'na') box.textContent = '这台机器上机器人执行的命令没有隔离。';
  else if (state === 'unknown') box.textContent = '正在检查这台机器能不能用沙箱…';
  else if (state === 'off') box.textContent = `没有生效：${s.reason || '原因不明'}。命令照常运行，但看得到 Lamplit 自己的数据。`;
  else if (s.mode === 'open') box.textContent = '已开启：机器人执行的命令在沙箱里跑，看不到 Lamplit 自己的数据（密钥、配对凭据、保险箱）。这台机器交给了机器人（放手），其他位置照常可用。用 sudo 的命令不在沙箱里。';
  // 1.5.63: with a network of its own the sandbox reaches the internet, not this machine's local-only ports.
  else if (s.net?.state === 'own') box.textContent = '已开启：机器人执行的命令在沙箱里跑，看不到 Lamplit 自己的数据（密钥、配对凭据、保险箱）；系统只读，个人文件夹里只看得到工作区和开放的文件夹。每个机器人有自己的 /tmp，看不到你的 /tmp、你的屏幕和登录会话；它启动的图形程序只会开在它自己的屏幕上，这台机器没给它开屏幕时就打不开图形窗口。沙箱有自己的网络：能上网，但连不到这台机器上只对本机开放的端口（比如本机的数据库、开发服务器）。用 sudo 的命令、你批准越过边界的那一步不在沙箱里。';
  else box.textContent = '已开启：机器人执行的命令在沙箱里跑，看不到 Lamplit 自己的数据（密钥、配对凭据、保险箱）；系统只读，个人文件夹里只看得到工作区和开放的文件夹。每个机器人有自己的 /tmp，看不到你的 /tmp、你的屏幕和登录会话；它启动的图形程序只会开在它自己的屏幕上，这台机器没给它开屏幕时就打不开图形窗口。用 sudo 的命令、你批准越过边界的那一步不在沙箱里。';
}

async function applyStrictPermissions() {
  const ok = await askConfirm({
    title: '收紧这台机器？',
    text: '审批级别改为「谨慎」，生成图片/视频每次先问，其他位置一律不许，sudo 先问，接管桌面改为「只能看」。机器人的工具授权不变；这些改动会写进审计。',
    confirmLabel: '一键最严',
  });
  if (!ok) return;
  await savePolicy(
    { level: 'careful', generate: 'ask', outside: 'deny', sudo: 'ask', takeover: 'view', trustPrimary: false },
    '已收紧：谨慎 · 生成先问 · 其他位置不许 · sudo 先问 · 接管只看',
  );
}

/* --- cost (Settings > 成本) -------------------------------------------------- */
function fmtTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function moneyText(cost, currency) {
  const symbol = currency === 'USD' ? '$' : '¥';
  const value = Number(cost) || 0;
  return `${symbol}${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function usageRangeLabel(days) {
  return days === 1 ? '今天' : days === 7 ? '近 7 天' : `近 ${days} 天`;
}

async function loadUsage(days = state.usageDays || 7) {
  state.usageDays = Math.min(Math.max(Number(days) || 7, 1), 365);
  let own;
  try {
    own = await api(`/api/usage?days=${state.usageDays}`);
  } catch {
    return; /* older server: the section simply stays empty */
  }
  // Every machine's cost in one view (1.5.10): this one plus the others,
  // added up; prices stay each machine's own.
  let peers = { machines: [], missing: [] };
  if (state.usageScope !== 'here') peers = await api(`/api/peers/usage?days=${state.usageDays}`).catch(() => peers);
  renderUsage(mergeUsage(own, peers));
}

/** This machine's usage plus the other machines' -> the same shape, with byMachine. */
function mergeUsage(own, peers = { machines: [] }) {
  const others = (peers.machines || []).filter((m) => m.totals);
  const sumRows = (rows) => {
    const out = { tokens: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, reasoningOf: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 };
    for (const r of rows) for (const k of Object.keys(out)) out[k] += Number(r?.[k]) || 0;
    out.cost = Math.round(out.cost * 10000) / 10000;
    return out;
  };
  const byKey = (lists) => {
    const map = new Map();
    for (const row of lists.flat()) map.set(row.key, sumRows([map.get(row.key) || {}, row]));
    return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.tokens - a.tokens);
  };
  const here = typeof machineDisplayName === 'function' ? machineDisplayName() : '本机';
  return {
    ...own,
    scope: others.length ? 'all' : 'here',
    missing: peers.missing || [],
    totals: sumRows([own.totals, ...others.map((m) => m.totals)]),
    byModel: byKey([own.byModel || [], ...others.map((m) => m.byModel || [])]),
    byBot: [...(own.byBot || []), ...others.flatMap((m) => (m.byBot || []).map((b) => ({ ...b, machine: m.machine })))].sort((a, b) => b.tokens - a.tokens),
    byRoutine: [...(own.byRoutine || []), ...others.flatMap((m) => (m.byRoutine || []).map((b) => ({ ...b, machine: m.machine })))].sort((a, b) => b.cost - a.cost),
    byMachine: others.length ? [{ key: here, ...sumRows([own.totals]) }, ...others.map((m) => ({ key: m.machine, ...sumRows([m.totals]) }))] : [],
    // 1.5.50: the kinds of call, evaluation apart, and the recent pace of every machine together.
    bySource: byKey([own.bySource || [], ...others.map((m) => m.bySource || [])]),
    eval: sumRows([own.eval, ...others.map((m) => m.eval)]),
    spendRate: { perDay: Math.round(((Number(own.spendRate?.perDay) || 0) + others.reduce((s, m) => s + (Number(m.spendRate?.perDay) || 0), 0)) * 100) / 100 },
    otherCurrencies: [...new Set(others.map((m) => m.currency).filter((c) => c && c !== own.currency))],
  };
}

function usageCostText(row, currency) {
  if (!row || !row.tokens) return '—';
  if (row.cost > 0) {
    return row.unpricedTokens
      ? `${moneyText(row.cost, currency)} + ${fmtTokens(row.unpricedTokens)} 未设单价`
      : moneyText(row.cost, currency);
  }
  return '未设单价';
}

function renderUsageTable(table, rows, currency, nameOf, emptyText) {
  if (!table) return;
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  head.innerHTML = '';
  const headRow = document.createElement('tr');
  ['名称', 'tokens', '估算'].forEach((label) => headRow.appendChild(el('th', '', label)));
  head.appendChild(headRow);
  body.innerHTML = '';
  for (const row of rows || []) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', '', nameOf(row)));
    const tokens = row.tokens
      ? `${fmtTokens(row.tokens)}${row.callsWithoutUsage ? ` · ${row.callsWithoutUsage} 次无用量` : ''}`
      : (row.callsWithoutUsage ? `${row.callsWithoutUsage} 次无用量` : '0');
    tr.appendChild(el('td', '', tokens));
    const cost = usageCostText(row, currency);
    tr.appendChild(el('td', cost === '未设单价' ? 'ask' : '', cost));
    body.appendChild(tr);
  }
  if (!(rows || []).length) {
    const tr = document.createElement('tr');
    const cell = el('td', 'row-note', emptyText);
    cell.colSpan = 3;
    tr.appendChild(cell);
    body.appendChild(tr);
  }
}

/** The kinds of model call, by name (1.5.50). */
const USAGE_SOURCE_NAMES = {
  chat: '聊天', routine: '定时任务', bot: '同事转交', group: '群聊', task: '自动接着做', feishu: '飞书', aside: '干活时插话',
  vision: '看图', rule: '规则判断', translate: '翻译', check: '连通测试',
};

function renderUsage(data) {
  state.usage = data;
  const days = data.days || state.usageDays || 7;
  const currency = data.currency || 'CNY';
  const settings = data.settings || { prices: {}, dailyAlert: 0 };
  const totals = data.totals || {};
  const summary = $('usage-summary');
  if (!summary) return;
  const label = usageRangeLabel(days);
  // One line of money first (1.5.54, walkthrough 6.2): what a newcomer wants to know.
  const headline = $('usage-headline');
  if (headline) {
    const spent = totals.cost > 0 ? moneyText(totals.cost, currency) : '';
    const perDay = data.spendRate?.perDay > 0 ? data.spendRate.perDay : totals.cost > 0 && days >= 7 ? totals.cost / days : 0;
    // The month says the daily pace it comes from (the recent days with use, not the range).
    const month = perDay ? `照最近每天约 ${moneyText(perDay, currency)}，一个月约 ${moneyText(perDay * 30, currency)}` : '';
    headline.textContent = !totals.tokens ? `${label}还没用过模型。`
      : spent ? `${label}大约花了 ${spent}${totals.unpricedTokens ? '（有的模型还没设价格，没算进来）' : ''}${month ? `；${month}` : ''}。`
        : `${label}用了 ${totals.calls || 0} 次模型。这家的价格 Lamplit 还不知道：去服务商的价格页，把每百万 tokens 的价格填到下面「模型单价」里，这里就能算出花了多少钱。`;
  }
  const chips = [
    [`${label} tokens`, fmtTokens(totals.tokens), false],
    [`${label}估算`, usageCostText({ tokens: totals.tokens, cost: totals.cost, unpricedTokens: totals.unpricedTokens }, currency), Boolean(totals.unpricedTokens && !totals.cost)],
    ['未设单价 tokens', fmtTokens(totals.unpricedTokens), Boolean(totals.unpricedTokens)],
    ['调用', `${totals.calls || 0} 次${totals.callsWithoutUsage ? ` · ${totals.callsWithoutUsage} 次无用量` : ''}`, false],
    ['缓存命中', totals.prompt && totals.cached ? `${Math.round((totals.cached / totals.prompt) * 100)}% 的输入` : '还没有记录', false],
    // 1.5.50: the pace the checkup's 「还能用几天」 uses; evaluation is not in it.
    ['最近每天约', data.spendRate?.perDay > 0 ? `${moneyText(data.spendRate.perDay, currency)}（不含评测）` : '还算不出来', false],
  ];
  // S5: the share of the output spent thinking, of the calls that say so (older ones did not).
  if (totals.reasoningOf > 0) {
    const share = totals.reasoning / totals.reasoningOf;
    chips.push(['其中思考', share > 0 && share < 0.01 ? '不到 1% 的输出' : `${Math.round(share * 100)}% 的输出`, false]);
  }
  // B2: evaluation runs, apart.
  if (data.eval?.calls) chips.push(['评测', `${usageCostText(data.eval, currency)}（不算进每天的花费）`, false]);
  chips.push(
    ['每日提醒', settings.dailyAlert ? moneyText(settings.dailyAlert, currency) : '关闭', false],
    ['每个助手每日预算', settings.botDailyBudget ? moneyText(settings.botDailyBudget, currency) : '不限', false],
  );
  if (data.alert) chips.push(['今日已超提醒线', moneyText(data.alert.cost, currency), true]);
  summary.innerHTML = '';
  for (const [key, value, warn] of chips) {
    const chip = el('span', `perm-chip${warn ? ' warn' : ''}`);
    chip.appendChild(el('span', '', key));
    chip.appendChild(el('b', '', value));
    summary.appendChild(chip);
  }

  const machineWrap = $('usage-machines-wrap');
  if (machineWrap) machineWrap.hidden = !(data.byMachine || []).length;
  renderUsageTable($('usage-machines'), data.byMachine, currency, (row) => row.key, '');
  const note = $('usage-scope-note');
  if (note) {
    note.hidden = !(data.missing?.length || data.otherCurrencies?.length);
    note.textContent = [data.missing?.length ? `没连上的机器没算进来：${data.missing.join('、')}` : '', data.otherCurrencies?.length ? '有的机器单价用的是另一种货币，合计只是粗略相加' : ''].filter(Boolean).join('；');
  }
  // By name (1.5.29); assistants that are gone and nameless fold into one row, evaluation runs into another.
  // Lamplit's own calls (testing the model, the checkup, translating) by what they are (1.5.54).
  const nameOfBot = (row) => (row.key === '_app' ? 'Lamplit 自己（测试连接、体检、翻译）' : (row.machine ? state.peerBots?.[row.machine]?.[row.key] : botById(row.key)?.name) || row.name || '');
  const isEval = (row) => Boolean(row.eval) || /^评测-/.test(nameOfBot(row)) || /^[a-z]\d{1,2}-[a-z0-9-]+$/.test(row.key);
  const folded = new Map();
  const botRows = [];
  for (const row of data.byBot || []) {
    const kind = isEval(row) ? 'eval' : (nameOfBot(row) ? '' : 'gone');
    if (!kind) { botRows.push(row); continue; }
    const key = `${kind}|${row.machine || ''}`;
    const sum = folded.get(key) || { key, kind, machine: row.machine, count: 0, tokens: 0, prompt: 0, completion: 0, cached: 0, cost: 0, calls: 0, unpricedTokens: 0, callsWithoutUsage: 0 };
    for (const k of ['tokens', 'prompt', 'completion', 'cached', 'cost', 'calls', 'unpricedTokens', 'callsWithoutUsage']) sum[k] += Number(row[k]) || 0;
    sum.count += 1;
    folded.set(key, sum);
  }
  botRows.push(...folded.values());
  botRows.sort((a, b) => b.tokens - a.tokens);
  renderUsageTable(
    $('usage-bots'),
    botRows,
    currency,
    (row) => {
      const name = row.kind === 'eval' ? `评测（${row.count} 项）` : row.kind === 'gone' ? `已删除的助手（${row.count} 个）` : nameOfBot(row);
      return row.machine ? `${name || '—'} · ${row.machine}` : (name || '—');
    },
    '还没有用量。接上真实模型聊几句，这里就会出现。',
  );
  if ((data.byBot || []).some((r) => r.machine) && !state.peerBots) {
    state.peerBots = {};
    api('/api/peers/bots').then((r) => {
      for (const m of r.machines || []) state.peerBots[m.machine] = Object.fromEntries((m.bots || []).map((b) => [b.id, b.name]));
      renderUsage(state.usage);
    }).catch(() => {});
  }
  renderUsageTable($('usage-models'), data.byModel, currency, (row) => row.key || '—', '还没有用量。');
  // What kind of call (1.5.50): chats, routines … and the small ones that were not counted before (看图, 规则判断, 翻译, 连通测试).
  const sourceWrap = $('usage-sources-wrap');
  if (sourceWrap) sourceWrap.hidden = !(data.bySource || []).length;
  renderUsageTable($('usage-sources'), data.bySource, currency, (row) => USAGE_SOURCE_NAMES[row.key] || row.key || '—', '');
  // What each scheduled task cost (1.5.28): a task that runs every hour adds up.
  const routineWrap = $('usage-routines-wrap');
  if (routineWrap) routineWrap.hidden = !(data.byRoutine || []).length;
  if ((data.byRoutine || []).length && !state.routines && !state.usageRoutinesAsked) {
    state.usageRoutinesAsked = true;
    api('/api/routines').then((r) => { state.routines = r; renderUsage(state.usage); }).catch(() => {});
  }
  renderUsageTable($('usage-routines'), data.byRoutine, currency, (row) => {
    const name = (state.routines || []).find((r) => r.id === row.key)?.name || (typeof humanizeIds === 'function' ? humanizeIds(row.key) : row.key);
    return row.machine ? `${name} · ${row.machine}` : name;
  }, '');

  const priceBox = $('usage-prices');
  if (priceBox) {
    priceBox.innerHTML = '';
    const priced = new Set(Object.keys(settings.prices || {}));
    const addRow = (name, price, missing = false, removable = true) => {
      const row = el('div', 'usage-price-row');
      const nameInput = el('input', 'field name-input');
      nameInput.value = name;
      nameInput.placeholder = '模型名';
      const inInput = el('input', 'field in-input');
      inInput.placeholder = '输入价';
      inInput.inputMode = 'decimal';
      inInput.value = price ? String(price.in) : '';
      const outInput = el('input', 'field out-input');
      outInput.placeholder = '输出价';
      outInput.inputMode = 'decimal';
      outInput.value = price ? String(price.out) : '';
      const cachedInput = el('input', 'field cached-input');
      cachedInput.placeholder = '缓存命中价';
      cachedInput.title = '命中缓存的输入的单价；不填按输入价算';
      cachedInput.inputMode = 'decimal';
      cachedInput.value = price && price.cached != null ? String(price.cached) : '';
      // Peak prices (1.5.29): what is typed is the peak price, the rest of the time half.
      const peakLabel = el('label', 'usage-peak');
      const peakBox = el('input', 'peak-input');
      peakBox.type = 'checkbox';
      peakBox.checked = Boolean(price?.peak);
      peakLabel.title = '填的是高峰价：北京时间工作日 9–12、14–18 按这个算，其余时间按一半算（DeepSeek 的规则）';
      peakLabel.append(peakBox, document.createTextNode(' 峰谷价'));
      row.appendChild(nameInput);
      row.appendChild(inInput);
      row.appendChild(cachedInput);
      row.appendChild(outInput);
      row.appendChild(peakLabel);
      // The site's prices for a model Lamplit knows: one click fills them (saved only with 保存).
      const known = (data.suggested || {})[name];
      if (known && !(price && price.in === known.in && price.out === known.out && price.cached === known.cached && Boolean(price.peak) === Boolean(known.peak))) {
        const fill = el('button', 'btn tiny', '填官网价');
        fill.type = 'button';
        fill.title = `输入 ${known.in}、缓存命中 ${known.cached}、输出 ${known.out}（每百万 tokens，高峰价；空闲时段半价）`;
        fill.addEventListener('click', () => {
          inInput.value = String(known.in);
          cachedInput.value = String(known.cached);
          outInput.value = String(known.out);
          peakBox.checked = Boolean(known.peak);
          toast('已填好，点下面的「保存」生效');
        });
        row.appendChild(fill);
      }
      if (missing) row.appendChild(el('span', 'tag', '未设单价'));
      if (removable) {
        const del = el('button', 'att-x', '✕');
        del.type = 'button';
        del.addEventListener('click', () => row.remove());
        row.appendChild(del);
      }
      priceBox.appendChild(row);
    };
    for (const [name, price] of Object.entries(settings.prices || {})) addRow(name, price);
    for (const model of data.byModel || []) {
      if (!priced.has(model.key) && model.tokens) addRow(model.key === '(未知)' ? '' : model.key, null, true);
    }
    addRow('', null, false, false);
  }
  if ($('usage-currency')) $('usage-currency').value = currency;
  if ($('usage-alert')) $('usage-alert').value = settings.dailyAlert || '';
  if ($('usage-budget')) $('usage-budget').value = settings.botDailyBudget || '';
  if ($('usage-range')) {
    $('usage-range').querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('on', Number(btn.dataset.days) === days);
    });
  }
}

async function saveUsageForm() {
  const prices = {};
  const noPeak = [];
  document.querySelectorAll('#usage-prices .usage-price-row').forEach((row) => {
    const name = row.querySelector('.name-input')?.value.trim();
    const inRaw = row.querySelector('.in-input')?.value.trim();
    const outRaw = row.querySelector('.out-input')?.value.trim();
    const cachedRaw = row.querySelector('.cached-input')?.value.trim();
    // An untouched row (name only, no numbers) is not a price: saving it as
    // 0/0 would silently turn "no price" into "free".
    if (!name || (!inRaw && !outRaw)) return;
    // peak: false is said too (1.5.50): an unticked box stays unticked, not filled in again from the site's price.
    const peak = Boolean(row.querySelector('.peak-input')?.checked);
    prices[name] = { in: Number(inRaw) || 0, out: Number(outRaw) || 0, ...(cachedRaw ? { cached: Number(cachedRaw) || 0 } : {}), peak };
    if (!peak && state.usage?.suggested?.[name]?.peak) noPeak.push(name);
  });
  const dailyAlert = Number($('usage-alert')?.value) || 0;
  const botDailyBudget = Number($('usage-budget')?.value) || 0;
  try {
    await api('/api/usage', {
      method: 'PUT',
      body: { currency: $('usage-currency')?.value || 'CNY', prices, dailyAlert, botDailyBudget },
    });
    toast(noPeak.length ? `成本设置已保存。${noPeak.join('、')} 没勾峰谷价：闲时本来是半价，现在也按全价估算` : '成本设置已保存');
    loadUsage();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

function setStatus(kind, text) {  const node = $('set-status');
  node.hidden = false;
  node.className = `set-status ${kind}`;
  node.textContent = text;
}

function settingsPayload() {
  const payload = {
    provider: $('set-provider').value,
    baseUrl: $('set-baseurl').value.trim(),
    model: $('set-model').value.trim(),
  };
  const key = $('set-apikey').value.trim();
  if (key) payload.apiKey = key;
  return payload;
}

/* The sibling endpoint may accept { model: {...} } or a flat body; try both. */
async function putSettings(payload) {
  try {
    return await api('/api/settings', { method: 'PUT', body: { model: payload } });
  } catch (err) {
    if (err.status === 400 || err.status === 422) {
      return await api('/api/settings', { method: 'PUT', body: payload });
    }
    throw err;
  }
}

async function saveSettings() {
  const payload = settingsPayload();
  if (payload.provider === 'openai' && !payload.model) {
    setStatus('bad', 'openai 需要一个模型名，例如 gpt-4o-mini。');
    return;
  }
  const save = $('set-save');
  save.disabled = true;
  setStatus('busy', '保存中…');
  try {
    await putSettings(payload);
    $('set-apikey').value = '';
    // Re-read instead of trusting the reply: it is a partial projection and the
    // pairing card / server block must stay intact.
    await loadSettings();
    try { state.config = await api('/api/config'); } catch { /* non-fatal */ }
    updateModelUi();
    renderMessages();
    setStatus('ok', '已保存。新的一轮对话就会用上。');
    toast('设置已保存');
    // One model for every machine: a change made on this computer goes to all
    // of them at once (a remote machine's own settings stay its own).
    if (machineBridge?.local && (machineBridge.machines || []).length && window.desk?.syncModel && payload.provider !== 'mock') {
      setStatus('busy', '已保存，正在同步到所有机器…');
      const res = await window.desk.syncModel().catch((err) => ({ ok: false, error: err.message }));
      const failed = (res?.results || []).filter((r) => !r.ok);
      if (!res?.ok) setStatus('bad', `已保存；同步到其他机器失败：${res?.error || '未知原因'}`);
      else if (failed.length) setStatus('bad', `已保存；没同步上：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`);
      else setStatus('ok', '已保存，并同步到所有机器。');
    }
  } catch (err) {
    if (err.status === 401) return;
    setStatus('bad', err.status === 404
      ? '服务端还没有设置接口（404），暂时只能通过环境变量配置模型。'
      : `保存失败：${err.message}`);
  } finally {
    save.disabled = false;
  }
}

async function testConnection() {
  const payload = settingsPayload();
  const hasKey = (state.settings && state.settings.model && state.settings.model.hasKey) || Boolean(payload.apiKey);
  if (payload.provider !== 'mock' && !hasKey) {
    setStatus('bad', '先填一个 API Key 再测试。');
    return;
  }
  const btn = $('set-test');
  btn.disabled = true;
  setStatus('busy', '正在连接…');
  const started = (window.performance && performance.now) ? performance.now() : Date.now();
  try {
    let result;
    try {
      result = await api('/api/settings/test', { method: 'POST', body: { model: payload } });
    } catch (err) {
      if (err.status === 400 || err.status === 422) {
        result = await api('/api/settings/test', { method: 'POST', body: payload });
      } else {
        throw err;
      }
    }
    const elapsed = Math.max(0, Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - started));
    const reported = result && (result.latencyMs ?? result.latency ?? result.ms ?? result.durationMs);
    const ms = Math.round(Number.isFinite(Number(reported)) ? Number(reported) : elapsed);
    const ok = result ? result.ok !== false && !result.error : true;
    const errText = result && result.error
      ? (typeof result.error === 'string' ? result.error : result.error.message || '')
      : '';
    const extra = (result && (result.reply || result.message)) || '';
    const mode = (result && result.mode) || '';
    const text = ok
      ? `连接正常 · ${ms} 毫秒${mode && mode !== 'live' ? ` · ${mode === 'mock' ? '演示模式' : mode}` : ''}${extra ? ` · ${truncate(extra, 48)}` : ''}`
      : `连接失败${errText ? `：${truncate(errText, 160)}` : ''}`;
    setStatus(ok ? 'ok' : 'bad', text);
  } catch (err) {
    if (err.status === 401) return;
    setStatus('bad', err.status === 404
      ? '服务端还没有测试接口（404）。保存之后照样能用。'
      : `连接失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function clearKey() {
  try {
    try {
      await api('/api/settings', { method: 'PUT', body: { model: { apiKey: '' } } });
    } catch (err) {
      if (err.status === 400 || err.status === 422) {
        await api('/api/settings', { method: 'PUT', body: { apiKey: '' } });
      } else {
        throw err;
      }
    }
    $('set-apikey').value = '';
    await loadSettings();
    renderSettingsForm();
    updateModelUi();
    setStatus('ok', '已清除保存的密钥。');
  } catch (err) {
    setStatus('bad', err.status === 404 ? '服务端还没有设置接口（404）。' : `清除失败：${err.message}`);
  }
}

