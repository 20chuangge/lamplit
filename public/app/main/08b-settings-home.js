'use strict';
// Lamplit page, part 8b: the settings home (redesign step 5, 1.5.61) - on top 「一切正常吗、花了多少钱」, then 4 groups, each page with its short name, one line on what it is, and what it is set to now, so most of it reads without opening anything. Parts share one scope and load in order (scripts/check-page-parts.mjs).

/**
 * The 4 groups: [page, name, what it is]. The names are the short ones of the
 * left list, the section heads and every 「设置 → …」 (1.5.62: step 5 had
 * renamed them in plain words and nothing else matched); the line under each
 * says what it is. The group titles here stay in plain words.
 */
const SETTINGS_GROUPS = [
  ['助手怎么干活', [
    ['sec-model', '模型', '它用哪个 AI 思考'],
    ['sec-skills', '技能', '会做哪些事'],
    ['sec-memory', '记忆', '它记住了你什么'],
    ['sec-initiative', '主动', '什么时候主动找你：每天简报、定时任务'],
  ]],
  ['安全', [
    ['sec-run', '审批', '什么时候先问你'],
    ['sec-bounds', '边界', '能碰哪些地方：文件夹、网站、命令'],
    ['sec-vault', '保险箱', '账号密码，只存在这台电脑'],
    ['sec-audit', '操作记录', '做过什么，能撤销的都在这'],
  ]],
  ['连接', [
    ['sec-machines', '机器', '家里的电脑、云服务器'],
    ['sec-pair', '手机和外网', '出门在外也能用'],
    ['sec-feishu', '飞书', '在飞书里跟助手说话'],
    ['sec-mcp', '连接应用', '邮箱、网盘、X…'],
  ]],
  ['外观和系统', [
    ['sec-appearance', '外观', '深色、浅色，头像动起来'],
    ['sec-backup', '备份', '备份和恢复，换电脑也不丢'],
    ['sec-checkup', '体检', '哪里不对，一个按钮去修'],
    ['sec-usage', '成本', '花了多少钱：按天、按助手、按机器看'],
    ['sec-pages', '页面库', '它做的页面都在这'],
    ['sec-about', '关于', '版本和更新'],
  ]],
];

const settingsHomeUi = { usage: null, at: 0 };

/** What a page is set to now, in a few words ('' when there is nothing short to say); warn: worth a look. */
function settingsValue(target) {
  const n = (list) => (Array.isArray(list) ? list.length : 0);
  switch (target) {
    case 'sec-model': {
      const info = modelState();
      return info.unconfigured ? { text: '还没接模型', warn: true } : { text: info.provider === 'mock' ? '演示模式' : info.model };
    }
    case 'sec-skills': return n(state.skills) ? { text: `${n(state.skills)} 个` } : null;
    case 'sec-initiative': {
      const d = initiativeUi?.view?.daily;
      return d ? { text: d.enabled ? `${d.time || '09:00'} 简报` : '关着' } : null;
    }
    case 'sec-run': {
      const level = state.policy?.level || state.policy?.effective?.level;
      return level ? { text: { careful: '每次都问', standard: '会改东西就问', auto: '放手做' }[level] || level } : null;
    }
    case 'sec-vault': return Array.isArray(state.vault) ? { text: `${n(state.vault)} 个账号` } : null;
    case 'sec-machines': {
      const others = (state.peerRoster || []);
      const off = others.filter((m) => !m.online).length;
      if (!others.length) return { text: '只有这台' };
      return off ? { text: `${off} 台离线`, warn: true } : { text: `${others.length + 1} 台都在线` };
    }
    case 'sec-mcp': {
      const on = (mcpUi?.servers || []).filter((s) => mcpIsOn(s)).length;
      return { text: on ? `${on} 个已连接` : '还没连' };
    }
    case 'sec-appearance': {
      const pref = (() => { try { return localStorage.getItem('desk.theme') || 'system'; } catch { return 'system'; } })();
      return { text: { dark: '深色', light: '浅色', system: '跟随系统' }[pref] || '跟随系统' };
    }
    case 'sec-usage': {
      const u = settingsHomeUi.usage;
      return u ? { text: `这台 30 天 ${moneyWords(u)}` } : null;
    }
    case 'sec-about': {
      const v = state.settings?.app?.version || state.config?.version;
      return v ? { text: v } : null;
    }
    default: return null;
  }
}

function moneyWords(u) {
  const cost = Number(u?.totals?.cost) || 0;
  return `${u?.currency === 'USD' ? '$' : '¥'}${cost.toFixed(2)}`;
}

/**
 * The home's figure is this machine's last 30 days, so it opens 成本 at just
 * that (1.5.62): the page opened on all machines and 7 days, and the two
 * numbers did not match. The buttons on that page change it as before.
 */
function openUsageHere() {
  state.usageScope = 'here';
  state.usageDays = 30;
  for (const b of $('usage-scope')?.querySelectorAll('button') || []) b.classList.toggle('on', b.dataset.scope === 'here');
  setSettingsNav('sec-usage');
  loadUsage(30).catch(() => {});
}

/** The first thing settings shows (on a computer): is all well, what it cost, then the 4 groups. */
function renderSettingsHome() {
  const box = $('sec-home');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('div', 'dsec-head', settingsTitle()));
  // Is all well, and what it cost.
  const health = el('div', 'set-health');
  // Each thing to look at is named and opens its page (1.5.61 beginner test: 「有 1 处」 said not which).
  const issues = [];
  if (modelState().unconfigured) issues.push(['还没接模型', 'sec-model']);
  const off = (state.peerRoster || []).filter((m) => !m.online).map((m) => m.machine);
  if (off.length) issues.push([`${off.join('、')}关着`, 'sec-machines']);
  const left = el('div', 'set-health-main');
  left.appendChild(el('b', `set-health-title${issues.length ? ' warn' : ''}`, issues.length ? `有 ${issues.length} 处要看一眼` : '一切正常'));
  const machines = (state.peerRoster || []).length + 1;
  const sub = el('span', 'set-health-sub', machines > 1 ? `${machines - off.length} 台机器在线` : '这台电脑在线');
  for (const [text, target] of issues) {
    const go = el('button', 'link-btn set-health-issue', `${text} →`);
    go.type = 'button';
    go.addEventListener('click', () => setSettingsNav(target));
    sub.append(' · ', go);
  }
  left.appendChild(sub);
  health.appendChild(left);
  const spent = el('button', 'set-health-cost');
  spent.type = 'button';
  spent.appendChild(el('b', null, settingsHomeUi.usage ? moneyWords(settingsHomeUi.usage) : '—'));
  spent.appendChild(el('span', null, '这台电脑最近 30 天'));
  spent.addEventListener('click', openUsageHere);
  health.appendChild(spent);
  box.appendChild(health);
  // The 4 groups.
  const grid = el('div', 'set-groups');
  for (const [title, pages] of SETTINGS_GROUPS) {
    const card = el('div', 'set-group');
    card.appendChild(el('div', 'set-group-title', title));
    for (const [target, name, what] of pages) {
      if (!$(target)) continue;
      const row = el('button', 'set-row');
      row.type = 'button';
      row.dataset.setTarget = target;
      const icon = SETNAV_ICONS[target];
      if (icon) row.insertAdjacentHTML('beforeend', `<svg class="set-row-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`);
      const text = el('span', 'set-row-text');
      text.appendChild(el('b', null, name));
      text.appendChild(el('small', null, what));
      row.appendChild(text);
      const v = settingsValue(target);
      if (v?.text) row.appendChild(el('span', `set-row-value${v.warn ? ' warn' : ''}`, v.text));
      row.appendChild(el('span', 'set-row-go', '›'));
      row.addEventListener('click', target === 'sec-usage' ? openUsageHere : () => setSettingsNav(target)); // 成本 at what its value says
      card.appendChild(row);
    }
    grid.appendChild(card);
  }
  box.appendChild(grid);
  box.appendChild(el('p', 'set-home-note', '这些设置属于这台机器。别的机器的设置，在左上角切到那台再打开。'));
  // What it cost, read once a minute at most; drawn again when it comes.
  if (Date.now() - settingsHomeUi.at > 60000) {
    settingsHomeUi.at = Date.now();
    api('/api/usage?days=30').then((u) => { settingsHomeUi.usage = u; if ($('sec-home')?.classList.contains('active')) renderSettingsHome(); }).catch(() => {});
  }
}
