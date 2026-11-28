#!/bin/bash
# ==========================================================================
#  hub-settings-push.sh —— 把模型（以及语音、看图）设置交给这台服务器上的 Lamplit
#
#  用法（root）：hub-settings-push.sh <设置文件.json>
#
#  设置文件是一个数组：[{"path":"/api/settings","body":{…}}, {"path":"/api/voice","body":{…}}, …]，
#  由装它的那台电脑经 SSH 写到这里，只有 root 能读，用完就删。这里用本机密钥
#  （data/local-key）在 127.0.0.1 上逐条交给本机的 Lamplit：模型密钥不经过网络明文
#  传输，不出现在命令行里，也不用掉配对码（1.5.78）。
#
#  输出一行 DESK_HUB_SETTINGS=ok|none|error:<原因>
#    none  这台服务器上没装 Lamplit，不算出错。
# ==========================================================================
set -u
BODY="${1:-}"
UNIT=/etc/systemd/system/desk-hub.service

finish() { rm -f "$BODY"; echo "DESK_HUB_SETTINGS=$1"; exit 0; }

[ "$(id -u)" = 0 ] || finish "error:要用 root 运行"
[ -s "$BODY" ] || finish "error:没有收到设置"
[ -f "$UNIT" ] || finish none
APP_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
PORT="$(sed -n 's/^Environment=PORT=//p' "$UNIT" | head -1)"
NODE="$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$UNIT" | head -1)"
[ -n "$APP_DIR" ] && [ -n "$PORT" ] && [ -x "$NODE" ] || finish none
systemctl is-active --quiet desk-hub || finish "error:这台服务器上的 Lamplit 没在运行"

OUT=$("$NODE" -e '
const fs = require("fs");
const [body, port, keyFile] = process.argv.slice(1);
const ALLOWED = new Set(["/api/settings", "/api/voice", "/api/vision"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let items;
  try { items = JSON.parse(fs.readFileSync(body, "utf8")); } catch { console.log("error:设置文件读不出来"); return; }
  if (!Array.isArray(items) || !items.length || items.some((i) => !i || !ALLOWED.has(i.path) || !i.body || typeof i.body !== "object")) { console.log("error:设置文件的内容不对"); return; }
  for (const item of items) {
    let last = "";
    let done = false;
    for (let i = 0; i < 40 && !done; i += 1) {
      let key = "";
      try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch { /* made on the first local request */ }
      try {
        const res = await fetch(`http://127.0.0.1:${port}${item.path}`, { method: "PUT", headers: { "content-type": "application/json", ...(key ? { "x-lamplit-local": key } : {}) }, body: JSON.stringify(item.body), signal: AbortSignal.timeout(10000) });
        const j = await res.json().catch(() => ({}));
        if (res.ok) { done = true; break; }
        last = (j && j.error && (j.error.message || j.error.code)) || `HTTP ${res.status}`;
        // 4xx other than "not ready yet": waiting does not help.
        if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) break;
      } catch (err) { last = err.message; }
      await sleep(1500);
    }
    if (!done) { console.log(`error:${item.path} ${String(last).replace(/\s+/g, " ").slice(0, 140)}`); return; }
  }
  console.log("ok");
})();
' "$BODY" "$PORT" "$APP_DIR/data/local-key" 2>&1 | tail -1)
finish "${OUT:-error:没有结果}"
