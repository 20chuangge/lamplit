/**
 * abilities.mjs - which tools a bot needs to do its job.
 *
 * A bot that joined the team but cannot read or write a file is decoration:
 * work given to it stalls, or the coordinator quietly stops giving it any.
 * So a new bot starts with the tools every teammate needs (its workspace, the
 * web, its notes, the group), gets the ones its role plainly calls for, and can
 * ask the human for anything else it turns out to need (tool_request) instead
 * of answering "I can't". Granting is not approving: risky calls still ask.
 */

/** Every teammate: look at and write its workspace, fetch a page, keep notes, talk in the group. */
export const BASE_TOOLS = [
  'fs_list', 'fs_read', 'fs_write', 'fs_mkdir',
  'http_fetch',
  'memory_read', 'memory_write',
  'skill_list', 'skill_read',
  'group_post', 'bot_list',
];

/** What a role (or a task) plainly calls for. */
const ROLE_RULES = [
  [/代码|开发|程序|编程|工程师|运维|部署|测试|脚本|服务器|数据库|数据分析|统计|爬虫|自动化|命令行|终端|运行命令|执行命令|跑一下命令|跑命令|装软件|\bshell\b|\bterminal\b|\bcommands?\b|\b(code|coder|coding|dev|developer|engineer|ops|devops|test|qa|script|data)\b/i, ['shell']],
  [/调研|研究|搜索|搜集|收集|资料|浏览|网页|网站|新闻|竞品|采集|查询|检索|\b(research|browse|search|web|news)\b/i, ['browser_open']],
  [/下载|上传|表单|填写|登录|后台|\b(download|upload|form|login)\b/i, ['browser_open']],
  // 1.3.0: work on the human's phone (a 小红书 account lives in the app).
  [/手机|安卓|App\s*里|小红书|抖音|微信里|快手|\b(android|phone|mobile app)\b/i, ['phone']],
];

export function toolsForText(text) {
  const out = new Set();
  const t = String(text || '');
  for (const [re, tools] of ROLE_RULES) if (re.test(t)) for (const x of tools) out.add(x);
  return [...out];
}

/** Tools a bot may ask the human for. Reshaping the team or the product stays with the primary bot. */
const NOT_REQUESTABLE = new Set([
  'bot_create', 'bot_update', 'bot_delete',
  'group_create', 'group_update', 'group_delete',
  'settings_update', 'ui_set', 'machine_switch',
  'tool_request', 'task_finish', 'mcp_find_tools', 'mcp_call',
]);
export function isRequestable(name) {
  const n = String(name || '');
  return Boolean(n) && !NOT_REQUESTABLE.has(n) && !n.startsWith('mcp__') && !(n.startsWith('browser_') && n !== 'browser_open');
}

/** Human words for the card ("给「编剧」加上：命令行"). */
const LABELS = {
  fs_list: '查看文件', fs_read: '读文件', fs_write: '写文件', fs_mkdir: '建文件夹', fs_delete: '删除文件',
  shell: '命令行', cli_agent_run: '编程助手（Claude Code / Codex / Cursor / Qoder）', http_fetch: '抓取网页', browser_open: '浏览器',
  memory_read: '读笔记', memory_write: '记笔记', skill_list: '查看技能', skill_read: '读技能', skill_save: '保存技能',
  routine_create: '建定时任务', routine_list: '查看定时任务', routine_run: '运行定时任务',
  bot_list: '查看成员', bot_message: '找其他机器人帮忙', file_send: '发文件到别的机器', file_fetch: '从别的机器取文件',
  group_post: '在群里发言', group_list: '查看群', settings_get: '查看设置', ui_get: '查看界面', machine_list: '查看机器',
  desktop_ui: '操作桌面', browser_fill_secret: '填写保存的登录信息', phone: '操作手机',
};
export const toolLabel = (name) => (LABELS[name] ? `${LABELS[name]}（${name}）` : name);
/** The same words without the tool's own name, for what the human reads (1.5.41: 「命令行（shell）」 on a card). */
export const toolWords = (name) => LABELS[name] || '';

/** The grant list for a new bot: base + what its role calls for + what was asked for, known tools only. */
/**
 * On a machine given to the bots (a Linux box set up by setup-linux.sh), a new
 * bot starts with every everyday tool: the machine is theirs, and asking for
 * each one held up the work (11-15, Ubuntu). Not coding assistants (they spend
 * the human's subscription) nor the desktop. The human can switch any off.
 */
export const REMOTE_FULL_TOOLS = [
  'shell', 'fs_delete', 'browser_open', 'bot_message', 'bot_pass', 'file_send', 'file_fetch',
  'skill_save', 'routine_list', 'routine_create', 'routine_run', 'group_list', 'machine_list',
];

export function grantsForNewBot({ role = '', requested = [], known = null, remote = false } = {}) {
  const out = new Set([...BASE_TOOLS, ...(remote ? REMOTE_FULL_TOOLS : []), ...toolsForText(role), ...(Array.isArray(requested) ? requested.map(String) : [])]);
  return [...out].filter((t) => !known || known.has(t));
}

/** A short "can do" line for the coordinator's member list. */
export function abilitySummary(tools) {
  const has = new Set(tools || []);
  const parts = [];
  if (has.has('fs_write')) parts.push('写文件');
  if (has.has('shell')) parts.push('命令行');
  if (has.has('browser_open')) parts.push('浏览器');
  if (has.has('http_fetch')) parts.push('抓网页');
  if (has.has('cli_agent_run')) parts.push('编程助手（Claude Code/Codex/Cursor/Qoder）');
  if (has.has('desktop_ui')) parts.push('操作桌面');
  return parts.length ? parts.join('、') : '还没有工具';
}
