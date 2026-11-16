# Lamplit 发布说明

**版本**：1.5.12
**日期**：2026-11-14

---

## 装哪个

| 你要什么 | 用这个 | 说明 |
|---|---|---|
| Windows 上长期用 | `Lamplit-Setup-1.5.12.exe` | 安装包，装到 `%LOCALAPPDATA%\Programs\Lamplit`，建桌面/开始菜单快捷方式，免管理员，可卸载 |
| 不想装 / 想放 U 盘 | `Lamplit-Portable-1.5.12.exe` | 免安装，双击即用 |
| Android 手机 | `Lamplit-Android-1.5.12.apk` | 侧载安装，允许「安装未知来源应用」即可；从 1.5.7 及更早版本升级要先卸载一次 |
| iPhone / 临时用 | 浏览器打开电脑上的地址 + 配对码 | 见下「手机」一节 |

桌面端两个 exe 约 80 MB，APK 约 27 MB。Windows 安装包**未签名**（首次运行 SmartScreen 提示「未知发布者」→ 更多信息 → 仍要运行）；APK 从 1.5.8 起用 Lamplit 自己的发版密钥签名（之前是调试签名，所以这一次要先卸载旧版再装、重新配对）。发布页列出了每个文件的 SHA-256，可以用 `Get-FileHash` 核对。

数据在 `%APPDATA%\Lamplit\`；从 1.2.151 及更早版本升级的电脑继续用原来的 `%APPDATA%\Desk\`，什么都不用搬。卸载不会删它。

---

## 这一版改了什么

- **文件卡片和页面卡片一个样子**：回复里提到的文件，左边是带颜色的类型标（PDF 红、Word 蓝、Excel / CSV 绿、PPT 橙、MD 灰），中间是文件名和「Markdown · 12 KB · 点开查看」，右边一个下载箭头。点开：PDF 在应用里看；md 按聊天里的样式排好版（标题、列表、表格）；txt 显示文字；csv 显示成表格。Word / Excel / PPT 应用里看不了，在这台电脑上点开用系统程序打开，别处点开就下载，卡片上会写清楚是哪一种。
- **连接应用改版**：一格一格的应用卡片，上面按分类筛选（全部、已连接、通信、开发、创作、效率、生活…），已连接的排前面；点一个就在原地展开怎么连。有官方图标的应用（Notion、GitHub、GitLab、X、Cloudflare、Kubernetes、Docker、Godot、Obsidian、Home Assistant、MiniMax、Suno）显示自己的标志，图标来自 simple-icons（CC0）。
- **新加的应用**（都按应用自己的文档或官方包接入）：X（推特，只读）、钉钉、高德地图、MiniMax、Cloudflare、Kubernetes、Docker、Godot、Obsidian、Home Assistant。需要填好几项的（钉钉的 Client ID 和 Secret、MiniMax 的 Key 和站点、Home Assistant 的地址和令牌）现在有对应的输入框。连的是这台电脑上的程序的（Obsidian、Docker、Godot、Kubernetes）只在这台机器上连接，不会同步到别的机器。Blender、虚幻引擎、Figma、Telegram、XMind 这次没有加：前两个的官方接入方式还没核实，Figma 只让它名单里的客户端连接，后两个没有可靠的官方包。
- **机器人不再绕过浏览器工具**：用命令直接连浏览器的调试端口（curl …/json、devtools 连接）去操作浏览器，每次都会先问你；正常用浏览器工具不受影响。
- **长文件分几次写**：机器人写长文件一开始就分段写，不会先写一个被截断的再重来。
- **自测**：`npm run smoke` 1376 项全部通过。

注意：1.2.156 起密钥文件已加密，**不要退回 1.2.155 及更早的版本**——旧版本读不了加密后的文件。

---

## 第一次使用

1. 双击 `Lamplit.exe`（或安装后的快捷方式）。窗口打开，模型默认是 `mock · 演示`。
2. 点右上角 **⚙** → 填 **Provider**（OpenAI 兼容端点）、**Base URL**、**Model**、**API Key** → **保存** → **测试连接**。
   - DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1`，模型 `gpt-4o-mini`
   - 本地 Ollama / vLLM：填你自己的 `http://127.0.0.1:11434/v1`
3. 回到对话，直接说话。高风险动作会停下来等你批准。

## 手机

1. 电脑上 ⚙ → **配对**，能看到局域网地址和 **8 位配对码**。
   - 如果只显示 `127.0.0.1`，说明只监听了本机：用 `ASSIST_ALLOW_REMOTE=1` 重启，或在设置里打开「手机和外网」。
2. 手机浏览器打开该地址输码，或在 Android App 里扫码 / 填地址 + 码。
3. 装好 App 并配对后，它会在后台保持一条事件连接：任务做完、或助手停下来等你确认时，通知会到手机上。审批通知上的「批准 / 拒绝」直接生效。

---

## 已知限制

- **安装包未签名**：SmartScreen 会警告。正式分发需要 OV/EV 证书。
- **隔离有限**：Linux 上机器人的命令在 bubblewrap 沙箱里跑，Windows 上用单独的低权限账户跑（设置 → 边界 → 命令隔离）；但 Windows 的 D 盘等其他磁盘按系统默认所有账户可读写，macOS 没有隔离。审批防手滑，不防恶意模型。
- **撤销只管文件工具**：机器人用写文件、删文件改动工作区，7 天内能撤销；用命令行改的不在其内。
- **手机端还没有附件和语音**：选图、拖文件、录音目前只能在网页端 / 桌面端用。
- **公网访问要自己加一层**：Hub 的鉴权是配对码 / 令牌，暴露公网前请套 Tailscale 或 Cloudflare Tunnel。
- **审批「可恢复」≠「可续跑」**：无人值守任务在重启后只记录决策，需要重跑。
- **记忆不压缩**：只追加，召回靠关键词 + 时间衰减。

## 从源码构建

```bash
npm install
npm start                  # 服务 + 网页界面 http://127.0.0.1:4390
npm run desktop:build      # Windows 安装包 / 免安装 → desktop/dist/
npm run smoke              # 全量自测
```

Android 需要 JDK 21 + Android SDK，步骤见 `docs/BUILD-MOBILE.md`。
