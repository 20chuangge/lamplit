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
        if (on) hideOffNotice(c);
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
            if (!wanted(c) || PhoneAgentService.instance != null || isOn(c)) {
                if (isOn(c)) hideOffNotice(c);
                return;
            }
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
