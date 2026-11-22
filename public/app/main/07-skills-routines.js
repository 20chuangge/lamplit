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

/** The built-in skills by a Chinese name (1.5.54, walkthrough 6.5: 「release-check」 meant nothing). */
const SKILL_NAMES = { 'release-check': '发布前检查', 'source-digest': '读网页写摘要', 'weekly-review': '写周报', 'workspace-sweep': '工作区小结' };

function renderSkills() {
  const list = $('skills-list');
  list.innerHTML = '';
  $('skills-count').textContent = String(state.skills.length);
  const bot = botById(state.botId);
  const granted = new Set((bot && bot.skills) || []);

  for (const skill of state.skills) {
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', null, SKILL_NAMES[skill.name] || skill.name));
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
    // The file is a detail, under the steps (1.5.54, walkthrough 6.5).
    const where = el('details', 'tiny muted');
    where.appendChild(el('summary', null, '文件在哪'));
    where.appendChild(el('div', 'card-sub mono', `${skill.name} · ${skill.file}`));
    card.appendChild(where);
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
  loadNudge().catch(() => { /* older server: no daily note */ });
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

/** A time in the peak hours, 「闲时再跑」 not ticked: said next to it (1.5.54, walkthrough 3.8). */
function routinePeakHint() {
  const hint = $('rt-peak-hint');
  if (!hint) return;
  const m = /(\d{1,2})[:：](\d{2})/.exec($('rt-schedule')?.value || '');
  const h = m ? Number(m[1]) + Number(m[2]) / 60 : -1;
  const peak = (h >= 9 && h < 12) || (h >= 14 && h < 18);
  const show = peakPriced() && peak && !$('rt-off-peak')?.checked && !/周[六日天]/.test($('rt-schedule')?.value || '');
  hint.hidden = !show;
  hint.textContent = show ? `${m[1]}:${m[2]} 是高峰时段，勾上下面的「闲时再跑」，模型费省一半。` : '';
}

function renderRoutines() {
  const list = $('routines-list');
  list.innerHTML = '';
  renderRoutineBotOptions();
  // 「闲时再跑」 only where the model has peak hours (1.5.50).
  const offPeakRow = $('rt-off-peak')?.closest('label');
  if (offPeakRow) offPeakRow.hidden = !peakPriced();
  routinePeakHint();

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
    // Waiting for the off-peak hours: the time it really runs (1.5.50: 「下次 3天后」 hid 12:00).
    meta.appendChild(el('span', 'tag', rt.offPeak && rt.nextRun ? `下次 ${fmtRunAt(rt.nextRun)}（闲时）` : `下次 ${fmtWhen(rt.nextRun)}`));
    if (rt.lastStatus) {
      const cls = rt.lastStatus === 'success' ? 'good' : rt.lastStatus === 'needs_approval' ? 'warn' : 'bad';
      meta.appendChild(el('span', `tag ${cls}`, `上次 ${runStatusLabel(rt.lastStatus)}`));
    }
    if (rt.preset === 'briefing') meta.appendChild(el('span', 'tag', '每日简报'));
    if (rt.onlyChanges) meta.appendChild(el('span', 'tag', '有变化才提醒'));
    if (rt.pushFeishu) meta.appendChild(el('span', 'tag', '发到飞书'));
    // 1.5.50: waits for the off-peak hours (half the model price).
    if (rt.offPeak) meta.appendChild(el('span', 'tag', '闲时再跑'));
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
        // You are here: a step that needs your OK asks you in its chat (1.5.41).
        await api(`/api/routines/${encodeURIComponent(rt.id)}/test`, { method: 'POST', body: { watched: true } });
        toast(`开始跑了：要你点头的步骤会在「${botById(rt.botId)?.name || '它'}」的对话里问你`);
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
    // 闲时再跑 on or off for a routine that exists (1.5.50, S2).
    const cheap = el('button', 'btn tiny', rt.offPeak ? '改成到点就跑' : '改成闲时再跑');
    cheap.type = 'button';
    cheap.title = rt.offPeak ? '不再等闲时：到点就跑' : OFF_PEAK_WORDS;
    cheap.addEventListener('click', async () => {
      try {
        await api(`/api/routines/${encodeURIComponent(rt.id)}`, { method: 'PATCH', body: { offPeak: !rt.offPeak } });
        await loadRoutines();
        toast(rt.offPeak ? '改好了：到点就跑' : `改好了：${OFF_PEAK_WORDS}`);
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
      // Only where the model has peak hours (DeepSeek), or to switch it off again.
      if (rt.offPeak || peakPriced()) actions.appendChild(cheap);
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

/** What 「闲时再跑」 does, in words (1.5.50, S2). */
const OFF_PEAK_WORDS = '到点时如果正好是高峰时段（工作日 9–12、14–18 点），就推到 12:00 或 18:00 再跑，模型费省一半';

/** Does this machine's model have peak hours (DeepSeek)? The off-peak option is shown only then. */
function peakPriced() {
  const m = (state.settings && state.settings.model) || {};
  return /deepseek/i.test(`${m.provider || ''} ${m.model || ''} ${m.baseUrl || ''}`);
}

/** 「今天 12:00」「明天 18:00」「周一 12:00」「11-30 12:00」 */
function fmtRunAt(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const days = Math.floor((at.getTime() - day0.getTime()) / 86400000);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `明天 ${hm}`;
  if (days > 1 && days < 7) return `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][at.getDay()]} ${hm}`;
  return `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${hm}`;
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
        offPeak: $('rt-off-peak').checked,
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
  if (isRemoteId(state.botId)) { renderRemoteMemoryNote(); return; }
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
  // The preview is alive too: a new shape or colour shows the face that will look back.
  lampMount(host, bot, 96);
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
  // Each part on its own, so the English page translates each (1.5.41 test: the line stayed Chinese).
  const said = el('span');
  parts.filter(Boolean).forEach((p, i) => { if (i) said.appendChild(document.createTextNode(' · ')); said.appendChild(el('span', null, p)); });
  line.appendChild(said);
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
        await api(`/api/routines/${encodeURIComponent(rt.id)}/test`, { method: 'POST', body: { watched: true } });
        toast('开始跑了：要你点头的步骤会在这里问你');
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

/* ---------------------------------------------------------------------
   1.5.45 第四步「替你想」: drafts, a change to a bot, the first hand-off to a
   machine, X, what each machine is for, 「有什么在等你」
   --------------------------------------------------------------------- */

/** What a card needs beyond the usual, from any record of it (a pending card, the transcript, the inbox). */
function cardExtras(src = {}) {
  return {
    ...(src.draft ? { draft: src.draft } : {}),
    ...(src.adjust ? { adjust: src.adjust } : {}),
    ...(src.handoff ? { handoff: src.handoff } : {}),
    ...(src.edits ? { edits: src.edits } : {}),
    ...(src.edited ? { edited: true } : {}),
  };
}

/** The headline of a card that is a draft, a change to a bot or a hand-off. */
function thinkCardInfo(data) {
  const d = data.draft;
  if (d) {
    const where = d.channel === '邮件' ? '发一封邮件' : d.channel === 'X' ? (d.kind === 'reply' ? '在 X 上回复一条帖子' : '在 X 上发一条帖子') : `发到「${d.channel}」`;
    return { title: `想${where}`, detail: '', facts: [], impact: data.decision ? '' : '下面是草稿，可以直接改；发出去的就是框里的字。' };
  }
  const a = data.adjust;
  if (a) return { title: `想改「${a.botName}」${a.machine ? `（${a.machine}）` : ''}`, detail: '', facts: [], impact: '同意后马上生效。之后可以在对话里点「撤销」改回去。' };
  const h = data.handoff;
  if (h) return { title: `想把一件事交给「${h.machine}」${h.bot ? `上的「${h.bot}」` : '上的主助理'}`, detail: '', facts: h.task ? [['要做的事', h.task]] : [], impact: h.waits
    ? `${h.bot ? `「${h.bot}」` : '那边的主助理'}做完会把结果交回来，我再告诉你。同意后，以后交给「${h.machine}」不再问你，聊天里会写一行交给了谁。`
    : `你这边不用换窗口，结果在左边「${h.machine}」下面看。同意后，以后交给「${h.machine}」不再问你，只告诉你一声。` };
  return null;
}

/** A draft: its text in boxes that can be edited (read-only once answered). */
function draftBox(data, { resolved = false } = {}) {
  const d = data.draft;
  const box = el('div', 'approval-draft');
  if (d.replyUrl) {
    const to = el('div', 'approval-fact');
    to.appendChild(el('span', 'approval-fact-k', '回复'));
    const link = el('a', 'approval-fact-v', d.context ? `「${d.context}」` : '这条帖子');
    link.href = d.replyUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    to.appendChild(link);
    box.appendChild(to);
  }
  const edits = data.edits || {};
  for (const f of d.fields || []) {
    const id = `draft-${data.approvalId || 'x'}-${f.key}`.replace(/[^\w-]/g, '_');
    const label = el('label', 'lbl', f.label);
    label.htmlFor = id;
    box.appendChild(label);
    const input = el(f.multiline ? 'textarea' : 'input', 'field draft-field');
    input.id = id;
    input.dataset.key = f.key;
    input.value = edits[f.key] !== undefined ? String(edits[f.key]) : String(f.value ?? '');
    if (f.multiline) input.rows = Math.min(10, Math.max(3, Math.ceil(input.value.length / 40)));
    if (resolved) input.readOnly = true;
    box.appendChild(input);
    if (f.max) {
      const count = el('div', 'tiny muted draft-count');
      const update = () => {
        const n = [...input.value].length;
        count.textContent = `${n} / ${f.max} 字`;
        count.classList.toggle('bad', n > f.max);
      };
      input.addEventListener('input', update);
      update();
      box.appendChild(count);
    }
  }
  if (Array.isArray(d.files) && d.files.length) box.appendChild(el('div', 'tiny muted', `一起发：${d.files.join('、')}`));
  return box;
}

/** The boxes' text where it differs from the draft: what goes with 「发送」. */
function draftEdits(card, data) {
  const out = {};
  for (const input of card.querySelectorAll('.draft-field')) {
    const f = (data.draft?.fields || []).find((x) => x.key === input.dataset.key);
    if (f && input.value !== String(f.value ?? '')) out[f.key] = input.value;
  }
  return Object.keys(out).length ? out : null;
}

/** A change to a bot, line by line: + added (green), - removed (red), the job line before and after. */
function adjustDiff(a) {
  const box = el('div', 'adjust-diff');
  // The rules as they are now (1.5.45 test: is the new one in conflict with an old one?).
  if (Array.isArray(a.rulesNow) && a.rulesNow.length) {
    const now = el('details', 'adjust-now');
    now.appendChild(el('summary', 'tiny muted', `现在的规则（${a.rulesNow.length} 条）`));
    for (const r of a.rulesNow) now.appendChild(el('div', 'adjust-line same', r));
    box.appendChild(now);
  }
  if (a.roleChange) {
    box.appendChild(el('div', 'adjust-line minus', `职责：${a.roleChange.from || '（空）'}`));
    box.appendChild(el('div', 'adjust-line plus', `职责：${a.roleChange.to}`));
  }
  for (const l of a.lines || []) {
    // A part that changes from one value to another (avatar, a routine's time): 「before → after」.
    if (l.op === '~') {
      // A colour is shown as a colour, not as its code.
      const hex = (v) => /^#[0-9a-f]{3,8}$/i.test(String(v || ''));
      if (hex(l.from) || hex(l.to)) {
        const row = el('div', 'adjust-line change');
        row.appendChild(document.createTextNode(`${l.label}：`));
        for (const [i, v] of [l.from, l.to].entries()) {
          if (i) row.appendChild(document.createTextNode(' → '));
          const dot = el('span', 'adjust-swatch');
          dot.style.background = hex(v) ? v : 'transparent';
          dot.title = String(v || '');
          row.appendChild(dot);
        }
        box.appendChild(row);
      } else box.appendChild(el('div', 'adjust-line change', `${l.label}：${l.from || '（空）'} → ${l.to}`));
      continue;
    }
    box.appendChild(el('div', `adjust-line ${l.op === '+' ? 'plus' : 'minus'}`, `${l.op === '+' ? '+ ' : '− '}${l.text}`));
  }
  return box;
}

/** The buttons' words on a card that is a draft, a change or a hand-off. */
function thinkButtons(data) {
  // Where it goes (1.5.58): 「发到小红书」, 「发出这封邮件」, 「回复」 - never a bare 「发送」.
  if (data.draft) return { yes: draftYes(data.draft), yesTip: '发出去的就是框里的字', no: '不发了', noTip: '不发，把「不发了」告诉它' };
  if (data.adjust) return { yes: '同意修改', yesTip: '马上生效，之后可以撤销', no: '不改了', noTip: '不改，把「不改了」告诉它' };
  if (data.handoff) return { yes: '交过去', yesTip: '以后交给这台不再问你', no: '先别交', noTip: '不交，把「不行」告诉它' };
  return null;
}

/** 「已改「策略」的规则 · 撤销」 after a change made by talking. */
/**
 * Work handed to an assistant on another machine, done (1.5.52 beginner test): shown in the chat
 * even with the steps hidden - who it went to, and its answer (folded when long).
 */
function handoffDoneCard(item) {
  const out = item.output && typeof item.output === 'object' ? item.output : {};
  const wrap = el('div', 'adjust-done handoff-done');
  wrap.appendChild(el('div', 'adjust-done-title', `交给了「${out.machine}」上的「${out.botName || out.botId || '助手'}」`));
  const reply = String(out.reply || '').trim();
  if (!reply || reply === '(no reply)') {
    wrap.appendChild(el('div', 'tiny muted', '它没有回复。'));
    return wrap;
  }
  if (out.status && !['success', 'done', 'ok'].includes(out.status)) wrap.appendChild(el('div', 'tiny muted', '它没做完，下面是它停下前说的。'));
  wrap.appendChild(el('div', 'tiny muted', '它的回复：'));
  const text = el('div', 'handoff-reply', reply.length > 300 ? `${reply.slice(0, 300)}…` : reply);
  wrap.appendChild(text);
  if (reply.length > 300) {
    const more = el('button', 'btn tiny', '看全文');
    more.type = 'button';
    more.addEventListener('click', () => { text.textContent = reply; more.remove(); });
    wrap.appendChild(more);
  }
  return wrap;
}

function adjustDoneCard(item) {
  const out = item.output && typeof item.output === 'object' ? item.output : {};
  const wrap = el('div', 'adjust-done');
  const who = `「${out.bot || '助手'}」${out.machine ? `（${out.machine}）` : ''}`;
  wrap.appendChild(el('div', 'adjust-done-title', `已改${who}`));
  if ((out.lines || []).length || out.role) wrap.appendChild(adjustDiff({ lines: out.lines || [], ...(out.role ? { roleChange: { from: '', to: out.role } } : {}) }));
  if (out.adjustmentId) {
    const undo = el('button', 'btn tiny', '撤销');
    // Undone already (another time, another device): said so after a reload.
    api('/api/adjustments').then((r) => { if ((r.items || []).some((a) => a.id === out.adjustmentId && a.undoneAt) && undo.isConnected) { undo.replaceWith(el('span', 'tiny muted', '已撤销，改回原样了')); wrap.classList.add('undone'); } }).catch(() => {});
    undo.type = 'button';
    undo.title = '把这个助手改回改之前的样子';
    undo.addEventListener('click', async () => {
      if (!(await askConfirm({ title: `把${who}改回原样？`, text: '这次改的每一项都改回改之前的样子。', confirmLabel: '撤销' }))) return;
      undo.disabled = true;
      try {
        await api(`/api/adjustments/${encodeURIComponent(out.adjustmentId)}/undo`, { method: 'POST', body: {} });
        undo.replaceWith(el('span', 'tiny muted', '已撤销，改回原样了'));
        wrap.classList.add('undone');
        toast(`已把${who}改回原样`);
      } catch (err) {
        undo.disabled = false;
        if (err.code === 'ADJUST_ALREADY_UNDONE') undo.replaceWith(el('span', 'tiny muted', '已经撤销过了'));
        else if (!err.quiet) toast(err.message, true);
      }
    });
    wrap.appendChild(undo);
  }
  return wrap;
}

/* --- X (Settings → 连接应用) ------------------------------------------- */
// `dataset` stands in for the card's: whether 发帖和回复 is being edited survives a re-render of the grid.
const xUi = { view: null, dataset: {} };

/** ?relay=… when this page shows another machine in the desktop app: X's sign-in comes back to this computer (1.5.52). */
function xRelayQuery() {
  const r = mcpRelay();
  return r ? `?relay=${encodeURIComponent(r)}` : '';
}

/** What X's tile needs: signed in or not, the callback to give X. Re-drawn where it is open. */
async function loadXCard() {
  try { xUi.view = await api(`/api/x${xRelayQuery()}`); } catch { xUi.view = null; return; }
  if ($('mcp-catalog')) renderMcp();
}

/** X's tile was changed: the grid is drawn again (the tile stays open). */
function renderXCard() {
  renderMcp();
}

/**
 * X in 连接应用 (1.5.52: a tile like every app, no card pinned on top). Opened, it has
 * two parts on the same X developer app:
 *   发帖和回复              sign in on X's own page (OAuth 2.0), every post a draft first
 *   搜帖子、看用户（可选）  X's hosted app (read-only) with the app's Bearer Token -
 *                           the catalog entry with detail: 'x'
 */
function renderXDetail(app) {
  const box = el('div', 'mcp-app-body x-detail');
  // Said first: without a developer account there is nothing to do here yet (1.5.54, walkthrough 6.1).
  box.appendChild(el('div', 'row-note', '要先有一个 X 开发者账号（在 X 开发者后台用你的 X 账号注册，十来分钟）。没有的话，可以先跳过 X。'));
  box.appendChild(el('div', 'tiny muted', '两部分用的是同一个 X 开发者应用：发帖要在 X 的网页上登录授权，搜帖子只要它的 Bearer Token。'));
  const v = xUi.view;
  const post = el('div', 'x-part');
  post.appendChild(el('div', 'x-part-title', '发帖和回复'));
  if (!v) post.appendChild(el('div', 'tiny muted', '这台机器的 Lamplit 还不支持。'));
  else {
    post.appendChild(el('div', 'tiny muted', v.connected ? `已连接：@${v.username || '你的账号'}` : v.configured ? '应用已填好，还没登录授权' : '助手发的每一条都先给你看草稿，你点「发送」才发'));
    renderXPost(post, v, xUi);
  }
  box.appendChild(post);
  const read = el('div', 'x-part');
  read.appendChild(el('div', 'x-part-title', '搜帖子、看用户（可选）'));
  renderXRead(read, app);
  box.appendChild(read);
  return box;
}

/** 搜帖子、看用户: X's hosted app, with the same panels as any connected app. */
function renderXRead(part, app) {
  const srv = app.server || (mcpUi.servers || []).find((s) => s.catalogId === 'x') || null;
  part.appendChild(el('div', 'tiny muted', srv ? mcpStateLabel(srv) : '只读：让助手搜 X 上的帖子、看用户和话题。用不着就不用接。'));
  if (srv) { part.appendChild(mcpServerPanel(srv)); return; }
  if (!xUi.readOpen) {
    const open = el('button', 'btn tiny', '接上');
    open.type = 'button';
    open.addEventListener('click', () => { xUi.readOpen = true; renderXCard(); });
    part.appendChild(open);
    return;
  }
  part.appendChild(mcpConnectForm(app));
}

/** Whether X's tile counts as connected (for 「已连接 N」): either part switched on. 0 or 1. */
function xConnectedCount() {
  return xUi.view?.connected || (mcpUi.servers || []).some((s) => s.catalogId === 'x' && mcpIsOn(s)) ? 1 : 0;
}

/** X's tile line: signed in, the read part's state, set up but not signed in, or 连接. */
function xTileState(srv) {
  if (xUi.view?.connected) return { text: '✓ 已连接', cls: 'ok' };
  if (srv) return { text: mcpStateLabel(srv), cls: srv.state === 'ready' ? 'ok' : srv.state === 'needs_auth' || srv.state === 'failed' ? 'warn' : '' };
  if (xUi.view?.configured) return { text: '还没登录授权', cls: 'warn' };
  return { text: '连接', cls: '' };
}

/** 发帖和回复: the human's developer app, signing in on X, who may post. */
function renderXPost(box, v, card) {
  if (!v.configured || card.dataset.editing === '1') {
    const step1 = el('div', 'row-note');
    step1.appendChild(document.createTextNode('1. 在 '));
    const dev = el('a', null, 'X 开发者后台');
    dev.href = v.developerUrl;
    dev.target = '_blank';
    dev.rel = 'noopener noreferrer';
    dev.addEventListener('click', (e) => { e.preventDefault(); openSignInPage(v.developerUrl); });
    step1.appendChild(dev);
    step1.appendChild(document.createTextNode(' 打开你的应用 → 「User authentication settings」：类型选「Web App」，权限选「Read and write」，回调地址填下面这一行。'));
    box.appendChild(step1);
    box.appendChild(el('div', 'row-note', '还没有开发者应用：在上面的网址用你的 X 账号登录，建一个项目和应用（Project → App）就有了。X 的接口要不要付费、每月能发多少，按 X 当时的规定。'));
    const cb = el('input', 'field mono');
    cb.readOnly = true;
    cb.value = v.callback;
    cb.setAttribute('aria-label', '回调地址');
    cb.addEventListener('focus', () => cb.select());
    box.appendChild(cb);
    box.appendChild(el('div', 'row-note', '2. 在应用的「Keys and tokens」里复制「OAuth 2.0 Client ID」和「Client Secret」，填在这里。它们加密存在这台电脑上，不进聊天，也不会发给别的机器。'));
    const id = el('input', 'field mono');
    id.placeholder = v.clientIdHint ? `Client ID（现在是 ${v.clientIdHint}，不改就留空）` : 'Client ID';
    id.autocomplete = 'off';
    id.setAttribute('aria-label', 'X 的 Client ID');
    const secret = el('input', 'field mono');
    secret.type = 'password';
    secret.placeholder = v.hasClientSecret ? 'Client Secret（已保存，不改就留空）' : 'Client Secret';
    secret.autocomplete = 'off';
    secret.setAttribute('aria-label', 'X 的 Client Secret');
    box.appendChild(id);
    box.appendChild(secret);
    const save = el('button', 'btn primary', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        xUi.view = await api('/api/x/app', { method: 'PUT', body: { ...(id.value.trim() ? { clientId: id.value.trim() } : {}), ...(secret.value.trim() ? { clientSecret: secret.value.trim() } : {}) } });
        delete card.dataset.editing;
        renderXCard();
        toast('保存好了：下一步点「去 X 登录授权」');
      } catch (err) { save.disabled = false; if (!err.quiet) toast(err.message, true); }
    });
    const row = el('div', 'btn-row');
    row.appendChild(save);
    if (v.configured) {
      const cancel = el('button', 'btn', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { delete card.dataset.editing; renderXCard(); });
      row.appendChild(cancel);
    }
    box.appendChild(row);
    return;
  }
  // Saved, not signed in yet (1.5.52 beginner test): the callback stays in view, the one X must have.
  if (!v.connected && v.callback) {
    box.appendChild(el('div', 'row-note', 'X 后台填的回调地址要是这一行：'));
    const cbNow = el('input', 'field mono');
    cbNow.readOnly = true;
    cbNow.value = v.callback;
    cbNow.setAttribute('aria-label', '回调地址');
    cbNow.addEventListener('focus', () => cbNow.select());
    box.appendChild(cbNow);
  }
  const row = el('div', 'btn-row');
  const login = el('button', `btn${v.connected ? '' : ' primary'}`, v.connected ? '重新登录授权' : '去 X 登录授权');
  login.type = 'button';
  login.title = '在 X 自己的网页上登录并点「允许」。Lamplit 看不到你的 X 密码';
  login.addEventListener('click', async () => {
    login.disabled = true;
    try {
      const r = await api('/api/x/login', { method: 'POST', body: { relay: mcpRelay() } });
      await openSignInPage(r.url);
      toast('在打开的 X 页面上登录并点「允许」，完成后回到这里');
    } catch (err) { if (!err.quiet) toast(err.message, true); } finally { login.disabled = false; }
  });
  row.appendChild(login);
  const edit = el('button', 'btn', '改应用');
  edit.type = 'button';
  edit.addEventListener('click', () => { card.dataset.editing = '1'; renderXCard(); });
  row.appendChild(edit);
  if (v.connected) {
    const out = el('button', 'btn', '断开');
    out.type = 'button';
    out.addEventListener('click', async () => {
      if (!(await askConfirm({ title: '断开 X？', text: '助手就不能再发帖了（已经发的不受影响）。要再用时重新登录授权就行。', confirmLabel: '断开' }))) return;
      try { xUi.view = await api('/api/x', { method: 'DELETE' }); renderXCard(); } catch (err) { if (!err.quiet) toast(err.message, true); }
    });
    row.appendChild(out);
  }
  box.appendChild(row);
  box.appendChild(el('div', 'row-note', '要在电脑上的 Lamplit 里点登录：X 会把你送回你正在用的这台电脑，它再交给设置 X 的那台机器（在别的机器的页面里设置也行）。'));
  if (v.connected) {
    box.appendChild(el('div', 'lbl', '哪些助手能在 X 上发帖（每一条都先给你看草稿）'));
    const picks = el('div', 'x-bots');
    for (const bot of state.bots || []) {
      const lab = el('label', 'switch-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = (v.bots || []).includes(bot.id);
      cb.addEventListener('change', async () => {
        const next = new Set(xUi.view.bots || []);
        if (cb.checked) next.add(bot.id); else next.delete(bot.id);
        try { xUi.view = await api('/api/x/bots', { method: 'PUT', body: { bots: [...next] } }); toast(cb.checked ? `「${bot.name}」可以在 X 上发帖了（先给你看草稿）` : `「${bot.name}」不能再在 X 上发帖`); } catch (err) { cb.checked = !cb.checked; if (!err.quiet) toast(err.message, true); }
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(` ${bot.name}`));
      picks.appendChild(lab);
    }
    box.appendChild(picks);
  }
}

/* --- what each machine is for (设置 → 机器) ----------------------------- */
const machineNotesUi = { notes: {}, at: 0 };

async function loadMachineNotes() {
  try {
    const r = await api('/api/machine-notes');
    machineNotesUi.notes = r.notes || {};
    machineNotesUi.at = Date.now();
  } catch { /* older server */ }
  return machineNotesUi.notes;
}

/** 「适合：…」 under a machine, editable in place. */
function machineNoteLine(name) {
  const line = el('div', 'machine-note tiny');
  const n = machineNotesUi.notes[name];
  const show = () => {
    line.innerHTML = '';
    line.classList.remove('editing');
    line.closest('.machine-row')?.classList.remove('noting');
    const cur = machineNotesUi.notes[name]?.note || '';
    const shown = el('span', 'muted machine-note-text', `适合：${cur ? shortNote(cur, 30) : '还没写'}`);
    if (cur) {
      shown.title = cur;
      // No hover on a phone: a tap shows the whole line, another tap folds it.
      shown.addEventListener('click', () => { const full = shown.classList.toggle('full'); shown.textContent = `适合：${full ? cur : shortNote(cur, 30)}`; });
    }
    line.appendChild(shown);
    const edit = el('button', 'link-btn tiny', '改');
    edit.type = 'button';
    edit.title = '主助理按这一句挑机器干活';
    edit.addEventListener('click', () => {
      line.innerHTML = '';
      const input = el('input', 'field');
      input.value = cur;
      input.maxLength = 200;
      input.placeholder = '比如：一直开着，跑发布和筛岗';
      input.setAttribute('aria-label', `「${name}」适合干什么`);
      const ok = el('button', 'btn tiny primary', '保存');
      ok.type = 'button';
      ok.addEventListener('click', async () => {
        try {
          const r = await api('/api/machine-notes', { method: 'PUT', body: { machine: name, note: input.value } });
          machineNotesUi.notes = r.notes || machineNotesUi.notes;
          show();
          toast('记下了：主助理以后按这一句挑机器');
        } catch (err) { if (!err.quiet) toast(err.message, true); }
      });
      const no = el('button', 'btn tiny', '取消');
      no.type = 'button';
      no.addEventListener('click', show);
      line.classList.add('editing');
      line.closest('.machine-row')?.classList.add('noting');
      line.appendChild(input);
      line.appendChild(ok);
      line.appendChild(no);
      line.appendChild(el('div', 'tiny muted machine-note-where', '只记在这台电脑的 Lamplit 里：这台上的主助理按这一句挑机器。'));
      input.focus();
    });
    line.appendChild(edit);
  };
  if (n !== undefined || machineNotesUi.at) show();
  else loadMachineNotes().then(show);
  return line;
}

/* --- 「有什么在等你」 (右边「任务」) ------------------------------------- */
async function loadNudge() {
  if (!$('nudge-on')) return;
  try {
    const n = await api('/api/nudge');
    $('nudge-on').checked = Boolean(n.enabled);
    $('nudge-time').value = n.time || '09:00';
  } catch { $('nudge-card')?.setAttribute('hidden', ''); }
}

async function saveNudge() {
  const n = await api('/api/nudge', { method: 'PUT', body: { enabled: $('nudge-on').checked, time: $('nudge-time').value || '09:00' } });
  toast(n.enabled ? `好的，每天 ${n.time} 告诉你有什么在等你（没有就不说）` : '每天的提醒关掉了');
  return n;
}

/** At most n characters, then 「…」. */
function shortNote(s, n = 30) {
  const chars = [...String(s || '')];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

/** How a machine is reached, in a few words: its address, Tailscale, or the relay. */
function machineRoute(m) {
  const hostPort = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };
  if (m.self) return m.url ? hostPort(m.url) : '只在这台电脑上用';
  if (m.relay) return '经中转';
  if (m.tailnetUrl) return ['Tailscale', hostPort(m.tailnetUrl)].join(' · ');
  return m.url ? hostPort(m.url) : '';
}

/**
 * 设置 → 机器 (1.5.51, the human: just the name and the address): each row is
 * the machine's name (this one by its own name, tagged 「这台」), where it is
 * reached and whether it answers, and one short 「适合」 line behind 「改」. The
 * bots are not listed here: the sidebar shows them.
 */
async function addMachineNotes(box) {
  let here = '';
  try { here = (await api('/api/machine-notes')).here || ''; } catch { return; }
  await loadMachineNotes();
  let list = [];
  try { list = (await api('/api/machines')).machines || []; } catch { /* the rows keep what they had */ }
  for (const row of box.querySelectorAll('.machine-row')) {
    const meta = row.querySelector('.machine-meta');
    const nameEl = row.querySelector('.machine-name');
    if (!meta || !nameEl) continue;
    const self = row.dataset.self === '1';
    const name = self ? (here || nameEl.textContent) : nameEl.textContent;
    if (self && !nameEl.querySelector('.machine-tag')) {
      nameEl.textContent = name;
      nameEl.appendChild(el('span', 'machine-tag here', '这台'));
      // 「这台」 already says it; 「当前」 next to it said the same again (1.5.51 test).
      for (const t of row.querySelectorAll('.machine-actions .machine-tag')) if (t.textContent === '当前') t.remove();
    }
    const m = self ? list.find((x) => x.self) : list.find((x) => !x.self && x.name === name);
    const sub = row.querySelector('.machine-sub');
    if (m && sub) {
      const funnel = sub.querySelector('.funnel-state');
      sub.innerHTML = '';
      sub.appendChild(el('span', `dot ${m.online ? 'on' : ''}`));
      sub.appendChild(document.createTextNode(m.online ? '在线' : '离线'));
      const route = machineRoute(m);
      if (route) sub.appendChild(el('span', 'machine-route', ` · ${route}`));
      if (funnel) sub.appendChild(funnel);
    }
    if (!meta.querySelector('.machine-note')) meta.appendChild(machineNoteLine(name));
  }
}
/* --- 设置 → 主动: the initiative layer, all in one place (1.5.45) ------------------ */
const initiativeUi = { view: null };
const INITIATIVE_EVENTS = [
  ['card_waiting', '一张卡等了很久还没人点'],
  ['machine_back', '一台机器重新连上了'],
  ['outbox_sent', '排队等别的机器的消息交过去了'],
  ['routine_failed', '定时任务没跑成（由那个助手自己说）'],
];

async function loadInitiative() {
  if (!$('initiative-box')) return;
  try { initiativeUi.view = await api('/api/initiative'); } catch { return; }
  const v = initiativeUi.view;
  if ($('nudge-on')) $('nudge-on').checked = Boolean(v.daily?.enabled);
  if ($('nudge-time')) $('nudge-time').value = v.daily?.time || '09:00';
  renderInitiative();
}

async function saveInitiative(patch, okText = '已保存') {
  try {
    initiativeUi.view = await api('/api/initiative', { method: 'PUT', body: patch });
    if (okText) toast(okText);
    renderInitiative();
  } catch (err) { if (!err.quiet) toast(err.message, true); loadInitiative(); }
}

function renderInitiative() {
  const box = $('initiative-box');
  const v = initiativeUi.view;
  if (!box || !v) return;
  box.innerHTML = '';
  const card = (title) => { const c = el('div', 'card initiative-card'); c.appendChild(el('div', 'lbl', title)); box.appendChild(c); return c; };
  const sw = (parent, text, on, change) => {
    const lab = el('label', 'switch-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(on);
    cb.addEventListener('change', () => change(cb.checked));
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(` ${text}`));
    parent.appendChild(lab);
    return cb;
  };

  const rules = card('什么时候开口');
  const maxRow = el('div', 'row-2');
  maxRow.appendChild(el('span', null, '每个助手每天最多'));
  const max = el('input', 'field initiative-max');
  max.type = 'number';
  max.min = '1';
  max.max = '20';
  max.value = String(v.maxPerDay || 3);
  max.setAttribute('aria-label', '每个助手每天最多几条');
  max.addEventListener('change', () => saveInitiative({ maxPerDay: Number(max.value) }, `好的，每个助手每天最多主动说 ${max.value} 条`));
  maxRow.appendChild(max);
  maxRow.appendChild(el('span', null, '条，多的攒到下一条一起说'));
  rules.appendChild(maxRow);
  sw(rules, '窗口不在前面时，在电脑/手机上弹通知', v.notify, (on) => saveInitiative({ notify: on }));
  sw(rules, '安静时段（这段时间不说，过了合成一条）', v.quiet?.on, (on) => saveInitiative({ quiet: { on } }));
  if (v.quiet?.on) {
    const q = el('div', 'row-2');
    for (const k of ['from', 'to']) {
      const t = el('input', 'field');
      t.type = 'time';
      t.value = v.quiet[k];
      t.setAttribute('aria-label', k === 'from' ? '安静时段从' : '安静时段到');
      t.addEventListener('change', () => saveInitiative({ quiet: { [k]: t.value } }));
      q.appendChild(t);
      if (k === 'from') q.appendChild(el('span', null, '到'));
    }
    rules.appendChild(q);
  }

  const ev = card('出了这些事，主助理告诉你');
  for (const [k, words] of INITIATIVE_EVENTS) sw(ev, words, v.events?.[k] !== false, (on) => saveInitiative({ events: { [k]: on } }));
  const waitRow = el('div', 'row-2');
  waitRow.appendChild(el('span', 'tiny muted', '「等了很久」指超过'));
  const wait = el('input', 'field initiative-max');
  wait.type = 'number';
  wait.min = '5';
  wait.value = String(v.cardWaitMinutes || 60);
  wait.setAttribute('aria-label', '卡片等多久算很久（分钟）');
  wait.addEventListener('change', () => saveInitiative({ cardWaitMinutes: Number(wait.value) }));
  waitRow.appendChild(wait);
  waitRow.appendChild(el('span', 'tiny muted', '分钟'));
  ev.appendChild(waitRow);

  const who = card('哪些助手可以主动找你（这台机器上的）');
  for (const bot of (state.bots || []).filter((b) => !b.machine)) {
    sw(who, `${bot.name}${bot.primary ? '（主助理）' : ''}`, v.bots?.[bot.id] !== false, (on) => saveInitiative({ bots: { [bot.id]: on } }, on ? `「${bot.name}」可以主动找你了` : `「${bot.name}」不会再主动找你`));
  }

  const later = card('助手约好的回头看、盯着的文件夹');
  const items = [
    ...(v.followUps || []).map((f) => ({ kind: 'followups', id: f.id, text: `${botById(f.botId)?.name || f.botId} · ${new Date(f.at).toLocaleString()}：${f.about}` })),
    ...(v.watches || []).map((w) => ({ kind: 'watches', id: w.id, text: `${botById(w.botId)?.name || w.botId} 盯着「${w.path}」：${w.about}` })),
  ];
  if (!items.length) later.appendChild(el('div', 'tiny muted', '现在没有。对助手说「明天提醒我看结果」「新文件放进 inbox 就处理」，它会记在这里。'));
  for (const it of items) {
    const row = el('div', 'initiative-item');
    row.appendChild(el('span', 'tiny', it.text));
    const x = el('button', 'btn tiny', '取消');
    x.type = 'button';
    x.addEventListener('click', async () => {
      try { initiativeUi.view = await api(`/api/initiative/${it.kind}/${encodeURIComponent(it.id)}`, { method: 'DELETE' }); renderInitiative(); toast('取消了'); } catch (err) { if (!err.quiet) toast(err.message, true); }
    });
    row.appendChild(x);
    later.appendChild(row);
  }
}

/** A bot waking itself (a follow-up it set, a new file in a folder it watches): one line, not the system's note (1.5.45). */
function initiativeLine(text, source) {
  const first = String(text || '').split('\n')[0];
  if (source === 'watch') {
    const m = /^（你盯着的文件夹「(.+?)」里出现了新文件：(.+?)）(.*)$/.exec(first);
    return m ? `盯着的文件夹「${m[1]}」有新文件：${m[2]}` : '盯着的文件夹里有新文件';
  }
  return `约好的回头看：${first.replace(/^（[^）]*）/, '').trim() || '到时间了'}`;
}
