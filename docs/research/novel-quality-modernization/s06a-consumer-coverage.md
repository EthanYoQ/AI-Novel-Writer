# S06A 接入台账（代码接线与本机分项验证完成）

依赖 S05：`5c5069673af4d2ef3f8c3e57ac9133e96a898255`。模型调用 0；仅合成 fixtures。代码、IPC 合同测试与真实 provider/安装资格分别计证。

| 入口 | 模板 key | Skill | 源选取 |
|---|---|---|---|
| 全局配置 | generate_global_config | planning | 当前 core、作者 idea 原文、请求章数/字数 |
| 故事前提 | premise | planning | 当前 core、作者 premise 步骤指导 |
| 角色架构 | character_dynamics | planning | 当前 core/角色事实、作者 characters 步骤指导 |
| 世界观 | world_building | planning | 当前 core、worldbuilding 步骤指导；恢复必须精确持久 handle |
| 情节大纲 | synopsis | planning | 当前 core、synopsis 步骤指导；恢复必须精确持久 handle |
| 章节蓝图 | chapter_blueprint_chunk | planning | 目标范围及已有蓝图依赖章号、作者请求范围 |
| 单字段 | generate_novel_config_field | planning | 当前 core；operation 明确字段名 |
| 资料角色提取 | planning_material_character_extraction | planning | 作者选取资料原文（不 trim）及稳定资料 ID |
| 文风分析 | analyze_writing_style | 无（沿用现有行为） | 先读取实际定稿 ID，或原始导入样本字节，再 begin |

资料提示词来自纯 `src/shared/planning-material-prompts.ts`。命令实际解析模板覆盖，原 inline 合同移入单一共享来源；不存在第二套提示词。

目录保留五项语义拆批；移除入口私有 50 章门。200 章合成测试的第 33 次请求被 32 次预算拒绝，仅 1–160 章完整连续项一次提交，161–200 未完成，不能称 200 章成功。`StructuredBatchResult` 失败返回 `validatedItems`，只包括完整合同通过的项，不包括截断 JSON。正式提交的主进程来源 CAS 与恢复后同 root 接线由中央集成验证。

新增 `structured-planning-runtime.test.ts` 使用默认 main helper/transport/facade 与合成 IPC 验证文风源选择和无 handle 恢复拒绝；它不是主进程 SQLite/provider 执行证据。旧恢复测试仍使用注入旧 runtime driver，附合成导航 handle，仅复验旧业务解析/源冲突断言。资料输入使用安全的序号 ID，每个输入保存可逆的 `{fileName,text}` JSON 封装；中文、点号与同名资料均进入真实来源绑定测试。原文件名和正文的 CRLF、首尾空白可逐字还原；来源 hash 是封装字节的 hash，不冒充原文件 hash。

main 分支只保存精确运行导航和既有来源/范围 metadata，不再把 world/synopsis 未完成候选正文镜像写回 partial/core。恢复正文必须来自主进程已确认的 visible composition；无确认组合时即使有 handle 也拒绝自动续写。共享 visible-append-v1 保留原 1600/48 非空白重叠与原文拼接规则，renderer 仍独立去除 thinking 标签。

配置主合同为 structured-data，仅预声明 generate-global-guidance-replacement 的 visible-text 例外；修复仍属于同一 run，不把已解析模型结果转成 authorInputs。工厂旅程测试覆盖一次截断替代、六种坏替代拒绝与单字段指导修复，禁止 renderer provider 调用。

当前局部证据：目录、资料提取、structured batch、bounded completion、配置旅程共 154/154；世界观与 synopsis 旧业务恢复 41/41；默认 main facade 合成 IPC 11/11，其中 world/synopsis acknowledged composition 恢复/无确认拒绝四个反例。纯合并与 draft 旧输出 parity 133/133。以上是合成接口/业务合同证据，主进程 SQLite 持久化与 provider 执行须由中央独立证据覆盖。

中央真实事务与持久预算验证、52 个代码/测试文件的独立审查已完成，详见 [中央证据](s06a-integration-evidence.md)。本片的代码接线完成不等于全部消费者、真实模型或整产品通过；S09 旧名称写入与 S06D 导入恢复的未完成边界保留。

正式提交接线：premise/worldbuilding 使用 db:project-core-commit-generated，synopsis 保留原 expected CAS 并附 generationRunHandle；配置和单字段使用 commitGeneratedNovelConfig，冻结 begin 前作者配置并先保存再更新 UI，不再调用普通 saveProject。独立文风写入使用同一 core guard；导入文风 callback 接收 handle 并由中央导入 effect 事务保存，命令不先另写 core。新增来源拒绝/作者本地草稿变化反例保证不回调或覆盖作者新稿。

真实注册的生成/数据库 IPC 使用实际项目会话与 canonical SQLite 验证：设定或模板改变后拒写，候选仍可读；源文件重读与正式更新位于同一事务。配置和文风统一使用作者草稿前置比较及保存后的逐字段合并；导入 callback 替代直接 core 写入，仍只执行一次 effect。default-main tests 的合成 IPC 证据单独列示，不扩大为数据库事务证明。


目录持久继续接线：提交同时携带原始完整 generationRequestedRange；部分/完整 formal commit 的 generationProgress 由主进程事务产生。工厂每次按作者选择的 operationId 重读主进程进度，沿显式 continuationHandle/run 链找到末端，以 receipt.remainingRange 覆盖 UI 范围；已发行 handle 必须 resume，尚未发行才按 operation 请求同根新 stage。完成末端不能再生成；来源不明、链分歧、循环均拒绝。原节奏指导与作者配置必须从冻结 authorInputs 恢复，旧记录缺项明确拒绝，不默默清空。

DirectoryConfigDialog 显示已保存范围与末端剩余范围，按钮明确沿用原预算。移除 UI 旧 50 章硬门，仅展示大范围可能耗尽预算的提示；200 章意图仍受主进程 32 次总帽。中文 Chromium 16/16（含末端链选择、200 章意图提交）；目录命令/工厂 62/62（含 10/50/200、重启精确 handle、子链已完成范围不重写）。这些证明 renderer 路由与合成合同；真实持久预算/事务范围守卫由中央测试另外证明。

中央目录测试覆盖：正式蓝图与进度同事务回滚、重启同一 root 与原请求计数、32 次额度耗尽后不新建预算、原作者指导字节保留、损坏 epoch 拒绝。读取范围可包含已完成章节作为依赖，正式写入范围则必须等于该续接阶段的 remainingRange；真实命令产生 `[3,1,2]` 的依赖选择可继续第 3 章，而写回第 1–3 章会被拒绝。

世界观/大纲首次中断即显示候选，不再依赖已有正式正文。查看和复制保留原字节；只有确认过的 composition 可续写，按钮展示时的 exact handle 经 launcher 传至工厂，检查点换成另一运行时拒绝。旧镜像、缺 handle 或缺 composition 保留只读候选，续写禁用。中文 Chromium 8/8，使用真实 launcher/factory；未执行模型。
