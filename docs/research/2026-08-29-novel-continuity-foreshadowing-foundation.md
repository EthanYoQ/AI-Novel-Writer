# 长篇连续性与伏笔功能底座决策

## 底座决策单

- 决策：`REFERENCE`
- 推荐参考：[mrigankad/Novel-OS](https://github.com/mrigankad/Novel-OS)（MIT，36 Stars，最后代码提交 2026-08-09，覆盖确定性连续性检查、上下文包、人工豁免）
- 备选：[Yaemikoreal/OpenNovel](https://github.com/Yaemikoreal/OpenNovel)（MIT，2 Stars，最后代码提交 2026-08-01，覆盖状态投影、伏笔追踪、人工差异确认）、[Nigh/show-me-the-story](https://github.com/Nigh/show-me-the-story)（MIT，520 Stars，最后代码提交 2026-08-08，覆盖伏笔生命周期、叙事记忆和写作后处理）
- 结论：三个项目均与现有 Electron、TypeScript、SQLite 产品的架构和事实源不匹配，不适合作为新的主底座；现有产品已经具备蓝图、草稿、审稿、修稿、定稿、结构化角色与连续性检索等深层 seam，应在这些 seam 上增量实现。

Issue #158 记录了当时的产品范围与交付切片；该 Issue 已关闭，本文件只保存带日期的底座选择证据，不代表当前实施状态。

### 可借鉴的设计

1. `show-me-the-story`
   - 伏笔采用埋设、推进、回收、放弃状态，并记录目标章节和章节事件。
   - 写作时只注入活跃伏笔，完成后更新状态，超期时提示。
   - 不照搬其自动重写和单体 `progress.json` 状态模型。
2. `Novel-OS`
   - 先运行便宜、确定性的检查，再把结构化发现交给模型审校。
   - 检查结果以“类别 + 实体”形成稳定事实键；作者可说明“这是有意安排”，豁免在措辞变化后仍有效。
   - 上下文包按用途和相关实体裁剪，而不是把全部历史无差别注入。
3. `OpenNovel`
   - 将事件折叠为当前角色状态投影，供写作上下文读取。
   - AI 只提出状态变化，人工查看差异并确认后才成为事实。
   - 伏笔同时支持自动识别和人工维护，但产品中仍以人工确认后的定稿证据为权威。

### Top 3 浅读评分

每项按 0–2 分计，权重依次为覆盖度 ×3、可二开性 ×3、架构匹配 ×2、活跃度 ×2、Bus factor ×1、代码与测试 ×2、文档与社区 ×1；满分 28。License 为门槛项，不计分。

| 候选 | 覆盖 | 扩展 | 架构 | 活跃 | Bus | 测试 | 文档 | 加权总分 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `mrigankad/Novel-OS` | 2 | 2 | 1 | 2 | 0 | 2 | 2 | 24 | 功能最接近，但 Python/React 状态体系不能替换现有事实源；作参考 |
| `Yaemikoreal/OpenNovel` | 2 | 2 | 1 | 1 | 2 | 2 | 1 | 23 | 状态投影与人工确认边界可借鉴；项目仍处 Alpha；作参考 |
| `Nigh/show-me-the-story` | 2 | 1 | 1 | 2 | 1 | 1 | 2 | 20 | Issue 直接来源且产品验证较强，但 Go/Svelte 单体和自动重写策略不匹配；作参考 |

### 搜索覆盖证据

- 关键词组：`AI novel writer / narrative OS / story bible`、`novel continuity / canon checker / story memory`、`foreshadow tracker / plot thread / narrative promise`、`human-in-the-loop / state diff / consequence preview`、`show-me-the-story`。
- 渠道：GitHub CLI、npm 注册表、Awesome Lists、Exa Web 搜索。
- 候选数：17 个真实候选；除 Top 3 外还包括 `nativeB/scriptor`、`jimchou-h/aether-quill`、`brokorus/booker`、`yile16/auto-novel-framework`、`wsly2006/AINovelStudio`、`finxter/awesome-ai-book-writing`、`aminblm/awesome-chatgpt-creative-writing`、`dorakingx/novelpilot`、`NekoStash/AeonEchoes`、`neosun100/MuMuAINovel`、`akarshkashyap4-ui/NovelWriter`、`Manuskript`、`novel-agent-cli`、`@narrative-os/engine`。
- 跳过渠道：无。
- 注册表结论：未发现可直接安装、同时符合现有事实源和工作流边界的专用连续性/伏笔组件。
