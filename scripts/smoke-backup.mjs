/**
 * smoke-backup.mjs - one-click backup and restore (1.5.54).
 *
 * A computer that dies took the bots, their memory, the chat history, the
 * routines and the keys with it: the keys are sealed with a key Windows keeps
 * for that one computer, so even a copied data folder opens nothing. Now:
 *   - 设置 → 备份 writes one file, encrypted with a password the human sets
 *     (scrypt + AES-256-GCM); without the password nothing in it reads;
 *   - restoring it on another computer (another master key) re-seals the keys
 *     there; pairings, logins to other machines and relay secrets stay behind
 *     and the restore screen says so;
 *   - a wrong password, a damaged file and a file from a newer Lamplit are
 *     refused in plain words; nothing is replaced without a confirm, and the
 *     data there is backed up first (恢复前自动备份);
 *   - only the human: a bot's command on this computer cannot back up or restore.
 *
 * Two (three) throw-away hubs of its own, on 127.0.0.1, each with its own master
 * key. Run by scripts/smoke.mjs as its own stage (kept apart so it merges cleanly).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'correct horse 42';
const API_KEY = 'sk-backup-smoke-0123456789';
const VAULT_VALUE = 'hunter2-backup-smoke';

async function seed(home) {
  for (const dir of ['config', 'skills', 'public']) {
    await fsp.cp(path.join(REPO, dir), path.join(home, dir), { recursive: true }).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
  await fsp.mkdir(path.join(home, 'workspace'), { recursive: true });
}

function startHub(home, masterKey) {
  const env = {
    ...process.env,
    ASSIST_HOME: home,
    ASSIST_DATA_DIR: path.join(home, 'data'),
    ASSIST_WORKSPACE_DIR: path.join(home, 'workspace'),
    ASSIST_MASTER_KEY: masterKey,
    ASSIST_MODEL_PROVIDER: 'mock',
    ASSIST_UPDATE_NO_EXIT: '1',
    PORT: '0',
    HOST: '127.0.0.1',
    DESK_VNC_PORT: '1',
    DESK_CLI_WATCH: '0',
    DESK_SCREEN_WATCH: '0',
    DESK_TAILSCALE_SIMULATE: '1',
    LAMPLIT_DIRECT_ALLOW_LOOPBACK: '1',
    LAMPLIT_DIRECT_BIND: '127.0.0.1',
  };
  delete env.ASSIST_API_KEY;
  const proc = spawn(process.execPath, [path.join(REPO, 'src', 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let buf = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`hub did not start in 20s\n${err.slice(-800)}`)), 20000);
    proc.stderr.on('data', (c) => { err += c.toString('utf8'); });
    proc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const ready = JSON.parse(line.trim());
          if (ready.event === 'ready') {
            clearTimeout(timer);
            const port = ready.port || Number(new URL(ready.url).port);
            resolve({ proc, home, masterKey, base: `http://127.0.0.1:${port}`, stderr: () => err });
          }
        } catch { /* partial line */ }
      }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`hub exited ${code}\n${err.slice(-800)}`)); });
  });
}

async function stopHub(hub) {
  if (!hub?.proc || hub.proc.exitCode !== null) return;
  hub.proc.removeAllListeners('exit');
  await new Promise((resolve) => {
    hub.proc.once('exit', resolve);
    hub.proc.kill();
    setTimeout(resolve, 4000);
  });
}

const localKey = (hub) => { try { return fs.readFileSync(path.join(hub.home, 'data', 'local-key'), 'utf8').trim(); } catch { return ''; } };

/** A request as the human's own app (the local key), or as a bot's command (`bot: true`, no key). */
async function call(hub, method, p, body, { bot = false, raw = null, type = null } = {}) {
  const headers = {};
  if (!bot) headers['x-lamplit-local'] = localKey(hub);
  let payload;
  if (raw) { payload = raw; headers['content-type'] = type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await globalThis.fetch.call(null, `${hub.base}${p}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  if (/octet-stream/.test(ct)) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const box = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function backupChecks({ check, readText }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lamplit-backup-smoke-'));
  const keyA = crypto.randomBytes(32).toString('hex');
  const keyB = crypto.randomBytes(32).toString('hex');
  const keyC = crypto.randomBytes(32).toString('hex');
  const homes = { a: path.join(tmp, 'a'), b: path.join(tmp, 'b'), c: path.join(tmp, 'c') };
  for (const h of Object.values(homes)) await seed(h);
  const store = await import('../src/store.mjs');
  const auth = await import('../src/auth.mjs');
  let A = null;
  let B = null;
  let C = null;
  try {
    // --- the module and the rules, before any hub -----------------------------------
    let backup = null;
    try { backup = await import('../src/backup.mjs'); } catch (err) { check('BK0 src/backup.mjs exists', false, err.message); return; }
    check('BK0 src/backup.mjs exists', Boolean(backup));
    check('BK1 every backup and restore route is the human\'s (isAuthorityRequest)',
      ['GET /api/backup', 'POST /api/backup', 'POST /api/backup/schedule', 'POST /api/backup/schedule/run', 'POST /api/restore/upload', 'POST /api/restore/peek', 'POST /api/restore/inspect', 'POST /api/restore/apply', 'POST /api/restore/cancel', 'POST /api/peers/腾讯云/backup']
        .every((r) => { const [m, p] = r.split(' '); return auth.isAuthorityRequest(m, p, {}); }));
    // Every file the hub keeps in data/ is put in the backup, kept out of it on purpose, or sealed as a key.
    {
      const src = (await Promise.all((await fsp.readdir(path.join(REPO, 'src'))).filter((n) => n.endsWith('.mjs')).map((n) => fsp.readFile(path.join(REPO, 'src', n), 'utf8')))).join('\n');
      const names = new Set();
      for (const m of src.matchAll(/(?:P\.dataDir|dataDir|DATA_DIR),\s*'([^'$`]+)'/g)) names.add(m[1].split('/')[0]);
      for (const m of src.matchAll(/(?:P\.dataDir|dataDir),\s*`([a-z-]+)-\$\{/g)) names.add(`${m[1]}-x.json`);
      const unknown = [...names].filter((n) => !backup.classifyDataName(n));
      check('BK2 every data file the code writes is classified (in the backup, a key, or left out on purpose)', names.size > 40 && !unknown.length, `unclassified: ${unknown.join(', ')} (of ${names.size})`);
      check('BK3 pairings, logins to other machines, relay secrets and this computer\'s own keys stay out',
        ['security.json', 'devices.json', 'local-key', 'peers.json', 'relay-link.json', 'runner.json', 'master.key', 'backup-key.json', 'tls', 'relay-tls', 'turns', 'pending.json', 'browser-profiles', 'workspace.json'].every((n) => backup.classifyDataName(n) === 'skip'),
        ['security.json', 'devices.json', 'local-key', 'peers.json', 'relay-link.json', 'runner.json'].map((n) => `${n}=${backup.classifyDataName(n)}`).join(' '));
      check('BK4 keys go in as keys (opened here, sealed again there): model, voice, apps, the vault',
        ['secrets.json', 'voice.json', 'vision.json', 'media.json', 'mcp.json', 'feishu.json', 'x-account.json', 'model-keys.json', 'feishu-app-x.json'].every((n) => backup.classifyDataName(n) === 'secret')
        && backup.classifyDataName('vault.key') === 'vault-key' && backup.classifyDataName('vault.json') === 'vault');
      check('BK5 the backup key file is sealed like the other key files', store.SEALED_FILES.has('backup-key.json'));
    }

    // --- a hub with something worth keeping -----------------------------------------
    A = await startHub(homes.a, keyA);
    const made = await call(A, 'POST', '/api/bots', { name: '策略', role: '求职策略与筛岗', persona: '只看后端岗位。BACKUP-PERSONA-MARK' });
    const ceId = made.json?.bot?.id;
    check('BK6 test hub A: a bot of its own', made.status === 200 && ceId, made.text?.slice(0, 200));
    await fsp.mkdir(path.join(homes.a, 'data', 'memory', ceId), { recursive: true });
    await fsp.writeFile(path.join(homes.a, 'data', 'memory', ceId, 'MEMORY.md'), '# 记忆\n- 用户只看北京的岗位 BACKUP-MEMORY-MARK\n');
    const rt = await call(A, 'POST', '/api/routines', { botId: ceId, name: '早报', instruction: '把昨晚新出的岗位列出来', schedule: '每天 8:30' });
    const vault = await call(A, 'POST', '/api/vault', { name: '京东', site: 'https://jd.example', values: { 账号: 'me@example.com', 密码: VAULT_VALUE } });
    const set = await call(A, 'PUT', '/api/settings', { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'fake', apiKey: API_KEY });
    await call(A, 'POST', '/api/bots/chief/message', { text: '你好，记住我叫小林' });
    await fsp.mkdir(path.join(homes.a, 'workspace', 'notes'), { recursive: true });
    await fsp.writeFile(path.join(homes.a, 'workspace', 'notes', '计划.txt'), 'BACKUP-WORKSPACE-MARK\n');
    check('BK7 test hub A: a routine, a vault login and a model key', rt.status === 200 && vault.status === 200 && set.status === 200, `${rt.status} ${vault.status} ${set.status} ${vault.text?.slice(0, 120)}`);
    const secretsA = box(path.join(homes.a, 'data', 'secrets.json'));
    check('BK8 on A the model key is sealed with A\'s master key (a copy opens nothing elsewhere)', secretsA.lamplitSealed === 1 && store.openSealed(secretsA, Buffer.from(keyB, 'hex')) === null);

    // --- only the human ----------------------------------------------------------------
    {
      const asBot = await call(A, 'POST', '/api/backup', { password: PASSWORD }, { bot: true });
      const readAsBot = await call(A, 'GET', '/api/backup', undefined, { bot: true });
      const restoreAsBot = await call(A, 'POST', '/api/restore/inspect', { from: path.join(tmp, 'x.lamplit'), password: PASSWORD }, { bot: true });
      check('BK9 a bot\'s command on this computer cannot back up, look at the backup settings, or restore',
        asBot.status === 403 && readAsBot.status === 403 && restoreAsBot.status === 403 && asBot.json?.error?.code === 'LOCAL_KEY_REQUIRED', `${asBot.status} ${readAsBot.status} ${restoreAsBot.status}`);
    }
    {
      const short = await call(A, 'POST', '/api/backup', { password: '1234' });
      const none = await call(A, 'POST', '/api/backup', {});
      check('BK10 a backup needs a password of 8 or more, said in plain words', short.status === 400 && short.json?.error?.code === 'BACKUP_PASSWORD_SHORT' && /8/.test(short.json?.error?.message || '') && none.status === 400, `${short.status} ${short.text?.slice(0, 160)}`);
    }
    const info0 = await call(A, 'GET', '/api/backup');
    check('BK11 GET /api/backup: nothing backed up yet, the workspace size, what stays out',
      info0.status === 200 && !info0.json?.lastBackup && info0.json?.workspace?.files >= 1 && info0.json?.workspace?.bytes > 0 && Array.isArray(info0.json?.notIncluded) && info0.json.notIncluded.length >= 4 && info0.json.notIncluded.some((n) => /配对/.test(n.text)) && info0.json.notIncluded.some((n) => /中转/.test(n.text)),
      info0.text?.slice(0, 300));

    // The Windows screen's passwords (TightVNC, 1.5.53) belong to this computer's TightVNC.
    await fsp.writeFile(path.join(homes.a, 'data', 'tightvnc.json'), store.sealText(JSON.stringify({ password: 'VNC-MARK-A1', viewOnly: 'VNC-MARK-A2', admin: 'VNC-MARK-A3' }), Buffer.from(keyA, 'hex')));
    // --- backing up ---------------------------------------------------------------------
    const down = await call(A, 'POST', '/api/backup', { password: PASSWORD, includeWorkspace: true });
    const file = path.join(tmp, 'a.lamplit');
    if (down.bytes) await fsp.writeFile(file, down.bytes);
    const disp = down.headers?.get?.('content-disposition') || '';
    check('BK12 「备份到文件」 in a browser: a download named Lamplit-备份-….lamplit', down.status === 200 && down.bytes?.length > 200 && /attachment/.test(disp) && /\.lamplit/.test(decodeURIComponent(disp)), `${down.status} ${disp} ${down.text?.slice(0, 200)}`);
    const bytes = down.bytes || Buffer.alloc(0);
    const firstLine = bytes.subarray(0, 40).toString('utf8').split('\n')[0];
    check('BK13 the file says what it is and its format on the first line', firstLine === 'LAMPLIT-BACKUP 1', firstLine);
    const asText = bytes.toString('latin1');
    check('BK14 nothing in the file reads without the password (key, vault login, persona, memory, files)',
      ![API_KEY, VAULT_VALUE, 'BACKUP-PERSONA-MARK', 'BACKUP-MEMORY-MARK', 'BACKUP-WORKSPACE-MARK', '策略', '小林'].some((s) => asText.includes(s) || bytes.includes(Buffer.from(s, 'utf8'))));
    const header = (() => { try { return JSON.parse(bytes.toString('utf8').split('\n')[1]); } catch { return null; } })();
    check('BK15 the header (no password needed) holds counts and how it is locked, not names', header?.kdf?.name === 'scrypt' && header?.kdf?.N >= 2 ** 15 && header?.cipher === 'aes-256-gcm' && header?.counts?.bots >= 2 && header?.counts?.routines === 1 && header?.counts?.vault === 1 && !JSON.stringify(header).includes('策略'), JSON.stringify(header)?.slice(0, 300));
    const info1 = await call(A, 'GET', '/api/backup');
    check('BK16 the last backup time is kept', Boolean(info1.json?.lastBackup?.at), info1.text?.slice(0, 200));
    // The desktop app: a path picked in the native save dialog.
    {
      const picked = path.join(tmp, 'picked', 'mine.lamplit');
      await fsp.mkdir(path.dirname(picked), { recursive: true });
      const r = await call(A, 'POST', '/api/backup', { password: PASSWORD, to: picked });
      const bad = await call(A, 'POST', '/api/backup', { password: PASSWORD, to: path.join(tmp, 'picked', 'notes.txt') });
      const inData = await call(A, 'POST', '/api/backup', { password: PASSWORD, to: path.join(homes.a, 'data', 'x.lamplit') });
      check('BK17 the desktop app saves where the dialog said; only a .lamplit file, never in the data folder', r.status === 200 && fs.existsSync(picked) && r.json?.file === picked && bad.status === 400 && inData.status === 400, `${r.status} ${r.text?.slice(0, 120)} ${bad.status} ${inData.status}`);
    }

    // --- an empty second hub: what is in it, and what is refused ----------------------
    B = await startHub(homes.b, keyB);
    const tokenBefore = box(path.join(homes.b, 'data', 'security.json')).token;
    const vncB = store.sealText(JSON.stringify({ password: 'VNC-MARK-B1' }), Buffer.from(keyB, 'hex'));
    await fsp.writeFile(path.join(homes.b, 'data', 'tightvnc.json'), vncB);
    const up = await call(B, 'POST', '/api/restore/upload', undefined, { raw: bytes });
    check('BK18 「从备份恢复」 in a browser: the file uploads; what it is shows before the password', up.status === 200 && up.json?.uploadId && up.json?.backup?.counts?.bots >= 2 && up.json?.backup?.createdAt, up.text?.slice(0, 200));
    const asJsonText = await call(B, 'POST', '/api/restore/upload', undefined, { raw: bytes, type: 'text/plain' });
    check('BK19 an upload must say it is a file (another site cannot post one with text/plain)', asJsonText.status === 415, String(asJsonText.status));
    const wrong = await call(B, 'POST', '/api/restore/inspect', { uploadId: up.json?.uploadId, password: 'not the password' });
    check('BK20 a wrong password is refused in plain words', wrong.status === 400 && wrong.json?.error?.code === 'BACKUP_WRONG_PASSWORD' && /密码不对/.test(wrong.json?.error?.message || ''), wrong.text?.slice(0, 200));
    const refusal = async (buf) => {
      const u = await call(B, 'POST', '/api/restore/upload', undefined, { raw: buf });
      if (u.status !== 200) return u.json?.error || { code: `upload ${u.status}` };
      const i = await call(B, 'POST', '/api/restore/inspect', { uploadId: u.json.uploadId, password: PASSWORD });
      return i.status === 200 ? { code: 'ACCEPTED' } : i.json?.error || { code: String(i.status) };
    };
    {
      const flipped = Buffer.from(bytes);
      flipped[Math.floor(flipped.length * 0.7)] ^= 0x40;
      const e1 = await refusal(flipped);
      const e2 = await refusal(bytes.subarray(0, Math.floor(bytes.length * 0.6)));
      const lines = bytes.toString('utf8').split('\n');
      const tampered = JSON.parse(lines[1]);
      tampered.counts.bots += 5;
      const headLen = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`);
      const e3 = await refusal(Buffer.concat([Buffer.from(`${lines[0]}\n${JSON.stringify(tampered)}\n`), bytes.subarray(headLen)]));
      check('BK21 a damaged file (one byte changed, cut short, the header edited) is refused, nothing staged', [e1, e2, e3].every((e) => e.code === 'BACKUP_DAMAGED' && /坏了/.test(e.message || '')), [e1, e2, e3].map((e) => e.code).join(' '));
      // The beginner test (11-21): a file cut short showed its contents and asked for the password first.
      const cut = await call(B, 'POST', '/api/restore/upload', undefined, { raw: bytes.subarray(0, Math.floor(bytes.length * 0.6)) });
      check('BK21b a file cut short is refused as soon as it is picked, before the password (the end mark and length)', cut.status === 400 && cut.json?.error?.code === 'BACKUP_DAMAGED' && bytes.subarray(-11).toString('latin1') === 'LAMPLIT-END', `${cut.status} ${cut.text?.slice(0, 120)}`);
      const newer = Buffer.concat([Buffer.from('LAMPLIT-BACKUP 99\n'), bytes.subarray(Buffer.byteLength('LAMPLIT-BACKUP 1\n'))]);
      const e4 = await refusal(newer);
      check('BK22 a backup from a newer Lamplit is refused: update this one first', e4.code === 'BACKUP_TOO_NEW' && /更新/.test(e4.message || ''), `${e4.code} ${e4.message}`);
      const e5 = await refusal(crypto.randomBytes(3000));
      check('BK23 a file that is not a backup is refused', e5.code === 'BACKUP_NOT_A_BACKUP', e5.code);
    }
    const ins = await call(B, 'POST', '/api/restore/inspect', { uploadId: up.json?.uploadId, password: PASSWORD });
    const c = ins.json || {};
    check('BK24 with the password: the bots by name, the keys it holds, the workspace, an empty hub here',
      ins.status === 200 && c.id && c.contents?.bots?.includes('策略') && c.contents?.secrets?.length >= 2 && c.contents?.workspace?.files >= 1 && c.current?.fresh === true,
      ins.text?.slice(0, 400));
    check('BK25 the restore screen lists what is not in a backup', Array.isArray(c.notIncluded) && c.notIncluded.some((n) => /手机/.test(n.text)) && c.notIncluded.some((n) => /机器/.test(n.text)));
    {
      const staged = path.join(homes.b, 'data', '.restore', String(c.id || 'none'), 'files');
      const names = fs.existsSync(staged) ? fs.readdirSync(staged, { recursive: true }).map(String) : [];
      const leaked = names.filter((n) => { const f = path.join(staged, n); try { return /tightvnc|vnc-secure/i.test(n) || (fs.statSync(f).isFile() && fs.readFileSync(f).includes(Buffer.from('VNC-MARK-A'))); } catch { return false; } });
      check('BK57 the Windows screen passwords (TightVNC, 1.5.53) are not in a backup, not even inside it; the restore screen says so',
        names.length > 5 && !leaked.length && ['tightvnc.json', 'vnc-secure-ab12.ps1', 'vnc-secure-ab12.ps1.done', 'vnc-control-1-2.txt'].every((n) => backup.classifyDataName(n) === 'skip') && c.notIncluded?.some((n) => n.key === 'screen' && /设好密码/.test(n.text)),
        `staged ${names.length}, leaked: ${leaked.join(', ')}`);
    }
    const noConfirm = await call(B, 'POST', '/api/restore/apply', { id: c.id, mode: 'replace' });
    const badMode = await call(B, 'POST', '/api/restore/apply', { id: c.id, mode: 'everything', confirm: true });
    check('BK26 nothing is replaced without a confirm', noConfirm.status === 400 && noConfirm.json?.error?.code === 'RESTORE_CONFIRM_REQUIRED' && badMode.status === 400);
    const applied = await call(B, 'POST', '/api/restore/apply', { id: c.id, mode: 'replace', includeWorkspace: true, confirm: true });
    const pre = applied.json?.preBackup?.file || '';
    check('BK27 applying: the data here is backed up first (恢复前自动备份), then Lamplit starts again', applied.status === 200 && pre && fs.existsSync(pre) && /恢复前自动备份/.test(path.basename(pre)) && applied.json?.restarting !== undefined, applied.text?.slice(0, 300));
    check('BK28 the keys waiting for the restart are not lying around in plain text', !fs.readdirSync(path.join(homes.b, 'data'), { recursive: true }).some((n) => {
      const f = path.join(homes.b, 'data', String(n));
      try { return fs.statSync(f).isFile() && fs.readFileSync(f).includes(Buffer.from(API_KEY)); } catch { return false; }
    }));
    await stopHub(B);
    B = await startHub(homes.b, keyB);

    // --- everything works there, keys sealed with B's own key ---------------------------
    {
      const bots = (await call(B, 'GET', '/api/bots')).json || [];
      const list = Array.isArray(bots) ? bots : bots.bots || [];
      const ce = list.find((b) => b.name === '策略');
      const routines = (await call(B, 'GET', '/api/routines')).json;
      const rlist = Array.isArray(routines) ? routines : routines?.routines || [];
      const mem = ce ? (await call(B, 'GET', `/api/bots/${ce.id}/memory`)).json : null;
      const msgs = (await call(B, 'GET', '/api/bots/chief/messages')).text || '';
      const settings = (await call(B, 'GET', '/api/settings')).json || {};
      check('BK29 restored on B: the bot, its role, its memory, the routine, the chat history', Boolean(ce) && /求职/.test(ce.role || '') && /BACKUP-MEMORY-MARK/.test(mem?.memory || '') && rlist.some((r) => r.name === '早报') && msgs.includes('小林'), `${Boolean(ce)} ${mem?.memory?.slice(0, 80)} ${rlist.length} ${msgs.length}`);
      check('BK30 restored on B: the model key (the settings say a key is there)', JSON.stringify(settings).includes('"hasKey":true'), JSON.stringify(settings).slice(0, 300));
      const sealedB = box(path.join(homes.b, 'data', 'secrets.json'));
      const opened = store.openSealed(sealedB, Buffer.from(keyB, 'hex'));
      check('BK31 the model key is sealed again with B\'s own master key (A\'s does not open it)', sealedB.lamplitSealed === 1 && opened && JSON.parse(opened).apiKey === API_KEY && store.openSealed(sealedB, Buffer.from(keyA, 'hex')) === null, opened ? 'opened' : 'not opened');
      const vk = fs.readFileSync(path.join(homes.b, 'data', 'vault.key'));
      const rawKey = (() => { try { const t = store.openSealed(JSON.parse(vk.toString('utf8')), Buffer.from(keyB, 'hex')); return t ? Buffer.from(t, 'base64') : null; } catch { return null; } })();
      const entry = box(path.join(homes.b, 'data', 'vault.json')).entries?.find((e) => e.name === '京东');
      let value = null;
      try {
        const f = entry.fields['密码'];
        const d = crypto.createDecipheriv('aes-256-gcm', rawKey, Buffer.from(f.iv, 'base64'));
        d.setAuthTag(Buffer.from(f.tag, 'base64'));
        value = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
      } catch { /* stays null */ }
      check('BK32 the vault login opens on B with B\'s key (the vault key re-sealed there)', value === VAULT_VALUE, value === null ? 'did not open' : 'wrong value');
      const ws = await fsp.readFile(path.join(homes.b, 'workspace', 'notes', '计划.txt'), 'utf8').catch(() => '');
      check('BK33 the workspace files came along (asked for)', ws.includes('BACKUP-WORKSPACE-MARK'));
      check('BK34 B keeps its own pairing token (pairings are not part of a backup)', box(path.join(homes.b, 'data', 'security.json')).token === tokenBefore);
      check('BK58 B keeps its own screen passwords: a restore never touches tightvnc.json', fs.readFileSync(path.join(homes.b, 'data', 'tightvnc.json'), 'utf8') === vncB);
      const info = (await call(B, 'GET', '/api/backup')).json || {};
      check('BK35 after the restart the page can say the restore worked, and where the copy from before is', info.lastRestore?.ok === true && info.lastRestore?.preBackup && !fs.existsSync(path.join(homes.b, 'data', 'restore-pending.json')), JSON.stringify(info.lastRestore || null));
      const preUp = await call(B, 'POST', '/api/restore/peek', { from: pre });
      const preIns = await call(B, 'POST', '/api/restore/inspect', { from: pre, password: PASSWORD });
      check('BK36 the 恢复前自动备份 opens with the same password', preUp.status === 200 && preIns.status === 200 && preUp.json?.backup?.kind === 'pre-restore', `${preUp.status} ${preIns.status} ${preIns.text?.slice(0, 160)}`);
      if (preIns.json?.id) await call(B, 'POST', '/api/restore/cancel', { id: preIns.json.id });
    }

    // --- merging into a hub that has its own things ---------------------------------------
    C = await startHub(homes.c, keyC);
    await call(C, 'POST', '/api/bots', { name: 'C助手', role: '只在 C 上' });
    await call(C, 'POST', '/api/vault', { name: 'C的邮箱', values: { 密码: 'c-own-secret' } });
    await call(C, 'PUT', '/api/settings', { provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'c-model', apiKey: 'sk-c-own-key' });
    await call(C, 'POST', '/api/bots/chief/message', { text: '这是C上的聊天' });
    // A turn still running refuses a restore (RESTORE_BUSY): wait for this one to end.
    for (let i = 0; i < 100 && ((await call(C, 'GET', '/api/health')).json?.activeTurns || 0) > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    {
      const u = await call(C, 'POST', '/api/restore/upload', undefined, { raw: bytes });
      const i = await call(C, 'POST', '/api/restore/inspect', { uploadId: u.json?.uploadId, password: PASSWORD });
      check('BK37 a hub with its own bots and chats is not 「fresh」: the human chooses replace or merge', i.status === 200 && i.json?.current?.fresh === false && i.json?.current?.counts?.bots >= 2, i.text?.slice(0, 200));
      const m = await call(C, 'POST', '/api/restore/apply', { id: i.json?.id, mode: 'merge', confirm: true });
      check('BK38 merge applied', m.status === 200, m.text?.slice(0, 200));
      await stopHub(C);
      C = await startHub(homes.c, keyC);
      const bots = (await call(C, 'GET', '/api/bots')).json;
      const list = Array.isArray(bots) ? bots : bots?.bots || [];
      const names = list.map((b) => b.name);
      const msgs = (await call(C, 'GET', '/api/bots/chief/messages')).text || '';
      const secrets = JSON.parse(store.openSealed(box(path.join(homes.c, 'data', 'secrets.json')), Buffer.from(keyC, 'hex')) || '{}');
      check('BK39 merge keeps what C had (its bot, its chat, its model key) and adds what it lacked (策略, the routine)',
        names.includes('C助手') && names.includes('策略') && names.filter((n) => n === '策略').length === 1 && msgs.includes('这是C上的聊天') && secrets.apiKey === 'sk-c-own-key' && ((await call(C, 'GET', '/api/routines')).text || '').includes('早报'),
        `${names.join(',')} key=${secrets.apiKey === 'sk-c-own-key'}`);
      const rawC = (() => { try { const t = store.openSealed(JSON.parse(fs.readFileSync(path.join(homes.c, 'data', 'vault.key'), 'utf8')), Buffer.from(keyC, 'hex')); return t ? Buffer.from(t, 'base64') : null; } catch { return null; } })();
      const entries = box(path.join(homes.c, 'data', 'vault.json')).entries || [];
      const openField = (e, label) => { try { const f = e.fields[label]; const d = crypto.createDecipheriv('aes-256-gcm', rawC, Buffer.from(f.iv, 'base64')); d.setAuthTag(Buffer.from(f.tag, 'base64')); return Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'); } catch { return null; } };
      check('BK40 merged vault: C\'s own login and the one from the backup both open with C\'s key (re-encrypted)',
        openField(entries.find((e) => e.name === 'C的邮箱') || {}, '密码') === 'c-own-secret' && openField(entries.find((e) => e.name === '京东') || {}, '密码') === VAULT_VALUE,
        entries.map((e) => e.name).join(','));
    }

    // --- another machine, backed up from here (human only) ------------------------------
    {
      const secA = box(path.join(homes.a, 'data', 'security.json'));
      // Sealed since 1.5.54 (review L6): open it with A's master key.
      const tokenA = (secA?.lamplitSealed ? JSON.parse(store.openSealed(secA, Buffer.from(keyA, 'hex')) || '{}') : secA).token;
      await call(B, 'PUT', '/api/peers', { peers: [{ name: '源机器', url: A.base, token: tokenA }] });
      const asBot = await call(B, 'POST', `/api/peers/${encodeURIComponent('源机器')}/backup`, { password: PASSWORD }, { bot: true });
      const far = await call(B, 'POST', `/api/peers/${encodeURIComponent('源机器')}/backup`, { password: PASSWORD });
      const farHead = (() => { try { return JSON.parse(far.bytes.toString('utf8').split('\n')[1]); } catch { return null; } })();
      check('BK41 「也备份」 another machine: its own backup comes back to this computer; not for a bot', asBot.status === 403 && far.status === 200 && far.bytes?.subarray(0, 16).toString() === 'LAMPLIT-BACKUP 1' && farHead?.counts?.routines === 1, `${asBot.status} ${far.status} ${far.text?.slice(0, 160)}`);
      const list = (await call(B, 'GET', '/api/backup')).json?.peers || [];
      check('BK42 the backup page names the other machines (each backs up itself)', list.includes('源机器'), JSON.stringify(list));
    }

    // --- automatic backups to a folder, keeping the last N ------------------------------
    {
      const folder = path.join(tmp, 'auto');
      const noPass = await call(A, 'POST', '/api/backup/schedule', { enabled: true, folder, keep: 2, everyHours: 24 });
      const on = await call(A, 'POST', '/api/backup/schedule', { enabled: true, folder, keep: 2, everyHours: 24, password: PASSWORD });
      check('BK43 automatic backups need a folder and a password (asked once, kept sealed)', noPass.status === 400 && on.status === 200 && on.json?.schedule?.enabled && on.json?.schedule?.hasPassword && !JSON.stringify(on.json).includes(PASSWORD), `${noPass.status} ${on.status} ${on.text?.slice(0, 200)}`);
      const keyFile = path.join(homes.a, 'data', 'backup-key.json');
      check('BK44 the kept backup key is sealed with this computer\'s master key, never the password itself', fs.existsSync(keyFile) && box(keyFile).lamplitSealed === 1 && !fs.readFileSync(keyFile, 'utf8').includes(PASSWORD));
      for (let i = 0; i < 3; i += 1) await call(A, 'POST', '/api/backup/schedule/run');
      const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => n.endsWith('.lamplit')) : [];
      check('BK45 「现在备份一次」 three times with keep 2: the last two stay', files.length === 2 && files.every((n) => /^Lamplit-自动备份-/.test(n)), files.join(', '));
      if (files[0]) {
        const u = await call(B, 'POST', '/api/restore/peek', { from: path.join(folder, files[0]) });
        const i = await call(B, 'POST', '/api/restore/inspect', { from: path.join(folder, files[0]), password: PASSWORD });
        check('BK46 an automatic backup opens with the password set for it', u.status === 200 && i.status === 200 && u.json?.backup?.kind === 'auto', `${u.status} ${i.status}`);
        if (i.json?.id) await call(B, 'POST', '/api/restore/cancel', { id: i.json.id });
      }
      const info = (await call(A, 'GET', '/api/backup')).json || {};
      check('BK47 the page shows when the last automatic backup ran', Boolean(info.schedule?.lastAuto?.at) && info.schedule?.lastAuto?.ok === true, JSON.stringify(info.schedule || null).slice(0, 200));
      const off = await call(A, 'POST', '/api/backup/schedule', { enabled: false });
      check('BK48 turning it off forgets the kept key', off.status === 200 && !fs.existsSync(keyFile));
    }

    // --- the page and the desktop app --------------------------------------------------
    {
      const page = await readText('../public/index.html');
      const main = await readText('../desktop/main.mjs');
      const preload = await readText('../desktop/shell-preload.cjs');
      const guard = await readText('../desktop/guard.mjs');
      const sw = await readText('../public/sw.js');
      check('BK49 设置 → 通用 → 备份: 「备份到文件…」, 「从备份恢复…」, the last backup, automatic backups',
        page.includes('data-set-target="sec-backup"') && page.includes('id="sec-backup"') && page.includes('备份到文件…') && page.includes('从备份恢复…') && page.includes('id="backup-last"') && page.includes('id="backup-auto"'));
      check('BK50 the desktop app asks where with its own save / open / folder dialogs, from this computer\'s page only',
        /handle\('desk:pick-backup-save'/.test(main) && /handle\('desk:pick-backup-open'/.test(main) && /handle\('desk:pick-folder'/.test(main) && /pickBackupSave/.test(preload) && /pickBackupOpen/.test(preload) && /pickFolder/.test(preload)
        && /'desk:pick-backup-save'/.test(guard) && /'desk:pick-backup-open'/.test(guard) && /'desk:pick-folder'/.test(guard));
      check('BK51 the page part is fetched fresh like the others (1.5.55: the worker keeps no part)', !sw.includes('/app/main/13-backup.js') && page.includes('function loadBackup'));
      check('BK52 the restore screen asks before replacing and says the data here is backed up first', page.includes('恢复前自动备份') && /window\.confirm\(/.test(page.slice(page.indexOf('function loadBackup'))));
      check('BK53 全部机器: each machine backs itself up, and another machine can be backed up from here', page.includes('每台机器各自备份') && page.includes('也备份'));
      // What the beginner test found (11-21).
      const brief = await call(B, 'GET', '/api/backup?brief=1');
      check('BK54 after the restart any page says the restore worked (a quick ask at start, no walk through the workspace)',
        brief.status === 200 && brief.json?.lastRestore?.ok === true && !('workspace' in (brief.json || {})) && page.includes("api('/api/backup?brief=1', { quiet: true })") && page.includes('toast(restoreReport(r)'), brief.text?.slice(0, 160));
      check('BK55 a browser not paired yet that picks a file is asked to pair, and the upload goes on after; the 恢复前自动备份 folder is read again',
        page.includes("if (j?.error?.code === 'LOCAL_KEY_REQUIRED')") && page.includes('restoreUpload(file); } };') && page.includes('if (!backupState.info) await loadBackup()'));
      check('BK56 of what is not in a backup, the re-pairing stays in sight and the rest folds', page.includes('恢复后：${first.text}') && !/out\.open = true/.test(page.slice(page.indexOf('function renderRestoreChoice'))));
    }
  } finally {
    await stopHub(A);
    await stopHub(B);
    await stopHub(C);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
