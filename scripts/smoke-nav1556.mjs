// 1.5.56: on a phone, closing 设置 goes back where it was opened from; the back key goes back one
// level (a page → the settings list → where you came from). The desktop is as it was.
// The navigation logic is a small factory in 12-wiring.js between markers, run here with a fake
// page; the real thing was also tried at phone width in a browser.
import vm from 'node:vm';

const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); return i >= 0 && j > i ? src.slice(i, j) : ''; };

/** A tiny page: the home list, the panel and its tabs, one chat; enough for the view functions. */
function fakePage() {
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ?? !s.has(c) ? s.add(c) : s.delete(c)) }; };
  const els = { 'home-search': { value: '' }, panel: { classList: cls() } };
  const tabs = { activity: { dataset: { tab: 'activity' }, classList: cls() }, computer: { dataset: { tab: 'computer' }, classList: cls() } };
  const page = {
    body: { classList: cls() },
    chat: 'bot:chief',
    mobile: true,
    $: (id) => els[id] || null,
    openSidebar() { page.body.classList.add('m-home'); },
    closeSidebar() { page.body.classList.remove('m-home'); els['home-search'].value = ''; },
    openPanel(tab) { els.panel.classList.add('open'); for (const t of Object.values(tabs)) t.classList.remove('active'); tabs[tab || 'activity'].classList.add('active'); },
    closePanel() { els.panel.classList.remove('open'); },
    filterHome() {},
    document: { body: null, querySelector: (sel) => (sel === '.tabs .tab.active' ? Object.values(tabs).find((t) => t.classList.contains('active')) || null : null) },
  };
  page.document.body = page.body;
  return { page, els };
}

export async function navChecks({ check, readText }) {
  const wiring = await readText('../public/app/main/12-wiring.js');
  const settings = await readText('../public/app/main/08-settings.js');
  const page = await readText('../public/index.html');
  const code = between(wiring, '/* settings-nav:start */', '/* settings-nav:end */');
  check('NAV0 the settings navigation is one small piece (makeSettingsNav, settingsView, restoreSettingsView) that openSettings and closeSettings use',
    Boolean(code) && code.includes('function makeSettingsNav(') && code.includes('function settingsView(') && code.includes('function restoreSettingsView(')
    && settings.includes('settingsNav.opened(') && settings.includes('settingsNav.closed('));
  if (!code) return;

  const run = (setup) => {
    const { page: p, els } = fakePage();
    const pushed = [];
    let backs = 0;
    const ctx = {
      document: p.document, $: p.$, isMobile: () => p.mobile, currentChatKey: () => p.chat,
      openSidebar: p.openSidebar, closeSidebar: p.closeSidebar, openPanel: p.openPanel, closePanel: p.closePanel, filterHome: p.filterHome,
      history: { pushState: (s) => pushed.push(s), go: (n) => { backs += -n; }, back: () => { backs += 1; } },
    };
    vm.createContext(ctx);
    vm.runInContext(`${code}\nthis.nav = makeSettingsNav({ mobile: () => isMobile(), view: settingsView, push: (s) => history.pushState({ lamplit: s }, ''), back: (n) => history.go(-n) });`, ctx);
    setup(p, els);
    return { p, els, nav: ctx.nav, ctx, pushed, backs: () => backs };
  };
  // Open (the page closes the home list and panel after the view is taken), then close; what shows?
  const roundTrip = (setup, { section = '', closeBy = 'button', pickSection = false } = {}) => {
    const t = run(setup);
    t.nav.opened(section, false);
    t.p.closeSidebar(); t.p.closePanel();
    if (pickSection) t.nav.sectionPicked();
    let from;
    if (closeBy === 'button') from = t.nav.closed({ viaHistory: false });
    else {
      // The back key: each press pops one entry; the page acts on what popped() says.
      let said = '';
      while (said !== 'close') { said = t.nav.popped(); if (said === 'none') break; }
      from = t.nav.closed({ viaHistory: true });
    }
    t.ctx.restoreSettingsView(from);
    return {
      home: t.p.body.classList.contains('m-home'), search: t.els['home-search'].value,
      panel: t.els.panel.classList.contains('open') ? t.p.document.querySelector('.tabs .tab.active')?.dataset.tab : '',
      chat: t.p.chat, pushed: t.pushed.length, backs: t.backs(),
    };
  };

  const home = roundTrip((p, els) => { p.openSidebar(); els['home-search'].value = '小笔'; });
  check('NAV1 phone: 设置 opened from the home list (with a search typed) closes back to the home list, the search still there',
    home.home && home.search === '小笔' && !home.panel, JSON.stringify(home));
  const chat = roundTrip((p) => { p.chat = 'bot:writer'; });
  check('NAV2 phone: opened from a chat (the mic without a voice key, 「其他服务商」), it closes back to that chat - not the home list, not 助理',
    !chat.home && !chat.panel && chat.chat === 'bot:writer', JSON.stringify(chat));
  const group = roundTrip((p) => { p.chat = 'group:g1'; });
  check('NAV3 phone: opened from a group chat, it closes back to that group', !group.home && group.chat === 'group:g1', JSON.stringify(group));
  const tasks = roundTrip((p) => { p.openPanel('activity'); }, { section: 'sec-initiative' });
  const screen = roundTrip((p) => { p.openPanel('computer'); }, { section: 'sec-skills' });
  check('NAV4 phone: opened from the 任务 panel (the 「设置 → 主动」 link) or the 电脑 tab, it closes back to that panel and tab',
    tasks.panel === 'activity' && !tasks.home && screen.panel === 'computer', JSON.stringify({ tasks, screen }));
  const banner = roundTrip((p) => { p.chat = 'bot:chief'; }, { section: 'sec-checkup' });
  const machines = roundTrip((p) => { p.openPanel('activity'); }, { section: 'sec-machines' });
  check('NAV5 phone: a page opened from somewhere specific (the checkup banner in a chat, the 机器 link) closes back there',
    !banner.home && banner.chat === 'bot:chief' && machines.panel === 'activity', JSON.stringify({ banner, machines }));
  {
    const t = run((p) => { p.openSidebar(); });
    t.nav.opened('', false); t.p.closeSidebar(); t.p.closePanel();
    t.p.chat = 'bot:other'; // something in 设置 opened another chat
    t.ctx.restoreSettingsView(t.nav.closed({ viaHistory: false }));
    check('NAV6 when something inside 设置 opened another chat, that chat stays (the home list does not come back over it)',
      !t.p.body.classList.contains('m-home') && t.p.chat === 'bot:other');
  }

  // The back key, one level at a time.
  {
    const t = run((p) => { p.openSidebar(); });
    t.nav.opened('', false);
    t.nav.sectionPicked();
    const first = t.nav.popped();
    const second = t.nav.popped();
    check('NAV7 back key: a page inside 设置 → the settings list → closes (two presses, each one step); the settings list then closes to where you came from',
      t.pushed.length === 2 && first === 'home' && second === 'close', JSON.stringify({ pushed: t.pushed, first, second }));
    const direct = run(() => {});
    direct.nav.opened('sec-checkup', false);
    const d1 = direct.nav.popped();
    const d2 = direct.nav.popped();
    check('NAV8 back key on a page opened straight from elsewhere (the checkup banner): first the settings list, then out',
      direct.pushed.length === 2 && d1 === 'home' && d2 === 'close', JSON.stringify({ d1, d2 }));
    const closed = run(() => {});
    closed.nav.opened('', false);
    closed.nav.sectionPicked();
    closed.nav.closed({ viaHistory: false });
    const after = closed.nav.popped();
    check('NAV9 closing with ✕ takes its history steps back too (the next back key does not reopen anything); that step is ignored',
      closed.backs() === 2 && after === 'ignore', JSON.stringify({ backs: closed.backs(), after }));
    const arrow = run(() => {});
    arrow.nav.opened('', false);
    arrow.nav.sectionPicked();
    arrow.nav.toHome();
    const a1 = arrow.nav.popped();
    const a2 = arrow.nav.popped();
    check('NAV10 the ‹ arrow (back to the settings list) takes one step too; the next back key closes 设置',
      a1 === 'ignore' && a2 === 'close', JSON.stringify({ a1, a2 }));
  }
  {
    // Beginner test (1.5.56): 体检 → 「去设置模型」 → back went to the list, not to 体检.
    const t = run(() => {});
    t.nav.opened('sec-checkup', false);
    t.nav.opened('sec-model', true); // a link inside 设置 opens another page
    const b1 = t.nav.popped();
    const b2 = t.nav.popped();
    const b3 = t.nav.popped();
    const x = run(() => {});
    x.nav.opened('sec-checkup', false);
    x.nav.opened('sec-model', true);
    x.nav.closed({ viaHistory: false });
    const same = run(() => {});
    same.nav.opened('sec-model', false);
    same.nav.opened('sec-model', true); // the same page again adds no step
    check('NAV13 a page opened from another page inside 设置 is one more step: back goes 模型 → 体检 → the list → out; ✕ takes all of them back; the same page twice adds nothing',
      b1 === 'page:sec-checkup' && b2 === 'home' && b3 === 'close' && x.backs() === 3 && same.pushed.length === 2, JSON.stringify({ b1, b2, b3, backs: x.backs(), same: same.pushed.length }));
  }
  // Back from a chat (the coordinator, after the beginner test): a chat entered from the home list is one
  // history step; the back key there shows the home list; on the home list it leaves the app as before.
  {
    const t = run(() => {});
    vm.runInContext("this.chat = makeChatNav({ mobile: () => isMobile(), push: (s) => history.pushState({ lamplit: s }, ''), back: (n) => history.go(-n) });", t.ctx);
    const chatNav = t.ctx.chat;
    // The page's router: a settings step first, then the chat's.
    const pop = () => { const s = t.nav.popped(); return s !== 'none' ? `settings:${s}` : `chat:${chatNav.popped()}`; };
    chatNav.entered();
    chatNav.entered(); // another chat from inside a chat adds nothing
    const once = t.pushed.length;
    const b1 = pop();
    const b2 = pop();
    check('NAV14 phone: a chat opened from the home list is one back step: back shows the home list; back again is not ours (the app leaves, as before); a second chat from inside the first adds nothing',
      once === 1 && b1 === 'chat:home' && b2 === 'chat:none', JSON.stringify({ once, b1, b2 }));
    const u = run(() => {});
    vm.runInContext("this.chat = makeChatNav({ mobile: () => isMobile(), push: (s) => history.pushState({ lamplit: s }, ''), back: (n) => history.go(-n) });", u.ctx);
    const c2 = u.ctx.chat;
    const pop2 = () => { const s = u.nav.popped(); return s !== 'none' ? `settings:${s}` : `chat:${c2.popped()}`; };
    c2.entered();
    u.nav.opened('', false); u.nav.sectionPicked('sec-usage');
    const s1 = pop2(); const s2 = pop2(); u.nav.closed({ viaHistory: true }); const s3 = pop2();
    c2.entered();
    c2.left(); // the chat's own ‹ back to the home list
    const s4 = pop2();
    check('NAV15 settings opened in a chat keep their layers on top: back goes page → settings list → (closed) the chat → the home list; the chat\'s ‹ takes its step back itself',
      s1 === 'settings:home' && s2 === 'settings:close' && s3 === 'chat:home' && s4 === 'chat:ignore', JSON.stringify({ s1, s2, s3, s4 }));
    const d = run((p) => { p.mobile = false; });
    vm.runInContext("this.chat = makeChatNav({ mobile: () => isMobile(), push: (s) => history.pushState({ lamplit: s }, ''), back: (n) => history.go(-n) });", d.ctx);
    d.ctx.chat.entered();
    check('NAV16 desktop: opening a chat adds no history step', d.pushed.length === 0);
  }
  const bots = await readText('../public/app/main/04-bots.js');
  const groups = await readText('../public/app/main/03-groups.js');
  check('NAV17 the page: a bot or group opened from the home list is a step (selectBot, openGroup), the chat\'s ‹ takes it back, and the back key shows the home list (one router for settings and chats)',
    bots.includes('if (fromHome && !keepHome) chatNav.entered();') && groups.includes('if (fromHome) chatNav.entered();')
    && wiring.includes("else { closePanel(); chatNav.left(); openSidebar(); }") && wiring.includes("window.addEventListener('popstate', onNavPopState);") && wiring.includes("if (chatNav.popped() === 'home') { closePanel(); openSidebar(); }"));
  check('NAV18 no flash of the chat when 设置 opens on a phone: the home list and the panel stay under the sheet until it has faded in (160 ms), then close',
    settings.includes('setTimeout(() => { if (state.settingsOpen) { closeSidebar(); closePanel(); } }, 200);'));
  check('NAV19 the group input hint fits a phone (measured at 375 px: 181 px of room): 「@ 可指定谁来答…」 (120 px; English 164 px), the group name being in the header; the long one on a computer',
    bots.includes("isMobile() ? '@ 可指定谁来答…' :"));
  {
    const t = run((p) => { p.mobile = false; });
    t.nav.opened('', false);
    const from = t.nav.closed({ viaHistory: false });
    check('NAV11 desktop: nothing is added to the history and nothing is restored (it closes back to the same screen as before)',
      t.pushed.length === 0 && from === null && t.backs() === 0);
  }
  check('NAV12 the page: the 设置 button no longer shuts the home list before 设置 sees it; the demo banner opens the model picker (connectRealModel takes no argument, so its click event is not passed on as a section; 1.5.61: the three brains of the first run while no model is connected); the back key pops a step (popstate); desktop focus goes back to the 设置 button',
    !/\$\('settings-btn'\)\.addEventListener\('click', \(\) => \{\s*closeSidebar\(\);/.test(wiring) && wiring.includes("$('mock-banner-btn').addEventListener('click', connectRealModel);")
    && wiring.includes("window.addEventListener('popstate', onNavPopState);") && settings.includes("if (!isMobile()) $('settings-btn').focus();")
    && page.includes('settingsNav.sectionPicked(btn.dataset.setTarget)') && page.includes('settingsNav.toHome()'));
}
