# tib-service —— TiBrowser 边车服务

TiBrowser v1.0.0-rc1 的 Node 边车进程。它**不是**浏览器的一部分，而是一个可选的独立进程：

- 设置与密钥存储（Windows **DPAPI** 加密，绝不落盘明文）
- 书签 / 历史 / 下载记录（JSON + 原子写）
- AI：OpenAI 兼容协议（流式与非流式）、**MCP 客户端**（stdio 真实实现）、**OAuth 2.0 PKCE** 回环授权、智能体工具循环
- 本地办公模式（WorkBuddy 对标）与本地开发模式（Tare + codex 对标，带工作区沙箱）
- 本地自动化 API（HTTP + WebSocket），供用户自己的 AI 工具 / CLI / harness 驱动浏览器
- 安全浏览三档、turtlelnc 白名单、危险下载闸门
- `.tbuser` 配置迁移与本地/网盘文件夹同步

> 完整接口契约见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)；
> 边车 RPC 方法表见 [`../docs/SERVICE-API.md`](../docs/SERVICE-API.md)；
> 自动化接口见 [`../docs/AUTOMATION.md`](../docs/AUTOMATION.md)。

## 运行

```bash
cd service
npm install
npm run build        # tsc -p tsconfig.json
npm start            # node dist/index.js
```

启动参数：

```text
node dist/index.js [--port <n>] [--token-file <path>] [--token <t>] [--energy-mode <m>]
                    [--user-data <dir>] [--blocklists <dir>] [--headless] [--help]
```

**stdout 只输出一行** JSON（原生父进程据此判定就绪）：

```json
{"ready":true,"port":51234,"version":"1.0.0-rc1","build":260913,"capabilities":["store","ai:chat", "..."]}
```

其余日志全部走 stderr。启动后写入 `<userData>/service.json`（port/token/pid）。

## 验证

```bash
npm run typecheck    # tsc --noEmit
npm run self-test    # 打印 SELFTEST OK；不联网、不需要浏览器
npm run smoke        # 真实起进程，验证 CLI 参数、鉴权、自动化 HTTP/WS 通道
npm run check-bridge # 起一个「假原生端点」，验证 外部工具 → 边车 → 原生 的转发链路
npm run docs         # 重新生成 docs/SERVICE-API.md 与 docs/AUTOMATION.md
```

`npm run self-test` 覆盖 8 组共 100 项断言：RPC 鉴权（401/200）、设置/书签/历史 CRUD、
API Key 不落明文、URL 扫描表（含 turtlelnc 例外与下载警告）、假 OpenAI 服务端上的智能体
工具循环与权限闸门、假 MCP 服务器的 stdio 往返、工作区沙箱与同步。

## 目录结构

```text
service/src/
├── index.ts            入口（参数解析 + 就绪行）
├── app.ts              服务容器（装配各模块）
├── paths.ts            用户数据目录解析
├── selftest.ts         自检入口
├── shared/             共享类型与常量（src/shared 的只读镜像）
├── rpc/                RPC 服务器与方法注册表
├── store/              设置 / 密钥(DPAPI) / 书签 / 历史 / 下载 / 原子写
├── ai/                 client / providers / mcp / oauth / agent / tools / executor
│   └── modes/          本地办公模式、本地开发模式、工作区沙箱
├── automation/         本地自动化 API（HTTP + WS + 发现文件 + 文档生成）
├── security/           黑名单 / URL 扫描 / 三档能力矩阵 / 下载闸门 / 扩展审查
├── sync/               .tbuser 迁移 / 账户 / 可插拔同步后端
├── testing/            假 OpenAI 服务端、假 MCP 服务器、API 客户端、冒烟检查
└── tools/              文档生成器
```

## 依赖

运行时只依赖两个第三方包（其余全部使用 Node 内置模块）：

| 包 | 用途 | 说明 |
|---|---|---|
| `ws` | 自动化 WebSocket 通道 | Node 内置无 WebSocket **服务端**，必须引入 |
| `adm-zip` | `.tbuser` 配置文件打包/解包 | 与仓库根 v0.1.0 使用的同一库，保持格式兼容 |

## 本地能力的诚实边界

以下能力**本地无法实现**，代码中一律显式返回中文说明而不是假装成功：

- Google Safe Browsing / 微软 SmartScreen 云端实时威胁库比对与内容上报（需官方 API Key）
- 登录后的跨服务账号级保护
- 真实 Microsoft / Google 云同步（必须由用户自备 OAuth `client_id`）
- 语音转写（无本地 ASR 模型）；PDF / Word 二进制文档解析；生成 `.pptx`
- 扩展的动态沙箱分析（只做静态审查）
