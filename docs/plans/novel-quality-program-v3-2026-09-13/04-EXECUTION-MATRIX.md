# 34节点调度与单一文件所有权

本表为Program v3唯一依赖表：原24片+新增10片（v2八片修订，新增B01/B02）。依赖指已集成且对应门通过的实际SHA/receipt，不是已派发。

| ID | Blocked by | 交付 |
| --- | --- | --- |
| S00 | 无 | 基线、三方差异、Issue与质量预注册 |
| S01 | S00 | 契约、单一共享接线/schema owner |
| G01 | S00、S01 | Issue逐症状修复/增强台账与已交付复核 |
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
| S09B | S09A、S06B | 连续性/导入ID与有出处的自动derived角色演进 |
| S09C | S09B、S06D | 角色UI/Agent身份接缝 |
| S10A | S07、S09C | 上下文选择纯合同 |
| S10B | S10A | 生产上下文与early-context |
| S11 | S10B | 审修闭环M03与early-review |
| S12 | S11、S09C | 导入账本M04 |
| F03 | S12、F01 | 角色头像/展示资产M05 |
| B01 | F03、S12 | 完整项目便携归档/新副本恢复与冻结历史 |
| B02 | B01、S03 | 手动WebDAV不可变世代/分叉与本机安全绑定 |
| F04 | F02、F03、B02、S12 | Writer完整旧/新/增强功能接入与已知缺陷修复 |
| F05 | F04 | 功能并集Preflight→Writer默认→同SHA Final/post-UI三门 |
| S13 | S12、S07、F05 | 消费F05 post-UI新receipt后Vela/无消费者退出 |
| S14A | S13 | 集成/review/工具和版本收口，冻结subjectSha |
| S14B | S14A | 同SHA中文18章双臂质量 |
| S14C | S14A | 同SHA真实升级/旧版重开 |
| S14D | S14B、S14C | 同SHA三个桌面目标资格 |
| R01 | S14D | 批准后的精确产物发布 |
| G02 | R01、G01 | 按实际发布/原问题完整结果关闭并列阻塞 |

## 并行与所有权

沿用原central owner：main/App启动、database/probe/registry、IPC/preload/channels/client/types中央接线、package/lock/build/release配置。业务文件按依赖接力；最多两个不抢文件开发Agent，每个Sol/high不得再开子代理。

| 片 | 独占范围 | 接线/交接 |
| --- | --- | --- |
| G01/G02/R01 | 脱敏台账/稿件/receipt | 远端主线程在执行授权下操作；非worker直接关单/发布 |
| F01 | appearance-profile/bootstrap、theme/ui-version hydration/单writer与tests | main skin/S03；App/IPC集成者 |
| F02 | layout/v2独占壳、pages/v2展示、styles/redesign/合法素材 | props/action slots供F04，不抢业务store/页面 |
| S09B | 原定稿/连续性身份接缝，加C16字段commit-time CAS/来源单调的自动derived更新与拒绝来源去重 | 消费现有outbox/提取结果；新字段由S01统一合同，不私建第二队列 |
| F03 | character-asset service/repository、M05、avatar controller/hooks/tests | S08 ID、S04 staging、B01资产表；central registry/IPC只提请求 |
| B01 | project-archive service/portable格式/字段映射/controller与tests | S04/S05/S09/S10/S12会签身份/来源/当前可读权威/执行冻结；不改正文导出UI，F04接入口 |
| B02 | WebDAV服务、OS秘密store、CloudProjectBinding非密app-data单writer、专用client/contract与网络tests | 接B01产物，不再写DB/迁移；F04接全部UI |
| F04 | EditorArea、编辑/项目转换、共享业务页/设置、CodeMirror、关系图、overview hook与project-peek只读服务 | 原业务/资产/备份网络语义不夺owner；中央IPC由集成者接；按a→g检查点串行 |
| F05 | union证据/browser/Electron fixtures、Preflight/Final与post-UI receipts | 无新业务代码；缺陷退原owner；default由主集成者激活 |
| S13/S14A | Vela/已证实死代码退出、工具/版本/最终review与freeze | F05以后不塞新UI/云功能；影响行为则回对应门重新资格 |

M00(S04)→M01(S05)→M02(S08)→M03(S11)→M04(S12)→M05(F03)同一registry，没有并行DDL。B01默认使用portable格式/sidecar及已批准来源字段，不私增M06；确需schema改变须回S01统一分配、S04更新最终目标并补审，不能冻结后补。

F02可与S03/4并行（只展示）；S06 lane与S08 repository可并行；S14B与C独立根/ABI可并行。B01/B02完成服务接口才进F04最终接线，避免两个agent同时改SettingsModal/EditorArea。F04的a–g是同一owner的串行小提交，主线程可在检查点完成后换worker，但不能并行抢文件。

## 强门

F03.m05-integrated由central/S04 owner集成同一registry M05、头像portable资产处置表与可实际运行validator后出receipt，F03才完成。B01.requiredGates必须消费此门，不能拿“F03交了请求”当最终M05可用。没有新节点或并行DDL；S14C仍在最终subjectSha重跑迁移资格。

F05内部preflight→activate-release-default→post-ui-requalification。preflight必须U01–U16全部Writer动作通过；activation是发布policy=writer，不写为作者选择。Final和原S07/S10B/S11三固定双臂case均为同postUiIntegrationSha，S13.requiredGates强依赖这些新receipt。S00预留原80次总物理调用，不能新增模型帽或按颜色扩18章样本。

S13后若行为改变使相关门过期，回原owner修复/重新资格再S14A冻结subjectSha。S14B/C/D使用同subjectSha只读tracked源；R01提升同字节产物，G02才结案已发布产品问题。G01调查可并行且远端未授权不阻塞本地代码；未解决单项保留open，不占开发agent等回复。
