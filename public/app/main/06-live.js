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
  const readThis = mode === 'always' || (mode === 'voice' && voice.spokeSinceSend);
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
      await api(`/api/bots/${state.botId}/message`, { method: 'POST', body: { text, attachments } });
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
    if (chatKeyOf(ev) === currentChatKey()) showTyping(ev.botId || state.botId, ev.text || '正在处理…');
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
      state.liveTurn = { turnId: ev.turnId, bubble: null, text: '', sender };
      // A colleague handed this bot work: show what it asked, with its face, as it arrives.
      if (ev.fromBotId && ev.text && !isGroupMode() && ev.botId === state.botId) {
        messagesEl.appendChild(botMessageRow({ fromBot: ev.fromBotId, text: ev.text, ts: ev.ts }));
      }
      showTyping(ev.botId || state.botId, '正在处理…');
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
      showTyping(ev.botId || state.botId, '正在处理…');
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
    if (chip && chip.name) showTyping(state.liveTurn?.botId || state.botId, `正在${toolNameLabel(chip.name)}…`);
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
  const resolved = Boolean(data.decision);
  const info = describeTool(data.tool, data.args);

  const top = el('div', 'approval-top');
  top.appendChild(el('span', 'approval-kicker', resolved ? '已处理' : '需要你确认'));
  if (!resolved) {
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

  for (const [label, value] of info.facts) {
    if (info.detail && value === info.detail) continue;
    const line = el('div', 'approval-fact');
    line.appendChild(el('span', 'approval-fact-k', label));
    line.appendChild(el('span', 'approval-fact-v', value));
    card.appendChild(line);
  }

  if (info.impact) card.appendChild(el('div', 'approval-impact', info.impact));

  const why = reasonLabel(data.reason);
  card.appendChild(el('div', 'approval-why', why ? `为什么停下来问你：${why}` : '这个操作会改动文件或对外发东西，所以先停下来问你。'));

  if (resolved) {
    card.classList.add('resolved');
    const actions = el('div', 'approval-actions');
    const good = data.decision === 'approved' || data.decision === 'approve';
    const done = el('div', 'approval-done');
    done.appendChild(el('span', `approval-pill ${good ? 'ok' : 'no'}`, decisionLabel(data.decision)));
    done.appendChild(el('span', 'muted tiny', good ? '这一轮已经继续跑了。' : '它已经收到「不要做」。'));
    actions.appendChild(done);
    if (data.note) actions.appendChild(el('div', 'muted tiny', `备注：${data.note}`));
    card.appendChild(actions);
    appendTechnicalDetails(card, data);
    return card;
  }

  // One row of buttons (批准 / 拒绝 / 看详情), the optional note under it.
  // 批准 only approves this one step; 拒绝 tells the bot no.
  card.classList.add('pending');
  const actions = el('div', 'approval-actions');
  const choose = el('div', 'approval-buttons');

  const allow = el('button', 'btn primary approval-allow', '批准');
  allow.type = 'button';
  allow.title = '只批准这一步，做完就结束';
  const reject = el('button', 'btn approval-reject', '拒绝');
  reject.type = 'button';
  reject.title = '不执行，把「不行」告诉它';
  const more = el('button', 'btn approval-more', '看详情');
  more.type = 'button';

  const note = el('input', 'field approval-note');
  note.placeholder = '想补一句话？（可选）';
  note.setAttribute('aria-label', '审批备注');

  allow.addEventListener('click', () => decide(data.approvalId, 'approve', note.value, card, allow, reject));
  reject.addEventListener('click', () => decide(data.approvalId, 'deny', note.value, card, allow, reject));

  choose.appendChild(allow);
  choose.appendChild(reject);
  choose.appendChild(more);
  actions.appendChild(choose);
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
    const done = el('div', 'approval-done');
    done.appendChild(el('span', `approval-pill ${good ? 'ok' : 'no'}`, decisionLabel(decision)));
    done.appendChild(el('span', 'muted tiny', good ? '这一轮会继续跑。' : '已经告诉它不要做。'));
    actions.appendChild(done);
    if (note) actions.appendChild(el('div', 'muted tiny', `备注：${note}`));
  }
}

async function decide(approvalId, decision, note, card, approve, deny) {
  if (approve) approve.disabled = true;
  if (deny) deny.disabled = true;
  try {
    await api(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: { decision, note: note || '' },
    });
    settleApprovalCard(card, decision, note);
    state.approvals = state.approvals.filter((a) => a.id !== approvalId);
    refreshPendingApprovals();
  } catch (err) {
    if (approve) approve.disabled = false;
    if (deny) deny.disabled = false;
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
    if (messagesEl.querySelector(`[data-approval="${CSS.escape(approval.id)}"]`)) continue;
    appendApprovalCard({
      approvalId: approval.id,
      tool: approval.toolName,
      risk: approval.risk,
      reason: approval.reason,
      args: safeParse(approval.args),
    });
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
  if (botId && (isGroupMode() || state.botId !== botId)) await selectBot(botId);
  let card = approvalId ? await waitForApprovalCard(approvalId, 2500) : null;
  if (!card && approvalId) {
    const a = (state.approvals || []).find((x) => x.id === approvalId);
    if (a) {
      appendApprovalCard({ approvalId: a.id, tool: a.toolName, risk: a.risk, reason: a.reason, args: safeParse(a.args) });
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

