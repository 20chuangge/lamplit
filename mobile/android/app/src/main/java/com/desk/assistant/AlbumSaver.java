package com.desk.assistant;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;

/**
 * Workspace files into this phone's album (1.5.65).
 *
 * A bot on a paired machine needs pictures or a video on this phone (to post
 * them from an app here). The machine sends one save_media step with a list
 * of files, each at a one-time address on that machine (/api/phone/files/:token,
 * only for this phone, only while the step runs). The files are fetched over
 * the same paired connection as every other step - never from anywhere else -
 * and saved through MediaStore: pictures and videos in DCIM/Lamplit, other
 * files in Download/Lamplit. No storage permission is needed (Android 10+).
 *
 * Order: the list's first file must end up the newest, so 「从相册选择」 shows
 * it first. They are saved last file first, each started in a later second
 * than the one before (galleries sort by the second).
 */
final class AlbumSaver {

    static final long MAX_BYTES = 200L * 1024 * 1024;
    static final int MAX_FILES = 50;
    private static final String FILES_PATH = "/api/phone/files/";

    /** Opens the connection for one file's address on the machine (with this phone's token). */
    interface Fetch {
        HttpURLConnection open(String path) throws Exception;
    }

    private AlbumSaver() {
    }

    static JSONObject save(Context context, JSONArray files, Fetch fetch) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new PhoneAgentService.StepError("PHONE_ANDROID_TOO_OLD",
                    "saving files into the album without the cable needs Android 10 or newer: plug the phone into a computer with Lamplit and USB debugging on instead");
        }
        if (files == null || files.length() == 0) throw new PhoneAgentService.StepError("PHONE_BAD_ARGS", "no files to save");
        if (files.length() > MAX_FILES) throw new PhoneAgentService.StepError("PHONE_TOO_MANY_FILES", "at most " + MAX_FILES + " files at a time");
        long total = 0;
        for (int i = 0; i < files.length(); i += 1) {
            JSONObject f = files.optJSONObject(i);
            total += f == null ? 0 : Math.max(0, f.optLong("size", 0));
        }
        if (total > MAX_BYTES) throw new PhoneAgentService.StepError("PHONE_FILES_TOO_LARGE", "at most 200 MB at a time");

        JSONArray failed = new JSONArray();
        int saved = 0;
        long lastSecond = 0;
        String firstWhy = "";
        for (int i = files.length() - 1; i >= 0; i -= 1) {
            JSONObject f = files.optJSONObject(i);
            int order = f == null ? i : f.optInt("order", i);
            try {
                if (f == null) throw new IllegalArgumentException("not a file");
                lastSecond = saveOne(context, f, fetch, lastSecond);
                saved += 1;
            } catch (Exception err) {
                String why = String.valueOf(err.getMessage());
                if (firstWhy.isEmpty()) firstWhy = why;
                failed.put(new JSONObject().put("order", order).put("why", why));
            }
        }
        if (saved == 0) throw new PhoneAgentService.StepError("PHONE_FAILED", "no file was saved on the phone: " + firstWhy);
        return new JSONObject().put("saved", saved).put("failed", failed);
    }

    /** A name the phone takes: no folders, no control characters. */
    static String cleanName(String raw) {
        String name = String.valueOf(raw == null ? "" : raw).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.startsWith(".")) name = "_" + name.substring(1);
        if (name.length() > 100) name = name.substring(name.length() - 100);
        return name.isEmpty() ? "file" : name;
    }

    /** Saves one file; -> the second (wall clock) it was finished in. */
    @TargetApi(Build.VERSION_CODES.Q)
    private static long saveOne(Context context, JSONObject f, Fetch fetch, long lastSecond) throws Exception {
        String path = f.optString("url", "");
        if (!path.startsWith(FILES_PATH) || !path.substring(FILES_PATH.length()).matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("not a file of the machine");
        }
        String kind = f.optString("kind", "file");
        String mime = f.optString("mime", "application/octet-stream");
        // The collection must match the type: anything else goes to Downloads.
        if ("image".equals(kind) && !mime.startsWith("image/")) kind = "file";
        if ("video".equals(kind) && !mime.startsWith("video/")) kind = "file";
        long size = f.optLong("size", -1);

        // Started in a later second than the file before: then its time is newer.
        long now = System.currentTimeMillis();
        if (now / 1000 <= lastSecond) Thread.sleep((lastSecond + 1) * 1000 - now + 30);

        Uri collection;
        String folder;
        if ("image".equals(kind)) {
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            folder = Environment.DIRECTORY_DCIM + "/Lamplit";
        } else if ("video".equals(kind)) {
            collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            folder = Environment.DIRECTORY_DCIM + "/Lamplit";
        } else {
            collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            folder = Environment.DIRECTORY_DOWNLOADS + "/Lamplit";
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName(f.optString("name", "file")));
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        if (!"file".equals(kind)) values.put(MediaStore.MediaColumns.DATE_TAKEN, System.currentTimeMillis());

        ContentResolver resolver = context.getContentResolver();
        Uri item = resolver.insert(collection, values);
        if (item == null) throw new IllegalStateException("the phone did not make the file");
        boolean done = false;
        HttpURLConnection conn = null;
        try {
            conn = fetch.open(path);
            int status = conn.getResponseCode();
            if (status != 200) throw new IllegalStateException("the machine answered HTTP " + status);
            long got = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IllegalStateException("the phone did not open the file");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    got += read;
                    if (got > MAX_BYTES || (size >= 0 && got > size)) throw new IllegalStateException("the file is bigger than the machine said");
                    out.write(buffer, 0, read);
                }
            }
            if (size >= 0 && got != size) throw new IllegalStateException("the file came incomplete");
            ContentValues finished = new ContentValues();
            finished.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, finished, null, null);
            done = true;
            return System.currentTimeMillis() / 1000;
        } finally {
            if (conn != null) conn.disconnect();
            if (!done) {
                try {
                    resolver.delete(item, null, null);
                } catch (Exception ignored) {
                    // a half file the system cleans up (pending files expire)
                }
            }
        }
    }
}
