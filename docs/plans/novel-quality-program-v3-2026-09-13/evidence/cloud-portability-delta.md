> 计划输入证据：下文是独立调查原始意见，不是实施指令或运行通过结论；Program v3合同/Spec与用户最新要求优先。donor占位备份的旧建议已由本版B01/B02真实功能要求替代。

# B01/B02 云便携副本最小安全合同

## 决策

B01 不是复制活动中的 SQLite/WAL，也不是把旧项目原地改成另一个 `projectId`。它应从一个一致性源快照生成**版本化便携导出库 + 资产清单**，B02 只负责把该不可变 generation 手动上传/下载到 WebDAV。恢复永远先进入 staging，校验后安装为新本地项目副本；不做双向实时同步、自动合并或通用恢复平台。

核心规则是三类信息分开：

1. **作者/领域事实与历史证据**：保留原 ID、原字节和原 hash，不因换机器或新 `projectId` 重写。
2. **旧运行的恢复授权**：保留为可查看历史或候选，但在新副本中全部失去自动执行权；需要基于新项目事实重新授权。
3. **机器绑定元数据**：不直接打包，恢复时重新生成、重新绑定或明确显示缺失；不得为“可运行”而改写作者文字或伪造旧 receipt。

## ID 与证据处置

| 对象 | 便携副本动作 | 新副本是否可直接执行 |
|---|---|---|
| manifest `projectId`、session epoch/lease | 源 `projectId` 仅作为 `originProjectId` 写入便携来源记录；安装时生成全新本地 `projectId`、epoch、lease | 新 ID 只授权新动作；旧 ID 不授权当前写入 |
| `cloudBookId`、snapshot generation | 首次绑定生成稳定 `cloudBookId`；每次备份生成不可变 generation，二者不替代本地 `projectId` | 仅用于定位与 CAS，不作为项目写权限 |
| `character_id`、章节/草稿/蓝图/知识文档 ID、finalizationId、SourceRef | 在副本内部原样保留；项目隔离使这些局部 ID 不与原项目冲突 | 可作为已迁移领域事实继续引用 |
| 作者正文、提示词/Skill、定稿快照、内容 hash、事实来源 hash | 原字节复制，原 hash 验证；另算 archive/transport hash，绝不重算后冒充原 hash | 可读取；任何新修改产生新 revision/hash |
| 已终结的 C01 rootAction/attempt/reservation/usage receipt | 原 ID、终态和非敏感 receipt 原样保存为 `originProjectId` 历史；`settled/failed/cancelled/unknown` 不改写、不清账 | 永不自动重发；`unknown` 继续按原保守占用解释 |
| C02 candidate/artifact/revision/fingerprint | 文本、最大 durable revision、artifact/attempt ID 和旧 fingerprint 原样保留；状态投影为 `portable-visible-frozen` | 不可续写、提交、定稿或入上下文；作者显式“采用到新副本”时新建 lineage/fingerprint，并引用旧 artifact/hash |
| ContextSnapshot、候选准入证据 | 原 source ID/revision/hash、选择理由与省略理由保留 | 只作历史解释；必须按新项目当前事实重建 ContextSnapshot 才能用于新请求 |
| finalization/outbox | 已完成定稿与完成发布 receipt 原样保留；`pending/inflight/unknown/failed` 保留原状态并增加只读冻结投影 | 不自动写文件、不自动 retry；作者在新根显式发布时创建新 outbox operation/rootAction，引用原 finalizationId/contentHash |
| import run / recovery / partial / migration journal | 已完成 receipt 保留；未完成或可恢复记录保存为可见候选，原状态与 hash 不抹除 | 不自动继续、重放或提交；重新选择来源并通过当前 fingerprint/authority 校验后建立新 run |

### 为什么不能改写旧 fingerprint

C02 fingerprint 含旧 `projectId/session epoch/rootAction lineage`。恢复时若把其中的项目 ID 批量替换成新 ID，旧 receipt/hash 就不再可信；若继续把旧 fingerprint 当授权，又会让旧机器的 session/action 在新副本自动复活。正确做法是：旧 fingerprint 原样作为历史证据，便携来源记录声明它属于 `originProjectId`；新副本的任何恢复、采用、续写、发布和网络调用都创建含新 `projectId/epoch` 的新 fingerprint，并显式引用旧候选 hash。

## 机器元数据与混合记录

便携导出器必须按字段 allowlist 重建导出库，而非复制原 DB 文件。字段分三类：

- **重新生成**：本地项目根、规范化绝对路径、session lease/epoch、renderer/window/UI cache、文件 grant、锁、临时路径、DB/WAL 句柄、下载 staging 路径、设备/安装实例 ID。
- **保留非密配置但解除绑定**：模型名称、endpoint（若产品认定可便携）、采样参数、provider 类型可作为非密配置保存；API Key、WebDAV token、cookie、OS vault key 和现有 `secretRef` 不打包。恢复后显示 `credential-required`，用户在目标机器授权后生成新的本地 `secretRef`。旧 `secretRef` 不重写成新值，也不传给模型/日志/UI。
- **外部来源**：绝对文件路径、文件 grant 与应用级 import HMAC secret 不打包。已完成导入保留作者内容、source/content hash 与非敏感来源显示；目标机无法复算旧 HMAC 时标 `source-verification-unavailable`。重新选择源文件后以新机器 secret 计算新 fingerprint，建立新 run，不篡改旧来源 hash。

如果某个旧 receipt JSON 同时包含不可上传的绝对路径或 `secretRef`，不得修改 JSON 后仍称其为原 receipt，也不得因“历史证据”把敏感字段上传。便携库只保存：原 receipt 的 SHA-256、允许字段的明确 `redactedProjection`、`redactionReason` 和 `nonReplayable=true`；源设备原记录保持不动。验收报告必须把这种条目列为 `historical-redacted`，不得声称完整 receipt 已迁移。安全/定稿关键 receipt 若无法在不泄露敏感值的情况下验证领域事实，则 B01 阻塞该 generation，而不是静默降级。

作者文字及其历史 source hash 不参与上述重定位：正文、定稿内容、提示词/Skill 字节永不做路径替换、换行规范化或字符串搜索替换。新项目根、凭据缺失和来源重授权都放在独立 portability/machine-binding 投影中。

## 一致性生成与恢复顺序

1. B01 获取当前项目 lease，冻结 `sourceSnapshotId`、DB schema、资产 manifest 与 revision；使用 SQLite backup API/受控 checkpoint 生成一致导出视图，不直接复制活动的 `db + wal`。
2. 对 DB 表和项目文件逐项执行 disposition：领域事实原样复制；运行状态冻结；机器字段重建/解除绑定；未知文件只列 `backup-only`，不执行、不跟随 symlink/junction/reparse。
3. 对每项记录原字节 hash、语义计数和 disposition，再生成 portable DB/manifest 与整体 generation hash。源项目在构建期间变化，则 generation 不得成为 WebDAV `latest`。
4. B02 将唯一 generation 上传到临时/不可变对象；远端大小/hash 校验成功后，才以 ETag/If-Match 条件切换 `latest`。半上传对象不可被恢复入口发现。
5. 下载后在 staging 做大小、hash、schema、allowlist、路径和 reparse 校验；未知较高 schema 只读拒绝安装。
6. 安装时生成新本地 `projectId/session epoch/lease`，写 `originProjectId/cloudBookId/originGeneration` 来源记录并建立缺凭据/冻结候选投影。完整 migration acceptance 通过后才注册项目；失败只清 staging，不触碰当前项目或原副本。

## 必须可失败的验收

1. 源项目含已完成与 `unknown` 的 C01 attempts：恢复后账本仍能解释旧成本，但两类都不会发网；点击采用会创建新 rootAction/attempt，而不是复用旧 ID。
2. 源候选 fingerprint 绑定旧项目/epoch：恢复后候选可查看、复制，恢复按钮默认禁用；当前作者事实完全匹配并显式采用后，产生引用旧 artifact hash 的新 lineage。改变正文/模板/Skill 时必须拒绝采用。
3. outbox 有 completed、pending、inflight/unknown：completed 历史不重发，其他项不自动写目标文件；新路径发布生成新 operation，原 receipt 不变。
4. DB 同时含绝对源路径、失效 `secretRef` 与 API/WebDAV 凭据：云端 generation 扫描不到原值或其 hash；目标机显示需重授权。若关键 receipt 无法安全投影，备份明确阻塞，不生成“成功”快照。
5. 作者正文中恰好包含旧机器路径字符串：恢复后正文原字节/hash完全一致，证明没有全库文本替换。
6. 应用在 SQLite 写入/WAL 活跃时备份：恢复出的 DB 是单一一致 revision；源变化时 `latest` 不前移。
7. 同一 generation 在两台机器恢复：得到不同本地 `projectId`，但领域 ID、作者字节、finalizationId 与 source hash 相同；两边不能凭这些相同 ID 自动互写或自动合并。

## 与现有契约的最小衔接

- C01：旧账本只读保真，新动作重新开户；绝不因换机器释放 `unknown` 或重发旧 attempt。
- C02：旧候选保留最大 durable prefix，但新 ID/epoch 使其默认无恢复授权；显式采用创建新 lineage。
- C03：旧 SourceRef/hash 保留为历史；新上下文只从当前事实重新验证，partial/recovery/stale 不自动准入。
- C08/C09：B01 消费同一 canonical asset/disposition manifest 和 S04 migration acceptance；不得另列一套“云端认为完整”的资产白名单。

这一定义只覆盖单项目、手动 WebDAV、恢复为新副本。它不包含后台自动备份、跨设备实时同步、内容级合并、多用户协作、任意提供商插件或云账户平台。
