// 1.5.70: from the evening of 11-25, one 小红书 note tried 13 times (267 steps) and never submitted.
//   1. An OPPO system service rewrote the list of enabled accessibility services each time the keyboard was
//      closed; Lamplit's fell out and came back 2.5 s later, and the step in between was answered "off".
//   2. 「必须发出去」 was not a go; the go said before Lamplit updated itself was forgotten; 小红书's bottom
//      「发布」 tab (it opens the editor) asked like a publish.
//   3. A member's card showed only in the member's own chat, not in the group the task was given in.
//   4. Two places said who works (a line and the strip); the strip sat at the window's left edge, and was
//      empty for seconds after leaving the group and coming back.
//   5. Every five minutes the other machine showed as 离线 for the 7 s the direct addresses were tried again.
// Called from smoke.mjs as a stage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function fix1570Checks({ check, readText }) {
  const A = await import('../src/agent.mjs');
  const P = await import('../src/phone.mjs');

  // --- 1. the phone waits for its service -------------------------------------------------------------
  const watcher = await readText('../mobile/android/app/src/main/java/com/desk/assistant/NightshiftWatcher.java');
  const wait = watcher.slice(watcher.indexOf('private PhoneAgentService waitForAgent()'), watcher.indexOf('/** Do one step a machine sent'));
  check('WAIT70-1 a step that arrives while the phone\'s service is out (and the human still wants it on) puts it back and waits up to 12 s for it, instead of answering 「off」; with the human\'s own off it answers at once',
    watcher.includes('PhoneAgentService agent = "save_media".equals(event.optString("action", "")) ? PhoneAgentService.instance : waitForAgent();')
    && wait.includes('if (agent != null || !AgentKeeper.wanted(this)) return agent;') && wait.includes('+ 12000;') && wait.includes('AgentKeeper.ensure(this); nextEnsure = now + 1500;')
    && wait.includes('return PhoneAgentService.instance;'));

  // --- 2. the go ---------------------------------------------------------------------------------------
  const yes = ['发', '必须发出去', '继续发', '现在发吧', '那就发', '直接发布', '赶紧发出去', '好，发', '可以排', '提交定时', '马上发'];
  const no = ['现在可以发布吗？', '发给我看看', '先别发', '到底发还是不发', '继续', '已经好了', '只用手机', '哪里关了，开着呢', '发现一个问题', '发我', 'ok', '可以', '必须', '发什么', '发布记录给我'];
  check('GO70-1 a word of urgency in front is still a go (必须发出去 / 继续发 / 马上发 / 提交定时); a question, 「继续」 alone, 「发给我看看」 are not',
    yes.every((t) => A.GO_WORDS.test(t)) && !no.some((t) => A.GO_WORDS.test(t)), JSON.stringify({ missed: yes.filter((t) => !A.GO_WORDS.test(t)), wrong: no.filter((t) => A.GO_WORDS.test(t)) }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamplit-fix70-'));
  try {
    const file = path.join(dir, 'human-go.json');
    const one = Object.create(A.AgentRuntime.prototype);
    one.humanGoFile = file;
    one.noteHumanGo('必须发出去', ['pub', 'lead']);
    const two = Object.create(A.AgentRuntime.prototype); // Lamplit started again
    two.humanGoFile = file;
    const kept = Boolean(two.humanGoFor('pub')) && Boolean(two.humanGoFor('lead')) && !two.humanGoFor('other');
    const late = two.humanGoFor('pub', Date.now() + 3 * 3600 * 1000);
    two.noteHumanGo('先别发', ['pub']);
    const three = Object.create(A.AgentRuntime.prototype);
    three.humanGoFile = file;
    check('GO70-2 the go outlives a restart (kept in a file, who and when only), still two hours, and 「先别发」 takes it back there too; the file stays out of the backup',
      kept && late === null && !three.humanGoFor('pub') && Boolean(three.humanGoFor('lead'))
      && (await readText('../src/backup.mjs')).includes("'human-go.json',"), JSON.stringify({ kept, late }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The bottom bar's 「发布」 opens the editor; the editor's own 「发布笔记」 publishes.
  const nd = (text, l, t, r, b, extra = {}) => ({ text, desc: '', id: '', bounds: [l, t, r, b], clickable: extra.clickable !== false, editable: Boolean(extra.editable) });
  const home = [nd('推荐', 300, 150, 500, 230), nd('一篇笔记的标题', 40, 400, 520, 900), nd('首页', 0, 2260, 216, 2400), nd('市集', 216, 2260, 432, 2400), nd('发布', 432, 2260, 648, 2400), nd('消息', 648, 2260, 864, 2400), nd('我', 864, 2260, 1080, 2400)];
  const editor = [nd('添加标题', 40, 500, 1040, 600, { editable: true }), nd('话题', 40, 2100, 200, 2180), nd('用户', 0, 2260, 30, 2400), nd('存草稿', 40, 2260, 300, 2400), nd('地点', 300, 2260, 340, 2400), nd('发布笔记', 340, 2260, 1040, 2400)];
  const confirm = [nd('确认发布这篇笔记？', 140, 1000, 940, 1100, { clickable: false }), nd('取消', 140, 1200, 540, 1320), nd('发布', 540, 1200, 940, 1320)];
  const two = [nd('一张图', 0, 300, 1080, 1800), nd('存草稿', 40, 2260, 500, 2400), nd('发布', 540, 2260, 1040, 2400)];
  const seen = {
    home: { entry: P.opensAComposer(home[4], home) }, editor: { entry: P.opensAComposer(editor[5], editor) },
    confirm: { entry: P.opensAComposer(confirm[2], confirm) }, two: { entry: P.opensAComposer(two[2], two) },
  };
  const tools = await readText('../src/tools.mjs');
  check('TAB70-1 「发布」 in an app\'s bottom bar (a row of five, no box to write in) only opens the editor: an ordinary tap; the editor\'s 「发布笔记」 and a 「发布」 in a confirm box still ask',
    seen.home.entry === true && seen.editor.entry === false && seen.confirm.entry === false && seen.two.entry === false
    && (await readText('../src/phone.mjs')).includes('entry: Boolean(node && ui && opensAComposer(node, ui.nodes))') && tools.includes("const opens = action === 'tap' && seen.entry && phoneStepKind(words) === 'publish';") && tools.includes('&& !(action === \'tap\' && seen.clearsBox) && !opens) {'),
    JSON.stringify(seen));

  // --- 3 & 4. the group on screen -----------------------------------------------------------------------
  const side = await readText('../public/app/main/04b-sidebar.js');
  const live = await readText('../public/app/main/06-live.js');
  const groups = await readText('../public/app/main/03-groups.js');
  const css = await readText('../public/app/style.css');
  check('CARD70-1 a member\'s card that waits for the human is drawn in the group, under the member\'s name: from this machine\'s approvals, or from the inbox for a group on another machine; answered through the same routes as in its own chat',
    side.includes("appendApprovalCard(approvalCardData(approval), groupFace(approval.botId));") && side.includes("appendApprovalCard(inboxCardData(item), groupFace(item.botId, item.botName));")
    && side.includes("if (item.machine !== far.machine || !ids.has(item.botId) || !item.toolName) continue;") && side.includes('if (state.groupId === gid) drawGroupCards(gid)')
    && live.includes('function approvalCardData(approval) {') && live.includes('const data = approvalCardData(approval);'));
  check('STRIP70-1 one place says who works in a group: the line under the messages goes into the strip (no second 「正在转交给同事…」); the strip is drawn at once from what was last known, before the messages load, and is as wide as the box under it',
    live.includes("if (isGroupMode()) { messagesEl.querySelector('.typing-row')?.remove(); groupTyping(botId, label); return; }") && live.includes("if (state.groupLive) groupTyping(null, '');")
    && side.includes('drawGroupWorking(); // what was known when this group was last open, until the answer comes') && side.includes('state.groupWorkingTimer = setInterval(tick, 3000);')
    && /watchGroupWorking\(\);[^\n]*\n  await loadGroupMessages\(\);/.test(groups.replace(/\r\n/g, '\n'))
    && css.includes('max-width: calc(760px + 48px); margin: 6px auto 0; padding: 0 24px;'));

  // --- 5. the other machine does not blink 离线 ----------------------------------------------------------
  const desk = await readText('../desktop/main.mjs');
  check('ROUTE70-1 a kept way that still answers is used at any age; after 5 minutes the direct addresses are tried again behind the scenes, once at a time',
    desk.includes('if (kept && kept.base !== url && await probeHub(kept.base)) {') && desk.includes('if (Date.now() - kept.at >= ROUTE_KEEP_MS && !routeLooking.has(url)) {')
    && desk.includes('findRoute(url).then((base) => { if (base) keepRoute(url, base); }).catch(() => {}).finally(() => routeLooking.delete(url));'));
}
