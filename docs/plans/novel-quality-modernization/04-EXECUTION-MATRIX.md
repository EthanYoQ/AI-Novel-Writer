# v2 执行依赖、共享所有权与兼容波次

此表是主计划的约束性组成部分，尚不是开发 Spec。计划通过后以各 ID 拆发 Sol/high Spec。`S06`、`S09`、`S10`、`S14` 只是分组，不允许给一个 Agent 下发“全组随便改”。

## 1. 唯一共享 owner

主集成者延续 S01 的集成职责，独占以下**共享接线区**（一个逻辑写入口）：`electron/database.ts` 的 probe/开库/registry 调用、`electron/ipc-handlers.ts`、`electron/preload.ts`、`src/shared/ipc-channels.ts`、bridge 类型声明、`src/services/ipc-client.ts`、`electron/main.ts` 的启动接线及最终 package/lock/release 配置。业务 Agent 只提供模块、类型与接线请求，不并行改这里；主集成者按下表接受并针对性测试，不另起一套框架。

S01 负责新增 schema registry/runner 的接口、版本分配和注册；各 schema 切片拥有自己迁移 function 与 fixture。registry 顺序 C07：M00(S04) → M01(S05) → M02(S08) → M03(S11) → M04(S12)。同一集成 lane 上一次只执行一个迁移集，不向用户发布中间状态。

共享业务文件按下面的入口所有者接力，不能并发编辑。S00 要把这里的锚点展开为实际完整路径；新增路径由 S01 固定。每个 Spec 限一个共享接线请求区，任何额外跨所有权改动先回主集成者拆分/排序。独占模块内可跨多个文件，不以一个物理文件为人为大小限制。

## 2. 可调度 DAG 与独占模块

| ID | 必须已合入并验证的依赖 | 独占模块 / 不包含共享接线区 | 可独立证明的成果 |
| --- | --- | --- | --- |
| S00 | 无 | evidence/fixture 清单、测试环境说明 | 最新入口/消费者/资产、中文 oracle、ABI 命令与实验预算，生产代码零改动 |
| S01 | S00 | 新共享领域类型、schema runner 骨架、ADR；共享接线由集成者落地 | 兼容旧消费者的新增 seam，业务行为不变 |
| S02 | S01 | typed resource parser、protocol/client 适配、全部 URI/UI/bridge 消费点 | 规范 API/URI 可用，旧持久引用只读解析，角色仍只读投影 |
| S03 | S02 | config locator、startup migration coordinator、全局对象迁移/相关 smoke fixture | 两根隔离、一次切换、不丢模型凭据；尚不启用真实作者迁移 |
| S04 | S03 | project-access/storage migration、M00 function、asset/LanceDB 迁移适配 | 冻结 canonical DB 基线与物理转换，合成项目故障恢复；作者开关仍关 |
| S05 | S04 | 主进程 run service/ledger、recovery repository、M01 function、generation runtime/harness core | 持久 root 预算与 CAS 候选的 service fixture；入口尚经 facade |
| S06A | S05 | architecture/characters/directory 命令及结构化规划 helper/测试 | 结构化规划 length/取消/恢复范围覆盖，完整项一次提交 |
| S06B | S06A | generate-draft、batch-chapter、workflow-store、AIOutputPanel 恢复绑定/测试 | 正文、待审批量、自动定稿模式各自不丢稿/不重复 |
| S06C | S06B | review-chapter、refine-from-review 的运行接入（不是语义闭环） | 审修请求归同根，失败候选保存；保留原有合并保护 |
| S06D | S06C | agent-store、Agent generation 工具/start-workflow 的运行接入 | Agent 子任务不能换 session 逃预算，不绕过领域写入 |
| S07 | S06D | 阶段 budget planner、已有模型能力映射、诊断视图/帮助文案 | 数值策略解释、中文长度/范围 early gate；不再改入口终态 |
| S08 | S05 | character-roster schema/repository、M02 function、身份 resolver | 旧姓名数据无损映射 ID，歧义保存为待确认；兼容读 facade |
| S09A | S08、S06A | blueprint-character-sync、目录/角色命令、关系与蓝图解析/提交适配 | 规划提议不自动入 roster，显式批量批准幂等 |
| S09B | S09A、S06B | 定稿/连续性角色关联、import inference/global facts 的 ID 接入 | 确定事实才绑定身份，未知来源不洗白，原子定稿仍成立 |
| S09C | S09B、S06D | 角色 UI/client/Agent roster tool 的 ID/proposal 接入 | 改名/重名 UI 与工具稳定引用，name-only 正式写消费者退出 |
| S10A | S07、S09C | source-selection/ContextSnapshot 纯契约及 fixtures | 无模型即可验证必需覆盖/候选准入/歧义/容量策略 |
| S10B | S10A | chapter-materials、prompt-builder、写/审/修命令材料装配 | 共享证据编译正式启用，中文身份/长设定 early gate |
| S11 | S10B | review/revision repository、M03 function、refinement-completeness、ReviewReport/ThreeWayMerge、相关 store 接入 | 锚点/no-op/复核闭环，定向修稿 early gate，不假绿 |
| S12 | S11、S09C | import ledger/repository/orchestrator/dialog、M04 function | 单完成账本、单取消 owner，派生进度，不删除必要租约/CAS |
| S13 | S12、S07 | 退出台账、无消费者模块/片段、最终残留消费者及限定构建依赖清理 | 全量 lexical+behavior 退出证明；三项 early gate 均达标才开始 |
| S14A | S13 | 确定性集成 fixture/runner、代码证据 | 当前生产入口回归与原稿保护；不等于模型质量 |
| S14B | S14A | 中文对照执行/盲评包 | 完整质量结论 failed/inconclusive/non-inferior/improved，不能只写 passed |
| S14C | S14A | 安装版升级/旧版重开/故障恢复验收包 | 三种迁移结论独立；不碰作者原件 |
| S14D | S14B、S14C | 同 SHA Windows/macOS 资格 receipts | 三平台各自资格，正式发布/merge 仍需新授权 |

安全默认按表拓扑串行。可并行的有限例子：S06A–D 的入口 lane 与 S08 的角色 repository lane（完成 S05 后）；S07 的预算策略与 S09 的角色入口 lane（owner 交接后、无重叠文件）；S14B 模型证据与 S14C 合成升级 fixture（独立数据根/ABI 环境）。S03/S04 接线、任何 schema 注册/开库、最后 package/lock 变更一律串行。

依赖表示**实现与验证已合入**，不是 Agent 说写完；下游记录上游 SHA。已被最新上游修复的工作在同入口复验后跳过，不二次重构。质量失败仅修对应片，不顺手跨层重写。

## 3. 入口波次与兼容态

| 交接点 | 新语义 | 暂存旧边界 | 退出证据 |
| --- | --- | --- | --- |
| S02 | 所有运行调用用 aiNovel API/URI | 持久旧 URI 经单一只读 parser；未迁移磁盘由 locator 分流 | UI 文件类型/只读/历史 tabs/版本比较矩阵 |
| S04 | 合成新项目 canonical M00 | 未显式迁移的旧项目只读 probe；不得偷偷开旧库写 schema | journal + 物理布局 + 受支持旧二进制重开 |
| S05–S06D | Run owner 唯一，四入口波依次接入 | 未接入口通过 facade，用相同根预算/持久 service，不允许第二套终态写者 | 每族真实 renderer→IPC→service→repository fixture |
| S08–S09C | ID 为写入主键，proposal 批准 | name-only 只读/兼容 importer，阶段未接的入口不可绕过 resolver 写事实 | 每个正式写消费者 ID 退出表 |
| S10A/B | 先纯契约再生产编译 | 旧装配器未切换时明确标记；不两套同时装相同事实 | ContextSnapshot include/omit 及生产 prompt 收据 |
| S11/S12 | 审稿/导入各自单一状态 owner | 旧展示字段只读对照派生，删除前做等价表 | 定向 finding 状态、effect ledger、取消一致性 |
| S13 | 正常生产无 Vela API/路径/旧写法 | 仅隔离 legacy import、历史/许可/fixture | inventory 每项 terminal disposition 与消费者为零证明 |

迁移开发启用只限 fixture；发布给作者时所有迁移启用门必须通过，不发布只能打开新格式却不能安全迁移旧小说的半成品。停止一波时保持前一波 service/facade 能通过回归；持久新数据一旦写入，代码回滚不得自动降 schema，需 forward fix 或独立副本导出。

## 4. 每片的必交证据

每个 Sol/high Spec 必须给出：目的/非目标、依赖 SHA、唯一 owner 与禁改共享区、消费契约、完整路径锚点、新增文件标记、步骤、独立 fixture 与可执行命令、故障/回退、中文验收、实际 SHA/命令/退出码/未执行项。不得把“另一个 Agent 会处理”当本片通过证据。

命令以 S00 验证的 Node/Electron native ABI profile 为前提；本计划不凭脚本名声称测过。共享 native 目录不反复重建；无凭据/批准/二进制/平台时标 blocked 或 not-run，不安装替代模型蒙混通过。Agent 不再开子代理，不回滚他人修改，不自行公开 Issue/PR 或执行 release。
