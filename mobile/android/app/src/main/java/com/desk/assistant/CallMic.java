package com.desk.assistant;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.util.Base64;

import java.io.ByteArrayOutputStream;

/**
 * The microphone for a call (1.5.22): it records without stopping.
 *
 * The first version stopped and restarted a MediaRecorder after every
 * sentence (hundreds of ms on a phone, the start of the next sentence lost)
 * and its loudness reading ran high, so a call felt slow. This keeps one
 * AudioRecord open (16 kHz mono, the phone's voice-call source with echo
 * cancellation), says how loud the last 100 ms were (the same peak measure
 * the page uses on a computer), and hands over what was said since the last
 * hand-over as a WAV file.
 */
final class CallMic {
    private static final int RATE = 16000;
    private static final int MAX_BYTES = RATE * 2 * 60; // one minute at most

    private AudioRecord rec;
    private Thread reader;
    private volatile boolean running;
    private final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
    private volatile double peak;
    private long peakAt;
    private AcousticEchoCanceler aec;
    private NoiseSuppressor ns;

    synchronized boolean start() {
        if (running) return true;
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
        } catch (SecurityException err) {
            return false;
        }
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) { rec.release(); rec = null; return false; }
        try { if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(rec.getAudioSessionId()); if (aec != null) aec.setEnabled(true); } } catch (Exception ignored) { }
        try { if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(rec.getAudioSessionId()); if (ns != null) ns.setEnabled(true); } } catch (Exception ignored) { }
        synchronized (pcm) { pcm.reset(); }
        running = true;
        rec.startRecording();
        reader = new Thread(this::read, "lamplit-call-mic");
        reader.start();
        return true;
    }

    private void read() {
        short[] frame = new short[RATE / 50]; // 20 ms
        byte[] bytes = new byte[frame.length * 2];
        while (running) {
            int n = rec.read(frame, 0, frame.length);
            if (n <= 0) continue;
            int top = 0;
            for (int i = 0; i < n; i++) {
                int v = Math.abs(frame[i]);
                if (v > top) top = v;
                bytes[2 * i] = (byte) (frame[i] & 0xff);
                bytes[2 * i + 1] = (byte) ((frame[i] >> 8) & 0xff);
            }
            long now = System.currentTimeMillis();
            double lv = top / 32768.0;
            if (now - peakAt > 100 || lv > peak) { peak = lv; peakAt = now; }
            synchronized (pcm) {
                if (pcm.size() < MAX_BYTES) pcm.write(bytes, 0, n * 2);
            }
        }
    }

    double level() {
        return System.currentTimeMillis() - peakAt > 300 ? 0 : peak;
    }

    /** What was said since the last hand-over, as a WAV file in base64 ("" when nothing). */
    String take() {
        byte[] data;
        synchronized (pcm) { data = pcm.toByteArray(); pcm.reset(); }
        if (data.length < RATE / 5) return "";
        return Base64.encodeToString(wav(data), Base64.NO_WRAP);
    }

    void discard() {
        synchronized (pcm) { pcm.reset(); }
    }

    synchronized void stop() {
        running = false;
        try { if (reader != null) reader.join(300); } catch (InterruptedException ignored) { }
        try { if (rec != null) { rec.stop(); rec.release(); } } catch (Exception ignored) { }
        try { if (aec != null) aec.release(); if (ns != null) ns.release(); } catch (Exception ignored) { }
        rec = null; aec = null; ns = null; reader = null;
        synchronized (pcm) { pcm.reset(); }
    }

    private static byte[] wav(byte[] pcmData) {
        int len = pcmData.length;
        byte[] out = new byte[44 + len];
        writeStr(out, 0, "RIFF"); writeInt(out, 4, 36 + len); writeStr(out, 8, "WAVE");
        writeStr(out, 12, "fmt "); writeInt(out, 16, 16); writeShort(out, 20, 1); writeShort(out, 22, 1);
        writeInt(out, 24, RATE); writeInt(out, 28, RATE * 2); writeShort(out, 32, 2); writeShort(out, 34, 16);
        writeStr(out, 36, "data"); writeInt(out, 40, len);
        System.arraycopy(pcmData, 0, out, 44, len);
        return out;
    }

    private static void writeStr(byte[] b, int at, String s) { for (int i = 0; i < 4; i++) b[at + i] = (byte) s.charAt(i); }
    private static void writeInt(byte[] b, int at, int v) { for (int i = 0; i < 4; i++) b[at + i] = (byte) ((v >> (8 * i)) & 0xff); }
    private static void writeShort(byte[] b, int at, int v) { b[at] = (byte) (v & 0xff); b[at + 1] = (byte) ((v >> 8) & 0xff); }
}
