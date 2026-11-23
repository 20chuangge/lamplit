package com.desk.assistant;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * PhoneRoutes.java on a desktop JDK (1.5.66): which machine a paired address
 * belongs to, and which way the phone takes to it. scripts/smoke-phonerelay-1566.mjs
 * compiles this with PhoneRoutes.java and runs it. Not part of the app.
 * Prints one line of JSON: each case's answer. Addresses are documentation ones.
 */
public final class PhoneRoutesCheck {

    private static final String PC_LAN = "http://192.168.1.5:4390";
    private static final String PC_RELAY = "http://127.0.0.1:14440";
    private static final String CLOUD_OLD_TS = "http://100.64.0.1:4390";
    private static final String CLOUD_NEW_TS = "http://100.64.0.2:4390";
    private static final String CLOUD_PUBLIC = "http://203.0.113.10:4390";
    private static final String CLOUD_RELAY = "http://127.0.0.1:14441";
    private static final String CLOUD_ID = "cloudid0123456789abcdef";
    private static final String PC_ID = "pcid0123456789abcdef00";

    /** A phone's network, made up: which addresses are on its Wi-Fi, whether Tailscale is on, which answer. */
    static final class FakeNet implements PhoneRoutes.Net {
        final Set<String> sameLan = new HashSet<>();
        final Set<String> answering = new HashSet<>();
        boolean tailscale = false;
        final List<String> probed = new ArrayList<>();

        FakeNet lan(String... urls) { sameLan.addAll(Arrays.asList(urls)); return this; }
        FakeNet up(String... urls) { answering.addAll(Arrays.asList(urls)); return this; }
        FakeNet tailscale(boolean on) { tailscale = on; return this; }

        @Override public boolean isRelay(String url) { return url.startsWith("http://127.0.0.1:144"); }
        @Override public boolean isLan(String url) { return url.matches("^https?://(10\\.\\d+|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+(:\\d+)?$"); }
        @Override public boolean isTailnet(String url) { return url.startsWith("http://100.64.") || url.contains(".ts.net"); }
        @Override public boolean sameLan(String url) { return sameLan.contains(url); }
        @Override public boolean mayReach(String url) {
            if (isTailnet(url)) return tailscale;
            if (isLan(url)) return sameLan.contains(url);
            return true;
        }
        @Override public boolean answers(String url) { probed.add(url); return answering.contains(url); }
    }

    private static List<PhoneRoutes.Machine> fleet() {
        List<PhoneRoutes.Machine> f = new ArrayList<>();
        f.add(new PhoneRoutes.Machine("书房电脑", PC_ID, Arrays.asList(PC_LAN, PC_RELAY)));
        f.add(new PhoneRoutes.Machine("腾讯云", CLOUD_ID, Arrays.asList(CLOUD_NEW_TS, CLOUD_PUBLIC, CLOUD_RELAY + "/")));
        return f;
    }

    private static String q(String s) {
        return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    public static void main(String[] args) {
        Map<String, String> out = new LinkedHashMap<>();
        List<PhoneRoutes.Machine> fleet = fleet();
        PhoneRoutes.Machine cloud = fleet.get(1);

        // --- which machine: by relay id, address, then name -------------------------------
        List<PhoneRoutes.Known> paired = new ArrayList<>();
        paired.add(new PhoneRoutes.Known(PC_LAN).name("书房电脑").address(PC_RELAY).relayId(PC_ID));
        paired.add(new PhoneRoutes.Known(CLOUD_OLD_TS + "/").name(" 腾讯云 "));
        out.put("staleByName", q(PhoneRoutes.match(cloud, paired, fleet)));

        List<PhoneRoutes.Known> byId = new ArrayList<>();
        byId.add(new PhoneRoutes.Known(CLOUD_OLD_TS).relayId(CLOUD_ID).name("另一个名字"));
        out.put("byRelayId", q(PhoneRoutes.match(cloud, byId, fleet)));

        List<PhoneRoutes.Known> byAddr = new ArrayList<>();
        byAddr.add(new PhoneRoutes.Known(CLOUD_OLD_TS).address(CLOUD_PUBLIC));
        out.put("byAddress", q(PhoneRoutes.match(cloud, byAddr, fleet)));

        List<PhoneRoutes.Machine> twoNamed = new ArrayList<>(fleet);
        twoNamed.add(new PhoneRoutes.Machine("腾讯云", "", Arrays.asList("http://203.0.113.11:4390")));
        out.put("nameTwiceInList", q(PhoneRoutes.match(cloud, paired, twoNamed)));

        List<PhoneRoutes.Known> otherId = new ArrayList<>();
        otherId.add(new PhoneRoutes.Known(CLOUD_OLD_TS).name("腾讯云").relayId("someothermachine0000"));
        out.put("nameButAnotherRelayId", q(PhoneRoutes.match(cloud, otherId, fleet)));

        PhoneRoutes.Known refused = new PhoneRoutes.Known(CLOUD_OLD_TS).name("腾讯云");
        refused.refusedByName = true;
        List<PhoneRoutes.Known> refusedList = new ArrayList<>();
        refusedList.add(refused);
        out.put("refusedByName", q(PhoneRoutes.match(cloud, refusedList, fleet)));

        List<PhoneRoutes.Known> labelOnly = new ArrayList<>();
        labelOnly.add(new PhoneRoutes.Known(CLOUD_OLD_TS).name("100.64.0.1:4390"));
        out.put("addressLabelIsNoName", q(PhoneRoutes.match(new PhoneRoutes.Machine("100.64.0.1:4390", "", Arrays.asList(CLOUD_NEW_TS)), labelOnly, fleet)));
        out.put("nameKeys", q(PhoneRoutes.nameKey("100.64.0.1:4390") + "|" + PhoneRoutes.nameKey("cafe") + "|" + PhoneRoutes.nameKey("pc.local:4390") + "|" + PhoneRoutes.nameKey(" Cloud ")));

        List<PhoneRoutes.Known> pcNamedLikeCloud = new ArrayList<>();
        pcNamedLikeCloud.add(new PhoneRoutes.Known(PC_LAN).name("腾讯云"));
        out.put("nameOnAnotherMachinesAddress", q(PhoneRoutes.match(cloud, pcNamedLikeCloud, fleet)));

        // --- which way ------------------------------------------------------------------
        FakeNet home = new FakeNet().lan(PC_LAN).up(PC_LAN, PC_RELAY);
        out.put("homeWay", q(PhoneRoutes.pick(PC_LAN, Arrays.asList(PC_RELAY), home)));
        out.put("homeProbes", q(String.join(",", home.probed)));

        FakeNet homeNoRelay = new FakeNet().lan(PC_LAN).up(PC_LAN);
        out.put("homeNoRelayWay", q(PhoneRoutes.pick(PC_LAN, new ArrayList<>(), homeNoRelay)));
        out.put("homeNoRelayProbes", String.valueOf(homeNoRelay.probed.size()));

        FakeNet away = new FakeNet().tailscale(false).up(CLOUD_RELAY);
        out.put("awayWay", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_NEW_TS, CLOUD_PUBLIC, CLOUD_RELAY), away)));
        out.put("awayProbes", q(String.join(",", away.probed)));

        FakeNet relayDownNow = new FakeNet().tailscale(false);
        out.put("relayDownWay", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_RELAY), relayDownNow)));

        FakeNet tsOn = new FakeNet().tailscale(true).up(CLOUD_NEW_TS, CLOUD_RELAY);
        out.put("newTailnetWay", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_NEW_TS, CLOUD_RELAY), tsOn)));

        FakeNet tsOnNothing = new FakeNet().tailscale(true);
        out.put("tailscaleOnNothingAnswers", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_RELAY), tsOnNothing)));

        FakeNet sameWifi = new FakeNet().lan("http://192.168.1.9:4390").up("http://192.168.1.9:4390", CLOUD_RELAY);
        out.put("sameWifiWay", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_RELAY, "http://192.168.1.9:4390"), sameWifi)));

        FakeNet otherWifi = new FakeNet().up(CLOUD_RELAY);
        out.put("otherWifiLanSkipped", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList("http://192.168.1.9:4390", CLOUD_RELAY), otherWifi) + "|" + String.join(",", otherWifi.probed)));

        FakeNet pairedRelay = new FakeNet();
        out.put("pairedAtRelay", q(PhoneRoutes.pick(CLOUD_RELAY, Arrays.asList(CLOUD_OLD_TS), pairedRelay) + "|" + pairedRelay.probed.size()));

        FakeNet publicOnly = new FakeNet().up(CLOUD_PUBLIC);
        out.put("publicNotUsed", q(PhoneRoutes.pick(CLOUD_OLD_TS, Arrays.asList(CLOUD_PUBLIC), publicOnly) + "|" + publicOnly.probed.size()));

        StringBuilder json = new StringBuilder("{");
        for (Map.Entry<String, String> e : out.entrySet()) {
            if (json.length() > 1) json.append(',');
            json.append(q(e.getKey())).append(':').append(e.getValue());
        }
        System.out.println(json.append('}'));
    }
}
