// Drafts (1.5.45 第四步「替你想」): anything that goes out - a post, a mail, a
// message, a reply - is shown to the human first as a card they can edit, and
// goes out only when they press 「发送」. It is the approval card with the text
// in boxes: the human answers with `edits`, and only the fields the card lists
// can be changed (never the attachments, the account, or anything else).
//
//   draftFor(name, args, {mcp})   -> {channel, kind, fields:[{key,label,value,multiline,max?}], replyTo?, to?} | null
//   applyEdits(args, draft, edits) -> {args, changed:[key]} | {error}
//
// A field key is a path into the arguments: "body", "data.content", and
// "data.content#text" for text inside a JSON string (Feishu's message body).

/** Steps of connected apps that send something to someone: by the words of the tool's name. */
// 1.5.54 (the verifier's M6 list): sharing, uploading, inviting, submitting, and creating or editing what
// others read (an issue, a post, a comment; not a document page, which is the user's own, as fs_write) go out too.
// 1.5.55 (the verifier's second 1.5.54 round): GitHub's pull requests and pushed files, and chat
// tools' writes (write_message, chat_update, edit_message, add_member) go out too. A Notion page or
// database item stays the user's own document, as before; so does a local file tool's write_file.
const SEND_WORDS = /(^|[._-])(send|post|reply|publish|comment|tweet|repost|quote|forward|email|notify|broadcast|dm|share|upload|invite|submit|push|messages?[._-](create|reply|send|update|edit)|create[._-](message|post|comment|tweet|issue|reply|review|gist|discussion|event|pull[._-]request|pr|release|or[._-]update[._-]file)|update[._-](post|issue|comment|message|pull[._-]request)|merge[._-](pull[._-]request|pr)|(write|edit)[._-]message|chat[._-](update|send|post[._-]?message)|add[._-](member|collaborator|participant|user)s?)($|[._-])/i;
const NOT_SEND = /(^|[._-])(get|list|search|read|fetch|query|find|lookup|describe|show|view|retrieve|count|draft_list)($|[._-])/i;
/** Keys that hold what is said (the body of a post or a message). */
const TEXT_KEY = /^(text|content|body|message|msg|comment|reply|caption|title|subject|desc|description|status|note|markdown|html_body|text_body)$/i;
const LABELS = { text: '正文', content: '正文', body: '正文', message: '正文', msg: '正文', comment: '评论', reply: '回复', caption: '配文', title: '标题', subject: '标题', desc: '描述', description: '描述', status: '正文', note: '正文', markdown: '正文', html_body: '正文', text_body: '正文', to: '收件人' };

/** A post's id from a link (x.com/…/status/123) or the id itself. */
export function postIdOf(ref) {
  const s = String(ref || '').trim();
  const m = /\/status(?:es)?\/(\d{1,25})/.exec(s) || /^(\d{1,25})$/.exec(s);
  return m ? m[1] : '';
}

/** A tool name as words: camelCase split (1.5.54, review M6: sendMessage, chat.postMessage, createIssueComment). */
const nameWords = (name) => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Is this connected-app step a send (not a look, not some other write)? */
export function isSendingTool(toolName) {
  const n = nameWords(toolName);
  if (!n || NOT_SEND.test(n.replace(/^mcp__[^_]+__/, '').split(/[._-]/)[0])) return false;
  return SEND_WORDS.test(n);
}

// What a command line sends to someone (1.5.54, review M6): a form or a body posted with
// curl, wget, PowerShell, .NET, Python, Node or gh, or mail. Copying files around (scp, rsync,
// git push) is not here. The verifier's second round found the short and abbreviated forms:
// curl -sd / -sSfd / --json, wget --method=POST, irm -Me Post, -Method:Post, WebClient.Upload*,
// urlopen(data=), httpx.post, fetch(..., {method:'POST'}), gh api -X POST, -EncodedCommand.
const COMMAND_SENDS = [
  // curl: a short-option cluster holding d (data), F (form) or T (upload) - case matters: -D is "dump headers".
  // The program's name in any case (1.5.55: CURL.EXE, cUrL), the option letters as they are.
  /\b[cC][uU][rR][lL](\.[eE][xX][eE])?\b[^|;&\n]*\s-[A-Za-z]*[dFT][A-Za-z]*(?=[\s'"=@]|$)/,
  /\b(curl|wget)(\.exe)?\b[^|;&\n]*(\s--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string|upload-file|post-data|post-file|body-data|body-file)\b|\s-X\s*['"]?(POST|PUT|PATCH)\b|--request[=\s]+['"]?(POST|PUT|PATCH)\b|--method[=\s]+['"]?(POST|PUT|PATCH)\b)/i,
  // PowerShell (any unique abbreviation, space or colon): -Method/-Me/-M Post, -Body/-B, -InFile/-In.
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b[^|;\n]*(\s-M[a-z]*[:\s]+['"]?(Post|Put|Patch)\b|\s-B[a-z]*([:\s]|$)|\s-In[a-z]*[:\s])/i,
  /\bNet\.WebClient\b|\.Upload(String|File|Data|Values)(Async|TaskAsync)?\s*\(|\.(PostAsync|PutAsync|PatchAsync|SendAsync|PostAsJsonAsync|PutAsJsonAsync)\s*\(/i,
  /(^|[\s;&|(])(mail|mailx|sendmail|mutt|msmtp|swaks)\s/i,
  /\b(smtplib|nodemailer)\b|\b(requests|httpx|aiohttp|session|axios)\.(post|put|patch)\s*\(|\.request\(\s*(method\s*=\s*)?['"](POST|PUT|PATCH)['"]|Send-MailMessage/i,
  // 1.5.55 (the verifier's second round): what else carries data out of the computer.
  // PowerShell's method as an expression or a variable (-Method ("Po"+"st"), -Method $m): not known, so it asks.
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;\n]*\s-M[a-z]*[:\s]+[($]/i,
  // Uploads with BITS, certutil's URL fetches (the address itself can carry the data).
  /\bStart-BitsTransfer\b[^|;\n]*\s-T[a-z]*[:\s]+['"]?Up/i, /\bbitsadmin(\.exe)?\b[^|;&\n]*\/upload\b/i, /\bcertutil(\.exe)?\b[^|;&\n]*\s[-/](urlcache|verifyctl|url)\b/i,
  // Raw sockets (Python, PowerShell, .NET), DNS lookups (data in the name), remote shells and copies, cloud copies, FTP, git push.
  /\bsocket\.(socket|create_connection)\s*\(|\.sendall\s*\(|Net\.Sockets\.(TcpClient|UdpClient|Socket)\b|\b(nc|ncat|netcat|socat|telnet)(\.exe)?\s/i,
  /\b(nslookup|dig|Resolve-DnsName)(\.exe)?\s/i,
  /(^|[\s;&|(])(ssh|scp|sftp|lftp|ftp|tftp|plink|pscp|psftp)(\.exe)?\s/i,
  /\brsync\b[^|;&\n]*(\s\S*[^\s:\\/]:|::|rsync:\/\/)/i,
  /\brclone(\.exe)?\s+(copy|copyto|sync|bisync|move|moveto|rcat|mkdir|purge)\b/i,
  /\baws(\.exe)?\s+s3\s+(cp|mv|sync)\b|\baws(\.exe)?\s+s3api\s+put-object\b|\b(gsutil|azcopy)(\.exe)?\s+(cp|mv|rsync|copy|sync)\b/i,
  /\bgit(\.exe)?\s+(-[cC]\s+\S+\s+)*push\b/i,
  // Options kept out of sight: curl -K/--config, wget -e/--execute/--config, a command's output or a
  // PowerShell splat as the options. What they say cannot be read here, so it asks.
  /\b[cC][uU][rR][lL](\.[eE][xX][eE])?\b[^|;&\n]*(\s-[A-Za-z]*K[A-Za-z]*(?=[\s'"=]|$)|\s--config\b)/,
  /\b[wW][gG][eE][tT](\.[eE][xX][eE])?\b[^|;&\n]*(\s-[A-Za-z]*e[A-Za-z]*(?=[\s'"=]|$)|\s--(execute|config)\b)/,
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)(\.exe)?\b[^|;&\n]*(\$\(|`|\s@[A-Za-z_]\w*)/i,
  /\burlopen\([^)]*\bdata\s*=|\bRequest\([^)]*\bdata\s*=|\bmethod\s*[:=]\s*['"](POST|PUT|PATCH)['"]/i,
  /\bgh(\.exe)?\s+api\b[^|;&\n]*(\s-X\s*['"]?(POST|PUT|PATCH)\b|\s--method[=\s]+['"]?(POST|PUT|PATCH)\b|\s-[fF]\s|\s--(field|raw-field|input)\b)|\bgh(\.exe)?\s+(issue|pr|release|gist|discussion)\s+(create|comment|edit|review|merge|close|reopen)\b/i,
];
const LOCAL_URL = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;
/** The request can be sent somewhere else than its URL says (a proxy, a forced address): no "local only" pass. */
const REDIRECTED = /\s--(connect-to|resolve|proxy|preproxy|socks4a?|socks5(-hostname)?|proxy1\.0)\b|\s-x(\s|\S)|\s-Proxy\b|\bHTTPS?_PROXY\s*=|\bALL_PROXY\s*=/i;
/** Only addresses on this machine are named (a local service), sent straight there: not "out". */
/** Options that are not on the line (a config file, a command's output, a splat): where it goes is not known. */
const HIDDEN = /\s-[A-Za-z]*K[A-Za-z]*(?=[\s'"=]|$)|\s--(config|execute)\b|\$\(|`|\s@[A-Za-z_]\w*/;
const onlyLocal = (text) => {
  const t = String(text || '');
  if (REDIRECTED.test(t) || HIDDEN.test(t)) return false;
  const urls = t.match(/https?:\/\/[^\s'"]+/gi) || [];
  return urls.length > 0 && urls.every((u) => LOCAL_URL.test(u));
};
/** PowerShell's -EncodedCommand (any abbreviation): the script in it, decoded, or null. */
function encodedScript(command) {
  const m = /\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedc[a-z]*)\s+['"]?([A-Za-z0-9+/=]{8,})/i.exec(String(command || ''));
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64').toString('utf16le'); } catch { return ''; }
}

/**
 * May a remembered 「以后都允许」 let this step run without asking (1.5.54, the verifier's M6)?
 * Not for a program that can reach the network used with an address: what it does with the
 * address is in its options, and one yes for "curl" or "python" is not a yes to post anything.
 */
export function rememberMayCover(name, args = {}) {
  if (name !== 'shell') return true;
  const raw = String(args?.command || '');
  const command = unescapedCommand(raw);
  // 1.5.55: the programs that reach another computer by name (ssh, scp, git, …) too, and options
  // out of sight (-K, --config, $(…), backticks, a splat) count like an address.
  const net = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|powershell|pwsh|python3?|py|node|deno|bun|gh|ruby|perl|php|ssh|scp|sftp|ftp|tftp|nslookup|dig|Resolve-DnsName|git|rclone|aws|gsutil|azcopy|bitsadmin|certutil|Start-BitsTransfer|nc|ncat|socat|telnet)(\.exe)?\b/i.test(command);
  // Programs that reach another computer by its name alone (no https:// to see): never covered.
  if (/(^|[\s;&|(])(ssh|scp|sftp|lftp|ftp|tftp|plink|pscp|nslookup|dig|Resolve-DnsName|nc|ncat|netcat|socat|telnet)(\.exe)?\s/i.test(command)) return false;
  return !(net && (/https?:\/\//i.test(command) || encodedScript(command) !== null || HIDDEN.test(raw) || /\s@\S/.test(raw)));
}

/**
 * The command as the shell will read it (1.5.55, the verifier's second round): cmd's ^ escapes
 * (c^url), empty quotes inside a word (c""url, c''url) and PowerShell's backtick escapes (c`url)
 * taken out, so a program's name is seen however it is spelled.
 */
export function unescapedCommand(command) {
  return String(command || '').replace(/\^(?=[^\s])/g, '').replace(/(\S)(""|'')(?=\S)/g, '$1').replace(/`(?=[A-Za-z])/g, '');
}

/**
 * A step that sends something out with no draft card to show it in (1.5.54, review M6): a
 * connected app's send whose text could not be found, a command that posts or mails, a
 * website form. -> why it asks every time, or ''. What this cannot see: a bot clicking
 * 「发布」 in its own browser, or a program it wrote doing the sending (asked as commands).
 */
export function outgoingAsk(name, args = {}, { mcp = null } = {}) {
  if (mcp && (isSendingTool(mcp.tool) || isSendingTool(name))) return `用「${String(mcp.server || '连接的应用')}」往外发东西：没有能改的正文，每次都先问你`;
  if (name === 'shell') {
    const raw = String(args?.command || '');
    const command = unescapedCommand(raw);
    if (COMMAND_SENDS.some((re) => re.test(command) || re.test(raw)) && !(onlyLocal(raw) && onlyLocal(command))) return '这条命令会往外发数据（提交内容、上传、连到别的电脑或发邮件），每次都先问你';
    // A PowerShell script handed over encoded: what it says decides; one that cannot be read asks.
    const inner = encodedScript(command);
    if (inner !== null && (!inner.trim() || outgoingAsk('shell', { command: inner }))) return '这条命令带着一段编码过的脚本，可能往外发数据，每次都先问你';
  }
  if (name === 'http_fetch' && String(args?.method || 'GET').toUpperCase() !== 'GET' && !onlyLocal(args?.url)) return '向网站提交数据，每次都先问你';
  return '';
}

function getPath(obj, key) {
  const [p, inner] = String(key).split('#');
  let v = obj;
  for (const part of p.split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[part]; }
  if (inner) {
    try { const j = JSON.parse(v); return j && typeof j === 'object' ? j[inner] : undefined; } catch { return undefined; }
  }
  return v;
}

function setPath(obj, key, value) {
  const [p, inner] = String(key).split('#');
  const parts = p.split('.');
  let o = obj;
  for (const part of parts.slice(0, -1)) { if (!o[part] || typeof o[part] !== 'object') o[part] = {}; o = o[part]; }
  const last = parts[parts.length - 1];
  if (inner) {
    let j = {};
    try { j = JSON.parse(o[last]); } catch { /* replaced below */ }
    if (!j || typeof j !== 'object') j = {};
    j[inner] = value;
    o[last] = JSON.stringify(j);
  } else o[last] = value;
}

/** The text fields of a connected app's send, nested ones too (data.content), at most four. */
function textFields(args) {
  const out = [];
  const walk = (obj, prefix, depth) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && TEXT_KEY.test(k)) {
        // A JSON string with a text inside (Feishu: content = '{"text":"…"}'): that text.
        if (/^\s*\{/.test(v)) {
          try {
            const j = JSON.parse(v);
            if (j && typeof j.text === 'string') { out.push({ key: `${key}#text`, label: '正文', value: j.text, multiline: true }); continue; }
          } catch { /* plain text that starts with { */ }
        }
        out.push({ key, label: LABELS[k.toLowerCase()] || k, value: v, multiline: v.length > 40 || /body|content|text|message|markdown/i.test(k) });
      } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key, depth + 1);
    }
  };
  walk(args, '', 0);
  return out.slice(0, 4);
}

const listText = (v) => (Array.isArray(v) ? v.map(String).join(', ') : String(v || ''));

/**
 * The one outgoing gate (1.5.45, the human: 「要可复用的呀」). A tool that sends
 * something outside says so itself - `outgoing` on the tool (a connected app:
 * its `lamplitOutgoing` annotation) - and every such step is the same draft
 * card. Nothing here knows any channel by name: a new channel only has to be
 * marked. The spec (functions allowed for tools inside the hub; plain data for
 * connected apps):
 *   channel   '微信' | (args) => string          where it goes (shown on the card)
 *   when      (args) => boolean                   only some calls go out (a POST, not a GET)
 *   kind      'post' | (args) => string           post / reply / mail / message / webhook
 *   replyKey  'replyTo'                           the argument naming what it answers (a link or id)
 *   replyUrl  (id) => url                         where that is, for the card's link
 *   contextKey 'context'                          one line on what is answered
 *   filesKey  'attachments'                       files that go with it (shown, not editable)
 *   fields    [{key, label, multiline?, max?, list?, optional?}]   what the human may edit
 * Connected apps that say nothing: a tool whose name says it sends (send, post,
 * reply, publish, comment …) is a draft with its text fields.
 */
export function draftFor(name, args = {}, { mcp = null, outgoing = null } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const spec = outgoing || mcp?.outgoing || null;
  if (spec && Array.isArray(spec.fields)) {
    if (typeof spec.when === 'function' && !spec.when(a)) return null;
    const pick = (v) => (typeof v === 'function' ? v(a) : v);
    const fields = spec.fields
      .filter((f) => !f.optional || (getPath(a, f.key) !== undefined && String(getPath(a, f.key)) !== ''))
      .map((f) => ({ key: f.key, label: f.label || f.key, multiline: Boolean(f.multiline), ...(f.max ? { max: f.max } : {}), ...(f.list ? { list: true } : {}), value: f.list ? listText(getPath(a, f.key)) : String(getPath(a, f.key) ?? '') }));
    if (!fields.length) return null;
    const replyTo = spec.replyKey ? postIdOf(a[spec.replyKey]) || (a[spec.replyKey] ? String(a[spec.replyKey]).slice(0, 200) : '') : '';
    const files = spec.filesKey && Array.isArray(a[spec.filesKey]) && a[spec.filesKey].length ? a[spec.filesKey].map(String).slice(0, 9) : null;
    const kind = pick(spec.kind) || (replyTo ? 'reply' : 'post');
    return {
      channel: String(pick(spec.channel) || mcp?.server || '外部').slice(0, 40),
      kind,
      ...(replyTo ? { replyTo, ...(typeof spec.replyUrl === 'function' ? { replyUrl: spec.replyUrl(replyTo) } : {}) } : {}),
      ...(spec.contextKey && a[spec.contextKey] ? { context: String(a[spec.contextKey]).slice(0, 300) } : {}),
      ...(files ? { files } : {}),
      fields,
    };
  }
  if (!mcp) return null;
  const tool = String(mcp.tool || '');
  if (!isSendingTool(tool) && !isSendingTool(name)) return null;
  const fields = textFields(a);
  if (!fields.length) return null;
  return { channel: String(mcp.server || '连接的应用').slice(0, 30), kind: /reply|comment/i.test(tool) ? 'reply' : 'message', fields };
}

/**
 * The arguments with the human's edits, only on the draft's own fields.
 * A recipient list stays a list. A field over its limit is refused (nothing goes out).
 */
export function applyEdits(args, draft, edits) {
  const out = JSON.parse(JSON.stringify(args && typeof args === 'object' ? args : {}));
  const changed = [];
  if (!draft || !Array.isArray(draft.fields) || !edits || typeof edits !== 'object') return { args: out, changed };
  for (const f of draft.fields) {
    if (!Object.prototype.hasOwnProperty.call(edits, f.key)) continue;
    const next = String(edits[f.key] ?? '');
    if (next === String(f.value ?? '')) continue;
    if (f.max && [...next].length > f.max) return { error: `「${f.label}」最多 ${f.max} 个字，现在是 ${[...next].length} 个。改短一点再发。` };
    if (f.list) {
      const list = next.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
      if (!list.length) return { error: `「${f.label}」不能是空的。` };
      setPath(out, f.key, list);
    } else setPath(out, f.key, next);
    changed.push(f.key);
  }
  return { args: out, changed };
}

/** Only edits to the draft's own fields, as short strings: what a card record keeps. */
export function cleanEdits(draft, edits) {
  if (!draft || !Array.isArray(draft.fields) || !edits || typeof edits !== 'object') return null;
  const keys = new Set(draft.fields.map((f) => f.key));
  const out = {};
  for (const [k, v] of Object.entries(edits)) if (keys.has(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 20000);
  return Object.keys(out).length ? out : null;
}

/** The value of a field in the arguments (for a check after the edits). */
export const fieldValue = getPath;
