package com.desk.assistant;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Text for the phone tool (1.3.1): a bot on the computer types into an app on
 * this phone through adb, but `adb shell input text` only takes plain ASCII.
 * For anything else (Chinese) the computer calls
 *   adb shell content call --uri content://com.desk.assistant.phonetype --method type --arg <base64>
 * and the text goes on the clipboard; the computer then presses paste in the
 * box with the cursor.
 *
 * A content provider, not a broadcast receiver: on ColorOS a broadcast to an
 * app the system keeps in the background never arrived (1.3.0, 11-15), while
 * a provider call starts or wakes the app.
 *
 * Only adb can call this: call() checks android.permission.DUMP itself (the
 * manifest permission does not cover call()); the adb shell has it and no
 * ordinary app can get it. Nothing is read from the clipboard, nothing is sent.
 */
public class PhoneTypeProvider extends ContentProvider {

    private static final String TAG = "lamplit-phone-type";
    private static final int MAX_CHARS = 5000;

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        Bundle out = new Bundle();
        Context context = getContext();
        if (context == null || context.checkCallingPermission("android.permission.DUMP") != PackageManager.PERMISSION_GRANTED) {
            out.putBoolean("ok", false);
            out.putString("error", "adb only");
            return out;
        }
        if ("probe".equals(method)) {
            out.putBoolean("ok", true);
            return out;
        }
        if (!"type".equals(method) || arg == null || arg.isEmpty()) {
            out.putBoolean("ok", false);
            out.putString("error", "say method type with the text in base64");
            return out;
        }
        try {
            String raw = new String(Base64.decode(arg, Base64.DEFAULT), StandardCharsets.UTF_8);
            final String text = raw.length() > MAX_CHARS ? raw.substring(0, MAX_CHARS) : raw;
            final ClipboardManager clip = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clip == null) {
                out.putBoolean("ok", false);
                out.putString("error", "no clipboard");
                return out;
            }
            // Set right here, on the call's own thread: the clipboard does not
            // need the main thread, and in the background ColorOS can hold the
            // main thread back past any wait (1.3.1: two of three tries timed
            // out). The main thread is only the fallback.
            final AtomicBoolean done = new AtomicBoolean(false);
            try {
                clip.setPrimaryClip(ClipData.newPlainText("Lamplit", text));
                done.set(true);
            } catch (Exception direct) {
                Log.w(TAG, "direct set failed, trying the main thread: " + direct.getMessage());
                final CountDownLatch latch = new CountDownLatch(1);
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        clip.setPrimaryClip(ClipData.newPlainText("Lamplit", text));
                        done.set(true);
                    } catch (Exception e) {
                        Log.w(TAG, "could not set the text: " + e.getMessage());
                    } finally {
                        latch.countDown();
                    }
                });
                latch.await(5, TimeUnit.SECONDS);
            }
            out.putBoolean("ok", done.get());
            if (!done.get()) out.putString("error", "the clipboard did not take it");
        } catch (Exception e) {
            out.putBoolean("ok", false);
            out.putString("error", String.valueOf(e.getMessage()));
        }
        return out;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
