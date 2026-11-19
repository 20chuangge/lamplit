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
const LOCAL_ONLY = new Set(['desk:open-file', 'desk:set-remote', 'desk:install-update', 'desk:firewall-status', 'desk:firewall-fix', 'desk:tailscale-netcheck']);

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
/** From the rules of this program and the networks it is on: does Windows let a phone on the LAN in? */
export function firewallVerdict({ block = [], allow = [], ours = false, networks = [] } = {}) {
  const list = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]).map(String);
  const nets = list(networks).filter((n) => /Public|Private|Domain/i.test(n));
  const covers = (profile, net) => /Any/i.test(profile) || profile.toLowerCase().includes(net.toLowerCase().replace('domainauthenticated', 'domain'));
  const want = nets.length ? nets : ['Public'];
  const blocked = list(block).some((p) => want.some((n) => covers(p, n)));
  const allowed = want.every((n) => list(allow).some((p) => covers(p, n)));
  return { blocked, allowed, ok: !blocked && allowed, ours: Boolean(ours), networks: nets };
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
