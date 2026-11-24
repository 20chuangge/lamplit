// 1.5.64: folder upload. A folder picked (📎 → 「选文件夹」) or dropped on the chat keeps its layout under
// uploads/<day>/<folder>/…, goes as one attachment item and is drawn as one folder card; the bot's text gets its
// path and a short list. Skipped names, limits (25 MB a file, 200 files / 500 MB a folder), unsafe names refused,
// clashes get a suffix and nothing is overwritten. To another machine each file goes over the hub's pass-on keeping
// the layout, with 「正在传 12/40…」; an older Lamplit there gets the files flat with a note. 20 attachments a message.
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const day = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f6a1b40000000049454e44ae426082', 'hex');

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src.replace(/\r\n/g, '\n'));
  return m ? m[0] : '';
}
/** A top-level const of a page part, as source (one statement). */
function constSource(src, name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(src.replace(/\r\n/g, '\n'));
  return m ? m[0] : '';
}

// --- the rules: names, skip list, the hub's own checks -----------------------------------------------
export async function folderRuleChecks({ check, readText }) {
  const F = await import('../src/folderupload.mjs');
  const refused = ['../escape.txt', 'a/../../x.txt', '/etc/passwd', 'C:/Windows/x.txt', 'c:x', 'a\\..\\..\\x.txt', 'CON', 'sub/aux.txt', 'nul.tar.gz', 'COM1', 'lpt9.log', 'a/ b', 'trailing.', 'sp ', '', 'a//b', './a', 'a/./b', 'x\u0000y', 'bad:name', 'q?.txt'];
  const outcome = refused.map((r) => { try { F.checkRelPath(r); return `${JSON.stringify(r)} accepted`; } catch (err) { return err.code === 'BAD_PATH' && err.status === 400 ? '' : `${JSON.stringify(r)} ${err.code}`; } }).filter(Boolean);
  const fine = ['素材/封面.png', 'a/b/c/d.md', '01 开场.mp4', 'console.txt', 'nullable/x', '.env.example', 'COM10.txt'].map((r) => { try { return F.checkRelPath(r) === r ? '' : r; } catch { return r; } }).filter(Boolean);
  check('FOLD-1a a path inside an uploaded folder: "..", absolute paths, drive letters, backslashes, names Windows keeps (CON, aux.txt, COM1…), empty parts, trailing dots / spaces and forbidden characters are refused; ordinary names, Chinese too, pass unchanged',
    outcome.length === 0 && fine.length === 0, JSON.stringify({ outcome, fine }));

  const skips = { '.git/HEAD': '.git/', 'src/.git/objects/ab': 'src/.git/', 'node_modules/x/index.js': 'node_modules/', 'a/node_modules/b.js': 'a/node_modules/', '.DS_Store': '.DS_Store', 'pics/Thumbs.db': 'pics/Thumbs.db', 'desktop.ini': 'desktop.ini', 'sub/Desktop.INI': 'sub/Desktop.INI', '._a.png': '._a.png', '~$报告.docx': '~$报告.docx', '$RECYCLE.BIN/x': '$RECYCLE.BIN/' };
  const keeps = ['素材/a.png', '.github/workflows/ci.yml', 'git/notes.md', 'node_modules.txt', 'Thumbs.db.bak', 'a.git'];
  const page = await readText('../public/app/main/05b-folder.js');
  // eslint-disable-next-line no-new-func
  const pageRules = new Function(`${constSource(page, 'FOLDER_LIMITS')}${constSource(page, 'FOLDER_SKIP_DIRS')}${constSource(page, 'FOLDER_SKIP_FILES')}${constSource(page, 'FOLDER_RESERVED')}
    const fmtBytes = (n) => String(n);
    ${fnSource(page, 'folderSkipped')}${fnSource(page, 'folderBadPath')}${fnSource(page, 'planFolder')}
    return { folderSkipped, folderBadPath, planFolder, FOLDER_LIMITS };`)();
  const wrongPage = Object.entries(skips).filter(([rel, want]) => pageRules.folderSkipped(rel) !== want).map(([r]) => r).concat(keeps.filter((r) => pageRules.folderSkipped(r)));
  const wrongHub = Object.keys(skips).filter((rel) => !F.skippedPart(rel)).concat(keeps.filter((r) => F.skippedPart(r)));
  const pageBad = refused.filter((r) => r && !pageRules.folderBadPath(r)).concat(['素材/封面.png', 'console.txt'].filter((r) => pageRules.folderBadPath(r)));
  check('FOLD-1b the skip list, on the page and on the hub alike: .git, node_modules (named once, as a folder), .DS_Store, Thumbs.db, desktop.ini, ._ files, Office ~$ lock files, $RECYCLE.BIN; look-alikes (.github, node_modules.txt, Thumbs.db.bak) are kept; the page refuses the same unsafe names the hub does',
    wrongPage.length === 0 && wrongHub.length === 0 && pageBad.length === 0, JSON.stringify({ wrongPage, wrongHub, pageBad }));

  // The page's plan of a folder: skipped, too big, bad names, and the folder limits (refused whole, with why).
  const MB = 1024 * 1024;
  const f = (rel, size = 10) => ({ rel, file: { size } });
  const plan = pageRules.planFolder([f('b.txt'), f('a/封面.png'), f('.git/HEAD'), f('.git/config'), f('node_modules/x/y.js'), f('Thumbs.db'), f('big.mp4', 26 * MB), f('ok.mp4', 25 * MB), f('aux.txt')]);
  const many = pageRules.planFolder(Array.from({ length: 201 }, (_, i) => f(`f${i}.txt`)));
  const atLimit = pageRules.planFolder(Array.from({ length: 200 }, (_, i) => f(`f${i}.txt`)));
  const heavy = pageRules.planFolder(Array.from({ length: 21 }, (_, i) => f(`v${i}.mp4`, 24 * MB)));
  const onlySkipped = pageRules.planFolder([f('.DS_Store'), f('.git/HEAD')]);
  check('FOLD-1c before sending, a folder\'s plan names what is skipped (each folder once), what is over 25 MB and what has a name that cannot be stored; 25 MB itself goes; 201 files or over 500 MB refuse the whole folder with a reason; 200 files go; nothing left to send refuses',
    JSON.stringify(plan.ok.map((e) => e.rel)) === JSON.stringify(['a/封面.png', 'b.txt', 'ok.mp4'])
    && JSON.stringify(plan.skipped) === JSON.stringify(['.git/', 'Thumbs.db', 'node_modules/']) && JSON.stringify(plan.over) === JSON.stringify(['big.mp4']) && JSON.stringify(plan.bad) === JSON.stringify(['aux.txt']) && !plan.refuse
    && /最多 200 个/.test(many.refuse) && !atLimit.refuse && /最多 500 MB/.test(heavy.refuse) && /没有能传的文件/.test(onlySkipped.refuse)
    && F.FOLDER_MAX_FILES === 200 && F.FOLDER_MAX_BYTES === 500 * MB && F.FILE_MAX_BYTES === 25 * MB && pageRules.FOLDER_LIMITS.files === 200 && pageRules.FOLDER_LIMITS.bytes === 500 * MB && pageRules.FOLDER_LIMITS.items === 20,
    JSON.stringify({ plan, many: many.refuse, heavy: heavy.refuse }));

  check('FOLD-1d a folder\'s own name is made safe, never refused: separators and forbidden characters become _, a reserved name gets a _ in front, "." / ".." / empty become "folder"',
    F.safeFolderName('视频') === '视频' && F.safeFolderName('a/b\\c') === 'a_b_c' && F.safeFolderName('CON') === '_CON' && F.safeFolderName('..') === 'folder' && F.safeFolderName('') === 'folder' && F.safeFolderName('名字. ') === '名字'
    && F.isFolderUploadPath('uploads/2026-11-23/视频') && !F.isFolderUploadPath('uploads/2026-11-23') && !F.isFolderUploadPath('uploads/2026-11-23/视频/素材') && !F.isFolderUploadPath('uploads/2026-11-23/..') && !F.isFolderUploadPath('config'));
}

// --- the hub: a folder upload here --------------------------------------------------------------------
export async function folderHubChecks({ check, api, base, rawFetch }) {
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  const key = fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'local-key'), 'utf8').trim();
  const put = async (folder, rel, body, extra = {}) => {
    const res = await rawFetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-lamplit-local': key, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(rel.split('/').pop()), ...(folder !== null ? { 'x-folder': encodeURIComponent(folder) } : {}), 'x-rel-path': encodeURIComponent(rel), ...extra }, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };

  // A folder: made, then a nested layout.
  const made = await api('/api/uploads/folder', { method: 'POST', body: { name: '发布视频' } });
  const F = made.json?.path || '';
  const files = { '01-开场.txt': '开场', '素材/封面.png': PNG, '素材/字幕/中文.srt': '1\n00:00:01 --> 00:00:02\n你好', 'b/c/d/深.md': '# 深' };
  const ups = [];
  for (const [rel, body] of Object.entries(files)) ups.push(await put(F, rel, body));
  const onDisk = Object.entries(files).every(([rel, body]) => { try { return fs.readFileSync(path.join(ws, F, ...rel.split('/'))).equals(Buffer.from(body)); } catch { return false; } });
  check('FOLD-2a a folder upload keeps its layout under uploads/<day>/<folder>/: nested files land where they were, byte for byte, and each answer names its path there',
    made.status === 200 && F === `uploads/${day()}/发布视频` && ups.every((u) => u.status === 200) && onDisk
    && ups[1].json?.path === `${F}/素材/封面.png` && ups[1].json?.mime === 'image/png' && ups[2].json?.path === `${F}/素材/字幕/中文.srt`, JSON.stringify({ made: made.json, ups: ups.map((u) => u.json?.path || u.json) }));

  // Name clashes: the folder name used again today, a file of that name, the same file twice. Nothing overwritten.
  const again = await api('/api/uploads/folder', { method: 'POST', body: { name: '发布视频' } });
  const third = await api('/api/uploads/folder', { method: 'POST', body: { name: '发布视频' } });
  const flat = await rawFetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-lamplit-local': key, 'x-file-name': encodeURIComponent('同名') }, body: 'a file' }).then((r) => r.json());
  const overFile = await api('/api/uploads/folder', { method: 'POST', body: { name: '同名' } });
  const twice = await put(F, '01-开场.txt', '第二份');
  const both = [await api('/api/uploads/folder', { method: 'POST', body: { name: '并发' } }), await api('/api/uploads/folder', { method: 'POST', body: { name: '并发' } })];
  const parallel = await Promise.all([1, 2, 3].map(() => api('/api/uploads/folder', { method: 'POST', body: { name: '同时' } })));
  const firstKept = fs.readFileSync(path.join(ws, F, '01-开场.txt'), 'utf8') === '开场';
  check('FOLD-2b clashes get a suffix and never overwrite: the same folder name today -> 发布视频-1, -2; a name a file already has -> 同名-1; the same file twice in a folder -> 01-开场-1.txt (the first unchanged); three at once each get their own folder',
    again.json?.path === `uploads/${day()}/发布视频-1` && third.json?.path === `uploads/${day()}/发布视频-2` && flat.path === `uploads/${day()}/同名` && overFile.json?.path === `uploads/${day()}/同名-1`
    && twice.status === 200 && twice.json?.path === `${F}/01-开场-1.txt` && firstKept && both[0].json?.path !== both[1].json?.path
    && new Set(parallel.map((p) => p.json?.path)).size === 3 && parallel.every((p) => p.status === 200),
    JSON.stringify({ again: again.json, third: third.json, overFile: overFile.json, twice: twice.json, parallel: parallel.map((p) => p.json?.path) }));

  // Unsafe: a path that leads out, absolute, reserved names; a folder that is not one made for an upload.
  const evil = ['../逃出.txt', '../../config/evil.json', '/abs.txt', 'C:/x.txt', 'a\\..\\..\\x.txt', 'CON', 'sub/aux.txt', 'x/../../y.txt', ''];
  const evilRes = [];
  for (const rel of evil) evilRes.push((await put(F, rel, 'evil')).status);
  const badFolders = [];
  for (const folder of ['uploads/../config', 'config', `uploads/${day()}`, `${F}/素材`, `uploads/${day()}/没有这个`, 'uploads/2026-11-23/../../data']) badFolders.push((await put(folder, 'x.txt', 'evil')).json?.error?.code || 'accepted');
  const noFolder = await put(null, 'x.txt', 'evil');
  const leaked = fs.existsSync(path.join(ws, 'uploads', day(), '逃出.txt')) || fs.existsSync(path.join(ws, '逃出.txt')) || fs.existsSync(path.join(ws, 'abs.txt'));
  check('FOLD-2c unsafe paths are refused (400 BAD_PATH) and nothing is written: "..", absolute, drive letters, backslashes, CON / aux.txt; x-folder must be a folder made by POST /api/uploads/folder (not a day, a subfolder, a missing one, or outside)',
    evilRes.every((s) => s === 400) && badFolders.every((c) => c === 'BAD_FOLDER') && noFolder.status === 400 && !leaked, JSON.stringify({ evilRes, badFolders, noFolder: noFolder.status }));

  // A folder's limits: 200 files, 500 MB (checked from what is there).
  const full = await api('/api/uploads/folder', { method: 'POST', body: { name: '满的' } });
  const fullAbs = path.join(ws, full.json.path);
  for (let i = 0; i < 200; i += 1) fs.writeFileSync(path.join(fullAbs, `f${i}.txt`), 'x');
  const overCount = await put(full.json.path, 'one-more.txt', 'x');
  const heavy = await api('/api/uploads/folder', { method: 'POST', body: { name: '重的' } });
  const heavyAbs = path.join(ws, heavy.json.path);
  const fd = fs.openSync(path.join(heavyAbs, 'big.bin'), 'w');
  fs.ftruncateSync(fd, 500 * 1024 * 1024 - 10);
  fs.closeSync(fd);
  const overBytes = await put(heavy.json.path, 'small.txt', Buffer.alloc(20));
  const fits = await put(heavy.json.path, 'tiny.txt', Buffer.alloc(5));
  fs.rmSync(heavyAbs, { recursive: true, force: true });
  const bigFile = await put(F, 'huge.bin', Buffer.alloc(25 * 1024 * 1024 + 1));
  check('FOLD-2d limits on the hub: a 201st file is refused (FOLDER_TOO_MANY_FILES), going over 500 MB is refused (FOLDER_TOO_LARGE) while what still fits goes, and one file over 25 MB is refused as before',
    overCount.json?.error?.code === 'FOLDER_TOO_MANY_FILES' && overBytes.json?.error?.code === 'FOLDER_TOO_LARGE' && fits.status === 200 && bigFile.json?.error?.code === 'UPLOAD_TOO_LARGE',
    JSON.stringify({ overCount: overCount.json, overBytes: overBytes.json, fits: fits.status, bigFile: bigFile.status }));

  // In a message: one item, its path and a short list for the bot; images hinted at image_view.
  const many = await api('/api/uploads/folder', { method: 'POST', body: { name: '四十个' } });
  for (let i = 0; i < 40; i += 1) await put(many.json.path, `章节/${String(i).padStart(2, '0')}.txt`, `第 ${i} 章`);
  const sent = await api('/api/bots/chief/message', { method: 'POST', body: { text: '看看这两个文件夹', attachments: [{ path: F }, { path: `${many.json.path}/` }] } });
  let userText = '';
  for (let i = 0; i < 50 && !userText; i += 1) {
    const items = (await api('/api/bots/chief/messages?limit=20')).json || [];
    userText = [...items].reverse().find((m) => m.role === 'user' && String(m.text || '').startsWith('看看这两个文件夹'))?.text || '';
    if (!userText) await sleep(100);
  }
  const lines = userText.split('\n');
  const head = lines.find((l) => l.startsWith(`- ${F}/（文件夹，`));
  const head40 = lines.find((l) => l.startsWith(`- ${many.json.path}/（文件夹，40 个文件，`));
  const tree = lines.filter((l) => l.startsWith('  · 章节/'));
  check('FOLD-2e a folder is one attachment in the message: the bot reads its path, how many files and the size, then a short list (30 entries, 「…还有 10 个」), not one line per file; a picture inside brings the image_view hint',
    sent.status === 200 && Boolean(head) && /（文件夹，5 个文件，[\d.]+ (KB|MB)）$/.test(head) && lines.includes('  · 素材/封面.png') && Boolean(head40) && tree.length === 30 && lines.includes('  …还有 10 个')
    && userText.includes('[附件] 都在共享工作区里：') && userText.includes('image_view'),
    JSON.stringify({ status: sent.status, err: sent.json?.error, head, head40, tree: tree.length }).slice(0, 600));

  // Images inside stay reachable: the workspace file route and image_view's path both take the nested path.
  const img = await rawFetch(`${base}/api/workspace/file?path=${encodeURIComponent(`${F}/素材/封面.png`)}`, { headers: { 'x-lamplit-local': key } });
  const imgBytes = Buffer.from(await img.arrayBuffer());
  const tools = await fsp.readFile(path.join(REPO, 'src', 'tools.mjs'), 'utf8');
  check('FOLD-2f a picture inside an uploaded folder is reachable by its nested path (shown inline, the same bytes) - the path image_view takes (any workspace path)',
    img.status === 200 && /image\/png/.test(img.headers.get('content-type') || '') && imgBytes.equals(PNG) && /image_view/.test(tools), String(img.status));

  // 20 attachments a message (was 10); a folder is one; 21 is refused; only uploads.
  const twenty = [];
  for (let i = 0; i < 20; i += 1) twenty.push((await rawFetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-lamplit-local': key, 'x-file-name': encodeURIComponent(`n${i}.txt`) }, body: `n${i}` }).then((r) => r.json())).path);
  const ok20 = await api('/api/bots/chief/message', { method: 'POST', body: { text: '二十个', attachments: twenty.map((p) => ({ path: p })) } });
  const ok19f = await api('/api/bots/chief/message', { method: 'POST', body: { text: '十九个加一个文件夹', attachments: [...twenty.slice(0, 19).map((p) => ({ path: p })), { path: F }] } });
  const no21 = await api('/api/bots/chief/message', { method: 'POST', body: { text: '二十一个', attachments: [...twenty.map((p) => ({ path: p })), { path: F }] } });
  const notUpload = await api('/api/bots/chief/message', { method: 'POST', body: { text: 'x', attachments: [{ path: `uploads/${day()}` }] } });
  const sub = await api('/api/bots/chief/message', { method: 'POST', body: { text: 'x', attachments: [{ path: `${F}/素材` }] } });
  const empty = await api('/api/uploads/folder', { method: 'POST', body: { name: '空的' } });
  const emptyMsg = await api('/api/bots/chief/message', { method: 'POST', body: { text: 'x', attachments: [{ path: empty.json.path }] } });
  check('FOLD-2g 20 attachments in one message (was 10), a folder counting as one; a 21st is refused (TOO_MANY_ATTACHMENTS); a day folder, a subfolder or an empty folder is no attachment',
    ok20.status === 200 && ok19f.status === 200 && no21.status === 400 && no21.json?.error?.code === 'TOO_MANY_ATTACHMENTS' && notUpload.status === 400 && sub.status === 400 && emptyMsg.status === 400,
    JSON.stringify({ ok20: ok20.status, ok19f: ok19f.status, no21: no21.json?.error, notUpload: notUpload.status, sub: sub.status, empty: emptyMsg.status }));
  await sleep(300);
}

// --- another machine: the layout kept there, progress, an older Lamplit -------------------------------
export async function folderPeerChecks({ check, api, base, rawFetch, startServerChild, stopProcess, seedHome }) {
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-folder-'));
  await seedHome(otherHome);
  let other = null;
  const M = '剪辑电脑';
  const enc = encodeURIComponent(M);
  const ws = process.env.ASSIST_WORKSPACE_DIR;
  const key = fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'local-key'), 'utf8').trim();
  let stream = null;
  try {
    other = await startServerChild(otherHome, { ASSIST_DATA_DIR: path.join(otherHome, 'data'), ASSIST_WORKSPACE_DIR: path.join(otherHome, 'workspace') });
    const B = other.url;
    const bKey = fs.readFileSync(path.join(otherHome, 'data', 'local-key'), 'utf8').trim();
    const bToken = JSON.parse(fs.readFileSync(path.join(otherHome, 'data', 'security.json'), 'utf8')).token;
    const bGet = async (p) => (await rawFetch(`${B}${p}`, { headers: { 'x-lamplit-local': bKey } })).json();
    await api('/api/peers', { method: 'PUT', body: { peers: [{ name: M, url: B, token: bToken }] } });

    // A folder here, 12 files in three levels, and a loose picture.
    const made = (await api('/api/uploads/folder', { method: 'POST', body: { name: '上线视频' } })).json;
    const files = {};
    for (let i = 0; i < 10; i += 1) files[`片段/${String(i).padStart(2, '0')}.txt`] = `片段 ${i}`;
    files['封面/封面.png'] = PNG;
    files['说明/最终/说明.md'] = '# 说明';
    for (const [rel, body] of Object.entries(files)) {
      await rawFetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-lamplit-local': key, 'x-folder': encodeURIComponent(made.path), 'x-rel-path': encodeURIComponent(rel), 'x-file-name': encodeURIComponent(rel.split('/').pop()) }, body });
    }
    const loose = await rawFetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-lamplit-local': key, 'x-file-name': encodeURIComponent('另一张.png') }, body: PNG }).then((r) => r.json());

    // Listen to this hub's events for the progress of this send (the page does the same).
    const events = [];
    const ctl = new AbortController();
    stream = ctl;
    const res = await rawFetch(`${base}/api/stream`, { headers: { 'x-lamplit-local': key, accept: 'text/event-stream' }, signal: ctl.signal });
    (async () => {
      const reader = res.body.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += Buffer.from(value).toString('utf8');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (data) { try { events.push(JSON.parse(data.slice(6))); } catch { /* not json */ } }
        }
      }
    })();
    await sleep(200);
    const sent = await api(`/api/peers/${enc}/bots/chief/message`, { method: 'POST', body: { text: '把这些剪成一条', attachments: [{ path: made.path }, { path: loose.path }], uploadTag: 'up-smoke-1' } });
    let userText = '';
    for (let i = 0; i < 50 && !userText; i += 1) {
      const items = await bGet('/api/bots/chief/messages?limit=20');
      userText = [...(items || [])].reverse().find((m) => m.role === 'user' && String(m.text || '').startsWith('把这些剪成一条'))?.text || '';
      if (!userText) await sleep(100);
    }
    const there = `uploads/${day()}/上线视频`;
    const bWs = path.join(otherHome, 'workspace');
    const sameThere = Object.entries(files).every(([rel, body]) => { try { return fs.readFileSync(path.join(bWs, there, ...rel.split('/'))).equals(Buffer.from(body)); } catch { return false; } });
    check('FOLD-3a to a bot on another machine (全部机器): the folder goes file by file over the hub\'s pass-on and keeps its layout there, byte for byte; the message there carries it as one folder item next to the loose picture',
      sent.status === 200 && sameThere && userText.includes(`- ${there}/（文件夹，12 个文件，`) && userText.includes('  · 说明/最终/说明.md') && /- uploads\/\d{4}-\d{2}-\d{2}\/另一张\.png（图片，/.test(userText),
      JSON.stringify({ status: sent.status, err: sent.json?.error, sameThere, userText: userText.slice(0, 400) }));

    const progress = events.filter((e) => e.type === 'peer.upload' && e.tag === 'up-smoke-1');
    const last = progress[progress.length - 1];
    check('FOLD-3b progress while it goes (for 「正在传 12/40…」): peer.upload events with this send\'s tag, counting up to 13/13 (12 in the folder and the picture), never more than about one a second plus the last; other sends do not hear them',
      progress.length >= 2 && progress[0].done === 0 && last?.done === 13 && last?.total === 13 && progress.every((e, i) => i === 0 || e.done >= progress[i - 1].done) && progress.length <= 15 && last.machine === M,
      JSON.stringify(progress.map((e) => `${e.done}/${e.total}`)));

    // A group on that machine: the same.
    const g = await rawFetch(`${B}/api/groups`, { method: 'POST', headers: { 'x-lamplit-local': bKey, 'content-type': 'application/json' }, body: JSON.stringify({ name: '剪辑组', members: ['chief', 'researcher'] }) }).then((r) => r.json()).catch(() => null);
    const gid = g?.group?.id || g?.id || '';
    const toGroup = gid ? await api(`/api/peers/${enc}/groups/${encodeURIComponent(gid)}/message`, { method: 'POST', body: { text: '群里也看看', attachments: [{ path: made.path }], uploadTag: 'up-smoke-2' } }) : { status: 0 };
    check('FOLD-3c to a group on another machine: the folder lands there again under a new name (上线视频-1, the first one untouched) and the group gets it as one item',
      toGroup.status === 200 && fs.existsSync(path.join(bWs, `${there}-1`, '说明', '最终', '说明.md')) && fs.readFileSync(path.join(bWs, there, '片段', '00.txt'), 'utf8') === '片段 0',
      JSON.stringify({ gid, status: toGroup.status, err: toGroup.json?.error }));
  } finally {
    stream?.abort();
    await api('/api/peers', { method: 'PUT', body: { peers: [] } }).catch(() => {});
    if (other) await stopProcess(other.child).catch(() => {});
    fs.rmSync(otherHome, { recursive: true, force: true });
  }
  void ws;
}

/** An older Lamplit (no folder uploads, 10 attachments a message), played by a fake peer link. */
export async function folderOldPeerChecks({ check }) {
  const { createRoster } = await import('../src/roster.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-oldpeer-'));
  const mk = ({ old }) => {
    const seen = { uploads: [], messages: [], events: [] };
    let n = 0;
    const peer = { name: '旧电脑', url: 'http://127.0.0.1:9', token: 't' };
    const peers = {
      find: () => peer,
      json: async (_p, method, p, opts = {}) => {
        if (p === '/api/uploads/folder') {
          if (old) throw Object.assign(new Error('no route'), { code: 'NOT_FOUND' });
          return { path: `uploads/2026-11-23/${opts.body.name}`, name: opts.body.name };
        }
        if (p === '/api/uploads') {
          const h = opts.headers || {};
          const name = decodeURIComponent(h['x-file-name']);
          seen.uploads.push({ name, folder: h['x-folder'] ? decodeURIComponent(h['x-folder']) : '', rel: h['x-rel-path'] ? decodeURIComponent(h['x-rel-path']) : '', timeoutMs: opts.timeoutMs });
          n += 1;
          if (!old && h['x-folder']) return { path: `${decodeURIComponent(h['x-folder'])}/${decodeURIComponent(h['x-rel-path'])}` };
          return { path: `uploads/2026-11-23/${name.replace(/(\.\w+)$/, `-${n}$1`)}` };
        }
        if (/\/message$/.test(p)) {
          if (old && (opts.body.attachments || []).length > 10) throw Object.assign(new Error('at most 10 attachments per message'), { code: 'TOO_MANY_ATTACHMENTS' });
          seen.messages.push(opts.body);
          return { turnId: 't1' };
        }
        throw new Error(`unexpected ${method} ${p}`);
      },
      async load() {},
    };
    const folderFiles = Array.from({ length: 35 }, (_, i) => ({ rel: `${i < 3 ? 'a/' : 'b/'}${i}.txt`, size: 3 }));
    const roster = createRoster({
      peers,
      bus: { emit: (e) => seen.events.push(e) },
      cacheFile: path.join(tmp, `c-${old}.json`),
      outboxFile: path.join(tmp, `o-${old}.json`),
      readUpload: async (rel) => ({ bytes: Buffer.from('abc'), name: rel.split('/').pop() }),
      listUpload: async (rel) => (rel.endsWith('/素材') ? { name: '素材', files: folderFiles } : null),
    });
    return { roster, seen, peer };
  };

  // Today's Lamplit there: the layout header goes with each file.
  const fresh = mk({ old: false });
  await fresh.roster.send(fresh.peer, 'chief', { text: '看看', attachments: [{ path: 'uploads/2026-11-23/素材' }], tag: 'up-x' });
  const msg = fresh.seen.messages[0];
  check('FOLD-4a the pass-on asks that machine for a folder first, then sends every file with x-folder / x-rel-path (its layout), each with the 120 s timeout; the message carries one folder item',
    fresh.seen.uploads.length === 35 && fresh.seen.uploads.every((u) => u.folder === 'uploads/2026-11-23/素材' && u.rel && u.timeoutMs === 120000) && fresh.seen.uploads[0].rel === 'a/0.txt'
    && JSON.stringify(msg?.attachments) === JSON.stringify([{ path: 'uploads/2026-11-23/素材' }]) && msg.text === '看看', JSON.stringify({ n: fresh.seen.uploads.length, msg }));

  // An older Lamplit: flat files, named in a note; the message still goes.
  const old = mk({ old: true });
  await old.roster.send(old.peer, 'chief', { text: '看看', attachments: [{ path: 'uploads/2026-11-23/素材' }, { path: 'uploads/2026-11-23/x.txt' }], tag: 'up-y' });
  const omsg = old.seen.messages[0];
  check('FOLD-4b an older Lamplit there (no folder uploads, 404): the files go flat into its uploads, and the text says so - which version, how many, where each went and what it was (30 lines, then 「…还有 5 个」); the loose file is still an attachment',
    old.seen.uploads.length === 36 && old.seen.uploads.every((u) => !u.folder && !u.rel) && /版本较旧，不能保留文件夹结构，35 个文件平放在共享工作区里/.test(omsg?.text || '')
    && (omsg.text.match(/（原来是 素材\//g) || []).length === 30 && /…还有 5 个，也在 uploads\/2026-11-23\/ 里/.test(omsg.text) && omsg.text.startsWith('看看\n\n（文件夹「素材」')
    && (omsg.attachments || []).length === 1, JSON.stringify({ uploads: old.seen.uploads.length, text: (omsg?.text || '').slice(0, 300), att: omsg?.attachments }));

  // An older Lamplit and 20 loose files: 10 as attachments, the rest named in the text.
  const old2 = mk({ old: true });
  await old2.roster.send(old2.peer, 'chief', { text: '二十个', attachments: Array.from({ length: 20 }, (_, i) => ({ path: `uploads/2026-11-23/f${i}.txt` })) });
  const m2 = old2.seen.messages[0];
  check('FOLD-4c an older Lamplit takes 10 attachments: 20 files still arrive - 10 as attachments, the other 10 named in the text with a note',
    (m2?.attachments || []).length === 10 && /一条消息最多收 10 个附件；另外 10 个也已传到共享工作区/.test(m2?.text || '') && (m2.text.match(/\n- uploads\//g) || []).length === 10, JSON.stringify({ att: m2?.attachments?.length, text: (m2?.text || '').slice(0, 200) }));

  const ev = fresh.seen.events.filter((e) => e.type === 'peer.upload');
  check('FOLD-4d progress for a big folder is a line a second or so, not one per file: it starts at 0, ends at 35/35 with this send\'s tag, and a single file sends none',
    ev.length >= 2 && ev.length < 10 && ev[0].done === 0 && ev[ev.length - 1].done === 35 && ev.every((e) => e.tag === 'up-x' && e.total === 35)
    && old2.seen.events.some((e) => e.done === 20) && mk({ old: false }).seen.events.length === 0, JSON.stringify(ev.map((e) => e.done)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- the page: the picker, the drop, the chip, the card, 20 a message --------------------------------
export async function folderPageChecks({ check, readText }) {
  const html = await readText('../public/index.html');
  const part = await readText('../public/app/main/05b-folder.js');
  const chat = await readText('../public/app/main/05-chat.js');
  const live = await readText('../public/app/main/06-live.js');
  const wiring = await readText('../public/app/main/12-wiring.js');
  check('FOLD-5a 📎 on a computer opens 「选文件」 / 「选文件夹」 (a webkitdirectory input); on a phone it opens the file picker as before (no folder picking in the Android app or a phone browser)',
    /<input type="file" id="attach-folder-input" webkitdirectory multiple hidden \/>/.test(html) && /id="attach-pick-files">[\s\S]*?<span class="am-title">选文件<\/span>[\s\S]*?<\/button>/.test(html) && /id="attach-pick-folder">[\s\S]*?<span class="am-title">选文件夹<\/span>[\s\S]*?<\/button>/.test(html)
    && /function placeAttachMenu\(menu\)/.test(part) && part.includes('if (!menu.hidden) placeAttachMenu(menu);')
    && wiring.includes("$('attach-btn').addEventListener('click', onAttachClick);") && /if \(!menu \|\| !canPickFolder\(\)\) \{ \$\('attach-input'\)\.click\(\); return; \}/.test(part)
    && /window\.Capacitor \|\| \/Android\|iPhone\|iPad\|Mobile\/i/.test(part));

  // canPickFolder: a phone's user agent or the app says no.
  const probe = (ua, cap) => {
    // eslint-disable-next-line no-new-func
    return new Function('window', 'navigator', 'document', `${fnSource(part, 'canPickFolder')}return canPickFolder();`)(
      { Capacitor: cap, matchMedia: () => ({ matches: false }) }, { userAgent: ua }, { createElement: () => ({ webkitdirectory: false }) });
  };
  check('FOLD-5b folder picking is offered on a desktop browser and the desktop app, not on Android (app or browser) or an iPhone',
    probe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Electron/33', undefined) === true && probe('Mozilla/5.0 (Linux; Android 14) Mobile', undefined) === false
    && probe('Mozilla/5.0 (Windows NT 10.0)', {}) === false && probe('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', undefined) === false);

  check('FOLD-5c a folder dropped on the chat is read through dataTransfer.items (webkitGetAsEntry, every readEntries batch, recursively); plain files still go through dataTransfer.files',
    wiring.includes('onChatDrop(event);') && /webkitGetAsEntry/.test(part) && /readEntries\(\(batch\) => \{ if \(!batch\.length\) resolve\(all\); else \{ all\.push\(\.\.\.batch\); next\(\); \} \}/.test(part)
    && /if \(dt\.files\?\.length\) \{ event\.preventDefault\(\); addFiles\(dt\.files\); \}/.test(part) && /await walk\(entry, rel\)/.test(part));

  check('FOLD-5d at most 20 attachments a message (was 10) on the page too, a folder counting once; the message 「一条消息最多 20 个附件」 and its English',
    /if \(state\.pendingFiles\.length >= FOLDER_LIMITS\.items\) \{ toast\(`一条消息最多 \$\{FOLDER_LIMITS\.items\} 个附件`, true\); break; \}/.test(chat) && !/slice\(0, 10\)/.test(chat.slice(chat.indexOf('async function addFiles'), chat.indexOf('async function addFiles') + 400))
    && (await readText('../public/i18n-en.js')).includes('"一条消息最多 {0} 个附件": "At most {0} attachments per message"'));

  // The "[附件]" block as the hub writes it -> one folder card with its list; a file line still a file.
  const F = await import('../src/folderupload.mjs');
  const files = Array.from({ length: 33 }, (_, i) => ({ rel: i === 0 ? '素材/封面.png' : `片段/${i}.txt`, size: 1000 }));
  const text = `看看\n\n[附件] 都在共享工作区里：\n${F.folderLines('uploads/2026-11-23/视频', files).join('\n')}\n- uploads/2026-11-23/a.png（图片，1 KB）\n（图片的内容要用 image_view 工具看。）`;
  // eslint-disable-next-line no-new-func
  const parse = new Function(`${constSource(part, 'ATTACH_MARK')}${fnSource(part, 'parseFolderLine')}${fnSource(part, 'splitAttachments')}return splitAttachments;`)();
  const out = parse(text);
  const folder = out.files[0];
  check('FOLD-5e the page reads the hub\'s folder lines back as one folder item (path, name, 33 files, size, the 30 listed, 「…还有 3 个」) and a file line after it as a file, as before',
    out.text === '看看' && out.files.length === 2 && folder.folder && folder.path === 'uploads/2026-11-23/视频' && folder.name === '视频' && folder.count === 33 && folder.size === '32 KB'
    && folder.entries.length === 30 && folder.entries[0] === '素材/封面.png' && folder.more === 3 && out.files[1].image && out.files[1].path === 'uploads/2026-11-23/a.png',
    JSON.stringify({ text: out.text, folder: { ...folder, entries: folder?.entries?.length }, second: out.files[1] }));

  // The card: name, N 个文件 · size; the list behind a click; pictures open in the viewer; 在文件夹中打开 on this computer.
  const made = [];
  const node = (tag, cls = '', txt = '') => {
    const n = { tag, className: cls, textContent: txt, children: [], hidden: false, attrs: {}, listeners: {}, href: '' };
    n.appendChild = (c) => { n.children.push(c); return c; };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    n.addEventListener = (k, fn) => { n.listeners[k] = fn; };
    made.push(n);
    return n;
  };
  // eslint-disable-next-line no-new-func
  const card = new Function('el', 'chatFileUrl', 'openLightbox', 'remoteChatMachine', 'canOpenLocally', 'openLocalFile', `${fnSource(part, 'folderCard')}return folderCard;`)(
    node, (p) => `/api/workspace/file?path=${encodeURIComponent(p)}`, () => {}, () => '', () => true, () => {})({ ...folder, entries: ['素材/封面.png', '片段/1.txt'], more: 31 });
  const texts = made.map((n) => n.textContent);
  const list = made.find((n) => n.className === 'att-folder-list');
  const main = made.find((n) => n.className === 'att-folder-main');
  main.listeners.click();
  check('FOLD-5f the folder card in the message: 📁, the folder name, 「33 个文件 · 32 KB」; a click shows the list (a picture inside opens in the viewer), 「…还有 31 个」, and 「在文件夹中打开」 on this computer',
    card.className === 'att-folder' && texts.includes('📁') && texts.includes('视频') && texts.includes('33 个文件 · 32 KB') && texts.includes('…还有 31 个') && texts.includes('在文件夹中打开')
    && made.some((n) => n.tag === 'a' && n.textContent === '素材/封面.png' && /%E7%B4%A0%E6%9D%90%2F/.test(n.href)) && list.hidden === false && main.attrs['aria-expanded'] === 'true',
    JSON.stringify(texts));

  check('FOLD-5g while a folder goes up it is one chip 「名字 · 上传中 3/15…」, then 「名字 · 15 个文件 · 320 MB」; under the chips, before sending, what was skipped, over 25 MB, not storable or failed; ✕ stops it',
    part.includes('`${f.name} · 上传中 ${f.done}/${f.total}…`') && part.includes('`${f.name} · ${f.done} 个文件 · ${fmtBytes(f.bytes)}`') && part.includes('跳过 ${f.skipped.length} 个') && part.includes('超过 25 MB 没传 ${f.over.length} 个')
    && part.includes('名字不能用没传 ${f.bad.length} 个') && chat.includes('const note = folderLeftOut(f);') && part.includes('if (entry.cancelled) return entry;') && part.includes('f.cancelled = true;'));

  check('FOLD-5h sending to another machine with several files shows 「正在传 12/40…」 under the message, from this send\'s own peer.upload events, and takes it away when done; the hub sends those events to every window (group chats too)',
    live.includes('const uploadTag = remoteChatMachine() ? watchPeerUpload(files, myRow) : \'\';') && live.includes("if (ev.type === 'peer.upload') {") && live.includes('if (uploadTag) endPeerUpload();')
    && part.includes('`正在传 ${ev.done}/${ev.total}…`') && (await readText('../src/server.mjs')).includes("'initiative.say', 'peer.upload']"));

  check('FOLD-5i the optimistic bubble draws a folder as the hub will (one folder line), so the card shows at once',
    live.includes('f.folder ? folderAttachLine(f) :') && part.includes("return `- ${String(f.path).replace(/\\/?$/, '/')}（文件夹，${f.done} 个文件，${fmtBytes(f.bytes)}）`;"));
}
