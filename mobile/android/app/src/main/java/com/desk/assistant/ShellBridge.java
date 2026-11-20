package com.desk.assistant;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.util.Map;
import android.content.pm.ActivityInfo;
import android.view.Window;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Native window control for the takeover view.
 *
 * The hub page is a remote URL, so Capacitor's plugin JS bridge is not injected
 * there; these two calls are the same intent the screen-orientation plugin
 * carries, exposed directly to the page.
 */
public class ShellBridge {

    private final Activity activity;

    public ShellBridge(Activity activity) {
        this.activity = activity;
    }

    /*
     * Who is calling (SEC-16). Every page the app shows gets this bridge, and
     * the app may show any address a link leads to. The clipboard is for the
     * app's own page and the machines this phone is paired with; the token box
     * is for the app's own page only (the launcher, http://localhost).
     */
    private String currentUrl() {
        FutureTask<String> task = new FutureTask<>(() -> {
            if (!(activity instanceof BridgeActivity)) return "";
            WebView view = ((BridgeActivity) activity).getBridge().getWebView();
            String url = view == null ? null : view.getUrl();
            return url == null ? "" : url;
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "";
        }
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return "";
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return "";
        }
    }

    boolean fromAppPage() {
        return "http://localhost".equals(originOf(currentUrl()));
    }

    /**
     * A machine's page, for calls that only move between the app's own screens
     * (showMachines, openMachine): a trusted page, or one this app opened
     * through its relay forwarder (127.0.0.1:14440-14499, pinned to a machine
     * the phone paired with). 1.5.38: on mobile data the page is the forwarder
     * and its origin holds no login of its own, so these were refused.
     */
    boolean fromMachinePage() {
        return fromTrustedPage() || RelayLinks.isRelayLocal(currentUrl());
    }

    boolean fromTrustedPage() {
        String origin = originOf(currentUrl());
        if (origin.isEmpty()) return false;
        if ("http://localhost".equals(origin)) return true;
        SharedPreferences p = activity.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        for (Map.Entry<String, ?> entry : p.getAll().entrySet()) {
            String key = entry.getKey();
            if (key.startsWith("desk.token:") && origin.equals(originOf(key.substring("desk.token:".length())))) return true;
        }
        return false;
    }

    /** A device token sealed with the phone's Keystore (launcher only). Empty when sealing is not possible. */
    @JavascriptInterface
    public String sealToken(final String token) {
        if (!fromAppPage()) return "";
        String sealed = TokenBox.seal(token);
        return sealed == null ? "" : sealed;
    }

    /** The token inside a sealed value (launcher only). Empty when it cannot be opened. */
    @JavascriptInterface
    public String openToken(final String sealed) {
        if (!fromAppPage()) return "";
        String token = TokenBox.open(sealed);
        return token == null ? "" : token;
    }

    /**
     * The local address (http://127.0.0.1:144xx) for a computer behind a Lamplit
     * relay, pinned to the certificate fingerprint its pairing code carried
     * (launcher only; 第 1 步原型). Empty when it is not a relay address.
     */
    /**
     * Back to the app's own machine list (the launcher), from a machine's page:
     * the same as the Back key, as a button people can see (第 2 步). Only a
     * machine this phone paired with may ask; it only changes what is shown.
     */
    @JavascriptInterface
    public boolean showMachines() {
        if (!fromMachinePage() || !(activity instanceof BridgeActivity)) return false;
        activity.runOnUiThread(() -> {
            com.getcapacitor.Bridge bridge = ((BridgeActivity) activity).getBridge();
            if (bridge == null || bridge.getWebView() == null || bridge.getLocalUrl() == null) return;
            bridge.getWebView().loadUrl(bridge.getLocalUrl());
        });
        return true;
    }

    /**
     * Open another machine from the app's own list (1.5.37): a machine's page
     * cannot reach one that only the relay reaches (only the app runs relay
     * forwarders), so it hands the switch to the launcher, which opens it the
     * way its list does - LAN, Tailscale, then the relay - and carries the login.
     */
    @JavascriptInterface
    public boolean openMachine(final String name) {
        if (!fromMachinePage() || !(activity instanceof BridgeActivity) || name == null) return false;
        final String clean = name.trim();
        if (clean.isEmpty() || clean.length() > 80) return false;
        activity.runOnUiThread(() -> {
            com.getcapacitor.Bridge bridge = ((BridgeActivity) activity).getBridge();
            if (bridge == null || bridge.getWebView() == null || bridge.getLocalUrl() == null) return;
            String base = bridge.getLocalUrl().replaceAll("/+$", "");
            bridge.getWebView().loadUrl(base + "/#open=" + Uri.encode(clean));
        });
        return true;
    }

    /**
     * The phone's own network, for choosing a machine's address (NetHints,
     * 1.5.39): the launcher, and a machine's page (its switcher would otherwise
     * wait out every dead address). Only whether Tailscale is on and this
     * phone's own subnets.
     */
    @JavascriptInterface
    public String networkHints() {
        if (!fromAppPage() && !fromMachinePage()) return "";
        return NetHints.json();
    }

    @JavascriptInterface
    public String relayLocal(final String host, final int port, final String id, final String fp) {
        if (!fromAppPage()) return "";
        return RelayLinks.localUrl(activity, host, port, id, fp);
    }

    /**
     * 直连 (1.5.46): does this phone reach the computer behind a relay
     * forwarder URL (or a computer's relay id) over the direct channel right
     * now? "direct" or "relay"; "" for anything else. Only the route, in words.
     */
    @JavascriptInterface
    public String relayRoute(final String urlOrId) {
        if ((!fromAppPage() && !fromMachinePage()) || urlOrId == null) return "";
        String v = urlOrId.trim();
        if (v.matches("^[a-z0-9]{16,40}$")) return RelayLinks.DIRECT.route(v);
        return RelayLinks.routeFor(activity, v);
    }

    /**
     * 1.5.48: one line for 关于 on a machine's page, so the road can be checked
     * without logcat - route, direct state, the last reason, the next try. No addresses.
     */
    @JavascriptInterface
    public String relayDebug(final String urlOrId) {
        if ((!fromAppPage() && !fromMachinePage()) || urlOrId == null) return "";
        String v = urlOrId.trim();
        if (v.matches("^[a-z0-9]{16,40}$")) return RelayLinks.DIRECT.debug(v);
        return RelayLinks.debugFor(activity, v);
    }

    @JavascriptInterface
    public void setImmersive(final boolean on) {
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, !on);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller == null) return;
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (on) controller.hide(WindowInsetsCompat.Type.systemBars());
            else controller.show(WindowInsetsCompat.Type.systemBars());
        });
    }

    @JavascriptInterface
    public void setOrientation(final String mode) {
        activity.runOnUiThread(() -> {
            int requested;
            if ("landscape".equals(mode)) requested = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            else if ("portrait".equals(mode)) requested = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            else requested = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            activity.setRequestedOrientation(requested);
        });
    }

    /*
     * The phone's clipboard. The hub page is plain http on the LAN, where
     * navigator.clipboard does not exist; ClipboardManager is the system's own
     * and carries any text (Chinese included). Read and written on the UI
     * thread: Android 10+ only lets the app in focus read it.
     */
    @JavascriptInterface
    public String clipboardRead() {
        if (!fromTrustedPage()) return "";
        FutureTask<String> task = new FutureTask<>(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(activity);
            return text == null ? "" : text.toString();
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "";
        }
    }

    /*
     * A sign-in page (a connected app's OAuth) in the phone's browser: the
     * app's page comes back to the machine's address, which the browser reaches
     * the same way this app does.
     */
    /**
     * 外观 and 语言 for every machine's page (1.3.2): each machine's address has
     * its own storage, so the app keeps them once. JSON {theme, lang}.
     */
    @JavascriptInterface
    public String viewPrefs() {
        return activity.getSharedPreferences("lamplit_view", Context.MODE_PRIVATE).getString("prefs", "{}");
    }

    @JavascriptInterface
    public void setViewPrefs(final String json) {
        try {
            org.json.JSONObject in = new org.json.JSONObject(json == null ? "{}" : json);
            org.json.JSONObject out = new org.json.JSONObject();
            String theme = in.optString("theme", "");
            String lang = in.optString("lang", "");
            if (theme.matches("dark|light|system")) out.put("theme", theme);
            if (lang.matches("zh|en|system")) out.put("lang", lang);
            activity.getSharedPreferences("lamplit_view", Context.MODE_PRIVATE).edit().putString("prefs", out.toString()).apply();
        } catch (Exception ignored) {
            // a malformed value is simply not saved
        }
    }

    /** 「让机器人用这部手机」 is on (the accessibility service is running) - 1.4.0. */
    @JavascriptInterface
    public boolean phoneAgentEnabled() {
        return PhoneAgentService.instance != null;
    }

    /**
     * Opens the system's accessibility settings, where the human turns
     * 「Lamplit：让机器人用这部手机」 on or off. Lamplit cannot turn it on itself.
     */
    @JavascriptInterface
    public boolean openAccessibilitySettings() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 1.5.17: is Lamplit free of battery optimisation (keeps running with the screen off)? */
    @JavascriptInterface
    public boolean batteryUnrestricted() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) activity.getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isIgnoringBatteryOptimizations(activity.getPackageName());
        } catch (Exception e) {
            return true;
        }
    }

    /** The system's own dialog: let Lamplit keep running (the human chooses Allow there). */
    @JavascriptInterface
    public boolean askBatteryUnrestricted() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            try {
                Intent list = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(list);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    /** App info, where OPPO, vivo, Xiaomi and others keep 「允许后台运行」 and 「自启动」. */
    @JavascriptInterface
    public boolean openAppDetails() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String manufacturer() {
        return android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER;
    }

    /** This app's own version (1.2.166: the page compares it with the latest release). */
    @JavascriptInterface
    public String appVersion() {
        try {
            String v = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean openExternal(final String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return false;
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
            } catch (Exception ignored) {
                // no browser: the page shows a link to copy
            }
        });
        return true;
    }

    @JavascriptInterface
    public boolean clipboardWrite(final String text) {
        if (!fromTrustedPage()) return false;
        FutureTask<Boolean> task = new FutureTask<>(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("Lamplit", text == null ? "" : text));
            return true;
        });
        activity.runOnUiThread(task);
        try {
            return task.get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return false;
        }
    }
}