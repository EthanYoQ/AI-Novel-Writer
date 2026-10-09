# Program v2 独立对抗审计：迁移、Issue 与发布轨 delta

## Verdict

**PASS**

Program v1 的 3 个实施阻断 P2 均已关闭；未发现 v2 delta 新增 P0、P1 或实施阻断 P2。`audits/MANIFEST-v2.json` 的 17 个受审文件已复算为 **17/17 SHA-256 匹配**；`dag.json` 可解析为 32 个节点，并明确列出 F05 的三个内部 gate 与 `S13.requiredGates`。

本结论只表示计划具备实施条件，不表示生产代码、真实迁移、产品场景、模型质量、桌面安装、云端资格、正式发布或 Issue 写入已经执行或通过。

## 原阻断逐项关闭

### P2-1：产品 canonical 生命周期 —— 已关闭

**v2 证据**

- `03-ISSUE-CLOSURE.md:32-33` 规定 #187/#219/#221/#224 的 successor 必须是持续 open 的产品问题 canonical，继承 G02 的安装版、公开 Release 和新反例门；代码 child 不能替代，PR 只能用 `Refs`，禁止 `Fixes/Closes` 自动关闭。
- 同处明确 GitHub 多次写入非原子：先建立完整 open successor 并完成双向链接，再归档/缩 scope 旧项；失败时保留或先 reopen 原项，不允许零 open 间隙。
- `03-ISSUE-CLOSURE.md:47`、`specs/G01.md:10-13`、`specs/G02.md:5-11` 同时覆盖 successor 被关闭、删除或缩 scope 后的立即 blocked + reopen/re-home，不再等到计划末尾补救；台账 fixture 必须证明“旧单归档 + child 关闭 + 未发布”仍有产品 canonical open。
- #187 已显式保留 `review-chapter`、`chapter-blueprint-directory`、`chapter-blueprint-directory:compact-single` 和 v1.1.0 后仍复现四项，#229 不能替代；#191 两部分、#221 两症状、#224 双入口继续分别验收。#213 明确保留长期 open。

**反例回放**

若 F04 child 合并后关闭、#224 尚未发布，产品 canonical 仍必须 open；若 canonical 被误关，G01/G02 台账立即 blocked 并先恢复 open 追踪。因此 v1 中“实施 child 关闭后零 open Bug”的路径已被阻断。

**关闭条件结果**：满足。当前裁决仍是 3 项有事实关闭依据、6 项只有完整 successor/双向证据后可行政归档、#213 保留；行政归档不计修复。

### P2-2：M05 staging 与物理提交点 —— 已关闭

**v2 证据**

- `05-INTEGRATION-CONTRACT.md:45-51` 与 `specs/F03.md:9-13` 把运行期 asset commit 和迁移期 M05 分成两个显式入口。
- M05 只能消费 S04 已验证的 `sourceSnapshot/stagingTargetRoot capability`，禁止解析 runtime/default canonical locator；文件、DB 引用和孤儿清单全部写入 staging，在 `target-installed` 前不得创建 live `.ai-novel` 资产，也不得修改/删除来源。
- 文件/引用集合及源/目标字节 hash 进入 S04 journal/receipt；`verified` 后关闭来源、staging DB 和文件句柄再 cutover。S08 还须保留旧资产关联到新 ID 的确定/歧义映射，避免 M02 先删依据。
- F03 必须向 S04 owner/集成者交唯一 runner 适配请求；最终 M05、known donor、unknown fork、姓名碰撞、文件/DB/journal 故障注入和原字节保全均在 S14A 冻结前进入 `project-migration-acceptance`，S14C 不得临时补 tracked 脚本。
- 正文 `merged-md/split-md/txt` 明确不附加头像，未借头像需求发明备份格式。

**反例回放**

若 M05 尝试调用默认 locator，在 `prepared` 阶段写 live 根，合同直接判非法；故障 fixture 还必须证明 `legacy-isolated` 前 live canonical 零创建/零写且只留任务 staging。v1 中崩溃后出现双根/伪目标的路径已被阻断。

**关闭条件结果**：满足。M00→M05 仍是单 registry、单 schema owner、无并行 DDL；unknown fork 和素材原件继续 backup/blocked 而不猜迁。

### P2-3：云端精确发布资产 —— 已关闭

**v2 证据**

- `specs/R01.md:11` 不再用“三个下载链接”作为完成门，而是读取冻结 `subjectSha` 内 `.release/release-profile.json` 的精确 cardinality/name/platform/role；当前明确为 7 项。
- 每项核对 workflow run-attempt artifact ID、大小、按 profile `hashPolicy` 的 hash、下载可用性及 update metadata 的版本/文件/校验引用；缺项、额外旧项、重复项和错误 sidecar 均不得 `published-qualified`。
- `specs/R01.md:8-13` 继续要求 tag 精确绑定经测 `subjectSha`、只提升 S14D 验证的云端同字节产物；artifact 过期回 S14D 在同 SHA 重取完整资格/receipt，tracked 变化则回 S14A，禁止本机重建或旧包顶替。
- promotion 的失败 fixture/工具适配必须在 S14A 冻结前完成，R01 只运行；签名仍按 `allow-unsigned-with-disclosure`，要求 signing receipt 与公开披露，没有新增收费签名门。

**反例回放**

只上传三个 installer、漏 `latest.yml`/blockmap/checksum，或混入额外旧 sidecar，都会在精确集合与引用校验处 fail-closed；过期 artifact 不能被本机新包替代。v1 中不完整 Release 被报告为通过的路径已被阻断。

**关闭条件结果**：满足。

## 新增 delta 的兼容性裁决

### Renderer 外观偏好单 writer —— 通过

- `05-INTEGRATION-CONTRACT.md:7-21` 将 renderer 的旧 theme/ui-version 键一次迁入单一 appearance JSON；theme/ui-version store 只投影、不再各自 persist。main `SkinService` 继续独占 backgroundSkin，renderer 只消费带各自 revision 的快照，不虚构跨进程原子 generation或镜像写入。
- 实施 DAG 的 F01→S03 表示先提供 renderer 合同/接缝，再由 S03 完成 main migration；运行顺序仍是 `mainReady → renderer pending/migrate/ack → App business hydration`。未 ack 不删旧键，损坏/不可用安全回 Classic 且不写默认，S13 只在 ack 后清理已确认键。
- `shellPreference=unset` 与发布默认分离；F05 Preflight 前开发安全默认 Classic，激活 Writer 不物化成作者选择。因此没有侵蚀 C08 的全局启动门、作者显式偏好或单 writer 边界。

### F05 后同 SHA 三道 early gate 复验 —— 通过

- `01-MASTER-PLAN.md:32`、矩阵 `:31-32,58`、C14 `:63-65`、`specs/F05.md:10-12` 和 DAG 一致规定：Preflight → 主集成者激活 Writer 发布默认 → 在同一 `postUiIntegrationSha` 做 F05.Final 与 `early-budget/early-context/early-review` 三道真实双目标复验。
- 三门仍由 S07/S10B/S11 原 owner 执行，必须重建 candidate manifest、做实际双目标零模型 dry-run/parity，并让逐请求 receipt 绑定真实 code/artifact/driver SHA；旧 early PASS、mock 或单臂输出不能继承。
- `S13.requiredGates` 明确依赖 `F05.post-ui-requalification`，所以 S13 不能消费 F04 前的旧证据。所有调用仍进入原 80 次总帽，S00 必须预留；不足只能 blocked/inconclusive，最终 18 章样本不扩张。
- post-UI 三门是阶段资格，不冒充最终 `subjectSha`；S13 后若相关入口/参数再变必须重取相应门，S14A 才核验全部适配并冻结，S14B/C/D 仍只读同一最终 SHA。原冻结链未被旁路。

### 头像附件取消与隐私缓存 —— 通过

- F03 取消对现有正文导出格式附加头像，避免把“作者项目资产”扩成未设计的备份协议；项目物理迁移和受控副本仍保留头像引用/字节，不等于丢资产。
- overview 缓存仍禁止持久化正文尾句/绝对路径、禁止跨项目串读和公开诊断；F02 不带 donor 写缓存实现，F04 使用最终只读来源，S13 只清已确认旧键。没有弱化 C09 的作者数据、恢复候选或偏好保全。

## 非阻断观察

- F01 的“实现依赖”与运行时 `mainReady` 顺序是两层不同关系，当前文字已能区分；实施 receipt 应分别记录 module dependency SHA 与真实启动时序，避免只用纯 parser 测试宣称全局迁移通过。
- post-UI early gate 的预留会压缩原 80 次总账中的修复/重试余量；合同已正确要求 S00 开工即证明最小必需路径可容纳。若实际不可容纳，应缩小可声明结论或 blocked，不能再次扩帽。

## 最终边界

Program v2 可进入后续实施派发。PASS 不授权 GitHub 写入，也不代表 3 个 Issue 已关闭、6 个 successor 已建立、M05 已迁移真实头像、Writer 已激活、模型质量已改善、三平台已 qualified 或 Release 已发布；这些仍必须按各自 Spec 产生实际 SHA、命令、receipt 和失败记录。
