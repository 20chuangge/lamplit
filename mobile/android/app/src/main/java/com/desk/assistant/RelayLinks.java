package com.desk.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Reaching a computer through the Lamplit relay without Tailscale (第 1 步原型).
 *
 * The computer keeps a tunnel open to a relay server; the relay forwards a TLS
 * connection by its server name (SNI) without decrypting it, and TLS ends on
 * the computer, whose certificate is its own (self-signed). So this phone must
 *   - send the computer's id as the server name, and
 *   - trust exactly that computer's certificate, by the fingerprint the pairing
 *     code carried - no public CA, no "accept any certificate".
 *
 * A WebView can do neither for an IP address. So the app does it itself: one
 * small forwarder per computer on 127.0.0.1:<port> inside the app. The WebView
 * and the background watcher talk plain HTTP to it; it opens the pinned TLS
 * connection through the relay and copies bytes both ways. The encryption runs
 * from this app to the computer; the relay in the middle sees ciphertext only.
 *
 * The address the app stores for that computer is http://127.0.0.1:<port>: the
 * port is fixed per computer (kept in the app's storage), so the page's origin
 * - and the login cookie with it - stays the same across app starts.
 */
public final class RelayLinks {

    private static final String TAG = "lamplit-relay";
    private static final String PREFS = "lamplit_relay";
    /** Ports for relay forwarders: 127.0.0.1 in this range means "through the relay" (launcher.js says the same). */
    static final int FIRST_PORT = 14440;
    static final int LAST_PORT = 14499;
    private static final String SNI_SUFFIX = ".relay.lamplit";

    private static final Map<Integer, ServerSocket> listening = new ConcurrentHashMap<>();

    /**
     * 直连 (1.5.46, DirectChannel.java): each computer this phone reaches
     * through the relay is also tried directly; when that works, new
     * connections take the direct channel, else the relay as before.
     */
    static final DirectChannel.Links DIRECT = new DirectChannel.Links(new DirectChannel.Options());
    private static volatile boolean watchingNetwork = false;

    private RelayLinks() {}

    /** 'direct-lan', 'direct' or 'relay' for the computer behind a forwarder URL (http://127.0.0.1:144xx); '' when it is not one. */
    static String routeFor(Context context, String url) {
        String id = idFor(context, url);
        return id.isEmpty() ? "" : DIRECT.route(id);
    }

    /** The debug line (1.5.48) for the computer behind a forwarder URL; '' when it is not one. */
    static String debugFor(Context context, String url) {
        String id = idFor(context, url);
        return id.isEmpty() ? "" : DIRECT.debug(id);
    }

    /** The computer id behind a forwarder URL; '' when it is not one. */
    static String idFor(Context context, String url) {
        if (!isRelayLocal(url)) return "";
        try {
            JSONObject row = rowFor(context, new java.net.URL(url).getPort());
            return row == null ? "" : row.optString("id", "");
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * The network changed (Wi-Fi to mobile data, another Wi-Fi): a direct path
     * is gone with it. Drop them now - new connections take the relay - and try
     * again on the next connection. Only real changes: a new network, a lost
     * one, new addresses; not the signal-strength updates.
     */
    private static void watchNetwork(Context context) {
        if (watchingNetwork || Build.VERSION.SDK_INT < 24) return;
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) context.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            cm.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
                private String network = "";
                private String addresses = "";

                private void drop(String why) {
                    Log.i(TAG, "network changed (" + why + "): direct links dropped, the relay carries on");
                    DIRECT.reset();
                }

                @Override
                public void onAvailable(android.net.Network n) {
                    String now = String.valueOf(n);
                    // The first call only tells which network is in use.
                    if (!network.isEmpty() && !network.equals(now)) drop("another network");
                    if (!network.equals(now)) addresses = "";
                    network = now;
                }

                @Override
                public void onLost(android.net.Network n) {
                    if (String.valueOf(n).equals(network)) {
                        network = "";
                        addresses = "";
                        drop("network lost");
                    }
                }

                @Override
                public void onLinkPropertiesChanged(android.net.Network n, android.net.LinkProperties lp) {
                    StringBuilder s = new StringBuilder();
                    for (android.net.LinkAddress a : lp.getLinkAddresses()) s.append(a.getAddress().getHostAddress()).append(',');
                    String now = s.toString();
                    if (!addresses.isEmpty() && !addresses.equals(now)) drop("new address");
                    addresses = now;
                }
            });
            watchingNetwork = true;
        } catch (Exception err) {
            Log.w(TAG, "cannot watch the network: " + err.getMessage());
        }
    }

    /**
     * Ask computer `id` to go direct: POST /api/direct/offer through this very
     * forwarder (so through the relay, inside the pinned TLS) with this phone's
     * device token for it. No token (a one-time visit): no direct.
     */
    private static void kickDirect(Context context, final int local, String host, int port, String id) {
        SharedPreferences store = context.getApplicationContext().getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        final String base = "http://127.0.0.1:" + local;
        // The app keeps the login under the machine's main address (1.5.48: on the
        // user's phone it was never found here, so the phone never went direct).
        String token = null;
        for (String owner : DirectChannel.tokenOwners(base, store.getString("desk.hubs", "[]"))) {
            String sealed = store.getString("desk.token:" + owner, null);
            if (sealed == null) sealed = store.getString("desk.token:" + owner + "/", null);
            String open = sealed == null ? null : TokenBox.open(sealed);
            if (open != null && !open.isEmpty()) { token = open; break; }
        }
        if (token == null) {
            DIRECT.note(id, "这台电脑在手机上没有登录，没法申请直连");
            return;
        }
        final String bearer = token;
        DIRECT.kick(id, host, port, body -> {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(base + "/api/direct/offer").openConnection();
            try {
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("Authorization", "Bearer " + bearer);
                c.getOutputStream().write(body.getBytes("UTF-8"));
                int status = c.getResponseCode();
                if (status != 200) throw new java.io.IOException("offer: HTTP " + status);
                java.io.ByteArrayOutputStream all = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                InputStream in = c.getInputStream();
                int n;
                while ((n = in.read(buf)) >= 0 && all.size() < 64 * 1024) all.write(buf, 0, n);
                return all.toString("UTF-8");
            } finally {
                c.disconnect();
            }
        });
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isRelayLocal(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            int port = u.getPort();
            return "127.0.0.1".equals(u.getHost()) && port >= FIRST_PORT && port <= LAST_PORT;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean validId(String id) {
        return id != null && id.matches("^[a-z0-9]{16,40}$");
    }

    private static boolean validFp(String fp) {
        return fp != null && fp.matches("^[0-9a-f]{64}$");
    }

    private static boolean validHost(String host) {
        return host != null && host.matches("^[A-Za-z0-9.:\\-\\[\\]]{1,253}$");
    }

    /**
     * The local address for computer `id` behind relay host:port, pinned to fp.
     * Made once (and remembered), started if it is not running. "" when the
     * input is not a relay address.
     */
    static synchronized String localUrl(Context context, String host, int port, String id, String fp) {
        if (!validHost(host) || port <= 0 || port > 65535 || !validId(id)) return "";
        String cleanFp = fp == null ? "" : fp.toLowerCase().replace(":", "");
        if (!validFp(cleanFp)) return "";
        // One forwarder per computer, kept by its id (第 2 步): the relay's port or
        // address may change (installed again, a new port) and the computer keeps
        // its local address - its row in the list and its login stay.
        String key = "id:" + id;
        SharedPreferences p = prefs(context);
        SharedPreferences.Editor cleanup = p.edit();
        int local = 0;
        try {
            String known = p.getString(key, null);
            if (known != null) local = new JSONObject(known).optInt("local", 0);
        } catch (Exception ignored) {
            local = 0;
        }
        // Rows from the prototype were kept by host:port/id: take their port over.
        for (Map.Entry<String, ?> e : p.getAll().entrySet()) {
            if (e.getKey().equals(key)) continue;
            try {
                JSONObject old = new JSONObject(String.valueOf(e.getValue()));
                if (!id.equals(old.optString("id", ""))) continue;
                if (local < FIRST_PORT || local > LAST_PORT) local = old.optInt("local", 0);
                cleanup.remove(e.getKey());
            } catch (Exception ignored) {
                // not ours
            }
        }
        cleanup.commit();
        if (local < FIRST_PORT || local > LAST_PORT) {
            java.util.Set<Integer> used = new java.util.HashSet<>();
            for (Map.Entry<String, ?> e : p.getAll().entrySet()) {
                try {
                    used.add(new JSONObject(String.valueOf(e.getValue())).optInt("local", 0));
                } catch (Exception ignored) {
                    // not ours
                }
            }
            for (int candidate = FIRST_PORT; candidate <= LAST_PORT; candidate += 1) {
                if (!used.contains(candidate)) {
                    local = candidate;
                    break;
                }
            }
            if (local == 0) return "";
        }
        try {
            JSONObject row = new JSONObject();
            row.put("host", host.toLowerCase());
            row.put("port", port);
            row.put("id", id);
            row.put("fp", cleanFp);
            row.put("local", local);
            p.edit().putString(key, row.toString()).apply();
        } catch (Exception ignored) {
            return "";
        }
        start(context, local);
        return "http://127.0.0.1:" + local;
    }

    /** Start every forwarder this phone knows (app start, watcher start). */
    static void startAll(Context context) {
        for (Map.Entry<String, ?> e : prefs(context).getAll().entrySet()) {
            try {
                int local = new JSONObject(String.valueOf(e.getValue())).optInt("local", 0);
                if (local >= FIRST_PORT && local <= LAST_PORT) start(context, local);
            } catch (Exception ignored) {
                // not ours
            }
        }
    }

    /** The relay row behind a local port (read fresh: the fingerprint may have been updated). */
    private static JSONObject rowFor(Context context, int local) {
        for (Map.Entry<String, ?> e : prefs(context).getAll().entrySet()) {
            try {
                JSONObject row = new JSONObject(String.valueOf(e.getValue()));
                if (row.optInt("local", 0) == local) return row;
            } catch (Exception ignored) {
                // not ours
            }
        }
        return null;
    }

    private static void start(Context context, int local) {
        ServerSocket existing = listening.get(local);
        if (existing != null && !existing.isClosed()) return;
        final Context app = context.getApplicationContext();
        Thread t = new Thread(() -> {
            ServerSocket server = null;
            try {
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), local), 32);
                listening.put(local, server);
                Log.i(TAG, "forwarder on 127.0.0.1:" + local);
                while (!server.isClosed()) {
                    Socket inner = server.accept();
                    Thread c = new Thread(() -> serve(app, local, inner), "relay-conn:" + local);
                    c.setDaemon(true);
                    c.start();
                }
            } catch (Exception err) {
                Log.w(TAG, "forwarder " + local + " stopped: " + err.getClass().getSimpleName() + " " + err.getMessage());
            } finally {
                listening.remove(local);
                if (server != null) {
                    try {
                        server.close();
                    } catch (Exception ignored) {
                        // closed
                    }
                }
            }
        }, "relay-listen:" + local);
        t.setDaemon(true);
        t.start();
    }

    /** One connection from the WebView or the watcher: pinned TLS through the relay, bytes both ways. */
    private static void serve(Context context, int local, Socket inner) {
        SSLSocket outer = null;
        try {
            JSONObject row = rowFor(context, local);
            if (row == null) throw new IllegalStateException("no relay for port " + local);
            String host = row.getString("host");
            int port = row.getInt("port");
            String id = row.getString("id");
            String fp = row.getString("fp");
            SSLContext ssl = SSLContext.getInstance("TLS");
            ssl.init(null, new TrustManager[] { new PinnedTrust(fp) }, null);
            // 直连 first (1.5.46): the same pinned TLS, over the direct channel.
            DirectChannel.Mux direct = DIRECT.muxFor(id);
            if (direct != null) {
                Socket plain = null;
                try {
                    plain = direct.openSocket();
                    outer = (SSLSocket) ssl.getSocketFactory().createSocket(plain, host, port, true);
                    setServerName(outer, id + SNI_SUFFIX);
                    outer.setSoTimeout(4000); // a stalled direct path: the relay takes this one
                    outer.startHandshake();
                } catch (Exception err) {
                    closeQuietly(outer);
                    closeQuietly(plain);
                    outer = null;
                    // Another certificate is never "try the relay instead": it is not the computer.
                    if (String.valueOf(err.getMessage()).contains("not the computer you paired with")) throw err;
                    // Stalled: the next connections take the relay at once, until a new try.
                    DIRECT.drop(id);
                }
            }
            if (outer == null) {
                outer = throughRelay(ssl, host, port, id);
                // Through the relay: try going direct for the next connections (it waits between tries).
                watchNetwork(context);
                kickDirect(context, local, host, port, id);
            }
            outer.setSoTimeout(0);
            inner.setTcpNoDelay(true);
            final Socket a = inner;
            final SSLSocket b = outer;
            final java.util.concurrent.atomic.AtomicInteger open = new java.util.concurrent.atomic.AtomicInteger(2);
            Thread up = new Thread(() -> pump(a, b, open), "relay-up:" + local);
            up.setDaemon(true);
            up.start();
            pump(b, a, open);
        } catch (Exception err) {
            Log.d(TAG, "relay connection failed: " + err.getClass().getSimpleName() + " " + err.getMessage());
            closeQuietly(inner);
            closeQuietly(outer);
        }
    }

    /** Waits before the 2nd and 3rd try when the relay closed the handshake (1.5.66). */
    static final long[] RELAY_RETRY_MS = { 1000L, 2500L };

    /**
     * Pinned TLS to computer `id` through the relay.
     *
     * The relay closes a connection at once when the computer has no tunnel to
     * it right now - restarting, updating, asleep (relay.mjs route(): "a
     * computer that registered here but is away"). The phone saw that as
     * "SSLHandshakeException: connection closed" (11-23, 6 s after the PC's
     * Lamplit restarted, before its tunnel was back). The computer reconnects
     * by itself within seconds, so a closed handshake is tried again after a
     * short wait; the watcher's own backoff covers longer gaps. A certificate
     * that is not the paired computer's, or a relay that cannot be reached at
     * all, is not tried again here.
     */
    private static SSLSocket throughRelay(SSLContext ssl, String host, int port, String id) throws Exception {
        for (int attempt = 0; ; attempt += 1) {
            Socket plain = new Socket();
            SSLSocket outer = null;
            try {
                plain.connect(new InetSocketAddress(host, port), 10000);
            } catch (Exception err) {
                closeQuietly(plain);
                throw err; // the relay itself is out of reach: no quick retry helps
            }
            try {
                plain.setTcpNoDelay(true);
                outer = (SSLSocket) ssl.getSocketFactory().createSocket(plain, host, port, true);
                setServerName(outer, id + SNI_SUFFIX);
                outer.setSoTimeout(15000); // a handshake that stalls is not left hanging
                outer.startHandshake();
                outer.setSoTimeout(0);
                return outer;
            } catch (Exception err) {
                closeQuietly(outer);
                closeQuietly(plain);
                for (Throwable t = err; t != null; t = t.getCause()) {
                    if (String.valueOf(t.getMessage()).contains("not the computer you paired with")) throw err;
                }
                if (attempt >= RELAY_RETRY_MS.length) throw err;
                Log.i(TAG, "the relay has no link from that computer right now (" + err.getClass().getSimpleName() + "); trying again");
                Thread.sleep(RELAY_RETRY_MS[attempt]);
            }
        }
    }

    /** SNI = the computer's id. The relay routes by it; nothing else is readable to it. */
    private static void setServerName(SSLSocket socket, String name) {
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                javax.net.ssl.SSLParameters params = socket.getSSLParameters();
                java.util.List<javax.net.ssl.SNIServerName> names = new java.util.ArrayList<>();
                names.add(new javax.net.ssl.SNIHostName(name));
                params.setServerNames(names);
                socket.setSSLParameters(params);
            } catch (Exception ignored) {
                // fall back to Conscrypt's own setter below
            }
        }
        try {
            socket.getClass().getMethod("setHostname", String.class).invoke(socket, name);
        } catch (Exception ignored) {
            // not Conscrypt: SSLParameters above did it
        }
    }

    /**
     * One direction. The end of one direction is passed on as a half close
     * (a client that sends its request and then closes its sending side still
     * gets the answer); both sockets close when both directions are done, or
     * at once on an error.
     */
    private static void pump(Socket from, Socket to, java.util.concurrent.atomic.AtomicInteger open) {
        byte[] buffer = new byte[32 * 1024];
        boolean clean = false;
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buffer)) >= 0) {
                out.write(buffer, 0, n);
                out.flush();
            }
            clean = true;
            try {
                if (!(to instanceof SSLSocket)) to.shutdownOutput();
            } catch (Exception ignored) {
                // already closed
            }
        } catch (Exception ignored) {
            // one side is gone
        } finally {
            if (!clean || open.decrementAndGet() <= 0) {
                closeQuietly(from);
                closeQuietly(to);
            }
        }
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Exception ignored) {
            // closed
        }
    }

    /** Trusts one certificate: the computer's, by its SHA-256 fingerprint. */
    static final class PinnedTrust implements X509TrustManager {
        private final String fp;

        PinnedTrust(String fp) {
            this.fp = fp;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
            String got;
            try {
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                StringBuilder hex = new StringBuilder();
                for (byte b : digest) hex.append(String.format("%02x", b));
                got = hex.toString();
            } catch (Exception e) {
                throw new CertificateException("cannot read the certificate");
            }
            if (!MessageDigest.isEqual(got.getBytes(), fp.getBytes())) {
                throw new CertificateException("this is not the computer you paired with");
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** For the launcher: every relay row as {local, host, port, id, route: 'direct'|'relay'}. */
    static String describe(Context context) {
        org.json.JSONArray out = new org.json.JSONArray();
        for (Iterator<? extends Map.Entry<String, ?>> it = prefs(context).getAll().entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, ?> e = it.next();
            try {
                JSONObject row = new JSONObject(String.valueOf(e.getValue()));
                JSONObject shown = new JSONObject();
                shown.put("local", row.optInt("local"));
                shown.put("host", row.optString("host"));
                shown.put("port", row.optInt("port"));
                shown.put("id", row.optString("id"));
                shown.put("route", DIRECT.route(row.optString("id")));
                out.put(shown);
            } catch (Exception ignored) {
                // not ours
            }
        }
        return out.toString();
    }
}
