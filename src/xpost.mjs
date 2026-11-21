// X (Twitter) posting with the human's own developer app (1.5.45 第四步「替你想」).
//
// The human registers an app at developer.x.com, turns on 「用户登录（OAuth 2.0）」,
// pastes this hub's callback into it and its Client ID (and Client Secret, for a
// "Web App" / confidential client) into Settings → 连接应用 → X. Signing in happens
// on X's own page: Lamplit never sees the X password. What comes back - the
// access and refresh tokens - and the app's secret are kept in data/x-account.json,
// a sealed file (store.mjs SEALED_FILES: encrypted with the desktop app's master
// key, like the other keys). They are never in the vault the bots can list and
// fill into pages, never in a reply, a URL, a log, or sent to another machine.
//
// OAuth 2.0 Authorization Code with PKCE (S256), scopes to post, to read the
// account's name and to stay signed in (offline.access -> a refresh token).
// Posting is POST /2/tweets; a reply names the post it answers.
//
//   createXAccount({file, fetchImpl, now}) -> {view, setApp, beginLogin, finishLogin, post, disconnect, setBots, allows}

import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from './store.mjs';
import { pkcePair } from './mcpauth.mjs';
import { postIdOf } from './drafts.mjs';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_API = 'https://api.x.com';
export const X_TOKEN_URL = `${X_API}/2/oauth2/token`;
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
/** Where the human makes the app (shown on the settings card). */
export const X_DEVELOPER_URL = 'https://developer.x.com/en/portal/projects-and-apps';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 20000;

const xError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/** A message from X with nothing secret in it (X never echoes a token, but be sure). */
function scrub(text, secrets = []) {
  let t = String(text || '').slice(0, 300);
  for (const s of secrets) if (s && s.length > 6) t = t.split(s).join('•••');
  return t;
}

export function createXAccount({ file, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let data = null; // {clientId, clientSecret, accessToken, refreshToken, expiresAt, userId, username, bots:[], connectedAt}
  const pending = new Map(); // state -> {verifier, redirectUri, at}

  async function load() {
    if (data) return data;
    const raw = await readJson(file, {}).catch(() => ({}));
    data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (!Array.isArray(data.bots)) data.bots = [];
    return data;
  }
  const save = () => writeJsonAtomic(file, data);
  const secrets = () => [data?.clientSecret, data?.accessToken, data?.refreshToken];

  async function call(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw xError('X_UNREACHABLE', `连不上 X（${scrub(err.message, secrets())}）。检查网络后再试。`, 502);
    }
    let body = {};
    try { body = await res.json(); } catch { /* none */ }
    return { res, body };
  }

  /** The app's credentials on a token request: Basic auth with the secret, else the id in the body. */
  function clientAuth(params) {
    if (data.clientSecret) {
      return { headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(data.clientId)}:${encodeURIComponent(data.clientSecret)}`).toString('base64')}` }, params };
    }
    return { headers: {}, params: { ...params, client_id: data.clientId } };
  }

  async function tokenRequest(params) {
    const auth = clientAuth(params);
    const { res, body } = await call(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...auth.headers },
      body: new URLSearchParams(auth.params).toString(),
    });
    if (!res.ok || !body.access_token) {
      const why = scrub(body.error_description || body.error || `HTTP ${res.status}`, secrets());
      throw xError('X_TOKEN_FAILED', `X 没有给授权（${why}）。到「设置 → 连接应用 → X」重新连一下。`, 502);
    }
    data.accessToken = String(body.access_token);
    if (body.refresh_token) data.refreshToken = String(body.refresh_token);
    data.expiresAt = body.expires_in ? now() + Number(body.expires_in) * 1000 : 0;
  }

  async function freshToken() {
    await load();
    if (!data.accessToken) throw xError('X_NOT_CONNECTED', '还没有连上 X：到「设置 → 连接应用 → X」点「去 X 登录授权」。', 409);
    if (data.expiresAt && data.expiresAt < now() + 60000) {
      if (!data.refreshToken) throw xError('X_EXPIRED', 'X 的授权过期了：到「设置 → 连接应用 → X」重新连一下。', 409);
      try {
        await tokenRequest({ grant_type: 'refresh_token', refresh_token: data.refreshToken });
      } catch (err) {
        throw xError('X_EXPIRED', `X 的授权过期了，续不上：到「设置 → 连接应用 → X」重新连一下。（${err.message}）`, 409);
      }
      await save();
    }
    return data.accessToken;
  }

  return {
    load,

    /** What the page may see: no key, no token, only whether and as whom. */
    view() {
      const d = data || {};
      return {
        configured: Boolean(d.clientId),
        // The id's first and last characters, to tell which app it is.
        ...(d.clientId ? { clientIdHint: `${String(d.clientId).slice(0, 4)}…${String(d.clientId).slice(-3)}` } : {}),
        hasClientSecret: Boolean(d.clientSecret),
        connected: Boolean(d.accessToken),
        username: d.username || '',
        bots: [...(d.bots || [])],
        ...(d.connectedAt ? { connectedAt: d.connectedAt } : {}),
      };
    },

    /** The human's developer app: Client ID, and the Client Secret for a confidential client. */
    async setApp({ clientId, clientSecret } = {}) {
      await load();
      // Left empty while one is saved: keep it (only the secret is being changed).
      const id = String(clientId || '').trim() || (clientId === undefined || clientId === '' ? String(data.clientId || '') : '');
      if (!/^[\w.~-]{6,200}$/.test(id)) throw xError('X_BAD_CLIENT_ID', 'Client ID 不对：在 X 开发者后台，应用的「Keys and tokens」→「OAuth 2.0 Client ID and Client Secret」里复制。');
      const secret = String(clientSecret ?? '').trim();
      if (secret && !/^[\w.~-]{6,300}$/.test(secret)) throw xError('X_BAD_CLIENT_SECRET', 'Client Secret 不对：从同一个地方复制，不要带空格。');
      // Another app: whatever was signed in with the old one goes.
      if (data.clientId && data.clientId !== id) { delete data.accessToken; delete data.refreshToken; delete data.expiresAt; delete data.username; delete data.userId; }
      data.clientId = id;
      if (clientSecret !== undefined) { if (secret) data.clientSecret = secret; else delete data.clientSecret; }
      await save();
      return this.view();
    },

    /** The link to X's own sign-in page, for this hub's callback. Ten minutes, used once. */
    async beginLogin({ redirectUri }) {
      await load();
      if (!data.clientId) throw xError('X_NOT_CONFIGURED', '先填 X 开发者应用的 Client ID。');
      for (const [s, p] of pending) if (now() - p.at > LOGIN_TTL_MS) pending.delete(s);
      const { verifier, challenge } = pkcePair();
      const state = crypto.randomBytes(24).toString('base64url');
      pending.set(state, { verifier, redirectUri, at: now() });
      const url = new URL(X_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', data.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', X_SCOPES.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { url: url.href };
    },

    /** Did this account start this sign-in (1.5.52: a callback another machine got is handed to the right one)? */
    hasPending(state) {
      const p = pending.get(String(state || ''));
      return Boolean(p) && now() - p.at <= LOGIN_TTL_MS;
    },

    /** X sent the browser back: swap the code for tokens, read the account's name. */
    async finishLogin({ state, code, error } = {}) {
      await load();
      const p = pending.get(String(state || ''));
      pending.delete(String(state || ''));
      if (!p || now() - p.at > LOGIN_TTL_MS) throw xError('X_STATE', '这次登录已经用过或过期了，没有完成。回到 Lamplit 重新点「去 X 登录授权」。');
      if (error) throw xError('X_DENIED', `X 上没有同意授权（${scrub(error)}），没有连上。`);
      if (!code) throw xError('X_STATE', '没有拿到 X 的授权码，没有完成。回到 Lamplit 重新点「去 X 登录授权」。');
      await tokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: p.redirectUri, code_verifier: p.verifier });
      const { res, body } = await call(`${X_API}/2/users/me`, { headers: { authorization: `Bearer ${data.accessToken}` } });
      if (res.ok && body?.data?.username) { data.username = String(body.data.username).slice(0, 60); data.userId = String(body.data.id || ''); }
      data.connectedAt = new Date(now()).toISOString();
      await save();
      return { username: data.username || '' };
    },

    /** Post (or reply) as the human. -> {id, url}. Only after the human pressed 「发送」 on the draft. */
    async post({ text, replyTo } = {}) {
      const body = { text: String(text || '') };
      if (!body.text.trim()) throw xError('X_EMPTY', '帖子是空的，没有发。');
      const reply = postIdOf(replyTo);
      if (replyTo && !reply) throw xError('X_BAD_REPLY', `看不懂要回复哪条帖子（${String(replyTo).slice(0, 80)}）：给帖子的链接或编号。`);
      if (reply) body.reply = { in_reply_to_tweet_id: reply };
      const token = await freshToken();
      const { res, body: out } = await call(`${X_API}/2/tweets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !out?.data?.id) {
        const why = scrub(out?.detail || out?.title || out?.errors?.[0]?.message || `HTTP ${res.status}`, secrets());
        const hint = res.status === 403 ? '（X 拒绝了：多半是开发者应用没有「读和写」权限，或者账户的接口额度用完了）' : res.status === 401 ? '（授权失效了：到「设置 → 连接应用 → X」重新连一下）' : res.status === 429 ? '（发得太快或额度用完了，过一会儿再试）' : '';
        throw xError('X_POST_FAILED', `X 没有发出去：${why}${hint}`, 502);
      }
      const id = String(out.data.id);
      return { id, url: data.username ? `https://x.com/${data.username}/status/${id}` : `https://x.com/i/status/${id}` };
    },

    /** Sign out here (the app's id stays, so connecting again is one click). */
    async disconnect({ forgetApp = false } = {}) {
      await load();
      delete data.accessToken; delete data.refreshToken; delete data.expiresAt; delete data.username; delete data.userId; delete data.connectedAt;
      if (forgetApp) { delete data.clientId; delete data.clientSecret; data.bots = []; }
      await save();
      return this.view();
    },

    /** Which bots may post (the human's pick on the card). */
    async setBots(ids = []) {
      await load();
      data.bots = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((s) => /^[\w.-]{1,80}$/.test(s)))].slice(0, 20);
      await save();
      return this.view();
    },

    allows(botId) {
      return Boolean(data?.accessToken) && (data.bots || []).includes(String(botId || ''));
    },
  };
}
