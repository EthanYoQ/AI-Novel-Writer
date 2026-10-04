# Migration / portability adversarial review — round 1

## Verdict

**FAIL（REQUEST_CHANGES）**。

`audits/MANIFEST-v3-round-1.json` 列出的 26 个文件已逐一重新计算 SHA-256，**26/26 相符**。`dag.json` 有 34 个节点、无缺失依赖、拓扑可遍历，机械 DAG 本身无环。本轮未继承 Program v2 的 PASS，也未运行生产代码、迁移、WebDAV、模型或发布测试。

Issue 实质交付、头像 MUST、Writer 完整默认、R01 同 `subjectSha` 精确发布等主方向成立；阻断集中在新 B01/B02 的权限/证据移植合同。以下 4 个 P1 会分别造成秘密派生泄漏、恢复后长篇上下文失效、B01 消费未集成的 M05，以及重启后 CAS 基线不可靠。在关闭前不能派发 B01/B02 为可实施 Spec。

## Blocking findings

### P1-1 — `originalHash` 会重新泄露已声明排除的 secretRef / 机器路径派生信息

**证据**

- `05-INTEGRATION-CONTRACT.md:91` 明确排除模型/云凭据、`secretRef` 和机器路径。
- 同文件 `:96` 却要求混有机器路径/敏感元数据的 receipt 携带 `originalHash + redactedProjection`。
- `specs/B01.md:15` 再次排除这些值，但 `:18` 又要求敏感 receipt 保留 `originalHash`。
- 包内输入证据 `evidence/cloud-portability-delta.md:59` 的负样本要求云端看不到原值**或其 hash**，与约束/Spec直接冲突。

**可失败反例**

旧 receipt 为几乎固定的 JSON，唯一变化字段是 `secretRef="vault:item-42"` 或用户目录 `C:\\Users\\Alice\\Novel`。便携包不含明文，却包含整段原 receipt 的 SHA-256。知道其余字段的云端或本地攻击者可以枚举短 `secretRef`/常见路径确认原值；即使 token 熵高，该 digest 仍是从明确禁止外带的秘密字节派生出的稳定关联标识。实现会同时满足“明文已删”和“originalHash已保存”，从而错误通过当前两个相反门。

**最小修订**

在 C17.6 与 B01 第 6 步把记录分成两种：

1. 原始字节已通过 portable allowlist、没有任何被排除字段时，才允许携带原 receipt 与其 hash。
2. 只要原记录含 credential、`secretRef`、绝对路径或其他被排除字节，archive **不得携带原值，也不得携带对含这些字节的原记录所算 digest/MAC**；只保存允许字段的 `redactedProjection`、基于该 projection 的 `projectionHash`、被排除的字段名、终态/稳定记录 ID 和 `nonReplayable=true`，并明确“不验证原 receipt 字节”。

测试加入已知 token、secretRef、路径及 `SHA256(rawReceipt)` / 常见拼接 hash 的负样本；不能靠只搜明文通过。

**关闭条件**

C17、B01、B01 验收文字不再产生冲突；敏感混合 receipt fixture 证明便携包不含被排除字节及任何基于这些字节的稳定 digest，UI/报告不把 projection 冒充原 receipt 已验证。

### P1-2 — 新 projectId 只冻结了旧执行权限，却没有建立当前定稿/derived 连续性的安全可读权威

**证据**

- `05-INTEGRATION-CONTRACT.md:94` 要求新 local projectId，同时保留领域 ID、作者字节/source hash 和旧 receipt 绑定；`:95` 冻结旧 C01/C02/outbox/import/recovery。
- `specs/B01.md:18-19` 同样强调旧绑定不可伪改、旧运行不可执行；`:26-28` 只笼统要求“当前正文/角色/图谱可用、历史非重放信息不被 C03 当当前事实”。
- 旧 C02 fingerprint 明确包含 projectId/session epoch；旧 C03 又要求上下文只采纳当前、未过期、准入合法的来源。当前合同没有定义：恢复后哪些**已经接受且仍由当前定稿支撑**的 derived 角色状态、连续性摘要/线程、SourceRef 如何在不重写旧 receipt 的情况下成为新项目可读上下文。

**可失败反例**

项目 A 已定稿 1–20 章；第 20 章的有效 `finalizationId/contentHash` 支撑角色伤势和未解线索。恢复为项目 B 后：

- 若实现按“旧 projectId 历史全部冻结”处理，角色 derived/连续性投影都变 stale，写第 21 章时只剩静态设定，恢复副本虽能打开正文却不能保持连续写作。
- 若实现把 receipt/fingerprint 内 A 的 projectId 就地换成 B，历史 hash/不可变证据被伪改，并可能错误复活旧 attempt/outbox。

两种实现都符合当前模糊文字的一部分；S14C 的“继续创作”只能发现问题，不能替代实施合同。

**最小修订**

给 C17/B01 增加一个窄的 `transfer-authority receipt`，不引入恢复平台：

- 逐项记录 `originProjectId -> newProjectId`、snapshot generation、稳定领域 ID、原 `finalizationId/contentHash/sourceHash` 与当前性判定。
- 当前已接受的 author facts、finalized drafts 及其**精确来源仍存在且 hash 相符**的 derived 投影可原值安装为新项目的 current readable authority；保留 `derived` provenance，不改成 author，不改旧 receipt。
- 执行授权完全分离：rootAction/attempt/candidate/pending outbox 仍冻结；transfer receipt 只授权读取当前事实，绝不授权重发、续跑或发布。
- 来源缺失/被替换/歧义的 derived 才标 stale；运行期回读保留的原始定稿正文作确定性 fallback，不重跑全书模型。新 ContextSnapshot 由新项目当前事实重建并引用 transfer receipt。

**关闭条件**

新增反例证明：恢复后的第 21 章上下文包含 1–20 章仍有效的当前定稿、author facts 和 source-valid derived 状态；旧候选/unknown attempt/pending outbox 不进入上下文且不执行；替换第 20 章后旧 derived 失效并回读原文，不改历史 receipt、不触发全书重抽取。

### P1-3 — B01 依赖“最终 M05 manifest”，但 DAG 只保证 F03 提交适配请求，未保证 S04 registry/runner 已集成

**证据**

- `specs/B01.md:13` 开工即要求消费 “S04最终M05 asset manifest”，恢复步骤 `:17` 还要调用 S04 兼容/验证器。
- `specs/F03.md:11` 由 F03 提供 M05，而 central registry/DB 接线不属于 F03；`:14` 的完成动作只是向 S04 owner/集成者“提交适配请求”，实际 project-migration-acceptance 只要求在 S14A 前覆盖。
- `04-EXECUTION-MATRIX.md:29-31` 允许 F03 完成后立刻进入 B01；`:59` 又声称 M00→…→M05 为同一 registry。没有 gate 表示 M05 已被 central owner 合入 S04 最终目标并有可运行 validator。
- `05-INTEGRATION-CONTRACT.md:55` 同样把最终 M05 runner 的时限放到 S14A 前，晚于 B01 的实际消费点。

**可失败反例**

F03 完成头像 runtime service/M05 migration 函数并交接请求，节点被记完成；B01 随即按 DAG 开工。此时 S04 的 target registry/acceptance runner 仍只认识 M00–M04，B01 要么漏打头像/引用，要么私下复制 M05 解释形成第二资产表。直到 S14A 才集成 runner 时，portable 格式、B02 和 F04 已建立在错误资产闭包上。

**最小修订**

不必新增大节点。为 F03 定义一个机器可判的 `m05-integrated` 完成门，由 central/S04 owner 接收 F03 请求后完成：

- 同一 registry 的最终 target 包含 M05；
- S04 asset manifest/portable disposition 已包含头像字节、引用、孤儿/歧义；
- tracked project-migration-acceptance runner 已能构造/验证 M05（最终 subject 的实跑仍留 S14C）。

B01 必须依赖这个门，而不是仅依赖“F03 已交请求”。文件 owner 不变，F03 与 central owner 仍不并行抢 registry。

**关闭条件**

`dag.json`/04/05/F03/B01 对 F03 完成语义一致；在 B01 开工前已有同一 integrated M05 manifest/validator 的 receipt，B01 无权另造资产解释。

### P1-4 — WebDAV 的 project↔cloudBook 基准绑定没有持久化 owner，重启后 CAS 无法判断“远端自上次备份已变化”

**证据**

- `05-INTEGRATION-CONTRACT.md:107` 要求 `cloudBookId`、只读继承绑定、显式基准 generation 和 CAS。
- `specs/B02.md:11` 只明确端点/用户名/OS秘密的 main 持久化；`:14-15` 使用 cloudBookId、远端基准与“两设备同基准”，但没有定义 project-cloud binding 存放位置、字段、revision 或 writer。
- `04-EXECUTION-MATRIX.md:54` 又限制 B02“不再写DB/迁移”；B01只负责 portable 数据转换。当前没有任何 owner 明确持久化 `localProjectId/cloudBookId/expectedGeneration`，也没有重启后的绑定验收；`specs/B02.md:27` 的重启只覆盖凭据。

**可失败反例**

A 将本地项目备份为 generation 1 后关闭应用；B 基于 generation 1 上传 generation 2。A 重启时若只重新读取此刻 latest 的 ETag，再把它当本次 expected ETag，generation 1 的本地分支没有任何持久基准可比较，A 会用 generation 3 覆盖指针而不提示“远端自我的上次基准已变化”。如果实现把 binding 临时塞进项目 DB，又违反 B02 不写 DB/未分配 schema owner，并可能把 endpoint credential reference 带入 B01 archive。

**最小修订**

先指定唯一的非密 `CloudProjectBinding` owner/存储（可由 B02 独占 canonical app-data store，或由 S01 分配明确 project schema；只选一种）。endpoint/account credential 只以目标机本地配置关联，secret/secretRef 不进入项目或 archive。恢复副本只携 `cloudBookId + originGeneration` 的只读来源；作者显式 rebind 后才建立 writable 本地 binding。

冲突模型可选下面一种，不能混成目前的半套状态：

1. **保留强 CAS 语义**：binding 至少持久化 `localProjectId/cloudBookId/lastAcceptedGenerationId/pointer ETag or revision/mode/revision`；上传同时比较持久 expected generation 与 fresh remote pointer，不能把刚读到的 latest 自动采纳为本地基准。
2. **更小的 immutable-generation 语义**：generation 是唯一真相且永不覆盖，`latest` 只是可丢失/过期的可选 hint；上传即使没有 pointer CAS 也只能 append 新 generation，不得删除或覆盖其他 generation。每个 manifest 记录用户实际选择/看到的 `parentGenerationId`，并在出现 sibling generations 时显示分叉而非声称同步。此时移除“无 CAS 即整个服务不可用”和“同基准只能一个上传成功”的过强承诺，但仍需持久的 `cloudBookId/originGeneration/mode` owner，避免恢复即自动推送。

**关闭条件**

04/05/B02 明确 owner、存储、字段与 portable disposition；新增 “A gen1→退出，B gen2→A重启上传” 测试：强 CAS 方案必须冲突，immutable-only 方案必须形成两个都可恢复的 generation 并明确显示分叉，绝不静默覆盖/假同步。恢复副本重启后仍 `origin-readonly`、不自动推送；凭据清除不得删除非密历史/误授权，项目删除则按明确回收规则移除本地 binding。

## Non-blocking observations

### P2 — 补一个恶意 DAV `href` / redirect 的根路径约束 fixture

`specs/B02.md:12` 已有 HTTPS、跨 origin 凭据和受控子路径原则，因此不需新增网络框架。建议在现有网络测试中加入：PROPFIND 返回同 origin 但逃出配置根的 absolute/percent-encoded `href`、HTTPS→HTTP 或跨 origin redirect。预期不跟随、不发送 Authorization、不对根外对象 PUT/GET。此项可随 P1-4 的 binding/CAS 测试一并补，不单独扩大协议支持范围。

## 已明确通过的审计点

- 26/26 manifest hash 相符；34 节点引用完整且无环。
- v2 的行政归档、7 日无回复关闭、排除 #213、#191 全手工更新均已从现行合同撤销；G01/G02 保持原产品 Issue 到真实结果完成。
- #187/#191/#211/#213/#219/#221/#224 的原范围未被部分 PR 或 successor 偷换；#199/#205 只是发布证据复核候选；#222 保留窄代码门。
- 头像选择/压缩/替换/删除/图谱/迁移/B01 roundtrip 均为 MUST；未知 donor fork 不猜映射。
- Writer 的 U01–U16 都要求自身生产入口，Classic 不代填；默认激活位于 Preflight 后，Final/post-UI 与后续 `subjectSha` 规则未被削弱。
- B02 已限定单一手动 WebDAV、恢复新副本、TLS、OS secret store、不可变 generation/CAS 和非 E2E 披露，没有被扩成云平台。
- R01 保持同 `subjectSha`、冻结 profile 精确资产集合、云端原字节提升与显式发布授权；G02 在真实发布后逐项 fresh-read。

## Pass condition for round 2

关闭 P1-1 至 P1-4，并同步修改所有互相引用的约束/Spec/DAG文字；更新 manifest 后做有界 delta 复审即可。通过只表示计划具备实施条件，不表示迁移、WebDAV、产品、模型、安装包、发布或 Issue 已通过。
