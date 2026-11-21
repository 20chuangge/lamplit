// 1.5.56: redesign step 2, the living avatar (public/app/main/11b-lamp.js).
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

export async function lampChecks({ check, readText }) {
  const lamp = await readText('../public/app/main/11b-lamp.js');
  const page = await readText('../public/index.html');
  const en = await readText('../public/i18n-en.js');

  // --- L1 the state mapping: one state from what the page already knows
  const lampStateOf = new Function(`${fnSource(lamp, 'lampStateOf')}; return lampStateOf;`)();
  const cases = [
    [null, {}, 'idle'],
    [{ working: true }, {}, 'think'],
    [{ working: true, doing: { text: '整理下载' } }, {}, 'think'],
    [{ working: true, doing: { tool: 'shell' } }, {}, 'work'],
    [{ working: true, doing: { step: '第二步', done: 1, total: 3 } }, {}, 'work'],
    [{ needsYou: true, working: true }, {}, 'wait'],
    [{ asking: { question: '要哪个？' } }, {}, 'wait'],
    [{ failed: { status: 'failed' } }, {}, 'stuck'],
    [{ unread: true }, {}, 'done'],
    [{ unread: true }, { onScreen: true }, 'idle'],
    [null, { noModel: true }, 'idle'], // no model is not a face state: the banner and the first run say it
    [{ needsYou: true }, { online: false }, 'offline'],
    [{ working: true }, { linkDown: true }, 'offline'],
    [{ unread: true, failed: { status: 'budget' } }, {}, 'stuck'],
  ];
  const wrong = cases.filter(([item, ctx, want]) => lampStateOf(item, ctx) !== want).map(([item, ctx, want]) => `${JSON.stringify(item)} ${JSON.stringify(ctx)} -> ${lampStateOf(item, ctx)} (want ${want})`);
  check('L1 living avatar: the seven states of the design study from attention, the machine and the link - offline > waits on you > thinking / working > stuck > done > idle', wrong.length === 0, wrong.join('; '));
  check('L1 seven states and no more: no 「睡着」, no state for a missing model', !/sleep|noModel|modelState/.test(lamp)
    && JSON.stringify(Object.keys(new Function(`${/const LAMP_EYES = [^;]+;/.exec(lamp)[0]} return LAMP_EYES;`)())) === JSON.stringify(['idle', 'think', 'work', 'wait', 'done', 'stuck', 'offline']));
  check('L1 the list and the large faces read the same state (lampStateFor), list faces only swap a cached face image',
    lamp.includes('function lampStateFor(bot') && /function lampMarkRow[\s\S]*?faceSvg\(a\.color, FACE_ZOOM\[a\.shape\] \|\| 1, LAMP_EYES\[st\]\)/.test(lamp)
    && page.includes('lampMarkRow(av, bot);') && page.includes("lampMarkRow(av, bot, { key: `bot:${id}`, online: m.online });"));

  // --- L2 attention knows a stuck turn (the one piece of state the page did not have)
  const { createAttention, STUCK_STATUSES } = await import('../src/attention.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamp-att-'));
  try {
    let onEvent = null;
    const bus = { emit() {}, subscribe(fn) { onEvent = fn; } };
    const att = createAttention({ file: path.join(dir, 'attention.json'), bus });
    await att.load();
    const ts = () => new Date().toISOString();
    onEvent({ type: 'turn.start', botId: 'a', turnId: 't1', text: '做点事' });
    onEvent({ type: 'turn.end', botId: 'a', turnId: 't1', status: 'failed', ts: ts() });
    const failed = att.snapshot().items['bot:a']?.failed;
    att.seen('bot:a');
    const stillAfterSeen = att.snapshot().items['bot:a']?.failed;
    onEvent({ type: 'turn.start', botId: 'a', turnId: 't2', text: '再试' });
    const whileWorking = att.snapshot().items['bot:a'];
    onEvent({ type: 'turn.end', botId: 'a', turnId: 't2', status: 'success', ts: ts() });
    const afterGood = att.snapshot().items['bot:a']?.failed;
    onEvent({ type: 'turn.start', botId: 'b', turnId: 't3' });
    onEvent({ type: 'turn.end', botId: 'b', turnId: 't3', status: 'stopped', ts: ts() });
    const stopped = att.snapshot().items['bot:b']?.failed;
    onEvent({ type: 'turn.start', botId: 'c', turnId: 't4' });
    onEvent({ type: 'turn.end', botId: 'c', turnId: 't4', status: 'budget', ts: ts() });
    await new Promise((r) => setTimeout(r, 400)); // saved after 300 ms
    const again = createAttention({ file: path.join(dir, 'attention.json'), bus: { emit() {}, subscribe() {} } });
    await again.load();
    const reloaded = again.snapshot().items['bot:c']?.failed;
    check('L2 attention says a chat got stuck: the last turn failed (model error, error, timeout, budget, no progress, step limit), kept after it was seen, gone while it works and after a good turn; a stop the human asked for is not stuck; it survives a restart',
      failed?.status === 'failed' && stillAfterSeen?.status === 'failed' && whileWorking?.working && !whileWorking.failed && !afterGood && !stopped
      && reloaded?.status === 'budget' && ['failed', 'error', 'timeout', 'budget', 'stalled', 'max_steps'].every((s) => STUCK_STATUSES.has(s)) && !STUCK_STATUSES.has('stopped') && !STUCK_STATUSES.has('cancelled'),
      JSON.stringify({ failed, stillAfterSeen, whileWorking, afterGood, stopped, reloaded }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check('L2 the list says it too: a red dot and 「出错了，没做完」 (stuckLine), English included',
    page.includes("kind = 'failed';") && page.includes("if (item?.failed) return { kind: 'failed', text: stuckLine(item.failed.status)")
    && page.includes('.att.failed i { background: var(--danger); }') && en.includes('"{0}，没做完": "{0}, did not finish"'));

  // --- L3 motion off: the setting, the system's reduced motion, and what stays still
  const motion = (stored, reduced) => {
    const ctx = {
      localStorage: { getItem: (k) => (k === 'desk.lampMotion' ? stored : null) },
      lampReduce: { matches: reduced },
    };
    vm.createContext(ctx);
    vm.runInContext(`const LAMP_MOTION_KEY = 'desk.lampMotion'; ${fnSource(lamp, 'lampMotionOn')}${fnSource(lamp, 'lampStill')} this.still = lampStill();`, ctx);
    return ctx.still;
  };
  check('L3 motion off: 外观 → 头像动起来 off, or the system asks for less motion, and the faces are still; on by default',
    motion(null, false) === false && motion('on', false) === false && motion('off', false) === true && motion(null, true) === true
    && page.includes('<input type="checkbox" id="lamp-motion" checked />') && page.includes('头像动起来：眼睛跟着你看、会眨眼')
    && en.includes('"头像动起来：眼睛跟着你看、会眨眼": "Living avatars: eyes follow you and blink"')
    && lamp.includes("localStorage.setItem(LAMP_MOTION_KEY, event.target.checked ? 'on' : 'off')"));
  check('L3 still means still: no spring and no blink (lampPose), CSS animations off under html.lamp-still and prefers-reduced-motion, the state still shows (work keeps its glow)',
    /if \(still\) \{ lampPose\(it\); continue; \}/.test(lamp) && lamp.includes("document.documentElement.classList.toggle('lamp-still', lampStill());")
    && page.includes('html.lamp-still .lamp-live .lamp-body, html.lamp-still .lamp-live .lamp-glow, html.lamp-still .lamp-live .lamp-ring { animation: none !important;')
    && /@media \(prefers-reduced-motion: reduce\) \{\s*\.lamp-live \.lamp-body, \.lamp-live \.lamp-glow, \.lamp-live \.lamp-ring \{ animation: none !important;/.test(page)
    && page.includes('html.lamp-still .lamp-live[data-state="work"] .lamp-glow { opacity: 0.9; }'));

  // --- L4 light: one loop for the few large faces, nothing per list row, nothing while hidden
  const rafCalls = (lamp.match(/requestAnimationFrame\(/g) || []).length;
  check('L4 one animation loop for all large faces; it stops when they are still (one alarm for the next blink), when the tab is hidden, and for faces out of view',
    rafCalls === 2 && lamp.includes('if (document.hidden || lampAppAway) return;') && lamp.includes("document.addEventListener('visibilitychange', () => lampPause(document.hidden));")
    && lamp.includes('if (away) { cancelAnimationFrame(lampRaf); lampRaf = 0; clearTimeout(lampWake); return; }')
    && lamp.includes('new IntersectionObserver') && lamp.includes('if (!it.visible || !it.eyes) continue;')
    && /if \(wake < Infinity && !still\) lampWake = setTimeout\(lampKick/.test(lamp));
  check('L4 list faces: no timer, no frame, no listener per row', !/setTimeout|requestAnimationFrame|addEventListener/.test(fnSource(lamp, 'lampMarkRow')));
  check('L4 large faces are inline SVG clipped to the bot\'s shape; a picture stays a picture with only a ring; a picture that fails gives the face back',
    lamp.includes('<clipPath id="${id}c"><path d="${shape.path}"/></clipPath>') && lamp.includes('<image class="lamp-img" href=')
    && page.includes('.lamp-live[data-img][data-state="work"] .lamp-ring') && lamp.includes(".lamp-img')?.addEventListener('error'"));
  check('L4 where the large faces are: the chat header, the empty chat, the bot page, the avatar editor',
    page.includes("lampMount(host, bot, 30, 'chat-avatar');") && page.includes("lampMount(av, bot, 54, 'empty-avatar');")
    && page.includes("lampMount($('botedit-preview'), bot, 60);") && page.includes('lampMount(host, bot, 96);'));
  check('L4 the Android app in the background stops the loop too (Capacitor appStateChange, pause / resume), like a hidden tab',
    lamp.includes("window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', ({ isActive }) => { lampAppAway = !isActive; lampPause(lampAppAway); });")
    && lamp.includes("document.addEventListener('pause'") && lamp.includes("if (!lampRaf && !document.hidden && !lampAppAway && lampItems.size)"));

  // --- L5 how each state shows (design study §3.3)
  check('L5 等你: a violet ring and badge on the large face; on the list face a violet ring outside the shape (the mask moves to the face layer); 卡住: a red badge (large face) and red dot (row); 机器离线: eyes shut, lamp off, the whole row faded',
    lamp.includes('<i class="lamp-badge" aria-hidden="true"></i>')
    && page.includes('.lamp-live[data-state="wait"] .lamp-badge { display: block; background: var(--accent); }')
    && page.includes('.lamp-live[data-state="stuck"] .lamp-badge { display: block; background: var(--danger); }')
    && page.includes('mask-image:${url};--av-mask:${url}}') && /\.av\[data-lamp\] > \.av-face, \.av\[data-lamp\] > \.av-img, \.av\[data-lamp\]::after \{\s*-webkit-mask-image: var\(--av-mask\)/.test(page)
    && page.includes('.bot:has(.bot-av[data-lamp="offline"]) { opacity: 0.6; }') && page.includes('.lamp-live[data-state="offline"] .lamp-glow { opacity: 0; animation: none; }')
    && !page.includes('[data-state="stuck"] .lamp-ring'));
  // The beginner test (1.5.56): in the list, working and stuck did not show without reading the line.
  check('L5 the list face says it without words: a turning ring at the corner while it thinks or works (the header face too), a red dot when stuck, a violet dot when it waits; the ring stands still when motion is off; the row-end dot for working is hollow, for a new result solid',
    page.includes('.av[data-lamp="work"]::before, .av[data-lamp="think"]::before {') && /border-top-color: var\(--text\);\s*animation: lamp-spin 0\.9s linear infinite;/.test(page)
    && page.includes('.av[data-lamp="stuck"]::before { content: ""; background: var(--danger); }') && /\.av\[data-lamp="wait"\]::before \{\s*content: "!"; background: var\(--accent-solid\); color: var\(--on-accent\);/.test(page)
    && page.includes('.lamp-live[data-state="work"] .lamp-badge, .lamp-live[data-state="think"] .lamp-badge {')
    && page.includes('html.lamp-still .av[data-lamp]::before { animation: none; }') && page.includes('html.lamp-still .lamp-live .lamp-badge { animation: none; }')
    && page.includes('@media (prefers-reduced-motion: reduce) { .av[data-lamp]::before { animation: none; } }')
    && page.includes('.att.working i { background: none; box-shadow: inset 0 0 0 2px var(--text); animation-name: att-ring; }') && page.includes('--lamp-track: color-mix(in srgb, var(--dim) 60%, transparent);') && page.includes('.att.unread i { background: var(--solid); }'));
  check('L5 the face itself tells 在做 from 卡住: the lamp in a working list face pulses (steady and bright when motion is off), stuck eyes are drooping lids (list and large face alike), not short bars',
    page.includes('.av[data-lamp="work"]::after { animation: lamp-glow 2.2s ease-in-out infinite; }')
    && page.includes('html.lamp-still .av[data-lamp="work"]::after { animation: none; opacity: 0.9; }')
    && page.includes('@media (prefers-reduced-motion: reduce) { .av[data-lamp="work"]::after { animation: none; opacity: 0.9; } }')
    && /half: \(x, ink\) => \(x < 50\s*\? `<path d='M\$\{x - 1\},48\.5 L\$\{x \+ 9\.5\},44\.5/.test(page)
    && lamp.includes(`FACE_EYES.half(x, ink).replace('<path ', '<path class="e-half" ')`));
  check('L5 the three dots under the chat are gone: the face shows thinking and working, the line says what',
    page.includes(`row.innerHTML = '<span class="typing-label"></span>';`) && !page.includes('<span class="typing-dots"><i></i><i></i><i></i></span><span class="typing-label">'));
  check('L5 「任务」 in the chat header sizes to its icon and word (the 32 px header rule squeezed the icon away and the word spilled out); narrow, it is a square icon',
    /\.chat-head \.icon-btn \{ width: 32px;[^\n]*\n[^\n]*\n  \.chat-head \.icon-btn\.with-label \{ width: auto; \}\n  \.icon-btn\.with-label svg \{ flex: none; \}/.test(page)
    && page.includes('#nav-toggle, #panel-toggle { width: 36px; height: 36px; min-height: 36px; }')
    && (page.match(/class="icon-btn with-label"/g) || []).length === 1);

  check('L4 gaze: the pointer, the composer while you type, the card that waits on you; a face with nobody moving only glances now and then',
    lamp.includes("now - lampTyping < 1600 ? $('composer')") && lamp.includes(".messages .approval.pending, #decision-strip:not([hidden]), .takeover-card")
    && lamp.includes('Math.tanh(d / 260)') && lamp.includes('now - lampPointer.t > 5000'));
}
