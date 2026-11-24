package com.desk.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.Enumeration;

/**
 * Which of a machine's addresses this phone can use right now (1.5.39).
 *
 * A machine has a LAN address, maybe a Tailscale one, maybe a relay one. Away
 * from home with Tailscale off, trying the first two only meant waiting for
 * them to time out (seen: 5-10 s per switch on a hotspot) before the relay
 * was used. So:
 *   - a Tailscale address (100.64.0.0/10, *.ts.net over http) only while this
 *     phone itself has a Tailscale address (Tailscale's VPN is on);
 *   - a LAN address (10/8, 172.16/12, 192.168/16) only when it is on the same
 *     subnet as one of this phone's own addresses (the same Wi-Fi);
 *   - anything else (the relay forwarder, a public address) always.
 */
final class NetHints {

    private NetHints() {}

    private static boolean isTailnetIp(byte[] a) {
        return a.length == 4 && (a[0] & 0xff) == 100 && (a[1] & 0xc0) == 64;
    }

    private static boolean isPrivateHost(String host) {
        return host != null && host.matches("^(10\\.\\d+|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+$");
    }

    private static boolean isTailnetHost(String host) {
        if (host == null) return false;
        if (host.toLowerCase().endsWith(".ts.net")) return true;
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            return a == 100 && b >= 64 && b <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** Is `url` a Tailscale address (100.64/10 or *.ts.net)? */
    static boolean isTailnetUrl(String url) {
        try {
            return isTailnetHost(new URL(url).getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /** Is Tailscale's VPN on on this phone (it holds a 100.64/10 address)? */
    static boolean tailscaleUp() {
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements()) {
                NetworkInterface nif = all.nextElement();
                if (!nif.isUp()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress addr = ia.getAddress();
                    if (addr instanceof Inet4Address && isTailnetIp(addr.getAddress())) return true;
                }
            }
        } catch (Exception ignored) {
            // unknown: say yes, so nothing is skipped
            return true;
        }
        return false;
    }

    /** Is this private IPv4 host on the same subnet as one of this phone's own addresses? */
    static boolean onSameLan(String host) {
        try {
            byte[] target = InetAddress.getByName(host).getAddress();
            if (target.length != 4) return true;
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements()) {
                NetworkInterface nif = all.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress addr = ia.getAddress();
                    if (!(addr instanceof Inet4Address) || isTailnetIp(addr.getAddress())) continue;
                    int bits = Math.max(8, Math.min(32, ia.getNetworkPrefixLength()));
                    int mask = bits == 32 ? -1 : ~((1 << (32 - bits)) - 1);
                    if ((toInt(addr.getAddress()) & mask) == (toInt(target) & mask)) return true;
                }
            }
        } catch (Exception ignored) {
            return true;
        }
        return false;
    }

    private static int toInt(byte[] a) {
        return ((a[0] & 0xff) << 24) | ((a[1] & 0xff) << 16) | ((a[2] & 0xff) << 8) | (a[3] & 0xff);
    }

    /** May this phone reach `url` right now, as far as its own network can tell? */
    static boolean mayReach(String url) {
        String host;
        boolean https;
        try {
            URL u = new URL(url);
            host = u.getHost();
            https = "https".equalsIgnoreCase(u.getProtocol());
        } catch (Exception e) {
            return true;
        }
        if (isTailnetHost(host) && !(https && host.toLowerCase().endsWith(".ts.net"))) return tailscaleUp();
        if (isPrivateHost(host)) return onSameLan(host);
        return true;
    }

    /** For the launcher: {"tailscale":bool, "lan":["192.168.1.3/24", …]}. */
    static String json() {
        JSONObject out = new JSONObject();
        JSONArray lan = new JSONArray();
        try {
            out.put("tailscale", tailscaleUp());
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            while (all != null && all.hasMoreElements()) {
                NetworkInterface nif = all.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress addr = ia.getAddress();
                    if (!(addr instanceof Inet4Address) || isTailnetIp(addr.getAddress())) continue;
                    lan.put(addr.getHostAddress() + "/" + ia.getNetworkPrefixLength());
                }
            }
            out.put("lan", lan);
        } catch (Exception ignored) {
            return "";
        }
        return out.toString();
    }
}
