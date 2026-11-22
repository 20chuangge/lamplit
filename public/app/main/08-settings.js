'use strict';
// Lamplit page, part 8 of 12: settings. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   settings drawer
   --------------------------------------------------------------------- */
async function loadSettings() {
  // Without the app's key the code is not ours to see (1.5.32): do not ask for it.
  const mayDecide = state.auth?.authority !== false;
  const [s, p] = await Promise.allSettled([api('/api/settings'), mayDecide ? api('/api/pairing') : Promise.reject(new Error(''))]);
  state.settings = s.status === 'fulfilled' ? s.value : null;
  state.settingsError = s.status === 'rejected' ? s.reason : null;
  state.pairing = (state.settings && state.settings.pairing)
    || (p.status === 'fulfilled' ? p.value : null);
  if (state.settingsError && state.settingsError.status === 401) return;

  renderSettingsForm();
  renderPairing();
  updateModelUi();
}

/* Provider catalogue: fetched once, then used to fill the select, the model
   suggestions and the "get a key" link. The list is static, so one fetch is all
   it takes; a failure just leaves the two built-in options in place. */
async function ensureProviderOptions() {
  if (state.providers) return state.providers;
  try {
    const data = await api('/api/providers');
    state.providers = data.providers || [];
  } catch {
    state.providers = [
      { name: 'mock', label: '演示模式（无需密钥）', needsKey: false, models: [], baseUrl: '' },
      { name: 'openai', label: 'OpenAI', needsKey: true, models: ['gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1' },
    ];
  }
  const select = $('set-provider');
  const current = select.value;
  select.innerHTML = state.providers
    .map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.label)}</option>`)
    .join('');
  if (current) select.value = current;
  return state.providers;
}

function fillModelList(models) {
  const list = $('model-suggestions');
  if (list) list.innerHTML = (models || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

/**
 * The models the provider offers right now, read from the provider itself
 * (with the typed key, or the saved one), so the list is never out of date.
 */
let liveModelsTimer = null;
function loadLiveModels(delay = 0) {
  clearTimeout(liveModelsTimer);
  liveModelsTimer = setTimeout(async () => {
    const provider = $('set-provider').value;
    if (!provider || provider === 'mock') { $('model-list-note').textContent = ''; return; }
    $('model-list-note').textContent = '正在向服务商读取它现在提供的模型…';
    try {
      const r = await api('/api/providers/models', { method: 'POST', body: { provider, baseUrl: $('set-baseurl').value.trim(), apiKey: $('set-apikey').value.trim() } });
      if ($('set-provider').value !== provider) return;
      fillModelList(r.models);
      if (r.models?.length) $('set-model').placeholder = r.models[0];
      $('model-list-note').textContent = r.live ? `服务商现在提供 ${r.models.length} 个模型，点输入框可以选。` : (r.error ? `${r.error}；先列出常用的几个。` : '');
    } catch (err) {
      $('model-list-note').textContent = '';
    }
  }, delay);
}

function renderProviderHints(provider) {
  const preset = (state.providers || []).find((p) => p.name === provider);
  fillModelList(preset?.models);
  $('set-model').placeholder = preset?.models?.[0] || '模型名';
  loadLiveModels();
  const link = $('provider-keyurl');
  if (link) {
    link.textContent = preset?.keyUrl ? `在 ${preset.label} 申请密钥 →` : '';
    link.href = preset?.keyUrl || '#';
    link.hidden = !preset?.keyUrl;
  }
  if (preset?.note) $('key-state').textContent = preset.note;
  // The demo needs no address, model or key: they are not shown (1.5.54, walkthrough 6.6).
  const demo = provider === 'mock';
  for (const id of ['set-baseurl', 'set-model', 'set-apikey']) {
    if ($(id)) $(id).hidden = demo;
    const box = $(id)?.closest('.pw-wrap');
    if (box) box.hidden = demo;
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) label.hidden = demo;
  }
  if ($('model-list-note')) $('model-list-note').hidden = demo;
}

function renderSettingsForm() {
  fillModelPreset().catch(() => {});
  const m = (state.settings && state.settings.model) || {};
  const cfg = (state.config && state.config.model) || {};

  ensureProviderOptions().finally(() => {
    $('set-provider').value = m.provider || cfg.provider || 'mock';
    renderProviderHints($('set-provider').value);
  });
  $('set-baseurl').value = m.baseUrl || '';
  $('set-model').value = m.model || (cfg.provider === 'openai' ? cfg.model : '') || '';
  $('set-apikey').value = '';
  $('set-apikey').placeholder = m.hasKey ? '已保存' : 'sk-…';
  $('key-state').textContent = m.hasKey
    ? '已保存密钥。留空表示保持不变。'
    : '尚未保存密钥。';
  $('set-clear-wrap').hidden = !m.hasKey;

  const note = $('settings-note');
  const unavailable = state.settingsError
    && state.settingsError.status !== 401;
  if (unavailable) {
    note.hidden = false;
    note.textContent = state.settingsError.status === 404
      ? '这个版本的服务端还没有设置接口（404），下面显示的是当前生效的只读信息，保存/测试暂不可用。'
      : `读取设置失败：${state.settingsError.message}`;
  } else {
    note.hidden = true;
  }
  $('set-save').disabled = Boolean(unavailable);
  $('set-test').disabled = Boolean(unavailable);
}

async function loadFunnel() {
  try {
    state.funnel = await api('/api/funnel');
    renderFunnel();
  } catch {
    /* older server: no public door */
  }
}

function renderFunnel() {
  const funnel = state.funnel;
  if (!funnel) return;
  const toggle = $('funnel-enabled');
  if (toggle) {
    toggle.checked = Boolean(funnel.enabled);
    toggle.disabled = !funnel.installed;
  }
  const hint = $('funnel-hint');
  if (hint) {
    hint.textContent = funnel.state === 'not_installed'
      ? '这台电脑没装 Tailscale：装好后才能开外网访问。'
      : funnel.state === 'need_tailscale'
        ? '还差一步：去 Tailscale 后台打开 Funnel 和 HTTPS 证书，然后点「重试」。'
        : funnel.state === 'enabled'
          ? '已开启：手机在任何网络下都能连（不用装 Tailscale）。'
          : funnel.state === 'error'
            ? (funnel.error || '开启失败')
            : '关闭：手机在外面只能走局域网或已装 Tailscale。';
  }
  if ($('funnel-address')) $('funnel-address').hidden = !funnel.enabled || !funnel.address;
  if (funnel.address) $('funnel-url').textContent = `${funnel.address}/`;
  if ($('funnel-actions')) $('funnel-actions').hidden = !(funnel.hint || funnel.error);
  const open = $('funnel-open');
  if (open) {
    open.hidden = !funnel.hint;
    if (funnel.hint) open.href = funnel.hint;
  }
  if ($('funnel-retry')) $('funnel-retry').hidden = !(funnel.hint || funnel.error);
}

async function setFunnel(enabled) {
  const toggle = $('funnel-enabled');
  if (toggle) toggle.disabled = true;
  try {
    state.funnel = await api('/api/funnel', { method: 'POST', body: { enabled } });
    renderFunnel();
    toast(enabled ? '外网访问已开启' : '外网访问已关闭');
    await loadSettings();
  } catch (err) {
    toast(`外网访问没改成：${err.message}`, true);
    await loadFunnel();
  } finally {
    if (toggle) toggle.disabled = !state.funnel?.installed;
  }
}

function renderPairing() {
  const s = state.settings || {};
  const p = (s.pairing) || state.pairing || {};
  const url = p.url || (s.server && s.server.lanUrl) || '';
  const code = p.code || '';
  const remoteOn = Boolean(s.server && s.server.lanUrl);

  // The switch only exists in the desktop app: a browser tab cannot rebind the
  // hub it is already talking to.
  const deskCanRebind = Boolean(window.desk?.setRemote);
  const wrap = $('allow-remote-wrap');
  if (wrap) wrap.hidden = !deskCanRebind;
  const remoteBox = $('allow-remote');
  if (remoteBox) remoteBox.checked = remoteOn;
  checkFirewall(remoteOn);
  const connectBtn = $('phone-connect');
  if (connectBtn) connectBtn.disabled = false;
  const hint = $('phone-connect-hint');
  // Through the relay (第 2 步: 设置 → 手机和外网 → 云服务器中转): reachable from outside without Tailscale.
  const relayOn = Boolean(s.pairing?.relay);
  if (typeof renderTunnel === 'function') renderTunnel();
  if (hint) {
    hint.textContent = remoteOn
      ? '电脑上显示一个二维码，手机扫一下就进去了。'
      : relayOn
        ? '已经通过中转连接：手机 App 扫码以后，在外面用流量也能连上。'
        : (deskCanRebind
        ? '先打开上面的「允许手机连接」，再点这里出二维码。'
        : '这台机器现在只监听本机，手机连不进来。在跑 Lamplit 的那台电脑上打开「允许手机连接」。');
  }

  $('pair-url').textContent = url || location.origin;
  const tailnet = (s.server && s.server.tailnetUrl) || '';
  $('pair-tailnet-wrap').hidden = !tailnet;
  $('pair-tailnet').textContent = tailnet;
  const outside = $('outside-state');
  if (outside) {
    outside.textContent = relayOn
      ? '这台电脑已经通过你的云服务器中转连接（上面「出门在外」）：手机 App 扫过码，在外面用流量也能连上，不用装 Tailscale。'
      : tailnet
      ? `这台机器已经在 Tailscale 上：电脑和手机装好 Tailscale 后，在外面也能用 ${tailnet} 连上它。`
      : (s.server && s.server.lanUrl)
        ? '这台机器还没装 Tailscale：现在只能在同一个局域网里连上它。'
        : '这是本机的 Lamplit，只在这台电脑上用。出门在外想直接连：装 Tailscale，或者试试下面的「自建中转」（试验）；只想让它干活，用飞书给助理发消息。';
  }
  // A public address: say the connection is not encrypted.
  try {
    const lanHost = s.server?.lanUrl ? new URL(s.server.lanUrl).hostname : '';
    if (outside && !tailnet && lanHost && isPublicAddress(lanHost)) outside.textContent = '这台机器用的是公网地址：连接没有加密，配对凭据会明文经过公网。建议装上 Tailscale，以后只走加密连接。';
  } catch { /* no address */ }
  loadTailscaleBox(Boolean(tailnet)).catch(() => {});
  const codeNode = $('pair-code');
  codeNode.textContent = code ? formatPairCode(code) : (p.hidden ? '在 Lamplit 应用里看' : '未生成');
  codeNode.classList.toggle('empty', !code);
  $('pair-copy-url').disabled = !url;
  $('pair-copy-code').disabled = !code;

  const empty = $('pair-empty');
  if (p.hidden) {
    empty.hidden = false;
    empty.textContent = '配对码只在 Lamplit 应用和已配对的设备上显示：这个浏览器还没配对。';
  } else if (!code && !url) {
    empty.hidden = false;
    empty.textContent = `服务端没有提供配对信息（/api/pairing 404）。在同一局域网里，可以用 ${location.origin} 打开；如果这台机器要求认证，请在服务端配置里生成配对码。`;
  } else if (!code) {
    empty.hidden = false;
    empty.textContent = '有地址但没有配对码：手机打开这个地址后会要求配对码，请在服务端生成。';
  } else {
    empty.hidden = true;
  }
  loadDevices().catch(() => {});
}

function formatPairCode(code) {
  const raw = String(code).replace(/\s+/g, '');
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)} ${raw.slice(4)}`;
  if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 3)} ${raw.slice(3)}`;
  if (/^\d+$/.test(raw) && raw.length % 3 === 0) return raw.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
  return raw;
}

// ---------------------------------------------------------------------------
// 手机和外网: the QR a phone scans, the phones that paired, the remote switch
// ---------------------------------------------------------------------------

let pairDialogTimer = null;

function pairModalOpen(open) {
  const modal = $('pair-modal');
  const scrim = $('pair-scrim');
  if (!modal || !scrim) return;
  modal.classList.toggle('open', open);
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
  scrim.classList.toggle('show', open);
  if (!open) {
    clearInterval(pairDialogTimer);
    pairDialogTimer = null;
  }
}

function setQrBox(html) {
  const box = $('qr-box');
  if (box) box.innerHTML = html;
}

/** Draw the URL as an inline SVG (offline: the library is vendored, not a CDN). */
function drawQr(url, note = '') {
  const box = $('qr-box');
  if (!box) return;
  try {
    const qr = window.qrcode(0, 'M');
    // A relay-only code starts with words (第 2 步): UTF-8, or the phone reads gibberish.
    if (/[^\x00-\x7f]/.test(url) && window.qrcode.stringToBytesFuncs?.['UTF-8']) window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: note || '手机扫这个码连接 Lamplit' });
  } catch (err) {
    box.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'qr-hint';
    hint.textContent = '二维码没画出来。复制下面的链接到手机浏览器，一样能连。';
    box.appendChild(hint);
  }
}

function pairCountdown(expiresAt) {
  const end = Date.parse(expiresAt || '');
  const node = $('qr-count');
  clearInterval(pairDialogTimer);
  if (!node || !Number.isFinite(end)) { if (node) node.textContent = ''; return; }
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (left <= 0) {
      clearInterval(pairDialogTimer);
      pairDialogTimer = null;
      node.textContent = '这个码过期了，正在换一个新的…';
      requestPairLink(state.pairLinksPrefer || '').catch(() => {});
      return;
    }
    node.textContent = `这个码 ${Math.floor(left / 60)} 分 ${String(left % 60).padStart(2, '0')} 秒内有效，只能用一次。`;
  };
  tick();
  pairDialogTimer = setInterval(tick, 1000);
}

function renderPairTabs(links, preferredKind) {
  const tabs = $('pair-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  if (!Array.isArray(links) || links.length === 0) {
    tabs.hidden = true;
    return;
  }
  tabs.hidden = links.length < 2;
  const labels = { public: '任何网络', lan: '在家（局域网）', tailnet: '在外面（Tailscale）' };
  const chosenKind = preferredKind || links.find((l) => l.kind === 'public')?.kind || links.find((l) => l.kind === 'tailnet')?.kind || links[0].kind;
  const chosen = links.find((l) => l.kind === chosenKind) || links[0];
  for (const link of links) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tiny';
    btn.classList.toggle('active', link.kind === chosen.kind);
    btn.textContent = labels[link.kind] || link.kind;
    btn.addEventListener('click', () => {
      state.pairLinksPrefer = link.kind;
      renderPairTabs(links, link.kind);
    });
    tabs.appendChild(btn);
  }
  drawQr(chosen.url, labels[chosen.kind] || '');
  $('qr-url').textContent = chosen.url || '';
  $('qr-copy').disabled = !chosen.url;
  $('qr-iphone').hidden = chosen.kind === 'tailnet' ? true : false;
  $('qr-tailnet-note').hidden = chosen.kind !== 'tailnet';
  pairCountdown(state.pairLinks?.expiresAt);
}

function showQrError(err) {
  const box = $('qr-error');
  if (!box) return;
  box.hidden = false;
  const code = err && err.code;
  let text = (err && err.message) || '生成二维码失败';
  if (code === 'REMOTE_DISABLED') {
    // In a browser there is no switch to show: say where it is (1.5.54, walkthrough 4.2).
    text = window.desk?.setRemote
      ? '这台电脑的 Lamplit 现在只监听本机。点下面打开「允许手机连接」，手机才连得进来。'
      : '这台电脑的 Lamplit 现在只监听本机。这个开关在电脑上的 Lamplit 应用里：设置 → 手机和外网 →「允许手机连接」。打开后再点「显示二维码」。';
  }
  box.textContent = text;
  if (code === 'REMOTE_DISABLED' && window.desk?.setRemote) {
    const btn = document.createElement('button');
    btn.className = 'btn tiny';
    btn.type = 'button';
    btn.style.marginTop = '8px';
    btn.textContent = '打开「允许手机连接」';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await window.desk.setRemote(true);
        await loadSettings();
        renderPairing();
        await requestPairLink(state.pairLinksPrefer || '');
      } catch (e) {
        toast(e?.message || '打开失败', true);
        btn.disabled = false;
      }
    });
    box.appendChild(document.createElement('br'));
    box.appendChild(btn);
  }
}

async function requestPairLink(preferredKind = '') {
  const box = $('qr-error');
  if (box) box.hidden = true;
  setQrBox('<div class="qr-hint">正在生成二维码…</div>');
  if ($('qr-url')) $('qr-url').textContent = '';
  if ($('qr-count')) $('qr-count').textContent = '';
  try {
    const made = await api('/api/pairing/link', { method: 'POST' });
    state.pairLinks = { links: made?.links || [], expiresAt: made?.expiresAt, url: made?.url, qr: made?.qr || '' };
    state.pairLinksPrefer = preferredKind;
    if (made?.qr) {
      // One code with every address: the phone app picks LAN when it is on the
      // same network and Tailscale when it is not - nothing to choose here.
      if ($('pair-tabs')) $('pair-tabs').hidden = true;
      drawQr(made.qr, '手机扫这个码连接 Lamplit');
      $('qr-url').textContent = made.qr;
      $('qr-copy').disabled = false; $('qr-refresh').disabled = false;
      $('qr-iphone').hidden = false;
      $('qr-tailnet-note').hidden = true;
      const note = $('qr-auto-note');
      if (note) note.hidden = state.pairLinks.links.length < 2;
      pairCountdown(made.expiresAt);
    } else {
      renderPairTabs(state.pairLinks.links, preferredKind);
    }
  } catch (err) {
    setQrBox('<div class="qr-hint">还没有二维码</div>');
    $('qr-copy').disabled = true; $('qr-refresh').disabled = true; // nothing to copy or change yet (1.5.54)
    showQrError(err);
  }
}

async function showPairDialog() {
  pairModalOpen(true);
  await requestPairLink(state.pairLinksPrefer || '');
}

/** One row per paired phone; removing one ends that phone's session. */
function renderDevices(all) {
  const list = $('device-list');
  if (!list) return;
  list.innerHTML = '';
  const empty = $('device-empty');
  if (empty) empty.hidden = all.length > 0;
  // Logins not used for a day fold into one line with a clean-up (1.5.30: one phone had 45).
  const cut = Date.now() - 24 * 3600 * 1000;
  const personal = (d) => d.kind === 'phone' || d.kind === 'browser' || (!d.kind && !/机器/.test(d.name || ''));
  const old = all.filter((d) => personal(d) && Date.parse(d.lastSeenAt) < cut);
  const devices = all.filter((d) => !old.includes(d));
  if (old.length) {
    const row = el('div', 'device-item device-old');
    const main = el('div', 'device-main');
    main.append(el('div', 'device-name', `还有 ${old.length} 个超过一天没用的旧登录`), el('div', 'device-meta', '多半是手机 App 重新打开机器、或重新配对时留下的；清掉不影响正在用的设备。'));
    const clean = el('button', 'btn tiny', '清理掉');
    clean.type = 'button';
    clean.addEventListener('click', async () => {
      clean.disabled = true;
      try {
        const res = await api('/api/devices/prune', { method: 'POST', body: { olderThanHours: 24 } });
        toast(`清掉了 ${res.removed || 0} 个旧登录`);
        renderDevices(res.devices || []);
      } catch (err) { toast(err.message, true); clean.disabled = false; }
    });
    row.append(main, clean);
    list.appendChild(row);
  }

  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'device-item';

    const main = document.createElement('div');
    main.className = 'device-main';
    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name || '设备';
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const seen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
    const seenText = seen && !Number.isNaN(seen.getTime())
      ? `最近 ${seen.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '最近用过';
    meta.textContent = device.ip ? `${seenText} · ${device.ip}` : seenText;
    main.append(name, meta);

    const remove = document.createElement('button');
    remove.className = 'btn tiny';
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
        toast('已移除。那台手机刷新就会回到配对页。');
        await loadDevices();
      } catch (err) {
        toast(err?.message || '移除失败', true);
        remove.disabled = false;
      }
    });

    row.append(main, remove);
    list.appendChild(row);
  }
}

async function loadDevices() {
  const list = $('device-list');
  if (!list) return;
  try {
    const data = await api('/api/devices');
    renderDevices(Array.isArray(data?.devices) ? data.devices : []);
  } catch {
    /* an older server without /api/devices: leave the list empty */
  }
}

/**
 * Windows Firewall (1.5.29): with 允许手机连接 on, does Windows let a phone on
 * the same Wi-Fi in? If not, say so here and offer the fix (it asks for admin).
 */
async function checkFirewall(remoteOn) {
  const note = $('firewall-note');
  const row = $('firewall-row');
  if (!note || !row) return;
  if (!remoteOn || !window.desk?.firewallStatus || !onLocalMachine()) { note.hidden = true; row.hidden = true; return; }
  const st = await window.desk.firewallStatus().catch(() => null);
  state.firewall = st;
  const closed = st?.applies && st.known && !st.ok;
  note.hidden = !closed;
  row.hidden = !closed;
  if (closed) {
    note.textContent = st.blocked
      ? 'Windows 防火墙挡住了局域网里的手机（之前弹窗时可能点了取消）。手机只能绕 Tailscale 连进来，会慢一些。'
      : `这台电脑的网络被 Windows 标成了「${(st.networks || []).includes('Public') ? '公用' : '专用'}」，没有放行 Lamplit：同一个 Wi-Fi 里的手机连不进来，只能绕 Tailscale。`;
  }
}
/**
 * 体检's Windows Firewall lines (1.5.49): TCP for the phone at home (with
 * 允许手机连接 on), UDP for 直连 (this computer's relay in use, 「先试直连」 on).
 * On the user's PC a Block rule left from the app's former name kept direct shut while
 * 体检 said nothing: it checked TCP only.
 */
function firewallCheckupItems(fw, remoteOn, relay) {
  if (!fw?.applies || !fw.known) return [];
  state.firewall = fw;
  const fix = { kind: 'firewall', label: '修复防火墙' };
  const out = [];
  if (remoteOn) {
    out.push(fw.ok
      ? { id: 'firewall', title: 'Windows 防火墙', state: 'ok', text: '同一个 Wi-Fi 里的手机可以直接连进来。' }
      : { id: 'firewall', title: 'Windows 防火墙', state: 'bad', text: '挡住了同一个 Wi-Fi 里的手机，手机只能绕远路连进来。', action: fix });
  }
  const direct = relay?.enabled && relay.direct?.enabled !== false && relay.direct?.applies !== false;
  if (direct && fw.udp?.known) {
    out.push(fw.udp.ok
      ? { id: 'firewall-udp', title: 'Windows 防火墙（直连）', state: 'ok', text: '放行了直连用的 UDP。' }
      : { id: 'firewall-udp', title: 'Windows 防火墙（直连）', state: 'warn', text: '挡住了直连用的 UDP：手机在外面打不通直连，只能走中转（能用，只是看屏幕慢一点、也占服务器流量）。', action: fix });
  }
  return out;
}

async function fixFirewall() {
  const btn = $('firewall-fix');
  if (!window.desk?.firewallFix) return;
  // Say exactly what will change before Windows asks for admin (1.5.49).
  const st = await window.desk.firewallStatus?.().catch(() => null);
  const plan = Array.isArray(st?.plan) ? st.plan : [];
  if (plan.length && !window.confirm(`修复 Windows 防火墙会做这些改动（接下来 Windows 会弹出管理员确认）：\n\n• ${plan.join('\n• ')}\n\n要继续吗？`)) return;
  if (btn) btn.disabled = true;
  toast('Windows 会弹出管理员确认，点「是」');
  try {
    const res = await window.desk.firewallFix();
    if (res?.ok) toast('好了：同一个 Wi-Fi 里的手机能直接连进来，直连用的 UDP 也放行了');
    else toast(res?.declined ? '没有修改：管理员确认被取消了' : '没修好，请在 Windows 防火墙里放行 Lamplit', true);
  } finally {
    if (btn) btn.disabled = false;
    checkFirewall(true);
  }
}

/** Desktop only: rebind the local hub so phones can reach it. */
async function applyRemoteSwitch(on) {
  const box = $('allow-remote');
  if (!window.desk?.setRemote) return;
  if (box) box.disabled = true;
  try {
    await window.desk.setRemote(Boolean(on));
    toast(on ? '已打开：手机现在能连进来了。' : '已关闭：手机连不进来了。');
    await loadSettings();
    renderPairing();
    await loadDevices();
  } catch (err) {
    toast(err?.message || '切换失败', true);
    if (box) box.checked = !on;
  } finally {
    if (box) box.disabled = false;
  }
}


/** Settings is a set of pages: the left list picks one, only that one shows. */
function setSettingsNav(sectionId) {
  document.querySelectorAll('.setnav').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.setTarget === sectionId);
  });
  document.querySelectorAll('#settings-scroll > .dsec').forEach((sec) => {
    sec.classList.toggle('active', sec.id === sectionId);
  });
  const scroller = $('settings-scroll');
  if (scroller) scroller.scrollTop = 0;
  const drawer = $('settings-drawer');
  drawer?.classList.remove('set-home');
  if (sectionId === 'sec-home') renderSettingsHome(); // 1.5.61: the home first (08b-settings-home.js)
  const picked = document.querySelector(`.setnav[data-set-target="${sectionId}"]`);
  $('settings-title').textContent = isMobile() && picked ? picked.textContent.trim() : settingsTitle();
}

/**
 * Whose settings these are (1.5.44): in 「全部机器」 设置 changes only this
 * machine's, and nothing said which. 「Windows 电脑的设置」, in the app too.
 */
function settingsTitle() {
  const name = machineDisplayName();
  return name ? `${name}的设置` : '设置';
}

// From desktop width to phone width with a page open: its name, not 「…的设置」 (1.5.44 test).
mqMobile.addEventListener?.('change', () => {
  if (!state.settingsOpen || $('settings-drawer')?.classList.contains('set-home')) return;
  const picked = document.querySelector('.setnav.active');
  $('settings-title').textContent = isMobile() && picked ? picked.textContent.trim() : settingsTitle();
});

/** Phone: the settings list itself (the mockup's grouped list). */
function showSettingsHome() {
  $('settings-drawer').classList.add('set-home');
  $('settings-title').textContent = settingsTitle();
}

/** Line icons for the settings list, one per page (Lucide shapes, ISC licence). */
const SETNAV_ICONS = {
  'sec-home': '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  'sec-model': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>',
  'sec-run': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  'sec-initiative': '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'sec-bounds': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  'sec-usage': '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5a3 3 0 0 0-2.5-1.2c-1.7 0-2.8.9-2.8 2s1 1.6 2.8 1.9 2.8.9 2.8 2-1.2 2-2.8 2a3 3 0 0 1-2.6-1.3M12 6.5v1.8M12 15.8v1.7"/>',
  'sec-feishu': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'sec-mcp': '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  'sec-pages': '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  'sec-vault': '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  'sec-audit': '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  'sec-machines': '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  'sec-skills': '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  'sec-memory': '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  'sec-appearance': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  'sec-pair': '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  'sec-backup': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  'sec-about': '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  'sec-checkup': '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
};
/*
 * Settings laid out as cards (1.5.10, after Cursor / Codex): each page keeps
 * its title and one line of description; what follows is grouped into cards,
 * one per small heading, and the 模型 page gets tabs instead of one long
 * scroll. The elements are moved, not rebuilt, so their ids and handlers stay.
 */
const MODEL_TABS = [
  ['chat', '对话', ['settings-form', 'model-share']],
  ['more', '多个模型', ['models-set']],
  ['voice', '语音', ['voice-set']],
  ['vision', '看图', ['vision-set']],
  ['media', '生图和视频', ['media-image-set', 'media-video-set']],
  ['code', '编程助手', ['cliagents-set']],
];
const CARD_BLOCKS = 'form, .voice-set, .perm-card, .pair-card, .model-share, .vault-add, details.set-block, .relay-box, .checkup-card';

function cardifySettings() {
  for (const sec of document.querySelectorAll('#settings-scroll > .dsec')) {
    if (sec.dataset.cards) continue;
    sec.dataset.cards = '1';
    const kids = [...sec.children];
    let i = 0;
    // The page title and its first line of description stay outside the cards.
    if (kids[i]?.matches('.dsec-head')) i += 1;
    if (kids[i]?.matches('.dsec-sub, .row-note') && !kids[i].id) i += 1;
    let card = null;
    for (; i < kids.length; i += 1) {
      const node = kids[i];
      if (node.matches(CARD_BLOCKS)) {
        node.classList.add('set-card');
        card = null;
        continue;
      }
      if (node.matches('.dsec-head') || !card) {
        card = el('div', 'set-card');
        sec.insertBefore(card, node);
      }
      card.appendChild(node);
    }
    for (const c of sec.querySelectorAll('.set-card')) if (!c.textContent.trim() && !c.querySelector('input, select, button, table')) c.remove();
  }
  // 模型: tabs.
  const model = $('sec-model');
  if (model && !$('model-tabs')) {
    const bar = el('div', 'set-tabs');
    bar.id = 'model-tabs';
    for (const [key, label] of MODEL_TABS) {
      const b = el('button', 'set-tab', label);
      b.type = 'button';
      b.dataset.tab = key;
      b.addEventListener('click', () => showModelTab(key));
      bar.appendChild(b);
    }
    const anchor = model.querySelector('.set-card');
    model.insertBefore(bar, anchor);
    showModelTab(state.modelTab || 'chat');
  }
}

function showModelTab(key) {
  state.modelTab = key;
  for (const b of document.querySelectorAll('#model-tabs .set-tab')) b.classList.toggle('on', b.dataset.tab === key);
  for (const [tab, , ids] of MODEL_TABS) {
    for (const id of ids) {
      const node = $(id);
      if (node) node.classList.toggle('tab-hidden', tab !== key);
    }
  }
}

function decorateSettingsNav() {
  document.querySelectorAll('.setnav').forEach((btn) => {
    const shape = SETNAV_ICONS[btn.dataset.setTarget];
    if (!shape || btn.querySelector('svg')) return;
    btn.insertAdjacentHTML('afterbegin', `<svg class="setnav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`);
  });
}

/** One model for every machine (desktop app only: it holds the pairings). */
async function syncModelToMachines() {
  const btn = $('model-sync');
  const note = $('model-sync-note');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const res = await window.desk.syncModel();
    note.hidden = false;
    if (!res?.ok) {
      note.textContent = res?.error || '同步失败';
      return;
    }
    if (!res.results.length) {
      note.textContent = '还没有别的机器。';
      return;
    }
    const done = res.results.filter((r) => r.ok).map((r) => r.name);
    const failed = res.results.filter((r) => !r.ok).map((r) => `${r.name}（${r.error}）`);
    note.textContent = [
      done.length ? (res.voice ? `已同步 ${res.model} 和语音密钥到：${done.join('、')}` : `已同步 ${res.model} 到：${done.join('、')}`) : '',
      failed.length ? `没同步上：${failed.join('、')}` : '',
    ].filter(Boolean).join('；');
    toast(failed.length ? '有机器没同步上' : '模型已同步到所有机器', Boolean(failed.length));
  } catch (err) {
    note.hidden = false;
    note.textContent = `同步失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '同步到所有机器';
  }
}

function openSettings(section) {
  if ($('model-share')) $('model-share').hidden = !window.desk?.syncModel;
  renderMachinesList();
  loadDesktopMode().catch(() => { /* older server */ });
  loadSkills();
  loadMemory();
  loadSettings().catch(() => { /* keep whatever we have */ });
  loadVoice().catch(() => { /* older server: no voice */ });
  loadVision().catch(() => { /* older server: no vision */ });
  loadCliAgents().catch(() => {});
  loadMedia().catch(() => { /* older server: no generation */ });
  loadPolicy().catch(() => { /* older server: switch stays off */ });
  loadAudit().catch(() => {});
  loadUsage().catch(() => {});
  loadFunnel().catch(() => {});
  loadVault().catch(() => {});
  loadMcp().catch(() => {});
  loadInitiative().catch(() => {});
  loadPages().catch(() => {});
  loadFeishu().catch(() => {});
  loadModels().catch(() => {});
  // Phone: what was open, taken before it is closed; one history step (1.5.56).
  settingsNav.opened(section, state.settingsOpen);
  // On a phone the home list and the panel stay under the sheet until it has faded in (160 ms):
  // shut at once, the chat behind them flashed (1.5.56).
  if (isMobile()) setTimeout(() => { if (state.settingsOpen) { closeSidebar(); closePanel(); } }, 200);
  else { closeSidebar(); closePanel(); }
  state.settingsOpen = true;
  $('settings-drawer').classList.add('open');
  $('settings-drawer').setAttribute('aria-hidden', 'false');
  $('settings-scrim').classList.add('show');
  normalizeOverlays();
  // Opened with nothing picked: the home (a computer; 1.5.61), the list (a phone).
  const targetId = section || (isMobile() ? 'sec-model' : 'sec-home');
  setSettingsNav(targetId);
  if (isMobile() && !section) showSettingsHome();
}

/* Linux machines: each bot has a screen of its own; light or full, and idle ones stop. */
async function loadDesktopMode() {
  const box = $('desktop-mode-box');
  if (!box) return;
  const r = await api('/api/desktops');
  // Wayland (cage) screens have no light/full choice: they show the browser only.
  const perBot = Boolean(r.support?.available && !r.support?.shared && r.support?.backend !== 'wayland');
  box.hidden = !perBot || !r.mode;
  // Where there is no choice, say why, so the option does not look lost.
  const none = $('desktop-mode-none');
  if (none) {
    const why = r.support?.backend === 'wayland'
      ? '这台机器的屏幕只显示机器人的浏览器（Rocky / RHEL 10 没有 X11，也就没有 XFCE），没有桌面可选。'
      : r.support?.shared || state.computer?.host?.platform === 'win32'
        ? '' // Windows: there is no choice to explain (1.5.54, walkthrough 5.4)
        : '';
    none.textContent = why;
    none.hidden = !box.hidden || !why;
  }
  if (box.hidden) return;
  $('desktop-mode').value = r.mode;
  const running = (r.desktops || []).filter((d) => d.running).length;
  const noXfce = r.mode === 'full' && r.fullInstalled === false
    ? '这台机器还没装 XFCE，现在仍用轻量桌面：点下面的「安装 XFCE」。'
    : '';
  const installing = r.install?.state === 'running';
  const failed = r.install?.state === 'failed' ? r.install.detail : '';
  const status = installing ? `${r.install.detail}。装好后新打开的桌面就是 XFCE。` : failed || noXfce;
  $('desktop-mode-note').textContent = `每个机器人有一块自己的屏幕，开着的有 ${running} 块。没人用 ${r.idleMinutes || 15} 分钟就自动关掉，要用时再打开（浏览器的登录状态不会丢）。改了以后，新打开的桌面才生效。${status ? ` ${status}` : ''}`;
  $('desktop-full-row').hidden = !(r.mode === 'full' && r.fullInstalled === false);
  $('desktop-full-install').disabled = installing;
  $('desktop-full-install').textContent = installing ? '正在安装…' : '安装 XFCE';
  clearTimeout(loadDesktopMode.poll);
  if (installing) loadDesktopMode.poll = setTimeout(() => { if (state.settingsOpen) loadDesktopMode().catch(() => {}); }, 15000);
}

async function installFullDesktop() {
  try {
    await api('/api/desktops/install-full', { method: 'POST' });
    toast('开始安装 XFCE，几分钟后新打开的桌面就是完整桌面');
  } catch (err) { toast(`安装失败：${err.message}`, true); }
  loadDesktopMode().catch(() => {});
}

async function saveDesktopMode() {
  try {
    await api('/api/desktops/mode', { method: 'PUT', body: { mode: $('desktop-mode').value } });
    toast('已保存，新打开的桌面会用这个');
    loadDesktopMode().catch(() => {});
  } catch (err) { toast(`保存失败：${err.message}`, true); }
}

function closeSettings(opts) {
  // Phone: back where it was opened from (opts is a click event when wired straight to a button).
  const from = state.settingsOpen ? settingsNav.closed({ viaHistory: opts?.viaHistory === true }) : null;
  state.settingsOpen = false;
  $('settings-drawer').classList.remove('open');
  $('settings-drawer').setAttribute('aria-hidden', 'true');
  $('settings-scrim').classList.remove('show');
  normalizeOverlays();
  restoreSettingsView(from);
  if (!isMobile()) $('settings-btn').focus();
}

/* Autonomy switch: does this installation ask before high-risk actions? */
/* --- sidebar status: needs you / working / new result ------------------------ */
state.attention = { items: {} };
state.otherMachines = [];
let attentionTimer = null;

/** A chat's status: this machine's, or (1.5.42) a bot's on another machine, from the roster. */
function attentionItem(key) {
  return state.attention?.items?.[key] || state.peerAttention?.[key] || null;
}

function currentChatKey() {
  if (isGroupMode()) return state.groupId ? `group:${state.groupId}` : null;
  return state.botId ? `bot:${state.botId}` : null;
}

/** The status mark for one sidebar row, or null when there is nothing to say. */
function attentionBadge(key) {
  const item = attentionItem(key);
  if (!item) return null;
  // The chat on screen has no "new result": the human is looking at it.
  const unread = item.unread && key !== currentChatKey();
  let kind = '';
  let label = '';
  if (item.needsYou) {
    kind = 'needs';
    label = item.waiting?.kind === 'decision' ? '需要你拍板'
      : item.waiting?.kind === 'login' ? '需要你填写登录信息'
      : item.waiting?.kind === 'takeover' ? '需要你接管屏幕'
        : '需要你处理：有操作等你批准';
  } else if (item.asking) {
    kind = 'needs';
    label = '需要你回复';
  } else if (item.working) {
    kind = 'working';
    label = '正在工作';
  } else if (item.failed) {
    // Redesign step 2: the last turn got stuck - a red dot until the next one starts.
    kind = 'failed';
    label = `上一次：${stuckLine(item.failed.status)}`;
  } else if (unread) {
    kind = 'unread';
    label = '有新结果';
  } else {
    return null;
  }
  const node = el('span', `att ${kind}`);
  node.title = label;
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', label);
  const dot = document.createElement('i');
  if (kind === 'needs') dot.textContent = '!';
  node.appendChild(dot);
  return node;
}

/**
 * The line under a bot or group in the list (1.5.40): what it is doing and how
 * far it is, what it waits on you for, or what it finished - not only its last
 * words. With nothing going on it is `idle` (a bot's role, a group's members).
 * -> {text, kind: 'needs' | 'working' | 'unread' | '', tail?: 'n/m' of its checklist}
 */
function rosterLine(key, { idle = '', last = '', group = false } = {}) {
  const item = attentionItem(key);
  const brief = (s, n = 60) => truncate(plainPreview(String(s || '')), n);
  // What matters comes first, the kind of wait in a word or not at all (1.5.41):
  // the orange 「!」 already says it waits on you, and a narrow list cut
  // 「等你点头：想运行 3 …」 before what it wanted. The tooltip has it whole.
  if (item?.needsYou) {
    const wait = item.waiting;
    if (wait?.kind === 'decision') return { kind: 'needs', text: wait.text ? `问你：${brief(wait.text)}` : '等你拍板', hint: '等你拍板' };
    if (wait?.kind === 'login') return { kind: 'needs', text: '等你填写登录信息' };
    if (wait?.kind === 'takeover') return { kind: 'needs', text: '等你接管屏幕' };
    // What the card asks, in its own headline (1.5.59): 「等你点头：删除「旧报告.docx」」.
    const card = group ? '' : waitingCardTitle(key);
    if (card) return { kind: 'needs', text: `等你点头：${card}` };
    const ask = item.ask || {};
    const who = group && ask.botName ? ask.botName : '';
    if (ask.count > 1) return { kind: 'needs', text: who ? `${who}：想运行 ${ask.count} 条查看命令` : `想运行 ${ask.count} 条查看命令`, hint: '等你点头' };
    if (TOOL_TEXT[ask.tool]) return { kind: 'needs', text: who ? `${who}：想${TOOL_TEXT[ask.tool].label}` : `想${TOOL_TEXT[ask.tool].label}`, hint: '等你点头' };
    const app = ask.tool ? mcpToolText(ask.tool)?.title : '';
    return { kind: 'needs', text: app ? (who ? `${who}：${app}` : app) : '有操作等你批准', hint: '等你点头' };
  }
  // A step of its checklist or board waits for an answer: the human is what it waits on.
  // A checklist parked with no question of its own says 等你回复 (1.5.41: it said nothing).
  if (item?.asking) {
    const q = item.asking.question;
    return { kind: 'needs', text: q ? `问你：${brief(q)}` : '等你回复', hint: '等你回复' };
  }
  if (item?.working) {
    const doing = item.doing || {};
    if (doing.total) return { kind: 'working', text: brief(doing.step, 40), tail: `${doing.done}/${doing.total}`, hint: '正在做' };
    if (doing.text) return { kind: 'working', text: `在做：${brief(doing.text)}` };
    if (doing.tool) return { kind: 'working', text: `正在${toolNameLabel(doing.tool)}…` };
    return { kind: 'working', text: '正在工作…' };
  }
  if (item?.failed) return { kind: 'failed', text: stuckLine(item.failed.status), hint: '上一次' };
  // The chat on screen has no "new result": the human is looking at it.
  if (item?.unread && key !== currentChatKey()) return { kind: 'unread', text: last ? `做完了：${last}` : '做完了，有新结果' };
  return { kind: '', text: idle };
}

/** Why the last turn got stuck, as the list says it: 「出错了，没做完」. */
function stuckLine(status) {
  if (status === 'stalled') return statusWords(status);
  return `${status === 'failed' || status === 'error' ? '出错了' : statusWords(status)}，没做完`;
}

/** That line as a node: in a narrow list the words give way, the count ("3/8") stays. */
function rosterLineNode(line) {
  const node = el('div', `bot-preview${line.kind ? ` st-${line.kind}` : ''}`);
  node.appendChild(el('span', 'bp-text', line.text));
  if (line.tail) node.appendChild(el('span', 'bp-tail', line.tail));
  const whole = line.hint ? `${line.hint}：${line.text}` : line.text;
  node.title = line.tail ? `${whole} · ${line.tail}` : whole;
  return node;
}

/** For the main assistant's line while it is free: how many other chats wait on the human. */
function othersWaitingLine(ownKey) {
  const others = Object.entries(state.attention?.items || {}).filter(([key]) => key !== ownKey).map(([, item]) => item || {});
  const needs = others.filter((item) => item.needsYou || item.asking).length;
  if (!needs) return '';
  // Not 「其余都在正常跑」 while another one got stuck (1.5.59 beginner test: 写稿 was red).
  const stuck = others.filter((item) => item.failed && !item.working && !item.needsYou && !item.asking).length;
  if (stuck) return `${needs} 件事等你，${stuck} 个出错了`;
  return others.some((item) => item.working && !item.needsYou && !item.asking) ? `${needs} 件事等你，其余都在正常跑` : `${needs} 件事等你`;
}

function loadAttention() {
  clearTimeout(attentionTimer);
  attentionTimer = setTimeout(async () => {
    const before = currentChatKey();
    const wasWorking = Boolean(state.attention?.items?.[before]?.working);
    const hadResult = new Set(Object.entries(state.attention?.items || {}).filter(([, item]) => item?.unread).map(([k]) => k));
    const prevItems = state.attention?.items || {};
    try { state.attention = await api('/api/attention'); } catch { return; /* older hub */ }
    noteActivity(prevItems, state.attention?.items, 'here'); // a new card, a result: that chat moves up (1.5.61)
    // 「做完了：…」 quotes its last words, and those come with the roster: fetch it when a result is new.
    if (Object.entries(state.attention.items || {}).some(([k, item]) => item?.unread && !hadResult.has(k))) {
      Promise.resolve(refreshRoster()).then(() => { renderBots(); renderGroups(); }).catch(() => {});
    }
    const key = currentChatKey();
    if (key && state.attention.items?.[key]?.unread && document.visibilityState === 'visible') markSeen();
    // A hand-over drawn as 在做 just as its turn ended (this news came after the transcript): it is done.
    if (key === before && wasWorking && !state.attention.items?.[key]?.working && !state.liveTurn && messagesEl?.querySelector('.handoff-state.doing')) renderMessages();
    renderBots();
    renderGroups();
    syncDoneButton();
    syncTypingWithAttention();
    renderDecisionStrip();
    lampRefresh();
  }, 120);
}

/**
 * 有新版本 (1.2.166): the desktop app on this computer and the phone app ask
 * this machine whether GitHub has a newer Lamplit (the machine caches it for
 * hours). Machines given to the bots are updated from this computer instead.
 */
/** The phone app or the desktop app on this computer: the ones that can update themselves. */
function canUpdateHere() {
  return typeof window.NightshiftShell?.appVersion === 'function' || (typeof window.desk?.installUpdate === 'function' && onLocalMachine());
}

// The phone app is rarely closed (1.5.0): coming back after half an hour asks again.
const UPDATE_RECHECK_MS = 30 * 60 * 1000;
let lastUpdateCheck = 0;
function maybeCheckForUpdate() {
  if (Date.now() - lastUpdateCheck > UPDATE_RECHECK_MS) checkForUpdate().catch(() => {});
}

/** fresh: ask GitHub now (检查更新 in 关于); manual: say what came of it. */
async function checkForUpdate({ fresh = false, manual = false } = {}) {
  const phone = typeof window.NightshiftShell?.appVersion === 'function';
  if (!canUpdateHere()) return;
  lastUpdateCheck = Date.now();
  let have = '';
  try { have = phone ? String(window.NightshiftShell.appVersion() || '') : ''; } catch { /* older app */ }
  const q = new URLSearchParams();
  if (have) q.set('have', have);
  if (fresh) q.set('fresh', '1');
  let info;
  try { info = await api(`/api/update${q.toString() ? `?${q}` : ''}`); } catch (err) {
    if (manual) toast(`没能检查更新：${err.message}`, true);
    return;
  }
  state.update = { ...info, phone };
  if (manual) {
    if (info.error) toast(`没能检查更新：${info.error}`, true);
    else if (!info.newer) toast('已经是最新版');
    // Asked for: show it even if this version was skipped before.
    else { try { localStorage.removeItem('desk.updateSkip'); } catch { /* private mode */ } }
  }
  renderUpdateBanner(state.update);
}

function renderUpdateBanner(info) {
  for (const box of [$('update-banner'), $('update-banner-side')]) if (box) fillUpdateBanner(box, info);
}

function fillUpdateBanner(box, info) {
  let skipped = '';
  try { skipped = localStorage.getItem('desk.updateSkip') || ''; } catch { /* private mode */ }
  const link = info?.phone ? info?.apkUrl : info?.setupUrl;
  if (!info?.newer || !link || skipped === info.latest) { box.hidden = true; return; }
  box.innerHTML = '';
  const head = el('div', 'update-head');
  head.appendChild(el('b', null, '有新版本'));
  head.appendChild(el('span', null, `${info.latest}（现在是 ${info.current}）`));
  box.appendChild(head);
  if (Array.isArray(info.notes) && info.notes.length) {
    const more = el('details', 'update-notes');
    more.appendChild(el('summary', null, '改了什么'));
    const list = el('ul');
    for (const n of info.notes) list.appendChild(el('li', null, n));
    more.appendChild(list);
    box.appendChild(more);
  }
  const actions = el('div', 'update-actions');
  const go = el('button', 'btn primary tiny', info.phone ? '下载新版' : '立即更新');
  go.type = 'button';
  go.addEventListener('click', async () => {
    if (info.phone) {
      try { window.NightshiftShell.openExternal(link); } catch { window.open(link, '_blank', 'noopener'); }
      toast('下载好后点开安装包，按提示更新');
      return;
    }
    const busy = Object.values(state.attention?.items || {}).some((i) => i && i.working);
    const ok = await askConfirm({
      title: `更新到 ${info.latest}`,
      text: busy ? '有机器人正在干活：更新时 Lamplit 会关掉再打开，正在做的这一轮会中断（任务清单会接着做）。要现在更新吗？' : 'Lamplit 会下载新版、自动安装，然后关掉再打开，大约一两分钟。',
      confirmLabel: '更新',
    });
    if (!ok) return;
    go.disabled = true;
    go.textContent = '正在下载…';
    const res = await window.desk.installUpdate(link).catch((err) => ({ ok: false, error: err.message }));
    if (!res?.ok) {
      go.disabled = false;
      go.textContent = '立即更新';
      toast(`没能更新：${res?.error || '未知原因'}`, true);
      return;
    }
    go.textContent = '正在安装，马上重新打开…';
  });
  const later = el('button', 'btn tiny', '这个版本先不更新');
  later.type = 'button';
  later.addEventListener('click', () => {
    try { localStorage.setItem('desk.updateSkip', info.latest); } catch { /* private mode */ }
    renderUpdateBanner(info);
  });
  actions.appendChild(go);
  if (info.page) {
    const page = el('button', 'btn tiny', '发布页');
    page.type = 'button';
    page.addEventListener('click', () => openSignInPage(info.page));
    actions.appendChild(page);
  }
  actions.appendChild(later);
  box.appendChild(actions);
  box.hidden = false;
}

/**
 * 需要你拍板, said on top of the chat (1.2.165): on 11-15 the group's "!"
 * explained itself only on hover. Clicking goes to the bot's last words; the
 * strip goes once you answer (a new turn starts there).
 */
function renderDecisionStrip() {
  const strip = $('decision-strip');
  if (!strip) return;
  const item = state.attention?.items?.[currentChatKey()];
  const wait = item?.waiting;
  if (!wait || wait.kind !== 'decision') { strip.hidden = true; return; }
  const text = String(wait.text || '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
  strip.textContent = '';
  strip.appendChild(el('b', null, '需要你拍板'));
  strip.appendChild(el('span', null, text ? truncate(text, 140) : '它在等你的决定，回它一句就行'));
  strip.title = '点一下看它的原话；回一句，这条提示就会消失';
  strip.hidden = false;
  strip.onclick = () => {
    const rows = messagesEl.querySelectorAll('.row.assistant, .row.group-row, .g-row');
    const last = rows[rows.length - 1] || messagesEl.lastElementChild;
    if (last) {
      last.scrollIntoView({ block: 'center', behavior: 'smooth' });
      last.classList.add('flash');
      setTimeout(() => last.classList.remove('flash'), 1600);
    }
    $('composer')?.focus?.();
  };
}

/**
 * The chat on screen shows "working…" whenever its bot is working, also when
 * the page missed the start (reloaded, opened mid-turn) or a step runs long
 * without news (waiting on a colleague). Live streaming keeps its own line.
 */
function syncTypingWithAttention() {
  if (isGroupMode() || !state.botId || !messagesEl) return;
  const att = state.attention?.items?.[currentChatKey()];
  const working = Boolean(att?.working);
  // A card waiting: 「等你点头…」 (1.5.54 recheck: after a reload it stayed 「正在处理…」, drawn before this data came).
  const label = att?.needsYou || att?.asking ? '等你点头…' : '正在处理…';
  const row = messagesEl.querySelector('.typing-row');
  if (working && !state.liveTurn?.bubble && row?.querySelector('.typing-label')?.textContent !== label) showTyping(typingBotId(), label);
  else if (!working && row && !state.liveTurn) hideTyping();
}

/** The human is looking at the chat on screen. */
function markSeen() {
  const key = currentChatKey();
  if (!key || document.visibilityState !== 'visible') return;
  const item = attentionItem(key);
  if (item) item.unread = false;
  // A bot on another machine: its machine keeps what was seen (1.5.42).
  if (!isGroupMode() && isRemoteId(state.botId)) { api(remoteApi(state.botId, '/seen'), { method: 'POST', body: {} }).catch(() => {}); return; }
  if (isGroupMode() && isRemoteId(state.groupId)) { api(remoteGroupApi(state.groupId, '/seen'), { method: 'POST', body: {} }).catch(() => {}); return; }
  api('/api/attention/seen', { method: 'POST', body: { key } }).catch(() => {});
}

/** Other machines' status, from the desktop shell (the page cannot reach them itself). */
async function pollOtherMachines() {
  if (!window.desk?.machinesAttention) return;
  const before = new Map((state.otherMachines || []).map((m) => [m.url, m.needsYou || 0]));
  try { state.otherMachines = (await window.desk.machinesAttention()) || []; } catch { return; }
  const more = state.otherMachines.filter((m) => before.has(m.url) && (m.needsYou || 0) > before.get(m.url));
  if (more.length) {
    // A card is announced by the inbox, and its notification opens that card here (1.5.41).
    // What is left is a question in a chat there: that one still opens the machine.
    await refreshInbox();
    for (const m of more) {
      if ((state.inbox.items || []).some((i) => i.machine === m.name)) continue;
      notifyHuman({ title: `「${m.name}」上有事等你`, body: '它在等你回一句话，点开看看', tag: `machine|${m.url}` });
    }
  }
  const needs = state.otherMachines.reduce((n, m) => n + (m.needsYou || 0), 0);
  const unread = state.otherMachines.reduce((n, m) => n + (m.unread || 0), 0);
  const badge = $('machine-badge');
  if (badge) {
    badge.hidden = !(needs || unread);
    badge.className = `machine-badge${needs ? ' needs' : ''}`;
    badge.textContent = String(needs || unread || '');
    const who = state.otherMachines.filter((m) => m.needsYou || m.unread).map((m) => m.name).join('、');
    badge.title = needs ? `其他机器上有 ${needs} 处需要你处理（${who}）` : `其他机器上有 ${unread} 个新结果（${who}）`;
  }
  renderMachineMenu();
}

function machineAttLabel(url) {
  const m = state.otherMachines?.find((x) => x.url === (url || 'local'));
  if (!m) return '';
  if (m.reachable === false) return `<span class="mm-att off">${escapeHtml('离线')}</span>`;
  if (m.needsYou) return `<span class="mm-att needs">${escapeHtml(`${m.needsYou} 处等你`)}</span>`;
  if (m.unread) return `<span class="mm-att">${escapeHtml(`${m.unread} 个新结果`)}</span>`;
  if (m.working) return `<span class="mm-att">${escapeHtml('工作中')}</span>`;
  return '';
}

/* --- connection, takeover popup, notifications --------------------------------- */
state.conn = { fails: 0, offline: false };

/** Health answered (or not): after two misses in a row, say so above the chat. */
function setConnected(ok) {
  const banner = $('conn-banner');
  if (ok) {
    const was = state.conn.offline;
    state.conn = { fails: 0, offline: false };
    if (banner) banner.hidden = true;
    document.querySelector('#machine-sub .machine-dot')?.classList.remove('off');
    if (was) {
      toast(`已重新连上「${machineDisplayName()}」`);
      clearInterval(state.connRetry);
      state.connRetry = null;
      loadAttention();
      if (isGroupMode()) loadGroupMessages(); else loadMessages();
    }
    return;
  }
  state.conn.fails += 1;
  if (state.conn.fails < 2 || state.conn.offline) return;
  state.conn.offline = true;
  lampRefresh(); // the faces close their eyes until the machine answers again
  if (banner) {
    $('conn-text').textContent = onLocalMachine()
      ? '连不上本机的 Lamplit 服务，正在重连…'
      : `连不上「${machineDisplayName()}」，正在重连…（那台机器可能关机、断网或在重启）`;
    $('conn-local').hidden = onLocalMachine() || !window.desk?.useLocal;
    banner.hidden = false;
  }
  document.querySelector('#machine-sub .machine-dot')?.classList.add('off');
  // Try more often while it is down.
  if (!state.connRetry) state.connRetry = setInterval(pollHealth, 5000);
}

function chatKeyOf(ev) {
  return ev.groupId ? `group:${ev.groupId}` : ev.botId ? `bot:${ev.botId}` : null;
}

function chatName(key) {
  const [kind, id] = String(key).split(/:(.*)/);
  if (kind === 'group') return groupById(id)?.name || '群组';
  return botById(id)?.name || id;
}

/** System notification, only when the window is not what the human is looking at. */
async function notifyHuman({ title, body = '', tag = '' }) {
  if (document.hasFocus()) return;
  // Notifications are outside the page, where the UI translation never reaches.
  const tr = (x) => (window.deskI18n?.t ? window.deskI18n.t(x) : x);
  title = tr(title);
  body = tr(body);
  try {
    if (window.desk?.notify) { await window.desk.notify({ title, body, tag }); return; }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); window.deskNotificationClick(tag); };
  } catch { /* notifications are a convenience */ }
}

/** A notification was clicked: go to what it was about. */
window.deskNotificationClick = async (tag) => {
  const [what, key, kind] = String(tag || '').split('|');
  // Someone there waits for a word (1.5.42): its chat opens here, no window switch.
  if (what === 'machine') {
    const name = (machineBridge?.machines || []).find((m) => m.url === key)?.name || '';
    const waiting = (state.peerRoster || []).find((m) => m.machine === name)?.bots?.find((b) => { const it = state.peerAttention?.[`bot:${b.id}@${name}`]; return it?.needsYou || it?.asking; });
    if (name && waiting && onLocalMachine()) { await selectBot(`${waiting.id}@${name}`); return; }
    if (key && key !== location.origin) switchMachine(key === 'local' ? '' : key);
    return;
  }
  // Another machine's card: opened here, in the inbox, where it can be answered (1.5.41).
  if (what === 'inbox') {
    let machine = key || '';
    try { machine = decodeURIComponent(machine); } catch { /* as it came */ }
    openInbox(machine, kind || '');
    return;
  }
  if (what !== 'chat' || !key) return;
  const [type, id] = key.split(/:(.*)/);
  if (type === 'group' && state.groupId !== id) await openGroup(id);
  if (type === 'bot' && (isGroupMode() || state.botId !== id)) await selectBot(id);
  if (kind === 'takeover') popupTakeover();
};

/** Take over full-window right away, with "done" one click away. */
async function popupTakeover() {
  openPanel('computer');
  await togglePanelMax(true);
  await openDesktopViewer();
  syncDoneButton();
}

/** The bot asked for a takeover or a login. */
function onActionRequest(ev) {
  const key = chatKeyOf(ev);
  if (!key) return;
  const takeover = ev.name === 'request_takeover';
  const args = safeArgs(ev.args) || {};
  const looking = key === currentChatKey() && document.hasFocus();
  // The card says what to do; the screen opens when the human taps 「接管屏幕」 (1.5.26:
  // it went full screen on its own, before they had read why).
  if (looking) return;
  notifyHuman({
    title: takeover ? `${chatName(key)} 需要你接管屏幕` : `${chatName(key)} 需要你填写登录信息`,
    body: takeover ? String(args.reason || '点这里接管') : String(args.name || args.site || '点这里填写'),
    tag: `chat|${key}|${takeover ? 'takeover' : 'login'}`,
  });
}

function onApprovalRequest(ev) {
  const key = chatKeyOf(ev);
  if (!key || (key === currentChatKey() && document.hasFocus())) return;
  notifyHuman({ title: `${chatName(key)} 有个操作等你批准`, body: toolNameLabel(ev.tool || ''), tag: `chat|${key}|approval` });
}

/** "我弄好了，继续" inside the full-window view, while this chat waits for a takeover. */
function syncDoneButton() {
  const btn = $('pc-done');
  if (!btn) return;
  const item = state.attention?.items?.[currentChatKey()];
  btn.classList.toggle('show', item?.waiting?.kind === 'takeover');
}

async function finishTakeover() {
  $('pc-done')?.classList.remove('show');
  if (desktopTakeover()) closeDesktopViewer();
  togglePanelMax(false);
  const input = $('composer');
  input.value = '我弄好了，继续';
  await send();
}

/* --- other models (Settings > 模型, and each bot's model) ----------------------- */
state.models = null;

async function loadModels() {
  try { state.models = await api('/api/models'); } catch { state.models = state.models || { default: null, models: [] }; }
  renderModels();
  return state.models;
}

function defaultModelLabel() {
  const d = state.models?.default || state.settings?.model;
  return d && d.model ? `默认（${d.model}）` : '默认';
}

function providerLabel(name) {
  return (state.providers || []).find((p) => p.name === name)?.label || name;
}

/** The bot's model picker: default, then every extra model. */
/** 朗读声音 in the bot panel: the speech service's voices, "默认" = the machine's choice. */
function renderBotVoiceSelect(bot) {
  const sec = $('botedit-voice-sec');
  const select = $('botedit-voice');
  if (!sec || !select) return;
  const tts = voice.status?.tts || {};
  sec.hidden = !tts.available;
  if (!tts.available) return;
  const voices = tts.voices || [];
  select.innerHTML = voices.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.label)}</option>`).join('');
  // Never picked one: the voice it has been speaking with (the machine's old setting).
  select.value = voices.some((x) => x.id === bot.voice) ? bot.voice : (voices.some((x) => x.id === tts.voice) ? tts.voice : voices[0]?.id || '');
}

function renderBotModelSelect(bot) {
  const select = $('botedit-model');
  if (!select) return;
  const fill = () => {
    const list = state.models?.models || [];
    select.innerHTML = `<option value="">${escapeHtml(defaultModelLabel())}</option>`
      + list.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(`${m.label} · ${providerLabel(m.provider)}${m.hasKey ? '' : '（缺密钥）'}`)}</option>`).join('');
    const known = !bot.model || list.some((m) => m.id === bot.model);
    select.value = known ? (bot.model || '') : '';
    $('botedit-model-note').textContent = !known
      ? '它原来的模型已被删除，现在用默认模型。'
      : list.length ? '没选的话用这台机器的默认模型。' : '想要更多选择：设置 → 模型 → 其他模型。';
  };
  fill();
  Promise.all([ensureProviderOptions(), loadModels()]).then(fill).catch(() => {});
}

function renderModels() {
  const box = $('models-list');
  if (!box) return;
  box.innerHTML = '';
  const list = state.models?.models || [];
  if (!list.length) { box.appendChild(el('div', 'row-note', '还没有其他模型。')); return; }
  for (const m of list) {
    const users = state.bots.filter((b) => b.model === m.id).map((b) => b.name);
    const row = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const title = el('div', 'vault-title');
    title.appendChild(el('b', '', m.label));
    title.appendChild(el('small', '', [providerLabel(m.provider), m.model, m.hasKey ? '' : '缺密钥', users.length ? `在用：${users.join('、')}` : ''].filter(Boolean).join(' · ')));
    head.appendChild(title);
    const key = el('button', 'btn tiny', '换密钥');
    key.type = 'button';
    const del = el('button', 'btn tiny danger', '删除');
    del.type = 'button';
    head.appendChild(key);
    head.appendChild(del);
    row.appendChild(head);
    const form = el('div', 'vault-edit');
    form.hidden = true;
    const input = document.createElement('input');
    input.className = 'field';
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.placeholder = '新的 API 密钥';
    const save = el('button', 'btn primary tiny', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      try { await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'PUT', body: { apiKey: input.value } }); toast('密钥已更新'); loadModels(); } catch (err) { toast(`保存失败：${err.message}`, true); }
    });
    form.appendChild(input);
    form.appendChild(save);
    row.appendChild(form);
    key.addEventListener('click', () => { form.hidden = !form.hidden; });
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = users.length ? '再点一次（在用的助手会改回默认）' : '再点一次删除'; return; }
      try { await api(`/api/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' }); toast(`已删除「${m.label}」`); loadModels(); } catch (err) { toast(`删除失败：${err.message}`, true); }
    });
    box.appendChild(row);
  }
}

/** Provider picked in "添加一个模型": suggest its models and address. */
async function fillModelPreset(changed = false) {
  await ensureProviderOptions();
  const select = $('mp-provider');
  if (!select) return;
  if (!select.options.length) {
    select.innerHTML = (state.providers || []).filter((p) => p.name !== 'mock')
      .map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.label)}</option>`).join('');
    // Start on the default model's provider: there the key can stay empty.
    const def = state.models?.default?.provider || state.settings?.model?.provider;
    if (def && [...select.options].some((o) => o.value === def)) select.value = def;
  }
  const preset = (state.providers || []).find((p) => p.name === select.value);
  if (!preset) return;
  $('mp-suggestions').innerHTML = (preset.models || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  if (changed || !$('mp-baseurl').value) $('mp-baseurl').value = preset.baseUrl || '';
  if (changed || !$('mp-model').value) $('mp-model').value = (preset.models || [])[0] || '';
}

function newModelBody() {
  return {
    provider: $('mp-provider').value,
    model: $('mp-model').value.trim(),
    baseUrl: $('mp-baseurl').value.trim(),
    label: $('mp-label').value.trim(),
    apiKey: $('mp-apikey').value,
  };
}

function modelNote(text, bad = false) {
  const note = $('mp-note');
  note.hidden = !text;
  note.textContent = text;
  note.style.color = bad ? 'var(--danger)' : '';
}

async function testNewModel() {
  modelNote('正在测试…');
  try {
    const r = await api('/api/models/test', { method: 'POST', body: newModelBody() });
    modelNote(r.ok ? `连接正常（${r.latencyMs} ms）` : `连接失败：${r.error?.message || '未知原因'}`, !r.ok);
  } catch (err) { modelNote(`连接失败：${err.message}`, true); }
}

async function saveNewModel() {
  const body = newModelBody();
  if (!body.model) { modelNote('填上模型名', true); return; }
  try {
    const r = await api('/api/models', { method: 'POST', body });
    ['mp-label', 'mp-apikey'].forEach((id) => { $(id).value = ''; });
    modelNote('');
    $('models-add').open = false;
    toast(`已添加「${r.model.label}」，可以在助手设置里选它了`);
    loadModels();
  } catch (err) { modelNote(`保存失败：${err.message}`, true); }
}

/* --- one key, several models (1.5.10) -------------------------------------------
   "列出这个密钥能用的模型" reads what the provider offers for that key; tick
   any number and they are added as separate models with the same key, then
   shared with every machine like the rest of the model settings. */
async function listKeyModels() {
  const b = newModelBody();
  const btn = $('mp-list');
  btn.disabled = true;
  modelNote('正在向服务商读取…');
  try {
    const r = await api('/api/providers/models', { method: 'POST', body: { provider: b.provider, baseUrl: b.baseUrl, apiKey: b.apiKey } });
    state.mpOptions = (r.models || []).map(String);
    state.mpPicked = new Set();
    $('mp-pick').hidden = false;
    $('mp-filter').value = '';
    renderModelPicks();
    modelNote(r.live ? `这个密钥能用 ${state.mpOptions.length} 个模型，勾选要添加的（可以多选）。` : `没读到实时列表（${r.error || '未知原因'}），先列出常用的。`, !r.live);
  } catch (err) {
    modelNote(`读取失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderModelPicks() {
  const box = $('mp-options');
  if (!box) return;
  const provider = $('mp-provider').value;
  const have = new Set((state.models?.models || []).filter((m) => m.provider === provider).map((m) => m.model));
  const q = $('mp-filter').value.trim().toLowerCase();
  const shown = (state.mpOptions || []).filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 300);
  box.innerHTML = '';
  if (!shown.length) box.appendChild(el('div', 'row-note', '没有符合的模型。'));
  for (const name of shown) {
    const row = el('label', 'mp-option');
    const box2 = document.createElement('input');
    box2.type = 'checkbox';
    box2.checked = have.has(name) || state.mpPicked.has(name);
    box2.disabled = have.has(name);
    box2.addEventListener('change', () => {
      if (box2.checked) state.mpPicked.add(name); else state.mpPicked.delete(name);
      updatePickButton();
    });
    row.appendChild(box2);
    row.appendChild(el('span', 'mp-name', name));
    if (have.has(name)) row.appendChild(el('span', 'tag', '已添加'));
    box.appendChild(row);
  }
  updatePickButton();
}

function updatePickButton() {
  const n = state.mpPicked?.size || 0;
  const btn = $('mp-add-picked');
  btn.disabled = !n;
  btn.textContent = n ? `添加选中的 ${n} 个模型` : '添加选中的模型';
}

async function addPickedModels() {
  const b = newModelBody();
  const picked = [...(state.mpPicked || [])];
  if (!picked.length) return;
  const btn = $('mp-add-picked');
  btn.disabled = true;
  const failed = [];
  for (const [i, model] of picked.entries()) {
    modelNote(`正在添加 ${i + 1}/${picked.length}：${model}`);
    try {
      await api('/api/models', { method: 'POST', body: { provider: b.provider, baseUrl: b.baseUrl, apiKey: b.apiKey, model, label: model } });
    } catch (err) {
      failed.push(`${model}（${err.message}）`);
    }
  }
  state.mpPicked = new Set();
  await loadModels();
  renderModelPicks();
  const added = picked.length - failed.length;
  // Shared with every machine, like any change to the model settings.
  let synced = '';
  if (added && machineBridge?.local && (machineBridge.machines || []).length && window.desk?.syncModel) {
    modelNote(`已添加 ${added} 个，正在同步到所有机器…`);
    const res = await window.desk.syncModel().catch((err) => ({ ok: false, error: err.message }));
    synced = res?.ok ? '，并同步到了所有机器' : `；同步到其他机器失败：${res?.error || '未知原因'}`;
  }
  modelNote(failed.length ? `添加了 ${added} 个${synced}；没成功：${failed.join('、')}` : `添加了 ${added} 个模型${synced}。可以在每个助手的设置里给它选一个。`, Boolean(failed.length));
  if (added) $('mp-apikey').value = '';
}

/* --- Feishu (Settings > 飞书) ------------------------------------------------- */
async function loadFeishu() {
  const v = await api('/api/feishu');
  renderFeishu(v);
  loadFeishuApps().catch(() => { /* older server: no apps of their own */ });
  return v;
}

/* Feishu apps of their own, one bot each (Notion §97.6 I2). */
async function loadFeishuApps() {
  const { apps } = await api('/api/feishu/apps');
  renderFeishuApps(apps || []);
  // the bots to choose from: this machine, then the other machines
  const select = $('feishu-app-bot');
  if (select && !select.dataset.filled) {
    select.dataset.filled = '1';
    select.innerHTML = state.bots.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}（这台机器）</option>`).join('');
    api('/api/peers/bots').then((r) => {
      for (const m of r.machines || []) for (const b of m.bots || []) {
        select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(`${b.id}@${m.machine}`)}">${escapeHtml(b.name)}（${escapeHtml(m.machine)}）</option>`);
      }
    }).catch(() => {});
  }
  return apps;
}

function renderFeishuApps(apps) {
  const list = $('feishu-apps');
  if (!list) return;
  list.innerHTML = '';
  if (!apps.length) { list.appendChild(el('div', 'row-note', '还没有。')); return; }
  for (const a of apps) {
    const row = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const title = el('div', 'vault-title');
    title.appendChild(el('b', '', `${a.name}（${a.machine || '这台机器'}）`));
    const status = a.connected ? `已连接 · 配对了 ${(a.users || []).length} 人` : !a.enabled ? '没有启用' : a.error ? `没连上：${a.error}` : '正在连接…';
    title.appendChild(el('small', '', `${status} · 配对码 ${a.pairCode || '——'}`));
    head.appendChild(title);
    const code = el('button', 'btn tiny', '换配对码');
    code.type = 'button';
    code.addEventListener('click', async () => {
      try { await api(`/api/feishu/apps/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { newPairCode: true } }); await loadFeishuApps(); } catch (err) { toast(err.message, true); }
    });
    head.appendChild(code);
    const del = el('button', 'btn tiny danger', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '再点一次删除'; return; }
      try { await api(`/api/feishu/apps/${encodeURIComponent(a.id)}`, { method: 'DELETE' }); await loadFeishuApps(); toast('已删除'); } catch (err) { toast(err.message, true); }
    });
    head.appendChild(del);
    row.appendChild(head);
    list.appendChild(row);
  }
}

async function addFeishuApp() {
  const body = { bot: $('feishu-app-bot').value, appId: $('feishu-app-id').value.trim(), appSecret: $('feishu-app-secret').value.trim() };
  if (!body.bot || !body.appId || !body.appSecret) { toast('先选机器人，再填 App ID 和 App Secret', true); return; }
  try {
    await api('/api/feishu/apps', { method: 'POST', body });
    $('feishu-app-id').value = '';
    $('feishu-app-secret').value = '';
    $('feishu-app-add').open = false;
    toast('已添加，正在连接飞书…');
    for (let i = 0; i < 20; i += 1) {
      const apps = await loadFeishuApps().catch(() => null);
      if (!apps || apps.every((a) => a.connected || a.error || !a.enabled)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) { toast(`添加失败：${err.message}`, true); }
}

function renderFeishu(v) {
  const status = $('feishu-status');
  if (!status || !v) return;
  status.className = `feishu-status${v.connected ? ' ok' : v.error ? ' bad' : ''}`;
  status.textContent = v.connected ? `已连接飞书 · 配对了 ${v.users.length} 人`
    : !v.enabled ? '没有启用。'
      : v.error ? `没连上：${v.error}` : '正在连接…';
  if (document.activeElement !== $('feishu-appid')) $('feishu-appid').value = v.appId || '';
  $('feishu-secret').value = '';
  $('feishu-secret').placeholder = v.hasSecret ? '已保存（留空不改）' : '';
  $('feishu-enabled').checked = Boolean(v.enabled);
  const select = $('feishu-bot');
  select.innerHTML = '<option value="">主助理</option>' + state.bots.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('');
  select.value = v.botId || '';
  $('feishu-code').textContent = v.pairCode || '——';
  if (!v.appId) $('feishu-guide').open = true;
  const list = $('feishu-users');
  list.innerHTML = '';
  for (const u of v.users || []) {
    const row = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const title = el('div', 'vault-title');
    title.appendChild(el('b', '', '飞书用户'));
    title.appendChild(el('small', '', `${u.openId.slice(0, 10)}… · ${u.since ? new Date(u.since).toLocaleDateString() : ''}`));
    head.appendChild(title);
    const del = el('button', 'btn tiny danger', '解除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '再点一次解除'; return; }
      try { renderFeishu(await api('/api/feishu/unpair', { method: 'POST', body: { openId: u.openId } })); } catch (err) { toast(err.message, true); }
    });
    head.appendChild(del);
    row.appendChild(head);
    list.appendChild(row);
  }
}

async function saveFeishu() {
  const body = {
    appId: $('feishu-appid').value.trim(),
    botId: $('feishu-bot').value,
    enabled: $('feishu-enabled').checked,
  };
  const secret = $('feishu-secret').value.trim();
  if (secret) body.appSecret = secret;
  if (body.enabled && (!body.appId || (!secret && !($('feishu-secret').placeholder || '').includes('已保存')))) { toast('先填 App ID 和 App Secret', true); return; }
  try {
    renderFeishu(await api('/api/feishu', { method: 'PUT', body }));
    toast(body.enabled ? '已保存，正在连接飞书…' : '已保存');
    // Keep the status honest until it settles: connected, or a reason it is not.
    if (body.enabled) {
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        const v = await loadFeishu().catch(() => null);
        if (!v || v.connected || v.error) break;
      }
    }
  } catch (err) { toast(`保存失败：${err.message}`, true); }
}

/* --- vault (Settings > 保险箱, and the login card in chat) --------------------- */
state.vault = null;

async function loadVault() {
  try { state.vault = (await api('/api/vault')).entries || []; } catch { state.vault = state.vault || []; }
  renderVault();
  return state.vault;
}

const isSecretLabel = (label) => /密码|password|口令|pin|passcode/i.test(String(label));

function renderVault() {
  const list = $('vault-list');
  if (!list) return;
  list.innerHTML = '';
  const entries = state.vault || [];
  if (!entries.length) { list.appendChild(el('div', 'row-note', '保险箱是空的。机器人需要登录时会请你填，也可以在下面先添加。')); return; }
  for (const entry of entries) {
    const row = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const title = el('div', 'vault-title');
    title.appendChild(el('b', '', entry.name));
    title.appendChild(el('small', '', [entry.site ? hostOfUrl(entry.site) : '', (entry.fields || []).join('、')].filter(Boolean).join(' · ')));
    head.appendChild(title);
    const edit = el('button', 'btn tiny', '更新');
    edit.type = 'button';
    const del = el('button', 'btn tiny danger', '删除');
    del.type = 'button';
    head.appendChild(edit);
    head.appendChild(del);
    row.appendChild(head);
    const form = el('div', 'vault-edit');
    form.hidden = true;
    for (const label of entry.fields || []) {
      const input = document.createElement('input');
      input.className = 'field';
      input.dataset.label = label;
      input.placeholder = `${label}（留空不改）`;
      if (isSecretLabel(label)) { input.type = 'password'; input.autocomplete = 'new-password'; }
      form.appendChild(input);
    }
    const save = el('button', 'btn primary tiny', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      const values = {};
      form.querySelectorAll('input[data-label]').forEach((i) => { if (i.value) values[i.dataset.label] = i.value; });
      if (!Object.keys(values).length) { toast('没有要改的内容'); return; }
      try { await api(`/api/vault/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { values } }); toast(`已更新「${entry.name}」`); loadVault(); } catch (err) { toast(`保存失败：${err.message}`, true); }
    });
    form.appendChild(save);
    row.appendChild(form);
    edit.addEventListener('click', () => { form.hidden = !form.hidden; });
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '再点一次删除'; return; }
      try { await api(`/api/vault/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }); toast(`已删除「${entry.name}」`); loadVault(); } catch (err) { toast(`删除失败：${err.message}`, true); }
    });
    list.appendChild(row);
  }
}

/* ---------------------------------------------------------------------
   直连 (1.5.46): the phone app reaches a computer directly when it can,
   the relay only introducing them (src/direct.mjs, DirectChannel.java).
   The relay card (11-machines.js) and the route words use these.
   --------------------------------------------------------------------- */
/**
 * 直连 (1.5.46): does the phone app reach this computer (its forwarder URL, or
 * a relay id) over the direct channel right now? 'direct' | 'relay' | ''.
 */
function phoneRelayRoute(urlOrId) {
  try {
    const shell = window.NightshiftShell;
    return shell && typeof shell.relayRoute === 'function' ? String(shell.relayRoute(String(urlOrId || '')) || '') : '';
  } catch {
    return '';
  }
}

/**
 * 关于 → 「手机到这台」 (1.5.48): in the phone app, through its forwarder, one
 * line from the app itself - the road (直连 · 局域网 / 中转), whether it is trying,
 * the last reason, the next try. No addresses. Elsewhere the row stays hidden.
 */
function renderPhoneRoad() {
  const row = $('about-road-row');
  if (!row) return;
  let line = '';
  try {
    const shell = window.NightshiftShell;
    if (throughPhoneRelay() && typeof shell?.relayDebug === 'function') line = String(shell.relayDebug(location.origin) || '');
  } catch { line = ''; }
  row.hidden = !line;
  if (line && $('about-road')) $('about-road').textContent = line;
}

/**
 * The desktop window's door to a machine only the relay reaches (127.0.0.N,
 * 1.5.47): its requests go direct when they can. Ask that machine how this
 * page's requests arrive, at most once a minute, so the route says 直连 then.
 */
function refreshDoorRoute() {
  const h = location.hostname;
  // The phone app's forwarder too (1.5.48): whether this machine hosts the relay itself.
  const door = /^127\.0\.0\.\d+$/.test(h) && h !== '127.0.0.1';
  if ((!door && !throughPhoneRelay()) || Date.now() - (state.doorRouteAt || 0) < 60000) return;
  state.doorRouteAt = Date.now();
  api('/api/direct/route').then((r) => {
    const route = door ? r?.route : state.doorRoute;
    if ((route && route !== state.doorRoute) || Boolean(r?.relayHere) !== Boolean(state.relayHere)) {
      state.doorRoute = route;
      state.relayHere = Boolean(r?.relayHere);
      syncMachineBranding();
      renderMachineMenu();
    }
  }).catch(() => {});
}

/**
 * The relay updating itself (1.5.47), in words for the relay card: what it
 * runs, that it updated, why it did not, or that it needs one last manual
 * 「重装」 (a relay from before 1.5.47). '' while there is nothing to say yet.
 */
function relayUpdateWords(view) {
  const r = view?.relay;
  const newer = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  if ((!r && view?.relayOld) || (r && !r.auto)) return '这个中转还不会自己更新：再点一次下面的「重装 / 换端口」（最后一次手动），以后它会跟着 Lamplit 自己更新。';
  if (!r) return '';
  const offer = view.relayUpdate?.version;
  // A failure counts only for a version newer than what runs (1.5.51: 「1.5.49 没能正常启动」
  // stayed while 1.5.50 ran). An older one means the relay moved on: say it updated.
  const failed = r.last && !r.last.ok && newer(r.last.version, r.version) ? r.last : null;
  const movedOn = r.last && (r.last.ok ? r.last.version === r.version : !failed);
  // A failed version, unless a newer one is on its way (1.5.50: 1.5.49 failed, 1.5.50 fixes it - say that one).
  if (failed && !(offer && newer(offer, failed.version))) return `中转这次没有更新：${failed.reason}。现在用的是 ${r.version}，照常能用。`;
  if (offer && newer(offer, r.version)) return r.fetching ? `中转正在更新到 ${offer}…` : `中转会自己更新到 ${offer}（几分钟内）。`;
  if (movedOn) return `中转已更新到 ${r.version}，以后也会自己更新。`;
  return `中转是最新的（${r.version}），以后会自己更新。`;
}

/**
 * Why the relay's new version did not start (1.5.50), folded under the card's
 * update line: the last lines it printed, addresses already taken out. Stays
 * open across the card's refreshes once opened.
 */
function relayFailureNode(view) {
  const last = view?.relay?.last;
  if (!view?.enabled || view.state !== 'online' || !last || last.ok || !last.detail) return null;
  if (!/没有更新/.test(relayUpdateWords(view))) return null;
  const box = document.createElement('details');
  box.className = 'relay-why';
  box.open = Boolean(state.relayWhyOpen);
  box.addEventListener('toggle', () => { state.relayWhyOpen = box.open; });
  box.appendChild(el('summary', '', '看原因（中转最后打印的几行）'));
  box.appendChild(el('pre', '', last.detail));
  return box;
}

/** 直连 (1.5.46) in the relay card, in words: on or off, working or why not. */
function directWords(d, port) {
  const base = directWordsBase(d, port);
  if (!d || d.enabled === false || d.active > 0 || d.stun === 'no') return base;
  // Something on this computer is in the way (1.5.49 beginner test): what to do, in order -
  // not the generic 「多半是两边的网络…」, not the same cause twice.
  const steps = directSteps(d);
  if (steps.length) {
    const lead = d.last === 'failed' ? '刚才试过直连，没打通，现在走中转（能用）。这台电脑上有东西挡着，' : '直连还没试过。为了能打通，先在这台电脑上';
    const list = steps.length > 1 ? `按顺序做：${steps.map((s, i) => `${'①②③'[i]} ${s}`).join('；')}` : `这样做：${steps[0]}`;
    return `${lead}${list}。`;
  }
  // Nothing found here: what the last try saw, when it says more than the base line.
  if (d.last === 'failed' && /no probe arrived/.test(d.lastFailure || '')) return '刚才试过直连，没打通，现在走中转（能用）。对方的探测包一个也没到这台电脑：多半是防火墙或代理挡住了 UDP。';
  if (d.last === 'failed' && /probes arrived/.test(d.lastFailure || '')) return '刚才试过直连，没打通，现在走中转（能用）。对方的探测包到了，但这台电脑发出去的没有回音：多半是对方那边的网络限制，换个网络会再试。';
  return base;
}

/**
 * What to do on this computer so direct gets through (1.5.49), in order:
 * Windows Firewall first, then a proxy's TUN (or, if it must stay on, the
 * rule that worked for Tailscale's UDP on the user's PC 11-17: by process
 * name, first; port and IP rules did not). An address that differs with no
 * TUN seen means a proxy all the same. Plain words; nothing is changed here.
 */
function directSteps(d) {
  if (state.firewall === undefined && window.desk?.firewallStatus && onLocalMachine()) {
    state.firewall = null; // asked once; the card is drawn again when the answer is in
    window.desk.firewallStatus().then((fw) => { state.firewall = fw || null; renderTunnel(false); }).catch(() => {});
  }
  const out = [];
  const fw = state.firewall;
  if (fw?.applies && fw.known && fw.udp?.known && !fw.udp.ok) out.push('Windows 防火墙挡住了直连用的 UDP：在「设置 → 体检」里点「修复防火墙」');
  const tun = (d.tun || []).length ? `（${d.tun.join('、')}）` : '';
  if (tun || d.addressHint === 'differ') out.push(`这台电脑开着代理${tun}，直连的 UDP 会被它绕走：暂时关掉 Clash 的 TUN 模式；要一直开着的话，在 Clash 规则的最前面加一条 PROCESS-NAME,Lamplit.exe,DIRECT，保存后重启 Lamplit`);
  return out;
}

function directWordsBase(d, port) {
  if (!d || d.enabled === false) return '「先试直连」关着：手机在外面都走中转。';
  // The relay can answer but UDP does not get through: only the firewall rule is missing (1.5.47 beginner test).
  if (d.stun === 'no' && d.stunCause === 'firewall') return `现在都走中转，能用。想直连，还差一步：到云服务器控制台的「防火墙」（或「安全组」）加一条 UDP ${port} 的规则。`;
  if (d.stun === 'no') return `现在都走中转，能用。想直连，中转要更新一次：点下面的「重装 / 换端口」，装完再到云服务器控制台加一条 UDP ${port} 的规则。`;
  // Who, by name (1.5.48: the PC said a device was direct; it was another machine, not the phone).
  if (d.active > 0) return `直连中：${(d.holders || []).map((h) => h.name).join('、') || `${d.active} 台设备`}直接连着这台电脑，数据不经过中转。`;
  // The latest try first (1.5.46 beginner test: after one success, a later failure was never said).
  if (d.last === 'failed') return '刚才试过直连，没打通，都走中转（能用）。多半是两边的网络不让直接连，换个网络会再试。';
  if (d.up > 0) return '以前直连成功过，现在没有设备直连。手机在外面连这台电脑时会再试。';
  return '还没有设备试过直连：手机在外面连这台电脑时会自动试。';
}

/** 「先试直连」 on or off (1.5.46). Off closes the direct links; the relay carries on. */
async function setDirect(on) {
  try {
    await api('/api/relay-link', { method: 'PUT', body: { direct: on } });
  } catch (err) {
    toast(err.message || String(err), true);
  }
  renderTunnel();
}
