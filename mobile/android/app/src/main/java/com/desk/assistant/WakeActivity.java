package com.desk.assistant;

import android.app.Activity;
import android.os.Bundle;

/**
 * Starts the Lamplit process and closes at once, showing nothing (1.3.1).
 *
 * ColorOS will not start an app that is not running for a content provider
 * call from adb, so before typing Chinese the computer runs
 *   adb shell am start -W -n com.desk.assistant/.WakeActivity
 * which brings the process up without opening Lamplit over the app being
 * typed into; PhoneTypeProvider can then be reached.
 */
public class WakeActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        finish();
        overridePendingTransition(0, 0);
    }
}
