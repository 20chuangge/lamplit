#!/bin/bash
# ==========================================================================
#  derp-linux.sh —— 把这台云服务器做成 Tailscale 的国内中转（DERP，Lamplit 1.5.29）
#
#  用法（root）：derp-linux.sh <这台服务器的公网 IP> [TCP 端口，默认 33445]
#
#  Tailscale 的两台设备直连打不通时会走中转；官方中转全在国外（新加坡、
#  美国……），从国内一来一回 200–400 毫秒。用一台国内的服务器当中转，只要
#  几十毫秒。只给你自己 Tailscale 账号里的设备用（--verify-clients，靠这台
#  机器上在线的 Tailscale 确认），别人用不了。
#
#  做的事：装 Go（国内镜像）→ 编译 Tailscale 官方的 derper → 用 IP 自签证书
#  → 注册成 lamplit-derp 服务 → 把要填进 Tailscale 后台的配置写进 Lamplit 的
#  数据目录（relay.json），「设置 → 机器 → 国内中转」显示它。
#  可以重复运行：装好的部分不重做。输出在 /var/log/lamplit-derp-setup.log。
# ==========================================================================
set -u
IP="${1:-}"
PORT="${2:-33445}"
STUN_PORT=3478
BASE=/opt/lamplit-derp
HUB_DATA=/opt/desk-hub/data
STATE="$HUB_DATA/relay.json"
SERVICE=lamplit-derp

export GOPATH="$BASE/gopath" GOMODCACHE="$BASE/gopath/pkg/mod" GOCACHE="$BASE/cache" GOBIN="$BASE/bin"
# Go 和 Tailscale 的源码走国内镜像；derper 要的新版 Go 也由它自动下载（GOTOOLCHAIN=auto）。
export GOPROXY="https://goproxy.cn,https://goproxy.io,direct" GOSUMDB="sum.golang.google.cn" GOTOOLCHAIN=auto GOFLAGS="-p=2"

say() { echo "[desk] $*"; }
write_state() { # 状态 说明 [证书指纹]
  mkdir -p "$HUB_DATA"
  printf '{"state":"%s","message":"%s","host":"%s","port":%s,"stunPort":%s,"certName":"%s","at":"%s"}\n' \
    "$1" "$2" "$IP" "$PORT" "$STUN_PORT" "${3:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  chown "$(stat -c %U "$HUB_DATA" 2>/dev/null || echo root)" "$STATE" 2>/dev/null || true
  chmod 644 "$STATE" 2>/dev/null || true
}
fail() { say "失败：$1"; write_state failed "$1"; echo "DESK_RELAY=failed"; exit 1; }

[ "$(id -u)" = 0 ] || { echo "要用 root 运行"; exit 1; }
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "用法：derp-linux.sh <公网 IP> [端口]"; exit 1; }
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "端口不对：$PORT"; exit 1; }
case "$IP" in
  10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    echo "$IP 不是公网 IP：中转要用手机和电脑都能直接连到的地址"; exit 1 ;;
esac

write_state installing "正在安装（约 5–10 分钟）"

# 1. Tailscale 必须在线：--verify-clients 靠它确认来的是你自己的设备。
command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1 \
  || fail "这台机器上的 Tailscale 没在运行：中转要靠它确认只给你自己的设备用"

# 2. Go
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "不支持的 CPU：$(uname -m)" ;;
esac
GO="$BASE/go/bin/go"
if [ ! -x "$GO" ]; then
  say "下载 Go…"
  # 1.5.61 (F13): into a folder of root's own (mktemp -d, not a fixed name in /tmp that another
  # account of this server could have put there first), and checked against the SHA-256 Go
  # publishes for that file before it is unpacked.
  GOJSON=$(curl -fsSL --max-time 20 'https://golang.google.cn/dl/?mode=json' 2>/dev/null | tr -d '\n' || true)
  V=$(printf '%s' "$GOJSON" | grep -o '"version": *"go[0-9.]*"' | head -1 | grep -o 'go[0-9.]*')
  [ -n "$V" ] || V=go1.25.0
  FILE="$V.linux-$ARCH.tar.gz"
  SUM=$(printf '%s' "$GOJSON" | grep -o "\"filename\": *\"$FILE\"[^}]*" | grep -o '"sha256": *"[0-9a-f]\{64\}"' | grep -o '[0-9a-f]\{64\}' | head -1)
  [ -n "$SUM" ] || SUM=$(curl -fsSL --max-time 20 "https://golang.google.cn/dl/$FILE.sha256" 2>/dev/null | grep -o '^[0-9a-f]\{64\}' | head -1)
  [ -n "$SUM" ] || fail "拿不到 Go 安装包的校验值（golang.google.cn 连不上），不装没核对过的 Go"
  mkdir -p "$BASE"
  GOTMP=$(mktemp -d) || fail "建不了临时文件夹"
  trap 'rm -rf "$GOTMP"' EXIT
  ok=0
  for url in "https://golang.google.cn/dl/$FILE" "https://mirrors.aliyun.com/golang/$FILE"; do
    if curl -fsSL --max-time 600 "$url" -o "$GOTMP/go.tgz" && printf '%s  %s\n' "$SUM" "$GOTMP/go.tgz" | sha256sum -c - >/dev/null 2>&1; then ok=1; break; fi
    rm -f "$GOTMP/go.tgz"
  done
  [ "$ok" = 1 ] || fail "下载不了 Go，或者下载的文件和官方校验值对不上（golang.google.cn 和阿里云镜像都试过）"
  rm -rf "$BASE/go" && tar -C "$BASE" -xzf "$GOTMP/go.tgz" || fail "Go 解压失败"
  rm -rf "$GOTMP"
fi

# 3. derper（Tailscale 官方的中转程序）
if [ ! -x "$BASE/bin/derper" ]; then
  say "编译 Tailscale 的中转程序（几分钟）…"
  "$GO" install tailscale.com/cmd/derper@latest || fail "编译 derper 失败（看 /var/log/lamplit-derp-setup.log）"
  # 编译用的缓存很大，用完就删。
  "$GO" clean -cache -modcache >/dev/null 2>&1 || true
  rm -rf "$BASE/cache"
fi

# 4. 服务：IP 自签证书（证书目录里没有就自动生成），只放行自己 Tailscale 里的设备。
mkdir -p "$BASE/certs"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Lamplit 国内中转（Tailscale DERP）
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=$BASE/bin/derper -hostname $IP -certmode manual -certdir $BASE/certs -a :$PORT -http-port -1 -stun -stun-port $STUN_PORT -verify-clients
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE" || fail "中转服务没能启动"

# 5. 本机防火墙（云服务器的安全组要你在控制台里放行，这里改不到）。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw allow "$STUN_PORT/udp" >/dev/null 2>&1 || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" --add-port="$STUN_PORT/udp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# 6. 确认它在答，取证书指纹（填进 Tailscale 后台时要用）。
CERT=""
for _ in $(seq 1 20); do
  sleep 1
  systemctl is-active --quiet "$SERVICE" || continue
  CERT=$(journalctl -u "$SERVICE" -n 80 --no-pager 2>/dev/null | grep -o '"CertName":"sha256-raw:[0-9a-f]*"' | tail -1 | sed 's/"CertName":"\(.*\)"/\1/')
  if [ -z "$CERT" ] && [ -f "$BASE/certs/$IP.crt" ] && command -v openssl >/dev/null 2>&1; then
    CERT="sha256-raw:$(openssl x509 -in "$BASE/certs/$IP.crt" -outform DER | sha256sum | cut -d' ' -f1)"
  fi
  [ -n "$CERT" ] && break
done
systemctl is-active --quiet "$SERVICE" || fail "中转服务启动后又停了（journalctl -u $SERVICE 看原因）"
[ -n "$CERT" ] || fail "中转起来了，但没读到证书指纹"
curl -sk --max-time 5 -o /dev/null "https://127.0.0.1:$PORT/" || say "注意：本机访问 https://127.0.0.1:$PORT 没有回应"

write_state ready "装好了：在云服务器安全组放行 TCP $PORT 和 UDP $STUN_PORT，再把配置填进 Tailscale 后台" "$CERT"
say "国内中转装好了：$IP:$PORT（STUN $STUN_PORT）"
echo "DESK_RELAY=ready $CERT"
