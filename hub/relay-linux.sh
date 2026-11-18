#!/bin/bash
# ==========================================================================
#  relay-linux.sh —— 把这台云服务器做成 Lamplit 自己的中转（不用 Tailscale，第 1 步原型）
#
#  用法（root）：relay-linux.sh <relay.mjs 的路径> [TCP 端口，默认 34443]
#
#  家里的电脑主动连到这里，手机在外面也连到这里，中转把加密的数据原样转给
#  电脑。中转只看 TLS 握手里的电脑编号（SNI），不解密：对话、文件、屏幕、
#  令牌它都看不到。加解密只在手机和电脑上做。
#
#  做的事：找到 Node.js 20+ → 装 hub/relay/relay.mjs 到 /opt/lamplit-relay →
#  注册成 lamplit-relay 服务（独立的临时账号，只能写自己的数据目录）→ 等它
#  生成自己的证书和「加入密码」→ 把证书指纹和加入密码交回给装它的电脑。
#  可以重复运行：数据目录（证书、加入密码、已登记的电脑）保留不变。
# ==========================================================================
set -u
SRC="${1:-}"
PORT="${2:-34443}"
BASE=/opt/lamplit-relay
SERVICE=lamplit-relay
STATE_DIR=/var/lib/lamplit-relay

say() { echo "[desk] $*"; }
fail() { echo "DESK_RELAY_ERROR=$1"; exit 1; }

[ "$(id -u)" = 0 ] || fail "要用 root 运行"
[ -f "$SRC" ] || fail "没有找到中转程序（上传失败？）"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "端口不对：$PORT（要 1024–65535）"
command -v systemctl >/dev/null 2>&1 || fail "这台服务器没有 systemd，暂时没法装成服务"

# 1. Node.js 20+：Lamplit 装过的那份优先，其次系统自带的。
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
NODE=""
for c in /opt/desk-hub/runtime/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && node_ok "$c"; then NODE="$c"; break; fi
done
[ -n "$NODE" ] || fail "这台服务器上没有 Node.js 20 以上（先用「添加机器」把 Lamplit 装上，它会带上 Node.js）"
mkdir -p "$BASE"
# 服务用的临时账号进不了 /root 和 /home：Node 在那里就复制一份过来。
case "$NODE" in
  /root/*|/home/*) install -m 0755 "$NODE" "$BASE/node" && NODE="$BASE/node" ;;
esac

# 2. 端口不能被别的程序占着（我们自己的服务除外）。
if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  systemctl is-active --quiet "$SERVICE" || fail "端口 $PORT 已经被别的程序占用，换一个端口再装"
fi

# 3. 程序和服务
install -m 0644 "$SRC" "$BASE/relay.mjs"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Lamplit relay (reach your computer without Tailscale)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE $BASE/relay.mjs --port $PORT --data $STATE_DIR
DynamicUser=yes
StateDirectory=lamplit-relay
StateDirectoryMode=0700
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE" || fail "服务没能启动（journalctl -u $SERVICE 看原因）"

# 4. 本机防火墙（如果开着）放行这个端口；云服务器控制台的安全组要你自己去放行。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# 5. 等它生成证书和加入密码，再自己连一次看看。
for _ in $(seq 1 30); do
  [ -s "$STATE_DIR/tls/cert.pem" ] && [ -s "$STATE_DIR/join-secret" ] && break
  sleep 1
done
[ -s "$STATE_DIR/tls/cert.pem" ] || fail "服务启动了但没有生成证书（journalctl -u $SERVICE 看原因）"
FP=$("$NODE" -e "const c=require('crypto'),f=require('fs');console.log(new c.X509Certificate(f.readFileSync(process.argv[1])).fingerprint256.replace(/:/g,'').toLowerCase())" "$STATE_DIR/tls/cert.pem") || fail "读不出证书指纹"
HEALTH=$("$NODE" -e "
const t=require('tls');const s=t.connect({host:'127.0.0.1',port:+process.argv[1],servername:'lamplit-relay',rejectUnauthorized:false},()=>s.write('GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
let o='';s.on('data',d=>o+=d);s.on('close',()=>console.log(/\"relay\":\"lamplit\"/.test(o)?'ok':'bad'));s.on('error',()=>console.log('bad'));setTimeout(()=>{console.log('bad');process.exit(0)},5000);" "$PORT" | head -1)
[ "$HEALTH" = ok ] || fail "服务在跑，但本机连不上它的端口 $PORT"

say "中转装好了：TCP $PORT，证书指纹 $FP"
echo "DESK_RELAY_FP=$FP"
echo "DESK_RELAY_PORT=$PORT"
echo "DESK_RELAY_JOIN=$(tr -d '[:space:]' < "$STATE_DIR/join-secret")"
echo "DESK_RELAY=ready"
