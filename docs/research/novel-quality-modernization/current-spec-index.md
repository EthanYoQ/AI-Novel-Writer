# Program v3 全部 34 个 Spec 的现行审查入口

整理日期：2026-09-26；2026-10-02 纳入[线程 10 交付计划](thread10-delivery-plan.md)，并保留 2026-09-30 材料澄清与 2026-10-01 自主审稿中未被取代的要求。范围为本轮重构的 24 个核心 Spec 和 10 个整合 Spec，不包含独立 DSH 插件或其他路线图。本索引整理已接受的要求，不证明实现、验收或发布完成。

## 使用方法与权威顺序

2026-10-02 用户追加的[模型差异与软件交付规则](thread10-delivery-plan.md#2026-10-02-用户追加模型差异与软件交付)优先适用。替代模型须在同案例真实软件流程通过，才能据此排除该范围的编排问题。直连 API 成功不能替代此条件。文学资格未完成的事实与数据保护要求保留。

1. 每项均读下表链接的**原 Spec 全文**，以及[核心 C01–C09](../../plans/novel-quality-modernization/03-CONTRACTS-AND-GATES.md)和 [Program v3 C10–C18 与旧 24 项覆盖表](../../plans/novel-quality-program-v3-2026-09-13/05-INTEGRATION-CONTRACT.md)中适用的条款。表内摘要是定位提示，不删减未列出的义务。
2. 按[交付 delta](delivery-contract-delta-2026-09-21.md)应用替代关系；[线程 10 交付计划](thread10-delivery-plan.md)拥有采样裁决、实施顺序及其余本次产品增量。[S07 现行增量](../../plans/novel-quality-modernization/specs/S07.md#generic-model-compatibility)独占通用模型兼容和自动参数匹配的详细要求。[现行变更规格](frontend-transition-specs.md)拥有其余前端、导入、交互及交付出口，[质量协议](quality-protocol.md)拥有机器接线说明与历史登记。新要求已生效，但不证明实现或资格完成；旧冻结原文不能否决新要求。[ADR 0019](../../adr/0019-remove-real-call-hard-cap.md)、[ADR 0020](../../adr/0020-legacy-project-copy-import.md)分别拥有调用上限调整和完整旧项目导入决定。
3. [实施计划](frontend-transition-plan.md)拥有当前依赖与调度，[执行规则](../../agents/delivery.md)拥有派工、模型和审查流程，包括 2026-10-01 生效的新建子 Agent 默认继承主线程模型与推理强度。冻结 DAG、旧执行矩阵、旧模型禁令和 `NOT STARTED` 是当时的规划，不是当前任务状态；旧环境快照、handoff 与审查收据中的模型配置只记录历史，不能覆盖现行派工规则。
4. 冻结 Spec 中的拟新增文件和示例命令须映射到实际 owner、消费者和现行入口；名字不同本身不构成缺陷。实际缺少合同要求的行为仍是缺口，不能通过修改规格消除。
5. 实际进度以唯一私有当前检查点及其绑定证据为准；[历史证据索引](evidence-index.md)与日期化 handoff 只证明各自范围。审查启动时固定代码 SHA、比较基线、工作区文档 hash 和未提交排除项，不把后续修改默认为已审。

## 所有审查共同适用的修订

2026-10-04 规划增量按 [S07.M03 有限输出与冻结范围](../../plans/novel-quality-modernization/specs/S07.md#planning-budget-range)、[S06A 逐章大纲与恢复](../../plans/novel-quality-modernization/specs/S06A.md#chapter-planning-recovery)、[S10A 单章选择](../../plans/novel-quality-modernization/specs/S10A.md#planning-chapter-selection)和 [S10B 材料消费](../../plans/novel-quality-modernization/specs/S10B.md#planning-context-consumption)审查。[线程 10 规划工作包](thread10-delivery-plan.md#planning-completion-work-package)拥有实施及验证顺序。该增量不证明已实现，不改变正式文学与平台交付义务。

C01/S07、F05/U03 及全部生成消费者应用 [S07.M01–M04](../../plans/novel-quality-modernization/specs/S07.md#generic-model-compatibility)。高级设置的通用 OpenAI 入口须支持未登记的兼容型号。选模后的容量和思考映射须进入实际请求。未知容量、运行估算和已验证硬上限分别记录；根预算、未知结果及保存保护保留。验收引用 S07.A01–A07，历史冻结仍按原合同解释。

S06B/C、S07、S09B、S10A/B、S11、S00/S14A/B/C 及 F05 的消费者须应用线程 10：补齐审修依据、区分 AI 建议与作者事实，新增自动短细纲及其来源/恢复，接入 candidate-only 多轮资格。保留[AI 自主审稿与作者批准](quality-protocol.md#ai-review-final-manuscript)；人工补题与开发比较不能代替正式闭环，旧诊断成功不填新名额。

2026-10-03 用户补充：F04 吸收 [#309 的章节定位保真要求](frontend-transition-specs.md#chapter-role-preservation)；F05 补[空项目真实创作旅程](thread10-delivery-plan.md#empty-project-real-journey)，涉及 S06A、S09A/B、S10A/B、S11 的实际串联。审稿问题按线程 10 第 3 节及 S07.M05 分开验运行、恢复和审修质量，不因只修运行器而关闭全部问题。2026-10-04 新测试要求[全流程同一模型配置](thread10-delivery-plan.md#single-model-qualification)，采用配置资格只走[现行最小路线](thread10-delivery-plan.md#native-configuration-route)，不要求所有诊断模型通过。相关出口未满足不能称完整 V3 交付。

S06A、S09B、S10A/B 及 S14A/B 继续应用[2026-09-30 材料澄清](delivery-contract-delta-2026-09-21.md#章节材料与生成行为澄清2026-09-30)中未被取代的前驱、共享证据、时间、地点、计划/禁令、完整蓝图与有界续写要求。“新 run 直接正文”已由自动短细纲取代；旧 reconciliation 的身份与恢复保留。全部新增要求须有真实接线和验收证据，实际进度读唯一私有当前检查点，历史失败不改判。

| 主题 | 现行解释与精确来源 |
| --- | --- |
| 产品前端 | 唯一逻辑产品壳为 `writer`，呈现为 PR #262 固定 donor 的 V3 时尚杂志；Classic 只承担历史 baseline/旧偏好兼容，不再要求长期回切或双壳完整资格。现行 F04/F05 取代 C10/C11/C14 及 F01/F02/F04/F05、S14C/D、R01 中冲突的呈现要求。保留全部 153 个 action 的能力与作者外观偏好。 |
| 字数与模型实验 | candidate 逐条采用 ±30% 和 draft-units v3；历史 baseline 的 ±20% 与全部回执不改。80 是计划额，产品预算保护不撤。线程 10 允许有界 API 筛选，独立开发日志不写正式物理账本；正式资格走原生入口和唯一账本，不要求旧参考臂。 |
| 事实与文学质量 | 线程 10 的七案三轮与连续九章按固定批次裁决，C16 另算；每条保留原成文标准与实际 FAIL/INCONCLUSIVE，批次容错、零容忍项及停止规则只读 owner。带问题的保存稿可按预登记继续，不伪定稿。两名独立评审各按案一次读完整闭环，只仲裁分歧；post-UI 保留独有断言，不另叠文学全绿门。另有改善声明才另行比较。 |
| 旧项目兼容 | ADR 0020 的普通离线**完整项目副本导入**取代 C08/project-storage、S04、F03 旧项目头像迁移、S14C、F05 U10.A11 中原地迁移/源侧 journal/旧根封锁要求。保留源小说及大纲、蓝图、世界观、人物、原文与资产；不经 AI 重建。检测源变化并验证目标，不承诺并发外部写入下原子快照。S03 全局配置迁移与 B01 当前项目归档合同不因本例外被削弱。 |
| 原文查看与编辑 | F05 U15.A02 查看完整原文，仅编辑项目副本，外部原件不变；只存检索片段时明确缺原文，不拼接伪造。编辑后旧索引不参与新检索，按现行 F05 恢复索引，不自动付费重建。 |
| 本地交互 | F05 的 editor-interaction-v2 取代旧 Classic 相对性能及旧绝对门；3000/200000 字两档、输入/选字四格，3 次预热、7 次原始测量，中位数 ≤100ms/最大值 ≤250ms，预览保持开启。精确计时与重跑条件读现行 F05。U06.A03 真实中文 IME 实测按用户指令 `WAIVED_BY_USER`，非 PASS、非阻断；其余编辑保存正确性不豁免。 |
| 冻结及证据复用 | F05 确定性 Final 与完整 S13 后进入 S14A，再做 post-UI；F05 仅缺 post-UI 时为 PARTIAL，但不反向阻断 S14A。消费者未受影响的旧证据保留真实 `testedSha` 和沿用理由；新包仍要自己的来源、hash、安装和启动证据。 |
| 测试与平台 | 普通 UI 用真实组件浏览器；OS、权限、native、恢复事实用对应真实环境。S14C 用确定性状态矩阵加不同恢复语义的真实进程中断，不倍增同义故障矩阵。三目标和签名策略以 [release profile](../../../.release/release-profile.json) 为准；不能以 CI 或脚本单测代替真实包资格。 |

## 核心规格：24 项

| Spec／原合同 | 当前审查重点及适用修订 |
| --- | --- |
| [S00 基线、台账与质量协议](../../plans/novel-quality-modernization/specs/S00.md) | C06/C09、v3 覆盖表、线程 10 第 4 节及质量协议。candidate-only 冻结须绑定候选自有模板、round/slot、真实生产 driver 与唯一账本；旧双目标只解释旧 revision。实际接线与验收状态读唯一私有当前检查点及其证据。完整阶段仍是必交项，历史局部 PASS 不证明新阶段就绪。 |
| [S01 共享契约与 schema lane](../../plans/novel-quality-modernization/specs/S01.md) | C01–C09、C10/C13/C16/C17、[ADR 0018](../../adr/0018-program-v3-domain-contracts.md)。单一 migration registry、共享 owner、类型到生产消费者的接线；纯契约检查不等于落盘保证。project-storage 按 ADR 0020 解释。 |
| [S02 规范 API 与 URI](../../plans/novel-quality-modernization/specs/S02.md) | C07/C09 及 v3 覆盖表。实际生产消费者走 canonical facade/资源 URI；V3 donor 不带回旧 API，合法 legacy importer 仍可保留旧格式读取。 |
| [S03 全局配置与启动](../../plans/novel-quality-modernization/specs/S03.md) | C08 的全局部分、C10/C11、F01。main 全局迁移/skin/mainReady 与 renderer appearance hydration 各有唯一 writer；旧偏好和作者配置保全。ADR 0020 不取消全局启动保护。 |
| [S04 项目迁移与知识保全](../../plans/novel-quality-modernization/specs/S04.md) | C07–C09、C13/C17，项目迁移路径由 ADR 0020 和现行 F05 A11 替代。完整副本、新身份及内部引用、源变化检测、目标完整性、知识/原文/资产保全；不再要求旧根永久拒写。 |
| [S05 持久生成 owner 与 CAS](../../plans/novel-quality-modernization/specs/S05.md) | C01–C03。根动作/物理 attempt/预算持久化、unknown 不盲重发、候选与 epoch/revision CAS；供唯一 V3 壳读取状态，不增第二 run owner。80 硬帽撤销不撤销产品预算。 |
| [S06A 结构化规划恢复](../../plans/novel-quality-modernization/specs/S06A.md) | C01–C03。架构/角色/蓝图等实际入口接同一 run 与恢复；结构化修复归原根预算，正式提交有持久证据。 |
| [S06B 正文与批量恢复](../../plans/novel-quality-modernization/specs/S06B.md) | C01–C03、线程 10 切片 B。单章/批量共同路径自动短细纲后写正文，实际产物、来源和调用归原根预算；正文开始后恢复保持原细纲与组合提示身份。流式前缀、保存、取消及直接前驱保护保留，UI 终态不领先持久化。 |
| [S06C 审稿修稿 run 归一](../../plans/novel-quality-modernization/specs/S06C.md) | C01–C03/C05、线程 10 切片 A。审修及复核消费已捕获的前驱、作者事实与目标；作者选择 AI 意见不把建议变成作者事实。普通审稿应用[完整报告提取与错误归因](../../plans/novel-quality-modernization/specs/S06C.md#review-output-reception)，不降低字段或事实要求，也不改历史评分。归原动作和预算，保持 finding、合并、恢复与全章末审边界。 |
| [S06D Agent 与工具子任务](../../plans/novel-quality-modernization/specs/S06D.md) | C01–C03。Agent/工具生成不旁路父动作、来源准入、预算和用户可见恢复；不借此扩展 DSH 插件范围。 |
| [S07 任务预算、范围与诊断](../../plans/novel-quality-modernization/specs/S07.md) | C01/C06、S07.M01–M04、质量协议及 ADR 0019。现行增量拥有移除型号白名单、通用选模、容量资料及思考映射；验收见 S07.A01–A07。短细纲归原根预算；运行估算不冒充硬上限。candidate 字数 ±30%，原生请求逐次结算，API 开发日志单列。 |
| [S08 稳定角色 ID](../../plans/novel-quality-modernization/specs/S08.md) | C04/C08/C13/C16。有来源的身份迁移、歧义拒绝、历史引用、头像到稳定 ID 映射；不按名字相似度猜合并。 |
| [S09A 角色/蓝图 proposal](../../plans/novel-quality-modernization/specs/S09A.md) | C04/C16。身份与关系提议、作者批准及正式提交边界；区别 S09B 已获授权的非冲突 derived 自动更新，不能笼统要求所有字段都手动批准。 |
| [S09B 连续性、定稿与导入身份](../../plans/novel-quality-modernization/specs/S09B.md) | C04/C16。当前权威定稿、来源顺序、字段 CAS；非冲突 derived 自动演进，作者值/非空 legacy 值保全，冲突或身份歧义才提议。线程 10 的细纲不是定稿或可信派生来源；计划不能冒充已发生事实，不增加独立提取调用。 |
| [S09C UI/Agent 稳定引用](../../plans/novel-quality-modernization/specs/S09C.md) | C04/C13/C16。V3 角色、图谱、头像和 Agent 全入口使用稳定 ID；历史边保留与当前活跃投影分开，退役身份不复活。 |
| [S10A 有来源上下文选择](../../plans/novel-quality-modernization/specs/S10A.md) | C02/C03、线程 10 切片 A/B。复用已捕获来源、容量裁决和当前候选准入，补齐审修依据，不在发送时另读未绑定材料。细纲可供正文消费，不是审稿事实证据；首页/图谱/头像信息不得自动塞入 prompt。 |
| [S10B 章节共享证据](../../plans/novel-quality-modernization/specs/S10B.md) | C03/C06、线程 10。写稿/审修共享可复算身份和事实优先级，细纲与实际正文提示绑定；保存前驱可带问题但不得伪定稿。±30% 保留，旧参考臂只解释历史；截断与复述分别验。 |
| [S11 审稿至复核闭环](../../plans/novel-quality-modernization/specs/S11.md) | C05、[现行 S14B](frontend-transition-specs.md#s14b--写作质量与-post-ui)及线程 10 切片 A。finding 绑定原文或明确目标，区分已发生、回顾、计划和本章目标；选择 AI 意见不提升其事实权威。定向复核不替代全章末审；首审发现、误报、修稿及最终质量分列，未解决状态按当前保存稿 hash 对应终局报告判断，不扫描旧 cycle 代判。 |
| [S12 导入 effect ledger](../../plans/novel-quality-modernization/specs/S12.md) | C01/C03/C08/C09。取消/重启/重试、输入来源、单完成账本和真实进度；V3 UI 接原 owner，不引入第二导入状态机。与 A11 旧项目副本导入区别核验，不能互相替代。 |
| [S13 legacy 退场](../../plans/novel-quality-modernization/specs/S13.md) | C09 及现行 S13。独立核心清理先做，UI 清理等 F04/F05 确定性 Final；保留有消费者的 importer/shared/baseline/许可。完整出口不等 post-UI，不以词法零命中为唯一标准。 |
| [S14A 集成与冻结](../../plans/novel-quality-modernization/specs/S14A.md) | 现行 S14A、线程 10 第 4 节。新 candidate-only 机器协议、候选模板、角色配置、细纲/恢复操作及采样身份先接好，再实际 dry-run 并绑定 subjectSha；旧局部冻结不能覆盖新完整阶段。 |
| [S14B 写作质量裁决](../../plans/novel-quality-modernization/specs/S14B.md) | 现行 S14B、线程 10 第 5–6 节。七案三轮、C16 另算、三项目九章合并资格；固定分母与失败保留，带问题保存后按选稿入口继续。post-UI 只补独有断言，不等单轮全绿、不叠文学门；旧相对比较不是必交资格。 |
| [S14C 旧项目与恢复](../../plans/novel-quality-modernization/specs/S14C.md) | ADR 0020、C17/C18、现行 S14C。两旧版资料保全、新旧副本独立、目标恢复、配置/安装与平台证据；局部导入 PASS 不等于安装升级或完整平台资格。 |
| [S14D 三目标桌面资格](../../plans/novel-quality-modernization/specs/S14D.md) | 现行 S14D 与 release profile。Windows x64/macOS ARM64/macOS x64 的实际包、安装启动/native/平台语义，汇合有效 S14B/C。只出资格，不能代 R01 发布。 |

## 整合规格：10 项

| Spec／原合同 | 当前审查重点及适用修订 |
| --- | --- |
| [G01 Issue 实质台账](../../plans/novel-quality-program-v3-2026-09-13/specs/G01.md) | C15。原症状、实际实现、V3 消费者、验证和未覆盖项分别记录；历史 Issue 快照不代表当前远端状态，不能用 commit/测试条数证明症状已解决。 |
| [F01 外观与偏好兼容](../../plans/novel-quality-program-v3-2026-09-13/specs/F01.md) | C10/C11 的现行替代。保全作者字体/主题/缩放/图片皮肤，区分默认与显式偏好；旧 classic/v1/v2 值迁移至唯一 V3 产品，不要求长期双壳开关。 |
| [F02 呈现与资产移植](../../plans/novel-quality-program-v3-2026-09-13/specs/F02.md) | C10/C12、现行 F04。固定 donor V3、来源与许可，复用当前业务内核；新增 donor 业务未被自动批准，不覆盖同名 store/controller/database。 |
| [F03 头像与资产](../../plans/novel-quality-program-v3-2026-09-13/specs/F03.md) | C13，旧项目路径补读 ADR 0020。完整头像能力、安全资产读取、稳定角色 ID、缓存及图谱消费者保留；旧格式资产随完整副本转换，不改原件。 |
| [B01 完整归档与新副本恢复](../../plans/novel-quality-program-v3-2026-09-13/specs/B01.md) | C17。当前项目一致性归档、资产/来源/可读权威、新 projectId/epoch、历史 nonReplayable；不携机器权限/秘密、不重放旧任务。ADR 0020 的离线旧源例外不放宽此路径。 |
| [B02 手动 WebDAV](../../plans/novel-quality-program-v3-2026-09-13/specs/B02.md) | C18。手动不可变完整世代、分叉/持久父世代、新副本恢复、OS 凭据与可见 session-only 降级；首版非 E2E，不做实时同步。B01 管资产/权限，不要求服务支持 CAS 才能备份。 |
| [F04 V3 主入口](../../plans/novel-quality-program-v3-2026-09-13/specs/F04.md) | 全部呈现要求读现行 F04，原业务能力和已知缺陷修复保留。薄切片一次视觉确认、完整业务接线、编辑/任务/保存状态连续；不重做已确认视觉方案。 |
| [F05 全功能与桌面体验](../../plans/novel-quality-program-v3-2026-09-13/specs/F05.md) | 现行 F05、[153-action 冻结并集](../../plans/novel-quality-program-v3-2026-09-13/09-FEATURE-UNION.md)、[证据分层](feature-evidence-levels.json)。U03 按 S07 验证通用选模、参数保存和实际请求。能力不删；A11/U15.A02/U06 按明确修订，Final 与 post-UI 分开，IME 豁免单独计数。 |
| [R01 精确产物发布](../../plans/novel-quality-program-v3-2026-09-13/specs/R01.md) | 现行 R01、release profile。实际被测产物、来源/hash/版本/update metadata、双语限制说明和发布授权；Draft PR 不等于发布，未签名按既有 profile 披露而不加购买证书门。 |
| [G02 按交付关闭 Issue](../../plans/novel-quality-program-v3-2026-09-13/specs/G02.md) | C15、现行 G02。逐症状到已发布能力及用户入口证据；只有具备相应授权才写评论/关闭/回读。未发布、未验证或有反例的项保持未结案。 |

## 给代码双审的边界

- **Standards** 审代码质量和仓库规范；坏味道是定位线索，不能把偏好或无消费者的泛化建议当阻断。
- **Spec** 按上述 34 项原合同加现行替代逐项审实现完整性、错误行为和越界；“历史已审”不是本次完整覆盖证明，但无新变更或反例也不重开已关闭 finding。
- 两轴使用同一固定代码范围，分别记录实际覆盖及未审项。测试、脚本、配置和直接合同消费者不能因默认过滤而消失；无关插件不混入本轮。
- 实现审查、确定性测试、真实模型文学质量、安装包资格、提交及发布是不同层次。缺模型/平台证据记待验或阻断，不伪装成代码缺陷；代码无 finding 也不等于产品可发布。
- S00 的完整阶段驱动、S14B 的正式质量与自主审稿、C16 既有提取与 C17/C18 恢复后继续创作证据、S14C/D 的平台资格及 R01/G02 交付须核对启动时的真实状态。full 的规划/正文/审修不代替 C16/C17 的独立操作。不要从“已整理全部 Spec”推导“全部 Spec 已完成”。
