package com.desk.assistant;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 「让机器人用这部手机」 (1.4.0): the phone works for the bots without a cable.
 *
 * The human turns this on in the system's accessibility settings (Lamplit only
 * opens that page). While it is on, a notice says so and has a 停止 button.
 * NightshiftWatcher hands it one step at a time from the machines the phone is
 * paired with; each machine has already asked the human where its rules say so
 * (paying, sending, publishing, agreeing always ask). This service only does
 * the step: read the screen, take a screenshot, tap, swipe, type into the box
 * with the cursor, press back/home/enter, open an app.
 *
 * Never: unlock the phone (a locked or dark screen stops every step), or type
 * into a password box.
 */
public class PhoneAgentService extends AccessibilityService {

    static volatile PhoneAgentService instance;

    private static final String CHANNEL = "phone-agent";
    private static final int NOTICE_ID = 4201;
    static final String ACTION_STOP = "com.desk.assistant.action.STOP_PHONE_AGENT";

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        // The human wants it on (1.5.20): kept until they turn it off themselves.
        AgentKeeper.setWanted(this, true);
        showNotice();
        // The system starts this service by itself (after the phone restarts or
        // Lamplit is updated) without opening Lamplit; the connection to the
        // machines must come up too, or no machine can reach the phone.
        if (NightshiftWatcher.hasPairing(this)) {
            try {
                Intent watch = new Intent(this, NightshiftWatcher.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(watch);
                else startService(watch);
            } catch (Exception ignored) {
                // not allowed right now: opening Lamplit once starts it
            }
        }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        hideNotice();
        // Told while Lamplit runs: the human turned it off in the system settings.
        // (An update or a stop kills Lamplit first, so this is not called then.)
        AgentKeeper.setWanted(this, false);
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        hideNotice();
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing to watch: the service only acts when a machine sends a step.
    }

    @Override
    public void onInterrupt() {
        // nothing in progress to interrupt
    }

    /** The human pressed 停止 on the notice. */
    void stopByHuman() {
        AgentKeeper.setWanted(this, false);
        hideNotice();
        disableSelf();
    }

    // ------------------------------------------------------------------ notice
    private void showNotice() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "机器人用手机", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("机器人可以操作这部手机时，一直显示这条提示。");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent stop = new Intent(this, PhoneAgentStopReceiver.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getBroadcast(this, 4202, stop, flags);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(this, 4203, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("机器人可以操作这部手机")
                .setContentText("付款、发送、发布每次都会先问你。不用了就点「停止」。")
                .setOngoing(true)
                .setContentIntent(openIntent)
                .addAction(new Notification.Action.Builder(null, "停止", stopIntent).build());
        nm.notify(NOTICE_ID, b.build());
    }

    private void hideNotice() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTICE_ID);
    }

    // ------------------------------------------------------------------- steps
    static class StepError extends Exception {
        final String code;

        StepError(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** One step from a machine. Runs on the watcher's thread, never the main one. */
    JSONObject run(String action, JSONObject args) throws Exception {
        switch (action) {
            case "window":
                return window();
            case "ui":
                return new JSONObject().put("xml", uiXml());
            case "screenshot":
                return screenshot();
            case "size":
                return size();
            case "tap":
                gesture(args.optInt("x"), args.optInt("y"), args.optInt("x"), args.optInt("y"), 60);
                return new JSONObject();
            case "swipe": {
                int x1 = args.optInt("x1"), y1 = args.optInt("y1"), x2 = args.optInt("x2"), y2 = args.optInt("y2");
                gesture(x1, y1, x2, y2, Math.max(50, Math.min(3000, args.optInt("ms", 350))));
                return new JSONObject();
            }
            case "type":
                type(args.optString("text", ""));
                return new JSONObject();
            case "key":
                key(args.optInt("code"));
                return new JSONObject();
            case "open":
                open(args.optString("pkg", ""));
                return new JSONObject();
            case "installed":
                return new JSONObject().put("installed", installed(args.optString("pkg", "")));
            case "apps":
                return apps();
            case "wake":
                return wake();
            default:
                throw new StepError("PHONE_FAILED", "unknown step " + action);
        }
    }

    private JSONObject window() throws Exception {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean locked = (km != null && km.isKeyguardLocked()) || (pm != null && !pm.isInteractive());
        AccessibilityNodeInfo root = getRootInActiveWindow();
        String app = root != null && root.getPackageName() != null ? root.getPackageName().toString() : "";
        return new JSONObject().put("locked", locked).put("app", app);
    }

    /**
     * Screen off (1.5.17): light it, and when the phone itself is not locked (no
     * PIN, or Smart Lock trusts it) put the swipe screen away. A PIN, pattern or
     * password stays the human's: then it only says the phone is locked.
     */
    private JSONObject wake() throws Exception {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (pm != null && !pm.isInteractive()) {
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock lit = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "lamplit:wake");
            lit.acquire(3000);
        }
        boolean secure = km != null && km.isDeviceLocked();
        if (km != null && km.isKeyguardLocked() && !secure) {
            Intent open = new Intent(this, UnlockActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            startActivity(open);
        }
        Thread.sleep(1200);
        // ColorOS stops an activity from showing over the lock screen unless the
        // human allowed 锁屏显示 (seen 11-17): with no code needed, swipe it up
        // as a finger would. Never when the phone says a code is needed.
        if (km != null && km.isKeyguardLocked() && !km.isDeviceLocked()) {
            JSONObject s = size();
            int w0 = s.optInt("w", 1080), h0 = s.optInt("h", 2400);
            gesture(w0 / 2, (int) (h0 * 0.88), w0 / 2, (int) (h0 * 0.30), 300);
            Thread.sleep(900);
        }
        JSONObject w = window();
        return w.put("needsCode", secure);
    }

    private JSONObject size() throws Exception {
        android.util.DisplayMetrics m = new android.util.DisplayMetrics();
        android.view.WindowManager wm = (android.view.WindowManager) getSystemService(Context.WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(m);
        return new JSONObject().put("w", m.widthPixels).put("h", m.heightPixels);
    }

    // ---- the screen as the same XML uiautomator gives (src/phone.mjs reads it)
    private String uiXml() {
        StringBuilder out = new StringBuilder("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) dump(root, 0, out, 0);
        out.append("</hierarchy>");
        return out.toString();
    }

    private void dump(AccessibilityNodeInfo n, int index, StringBuilder out, int depth) {
        if (n == null || depth > 60) return;
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        boolean hint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && n.isShowingHintText();
        String cls = n.isEditable() ? "android.widget.EditText" : String.valueOf(n.getClassName());
        out.append("<node index=\"").append(index)
                .append("\" text=\"").append(esc(hint || n.isPassword() ? "" : n.getText()))
                .append("\" resource-id=\"").append(esc(n.getViewIdResourceName()))
                .append("\" class=\"").append(esc(cls))
                .append("\" package=\"").append(esc(n.getPackageName()))
                .append("\" content-desc=\"").append(esc(n.getContentDescription() != null ? n.getContentDescription() : (hint ? n.getText() : "")))
                .append("\" clickable=\"").append(n.isClickable())
                .append("\" enabled=\"").append(n.isEnabled())
                .append("\" focused=\"").append(n.isFocused())
                .append("\" scrollable=\"").append(n.isScrollable())
                .append("\" password=\"").append(n.isPassword())
                .append("\" bounds=\"[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\"");
        int count = n.getChildCount();
        if (count == 0) {
            out.append(" />");
            return;
        }
        out.append('>');
        for (int i = 0; i < count; i += 1) dump(n.getChild(i), i, out, depth + 1);
        out.append("</node>");
    }

    private static String esc(CharSequence s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i += 1) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("&quot;"); break;
                case '&': b.append("&amp;"); break;
                case '<': b.append("&lt;"); break;
                case '>': b.append("&gt;"); break;
                case '\n': b.append("&#10;"); break;
                default: b.append(c);
            }
        }
        return b.toString();
    }

    // ---- screenshot (Android 11+)
    private JSONObject screenshot() throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) throw new StepError("PHONE_FAILED", "screenshots need Android 11 or newer");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> shot = new AtomicReference<>();
        AtomicReference<String> why = new AtomicReference<>("");
        takeScreenshot(Display.DEFAULT_DISPLAY, Executors.newSingleThreadExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult result) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(result.getHardwareBuffer(), result.getColorSpace());
                    if (hw != null) shot.set(hw.copy(Bitmap.Config.ARGB_8888, false));
                    result.getHardwareBuffer().close();
                } finally {
                    done.countDown();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                why.set("screenshot failed (" + errorCode + ")");
                done.countDown();
            }
        });
        if (!done.await(15, TimeUnit.SECONDS) || shot.get() == null) throw new StepError("PHONE_FAILED", why.get().isEmpty() ? "no screenshot" : why.get());
        // JPEG, not PNG: a full-size PNG took ~37 s to make and send (1.4.0).
        ByteArrayOutputStream jpg = new ByteArrayOutputStream();
        shot.get().compress(Bitmap.CompressFormat.JPEG, 80, jpg);
        return new JSONObject().put("image", Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP));
    }

    // ---- touch
    private void gesture(int x1, int y1, int x2, int y2, int ms) throws Exception {
        Path path = new Path();
        path.moveTo(Math.max(0, x1), Math.max(0, y1));
        if (x1 != x2 || y1 != y2) path.lineTo(Math.max(0, x2), Math.max(0, y2));
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(1, ms)))
                .build();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                ok.set(true);
                done.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                done.countDown();
            }
        }, null);
        if (!sent || !done.await(ms + 5000L, TimeUnit.MILLISECONDS) || !ok.get()) throw new StepError("PHONE_FAILED", "the phone did not take the touch");
    }

    // ---- typing: straight into the box with the cursor (no clipboard)
    private AccessibilityNodeInfo focusedBox() throws StepError {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo box = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (box == null || !box.isEditable()) throw new StepError("PHONE_NO_BOX", "no box has the cursor: tap the box first, then type");
        if (box.isPassword()) throw new StepError("PHONE_PASSWORD_FIELD", "that is a password box: the human types passwords themselves");
        return box;
    }

    private void type(String text) throws Exception {
        AccessibilityNodeInfo box = focusedBox();
        boolean hint = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && box.isShowingHintText();
        CharSequence now = hint ? "" : box.getText();
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, (now == null ? "" : now.toString()) + text);
        if (!box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw new StepError("PHONE_FAILED", "the box did not take the text");
    }

    private void key(int code) throws Exception {
        switch (code) {
            case 4: performGlobalAction(GLOBAL_ACTION_BACK); return;
            case 3: performGlobalAction(GLOBAL_ACTION_HOME); return;
            case 187: performGlobalAction(GLOBAL_ACTION_RECENTS); return;
            case 66: {
                AccessibilityNodeInfo box = focusedBox();
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                        || !box.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
                    throw new StepError("PHONE_FAILED", "this box has no enter: tap the search or send button instead");
                }
                return;
            }
            case 67: {
                AccessibilityNodeInfo box = focusedBox();
                CharSequence now = box.getText();
                String s = now == null ? "" : now.toString();
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s.isEmpty() ? "" : s.substring(0, s.length() - 1));
                box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                return;
            }
            default:
                throw new StepError("PHONE_FAILED", "that key is not available without the cable (back, home, recent, enter, delete are)");
        }
    }

    // ---- apps
    private void open(String pkg) throws Exception {
        Intent launch = getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) throw new StepError("PHONE_APP_NOT_FOUND", pkg + " is not installed (or cannot be opened)");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(launch);
    }

    private boolean installed(String pkg) {
        try {
            getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private JSONObject apps() throws Exception {
        JSONArray out = new JSONArray();
        for (ApplicationInfo info : getPackageManager().getInstalledApplications(0)) {
            if ((info.flags & ApplicationInfo.FLAG_SYSTEM) == 0) out.put(info.packageName);
        }
        return new JSONObject().put("apps", out);
    }
}
