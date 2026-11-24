// Which shell runs a bot's commands, for the model, and a bash command that cmd.exe cannot run (1.5.67).
// Its own small module: the shell tool (tools.mjs) and every bot's system prompt (agent.mjs) both use it.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Which shell runs a bot's commands here, in words for the model (1.5.67; 11-24, TikTok on Windows: 52 of 574 steps
 * failed - `ls -la … | head`, `tail`, `for f in …; do`, `2>&1 | head -60` in cmd.exe - and each was tried again in
 * cmd syntax). Shared by the shell tool's description and every bot's system prompt.
 */
export function shellGuide(platform = process.platform) {
  return platform === 'win32'
    ? 'Commands on this machine run in Windows cmd.exe, NOT bash: there is no head, tail, grep, sed, awk, wc, cat, ls, cp, mv, rm, touch or which, no `for x in …; do`, no `$(…)`, no /dev/null. Use cmd: dir, type, findstr, copy, move, del, where, `for %f in (*.mp4) do …`, `2>nul`; paths with backslashes, in double quotes when they have spaces. For anything longer than one line, write a .py (or .ps1) file in the workspace and run it (python x.py / powershell -NoProfile -File x.ps1); PowerShell one-liners go through `powershell -NoProfile -Command "…"`.'
    : 'Commands on this machine run in /bin/sh (bash syntax works: pipes, head, tail, grep, for loops).';
}

/** Unix tools a bash habit reaches for, and what cmd.exe has instead. */
const CMD_INSTEAD = {
  head: 'powershell -NoProfile -Command "Get-Content <file> -TotalCount 20"（或者写个 .py）', tail: 'powershell -NoProfile -Command "Get-Content <file> -Tail 20"',
  grep: 'findstr', sed: '写个 .py 处理', awk: '写个 .py 处理', wc: 'find /c /v ""', cat: 'type', ls: 'dir', cp: 'copy', mv: 'move', rm: 'del（文件夹用 rmdir /s /q）',
  touch: 'type nul > <file>', which: 'where', xargs: 'for %f in (…) do …', cut: '写个 .py 处理',
};
const pathHasCache = new Map();
/** Is a program on this machine's PATH (Git for Windows' coreutils, say)? Looked up once per name. */
function onPath(name) {
  if (pathHasCache.has(name)) return pathHasCache.get(name);
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const found = dirs.some((d) => exts.some((e) => fs.existsSync(path.join(d, `${name}${e.toLowerCase()}`)) || fs.existsSync(path.join(d, `${name}${e}`))));
  pathHasCache.set(name, found);
  return found;
}

/**
 * A command written for bash that cmd.exe cannot run (1.5.67): -> '' or why, with what to use instead - returned at
 * once, without spending a run. A command that hands itself to PowerShell, bash, sh or wsl is left alone; a Unix tool
 * that IS on PATH here (Git's coreutils) is fine.
 */
export function bashOnWindows(command, { has = onPath } = {}) {
  const c = String(command || '');
  if (/^\s*(@?\s*)?(powershell|pwsh|bash|sh|wsl|git-bash)(\.exe)?\b/i.test(c)) return '';
  const said = [];
  if (/\bfor\s+\w+\s+in\b[^\n]*;\s*do\b/.test(c)) said.push('`for x in …; do … done` 是 bash 的写法 → cmd 用 `for %f in (*.mp4) do …`');
  if (/\$\(/.test(c)) said.push('`$(…)` 是 bash 的写法 → 写成 .py 或 .ps1 脚本再运行');
  if (/\/dev\/null/.test(c)) said.push('`/dev/null` → cmd 用 `nul`（例如 `2>nul`）');
  const used = new Set();
  for (const m of c.matchAll(/(?:^|[|&;(]\s*)(head|tail|grep|sed|awk|wc|cat|ls|cp|mv|rm|touch|which|xargs|cut)(?=\s|$)/gi)) used.add(m[1].toLowerCase());
  for (const t of used) if (!has(t)) said.push(`\`${t}\` 在 cmd 里没有 → ${CMD_INSTEAD[t]}`);
  return said.length ? `这台机器用 Windows 的 cmd.exe 运行命令，不是 bash，这条没有运行：\n- ${said.join('\n- ')}\n改成 cmd 的写法再试；长一点的就写成 .py 脚本再运行。` : '';
}

