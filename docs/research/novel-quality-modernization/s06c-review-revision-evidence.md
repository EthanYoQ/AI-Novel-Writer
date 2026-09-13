# S06C 审修运行与恢复证据

实施基底 `55cc52317a4282e0a98edddbdbd3c863ebadbce6`；S06B 实际依赖 `88c80aa57ad4de266c57ccd88bab961e567920d3`。本文件所在提交是 S06C 集成快照。依据 Program v3 执行矩阵、增量合同和 S06C；冻结规划原字节未改。

## 实际行为

三个入口 `review-chapter`、`refine-draft`、`refine-from-review` 使用同一 main generation owner。主进程从实际 SQLite 冻结选中文稿 ID/章号/版本/状态/正文 hash、项目配置、作者输入、当前及未来蓝图、已定稿历史及当前来源的事实。角色约束只使用有效身份下的作者状态；旧的或过期的派生事实不作为当前事实输入。人工确认必须对应实际保存的原审稿和源稿；审稿后修稿的 parent root 和模型由原审稿保存凭据推导，不能另开预算。

坏 JSON 的完整替代输出、length 续写与恢复都记录为原 root 的独立 attempt。结构化输出不得拼接为报告；修稿采用持久可见组合并保留原完整性下限。作者在等待期间改稿、确认内容或实际来源变化时，拒绝正式写入并保留候选。旧的、没有可证明生成来源的审稿不会通过新入口重置预算，需重新发起一次有来源的审稿。

报告或待合并修稿与 generation effect 在同一 SQLite 事务提交；存储失败全部回滚，保留原 artifact/组合供重试。保存回执优先重读，不依赖当前模板或再次生成。已保存结果所依赖的 artifact 和组合被封存，禁止丢弃、追加 attempt 或切换组合；原请求重放仍返回原结果。没有增加 ReviewCycle/schema/第二套执行账本，也没有改变 RevisionRepository 原子合并语义。

AI 输出面板按明确 run 提供恢复、复制候选和重开已保存结果。过期源只允许读取候选或已保存结果。已合并或丢弃的修稿通过 revision URI 打开实际只读 CodeMirror，不再进入物理章节保存路径。该公开恢复接口保留供 F04 使用。

## 验证与独立复核

所有模型响应均为确定性 fixture；真实模型调用仍为 **0/80**。当前 Node 25.9 / ABI 141；本片未切换 SQLite ABI。以下计数有重叠，不累加成唯一总量。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| main context | 18/18 | 实际 SQLite，错误源选择、作者输入、有效/过期连续性、确认来源及跨库隔离 |
| main owner 审修 | 17/17 | 实际文件 SQLite、重开、原 root、取消迟到、存储注入回滚、保存凭据封存 |
| repository | 22/22 | 实际数据库注入，含错误全局库具有相同 ID 的反例；原合并回归 |
| 消费者和报告合同 | 7 文件 202/202 | 13 新恢复案例、原 95 消费者案例、22 repository 和 72 纯合同；消费者 transport 是合成 adapter |
| root 相关回归 | 8 文件 112/112 | context/owner/repository、定稿角色、连续性、URI 和正文恢复；与其他行重叠 |
| 最终中央接线回归 | 4 文件 112/112 | 注册 IPC 22、owner/source-binding、同名导入测试 26；IPC 案例走实际 client→注册 handler→SQLite，Electron 注册对象与 SSE 网络为 fixture |
| 独立 root 对抗探针 | 3/3 | 保存后丢弃证明、变更组合及新 epoch 重开，修复前后日志分别保留 |
| 实际 Chromium 组件 | 2 文件 7/7 | 三审修入口恢复面板及 merged/discarded 修稿实际只读；不是构建 Electron 验收 |
| 独立 UI 增量复核 | 2/2 浏览器、1/1 物理保存回归 | Ctrl+S 不写 revision；原物理保存仍可用 |
| 类型、全库 lint、i18n、构建 | 均退出 0 | 构建仍有已有分块/选项弃用警告；不是安装资格 |

独立审查发现并关闭三项 P2：保存后丢弃证明 artifact、保存后更改组合破坏回执、终态修稿 tab 元数据未真正禁止编辑。root 与独立代理分别复核对方文件；提交前核对主接线 10 文件、UI/IPC 增量 4 文件及消费者 10 文件冻结哈希。私有收据为 `s06c-root-review-runner.json`、`s06c-editor-delta-review.json`、`s06c-consumer-freeze.json`、`s06c-consumer-independent-review.json`。

实际命令及完整输出见任务私有目录的 `s06c-central-final.log`、`s06c-root-regressions-final.log`、`s06c-consumer-regression-final.log`、`s06c-recovery-browser-final.log`、`s06c-typecheck-final.log`、`s06c-lint-final.log`、`s06c-i18n-final.log`、`s06c-build-final.log`。主要命令：

```powershell
pnpm run typecheck
pnpm exec eslint . --ext 'ts,tsx' --report-unused-disable-directives --max-warnings 0
pnpm run check:i18n
pnpm run build
pnpm exec vitest run electron/controllers/__tests__/generation-controller.test.ts electron/services/__tests__/main-generation-owner.test.ts electron/services/__tests__/generation-source-binding.test.ts src/services/workflows/commands/__tests__/import-novel.command.test.ts
pnpm exec vitest run --config vitest.browser.config.ts src/components/panels/__tests__/EditorArea.revision-recovery.browser.tsx src/components/panels/__tests__/AIOutputPanel.main-recovery.browser.tsx
```

## CI 与后续边界

S09B SHA `55cc523` 的 [CI 34731373622](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34731373622) 失败：330 套通过、1 套失败、1 套未完成；3345 项通过、1 项失败、9 项跳过。普通失败是同名导入旧断言仍预期整体拒绝；本片只调整为 S09B 已实现的保留逐项提案语义，26/26 本地通过。向量测试在 copy-enter 约 257ms 后以 `0xC0000409` 退出，缺少 fault module/subcode，根因未确定；不能因旧的九个失败文件在新 CI 通过就称云端已修复。

S06D 继续核销 Agent、工具子任务、导入/后处理恢复和其他 S00 残余入口；在这些入口完成前阻断 S07。S11 负责 no-op、逐项复核、ReviewCycle 和完整审稿闭环，本片不声称意见已解决。F04/F05 的完整界面、实际构建 Electron 审修、真实模型质量、安装及发布均未在本片取得资格。保持 Draft PR，不合并、不发布、不关闭 Issue。
