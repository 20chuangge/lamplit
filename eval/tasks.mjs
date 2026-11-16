// The evaluation set (1.5.6, report 8.4): 20 real tasks of the kinds people
// give Lamplit - sort files, fill forms, look things up and write a report,
// handle mail, scheduled briefings - four of each.
//
// A task:
//   id, kind, title
//   files          the folder the bot starts with (relative to the task folder)
//   setupRoutines  routines that exist before it starts ({name, schedule, instruction})
//   prompt(dir)    what the human says; dir is the task folder in the workspace
//   truth()        (optional) a fact looked up at run time, for checks on live data
//   check(view)    {ok, why}: looks only at the folder, the bot's routines and its answer
//   good           a correct result (smoke: check passes on it, and fails on the untouched folder)
//
// Mail is files (.eml) on purpose: the set never sends a real message.

import { csvRows, numbersIn, hasNumber, cronIs, pass, fail } from './lib.mjs';

const eml = ({ from, to = '我 <me@example.com>', subject, date = 'Mon, 9 Nov 2026 09:00:00 +0800', body }) =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

const has = (text, ...words) => words.every((w) => String(text || '').includes(w));

/** Rows of a CSV as objects by header (trimmed), or [] when there is no such file. */
function table(view, rel) {
  const rows = csvRows(view.read(rel));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.replace(/\s+/g, ''));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// --- 整理文件 -----------------------------------------------------------------

const F1_FILES = {
  'inbox/合同.pdf': 'pdf: 合同', 'inbox/照片1.jpg': 'jpg: 照片', 'inbox/截图.png': 'png: 截图',
  'inbox/会议记录.docx': 'docx: 会议', 'inbox/清单.txt': 'txt: 清单', 'inbox/安装包.zip': 'zip: 安装包',
};
const F1_WHERE = { '合同.pdf': '文档', '照片1.jpg': '图片', '截图.png': '图片', '会议记录.docx': '文档', '清单.txt': '文档', '安装包.zip': '其他' };

const F2_FILES = {
  'scans/扫描001.txt': '发票日期：2026-03-05\n供应商：青木文具\n金额：128.00',
  'scans/扫描002.txt': '发票日期：2026-02-17\n供应商：北辰印务\n金额：560.00',
  'scans/扫描003.txt': '发票日期：2026-03-21\n供应商：远山咖啡\n金额：46.00',
};
const F2_NAMES = { '扫描001.txt': '2026-03-05_青木文具.txt', '扫描002.txt': '2026-02-17_北辰印务.txt', '扫描003.txt': '2026-03-21_远山咖啡.txt' };

const F3_FILES = {
  'photos/a.txt': '海边日落', 'photos/b.txt': '海边日落', 'photos/c.txt': '山顶云海',
  'photos/d.txt': '城市夜景', 'photos/e.txt': '山顶云海', 'photos/f.txt': '海边日落',
};

const F4_FILES = {
  'project/README.md': '# 项目', 'project/预算.xlsx': 'x', 'project/设计/首页.png': 'p',
  'project/设计/图标.svg': 's', 'project/会议/0301.md': 'm', 'project/会议/0315.md': 'm',
};

// --- 填表 ---------------------------------------------------------------------

const T1_PEOPLE = [['王小明', '13800001111', '杭州'], ['陈静', '13900002222', '成都'], ['刘洋', '13700003333', '西安']];
const T2_RECEIPTS = { 'receipts/1.txt': '11月3日 出租车 去客户公司 车费 46.5 元', 'receipts/2.txt': '2026年11月4日，午餐招待客户，共计 312 元。', 'receipts/3.txt': '11/6 高铁票 杭州-上海 73 元', 'receipts/4.txt': '打印装订投标文件，11月7日，88.2元' };
const T2_TOTAL = 519.7; // 46.5 + 312 + 73 + 88.2
const T4_START = '商品,数量\n笔记本,120\n签字笔,300\n文件夹,45\n订书机,12\n';
const T4_END = { 笔记本: 100, 签字笔: 350, 文件夹: 45, 订书机: 9 };

// --- 查资料出报告 ---------------------------------------------------------------

const R2_SALES = '日期,地区,金额\n11-01,华东,1200\n11-01,华南,800\n11-02,华北,650\n11-02,华东,900\n11-03,华南,1500\n11-03,华北,300\n11-04,华东,400\n';
const R2_TOTALS = { 华东: 2500, 华南: 2300, 华北: 950 };

// --- 邮件 -----------------------------------------------------------------------

const M1_MAIL = {
  'inbox/1.eml': eml({ from: '赵总 <boss@example.com>', subject: '周五前把三季度数据发我', body: '周五前把三季度的销售数据整理一份发我，谢谢。' }),
  'inbox/2.eml': eml({ from: '订阅周刊 <news@example.com>', subject: '本周科技周刊第 212 期', body: '本期内容：……（退订请点这里）' }),
  'inbox/3.eml': eml({ from: '客户 孙女士 <sun@example.com>', subject: '合同第三条怎么理解', body: '您好，合同第三条的违约金是按月算还是按年算？麻烦回复一下。' }),
  'inbox/4.eml': eml({ from: '系统通知 <noreply@example.com>', subject: '您的密码将在 7 天后过期', body: '这是一封自动发送的邮件，请勿回复。' }),
  'inbox/5.eml': eml({ from: '快递 <express@example.com>', subject: '您的包裹已签收', body: '您的包裹已于今天 10:20 签收。' }),
};
const M3_MAIL = {
  'inbox/a.eml': eml({ from: '青木文具 <bill@qingmu.example.com>', subject: '11月发票', body: '您好，附上11月办公用品发票，金额 1,280.50 元。' }),
  'inbox/b.eml': eml({ from: '远山咖啡 <hi@yuanshan.example.com>', subject: '发票已开具', body: '本月咖啡豆费用 460 元，发票已开具。' }),
  'inbox/c.eml': eml({ from: '北辰印务 <ar@beichen.example.com>', subject: '印刷费发票', body: '宣传册印刷费用共计 3,600 元，发票见附件。' }),
  'inbox/d.eml': eml({ from: '同事 小周 <zhou@example.com>', subject: '明天聚餐', body: '明天中午一起吃饭吗？' }),
};
const M3_AMOUNTS = { 青木文具: 1280.5, 远山咖啡: 460, 北辰印务: 3600 };
const M4_PEOPLE = [['周婷', '周一 10:00'], ['吴磊', '周二 15:30'], ['郑悦', '周四 09:00']];

// --- 定时简报 -------------------------------------------------------------------

const B4_LOG = '日期,项目,小时\n11-09,官网改版,3\n11-09,客户支持,2\n11-10,官网改版,5\n11-11,数据报表,4\n11-11,客户支持,1.5\n11-12,官网改版,2\n11-13,数据报表,3\n';
const B4_TOTALS = { 官网改版: 10, 客户支持: 3.5, 数据报表: 7 };

export const TASKS = [
  // 整理文件
  {
    id: 'f1-sort', kind: 'files', title: '按类型分文件夹',
    files: F1_FILES,
    prompt: (d) => `${d}/inbox 里的文件太乱了。帮我按类型分进 ${d}/inbox 下的「图片」「文档」「其他」三个文件夹：jpg、png 放图片，pdf、docx、txt 放文档，剩下的放其他。不要删文件，也不要改名。`,
    check(v) {
      for (const [name, where] of Object.entries(F1_WHERE)) {
        if (v.read(`inbox/${where}/${name}`) !== F1_FILES[`inbox/${name}`]) return fail(`${name} 不在 ${where}/`);
      }
      const loose = v.list('inbox').filter((n) => F1_WHERE[n]);
      return loose.length ? fail(`还留在 inbox 下：${loose.join('、')}`) : pass();
    },
    good: { files: Object.fromEntries(Object.entries(F1_WHERE).map(([n, w]) => [`inbox/${w}/${n}`, F1_FILES[`inbox/${n}`]])), remove: Object.keys(F1_FILES) },
  },
  {
    id: 'f2-rename', kind: 'files', title: '按发票内容改名',
    files: F2_FILES,
    prompt: (d) => `${d}/scans 里是几张发票扫描的文字。把每个文件改名成「发票日期_供应商.txt」，比如「2026-03-05_青木文具.txt」。内容不要动。`,
    check(v) {
      for (const [from, to] of Object.entries(F2_NAMES)) {
        if (v.read(`scans/${to}`) !== F2_FILES[`scans/${from}`]) return fail(`没有 ${to}`);
        if (v.exists(`scans/${from}`)) return fail(`${from} 还在`);
      }
      return pass();
    },
    good: { files: Object.fromEntries(Object.entries(F2_NAMES).map(([f, t]) => [`scans/${t}`, F2_FILES[`scans/${f}`]])), remove: Object.keys(F2_FILES) },
  },
  {
    id: 'f3-dedupe', kind: 'files', title: '删除重复文件',
    files: F3_FILES,
    prompt: (d) => `${d}/photos 里有内容一模一样的重复文件。每种内容只留一份（留文件名按字母排最前的那个），其余删掉。`,
    check(v) {
      const left = v.list('photos');
      return left.join(',') === 'a.txt,c.txt,d.txt' ? pass() : fail(`剩下：${left.join('、') || '（空）'}，应为 a、c、d`);
    },
    good: { remove: ['photos/b.txt', 'photos/e.txt', 'photos/f.txt'] },
  },
  {
    id: 'f4-index', kind: 'files', title: '给文件夹做目录',
    files: F4_FILES,
    prompt: (d) => `给 ${d}/project 做一份目录，写到 ${d}/目录.md：列出里面每一个文件（包括子文件夹里的），按子文件夹分组。`,
    check(v) {
      const doc = v.read('目录.md');
      if (!doc) return fail('没有 目录.md');
      const miss = Object.keys(F4_FILES).map((p) => p.split('/').pop()).filter((n) => !doc.includes(n));
      return miss.length ? fail(`目录里缺：${miss.join('、')}`) : pass();
    },
    good: { files: { '目录.md': '# 目录\n- README.md\n- 预算.xlsx\n## 设计\n- 首页.png\n- 图标.svg\n## 会议\n- 0301.md\n- 0315.md\n' } },
  },

  // 填表
  {
    id: 't1-signup', kind: 'forms', title: '从聊天记录整理报名表',
    files: { '报名记录.txt': `群聊摘录：\n王小明：我报名，电话 ${T1_PEOPLE[0][1]}，人在杭州。\n陈静：+1，成都的，手机 ${T1_PEOPLE[1][1]}\n刘洋：我也来！西安 ${T1_PEOPLE[2][1]}\n小李：我这周去不了，下次吧。\n` },
    prompt: (d) => `${d}/报名记录.txt 是群里的报名聊天。整理成 ${d}/报名表.csv，表头是「姓名,电话,城市」，每个报名的人一行（没报名的不要写）。`,
    check(v) {
      const rows = table(v, '报名表.csv');
      if (!rows.length) return fail('没有 报名表.csv 或表是空的');
      if (rows.length !== 3) return fail(`应有 3 行，实际 ${rows.length} 行`);
      for (const [n, tel, city] of T1_PEOPLE) {
        if (!rows.some((r) => r.姓名 === n && String(r.电话).replace(/\D/g, '') === tel && String(r.城市).includes(city))) return fail(`${n} 那一行不对`);
      }
      return pass();
    },
    good: { files: { '报名表.csv': `姓名,电话,城市\n${T1_PEOPLE.map((p) => p.join(',')).join('\n')}\n` } },
  },
  {
    id: 't2-expense', kind: 'forms', title: '填报销单',
    files: T2_RECEIPTS,
    prompt: (d) => `${d}/receipts 里是这周的四张票据。帮我填一张报销单 ${d}/报销单.csv，表头「日期,项目,金额」，每张票一行，日期写成 2026-11-03 这样，最后一行项目写「合计」，金额是总数。`,
    check(v) {
      const rows = table(v, '报销单.csv');
      if (!rows.length) return fail('没有 报销单.csv');
      const isTotal = (r) => /合计|总计/.test(String(r.项目) + String(r.日期));
      const items = rows.filter((r) => !isTotal(r));
      const total = rows.find(isTotal);
      if (items.length !== 4) return fail(`应有 4 张票，实际 ${items.length} 行`);
      for (const [day, amt] of [['2026-11-03', 46.5], ['2026-11-04', 312], ['2026-11-06', 73], ['2026-11-07', 88.2]]) {
        if (!items.some((r) => r.日期 === day && hasNumber(r.金额, amt))) return fail(`${day} ${amt} 那张不对`);
      }
      return total && hasNumber(total.金额, T2_TOTAL) ? pass() : fail(`合计应为 ${T2_TOTAL}`);
    },
    good: { files: { '报销单.csv': `日期,项目,金额\n2026-11-03,出租车,46.5\n2026-11-04,客户午餐,312\n2026-11-06,高铁票,73\n2026-11-07,打印装订,88.2\n,合计,${T2_TOTAL}\n` } },
  },
  {
    id: 't3-form', kind: 'forms', title: '按简历填申请表',
    files: {
      'form.json': '{\n  "姓名": "",\n  "出生年份": "",\n  "邮箱": "",\n  "工作年限": "",\n  "技能": []\n}\n',
      '简历.txt': '林晓雨，1994 年生。邮箱 linxy@example.com。\n2017 年毕业后一直做数据分析，到现在 9 年。\n会用：Python、SQL、Tableau。\n',
    },
    prompt: (d) => `照 ${d}/简历.txt 把 ${d}/form.json 这张申请表填好（直接改这个文件，保持 JSON 格式，字段名不要改）。`,
    check(v) {
      let f;
      try { f = JSON.parse(v.read('form.json') || ''); } catch { return fail('form.json 不是合法 JSON'); }
      if (f.姓名 !== '林晓雨') return fail('姓名不对');
      if (!String(f.出生年份).includes('1994')) return fail('出生年份不对');
      if (String(f.邮箱).trim() !== 'linxy@example.com') return fail('邮箱不对');
      if (!hasNumber(f.工作年限, 9)) return fail('工作年限不对');
      const skills = Array.isArray(f.技能) ? f.技能.join(',') : String(f.技能 || '');
      return has(skills, 'Python', 'SQL', 'Tableau') ? pass() : fail('技能不全');
    },
    good: { files: { 'form.json': '{"姓名":"林晓雨","出生年份":"1994","邮箱":"linxy@example.com","工作年限":"9","技能":["Python","SQL","Tableau"]}' } },
  },
  {
    id: 't4-stock', kind: 'forms', title: '更新库存表',
    files: { '库存.csv': T4_START, '今日出入库.txt': '上午领走笔记本 20 本。\n新到签字笔 50 支。\n下午订书机坏了 3 个，报废。\n文件夹今天没动。\n' },
    prompt: (d) => `按 ${d}/今日出入库.txt 更新 ${d}/库存.csv 里的数量（直接改这个文件，格式不变）。`,
    check(v) {
      const rows = table(v, '库存.csv');
      if (rows.length !== 4) return fail('库存.csv 应还是 4 行商品');
      for (const [name, n] of Object.entries(T4_END)) {
        const r = rows.find((x) => x.商品 === name);
        if (!r || !hasNumber(r.数量, n)) return fail(`${name} 应为 ${n}`);
      }
      return pass();
    },
    good: { files: { '库存.csv': `商品,数量\n${Object.entries(T4_END).map(([k, n]) => `${k},${n}`).join('\n')}\n` } },
  },

  // 查资料出报告
  {
    id: 'r1-quotes', kind: 'report', title: '比较三家报价写推荐',
    files: {
      'quotes/甲.md': '# 甲公司报价\n单价 86 元，起订 500 件，交货 15 天。',
      'quotes/乙.md': '# 乙公司报价\n单价 92 元，起订 200 件，交货 7 天。',
      'quotes/丙.md': '# 丙公司报价\n单价 95 元，起订 100 件，交货 5 天。',
    },
    prompt: (d) => `${d}/quotes 里是三家供应商的报价。我们要 300 件，10 天内必须到货。写一份比较报告 ${d}/比较报告.md：列出每家的单价、起订量和交货期，再给出推荐哪一家、为什么。推荐那一行用「推荐：」开头。`,
    check(v) {
      const doc = v.read('比较报告.md');
      if (!doc) return fail('没有 比较报告.md');
      if (![86, 92, 95].every((n) => hasNumber(doc, n))) return fail('报告里缺了某家的单价');
      const line = doc.split('\n').find((l) => /推荐[:：]/.test(l)) || '';
      return /乙/.test(line) && !/甲|丙/.test(line.replace(/乙.*$/, '')) ? pass() : fail(`推荐应是乙（满足 300 件、10 天内的最便宜）；推荐行：${line.slice(0, 40) || '没有'}`);
    },
    good: { files: { '比较报告.md': '| 公司 | 单价 | 起订 | 交货 |\n|---|---|---|---|\n| 甲 | 86 | 500 | 15 天 |\n| 乙 | 92 | 200 | 7 天 |\n| 丙 | 95 | 100 | 5 天 |\n\n推荐：乙公司。甲起订 500 件且要 15 天，不满足；乙比丙便宜。\n' } },
  },
  {
    id: 'r2-sales', kind: 'report', title: '销售数据出报告',
    files: { 'sales.csv': R2_SALES },
    prompt: (d) => `分析 ${d}/sales.csv，写一份销售报告 ${d}/销售报告.md：每个地区的销售总额、哪个地区最高，再加一两句结论。`,
    check(v) {
      const doc = v.read('销售报告.md');
      if (!doc) return fail('没有 销售报告.md');
      for (const [area, n] of Object.entries(R2_TOTALS)) {
        const line = doc.split('\n').find((l) => l.includes(area) && hasNumber(l, n));
        if (!line) return fail(`${area} 的总额应为 ${n}`);
      }
      return /华东[^。\n]{0,20}(最高|第一|最多)|(最高|第一|最多)[^。\n]{0,20}华东/.test(doc) ? pass() : fail('没说华东最高');
    },
    good: { files: { '销售报告.md': '| 地区 | 总额 |\n|---|---|\n| 华东 | 2500 |\n| 华南 | 2300 |\n| 华北 | 950 |\n\n华东最高，华北明显落后。\n' } },
  },
  {
    id: 'r3-web', kind: 'report', title: '上网查资料',
    files: {},
    async truth() {
      const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(20000) });
      const list = await res.json();
      const lts = list.find((r) => r.lts);
      return { version: lts.version, date: lts.date };
    },
    prompt: (d) => `上网查一下 Node.js 目前最新的 LTS 版本号和它的发布日期（以 nodejs.org 官方为准），写进 ${d}/node.md，两行：「版本：…」「日期：YYYY-MM-DD」。`,
    check(v) {
      const doc = v.read('node.md');
      if (!doc) return fail('没有 node.md');
      if (!v.truth) return fail('核对用的官方数据没取到');
      const ver = v.truth.version.replace(/^v/, '');
      if (!doc.includes(ver)) return fail(`版本应为 ${ver}`);
      return doc.includes(v.truth.date) ? pass() : fail(`日期应为 ${v.truth.date}`);
    },
    good: { truth: { version: 'v24.11.1', date: '2026-11-11' }, files: { 'node.md': '版本：v24.11.1\n日期：2026-11-11\n' } },
  },
  {
    id: 'r4-minutes', kind: 'report', title: '会议纪要提待办',
    files: { '会议纪要.md': '# 周会 11-16\n- 官网首页改版，小周负责，11月20日前出初稿。\n- 大家觉得年会可以去郊外，再议。\n- 客户报价单，阿美跟进，下周一（11月23日）发出。\n- 服务器续费，老陈本月底（11月30日）前办好。\n' },
    prompt: (d) => `从 ${d}/会议纪要.md 里把明确有人负责的待办提出来，写成 ${d}/待办.csv，表头「事项,负责人,截止日期」，日期写成 2026-11-20 这样。没定下来的不要写。`,
    check(v) {
      const rows = table(v, '待办.csv');
      if (rows.length !== 3) return fail(`应有 3 条待办，实际 ${rows.length}`);
      for (const [who, day] of [['小周', '2026-11-20'], ['阿美', '2026-11-23'], ['老陈', '2026-11-30']]) {
        if (!rows.some((r) => String(r.负责人).includes(who) && r.截止日期 === day)) return fail(`${who} 的待办不对`);
      }
      return pass();
    },
    good: { files: { '待办.csv': '事项,负责人,截止日期\n官网首页改版初稿,小周,2026-11-20\n发客户报价单,阿美,2026-11-23\n服务器续费,老陈,2026-11-30\n' } },
  },

  // 邮件
  {
    id: 'm1-triage', kind: 'mail', title: '挑出要回复的邮件',
    files: M1_MAIL,
    prompt: (d) => `${d}/inbox 是我今天收到的邮件。帮我挑出需要我亲自回复的，把它们的主题写进 ${d}/需回复.txt，一行一个。通知、广告、自动邮件不算。`,
    check(v) {
      const lines = String(v.read('需回复.txt') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return fail('没有 需回复.txt');
      const want = ['三季度数据', '合同第三条'];
      const miss = want.filter((w) => !lines.some((l) => l.includes(w)));
      if (miss.length) return fail(`漏了：${miss.join('、')}`);
      return lines.length === 2 ? pass() : fail(`应只有 2 封，写了 ${lines.length} 行`);
    },
    good: { files: { '需回复.txt': '周五前把三季度数据发我\n合同第三条怎么理解\n' } },
  },
  {
    id: 'm2-reply', kind: 'mail', title: '按日程回复约时间',
    files: {
      'inbox/约时间.eml': eml({ from: '李雷 <lilei@example.com>', subject: '下周找个时间聊聊合作', body: '下周哪天下午方便？想当面聊一小时合作的事。' }),
      '日程.txt': '下周日程：\n周一 全天出差\n周二 下午 部门会\n周三 下午 客户拜访\n周四 下午 空\n周五 下午 请假\n',
    },
    prompt: (d) => `帮我回复 ${d}/inbox/约时间.eml，按 ${d}/日程.txt 挑一个我有空的下午。回复写成草稿 ${d}/outbox/回复李雷.txt，先不要发。`,
    check(v) {
      const t = v.read('outbox/回复李雷.txt');
      if (!t) return fail('没有 outbox/回复李雷.txt');
      if (!t.includes('李')) return fail('没称呼对方');
      if (!t.includes('周四')) return fail('应约周四下午（唯一空的下午）');
      const offered = ['周一', '周二', '周三', '周五'].filter((w) => new RegExp(`${w}[^，。,.\\n]{0,6}(可以|方便|有空)`).test(t));
      return offered.length ? fail(`提议了没空的时间：${offered.join('、')}`) : pass();
    },
    good: { files: { 'outbox/回复李雷.txt': '李雷你好：\n下周四下午我有空，2 点到 3 点在我们公司聊可以吗？\n' } },
  },
  {
    id: 'm3-invoices', kind: 'mail', title: '从邮件汇总发票',
    files: M3_MAIL,
    prompt: (d) => `${d}/inbox 里有几封供应商的发票邮件。汇总成 ${d}/发票汇总.csv，表头「供应商,金额」，每家一行，金额只写数字；最后一行供应商写「合计」。不是发票的邮件不要算。`,
    check(v) {
      const rows = table(v, '发票汇总.csv');
      if (!rows.length) return fail('没有 发票汇总.csv');
      for (const [name, n] of Object.entries(M3_AMOUNTS)) {
        if (!rows.some((r) => String(r.供应商).includes(name) && hasNumber(r.金额, n))) return fail(`${name} 应为 ${n}`);
      }
      if (rows.some((r) => String(r.供应商).includes('小周'))) return fail('把聚餐邮件也算进去了');
      const total = rows.find((r) => String(r.供应商).includes('合计'));
      return total && hasNumber(total.金额, 5340.5) ? pass() : fail('合计应为 5340.5');
    },
    good: { files: { '发票汇总.csv': '供应商,金额\n青木文具,1280.50\n远山咖啡,460\n北辰印务,3600\n合计,5340.50\n' } },
  },
  {
    id: 'm4-merge', kind: 'mail', title: '按名单写通知',
    files: {
      '通知模板.txt': '{姓名}您好：\n您的面试安排在 {时间}，地点三楼会议室。请提前 10 分钟到。\n',
      '名单.csv': `姓名,时间\n${M4_PEOPLE.map((p) => p.join(',')).join('\n')}\n`,
    },
    prompt: (d) => `按 ${d}/通知模板.txt 给 ${d}/名单.csv 里每个人写一份面试通知，存成 ${d}/outbox/姓名.txt（比如 outbox/周婷.txt）。只写文件，不要发出去。`,
    check(v) {
      for (const [n, time] of M4_PEOPLE) {
        const t = v.read(`outbox/${n}.txt`);
        if (!t) return fail(`没有 outbox/${n}.txt`);
        if (!t.includes(n) || !t.includes(time)) return fail(`${n} 的通知名字或时间不对`);
        if (/[{}]/.test(t)) return fail(`${n} 的通知还留着 {占位符}`);
      }
      return pass();
    },
    good: { files: Object.fromEntries(M4_PEOPLE.map(([n, t]) => [`outbox/${n}.txt`, `${n}您好：\n您的面试安排在 ${t}，地点三楼会议室。请提前 10 分钟到。\n`])) },
  },

  // 定时简报
  {
    id: 'b1-routine', kind: 'briefing', title: '建工作日早报',
    files: { 'news/说明.txt': '这里每天会放新的行业新闻。' },
    prompt: (d) => `以后每个工作日（周一到周五）早上 8:30，帮我把 ${d}/news 里新的文件总结成一份简报发给我。设一个定时任务。`,
    check(v) {
      const r = v.routines.find((x) => x.enabled !== false && cronIs(x.schedule, { minute: 30, hour: 8, days: 'weekdays' }));
      return r ? pass() : fail(`没有工作日 8:30 的定时任务（有：${v.routines.map((x) => x.schedule).join('；') || '无'}）`);
    },
    good: { routines: [{ name: '早报', schedule: '30 8 * * 1-5', enabled: true }] },
  },
  {
    id: 'b2-reschedule', kind: 'briefing', title: '改定时任务时间',
    files: {},
    setupRoutines: [{ name: '晚报', schedule: '0 21 * * *', instruction: '把今天的待办完成情况总结给我' }],
    prompt: () => '把「晚报」这个定时任务改到每天傍晚 6 点。别的不用动。',
    check(v) {
      const r = v.routines.filter((x) => String(x.name).includes('晚报'));
      if (r.length !== 1) return fail(`应只有一个「晚报」，现在有 ${r.length} 个`);
      return cronIs(r[0].schedule, { minute: 0, hour: 18 }) ? pass() : fail(`时间是 ${r[0].schedule}，应为每天 18:00`);
    },
    good: { routines: [{ name: '晚报', schedule: '0 18 * * *', enabled: true }] },
  },
  {
    id: 'b3-today', kind: 'briefing', title: '今日简报',
    files: {
      'today/日程.txt': '09:30 产品评审\n14:00 和李雷聊合作\n16:30 一对一（小周）\n',
      'today/待办.txt': '[紧急] 下班前把报价单发给孙女士\n整理上周的发票\n预约体检\n',
      'today/天气.json': '{"城市":"杭州","天气":"小雨","最高":14,"最低":8}',
    },
    prompt: (d) => `根据 ${d}/today 里的日程、待办和天气，给我写一份今天的简报 ${d}/今日简报.md：几点有什么会、最要紧的一件事、天气和要不要带伞。简短一点。`,
    check(v) {
      const doc = v.read('今日简报.md');
      if (!doc) return fail('没有 今日简报.md');
      const times = ['9:30', '14:00', '16:30'].filter((t) => !doc.includes(t));
      if (times.length) return fail(`缺了会议时间：${times.join('、')}`);
      if (!doc.includes('报价单')) return fail('没提最要紧的报价单');
      return /雨/.test(doc) && /伞/.test(doc) && hasNumber(doc, 14) ? pass() : fail('天气（小雨、14 度、带伞）没写全');
    },
    good: { files: { '今日简报.md': '# 今天\n- 09:30 产品评审\n- 14:00 和李雷聊合作\n- 16:30 一对一（小周）\n\n最要紧：下班前把报价单发给孙女士。\n\n杭州小雨，8~14 度，带伞。\n' } },
  },
  {
    id: 'b4-weekly', kind: 'briefing', title: '按工时写周报',
    files: { 'worklog.csv': B4_LOG },
    prompt: (d) => `按 ${d}/worklog.csv 写这周的周报 ${d}/周报.md：每个项目一共花了多少小时，总共多少小时，再写一句下周重点（你看着写）。`,
    check(v) {
      const doc = v.read('周报.md');
      if (!doc) return fail('没有 周报.md');
      for (const [p, n] of Object.entries(B4_TOTALS)) {
        if (!doc.split('\n').some((l) => l.includes(p) && hasNumber(l, n))) return fail(`${p} 应为 ${n} 小时`);
      }
      return numbersIn(doc).some((x) => Math.abs(x - 20.5) < 0.01) ? pass() : fail('总计应为 20.5 小时');
    },
    good: { files: { '周报.md': '| 项目 | 小时 |\n|---|---|\n| 官网改版 | 10 |\n| 客户支持 | 3.5 |\n| 数据报表 | 7 |\n\n总计 20.5 小时。下周重点：官网上线。\n' } },
  },
];

// The tools every evaluation bot has: what these tasks need, nothing that
// reaches people (no mail_send, no file_send, no bot_message).
export const EVAL_TOOLS = ['fs_list', 'fs_read', 'fs_write', 'fs_mkdir', 'fs_delete', 'shell', 'http_fetch', 'memory_read', 'memory_write', 'routine_list', 'routine_create', 'routine_update', 'routine_delete'];
