// Lamplit site: theme switch, newest downloads, gentle reveal, docs contents.
(() => {
  const root = document.documentElement;
  const KEY = 'evenlight.theme';
  try { const t = localStorage.getItem(KEY); if (t === 'light' || t === 'dark') root.dataset.theme = t; } catch { /* private window */ }
  document.getElementById('theme')?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem(KEY, root.dataset.theme); } catch { /* not kept */ }
  });

  // 中文 / English (1.5.13): each page has its twin (data-other). A choice made
  // with the switch is kept; with none, a browser that reads no Chinese goes to
  // the English page once.
  const LANG = 'lamplit.lang';
  const lang = document.body.dataset.lang || 'zh';
  document.querySelectorAll('[data-lang-switch]').forEach((a) => a.addEventListener('click', () => {
    try { localStorage.setItem(LANG, a.dataset.langSwitch); } catch { /* not kept */ }
  }));
  let chosen = '';
  try { chosen = localStorage.getItem(LANG) || ''; } catch { /* private window */ }
  const readsChinese = (navigator.languages || [navigator.language || '']).some((l) => /^zh/i.test(l));
  if (!chosen && lang === 'zh' && !readsChinese && document.body.dataset.other) {
    location.replace(document.body.dataset.other + location.hash);
    return;
  }

  // Point the buttons straight at the newest files; the release page stays the fallback.
  // Installers were named Nightshift-* before 1.2.146 and Evenlight-* until 1.2.149.
  (async () => {
    try {
      const res = await fetch('https://api.github.com/repos/20chuangge/lamplit/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const find = (re) => (rel.assets || []).find((a) => re.test(a.name));
      const setup = find(/^(Lamplit|Evenlight|Nightshift)-Setup-.*\.exe$/);
      const apk = find(/^(Lamplit|Evenlight|Nightshift)-Android-.*\.apk$/);
      const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
      const a = document.getElementById('dl-setup');
      if (setup && a) {
        // Both pages download the Windows installer from GitHub (1.5.46: Tencent COS dropped; Gitee caps files at 100 MB).
        if (!a.dataset.cn) a.href = setup.browser_download_url;
        document.getElementById('dl-version').textContent = ` ${rel.tag_name}`;
        document.getElementById('dl-size').textContent = `Windows 10 / 11 · ${lang === 'en' ? '64-bit' : '64 位'} · ${mb(setup.size)}`;
      }
      const b = document.getElementById('dl-apk');
      if (apk && b && !b.dataset.cn) b.href = apk.browser_download_url;
    } catch { /* keep the release-page links */ }
  })();

  // Sections fade in once as they scroll into view.
  const targets = document.querySelectorAll('section:not(.hero) .wrap');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const t of targets) { t.classList.add('reveal'); io.observe(t); }
  }

  // Docs on a phone (11-20): the side contents are hidden there, so the same
  // links fold under the title; a tap closes the fold.
  const toc = document.querySelector('.toc');
  const intro = document.querySelector('.doc .intro');
  if (toc && intro) {
    const fold = document.createElement('details');
    fold.className = 'mtoc';
    const sum = document.createElement('summary');
    sum.textContent = toc.querySelector('p')?.textContent || 'Contents';
    const nav = document.createElement('nav');
    [...toc.children].slice(1).forEach((n) => nav.appendChild(n.cloneNode(true)));
    // Close first, then jump: closing after the jump would pull the section up out of view.
    nav.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      const target = a && document.getElementById(a.getAttribute('href').slice(1));
      if (!target) return;
      e.preventDefault();
      fold.open = false;
      history.pushState(null, '', a.getAttribute('href'));
      target.scrollIntoView();
    });
    fold.append(sum, nav);
    intro.after(fold);
  }

  // Docs: highlight the section being read.
  const links = [...document.querySelectorAll('.toc a')];
  if (links.length && 'IntersectionObserver' in window) {
    const byId = new Map(links.map((l) => [l.getAttribute('href').slice(1), l]));
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((l) => l.classList.remove('on'));
        byId.get(e.target.id)?.classList.add('on');
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.doc h2[id], .doc h3[id]').forEach((h) => spy.observe(h));
  }
})();
