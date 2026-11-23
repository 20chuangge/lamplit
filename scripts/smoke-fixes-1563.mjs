// 1.5.63: small fixes. A group's introductions run on another machine as a hand-over and that machine's
// daily note no longer counts them (the marker goes along, both ways, older peers still fine); the desktop
// app run against a developer page (ASSIST_DEV_URL) makes no master.key and leaves TightVNC alone; the
// pairing cookie is named after the port, so two Lamplits on one computer no longer log each other out
// (browsers paired before keep working and get the new name); smoke tests skip ports Windows keeps for
// itself; after a reload 「试试这些」 is not drawn above a card that still waits.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A top-level function of a source file, as source (default arguments may hold calls). */
function fnSource(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

/** One HTTP request with a Host header of our choosing (fetch cannot set it). */
function rawRequest(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.hostname, port: target.port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fixes1563Checks({ check, readText, api, base }) {
  // --- 1. a group's introductions on another machine: the marker goes along -------------------------
  const A = await import('../src/agent.mjs');
  {
    // The sending side: the group loop hands the far member its kickoff, and the hand-over carries it.
    const asked = [];
    const loop = {
      groups: { readGroupMessages: async () => [] },
      runTurn: async (o) => { asked.push({ who: o.botId, kickoff: o.kickoff }); return { status: 'success', turnId: 't-local' }; },
      runRemoteGroupTurn: async (o) => { asked.push({ who: o.member.id, kickoff: o.kickoff, remote: true }); return { status: 'success' }; },
      bus: { emit() {} },
    };
    const grp = { id: 'g63', name: '介绍组', coordinatorId: 'w', members: [{ id: 'w', name: '写稿' }, { id: 'f@书房电脑', name: '翻译', remote: { machine: '书房电脑', botId: 'f' } }] };
    await A.AgentRuntime.prototype.runGroupMessage.call(loop, { group: grp, text: '@写稿 @翻译 （这个群刚建好）请介绍一下', recordUser: false, kickoff: true });
    const intro = asked.find((x) => x.remote);
    asked.length = 0;
    await A.AgentRuntime.prototype.runGroupMessage.call(loop, { group: grp, text: '@写稿 @翻译 进度如何', recordUser: false });
    const plain = asked.find((x) => x.remote);
    check('F63-1a a new group\'s introduction goes to a member on another machine marked as one (and a normal message does not)',
      intro?.kickoff === true && plain?.kickoff === false, JSON.stringify({ intro, plain }));

    const sent = [];
    const events = [];
    const peers = {
      find: () => ({ name: '书房电脑' }),
      json: async (_peer, method, p, opts) => { sent.push({ method, p, body: opts?.body }); throw new Error('stop here (test)'); },
    };
    const far = {
      getPeers: () => peers,
      config: { workspaceDir: '' },
      groups: { readGroupMessages: async () => [] },
      recordGroupMessage: async (_gid, rec) => rec,
      bus: { emit: (e) => events.push(e) },
      active: new Map(),
    };
    await A.AgentRuntime.prototype.runRemoteGroupTurn.call(far, { group: grp, member: grp.members[1], text: '介绍一下', role: 'speaker', kickoff: true });
    const withFlag = sent.at(-1)?.body?.handoff;
    const endWith = events.filter((e) => e.type === 'turn.end').at(-1);
    await A.AgentRuntime.prototype.runRemoteGroupTurn.call(far, { group: grp, member: grp.members[1], text: '进度如何', role: 'speaker' });
    const without = sent.at(-1)?.body?.handoff;
    const endWithout = events.filter((e) => e.type === 'turn.end').at(-1);
    check('F63-1b the hand-over to the other machine carries kickoff:true for an introduction only; this machine marks its own copy of the turn too',
      withFlag?.kickoff === true && !('kickoff' in (without || {})) && Array.isArray(withFlag?.chain) && endWith?.kickoff === true && !endWithout?.kickoff,
      JSON.stringify({ withFlag, without, endWith: endWith?.kickoff, endWithout: endWithout?.kickoff }));
  }
  {
    // The receiving side, on a real hub: kickoff:true marks the turn an introduction; none, or anything but true (an older or odd peer), does not.
    const say = (handoff) => api('/api/bots/researcher/message', { method: 'POST', body: { text: '（群聊介绍）请介绍一下你自己', handoff } });
    const itemOf = async () => (await api('/api/attention')).json?.items?.['bot:researcher'] || {};
    const waitDone = async () => { for (let i = 0; i < 80; i += 1) { const it = await itemOf(); if (!it.working && it.unread) return it; await sleep(100); } return itemOf(); };
    const hand = { depth: 1, chain: ['group:g63', 'researcher'], budgetLeft: 4, from: { bot: '群「介绍组」', machine: '书房电脑' } };
    const r1 = await say({ ...hand, kickoff: true });
    const marked = await waitDone();
    const note1 = (await api('/api/nudge/preview')).json?.text || '';
    const r2 = await say({ ...hand, kickoff: 'yes' });
    const odd = await waitDone();
    const r3 = await say({ ...hand });
    const old = await waitDone();
    const note3 = (await api('/api/nudge/preview')).json?.text || '';
    check('F63-1c a hub given kickoff:true in a hand-over marks the turn as an introduction, and its daily note does not count it as unseen work; without it (an older peer) it counts as before',
      r1.status === 200 && r2.status === 200 && r3.status === 200 && marked.intro === true && !/做完了你还没看[^\n]*研究/.test(note1) && !odd.intro && !old.intro && /做完了你还没看[^\n]*研究/.test(note3),
      JSON.stringify({ marked, odd, old, note1: note1.slice(0, 120), note3: note3.slice(0, 160) }));
    await api('/api/attention/seen', { method: 'POST', body: { key: 'bot:researcher' } }).catch(() => null);
  }

  // --- 2. the desktop app against a developer page: no master.key in HOME, TightVNC left alone ------
  const main = await readText('../desktop/main.mjs');
  {
    const src = fnSource(main, 'masterKey');
    const run = (devUrl, existing = null) => {
      const writes = [];
      const logs = [];
      const fakeFs = {
        existsSync: () => existing !== null,
        readFileSync: () => existing,
        writeFileSync: (f) => writes.push(String(f)),
        mkdirSync: () => {},
      };
      const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`sealed:${s}`), decryptString: (b) => String(b).replace(/^sealed:/, '') };
      const crypto = { randomBytes: () => Buffer.alloc(32, 7) };
      const pathMod = { join: (...p) => p.join('/') };
      // eslint-disable-next-line no-new-func
      const masterKey = new Function('safeStorage', 'fs', 'path', 'HOME', 'DEV_URL', 'bootLog', 'crypto', `let masterKeyCache = null; ${src}; return masterKey;`)(safeStorage, fakeFs, pathMod, '/home', devUrl, (l) => logs.push(l), crypto);
      return { key: masterKey(), writes, logs };
    };
    const dev = run('http://127.0.0.1:5173/');
    const prod = run('');
    const devExisting = run('http://127.0.0.1:5173/', Buffer.from(`sealed:${'ab'.repeat(32)}`));
    check('F63-2a with ASSIST_DEV_URL set, the desktop app makes no master.key (HOME is the source folder then); a normal run still makes one, and a key already there is still read',
      Boolean(src) && dev.key === '' && dev.writes.length === 0 && /dev mode/.test(dev.logs.join()) && prod.key.length === 64 && prod.writes.some((f) => /master\.key$/.test(f)) && devExisting.key === 'ab'.repeat(32) && devExisting.writes.length === 0,
      JSON.stringify({ dev, prodWrites: prod.writes, devExisting: devExisting.key.length }));

    const m = /\n {2}const startLocalVnc = \(\) => \{[\s\S]*?\n {2}\};\n/.exec(main);
    const runVnc = (devUrl) => {
      const imported = [];
      const logs = [];
      const body = (m?.[0] || '').replace(/\bimport\(/g, '__import(');
      // eslint-disable-next-line no-new-func
      const start = new Function('process', 'DEV_URL', 'bootLog', '__import', 'pathToFileURL', 'path', 'SERVER_DIR', 'HOME', 'masterKey', `let localVnc = null; ${body}; return startLocalVnc;`)(
        { platform: 'win32' }, devUrl, (l) => logs.push(l), (u) => { imported.push(u); return Promise.resolve({ ensureLocalVnc: async () => ({ mode: 'test' }) }); },
        (p) => ({ href: `file:///${p}` }), { join: (...p) => p.join('/') }, '/srv', '/home', () => '',
      );
      start();
      return { imported, logs };
    };
    const devVnc = runVnc('http://127.0.0.1:5173/');
    const prodVnc = runVnc('');
    check('F63-2b with ASSIST_DEV_URL set, the desktop app never loads the TightVNC module (no start, no MSI download, no registry password); a normal run still does',
      Boolean(m) && devVnc.imported.length === 0 && /dev mode/.test(devVnc.logs.join()) && prodVnc.imported.some((u) => /localvnc\.mjs$/.test(u)),
      JSON.stringify({ devVnc, prodVnc: prodVnc.imported }));
  }

  // --- 3. the pairing cookie is named after the port --------------------------------------------------
  const AU = await import('../src/auth.mjs');
  {
    const req = (host, extra = {}) => ({ headers: { host, ...extra } });
    check('F63-3a the login cookie is named after the port the browser used; an address with no port keeps the plain name; through the relay the machine\'s own name still wins',
      AU.sessionCookieName(req('lamplit.test:4661')) === 'desk_session_4661'
      && AU.sessionCookieName(req('127.0.0.1:14390')) === 'desk_session_14390'
      && AU.sessionCookieName(req('pc.example.ts.net')) === 'desk_session'
      && AU.sessionCookieName(req('127.0.0.1:4390', { 'x-forwarded-host': 'pc.example.ts.net:8443' })) === 'desk_session_8443'
      && AU.sessionCookieName({ ...req('127.0.0.1:5000'), relayCookieName: 'desk_session_abcdef012345' }) === 'desk_session_abcdef012345'
      && JSON.stringify(AU.sessionCookieNames(req('lamplit.test:4661'))) === '["desk_session_4661","desk_session"]'
      && JSON.stringify(AU.sessionCookieNames({ ...req('127.0.0.1:5000'), relayCookieName: 'desk_session_abcdef012345' })) === '["desk_session_abcdef012345"]');

    // Two Lamplits on one computer, one browser (its cookies are kept per host, not per port).
    const hub = (name) => {
      const sessions = new Map();
      return { name, security: { token: `${name}-hub-token` }, devices: { findBySession: (t) => sessions.get(t) || null, touch() {} }, pair(n) { const t = `${name}-session-${n}`; sessions.set(t, { id: `${name}-dev-${n}` }); return t; } };
    };
    const one = hub('one');
    const two = hub('two');
    const jar = new Map();
    const store = (setCookie) => { const [pair] = setCookie.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))); };
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    const ask = (h, port) => AU.evaluateAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: `lamplit.test:${port}`, cookie: cookieHeader() } }, h.security, h.devices);
    store(AU.sessionCookieHeader(one.pair(1), { name: AU.sessionCookieName(req('lamplit.test:4661')) }));
    store(AU.sessionCookieHeader(two.pair(1), { name: AU.sessionCookieName(req('lamplit.test:4662')) }));
    const a1 = ask(one, 4661);
    const b1 = ask(two, 4662);
    check('F63-3b pairing a browser with a second Lamplit on the same computer no longer logs it out of the first: each keeps its own cookie',
      a1.authorized && a1.deviceId === 'one-dev-1' && b1.authorized && b1.deviceId === 'two-dev-1' && jar.size === 2, JSON.stringify({ a1, b1, jar: [...jar.keys()] }));

    // A browser paired before 1.5.63: only the plain name. It still signs in, and is given the new name.
    jar.clear();
    jar.set('desk_session', one.pair(2));
    const legacy = ask(one, 4661);
    const legacyTwo = ask(two, 4662);
    // The first Lamplit moved to another port: its own login under the old port's name still signs in there; the second's never does.
    jar.clear();
    jar.set('desk_session_4661', one.pair(5));
    jar.set('desk_session_4662', two.pair(3));
    const moved = ask(one, 4670);
    jar.delete('desk_session_4661');
    const notMine = ask(one, 4670);
    check('F63-3c a browser paired before 1.5.63 (plain cookie name) still signs in, is marked to get its cookie again under the new name, and the token never shows in the answer\'s JSON; the other Lamplit does not take it; a Lamplit that moved port still takes its own login, never another\'s',
      legacy.authorized && legacy.deviceId === 'one-dev-2' && legacy.renewCookie === 'one-session-2' && !JSON.stringify(legacy).includes('one-session-2') && !legacyTwo.authorized
      && moved.authorized && moved.deviceId === 'one-dev-5' && moved.renewCookie === 'one-session-5' && !notMine.authorized,
      JSON.stringify({ legacy, legacyTwo, moved, notMine }));

    // A browser on this computer that paired with the code (its authority) under either name.
    const local = { mode: 'local', authorized: true };
    check('F63-3d on this computer a browser paired with the code keeps its authority under the new name and under the old one',
      AU.carriesLocalKey({ headers: { host: '127.0.0.1:4661', cookie: `desk_session_4661=${one.pair(3)}` } }, local, path.join(HERE, 'no-such-dir'), one.devices) === true
      && AU.carriesLocalKey({ headers: { host: '127.0.0.1:4661', cookie: `desk_session=${one.pair(4)}` } }, local, path.join(HERE, 'no-such-dir'), one.devices) === true
      && AU.carriesLocalKey({ headers: { host: '127.0.0.1:4661', cookie: `desk_session_4662=${two.pair(2)}` } }, local, path.join(HERE, 'no-such-dir'), one.devices) === false);
  }
  {
    // The real hub: pairing names the cookie after the port; the old name signs in and is given the new one.
    const port = new URL(base).port;
    const code = (await api('/api/pairing')).json?.code;
    const paired = await rawRequest(base, '/api/pair', { method: 'POST', headers: { host: `lamplit.test:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const setCookie = String([].concat(paired.headers['set-cookie'] || [])[0] || '');
    const token = new RegExp(`^desk_session_${port}=([0-9a-f]{64});`).exec(setCookie)?.[1] || '';
    const withOld = await rawRequest(base, '/api/auth', { headers: { host: `lamplit.test:${port}`, cookie: `desk_session=${token}` } });
    const renewed = String([].concat(withOld.headers['set-cookie'] || [])[0] || '');
    const withNew = await rawRequest(base, '/api/auth', { headers: { host: `lamplit.test:${port}`, cookie: `desk_session_${port}=${token}` } });
    const page = await rawRequest(base, '/api/bots', { headers: { host: `lamplit.test:${port}`, cookie: `desk_session=${token}` } });
    const otherPort = await rawRequest(base, '/api/bots', { headers: { host: 'lamplit.test:1', cookie: `desk_session_${port}=${token}` } });
    const stranger = await rawRequest(base, '/api/bots', { headers: { host: 'lamplit.test:1', cookie: `desk_session_${port}=${'0'.repeat(64)}; desk_session=${'1'.repeat(64)}` } });
    check('F63-3e on the hub: pairing sets desk_session_<port>; the old plain name still signs in (pages and API) and the answer gives the cookie again under the new name; with the new name nothing more is sent; the token is not in any JSON; a login that is not this hub\'s signs in under no name',
      paired.status === 200 && Boolean(token) && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie)
      && withOld.json?.authorized === true && renewed.startsWith(`desk_session_${port}=${token};`) && /HttpOnly/.test(renewed)
      && withNew.json?.authorized === true && !withNew.headers['set-cookie']
      && page.status === 200 && String([].concat(page.headers['set-cookie'] || [])[0] || '').startsWith(`desk_session_${port}=`)
      && otherPort.status === 200 && String([].concat(otherPort.headers['set-cookie'] || [])[0] || '').startsWith(`desk_session_1=${token};`)
      && stranger.status === 401 && !withOld.text.includes(token),
      JSON.stringify({ paired: paired.status, setCookie: setCookie.slice(0, 30), withOld: withOld.json, renewed: renewed.slice(0, 30), withNew: withNew.headers['set-cookie'], page: page.status, otherPort: otherPort.status, stranger: stranger.status }));
  }
  {
    // The desktop app works the name out from the address alone, and copes with hubs from before 1.5.63.
    const G = await import('../desktop/guard.mjs');
    check('F63-3f the desktop app finds a machine\'s login by the address\'s port, then the plain name an older hub set; it reads either from a pairing answer',
      G.loginCookieName('http://127.0.0.1:4390') === 'desk_session_4390' && G.loginCookieName('https://pc.example.ts.net') === 'desk_session'
      && JSON.stringify(G.loginCookieNames('http://127.0.0.1:4390')) === '["desk_session_4390","desk_session"]'
      && JSON.stringify(G.loginFromSetCookie('desk_session_4390=abc%20d; HttpOnly; Path=/')) === '{"name":"desk_session_4390","value":"abc d"}'
      && JSON.stringify(G.loginFromSetCookie('desk_session=abc; HttpOnly')) === '{"name":"desk_session","value":"abc"}'
      && G.loginFromSetCookie('theme=dark') === null);
    const from = 'http://127.0.0.1:4390';
    check('F63-3g copying a login to another address of the same machine (its Tailscale one, or a relay door) renames it to fit; another Lamplit\'s login on that host is left behind',
      G.copiedLoginName('desk_session_4390', from, 'http://127.0.0.1:5390') === 'desk_session_5390'
      && G.copiedLoginName('desk_session', from, 'http://127.0.0.1:5390') === 'desk_session'
      && G.copiedLoginName('desk_session_4391', from, 'http://127.0.0.1:5390') === ''
      && G.copiedLoginName('desk_session_4390', from, 'http://127.0.0.1:4100', 'desk_session_abcdef012345', 'desk_session_4390') === 'desk_session_abcdef012345'
      && G.copiedLoginName('desk_session', from, 'http://127.0.0.1:4100', 'desk_session_abcdef012345', 'desk_session_4390') === ''
      && G.copiedLoginName('theme', from, 'http://127.0.0.1:5390') === 'theme'
      && G.isLoginCookieName('desk_session_abcdef012345') === false);
    check('F63-3h the desktop app no longer looks for the login under the plain name only',
      !/name: 'desk_session'/.test(main) && !/\/desk_session=\(/.test(main) && main.includes('loginFromSetCookie(') && main.includes('loginCookieNames('));
  }

  // --- 4. smoke tests skip the ports Windows keeps for itself -------------------------------------------
  {
    const P = await import('./test-ports.mjs');
    // A relay whose UDP is refused twice (bind EACCES) gets a third port, and what it opened is closed each time.
    let fails = 2;
    const opened = [];
    const fake = (n) => {
      const server = net.createServer();
      return { server, closed: 0, close() { this.closed += 1; }, listenStun: async (p) => { opened.push(p); if (n.left > 0) { n.left -= 1; throw Object.assign(new Error(`bind EACCES 127.0.0.1:${p}`), { code: 'EACCES' }); } } };
    };
    const ok = fake({ left: fails });
    const port = await P.listenRelay(ok, { stun: true });
    const tries = opened.length;
    const listening = ok.server.listening && ok.server.address().port === port;
    await new Promise((r) => ok.server.close(() => r()));
    const never = fake({ left: 99 });
    let err = null;
    try { await P.listenRelay(never, { stun: true }); } catch (e) { err = e; }
    check('F63-4a a relay port whose UDP Windows refuses (EACCES) is given up and another tried; after eight it says why, and leaves nothing listening',
      tries === fails + 1 && listening && err?.code === 'EACCES' && never.server.listening === false && never.closed === 1, JSON.stringify({ tries, listening, err: err?.message, nl: never.server.listening }));
    const R = await import('../hub/relay/relay.mjs');
    const relay = R.createRelay({ identity: R.makeSelfSignedCert({ commonName: 'lamplit-relay' }), joinSecret: 'x'.repeat(24) });
    let real = 0;
    try { real = await P.listenRelay(relay, { stun: true }); } finally { relay.close(); }
    const two = await P.freeTcpPorts(2);
    const twoFree = (await P.tcpFree(two)) && (await P.tcpFree(two + 1));
    check('F63-4b a real relay gets TCP and UDP on one number; two free TCP ports in a row are found for a browser\'s debugging port', real > 0 && two > 0 && twoFree, `${real} ${two}`);
    const direct = await readText('./smoke-direct.mjs');
    const interop = await readText('./direct-interop.mjs');
    const sec = await readText('./smoke-sec1561.mjs');
    const secv = await readText('./smoke-secv1561.mjs');
    const s1549 = await readText('./smoke-1549.mjs');
    check('F63-4c the direct-connection tests and the browser tests pick their ports that way (no fixed guess, no random port); 1.5.62\'s retry in smoke-1549 stays',
      (direct.match(/listenRelay\(relay/g) || []).length === 2 && !/relay\.server\.listen\(0[^\n]*\n[^\n]*\n?\s*await relay\.listenStun/.test(direct)
      && interop.includes('listenRelay(relay, { stun: true })') && !/Math\.random\(\) \* 20000/.test(sec + secv)
      && /for \(let tries = 1; ; tries \+= 1\)/.test(s1549));
  }

  // --- 5. the chat after a reload --------------------------------------------------------------------------
  {
    const bots = await readText('../public/app/main/04-bots.js');
    const settings = await readText('../public/app/main/08-settings.js');
    const live = await readText('../public/app/main/06-live.js');
    const sidebar = await readText('../public/app/main/04b-sidebar.js');
    const page = await readText('../public/index.html');
    // What each chat is doing is known before the first chat is drawn.
    const boot = fnSource(bots, 'boot');
    const primeAt = boot.indexOf('primeAttention()');
    const firstDraw = boot.indexOf('await selectBot(dest.id)');
    const state = { attention: { items: {} } };
    // eslint-disable-next-line no-new-func
    const prime = new Function('api', 'state', `${fnSource(settings, 'primeAttention')}; return primeAttention;`)(async () => ({ items: { 'bot:chief': { working: true, needsYou: true } } }), state);
    await prime();
    const primed = state.attention.items['bot:chief']?.working === true;
    const later = { attention: { items: { 'bot:x': { unread: true } } } };
    // eslint-disable-next-line no-new-func
    await new Function('api', 'state', `${fnSource(settings, 'primeAttention')}; return primeAttention;`)(async () => ({ items: {} }), later)();
    // eslint-disable-next-line no-new-func
    const older = { attention: { items: {} } };
    await new Function('api', 'state', `${fnSource(settings, 'primeAttention')}; return primeAttention;`)(async () => { throw new Error('404'); }, older)();
    check('F63-5a after a reload the page knows which chats are still at work before it draws the first one (so a first exchange waiting on a card gets 「等你点头…」, not 「试试这些」); newer news is not overwritten; an older hub draws as before',
      primeAt > 0 && firstDraw > primeAt && primed && later.attention.items['bot:x']?.unread === true && JSON.stringify(older.attention) === '{"items":{}}', JSON.stringify({ primeAt, firstDraw }));

    // A card coming in takes 「试试这些」 away, so it never sits above a card (a parked card too, with no turn running).
    const mk = (cls) => ({ className: cls, gone: false, remove() { this.gone = true; box.kids = box.kids.filter((k) => k !== this); } });
    const box = {
      kids: [mk('row'), mk('row'), mk('starter-row'), mk('starter-tip')],
      querySelector: (sel) => box.kids.find((k) => sel.split(',').some((s) => k.className === s.trim().replace(/^\./, ''))) || null,
      querySelectorAll: (sel) => box.kids.filter((k) => sel.split(',').some((s) => k.className === s.trim().replace(/^\./, ''))),
      appendChild: (n) => { box.kids.push(n); return n; },
    };
    // eslint-disable-next-line no-new-func
    const appendCard = new Function('messagesEl', 'buildApprovalCard', 'isGroupMode', 'groupSenderRow', 'keepTypingLast', 'focusNewCard', 'scrollToBottom', `${fnSource(live, 'appendApprovalCard')}; return appendApprovalCard;`)(
      box, () => mk('approval'), () => false, (_s, c) => c, () => {}, () => {}, () => {},
    );
    appendCard({ approvalId: 'ap1' });
    const order = box.kids.map((k) => k.className).join(',');
    check('F63-5b a card that comes in after 「试试这些」 takes it away (it was left above the card after a reload)', order === 'row,row,approval', order);

    // The header's count: the chat on screen only (redesign step 2 follow-up: already so since 1.5.59).
    // eslint-disable-next-line no-new-func
    const open = (st) => new Function('state', 'isGroupMode', 'groupById', 'groupMembers', 'isRemoteId', `${fnSource(sidebar, 'openChatApprovals')}; return openChatApprovals;`)(st, () => false, () => null, () => [], (id) => String(id).includes('@'))();
    const cardOfChief = { approvals: [{ id: 'a1', botId: 'chief' }], inbox: { items: [] } };
    const inWriter = open({ ...cardOfChief, botId: 'writer' });
    const inChief = open({ ...cardOfChief, botId: 'chief' });
    check('F63-5c 「N 个操作等你确认」 counts only the chat on screen: a card of 助理 is not counted in 写稿\'s chat (already so since 1.5.59, kept)',
      inWriter.local.length === 0 && inWriter.remote.length === 0 && inChief.local.length === 1);
    check('F63-5d the sidebar has no 「最近」 group any more (gone since 1.5.59: rows keep the hybrid order and hold still while the pointer is on the list)',
      !/el\([^)]*['"]最近['"]/.test(page) && /function noteActivity/.test(page) && /FREEZE_MS/.test(page));
  }
}

// --- 6. 管理助手 for a bot on another machine (1.5.63, the user: 「完整修好」) ---------------------------
// Two hubs: the one under test (this machine) and a second one standing for 「书房电脑」.
export async function remoteEditChecks({ check, readText, api, base, rawFetch, startServerChild, stopProcess, seedHome }) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-smoke-farbot-'));
  await seedHome(otherHome);
  let other = null;
  const M = '书房电脑';
  const enc = encodeURIComponent(M);
  const aKey = () => fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'local-key'), 'utf8').trim();
  try {
    other = await startServerChild(otherHome, { ASSIST_DATA_DIR: path.join(otherHome, 'data'), ASSIST_WORKSPACE_DIR: path.join(otherHome, 'workspace') });
    const B = other.url;
    const bKey = fs.readFileSync(path.join(otherHome, 'data', 'local-key'), 'utf8').trim();
    const bToken = JSON.parse(fs.readFileSync(path.join(otherHome, 'data', 'security.json'), 'utf8')).token;
    const aToken = JSON.parse(fs.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'security.json'), 'utf8')).token;
    const bApi = async (p, { method = 'GET', body } = {}) => {
      const res = await rawFetch(`${B}${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-lamplit-local': bKey }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text };
    };
    const readAudit = (dir) => { try { return fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    await api('/api/peers', { method: 'PUT', body: { peers: [{ name: M, url: B, token: bToken }] } });

    // On 书房电脑 itself: ops can run commands but not delete; a model only that machine has.
    await bApi('/api/bots/ops', { method: 'PATCH', body: { tools: ['shell', 'fs_list', 'fs_read', 'fs_write', 'fs_mkdir'] } });
    const bModel = (await bApi('/api/models', { method: 'POST', body: { label: '书房专用', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'far-only', apiKey: 'test-only-key' } })).json?.model;

    const read = await api(`/api/peers/${enc}/bots/ops`);
    const far = read.json?.bot;
    const localModels = (await api('/api/models')).json?.models || [];
    check('F63-6a 管理助手 for a bot on another machine reads it from there: its real tools and trust, the id as ops@书房电脑, and that machine\'s own models (not this one\'s), no key in the answer',
      read.status === 200 && far?.id === `ops@${M}` && far.tools.includes('shell') && !far.tools.includes('fs_delete') && typeof far.policy?.autoApproveMedium === 'boolean'
      && Boolean(read.json.models?.models?.some((m) => m.id === bModel?.id)) && !localModels.some((m) => m.id === bModel?.id) && read.json.machine === M && !JSON.stringify(read.json).includes('test-only-key'),
      JSON.stringify({ status: read.status, tools: far?.tools, models: read.json?.models?.models?.map((m) => m.id) }));

    // 保存: the same body as a save here, applied and audited there; primary is never passed on.
    const beforeB = readAudit(path.join(otherHome, 'data')).length;
    const saved = await api(`/api/peers/${enc}/bots/ops`, { method: 'PATCH', body: { name: far?.name, role: '从这台改的职责', tools: [...(far?.tools || []), 'fs_delete'], policy: { autoApproveMedium: false }, model: bModel?.id, voice: '', primary: true } });
    const there = (await bApi('/api/bots/ops')).json?.bot;
    const auditedThere = readAudit(path.join(otherHome, 'data')).slice(beforeB).find((e) => e.kind === 'bot.abilities' && e.botId === 'ops');
    const auditedHere = readAudit(process.env.ASSIST_DATA_DIR).reverse().find((e) => e.kind === 'peer.bot.update' && e.machine === M && e.botId === 'ops');
    check('F63-6b 保存 lands on that machine (role, abilities, its model), is audited there like a save there, and here as passed on; making it the main assistant is not passed on',
      saved.status === 200 && saved.json?.bot?.id === `ops@${M}` && there?.role === '从这台改的职责' && there.tools.includes('fs_delete') && there.model === bModel?.id && !there.primary
      && Boolean(auditedThere?.added?.includes('fs_delete')) && Array.isArray(auditedHere?.fields) && !auditedHere.fields.includes('primary'),
      JSON.stringify({ saved: saved.status, role: there?.role, model: there?.model, primary: there?.primary, auditedThere, auditedHere }));

    // The picture: the same checks as here, then on that machine; removing it too.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f6a1b40000000049454e44ae426082', 'hex');
    const up = await rawFetch(`${base}/api/peers/${enc}/bots/ops/avatar`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-lamplit-local': aKey() }, body: png });
    const upJson = await up.json().catch(() => null);
    const hasImage = (await bApi('/api/bots/ops')).json?.bot?.avatar?.hasImage;
    const lie = await rawFetch(`${base}/api/peers/${enc}/bots/ops/avatar`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-lamplit-local': aKey() }, body: Buffer.from('<html>not a picture</html>') });
    await lie.text().catch(() => '');
    const viaHere = await rawFetch(`${base}/api/peers/${enc}/avatar/ops`, { headers: { 'x-lamplit-local': aKey() } });
    await viaHere.arrayBuffer().catch(() => null);
    const gone = await api(`/api/peers/${enc}/bots/ops/avatar`, { method: 'DELETE' });
    const hasImageAfter = (await bApi('/api/bots/ops')).json?.bot?.avatar?.hasImage;
    check('F63-6c its picture can be changed from here: a real PNG goes to that machine and shows through this hub; one that is not a picture is refused here; removing it removes it there',
      up.status === 200 && upJson?.imageUrl === `/api/peers/${enc}/avatar/ops` && hasImage === true && lie.status === 400 && viaHere.status === 200 && gone.status === 200 && hasImageAfter === false,
      JSON.stringify({ up: up.status, upJson, hasImage, lie: lie.status, viaHere: viaHere.status, gone: gone.status, hasImageAfter }));

    // A call another hub passed on is never passed on (no hop to a third machine); only paired machines; only the human.
    const passed = await rawFetch(`${base}/api/peers/${enc}/bots/ops`, { method: 'PATCH', headers: { authorization: `Bearer ${aToken}`, 'x-lamplit-via': '1', 'content-type': 'application/json', 'x-no-local-key': '1' }, body: JSON.stringify({ role: '第三台机器改的' }) });
    const passedGet = await rawFetch(`${base}/api/peers/${enc}/bots/ops`, { headers: { authorization: `Bearer ${aToken}`, 'x-lamplit-via': '1', 'x-no-local-key': '1' } });
    const stranger = await api('/api/peers/%E6%B2%A1%E6%9C%89%E8%BF%99%E5%8F%B0/bots/ops', { method: 'PATCH', body: { role: 'x' } });
    const noKey = await rawFetch(`${base}/api/peers/${enc}/bots/ops`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-no-local-key': '1' }, body: JSON.stringify({ role: '机器人自己改的' }) });
    const roleNow = (await bApi('/api/bots/ops')).json?.bot?.role;
    check('F63-6d a request another hub passed on is refused (403, nothing changes there), an unknown machine is refused, and a program on this computer without the key gets nowhere',
      passed.status === 403 && passedGet.status === 403 && stranger.status === 404 && noKey.status === 403 && roleNow === '从这台改的职责',
      JSON.stringify({ passed: passed.status, passedGet: passedGet.status, stranger: stranger.status, noKey: noKey.status, roleNow }));

    // That machine off: the read says so; nothing is written.
    await stopProcess(other.child);
    other = null;
    const off = await api(`/api/peers/${enc}/bots/ops`);
    const offSave = await api(`/api/peers/${enc}/bots/ops`, { method: 'PATCH', body: { role: 'x' } });
    check('F63-6e with that machine off the read answers 「连不上」 (502), and a save cannot land anywhere',
      off.status === 502 && off.json?.error?.code === 'PEER_UNREACHABLE' && /连不上/.test(off.json?.error?.message || '') && offSave.status === 502, JSON.stringify({ off: off.status, offSave: offSave.status, err: off.json?.error }));
  } finally {
    await api('/api/peers', { method: 'PUT', body: { peers: [] } }).catch(() => {});
    if (other) await stopProcess(other.child).catch(() => {});
  }

  // The page: nothing is shown or saved as real until that machine answered; off or older: the note, no PATCH.
  const bots = await readText('../public/app/main/04-bots.js');
  const sent = [];
  const nodes = {};
  const node = (id) => (nodes[id] ||= { id, hidden: false, disabled: false, checked: false, textContent: '', innerHTML: '', value: '', appendChild() {}, closest: () => node('danger') });
  const st = { botEditRemote: null, bots: [] };
  // eslint-disable-next-line no-new-func
  const page = new Function('$', 'state', 'api', 'el', 'remoteApi', 'setBotEditNote', 'renderBotModelSelect', 'renderBotVoiceSelect', 'renderAbilities', 'botById', 'isRemoteId', 'toolsFromAbilities',
    `${fnSource(bots, 'loadRemoteBotEdit')}\n${fnSource(bots, 'saveBotEdit')}\nreturn { loadRemoteBotEdit, saveBotEdit };`)(
    node, st, async (p, o = {}) => { sent.push({ p, method: o.method || 'GET' }); const e = new Error('「书房电脑」现在连不上'); e.code = 'NOT_FOUND'; e.status = 502; throw e; },
    () => ({}), (id) => `/api/peers/x/bots/${id}`, (t) => { node('botedit-note').textContent = t; }, () => {}, () => {}, () => {}, () => null, () => true, () => [],
  );
  st.botEditRemote = { id: 'ops@书房电脑', machine: '书房电脑', bot: null, error: '' };
  node('botedit-save').disabled = true;
  await page.loadRemoteBotEdit('ops@书房电脑');
  node('botedit-name-input').value = 'x';
  await page.saveBotEdit();
  check('F63-6f in the page: a machine that does not answer (off, or an older Lamplit without the route) gives 「<machine> 现在连不上，连上后再改」, 保存 stays off and no PATCH is sent',
    node('botedit-note').textContent === '「书房电脑」现在连不上，连上后再改' && node('botedit-save').disabled === true && !sent.some((s) => s.method === 'PATCH'),
    JSON.stringify({ note: node('botedit-note').textContent, sent }));
  const html = await readText('../public/index.html');
  check('F63-6g the drawer\'s labels are unchanged (保存, 删除这个助手, 设为主助理, 试听); deleting it or making it the main assistant there is hidden for a bot on another machine',
    html.includes('>保存</button>') && html.includes('>删除这个助手</button>') && html.includes('>设为主助理</button>') && html.includes('>试听</button>')
    && /danger\.hidden = remote/.test(bots) && /prim\.hidden = Boolean\(bot\.primary\) \|\| remote/.test(bots) && /if \(!bot \|\| isRemoteId\(bot\.id\)\) return;/.test(bots));
}
