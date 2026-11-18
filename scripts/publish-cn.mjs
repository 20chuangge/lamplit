#!/usr/bin/env node
/**
 * publish-cn.mjs - put a release where people in China can download it fast
 * (1.5.31). GitHub stays the main release; this adds:
 *
 *   Windows installers -> Tencent Cloud COS (its default domain: no domain of
 *     our own or ICP filing needed; .exe downloads are allowed there)
 *     download/Lamplit-Setup-<v>.exe, download/Lamplit-Portable-<v>.exe
 *     download/latest/Lamplit-Setup.exe, download/latest/Lamplit-Portable.exe
 *     download/latest.json  {version, files:{name: {url, sha256, bytes}}, at}
 *   Android APK -> a Gitee release (COS's default domain refuses .apk)
 *
 * Credentials live outside the repository, in the release folder next to the
 * signing key, and are never printed:
 *   %USERPROFILE%\.lamplit-release\cos.json   {secretId, secretKey, bucket, region}
 *   %USERPROFILE%\.lamplit-release\gitee.json {token, owner, repo}
 *
 *   node scripts/publish-cn.mjs check            config + a test upload, download, delete
 *   node scripts/publish-cn.mjs cos <version>     upload the Windows installers
 *   node scripts/publish-cn.mjs gitee <version> [notes.md]   the APK on a Gitee release
 *
 * No SDK: COS's request signature (v5, HMAC-SHA1) is done here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'desktop', 'dist');
const SECRETS = process.env.LAMPLIT_RELEASE_DIR || path.join(os.homedir(), '.lamplit-release');

function readConfig(name, fields) {
  const file = path.join(SECRETS, name);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (err) {
    throw new Error(`${file}: ${err.code === 'ENOENT' ? 'not there' : `not valid JSON (${err.message})`}`);
  }
  const missing = fields.filter((f) => typeof raw[f] !== 'string' || !raw[f].trim() || /^填|^这里/.test(raw[f]));
  if (missing.length) throw new Error(`${file}: missing ${missing.join(', ')}`);
  return Object.fromEntries(fields.map((f) => [f, raw[f].trim()]));
}

// ------------------------------------------------------------------ COS
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha1', key).update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for one COS request (signs the host header only). */
export function cosAuthorization({ secretId, secretKey, method, key, host, now = Math.floor(Date.now() / 1000), ttl = 600 }) {
  const keyTime = `${now - 60};${now + ttl}`;
  const signKey = hmac(secretKey, keyTime);
  const httpString = `${method.toLowerCase()}\n/${key}\n\nhost=${enc(host)}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmac(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}

function cosClient(cfg) {
  const host = `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
  const url = (key) => `https://${host}/${key.split('/').map(enc).join('/')}`;
  const call = async (method, key, body, headers = {}) => {
    const res = await fetch(url(key), {
      method,
      headers: { authorization: cosAuthorization({ ...cfg, method, key, host }), ...headers },
      body,
      signal: AbortSignal.timeout(method === 'PUT' ? 30 * 60 * 1000 : 30000),
    });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || '';
      throw new Error(`COS ${method} ${key}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }
    return res;
  };
  return {
    host,
    url,
    put: (key, bytes, type = 'application/octet-stream') => call('PUT', key, bytes, { 'content-type': type, 'content-length': String(bytes.length) }),
    del: (key) => call('DELETE', key),
  };
}

async function cosCheck() {
  const cfg = readConfig('cos.json', ['secretId', 'secretKey', 'bucket', 'region']);
  console.log(`cos.json: ok (bucket ${cfg.bucket}, region ${cfg.region}; keys not shown)`);
  const cos = cosClient(cfg);
  const key = `check/lamplit-${Date.now()}.txt`;
  const text = `Lamplit upload check ${new Date().toISOString()}\n`;
  await cos.put(key, Buffer.from(text), 'text/plain; charset=utf-8');
  console.log('upload: ok');
  const got = await fetch(cos.url(key), { signal: AbortSignal.timeout(20000) });
  const back = got.ok ? await got.text() : '';
  console.log(got.ok && back === text ? 'public download: ok (anyone can download, as intended)' : `public download: HTTP ${got.status} - is the bucket 公有读私有写?`);
  await cos.del(key);
  const gone = await fetch(cos.url(key), { signal: AbortSignal.timeout(20000) });
  console.log(gone.status === 404 || gone.status === 403 ? 'delete: ok' : `delete: still there (HTTP ${gone.status})`);
}

async function cosUpload(version) {
  const cfg = readConfig('cos.json', ['secretId', 'secretKey', 'bucket', 'region']);
  const cos = cosClient(cfg);
  const files = {};
  for (const [kind, name] of [['Setup', `Lamplit-Setup-${version}.exe`], ['Portable', `Lamplit-Portable-${version}.exe`]]) {
    const file = path.join(DIST, name);
    const bytes = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const key of [`download/${name}`, `download/latest/Lamplit-${kind}.exe`]) {
      for (let attempt = 1; ; attempt += 1) {
        try { await cos.put(key, bytes); break; } catch (err) {
          if (attempt >= 3) throw err;
          console.log(`  retry ${key} (${err.message})`);
        }
      }
      console.log(`uploaded ${key} (${Math.round(bytes.length / 1048576)} MB)`);
    }
    files[name] = { url: cos.url(`download/${name}`), latest: cos.url(`download/latest/Lamplit-${kind}.exe`), sha256, bytes: bytes.length };
  }
  // The version before stays one release, then goes (storage costs little, but no clutter).
  let before = null;
  try { before = await (await fetch(cos.url('download/latest.json'), { signal: AbortSignal.timeout(15000) })).json(); } catch { /* first time */ }
  const keep = new Set([version, before?.version].filter(Boolean));
  for (const old of (before?.previous || [])) {
    if (keep.has(old)) continue;
    for (const kind of ['Setup', 'Portable']) await cos.del(`download/Lamplit-${kind}-${old}.exe`).catch(() => {});
    console.log(`removed ${old}`);
  }
  const latest = { version, files, previous: [before?.version].filter((v) => v && v !== version), at: new Date().toISOString() };
  await cos.put('download/latest.json', Buffer.from(JSON.stringify(latest, null, 2)), 'application/json; charset=utf-8');
  console.log(`latest.json -> ${version}`);
  console.log(`download: ${cos.url('download/latest/Lamplit-Setup.exe')}`);
}

// ------------------------------------------------------------------ Gitee
async function giteeCall(cfg, method, p, body) {
  const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${p}`;
  const res = await fetch(url, { method, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gitee ${method} ${p}: HTTP ${res.status} ${text.replace(/access_token=[^&"]+/g, 'access_token=***').slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function giteeCheck() {
  const cfg = readConfig('gitee.json', ['token', 'owner', 'repo']);
  console.log(`gitee.json: ok (${cfg.owner}/${cfg.repo}; token not shown)`);
  const repo = await giteeCall(cfg, 'GET', `?access_token=${encodeURIComponent(cfg.token)}`);
  console.log(`repository: ${repo.full_name} (${repo.public ? 'public' : 'PRIVATE - attachments will not download for others'}, default branch ${repo.default_branch})`);
}

async function giteeUpload(version, notes = '') {
  const cfg = readConfig('gitee.json', ['token', 'owner', 'repo']);
  const repo = await giteeCall(cfg, 'GET', `?access_token=${encodeURIComponent(cfg.token)}`);
  const tag = `v${version}`;
  let release = null;
  try { release = await giteeCall(cfg, 'GET', `/releases/tags/${encodeURIComponent(tag)}?access_token=${encodeURIComponent(cfg.token)}`); } catch { /* not yet */ }
  if (!release?.id) {
    const form = new URLSearchParams({ access_token: cfg.token, tag_name: tag, name: `Lamplit ${version}`, body: notes || `Lamplit ${version}`, target_commitish: repo.default_branch || 'master', prerelease: 'false' });
    release = await giteeCall(cfg, 'POST', '/releases', form);
  }
  const name = `Lamplit-Android-${version}.apk`;
  const form = new FormData();
  form.append('access_token', cfg.token);
  form.append('file', new Blob([fs.readFileSync(path.join(DIST, name))]), name);
  const att = await giteeCall(cfg, 'POST', `/releases/${release.id}/attach_files`, form);
  console.log(`gitee: ${tag} with ${name} -> ${att?.browser_download_url || 'uploaded'}`);
  // Gitee keeps 1 GB of attachments per repository: older releases' APKs go, the last three stay.
  const all = await giteeCall(cfg, 'GET', `/releases?access_token=${encodeURIComponent(cfg.token)}&per_page=100`);
  const older = (all || []).filter((r) => r.id !== release.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(2);
  for (const r of older) {
    await giteeCall(cfg, 'DELETE', `/releases/${r.id}?access_token=${encodeURIComponent(cfg.token)}`).catch(() => {});
    console.log(`gitee: removed old release ${r.tag_name}`);
  }
}

// ------------------------------------------------------------------ main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, version, notesFile] = process.argv.slice(2);
  const run = {
    check: async () => {
      await cosCheck().catch((err) => console.log(`COS: ${err.message}`));
      await giteeCheck().catch((err) => console.log(`Gitee: ${err.message}`));
    },
    cos: () => cosUpload(version),
    gitee: () => giteeUpload(version, notesFile ? fs.readFileSync(notesFile, 'utf8') : ''),
  }[cmd];
  if (!run || (cmd !== 'check' && !/^\d+\.\d+\.\d+$/.test(version || ''))) {
    console.log('usage: node scripts/publish-cn.mjs check | cos <version> | gitee <version>');
    process.exit(2);
  }
  run().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
}
