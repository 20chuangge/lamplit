'use strict';
// Lamplit page, part 10 of 12: tabs and layout, the machine screen, resizable panels. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   tabs, drawers, layout
   --------------------------------------------------------------------- */
function switchTab(name) {
  // Skills and memory live in Settings now; routines are part of 任务.
  if (name === 'skills' || name === 'memory') { openSettings(name === 'skills' ? 'sec-skills' : 'sec-memory'); return; }
  if (name === 'routines') name = 'activity';
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
  document.querySelectorAll('.navitem').forEach((n) => n.classList.toggle('active', n.dataset.tab === name));
  if (name === 'activity') { loadActivity(); loadRoutines(); }
  if (name === 'computer') {
    loadComputer();
    refreshScreen();
    syncViewer();
  } else if (!desktopTakeover()) {
    // Only the computer pane needs a live VNC socket; stop it when the human
    // switches away, unless they are actively controlling the machine.
    unmountViewer();
  }
  reportUiState();
}

/* ---------------------------------------------------------------------
   the machine the bots live on: screen + vitals
   --------------------------------------------------------------------- */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}天 ${h}小时` : h > 0 ? `${h}小时 ${m}分` : `${m}分`;
}

/**
 * The bot whose desktop the panel shows. In a group every member has its own
 * screen: follow whoever is working right now (or the coordinator), unless
 * the human picked one.
 */
function pcTargetBotId() {
  if (!isGroupMode()) return state.botId;
  const group = groupById(state.groupId);
  const ids = group ? groupMembers(group).map((b) => b.id) : [];
  if (state.pcPinned && ids.includes(state.pcPinned)) return state.pcPinned;
  if (state.pcFollow && ids.includes(state.pcFollow)) return state.pcFollow;
  return (group && ids.includes(group.coordinatorId)) ? group.coordinatorId : ids[0] || state.botId;
}

function renderPcWho() {
  const box = $('pc-who');
  if (!box) return;
  const group = isGroupMode() ? groupById(state.groupId) : null;
  box.hidden = !group;
  const current = pcTargetBotId();
  // The title names the bot whose screen this is, in a 1:1 chat too (11-15:
  // it still said 图表师 while the human looked at 主笔).
  const bot = botById(current);
  const far = remoteOf(current); // a bot on another machine says where (1.5.42): two of one name are told apart
  if ($('pc-title') && bot) $('pc-title').textContent = far ? `「${far.machine}」上${bot.name}的屏幕` : `${bot.name}的屏幕`;
  if (!group) return;
  box.innerHTML = '';
  for (const bot of groupMembers(group)) {
    const b = el('button', bot.id === current ? 'on' : '');
    b.type = 'button';
    b.title = `看 ${bot.name} 的屏幕`;
    b.appendChild(avatarNode(bot, 22));
    b.addEventListener('click', () => { state.pcPinned = bot.id; loadComputer(); });
    box.appendChild(b);
  }
}

/** The chat changed (another bot or group): the screen panel shows its screen. */
function followScreen() {
  renderPcWho();
  if (state.tab === 'computer' && $('pane-computer')?.classList.contains('active')) {
    loadComputer().then(() => refreshScreen()).catch(() => {});
  }
}

async function loadComputer() {
  let data;
  if (!state.policy) await loadPolicy().catch(() => {});
  renderPcWho();
  try {
    // Ask for THIS bot's desktop: every bot has its own screen, so the viewer
    // must not fall back to whatever the machine happens to be showing.
    const target = pcTargetBotId();
    if (isRemoteId(target)) { await loadRemoteComputer(target); return; }
    const scope = target ? `?botId=${encodeURIComponent(target)}` : '';
    data = await api(`/api/computer${scope}`);
  } catch (err) {
    $('pc-stats').innerHTML = `<div class="row-note">这台 Hub 还没有 /api/computer（${escapeHtml(err.message)}）。更新 Hub 端即可。</div>`;
    return;
  }
  state.computer = data;
  loadScreens().catch(() => {});
  if (data.desktop?.perBot && data.desktop?.url) {
    const wrap = $('pc-vnc-wrap');
    const current = wrap?.querySelector('iframe')?.getAttribute('src') || '';
    if (current !== data.desktop.url) {
      // Preview first: mount the live view with the shield on. Control starts
      // only when the human presses 接管桌面.
      const card = $('pc-screen-wrap');
      if (card) card.classList.remove('takeover');
      syncViewer();
    }
    if ($('pc-screen-note')) $('pc-screen-note').style.display = 'none';
    return;
  }
  // No screen of its own for this bot: take the previous bot's live view down.
  syncViewer();
  const rows = [
    ['主机', `${data.host.platform === 'win32' ? 'Windows' : data.host.platform} · ${data.host.release}`],
    ['主机名', data.host.hostname],
    ['已运行', fmtUptime(data.host.uptimeSec)],
    ['CPU', `${data.cpu.cores} 核 · ${data.cpu.usagePercent}%`],
    ['内存', `${data.memory.usedPercent}% · ${fmtBytes(data.memory.totalBytes - data.memory.freeBytes)} / ${fmtBytes(data.memory.totalBytes)}`],
    ['磁盘', data.disk ? `剩余 ${fmtBytes(data.disk.freeBytes)} / ${fmtBytes(data.disk.totalBytes)}` : '—'],
    ['浏览器', data.browser?.running ? `运行中 · pid ${data.browser.pid}` : (data.browser?.supported ? '未启动' : '不可用')],
    ['桌面归属', (() => {
      const per = data.perBotDesktop;
      if (!per) return '共享桌面';
      if (per.running && per.display) return `这个助手专属 ${per.display}`;
      if (per.support && per.support.available === false) return '共享桌面（Hub 不支持专属桌面）';
      return per.error ? `专属桌面启动失败` : '未启动';
    })()],
  ];
  $('pc-stats').innerHTML = rows
    .map(([k, v]) => `<div class="pc-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`)
    .join('');

  $('pc-procs').innerHTML = (data.processes || [])
    .map((p) => `<div class="pc-row"><span>${escapeHtml(p.name)}</span><b>${p.cpuPercent !== undefined ? `${p.cpuPercent}%` : `${p.cpuSec || 0}s`} · ${fmtBytes(p.memBytes || 0)}</b></div>`)
    .join('') || '<div class="row-note">拿不到进程列表</div>';
}

let screenTimer = null;
async function refreshScreen() {
  const img = $('pc-screen');
  const note = $('pc-screen-note');
  // A fresh machine is still installing its desktop and browser in the
  // background: say so, even when the screen parts are in already (the live
  // view would only show a black screen until the desktop itself is in).
  const setup = state.computer?.desktopSetup;
  if (setup && img && note) {
    // elapsedSec is counted on that machine (null when it cannot be trusted).
    const known = Number.isFinite(setup.elapsedSec);
    const mins = known ? Math.max(1, Math.round(setup.elapsedSec / 60)) : 0;
    img.style.display = 'none';
    note.textContent = setup.state === 'unsupported'
      ? setup.detail
      : setup.state === 'failed'
      ? `桌面没装全（${setup.detail}）：在这台机器上重新添加一次可以补上。`
      : known
        ? `桌面和浏览器还在后台安装：${setup.detail || '准备中'}（已 ${mins} 分钟，通常 3–10 分钟）。装好后这里会自动显示机器人的屏幕，机器人已经可以先做别的事。`
        : `桌面和浏览器还在后台安装：${setup.detail || '准备中'}（通常 3–10 分钟）。装好后这里会自动显示机器人的屏幕，机器人已经可以先做别的事。`;
    note.style.display = 'block';
    return;
  }
  // That machine has not answered yet for this bot: nothing of this computer meanwhile (screen-panel retest: a flash of it).
  const target = pcTargetBotId();
  if (isRemoteId(target) && !screenIsFor(target)) {
    if (img) img.style.display = 'none';
    if (note) { note.textContent = '正在打开屏幕…'; note.style.display = 'block'; }
    if (!refreshScreen.loading) refreshScreen.loading = loadComputer().catch(() => {}).finally(() => { refreshScreen.loading = null; });
    return;
  }
  // A bot on another machine (1.5.42): its own screen comes through this hub, or a word why not -
  // never this computer's picture under its name (final retest: 「小笔的屏幕」 showed this one).
  if (state.computer?.remote && !state.computer?.desktop?.perBot) {
    if (img) img.style.display = 'none';
    if (note) {
      note.textContent = state.computer.note || `这个助手在「${state.computer.remote.machine}」上，这里看不到它的屏幕。`;
      if (state.computer.locked) note.appendChild(pairButton(() => loadComputer()));
      note.style.display = 'block';
    }
    return;
  }
  if (state.computer?.desktop?.perBot) return;   // live view is already embedded
  if (!img) return;
  // Not known yet whether this bot has its own screen (a slow link, the first
  // load): asking for the machine's screen now would put its "no screen"
  // answer over the bot's live view when that arrives.
  if (!state.computer) {
    img.style.display = 'none';
    note.textContent = '正在打开屏幕…';
    note.style.display = 'block';
    // Opening the panel on a tab that was already 电脑 never asked: ask now,
    // once at a time. A failure says so instead of asking again and again.
    if (!refreshScreen.loading) {
      refreshScreen.loading = loadComputer().catch(() => {}).finally(() => {
        refreshScreen.loading = null;
        if (state.computer) refreshScreen();
        else { note.textContent = '打不开这台机器的屏幕信息，点「刷新」再试。'; note.style.display = 'block'; }
      });
    }
    return;
  }
  try {
    const res = await fetch(`/api/computer/screenshot?ts=${Date.now()}`, { credentials: 'same-origin' });
    // The bot's live view may have arrived while this was on its way.
    if (state.computer?.desktop?.perBot) return;
    if (isRemoteId(pcTargetBotId())) return; // or the panel moved to a bot on another machine (1.5.42)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      img.style.display = 'none';
      note.textContent = body?.error?.code === 'SCREENSHOT_UNAVAILABLE' && /no DISPLAY/.test(body?.error?.message || '')
        ? '这台机器本身没有桌面（服务器版），机器人的屏幕在它用浏览器或程序时才会打开。'
        : (body?.error?.message || '这台机器没有可截的屏幕（无桌面会话）');
      note.style.display = 'block';
      return;
    }
    const blob = await res.blob();
    if (isRemoteId(pcTargetBotId())) return;
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    const url = URL.createObjectURL(blob);
    img.dataset.url = url;
    img.src = url;
    img.style.display = 'block';
    note.style.display = 'none';
  } catch (err) {
    note.textContent = `截屏失败：${err.message}`;
    note.style.display = 'block';
  }
}

/* ---------------------------------------------------------------------
   resizable chrome: sidebar (left) and work panel (right).
   Each divider drags its own CSS variable; widths survive a reload.
   --------------------------------------------------------------------- */
const RESIZE_KEYS = { '--side-w': 'desk.sideW', '--panel-w': 'desk.panelW' };

function applyWidth(cssVar, px, { min, max }) {
  const limit = Math.max(min, Math.min(px, typeof max === 'function' ? max() : max));
  document.documentElement.style.setProperty(cssVar, `${Math.round(limit)}px`);
  return limit;
}

function readWidth(cssVar) {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
}

function wireEdgeResizer(handleId, cssVar, { min, max, fromRight }) {
  const handle = $(handleId);
  if (!handle) return;
  const key = RESIZE_KEYS[cssVar];
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 120) applyWidth(cssVar, saved, { min, max });
  } catch { /* private mode */ }

  let dragging = false;
  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    document.body.classList.add('resizing');
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* synthetic / unsupported */ }
    event.preventDefault();
  });
  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const px = fromRight ? window.innerWidth - event.clientX : event.clientX;
    applyWidth(cssVar, px, { min, max });
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const current = readWidth(cssVar);
    if (Number.isFinite(current)) {
      try { localStorage.setItem(key, String(current)); } catch { /* ignore */ }
    }
  };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty(cssVar);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  });
}

function wireChromeResizers() {
  wireEdgeResizer('sidebar-resizer', '--side-w', {
    min: 200, max: () => Math.min(520, window.innerWidth * 0.45), fromRight: false,
  });
  wireEdgeResizer('panel-resizer', '--panel-w', {
    min: 240, max: () => Math.max(360, window.innerWidth * 0.75), fromRight: true,
  });
}


/* ---------------------------------------------------------------------
   video cards (1.5.49): an attached or mentioned video shows its first
   frame, a play button and its length - an .mp4 used to look like any other
   file. A tap plays it right there with the native controls (full screen is
   one of them). A file on another machine comes from there, under the same
   pairing rules (findElsewhere, as for pictures). No frame to be read (a
   format this browser cannot decode): a plain 「视频」 card, still downloadable.
   --------------------------------------------------------------------- */
function videoCard(file, url) {
  const box = el('div', 'att-video');
  const stage = el('div', 'att-video-stage');
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.playsInline = true;
  v.muted = true; // the frame only; the sound once played
  v.src = `${url}#t=0.1`; // the frame at 0.1 s instead of black (a byte range, not the whole file)
  const play = el('button', 'att-video-play');
  play.type = 'button';
  play.setAttribute('aria-label', '播放视频');
  play.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const dur = el('span', 'att-video-dur', '');
  stage.append(v, play, dur);
  box.appendChild(stage);
  const length = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
  v.addEventListener('loadedmetadata', () => { dur.textContent = length(v.duration); });
  play.addEventListener('click', () => {
    box.classList.add('playing');
    v.muted = false;
    v.controls = true;
    v.play().catch(() => {});
  });
  const fallback = () => {
    box.classList.add('att-video-fallback');
    stage.replaceChildren(el('span', 'att-video-icon', '🎬'), el('b', 'att-video-kind', '视频'), el('span', 'att-video-note', '这里读不出画面，可以下载后观看'));
  };
  v.addEventListener('error', () => {
    if (v.dataset.tried) { fallback(); return; }
    v.dataset.tried = '1';
    findElsewhere(file.path).then((machine) => {
      if (!machine) { fallback(); return; }
      const far = remoteFileUrl(machine, file.path);
      v.src = `${far}#t=0.1`;
      dl.href = far;
      box.title = `在「${machine}」上`;
    });
  });
  // Under it: name and size, then small icon buttons (download, show in folder).
  const bar = el('div', 'att-video-bar');
  bar.appendChild(el('span', 'att-video-name', file.size ? `${file.name} · ${file.size}` : file.name));
  const icon = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const dl = el('a', 'att-act');
  dl.href = url;
  dl.setAttribute('download', file.name);
  dl.innerHTML = `${icon('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>')}<span>下载</span>`;
  bar.appendChild(dl);
  if (canOpenLocally()) {
    const show = el('button', 'att-act');
    show.type = 'button';
    show.title = '在文件夹中显示';
    show.innerHTML = `${icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}<span>打开位置</span>`;
    show.addEventListener('click', () => openLocalFile(file.path, true));
    bar.appendChild(show);
  }
  box.appendChild(bar);
  return box;
}
