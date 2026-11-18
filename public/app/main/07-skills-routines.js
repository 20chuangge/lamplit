'use strict';
// Lamplit page, part 7 of 12: skills, routines, memory, avatar customizer. Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   skills
   --------------------------------------------------------------------- */
async function loadSkills() {
  try {
    state.skills = await api('/api/skills');
  } catch (err) {
    if (err.status !== 401) toast(`技能加载失败：${err.message}`, true);
    return;
  }
  renderSkills();
}

function renderSkills() {
  const list = $('skills-list');
  list.innerHTML = '';
  $('skills-count').textContent = String(state.skills.length);
  const bot = state.bots.find((b) => b.id === state.botId);
  const granted = new Set((bot && bot.skills) || []);

  for (const skill of state.skills) {
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', null, skill.name));
    if (granted.has(skill.slug)) title.appendChild(el('span', 'tag good', '已授权'));
    card.appendChild(title);
    card.appendChild(el('div', 'card-sub', skill.description || '（没有描述）'));

    const when = el('div', 'tiny muted', `适用场景：${skill.when_to_use || '未说明'}`);
    when.style.marginTop = '6px';
    card.appendChild(when);

    if (skill.steps && skill.steps.length) {
      const details = el('details');
      details.style.marginTop = '6px';
      details.appendChild(el('summary', 'tiny muted', `${skill.steps.length} 个步骤`));
      const ol = el('ol', 'skill-steps');
      for (const step of skill.steps) ol.appendChild(el('li', null, step));
      details.appendChild(ol);
      if (skill.approval_notes) details.appendChild(el('div', 'skill-body', `审批说明：${skill.approval_notes}`));
      card.appendChild(details);
    }
    card.appendChild(el('div', 'card-sub mono', skill.file));
    list.appendChild(card);
  }
  if (!state.skills.length) list.appendChild(el('div', 'muted tiny', '还没有技能。'));
}

/* ---------------------------------------------------------------------
   routines
   --------------------------------------------------------------------- */
async function loadRoutines() {
  try {
    state.routines = await api('/api/routines');
  } catch (err) {
    if (err.status !== 401) toast(`定时任务加载失败：${err.message}`, true);
    return;
  }
  renderRoutines();
  loadBriefing().catch(() => { /* older server: no briefing */ });
}

/** The daily briefing card: one switch, a time, Feishu or not. */
async function loadBriefing() {
  const b = await api('/api/briefing');
  state.briefing = b;
  $('brief-on').checked = Boolean(b.enabled);
  $('brief-time').value = b.time || '08:30';
  $('brief-feishu').checked = Boolean(b.feishu);
  const last = b.lastRun ? `上次 ${fmtWhen(b.lastRun)}（${runStatusLabel(b.lastStatus)}）` : '';
  const next = b.enabled && b.nextRun ? `下次 ${fmtWhen(b.nextRun)}` : '';
  $('brief-note').textContent = [next, last].filter(Boolean).join(' · ') || '助理会汇总过去 24 小时所有机器上的情况：要你处理的事、每个机器人做完了什么、新做的页面。';
}

async function saveBriefing(extra = {}) {
  const b = await api('/api/briefing', { method: 'PUT', body: { enabled: $('brief-on').checked, time: $('brief-time').value || '08:30', feishu: $('brief-feishu').checked, ...extra } });
  state.briefing = b;
  await loadRoutines();
  return b;
}

function renderRoutineBotOptions() {
  const select = $('rt-bot');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  for (const bot of state.bots) {
    const opt = el('option', null, bot.name);
    opt.value = bot.id;
    select.appendChild(opt);
  }
  const values = Array.from(select.options).map((o) => o.value);
  if (current && values.includes(current)) select.value = current;
  else if (state.botId && values.includes(state.botId)) select.value = state.botId;
}

/**
 * The routines of the chat on screen (a group: its members'), or every one on
 * the machine with 全部 (11-15: every bot seemed to have the same six).
 */
function routinesInView() {
  const all = state.routines || [];
  if ($('rt-scope')?.checked) return all;
  const ids = isGroupMode() ? groupMembers(groupById(state.groupId)).map((b) => b.id) : [state.botId];
  return all.filter((rt) => ids.includes(rt.botId));
}

function renderRoutines() {
  const list = $('routines-list');
  list.innerHTML = '';
  renderRoutineBotOptions();

  for (const rt of routinesInView()) {
    const bot = state.bots.find((b) => b.id === rt.botId);
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', null, rt.name));
    if (!rt.enabled) title.appendChild(el('span', 'tag', '已暂停'));
    card.appendChild(title);
    // A routine whose bot was deleted (1.5.33): said so, not an id; it can be given to the main assistant or deleted.
    const orphan = !bot && !String(rt.botId || '').includes('@');
    card.appendChild(el('div', 'card-sub', `${bot ? bot.name : orphan ? '助手已删除' : rt.botId} · ${scheduleText(rt.schedule)}`));

    const meta = el('div', 'routine-meta');
    meta.appendChild(el('span', 'tag', `下次 ${fmtWhen(rt.nextRun)}`));
    if (rt.lastStatus) {
      const cls = rt.lastStatus === 'success' ? 'good' : rt.lastStatus === 'needs_approval' ? 'warn' : 'bad';
      meta.appendChild(el('span', `tag ${cls}`, `上次 ${runStatusLabel(rt.lastStatus)}`));
    }
    if (rt.preset === 'briefing') meta.appendChild(el('span', 'tag', '每日简报'));
    if (rt.onlyChanges) meta.appendChild(el('span', 'tag', '有变化才提醒'));
    if (rt.pushFeishu) meta.appendChild(el('span', 'tag', '发到飞书'));
    if (rt.timezone) meta.appendChild(el('span', 'tag', rt.timezone));
    card.appendChild(meta);

    if (rt.runs && rt.runs.length) {
      const details = el('details');
      details.style.marginTop = '7px';
      details.appendChild(el('summary', 'tiny muted', `${rt.runs.length} 次运行`));
      for (const run of [...rt.runs].reverse()) {
        const line = el('div', 'tiny muted');
        line.style.marginTop = '4px';
        line.textContent = run.quiet ? `${fmtClock(run.startedAt)} · 没有变化（没打扰你）` : `${fmtClock(run.startedAt)} · ${runStatusLabel(run.status)}${run.summary ? ` · ${truncate(run.summary, 60)}` : ''}`;
        details.appendChild(line);
      }
      card.appendChild(details);
    }

    const actions = el('div', 'approval-actions');
    const test = el('button', 'btn tiny', '立即运行');
    test.type = 'button';
    test.addEventListener('click', async () => {
      test.disabled = true;
      test.textContent = '运行中…';
      try {
        const res = await api(`/api/routines/${encodeURIComponent(rt.id)}/test`, { method: 'POST', body: {} });
        toast(`试运行：${runStatusLabel(res.run.status)}`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        await loadRoutines();
      }
    });
    const toggle = el('button', 'btn tiny', rt.enabled ? '暂停' : '启用');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      try {
        await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { enabled: !rt.enabled } });
        await loadRoutines();
      } catch (err) {
        toast(err.message, true);
      }
    });
    const del = el('button', 'btn tiny danger', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      // Asked first (1.5.33): one click deleted it.
      if (!(await askConfirm({ title: `删除定时任务「${rt.name}」？`, text: '删了就不会再跑；它以前的运行记录也一起删掉。', confirmLabel: '删除' }))) return;
      try {
        await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'DELETE' });
        await loadRoutines();
      } catch (err) {
        toast(err.message, true);
      }
    });
    // Its time can be changed here (1.5.33: there was no way to).
    const when = el('button', 'btn tiny', '改时间');
    when.type = 'button';
    when.addEventListener('click', async () => {
      const next = await askText({ title: `「${rt.name}」什么时候跑`, text: '可以写：每天 9:00、工作日 8:30、每周五 18:00、每月 1 号 10:00、每 30 分钟。', value: scheduleText(rt.schedule), confirmLabel: '保存' });
      if (next === null || next === undefined || !String(next).trim() || String(next).trim() === scheduleText(rt.schedule)) return;
      try {
        await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { schedule: String(next).trim() } });
        await loadRoutines();
        toast('时间改好了');
      } catch (err) {
        toast(err.message, true);
      }
    });
    const adopt = orphan ? el('button', 'btn tiny', '交给主助理') : null;
    if (adopt) {
      adopt.type = 'button';
      adopt.addEventListener('click', async () => {
        const primary = (state.bots || []).find((b) => b.primary);
        if (!primary) return;
        try {
          await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { botId: primary.id } });
          await loadRoutines();
          toast(`交给「${primary.name}」了；要它接着跑，点「启用」。`);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
    if (orphan) {
      if (adopt) actions.appendChild(adopt);
      actions.appendChild(del);
    } else {
      actions.appendChild(test);
      actions.appendChild(toggle);
      actions.appendChild(when);
      actions.appendChild(del);
    }
    card.appendChild(actions);
    list.appendChild(card);
  }
  if (!state.routines.length) list.appendChild(el('div', 'muted tiny', '还没有定时任务。'));
  else if (!routinesInView().length) {
    const who = isGroupMode() ? (groupById(state.groupId)?.name || '这个群') : (botById(state.botId)?.name || '它');
    list.appendChild(el('div', 'muted tiny', `${who}名下没有定时任务（这台机器上一共 ${state.routines.length} 条，勾选「全部」查看）。`));
  }
}

async function createRoutine() {
  const instruction = $('rt-instruction').value.trim();
  if (!instruction) { toast('定时任务需要一条指令', true); return; }
  try {
    await api('/api/routines', {
      method: 'POST',
      body: {
        name: $('rt-name').value.trim() || '未命名任务',
        instruction,
        botId: $('rt-bot').value,
        schedule: $('rt-schedule').value.trim() || '每天 9:00',
        onlyChanges: $('rt-only-changes').checked,
        pushFeishu: $('rt-feishu').checked,
      },
    });
    $('rt-name').value = '';
    $('rt-instruction').value = '';
    $('routine-form-card').style.display = 'none';
    await loadRoutines();
    toast('定时任务已创建');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------------------
   memory
   --------------------------------------------------------------------- */
async function loadMemory() {
  if (!state.botId) return;
  try {
    const data = await api(`/api/bots/${state.botId}/memory`);
    $('memory-title').textContent = `记忆 · ${data.entries.length} 条`;
    $('bot-memory-path').textContent = data.memoryFile;
    $('shared-path').textContent = data.sharedFile;
    $('bot-memory-pre').textContent = (data.memory || '').trim() || '（还没有保存内容）';
    $('shared-pre').textContent = (data.shared || '').trim() || '（还没有保存内容）';
  } catch (err) {
    if (err.status === 401) return;
    $('bot-memory-pre').textContent = `读取记忆失败：${err.message}`;
  }
}

/* ---------------------------------------------------------------------
   avatar customizer
   Shape/colour change immediately (optimistic), persist via PATCH, and roll
   back only on a real failure; a 404 means the endpoint is not deployed yet,
   so the change stays as a local preview and a quiet note explains it.
   --------------------------------------------------------------------- */
function currentAvatarBot() {
  return state.bots.find((b) => b.id === state.avatarBotId) || null;
}

function setAvatarNote(text) {
  const node = $('avatar-note');
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
}

function openAvatarCustomizer(botId) {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) return;
  state.avatarBotId = botId;
  closeSettings();
  closeSidebar();
  closePanel();
  $('avatar-sheet').classList.add('open');
  $('avatar-sheet').setAttribute('aria-hidden', 'false');
  $('avatar-scrim').classList.add('show');
  setAvatarNote('');
  renderCustomizer();
  if (!state.bots.some((b) => b && b.avatar)) {
    setAvatarNote('这个版本的服务端还没提供头像接口（404），下面的改动只在当前页面生效。');
  }
}

function closeAvatarCustomizer() {
  state.avatarBotId = null;
  $('avatar-sheet').classList.remove('open');
  $('avatar-sheet').setAttribute('aria-hidden', 'true');
  $('avatar-scrim').classList.remove('show');
}

function renderCustomizerPreview() {
  const bot = currentAvatarBot();
  const host = $('avatar-preview');
  if (!bot || !host) return;
  const a = avatarOf(bot);
  host.className = `av av-s-${a.shape}`;
  host.style.setProperty('--av-color', a.color);
  host.innerHTML = '';
  appendAvatarContent(host, a);
}

function renderCustomizer() {
  const bot = currentAvatarBot();
  if (!bot) return;
  const a = avatarOf(bot);
  $('avatar-title').textContent = `自定义头像 · ${bot.name}`;
  renderCustomizerPreview();

  const grid = $('shape-grid');
  grid.innerHTML = '';
  for (const shape of PICKER_SHAPES) {
    const active = shape.id === a.shape;
    const btn = el('button', `shape-btn${active ? ' active' : ''}`);
    btn.type = 'button';
    btn.dataset.shape = shape.id;
    btn.title = shape.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    btn.setAttribute('aria-label', shape.label);
    const mini = el('span', `av av-s-${shape.id}`);
    mini.style.setProperty('--av-color', a.color);
    mini.appendChild(faceLayer(a.color, shape.id));
    btn.appendChild(mini);
    btn.addEventListener('click', () => chooseShape(shape.id));
    grid.appendChild(btn);
  }

  const colors = $('color-row');
  colors.innerHTML = '';
  for (const color of AVATAR_COLORS) {
    const active = color.toLowerCase() === a.color.toLowerCase();
    const sw = el('button', `swatch${active ? ' active' : ''}`);
    sw.type = 'button';
    sw.style.background = color;
    sw.title = color;
    sw.setAttribute('role', 'radio');
    sw.setAttribute('aria-checked', active ? 'true' : 'false');
    sw.setAttribute('aria-label', `颜色 ${color}`);
    sw.addEventListener('click', () => chooseColor(color));
    colors.appendChild(sw);
  }

  $('avatar-upload-btn').textContent = a.hasImage ? '更换图片' : '上传图片';
  $('avatar-remove-btn').hidden = !a.hasImage;
}

async function persistAvatar(bot, patch) {
  try {
    const res = await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
      method: 'PATCH',
      body: { avatar: patch },
    });
    if (res && res.bot) {
      const index = state.bots.findIndex((b) => b.id === bot.id);
      if (index >= 0) {
        const merged = { ...state.bots[index], ...res.bot };
        merged.avatar = { ...avatarOf(bot), ...(res.bot.avatar || {}) };
        state.bots[index] = merged;
        renderBots();
        if (state.botId === merged.id) renderChatAvatar(merged);
      }
    }
    setAvatarNote('');
    return 'ok';
  } catch (err) {
    if (err.status === 404) {
      setAvatarNote('服务端还没提供头像接口（404）：改动只在当前页面生效，刷新后会恢复。');
      return 'unsupported';
    }
    if (err.status === 401) return 'failed';
    setAvatarNote(`头像没保存上：${err.message}`);
    return 'failed';
  }
}

async function chooseShape(shape) {
  const bot = currentAvatarBot();
  if (!bot || !SHAPE_IDS.has(shape)) return;
  const before = avatarOf(bot).shape;
  if (before === shape) return;
  setAvatarLocal(bot, { shape });
  renderCustomizer();
  const result = await persistAvatar(bot, { shape });
  if (result === 'failed') {
    setAvatarLocal(bot, { shape: before });
    renderCustomizer();
  }
}

async function chooseColor(color) {
  const bot = currentAvatarBot();
  if (!bot) return;
  const before = avatarOf(bot).color;
  if (before.toLowerCase() === String(color).toLowerCase()) return;
  setAvatarLocal(bot, { color });
  renderCustomizer();
  const result = await persistAvatar(bot, { color });
  if (result === 'failed') {
    setAvatarLocal(bot, { color: before });
    renderCustomizer();
  }
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图打不开')); };
    img.src = url;
  });
}

/** Downscale to <=512px and re-encode, so the POST is small and predictable. */
async function downscaleImage(file, max = 512) {
  const img = await loadImageFile(file);
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(sourceW, sourceH));
  const width = Math.max(1, Math.round(sourceW * scale));
  const height = Math.max(1, Math.round(sourceH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const type = /png/i.test(file.type) ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
  if (!blob) throw new Error('图片处理失败');
  if (blob.size > 2 * 1024 * 1024) throw new Error('压完还是太大，换一张？');
  return blob;
}

async function uploadAvatarFile(file) {
  const bot = currentAvatarBot();
  if (!bot || !file) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    setAvatarNote('只支持 PNG / JPEG / WebP 图片。');
    return;
  }
  setAvatarNote('正在处理图片…');
  try {
    const blob = await downscaleImage(file, 512);
    let res;
    try {
      res = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/avatar`, {
        method: 'POST',
        headers: { 'content-type': blob.type || file.type },
        body: blob,
      });
    } catch {
      throw new Error('网络没通');
    }
    if (res.status === 401) { enterAuth('这台设备的授权已失效，请重新配对。'); return; }
    if (res.status === 404) {
      const localUrl = URL.createObjectURL(blob);
      setAvatarLocal(bot, { hasImage: true, imageUrl: localUrl });
      renderCustomizer();
      setAvatarNote('服务端还没头像接口（404）：图片只在本页预览，不会保存。');
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text.slice(0, 120) || `HTTP ${res.status}`);
    }
    setAvatarLocal(bot, {
      hasImage: true,
      imageUrl: `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${Date.now()}`,
    });
    renderCustomizer();
    setAvatarNote('');
    toast('头像已更新');
  } catch (err) {
    setAvatarNote(`上传失败：${err.message}`);
  }
}

async function removeAvatarImage() {
  const bot = currentAvatarBot();
  if (!bot) return;
  const before = avatarOf(bot);
  setAvatarLocal(bot, { hasImage: false, imageUrl: '' });
  renderCustomizer();
  try {
    const res = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/avatar`, { method: 'DELETE' });
    if (res.status === 404) {
      setAvatarNote('服务端还没头像接口（404）：这里只是本地预览。');
      return;
    }
    if (res.status === 401) { enterAuth('这台设备的授权已失效，请重新配对。'); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('已移除头像图片');
  } catch (err) {
    setAvatarLocal(bot, before);
    renderCustomizer();
    setAvatarNote(`没移除掉：${err.message}`);
  }
}

async function resetAvatar() {
  const bot = currentAvatarBot();
  if (!bot) return;
  setAvatarLocal(bot, { ...AVATAR_DEFAULT, hasImage: false, imageUrl: '' });
  renderCustomizer();
  try {
    await fetch(`/api/bots/${encodeURIComponent(bot.id)}/avatar`, { method: 'DELETE' });
  } catch { /* the PATCH below still restores shape/colour */ }
  const result = await persistAvatar(bot, { ...AVATAR_DEFAULT });
  if (result === 'failed') {
    setAvatarNote('重置没保存上，稍后再试。');
  } else if (result === 'ok') {
    toast('头像已重置');
  }
  renderCustomizer();
}


/* ---------------------------------------------------------------------
   A scheduled run in the chat (1.5.11): not the whole instruction as if the
   human had sent it, but one line - when, which task, how often - with the
   instruction folded away (看指令: change it, pause, run once more). A run
   that found nothing new is just that line, "没有变化", and no reply.
   --------------------------------------------------------------------- */
const QUIET_REPLY = /^[「"]?(没有变化|无变化|NO_CHANGE)[」"]?[。.!！]?$/i;

/** The routine a run's message came from: same bot, same instruction. */
function routineOfRun(item) {
  const text = String(item.text || '').trim();
  const botId = item.botId || state.botId;
  const all = state.routines || [];
  const found = all.find((r) => r.botId === botId && String(r.instruction || '').trim() === text)
    || all.find((r) => String(r.instruction || '').trim() === text);
  if (!found && !routineRunRow.asked) {
    routineRunRow.asked = true;
    api('/api/routines').then((list) => { state.routines = list; renderMessages(); }).catch(() => {});
  }
  return found || null;
}

/** Every reply of a routine's run was "没有变化". */
function quietRun(turnId) {
  const replies = (state.messages || []).filter((m) => m.role === 'assistant' && m.turnId === turnId);
  return replies.length > 0 && replies.every((m) => QUIET_REPLY.test(String(m.text || '').trim()));
}

function routineRunRow(item) {
  const rt = routineOfRun(item);
  const quiet = item.turnId && quietRun(item.turnId);
  const wrap = el('div', `routine-run${quiet ? ' quiet' : ''}`);
  const line = el('div', 'routine-run-line');
  const at = item.ts ? new Date(item.ts) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  const parts = [when, rt ? `定时任务「${rt.name}」` : '定时任务'];
  if (rt?.schedule) parts.push(scheduleText(rt.schedule));
  if (rt && !rt.enabled) parts.push('已暂停');
  if (quiet) parts.push('没有变化');
  line.appendChild(el('span', 'routine-run-icon', '⏱'));
  line.appendChild(el('span', null, parts.filter(Boolean).join(' · ')));
  const toggle = el('button', 'routine-run-toggle', '看指令');
  toggle.type = 'button';
  line.appendChild(toggle);
  wrap.appendChild(line);

  const body = el('div', 'routine-run-body');
  body.hidden = true;
  const text = el('div', 'routine-run-text', String(item.text || ''));
  body.appendChild(text);
  if (rt) {
    const actions = el('div', 'routine-run-actions');
    const button = (label, fn) => { const b = el('button', 'btn tiny', label); b.type = 'button'; b.addEventListener('click', fn); actions.appendChild(b); return b; };
    const edit = button('改指令', () => {
      const box = el('textarea', 'routine-run-edit');
      box.value = rt.instruction || '';
      box.rows = Math.min(14, Math.max(4, box.value.split('\n').length + 1));
      text.replaceWith(box);
      edit.remove();
      const save = el('button', 'btn tiny primary', '保存');
      save.type = 'button';
      save.addEventListener('click', async () => {
        try {
          await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { instruction: box.value.trim() } });
          rt.instruction = box.value.trim();
          toast('指令已更新，下次运行按新的来');
          text.textContent = rt.instruction;
          box.replaceWith(text);
          save.remove();
          actions.prepend(edit);
        } catch (err) { toast(err.message, true); }
      });
      actions.prepend(save);
      box.focus();
    });
    button(rt.enabled ? '暂停' : '恢复', async () => {
      try {
        await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { enabled: !rt.enabled } });
        rt.enabled = !rt.enabled;
        toast(rt.enabled ? '已恢复，按计划继续跑' : '已暂停，不会再自动跑');
        renderMessages();
      } catch (err) { toast(err.message, true); }
    });
    const again = button('现在再跑一次', async () => {
      again.disabled = true;
      again.textContent = '运行中…';
      try {
        const res = await api(`/api/routines/${encodeURIComponent(rt.id)}/test`, { method: 'POST', body: {} });
        toast(`跑完了：${runStatusLabel(res.run.status)}`);
      } catch (err) { toast(err.message, true); } finally { again.disabled = false; again.textContent = '现在再跑一次'; }
    });
    body.appendChild(actions);
  }
  wrap.appendChild(body);
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? '看指令' : '收起';
  });
  return wrap;
}
