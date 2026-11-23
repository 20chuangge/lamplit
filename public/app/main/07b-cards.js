'use strict';
// Cards you answer, redesign step 3 (1.5.58): plain titles, a risk tag, up to three lines of what will happen, buttons that say where things go, honest receipts, next steps after a reply.
//
// Display only. What a click sends (decide / decideParked in 06-live.js) and every
// rule on the hub (who may approve, what, default-deny, 「以后都允许」) are untouched:
// the words here are made from the tool and its arguments by fixed templates, and a
// model-written purpose (shell's `purpose`, 1.5.54) only ever names the card.

/* --- the headline ------------------------------------------------------ */
const CARD_RISK = { LOW: ['ok', '风险低'], MEDIUM: ['warn', '风险中'], HIGH: ['danger', '风险高'] };

/** The last part of a path, for a title (「旧报告.docx」, not the whole path). */
function cardFileName(p) {
  const s = String(p || '').trim().replace(/[\\/]+$/, '');
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/** A path as said on a card: no leading 「.\」, no trailing slash. */
function cardPathWords(p) {
  return truncate(String(p || '').trim().replace(/^\.[\\/]/, '').replace(/(.)[\\/]+$/, '$1'), 40);
}

/** A web address as its host (「example.com」), else the address cut short. */
function cardHost(u) {
  try { return new URL(String(u || '')).host || truncate(String(u || ''), 40); } catch { return truncate(String(u || ''), 40); }
}

/** A title that starts with 想 (「想删除一个文件」) without it: the card already says it waits for you. */
function plainTitle(title) {
  const s = String(title || '');
  if (!/^想.{2,}/.test(s)) return s;
  // In English the whole sentence is translated first: 「Wants to delete…」 -> 「Delete…」.
  const en = window.deskI18n?.lang === 'en' ? window.deskI18n.t(s) : '';
  if (en && /^Wants to \S/.test(en)) return en.replace(/^Wants to (\S)/, (_, c) => c.toUpperCase());
  return s.slice(1);
}

/** A command line's parts (`cd x && rm y | head`): each program with its arguments. */
function commandParts(command) {
  const out = [];
  for (const piece of String(command || '').split(/&&|\|\||;|\|/)) {
    const words = (piece.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
    if (!words.length) continue;
    let prog = String(words[0]).toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop();
    let args = words.slice(1);
    if (prog === 'sudo' && args.length) { prog = String(args[0]).toLowerCase(); args = args.slice(1); }
    if (/^(cd|pushd|popd|set|export|chcp|env|true)$/.test(prog)) continue;
    out.push({ prog, args });
  }
  return out;
}

/** A path in words, with its quotes: 「旧报告.docx」, 「下载」里所有 .msi 文件, 「下载」里的所有东西. */
function pathPhrase(p) {
  const s = cardPathWords(p);
  const ext = /^(?:(.*)[\\/])?\*\.(\w+)$/.exec(s);
  if (ext) return ext[1] ? `「${ext[1]}」里所有 .${ext[2]} 文件` : `所有 .${ext[2]} 文件`;
  if (/(^|[\\/])\*(\.\*)?$/.test(s)) {
    const dir = s.replace(/[\\/]?\*(\.\*)?$/, '');
    return dir ? `「${dir}」里的所有东西` : '这里的所有东西';
  }
  return `「${s}」`;
}

/** Arguments that are not options (-x, --x, /q). */
function plainArgs(args) {
  return args.filter((a) => a && !/^-/.test(a) && !/^\/[a-z?]{1,3}$/i.test(a));
}

const CMD_LOOK = /^(ls|dir|gci|get-childitem|tree|find|du|df|stat|where|get-item|cat|type|gc|get-content|head|tail|less|more|ping|tracert|traceroute|nslookup|ipconfig|ifconfig|netstat|test-netconnection|tasklist|ps|get-process|top|echo|write-output|write-host|printf|pwd|whoami|hostname|systeminfo)$/;
const CMD_INSTALLERS = /^(npm|pnpm|yarn|pip|pip3|winget|choco|scoop|apt|apt-get|brew|conda)$/;

/**
 * What a command line does, in words, from the program it runs and its plain
 * arguments (a fixed table; the code itself is under 技术细节). -> {title, kind}
 * kind: look | delete | move | write | install | net | run | stop | power | other
 */
function commandWords(command) {
  const parts = commandParts(command);
  const first = parts[0];
  if (!first) return { title: '运行一条命令', kind: 'other' };
  const { prog, args } = first;
  // Each path said in words: 「下载」里所有 .msi 文件, not 「下载\*.msi」 (1.5.58 beginner test).
  const plain = plainArgs(args).map(pathPhrase);
  if (/^(ls|dir|gci|get-childitem|tree|find|du|df|stat|where|get-item)$/.test(prog)) return { title: plain[0] ? `查看${plain[0]}里的文件` : '查看文件和文件夹', kind: 'look' };
  if (/^(cat|type|gc|get-content|head|tail|less|more)$/.test(prog)) return { title: plain[0] ? `读${plain[0]}的内容` : '读一个文件的内容', kind: 'look' };
  if (/^(ping|tracert|traceroute|nslookup|ipconfig|ifconfig|netstat|test-netconnection)$/.test(prog)) return { title: '查看网络状况', kind: 'look' };
  if (/^(tasklist|ps|get-process|top)$/.test(prog)) return { title: '查看正在运行的程序', kind: 'look' };
  if (CMD_LOOK.test(prog)) return { title: '查看这台电脑的情况', kind: 'look' };
  if (/^(rm|del|erase|rd|rmdir|remove-item|ri)$/.test(prog)) return { title: plain[0] ? `删除${plain[0]}` : '删除文件', kind: 'delete' };
  if (/^(mv|move|move-item|mi|ren|rename|rename-item)$/.test(prog)) {
    if (plain.length >= 2) return { title: `把${plain[0]}移到${plain[1]}`, kind: 'move' };
    return { title: plain[0] ? `移动${plain[0]}` : '移动文件', kind: 'move' };
  }
  if (/^(cp|copy|copy-item|cpi|xcopy|robocopy)$/.test(prog)) {
    if (plain.length >= 2) return { title: `把${plain[0]}复制到${plain[1]}`, kind: 'write' };
    return { title: plain[0] ? `复制${plain[0]}` : '复制文件', kind: 'write' };
  }
  if (/^(mkdir|md|new-item|ni|touch)$/.test(prog)) return { title: plain[0] ? `新建${plain[0]}` : '新建文件或文件夹', kind: 'write' };
  if (prog === 'git') return { title: '用 git 处理代码仓库', kind: 'other' };
  if (CMD_INSTALLERS.test(prog)) return /\b(install|add|i|upgrade|update)\b/i.test(args.join(' ')) ? { title: `用 ${prog} 安装软件`, kind: 'install' } : { title: `用 ${prog} 管理软件`, kind: 'install' };
  if (/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(prog)) return { title: '访问一个网址', kind: 'net' };
  if (/^(taskkill|kill|pkill|stop-process)$/.test(prog)) return { title: '关掉一个程序', kind: 'stop' };
  if (/^(shutdown|restart-computer|stop-computer)$/.test(prog)) return { title: '关机或重启这台电脑', kind: 'power' };
  if (/^(python|python3|py|pythonw|node|nodejs|deno|bun|ruby|perl|php|java|powershell|pwsh|bash|sh|cmd)$/.test(prog)) {
    const script = plainArgs(args).find((a) => /\.(py|js|mjs|cjs|ts|rb|pl|php|jar|ps1|sh|bat|cmd)$/i.test(a));
    return { title: script ? `用 ${prog} 运行「${cardFileName(script)}」` : `用 ${prog} 运行一段程序`, kind: 'run' };
  }
  return { title: `运行一条命令（${prog}）`, kind: 'other' };
}

/** The card's headline: what will happen, in words (deterministic per tool and arguments). */
function cardTitle(data, info, many) {
  if (many) return `运行 ${many.length} 条查看类命令`;
  const args = safeArgs(data.args);
  if (data.draft) return draftTitle(data.draft);
  if (data.adjust || data.handoff) return plainTitle(info.title);
  const name = cardFileName(args.path);
  switch (data.tool) {
    case 'shell':
      // A purpose the bot wrote (1.5.54) names the card; the lines under it are made from the command itself.
      return args.purpose ? info.title : commandWords(args.command).title;
    case 'fs_delete':
      if (!name) break;
      return args.recursive ? `删除文件夹「${name}」和里面的所有东西` : `删除「${name}」`;
    case 'fs_write':
      if (!name) break;
      return args.mode === 'append' ? `往「${name}」末尾加内容` : `写入文件「${name}」`;
    case 'fs_mkdir': if (name) return `新建文件夹「${name}」`; break;
    case 'fs_read': if (name) return `读文件「${name}」`; break;
    case 'fs_list': if (name) return `看看「${name}」里有什么`; break;
    case 'http_fetch':
      if (!args.url) break;
      return /^(GET|HEAD|)$/i.test(String(args.method || '')) ? `打开网址 ${cardHost(args.url)}` : `向 ${cardHost(args.url)} 发送数据`;
    case 'browser_open': if (args.url) return `打开网页 ${cardHost(args.url)}`; break;
    case 'browser_download': if (args.url) return `从 ${cardHost(args.url)} 下载一个文件`; break;
    default: break;
  }
  return plainTitle(info.title);
}

/** A draft that is an answer to someone (a comment, a reply), not a post of its own. */
function isReplyDraft(d) {
  return Boolean(d) && (d.kind === 'reply' || /评论|回复/.test(String(d.channel || '')));
}

/** Where a draft goes, short: 「微信 · 王姐」 -> 「微信」. */
function draftPlace(d) {
  const c = String(d?.channel || '').split(/\s*[·・|]\s*/)[0].trim();
  return c || '外部';
}

function draftTitle(d) {
  if (d.channel === '邮件') return '发一封邮件';
  if (d.channel === 'X') return d.kind === 'reply' ? '在 X 上回复一条帖子' : '在 X 上发一条帖子';
  if (isReplyDraft(d)) return `回复：${d.channel}`;
  return `发到「${d.channel}」`;
}

/** The buttons' words: where things go (「发到小红书」, 「允许这一次」), never 「确定」 or 「发送」. */
function cardWords(data, many) {
  const think = thinkButtons(data);
  if (think) return think;
  if (many) return { yes: `允许这 ${many.length} 条`, yesTip: '这几条都会运行，不再一条条问', no: '不要', noTip: '都不执行，把「不行」告诉它' };
  return { yes: '允许这一次', yesTip: '只批准这一步，下次同样的操作还会问你', no: '不要', noTip: '不执行，把「不行」告诉它' };
}

/** The main button on a draft: 「发到小红书」, 「发出这封邮件」, 「回复」. */
function draftYes(d) {
  if (d.channel === '邮件') return '发出这封邮件';
  if (d.channel === 'X') return d.kind === 'reply' ? '在 X 上回复' : '发到 X';
  if (isReplyDraft(d)) return '回复';
  const place = draftPlace(d);
  return [...place].length <= 8 ? `发到${place}` : '发出去';
}

/* --- the risk tag ------------------------------------------------------ */
/** What kind of step it is, in two to four words (only from the tool and its arguments). */
function cardKindWords(data, looking) {
  const args = safeArgs(data.args);
  if (looking) return '只是查看';
  if (data.draft) return '会发出去';
  if (data.handoff || ['machine_switch', 'bot_message', 'bot_pass', 'group_handover', 'task_move', 'cli_agent_run'].includes(data.tool)) return '交给别人做';
  if (data.adjust || ['settings_update', 'bot_update', 'bot_create', 'bot_delete', 'routine_create', 'routine_update', 'routine_delete', 'tool_request'].includes(data.tool)) return '会改设置';
  if (['image_generate', 'video_generate', 'budget_extend'].includes(data.tool)) return '会花钱';
  if (data.tool === 'fs_delete') return '会删东西';
  if (['fs_write', 'fs_mkdir'].includes(data.tool)) return '会改文件';
  if (data.tool === 'shell') {
    const kind = commandWords(args.command).kind;
    if (kind === 'look') return '应该只是查看';
    if (kind === 'delete') return '会删东西';
    if (kind === 'move' || kind === 'write') return '会改文件';
    if (kind === 'install') return '会装软件';
    if (kind === 'power' || kind === 'stop') return '会关程序';
  }
  return '';
}

/** Green, amber or red for the risk level the hub gave this step (LOW / MEDIUM / HIGH). */
function riskTag(data, looking) {
  // The colour is always the hub's level, look-only commands included: a guess that a command only
  // reads can be wrong, and green says relax (the coordinator, after the 1.5.58 beginner test).
  const level = CARD_RISK[String(data.risk || '').toUpperCase()];
  if (!level) return null;
  const words = cardKindWords(data, looking);
  const tag = el('span', `approval-risk ${level[0]}`, words ? `${words} · ${level[1]}` : level[1]);
  tag.title = level[0] === 'ok' ? '低风险：只读或只在工作区里' : level[0] === 'warn' ? '中风险：会改动东西，多半能改回来' : '高风险：改了可能回不去、会发出去或花钱';
  return tag;
}

/* --- 它会做什么: up to three lines ------------------------------------ */
function cardLines(data, info, { many = null, looking = false, words = null } = {}) {
  const args = safeArgs(data.args);
  const where = data.from?.machine ? `「${data.from.machine}」` : '这台电脑';
  const lines = [];
  const add = (s) => { const v = String(s || '').trim(); if (v && !lines.includes(v)) lines.push(truncate(v, 110)); };
  if (data.draft) {
    const d = data.draft;
    add(isReplyDraft(d) ? `发到：${d.channel}` : `发到：${d.channel}${d.to ? `（${d.to}）` : ''}`);
    add(data.tool === 'post_draft' ? `点「${words?.yes || draftYes(d)}」后，它照框里的字去发，一字不改` : `点「${words?.yes || draftYes(d)}」就发出去，发的就是框里的字`);
    add('框里的字可以直接改；不想发就点「不发了」');
    return lines;
  }
  if (data.adjust) { add(info.impact); return lines; }
  if (data.handoff) { for (const [k, v] of info.facts) add(`${k}：${v}`); add(info.impact); return lines; }
  if (many) {
    add(`在${where}上运行 ${many.length} 条命令，命令在「技术细节」里`);
    add('这些命令只是查看，不会改动任何东西');
    return lines;
  }
  switch (data.tool) {
    case 'shell': {
      const said = commandWords(args.command);
      // The purpose is the bot's own words: the program actually run is said next to it, from the command.
      if (args.purpose) add(`实际要做的：${said.title}`);
      add(`在${where}上用你的账户运行；命令在「技术细节」里`);
      // What can be undone, said plainly: a command's changes are not kept (trash.mjs covers file tools only).
      add(looking ? '只是查看，不会改动任何东西' : said.kind === 'look' ? '看起来只是查看，不会改动东西' : '命令做的改动，Lamplit 没法撤销');
      break;
    }
    case 'fs_delete':
      add(`位置：${cardPathWords(args.path)}`);
      if (args.recursive) add('连同文件夹里的所有东西一起删');
      // In the workspace a delete is kept for 7 days (trash.mjs); outside it, it is gone (its risk is HIGH there).
      add(String(data.risk || '').toUpperCase() === 'MEDIUM' ? '在工作区里：删掉后 7 天内一般能撤销（很大的文件除外）' : '不在工作区里：删掉后 Lamplit 没法撤销');
      break;
    case 'fs_write':
      add(`位置：${cardPathWords(args.path)}`);
      add(info.impact);
      if (String(data.risk || '').toUpperCase() !== 'HIGH') add('在工作区里：7 天内一般能撤销');
      break;
    default:
      for (const [k, v] of info.facts) {
        if (lines.length >= 2) break;
        add(`${k}：${v}`);
      }
      add(info.impact);
      break;
  }
  return lines.slice(0, 3);
}

function linesNode(lines) {
  const box = el('div', 'approval-lines');
  box.appendChild(el('div', 'approval-lines-k', '它会做什么'));
  const list = el('ul', 'approval-lines-list');
  for (const line of lines) list.appendChild(el('li', null, line));
  box.appendChild(list);
  return box;
}

/* --- Enter / Esc on the focused card (desktop) -------------------------- */
function armCardKeys(card, main, no) {
  card.tabIndex = 0;
  card.setAttribute('aria-keyshortcuts', 'Enter Escape');
  card.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !card.classList.contains('pending')) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    // Enter on the card itself (a focused button keeps its own Enter); Esc anywhere but a box being typed in.
    if (e.key === 'Enter' && e.target === card && !main.disabled) { e.preventDefault(); main.click(); }
    else if (e.key === 'Escape' && !typing && !no.disabled) { e.preventDefault(); no.click(); }
  });
  return el('div', 'approval-keys', `按 Enter = ${main.textContent}，Esc = ${no.textContent}`);
}

/** A card that just came in gets the keys, unless you are typing somewhere. */
function focusNewCard(card) {
  const active = document.activeElement;
  if (card?.classList.contains('pending') && (!active || active === document.body)) {
    try { card.focus({ preventScroll: true }); } catch { /* an old browser: no shortcut */ }
  }
}

/** The phone step that puts workspace files into the album (1.5.65), for describeTool. */
function albumStepText(out, args, set) {
  const files = Array.isArray(args.paths) ? args.paths.map(String) : [];
  out.label = '放进手机相册';
  out.title = '想把文件放进你的手机相册';
  out.impact = '工作区里的文件直接传到你自己的手机上：图片和视频进相册，其他文件进「下载」。不经过任何公共网站。';
  out.detail = files.length ? `${files.length} 个文件` : '';
  if (files.length) set('文件', '文件', files.slice(0, 9).join('、') + (files.length > 9 ? `，等 ${files.length} 个` : ''));
  if (args.machine) set('手机连在', '手机连在', args.machine);
}

/** What save_to_album put on the phone (1.5.65), for the step's line: 「放进了手机相册：9 张」. */
function albumReceiptText(out) {
  const p = Number(out?.pictures) || 0;
  const v = Number(out?.videos) || 0;
  const d = Number(out?.downloads) || 0;
  const album = v ? [p ? `${p} 张图` : '', `${v} 段视频`].filter(Boolean).join('、') : p ? `${p} 张` : '';
  const text = [album ? `放进了手机相册：${album}` : '', d ? `放进了手机的「下载」：${d} 个文件` : ''].filter(Boolean).join('；');
  const missed = Array.isArray(out?.failed) ? out.failed.length : 0;
  return missed ? `${text}（${missed} 个没放成）` : text;
}

/* --- receipts: what actually happened --------------------------------- */
function receiptRow(kind, text, undo = null) {
  const row = el('div', `approval-receipt ${kind}`);
  row.appendChild(el('span', 'approval-receipt-icon', kind === 'ok' ? '✓' : kind === 'no' ? '✕' : kind === 'undone' ? '↺' : '…'));
  row.appendChild(el('span', 'approval-receipt-text', text));
  if (undo) row.appendChild(undo);
  return row;
}

/** The answer given, before the step ran: never 「已发送」 for something not sent yet. */
function decidedReceipt(data, decision, note, { edited = false } = {}) {
  const good = decision === 'approved' || decision === 'approve';
  if (!good && /^已取消/.test(String(note || ''))) return receiptRow('no', `已取消：${String(note).replace(/^已取消[：:]\s*/, '')}`);
  if (decision === 'timeout') return receiptRow('no', '等太久没人点，这一步没做');
  if (!good) return receiptRow('no', data.draft ? '不发了：没有发出去，已经告诉它了' : '没做：已经告诉它不要做');
  if (data.draft) {
    const done = edited ? '已定稿（你改过）' : '已定稿';
    return data.tool === 'post_draft'
      ? receiptRow('ok', `${done}：它现在照框里的字去「${draftPlace(data.draft)}」发，发好了会在对话里告诉你`)
      : receiptRow('wait', `${done}，正在发到「${draftPlace(data.draft)}」…`);
  }
  if (data.adjust) return receiptRow('wait', '同意了，正在改…');
  if (data.handoff) return receiptRow('wait', `同意了，正在交给「${data.handoff.machine}」…`);
  return receiptRow('wait', '允许了，它在做这一步…');
}

/** What the step did once it ran (its result), with 撤销 only where an undo really exists. */
function resultReceipt(data, ok, output) {
  const out = output && typeof output === 'object' ? output : {};
  if (!ok) {
    // A command that failed says why in its first error line (stderr), else its exit code.
    const known = { FS_NOT_FOUND: '找不到这个文件，可能已经删了或改了名', FS_NEEDS_RECURSIVE: '这是一个文件夹', FS_REFUSED: '这一步不允许做', ADJUST_NOTHING: '没有要改的，和现在一样' }[out.error?.code];
    const why = known || out.error?.message || out.message || String(out.stderr || '').trim().split('\n')[0] || (out.exitCode != null ? `exit code ${out.exitCode}` : '');
    const msg = truncate(String(why || '出错了').trim(), 120);
    return receiptRow('no', data.draft ? `没发出去：${msg}` : `没做成：${msg}`);
  }
  if (data.draft) return data.tool === 'post_draft' ? null : receiptRow('ok', `已经发到「${draftPlace(data.draft)}」`);
  if (data.adjust) return receiptRow('ok', '改好了，马上生效；下面可以撤销');
  if (data.handoff || data.tool === 'machine_switch') {
    const m = data.handoff?.machine || out.machine || '';
    return out.queued ? receiptRow('wait', `「${m}」现在连不上，开机后再交过去`) : receiptRow('ok', m ? `已交给「${m}」` : '交过去了');
  }
  const name = cardFileName(out.path || safeArgs(data.args).path);
  // Undone already (here, or with the turn's 「改了 N 个文件」): said so, no button.
  if (out.undo && (state.undoneFiles?.has(out.undo) || (data.turnId && state.undone?.has(data.turnId)))) {
    return receiptRow('undone', data.tool === 'fs_delete' ? `「${name}」删掉后又恢复了` : `「${name}」已恢复成这一步之前的样子`);
  }
  const undo = out.undo ? fileUndoButton(out.undo, name, data.turnId) : null;
  if (data.tool === 'fs_delete') return receiptRow('ok', `删掉了「${name}」${undo ? '（7 天内能撤销）' : ''}`, undo);
  if (data.tool === 'fs_write') return receiptRow('ok', `写好了「${name}」`, undo);
  return receiptRow('ok', '做完了');
}

/** 撤销 one file change (the same undo the turn's 「改了 N 个文件」 uses, 1.5.8). */
function fileUndoButton(id, name, turnId = '') {
  const btn = el('button', 'btn ghost tiny approval-undo', '撤销');
  btn.type = 'button';
  btn.title = '把这个文件恢复成这一步之前的样子（7 天内有效）';
  btn.addEventListener('click', async () => {
    if (!(await askStep(`把「${name}」恢复成这一步之前的样子？`, '这一步对这个文件做的改动会撤掉（7 天内有效）。', '恢复'))) return;
    btn.disabled = true;
    try {
      const res = await api(chatUndoUrl(), { method: 'POST', body: { ids: [id] } });
      const r = (res.results || [])[0] || {};
      if (!r.ok && !/已经撤销过/.test(r.error || '')) throw new Error(r.error || '没能撤销');
      (state.undoneFiles ||= new Set()).add(id);
      // The turn's 「删了 N 个文件」 follows when every file of the turn is back.
      const all = turnId ? (turnChanges(state.messages).get(turnId) || []) : [];
      if (all.length && all.every((c) => state.undoneFiles.has(c.id))) state.undone.add(turnId);
      for (const card of messagesEl.querySelectorAll('.att-doc')) card.recheck?.();
      if (isGroupMode()) btn.replaceWith(el('span', 'tiny muted', r.ok ? '已撤销' : '已经撤销过了'));
      else renderMessages();
    } catch (err) {
      btn.disabled = false;
      toast(`没能撤销：${err.message}`, true);
    }
  });
  return btn;
}

// 「以后都允许」 answers, noted on this device: the history does not keep which card it was,
// and the chat is drawn again from it when the turn ends. Display only (the hub keeps the permission).
const REMEMBERED_CARDS = 'lamplit.rememberedCards';
function rememberedCards() {
  try { return JSON.parse(localStorage.getItem(REMEMBERED_CARDS) || '{}') || {}; } catch { return {}; }
}
function noteRemembered(approvalId, patch) {
  if (!approvalId) return;
  const all = rememberedCards();
  all[approvalId] = { ...(all[approvalId] || {}), ...patch };
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete all[id];
  try { localStorage.setItem(REMEMBERED_CARDS, JSON.stringify(all)); } catch { /* private mode: this session only */ }
}

/** What 「以后都允许」 covers, in words: the hub's key is shell:<program>, <file tool>:<folder>, or a tool. */
function rememberWords(remember) {
  const key = String(remember?.key || '');
  const shell = /^shell:(.+)$/.exec(key);
  if (shell) {
    const what = { look: '查看类的命令', delete: '删文件的命令', move: '移动文件的命令', write: '改文件的命令', install: '装软件的命令', run: '运行程序的命令', net: '访问网址的命令', stop: '关程序的命令', power: '关机的命令' }[commandWords(shell[1]).kind] || '这类命令';
    return `${what}（程序：${shell[1]}）`;
  }
  const file = /^(fs_\w+):(.+)$/.exec(key);
  if (file) {
    const verb = { fs_write: '写文件', fs_mkdir: '建文件夹', fs_delete: '删文件', fs_read: '读文件', fs_list: '查看文件', fs_move: '移动文件', fs_copy: '复制文件' }[file[1]] || '改文件';
    const folder = cardFileName(file[2]);
    return !folder || /^workspace$/i.test(folder) ? `在工作区里${verb}` : `在「${folder}」文件夹里${verb}`;
  }
  return String(remember?.label || key);
}

/** 「以后都允许」 said: one line, and 撤销 takes it back (the same as 机器人设置 → 已记住的权限). */
function rememberedRow(botId, remember, approvalId = '') {
  const label = rememberWords(remember);
  if (!botId) return receiptRow('ok', `以后${label}都不再问你`);
  if (rememberedCards()[approvalId]?.undone) return receiptRow('ok', `以后${label}都不再问你 · 已撤销：以后又会先问你`);
  const btn = el('button', 'btn ghost tiny approval-undo', '撤销');
  btn.type = 'button';
  btn.title = '以后这类操作又会先问你';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const got = await api(`/api/bots/${encodeURIComponent(botId)}`);
      const bot = got?.bot || got || {};
      const allowed = (Array.isArray(bot.policy?.allowed) ? bot.policy.allowed : []).filter((a) => a.key !== remember.key);
      await api(`/api/bots/${encodeURIComponent(botId)}`, { method: 'PATCH', body: { policy: { ...(bot.policy || {}), allowed } } });
      noteRemembered(approvalId, { undone: true });
      btn.replaceWith(el('span', 'tiny muted', '已撤销：以后又会先问你'));
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  });
  return receiptRow('ok', `以后${label}都不再问你`, btn);
}

/** The card was answered (here, elsewhere, or by Lamplit): its receipt in place of the buttons. */
function cardReceipt(card, decision, note) {
  const data = card.cardData || {};
  const wrap = el('div', 'approval-receipts');
  const remembered = card.dataset.always === '1' && data.remember?.key ? data.remember : null;
  const main = decidedReceipt(data, decision, note, { edited: card.dataset.edited === '1' });
  main.classList.add('receipt-main');
  wrap.appendChild(main);
  if (remembered && (decision === 'approved' || decision === 'approve')) {
    const botId = card.dataset.machine ? '' : (data.botId || state.botId);
    noteRemembered(data.approvalId, { botId, key: remembered.key, label: remembered.label });
    wrap.appendChild(rememberedRow(botId, remembered, data.approvalId));
  }
  return wrap;
}

/** The step behind an answered card ran: its receipt says what it did (live, tool.result). */
function settleFromResult(ev) {
  if (!ev?.callId) return;
  const card = messagesEl.querySelector(`.approval[data-call-id="${cssEscape(ev.callId)}"]`);
  if (!card || !card.classList.contains('resolved') || card.dataset.decision !== 'approve') return;
  const row = resultReceipt(card.cardData || {}, ev.ok !== false, ev.result);
  const main = card.querySelector('.approval-receipt.receipt-main');
  if (row && main) { row.classList.add('receipt-main'); main.replaceWith(row); }
}

/** An answered card drawn from the history: the step's own result when it is there. */
function historyReceipt(data) {
  const good = data.decision === 'approved' || data.decision === 'approve';
  const wrap = el('div', 'approval-receipts');
  const ran = good ? historyResult(data) : null;
  let row = ran ? resultReceipt(data, ran.ok, ran.output) : null;
  const done = data.edited ? '已定稿（你改过）' : '已定稿';
  // A post the bot publishes itself afterwards: whether it went out is in its reply below, not known here.
  if (!row && good && data.draft && data.tool === 'post_draft') row = receiptRow('ok', `${done}：交给它照框里的字去「${draftPlace(data.draft)}」发，发没发成看它下面的回复`);
  // Answered, and the step's own result is not in this chat (another device, an older turn): said as it is.
  if (!row && good) row = receiptRow('ok', data.draft ? done : data.adjust || data.handoff ? '你同意了' : '你允许了这一步');
  if (!row) row = decidedReceipt(data, data.decision, data.note, { edited: Boolean(data.edited) });
  row.classList.add('receipt-main');
  wrap.appendChild(row);
  const said = good ? rememberedCards()[data.approvalId] : null;
  if (said?.key) wrap.appendChild(rememberedRow(said.botId || '', said, data.approvalId));
  return wrap;
}

/** The tool step that ran after this answer, in the same turn (from the chat's history). */
function historyResult(data) {
  const msgs = state.messages || [];
  const i = msgs.findIndex((m) => m.role === 'approval' && m.approvalId && m.approvalId === data.approvalId);
  if (i < 0) return null;
  for (let j = i + 1; j < msgs.length; j += 1) {
    const m = msgs[j];
    if (m.turnId !== msgs[i].turnId || m.role === 'approval') break;
    if (m.role === 'tool' && m.name === data.tool) return m;
  }
  return null;
}

/* --- next steps after a reply ----------------------------------------- */
const NEXT_MARK = /^(?:\d{1,2}[.、)）]|[-•*]|[A-Da-d][.、)）])\s*/;

/**
 * What you would most likely say next, read off the reply itself (no model):
 * the short choices a question ends with (「1. 移到回收站 2. 打包 3. 先不动」),
 * or 好 / 先不用 for a yes-or-no question at its end. At most 4.
 */
function nextStepChoices(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 1500) return [];
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (/[？?]/.test(s) && NEXT_MARK.test(last)) {
    const opts = [];
    for (let i = lines.length - 1; i >= 0 && NEXT_MARK.test(lines[i]); i -= 1) {
      opts.unshift(lines[i].replace(NEXT_MARK, '').replace(/\*\*/g, '').replace(/[。；;，,]$/, '').trim());
    }
    if (opts.length >= 2 && opts.length <= 4 && opts.every((o) => o && [...o].length <= 18)) return opts;
  }
  if (/(要不要|需要我|要我|我可以|可以吗|好吗|行吗|是否需要)[^。！？\n]*[？?]$/.test(s)) return ['好', '先不用'];
  return [];
}

function dropNextSteps() {
  messagesEl.querySelectorAll('.next-steps').forEach((n) => n.remove());
}

/** Under the newest reply, when the chat is idle: up to 4 buttons, the first one suggested (violet border). */
function showNextSteps() {
  dropNextSteps();
  if (isGroupMode() || state.attention?.items?.[currentChatKey()]?.working) return;
  if (messagesEl.querySelector('.approval.pending, .starter-row, .typing-row')) return;
  const last = [...(state.messages || [])].reverse().find((m) => m.role !== 'status' && (m.role !== 'tool' || isActionCard(m.name, m)));
  if (!last || last.role !== 'assistant' || last.system) return;
  const choices = nextStepChoices(last.text);
  if (!choices.length) return;
  const row = el('div', 'next-steps');
  row.setAttribute('aria-label', '下一步');
  // Suggested (violet): 好 for a yes-or-no question, or the choice the reply itself recommends - put first.
  // Not simply the first one: 「移到回收站」 is not a suggestion because it was listed first (1.5.58 beginner test).
  const pick = choices[0] === '好' ? 0 : choices.findIndex((c) => /推荐|建议/.test(c));
  if (pick > 0) choices.unshift(...choices.splice(pick, 1));
  choices.forEach((text, i) => {
    const chip = el('button', `next-step${i === 0 && pick >= 0 ? ' first' : ''}`, text);
    chip.type = 'button';
    if (i === 0 && pick >= 0) chip.title = '推荐';
    chip.addEventListener('click', () => {
      const composer = $('composer');
      if (!composer || composerBlocked()) return;
      dropNextSteps();
      composer.value = text;
      autoGrow(composer);
      send();
    });
    row.appendChild(chip);
  });
  messagesEl.appendChild(row);
}

/* --- a group of replies: 「全部回复（N）」 ------------------------------ */
// One turn asks one step at a time, so replies wait together only across chats
// and machines: they are put together in 「等你确认」.
const replyRows = new Map(); // "machine|id" -> the row drawn for it (keeps an edit being typed, and a receipt)

/** Every reply draft waiting for you now, this computer's and the other machines'. */
function waitingReplies() {
  const here = (state.approvals || []).filter((a) => a.status !== 'awaiting_human' && isReplyDraft(a.draft))
    .map((a) => ({ id: a.id, machine: '', tool: a.toolName, botName: botById(a.botId)?.name || '', draft: a.draft, edits: a.edits }));
  const there = (state.inbox?.items || []).filter((i) => i.status !== 'awaiting_human' && isReplyDraft(i.draft))
    .map((i) => ({ id: i.id, machine: i.machine, tool: i.toolName, botName: i.botName || '', draft: i.draft, edits: i.edits }));
  return [...here, ...there];
}

function replyRow(item) {
  const row = el('div', 'reply-row');
  row.dataset.approval = item.id;
  if (item.machine) row.dataset.machine = item.machine;
  row.dataset.draft = '1';
  row.cardData = { approvalId: item.id, tool: item.tool, draft: item.draft };
  row.appendChild(el('div', 'reply-row-to', `${item.draft.channel}${item.botName ? ` · ${item.botName}` : ''}${item.machine ? `（${item.machine}）` : ''}`));
  // What it answers, when the step says (X's context, a connected app's comment).
  if (item.draft.context) row.appendChild(el('div', 'reply-row-ctx', `原评论：${item.draft.context}`));
  const field = (item.draft.fields || []).find((f) => f.multiline) || (item.draft.fields || [])[0];
  if (field) {
    const box = el('textarea', 'field draft-field reply-row-text');
    box.dataset.key = field.key;
    box.value = item.edits?.[field.key] !== undefined ? String(item.edits[field.key]) : String(field.value ?? '');
    box.rows = Math.min(4, Math.max(1, Math.ceil(box.value.length / 34)));
    box.setAttribute('aria-label', '回复的内容');
    row.appendChild(box);
  }
  const actions = el('div', 'approval-actions reply-row-actions');
  const go = el('button', 'btn reply-row-send', '回复');
  go.type = 'button';
  go.title = '发出这一条，发的就是框里的字';
  go.addEventListener('click', () => answerReply(row, go));
  const skip = el('button', 'btn reply-row-skip', '不回这条');
  skip.type = 'button';
  skip.title = '这条不发，把「不发了」告诉它';
  skip.addEventListener('click', () => decide(row.dataset.approval, 'deny', '', row, go, skip));
  actions.appendChild(skip);
  actions.appendChild(go);
  row.appendChild(actions);
  return row;
}

function answerReply(row, btn) {
  const edits = draftEdits(row, row.cardData);
  if (edits) row.dataset.edited = '1';
  return decide(row.dataset.approval, 'approve', '', row, btn, null, null, edits);
}

/** The group, for 「等你确认」: one line each with its own 「回复」, and 「全部回复（N）」 under them. -> {node, keys} or null */
function replyGroup() {
  const items = waitingReplies();
  const keys = new Set(items.map((i) => `${i.machine}|${i.id}`));
  for (const [key, row] of replyRows) if (!keys.has(key) && !row.classList.contains('resolved')) replyRows.delete(key);
  for (const item of items) { const key = `${item.machine}|${item.id}`; if (!replyRows.has(key)) replyRows.set(key, replyRow(item)); }
  if (replyRows.size < 2) return null;
  const box = el('div', 'reply-group');
  const open = [...replyRows.values()].filter((r) => !r.classList.contains('resolved'));
  box.appendChild(el('div', 'reply-group-title', open.length ? `${open.length} 条回复等你看` : '回复都处理完了'));
  if (open.length) box.appendChild(el('div', 'muted tiny', '每条都能直接改；点「回复」只发那一条，「不回这条」就不发。'));
  for (const row of replyRows.values()) box.appendChild(row);
  if (open.length >= 2) {
    const all = el('button', 'btn primary reply-group-all', `全部回复（${open.length}）`);
    all.type = 'button';
    all.title = '把这几条都发出去，发的就是各自框里的字';
    all.addEventListener('click', async () => {
      all.disabled = true;
      for (const row of open) {
        const btn = row.querySelector('.reply-row-send');
        if (!btn) continue;
        if (btn && !btn.disabled && !row.classList.contains('resolved')) await answerReply(row, btn);
      }
    });
    box.appendChild(all);
  }
  return { node: box, keys: new Set(replyRows.keys()) };
}

/** On a reply card in a chat, when others wait too: one quiet button to see them together. */
function replyGroupHint(data) {
  if (!isReplyDraft(data.draft) || data.decision) return null;
  // This card counts too, also when it is drawn before it reaches the list (1.5.62: three waiting said 「2 条」).
  const items = waitingReplies();
  const n = items.length + (items.some((i) => i.id === data.approvalId) ? 0 : 1);
  if (n < 2) return null;
  const go = el('button', 'btn ghost tiny reply-group-link', `一起看这 ${n} 条回复`);
  go.type = 'button';
  go.addEventListener('click', () => openInbox());
  return go;
}

function clearReplyRows() {
  for (const [key, row] of replyRows) if (row.classList.contains('resolved')) replyRows.delete(key);
}
