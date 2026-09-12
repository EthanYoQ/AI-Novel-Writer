# 中文质量预注册：Program v3 S00

状态：预注册与无模型探针已实现；真实双目标、真实模型和文学质量结论均未运行。机器协议见 `protocol.json`，作者语义源见 `test/fixtures/novel-quality-modernization/semantic-source.json`。合成manifest测试通过只证明拒绝合同，不证明产品改善。

## 冻结样本与判断

三场景分别为旧港来信、山城药铺、长夜观星台，每场景三章，目标依次为900、2000、3000生产draft-units单位；两臂最终共18章。逐章±20%、所有必需事件、身份/时间/知情/物品/计划历史零错误是并列硬门。不得用跨章平均或自然度弥补事实失败。

每臂前章独立生成、保存并供本臂后章使用。早期第二章案例使用语义源指定的作者前情，不能把另一臂的输出借入。中文源生成legacy/canonical两份语义包；目前它们是格式parity合同材料，**尚非旧新SQLite项目转换产物**，S04/S06接入实际项目构造后需保存物理格式与语义回读parity收据。

复述判定：标注前章完整事件与本章非必要回顾的UTF-16 spans，以生产单位计数；重复既有完整事件超过本章10%失败。必须保存原文及hash，不能只按字符串相似度替代人工事件定位。文学自然度、节奏、人物动机由两位未参与实现且不是生成器自评的评审者逐章盲比较，附原文证据；全部维度均无劣才非劣。至少两个场景各一章一个维度两人一致优，其余非劣，才称样本改善。一次独立仲裁仍不明或无仲裁资源为inconclusive。

顺序固定在协议中，最终同时间窗交错两臂。seed固定；主集成者看输出前生成随机匿名标签并私存映射。远端版本不能锁定则记录可能漂移。所有失败、中止、缺章、重试进入意向分析表，旧S00输出不能代替最终baseline。

## 80次唯一总账

最小分配：S00 0；early三门4+2+6；post-UI重跑三门4+2+6；最终18章；规划6；C16既有提取6；备份恢复继续创作4；失败/重试/修复/审稿/复核余量22，合计80。一次逻辑动作可能消耗多次物理调用；此表是可容纳的最小路径，不保证输出、自动续写或失败路径都在配额内成功。所有真实发送（包括失败/unknown）受同一80总帽，不按皮肤加样本或开新账。

正式集成必须固定 `.runtime/.cache/novel-quality-modernization/physical-ledger.jsonl` 为本次campaign唯一账本，所有owner消费它。`updateLedger`持有排他wx锁，逐条append+fsync；锁存在不抢占，残缺记录拒绝继续。reserve先占位，dispatch先落盘再发网络；仅reserve可取消释放，dispatch后settle/unknown均占位。重试用新attempt，不能复用未知请求。调用后缺失usage仍以预留保守记账；本账本仅管实验物理次数，产品token/时间预算仍需S07 C01生产账本，不能拿这个替代。

formal driver尚未接入，因此CLI目前不发送模型请求。实际接入前必须校验总账路径、各阶段未消费的保留额度，并禁止更换campaign文件逃帽。前置失败不会伪造已发送请求；网络未知不可退还。余额不足只报blocked/inconclusive，禁止扩帽。

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
node --test scripts/__tests__/quality-modernization-run.test.mjs
```

help不启动目标。baseline-probe实际运行独立冻结树的既有 `real-provider-generation-qualification.mjs --dry-run`，网络阻断且不传秘密环境；该driver以模拟completion触达生产generation runtime。`quality-modernization-driver.mjs`另外调用目标树已有三条测试，实际触达规划、正文、审稿command：精确范围提交、900目标80%边界、审稿仅定稿历史来源。其IPC是注入测试边界，不是数据库/Electron启动证据。三个入口fixture为中文，不跑英文产品用例。

manifest绑定实际HEAD、仅src/electron生产实现hash（排除tests/fixtures/stories）、独立scripts/package/lock工具hash、既有driver hash与当前runner adapter hash、四个隔离根及fixture字节hash。排除plugins/DSH、计划/报告/缓存；隔离根必须在本工作树任务cache内，realpath检查防交叉、链接逃逸。双目标不能同HEAD/同实现源hash/同realpath，即使标签不同也拒绝；candidate subjectSha必须等于其实际codeSha，参数/作者素材/格式不等拒绝。两个真实目标均启动探针后dry-run才可报通过。hash是完整性而非签名，恶意修改runner本身不在此资格范围。

early/full选择器已可解析并验证同样目标，但目前返回exit2 `PRODUCTION_COMMAND_DRIVER_NOT_INTEGRATED`，不冒充文学实验。S00尚无candidate，真实双目标dry-run为not-run；仅合成observations测试通过。baseline生产源码保持原样。

## C16、C17、C18与编辑门

中文语义源逐项登记C16自动derived正例、author冲突、同名改名、拒绝重启、旧outbox、CAS作者并发、较早章迟到、同章旧版本、身份不明及后处理失败。全部消费现有提取路径，禁止每角色新建付费调用。

C17覆盖正文/头像/知识原文保全、新项目ID与稳定领域ID、当前可读author/derived来源承接、历史候选与未知已发冻结、秘密字段及其hash排除、未知字段blocked、跨revision与恢复碰撞。C18覆盖无CAS追加、同父分叉、origin-readonly重启、latest缺失、上传后本机绑定失败。模型继续创作仅使用4次预留；其余故障优先确定性fixture，未执行不记通过。

编辑绝对门仍消费Program v3 `feature-union.editor-absolute-v1`：3000/200000单位、IME、绝对/相对性能与逐action失败反例，不以模型预算扩成颜色乘积。F05三门须同postUiIntegrationSha的新收据；旧early结果不能代填。编辑具体测量器由F04/F05维护，此runner未实现UI性能资格。

## 单一接线请求

S06A/B/C提供已验证生产command执行adapter，S07在**每次实际物理发送前**调用共享reserve/dispatch，在终态settle/unknown，绑定arm、target code/source/driver hash、candidate subjectSha、parityId、phase/milestone、attemptId；不能在高层一次run扣一次。S04/S06负责把同语义源变成各臂实际项目格式并回读对等材料。S10B提供上下文证据、S11提供审稿→定向修稿→唯一复核，保存输出、模板/Skill与compiled prompt哈希；不要另建直接API实验器。主集成者固定唯一总账与未消费阶段预留、出两臂manifest、盲评映射、post-UI与最终subject冻结。以上tracked适配必须在S14A前完成；缺一项正式运行保持blocked。

启动冻结补充：manifest.environment绑定当前Node executable字节hash、版本与module ABI，esbuild/vitest/Electron/better-sqlite3安装manifest路径、版本、hash；startup为固定无shell argv，不接受任意命令。nativeProfile绑定主线程独立ABI配置收据原字节hash；这里只将其作为环境旁证，node-js探针不加载native，不宣称Electron/native资格。每次probe前后重新验证；runnerAdapterHash被修改、环境变化或argv变化均拒绝。early-budget每臂显式包含一次范围生成与一次正文生成，early/post-UI各4次，失败余量22次，总帽80。
