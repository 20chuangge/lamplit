// 1.5.65: workspace files into the phone's album. A bot on the cloud had 9 pictures to post from the phone and
// put them on public file hosts one by one to get them there. Now phone({action:'save_to_album', paths}) puts
// workspace files (checked, 50 files / 200 MB) on the human's own phone: over the cable (adb push + the phone's
// time + a media scan) or through the Lamplit app (it fetches each file from its own machine with a one-time
// token and saves it through MediaStore); the first file is the newest, so 「从相册选择」 shows them first.
// An app from before 1.5.65 is told plainly; another machine's phone is reached through that machine.
// Nothing here talks to a real phone: adb and the app are fakes.
// Called from smoke.mjs as stages; kept in its own file so other work on smoke.mjs does not collide.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The hub's own temp folder in the real hub (data/tmp); a folder of the test's own here.
const hubTmpForTests = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-album-hubtmp-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f6a1b40000000049454e44ae426082', 'hex');

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src.replace(/\r\n/g, '\n'));
  return m ? m[0] : '';
}

async function workspace() {
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamplit-album-ws-'));
  await fsp.mkdir(path.join(ws, 'post'), { recursive: true });
  for (let i = 1; i <= 9; i += 1) await fsp.writeFile(path.join(ws, 'post', `p${i}.png`), Buffer.concat([PNG, Buffer.from(`#${i}`)]));
  await fsp.writeFile(path.join(ws, 'post', 'clip.mp4'), Buffer.from('fake mp4 bytes'));
  await fsp.writeFile(path.join(ws, 'post', 'notes.pdf'), Buffer.from('%PDF-1.4 fake'));
  await fsp.writeFile(path.join(ws, 'post', "it's $(rm -rf) ok;.jpg"), PNG);
  return ws;
}

const codeOf = async (fn) => { try { await fn(); return ''; } catch (err) { return err.code || err.message; } };

// --- the rules: which files, the caps, the order, the names -----------------------------------------
export async function albumRuleChecks({ check }) {
  const P = await import('../src/phone.mjs');
  const ws = await workspace();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamplit-album-out-'));
  try {
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    let linked = false;
    try { fs.symlinkSync(outside, path.join(ws, 'escape'), 'junction'); linked = true; } catch { /* no links here: that case is skipped */ }
    const refused = {
      dotdot: await codeOf(() => P.albumFiles(ws, ['../x.png'])),
      absolute: await codeOf(() => P.albumFiles(ws, [path.join(outside, 'secret.png')])),
      link: linked ? await codeOf(() => P.albumFiles(ws, ['escape/secret.png'])) : 'PHONE_OUTSIDE_WORKSPACE',
      missing: await codeOf(() => P.albumFiles(ws, ['post/nope.png'])),
      folder: await codeOf(() => P.albumFiles(ws, ['post'])),
      none: await codeOf(() => P.albumFiles(ws, [])),
    };
    check('ALB-1a only files in the workspace go to the phone: "..", a path outside, a link out of it, a missing file and a folder are refused with a plain reason; no paths says what to give',
      refused.dotdot === 'PHONE_OUTSIDE_WORKSPACE' && refused.absolute === 'PHONE_OUTSIDE_WORKSPACE' && refused.link === 'PHONE_OUTSIDE_WORKSPACE'
      && refused.missing === 'PHONE_FILE_NOT_FOUND' && refused.folder === 'PHONE_BAD_ARGS' && refused.none === 'PHONE_BAD_ARGS', JSON.stringify({ ...refused, linked }));

    const many = await codeOf(() => P.albumFiles(ws, Array.from({ length: P.ALBUM_MAX_FILES + 1 }, (_, i) => `post/p${(i % 9) + 1}.png`)));
    const huge = path.join(ws, 'huge.mp4');
    const fh = await fsp.open(huge, 'w');
    await fh.truncate(P.ALBUM_MAX_BYTES + 1);
    await fh.close();
    const big = await codeOf(() => P.albumFiles(ws, ['huge.mp4']));
    await fsp.rm(huge, { force: true });
    check('ALB-1b the caps: at most 50 files and 200 MB at a time, each said with "do them in parts"',
      P.ALBUM_MAX_FILES === 50 && P.ALBUM_MAX_BYTES === 200 * 1024 * 1024 && many === 'PHONE_TOO_MANY_FILES' && big === 'PHONE_FILES_TOO_LARGE', JSON.stringify({ many, big }));

    const files = await P.albumFiles(ws, ['post/p3.png', './post/p1.png', 'workspace/post/clip.mp4', 'post/p3.png', 'post\\notes.pdf']);
    check('ALB-1c the files come back in the order given, once each (a repeat is dropped), workspace-relative, with their sizes',
      files.map((f) => f.rel).join(',') === 'post/p3.png,post/p1.png,post/clip.mp4,post/notes.pdf' && files.every((f) => f.size > 0 && f.root === path.resolve(ws)),
      files.map((f) => f.rel).join(','));

    const plan = P.albumPlan([...files, (await P.albumFiles(ws, ["post/it's $(rm -rf) ok;.jpg"]))[0]], { now: 1800000000500 });
    const names = plan.map((p) => p.phoneName);
    check('ALB-1d the plan: the first file is the newest (now), each next one a second older; pictures and videos go to DCIM/Lamplit, other files to Download/Lamplit',
      plan.map((p) => p.time).join(',') === '1800000000,1799999999,1799999998,1799999997,1799999996'
      && plan.map((p) => `${p.kind}:${p.folder}`).join(',') === 'image:DCIM/Lamplit,image:DCIM/Lamplit,video:DCIM/Lamplit,file:Download/Lamplit,image:DCIM/Lamplit'
      && plan[2].mime === 'video/mp4' && plan[3].mime === 'application/pdf', JSON.stringify(plan.map((p) => [p.time, p.kind, p.folder])));
    check('ALB-1e names on the phone keep the file\'s name, lose quotes and shell characters, and are unique in the run',
      names[0].startsWith('p3_') && names[0].endsWith('.png') && new Set(names).size === names.length && !/['"$;()`&|]/.test(names.join('')) && names[4].endsWith('.jpg'), names.join(' | '));

    const cmds = P.adbAlbumCommands('SER1', plan.slice(0, 3), (it) => `/tmp/x/${it.order}`);
    const pushes = cmds.copy.filter((c) => c[2] === 'push');
    const touches = cmds.copy.filter((c) => c[3] === 'touch');
    const scanned = Buffer.from(cmds.scan[cmds.scan.length - 1], 'base64').toString('utf8').split('\n');
    check('ALB-1f over the cable: pushed last file first into /sdcard/DCIM/Lamplit, each given its time (touch -d @seconds, quoted for the phone\'s shell); one scan through the Lamplit app with every path, the system\'s scan broadcast as the fallback',
      pushes.map((c) => c[3]).join(',') === '/tmp/x/2,/tmp/x/1,/tmp/x/0' && pushes.every((c) => c[0] === '-s' && c[1] === 'SER1' && c[4].startsWith('/sdcard/DCIM/Lamplit/'))
      && touches.map((c) => c[5]).join(',') === '@1799999998,@1799999999,@1800000000' && touches.every((c) => /^'\/sdcard\/DCIM\/Lamplit\/[^']+'$/.test(c[6]))
      && cmds.scan.includes('content://com.desk.assistant.phonetype') && cmds.scan.includes('scan') && scanned.length === 3 && scanned[0].endsWith(plan[0].phoneName)
      && cmds.broadcast.length === 3 && cmds.broadcast.every((b) => b.includes('android.intent.action.MEDIA_SCANNER_SCAN_FILE') && /^'file:\/\/\/sdcard\//.test(b[b.length - 1])),
      JSON.stringify({ pushes: pushes.map((c) => c[3]), touches: touches.map((c) => c[5]) }));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
}

/** A fake adb for one phone on the cable: records every command, reads what is pushed. */
function fakeAdb({ serial = 'SER1', model = 'PCX00', phoneNow = 1800000100, scanOk = true } = {}) {
  const calls = [];
  const pushed = [];
  const exec = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'devices') return { stdout: `List of devices attached\n${serial}   device product:x model:${model} device:y transport_id:1\n` };
    if (args[2] === 'push') { pushed.push({ remote: args[4], bytes: fs.readFileSync(args[3]), local: args[3] }); return { stdout: '1 file pushed' }; }
    if (args[2] === 'shell' && args[3] === 'date') return { stdout: `${phoneNow}\n` };
    if (args[2] === 'shell' && args[3] === 'content') return { stdout: scanOk ? 'Result: Bundle[{ok=true}]\n' : 'Result: Bundle[{ok=false, error=say method type with the text in base64}]\n' };
    return { stdout: '' };
  };
  return { exec, calls, pushed };
}

// --- over the cable ----------------------------------------------------------------------------------
export async function albumAdbChecks({ check }) {
  const P = await import('../src/phone.mjs');
  const ws = await workspace();
  try {
    const adb = fakeAdb();
    const phone = P.createPhone({ adb: 'adb', exec: adb.exec, workspaceDir: ws, tmpDir: hubTmpForTests });
    const files = await P.albumFiles(ws, ['post/p1.png', 'post/p2.png', 'post/clip.mp4', 'post/notes.pdf']);
    const out = await phone.act('save_to_album', { files });
    const touches = adb.calls.filter((c) => c[3] === 'touch');
    const same = adb.pushed.every((p, i) => p.bytes.equals(fs.readFileSync(files[files.length - 1 - i].abs)));
    const left = adb.pushed.filter((p) => fs.existsSync(p.local) || fs.existsSync(path.dirname(p.local)));
    check('ALB-2a over the cable: each file copied through the checked read and pushed, last first, with the bytes of the workspace file; the copies are gone afterwards',
      adb.pushed.map((p) => path.posix.basename(p.remote).split('_')[0]).join(',') === 'notes,clip,p2,p1' && same && left.length === 0,
      JSON.stringify(adb.pushed.map((p) => p.remote)));
    check('ALB-2b the times are the phone\'s own clock (date +%s): the first file is the newest, then a second older each',
      adb.calls.some((c) => c[3] === 'date' && c[4] === '+%s') && touches.map((c) => c[5]).join(',') === '@1800000097,@1800000098,@1800000099,@1800000100', touches.map((c) => c[5]).join(','));
    check('ALB-2c the scan goes through the Lamplit app; the system broadcast is not needed when it answered',
      adb.calls.some((c) => c.includes('--method') && c.includes('scan')) && !adb.calls.some((c) => c.includes('android.intent.action.MEDIA_SCANNER_SCAN_FILE')));
    check('ALB-2d the answer says what happened: by cable, 3 in the album (2 pictures, 1 video), 1 in Downloads, where each went, and how to pick them',
      out.done === true && out.via === 'adb' && out.album === 3 && out.pictures === 2 && out.videos === 1 && out.downloads === 1
      && out.saved.length === 4 && out.saved[0].path === 'post/p1.png' && out.saved[0].phone.startsWith('DCIM/Lamplit/') && out.saved[3].phone.startsWith('Download/Lamplit/')
      && /newest/.test(out.note) && /从相册选择/.test(out.note), JSON.stringify(out));

    const oldApp = fakeAdb({ scanOk: false });
    await P.createPhone({ adb: 'adb', exec: oldApp.exec, workspaceDir: ws, tmpDir: hubTmpForTests }).act('save_to_album', { files: files.slice(0, 2) });
    check('ALB-2e an older Lamplit app on that phone (no scan there): the system\'s scan broadcast for each file instead',
      oldApp.calls.filter((c) => c.includes('android.intent.action.MEDIA_SCANNER_SCAN_FILE')).length === 2);

    const none = P.createPhone({ adb: 'adb', exec: async (_f, a) => (a[0] === 'devices' ? { stdout: 'List of devices attached\n\n' } : { stdout: '' }), workspaceDir: ws, tmpDir: hubTmpForTests });
    const gone = await none.act('save_to_album', { files }).then(() => null, (err) => err);
    check('ALB-2f no phone connected: a clear error (PHONE_NOT_CONNECTED) that says how to connect it, nothing pushed',
      gone?.code === 'PHONE_NOT_CONNECTED' && /让机器人用这部手机|USB debugging/.test(gone.message), gone?.message);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
}

/** A fake Lamplit app on a phone: answers save_media by fetching each file the way the hub serves it. */
function fakeApp(linkRef, { deviceId = 'dev1', answer } = {}) {
  const jobs = [];
  const got = [];
  const bus = {
    emit(event) {
      if (event.type !== 'phone.job') return;
      jobs.push(event);
      setTimeout(async () => {
        const link = linkRef.link;
        if (answer) { link.resolve(event.jobId, event.to, answer(event)); return; }
        const { readInside } = await import('../src/safefs.mjs');
        const failed = [];
        for (const f of event.args.files || []) {
          const token = String(f.url).split('/').pop();
          const s = link.staged(token, deviceId);
          const other = link.staged(token, 'someone-else');
          if (!s || other || !/^\/api\/phone\/files\/[\w-]+$/.test(f.url)) { failed.push({ order: f.order, why: 'no file' }); continue; }
          got.push({ order: f.order, name: f.name, kind: f.kind, folder: f.folder, mime: f.mime, bytes: await readInside(s.root, s.abs), token });
        }
        link.resolve(event.jobId, event.to, { ok: true, result: { saved: got.length, failed } });
      }, 5);
    },
  };
  return { bus, jobs, got };
}

// --- through the Lamplit app (no cable, or another machine) ------------------------------------------
export async function albumAppChecks({ check }) {
  const P = await import('../src/phone.mjs');
  const L = await import('../src/phonelink.mjs');
  const ws = await workspace();
  try {
    const ref = {};
    const app = fakeApp(ref);
    const link = L.createPhoneLink({ bus: app.bus, jobTimeoutMs: 2000 });
    ref.link = link;
    link.register('dev1', { enabled: true, model: 'OPPO PCX00', caps: ['save_media'] });
    const phone = P.createPhone({ adb: () => 'lamplit', exec: L.makePhoneExec({ adbPath: () => '', link }), workspaceDir: ws, tmpDir: hubTmpForTests });
    const files = await P.albumFiles(ws, Array.from({ length: 9 }, (_, i) => `post/p${i + 1}.png`));
    const out = await phone.act('save_to_album', { files });
    const job = app.jobs[0] || {};
    const argsText = JSON.stringify(job.args || {});
    const sameBytes = app.got.every((g) => g.bytes.equals(fs.readFileSync(files[g.order].abs)));
    check('ALB-3a through the app: one save_media step to that phone only, the 9 files in the given order, each at a one-time address on this machine (never a public host, never a path of this computer)',
      app.jobs.length === 1 && job.to === 'dev1' && job.action === 'save_media' && job.args.files.length === 9
      && job.args.files.map((f) => f.order).join(',') === '0,1,2,3,4,5,6,7,8' && job.args.files.every((f) => /^\/api\/phone\/files\/[\w-]{20,}$/.test(f.url))
      && !argsText.includes(ws) && !/https?:/.test(argsText) && new Set(job.args.files.map((f) => f.url)).size === 9,
      argsText.slice(0, 300));
    check('ALB-3b the step carries what MediaStore needs: name, mime, kind (image/video/file), folder, size - and no time of this computer (the phone uses its own clock)',
      job.args.files.every((f) => Object.keys(f).sort().join(',') === 'folder,kind,mime,name,order,size,url') && job.args.files[0].mime === 'image/png' && job.args.files[0].folder === 'DCIM/Lamplit' && job.args.files[0].kind === 'image');
    check('ALB-3c the phone fetches exactly the workspace files, and only the phone the step went to may (another device gets nothing); the tokens are gone when the step ends',
      app.got.length === 9 && sameBytes && app.got.every((g) => link.staged(g.token, 'dev1') === null), JSON.stringify({ got: app.got.length, sameBytes }));
    check('ALB-3d the answer: through the app, 9 in the album',
      out.via === 'app' && out.album === 9 && out.pictures === 9 && out.downloads === 0 && out.saved.length === 9, JSON.stringify(out).slice(0, 300));
    check('ALB-3e the wait grows with the files (30 s + 2 s a file + 4 s a MB, at most 20 min)',
      L.mediaTimeoutMs([{ size: 0 }]) === 32000 && L.mediaTimeoutMs([{ size: 10 * 1024 * 1024 }, { size: 1 }]) === 30000 + 4000 + 11 * 4000 && L.mediaTimeoutMs(Array.from({ length: 50 }, () => ({ size: 4 * 1024 * 1024 }))) === 30000 + 100000 + 800000 && L.mediaTimeoutMs(Array.from({ length: 50 }, () => ({ size: 6 * 1024 * 1024 }))) === 20 * 60 * 1000);

    // Some saved, some not: said per file.
    const ref2 = {};
    const half = fakeApp(ref2, { answer: (ev) => ({ ok: true, result: { saved: 1, failed: [{ order: 1, why: 'the phone is full' }] } }) });
    const link2 = L.createPhoneLink({ bus: half.bus, jobTimeoutMs: 2000 });
    ref2.link = link2;
    link2.register('dev1', { enabled: true, model: 'X', caps: ['save_media'] });
    const out2 = await P.createPhone({ adb: () => 'lamplit', exec: L.makePhoneExec({ adbPath: () => '', link: link2 }), workspaceDir: ws, tmpDir: hubTmpForTests }).act('save_to_album', { files: files.slice(0, 2) });
    check('ALB-3f a file the phone could not save is named with the reason; the others count',
      out2.album === 1 && out2.failed?.length === 1 && out2.failed[0].path === 'post/p2.png' && /full/.test(out2.failed[0].why), JSON.stringify(out2));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
}

// --- an app from before 1.5.65 -------------------------------------------------------------------------
export async function albumOldAppChecks({ check }) {
  const P = await import('../src/phone.mjs');
  const L = await import('../src/phonelink.mjs');
  const ws = await workspace();
  try {
    const files = await P.albumFiles(ws, ['post/p1.png', 'post/p2.png']);
    // No caps in its report, no cable: told plainly, nothing sent to the phone.
    const ref = {};
    const app = fakeApp(ref);
    const link = L.createPhoneLink({ bus: app.bus, jobTimeoutMs: 2000 });
    ref.link = link;
    link.register('dev1', { enabled: true, model: 'OPPO PCX00' });
    const err = await P.createPhone({ adb: () => 'lamplit', exec: L.makePhoneExec({ adbPath: () => '', link }), workspaceDir: ws, tmpDir: hubTmpForTests }).act('save_to_album', { files }).then(() => null, (e) => e);
    check('ALB-4a an older Lamplit app on the phone: "update it to 1.5.65", with the cable as the other way and never a public file host; no step sent to the phone',
      err?.code === 'PHONE_APP_TOO_OLD' && err.message.includes('1.5.65') && /USB debugging/.test(err.message) && /public file host/.test(err.message) && app.jobs.length === 0, err?.message);

    // The same phone also on the cable here: the files go over the cable.
    const adb = fakeAdb({ model: 'PCX00' });
    const both = L.makePhoneExec({ adbPath: () => 'adb', link, adbExec: adb.exec });
    const out = await P.createPhone({ adb: () => 'adb', exec: both, workspaceDir: ws, tmpDir: hubTmpForTests }).act('save_to_album', { files });
    check('ALB-4b an older app but the same phone plugged in here: the files go over the cable instead (by its model)',
      out.via === 'adb' && adb.pushed.length === 2 && adb.pushed.every((p) => p.remote.startsWith('/sdcard/DCIM/Lamplit/')), JSON.stringify(out).slice(0, 200));

    // An app that said it could but does not know the step (an in-between build): the same message.
    const ref3 = {};
    const unknown = fakeApp(ref3, { answer: () => ({ ok: false, code: 'PHONE_FAILED', message: 'unknown step save_media' }) });
    const link3 = L.createPhoneLink({ bus: unknown.bus, jobTimeoutMs: 2000 });
    ref3.link = link3;
    link3.register('dev1', { enabled: true, model: 'Y', caps: ['save_media'] });
    const err3 = await P.createPhone({ adb: () => 'lamplit', exec: L.makePhoneExec({ adbPath: () => '', link: link3 }), workspaceDir: ws, tmpDir: hubTmpForTests }).act('save_to_album', { files }).then(() => null, (e) => e);
    check('ALB-4c an app that answers "unknown step" gets the same plain message', err3?.code === 'PHONE_APP_TOO_OLD' && err3.message.includes('1.5.65'), err3?.message);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
}

// --- the tool, the guidance, another machine ----------------------------------------------------------
export async function albumToolChecks({ check, toolsMod, readText }) {
  const P = await import('../src/phone.mjs');
  const L = await import('../src/phonelink.mjs');
  const ws = await workspace();
  try {
    const ref = {};
    const app = fakeApp(ref);
    const link = L.createPhoneLink({ bus: app.bus, jobTimeoutMs: 2000 });
    ref.link = link;
    link.register('dev1', { enabled: true, model: 'X', caps: ['save_media'] });
    const phone = P.createPhone({ adb: () => 'lamplit', exec: L.makePhoneExec({ adbPath: () => '', link }), workspaceDir: ws, tmpDir: hubTmpForTests });
    const uploads = [];
    const albumCalls = [];
    let peerOld = false;
    const peers = {
      list: () => [{ name: '腾讯云' }],
      find: (name) => (name === '腾讯云' ? { name: '腾讯云' } : null),
      json: async (_peer, method, p, opts) => { uploads.push({ method, p, name: decodeURIComponent(opts.headers['x-file-name']), bytes: opts.raw }); return { path: `uploads/2026-11-23/${decodeURIComponent(opts.headers['x-file-name'])}` }; },
      call: async (_peer, method, p, opts) => {
        albumCalls.push({ method, p, body: opts.body });
        if (peerOld) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }), { status: 404, headers: { 'content-type': 'application/json' } });
        const saved = opts.body.paths.map((x) => ({ path: x, phone: `DCIM/Lamplit/${path.posix.basename(x)}` }));
        return new Response(JSON.stringify({ done: true, via: 'app', album: saved.length, pictures: saved.length, videos: 0, downloads: 0, saved }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getPhone: () => phone, getPeers: () => peers });
    const ctx = { workspaceDir: ws, bot: { id: 'alb' }, turnId: 'alb-1' };
    const tool = registry.get('phone');
    const run = (args) => tool.run(args, ctx).then((r) => r, (e) => ({ error: e.code || e.message, message: e.message }));

    const risk = typeof tool.risk === 'function' ? tool.risk({ action: 'save_to_album' }) : tool.risk;
    const esc = await tool.escalate({ action: 'save_to_album', paths: ['post/p1.png', 'post/p2.png'] }, ctx);
    check('ALB-5a approval: putting the human\'s own files on their own phone is an ordinary phone step (MEDIUM, like opening an app) - not an outgoing send, not "ask every time"; the card says what in plain words',
      String(risk?.risk).toLowerCase() === 'medium' && String(esc?.risk).toLowerCase() === 'medium' && !esc.alwaysAsk && esc.reason === '把工作区里的 2 个文件放进你的手机相册' && !tool.outgoing, JSON.stringify({ risk, esc }));

    const { permissionKey } = await import('../src/approvals.mjs');
    const kept = permissionKey('phone', { action: 'save_to_album', paths: ['a.png'] });
    const tapKept = permissionKey('phone', { action: 'swipe' });
    check('ALB-5a2 「以后都允许」 on this card is kept for putting files in the album only - never for every step on the phone',
      kept?.key === 'phone:album' && kept.label === '把文件放进手机相册' && tapKept?.key === 'phone', JSON.stringify({ kept, tapKept }));

    const ok = await run({ action: 'save_to_album', paths: ['post/p2.png', 'post/p1.png'] });
    check('ALB-5b the phone tool takes paths and puts them on the phone through the app, in that order',
      ok.via === 'app' && ok.album === 2 && app.got.map((g) => g.order).join(',') === '0,1' && ok.saved[0].path === 'post/p2.png', JSON.stringify(ok).slice(0, 300));
    const bad = await run({ action: 'save_to_album', paths: ['../../etc/passwd'] });
    const tooMany = await run({ action: 'save_to_album', paths: Array.from({ length: 51 }, () => 'post/p1.png') });
    check('ALB-5c through the tool too: a path outside the workspace and more than 50 files are refused before anything moves',
      bad.error === 'PHONE_OUTSIDE_WORKSPACE' && tooMany.error === 'PHONE_TOO_MANY_FILES' && app.jobs.length === 1, JSON.stringify({ bad, tooMany: tooMany.error }));

    const there = await run({ action: 'save_to_album', paths: ['post/p1.png', 'post/clip.mp4'], machine: '腾讯云' });
    check('ALB-5d the phone on another machine: the files are sent there first (its uploads), then that machine puts them on its phone; the answer names this machine\'s paths',
      uploads.length === 2 && uploads[0].name === 'p1.png' && uploads[0].bytes.equals(fs.readFileSync(path.join(ws, 'post', 'p1.png')))
      && albumCalls.length === 1 && albumCalls[0].p === '/api/phone/album' && albumCalls[0].body.paths.join(',') === 'uploads/2026-11-23/p1.png,uploads/2026-11-23/clip.mp4'
      && there.machine === '腾讯云' && there.saved.map((s) => s.path).join(',') === 'post/p1.png,post/clip.mp4', JSON.stringify({ there, albumCalls }).slice(0, 400));
    peerOld = true;
    const old = await run({ action: 'save_to_album', paths: ['post/p1.png'], machine: '腾讯云' });
    check('ALB-5e that machine runs an older Lamplit: said plainly (update it there)', old.error === 'PEER_TOO_OLD' && old.message.includes('1.5.65'), JSON.stringify(old));

    const desc = tool.description;
    check('ALB-6a the tool says when to use it: save_to_album whenever files must reach the phone, never a public file host or download link; the caps are in it',
      P.PHONE_ACTIONS.includes('save_to_album') && tool.parameters.properties.action.enum.includes('save_to_album') && tool.parameters.properties.paths?.type === 'array'
      && /Whenever files must get onto the phone[^.]*save_to_album - never put them on a public file host/.test(desc) && desc.includes('50 files / 200 MB'), desc.slice(0, 200));
    const agentSrc = (await readText('../src/agent.mjs')).replace(/\r\n/g, '\n');
    check('ALB-6b the bots\' guidance: every bot hears never to use public file hosts between the human\'s own devices (save_to_album, file_send / file_fetch instead); bots with the phone hear how to put files on it',
      /public file host/.test(P.NO_PUBLIC_HOST_RULE) && /save_to_album/.test(P.NO_PUBLIC_HOST_RULE) && /file_send \/ file_fetch/.test(P.NO_PUBLIC_HOST_RULE)
      && /save_to_album/.test(P.PHONE_FILES_RULE) && /从相册选择/.test(P.PHONE_FILES_RULE) && /update it/.test(P.PHONE_FILES_RULE)
      && agentSrc.includes('        PHONE_FILES_RULE] : []),\n      NO_PUBLIC_HOST_RULE,') && agentSrc.includes("import { PHONE_KIND_LABEL, PHONE_FILES_RULE, NO_PUBLIC_HOST_RULE } from './phone.mjs';"));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
}

// --- the hub's routes ------------------------------------------------------------------------------------
export async function albumRouteChecks({ check, api, readText }) {
  const notPhone = await api('/api/phone/files/abcdefghijklmnopqrstuvwx');
  check('ALB-7a only a paired phone may fetch a file of a save step (a token alone is not enough)', notPhone.status === 403 && notPhone.json?.error?.code === 'NOT_A_PHONE', notPhone.text.slice(0, 160));
  const none = await api('/api/phone/album', { method: 'POST', body: { paths: [] } });
  const out = await api('/api/phone/album', { method: 'POST', body: { paths: ['../secret.png'] } });
  const missing = await api('/api/phone/album', { method: 'POST', body: { paths: ['uploads/none-here.png'] } });
  const many = await api('/api/phone/album', { method: 'POST', body: { paths: Array.from({ length: 51 }, (_, i) => `x${i}.png`) } });
  const page = await api('/api/phone/album', { method: 'POST', body: { paths: ['x.png'] }, headers: { origin: 'https://example.invalid' } });
  check('ALB-7b another machine\'s ask (POST /api/phone/album) is checked like a bot\'s: workspace files only, the caps; a web page cannot ask',
      none.status === 400 && none.json?.error?.code === 'PHONE_BAD_ARGS' && out.status === 400 && out.json?.error?.code === 'PHONE_OUTSIDE_WORKSPACE'
      && missing.status === 400 && missing.json?.error?.code === 'PHONE_FILE_NOT_FOUND' && many.status === 400 && many.json?.error?.code === 'PHONE_TOO_MANY_FILES' && (page.status === 401 || page.status === 403),
      JSON.stringify([none.status, out.status, missing.status, many.status, page.status]));
  const src = await readText('../src/server.mjs');
  check('ALB-7c the file goes out through the checked open at fetch time, only for the phone the token was made for; the phone\'s report carries what its app can do',
    /state\.phoneLink\.staged\(params\.token, device\.id\)[\s\S]{0,300}statInside\(file\.root, file\.abs\)/.test(src) && src.includes("caps: Array.isArray(body?.caps) ? body.caps : []"));
}

// --- the Android app ------------------------------------------------------------------------------------
export async function albumAndroidChecks({ check, readText }) {
  const base = '../mobile/android/app/src/main/java/com/desk/assistant/';
  const saver = await readText(`${base}AlbumSaver.java`);
  const watcher = await readText(`${base}NightshiftWatcher.java`);
  const provider = await readText(`${base}PhoneTypeProvider.java`);
  check('ALB-8a the app saves through MediaStore without any storage permission: pending until whole, DCIM/Lamplit for pictures and videos, Download/Lamplit for the rest; a file that came short or too big is taken away',
    saver.includes('MediaStore.MediaColumns.IS_PENDING, 1') && saver.includes('MediaStore.MediaColumns.IS_PENDING, 0') && saver.includes('Environment.DIRECTORY_DCIM + "/Lamplit"')
    && saver.includes('Environment.DIRECTORY_DOWNLOADS + "/Lamplit"') && saver.includes('MediaStore.Downloads.getContentUri') && saver.includes('the file came incomplete')
    && saver.includes('resolver.delete(item, null, null)') && saver.includes('Build.VERSION_CODES.Q'));
  check('ALB-8b order on the phone: saved last file first, each started in a later second than the one before; only addresses of its own machine (/api/phone/files/<token>) are fetched; 50 files / 200 MB',
    saver.includes('for (int i = files.length() - 1; i >= 0; i -= 1)') && saver.includes('if (now / 1000 <= lastSecond) Thread.sleep(')
    && saver.includes('FILES_PATH = "/api/phone/files/"') && saver.includes('!path.startsWith(FILES_PATH)') && saver.includes('MAX_FILES = 50') && saver.includes('MAX_BYTES = 200L * 1024 * 1024'));
  check('ALB-8c the watcher runs save_media itself, fetching from the machine that sent it (its address now, this phone\'s token, no redirects), and tells every machine it can',
    watcher.includes('"save_media".equals(event.optString("action", ""))') && watcher.includes('final String base = via(hub);') && watcher.includes('conn.setRequestProperty("Authorization", "Bearer " + token);')
    && watcher.includes('conn.setInstanceFollowRedirects(false);') && watcher.includes('body.put("caps", new org.json.JSONArray().put("save_media"));'));
  check('ALB-8d over the cable the app scans what was pushed - adb only, Lamplit\'s two folders only',
    provider.includes('"scan".equals(method)') && provider.includes('MediaScannerConnection.scanFile') && provider.includes('"/DCIM/Lamplit/"') && provider.includes('"/Download/Lamplit/"')
    && provider.indexOf('checkCallingPermission("android.permission.DUMP")') < provider.indexOf('"scan".equals(method)'));
}

// --- the page: the step's line --------------------------------------------------------------------------
export async function albumPageChecks({ check, readText }) {
  const chat = await readText('../public/app/main/05-chat.js');
  const cards = await readText('../public/app/main/07b-cards.js');
  // eslint-disable-next-line no-new-func
  const albumReceiptText = new Function(`${fnSource(cards, 'albumReceiptText')}; return albumReceiptText;`)();
  const lines = [
    albumReceiptText({ saved: [], pictures: 9, videos: 0, downloads: 0 }),
    albumReceiptText({ saved: [], pictures: 8, videos: 1, downloads: 0 }),
    albumReceiptText({ saved: [], pictures: 0, videos: 0, downloads: 2 }),
    albumReceiptText({ saved: [], pictures: 3, videos: 0, downloads: 0, failed: [{}] }),
  ];
  check('ALB-9a the turn shows what reached the phone: 「放进了手机相册：9 张」, with videos and Downloads said as such, and what did not',
    lines[0] === '放进了手机相册：9 张' && lines[1] === '放进了手机相册：8 张图、1 段视频' && lines[2] === '放进了手机的「下载」：2 个文件' && lines[3] === '放进了手机相册：3 张（1 个没放成）', JSON.stringify(lines));
  check('ALB-9b the step is named 「放进手机相册」 (not 「操作手机」) and its line becomes the receipt once done',
    chat.includes("if (args.action === 'save_to_album') albumStepText(out, args, set);") && /function albumStepText\(out, args, set\) \{[\s\S]{0,120}out\.label = '放进手机相册'/.test(cards)
    && chat.includes("if (item.name === 'phone' && item.ok && !item.pending && Array.isArray(item.output?.saved)) info.detail = albumReceiptText(item.output);"));
}
