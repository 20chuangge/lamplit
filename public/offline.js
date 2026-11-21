/* The offline page's script (1.5.55). A file of its own: the page's security policy allows no
 * inline script (the old onclick="location.reload()" never ran).
 *
 * The service worker shows this page when a page load fails. Two reasons look alike:
 *  - the hub is really not there (the computer is off): wait, and go back once it answers;
 *  - the hub is there, but the worker's own request failed (seen in an embedded browser):
 *    then the worker is the problem. It is removed, remembered (lamplit.noSw: the page does
 *    not register it again here), and the page loads without it.
 * /api/health is never answered by the worker, and needs no pairing.
 */
(() => {
  let pref = 'system';
  try { pref = localStorage.getItem('desk.lang') || 'system'; } catch { /* private mode */ }
  const en = pref === 'en' || (pref !== 'zh' && !/^zh/i.test(navigator.language || ''));
  if (en) {
    document.documentElement.lang = 'en';
    document.title = 'Lamplit · offline';
    const set = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = text; };
    set('off-title', 'Cannot reach your computer');
    set('off-line1', 'Lamplit works on your computer, and this page cannot reach it right now.');
    set('off-line2', 'Check that the computer is on and Lamplit is running. This page goes back by itself once it can, or retry.');
    set('off-retry', 'Retry');
  }
  const back = () => location.replace(location.href);
  document.getElementById('off-retry')?.addEventListener('click', back);

  const hubAnswers = () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  hubAnswers().then(async (up) => {
    if (!up) return;
    // The hub answers. Once, it may just have come back (a restart, an update): go back. Here again
    // within a minute while it answers: the worker cannot reach it. Without the worker, then.
    let bounced = 0;
    try { bounced = Number(sessionStorage.getItem('lamplit.offlineBounce')) || 0; } catch { /* private mode */ }
    if (!bounced || Date.now() - bounced > 60 * 1000) {
      try { sessionStorage.setItem('lamplit.offlineBounce', String(Date.now())); } catch { /* no second chance */ }
      back();
      return;
    }
    try { localStorage.setItem('lamplit.noSw', String(Date.now())); } catch { /* asked again next time */ }
    try {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* load again anyway */ }
    back();
  });
  // Really offline: look again every 10 seconds, and go back once it answers.
  setInterval(() => { hubAnswers().then((up) => { if (up) back(); }); }, 10000);
})();
