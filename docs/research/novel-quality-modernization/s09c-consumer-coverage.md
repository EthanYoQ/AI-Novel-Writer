# S09C 消费者迁移与核销

依赖实际提交：S09B `55cc52317a4282e0a98edddbdbd3c863ebadbce6`；S06D `5024594b36a856ed051c7d7e17223043fbd67bd2`。按 Program v3 S09C/C04 实施；执行模型 Astra/Medium 使用本次用户允许组合，冻结计划正文不改。本文件只描述 renderer/client/Agent 片，主进程作者事务由中央集成单独验证。

## 身份与保存

角色列表、选中卡、编辑、删除、改名、关系布局/拖拽/边和草稿三方合并使用 `characterId`。显示名可以相同或交换；列表显示来源备注或 ID 后缀，关系图同名节点附后缀。共享别名仅是查找候选。旧无 ID 草稿原样留在原项目草稿账本，不能按名字自动绑定或正式保存。

作者新增卡使用本地 `draft:<UUID>` 选择键；主进程回执 `created` 映射正式 ID，并在保存期间作者继续编辑时映射当前草稿和关系目标而保留 dirty。保存使用 roster 与 identity 双 revision、完整项目 session。相同冻结 payload/双 revision/session 的 SHA256 operation ID 保持一致；成功后的新编辑使用新 payload/revision，不借旧回执清除后来草稿。所有这些只是客户端行为；main 仍验证身份与事务。

## 正式消费者退出表

| 入口 | 当前路径与边界 |
| --- | --- |
| CharactersView / CharacterEditor | `selectedId` 和 ID 目标；`selectedName` 仅兼容显示导航，唯一显示名也不作为写目标；无生产调用 `setSelectedName`。 |
| character-store / roster-client | 唯一普通作者保存为 `db:character-roster-commit` 的 M02 manual_edit，发送每条 ID、关系 targetCharacterId、双 CAS。旧 `renames` 不再发送。 |
| character-rename-ledger | 合并按 ID，重名不合并；旧 rename metadata 辅助导出只保历史兼容测试，无生产调用来重建正式身份。 |
| RelationshipGraph / relationship-presentation | 图只读派生；结构化关系保 ID；同名手工关系须明确 ID 标签，歧义自由文本原样保留而不猜首人。 |
| CharacterCardImportButton | 复用已迁移的 session 绑定资料输入/主进程来源/候选 staging；本片未重构。作者通过实际 BottomPanel 批量确认。 |
| 架构、目录、资料导入与旧角色修复的 AdoptGeneratedCharactersCommand | 复用 CharacterProposalBatch；真实等待工作流发布窄 batch/choices；选择校验 batch ID/revision/session；一次继续发送显式 map/create/keep 和关系。未确认不正式采用，取消保留候选。 |
| 文本导入 | 已由 S09A/S06D 的主进程 proposal/effect lane 处理；本片不回到旧 name-only commit。 |
| 定稿角色推进 | 已由 S09B/S06D 专属 finalization-generation lane 处理；本片不改其来源/状态资格。 |
| legacy-character-roster-repair.command | 默认 dedicated lane；文件中两处旧 roster commit 仅明确 injected generationDependencies 测试分支，普通生产不进入。 |
| Agent read_characters | 列表携 ID；名字/当前有效别名查询总返回 candidates-only；详细读取必须显式 ID，重名/共享别名不 first-match。现注册表无独立 propose_roster 工具，未虚构新入口。 |
| Agent 写文件 / 虚拟 characters 资源 | 既有 project resource 边界继续拒绝通用 characters 正式写；本片没有添加绕行接口。旧正文名字不搜索替换。 |

批量确认的真实 host 是 `BottomPanel.ActiveRunPanel`，不是 AIOutputPanel。仅在当前项目/session 的原 waiting run 上允许修改选择；context.data.characterProposalChoices 与 run 窄投影分别克隆，不暴露整个私有 context。关系随已采用端点显式勾选，不用逐角色弹窗。旧无 ID 草稿仍需作者明确处理，未自动迁成角色事实。

## 实际验证与限制

- 10 个 Node 文件 75/75：同名/名字交换/别名/ID 草稿合并、保存竞态与 ACK 重试、旧项目拒绝、提议批准与只读角色资源。日志 `.runtime/.cache/novel-quality-modernization/s09c-node-final-r2.log`。
- 4 个实际 Chromium 中文文件 35/35：角色编辑/图谱/资料导入，以及实际 BottomPanel → waiting workflow → AdoptGeneratedCharactersCommand 的批量选择；跨项目选择拒绝和取消零批准。日志 `s09c-browser-final.log`。存在既有 React act/PostCSS 警告，不计为失败或隐藏。
- 定向 lint 与 i18n 执行记录在私有收据；全库 typecheck 使用当时完整工作区，结果单独记录。
- 旧 store 测试迁移保留保存期间编辑、跨项目迟到回执、删除/刷新互斥、丢弃及 dirty 保护断言；新增 SHA256 准备阶段后等待实际 IPC 已开始再触发“在途”竞争，未放宽超时或跳过测试。旧改名 metadata 断言换为稳定 ID/无新 name ledger。
- 独立 CI 单文件 fixture 修复另有 `s09c-ci-fixture-receipt.json`，不计入上述 75 或冒认云端失败已修闭。
- 所有 IPC 为合成回执；不把 mock 成功视为 SQLite 事务证据。主进程原子批准/CAS/回执由 root 另测。本片无真实模型调用、ABI 变更、安装/portable/云端/发布资格；不是整个 Program 完成。
