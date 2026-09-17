# 中文质量预注册：Program v3 S00

状态：预注册与 S00 无模型探针保留；S07 新增默认生产命令的双目标合成驱动。未冻结代码的开发执行、冻结目标 dry-run、真实模型执行与文学质量结论分开记录。机器协议见 `protocol.json`，作者语义源见 `test/fixtures/novel-quality-modernization/semantic-source.json`；二者预注册字节未改变。合成验证不证明产品改善。

## 冻结样本与判断

三场景分别为旧港来信、山城药铺、长夜观星台，每场景三章，目标依次为900、2000、3000生产draft-units单位；两臂最终共18章。逐章±20%、所有必需事件、身份/时间/知情/物品/计划历史零错误是并列硬门。不得用跨章平均或自然度弥补事实失败。

每臂前章独立生成、保存并供本臂后章使用。早期第二章案例使用语义源指定的作者前情，不能把另一臂的输出借入。S00 的 legacy/canonical 语义包仍只是格式合同材料；S07 early-budget 另从同一语义源构造各目标原生物理项目，并经实际 SQLite、提示词读取和模型配置入口回读 parity。此构造不声称验证旧项目迁移或其他阶段的项目 fixture。

复述判定：标注前章完整事件与本章非必要回顾的UTF-16 spans，以生产单位计数；重复既有完整事件超过本章10%失败。必须保存原文及hash，不能只按字符串相似度替代人工事件定位。文学自然度、节奏、人物动机由两位未参与实现且不是生成器自评的评审者逐章盲比较，附原文证据；全部维度均无劣才非劣。至少两个场景各一章一个维度两人一致优，其余非劣，才称样本改善。一次独立仲裁仍不明或无仲裁资源为inconclusive。

顺序固定在协议中，最终同时间窗交错两臂。seed固定；主集成者看输出前生成随机匿名标签并私存映射。远端版本不能锁定则记录可能漂移。所有失败、中止、缺章、重试进入意向分析表，旧S00输出不能代替最终baseline。

## 80次唯一总账

最小分配：S00 0；early三门4+2+6；post-UI重跑三门4+2+6；最终18章；规划6；C16既有提取6；备份恢复继续创作4；失败/重试/修复/审稿/复核余量22，合计80。一次逻辑动作可能消耗多次物理调用；此表是可容纳的最小路径，不保证输出、自动续写或失败路径都在配额内成功。所有真实发送（包括失败/unknown）受同一80总帽，不按皮肤加样本或开新账。

正式集成必须固定 `.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl` 为本次campaign唯一账本，所有owner消费它。`updateLedger`持有排他wx锁，逐条append+fsync；锁存在不抢占，残缺记录拒绝继续。reserve先占位，dispatch先落盘再发网络；仅reserve可取消释放，dispatch后settle/unknown均占位。重试用新attempt，不能复用未知请求。调用后缺失usage仍以预留保守记账；本账本仅管实验物理次数，产品token/时间预算仍需S07 C01生产账本，不能拿这个替代。

S07 的 early-budget 驱动在每次最终 provider fetch 前持锁 reserve→dispatch；原操作的重复物理发送消耗22次失败/修复余量，不能借用后续阶段的首次配额。真实模式唯一文件为上述 campaign 总账；合成模式使用独立、明确标注的模拟账本，不消耗真实80次。网络流结束后 settle/unknown，未知不得退款；前置失败不伪造已发送，余额不足只报 blocked/inconclusive。其他阶段仍须接入同一账本，未实现的阶段拒绝执行。

获准安全参数：provider=`openai`、protocol=`openai`、endpointHost=`api.siliconflow.cn`、modelName=`deepseek-ai/DeepSeek-V4-Flash`、temperature=0.7、maxTokens=16384。配置declared context=null/output=16384/reasoning=false/structuredOutput=false/usage=false不等于实测能力；不推测结构化支持、usage或上下文上限。密钥只通过现有安全模型入口，禁止fixture/receipt/日志携带密钥或密钥hash。旧qualification driver模拟的其他模型名称仅是其自带模拟样本，绝不是正式获准provider配置。

## 可运行入口及证据边界

```
node scripts/quality-modernization-run.mjs help
node scripts/quality-modernization-run.mjs baseline-probe --targets <私有execution-targets.json>
node scripts/quality-modernization-run.mjs dry-run --targets <真实双目标execution-targets.json>
node scripts/quality-modernization-run.mjs early-budget --targets <双目标> --milestone early
node scripts/quality-modernization-run.mjs early-context --targets <双目标> --milestone post-ui
node scripts/quality-modernization-run.mjs early-review --targets <双目标> --milestone post-ui
node scripts/quality-modernization-run.mjs full --targets <双目标> --milestone final
pnpm exec vitest run scripts/__tests__/quality-modernization-run.test.mjs
```

help不启动目标。baseline-probe实际运行独立冻结树的既有 `real-provider-generation-qualification.mjs --dry-run`，网络阻断且不传秘密环境；该driver以模拟completion触达生产generation runtime。`quality-modernization-driver.mjs`另外调用目标树已有三条测试，实际触达规划、正文、审稿command：精确范围提交、900目标80%边界、审稿仅定稿历史来源。其IPC是注入测试边界，不是数据库/Electron启动证据。三个入口fixture为中文，不跑英文产品用例。

manifest绑定实际HEAD、仅src/electron生产实现hash（排除tests/fixtures/stories）、独立scripts/package/lock工具hash、既有driver hash与当前runner adapter hash、四个隔离根及fixture字节hash。排除plugins/DSH、计划/报告/缓存；隔离根必须在本工作树任务cache内，realpath检查防交叉、链接逃逸。双目标不能同HEAD/同实现源hash/同realpath，即使标签不同也拒绝；candidate subjectSha必须等于其实际codeSha，参数/作者素材/格式不等拒绝。两个真实目标均启动探针后dry-run才可报通过。hash是完整性而非签名，恶意修改runner本身不在此资格范围。

schemaVersion=1 的 S00 manifests 保持历史探针行为，formal 阶段仍返回 exit2 `PRODUCTION_COMMAND_DRIVER_NOT_INTEGRATED`。schemaVersion=2 使用下述 S07 默认生产桥。未迁移的 early-context、early-review、full 返回 `PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED`。baseline 生产源码保持原样。

## S07 默认生产双路径与冻结顺序

新桥位于 `scripts/fixtures/quality-modernization-production.fixture.mjs`。它实例化各目标的默认 `GenerateDirectoryCommand`、`GenerateDraftCommand`，不传 `createRuntime`、completion、repository 或 command dependencies。Electron 的传输外壳由测试桥实现，处理器、项目权限、模型租约、provider、解析、提交均调用各目标实际源码；SQLite 使用真实隔离文件。候选臂走已注册的 generation main owner，基线走其原有 renderer runtime 和注册 LLM controller。两者都在同一个最终 fetch 边界切换 synthetic/real；不存在直接 API 质量实验器。

candidate 每次发送前从实际 fixture 数据库查询唯一 `dispatch-marked` attempt，并核对当前默认 command 持有的 project/epoch/root/run、attemptId 和真正输出上限；零条、多条或不匹配都拒发。收尾再核对原 attempt 的 stop、artifact 与正式 effect。已知 stop 且 usage 不可信时保留产品账本的 unknown liability，不谎称可信用量或失败退款。baseline 不伪造它没有的 main attempt，使用独立物理 ID 并绑定原实现哈希。

两臂的模板输入采用对称映射：从不可变 baseline `2264390d6fb8b052cc14736d544df0cc74516649` 提取 `chapter_blueprint_chunk` 和 `first_chapter_draft` 的完整原模板；两臂作为相同的自定义作者模板读回。语义源那句无占位符的 `template` 完整写入双方 `globalGuidance`，不会用它覆盖生产模板并丢掉作者素材。模板原字节、guidance 字节、实际项目回读哈希保存在私有 receipt；各臂编译后的 system/完整 prompt 哈希另列，允许体现实现差异。角色原始名字与身份约束完整保存在作者素材及主角档案，本门不凭名字凭空创建已批准角色卡。第二、三章作者预置蓝图用于验证本次第1章范围提交没有改写范围外内容。

执行环境由每臂实际探针决定。当前基线依赖使用 Electron ABI145，可用其 Electron executable 的 `ELECTRON_RUN_AS_NODE=1` 执行；候选使用本树 Node ABI141。二者都实际加载其自身 better-sqlite3 并查询，不把 package 版本或历史 native 收据当加载证明；不切换当前树 ABI，不改基线源码。差异写入 manifest，不声称环境完全相同，也不声称这是安装版 Electron UI 验收。

开发阶段先运行（只能生成 `development-only-unfrozen` 收据）：

```powershell
node scripts/quality-modernization-run.mjs development-synthetic --baseline-root <已登记baseline工作树> --output .runtime/.cache/novel-quality-modernization/s07-development-targets.json
node node_modules/vitest/vitest.mjs run scripts/__tests__/quality-modernization-run.test.mjs
```

主集成者完成本片全部源码与驱动提交后，才冻结正式目标：

```powershell
node scripts/quality-modernization-run.mjs freeze-targets --baseline-root <同一baseline工作树> --output .runtime/.cache/novel-quality-modernization/s07-targets.json --model-id <获准模型ID>
node scripts/quality-modernization-run.mjs dry-run --targets .runtime/.cache/novel-quality-modernization/s07-targets.json
```

freeze 拒绝未提交 candidate、未提交驱动、变更的 baseline；manifest 绑定目标源、执行工具、桥、native 二进制和固定启动身份。每次执行在其四个隔离根下建立新的短路径子目录，dry-run 不污染随后真实执行的项目。原有目录/receipt 不覆盖，所有输出与失败保留。

真实执行由主集成者在候选提交与 dry-run 通过后顺序开展。先通过已有安全配置路径，把获准模型记录注入每臂 manifest 指定的隔离 `config/models.json`，不从脚本自动寻找用户 home，不把 key 或其 hash 放进参数、fixture 或 receipt。驱动只读取明确模型 ID，核对预注册 provider、protocol、modelName、endpointHost、temperature 与 maxTokens，拒绝无凭据或参数漂移：

```powershell
node scripts/quality-modernization-run.mjs early-budget --targets .runtime/.cache/novel-quality-modernization/s07-targets.json --milestone early --mode real
```

裸 early-budget 不默认发模型，必须显式选择模式。兼容 `--phase early-budget --dry-run` 写法，但 `--protocol` 只接受实际 `docs/research/novel-quality-modernization/protocol.json`；冻结旧 Spec 示例中不存在的 test/fixtures 路径不会被悄悄替换。退出码0仅证明所列执行/落盘断言通过，1表示实际执行失败，2表示前置阻断。真实结果仍为 `pending-independent-oracle-review`，需独立评审原文事件、事实和质量，不能把合成正文或字数合格直接记为 C06 PASS。

## C16、C17、C18与编辑门

中文语义源逐项登记C16自动derived正例、author冲突、同名改名、拒绝重启、旧outbox、CAS作者并发、较早章迟到、同章旧版本、身份不明及后处理失败。全部消费现有提取路径，禁止每角色新建付费调用。

C17覆盖正文/头像/知识原文保全、新项目ID与稳定领域ID、当前可读author/derived来源承接、历史候选与未知已发冻结、秘密字段及其hash排除、未知字段blocked、跨revision与恢复碰撞。C18覆盖无CAS追加、同父分叉、origin-readonly重启、latest缺失、上传后本机绑定失败。模型继续创作仅使用4次预留；其余故障优先确定性fixture，未执行不记通过。

编辑绝对门仍消费Program v3 `feature-union.editor-absolute-v1`：3000/200000单位、IME、绝对/相对性能与逐action失败反例，不以模型预算扩成颜色乘积。F05三门须同postUiIntegrationSha的新收据；旧early结果不能代填。编辑具体测量器由F04/F05维护，此runner未实现UI性能资格。

## 后续阶段接线边界

S07 early-budget 已接默认生产命令及最终 fetch 处的 reserve/dispatch/settle/unknown，未新增生产 observer hook。后续阶段须复用同一总账和实际项目回读，绑定各自 phase/milestone/原 attempt，不能在高层一次 run 扣一次。S10B提供上下文证据、S11提供审稿→定向修稿→唯一复核，保存输出、模板/Skill与compiled prompt哈希；不要另建直接API实验器。主集成者固定唯一总账与未消费阶段预留、出两臂manifest、盲评映射、post-UI与最终subject冻结。未实现的阶段正式运行保持blocked。

启动冻结补充：manifest.environment绑定实际 executable 字节hash、版本与module ABI，以及 esbuild/vitest/Electron/better-sqlite3 安装manifest路径、版本、hash。schemaVersion=1 的 nativeProfile 仅为历史旁证，原 node-js 探针不加载 native；schemaVersion=2 另绑定实际加载并查询过的 SQLite binary。startup 固定执行器与已hash驱动，不接受任意命令；实际无shell argv写入每次桥接收据。正式执行前后重新验证 source/tools/adapter/environment/startup，任何漂移拒绝。early-budget每臂显式包含一次范围生成与一次正文生成，early/post-UI各4次，失败余量22次，总帽80。
