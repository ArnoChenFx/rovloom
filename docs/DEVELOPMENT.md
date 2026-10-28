# 开发与验证

面向贡献者。Rovloom 用 **Bun** 执行与构建。`package.json` 的 `engines.bun` 声明最低版本，依赖用 `^` 范围，`bun.lock` 保证可复现。CI 只跑最新稳定版（[Bun verification](../.github/workflows/bun.yml)），选择依据见 [ADR 0003](adr/0003-bun-toolchain.md)。提交前的约定见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 原生启动验收预算

产品 Gateway smoke 在一个共享的 10 秒单调冷启动期限内等待两个 HTTP 监听器就绪。它不按固定次数重试：快速的连接拒绝不能提前耗尽名义上的就绪预算。现有的 15 秒子进程生命周期仍是外层上限。失败时报告已耗毫秒数与受管子进程是否仍存活，不倾倒其私有配置或输出。

Windows 官方 Herdr attach 测试的预算为 30 秒（冷启动、Win32 身份证明与清理），而不是 Bun 默认的 5 秒。其服务发现使用独立的 10 秒单调启动窗口，并报告冷启动 / 已验证 attach 的耗时。这些只是 fixture 的验收界限，不延长原生请求期限，也不增加写重试。已知的启动失败由 #217 追踪，相关偶发观测见 #249。

## 日常命令

在仓库根目录执行：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
bun run smoke
```

- `bun run format` 与 `bun run lint:fix` 自动修正格式与可修复的 lint 问题。
- `bun run test:protocol`、`bun run test:toolchain` 聚焦运行协议与工具链测试。
- `bun run audit:luvus` 核对固定的 Luvus 原生输入。

Linux x64 的真实断连/重连验收已接入 Bun verification，在构建后运行：

```sh
bun --no-env-file scripts/e2e/connector-disconnect.mjs
```

默认按 dual-role fixture 的官方 Herdr 版本与 SHA-256 pin 下载；离线或复用已有文件可设置 `ROVLOOM_HERDR_BIN=/absolute/path/to/herdr`，同样核对摘要。`LUVUS_TEST_ROOT` 可指定测试私有目录的父目录。验收会停止并重启本轮 Gateway 子进程，检查原生 Connector 的断连诊断与新 ready 行，不使用用户状态或已有原生会话。

`bunfig.toml` 禁止自动读取 `.env` 和依赖安装脚本，子进程也显式传入 `--no-env-file`。`typecheck` 由 Bun 启动 TypeScript 编译器，保留 `strict` 与 `noUncheckedIndexedAccess`；转译不能替代类型检查。

## 构建产物

`bun run build` 先清空 `dist/`，再输出：

- `dist/src/`：各模块的 Bun ESM 入口、共享 chunk 与外部 source maps，依赖外置。入口清单由 `scripts/bun/build.mjs` 维护。
- `dist/webui/`：管理页的 browser target 产物（ESM、HTML、CSS、外部 source maps），不依赖 Node、远端字体或 UI 框架。

原生 schema 编译 Worker 随同一构建独立打包并内嵌锁定的 Ajv，不增加第二运行时、原生归档或 FFI。`bun run smoke` 从产物验证离线编译、请求/错误/结果边界、SQLite 文件重开、service 模块导入，以及 CLI help 与配置模板。

发行用的单文件构建和验收见 [DISTRIBUTION](DISTRIBUTION.md)，输出到 `dist/release/`。CLI 与 Gateway 的接口契约见 [MCP Streamable HTTP](protocol/MCP-HTTP.md) 与 [SERVICE](SERVICE.md)。

## 源码目录

- `src/connector/luvus/`：Luvus 的全部实现——方法表（`methods.ts`）、参数规则（`operations.ts`、`operations-validation.ts`、`parameter-help.ts`）、契约编译与校验（`contract/`）、原生/Wire 适配（`adapter.ts`、`catalog.ts`）与宿主接线（`host/`、`operations-provider.ts`）。
- `src/connector/herdr/`：Herdr 的全部实现（adapter、schema 编译、方法表、安装与来源）。
- `src/connector/{claims,schema-store,terminal-execution}.ts`：两个 provider 实际共用的发送账本、原始 schema 落盘约定与终端开关。
- `src/json/`：provider 中性的有界 JSON 工具。`src/wire/{native,backend}.ts` 是 Luvus 契约内核与 Wire 的接缝和中性原生后端接口；`wire`、`transport`、`storage`、`runtime`、`mcp`、`webui`、`admin`、`service` 按职责划分；根目录的 Store、Router 与协议文件是公共入口。
- `scripts/{luvus,herdr}`：固定版本原生输入的采集、审计和验证工具。`scripts/bun`：构建与 smoke。`scripts/release`：发行。`scripts/webui`：管理页浏览器检查。`scripts/maintenance`：维护脚本。
- `test/`：所有 Bun 回归，由 `bun run test` 执行。`test/fixtures/{luvus,herdr}` 按版本保存协议原文、来源与许可证，`test/fixtures/native-contract` 保存当前映射和矩阵（fixture 名沿用历史命名，被测实现已聚合到 `src/connector/luvus/`）。
- 端到端验收见 [e2e/README](../e2e/README.md)，不属于单元测试门禁。

## 管理页面的隔离验证

`bun run test` 已包含 `test/webui/`。构建后可运行只监听 `127.0.0.1`、随机端口的预览服务：

```sh
bun --no-env-file scripts/webui/preview.mjs
```

日志给出端口。`/` 使用构建后的入口，预览不提供 API，因此显示读取不可用；`/fixtures/` 使用隔离的测试数据，不含真实管理 API、管理员授权或 Connector。它是测试工具，不能用于部署管理页。用 Ctrl-C 关闭。

浏览器检查需要 Python Playwright 与 Chromium。一次运行全部检查：

```sh
bun run build
scripts/webui/check-all.sh [输出目录]
```

`CHROMIUM_PATH` 可指定 Chromium。单项检查为 `scripts/webui/check-{browser,preferences,layout,actions,lifecycle,bootstrap,retry-deadline}.py`，参数 `--url http://127.0.0.1:PORT --output <新目录>`；`actions`、`lifecycle`、`bootstrap`、`retry-deadline` 需要 `preview.mjs <端口> --actions`。输出目录必须是 checkout 外的新目录。

这些检查在真实 Chromium 上验证合成数据的展示、转义、焦点、导航、取消、部分失败、会话失效，两种语言与两种主题，以及桌面和 320px 布局。它们不验证真实管理后端或认证。设计与验收要求见 [GATEWAY-WEBUI](GATEWAY-WEBUI.md)。

## 固定输入与维护用途

| 数据 | 用途 |
|---|---|
| [Luvus 0.14.3 原始采集](../test/fixtures/luvus/0.14.3/linux/manifest.json) | 安装 schema 原文、实时能力、RPC/Host/终端记录、endpoint 与清理断言；测试和审计直接读取 |
| [Luvus 来源](../test/fixtures/luvus/0.14.3/provenance.json) | 官方 release 与 binary 摘要、固定源码 commit、schema 文档对应关系 |
| [覆盖账本](../test/fixtures/native-contract/coverage.json) | Luvus/Wire 测试与审计重算的逐方法基线 |
| [方法映射](../test/fixtures/native-contract/native-method-map.tsv)、[终端映射](../test/fixtures/native-contract/terminal-capability-map.tsv) | 审计用的方法、profile、transport、参数与终端 capability 证据；不是安全分类，也不是生产 allowlist |
| [矩阵](../test/fixtures/native-contract/matrix.json) | 原生测试物化的 seed、变更、生成器及正反断言 |
| [无效 pane](../test/fixtures/luvus/0.14.3/invalid-pane.json)、[失效路由](../test/fixtures/luvus/0.14.3/stale-pane.json) | 从独立原生采集逐字摘取的请求/响应，含 binary/schema 摘要与记录位置 |
| [Herdr 0.9.5 来源](../test/fixtures/herdr/0.9.5/provenance.json) | 官方 release 与 asset、源码 commit、Linux binary 与 schema 的 SHA-256、协议与方言；许可证见同目录 `LICENSE` |
| [Herdr 方法策略](../test/fixtures/herdr/0.9.5/method-policy.json)、[启动输入](../test/fixtures/herdr/0.9.5/agent-startup.json)、[工作流输入](../test/fixtures/herdr/0.9.5/workflow.json) | 静态与合成回归、离线结构校验和回放；策略不授权派发 |

fixture 字节不规范化，捕获中的 session 与路径标记保留原文。`coverage.json` 由 `bun scripts/luvus/audit-fixtures.mjs --write` 从固定原文生成。更新输入时显式生成并审查差异，日常 CI 只重算比对，不修改版本化输入。`dist/`、Python 缓存、工具日志和逐轮验收报告不提交；采集与验证输出写到 checkout 外的全新私有目录。

原生 schema 没有预编译资产：Worker 对每份安装 schema 用锁定 Ajv 完整编译（冷编译约 0.7 秒，接纳期限 10 秒）。运行时检查与失配回退见[原生契约](protocol/NATIVE-CONTRACT.md)。

## 重新采集与原生验证

这些工具面向升级 Luvus/Herdr 版本的维护者，不属于产品运行路径，对应的 Python 单元测试由 [python-tools 工作流](../.github/workflows/python-tools.yml)执行。

升级前先重新核对官方 release、下载摘要与安装契约；工具不会自动下载或升级 binary。

- **Luvus 采集**：按 provenance 核验官方 binary 后，输出到全新目录，不覆盖已提交 fixture。采集器在 `/workspace` 下创建自己的 0700 状态根、named session 与合成终端输入，不继承用户 HOME 或 session；这不是 OS 级沙箱。

  ```sh
  python3 scripts/luvus/collect.py --binary /absolute/path/to/luvus --output /tmp/rovloom-native-new
  ```

- **Herdr 离线审计**：不运行 Herdr、不发现或连接 socket。

  ```sh
  python3 test/herdr/test_contract.py
  python3 scripts/herdr/audit.py test/fixtures/herdr/synthetic
  python3 -B scripts/herdr/audit_methods.py --source-tree /absolute/path/to/pinned-herdr-source
  ```

  `synthetic` fixture 只验证离线工具，其版本、摘要和样本不是安装版的实测证据。`scripts/herdr/collect.py --input <私有导出目录> --output <新目录>` 把预先导出的证据校验后归档（目录 0700、文件 0600，拒绝链接、越界路径与未列文件）。审计通过也不签发执行许可。

- **Herdr 原生验证**：需要获授权的专用临时实例和与 pin 匹配的 binary。

  ```sh
  python3 scripts/herdr/verify_native.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-native-new
  python3 scripts/herdr/verify_readonly.py --binary /absolute/verified/herdr --output /tmp/rovloom-herdr-readonly-new
  ```

  两个命令都在全新私有 HOME/XDG 根启动新的 named session，不接入已有会话，不继承 SSH、模型凭据或用户配置，并在结束时清理自己的进程。`verify_native.py` 核对 binary、契约与订阅边界；`verify_readonly.py` 观察事件保留窗边界与并发刷新。结果只写入输出目录，不生成产品执行许可。

- **Herdr 管理工作流**：`scripts/herdr/verify-runtime.ts` 与 `scripts/herdr/verify-workspace-metadata.ts` 在自有 binary 上验收管理工作流与 workspace 元数据，需显式提供 binary 路径和 checkout 外的新报告路径。

## 范围说明

测试基线是 Linux 原生环境。Bun 的 `process.version` 只是 Node 兼容值，MCP SDK 的协议 revision 由依赖锁定。跨平台、真实双机、NAT/TLS 的验收见 [e2e/README](../e2e/README.md) 与 [Windows e2e](../.github/workflows/windows-e2e.yml)。

SQLite 使用 Bun 的 `node:sqlite`，要求全新库，不迁移旧库。测试使用临时 SQLite 文件。原生接口见[原生契约](protocol/NATIVE-CONTRACT.md)，外层协议见 [Wire v2](protocol/WIRE-PROTOCOL.md)，存储见 [STORAGE](STORAGE.md)，通道见 [TRANSPORT](TRANSPORT.md)，整体设计见 [DESIGN](DESIGN.md)。


### CI 调度

所有工作流的 Bun 安装都使用最新稳定版，外部 GitHub Actions 使用稳定的主版本标签。容器构建使用 `oven/bun:1-slim`，构建与运行阶段共享同一解析出的 Bun 1.x 基础镜像。Bun 验证、Gateway 平台与 standalone 候选构建在每次 PR 更新和推送到 `main` 时各运行一次；普通任务的过时运行会被取消。可复用的 Bun 工作流仍供 Release 使用，其 tag 验证不受此取消策略影响。手动触发（workflow dispatch）仍然可用。

原生 e2e 工作流始终报告一个 planning job 和一份验收汇总。验收 job 还会追加一份由 `scripts/ci/job-timing.mjs` 生成的逐 job 计时报告（等待＝run 创建到 job 开始、运行时长、最慢步骤），使超时与偶发失败的决策基于记录的分段数据而不是印象；该报告仅供观察，永不改变验收结论。产品源码、依赖与构建变更会选中原生验收；仅文档的变更跳过昂贵的 runner job。Planning 使用完整的 base/head Git 差异（包括删除），历史无法检查时也运行验收。被选中的 job 只要失败、取消或跳过，汇总即失败。`two-host acceptance`、`macos acceptance` 与 `windows acceptance` 可用作稳定的必需检查；仓库现有的分支保护不因此变更。

Job 预算：Bun/Gateway 20 分钟、standalone 30 分钟、平台原语 10 分钟、原生 e2e 25 分钟；planning、冻结安装与产物上传各有独立的 5 分钟界限。排队时间不计入 job 超时。用 Actions 的 run 创建/开始时间戳与步骤的开始/结束时间戳来区分排队、依赖下载、编译、原生操作与上传。改动操作期限前先保留失败步骤的证据。只有静态下载有有限重试；原生写入与服务操作不做通用重试。已知的 Intel macOS 启动竞态继续由 #217 追踪。

## 网络重试与偶发观测

CI 的固定 HTTPS 只读下载和 GitHub 元数据读取使用 `scripts/ci/read-network.mjs`：总预算内最多三次尝试、250/500 ms 退避，仅连接故障、408/429/500/502/503/504 和下载中断可重试。超大内容、证书错误、永久 HTTP 拒绝、无效重定向不重试；跨来源去除凭据。摘要校验、文件发布、native 安装/写入、服务控制、配对兑换和业务调用均不包重试，`outcome_unknown` 仍不自动重发。Release 校验的 curl 下载也仅设置两次有限网络重试。

Herdr Worker 样本/编译/打包、Gateway schema 编译、Windows 原生解析器及损坏 cancel 负例的 ready/dispatch/closed 阶段输出固定 JSON 阶段耗时。Linux 全量测试及六平台服务 job 将样本写入 job summary 和 `*-test-phases` / `parser-phases-*` 产物；tee 保留测试退出码，报告和上传失败不改变测试结论。原 Windows 桥的 spawn / first statement / script / exit / close 分段观测继续保留。没有全局延长测试 timeout。#249 复测中，main `12242af` 的 258 次 Luvus RPC 容量回归单独运行 29,969 ms，距 30 秒上限仅约 31 ms；因此仅该长循环 fixture 改为 60 秒，并分开记录 expired/active 两轮耗时。每次 native deadline、断言和调用次数不变。另一轮完整运行捕获 Herdr 生产 Gateway 工厂在 5,510 ms 触到默认 5 秒测试期限，随后共享编译器仍忙导致三个关联失败；该用例增加编译阶段计时，并按产品编译期限 10 秒加测试收尾 5 秒设置外层预算，编译失败也清理 fixture。产品编译期限仍是 10 秒。

macOS 系统服务失败时额外查询一次固定 label 的 `launchctl print`，只输出退出码、stderr 和公开状态字段，过滤环境与完整声明；不会再次执行 stop。Gateway smoke 失败记录自有 child 生命周期、输出字节/摘要和白名单产品错误行，未知输出不公开。#217 仍需实际 Intel macOS 失败样本才能定位；本地 Linux 通过不能证明该偶发已修复。

聚合存储量测命令：`bun --no-env-file scripts/storage/aggregate-benchmark.ts /tmp/aggregate.json`。方法和限制见[报告](performance/249-aggregate-storage.md)。
