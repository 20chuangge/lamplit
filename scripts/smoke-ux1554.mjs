// 1.5.54: what a newcomer tripped over (the 1.5.52 new-user walkthrough), and three queued items.
// Called from smoke.mjs as one stage; kept in its own file so other work on smoke.mjs does not collide.
import vm from 'node:vm';

/** The page's translator, run outside a browser, with English on. */
async function loadTranslator(readText) {
  const dictSrc = await readText('../public/i18n-en.js');
  const langSrc = await readText('../public/app/lang.js');
  const window = { deskViewPrefs: { get: () => ({ lang: 'en' }), set() {} } };
  const noop = () => {};
  const ctx = {
    window,
    localStorage: { getItem: () => 'en', setItem: noop },
    navigator: { language: 'en' },
    document: { documentElement: {}, title: '', addEventListener: noop, createTreeWalker: () => ({ nextNode: () => null }) },
    MutationObserver: class { observe() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    location: { reload: noop },
    WeakMap,
  };
  vm.createContext(ctx);
  vm.runInContext(dictSrc, ctx);
  vm.runInContext(langSrc, ctx);
  return window.deskI18n.t;
}

export async function uxChecks({ check, readText }) {
  const page = await readText('../public/index.html');
  const agent = await readText('../src/agent.mjs');
  const tools = await readText('../src/tools.mjs');
  const model = await readText('../src/model.mjs');

  // --- The first card a newcomer sees (walkthrough 2.2, 2.3, 3.9)
  check('UX1 a command card leads with what it does in plain words (the shell tool takes a purpose; the demo gives one); the command itself is one click away, not the headline',
    tools.includes("purpose: { type: 'string'") && /tool: 'shell', args: \{ command: move, purpose: '/.test(model)
    && page.includes('if (args.purpose) {') && page.includes("return args.purpose ? info.title : commandWords(args.command).title;") && page.includes("'要运行的命令'")); // 1.5.58: the command is under 技术细节
  check('UX2 the isolation warning is not shown in the demo (nothing real runs) and is asked about only when 「以后都允许」 is clicked',
    agent.includes("this.model?.provider !== 'mock' && sandboxStatus(this.config.policy).state !== 'on'") && page.includes('if (data.remember.warn && !(await askConfirm(')
    && !page.includes('${data.remember.warn ? ` ${data.remember.warn}` : \'\'}'));
  check('UX3 why it asks says what happens, not 「中风险操作」',
    !page.includes("'这是一个中风险操作'") && page.includes("'这一步会改动这台电脑上的东西'"));
  check('UX4 while a card waits, the line above says 「等你点头…」, not 「正在执行命令…」',
    page.includes("showTyping(typingBotId(), '等你点头…');"));
  check('UX5 a draft you said yes to reads 「已定稿」 (it is posted after that), never 「已发送」 at that moment',
    page.includes("'已定稿（你改过）' : '已定稿'") && !page.includes("'已发送（你改过）'"));

  // --- One daily note, from the machine you use (walkthrough 3.7)
  {
    const os = await import('node:os');
    const path = await import('node:path');
    const fsp = await import('node:fs/promises');
    const { createInitiative } = await import('../src/initiative.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ux1554-'));
    let t = new Date(2026, 10, 21, 10, 0).getTime();
    const said = [];
    const ini = createInitiative({ file: path.join(dir, 'i.json'), now: () => t, say: async (botId, text) => { said.push(text); }, waiting: async () => ({ cards: [{ machine: '书房电脑', botName: '小笔', what: '运行一条命令' }], unread: [], queued: [] }) });
    await ini.load();
    await ini.tick();
    const before = said.length;
    await ini.seenHere();
    t += 60 * 1000;
    await ini.tick();
    const server = await readText('../src/server.mjs');
    check('UX7 the daily 「有什么在等你」 comes only from a machine whose page you opened in the last week (a cloud machine just linked stays quiet); once you open it there, it comes that day',
      before === 0 && said.length === 1 && server.includes('if (!isHubCall(req, state.security)) state.initiative?.seenHere?.()'), JSON.stringify({ before, said }));
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    check('UX8 one daily summary: the task panel\'s 「每日简报」 says how it differs from 「有什么在等你」 and links to 设置 → 主动; the panel\'s icon says 「任务」',
      page.includes('id="brief-vs-nudge"') && page.includes("openSettings('sec-initiative')") && page.includes('class="work-label">任务</span>'));
    const form = page.slice(page.indexOf('id="routine-form-card"'), page.indexOf('id="routines-list"'));
    check('UX9 the new-task form: its buttons come after the options; a peak-hour time says 「勾上『闲时再跑』省一半」',
      form.indexOf('id="rt-save"') > form.indexOf('id="rt-off-peak"') && form.includes('id="rt-peak-hint"') && page.includes('function routinePeakHint()'));
  }

  // --- 手机和外网: one 出门在外 with the three ways (walkthrough 4.1, 4.2; queued: the Tailscale relay card)
  {
    const html = await readText('../public/index.html');
    const raw = html.slice(html.indexOf('id="sec-pair"'), html.indexOf('id="sec-checkup"'));
    const machines = html.slice(html.indexOf('id="sec-machines"'), html.indexOf('id="sec-pair"'));
    const at = (id) => raw.indexOf(`id="${id}"`);
    check('UX10 手机和外网: one 「出门在外」 with three ways in the docs\' order - Tailscale (free) first, then your own relay (trial), then Lamplit 中转 (coming); the public address (Funnel) is an option inside the Tailscale part; no heading twice',
      at('outside-ways') > 0 && at('tsx-box') > at('outside-ways') && at('tunnel-box') > at('tsx-box') && at('lamplit-relay-soon') > at('tunnel-box')
      && at('funnel-enabled') > at('tsx-box') && at('funnel-enabled') < at('tunnel-box')
      && !raw.includes('不用 Tailscale：用你的云服务器中转（试验）') && !raw.includes('外网访问（手机不用装 Tailscale）'));
    check('UX11 the Tailscale relay on your server moved from 机器 to the Tailscale part of 手机和外网, named 「Tailscale 加速（国内中转站）」, with one line on how it differs from 自建中转; the checkup\'s button goes there',
      !machines.includes('id="relay-box"') && at('relay-box') > at('tsx-box') && at('relay-box') < at('tunnel-box') && raw.includes('Tailscale 加速（国内中转站）')
      && /和下面的「自建中转」不一样/.test(raw) && page.includes("action: { kind: 'settings', target: 'sec-pair', label: 'Tailscale 加速' }"));
    check('UX12 the titles of these parts are in normal case (not TAILSCALE), and a phone on a cable is pointed to 机器',
      page.includes('.pair-title {') && raw.includes('class="pair-title"') && raw.includes('用数据线让机器人操作安卓手机'));
    const server = await readText('../src/server.mjs');
    check('UX13 switching to a machine that lets nothing in says so for any device, and where to turn it on (not 「允许手机连接」 as if it were about phones only)',
      !server.includes('没有打开允许手机连接，先在它上面打开再试') && server.includes('现在不让别的设备连进来') && page.includes('这个开关在电脑上的 Lamplit 应用里'));
  }

  // --- 机器: what is said there (walkthrough 5.1-5.4)
  {
    check('UX14 机器: no 「「全部机器」里能看到」 with one machine; no 「在 Lamplit 客户端里」 (you are in it); no desktop-kind note on Windows; adding a home computer does not prefill 「ubuntu」 and says how to find its address; Cancel goes back to 机器; no 「下一版」',
      !page.includes('「全部机器」里能看到每台机器上的助手') && !page.includes('在 Lamplit 客户端里「添加机器」') && page.includes('点下面「添加机器」把旧电脑或云服务器接进来')
      && page.includes('Windows 运行 ipconfig') && page.includes("kind === 'cloud' ? 'ubuntu' : ''") && page.includes("openSettings('sec-machines')") && !page.includes('下一版再做'));
  }

  // --- The sidebar and the machine menu (walkthrough 3.1, 3.2, 3.4, 3.6)
  // 1.5.59: no 「最近」 at all (the same chats twice): the filters 「N 件等你」 / 「N 个在做」 instead.
  check('UX15 the machine menu in a browser also ends with 「添加一台机器…」; a new assistant opens when made; no 「最近」 listing chats twice (1.5.59); this machine\'s chat title names it when there are others',
    page.includes('data-machine-add="1">添加一台机器…</button>') && page.includes('selectBot(made.id)') && !page.includes('RECENT_FROM') && page.includes('renderRosterFilters(list)')
    && page.includes('rosterChats().length > 1 ? `${bot.name} · ${machineDisplayName()}`'));
  check('UX16 a self-made assistant\'s first buttons: 「你会做什么？」 and one 「帮我…」 from its role, not fragments like 「打分排序」',
    page.includes("const starts = ['你会做什么？'"));

  // --- Blender in 连接应用 (queued): the official Blender Lab server, on this computer, every step asked
  {
    const M = await import('../src/mcp.mjs');
    const b = M.MCP_CATALOG.find((e) => e.id === 'blender');
    check('UX17 Blender is in the catalog as a local app: the official Blender Lab server (blender-mcp, from projects.blender.org/lab/blender_mcp), Blender 5.1+ and the add-on from the Blender Lab repository; the card warns it runs code with no guards and says to back up .blend files',
      b && b.local === true && b.transport === 'stdio' && b.command === 'blender-mcp' && b.askEvery === true
      && /projects\.blender\.org\/lab\/blender_mcp/.test(b.help) && /lab\.blender\.org/.test(b.help) && /5\.1/.test(b.help) && /\.blend/.test(b.warn || '') && /没有防护|不设防/.test(b.warn || ''),
      JSON.stringify(b || null).slice(0, 200));
    const src = await readText('../src/mcp.mjs');
    check('UX18 Blender\'s tools ask every time by default, even ones that say they only read (it runs code inside Blender); the page shows the warning on the tile',
      src.includes('const askEvery = Boolean(catalog.find((e) => e.id === cfg.catalogId)?.askEvery);') && src.includes('const readOnly = !askEvery && toolLooksReadOnly(t);')
      && src.includes('...(e.warn ? { warn: e.warn } : {})') && page.includes("if (app.warn) box.appendChild(el('div', 'row-note warn-note', app.warn));"));
  }

  // --- Settings in plain words (walkthrough #4, 2.1, 4.5, 6.1, 6.2, 6.4, 6.5, 6.6)
  {
    const P = await import('../src/providers.mjs');
    const cat = P.publicProviderCatalogue();
    const doubao = cat.find((p) => p.name === 'doubao');
    check('UX19 豆包 is in the provider list (Volcengine Ark, OpenAI-compatible), as the site says; the first screen says each provider in a few plain words, not a model name; the demo says it costs nothing',
      doubao && doubao.baseUrl === 'https://ark.cn-beijing.volces.com/api/v3' && /豆包/.test(doubao.label) && cat.find((p) => p.name === 'moonshot')?.blurb
      && page.includes("ONBOARD_WHY[name] || p?.blurb || ''") /* 1.5.61: three providers, said why */ && !page.includes('`默认模型 ${p.models[0]}`') && /不花钱/.test(cat.find((p) => p.name === 'mock')?.note || ''), JSON.stringify(doubao || null));
    check('UX20 the model page in the demo hides 接口地址 / 模型 / API 密钥',
      page.includes("const demo = provider === 'mock';") && page.includes("for (const id of ['set-baseurl', 'set-model', 'set-apikey'])"));
    check('UX21 成本 leads with one line of money (「大约花了」, 「一个月约」), or what to do when the price is unknown; the details fold; 「按助手」 not 「按机器人」; Lamplit\'s own calls are named',
      page.includes('id="usage-headline"') && page.includes('大约花了') && page.includes('一个月约') && page.includes('把每百万 tokens 的价格填到下面「模型单价」里')
      && page.includes('<summary>明细</summary>') && page.includes('>按助手</div>') && page.includes("'Lamplit 自己（测试连接、体检、翻译）'"));
    const server = await readText('../src/server.mjs');
    check('UX22 命令隔离 is said one way in plain words (体检, 边界, the card): 「机器人跑命令时用的是你的账户」, no 「本机密钥，绕过」',
      server.includes('机器人跑命令时用的是你的账户') && !server.includes('理论上能读到 Lamplit 的本机密钥') && page.includes('机器人跑命令时用的是你的账户') && agent.includes('机器人跑命令时用的是你的账户'));
    check('UX23 审批\'s chips are its own settings only (其他位置 and sudo live in 边界); on Windows 边界 says 管理员权限, not sudo',
      !page.includes("['sudo', policy.sudo === 'allow'") && !page.includes("['其他位置', policy.outside") && page.includes("$('sudo-head').textContent = win ? '管理员权限'"));
    check('UX24 连接应用 says 「接口」 not 「MCP」 to a newcomer; X says first that it needs an X developer account',
      !page.includes('把别的应用（MCP 服务器）接进来') && !(await readText('../src/mcp.mjs')).match(/desc: '[^']*官方 MCP/) && page.includes('要先有一个 X 开发者账号'));
    check('UX25 the built-in skills show Chinese names; the file path is inside the fold',
      page.includes("'release-check': '发布前检查'") && page.includes('SKILL_NAMES[skill.name] || skill.name'));
  }

  // --- Phone width and the outside door (walkthrough 4.3, 4.4)
  check('UX26 where the 8-digit code cannot be used, the pairing page has no code box and no 「找不到配对码？」, only how to scan; a wide table on a phone fades at the edge to say it scrolls',
    page.includes('function authCodeMode()') && page.includes("for (const id of ['auth-code', 'auth-connect', 'auth-help'])") && page.includes('.perm-table-wrap.scrolls'));

  // --- The yellow notice bar in the light theme (design study)
  {
    const css = await readText('../public/app/style.css');
    const light = css.slice(css.indexOf('html[data-theme="light"] {'), css.indexOf('}', css.indexOf('html[data-theme="light"] {')));
    check('UX27 the yellow notice bar\'s text is a theme token (pale yellow on dark, dark amber on light), not a fixed #fde68a',
      /\.conn-banner \{[^}]*color: var\(--warn-text\);/.test(css) && /--warn-text: #e3b866;/.test(css) && /--warn-text: #7a4c00;/.test(light) && !css.includes('#fde68a'));
  }

  // --- Beginner test of 1.5.54
  {
    const css = await readText('../public/app/style.css');
    check('BT54-1 a browser paired from the confirm box while the page could not load reloads by itself (it said 「连不上 Lamplit」 until 「重试」)',
      page.includes('state.fatal = true;') && page.includes('if (state.fatal) { location.reload(); return; }'));
    check('BT54-2 the add-machine dialog\'s own 「取消」 also goes back to 机器', page.includes("$('vnc-cancel').addEventListener('click', cancelMachineModal);"));
    check('BT54-3 cost: the month comes with the daily pace it is from (「照最近每天约」); the price goes in 「模型单价」; the three tables fold under 明细 too',
      page.includes('照最近每天约') && page.includes('填到下面「模型单价」里') && page.indexOf('id="usage-bots"') > page.indexOf('<summary>明细</summary>') && page.indexOf('id="usage-bots"') < page.indexOf('</details><!-- usage-more -->'));
    check('BT54-4 no 「上面的云服务器中转」 (it is below now); with no QR code its buttons cannot be clicked; the chat title gets its machine name once the machines are known; the box\'s hint uses the name alone; the demo hides the key\'s 「显示」 too',
      !page.includes('或者试试上面的「云服务器中转」') && page.includes("$('qr-copy').disabled = true; $('qr-refresh').disabled = true;")
      && page.includes('function refreshChatTitle()') && page.includes("$(id)?.closest('.pw-wrap')") && !css.includes('placeholder-unused'));
    const t = await loadTranslator(readText);
    const v = t('没配（可选）：想说话代替打字，在「设置 → 模型」里填一个硅基流动的密钥。');
    check('BT54-5 English: the checkup\'s own lines read in English', !/[一-鿿]/.test(v) && !/[一-鿿]/.test(t('去设置模型')) && !/[一-鿿]/.test(t('连手机')) && !/[一-鿿]/.test(t('连不上：它可能关机了，或者网络不通。')) && !/[一-鿿]/.test(t('内存还剩 2.0 GB，处理器不忙。')), JSON.stringify({ v }));
  }

  check('BT54-6 after a reload the waiting line follows the attention data when it arrives: 「等你点头…」 when a card waits (it stayed 「正在处理…」), redrawn under the newest message',
    page.includes("const label = att?.needsYou || att?.asking ? '等你点头…' : '正在处理…';") && page.includes("if (working && !state.liveTurn?.bubble && row?.querySelector('.typing-label')?.textContent !== label) showTyping(typingBotId(), label);"));

  // --- English: no 「… on …」 garble (walkthrough 7.2)
  {
    const t = await loadTranslator(readText);
    const a = t('个人文件的电脑');
    const b = t('交给了「腾讯云」上的「策略」');
    const c = t('3天');
    check('UX6 English: a one-character rule (的 → on, 想 → wants to) is used only when the whole text comes out English; longer rules still translate',
      a === '个人文件的电脑' && /^Handed to/.test(b) && c === '3d', JSON.stringify({ a, b, c }));
  }
}
