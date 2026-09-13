# 独立对抗计划审计：质量与可执行性 Round 1

审计者：独立质量轨（Sol/high）  
日期：2026-09-13  
范围：完整读取本包 00–06、08、`dag.json`、F01–F05/G01/G02/R01；核对旧 `novel-quality-modernization` C01–C09、Spec v3 执行合同及相关 S03/S04/S08/S12/S13/S14A–D。只做静态计划与必要源码边界核对，未执行模型、Electron、安装版、发布或真实项目。

## Verdict：FAIL

计划方向基本正确，机械 DAG/文件数量/manifest 并非问题；但目前有 3 个 P1 阻断，使计划还不能安全派发。最严重的是：F04 在三道 early gate 之后改写这些门所依赖的实际生产入口，而 S13 可以继续消费旧 SHA 的 early PASS，这直接违反旧 Spec v3 的不继承规则。另有外观偏好迁移/Writer 默认时序没有可执行 owner，以及头像导出要求超出当前正文导出合同且无文件 owner。

修正下列 P1 后可复审；无需重写整体 32 节点架构，也不应扩大模型总帽。

## 阻断发现

### P1-1：F04 之后三道 early gate 失去资格，S13 仍可错误放行

**位置**

- `01-MASTER-PLAN.md:30-32`
- `04-EXECUTION-MATRIX.md:20,26-32`
- `specs/F04.md:3-17`
- `specs/F05.md:10-11`
- 旧 `novel-quality-modernization/05-SOL-EXECUTION.md:57-63`

**反例**

现 DAG 先让 S07、S10B、S11 分别在各自临时 candidate SHA 完成 early-budget/context/review，然后 S12、F03、F04 才接入实际 Writer/Classic 业务页面。F04 明确接管 `EditorArea`、CodeMirror、world-building 恢复入口、批量、角色、ReviewReport/设置等真实动作接缝。这不是与 early gate 无关的纯 CSS 变化。

例如 F04 在移植按钮时漏传 `resumeWorldBuilding`、改变当前 draft/source ID、重复 dispatch，或让审修按钮选错 finding；旧 early 模型样本仍然绿，F05 的确定性 provider/fixture 也不能自动继承旧 SHA 的真实模型结论。当前 `S13` 只依赖 `S12、S07、F05`，没有“F04 集成 SHA 上的三门重新资格”输入，因此可以在旧 early receipt 已过期时继续进入 Vela 退出和 S14A。

旧执行合同已经明确：每次 early 请求绑定该门 candidate SHA，后续改变相关实现不得把旧结果冒充新 SHA 通过（旧 `05-SOL-EXECUTION.md:61-63`）。新包不能以“最终 S14B 还会测”绕过 S13 的前置门。

**最小修订**

在不增加 80 次总帽的前提下，加入一个明确的 post-F04 early requalification 里程碑（可作为 F05 的前置子门，或独立 `E01`，不必重构其他节点）：

1. S07/S10B/S11 原 owner 在 F04 已合入的同一 integration SHA 上各自重建 candidate manifest；
2. 三门重新执行双目标零模型 dry-run/parity，以及各自已预注册的固定中文两臂案例；
3. 所有请求继续计入原 80 次总帽，S00 预算表预留这次必需重跑；不够则 blocked/inconclusive，不扩帽；
4. S13 显式依赖这三份 post-F04 receipt，且 receipt 的 candidate SHA 必须是 F04/F05 接收的集成 SHA；
5. 此里程碑仍不替代 S14B 的 18 章最终双臂。

另一可接受方案是把会改变实际动作/参数的 F04 接线提前到相应 early gate 之前，仅把已证明纯展示的壳层留到之后；以当前 F04 依赖 S12 的定义，不能声称已经采用了该方案。

**关闭条件**

- DAG 和 `dag.json` 中存在可机读的 post-F04 early 依赖；
- owner、candidate SHA、双目标命令、receipt 和 80 次预算来源写清；
- 明确 F05 的 mock/确定性 fixture 不能代替该重跑。

### P1-2：三层偏好迁移没有可执行的持久化/启动 owner，Writer 默认激活时序矛盾

**位置**

- `04-EXECUTION-MATRIX.md:12,49-53`
- `05-INTEGRATION-CONTRACT.md:13-18,41-45,58,66`
- `specs/F01.md:3,8-15`
- `specs/F05.md:3,10`
- 当前 `src/stores/theme-store.ts:132-220`
- donor `src/stores/ui-version-store.ts:12-51`

**代码边界**

颜色/字体当前由 Zustand 写在 renderer `localStorage['ai-novel-writer-theme']`；donor 外壳选择也直接写 renderer `localStorage['ai-novel-writer-ui-version']`。背景 skin 则是 main-process `skin-service` 状态。它们不是一个进程、一个文件或一个启动时点。

F01 只拥有纯解析/兼容模块并明确“不改业务 store”；S03 是 ordinary renderer 启动前的 main-process 全局迁移，文件所有权不含 renderer theme/ui-version storage；F04 到更晚才接页面。计划没有固定 canonical AppearanceProfile 最终放在哪里、谁在 renderer hydration 前读取两个 localStorage 原值、如何把 main skin 与 renderer 偏好合成一次 revision，也没有 `pending/migrated/blocked` 启动状态。Sol 按当前所有权无法同时满足“先迁移再写默认”和“保留显式同值字体”。

同时，F01 写“无旧外壳值用发布默认 Writer”，但 F05 又要求通过后才建议 Writer，默认参数由主集成者在 S14A 冻结前落地。如果 F01/S03 已把“无键”物化为 Writer，F05 之前默认已经启用；若 F01 只返回逻辑 Writer，则 F05/S14A 又缺少明确的激活/回滚状态。这是实际派发时会产生两种不兼容实现的合同矛盾。

**最小修订**

1. 明列每个源键、源进程、canonical target、唯一 writer 与实际文件 owner：shell、theme/font、background skin 分别如何读取和提交；
2. 增加单一 appearance bootstrap 状态 `pending → migrated | blocked`。读取/迁移完成前 App 不持久化默认，不覆盖未知/损坏原值；失败只回安全 Classic 外壳并保留原值；
3. “无旧 shell 键”在 F01 解析阶段产生 `unset`，不是立即写 Writer。Writer 是 release-default activation，由 F05 给出准入 receipt、主集成者在 S14A 前显式开启；F05 失败时仍为 NO-GO/Classic 安全默认；
4. 指定 renderer storage 接线由哪个节点/文件 owner 实施。若 canonical 仍在 renderer localStorage，则不要让 S03 假称 main-process 已完成这部分；若迁入 main config，则定义一次 IPC bootstrap/ack、幂等 revision 和崩溃重启规则；
5. 除纯 parser fixture 外，增加实际 storage hydration 测试：旧 v1/v2、无键、显式默认值、损坏 JSON、localStorage 不可用、main skin 已加载/失败、首次写中崩溃。

**关闭条件**

- F01/S03/F05/S14A 对“解析、迁移、准入、激活”四阶段只有一种解释；
- renderer 与 main 的所有权/顺序可由单个 Sol 片和主集成接线实际执行；
- F05 之前不会因缺键提前把 Writer 写成作者偏好，F05/S14A 后新安装/无明确选择才使用 Writer。

### P1-3：F03 强制扩展头像“导出附件”，与当前范围和文件所有权不一致

**位置**

- `specs/F03.md:3,10`
- `01-MASTER-PLAN.md:14-22` 的“不扩展范围/不建备份系统”决定
- `02-FRONTEND-DECISION.md` 的备份处置
- 当前 `src/services/export-service.ts:28,290-417`

**反例**

F03 要求“导出含资产路径必须稳定；为已实现导出格式加适用附件支持”，但当前导出格式只有 `merged-md | split-md | txt`，语义是导出定稿正文/大纲，不是项目备份；F03 的独占文件也不包括 `src/services/export-service.ts`、`ExportDialog` 或 import/export controller。Sol 要么越权改导出链并发明资源包格式，要么无法完成 F03 的强制验收。

这也会把已经明确裁决为“移除 no-op 备份、不开发新备份系统”的范围重新从头像片带回来。头像作为项目资产必须随项目格式迁移/复制保持引用，但不等于必须进入正文 TXT/Markdown 导出。

**最小修订**

- 把 F03 的硬要求收窄为：项目物理迁移、受控项目副本/导入和 projectId/characterId 变化时资产引用稳定；
- 明确现有正文 `merged-md/split-md/txt` 不新增头像附件，除非另有已经存在且受审的项目归档格式；
- 删除 F03 对正文 export-service 的附件实现/测试要求。将来若用户另立项目备份需求，再单独授权格式、owner 和恢复合同。

**关闭条件**

- F03 可在其列明的独占模块与一个共享接线请求内完成；
- 不再隐式扩建项目备份/归档格式。

## 非阻断建议

### P2-1：壳切换优先保持业务 surface 稳定挂载，避免序列化整个 undo 栈

`specs/F04.md:7` 允许“重挂载后保存 buffer/selection/undo/助手输入”。这可能迫使实现新的编辑器状态序列化层，既过度工程，也更容易在 IME composition 中丢状态。优先把同一 `BusinessSurface/EditorArea` 保持在稳定 React owner/key 下，仅替换 chrome/layout；只对确实无法保挂的少量局部状态做显式持久化。不能通过永久挂载所有页面规避，但也无需重建完整 CodeMirror undo 仓库。

补一个确定性用例：composition 尚未结束时点击壳切换，切换推迟且不会产生半个字符；切回后 undo/selection/未发送助手输入仍在。项目切换也应覆盖未发送助手输入，而不仅是 tab/ledger。

### P2-2：F05 的 20% 延迟线需要先固定测量协议

F05 的性能目标有价值，但单写“同机中位数不恶化超过20%”容易受 warm-up、debug/dev build、计时点和输入长度影响。S00/F05 应冻结 build 类型、样本数、warm-up、计时点、长文 fixture 和置信/噪声处理；没有可靠测量保持 inconclusive，不把一次偶然抖动变成产品功能失败。

## 已确认无需修改的部分

- **F02 最新内核边界通过。** 它限定只移植独占壳/CSS/合法素材，禁止覆盖 command/store/共用业务页；F04 又显式保留 `world_building_partial_result` 与 `synopsisForDraftChapter`。三方 manifest + selective port 是正确方案。
- **F03 身份/资产主体设计通过。** 头像绑定稳定 `character_id`、旧姓名歧义不猜、原字节保全、DB 失败不删旧图、M05 串在 M04 后，符合 C04/C07/C09；本轮阻断只针对导出范围/owner。
- **F04 丢稿要求主体通过。** 项目切换先保存/放弃/取消、失败保持旧项目、旧异步回包隔离、IME 与 ledger 纳入测试，足以修复 donor 的先清 tab 回归；P2 建议只要求更小的实现形状。
- **F05 证据边界通过。** 明确区分 browser、真实 Electron、安装版、确定性 provider 与真实模型；renderer-only 预览/静态按钮不能冒充产品 PASS，备份占位必须移除。
- **范围裁决通过。** 继续使用已有 outline from/to，不新增 `outlineChapterCount`；移除 disabled 备份，不开发新备份系统。
- **最终实验纪律通过。** 18 章双臂、80 次物理请求总帽、baseline/candidate 双执行目标、逐请求 arm/target/driver/fixture 绑定、S14A 后冻结 `subjectSha`、B/C/D tracked 只读与证据不继承均被新包保留。P1-1 修复的是 F04 之前的 early receipt 时效，不要求扩大最终实验。
- **DAG 机械结构通过。** 32 个节点、24+8、无环、M00→M05 顺序与最终 S14A→B/C→D→R01 链成立；当前 FAIL 来自语义依赖缺失，不是节点计数或哈希问题。

## 复审关闭清单

1. 新 DAG 明确 F04 集成 SHA 上的三道 early requalification，并由 S13 强依赖；仍使用原双目标协议和 80 次总帽。
2. F01/S03/F05/S14A 固定 appearance 的 storage owner、bootstrap 状态与 Writer 准入后激活；不存在 F05 前提前写默认。
3. F03 删除正文导出附件扩张，或另获授权并分配明确 owner；本轮推荐删除。
4. manifest 更新并重新冻结修订文件；旧 24 Spec v3/C01–C09 原哈希与最终 subjectSha 规则继续不变。

满足以上三项 P1 后，计划可进入下一轮独立复审；P2 可在同次最小修订中收敛，但不单独阻止 PASS。
