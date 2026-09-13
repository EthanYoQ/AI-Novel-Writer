# Program v3 实施证据索引

基线 SHA：`2264390d6fb8b052cc14736d544df0cc74516649`。现行规格为 Program v3；本目录是实际实施产物，不修改三份冻结规划包。S00 已通过 Astra/Medium 独立审查，无未关闭阻断；该裁决只覆盖 S00，不声明生产功能完成。

| 对象 | 可复查材料 | 证据范围 |
| --- | --- | --- |
| 工作树、CodeGraph、规划复制 | `environment-profile.md`；私有 `bootstrap.json` | 实际开发树初始化和最新状态、28/17/26 冻结清单及 115 文件字节一致 |
| 运行时与 ABI | `environment-profile.md`；私有 `native-profiles.json`、`native-copy-isolation.json` | 两树 SQLite 文件真正独立；Node/Electron 内存查询，不是安装测试 |
| 获准提供商 | `environment-profile.md`；私有 `approved-provider.json` | 仅非秘密参数投影；无真实模型调用或网络资格 |
| 三方差异 | `donor-delta.json`、`donor-delta.md`、`inventory-generate.py` | 三方 960 路径、169 文件差异、原字节哈希和实际差异行范围；采用后仍需逐动作验收 |
| Vela 消费者 | `inventory.json` | 词法命中与 CodeGraph 调用路径分开；不声明零消费者或可以删除 |
| 迁移与归档对象 | `asset-disposition.json` | 27 类资产、30 表/322 字段的拟定处置，供 S01 签署；不是已执行迁移 |
| Issue 与发布基线 | `issue-baseline.json`；私有 `old-release-sources.json` | 只读刷新；未发布、关单或修改评论 |
| 中文实验预注册 | `protocol.json`、`quality-protocol.md`、`test/fixtures/novel-quality-modernization/semantic-source.json` | 80 次同一总帽、三场景各三章两臂、事实与文学判据；结果尚未产生 |
| 实验入口 | `scripts/quality-modernization-run.mjs`、`scripts/quality-modernization-driver.mjs` | help、阶段选择、身份/parity/账本拒绝逻辑；正式 driver 待相关切片接线 |
| 真实基线启动 | 私有 `baseline/execution-targets.json`、`baseline/probe.json`、`baseline/command-probe-vitest.json` | 固定旧实现的 runtime 和三个生产 command 注入完成结果探针；模型调用为 0 |
| 独立代码审查 | 私有 `review-s00.json` | PASS-S00-scoped；9/9 独立测试、基线探针复跑、2714 项三方哈希匹配；三项 P2 修复已核验 |
| S01 契约与迁移 lane | `s01-evidence.md`、`s01-storage-contract.json`、`docs/adr/0018-program-v3-domain-contracts.md` | 独立 36/36；现有 SQLite 实测 35 表/356 字段补全 S00 初扫；M00–M05 业务步骤尚未安装 |
| S00 历史云端 CI | [运行 34711345619](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34711345619) | `1d561e1f0ff14527a65ecb625dfd618147f1df0c` Windows PR CI 成功；不代表后续切片或安装资格 |
| S06A 最新已发布 CI | [运行 34724128298](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34724128298) | `852226db8058f171b98cee40d39bdcddb4f6be3a` 失败：向量 worker native 退出及 26 项分类失败，未确定 native 根因 |
| S06A 结构化入口 | `s06a-integration-evidence.md`、`s06a-consumer-coverage.md` | 实际主进程来源/正式提交保护、目录同预算恢复、独立审查；保留 S06D/S09 未覆盖项 |
| S06B / S09A | `s06b-s09a-integration-evidence.md`、`s06b-consumer-coverage.md`、`s09a-planning-consumer-evidence.json`、`s09a-import-consumer-evidence.json` | 正文准备和恢复、实际知识源与明确角色提案；3 场景 Electron 公开 IPC 验收，0 真实模型调用 |
| G01 原问题台账 | `g01-issue-ledger.md` | 10 项正文/评论与相关 PR/Release fresh-read；逐症状验收 owner；没有当前可关闭结论 |

私有文件均位于本任务 `.runtime/.cache/novel-quality-modernization/`，不进入提交。绝对执行路径、依赖和产物哈希供本机重跑使用，公开材料只包含非秘密字段和合成作品。

S00 时点已运行当前与冻结基线的类型检查及中文计数 7/7、恢复/正文三文件回归 141/141、基线三条 command probe 3/3。后续实际运行记录在各片证据文件中；最新调度规则见 `environment-profile.md`，子代理最低 Terra/Xhigh。真实候选两臂、真实模型、Writer 153 动作、中文 IME、归档/WebDAV、升级、安装及 Release 资格仍未通过；历史本地或 CI 成功不能代替这些产品门槛。

提交前验证 115 份冻结规划材料的 Git blob 与原字节一致。完整 `git diff --cached --check` 会指出原冻结文档已有的 Markdown 行尾双空格/EOF 空行；按用户要求保留受审字节，未改正文或屏蔽全局格式检查。排除三个冻结目录后，所有本次实施路径的同项检查退出 0。
