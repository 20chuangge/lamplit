#!/bin/bash
# ==========================================================================
#  relay-hub-join.sh —— 让这台服务器上的 Lamplit（desk-hub 服务）也连上中转
#
#  用法（root）：relay-hub-join.sh <设置文件.json>
#
#  设置文件是 PUT /api/relay-link 的内容（中转地址、端口、证书指纹、加入密码、
#  enabled），由装它的那台电脑经 SSH 写到这里，只有 root 能读，用完就删。
#  这里用本机密钥（data/local-key）在 127.0.0.1 上交给本机的 Lamplit：加入密码
#  不经过网络，也不出现在命令行里。
#
#  输出一行 DESK_HUB_RELAY=ok|none|error:<原因>
#    none  这台服务器上没装 Lamplit（只当中转用），不算出错。
# ==========================================================================
set -u
BODY="${1:-}"
UNIT=/etc/systemd/system/desk-hub.service

finish() { rm -f "$BODY"; echo "DESK_HUB_RELAY=$1"; exit 0; }

[ "$(id -u)" = 0 ] || finish "error:要用 root 运行"
[ -s "$BODY" ] || finish "error:没有收到中转设置"
[ -f "$UNIT" ] || finish none
APP_DIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
PORT="$(sed -n 's/^Environment=PORT=//p' "$UNIT" | head -1)"
NODE="$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$UNIT" | head -1)"
[ -n "$APP_DIR" ] && [ -n "$PORT" ] && [ -x "$NODE" ] || finish none
systemctl is-active --quiet desk-hub || finish "error:这台服务器上的 Lamplit 没在运行"

OUT=$("$NODE" -e '
const fs = require("fs");
const [body, port, keyFile] = process.argv.slice(1);
const payload = fs.readFileSync(body, "utf8");
const url = `http://127.0.0.1:${port}/api/relay-link`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let last = "";
  for (let i = 0; i < 40; i += 1) {
    let key = "";
    try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch { /* made on the first local request */ }
    try {
      const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...(key ? { "x-lamplit-local": key } : {}) }, body: payload, signal: AbortSignal.timeout(10000) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { console.log("ok"); return; }
      last = (j && j.error && (j.error.message || j.error.code)) || `HTTP ${res.status}`;
      // 404: a Lamplit from before the relay; nothing to wait for.
      if (res.status === 404) { console.log("error:这台服务器上的 Lamplit 版本太旧，不认识中转（先更新它）"); return; }
    } catch (err) { last = err.message; }
    await sleep(1500);
  }
  console.log(`error:${String(last).replace(/\s+/g, " ").slice(0, 160)}`);
})();
' "$BODY" "$PORT" "$APP_DIR/data/local-key" 2>&1 | tail -1)
finish "${OUT:-error:没有结果}"
