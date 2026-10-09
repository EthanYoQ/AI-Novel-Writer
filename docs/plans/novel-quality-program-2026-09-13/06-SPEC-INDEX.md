# Sol/high派发：复用24片，增加8片

先读本包00/01/04/05和[旧通用合同](../novel-quality-modernization/05-SOL-EXECUTION.md)。主线程组织与集成；Sol/high只做明确一片，**不是唯一开发者，不回滚他人修改，不开子代理**。本轮全部新实施状态NOT STARTED。

旧24片仍在[旧Spec索引](../novel-quality-modernization/06-SPEC-INDEX.md)，派发时必须附本包05的覆盖条目和04的新依赖，禁止只发旧Spec。不复制修改旧受审原件以免双版本漂移。

| 新Spec | 能交给Sol/high的明确成果 |
| --- | --- |
| [G01](specs/G01.md) | Issue刷新、已完成关单稿、完整承接/归档方案 |
| [F01](specs/F01.md) | 经典/写手分层与旧偏好兼容 |
| [F02](specs/F02.md) | 选择性移植独占React壳/CSS/素材 |
| [F03](specs/F03.md) | 角色头像资产、ID与迁移失败安全 |
| [F04](specs/F04.md) | 业务UI复用、未保存门、设置/图谱/编辑体验 |
| [F05](specs/F05.md) | 两外壳能力等价与默认准入 |
| [R01](specs/R01.md) | 正式发布准备与授权后的精确产物交付 |
| [G02](specs/G02.md) | 依据实际发布与新反馈完成Issue收敛 |

每片交付：上游SHA、实际改动/责任、已审和未审路径、命令/退出码、fixture/receipt、pass/fail/not-run/blocked、当前SHA及下一片可用接缝。源码存在按钮不能当“产品通过”。

非模型命令继续用现有typecheck/check:i18n/vitest/browser脚本及S00分离ABI profile；计划不声称命令已执行。下列新测试路径在各Spec中标“拟新增”，实施时创建；禁止passWithNoTests。真实模型调用只用已有获准配置、合成中文、原80总帽。

