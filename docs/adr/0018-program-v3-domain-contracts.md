# Program v3 的共享契约与分阶段接入

状态：S01领域类型与纯拒绝检查；尚未接入生产运行。依赖S00 `657ce4aa5f2e13dda4be222e256cd3faaecc9559`，S00测试入口集成 `b90b91961bd301e271f8198280c7494f6534186c`。本ADR扩充0017，不废除定稿/outbox、项目租约、Writing Skill与剧情树边界。新类型不创建数据库、IPC、网络、后台工作或第二事实源。

`generation-contract`只描述根作者动作、Run、物理attempt/reservation与可见Artifact。生产main创建根ID，项目/操作/nonce/冻结输入形成幂等键；子调用与恢复继承根。reserve、dispatch-marked必须分别先持久再执行；unknown不释放，不自动重发；用量缺失按预留，实耗超估如实保留且停止后续。产品token/时间根账由S05/S07在同一事务实现，纯检查函数自身没有并发或持久保证。provider reasoning included/separate/unknown明确列出，未能约束总开销不得自动链式重试。

`source-ref`的span为UTF-16 code unit，hash为未改写UTF-8字节。原稿不做Unicode/换行规范化。候选必须保存且为当前draft，只能作者选择或本批直接前驱；partial/recovery/conflict/stale/replaced不得自动供上下文。ContextSnapshot只引用现有事实，不建可写事实库。C02快照检查校验原文hash、epoch/attempt/root、CAS revision和前缀；异步hash检查仅作写前预检，S05仍须在实际提交事务内重查epoch/revision并以持久收据ack，不能把预检通过当已保存。

`character-identity`复用现有CharacterStateFieldProvenance、CharacterStateTextField与FinalizedSourceIdentity；稳定characterId新增为接入DTO，尚未替换生产name-only引用。scope精确别名候选只能得到resolved/ambiguous/unresolved，不用相似度或first-match。C16纯决策必须由S09B在现有同步事务内，重新读取字段revision/hash/provenance、项目epoch与权威定稿，并重新计算提交值hash后调用；传入自报hash不是授权。derived缺sourceOrder或顺序不可信必须source-conflict；旧章迟到、同章旧版本、并发作者编辑拒绝，空legacy字段可非冲突转derived，author/非空legacy保全并提议。拒绝去重只限角色/字段/源hash/值hash。函数不分配ID、不自动批准，不新增提取请求。

`review-cycle`区分生成、合并、resolved/unknown/unresolved/author-waived。finding锚点绑定sourceHash、合法UTF16 span、occurrence、excerptHash、类别、稳定目标；实际唯一定位与excerpt回读归S11。no-op或无关hunk维持unresolved；复核必须绑定合并稿和finding集合，最多一次。纯函数消费主进程已核验的证据，不能接受模型自行宣称uniqueAnchor/authorWaived为作者授权。

`project-storage`固定M00–M05业务ID，数字版本只由唯一migration registry拥有。journal留在项目 `.ai-novel-migration/journal.json`，不随`.vela`隔离移动。全局legacy source/canonical target/userData分离，main先完成全局迁移和skin读取发mainReady，F01再hydrate renderer appearance。renderer单writer只持久shellPreference、颜色/字体/缩放；main SkinService独占背景。发布默认不是作者偏好，也不虚构跨进程原子快照。路径证明必须由main进行真实realpath/能力/reparse验证；本类型没有文件授权能力。

C17只转移可读authority，不转移执行权限。B01新projectId/epoch，领域ID、作者原文、权威定稿及有来源的derived保留；TransferReadableAuthority须源当前唯一且恢复文本hash相符，derived不升author。旧候选、outbox/import运行、未知dispatch都是nonReplayable历史，启动不得重放或释放旧预算。新ContextSnapshot重建，显式采用另走新lineage/root。排除秘密/机器路径的旧收据只能带redactedProjection及其hash，不能夹带原秘密digest；这里没有通用序列化器或允许任意字段的生产归档器，B01消费签署allowlist。

迁移数值与安装状态、portable字段签署参见S01 migration owner交付。M00–M05尚未安装的业务迁移不可用占位函数前进版本。schema verified不等于已fence或开放业务；未知高版本、未知来源fingerprint/字段、未证明平台flush/rename时拒绝。Windows/macOS物理持久与旧版重开仍归S04/S14C实测。

接线请求与唯一owner见[模块登记](0018-module-ownership.md)。本片通过只证明类型可编译和合成拒绝路径，生产持久/真实模型/桌面/升级/完整项目恢复均未获资格；原80次实验帽及post-UI预留保持S00协议。
