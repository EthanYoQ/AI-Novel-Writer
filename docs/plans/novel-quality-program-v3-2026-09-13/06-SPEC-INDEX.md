# Sol/high派发：24片内核 + 10片整合

先读本包00/01/04/05/09与[旧通用执行合同](../novel-quality-modernization/05-SOL-EXECUTION.md)。主线程集成，Sol/high只做明确一片；不是唯一开发者，不回滚他人修改，不再开子代理。**本轮实施全部NOT STARTED。**

旧24片仍在[原Spec索引](../novel-quality-modernization/06-SPEC-INDEX.md)。每次派发必须附本包05的覆盖合同和04新依赖，特别S09B字段commit-time CAS/来源单调的自动derived、S00 portable合同/模型预算预留、S13 post-UI门；不能只发旧Spec。Program v2不是执行来源。

| 新/修订Spec | 明确成果 |
| --- | --- |
| [G01](specs/G01.md) | Issue逐症状修复/增强台账与实际完成复核 |
| [F01](specs/F01.md) | 经典/写手偏好兼容、发布默认与作者选择分离 |
| [F02](specs/F02.md) | React外壳/样式与完整action slots，不删功能 |
| [F03](specs/F03.md) | 完整头像、ID/迁移/提交失败安全/批量读取 |
| [B01](specs/B01.md) | 全资产项目归档/恢复新副本，身份/候选/秘密边界 |
| [B02](specs/B02.md) | 手动WebDAV、OS凭据/非密绑定、不可变备份/分叉、恢复闭环 |
| [F04](specs/F04.md) | Writer所有旧/新/增强交互+缺陷修复，a–g串行提交 |
| [F05](specs/F05.md) | Writer功能并集/Classic兼容/默认Final/post-UI资格 |
| [R01](specs/R01.md) | 授权后的精确产物发布、真实双语说明 |
| [G02](specs/G02.md) | 原Issue实际结果结案、未解决/未验证如实保留 |

每片交付依赖SHA、实际改动/路径owner、已审/未审范围、测试命令/退出码/fixture/receipt、PASS/FAIL/NOT RUN/BLOCKED、当前SHA和接缝。S00先确认实际runner/ABI，拟新增tests确实建立后执行，不允许passWithNoTests。不要每个小片重复全套模型/构建，按风险相关回归，完整资格在总门集中执行。

每个F04动作映射feature-union的Writer入口、shared command/IPC、持久/失败结果；不能用Classic或内部API代替。B01/B02先服务后UI，不抢共享文件。所有模型请求使用已获准配置/合成中文、原80次帽（含新场景预留/失败），不能为了关#221擅增其他提供商账号。
