// 1.5.57: the living avatar is seen to live - a 40 px header face whose eyes move a visible
// share of the face, and a sidebar that blinks, glows and breathes in pure CSS.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.

/** A top-level function of a page part, as source. */
function fnSource(src, name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(src);
  return m ? m[0] : '';
}

export async function lamp1557Checks({ check, readText }) {
  const lamp = await readText('../public/app/main/11b-lamp.js');
  const page = await readText('../public/index.html');

  // --- the header face: 40 px, same header height, eyes that move a visible share
  check('A1 the chat header face is 40 px (design 40-56; at 30 px it hardly moved) and keeps the header its height (a -2px margin: it takes the 36 px the 30 px face took)',
    page.includes("lampMount(host, bot, 40, 'chat-avatar');") && page.includes('.chat-head .chat-avatar.lamp-live { margin: -2px 0; }'));
  const lampReach = new Function(`${fnSource(lamp, 'lampReach')}; return lampReach;`)();
  const reaches = [30, 40, 54, 60, 96].map((n) => lampReach(n));
  check('A1 gaze scales with size: at a full look the eyes move 10-15% of the face (13% at 40 px, 11.5% at 54-60 px, 10% at 96 px), as a CSS length (--lamp-r); a small face blinks a little slower',
    reaches.every((r) => r >= 10 && r <= 15) && reaches[1] === 13 && reaches[2] === 11.5 && reaches[4] === 10
    && lamp.includes("host.style.setProperty('--lamp-r',") && lamp.includes('(lampReach(px) * px) / 100')
    && lamp.includes("host.style.setProperty('--lamp-blink-ms',") && lamp.includes('px <= 44 ? 190 : 150')
    && lamp.includes('translate(calc(var(--lamp-r) * ') && lamp.includes('(y * 0.7).toFixed(3)')
    && page.includes('.lamp-live.lamp-blinking .lamp-eye { animation: lamp-eye-blink var(--lamp-blink-ms, 150ms) ease-in-out 1; }'), JSON.stringify(reaches));
  // 1.5.57: the face is layers; only transform and opacity ever change (measured in the desktop app).
  check('A1 nothing a face does repaints: the eyes and the face move with transform, the glow and the ring with opacity, each on its own layer (will-change); the pointer is followed at most ~12 times a second, only within 900 px, not once it leaves the window',
    page.includes('.lamp-live .lamp-eyes { position: absolute; inset: 0; transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1); will-change: transform; }')
    && page.includes('@keyframes lamp-eye-blink { 50% { transform: scaleY(0.1); } }')
    && /\.lamp-live \.lamp-glow \{[^}]*will-change: opacity;/.test(page) && page.includes('.lamp-live[data-state="wait"] .lamp-ring-wrap { animation: lamp-ring 2s ease-in-out infinite; will-change: opacity; }')
    && page.includes('.lamp-live[data-state="think"] { animation: lamp-breathe 2.6s ease-in-out infinite; will-change: transform; }')
    && page.includes('@keyframes lamp-scan {') && !/requestAnimationFrame/.test(lamp)
    && lamp.includes('const wait = Math.max(0, 80 - (performance.now() - lampGazeAt));') && lamp.includes('x = Math.round(x * 20) / 20;')
    && lamp.includes('if (!at && d > 900) return [0, 0]; // far away: it stops following')
    && lamp.includes('lampPointer.out = true; // left the window'));
  // --- the sidebar: life in CSS only
  check('A2 sidebar rows blink now and then: one page timer picks one idle or waiting row in view every 3.5-8 s and gives it a 0.22 s CSS blink (the shut-eyes face); no timer and no frame per row, nothing runs between blinks (an endless per-row blink kept the desktop app drawing: ~7% of a core with 30 rows)',
    page.includes('.av.lamp-blink[data-lamp="idle"]:not(.has-image)::after, .av.lamp-blink[data-lamp="wait"]:not(.has-image)::after {')
    && page.includes('animation: lamp-row-blink 220ms linear 1;') && !page.includes('lamp-row-blink 9s')
    && lamp.includes("av.style.setProperty('--lamp-shut', faceSvg(a.color, FACE_ZOOM[a.shape] || 1, 'shut'));")
    && lamp.includes('lampBlinkTimer = setTimeout(lampRowBlink, 3500 + Math.random() * 4500);')
    && lamp.includes("if (document.hidden || lampAppAway || lampStill()) return;")
    && lamp.includes("av.addEventListener('animationend', () => av.classList.remove('lamp-blink'), { once: true });")
    && (lamp.match(/setTimeout\(lampRowBlink/g) || []).length === 1
    && !/setTimeout|requestAnimationFrame|addEventListener/.test(fnSource(lamp, 'lampMarkRow')));
  check('A2 the blink timers stop with the rest: hidden tab, app in the background, motion off',
    /function lampPause\(away\) \{\s*if \(away\) \{[^}]*clearTimeout\(lampBlinkTimer\);/.test(lamp) && /lampIdleSoon\(\);\s*lampRowBlinkSoon\(\);\s*\}/.test(lamp)
    && lamp.includes('lampRowBlinkSoon(); // motion off: no more row blinks'));
  check('A2 a working row\'s lamp pulses (opacity, on its own layer); a waiting row keeps a still violet ring (a breathing drop-shadow cost about a third of a core in the desktop app)',
    page.includes('.av[data-lamp="work"]::after { animation: lamp-glow 2.2s ease-in-out infinite; will-change: opacity; }')
    && !page.includes('lamp-wait-ring')
    && /\.av\[data-lamp="wait"\] \{\s*filter: drop-shadow\(0 0 1px var\(--accent\)\)/.test(page));
  check('A2 still means still in the list too: motion off (html.lamp-still) and reduced motion stop the blink, the pulse and the ring (they win over the row rules); the state stays readable',
    page.includes('html.lamp-still .av[data-lamp]::after, html.lamp-still .av[data-lamp="wait"] { animation: none !important; }')
    && page.includes('@media (prefers-reduced-motion: reduce) { .av[data-lamp]::after, .av[data-lamp="wait"] { animation: none !important; } }')
    && page.includes('html.lamp-still .av[data-lamp]::before { animation: none; }') && page.includes('html.lamp-still .av[data-lamp="work"]::after { animation: none; opacity: 0.9; }'));
  // Found while checking 1.5.57 in the desktop app: a refused shell call came back as an object
  // and was sent to the main assistant as 「[object Object]」 on every page load.
  const machines = await readText('../public/app/main/11-machines.js');
  check('A3 work handed over by the desktop shell is sent only when it is text: a refused call (an object) is never sent as 「[object Object]」',
    machines.includes("const got = await window.desk?.takePendingMessage?.(); text = typeof got === 'string' ? got.trim() : '';")
    && !machines.includes('String((await window.desk?.takePendingMessage?.()) ||'));
  // Light theme (1.5.57, the user): the bot's bubble was #eeeef0 on the #f7f7f8 page - no edge.
  const css = await readText('../public/app/style.css');
  const light = css.slice(css.indexOf('html[data-theme="light"] {'), css.indexOf('}', css.indexOf('html[data-theme="light"] {')));
  check('B1 light theme: the bot\'s bubble is a white surface with a hairline (the --border token, ~1.26:1 against the page) and a soft shadow, like the cards; the human\'s own stays a grey fill; dark is unchanged',
    /--bubble-bot: var\(--panel\);\s*--bubble-bot-border: var\(--border\);\s*--bubble-shadow: 0 1px 2px var\(--shade-1\);/.test(light) && light.includes('--bubble-user: #e8e8eb;')
    && css.includes('--bubble-bot: #161617;') && css.includes('--bubble-bot-border: transparent;') && css.includes('--bubble-shadow: 0 0 transparent;')
    && css.includes('max-width: min(680px, 86%); box-shadow: 0 0 0 1px var(--bubble-bot-border), var(--bubble-shadow);')
    && css.includes('background: var(--bubble-bot); border: 0; box-shadow: 0 0 0 1px var(--bubble-bot-border), var(--bubble-shadow); padding: 10px 16px;'));
}
