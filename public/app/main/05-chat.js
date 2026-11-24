'use strict';
// Lamplit page, part 5 of 12: chat - messages, markdown, attachments. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   messages
   --------------------------------------------------------------------- */
async function loadMessages() {
  if (isGroupMode()) return loadGroupMessages();
  if (!state.botId) return;
  const botId = state.botId;
  const cacheKey = `bot:${botId}:${state.showProcess ? 1 : 0}`;
  const cached = chatCacheGet(cacheKey);
  // Not when this chat is on screen already (1.5.63: at every turn end it drew the older copy, then the new one).
  if (cached && !remoteChatOnScreen(botId) && messagesEl.dataset.shown !== `bot:${botId}`) { state.messages = cached; renderMessages(); }
  let messages;
  try {
    // Steps hidden: their long output stays on the machine. A bot on another machine: read from there (1.5.42).
    messages = await api(`${isRemoteId(botId) ? remoteApi(botId, '/') : `/api/bots/${botId}/`}messages?limit=200${state.showProcess ? '' : '&compact=1'}`);
  } catch (err) {
    if (err.status === 401 || (isRemoteId(botId) && remoteChatFailed(botId, err, cached))) return; // 1.5.42: its machine is off
    if (state.botId === botId && !isGroupMode()) toast(`无法加载对话：${err.message}`, true);
    return;
  }
  // A slow machine can answer after the human moved to another chat: that
  // answer belongs to a chat no longer on screen.
  if (state.botId !== botId || isGroupMode()) return;
  // Nothing new only when nothing new is on screen too: a remote chat on screen was not repainted from the
  // saved copy, which another tab may have brought up to date (1.5.43 test: a reply that never showed).
  const sameAsShown = !remoteChatOnScreen(botId) || JSON.stringify(state.messages) === JSON.stringify(messages);
  if (!chatCachePut(cacheKey, messages) && cached && cached.length === messages.length && sameAsShown) return;
  state.messages = messages;
  renderMessages();
}

function renderMessages() {
  if (isGroupMode()) return renderGroupMessages();
  // "像发消息一样" — the turn's tool calls are process, not conversation.
  // They live in the Activity panel; the transcript only shows what was said.
  const visible = state.messages.filter(
    (m) => m.role !== 'status' && (state.showProcess || m.role !== 'tool' || isActionCard(m.name, m)),
  );
  const statuses = state.messages.filter((m) => m.role === 'status');

  // A turn may say several things on purpose: one short line when it starts
  // longer work, then the answer - a long one cut into a few messages. Shown
  // as they were sent (one bubble each), the same as while it was live.
  const items = visible.map((item) => ({ ...item }));
  // Work a colleague handed over: done once this bot answered and is not at it any more (1.5.40).
  const busy = Boolean(state.attention?.items?.[currentChatKey()]?.working);
  items.forEach((item, i) => { if (item.role === 'user' && item.fromBot) item.handoffState = handoffProgress(items.slice(i + 1), { working: busy, replied: (m) => m.role === 'assistant' && !m.system, again: (m) => m.role === 'user' }); });
  // A card the human acts on (takeover, login) comes after what the bot said in
  // that turn ("点下面的「接管屏幕」"), not before it.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.role !== 'tool' || !isActionCard(it.name) || !it.turnId) continue;
    let last = i;
    for (let j = i + 1; j < items.length && items[j].turnId === it.turnId; j += 1) last = j;
    if (last > i) { items.splice(i, 1); items.splice(last, 0, it); }
  }

  const place = chatPlace(`bot:${state.botId}`); // where the reader is (1.5.63)
  messagesEl.innerHTML = ''; messagesEl.dataset.chat = state.botId || '';
  const changesByTurn = turnChanges(state.messages);
  // A turn's own last message: a new message sent in the middle splits a turn in two (1.5.40), the line still shows once.
  const turnEnds = new Map();
  items.forEach((it, i) => { if (it.turnId) turnEnds.set(it.turnId, i); });
  const replyOfTurn = new Map(); // turnId -> the row of its last reply bubble (1.5.64)

  if (!visible.length) {
    messagesEl.appendChild(emptyState());
  } else {
    let lastDay = '';
    for (const item of items) {
      // A centred day marker whenever the calendar day changes.
      const day = item.ts ? dayKey(item.ts) : '';
      if (day && day !== lastDay) {
        messagesEl.appendChild(daySeparator(item.ts));
        lastDay = day;
      }
      // One malformed record must never blank the whole transcript.
      try {
        messagesEl.appendChild(renderItem(item));
        // The turn's own reply (1.5.64): its 「改了 N 个文件」 goes under it, not under a card that came later.
        if (item.turnId && item.role === 'assistant' && messagesEl.lastElementChild?.querySelector?.('.bubble')) replyOfTurn.set(item.turnId, messagesEl.lastElementChild);
      } catch (err) {
        console.error('render failed for a message', item && item.role, err);
        messagesEl.appendChild(el('div', 'status-line', `这条消息没能渲染（${item && item.role}）`));
      }
      // The end of a turn that changed files: what changed, and 撤销 (1.5.8).
      if (item.turnId && turnEnds.get(item.turnId) === items.indexOf(item) && changesByTurn.has(item.turnId)) {
        placeChanges(changesLine(item.turnId, changesByTurn.get(item.turnId)), replyOfTurn.get(item.turnId));
      }
    }
    // The last ended turn's result goes at the bottom only while it is the newest
    // thing in the chat and nothing runs: an old "已取消" must not sit under a
    // turn that is running now.
    const last = statuses[statuses.length - 1];
    const working = Boolean(state.attention?.items?.[currentChatKey()]?.working);
    const newer = items.some((it) => it.ts && last?.ts && it.ts > last.ts);
    // A restart's cut-off turn said so in words already (1.5.41: not again as "needs_attention - …").
    if (last && last.status !== 'success' && last.status !== 'needs_attention' && !newer && !working) messagesEl.appendChild(statusLine(last));
    // A reload wiped the "working…" line; the bot is still at it.
    const att = state.attention?.items?.[currentChatKey()];
    if (working) showTyping(typingBotId(), att?.needsYou || att?.asking ? '等你点头…' : '正在处理…');
  }

  if (visible.length) appendStarters(visible);
  // 「接入真实模型」 from the demo: the same three brains as the first run, under the chat (1.5.61 beginner test).
  if (visible.length && onboard.reopened && state.unconfigured && !state.mockAck && !remoteChatMachine()) messagesEl.appendChild(onboardingCard());
  showNextSteps(); // under the newest reply, while nothing runs (1.5.58)
  updateComposerMode();
  renderVideoJobs();
  restoreChatPlace(place, `bot:${state.botId}`);
}

/* --- file changes a turn made, undoable for 7 days (1.5.8) ------------------
   fs_write / fs_delete in the workspace return an undo id; the line under the
   turn lists the files and puts them all back at once. */
function turnChanges(messages) {
  const byTurn = new Map();
  for (const m of messages) {
    const id = m.role === 'tool' && m.ok && m.output && m.output.undo;
    if (!id || !m.turnId) continue;
    const list = byTurn.get(m.turnId) || [];
    list.push({ id, path: m.output.path || '', kind: m.name === 'fs_delete' ? 'delete' : 'write' });
    byTurn.set(m.turnId, list);
  }
  return byTurn;
}

state.undone = state.undone || new Set();
/** The turn's changed files: small words in the reply's action row; names and 撤销 (asked first) behind a click (1.5.43). */
function changesLine(turnId, changes) { return changesChip(turnId, changes); }

/* --- videos being made in the background ------------------------------------
   "视频生成中 · 已等 3 分 · 通常约 6 分钟": shown at the bottom of the chat that
   asked, updated until the video is there. */
const videoWatch = { timer: null, data: null, key: '' };
async function renderVideoJobs() {
  clearTimeout(videoWatch.timer); if (remoteChatMachine()) return appendQueuedMessages(); // 1.5.42: its videos are made there
  const key = currentChatKey();
  const q = isGroupMode() ? `groupId=${encodeURIComponent(state.groupId)}` : `botId=${encodeURIComponent(state.botId || '')}`;
  let data;
  try { data = await api(`/api/media/jobs?${q}`); } catch { return; }
  if (key !== currentChatKey()) return;
  messagesEl.querySelector('.video-jobs')?.remove();
  const running = (data.jobs || []).filter((j) => j.state === 'running');
  if (!running.length) return;
  const box = el('div', 'video-jobs');
  const mins = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} 秒` : `${Math.round(s / 60)} 分钟`);
  for (const j of running) {
    const waited = (Date.now() - j.createdAt) / 1000;
    const typical = data.typicalSec;
    let eta = typical ? `通常约 ${mins(typical)}` : '通常 3–15 分钟';
    if (typical && waited > typical * 1.5) eta = '比平时慢，还在等';
    const line = el('div', 'video-job');
    line.appendChild(el('span', 'typing-dots', ''));
    line.firstChild.innerHTML = '<i></i><i></i><i></i>';
    line.appendChild(el('span', null, `视频生成中：${truncate(j.prompt || '', 40)} · 已等 ${mins(waited)} · ${eta}`));
    box.appendChild(line);
  }
  messagesEl.appendChild(box);
  keepTypingLast();
  videoWatch.timer = setTimeout(renderVideoJobs, 15000);
}

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "11月5日周三 18:05" — the day plus the time of its first message. */
function daySeparator(ts) {
  const d = new Date(ts);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return el('div', 'day-sep', `${d.getMonth() + 1}月${d.getDate()}日${week} ${hh}:${mm}`);
}

function emptyState() {
  if (state.unconfigured && !state.mockAck && !remoteChatMachine()) return onboardingCard();
  if (onboard.justConnected && !remoteChatMachine()) return firstThingsCard(); // 1.5.61: 第一件事, once connected
  const card = welcomeCard();
  const bot = botById(state.botId); // its machine is off: said first (1.5.59 beginner test, a phone)
  if (!isGroupMode() && bot?.remote && !bot.remote.online) card.prepend(el('div', 'status-line link-down-line', `离线 · ${OFFLINE_WORDS}`));
  return card;
}

/* One row of an A/B choice card. Same shape in the empty state and in
   approvals, so the whole product teaches a single interaction. */
function choiceButton(key, title, desc, onPick) {
  const btn = el('button', 'choice');
  btn.type = 'button';
  btn.appendChild(el('span', 'choice-key', key));
  const body = el('span', 'choice-body');
  body.appendChild(el('span', 'choice-title', title));
  if (desc) body.appendChild(el('span', 'choice-desc', desc));
  btn.appendChild(body);
  btn.appendChild(el('span', 'choice-go', '›'));
  btn.addEventListener('click', onPick);
  return btn;
}

/** The empty chat's mark: the bot you are talking to, else the app icon. */
function emptyMark() {
  const bot = botById(state.botId);
  if (bot) {
    const av = el('span', 'empty-avatar');
    lampMount(av, bot, 54, 'empty-avatar');
    av.setAttribute('aria-hidden', 'true');
    return av;
  }
  const img = document.createElement('img');
  img.className = 'empty-avatar';
  img.src = 'icons/icon-128.png';
  img.alt = '';
  return img;
}

/**
 * A specialist bot's empty chat looks like a chat: its own greeting, in its
 * role, and a few starts taken from that role ("写脚本和分镜" …).
 */
function roleStarts(role) {
  const body = String(role || '').split(/[:：]/).slice(1).join('：') || String(role || '');
  return body.split(/[、，,；;。]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 18).slice(0, 4);
}

function specialistWelcome(bot) {
  const wrap = el('div', 'specialist-welcome');
  const row = el('div', 'row assistant');
  const bubble = el('div', 'bubble');
  const pad = padName(bot.name);
  const role = String(bot.role || '').replace(/[。.]+$/, '');
  bubble.appendChild(el('div', null, role ? `你好，我是${pad}${bot.name}，${role}。` : `你好，我是${pad}${bot.name}。`));
  bubble.appendChild(el('div', 'muted', onLocalMachine()
    ? '把要做的事直接发给我；要动文件或系统时我会先问你。也可以让主助理把活派给我。'
    : '把要做的事直接发给我，我自己做完。也可以让主助理把活派给我。'));
  // 「你会做什么？」 and one 「帮我…」 from its role: the role's pieces alone (「打分排序」) read as nothing (1.5.54, walkthrough 3.6).
  const first = roleStarts(bot.role).find((s) => s.length >= 4);
  const starts = ['你会做什么？', ...(first ? [`帮我${first.replace(/^帮我/, '')}`] : [])];
  if (starts.length) {
    const chips = el('div', 'start-chips');
    for (const s of starts) {
      const chip = el('button', 'btn tiny', s);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        const composer = $('composer');
        composer.value = /[？?]$/.test(s) ? s : `${s}：`;
        autoGrow(composer);
        composer.focus();
      });
      chips.appendChild(chip);
    }
    bubble.appendChild(chips);
  }
  row.appendChild(bubble);
  wrap.appendChild(row);
  return wrap;
}

function welcomeCard() {
  const bot = botById(state.botId);
  if (bot && !bot.primary) return specialistWelcome(bot);
  const wrap = el('div', 'empty');
  const name = bot ? bot.name : ($('chat-title').textContent || '助手');
  const pad = padName(name);
  const intro = bot && !bot.primary && bot.role
    ? `我是${pad}${name}，${bot.role}`
    : `我是${pad}${name}，告诉我要做什么，我来把它办完`;
  wrap.appendChild(emptyMark());
  wrap.appendChild(el('h2', null, '今天想让我做什么？'));
  // This computer asks before changing things; a remote machine is the bots' own.
  wrap.appendChild(el('p', null, onLocalMachine()
    ? `${intro}。要动文件或系统的操作，我会先问过你。`
    : `${intro}。这台机器交给我了，我会自己把事情做完。`));

  const choices = el('div', 'choice-list');
  for (const [key, title, desc, prompt] of STARTER_EXAMPLES) {
    choices.appendChild(choiceButton(key, title, desc, () => {
      const composer = $('composer');
      composer.value = prompt;
      autoGrow(composer);
      composer.focus();
    }));
  }
  wrap.appendChild(choices);
  wrap.appendChild(el('div', 'empty-foot', '也可以直接输入，Enter 发送。'));
  // One way in (1.5.40): the human need not work out which assistant a job belongs to.
  wrap.appendChild(el('div', 'empty-tip', askPrimaryTip()));
  return wrap;
}

function statusLine(item) {
  const map = {
    needs_approval: ['warn', '已暂停 · 等你批准'],
    failed: ['bad', '运行失败'],
    timeout: ['warn', '超时了'],
    cancelled: ['bad', '已取消'],
    max_steps: ['warn', '到达步数上限，先停下了'],
  };
  // The same call three times is "stuck", not the step limit.
  const stuck = item.status === 'max_steps' && /^Stopped: repeated /.test(item.summary || '');
  const [kind, label] = stuck ? ['warn', '同一个操作重复了，先停下了'] : (map[item.status] || ['warn', statusWords(item.status)]);
  if (stuck) {
    const line = el('div', 'status-line');
    line.appendChild(el('span', 'dot warn'));
    line.appendChild(el('span', null, label));
    return line;
  }
  const line = el('div', 'status-line');
  line.appendChild(el('span', `dot ${kind === 'bad' ? 'bad' : 'warn'}`));
  line.appendChild(el('span', null, `${label}${item.summary ? ` - ${reasonLabel(item.summary)}` : ''}`));
  return line;
}

/* ---------------------------------------------------------------------
   markdown: the models write markdown (bold, lists, tables, `code`), so the
   transcript has to render it instead of dumping the punctuation. Deliberately
   small and dependency-free: escape first, then a handful of block/inline
   rules. Anything not recognised stays as plain text.
   --------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="ext-link" href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(BARE_URL, (m, lead, url) => `${lead}<a class="ext-link" href="${url}" target="_blank" rel="noreferrer">${url}</a>`); // bare addresses too (1.5.41)
}

/** Very small markdown subset: fences, headings, lists, tables, quotes, rules. */
function mdToHtml(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushTable = (rows) => {
    if (!rows.length) return;
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const header = cells(rows[0]);
    const body = rows.slice(1).filter((r) => !/^\s*\|?[\s:-]+\|/.test(r));
    out.push('<div class="md-table"><table><thead><tr>'
      + header.map((c) => `<th>${mdInline(escapeHtml(c))}</th>`).join('')
      + '</tr></thead><tbody>'
      + body.map((r) => `<tr>${cells(r).map((c) => `<td>${mdInline(escapeHtml(c))}</td>`).join('')}</tr>`).join('')
      + '</tbody></table></div>');
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // closing fence
      out.push(`<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      flushTable(rows);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level} class="md-h">${mdInline(escapeHtml(heading[2]))}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      out.push('<hr class="md-rule">');
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${buf.map((l) => mdInline(escapeHtml(l))).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="md-list">${items.map((t) => `<li>${mdInline(escapeHtml(t))}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*(```|\||#{1,4}\s|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p class="md-p">${buf.map((l) => mdInline(escapeHtml(l))).join('<br>')}</p>`);
  }
  return out.join('');
}

/** True when the text actually contains markdown worth rendering. */
function looksMarkdown(text) {
  const s = String(text || '');
  return /```|`[^`]+`|\*\*[^*]+\*\*|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*#{1,4}\s|^\s*\|.*\|\s*$|^\s*>|\[[^\]\n]+\]\(https?:\/\//m.test(s); // a [link](https://…) alone too (1.5.41)
}

function renderItem(item) {
  switch (item.role) {
    case 'user':
      // A background job reporting back (video ready): a note, not something the human said.
      if (item.source === 'media') return el('div', 'status-line', /没有生成成功/.test(item.text || '') ? '后台任务：视频没有生成成功' : '后台任务：视频生成好了');
      // Another bot wrote this (a hand-off): its face and name, not the human's bubble.
      if (item.fromBot) return botMessageRow(item);
      // A scheduled run: one line naming the task, the instruction folded (1.5.11).
      if (item.source === 'routine') return routineRunRow(item);
      if (item.source === 'followup' || item.source === 'watch') return el('div', 'status-line', initiativeLine(item.text, item.source)); // a bot waking itself (1.5.45)
      return userRow(item);
    case 'assistant':
      // A run that found nothing new already says so on its line.
      if (item.source === 'routine' && item.turnId && quietRun(item.turnId)) return document.createDocumentFragment();
      return assistantRow(item.text, { system: item.system });
    case 'tool': {
      const node = toolChip(item);
      // Action cards sit in the replies' column, like a reply.
      if (!isActionCard(item.name, item)) return node;
      const row = el('div', 'row assistant card-row');
      row.appendChild(node);
      return row;
    }
    case 'approval':
      return buildApprovalCard(item);
    case 'plan': {
      const row = el('div', 'row assistant card-row');
      row.appendChild(planCard(item.planId, item.text));
      return row;
    }
    default:
      return el('div', 'status-line', item.text || item.role);
  }
}

/** A "显示 / 隐藏" button inside each password box (keys, SSH passwords). */
function addRevealButtons(root) {
  const inputs = root.matches?.('input[type="password"]') ? [root] : [...(root.querySelectorAll?.('input[type="password"]') || [])];
  for (const input of inputs) {
    if (input.dataset.reveal) continue;
    input.dataset.reveal = '1';
    const wrap = el('span', 'pw-wrap');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = el('button', 'pw-eye', '显示');
    btn.type = 'button';
    btn.setAttribute('aria-label', '显示或隐藏内容');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
      input.focus();
    });
    wrap.appendChild(btn);
  }
}

/** The desktop app on this computer can open the bots' files with their usual program. */
function canOpenLocally() {
  return Boolean(window.desk?.openFile) && onLocalMachine();
}

async function openLocalFile(rel, reveal) {
  if (!rel || !canOpenLocally()) return;
  const r = await window.desk.openFile(rel, reveal).catch((err) => ({ ok: false, error: err.message }));
  if (!r?.ok) toast(`打不开：${r?.error || '未知原因'}`, true);
  else if (r.message) toast(r.message);
}

/** A file a reply names that is not on this machine: which machine has it (cached). */
const elsewhere = new Map(); // path -> Promise<machine|null>
const elsewhereTitles = new Map(); // page path -> its title on that machine
function findElsewhere(path) {
  if (!elsewhere.has(path)) {
    elsewhere.set(path, api(`/api/peers/locate?path=${encodeURIComponent(path)}`).then((r) => {
      if (r.title) elsewhereTitles.set(path, r.title);
      return r.machine || null;
    }).catch(() => null));
  }
  return elsewhere.get(path);
}
const remoteFileUrl = (machine, path) => `/api/peers/${encodeURIComponent(machine)}/file?path=${encodeURIComponent(path)}`;

function attachmentNode(file) {
  if (file.folder) return folderCard(file); // 1.5.64, 05b-folder.js
  if (file.page) {
    const card = el('button', 'att-page');
    card.type = 'button';
    card.appendChild(el('span', 'att-icon', '📊'));
    const meta = el('span', 'att-meta');
    const known = (state.pages || []).find((p) => p.name === file.page);
    const name = el('span', 'att-name', known?.title || file.page);
    meta.appendChild(name);
    meta.appendChild(el('span', 'att-size', '页面 · 点开查看'));
    card.appendChild(meta);
    card.addEventListener('click', () => openPageViewer(file.page, known?.title));
    // The title, once the library is known (the bot may only have written the path).
    if (!known) {
      (state.pagesLoading ||= loadPages().catch(() => [])).then((list) => {
        const hit = (list || []).find((p) => p.name === file.page);
        if (hit) { name.textContent = hit.title; return; }
        // Made on another machine (a briefing names it): open it from there.
        findElsewhere(file.path).then((machine) => {
          if (!machine) { card.querySelector('.att-size').textContent = '页面 · 哪台机器上都找不到'; return; }
          card.querySelector('.att-size').textContent = `页面 · 在「${machine}」上 · 点开查看`;
          card.dataset.machine = machine;
          if (elsewhereTitles.get(file.path)) name.textContent = elsewhereTitles.get(file.path);
        });
      });
    }
    card.addEventListener('click', (event) => {
      if (!card.dataset.machine) return;
      event.stopImmediatePropagation();
      openPageViewer(file.page, elsewhereTitles.get(file.path) || null, card.dataset.machine);
    }, true);
    return card;
  }
  const url = chatFileUrl(file.path); // from the machine of the chat's bot (1.5.42)
  if (file.video) return videoCard(file, url); // a frame, play, its length (1.5.49, 10-computer.js)
  if (file.image) {
    const a = el('a', 'att-img');
    a.href = url;
    a.title = file.name;
    a.addEventListener('click', (event) => { event.preventDefault(); openLightbox(a.href || url, file.name); });
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name;
    img.loading = 'lazy';
    // A path the bot mentioned may not exist here: maybe on another machine.
    img.addEventListener('error', () => {
      if (img.dataset.tried) { a.remove(); return; }
      img.dataset.tried = '1';
      findElsewhere(file.path).then((machine) => {
        if (!machine) { a.remove(); return; }
        img.src = remoteFileUrl(machine, file.path);
        a.href = img.src;
        a.title = `${file.name} · 在「${machine}」上`;
      });
    });
    a.appendChild(img);
    return a;
  }
  if (file.pdf || file.doc) return docCard(file, url);
  const a = el('a', 'att-file');
  a.href = url;
  a.setAttribute('download', file.name);
  // On this computer: open it with its program instead of downloading a copy.
  if (canOpenLocally()) {
    a.title = '点开用系统程序打开；按住 Ctrl 点击：在文件夹中显示';
    a.addEventListener('click', (event) => { event.preventDefault(); openLocalFile(file.path, event.ctrlKey || event.metaKey); });
  }
  a.appendChild(el('span', 'att-icon', '📄'));
  const meta = el('span', 'att-meta');
  meta.appendChild(el('span', 'att-name', file.name));
  meta.appendChild(el('span', 'att-size', file.size));
  a.appendChild(meta);
  return a;
}

/**
 * A bot id said in the open chat (a hand-off's sender, a bot_message target), as that bot (1.5.65).
 * In a chat of a bot on another machine (全部机器) a plain id is a bot over there - never this
 * machine's bot of the same id: 「bot-xxxxxx → 发布」 read as a raw id. From that machine's roster,
 * else from one of its groups' members, with its face.
 */
function chatBotById(id) {
  const raw = String(id || '');
  if (!raw) return null;
  const far = isRemoteId(state.botId) && !isRemoteId(raw) ? remoteOf(state.botId) : null;
  if (!far) return botById(raw);
  const there = `${raw}@${far.machine}`;
  const known = botById(there);
  if (known) return faceOf(known);
  const m = (state.peerRoster || []).find((x) => x.machine === far.machine);
  for (const g of m?.groups || []) {
    const member = (g.members || []).find((x) => x && x.id === raw);
    if (member?.name) return faceOf({ ...member, id: there });
  }
  return null;
}

/** A message one bot sent another: "文案 → 质检", with the sender's face. */
function botMessageRow(item) {
  const sender = chatBotById(item.fromBot) || { id: item.fromBot, name: item.fromBot };
  // One line, the words behind a click (1.5.40).
  const row = handoffRow({ sender, target: botById(state.botId), text: item.text || '', state: item.handoffState || '', ts: item.ts });
  row.classList.add('from-bot');
  return row;
}

/** "@质检" in a message: a chip with that bot's face, so it is clear who is meant. */
function decorateMentions(node) {
  // In a group: its members too - another machine's group names its own (1.5.64), with their faces.
  const people = [...(isGroupMode() ? groupMembers(groupById(state.groupId)) : []), ...(state.bots || [])];
  const names = [...new Set(people.map((b) => b && b.name).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!node || !names.length || !String(node.textContent || '').includes('@')) return;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@(${names.map(esc).join('|')})`, 'g');
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement?.closest('code, pre, a, .mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const probe = new RegExp(re.source); // no /g: test() keeps no position between nodes
  const hits = [];
  while (walker.nextNode()) if (probe.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
  for (const textNode of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const value = textNode.nodeValue;
    re.lastIndex = 0;
    for (const m of value.matchAll(re)) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
      const bot = people.find((b) => b && b.name === m[1]);
      const chip = el('span', 'mention');
      if (bot) chip.appendChild(avatarNode(bot, 16));
      chip.appendChild(document.createTextNode(`@${m[1]}`));
      frag.appendChild(chip);
      last = m.index + m[0].length;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    textNode.replaceWith(frag);
  }
}

function userRow(item) {
  const row = el('div', 'row user');
  const { text, files } = splitAttachments(item.text);
  const wrap = el('div', 'bubble', text);
  decorateMentions(wrap);
  wrap.title = fmtClock(item.ts);
  if (files.length) {
    const box = el('div', 'att-list');
    files.forEach((f) => box.appendChild(attachmentNode(f)));
    if (text) wrap.appendChild(box);
    else { wrap.textContent = ''; wrap.appendChild(box); wrap.classList.add('only-att'); }
  }
  row.appendChild(wrap);
  return row;
}

/* ---------------------------------------------------------------------
   attachments in the composer: pick, paste or drop; each file uploads at
   once into the workspace and waits as a chip until the message is sent
   --------------------------------------------------------------------- */
state.pendingFiles = [];

function renderAttachStrip() {
  const strip = $('attach-strip');
  if (!strip) return;
  strip.innerHTML = '';
  strip.hidden = state.pendingFiles.length === 0;
  syncComposerActions();
  const notes = [];
  for (const f of state.pendingFiles) {
    if (f.folder) {
      // A folder (1.5.64): one chip; what was left out, named under the chips before sending.
      const chip = folderChip(f);
      chip.appendChild(removeChipButton(f));
      strip.appendChild(chip);
      const note = folderLeftOut(f);
      if (note) notes.push(note);
      continue;
    }
    const chip = el('div', `att-chip${f.status === 'uploading' ? ' busy' : ''}${f.status === 'error' ? ' bad' : ''}`);
    if (f.preview) {
      const img = document.createElement('img');
      img.src = f.preview;
      img.alt = '';
      chip.appendChild(img);
    } else {
      chip.appendChild(el('span', 'att-icon', '📄'));
    }
    chip.appendChild(el('span', 'att-chip-name', f.status === 'uploading' ? '上传中…' : f.status === 'error' ? `上传失败：${f.error}` : f.name));
    chip.appendChild(removeChipButton(f));
    strip.appendChild(chip);
  }
  notes.forEach((n) => strip.appendChild(n));
}

/* --- voice input ---------------------------------------------------------
   Click the mic (or Ctrl+D) to talk, click again to stop; the words land in
   the composer to be read and sent like typing. Esc throws the take away. */
const VOICE_MAX_MS = 3 * 60 * 1000;
const voice = { status: null, recorder: null, stream: null, chunks: [], started: 0, timer: null, cancelled: false };

async function loadVoice() {
  const v = await api('/api/voice');
  voice.status = v;
  const note = $('voice-state');
  if (!note) return v;
  note.textContent = v.available
    ? (v.source === 'model' ? `可以用了：沿用聊天模型的密钥，转写模型 ${v.model}。` : `可以用了：${v.model}。`)
    : '还不能用：当前的聊天模型服务商不提供语音转写，选一个下面的服务并填密钥。';
  const providers = v.providers || [{ id: 'siliconflow', label: '硅基流动 SenseVoice', ...v.preset }];
  voice.providers = providers;
  const select = $('voice-provider');
  select.innerHTML = providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
  const match = providers.find((p) => p.baseUrl && v.source === 'own' && p.baseUrl === v.baseUrl);
  select.value = v.source === 'own' ? (match ? match.id : 'custom') : providers[0].id;
  applyVoiceProvider(false);
  if (v.source === 'own') {
    $('voice-baseurl').value = v.baseUrl;
    $('voice-model').value = v.model;
  }
  $('voice-apikey').value = '';
  $('voice-apikey').placeholder = v.hasKey ? '已保存（留空不改）' : 'sk-…';
  $('voice-clear').hidden = !v.hasKey;
  const tts = v.tts || {};
  if ($('tts-auto')) {
    $('tts-auto').value = readAloudMode();
    $('tts-state').textContent = tts.available ? '用上面同一个语音服务和密钥。每个机器人的声音在「管理助手」里选。' : '现在的语音服务不支持朗读：选硅基流动（或 OpenAI）并填密钥就能用。';
  }
  return v;
}

/* --- read replies aloud ----------------------------------------------------
   One reply plays at a time; auto-read queues the parts of one answer. */
const speech = { audio: null, button: null, queue: [], playing: false };

function readAloudMode() {
  try { return localStorage.getItem('desk.readAloud') || 'voice'; } catch { return 'voice'; }
}

/** "Reading aloud · Stop" above the message box, whenever something is being read. */
function updateSpeakBar() {
  const bar = $('speak-bar');
  if (bar) bar.hidden = !(speech.playing || speech.loading);
}

function stopSpeaking() {
  speech.queue = [];
  speech.stopped = Date.now();
  // Stopped by the human: the rest of this answer is not read either.
  state.readAloudTurn = false;
  if (speech.audio) { speech.audio.pause(); speech.audio = null; }
  speech.button?.classList.remove('playing');
  if (speech.button) speech.button.textContent = '🔊 朗读';
  speech.button = null;
  speech.playing = false;
  speech.loading = false;
  updateSpeakBar();
}

/** voiceOf: {botId} reads in that bot's voice, {voice} in that voice (试听). */
/** The audio for one text (a call fetches the next sentence while one plays, 1.5.22). */
async function speechBlob(text, voiceOf = {}) {
  const res = await fetch('/api/voice/speak', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(voiceOf.voice ? { voice: voiceOf.voice } : voiceOf.botId ? { botId: voiceOf.botId } : {}) }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return res.blob();
}

async function speakText(text, button = null, voiceOf = {}, ready = null) {
  const asked = Date.now();
  speech.loading = true;
  updateSpeakBar();
  let blob;
  try {
    blob = await (ready || speechBlob(text, voiceOf));
  } finally {
    speech.loading = false;
    updateSpeakBar();
  }
  // Stopped while the audio was still being made: do not start it.
  if ((speech.stopped || 0) > asked) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  speech.audio = audio;
  speech.button = button;
  speech.playing = true;
  updateSpeakBar();
  if (button) { button.classList.add('playing'); button.textContent = '■ 停止'; }
  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.onpause = resolve;
    audio.play().catch(resolve);
  });
  URL.revokeObjectURL(url);
  if (speech.audio === audio) { speech.audio = null; speech.playing = false; }
  if (button) { button.classList.remove('playing'); button.textContent = '🔊 朗读'; }
  updateSpeakBar();
}


/**
 * What the desktop app's right-click menu does with selected text (main.mjs
 * calls these): read it aloud, translate it, or hand it to the assistant.
 */
window.lamplitSelection = {
  speak(text) {
    stopSpeaking();
    speakText(String(text || '')).catch((err) => toast(`朗读失败：${err.message}`, true));
  },
  async translate(text) {
    toast('正在翻译…');
    try {
      const r = await api('/api/translate', { method: 'POST', body: { text: String(text || '') } });
      hideToast();
      const shown = askConfirm({ title: r.target === 'English' ? '翻译成英文' : '翻译成中文', text: r.text || '（没有译文）', confirmLabel: '复制译文' });
      $('confirm-ok').classList.remove('danger');
      if (await shown) {
        await navigator.clipboard.writeText(r.text || '');
        toast('译文已复制');
      }
    } catch (err) {
      toast(`翻译失败：${err.message}`, true);
    }
  },
  ask(text) {
    const box = $('composer');
    if (!box) return;
    box.value = `${box.value ? `${box.value}\n` : ''}「${String(text || '').trim()}」\n`;
    box.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

function speakButton(text, botId = '') {
  const btn = el('button', 'speak-btn', '🔊 朗读');
  btn.type = 'button';
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (speech.button === btn) { stopSpeaking(); return; }
    stopSpeaking();
    btn.textContent = '…';
    try { await speakText(text, btn, { botId }); } catch (err) { btn.textContent = '🔊 朗读'; toast(`朗读失败：${err.message}`, true); }
  });
  return btn;
}

/** Fill URL, model and key link from the chosen service. */
function applyVoiceProvider(fill = true) {
  const p = (voice.providers || []).find((x) => x.id === $('voice-provider').value);
  if (!p) return;
  const custom = p.id === 'custom';
  $('voice-baseurl').placeholder = p.baseUrl || 'https://…/v1';
  $('voice-model').placeholder = p.model || 'whisper-1';
  $('voice-models').innerHTML = (p.models || [p.model].filter(Boolean)).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  if (fill) {
    $('voice-baseurl').value = custom ? '' : p.baseUrl;
    $('voice-model').value = custom ? '' : p.model;
  }
  const link = $('voice-keyurl');
  link.hidden = !p.keyUrl;
  if (p.keyUrl) link.href = p.keyUrl;
}

async function saveVoice(clear = false) {
  const body = clear
    ? { apiKey: '' }
    : { baseUrl: $('voice-baseurl').value.trim(), model: $('voice-model').value.trim() };
  const key = $('voice-apikey').value.trim();
  if (!clear && key) body.apiKey = key;
  try {
    await api('/api/voice', { method: 'PUT', body });
    await loadVoice();
    // In the desktop app a new key goes to every machine at once: hubs never
    // give a key back, so this is the moment it can travel.
    if (!clear && body.apiKey && window.desk?.syncVoice) {
      const res = await window.desk.syncVoice(body).catch(() => null);
      const failed = (res?.results || []).filter((r) => !r.ok);
      toast(
        !res?.ok ? '语音设置已保存（没同步到其他机器）'
          : failed.length ? `语音设置已保存；没同步上：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`
          : '语音设置已保存，并同步到所有机器',
        Boolean(failed.length || !res?.ok),
      );
      return;
    }
    toast(clear ? '语音密钥已清除' : '语音设置已保存');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

/* --- vision (image_view) settings ------------------------------------------ */
const vision = { status: null, providers: [] };

/* A model box with a list: a browser shows only the options that match what
   is typed, so with the current model filled in the list looked like one
   choice. While the box has focus it is empty (the current model shows as
   the hint) and every option shows; leaving it without a pick puts it back. */
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.getAttribute('list') || !el.value) return;
  el.dataset.kept = el.value;
  el.dataset.hint = el.placeholder;
  el.placeholder = el.value;
  el.value = '';
});
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.dataset.kept === undefined) return;
  if (!el.value) el.value = el.dataset.kept;
  el.placeholder = el.dataset.hint || '';
  delete el.dataset.kept;
  delete el.dataset.hint;
});

/** Settings → 模型 → 用订阅额度的编程助手: what this machine has. */
async function loadCliAgents(refresh = false) {
  const box = $('cliagents-list');
  if (!box) return;
  let data;
  try { data = await api(`/api/cliagents${refresh ? '?refresh=1' : ''}`); } catch { box.textContent = '这台机器的 Lamplit 版本太旧，还不支持。'; return; }
  box.innerHTML = '';
  for (const a of data.agents || []) {
    const row = document.createElement('div');
    row.style.margin = '6px 0';
    const name = document.createElement('b');
    name.textContent = a.label;
    const state = document.createElement('span');
    state.textContent = a.installed ? (a.loggedIn ? '：已装好，已登录，可以用' : '：已装好，还没登录') : '：没装';
    row.append(name, state);
    const how = document.createElement('div');
    how.className = 'mono';
    how.style.fontSize = 'var(--t-xs)';
    how.textContent = !a.installed ? `安装：${a.install}` : !a.loggedIn ? `登录：在这台机器的终端里运行 ${a.login}` : '';
    if (how.textContent) row.appendChild(how);
    // Which model it uses by default: its own list when it gives one, any name typed in.
    if (a.installed) {
      const pick = document.createElement('div');
      pick.className = 'btn-row';
      pick.style.margin = '4px 0 0';
      const input = document.createElement('input');
      input.className = 'field';
      input.style.flex = '1';
      input.style.minWidth = '0';
      input.placeholder = '默认模型（留空用它自己的默认）';
      input.value = a.model || '';
      input.setAttribute('list', `cliagent-models-${a.id}`);
      input.autocomplete = 'off';
      input.spellcheck = false;
      const list = document.createElement('datalist');
      list.id = `cliagent-models-${a.id}`;
      list.innerHTML = (a.models || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
      const save = document.createElement('button');
      save.className = 'btn tiny';
      save.type = 'button';
      save.textContent = '保存模型';
      save.addEventListener('click', async () => {
        try {
          await api('/api/cliagents', { method: 'PUT', body: { agent: a.id, model: input.value.trim() } });
          toast(input.value.trim() ? `${a.label} 默认用 ${input.value.trim()}` : `${a.label} 用它自己的默认模型`);
        } catch (err) { toast(`保存失败：${err.message}`, true); }
      });
      pick.append(input, list, save);
      row.appendChild(pick);
      if ((a.models || []).length) {
        const note = document.createElement('div');
        note.className = 'row-note';
        note.style.fontSize = 'var(--t-xs)';
        note.textContent = `可选 ${a.models.length} 个：点输入框选，或直接填模型名。机器人交活时也可以临时换模型。`;
        row.appendChild(note);
      }
    }
    box.appendChild(row);
  }
}

async function loadVision() {
  const v = await api('/api/vision');
  vision.status = v;
  vision.providers = v.providers || [];
  const note = $('vision-state');
  if (!note) return v;
  note.textContent = !v.available
    ? '还不能用：选一个看图服务并填密钥（硅基流动的密钥就行）。'
    : v.source === 'own' ? `已可用：${v.model}。`
      : v.source === 'voice' ? `已可用：沿用语音输入的硅基流动密钥，看图模型 ${v.model}。`
        : `已可用：沿用聊天模型的密钥，看图模型 ${v.model}。`;
  const select = $('vision-provider');
  select.innerHTML = vision.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
  // Two SiliconFlow entries (8B / 32B): the model tells them apart.
  const match = v.source === 'own'
    ? (vision.providers.find((p) => p.baseUrl && p.baseUrl === v.baseUrl && p.model === v.model) || vision.providers.find((p) => p.baseUrl && p.baseUrl === v.baseUrl))
    : null;
  select.value = v.source === 'own' ? (match ? match.id : 'custom') : (vision.providers[0]?.id || 'custom');
  applyVisionProvider(false);
  if (v.source === 'own') {
    $('vision-baseurl').value = v.baseUrl;
    $('vision-model').value = v.model;
  }
  $('vision-apikey').value = '';
  $('vision-apikey').placeholder = v.hasKey ? '已保存（留空不改）' : 'sk-…';
  $('vision-clear').hidden = !v.hasKey;
  return v;
}

function applyVisionProvider(fill = true) {
  const p = vision.providers.find((x) => x.id === $('vision-provider').value);
  if (!p) return;
  const custom = p.id === 'custom';
  $('vision-baseurl').placeholder = p.baseUrl || 'https://…/v1';
  $('vision-model').placeholder = p.model || 'model-name';
  if (fill) {
    $('vision-baseurl').value = custom ? '' : p.baseUrl;
    $('vision-model').value = custom ? '' : p.model;
  }
  const link = $('vision-keyurl');
  link.hidden = !p.keyUrl;
  if (p.keyUrl) link.href = p.keyUrl;
}

/* --- image / video generation settings (Settings > 模型 > 生图 / 生视频) -------- */
const media = { status: null };

async function loadMedia() {
  const m = await api('/api/media');
  media.status = m;
  for (const kind of ['image', 'video']) {
    const v = m[kind];
    const note = $(`media-${kind}-state`);
    if (!note || !v) continue;
    note.textContent = !v.available
      ? '还不能用：选一个服务并填密钥（硅基流动的密钥就行）。'
      : v.source === 'voice' ? `已可用：沿用语音输入的硅基流动密钥，模型 ${v.model}。` : `已可用：${v.model}。`;
    const select = $(`media-${kind}-service`);
    select.innerHTML = (v.services || []).map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('');
    select.value = v.service;
    applyMediaService(kind, false);
    if (v.model) $(`media-${kind}-model`).value = v.model;
    if (v.baseUrl) $(`media-${kind}-baseurl`).value = v.baseUrl;
    $(`media-${kind}-apikey`).value = '';
    $(`media-${kind}-apikey`).placeholder = v.hasKey ? '已保存（留空不改）' : 'sk-…';
    $(`media-${kind}-clear`).hidden = !v.hasKey;
  }
  return m;
}

function applyMediaService(kind, fill = true) {
  const services = media.status?.[kind]?.services || [];
  const s = services.find((x) => x.id === $(`media-${kind}-service`).value);
  if (!s) return;
  $(`media-${kind}-models`).innerHTML = (s.models || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  $(`media-${kind}-model`).placeholder = s.model;
  $(`media-${kind}-baseurl`).placeholder = s.baseUrl;
  if (fill) {
    $(`media-${kind}-model`).value = s.model;
    $(`media-${kind}-baseurl`).value = s.baseUrl;
  }
  const link = $(`media-${kind}-keyurl`);
  link.hidden = !s.keyUrl;
  if (s.keyUrl) link.href = s.keyUrl;
}

async function saveMediaKind(kind, clear = false) {
  const path = `/api/media/${kind}`;
  const body = clear ? { apiKey: '' } : {
    service: $(`media-${kind}-service`).value,
    model: $(`media-${kind}-model`).value.trim(),
    baseUrl: $(`media-${kind}-baseurl`).value.trim(),
  };
  const key = $(`media-${kind}-apikey`).value.trim();
  if (!clear && key) body.apiKey = key;
  const what = kind === 'image' ? '生图' : '生视频';
  try {
    await api(path, { method: 'PUT', body });
    await loadMedia();
    if (!clear && body.apiKey && window.desk?.syncConfig) {
      const res = await window.desk.syncConfig({ path, body }).catch(() => null);
      const failed = (res?.results || []).filter((r) => !r.ok);
      toast(
        !res?.ok ? `${what}设置已保存（没同步到其他机器）`
          : failed.length ? `${what}设置已保存；没同步上：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`
            : `${what}设置已保存，并同步到所有机器`,
        Boolean(failed.length || !res?.ok),
      );
      return;
    }
    toast(clear ? `${what}密钥已清除` : `${what}设置已保存`);
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

async function saveVision(clear = false) {
  const body = clear ? { apiKey: '' } : { baseUrl: $('vision-baseurl').value.trim(), model: $('vision-model').value.trim() };
  const key = $('vision-apikey').value.trim();
  if (!clear && key) body.apiKey = key;
  try {
    await api('/api/vision', { method: 'PUT', body });
    await loadVision();
    if (!clear && body.apiKey && window.desk?.syncConfig) {
      const res = await window.desk.syncConfig({ path: '/api/vision', body }).catch(() => null);
      const failed = (res?.results || []).filter((r) => !r.ok);
      toast(
        !res?.ok ? '看图设置已保存（没同步到其他机器）'
          : failed.length ? `看图设置已保存；没同步上：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`
          : '看图设置已保存，并同步到所有机器',
        Boolean(failed.length || !res?.ok),
      );
      return;
    }
    toast(clear ? '看图密钥已清除' : '看图设置已保存');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

function setMicUi(mode) {
  const btn = $('mic-btn');
  const box = btn.closest('.composer-box');
  const input = $('composer');
  btn.classList.toggle('rec', mode === 'rec');
  btn.classList.toggle('busy', mode === 'busy');
  box.classList.toggle('recording', mode === 'rec');
  btn.title = mode === 'rec' ? '结束并转成文字（Ctrl+D）' : '语音输入（Ctrl+D）';
  if (mode === 'rec' || mode === 'busy') {
    if (input.dataset.ph === undefined) input.dataset.ph = input.placeholder;
    input.readOnly = true;
  } else {
    input.readOnly = false;
    if (input.dataset.ph !== undefined) { input.placeholder = input.dataset.ph; delete input.dataset.ph; }
  }
  if (mode === 'busy') input.placeholder = '正在转成文字…';
}

function tickRecording() {
  const s = Math.floor((Date.now() - voice.started) / 1000);
  $('composer').placeholder = `正在听… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · 再点一次麦克风结束，Esc 取消`;
  if (Date.now() - voice.started >= VOICE_MAX_MS) stopRecording();
}

async function toggleVoice() {
  if (voice.recorder) { stopRecording(); return; }
  if ($('mic-btn').classList.contains('busy')) return;
  let status = voice.status;
  try { status = await loadVoice(); } catch { /* use what we have */ }
  if (!status?.available) {
    toast('先配置语音转文字（一个硅基流动的免费密钥就行）', true);
    openSettings('sec-model');
    setTimeout(() => $('voice-set')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    return;
  }
  const micError = (name, message = '') => toast(
    name === 'NotAllowedError' ? '麦克风被拒绝了：请在系统设置里允许 Lamplit 使用麦克风'
      : name === 'NotFoundError' ? '没找到麦克风' : `打不开麦克风：${message || name}`, true);
  // Desktop app on a plain-http machine: the app records for the page.
  if ((!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) && window.desk?.voiceStart) {
    const started = await window.desk.voiceStart().catch((err) => ({ error: 'Error', message: err.message }));
    if (!started?.ok) { micError(started?.error, started?.message); return; }
    voice.chunks = [];
    voice.cancelled = false;
    voice.recorder = {
      mimeType: 'audio/webm',
      stop: async () => {
        if (voice.cancelled) {
          await window.desk.voiceCancel().catch(() => null);
        } else {
          const out = await window.desk.voiceStop().catch(() => null);
          if (out?.bytes) {
            voice.chunks = [out.bytes];
            voice.recorder.mimeType = out.mime || 'audio/webm';
          }
        }
        finishRecording();
      },
    };
    voice.started = Date.now();
    setMicUi('rec');
    tickRecording();
    voice.timer = setInterval(tickRecording, 500);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('这个页面不能用麦克风（需要 https 或本机地址）', true);
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    micError(err.name, err.message);
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  voice.recorder = new MediaRecorder(voice.stream, mime ? { mimeType: mime } : undefined);
  voice.chunks = [];
  voice.cancelled = false;
  voice.recorder.ondataavailable = (event) => { if (event.data?.size) voice.chunks.push(event.data); };
  voice.recorder.onstop = finishRecording;
  voice.recorder.start(1000);
  voice.started = Date.now();
  setMicUi('rec');
  tickRecording();
  voice.timer = setInterval(tickRecording, 500);
}

function stopRecording(cancel = false) {
  if (!voice.recorder) return;
  voice.cancelled = cancel;
  clearInterval(voice.timer);
  try { voice.recorder.stop(); } catch { finishRecording(); }
}

async function finishRecording() {
  const recorder = voice.recorder;
  voice.recorder = null;
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
  const type = (recorder?.mimeType || 'audio/webm').split(';')[0];
  const blob = new Blob(voice.chunks, { type });
  voice.chunks = [];
  if (voice.cancelled || Date.now() - voice.started < 600 || !blob.size) {
    setMicUi('idle');
    if (!voice.cancelled) toast('太短了，没听到内容', true);
    return;
  }
  setMicUi('busy');
  try {
    const res = await fetch('/api/voice/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    setMicUi('idle');
    const text = String(data.text || '').trim();
    if (!text) { toast('没听清，再说一次？', true); return; }
    voice.spokeSinceSend = true;
    const input = $('composer');
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at);
    const after = input.value.slice(input.selectionEnd ?? at);
    const glue = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + glue + text + after;
    const caret = (before + glue + text).length;
    input.focus();
    input.setSelectionRange(caret, caret);
    autoGrow(input);
  } catch (err) {
    setMicUi('idle');
    toast(err.message, true);
  }
}

/* --- @mention picker (groups) ---------------------------------------------
   Type "@" in a group to pick who should answer; Enter/Tab picks, Esc closes.
   The server routes the message to the members it names. */
const mention = { open: false, items: [], index: 0, start: -1 };

function mentionQuery() {
  const input = $('composer');
  const caret = input.selectionStart ?? input.value.length;
  const m = /(^|[\s\u3000（(，,])@([^\s@]{0,20})$/.exec(input.value.slice(0, caret));
  return m ? { query: m[2], start: caret - m[2].length - 1, caret } : null;
}

function closeMention() {
  mention.open = false;
  const pop = $('mention-pop');
  if (pop) pop.hidden = true;
}

function updateMention() {
  const pop = $('mention-pop');
  const group = isGroupMode() ? groupById(state.groupId) : null;
  const q = group ? mentionQuery() : null;
  if (!pop || !q) { closeMention(); return; }
  const needle = q.query.toLowerCase();
  const members = groupMembers(group);
  const items = [{ all: true, name: '所有人', role: '每个成员都回答' }]
    .concat(members.map((b) => ({ bot: b, name: b.name, role: b.role || '' })))
    .filter((it) => !needle || it.name.toLowerCase().includes(needle) || (it.all && /^(all|everyone|所有|全体)/i.test(needle)));
  if (!items.length) { closeMention(); return; }
  mention.items = items;
  mention.start = q.start;
  mention.index = Math.min(mention.index, items.length - 1);
  pop.innerHTML = '';
  items.forEach((it, i) => {
    const row = el('button', `mp-item${i === mention.index ? ' on' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.appendChild(it.all ? el('span', 'mp-all', '@') : avatarNode(it.bot, 22));
    row.appendChild(el('span', '', it.name));
    if (it.role) row.appendChild(el('small', '', it.role));
    row.addEventListener('mousedown', (event) => { event.preventDefault(); pickMention(i); });
    pop.appendChild(row);
  });
  pop.hidden = false;
  mention.open = true;
}

function pickMention(i) {
  const it = mention.items[i];
  const input = $('composer');
  const q = mentionQuery();
  if (!it || !q) { closeMention(); return; }
  const insert = `@${it.name} `;
  input.value = input.value.slice(0, q.start) + insert + input.value.slice(q.caret);
  const caret = q.start + insert.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autoGrow(input);
  closeMention();
}

function onMentionKey(event) {
  if (!mention.open || event.isComposing) return;
  const n = mention.items.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopImmediatePropagation();
    mention.index = (mention.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
    updateMention();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    event.stopImmediatePropagation();
    pickMention(mention.index);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMention();
  }
}

async function addFiles(fileList) {
  // 1.5.64: 20 a message (was 10); a folder counts once.
  for (const file of [...fileList]) {
    if (state.pendingFiles.length >= FOLDER_LIMITS.items) { toast(`一条消息最多 ${FOLDER_LIMITS.items} 个附件`, true); break; }
    if (file.size > 25 * 1024 * 1024) { toast(`「${file.name}」超过 25 MB`, true); continue; }
    const entry = { name: file.name || 'image.png', status: 'uploading', preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '' };
    state.pendingFiles.push(entry);
    renderAttachStrip();
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(entry.name) },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      Object.assign(entry, { status: 'ready', path: data.path, name: data.name });
    } catch (err) {
      Object.assign(entry, { status: 'error', error: err.message });
    }
    renderAttachStrip();
  }
}

function assistantRow(text, { system = false, streaming = false } = {}) {
  const row = el('div', 'row assistant');
  const wrap = el('div', `bubble${system ? ' system' : ''}${streaming ? ' streaming' : ''}`);
  fillBubble(wrap, text, system);
  row.appendChild(wrap);
  return row;
}

/*
 * Workspace files a reply mentions, in order, once each: pictures and videos
 * shown, documents as cards with 预览 / 下载 (1.5.11). On 11-16 four résumé
 * PDFs and "job/resume/preview/四版对照.png" showed nothing: only ASCII
 * names of pictures were recognised. Now any letters (Chinese too), PDFs and
 * office files, and a list of bare names under "PDF 在 job/resume/customized/：".
 */
const FILE_EXTS = 'png|jpe?g|gif|webp|mp4|webm|pdf|docx?|xlsx?|pptx?|csv|md|txt|zip';
const PATH_CH = '[\\p{L}\\p{N}_.\\-·]';
function fileKind(p) {
  if (/\.(png|jpe?g|gif|webp)$/i.test(p)) return { image: true };
  if (/\.(mp4|webm)$/i.test(p)) return { video: true };
  if (/\.pdf$/i.test(p)) return { pdf: true };
  return { doc: true };
}
function mentionedImages(text) {
  const seen = new Set();
  const out = [];
  const src = String(text || '');
  const add = (raw) => {
    const p = raw.replace(/^\.\//, '').replace(/^workspace\//, '');
    if (seen.has(p) || p.startsWith('/') || /:\/\//.test(p) || /^pages\/[a-z0-9-]+\.html$/.test(p)) return;
    seen.add(p);
    out.push({ path: p, ...fileKind(p), name: p.split('/').pop(), size: '' });
  };
  const before = '(?:^|[\\s`\'"(（「：:，,])';
  const after = '(?=$|[\\s`\'")）」（(，。,.;；:：、!！?？])';
  const hits = [];
  for (const m of src.matchAll(new RegExp(`${before}((?:${PATH_CH}+\\/)+${PATH_CH}+\\.(?:${FILE_EXTS}))${after}`, 'giu'))) hits.push({ at: m.index, path: m[1] });
  // Bare names in a list under a folder the reply named ("四份 PDF 在 job/resume/customized/：").
  const dirs = [...src.matchAll(new RegExp(`${before}((?:${PATH_CH}+\\/)+)(?=$|[\\s\`'"，。：:)）]|里|中|下)`, 'gu'))].map((m) => ({ at: m.index, dir: m[1] }));
  if (dirs.length) {
    for (const m of src.matchAll(new RegExp(`(?:^|[\\s\`'"(（「：:，,•*\\-])(${PATH_CH}+\\.(?:${FILE_EXTS}))${after}`, 'giu'))) {
      if (m[1].includes('/')) continue;
      const dir = [...dirs].reverse().find((d) => d.at < m.index);
      if (dir) hits.push({ at: m.index, path: `${dir.dir}${m[1]}` });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) { add(h.path); if (out.length >= 12) break; }
  // Pages from the page library ("已保存到 pages/weekly-sales.html").
  for (const m of String(text || '').matchAll(/(?:^|[^\w/.-])(?:workspace\/)?pages\/([a-z0-9-]{1,60})\.html\b/g)) {
    const p = `pages/${m[1]}.html`;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, page: m[1], name: m[1], size: '' });
    if (out.length >= 8) break;
  }
  return out;
}

/** The page library of the machine this window shows. */
async function loadPages() {
  const data = await api('/api/pages');
  state.pages = data.pages || [];
  renderPages();
  // The other machines' pages, listed here too (1.5.10); they stay where they were made.
  api('/api/peers/pages').then((r) => { state.peerPages = r.machines || []; renderPages(); }).catch(() => {});
  return state.pages;
}

function renderPages() {
  const box = $('pages-list');
  if (!box) return;
  box.innerHTML = '';
  const list = state.pages || [];
  if (!list.length) box.appendChild(el('div', 'row-note', '这台机器上还没有页面。让机器人「把结果做成一个页面」试试。'));
  for (const p of list) {
    const row = el('div', 'vault-row');
    const head = el('div', 'vault-head');
    const title = el('div', 'vault-title');
    title.appendChild(el('b', '', p.title));
    title.appendChild(el('small', '', [p.botName, fmtWhen(p.updatedAt), fmtBytes(p.size)].filter(Boolean).join(' · ')));
    head.appendChild(title);
    const open = el('button', 'btn tiny', '打开');
    open.type = 'button';
    open.addEventListener('click', () => openPageViewer(p.name, p.title));
    const dl = el('a', 'btn tiny', '下载');
    dl.href = `/api/pages/${encodeURIComponent(p.name)}?download=1`;
    dl.setAttribute('download', `${p.name}.html`);
    const del = el('button', 'btn tiny danger', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '再点一次删除'; return; }
      try { await api(`/api/pages/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); toast(`已删除「${p.title}」`); loadPages(); } catch (err) { toast(`删除失败：${err.message}`, true); }
    });
    head.appendChild(open);
    head.appendChild(dl);
    head.appendChild(del);
    row.appendChild(head);
    box.appendChild(row);
  }
  for (const m of state.peerPages || []) {
    if (!(m.pages || []).length) continue;
    box.appendChild(el('div', 'pages-machine', `「${m.machine}」上的页面`));
    for (const p of m.pages) {
      const row = el('div', 'vault-row');
      const head = el('div', 'vault-head');
      const title = el('div', 'vault-title');
      title.appendChild(el('b', '', p.title));
      title.appendChild(el('small', '', [p.botName, fmtWhen(p.updatedAt), fmtBytes(p.size)].filter(Boolean).join(' · ')));
      head.appendChild(title);
      const open = el('button', 'btn tiny', '打开');
      open.type = 'button';
      open.addEventListener('click', () => openPageViewer(p.name, p.title, m.machine));
      head.appendChild(open);
      row.appendChild(head);
      box.appendChild(row);
    }
  }
}

/**
 * A page opens inside the app. It is the bot's HTML, so it runs sandboxed
 * (no access to this app or the hub); the hub serves it that way too.
 */
function openPageViewer(name, title, machine = null) {
  let box = $('page-viewer');
  if (!box) {
    box = el('div', 'page-viewer');
    box.id = 'page-viewer';
    box.innerHTML = '<div class="page-viewer-bar"><span class="page-viewer-title"></span><a class="btn tiny" data-dl>下载</a><button class="btn tiny" type="button" data-close>关闭</button></div><iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals" referrerpolicy="no-referrer"></iframe>';
    const close = () => { box.classList.remove('show'); box.querySelector('iframe').src = 'about:blank'; };
    box.querySelector('[data-close]').addEventListener('click', close);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && box.classList.contains('show')) close(); });
    document.body.appendChild(box);
  }
  const shown = title || (state.pages || []).find((p) => p.name === name)?.title || name;
  box.querySelector('.page-viewer-title').textContent = machine ? `${shown} · 「${machine}」` : shown;
  const dl = box.querySelector('[data-dl]');
  const src = machine ? remoteFileUrl(machine, `pages/${name}.html`) : `/api/pages/${encodeURIComponent(name)}`;
  dl.href = machine ? src : `${src}?download=1`;
  dl.hidden = Boolean(machine);
  dl.setAttribute('download', `${name}.html`);
  box.querySelector('iframe').src = src;
  box.classList.add('show');
}

/** Text (markdown when it looks like it) plus the images it points at. */
/** botId: whose words these are (its voice reads them aloud); the open chat's bot when not given. */
function fillBubble(bubble, raw, system = false, botId = '', fold = 'long') {
  let text = system ? raw : localBoardAsk(humanizeIds(withoutFetchedNote(raw)));
  if (!system && looksMarkdown(text)) {
    bubble.classList.add('md');
    bubble.innerHTML = mdToHtml(text);
  } else if (system || !/https?:\/\//i.test(text)) bubble.textContent = text;
  else { bubble.textContent = ''; appendLinkified(bubble, text); } // its addresses as links (1.5.41)
  if (system) return;
  foldBubble(bubble, text, fold);
  decorateMentions(bubble);
  const images = fetchedHere(raw, mentionedImages(text));
  if (images.length) {
    const list = el('div', 'att-list');
    for (const f of images) list.appendChild(attachmentNode(f));
    bubble.appendChild(list);
  }
  if (voice.status?.tts?.available && String(text || '').trim()) bubble.appendChild(speakButton(text, botId || state.botId));
}

/** Full-size image viewer inside the app; Esc or a click closes it. */
function openLightbox(url, name) {
  let box = $('lightbox');
  if (!box) {
    box = el('div', 'lightbox');
    box.id = 'lightbox';
    box.innerHTML = '<img alt=""><div class="lightbox-bar"><span class="lightbox-name"></span><a class="btn tiny" download>下载</a><button class="btn tiny" type="button" data-open hidden>用系统程序打开</button><button class="btn tiny" type="button" data-reveal hidden>在文件夹中显示</button></div>';
    box.querySelector('[data-open]').addEventListener('click', () => openLocalFile(box.dataset.path, false));
    box.querySelector('[data-reveal]').addEventListener('click', () => openLocalFile(box.dataset.path, true));
    box.addEventListener('click', (event) => { if (!event.target.closest('.lightbox-bar')) box.classList.remove('show'); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') box.classList.remove('show'); });
    document.body.appendChild(box);
  }
  box.querySelector('img').src = url;
  box.querySelector('img').alt = name;
  // On this computer, the desktop app can open it or show it in its folder.
  const rel = /[?&]path=([^&]+)/.exec(url) && url.startsWith('/api/workspace/file') ? decodeURIComponent(/[?&]path=([^&]+)/.exec(url)[1]) : '';
  box.dataset.path = rel;
  const can = Boolean(rel && canOpenLocally());
  box.querySelector('[data-open]').hidden = !can;
  box.querySelector('[data-reveal]').hidden = !can;
  box.querySelector('.lightbox-name').textContent = name;
  const dl = box.querySelector('a');
  dl.href = url;
  dl.setAttribute('download', name);
  box.classList.add('show');
}

/* A pre block that collapses long tool output behind one "展开". */
function longBlock(label, text, { clampAt = 600, labelIsRaw = false } = {}) {
  const wrap = el('div', 'block');
  if (label && !labelIsRaw) wrap.appendChild(el('div', 'block-label', label));
  const pre = el('pre', 'block-pre', text);
  wrap.appendChild(pre);

  const long = String(text).length > clampAt || String(text).split('\n').length > 16;
  if (long) {
    wrap.classList.add('clamped');
    const btn = el('button', 'btn tiny block-expand', '展开');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      wrap.classList.remove('clamped');
      btn.remove();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

/* Plain-language naming for tool calls. The transcript is read by a person,
   not by the model: no `routine_create · 已拒绝` blocks. Unknown names fall
   back to the raw id so a newly added tool is never invisible. */
const TOOL_TEXT = {
  vault_list: { label: '查看保险箱', title: '想看看保险箱里有哪些登录信息', impact: '只看名字，看不到密码。' },
  request_login: { label: '请你登录', title: '需要你填写登录信息', impact: '密码只进保险箱，不进聊天。' },
  browser_fill_secret: { label: '填入登录信息', title: '想把保险箱里的登录信息填进网页', impact: '机器人看不到密码本身。' },
  request_takeover: { label: '请你接管屏幕', title: '需要你接管屏幕', impact: '你来操作这一步。' },
  image_view: { label: '看图片', title: '想看一张图片', impact: '只读取，不改动。' },
  cli_agent_run: { label: '交给编程助手', title: '想把写代码的活交给 Claude Code / Codex / Cursor / Qoder', impact: '用你的订阅额度，在工作区的一个文件夹里写文件；勾了「运行命令」时还会运行命令。' },
  briefing_collect: { label: '汇总近况', title: '想汇总各台机器的近况', impact: '只读取，不改动。' },
  page_save: { label: '做页面', title: '想把结果做成一个页面', impact: '页面存进工作区的页面库。' },
  file_send: { label: '发文件到另一台机器', title: '想把一个文件发到另一台机器', impact: '那台机器的工作区里会多一个文件。' },
  file_fetch: { label: '从另一台机器取文件', title: '想从另一台机器取回一个文件', impact: '这台机器的工作区里会多一个文件。' },
  group_list: { label: '查看群', title: '想看看有哪些群', impact: '只读取名单。' },
  group_update: { label: '修改群', title: '想修改一个群', impact: '群的名字或成员会变。' },
  group_delete: { label: '删除群', title: '想删除一个群', impact: '群和它的聊天记录会被删掉。' },
  settings_get: { label: '查看设置', title: '想看看这台机器的设置', impact: '只读取，不改动。' },
  settings_update: { label: '修改设置', title: '想修改这台机器的设置', impact: '设置会改变，之后的对话按新设置来。' },
  ui_get: { label: '查看界面状态', title: '想看看界面现在的状态', impact: '只读取，不改动。' },
  ui_set: { label: '调整界面', title: '想调整界面', impact: '界面显示会变。' },
  image_generate: { label: '生成图片', title: '想生成图片', impact: '会调用生图服务，按张计费（通常几分钱）；图片存进工作区。' },
  video_generate: { label: '生成视频', title: '想生成一段视频', impact: '会调用生视频服务，按条计费，比图片贵；要等几分钟。' },
  shell: { label: '执行命令', title: '想在这台电脑上运行一条命令', impact: '命令会以你当前的用户身份运行，可能出现你没预料到的改动。' },
  phone: { label: '操作手机', title: '想在你的手机上做一步', impact: '会在手机上点、滑或输入；付款、发送、发布、删除每次都会先问你。手机锁着时不会去解锁。' },
  desktop_ui: { label: '操作桌面程序', title: '想在后台操作一个桌面程序', impact: '会在那个窗口里按按钮或填文字，不动你的鼠标。' },
  fs_write: { label: '写入文件', title: '想写入一个文件', impact: '如果同名文件已经存在，里面的内容会被覆盖。' },
  machine_switch: { label: '交给另一台机器', title: '想把一件事交给另一台机器', impact: '窗口不动，那台上的助手接着做。' },
  machine_note: { label: '记下机器适合干什么', title: '想记下一台机器适合干什么', impact: '主助理以后按这一句挑机器。' },
  x_post: { label: '在 X 上发帖', title: '想在 X 上发一条帖子', impact: '先给你看草稿，你点「发到 X」才发。' },
  post_draft: { label: '给你看草稿', title: '想先给你看要发出去的草稿', impact: '你同意后，它照你定的稿去发。' },
  follow_up: { label: '约好回头看', title: '想约个时间回头看一眼', impact: '到时候它自己回来看，有新情况才告诉你。' },
  watch_folder: { label: '盯着一个文件夹', title: '想盯着一个文件夹', impact: '里面出现新文件时，它会自己来处理。' },
  bot_adjust: { label: '改助手', title: '想改一个助手', impact: '同意后马上生效，可以撤销。' },
  machine_list: { label: '查看机器', title: '想看看有哪些机器', impact: '只读取名单。' },
  fs_delete: { label: '删除文件', title: '想删除一个文件或文件夹', impact: '删掉之后，Lamplit 里没有撤销按钮。' },
  fs_mkdir: { label: '新建文件夹', title: '想新建一个文件夹', impact: '只会在工作区里加一个目录，不改动已有文件。' },
  fs_read: { label: '读取文件', title: '想读取一个文件', impact: '只会读取内容，不会改动它。' },
  fs_list: { label: '查看目录', title: '想看看目录里有什么', impact: '只会读取文件名，不会改动任何东西。' },
  routine_create: { label: '创建定时任务', title: '想创建一个会自己重复跑的任务', impact: '创建后会按计划一直自动运行，直到你把它停掉。' },
  routine_run: { label: '运行定时任务', title: '想立刻运行一个定时任务', impact: '它会马上在后台跑一轮，结果记进历史。' },
  routine_list: { label: '查看定时任务', title: '想看看有哪些定时任务', impact: '只读取列表，不会改动。' },
  memory_write: { label: '记住一件事', title: '想记住一条信息', impact: '会写进长期记忆，以后的对话都会带上它。' },
  memory_read: { label: '读取记忆', title: '想看看记住了什么', impact: '只读取，不会改动。' },
  http_fetch: { label: '访问网址', title: '想访问一个网址', impact: '会向这个地址发出请求，对方能看到请求来源。' },
  browser_open: { label: '打开网页', title: '想打开一个网页', impact: '只是打开，不会提交任何表单。' },
  browser_click: { label: '点击网页', title: '想点击网页上的一个位置', impact: '可能触发页面上的操作，例如提交或下载。' },
  browser_type: { label: '填写网页', title: '想在网页里输入文字', impact: '会填进当前页面获得焦点的输入框。' },
  browser_press: { label: '在网页上按键', title: '想在网页上按一个键', impact: '按回车可能会提交表单或选中一个选项。' },
  browser_steps: { label: '在网页上连着做几步', title: '想在网页上连着做几步', impact: '点击、输入、按键一个接一个做，可能触发页面上的操作，例如提交。' },
  budget_extend: { label: '超出今天的预算', title: '今天花到了每日预算，想接着做', impact: '同意后这个助手今天再放行一份预算；不同意它就停在这里。' },
  phone_allow: { label: '申请手机操作不用问', title: '想在手机上的这个 App 里自己发送、发布', impact: '你同意后，这个机器人在这个 App 上做这类操作不再问你；付款仍然每次问。' },
  browser_upload: { label: '往网页上传文件', title: '想把工作区里的文件传到网页上', impact: '文件会交给当前网页，比如发笔记的配图。' },
  browser_eval: { label: '运行网页脚本', title: '想在网页里运行一段脚本', impact: '脚本能读取或改动当前页面的内容。' },
  browser_download: { label: '下载文件', title: '想下载一个文件', impact: '文件会保存到这台电脑上。' },
  browser_screenshot: { label: '网页截图', title: '想给网页截一张图', impact: '只读取当前页面，不会改动。' },
  browser_snapshot: { label: '读取网页', title: '想读取网页上的内容', impact: '只读取页面结构，不会改动。' },
  browser_status: { label: '查看浏览器', title: '想看看浏览器是否打开着', impact: '只读取状态。' },
  browser_close: { label: '关闭浏览器', title: '想关上浏览器', impact: '会关闭当前打开的浏览器窗口。' },
  bot_message: { label: '转交给同事', title: '想把任务交给另一位助手', impact: '对方会用自己的工具和记忆独立完成，再回来汇报。' },
  bot_pass: { label: '交给下一位同事', title: '想把下一步交给另一位助手', impact: '对方接着做，这一位不等回复就结束。' },
  routine_update: { label: '改定时任务', title: '想修改一条定时任务', impact: '改的是别的机器人名下的任务，所以先问你。' },
  routine_delete: { label: '删定时任务', title: '想删除一条定时任务', impact: '删的是别的机器人名下的任务，所以先问你；删了就不会再跑。' },
  task_move: { label: '把任务搬到另一台机器', title: '想把这件事换到另一台机器上接着做', impact: '任务清单、进度和相关文件会传到那台机器；网站登录不会跟过去。' },
  group_handover: { label: '交给群里做', title: '想把整件事交给一个群', impact: '群里的协调者接手安排，结果发在群里。' },
  tell_human: { label: '请你拍板', title: '有件事需要你决定', impact: '在对话、手机和飞书里告诉你。' },
  tool_request: { label: '申请工具', title: '想申请加上一些工具', impact: '同意后这个机器人一直能用这些工具，可以在机器人设置里关掉；有风险的操作照样会先问你。' },
  bot_create: { label: '新建助手', title: '想新建一个助手', impact: '列表里会多一个成员，拥有你授予的工具。' },
  bot_update: { label: '修改助手', title: '想改一个助手的设置', impact: '会改名字、职责或它可用的工具。' },
  bot_delete: { label: '删除助手', title: '想删除一个助手', impact: '它的对话记录和群里的位置会一起消失，无法恢复。' },
  bot_list: { label: '查看助手', title: '想看看有哪些助手', impact: '只读取名单。' },
  group_create: { label: '新建群组', title: '想新建一个群组', impact: '会把几位助手拉进同一个对话。' },
  group_post: { label: '在群里发言', title: '想在群里发一条消息', impact: '群里所有成员都会看到。' },
  skill_save: { label: '保存技能', title: '想把这套做法保存成技能', impact: '会写进共享技能库，之后可以重复使用。' },
  skill_list: { label: '查看技能', title: '想看看有哪些技能', impact: '只读取列表。' },
  skill_read: { label: '读取技能', title: '想读一个技能的步骤', impact: '只读取内容。' },
  task_finish: { label: '结束任务', title: '想结束这一轮', impact: '它会停下来，把结果交给你。' },
  mcp_find_tools: { label: '找应用里的工具', title: '想在连接的应用里找合适的工具', impact: '只是查找，不做任何改动。' },
  mcp_call: { label: '用连接的应用', title: '想用连接应用里的一个工具', impact: '和直接调用那个工具一样，该问你的照样会问。' },
};

/** A connected app's tool (mcp__<server>__<tool>) as people read it (1.5.67): 「Notion · 更新页面」 (its title, or its name made readable), not mcp__m2c4a5__notion-update-page. */
function mcpToolHuman(name) {
  const m = String(name || '').match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/); if (!m) return null;
  let servers = []; try { servers = mcpUi.servers || []; } catch { /* before the settings code ran */ }
  const server = servers.find((x) => x.id === m[1]), app = server?.name || '连接的应用', what = String((server?.tools || []).find((t) => t.name === m[2])?.title || '').trim() || m[2].replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { app, what, label: `${app} · ${what}` };
}
function mcpToolText(name) {
  const h = mcpToolHuman(name); return h ? { label: `「${h.label}」`, title: `想用「${h.app}」：${h.what}`, impact: '连接应用里的工具；在「设置 → 连接应用」里设成「始终允许」后就不再问你。' } : null;
}

function toolNameLabel(name) {
  return (TOOL_TEXT[name] && TOOL_TEXT[name].label) || mcpToolText(name)?.label || INTERNAL_TOOL_WORDS[name] || (/^[a-z]+(_[a-z]+)+$/.test(name || '') ? '处理' : name) || '操作';
}

function safeArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const parsed = safeParse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return typeof raw === 'object' ? raw : {};
}

function humanSchedule(schedule) {
  const s = String(schedule || '').trim();
  if (!s) return '';
  const every = /^every\s+(\d+)\s*(minutes?|hours?|seconds?|days?)$/i.exec(s);
  if (every) {
    const unit = /^m/i.test(every[2]) ? '分钟' : /^h/i.test(every[2]) ? '小时' : /^s/i.test(every[2]) ? '秒' : '天';
    return `每 ${Number(every[1])} ${unit}`;
  }
  const parts = s.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    const hhmm = /^\d+$/.test(min) && /^\d+$/.test(hour)
      ? `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}` : '';
    if (hhmm && dom === '*' && mon === '*') {
      if (dow === '*') return `每天 ${hhmm}`;
      if (dow === '1-5') return `工作日 ${hhmm}`;
      const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      if (/^\d$/.test(dow)) return `每${names[Number(dow)]} ${hhmm}`;
    }
    if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      return `每 ${min.slice(2)} 分钟`;
    }
    return `按计划运行（${s}）`;
  }
  return s;
}

function describeTool(name, rawArgs) {
  const args = safeArgs(rawArgs);
  const base = TOOL_TEXT[name] || mcpToolText(name) || { label: name || '操作', title: `想使用「${name || '工具'}」`, impact: '' };
  const out = { label: base.label, title: base.title, impact: base.impact, detail: '', facts: [] };
  const set = (key, label, value) => {
    if (value === undefined || value === null || value === '') return;
    out.facts.push([label, String(value)]);
  };

  switch (name) {
    case 'shell':
      // What it does in plain words leads; the code is one click away (1.5.54, walkthrough 2.2).
      if (args.purpose) {
        out.title = String(args.purpose).trim().slice(0, 120);
        out.command = String(args.command || '').trim();
        out.impact = ''; // the why-line says what happens; 「可能出现你没预料到的改动」 under a plain headline only scared (1.5.54)
        break;
      }
      out.detail = String(args.command || '').trim();
      set('命令', '命令', out.detail);
      break;
    case 'fs_write': {
      const bytes = typeof args.content === 'string' ? args.content.length : 0;
      out.detail = args.path || '';
      if (args.mode === 'append') out.impact = '内容会追加到文件末尾，不会覆盖原有内容。';
      set('文件', '文件', args.path);
      if (bytes) set('大小', '写入大小', `${bytes} 个字符`);
      break;
    }
    case 'fs_delete':
      out.detail = args.path || '';
      set('文件', '文件', args.path);
      if (args.recursive) out.impact = '会连同文件夹里的所有东西一起删除，删掉之后没有撤销。';
      break;
    case 'fs_mkdir':
    case 'fs_read':
    case 'fs_list':
      out.detail = args.path || '';
      set('位置', '位置', args.path);
      break;
    case 'http_fetch':
      out.detail = args.url || '';
      set('地址', '网址', args.url);
      set('方法', '方式', (args.method || 'GET').toUpperCase());
      break;
    case 'browser_open':
    case 'browser_download':
      out.detail = args.url || '';
      set('地址', '网址', args.url);
      break;
    case 'browser_click':
      out.detail = args.selector || args.ref || args.text || '';
      set('目标', '目标', out.detail);
      break;
    case 'browser_type':
      out.detail = args.text ? `输入「${truncate(args.text, 60)}」` : '';
      set('内容', '输入内容', args.text ? truncate(args.text, 160) : '');
      break;
    case 'browser_press':
      out.detail = args.keys ? `按「${truncate(args.keys, 40)}」` : '';
      set('按键', '按键', args.keys || '');
      break;
    case 'browser_eval':
      out.detail = args.script || args.code || '';
      break;
    case 'routine_create': {
      const when = humanSchedule(args.schedule);
      out.detail = when;
      out.title = '想创建一个会自己重复跑的任务';
      set('做什么', '每次做什么', truncate(args.instruction || '', 160));
      if (args.name) set('名字', '任务名', args.name);
      break;
    }
    case 'routine_run':
      out.detail = args.id || '';
      set('任务', '任务编号', args.id);
      break;
    case 'memory_write':
      out.detail = truncate(args.text || '', 72);
      set('记住', '要记住的内容', truncate(args.text || '', 240));
      out.impact = args.scope === 'shared'
        ? '会写进所有助手共用的记忆。'
        : '只会写进这位助手自己的记忆，以后的对话都会带上它。';
      break;
    case 'bot_message': {
      const target = chatBotById(args.botId);
      out.detail = target ? target.name : (args.botId || '');
      out.title = `想把任务交给${target ? `「${target.name}」` : '另一位助手'}`;
      set('交给', '交给', target ? target.name : args.botId);
      set('任务', '要它做什么', truncate(args.text || '', 200));
      break;
    }
    case 'bot_create':
    case 'bot_update':
    case 'bot_delete':
      out.detail = args.name || args.id || '';
      set('助手', '助手', args.name || args.id);
      if (Array.isArray(args.tools) && args.tools.length) {
        set('工具', '可用的工具', args.tools.map(toolNameLabel).join('、'));
      }
      break;
    case 'group_create':
      out.detail = args.name || '';
      set('群名', '群名', args.name);
      if (Array.isArray(args.members)) set('成员', '成员', `${args.members.length} 位`);
      break;
    case 'group_post':
      out.detail = truncate(args.text || '', 72);
      set('内容', '要发的内容', truncate(args.text || '', 200));
      break;
    case 'phone': if (args.action === 'save_to_album') albumStepText(out, args, set); break; // files into the album (1.5.65), 07b-cards.js
    case 'skill_save':
      out.detail = args.name || '';
      set('技能', '技能名', args.name);
      break;
    default:
      break;
  }
  return out;
}

/** A bot handing its screen to the human: what to do, and two buttons. */
function takeoverCard(item) {
  const args = safeArgs(item.args) || {};
  const card = el('div', 'takeover-card');
  card.appendChild(el('div', 'takeover-title', '需要你接管屏幕'));
  card.appendChild(el('div', 'takeover-reason', String(args.reason || '完成这一步')));
  const row = el('div', 'btn-row');
  const go = el('button', 'btn primary', '接管屏幕');
  go.type = 'button';
  go.addEventListener('click', () => popupTakeover());
  const done = el('button', 'btn', '我弄好了，继续');
  done.type = 'button';
  done.addEventListener('click', async () => {
    if (desktopTakeover()) closeDesktopViewer();
    const input = $('composer');
    input.value = '我弄好了，继续';
    await send();
  });
  row.appendChild(go);
  row.appendChild(done);
  card.appendChild(row);
  card.appendChild(el('div', 'row-note', state.policy?.takeover === 'view'
    ? '这台机器的接管设成了「只能看」：要操作的话，先在 设置 → 审批 里改成「能看能控」。'
    : '密码、验证码只在屏幕上输入，不要发在聊天里。'));
  return card;
}

/**
 * Copy and paste between this computer and the remote desktop. noVNC only
 * offers a hidden side panel for it; here text copied over there lands in
 * this clipboard, and Ctrl/Cmd+V in the viewer pastes this clipboard there.
 */
function openClipDrawer() {
  const remote = document.querySelector('#pc-vnc-wrap iframe')?.contentDocument?.getElementById('noVNC_clipboard_text');
  if (remote?.value) $('clip-text').value = remote.value;
  if ($('clip-mine')) $('clip-mine').hidden = typeof window.desk?.clipboardRead !== 'function' && !(navigator.clipboard?.readText && window.isSecureContext);
  $('clip-scrim').classList.add('show');
  $('clip-drawer').hidden = false;
  setTimeout(() => $('clip-text').focus(), 60);
}

function closeClipDrawer() {
  $('clip-scrim').classList.remove('show');
  $('clip-drawer').hidden = true;
}

function bridgeClipboard(frame) {
  const win = frame.contentWindow;
  if (!win || win.__nsClipboard) return;
  win.__nsClipboard = true;
  const tick = setInterval(() => {
    if (!frame.isConnected) { clearInterval(tick); return; }
    const rfb = win.UI && win.UI.rfb;
    if (!rfb || rfb.__nsBridged) return; // noVNC makes a new one on reconnect
    rfb.__nsBridged = true;
    rfb.addEventListener('clipboard', async (event) => {
      const got = event.detail && event.detail.text;
      if (!got) return;
      const text = await pullRemoteClip(got);
      // The drawer shows it too, for when this device's clipboard is out of reach.
      const box = document.getElementById('clip-text');
      if (box) box.value = text;
      phoneClipWrite(text);
    });
  }, 1000);
  win.document.addEventListener('keydown', async (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'v') return;
    const rfb = win.UI && win.UI.rfb;
    if (!rfb || rfb.viewOnly) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const mine = await phoneClipRead();
    const text = mine || document.getElementById('clip-text')?.value || '';
    const res = text ? await pushRemoteClip(rfb, text, { paste: true }) : null;
    if (res?.typed) return;
    // Ctrl is already down over there; send the V once the clipboard arrived.
    setTimeout(() => { rfb.sendKey(0x76, 'KeyV', true); rfb.sendKey(0x76, 'KeyV', false); }, 80);
  }, true);
}

/** Tool calls that put something in front of the human to act on. */
function isActionCard(name, item = null) {
  if (name === 'bot_message') return peerHandoffDone(item);
  return name === 'request_takeover' || name === 'request_login' || name === 'bot_adjust';
}

/** A hand-off to another machine that came back (its card shows in the chat). */
function peerHandoffDone(item) {
  return Boolean(item && item.name === 'bot_message' && !item.pending && item.ok && item.output?.machine);
}

function toolChip(item) {
  // A change made to a bot by talking (1.5.45): what changed, and 「撤销」.
  if (item.name === 'bot_adjust' && !item.pending && item.ok && item.output?.changed) return adjustDoneCard(item);
  if (item.name === 'bot_message' && !item.pending && item.ok && item.output?.machine) return handoffDoneCard(item);
  if (item.name === 'request_takeover' && !item.pending) return takeoverCard(item);
  if (item.name === 'request_login' && !item.pending) return loginCard(item);
  const info = describeTool(item.name, item.args);
  if (item.name === 'phone' && item.ok && !item.pending && Array.isArray(item.output?.saved)) info.detail = albumReceiptText(item.output); // what reached the phone (1.5.65)
  const details = el('details', 'chip');
  const summary = el('summary');

  // 「没有要改的」 is not a failure (1.5.58 beginner test: it showed red 「没成功」).
  const nothing = !item.pending && !item.ok && item.output?.error?.code === 'ADJUST_NOTHING';
  const state = item.pending ? 'pending' : item.ok || nothing ? 'ok' : 'fail';
  const icon = item.pending ? '⋯' : nothing ? '–' : item.ok ? '✓' : '✕';
  summary.appendChild(el('span', `chip-icon ${state}`, icon));

  const text = el('span', 'chip-text');
  text.appendChild(el('span', 'chip-name', info.label));
  if (info.detail) text.appendChild(el('span', 'chip-detail', truncate(info.detail, 64)));
  summary.appendChild(text);

  if (item.pending) summary.appendChild(el('span', 'chip-state', '进行中'));
  else if (item.denied) summary.appendChild(el('span', 'chip-state bad', '已拒绝'));
  else if (item.needsApproval) summary.appendChild(el('span', 'chip-state warn', '等你确认'));
  else if (item.ok) summary.appendChild(el('span', 'chip-state', '完成'));
  else if (nothing) summary.appendChild(el('span', 'chip-state', '没有要改的'));
  else summary.appendChild(el('span', 'chip-state bad', '没成功'));

  const args = safeArgs(item.args);
  const hasOutput = item.output !== undefined && item.output !== null && item.output !== '';
  const hasBody = Boolean(item.reason || info.facts.length || hasOutput);
  if (hasBody) {
    const more = el('span', 'chip-more');
    more.appendChild(el('span', 'when-closed', '详情'));
    more.appendChild(el('span', 'when-open', '收起'));
    summary.appendChild(more);
  }
  details.appendChild(summary);
  if (!hasBody) return details;

  const body = el('div', 'body');
  if (info.impact) body.appendChild(el('div', 'chip-impact', info.impact));
  if (item.reason) body.appendChild(el('div', 'muted tiny', reasonLabel(item.reason)));
  for (const [label, value] of info.facts) {
    const line = el('div', 'chip-fact');
    line.appendChild(el('span', 'chip-fact-k', label));
    line.appendChild(el('span', 'chip-fact-v', value));
    body.appendChild(line);
  }

  const raw = {};
  if (Object.keys(args).length) raw['参数'] = args;
  if (hasOutput) raw['结果'] = item.output;
  if (Object.keys(raw).length) {
    const tech = el('details', 'tech');
    tech.appendChild(el('summary', null, '技术细节'));
    tech.appendChild(el('pre', 'tech-pre', JSON.stringify(raw, null, 2)));
    body.appendChild(tech);
  }
  details.appendChild(body);
  return details;
}

