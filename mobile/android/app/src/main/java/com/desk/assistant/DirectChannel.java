package com.desk.assistant;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 直连 (1.5.46): this phone talks to a paired computer over UDP directly when
 * it can, instead of through the relay. The same protocol as src/direct.mjs,
 * byte for byte; scripts/direct-interop.mjs compiles this file with a desktop
 * JDK and runs it against the Node side, so keep it free of Android classes.
 *
 * How (the phone is always the side that dials):
 *   1. Ask the relay's STUN which outside address this UDP socket has.
 *   2. POST /api/direct/offer to the computer THROUGH THE RELAY, inside the TLS
 *      pinned to its certificate, with this phone's device token: our
 *      addresses and half a key. The relay sees ciphertext only; without a
 *      paired device's token the computer does not answer.
 *   3. Both sides send encrypted probes to each other's addresses; the first
 *      probe answered picks the path. Nothing within a few seconds: stay on
 *      the relay, try again later (1, 5, 15 min; at once after a network change).
 *   4. Each connection the WebView makes then becomes a stream in the channel,
 *      carrying the SAME pinned TLS as through the relay (RelayLinks.serve).
 *
 * Datagram: 0xD1 | session id (8) | counter (8) | AES-256-GCM(type | body) | tag (16).
 * Inside: reliable ordered delivery (ACK + SACK, retransmission, AIMD) of
 * [length (4)][Mux frame], the relay tunnel's multiplexer (hub/relay/relay.mjs).
 */
final class DirectChannel {

    private DirectChannel() {}

    static final int MAGIC = 0xD1;
    static final int HEADER = 17;
    static final int TAG = 16;
    static final int MAX_PACKET = 1232;
    static final int MSS = MAX_PACKET - HEADER - TAG - 1 - 4;
    static final int PROBE = 0x01, PROBE_ACK = 0x02, SELECT = 0x03, DATA = 0x10, ACK = 0x11, PING = 0x20, PONG = 0x21, CLOSE = 0x30;
    static final int RECV_WINDOW = 2048;
    static final int MAX_CANDIDATES = 8;
    /** The multiplexer's frames and window (hub/relay/relay.mjs). */
    static final int M_OPEN = 1, M_DATA = 2, M_END = 3, M_RST = 4, M_WIN = 5;
    static final int M_WINDOW = 256 * 1024, M_CHUNK = 32 * 1024, M_CREDIT_STEP = 32 * 1024;
    static final long[] RETRY_MS = { 60000L, 5 * 60000L, 15 * 60000L };

    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Timings; the defaults are what the app uses. */
    static final class Options {
        long punchMs = 8000;
        long probeEveryMs = 200;
        long pingMs = 10000;
        long deadMs = 25000;
        boolean allowLoopback = false;
        boolean hostCandidates = true;
        /** Tests only: drop this share of outgoing datagrams. */
        double dropRate = 0;
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    static byte[] random(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    private static void putInt(byte[] b, int at, long v) {
        b[at] = (byte) (v >>> 24); b[at + 1] = (byte) (v >>> 16); b[at + 2] = (byte) (v >>> 8); b[at + 3] = (byte) v;
    }

    private static long getInt(byte[] b, int at) {
        return ((b[at] & 0xffL) << 24) | ((b[at + 1] & 0xffL) << 16) | ((b[at + 2] & 0xffL) << 8) | (b[at + 3] & 0xffL);
    }

    private static void putLong(byte[] b, int at, long v) {
        for (int i = 7; i >= 0; i--) { b[at + i] = (byte) v; v >>>= 8; }
    }

    private static long getLong(byte[] b, int at) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (b[at + i] & 0xffL);
        return v;
    }

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    /** base64url without padding (java.util.Base64 needs API 26). */
    static String b64url(byte[] in) {
        StringBuilder s = new StringBuilder();
        int i = 0;
        for (; i + 2 < in.length; i += 3) {
            int v = ((in[i] & 0xff) << 16) | ((in[i + 1] & 0xff) << 8) | (in[i + 2] & 0xff);
            s.append(B64[v >>> 18]).append(B64[(v >>> 12) & 63]).append(B64[(v >>> 6) & 63]).append(B64[v & 63]);
        }
        if (in.length - i == 1) {
            int v = (in[i] & 0xff) << 16;
            s.append(B64[v >>> 18]).append(B64[(v >>> 12) & 63]);
        } else if (in.length - i == 2) {
            int v = ((in[i] & 0xff) << 16) | ((in[i + 1] & 0xff) << 8);
            s.append(B64[v >>> 18]).append(B64[(v >>> 12) & 63]).append(B64[(v >>> 6) & 63]);
        }
        return s.toString();
    }

    static byte[] unb64url(String text) {
        String t = text == null ? "" : text.replace('+', '-').replace('/', '_').replace("=", "");
        int[] map = new int[128];
        Arrays.fill(map, -1);
        for (int i = 0; i < 64; i++) map[B64[i]] = i;
        byte[] out = new byte[t.length() * 3 / 4];
        int bits = 0, n = 0, o = 0;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c >= 128 || map[c] < 0) return null;
            bits = (bits << 6) | map[c];
            n += 6;
            if (n >= 8) { n -= 8; out[o++] = (byte) (bits >>> n); }
        }
        return o == out.length ? out : Arrays.copyOf(out, o);
    }

    // ------------------------------------------------------------------
    // Keys and sealing
    // ------------------------------------------------------------------

    /** HKDF-SHA256(clientHalf | serverHalf, salt = sid) -> {client->computer key, computer->client key}. */
    static byte[][] deriveKeys(byte[] clientHalf, byte[] serverHalf, byte[] sid) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(sid, "HmacSHA256"));
        byte[] ikm = new byte[clientHalf.length + serverHalf.length];
        System.arraycopy(clientHalf, 0, ikm, 0, clientHalf.length);
        System.arraycopy(serverHalf, 0, ikm, clientHalf.length, serverHalf.length);
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] info = "lamplit-direct v1".getBytes(UTF8);
        byte[] okm = new byte[64];
        byte[] t = new byte[0];
        int pos = 0;
        for (int i = 1; pos < 64; i++) {
            mac.update(t);
            mac.update(info);
            mac.update((byte) i);
            t = mac.doFinal();
            int n = Math.min(t.length, 64 - pos);
            System.arraycopy(t, 0, okm, pos, n);
            pos += n;
        }
        return new byte[][] { Arrays.copyOfRange(okm, 0, 32), Arrays.copyOfRange(okm, 32, 64) };
    }

    private static byte[] nonce(long counter) {
        byte[] iv = new byte[12];
        putLong(iv, 4, counter);
        return iv;
    }

    static byte[] seal(byte[] key, byte[] sid, long counter, byte[] plain) throws GeneralSecurityException {
        byte[] out = new byte[HEADER + plain.length + TAG];
        out[0] = (byte) MAGIC;
        System.arraycopy(sid, 0, out, 1, 8);
        putLong(out, 9, counter);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce(counter)));
        c.updateAAD(out, 0, HEADER);
        c.doFinal(plain, 0, plain.length, out, HEADER);
        return out;
    }

    /** -> plain (with the counter in counterOut[0]), or null: not ours, changed, wrong key. */
    static byte[] open(byte[] key, byte[] packet, int len, long[] counterOut) {
        if (len < HEADER + TAG + 1 || (packet[0] & 0xff) != MAGIC) return null;
        long counter = getLong(packet, 9);
        if (counter < 0) return null;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce(counter)));
            c.updateAAD(packet, 0, HEADER);
            byte[] plain = c.doFinal(packet, HEADER, len - HEADER);
            counterOut[0] = counter;
            return plain;
        } catch (GeneralSecurityException e) {
            return null;
        }
    }

    /** Counters seen recently: each taken once; older than the window, never. */
    static final class Replay {
        final int size = 1024;
        long max = -1;
        final boolean[] seen = new boolean[size];

        boolean accept(long n) {
            if (n > max) {
                if (n - max >= size) Arrays.fill(seen, false);
                else for (long i = max + 1; i <= n; i++) seen[(int) (i % size)] = false;
                max = n;
                seen[(int) (n % size)] = true;
                return true;
            }
            if (max - n >= size || seen[(int) (n % size)]) return false;
            seen[(int) (n % size)] = true;
            return true;
        }
    }

    // ------------------------------------------------------------------
    // STUN (the relay answers padded Binding Requests, hub/relay/relay.mjs)
    // ------------------------------------------------------------------

    private static final int STUN_MAGIC = 0x2112a442;

    static byte[] stunRequest(byte[] txid) {
        byte[] b = new byte[44];
        b[1] = 0x01; // Binding Request
        b[3] = 24;
        putInt(b, 4, STUN_MAGIC);
        System.arraycopy(txid, 0, b, 8, 12);
        b[20] = 0x00; b[21] = 0x26; // PADDING
        b[23] = 20;
        return b;
    }

    static InetSocketAddress parseStun(byte[] b, int len, byte[] txid) {
        if (len < 20 || (b[0] & 0xc0) != 0 || getInt(b, 4) != (STUN_MAGIC & 0xffffffffL)) return null;
        if (b[0] != 0x01 || b[1] != 0x01) return null;
        for (int i = 0; i < 12; i++) if (b[8 + i] != txid[i]) return null;
        int p = 20;
        while (p + 4 <= len) {
            int type = ((b[p] & 0xff) << 8) | (b[p + 1] & 0xff);
            int l = ((b[p + 2] & 0xff) << 8) | (b[p + 3] & 0xff);
            if (p + 4 + l > len) return null;
            if (type == 0x0020 && l >= 8) {
                int port = ((((b[p + 6] & 0xff) << 8) | (b[p + 7] & 0xff)) ^ (STUN_MAGIC >>> 16)) & 0xffff;
                int n = b[p + 5] == 0x02 ? 16 : 4;
                if (l < 4 + n) return null;
                byte[] key = new byte[16];
                putInt(key, 0, STUN_MAGIC);
                System.arraycopy(b, 8, key, 4, 12);
                byte[] raw = new byte[n];
                for (int i = 0; i < n; i++) raw[i] = (byte) (b[p + 8 + i] ^ key[i]);
                try {
                    return new InetSocketAddress(InetAddress.getByAddress(raw), port);
                } catch (IOException e) {
                    return null;
                }
            }
            p += 4 + l + ((4 - (l % 4)) % 4);
        }
        return null;
    }

    /** This socket's outside address, as the relay sees it; null after three tries. Before the session starts. */
    static InetSocketAddress stun(DatagramSocket socket, String host, int port) {
        try {
            InetAddress relay = InetAddress.getByName(host);
            byte[] txid = random(12);
            byte[] req = stunRequest(txid);
            byte[] buf = new byte[256];
            int old = socket.getSoTimeout();
            try {
                for (int i = 0; i < 3; i++) {
                    socket.send(new DatagramPacket(req, req.length, relay, port));
                    socket.setSoTimeout(500);
                    long until = System.currentTimeMillis() + 500;
                    while (System.currentTimeMillis() < until) {
                        DatagramPacket in = new DatagramPacket(buf, buf.length);
                        try {
                            socket.receive(in);
                        } catch (java.net.SocketTimeoutException e) {
                            break;
                        }
                        InetSocketAddress got = parseStun(in.getData(), in.getLength(), txid);
                        if (got != null) return got;
                    }
                }
            } finally {
                socket.setSoTimeout(old);
            }
        } catch (IOException ignored) {
            // no STUN: host candidates only
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Candidates
    // ------------------------------------------------------------------

    private static boolean usable(InetAddress a, boolean allowLoopback) {
        if (a == null || a.isAnyLocalAddress() || a.isMulticastAddress() || a.isLinkLocalAddress()) return false;
        if (a.isLoopbackAddress()) return allowLoopback;
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int x = b[0] & 0xff, y = b[1] & 0xff;
            if (x == 0 || x >= 224) return false;
            if (x == 255) return false;
        }
        return true;
    }

    /** This phone's own addresses worth offering: not Tailscale's, not a carrier's 100.64/10, not a TUN proxy's. */
    static List<InetAddress> localAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements()) {
                NetworkInterface nif = all.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (!usable(a, false)) continue;
                    byte[] b = a.getAddress();
                    if (a instanceof Inet4Address) {
                        int x = b[0] & 0xff, y = b[1] & 0xff;
                        if (x == 100 && y >= 64 && y <= 127) continue;
                        if (x == 198 && (y == 18 || y == 19)) continue;
                    } else if (a instanceof Inet6Address) {
                        int x = b[0] & 0xff;
                        // global (2000::/3) or a home ULA (fc00::/7)
                        if (!((x & 0xe0) == 0x20 || (x & 0xfe) == 0xfc)) continue;
                    }
                    if (out.size() < 6) out.add(a);
                }
            }
        } catch (Exception ignored) {
            // none
        }
        return out;
    }

    private static String addrText(InetAddress a) {
        String s = a.getHostAddress();
        int pct = s.indexOf('%');
        return (pct >= 0 ? s.substring(0, pct) : s).toLowerCase();
    }

    private static final Pattern REPLY_HALF = Pattern.compile("\"half\"\\s*:\\s*\"([A-Za-z0-9_-]+)\"");
    private static final Pattern REPLY_SID = Pattern.compile("\"sid\"\\s*:\\s*\"([0-9a-f]{16})\"");
    private static final Pattern CAND_OBJ = Pattern.compile("\\{[^{}]*\\}");
    private static final Pattern CAND_A = Pattern.compile("\"a\"\\s*:\\s*\"([0-9A-Fa-f.:]{2,45})\"");
    private static final Pattern CAND_P = Pattern.compile("\"p\"\\s*:\\s*(\\d{1,5})");

    /** The computer's candidates from its reply: real addresses only, at most 8. */
    static List<InetSocketAddress> parseCandidates(String reply, boolean allowLoopback) {
        List<InetSocketAddress> out = new ArrayList<>();
        int at = reply.indexOf("\"cands\"");
        if (at < 0) return out;
        Matcher m = CAND_OBJ.matcher(reply.substring(at));
        while (m.find() && out.size() < MAX_CANDIDATES) {
            Matcher a = CAND_A.matcher(m.group());
            Matcher p = CAND_P.matcher(m.group());
            if (!a.find() || !p.find()) continue;
            int port = Integer.parseInt(p.group(1));
            if (port < 1 || port > 65535) continue;
            try {
                // Literal addresses only: never a DNS lookup on what the other side wrote.
                String text = a.group(1);
                if (!text.matches("^[0-9.]+$") && !text.contains(":")) continue;
                InetAddress addr = InetAddress.getByName(text);
                if (!usable(addr, allowLoopback)) continue;
                InetSocketAddress c = new InetSocketAddress(addr, port);
                if (!out.contains(c)) out.add(c);
            } catch (Exception ignored) {
                // not an address
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // One session (the phone's side): punching, then reliable delivery
    // ------------------------------------------------------------------

    interface Listener {
        void onMessage(byte[] message);

        void onClose(String why);
    }

    static final class Entry {
        final byte[] data;
        long sentAt;
        int tries;

        Entry(byte[] data, long sentAt) {
            this.data = data;
            this.sentAt = sentAt;
        }
    }

    static final class Session {
        final DatagramSocket socket;
        final byte[] sid;
        final byte[] sendKey;
        final byte[] recvKey;
        final Options o;
        final List<InetSocketAddress> cands;
        Listener listener;
        volatile InetSocketAddress remote;
        volatile String state = "punching";
        volatile String reason = "";
        long counter = 0;
        final Replay window = new Replay();
        boolean heard = false;
        int probesSent = 0;
        long lastHeard, lastSent, startedAt, nextProbe, upAt;
        final byte[] nonce = random(8);
        final CountDownLatch settled = new CountDownLatch(1);
        // sending
        final ArrayDeque<byte[]> queue = new ArrayDeque<>();
        int headOff = 0;
        long queued = 0;
        long nextSeq = 0;
        final TreeMap<Long, Entry> inflight = new TreeMap<>();
        long inflightBytes = 0;
        double cwnd = 16, ssthresh = 512;
        int peerWindow = 256;
        long recoverUntil = 0;
        double srtt = 0, rttvar = 0, rto = 1000;
        // receiving
        long expected = 0;
        final HashMap<Long, byte[]> rbuf = new HashMap<>();
        int ackOwed = 0;
        long ackAt = 0;
        byte[] in = new byte[64 * 1024];
        int inLen = 0;
        long bytesIn = 0, bytesOut = 0;
        private Thread receiver, ticker;

        Session(DatagramSocket socket, byte[] sid, byte[] sendKey, byte[] recvKey, List<InetSocketAddress> cands, Options o) {
            this.socket = socket;
            this.sid = sid;
            this.sendKey = sendKey;
            this.recvKey = recvKey;
            this.cands = new ArrayList<>(cands);
            this.o = o;
            long now = System.currentTimeMillis();
            lastHeard = now;
            lastSent = now;
            startedAt = now;
        }

        void start() {
            receiver = new Thread(this::receiveLoop, "direct-recv");
            receiver.setDaemon(true);
            receiver.start();
            ticker = new Thread(() -> {
                while (!"closed".equals(state)) {
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException e) {
                        return;
                    }
                    tick();
                }
            }, "direct-tick");
            ticker.setDaemon(true);
            ticker.start();
            synchronized (this) {
                probe();
            }
        }

        boolean awaitUp(long ms) throws InterruptedException {
            settled.await(ms, TimeUnit.MILLISECONDS);
            return "up".equals(state);
        }

        private void receiveLoop() {
            byte[] buf = new byte[2048];
            while (!"closed".equals(state)) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(p);
                } catch (java.net.SocketTimeoutException e) {
                    continue;
                } catch (IOException e) {
                    close("socket closed");
                    return;
                }
                if (p.getLength() < HEADER + TAG + 1 || (buf[0] & 0xff) != MAGIC) continue;
                boolean mine = true;
                for (int i = 0; i < 8; i++) if (buf[1 + i] != sid[i]) mine = false;
                if (!mine) continue;
                receive(buf, p.getLength(), new InetSocketAddress(p.getAddress(), p.getPort()));
            }
        }

        private synchronized void raw(int type, byte[] body, int bodyLen, InetSocketAddress to) {
            if (to == null || "closed".equals(state)) return;
            byte[] plain = new byte[1 + bodyLen];
            plain[0] = (byte) type;
            System.arraycopy(body, 0, plain, 1, bodyLen);
            try {
                byte[] packet = seal(sendKey, sid, counter++, plain);
                lastSent = System.currentTimeMillis();
                if (o.dropRate > 0 && RANDOM.nextDouble() < o.dropRate) return;
                socket.send(new DatagramPacket(packet, packet.length, to));
            } catch (Exception ignored) {
                // a send that fails is a lost packet
            }
        }

        private void raw(int type, byte[] body) {
            raw(type, body, body.length, remote);
        }

        private byte[] probeBody() {
            byte[] b = new byte[9];
            System.arraycopy(nonce, 0, b, 0, 8);
            b[8] = 1; // from the dialing side
            return b;
        }

        private synchronized void probe() {
            if (!"punching".equals(state)) return;
            byte[] body = probeBody();
            for (InetSocketAddress c : cands) { raw(PROBE, body, body.length, c); probesSent++; }
            nextProbe = System.currentTimeMillis() + o.probeEveryMs;
        }

        private synchronized void receive(byte[] packet, int len, InetSocketAddress from) {
            if ("closed".equals(state)) return;
            long[] counterOut = new long[1];
            byte[] plain = open(recvKey, packet, len, counterOut);
            if (plain == null || plain.length < 1) return;
            boolean newest = counterOut[0] > window.max;
            if (!window.accept(counterOut[0])) return;
            heard = true;
            lastHeard = System.currentTimeMillis();
            int type = plain[0] & 0xff;
            int bodyLen = plain.length - 1;
            byte[] body = Arrays.copyOfRange(plain, 1, plain.length);
            if (type == PROBE) {
                if (bodyLen >= 8) raw(PROBE_ACK, body, 8, from);
                // From an address the computer never listed: probe back there too.
                if ("punching".equals(state) && cands.size() < MAX_CANDIDATES + 4 && !cands.contains(from)) {
                    cands.add(from);
                    byte[] pb = probeBody();
                    raw(PROBE, pb, pb.length, from);
                }
                return;
            }
            if (type == PROBE_ACK) {
                if ("punching".equals(state) && bodyLen >= 8 && Arrays.equals(Arrays.copyOf(body, 8), nonce)) {
                    remote = from;
                    state = "up";
                    upAt = System.currentTimeMillis();
                    for (int i = 0; i < 3; i++) raw(SELECT, new byte[0]);
                    settled.countDown();
                    pump();
                }
                return;
            }
            if (type == CLOSE) {
                closeLocked("closed by the other side");
                return;
            }
            if (!"up".equals(state)) return;
            if (newest && !from.equals(remote)) remote = from;
            if (type == PING) {
                raw(PONG, Arrays.copyOf(body, Math.min(4, bodyLen)));
                return;
            }
            if (type == DATA && bodyLen >= 4) {
                data(getInt(body, 0), Arrays.copyOfRange(body, 4, bodyLen));
                return;
            }
            if (type == ACK && bodyLen >= 7) ack(body, bodyLen);
        }

        // --- sending -------------------------------------------------------

        /** One message (a Mux frame) into the ordered byte stream. */
        synchronized boolean send(byte[] message) {
            if ("closed".equals(state)) return false;
            byte[] head = new byte[4];
            putInt(head, 0, message.length);
            queue.add(head);
            queue.add(message);
            queued += 4 + message.length;
            pump();
            return true;
        }

        synchronized boolean needDrain() {
            return queued + inflightBytes > 1024 * 1024;
        }

        private byte[] take(int n) {
            byte[] out = new byte[(int) Math.min(n, queued)];
            int o = 0;
            while (o < out.length) {
                byte[] head = queue.peek();
                int left = head.length - headOff;
                int k = Math.min(left, out.length - o);
                System.arraycopy(head, headOff, out, o, k);
                o += k;
                headOff += k;
                if (headOff == head.length) {
                    queue.poll();
                    headOff = 0;
                }
            }
            queued -= out.length;
            return out;
        }

        private void pump() {
            if (!"up".equals(state)) return;
            while (queued > 0 && inflight.size() < Math.min((int) Math.floor(cwnd), peerWindow)) {
                byte[] d = take(MSS);
                long seq = nextSeq++;
                inflight.put(seq, new Entry(d, System.currentTimeMillis()));
                inflightBytes += d.length;
                sendData(seq, d);
            }
        }

        private void sendData(long seq, byte[] d) {
            byte[] body = new byte[4 + d.length];
            putInt(body, 0, seq);
            System.arraycopy(d, 0, body, 4, d.length);
            raw(DATA, body);
            bytesOut += d.length;
        }

        private void acked(long seq, Entry e, long now) {
            inflight.remove(seq);
            inflightBytes -= e.data.length;
            if (cwnd < ssthresh) cwnd += 1; else cwnd += 1 / cwnd;
            if (cwnd > 4096) cwnd = 4096;
            if (e.tries == 0) {
                double r = now - e.sentAt;
                if (srtt == 0) { srtt = r; rttvar = r / 2; } else {
                    rttvar = 0.75 * rttvar + 0.25 * Math.abs(srtt - r);
                    srtt = 0.875 * srtt + 0.125 * r;
                }
                rto = Math.min(4000, Math.max(200, srtt + 4 * rttvar));
            }
        }

        private void ack(byte[] b, int len) {
            long now = System.currentTimeMillis();
            long next = getInt(b, 0);
            peerWindow = Math.max(1, ((b[4] & 0xff) << 8) | (b[5] & 0xff));
            int n = Math.min(b[6] & 0xff, (len - 7) / 8);
            long highest = -1;
            long highestSent = 0;
            while (!inflight.isEmpty() && inflight.firstKey() < next) {
                Map.Entry<Long, Entry> f = inflight.firstEntry();
                if (f.getKey() > highest) { highest = f.getKey(); highestSent = f.getValue().sentAt; }
                acked(f.getKey(), f.getValue(), now);
            }
            for (int i = 0; i < n; i++) {
                long from = getInt(b, 7 + i * 8);
                long to = getInt(b, 11 + i * 8);
                for (long s = from; s < to && s - from < RECV_WINDOW; s++) {
                    Entry e = inflight.get(s);
                    if (e == null) continue;
                    if (s > highest) { highest = s; highestSent = e.sentAt; }
                    acked(s, e, now);
                }
            }
            if (highest >= 0) {
                for (Map.Entry<Long, Entry> f : inflight.entrySet()) {
                    long seq = f.getKey();
                    if (seq + 3 > highest) break;
                    Entry e = f.getValue();
                    if (e.sentAt >= highestSent) continue;
                    lost(seq);
                    e.sentAt = now;
                    e.tries += 1;
                    sendData(seq, e.data);
                }
            }
            pump();
            notifyAll(); // writers waiting for room
        }

        private void lost(long seq) {
            if (seq < recoverUntil) return;
            ssthresh = Math.max(cwnd / 2, 4);
            cwnd = ssthresh;
            recoverUntil = nextSeq;
        }

        // --- receiving -----------------------------------------------------

        private void data(long seq, byte[] d) {
            if (seq < expected || rbuf.containsKey(seq)) {
                sendAck();
                return;
            }
            if (seq >= expected + RECV_WINDOW) return;
            rbuf.put(seq, d);
            boolean inOrder = seq == expected;
            while (rbuf.containsKey(expected)) {
                byte[] x = rbuf.remove(expected);
                expected += 1;
                deliver(x);
                if ("closed".equals(state)) return;
            }
            ackOwed += 1;
            if (!inOrder || ackOwed >= 2) sendAck();
            else if (ackAt == 0) ackAt = System.currentTimeMillis() + 10;
        }

        private void sendAck() {
            ackOwed = 0;
            ackAt = 0;
            List<long[]> ranges = new ArrayList<>();
            if (!rbuf.isEmpty()) {
                Long[] keys = rbuf.keySet().toArray(new Long[0]);
                Arrays.sort(keys);
                long from = keys[0], prev = keys[0];
                for (int i = 1; i <= keys.length && ranges.size() < 16; i++) {
                    if (i < keys.length && keys[i] == prev + 1) { prev = keys[i]; continue; }
                    ranges.add(new long[] { from, prev + 1 });
                    if (i < keys.length) { from = keys[i]; prev = keys[i]; }
                }
            }
            byte[] body = new byte[7 + ranges.size() * 8];
            putInt(body, 0, expected);
            int w = Math.max(1, Math.min(0xffff, RECV_WINDOW - rbuf.size()));
            body[4] = (byte) (w >>> 8);
            body[5] = (byte) w;
            body[6] = (byte) ranges.size();
            for (int i = 0; i < ranges.size(); i++) {
                putInt(body, 7 + i * 8, ranges.get(i)[0]);
                putInt(body, 11 + i * 8, ranges.get(i)[1]);
            }
            raw(ACK, body);
        }

        private void deliver(byte[] d) {
            bytesIn += d.length;
            if (inLen + d.length > in.length) in = Arrays.copyOf(in, Math.max(in.length * 2, inLen + d.length));
            System.arraycopy(d, 0, in, inLen, d.length);
            inLen += d.length;
            int at = 0;
            while (inLen - at >= 4) {
                long len = getInt(in, at);
                if (len > 2 * 1024 * 1024) { closeLocked("message too large"); return; }
                if (inLen - at < 4 + len) break;
                byte[] msg = Arrays.copyOfRange(in, at + 4, at + 4 + (int) len);
                at += 4 + (int) len;
                if (listener != null) listener.onMessage(msg);
                if ("closed".equals(state)) return;
            }
            if (at > 0) {
                System.arraycopy(in, at, in, 0, inLen - at);
                inLen -= at;
            }
        }

        // --- the clock -----------------------------------------------------

        private synchronized void tick() {
            long now = System.currentTimeMillis();
            if ("punching".equals(state)) {
                if (now - startedAt > o.punchMs) {
                    // Per side, what was seen (1.5.49): did any probe of the computer arrive here?
                    reason = heard ? "punch: probes arrived but ours were not answered" : "punch: no probe arrived (sent " + probesSent + " to " + cands.size() + " addresses) - NAT or firewall";
                    closeLocked(reason);
                    return;
                }
                if (now >= nextProbe) probe();
                return;
            }
            if (!"up".equals(state)) return;
            if (now - lastHeard > o.deadMs) { closeLocked("timeout: nothing heard"); return; }
            if (ackAt != 0 && now >= ackAt) sendAck();
            int n = 0;
            for (Iterator<Map.Entry<Long, Entry>> it = inflight.entrySet().iterator(); it.hasNext() && n < 32; ) {
                Map.Entry<Long, Entry> f = it.next();
                Entry e = f.getValue();
                if (now - e.sentAt < rto * Math.pow(2, Math.min(e.tries, 4))) continue;
                if (e.tries >= 12) { closeLocked("timeout: no acknowledgement"); return; }
                if (f.getKey() >= recoverUntil) { ssthresh = Math.max(cwnd / 2, 4); cwnd = 4; recoverUntil = nextSeq; }
                e.sentAt = now;
                e.tries += 1;
                n += 1;
                sendData(f.getKey(), e.data);
            }
            if (now - lastSent > o.pingMs || (now - lastHeard > o.pingMs && now - lastSent > 1000)) {
                byte[] t = new byte[4];
                putInt(t, 0, now - startedAt);
                raw(PING, t);
            }
        }

        void close(String why) {
            synchronized (this) {
                closeLocked(why);
            }
        }

        private void closeLocked(String why) {
            if ("closed".equals(state)) return;
            if (remote != null) { raw(CLOSE, new byte[0]); raw(CLOSE, new byte[0]); }
            state = "closed";
            if (reason.isEmpty()) reason = why;
            inflight.clear();
            queue.clear();
            notifyAll();
            settled.countDown();
            socket.close();
            final Listener l = listener;
            final String r = reason;
            if (l != null) {
                Thread t = new Thread(() -> l.onClose(r), "direct-closed");
                t.setDaemon(true);
                t.start();
            }
        }
    }

    // ------------------------------------------------------------------
    // The multiplexer, the phone's side: it opens streams, never accepts one
    // ------------------------------------------------------------------

    static final class Mux implements Listener {
        final Session session;
        final Map<Integer, MStream> streams = new ConcurrentHashMap<>();
        private int nextId = 1;
        volatile boolean closed = false;
        volatile Runnable onClosed;

        Mux(Session session) {
            this.session = session;
            session.listener = this;
        }

        static byte[] frame(int type, int id, byte[] body, int off, int len) {
            byte[] f = new byte[5 + len];
            f[0] = (byte) type;
            putInt(f, 1, id & 0xffffffffL);
            System.arraycopy(body, off, f, 5, len);
            return f;
        }

        synchronized MStream open() {
            int id = nextId;
            nextId = nextId % 0x0ffffff0 + 1;
            MStream s = new MStream(this, id);
            streams.put(id, s);
            byte[] meta = "{}".getBytes(UTF8);
            session.send(frame(M_OPEN, id, meta, 0, meta.length));
            return s;
        }

        @Override
        public void onMessage(byte[] m) {
            if (m.length < 5) return;
            int type = m[0] & 0xff;
            int id = (int) getInt(m, 1);
            if (type == M_OPEN) {
                // The computer cannot open a connection into the phone.
                session.send(frame(M_RST, id, new byte[0], 0, 0));
                return;
            }
            MStream s = streams.get(id);
            if (s == null) return;
            if (type == M_DATA) s.incoming(Arrays.copyOfRange(m, 5, m.length));
            else if (type == M_END) s.remoteEnded();
            else if (type == M_RST) s.reset();
            else if (type == M_WIN && m.length >= 9) s.credit(getInt(m, 5));
        }

        @Override
        public void onClose(String why) {
            closed = true;
            for (MStream s : streams.values()) s.reset();
            streams.clear();
            Runnable r = onClosed;
            if (r != null) r.run();
        }

        /**
         * A plain socket whose bytes travel in a new stream: what RelayLinks
         * wraps in pinned TLS, exactly as it wraps its socket to the relay.
         * A loopback pair, so it works with every Android TLS (6.0 included).
         */
        Socket openSocket() throws IOException {
            if (closed) throw new IOException("direct channel closed");
            InetAddress lo = InetAddress.getByName("127.0.0.1");
            ServerSocket server = new ServerSocket(0, 1, lo);
            Socket a;
            Socket b;
            try {
                a = new Socket(lo, server.getLocalPort());
                server.setSoTimeout(3000);
                b = server.accept();
            } finally {
                server.close();
            }
            a.setTcpNoDelay(true);
            b.setTcpNoDelay(true);
            final MStream s = open();
            final Socket inner = b;
            Thread up = new Thread(() -> {
                byte[] buf = new byte[M_CHUNK];
                try {
                    InputStream in = inner.getInputStream();
                    int n;
                    while ((n = in.read(buf)) >= 0) s.write(buf, 0, n);
                    s.end();
                } catch (IOException e) {
                    s.destroy();
                    closeQuietly(inner);
                }
            }, "direct-up");
            up.setDaemon(true);
            up.start();
            Thread down = new Thread(() -> {
                try {
                    OutputStream out = inner.getOutputStream();
                    byte[] d;
                    while ((d = s.take()) != null) {
                        out.write(d);
                        out.flush();
                        s.consumed(d.length);
                    }
                    inner.shutdownOutput();
                } catch (Exception e) {
                    s.destroy();
                    closeQuietly(inner);
                }
            }, "direct-down");
            down.setDaemon(true);
            down.start();
            return a;
        }
    }

    static void closeQuietly(Socket s) {
        try {
            if (s != null) s.close();
        } catch (IOException ignored) {
            // closed
        }
    }

    static final class MStream {
        final Mux mux;
        final int id;
        private long credit = M_WINDOW;
        private long owed = 0;
        private final ArrayDeque<byte[]> in = new ArrayDeque<>();
        private boolean ended = false;
        private boolean gone = false;
        private boolean endSent = false;

        MStream(Mux mux, int id) {
            this.mux = mux;
            this.id = id;
        }

        synchronized void incoming(byte[] d) {
            in.add(d);
            notifyAll();
        }

        synchronized void remoteEnded() {
            ended = true;
            notifyAll();
        }

        synchronized void reset() {
            gone = true;
            mux.streams.remove(id);
            notifyAll();
        }

        synchronized void credit(long n) {
            credit += n;
            notifyAll();
        }

        /** The next bytes from the computer; null at its end. */
        synchronized byte[] take() throws IOException, InterruptedException {
            while (in.isEmpty() && !ended && !gone) wait();
            if (!in.isEmpty()) return in.poll();
            if (gone) throw new IOException("stream reset");
            return null;
        }

        /** Give credit back once bytes left for the TLS socket (flow control, as in relay.mjs). */
        void consumed(int n) {
            long give = 0;
            synchronized (this) {
                owed += n;
                if (owed >= M_CREDIT_STEP && !gone) { give = owed; owed = 0; }
            }
            if (give > 0) {
                byte[] b = new byte[4];
                putInt(b, 0, give);
                mux.session.send(Mux.frame(M_WIN, id, b, 0, 4));
            }
        }

        void write(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                int n;
                synchronized (this) {
                    try {
                        while (credit <= 0 && !gone) wait(200);
                    } catch (InterruptedException e) {
                        throw new IOException("interrupted");
                    }
                    if (gone || mux.closed) throw new IOException("stream closed");
                    n = (int) Math.min(Math.min(len, credit), M_CHUNK);
                    credit -= n;
                }
                // The channel is full: wait for room (a slow path holds back the writer, not the app).
                synchronized (mux.session) {
                    try {
                        while (mux.session.needDrain() && !"closed".equals(mux.session.state)) mux.session.wait(100);
                    } catch (InterruptedException e) {
                        throw new IOException("interrupted");
                    }
                }
                if (!mux.session.send(Mux.frame(M_DATA, id, b, off, n))) throw new IOException("channel closed");
                off += n;
                len -= n;
            }
        }

        void end() {
            synchronized (this) {
                if (endSent || gone) return;
                endSent = true;
            }
            mux.session.send(Mux.frame(M_END, id, new byte[0], 0, 0));
        }

        void destroy() {
            boolean send;
            synchronized (this) {
                send = !gone;
                gone = true;
                mux.streams.remove(id);
                notifyAll();
            }
            if (send) mux.session.send(Mux.frame(M_RST, id, new byte[0], 0, 0));
        }
    }

    // ------------------------------------------------------------------
    // Dialing, and the direct links this phone holds (one per computer)
    // ------------------------------------------------------------------

    /** Sends the offer to the computer through the relay (with this phone's token); returns its reply. */
    interface Offerer {
        String offer(String body) throws Exception;
    }

    /** STUN, offer, punch. -> a Mux over a channel that is up; throws with the reason otherwise. */
    static Mux dial(String relayHost, int relayPort, Offerer offerer, Options o) throws Exception {
        DatagramSocket socket = new DatagramSocket();
        try {
            InetSocketAddress outside = stun(socket, relayHost, relayPort);
            StringBuilder cands = new StringBuilder();
            int n = 0;
            if (o.hostCandidates) {
                for (InetAddress a : localAddresses()) {
                    cands.append(n++ > 0 ? "," : "").append("{\"a\":\"").append(addrText(a)).append("\",\"p\":").append(socket.getLocalPort()).append(",\"k\":\"host\"}");
                }
            }
            if (outside != null) {
                cands.append(n++ > 0 ? "," : "").append("{\"a\":\"").append(addrText(outside.getAddress())).append("\",\"p\":").append(outside.getPort()).append(",\"k\":\"srflx\"}");
            }
            byte[] sid = random(8);
            byte[] half = random(32);
            String body = "{\"v\":1,\"sid\":\"" + hex(sid) + "\",\"half\":\"" + b64url(half) + "\",\"cands\":[" + cands + "]}";
            String reply = offerer.offer(body);
            Matcher h = REPLY_HALF.matcher(reply);
            Matcher s = REPLY_SID.matcher(reply);
            byte[] theirs = h.find() ? unb64url(h.group(1)) : null;
            if (theirs == null || theirs.length != 32 || !s.find() || !s.group(1).equals(hex(sid))) throw new IOException("offer: the computer did not take it");
            byte[][] keys = deriveKeys(half, theirs, sid);
            Session session = new Session(socket, sid, keys[0], keys[1], parseCandidates(reply, o.allowLoopback), o);
            Mux mux = new Mux(session);
            session.start();
            if (!session.awaitUp(o.punchMs + 1000)) {
                session.close("punch: no answer");
                throw new IOException(session.reason.isEmpty() ? "punch failed" : session.reason);
            }
            return mux;
        } catch (Exception e) {
            socket.close();
            throw e;
        }
    }

    static final class Link {
        volatile Mux mux;
        volatile boolean pending;
        long nextTry = 0;
        int failures = 0;
        volatile String reason = "";
        volatile long lastTryAt = 0;
    }

    private static final Pattern HUB_ROW = Pattern.compile("\\{[^{}]*\\}");
    private static final Pattern HUB_URL = Pattern.compile("\"(https?://[^\"\\\\]{1,300})\"");

    /**
     * Where the app keeps the login for the computer behind forwarder `base`
     * (1.5.48): the app stores a machine's token under the row's main address
     * (desk.hubs rows {url, alt:[…]}), usually its LAN address, and the
     * forwarder's 127.0.0.1:144xx is one of its alternates. -> the row's
     * addresses, main first, to try in order; just `base` when no row has it.
     */
    static List<String> tokenOwners(String base, String hubsJson) {
        List<String> out = new ArrayList<>();
        Matcher row = HUB_ROW.matcher(hubsJson == null ? "" : hubsJson);
        while (row.find()) {
            String text = row.group();
            if (!text.contains("\"" + base + "\"") && !text.contains("\"" + base + "/\"")) continue;
            // The main address ("url") first, then the others in order; never the via (another machine).
            Matcher main = Pattern.compile("\"url\"\\s*:\\s*\"(https?://[^\"\\\\]{1,300})\"").matcher(text);
            if (main.find()) out.add(main.group(1));
            int alt = text.indexOf("\"alt\"");
            if (alt >= 0) {
                int end = text.indexOf(']', alt);
                Matcher u = HUB_URL.matcher(text.substring(alt, end < 0 ? text.length() : end));
                while (u.find()) if (!out.contains(u.group(1))) out.add(u.group(1));
            }
            break;
        }
        if (!out.contains(base)) out.add(base);
        return out;
    }

    /** A private, link-local or loopback address: the home network, said as 局域网. */
    static boolean isLocalNetwork(InetAddress a) {
        if (a == null) return false;
        if (a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isLoopbackAddress()) return true;
        byte[] b = a.getAddress();
        return b.length == 16 && (b[0] & 0xfe) == 0xfc; // IPv6 ULA fc00::/7
    }

    /** A punch failure in words for 关于 (1.5.49); anything else as it is, without addresses. */
    static String reasonWords(String reason) {
        String r = String.valueOf(reason == null ? "" : reason);
        if (r.startsWith("punch: no probe arrived")) return "对方的探测包一个也没到（多半是电脑那边的防火墙或代理挡住了 UDP）";
        if (r.startsWith("punch: probes arrived")) return "收到了电脑的探测包，但手机发的没有回音（多半是这边的网络限制）";
        return noAddresses(r);
    }

    /** No addresses in what the app shows (a reason may carry one from an exception). */
    static String noAddresses(String text) {
        return String.valueOf(text == null ? "" : text)
            .replaceAll("\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b", "…")
            .replaceAll("\\[?[0-9A-Fa-f]{0,4}(:[0-9A-Fa-f]{0,4}){2,7}\\]?(:\\d+)?", "…");
    }

    /** The direct links of this phone, one per computer id; retry waits, network changes. */
    static final class Links {
        final Map<String, Link> links = new ConcurrentHashMap<>();
        final Options options;

        Links(Options options) {
            this.options = options;
        }

        Link link(String id) {
            Link l = links.get(id);
            if (l == null) {
                l = new Link();
                Link had = links.putIfAbsent(id, l);
                if (had != null) l = had;
            }
            return l;
        }

        /** The channel to computer `id` when it is up, else null (use the relay). */
        Mux muxFor(String id) {
            Link l = links.get(id);
            Mux m = l == null ? null : l.mux;
            return m != null && !m.closed ? m : null;
        }

        /** 'direct-lan' (straight, inside the home network), 'direct', or 'relay'. */
        String route(String id) {
            Mux m = muxFor(id);
            if (m == null) return "relay";
            InetSocketAddress r = m.session.remote;
            return r != null && isLocalNetwork(r.getAddress()) ? "direct-lan" : "direct";
        }

        /** Record why there is no direct try (e.g. no login for that computer), for the debug line. */
        void note(String id, String reason) {
            link(id).reason = reason;
        }

        /**
         * One line for the app's 关于 (1.5.48: no logcat in a release build):
         * the road, its state, the last reason, the next try. Never an address.
         */
        String debug(String id) {
            Link l = links.get(id);
            String route = route(id);
            long now = System.currentTimeMillis();
            StringBuilder s = new StringBuilder();
            if (route.startsWith("direct")) s.append("直连").append("direct-lan".equals(route) ? "（局域网）" : "（经公网）");
            else s.append("中转");
            if (l == null || (l.lastTryAt == 0 && l.reason.isEmpty())) return s.append(" · 还没试过直连").toString();
            if (l.pending) s.append(" · 正在试直连");
            if (!route.startsWith("direct")) {
                if (!l.reason.isEmpty()) s.append(" · 上次：").append(reasonWords(l.reason));
                if (l.lastTryAt > 0) s.append("（").append(Math.max(0, (now - l.lastTryAt) / 60000)).append(" 分钟前）");
                if (l.nextTry > now) s.append(" · ").append(Math.max(1, (l.nextTry - now) / 1000)).append(" 秒后再试");
            }
            return s.toString();
        }

        /** Try in the background unless up, trying, or waiting to retry. */
        void kick(final String id, final String relayHost, final int relayPort, final Offerer offerer) {
            final Link l = link(id);
            synchronized (l) {
                if (l.pending || muxFor(id) != null || System.currentTimeMillis() < l.nextTry) return;
                l.pending = true;
                l.lastTryAt = System.currentTimeMillis();
            }
            Thread t = new Thread(() -> {
                try {
                    final Mux m = dial(relayHost, relayPort, offerer, options);
                    final long upAt = System.currentTimeMillis();
                    m.onClosed = () -> {
                        synchronized (l) {
                            if (l.mux != m) return;
                            l.mux = null;
                            l.reason = m.session.reason;
                            l.failures = 0;
                            // It worked and died (walked out of Wi-Fi): try again soon.
                            l.nextTry = System.currentTimeMillis() + (System.currentTimeMillis() - upAt > 10000 ? 5000 : 10000);
                        }
                    };
                    synchronized (l) {
                        l.mux = m;
                        l.reason = "";
                    }
                    if (m.closed) m.onClosed.run();
                } catch (Exception e) {
                    synchronized (l) {
                        String msg = String.valueOf(e.getMessage());
                        l.reason = msg;
                        if (msg.contains("409")) l.failures = RETRY_MS.length - 1; // off on that computer
                        l.failures += 1;
                        l.nextTry = System.currentTimeMillis() + RETRY_MS[Math.min(l.failures - 1, RETRY_MS.length - 1)];
                    }
                } finally {
                    l.pending = false;
                }
            }, "direct-dial");
            t.setDaemon(true);
            t.start();
        }

        /** A connection over it stalled (the computer restarted, the path died quietly): drop it now. */
        void drop(String id) {
            Link l = links.get(id);
            Mux m = l == null ? null : l.mux;
            if (m != null) m.session.close("stalled");
        }

        /** The network changed (Wi-Fi to mobile data): drop direct links, forget the waits. */
        void reset() {
            for (Link l : links.values()) {
                Mux m;
                synchronized (l) {
                    l.failures = 0;
                    l.nextTry = 0;
                    m = l.mux;
                    l.mux = null;
                }
                if (m != null) m.session.close("network changed");
            }
        }
    }
}
