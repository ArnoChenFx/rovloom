# Rovloom 文档

## 使用

| 文档 | 内容 |
|---|---|
| [Quick Start](QUICK-START.md) · [快速开始](QUICK-START-zh.md) | 安装、配对、连接 MCP 客户端 |
| [Configuration](CONFIGURATION.md) · [配置参考](CONFIGURATION-zh.md) | 每个角色的唯一配置文件与全部参数 |
| [Docker deployment](DOCKER.md) · [Docker 部署](DOCKER-zh.md) | 用 Docker 运行 Gateway |
| [运维指南](OPERATIONS.md) | 令牌、管理员、重新配对、备份、升级、排错 |
| [开机服务](SERVICE.md) | 注册、启停与权限 |
| [管理页](GATEWAY-WEBUI.md) | 页面、操作与管理 API |
| [Agent skill](../skills/rovloom/SKILL.md) | 交给 AI 客户端的 MCP 使用指南：调用顺序、错误处置、无依赖调用脚本 |

## 设计与协议

| 文档 | 内容 |
|---|---|
| [系统设计](DESIGN.md) | 角色、Target/provider、授权、结果、去重、恢复与默认限额 |
| [协议总览](PROTOCOL.md) | MCP、Wire v2、原生契约三层接口 |
| [MCP Streamable HTTP](protocol/MCP-HTTP.md) | MCP 传输、工具、错误与调用顺序 |
| [Wire 协议](protocol/WIRE-PROTOCOL.md) | 帧、协商、字段、方向与限额 |
| [原生契约](protocol/NATIVE-CONTRACT.md) | Luvus 校验、handle 与调用顺序 |
| [通道](TRANSPORT.md) | WSS/回环通道、重连与限额 |
| [存储](STORAGE.md) | SQLite、保留期与容量、备份与恢复 |
| [终端执行](TERMINAL-EXECUTION.md) | Connector 本机终端开关与结果语义 |
| [Luvus](LUVUS-OPERATIONS.md) | Luvus 窗口与 Agent 操作 |
| [ADR 0003](adr/0003-bun-toolchain.md) · [ADR 0004](adr/0004-multi-runtime-provider.md) | Bun 工具链、多 runtime provider 的决策理由 |

## 开发与发布

| 文档 | 内容 |
|---|---|
| [开发与验证](DEVELOPMENT.md) | 工具链、构建、测试与固定原生输入 |
| [发行构建](DISTRIBUTION.md) | 单文件构建、tag 门禁与发布资产 |
| [贡献指南](../CONTRIBUTING.md) | 贡献流程 |
| [端到端验收](../e2e/README.md) | 真实 Herdr/Luvus 的验收脚本 |
