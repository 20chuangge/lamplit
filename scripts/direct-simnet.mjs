/**
 * direct-simnet.mjs - a pretend internet for the direct-connection tests
 * (1.5.46). No real sockets: hosts, NAT routers, latency, loss and reordering,
 * all in this process, so hole punching can be tried against every kind of
 * NAT without a phone, a carrier or a second network.
 *
 *   const net = createSimNet({ latencyMs: 20, loss: 0.05 });
 *   const home = net.nat('203.0.113.10', 'port');     // full | restricted | port | symmetric
 *   const pc = net.host('192.168.1.5', { nat: home });
 *   const relay = net.host('198.51.100.1');           // a public host, no NAT
 *   pc.createSocket('udp4')  -> a socket shaped like dgram's
 *
 * NAT kinds (RFC 4787 terms):
 *   full        endpoint-independent mapping and filtering ("full cone")
 *   restricted  endpoint-independent mapping, address-dependent filtering
 *   port        endpoint-independent mapping, address+port-dependent filtering
 *   symmetric   a new outside port for every destination, port-dependent filtering
 * Hosts behind the same NAT reach each other's private addresses (one LAN).
 * No hairpinning: a host behind a NAT cannot reach its own NAT's public address.
 */

import { EventEmitter } from 'node:events';

export function createSimNet({ latencyMs = 5, jitterMs = 0, loss = 0, reorder = 0, seed = 1 } = {}) {
  let rnd = seed >>> 0 || 1;
  const random = () => {
    // xorshift: the same run every time, so a failing case can be replayed
    rnd ^= rnd << 13; rnd >>>= 0;
    rnd ^= rnd >>> 17;
    rnd ^= rnd << 5; rnd >>>= 0;
    return rnd / 0x100000000;
  };
  const hosts = new Map(); // ip -> host
  const nats = new Map(); // public ip -> nat
  const stats = { sent: 0, delivered: 0, dropped: 0, filtered: 0 };
  const opts = { latencyMs, jitterMs, loss, reorder };

  function nat(publicIp, kind = 'port') {
    const n = {
      publicIp,
      kind,
      nextPort: 40000,
      out: new Map(), // "ip:port" (+ "|dst" when symmetric) -> outside port
      in: new Map(), // outside port -> {ip, port, allowed:Set<"ip"|"ip:port">}
      blocked: false, // drops every UDP packet (a network that blocks UDP)
    };
    nats.set(publicIp, n);
    return n;
  }

  function host(ip, { nat: behind = null } = {}) {
    const h = { ip, nat: behind, sockets: new Map(), nextPort: 50000 };
    hosts.set(ip, h);
    h.createSocket = () => createSocket(h);
    return h;
  }

  function createSocket(h) {
    const s = new EventEmitter();
    s.port = 0;
    s.closed = false;
    s.bind = (port = 0, _addr, cb) => {
      if (typeof port === 'function') { cb = port; port = 0; }
      if (typeof _addr === 'function') { cb = _addr; }
      s.port = port || h.nextPort++;
      h.sockets.set(s.port, s);
      queueMicrotask(() => { s.emit('listening'); cb?.(); });
      return s;
    };
    s.address = () => ({ address: '0.0.0.0', port: s.port, family: 'IPv4' });
    s.send = (buf, port, address, cb) => {
      if (s.closed) return;
      route(h, s.port, Buffer.from(buf), address, Number(port));
      if (typeof cb === 'function') queueMicrotask(() => cb(null));
    };
    s.close = (cb) => {
      s.closed = true;
      h.sockets.delete(s.port);
      queueMicrotask(() => { s.emit('close'); cb?.(); });
    };
    s.unref = () => s;
    s.ref = () => s;
    s.setRecvBufferSize = () => {};
    s.setSendBufferSize = () => {};
    return s;
  }

  function later(fn) {
    if (random() < opts.loss) { stats.dropped += 1; return; }
    let delay = opts.latencyMs + (opts.jitterMs ? random() * opts.jitterMs : 0);
    if (opts.reorder && random() < opts.reorder) delay += opts.latencyMs + 5;
    setTimeout(fn, Math.max(0, delay));
  }

  /** A packet leaves host h from port sport, to dst:dport. */
  function route(h, sport, buf, dst, dport) {
    stats.sent += 1;
    let srcIp = h.ip;
    let srcPort = sport;
    const target = hosts.get(dst);
    const sameLan = target && target.nat === h.nat && h.nat !== null;
    if (h.nat && !sameLan) {
      if (h.nat.blocked) { stats.filtered += 1; return; }
      const n = h.nat;
      const key = n.kind === 'symmetric' ? `${h.ip}:${sport}|${dst}:${dport}` : `${h.ip}:${sport}`;
      let outPort = n.out.get(key);
      if (!outPort) {
        outPort = n.nextPort++;
        n.out.set(key, outPort);
        n.in.set(outPort, { ip: h.ip, port: sport, allowed: new Set() });
      }
      const m = n.in.get(outPort);
      m.allowed.add(dst);
      m.allowed.add(`${dst}:${dport}`);
      srcIp = n.publicIp;
      srcPort = outPort;
    }
    later(() => deliver(srcIp, srcPort, buf, dst, dport));
  }

  function deliver(srcIp, srcPort, buf, dst, dport) {
    const n = nats.get(dst);
    if (n) {
      if (n.blocked) { stats.filtered += 1; return; }
      const m = n.in.get(dport);
      if (!m) { stats.filtered += 1; return; }
      const ok = n.kind === 'full' ? true : n.kind === 'restricted' ? m.allowed.has(srcIp) : m.allowed.has(`${srcIp}:${srcPort}`);
      if (!ok) { stats.filtered += 1; return; }
      return toSocket(hosts.get(m.ip), m.port, buf, srcIp, srcPort);
    }
    const h = hosts.get(dst);
    if (!h) { stats.filtered += 1; return; }
    // A host behind a NAT is reached on its private address only from its own LAN.
    if (h.nat) {
      const from = hosts.get(srcIp);
      if (!from || from.nat !== h.nat) { stats.filtered += 1; return; }
    }
    toSocket(h, dport, buf, srcIp, srcPort);
  }

  function toSocket(h, port, buf, srcIp, srcPort) {
    const s = h?.sockets.get(port);
    if (!s || s.closed) { stats.filtered += 1; return; }
    stats.delivered += 1;
    s.emit('message', buf, { address: srcIp, port: srcPort, family: 'IPv4', size: buf.length });
  }

  return {
    nat,
    host,
    stats,
    /** Change latency/loss/reorder while running. */
    set(patch) { Object.assign(opts, patch); },
  };
}

/**
 * A STUN answerer on a simulated public host, using the relay's own code, so
 * the punching tests see the same answers a real relay gives.
 */
export function simStun(net, ip, port, stunAnswer) {
  const h = net.host(ip);
  const s = h.createSocket('udp4');
  s.bind(port);
  s.on('message', (msg, rinfo) => {
    const out = stunAnswer(msg, rinfo);
    if (out) s.send(out, rinfo.port, rinfo.address);
  });
  return { host: h, socket: s, close: () => s.close() };
}
