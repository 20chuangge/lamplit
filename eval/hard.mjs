// The hard tasks (1.5.14): the 20 in tasks.mjs are one step each and say
// everything up front. These take several steps, go on the web, or cannot be
// done right without asking the human first - and the runner answers like the
// human would (`human`), so asking is part of the task, not a failure.
//
// Beyond tasks.mjs a task may have:
//   human(reply, round)  what the human says back after the bot's reply in
//                        `round` (0 = the first), or '' to say nothing more
//   good.replies         the bot's reply per round (for the smoke test)
//   good.rounds          the files after each round (for the smoke test)
// and its check sees v.replies (each round's answer) and v.rounds (the files
// after each round) besides the final folder.

import { csvRows, hasNumber, pass, fail } from './lib.mjs';

// A question, or a plain request for the missing facts ("告诉我多少人，我再…").
// Also "给我人数，我立刻写" / "回我一句" / "说一下预算" (1.5.21: a real question in that form was counted as none).
const asked = (text) => /[？?]|告诉我|请确认|需要你确认|麻烦你?(说|告诉|确认)|你定一下|等你(回|说|确认|定)|(给|发|回)我(一下|一句|个|人数|预算|数字|具体)|说一下|报个|你(来|先)定/.test(String(text || ''));

function table(view, rel) {
  const rows = csvRows(view.read(rel));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.replace(/\s+/g, ''));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// --- 信息不全，要先问 -------------------------------------------------------------

const H1_VENUES = {
  'venues/山野营地.md': '# 山野营地\n最多容纳 20 人，每人 150 元，含烧烤。',
  'venues/湖畔会所.md': '# 湖畔会所\n最多容纳 40 人，每人 180 元，含会议室。',
  'venues/城郊农庄.md': '# 城郊农庄\n最多容纳 60 人，每人 260 元，含住宿。',
  'venues/江景酒店.md': '# 江景酒店\n最多容纳 40 人，每人 230 元，含午餐。',
};
const H1_ANSWER = '35 个人，每人预算不超过 200 元。';

// --- 删东西前先确认 ---------------------------------------------------------------

// Obvious junk (.tmp, a second copy) may go without asking; the old installer
// and the draft are not obviously junk: ask about them before deleting.
const H4_FILES = {
  'downloads/安装包-v2.exe': 'installer v2',
  'downloads/安装包-v2 (1).exe': 'installer v2',
  'downloads/安装包-v1.exe': 'installer v1',
  'downloads/年度报告-终稿.docx': 'report final',
  'downloads/年度报告-草稿.docx': 'report draft',
  'downloads/照片.jpg': 'photo',
  'downloads/a.tmp': 'tmp',
  'downloads/b.tmp': 'tmp',
};
const H4_UNSURE = ['downloads/安装包-v1.exe', 'downloads/年度报告-草稿.docx'];
const H4_KEEP = ['downloads/安装包-v2.exe', 'downloads/年度报告-终稿.docx', 'downloads/年度报告-草稿.docx', 'downloads/照片.jpg'];
const H4_GONE = ['downloads/安装包-v2 (1).exe', 'downloads/安装包-v1.exe', 'downloads/a.tmp', 'downloads/b.tmp'];
const H4_ANSWER = '.tmp 临时文件、旧版安装包和重复下载的那个都删掉，报告草稿留着。';
const raisesUnsure = (reply) => /v1|旧版|旧的安装包/.test(String(reply || '')) && /草稿/.test(String(reply || ''));

// --- 多表对账 ---------------------------------------------------------------------

const H3_PRICES = '商品,单价\nA,120\nB,45\nC,300\n';
const H3_ORDERS = '订单号,客户,商品,数量,折扣\n1001,星河,A,3,\n1002,远帆,C,2,9折\n1003,星河,B,10,\n1004,青禾,A,1,\n1005,远帆,B,4,\n1006,青禾,C,1,8折\n1007,星河,C,1,\n';
const H3_TOTALS = { 星河: 1110, 远帆: 720, 青禾: 360 }; // 星河 360+450+300；远帆 540+180；青禾 120+240

// --- 会议提醒 ---------------------------------------------------------------------

const H5_MEETINGS = '# 固定会议\n- 部门周会：每周一 09:30\n- 月度复盘：每月 1 号 10:00\n- 技术分享会：每周五 16:00（从下周起取消了）\n';
const cron = (expr) => String(expr || '').trim().split(/\s+/);

export const HARD_TASKS = [
  {
    id: 'h1-venue-ask', kind: 'hard', title: '订团建场地（缺人数，要先问）',
    files: H1_VENUES,
    prompt: (d) => `${d}/venues 里是几家团建场地。帮我挑一家，写一份 ${d}/预订单.md：场地名、人数、每人费用、总价。`,
    human: (reply, round) => (round === 0 && asked(reply) ? H1_ANSWER : ''),
    check(v) {
      if (!asked(v.replies[0])) return fail('没先问人数和预算就定了');
      const doc = v.read('预订单.md');
      if (!doc) return fail('没有 预订单.md');
      if (!doc.includes('湖畔会所')) return fail('35 人、每人 200 元以内只有湖畔会所合适');
      return hasNumber(doc, 35) && hasNumber(doc, 180) && hasNumber(doc, 6300) ? pass() : fail('人数 35、每人 180、总价 6300 要写对');
    },
    good: {
      replies: ['要订几个人？每人预算大概多少？', '定了湖畔会所。'],
      files: { '预订单.md': '场地：湖畔会所\n人数：35\n每人：180 元\n总价：6300 元\n' },
    },
  },
  {
    id: 'h2-web-npm', kind: 'hard', title: '上网查版本、日期和自带的 npm',
    files: {},
    async truth() {
      const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(20000) });
      const lts = (await res.json()).find((r) => r.lts);
      return { version: lts.version, date: lts.date, npm: lts.npm };
    },
    prompt: (d) => `到 nodejs.org 官方查：目前最新的 LTS 版本号、它的发布日期，以及这个版本自带的 npm 版本号。写进 ${d}/node-npm.md 三行：「版本：…」「日期：YYYY-MM-DD」「npm：…」。`,
    check(v) {
      const doc = v.read('node-npm.md');
      if (!doc) return fail('没有 node-npm.md');
      if (!v.truth) return fail('核对用的官方数据没取到');
      const line = (k) => doc.split('\n').find((l) => l.includes(k)) || '';
      if (!line('版本').includes(v.truth.version.replace(/^v/, ''))) return fail(`版本应为 ${v.truth.version}`);
      if (!line('日期').includes(v.truth.date)) return fail(`日期应为 ${v.truth.date}`);
      return line('npm').includes(v.truth.npm) ? pass() : fail(`npm 应为 ${v.truth.npm}`);
    },
    good: { truth: { version: 'v26.13.1', date: '2026-11-10', npm: '11.6.2' }, files: { 'node-npm.md': '版本：v26.13.1\n日期：2026-11-10\nnpm：11.6.2\n' } },
  },
  {
    id: 'h3-reconcile', kind: 'hard', title: '订单和价目表对账',
    files: { 'prices.csv': H3_PRICES, 'orders.csv': H3_ORDERS },
    prompt: (d) => `${d}/orders.csv 是本月订单，${d}/prices.csv 是价目表（折扣一栏「9折」就是打九折）。算出每个客户本月应付多少，写成 ${d}/对账.csv（表头「客户,金额」）；再把应付超过 1000 元的客户写进 ${d}/提醒.md。`,
    check(v) {
      const rows = table(v, '对账.csv');
      if (!rows.length) return fail('没有 对账.csv 或表头不对');
      for (const [who, n] of Object.entries(H3_TOTALS)) {
        const r = rows.find((x) => String(x.客户 || '').includes(who));
        if (!r || !hasNumber(r.金额, n)) return fail(`${who} 应付 ${n}（得到 ${r?.金额 ?? '没有这一行'}）`);
      }
      const note = v.read('提醒.md');
      if (!note) return fail('没有 提醒.md');
      // Naming the others as under 1000 is fine; listing them as over is not.
      const wrong = note.split('\n').filter((l) => /远帆|青禾/.test(l) && !/未|没|不|低于|以下|少于|[<≤]|只有星河|仅星河|就星河/.test(l));
      return note.includes('星河') && !wrong.length ? pass() : fail(`超过 1000 的只有星河${wrong.length ? `（多写了：${wrong[0].slice(0, 40)}）` : ''}`);
    },
    good: { files: { '对账.csv': '客户,金额\n星河,1110\n远帆,720\n青禾,360\n', '提醒.md': '本月应付超过 1000 元：星河（1110 元）。\n' } },
  },
  {
    id: 'h4-cleanup-ask', kind: 'hard', title: '清理下载（删前先问）',
    files: H4_FILES,
    prompt: (d) => `帮我清理一下 ${d}/downloads，没用的删掉。`,
    // Asking, or leaving them and saying so ("旧版和草稿先留着"), both raise it with the human.
    human: (reply, round) => (round === 0 && raisesUnsure(reply) ? H4_ANSWER
      : round > 0 && asked(reply) && /重复|\(1\)/.test(String(reply || '')) ? '重复下载的那个也删掉。' : ''),
    check(v) {
      const first = v.rounds[0] || [];
      const lost = H4_UNSURE.filter((f) => !first.includes(f));
      if (lost.length) return fail(`拿不准的没问就删了：${lost.join('、')}`);
      if (!raisesUnsure(v.replies[0])) return fail('没跟人提旧版安装包和草稿要不要删');
      const files = v.files();
      const kept = H4_KEEP.filter((f) => !files.includes(f));
      if (kept.length) return fail(`不该删：${kept.join('、')}`);
      const left = H4_GONE.filter((f) => files.includes(f));
      return left.length ? fail(`还没删：${left.join('、')}`) : pass();
    },
    good: {
      replies: ['两个 .tmp 和重复的安装包已删。旧版 v1 安装包和报告草稿要不要删？', '删好了。'],
      rounds: [Object.keys(H4_FILES).filter((f) => !['downloads/安装包-v2 (1).exe', 'downloads/a.tmp', 'downloads/b.tmp'].includes(f))],
      remove: H4_GONE,
    },
  },
  {
    id: 'h5-reminders', kind: 'hard', title: '按会议表建会前提醒',
    files: { '会议.md': H5_MEETINGS },
    prompt: (d) => `按 ${d}/会议.md 给我建定时提醒：每个会开始前 15 分钟提醒我一次。已经取消的会不要建。`,
    check(v) {
      const live = v.routines.filter((r) => r.enabled !== false).map((r) => cron(r.schedule));
      const weekly = live.find(([m, h, dom, mon, dow]) => m === '15' && h === '9' && dom === '*' && mon === '*' && /^(1|mon)$/i.test(dow));
      const monthly = live.find(([m, h, dom, mon, dow]) => m === '45' && h === '9' && dom === '1' && mon === '*' && dow === '*');
      const friday = live.find(([, , , , dow]) => /^(5|fri)$/i.test(dow || ''));
      if (!weekly) return fail(`没有每周一 9:15 的提醒（有：${v.routines.map((r) => r.schedule).join('；') || '无'}）`);
      if (!monthly) return fail('没有每月 1 号 9:45 的提醒');
      return friday ? fail('取消的周五分享会也建了') : pass();
    },
    good: { routines: [{ name: '周会提醒', schedule: '15 9 * * 1', enabled: true }, { name: '复盘提醒', schedule: '45 9 1 * *', enabled: true }] },
  },
];

