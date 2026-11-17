package com.desk.assistant;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

/**
 * Lights the screen and puts away a lock screen that needs nothing (1.5.17).
 *
 * A bot asked to use the phone while its screen was off could only say "please
 * unlock it". When the phone itself says it is not locked - no PIN, or Smart
 * Lock trusts where it is - this shows over the lock screen, turns the screen
 * on and asks the system to dismiss the swipe screen, then closes. It never
 * brings up or fills in a PIN, pattern or password: PhoneAgentService starts it
 * only when KeyguardManager.isDeviceLocked() is false.
 */
public class UnlockActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (km != null && km.isDeviceLocked()) { finish(); return; }
        if (km != null && Build.VERSION.SDK_INT >= 26) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override public void onDismissSucceeded() { finish(); }
                @Override public void onDismissCancelled() { finish(); }
                @Override public void onDismissError() { finish(); }
            });
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
            finish();
        }
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }
}
