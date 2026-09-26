# Program v3 全部 34 个 Spec 的现行审查入口

整理日期：2026-09-26。范围为本轮重构的 24 个核心 Spec 和 10 个整合 Spec，不包含独立 DSH 插件或其他路线图。本索引整理已接受的要求，不新增产品范围，也不证明实现、验收或发布完成。

## 使用方法与权威顺序

1. 每项均读下表链接的**原 Spec 全文**，以及[核心 C01–C09](../../plans/novel-quality-modernization/03-CONTRACTS-AND-GATES.md)和 [Program v3 C10–C18 与旧 24 项覆盖表](../../plans/novel-quality-program-v3-2026-09-13/05-INTEGRATION-CONTRACT.md)中适用的条款。表内摘要是定位提示，不删减未列出的义务。
2. 按[交付 delta](delivery-contract-delta-2026-09-21.md)应用明确的替代关系；[现行变更规格](frontend-transition-specs.md)拥有前端、导入、编辑交互及交付出口，[质量协议](quality-protocol.md)拥有实验规则，[ADR 0019](../../adr/0019-remove-real-call-hard-cap.md)、[ADR 0020](../../adr/0020-legacy-project-copy-import.md)分别拥有调用上限调整和完整旧项目导入决定。
3. [实施计划](frontend-transition-plan.md)拥有当前依赖与调度，[执行规则](../../agents/delivery.md)拥有派工、模型和审查流程。冻结 DAG、旧执行矩阵、旧模型禁令和 `NOT STARTED` 是当时的规划，不是当前任务状态。
4. 冻结 Spec 中的拟新增文件和示例命令须映射到实际 owner、消费者和现行入口；名字不同本身不构成缺陷。实际缺少合同要求的行为仍是缺口，不能通过修改规格消除。
5. 实际进度以唯一私有当前检查点及其绑定证据为准；[历史证据索引](evidence-index.md)与日期化 handoff 只证明各自范围。审查启动时固定代码 SHA、比较基线、工作区文档 hash 和未提交排除项，不把后续修改默认为已审。

## 所有审查共同适用的修订

| 主题 | 现行解释与精确来源 |
| --- | --- |
| 产品前端 | 唯一逻辑产品壳为 `writer`，呈现为 PR #262 固定 donor 的 V3 时尚杂志；Classic 只承担历史 baseline/旧偏好兼容，不再要求长期回切或双壳完整资格。现行 F04/F05 取代 C10/C11/C14 及 F01/F02/F04/F05、S14C/D、R01 中冲突的呈现要求。保留全部 153 个 action 的能力与作者外观偏好。 |
| 字数与模型实验 | candidate 逐章采用 ±30% 和 draft-units v3 的舍入；baseline 原代码的 ±20%、历史回执和 FAIL 不改。80 是计划分配额，不是全局硬帽；逐物理请求记账及产品动作的预算保护继续有效。参考臂例外只适用于质量协议明定的形状，不能泛化为所有阶段豁免。 |
| 事实与文学质量 | 事实、必需事件、复述、自然度、节奏、人物动机、独立盲评和不挑优要求保留。技术请求已结算不等于内容合格；修复通过不自动消除历史质量 FAIL。完整实验还须同臂连续三章、固定顺序和真实生产入口。 |
| 旧项目兼容 | ADR 0020 的普通离线**完整项目副本导入**取代 C08/project-storage、S04、F03 旧项目头像迁移、S14C、F05 U10.A11 中原地迁移/源侧 journal/旧根封锁要求。保留源小说及大纲、蓝图、世界观、人物、原文与资产；不经 AI 重建。检测源变化并验证目标，不承诺并发外部写入下原子快照。S03 全局配置迁移与 B01 当前项目归档合同不因本例外被削弱。 |
| 原文查看与编辑 | F05 U15.A02 查看完整原文，仅编辑项目副本，外部原件不变；只存检索片段时明确缺原文，不拼接伪造。编辑后旧索引不参与新检索，按现行 F05 恢复索引，不自动付费重建。 |
| 本地交互 | F05 的 editor-interaction-v2 取代旧 Classic 相对性能及旧绝对门；3000/200000 字两档、输入/选字四格，3 次预热、7 次原始测量，中位数 ≤100ms/最大值 ≤250ms，预览保持开启。精确计时与重跑条件读现行 F05。U06.A03 真实中文 IME 实测按用户指令 `WAIVED_BY_USER`，非 PASS、非阻断；其余编辑保存正确性不豁免。 |
| 冻结及证据复用 | F05 确定性 Final 与完整 S13 后进入 S14A，再做 post-UI；F05 仅缺 post-UI 时为 PARTIAL，但不反向阻断 S14A。消费者未受影响的旧证据保留真实 `testedSha` 和沿用理由；新包仍要自己的来源、hash、安装和启动证据。 |
| 测试与平台 | 普通 UI 用真实组件浏览器；OS、权限、native、恢复事实用对应真实环境。S14C 用确定性状态矩阵加不同恢复语义的真实进程中断，不倍增同义故障矩阵。三目标和签名策略以 [release profile](../../../.release/release-profile.json) 为准；不能以 CI 或脚本单测代替真实包资格。 |

## 核心规格：24 项

| Spec／原合同 | 当前审查重点及适用修订 |
| --- | --- |
| [S00 基线、台账与质量协议](../../plans/novel-quality-modernization/specs/S00.md) | C06/C09、v3 覆盖表、现行质量协议。台账、双目标、唯一物理账本、parity、真实生产 driver 均须按其实际范围审查；历史 S00-scoped PASS 不证明 `full` 已实现。完整阶段接线仍属原必交义务，见现行 S14A/B。 |
| [S01 共享契约与 schema lane](../../plans/novel-quality-modernization/specs/S01.md) | C01–C09、C10/C13/C16/C17、[ADR 0018](../../adr/0018-program-v3-domain-contracts.md)。单一 migration registry、共享 owner、类型到生产消费者的接线；纯契约检查不等于落盘保证。project-storage 按 ADR 0020 解释。 |
| [S02 规范 API 与 URI](../../plans/novel-quality-modernization/specs/S02.md) | C07/C09 及 v3 覆盖表。实际生产消费者走 canonical facade/资源 URI；V3 donor 不带回旧 API，合法 legacy importer 仍可保留旧格式读取。 |
| [S03 全局配置与启动](../../plans/novel-quality-modernization/specs/S03.md) | C08 的全局部分、C10/C11、F01。main 全局迁移/skin/mainReady 与 renderer appearance hydration 各有唯一 writer；旧偏好和作者配置保全。ADR 0020 不取消全局启动保护。 |
| [S04 项目迁移与知识保全](../../plans/novel-quality-modernization/specs/S04.md) | C07–C09、C13/C17，项目迁移路径由 ADR 0020 和现行 F05 A11 替代。完整副本、新身份及内部引用、源变化检测、目标完整性、知识/原文/资产保全；不再要求旧根永久拒写。 |
| [S05 持久生成 owner 与 CAS](../../plans/novel-quality-modernization/specs/S05.md) | C01–C03。根动作/物理 attempt/预算持久化、unknown 不盲重发、候选与 epoch/revision CAS；供唯一 V3 壳读取状态，不增第二 run owner。80 硬帽撤销不撤销产品预算。 |
| [S06A 结构化规划恢复](../../plans/novel-quality-modernization/specs/S06A.md) | C01–C03。架构/角色/蓝图等实际入口接同一 run 与恢复；结构化修复归原根预算，正式提交有持久证据。 |
| [S06B 正文与批量恢复](../../plans/novel-quality-modernization/specs/S06B.md) | C01–C03。流式前缀、候选保存、取消/失败恢复、批量直接前驱和继续生成；UI 终态不能领先持久化。 |
| [S06C 审稿修稿 run 归一](../../plans/novel-quality-modernization/specs/S06C.md) | C01–C03/C05。审稿/修稿入口归原动作与预算，候选及恢复语义保持；与 S11 的 finding/合并/复核合同同时适用。 |
| [S06D Agent 与工具子任务](../../plans/novel-quality-modernization/specs/S06D.md) | C01–C03。Agent/工具生成不旁路父动作、来源准入、预算和用户可见恢复；不借此扩展 DSH 插件范围。 |
| [S07 任务预算、范围与诊断](../../plans/novel-quality-modernization/specs/S07.md) | C01/C06、现行质量协议及 ADR 0019。不同任务预算、能力未知时的行为、范围生成与透明诊断；candidate 字数改 ±30%，物理请求仍逐次结算。 |
| [S08 稳定角色 ID](../../plans/novel-quality-modernization/specs/S08.md) | C04/C08/C13/C16。有来源的身份迁移、歧义拒绝、历史引用、头像到稳定 ID 映射；不按名字相似度猜合并。 |
| [S09A 角色/蓝图 proposal](../../plans/novel-quality-modernization/specs/S09A.md) | C04/C16。身份与关系提议、作者批准及正式提交边界；区别 S09B 已获授权的非冲突 derived 自动更新，不能笼统要求所有字段都手动批准。 |
| [S09B 连续性、定稿与导入身份](../../plans/novel-quality-modernization/specs/S09B.md) | C04/C16。当前权威定稿、来源顺序、字段 CAS；非冲突 derived 自动演进，作者值/非空 legacy 值保全，冲突或身份歧义才提议；不增加独立提取模型调用。 |
| [S09C UI/Agent 稳定引用](../../plans/novel-quality-modernization/specs/S09C.md) | C04/C13/C16。V3 角色、图谱、头像和 Agent 全入口使用稳定 ID；历史边保留与当前活跃投影分开，退役身份不复活。 |
| [S10A 有来源上下文选择](../../plans/novel-quality-modernization/specs/S10A.md) | C02/C03。纯选择、当前候选准入、原文 hash/UTF-16 span、事实来源；首页/图谱/头像信息不得自动塞入 prompt。 |
| [S10B 章节共享证据](../../plans/novel-quality-modernization/specs/S10B.md) | C03/C06。写稿/审稿/修稿共享可复算章节证据；现行质量协议解释历史 revision、参考臂例外和 ±30%。长文截断与上下文复述是不同症状，不能用单一测试互相代证。 |
| [S11 审稿至复核闭环](../../plans/novel-quality-modernization/specs/S11.md) | C05。finding 绑定原文/锚点，实质改稿与 merge、resolved 分开；最多一次绑定合并稿的逐项复核。无法证明解决则 unknown/unresolved/作者决定，不能伪 PASS。历史参考臂特例只按质量协议的加性裁决解释。 |
| [S12 导入 effect ledger](../../plans/novel-quality-modernization/specs/S12.md) | C01/C03/C08/C09。取消/重启/重试、输入来源、单完成账本和真实进度；V3 UI 接原 owner，不引入第二导入状态机。与 A11 旧项目副本导入区别核验，不能互相替代。 |
| [S13 legacy 退场](../../plans/novel-quality-modernization/specs/S13.md) | C09 及现行 S13。独立核心清理先做，UI 清理等 F04/F05 确定性 Final；保留有消费者的 importer/shared/baseline/许可。完整出口不等 post-UI，不以词法零命中为唯一标准。 |
| [S14A 集成与冻结](../../plans/novel-quality-modernization/specs/S14A.md) | 现行 S14A。关键接线、默认、版本、质量/迁移/发布工具先完成；实际双目标 dry-run 后绑定 subjectSha。完整实验 driver 就绪义务不能被 early-budget 局部冻结覆盖。 |
| [S14B 写作质量裁决](../../plans/novel-quality-modernization/specs/S14B.md) | 现行 S14B 和质量协议。三场景×三章×双臂，实际前章给同臂后章，固定交错顺序、oracle 与独立盲评；post-UI 仅在语义/断言/前驱相符时复用。保留失败，不抽样挑优。 |
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
| [F05 全功能与桌面体验](../../plans/novel-quality-program-v3-2026-09-13/specs/F05.md) | 现行 F05、[153-action 冻结并集](../../plans/novel-quality-program-v3-2026-09-13/09-FEATURE-UNION.md)、[证据分层](feature-evidence-levels.json)。能力不删；A11/U15.A02/U06 按明确修订，Final 与 post-UI 分开，IME 豁免单独计数。 |
| [R01 精确产物发布](../../plans/novel-quality-program-v3-2026-09-13/specs/R01.md) | 现行 R01、release profile。实际被测产物、来源/hash/版本/update metadata、双语限制说明和发布授权；Draft PR 不等于发布，未签名按既有 profile 披露而不加购买证书门。 |
| [G02 按交付关闭 Issue](../../plans/novel-quality-program-v3-2026-09-13/specs/G02.md) | C15、现行 G02。逐症状到已发布能力及用户入口证据；只有具备相应授权才写评论/关闭/回读。未发布、未验证或有反例的项保持未结案。 |

## 给代码双审的边界

- **Standards** 审代码质量和仓库规范；坏味道是定位线索，不能把偏好或无消费者的泛化建议当阻断。
- **Spec** 按上述 34 项原合同加现行替代逐项审实现完整性、错误行为和越界；“历史已审”不是本次完整覆盖证明，但无新变更或反例也不重开已关闭 finding。
- 两轴使用同一固定代码范围，分别记录实际覆盖及未审项。测试、脚本、配置和直接合同消费者不能因默认过滤而消失；无关插件不混入本轮。
- 实现审查、确定性测试、真实模型文学质量、安装包资格、提交及发布是不同层次。缺模型/平台证据记待验或阻断，不伪装成代码缺陷；代码无 finding 也不等于产品可发布。
- S00 的完整阶段驱动、S14B 的正式质量、C16 既有提取与 C17/C18 恢复后继续创作证据、S14C/D 的平台资格及 R01/G02 交付须核对启动时的真实状态。full 的规划/正文不代替 C16/C17 的独立操作。不要从“已整理全部 Spec”推导“全部 Spec 已完成”。
