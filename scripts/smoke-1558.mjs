#!/usr/bin/env node
/**
 * smoke-1558.mjs - 1.5.58: a bot's screen on another machine, in 全部机器.
 *
 * 11-22, on the user's PC: a group's bots on the cloud machine (reached only
 * through the relay). The 电脑 tab got the screen's address, but the viewer
 * said 「无法连接到服务器」 and was labelled 「实时画面 · Windows 电脑」 -
 * this hub opened the far screen's socket without the relay, and the label
 * named the machine of the page instead of the bot's.
 *
 *   remoteScreenChecks({check})   the label names the other machine; the
 *                                 socket bridge goes through the relay when
 *                                 that is the way (scripts/e2e-relay.mjs runs it)
 *
 * Run alone: node scripts/smoke-1558.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** A function's source out of a page part, made callable with the given helpers. */
function extract(text, name, helpers = {}) {
  const m = text.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found`);
  return new Function(...Object.keys(helpers), `${m[0]}; return ${name};`)(...Object.values(helpers));
}

export async function remoteScreenChecks({ check }) {
  const groups = read('public/app/main/03-groups.js');
  const machines = (read('public/app/main/11-machines.js') + read('public/app/main/11a-network.js'));
  const state = { computer: null };
  const name = extract(groups, 'screenMachineName', { state, machineDisplayName: () => 'Windows 电脑' });
  state.computer = { remote: { machine: '腾讯云 -ubuntu', botId: 'resume' }, desktop: { url: '/novnc/vnc.html?path=x' } };
  const far = name();
  state.computer = { desktop: { url: '/novnc/vnc.html?path=y' } };
  const here = name();
  check('label: a bot\'s screen on another machine is named after that machine (腾讯云 -ubuntu, not Windows 电脑)', far === '腾讯云 -ubuntu', far);
  check('label: a bot of this machine still gets this machine\'s name', here === 'Windows 电脑', here);
  const viewer = machines.match(/function syncViewer\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  check('label: the screen viewer\'s 「实时画面 · …」 and its frame title use that name, not the page machine\'s',
    viewer.includes('`实时画面 · ${screenMachineName()}`') && viewer.includes('`${screenMachineName()}桌面`') && !/实时画面 · \$\{machineDisplayName\(\)\}/.test(viewer));

  const server = read('src/server.mjs');
  const bridge = server.match(/async function bridgePeerDesktop\([^)]*\) \{[\s\S]*?\n\}/)?.[0] || '';
  check('socket: the far screen\'s address is asked the usual way (relay included), not with noRelay', bridge.includes("state.peers.call(peer, 'GET', '/api/health', { timeoutMs: 5000 })") && !/noRelay/.test(bridge));
  check('socket: through the relay it opens a pinned connection (connectViaRelay, the direct channel when up) and names that machine to it',
    /connectViaRelay\(way\.relay, \{ direct: state\.peers\.directDialer\?\.\(\) \|\| null \}\)/.test(bridge) && bridge.includes('send(upstream, relayServerName(way.relay.id))'));
  check('socket: still only the human (this computer\'s key), never a call another hub passed on',
    bridge.includes("if (req.headers[VIA_HEADER]) return refuse(403, 'Forbidden');") && bridge.includes("if (!carriesLocalKey(req, auth, P.dataDir, state.devices, state.security)) return refuse(403, 'Forbidden');"));
  const e2e = read('scripts/e2e-relay.mjs');
  check('e2e: scripts/e2e-relay.mjs opens a bot\'s screen on B from A through the relay and over B\'s own address',
    e2e.includes('the screen of a bot on B opens in A\\\'s window through the relay') && e2e.includes('over B\\\'s own address the screen'));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let failed = 0;
  let passed = 0;
  const check = (n, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok  ${n}`); } else { failed += 1; console.log(`  FAIL ${n}${detail ? `\n       ${detail}` : ''}`); }
  };
  remoteScreenChecks({ check }).then(() => {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }, (err) => { console.error(err); process.exit(1); });
}
