// CommonJS on purpose: a sandboxed preload (sandbox: true) cannot be an ES
// module, and this file must be listed in electron-builder.yml `files:` or it
// simply will not exist inside app.asar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskShell', {
  minimize: () => ipcRenderer.send('shell:minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-maximize'),
  close: () => ipcRenderer.send('shell:close'),
});

// Machine switching lives in the main window, which uses THIS preload (not
// preload.mjs). Without it window.desk is undefined and every machine button
// silently does nothing.
// 外观 and 语言, kept once for every machine (1.3.2). Read synchronously: the
// page applies them before its first paint.
let viewPrefs = {};
try { viewPrefs = ipcRenderer.sendSync('desk:view-prefs-sync') || {}; } catch { /* first run */ }

contextBridge.exposeInMainWorld('desk', {
  viewPrefs,
  setViewPrefs: (prefs) => ipcRenderer.invoke('desk:set-view-prefs', prefs),
  listMachines: () => ipcRenderer.invoke('desk:list-machines'),
  machinesAttention: () => ipcRenderer.invoke('desk:machines-attention'),
  notify: (note) => ipcRenderer.invoke('desk:notify', note),
  switchHub: (url, message) => ipcRenderer.invoke('desk:switch-hub', url, message),
  useLocal: (message) => ipcRenderer.invoke('desk:use-local', message),
  takePendingMessage: () => ipcRenderer.invoke('desk:take-pending-message'),
  addMachine: (machine) => ipcRenderer.invoke('desk:add-machine', machine),
  renameMachine: (url, name) => ipcRenderer.invoke('desk:rename-machine', { url, name }),
  removeMachine: (url) => ipcRenderer.invoke('desk:remove-machine', url),
  syncModel: () => ipcRenderer.invoke('desk:sync-model'),
  syncVoice: (voice) => ipcRenderer.invoke('desk:sync-voice', voice),
  syncConfig: (req) => ipcRenderer.invoke('desk:sync-config', req),
  voiceStart: () => ipcRenderer.invoke('desk:voice-start'),
  localProvision: (req) => ipcRenderer.invoke('desk:local-provision', req),
  openFile: (rel, reveal = false) => ipcRenderer.invoke('desk:open-file', { rel, reveal }),
  // Settings → 手机和外网 → 允许手机连接: rebinds the bundled server to the network.
  setRemote: (on) => ipcRenderer.invoke('desk:set-remote', Boolean(on)),
  // Windows Firewall lets a phone on the LAN in? and the one-click fix (asks for admin) (1.5.29).
  firewallStatus: () => ipcRenderer.invoke('desk:firewall-status'),
  firewallFix: () => ipcRenderer.invoke('desk:firewall-fix'),
  // Tailscale's relay regions and their distance from this computer (read-only, 1.5.29).
  tailscaleNetcheck: () => ipcRenderer.invoke('desk:tailscale-netcheck'),
  voiceStop: () => ipcRenderer.invoke('desk:voice-stop'),
  voiceCancel: () => ipcRenderer.invoke('desk:voice-cancel'),
  voiceLevel: () => ipcRenderer.invoke('desk:voice-level'),
  // The system clipboard: a machine's page is plain http, where navigator.clipboard is absent.
  clipboardRead: () => ipcRenderer.invoke('desk:clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('desk:clipboard-write', String(text ?? '')),
  // A sign-in page (a connected app's OAuth) in the system browser, never in this window.
  openExternal: (url) => ipcRenderer.invoke('desk:open-external', String(url ?? '')),
  // 有新版本 → 立即更新: download the Lamplit installer, install it, start again.
  installUpdate: (url) => ipcRenderer.invoke('desk:install-update', String(url ?? '')),
  // 设置 → 备份 (1.5.54): the system's save / open / folder dialogs; a path for this computer's hub.
  pickBackupSave: (name) => ipcRenderer.invoke('desk:pick-backup-save', String(name ?? '')),
  pickBackupOpen: () => ipcRenderer.invoke('desk:pick-backup-open'),
  pickFolder: () => ipcRenderer.invoke('desk:pick-folder'),
});
