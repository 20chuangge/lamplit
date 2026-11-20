/**
 * approvals.mjs - the human-in-the-loop boundary.
 *
 * Three risk tiers, one rule set:
 *   LOW     auto-runs. Reading a file inside the workspace.
 *   MEDIUM  auto-runs only when the bot's policy says autoApproveMedium,
 *           otherwise it asks. Shell commands, network fetches, writes to the
 *           shared skill library.
 *   HIGH    always asks. Danger-denylisted shell commands, anything that touches
 *           the filesystem outside the shared workspace, sending messages on the
 *           user's behalf.
 *
 * There is exactly one decision function (classify) so the UI, the audit log and
 * the agent loop can never disagree about why something was allowed.
 */

import path from 'node:path';
import { uid, nowIso } from './store.mjs';
import { lookOnly } from './boundary.mjs';
import { applyEdits, cleanEdits } from './drafts.mjs';

export const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };
export const DECISION = { AUTO: 'auto', ASK: 'ask', DENY: 'deny' };

/**
 * Danger denylist for the shell tool. Anything matching is promoted to HIGH,
 * i.e. it cannot run without a human clicking approve - regardless of what the
 * bot's policy says about medium-risk commands.
 *
 * These are intentionally broad and ugly: the point is to catch the obvious
 * catastrophes, not to be a sandbox. The README says so out loud.
 */
export const DEFAULT_DENY_PATTERNS = [
  'rm\\s+-rf',
  'rm\\s+-fr',
  // rm -r -f / -f -r / --recursive --force / -v -rf ... (matched case-insensitively, so -Rf too)
  '\\brm\\s+(?:-{1,2}[a-z-]+\\s+)*-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive)\\b',
  '\\brm\\s+(?:-\\S+\\s+)*-r\\S*\\s+(?:-\\S+\\s+)*-f',
  '\\brm\\s+(?:-\\S+\\s+)*-f\\S*\\s+(?:-\\S+\\s+)*-r',
  // download, then run what came down
  '\\b(iwr|Invoke-WebRequest|curl|wget)\\b[^\\n]*\\s-(o|OutFile|O)\\b[^\\n]*[;&]+\\s*(\\.\\\\|\\./|sh\\s|bash\\s|start\\s|powershell)',
  '\\bdel\\s+/[sfq]\\b',
  '\\brmdir\\s+/s\\b',
  '\\bformat\\s+[a-z]:',
  '\\bmkfs\\b',
  '\\bdd\\s+if=',
  '\\b(shutdown|reboot|halt|poweroff)\\b',
  '\\bsudo\\b',
  '\\brunas\\b',
  '\\breg\\s+delete\\b',
  '\\bnet\\s+user\\b.*\\/add',
  '\\bcurl\\b[^|]*\\|\\s*(ba)?sh',
  '\\bwget\\b[^|]*\\|\\s*(ba)?sh',
  '\\biwr\\b[^|]*\\|\\s*iex',
  '\\bchmod\\s+777\\s+/',
  '(?:^|[;&|\\s]):\\(\\)\\s*\\{', // fork bomb (no \b: a colon has no word edge)
  '\\bgit\\s+push\\s+--force\\b',
  '\\bgit\\s+reset\\s+--hard\\b',
  '>\\s*/dev/(sd[a-z]|vd[a-z]|hd[a-z]|nvme\\d)',
  '\\bRemove-Item\\b.*-Recurse\\b',
  // Windows: fetch a program and run it, or make something start by itself (1.5.32)
  '\\bcertutil\\b[^\\n]*-urlcache\\b',
  '\\bbitsadmin\\b[^\\n]*/transfer\\b',
  '\\bschtasks\\b[^\\n]*/create\\b',
  '\\breg\\s+add\\b[^\\n]*\\\\(Run|RunOnce|Winlogon)\\b',
];

/**
 * On a remote machine (an idle PC or VM given to the assistant) bots run with
 * sudo and without approval cards. Only what would cut the machine off or
 * wipe it still waits for a human: losing the box is not something a bot can
 * undo by itself.
 */
// A word only counts as the command when it is in command position: at the
// start, after ; & | ` ( or after sudo. "x11vnc -storepasswd ... /vnc/passwd"
// or "cat /etc/passwd" is not the passwd command (the old pattern blocked both).
const CMD = '(?:^|[;&|`(]\\s*|\\bsudo\\s+(?:-\\S+\\s+)*)';

export const REMOTE_DENY_PATTERNS = [
  '\\brm\\s+(-\\S+\\s+)*(/|/\\*|~|/home|/etc|/usr|/var|/boot|/opt/desk-hub)(\\s|$)', // rm of / or a system root
  `${CMD}mkfs`,
  '\\bdd\\b[^|;&]*\\bof=/dev/',
  '>\\s*/dev/(sd|nvme|vd|hd)[a-z]',
  `${CMD}(shutdown|poweroff|halt)\\b`,
  `${CMD}init\\s+0\\b`,
  '\\bsystemctl\\s+(stop|disable|mask|kill)\\s+(ssh|sshd|desk-hub)(\\.service)?\\b',
  '\\bufw\\s+(enable|default\\s+deny)\\b',
  '\\biptables\\b.*-P\\s+INPUT\\s+DROP',
  `${CMD}(passwd|userdel|deluser)\\b`,
  // The desktop is reached only through the paired hub: never open it to the network.
  '\\bx11vnc\\b.*\\s-listen\\s+(?!127\\.|localhost\\b)',
  '\\bwebsockify\\b.*\\b0\\.0\\.0\\.0:',
  'LoopbackOnly\\b.*\\b0\\b',
  '(?:^|[;&|\\s]):\\(\\)\\s*\\{', // fork bomb
  // Windows hubs
  '\\bformat(\\.com)?\\s+[a-z]:',
  '\\b(Format-Volume|Clear-Disk|Initialize-Disk|Stop-Computer)\\b',
  '\\bRemove-Item\\b.*\\s[a-z]:\\\\?(\\*)?(\\s|$)', // a whole drive
  '\\b(rd|rmdir)\\s+/s\\b.*\\s[a-z]:\\\\?(\\s|$)',
  '\\b(Stop-Service|Set-Service|sc(\\.exe)?\\s+(stop|config))\\b.*\\bsshd\\b',
  '\\b(Disable|Unregister|Stop)-ScheduledTask\\b.*NightshiftHub',
  '\\bnet\\s+user\\b.*\\/(delete|passwordreq)',
  '\\bSet-LocalUser\\b.*-Password\\b',
  '\\bnetsh\\s+advfirewall\\b.*\\bblock',
];

/**
 * Approval levels a human picks per machine:
 *   careful  - every medium and high risk action asks, for every bot
 *   standard - high risk asks; medium asks unless the bot is trusted (today's default)
 *   auto     - everything runs; only the danger list still asks
 */
export const APPROVAL_LEVELS = ['careful', 'standard', 'auto'];

/** A plain phrase the human typed ("git push") as a whole-word pattern. */
export function phraseToPattern(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return '';
  return `(?:^|[^\\w-])${words.join('\\s+')}(?![\\w-])`;
}

/** 'remote' on a machine set up by hub/setup-linux.sh, 'local' otherwise. */
export function machineMode() {
  return process.env.DESK_MACHINE_MODE === 'remote' ? 'remote' : 'local';
}

/**
 * The approval policy that actually applies here. On this computer the human
 * opts into autonomy (autoApproveAll); on a remote machine autonomy is the
 * default and can be switched off (remoteAutonomy: false).
 */
export function effectivePolicy(configPolicy = {}) {
  const mode = machineMode();
  const remote = mode === 'remote';
  // Older configs only had the on/off switch: map it onto the levels.
  const legacyAuto = remote ? configPolicy.remoteAutonomy !== false : Boolean(configPolicy.autoApproveAll);
  const level = APPROVAL_LEVELS.includes(configPolicy.level) ? configPolicy.level : (legacyAuto ? 'auto' : 'standard');
  // A list saved in config (older installs copied the defaults there) adds to
  // the built-in one; it never replaces it, or fixes to the defaults never land.
  const builtin = remote
    ? REMOTE_DENY_PATTERNS
    : [...new Set([...DEFAULT_DENY_PATTERNS, ...(configPolicy.denyPatterns || [])])];
  // The human's own additions never replace the built-in floor.
  const extra = (configPolicy.extraDeny || []).map((e) => e?.pattern).filter(Boolean);
  return {
    mode,
    level,
    autonomous: level === 'auto',
    careful: level === 'careful',
    builtinDeny: builtin,
    extraDeny: configPolicy.extraDeny || [],
    denyPatterns: [...builtin, ...extra],
  };
}

/**
 * Does medium risk run without asking for this bot and this call? (SEC-04)
 *   careful   - never
 *   standard  - a trusted bot (autoApproveMedium) does routine work, but a
 *               shell command runs unasked only when it just looks (ls, df,
 *               ps | grep); one that may change things asks, as the UI says
 *   auto      - always (the danger list still asks)
 */
export function mediumRunsUnasked({ careful = false, autonomous = false, trusted = false, toolName = '', args = {} } = {}) {
  if (careful) return false;
  if (autonomous) return true;
  if (!trusted) return false;
  return toolName !== 'shell' || lookOnly(String(args?.command || '')).look;
}

/**
 * "以后都允许" (1.2.164): what counts as the same permission next time.
 *   shell      - the program it runs (python3, npm, git); `cd`, env settings and
 *                sudo in front do not count, so `cd x && python3 -` is python3
 *   file tools - the folder (writing a.md and b.md in one folder is one permission)
 *   others     - the tool
 * -> {key, label} or null (nothing to remember).
 */
// Programs that run whatever code they are given (1.5.33). 「以后都允许」 stays by
// program for them too - a bot must be able to finish a job on its own - and what
// a command does decides the rest: the danger list, places outside the workspace
// and Lamplit's own keys keep asking. With the bots' commands not isolated, the
// card says so for these (agent.mjs adds remember.warn).
export const CODE_RUNNERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'pythonw', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'perl', 'ruby', 'php', 'deno', 'bun', 'npx', 'bunx', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'osascript', 'java', 'lua', 'rscript', 'tclsh', 'start', 'invoke-expression', 'iex', 'xargs', 'awk', 'gawk']);
const PIPE_FILTERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'head', 'tail', 'wc', 'cut', 'tr', 'column', 'nl', 'findstr', 'select-object', 'select', 'where-object', 'where', 'sort-object', 'measure-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'jq', 'cat', 'echo', 'printf', 'true', 'q']);
const FILE_VERBS = { fs_write: '写文件', fs_mkdir: '建文件夹', fs_delete: '删文件', fs_read: '读文件', fs_list: '查看文件', fs_move: '移动文件', fs_copy: '复制文件' };
export function permissionKey(toolName, args = {}, { workspaceDir = '', phoneApp = null } = {}) {
  const name = String(toolName || '');
  if (!name) return null;
  if (name === 'shell') {
    const command = String(args?.command || '').trim();
    const program = mainProgram(command);
    if (!program) return null;
    // `git status && node x.js` runs node too: it goes by only when every program in it was allowed.
    // (Filters on a pipe - grep, sort, head, findstr… - do not count: they only shape the output.)
    const also = [...new Set(allPrograms(command))].filter((p) => p !== program && !PIPE_FILTERS.has(p)).map((p) => `shell:${p}`);
    return { key: `shell:${program}`, label: `用 ${program} 运行命令`, ...(also.length ? { also } : {}), ...(CODE_RUNNERS.has(program) ? { runsCode: true } : {}) };
  }
  // The phone (1.3.0): allowed for good per app ("在手机的小红书里点、滑、输入").
  if (name === 'phone') {
    const pkg = String(phoneApp?.pkg || '').trim();
    return pkg ? { key: `phone:${pkg}`, label: `在手机的「${phoneApp.label || pkg}」里点、滑、输入、打开` } : { key: 'phone', label: '在手机上点、滑、输入' };
  }
  if (FILE_VERBS[name]) {
    const raw = args?.path ?? args?.from ?? args?.src;
    if (raw === undefined || raw === null || raw === '') return { key: name, label: FILE_VERBS[name] };
    const abs = path.resolve(workspaceDir || '.', String(raw));
    const dir = path.dirname(abs);
    return { key: `${name}:${dir.toLowerCase()}`, label: `在 ${dir} 里${FILE_VERBS[name]}` };
  }
  return { key: name, label: name };
}

/** Every program a command line runs (each part of a chain or pipe), past cd and wrappers. */
export function allPrograms(command) {
  const out = [];
  // A heredoc's body and quoted text are data, not commands (python3 - <<EOF … EOF, node -e "a; b").
  const bare = String(command || '')
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, '<<HEREDOC')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q');
  for (const part of bare.split(/&&|\|\||[;|\n]/)) {
    const p = mainProgram(part);
    if (p) out.push(p);
  }
  return out;
}

/** The program a command line is really about: past cd, env settings, sudo/env/nohup. */
export function mainProgram(command) {
  for (const part of String(command || '').split(/&&|\|\||[;|\n]/)) {
    let rest = part.trim().replace(/^&\s*/, '');
    // Settings and wrappers in front: FOO=1 sudo env nohup ... python3
    for (;;) {
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env|nohup|time|exec|command)(?:\s+|$)/.exec(rest);
      if (!m) break;
      rest = rest.slice(m[0].length);
    }
    const w = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(rest);
    const first = w ? (w[1] || w[2] || w[3]) : '';
    if (!first || /^(cd|pushd|popd|set|export|echo|true|:)$/i.test(first) || first.startsWith('#')) continue;
    const base = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
    if (base) return base;
  }
  return '';
}

/** Has the human allowed this for good for this bot? */
export function isRemembered(bot, key) {
  return Boolean(key) && Array.isArray(bot?.policy?.allowed) && bot.policy.allowed.some((a) => a && a.key === key);
}

/** Patterns that do not compile (they would never match): checked at start. */
export function invalidDenyPatterns(patterns = []) {
  const bad = [];
  for (const p of patterns) {
    try {
      new RegExp(p, 'i');
    } catch (err) {
      bad.push({ pattern: p, error: err.message });
    }
  }
  return bad;
}

/** Which deny patterns match this shell command (for the audit "reason"). */
export function matchedDenyPatterns(command, patterns = DEFAULT_DENY_PATTERNS) {
  const text = String(command || '');
  const hits = [];
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) hits.push(p);
    } catch {
      /* ignore malformed patterns */
    }
  }
  return hits;
}

/**
 * Decide what happens to one tool call.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} policy {
 *   baseRisk: 'LOW'|'MEDIUM'|'HIGH',   // from the registry, already escalated by the tool
 *   granted: boolean,                  // is this tool granted to this bot?
 *   autoApproveMedium: boolean,
 *   denyPatterns: string[],
 *   unattended: boolean,
 *   extraRiskReason?: string           // e.g. "path is outside the shared workspace"
 * }
 * @returns {{risk: string, decision: string, reason: string}}
 */
export function classify(toolName, args, policy = {}) {
  const {
    baseRisk = RISK.MEDIUM,
    granted = true,
    autoApproveMedium = false,
    denyPatterns = DEFAULT_DENY_PATTERNS,
    extraRiskReason = '',
  } = policy;

  // 1. Tool grants are an allow-list, not a hint.
  if (!granted) {
    return {
      risk: RISK.HIGH,
      decision: DECISION.DENY,
      reason: `${toolName} is not granted to this bot`,
    };
  }

  let risk = baseRisk;
  let reason = extraRiskReason;
  let denylisted = false;

  // 2. Hard escalations that override whatever the tool declared.
  if (toolName === 'shell') {
    const hits = matchedDenyPatterns(args?.command, denyPatterns);
    if (hits.length) {
      risk = RISK.HIGH;
      denylisted = true;
      reason = `command matches danger denylist (${hits.slice(0, 2).join(', ')})`;
    }
  }
  if (!reason) {
    reason = risk === RISK.LOW ? 'low-risk tool' : risk === RISK.MEDIUM ? 'medium-risk tool' : 'high-risk tool';
  }

  // 3. Risk -> decision.
  //
  // `autoApproveAll` is for a machine the human has dedicated to the assistant
  // (an idle PC or a cloud VM). It removes the *prompt*, not the *guard*: the
  // denylist still escalates to HIGH and is still denied below, and every
  // decision keeps landing in the audit log so nothing runs unrecorded.
  const autonomous = policy.autoApproveAll === true;
  if (risk === RISK.HIGH) {
    if (autonomous && !denylisted) {
      return { risk, decision: DECISION.AUTO, reason: `${reason}; auto-approved (autonomous mode)` };
    }
    return { risk, decision: DECISION.ASK, reason };
  }
  if (risk === RISK.MEDIUM) {
    return autoApproveMedium || autonomous
      ? { risk, decision: DECISION.AUTO, reason: `${reason}; auto-approved by policy` }
      : { risk, decision: DECISION.ASK, reason };
  }
  return { risk, decision: DECISION.AUTO, reason };
}

/**
 * Pending-approval queue.
 *
 * The agent loop awaits `request(...)`. The HTTP layer resolves it when the
 * human clicks approve/deny. A 10-minute timer denies by timeout so a forgotten
 * card cannot hold a turn open forever (the timer is unref'd so it never keeps
 * the process alive on its own).
 */
const MAX_FINISHED_RECORDS = 500;

/**
 * A card a scheduled run left behind (it stopped instead of waiting) is kept
 * for a day: long enough to see it and run the routine again, not so long that
 * "1 个操作等你确认" stays up for good (1.3.2).
 */
export const PARKED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The note on a card that closed because the human wrote something new in that
 * chat instead of answering it (1.5.40). The page shows 已取消 and the rest.
 */
export const NEW_MESSAGE_NOTE = '已取消：你发了新消息';
/** How a card that is no longer waiting reads when it is answered again (1.5.41). */
const ALREADY = { approved: '已经允许过了', denied: '已经拒绝过了', timeout: '已经过时了', dismissed: '已经收起了', expired: '已经过期收起了' };
const parkedTooOld = (r, now = Date.now()) => r.status === 'awaiting_human' && now - Date.parse(r.createdAt || 0) > PARKED_TTL_MS;

export class ApprovalQueue {
  constructor({ timeoutMs = 10 * 60 * 1000, onAudit = async () => {}, onPersist = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onAudit = onAudit;
    /**
     * Called with the list of records still waiting for a human, every time
     * that list changes. The server writes it to data/pending.json so a crash
     * does not lose the decision the human was about to make.
     */
    this.onPersist = onPersist;
    /** @type {Map<string, object>} */
    this.records = new Map();
    this.waiters = new Map(); // id -> {resolve, timer}
  }

  /** Everything a human still has to look at. */
  pendingRecords() {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending' || record.status === 'awaiting_human')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  persist() {
    try {
      this.onPersist(this.pendingRecords());
    } catch (err) {
      console.error('[approvals] persist failed:', err.message);
    }
  }

  /**
   * Rehydrate approvals that were still pending when the process died.
   *
   * They have no waiter (the turn that asked is gone), so `decide` records the
   * human's answer instead of resuming work - see restore + decide below.
   */
  restore(records = []) {
    let restored = 0;
    for (const saved of records) {
      if (!saved?.id || !saved.toolName) continue;
      if (saved.status !== 'pending' && saved.status !== 'awaiting_human') continue;
      if (this.records.has(saved.id)) continue;
      // A routine's card from more than a day ago is not brought back.
      if (parkedTooOld(saved)) continue;

      const record = {
        ...saved,
        restored: true,
        restoredAt: nowIso(),
      };
      // Approving a restored card replays one call: a card for several commands
      // comes back as the card for its first one (1.5.40).
      if (record.batch) {
        try { const a = JSON.parse(record.args); delete a.commands; record.args = JSON.stringify(a); } catch { /* keep the args as they are */ }
        delete record.batch;
      }
      delete record.lookTurn;
      this.records.set(record.id, record);
      restored += 1;
      // A routine's card has no turn to time out; it expires after a day (list()).
      if (record.status === 'awaiting_human') continue;

      // Give a restored card the same appeal window as a fresh one.
      const timer = setTimeout(() => {
        this.settle(record.id, 'timeout', 'approval window expired after a restart');
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    if (restored) this.persist();
    return restored;
  }

  /**
   * Ask for permission. Resolves with {decision:'approved'|'denied'|'timeout', note}.
   *
   * In unattended mode (a routine firing while nobody is watching) we do NOT
   * block: we park a pending record, hand back 'needs_approval', and let the
   * routine report that in chat. That is the honest behaviour - a scheduled run
   * should never hang for ten minutes pretending to work.
   */
  request({ turnId, botId, toolName, args, risk, reason, unattended = false, remember = null, batch = null, lookTurn = false, look = false, draft = null, adjust = null, handoff = null }) {
    const id = uid('ap');
    const record = {
      id,
      turnId,
      botId,
      toolName,
      args: truncateArgs(args),
      risk,
      reason,
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
      note: '',
      unattended,
      // What "以后都允许" would remember ({key, label}); absent when it always asks.
      ...(remember?.key ? { remember: { key: String(remember.key), label: String(remember.label || remember.key) } } : {}),
      // One card for several commands that only look (1.5.40): each one in full.
      ...(Array.isArray(batch?.commands) && batch.commands.length > 1 ? { batch: { commands: batch.commands.map((c) => String(c).slice(0, 1000)).slice(0, 20) } } : {}),
      // Allowing this also lets the turn's later look-only commands run unasked.
      ...(lookTurn ? { lookTurn: true } : {}),
      // Commands that only look: the card says so before and after it is answered.
      ...(look ? { look: true } : {}),
      // Something going out (1.5.45): the card shows its text in boxes the human can edit.
      ...(draft && Array.isArray(draft.fields) ? { draft } : {}),
      // A change to a bot (1.5.45): before and after, line by line.
      ...(adjust ? { adjust } : {}),
      // The first hand-off to a machine (1.5.45): which machine and bot.
      ...(handoff ? { handoff } : {}),
    };
    this.records.set(id, record);
    void this.onAudit({ kind: 'approval.requested', ...record });

    if (unattended) {
      record.status = 'awaiting_human';
      const parked = Promise.resolve({ approval: record, decision: 'needs_approval', note: '' });
      // Callers need the record id synchronously to push it to the UI, even
      // though the decision itself is asynchronous.
      parked.record = record;
      this.persist();
      return parked;
    }

    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, 'timeout', 'no response within the approval window');
        // settle() resolves the waiter; nothing else to do here.
      }, this.timeoutMs);
      // Do not let a pending approval keep a headless process alive.
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.set(id, { resolve, timer });
    });
    promise.record = record;
    this.persist();
    return promise;
  }

  /**
   * Human decision from the UI/API. Returns the updated record, or null.
   *
   * A record parked by an unattended run ("awaiting_human") can still be
   * decided - we record the human's answer for the audit trail and flag it as
   * late, but we do NOT resume the finished run. Re-running the routine is the
   * explicit way to continue; see README "what this replica does NOT do".
   */
  decide(id, decision, note = '', by = 'human', { decidedOn = '', edits = null } = {}) {
    const record = this.records.get(id);
    if (!record) return null;
    // Answered already (another device, another machine, or a second click):
    // said so in words, never "unknown decision" (1.5.41).
    if (record.status !== 'pending' && record.status !== 'awaiting_human') {
      return { ...record, error: `这张卡${ALREADY[record.status] || '已经处理过了'}，不用再点。` };
    }
    // Answered on another of the human's machines (1.5.41 一个待办箱): which one, in the record and the log.
    if (decidedOn) record.decidedOn = String(decidedOn).slice(0, 60);
    // A routine's card: "不用了", or "现在跑一次" (the server starts the run).
    if (record.status === 'awaiting_human' && ['dismiss', 'rerun'].includes(String(decision || '').toLowerCase())) {
      record.status = 'dismissed';
      record.decidedAt = nowIso();
      record.note = String(note || (String(decision).toLowerCase() === 'rerun' ? '现在跑一次' : '不用了'));
      record.by = by;
      record.late = true;
      this.records.set(id, record);
      void this.onAudit({ kind: 'approval.resolved', ...record });
      this.persist();
      return { ...record };
    }
    const normalized = normalizeDecision(decision);
    if (!normalized) return { ...record, error: `这张卡不能这样处理（${String(decision).slice(0, 20)}）` };
    // The human's edits to a draft (1.5.45): only its own fields, checked before anything is approved.
    // A card that is not a draft takes no edits (a command cannot be changed by "editing" its card).
    if (normalized === 'approved' && record.draft && edits) {
      const clean = cleanEdits(record.draft, edits);
      if (clean) {
        let args = {};
        try { args = JSON.parse(record.args); } catch { /* the card's own copy may be cut; the turn applies the edits */ }
        const tried = applyEdits(args, record.draft, clean);
        if (tried.error) return { ...record, error: tried.error, editError: true };
        record.edits = clean;
        record.edited = Object.keys(clean).some((k) => String(clean[k]) !== String(record.draft.fields.find((f) => f.key === k)?.value ?? ''));
        if (!record.edited) delete record.edits;
      }
    }

    if (record.status === 'awaiting_human') {
      record.status = normalized === 'approved' ? 'approved' : 'denied';
      record.decidedAt = nowIso();
      record.note = String(note || '');
      record.by = by;
      record.late = true;
      this.records.set(id, record);
      void this.onAudit({ kind: 'approval.resolved', ...record });
      this.persist();
      return { ...record, late: true };
    }

    this.settle(id, normalized, note, by);
    return this.records.get(id);
  }

  settle(id, decision, note = '', by = 'system') {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.status !== 'pending') return record;

    record.status = decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timeout' : 'denied';
    record.decidedAt = nowIso();
    record.note = String(note || '');
    record.by = by;
    // A card that outlived its turn is answered after the fact: record it, but
    // do not pretend the run picked the decision up.
    if (record.restored) record.late = true;
    this.records.set(id, record);
    void this.onAudit({ kind: 'approval.resolved', ...record });
    this.persist();
    this.prune();

    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ approval: record, decision: record.status, note: record.note });
    }
    return record;
  }

  get(id) {
    return this.records.get(id) || null;
  }

  /**
   * Keep the newest 500 finished cards in memory (BUG-03): a hub that runs
   * for months would otherwise grow forever. The audit file keeps every one.
   */
  prune(keep = MAX_FINISHED_RECORDS) {
    const finished = [...this.records.values()].filter((r) => r.status !== 'pending' && r.status !== 'awaiting_human');
    if (finished.length <= keep) return;
    finished.sort((a, b) => String(a.decidedAt || a.createdAt).localeCompare(String(b.decidedAt || b.createdAt)));
    for (const r of finished.slice(0, finished.length - keep)) this.records.delete(r.id);
  }

  /** Routine cards older than a day: expired, off the "waiting for you" list. */
  expireParked(now = Date.now()) {
    let changed = false;
    for (const r of this.records.values()) {
      if (!parkedTooOld(r, now)) continue;
      r.status = 'expired';
      r.decidedAt = nowIso();
      r.note = '定时任务的这一步过了一天没人处理，已收起';
      changed = true;
      void this.onAudit({ kind: 'approval.expired', ...r });
    }
    if (changed) this.persist();
  }

  list({ status, botId, limit = 100 } = {}) {
    this.expireParked();
    let out = [...this.records.values()];
    // "pending" means "a human still has something to do", which includes the
    // cards an unattended routine parked instead of waiting for.
    if (status === 'pending') out = out.filter((r) => r.status === 'pending' || r.status === 'awaiting_human');
    else if (status === 'history') out = out.filter((r) => r.status !== 'pending' && r.status !== 'awaiting_human');
    else if (status) out = out.filter((r) => r.status === status);
    if (botId) out = out.filter((r) => r.botId === botId);
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out.slice(0, limit);
  }

  /**
   * Shutdown path.
   *
   * Do not silently deny cards the human never saw: unblock the turns that are
   * being cancelled anyway, but leave the records pending (and on disk) so the
   * next boot can show them again. Crash recovery and a clean restart then
   * behave the same way.
   */
  shutdown(reason = 'server shutting down') {
    for (const record of [...this.records.values()]) {
      if (record.status !== 'pending' && record.status !== 'awaiting_human') continue;
      record.interruptedAt = nowIso();
      record.interruptedReason = String(reason);
      const waiter = this.waiters.get(record.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(record.id);
        waiter.resolve({ approval: record, decision: 'denied', note: reason });
      }
    }
    this.persist();
  }

  /**
   * A deleted bot's cards (1.5.32): closed, so "N 个操作等你确认" does not keep a
   * card nobody can open. -> the records closed.
   */
  cancelForBot(botId, reason = '已取消：助手已删除') {
    const closed = [];
    for (const record of [...this.records.values()]) {
      if (record.botId !== botId) continue;
      if (record.status === 'pending') {
        this.settle(record.id, 'denied', reason, 'system');
        closed.push({ ...this.records.get(record.id) });
      } else if (record.status === 'awaiting_human') {
        record.status = 'dismissed';
        record.decidedAt = nowIso();
        record.note = reason;
        record.by = 'system';
        this.records.set(record.id, record);
        void this.onAudit({ kind: 'approval.resolved', ...record });
        closed.push({ ...record });
      }
    }
    if (closed.length) this.persist();
    return closed;
  }

  /** The cards a running turn is stopped on right now. */
  pendingForTurn(turnId) {
    return [...this.records.values()].filter((r) => r.turnId === turnId && r.status === 'pending' && this.waiters.has(r.id));
  }

  /**
   * Cards of this bot that nothing waits on any more (their turn ended with a
   * restart): closed when the human moves on. -> the records closed.
   */
  cancelOrphans(botId, reason = NEW_MESSAGE_NOTE) {
    const closed = [];
    for (const record of [...this.records.values()]) {
      if (record.botId !== botId || record.status !== 'pending' || this.waiters.has(record.id)) continue;
      this.settle(record.id, 'denied', reason, 'system');
      closed.push({ ...this.records.get(record.id) });
    }
    return closed;
  }

  /** Resolve any waiter belonging to a cancelled turn. */
  cancelForTurn(turnId, reason = 'turn cancelled') {
    for (const record of this.records.values()) {
      if (record.turnId === turnId && record.status === 'pending') {
        this.settle(record.id, 'denied', reason, 'system');
      }
    }
  }
}

function normalizeDecision(value) {
  const v = String(value || '').toLowerCase();
  if (['approve', 'approved', 'allow', 'yes', 'approve_once'].includes(v)) return 'approved';
  if (['deny', 'denied', 'reject', 'no'].includes(v)) return 'denied';
  return null;
}

function truncateArgs(args) {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 4000 ? `${json.slice(0, 4000)}...` : json;
  } catch {
    return '{}';
  }
}
