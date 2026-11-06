# 旧外壳基线场景

> 历史说明：本文件按当时的改造或 issue 记录场景与对照步骤，不随当前构建更新。其中的对照命令（旧外壳场景、`--shell`、指向 trunk 的 `--app-root`）只适用于当时的 trunk，在当前构建上不能照抄。当前构建的做法以正文和 `driver.md` 为准；某个场景现在能不能对 head 跑，以 `driver.md`「RD-10 删除旧外壳之后」的分类为准。

RD-10 之前的旧外壳场景，只对 trunk（`--app-root`）跑。做旧外壳对照或改 `scenarios.mjs` 时读。

## 场景

| 名称 | 对应流程 | 单跑时截图停在 | `baseline-all` 里的不同 | 用夹具模型 |
|---|---|---|---|---|
| `new-project` | 新建作品 | 新作品的小说配置页 | 无 | 否 |
| `open-sample` | 打开示例作品 | 项目树刷新完成（蓝图 2/100 章、角色图谱已生成），显示第 1 章与草稿_v1 | 无 | 否 |
| `write-chapter` | 写作此章 | 草稿标签已打开，正文非空 | 已有预置的草稿_v1，写出的是草稿_v2 | 是 |
| `review` | AI 审稿 | 审稿报告标签 | 审的是最新一稿草稿_v2 | 是 |
| `revise-merge` | 按确认意见修稿并合并 | 修稿合并对话框；截图后点完成合并，等对话框关闭 | 修的是草稿_v2 | 是 |
| `finalize` | 定稿 | 已定稿（只读），AI 输出显示后处理完成 | 定稿的是合并后的草稿_v2，不是草稿_v1 | 是 |
| `run-panel` | 打开运行面板（现为 AI 输出） | 重开作品后从右侧栏打开 AI 输出，显示一条持久运行「第1章候选」 | 无；它排在审稿之前，因为草稿被修稿改动后这条记录变成「第1章生成记录」 | 是 |
| `settings` | 打开设置 | 设置弹窗 | 截图后关闭设置，接着跑 new-project | 否 |
| `baseline-all` | 按共享前置串成 2 个会话跑上面 8 个场景 | 8 张截图 | | |
| `startup-timing` | 只启动 | 不截图，输出启动耗时 | | 否 |

示例作品名为「灯塔」，第 1 章「旧港」，由公开 IPC 预置后从书房打开；打开后等项目树统一刷新结束再继续，之前的画面随刷新进度变化。

场景的 `run` 可以调 `context.restart()`：退出应用、用同一隔离目录冷启动（不重写外观），context 里的 `app`、`page` 换成新的，用于验证「重启后仍保持」。

`scripts/redesign/scenarios.mjs` 里每个场景分三段：`setup` 是单跑时的前置（预置作品、写一章、审稿等），`run` 从前置状态走到截图状态，`after` 在截图后执行。一个会话只跑首个场景的 `setup`，然后依次 `run`、截图、`after`。`baseline-all` 的会话在 `BASELINE_SESSIONS`：

- `baseline-shelf`：`settings` → `new-project`。不预置作品，`new-project` 要在空项目目录里建「灯塔」，与示例作品不能共存。
- `baseline-sample`：`open-sample` → `write-chapter` → `run-panel` → `review` → `revise-merge` → `finalize`。预置一次带草稿_v1 的示例作品，后面每步接着上一步的状态。

改动前 `baseline-all` 每个场景各冷启动一次（8 次）；现在 2 次。

## 不进 baseline-all 的场景

`scenarios.mjs` 的 `EXTRA_SCENARIOS` 只能单跑，不进 `baseline-all`。`run` 的返回值写进结果的 `measured`。需要卡住模型调用时，场景从上下文的 `fake.gate` 调 `hold()`，在 `after` 里 `release()`。`hold()` 只卡对话请求；只走嵌入的步骤（参考文本入库）用 `hold({ embeddings: true })` 连嵌入一起卡。`fake.gate.waiting` 是正卡在门上的请求数，截图前等它大于 0，画面才停在确定的那一步。

| 名称 | 检查 | 单跑时截图停在 | 用夹具模型 |
|---|---|---|---|
| `write-latency` | 在渲染进程里计时：点击写作此章弹窗的「开始创作」到 AI 输出标题可见，写进 `measured.writeToOutputMs`。RD-4 起旧外壳右栏默认是 AI 输出，计时前只在它开着时收起，trunk 不受影响 | 写作完成 | 是 |
| `nav-switch-project` | 角色视图加沉浸写作时从标题栏切换到另一部作品，断言退出沉浸、侧栏显示项目树 | 新作品的小说配置页 | 否 |
| `nav-toast-open` | 写作完成后再点右侧栏「AI 输出」收起它，点完成提示「打开查看」，断言 AI 输出重新出现 | AI 输出里的「第1章候选」 | 是 |
| `nav-status-capsule` | 卡住模型让写作停在运行中，收起 AI 输出后点状态栏任务胶囊，断言 AI 输出出现 | 运行中的 AI 输出 | 是 |
| `nav-settings-model` | 先从标题栏「备份」打开设置并关闭，再点状态栏模型，断言落在「AI 生成模型」 | 设置弹窗的模型分组 | 是 |
| `nav-kb-import` | 关掉底部面板后在「小说」视图导入创作资料并确认发送，断言底部面板打开且停在「任务」 | 知识库页与任务面板 | 是 |
| `nav-card-import` | 关掉底部面板后在「角色」视图粘贴角色卡并确认发送，断言底部面板打开且停在「任务」 | 角色页与任务面板 | 是 |
| `nav-batch` | 关掉底部面板后从章节蓝图启动 1 章批量创作，断言底部面板打开且停在「任务」 | 批量创作运行中 | 是 |
| `nav-home-import` | 回到首页，点「小说拆解」把参考小说导入当前作品，连嵌入一起卡住模型，断言离开首页、项目树与 AI 输出出现 | 项目树刷新完成，第 1 步「导入参考文本与构建知识库」卡在第一个嵌入请求上 | 是 |
| `settings-appearance` | 旧外壳打开设置并切到「外观」。head 比 trunk 多「界面布局」一组，两边截图不同是预期 | 设置的外观分区 | 否 |
| `nav-immersive-twice` | 关掉底部面板后两次切换沉浸写作，断言三块面板恢复到切换前 | 恢复后的工作台 | 否 |
| `nav-plot-blueprint-source` | 生成剧情树（假模型回复不是 JSON，落到按蓝图的确定性剧情树），从事件来源打开第 1、2 章蓝图；第 1 章标题改了不保存，断言切换选中后改动仍在，手动选第 2 章后再点第 1 章来源会重新选中第 1 章 | 章节蓝图选中第 1 章、标题有未保存改动 | 是 |

`nav-` 场景对 trunk（`--app-root`）与 head 各跑一次，两边都通过即行为一致。`write-latency` 与 `startup-timing` 一样交替各跑 5 次取中位数。

上面这段和 `settings-appearance` 的「head 比 trunk 多」都是 RD-10 之前的做法。RD-10 起 head 没有旧外壳，`nav-*`、`write-latency`、`settings-appearance` 对 head 跑必然失败：它们只对 trunk 跑，head 一侧改跑对应的纸墨外壳场景（设置类用 `stage-settings-*`，其余按页面在 `rd-stage-scenarios.md` 里找），分类见 `driver.md`「RD-10 删除旧外壳之后」。当前构建没有等价的 `writeToOutputMs` 测量，`write-latency` 的 trunk 与 head 对比不可用；`write-stream` 测的是流式出字，不是同一指标。
