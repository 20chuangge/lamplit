/**
 * updates.mjs - is there a newer Lamplit? (1.2.166)
 *
 * Asks GitHub for the latest release of the public repository, at most once
 * every few hours, and says whether it is newer than what runs here (or than
 * a version the caller names: the phone app's own). Nothing about the human
 * is sent: a plain GET with a generic User-Agent.
 *
 * Machines given to the bots are updated by this computer (push-update), so
 * only the desktop and phone apps show the reminder.
 */

export const RELEASES_API = 'https://api.github.com/repos/20chuangge/lamplit/releases/latest';
export const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/20chuangge/lamplit/releases/download/';
const CACHE_MS = 6 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 30 * 60 * 1000;

/** 1.2.10 > 1.2.9; anything that is not numbers sorts as 0. -> -1 | 0 | 1 */
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Release notes as a few plain lines for the reminder. */
function shortNotes(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    .slice(0, 6)
    .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
}

export function createUpdateChecker({ current, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = 0;
  let failedAt = 0;
  let lastError = '';

  async function latest() {
    const t = now();
    if (cached && t - cachedAt < CACHE_MS) return cached;
    if (!cached && failedAt && t - failedAt < FAIL_CACHE_MS) throw new Error(lastError || 'update check failed');
    try {
      const res = await fetchImpl(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Lamplit-update-check' }, signal: AbortSignal.timeout?.(15000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const data = await res.json();
      const version = String(data.tag_name || '').replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('the latest release has no version tag');
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const pick = (re) => assets.map((a) => String(a?.browser_download_url || '')).find((u) => u.startsWith(RELEASE_DOWNLOAD_PREFIX) && re.test(u)) || '';
      cached = {
        latest: version,
        page: String(data.html_url || '').startsWith('https://github.com/') ? String(data.html_url) : '',
        setupUrl: pick(/Lamplit-Setup-[\d.]+\.exe$/),
        apkUrl: pick(/Lamplit-Android-[\d.]+\.apk$/),
        notes: shortNotes(data.body),
        publishedAt: data.published_at || null,
      };
      cachedAt = t;
      lastError = '';
      return cached;
    } catch (err) {
      failedAt = t;
      lastError = err.message;
      if (cached) return cached;
      throw err;
    }
  }

  return {
    /** -> {current, latest, newer, page, setupUrl, apkUrl, notes} or {current, newer:false, error} */
    async check({ have = '' } = {}) {
      const mine = /^\d+\.\d+\.\d+$/.test(String(have)) ? String(have) : String(current || '');
      try {
        const info = await latest();
        return { current: mine, ...info, newer: compareVersions(info.latest, mine) > 0 };
      } catch (err) {
        return { current: mine, newer: false, error: err.message };
      }
    },
  };
}
