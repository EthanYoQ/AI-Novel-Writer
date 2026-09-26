# Program v3 F04 暂停交接

日期：2026-09-21。F04 已完成并通过独立代码审查；按用户边界在进入 F05 前暂停。

## 工作位置

- 分支：`codex/program-v3-refactor-thread-3`
- F04 最终代码提交：`df5901dc`（本交接文档是其后续文档提交）
- 唯一检查点、物理总账及原始证据保存在私有运行目录，不纳入公开提交。

## 本线程完成的 F04 收口

- `745ca5e`：增加 main 授权的 recent-project capability、严格只读 project peek 和当前项目 overview；不创建或迁移被预览项目，不唤醒 outbox。
- `642bc1c`：Writer 生产入口接入 WelcomePageV2 书架、六工序保守进度和“首次预览、再次进入”；Classic 入口保持不变。
- `3974ac7`：接入 stable-ID 头像操作和批量读取、五档 BFS 关系图、换中心、拖动/平移/缩放/真实 fit/reset、人物侧栏与 1000 人可搜索分页。渲染窗口上限 80，reset 不写人物事实；旧关系编辑、AI 提议和正式确认删除全部均保留。
- `df5901d`：设置新增统一项目备份面板；Writer 标题栏、Welcome 和 Classic 共用标题栏均可达。B01 本地导出/恢复使用受限 picker 和正式 archive IPC；恢复只创建新副本。B02 WebDAV 支持连接/显式重绑、上传披露确认、不可变世代列表/分叉、恢复副本、取消、两步清凭据和 session-only 降级提示。清凭据后重新读取 authoritative binding revision，允许同面板安全重连。

## 验证与审查

- F04.e：service 9/9；main/service/IPC 50/50；Writer browser 5/5；typecheck、定向 ESLint、diff-check 通过。只读 service 与中央接线 reviewer 均 REVIEW-READY=YES。
- F04.f：browser 33/33；typecheck、定向 ESLint、diff-check 通过。真实 fit 的 80 个断开人物反例关闭 reviewer P1，最终 REVIEW-READY=YES。
- F04.g：backup browser 13/13；archive/cloud controller 27/27；typecheck、定向 ESLint、diff-check 通过。cancel/clear-credential、session-only 和 clear 后 revision 刷新 findings 均已针对性复验，最终 REVIEW-READY=YES。
- 本线程真实模型实验 0 次，未修改历史账本或私有证据。

上述验证不替代真实 Electron 文件选择、真实 WebDAV UI 闭环、打包 profile、Windows 中文 IME、200k 编辑器性能或三平台资格；这些层级仍由 F05/S14 执行。

## 未关闭的可靠性问题

以下四类继续分别记录，单跑通过不能自动关闭：

- import hook timeout
- project-clear 两个 case timeout
- vector native `0xC0000409`
- 全量 mcp-manager `GLOBAL_MIGRATION_IO_FAILED`

## 后续顺序与规则

剩余依赖链：`F05 → S13 → S14A → S14B/S14C → S14D → R01 → G02`，G01 问题台账贯穿执行。

下一线程只从 F05 开始：先按 `feature-union.json` 逐 action 核对 Writer 真实入口、handler/store、command/IPC、持久/失败结果与证据层级；完成 Preflight 后才激活 Writer 默认值，再在同一候选 SHA 执行 Final/post-UI 三门。Classic 证据、内部直接调用、null 或 NOT RUN 不能代填 Writer receipt。

保持以下约束：

- 不重跑 S10B/S11 历史 early 实验，不重审无新变更的关闭 finding。
- 当前生成目标和 candidate 字数门为 ±30%，使用 draft-units v3 与既有舍入；冻结 baseline 不追溯改判。
- GPT Pro 咨询已取消。同一阻断两轮有明确假设的修复仍失败时，使用显式非 Astra 的独立顾问 Agent；建议仍须本地实现、测试和独立复验。
- `fast-check` 已安装，仅在重复性或状态空间缺陷有实际价值时使用。
- 所有子 Agent 显式指定非 Astra 模型，禁止子 Agent 再派子 Agent；实施和审查使用 `$ponytail full`。
- 精确暂存，不使用 `git add -A`；不新建第二总账或第二检查点。
