#!/usr/bin/env node
/**
 * publish-cn.mjs - put a release where people in China can download it fast
 * (1.5.31). GitHub stays the main release; this adds the Android APK on a
 * Gitee release.
 *
 * Windows installers stay on GitHub only: Gitee caps an attachment at 100 MB
 * and the installers are larger. (1.5.31-1.5.45 also put them on Tencent Cloud
 * COS; dropped in 1.5.46 - the user stopped paying for it.)
 *
 * Credentials live outside the repository, in the release folder next to the
 * signing key, and are never printed:
 *   %USERPROFILE%.lamplit-releasegitee.json {token, owner, repo}
 *
 *   node scripts/publish-cn.mjs check            config + the repository
 *   node scripts/publish-cn.mjs gitee <version> [notes.md]   the APK on a Gitee release
 */
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
      await giteeCheck().catch((err) => console.log(`Gitee: ${err.message}`));
    },
    gitee: () => giteeUpload(version, notesFile ? fs.readFileSync(notesFile, 'utf8') : ''),
  }[cmd];
  if (!run || (cmd !== 'check' && !/^\d+\.\d+\.\d+$/.test(version || ''))) {
    console.log('usage: node scripts/publish-cn.mjs check | gitee <version> [notes.md]');
    process.exit(2);
  }
  run().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
}
