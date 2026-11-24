// What a turn did, in words the next turn can act on (1.5.68).
//
// 11-24, TikTok运营, 「可以排」: the first round put the video on TikTok and clicked 「预约发布」 (11:16:49), started
// YouTube and ran out of its 150 steps. The round that went on by itself was handed the last 30 steps as
// `browser_upload()`, `browser_eval()`, `browser_click()` - no file, no button, no page - and the publish was
// not among them. It uploaded to TikTok again and scheduled a second copy; the third round uploaded to
// YouTube a third time, and its closing words said YouTube had not started.
// Now each step carries a line of its own: which page, which file, which button. A step that went out
// (an upload, a click on 发布 / 预约发布 / Post / Schedule …) is marked and handed on for the whole chain,
// however many steps ago. And a file uploaded to a site, then published there, is not uploaded to that site
// again in the same chain unless the bot says it means it (again: true).

/** The words of a button that sends something out. */
export const OUT_WORDS = /发布|预约|发表|发送|提交|排期|定时|安排时间|分享|上架|publish|post\b|schedule|submit|send|share/i;

/** host + path of a page, without the query: where a step happened. */
export function whereOf(url) {
  try {
    const u = new URL(String(url));
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

import { appLabel, SENSITIVE_TAP, tapWords, phoneStepKind } from './phone.mjs';

const hostOf = (url) => { try { return new URL(String(url)).host.replace(/^www\./, ''); } catch { return ''; } };
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const quoted = (t, n = 40) => `「${String(t).replace(/\s+/g, ' ').trim().slice(0, n)}」`;

/** The quoted texts in a page script that clicks: what it went for. */
function clickTargets(expression) {
  const src = String(expression || '');
  if (!/\.click\(\s*\)/.test(src)) return [];
  const out = [];
  for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\\\n]){1,40})\1/g)) {
    const t = m[2].trim();
    if (t && /[\p{L}]/u.test(t) && !/^[\w.#[\]=:*>~+-]+$/.test(t)) out.push(t);
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * One step in words. page: the page the bot was on before this step.
 * Returns { did, out, page, files? }: did - the line (or '' when there is nothing worth saying);
 * out - it went out; page - the page after it; files - what an upload handed over.
 */
export function stepWords({ name, args = {}, result = null, ok = true, page = '' }) {
  const r = result && typeof result === 'object' ? result : {};
  const after = typeof r.url === 'string' && r.url ? r.url : page;
  const at = whereOf(page) || whereOf(after);
  const on = at ? `在 ${at} ` : '';
  if (!ok) return { did: '', out: false, page: after };
  switch (name) {
    case 'browser_open':
      return { did: `打开了 ${whereOf(after) || String(args.url || '').slice(0, 80)}`, out: false, page: after };
    case 'browser_upload': {
      const files = (Array.isArray(r.files) && r.files.length ? r.files : (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean)).map(baseName);
      const box = r.box?.label ? `（${String(r.box.label).slice(0, 20)}）` : '';
      return { did: `${on}上传了 ${files.join('、') || '文件'}${box}`, out: true, page: after, files };
    }
    case 'browser_click': {
      const label = r.clicked?.name || args.text || args.selector || args.ref || '';
      const moved = whereOf(after) && whereOf(after) !== at ? `，页面到了 ${whereOf(after)}` : '';
      return { did: `${on}点了${quoted(label)}${moved}`, out: OUT_WORDS.test(String(label)), page: after };
    }
    case 'browser_eval': {
      const targets = clickTargets(args.expression);
      if (!targets.length) return { did: '', out: false, page: after };
      const said = typeof r.value === 'string' ? `（脚本返回 ${r.value.slice(0, 30)}）` : '';
      return { did: `${on}用脚本点了${targets.map((t) => quoted(t)).join('、')}${said}`, out: targets.some((t) => OUT_WORDS.test(t)) && !/^(nf|not ?found|none|no)$/i.test(String(r.value || '').trim()), page: after };
    }
    case 'browser_type': {
      const field = r.typed?.name || args.selector || args.ref || '';
      return { did: `${on}在${quoted(field, 20)}里输入了${quoted(args.text ?? '', 30)}`, out: false, page: after };
    }
    case 'browser_press':
      return { did: `${on}按了 ${String(args.keys || '').slice(0, 30)}`, out: false, page: after };
    case 'browser_steps': {
      // Several actions in one call (1.5.68): each in its own words, on one line.
      let at2 = page;
      let out = false;
      const parts = [];
      for (const s of Array.isArray(r.steps) ? r.steps : []) {
        const a = (Array.isArray(args.steps) ? args.steps : [])[(s.step || 1) - 1] || {};
        const w = stepWords({ name: `browser_${s.do}`, args: a, result: s, ok: true, page: at2 });
        if (w.did) parts.push(w.did.replace(/^在 \S+ /, ''));
        out = out || w.out;
        at2 = w.page || at2;
      }
      return { did: parts.length ? `${on}${parts.join('，')}` : '', out, page: after };
    }
    case 'phone': {
      // The phone is a place of its own (the app in front); the browser's page stays what it was.
      const pkg = r.screen?.app || r.app || '';
      const where = pkg ? `在手机「${appLabel(pkg)}」` : '在手机上';
      const one = (a, res) => {
        const act = String(a?.action || '');
        const label = String(res?.tapped || a?.what || a?.target || '');
        const w = tapWords(label);
        if (act === 'tap') return { t: `点了${quoted(label || `${a?.x},${a?.y}`)}`, out: SENSITIVE_TAP.test(w) && ['publish', 'send'].includes(phoneStepKind(w)) };
        if (act === 'type') return { t: `在${quoted(a?.target || '输入框', 20)}里输入了${quoted(a?.text ?? '', 30)}${a?.submit ? '并回车' : ''}`, out: false };
        if (act === 'key') return { t: `按了${a?.key || ''}键`, out: false };
        if (act === 'swipe') return { t: `向${a?.direction || ''}滑`, out: false };
        if (act === 'open') return { t: `打开了${quoted(a?.app || '')}`, out: false };
        if (act === 'save_to_album') return { t: `把 ${(Array.isArray(a?.paths) ? a.paths : []).map(baseName).join('、')} 放进了相册`, out: false };
        return { t: '', out: false };
      };
      const list = String(args.action) === 'steps'
        ? (Array.isArray(r.steps) ? r.steps : []).map((s) => one((Array.isArray(args.steps) ? args.steps : [])[(s.step || 1) - 1], s))
        : [one(args, r)];
      const said = list.filter((x) => x.t);
      return { did: said.length ? `${where}${said.map((x) => x.t).join('，')}` : '', out: said.some((x) => x.out), page, place: pkg ? `app:${pkg}` : '' };
    }
    default:
      return { did: '', out: false, page: after };
  }
}

/**
 * An upload of these files to this page's site that already went out in this chain: the file was uploaded
 * to the same site, and after that a step there sent something out. Returns the line to tell the bot, or ''.
 */
export function alreadySent(receipts, files, page) {
  const host = hostOf(page);
  if (!host) return '';
  const names = new Set((files || []).map(baseName).filter(Boolean));
  if (!names.size) return '';
  const list = receipts || [];
  for (let i = 0; i < list.length; i += 1) {
    const up = list[i];
    if (up?.name !== 'browser_upload' || up.ok === false || hostOf(up.page) !== host) continue;
    const same = (up.files || []).filter((f) => names.has(f));
    if (!same.length) continue;
    // The latest step there that went out: 「预约发布」, not the 「schedule」 option picked before it.
    const sent = list.slice(i + 1).filter((r) => r?.out && r.ok !== false && r.name !== 'browser_upload' && hostOf(r.page) === host).pop();
    if (sent) return `${same.join('、')} 这一串活里已经在 ${host} 上传过（${up.did}），之后${sent.did}。再传一次就会多出一条重复的。先去 ${host} 的作品列表看一眼是不是已经在了；确实要重新传（比如上一次没成功、已经删掉了），带上 again: true 再调用一次。`;
  }
  return '';
}
