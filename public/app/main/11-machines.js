'use strict';
// Lamplit page, part 11 of 12: machines. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   machines
   A machine is one Desk server with its own bots, memory, workspace and
   screens. The window shows exactly one machine; the desktop shell
   (window.desk) switches by pointing the window at another server. In a plain
   browser or on a phone there is no list: you are on the machine you opened.
   --------------------------------------------------------------------- */
let viewerUrl = '';
/** {current, local, machines:[{url,name}]} from the desktop shell, or null. */
let machineBridge = null;
/** This hub's own hostname (browser / phone, where there is no bridge). */
let selfMachineName = '';

function onLocalMachine() {
  // In the phone app, 127.0.0.1:14440-14499 is its relay forwarder: another machine, not this one.
  if (throughPhoneRelay()) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(location.origin);
}

/**
 * The way from here to another machine, in words: the first of its addresses
 * that answers (LAN or public, then Tailscale), else 「中转」 when it has a relay
 * address and the phone app can use it, else 「连不上」.
 */
async function routeWords(m) {
  const lanLike = (u) => { try { return !isPublicAddress(new URL(u).hostname); } catch { return false; } };
  // Only what this phone can use now, all at once (1.5.39: one by one, each
  // dead address cost 4 s and the menu said 检测中… for up to 8 s).
  const tries = [m.url, m.tailnetUrl].filter((u) => u && phoneCanUse(u));
  // With a relay the app can use, an address that has not answered in 1 s is not the way.
  const viaRelay = Boolean(m.relay && window.NightshiftShell?.openMachine);
  const first = await firstReachable(tries, viaRelay ? 1000 : 4000);
  if (first && first === m.url) return lanLike(m.url) ? '局域网' : '外网';
  if (first) return 'Tailscale';
  if (viaRelay) return { 'direct-lan': '局域网', direct: '直连' }[phoneRelayRoute(m.relay.id)] || '中转';
  return '连不上';
}

/** A page the phone app opened through its relay forwarder (RelayLinks: 127.0.0.1:14440-14499). */
function throughPhoneRelay(origin = location.origin) {
  try {
    const u = new URL(origin);
    const port = Number(u.port);
    return Boolean(window.NightshiftShell) && u.hostname === '127.0.0.1' && port >= 14440 && port <= 14499;
  } catch {
    return false;
  }
}

function machineDisplayName() {
  // This computer by its own name (「客厅电脑」), not 「本机」 (1.5.42; the step-two test).
  if (onLocalMachine()) return selfMachineName || state.health?.name || '这台电脑';
  // The machine the desktop app switched to, whatever address this page came on
  // (through the relay it is a loopback door, 127.0.0.N: 1.5.37).
  const row = machineBridge?.machines?.find((m) => m.url === location.origin || m.tailnetUrl === location.origin)
    || (machineBridge?.current ? machineBridge.machines?.find((m) => m.url === machineBridge.current) : null);
  // Through the phone's relay forwarder the address is 127.0.0.1: a name, or nothing yet.
  return row?.name || selfMachineName || state.computer?.host?.hostname || (throughPhoneRelay() ? '' : location.hostname);
}

/** How this page reached its machine, in words: 局域网 (1.5.48: a direct path inside the home network too) / 直连 / 中转 (the desktop's door 127.0.0.N or the phone's forwarder), Tailscale (100.x), else the host name. */
function pageRouteWords() {
  const h = location.hostname;
  if (throughPhoneRelay() && phoneRelayRoute(location.origin) === 'direct-lan') return '局域网';
  if ((throughPhoneRelay() && phoneRelayRoute(location.origin) === 'direct') || state.doorRoute === 'direct') return '直连';
  if (throughPhoneRelay() || (/^127\.0\.0\.\d+$/.test(h) && h !== '127.0.0.1')) return state.relayHere ? '经中转（中转就在这台上）' : '中转'; // 1.5.48: on purpose there
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'Tailscale';
  if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/.test(h)) return '局域网';
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(h)) return '这台电脑'; // not its address (1.5.59 beginner test)
  return h;
}

/** Everything that names "where am I": switcher, account chip, About. */
function syncMachineBranding() {
  const local = onLocalMachine();
  const name = machineDisplayName();
  const host = state.computer?.host;
  const os = host ? (host.platform === 'win32' ? 'Windows' : host.platform === 'linux' ? 'Linux' : host.platform) : '';
  // 全部机器 is titled so wherever the page runs (1.5.48: the phone app showed the page's own machine, 腾讯云).
  const grouped = rosterGrouped() && !singleVisit(); if ($('machine-name')) $('machine-name').textContent = grouped ? '全部机器' : name;
  if ($('pc-title')) $('pc-title').textContent = `${name}的屏幕`;
  if (state.settingsOpen && (!isMobile() || $('settings-drawer')?.classList.contains('set-home'))) $('settings-title').textContent = settingsTitle(); // its name came later
  if ($('machine-sub')) {
    $('machine-sub').innerHTML = `<i class="machine-dot"></i>${escapeHtml(grouped ? `${(state.peerRoster || []).length + 1} 台 · 这台是 ${name}` : local && !singleVisit() ? '这台电脑' : [os, singleVisit() && '只看这台', (!singleVisit() || throughPhoneRelay() || state.doorRoute) && pageRouteWords()].filter(Boolean).join(' · '))}`; // 1.5.48: 只看这台 in the app says the road too
  }
  if ($('about-origin')) $('about-origin').textContent = location.origin;
  if ($('timezone-pill')) $('timezone-pill').textContent = timezoneLabel(effectiveTimezone());
  if ($('composer-hint') && !remoteChatMachine()) { // a remote chat's own hint stays (1.5.42)
    $('composer-hint').textContent = local
      ? '需要动你电脑的操作，会先问过你'
      : `在「${name}」上，助手会自己把事情做完`;
  }
}

/** Every machine this client can switch to, for the bots to see. */
function knownMachines() {
  if (!machineBridge) return [];
  return [{ name: machineBridge.localName || '这台电脑', url: 'local', current: Boolean(machineBridge.local) }]
    .concat((machineBridge.machines || []).map((m) => ({ name: m.name, url: m.url, current: m.url === machineBridge.current })));
}

/** A bot asked to move the work to another machine: switch, and carry the task. */
async function switchMachineFor({ target, message }) {
  const wanted = String(target || '').trim().toLowerCase();
  const match = knownMachines().find((m) => m.url.toLowerCase() === wanted || m.name.toLowerCase() === wanted)
    || knownMachines().find((m) => m.name.toLowerCase().includes(wanted) || m.url.toLowerCase().includes(wanted));
  if (!match || !window.desk) { toast(`找不到机器「${target}」`, true); return; }
  if (match.current) return;
  toast(`正在切换到「${match.name}」…`);
  const text = String(message || '').trim();
  const res = match.url === 'local' ? await window.desk.useLocal(text) : await window.desk.switchHub(match.url, text);
  if (!res?.ok) toast(res?.error || '切换失败', true);
}

/** Work handed over from another machine: give it to this machine's primary bot. */
async function deliverPendingTask() {
  let text = '';
  try { const got = await window.desk?.takePendingMessage?.(); text = typeof got === 'string' ? got.trim() : ''; } catch { return; } // a refused call is an object, never a message (1.5.57: it was sent as 「[object Object]」)
  if (!text) return;
  const primary = state.bots.find((b) => b.primary) || state.bots[0];
  if (!primary) return;
  if (state.groupId || state.botId !== primary.id) await selectBot(primary.id);
  const input = $('composer');
  input.value = text;
  await send();
}

async function refreshMachines() {
  try { machineBridge = window.NightshiftShell ? null : (await window.desk?.listMachines?.()) || null; } catch { machineBridge = null; } // 1.5.48: never the desktop's menu (「这台电脑」) inside the phone app
  // Its own name first, at once (the desktop app too, 1.5.42: the top left names it); the full list waits for the others to be probed.
  if (!selfMachineName) {
    api('/api/machines?self=1').then((data) => {
      const mine = (data?.machines || []).find((m) => m.self);
      if (mine?.name && !selfMachineName) { selfMachineName = mine.name; syncMachineBranding(); renderMachineMenu(); }
    }).catch(() => {});
  }
  // Browser / phone: no desktop bridge, but the hub knows its own hostname, so
  // the sidebar can say "ubuntu" instead of "100.64.0.5".
  if (!machineBridge) {
    try {
      const data = await api('/api/machines');
      state.machinesCache = { at: Date.now(), machines: data?.machines || [] };
      const mine = (data?.machines || []).find((m) => m.self);
      if (mine?.name) selfMachineName = mine.name;
    } catch {
      /* offline: keep whatever we had */
    }
  }
  if (state.ready) reportUiState();
  syncMachineBranding();
  renderMachineMenu();
  if ($('settings-drawer')?.classList.contains('open')) renderMachinesList();
  return machineBridge;
}

async function switchMachine(url) {
  closeMenus();
  if (!window.desk) return;
  const name = url ? ((machineBridge?.machines || []).find((m) => m.url === url)?.name || '那台机器') : (machineBridge?.localName || '这台电脑');
  // Say something at once: reaching a machine can take a few seconds.
  toast(`正在切换到「${name}」…`);
  const res = url ? await window.desk.switchHub(url) : await window.desk.useLocal();
  if (!res?.ok) toast(res?.error || '切换失败', true);
}

/** Sidebar dropdown: every machine, plus "添加机器". */
function renderMachineMenu() {
  const menu = $('machine-menu');
  if (!menu) return;
  if (!machineBridge) {
    // Browser / phone: the hub knows the machines, and can hand out a one-time
    // link into one of them. Same list as Settings → 机器, one line each - plus
    // the machine we were switched away from, so the way back is the same list
    // instead of a separate button.
    const list = (state.machinesCache && state.machinesCache.machines) || [];
    let back = cameFromMachine();
    // The phone app's relay forwarder is a way to a machine, not a machine (1.5.37):
    // that machine is in the list below already.
    if (back && throughPhoneRelay(back.origin)) back = null;
    // Every machine now lists every other one, so the machine we came from is
    // usually in the list already (by name, or by one of its addresses): one row.
    if (back) {
      const origins = (m) => [m.url, m.tailnetUrl].filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return ''; } });
      if (list.some((m) => (back.name && m.name === back.name) || origins(m).includes(back.origin))) back = null;
    }
    // The way back is rendered exactly like any other machine row: name, an
    // "离线" tag when it does not answer, and its address. No arrow, no label -
    // it is just one more machine in the list.
    // Each machine in a few words too (1.5.59): what it is for, its bots, what waits and works there.
    const row = (name, address, { off = false, current = false, attrs = '', key = '', meta = '', dot = false } = {}) => `
      <button type="button" role="menuitem" class="mm-item ${current ? 'current' : ''}" ${attrs} ${key ? `data-row="${escapeHtml(key)}"` : ''}>
        <b>${dot ? `<i class="mm-dot ${off ? 'off' : 'on'}"></i>` : ''}${escapeHtml(name)}</b>${off ? '<small class="off">离线</small>' : ''}
        <small>${escapeHtml(address)}</small>${meta}
      </button>`;
    // Inside the Lamplit phone app: the way back to the app's own machine list
    // (the Back key does the same, but nobody sees a key; 第 2 步, seen on a phone).
    const appList = typeof window.NightshiftShell?.showMachines === 'function'
      ? '<div class="menu-sep"></div><button type="button" role="menuitem" data-app-machines="1">返回 App 的机器列表</button>'
      : '';
    if (!list.length && !back) {
      menu.innerHTML = `<button type="button" disabled>正在读取机器列表…</button>${appList}`;
      return;
    }
    const rows = [];
    if (back) rows.push(row(back.name || back.origin.replace(/^https?:\/\//, ''), back.origin, {
      attrs: `data-back-origin="${escapeHtml(back.origin)}"`,
      key: 'origin',
    }));
    // 「全部机器」 (1.5.42): every machine's bots in this sidebar; this machine alone is its own row.
    // Opened by name from another machine (1.5.44): 「全部机器」 is the way back there.
    if (list.some((m) => !m.self) || (singleVisit() && canGoHome())) rows.push(row('全部机器', singleVisit() ? '回到全部机器' : '每台机器上的助手都在左边', { current: state.view === 'all', attrs: 'data-view="all"' }));
    for (const m of list) {
      rows.push(
        m.self
          ? row(m.name, list.some((x) => !x.self) ? `${selfSub()} · 只看这台` : selfSub(), { current: state.view !== 'all' || !list.some((x) => !x.self), attrs: 'data-view="local"', meta: machineOverviewHtml(m.name), dot: true })
          : row(m.name, '检测中…', { off: !m.online, attrs: `data-handoff-menu="${escapeHtml(m.name)}"`, meta: machineOverviewHtml(m.name), dot: true }),
      );
    }
    const add = /* 添加 from here too (1.5.54) */ onLocalMachine() && !window.NightshiftShell ? '<div class="menu-sep"></div><button type="button" role="menuitem" data-machine-add="1">添加一台机器…</button>' : '';
    menu.innerHTML = rows.join('') + add + appList;
    // How this phone or browser would get there, in words (局域网 / Tailscale /
    // 中转), not an address: 127.x, 100.x and IP:port meant nothing (1.5.37).
    for (const m of list.filter((x) => !x.self)) {
      const small = [...menu.querySelectorAll('[data-handoff-menu]')].find((b) => b.dataset.handoffMenu === m.name)?.querySelector('small:not(.off):not(.mm-meta)');
      // Off already says 离线: not 「连不上」 next to it (1.5.59 beginner test).
      if (small) void routeWords(m).then((words) => { if (small.isConnected) small.textContent = !m.online && words === '连不上' ? '' : words; });
    }
    // The machine we came from is not a peer of this hub, so its state is unknown:
    // probe it once and mark it 离线 if it does not answer.
    if (back) {
      const rowNode = menu.querySelector('[data-row="origin"]');
      reachable(back.origin).then((ok) => {
        if (ok || !rowNode) return;
        const tag = document.createElement('small');
        tag.className = 'off';
        tag.textContent = '离线';
        rowNode.querySelector('b')?.after(tag);
      });
    }
    return;
  }
  const others = machineBridge.machines || [];
  const rows = [];
  // 「全部机器」 (1.5.42): the default - this computer's window, every machine's bots in its sidebar.
  if (others.length) rows.push({ view: 'all', name: '全部机器', sub: '每台机器上的助手都在左边', current: Boolean(machineBridge.local) && state.view === 'all' });
  rows.push({ url: '', view: 'local', name: machineBridge.localName || (machineBridge.local ? machineDisplayName() : '这台电脑'), sub: others.length ? '这台电脑 · 只看这台' : '这台电脑', current: Boolean(machineBridge.local) && (state.view !== 'all' || !others.length) });
  for (const m of others) {
    // How it is reached, in words (中转 / Tailscale / 局域网) for the one on screen; never an address.
    const route = m.url === machineBridge.current ? pageRouteWords() : '';
    rows.push({ url: m.url, name: m.name, sub: /^(中转|经中转|直连|Tailscale|局域网)/.test(route) ?`${route} · 只看这台` : '只看这台', current: m.url === machineBridge.current });
  }
  menu.innerHTML = rows.map((m) => `
    <button type="button" role="menuitem" class="mm-item ${m.current ? 'current' : ''}" ${m.url !== undefined ? `data-machine="${escapeHtml(m.url)}"` : ''} ${m.view ? `data-view="${m.view}"` : ''}>
      <b>${escapeHtml(m.name)}</b>${m.url !== undefined ? machineAttLabel(m.url) : ''}<small>${escapeHtml(m.sub)}</small>${m.view === 'all' ? '' : machineOverviewHtml(m.name)}
    </button>`).join('')
    + '<div class="menu-sep"></div><button type="button" role="menuitem" data-machine-add="1">添加一台机器…</button>';
}

/** Settings → 机器: one row each, switch / rename / remove. */
/** Settings → 机器 → 手机: the phones on this machine's adb (1.3.0). */
async function renderPhoneBox() {
  const list = $('phone-list');
  if (!list) return;
  const local = onLocalMachine();
  let data;
  try { data = await api('/api/phone'); } catch (err) { list.innerHTML = `<div class="machine-empty">${escapeHtml(err.message)}</div>`; return; }
  // Where adb is: only in the desktop app on this computer (a phone cannot set it; 1.5.29).
  $('phone-adb-row').hidden = !(local && window.desk && !isMobile());
  // On the phone itself, the cable way is not the one to explain.
  if ($('phone-usb-note')) $('phone-usb-note').hidden = Boolean(window.NightshiftShell);
  if ($('phone-adb') && document.activeElement !== $('phone-adb')) $('phone-adb').value = data.adb?.configured || data.adb?.path || '';
  renderPhoneAgentRow();
  if (!(data.devices || []).length) {
    const how = '在手机上的 Lamplit 里打开「让机器人用这部手机」（不用数据线），或者用数据线连这台电脑、打开 USB 调试。';
    list.innerHTML = `<div class="machine-empty">${escapeHtml(data.error || (data.adb?.found ? `没有能用的手机。${how}` : `没有能用的手机。${how}${local ? '用数据线的话，这台电脑要装好 adb（Android platform-tools），或在下面填 adb.exe 的位置。' : ''}`))}</div>`;
    return;
  }
  list.innerHTML = data.devices.map((d) => {
    const via = d.via === 'app' ? '通过 Lamplit App（不用数据线）' : '数据线';
    const sub = d.state === 'unauthorized' ? '还没允许这台电脑：解锁手机，在弹窗里点「允许」'
      : d.state !== 'device' ? `状态：${d.state}`
      : d.locked ? `${via} · 锁着屏（机器人会请你解锁）` : `${via}${d.appName || d.app ? ` · 前台：${d.appName || d.app}` : ''}`;
    return `<div class="machine-row"><div class="machine-avatar">${escapeHtml((d.model || '手').slice(0, 1))}</div><div class="machine-meta"><div class="machine-name">${escapeHtml(d.model || d.serial)}</div><div class="machine-sub">${escapeHtml(sub)}</div></div></div>`;
  }).join('');
}

/**
 * On the phone itself (1.4.0): 「让机器人用这部手机」. Lamplit only opens the
 * system's accessibility settings; the human turns it on there.
 */
function renderPhoneAgentRow() {
  const row = $('phone-agent-row');
  const shell = window.NightshiftShell;
  if (!row) return;
  if (!shell || typeof shell.phoneAgentEnabled !== 'function') { row.hidden = true; return; }
  row.hidden = false;
  let on = false;
  try { on = Boolean(shell.phoneAgentEnabled()); } catch { /* old app */ }
  $('phone-agent-state').textContent = on
    ? '已打开：你各台机器上的机器人可以用这部手机（不用数据线）。通知栏里有提示，点「停止」随时关掉。'
    : '还没打开。打开后，你各台机器上的机器人不用数据线也能用这部手机：看屏幕、点、输入、打开 App。付款、发送、发布、同意条款每次都会先问你；锁屏时不会解锁，也不会输入密码。';
  $('phone-agent-btn').textContent = on ? '去系统设置里关掉' : '打开「让机器人用这部手机」';
  // Turning it off is the quiet choice; turning it on the main one (1.5.29).
  $('phone-agent-btn').classList.toggle('primary', !on);
  // 1.5.17: with the screen off the system puts Lamplit to sleep and the machines
  // lose the phone. Ask to keep running while it is given to the bots.
  const bat = $('phone-agent-battery');
  if (!bat) return;
  let free = true;
  try { free = typeof shell.batteryUnrestricted !== 'function' || Boolean(shell.batteryUnrestricted()); } catch { /* old app */ }
  bat.hidden = !on || free;
  let maker = '';
  try { maker = String(shell.manufacturer?.() || '').toLowerCase(); } catch { /* old app */ }
  const strict = /oppo|oneplus|realme|vivo|iqoo|xiaomi|redmi|huawei|honor|meizu/.test(maker);
  $('phone-agent-battery-note').textContent = '息屏后系统会让 Lamplit 休眠，机器就连不上这部手机了。点下面的按钮，在弹出的对话框里选「允许」，让它在后台一直运行。'
    + (strict ? '这个牌子的手机还要在「应用信息 → 耗电管理（或电池）」里打开「允许后台运行」和「允许自启动」。' : '');
  $('phone-agent-appinfo').hidden = !strict;
}

function bindPhoneBox() {
  if ($('phone-agent-btn') && !$('phone-agent-btn').dataset.bound) {
    $('phone-agent-btn').dataset.bound = '1';
    $('phone-agent-btn').addEventListener('click', () => {
      try { window.NightshiftShell.openAccessibilitySettings(); } catch { /* old app */ }
      toast('在系统设置里找到「Lamplit：让机器人用这部手机」，打开它，再回来');
    });
    // Back from the system settings: show what is on now.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderPhoneAgentRow(); });
  }
  if ($('phone-agent-keep') && !$('phone-agent-keep').dataset.bound) {
    $('phone-agent-keep').dataset.bound = '1';
    $('phone-agent-keep').addEventListener('click', () => {
      try { window.NightshiftShell.askBatteryUnrestricted(); } catch { /* old app */ }
    });
    $('phone-agent-appinfo').addEventListener('click', () => {
      try { window.NightshiftShell.openAppDetails(); } catch { /* old app */ }
      toast('在「耗电管理」或「电池」里打开「允许后台运行」和「允许自启动」，再回来');
    });
  }
  if (!$('phone-refresh') || $('phone-refresh').dataset.bound) return;
  $('phone-refresh').dataset.bound = '1';
  $('phone-refresh').addEventListener('click', () => renderPhoneBox());
  $('phone-adb-save').addEventListener('click', async () => {
    try {
      await api('/api/phone', { method: 'PUT', body: { adbPath: $('phone-adb').value.trim() } });
      toast('已保存');
      renderPhoneBox();
    } catch (err) { toast(err.message, true); }
  });
}

function renderMachinesList() {
  bindPhoneBox();
  renderPhoneBox();
  const box = $('set-machines-list');
  if (!box) return;
  if (!machineBridge) {
    // Browser / phone: no desktop bridge, but this hub knows the other machines
    // and can hand out a one-time link into any of them.
    box.innerHTML = '<div class="machine-empty">正在读取机器列表…</div>';
    renderBrowserMachines().catch(() => {
      box.innerHTML = `<div class="machine-empty">当前：${escapeHtml(machineDisplayName())}。这台机器离线时读不到机器列表；添加机器请在 Lamplit 客户端里操作。</div>`;
    });
    return;
  }
  const row = (m) => `
    <div class="machine-row ${m.current ? 'current' : ''}"${m.self ? ' data-self="1"' : ''}>
      <div class="machine-avatar">${escapeHtml((m.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="machine-meta">
        <div class="machine-name">${escapeHtml(m.name)}</div>
        <div class="machine-sub">${escapeHtml(m.sub)}</div>
      </div>
      <div class="machine-actions">
        ${m.current ? '<span class="machine-tag">当前</span>' : `<button class="btn tiny" data-switch="${escapeHtml(m.url)}">切到这里</button>`}
        ${m.url ? `<button class="btn tiny" data-rename="${escapeHtml(m.url)}">改名</button><button class="btn tiny" data-remove="${escapeHtml(m.url)}">移除</button>` : ''}
      </div>
    </div>`;
  const rows = [row({ url: '', name: machineDisplayName() || '这台电脑', self: true, sub: '', current: machineBridge.local })];
  for (const m of machineBridge.machines || []) {
    rows.push(row({ url: m.url, name: m.name, sub: m.url, current: m.url === machineBridge.current }));
  }
  if (!(machineBridge.machines || []).length) {
    rows.push('<div class="machine-empty">还没有别的机器。点「添加机器」，填 SSH 信息就能自动装好一台。</div>');
  }
  box.innerHTML = rows.join('');
  addMachineNotes(box);
}

/**
 * Browser / phone version of the same list. This hub already knows the other
 * machines (data/peers.json) and can mint a one-time pairing link into one of
 * them, so switching needs no credential on this device.
 */
async function renderBrowserMachines() {
  const box = $('set-machines-list');
  if (!box) return;
  const data = await api('/api/machines');
  const machines = Array.isArray(data?.machines) ? data.machines : [];
  const mine = machines.find((m) => m.self);
  const others = machines.filter((m) => !m.self);
  const row = (m) => `
    <div class="machine-row ${m.self ? 'current' : ''}"${m.self ? ' data-self="1"' : ''}>
      <div class="machine-avatar">${escapeHtml((m.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="machine-meta">
        <div class="machine-name">${escapeHtml(m.name)}</div>
        <div class="machine-sub">${m.self ? selfSub() : `<span class="dot ${m.online ? 'on' : ''}"></span>${m.online ? '在线' : '离线'}<span class="funnel-state" data-funnel-state="${escapeHtml(m.name)}"></span>`}</div>
      </div>
      <div class="machine-actions">
        ${m.self
          ? '<span class="machine-tag">当前</span>'
          : `<button class="btn tiny" data-handoff="${escapeHtml(m.name)}" ${m.online ? '' : 'disabled'}>切到这台</button>
             <button class="btn tiny" data-funnel="${escapeHtml(m.name)}" ${m.online ? '' : 'disabled'} title="外网访问：不装 Tailscale 也能从外面连这台">外网访问</button>`}
      </div>
    </div>`;
  const rows = machines.map(row);
  if (!others.length) {
    rows.push('<div class="machine-empty">还没有别的机器。点下面「添加机器」把旧电脑或云服务器接进来。</div>');
  }
  if (mine && !mine.url) {
    rows.push('<div class="machine-empty">这台电脑现在只在局域网/本机可用（没有打开「允许手机连接」），所以别的设备跳不过来。</div>');
  }
  box.innerHTML = rows.join('');
  addMachineNotes(box);
  refreshMachineFunnelButtons();
}

/** Per-machine public door: read current state lazily, one small button each. */
async function refreshMachineFunnelButtons() {
  for (const btn of document.querySelectorAll('#set-machines-list [data-funnel]')) {
    const name = btn.dataset.funnel;
    try {
      const data = await api(`/api/machines/${encodeURIComponent(name)}/funnel`);
      const funnel = data.funnel || {};
      btn.dataset.enabled = funnel.enabled ? '1' : '';
      // The button says what it does; the row says how it is (1.5.29: 「外网开」 read as a command).
      btn.textContent = funnel.enabled ? '关掉外网访问' : '打开外网访问';
      btn.title = funnel.address || funnel.error || '';
      const tag = document.querySelector(`[data-funnel-state="${cssEscape(name)}"]`);
      if (tag) tag.textContent = funnel.enabled ? ' · 外网访问已开' : '';
    } catch {
      btn.textContent = '外网访问';
    }
  }
}
async function handoffToMachine(name, button) {
  if (button) {
    button.disabled = true;
    button.textContent = '正在过去…';
  }
  try {
    const res = await api(`/api/machines/${encodeURIComponent(name)}/handoff`, { method: 'POST' });
    if (!res?.url) throw new Error('没有拿到跳转地址');
    // The machine may have several addresses (public, LAN, Tailscale). A VM's
    // LAN one is often the computer's internal network: try each and go to the
    // first this phone can reach; only when none works, say why.
    // LAN, then Tailscale, then the public address (it goes round the internet).
    const order = { lan: 0, tailnet: 1, public: 2 };
    const ranked = (Array.isArray(res.links) ? [...res.links] : []).sort((x, y) => (order[x.kind] ?? 1) - (order[y.kind] ?? 1));
    const candidates = [...new Set([...ranked.map((l) => l.url), res.url].filter(Boolean))];
    // Only those this phone can use now, tried together, the best-ranked that
    // answers wins (1.5.39: one by one, 4 s per dead address, 12 s on a hotspot).
    const usable = candidates.filter(phoneCanUse);
    // In the app with a relay to fall back on, give the direct addresses 1 s, not 4 each.
    const canRelay = Boolean(res.relay && typeof window.NightshiftShell?.openMachine === 'function');
    let target = await firstReachable(usable, canRelay ? 1000 : 4000);
    // Only the relay goes there, and only the phone app can use it (its own
    // forwarder): the app opens it from its machine list, with the login (1.5.37).
    if (!target && res.relay && typeof window.NightshiftShell?.openMachine === 'function') {
      if (button) button.textContent = '经中转过去…';
      if (window.NightshiftShell.openMachine(name)) return;
    }
    if (!target) {
      const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
      const hasTailnet = candidates.some((u) => /^100\./.test(hostOf(u)));
      throw new Error(
        `这台手机到不了「${name}」。它的地址是 ${
          candidates.map(hostOf).join('、')
        }：${hasTailnet ? 'Tailscale 地址要手机也装 Tailscale 并登录同一个账号；局域网地址只有电脑能访问时（虚拟机内网），把虚拟机网络改成「桥接」' : '这个地址只有电脑能访问（虚拟机内网），把虚拟机网络改成「桥接」或给手机装 Tailscale'}`,
      );
    }
    // `from` gives the other machine a one-tap way back: it points at this
    // origin, where this phone is already paired. `fromName` labels it in the
    // other machine's list with the name instead of the address.
    const next = new URL(target);
    next.searchParams.set('from', location.origin);
    next.searchParams.set('view', 'one'); // a machine picked by name: 「只看这台」 there (1.5.44)
    const label = machineDisplayName();
    if (label) next.searchParams.set('fromName', label);
    location.assign(next.toString());
  } catch (err) {
    toast(err?.message || '切换失败', true);
    if (button) {
      button.disabled = false;
      button.textContent = '切到这';
    }
  }
}

/** Is this URL reachable from here? An opaque no-cors request is enough. */
function reachable(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    fetch(url, { mode: 'no-cors', cache: 'no-store' })
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

async function onMachineListClick(event) {
  const funnelBtn = event.target.closest('[data-funnel]');
  if (funnelBtn) {
    const name = funnelBtn.dataset.funnel;
    const enabled = funnelBtn.dataset.enabled !== '1';
    funnelBtn.disabled = true;
    funnelBtn.textContent = enabled ? '开启中…' : '关闭中…';
    try {
      await api(`/api/machines/${encodeURIComponent(name)}/funnel`, { method: 'POST', body: { enabled } });
      toast(enabled ? `「${name}」外网访问已开启` : `「${name}」外网访问已关闭`);
    } catch (err) {
      toast(`没改成：${err.message}`, true);
    } finally {
      funnelBtn.disabled = false;
      refreshMachineFunnelButtons();
    }
    return;
  }
  const handoff = event.target.closest('[data-handoff]');
  if (handoff) {
    await handoffToMachine(handoff.dataset.handoff, handoff);
    return;
  }
  const btn = event.target.closest('[data-switch],[data-rename],[data-remove]');
  if (!btn || !window.desk) return;
  if (btn.dataset.switch !== undefined) {
    btn.disabled = true;
    btn.textContent = '切换中…';
    await switchMachine(btn.dataset.switch);
    btn.disabled = false;
    btn.textContent = '切到这里';
    return;
  }
  if (btn.dataset.rename) {
    const current = machineBridge?.machines?.find((m) => m.url === btn.dataset.rename)?.name || '';
    const name = await askText({ title: '给这台机器改名', text: '这个名字会显示在机器列表和左上角。', value: current, confirmLabel: '改名' });
    if (!name || !name.trim()) return;
    const res = await window.desk.renameMachine(btn.dataset.rename, name.trim());
    if (!res?.ok) toast(res?.error || '改名失败', true);
    await refreshMachines();
    return;
  }
  if (btn.dataset.remove) {
    const ok = await askConfirm({
      title: '移除这台机器？',
      text: '只是从列表里拿掉，那台机器上的助手和数据不会删除；以后可以重新添加。',
      confirmLabel: '移除',
    });
    if (!ok) return;
    await window.desk.removeMachine(btn.dataset.remove);
    await refreshMachines();
  }
}

/** Accept "1.2.3.4", "1.2.3.4:22" or a URL; only the host matters here. */
/**
 * The machine this window shows is overloaded (CPU near 100% for a minute, or
 * almost no memory left): everything gets slow, so say why, once.
 */
const busyWatch = { dismissed: false, timer: null };
async function checkBusy() {
  clearTimeout(busyWatch.timer);
  busyWatch.timer = setTimeout(checkBusy, 60000);
  let h;
  try { h = await api('/api/health'); } catch { return; }
  const l = h.load;
  const banner = $('busy-banner');
  if (!banner || !l) return;
  if (!l.busy) { banner.hidden = true; busyWatch.dismissed = false; return; }
  if (busyWatch.dismissed) return;
  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  $('busy-text').textContent = l.why === 'memory'
    ? `这台机器内存快用完了（只剩 ${gb(l.memFreeMB)} / ${gb(l.memTotalMB)}），Lamplit 会变慢。可以关掉不用的程序，或给它加内存。`
    : `这台机器很忙：CPU 已经满负荷一分多钟（${l.cores} 核，${l.cpu}%），Lamplit 会变慢。常见原因是系统更新或杀毒扫描；虚拟机建议至少 2 核、4 GB 内存。`;
  banner.hidden = false;
}

/** Settings → 手机和外网: install Tailscale on a machine already added (one given to the bots). */
let tsWatch = null;
// 1.5.43: the Tailscale card (one click here and on the other machines) - in the roster part.
async function loadTailscaleBox() { clearTimeout(tsWatch); return renderTailscaleCard(); }
async function installTailscale() { return installTailscaleHere(); }

/** A public address (a cloud host), not the LAN, Tailscale or this computer. */
function isPublicAddress(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.ts.net') || !h.includes('.') && !h.includes(':')) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  if (h.includes(':')) return !/^(fc|fd|fe80|::1)/.test(h);
  return true; // a domain name: most likely on the internet
}

function updatePublicHint() {
  const address = parseTargetAddress($('vnc-addr').value);
  const pub = Boolean(address && isPublicAddress(address.host));
  $('vnc-public').hidden = !pub;
  if (pub) $('vnc-ts').open = true;
}

function parseTargetAddress(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`); }
  catch { return null; }
  return u.hostname ? { host: u.hostname } : null;
}

/** The live view: the hub hands out the current bot's own desktop URL. A
 *  machine without one shows screenshots instead of a dead viewer. */
function currentViewerUrl() {
  const url = state.computer?.desktop?.url || '';
  // "只能看": noVNC sends no mouse or keyboard input.
  return url && state.policy?.takeover === 'view' ? `${url}&view_only=1` : url;
}

function renderComputerPane() {
  syncMachineBranding();
  if ($('pc-title')) $('pc-title').textContent = `${machineDisplayName()}的屏幕`;
  if (!desktopTakeover()) {
    if ($('pc-screen')) $('pc-screen').style.display = '';
    refreshScreen();
  }
  syncViewer();
}

/**
 * The viewer iframe stays mounted while the pane is open: a live picture
 * before takeover, keyboard/mouse control after. No reconnect when toggling.
 */
function syncViewer() {
  const wrap = $('pc-vnc-wrap');
  const shield = $('pc-vnc-shield');
  if (!wrap) return;
  const takeover = desktopTakeover();
  const watching = state.panelOpen && state.tab === 'computer';
  const installing = state.computer?.desktopSetup?.state === 'running';
  const bar = $('pc-mobile-bar');
  if (bar) bar.hidden = !(isMobile() && takeover && watching);
  syncPhoneTouch(isMobile() && takeover && watching);
  const url = currentViewerUrl();
  // Closing the pane ends the session even mid-takeover: a hidden iframe must
  // not keep a VNC websocket (and the remote input focus) alive.
  if (!watching || installing || (!takeover && !url)) {
    if ($('pc-light-hint')) $('pc-light-hint').hidden = true;
    unmountViewer();
    if (shield) shield.hidden = true;
    if ($('pc-desktop')) $('pc-desktop').textContent = '接管桌面';
    return;
  }
  if (!url) { unmountViewer(); if (shield) shield.hidden = true; return; }
  if (viewerUrl !== url || !wrap.querySelector('iframe')) {
    wrap.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('title', `${screenMachineName()}桌面`);
    frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    frame.setAttribute('allowfullscreen', '');
    frame.referrerPolicy = 'no-referrer';
    frame.addEventListener('load', () => bridgeClipboard(frame));
    wrap.appendChild(frame);
    viewerUrl = url;
  }
  wrap.hidden = false;
  if ($('pc-screen')) $('pc-screen').style.display = 'none';
  if ($('pc-screen-note')) $('pc-screen-note').style.display = 'none';
  const card = $('pc-screen-wrap');
  if (card) {
    card.classList.add('viewer');
    card.classList.toggle('takeover', takeover);
    card.classList.toggle('preview', !takeover);
  }
  if (shield) {
    shield.hidden = takeover;
    if (!takeover && $('pc-preview-name')) $('pc-preview-name').textContent = `实时画面 · ${screenMachineName()}`;
  }
  {
    // Light (openbox) and kiosk (cage, Rocky/RHEL 10) screens are empty until a
    // bot opens something: say that is normal.
    const hint = $('pc-light-hint');
    const mode = state.computer?.desktop?.mode;
    if (hint) {
      hint.hidden = mode !== 'light' && mode !== 'kiosk';
      if (!hint.hidden) hint.textContent = mode === 'kiosk' ? '这台机器的屏幕只显示机器人的浏览器，没有桌面；空着（黑屏）是正常的，机器人打开浏览器时会铺满这里。' : '轻量桌面：没有任务栏和图标，空着是正常的。机器人打开浏览器或程序时，窗口会出现在这里；接管后右键空白处有菜单。';
    }
  }
  if ($('pc-desktop')) $('pc-desktop').textContent = takeover ? '返回预览' : '接管桌面';
}

/*
 * Phone takeover as a remote-control app does it. 触摸板 (default): drag moves a
 * cursor, tap clicks, double-tap and hold drags, two-finger tap right-clicks,
 * two fingers up/down scroll. 直接点: tap where you touch, drag holds the left
 * button, long press right-clicks. Pinch zooms the picture; two fingers pan it
 * while zoomed. noVNC gets plain mouse events in its canvas coordinates.
 */
const phoneTouch = {
  mode: (() => { try { return localStorage.getItem('desk.touchMode') === 'direct' ? 'direct' : 'pad'; } catch { return 'pad'; } })(),
  zoom: 1, tx: 0, ty: 0, cursor: null, on: false,
};
function vncRfb() { return document.querySelector('#pc-vnc-wrap iframe')?.contentWindow?.UI?.rfb || null; }
/** Touch-layer pixels -> noVNC canvas pixels (through the zoom and the iframe). */
function touchToCanvas(ox, oy) {
  const frame = document.querySelector('#pc-vnc-wrap iframe');
  const rfb = vncRfb();
  if (!frame || !rfb?._canvas) return null;
  const layer = $('pc-touch').getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const z = fr.width / (frame.offsetWidth || fr.width || 1);
  const ix = (layer.left + ox - fr.left) / z;
  const iy = (layer.top + oy - fr.top) / z;
  const cr = rfb._canvas.getBoundingClientRect();
  return { x: ix - cr.left, y: iy - cr.top };
}
function touchMove(ox, oy) { const p = touchToCanvas(ox, oy); if (p) vncRfb()._handleMouseMove(p.x, p.y); }
function touchButtons(ox, oy, mask) { const p = touchToCanvas(ox, oy); if (p) vncRfb()._handleMouseButton(p.x, p.y, mask); }
function touchClick(ox, oy, mask = 1) {
  touchMove(ox, oy);
  touchButtons(ox, oy, mask);
  setTimeout(() => touchButtons(ox, oy, 0), 40);
}
/** Where the remote picture sits inside the touch layer, in layer pixels. */
function canvasInLayer() {
  const frame = document.querySelector('#pc-vnc-wrap iframe');
  const rfb = vncRfb();
  const layer = $('pc-touch');
  if (!frame || !rfb?._canvas || !layer) return null;
  const lr = layer.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const z = fr.width / (frame.offsetWidth || fr.width || 1);
  const cr = rfb._canvas.getBoundingClientRect();
  if (!cr.width || !cr.height) return null;
  return { left: fr.left + cr.left * z - lr.left, top: fr.top + cr.top * z - lr.top, width: cr.width * z, height: cr.height * z };
}
function placeCursor() {
  const c = $('pc-cursor');
  if (c && phoneTouch.cursor) c.style.translate = `${phoneTouch.cursor.x}px ${phoneTouch.cursor.y}px`;
  // Remember the spot as a share of the picture, so a layout change (全屏,
  // rotating the phone) can put the ring back over the same remote point.
  const pic = canvasInLayer();
  if (pic && phoneTouch.cursor) phoneTouch.cursorAt = { fx: (phoneTouch.cursor.x - pic.left) / pic.width, fy: (phoneTouch.cursor.y - pic.top) / pic.height };
}
/** After the picture moved or changed size: same remote point, new screen spot. */
function replaceCursor() {
  const pic = canvasInLayer();
  if (!pic || !phoneTouch.on) return;
  // Not placed over the picture yet (it was still connecting): the middle of it.
  const fresh = !phoneTouch.cursorAt;
  const at = phoneTouch.cursorAt || { fx: 0.5, fy: 0.5 };
  phoneTouch.cursor = { x: pic.left + at.fx * pic.width, y: pic.top + at.fy * pic.height };
  placeCursor();
  if (fresh) touchMove(phoneTouch.cursor.x, phoneTouch.cursor.y);
}
function applyZoom() {
  const wrap = $('pc-vnc-wrap');
  if (!wrap) return;
  wrap.style.transform = phoneTouch.zoom > 1.001 ? `translate(${phoneTouch.tx}px, ${phoneTouch.ty}px) scale(${phoneTouch.zoom})` : '';
}
function syncPhoneTouch(on) {
  const layer = $('pc-touch');
  if (!layer) return;
  layer.hidden = !on;
  layer.classList.toggle('direct', phoneTouch.mode === 'direct');
  document.body.classList.toggle('pc-touching', on);
  if ($('pcm-mode')) $('pcm-mode').textContent = phoneTouch.mode === 'direct' ? '直接点' : '触摸板';
  if ($('pcm-full')) $('pcm-full').textContent = document.body.classList.contains('panel-max') ? '退出全屏' : '全屏';
  if (on && !phoneTouch.on) {
    const r = layer.getBoundingClientRect();
    phoneTouch.cursor = { x: r.width / 2, y: r.height / 2 };
    phoneTouch.on = true;
    placeCursor();
    // The remote pointer starts where the ring is.
    touchMove(phoneTouch.cursor.x, phoneTouch.cursor.y);
  }
  if (!on && phoneTouch.on) { phoneTouch.zoom = 1; phoneTouch.tx = 0; phoneTouch.ty = 0; phoneTouch.cursorAt = null; applyZoom(); }
  phoneTouch.on = on;
}
function setupPhoneTouch() {
  const layer = $('pc-touch');
  if (!layer) return;
  const pts = new Map();
  let g = null;
  let lastTapAt = 0;
  let holdTimer = null;
  // 全屏 / rotating resizes the picture a moment after the layer: follow both.
  if (window.ResizeObserver) {
    let settle = null;
    new ResizeObserver(() => {
      replaceCursor();
      clearTimeout(settle);
      settle = setTimeout(replaceCursor, 350);
    }).observe(layer);
  }
  const local = (e) => { const r = layer.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const clampCursor = () => {
    const r = layer.getBoundingClientRect();
    phoneTouch.cursor.x = Math.max(0, Math.min(r.width - 1, phoneTouch.cursor.x));
    phoneTouch.cursor.y = Math.max(0, Math.min(r.height - 1, phoneTouch.cursor.y));
  };
  const clampPan = () => {
    const r = layer.getBoundingClientRect();
    phoneTouch.tx = Math.min(0, Math.max(r.width - r.width * phoneTouch.zoom, phoneTouch.tx));
    phoneTouch.ty = Math.min(0, Math.max(r.height - r.height * phoneTouch.zoom, phoneTouch.ty));
  };
  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { layer.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const p = local(e);
    pts.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
    if (pts.size === 1) {
      g = { kind: 'one', start: Date.now(), moved: false, dragging: false, right: false, last: p };
      if (phoneTouch.mode === 'pad') {
        // Double tap and hold: drag with the left button down.
        if (Date.now() - lastTapAt < 320) { g.dragging = true; touchButtons(phoneTouch.cursor.x, phoneTouch.cursor.y, 1); }
      } else {
        holdTimer = setTimeout(() => { if (g?.kind === 'one' && !g.moved) { g.right = true; touchClick(p.x, p.y, 4); } }, 600);
      }
    } else if (pts.size === 2) {
      clearTimeout(holdTimer);
      if (g?.dragging) {
        const at = phoneTouch.mode === 'pad' ? phoneTouch.cursor : g.last;
        touchButtons(at.x, at.y, 0);
      }
      const [a, b] = [...pts.values()];
      g = { kind: 'two', start: Date.now(), moved: false, pinch: false, d0: dist(a, b), z0: phoneTouch.zoom, m0: mid(a, b), last: mid(a, b), tx0: phoneTouch.tx, ty0: phoneTouch.ty, acc: 0 };
    }
  });
  layer.addEventListener('pointermove', (e) => {
    const pt = pts.get(e.pointerId);
    if (!pt || !g) return;
    e.preventDefault();
    const p = local(e);
    pt.x = p.x;
    pt.y = p.y;
    if (g.kind === 'one') {
      const dx = p.x - g.last.x;
      const dy = p.y - g.last.y;
      g.last = p;
      if (!g.moved && Math.hypot(p.x - pt.sx, p.y - pt.sy) > 8) {
        g.moved = true;
        clearTimeout(holdTimer);
        if (phoneTouch.mode === 'direct' && !g.right) { touchMove(pt.sx, pt.sy); touchButtons(pt.sx, pt.sy, 1); g.dragging = true; }
      }
      if (phoneTouch.mode === 'pad') {
        phoneTouch.cursor.x += dx * 1.6;
        phoneTouch.cursor.y += dy * 1.6;
        clampCursor();
        placeCursor();
        touchMove(phoneTouch.cursor.x, phoneTouch.cursor.y);
      } else if (g.dragging) {
        touchMove(p.x, p.y);
      }
    } else if (g.kind === 'two' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b);
      const m = mid(a, b);
      if (Math.hypot(m.x - g.m0.x, m.y - g.m0.y) > 8 || Math.abs(d - g.d0) > 8) g.moved = true;
      if (g.pinch || Math.abs(d - g.d0) > 28) {
        g.pinch = true;
        const z = Math.max(1, Math.min(4, g.z0 * d / g.d0));
        phoneTouch.tx = g.m0.x - (g.m0.x - g.tx0) * (z / g.z0) + (m.x - g.m0.x);
        phoneTouch.ty = g.m0.y - (g.m0.y - g.ty0) * (z / g.z0) + (m.y - g.m0.y);
        phoneTouch.zoom = z;
        clampPan();
        applyZoom();
      } else if (phoneTouch.zoom > 1.001) {
        phoneTouch.tx = g.tx0 + (m.x - g.m0.x);
        phoneTouch.ty = g.ty0 + (m.y - g.m0.y);
        clampPan();
        applyZoom();
      } else {
        // Two fingers up/down: the wheel, like a laptop touchpad.
        g.acc += m.y - g.last.y;
        const at = phoneTouch.mode === 'pad' ? phoneTouch.cursor : g.m0;
        while (Math.abs(g.acc) >= 36) {
          const up = g.acc > 0; // fingers move down = content moves down = wheel up
          touchMove(at.x, at.y);
          touchButtons(at.x, at.y, up ? 8 : 16);
          touchButtons(at.x, at.y, 0);
          g.acc += up ? -36 : 36;
        }
      }
      g.last = m;
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'one' && pts.size === 0) {
      clearTimeout(holdTimer);
      const quick = Date.now() - g.start < 300;
      if (phoneTouch.mode === 'pad') {
        const c = phoneTouch.cursor;
        if (g.dragging) touchButtons(c.x, c.y, 0);
        else if (!g.moved && quick) { touchClick(c.x, c.y, 1); lastTapAt = Date.now(); }
      } else if (g.dragging) {
        touchButtons(g.last.x, g.last.y, 0);
      } else if (!g.moved && !g.right && quick) {
        touchClick(g.last.x, g.last.y, 1);
      }
      g = null;
    } else if (g.kind === 'two') {
      if (!g.moved && !g.pinch && Date.now() - g.start < 400) {
        const at = phoneTouch.mode === 'pad' ? phoneTouch.cursor : g.m0;
        touchClick(at.x, at.y, 4);
      }
      g = pts.size === 0 ? null : { kind: 'done' };
    } else if (g.kind === 'done' && pts.size === 0) {
      g = null;
    }
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);

  $('pcm-mode')?.addEventListener('click', () => {
    phoneTouch.mode = phoneTouch.mode === 'pad' ? 'direct' : 'pad';
    try { localStorage.setItem('desk.touchMode', phoneTouch.mode); } catch { /* private mode */ }
    syncPhoneTouch(phoneTouch.on);
    toast(phoneTouch.mode === 'pad'
      ? '触摸板：拖动移动光标，轻点是左键，双击按住可以拖动，双指轻点是右键，双指上下滑是滚动'
      : '直接点：点哪里就点哪里，按住拖动，长按是右键，双指上下滑是滚动');
  });
  $('pcm-full')?.addEventListener('click', () => {
    togglePanelMax(!document.body.classList.contains('panel-max'));
    setTimeout(() => syncPhoneTouch(phoneTouch.on), 60);
  });
  $('pcm-hide')?.addEventListener('click', () => document.body.classList.add('pcm-collapsed'));
  $('pcm-handle')?.addEventListener('click', () => document.body.classList.remove('pcm-collapsed'));
}

/* A Windows machine with several monitors: show one at a time (the primary
   one unless picked), or all side by side. Hidden with one screen, on Linux
   and on hubs too old to know. */
async function loadScreens() {
  const pick = $('pc-monitor');
  if (!pick) return;
  let data = null;
  try { data = await api('/api/desktop/screens'); } catch { data = null; }
  const screens = data?.supported ? data.screens || [] : [];
  if (screens.length < 2) { pick.hidden = true; return; }
  const opts = [['primary', '主屏'], ...screens.map((s) => [String(s.n), s.label]), ['all', '全部屏幕']];
  const html = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  if (pick.dataset.html !== html) { pick.innerHTML = html; pick.dataset.html = html; }
  if (document.activeElement !== pick) pick.value = String(data.choice ?? 'primary');
  pick.hidden = false;
}

async function pickScreen() {
  const pick = $('pc-monitor');
  const screen = pick.value === 'primary' || pick.value === 'all' ? pick.value : Number(pick.value);
  pick.disabled = true;
  try {
    await api('/api/desktop/screen', { method: 'PUT', body: { screen } });
    // The picture changes size: connect the view again so it fits. TightVNC
    // drops its viewers while it switches, and a connection tried in that
    // moment fails for good (seen: "无法连接到服务器"): wait, then check.
    unmountViewer();
    await new Promise((r) => setTimeout(r, 1500));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      syncViewer();
      await new Promise((r) => setTimeout(r, 4000));
      const ui = document.querySelector('#pc-vnc-wrap iframe')?.contentWindow?.UI;
      if (!ui || ui.connected) break;
      unmountViewer();
    }
  } catch (err) {
    toast(`换屏幕失败：${err.message}`, true);
    loadScreens().catch(() => {});
  } finally {
    pick.disabled = false;
  }
}

function unmountViewer() {
  const wrap = $('pc-vnc-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.hidden = true;
  viewerUrl = '';
  const card = $('pc-screen-wrap');
  if (card) {
    card.classList.remove('takeover', 'viewer', 'preview');
  }
  if ($('pc-vnc-shield')) $('pc-vnc-shield').hidden = true;
}

function fillZoneSelect(select, current) {
  if (!select) return;
  const zones = new Set(COMMON_TIMEZONES);
  try { for (const zone of Intl.supportedValuesOf('timeZone')) zones.add(zone); } catch { /* older engine */ }
  if (current) zones.add(current);
  select.innerHTML = ['<option value="">不确定</option>', ...[...zones].sort().map((zone) => (
    `<option value="${escapeHtml(zone)}">${escapeHtml(timezoneLabel(zone))}</option>`
  ))].join('');
  select.value = current || '';
}

function openMachineModal() {
  state.machineFromSettings = false; $('vnc-name').value = ''; resetOutsideChoice();
  for (const chip of document.querySelectorAll('#vnc-name-chips [data-name]')) chip.classList.remove('on');
  $('vnc-addr').value = '';
  $('vnc-ssh-user').value = ''; // no 「ubuntu」 for a computer at home; 「云服务器」 fills it (1.5.54)
  $('vnc-ssh-port').value = '22';
  $('vnc-ssh-pass').value = '';
  $('vnc-progress').hidden = true;
  $('vnc-progress').className = 'modal-note';
  if ($('vnc-progress-wrap')) $('vnc-progress-wrap').hidden = true;
  $('vnc-modal-note').hidden = true;
  $('vnc-modal').classList.add('open');
  $('vnc-modal').setAttribute('aria-hidden', 'false');
  $('vnc-scrim').classList.add('show');
  setTimeout(() => $('vnc-name').focus(), 50);
  updatePublicHint();
}

function closeMachineModal() {
  $('vnc-modal').classList.remove('open');
  $('vnc-modal').setAttribute('aria-hidden', 'true');
  $('vnc-scrim').classList.remove('show');
}

function saveMachineFromModal() {
  const note = $('vnc-modal-note');
  const fail = (text) => { note.textContent = text; note.hidden = false; note.scrollIntoView({ block: 'nearest' }); };
  // What it is called everywhere after (1.5.42): a name the human gave, never its address.
  if (!$('vnc-name').value.trim()) { $('vnc-name').focus(); return fail('先选一下它是哪台（或者自己写个名字），以后到处都用这个名字。'); }
  const hostInput = $('vnc-addr').value.trim();
  if (!hostInput) return fail('先填那台机器的 IP，例如 192.168.1.20');
  const address = parseTargetAddress(hostInput);
  if (!address) return fail('IP 地址看起来不对，例子：192.168.1.20');
  if (!$('vnc-ssh-user').value.trim()) { $('vnc-ssh-user').focus(); return fail('填一下用户名：你登录那台电脑用的那个（云服务器一般是 ubuntu 或 root）。'); }
  const password = $('vnc-ssh-pass').value;
  if (!password) return fail('还需要那台机器的 SSH 密码，才能自动配置。');
  const reach = outsideChoice(); // 只在家里用 / Tailscale / 自建中转 (1.5.43)
  if (reach.error) return fail(reach.error);

  note.hidden = true;
  startRemoteProvision({
    name: $('vnc-name').value.trim(),
    host: address.host,
    sshPort: Number($('vnc-ssh-port').value) || 22,
    username: $('vnc-ssh-user').value.trim(),
    password,
    desktop: $('vnc-desktop')?.value === 'full' ? 'full' : 'light',
    ...reach.options,
  });
}

/**
 * Install a hub on the target and show progress in the dialog. The SSH
 * password lives in this job only. When it finishes the desktop shell pairs
 * with the new hub and adds it to the machine list.
 */
/**
 * In the desktop app, machine setup always runs on this computer (the page may
 * belong to a remote machine, which would install its own older copy and
 * restart itself mid-way when it is the target).
 */
/**
 * The machine you are on, and how this page reaches it (第 2 步): inside the phone app
 * a page on 127.0.0.1:14440-14499 came through the relay (the app's forwarder, RelayLinks).
 */
function selfSub() {
  // Opened by name from another machine (1.5.44 test): the one on screen, not the one in your hand.
  if (throughPhoneRelay() && state.relayHere) return `${singleVisit() ? '现在打开的这台' : '你正在用的这台'} · 经中转（中转就在这台上）`; // 1.5.48
  if (throughPhoneRelay() && /^direct/.test(phoneRelayRoute(location.origin))) return `${singleVisit() ? '现在打开的这台' : '你正在用的这台'} · ${phoneRelayRoute(location.origin) === 'direct-lan' ? '局域网' : '直连'}`;
  if (singleVisit()) return throughPhoneRelay() ? '现在打开的这台 · 经过中转' : '现在打开的这台';
  return throughPhoneRelay() ? '你正在用的这台 · 经过中转' : '你正在用的这台';
}

/** A job poll answers with the job itself (GET /api/remote/provision/:id); keep the last one when it fails. */
const jobFrom = (res, last) => (res?.id ? res : res?.job?.id ? res.job : last);

async function provisionApi(path, options = {}) {
  if (!window.desk?.localProvision || machineBridge?.local) return api(path, options);
  const res = await window.desk.localProvision({ method: options.method || 'GET', path, body: options.body });
  if (res.status >= 200 && res.status < 300) return res.json;
  const err = new Error(res.json?.error?.message || (res.status ? `HTTP ${res.status}` : '连不上本机的 Lamplit 服务'));
  err.status = res.status;
  throw err;
}

async function startRemoteProvision(options) {
  const progress = $('vnc-progress');
  const save = $('vnc-save');
  const barWrap = $('vnc-progress-wrap');
  const bar = $('vnc-progress-bar');
  const barStep = $('vnc-progress-step');
  // Typical seconds per step of the setup script; step 3 on Linux (desktop
  // packages) and step 5 on Windows (TightVNC) are the long ones. The bar and
  // the estimate move every second between polls, so it never looks frozen.
  const STEP_SECONDS = {
    linux: [5, 60, 600, 10, 10, 15, 10],
    windows: [5, 60, 20, 10, 90, 10, 30],
  };
  const t0 = Date.now();
  let cur = { step: 0, total: 0, os: '', since: Date.now() };
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const paint = () => {
    if (!barWrap || !bar) return;
    barWrap.hidden = false;
    const { step, total } = cur;
    const known = total > 0 && step > 0;
    barWrap.querySelector('.prov-bar')?.classList.toggle('indeterminate', !known);
    const elapsed = clock(Date.now() - t0);
    if (!known) {
      if (barStep) barStep.textContent = `正在连接和上传… · 已用 ${elapsed}`;
      return;
    }
    const weights = STEP_SECONDS[/windows/i.test(cur.os) ? 'windows' : 'linux'];
    const w = (i) => weights[i] ?? 15;
    const all = Array.from({ length: total }, (_, i) => w(i)).reduce((a, b) => a + b, 0);
    const done = Array.from({ length: step - 1 }, (_, i) => w(i)).reduce((a, b) => a + b, 0);
    const inStep = (Date.now() - cur.since) / 1000;
    const part = Math.min(0.92, inStep / w(step - 1)); // creep, never claim the step is done
    bar.style.width = `${Math.min(99, Math.round(((done + part * w(step - 1)) / all) * 100))}%`;
    const left = all - done - inStep;
    if (barStep) {
      barStep.textContent = left <= 5 ? `第 ${step}/${total} 步 · 已用 ${elapsed} · 这一步比较久，还在进行`
        : left < 60 ? `第 ${step}/${total} 步 · 已用 ${elapsed} · 还要约 ${Math.max(10, Math.round(left / 10) * 10)} 秒`
        : `第 ${step}/${total} 步 · 已用 ${elapsed} · 还要约 ${Math.round(left / 60)} 分钟`;
    }
  };
  const setBar = (job) => {
    const step = Number(job?.step || 0);
    if (step !== cur.step) cur.since = Date.now();
    cur = { ...cur, step, total: Number(job?.totalSteps || 0), os: job?.os || cur.os };
    paint();
  };
  const ticker = setInterval(paint, 1000);
  const show = (text, kind = '') => {
    if (!progress) return;
    progress.hidden = false;
    progress.className = `modal-note${kind ? ` ${kind}` : ''}`;
    progress.textContent = text;
  };
  show('正在连接那台机器…');
  if (save) save.disabled = true;
  try {
    const started = await provisionApi('/api/remote/provision', { method: 'POST', body: options });
    const jobId = started?.job?.id;
    if (!jobId) throw new Error('服务没有返回配置任务');
    let job = started.job;
    let quietTicks = 0;
    while (job && job.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const before = job.message;
      job = await provisionApi(`/api/remote/provision/${encodeURIComponent(jobId)}`);
      show(job.message || '正在配置…');
      setBar(job);
      quietTicks = job.message === before ? quietTicks + 1 : 0;
      // Long package installs can be silent for minutes; keep the human oriented.
      if (quietTicks === 80) show('安装还在进行，软件包较大时需要几分钟…');
    }
    clearInterval(ticker);
    if (job.state === 'error') throw new Error(job.message || '远程配置失败');
    if (!job.hubUrl) throw new Error('配置结束了，但没有拿到那台机器的地址');

    if (bar) bar.style.width = '100%';
    if (barStep) barStep.textContent = `完成 · 用时 ${clock(Date.now() - t0)}`;
    let paired = false;
    if (window.desk?.addMachine) {
      const added = await window.desk.addMachine({ url: job.hubUrl, tailnetUrl: job.tailnetUrl, name: options.name, pairCode: job.pairCode });
      paired = Boolean(added?.paired);
      await refreshMachines();
    }
    show(job.state === 'warning' ? (job.message || '装好了，但有一项没完全就绪') : `「${options.name}」已经装好${paired ? '并配对' : ''}。${job.tailscale ? ` ${job.tailscale}。` : ''}`, job.state === 'warning' ? '' : 'ok');
    const note = $('vnc-modal-note');
    note.hidden = false;
    const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : `${Math.max(1, Math.round(ms / 1000))} 秒`);
    note.innerHTML = `<div style="margin-bottom:6px">地址：<b>${escapeHtml(job.hubUrl)}</b>`
      + (job.pairCode && !paired ? ` · 配对码 <b>${escapeHtml(job.pairCode)}</b>` : '')
      + '</div>'
      + (job.desktopPending ? `<div style="margin-bottom:6px">${escapeHtml('机器人的桌面和浏览器在那台机器上后台继续安装（通常 3–8 分钟），装好后「电脑」面板自动可用；现在就可以先让机器人干活。')}</div>` : '')
      // Where the time went, so a slow install can be explained.
      + ((job.timings || []).filter((t) => t.ms >= 1000).length
        ? `<details class="install-times"><summary>${escapeHtml('每一步用时')}</summary>${(job.timings || []).filter((t) => t.ms >= 1000).map((t) => `<div>${escapeHtml(t.label)} · ${escapeHtml(secs(t.ms))}</div>`).join('')}</details>`
        : '');
    if (window.desk?.switchHub) {
      const btn = document.createElement('button');
      btn.className = 'btn primary tiny';
      btn.type = 'button';
      btn.textContent = '切换到这台机器';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '正在切换…';
        await switchMachine(job.hubUrl);
        btn.disabled = false;
        btn.textContent = '切换到这台机器';
      });
      note.appendChild(btn);
    }
  } catch (err) {
    show(`自动配置失败：${err.message}`, 'bad');
  } finally {
    clearInterval(ticker);
    if (save) save.disabled = false;
  }
}

/** Fill the whole window with the single desktop card. */
const screenOrientationPlugin = () => window.Capacitor?.Plugins?.ScreenOrientation || null;
const isNativeApp = () => Boolean(window.Capacitor?.isNativePlatform?.());

function setRotateUi(on) {
  const btn = $('pcm-rot');
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.textContent = on ? '竖屏' : '旋转';
}

/**
 * User-controlled landscape. Native: real orientation lock + hidden system
 * bars. Browser: fullscreen + orientation lock when allowed. If either is
 * refused, fall back to rotating the picture with CSS — the controls stay
 * upright, and the same button turns it back.
 */
async function enterLandscape() {
  if (document.body.classList.contains('pc-landscape')) return;
  document.body.classList.add('pc-landscape');
  setRotateUi(true);
  // Remote hub pages have no Capacitor JS bridge, so the shell offers the same
  // two calls directly (window.desk.setOrientation / setImmersive).
  if (typeof window.desk?.setOrientation === 'function') {
    window.desk.setOrientation('landscape');
    window.desk?.setImmersive?.(true);
    document.body.classList.add('pc-native-landscape');
    return;
  }
  const plugin = screenOrientationPlugin();
  if (isNativeApp() && plugin) {
    try {
      await plugin.lock({ orientation: 'landscape' });
      document.body.classList.add('pc-native-landscape');
      window.desk?.setImmersive?.(true);
      return;
    } catch { /* fall through to CSS */ }
  } else {
    try {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      if (screen.orientation?.lock) await screen.orientation.lock('landscape');
      document.body.classList.add('pc-native-landscape');
      return;
    } catch { /* fall through to CSS */ }
  }
  document.body.classList.add('pc-rotated');
}

/** The phone app can really turn the screen (Android); a browser or an iPhone cannot be relied on. */
function canNativeRotate() {
  return typeof window.desk?.setOrientation === 'function' || Boolean(isNativeApp() && screenOrientationPlugin());
}

async function exitLandscape() {
  const was = document.body.classList.contains('pc-landscape');
  document.body.classList.remove('pc-landscape', 'pc-rotated', 'pc-native-landscape');
  setRotateUi(false);
  if (!was) return;
  if (typeof window.desk?.setOrientation === 'function') {
    window.desk.setOrientation('portrait');
    window.desk?.setImmersive?.(false);
    return;
  }
  const plugin = screenOrientationPlugin();
  try {
    if (isNativeApp() && plugin) await plugin.unlock();
    else {
      if (screen.orientation?.unlock) screen.orientation.unlock();
      if (document.fullscreenElement) await document.exitFullscreen();
    }
  } catch { /* already portrait */ }
  window.desk?.setImmersive?.(false);
}

async function toggleRotate() {
  if (!document.body.classList.contains('panel-max')) await togglePanelMax(true);
  if (document.body.classList.contains('pc-landscape')) await exitLandscape();
  else await enterLandscape();
}

async function togglePanelMax(on) {
  const next = on === undefined ? !document.body.classList.contains('panel-max') : on;
  if (!next) await exitLandscape();
  document.body.classList.toggle('panel-max', next);
  if (next) {
    state.panelOpen = true;
    applyLayoutPrefs();
    switchTab('computer');
  }
  $('pc-max').textContent = next ? '退出全屏' : '全屏';
  syncViewer();
  // A desktop is wide: held upright, a phone showed it as a thin strip in the
  // middle of a black screen. Full screen on the phone app turns it sideways.
  if (next && isMobile() && canNativeRotate() && window.innerHeight > window.innerWidth) enterLandscape();
}

function desktopTakeover() {
  return $('pc-screen-wrap')?.classList.contains('takeover');
}

/** Start controlling the desktop. With a live preview mounted this only
 *  lifts the shield, so there is no reconnect and no black frame. */
async function openDesktopViewer() {
  // Another machine's screen (1.5.42): the mouse and keyboard would work that computer. Ask first.
  const far = remoteOf(pcTargetBotId());
  if (far && !(await askConfirm({ title: `接管「${far.machine}」的屏幕？`, text: `接管后，你的鼠标和键盘会操作「${far.machine}」那台电脑。助手正在做的事可能会被你打断。`, confirmLabel: '接管' }))) return;
  api('/api/audit/takeover', { method: 'POST', body: { botId: pcTargetBotId(), mode: state.policy?.takeover === 'view' ? 'view' : 'control' } }).catch(() => {});
  if (!state.computer?.desktop?.url) {
    try { await loadComputer(); } catch { /* the viewer can still ask for a password */ }
  }
  const card = $('pc-screen-wrap');
  if (card) card.classList.add('takeover');
  syncViewer();
}

function closeDesktopViewer() {
  exitLandscape();
  const card = $('pc-screen-wrap');
  if (card) card.classList.remove('takeover');
  unmountViewer();
  if ($('pc-desktop')) $('pc-desktop').textContent = '接管桌面';
  renderComputerPane();
}

function stopScreenLoop() {  if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
}

function startScreenLoop() {
  stopScreenLoop();
  screenTimer = setInterval(() => {
    // Hidden = phone in a pocket: a screenshot every 5 s is megabytes over a
    // Tailscale relay for a picture nobody is looking at.
    if (document.hidden) return;
    if (state.tab !== 'computer' || !state.panelOpen) return;
    refreshScreen();
    loadComputer();
  }, 5000);
}

function openSidebar() {
  // A drawer only exists below the breakpoint; refuse it on the desktop layout.
  if (!isMobile()) { closeSidebar(); return; }
  closePanel();
  // On a phone it is the home page (every bot and group, like a messenger), not a drawer.
  document.body.classList.add('m-home');
  $('sidebar').classList.add('open');
  $('sidebar-scrim').classList.add('show');
  $('nav-toggle').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.body.classList.remove('m-home');
  if ($('home-search')?.value) { $('home-search').value = ''; filterHome(); }
  $('sidebar').classList.remove('open');
  $('sidebar-scrim').classList.remove('show');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
}

function openPanel(tab) {
  if (tab) switchTab(tab);
  if (!isMobile()) {
    // Desktop: the panel is a column, not a drawer. Just show it.
    state.panelOpen = true;
    try { localStorage.setItem('desk.panelOpen', '1'); } catch { /* private mode */ }
    document.body.classList.remove('panel-hidden');
    return;
  }
  closeSidebar();
  $('panel').classList.add('open');
  $('panel').setAttribute('aria-hidden', 'false');
  $('panel-scrim').classList.add('show');
}

function closePanel() {
  $('panel').classList.remove('open');
  $('panel-scrim').classList.remove('show');
  // Mobile used to keep state.panelOpen true here, so the VNC iframe and its
  // websocket stayed live behind a closed sheet, burning battery and data.
  if (state.panelOpen) {
    state.panelOpen = false;
    try { localStorage.setItem('desk.panelOpen', '0'); } catch { /* private mode */ }
    applyLayoutPrefs();
  }
  $('panel').setAttribute('aria-hidden', isMobile() ? 'true' : 'false');
  syncViewer();
}

/** Conversation-first defaults: no work panel, no tool chips, until asked. */
function applyLayoutPrefs() {
  document.body.classList.toggle('panel-hidden', !state.panelOpen);
  const toggle = $('panel-toggle');
  if (toggle) {
    toggle.classList.toggle('on', Boolean(state.panelOpen));
    toggle.setAttribute('aria-pressed', state.panelOpen ? 'true' : 'false');
  }
  const checkbox = $('show-process');
  if (checkbox) checkbox.checked = Boolean(state.showProcess);
}

/**
 * Single source of truth for overlay state. Run on boot, on every resize,
 * after a turn, and when a bot is picked: a scrim is only ever visible when
 * its drawer is genuinely open on a small screen, so no stuck overlay can
 * survive a layout change.
 */
function normalizeOverlays() {
  const mobile = isMobile();
  const sidebarOpen = mobile && $('sidebar').classList.contains('open');
  const panelOpen = mobile && $('panel').classList.contains('open');

  if (!sidebarOpen) closeSidebar();
  if (!panelOpen) {
    $('panel').classList.remove('open');
    $('panel-scrim').classList.remove('show');
  }
  $('panel').setAttribute('aria-hidden', panelOpen ? 'false' : (mobile ? 'true' : 'false'));

  if (!state.settingsOpen) $('settings-scrim').classList.remove('show');

  // Belt and braces: no scrim without something behind it.
  if (!sidebarOpen && !panelOpen && !state.settingsOpen) {
    $('sidebar-scrim').classList.remove('show');
    $('panel-scrim').classList.remove('show');
    $('settings-scrim').classList.remove('show');
  }
  document.body.classList.toggle('overlay-open', sidebarOpen || panelOpen || state.settingsOpen);
}

function resetMobileSurfaces() {
  normalizeOverlays();
}

function onViewportModeChange() {
  if (isMobile()) {
    $('panel').setAttribute('aria-hidden', 'true');
  } else {
    resetMobileSurfaces();
    $('panel').setAttribute('aria-hidden', 'false');
  }
}

/* Keyboard / visual viewport: keep the composer above the on-screen keyboard. */
function setupViewport() {
  let raf = 0;
  const apply = () => {
    raf = 0;
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const keyboard = Boolean(vv && vv.height < window.innerHeight - 120);
    const root = document.documentElement;
    // The phone app resizes the page for the keyboard ("native"), so the
    // visual viewport alone cannot tell: compare with the tallest page seen.
    apply.base = Math.max(apply.base || 0, window.innerHeight);
    const kbOpen = keyboard || window.innerHeight < apply.base - 120;
    document.body.classList.toggle('kb-open', kbOpen);
    root.style.setProperty('--kb-bottom', `${vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0}px`);
    // Takeover: the 键盘 button shows whether the remote keyboard is up.
    if ($('pcm-key')) $('pcm-key').classList.toggle('on', kbOpen && document.body.classList.contains('pc-touching'));
    if (keyboard) root.style.setProperty('--app-height', `${Math.round(height)}px`);
    else root.style.removeProperty('--app-height');
    if (keyboard) {
      const active = document.activeElement;
      if (active === $('composer') || active === $('auth-code')) scrollToBottom(true);
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(apply);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', () => { apply.base = 0; schedule(); });
  // Layout changes (including window zoom) must never leave a scrim behind.
  let overlayRaf = 0;
  const syncOverlays = () => {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => { overlayRaf = 0; normalizeOverlays(); });
  };
  window.addEventListener('resize', syncOverlays);
  window.addEventListener('orientationchange', syncOverlays);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  apply();
  normalizeOverlays();
}
