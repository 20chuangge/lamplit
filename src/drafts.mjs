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
const SEND_WORDS = /(^|[._-])(send|post|reply|publish|comment|tweet|repost|quote|forward|email|message[._-](create|reply|send)|create[._-](message|post|comment|tweet))($|[._-])/i;
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

/** Is this connected-app step a send (not a look, not some other write)? */
export function isSendingTool(toolName) {
  const n = String(toolName || '');
  if (!n || NOT_SEND.test(n.replace(/^mcp__[^_]+__/, '').split(/[._-]/)[0])) return false;
  return SEND_WORDS.test(n);
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
