'use strict';
// Lamplit page, part 6 of 12: live - sending, the event stream, UI state, the working line, approvals, activity. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   sending
   --------------------------------------------------------------------- */
async function send() {
  const input = $('composer');
  const text = input.value.trim();
  if (state.pendingFiles.some((f) => f.status === 'uploading')) { toast('附件还在上传，稍等一下'); return; }
  const files = state.pendingFiles.filter((f) => f.status === 'ready');
  if ((!text && !files.length) || state.sending || composerBlocked()) return;
  if (!isGroupMode() && !state.botId) return;
  const attachments = files.map((f) => ({ path: f.path }));
  state.pendingFiles = [];
  renderAttachStrip();

  state.sending = true;
  $('send-btn').disabled = true;
  // Read the answer aloud: always, or when this question was spoken.
  const mode = readAloudMode();
  const readThis = call.on || mode === 'always' || (mode === 'voice' && voice.spokeSinceSend);
  voice.spokeSinceSend = false;
  stopSpeaking(); // a new question: whatever was being read stops
  state.readAloudTurn = readThis;
  input.value = '';
  autoGrow(input);
  closeSidebar();

  // Optimistic user bubble; the authoritative reload happens on turn.end.
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const shown = files.length
    ? `${text || '（见附件）'}${ATTACH_MARK}${files.map((f) => `- ${f.path}（${/\.(png|jpe?g|gif|webp)$/i.test(f.path) ? '图片' : '文件'}，…）`).join('\n')}`
    : text;
  messagesEl.appendChild(userRow({ text: shown, ts: new Date().toISOString() }));
  keepTypingLast();
  scrollToBottom(true);

  try {
    if (isGroupMode()) {
      await api(`/api/groups/${encodeURIComponent(state.groupId)}/message`, { method: 'POST', body: { text, attachments } });
    } else {
      await api(`/api/bots/${state.botId}/message`, { method: 'POST', body: { text, attachments, ...(call.on ? { voiceCall: true } : {}) } });
    }
  } catch (err) {
    if (err.status !== 401) toast(err.status === 404 ? '服务端还没有群组消息接口（404）' : err.message, true);
  } finally {
    state.sending = false;
    $('send-btn').disabled = false;
    updateComposerMode();
    if (!isMobile()) input.focus();
  }
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  syncComposerActions();
}

/**
 * The composer's right side (1.5.29): 🎤 and 📞 while it is empty; once there
 * is text or a file, 📞 gives its place to send. Two buttons at a time.
 */
function syncComposerActions() {
  const box = document.querySelector('.composer-box');
  const input = $('composer');
  if (!box || !input) return;
  box.classList.toggle('has-text', Boolean(input.value.trim()) || (state.pendingFiles || []).length > 0);
  // While this bot works and the box is empty: a stop button (1.5.33; the docs promised one).
  box.classList.toggle('working', Boolean(state.working && !isGroupMode()));
}

/** Is the bot on screen working? From the event stream, and once from the hub when a chat opens. */
function setWorking(on) {
  state.working = Boolean(on);
  syncComposerActions();
}
async function refreshWorking() {
  if (isGroupMode() || !state.botId) return setWorking(false);
  try {
    const turns = await api('/api/turns');
    setWorking((turns || []).some((t) => t.botId === state.botId));
  } catch { /* leave it */ }
}

/** The stop button says 「停下」: the turn stops, its task does not go on by itself, its waiting cards close. */
function stopWorking() {
  if (!state.working || state.sending) return;
  $('composer').value = '停下';
  send().finally(() => setTimeout(refreshWorking, 1500));
}
/** Every way text gets into the box (typing, voice, 「我弄好了，继续」, editing) goes through `value`. */
function watchComposerValue() {
  const input = $('composer');
  const own = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (!input || !own || input.dataset.watched) return;
  input.dataset.watched = '1';
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return own.get.call(this); },
    set(v) { own.set.call(this, v); syncComposerActions(); },
  });
  input.addEventListener('input', syncComposerActions);
  syncComposerActions();
}

/* ---------------------------------------------------------------------
   SSE — one stream per context; a group subscribes with ?groupId=
   --------------------------------------------------------------------- */
function streamKey() {
  return isGroupMode() ? `group:${state.groupId}` : 'dm';
}

function connectStream() {
  const key = streamKey();
  if (state.stream && state.streamKey === key) return;
  if (state.stream) state.stream.close();
  state.streamKey = key;
  const url = isGroupMode()
    ? `/api/stream?groupId=${encodeURIComponent(state.groupId)}`
    : '/api/stream';
  let es;
  try {
    es = new EventSource(url);
  } catch {
    return;
  }
  state.stream = es;

  es.onopen = () => { $('health-dot').className = 'dot ok'; };
  es.onerror = () => {
    $('health-dot').className = 'dot warn';
    // Check now instead of waiting for the next 15-second health poll.
    clearTimeout(state.connCheck);
    state.connCheck = setTimeout(pollHealth, 2500);
    // EventSource reconnects on its own.
  };
  es.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleEvent(data);
  };
}

/* ---------------------------------------------------------------------
   UI state reported to the server, and commands coming back from the
   primary bot. The browser owns the real state (localStorage); the server's
   copy exists so "助理，把主题换成浅色" has something to read and a channel
   to answer on.
   --------------------------------------------------------------------- */
let uiReportTimer = null;
function reportUiState() {
  clearTimeout(uiReportTimer);
  uiReportTimer = setTimeout(() => {
    if (!state.ready) return;
    const pref = timezonePref();
    api('/api/ui/state', {
      method: 'POST',
      body: {
        patch: {
          theme: themePref(),
          lang: window.deskI18n?.lang || 'zh',
          timezoneMode: pref.mode,
          timezone: effectiveTimezone(),
          machine: {
            name: machineDisplayName(),
            url: location.origin,
            local: onLocalMachine(),
          },
          machines: knownMachines(),
          panelOpen: Boolean(state.panelOpen),
          tab: state.tab || 'chat',
        },
      },
    }).catch(() => { /* an older server does not have this route */ });
  }, 300);
}

function applyUiCommand(patch = {}) {
  let touched = false;

  if (patch.theme && THEME_LABELS[patch.theme]) {
    applyTheme(patch.theme, { persist: true });
    touched = true;
  }

  if (patch.timezoneMode || patch.timezone) {
    const pref = timezonePref();
    if (patch.timezoneMode) pref.mode = patch.timezoneMode;
    if (patch.timezone) {
      pref.value = patch.timezone;
      if (!patch.timezoneMode) pref.mode = 'manual';
    }
    try { localStorage.setItem(TZ_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
    applyTimezone({ push: true });
    touched = true;
  }

  if (patch.switchMachine && patch.switchMachine.target) {
    switchMachineFor(patch.switchMachine);
    touched = true;
  }

  if (patch.tab) {
    state.panelOpen = true;
    applyLayoutPrefs();
    // On mobile the sheet only slides up via openPanel(); setting state alone
    // left the viewer mounted but parked below the viewport.
    openPanel(patch.tab);
    touched = true;
  }
  if (patch.panelOpen !== undefined) {
    state.panelOpen = Boolean(patch.panelOpen);
    applyLayoutPrefs();
    if (state.panelOpen) openPanel();
    else closePanel();
    touched = true;
  }

  if (touched) {
    toast('助理已调整界面');
    reportUiState();
  }
}

function handleEvent(ev) {
  // Roster edits are global and belong to no single chat: handle them before
  // the per-bot filter below, and keep them out of the Activity feed.
  if (ev.type === 'ui.command') {
    applyUiCommand(ev.patch || {});
    return;
  }
  if (ev.type === 'settings.changed') {
    const section = ev.section || 'model';
    if (section === 'model' && state.settings && ev.settings) state.settings.model = ev.settings;
    if (section === 'model') updateModelUi();
    const drawer = $('settings-drawer');
    if (!drawer?.classList.contains('open')) return;
    const active = document.querySelector('.setnav.active')?.dataset.setTarget || 'sec-model';
    const where = {
      model: 'sec-model', voice: 'sec-model', vision: 'sec-model', media: 'sec-model',
      policy: ['sec-run', 'sec-bounds'], usage: 'sec-usage', feishu: 'sec-feishu', mcp: 'sec-mcp',
      machines: 'sec-machines', network: 'sec-pair',
    }[section];
    if (where && ![].concat(where).includes(active)) return;
    if (section === 'model') { loadSettings().then(renderSettingsForm).catch(() => {}); loadModels().catch(() => {}); }
    if (section === 'voice') loadVoice().catch(() => {});
    if (section === 'vision') loadVision().catch(() => {});
    if (section === 'media') loadMedia().catch(() => {});
    if (section === 'policy') loadPolicy().catch(() => {});
    if (section === 'usage') loadUsage().catch(() => {});
    if (section === 'feishu') loadFeishu().catch(() => {});
    if (section === 'mcp') loadMcp().catch(() => {});
    if (section === 'machines') renderMachinesList();
    if (section === 'network') loadSettings().then(renderSettingsForm).catch(() => {});
    if (section === 'routines') loadRoutines().catch(() => {});
    return;
  }
  if (ev.type === 'usage.alert') {
    const symbol = ev.currency === 'USD' ? '$' : '¥';
    toast(`今日估算 ${symbol}${(Number(ev.cost) || 0).toFixed(2)} 已超过提醒线 ${symbol}${(Number(ev.limit) || 0).toFixed(2)}`, true);
    if ($('settings-drawer')?.classList.contains('open')) loadUsage().catch(() => {});
    return;
  }
  if (ev.type === 'roster.changed') {
    refreshRoster();
    return;
  }
  if (ev.type === 'feishu.changed') {
    if ($('settings-drawer')?.classList.contains('open')) loadFeishu().catch(() => {});
    return;
  }
  if (ev.type === 'attention.changed') {
    loadAttention();
    return;
  }
  if (ev.type === 'group.plan') {
    onPlanEvent(ev.plan);
    return;
  }
  if (ev.type === 'bot.plan') {
    // A bot's own task: a new one shows up in its open chat right away.
    onPlanEvent(ev.plan);
    if (!isGroupMode() && ev.botId === state.botId && ev.plan?.id && !document.querySelector(`.plan-card[data-plan="${cssEscape(ev.plan.id)}"]`)) {
      if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
      messagesEl.appendChild(renderItem({ role: 'plan', planId: ev.plan.id, text: '' }));
      scrollToBottom();
    }
    return;
  }
  if (ev.type === 'tool.progress') {
    // "Video queued, waited 2 min": shown in the working line, not the activity feed.
    if (chatKeyOf(ev) === currentChatKey()) showTyping(ev.botId || typingBotId(), ev.text || '正在处理…');
    return;
  }
  if (ev.type === 'tool.result' && isActionCard(ev.name) && ev.ok !== false) onActionRequest(ev);
  if (ev.type === 'approval.request') onApprovalRequest(ev);

  const key = `${ev.type}|${ev.turnId || ''}|${ev.callId || ev.approvalId || ''}|${ev.ts || ''}`;
  if (!state.seenEvents.has(key)) {
    state.seenEvents.add(key);
    if (state.seenEvents.size > 800) state.seenEvents.clear();
    addActivity(ev);
  }

  const forThis = isGroupMode()
    ? (!ev.groupId || ev.groupId === state.groupId)
    : (!ev.botId || ev.botId === state.botId);
  if (!forThis) {
    if (ev.type === 'approval.request') refreshPendingApprovals();
    return;
  }

  const sender = isGroupMode()
    ? senderOf({ from: ev.botId, name: ev.botName })
    : null;

  // A quick answer the bot gave while busy with something else: its own
  // bubble; the running turn's live state and "working…" line stay as they are.
  if (ev.aside) {
    if (ev.type === 'message' && ev.text) {
      if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
      let row;
      if (isGroupMode()) {
        const bubble = el('div', 'bubble');
        fillBubble(bubble, ev.text, false, ev.botId);
        row = groupSenderRow(sender, bubble);
      } else {
        row = assistantRow(ev.text);
      }
      row.classList.add('aside');
      messagesEl.appendChild(row);
      if (state.readAloudTurn && voice.status?.tts?.available) queueSpeech(ev.text, ev.botId);
      keepTypingLast();
      scrollToBottom();
    }
    return;
  }

  switch (ev.type) {
    case 'turn.start':
      if (isGroupMode() && ev.botId && ev.botId !== state.pcFollow) {
        state.pcFollow = ev.botId;
        if (!state.pcPinned && $('pane-computer')?.classList.contains('active')) loadComputer();
      }
      state.liveTurn = { turnId: ev.turnId, botId: ev.botId || null, bubble: null, text: '', sender };
      if (!isGroupMode() && ev.botId === state.botId && !ev.aside) setWorking(true);
      // A colleague handed this bot work: show what it asked, with its face, as it arrives.
      if (ev.fromBotId && ev.text && !isGroupMode() && ev.botId === state.botId) {
        messagesEl.appendChild(botMessageRow({ fromBot: ev.fromBotId, text: ev.text, ts: ev.ts, handoffState: 'doing' }));
      }
      // A scheduled run starting: its line, as the transcript will show it (1.5.11).
      if (ev.source === 'routine' && ev.text && !isGroupMode() && ev.botId === state.botId) {
        messagesEl.appendChild(routineRunRow({ role: 'user', source: 'routine', text: ev.text, ts: ev.ts, botId: ev.botId }));
      }
      showTyping(ev.botId || typingBotId(), '正在处理…');
      break;

    case 'tool.call':
      appendLiveChip({
        name: ev.name, args: ev.args, risk: ev.risk, ts: ev.ts, ok: true, output: null,
        pending: true, callId: ev.callId, botId: ev.botId,
      });
      break;

    case 'tool.result': {
      const chip = messagesEl.querySelector(`[data-call="${cssEscape(ev.callId || '')}"]`);
      if (chip) {
        chip.replaceWith(toolChip({
          name: ev.name, args: ev.args || {}, risk: ev.risk, ts: ev.ts,
          ok: ev.ok, output: ev.result, reason: ev.denied ? '你拒绝了这次操作' : null,
        }));
      } else {
        appendLiveChip({ name: ev.name, args: ev.args || {}, risk: ev.risk, ts: ev.ts, ok: ev.ok, output: ev.result, botId: ev.botId });
      }
      break;
    }

    case 'message.retract':
      // The hub took back what was streamed (a made-up result): drop the bubble.
      if (state.liveTurn?.bubble) {
        state.liveTurn.bubble.closest('.row')?.remove();
        state.liveTurn.bubble = null;
        state.liveTurn.text = '';
      }
      showTyping(ev.botId || typingBotId(), '正在处理…');
      break;

    case 'message.delta':
      hideTyping();          // text is arriving: the bubble is the feedback now
      appendDelta(ev.text, sender);
      break;

    case 'message':
      hideTyping();
      finalizeLiveMessage(ev.text, ev.system, sender);
      break;

    case 'approval.request':
      appendApprovalCard(ev, sender);
      refreshPendingApprovals();
      toast('有一个操作在等你批准');
      // In a call: said aloud, but given only on the screen (1.5.22).
      if (call.on && voice.status?.tts?.available) queueSpeech('需要你在屏幕上确认一下。');
      break;

    case 'approval.resolved':
      markApprovalResolved(ev);
      refreshPendingApprovals();
      break;

    case 'turn.end':
      onTurnEnd(ev);
      break;

    case 'error':
      toast(ev.message || '这一轮运行失败了', true);
      break;

    default:
      break;
  }
}

/* ---------------------------------------------------------------------
   "working…" indicator: with tool chips hidden, a turn that is doing five
   tool calls looks exactly like a dead UI. This is the missing feedback.
   --------------------------------------------------------------------- */
/**
 * Whose face the working line shows: the bot of the running turn; in a group
 * with none known yet, the coordinator - never the last 1:1 bot (1.2.166: 助理's
 * face showed while 选题 worked in 小红书运营组).
 */
function typingBotId() {
  if (state.liveTurn?.botId) return state.liveTurn.botId;
  if (isGroupMode()) return groupById(state.groupId)?.coordinatorId || null;
  return state.botId;
}

function showTyping(botId, label = '正在处理…') {
  let row = messagesEl.querySelector('.typing-row');
  if (!row) {
    row = el('div', 'typing-row');
    row.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span><span class="typing-label"></span>';
  }
  // Always under the newest message (a message sent meanwhile goes above it).
  if (messagesEl.lastElementChild !== row) messagesEl.appendChild(row);
  row.querySelector('.typing-label').textContent = label;
  // In a group: the face of the bot at work, so the human sees who is busy.
  const who = row.querySelector('.typing-who');
  if (isGroupMode() && botId) {
    const bot = botById(botId) || groupMemberById?.(botId);
    if (bot && who?.dataset.bot !== botId) {
      const face = avatarNode(bot, 18, 'typing-who');
      face.dataset.bot = botId;
      face.title = bot.name || '';
      if (who) who.replaceWith(face); else row.prepend(face);
    }
  } else if (who) {
    who.remove();
  }
  scrollToBottom();
}

/** Keep the "working…" hint under anything just added to the chat. */
function keepTypingLast() {
  const row = messagesEl.querySelector('.typing-row');
  if (row && messagesEl.lastElementChild !== row) messagesEl.appendChild(row);
}

function hideTyping() {
  const row = messagesEl.querySelector('.typing-row');
  if (row) row.remove();
}

function appendLiveChip(chip) {
  // Same rule as renderMessages: the live stream must not leak tool chips into
  // the transcript when process display is off — but the turn must still look
  // alive, so keep the typing indicator updated with what is running.
  // Cards the human has to act on (takeover, login form) are not "process":
  // they always show, once the call has finished.
  const card = chip && isActionCard(chip.name);
  if (card && chip.pending) return;
  if (!state.showProcess && !card) {
    if (chip && chip.name) showTyping(typingBotId(), `正在${toolNameLabel(chip.name)}…`);
    return;
  }
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const node = toolChip(chip);
  if (chip.callId) node.dataset.call = chip.callId;
  if (isGroupMode() && chip.botId) {
    messagesEl.appendChild(groupSenderRow(botById(chip.botId) || { id: chip.botId, name: chip.botId }, node));
  } else if (card) {
    const row = el('div', 'row assistant card-row');
    row.appendChild(node);
    messagesEl.appendChild(row);
  } else {
    messagesEl.appendChild(node);
  }
  keepTypingLast();
  scrollToBottom();
}

/** One left-hand row: plain bubble for a DM, attributed bubble inside a group. */
function liveAssistantRow(sender, { streaming = false, system = false } = {}) {
  if (isGroupMode() && sender) {
    const row = groupSenderRow(sender, null);
    const block = row.querySelector('.g-block');
    const bubble = el('div', `bubble${system ? ' system' : ''}${streaming ? ' streaming' : ''}`);
    block.appendChild(bubble);
    return { row, bubble };
  }
  const row = assistantRow('', { streaming, system });
  return { row, bubble: row.querySelector('.bubble') };
}

function appendDelta(text, sender) {
  if (!state.liveTurn) state.liveTurn = { turnId: null, bubble: null, text: '', sender };
  if (!state.liveTurn.bubble) {
    if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
    const live = liveAssistantRow(sender || state.liveTurn.sender, { streaming: true });
    state.liveTurn.bubble = live.bubble;
    messagesEl.appendChild(live.row);
  }
  state.liveTurn.text += text;
  state.liveTurn.bubble.textContent = state.liveTurn.text;
  scrollToBottom();
}

function finalizeLiveMessage(text, system, sender) {
  if (!state.liveTurn) state.liveTurn = { turnId: null, bubble: null, text: '', sender };
  if (!state.liveTurn.bubble) {
    if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
    const live = liveAssistantRow(sender || state.liveTurn.sender, { streaming: true, system });
    state.liveTurn.bubble = live.bubble;
    messagesEl.appendChild(live.row);
  }
  state.liveTurn.text = text;
  const speaker = (sender || state.liveTurn.sender)?.id || state.botId;
  fillBubble(state.liveTurn.bubble, text, system, speaker);
  if (!system && state.readAloudTurn && voice.status?.tts?.available) queueSpeech(text, speaker);
  state.liveTurn.bubble.classList.remove('streaming');
  if (system) state.liveTurn.bubble.classList.add('system');
  state.liveTurn.bubble = null;
  scrollToBottom();
}

function onTurnEnd(ev) {
  state.liveTurn = null;
  if (!isGroupMode() && (!ev?.botId || ev.botId === state.botId) && !ev?.aside) setWorking(false);
  state.readAloudTurn = false;
  hideTyping();
  normalizeOverlays();
  if (isGroupMode()) {
    loadGroupMessages();
    loadActivity();
    return;
  }
  state.messages.push({ role: 'status', status: ev.status, summary: ev.summary, id: `s-${ev.turnId}` });
  loadMessages();
  loadActivity();
  if (ev.status === 'needs_approval') {
    refreshPendingApprovals();
    toast('运行暂停了，它在等你批准');
  }
  loadMemory();
}

/* ---------------------------------------------------------------------
   approvals
   --------------------------------------------------------------------- */
function appendApprovalCard(ev, sender) {
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const card = buildApprovalCard(ev);
  if (isGroupMode() && sender) {
    messagesEl.appendChild(groupSenderRow(sender, card));
  } else {
    messagesEl.appendChild(card);
  }
  scrollToBottom(true);
}

/**
 * One card, two lives: interactive while the turn is blocked, read-only once
 * the transcript is reloaded (the server keeps the decision).
 * Everything above the fold is plain language — the raw arguments live in one
 * collapsed block at the bottom, for people who actually want them.
 */
function buildApprovalCard(data) {
  const card = el('div', 'approval');
  card.dataset.approval = data.approvalId || '';
  // A scheduled run that stopped at this step (1.3.2): not an answered card,
  // and not one anything waits on. While it is still open it offers
  // 现在跑一次（我看着） and 不用了; it was drawn as 已处理 with no buttons.
  const parked = data.decision === 'needs_approval';
  const parkedOpen = parked && (data.live || (state.approvals || []).some((a) => a.id === data.approvalId));
  const resolved = Boolean(data.decision) && !parked;
  const info = describeTool(data.tool, data.args);
  // Several commands that only look, asked about once (1.5.40): each one shown in full.
  const many = Array.isArray(data.batch?.commands) && data.batch.commands.length > 1 ? data.batch.commands : null;
  if (many) {
    info.title = `想运行 ${many.length} 条查看类命令`;
    info.detail = '';
    info.facts = [];
    info.impact = '这些命令只是查看，不会改动任何东西。';
  }
  // Look-only commands: said so, and why it asks anyway - not "medium risk" under "changes nothing" (1.5.40 test).
  const looking = Boolean(many || data.look || data.lookTurn);
  if (looking && !many) info.impact = '这条命令只是查看，不会改动任何东西。';

  const top = el('div', 'approval-top');
  top.appendChild(el('span', 'approval-kicker', parked ? '定时任务停在了这一步' : resolved ? '已处理' : '需要你确认'));
  if (!resolved && !parked) {
    const wait = el('span', 'approval-wait');
    wait.appendChild(el('span', 'dot'));
    wait.appendChild(el('span', null, '在等你'));
    top.appendChild(wait);
  }
  card.appendChild(top);

  const title = el('div', 'approval-title', info.title);
  card.appendChild(title);

  // If a fact is just the same value as the headline detail, show that fact's
  // label as a caption instead of printing the value twice.
  const detailLabel = info.detail
    ? (info.facts.find(([, value]) => value === info.detail) || [])[0] || ''
    : '';

  if (info.detail) {
    const detail = el('div', 'approval-detail');
    if (detailLabel) detail.appendChild(el('div', 'approval-detail-k', detailLabel));
    detail.appendChild(el('code', null, truncate(info.detail, 220)));
    card.appendChild(detail);
  }
  if (many) {
    const list = el('div', 'approval-batch');
    for (const command of many) list.appendChild(el('code', null, String(command)));
    card.appendChild(list);
  }

  for (const [label, value] of info.facts) {
    if (info.detail && value === info.detail) continue;
    const line = el('div', 'approval-fact');
    line.appendChild(el('span', 'approval-fact-k', label));
    line.appendChild(el('span', 'approval-fact-v', value));
    card.appendChild(line);
  }

  if (info.impact) card.appendChild(el('div', 'approval-impact', info.impact));

  const why = looking ? '在这台电脑上运行命令前，都先问你一次' : reasonLabel(data.reason);
  card.appendChild(el('div', 'approval-why', why ? `为什么停下来问你：${why}` : '这个操作会改动文件或对外发东西，所以先停下来问你。'));

  if (parked) {
    card.classList.add(parkedOpen ? 'parked-open' : 'resolved');
    const actions = el('div', 'approval-actions');
    if (parkedOpen) {
      actions.appendChild(el('div', 'muted tiny', '当时没人在，它没有等你，先停了。想让它接着做就再跑一次：这一步会再问你，你点了才会做。卡片一天后会自己收起。'));
      const choose = el('div', 'approval-buttons');
      const rerun = el('button', 'btn primary', '现在跑一次（我看着）');
      rerun.type = 'button';
      const drop = el('button', 'btn', '不用了');
      drop.type = 'button';
      rerun.addEventListener('click', () => decideParked(data.approvalId, 'rerun', card, [rerun, drop]));
      drop.addEventListener('click', () => decideParked(data.approvalId, 'dismiss', card, [rerun, drop]));
      choose.appendChild(rerun);
      choose.appendChild(drop);
      actions.appendChild(choose);
    } else {
      actions.appendChild(el('div', 'muted tiny', '已收起。'));
    }
    card.appendChild(actions);
    appendTechnicalDetails(card, data);
    return card;
  }

  if (resolved) {
    card.classList.add('resolved');
    const actions = el('div', 'approval-actions');
    const good = data.decision === 'approved' || data.decision === 'approve';
    const cancelled = !good && /^已取消/.test(String(data.note || ''));
    const done = el('div', 'approval-done');
    done.appendChild(el('span', `approval-pill ${good ? 'ok' : 'no'}`, cancelled ? '已取消' : decisionLabel(data.decision)));
    done.appendChild(el('span', 'muted tiny', good ? '这一轮已经继续跑了。' : cancelled ? String(data.note).replace(/^已取消[：:]\s*/, '') + '。' : '它已经收到「不要做」。'));
    actions.appendChild(done);
    if (data.note && !cancelled) actions.appendChild(el('div', 'muted tiny', `备注：${data.note}`));
    card.appendChild(actions);
    appendTechnicalDetails(card, data);
    return card;
  }

  // One row of buttons (允许这一次 / 以后都允许 / 拒绝 / 看详情), the optional note under it.
  // 允许这一次 approves this one step; 以后都允许 also lets the same kind of
  // step run unasked for this bot (the danger list etc. offer only the first);
  // 拒绝 tells the bot no, and the next such step asks again.
  card.classList.add('pending');
  const actions = el('div', 'approval-actions');
  const choose = el('div', 'approval-buttons');

  const allow = el('button', 'btn primary approval-allow', many ? `允许这 ${many.length} 条` : '允许这一次');
  allow.type = 'button';
  allow.title = many ? '这几条都会运行，不再一条条问' : '只批准这一步，下次同样的操作还会问你';
  const always = data.remember?.key ? el('button', 'btn approval-always', '以后都允许') : null;
  if (always) {
    always.type = 'button';
    always.title = `以后「${data.remember.label}」不再问你（机器人设置里可以撤销）`;
  }
  // What 「以后都允许」 covers, said before the click (1.5.33: it read as "allow everything").
  const still = String(data.remember?.key || '').startsWith('shell:') ? '（危险操作和工作区外的改动照样会问）' : '';
  const scope = data.remember?.key ? el('div', 'approval-scope muted tiny', `「以后都允许」：以后${data.remember.label}都不再问${still}。${data.remember.warn ? ` ${data.remember.warn}` : ''}`) : null;
  // Allowing a look-only command covers the turn's later ones: said before the click (1.5.40).
  const lookNote = data.lookTurn
    ? el('div', 'approval-scope muted tiny', many ? '允许后这几条都会运行；这一轮后面只是查看的命令也不再问你，会改动东西的照样先问。' : '允许后，这一轮后面只是查看的命令不再问你；会改动东西的照样先问。')
    : many ? el('div', 'approval-scope muted tiny', '允许后这几条都会运行，不再一条条问。') : null;
  const reject = el('button', 'btn approval-reject', '拒绝');
  reject.type = 'button';
  reject.title = many ? '都不执行，把「不行」告诉它' : '不执行，把「不行」告诉它';
  const more = el('button', 'btn approval-more', '看详情');
  more.type = 'button';

  const note = el('input', 'field approval-note');
  note.placeholder = '想补一句话？（可选）';
  note.setAttribute('aria-label', '审批备注');

  allow.addEventListener('click', () => decide(data.approvalId, 'approve', note.value, card, allow, reject));
  if (always) always.addEventListener('click', () => decide(data.approvalId, 'approve', note.value, card, allow, reject, data.remember));
  reject.addEventListener('click', () => decide(data.approvalId, 'deny', note.value, card, allow, reject));

  choose.appendChild(allow);
  if (always) choose.appendChild(always);
  choose.appendChild(reject);
  choose.appendChild(more);
  actions.appendChild(choose);
  if (lookNote) actions.appendChild(lookNote);
  if (scope) actions.appendChild(scope);
  actions.appendChild(note);
  card.appendChild(actions);
  appendTechnicalDetails(card, data);
  const tech = card.querySelector('.approval-tech');
  more.addEventListener('click', () => {
    tech.open = !tech.open;
    more.textContent = tech.open ? '收起详情' : '看详情';
    if (tech.open) tech.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  return card;
}

/** Raw tool + arguments, folded away. Shared by live and resolved cards. */
function appendTechnicalDetails(card, data) {
  const args = safeArgs(data.args);
  const raw = { 工具: data.tool || '', 参数: args };
  if (data.risk) raw['风险'] = String(data.risk);
  const tech = el('details', 'tech approval-tech');
  tech.appendChild(el('summary', null, '技术细节'));
  tech.appendChild(el('pre', 'tech-pre', JSON.stringify(raw, null, 2)));
  card.appendChild(tech);
}

/** Turn the card into its settled state without rebuilding the transcript. */
function settleApprovalCard(card, decision, note) {
  if (!card) return;
  hideToast(); // "waiting for you" is no longer true the moment you answer
  card.classList.add('resolved');
  card.classList.remove('pending');
  const top = card.querySelector('.approval-top');
  if (top && top.firstChild) top.firstChild.textContent = '已处理';
  const wait = card.querySelector('.approval-wait');
  if (wait) wait.remove();
  const actions = card.querySelector('.approval-actions');
  if (actions) {
    actions.innerHTML = '';
    const good = decision === 'approved' || decision === 'approve';
    // Closed by Lamplit (stopped, the bot deleted), not refused by you (1.5.33).
    const cancelled = !good && /^已取消/.test(String(note || ''));
    const done = el('div', 'approval-done');
    done.appendChild(el('span', `approval-pill ${good ? 'ok' : 'no'}`, cancelled ? '已取消' : decisionLabel(decision)));
    done.appendChild(el('span', 'muted tiny', good ? '这一轮会继续跑。' : cancelled ? String(note).replace(/^已取消[：:]\s*/, '') + '。' : '已经告诉它不要做。'));
    actions.appendChild(done);
    if (note && !cancelled) actions.appendChild(el('div', 'muted tiny', `备注：${note}`));
  }
}

/** A routine's card: run it again now (attended), or put it away. */
async function decideParked(approvalId, decision, card, buttons) {
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const res = await api(`/api/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: { decision } });
    const actions = card.querySelector('.approval-actions');
    card.classList.remove('parked-open');
    card.classList.add('resolved');
    if (actions) {
      actions.innerHTML = '';
      actions.appendChild(el('div', 'muted tiny', decision === 'rerun'
        ? (res?.rerun ? '已经重新开始跑了：需要你点头的那一步会在这里弹出来。' : (res?.message || '找不到这个定时任务了。'))
        : '已收起。'));
    }
    if (decision === 'rerun' && res?.rerun) toast('定时任务重新开始跑了，你在这里看着');
    state.approvals = (state.approvals || []).filter((a) => a.id !== approvalId);
    refreshPendingApprovals();
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    toast(err.message, true);
    refreshPendingApprovals();
  }
}

async function decide(approvalId, decision, note, card, approve, deny, remember = null) {
  if (approve) approve.disabled = true;
  if (deny) deny.disabled = true;
  const alwaysBtn = card?.querySelector('.approval-always');
  if (alwaysBtn) alwaysBtn.disabled = true;
  try {
    const res = await api(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: { decision, note: note || '', ...(remember ? { always: true } : {}) },
    });
    settleApprovalCard(card, decision, note);
    if (res?.remembered) toast(`好的，以后${res.remembered.label}都不再问你${String(res.remembered.key || '').startsWith('shell:') ? '（危险操作和工作区外的改动照样会问）' : ''}`);
    state.approvals = state.approvals.filter((a) => a.id !== approvalId);
    refreshPendingApprovals();
  } catch (err) {
    if (approve) approve.disabled = false;
    if (deny) deny.disabled = false;
    if (alwaysBtn) alwaysBtn.disabled = false;
    toast(err.message, true);
    refreshPendingApprovals();
  }
}

async function refreshPendingApprovals() {
  // Approvals belong to a 1:1 transcript; the group view shows them via SSE.
  if (isGroupMode()) return;
  try {
    state.approvals = await api('/api/approvals?status=pending');
  } catch {
    return;
  }
  // A delegated bot can be blocked on an approval while you are looking at a
  // different transcript. Without this badge the coordinator just looks dead.
  const foreign = state.approvals.filter((a) => a.botId && a.botId !== state.botId);
  const pill = $('approvals-pill');
  if (pill) {
    const count = state.approvals.length;
    pill.hidden = count === 0;
    pill.textContent = count === 1 ? '1 个操作等你确认' : `${count} 个操作等你确认`;
    const first = foreign[0] || state.approvals[0];
    pill.dataset.bot = first?.botId || '';
    pill.dataset.approvalId = first?.id || '';
  }
  for (const approval of state.approvals) {
    if (approval.botId && approval.botId !== state.botId) continue;
    const parked = approval.status === 'awaiting_human';
    const data = {
      approvalId: approval.id,
      tool: approval.toolName,
      risk: approval.risk,
      reason: approval.reason,
      args: safeParse(approval.args),
      // After a reload the card is rebuilt from here: keep 「以后都允许」 (1.5.33).
      ...(approval.remember?.key ? { remember: approval.remember } : {}),
      // And what a card for look-only commands covers (1.5.40).
      ...(approval.batch ? { batch: approval.batch } : {}),
      ...(approval.lookTurn ? { lookTurn: true } : {}),
      ...(approval.look ? { look: true } : {}),
      ...(parked ? { decision: 'needs_approval', live: true } : {}),
    };
    const existing = messagesEl.querySelector(`[data-approval="${CSS.escape(approval.id)}"]`);
    // The transcript drew a routine's card before the list arrived: give it its buttons.
    if (existing && parked && !existing.classList.contains('parked-open')) { existing.replaceWith(buildApprovalCard(data)); continue; }
    if (existing) continue;
    appendApprovalCard(data);
  }
}

/**
 * The approval a notification tap points at (?approval=<id>&bot=<id>).
 * The Android shell opens the hub itself; the query is how the tap says
 * which card it meant.
 */
function approvalTarget() {
  try {
    const params = new URL(location.href).searchParams;
    const approvalId = (params.get('approval') || '').trim();
    if (!approvalId) return null;
    return { approvalId, botId: (params.get('bot') || '').trim() };
  } catch {
    return null;
  }
}

/** Bring the card a notification asked for into view, then drop the query. */
async function focusApprovalFromLink(target) {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('approval');
    url.searchParams.delete('bot');
    history.replaceState(null, '', url.toString());
  } catch { /* an unclean URL still works */ }

  const card = await waitForApprovalCard(target.approvalId, 2500);
  if (!card) {
    toast('这条审批不在了，可能已经处理过。');
    return;
  }
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('is-focus');
  setTimeout(() => card.classList.remove('is-focus'), 3000);
}

/**
 * "N 个操作等你确认": open that bot and bring its waiting card into view. The
 * card can sit far up a long chat (on 11-15 it was dozens of messages up and
 * looked missing), or not be loaded at all: then it is put at the bottom.
 */
async function focusApprovalCard(approvalId, botId) {
  // A card left by a bot that is gone (1.5.32): show it here, where it can still be answered.
  const known = !botId || (state.bots || []).some((b) => b.id === botId);
  if (botId && known && (isGroupMode() || state.botId !== botId)) await selectBot(botId);
  let card = approvalId ? await waitForApprovalCard(approvalId, 2500) : null;
  if (!card && approvalId) {
    const a = (state.approvals || []).find((x) => x.id === approvalId);
    if (a) {
      appendApprovalCard({ approvalId: a.id, tool: a.toolName, risk: a.risk, reason: a.reason, args: safeParse(a.args), ...(a.remember?.key ? { remember: a.remember } : {}), ...(a.status === 'awaiting_human' ? { decision: 'needs_approval', live: true } : {}) });
      card = messagesEl.querySelector(`[data-approval="${CSS.escape(approvalId)}"]`);
    }
  }
  if (!card) {
    toast('这条审批不在了，可能已经处理过。');
    return;
  }
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 3600);
}

async function waitForApprovalCard(approvalId, timeoutMs) {
  const selector = `[data-approval="${CSS.escape(approvalId)}"]`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const card = messagesEl.querySelector(selector);
    if (card) return card;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

function markApprovalResolved(ev) {
  const card = messagesEl.querySelector(`[data-approval="${CSS.escape(ev.approvalId || '')}"]`);
  if (!card) return;
  settleApprovalCard(card, ev.decision, ev.note || '');
}

/* ---------------------------------------------------------------------
   activity
   --------------------------------------------------------------------- */
function addActivity(ev) {
  state.activities.unshift(ev);
  if (state.activities.length > 120) state.activities.pop();
  renderActivity();
}

async function loadActivity() {
  try {
    const events = await api('/api/events?limit=60');
    state.activities = [...events].reverse();
    renderActivity();
  } catch { /* non-fatal */ }
}

const RUN_STATUS_LABELS = {
  success: '完成', failed: '失败', needs_approval: '待批准',
  timeout: '超时', cancelled: '已取消', max_steps: '到达步数上限',
};
function runStatusLabel(status) {
  if (!status) return '—';
  return RUN_STATUS_LABELS[String(status).toLowerCase()] || String(status);
}

const ACTIVITY_KIND_LABELS = { turn: '对话', tool: '工具', approval: '审批', message: '消息', error: '错误' };

function activityLabel(ev) {
  switch (ev.type) {
    case 'turn.start': return { kind: 'turn', text: `${ev.botName || ev.botId}：${ev.source === 'task' ? (/先停下来/.test(ev.text || '') ? '任务没有进展，停下来说明情况' : '任务自动接着做') : truncate(ev.text, 90)}` };
    case 'turn.end': return { kind: 'turn', text: `${ev.botName || ev.botId} 结束（${runStatusLabel(ev.status)}${ev.steps ? `，${ev.steps} 步` : ''}）` };
    case 'tool.call': return { kind: 'tool', text: `${ev.botName || ev.botId} · ${toolNameLabel(ev.name)}${ev.risk ? `（${riskLabel(ev.risk)}风险）` : ''} ${decisionLabel(ev.decision)}` };
    case 'tool.result': return { kind: ev.ok ? 'tool' : 'error', text: `${toolNameLabel(ev.name)} ${ev.ok ? '完成' : '没成功'}${ev.denied ? '（被拒绝）' : ''}` };
    case 'approval.request': return { kind: 'approval', text: `${toolNameLabel(ev.tool)} · 等你确认` };
    case 'approval.resolved': return { kind: 'approval', text: `${toolNameLabel(ev.tool)} · ${decisionLabel(ev.decision)}` };
    case 'approval.decided': return { kind: 'approval', text: `你${ev.status === 'approved' ? '批准' : '拒绝'}了 ${truncate(ev.turnId, 14)}` };
    case 'message': return { kind: 'message', text: `${ev.botName || ev.botId}：${truncate(ev.text, 90)}` };
    case 'error': return { kind: 'error', text: truncate(ev.message, 110) };
    default: return null;
  }
}

function renderActivity() {
  const list = $('activity-list');
  if (!list) return;
  list.innerHTML = '';
  const items = state.activities.filter((ev) => activityLabel(ev)).slice(0, 80);
  $('activity-count').textContent = String(items.length);

  for (const ev of items) {
    const { kind, text } = activityLabel(ev);
    const row = el('div', 'activity-item');
    row.appendChild(el('span', 'activity-when', fmtClock(ev.ts).slice(0, 5)));
    row.appendChild(el('span', `activity-kind k-${kind}`, ACTIVITY_KIND_LABELS[kind] || kind));
    row.appendChild(el('span', 'activity-text', text));
    list.appendChild(row);
  }
  if (!items.length) list.appendChild(el('div', 'muted tiny', '还没有动态。发一条消息试试。'));
}

/*
 * A document a reply names: a card like a page's (1.5.12) - its kind as a
 * coloured badge, the name, "Markdown · 12 KB · 点开查看". A click shows it in
 * the app when it can (PDF where the browser can, md / txt / csv always), else
 * opens it here with the system's program, else downloads it; the arrow always
 * downloads. It looks on this machine first, then on the other machines; a
 * name that is nowhere shows no card.
 */
const DOC_KINDS = {
  pdf: ['PDF', 'PDF 文档', 'pdf'], md: ['MD', 'Markdown', 'md'], txt: ['TXT', '文本', 'txt'], csv: ['CSV', '表格', 'xls'],
  doc: ['DOC', 'Word 文档', 'doc'], docx: ['DOC', 'Word 文档', 'doc'], xls: ['XLS', 'Excel 表格', 'xls'], xlsx: ['XLS', 'Excel 表格', 'xls'],
  ppt: ['PPT', 'PPT 演示', 'ppt'], pptx: ['PPT', 'PPT 演示', 'ppt'], zip: ['ZIP', '压缩包', 'zip'],
};
function docKind(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const [badge, label, tone] = DOC_KINDS[ext] || [ext.slice(0, 4).toUpperCase() || 'FILE', '文件', 'txt'];
  const view = ext === 'pdf' ? (navigator.pdfViewerEnabled !== false ? 'frame' : '') : (['md', 'txt', 'csv'].includes(ext) ? ext : '');
  return { badge, label, tone, view };
}

function docCard(file, url) {
  const kind = docKind(file.name);
  const card = el('div', 'att-doc');
  const main = el('button', 'att-doc-main');
  main.type = 'button';
  main.appendChild(el('span', `att-badge ft-${kind.tone}`, kind.badge));
  const meta = el('span', 'att-meta');
  meta.appendChild(el('span', 'att-name', file.name));
  const sub = el('span', 'att-size', kind.label);
  meta.appendChild(sub);
  main.appendChild(meta);
  card.appendChild(main);
  const dl = el('a', 'att-doc-dl', '↓');
  dl.href = url;
  dl.title = '下载';
  dl.setAttribute('aria-label', '下载');
  dl.setAttribute('download', file.name);
  card.appendChild(dl);
  let src = url;
  let local = true;
  const action = () => (kind.view ? '点开查看' : (local && canOpenLocally() ? '点开打开' : '点开下载'));
  const describe = (where) => { sub.textContent = [kind.label, where, action()].filter(Boolean).join(' · '); };
  describe('');
  main.addEventListener('click', (event) => {
    if (kind.view) { openFileViewer(kind.view === 'frame' ? `${src}&inline=1` : src, file.name, src, kind.view, local ? file.path : ''); return; }
    if (local && canOpenLocally()) { openLocalFile(file.path, event.ctrlKey || event.metaKey); return; }
    dl.click();
  });
  api(`/api/workspace/stat?path=${encodeURIComponent(file.path)}`).then((r) => {
    if (r.exists) { describe(fmtBytes(r.size)); return; }
    findElsewhere(file.path).then((machine) => {
      if (!machine) { card.remove(); return; }
      src = remoteFileUrl(machine, file.path);
      local = false;
      dl.href = src;
      describe(`在「${machine}」上`);
    });
  }).catch(() => {});
  return card;
}

/** A document in the app: a PDF in a frame, Markdown / text / CSV drawn here; 打开, 下载, 关闭 (Esc). */
function openFileViewer(src, name, downloadUrl, view = 'frame', localPath = '') {
  let box = $('file-viewer');
  if (!box) {
    box = el('div', 'page-viewer');
    box.id = 'file-viewer';
    box.innerHTML = '<div class="page-viewer-bar"><span class="page-viewer-title"></span><button class="btn tiny" type="button" data-open>打开</button><a class="btn tiny" data-dl>下载</a><button class="btn tiny" type="button" data-close>关闭</button></div><iframe referrerpolicy="no-referrer"></iframe><div class="file-viewer-doc"></div>';
    const close = () => { box.classList.remove('show'); box.querySelector('iframe').src = 'about:blank'; box.querySelector('.file-viewer-doc').innerHTML = ''; };
    box.querySelector('[data-close]').addEventListener('click', close);
    box.querySelector('[data-open]').addEventListener('click', (event) => openLocalFile(box.dataset.path, event.ctrlKey || event.metaKey));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && box.classList.contains('show')) close(); });
    document.body.appendChild(box);
  }
  box.querySelector('.page-viewer-title').textContent = name;
  const dl = box.querySelector('[data-dl]');
  dl.href = downloadUrl;
  dl.setAttribute('download', name);
  box.dataset.path = localPath;
  box.querySelector('[data-open]').hidden = !(localPath && canOpenLocally());
  const frame = box.querySelector('iframe');
  const doc = box.querySelector('.file-viewer-doc');
  frame.hidden = view !== 'frame';
  doc.hidden = view === 'frame';
  if (view === 'frame') frame.src = src;
  else {
    doc.textContent = '…';
    fetch(src, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => {
      const body = text.length > 400000 ? `${text.slice(0, 400000)}\n…` : text;
      doc.innerHTML = '';
      if (view === 'md') { const md = el('div', 'bubble md file-viewer-md'); /* the chat's Markdown look, tables included */ md.innerHTML = mdToHtml(body); doc.appendChild(md); return; }
      if (view === 'csv') {
        const table = el('table', 'csv-table');
        body.split(/\r?\n/).filter(Boolean).slice(0, 2000).forEach((line, i) => {
          const tr = el('tr');
          line.split(',').forEach((cell) => tr.appendChild(el(i ? 'td' : 'th', null, cell.replace(/^"|"$/g, ''))));
          table.appendChild(tr);
        });
        doc.appendChild(table);
        return;
      }
      doc.appendChild(el('pre', 'file-viewer-text', body));
    }).catch(() => { doc.textContent = '没能读到这个文件。'; });
  }
  box.classList.add('show');
}

/* --- 通话模式 (1.5.22) ------------------------------------------------------
   Talk instead of type, back and forth: it listens, notices when you have
   finished (about 0.8 s of quiet), turns that into text and sends it, then
   reads the answer aloud sentence by sentence. Speaking while it reads stops
   the reading (it keeps working). Approvals are never given by voice: it says
   one is waiting, and you tap it on the screen. */
const call = { on: false, rec: null, timer: null, heard: 0, quiet: 0, floor: 0.02, segStart: 0, cutting: false, phase: 'listen', pending: '', waiting: 0, chain: Promise.resolve(), said: [], readEnded: 0 };
const CALL_HOLD_MS = 400;
const CALL_TAIL_MS = 700;    // after reading: the room's echo dies down before it listens again

/** The button on the call bar: 「打断」 while it reads, 「说完了」 while it listens. */
function callDoneLabel() {
  const b = $('call-done');
  if (b) b.textContent = call.deaf ? '打断' : '说完了';
}    // after the text is back: a little more quiet before sending (a pause at a comma is not the end)
const CALL_TICK_MS = 100;
const CALL_START_MS = 250;   // this much sound before it counts as speech
const CALL_END_MS = 800;     // this much quiet after speech ends a sentence
const CALL_MAX_MS = 60000;   // one utterance at most
const CALL_IDLE_MS = 30000;  // silence: start a fresh recording now and then

/** The microphone for a call: the page's own where it may, else the app's (desktop, Android). */
async function openCallMic() {
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined') {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    let rec = null;
    let chunks = [];
    const begin = () => { chunks = []; rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); }; rec.start(500); };
    begin();
    return {
      level: async () => { analyser.getFloatTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v)); return peak; },
      take: () => new Promise((resolve) => {
        const r = rec;
        r.onstop = () => { const type = (r.mimeType || 'audio/webm').split(';')[0]; resolve({ blob: new Blob(chunks, { type }), type }); begin(); };
        r.stop();
      }),
      restart: async () => { rec.onstop = () => begin(); rec.stop(); },
      close: async () => { try { rec.onstop = null; rec.stop(); } catch { /* stopped */ } stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); },
    };
  }
  const d = window.desk;
  if (d?.callMic) {
    // Android (1.5.22): one recording that never stops; each sentence is cut out as a WAV.
    const ok = await d.callMic.start();
    if (!ok) throw Object.assign(new Error('打不开麦克风'), { name: 'NotAllowedError' });
    return {
      level: async () => Number(d.callMic.level()) || 0,
      take: async () => { const bytes = d.callMic.take(); return { blob: new Blob(bytes ? [bytes] : [], { type: 'audio/wav' }), type: 'audio/wav' }; },
      restart: async () => { d.callMic.discard(); },
      close: async () => { d.callMic.stop(); },
    };
  }
  if (!d?.voiceStart) throw new Error('这个页面用不了麦克风（需要 https、本机地址，或者 Lamplit 应用）');
  if (typeof d.voiceLevel !== 'function') throw new Error('通话要新版的 Lamplit 应用：先更新一下电脑或手机上的 Lamplit');
  const started = await d.voiceStart({ call: true });
  if (!started?.ok) throw Object.assign(new Error(started?.message || '打不开麦克风'), { name: started?.error });
  return {
    level: async () => Number(await d.voiceLevel()) || 0,
    take: async () => {
      const out = await d.voiceStop();
      await d.voiceStart({ call: true });
      if (!out?.bytes) return { blob: new Blob([]), type: 'audio/webm' };
      const type = out.mime || 'audio/webm';
      return { blob: new Blob([out.bytes], { type }), type };
    },
    restart: async () => { await d.voiceCancel(); await d.voiceStart({ call: true }); },
    close: async () => { await d.voiceCancel().catch(() => null); },
  };
}

function setCallPhase(phase) {
  call.phase = phase;
  const label = { listen: '在听', send: '听到了，正在转成文字', think: '在想', speak: '在说（要插话就点「打断」）' }[phase] || phase;
  if ($('call-state')) $('call-state').textContent = label;
}

async function startCall() {
  if (call.on) return;
  let status = voice.status;
  try { status = await loadVoice(); } catch { /* use what we have */ }
  if (!status?.available) { toast('通话要先配置语音转文字（一个硅基流动的免费密钥就行）', true); openSettings('sec-model'); return; }
  if (!status?.tts?.available) { toast('通话要能朗读：语音服务选硅基流动或 OpenAI 并填密钥', true); openSettings('sec-model'); return; }
  if (voice.recorder) stopRecording(true);
  try {
    call.rec = await openCallMic();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? '麦克风被拒绝了：请在系统设置里允许 Lamplit 使用麦克风' : err.message, true);
    return;
  }
  Object.assign(call, { on: true, heard: 0, quiet: 0, floor: 0.02, segStart: Date.now(), cutting: false, pending: '', waiting: 0, chain: Promise.resolve(), said: [], readEnded: 0 });
  $('call-bar').hidden = false;
  $('call-btn').classList.add('on');
  setCallPhase('listen');
  call.timer = setInterval(callTick, CALL_TICK_MS);
}

async function endCall() {
  if (!call.on) return;
  call.on = false;
  call.pending = '';
  clearInterval(call.timer);
  stopSpeaking();
  await call.rec?.close().catch(() => {});
  call.rec = null;
  $('call-bar').hidden = true;
  $('call-btn').classList.remove('on');
}

function toggleCall() { if (call.on) endCall(); else startCall(); }

async function callTick() {
  if (!call.on || call.cutting || !call.rec) return;
  let lv = 0;
  try { lv = await call.rec.level(); } catch { return; }
  // While it reads aloud, and a moment after, the microphone hears mostly itself
  // (1.5.22: its words came back misheard - "手机原证tm0不猥琐" - and were sent
  // as the human's). So it does not listen then; 「打断」 stops the reading.
  const reading = speech.playing || speech.loading || speech.queue.length > 0;
  if (reading || Date.now() - call.readEnded < CALL_TAIL_MS) {
    call.heard = 0;
    call.quiet = 0;
    call.deaf = true;
    callDoneLabel();
    return;
  }
  if (call.deaf) {
    call.deaf = false;
    callDoneLabel();
    call.cutting = true;
    try { await call.rec.restart(); } catch { /* next tick */ }
    call.segStart = Date.now();
    call.cutting = false;
    return;
  }
  const bar = Math.max(0.04, call.floor * 3);
  if (lv > bar) { call.heard += CALL_TICK_MS; call.quiet = 0; }
  else call.quiet += CALL_TICK_MS;
  // The background: follows quiet quickly, rises slowly under a steady noise (a fan, a TV),
  // so that noise stops counting as speech and a sentence can end.
  call.floor = lv < call.floor ? call.floor * 0.8 + lv * 0.2 : call.floor * 0.995 + lv * 0.005;
  if (call.heard && call.heard < CALL_START_MS && call.quiet >= CALL_END_MS) call.heard = 0; // a cough, a click
  const long = call.heard && Date.now() - call.segStart > CALL_MAX_MS;
  if ((call.heard >= CALL_START_MS && call.quiet >= CALL_END_MS) || long) { cutUtterance(); return; }
  if (!call.heard && Date.now() - call.segStart > CALL_IDLE_MS) {
    call.cutting = true;
    try { await call.rec.restart(); } catch { /* next tick */ }
    call.segStart = Date.now();
    call.cutting = false;
  }
}

async function cutUtterance() {
  call.cutting = true;
  call.heard = 0;
  call.quiet = 0;
  setCallPhase('send');
  let taken;
  try { taken = await call.rec.take(); } catch (err) { toast(err.message, true); }
  call.segStart = Date.now();
  call.cutting = false;
  if (!call.on || !taken?.blob?.size) { if (!call.waiting) setCallPhase('listen'); return; }
  // Pieces are turned into text at once, but used in the order they were said
  // (1.5.22, seen: a short second piece came back first and was sent first).
  const job = fetch('/api/voice/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': taken.type }, body: taken.blob })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      return String(data.text || '').trim();
    });
  call.waiting += 1;
  call.chain = call.chain.then(() => usePiece(job));
}

/** One piece of what was said, in order: held while more is coming, then sent as one message. */
async function usePiece(job) {
  let heardText = '';
  try { heardText = await job; } catch (err) { toast(`没转成文字：${err.message}`, true); }
  call.waiting -= 1;
  if (!call.on) return;
  // Its own voice heard back is not the human talking (1.5.22).
  heardText = stripEcho(heardText);
  // Something real said while it reads: that is an interruption - stop reading.
  if (heardText && (speech.playing || speech.loading)) stopSpeaking();
  if (heardText) call.pending = call.pending ? `${call.pending}${heardText}` : heardText;
  if (!call.pending) { if (!call.waiting) setCallPhase('listen'); return; }
  // A later piece is on its way: it carries this one (a pause at a comma is not the end).
  if (call.waiting) return;
  const held = Date.now();
  while (call.on && Date.now() - held < CALL_HOLD_MS) {
    if (call.heard >= CALL_START_MS || call.waiting) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!call.on || call.heard >= CALL_START_MS || call.waiting) return;
  const text = call.pending;
  call.pending = '';
  try {
    // Wait for a send in flight (a sentence right after another).
    for (let i = 0; i < 50 && state.sending; i += 1) await new Promise((r) => setTimeout(r, 200));
    const input = $('composer');
    input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
    voice.spokeSinceSend = true;
    setCallPhase('think');
    await send();
  } catch (err) {
    toast(err.message, true);
    setCallPhase('listen');
  }
}

/** Auto-read: replies of a turn this window started play one after another; the next part's audio is fetched while one plays. */
async function queueSpeech(text, botId = '') {
  for (const part of speechParts(text)) speech.queue.push({ text: part, botId });
  if (speech.playing || speech.draining) return;
  speech.draining = true;
  while (speech.queue.length) {
    const next = speech.queue.shift();
    if (!next?.text) continue;
    if (call.on) { setCallPhase('speak'); call.said.push({ text: next.text, at: Date.now() }); }
    const ready = next.ready || speechBlob(next.text, { botId: next.botId });
    ready.catch(() => {});
    if (speech.queue[0]?.text && !speech.queue[0].ready) { speech.queue[0].ready = speechBlob(speech.queue[0].text, { botId: speech.queue[0].botId }); speech.queue[0].ready.catch(() => {}); }
    try { await speakText(next.text, null, { botId: next.botId }, ready); } catch (err) { toast(`朗读失败：${err.message}`, true); speech.queue = []; }
  }
  speech.draining = false;
  if (call.on) { call.readEnded = Date.now(); if (call.phase === 'speak') setCallPhase('listen'); }
}

const plainText = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * Take out of what was heard what Lamplit itself just read aloud (1.5.22: its
 * own voice came back through the microphone and was sent as the human's
 * words). Pieces of 4+ characters that appear in what it read in the last
 * 90 s are dropped; what is left is the human's. '' when it was all echo.
 */
function stripEcho(heard, said = call.said) {
  const recent = said.filter((s) => Date.now() - s.at < 90000).map((s) => plainText(s.text)).join('|');
  const t = plainText(heard);
  if (!recent || !t) return String(heard || '').trim();
  let kept = '';
  for (let i = 0; i < t.length;) {
    let k = 0;
    while (i + k < t.length && recent.includes(t.slice(i, i + k + 1))) k += 1;
    if (k >= 4) i += k; else { kept += t[i]; i += 1; }
  }
  if (kept.length <= 2 || kept.length < t.length * 0.25) return '';
  return kept.length === t.length ? String(heard).trim() : kept;
}

/** Long answers are read sentence by sentence, so the first one starts sooner (calls only). */
function speechParts(text) {
  if (!call.on) return [text];
  const parts = String(text || '').match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [String(text || '')];
  const out = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length + p.length) < 40) out[out.length - 1] += p; else out.push(p);
  }
  return out.slice(0, 12);
}
