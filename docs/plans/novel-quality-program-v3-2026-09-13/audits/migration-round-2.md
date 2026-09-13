# Migration / portability adversarial review — round 2

## Verdict

**PASS（计划可进入实施拆分/执行；不代表产品或发布已通过）**。

`audits/MANIFEST-v3-round-2.json` 列出的 28 个文件已逐一重新计算 SHA-256，**28/28 相符**。对冻结包运行其静态合同检查，结果为 16 个功能组、153 个逐动作对象、9 个负例全部通过；该检查只验证计划/合同 fixture。`dag.json` 维持 34 个节点，并把本轮新增约束表达为 4 个机器门；未发现迁移 owner、required gate 或依赖闭环的新矛盾。

本轮只复审 Round 1 的 4 个 P1 和相关增量，没有运行生产代码、真实项目迁移、WebDAV、模型、安装包、发布或 GitHub Issue 操作。

## Round 1 blockers

### P1-1 — 敏感混合 receipt 的原始 hash 泄漏：**CLOSED**

- `05-INTEGRATION-CONTRACT.md:102` 现在明确：含 credential、`secretRef`、机器路径等排除字节的记录，既不携带原值，也不携带针对这些字节或原记录计算的 digest/MAC；只允许 portable projection、`projectionHash`、排除字段名、非敏感稳定 ID、终态和 `nonReplayable=true`。
- `specs/B01.md:19` 与合同采用相同二分规则；`:31` 明列 `SHA256(rawSensitiveReceipt)` 及拼接 digest/MAC 负例，不能以只搜明文代替字段 allowlist。
- transfer receipt 的 current-authority hash 被限制为允许外带的作者正文/定稿资产，不再能借历史 receipt hash 夹带被排除元数据。

原反例中可枚举的 vault 引用或用户路径现在没有稳定原始摘要可供离线确认；projection 也不会被冒充为原 receipt 已验证。

### P1-2 — 新 projectId 恢复后的长篇连续性权威：**CLOSED**

- `05-INTEGRATION-CONTRACT.md:98-102` 新增窄 `transfer-authority receipt`：保留 origin→target、generation、稳定领域 ID、原 finalization/content/source hashes 与 currentness；把仍由精确来源支撑的 author facts、权威定稿和 source-valid derived 安装为新项目的当前**可读**权威，并重建引用 transfer receipt 的新 `ContextSnapshot`。
- 同时把执行授权完全分离：旧 C01 unknown、pending/inflight outbox、import/recovery、candidate/attempt 继续冻结，不因 transfer receipt 获得续跑、发送或发布权限。
- `specs/B01.md:28` 给出精确的 1–20 章恢复后写第 21 章反例；替换第 20 章时旧 derived 必须失效并回读新权威正文，不改旧 receipt、不重抽全书模型。

这已消除“冻结全部旧事实导致第 21 章失忆”和“改写旧 projectId/hash 复活历史执行”之间的实现歧义。S05/S09/S10/S12 的承接边界也在矩阵 handoff 中明确，不需要另建自由事实 store。

### P1-3 — B01 早于 S04 实际集成 M05：**CLOSED**

- `04-EXECUTION-MATRIX.md:65`、`05-INTEGRATION-CONTRACT.md:55` 和 `specs/F03.md:14` 一致定义 `F03.m05-integrated`：同一 registry 已含 M05、S04 asset/portable disposition 已覆盖头像字节/引用/孤儿/歧义、tracked migration acceptance runner 已能实际构造和验证 M05，才可出 receipt。
- `dag.json:176-195` 把该门归 central/S04 owner，并将其列为 B01 的 `requiredGates`；`specs/B01.md:3` 明确只有“F03 已交适配请求”不能开工。
- 最终 `subjectSha` 的真实迁移资格仍由 S14C 重跑；冻结前集成门与冻结后的发布门没有相互替代。

因此 B01 无法在 S04 尚不认识 M05 时自行复制第二套头像资产解释，原并行时序缺口已闭合。

### P1-4 — WebDAV 重启绑定与云端并发基准：**CLOSED**

- `05-INTEGRATION-CONTRACT.md:113-121` 选择较小且自洽的模型：随机不可覆盖 generation 是唯一真相；completion descriptor 只在完整上传和校验后出现；`latest` 仅是可丢、可过期的 hint，列表/恢复不依赖它，无 CAS 服务仍可 append。
- `specs/B02.md:15-16` 指定 B02 为 canonical app-data `cloud-backup-bindings.json` 唯一 writer，字段包括 `localProjectId`、`cloudBookId`、`localEndpointAccountId`、`lastSelectedParentGenerationIds`、`mode`、`revision`，并要求原子更新/revision。密码在 OS secret store，本机账号引用和 binding 不进入项目归档。
- 恢复副本只携 `cloudBookId/originGeneration` 的只读来源；目标机首次建立 `origin-readonly`，重启仍不能自动推送，必须显式选账号、云书和父世代后才转 writable。
- `specs/B02.md:26-27` 覆盖无 CAS、过期/错误 latest、A/B 同父 append、A 退出重启、两个 sibling 都保留可恢复、binding 写失败和恢复副本重启仍只读。

当前方案不会把 fresh-read `latest` 偷换成本机已接受基准，也不承诺同父只有一个上传成功。两个分支作为显式 siblings 保留，既满足数据保护，也避免引入强 CAS/实时同步平台。

## Round 1 P2

### DAV 根路径、`href` 与 redirect 逃逸 fixture：**CLOSED**

`specs/B02.md:12,29` 已将配置根外 absolute/percent-encoded `href`、跨 origin 或 HTTPS→HTTP redirect、Authorization 不外发、根外不 PUT/GET，以及 XXE/响应大小纳入失败合同与网络 fixture。该修订复用现有 typed client/受控 WebDAV，不扩大 provider 范围。

## New contradiction check

未发现新的 P1 或实施阻断 P2：

- **可移植证据与当前写作权威没有混为一谈。** 旧 receipt 保持不可变；transfer receipt 只承接来源仍有效的读取权威，新项目重建 ContextSnapshot；旧任务、候选和 outbox 仍冻结。
- **本地 binding 与便携归档边界一致。** cloudBook/origin 只读来源可随恢复意图传递，机器账号绑定和 secret 不随项目搬运；B02 是唯一 app-data writer，B01 不再暗写 DB/schema。
- **云端真相与导航 hint 没有混为一谈。** 完整 generation/completion descriptor 决定可恢复性，`latest` 丢失、过期或无 CAS 都不能覆盖/隐藏 sibling。
- **M05 没有形成第二条 schema lane。** F03 提供头像迁移能力，central/S04 owner 完成同一 registry/runner 的集成，B01 只消费 gate，S14C 对冻结 `subjectSha` 最终重验。
- `09-FEATURE-UNION.md:24,28` 仍把 U16 的本地归档、WebDAV、Writer 接线和最终验收分给 B01/B02/F04/F05；`03-ISSUE-CLOSURE.md:20` 仍要求 #213 在完整功能、打包入口、受控服务和公开发布后才能关闭，没有被静态合同 PASS 冒充为产品完成。

## Release boundary

本 PASS 仅表示冻结的迁移/资产/权限/云存档计划在静态层面已具备实施条件。后续仍必须按各 Spec 完成合成迁移、受控 WebDAV、两个隔离打包 profile、OS secret store、恢复后继续创作、最终同 `subjectSha` 资格与 R01/G02 发布证据；任一未运行或失败都应记为 NOT RUN/blocked，不能据此关闭 #213 或声明迁移已通过。
