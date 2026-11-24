package com.desk.assistant;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

/**
 * Keeps 「让机器人用这部手机」 on while the human wants it on (1.5.20).
 *
 * Android turns an accessibility service off whenever its app is stopped: an
 * update (11-17: six installs, six times off), a swipe in the recent apps, a
 * cleaner. The human then had to find the switch again.
 *
 * What the human wants is remembered: on when the service connects; off when
 * they press 停止, or turn it off in the system settings (the service is told
 * so while Lamplit is running - an update or a stop kills Lamplit first, so it
 * hears nothing and the wish stays "on").
 *
 * With WRITE_SECURE_SETTINGS (granted once from a computer:
 *   adb shell pm grant com.desk.assistant android.permission.WRITE_SECURE_SETTINGS)
 * Lamplit adds its own service back to the enabled list - only its own, never
 * any other setting. Without it, a notice asks the human to turn it on again.
 */
final class AgentKeeper {
    private static final String TAG = "lamplit-keeper";
    private static final String PREFS = "lamplit_phone";
    private static final String WANT = "agentWanted";
    private static final int NOTICE_OFF = 4102;
    private static final String CHANNEL = "phone-agent-off";

    private AgentKeeper() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void setWanted(Context c, boolean on) {
        prefs(c).edit().putBoolean(WANT, on).apply();
        if (on) {
            hideOffNotice(c);
            // Connected (1.5.67): the "tap to reconnect" notice goes too.
            hideReconnectNotice(c);
            unboundSince = 0;
        }
    }

    static boolean wanted(Context c) {
        return prefs(c).getBoolean(WANT, false);
    }

    static boolean canTurnOn(Context c) {
        return c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED;
    }

    private static String component(Context c) {
        return new ComponentName(c, PhoneAgentService.class).flattenToString();
    }

    static boolean isOn(Context c) {
        String list = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (list == null) return false;
        String mine = component(c);
        for (String s : list.split(":")) if (s.equalsIgnoreCase(mine)) return true;
        return false;
    }

    /** Wanted but off: turn it back on (with the permission) or ask the human to. */
    static void ensure(Context c) {
        try {
            if (PhoneAgentService.instance != null) {
                unboundSince = 0;
                hideOffNotice(c);
                hideReconnectNotice(c);
                return;
            }
            if (isOn(c)) {
                // On in the settings but not connected (1.5.67): see reconnect().
                hideOffNotice(c);
                reconnect(c);
                return;
            }
            hideReconnectNotice(c);
            if (!wanted(c)) return;
            if (canTurnOn(c)) {
                String list = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
                String next = (list == null || list.isEmpty()) ? component(c) : list + ":" + component(c);
                Settings.Secure.putString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next);
                Settings.Secure.putString(c.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, "1");
                Log.i(TAG, "turned 让机器人用这部手机 back on");
                hideOffNotice(c);
            } else {
                showOffNotice(c);
            }
        } catch (Exception err) {
            Log.w(TAG, "could not turn it back on: " + err.getClass().getSimpleName());
            showOffNotice(c);
        }
    }

    // ------------------------------------------------------------ on, but not connected (1.5.67)
    /*
     * Seen 11-24 on an OPPO: after Lamplit was updated (adb install -r) the
     * service stayed on in the system settings, but the system did not connect
     * it again until the human opened Lamplit. Meanwhile the bots heard "off".
     * Now, after 15 s of that: with WRITE_SECURE_SETTINGS the service is taken
     * out of the list and put back (the system connects it again) - once per
     * gap; without it (or when that did not help) a notice asks the human to
     * tap, which opens Lamplit and so connects it.
     */
    private static final int NOTICE_RECONNECT = 4104;
    private static final String CHANNEL_RECONNECT = "phone-agent-reconnect";
    private static final String REPLACED_AT = "replacedAt";
    private static volatile long unboundSince = 0;
    private static volatile long toggledFor = -1;

    /** StartupReceiver: Lamplit was just updated (the notice says so). */
    static void noteUpdated(Context c) {
        prefs(c).edit().putLong(REPLACED_AT, System.currentTimeMillis()).apply();
    }

    private static boolean justUpdated(Context c) {
        long at = prefs(c).getLong(REPLACED_AT, 0L);
        return at > 0 && System.currentTimeMillis() - at < 30L * 60000L;
    }

    /** What the bots' message says the gap came from: an update, or a restart / the system. */
    static boolean reconnectingAfterUpdate(Context c) {
        return justUpdated(c);
    }

    private static void reconnect(Context c) {
        long now = System.currentTimeMillis();
        if (unboundSince == 0) {
            unboundSince = now; // the system often connects it by itself within seconds
            return;
        }
        if (now - unboundSince < 15000L) return;
        if (toggledFor != unboundSince && canTurnOn(c)) {
            toggledFor = unboundSince;
            final Context app = c.getApplicationContext();
            new Thread(() -> {
                try {
                    String mine = component(app);
                    String list = Settings.Secure.getString(app.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
                    StringBuilder without = new StringBuilder();
                    if (list != null) for (String s : list.split(":")) {
                        if (s.isEmpty() || s.equalsIgnoreCase(mine)) continue;
                        if (without.length() > 0) without.append(':');
                        without.append(s);
                    }
                    Settings.Secure.putString(app.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, without.toString());
                    Thread.sleep(500);
                    String back = without.length() == 0 ? mine : without + ":" + mine;
                    Settings.Secure.putString(app.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, back);
                    Settings.Secure.putString(app.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, "1");
                    Log.i(TAG, "让机器人用这部手机 was on but not connected: switched it off and on to connect it");
                } catch (Exception err) {
                    Log.w(TAG, "could not reconnect it: " + err.getClass().getSimpleName());
                }
            }, "agent-reconnect").start();
            return;
        }
        showReconnectNotice(c);
    }

    private static void showReconnectNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_RECONNECT, "机器人重新接上手机", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(c, 4105, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(c, CHANNEL_RECONNECT) : new Notification.Builder(c);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(justUpdated(c) ? "Lamplit 更新好了，点一下让机器人重新接上手机" : "点一下让机器人重新接上手机")
                .setContentText("「让机器人用这部手机」还开着，只是系统还没把它接上。打开一次 Lamplit 就好。")
                .setContentIntent(pi)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true);
        nm.notify(NOTICE_RECONNECT, b.build());
    }

    private static void hideReconnectNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTICE_RECONNECT);
    }

    private static void showOffNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "机器人用手机被关掉了", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(c, 4103, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("「让机器人用这部手机」被系统关掉了")
                .setContentText("Lamplit 更新或被清理后系统会关掉它。点这里重新打开。")
                .setContentIntent(pi)
                .setAutoCancel(true);
        nm.notify(NOTICE_OFF, b.build());
    }

    private static void hideOffNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTICE_OFF);
    }
}
