# 独立审计与处置记录

当前阶段：**主计划 v2 与24份 Spec（最新v3）均完成两轨独立复审，PASS。** 首轮12项规划阻断与后续3项拆分阻断均已CLOSED，当前无未关闭的规划/Spec阻断。本文件汇总原审计者实际裁决，不是主线程自批通过证明，也不是实现/测试通过证明。

首轮：独立 `plan_redteam_quality` 与 `plan_redteam_migration`，均 Sol/high；不参加主计划编写、未开子代理。质量轨 REQUEST_CHANGES（6 P1 + 1 阻断 P2）；迁移轨 FAIL/REQUEST_CHANGES（4 P1 + 1 阻断 P2）；合计 12 个规划阻断项，无 P0。原报告完整保留，不重写首轮结论。

## 首轮 → v2 修正

| Finding | 接受后的具体修正 | 约束位置 | 复审结果 |
| --- | --- | --- | --- |
| Q1 | 持久 root action、输入/输出/推理计账、dispatch 不确定窗口与原子 reservation | C01、C07 | CLOSED，质量 Round 2 |
| Q2 | 单 owner canonical prefix、CAS 单调快照、attempt 隔离与完整 fingerprint | C02 | CLOSED，质量 Round 2 |
| Q3 | 前章候选准入白名单、lineage/hash 及下游失效 | C03 | CLOSED，质量 Round 2 |
| Q4 | 名称/别名三态解析、不猜测绑定、批准与 ID 引用同事务 | C04 | CLOSED，质量 Round 2 |
| Q5 | 可验证 finding 锚点、生成/合并双 no-op 门、复核不假绿 | C05 | CLOSED，质量 Round 2 |
| Q6 | 逐章 oracle、双盲评非劣、不用平均抵消失败、早期门与漂移说明 | C06 | CLOSED，质量 Round 2 |
| Q7 | 四运行入口波、三身份波、纯契约后上下文接入、四份末端证据 | C07、04 执行矩阵 | CLOSED，质量 Round 2 |
| MIG-R1-01 | 旧发现路径物理隔离、逐崩溃点收敛、旧版实测、新 ID 降级副本 | C08 项目 | CLOSED，迁移 Round 2 |
| MIG-R1-02 | 全局启动前门禁、双 locator、模型/默认配置 generation、禁止回灌 | C08 全局 | CLOSED，迁移 Round 2 |
| MIG-R1-03 | 唯一 schema owner、M00→M04 序列、probe/migrate/fence 分离 | C07、04 执行矩阵 | CLOSED，迁移 Round 2 |
| MIG-R1-04 | LanceDB canonical 全文保全，不把全文当向量缓存；关闭两端句柄 | C09、C08 | CLOSED，迁移 Round 2 |
| MIG-R1-05 | 逐类 disposition、未知项隔离、reparse 不跟随、S13 逐项核销 | C09、S00/S04/S13 | CLOSED，迁移 Round 2 |

非阻断建议一并采纳：位置单位/文本哈希口径、结构化残片可查看删除、供应商漂移分栏、词法与行为两张退出表、旧版原根/独立副本/崩溃恢复三项分报；没有增加分布式系统或第二事实库。

## v2 已审哈希

| 文件 | SHA-256 |
| --- | --- |
| 01-PLAN.md | D44598A05DD2683E0225ED1513B49C3F2F03DA51E19B8DD509A614E4EABE8EB8 |
| 03-CONTRACTS-AND-GATES.md | 2AF730617CCAFF0303FEB5D4C9F300CAEB85491EE2814B0E9CFDA030269063C3 |
| 04-EXECUTION-MATRIX.md | F67B9068E5A26AD8A6040E151DF4AC6900E62944C33A2C8DF8236B81611392C4 |

审计通过仅意味着可编写/执行实施 Spec，不意味着任何代码修复、迁移、模型写作、安装包或发布已通过。当前生产代码、真实模型和安装包均未在本轮运行验证。

独立报告：[质量首轮](quality-round-1.md)、[质量复审 PASS](quality-round-2.md)、[迁移首轮](migration-round-1.md)、[迁移复审 PASS](migration-round-2.md)。三份受审文件不因 PASS 而回改页首，以免哈希失效。

## 计划通过后：Spec拆分对抗审计

| Finding | 发现及关闭版本 | 具体收口 | 最终独立裁决 |
| --- | --- | --- | --- |
| SR1（P1） | Spec v1发现，v2关闭 | S00保留可启动baseline；S14A对称candidate；实际双目标身份/隔离/fixture parity，逐请求arm-target证据 | 质量Spec Round2 CLOSED |
| MSR-01（P1） | Spec v1发现，v2关闭 | 所有tracked工具适配在freeze前；B/C/D只读同subjectSha，变化回S14A；reportSha分离 | 迁移Spec Round2 PASS；质量亦确认CLOSED |
| ER1（P1） | Spec v2发现，v3关闭 | S07/S10B/S11各自直接负责双目标/phase/dry-run/parity/逐请求收据，不准单臂代替 | 质量Spec Round3 PASS；迁移v3 delta PASS |

完整保留：[质量拆分首轮](quality-spec-review.md)、[质量拆分Round2](quality-spec-review-round-2.md)、[质量最终PASS](quality-spec-review-round-3.md)；[迁移拆分首轮](migration-spec-review.md)、[迁移拆分Round2 PASS](migration-spec-review-round-2.md)、[迁移最终v3 PASS](migration-spec-review-round-3.md)。

最新受审文件清单：[SPEC-MANIFEST-v3.json](SPEC-MANIFEST-v3.json)，覆盖执行合同/索引/24份Spec，共26文件。两名审计者均复算26/26哈希匹配。v1/v2 manifest和其中的送审status是历史快照，当前裁决以本页及原始最终报告为准。主计划01/03/04未在拆分期间改动。

## 最终授权和证据边界

可进入实施准备的是计划/Spec，不是已经修好的产品。后续仍须S00核对最新源码/环境，依赖满足才下发Sol/high；不把当前PASS当代码、小说质量、实际迁移或桌面发布资格PASS。本轮没有代码提交、推送、Issue/PR、merge、Release/tag或Issue关闭。
