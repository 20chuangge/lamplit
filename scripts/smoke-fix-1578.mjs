// 1.5.78: from 11-27/28. A server on the internet (a public address, no cloud firewall) was added through
// 「添加机器」 as 「只在家里用」: this computer then talked to it by plain http across the internet - the login,
// the chats, and during the install the model key - and nothing said so.
//   1. the page stops once at 「只在家里用」 for an address on the internet and picks the relay;
//   2. a Linux server gets the model, voice and vision settings over the SSH session, not by http;
//   3. the desktop app tries a machine's encrypted ways (Tailscale, the relay) before a public http address.
// Called from smoke.mjs as a stage.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export async function fix1578Checks({ check, readText }) {
  const R = await import('../src/remote.mjs');
  const G = await import('../desktop/guard.mjs');
  const remote = await readText('../src/remote.mjs');
  const shell = await readText('../desktop/main.mjs');
  const page = await readText('../public/app/main/11-machines.js');
  const script = (await readText('../hub/hub-settings-push.sh')).replace(/\r\n/g, '\n');

  // --- the page ---------------------------------------------------------------------------------------
  const src = /function onTheInternet\(host\) \{[\s\S]*?\n\}/.exec(page.replace(/\r\n/g, '\n'))?.[0] || '';
  const onTheInternet = src ? new Function(`${src}; return onTheInternet;`)() : () => null;
  const out = ['8.8.8.8', '203.0.113.7', 'vps.example.com'];
  const home = ['192.168.1.20', '10.0.0.5', '172.16.3.4', '100.101.102.103', '127.0.0.1', '169.254.1.1', 'nas.local', 'box.lan', 'mypc', '999.1.1.1', ''];
  check('NET78-1 「添加机器」: an address on the internet (a public IPv4, a domain name) chosen as 「只在家里用」 stops once - it says the connection would not be encrypted, picks 自建中转, and a second click with 「只在家里用」 goes on; a home address (192.168…, 10…, a Tailscale 100.x, nas.local, a bare name) is not stopped',
    out.every((h) => onTheInternet(h) === true) && home.every((h) => onTheInternet(h) === false)
    && page.includes("if (reach.options?.outside === 'home' && onTheInternet(address.host) && openWayAck !== address.host) {") && page.includes('openWayAck = address.host;')
    && page.includes('input[name="vnc-outside"][value="relay"]') && /不加密：登录凭证和聊天内容在网上是明文/.test(page) && /改回「只在家里用」再点一次/.test(page),
    JSON.stringify({ out: out.map(onTheInternet), home: home.map(onTheInternet) }));

  // --- the settings over SSH --------------------------------------------------------------------------
  const items = R.settingsItems({ provider: 'deepseek', apiKey: 'k' }, { apiKey: 'v' }, null);
  check('NET78-2 a Linux server gets the model settings (then voice, vision) over the SSH session - a root-only file handed to its Lamplit on 127.0.0.1 with the local key - whether or not this computer reaches it, and without the pairing code; only a Windows machine still gets them by http',
    items.map((i) => i.path).join() === '/api/settings,/api/voice' && R.settingsItems(null, null, null).length === 0
    && remote.includes('const overSsh = !windows ? modelToShare() : null;') && remote.includes('const model = reachable && windows ? modelToShare() : null;')
    && remote.includes("await pushSettingsOverSsh(client, { sudoPrefix, password, isRoot }, settingsItems(overSsh, voiceToShare(), visionToShare()))")
    && remote.includes('umask 077; cat > ${body}') && remote.includes('{ drop: [body] }')
    && script.includes('"x-lamplit-local": key') && script.includes('http://127.0.0.1:${port}${item.path}') && script.includes('echo "DESK_HUB_SETTINGS=$1"') && script.includes('rm -f "$BODY"'),
    JSON.stringify(items.map((i) => i.path)));

  // The part of the script that talks to the hub, run for real against a small server.
  const js = /"\$NODE" -e '\n([\s\S]*?)\n' "\$BODY"/.exec(script)?.[1] || '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push78-'));
  const seen = [];
  let failVoice = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-lamplit-local'] || '', body });
      const bad = failVoice && req.url === '/api/voice';
      res.writeHead(bad ? 400 : 200, { 'content-type': 'application/json' });
      res.end(bad ? '{"error":{"message":"unknown voice provider"}}' : '{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'local-key'), 'LOCALKEY\n');
  const run = (file) => new Promise((resolve) => execFile(process.execPath, ['-e', js, file, String(port), path.join(dir, 'local-key')], { timeout: 30000 }, (_e, stdout) => resolve(String(stdout).trim().split('\n').pop())));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify(R.settingsItems({ provider: 'deepseek', model: 'm', apiKey: 'sk-x' }, { apiKey: 'v' }, { apiKey: 'w' })));
  const ok = js ? await run(good) : 'no script';
  const okSeen = seen.splice(0);
  const evil = path.join(dir, 'evil.json');
  fs.writeFileSync(evil, JSON.stringify([{ path: '/api/bots/chief', body: { persona: 'x' } }]));
  const refused = js ? await run(evil) : 'no script';
  const evilSeen = seen.splice(0).length;
  failVoice = true;
  const partial = js ? await run(good) : 'no script';
  const partialSeen = seen.splice(0).map((s) => s.url);
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  check('NET78-3 that script hands each setting to the hub in order with the local key and says ok; it takes only the three settings paths (anything else in the file is refused, nothing sent); a setting the hub refuses stops it there with the hub\'s own words',
    ok === 'ok' && okSeen.map((s) => `${s.method} ${s.url}`).join() === 'PUT /api/settings,PUT /api/voice,PUT /api/vision' && okSeen.every((s) => s.key === 'LOCALKEY') && JSON.parse(okSeen[0].body).apiKey === 'sk-x'
    && refused === 'error:设置文件的内容不对' && evilSeen === 0 && /^error:\/api\/voice unknown voice provider/.test(partial) && partialSeen.join() === '/api/settings,/api/voice',
    JSON.stringify({ ok, refused, evilSeen, partial, partialSeen, okSeen: okSeen.map((s) => s.url) }));

  // --- the desktop app --------------------------------------------------------------------------------
  const open = ['http://8.8.8.8:4390', 'http://203.0.113.7:4390/'];
  const shut = ['http://192.168.1.20:4390', 'http://100.101.102.103:4390', 'http://127.0.0.2:46058', 'https://8.8.8.8:4390', 'http://vps.example.com:4390', ''];
  check('NET78-4 the desktop app: a machine whose own address is plain http to a public IPv4 is reached by its Tailscale address or the relay first; its open address comes last and the log says it is talked to in the clear; a home or Tailscale address is tried first as before',
    open.every(G.openInternetAddress) && !shut.some(G.openInternetAddress)
    && shell.includes("if (!open && process.env.DESK_FORCE_TAILNET !== '1' && await probeHub(url)) return url;")
    && shell.includes("if (open && process.env.DESK_FORCE_TAILNET !== '1' && await probeHub(url)) {") && shell.includes('with no Tailscale or relay: talking to it in the clear'),
    JSON.stringify({ open: open.map(G.openInternetAddress), shut: shut.map(G.openInternetAddress) }));
}
