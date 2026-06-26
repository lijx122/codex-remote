# Codex Remote

通过微信和 Web 远程控制 Windows 上的 Codex Desktop。查看会话、发送消息、打断执行，无需独立 app-server 接管。

**仅支持 Windows。** 依赖 Codex Desktop 的 `\\.\pipe\codex-ipc` 命名管道。

## 架构

```
微信 ─┐
       ├─→ codex-control-plane (HTTP/WS) ─→ codex-follower-core ─→ \\.\pipe\codex-ipc ─→ Codex Desktop
Web  ─┘
```

微信和 Web 共用 `codex-control-plane`，通过 REST API 操作，WebSocket 接收事件。`codex-follower-core` 直连 Desktop IPC 管道。

## 项目结构

```
codex/
├── adapters/
│   ├── web/                    Web 前端（由 codex-control-plane 提供）
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── wxbot/                  微信渠道（iLink Bot API）
│       ├── bin/ilink.js         入口：QR 登录 + 长轮询
│       └── src/
│           ├── adapter.js       命令处理、事件订阅
│           ├── control-plane-client.js  HTTP 调用 control-plane
│           ├── ilink-client.js  微信 iLink API
│           └── message-utils.js 消息格式化
├── packages/
│   ├── codex-follower-core/     IPC 核心层
│   │   └── src/
│   │       ├── index.js         连接管理、会话发现、发送/打断/warm
│   │       ├── ipc-transport.js 命名管道帧协议（4字节LE长度+JSON）
│   │       └── event-bus.js     发布订阅
│   └── codex-control-plane/     Web 服务层（REST + WebSocket + 静态文件）
│       ├── src/server.js
│       └── bin/codex-control-plane.js
├── tools/                       入口脚本与调试工具
├── start-daily-wxbot.ps1        一键启动（隐藏窗口，Web + 微信）
├── run-wxbot.bat                备选启动方式
├── run-wxbot-hidden.vbs         VBS 隐藏启动（桌面快捷方式用）
└── .env                         环境变量（HOST/PORT/TOKEN）
```

## 前置条件

- Windows 10/11
- [Codex Desktop](https://codex.openai.com) 已安装并运行
- Node.js ≥ 18（推荐用 fnm 管理）

## 快速开始

### 桌面快捷方式（推荐）

双击 `启动微信Bot(隐藏).lnk` 即可后台启动。创建方法：

1. 右键桌面 → 新建 → 快捷方式
2. 目标：`powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "F:\cx\cx\codex\start-daily-wxbot.ps1"`
3. 起始位置：`F:\cx\cx\codex`

### 手动启动

```powershell
# 安装依赖
npm install

# 一键启动 Web + 微信
.\start-daily-wxbot.ps1
```

第一次启动时，二维码图片会写入 `adapters/wxbot/.runtime/ilink-qrcode.png`，用手机微信扫描即可绑定。Token 保存在 `adapters/wxbot/.runtime/ilink-bot-token.json`，后续启动自动加载。

### 环境变量

复制 `.env.example` 为 `.env`，可选配置：

```ini
CODEX_CONTROL_PLANE_HOST=0.0.0.0
CODEX_CONTROL_PLANE_PORT=8787
ILINK_BOT_TOKEN=<微信Bot Token，用于跳过扫码>
```

## 使用

### Web 端

打开 http://127.0.0.1:8787

### 微信端

向绑定的 Bot 发送以下命令：

| 命令 | 说明 |
|---|---|
| `/ls [数量]` | 查看最近会话（默认20，`/ls all` 查看全部） |
| `/q <序号>` | 切换到指定会话，自动唤醒未加载的会话 |
| `/where` | 查看当前会话信息 |
| `/history` | 查看最近 20 条历史消息 |
| `/stop` | 中断当前执行 |
| `/help` | 查看帮助 |

直接发送文本（不以 `/` 开头）会注入 Desktop 当前会话。

### 会话状态标记

- **●** — Desktop 已加载，可直接发送
- **○** — 未加载，`/q` 或发送消息时会通过 deep link 自动唤醒

新建会话请在 Desktop 中操作（`Ctrl+N`）。

## 日志

日志文件在 `reports/` 目录：

- `control-plane.log` — control-plane 请求日志
- `wxbot.log` — 微信收发日志
- `wxbot.err` — 微信错误日志
- `pids.json` — 当前运行的进程 ID

## 单独启动

```powershell
# 仅 Web
node tools/codex-control-plane.js

# 仅微信
node adapters/wxbot/bin/ilink.js
```

## 已知限制

- **不支持创建新会话**：follower 客户端无此权限，请在 Desktop 中新建
- **未加载会话需唤醒**：Desktop 不在内存中的会话无法直接发送，系统通过 `codex://` deep link 自动唤醒
- **审批不可用**：Desktop 不向 follower 客户端发送审批请求（elevated sandbox 模式下几乎不弹审批）
- **仅 Windows**：IPC 管道路径 `\\.\pipe\codex-ipc` 是 Windows 命名管道
- **需要 Desktop 运行**：IPC 管道由 Desktop 主进程创建
