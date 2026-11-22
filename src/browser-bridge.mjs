/**
 * browser-bridge.mjs - the bot's browser on the Windows desktop, with no port
 * (1.5.61, the verifier's N1 / F7).
 *
 * A hub in Windows' service session cannot show a window. To put the bot's
 * browser on the desktop of whoever is signed in at the console, it has a
 * scheduled task run this file in that session. Chrome is started here with
 * --remote-debugging-pipe (fds 3 and 4), and this program dials back to the
 * hub on 127.0.0.1 and relays the pipe over that connection. Chrome listens on
 * nothing; the hub listens only until this program has presented the one-time
 * token from the ticket.
 *
 *   node browser-bridge.mjs <ticket.json>            (from the scheduled task:
 *                                                    hands itself to a copy with no window)
 *   node browser-bridge.mjs <ticket.json> --child    (that copy)
 *
 * The ticket (in Lamplit's data folder, which the bots' account cannot read):
 * {port, token, exe, args, env}. It is removed as soon as it is read. When the
 * hub's end goes away, Chrome is stopped; when Chrome ends, so does this.
 */
import fs from 'node:fs';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { childEnv } from './childenv.mjs';

const [ticketFile, mode] = process.argv.slice(2);

if (mode !== '--child') {
  // Started by the task in a (minimised) console window: a copy with no window does the work.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ticketFile, '--child'], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}

let ticket;
try {
  ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
} catch {
  process.exit(2);
} finally {
  try { fs.rmSync(ticketFile, { force: true }); } catch { /* the hub removes it too */ }
}
if (!ticket?.port || !ticket?.token || !ticket?.exe || !Array.isArray(ticket.args)) process.exit(2);

const chrome = spawn(ticket.exe, ticket.args, {
  // 3: what Chrome reads, 4: what it writes. A visible window (windowsHide: false).
  stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  env: { ...childEnv(process.env), ...(ticket.env || {}) },
  windowsHide: false,
});
let done = false;
const stopChrome = () => {
  if (!chrome.pid || chrome.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    else chrome.kill();
  } catch { /* gone */ }
};
const finish = (code) => {
  if (done) return;
  done = true;
  stopChrome();
  setTimeout(() => process.exit(code), 200).unref();
};
chrome.on('error', () => finish(3));

const socket = net.connect({ host: '127.0.0.1', port: Number(ticket.port) }, () => {
  socket.write(`${ticket.token}\n${chrome.pid || 0}\n`);
  socket.pipe(chrome.stdio[3]);
  chrome.stdio[4].pipe(socket);
});
socket.on('error', () => finish(4));
socket.on('close', () => finish(0));
chrome.stdio[3].on('error', () => finish(5));
chrome.on('exit', () => { try { socket.end(); } catch { /* gone */ } finish(0); });
