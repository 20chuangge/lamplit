#!/usr/bin/env node
/**
 * release-notes.mjs - the GitHub release text for this version (1.5.8).
 *
 *   node scripts/release-notes.mjs <out.md>
 *
 * The "这一版改了什么" block of RELEASE.md, then how to install each file and
 * its SHA-256 (the Windows installer is not code-signed yet: Windows warns,
 * and the hash is how to know the file is the one published here).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/release-notes.mjs <out.md>'); process.exit(1); }
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const release = fs.readFileSync(path.join(REPO, 'RELEASE.md'), 'utf8');
const start = release.indexOf('## 这一版改了什么');
const end = release.indexOf('\n---', start);
const body = release.slice(start, end).replace('## 这一版改了什么', `## Lamplit ${version}`).trim();

const files = [`Lamplit-Setup-${version}.exe`, `Lamplit-Portable-${version}.exe`, `Lamplit-Android-${version}.apk`];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'desktop', 'dist', f))).digest('hex');
const rows = files.filter((f) => fs.existsSync(path.join(REPO, 'desktop', 'dist', f))).map((f) => `| ${f} | \`${hash(f)}\` |`);

const text = `${body}

## 安装

- **Windows**：安装包还没有代码签名，Windows 会提示「Windows 已保护你的电脑」或「未知发布者」。点「更多信息」→「仍要运行」。可以先用下面的 SHA-256 核对文件（PowerShell：\`Get-FileHash 文件名\`）。
- **Android**：用 Lamplit 自己的发版密钥签名。手机上要允许「安装未知应用」。从 1.5.7 及更早的版本（调试签名）升级时，要先卸载旧版再装，然后重新扫码配对一次；以后就能直接覆盖升级。

| 文件 | SHA-256 |
|---|---|
${rows.join('\n')}
`;
fs.writeFileSync(out, text);
console.log(`[release-notes] ${version}: ${rows.length} files`);
