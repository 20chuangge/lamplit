package com.desk.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Nightshift's background watcher.
 *
 * Why a foreground service: the phone must tell the user when a turn finished or
 * when the assistant is waiting for an approval, even with the screen off. A
 * WebView that is not visible gets frozen, so the SSE connection has to live in
 * a service instead - the app's own subscription, independent of any screen.
 *
 * What it does: reads the hub address + device token the app stored (Capacitor
 * Preferences -> SharedPreferences "CapacitorStorage"), keeps an SSE connection to
 * /api/stream open, and turns two event kinds into a notification:
 *   - approval.request  "要你确认一下" (something is blocked on the human)
 *   - turn.end          "这一轮结束了" (only for turns the human did not sit and
 *                       watch - the app being in the background is our proxy)
 *
 * The connection is retried with a backoff; a dropped Wi-Fi or a sleeping
 * machine is normal, not an error worth a notification.
 */
public class NightshiftWatcher extends Service {

    private static final String TAG = "nightshift-watch";
    private static final String CHANNEL_SERVICE = "nightshift-service";
    private static final String CHANNEL_EVENTS = "nightshift-events";
    private static final int ID_SERVICE = 4101;
    private static int eventSeq = 4110;

    private volatile boolean running = false;
    private Thread worker;
    /** Every open stream, so onDestroy can drop them all. */
    private final java.util.Set<HttpURLConnection> connections =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());

    /** Set by MainActivity: the user is looking at the app right now. */
    static volatile boolean appVisible = false;

    /** Capacitor Preferences stores everything in one SharedPreferences file. */
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
    }

    /**
     * The hubs this phone holds a token for, most recently used first.
     *
     * desk.hubUrl is the last machine the user *looked at*, which may be one the
     * phone has no token for (reached through a one-time link) - so the token is
     * what decides, not the last URL.
     */
    private static java.util.List<String> hubsWithToken(SharedPreferences p) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        String last = p.getString("desk.hubUrl", null);
        if (last != null) {
            last = last.replaceAll("/+$", "");
            if (p.getString("desk.token:" + last, null) != null) out.add(last);
        }
        for (Map.Entry<String, ?> entry : p.getAll().entrySet()) {
            String key = entry.getKey();
            if (key.startsWith("desk.token:") && entry.getValue() instanceof String) {
                out.add(key.substring("desk.token:".length()));
            }
        }
        return new java.util.ArrayList<>(out);
    }

    static boolean hasPairing(Context context) {
        return !hubsWithToken(prefs(context)).isEmpty();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(ID_SERVICE, serviceNotification(this));
        if (!running) {
            running = true;
            worker = new Thread(this::supervise, "nightshift-supervisor");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWake();
        for (HttpURLConnection conn : connections) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // already gone
            }
        }
        connections.clear();
        super.onDestroy();
    }

    // ------------------------------------------------------------- supervisors
    /*
     * One thread per hub the phone holds a token for: a notification must arrive
     * whichever machine ran the turn, and each machine has its own event stream.
     * A supervisor re-reads the tokens every 30 s so a machine paired later (or
     * one whose token was removed) is picked up without restarting the app.
     */
    private final Map<String, Thread> workers = new java.util.concurrent.ConcurrentHashMap<>();

    private void supervise() {
        long lastSync = 0;
        while (running) {
            // One per machine (1.5.67): a login for an address the machine no longer has,
            // found to be another login's machine, is only another address of that one.
            java.util.List<String> hubs = activeHubs();
            // The relay forwarders live in this process: up again after Android restarted it.
            RelayLinks.startAll(this);
            // 「让机器人用这部手机」 turned off by an update or a cleaner: back on (1.5.20).
            AgentKeeper.ensure(this);
            keepAwakeForBots();
            for (String hub : hubs) ensureWorker(hub);
            // Tell every machine whether the bots may use this phone (1.4.0) -
            // each from its own thread (1.5.17): one machine that is off took
            // 10-25 s to time out and held every other machine's report back,
            // so a live machine heard from the phone too late and dropped it.
            for (String hub : hubs) ensureReporter(hub);
            // Every five minutes, ask a hub we know for the machines it knows and
            // pair this phone with any that answer. That is what makes a machine
            // added later (or one that boots later) notify without anyone
            // touching the app - the phone just needs one live hub to learn from.
            if (!hubs.isEmpty() && System.currentTimeMillis() - lastSync > 300000L) {
                lastSync = System.currentTimeMillis();
                for (String hub : hubs) {
                    if (!running) break;
                    final String h = hub;
                    new Thread(() -> syncFleet(h), "fleet:" + hub).start();
                }
            }
            sleep(30000);
        }
        releaseWake();
    }

    private final Map<String, Thread> reporters = new java.util.concurrent.ConcurrentHashMap<>();
    /** Machines that did not answer the last report: they are asked less often. */
    private final Map<String, Integer> misses = new java.util.concurrent.ConcurrentHashMap<>();

    /** One report thread per machine: every 30 s, less often (up to 5 min) to one that does not answer. */
    private void ensureReporter(String hub) {
        Thread alive = reporters.get(hub);
        if (alive != null && alive.isAlive()) return;
        Thread t = new Thread(() -> {
            try {
                while (running && activeHubs().contains(hub)) {
                    boolean ok = reportPhoneAgent(hub);
                    int miss = ok ? 0 : Math.min(misses.getOrDefault(hub, 0) + 1, 10);
                    misses.put(hub, miss);
                    sleep(miss == 0 ? 30000L : Math.min(300000L, 30000L * miss));
                }
            } finally {
                reporters.remove(hub);
            }
        }, "report:" + hub);
        t.setDaemon(true);
        reporters.put(hub, t);
        t.start();
    }

    private android.os.PowerManager.WakeLock wake;

    /**
     * While 「让机器人用这部手机」 is on, keep the CPU awake (screen may be off)
     * so the reports and the event stream go on; let go as soon as it is off.
     */
    private synchronized void keepAwakeForBots() {
        boolean want = PhoneAgentService.instance != null;
        try {
            if (want && (wake == null || !wake.isHeld())) {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "lamplit:phone-agent");
                wake.setReferenceCounted(false);
                wake.acquire();
            } else if (!want) {
                releaseWake();
            }
        } catch (Exception err) {
            Log.d(TAG, "wake lock: " + err.getClass().getSimpleName());
        }
    }

    private synchronized void releaseWake() {
        try {
            if (wake != null && wake.isHeld()) wake.release();
        } catch (Exception ignored) {
            // already released
        }
        wake = null;
    }

    /**
     * One machine's peer list, turned into device tokens.
     *
     * The hub that knows a machine can hand out a one-time door for it; spending
     * that door on `client:"app"` pairing is exactly what the watcher needs.
     * Nothing is copied between machines: each pairing is its own credential.
     */
    private void syncFleet(String hub) {
        String token = TokenBox.open(prefs(this).getString("desk.token:" + hub, null));
        if (token == null) return;
        try {
            // Through the way that works now (1.5.66): the paired address may be dead.
            String base = via(hub);
            JSONObject list = new JSONObject(get(base + "/api/machines", token));
            org.json.JSONArray machines = list.optJSONArray("machines");
            if (machines == null) return;
            java.util.List<JSONObject> rows = new java.util.ArrayList<>();
            java.util.List<PhoneRoutes.Machine> fleet = new java.util.ArrayList<>();
            for (int i = 0; i < machines.length(); i += 1) {
                JSONObject machine = machines.optJSONObject(i);
                if (machine == null) continue;
                rows.add(machine);
                fleet.add(machineOf(machine));
            }
            // Every machine this phone already holds a login for, by what it knows of it.
            java.util.List<PhoneRoutes.Known> paired = new java.util.ArrayList<>();
            for (String other : activeHubs()) if (!other.equals(hub)) paired.add(knownOf(other));
            // A login of ours that does not answer may be this very machine's (1.5.67).
            findSameMachine(hub, base, token);
            for (int i = 0; i < rows.size(); i += 1) {
                JSONObject machine = rows.get(i);
                PhoneRoutes.Machine m = fleet.get(i);
                // The machine that answered is `hub`, whatever address it was reached by:
                // its own list of its addresses is the fresh one (1.5.66).
                if (machine.optBoolean("self")) {
                    learn(hub, m);
                    continue;
                }
                String name = m.name;
                if (name.isEmpty()) continue;
                // Already paired with it, maybe at an address it no longer has (1.5.66: the
                // cloud's old Tailscale address): refresh its addresses, no second login.
                String same = PhoneRoutes.match(m, paired, fleet);
                if (same != null) {
                    learn(same, m);
                    continue;
                }
                // A machine has up to three ways (tailnet, its own address, the relay);
                // only the ones this phone can use now are tried, the relay last.
                java.util.List<String> targets = new java.util.ArrayList<>();
                for (String target : m.addresses) {
                    if (RelayLinks.isRelayLocal(target) || NetHints.mayReach(target)) targets.add(target);
                }
                for (String target : targets) {
                    if (prefs(this).getString("desk.token:" + target, null) != null) break;
                    String door = handoff(base, token, name);
                    if (door.isEmpty()) break; // the machine is off or has no address
                    String code = pairCode(door);
                    if (code.isEmpty()) break;
                    String fresh = pair(target, code);
                    if (!fresh.isEmpty()) {
                        prefs(this).edit().putString("desk.token:" + target, fresh).apply();
                        learn(target, m);
                        Log.i(TAG, "paired with " + name + " at " + target);
                        break;
                    }
                    Log.i(TAG, "pairing with " + name + " at " + target + " did not work");
                }
            }
        } catch (Exception err) {
            forgetRoute(hub);
            Log.d(TAG, "fleet sync from " + hub + " failed: " + err.getClass().getSimpleName());
        }
    }

    /** A string field; "" for a missing or null one (Android's optString turns null into "null"). */
    private static String str(JSONObject o, String key) {
        if (o == null || o.isNull(key)) return "";
        return o.optString(key, "").trim();
    }

    /** One /api/machines row: its name, relay id and addresses (tailnet, own, this phone's relay forwarder). */
    private PhoneRoutes.Machine machineOf(JSONObject machine) {
        java.util.List<String> addrs = new java.util.ArrayList<>();
        addrs.add(str(machine, "tailnetUrl"));
        addrs.add(str(machine, "url"));
        String relayId = "";
        JSONObject relay = machine.optJSONObject("relay");
        if (relay != null) {
            relayId = str(relay, "id");
            // Made, or updated in place (a new relay host, port or certificate) - kept by the machine's id.
            String local = RelayLinks.localUrl(this, str(relay, "host"), relay.optInt("port", 0), relayId, str(relay, "fp"));
            addrs.add(local);
        }
        return new PhoneRoutes.Machine(str(machine, "name"), relayId, addrs);
    }

    // ------------------------------------------------------------ what a machine is (1.5.66)
    /*
     * The phone's login for a machine is kept under the address it paired at
     * (desk.token:<address>); the machine may have other addresses since. What
     * the watcher learned of each paired machine from fleet sync is kept here,
     * apart from the app's own list (desk.hubs, which the page writes):
     *   "hub:<address>" -> {name, relayId, addrs:[...], at, refused}
     * refused: its login was turned away at an address learned by name - that
     * was not the same machine; its learned addresses are not used.
     */
    private static final String LEARNED = "lamplit_machines";

    private JSONObject learned(String hub) {
        try {
            String raw = getSharedPreferences(LEARNED, Context.MODE_PRIVATE).getString("hub:" + hub, null);
            return raw == null ? null : new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** The hub `hub`'s login was found to belong to (its machine's working entry), or null. */
    private String sameAs(String hub) {
        String to = str(learned(hub), "sameAs");
        return to.isEmpty() || to.equals(hub) ? null : to;
    }

    /**
     * The hubs the watcher keeps a stream, a report and fleet sync for: one per
     * machine. A hub whose login belongs to another hub's machine (sameAs) is
     * left out while that one still has its login and is not itself folded.
     */
    private java.util.List<String> activeHubs() {
        java.util.List<String> all = hubsWithToken(prefs(this));
        java.util.Map<String, String> folded = new java.util.HashMap<>();
        for (String h : all) {
            String to = sameAs(h);
            if (to != null) folded.put(h, to);
        }
        return PhoneRoutes.active(all, folded);
    }

    private static String sha256Hex(String text) throws Exception {
        byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : d) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /**
     * Seen 11-24: after 1.5.66 the phone held two logins for the cloud machine -
     * one at its old Tailscale address (dead: Tailscale off, and the machine has
     * another address now) and one through the relay (working). Nothing in the
     * machine lists ties the old address to the machine, so the watcher kept
     * timing out on it every minute. Now, from a hub that answers, the phone asks
     * (POST /api/phone/mine) which of its logins for hubs that do not answer are
     * that machine's - by their SHA-256, which the machine keeps instead of the
     * login, so no login leaves the phone. Those become another address of the
     * working hub. A machine before 1.5.67 does not know the question: nothing changes.
     */
    private void findSameMachine(String hub, String base, String token) {
        try {
            java.util.List<String> candidates = new java.util.ArrayList<>();
            org.json.JSONArray hashes = new org.json.JSONArray();
            for (String other : activeHubs()) {
                if (other.equals(hub) || misses.getOrDefault(other, 0) < 2) continue;
                String theirs = TokenBox.open(prefs(this).getString("desk.token:" + other, null));
                if (theirs == null || theirs.isEmpty() || theirs.equals(token)) continue;
                candidates.add(other);
                hashes.put(sha256Hex(theirs));
                if (candidates.size() >= 20) break;
            }
            if (candidates.isEmpty()) return;
            JSONObject body = new JSONObject();
            body.put("hashes", hashes);
            org.json.JSONArray mine = postJson(base + "/api/phone/mine", token, body).optJSONArray("mine");
            if (mine == null) return;
            for (int i = 0; i < candidates.size() && i < mine.length(); i += 1) {
                if (!mine.optBoolean(i, false)) continue;
                String dead = candidates.get(i);
                JSONObject row = learned(dead);
                if (row == null) row = new JSONObject();
                row.put("sameAs", hub);
                row.put("at", System.currentTimeMillis());
                getSharedPreferences(LEARNED, Context.MODE_PRIVATE).edit().putString("hub:" + dead, row.toString()).apply();
                forgetRoute(hub);
                forgetRoute(dead);
                Log.i(TAG, dead + " is the same machine as " + hub + " (its login is that machine's): watched through " + hub + " only, " + dead + " kept as another address");
            }
        } catch (Exception err) {
            Log.d(TAG, "could not ask " + hub + " about the other logins: " + err.getClass().getSimpleName());
        }
    }

    /** Learned addresses of `hub` still in use (none once refused). */
    private java.util.List<String> learnedAddresses(String hub) {
        java.util.List<String> out = new java.util.ArrayList<>();
        JSONObject row = learned(hub);
        if (row == null || row.optBoolean("refused")) return out;
        org.json.JSONArray addrs = row.optJSONArray("addrs");
        if (addrs != null) for (int i = 0; i < addrs.length(); i += 1) {
            String a = addrs.optString(i, "").replaceAll("/+$", "");
            if (!a.isEmpty() && !a.equals(hub) && !out.contains(a)) out.add(a);
        }
        return out;
    }

    /** `hub` is machine `m`: keep its fresh addresses (the old ones it no longer lists go). */
    private void learn(String hub, PhoneRoutes.Machine m) {
        try {
            JSONObject old = learned(hub);
            org.json.JSONArray addrs = new org.json.JSONArray();
            for (String a : m.addresses) if (!a.equals(hub)) addrs.put(a);
            JSONObject row = new JSONObject();
            row.put("name", m.name);
            row.put("relayId", m.relayId);
            row.put("addrs", addrs);
            row.put("at", System.currentTimeMillis());
            row.put("refused", false);
            if (old != null && !str(old, "sameAs").isEmpty()) row.put("sameAs", str(old, "sameAs"));
            boolean changed = old == null || old.optBoolean("refused")
                    || !String.valueOf(old.optJSONArray("addrs")).equals(addrs.toString())
                    || !m.relayId.equals(str(old, "relayId"));
            getSharedPreferences(LEARNED, Context.MODE_PRIVATE).edit().putString("hub:" + hub, row.toString()).apply();
            if (changed) {
                forgetRoute(hub);
                Log.i(TAG, "machine " + m.name + " (paired at " + hub + "): addresses refreshed"
                        + (m.relayId.isEmpty() ? "" : ", its relay known"));
            }
        } catch (Exception err) {
            Log.d(TAG, "could not keep what " + hub + " is: " + err.getClass().getSimpleName());
        }
    }

    /** Its login was turned away at a learned address: that address was another machine's. */
    private void refuseLearned(String hub) {
        try {
            JSONObject row = learned(hub);
            if (row == null) return;
            row.put("refused", true);
            getSharedPreferences(LEARNED, Context.MODE_PRIVATE).edit().putString("hub:" + hub, row.toString()).apply();
        } catch (Exception ignored) {
            // nothing kept: nothing to undo
        }
    }

    /** The names the app's list gives the machine at `hub` (its row, or a row that has it as another address). */
    private java.util.List<String> rowNames(String hub) {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            org.json.JSONArray rows = new org.json.JSONArray(prefs(this).getString("desk.hubs", "[]"));
            for (int i = 0; i < rows.length(); i += 1) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                boolean mine = hub.equals(str(row, "url").replaceAll("/+$", ""));
                org.json.JSONArray alt = row.optJSONArray("alt");
                if (!mine && alt != null) for (int j = 0; j < alt.length(); j += 1) {
                    if (hub.equals(alt.optString(j, "").replaceAll("/+$", ""))) mine = true;
                }
                if (mine && !str(row, "name").isEmpty()) out.add(str(row, "name"));
            }
        } catch (Exception ignored) {
            // no list yet
        }
        return out;
    }

    /** Everything this phone knows of the machine it paired with at `hub`. */
    private PhoneRoutes.Known knownOf(String hub) {
        PhoneRoutes.Known k = new PhoneRoutes.Known(hub);
        for (String a : addressesOf(hub)) {
            k.address(a);
            String id = RelayLinks.idFor(this, a);
            if (!id.isEmpty()) k.relayId(id);
        }
        String own = RelayLinks.idFor(this, hub);
        if (!own.isEmpty()) k.relayId(own);
        for (String n : rowNames(hub)) k.name(n);
        JSONObject row = learned(hub);
        if (row != null) {
            if (row.optBoolean("refused")) k.refusedByName = true;
            else {
                k.name(str(row, "name"));
                k.relayId(str(row, "relayId"));
            }
        }
        return k;
    }

    /** POST /api/machines/<name>/handoff -> one-time URL (or "" when it cannot). */
    private String handoff(String hub, String token, String name) {
        try {
            return postJson(hub + "/api/machines/" + java.net.URLEncoder.encode(name, "UTF-8") + "/handoff", token, null)
                    .optString("url", "");
        } catch (Exception err) {
            return "";
        }
    }

    /** Pair from a one-time link token; returns the device token or "". */
    private String pair(String hub, String code) {
        try {
            JSONObject body = new JSONObject();
            body.put("code", code);
            body.put("client", "app");
            JSONObject made = postJson(hub + "/api/pair", null, body);
            return made.optString("token", "");
        } catch (Exception err) {
            return "";
        }
    }

    private String pairCode(String door) {
        try {
            java.net.URI uri = java.net.URI.create(door);
            String query = uri.getQuery();
            if (query == null) return "";
            for (String part : query.split("&")) {
                if (part.startsWith("pair=")) return java.net.URLDecoder.decode(part.substring(5), "UTF-8");
            }
        } catch (Exception ignored) {
            // not a URL we understand
        }
        return "";
    }

    private String get(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            if (conn.getResponseCode() != 200) throw new IllegalStateException("HTTP " + conn.getResponseCode());
            java.io.InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject postJson(String url, String token, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(20000);
            if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            byte[] payload = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            java.io.OutputStream out = conn.getOutputStream();
            out.write(payload);
            out.close();
            int status = conn.getResponseCode();
            java.io.InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            java.io.ByteArrayOutputStream sink = new java.io.ByteArrayOutputStream();
            if (in != null) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) sink.write(buffer, 0, read);
            }
            String text = new String(sink.toByteArray(), StandardCharsets.UTF_8);
            if (status >= 400) throw new IllegalStateException("HTTP " + status);
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    // ------------------------------------------------------------ the shortest way (1.5.29)
    /**
     * A machine is known by the address the phone paired with (often its
     * Tailscale one) and, in the app's list, by its other addresses. On the
     * same Wi-Fi its LAN address is the short way: no VPN, no relay abroad when
     * Tailscale cannot connect directly. The token works at either address.
     * Checked at most once a minute per machine; a failure forgets the choice.
     */
    private final Map<String, String[]> routes = new java.util.concurrent.ConcurrentHashMap<>();

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Exception e) {
            return "";
        }
    }

    static boolean isLanAddress(String url) {
        String host;
        try {
            host = new URL(url).getHost();
        } catch (Exception e) {
            return false;
        }
        return host.matches("^(10\\.\\d+|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+$");
    }

    /** The other addresses known for this machine: the app's list, then what fleet sync learned. */
    private java.util.List<String> addressesOf(String hub) {
        java.util.List<String> out = appAddresses(hub);
        // What fleet sync learned of the same machine (1.5.66): its addresses now, its relay.
        for (String u : learnedAddresses(hub)) if (!out.contains(u)) out.add(u);
        // Its other logins' addresses (1.5.67): tried only when this phone can use them (Tailscale on).
        for (String other : hubsWithToken(prefs(this))) {
            if (!other.equals(hub) && hub.equals(sameAs(other)) && !out.contains(other)) out.add(other);
        }
        return out;
    }

    /** The other addresses the app knows for this machine (desk.hubs rows: {url, alt:[...]}). */
    private java.util.List<String> appAddresses(String hub) {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            org.json.JSONArray rows = new org.json.JSONArray(prefs(this).getString("desk.hubs", "[]"));
            for (int i = 0; i < rows.length(); i += 1) {
                JSONObject row = rows.optJSONObject(i);
                if (row == null) continue;
                java.util.List<String> all = new java.util.ArrayList<>();
                all.add(row.optString("url", "").replaceAll("/+$", ""));
                org.json.JSONArray alt = row.optJSONArray("alt");
                if (alt != null) for (int j = 0; j < alt.length(); j += 1) all.add(alt.optString(j, "").replaceAll("/+$", ""));
                if (!all.contains(hub)) continue;
                for (String u : all) if (!u.isEmpty() && !u.equals(hub) && !out.contains(u)) out.add(u);
            }
        } catch (Exception ignored) {
            // no list yet: only the paired address
        }
        return out;
    }

    private boolean answers(String base) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + "/api/auth").openConnection();
            conn.setConnectTimeout(1500);
            // Through the relay the forwarder first connects out and does TLS (1.5.66:
            // 2.5 s was tight on mobile data, and a miss meant the dead address instead).
            conn.setReadTimeout(RelayLinks.isRelayLocal(base) ? 6000 : 2500);
            return conn.getResponseCode() > 0;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private final PhoneRoutes.Net net = new PhoneRoutes.Net() {
        @Override public boolean isRelay(String url) { return RelayLinks.isRelayLocal(url); }
        @Override public boolean isLan(String url) { return isLanAddress(url); }
        @Override public boolean isTailnet(String url) { return NetHints.isTailnetUrl(url); }
        @Override public boolean sameLan(String url) { return NetHints.onSameLan(hostOf(url)); }
        @Override public boolean mayReach(String url) { return NetHints.mayReach(url); }
        @Override public boolean answers(String url) { return NightshiftWatcher.this.answers(url); }
    };

    /**
     * Where to reach `hub` now (PhoneRoutes.pick): a LAN address of the same
     * machine on this Wi-Fi, else `hub` itself or a newer Tailscale address of
     * it when this phone can use them, else the machine's relay. With Tailscale
     * off and nothing answering, the relay stays the way (1.5.66) - not the dead
     * Tailscale address. A machine with nothing else known: `hub`, untested.
     */
    String via(String hub) {
        String[] known = routes.get(hub);
        if (known != null && System.currentTimeMillis() - Long.parseLong(known[1]) < 60000L) return known[0];
        String best = PhoneRoutes.pick(hub, addressesOf(hub), net);
        String before = known == null ? hub : known[0];
        routes.put(hub, new String[] { best, String.valueOf(System.currentTimeMillis()) });
        if (!best.equals(hub) && !best.equals(before)) {
            Log.i(TAG, "reaching " + hub + (RelayLinks.isRelayLocal(best) ? " through the relay" : isLanAddress(best) ? " on the local network" : " at its newer address"));
        }
        return best;
    }

    void forgetRoute(String hub) {
        routes.remove(hub);
    }

    private void ensureWorker(String hub) {
        Thread alive = workers.get(hub);
        if (alive != null && alive.isAlive()) return;
        Thread worker = new Thread(() -> {
            try {
                watchHub(hub);
            } finally {
                workers.remove(hub);
            }
        }, "nightshift:" + hub);
        worker.setDaemon(true);
        workers.put(hub, worker);
        worker.start();
    }

    /** Keep one hub's stream open, retrying with a backoff. */
    private void watchHub(String hub) {
        int attempt = 0;
        while (running) {
            SharedPreferences p = prefs(this);
            String token = TokenBox.open(p.getString("desk.token:" + hub, null));
            if (token == null) return; // unpaired or revoked: the supervisor decides
            // Found to be another hub's machine (1.5.67): that hub's stream is this machine's.
            if (!activeHubs().contains(hub)) {
                Log.i(TAG, "not watching " + hub + " on its own: it is " + sameAs(hub));
                return;
            }
            boolean established = false;
            try {
                established = connectAndRead(hub, token);
            } catch (Exception err) {
                if (!running) return;
                // Left the Wi-Fi (or the VPN dropped): look for the way again next time.
                forgetRoute(hub);
                Log.i(TAG, "stream from " + hub + " ended: " + err.getClass().getSimpleName());
            }
            if (!running) return;
            attempt = established ? 1 : Math.min(attempt + 1, 8);
            // Quicker back after a machine restarts (an install takes ~20 s), 1.4.1;
            // a machine that stays off is tried less and less often, up to once a
            // minute (1.5.17: an off machine was tried every 16 s all day).
            sleep(Math.min(60000L, 1500L * attempt * attempt));
        }
    }

    /** One SSE connection; returns true when it had been established. */
    private boolean connectAndRead(String hub, String token) throws Exception {
        String base = via(hub);
        String url = base + "/api/stream";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        connections.add(conn);
        try {
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setConnectTimeout(10000);
            // The hub sends a comment every 15 s. Silence for 45 s means the
            // socket is a zombie (Wi-Fi moved, NAT expired); without a timeout
            // the read blocks forever and approvals stop arriving.
            conn.setReadTimeout(45000);
            int status = conn.getResponseCode();
            if (status == 401) {
                forgetRoute(hub);
                if (!base.equals(hub) && learnedAddresses(hub).contains(base) && !appAddresses(hub).contains(base)) {
                    // Turned away at an address only fleet sync matched (by name, 1.5.66): that
                    // was another machine, not a revoked login. Stop using what was learned.
                    Log.w(TAG, "token rejected at a learned address of " + hub + ": not using it");
                    refuseLearned(hub);
                    return false;
                }
                // Revoked on the computer: forget this hub's token, keep the others.
                Log.w(TAG, "token rejected for " + hub);
                prefs(this).edit().remove("desk.token:" + hub).apply();
                return false;
            }
            if (status != 200) throw new IllegalStateException("HTTP " + status);
            Log.i(TAG, "watching " + hub);
            if (!base.equals(hub)) Log.i(TAG, "  (" + (RelayLinks.isRelayLocal(base) ? "through the relay" : "at " + base) + ")");
            // Say at once whether the bots may use this phone (1.4.1): after the
            // machine restarted it knew nothing until the next 30 s round.
            new Thread(() -> reportPhoneAgent(hub), "phone-agent-hello").start();
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.startsWith("data: ")) handleEvent(hub, line.substring(6));
            }
            return true;
        } finally {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // nothing to do
            }
            connections.remove(conn);
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    // ------------------------------------------------------------ the phone (1.4.0)
    /** POST /api/phone/agent: may the bots on that machine use this phone now? true when it answered. */
    private boolean reportPhoneAgent(String hub) {
        String token = TokenBox.open(prefs(this).getString("desk.token:" + hub, null));
        if (token == null) return false;
        try {
            JSONObject body = new JSONObject();
            body.put("enabled", PhoneAgentService.instance != null);
            // Off but still switched on in the system settings (1.5.66): the system
            // disconnected the service; the human did not turn it off.
            body.put("listed", agentListed());
            // Not connected since an update (1.5.67): the machine's message says so.
            body.put("updated", AgentKeeper.reconnectingAfterUpdate(this));
            body.put("model", (Build.MANUFACTURER + " " + Build.MODEL).trim());
            body.put("sdk", Build.VERSION.SDK_INT);
            // The same phone paired through two addresses is one phone (1.4.1).
            body.put("phoneId", phoneId(this));
            // Steps beyond the first ones (1.5.65): files into the album.
            body.put("caps", new org.json.JSONArray().put("save_media"));
            postJson(via(hub) + "/api/phone/agent", token, body);
            return true;
        } catch (Exception err) {
            forgetRoute(hub);
            Log.d(TAG, "phone agent report to " + hub + " failed: " + err.getClass().getSimpleName());
            return false;
        }
    }

    /** Does the system's accessibility list still have Lamplit's service (on, maybe not connected)? */
    private boolean agentListed() {
        try {
            return AgentKeeper.isOn(this);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Why a step cannot run: the service is not connected (1.5.66). Off in the
     * settings: the human turns it on. Still on in the settings: the system
     * disconnected it - opening Lamplit or switching it off and on reconnects it.
     */
    static String agentOffMessage(boolean listed, boolean afterUpdate) {
        if (listed) {
            // 1.5.67: after an update a bot still told the human it was "被关掉了". Say what it is, and give the words.
            return "Lamplit's phone service is not connected yet" + (afterUpdate ? " since Lamplit was updated on the phone" : " (Lamplit was updated or restarted, or the system disconnected it)")
                    + ". 「让机器人用这部手机」 is still switched on - nobody turned it off. Opening Lamplit on the phone once connects it again (the phone shows a notice for that). "
                    + "Tell the human: 「Lamplit 刚更新或重启过，机器人还没重新接上手机。在手机上打开一次 Lamplit 就好，开关不用动。」 Do not say it was turned off (不要说「被关掉了」). Then try again.";
        }
        return "「让机器人用这部手机」 is off on the phone: ask the human to turn it on in Lamplit (设置 → 机器 → 手机)";
    }

    /** This phone's own id for the machines (made once, kept in the app's storage). */
    static String phoneId(Context context) {
        SharedPreferences p = context.getSharedPreferences("lamplit_phone", Context.MODE_PRIVATE);
        String id = p.getString("id", null);
        if (id == null || id.isEmpty()) {
            id = "ph_" + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            p.edit().putString("id", id).apply();
        }
        return id;
    }

    /** save_media (1.5.65): each file from `hub` itself, with this phone's token for it, into MediaStore. */
    private JSONObject saveMedia(String hub, org.json.JSONArray files) throws Exception {
        final String token = TokenBox.open(prefs(this).getString("desk.token:" + hub, null));
        if (token == null) throw new PhoneAgentService.StepError("PHONE_FAILED", "this phone is not paired with that machine any more");
        final String base = via(hub);
        return AlbumSaver.save(this, files, (path) -> {
            HttpURLConnection conn = (HttpURLConnection) new URL(base + path).openConnection();
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(60000);
            return conn;
        });
    }

    /** Do one step a machine sent and give it the answer (POST /api/phone/jobs/:id). */
    private void runPhoneJob(String hub, JSONObject event) {
        final String jobId = event.optString("jobId", "");
        if (jobId.isEmpty() || !jobId.matches("[A-Za-z0-9_-]+")) return;
        Thread t = new Thread(() -> {
            JSONObject reply = new JSONObject();
            try {
                PhoneAgentService agent = PhoneAgentService.instance;
                if ("save_media".equals(event.optString("action", ""))) {
                    // Files into the album (1.5.65): fetched from this machine only, over its paired connection.
                    JSONObject args = event.optJSONObject("args");
                    reply.put("result", saveMedia(hub, args == null ? null : args.optJSONArray("files")));
                    reply.put("ok", true);
                } else if (agent == null) {
                    reply.put("ok", false);
                    // On in the settings but not connected yet (1.5.67): its own code, so no bot reads "off".
                    boolean listed = agentListed();
                    reply.put("code", listed ? "PHONE_AGENT_RECONNECTING" : "PHONE_AGENT_OFF");
                    reply.put("message", agentOffMessage(listed, AgentKeeper.reconnectingAfterUpdate(this)));
                } else {
                    JSONObject args = event.optJSONObject("args");
                    JSONObject result = agent.run(event.optString("action", ""), args == null ? new JSONObject() : args);
                    reply.put("ok", true);
                    reply.put("result", result);
                }
            } catch (PhoneAgentService.StepError err) {
                try {
                    reply.put("ok", false);
                    reply.put("code", err.code);
                    reply.put("message", err.getMessage());
                } catch (Exception ignored) {
                    // nothing more to say
                }
            } catch (Exception err) {
                try {
                    reply.put("ok", false);
                    reply.put("code", "PHONE_FAILED");
                    reply.put("message", String.valueOf(err.getMessage()));
                } catch (Exception ignored) {
                    // nothing more to say
                }
            }
            String token = TokenBox.open(prefs(this).getString("desk.token:" + hub, null));
            if (token == null) return;
            try {
                postJson(via(hub) + "/api/phone/jobs/" + jobId, token, reply);
            } catch (Exception err) {
                Log.d(TAG, "phone step answer to " + hub + " failed: " + err.getMessage());
                // The answer did not get through (too large, a dropped network): say
                // so in a few bytes, so the bot hears it now and not after a timeout.
                try {
                    JSONObject short_ = new JSONObject();
                    short_.put("ok", false);
                    short_.put("code", "PHONE_FAILED");
                    short_.put("message", "the phone did the step but could not send the answer back (" + err.getMessage() + ")");
                    // The way may have just gone (1.5.66: it was the dead paired address): look again.
                    forgetRoute(hub);
                    postJson(via(hub) + "/api/phone/jobs/" + jobId, token, short_);
                } catch (Exception ignored) {
                    // the machine will time out and say so
                }
            }
        }, "phone-job");
        t.setDaemon(true);
        t.start();
    }

    /** One SSE event: decide whether the human needs to be told. */
    private void handleEvent(String hub, String json) {
        try {
            JSONObject event = new JSONObject(json);
            String type = event.optString("type", "");
            if ("phone.job".equals(type)) {
                // A step for this phone from a paired machine (1.4.0); the machine
                // sends it to this phone only and has already asked the human.
                runPhoneJob(hub, event);
                return;
            }
            if ("approval.request".equals(type)) {
                // Always worth a buzz: the turn is blocked on a decision.
                notifyApproval(hub,
                        event.optString("approvalId", ""),
                        event.optString("botId", ""),
                        event.optString("botName", ""),
                        event.optString("tool", "工具"),
                        event.optJSONObject("args"),
                        event.optString("reason", ""));
                return;
            }
            if ("approval.resolved".equals(type)) {
                // Decided on the computer or in another client: the phone's card
                // must go away too, or it keeps asking for an answer already given.
                String resolvedId = event.optString("approvalId", "");
                if (!resolvedId.isEmpty()) cancelApprovalNotification(resolvedId);
                return;
            }
            if ("human.notice".equals(type)) {
                // A bot needs the human's decision (tell_human): always worth a buzz,
                // even when a teammate or a routine was the one asking.
                String bot = event.optString("botName", "");
                notify((bot.isEmpty() ? "" : bot + " · ") + "需要你拍板", event.optString("text", "打开 Lamplit 看看。"), hub,
                        "", event.optString("botId", ""), bot);
                return;
            }
            if ("turn.end".equals(type)) {
                // Quiet while the user is already watching that screen.
                if (appVisible) return;
                String status = event.optString("status", "success");
                String summary = event.optString("summary", "");
                String title = "success".equals(status) ? "这一轮做完了" : "这一轮结束了：" + status;
                notify(title, summary.isEmpty() ? "打开 Lamplit 看看结果。" : summary, hub,
                        "", event.optString("botId", ""), event.optString("botName", ""));
            }
        } catch (Exception err) {
            Log.d(TAG, "bad event: " + err.getMessage());
        }
    }

    // ------------------------------------------------------------ notifications
    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE, "后台运行", NotificationManager.IMPORTANCE_MIN);
        service.setDescription("Lamplit 在后台盯着任务。关掉它就不再提醒。");
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel events = new NotificationChannel(
                CHANNEL_EVENTS, "任务提醒", NotificationManager.IMPORTANCE_HIGH);
        events.setDescription("任务做完、或者助手在等你确认时提醒你。");
        events.enableVibration(true);
        manager.createNotificationChannel(events);
    }

    /**
     * A tap carries the exact machine the event came from, plus the approval to
     * focus. Request codes must differ per notification: PendingIntent identity
     * ignores extras, so a shared code would make the newest extras win for
     * every notification still on screen.
     */
    private PendingIntent openApp(int requestCode, String hub, String approvalId, String botId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (hub != null && !hub.isEmpty()) intent.putExtra("desk.openHub", hub);
        if (approvalId != null && !approvalId.isEmpty()) intent.putExtra("desk.openApproval", approvalId);
        if (botId != null && !botId.isEmpty()) intent.putExtra("desk.openBot", botId);
        int pending = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pending |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, intent, pending);
    }

    private PendingIntent approvalAction(int requestCode, String hub, String approvalId, String decision, int notificationId) {
        Intent intent = new Intent(this, ApprovalActionReceiver.class);
        intent.setAction(ApprovalActionReceiver.ACTION_DECIDE);
        intent.putExtra(ApprovalActionReceiver.EXTRA_HUB, hub);
        intent.putExtra(ApprovalActionReceiver.EXTRA_APPROVAL_ID, approvalId);
        intent.putExtra(ApprovalActionReceiver.EXTRA_DECISION, decision);
        intent.putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, notificationId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(this, requestCode, intent, flags);
    }

    /**
     * The approval notification is a card, not the system template: the same
     * shape as the chat's approval card (kicker, waiting pill, what it wants to
     * do, why it stopped), with the two choices as real buttons. Both buttons
     * post the existing explicit, immutable broadcast to ApprovalActionReceiver,
     * so the device token still never leaves the app's private prefs.
     */
    private void notifyApproval(String hub, String approvalId, String botId, String botName,
                                String tool, JSONObject args, String reason) {
        int id = eventSeq++;
        // At most 8 notices kept (ids reused), not 90 (1.5.20: 100 posted, the system dropped new ones).
        if (eventSeq > 4117) eventSeq = 4110;
        String title = approvalTitle(tool);
        String detail = approvalDetail(tool, args);
        String why = reason == null || reason.trim().isEmpty()
                ? "这一步会改动文件或对外发东西，所以先停下来问你。"
                : "为什么停下来问你：" + reason.trim();

        RemoteViews card = new RemoteViews(getPackageName(), R.layout.notification_approval);
        card.setTextViewText(R.id.notif_kicker,
                botName.isEmpty() ? "需要你确认" : "需要你确认 · " + botName);
        card.setTextViewText(R.id.notif_title, title);
        if (detail.isEmpty()) {
            card.setViewVisibility(R.id.notif_detail, View.GONE);
        } else {
            card.setViewVisibility(R.id.notif_detail, View.VISIBLE);
            card.setTextViewText(R.id.notif_detail_label, approvalDetailLabel(tool));
            card.setTextViewText(R.id.notif_detail_value, detail);
        }
        card.setTextViewText(R.id.notif_why, why);

        PendingIntent open = openApp(id, hub, approvalId, botId);
        card.setOnClickPendingIntent(R.id.notif_card, open);
        card.setOnClickPendingIntent(R.id.notif_title, open);
        card.setOnClickPendingIntent(R.id.notif_detail, open);
        card.setOnClickPendingIntent(R.id.notif_why, open);
        card.setOnClickPendingIntent(R.id.notif_allow,
                approvalAction(id * 2, hub, approvalId, "approve", id));
        card.setOnClickPendingIntent(R.id.notif_deny,
                approvalAction(id * 2 + 1, hub, approvalId, "deny", id));

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_EVENTS)
                : new Notification.Builder(this);
        builder.setContentTitle(botName.isEmpty() ? "需要你确认" : "需要你确认 · " + botName)
                .setContentText(detail.isEmpty() ? title : title + " · " + detail)
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setCustomBigContentView(card)
                // Its own group: sharing the app's auto group with the foreground
                // service buries the card behind a "Nightshift (2)" bundle, and a
                // collapsed bundle cannot show the two buttons at all.
                .setGroup("nightshift.approval." + approvalId);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(id, builder.build());
    }

    /** Cancel this approval's card wherever it still sits in the shade. */
    private void cancelApprovalNotification(String approvalId) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String group = "nightshift.approval." + approvalId;
        StatusBarNotification[] active = manager.getActiveNotifications();
        if (active == null) return;
        for (StatusBarNotification sbn : active) {
            Notification posted = sbn.getNotification();
            if (posted != null && group.equals(posted.getGroup())) manager.cancel(sbn.getId());
        }
    }

    /** Plain-language version of the tool name, mirroring the chat card. */
    private static String approvalTitle(String tool) {
        switch (tool) {
            case "shell": return "想在这台电脑上运行一条命令";
            case "fs_write": return "想写入一个文件";
            case "fs_delete": return "想删除一个文件或文件夹";
            case "fs_mkdir": return "想新建一个文件夹";
            case "fs_read": return "想读取一个文件";
            case "fs_list": return "想看看目录里有什么";
            case "http_fetch": return "想访问一个网址";
            case "browser_open": return "想打开一个网页";
            case "browser_download": return "想下载一个文件";
            case "browser_click": return "想点击网页上的一个位置";
            case "browser_type": return "想在网页里输入文字";
            case "browser_eval": return "想在网页里运行一段脚本";
            case "memory_write": return "想记住一件事";
            case "routine_create": return "想创建一个会自己重复跑的任务";
            case "routine_run": return "想立刻运行一个定时任务";
            case "bot_message": return "想把任务交给另一位助手";
            case "bot_create": return "想新建一个助手";
            case "bot_update": return "想改一个助手的设置";
            case "bot_delete": return "想删除一个助手";
            case "file_send": return "想把一个文件发到另一台机器";
            case "file_fetch": return "想从另一台机器取回一个文件";
            case "machine_switch": return "想把任务交给另一台机器";
            case "image_generate": return "想生成图片";
            case "video_generate": return "想生成一段视频";
            default: return tool.isEmpty() ? "想动一步" : "想使用「" + tool + "」动一步";
        }
    }

    private static String approvalDetailLabel(String tool) {
        switch (tool) {
            case "shell": return "命令";
            case "fs_write":
            case "fs_delete":
            case "fs_mkdir":
            case "fs_read":
            case "fs_list":
            case "file_send":
            case "file_fetch": return "文件";
            case "http_fetch":
            case "browser_open":
            case "browser_download": return "网址";
            case "browser_click": return "目标";
            case "browser_type": return "内容";
            case "browser_eval": return "脚本";
            case "memory_write": return "记住";
            case "routine_create":
            case "bot_message": return "任务";
            case "routine_run": return "任务编号";
            case "machine_switch": return "机器";
            case "image_generate":
            case "video_generate": return "描述";
            default: return "工具";
        }
    }

    /** The one argument that explains the action, capped for the shade. */
    private static String approvalDetail(String tool, JSONObject args) {
        if (args == null) return "";
        String value;
        switch (tool) {
            case "shell": value = args.optString("command", ""); break;
            case "fs_write":
            case "fs_delete":
            case "fs_mkdir":
            case "fs_read":
            case "fs_list":
            case "file_send":
            case "file_fetch": value = args.optString("path", ""); break;
            case "http_fetch":
            case "browser_open":
            case "browser_download": value = args.optString("url", ""); break;
            case "browser_click": value = args.optString("selector", args.optString("ref", args.optString("text", ""))); break;
            case "browser_type": value = args.optString("text", ""); break;
            case "browser_eval": value = args.optString("script", args.optString("code", "")); break;
            case "memory_write": value = args.optString("text", ""); break;
            case "routine_create": value = args.optString("name", args.optString("instruction", "")); break;
            case "routine_run": value = args.optString("id", ""); break;
            case "bot_message": value = args.optString("text", ""); break;
            case "machine_switch": value = args.optString("machine", ""); break;
            case "image_generate":
            case "video_generate": value = args.optString("prompt", ""); break;
            default: value = ""; break;
        }
        value = value.trim();
        if (value.length() > 160) value = value.substring(0, 157) + "…";
        return value;
    }

    private Notification serviceNotification(Context context) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_SERVICE)
                : new Notification.Builder(context);
        builder.setContentTitle("Lamplit 在后台盯着")
                .setContentText("有结果会提醒你")
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(0, null, null, null))
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent stop = new Intent(context, NightshiftWatcher.class);
            stop.setAction("stop");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            builder.addAction(new Notification.Action.Builder(
                    null, "停止", PendingIntent.getService(context, 7, stop, flags)).build());
        }
        return builder.build();
    }

    private void notify(String title, String body, String hub, String approvalId, String botId, String botName) {
        int id = eventSeq++;
        // At most 8 notices kept (ids reused), not 90 (1.5.20: 100 posted, the system dropped new ones).
        if (eventSeq > 4117) eventSeq = 4110;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_EVENTS)
                : new Notification.Builder(this);
        builder.setContentTitle(botName.isEmpty() ? title : (title + " · " + botName))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_nightshift)
                .setContentIntent(openApp(id, hub, approvalId, botId))
                .setAutoCancel(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setVisibility(Notification.VISIBILITY_PRIVATE);
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(id, builder.build());
    }
}
