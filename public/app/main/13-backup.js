'use strict';
// Lamplit page, part 13: 设置 → 备份 - back up to a file, restore from one, automatic backups, other machines (1.5.54).

/* The desktop app on this computer's own page picks files with its own
   dialogs and the hub reads / writes them there; anywhere else (a browser, a
   phone, another machine's page) the file is a download / an upload. */
const backupNative = () => Boolean(window.desk?.pickBackupSave) && onLocalMachine();
const backupState = { info: null, source: null, inspected: null };

function backupWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function backupStatus(text, isError = false) {
  const box = $('backup-status');
  if (!box) return;
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('bad', Boolean(isError));
}

/** 3 个助手、1 个群组… from a backup's counts. */
function backupCountsText(c = {}) {
  const parts = [];
  if (c.bots) parts.push(`${c.bots} 个助手`);
  if (c.groups) parts.push(`${c.groups} 个群组`);
  if (c.sessions) parts.push(`${c.sessions} 份聊天记录`);
  if (c.memory) parts.push(`${c.memory} 份记忆`);
  if (c.routines) parts.push(`${c.routines} 条例行任务`);
  if (c.skills) parts.push(`${c.skills} 个技能`);
  if (c.vault) parts.push(`保险箱 ${c.vault} 条`);
  if (c.secrets) parts.push(`${c.secrets} 组钥匙和应用设置`);
  if (c.workspaceFiles) parts.push(`工作区 ${c.workspaceFiles} 个文件（${fmtBytes(c.workspaceBytes || 0)}）`);
  return parts.join('、') || '几乎是空的';
}

/** A restore from the last 15 minutes (the hub restarted for it). */
const restoreRecent = (r) => Boolean(r?.at) && Date.now() - Date.parse(r.at) < 15 * 60 * 1000;
function restoreReport(r) {
  const pre = r.preBackup ? `恢复之前的数据另存在：${r.preBackup}` : '';
  return r.ok
    ? `恢复好了（${r.mode === 'merge' ? '合并' : '换成备份里的'}）。${pre}${r.problems?.length ? `\n有几处没恢复：${r.problems.join('；')}` : ''}\n别忘了：手机和其他机器要重新配对一次。`
    : `恢复没做完：${(r.problems || []).join('；')}。${pre}`;
}

async function loadBackup() {
  if (!$('sec-backup')) return;
  let info;
  try {
    info = await api('/api/backup', { quiet: true });
  } catch (err) {
    $('backup-last').textContent = err.quiet ? '要先把这个浏览器配对一次才能看（点「备份到文件…」会带你配对）' : (err.status === 404 ? '这台机器上的 Lamplit 还不会备份：先更新到最新版' : err.message);
    return;
  }
  backupState.info = info;
  $('backup-machine').textContent = info.machine || '这台机器';
  const last = info.lastBackup;
  $('backup-last').textContent = last?.at ? `${backupWhen(last.at)}${last.kind === 'auto' ? '（自动）' : ''}${last.bytes ? ` · ${fmtBytes(last.bytes)}` : ''}` : '还没备份过';
  const ws = info.workspace || {};
  $('backup-ws-size').textContent = !ws.files ? '（工作区是空的）'
    : ws.partial ? `（很大：超过 ${ws.files} 个文件、${fmtBytes(ws.bytes || 0)}）` : `（${ws.files} 个文件，${fmtBytes(ws.bytes || 0)}）`;
  const list = $('backup-not-list');
  list.replaceChildren(...(info.notIncluded || []).map((n) => el('li', '', n.text)));
  renderBackupSchedule(info.schedule || {});
  const peers = info.peers || [];
  $('backup-peers-wrap').hidden = !peers.length;
  $('backup-peers').replaceChildren(...peers.map((name) => {
    const b = el('button', 'btn tiny', `也备份「${name}」…`);
    b.type = 'button';
    b.addEventListener('click', () => backupPeer(name, b));
    return b;
  }));
  // Just restored (the page reloaded after the restart): say how it went here too.
  const r = info.lastRestore;
  if (restoreRecent(r) && !$('backup-status').textContent) backupStatus(restoreReport(r), !r.ok);
}

function backupPassword() {
  const p1 = $('backup-pass').value;
  const p2 = $('backup-pass2').value;
  if (p1.length < 8) throw new Error('备份密码至少 8 位。');
  if (p1 !== p2) throw new Error('两次输入的密码不一样。');
  return p1;
}

/** A POST that answers with a file: saved as a download. -> {name, bytes} */
async function backupDownload(path, body, fallbackName) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('无法连接 Lamplit 服务，网络可能断了。');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw Object.assign(new Error(j?.error?.message || `${res.status} ${res.statusText}`), { code: j?.error?.code, status: res.status });
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  let name = fallbackName;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { name = decodeURIComponent(star[1]); } catch { /* keep */ } }
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { name, bytes: blob.size };
}

async function backupGo() {
  let password;
  try { password = backupPassword(); } catch (err) { backupStatus(err.message, true); return; }
  const btn = $('backup-go');
  btn.disabled = true;
  try {
    await apiRequest('/api/backup'); // only the human: a browser not paired yet is asked to pair here
    const includeWorkspace = $('backup-ws').checked;
    if (backupNative()) {
      const picked = await window.desk.pickBackupSave(`Lamplit-备份-${(backupState.info?.machine || '').replace(/[\\/:*?"<>|]+/g, '')}-${new Date().toISOString().slice(0, 10)}.lamplit`);
      if (!picked?.path) { backupStatus(''); return; }
      backupStatus('正在备份…（工作区大的话要一会儿）');
      const r = await api('/api/backup', { method: 'POST', body: { password, includeWorkspace, to: picked.path } });
      backupStatus(`备份好了：${r.file}（${fmtBytes(r.bytes)}）。${r.warnings?.length ? `\n有几样没放进去：${r.warnings.join('；')}` : ''}`);
    } else {
      backupStatus('正在备份…（工作区大的话要一会儿）');
      const r = await backupDownload('/api/backup', { password, includeWorkspace }, 'Lamplit-备份.lamplit');
      backupStatus(`备份好了：已下载「${r.name}」（${fmtBytes(r.bytes)}）。把它存到 U 盘、网盘或另一台电脑上。`);
    }
    $('backup-pass').value = '';
    $('backup-pass2').value = '';
    loadBackup().catch(() => {});
  } catch (err) {
    if (!err.quiet) backupStatus(`没备份成：${err.message}`, true);
    // Asked to pair this browser first: once paired, the backup goes on by itself.
    else if (state.afterPair?.path === '/api/backup') state.afterPair.then = () => { loadBackup().catch(() => {}); backupGo(); };
  } finally {
    btn.disabled = false;
  }
}

async function backupPeer(name, btn) {
  let password;
  try { password = backupPassword(); } catch (err) { backupStatus(`${err.message}（在上面「备份密码」里填）`, true); return; }
  btn.disabled = true;
  backupStatus(`正在让「${name}」备份自己，再存到这台电脑上…`);
  try {
    const r = await backupDownload(`/api/peers/${encodeURIComponent(name)}/backup`, { password }, `Lamplit-备份-${name}.lamplit`);
    backupStatus(`「${name}」的备份好了：已下载「${r.name}」（${fmtBytes(r.bytes)}）。密码和上面的一样。`);
  } catch (err) {
    backupStatus(err.code === 'LOCAL_KEY_REQUIRED' ? '这一步只能在 Lamplit 应用里，或者配对过的设备上做。' : `「${name}」没备份成：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---- restoring --------------------------------------------------------------- */

async function restoreGo() {
  backupStatus('');
  try { await apiRequest('/api/backup'); } catch (err) {
    if (!err.quiet) backupStatus(err.message, true);
    else if (state.afterPair?.path === '/api/backup') state.afterPair.then = () => { loadBackup().catch(() => {}); restoreGo(); };
    return;
  }
  if (backupNative()) {
    const picked = await window.desk.pickBackupOpen();
    if (!picked?.path) return;
    try {
      const r = await api('/api/restore/peek', { method: 'POST', body: { from: picked.path } });
      backupState.source = { from: picked.path };
      renderRestoreStart(r.backup);
    } catch (err) { backupStatus(err.message, true); }
    return;
  }
  $('restore-file').value = '';
  $('restore-file').click();
}

/** The picked file goes up to the hub (with progress); what it is comes back. */
function restoreUpload(file) {
  if (!file) return;
  backupStatus(`正在读取「${file.name}」…`);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/restore/upload');
  xhr.setRequestHeader('content-type', 'application/octet-stream');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 2 * 1024 * 1024) backupStatus(`正在读取「${file.name}」… ${Math.round((e.loaded / e.total) * 100)}%`); };
  xhr.onerror = () => backupStatus('无法连接 Lamplit 服务，网络可能断了。', true);
  xhr.onload = () => {
    let j = null;
    try { j = JSON.parse(xhr.responseText); } catch { /* not json */ }
    // Not paired yet: the same 「这一步要你本人确认」 box as everywhere; once paired, the upload goes on.
    if (j?.error?.code === 'LOCAL_KEY_REQUIRED') {
      backupStatus('');
      if ($('local-pair-why')) $('local-pair-why').textContent = '备份和恢复只能在 Lamplit 应用里，或者在配对过的设备上做：备份里有这台机器的全部数据和钥匙，机器人自己跑的程序碰不到。';
      state.afterPair = { path: '/api/backup', options: {}, then: () => { loadBackup().catch(() => {}); restoreUpload(file); } };
      localPairOpen(true);
      return;
    }
    if (xhr.status !== 200) { backupStatus(j?.error?.message || `上传没成功（${xhr.status}）`, true); return; }
    backupStatus('');
    backupState.source = { uploadId: j.uploadId };
    // Where 恢复前自动备份 goes comes from this (beginner test 11-21: a page opened before pairing had none yet).
    if (!backupState.info) loadBackup().catch(() => {});
    renderRestoreStart(j.backup);
  };
  xhr.send(file);
}

function restorePanel() {
  const panel = $('restore-panel');
  panel.hidden = false;
  panel.replaceChildren();
  return panel;
}

function restoreClose() {
  const id = backupState.inspected?.id;
  if (id) api('/api/restore/cancel', { method: 'POST', body: { id } }).catch(() => {});
  backupState.inspected = null;
  backupState.source = null;
  $('restore-panel').hidden = true;
  $('restore-panel').replaceChildren();
}

/** Step 1: what the file is (no password needed) and the password. */
function renderRestoreStart(b) {
  const panel = restorePanel();
  panel.append(el('div', 'dsec-head restore-head', '从备份恢复'));
  const who = b.kind === 'pre-restore' ? '（这是一份「恢复前自动备份」）' : b.kind === 'auto' ? '（自动备份）' : '';
  panel.append(el('div', 'row-note', `这个备份：${backupWhen(b.createdAt)} 在「${b.machine || '一台机器'}」上做的${b.appVersion ? `（Lamplit ${b.appVersion}）` : ''}${who}。里面有：${backupCountsText(b.counts)}。`));
  const label = el('label', 'lbl', '备份密码');
  label.htmlFor = 'restore-pass';
  const pass = el('input', 'field');
  pass.id = 'restore-pass';
  pass.type = 'password';
  pass.autocomplete = 'off';
  const msg = el('div', 'set-status bad');
  msg.hidden = true;
  const row = el('div', 'btn-row');
  const open = el('button', 'btn primary', '打开');
  open.type = 'button';
  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', restoreClose);
  const go = async () => {
    msg.hidden = true;
    open.disabled = true;
    open.textContent = '正在打开…';
    try {
      const r = await api('/api/restore/inspect', { method: 'POST', body: { ...backupState.source, password: pass.value } });
      backupState.inspected = r;
      if (!backupState.info) await loadBackup().catch(() => {});
      renderRestoreChoice(r);
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
      // A damaged or newer file stays refused: only a wrong password is worth another try.
      if (err.code !== 'BACKUP_WRONG_PASSWORD') open.hidden = true;
    } finally {
      open.disabled = false;
      open.textContent = '打开';
    }
  };
  open.addEventListener('click', go);
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  row.append(open, cancel);
  panel.append(label, pass, row, msg);
  setTimeout(() => pass.focus(), 50);
}

/** Step 2: what is in it, what is not, replace or merge, and the confirm. */
function renderRestoreChoice(r) {
  const panel = restorePanel();
  const c = r.contents || {};
  panel.append(el('div', 'dsec-head restore-head', '从备份恢复'));
  panel.append(el('div', 'row-note', `密码对了，文件也是完整的。里面有：${backupCountsText(c.counts)}。`));
  if (c.bots?.length) panel.append(el('div', 'row-note', `助手：${c.bots.join('、')}`));
  if (c.secrets?.length) panel.append(el('div', 'row-note', `钥匙和设置：${c.secrets.join('、')}（恢复时用这台电脑自己的钥匙重新加密）`));
  // The one everybody meets first stays in sight; the rest folds (beginner test 11-21: eight lines open was long).
  const notIn = r.notIncluded || [];
  const first = notIn.find((n) => n.key === 'devices') || notIn[0];
  if (first) panel.append(el('div', 'row-note warn-note', `恢复后：${first.text}`));
  const out = el('details', 'backup-out');
  out.append(el('summary', '', '还有哪些不在备份里、恢复后要重新弄一下'));
  const ul = el('ul', 'backup-out-list');
  ul.append(...notIn.filter((n) => n !== first).map((n) => el('li', '', n.text)));
  out.append(ul);
  panel.append(out);

  let mode = r.current?.fresh ? 'replace' : '';
  if (r.current?.fresh) {
    panel.append(el('div', 'row-note', '这台还是刚装好的样子：恢复后就是备份里的样子。'));
  } else {
    panel.append(el('div', 'row-note warn-note', `这台机器上已经有东西了（${backupCountsText(r.current?.counts)}）。选一种：`));
    const opt = (value, title, text) => {
      const lab = el('label', 'restore-mode');
      const input = el('input');
      input.type = 'radio';
      input.name = 'restore-mode';
      input.value = value;
      input.addEventListener('change', () => { mode = value; });
      const body = el('span');
      body.append(el('b', '', title), el('span', 'row-note', text));
      lab.append(input, body);
      return lab;
    };
    panel.append(
      opt('merge', '合并', '这台已有的都不动，只把备份里这台没有的助手（连同它们的聊天和记忆）、例行任务、保险箱条目等加进来。'),
      opt('replace', '换成备份里的', '这台现在的助手、聊天记录、记忆、技能和群组换成备份里的，设置和钥匙也用备份里的。'),
    );
  }
  let wsBox = null;
  if (c.workspace?.files) {
    const lab = el('label', 'switch-row');
    wsBox = el('input');
    wsBox.type = 'checkbox';
    wsBox.checked = true;
    lab.append(wsBox, document.createTextNode(` 也恢复工作区里的 ${c.workspace.files} 个文件（${fmtBytes(c.workspace.bytes || 0)}）：工作区里别的文件不动`));
    panel.append(lab);
  }
  const folder = backupState.info?.schedule?.folder || backupState.info?.defaultFolder || '';
  panel.append(el('div', 'row-note', folder
    ? `恢复前会先把这台现在的数据另存一份「恢复前自动备份」（存在 ${folder}，密码和刚才输入的一样），恢复后 Lamplit 会自己重新启动。`
    : '恢复前会先把这台现在的数据另存一份「恢复前自动备份」（密码和刚才输入的一样，存在哪里恢复完会告诉你），恢复后 Lamplit 会自己重新启动。'));
  const msg = el('div', 'set-status bad');
  msg.hidden = true;
  const row = el('div', 'btn-row');
  const go = el('button', 'btn primary', '恢复');
  go.type = 'button';
  const cancel = el('button', 'btn', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', restoreClose);
  go.addEventListener('click', async () => {
    msg.hidden = true;
    if (!mode) { msg.textContent = '先选「合并」还是「换成备份里的」。'; msg.hidden = false; return; }
    const sure = mode === 'replace'
      ? (r.current?.fresh ? '确定从这个备份恢复吗？恢复后 Lamplit 会重新启动。' : '确定把这台的助手、聊天记录、记忆、技能、群组和设置换成备份里的吗？\n\n换之前会先自动备份一份现在的（恢复前自动备份）。')
      : '确定把备份里这台没有的东西合并进来吗？这台已有的不会改。';
    if (!window.confirm(sure)) return;
    go.disabled = true;
    cancel.disabled = true;
    go.textContent = '正在恢复…';
    try {
      const done = await api('/api/restore/apply', { method: 'POST', body: { id: r.id, mode, includeWorkspace: Boolean(wsBox?.checked), confirm: true } });
      backupState.inspected = null;
      panel.replaceChildren(el('div', 'row-note', `恢复前自动备份存好了：${done.preBackup?.file || ''}`));
      if (done.restarting) {
        panel.append(el('div', 'row-note', 'Lamplit 正在重新启动，好了会自己刷新。如果一分钟后还没好，关掉 Lamplit 再打开一次。'));
        restoreWaitRestart();
      } else {
        panel.append(el('div', 'row-note warn-note', '要重新启动 Lamplit，恢复才会生效。'));
      }
    } catch (err) {
      msg.textContent = err.message;
      msg.hidden = false;
      go.disabled = false;
      cancel.disabled = false;
      go.textContent = '恢复';
    }
  });
  row.append(go, cancel);
  panel.append(msg, row);
}

/** After the restart: wait for the hub to answer again (a fresh uptime), then reload. */
async function restoreWaitRestart() {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 2500));
  while (Date.now() - started < 120000) {
    try {
      const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json());
      if (h?.ok && h.uptimeSec < 60) { location.reload(); return; }
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/* ---- automatic backups ------------------------------------------------------- */

function renderBackupSchedule(s) {
  $('backup-auto-on').checked = Boolean(s.enabled);
  $('backup-auto-form').hidden = !s.enabled;
  $('backup-auto-folder').value = s.folder || '';
  $('backup-auto-every').value = String([24, 72, 168].includes(s.everyHours) ? s.everyHours : 24);
  $('backup-auto-keep').value = String([3, 7, 14, 30].includes(s.keep) ? s.keep : 7);
  $('backup-auto-ws').checked = Boolean(s.includeWorkspace);
  $('backup-auto-pick').hidden = !(window.desk?.pickFolder && onLocalMachine());
  $('backup-auto-pass-label').textContent = s.hasPassword ? '换一个密码（不换就空着）' : '自动备份的密码';
  const l = s.lastAuto;
  $('backup-auto-last').textContent = !s.enabled ? '' : !l ? '还没自动备份过。' : l.ok
    ? `上次自动备份：${backupWhen(l.at)}，成功（${fmtBytes(l.bytes || 0)}）。`
    : `上次自动备份：${backupWhen(l.at)}，没成功：${l.error || ''}`;
}

async function backupScheduleSave(enabled) {
  const body = enabled ? {
    enabled: true,
    folder: $('backup-auto-folder').value.trim(),
    everyHours: Number($('backup-auto-every').value),
    keep: Number($('backup-auto-keep').value),
    includeWorkspace: $('backup-auto-ws').checked,
    ...($('backup-auto-pass').value ? { password: $('backup-auto-pass').value } : {}),
  } : { enabled: false };
  if (enabled && body.password !== undefined && body.password.length < 8) { backupStatus('自动备份的密码至少 8 位。', true); return; }
  try {
    const r = await api('/api/backup/schedule', { method: 'POST', body });
    $('backup-auto-pass').value = '';
    renderBackupSchedule(r.schedule);
    backupStatus(enabled ? '自动备份设好了。' : '自动备份关掉了（保存的密码也删了）。');
  } catch (err) {
    if (!err.quiet) backupStatus(err.message, true);
    if (!enabled) $('backup-auto-on').checked = true;
  }
}

$('backup-go')?.addEventListener('click', backupGo);
$('restore-go')?.addEventListener('click', restoreGo);
$('restore-file')?.addEventListener('change', (e) => restoreUpload(e.target.files?.[0]));
$('backup-auto-on')?.addEventListener('change', (e) => {
  if (e.target.checked) { $('backup-auto-form').hidden = false; return; }
  if (backupState.info?.schedule?.enabled) backupScheduleSave(false);
  else $('backup-auto-form').hidden = true;
});
$('backup-auto-save')?.addEventListener('click', () => backupScheduleSave(true));
$('backup-auto-run')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  backupStatus('正在备份…');
  try {
    const r = await api('/api/backup/schedule/run', { method: 'POST' });
    backupStatus(`备份好了：${r.file}（${fmtBytes(r.bytes)}）。`);
    loadBackup().catch(() => {});
  } catch (err) {
    if (!err.quiet) backupStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
$('backup-auto-pick')?.addEventListener('click', async () => {
  const r = await window.desk?.pickFolder?.();
  if (r?.path) $('backup-auto-folder').value = r.path;
});
// Opened from the settings list (or straight to it): load what it shows.
document.addEventListener('click', (event) => {
  if (event.target.closest('.setnav[data-set-target="sec-backup"]')) loadBackup().catch(() => {});
});

// After the restart a restore asked for, the page that comes back says how it went, once
// (beginner test 11-21: only 设置 → 备份 said it, the chat page did not).
setTimeout(async () => {
  if (state.auth && state.auth.required && !state.auth.authorized) return;
  let info;
  try { info = await api('/api/backup?brief=1', { quiet: true }); } catch { return; }
  const r = info?.lastRestore;
  if (!restoreRecent(r)) return;
  let seen = '';
  try { seen = localStorage.getItem('lamplit.restoreSeen') || ''; } catch { /* private mode */ }
  if (seen === r.at) return;
  try { localStorage.setItem('lamplit.restoreSeen', r.at); } catch { /* private mode */ }
  toast(restoreReport(r).replace(/\n/g, ' '), !r.ok);
}, 2500);
