# S00 实际环境与证据边界

核对日期：2026-09-13（Asia/Shanghai）。本轮采用 Program v3。用户已解除子代理固定使用 Astra/Medium 的限制：主集成者按任务复杂度分配模型和推理强度，最低 Terra/Xhigh；主集成者为 Astra/Xhigh。此前 Astra/Medium 的执行和审查收据保留历史事实，后续任务遵循新下限。冻结计划中的旧模型文字保留，不能覆盖最新调度要求。

## 开发树与基线

当前分支 `codex/novel-quality-program-v3` 从实际 `origin/master` 的 `2264390d6fb8b052cc14736d544df0cc74516649` 开始。该提交已经合并 PR #229，包含交接源 `731bda13ff9197d0abefaa353139df1359ce75cb` 的恢复和提交前源校验修复；无需再次移植。

在确认应用实际分配的开发树、父级 AGENTS 和初始干净 Git 状态之后，执行 `codegraph init <actual-development-worktree>`；CodeGraph 1.5.0 初次索引 879 个文件、13,513 个节点、58,791 条边。随后 `codegraph status <actual-development-worktree>` 返回 `Index is up to date`。实际绝对路径和原始命令仅在本地 `bootstrap.json` 收据中保存。未使用 donor 或父目录的混合索引。

三个规划目录及入口指针共 115 个文件逐字节复制；复制前后现行 v3 的 28 项、历史 v2 的 17 项、基础 Spec v3 的 26 项冻结清单全部匹配。规划检查器的 15 个反例通过，仅表示合同形状通过。

可再次执行的旧实现基线是 owner 仓库 `.worktrees/program-v3-baseline-d103` 下独立注册的 detached worktree，固定在相同旧实现 SHA `2264390d6fb8b052cc14736d544df0cc74516649`。这不是 candidate；真实两臂必须等待对应候选实现并验证生产源码不同。基线不修改 tracked 代码，独立依赖和合成数据；其 `.vibe-owner.json` 记录保留理由、30 日 TTL 与清理命令。现行开发树内缓存位于 `.runtime/.cache/novel-quality-modernization/`。

## 已验证运行环境

| 项目 | 当前开发树 | 冻结基线 |
| --- | --- | --- |
| 操作系统 | Windows x64 | Windows x64 |
| Node / pnpm | Node 25.9.0 / pnpm 11.11.0 | Node 25.9.0 / pnpm 11.11.0 |
| 安装 | `pnpm install --frozen-lockfile`，退出 0 | 同命令，退出 0 |
| node_modules | 本树目录；SQLite 包已逐文件拆除共享硬链接 | 本树目录；SQLite 包已逐文件拆除共享硬链接 |
| 常规数据库 ABI | `pnpm run prepare:native-node` 验证 Node ABI 141 | 桌面 profile 使用 Electron ABI 145 |
| Electron | 锁文件解析为 41.10.7；内置 Node 24.18.0 | `node scripts/prepare-native-for-electron.mjs` 验证内存 SQLite 查询，退出 0 |
| 类型检查 | `pnpm run typecheck` 退出 0 | 同命令，退出 0 |
| 最小中文计数回归 | `pnpm exec vitest run src/shared/__tests__/draft-units.test.ts`，7/7 | 同命令，7/7 |

首次安装后的 Node SQLite 探针出现 ABI 不匹配。后续交叉复验发现，即使 `node_modules` 不是另一树的链接，pnpm 导入的 SQLite 二进制仍共享同一文件标识，链接数为 17；准备 Electron 会使 Node ABI 收据失效。`pnpm install --frozen-lockfile --force --package-import-method=copy --ignore-scripts` 在此环境没有重新导入文件，因此没有把该命令当作隔离成功。

最终仅在两个任务自有 SQLite 包的已验证绝对路径内，对各 50 个硬链接文件进行字节校验的复制及同目录替换，然后准备当前树的 Node ABI。最终两个二进制标识不同、链接数各为 1，Node 141 与 Electron 145 的内存查询分别再次通过；记录于本地 `native-copy-isolation.json`、`native-profiles.json`。这是环境调整，不是产品缺陷。后续切换 ABI 前必须复验实际二进制链接，不能仅检查目录路径；两臂相同 ABI 的资格也须重新准备和冻结，不能继承旧收据。

Playwright 1.59.1 的 Chromium 1217 可启动；纯中文隔离页面文字准确。端口 63513 的本机绑定探针成功，可通过 `AI_NOVEL_VITEST_BROWSER_API_PORT` 指定；端口可用性是该时点的检查，启动时仍须重新占用。浏览器环境探针不包含产品交互或 Windows 原生中文 IME 资格。

## 获准模型的非秘密投影

从已存在的本地配置只读核对以下原字段，未发网络请求、未修改配置、未保存或计算密钥哈希：

| 原字段 | 实际值 |
| --- | --- |
| `provider` | `openai` |
| `protocol` | `openai` |
| `modelName` | `deepseek-ai/DeepSeek-V4-Flash` |
| `baseUrl` 的公开端点 | `https://api.siliconflow.cn/v1` |
| `temperature` | `0.7` |
| `maxTokens` | `16384` |
| `capabilities.maxOutputTokens` | `16384` |
| `capabilities.contextWindowTokens` | `null`，本地配置没有声明 |
| `capabilities.reasoning / structuredOutput / usage` | 均为 `false`，仅表示本地能力声明，未进行提供商实测 |

本地凭据存在，但网络可达性及账户可用性尚未测试。真实执行仅在总账与生产 driver 就绪后使用这份获准配置。S07 必须按未知 usage 的保守 reservation 规则处理，不能据本地声明推断提供商完整能力。当前物理模型调用 **0/80**；头像、前端、归档及 WebDAV 使用无模型 fixture。

## 旧安装版来源

已通过 GitHub 只读接口核对公开正式 Release 和本地 tag 指向；未把源码构建当旧安装二进制。

| 版本 | tag 提交 | Windows 安装资产 | GitHub 声明的 SHA-256 |
| --- | --- | --- | --- |
| [v1.1.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v1.1.0) | `879f83521414f66019488462830c3134c77dc4f8` | `ai-novel-writer-setup-1.1.0.exe`，195153833 字节 | `54b436aeab43a8b00affb768e1db083f3e6b90ef25ebf1cd2dd6779a500c7f88` |
| [v1.0.0](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v1.0.0) | `15e31bb88c462596f28d8e2a46088ecac2da0548` | `ai-novel-writer-setup-1.0.0.exe`，195139528 字节 | `c7392e16ba07011344b079090e13a135a01acfe84eb22d1a7b7d9bb5573b79fe` |

两个 Release 均有 macOS arm64/x64 DMG。以上仅验证资产元数据来源；下载字节、安装、旧版重开/拒绝原根、三个平台升级与发布资格均 **NOT RUN**，分别由 S14C/S14D 验证。

## 隔离与后续门

每次执行同时绑定独立 userData、项目、legacy source、canonical app-data 与收据根。无模型探针不带凭据；实际模型注入不进入 fixture、公开 manifest 或日志。baseline/candidate 的可执行 manifest 记录实际路径并只保存在任务缓存，公开说明只引用安全角色和相对路径。

基线生产入口无模型探针已通过：既有 runtime 干跑，以及 `GenerateDirectoryCommand`、`GenerateDraftCommand`、`ReviewChapterCommand` 三条中文 fixture（3/3）。使用注入的 completion 和 IPC，验证命令可执行及测试断言；这不证明真实数据库、桌面或模型结果。当前入口的 `world-building-recovery.command`、`bounded-completion`、`generate-draft.command` 三文件回归 141/141 通过。

两臂拒绝逻辑、parity 和账本测试由 S00 集成收据登记。真实候选尚未形成，不能把同份旧实现的两个副本作为改善对照。所有 Writer 动作、三道 early/post-UI 模型门、18 章最终盲评、安装、升级、WebDAV、云构建和发布目前 **NOT RUN**。
