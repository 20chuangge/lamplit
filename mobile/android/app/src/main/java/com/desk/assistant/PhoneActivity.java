package com.desk.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the machines did with this phone (1.5.0), for 「我的手机」 in the app.
 *
 * A short list kept in the app's own storage: when, which machine, what kind
 * of step, whether it worked. Never what was typed and never a picture. The
 * same step from the same machine a moment later adds to the last line
 * (a bot looking ten times, or the computer's live view) instead of a new one.
 */
final class PhoneActivity {
    private static final String PREFS = "lamplit_phone";
    private static final String KEY = "activity";
    private static final int KEEP = 40;
    private static final long SAME_LINE_MS = 3 * 60 * 1000L;

    private PhoneActivity() {}

    /** Steps that are plumbing for another step are not worth a line. */
    private static boolean worthALine(String action) {
        return !("window".equals(action) || "size".equals(action) || "installed".equals(action));
    }

    static synchronized void record(Context context, String hub, String action, boolean watch, String pkg, boolean ok) {
        if (action == null || action.isEmpty() || !worthALine(action)) return;
        // A look is a look: the screen tree and the picture read the same to the human.
        String kind = watch ? "watch" : ("ui".equals(action) || "screenshot".equals(action)) ? "look" : action;
        try {
            SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray list = new JSONArray(p.getString(KEY, "[]"));
            long now = System.currentTimeMillis();
            JSONObject last = list.length() > 0 ? list.optJSONObject(0) : null;
            if (last != null && kind.equals(last.optString("kind")) && String.valueOf(hub).equals(last.optString("hub"))
                    && String.valueOf(pkg == null ? "" : pkg).equals(last.optString("pkg"))
                    && now - last.optLong("at") < SAME_LINE_MS) {
                last.put("at", now);
                last.put("count", last.optInt("count", 1) + 1);
                if (!ok) last.put("ok", false);
            } else {
                JSONObject row = new JSONObject();
                row.put("at", now);
                row.put("hub", hub == null ? "" : hub);
                row.put("kind", kind);
                row.put("pkg", pkg == null ? "" : pkg.replaceAll("[^A-Za-z0-9._]", "").substring(0, Math.min(80, pkg.replaceAll("[^A-Za-z0-9._]", "").length())));
                row.put("ok", ok);
                row.put("count", 1);
                JSONArray next = new JSONArray();
                next.put(row);
                for (int i = 0; i < list.length() && next.length() < KEEP; i++) next.put(list.get(i));
                list = next;
            }
            p.edit().putString(KEY, list.toString()).apply();
        } catch (Exception ignored) {
            // the log is a convenience: a bad entry never stops a step
        }
    }

    static String read(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]");
    }
}
