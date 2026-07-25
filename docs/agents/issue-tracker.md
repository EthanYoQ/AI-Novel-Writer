# Issue tracker: GitHub

本仓库的规格、PRD 与实施任务使用 GitHub Issues 管理，所有操作默认通过 `gh` CLI 或已连接的 GitHub 工具完成。

## 约定

- 创建、读取、评论、加标签和关闭任务时，以 `EthanYoQ/AI-Novel-Writer` 为目标仓库。
- 当工程 Skill 要求“发布到 issue tracker”时，创建 GitHub Issue。
- 当工程 Skill 要求“读取 ticket”时，读取对应 Issue 的正文、评论和标签。
- GitHub PR 不作为外部需求分流入口；只有用户明确指定的 PR 才进入审查流程。
- 规格 Issue 不因拆分实施 tickets 而自动关闭或改写。
- 实施 ticket 使用正文中的 `Blocked by` 记录依赖；GitHub 原生 issue dependency 可用时，同时写入原生依赖关系。

## 发布与合并

- 源码、规格与工作流配置通过普通 Git 提交发布。
- 安装包、更新元数据和其他大体积构建产物不得提交到 Git 或 Git LFS。
- “仅测试云端构建”产生的安装包只能作为 GitHub Actions Artifact 保存，不得自动创建或修改 Release。
