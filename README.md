# Codex Remote

通过微信和 Web 远程控制 Windows 上的 Codex Desktop。查看会话、发送消息、打断执行，无需独立 app-server 接管。

**仅支持 Windows。** 依赖 Codex Desktop 的 `\\.\pipe\codex-ipc` 命名管道。

## 架构

```
微信 ─┐
       ├─→ codex-follower-core ─→ \\.\pipe\codex-ipc ─→ Codex Desktop
Web  ─┘
```

所有渠道共用 `codex-follower-core`，直连 Desktop 内嵌的 IPC 管道。不启动独立 app-server，不经过 HTTP 中间层。

## 项目结构

```
codex/
├── adapters/
│   ├── web/                    Web 前端（由 codex-control-plane 提供服务）
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── wxbot/                  微信渠道（iLink Bot API）
│       ├── bin/ilink.js         入口：QR 登录 + 长轮询
│       └── src/
│           ├── adapter.js       命令处理
│           ├── follower-client.js  封装 codex-follower-core
│           ├── ilink-client.js  微信 iLink API
│           └── message-utils.js 消息格式化
├── packages/
│   ├── codex-follower-core/     IPC 核心层
│   │   └── src/
│   │       ├── index.js         连接管理、会话操作、事件发布
│   │       ├── ipc-transport.js 命名管道帧协议
│   │       └── event-bus.js     发布订阅
│   ├── codex-control-plane/     Web 服务（REST + WebSocket + 静态文件）
│   └── codex-follower-cli/      CLI 调试工具
├── tools/                       入口脚本
├── start-daily-wxbot.ps1        一键启动（Web + 微信）
├── BASE_LAYER_INTEGRATION.md    基础层对接文档
├── codex-remote-control-research.md  调研报告
└── production-readiness-report.md    稳定性测试报告
```

## 前置条件

- Windows 10/11
- [Codex Desktop](https://codex.openai.com) 已安装并运行
- Node.js ≥ 18

## 快速开始

```powershell
# 安装依赖
npm install

# 一键启动 Web + 微信
.\start-daily-wxbot.ps1
```

第一次启动时，终端会打印微信扫码链接，用手机微信扫描即可绑定。Token 保存在 `adapters/wxbot/.runtime/ilink-bot-token.json`，后续启动自动加载。

## 使用

### Web 端

打开 http://127.0.0.1:8787

### 微信端

向绑定的 Bot 发送以下命令：

| 命令 | 说明 |
|---|---|
| `/ls` | 查看最近 20 个会话（带序号） |
| `/q <序号>` | 切换到指定会话，如 `/q 1` |
| `/where` | 查看当前会话信息 |
| `/history` | 查看最近消息 |
| `/stop` | 中断当前执行 |
| `/help` | 查看帮助 |

直接发送文本（不以 `/` 开头）会注入 Desktop 当前会话。新建会话请在 Desktop 中操作。

## 单独启动

```powershell
# 仅 Web
node tools/codex-control-plane.js

# 仅微信
node adapters/wxbot/bin/ilink.js
```

## 调试

```powershell
# CLI 测试工具
node tools/codex-follower.js list
node tools/codex-follower.js history <conversationId>
node tools/codex-follower.js send <conversationId> "hello"

# 底层 IPC 探测
node tools/codex-ipc-client.js init
```

## 已知限制

- **不支持创建新会话**：follower 客户端无此权限，请在 Desktop 中新建
- **审批不可用**：Desktop 不向 follower 客户端发送审批请求（elevated sandbox 模式下几乎不弹审批）
- **仅 Windows**：IPC 管道路径 `\\.\pipe\codex-ipc` 是 Windows 命名管道
- **需要 Desktop 运行**：IPC 管道由 Desktop 主进程创建
