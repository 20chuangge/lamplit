/**
 * test-ports.mjs - ports for the smoke tests that Windows really gives out (1.5.63).
 *
 * Windows keeps some port ranges for itself (Hyper-V, WSL, Docker: see
 * `netsh int ipv4 show excludedportrange protocol=udp`), and the TCP and UDP
 * lists differ. A port the system handed out for TCP can be one of the kept
 * UDP ones, so a relay that answers STUN on "its TCP port number" failed now
 * and then with `bind EACCES` (CI runners mostly). A port picked at random can
 * be a kept one too. These helpers try another port instead (smoke-1549.mjs
 * did this first, in 1.5.62).
 */
import dgram from 'node:dgram';
import net from 'node:net';

const TRIES = 8;

/** Can a UDP socket have this port right now? (closed again at once) */
export function udpFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* never opened */ } resolve(false); });
    s.bind(port, host, () => s.close(() => resolve(true)));
  });
}

/** Can a TCP server have this port right now? (closed again at once) */
export function tcpFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

const listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (err) => { server.off('listening', onListening); reject(err); };
  const onListening = () => { server.off('error', onError); resolve(server.address().port); };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

/**
 * Start a relay's TCP server on a port whose number UDP can have too, for its
 * STUN answers. stun: true also starts those answers (stunOptions passed on);
 * false only makes sure they can start later on the same number.
 * -> the port. Whatever was opened is closed again when every try failed.
 */
export async function listenRelay(relay, { host = '127.0.0.1', stun = false, stunOptions } = {}) {
  let last = null;
  for (let tries = 1; tries <= TRIES; tries += 1) {
    const port = await listen(relay.server, 0, host);
    try {
      if (stun) await relay.listenStun(port, host, ...(stunOptions ? [stunOptions] : []));
      else if (!(await udpFree(port, host))) throw Object.assign(new Error(`bind EACCES ${host}:${port} (udp)`), { code: 'EACCES' });
      return port;
    } catch (err) {
      last = err;
      await close(relay.server);
    }
  }
  try { relay.close?.(); } catch { /* already closed */ }
  throw last;
}

/**
 * `count` free TCP ports in a row (port, port+1, ...) for a program that is
 * told its port up front (a browser's --remote-debugging-port): the system's
 * own pick, so not a kept one, and checked free before it is used.
 */
export async function freeTcpPorts(count = 1, host = '127.0.0.1') {
  for (let tries = 1; tries <= TRIES * 2; tries += 1) {
    const probe = net.createServer();
    const port = await listen(probe, 0, host);
    await close(probe);
    if (port + count - 1 > 65535) continue;
    let ok = true;
    for (let i = 0; i < count && ok; i += 1) ok = await tcpFree(port + i, host);
    if (ok) return port;
  }
  throw new Error(`no ${count} free TCP ports in a row on ${host}`);
}
