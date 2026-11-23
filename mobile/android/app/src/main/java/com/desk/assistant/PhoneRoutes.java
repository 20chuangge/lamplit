package com.desk.assistant;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Which machine a paired address belongs to, and which of its addresses to use
 * now (1.5.66).
 *
 * Seen 11-23: the phone was paired with the cloud machine at a Tailscale
 * address the machine no longer had, Tailscale was off on the phone, and the
 * phone tried that one address every minute for hours. The PC's machine list
 * had the cloud's new Tailscale address and its relay, but the phone looked
 * machines up by address only, so it never learned that this was the same
 * machine. Now a machine is matched by what stays the same: its relay id
 * (its own, never shared), then any address in common, then its name.
 *
 * Plain Java, no Android classes: scripts/java/PhoneRoutesCheck.java runs it
 * on a desktop JDK (smoke stage 1.5.66).
 */
final class PhoneRoutes {

    private PhoneRoutes() {}

    /** One machine as a hub's /api/machines lists it. */
    static final class Machine {
        final String name;
        final String relayId;
        /** Its url, tailnetUrl and (when it has a relay) this phone's forwarder for it. */
        final List<String> addresses;

        Machine(String name, String relayId, Collection<String> addresses) {
            this.name = name == null ? "" : name.trim();
            this.relayId = relayId == null ? "" : relayId.trim();
            this.addresses = new ArrayList<>();
            if (addresses != null) for (String a : addresses) {
                String c = clean(a);
                if (!c.isEmpty() && !this.addresses.contains(c)) this.addresses.add(c);
            }
        }
    }

    /** What this phone knows about one machine it holds a login (device token) for. */
    static final class Known {
        final String hub;
        final Set<String> addresses = new LinkedHashSet<>();
        final Set<String> names = new LinkedHashSet<>();
        final Set<String> relayIds = new LinkedHashSet<>();
        /** Its token was refused at an address learned by name: do not match it by name again. */
        boolean refusedByName = false;

        Known(String hub) {
            this.hub = clean(hub);
            this.addresses.add(this.hub);
        }

        Known address(String url) {
            String c = clean(url);
            if (!c.isEmpty()) addresses.add(c);
            return this;
        }

        Known name(String name) {
            String k = nameKey(name);
            if (!k.isEmpty()) names.add(k);
            return this;
        }

        Known relayId(String id) {
            if (id != null && !id.trim().isEmpty()) relayIds.add(id.trim());
            return this;
        }
    }

    static String clean(String url) {
        return url == null ? "" : url.trim().replaceAll("/+$", "");
    }

    /**
     * A name to compare by: trimmed, lower case. A row the app named after its
     * address ("100.64.0.1:4390") is not a name.
     */
    static String nameKey(String name) {
        String k = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
        if (k.matches("^\\d+(\\.\\d+){3}(:\\d+)?$") || k.matches("^\\[[0-9a-f:]+\\](:\\d+)?$") || k.matches("^[a-z0-9.-]+:\\d+$")) return "";
        return k;
    }

    private static boolean shares(Known k, Machine m) {
        for (String a : m.addresses) if (k.addresses.contains(a)) return true;
        return false;
    }

    /**
     * The paired hub that is machine `m` of `fleet` (the whole list it came in,
     * the answering machine too), or null.
     *   1. the same relay id;
     *   2. an address in common;
     *   3. the same name - only when no other machine in the list has that
     *      name, the hub is not another machine of the list by id or address,
     *      and the hub is not known by another relay id.
     */
    static String match(Machine m, List<Known> paired, List<Machine> fleet) {
        if (m == null || paired == null) return null;
        if (!m.relayId.isEmpty()) {
            for (Known k : paired) if (k.relayIds.contains(m.relayId)) return k.hub;
        }
        for (Known k : paired) if (shares(k, m)) return k.hub;
        String key = nameKey(m.name);
        if (key.isEmpty()) return null;
        int same = 0;
        if (fleet != null) for (Machine other : fleet) if (key.equals(nameKey(other.name))) same += 1;
        if (same > 1) return null;
        for (Known k : paired) {
            if (k.refusedByName || !k.names.contains(key)) continue;
            if (!k.relayIds.isEmpty() && (m.relayId.isEmpty() || !k.relayIds.contains(m.relayId))) continue;
            boolean another = false;
            if (fleet != null) for (Machine other : fleet) {
                if (other == m) continue;
                if ((!other.relayId.isEmpty() && k.relayIds.contains(other.relayId)) || shares(k, other)) {
                    another = true;
                    break;
                }
            }
            if (!another) return k.hub;
        }
        return null;
    }

    /** What the phone's network says about an address, and whether it answers. */
    interface Net {
        /** 127.0.0.1:14440-14499: this app's relay forwarder. */
        boolean isRelay(String url);
        /** 10/8, 172.16/12, 192.168/16. */
        boolean isLan(String url);
        /** 100.64/10 or *.ts.net. */
        boolean isTailnet(String url);
        /** A LAN address on this phone's own Wi-Fi subnet. */
        boolean sameLan(String url);
        /** NetHints.mayReach: Tailscale on for a tailnet address, the same Wi-Fi for a LAN one. */
        boolean mayReach(String url);
        boolean answers(String url);
    }

    /**
     * Where to reach the machine paired at `hub` now, given its other addresses.
     * The order stays (1.5.29 / 1.5.39): the same Wi-Fi, then the machine's own
     * address (or a newer Tailscale address of it) when this phone can use it,
     * then the relay.
     *
     * New (1.5.66): when nothing answers and the paired address is one this
     * phone cannot use now (Tailscale off, another Wi-Fi), the relay stays the
     * way - it comes back by itself (a machine restarting reconnects to it) -
     * instead of the dead address being tried every minute.
     */
    static String pick(String hub, List<String> others, Net net) {
        hub = clean(hub);
        List<String> rest = new ArrayList<>();
        if (others != null) for (String o : others) {
            String c = clean(o);
            if (!c.isEmpty() && !c.equals(hub) && !rest.contains(c)) rest.add(c);
        }
        // Paired through the relay: that is its way (it goes direct by itself, DirectChannel).
        if (net.isRelay(hub)) return hub;
        if (!net.isLan(hub)) {
            for (String o : rest) if (net.isLan(o) && net.sameLan(o) && net.answers(o)) return o;
        }
        List<String> direct = new ArrayList<>();
        direct.add(hub);
        for (String o : rest) if (net.isTailnet(o)) direct.add(o);
        List<String> relays = new ArrayList<>();
        for (String o : rest) if (net.isRelay(o)) relays.add(o);
        // Nothing else known: the paired address, untested (no probe at home).
        if (relays.isEmpty() && direct.size() == 1) return hub;
        for (String d : direct) if (net.mayReach(d) && net.answers(d)) return d;
        for (String r : relays) if (net.answers(r)) return r;
        if (!relays.isEmpty() && !net.mayReach(hub)) return relays.get(0);
        return hub;
    }
}
