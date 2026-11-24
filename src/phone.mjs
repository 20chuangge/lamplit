// The human's Android phone as something a bot can work (1.3.0, step one).
//
// The phone is plugged into this computer (or on the same Wi-Fi) with USB
// debugging on; everything goes through adb: a screenshot and the screen's
// accessibility tree to look, `input` to tap, swipe, type and press keys, and
// `monkey` to open an app. Plain text goes in with `input text`; anything else
// (Chinese) goes through the Lamplit app on the phone, which puts it on the
// clipboard (PhoneTypeProvider, only adb may call it) and is pasted.
//
// Never: unlock the phone (a locked or dark screen stops every action and the
// bot asks the human), or type into a password box.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { saveInside, statInside } from './safefs.mjs';
import { hubTmp } from './store.mjs';

const LAMPLIT_PACKAGE = 'com.desk.assistant';

/** Everyday names of common apps -> package. A package name works too. */
export const KNOWN_APPS = {
  小红书: 'com.xingin.xhs', 微信: 'com.tencent.mm', 抖音: 'com.ss.android.ugc.aweme', 淘宝: 'com.taobao.taobao',
  支付宝: 'com.eg.android.AlipayGphone', 微博: 'com.sina.weibo', B站: 'tv.danmaku.bili', 哔哩哔哩: 'tv.danmaku.bili',
  飞书: 'com.ss.android.lark', 钉钉: 'com.alibaba.android.rimet', QQ: 'com.tencent.mobileqq', 京东: 'com.jingdong.app.mall',
  美团: 'com.sankuai.meituan', 高德地图: 'com.autonavi.minimap', 知乎: 'com.zhihu.android', 拼多多: 'com.xunmeng.pinduoduo',
  快手: 'com.smile.gifmaker', 网易云音乐: 'com.netease.cloudmusic', 大众点评: 'com.dianping.v1', 携程: 'ctrip.android.view',
  设置: 'com.android.settings', Chrome: 'com.android.chrome', 浏览器: 'com.heytap.browser', 相机: 'com.oplus.camera',
  // 1.5.11: the job-search team asked for "BOSS直聘" by name.
  BOSS直聘: 'com.hpbr.bosszhipin', 猎聘: 'com.lietou.mishu', 智联招聘: 'com.zhaopin.social', 前程无忧: 'com.job.android',
  企业微信: 'com.tencent.wework', 腾讯会议: 'com.tencent.wemeet.app', 闲鱼: 'com.taobao.idlefish', 饿了么: 'me.ele',
  百度: 'com.baidu.searchbox', 今日头条: 'com.ss.android.article.news', 微信读书: 'com.tencent.weread', 夸克: 'com.quark.browser',
  Lamplit: LAMPLIT_PACKAGE,
};
const APP_NAMES = Object.fromEntries(Object.entries(KNOWN_APPS).map(([name, pkg]) => [pkg, name]));
// The home screen has a package per maker; it is still 手机桌面 (1.3.1).
for (const pkg of ['com.android.launcher', 'com.android.launcher3', 'com.oppo.launcher', 'com.miui.home', 'com.huawei.android.launcher', 'com.hihonor.android.launcher', 'com.bbk.launcher2', 'com.sec.android.app.launcher', 'com.google.android.apps.nexuslauncher']) APP_NAMES[pkg] = '手机桌面';
export const appLabel = (pkg) => APP_NAMES[pkg] || pkg || '';

/** Taps that pay, send, publish or delete: always asked, every time. */
/**
 * What a sensitive tap would do (1.5.25): paying always asks; sending,
 * publishing, agreeing and deleting can be let through per bot and app once
 * the human said so on a card (phone_allow).
 */
export function phoneStepKind(words) {
  const w = String(words || '');
  if (/支付|付款|转账|买单|购买|下单|提交订单|充值|\b(pay|buy|purchase|confirm payment)\b/i.test(w)) return 'pay';
  if (/删除|清空|卸载|注销|退出登录|\b(delete|remove|uninstall)\b/i.test(w)) return 'delete';
  if (/发布|发表|\b(post|publish)\b/i.test(w)) return 'publish';
  if (/授权|同意|接受|允许|\b(agree|accept|allow)\b/i.test(w)) return 'agree';
  if (/发送|评论|回复|\bsend\b/i.test(w)) return 'send';
  return 'pay'; // unknown: treated like the strictest
}
export const PHONE_KIND_LABEL = { send: '发消息', publish: '发布', agree: '点同意', delete: '删除', pay: '付款' };

export const SENSITIVE_TAP = /支付|付款|转账|买单|购买|下单|提交订单|充值|发布|发送|发表|评论|回复|删除|清空|卸载|注销|退出登录|授权|同意|接受|允许|\b(pay|buy|purchase|send|post|publish|delete|remove|uninstall|confirm payment|agree|accept|allow)\b/i;

/** A box for searching: pressing enter there looks things up, it sends nothing. */
const SEARCH_BOX = /search|搜索|查找|搜一搜|query/i;
/** What the × in an input box is called. */
const CLEAR_WORDS = /^(全部删除|清除|清空|清除内容|删除文字|删除内容|clear( all| text)?|×|x|ic_clear|clear_btn|iv_clear|btn_clear|search_clear)$/i;

/**
 * A shell command that runs adb: it would work the phone around the phone
 * tool's rules (always asking before paying or posting, never unlocking).
 */
export function adbInShell(command) {
  const m = /(^|[\s;&|(])["']?(?:[^\s"';&|]*[\\/])?adb(?:\.exe)?["']?(?=\s|$)/i.exec(String(command || ''));
  return m ? 'adb' : '';
}

const KEYS = { back: 4, home: 3, enter: 66, recent: 187, delete: 67, search: 84, menu: 82, paste: 279 };

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** ".jpg" for JPEG bytes, else ".png" (adb's screencap is PNG). */
export function imageExt(bytes) {
  return bytes && bytes[0] === 0xff && bytes[1] === 0xd8 ? '.jpg' : '.png';
}

// ---- reading what adb says --------------------------------------------------

export function parseDevices(text) {
  return String(text || '').split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const model = (rest.find((x) => x.startsWith('model:')) || '').slice(6).replace(/_/g, ' ');
    return { serial, state, model };
  }).filter((d) => d.serial && d.state);
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&') : '';
};

/** The screen as a flat list of things a bot can read or press. */
export function parseUi(xml) {
  const nodes = [];
  let app = '';
  for (const m of String(xml || '').matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr(tag, 'bounds'));
    if (!b) continue;
    const [l, t, r, bt] = b.slice(1).map(Number);
    const cls = attr(tag, 'class');
    const node = {
      text: attr(tag, 'text').trim(),
      desc: attr(tag, 'content-desc').trim(),
      id: attr(tag, 'resource-id').replace(/^.*:id\//, ''),
      cls: cls.split('.').pop(),
      x: Math.round((l + r) / 2),
      y: Math.round((t + bt) / 2),
      bounds: [l, t, r, bt],
      clickable: attr(tag, 'clickable') === 'true',
      editable: /EditText|AutoCompleteTextView/.test(cls),
      focused: attr(tag, 'focused') === 'true',
      scrollable: attr(tag, 'scrollable') === 'true',
      password: attr(tag, 'password') === 'true',
    };
    if (!app) app = attr(tag, 'package');
    if (r <= l || bt <= t) continue;
    if (!node.text && !node.desc && !node.clickable && !node.editable && !node.scrollable) continue;
    nodes.push(node);
  }
  nodes.forEach((n, i) => { n.i = i; });
  return { app, nodes };
}

/** Locked (or dark) and the app in front, from `dumpsys window`. */
export function parseWindow(text) {
  const s = String(text || '');
  const locked = /isKeyguardShowing=true|mDreamingLockscreen=true|mShowingLockscreen=true/.test(s);
  const focus = /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(s) || /mFocusedApp=\S+\{\S+ \S+ ([\w.]+)\//.exec(s);
  return { locked, app: focus ? focus[1] : '' };
}

/** Where adb is: the human's setting, LAMPLIT_ADB / ADB, the Android SDK, PATH. */
export function findAdb({ configured = '', env = process.env, exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const sdkDirs = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'), path.join(os.homedir(), 'Library', 'Android', 'sdk')].filter(Boolean);
  const candidates = [configured, env.LAMPLIT_ADB, env.ADB, ...sdkDirs.map((d) => path.join(d, 'platform-tools', exe)),
    ...String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))];
  for (const c of candidates) if (c && exists(c)) return c;
  return '';
}

function runAdb(file, args, { timeout = 20000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve({ stdout });
    });
  });
}

/** `input text` takes ASCII only, with spaces as %s and shell characters escaped. */
function plainText(text) {
  return /^[\x20-\x7e]*$/.test(text) && !text.includes('%');
}
function inputTextArg(text) {
  return text.replace(/([\\"'`$&|;<>()*?#~!\[\]{}])/g, '\\$1').replace(/ /g, '%s');
}

// ---- workspace files into the phone's album (1.5.65) -------------------------
//
// A bot on the cloud had to post 9 pictures from the phone; they were in its
// workspace, not in the phone's album, so it put them on public file hosts one
// by one to download them on the phone. Now save_to_album puts workspace files
// on the human's own phone, never through anyone else:
//   - on the cable: adb push to /sdcard/DCIM/Lamplit (other files: Download/Lamplit),
//     each file's time set, then the phone's media scan;
//   - through the Lamplit app (no cable, or this is another machine): the app
//     fetches each file from this machine over its paired connection and saves it
//     through MediaStore (phonelink.mjs, GET /api/phone/files/:token).
// The first file is the newest, the next a second older and so on, so the
// gallery and 「从相册选择」 (newest first) show them first, in the given order.

export const ALBUM_MAX_FILES = 50;
export const ALBUM_MAX_BYTES = 200 * 1024 * 1024;
export const ALBUM_DIR = 'DCIM/Lamplit';
export const DOWNLOAD_DIR = 'Download/Lamplit';
/** The phone app that can save files (its save_media step). */
export const ALBUM_APP_VERSION = '1.5.65';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.3gp': 'video/3gpp', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};
const FILE_TYPES = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.apk': 'application/vnd.android.package-archive',
};

/** image / video go to the album, anything else to Downloads. -> {kind, mime} */
export function mediaKind(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const media = MEDIA_TYPES[ext];
  if (media) return { kind: media.startsWith('image/') ? 'image' : 'video', mime: media };
  return { kind: 'file', mime: FILE_TYPES[ext] || 'application/octet-stream' };
}

/** A name safe on the phone and in a shell there: no folders, quotes or control characters; a tag keeps it unique. */
export function phoneFileName(name, tag = '') {
  const base = path.basename(String(name || '').replace(/\\/g, '/')) || 'file';
  const ext = path.extname(base).toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
  const stem = base.slice(0, base.length - path.extname(base).length)
    .replace(/[\\/:*?"<>|'`$!&;(){}[\]#~%^\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/^[.\-_]+/, '').slice(0, 60) || 'file';
  return `${stem}${tag ? `_${tag}` : ''}${ext}`;
}

/**
 * Each file's name, folder and time on the phone, in the given order: the first
 * is the newest (now), each next one a second older. Saved last file first.
 */
export function albumPlan(files, { now = Date.now() } = {}) {
  const sec = Math.floor(now / 1000);
  const tag = sec.toString(36);
  return (files || []).map((f, i) => {
    const { kind, mime } = mediaKind(f.name || f.abs);
    return { ...f, kind, mime, folder: kind === 'file' ? DOWNLOAD_DIR : ALBUM_DIR, phoneName: phoneFileName(f.name || f.abs, `${tag}${String(i + 1).padStart(2, '0')}`), time: sec - i, order: i };
  });
}

/** One argument for `adb shell` (the phone's shell joins them into one line). */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The adb command lines that put the planned files on a phone on the cable:
 * copy (push + its time, last file first), then one media scan through the
 * Lamplit app (1.5.65 and newer), and the system's scan broadcast for each
 * file when the app did not take it. local(item) is the file on this computer.
 */
export function adbAlbumCommands(serial, items, local = (it) => it.abs) {
  const copy = [];
  const remotes = [];
  for (const it of [...items].reverse()) {
    const remote = `/sdcard/${it.folder}/${it.phoneName}`;
    remotes.unshift(remote);
    copy.push(['-s', serial, 'push', local(it), remote]);
    copy.push(['-s', serial, 'shell', 'touch', '-d', `@${it.time}`, shellQuote(remote)]);
  }
  const scan = ['-s', serial, 'shell', 'content', 'call', '--uri', `content://${LAMPLIT_PACKAGE}.phonetype`, '--method', 'scan', '--arg', Buffer.from(remotes.join('\n'), 'utf8').toString('base64')];
  const broadcast = remotes.map((r) => ['-s', serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', shellQuote(`file://${r}`)]);
  return { copy, scan, broadcast, remotes };
}

/**
 * The workspace files a bot named, checked like every read of the workspace
 * (safefs: a link out of it is refused), with the caps. -> [{rel, abs, root, name, size}]
 */
export async function albumFiles(root, paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!list.length) throw fail('PHONE_BAD_ARGS', 'save_to_album needs paths: the workspace files to put on the phone, in the order you want them');
  if (list.length > ALBUM_MAX_FILES) throw fail('PHONE_TOO_MANY_FILES', `at most ${ALBUM_MAX_FILES} files at a time (you gave ${list.length}): do them in parts`);
  const rootAbs = path.resolve(root);
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const raw of list) {
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^workspace\//, '');
    const abs = path.resolve(rootAbs, rel);
    if (!abs.startsWith(rootAbs + path.sep)) throw fail('PHONE_OUTSIDE_WORKSPACE', `only files in the workspace can go to the phone (${raw} is not)`);
    if (seen.has(abs)) continue;
    let st;
    try {
      const { fh, stat } = await statInside(rootAbs, abs);
      await fh.close().catch(() => {});
      st = stat;
    } catch (err) {
      if (err.code === 'PATH_OUTSIDE_WORKSPACE') throw fail('PHONE_OUTSIDE_WORKSPACE', `only files in the workspace can go to the phone (${raw} leads outside it)`);
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw fail('PHONE_FILE_NOT_FOUND', `no such file in the workspace: ${rel}`);
      if (err.code === 'EISDIR' || err.code === 'EPERM' || err.code === 'EACCES') {
        const isDir = await fsp.stat(abs).then((s) => s.isDirectory()).catch(() => false);
        if (isDir) throw fail('PHONE_BAD_ARGS', `${rel} is a folder: name the files in it`);
      }
      throw fail('PHONE_FILE_NOT_FOUND', `cannot read ${rel}: ${err.message}`);
    }
    if (!st.isFile()) throw fail('PHONE_BAD_ARGS', `${rel} is not a file`);
    total += st.size;
    if (total > ALBUM_MAX_BYTES) throw fail('PHONE_FILES_TOO_LARGE', `at most ${ALBUM_MAX_BYTES / (1024 * 1024)} MB at a time: do them in parts`);
    seen.add(abs);
    out.push({ rel: path.relative(rootAbs, abs).split(path.sep).join('/'), abs, root: rootAbs, name: path.basename(abs), size: st.size });
  }
  return out;
}

/** Copy a checked workspace file to `dest` (a folder of the hub's own), streamed. */
async function copyOut(root, abs, dest) {
  const { fh, stat } = await statInside(root, abs);
  try {
    if (stat.size > ALBUM_MAX_BYTES) throw fail('PHONE_FILES_TOO_LARGE', 'the file grew past the limit');
    await pipeline(fh.createReadStream({ autoClose: false }), fs.createWriteStream(dest, { mode: 0o600 }));
  } finally {
    await fh.close().catch(() => {});
  }
}

export const albumOldAppMessage = (adbHere) => `The Lamplit app on the phone is too old to save files: the human needs to update it to ${ALBUM_APP_VERSION} or newer (Lamplit on the phone → 设置 → 检查更新).`
  + (adbHere ? ' Or plug the phone into this computer with USB debugging on: then the files go over the cable.' : ' Until then, plugging it into a computer with Lamplit and USB debugging on works too.')
  + ' Never put the files on a public file host instead.';

/** The bots' guidance (1.5.65): for bots that work the phone, and for every bot. */
export const PHONE_FILES_RULE = 'Files the phone needs (pictures or a video to post from an app there, a document to open): put them on it with phone save_to_album, paths in the order you want - they become the newest in the gallery, so in 「从相册选择」 pick them from the top. If the Lamplit app there is too old for it, tell the human to update it; do not find another way.';
export const NO_PUBLIC_HOST_RULE = 'Never upload the human\'s files to a public file host, a paste site or a temporary download link to move them between the human\'s own devices: onto the phone use phone save_to_album, between machines file_send / file_fetch. If none of those can do it, ask the human.';

/** What a save did, for the bot and the turn's receipt. */
export function albumSummary(items, result = {}, via = '') {
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const bad = new Set(failed.map((f) => Number(f.order)));
  const ok = items.filter((it) => !bad.has(it.order));
  const pictures = ok.filter((it) => it.kind === 'image').length;
  const videos = ok.filter((it) => it.kind === 'video').length;
  const album = pictures + videos;
  const downloads = ok.length - album;
  return {
    done: ok.length > 0,
    via,
    album,
    pictures,
    videos,
    downloads,
    saved: ok.map((it) => ({ path: it.rel, phone: `${it.folder}/${it.phoneName}` })),
    ...(failed.length ? { failed: failed.map((f) => ({ path: items.find((it) => it.order === Number(f.order))?.rel || '', why: String(f.why || f.message || '').slice(0, 200) })) } : {}),
    note: album
      ? `${album} picture(s)/video(s) are now the newest in the phone's gallery (album 「Lamplit」), in the order given: in 「从相册选择」 the first one is at the top left.${downloads ? ` ${downloads} other file(s) are in Downloads/Lamplit.` : ''}`
      : `${downloads} file(s) are in the phone's Downloads/Lamplit folder.`,
  };
}

// ---- the phone --------------------------------------------------------------

export function createPhone({ adb, exec = runAdb, workspaceDir, tmpDir = () => hubTmp('album') }) {
  const lastUi = new Map(); // serial -> {at, app, nodes}
  let lastSerial = '';

  const adbPath = () => {
    const p = typeof adb === 'function' ? adb() : adb;
    if (!p) throw fail('ADB_NOT_FOUND', 'adb is not on this computer. The human needs Android platform-tools (adb) here and the phone plugged in with USB debugging on; Settings → 机器 → 手机 says where adb is.');
    return p;
  };
  const run = async (args, opts) => {
    try {
      return await exec(adbPath(), args, opts);
    } catch (err) {
      // The app's own answers (locked, a password box, no answer) keep their meaning (1.4.0).
      if (err.code === 'ADB_NOT_FOUND' || /^PHONE_/.test(String(err.code || ''))) throw err;
      if (err.code === 'ENOENT') throw fail('ADB_NOT_FOUND', `adb was not found at ${adbPath()}`);
      throw fail('PHONE_ADB_FAILED', `adb ${args.slice(0, 3).join(' ')} failed: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
    }
  };
  const text = async (args, opts) => {
    const { stdout } = await run(args, opts);
    return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  };

  async function devices() {
    return parseDevices(await text(['devices', '-l'], { timeout: 10000 }));
  }

  /** The phone meant: the one asked for (serial or model), else the only one. */
  async function pick(device, { remember = true } = {}) {
    const list = await devices();
    const ready = list.filter((d) => d.state === 'device');
    const want = String(device || '').trim().toLowerCase();
    if (want) {
      const hit = list.find((d) => d.serial.toLowerCase() === want || d.model.toLowerCase() === want) || list.find((d) => d.model.toLowerCase().includes(want));
      if (!hit) throw fail('PHONE_NOT_CONNECTED', `no phone "${device}" on this computer; connected: ${list.map((d) => `${d.model || d.serial} (${d.state})`).join(', ') || 'none'}`);
      if (hit.state !== 'device') throw fail('PHONE_NOT_READY', stateHelp(hit));
      if (remember) lastSerial = hit.serial;
      return hit.serial;
    }
    if (!ready.length) {
      const odd = list[0];
      const gone = typeof exec.whyGone === 'function' ? exec.whyGone() : '';
      throw fail(odd ? 'PHONE_NOT_READY' : 'PHONE_NOT_CONNECTED', odd ? stateHelp(odd) : gone ? `no phone answers right now.${gone}` : 'no phone can be used from here. Ask the human to turn on 「让机器人用这部手机」 in the Lamplit app on the phone (Settings → 机器 → 手机), or to plug it into this computer with USB debugging on.');
    }
    if (ready.length > 1 && !ready.some((d) => d.serial === lastSerial)) {
      throw fail('PHONE_WHICH', `more than one phone is connected (${ready.map((d) => d.model || d.serial).join(', ')}); say which with device`);
    }
    const chosen = ready.find((d) => d.serial === lastSerial)?.serial || ready[0].serial;
    if (remember) lastSerial = chosen;
    return chosen;
  }
  const stateHelp = (d) => (d.state === 'unauthorized'
    ? `the phone ${d.model || d.serial} has not allowed this computer yet: ask the human to unlock it and tap 允许 on the USB debugging prompt`
    : `the phone ${d.model || d.serial} is ${d.state}; ask the human to check the cable and USB debugging`);

  async function windowState(serial) {
    return parseWindow(await text(['-s', serial, 'shell', 'dumpsys', 'window'], { timeout: 10000 }));
  }

  /**
   * Every action that touches the screen first checks the phone is unlocked.
   * Screen off (1.5.17): light it once and put away a lock screen that needs no
   * code (the phone decides: no PIN, or Smart Lock trusts it). A PIN, pattern
   * or password stays the human's.
   */
  async function ensureOpen(serial) {
    let w = await windowState(serial);
    if (w.locked) {
      try {
        await run(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
        await run(['-s', serial, 'shell', 'wm', 'dismiss-keyguard']);
        await new Promise((r) => setTimeout(r, 800));
        w = await windowState(serial);
      } catch { /* stays locked */ }
    }
    if (w.locked) {
      throw fail('PHONE_LOCKED', 'The phone is locked: the screen was lit, but it needs the human\'s PIN, pattern, fingerprint or face. Ask the human to unlock it, then go on when they say so. Never try to unlock it yourself and never type a PIN or password. (If they want the bots to use it while they are away: Smart Lock / 智能解锁 in the phone\'s security settings keeps it unlocked at home, or no lock screen.)');
    }
    return w;
  }

  async function readUi(serial) {
    const xml = await text(['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 30000 });
    const ui = parseUi(xml);
    lastUi.set(serial, { at: Date.now(), ...ui });
    return ui;
  }

  const brief = (n) => ({
    i: n.i,
    ...(n.text ? { text: n.text.slice(0, 80) } : {}),
    ...(n.desc ? { desc: n.desc.slice(0, 80) } : {}),
    ...(n.id ? { id: n.id } : {}),
    kind: n.editable ? 'input' : n.scrollable ? 'list' : n.clickable ? 'button' : 'text',
    at: [n.x, n.y],
    ...(n.focused ? { focused: true } : {}),
    ...(n.password ? { password: true } : {}),
  });

  /** The node meant by target (its words), index, or a point. */
  function findNode(serial, { target, index, x, y } = {}) {
    const ui = lastUi.get(serial);
    const nodes = ui?.nodes || [];
    if (Number.isInteger(index)) return nodes[index] || null;
    if (target) {
      const want = String(target).trim().toLowerCase();
      const exact = nodes.find((n) => [n.text, n.desc, n.id].some((v) => v && v.toLowerCase() === want));
      return exact || nodes.find((n) => [n.text, n.desc].some((v) => v && v.toLowerCase().includes(want))) || null;
    }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const under = nodes.filter((n) => x >= n.bounds[0] && x <= n.bounds[2] && y >= n.bounds[1] && y <= n.bounds[3]);
      return under.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]))[0] || null;
    }
    return null;
  }

  async function look({ device, path: want } = {}) {
    const serial = await pick(device);
    const w = await ensureOpen(serial);
    const day = new Date().toISOString().slice(0, 10);
    const { stdout } = await run(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 45000, binary: true });
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
    // The app sends JPEG (a full-size PNG took ~37 s over the network, 1.4.0); name it for what it is.
    const ext = imageExt(bytes);
    let rel = want ? String(want).replace(/\\/g, '/') : `phone/${day}/screen-${Date.now()}${ext}`;
    if (want && !rel.toLowerCase().endsWith(ext)) rel = rel.replace(/\.(png|jpe?g)$/i, '') + ext;
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw fail('PHONE_BAD_ARGS', 'path must stay inside the workspace');
    const abs = path.join(workspaceDir, rel);
    // 1.5.60 (the verifier's F1): folders one level at a time, the file through the checked open.
    try { await saveInside(workspaceDir, abs, bytes); } catch (err) { if (err.code === 'PATH_OUTSIDE_WORKSPACE') throw fail('PHONE_BAD_ARGS', 'path leads outside the workspace through a link'); throw err; }
    const ui = await readUi(serial).catch(() => ({ app: w.app, nodes: [] }));
    const app = w.app || ui.app;
    return {
      screenshot: rel,
      app,
      appName: appLabel(app),
      elements: ui.nodes.slice(0, 150).map(brief),
      ...(ui.nodes.length > 150 ? { more: ui.nodes.length - 150 } : {}),
      note: ui.nodes.length
        ? 'Tap with target (the words), index (i) or x/y (at). To see pictures or what the list misses, look at the screenshot with image_view.'
        : 'This screen exposes nothing readable (a game, video or web view): look at the screenshot with image_view and tap by x/y.',
    };
  }

  async function where(serial, args) {
    if (Number.isFinite(args.x) && Number.isFinite(args.y) && !args.target && !Number.isInteger(args.index)) return { x: Math.round(args.x), y: Math.round(args.y), node: findNode(serial, args) };
    if (!lastUi.get(serial) || Date.now() - lastUi.get(serial).at > 60000) await readUi(serial);
    let node = findNode(serial, args);
    if (!node && args.target) { await readUi(serial); node = findNode(serial, args); }
    if (!node) throw fail('PHONE_NOT_ON_SCREEN', `"${args.target ?? args.index}" is not on the screen now; look again`);
    return { x: node.x, y: node.y, node };
  }

  async function tap(args = {}) {
    const serial = await pick(args.device);
    const w = await ensureOpen(serial);
    const p = await where(serial, args);
    if (args.long) await run(['-s', serial, 'shell', 'input', 'swipe', String(p.x), String(p.y), String(p.x), String(p.y), '800']);
    else await run(['-s', serial, 'shell', 'input', 'tap', String(p.x), String(p.y)]);
    lastUi.delete(serial);
    return { done: true, tapped: p.node ? (p.node.text || p.node.desc || p.node.id || `${p.x},${p.y}`) : `${p.x},${p.y}`, app: w.app, note: 'Look again to see what happened.' };
  }

  async function swipe(args = {}) {
    const serial = await pick(args.device);
    await ensureOpen(serial);
    const size = /(\d+)x(\d+)/.exec(await text(['-s', serial, 'shell', 'wm', 'size']));
    const W = size ? Number(size[1]) : 1080;
    const H = size ? Number(size[2]) : 2400;
    const d = String(args.direction || 'up');
    // "up" moves the content up (scrolls down the page), like a finger going up.
    const lines = { up: [W / 2, H * 0.75, W / 2, H * 0.3], down: [W / 2, H * 0.3, W / 2, H * 0.75], left: [W * 0.85, H / 2, W * 0.15, H / 2], right: [W * 0.15, H / 2, W * 0.85, H / 2] };
    const [x1, y1, x2, y2] = Array.isArray(args.from) && Array.isArray(args.to) ? [...args.from, ...args.to] : (lines[d] || lines.up);
    await run(['-s', serial, 'shell', 'input', 'swipe', ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(Math.round(Number(args.ms) || 350))]);
    lastUi.delete(serial);
    return { done: true, note: 'Look again to see the new part of the screen.' };
  }

  async function type(args = {}) {
    const serial = await pick(args.device);
    await ensureOpen(serial);
    const value = String(args.text ?? '');
    if (!value) throw fail('PHONE_BAD_ARGS', 'say what text to type');
    if (args.target !== undefined || Number.isInteger(args.index)) {
      const p = await where(serial, args);
      if (p.node?.password) throw fail('PHONE_PASSWORD_FIELD', 'that is a password box: the human types passwords themselves. Ask them to.');
      await run(['-s', serial, 'shell', 'input', 'tap', String(p.x), String(p.y)]);
    }
    const ui = await readUi(serial).catch(() => null);
    const focused = ui?.nodes.find((n) => n.focused && n.editable);
    if (focused?.password) throw fail('PHONE_PASSWORD_FIELD', 'the box with the cursor is a password box: the human types passwords themselves. Ask them to.');
    if (plainText(value)) {
      await run(['-s', serial, 'shell', 'input', 'text', inputTextArg(value)]);
    } else {
      // Chinese and other text: the Lamplit app puts it on the clipboard, then paste.
      // A provider call, not a broadcast: ColorOS dropped the broadcast (1.3.1).
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      const callType = () => text(['-s', serial, 'shell', 'content', 'call', '--uri', `content://${LAMPLIT_PACKAGE}.phonetype`, '--method', 'type', '--arg', b64]).catch((err) => String(err.message || ''));
      let out = await callType();
      // Lamplit not running: ColorOS will not start it for a provider call.
      // An invisible screen of Lamplit's (it closes at once) brings the
      // process up without covering the app being typed into; then wait
      // until the provider answers (a cold start takes a few seconds).
      // Also when the app answered but could not take the text (held back in
      // the background, 1.3.1 on ColorOS): wake it and try once more.
      if (!/ok=true/.test(out)) {
        const before = await windowState(serial);
        await run(['-s', serial, 'shell', 'am', 'start', '-W', '-n', `${LAMPLIT_PACKAGE}/.WakeActivity`], { timeout: 15000 }).catch(() => {});
        for (let i = 0; i < 16; i += 1) {
          const probe = await text(['-s', serial, 'shell', 'content', 'call', '--uri', `content://${LAMPLIT_PACKAGE}.phonetype`, '--method', 'probe']).catch((err) => String(err.message || ''));
          if (/ok=true/.test(probe)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        // Should Lamplit itself have come to the front, go back to where the typing goes.
        if (before.app && before.app !== LAMPLIT_PACKAGE && (await windowState(serial)).app === LAMPLIT_PACKAGE) await run(['-s', serial, 'shell', 'input', 'keyevent', String(KEYS.back)]);
        out = await callType();
      }
      if (!/ok=true/.test(out)) {
        const why = /Could not find provider/i.test(out) ? 'the Lamplit app (1.3.1 or newer) is not on the phone or could not be started'
          : (/error=([^,}\]]+)/.exec(out)?.[1] || out.trim().split('\n')[0] || 'no answer').slice(0, 160);
        throw fail('PHONE_TYPE_NEEDS_APP', `Chinese did not go in (${why}); plain letters and digits work without the app. Try once more, or tell the human; typing pinyin and picking from the suggestions also works.`);
      }
      await run(['-s', serial, 'shell', 'input', 'keyevent', String(KEYS.paste)]);
    }
    if (args.submit) await run(['-s', serial, 'shell', 'input', 'keyevent', String(KEYS.enter)]);
    lastUi.delete(serial);
    return { done: true, typed: value.length, note: 'Look again to check it went into the right box.' };
  }

  async function key(args = {}) {
    const serial = await pick(args.device);
    await ensureOpen(serial);
    const code = KEYS[String(args.key || '').toLowerCase()];
    if (!code || code === KEYS.paste) throw fail('PHONE_BAD_ARGS', `key is one of ${Object.keys(KEYS).filter((k) => k !== 'paste').join(', ')}`);
    await run(['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
    lastUi.delete(serial);
    return { done: true };
  }

  async function resolveApp(serial, app) {
    const name = String(app || '').trim();
    if (!name) throw fail('PHONE_BAD_ARGS', 'say which app');
    // "BOSS 直聘", "boss直聘", "BOSS直聘": spaces and case do not matter.
    const loose = (s) => String(s).replace(/\s+/g, '').toLowerCase();
    const pkg = KNOWN_APPS[name] || Object.entries(KNOWN_APPS).find(([k]) => loose(k) === loose(name))?.[1] || name;
    if (!/^[A-Za-z][\w]*(\.[\w]+)+$/.test(pkg)) throw fail('PHONE_APP_NOT_FOUND', `don't know the app "${name}"; use its package name (apps lists them)`);
    const there = await text(['-s', serial, 'shell', 'pm', 'path', pkg]);
    if (!/package:/.test(there)) throw fail('PHONE_APP_NOT_FOUND', `"${name}" (${pkg}) is not installed on the phone`);
    return pkg;
  }

  async function open(args = {}) {
    const serial = await pick(args.device);
    await ensureOpen(serial);
    const pkg = await resolveApp(serial, args.app);
    await run(['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    lastUi.delete(serial);
    return { done: true, app: pkg, appName: appLabel(pkg), note: 'It may take a second or two to open; then look.' };
  }

  async function apps(args = {}) {
    const serial = await pick(args.device);
    const listed = (await text(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'])).split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
    return { apps: listed.sort().map((pkg) => (APP_NAMES[pkg] ? { name: APP_NAMES[pkg], package: pkg } : { package: pkg })) };
  }

  async function status(args = {}) {
    const list = await devices();
    const out = [];
    for (const d of list) {
      if (d.state !== 'device') { out.push({ ...d, help: stateHelp(d) }); continue; }
      const w = await windowState(d.serial).catch(() => ({ locked: null, app: '' }));
      out.push({ ...d, locked: w.locked, app: w.app, appName: appLabel(w.app) });
    }
    if (args.device) return { devices: out.filter((d) => d.serial === args.device || d.model === args.device) };
    // No phone ready, though one was here before (1.5.66): say why, not just "no devices".
    if (!out.some((d) => d.state === 'device')) {
      const gone = typeof exec.whyGone === 'function' ? exec.whyGone().trim() : '';
      if (gone) return { devices: out, note: gone };
    }
    return { devices: out };
  }

  /** What a tap is about to press, from the last screen read (for the approval card). */
  function labelFor(args = {}) {
    const serial = (args.device && [...lastUi.keys()].find((s) => s === args.device)) || lastSerial || [...lastUi.keys()][0];
    const ui = serial ? lastUi.get(serial) : null;
    const node = serial ? findNode(serial, args) : null;
    const label = node ? (node.text || node.desc || node.id) : String(args.target || args.what || '');
    return { label, app: ui?.app || '', clearsBox: Boolean(node && ui && clearsABox(node, ui.nodes)) };
  }

  /**
   * The × that empties an input box ("全部删除", "清除"): small and inside or
   * right next to the box, on the same row. It deletes typed text, not data
   * (1.3.1: 小红书's search box asked three times).
   */
  function clearsABox(node, nodes) {
    if (node.editable || ![node.text, node.desc, node.id].some((v) => v && CLEAR_WORDS.test(v))) return false;
    const [l, t, r, b] = node.bounds;
    if (r - l > 200 || b - t > 200) return false;
    return nodes.some((n) => n.editable && n !== node && t < n.bounds[3] && b > n.bounds[1] && l < n.bounds[2] + 120 && r > n.bounds[0]);
  }

  /** The box with the cursor now (reads the screen): is enter there a search or a send? */
  async function focusedBox(args = {}) {
    try {
      const serial = await pick(args.device);
      const ui = await readUi(serial);
      const box = ui.nodes.find((n) => n.focused && n.editable) || null;
      return { app: ui.app, box, search: Boolean(box && SEARCH_BOX.test(`${box.id} ${box.desc} ${box.text}`)) };
    } catch {
      return { app: '', box: null, search: false };
    }
  }

  /** watch: the human's live view on the computer (1.5.0), which leaves the bots' phone choice alone. */
  async function screenshotBytes({ device, watch = false } = {}) {
    const serial = await pick(device, { remember: !watch });
    const { stdout } = await run(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20000, binary: true, watch: Boolean(watch) });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  }

  /**
   * Workspace files into the phone's album (1.5.65). args.files: from albumFiles()
   * (checked, within the caps). Through the Lamplit app when the phone is on it
   * and the app can; else over the cable when the same phone is plugged in here.
   */
  async function saveToAlbum(args = {}) {
    const files = Array.isArray(args.files) ? args.files : [];
    if (!files.length) throw fail('PHONE_BAD_ARGS', 'save_to_album needs paths: the workspace files to put on the phone');
    const items = albumPlan(files);
    const serial = await pick(args.device);
    if (serial.startsWith('lamplit:')) {
      const deviceId = serial.slice('lamplit:'.length);
      const media = typeof exec.media === 'function' ? exec.media : null;
      if (media && media.can(deviceId)) {
        try {
          return albumSummary(items, await media(deviceId, items), 'app');
        } catch (err) {
          if (err.code !== 'PHONE_APP_TOO_OLD') throw err;
        }
      }
      // An older app: the same phone on the cable here still works.
      const twin = typeof exec.adbTwin === 'function' ? await exec.adbTwin(deviceId).catch(() => '') : '';
      if (twin) return albumSummary(items, await byAdb(twin, items), 'adb');
      throw fail('PHONE_APP_TOO_OLD', albumOldAppMessage(Boolean(adbPathOrEmpty())));
    }
    return albumSummary(items, await byAdb(serial, items), 'adb');
  }
  const adbPathOrEmpty = () => { try { const p = typeof adb === 'function' ? adb() : adb; return p && p !== 'lamplit' ? p : ''; } catch { return ''; } };

  /** Over the cable: each file copied (checked) to a folder of the hub's own, pushed, its time set; then a scan. */
  async function byAdb(serial, items) {
    // The phone's own clock: "newest" is newer than the photos taken there just now, whatever this computer's clock says.
    const phoneNow = Number(String(await text(['-s', serial, 'shell', 'date', '+%s'], { timeout: 10000 }).catch(() => '')).trim());
    if (Number.isFinite(phoneNow) && phoneNow > 1e9) items = items.map((it) => ({ ...it, time: phoneNow - it.order }));
    // The hub's own temp folder (data/tmp, hidden from the bots), never the system's.
    const tmp = await fsp.mkdtemp(path.join(typeof tmpDir === 'function' ? tmpDir() : tmpDir, 'push-'));
    const local = (it) => path.join(tmp, `${it.order}${path.extname(it.phoneName)}`);
    const { copy, scan, broadcast } = adbAlbumCommands(serial, items, local);
    const failed = [];
    try {
      const saveOrder = [...items].reverse();
      for (let i = 0; i < saveOrder.length; i += 1) {
        const it = saveOrder[i];
        try {
          await copyOut(it.root, it.abs, local(it));
          await run(copy[i * 2], { timeout: 60000 + Math.ceil(it.size / (1024 * 1024)) * 3000 });
          await run(copy[i * 2 + 1], { timeout: 15000 }).catch(() => {}); // a phone without `touch -d`: the order may differ
        } catch (err) {
          if (err.code === 'PHONE_NOT_CONNECTED' || err.code === 'ADB_NOT_FOUND') throw err;
          failed.push({ order: it.order, why: err.code === 'PATH_OUTSIDE_WORKSPACE' ? 'leads outside the workspace' : err.message });
        } finally {
          await fsp.rm(local(it), { force: true }).catch(() => {});
        }
      }
      if (failed.length === items.length) throw fail('PHONE_ADB_FAILED', `no file got onto the phone: ${failed[0]?.why || ''}`.slice(0, 400));
      const scanned = await text(scan, { timeout: 20000 }).catch(() => '');
      if (!/ok=true/.test(scanned)) {
        for (const line of broadcast) await run(line, { timeout: 15000 }).catch(() => {});
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { failed };
  }

  const ACTIONS = { status, look, tap, swipe, type, key, open, apps, save_to_album: saveToAlbum };
  return {
    devices, status, look, tap, swipe, type, key, open, apps, saveToAlbum, labelFor, focusedBox, screenshotBytes,
    adbPath: () => { try { return adbPath(); } catch { return ''; } },
    act(action, args = {}) {
      const fn = ACTIONS[action];
      if (!fn) throw fail('PHONE_BAD_ARGS', `action is one of ${Object.keys(ACTIONS).join(', ')}`);
      return fn(args);
    },
  };
}

export const PHONE_ACTIONS = ['status', 'look', 'tap', 'swipe', 'type', 'key', 'open', 'apps', 'save_to_album'];
export const PHONE_LOOK_ACTIONS = new Set(['status', 'look', 'apps']);
