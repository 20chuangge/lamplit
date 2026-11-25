// The one table of 「问不问你」 (1.5.72). Every row is run through the real decision code (AgentRuntime with
// the real tools' risk and escalate), for each of the three levels. `node scripts/ask-table.mjs` prints the
// table as it is; smoke checks it against the expectations below, so a change to any of the scattered rules
// that moves a row shows up here, in one place, in words a person can read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEVELS = [['careful', '谨慎'], ['standard', '标准'], ['auto', '放手']];

/**
 * what: the step in words. call: the tool call. said: what the human said before (a 「发」). draft: someone
 * else's half-written work is on the phone. ask: per level, true = a card, false = runs, 'deny' = refused.
 */
export const ROWS = [
  { what: '读文件', call: ['fs_read', { path: 'a.txt' }], ask: { careful: false, standard: false, auto: false } },
  { what: '写文件（工作区里）', call: ['fs_write', { path: 'out/b.txt', content: 'x' }], ask: { careful: false, standard: false, auto: false } },
  { what: '只是看的命令（dir）', call: ['shell', { command: 'dir', purpose: '看目录' }], ask: { careful: true, standard: false, auto: false } },
  { what: '手机：看屏幕', call: ['phone', { action: 'look' }], ask: { careful: false, standard: false, auto: false } },
  { what: '手机：普通的点（下一步）', call: ['phone', { action: 'tap', target: '下一步' }], ask: { careful: true, standard: true, auto: false } },
  { what: '手机：底部一排里的「发布」入口', call: ['phone', { action: 'tap', target: '发布', entry: true }], ask: { careful: true, standard: true, auto: false } },
  { what: '手机：点「发布笔记」，你没说过发', call: ['phone', { action: 'tap', target: '发布笔记' }], ask: { careful: true, standard: true, auto: true } },
  { what: '手机：点「发布笔记」，你说过「发」', call: ['phone', { action: 'tap', target: '发布笔记' }], said: '发', ask: { careful: false, standard: false, auto: false } },
  { what: '手机：点「发送」，你说过「必须发出去」', call: ['phone', { action: 'tap', target: '发送' }], said: '必须发出去', ask: { careful: false, standard: false, auto: false } },
  { what: '给你看要发的草稿，你没说过发', call: ['post_draft', { channel: '小红书', title: '标题', body: '正文' }], ask: { careful: true, standard: true, auto: true } },
  { what: '手机：点「发布笔记」，你刚在草稿卡上点了允许', call: ['phone', { action: 'tap', target: '发布笔记' }], before: ['post_draft', { channel: '小红书', title: '标题', body: '正文' }], ask: { careful: false, standard: false, auto: false } },
  { what: '手机：点「立即支付」，你说过「发」', call: ['phone', { action: 'tap', target: '立即支付' }], said: '发', ask: { careful: true, standard: true, auto: true } },
  { what: '手机：点「删除」，你说过「发」', call: ['phone', { action: 'tap', target: '删除' }], said: '发', ask: { careful: true, standard: true, auto: true } },
  { what: '手机：点「同意并继续」', call: ['phone', { action: 'tap', target: '同意并继续' }], ask: { careful: true, standard: true, auto: true } },
  { what: '手机：别人填到一半时点「退出」', call: ['phone', { action: 'tap', target: '退出' }], draft: true, ask: { careful: true, standard: true, auto: true } },
  { what: '手机：没有半成品时点「退出」', call: ['phone', { action: 'tap', target: '退出' }], ask: { careful: true, standard: true, auto: false } },
];

/** Run every row at every level -> [{what, careful, standard, auto}] (true = asked). */
export async function runTable({ toolsMod }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-ask-'));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  const out = [];
  try {
    for (const row of ROWS) {
      const line = { what: row.what };
      for (const [level] of LEVELS) {
        const bot = { id: 'pub', name: '发布', role: '发布', persona: 'p', tools: ['fs_read', 'fs_write', 'shell', 'phone', 'post_draft'], skills: [], policy: {} };
        const cards = [];
        let ran = 0;
        let step = 0;
        const model = { provider: 'fake', model: 'fake', complete: async () => {
          step += 1;
          // A step before the one the row is about (the draft the human said yes to): its card is not the row's.
          const calls = row.before ? [row.before, row.call] : [row.call];
          return step <= calls.length ? { content: '', toolCalls: [{ id: `c${step}`, name: calls[step - 1][0], arguments: calls[step - 1][1] }] } : { content: '好。', toolCalls: [] };
        } };
        let rtRef = null;
        const registry = toolsMod.createRegistry({ workspaceDir: ws, config: {}, getRuntime: () => rtRef });
        const realGet = registry.get.bind(registry);
        // The phone is not there: its own escalate decides from the words on the button, as on a real screen.
        registry.get = (name) => {
          const tool = realGet(name);
          if (name !== 'phone' || !tool) return tool ? { ...tool, run: async (...a) => { ran += 1; return name === 'shell' ? { ok: true, stdout: '' } : tool.run(...a); } } : tool;
          return {
            ...tool,
            escalate: async (args, ctx) => {
              if (P.PHONE_LOOK_ACTIONS.has(String(args?.action))) return null;
              const words = P.tapWords(String(args?.target || ''));
              const app = { pkg: 'com.xingin.xhs', label: '小红书' };
              const draft = rtRef.phoneDraftFor(ctx);
              if (draft && P.DISCARD_WORDS.test(words)) return { risk: 'HIGH', alwaysAsk: true, app, phoneKind: 'delete', reason: '会丢掉填到一半的内容' };
              const opens = args?.entry && P.phoneStepKind(words) === 'publish';
              if (P.SENSITIVE_TAP.test(words) && !opens) return { risk: 'HIGH', alwaysAsk: true, app, phoneKind: P.phoneStepKind(words), reason: `点「${args.target}」` };
              return { risk: 'MEDIUM', app, reason: `点「${args.target}」` };
            },
            run: async () => { ran += 1; return { ok: true }; },
          };
        };
        const rt = new A.AgentRuntime({
          config: { workspaceDir: ws, policy: { level } }, registry, model,
          bots: { getBot: async () => bot, listBots: async () => [bot] }, groups: { listGroups: async () => [] },
          memory: { renderMemoryDigest: async () => '' }, skills: { renderSkillsDigest: async () => '' },
          approvals: { cancelForTurn() {}, pendingForTurn: () => [], cancelOrphans: () => [], request(req) { cards.push(req); const p = Promise.resolve({ decision: 'approved', approval: { id: `a${cards.length}` } }); p.record = { id: `a${cards.length}` }; return p; } },
          bus: { emit() {} },
        });
        rtRef = rt;
        rt.humanGoFile = path.join(ws, `go-${Math.random().toString(36).slice(2)}.json`);
        rt.record = async () => {};
        rt.queueMs = 20;
        if (row.said) rt.noteHumanGo(row.said, ['pub']);
        if (row.draft) rt.phoneDraft = { botId: 'art', botName: '美术', chainId: 'other', place: '小红书', at: Date.now(), what: '写到一半' };
        const res = await rt.runTurn({ botId: 'pub', text: '做这一步', source: 'bot', fromBotId: 'lead' }).catch((e) => ({ status: `error ${e.message}` }));
        line[level] = cards.length > (row.before ? 1 : 0) ? true : (ran > 0 || P.PHONE_LOOK_ACTIONS.has(String(row.call[1]?.action)) || row.call[0] === 'fs_read' ? false : `no run (${res?.status})`);
      }
      out.push(line);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return out;
}

export function tableText(lines) {
  const word = (v) => (v === true ? '问你' : v === false ? '直接做' : String(v));
  return ['| 这一步 | 谨慎 | 标准 | 放手 |', '|---|---|---|---|', ...lines.map((l) => `| ${l.what} | ${word(l.careful)} | ${word(l.standard)} | ${word(l.auto)} |`)].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('ask-table.mjs')) {
  const toolsMod = await import('../src/tools.mjs');
  const lines = await runTable({ toolsMod });
  console.log(tableText(lines));
  const off = lines.flatMap((l, i) => LEVELS.filter(([k]) => l[k] !== ROWS[i].ask[k]).map(([k, zh]) => `${l.what} @${zh}: is ${l[k]}, expected ${ROWS[i].ask[k]}`));
  console.log(off.length ? `\nDIFFERS FROM THE TABLE:\n${off.join('\n')}` : '\nmatches the table');
  process.exit(0);
}
