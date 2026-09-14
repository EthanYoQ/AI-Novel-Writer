# 24 份 Sol/high Spec

全部生产实施状态：NOT STARTED。依赖必须以**已合入且验证的实际 SHA**满足；上游口头 done 不算。唯一共享接线 owner 与 schema M00→M04 顺序见 [执行矩阵](04-EXECUTION-MATRIX.md)，通用限制见 [执行合同](05-SOL-EXECUTION.md)。

| Spec | 交付范围 | Blocked by |
| --- | --- | --- |
| [S00](specs/S00.md) | 最新基线、消费者/资产台账、中文预注册 | 无 |
| [S01](specs/S01.md) | 共享契约、ADR、schema lane | S00 |
| [S02](specs/S02.md) | API/URI 全量消费者 | S01 |
| [S03](specs/S03.md) | 全局配置与启动前迁移 | S02 |
| [S04](specs/S04.md) | 项目/知识库/物理格式迁移，M00 | S03 |
| [S05](specs/S05.md) | Run/预算/持久候选，M01 | S04 |
| [S06A](specs/S06A.md) | 结构化规划入口 | S05 |
| [S06B](specs/S06B.md) | 正文/两批量模式 | S06A |
| [S06C](specs/S06C.md) | 审修运行入口 | S06B |
| [S06D](specs/S06D.md) | Agent/工具子任务 | S06C |
| [S07](specs/S07.md) | 任务预算、诊断、第一质量门 | S06D |
| [S08](specs/S08.md) | 角色 ID/provenance，M02 | S05 |
| [S09A](specs/S09A.md) | 蓝图/角色 proposal 批准 | S08、S06A |
| [S09B](specs/S09B.md) | 连续性/定稿/导入身份 | S09A、S06B |
| [S09C](specs/S09C.md) | 角色 UI/Agent | S09B、S06D |
| [S10A](specs/S10A.md) | 来源选择纯契约 | S07、S09C |
| [S10B](specs/S10B.md) | 共享章节上下文、第二质量门 | S10A |
| [S11](specs/S11.md) | 审修闭环/第三质量门，M03 | S10B |
| [S12](specs/S12.md) | 导入账本与取消收敛，M04 | S11、S09C |
| [S13](specs/S13.md) | Vela 最终退场/死代码与依赖 | S12、S07，三个早期质量门 |
| [S14A](specs/S14A.md) | 冻结前工具收口、确定性/review、双目标验证与subjectSha冻结 | S13 |
| [S14B](specs/S14B.md) | 只读运行真实旧/新两臂三场景三章盲评 | S14A |
| [S14C](specs/S14C.md) | 只读执行升级/旧版重开/崩溃 | S14A |
| [S14D](specs/S14D.md) | 同subjectSha三平台只读资格，不发布 | S14B、S14C |

## 需求追踪

| 用户目标 / 反复问题 | 实现责任 | 关键证据 |
| --- | --- | --- |
| Vela 全量重写/退出，不仅改名 | S00–S04、S13 | 消费者/能力/资产三张退出表、旧版拒写与原文保全 |
| 无效残留清理 | S00、S13 | 静态+动态消费为零、限定依赖删除、生产编辑/diff 回归 |
| 输出上限、生成浪费、恢复失败 | S05–S07 | 实际物理参数/父账、候选 CAS、范围覆盖、首个中文门 |
| 长设定挤爆 prompt 与信息丢失 | S10A/B | 原文完整、必需证据覆盖、snapshot、第二中文门 |
| 角色混乱/自动加入/改名串人 | S08–S09C、S10 | 稳定 ID、歧义待确认、来源/lineage、事实 oracle |
| no-op 修稿、反复审稿假绿 | S06C、S11 | finding 锚点、真实 hunk、最多一次复核、第三中文门 |
| 过度/重复状态与导入防御 | S05、S12 | 单取消 owner、单 effect ledger、必要安全约束仍在 |
| 小说写作质量实际变好 | S00、S07、S10B、S11、S14B | 预注册、逐章非劣/改善、盲评原文证据、不选优样本 |
| 作者数据与桌面可交付 | S03/S04、S14A/C/D | 不改原件、单写根、实际旧二进制、三目标各自 receipts |

建议一次至多两个互不抢文件的实施 Agent；主集成者单独负责共享接线和审查。可以串行完成，不把并行数量当进度指标。

最终证据链：所有tracked工具适配 → S14A验证/冻结subjectSha → B/C隔离只读执行 → D消费同SHA收据。任何B/C/D阶段tracked改动必须退回重新冻结，旧证据不得自动沿用；两个A/B执行目标必须各自可运行并有数据语义parity，不能把同代码运行两次贴标签。细则见通用执行合同。

S07/S10B/S11早期门同样各自负责真实baseline/candidate双目标、零模型dry-run、fixture parity与逐请求arm-target SHA收据，分别执行early-budget/early-context/early-review。单臂smoke不能代替对照；早期结果不替代最终subjectSha资格，全部仍共用80次实验总帽。
