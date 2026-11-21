/**
 * smoke-sec1553.mjs - 1.5.53: what only the human may do is the default.
 *
 * The 11-21 pre-launch security review found that 「只有本人能做」 was a list of
 * routes, and the routes left off it could be chained: a program on this
 * computer without the local key (a bot's own `curl`) asked this hub for
 * another machine's pairing link (/api/machines/:name/handoff), paired itself
 * there, asked that machine for this one's link, and was the human on both
 * (S1). It could also move the workspace (H1), have a server of its own
 * "added" and receive the model keys (H2), rewrite a bot's rules (M1), swap the
 * machine list (M2), open the public door (M3), take a screenshot (M4) and
 * pass as another machine (M5). Feishu's 6-digit code matched anywhere in a
 * message, never expired and had no attempt limit (H3).
 *
 * Now every /api route needs the human (the local key, a paired device, or
 * another of the human's hubs with its token) unless it is on the short,
 * reviewed list in src/auth.mjs (OPEN_ROUTES). The sweep below asks every
 * route in server.mjs without a key: a new route cannot be open by accident.
 */
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The routes server.mjs declares: [{method, re, source}]. */
export function declaredRoutes(serverSrc) {
  const out = [];
  const re = /route\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*(\/\^.*?\$\/)\s*,/gs;
  for (const m of serverSrc.matchAll(re)) {
    const body = m[2].slice(1, -1);
    out.push({ method: m[1], source: body, re: new RegExp(body) });
  }
  return out;
}

/** A path that the route's pattern matches: each named part becomes its first choice or "x1". */
export function samplePath(source) {
  let s = source.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\(\?<\w+>([^()]*)\)/g, (_, inner) => (/^[a-z|]+$/i.test(inner) ? inner.split('|')[0] : 'x1'));
  return s.replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\\./g, '.');
}

/** A WebSocket handshake to `port` -> the status code of the answer. */
function upgradeStatus(port, pathName, headers = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${pathName} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); if (m) { resolve(Number(m[1])); sock.destroy(); } });
    sock.on('error', () => resolve(0));
    sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] || 0)));
    setTimeout(() => { sock.destroy(); resolve(0); }, 5000).unref?.();
  });
}

export async function secChecks({ check, api, rawFetch, base, readText, startServerChild, stopProcess, seedHome }) {
  const A = await import('../src/auth.mjs');
  const noKey = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await rawFetch(`${base}${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const refused = (r) => r.status === 403 && r.json?.error?.code === 'LOCAL_KEY_REQUIRED';

  // --- S1: the handoff chain, with a second hub that lets phones in ---------------------
  const otherHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'assist-smoke-sec-'));
  await seedHome(otherHome);
  let other = null;
  try {
    // Phones may connect to it (a LAN address), so it can make pairing links, as a real second machine does.
    other = await startServerChild(otherHome, { HOST: '0.0.0.0', ASSIST_ALLOW_REMOTE: '1', ASSIST_DATA_DIR: path.join(otherHome, 'data'), ASSIST_WORKSPACE_DIR: path.join(otherHome, 'workspace') });
    const B = `http://127.0.0.1:${other.ready.port}`;
    const bKey = fsSync.readFileSync(path.join(otherHome, 'data', 'local-key'), 'utf8').trim();
    const bToken = JSON.parse(fsSync.readFileSync(path.join(otherHome, 'data', 'security.json'), 'utf8')).token;
    const aToken = JSON.parse(fsSync.readFileSync(path.join(process.env.ASSIST_DATA_DIR, 'security.json'), 'utf8')).token;
    const bCall = async (p, { method = 'GET', body, headers = {} } = {}) => {
      const res = await rawFetch(`${B}${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text };
    };
    // The two know each other, as the desktop app hands the list out (with the key).
    await api('/api/peers', { method: 'PUT', body: { peers: [{ name: '书房', url: B, token: bToken }] } });
    await bCall('/api/peers', { method: 'PUT', body: { peers: [{ name: '这台', url: base, token: aToken }] }, headers: { 'x-lamplit-local': bKey } });

    const hop = await noKey(`/api/machines/${encodeURIComponent('书房')}/handoff`, { method: 'POST' });
    check('SEC-S1 a program on this computer without the key cannot get another machine\'s pairing link through this hub (the first step of the chain)',
      refused(hop) && !hop.text.includes('pair='), `${hop.status} ${hop.text.slice(0, 160)}`);
    const human = await api(`/api/machines/${encodeURIComponent('书房')}/handoff`, { method: 'POST' });
    const linkB = human.json?.url ? new URL(human.json.url).searchParams.get('pair') : '';
    check('SEC-S1b the human\'s app still hands a phone over to the other machine (its link pairs there once)', human.status === 200 && Boolean(linkB), human.text.slice(0, 200));
    const paired = linkB ? await bCall('/api/pair', { method: 'POST', body: { token: linkB, client: 'app', deviceName: 'smoke phone' } }) : { json: {} };
    const dev = paired.json?.token ? { authorization: `Bearer ${paired.json.token}` } : {};
    const devPairing = await bCall('/api/pairing', { headers: dev });
    const devPolicy = await bCall('/api/policy', { headers: dev });
    check('SEC-S1c a paired device is still the human there (its token reaches what only the human may do)', paired.status === 200 && devPairing.status === 200 && devPolicy.status === 200, `${paired.status} ${devPairing.status} ${devPolicy.status}`);
    const hubCall = await bCall('/api/bots', { headers: { authorization: `Bearer ${bToken}` } });
    const hubAnswer = await bCall('/api/inbox/x/ap_none', { method: 'POST', body: { decision: 'approve' }, headers: { authorization: `Bearer ${bToken}` } });
    check('SEC-S1d another of the human\'s hubs (its token) still works there: reads, and what it passes on', hubCall.status === 200 && hubAnswer.status !== 403, `${hubCall.status} ${hubAnswer.status}`);
    const bProgram = await bCall(`/api/machines/${encodeURIComponent('这台')}/handoff`, { method: 'POST' });
    check('SEC-S1e the same holds on the other machine: its programs cannot ask it for this machine\'s link', refused(bProgram), `${bProgram.status} ${bProgram.text.slice(0, 160)}`);

    // --- N1 (1.5.53 review): the 8-digit code guessed from 127.0.0.2, 127.0.0.3, ... ------
    const bPort = Number(new URL(B).port);
    const tryFrom = (localAddress, codeTry) => new Promise((resolve) => {
      const body = JSON.stringify({ code: codeTry });
      const req = http.request({ host: '127.0.0.1', port: bPort, path: '/api/pair', method: 'POST', localAddress, agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let t = '';
        res.on('data', (d) => { t += d; });
        res.on('end', () => resolve({ status: res.statusCode, code: (() => { try { return JSON.parse(t).error?.code || ''; } catch { return ''; } })() }));
      });
      req.on('error', (e) => resolve({ status: 0, code: e.code }));
      req.end(body);
    });
    const withB = { headers: { 'x-lamplit-local': bKey } };
    const codeBefore = (await bCall('/api/pairing', withB)).json?.code || '';
    const tally = {};
    for (let ip = 2; ip <= 30; ip += 1) {
      for (let i = 0; i < 5; i += 1) {
        let guess = String(10000000 + ip * 10 + i);
        if (guess === codeBefore) guess = String(Number(guess) + 1);
        const r = await tryFrom(`127.0.0.${ip}`, guess);
        tally[r.status] = (tally[r.status] || 0) + 1;
      }
    }
    const codeAfter = (await bCall('/api/pairing', withB)).json?.code || '';
    check('SEC-N1a a program here gets 5 tries in all, not 5 from each loopback address (127.0.0.2-30); the rest are refused',
      (tally[401] || 0) <= 5 && (tally[429] || 0) >= 140, JSON.stringify(tally));
    const rightButPaused = await tryFrom('127.0.0.1', codeAfter);
    const authB = (await bCall('/api/auth')).json || {};
    check('SEC-N1b after 20 wrong tries the code is changed and the code is refused for a while, even the right one; the page is told not to offer it',
      /^\d{8}$/.test(codeAfter) && codeAfter !== codeBefore && rightButPaused.status === 429 && rightButPaused.code === 'PAIR_CODE_PAUSED' && authB.codeAllowed === false,
      JSON.stringify({ changed: codeAfter !== codeBefore, rightButPaused, codeAllowed: authB.codeAllowed }));
    const qr = (await bCall('/api/pairing/link', { method: 'POST', ...withB })).json;
    const qrToken = qr?.url ? new URL(qr.url).searchParams.get('pair') : '';
    const qrPaired = qrToken ? await bCall('/api/pair', { method: 'POST', body: { token: qrToken, client: 'app' } }) : { status: 0 };
    check('SEC-N1c the QR code\'s one-time link still pairs while the code is paused', qrPaired.status === 200 && Boolean(qrPaired.json?.token), String(qrPaired.status));
  } finally {
    await api('/api/peers', { method: 'PUT', body: { peers: [] } }).catch(() => {});
    if (other?.child) await stopProcess(other.child);
    await fsp.rm(otherHome, { recursive: true, force: true }).catch(() => {});
  }

  // --- the named findings, one by one ----------------------------------------------------
  const workspace = await noKey('/api/workspace', { method: 'PUT', body: { path: path.join(os.tmpdir(), 'lamplit-wide') } });
  check('SEC-H1 a program without the key cannot move the bots\' workspace', refused(workspace), workspace.text.slice(0, 160));
  const provision = await noKey('/api/remote/provision', { method: 'POST', body: { host: '127.0.0.1', sshPort: 1, username: 'x', password: 'y' } });
  const relayJob = await noKey('/api/remote/relay', { method: 'POST', body: { host: '127.0.0.1', sshPort: 1, username: 'x', password: 'y' } });
  check('SEC-H2 a program without the key cannot have a server "added" (which would receive the model, voice and vision keys and the relay\'s join secret)', refused(provision) && refused(relayJob), `${provision.status} ${relayJob.status}`);
  const feishuView = await noKey('/api/feishu');
  check('SEC-H3a the Feishu pairing code is not readable by a program on this computer', refused(feishuView) && !/pairCode/.test(feishuView.text), feishuView.text.slice(0, 160));
  const persona = await noKey('/api/bots/chief', { method: 'PATCH', body: { persona: 'rewritten by a program' } });
  const role = await noKey('/api/bots/chief', { method: 'PATCH', body: { role: '助理' } });
  const said = await noKey('/api/bots/chief/message', { method: 'POST', body: { text: 'a program speaking as you' } });
  check('SEC-M1 a program without the key cannot rewrite a bot\'s rules or job, or speak to a bot as you', refused(persona) && refused(role) && refused(said), `${persona.status} ${role.status} ${said.status}`);
  const peers = await noKey('/api/peers', { method: 'PUT', body: { peers: [{ name: '假的', url: 'http://127.0.0.1:9', token: 'attackerTOKEN1' }] } });
  check('SEC-M2 a program without the key cannot swap the list of the human\'s machines', refused(peers) && !JSON.stringify((await api('/api/peers')).json || {}).includes('假的'), peers.text.slice(0, 160));
  const funnel = await noKey('/api/funnel', { method: 'POST', body: { enabled: false } });
  const funnelThere = await noKey('/api/machines/x/funnel', { method: 'POST', body: { enabled: false } });
  check('SEC-M3 a program without the key cannot open the public door, here or on another machine', refused(funnel) && refused(funnelThere), `${funnel.status} ${funnelThere.status}`);
  const shot = await noKey('/api/computer/screenshot');
  const phoneShot = await noKey('/api/phone/screen');
  const clip = await noKey('/api/bots/chief/desktop/clipboard');
  check('SEC-M4 a program without the key cannot see the screen, the phone\'s screen or a desktop\'s clipboard', refused(shot) && refused(phoneShot) && refused(clip), `${shot.status} ${phoneShot.status} ${clip.status}`);
  const put = await noKey('/api/workspace/file?path=sec.txt', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' } });
  const task = await noKey('/api/tasks/import', { method: 'POST', body: { botId: 'chief', goal: 'x', steps: [{ title: 'a' }, { title: 'b' }] } });
  const door = await noKey('/api/remote/relay-door', { method: 'POST', body: { url: 'http://x' } });
  check('SEC-M5 a program without the key does not pass as another machine (files, tasks) or as the desktop app (its local-only doors)', refused(put) && refused(task) && refused(door), `${put.status} ${task.status} ${door.status}`);
  const port = Number(new URL(base).port);
  const ws = await upgradeStatus(port, '/api/bots/chief/desktop/ws', { Origin: base });
  check('SEC-M6 a program without the key cannot open a bot\'s screen socket by naming this page as its Origin', ws === 403 || ws === 401, String(ws));

  // --- the sweep: every route is the human's or on the reviewed list -----------------------
  const serverSrc = await readText('../src/server.mjs');
  const routes = declaredRoutes(serverSrc);
  const declared = (serverSrc.match(/^route\(/gm) || []).length;
  check('SEC-SWEEP-0 the sweep reads every route server.mjs declares', routes.length === declared && routes.length > 150, `${routes.length} of ${declared}`);
  const unsampled = routes.filter((r) => !r.re.test(samplePath(r.source)));
  check('SEC-SWEEP-1 each route has a sample path its pattern matches', !unsampled.length, unsampled.map((r) => `${r.method} ${r.source}`).join(', '));
  const open = [];
  const notGated = [];
  for (const r of routes) {
    const p = samplePath(r.source);
    const listed = A.openRouteFor(r.method, p);
    if (listed) { open.push(`${r.method} ${p}`); continue; }
    const res = await noKey(p, { method: r.method });
    if (!refused(res)) notGated.push(`${r.method} ${p} -> ${res.status}`);
  }
  check('SEC-SWEEP-2 every route not on the reviewed list refuses a request from this computer without the key (403 LOCAL_KEY_REQUIRED)', !notGated.length, notGated.join('; '));
  const entries = A.OPEN_ROUTES;
  const stale = entries.filter((e) => !routes.some((r) => r.method === e.method && r.source === e.path.source));
  check('SEC-SWEEP-3 the reviewed list is short, every entry says why, and names a route that exists',
    entries.length > 0 && entries.length <= 8 && entries.every((e) => typeof e.why === 'string' && e.why.length > 20) && !stale.length,
    `${entries.length} entries; stale: ${stale.map((e) => `${e.method} ${e.path.source}`).join(', ')}`);
  check('SEC-SWEEP-4 what stays open without the key: health, pairing itself and the two sign-in callbacks', open.length === entries.length, open.join(', '));
  check('SEC-SWEEP-5 isAuthorityRequest is the default-deny rule: an unknown route is the human\'s', A.isAuthorityRequest('POST', '/api/some-new-route') && A.isAuthorityRequest('GET', '/api/some-new-route') && !A.isAuthorityRequest('GET', '/api/health'));
  const first = await noKey('/api/settings', { method: 'PUT', body: {} });
  check('SEC-SWEEP-6 the first-model exception needs at least one model field (an empty body is not a first setup)', refused(first), `${first.status} ${first.text.slice(0, 120)}`);

  // --- H3: Feishu pairing ---------------------------------------------------------------
  const FS = await import('../src/feishu.mjs');
  const { EventBus } = await import('../src/store.mjs');
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'feishu-sec-'));
  try {
    const sent = [];
    const fakeFetch = async (url, init = {}) => {
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, ...data }) });
      if (url.includes('tenant_access_token')) return ok({ tenant_access_token: 't-1', expire: 7200 });
      if (url.includes('/im/v1/messages')) { const c = JSON.parse(body.content); sent.push(c.zh_cn?.content?.[0]?.[0]?.text || JSON.stringify(c)); return ok({ data: {} }); }
      return ok({ data: {} });
    };
    let clock = Date.now();
    const mk = () => FS.createFeishu({
      file: path.join(dir, 'feishu.json'), bus: new EventBus(), workspaceDir: dir, fetchImpl: fakeFetch,
      runtime: { runTurn: async (t) => t }, approvals: { resolve: () => {} }, getBots: () => [{ id: 'chief', primary: true }], machineName: () => '测试机', now: () => clock,
    });
    const f = mk();
    await f.load();
    await f.update({ appId: 'cli_sec', appSecret: 'sec-x' });
    let n = 0;
    const say = async (who, text) => {
      n += 1;
      f._handleFrame(FS.encodeFrame({ method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: `s${n}` }], payload: Buffer.from(JSON.stringify({ header: { event_id: `se${n}`, event_type: 'im.message.receive_v1' }, event: { sender: { sender_id: { open_id: who }, sender_type: 'user' }, message: { message_id: `sm_${n}`, chat_id: `oc_${who}`, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } } })) }));
      await new Promise((r) => setTimeout(r, 30));
    };
    const code = f.view().pairCode;
    check('SEC-H3b the Feishu code is longer (8 digits)', /^\d{8}$/.test(code), code);
    await say('ou_scan', `0000000 ${code} 1111111`);
    check('SEC-H3c a message that only contains the code somewhere does not pair (exactly the code, or 「配对 」 and the code)', f.view().users.length === 0);
    for (let i = 0; i < 6; i += 1) await say('ou_guess', String(10000000 + i));
    await say('ou_guess', code);
    check('SEC-H3d after a few wrong tries the same sender is not paired even with the right code', f.view().users.length === 0 && /太多/.test(sent.at(-1) || ''), sent.at(-1));
    const before = f.view().pairCode;
    for (let i = 0; i < 20; i += 1) await say(`ou_many${i}`, String(20000000 + i));
    const after = f.view().pairCode;
    await say('ou_late', after);
    check('SEC-H3e many wrong tries from many senders change the code and pause pairing for a while', before !== after && f.view().users.length === 0 && /暂停|稍后/.test(sent.at(-1) || ''), sent.at(-1));
    clock += 16 * 60 * 1000;
    const fresh = f.view().pairCode;
    await say('ou_ok', `配对 ${fresh}`);
    check('SEC-H3f after the pause the human pairs with 「配对 」 and the code, once', f.view().users.length === 1 && f.view().pairCode !== fresh);
    const next = f.view().pairCode;
    clock += 31 * 60 * 1000;
    await say('ou_slow', next);
    check('SEC-H3g a code older than 30 minutes no longer pairs; a new one is shown', f.view().users.length === 1 && f.view().pairCode !== next && /过期/.test(sent.at(-1) || ''), sent.at(-1));
    f.stop();
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }

  // --- the English page froze on Settings (1.5.52 walkthrough #1) -----------------------
  const probe = await langLoopProbe(await readText('../public/app/lang.js'));
  check('I18N-1 English: a translation that still holds Chinese is not translated again by its own observer (the page froze on Settings); new text the app writes is still translated',
    probe.writes === 1 && probe.text === '开开x' && probe.later === '开开y' && probe.laterWrites === 2 && !probe.error, JSON.stringify(probe).slice(0, 200));
}

/**
 * The English page froze on opening Settings (1.5.52 walkthrough #1): lang.js
 * translated its own output again whenever a rule's result still held Chinese.
 * A fake page runs lang.js with such a rule and counts the writes to one node.
 * -> {writes, text, later}
 */
export async function langLoopProbe(langSrc, { ms = 300 } = {}) {
  const vm = await import('node:vm');
  let observer = null;
  const pending = [];
  let scheduled = false;
  let error = '';
  const flush = () => { scheduled = false; const batch = pending.splice(0); try { if (batch.length && observer) observer(batch); } catch (err) { error = err.message; } };
  const queue = (rec) => { pending.push(rec); if (!scheduled) { scheduled = true; setImmediate(flush); } };
  const parent = { closest: () => null };
  class FakeText {
    constructor(v) { this.nodeType = 3; this._v = v; this.parentElement = parent; this.writes = 0; }
    get nodeValue() { return this._v; }
    set nodeValue(v) { this._v = v; this.writes += 1; queue({ type: 'characterData', target: this }); }
  }
  const box = {
    localStorage: { getItem: () => 'en', setItem() {} },
    navigator: { language: 'en-US' },
    document: { documentElement: { lang: '' }, title: '', addEventListener() {}, body: null, createTreeWalker: () => ({ nextNode: () => null }) },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
    DESK_I18N_EN: { '开{0}': '开开{0}' }, // a rule whose result is translated again forever
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(langSrc, box);
  const node = new FakeText('');
  node._v = '开x';
  queue({ type: 'characterData', target: node });
  await new Promise((r) => setTimeout(r, ms));
  const writes = node.writes;
  const text = node.nodeValue;
  // The app writes new text into the same node: that is translated (once).
  node.nodeValue = '开y';
  await new Promise((r) => setTimeout(r, 50));
  return { writes, text: text.slice(0, 40), later: node.nodeValue, laterWrites: node.writes - writes, error };
}
