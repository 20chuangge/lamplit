
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
    function fixText(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP) || parent.closest('script, style')) return;
      const before = node.nodeValue;
      if (!CJK.test(before)) return;
      const after = t(before);
      if (after !== before) {
        const lead = before.match(/^\s*/)[0];
        const tail = before.match(/\s*$/)[0];
        node.nodeValue = lead + after + tail;
      }
    }
    function fixAttrs(el) {
      if (el.closest && el.closest('.bubble:not(.system), #pc-vnc-wrap')) return;
      for (const name of ATTRS) {
        const v = el.getAttribute && el.getAttribute(name);
        if (v && CJK.test(v)) {
          const nv = t(v);
          if (nv !== v) el.setAttribute(name, nv);
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
