#!/usr/bin/env node
/**
 * smoke-1551.mjs - 1.5.51: the relay's last update result is current, and the
 * relay installer brings its own Node.js.
 *
 * 11-21, after the relay updated itself to 1.5.50: 体检 still said
 * 「中转这次没有更新：新版本 1.5.49 没能正常启动…现在用的是 1.5.50」. The relay
 * read its book once at start (before the supervisor wrote "1.5.50 runs fine"),
 * and the computer showed any failure, even one older than what runs.
 *
 *   lastResultChecks({check})     the relay says {ok:true} once a newer version is
 *                                 up; the card and 体检 ignore older failures; the
 *                                 1.5.50 relay still takes 1.5.51
 *   installerChecks({check})      hub/relay-linux.sh installs Node.js 20+ itself
 *
 * Run alone: node scripts/smoke-1551.mjs
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRelayUpdater } from '../hub/relay/relay.mjs';
import { makeRelayManifest } from '../src/relayupdate.mjs';
import { book, build, layout, readyLine, stage, startService, stopService, until } from './smoke-relay-layout.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZERO = '0'.repeat(64);

/** A function's source out of a page or server file, made callable with the given helpers. */
function extract(text, name, helpers = {}) {
  const m = text.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found`);
  return new Function(...Object.keys(helpers), `${m[0]}; return ${name};`)(...Object.values(helpers));
}

const FAILED_149 = { ok: false, version: '1.5.49', at: '2026-11-21T03:39:04.000Z', reason: '新版本 1.5.49 没能正常启动，已退回 1.5.47', detail: 'x' };

export async function lastResultChecks({ check }) {
  const keep = setInterval(() => {}, 1000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-1551-'));
  const runs = [];
  try {
    // --- the relay: its own last result -------------------------------------------
    const writeBook = (dir, b) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify(b)); };
    const asOnServer = path.join(tmp, 'server-book');
    writeBook(asOnServer, { current: { v: 1, version: '1.5.50', sha256: ZERO, signature: '' }, previous: null, bad: ['1.5.49'], last: FAILED_149 });
    const u = createRelayUpdater({ running: { version: '1.5.50', sha256: ZERO }, stateDir: asOnServer, minIntervalMs: 0 });
    check('relay: it can say it started fine (confirmRunning)', typeof u.confirmRunning === 'function');
    u.confirmRunning?.();
    const s1 = u.status().last;
    check('relay: once 1.5.50 is up, its last result is {ok:true, 1.5.50} - not the old 1.5.49 failure', s1?.ok === true && s1.version === '1.5.50' && !s1.reason && !s1.detail, JSON.stringify(s1));
    const b1 = JSON.parse(fs.readFileSync(path.join(asOnServer, 'updates.json'), 'utf8'));
    check('relay: written to the book too, and 1.5.49 stays on the bad list', b1.last?.ok === true && b1.last.version === '1.5.50' && JSON.stringify(b1.bad) === '["1.5.49"]', JSON.stringify(b1));

    const rolledBack = path.join(tmp, 'rolled-back');
    writeBook(rolledBack, { current: null, previous: null, bad: ['1.5.49'], last: FAILED_149 });
    const back = createRelayUpdater({ running: { version: '1.5.47', sha256: ZERO }, stateDir: rolledBack, minIntervalMs: 0 });
    back.confirmRunning?.();
    check('relay: the version it rolled back to (1.5.47) keeps saying that 1.5.49 failed', back.status().last?.ok === false && back.status().last.version === '1.5.49');

    const fresh = path.join(tmp, 'fresh');
    const nothing = createRelayUpdater({ running: { version: '1.5.50', sha256: ZERO }, stateDir: fresh, minIntervalMs: 0 });
    nothing.confirmRunning?.();
    check('relay: a fresh install with nothing updated yet says nothing about updates', nothing.status().last === null || nothing.status().last === undefined, JSON.stringify(nothing.status().last));

    const later = path.join(tmp, 'later');
    writeBook(later, { current: null, previous: null, bad: [], last: null });
    const reader = createRelayUpdater({ running: { version: '1.5.50', sha256: ZERO }, stateDir: later, minIntervalMs: 0 });
    writeBook(later, { current: null, previous: null, bad: [], last: { ok: true, version: '1.5.50', at: '2026-11-21T04:00:00.000Z' } });
    check('relay: what the supervisor writes later (its "runs fine" after a minute) is what the relay reports, not what it read at start', reader.status().last?.ok === true && reader.status().last.version === '1.5.50', JSON.stringify(reader.status().last));

    // --- the computer: the card and 体检 ------------------------------------------
    const page = read('public/app/main/08-settings.js');
    const words = extract(page, 'relayUpdateWords');
    const view = (relay, offer) => ({ enabled: true, state: 'online', relay, relayUpdate: offer ? { version: offer } : null });
    const now = words(view({ version: '1.5.50', auto: true, last: FAILED_149 }, '1.5.50'));
    check('card: an old failure (1.5.49) under a newer running version (1.5.50) is not shown; it says it updated', !/没有更新/.test(now) && /已更新到 1\.5\.50/.test(now), now);
    check('card: while the rolled-back 1.5.47 runs, the 1.5.49 failure is still said', /没有更新/.test(words(view({ version: '1.5.47', auto: true, last: FAILED_149 }, '1.5.49'))));
    check('card: after the relay itself says ok, it says it updated', /已更新到 1\.5\.50/.test(words(view({ version: '1.5.50', auto: true, last: { ok: true, version: '1.5.50' } }, '1.5.50'))));
    const failNode = extract(page, 'relayFailureNode', { relayUpdateWords: words, state: {}, el: () => ({}), document: { createElement: () => ({ addEventListener() {}, appendChild() {} }) } });
    check('card: 「看原因」 is not offered for an old failure', failNode(view({ version: '1.5.50', auto: true, last: FAILED_149 }, '1.5.50')) === null);

    const server = read('src/server.mjs');
    const item = (id, title, level, text) => ({ id, title, level, text });
    const checkup = extract(server, 'relayUpdateCheckupItem', { checkupItem: item });
    const st = (relay, offer) => ({ relayLink: { view: () => ({ ...view(relay, offer) }) } });
    const t1 = checkup(st({ version: '1.5.50', auto: true, last: FAILED_149 }, '1.5.50'));
    check('体检: the line seen on the user\'s PC (1.5.49 failed, 1.5.50 runs) now says it updated to 1.5.50, as ok', t1?.level === 'ok' && /已更新到 1\.5\.50/.test(t1.text) && !/没有更新|1\.5\.49/.test(t1.text), JSON.stringify(t1));
    const t2 = checkup(st({ version: '1.5.47', auto: true, last: FAILED_149 }, '1.5.49'));
    check('体检: a failure newer than what runs is still said (a note, not a problem)', t2?.level === 'info' && /没有更新/.test(t2.text));
    const t3 = checkup(st({ version: '1.5.50', auto: true, last: null }, '1.5.50'));
    check('体检: up to date with nothing to report: one plain ok line, no update talk', t3?.level === 'ok' && /1\.5\.50/.test(t3.text) && !/没有更新|已更新/.test(t3.text), JSON.stringify(t3));
    const t4 = checkup(st({ version: '1.5.50', auto: true, last: FAILED_149 }, '1.5.51'));
    check('体检: a newer version offered is said as coming, not the old failure', t4 && /1\.5\.51/.test(t4.text) && !/1\.5\.49/.test(t4.text), JSON.stringify(t4));

    // --- real processes: the server as it is now, updating to the next version ---------
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    let released = '';
    try { released = execFileSync('git', ['show', 'origin/main:hub/relay/relay.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }); } catch { /* shallow checkout */ }
    if (!/RELAY_VERSION = '1\.5\.50'/.test(released)) released = '';
    const NEXT = '1.5.51';
    const a = layout(tmp, 'server');
    // /opt: the supervisor installed long ago; the state: 1.5.50 staged and running, the 1.5.49 failure in the book.
    fs.writeFileSync(path.join(a.opt, 'relay.mjs'), build(pub, '1.5.47'));
    const r150 = build(pub, '1.5.50', released ? { source: released } : {});
    await stage(a, privateKey, pub, '1.5.50', r150);
    const bk = book(a);
    fs.writeFileSync(path.join(a.priv, 'updates.json'), JSON.stringify({ ...bk, bad: ['1.5.49'], last: FAILED_149 }));

    // The 1.5.50 relay (the released code when git has it) takes 1.5.51 when offered.
    const tmpOld = path.join(tmp, 'released-relay.mjs');
    fs.writeFileSync(tmpOld, r150);
    const Old = await import(pathToFileURL(tmpOld).href);
    const nextBytes = build(pub, NEXT);
    const manifest = makeRelayManifest({ version: NEXT, bytes: nextBytes, privateKey });
    let staged = '';
    const old = Old.createRelayUpdater({ running: { version: '1.5.50', sha256: crypto.createHash('sha256').update(r150).digest('hex') }, stateDir: a.link, keys: [pub], minIntervalMs: 0, onStaged: (v) => { staged = v; } });
    old.offer({ id: 'pc', fetch: async (p) => (p.endsWith('relay.mjs') ? nextBytes : Buffer.from(JSON.stringify(manifest))), tell: () => {} }, { version: NEXT, sha256: manifest.sha256 });
    await until(() => staged, 5000);
    check(`the ${released ? 'released ' : ''}1.5.50 relay takes ${NEXT} when a computer offers it (signature checked, staged)`, staged === NEXT && book(a)?.current?.version === NEXT, JSON.stringify(book(a)));

    const run = startService(a);
    runs.push(run);
    const up = await until(() => readyLine(run), 20000);
    check(`${NEXT} comes up under the old supervisor`, up?.port > 0 && run.err.includes(`starting relay ${NEXT} (updated`), run.err.slice(-600));
    if (up?.port) {
      const { createRelayLink } = await import('../src/relaylink.mjs');
      const join = fs.readFileSync(path.join(a.priv, 'join-secret'), 'utf8').trim();
      const link = createRelayLink({ dataDir: path.join(tmp, 'hub'), handler: (_q, s) => s.end('hub'), log: () => {}, relayUpdate: () => null });
      try {
        link.configure({ enabled: true, host: '127.0.0.1', port: up.port, relayFingerprint: up.fingerprint, join, direct: false });
        await until(() => link.view().relay?.version, 8000);
        const r = link.view().relay || {};
        check(`the computer hears ${NEXT} with {ok:true, ${NEXT}} at once - no waiting a minute, no old failure`, r.version === NEXT && r.last?.ok === true && r.last.version === NEXT, JSON.stringify(r));
        const t = checkup({ relayLink: { view: () => link.view() } });
        check(`体检 on that computer: 中转已更新到 ${NEXT}`, t?.level === 'ok' && t.text.includes(`已更新到 ${NEXT}`), JSON.stringify(t));
      } finally {
        link.stop();
        link.closeDirect?.();
      }
    }
    await stopService(run);
  } finally {
    for (const r of runs) await stopService(r).catch(() => {});
    clearInterval(keep);
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export async function installerChecks({ check }) {
  const sh = read('hub/relay-linux.sh');
  check('installer: it installs Node.js itself when none 20+ is found (no longer stops with "install Lamplit first")', /install_node\(\) \{/.test(sh) && /\nfind_node \|\| install_node\n/.test(sh) && !/先用「添加机器」把 Lamplit 装上，它会带上 Node\.js/.test(sh));
  check('installer: the system\'s own packages when they are 20+, else NodeSource with a pinned major (22)', /NODE_MAJOR=22/.test(sh) && sh.includes('https://deb.nodesource.com/node_${NODE_MAJOR}.x') && sh.includes('https://rpm.nodesource.com/pub_${NODE_MAJOR}.x/nodistro/nodejs/'));
  check('installer: NodeSource packages are checked against NodeSource\'s key (apt Signed-By, rpm gpgcheck=1); no downloaded script is run', /Signed-By: \/usr\/share\/keyrings\/nodesource\.gpg/.test(sh) && /gpgcheck=1/.test(sh) && /nodesource-repo\.gpg\.key/.test(sh) && /ns-operations-public\.key/.test(sh) && !/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(sh) && !/setup_\d+\.x/.test(sh));
  check('installer: it says what it does, in plain words, before and after', /正在安装 Node\.js/.test(sh) && sh.includes('Node.js $("$NODE" -v) 装好了') && /改用 Node\.js 官网推荐的软件源（NodeSource）/.test(sh) && /用系统软件源里的 Node\.js/.test(sh));
  const remote = read('src/remote.mjs');
  check('installer: the computer shows its lines as progress, and waits long enough for Node to install (10 minutes)',
    remote.split('\n').some((l) => l.includes('lamplit-relay-setup.sh /tmp/lamplit-relay.mjs ${Number(port)}') && l.includes('timeoutMs: 600000') && l.includes("onLine: (line) => { const m = /^\\[desk\\] (.+)/.exec(line); if (m) setProgress(job, m[1]); }")));
  await runInstallerCases({ check, sh });

  const relayDoc = read('docs/RELAY.md');
  check('docs/RELAY.md: says the installer brings Node.js itself (system packages or NodeSource 22), not that it stops', /自动装/.test(relayDoc) && /NodeSource/.test(relayDoc) && !/安装会停下并提示「这台服务器上没有 Node\.js 20 以上」/.test(relayDoc));
  const zh = read('site/docs.html');
  const en = read('site/en/docs.html');
  check('site docs (zh): the server line says Node.js is installed automatically', /Node\.js[^<]*自动装/.test(zh) && !zh.includes('没有的话安装时会提示你'));
  check('docs: the install time says 10 seconds usually, minutes when Node.js is installed first (zh, en, RELAY.md)', /一般 10 秒左右；要先装 Node\.js 的话要几分钟/.test(zh) && /Usually about 10 seconds; a few minutes when it installs Node\.js first/.test(en) && /一般约 10 秒装好；要先装 Node\.js 的话要几分钟/.test(relayDoc) && !/大约 10 秒。SSH/.test(zh));
  check('site docs (en): the server line says Node.js is installed automatically', /installs Node\.js[^<]*itself/.test(en) && !en.includes('otherwise the install tells you'));
}

/** Where bash is: on Windows the Git one (not WSL's System32 bash), else bash on PATH. */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const out = execFileSync('where', ['bash'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/System32|WindowsApps/i.test(l)) || '';
  } catch { return ''; }
}

/**
 * The installer's Node.js step, run for real in bash with stand-ins for the
 * system: /etc/os-release, apt-get, apt-cache, dnf, rpm, curl, gpg, dpkg and a
 * node that is "20+" only once a package was installed. Files land in a temp root.
 */
async function runInstallerCases({ check, sh }) {
  const bash = findBash();
  if (!bash) { check('installer run: bash is available here', false, 'no bash'); return; }
  const from = sh.indexOf('node_ok() {');
  const to = sh.indexOf('\nfind_node || install_node\n');
  const lib = sh.slice(from, to);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-nodeinst-'));
  const P = (p) => p.replace(/\\/g, '/');
  const run = (name, { osRelease, env = {} }) => {
    const root = P(path.join(tmp, name));
    const bin = `${root}/bin`;
    for (const d of ['bin', 'etc/apt/sources.list.d', 'etc/apt/preferences.d', 'etc/yum.repos.d', 'usr/share/keyrings', 'tmp']) fs.mkdirSync(path.join(tmp, name, d), { recursive: true });
    if (osRelease !== null) fs.writeFileSync(path.join(tmp, name, 'etc', 'os-release'), osRelease);
    const tool = (n, body) => fs.writeFileSync(path.join(tmp, name, 'bin', n), `#!/bin/bash\necho "${n} $*" >> "${root}/calls"\n${body}\n`, { mode: 0o755 });
    const installed = `touch "${root}/installed"`;
    tool('node', `if [ -f "${root}/installed" ]; then [ "$1" = -v ] && echo v22.11.0 || echo 22; else [ "$1" = -v ] && echo v18.19.0 || echo 18; fi`);
    tool('apt-get', `case "$*" in *"install -y nodejs"*) ${installed} ;; esac; exit 0`);
    tool('apt-cache', `echo "nodejs:"; echo "  Installed: (none)"; echo "  Candidate: ${env.APT_CANDIDATE || '18.19.1+dfsg-6ubuntu5'}"`);
    tool('curl', 'echo FAKEKEY');
    tool('gpg', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && { cat > "$2"; exit 0; }; shift; done');
    tool('dpkg', 'echo amd64');
    tool('dnf', `case "$*" in *"module install"*) ${env.DNF_MODULE_OK ? installed : 'exit 1'} ;; *"list available nodejs"*) echo "nodejs.x86_64   ${env.DNF_AVAIL || '1:16.20.2-8.el9_4'}   appstream" ;; *"install -y nodejs"*|*"upgrade -y nodejs"*) ${installed} ;; esac; exit 0`);
    tool('rpm', `exit ${env.RPM_HAS ? 0 : 1}`);
    const body = lib.replace(/\/etc\//g, `${root}/etc/`).replace(/\/usr\/share\/keyrings/g, `${root}/usr/share/keyrings`).replace(/\/tmp\//g, `${root}/tmp/`)
      .replace('/opt/desk-hub/runtime/bin/node', `${root}/none/node`).replace(' /usr/bin/node;', ` ${root}/none/node2;`);
    const script = ['set -u', 'say() { echo "[desk] $*"; }', 'fail() { echo "DESK_RELAY_ERROR=$1"; exit 1; }', body, 'find_node || install_node', 'echo "NODE_AT=$NODE"'].join('\n');
    fs.writeFileSync(path.join(tmp, name, 'run.sh'), script);
    let out = '';
    let code = 0;
    try {
      out = execFileSync(bash, [`${root}/run.sh`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { out = String(err.stdout || ''); code = err.status || 1; }
    const file = (p) => { try { return fs.readFileSync(path.join(tmp, name, p), 'utf8'); } catch { return ''; } };
    return { out, code, calls: file('calls'), file };
  };
  try {
    const ubuntu = run('ubuntu', { osRelease: 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04 LTS"\n' });
    const src = ubuntu.file('etc/apt/sources.list.d/nodesource.sources');
    check('installer run (Ubuntu 24.04, system Node 18): adds the signed NodeSource 22 source, installs nodejs, finds Node 22',
      ubuntu.code === 0 && /URIs: https:\/\/deb\.nodesource\.com\/node_22\.x/.test(src) && /^Signed-By: \S*\/usr\/share\/keyrings\/nodesource\.gpg$/m.test(src) && /Architectures: amd64/.test(src)
      && ubuntu.file('usr/share/keyrings/nodesource.gpg').includes('FAKEKEY') && /Pin: origin deb\.nodesource\.com/.test(ubuntu.file('etc/apt/preferences.d/nodejs'))
      && /apt-get install -y nodejs/.test(ubuntu.calls) && /\[desk\] 正在安装 Node\.js/.test(ubuntu.out) && /改用 Node\.js 官网推荐的软件源/.test(ubuntu.out) &&/Node\.js v22\.11\.0 装好了/.test(ubuntu.out) && /NODE_AT=.+\/node/.test(ubuntu.out), `${ubuntu.out}\n${ubuntu.calls}`);
    const debian = run('debian13', { osRelease: 'ID=debian\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n', env: { APT_CANDIDATE: '20.19.2+dfsg-1' } });
    check('installer run (Debian 13, system Node 20): uses the system package, adds no NodeSource source',
      debian.code === 0 && /用系统软件源里的 Node\.js 20/.test(debian.out) && !debian.file('etc/apt/sources.list.d/nodesource.sources') && /apt-get install -y nodejs/.test(debian.calls), debian.out);
    const rocky = run('rocky9', { osRelease: 'ID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n', env: { DNF_MODULE_OK: true } });
    check('installer run (Rocky 9): the system\'s nodejs:22 module stream, no NodeSource', rocky.code === 0 && /dnf -y module install nodejs:22\/common/.test(rocky.calls) && /用系统软件源里的 Node\.js 22/.test(rocky.out) && !rocky.file('etc/yum.repos.d/nodesource-nodejs.repo'), rocky.out);
    const tencent = run('tencentos', { osRelease: 'ID="tencentos"\nID_LIKE="rhel fedora centos"\nPRETTY_NAME="TencentOS Server 3.1"\n', env: { RPM_HAS: true } });
    const repo = tencent.file('etc/yum.repos.d/nodesource-nodejs.repo');
    check('installer run (TencentOS, no module, system Node 16 installed): NodeSource 22 repo with gpgcheck, an upgrade of nodejs',
      tencent.code === 0 && /baseurl=https:\/\/rpm\.nodesource\.com\/pub_22\.x\/nodistro\/nodejs\/\$basearch/.test(repo) && /gpgcheck=1/.test(repo) && /gpgkey=https:\/\/rpm\.nodesource\.com\/gpgkey\/ns-operations-public\.key/.test(repo) && /module_hotfixes=1/.test(repo)
      && /dnf upgrade -y nodejs/.test(tencent.calls) && /Node\.js v22\.11\.0 装好了/.test(tencent.out), `${tencent.out}\n${tencent.calls}`);
    const alinux = run('alinux3', { osRelease: 'ID="alinux"\nID_LIKE="rhel fedora centos anolis"\nPRETTY_NAME="Alibaba Cloud Linux 3 (Soaring Falcon)"\n', env: { DNF_MODULE_OK: true } });
    check('installer run (Alibaba Cloud Linux 3, as on Aliyun ECS): treated as RHEL-like, the system\'s module stream', alinux.code === 0 && /dnf -y module install nodejs:22\/common/.test(alinux.calls) && /Node\.js 22/.test(alinux.out), alinux.out);
    const alpine = run('alpine', { osRelease: 'ID=alpine\nPRETTY_NAME="Alpine Linux v3.20"\n' });
    check('installer run (an unknown system): stops, names it, suggests Ubuntu 24.04 or installing Node.js 20+, lists what works, links the docs', alpine.code === 1 && /DESK_RELAY_ERROR=不认识这个系统（Alpine Linux v3\.20）.*重装成 Ubuntu 24\.04.*先自己装好 Node\.js 20 或更新.*Alibaba Cloud Linux.*docs\.html#outside/.test(alpine.out), alpine.out);
    const none = run('no-os-release', { osRelease: null });
    check('installer run (no /etc/os-release): stops with a clear message', none.code === 1 && /DESK_RELAY_ERROR=不认识这个系统（没有/.test(none.out), none.out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let failed = 0;
  let passed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };
  (async () => { await lastResultChecks({ check }); await installerChecks({ check }); })().then(() => {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}
