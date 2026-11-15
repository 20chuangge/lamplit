
  // Apply the saved theme before the first paint so a light-theme user never
  // sees a dark flash while the module script at the bottom is still loading.
  (() => {
    try {
      const pref = localStorage.getItem('desk.theme') || 'system';
      const light = pref === 'light'
        || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
      document.documentElement.dataset.theme = light ? 'light' : 'dark';
      document.documentElement.dataset.themePref = pref;
      document.documentElement.style.colorScheme = light ? 'light' : 'dark';
    } catch { /* private mode: keep the dark default */ }
  })();

  /* iOS: the header pads itself by env(safe-area-inset-top), but the value the
     device reports cannot be trusted in every context - installed home-screen
     apps report 0 on some iOS versions, Chrome for iOS floats its own toolbar
     over the page, and a value smaller than the real Dynamic Island height still
     leaves a dead strip under the clock. So: in an installed app or Chrome iOS,
     take the larger of "what the platform says" and "what this phone has".
     Safari-the-browser accounts for its own chrome and is left alone. */
  (() => {
    try {
      const ua = navigator.userAgent || '';
      const isIphone = /iPhone|iPod/.test(ua);
      const isChromeIos = /CriOS/.test(ua);
      const flagged = window.navigator.standalone === true
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      // Switching machines in the home-screen app opens the other machine's
      // address in iOS's in-app browser, with its own bars above and below:
      // the flags still say "installed app", but the page is far shorter than
      // the screen and the bars already keep it clear of the clock. Only a page
      // within a status bar of the screen's height is the app's own window.
      const gap = (window.screen?.height || 0) - window.innerHeight;
      const standalone = flagged && gap < 100;
      if (isIphone) document.documentElement.classList.add('ios');
      if (isIphone && standalone) document.documentElement.classList.add('ios-standalone');
      // The page ends above the bottom of the screen (iOS 26+): the home bar is outside it.
      if (isIphone && standalone && gap >= 40) document.documentElement.classList.add('ios-short-vp');
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
      document.documentElement.appendChild(probe);
      const reported = probe.getBoundingClientRect().height;
      document.documentElement.removeChild(probe);
      document.documentElement.dataset.safeTop = String(Math.round(reported));
      if (!isIphone) return;
      if (!standalone && !isChromeIos) return;
      // The status bar's height on each iPhone screen size (points), when iOS reports less.
      const h = window.screen?.height || 0;
      const estimate = ({ 956: 62, 932: 59, 926: 47, 896: 48, 874: 62, 852: 59, 844: 47, 812: 50 })[h] || (h >= 800 ? 59 : 20);
      if (reported >= estimate) return;
      document.documentElement.style.setProperty('--safe-t', `${estimate}px`);
      document.documentElement.dataset.safeFallback = String(estimate);
    } catch { /* nothing to do */ }
  })();
