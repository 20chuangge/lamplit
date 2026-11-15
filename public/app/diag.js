
/* Safe-area diagnostics: open with ?diag=1 to read what the device actually
   reports. iOS has no remote inspector from Windows, so this panel is how the
   numbers travel back. English labels on purpose (it is a developer tool). */
(() => {
  // Reachable with ?diag=1, or by tapping the brand five times: an installed app
  // always opens "/", so the query string cannot be typed there.
  const wanted = new URLSearchParams(location.search).has('diag');
  let taps = 0;
  let lastTap = 0;
  const add = () => {
    const box = document.createElement('div');
    box.dataset.diagPanel = '1';
    box.style.cssText = [
      'position:fixed', 'inset:auto 12px 90px 12px', 'z-index:99999',
      'background:#0b0e14ee', 'color:#e7e9f0', 'border:1px solid #3a4256', 'border-radius:12px',
      'padding:12px 14px', 'font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace',
      'white-space:pre-wrap', 'max-height:52vh', 'overflow:auto',
    ].join(';');
    const topbar = document.querySelector('.topbar');
    const rect = topbar ? topbar.getBoundingClientRect() : null;
    const html = document.documentElement;
    const rows = [
      'standalone: ' + (window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches),
      'safe-top reported: ' + (html.dataset.safeTop || '?') + 'px',
      'safe-top fallback: ' + (html.dataset.safeFallback || 'none'),
      '--safe-t var: ' + getComputedStyle(html).getPropertyValue('--safe-t').trim(),
      'inner: ' + innerWidth + 'x' + innerHeight + '  screen: ' + screen.width + 'x' + screen.height,
      'dpr: ' + devicePixelRatio,
      'topbar: top=' + (rect ? Math.round(rect.top) : '?') + ' h=' + (rect ? Math.round(rect.height) : '?'),
      'status-bar-style meta: ' + (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || '?'),
      'ua: ' + navigator.userAgent.slice(0, 90),
    ];
    box.textContent = rows.join('\n');
    const close = document.createElement('button');
    close.textContent = 'close';
    close.style.cssText = 'margin-top:8px;padding:6px 10px;border-radius:8px;border:1px solid #444;background:#1b2130;color:#e7e9f0;font:inherit';
    close.onclick = () => box.remove();
    box.appendChild(close);
    document.body.appendChild(box);
    // A 44px tall target glued to the very top: can a finger reach it?
    const probe = document.createElement('button');
    probe.textContent = 'tap me (top strip)';
    probe.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'height:44px', 'z-index:100000',
      'background:#a3a3a3cc', 'color:#fff', 'border:0', 'font:12px/1 ui-monospace,monospace',
    ].join(';');
    let taps = 0;
    probe.onclick = () => { taps += 1; probe.textContent = 'tapped x' + taps; };
    document.body.appendChild(probe);
  };
  if (wanted) {
    if (document.body) add();
    else document.addEventListener('DOMContentLoaded', add);
    return;
  }
  // Five quick taps on the brand open the same panel inside an installed app.
  document.addEventListener('click', (event) => {
    if (!event.target.closest || !event.target.closest('.brand')) return;
    const now = Date.now();
    taps = now - lastTap < 800 ? taps + 1 : 1;
    lastTap = now;
    if (taps < 5) return;
    taps = 0;
    if (!document.querySelector('[data-diag-panel]')) add();
  }, true);
})();
