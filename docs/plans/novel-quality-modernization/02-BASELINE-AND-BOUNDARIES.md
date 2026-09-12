# 当前证据、生产消费者与不可破坏边界

这是计划的证据附录，不是已完成的迁移或逐行审查清单。基线 `731bda1`，代码树等同 `origin/master@2264390`；完整 SHA 见主计划。开工仍须以实际最新状态复核。

## 已复核的入口

| 领域 | 当前锚点 | 当前事实 / 对改造的约束 |
| --- | --- | --- |
| 全局资料 | `electron/utils/config-utils.ts` | `VELA_HOME` 来自 `AI_NOVEL_VELA_HOME` 或用户 `.vela`；config/models/recent-projects 与 prompts/logs 共用该根。读取损坏不能 fallback 后覆盖原文件；原子 JSON 替换与 Windows 短暂占用重试要保留。 |
| 项目身份与磁盘根 | `electron/services/project-access.ts`、`electron/database.ts`、`electron/services/project-storage-preflight.ts` | 当前清单 `.vela/project.json`、schemaVersion=1、稳定 projectId；受控无清单 DB 指纹 `vela-sqlite-v1`；DB 为 `.vela/vela.db`。只改数据库文件名不能完成迁移。 |
| 虚拟文档 | `src/services/vela-protocol.ts`、`src/shared/project-paths.ts` | core/draft/manuscript/revision/review 是 DB 资源，不是普通文件；角色 core 是只读投影。新 URI 必须覆盖所有资源类型并保留只读性。 |
| bridge | `electron/preload.ts`、`src/services/ipc-client.ts`、`src/services/finalization-client.ts`、`src/shared/ipc-channels.ts` | 普通调用经统一 client，定稿和部分 release smoke 也直接接触 window bridge；不能只改一个声明。 |
| UI 生产入口 | `EditorArea.tsx`、`DraftEditor.tsx`、`WorldBuildingEditor.tsx`、`ArchFileViewer.tsx`、`ProjectTree.tsx`、`VersionHistory.tsx` | 路径分支、编辑/只读判断、打开已有标签、版本比较、事件刷新、持久编辑器状态都要迁移；不能只测试解析器。 |
| 工作流 | `architecture.command.ts`、`directory.command.ts`、`generate-draft.command.ts`、`review-chapter.command.ts`、`refine-from-review.command.ts`、`batch-chapter-workflow.ts` | 仍产生/消费旧 URI 和多套恢复状态。批量有草稿待审与自动定稿两种模式，不能在重写时混为一条路径。 |
| Skill / MCP / 模板 | `skill-registry.ts`、`writing-skill-bindings.ts`、`prompt-templates.ts`、`prompt-catalog.ts`、`electron/mcp/mcp-manager.ts` | 用户与项目范围均有旧路径；阶段冻结、绑定引用、用户内容保留以及禁止执行型写作 Skill 的边界不能丢。 |
| 知识库与嵌入 | `electron/vector-store.ts`、`knowledge-base.ts`、`embedding.ts` | 向量空间、legacy vectors、LanceDB 文件与项目身份有关；关闭句柄、迁移原始资料、校验 registry，不能只复制 `.db`。 |
| 定稿/删除 | `finalization-service.ts`、`finalization-repository.ts`、`chapter-deletion-repository.ts` | 正文快照、outbox、失效水位和恢复删除是已有安全能力，不能把新流水线绕过它们。 |
| 角色 | `character-roster-repository.ts`、`blueprint-character-sync.ts`、`character-roster.ts` | 姓名身份与蓝图新候选晋升需要调整；已有动态字段来源与事务不可撤销。 |
| 审稿 | `refinement-completeness.ts`、`review-chapter.command.ts`、`revision-repository.ts`、`ThreeWayMerge.tsx` | 已隔离证明 no-op 可通过完整性门禁；原子合并与源稿冲突保护已存在，要补闭环而非另建 revision 系统。 |
| 字数 | `src/shared/draft-units.ts` | `countDraftUnits()` 版本3按 Unicode 汉字/词等可见单位计数；新写入与 UI 已有统一算法，历史算法仅为幂等兼容。 |
| 更新/发行 | `electron/services/update-service.ts`、`update-preferences-store.ts`、`scripts/smoke-*`、`scripts/*update*`、`.release/` | 更新偏好、隔离环境变量、smoke bridge/URI 和安装探针也存在 Vela 标识。三平台资格要核验真正入口，不能排除测试/脚本后宣布全量退出。 |

## 扫描口径

S00 应保存可重跑的台账，而不是只有匹配次数。每项至少有：路径/符号、生产消费者、类型（命名、存储 ABI、行为、死代码、历史/许可）、替代点、唯一所有者、兼容允许位置、验证方法、最终处理结果。

扫描目录包括桌面 `src`、`electron`、构建/资格 `scripts`、`.release`、`.github`、包/锁文件、使用中的文档与 fixture；明确排除 DSH 与生成缓存。生产词法命中和历史来源清单分别记录。无 Vela 字样的继承模块也要按实际消费能力分类；不能用字符串消失证明实现已替换。

已发现的无消费者候选：`MonacoDiffViewer.tsx`、`DiffViewer.tsx`、旧 ProseMirror/CSS 选择器、`isVelaProtocol`、`DIR_VELA_INTERNAL`。删除前仍需核对最新动态 import、barrel、Vite glob、构建配置和真实 UI；只删无消费者片段，不删活跃 ThreeWayMerge 或整个 CSS。

## 测试环境与数据

本工作树曾使用匹配 Electron ABI 执行数据库测试；不能直接把 Node ABI 报错当产品回归。S00 固定可用 Node/Electron/pnpm 与 native ABI，记录可复用的测试命令；如需重建依赖，在自己的隔离执行环境中处理，不反复切换他人工作树的共享 native 依赖。

基线原件、候选运行目录和迁移 fixture 分离。所有 fixture 合成中文，不复制作者真实小说、个人配置、凭据或已有私有 handoff；真实模型只使用获准配置进行调用，报告只保留安全参数和计数。

本附录不证明 #221/#226 的完整用户场景已复现；完整复现与计划验收在 S00/S14 按限制执行。
