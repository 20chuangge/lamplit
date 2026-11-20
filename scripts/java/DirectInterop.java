package com.desk.assistant;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SNIServerName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * The phone's direct channel (DirectChannel.java) against the computer's
 * (src/direct.mjs), on one desktop with a JDK: scripts/direct-interop.mjs
 * compiles this with DirectChannel.java and runs it. Not part of the app.
 *
 *   java com.desk.assistant.DirectInterop <relayPort> <offerUrl> <fp> <id> <dropRate>
 * Prints one line of JSON: what worked.
 */
public final class DirectInterop {

    private static final Charset UTF8 = Charset.forName("UTF-8");

    public static void main(String[] args) throws Exception {
        int relayPort = Integer.parseInt(args[0]);
        final String offerUrl = args[1];
        final String fp = args[2];
        final String id = args[3];
        DirectChannel.Options o = new DirectChannel.Options();
        o.allowLoopback = true;
        o.hostCandidates = false;
        o.punchMs = 4000;
        o.dropRate = Double.parseDouble(args[4]);
        DirectChannel.Links links = new DirectChannel.Links(o);
        DirectChannel.Offerer offerer = body -> post(offerUrl, body);
        links.kick(id, "127.0.0.1", relayPort, offerer);
        long until = System.currentTimeMillis() + 8000;
        while (links.muxFor(id) == null && System.currentTimeMillis() < until) Thread.sleep(20);
        StringBuilder out = new StringBuilder("{");
        out.append("\"route\":\"").append(links.route(id)).append("\"");
        out.append(",\"reason\":\"").append(String.valueOf(links.link(id).reason).replace("\"", "'")).append("\"");
        DirectChannel.Mux mux = links.muxFor(id);
        if (mux != null) {
            // Like RelayLinks.serve: a plain socket over the channel, TLS pinned to the computer on top.
            byte[] big = request(mux, fp, id, "GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", null);
            out.append(",\"bigHash\":\"").append(sha(body(big))).append("\"");
            byte[] payload = new byte[1024 * 1024 + 7];
            for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i * 31 + 7);
            byte[] up = request(mux, fp, id, "POST /hash HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: " + payload.length + "\r\n\r\n", payload);
            out.append(",\"upHash\":\"").append(new String(body(up), UTF8).trim()).append("\"");
            out.append(",\"sentHash\":\"").append(sha(payload)).append("\"");
            String wrong = "ok";
            try {
                request(mux, "b".repeat(64), id, "GET /big HTTP/1.1\r\nHost: x\r\n\r\n", null);
            } catch (Exception e) {
                wrong = "refused";
            }
            out.append(",\"wrongFp\":\"").append(wrong).append("\"");
            // Several at once (a page loads a handful of files together).
            final String[] hashes = new String[4];
            Thread[] ts = new Thread[4];
            for (int i = 0; i < 4; i++) {
                final int k = i;
                ts[i] = new Thread(() -> {
                    try {
                        hashes[k] = sha(body(request(mux, fp, id, "GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", null)));
                    } catch (Exception e) {
                        hashes[k] = "error " + e.getMessage();
                    }
                });
                ts[i].start();
            }
            for (Thread t : ts) t.join();
            out.append(",\"parallel\":[");
            for (int i = 0; i < 4; i++) out.append(i > 0 ? "," : "").append("\"").append(hashes[i]).append("\"");
            out.append("]");
            links.reset();
            out.append(",\"afterReset\":\"").append(links.route(id)).append("\"");
        }
        out.append("}");
        System.out.println(out);
        System.exit(0);
    }

    static String post(String url, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        c.getOutputStream().write(body.getBytes(UTF8));
        if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
        return new String(readAll(c.getInputStream()), UTF8);
    }

    static byte[] request(DirectChannel.Mux mux, String fp, String id, String head, byte[] payload) throws Exception {
        Socket plain = mux.openSocket();
        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(null, new TrustManager[] { new Pinned(fp) }, null);
        SSLSocket s = (SSLSocket) ssl.getSocketFactory().createSocket(plain, "127.0.0.1", 0, true);
        SSLParameters p = s.getSSLParameters();
        java.util.List<SNIServerName> names = new java.util.ArrayList<>();
        names.add(new SNIHostName(id + ".relay.lamplit"));
        p.setServerNames(names);
        s.setSSLParameters(p);
        s.setSoTimeout(15000);
        s.startHandshake();
        OutputStream out = s.getOutputStream();
        out.write(head.getBytes(UTF8));
        if (payload != null) out.write(payload);
        out.flush();
        byte[] all = readAll(s.getInputStream());
        s.close();
        return all;
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[32768];
        int n;
        while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
        return b.toByteArray();
    }

    static byte[] body(byte[] response) {
        for (int i = 0; i + 3 < response.length; i++) {
            if (response[i] == '\r' && response[i + 1] == '\n' && response[i + 2] == '\r' && response[i + 3] == '\n') {
                return java.util.Arrays.copyOfRange(response, i + 4, response.length);
            }
        }
        return new byte[0];
    }

    static String sha(byte[] b) throws Exception {
        return DirectChannel.hex(MessageDigest.getInstance("SHA-256").digest(b));
    }

    static final class Pinned implements X509TrustManager {
        final String fp;

        Pinned(String fp) {
            this.fp = fp;
        }

        public void checkClientTrusted(X509Certificate[] c, String a) throws CertificateException {
            throw new CertificateException("not a server");
        }

        public void checkServerTrusted(X509Certificate[] chain, String a) throws CertificateException {
            try {
                String got = DirectChannel.hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                if (!got.equals(fp)) throw new CertificateException("not the computer");
            } catch (CertificateException e) {
                throw e;
            } catch (Exception e) {
                throw new CertificateException(e.getMessage());
            }
        }

        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
