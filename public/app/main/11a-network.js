'use strict';
// Lamplit page, part 11a: the network check, the two relays and 体检 (split from 11-machines.js in 1.5.59, unchanged). Parts share one scope and load in order (scripts/check-page-parts.mjs).
/* ---------------------------------------------------------------------
   网络诊断 (1.5.28): how fast this device reaches the machine on screen, and
   that machine the others. Hundreds of milliseconds inside one country almost
   always means a proxy (Clash and the like) sends Tailscale abroad.
   --------------------------------------------------------------------- */
const NET_SLOW_MS = 150;
async function pingHub(times = 3) {
  const out = [];
  for (let i = 0; i < times; i += 1) {
    const started = performance.now();
    try { await api('/api/health'); out.push(Math.round(performance.now() - started)); } catch { /* counted as missing */ }
  }
  out.sort((a, b) => a - b);
  return out.length ? out[Math.floor((out.length - 1) / 2)] : null;
}
function netVerdict(ms) {
  if (ms == null) return ['连不上', 'bad'];
  if (ms < 80) return ['正常', 'ok'];
  if (ms < NET_SLOW_MS) return ['有点慢', 'ok'];
  return ['很慢', 'bad'];
}
async function runNetCheck() {
  const box = $('net-check-out');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="row-note">正在测…</div>';
  const here = await pingHub();
  const peers = await api('/api/peers/latency').catch(() => ({ machines: [] }));
  const line = (from, to, ms, extra = '') => {
    const [word, cls] = netVerdict(ms);
    return `<div class="net-line ${cls}"><span>${escapeHtml(from)} → ${escapeHtml(to)}</span><b>${ms == null ? '—' : `${ms} 毫秒`} · ${word}</b>${extra ? `<span class="row-note">${escapeHtml(extra)}</span>` : ''}</div>`;
  };
  const current = machineDisplayName();
  const rows = [line(isMobile() ? '这部手机' : '这台设备', current, here)];
  for (const m of peers.machines || []) rows.push(line(current, m.machine, m.ms, m.error ? '没连上' : (m.via === 'tailscale' ? '走 Tailscale' : m.via === 'relay' ? '走中转' : m.via === 'direct' ? '直连' : '')));
  const ts = window.desk?.tailscaleNetcheck && onLocalMachine() ? await window.desk.tailscaleNetcheck().catch(() => null) : null;
  const cn = (ts?.regions || []).find((r) => r.code === 'lamplit');
  if (cn) rows.push(line(isMobile() ? '这部手机' : '这台设备', '国内中转（Tailscale）', cn.ms, '直连打不通时走它'));
  else if (ts?.ok && (ts.regions || []).length) {
    const best = [...ts.regions].sort((a, b) => a.ms - b.ms)[0];
    rows.push(`<div class="row-note">Tailscale 直连打不通时走的中转：${escapeHtml(best.name)}，${best.ms} 毫秒${best.ms >= NET_SLOW_MS ? '（在国外；可以把一台国内云服务器做成加速站，见 设置 → 手机和外网 →「Tailscale 加速」）' : ''}。</div>`);
  }
  const fw = window.desk?.firewallStatus && onLocalMachine() ? await window.desk.firewallStatus().catch(() => null) : null;
  if (fw?.applies && fw.known && !fw.ok) rows.push('<div class="row-note warn-note">Windows 防火墙没有放行局域网里的手机：在「设置 → 手机和外网」里点「修复防火墙」。</div>');
  const slow = here == null || here >= NET_SLOW_MS || (peers.machines || []).some((m) => m.ms != null && m.ms >= NET_SLOW_MS);
  if (slow) {
    rows.push(`<div class="row-note warn-note">超过 ${NET_SLOW_MS} 毫秒，多半是网络在绕道：电脑上开着代理软件（Clash、V2Ray 等）时，Tailscale 的流量会被送到国外再绕回来。在代理规则的最前面加一条 <code>PROCESS-NAME,tailscaled.exe,DIRECT</code>，在 TUN（虚拟网卡）设置里排除局域网网段（192.168.0.0/16、10.0.0.0/8、172.16.0.0/12），然后在代理软件里关闭全部连接。手机和电脑在同一个 Wi-Fi 却很慢，也是这个原因。</div>`);
  } else {
    rows.push('<div class="row-note">都正常。</div>');
  }
  box.innerHTML = rows.join('');
}
document.addEventListener('click', (event) => {
  if (event.target.closest('#net-check')) runNetCheck();
});
/** Once a day at most: say so when the machine on screen answers slowly. */
setTimeout(async () => {
  let last = '';
  try { last = localStorage.getItem('lamplit.netwarn') || ''; } catch { /* no storage */ }
  const today = new Date().toDateString();
  if (last === today) return;
  const ms = await pingHub();
  if (ms == null || ms < 250) return;
  try { localStorage.setItem('lamplit.netwarn', today); } catch { /* no storage */ }
  toast(`连到这台机器很慢（约 ${ms} 毫秒）。打开「设置 → 机器 → 网络诊断」看看原因`, true);
}, 20000);

/* ---------------------------------------------------------------------
   国内中转 (1.5.29): a cloud server in China as Tailscale's relay. Installed
   over SSH (hub/derp-linux.sh), then two steps that only the human can do:
   open the ports in the cloud's security group, and paste the derpMap into
   the Tailscale policy file. The network check says when it is in use.
   --------------------------------------------------------------------- */
async function renderRelays() {
  const box = $('relay-status');
  if (!box) return;
  const data = await api(`/api/peers/relays${state.relayFresh ? '?fresh=1' : ''}`).catch(() => ({ machines: [] }));
  state.relayFresh = false;
  state.relays = data.machines || [];
  // In use? The machine asks its own Tailscale, so the phone sees it as well.
  const inUse = data.inUse || null;
  const chip = $('relay-chip');
  const ready = state.relays.filter((m) => m.relay?.state === 'ready');
  const installing = state.relays.some((m) => m.relay?.state === 'installing');
  if (chip) {
    chip.textContent = inUse ? `已生效 · ${inUse.ms} 毫秒` : installing ? '正在安装' : ready.length ? '还差几步' : state.relays.length ? '没装好' : '可选';
    chip.className = `relay-chip ${inUse ? 'ok' : ready.length || installing ? 'warn' : ''}`;
  }
  // Installing: look again every 10 s while the section is open (1.5.29: it said "正在连接 SSH…" long after it was done).
  clearTimeout(state.relayTimer);
  if (installing && $('relay-box')?.open) state.relayTimer = setTimeout(renderRelays, 10000);
  // The form is for a new relay: shown when there is none, behind a button otherwise.
  if ($('relay-form')) $('relay-form').hidden = state.relays.length > 0 && !state.relayFormOpen;
  if ($('relay-add')) $('relay-add').hidden = !state.relays.length || state.relayFormOpen;
  if (!state.relays.length) { box.innerHTML = ''; return; }
  const step = (done, html) => `<li class="${done ? 'done' : ''}"><span class="relay-check" aria-hidden="true">${done ? '✓' : ''}</span><span>${html}</span></li>`;
  box.innerHTML = state.relays.map((m, i) => {
    const r = m.relay || {};
    const head = `<div class="relay-head"><b>${escapeHtml(m.machine)}</b><span class="relay-ip">${escapeHtml(r.host || '')}</span></div>`;
    if (r.state !== 'ready' || !m.derpMap) {
      const word = r.state === 'failed' ? `没装好：${r.message || ''}` : (r.message || '正在安装');
      return `<div class="relay-card">${head}<div class="row-note${r.state === 'failed' ? ' warn-note' : ''}">${escapeHtml(word)}</div></div>`;
    }
    const portsOk = m.reachable === true;
    if (inUse) {
      return `<div class="relay-card">${head}<div class="row-note">已生效：直连打不通时走它，${inUse.ms} 毫秒。</div>
        <details class="relay-config"><summary>Tailscale 里的配置</summary><pre class="relay-map">${escapeHtml(m.derpMap)}</pre></details></div>`;
    }
    return `<div class="relay-card">${head}
      <ol class="relay-steps">
        ${step(true, '中转程序装好了')}
        ${step(portsOk, `在云服务器控制台的「安全组 / 防火墙」里放行 <code>TCP ${Number(r.port) || 33445}</code> 和 <code>UDP ${Number(r.stunPort) || 3478}</code>${portsOk ? '（已经连得上）' : ''}`)}
        ${step(false, `打开 <a href="https://login.tailscale.com/admin/acls/file" target="_blank" rel="noreferrer">Tailscale 后台 → Access controls → JSON editor</a>，把配置粘到最开头的 <code>{</code> 后面，保存`)}
      </ol>
      <div class="relay-actions"><button class="btn tiny primary" type="button" data-relay-copy="${i}">复制配置</button><button class="btn tiny" type="button" data-relay-recheck>再检查一次</button></div>
      <details class="relay-config"><summary>看配置内容</summary><pre class="relay-map">${escapeHtml(m.derpMap)}</pre></details>
    </div>`;
  }).join('');
}

async function startRelay() {
  const note = $('relay-note');
  const say = (text, bad = false) => { note.hidden = false; note.textContent = text; note.classList.toggle('warn-note', bad); };
  const host = $('relay-host').value.trim();
  const password = $('relay-ssh-pass').value;
  if (!host) return say('先填服务器的公网 IP（在云服务器控制台里能看到）', true);
  if (!password) return say('还需要这台服务器的 SSH 密码', true);
  const btn = $('relay-start');
  btn.disabled = true;
  try {
    const res = await provisionApi('/api/remote/relay', { method: 'POST', body: {
      host, publicIp: host, sshPort: Number($('relay-ssh-port').value) || 22, username: $('relay-ssh-user').value.trim() || 'root', password,
    } });
    $('relay-ssh-pass').value = '';
    let job = res.job;
    for (let i = 0; i < 120 && job?.state === 'running'; i += 1) {
      say(job.message || '正在连接…');
      await new Promise((r) => setTimeout(r, 1500));
      job = jobFrom(await provisionApi(`/api/remote/provision/${encodeURIComponent(job.id)}`).catch(() => null), job);
    }
    say(job?.message || '', job?.state === 'error');
    if (job?.state === 'done') setTimeout(renderRelays, 5000);
  } catch (err) {
    say(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#relay-start')) startRelay();
  if (event.target.closest('#relay-add')) { state.relayFormOpen = true; renderRelays(); }
  if (event.target.closest('[data-relay-recheck]')) { state.relayFresh = true; renderRelays(); }
  const copy = event.target.closest('[data-relay-copy]');
  if (copy) {
    const text = state.relays?.[Number(copy.dataset.relayCopy)]?.derpMap || '';
    (window.desk?.clipboardWrite ? window.desk.clipboardWrite(text) : navigator.clipboard.writeText(text))
      .then(() => toast('已复制，去 Tailscale 后台粘贴'), () => toast('复制失败，请手动选中复制', true));
  }
});
document.addEventListener('toggle', (event) => {
  if (event.target?.id === 'relay-box' && event.target.open) renderRelays();
}, true);

/* ---------------------------------------------------------------------
   不用 Tailscale：用你的云服务器中转 (设置 → 手机和外网, 第 2 步). Lamplit's
   own relay on a cloud server, installed over SSH (hub/relay-linux.sh); once
   installed this computer keeps a tunnel to it (「通过中转连接」, turned on by
   the install). The relay only forwards TLS it cannot read; the phone app
   pins this computer's own certificate, carried by the pairing code.
   The form has three uses: install, install again (same server: keeps the
   join secret and the registered computers; also how the port changes),
   uninstall.
   --------------------------------------------------------------------- */

/** Where to open the relay's port in the cloud console (src/remote.mjs says the same). */
function relayPortAdvice(port) {
  const p = Number(port) || 34443;
  return `在云服务器控制台放行 TCP ${p}，再加一条 UDP ${p}（直连用；来源都是 0.0.0.0/0）：腾讯云轻量应用服务器在实例详情的「防火墙」页添加规则；腾讯云 CVM（云服务器）在「安全组」的入站规则里添加；阿里云 ECS 也是「安全组」。`;
}



const isShown = (node) => Boolean(node && node.offsetParent !== null);

function tunnelFormMode(mode, view = state.tunnel || {}) {
  state.tunnelFormMode = mode || '';
  const form = $('tunnel-form');
  if (!form) return;
  const configured = Boolean(view.host && view.relayFingerprint);
  form.hidden = configured && !mode;
  const start = $('tunnel-start');
  const note = $('tunnel-form-note');
  $('tunnel-port').hidden = mode === 'uninstall';
  if ($('tunnel-cancel')) $('tunnel-cancel').hidden = !configured;
  start.classList.toggle('danger', mode === 'uninstall');
  if (mode === 'reinstall') {
    $('tunnel-host').value = view.host || '';
    $('tunnel-port').value = String(view.port || '');
    start.textContent = '重装中转';
    note.textContent = '在同一台服务器上再装一次：加入密码和已经登记的电脑都保留。想换端口，就改下面的端口再装（记得在云服务器控制台放行新端口）。';
  } else if (mode === 'uninstall') {
    $('tunnel-host').value = view.host || '';
    start.textContent = '卸载中转';
    note.textContent = '从这台服务器上删掉中转（服务、程序和它的数据），这台电脑也不再连它。手机在外面就连不上了，在家（局域网）不受影响。';
  } else {
    if (mode === 'add') { $('tunnel-host').value = ''; $('tunnel-port').value = ''; }
    start.textContent = '在这台服务器上装中转';
    note.textContent = '要一台有公网 IP 的 Linux 云服务器（腾讯云、阿里云等都行），填它的 SSH 账号。装好后这台电脑会自动连上，并试一下端口通不通。';
  }
}

async function renderTunnel(probe = true) {
  const box = $('tunnel-status');
  if (!box) return;
  let view;
  try {
    view = await api(probe === false ? '/api/relay-link' : '/api/relay-link?probe=1'); // opened: ask the relay again (1.5.47)
  } catch (err) {
    box.textContent = err.message || String(err);
    return;
  }
  state.tunnel = view;
  const configured = Boolean(view.host && view.relayFingerprint);
  const toggle = $('tunnel-enabled');
  if (toggle) { toggle.checked = Boolean(view.enabled); toggle.disabled = !configured; toggle.closest('label').hidden = !configured; }
  const chip = $('tunnel-chip');
  const words = { online: '已连上', connecting: '正在连接', error: '连不上', off: '关', unconfigured: '没装' };
  if (chip) {
    chip.textContent = view.enabled ? (words[view.state] || view.state) : configured ? '关' : '没装';
    chip.className = `relay-chip ${view.enabled && view.state === 'online' ? 'ok' : view.enabled ? 'warn' : ''}`;
  }
  // The form while there is no relay, or while one of its uses is open.
  if (!configured && state.tunnelFormMode !== 'add') tunnelFormMode('', view);
  else if ($('tunnel-form')) $('tunnel-form').hidden = !state.tunnelFormMode;
  if ($('tunnel-actions')) $('tunnel-actions').hidden = !configured || Boolean(state.tunnelFormMode);
  // Another machine's page in the desktop app (1.5.36): installing runs from this
  // computer (over SSH), so the form lives on 本机's page; here only its status.
  const elsewhere = Boolean(window.desk?.localProvision && machineBridge && !machineBridge.local);
  if (elsewhere) {
    if ($('tunnel-form')) $('tunnel-form').hidden = true;
    for (const id of ['tunnel-reinstall', 'tunnel-add', 'tunnel-uninstall']) if ($(id)) $(id).hidden = true;
    if ($('tunnel-actions')) $('tunnel-actions').hidden = !configured;
  } else {
    for (const id of ['tunnel-reinstall', 'tunnel-add', 'tunnel-uninstall']) if ($(id)) $(id).hidden = false;
  }
  if ($('tunnel-share')) $('tunnel-share').hidden = !(configured && view.enabled);
  const portNote = $('tunnel-port-note');
  box.textContent = '';
  if (!configured) {
    if (portNote) portNote.hidden = true;
    if (elsewhere) box.appendChild(el('div', '', '中转在「本机」的 设置 → 手机和外网 里装（在这台电脑上点，它会经 SSH 装到云服务器）；装好后点「让其他机器也用这个中转」，这台机器就跟着连上。'));
    return;
  }
  const mb = (n) => (Number(n) / 1024 / 1024).toFixed(1);
  const why = {
    RELAY_UNREACHABLE: '连不上中转：服务器关了，或者云服务器的防火墙（安全组）还没放行这个端口',
    RELAY_UNAUTHORIZED: '中转不认这台电脑（加入密码不对）：在这里点「重装 / 换端口」再装一次',
    RELAY_CERT_MISMATCH: '中转的证书变了：不是装的那一台，为了安全没有连',
  };
  const lines = [`中转：${view.host}，TCP ${view.port}`];
  if (!view.enabled) lines.push('「通过中转连接」关着：手机在外面连不上这台电脑。');
  else if (view.state === 'online') lines.push(`已连上。经过中转的连接 ${view.connections} 个，收 ${mb(view.bytesIn)} MB，发 ${mb(view.bytesOut)} MB。手机 App 扫过 设置 → 手机和外网 的二维码，出门用流量也能连回来。`);
  else if (view.state === 'error') lines.push(why[view.error] || `连不上中转（${view.error}）`);
  else lines.push('正在连接中转…');
  if (view.enabled && view.state === 'online' && relayUpdateWords(view)) lines.push(relayUpdateWords(view)); // 1.5.47: it updates itself
  for (const line of lines) box.appendChild(el('div', '', line));
  { const whyNode = relayFailureNode(view); if (whyNode) box.appendChild(whyNode); } // 1.5.50: why a new version did not start
  // 「先试直连」 (1.5.46): with the relay on; not on the relay's own server (nothing to save there).
  const direct = view.direct || {};
  const showDirect = configured && view.enabled && direct.applies !== false;
  if ($('tunnel-direct')) { $('tunnel-direct').checked = direct.enabled !== false; $('tunnel-direct').closest('label').hidden = !showDirect; }
  if ($('tunnel-direct-status')) { $('tunnel-direct-status').hidden = !showDirect; $('tunnel-direct-status').textContent = showDirect ? directWords(direct, view.port) : ''; }
  // Port closed in the cloud console: say where to open it, every time it is the reason.
  if (portNote) {
    const closed = view.enabled && view.state === 'error' && view.error === 'RELAY_UNREACHABLE';
    portNote.hidden = !closed;
    if (closed) portNote.textContent = `${relayPortAdvice(view.port)}放行后点「再测一次」。`;
  }
  clearTimeout(state.tunnelTimer);
  if (isShown($('tunnel-box'))) state.tunnelTimer = setTimeout(() => renderTunnel(false), view.enabled && view.state !== 'online' ? 3000 : 15000);
}

async function setTunnel(enabled) {
  try {
    await api('/api/relay-link', { method: 'PUT', body: { enabled } });
  } catch (err) {
    toast(err.message || String(err), true);
  }
  renderTunnel();
  loadSettings().then(() => renderPairing()).catch(() => {});
}



function tunnelSay(text, bad = false) {
  const note = $('tunnel-note');
  if (!note) return;
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('warn-note', bad);
}

async function testTunnel() {
  const btn = $('tunnel-test');
  if (btn) btn.disabled = true;
  tunnelSay('正在从这台电脑试连中转的端口…');
  try {
    const res = await api('/api/relay-link/test', { method: 'POST' });
    const port = res.view?.port || state.tunnel?.port;
    if (res.ok) tunnelSay(`通了：这台电脑连中转要 ${res.ms} 毫秒。`);
    else if (res.code === 'RELAY_CERT_MISMATCH') tunnelSay('这个端口上回答的不是装的那个中转（证书对不上）。点「重装 / 换端口」换一个端口再装。', true);
    else tunnelSay(`还是连不上 TCP ${port}。${relayPortAdvice(port)}`, true);
  } catch (err) {
    tunnelSay(err.message || String(err), true);
  } finally {
    if (btn) btn.disabled = false;
    renderTunnel();
  }
}

async function startTunnel() {
  const mode = state.tunnelFormMode === 'uninstall' ? 'uninstall' : 'install';
  const host = $('tunnel-host').value.trim();
  const password = $('tunnel-ssh-pass').value;
  if (!host) return tunnelSay('先填云服务器的公网 IP（在云服务器控制台里能看到）', true);
  if (!password) return tunnelSay('还需要这台服务器的 SSH 密码', true);
  // eslint-disable-next-line no-alert
  if (mode === 'uninstall' && !window.confirm(`从 ${host} 上卸载中转？手机在外面就连不上这台电脑了。`)) return;
  const btn = $('tunnel-start');
  btn.disabled = true;
  try {
    const res = await provisionApi('/api/remote/relay-tunnel', { method: 'POST', body: {
      mode, host, publicIp: host, sshPort: Number($('tunnel-ssh-port').value) || 22, username: $('tunnel-ssh-user').value.trim() || 'root', password,
      port: Number($('tunnel-port').value) || 34443,
    } });
    $('tunnel-ssh-pass').value = '';
    let job = res.job;
    for (let i = 0; i < 160 && job?.state === 'running'; i += 1) {
      tunnelSay(job.message || '正在连接…');
      await new Promise((r) => setTimeout(r, 1500));
      job = jobFrom(await provisionApi(`/api/remote/provision/${encodeURIComponent(job.id)}`).catch(() => null), job);
    }
    // Said once, here, until the next action: done, or what is left (the port).
    tunnelSay(job?.message || '', job?.state !== 'done');
    if (job?.state === 'done' || job?.state === 'warning') {
      tunnelFormMode('');
      await renderTunnel();
      loadSettings().then(() => renderPairing()).catch(() => {});
    }
  } catch (err) {
    tunnelSay(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

async function shareTunnel() {
  tunnelSay('正在告诉其他机器…');
  try {
    const res = await api('/api/relay-link/share', { method: 'POST' });
    const list = res.machines || [];
    tunnelSay(list.length
      ? list.map((m) => (m.ok ? (m.already ? `「${m.machine}」：已经在用这个中转` : `「${m.machine}」：已打开`) : `「${m.machine}」：没成功（${m.error || ''}）`)).join('\n')
      : '还没有其他机器。');
  } catch (err) {
    tunnelSay(err.message || String(err), true);
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#tunnel-start')) startTunnel();
  if (event.target.closest('#tunnel-test')) testTunnel();
  if (event.target.closest('#tunnel-share')) shareTunnel();
  const use = event.target.closest('#tunnel-add, #tunnel-reinstall, #tunnel-uninstall, #tunnel-cancel');
  if (use) {
    const mode = { 'tunnel-add': 'add', 'tunnel-reinstall': 'reinstall', 'tunnel-uninstall': 'uninstall' }[use.id] || '';
    tunnelSay('');
    tunnelFormMode(mode);
    renderTunnel();
  }
  // 设置 → 手机和外网 opened: show where the relay stands.
  if (event.target.closest('.setnav[data-set-target="sec-pair"]')) setTimeout(renderTunnel, 0);
});
document.addEventListener('change', (event) => {
  if (event.target?.id === 'tunnel-enabled') setTunnel(event.target.checked);
  if (event.target?.id === 'tunnel-direct') setDirect(event.target.checked);
});

/* ---------------------------------------------------------------------
   体检 (1.5.30): one list a new user can read top to bottom. The machine
   checks the model, the balance, voice, phones, its own load and the other
   machines (GET /api/checkup); this page adds what only it sees - its own
   distance to the machine, Windows Firewall, Tailscale's relay. Problems
   first; each with the one button that fixes or leads to the fix.
   --------------------------------------------------------------------- */
const CHECKUP_ORDER = { bad: 0, warn: 1, ok: 2, info: 3 };
async function gatherCheckup() {
  const data = await api('/api/checkup?deep=1').catch((err) => ({ items: [{ id: 'hub', title: '这台机器', state: 'bad', text: `问不到它的情况：${err.message}` }] }));
  const items = [...(data.items || [])];
  const here = await pingHub().catch(() => null);
  if (here != null && here >= NET_SLOW_MS) {
    items.push({ id: 'net', title: '网络', state: 'warn', text: `这台设备连到「${machineDisplayName()}」要 ${here} 毫秒，比正常慢很多：多半是代理软件让网络绕了远路。`, action: { kind: 'settings', target: 'sec-machines', label: '网络诊断' } });
  }
  const local = window.desk && onLocalMachine();
  const fw = local && window.desk.firewallStatus ? await window.desk.firewallStatus().catch(() => null) : null;
  // TCP for the phone at home, UDP for 直连 (1.5.49): 08-settings.js firewallCheckupItems.
  items.push(...firewallCheckupItems(fw, Boolean(state.settings?.server?.lanUrl), fw ? await api('/api/relay-link').catch(() => null) : null));
  const ts = local && window.desk.tailscaleNetcheck ? await window.desk.tailscaleNetcheck().catch(() => null) : null;
  if (ts?.ok && (ts.regions || []).length) {
    const best = [...ts.regions].sort((a, b) => a.ms - b.ms)[0];
    items.push(best.ms < NET_SLOW_MS
      ? { id: 'relay', title: 'Tailscale 中转', state: 'ok', text: `直连打不通时走「${best.name}」，${best.ms} 毫秒。` }
      : { id: 'relay', title: 'Tailscale 中转', state: 'info', text: `直连打不通时要绕到国外的「${best.name}」（${best.ms} 毫秒）。在家用影响不大；常在外面用，可以把一台国内云服务器做成 Tailscale 加速站。`, action: { kind: 'settings', target: 'sec-pair', label: 'Tailscale 加速' } });
  }
  items.sort((a, b) => (CHECKUP_ORDER[a.state] ?? 9) - (CHECKUP_ORDER[b.state] ?? 9));
  return items;
}

function renderCheckup(items) {
  const box = $('checkup-list');
  if (!box) return;
  state.checkupItems = items;
  box.innerHTML = items.map((it, i) => `<div class="checkup-row ${it.state}">
      <span class="checkup-dot" aria-hidden="true"></span>
      <div class="checkup-meta"><b>${escapeHtml(it.title)}</b><span>${escapeHtml(it.text)}</span></div>
      ${it.action ? `<button class="btn tiny${it.state === 'bad' ? ' primary' : ''}" type="button" data-checkup-act="${i}">${escapeHtml(it.action.label)}</button>` : ''}
    </div>`).join('');
  const bad = items.filter((it) => it.state === 'bad' || it.state === 'warn').length;
  if ($('checkup-when')) $('checkup-when').textContent = bad ? `发现 ${bad} 个要处理的地方` : '都正常';
}

async function runCheckup() {
  const box = $('checkup-list');
  if (box) box.innerHTML = '<div class="row-note">正在检查（要问一下模型服务商，十几秒）…</div>';
  const btn = $('checkup-run');
  if (btn) btn.disabled = true;
  try {
    const items = await gatherCheckup();
    renderCheckup(items);
    showCheckupBanner(items);
    return items;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function checkupAction(action) {
  if (!action) return;
  if (action.kind === 'settings') openSettings(action.target);
  else if (action.kind === 'link') openSignInPage(action.url);
  else if (action.kind === 'firewall') fixFirewall().then(() => runCheckup());
  else if (action.kind === 'runner') setupRunnerAccount().then(() => setTimeout(() => runCheckup(), 8000));
  else if (action.kind === 'vnc') secureScreen(action.replace).then(() => runCheckup());
}

/** Above the chat, once a day: the check found something to fix. */
function showCheckupBanner(items) {
  const bar = $('checkup-banner');
  if (!bar) return;
  const problems = (items || []).filter((it) => it.state === 'bad' || it.state === 'warn');
  let dismissed = '';
  try { dismissed = localStorage.getItem('lamplit.checkup.dismissed') || ''; } catch { /* no storage */ }
  bar.hidden = !problems.length || dismissed === new Date().toDateString() || (state.unconfigured && problems.every((p) => p.id === 'model'));
  if (!bar.hidden) $('checkup-banner-text').textContent = problems.length === 1 ? `体检：${problems[0].title}有问题。` : `体检发现 ${problems.length} 个要处理的地方。`;
}

document.addEventListener('click', (event) => {
  if (event.target.closest('#checkup-run')) runCheckup();
  const act = event.target.closest('[data-checkup-act]');
  if (act) checkupAction(state.checkupItems?.[Number(act.dataset.checkupAct)]?.action);
  if (event.target.closest('[data-set-target="sec-checkup"]') || event.target.closest('#checkup-banner-btn')) {
    if (event.target.closest('#checkup-banner-btn')) openSettings('sec-checkup');
    runCheckup();
  }
  if (event.target.closest('#checkup-banner-x')) {
    try { localStorage.setItem('lamplit.checkup.dismissed', new Date().toDateString()); } catch { /* no storage */ }
    $('checkup-banner').hidden = true;
  }
});

/* Once a day, a quiet check a minute after the app opens (no model test: free). */
setTimeout(async () => {
  let last = '';
  try { last = localStorage.getItem('lamplit.checkup.day') || ''; } catch { /* no storage */ }
  const today = new Date().toDateString();
  if (last === today || state.unconfigured) return;
  try { localStorage.setItem('lamplit.checkup.day', today); } catch { /* no storage */ }
  const data = await api('/api/checkup').catch(() => null);
  if (data?.items) showCheckupBanner(data.items);
}, 60000);
