# Program v1 独立对抗审计：迁移、Issue 与发布轨

## Verdict

**FAIL**

未发现 P0/P1；发现 **3 个实施阻断 P2**。它们均可通过局部合同补句关闭，不要求新增通用框架、扩大模型调用或增加收费签名门。

本结论只审计划是否具备安全实施条件。`audits/MANIFEST-v1.json` 的 17 个文件已复算为 **17/17 SHA-256 匹配**；原 C01–C09、Spec v3 冻结/双目标/80 次总帽及旧 26 文件包按主线程提供的未变边界合读。本轮未执行生产实现、真实项目迁移、模型、安装版、云端资格、发布或 GitHub Issue 写入。

## 阻断发现

### P2-1：行政归档只约束 successor 在归档瞬间 open，尚不能保证 user Bug 到发布前始终有 open canonical

**证据**

- `03-ISSUE-CLOSURE.md:27-30` 和 `specs/G01.md:7-10` 已正确要求：六个旧项只有完整 open successor、逐症状 owner/验收、双向链接后才可按 `not_planned` 行政归档。
- `03-ISSUE-CLOSURE.md:43-45` 与 `specs/G02.md:5-11` 又正确规定 user Bug 的 `completed` 需要实际修复、产品/安装证据及公开 Release。
- 但 successor 可以是“Spec 任务/实施 Issue”，当前文字只要求它在原单归档时仍 open，没有明确规定 #187/#219/#221/#224 的**产品 canonical successor 必须一直 open 到 G02 发布门**；也没有规定 successor 后来被缩 scope、按代码边界关闭或删除时如何立即恢复 canonical。

**可失败反例**

1. G01 为 #224 创建一个 F04 实施 Issue，写了双入口验收并双向链接，于是将原 #224 行政归档。
2. F04 合并后，实施 Issue 按“代码已完成”关闭；此时还没有 S14C/D、R01 Release，最新公开版本仍可能白屏。
3. G02 虽会在最后复读，但在 W3 到 W6 之间两个 Issue 都已关闭；新复现没有明确 open canonical，公开列表看起来像 Bug 已解决。#187 的 review/blueprint 多入口也可因只把 #229 或某一实现片当 successor 而丢掉剩余症状。

**最小修正与位置**

在 `03-ISSUE-CLOSURE.md §2`、`specs/G01.md` 验收和 `specs/G02.md` 各补同一条生命周期约束：

- #187/#219/#221/#224 的 successor 必须是**产品问题 canonical**，继承 G02 的“适用安装版 + 公开 Release + 无新反例”关闭门，并在该门前保持 open；代码实施 Issue/PR 可以作为 child，但不能单独替代产品 canonical。
- successor 被关闭、删除或缩 scope 前，必须先让原 Issue reopen，或原子地建立另一份完整 open canonical 并完成双向链接；否则停止后续行政归档并把台账标 blocked。
- #187 successor 的症状表至少显式保留现有诊断中的 `review-chapter`、`chapter-blueprint-directory`、`chapter-blueprint-directory:compact-single` 及 v1.1.0 后“仍复现”，分别落到诊断/规划/审稿/预算 owner；不能把 S10 或 #229 的世界观局部修复当全部承接。#221 继续保持“多余角色”和“跨章重复”两个独立验收项，不预判同根因。

内部窄合同 #211/#222 可以继续采用计划已写明的代码完成边界；#191 feature 与 #213 长期路线不伪装成 user Bug completed。

**关闭条件**

上述三处文字一致；构造“原单已归档、实施 child 已关闭、未发布”的台账 fixture 时，必须得到 `blocked + reopen/re-home required`，不得得到零 open canonical。

### P2-2：M05 说明了 schema 顺序和原字节保全，但未明确禁止 migration function 在物理 cutover 前写 live `.ai-novel` 根

**证据**

- 原 C07/C08 要求 S04 在 staging 中运行唯一 registry，并按 `prepared → verified → legacy-isolated → target-installed → switched` 切换；`verified` 前来源仍唯一活动，目标不能被正常发现。
- 新 `05-INTEGRATION-CONTRACT.md:29-33` 正确把名字 hash 迁为稳定 `character_id`、把 M05 排在 M04 后，并规定 known fingerprint 才转换、unknown fork 隔离保全。
- `specs/F03.md:5-9` 同时描述运行期头像 commit（安装文件后事务更新引用）和 M05 迁移，但没有明确区分两种写根：M05 必须只写 S04 提供的 staging capability，不能调用默认 locator 提前创建 live `.ai-novel/avatars` 或打开活动 canonical DB。

**可失败反例**

M05 复用运行期 `character-asset-service` 的默认项目 locator。迁移仍处于 `prepared` 时，它先在 live `.ai-novel/avatars/<character_id>` 安装文件，随后 DB 回填失败或进程崩溃。此时 journal 仍认为旧 `.vela` 唯一活动，但新根已经存在；重启可能进入“双根/目标似乎已安装”分支，或把本次孤儿误当用户已有目标。原头像字节即使还在，C08 的物理事实判据已被破坏。

**最小修正与位置**

在 `05-INTEGRATION-CONTRACT.md §C13` 与 `specs/F03.md` 的 M05 步骤补充：

- 运行期头像 commit 与迁移期 M05 是同一资产规则的两个显式入口；M05 只能接收 S04 验证过的 `sourceSnapshot` 和 `stagingTargetRoot/capability`，禁止解析默认/活动 canonical locator。
- M05 产生的头像文件、引用回填和孤儿清单全部位于 staging；不删除/改写来源，不在 `target-installed` 前创建 live `.ai-novel` 资产。文件/引用集合、源/目标字节 hash 进入 S04 journal/验证 receipt；源、staging DB 和文件句柄在 `verified` 后关闭再 cutover。
- F03 向 S04 owner/主集成者交一个明确 runner 适配请求；S14A 冻结前，`project-migration-acceptance` 必须以最终 M05 目标覆盖 donor known variant、unknown fork、姓名碰撞、DB失败/崩溃和原字节保全。不得由 S14C 冻结后临时补脚本。

这只是收紧既有 S04 staging 与单 registry，不是第二套迁移框架。

**关闭条件**

故障 fixture 在 M05 每个文件/DB/journal 注入点中证明：`legacy-isolated` 前 live canonical 根零创建/零写；失败只留下可识别的任务 staging，来源和未知素材原件 hash 不变；最终 acceptance runner 的 tracked 适配在 S14A 前完成。

### P2-3：R01 的“3 个下载链接”与当前 release profile 的 7 个精确资产合同不一致

**证据**

- `specs/R01.md:5-11` 已正确要求同一 S14A `subjectSha`、S14B/C/D 同 SHA receipt、tag 精确绑定被测提交、只提升 S14D 验证的 GitHub Actions 同字节产物，且签名严格遵循 profile 的 `allow-unsigned-with-disclosure`。
- 但 `specs/R01.md:11` 只写“检查三个下载链接/文件 hash/update 元数据”。当前 `.release/release-profile.json` 的 `releaseAssets` 是 **7 项**：Windows installer、blockmap、`latest.yml`、两个 macOS DMG、两个 DMG checksum sidecar。

**可失败反例**

R01 上传并验证 Windows/macOS 三个 installer，tag 和这三个 hash 都正确，但漏掉 `latest.yml`、blockmap 或两份 checksum。按“三个下载链接”可以被报告为发布通过，实际自动更新或公开校验链已断；反过来，上传了未经 S14D manifest 验证的额外同名/旧 sidecar 也可能未被拒绝。

**最小修正与位置**

把 `specs/R01.md:11` 的固定“三个下载链接”改为 profile 驱动的**精确资产集合**：

- 从冻结 subject 中的 `.release/release-profile.json` 读取期望 cardinality/name/platform/role；当前为 7 项，但不把 7 永久硬编码成未来协议。
- Release 回读必须逐项核对 workflow run-attempt artifact ID、文件名、大小、按 profile hashPolicy 计算的 hash、平台/角色、下载可用性和 update metadata 引用；缺项、额外项、重复项或 sidecar 指向错误版本一律不 published-qualified。
- 若资格 artifact 因 retention 过期，不用本机重建或旧包顶替；回 S14D 在同 `subjectSha` 重取云端 artifact/receipt，并以新一组完整 hash 作为唯一 R01 输入。若 tracked 内容变化则回 S14A。

签名仍保持当前允许未签名但强制 receipt/公开披露，不新增证书购买门。

**关闭条件**

R01 dry-run/fixture 对 7 项当前 profile 验证通过，并对漏 `latest.yml`、错 blockmap、缺 checksum、额外旧资产、过期 artifact、tag/subjectSha 不同分别 fail-closed。

## 已通过的重点

- **Issue 数量与现态没有失真：** 计划保持“3 可按事实收敛 + 6 只有完整承接才可行政归档 + #213 长期 open”，初始缺信息 eligible 为 0；没有用日期、空日志栏或 `needs-triage` 冒充未回复。#187 新反例、#191 未覆盖的随剧情更新、#221 双症状、#224 失败 CI 均被保留。
- **M05 顺序正确：** DAG 和矩阵将 M05 串在 M04 后，仍由 S01/主集成者独占 registry/开库/共享 IPC；F03 不取得角色 resolver 或中心接线所有权。
- **头像不是 CSS：** stable character ID、改名/重名/碰撞、多义、DB失败/孤儿、reparse、删除/导出、未知 fork 与原字节保全均有明确责任；没有新建通用资产平台。
- **缓存隐私边界成立：** donor `vela:overview:<path>` 的绝对路径/正文尾句被列为私密资产；新缓存只留最小统计，不持久化摘句，不跨项目读，S13 只能清已确认 key，不能按前缀删除其他作者资料。F02 不原样带入 donor cache，F04 才接最终只读数据源。
- **冻结和远端授权成立：** F05/S13/版本/工具都在 S14A 前收口；S14B/C/D 只读同一 `subjectSha`，任何 tracked 修改退回重冻；S14D 云端资格与 R01 发布分开，R01/G01/G02 仍需对应用户授权，计划本身不授权 merge/tag/release/Issue 写入。
- **范围保持克制：** 不实现 #213 云存档、不造皮肤插件/第二业务内核/第二迁移框架，不增加 80 次模型总帽，也不把收费签名设为门槛。

## 非阻断建议

1. S13 的旧 overview 清理 receipt 只记录合成 key、数量、结果和是否命中授权 store，不记录真实 localStorage key（其中含路径）或 value；这可直接作为 C13 的隐私断言，不需新日志系统。
2. G01/G02 的公开模板把 `closureCategory` 与 `releaseStatus` 做枚举校验（例如 `administrative-transfer/unresolved` 不能搭配 `fixed`），用现有 disposition 表即可，不必新增机器人。

## 复审门

关闭 P2-1 至 P2-3 后可做有界 delta 复审；无需重跑全库源码调查。复审 PASS 仍只表示计划可实施，不代表产品、迁移、模型质量、安装包、云端资格、发布或 Issue 关闭已经完成。
