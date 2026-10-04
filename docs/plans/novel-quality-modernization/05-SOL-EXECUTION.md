# Sol/high 通用执行合同

适用以下 24 份 Spec。每次下发必须同时阅读主计划、C01–C09、执行矩阵和本文件。受审 v2 已由两名独立审计者 PASS；实施状态仍为 NOT STARTED。路径均相对**当前选定仓库工作树根**，不是要求另 clone，也不固定依赖本机旧目录。

## 派发模板

> 使用 Sol/high 执行指定的一份 Spec，先读本合同及其引用计划。你不是唯一开发者，不要恢复或覆盖他人的改动；严格守文件所有权。禁止再开子代理。先复核依赖 SHA、最新源码和 CodeGraph root/staleness；索引失配则读当前源码，不自动初始化。只做本片，发现额外问题回报主集成者。不自动 merge、发布、打 tag、关闭 Issue 或改真实小说。完成后交付代码/实际测试/依赖与最终 SHA/未执行项。

这是一份可发布到 GitHub Issue 的本地规格包，本轮未创建 Issues。后续获准发布时，一片一个实施 Issue，正文列 Blocked by（平台支持时同时建原生 dependency）；PR 链接实施 Issue，不用 PR 替代需求。依赖完成前不标 ready-for-agent，根规格不因拆完自动关闭。此文件不授权本轮公开任何资料。

## 开工与唯一共享接线区

1. 保留现有改动；先核对 git status/worktree/latest SHA。不 checkout 覆盖、不清理他人文件、不 git add -A。下游以“依赖已合入且验证”的 SHA 开始，不能只等口头 done。
2. 每片只改自己列出的模块及专属测试；共享区完全由 S01 集成 owner 管理：database 开库/registry、main startup、IPC handlers/preload/channels/client/类型声明、最终 package/lock/release 接线。需要修改时提交一个明确的 shared-wiring 请求（函数签名、调用点、迁移次序和验收），由集成者顺序落地。
3. 新模块路径标“拟新增”；S01 固定实际名称并在模块清单登记，后续直接消费。不建新通用 Agent/事件总线/迁移框架。语言界面改动只增本片需要的中文体验与对应翻译键；本轮场景测试仅中文。
4. 升级功能在 fixture 环境开发。作者数据迁移启用必须等 C08 的物理/旧版证据及总体质量门；不能先发布未兼容中间版。DSH 永远不在本包范围。

## 固定的接入提案（由 S01 登记，不另立事实源）

- 拟新增共享契约：`src/shared/generation-contract.ts`、`src/shared/source-ref.ts`、`src/shared/review-cycle.ts`、`src/shared/project-storage.ts`；按现有类型结构合并亦可，语义须等价。
- 拟新增 schema lane：`electron/migrations/registry.ts`、`electron/migrations/runner.ts`，各切片在同目录提供独立 migration function，注册仅由集成者修改。
- 项目 journal 提案为项目根 `.ai-novel-migration/journal.json`，staging/隔离备份也在该专用目录按 migrationId 分隔，不能随 `.vela` 隔离而失联；现有同名未知资产不覆盖。S01/S04 验证实际平台持久性和路径长度后固定。
- 全局 legacy source 显式注入 `AI_NOVEL_LEGACY_SOURCE_HOME`（旧 `AI_NOVEL_VELA_HOME` 仅兼容 source）；canonical target 为 `AI_NOVEL_APP_DATA_HOME` 或生产默认 appData。隔离测试必须同时设置源/目标并隔离 userData，不暴露或覆盖真实配置。这些变量只用于路径，不承载凭据。
- 项目物理布局与 schema 分离；M00→M04 由同一 registry 升级到当前目标。新 appId 不改变现有安装身份。

## 命令与测试口径

先由 S00 记录：Node/pnpm/Electron 版本、native ABI、依赖目录是否共享、浏览器路径/端口及实际可用 profile。常规脚本在 package.json 中已核对存在；**不代表本轮跑过**。

```powershell
pnpm run typecheck
pnpm run check:i18n
pnpm exec vitest run <本片测试文件>
pnpm exec vitest run --config vitest.browser.config.ts <本片.browser.tsx>
```

各 Spec 下面给出了具体测试目标；标“新增”的文件要在实施时创建，当前还不存在。不能使用 passWithNoTests 掩盖漏跑。Node SQLite/向量测试与 Electron 包装测试分别使用 S00 验证的 ABI profile，必要时在独占工作树使用现有 prepare-native-for-node/electron 脚本；禁止反复重建别人的共享 node_modules。原生错配是环境失败，不当作产品 Bug，也不当通过。

每片至少相关单测 + 受影响生产入口回归 + typecheck；UI 变化另跑中文浏览器用例及 i18n 键完整性。新测试覆盖其 Spec 给出的故障矩阵，不以测试数量/快照存在代替语义。全量、真实模型、安装版、云端资格按 S14 分栏，不要求每片重复全部重测试。

真实模型仅使用当前获准的硅基流动 DeepSeek-V4-Flash 配置；密钥来自已有安全配置，不打印/上传/写入 fixture。只用合成中文小说，总调用 C06 帽内记账，未执行标 not-run。缺模型/平台/权限/安装版则 blocked，不能擅自换供应商、改用户参数或编造结果。

## 最终两臂目标与不可变 subjectSha

S00 必须保留**可再次启动的 baseline execution target**，不只是历史输出或 SHA：主线程优先复用已注册工作树，否则在 owner 仓库 `.worktrees` 准备独立冻结工作树/带哈希构建产物，不另 clone、不 checkout 覆盖当前工作树。manifest 固定代码/产物/driver 哈希、启动命令、Node/Electron/native ABI、生产入口种类、实际隔离 userData/配置/项目根、旧格式布局与安全模型注入方式。基线程序不为迁就候选而改写；不能隔离启动则报告 blocked。

S14A 在**所有 tracked 实验/迁移 runner、协议、smoke、release workflow 适配合入并验证之后**冻结候选 `subjectSha` 与对称的 candidate execution manifest。质量 runner 由 S00 提供，迁移验收 runner 由 S04 提供，最终资格适配由 S13/主集成者提供；缺口只在 S14A 冻结前由原 owner 补齐。baseline target 保持 S00 选定的旧实现；candidate target 必须为本次 subjectSha。数据/receipt 的事后报告提交 SHA 不等于 subjectSha。

`execution-targets.json` 显式包含 baseline/candidate 两个 manifest。runner help 不启动模型；dry-run 零模型调用，但必须实际验证两个 target 可启动、生产入口可达、实际执行路径/产物哈希与 manifest 一致、目标实现不是同一份、数据根互不相交且真实用户目录不被消费。不能只相信调用方传入的 arm 标签。相同目标只允许标记为非资格 placebo 诊断，不能产出改善结论。

两种物理格式的 fixture 由同一不可变中文语义源构建；parity receipt 比较作者动作/章节范围/顺序、brief/原材料、用户可控模板/Skill、模型参数与 oracle，不要求旧新数据库字节相同。编译后的系统 prompt 可作为产品差异，但必须记录各自哈希，不能把不同作者输入当实现收益。正式请求 receipt 绑定 arm、实际 target code/artifact/driver SHA、candidate subjectSha 与 fixture parity ID。

S14B/C/D **只读执行冻结 subject 的跟踪源码**，可产生隔离构建输出/private receipts，不可在该波修改 tracked runner/protocol/smoke/.release/.github。任何 tracked 修改需求先停止→退原 owner→重新 S14A 验证/冻结；旧 B/C/D 证据对新 subjectSha 全部失效，不自动继承，必须在新 SHA 重跑或明确 not-run/blocked，仍受总调用帽。仅报告文件另行提交时记录 reportSha，不冒充产品新 subject。

S14B/C 可并行仅当 subjectSha 相同、runner dry-run 已通过、数据根与 ABI 独立；S14D 只接受同 subjectSha 的 B/C 终态收据。不足以运行 baseline、parity 失败、目标相同、缺同 SHA 收据，只能 blocked/inconclusive/not-qualified。

## 三个 early gate 的直接责任

S07、S10B、S11 的 owner **各自负责**消费 S00 runner/protocol/可执行 baseline manifest，取得主集成者为当前已合入切片生成的临时 candidate execution manifest（实际代码/产物/driver SHA、生产入口、ABI与隔离根），组成该门的双目标清单。S00 在 protocol 冻结三个 phase selector：`early-budget`、`early-context`、`early-review`；分别由 S07、S10B、S11 执行，不能留成未填选择器后声称已测。

每个门先做双目标**零模型** dry-run：实际旧/新目标不同、各自生产入口可达、数据根不交叉、由同语义源构造的 fixture parity 成立；再同时间窗运行预注册两臂案例。每次请求绑定 arm、实际 target code/artifact/driver SHA、parity ID 和该门 candidate SHA。单臂 smoke、同一程序两次、仅 S00 历史输出、baseline 不可用、parity/receipt 缺失都不能标 early PASS。

实际 selector、命令、双 manifests、dry-run/parity 与逐请求 receipts 是三片各自的必交物，不能只引用“S00会做”。盲评资源由主线程派发，worker不再开代理。全部调用仍进入 C06 的同一80次总帽；不足则not-run/blocked/inconclusive，不扩大预算。early结果只覆盖该门当时的SHA，后续改变相关实现不能把旧结果冒充新SHA通过；它不是S14A最终subjectSha，也不替代S14B完整质量结论。

## 每片完成定义与停止

- 代码证据：base/dependency/final SHA、已改路径、生产消费者覆盖、相关命令/退出码/测试数及脱敏 receipts；源码检查、确定性测试、真实模型、安装包分别列。
- 数据证据：新旧 fixture ID/版本/原文哈希、失败后保留位置、候选/正式边界，失败注入点与恢复结果。
- 独立 review 后关闭本片阻断发现再交接。新增跨模块契约/放宽门槛先回主集成者并补审；不自行消化成新框架。
- 没有真实执行的检查不得写 passed。源变化/歧义/高版本库/磁盘失败要保留成果并停相应写入，不拿删除作者资料换成功。
- 持久 schema/格式切换后禁止简单退代码自动降库；forward fix 或明确独立副本导出。迁移前可回旧 adapter，但已产生新数据不回旧快照。
- 提交/推送/Issue/PR 由主线程在相应用户授权下统一做；本计划交付不是远端写入授权。禁止 merge、正式 release/tag/Issue closure 的权限默许。

证据模板：`specId | base/dependency/final SHA | command | exit | scenario | assertion | receipt | pass/fail/blocked/not-run | remaining`。
