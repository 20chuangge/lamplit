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
#  做的事：找到 Node.js 20+（没有就从系统软件源或 NodeSource 装上）→ 装 hub/relay/relay.mjs 到 /opt/lamplit-relay →
#  注册成 lamplit-relay 服务（独立的临时账号，只能写自己的数据目录）→ 等它
#  生成自己的证书和「加入密码」→ 把证书指纹和加入密码交回给装它的电脑。
#  可以重复运行：数据目录（证书、加入密码、已登记的电脑）保留不变；换端口就是
#  用新端口再装一次。
#
#  卸载：relay-linux.sh --uninstall —— 停掉并删除服务、程序和数据目录，删掉本机
#  防火墙里为它放行的端口。云服务器控制台里的规则要你自己删。
# ==========================================================================
set -u
SRC="${1:-}"
PORT="${2:-34443}"
BASE=/opt/lamplit-relay
SERVICE=lamplit-relay
STATE_DIR=/var/lib/lamplit-relay
UNIT="/etc/systemd/system/$SERVICE.service"

say() { echo "[desk] $*"; }
fail() { echo "DESK_RELAY_ERROR=$1"; exit 1; }

[ "$(id -u)" = 0 ] || fail "要用 root 运行"

if [ "$SRC" = "--uninstall" ]; then
  OLD_PORT="$(sed -n 's/.*--port \([0-9]*\).*/\1/p' "$UNIT" 2>/dev/null | head -1)"
  systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload >/dev/null 2>&1 || true
  # DynamicUser 的数据实际在 /var/lib/private 下，/var/lib/lamplit-relay 是指向它的链接。
  rm -rf "$BASE" "$STATE_DIR" "/var/lib/private/$SERVICE"
  if [ -n "$OLD_PORT" ]; then
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
      ufw delete allow "$OLD_PORT/tcp" >/dev/null 2>&1 || true
      ufw delete allow "$OLD_PORT/udp" >/dev/null 2>&1 || true
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
      firewall-cmd --permanent --remove-port="$OLD_PORT/tcp" >/dev/null 2>&1 || true
      firewall-cmd --permanent --remove-port="$OLD_PORT/udp" >/dev/null 2>&1 || true
      firewall-cmd --reload >/dev/null 2>&1 || true
    fi
  fi
  systemctl is-active --quiet "$SERVICE" && fail "服务还在运行，没能停掉"
  say "中转已卸载${OLD_PORT:+（原来的端口 TCP $OLD_PORT）}"
  echo "DESK_RELAY_PORT=${OLD_PORT:-}"
  echo "DESK_RELAY=removed"
  exit 0
fi

[ -f "$SRC" ] || fail "没有找到中转程序（上传失败？）"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "端口不对：$PORT（要 1024–65535）"
command -v systemctl >/dev/null 2>&1 || fail "这台服务器没有 systemd，暂时没法装成服务"

# 1. Node.js 20+：Lamplit 装过的那份优先，其次系统里已有的；都没有（或太旧）就自己装（1.5.51）。
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
find_node() {
  NODE=""
  for c in /opt/desk-hub/runtime/bin/node "$(command -v node 2>/dev/null || true)" /usr/bin/node; do
    if [ -n "$c" ] && node_ok "$c"; then NODE="$c"; return 0; fi
  done
  return 1
}

# 从可信的地方装 Node.js：系统自己的软件源（版本够 20 就用它），否则 NodeSource
# （Node.js 官网列出的 Linux 软件源）固定的大版本 NODE_MAJOR。NodeSource 的软件包
# 有签名，apt 用 signed-by、dnf/yum 用 gpgcheck=1 来验，不运行网上下载的脚本。
NODE_MAJOR=22
# 安装日志放在只有 root 能写的地方（1.5.54，检查报告 L8：/tmp 里固定的文件名可能被别人先放一个链接）。
NODE_LOG=/var/log/lamplit-node-install.log
# NodeSource 的签名钥匙（1.5.54，L8）：下载后先核对指纹，对不上就不装。指纹取自 2026-11-21 经 HTTPS 下载的钥匙
# （NodeSource 没有用文字公布指纹），以后钥匙被换掉就能发现。
NODESOURCE_DEB_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4
NODESOURCE_RPM_FPR=242B813831AF09562B6C46F76B88DA4E3AF28A14
# 一个钥匙文件的主钥匙指纹（新旧 gpg 都能用的写法）。文件里必须正好一把主钥匙：多夹一把别的钥匙，
# 它也会被系统信任（1.5.54 复查，L8），那样就什么都不输出，指纹对不上。
key_fpr() { { gpg --show-keys --with-colons "$1" 2>/dev/null || gpg --with-colons --with-fingerprint "$1" 2>/dev/null; } | awk -F: '/^pub/ {n++; want=1; next} /^fpr/ && want {if (!f) f=$10; want=0} END {if (n == 1) print f}'; }
install_node() {
  [ -r /etc/os-release ] || fail "不认识这个系统（没有 /etc/os-release），没法自动装 Node.js。最省事的是把这台云服务器重装成 Ubuntu 24.04 再装中转；或者先自己装好 Node.js 20 或更新。说明：https://20chuangge.github.io/lamplit/docs.html#outside"
  # shellcheck disable=SC1091
  . /etc/os-release
  local ids=" ${ID:-} ${ID_LIKE:-} " arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *) fail "这台服务器的处理器（$arch）没有现成的 Node.js 软件包：请先自己装好 Node.js 20 或更新，再装中转" ;;
  esac
  : > "$NODE_LOG"
  if command -v apt-get >/dev/null 2>&1 && [[ "$ids" =~ \ (debian|ubuntu)\  ]]; then
    say "正在安装 Node.js（中转要用它运行；这台服务器上没有 20 或更新的版本）…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update >>"$NODE_LOG" 2>&1 || true
    local cand
    cand="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p' | head -1)"
    if [ "${cand:-0}" -ge 20 ] 2>/dev/null; then
      say "用系统软件源里的 Node.js $cand（${PRETTY_NAME:-$ID}）"
      apt-get install -y nodejs >>"$NODE_LOG" 2>&1 || fail "安装系统自带的 Node.js 失败（细节在服务器的 $NODE_LOG）"
    else
      say "系统软件源里的 Node.js 太旧，改用 Node.js 官网推荐的软件源（NodeSource）装 Node.js $NODE_MAJOR：软件包有签名，会先验证再装"
      apt-get install -y ca-certificates curl gnupg >>"$NODE_LOG" 2>&1 || fail "安装 curl / gnupg 失败（细节在服务器的 $NODE_LOG）"
      mkdir -p /usr/share/keyrings
      local asc
      asc="$(mktemp)"
      curl -fsSL -o "$asc" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key 2>>"$NODE_LOG" \
        || { rm -f "$asc"; fail "下载 NodeSource 的签名钥匙失败（这台服务器连不上 deb.nodesource.com？）"; }
      [ "$(key_fpr "$asc")" = "$NODESOURCE_DEB_FPR" ] || { rm -f "$asc"; fail "NodeSource 的签名钥匙和记下的指纹对不上，没有装（请先自己装好 Node.js 20 或更新，再装中转）"; }
      gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg "$asc" 2>>"$NODE_LOG" || { rm -f "$asc"; fail "处理 NodeSource 的签名钥匙失败"; }
      rm -f "$asc"
      chmod 644 /usr/share/keyrings/nodesource.gpg
      rm -f /etc/apt/sources.list.d/nodesource.list
      cat > /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
      printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
      apt-get update >>"$NODE_LOG" 2>&1 || fail "读取 NodeSource 软件源失败（细节在服务器的 $NODE_LOG）"
      apt-get install -y nodejs >>"$NODE_LOG" 2>&1 || fail "从 NodeSource 安装 Node.js 失败（细节在服务器的 $NODE_LOG）"
    fi
  elif [[ "$ids" =~ \ (rhel|centos|fedora|rocky|almalinux|ol|tencentos|opencloudos|anolis|alinux|amzn)\  ]] && { command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; }; then
    local pm=yum avail
    command -v dnf >/dev/null 2>&1 && pm=dnf
    say "正在安装 Node.js（中转要用它运行；这台服务器上没有 20 或更新的版本）…"
    # 系统自己的：Rocky / Alma / RHEL 8–9 的 AppStream 里有 nodejs:$NODE_MAJOR 这个模块流，新系统直接有新版本。
    if $pm -y module install "nodejs:$NODE_MAJOR/common" >>"$NODE_LOG" 2>&1 && find_node; then
      say "用系统软件源里的 Node.js $NODE_MAJOR（${PRETTY_NAME:-$ID}）"
    else
      avail="$($pm -q list available nodejs 2>/dev/null | awk '/^nodejs\./ {print $2}' | sed 's/^[0-9]*://' | cut -d. -f1 | sort -n | tail -1)"
      if [ "${avail:-0}" -ge 20 ] 2>/dev/null; then
        say "用系统软件源里的 Node.js $avail（${PRETTY_NAME:-$ID}）"
        $pm install -y nodejs >>"$NODE_LOG" 2>&1 || fail "安装系统自带的 Node.js 失败（细节在服务器的 $NODE_LOG）"
      else
        say "系统软件源里的 Node.js 太旧，改用 Node.js 官网推荐的软件源（NodeSource）装 Node.js $NODE_MAJOR：软件包有签名，会先验证再装"
        rm -f /etc/yum.repos.d/nodesource*.repo
        # 钥匙先下到本机、核对指纹，软件源再指向这个本地文件（1.5.54，L8）。
        mkdir -p /etc/pki/rpm-gpg
        curl -fsSL -o /etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource https://rpm.nodesource.com/gpgkey/ns-operations-public.key 2>>"$NODE_LOG" \
          || fail "下载 NodeSource 的签名钥匙失败（这台服务器连不上 rpm.nodesource.com？）"
        if [ "$(key_fpr /etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource)" != "$NODESOURCE_RPM_FPR" ]; then
          rm -f /etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource
          fail "NodeSource 的签名钥匙和记下的指纹对不上，没有装（请先自己装好 Node.js 20 或更新，再装中转）"
        fi
        cat > /etc/yum.repos.d/nodesource-nodejs.repo <<EOF
[nodesource-nodejs]
name=Node.js Packages for Linux RPM based distros - \$basearch
baseurl=https://rpm.nodesource.com/pub_${NODE_MAJOR}.x/nodistro/nodejs/\$basearch
priority=9
enabled=1
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-nodesource
module_hotfixes=1
EOF
        # 已有一个旧的 nodejs 时是升级，没有时是安装。
        if rpm -q nodejs >/dev/null 2>&1; then $pm upgrade -y nodejs >>"$NODE_LOG" 2>&1; else $pm install -y nodejs >>"$NODE_LOG" 2>&1; fi \
          || fail "从 NodeSource 安装 Node.js 失败（细节在服务器的 $NODE_LOG）"
      fi
    fi
  else
    fail "不认识这个系统（${PRETTY_NAME:-${ID:-未知}}），没法自动装 Node.js。最省事的是在云服务器控制台把系统重装成 Ubuntu 24.04 再装中转；或者先自己装好 Node.js 20 或更新。能自动装的：Ubuntu、Debian、Rocky、AlmaLinux、CentOS、RHEL、TencentOS、OpenCloudOS、Alibaba Cloud Linux。说明：https://20chuangge.github.io/lamplit/docs.html#outside"
  fi
  hash -r
  find_node || fail "装了 Node.js，但还是找不到 20 或更新的版本（细节在服务器的 $NODE_LOG）"
  say "Node.js $("$NODE" -v) 装好了（$NODE）"
}

find_node || install_node
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
OLD_PORT="$(sed -n 's/.*--port \([0-9]*\).*/\1/p' "$UNIT" 2>/dev/null | head -1)"
install -m 0644 "$SRC" "$BASE/relay.mjs"
cat > "$UNIT" <<EOF
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

# 4. 本机防火墙（如果开着）放行这个端口：TCP 给中转，UDP 给直连时问地址（STUN，1.5.46）；
# 云服务器控制台的安全组要你自己去放行。换了端口：旧端口在本机防火墙里的放行也删掉。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw allow "$PORT/udp" >/dev/null 2>&1 || true
  [ -n "$OLD_PORT" ] && [ "$OLD_PORT" != "$PORT" ] && { ufw delete allow "$OLD_PORT/tcp" >/dev/null 2>&1 || true; ufw delete allow "$OLD_PORT/udp" >/dev/null 2>&1 || true; }
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port="$PORT/udp" >/dev/null 2>&1 || true
  [ -n "$OLD_PORT" ] && [ "$OLD_PORT" != "$PORT" ] && { firewall-cmd --permanent --remove-port="$OLD_PORT/tcp" >/dev/null 2>&1 || true; firewall-cmd --permanent --remove-port="$OLD_PORT/udp" >/dev/null 2>&1 || true; }
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
echo "DESK_RELAY_OLD_PORT=${OLD_PORT:-}"
echo "DESK_RELAY_HUB=$([ -f /etc/systemd/system/desk-hub.service ] && echo yes || echo no)"
echo "DESK_RELAY_JOIN=$(tr -d '[:space:]' < "$STATE_DIR/join-secret")"
echo "DESK_RELAY=ready"
