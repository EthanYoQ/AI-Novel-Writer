# 本轮证据与未执行范围

2026-09-13。读取最新GitHub open Issue和相关PR/Release；源码比较与两轨调查的独立报告位于evidence。它们是本轮快照，不是后续直接关闭/发布的授权。

- [Issue调查原文](evidence/issue-triage.md)：10个open Issue；3个有关闭依据；无人满足已请求信息仍未答的条件。
- [前端源码调查原文](evidence/frontend-source-audit.md)：技术栈、三方范围计数、15类能力链和切项目静态反例。
- 主线程做了renderer-only首页→设置→外观→经典回切，具体边界见02。没有模型调用、真实小说/项目操作、Electron或安装版运行测试。

原始本地中间证据在本工作树.runtime/.cache/program-plan-20260913；原截图已逐张保存，appearance原文件经图像查看复核。截图模糊，不作为视觉精度通过证据，不为公开包附带本地截图/路径或原始用户诊断。项目内预览脚本/依赖缓存可重建，未创建项目外临时目录。服务与浏览器临时页已停止/关闭，viewport已还原。

CodeGraph返回过错误工作树/混合路径，取证分清了root与具体在盘文件；未运行init/upgrade。没有复制或修改贡献者原件，也未运行其Electron主进程。

未执行：生产实现、正式typecheck/单测/全量回归、付费模型、真实IME、完整功能等价、安装/升级、三平台云端资格、commit/push/PR/merge/tag/Release/Issue写入。文档静态校验和独立计划审计另在audits记录，不能换算为这些项目通过。
