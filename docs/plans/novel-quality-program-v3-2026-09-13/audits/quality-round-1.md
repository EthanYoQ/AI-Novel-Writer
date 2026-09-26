# Novel Quality Program v3 独立质量审计（Round 1）

## 裁决

**FAIL / REQUEST_CHANGES**

本裁决只表示冻结的 Program v3 尚不具备安全派发条件，不表示其总体方向错误，也不表示代码或运行测试失败。本轮未运行模型、Electron、生产测试或发布流程。

- P0：0
- P1：3（均为阻断）
- P2：1（非阻断改进）

## 审计边界与完整性

- 已按 `audits/MANIFEST-v3-round-1.json` 逐项计算并核对 26 个受审文件：**26/26 SHA-256 一致**。
- 审阅重点为 `00/01/02/04/05/09/10`、`feature-union.json`、`F01-F05`、`B01/B02` 与 `dag.json`，并按需对照旧 `S09B` 和 ADR-0017；没有重开全仓调查。
- `dag.json` 的 34 个节点 ID 唯一，依赖引用均存在；本轮阻断在语义合同、机器门和所有权，而不是简单的缺节点。

## 阻断发现

### Q1 / P1：C16 缺少字段级提交时 CAS 与派生来源单调序，可能覆盖作者事实或让角色状态倒退

**位置**

- `05-INTEGRATION-CONTRACT.md:77-85`
- `04-EXECUTION-MATRIX.md:23,51`
- `specs/S09B.md` 的角色派生写入责任（并对照旧包 `novel-quality-modernization/specs/S09B.md:20-27`）
- `docs/adr/0017-source-bound-character-state-and-continuity.md:3-7`

**具体反例**

1. 第 11 章定稿产生提取任务，任务观察到角色字段为空或为 derived；任务执行期间作者手工修改该字段。当前合同只要求来源定稿仍有效、作者/legacy 冲突时提案，没有要求在最终写入事务中比较任务观察到的字段 revision/value/provenance。迟到任务因此仍可能把作者刚写的事实覆盖为 derived。
2. 第 12 章的更新角色状态已先落盘；随后第 11 章 outbox 重试。当前合同允许更新“已有 derived”字段，却没有规定仅更晚的规范来源可以替换当前 derived。旧任务可把地点、伤势、关系或身份回退到较早状态，污染后续上下文。
3. 同一章重新定稿后，旧 contentHash 的任务与新任务交错；仅凭 finalizationId/contentHash/source 记录和去重不足以证明旧任务对当前字段仍有写权限。

**为什么阻断**

这是作者数据与小说连续性的安全边界。错误值一旦进入角色真相源，会继续被上下文组装和后续生成消费；“来源可追踪”不能补救已覆盖的作者事实或时序回退。

**最小修订**

- 为每个候选字段携带提取时观察到的 `valueHash/revision + provenance revision`，在同一提交事务中对字段做 compare-and-set。
- 提交时再次验证该 finalization/contentHash 仍是当前权威来源；字段变为 author/legacy、或 revision/value/provenance 不匹配时不得自动写入，只能生成提案或安全拒绝。
- 定义 derived 来源的规范单调序。相同来源和值幂等；仅严格更新的权威来源可替换当前 derived；较旧或已被重新定稿淘汰的来源必须忽略/标 stale。
- 去重键至少绑定 `characterId + field + source finalization/contentHash + proposed value`，不能只去重“处理过某章”。

**关闭条件**

- 合同、S09B 与测试目标明确上述提交时 CAS、权威来源复核和单调序。
- 至少覆盖：提取后作者并发编辑；第 N+1 章先写、第 N 章迟到重试；同章重新定稿；重复 outbox；author/legacy 冲突。所有反例均证明不覆盖、不回退且可追踪。

### Q2 / P1：`feature-union.json` 无法逐动作表达完成证据，且 U16 的机器 owner 与 B01/B02 文件所有权矛盾

**位置**

- `09-FEATURE-UNION.md:3-5,24,28,34`
- `feature-union.json:10-19` 及各 feature 重复的 `actions` / 单一 `status` / 单一 `evidence` 结构
- `feature-union.json:444-472`（U16）
- `04-EXECUTION-MATRIX.md:53-56`
- `specs/F04.md:21`
- `specs/F05.md:5`
- `specs/B01.md:3`、`specs/B02.md:3,18`

**具体反例**

1. U03 同组包含多个 Skill/Prompt 动作，执行者可以只填写一个入口的一份 receipt，再把 feature 级 `status` 标为 PASS；机器结构没有位置证明其他 required action 已执行。文本虽禁止 group-only PASS，验证器却无法从 JSON 区分每个动作的状态、证据和 SHA。
2. U16 同组既有本地归档/恢复，也有 WebDAV 上传/列出/下载/恢复，但机器 owner 只有 B02。执行矩阵又明确本地归档属于 B01、WebDAV 属于 B02，两个 Spec 都限制自身范围。Sol/high 按 manifest 派发时，要么 B02 越权修改 B01 的归档/数据库责任，要么 U16 仍可在 B01 子动作无证据时被整组判过。
3. 类似的跨组件功能若只保留 feature 级 owner，会把“UI owner”“业务 owner”“证据 owner”混为一个字段，后续 F05 无法可靠验证 Writer 中每个旧能力和 donor 实际能力都真实可达。

**为什么阻断**

用户的核心要求是 Writer 自身覆盖旧能力与 donor 实际能力的并集，不能靠 Classic 补缺。当前机器工件允许用一个子动作的成功冒充整组成功，正好会产生“文档宣称全覆盖、实际隐藏或漏掉新功能”的假通过。

**最小修订**

- 将 `actions` 从字符串改为带稳定 `actionId` 的对象；每个 required action 独立记录 `owner/uiOwner`、`requiredInWriter`、`status` 和完整 evidence（Writer entry、handler、IPC、outcome、fixture、integration SHA、receipt）。
- feature 级状态只能由所有 required action 的状态派生，不能手工独立设 PASS。
- U16 按动作分配 B01/B02/F04 所有权；可保留一个协调 owner，但不得替代实施 owner。其他跨 owner 组采用同一规则。
- F05/S00 验证器拒绝 actionId 缺失或重复、任一 required action 证据为空、证据来自 Classic、或一个 receipt 被不相干动作复用。

**关闭条件**

- 机器清单能逐动作表示并验证状态/证据/owner；U16 的本地归档、恢复、上传、列出、下载和远端恢复分别有正确责任人。
- 给出至少一个负例 fixture，证明“只完成组内一个动作并设置 feature PASS”必然失败。

### Q3 / P1：编辑器性能门只有 Writer 相对 Classic 的比例，两个壳共享慢内核时仍会假通过

**位置**

- `02-FRONTEND-DECISION.md:33`
- `09-FEATURE-UNION.md:14`
- `specs/F04.md:13,25`
- `specs/F05.md:8,18`
- `evidence/donor-feature-union.md` 的 N07/N08 编辑器与实时预览证据

**具体反例**

Writer 与 Classic 最终都复用同一个发生回归的 CodeMirror/Markdown 渲染路径：20 万中文单位下 Writer 每次输入 40 ms，Classic 为 42 ms。Writer 满足“不慢于 Classic 20%”并可通过现有相对门，但两者都已经影响连续输入；中文组合输入还可能出现丢字、重复提交或光标/选区跳动。由于两壳共用内核，对照臂无法充当独立的绝对可用性基准。

**为什么阻断**

Writer 必须成为默认完整入口。“不比同样变慢的 Classic 更差”不能证明默认写作入口可用，也不能证明 Issue 的实质修复；纯耗时中位数也不能捕获 IME 数据损坏。

**最小修订**

- S00 在实现前冻结独立于候选结果的绝对编辑可用性门，覆盖 3000/200000 中文单位的真实 production editor 输入、选区和 composition 流程。
- 同时保留现有 Writer-vs-Classic 相对回归门；绝对门至少包含预注册的 median 与 p95/long-task 边界，以及中文 composition **零丢失、零重复**、选区/光标/undo 保持。
- 阈值须在看候选结果前由产品可解释目标或冻结基线确定，不能由实施者事后挑选；测量不得使用 mock/dev editor、Classic 替代 Writer，或通过关闭实时预览来过门。

**关闭条件**

- S00、F04/F05 与 U06 的机器协议都引用同一个冻结绝对门，并保留相对门。
- 存在负例证明“两壳同慢”“IME 丢字但耗时合格”“关闭预览后变快”均不得 PASS。

## 非阻断建议

### N1 / P2：将 WebDAV 不可变 generation 设为真相，`latest` 仅作可选提示

**位置**

- `05-INTEGRATION-CONTRACT.md:101-109`
- `specs/B02.md:13-15,22-29`
- `01-MASTER-PLAN.md:44`

不可变、唯一命名且带校验的 generation 已能避免远端覆盖；当前又把可靠 CAS 更新 `latest` 设为可用性前提，会无谓拒绝不支持条件写的常见 WebDAV 服务。最小调整是以验证通过的 generation manifests 列表为唯一真相，`latest` 只在服务支持安全 CAS 时写作缓存/提示；不支持时仍可列出并让作者明确选择版本，且始终禁止 last-write-wins 覆盖。此项改善兼容性，但不单独阻断 v3 的规划可派发性。

## 已确认未退让的核心边界

- 头像在 C13、F03、U10、B01 与 F05 中仍是硬性 MUST，包含稳定 ID、资产生命周期、项目迁移/归档恢复与 Writer 验收；未发现以删除头像来过门。
- Writer 被明确要求独立承载旧能力与 donor 实际能力并集，Classic 不能补缺；默认激活在 Preflight 后、Final 和 post-UI gates 前，方向正确。
- Issue 关闭要求生产入口、持久化、重启/切项目/恢复及负例证据，不允许静态存在或 renderer-only 预览冒充通过。
- 原 18 章、80 次真实模型调用总帽、双目标、同 integration SHA、subjectSha 冻结和修改后重新资格规则仍被保留；新增 UI/备份工作未增加模型调用帽。
- B01/B02 仍限定为本地便携归档与手动 WebDAV，没有扩张为实时同步、多平台或新的备份服务。

## 通过条件摘要

下一轮仅需按新的冻结 manifest 复核三项 P1 是否被合同、Spec、机器清单和负例共同关闭，并确认修订未破坏头像、Writer 默认完整入口、80 次总帽和同 SHA 资格链。P2 可同时采纳，但不作为单独 PASS 前提。
