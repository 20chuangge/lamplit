'use strict';
// Lamplit page, part 5b: folder upload (1.5.64) - 📎 → 「选文件夹」 or a folder dropped on the chat; its files go up one by one keeping the layout (uploads/<day>/<folder>/…), it waits as one chip and goes as one attachment, drawn as one folder card; skipped and too-big files are named before sending; 「正在传 12/40…」 while a hub passes it to another machine. Phones pick files only. Parts share one scope and load in order (scripts/check-page-parts.mjs).

/** "[附件]" block the server appends for the bot: split it off for display. */
const ATTACH_MARK = '\n\n[附件] 都在共享工作区里：\n';
function splitAttachments(text) {
  const raw = String(text || '');
  const at = raw.indexOf(ATTACH_MARK);
  if (at < 0) return { text: raw, files: [] };
  const files = [];
  for (const line of raw.slice(at + ATTACH_MARK.length).split('\n')) {
    // A folder (1.5.64): its line, then "  · 素材/a.png" lines and "  …还有 N 个" under it.
    const folder = parseFolderLine(line);
    if (folder) { files.push(folder); continue; }
    const last = files[files.length - 1];
    const sub = /^ {2}· (.+)$/.exec(line);
    const more = /^ {2}…还有 (\d+) 个$/.exec(line);
    if (last?.folder && (sub || more)) { if (sub) last.entries.push(sub[1]); else last.more = Number(more[1]); continue; }
    const m = /^- (.+?)（(图片|文件)，([^）]+)）$/.exec(line.trim());
    // A video attached as a file is a video (1.5.49: an .mp4 showed as a plain file icon).
    if (m) files.push({ path: m[1], image: m[2] === '图片', video: m[2] === '文件' && /\.(mp4|webm|mov|m4v)$/i.test(m[1]), size: m[3], name: m[1].split('/').pop() });
  }
  const body = raw.slice(0, at);
  return { text: body === '（见附件）' ? '' : body, files };
}

/** The ✕ on a chip waiting in the composer: a file, or a folder still going up (it stops). */
function removeChipButton(f) {
  const x = el('button', 'att-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', '移除');
  x.addEventListener('click', () => {
    state.pendingFiles = state.pendingFiles.filter((p) => p !== f);
    f.cancelled = true; // a folder still going up stops (1.5.64)
    if (f.preview) URL.revokeObjectURL(f.preview);
    renderAttachStrip();
  });
  return x;
}

/* The same rules as src/folderupload.mjs (the hub checks every file again). */
const FOLDER_LIMITS = { files: 200, bytes: 500 * 1024 * 1024, file: 25 * 1024 * 1024, items: 20 };
const FOLDER_SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__macosx', '$recycle.bin', 'system volume information', '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems']);
const FOLDER_SKIP_FILES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', '.localized', 'icon\r']);
const FOLDER_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** What of a path inside the folder the upload leaves out: '' (nothing), "node_modules/" (a folder, once for all its files) or "a/Thumbs.db". */
function folderSkipped(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const low = parts[i].toLowerCase();
    if (i < parts.length - 1 && FOLDER_SKIP_DIRS.has(low)) return `${parts.slice(0, i + 1).join('/')}/`;
    if (i === parts.length - 1 && (FOLDER_SKIP_FILES.has(low) || low.startsWith('._') || low.startsWith('~$'))) return parts.join('/');
  }
  return '';
}

/** A path inside the folder that cannot be stored safely (.., reserved Windows names…). */
function folderBadPath(rel) {
  const s = String(rel || '');
  if (!s || s.includes('\\') || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.length > 600) return true;
  const parts = s.split('/');
  if (parts.length > 24) return true;
  // eslint-disable-next-line no-control-regex
  return parts.some((p) => !p || p === '.' || p === '..' || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(p) || /[. ]$/.test(p) || /^ /.test(p) || FOLDER_RESERVED.test(p));
}

/**
 * What of a folder goes up: [{file, rel}] in -> {ok, skipped, over, bad, bytes, refuse}.
 * `rel` is the path inside the folder ("素材/a.png"). Too many files or too
 * many bytes in all: the whole folder is refused (refuse says why).
 */
function planFolder(entries) {
  const ok = [];
  const skipped = [];
  const over = [];
  const bad = [];
  for (const e of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const skip = folderSkipped(e.rel);
    if (skip) { if (!skipped.includes(skip)) skipped.push(skip); }
    else if (folderBadPath(e.rel)) bad.push(e.rel);
    else if ((e.file?.size || 0) > FOLDER_LIMITS.file) over.push(e.rel);
    else ok.push(e);
  }
  const bytes = ok.reduce((s, e) => s + (e.file?.size || 0), 0);
  let refuse = '';
  if (!ok.length) refuse = '这个文件夹里没有能传的文件';
  else if (ok.length > FOLDER_LIMITS.files) refuse = `文件夹里有 ${ok.length} 个文件，一次最多 ${FOLDER_LIMITS.files} 个。可以分成几个小文件夹再传`;
  else if (bytes > FOLDER_LIMITS.bytes) refuse = `文件夹一共 ${fmtBytes(bytes)}，一次最多 500 MB。可以分成几个小文件夹再传`;
  return { ok, skipped, over, bad, bytes, refuse };
}

/** Folder upload on this device: a computer's browser or the desktop app, not a phone (1.5.64). */
function canPickFolder() {
  if (window.Capacitor || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')) return false;
  if (window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(pointer: fine)').matches) return false;
  return 'webkitdirectory' in document.createElement('input');
}

/** The folder chosen with 「选文件夹」: its files carry "folder/sub/a.png" as webkitRelativePath. */
function addPickedFolder(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) { toast('这个文件夹是空的', true); return; }
  const first = String(files[0].webkitRelativePath || files[0].name);
  const name = first.split('/')[0] || '文件夹';
  const entries = files.map((file) => ({ file, rel: String(file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name }));
  return addFolder(name, entries);
}

/** Every file under a dropped folder entry (FileSystemDirectoryEntry), with its path inside it. */
async function readDroppedFolder(dirEntry) {
  const out = [];
  const readAll = (reader) => new Promise((resolve) => {
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, () => resolve(all));
    next();
  });
  const fileOf = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
  async function walk(dir, prefix) {
    for (const entry of await readAll(dir.createReader())) {
      if (out.length > FOLDER_LIMITS.files * 5) return; // far over the limit: enough to say so
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (FOLDER_SKIP_DIRS.has(entry.name.toLowerCase())) { out.push({ file: null, rel: `${rel}/` }); continue; } // not read at all, only named
        await walk(entry, rel);
      } else if (entry.isFile) {
        const file = await fileOf(entry);
        if (file) out.push({ file, rel });
      }
    }
  }
  await walk(dirEntry, '');
  return out;
}

/**
 * Something dropped on the chat: files as before, folders read through
 * dataTransfer.items (dataTransfer.files lists a folder as an empty "file").
 * The entries must be taken while the drop event runs; reading them can wait.
 */
function onChatDrop(event) {
  const dt = event.dataTransfer;
  if (!dt) return;
  const entries = [...(dt.items || [])].filter((it) => it.kind === 'file').map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  const folders = entries.filter((e) => e.isDirectory);
  if (!folders.length) {
    if (dt.files?.length) { event.preventDefault(); addFiles(dt.files); }
    return;
  }
  event.preventDefault();
  if (!canPickFolder()) { toast('手机上暂时不能传文件夹，请选文件', true); return; }
  const loose = entries.filter((e) => e.isFile);
  (async () => {
    for (const dir of folders) await addFolder(dir.name, await readDroppedFolder(dir));
    if (loose.length) addFiles((await Promise.all(loose.map((e) => new Promise((r) => e.file(r, () => r(null)))))).filter(Boolean));
  })().catch((err) => toast(`读不了这个文件夹：${err.message}`, true));
}

/** One folder into the composer: checked, then its files uploaded one at a time; one chip. */
async function addFolder(name, entries) {
  if (state.pendingFiles.length >= FOLDER_LIMITS.items) { toast(`一条消息最多 ${FOLDER_LIMITS.items} 个附件`, true); return null; }
  const plan = planFolder(entries.filter((e) => e.file));
  // Folders the drop never opened (node_modules…) are skipped too.
  for (const e of entries) if (!e.file && !plan.skipped.includes(e.rel)) plan.skipped.push(e.rel);
  if (plan.refuse) { toast(`「${name}」没有添加：${plan.refuse}`, true); return null; }
  const entry = {
    folder: true, name, status: 'uploading', done: 0, total: plan.ok.length, bytes: plan.bytes,
    skipped: plan.skipped, over: plan.over, bad: plan.bad, failed: [],
  };
  state.pendingFiles.push(entry);
  renderAttachStrip();
  try {
    const made = await api('/api/uploads/folder', { method: 'POST', body: { name } });
    Object.assign(entry, { path: made.path, name: made.name || name });
    for (const e of plan.ok) {
      if (entry.cancelled) return entry;
      const res = await fetch('/api/uploads', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': e.file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(e.rel.split('/').pop()), 'x-folder': encodeURIComponent(made.path), 'x-rel-path': encodeURIComponent(e.rel) },
        body: e.file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The folder's own limits are firm; anything else for one file: that file is named, the rest go on.
        if (/^FOLDER_/.test(data?.error?.code || '')) throw new Error(data.error.message);
        entry.failed.push(e.rel);
      } else entry.done += 1;
      renderAttachStrip();
    }
    if (!entry.done) throw new Error('一个文件也没传上');
    entry.status = 'ready';
  } catch (err) {
    Object.assign(entry, { status: 'error', error: err.message });
  }
  renderAttachStrip();
  return entry;
}

/** The chip of a folder waiting in the composer. */
function folderChip(f) {
  const chip = el('div', `att-chip att-chip-folder${f.status === 'uploading' ? ' busy' : ''}${f.status === 'error' ? ' bad' : ''}`);
  chip.appendChild(el('span', 'att-icon', '📁'));
  const label = f.status === 'uploading' ? `${f.name} · 上传中 ${f.done}/${f.total}…`
    : f.status === 'error' ? `${f.name} · 上传失败：${f.error}`
      : `${f.name} · ${f.done} 个文件 · ${fmtBytes(f.bytes)}`;
  chip.appendChild(el('span', 'att-chip-name', label));
  chip.title = label;
  return chip;
}

/** Under the chips, before sending: which files of a folder were left out and why. */
function folderLeftOut(f) {
  const list = (arr) => `${arr.slice(0, 3).join('、')}${arr.length > 3 ? ` 等 ${arr.length} 个` : ''}`;
  const parts = [];
  if (f.skipped?.length) parts.push(`跳过 ${f.skipped.length} 个（${list(f.skipped)}）`);
  if (f.over?.length) parts.push(`超过 25 MB 没传 ${f.over.length} 个（${list(f.over)}）`);
  if (f.bad?.length) parts.push(`名字不能用没传 ${f.bad.length} 个（${list(f.bad)}）`);
  if (f.failed?.length) parts.push(`上传失败 ${f.failed.length} 个（${list(f.failed)}）`);
  if (!parts.length) return null;
  const node = el('div', 'att-note', `「${f.name}」${parts.join('；')}`);
  node.title = [...(f.skipped || []), ...(f.over || []), ...(f.bad || []), ...(f.failed || [])].join('\n');
  return node;
}

/** The "[附件]" line of a folder, as the hub writes it (src/folderupload.mjs folderLines). */
function folderAttachLine(f) {
  return `- ${String(f.path).replace(/\/?$/, '/')}（文件夹，${f.done} 个文件，${fmtBytes(f.bytes)}）`;
}

/** A folder line of the "[附件]" block -> {folder, path, name, count, size, entries:[], more} or null. */
function parseFolderLine(line) {
  const m = /^- (.+?)\/（文件夹，(\d+) 个文件，([^）]+)）$/.exec(String(line).trim());
  return m ? { folder: true, path: m[1], name: m[1].split('/').pop(), count: Number(m[2]), size: m[3], entries: [], more: 0 } : null;
}

/** The folder card in a message: name, how many files, the size; a click shows what is in it. */
function folderCard(file) {
  const card = el('div', 'att-folder');
  const main = el('button', 'att-folder-main');
  main.type = 'button';
  main.setAttribute('aria-expanded', 'false');
  main.appendChild(el('span', 'att-icon', '📁'));
  const meta = el('span', 'att-meta');
  meta.appendChild(el('span', 'att-name', file.name));
  meta.appendChild(el('span', 'att-size', `${file.count} 个文件 · ${file.size}`));
  main.appendChild(meta);
  card.appendChild(main);
  const list = el('div', 'att-folder-list');
  list.hidden = true;
  for (const rel of file.entries) {
    const p = `${file.path}/${rel}`;
    if (/\.(png|jpe?g|gif|webp)$/i.test(rel)) {
      const a = el('a', 'att-folder-item', rel);
      a.href = chatFileUrl(p);
      a.addEventListener('click', (event) => { event.preventDefault(); openLightbox(a.href, rel.split('/').pop()); });
      list.appendChild(a);
    } else list.appendChild(el('span', 'att-folder-item', rel));
  }
  if (file.more) list.appendChild(el('span', 'att-folder-item more', `…还有 ${file.more} 个`));
  if (!remoteChatMachine() && canOpenLocally()) {
    const open = el('button', 'link-btn att-folder-open', '在文件夹中打开');
    open.type = 'button';
    open.addEventListener('click', () => openLocalFile(file.path, false));
    list.appendChild(open);
  }
  card.appendChild(list);
  main.addEventListener('click', () => {
    list.hidden = !list.hidden;
    main.setAttribute('aria-expanded', String(!list.hidden));
  });
  return card;
}

/* --- 「正在传 12/40…」: a hub passing files on to another machine ---------------- */
const uploadWatch = { tag: '', node: null };

/** Before a send to another machine with several files: a line under the message, and the tag it listens for. */
function watchPeerUpload(files, afterRow) {
  const count = files.reduce((n, f) => n + (f.folder ? f.done : 1), 0);
  if (count < 2 || !afterRow) return '';
  uploadWatch.tag = `up-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  uploadWatch.node = el('div', 'status-line upload-progress', `正在传 0/${count}…`);
  afterRow.after(uploadWatch.node);
  return uploadWatch.tag;
}

function onPeerUpload(ev) {
  if (!ev.tag || ev.tag !== uploadWatch.tag || !uploadWatch.node) return;
  uploadWatch.node.textContent = ev.done >= ev.total ? `已传 ${ev.total}/${ev.total}，交给对方…` : `正在传 ${ev.done}/${ev.total}…`;
}

function endPeerUpload() {
  uploadWatch.node?.remove();
  uploadWatch.tag = '';
  uploadWatch.node = null;
}

/** 📎 on a computer: a small menu, 「选文件」 or 「选文件夹」; on a phone the file picker as before. */
function onAttachClick(event) {
  const menu = $('attach-menu');
  if (!menu || !canPickFolder()) { $('attach-input').click(); return; }
  event.stopPropagation();
  toggleMenu(menu, $('attach-btn'));
  if (!menu.hidden) placeAttachMenu(menu);
}

/** 1.5.66: the menu sits right above the 📎, not at the composer's left edge (far away on a wide window). */
function placeAttachMenu(menu) {
  const btn = $('attach-btn');
  const host = menu.offsetParent || menu.parentElement;
  if (!btn || !host) return;
  const b = btn.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const left = Math.max(8, Math.min(b.left - h.left - 4, h.width - menu.offsetWidth - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.bottom = `${Math.round(h.bottom - b.top + 8)}px`;
}
