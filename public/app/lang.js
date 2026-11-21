
  /* -------------------------------------------------------------------
     Language. The UI is written in Chinese; English comes from
     i18n-en.js, keyed by the Chinese text. With English on, an observer
     translates every text node and title / placeholder / aria-label as
     it appears, so dynamic UI needs no per-call wiring. Conversation
     content (bubbles, inputs, code) is never touched.
     ------------------------------------------------------------------- */
  (() => {
    const KEY = 'desk.lang';
    let pref = 'system';
    try { pref = localStorage.getItem(KEY) || 'system'; } catch { /* private mode */ }
    // The app's own copy wins: it follows you from machine to machine (theme.js, 1.3.2).
    const sharedLang = window.deskViewPrefs && window.deskViewPrefs.get().lang;
    if (sharedLang === 'zh' || sharedLang === 'en' || sharedLang === 'system') pref = sharedLang;
    const lang = pref === 'zh' || pref === 'en' ? pref : (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';

    const CJK = /[一-鿿]/;
    const exact = new Map();
    const patterns = [];
    const dict = window.DESK_I18N_EN || {};
    const norm = (text) => text.replace(/\s+/g, ' ').trim();
    for (const [zh, en] of Object.entries(dict)) {
      const parts = zh.split(/\{(\d)\}/);
      if (parts.length === 1) { exact.set(zh, en); continue; }
      let source = '^';
      const order = [];
      parts.forEach((part, i) => {
        if (i % 2) { source += '(.*?)'; order.push(Number(part)); }
        else source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      });
      // Most specific first: more literal text = fewer false matches.
      patterns.push({ re: new RegExp(`${source}$`), order, en, weight: zh.replace(/\{\d\}/g, '').length });
    }
    patterns.sort((a, b) => b.weight - a.weight);

    const cache = new Map();
    function t(text) {
      if (lang !== 'en' || !text || !CJK.test(text)) return text;
      const key = norm(text);
      if (cache.has(key)) return cache.get(key);
      let out = exact.get(key);
      if (out === undefined) {
        for (const p of patterns) {
          const m = p.re.exec(key);
          if (!m) continue;
          const values = [];
          p.order.forEach((slot, i) => { values[slot] = m[i + 1]; });
          out = p.en.replace(/\{(\d)\}/g, (_, slot) => t(values[Number(slot)] || ''));
          break;
        }
      }
      if (out === undefined) out = text;
      cache.set(key, out);
      return out;
    }

    const SKIP = '.bubble:not(.system), textarea, input, pre, code, .tech-pre, .mem-pre, .no-i18n, #pc-vnc-wrap';
    const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
    // What this file wrote itself (1.5.53, the 1.5.52 walkthrough's #1): the observer
    // sees its own change as new text, and a translation that still had Chinese in it
    // (a pattern rule's leftover) was translated again, and again - the page froze on
    // opening Settings. A value that is what we wrote is ours: left alone.
    const wroteText = new WeakMap(); // text node -> the value written
    const wroteAttr = new WeakMap(); // element -> {name: value written}
    function fixText(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP) || parent.closest('script, style')) return;
      const before = node.nodeValue;
      if (!CJK.test(before) || wroteText.get(node) === before) return;
      const after = t(before);
      if (after !== before) {
        const lead = before.match(/^\s*/)[0];
        const tail = before.match(/\s*$/)[0];
        const value = lead + after + tail;
        wroteText.set(node, value);
        node.nodeValue = value;
      }
    }
    function fixAttrs(el) {
      if (el.closest && el.closest('.bubble:not(.system), #pc-vnc-wrap')) return;
      for (const name of ATTRS) {
        const v = el.getAttribute && el.getAttribute(name);
        if (v && CJK.test(v)) {
          const mine = wroteAttr.get(el);
          if (mine && mine[name] === v) continue;
          const nv = t(v);
          if (nv !== v) {
            wroteAttr.set(el, { ...(mine || {}), [name]: nv });
            el.setAttribute(name, nv);
          }
        }
      }
    }
    function fixTree(root) {
      if (root.nodeType === 3) { fixText(root); return; }
      if (root.nodeType !== 1) return;
      fixAttrs(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === 3) fixText(n);
        else fixAttrs(n);
      }
    }

    window.deskI18n = {
      lang,
      pref,
      t,
      setPref(next) {
        try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
        if (window.deskViewPrefs) window.deskViewPrefs.set({ lang: next });
        location.reload();
      },
    };
    if (lang !== 'en') return;
    document.title = t(document.title);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') fixText(m.target);
        else if (m.type === 'attributes') fixAttrs(m.target);
        else m.addedNodes.forEach(fixTree);
      }
    }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
    document.addEventListener('DOMContentLoaded', () => fixTree(document.body));
  })();
