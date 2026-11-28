/**
 * guard.mjs - who may use the desktop app's bridge (SEC-09), and which files
 * "open" must not run (SEC-17). Pure functions, so the smoke test can check them.
 *
 * The window shows this computer's hub or a machine the human added. Any page
 * in it gets `window.desk`; what a call may do depends on whose page it is:
 *   local - this computer's own hub page
 *   known - a machine in the list (by its LAN or Tailscale address)
 *   other - anything else (never expected; refused)
 */

/** 'local' | 'known' | 'other' for the page that sent a bridge call. */
export function senderKind(url, { localOrigin = '', machineOrigins = [] } = {}) {
  let origin = '';
  try {
    origin = new URL(String(url || '')).origin;
  } catch {
    return 'other';
  }
  if (origin === 'null' || !origin) return 'other';
  const same = (o) => {
    try { return Boolean(o) && new URL(o).origin === origin; } catch { return false; }
  };
  if (same(localOrigin)) return 'local';
  if (machineOrigins.some(same)) return 'known';
  return 'other';
}

/**
 * Channels only this computer's page may use: they act on this computer
 * (open its files, open it to the network). Everything else the page uses is
 * fine from any added machine's page too (the clipboard, adding a machine -
 * which always runs from here - switching, notifications, voice).
 */
// The backup dialogs too (1.5.54): the path they give is one on this computer, for this computer's hub.
const LOCAL_ONLY = new Set(['desk:open-file', 'desk:set-remote', 'desk:install-update', 'desk:firewall-status', 'desk:firewall-fix', 'desk:tailscale-netcheck', 'desk:pick-backup-save', 'desk:pick-backup-open', 'desk:pick-folder']);

export function mayUse(channel, kind) {
  if (kind === 'local') return true;
  if (kind === 'known') return !LOCAL_ONLY.has(String(channel));
  return false;
}

/** Files that run something when opened: show them in their folder instead. */
const PROGRAM_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.lnk', '.scr', '.hta', '.reg', '.pif', '.cpl', '.msc', '.jar', '.appref-ms', '.url', '.application']);

export function isProgramFile(name) {
  const m = /\.[^./\\]+$/.exec(String(name || '').toLowerCase());
  return Boolean(m) && PROGRAM_EXTENSIONS.has(m[0]);
}

/** Windows Firewall (1.5.29) - see firewallStatus in main.mjs. */
/**
 * From the rules of this program and the networks it is on: does Windows let
 * a phone on the LAN in (TCP), and a direct connection (UDP, 1.5.49)?
 * Input: {rules:[{action, profile, protocol, name}], ours, networks}; the
 * older {block:[profiles], allow:[profiles]} (TCP only) still reads.
 * A Block rule beats any Allow on the same network (Windows' order).
 */
export function firewallVerdict({ rules, block = [], allow = [], ours = false, networks = [] } = {}) {
  const list = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]).map(String);
  const nets = list(networks).filter((n) => /Public|Private|Domain/i.test(n));
  const covers = (profile, net) => /Any/i.test(profile) || profile.toLowerCase().includes(net.toLowerCase().replace('domainauthenticated', 'domain'));
  const want = nets.length ? nets : ['Public'];
  const legacy = !Array.isArray(rules);
  const all = legacy
    ? [...list(block).map((profile) => ({ action: 'Block', profile, protocol: 'TCP' })), ...list(allow).map((profile) => ({ action: 'Allow', profile, protocol: 'TCP' }))]
    : rules.map((r) => ({ action: String(r?.action || ''), profile: String(r?.profile || ''), protocol: String(r?.protocol || 'Any'), name: String(r?.name || '') }));
  const forProto = (proto) => all.filter((r) => /^any$/i.test(r.protocol) || r.protocol.toUpperCase() === proto);
  const judge = (proto) => {
    const mine = forProto(proto);
    const blocked = mine.some((r) => r.action === 'Block' && want.some((n) => covers(r.profile, n)));
    const allowed = want.every((n) => mine.some((r) => r.action === 'Allow' && covers(r.profile, n)));
    return { blocked, allowed, ok: !blocked && allowed, known: true };
  };
  const tcp = judge('TCP');
  const udp = legacy ? { blocked: false, allowed: false, ok: false, known: false } : judge('UDP');
  const words = { public: '公用网络', private: '专用网络', domain: '域网络', any: '所有网络' };
  const where = (p) => p.split(/[,\s]+/).filter(Boolean).map((x) => words[x.toLowerCase()] || x).join('、');
  // Block rules of this program on a network it is on: the fix removes them (often from an old app name).
  const staleBlocks = legacy ? [] : all.filter((r) => r.action === 'Block' && want.some((n) => covers(r.profile, n)))
    .map((r) => `${r.name || '（没有名字）'}（${/^any$/i.test(r.protocol) ? 'TCP 和 UDP' : r.protocol.toUpperCase()}，${where(r.profile)}）`);
  return { ...tcp, tcp, udp, staleBlocks, ours: Boolean(ours), networks: nets };
}

/**
 * What the one-click fix will change (1.5.49), in words, shown before the
 * UAC prompt: [] when nothing is needed. Mirrors firewallFix in main.mjs.
 */
export function firewallPlan(verdict) {
  if (!verdict || (verdict.ok && verdict.udp?.ok && !(verdict.staleBlocks || []).length)) return [];
  const out = (verdict.staleBlocks || []).map((name) => `删掉挡住 Lamplit 的规则「${name}」`);
  out.push('添加（或更新）一条：允许 Lamplit 从局域网和 Tailscale 接收 TCP（手机在家连这台电脑）');
  out.push('添加（或更新）一条：允许 Lamplit 接收 UDP（直连用，所有网络；只认配对设备的加密包）');
  return out;
}

/** `tailscale netcheck` output -> the relay regions and their distance (1.5.29). */
export function parseNetcheck(text) {
  const regions = [];
  for (const m of String(text || '').matchAll(/^\s*-\s*([a-z0-9-]+):\s*([\d.]+)\s*ms\s*\(([^)]*)\)/gim)) {
    regions.push({ code: m[1], ms: Math.round(Number(m[2])), name: m[3] });
  }
  const nearest = /Nearest DERP:\s*(.+)/i.exec(String(text || ''))?.[1]?.trim() || '';
  return { regions, nearest };
}

/**
 * The address to name when asking this computer's hub to push an update to a
 * machine (1.5.41). The hub sends packages only to an address in its list
 * (ENG-08); away from home the app reaches a machine through a relay door
 * (127.0.0.N), which is not in the list and was refused (1.5.38-1.5.40). So:
 * the address it reached, when that is the machine's own or Tailscale address;
 * otherwise the machine's own address, and the hub goes through the relay itself.
 */
export function pushUpdateAddress(machine, reached) {
  const origin = (u) => { try { return new URL(String(u || '')).origin.toLowerCase(); } catch { return ''; } };
  const at = origin(reached);
  const listed = [machine?.url, machine?.tailnetUrl].some((u) => u && origin(u) === at);
  return at && listed ? reached : String(machine?.url || '');
}

/**
 * The login cookie a hub sets for a browser at this address (1.5.63, src/auth.mjs
 * sessionCookieName): cookies are kept per host, not per port, so two Lamplits
 * on one computer each name theirs after the port ("desk_session_14390"); an
 * address with no port keeps the plain name.
 */
export const LEGACY_LOGIN_COOKIE = 'desk_session';
export function loginCookieName(url) {
  let port = '';
  try { port = new URL(String(url || '')).port; } catch { /* not an address */ }
  return port ? `${LEGACY_LOGIN_COOKIE}_${port}` : LEGACY_LOGIN_COOKIE;
}

/** The names a login for this address may be under, its own first: hubs before 1.5.63 set the plain one. */
export function loginCookieNames(url) {
  const own = loginCookieName(url);
  return own === LEGACY_LOGIN_COOKIE ? [own] : [own, LEGACY_LOGIN_COOKIE];
}

/** Is this cookie some hub's login (any port)? A relay one (12 characters of the machine's id) is not. */
export function isLoginCookieName(name) {
  return /^desk_session(?:_\d{1,5})?$/.test(String(name || ''));
}

/**
 * A machine's own address that is plain http to a public IPv4 (1.5.78): what goes there crosses the internet
 * in the clear, so its Tailscale address and the relay are tried first.
 */
export function openInternetAddress(url) {
  const m = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:\/|$)/.exec(String(url || ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** The login in a POST /api/pair answer's Set-Cookie (either name): {name, value} or null. */
export function loginFromSetCookie(header) {
  const m = /(?:^|[\s,;])(desk_session(?:_\d{1,5})?)=([^;,\s]+)/.exec(String(header || ''));
  if (!m) return null;
  let value = m[2];
  try { value = decodeURIComponent(value); } catch { /* as it is */ }
  return { name: m[1], value };
}

/**
 * How one login cookie is copied from one address of a machine to another
 * (its Tailscale address, or a relay door named `rename`): the new name, or ''
 * to leave it (another Lamplit's login on the same host).
 */
export function copiedLoginName(cookieName, from, to, rename = '', chosen = '') {
  if (!isLoginCookieName(cookieName)) return cookieName;
  if (!loginCookieNames(from).includes(cookieName)) return '';
  if (rename) return cookieName === chosen ? rename : '';
  return cookieName === LEGACY_LOGIN_COOKIE ? LEGACY_LOGIN_COOKIE : loginCookieName(to);
}
