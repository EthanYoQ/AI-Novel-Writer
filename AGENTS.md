# AI Novel 项目 Agent 约定

### 本项目目标（背景）

构建一个**无内置本地/云端模型依赖**的小说生成 **harness**：

- 编排层：项目状态、蓝图、连续性、阶段门禁、落盘
- 生成层：由调用方 Agent（如 Grok / Codex）完成
- 参照架构：AI-Novel-Writer 的生产管线（配置 → 架构 → 角色 → 蓝图 → 草稿 → 审稿 → 修稿 → 定稿）

### 语言

- 与用户对话、文档默认中文
- 代码标识符可用英文

## Agent skills

### Issue tracker

规格、PRD 与实施任务使用本仓库的 GitHub Issues 管理；PR 不作为需求分流入口。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用以下任务标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用单一领域上下文：稳定术语写入根目录 `CONTEXT.md`；只有难以逆转、会影响后续设计的决定才写入 `docs/adr/`。探索或修改前应先阅读相关领域文档。详见 `docs/agents/domain.md`。

### Implementation coordination

进入 `/implement` 阶段时，必须由子 Agent 驱动开发：主 Agent 将可独立验证的实施切片分配给子 Agent，并负责范围控制、集成、完整测试、代码审查与发布决策。

在用户要求自主推进的 Matt 工程流程期间，不因架构或功能取舍向用户发起确认问题。遇到重大决策时，先委派独立子 Agent 提供决策意见，再由主 Agent 基于项目约定、规格和证据作出可追溯的决定。
