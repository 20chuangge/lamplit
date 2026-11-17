package com.desk.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * After an update of Lamplit or a restart of the phone (1.5.20): bring the
 * connection to the machines back and 「让机器人用这部手机」 with it, without
 * anyone opening Lamplit. Before, an update left both off until the app was opened.
 */
public class StartupReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) && !Intent.ACTION_BOOT_COMPLETED.equals(action)) return;
        AgentKeeper.ensure(context);
        if (!NightshiftWatcher.hasPairing(context)) return;
        try {
            Intent watch = new Intent(context, NightshiftWatcher.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(watch);
            else context.startService(watch);
        } catch (Exception ignored) {
            // not allowed right now: opening Lamplit once starts it
        }
    }
}
