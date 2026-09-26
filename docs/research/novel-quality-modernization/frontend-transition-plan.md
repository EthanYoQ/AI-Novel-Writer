# 核心收尾与 V3 接入实施计划

> 执行：主线程用 superpowers:subagent-driven-development 分配独立行为切片；worker 不再派生。全部范围先读[34 项现行 Spec 索引](current-spec-index.md)，变更出口见[现行规格](frontend-transition-specs.md)，不要从旧线程长对话重新规划。

本文件是依赖与执行方法，不是进度表。下列工作包包括已完成的前置工作，接续时只执行唯一私有当前检查点中的未完成项；不得把旧规划基准或本文件列出的步骤当成需要全部重做。

**目标**：停止弃用界面的全量 F05 投入，保留重构内核，接 PR #262 的 V3 时尚杂志，最后集中完成产品资格。
**结构**：当前 command/IPC/数据库为业务基础，只移入固定 donor 呈现；核心可交接与最终可发布分开。
**技术栈**：现有 React/TypeScript、Electron、Zustand、SQLite/native 工具链；无新框架或通用 adapter 系统。
**状态**：READY-FOR-EXECUTION。2026-09-22 基础计划已双审，见[审计记录](frontend-transition-audit-2026-09-22.md)。2026-09-24 完整旧项目副本导入与新版编辑交互预算增量，已由两名独立 gpt-6-sol/high 顾问定向审计通过；旧质量协议引用冲突已修正并定向复验，无未关闭阻断。该结论仅覆盖本轮合同，不表示功能实现或产品资格通过。

2026-09-25 用户批准 A11 普通离线完整导入及 U15.A02 完整原文查看/仅编辑项目副本。本次增量经两名独立 gpt-6-sol/high 顾问定向审计通过：两人均覆盖 ADR 0020、现行规格、计划与交付 delta；发现的旧索引参与新检索及 F05/post-UI 冻结循环依赖已最小修订，由原审计员定向复验关闭。无未关闭阻断，可执行；不表示产品实现或资格通过。具体产品边界由现行规格与 ADR 0020 拥有。

## 接管与所有权

历史规划基准：分支 codex/program-v3-refactor-thread-3，SHA `e9851798b3aeb8c8de5858d9236d3337074430fb`。该 SHA 不是当前 HEAD 或审查终点。接管先读唯一私有检查点并核实际分支/HEAD/dirty，保留其他 owner 未提交工作与私有证据，不 clean/reset/整体 stash、不回退到规划基准。未批准审计提案不能覆盖现行合同。

建议新建干净上下文的执行线程，接同一工作树，不 fork 八小时历史、不重新 clone/搬家。旧线程只留现场与未完成运行信息；换线程是目标切换，不以运行时长推断模型失效。

前端 owner 只负责 F04 呈现与相关 browser tests；核心 owner 只改复现定位的 src/services/generation、workflows 或 electron/controllers、services、repositories 及定点测试；主集成者独占 App/main/IPC、package/lock、release、检查点。共享文件只有一个 writer。

## 依赖顺序

```text
接管 → 核心缺口定位/定点修复 → 核心可交接
  └─ F04 V3薄切片 → 用户一次视觉确认 → F04完整接入
核心可交接 → S13独立核心清理 / S14C准备（可并行）
S14C准备中的A11离线完整复制/目标校验转换 → V3生产导入入口 → 真包A11
核心可交接 + F04完整接入 + A11及其余必需动作证据 → F05确定性Final
F05确定性Final + S13最终清理 → S14A集成/冻结
完整质量/平台driver接线 → 对应S14A冻结；不等待真实模型才能做离线接线
S14A → post-UI + S14B / S14C最终资格（隔离并行）
汇合 → S14D → R01授权发布 → G02授权结案
```

薄切片成功不能掩盖核心阻断；S13 分段不是新增两片，S14C 准备不算最终通过。F05 的模型子门在 post-UI 后补齐；最终发布仍等全部必需门。某质量案例 FAIL 时按已批准纠错路径推进，不盲目重复采样；保持阻断的同时继续无依赖的平台资格、驱动离线接线和代码审查。

U10.A11 按 2026-09-25 决定采用离线完整项目副本导入；U15.A02 按现行规格查看完整原文、只编辑项目副本；U06 沿用 editor-interaction-v2。顾问负责合同及冲突处置，执行主线程负责 owner 分配、实现、定向验证和 PR 同步；无需再向用户询问这两项产品选择。不再等待旧根永久拒写、系统原子快照或旧 Classic 性能基线，其余依赖不变。

## 工作包 1：现场与核心缺口

**路径**：唯一检查点、已有 scripts/f05-u13-history-seal-journey.mjs；实际定位到的 generation-controller.ts、main-generation-owner.ts、workflow-main-generation.ts 及原测试，不要求全改。

- 确认旧线程 idle、子 Agent/进程/fixture 状态，保留未跟踪文件；不重启弃用 UI 全量验收，不强杀正在持久化的实例。
- 对 U13 未稳定终态等问题用 systematic-debugging：记录预期/实际、构建/driver SHA、ABI 和触发步骤，找 UI/driver→command→main→持久化首个偏差。定位前不同时改多层、不反复加等待。
- 真业务 Bug 先最小可失败回归再最小修复；fixture/ABI 错误只修对应层。不能复现就保留缺口，不假修或关闭。
- 针对受影响链路验证，一次独立审查，原 finding 定向复验；按规格四项核心出口更新检查点，不跑旧 F05 全量或把核心通过称为发布完成。

实际入口：pnpm run prepare:native-node；pnpm exec vitest run <定位出的测试文件>；pnpm run test:browser -- <定位出的测试文件>；pnpm run typecheck。按根因选用，不机械跑全部；native 切换用现有脚本串行。纯文档不写产品测试。

## 工作包 2：F04 接入

**路径**：src/App.tsx、src/main.tsx、src/components/layout/v2/ShellV2.tsx、src/components/pages/v2/WelcomePageV2.tsx、appearance stores/profile 与实际移入的 magazine 样式/资源；shared editor/service 只按实际接缝改。

- 固定 donor SHA 并显式 V3；先检查已有本地来源，必要时获取指定提交，不新 clone；保存来源许可，不复制 donor 后端。
- 取得 V3 书架/编辑/角色/设置参考图；先让本项目核心的打开/编辑/保存/重开链在新外壳可用。
- 给用户一个可运行薄切片确认布局/字体；等待时做独立核心工作，不暗中全面移植。
- 确认后按功能组接入剩余能力，在同一 action 覆盖记录写新入口与 current owner；定点测试后一次切片审查。截图只补实际变动。
- F04 出口达到即停止移植，不新增 donor 业务、设计系统、三版本切换或 adapter 框架。

## 工作包 3：F05、S13、候选

**路径**：现有 feature-union 执行输入/检查器、feature-evidence-levels.json、browser/相关 scripts/f05-u*-journey.mjs、S13 原 owner 残留与 release/package 接线。

- F05 改验 V3；153 能力逐项有效覆盖，多个动作共用旅程。旧核心证据带真实 SHA 沿用，旧 UI 证据不能代新接线。
- 按 ADR 0020 复用两版 staging 适配，从 V3 生产入口离线完整复制到独立新项目，检测源变化并校验目标；保全大纲/蓝图/世界观/人物/正文及全部已有项目资料，不调用 AI、不回写源。核对新旧写入隔离、当前 schema、领域引用和故障恢复；synthetic staging 只作局部证据，不继续旧根封锁/VSS/虚拟磁盘实验。
- U15.A02 复用已有查看/编辑/保存路径，只编辑项目副本，按现行规格处理仅存片段和索引待更新状态；定向验证保存重开与外部原件不变，不新增通用编辑器或自动付费重建。
- U06 只适配现有 journey/checker 到 editor-interaction-v2，先核输入事件与界面终态，再跑新版当前包四格响应数据及其他必需的编辑/保存正确性。按 2026-09-25 用户指令跳过 U06.A03 中文 IME 实测，记 `WAIVED_BY_USER`（非 PASS），不作阻断，历史 FAIL 原样保留；其余编辑、保存与响应要求仍必验。旧 Classic 不重采、不改判。新版正式数据按新合同取得，旧诊断额度不延续为新门禁。
- 原生、权限、恢复事实真环境，其余按现有层级 browser/定点验证。共用未变产品包；driver 改变记来源，不为每小脚本重打包。
- 先汇总已有 U06/U11 等行为证据；driver 修后只按实际影响补验，未影响原运行前置/断言/结果解释的证据带原 SHA 和沿用理由保留。缺口进入既有覆盖记录，不因局部阻断或咨询等待停止独立任务。
- Preflight 全过后激活 Writer/V3 正式默认，检查旧偏好与新装，完成确定性 Final，保留待 post-UI。
- S13 先独立核心清理，F04/Final 后做旧 UI 退场；受影响入口复验，保留 importer、baseline、共享组件。
- 最终一次全量回归与集成审查；tracked runner、版本、默认、release 配置就绪后 S14A 冻结。

现有全量入口：pnpm test、pnpm run test:browser、pnpm run typecheck、pnpm run check:i18n、pnpm run build；仅最终候选或足以使旧结果失效时执行。UI driver 先核验参数与新呈现，不能盲跑默认旧皮肤路径。

## 工作包 4：最终资格与交付

完整驱动接线仍是原 S00/S14A 必交项：在既有 runner/bridge 内验证六个同臂持续项目、六次规划/十八章正文、固定顺序和唯一物理账本，再由独立 reviewer 定向审查；同步协议分派后重新绑定相关候选。help、early 三门或模拟章节的成功不能冒充完整正式实验。精确行为与复用条件见现行 S14A/B；不要在这里另订样本或评分规则。

- 按 quality-protocol 实际 CLI 做 baseline/candidate dry-run、必要 post-UI 和最终 18 章；保留原始失败、账本、双臂和独立文学评审。
- 取冻结候选完整旧项目副本导入/目标恢复结论；数据与 native 环境隔离后才能并行模型实验。
- 按 .release/release-profile.json 取得三目标真实包资格，不重复所有文学/组件矩阵；平台或云权限缺口如实记录。
- 已有推送授权内稳定切片可先更新 Draft PR #230，检查整个待公开历史。无 merge/tag/release/Issue 写授权时交具体待授权动作，不阻塞无依赖开发。
- 执行主线程集中同步顾问已批准且已审文档，精确提交并回读 Draft PR；不夹带私有缓存、无关 plugin AGENTS 或全部截图。提前核对模型配置/唯一账本及既有三平台工作流，正式资格仍绑定冻结候选；80 是计划额，签名按 release profile，不新增证书购买门。
- 根据实际发布和原症状证据完成 G02；未发布/未解决保持 open。

## 审查重点与停止条件

1. donor 同名组件带回旧 IPC/store：F04 核对真正消费者，受影响业务定点回归。
2. 换壳卸载编辑器导致 dirty/undo/任务丢失：薄切片/组件回归，F05 实际保存重开。
3. CSS、字体和 portal 混搭挤压：薄切片先确认，后续只检查受影响表面。
4. 旧回执冒充新 UI：F05 核对 shell、入口、driver、真实 SHA，只继承未变核心部分。
5. 恢复/native 缺陷被当作外观问题：核心根因定位，S14C/D 对应真实环境验证。

执行者按适用 Superpowers Skill 自身触发条件工作，现行计划仍是范围与依赖依据，不另订项目总计划。可调最小实现与测试；改变视觉来源、能力、数据/实验合同或发布范围，给顾问一份具体差异。达到出口就推进，不加可选产品门。
