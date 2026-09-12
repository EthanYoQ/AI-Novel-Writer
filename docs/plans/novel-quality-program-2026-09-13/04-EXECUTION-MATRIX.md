# 完整32节点调度与文件所有权

这是本迭代唯一依赖表。原24Spec加8个新Spec；G/R为治理和对外交付，不属于额外小说生成框架。所有依赖表示已集成并完成本片门的实际SHA/receipt，不是已派发。

| ID | Blocked by | 交付 |
| --- | --- | --- |
| S00 | 无 | 基线、三方差异、Issue与质量预注册 |
| S01 | S00 | 契约、单一共享接线/schema owner |
| G01 | S00、S01 | Issue首批关闭与完整承接归档 |
| F01 | S01 | 经典/写手与旧偏好兼容合同 |
| S02 | S01 | API/URI canonical接入 |
| S03 | S02、F01 | 全局迁移，含外观偏好 |
| F02 | S02、F01 | 纯外壳与CSS/素材选择性移植 |
| S04 | S03 | 项目/资产迁移M00，识别donor变体 |
| S05 | S04 | 持久Run/候选M01 |
| S06A | S05 | 规划入口 |
| S06B | S06A | 正文/批量入口 |
| S06C | S06B | 审修运行入口 |
| S06D | S06C | Agent入口 |
| S07 | S06D | 任务预算与early-budget |
| S08 | S05 | 角色ID M02 |
| S09A | S08、S06A | 角色提议/批准 |
| S09B | S09A、S06B | 连续性/导入ID |
| S09C | S09B、S06D | 角色UI/Agent身份接缝 |
| S10A | S07、S09C | 上下文选择纯合同 |
| S10B | S10A | 生产上下文与early-context |
| S11 | S10B | 审修闭环M03与early-review |
| S12 | S11、S09C | 导入账本M04 |
| F03 | S12、F01 | 角色头像/展示资产M05 |
| F04 | F02、F03、S12 | 新旧共用页面/编辑器/项目切换/设置接入 |
| F05 | F04 | Preflight→默认激活→同SHA Final/三道post-UI复验 |
| S13 | S12、S07、F05 | 消费F05 post-UI新receipt后Vela/无消费者退出 |
| S14A | S13 | 集成/review/工具和版本收口，冻结subjectSha |
| S14B | S14A | 同SHA中文18章双臂质量 |
| S14C | S14A | 同SHA真实升级/旧版重开 |
| S14D | S14B、S14C | 同SHA三个桌面目标资格 |
| R01 | S14D | 批准后的精确产物发布 |
| G02 | R01、G01 | 发布后Issue完成与缺信息收口 |

G01虽可与开发并行，但只能由主线程远端操作；若授权/信息不足，它记录blocked，不阻塞本地S02等代码开发。G02缺信息等待只影响该Issue，不占用开发Agent轮询。

## 文件所有权

沿用原共享owner：database/probe/registry、main、IPC/preload/channels/client/types、package/lock/build/release最终配置。原S06/S09/S11/S12业务文件按原先接力；以下新增加在稳定下游接管，禁止抢改。

| 新Spec | 独占模块/测试 | 不能自改、只提接线请求 |
| --- | --- | --- |
| G01/G02/R01 | 脱敏清单、说明草案、receipt | worker不直接评论/关单/发布；主线程核对后操作 |
| F01 | 拟src/shared/appearance-profile.ts、renderer appearance bootstrap、theme-store/ui-version-store hydration适配与storage fixture | main skin/global迁移由S03；App/init与IPC接线由主集成者 |
| F02 | src/components/layout/v2独占shell、pages/v2展示组件、styles/redesign和合法素材 | App/main/index/共用EditorArea、stores、工作流不得直接覆盖 |
| F03 | 拟character-asset service/repository、migration M05 function、头像hook/controller专属实现和测试 | database/registry/IPC由主集成者；不改角色ID resolver |
| F04 | 接力接管EditorArea、editor/project transition UI、共享业务页和CodeMirror外观/交互适配、relation视图、SettingsModal | 运行/预算/角色事实/审稿repository语义仍原owner；额外行为变更先回原片 |
| F05 | 新两壳fixture、Preflight/Final覆盖清单、post-UI receipt收集 | 无新业务实现；Preflight后主集成者激活默认；原S07/S10B/S11 owners完成post-UI门再交S13 |
| S13/S14A | 最后退出/工具/资格接线与独立review | F05后UI主线停止新增功能；不带未审donor整包 |

F02中的overview只接只读props/共享selector；不把donor自带useProjectOverview写缓存实现原样带入。F04才绑定最终数据源，避免提前偷建第二事实源。

F05内部门为preflight→activate-release-default→post-ui-requalification；最后一步同时完成两壳Final确认，实际candidate SHA在默认激活及所有F04/F05 tracked适配后取得。dag.json有machine-readable gates及S13.requiredGates，三道case仍用early-budget/early-context/early-review selector，milestone=post-ui；S00负责协议/预算预留，原owner负责实际双目标命令、parity、逐请求receipt。不得以mock或旧early报告替代。所有调用共用80总帽，不够则blocked，不增加18章最终样本量。

M00(S04)→M01(S05)→M02(S08)→M03(S11)→M04(S12)→M05(F03)，同一registry；没有并行DDL。布局/素材不需要数据库迁移。

安全并行例：F02独占外壳对S03/04存储；S06入口lane对S08 repository；S14B对S14C（独立根/ABI）。不允许F02和F04同时改共用页面，也不允许PR#223与S13同时删同模块。
