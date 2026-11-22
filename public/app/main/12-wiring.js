'use strict';
// Lamplit page, part 12 of 12: wiring and start. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   wiring
   --------------------------------------------------------------------- */
/** Links to the website's docs: the English pages when the app is in English (1.5.13). */
function pointDocsLinks() {
  const en = window.deskI18n?.lang === 'en';
  for (const a of document.querySelectorAll('a[data-docs]')) {
    a.href = `https://20chuangge.github.io/lamplit/${en ? 'en/' : ''}docs.html${a.dataset.docs || ''}`;
  }
}

function wireChrome() {
  $('auth-url').value = location.origin;
  pointDocsLinks();

  // Inside the desktop shell there is no OS title bar; we draw it.
  if (window.deskShell) {
    document.body.classList.add('shell');
    $('winbtns')?.addEventListener('click', (event) => {
      const act = event.target.closest('[data-win]')?.dataset.win;
      if (act === 'min') window.deskShell.minimize();
      else if (act === 'max') window.deskShell.toggleMaximize();
      else if (act === 'close') window.deskShell.close();
    });
    // The pairing screen's own title bar (1.5.6).
    $('auth-winbtns')?.addEventListener('click', (event) => {
      const act = event.target.closest('[data-win]')?.dataset.win;
      if (act === 'min') window.deskShell.minimize();
      else if (act === 'max') window.deskShell.toggleMaximize();
      else if (act === 'close') window.deskShell.close();
    });
  }
  // Settings → 边界 → 命令隔离 on Windows (1.5.7): make the lamplit-runner account.
  // 成本: every machine, or only this one (1.5.10).
  $('usage-scope')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-scope]');
    if (!btn) return;
    state.usageScope = btn.dataset.scope;
    for (const b of $('usage-scope').querySelectorAll('button')) b.classList.toggle('on', b === btn);
    loadUsage().catch(() => {});
  });
  $('runner-setup')?.addEventListener('click', () => setupRunnerAccount());
  $('auth-back')?.addEventListener('click', async () => {
    const res = await window.desk.useLocal().catch((err) => ({ ok: false, error: err.message }));
    if (res && res.ok === false) setAuthMsg(res.error || '回不去这台电脑，重启 Lamplit 试试。');
  });

  // topbar / drawers
  $('nav-toggle').addEventListener('click', () => {
    if ($('sidebar').classList.contains('open')) closeSidebar();
    else { closePanel(); chatNav.left(); openSidebar(); }
  });
  $('sidebar-close').addEventListener('click', closeSidebar);
  $('home-search')?.addEventListener('input', filterHome);
  $('roster-search')?.addEventListener('input', filterHome);
  // 「它在外面怎么连」 (1.5.43): the Tailscale key appears with Tailscale.
  document.querySelectorAll('input[name="vnc-outside"]').forEach((r) => r.addEventListener('change', syncOutsideChoice));
  $('sidebar-scrim').addEventListener('click', closeSidebar);

  // openSettings looks at what is open first, then closes it (1.5.56: shut here, the home list was lost).
  $('settings-btn').addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-back')?.addEventListener('click', () => { settingsNav.toHome(); showSettingsHome(); });
  window.addEventListener('popstate', onNavPopState);
  decorateSettingsNav();
  cardifySettings();
  $('settings-scrim').addEventListener('click', closeSettings);
  // Settings is a page beside the sidebar: picking a chat there goes back to it.
  $('sidebar')?.addEventListener('click', (e) => {
    if (state.settingsOpen && !isMobile() && e.target.closest('.bot, .group')) closeSettings();
  });
  document.querySelectorAll('.setnav').forEach((btn) => {
    btn.addEventListener('click', () => { settingsNav.sectionPicked(btn.dataset.setTarget); setSettingsNav(btn.dataset.setTarget); });
  });

  $('mock-banner-btn').addEventListener('click', () => openSettings('sec-model'));
  $('group-delete-btn')?.addEventListener('click', deleteCurrentGroup);
  $('confirm-ok')?.addEventListener('click', () => settleConfirm(true));
  $('confirm-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); settleConfirm(true); } });
  $('confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  $('confirm-close')?.addEventListener('click', () => settleConfirm(false));
  $('confirm-scrim')?.addEventListener('click', () => settleConfirm(false));
  $('approvals-pill').addEventListener('click', () => {
    const pill = $('approvals-pill');
    // Another machine is waiting too (1.5.41): the inbox shows every card, its own and the others'.
    if (pill.dataset.remote) {
      openInbox();
    } else if (pill.dataset.bot || pill.dataset.approvalId) {
      focusApprovalCard(pill.dataset.approvalId, pill.dataset.bot);
    } else {
      state.panelOpen = true;
      applyLayoutPrefs();
      openPanel('activity');
    }
  });
  $('pc-monitor')?.addEventListener('change', () => pickScreen().catch(() => {}));
  $('pc-refresh').addEventListener('click', () => {
    if ($('pc-vnc-wrap')?.querySelector('iframe')) {
      $('pc-vnc-wrap').innerHTML = '';
      viewerUrl = '';
    }
    loadComputer();
    refreshScreen();
    syncViewer();
  });
  $('pc-desktop').addEventListener('click', () => {
    if (desktopTakeover()) closeDesktopViewer();
    else openDesktopViewer();
  });
  $('pc-preview-take').addEventListener('click', () => openDesktopViewer());
  $('pc-vnc-shield').addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (isMobile() && !desktopTakeover()) togglePanelMax(true);
  });
  const vncUI = () => document.querySelector('#pc-vnc-wrap iframe')?.contentWindow?.UI || null;
  // Touching the button must not take focus from the remote keyboard's input:
  // that would close the keyboard first, and the tap would open it again.
  $('pcm-key').addEventListener('pointerdown', (event) => event.preventDefault());
  $('pcm-key').addEventListener('mousedown', (event) => event.preventDefault());
  $('pcm-key').addEventListener('click', (event) => {
    // A toggle: the keyboard comes up only from this button and goes away from it.
    const ui = vncUI();
    const doc = document.querySelector('#pc-vnc-wrap iframe')?.contentDocument;
    const input = doc?.getElementById('noVNC_keyboardinput');
    if (!ui) return;
    const open = (input && doc.activeElement === input) || document.body.classList.contains('kb-open');
    if (open) {
      ui.hideVirtualKeyboard();
      input?.blur();
    } else ui.showVirtualKeyboard();
    const btn = event.currentTarget;
    setTimeout(() => btn.classList.toggle('on', !open && Boolean(input && doc.activeElement === input)), 80);
  });
  setupPhoneTouch();
  $('pcm-ctrl').addEventListener('click', (event) => { vncUI()?.toggleCtrl(); event.currentTarget.classList.toggle('on'); });
  $('pcm-alt').addEventListener('click', (event) => { vncUI()?.toggleAlt(); event.currentTarget.classList.toggle('on'); });
  $('pcm-esc').addEventListener('click', () => vncUI()?.sendKey(0xff1b, 'Escape'));
  $('pcm-tab').addEventListener('click', () => vncUI()?.sendKey(0xff09, 'Tab'));
  $('pcm-clip').addEventListener('click', openClipDrawer);
  $('pcm-rot').addEventListener('click', () => { toggleRotate(); });
  $('pcm-view').addEventListener('click', () => { exitLandscape(); closeDesktopViewer(); });
  $('clip-close').addEventListener('click', closeClipDrawer);
  $('clip-scrim').addEventListener('click', closeClipDrawer);
  const sendClip = async (paste) => {
    const ui = vncUI();
    if (!ui?.rfb) { toast('画面还没连上', true); return null; }
    const res = await pushRemoteClip(ui.rfb, $('clip-text').value, { paste });
    if (res.lossy) toast(paste ? '这台机器的剪贴板和浏览器都放不进中文，会变成 ?，请用「键盘」输入' : '中文放不进这台机器的剪贴板（会变成 ?）：点「发送并 Ctrl+V」直接输入到机器人的浏览器', true);
    return res.ok ? { ui, typed: res.typed } : null;
  };
  $('clip-send').addEventListener('click', async () => {
    if (await sendClip(false)) toast('已放入远端剪贴板：在远端按 Ctrl+V 粘贴');
  });
  $('clip-paste').addEventListener('click', async () => {
    const sent = await sendClip(true);
    if (!sent) return;
    closeClipDrawer();
    if (sent.typed) { toast('已输入到机器人的浏览器'); return; }
    const { ui } = sent;
    ui.sendKey(0xffe3, 'ControlLeft', true);
    ui.sendKey(0x76, 'KeyV');
    ui.sendKey(0xffe3, 'ControlLeft', false);
  });
  $('clip-mine')?.addEventListener('click', async () => {
    const text = await phoneClipRead();
    if (text) $('clip-text').value = text;
    else toast('手机剪贴板是空的，或读不到：请长按文本框粘贴', true);
  });
  $('clip-copy').addEventListener('click', async () => {
    const box = $('clip-text');
    try {
      if (!(await phoneClipWrite(box.value))) { box.focus(); box.select(); document.execCommand('copy'); }
      toast('已复制到手机剪贴板');
    } catch { toast('复制失败：请长按文本框手动复制', true); }
  });
  $('pc-max').addEventListener('click', () => togglePanelMax());
  $('pc-exit').addEventListener('click', () => togglePanelMax(false));
  // No Esc key on a phone.
  if (window.matchMedia?.('(pointer: coarse)').matches) $('pc-exit').textContent = '退出全屏';
  $('pc-done')?.addEventListener('click', finishTakeover);
  $('conn-retry')?.addEventListener('click', () => pollHealth());
  $('conn-local')?.addEventListener('click', () => switchMachine(''));
  // machines: sidebar switcher + Settings → 机器
  $('machine-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    renderMachineMenu();
    toggleMenu($('machine-menu'), $('machine-btn'));
    refreshMachines();
    // What each machine is for (1.5.59): the notes, when not read in the last minute.
    if (Date.now() - machineNotesUi.at > 60000) loadMachineNotes().then(() => { if (!$('machine-menu').hidden) renderMachineMenu(); });
  });
  $('machine-menu').addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item || item.disabled) return;
    closeMenus();
    if (item.dataset.machineAdd) { openMachineModal(); return; }
    if (item.dataset.appMachines) { try { window.NightshiftShell?.showMachines?.(); } catch { /* old app */ } return; }
    if (item.dataset.backOrigin) { location.assign(item.dataset.backOrigin); return; }
    if (item.dataset.handoffMenu) { handoffToMachine(item.dataset.handoffMenu, item); return; }
    if (item.dataset.view || item.dataset.machine !== undefined) pickMachineRow(item);
  });
  $('set-machines-list')?.addEventListener('click', onMachineListClick);
  // Opened from 设置 → 机器: Cancel goes back there (1.5.54, walkthrough 5.3).
  $('set-add-machine')?.addEventListener('click', () => { closeSettings(); openMachineModal(); state.machineFromSettings = true; });
  document.querySelector('[data-open-machines]')?.addEventListener('click', (event) => { event.preventDefault(); openSettings('sec-machines'); });
  $('vnc-modal-close').addEventListener('click', cancelMachineModal);
  $('vnc-cancel').addEventListener('click', cancelMachineModal);
  $('vnc-scrim').addEventListener('click', cancelMachineModal);
  $('about-update-btn')?.addEventListener('click', () => checkForUpdate({ fresh: true, manual: true }));
  $('vnc-save').addEventListener('click', saveMachineFromModal);
  // 「它是哪台？」 (1.5.42): a tap fills the name; 「自己写」 puts the cursor there.
  $('vnc-name-chips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-name]');
    if (!chip) return;
    for (const c of document.querySelectorAll('#vnc-name-chips [data-name]')) c.classList.toggle('on', c === chip);
    if (chip.dataset.name === '*') { $('vnc-name').value = ''; $('vnc-name').focus(); return; }
    $('vnc-name').value = chip.dataset.name;
    // A cloud server usually logs in as ubuntu; a computer at home as you (1.5.54, walkthrough 5.1).
    const kind = chip.dataset.name === '云服务器' ? 'cloud' : 'home';
    $('vnc-ssh-user').value = kind === 'cloud' ? 'ubuntu' : '';
    $('vnc-ssh-user').placeholder = kind === 'cloud' ? 'ubuntu 或 root' : '你登录那台电脑用的用户名';
  });
  $('vnc-modal').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) {
      event.preventDefault();
      saveMachineFromModal();
    }
  });
  wireChromeResizers();
  // Esc closes the machine dialog first, then the full-window desktop view.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('vnc-modal')?.classList.contains('open')) { cancelMachineModal(); return; }
    if (document.body.classList.contains('panel-max')) togglePanelMax(false);
  });
  document.querySelectorAll('input[name="approval-level"]').forEach((radio) => {
    radio.addEventListener('change', () => { if (radio.checked) savePolicy({ level: radio.value }); });
  });
  $('perm-strict')?.addEventListener('click', applyStrictPermissions);
  $('usage-save')?.addEventListener('click', saveUsageForm);
  $('usage-range')?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => loadUsage(Number(btn.dataset.days)));
  });
  $('vault-new-save')?.addEventListener('click', saveNewVaultEntry);
  setupMcpForm();
  $('folder-add-btn')?.addEventListener('click', async () => {
    const p = $('folder-input').value.trim();
    if (!p) return;
    if (await savePolicy({ addFolder: { path: p, write: $('folder-write').checked } }, '已开放')) { $('folder-input').value = ''; $('folder-write').checked = false; }
  });
  $('folder-outside')?.addEventListener('change', (e) => savePolicy({ outside: e.target.value }, '已保存'));
  $('sudo-mode')?.addEventListener('change', (e) => savePolicy({ sudo: e.target.value }, '已保存'));
  $('read-guard')?.addEventListener('change', (e) => savePolicy({ readGuard: e.target.checked }, e.target.checked ? '已打开：读过网页、邮件后，发出去和改东西的操作先问你' : '已关闭：读过网页、邮件后不再额外先问'));
  $('trust-primary')?.addEventListener('change', (e) => savePolicy({ trustPrimary: e.target.checked }, e.target.checked ? '已打开：主助理只有危险命令还会问你' : '已关闭：主助理的 sudo 和其他位置恢复先问'));
  $('feishu-save')?.addEventListener('click', saveFeishu);
  $('feishu-app-save')?.addEventListener('click', addFeishuApp);
  $('desktop-mode')?.addEventListener('change', saveDesktopMode);
  $('desktop-full-install')?.addEventListener('click', installFullDesktop);
  $('feishu-newcode')?.addEventListener('click', async () => { try { renderFeishu(await api('/api/feishu', { method: 'PUT', body: { newPairCode: true } })); } catch (err) { toast(err.message, true); } });
  $('mp-save')?.addEventListener('click', saveNewModel);
  $('mp-list')?.addEventListener('click', listKeyModels);
  $('mp-filter')?.addEventListener('input', renderModelPicks);
  $('mp-add-picked')?.addEventListener('click', addPickedModels);
  $('mp-provider')?.addEventListener('change', () => { $('mp-pick').hidden = true; state.mpOptions = []; });
  $('mp-test')?.addEventListener('click', testNewModel);
  $('mp-provider')?.addEventListener('change', () => fillModelPreset(true));
  document.querySelectorAll('#audit-filters .chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      auditView = btn.dataset.view;
      document.querySelectorAll('#audit-filters .chip-btn').forEach((b) => b.classList.toggle('on', b === btn));
      loadAudit();
    });
  });
  document.querySelectorAll('input[name="generate-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const said = { level: '生成图片和视频：跟随审批级别', ask: '生成图片和视频：每次先问我', auto: '生成图片和视频：直接生成' }[radio.value];
      savePolicy({ generate: radio.value }, said);
    });
  });
  document.querySelectorAll('input[name="takeover-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      savePolicy({ takeover: radio.value }, radio.value === 'view' ? '接管桌面改为「只能看」' : '接管桌面改为「能看能控」')
        .then(() => syncViewer());
    });
  });
  const addDeny = () => {
    const input = $('deny-input');
    const text = input.value.trim();
    if (!text) return;
    savePolicy({ addDeny: text }, `已添加：${text}`).then((saved) => { if (saved) input.value = ''; });
  };
  $('deny-add-btn')?.addEventListener('click', addDeny);
  const addRule = () => {
    const input = $('rule-input');
    const text = input.value.trim();
    if (!text) return;
    savePolicy({ addRule: { text, action: $('rule-action').value } }, `已添加规则：${text}`).then((saved) => { if (saved) input.value = ''; });
  };
  $('rule-add-btn')?.addEventListener('click', addRule);
  $('rule-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addRule(); } });
  $('deny-input')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addDeny(); } });
  // A table wider than its box fades at the right edge until scrolled to the end (1.5.54, walkthrough 4.3).
  const markScroll = (w) => { w.classList.toggle('scrolls', w.scrollWidth > w.clientWidth + 4); w.classList.toggle('at-end', w.scrollLeft + w.clientWidth >= w.scrollWidth - 4); };
  document.addEventListener('scroll', (event) => { const w = event.target?.closest?.('.perm-table-wrap'); if (w) markScroll(w); }, true);
  let markQueued = false;
  new MutationObserver(() => { if (markQueued) return; markQueued = true; requestAnimationFrame(() => { markQueued = false; document.querySelectorAll('.perm-table-wrap').forEach(markScroll); }); }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => document.querySelectorAll('.perm-table-wrap').forEach(markScroll));
  $('panel-toggle').addEventListener('click', () => {
    if (state.panelOpen) { closePanel(); return; }
    state.panelOpen = true;
    try { localStorage.setItem('desk.panelOpen', '1'); } catch { /* private mode */ }
    applyLayoutPrefs();
    openPanel('activity');
  });
  $('show-process').addEventListener('change', (event) => {
    state.showProcess = Boolean(event.target.checked);
    try { localStorage.setItem('desk.showProcess', state.showProcess ? '1' : '0'); } catch { /* private mode */ }
    renderMessages();
    // Shown steps want their whole output, which the compact chat left on the machine.
    if (state.showProcess && !isGroupMode()) loadMessages();
  });
  $('panel-close').addEventListener('click', closePanel);
  $('panel-scrim').addEventListener('click', closePanel);
  $('panel-grip').addEventListener('click', closePanel);

  // panel tabs + bottom nav
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  document.querySelectorAll('.navitem').forEach((item) => {
    item.addEventListener('click', () => {
      const name = item.dataset.tab;
      const open = $('panel').classList.contains('open');
      if (open && state.tab === name) closePanel();
      else openPanel(name);
    });
  });

  // composer
  $('attach-btn').addEventListener('click', () => $('attach-input').click());
  $('attach-input').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
  $('composer').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  const dropZone = document.querySelector('.chat');
  dropZone?.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); dropZone.classList.add('dragging'); } });
  dropZone?.addEventListener('dragleave', (event) => { if (event.target === dropZone) dropZone.classList.remove('dragging'); });
  dropZone?.addEventListener('drop', (event) => {
    dropZone.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files); }
  });
  $('send-btn').addEventListener('click', send);
  $('botedit-primary')?.addEventListener('click', makePrimary);
  $('stop-btn')?.addEventListener('click', stopWorking);
  // capture phase: the picker sees Enter before "send" does
  $('composer').addEventListener('keydown', onMentionKey, true);
  $('composer').addEventListener('input', () => { mention.index = 0; updateMention(); });
  $('composer').addEventListener('click', updateMention);
  $('composer').addEventListener('blur', () => setTimeout(closeMention, 150));
  $('mic-btn').addEventListener('click', toggleVoice);
  $('call-btn').addEventListener('click', toggleCall);
  $('call-end').addEventListener('click', endCall);
  // Too noisy to hear the end: send what was said now.
  // While it reads: 「打断」 stops the reading and it listens at once. Otherwise: send what was said now.
  $('call-done').addEventListener('click', () => {
    if (!call.on || call.cutting) return;
    if (call.deaf) { stopSpeaking(); call.readEnded = 0; setCallPhase('listen'); return; }
    if (call.heard) cutUtterance();
  });
  // Every key and password box: hidden by default, a button shows what was typed.
  addRevealButtons(document);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) addRevealButtons(n);
  }).observe(document.body, { childList: true, subtree: true });
  $('voice-save')?.addEventListener('click', () => saveVoice(false));
  $('vnc-addr')?.addEventListener('input', updatePublicHint);
  $('ts-go')?.addEventListener('click', installTailscale);
  // The Tailscale card (1.5.43): each step asks first.
  $('tsx-install')?.addEventListener('click', installTailscaleHere);
  $('tsx-login')?.addEventListener('click', loginTailscaleHere);
  $('tsx-uninstall')?.addEventListener('click', uninstallTailscaleHere);
  $('tsx-share')?.addEventListener('click', shareTailscale);
  $('busy-close')?.addEventListener('click', () => { busyWatch.dismissed = true; $('busy-banner').hidden = true; });
  setTimeout(checkBusy, 20000);
  $('botedit-voice-try')?.addEventListener('click', async () => {
    const bot = botById(state.botEditingId);
    const picked = $('botedit-voice').value;
    stopSpeaking();
    try { await speakText(`你好，我是${bot?.name || '助理'}。这是我朗读回复时的声音。`, null, picked ? { voice: picked } : {}); } catch (err) { toast(`朗读失败：${err.message}`, true); }
  });
  $('tts-auto')?.addEventListener('change', () => {
    try { localStorage.setItem('desk.readAloud', $('tts-auto').value); } catch { /* private window */ }
  });
  $('speak-stop')?.addEventListener('click', stopSpeaking);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (speech.playing || speech.loading)) stopSpeaking();
  });
  $('voice-provider')?.addEventListener('change', () => applyVoiceProvider(true));
  $('vision-save')?.addEventListener('click', () => saveVision(false));
  for (const kind of ['image', 'video']) {
    $(`media-${kind}-save`)?.addEventListener('click', () => saveMediaKind(kind, false));
    $(`media-${kind}-clear`)?.addEventListener('click', () => saveMediaKind(kind, true));
    $(`media-${kind}-service`)?.addEventListener('change', () => applyMediaService(kind, true));
  }
  $('vision-clear')?.addEventListener('click', () => saveVision(true));
  $('vision-provider')?.addEventListener('change', () => applyVisionProvider(true));
  $('cliagents-refresh')?.addEventListener('click', () => loadCliAgents(true).catch(() => {}));
  $('voice-clear')?.addEventListener('click', () => saveVoice(true));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && !state.settingsOpen) {
      event.preventDefault();
      toggleVoice();
    } else if (event.key === 'Escape' && voice.recorder) {
      event.preventDefault();
      stopRecording(true);
    }
  });
  $('composer').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  $('composer').addEventListener('input', (event) => autoGrow(event.target));
  watchComposerValue();
  $('composer').addEventListener('focus', () => {
    setTimeout(() => { if (isMobile()) scrollToBottom(true); }, 260);
  });

  // bots
  $('new-bot-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu($('new-menu'), $('new-bot-btn'));
  });
  $('new-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-act]');
    if (!item || item.disabled) return;
    closeMenus();
    if (item.dataset.act === 'group') { openGroupModal(); return; }
    const form = $('bot-form');
    fillBotWhere();
    form.classList.add('open');
    $('new-bot-name').focus();
  });
  $('new-bot-cancel').addEventListener('click', () => {
    $('bot-form').classList.remove('open');
    $('new-bot-name').value = '';
    $('new-bot-role').value = '';
  });
  $('new-bot-save').addEventListener('click', async () => {
    const name = $('new-bot-name').value.trim();
    if (!name) { toast('先给这个助手起个名字', true); return; }
    // 「建在哪台？」 (1.5.44): '' is this machine.
    const where = $('new-bot-where-row').hidden ? '' : $('new-bot-where').value;
    try {
      const res = await api(where ? `/api/peers/${encodeURIComponent(where)}/bots` : '/api/bots', {
        method: 'POST',
        body: {
          name,
          role: $('new-bot-role').value.trim(),
          // UI-level language rule: the backend has no locale switch yet, so
          // the persona is where "always answer in Chinese" lives.
          persona: window.deskI18n?.lang === 'en'
            ? 'Always reply in English. Keep technical terms, commands, paths, code and error text as they are.'
            : '始终使用简体中文回答。技术名词、命令、路径、代码和报错原文保持原样。',
        },
      });
      if (where) { await botMadeThere(where, res); return; }
      state.bots = await api('/api/bots');
      renderBots();
      renderRoutines();
      $('new-bot-cancel').click();
      toast('助手已创建');
      // Opened at once, like a new group (1.5.54, walkthrough 3.2).
      const made = res?.bot;
      if (made?.id) selectBot(made.id);
    } catch (err) {
      // The pairing box says it, and makes it once paired: then the form closes and it opens (1.5.44 test).
      if (err.code === 'LOCAL_KEY_REQUIRED') { if (where && state.afterPair) state.afterPair.then = (res) => botMadeThere(where, res); return; }
      toast(where && err.code !== 'BOT_EXISTS' ? `在「${where}」上没建成：${err.message}。也可以在左上角切到「${where}」再建。` : err.message, true);
    }
  });
  // Enter in the name or the role box creates it, like the button (1.5.41 test).
  for (const id of ['new-bot-name', 'new-bot-role']) {
    $(id)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('new-bot-save').click(); }
    });
  }

  // group dialog
  $('group-close').addEventListener('click', closeGroupModal);
  $('group-cancel').addEventListener('click', closeGroupModal);
  $('group-scrim').addEventListener('click', closeGroupModal);
  $('group-create').addEventListener('click', createGroup);
  $('group-delete').addEventListener('click', () => { if (state.groupDraft?.id) deleteGroup(state.groupDraft.id); });
  // Click the chat's name to open its details (Grok-style): a bot's profile,
  // or a group's name, members and coordinator.
  document.querySelector('.chat-title-text')?.addEventListener('click', () => {
    if (state.groupId) openGroupModal(state.groupId);
    else if (state.botId) openBotEdit(state.botId);
  });
  $('group-name').addEventListener('input', (event) => {
    state.groupDraft.name = event.target.value;
    $('group-create').disabled = !(state.groupDraft.name.trim() && state.groupDraft.members.length >= 2);
  });
  $('group-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); createGroup(); }
  });

  // bot management
  $('botedit-close').addEventListener('click', closeBotEdit);
  $('botedit-scrim').addEventListener('click', closeBotEdit);
  $('botedit-save').addEventListener('click', saveBotEdit);
  $('botedit-delete').addEventListener('click', deleteBotFlow);
  $('botedit-avatar').addEventListener('click', () => {
    const id = state.botEditingId;
    closeBotEdit();
    if (id) openAvatarCustomizer(id);
  });
  $('botedit-name-input').addEventListener('input', () => {
    state.deleteArmed = false;
    $('botedit-delete').textContent = '删除这个助手';
  });
  $('botedit-name-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); saveBotEdit(); }
  });

  // A link in a reply opens in this device's own browser (1.5.41): the phone's, the desktop's.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a.ext-link');
    if (!link || !/^https?:/i.test(link.href) || event.defaultPrevented) return;
    event.preventDefault();
    openLinkHere(link.href);
  });

  // clicking anywhere else closes popover menus
  document.addEventListener('click', (event) => {
    if (event.target.closest('.menu') || event.target.closest('#new-bot-btn') || event.target.closest('.bot-more')) return;
    closeMenus();
  });

  // 「有什么在等你」 once a day (1.5.45)
  for (const id of ['nudge-on', 'nudge-time']) $(id)?.addEventListener('change', () => saveNudge().catch((err) => { if (!err.quiet) toast(err.message, true); }));
  // daily briefing
  for (const id of ['brief-on', 'brief-time', 'brief-feishu']) {
    $(id)?.addEventListener('change', () => saveBriefing()
      .then((b) => { if (id === 'brief-on') toast(b.enabled ? `每日简报已开启：每天 ${b.time}` : '每日简报已关闭'); })
      .catch((err) => toast(err.message, true)));
  }
  $('brief-try')?.addEventListener('click', async () => {
    const btn = $('brief-try');
    btn.disabled = true;
    btn.textContent = '正在写简报…';
    try {
      const b = state.briefing?.routineId ? state.briefing : await saveBriefing();
      const res = await api(`/api/routines/${encodeURIComponent(b.routineId)}/test`, { method: 'POST', body: {} });
      toast(res.run.status === 'success' ? '简报写好了，在助理的对话里' : `简报没写成：${runStatusLabel(res.run.status)}`, res.run.status !== 'success');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '现在试一次';
      loadRoutines();
    }
  });

  // routines
  // 全部: every routine on the machine instead of the chat's own.
  $('rt-scope')?.addEventListener('change', () => renderRoutines());
  // The routine form's peak-hour hint follows the time and the box (1.5.54).
  $('rt-schedule')?.addEventListener('input', routinePeakHint);
  $('rt-off-peak')?.addEventListener('change', routinePeakHint);
  // 「设置 → 主动」 from the task panel (1.5.54: one daily note, said where it lives).
  document.querySelector('[data-open-initiative]')?.addEventListener('click', (event) => { event.preventDefault(); openSettings('sec-initiative'); });
  $('new-routine-btn').addEventListener('click', () => {
    const card = $('routine-form-card');
    const hidden = card.style.display === 'none' || !card.style.display;
    card.style.display = hidden ? 'block' : 'none';
    if (hidden) $('rt-name').focus();
  });
  $('rt-cancel').addEventListener('click', () => { $('routine-form-card').style.display = 'none'; });
  $('rt-save').addEventListener('click', createRoutine);
  $('memory-refresh').addEventListener('click', () => { loadMemory(); loadActivity(); });

  $('model-sync')?.addEventListener('click', syncModelToMachines);
  // settings form
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettings();
  });
  $('set-test').addEventListener('click', testConnection);
  $('set-clear-key').addEventListener('click', clearKey);
  $('set-apikey').addEventListener('input', () => loadLiveModels(900));
  $('set-baseurl').addEventListener('change', () => loadLiveModels());
  $('set-provider').addEventListener('change', () => {
    const provider = $('set-provider').value;
    const preset = (state.providers || []).find((p) => p.name === provider);
    renderProviderHints(provider);
    if (provider === 'mock') {
      $('key-state').textContent = '演示模式不需要密钥。';
    } else if (preset && preset.needsKey === false) {
      $('key-state').textContent = `${preset.label} 在本机运行，不需要密钥。`;
      if (preset.baseUrl) $('set-baseurl').value = preset.baseUrl;
      if (!$('set-model').value && preset.models[0]) $('set-model').value = preset.models[0];
    } else {
      const m = (state.settings && state.settings.model) || {};
      $('key-state').textContent = m.hasKey ? '已保存密钥。留空表示保持不变。' : '尚未保存密钥。';
      if (preset) {
        if (preset.baseUrl) $('set-baseurl').value = preset.baseUrl;
        if (!$('set-model').value && preset.models[0]) $('set-model').value = preset.models[0];
        const link = $('provider-keyurl');
        if (link) {
          link.textContent = preset.keyUrl ? `在 ${preset.label} 申请密钥 →` : '';
          link.href = preset.keyUrl || '#';
          link.hidden = !preset.keyUrl;
        }
      }
      if (!$('set-apikey').value) $('set-apikey').focus();
    }
  });

  // pairing
  $('pair-copy-url').addEventListener('click', () => copyText($('pair-url').textContent.trim(), '地址已复制'));
  $('pair-copy-tailnet')?.addEventListener('click', () => copyText($('pair-tailnet').textContent.trim(), '地址已复制'));
  $('pair-copy-code').addEventListener('click', () => {
    const raw = ((state.settings && state.settings.pairing) || state.pairing || {}).code
      || $('pair-code').textContent.replace(/\s+/g, '');
    copyText(raw, '配对码已复制');
  });

  // 手机和外网: QR dialog, device list, the desktop-only remote switch
  $('phone-connect')?.addEventListener('click', () => showPairDialog());
  $('funnel-enabled')?.addEventListener('change', (event) => setFunnel(event.target.checked));
  $('funnel-retry')?.addEventListener('click', () => setFunnel(Boolean($('funnel-enabled')?.checked ?? true)));
  $('funnel-copy')?.addEventListener('click', async () => {
    const text = $('funnel-url')?.textContent || '';
    try {
      if (!(await phoneClipWrite(text))) {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('已复制');
    } catch {
      toast('复制失败', true);
    }
  });
  $('pair-modal-close')?.addEventListener('click', () => pairModalOpen(false));
  // A browser on this computer pairs itself to decide approvals (1.5.32).
  $('local-pair-close')?.addEventListener('click', () => localPairOpen(false));
  $('local-pair-scrim')?.addEventListener('click', () => localPairOpen(false));
  $('local-pair-go')?.addEventListener('click', () => pairThisBrowser());
  // The inbox: every card waiting on you, this machine's and the others' (1.5.41).
  $('inbox-close')?.addEventListener('click', () => inboxOpen(false));
  $('inbox-scrim')?.addEventListener('click', () => inboxOpen(false));
  $('local-pair-code')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); pairThisBrowser(); } });
  $('pair-scrim')?.addEventListener('click', () => pairModalOpen(false));
  $('qr-refresh')?.addEventListener('click', () => requestPairLink(state.pairLinksPrefer || ''));
  $('qr-copy')?.addEventListener('click', () => copyText($('qr-url').textContent.trim(), '链接已复制'));
  $('allow-remote')?.addEventListener('change', (event) => applyRemoteSwitch(event.target.checked));
  $('firewall-fix')?.addEventListener('click', () => fixFirewall());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('pair-modal')?.classList.contains('open')) pairModalOpen(false);
  });

  // avatar customizer
  $('chat-avatar').addEventListener('click', () => {
    if (state.botId) openAvatarCustomizer(state.botId);
  });
  $('avatar-close').addEventListener('click', closeAvatarCustomizer);
  $('avatar-scrim').addEventListener('click', closeAvatarCustomizer);
  $('avatar-upload-btn').addEventListener('click', () => $('avatar-file').click());
  $('avatar-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) uploadAvatarFile(file);
  });
  $('avatar-remove-btn').addEventListener('click', removeAvatarImage);
  $('avatar-reset').addEventListener('click', resetAvatar);

  // auth screen
  $('auth-connect').addEventListener('click', connectDevice);
  $('auth-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); connectDevice(); }
  });
  $('auth-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('auth-code').focus(); }
  });

  // global keys
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('local-pair-modal')?.classList.contains('open')) { localPairOpen(false); return; }
    if (inboxIsOpen()) { inboxOpen(false); return; }
    if ($('group-modal').classList.contains('open')) { closeGroupModal(); return; }
    if (state.botEditingId) { closeBotEdit(); return; }
    if (state.avatarBotId) { closeAvatarCustomizer(); return; }
    if (document.querySelector('.menu:not([hidden])')) { closeMenus(); return; }
    if (state.settingsOpen) { closeSettings(); return; }
    if ($('panel').classList.contains('open')) { closePanel(); return; }
    if ($('sidebar').classList.contains('open')) { closeSidebar(); return; }
  });

  // responsive + lifecycle
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', onViewportModeChange);
  else if (mqMobile.addListener) mqMobile.addListener(onViewportModeChange);
  onViewportModeChange();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { exitLandscape(); return; }
    if (authShown) return;
    if (state.stream && state.stream.readyState === 2) connectStream();
    pollHealth();
    if (state.botId && !state.liveTurn) { refreshPendingApprovals(); }
  });
}

/* ---------------------------------------------------------------------
   go
   --------------------------------------------------------------------- */
try {
  state.mockAck = sessionStorage.getItem('desk.mockAck') === '1';
} catch { state.mockAck = false; }

installAvatarStyles();

boot().catch((err) => {
  showFatal(err);
});

// Small read-only debug surface: useful in the field, harmless in production.
window.__desk = {
  state,
  reload: () => location.reload(),
  showAuthScreen: enterAuth,
  refreshModel: () => { renderSettingsForm(); renderPairing(); updateModelUi(); renderMessages(); },
  openAvatar: openAvatarCustomizer,
  avatarShapes: AVATAR_SHAPES,
  faceSvg,
  renderMessages,
};

/** Closed without adding: back to 设置 → 机器 when it was opened from there. */
function cancelMachineModal() {
  closeMachineModal();
  if (state.machineFromSettings) openSettings('sec-machines');
  state.machineFromSettings = false;
}

/* settings-nav:start */
/**
 * Phone: where 设置 was opened from, and the back key inside it (1.5.56). Closing 设置 used to
 * land in 助理's chat whatever was open before (the home list, the 任务 / 电脑 panel), and the
 * back key left the app. Now each level of 设置 is one history step: a page (and a page opened
 * from it, e.g. 体检 → 「去设置模型」) → the settings list → back where you came from. The desktop
 * adds no history and restores nothing.
 *   env: { mobile(), view(), push(name), back(steps) }
 */
function makeSettingsNav(env) {
  let origin = null;
  let open = false;   // 设置 added its own step (the settings list)
  let pages = [];     // the pages opened in it, one history step each
  let ignore = 0;     // steps this code took back itself (✕, the ‹ arrow): their popstate is not the back key
  const page = (section) => { if (section && pages[pages.length - 1] !== section) { env.push('section'); pages.push(section); } };
  return {
    /** 设置 opened (already: it was open, and a page is opened from the list or from another page). */
    opened(section, already) {
      if (!env.mobile()) { if (!already) origin = null; return; }
      if (!already || !open) { origin = already ? origin : env.view(); env.push('settings'); open = true; pages = []; }
      page(section);
    },
    /** A page picked in the settings list. */
    sectionPicked(section = 'page') { if (env.mobile() && open && !pages.length) page(section); },
    /** The ‹ arrow: back to the settings list (as many steps as pages). */
    toHome() { if (pages.length) { ignore += 1; env.back(pages.length); pages = []; } },
    /** 设置 closed: its steps go (unless the back key took them), and where it was opened from. */
    closed({ viaHistory = false } = {}) {
      const from = origin;
      origin = null;
      if (!viaHistory && open) { ignore += 1; env.back(1 + pages.length); }
      open = false;
      pages = [];
      return from;
    },
    /** A history step went back: 'page:<id>' (the page before), 'home' (the list), 'close', 'ignore' (ours) or 'none'. */
    popped() {
      if (ignore) { ignore -= 1; return 'ignore'; }
      if (pages.length > 1) { pages.pop(); return `page:${pages[pages.length - 1]}`; }
      if (pages.length === 1) { pages.pop(); return 'home'; }
      if (open) return 'close';
      return 'none';
    },
  };
}

/**
 * Phone: a chat opened from the home list is one history step, so the back key shows the home
 * list again (it left the app). Back on the home list leaves the app, as before. Settings' steps
 * sit on top of it and go first. The desktop adds nothing.
 *   env: { mobile(), push(name), back(steps) }
 */
function makeChatNav(env) {
  let inChat = false; // the chat's step is in the history
  let ignore = 0;     // the chat's ‹ took it back itself
  return {
    /** A chat opened from the home list (another one from inside a chat adds nothing). */
    entered() { if (env.mobile() && !inChat) { env.push('chat'); inChat = true; } },
    /** The chat's ‹: back to the home list by the page itself. */
    left() { if (inChat) { inChat = false; ignore += 1; env.back(1); } },
    /** A history step went back: 'home', 'ignore' (ours) or 'none' (not ours: the app leaves). */
    popped() {
      if (ignore) { ignore -= 1; return 'ignore'; }
      if (inChat) { inChat = false; return 'home'; }
      return 'none';
    },
  };
}

/** What was on screen: the home list (and its search), the panel's tab, the chat. */
function settingsView() {
  const panelOpen = Boolean($('panel')?.classList.contains('open'));
  return {
    home: document.body.classList.contains('m-home'),
    search: $('home-search')?.value || '',
    panel: panelOpen ? document.querySelector('.tabs .tab.active')?.dataset.tab || 'activity' : '',
    chat: currentChatKey(),
  };
}

/** Back to it. A chat that something in 设置 opened meanwhile stays: it was asked for. */
function restoreSettingsView(from) {
  if (!from || !isMobile() || from.chat !== currentChatKey()) return;
  if (from.home) {
    openSidebar();
    if (from.search && $('home-search')) { $('home-search').value = from.search; filterHome(); }
  } else if (from.panel) openPanel(from.panel);
}
/* settings-nav:end */

const settingsNav = makeSettingsNav({
  mobile: () => isMobile(),
  view: settingsView,
  push: (name) => { try { history.pushState({ lamplit: name }, ''); } catch { /* no history: the buttons still work */ } },
  back: (steps) => { try { history.go(-steps); } catch { /* nothing to take back */ } },
});

const chatNav = makeChatNav({
  mobile: () => isMobile(),
  push: (name) => { try { history.pushState({ lamplit: name }, ''); } catch { /* no history: the ‹ still works */ } },
  back: (steps) => { try { history.go(-steps); } catch { /* nothing to take back */ } },
});

/** The back key (Android) or the browser's back: one level of 设置 first, then a chat → the home list. */
function onNavPopState() {
  const said = settingsNav.popped();
  if (said.startsWith('page:') && state.settingsOpen) setSettingsNav(said.slice(5));
  else if (said === 'home' && state.settingsOpen) showSettingsHome();
  else if (said === 'close' && state.settingsOpen) closeSettings({ viaHistory: true });
  else if (said === 'none') {
    if (chatNav.popped() === 'home') { closePanel(); openSidebar(); }
  }
}
