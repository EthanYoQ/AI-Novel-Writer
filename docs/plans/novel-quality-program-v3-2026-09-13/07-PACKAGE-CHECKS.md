# Program v3静态包检查

2026-09-13。状态：静态检查PASS；两条Sol/high独立对抗审计均PASS，详情见audits/00-DISPOSITION.md。仅计划与合同检查，不是产品测试。

| 检查 | 实际结果 |
| --- | --- |
| DAG/Spec引用/执行矩阵 | 34个唯一节点、无环，24原片+10整合片，依赖表一致 |
| 强门 | 4个子门；B01必须等F03.m05-integrated，S13必须等F05.post-ui-requalification |
| 功能并集 | 16组153个逐动作，全requiredInWriter=true且not-run，owner合法 |
| 本地Markdown链接 | 正文与审计报告全部本地链接均在最终检查范围，结果无缺失 |
| 当前冻结对象 | MANIFEST-v3-round-3的28文件hash全部匹配 |
| 保留历史 | Program v2的17文件、原Spec manifest的26文件及原3计划文件hash不变 |
| 合同反例 | 15个反例PASS：组级假通过、错owner、Classic代填、重复ID、空receipt、复用step、两壳同慢、IME丢字、关闭预览、缺selection、少于7样本、虚报稳定、选择相对变慢、预热不足、长任务超门 |
| 常见token/key模式 | 未发现匹配；这是有限模式检查，不是完整DLP证明 |
| 工作区 | 生产tracked/staged diff均为空；仅本轮/既有未跟踪计划包与受控缓存 |

实际执行：node .runtime/.cache/program-plan-v3-20260913/validate-plan.mjs；node docs/plans/novel-quality-program-v3-2026-09-13/checks/feature-union-check.test.mjs，退出码均0。合同反例使用合成receipt形状，正例只说明结构可接受，不意味着任何真实动作通过。

未执行：生产代码/模型/中文产品场景/真实IME/项目升级或归档/WebDAV/安装版/云构建/正式发布。GitHub没有评论、关单、PR或其他写入。本轮没有新建项目外路径；中间证据留在本工作树.runtime/.cache，未改贡献目录或真实小说。
