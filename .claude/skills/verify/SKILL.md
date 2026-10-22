---
name: verify
description: 在真实 Electron 中驱动 AI 小说作家，按场景截图、记录启动耗时并读取只读诊断。前端重设计 RD-0 至 RD-10 每个 PR 的实机验证都走这里。用于「实机验证」「截图对比」「跑一下界面场景」。
---

# verify

驱动脚本是 `scripts/redesign/drive.mjs`。它用 Playwright 的 `_electron` 启动当前工作树的构建产物（`electron .`），每个会话（一次冷启动）一个全新的隔离目录，模型调用全部走本机假服务，不调用真实模型。单跑一个场景就是只含这个场景的会话。

应用窗口不出现在屏幕上。驱动用 `electron -r scripts/redesign/offscreen-window.cjs` 在应用主进程脚本之前挂上 `browser-window-created` 监听：窗口一创建就移到所有显示器右侧之外，去掉任务栏按钮，设为不可激活并交还焦点，不打扰正在用电脑的人。截图走页面视口，与窗口位置无关；页面焦点由 Playwright 的焦点模拟提供，`document.hasFocus()` 仍为 true。每次截图前断言 `document.visibilityState` 为 `visible`，防止屏幕外窗口被当作隐藏而停帧。

## 启动前

在要验证的工作树根目录依次运行：

```bash
pnpm install --frozen-lockfile
pnpm rebuild:electron
pnpm build
```

驱动加载的是 `dist/` 与 `dist-electron/`，改了 `src/` 或 `electron/` 必须重新 `pnpm build`。`better-sqlite3` 刚为 vitest 切到 Node ABI（`pnpm prepare:native-node`）时，先 `pnpm rebuild:electron` 再驱动。

## 命令

```bash
pnpm verify:drive -- --scenario <名称> [--theme light|dark] [--shell writer|stage] [--out <目录>] [--dump-dom] [--console] [--video] [--app-root <目录>]
# 等价于
node scripts/redesign/drive.mjs --scenario <名称> ...
```

- `--theme` 默认 `light`，即外观里的「浅色」；`dark` 为「深色」。
- `--shell` 只对 RD-10 之前的构建（`--app-root` 指向的 trunk）有意义：不给时不碰外观里的外壳偏好（旧外壳），`stage` 选 RD-3 起的流程脊外壳，与主题在同一次写入里改，只重载一次；RD-2 及更早的 trunk 不认识 `stage`，不要传。RD-10 起的构建只有纸墨外壳，外观写在 v3 键里，没有外壳偏好：`--shell` 不必传，传 `writer` 直接报错。
- `--video` 在每个截图点的 `run` 期间录屏：CDP `Page.startScreencast` 收帧，按帧时间戳交给本机 `ffmpeg` 编成 H.264 mp4，写到 `<场景>-<主题>.mp4`。不需要 Playwright 自带的 ffmpeg。
- `--out` 默认 `.runtime/redesign-baseline/`（已被 git 忽略）。
- `--app-root` 默认当前工作树。性能对照时指向 trunk 的工作树，用同一个驱动测两边；目标工作树也要先跑完上面三条命令，它加载的是自己的 `dist-electron/` 和 `better-sqlite3`。
- 退出码：0 全部通过；1 有场景失败、残留进程或隔离目录外写入；2 参数错误。

RD-10 删除旧外壳之后，场景分三类：

- 只走旧外壳的场景只对 trunk 跑（`--app-root`）：下面「场景」表的 8 个基线场景与 `baseline-all`、`nav-*`、`write-latency`、`settings-appearance`、`run-write-steps`、`legacy-no-chat`、`arch-legacy-sidebar`。对照时 head 一侧改跑对应的新外壳场景。
- 两种外壳都能跑的场景运行时按页面上有没有纸墨外壳选页面对象，head 与 trunk 用同一条命令：`startup-timing`、`idle-memory`、`chapter-switch`、`chapter-open`、`typing-latency`、`chapter-regression`、`blueprint-regression`、`blueprint-timing`、`refs-regression`、`refs-timing`、`new-project-files`。
- 其余声明了 `shell: 'stage'` 的场景只对 RD-3 及以后的构建跑。

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

## 输出

在 `--out` 目录下：

- `<场景>-<主题>.png`：场景截图，1440×900（`stage-1280` 为 1280×900）。
- `--video` 时另有 `<场景>-<主题>.mp4`，结果项的 `video` 字段指向它。
- `<场景>-<主题>.json`：本次运行的结果数组，每个截图点一项。`scenario`、`screenshot` 属于这个截图点；`session`（会话名，单跑时等于场景名）、`timing`、`shell`（外壳的 `data-shell-presentation`，`writer` 或 `stage`：`startup-timing` 取计时那次启动显示的外壳，其余场景取写好外观、重载之后的外壳，用来确认测的就是要测的外壳）、`externalRequests`、`residualProcesses`、`externalWrites`、`quit`、`isolationRoot` 属于整个会话，会话里每一项都抄一份；会话用了夹具模型时另含 `modelRequests`（整个会话里假服务收到的全部请求数，嵌入请求也计入，与 `--console` 里的 `[fake-model]` 行一一对应）。失败时含 `error`：截图点自己的失败写在该项；同一会话里排在失败点之后的截图点不再运行，`error` 写明是被哪个场景拖住；会话级失败（启动、外部请求、退出、进程枚举）写进该会话的每一项。
- 失败时额外写 `<失败场景>-<主题>.failure.png`、`.dom.html`、`.aria.yml` 和 `<会话>-<主题>.console.log`，隔离目录保留以便排查。

每个会话结束后，驱动检查三件事，任一不满足即退出码 1：

- `externalRequests` 为空。每个会话都在 Electron 启动后替换主进程的 `globalThis.fetch`：用夹具模型的会话只放行 `https://api.openai.com/v1/*` 并改道到本机假服务，其余会话一律不放行。被拒的请求记下来源并抛错。检查范围只有主进程 `fetch`，且从 `electron.launch` 返回后才生效；更早的请求、渲染进程的请求和 Electron `net` 模块的请求都不在内。
- `residualProcesses` 为空：应用关闭后，以 `--user-data-dir` 匹配不到存活进程。子进程退出需要时间，驱动最多查 10 次、间隔 300 ms。
- `externalWrites` 为空：`~/.vela`、`%APPDATA%\ai-novel-writer`、`%APPDATA%\AI小说作家` 的最新修改时间不变。

枚举或结束进程本身失败时，原因写进该会话每一项的 `error`，结果 JSON 照常写出。

## 只读诊断

```bash
node scripts/redesign/drive.mjs --scenario open-sample --dump-dom --console --out <目录>
```

- `--dump-dom` 在每个截图点截图后写 `<场景>-<主题>.dom.html`（`page.content()`）和 `.aria.yml`（Playwright 无障碍快照）。改页面对象前先看 `.aria.yml`，选择器优先用其中的角色与可访问名称。
- `--console` 每个会话写一份 `<会话>-<主题>.console.log`（单跑时会话名就是场景名，`baseline-all` 为 `baseline-shelf`、`baseline-sample`）：渲染进程控制台、页面异常、主进程 stdout/stderr，以及假模型每次请求的分类（`[fake-model] prose|review|revision|character-state|embedding`）。

## 截图可重复性

同一场景连续跑三次再比较：

```bash
for i in 1 2 3; do node scripts/redesign/drive.mjs --scenario review --out shots/r$i; done
node scripts/redesign/pixel-diff.mjs shots/r1/review-light.png shots/r2/review-light.png shots/r3/review-light.png
```

`pixel-diff.mjs` 输出各张相对第一张的不同像素占比，`maxRatio` 小于 0.005 时退出码 0，否则 1。尺寸与第一张不同的图记为全部不同（`ratio` 为 1），`reason` 写明两边尺寸。任一通道差值超过 2 级才算不同像素（`ratio`），因为同一状态连续截图时，渲染器在背景模糊和渐变上偶发全屏 ±1～2 级抖动；逐字节比较的结果另列为 `strictRatio`，供判断差异是不是这种抖动。

## 启动耗时

`startup-timing` 的 `timing` 字段：`readyToShowToInteractiveMs`（主窗口 `ready-to-show` 到书房「新建作品」按钮可见，计划里的性能指标）、`launchToInteractiveMs`、`navigationToInteractiveMs`。`ready-to-show` 监听在预加载脚本里、先于移窗挂上，窗口创建前就已就位，所以每次都有值。trunk 与 head 交替各跑 5 次取中位数：

```bash
node scripts/redesign/drive.mjs --scenario startup-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario startup-timing --out <目录>
```

## 空闲内存

`idle-memory` 与 `startup-timing` 一样先在同一隔离目录预启动一次写好主题，再冷启动一次；第二次启动到书房可交互后静置 10 秒，再每隔 1 秒用 `app.getAppMetrics()` 采样 5 次全部进程的内存，结果写进 `memory`：`workingSetKB`、`privateKB`（Windows 才有私有字节）是各次合计的中位数，`byType` 按进程类型（Browser、Tab、GPU、Utility 等）各取工作集中位数，`samples` 是采样次数。不截图、不用夹具模型。计划 RD-10 的性能复测与启动耗时交替跑：trunk 与 head 各 5 次，取中位数比较，跑的时候机器上不开别的程序。

```bash
node scripts/redesign/drive.mjs --scenario idle-memory --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario idle-memory --out <目录>
```

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

## 新外壳（RD-3 起）

页面对象在 `scripts/redesign/pages/stage.mjs`，选择器用角色与可访问名称（流程脊是 `navigation`「创作流程」，章节是其中的列表「章节」，标签条是 `tablist`「已打开的页面」，顶栏是 `banner`）。示例作品在 `scripts/redesign/stage-sample.mjs`：「灯塔」12 章全有蓝图，架构四节齐全，1、2 章定稿，3 章已审稿，4 章草稿，其余待写；与旧外壳基线的 SAMPLE 分开，基线截图不受影响。打开后落在第 4 章（几章都在写时取最后一章在写的，#407 第 2 轮用户决定）；`seedStageSample` 默认等落点后切到第 3 章并关掉第 4 章标签，场景都从只开着第 3 章开始（对照用的旧构建本来就落在第 3 章，不切）。两种外壳都能用这份示例：新外壳从书房打开，旧外壳从项目树打开第 3 章草稿。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `stage-open-sample` | 流程脊四个阶段的状态（设定、架构、蓝图完成，正文进行中）、章节阶段、当前章为 3、只有一个标签时标签条收起、外壳文字对比度（普通字号的文字连同说明文字 4.5:1，图标按钮 3:1，底色沿祖先叠加求出） | 第 3 章正文 | 否 | lane 1 的新外壳部分、lane 2（浅色）、lane 3（`--theme dark`） |
| `stage-tabs` | 依次打开设定与蓝图共三个标签，关掉一个后还剩两个且标签条仍在；`after` 再关一个，标签条收起 | 两个标签 | 否 | lane 4 |
| `stage-dirty-close` | 改设定页后关「设定」标签，出现危险确认；`after` 点「继续编辑」，标签与修改都在 | 危险确认对话框 | 否 | lane 5 |
| `stage-save` | 改小说配置，顶栏变「未保存」，Ctrl S 后变「已保存」 | 已保存 | 否 | lane 6 |
| `stage-find-chapter` | Ctrl P 输入「4」回车打开第 4 章，再输入「第3章」打开第 3 章，流程脊当前章随之变化 | 第 3 章正文 | 否 | lane 7 |
| `stage-focus` | 沉浸写作后流程脊与标签条消失，正文与章节动作条（AI 审稿等）在；`after` 按 Esc 恢复 | 沉浸写作 | 否 | lane 8 |
| `stage-1280` | 视口 1280×900：页面无横向滚动，外壳里的名称、章名、位置、搜索提示、保存状态都没有被截断或折行 | 1280 宽 | 否 | lane 9 |
| `stage-migrate` | RD-10 起：去掉 v3 键、在旧键写入 RD-10 之前的配置后重载，galaxy（v1、旧外壳偏好）与 paper（v2）各走一遍：进入纸墨外壳且不出现启动阻塞，galaxy 迁成深色、paper 迁成浅色，缩放照旧，旧键逐字节不变（供回滚） | 纸墨外壳 | 否 | RD-10 lane 3、4 |
| `stage-palette` | Ctrl K 输入「灯」，结果里有第 6 章；`after` 按 Esc 关闭 | Ctrl K 结果 | 否 | |
| `stage-run` | 卡住模型后从章节蓝图写下一章：运行侧页自动打开，顶栏胶囊展开并显示进度；`after` 先确认侧页开着时 Ctrl K 仍能打开搜索（侧页不是模态层），再放行、等侧页里「上一次运行」显示已完成、新草稿打开 | 运行侧页与胶囊 | 是 | |
| `stage-library` | 没有打开作品时是书房，没有流程脊；书架空着时唯一的主按钮是「新建作品」，没有模型时有「还没有连接 AI 模型」引导；书房文字对比度 | 空书房 | 否 | RD-5 lane 2 |
| `stage-modal-layers` | 改设定后从作品菜单打开旧的「导出项目」对话框：Ctrl K 不开搜索、Ctrl W 不弹放弃确认；从主进程关窗，退出确认画在对话框之上（`isTopmost` 让所有元素参与命中测试后取中心点最上层元素）；`after` 取消退出并关掉导出。RD-5 起设置是页面而不是弹窗，所以模态层改用导出对话框；Radix 对话框会把退出确认设为 aria-hidden，页面对象 `exitDialog` 按类名找它 | 退出确认 | 否 | 第 3 条 |
| `stage-close-key` | 书房里、搜索框里各按一次 Ctrl W，页面都拦下（`defaultPrevented`），应用仍在。应用菜单有 CommandOrControl+W 的「关闭」，但驱动注入的按键到不了菜单快捷键，所以断言的是拦截 | 搜索框 | 否 | 第 4 条 |
| `stage-reopen` | 从作品菜单回到书房，用 Ctrl K「打开《灯塔》」重新打开同一部作品（新的项目会话），再次落到最后一章在写的第 4 章 | 第 4 章正文 | 否 | 第 8 条 |
| `stage-partial-blueprint` | 规划 100 章、只有 12 章蓝图：蓝图算完成，落点仍是正文第 4 章 | 第 4 章正文 | 否 | 第 6 条 |
| `stage-revert-after-final` | 第 1 章定稿后再建一份新草稿（版本历史「回退到此版本」的效果）：第 1 章回到草稿，但最后一章在写的仍是第 4 章，打开作品落在第 4 章；章节列表里第 1 章按草稿显示，点它打开的是新草稿 | 第 1 章新草稿 | 否 | 第 7 条 |
| `stage-new-project` | 新外壳里新建作品：设定进行中、其余未开始；外壳文字对比度、进度环半径 8.5、设定说明在名字下一行、作品资料图标跟随行文字色 | 新作品首屏 | 否 | 第 20、23、24 条 |
| `stage-focus-search` | 沉浸写作里 Ctrl F 打开正文搜索，Esc 只关搜索框、不退出沉浸；`after` 再按 Esc 退出沉浸 | 沉浸写作 | 否 | 第 10 条 |
| `stage-tour` | 30–60 秒的导览：四个阶段、Ctrl K、Ctrl P、关标签、沉浸写作、写一章看运行胶囊与侧页。配 `--video` 录评审视频 | 写完一章 | 是 | Review gate |
| `chapter-switch` | 打开第 3 章后，从点击第 4 章到它的正文在编辑器里可见，渲染进程内按帧计时，写进 `measured.chapterSwitchMs`。旧外壳点草稿箱里的草稿，新外壳点流程脊里的章 | 第 4 章正文 | 否 | perf |

lane 1 的旧外壳部分：head 与 trunk 各跑一次 `baseline-all`，逐张 `pixel-diff.mjs`，`maxRatio` 小于 0.005。

perf：三组交替，各预热 2 次不计，再各计 5 次：trunk 旧外壳、head 旧外壳、head 新外壳。head 旧外壳对 trunk 旧外壳量的是新外壳模块被 `App.tsx` 静态引入后旧外壳用户付出的启动代价。这是 RD-3 到 RD-9 的做法；RD-10 起 head 没有旧外壳，只比 trunk 旧外壳与 head 纸墨外壳两组，下面带 `--shell stage` 的命令对 head 去掉 `--shell`。

```bash
node scripts/redesign/drive.mjs --scenario startup-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario startup-timing --out <目录>
node scripts/redesign/drive.mjs --scenario startup-timing --shell stage --out <目录>
node scripts/redesign/drive.mjs --scenario chapter-switch --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario chapter-switch --shell stage --out <目录>
```

`startup-timing` 三组都先在同一隔离目录启动一次写好主题（新外壳另写外壳偏好）再退出，计时的是之后那次冷启动；首次启动还要迁移旧配置、建库，与之后的启动不可比，所以两侧都不计首次。启动计时以驱动发现「新建作品」可见为准，Playwright 的轮询间隔随等待时间变长，所以晚出现的界面会被多计一些。

## 运行侧页（RD-4 起）

场景在 `scripts/redesign/run-scenarios.mjs`，页面对象在 `scripts/redesign/pages/run-sheet.mjs`（侧页是 `complementary`「运行」，分页是其中的 `tab`，运行与恢复项是 `article`，按标题命名）。假模型另有两种回复：`fake.streamProse({ chunks, intervalMs })` 之后的正文按块定速流出，每块发出的时刻记进 `fake.streamLog`；`fake.replyCharacterCards()` 之后，提示词里有「【资料 」时回一份角色提取 JSON（守塔人与林岚），不开时照旧回正文、提取失败。复制类操作在页面里改写 `navigator.clipboard.writeText` 记录内容，不碰系统剪贴板。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `run-write-steps` | 旧外壳写一章，`measured` 记下 AI 输出里的步骤名、正文与聊天按钮、「写作助手」区域的数量；head 与 trunk 各跑一次对照 | 写完的 AI 输出 | 是 | lane 1 |
| `run-live` | 正文定速流出时侧页「进行中」展开当前步骤，实时输出的句数持续增加 | 正文流到一半 | 是 | lane 2 |
| `run-cancel` | 卡住模型后在运行卡片上点「取消」：没有进行中的运行，顶栏胶囊消失，「上一次运行」写明已取消 | 取消后的侧页 | 是 | lane 3 |
| `run-batch` | 删掉 3、4 章草稿后批量写两章：Ctrl P 里只有正在写的第 3 章标生成中；暂停后本章写完即停，2 秒内不再有模型请求，没有章标生成中；`after` 继续并写完 | 已暂停 | 是 | lane 4 |
| `run-confirm` | 从角色页粘贴两张角色卡：侧页出现「等你确认」与两个采用方式；`after` 林岚对应已有、守塔人新建，确认后角色列表多了守塔人、林岚仍只有一个 | 等你确认 | 是 | lane 5 |
| `run-discard` | 预置一条恢复候选：复制得到原文；「放弃…」出现就地确认条且焦点在「保留」；`after` 确认放弃，收起再打开侧页（重新读取）后候选不再列出 | 就地确认条 | 否 | lane 6 |
| `run-diagnostics` | 预置三条调用记录后写一章：诊断分页是宽版，调用表有预置的三行加上这次写作真实发出的请求（#442 起主进程生成也记账，现为 5 行），复制安全诊断不含正文与密钥，界面文字没有 token（日志行原文除外） | 诊断分页 | 是 | lane 7 |
| `run-en` | 切到英文重载：Ctrl K 搜 assistant、agent、chat 都没有结果；写一章时侧页分页是英文，整页没有聊天字样 | 英文的进行中 | 是 | lane 8 |
| `legacy-no-chat` | 旧外壳：右侧栏只有「AI 输出」，没有 Agent 按钮，右侧区域名为「AI 输出」，整页没有聊天字样；再点一次收起、再点打开 | AI 输出 | 否 | lane 9 |
| `run-olddata` | 预置一条助手任务（两轮历史加一轮回复）：打开作品与运行侧页没有报错，界面没有调用任何 `agent-generation:*`（在主进程里包一层 invoke 计数），侧页不列助手任务；`after` 重开读出的对话内容与之前相同，项目目录里数据库以外的文件没有改动 | 进行中 | 是 | lane 10 |
| `run-tour` | 30–60 秒的导览：定速写一章看实时输出与完成，历史里展开这次运行，诊断宽版，放弃恢复候选的就地确认后选「保留」，收起侧页再用 Ctrl K 打开。配 `--video` 录评审视频 | 进行中 | 是 | Review gate |
| `write-stream` | 60 块、每块 50 字、间隔 50 ms 的正文流出（3000 字）：`measured.fps` 是第一块到最后一块显示之间的帧率，`appendMedianMs`、`appendP95Ms` 是每块从假模型发出到出现在界面上的延迟。两种外壳都能跑，用 `--shell stage` 选新外壳 | 写完一章 | 是 | perf |

`run-olddata` 的状态对比只看对话内容：重开作品时主进程会把旧会话里没写完的助手任务登记为暂停、改期限，这是主进程的租约记账，与界面无关。

## 书房、设定与设置（RD-5 起）

书房、设定页与设置页的页面对象也在 `pages/stage.mjs`：书架是列表「最近的作品」，封面按钮叫「预览《书名》」，右侧概览是区域「《书名》概览」，里面唯一的主按钮是「打开《书名》」（只预览的书）或「继续写作 · 下一步」（当前作品）；每本书的更多操作是「《书名》更多操作」菜单。`openFromLibrary` 先点封面再点「打开《书名》」，`openFromPalette` 从 Ctrl K 打开（同一部作品也会开新的会话）。新建作品的对话框旧外壳叫「新建小说项目」，新外壳叫「新建作品」，`bookshelf.createProject` 两种都认。设定页的核心大纲是文本框「核心大纲」（缺这项时名字带「 · 必填」），三项必填是下拉「类型」「目标读者」与一组「篇幅」，更多设定是按钮组「更多设定」，展开的每项是同名区域；`dirtySetup` 在核心大纲末尾补一句。假模型认出配置 JSON 合同的提示词时返回 `FIXTURE_CONFIG`。设置页是导航「设置分组」，每页标题是一级标题；`openSettings` 从流程脊打开，`showSettingsPage` 切页，`closeSettings` 点「返回作品／返回书房」。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `stage-library-preview` | 预置示例作品但不打开，点封面预览：概览的阶段进度里架构、蓝图完成，正文进行中；没有流程脊（没有打开）；唯一的主按钮是「打开《灯塔》」；文字对比度 | 预览概览 | 否 | lane 3 |
| `stage-library-remove` | 回到书房，书本菜单「从最近项目移除…」出现确认；`after` 确认后封面消失、作品文件夹仍在 | 移除确认 | 否 | lane 4 |
| `stage-library-delete` | 当前作品的书本菜单「删除作品…」，输入「灯」时「删除作品」禁用；`after` 输入完整书名后可用，再取消，文件夹仍在 | 删除确认（名字不对） | 否 | lane 5 |
| `stage-update-card` | 夹具更新源（`stubUpdates` 替换主进程的更新 IPC，安装只计数）；设定页改一项未保存，回书房点「下载更新」再点「立即重启更新」，出现「请先处理未保存的修改」与「返回保存」；`after` 返回保存，安装次数为 0 | 更新拦截 | 否 | lane 10 |
| `stage-setup-required` | 新外壳新建「雾岛」，写核心大纲、选类型，不选目标读者：「下一步：故事架构」禁用，提示「选好目标读者就能继续」并由 `aria-describedby` 关联；设定页唯一的主按钮；对比度；`after` 选目标读者后点下一步，先保存再到架构 | 必填未齐 | 否 | lane 6 |
| `stage-setup-fill` | 示例作品的设定页点「AI 补全其余设定」，确认扩写已有内容；夹具按配置 JSON 合同返回（`FIXTURE_CONFIG`），世界观被填上、核心大纲保留作者原文；再改世界观，设定变为未保存 | 补全后的世界观 | 是 | lane 7 |
| `stage-settings-groups` | 从流程脊打开设置：分组为常用（AI 模型、外观）、高级（检索模型、网络代理、提示词模板、写作 Skills）、其他（项目备份、关于与更新），落在 AI 模型，位置为「设置 / AI 模型」；外观里放大到 105% 再还原；外观页没有主按钮；对比度；`after` 按 Esc 回到第 3 章 | 外观 | 否 | You see、缩放移入外观 |
| `stage-settings-dark` | 设置 → 外观 → 主题选「深色」，外壳变深色；`context.restart()` 退出应用再用同一隔离目录冷启动，仍是深色，外观里「深色」仍选中；深色对比度 | 深色外观 | 否 | lane 8 |
| `stage-settings-model` | 设置 → AI 模型，夹具模型的更多操作「删除模型…」出现危险确认；`after` 取消，模型还在 | 删除模型确认 | 否 | lane 9 |
| `stage-first-model` | 全新配置的空书房点「还没有连接 AI 模型」里的「添加模型」，落在设置的 AI 模型，空状态「还没有添加模型」，唯一的主按钮是添加模型 | 首次使用的模型页 | 否 | 附录 A 首次使用 |
| `stage-rd5-tour` | 30–60 秒的 RD-5 导览：空书房、新建「雾岛」进入设定页、写核心大纲并补齐必填、展开「文风」、下一步到架构、设置的 AI 模型与外观（切深色再切回）、关于与更新、回书房看书架、删除作品确认（名字不对时禁用）。配 `--video` 录评审视频 | 书房 | 否 | Review gate |
| `library-timing` | 计时会话（与 `startup-timing` 同样先预启动一次，另用公开 IPC 新建 20 部作品）：`readyToShowToInteractiveMs`（书房「新建作品」可见），以及页面里记下的 `renderInteractiveMs`（「新建作品」进入 DOM）与 `renderShelfMs`（20 个「预览《书名》」按钮都进入 DOM），都以导航开始为 0。旧欢迎页与新书房的书本按钮同名，所以对 trunk 也能跑 | 不截图 | 否 | perf |
| `stage-lazy-retry` | 主进程 `webRequest` 拦下设定页代码块（`blockChunks`），重载后打开示例作品点「设定」，出现「页面没有载入」与「重试」；`after` 放行后点重试，设定页出现，且请求日志里有带 `?retry=` 的设定页代码块 | 载入失败 | 否 | RD-5 修复第 1 轮 |
| `stage-setup-save-fail` | 设定页改一句后让 `project:save` 返回失败（`failProjectSaves` 换掉主进程处理函数）：Ctrl S 与「下一步」都在页脚出现 role=alert 的失败说明，仍停在设定、仍是未保存；`after` 换回处理函数再点保存，变为已保存、失败说明消失 | 保存失败 | 否 | RD-5 修复第 1 轮 |
| `stage-error-code-display` | 主进程的错误码在显示处按界面语言说明（#474）：选好上级文件夹后换成同名新文件夹再新建作品，断言 `measured.createAfterParentReplaced` 是主进程原样返回的 `Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED`；试改名打开着的作品文件夹（Windows 上被作品库占用，`measured.rename` 为 `EPERM`；改得动也立刻改回），再让 `kb:clear-all` 返回 `PROJECT_SESSION_STALE`；中文、英文各从知识库清空一次，提示是登记的说明、没有裸错误码 | 中文、英文的报错提示（`stage-error-code-display-zh`、`-en`） | 否 | #474 渲染层消费处 |
| `stage-setup-short` | 新建「雾岛」：必填项先不标红；1440×900、1280×800、1280×720 下「类型」「目标读者」都在底栏之上；`after` 点开「全局写作要求」，面板不在底栏后面、焦点在它的输入框里 | 1280×720 设定页 | 否 | RD-5 修复第 1 轮 |
| `stage-settings-legacy` | 模型编辑表单的输入框 40px 高；`context.shoot` 中途拍下模型编辑、提示词模板、写作 Skills；项目备份页只有「导出本地存档」一个实心主按钮 | 项目备份 | 否 | RD-5 修复第 1 轮 |
| `stage-settings-leave` | 编辑夹具模型改名，输入框里按 Esc 设置页不关；焦点移出后 Esc 弹「放弃未保存的修改？」；`after` 继续编辑修改还在，「返回作品」再确认放弃才关；再开设置页从 Ctrl K 选「角色」，设置页收起、「角色」标签选中 | 放弃确认 | 否 | RD-5 修复第 1 轮 |
| `stage-settings-leave-work` | 作品里开着两个标签，设置页改了夹具模型名、不保存：标签条不显示；依次从流程脊阶段「架构」、流程脊资料「剧情与伏笔」、Ctrl K「蓝图」、Ctrl P「旧港」、Ctrl K「回到书房」、作品菜单「回到书房」离开，每次先弹「放弃未保存的修改？」，「继续编辑」后设置页与输入都在，再走一次选「放弃修改」才到去处 | 每个入口的确认（`leave-<入口>`） | 否 | RD-5 修复第 2 轮 |
| `stage-settings-leave-library` | 书房里从顶栏打开设置、改模型名不保存：Ctrl K「打开《灯塔》」、Ctrl O、Ctrl K「打开作品」（系统对话框打桩为示例作品）、Ctrl N、Ctrl K「新建作品」、Ctrl K「小说拆解与仿写」，每次先确认、继续编辑不走；放弃后打开作品（等「项目数据加载完成」）或弹出新建、拆解对话框 | 每个入口的确认与到达（`leave-`、`arrived-<入口>`） | 否 | RD-5 修复第 2 轮 |
| `new-project-files` | 新建作品后列出作品文件夹里建出的文件（`measured.files`）与 `.ai-novel/project.json` 去掉标识、时间后的形状（`measured.manifest`）。trunk 与 head、两种外壳（`--shell stage`）各跑一次，两项都应一致 | 新建作品后 | 否 | RD-5 lane 1 |

## 页面内计时

计时会话（`startup-timing`、`library-timing`）启动时设环境变量 `DRIVE_RENDER_TIMING`，`offscreen-window.cjs` 据此给默认会话注册页面预加载 `render-timing-preload.cjs`：它在页面脚本之前装好 MutationObserver，把「新建作品」与书架上的书第一次进入 DOM 的时刻（`performance.now()`）写在 `<html>` 的 `data-drive-interactive`、`data-drive-shelf` 上，驱动启动后读出，写进 `timing.renderInteractiveMs`、`timing.renderShelfMs`。它们没有 Playwright 轮询的量化误差。其他场景不注册这个预加载。

## 改外壳时

类名选择器只出现在 `scripts/redesign/pages/`，按任务域分文件：`shell`（启动、外壳就绪、标题栏、状态栏、左右栏与可收起面板）、`bookshelf`（旧外壳书房与两种外壳的新建作品）、`project`（项目树）、`chapter`（单章写作、审稿、修稿合并、定稿）、`run-panel`（运行面板）、`settings`（设置，含外观里切换界面布局）、`materials`（知识库与角色卡导入）、`stage`（新外壳：流程脊、章节列表、标签条、Ctrl K 与 Ctrl P、保存状态、沉浸写作、书房）、`run-sheet`（新外壳的运行侧页）。`shell.waitForShell` 对两种外壳都成立。外壳替换后只改这些页面对象，场景 `scripts/redesign/scenarios.mjs` 不动。

`/.claude/` 在 `.gitignore` 里，提交本文件的改动要用 `git add -f .claude/skills/verify/SKILL.md`（或 `git add -u`）。假模型在 `scripts/redesign/fake-model.mjs`，按提示词特征返回正文、短细纲（与正文同一段文字，但不参与定速流出）、审稿 JSON、修稿正文、角色状态 JSON 或角色提取 JSON。

## 架构阶段与角色名单（RD-6 起）

场景在 `scripts/redesign/arch-scenarios.mjs`，页面对象在 `scripts/redesign/pages/architecture.mjs`（四节是 `region`，按节名命名；角色名单左栏是 `complementary`「角色名单」；生成架构对话框是 `dialog`「生成架构」）。示例作品沿用「灯塔」，按场景清空架构的某几节；示例作品有蓝图与正文，打开后落在写作位置（用户决定 B，#394 §6），场景等落点定下后从流程脊进架构。驱动读库用界面那次打开作品的会话（在主进程里包一层 `project:open` 记下租约），不必重开作品。夹具模型对「本次只写第 N 章」的情节大纲请求回这一章的二级标题与正文。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `arch-regression` | 清空前提、世界观、大纲后从架构页生成（角色名单已预置），`measured` 记下四份文档与哈希；head 与 trunk（`--app-root`，旧故事架构总览）各跑一次，四份文档逐字相同 | 生成完的架构页 | 是 | lane 1 |
| `arch-partial` | 两节已确认：主按钮「继续生成架构」且只有一个、「下一步：章节蓝图」置灰，四节徽标，流程脊同为 2 / 4，角色名单一节列出林岚 | 架构页 | 否 | lane 2 |
| `arch-done` | 四节已确认：主按钮「下一步：章节蓝图」；`after` 点它进入蓝图 | 架构页 | 否 | lane 3 |
| `arch-confirm` | 生成架构对话框：勾选已确认的前提标「将覆盖」，角色名单「保留」，空的两节「新生成」 | 对话框 | 否 | lane 4 |
| `arch-resume` | 24 章的大纲先生成 1–10 章，从提示条续写 11–16 章，提示条写明第 17–24 章还没有大纲；部分完成不算已确认（页头与流程脊 3 / 4、主按钮继续生成、下一步置灰），运行侧页两张大纲恢复稿按范围区分；`after` 续写 17–24 章，1–16 章逐字不变、1–24 章各一次 | 第 17–24 章的续写对话框 | 是 | lane 5 |
| `arch-model-change` | 续写第 6–10 章时卡住第 6 章，用 `llm:save-model` 把夹具模型改名保存（等同设置页保存），放行后第 7 章被拒：上一次运行写明模型设置被修改、停在第 7 章、第 6 章在大纲恢复稿且不能覆盖正式内容、正式大纲未被改动、从第 6 章重新生成，有「打开架构页」、没有「继续生成情节大纲」、不出现原始错误码；诊断的 AI 调用记录 6 行（1–5 章与第 6 章）；`after` 点「打开架构页」，生成对话框从第 6 章起，重新生成到 10 / 24 章 | 失败的上一次运行 | 是 | #441 #442 |
| `arch-model-change-last` | 续写第 6–6 章时卡住第 6 章并改名保存夹具模型，候选生成完、正式保存被来源检查拒绝：上一次运行写明正式保存被拒绝、这批大纲在恢复稿且不能覆盖正式内容、从第 6 章重新生成，没有「继续生成情节大纲」、不出现原始错误码；架构页大纲提示只能查看或复制，有「从第 6 章重新生成」、没有「编辑恢复稿」，正式大纲仍是 1–5 章；`after` 从第 6 章重新生成到 6 / 24 章 | 失败的上一次运行 | 是 | #441 |
| `arch-rewrite` | 大纲写到 16 / 24 章后先把第 1–5 章改成作者旧稿，从「AI 重新生成此节…」选第 1–5 章：默认起始章 17，标「将覆盖第 1–5 章」并写明第 6–16 章原样保留，可以提交；`after` 生成后第 6 章起逐字不变、第 1–5 章换成本次结果，大纲仍是部分完成 16 / 24，页头与流程脊 3 / 4 | 第 1–5 章的重写对话框 | 是 | 修复第 2 轮 |
| `arch-legacy-sidebar` | `--shell writer`（发布默认外壳）：大纲分批写到 16 / 24 章，侧栏「故事架构 4/4」，情节大纲一行不是待生成、行内有清空按钮、右键「清空情节大纲」可用；侧栏写「角色名单」 | 右键菜单 | 否 | 修复第 2 轮 |
| `arch-names-en` | 英文界面：四节 Premise、Cast、World、Outline，名单菜单「View cast as text」打开「Cast as text」标签与指向 Cast 页的横幅，没有旧名字，名单底栏「1 character」 | 角色名单 | 否 | 修复第 2 轮 |
| `arch-clear` | 世界观「清空此节…」出现危险确认；`after` 取消，摘要、徽标与数据库里的世界观都不变 | 危险确认 | 否 | lane 6 |
| `arch-cast-save` | 新建「守塔人」并按 Ctrl S 保存：名单、名单投影（`db:character-roster-read` 的 renderedMarkdown）、架构页「2 位角色」与「查看角色名单全文」都有守塔人 | 角色名单 | 否 | lane 7 |
| `arch-graph` | 关系图谱放大、滚轮、拖拽（画面变化）都生效；`after` 点中心节点打开档案 | 关系图谱 | 否 | lane 8 |
| `arch-cards` | 角色名单里粘贴两张角色卡，运行侧页确认后守塔人进名单、林岚仍只有一个 | 角色名单 | 是 | lane 9 |
| `arch-import-dialog` | 导入角色卡对话框与外发确认是同一个纸墨对话框的两步（`.pi-dialog`、底色等于 `--surface`，不另弹确认框）；`after` 返回并关闭 | 外发确认 | 是 | lane 9 |
| `arch-dark` | 用 `--theme dark` 跑（漏传时开头的主题断言失败）：架构页文字对比度达标（名称与正文 4.5:1，说明 3:1），分节卡底色等于 `--paper` 的计算值 | 架构页 | 否 | lane 10 |
| `arch-timing` | 从点流程脊「架构」到四节可交互的毫秒数（`measured.openMs` 按动画帧轮询；`openDomMs` 是 DOM 达到就绪的时刻，屏幕外窗口的动画帧会被节流；`ipcDuringOpen` 是这段时间主进程按通道收到的 invoke 数），200 位角色时角色列表第 1 页滚动帧率（`measured.scrollFps`）。trunk 是旧故事架构标签与旧角色列表，head 是架构阶段与角色名单 | 角色列表 | 否 | perf |
| `arch-tour` | 30～60 秒的导览：四节与主按钮、对话框的覆盖与保留、清空此节的危险确认、角色名单保存与关系图谱。配 `--video` 录评审视频 | 架构页 | 否 | Review gate |

perf 交替各跑 5 次取中位数：

```bash
node scripts/redesign/drive.mjs --scenario arch-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario arch-timing --out <目录>
```

## 蓝图阶段与写作弹层（RD-7 起）

场景在 `scripts/redesign/blueprint-scenarios.mjs`，页面对象在 `scripts/redesign/pages/blueprint.mjs`（章节规划是 `complementary`「章节规划」，单章蓝图是 `region`「第 N 章蓝图」，写作弹层是 `dialog`「本次写作选项」，主按钮「写第 N 章」直接开始写）。新外壳从蓝图写下一章的场景（`stage-run`、`stage-tour`、运行侧页各场景、`write-stream --shell stage`）都改走 `blueprint.writeNext`；旧外壳仍走 `chapter.writeNextChapter`。新外壳写作此章按设定里的每章字数写，不再在写作时填字数，所以示例作品的每章字数是夹具模型一次写得完的 100。假模型另记 `fake.chats`：每次对话请求的种类、模型与消息原文。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `blueprint-regression` | 第 3 章蓝图带出场人物与作者指导，从蓝图写下一章：旧外壳点「写作第 3 章」在对话框里直接开始，新外壳点「写第 3 章」。`measured.requests` 是每次模型请求的种类、模型与消息的 sha256，`proseMessages` 是正文请求原文。trunk（`--app-root`）与 head（`--shell stage`）两边的 `requests` 相同即通过 | 写出的草稿 | 是 | lane 1 |
| `blueprint-page` | 选中第 5 章：标题「逐章规划」、主按钮「写第 3 章」、12 章规划、页头只有一个拆分主按钮、蓝图页文字对比度（名称 4.5:1，说明 3:1；章节规划的状态文字 `.stage-bp-plan-status` 每种状态都查，含默认的待写）。选择器清单是 `blueprint-scenarios.mjs` 的 `PAGE_CONTRAST`，算法与外壳共用 `scenarios.mjs` 的 `contrastFailures`。浅色、深色各跑一次 | 蓝图页 | 否 | lane 2、lane 10（`--theme dark`） |
| `blueprint-popover` | 打开「本次写作选项」：只有本次模型、作者微操指导、折叠的更多（检索关键词），整页只有这一个对话层 | 写作弹层 | 否 | lane 3 |
| `blueprint-preflight` | 主进程里把 `db:continuity-list-before` 换成夹具（第 1 章守塔人已死），点写第 3 章：弹层里出现一致性预检，有保存安排、仅本次忽略、改蓝图后重检，模型没有收到请求；`after` 换回原处理函数后仅本次忽略，写完 | 一致性预检 | 是 | lane 4 |
| `blueprint-overwrite` | AI 生成蓝图选覆盖后开始：生成对话框先收起，危险确认「覆盖已有蓝图？」写明会替换 12 章；`after` 取消后生成对话框原样回来，没有错误提示，蓝图不变 | 覆盖确认 | 否 | lane 5 |
| `blueprint-batch` | 删掉 3、4 章草稿后批量创作 4 章：运行侧页出现批量卡（第 3 至 6 章）；`after` 取消 | 批量卡 | 是 | lane 6 |
| `blueprint-clear` | 更多蓝图操作的危险分组里清空全部蓝图，危险确认后列表为空，出现空状态与 AI 生成蓝图 | 空状态 | 否 | lane 7 |
| `blueprint-recover` | 规划 16 章，生成第 13～16 章蓝图（假模型回正文，生成失败留下恢复稿）：蓝图页出现恢复稿提示条，「编辑恢复稿」打开恢复稿标签，「继续生成缺少的章节」可用；`after` 点它，模型再次收到请求 | 恢复稿标签 | 是 | lane 8 |
| `blueprint-recover-error-en` | 同 `blueprint-recover` 留下恢复稿并打开恢复稿标签，再在外观页把界面语言切成英文；恢复稿改成缺字段的 JSON 后保存：报错是英文、写明哪个位置缺了什么，不带「结构化合同诊断」中文前缀 | 恢复稿的英文报错 | 是 | #474 |
| `blueprint-save` | 改第 6 章标题：整页只有顶栏一处「未保存」，Ctrl S 后变「已保存」，重新加载后标题仍在 | 已保存 | 否 | lane 9 |
| `blueprint-finalize-next` | 第 3 章草稿定稿，设置里开着「定稿后打开下一章」（F-056）：落到第 4 章的单章视图，写作弹层由这一章「写作此章」旁的「本次写作选项」打开（`aria-controls` 指向弹层）并贴着它展开，只弹出写作弹层，没有旧的创作对话框 | 写作弹层 | 是 | F-056 |
| `blueprint-tour` | 30–60 秒导览：选章改标题保存、清空的危险确认、生成蓝图覆盖、批量创作、写作弹层、一致性预检、仅本次忽略后写完。配 `--video` 录评审视频 | 写完一章 | 是 | Review gate |
| `blueprint-timing` | 300 章蓝图：从点蓝图到第 300 章出现在列表里（`openMs`），从点第 150 章到它的标题出现（`switchMs`），渲染进程内按帧计时。旧外壳点项目树「章节蓝图」与列表项，两种外壳都能跑 | 第 150 章 | 否 | perf |

```bash
node scripts/redesign/drive.mjs --scenario blueprint-regression --app-root <trunk 工作树> --out <目录>/trunk
node scripts/redesign/drive.mjs --scenario blueprint-regression --shell stage --out <目录>/head
node scripts/redesign/drive.mjs --scenario blueprint-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario blueprint-timing --shell stage --out <目录>
```

## 正文单章视图（RD-8 起）

场景在 `scripts/redesign/chapter-scenarios.mjs`，页面对象在 `scripts/redesign/pages/chapter-view.mjs`（单章视图是 `.stage-ch`，审稿侧页是 `complementary`「审稿报告」，修稿合并是 `region`「修稿合并」，定稿后处理是 `region`「定稿后处理」，版本切换器是按钮「本章版本：…」，定稿确认是 `dialog`「定稿第 N 章？」）。新外壳打开第 N 章就是单章视图，示例作品第 3 章带一份审稿（已审稿，打开时默认展开审稿侧页）；待写章显示本章蓝图与「写作此章」，草稿状态主按钮是 AI 审稿，已审稿是「按 N 项意见修稿」，有待合并修稿时直接摆出合并视图，已修稿是定稿，定稿后列出后处理各步。假模型另有 `fake.breakCharacterState()`：之后定稿后处理的角色状态更新收到不是 JSON 的回复而失败，传 `false` 恢复；`fake.dropCharacterState(n)`：之后 n 次角色状态请求回 200 后不发内容就断开。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `chapter-regression` | 删掉 3、4 章草稿后写第 3 章，走完审稿、按意见修稿、全部用修稿合并、等复验、定稿；`measured` 是定稿正文的 sha256 与后处理各步成败（从数据库读）。trunk（`--app-root`，旧外壳）与 head（`--shell stage`）两边相同即通过。读库要回书房重开作品，新外壳之后再打开第 3 章 | 定稿视图（新外壳）、书房（旧外壳） | 是 | lane 1 |
| `chapter-draft` | 第 4 章草稿：主按钮 AI 审稿，生命周期停在审稿，版本切换器「草稿 v1 · N 字」 | 草稿 | 否 | lane 2 |
| `chapter-review` | 第 4 章 AI 审稿后侧页展开；取消、再勾一条意见时主按钮「按 N 项意见修稿」与侧页底部「N / 总数」同步 | 审稿侧页 | 是 | lane 3 |
| `chapter-manual` | 添加我的意见后修稿，假模型收到的修稿请求里有这条意见 | 合并视图 | 是 | lane 4 |
| `chapter-merge` | 修稿后合并视图第一处用修稿（多于一处时第二处手动编辑）；`after` 完成合并，正文里是选中的文字 | 逐段选择 | 是 | lane 5 |
| `chapter-finalize` | 第 3 章从「更多」定稿，确认后正文只读，后处理「4 / 4 完成」（正文文件与三步后处理） | 定稿视图 | 是 | lane 6 |
| `chapter-write-after-edited-chain` | 预置第 4 章 v2 以第 3 章候选稿为前驱，再改第 3 章正文；3、4 章逐章定稿后写第 5 章：假模型收到 1 次正文请求，正文保存，运行侧页没有原始 IPC 错误 | 第 5 章与运行侧页 | 是 | #438 |
| `chapter-rereview-legacy` | 第 3 章（旧版本留下的 reviewed 稿）点「重新审稿」：假模型收到 1 次审稿请求，运行侧页没有原始 IPC 错误；恢复卡里的审稿候选显示「1 条意见」摘要，不显示原始 JSON | 第 3 章与运行侧页 | 是 | #411、#455 |
| `chapter-rereview-legacy-en` | 同上重新审稿后切到英文界面重开作品，从 Ctrl K「Run sheet」打开运行侧页：审稿候选显示「1 item」摘要，不显示原始 JSON | 英文运行侧页 | 是 | #455 |
| `chapter-finalize-gone-en` | 切到英文界面后定稿第 3 章，主进程的 `finalization:commit` 先卡住，期间按卡住的请求里的稿 id 与会话删掉这一稿再放行：定稿仓储只交 `DRAFT_NOT_FOUND`，运行卡片的失败说明是英文、不带汉字 | 英文运行卡片的失败说明 | 是 | #474 |
| `chapter-retry` | 角色状态更新失败后点「重试失败步骤」：之后假模型只收到角色状态请求，后处理回到 4 / 4 | 重试后的定稿视图 | 是 | lane 7 |
| `chapter-retry-stream` | 角色状态请求两次断流（`fake.dropCharacterState(2)`）：自动后处理只请求一次，失败说明不含错误码；重开应用后点「重试失败步骤」恰好再请求一次，说明换成「没有返回完整结果」（中途截图 `chapter-retry-stream-failed`）；再点这一步的「重试」第三次请求成功，回到 3 / 3（重开后不列正文文件） | 重试成功后的定稿视图 | 是 | #420 |
| `chapter-selection` | 选中一段：工具条四个纸墨按钮（润色、扩写、续写、改成对话）；润色预览后替换，再选一段润色后取消，原文不变 | 选区工具条 | 是 | lane 8 |
| `chapter-delete` | 第 4 章有 v1、v2：从「更多」删除这一稿出现危险确认；`after` 确认后版本切换器只剩 v1 | 危险确认 | 否 | lane 9 |
| `chapter-1280` | 视口 1280×900（配 `--theme dark`）：第 3 章打开时审稿侧页已展开，收起它后正文一行 32～35 字；运行侧页打开后不少于 24 字，页面没有横向滚动 | 运行侧页与纸面 | 否 | lane 10 |
| `chapter-sheet-landing` | 删掉第 4 章的稿，打开作品落在已审稿的第 3 章：审稿侧页刚出现与 4 秒后都展开（不先开后收）；换到带历史审稿的已定稿第 2 章不展开，「更多」里有审稿报告；回到第 3 章仍展开 | 审稿侧页 | 否 | 侧页归属 |
| `chapter-sheets-1280`、`chapter-sheets-1440` | 第 3 章（已审稿）在该宽度下先开运行侧页、再从「更多」开审稿报告：同一时间只有一个侧页，纸面不被盖住，正文一行不少于 24 字，没有横向滚动 | 审稿侧页与纸面 | 否 | 双侧页 |
| `chapter-focus` | 1440 宽打开第 4 章进入沉浸写作：内容面板无外边距、圆角与阴影（全出血）；底部「N / 设定每章字数 字」与进度条；正文首行缩进 36px | 沉浸写作 | 否 | Focus 画板 |
| `chapter-tour` | 30～60 秒导览：检查维度、审稿侧页与作者意见、按意见修稿、逐段合并、定稿确认、定稿后处理。配 `--video` 录评审视频 | 定稿视图 | 是 | Review gate |
| `chapter-open` | 1 万字的第 5 章：从点击（新外壳点流程脊里的章，旧外壳点草稿箱）到正文出现且所在滚动区可以滚动，毫秒，不取整。`frameMs` 按动画帧检查，`domMs` 在 DOM 变化回调里记，不依赖动画帧 | 第 5 章 | 否 | perf |
| `typing-latency` | 在第 5 章第 1 段末尾连续输入 40 个字母：每键从 `beforeinput` 到正文 DOM 变化（`domP95Ms`）与之后第一帧（`frameP95Ms`） | 第 5 章 | 否 | perf |

```bash
node scripts/redesign/drive.mjs --scenario chapter-regression --app-root <trunk 工作树> --out <目录>/trunk
node scripts/redesign/drive.mjs --scenario chapter-regression --shell stage --out <目录>/head
node scripts/redesign/drive.mjs --scenario chapter-open --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario chapter-open --shell stage --out <目录>
node scripts/redesign/drive.mjs --scenario typing-latency --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario typing-latency --shell stage --out <目录>
```

草稿、审稿、合并、定稿、1280 与沉浸写作各场景都用 `contrastFailures` 核对单章视图的文字对比度（正文与合并栏 4.5，说明文字 3）。屏幕外窗口的动画帧可能被系统节流，`chapter-open` 与 `typing-latency` 都同时报不依赖动画帧的 DOM 口径。RD-X1 起打开作品的默认落点随提交同步落下，读文件树期间打开的运行侧页不再被收起（`x1-run-sheet-keep`）；`afterProjectOpenSettles` 的 2 秒等待是之前留下的，保留无害。审稿侧页属于单章视图，不随落点收起。

## 作品资料页（RD-9 起）

场景在 `scripts/redesign/refs-scenarios.mjs`，页面对象在 `scripts/redesign/pages/refs.mjs`（流程脊「作品资料」里的三个按钮；剧情树是 `table`「剧情树」，线索路线是 `list`「线索路线」，知识库资料是 `navigation`「资料」，版本历史的章节是 `navigation`「章节」、各稿是 `list`「版本时间线」、对比是 `region`「对比」里的 `article`「与当前稿的差异」）。示例作品在 `seedStageSample` 之上加一条伏笔线索「雾钟为何提前」和第 3 章的第二稿。`fake.replyPlotTree()` 之后的剧情树整理回一份两轨 JSON（定稿章与单数位蓝图章进主线「雾钟与沉船」，双数位蓝图章进支线「父亲的地图」），来源取自提示里的资料；不开时假模型回正文，剧情树落到单轨的确定性快照。知识库导入用 `stubOpenFiles` 让系统打开对话框直接返回两份资料，外发提取确认点「取消」。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `refs-regression` | 生成剧情树后从主进程读出快照，`measured.tracks` 是轨道与事件。head 用 `--shell stage`，trunk 用 `--app-root`，两边 `tracks` 逐字相同即通过 | 剧情树 | 是 | lane 1 |
| `refs-plot` | 剧情树两行依次是主线、支线，主线有已定稿发生的事件；页面写明只读快照、不参与写作；点事件后出现「打开来源：第 1 章定稿」 | 选中事件的剧情树 | 是 | lane 2 |
| `refs-clear` | 「更多」里的「清除剧情树…」弹出危险确认；`after` 取消，剧情树仍在 | 危险确认 | 是 | lane 3 |
| `refs-threads` | 线索路线起初是埋设未到、推进不显示、解决未到；记录第 1 章定稿里的变化后，埋设一站变成已发生 | 推进后的线索 | 否 | lane 4 |
| `refs-delete` | 线索行「更多」里的「删除线索…」弹出危险确认；`after` 取消，线索仍在 | 危险确认 | 否 | lane 5 |
| `refs-thread-evidence-en` | 切到英文界面后记录第 1 章定稿里的变化，原文填一句定稿里没有的话：主进程只交 `NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE`，表单里的提示是英文、不带汉字与错误码，作者的输入留着 | 表单里的英文提示 | 否 | #474 |
| `refs-kb-errors-en` | 导入两份资料并打开「守塔人小传」，在外观里切到英文；把这份资料的项目副本文件在磁盘上改掉后编辑并点「Save copy」：主进程只交 `KNOWLEDGE_BASE_COPY_CHANGED`，失败提示是英文；中途拍 `refs-kb-copy-changed-en`。再写坏检索索引登记文件（`.ai-novel/embedding-spaces.json`），到设置「Retrieval model」页：读状态时主进程只交 `EMBEDDING_SPACE_REGISTRY_INVALID`，索引区的提示是英文；两处都不带汉字与错误码 | 检索模型页的英文索引提示 | 是 | #474 |
| `models-test-connection-en` | 在外观里切到英文，到「AI models」编辑夹具模型、把 API Key 改错后点「Test connection」：假服务回 403，provider 只交 `LLM_REQUEST_FAILED` 与状态码，模型表单的结果是英文说明、不带汉字与错误码，假服务没有记到模型请求 | 模型表单的英文连接失败 | 是 | #474 |
| `refs-kb` | 导入两份资料后查「雾钟」，结果片段里标出查找词；整窗文字、可访问名称、提示与占位里没有 LanceDB、FTS、BM25、Embedding、向量、query、MCP、token | 查找结果 | 是 | lane 6 |
| `refs-kb-dirty` | 改了项目副本不保存就点另一份资料，弹出放弃修改的确认；`after` 选「继续编辑」，修改还在，再按 Ctrl S 保存后「有未保存的修改」消失 | 未保存确认 | 是 | lane 7 |
| `refs-diff` | 第 3 章选草稿 v1：对比是 `aria-readonly` 的差异页，标出新增，区域里没有输入框、可编辑元素或编辑器，没有「完成合并」 | 只读对比 | 否 | lane 8 |
| `refs-revert` | 回退到草稿 v1：确认里写明新建草稿 v3；确认后时间线依次是草稿 v3、v2、v1，选 v3 显示「与当前稿相同」 | 回退后的时间线 | 否 | lane 9 |
| `refs-dark` | 用 `--theme dark` 跑：知识库、版本历史、剧情树三页各查一次资料页文字对比度（标题与正文 4.5:1，说明 3:1；选中章序号、选中稿说明与对比里删去的字按 4.5:1），最后再查外壳 | 深色剧情树 | 是 | lane 10 |
| `refs-kb-finalized` | 在第 3 章正文里点「定稿」并确认，等运行侧页写明已完成；知识库「定稿章节 1」里是第 3 章、「我导入的 0」，点开只有「这一章由定稿自动收入」，没有编辑框 | 定稿章节一栏 | 是 | 定稿入库 |
| `refs-narrow-{plot,kb,history}-{1280,1440}` | 视口 1280 或 1440，导入资料后运行侧页开着：剧情树的模型、生成与「更多」同一行，线索名称不折行、「更多」与路线同一行；知识库原文宽不小于 300px；版本对比头的标签都不折行、对比正文宽不小于 420px。`measured.contentWidth` 是内容区宽 | 侧页开着的资料页 | 是 | 窄宽度 |
| `refs-tour` | 30–60 秒的导览：生成剧情树、选事件、清除确认后取消、伏笔线索、导入资料并查找、版本对比、回退新建 v3。配 `--video` 录评审视频 | 剧情与伏笔标签 | 是 | Review gate |
| `refs-timing` | 100 章、每章 5 稿，用夹具模型整理好剧情树并停在剧情树页；计时从点版本历史到第 100 章出现在章节列表（`historyOpenMs`），再从点剧情树到第 1 章事件出现在表格里（`plotOpenMs`），渲染进程内按帧计时 | 剧情树 | 是 | perf |

perf：trunk 与 head 交替各跑 5 次，取两项各自的中位数。head 加 `--shell stage`，trunk 用旧外壳的左栏「历史」「剧情」进入。

```bash
node scripts/redesign/drive.mjs --scenario refs-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario refs-timing --shell stage --out <目录>
```

## 统一视觉层（RD-V）

场景在 `scripts/redesign/visual-scenarios.mjs`，都走新外壳，浅深各跑一次。断言的是浮层渲染进带 `.paper-ink` 的纸墨根或宿主（`#ai-novel-ink-overlay`），才取得到纸墨令牌与深色。对话框类场景截图前等 400 ms，让遮罩与对话框的淡入走完。

| 名称 | 检查 | 截图停在 | 夹具模型 |
|---|---|---|---|
| `rdv-clear` | 作品菜单「清除生成内容…」：标准危险确认，焦点在「取消」，三类内容是勾选行，取消一项后后果句改成「将清除 2 类内容」；`after` 按 Esc 关闭 | 危险确认 | 否 |
| `rdv-alert` | 书房里在同一目录再建一部同名作品，主进程拒绝，命令式 `alertError` 渲染进纸墨宿主，焦点在「确定」，旧「新建小说项目」对话框也在宿主里；`after` 点「确定」 | 叠在新建作品对话框上的错误弹框 | 否 |
| `project-errors-en` | 建好「雾岛」后把界面语言切成英文重载：同一目录再建同名作品（主进程交 `PROJECT_DIRECTORY_EXISTS`），再把作品文件夹删掉后从书房打开（`PROJECT_DIRECTORY_MISSING`），两次报错弹框都是英文、不带汉字与错误码；中途拍 `project-exists-en`、`project-missing-en`；`after` 点「OK」 | 打开已删除作品的英文报错弹框 | 否 |
| `import-run-error-en` | 在外观里切到英文，从作品菜单「Novel breakdown & imitation…」把两章参考小说导入当前作品；主进程的 `kb:import-reference-text` 先卡住，期间按卡住的请求里的执行身份调公开的 `db:import-run-cancel-at-boundary` 收回这次导入的执行租约再放行：导入运行仓储只交 `IMPORT_RUN_EXECUTION_STALE`，运行卡片的失败说明是英文、不带汉字与错误码（#474 B1） | 英文运行卡片的导入失败说明 | 是 |
| `rdv-toasts` | 预置两条调用记录后写一章，在诊断分页连点三次「复制安全诊断」再让剪贴板失败点一次：三次成功合并成一条，出错的另起一条，只有一个提示栈，通知互不重叠，`measured.toasts` 是栈里的条数 | 右下角提示栈 | 是 |
| `rdv-toast-error` | 同上写一章，先复制成功一次让提示栈出现，再打开 Ctrl K 面板（Radix 模态）后让复制失败：出错通知是八角符号，卡片自身不带 `role`，不在 `aria-hidden` 子树里，经挂载点 `#ai-novel-ink-toasts` 的 `aria-live="polite"` 播报（挂载点内没有任何 `role="alert"`），面板仍开着；`after` 按 Esc | 面板上方的出错通知 | 是 |
| `rdv-toast-flood` | 打开样例作品，按 `app.getAppPath()` 找到构建产物 `dist/assets/ToastStack-*.js`，在页面里 import 同一模块（与应用共享栈状态），推入 24 条常驻出错通知：栈在顶栏以下（`top >= 48`）、视口以内，标 `data-overflow` 可滚动，最新一条露在栈底；滚到顶关掉最早那条剩 23 条，中途拍 `rdv-toast-flood-top`。推入函数是按压缩产物里的 `exiting:!1` 找到的，换压缩器或改了条目字段就要改这里 | 滚回底部的满栈 | 否 |
| `rdv-clear-busy` | 主进程的 `db:project-clear-generated-data` 换成永不返回，点「清除所选」：按钮写「清除中…」、`aria-busy`、禁用，三个勾选禁用，Esc 关不掉，指针停在按钮上 | 清除中的危险确认 | 否 |
| `rdv-run-failure` | 粘贴一张角色卡但假模型不回提取 JSON：运行失败，运行卡里的失败提示是朱批（没有底色）；关掉导入对话框 | 运行侧页的失败提示 | 是 |
| `rdv-export` | 作品菜单「导出…」：旧导出对话框 Portal 进纸墨宿主，外壳是 `pi-dialog` | 导出对话框 | 否 |
| `rdv-import-novel` | 作品菜单「小说拆解与仿写…」：旧拆解对话框 Portal 进纸墨宿主 | 拆解对话框 | 否 |
| `rdv-settings` | 从流程脊打开设置，先进「提示词模板」中途拍 `rdv-settings-prompts`，再进「项目备份」；`after` 点「返回作品」。两页都是旧面板，看旧按钮变体在新外壳下换成纸墨按钮 | 项目备份（中途一张提示词模板） | 否 |
| `rdv-tour` | 30–60 秒的评审导览：清除生成内容的危险确认（勾掉一项）、旧导出对话框、写一章后连点「复制安全诊断」看提示栈（两次成功合并，一次失败另起出错通知）、粘贴角色卡看运行失败的朱批提示。配 `--video` 录评审视频 | 运行失败提示 | 是 |
| `rdv-sheet-squeeze` | 从 Ctrl K 打开运行侧页并切到诊断分页，在 1440×900、1280×800、1152×720、1024×768、820×640、683×512 六种视口下（后三种对应界面缩放 125%、150%）逐页走正文、设定、架构、蓝图、角色名单、剧情与伏笔、知识库、版本历史、设置：主区域没有一字一行的文字（一段至少三个字、排出的行数不少于字数的六成）。`measured` 记下每页每个视口的面板、内容区、侧页宽度与侧页是否浮在内容区上：内容区放得下 600px 加普通侧页时并排、内容区不小于 600px，否则侧页浮起、内容区占满面板。设置页在 820 以下只记录不判失败（分组导航固定 232px，另行处理）。之后收起侧页，在 683×512 再拍一遍各页（`-683-closed`）。再在 1076×768（面板 790）把角色名单切到关系图谱、开诊断侧页：图谱工具条落在侧页范围里的按钮，中心点的 `elementFromPoint` 都属于侧页（`toolbarOverSheet` 为空，`-characters-graph-1076`）；最后在 1280×800 切到进行中分页（内容区 614px）拍架构页，`header.sameRow` 记下页头动作是否与标题同一行（`-architecture-1280-active`） | 1280×800 的架构页（侧页在进行中分页） | 否 |
| `rdv-selbar-anchor` | 三击选中第 3 章正文、故事前提文档（ArchFileViewer）里的一行，再在 820×640 开着浮起的运行侧页时选一次：选区工具条底边中点与它内联的视口坐标 top/left 之差（`measured` 的 `dx`、`dy`）都在 2px 内，也就是没有祖先成为它的 fixed 包含块 | 820×640 浮起侧页下的架构文档选区 | 否 |

## 外部审查修复（RD-X1）

场景在 `scripts/redesign/x1-scenarios.mjs`，都走新外壳。竞态用主进程通道上的门稳定复现：`holdChannel(app, 通道, { after })` 卡住接下来的调用，`after: true` 时先交给原处理函数、卡住的是回复（主进程已做完、渲染进程迟迟收不到）；`untilHeld` 等到有调用卡在门上，`releaseChannel` 放行。`recordCalls` 记下通道之后每次调用所属的作品路径，`stubChannel` 把通道换成固定回复并计数；两者遇到主进程没有的通道都直接报错，通道改名后断言不会因为记不到调用而假绿。`seedTwoBooks` 先建「港口」（三章定稿，第 3 章定稿带历史审稿），再建并打开灯塔；两部作品第 3 章的稿 id 相同。假模型另有 `fake.failProse()`：之后的正文回复（含 `streamProse` 的流式回复）以 `content_filter` 结束，写稿在这次打开里失败。蓝图页的 `generateRange` 让「架构还不完整」警告与运行侧页展开竞争等待，调用前运行侧页要收起。除 `x1-open-folder-cancel`（RD-V 栈顶上也应通过）和 `x1-import-overlap`（RD-V 栈顶不适用）外，每个场景对 RD-V 栈顶的构建（`--app-root`）跑一次应失败；所有场景对 head 跑一次都应通过。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `x1-kb-late-read` | 导入两份资料；点「守塔人小传」时读取卡住，切到版本历史再切回，改「沉船名录」后放行：编辑框仍是改过的沉船名录，带未保存标记 | 知识库 | 是 | #388 T1 |
| `x1-setup-leave` | 设定页改一句点「下一步」，保存卡住时回书房，放行后仍在书房 | 书房 | 否 | #380 C4 |
| `x1-settings-section` | 写作 Skills 填地址不保存：Ctrl K「设置」先确认，继续编辑留在原页、输入还在；作品菜单「项目备份」确认放弃后到项目备份 | 项目备份 | 否 | #380 C1 |
| `skills-import-local` | 系统对话框打桩为隔离 TEMP 里的 Agent Skill 文件夹（SKILL.md 引用 references/voice.md、大小写不同的 References/Voice.md 和不存在的 FORMS.md，voice.md 回链 ../SKILL.md，另有 scripts/lint.py）：设置 → 写作 Skills →「选择文件夹」，检查卡只列一次并入的 references/voice.md，另列模型看不到与不会安装的文件，中途拍 `skills-import-local-inspected`；确认安装后把它绑定到「章节正文」，断言安装清单 `.pagekin-bundle.json` 只列 references/voice.md；再在 Skill 库旁放一个没有清单的旧式 Skill（SKILL.md 链接到含工具措辞的 forms.md），重开设置后它仍按 master 判兼容、可绑定，拍 `skills-import-local-bound`；最后从蓝图写下一章，断言写正文的请求带上 voice.md 原文、不含脚本，等运行完成 | 第 3 章写完、运行侧页显示已完成 | 是 | 本机 Skill 导入、安装清单、旧 Skill 与 master 一致 |
| `x1-write-switch` | 一致性预检里保存安排、回复卡住时回书房用 Ctrl K 打开港口（作品条目只在书房的 Ctrl K 里），放行后港口里没有写作的启动调用，模型没收到正文请求 | 港口 | 是 | #387 C1 |
| `x1-waive-all` | 第 4 章 AI 审稿（复验周期由审稿写回建立，才有「不修改此项」），侧页每条都选「不修改此项」：主按钮变成「确认不修改」，确认后提示已确认；换到第 3 章再回来仍是已确认（读自数据库） | 第 4 章 | 是 | #392 T1 |
| `x1-cleanup-retry` | 第 3 章另有草稿 v1；把 v2 定稿（真实后处理写出正文文件），另起 PowerShell 进程只共享读地占住正文 txt（按 PID 结束），删除正文：落在 v1 的单章视图上，有「删除正文后的清理没有完成」且原因是 EBUSY；放开文件后点重试清理，提示消失、文件已删 | v1 单章视图 | 是 | #392 T2 |
| `x1-run-recovery` | `failProse` 后写下一章：运行失败，运行侧页「可恢复的内容」立即列出第 3 章候选 | 运行侧页 | 是 | #381 C1 |
| `x1-waiver-switch` | 第 4 章 AI 审稿后每条都选「不修改此项」，点「确认不修改」时读审稿原文卡住；回书房用 Ctrl K 打开港口并打开运行侧页，放行后运行侧页还开着，没有被换成灯塔那一稿的审稿侧页 | 港口运行侧页 | 是 | #405 r2 C1 |
| `x1-setup-save-remount` | 设定页改一句按 Ctrl S，保存卡住时切到第 3 章标签再切回：下一步仍不可点，再按 Ctrl S 也不重发，放行后主进程只收到 1 次保存 | 设定 | 否 | #405 r2 复验低项 7 |
| `x1-generate-slow-warning` | 规划 16 章，生成第 13～16 章蓝图时读架构（`db:project-core-get`）卡 4.5 秒：「架构还不完整」晚于 3 秒出现，`generateRange` 仍点继续生成，运行侧页展开 | 运行侧页 | 是 | #405 r2 O8 |
| `x1-generate-no-warning` | 同上但主进程读架构时补上角色名单：没有警告，`generateRange` 在运行侧页展开时返回，记下耗时（旧写法固定多等 3 秒） | 运行侧页 | 是 | #405 r2 O8 |
| `x1-review-sheet-switch` | 灯塔第 3 章审稿侧页开着时回书房用 Ctrl K 打开港口，再开港口同 id 的已定稿第 3 章：审稿侧页不展开 | 港口第 3 章 | 否 | #399 §1 |
| `x1-import-settings` | 书房里导入旧项目副本（对话框与复制打桩，复制卡住），期间在设置页填地址；复制完成要打开作品时先确认，继续编辑后设置页与输入都在，作品没有打开 | 设置页 | 否 | #404 第 1 项 |
| `x1-open-folder-order` | 设置页有没保存的输入时 Ctrl O、作品菜单「打开其他作品…」先确认，确认框出现时还没有弹选文件夹，继续编辑后也不弹 | 设置页 | 否 | #404 第 2 项 |
| `x1-open-folder-cancel` | 选文件夹打桩成取消。设置页有没保存的输入时 Ctrl O、作品菜单「打开其他作品…」（问放弃就选放弃修改），再清空输入后 Ctrl O：三次之后设置页都还开着，输入还在。RD-V 栈顶上也应通过（它先选文件夹），上一轮 45656084 上失败 | 设置页 | 否 | #405 r1-1 |
| `x1-import-overlap` | 同 `x1-import-settings` 到确认框出现，再按 Ctrl N：出现提示「请先处理『放弃未保存的修改？』」；选继续编辑：没有弹新建，输入还在，回书房后「导入旧项目副本…」可点。RD-V 栈顶没有这个确认框，不适用；上一轮 45656084 上导入入口一直禁用 | 书房导入菜单 | 否 | #405 r1-2 |
| `x1-open-folder-pick` | 只替换 Electron 的选文件夹对话框（选到港口，授权照常签发）。灯塔设置页有没保存的输入时 Ctrl O：确认框出现前没弹选文件夹，选放弃修改后弹一次，设置页收起、打开港口，不再问。RD-V 栈顶先选文件夹，失败 | 港口 | 否 | #405 r1-1 |
| `x1-library-return` | 先回一次书房，再从书房 Ctrl K 重新打开灯塔，读文件树卡住时进作品又回书房，放行后仍在书房（落点晚到的版本只比较提交前后的布局，两次都是作者亲手回的书房） | 书房 | 否 | #403 |
| `x1-run-sheet-keep` | 从书房打开灯塔，读文件树卡住时打开运行侧页，放行后侧页仍开着 | 运行侧页 | 否 | #395 |

## 外部审查修复（RD-X2）

场景在 `scripts/redesign/x2-scenarios.mjs`，都走新外壳，复用 RD-X1 的 `holdChannel`、`untilHeld`、`releaseChannel` 与 `seedHarbor`。每个场景把作者看到的值收进 `measured` 最后一次断言，对 RD-X1 栈顶的构建（`--app-root`）跑一次应失败，失败消息里能看到每一项的值。假模型另有 `fake.replyReview(json)`：之后的审稿（含合并后的复验）回这份 JSON；复验只覆盖带正文证据区间的本章目标意见，默认审稿只有文学类意见，合并后不会复验。主进程没有默认检索模型时退回默认生成模型，所以要演示「没有检索模型」得先删掉生成模型。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `x2-landing` | 「荒岛」只有架构（大纲分批写到第 6 章）、「北堤」再加三章蓝图、「南湾」只有第 1 章定稿没有蓝图、「空港」只有一份空的草稿、灯塔（同样的大纲）有蓝图与正文、第 3、4 章都在写：书房依次打开分别落在架构、正文第 1 章、正文第 1 章、架构（空稿不算开始）、正文第 4 章（最后一章在写的）；再从书房「打开作品」选文件夹打开灯塔，仍落在第 4 章；点第 1 章再点「正文」回到第 4 章；回书房后主按钮是「继续写作 · 第 4 章 · 待审稿」 | 书房概览 | 否 | #394 §6、#407 第 2 轮第 1、2 条 |
| `x2-outline` | 大纲带分批尾标但末尾多一个换行：徽标「不完整」、页头 3 / 4、下一步不可点；生成对话框选 1–12 章标「范围无效」、提交不可点 | 架构页 | 否 | #394 §1、§2 |
| `x2-library-overview` | 书房预览港口后点「回到《灯塔》」，概览不再是读取中、显示摘录；再预览港口并从最近项目移除它，灯塔概览照常 | 书房 | 否 | #380 C3、O23 |
| `x2-history` | 版本历史再点第 3 章各稿还在；读第 4 章各稿卡住时显示「正在读取…」；版本历史与单章版本切换器的时间等于库里 UTC 时刻换成本地时间 | 第 3 章 | 否 | #388 T2、T12、T8 |
| `x2-index-model` | 有检索模型并导入资料后去掉生成模型，在设置「检索模型」页删掉检索模型：索引区回到「配置并启用检索模型后…」，没有重建按钮 | 检索模型页 | 是 | #388 T3 |
| `x2-kb-limit` | 查找「守塔人」后在框里改字不提交，「最多显示」改成 5：主进程收到 `[守塔人,10]`、`[守塔人,5]` 两次查找 | 知识库 | 是 | #388 T15 |
| `x2-cast` | 角色档案三个视图里只有基础设定有头像按钮；粘贴角色卡的全文框至少 9 行高 | 角色名单 | 否 | #389 X1、O#2 |
| `x2-recheck` | `replyReview` 让审稿回第 4 章关键事件未完成（带证据）；审稿、按意见修稿、全部用修稿合并，自动复验跑完：提示「复验完成：x / y 项意见已解决」，审稿报告逐项标复验结果 | 审稿报告 | 是 | #392 T3 |
| `x2-blueprint-save` | 蓝图页改第 5 章标题并「保存此章」，流程脊第 5 章显示新标题 | 第 3 章 | 否 | #377 R1 |
| `x2-open-chapter` | 读第 4 章正文卡住时点流程脊「设定」，放行后仍在设定 | 设定页 | 否 | #377 R2 |

## 外部审查修复（RD-X3）

场景在 `scripts/redesign/rdx3-scenarios.mjs`，都走新外壳。要看修复前的样子，用 `--app-root` 指向 RD-V 栈顶（`87097dbb`）的构建再跑一次：这些场景在那边应当失败。

| 名称 | 检查 | 截图停在 | 夹具模型 |
|---|---|---|---|
| `rdx3-popover-1280`、`rdx3-popover-1024` | 视口设成 1280×720 或 1024×640，第 3 章出场三人，主进程的 `db:continuity-list-before` 换成三人都已死的事实：写作弹层出三条预检提醒，停在视口内（下沿留 8px）并在内部滚动，滚到底「仅本次忽略」在视口内点得到，内部滚动不关弹层；中途拍 `-top`，`after` 换回原处理函数并按 Esc | 滚到底的写作弹层 | 是 |
| `rdx3-keyboard` | 按 Tab 走到流程脊当前阶段行、激活的内容标签、拆分主按钮两半、运行侧页分段页签的选中项，各自 `:focus-visible` 且 `box-shadow` 含强调色，逐个截图；`measured` 是五处的 `box-shadow` | 运行侧页的分段页签 | 否 |
| `rdx3-import-dialog` | 作品菜单「小说拆解与仿写…」：对话框里只有一个 `.pi-btn--primary`，带 `aria-pressed` 的切换按钮都是次按钮；`after` 按 Esc | 拆解对话框 | 否 |
| `rdx3-toast-resize` | 推入 11 条常驻出错通知（推入函数的找法同 `rdv-toast-flood`），1440×900 下不溢出；视口缩到 1100×640 后栈标 `data-overflow`、最新一条露在栈底、卡片右缘到窗口右缘的距离不变。`measured.shiftWithoutCompensation` 是去掉滚动条补偿时卡片会左移的像素 | 缩窗后的满栈 | 否 |
| `rdx3-long-title` | 主进程把 `project:open` 返回的作品名换成 80 个字（项目文件夹不能这么长），视口 1024×640：顶栏作品名以省略号收尾，关闭按钮右缘在窗口内 | 顶栏 | 否 |
| `rdx3-inline-confirm-focus` | 写一章让诊断分页有日志：「清空日志…」的确认条用鼠标点「保留」、按 Esc、键盘打开后 Esc 与回车「保留」，恢复候选「放弃…」的确认条点「保留」与按 Esc，每次焦点都回到打开它的按钮。`measured.focusLog` 是页面里记下的每次焦点移动 | 诊断分页 | 是 |
| `rdx3-plan-ring` | 蓝图页选中第 5 章，当前章行与第 6 章行各按 Tab 聚焦：截行四周的图数强调色像素，聚焦比不聚焦多出一整圈 2px 环（不少于 4 ×（宽 + 高）× 0.8），只选中的当前章没有这圈环；`withoutContainment` 是去掉列表项 content-visibility 后的同一计数，与聚焦时相等说明环没被裁。像素解码在 `png.mjs`，与 `pixel-diff.mjs` 共用 | 第 6 章行聚焦 | 否 |
| `rdx3-work-menu-focus` | 作品菜单「导出…」「小说拆解与仿写…」「清除生成内容…」打开的对话框，按 Esc、点「取消」或「关闭」关掉后焦点都回到作品菜单按钮 | 回到作品菜单按钮后 | 否 |
| `rdx3-toast-wheel` | 作品菜单「清除生成内容…」开着（Radix 模态）时推入 24 条常驻出错通知：栈可滚动、滚动条 6px，鼠标停在栈上真滚轮往上滚超过 100px | 滚上去的满栈 | 否 |
| `rdx3-write-after-discard` | 开着「定稿后打开下一章」，第 3 章定稿后扣住第 4 章的读取，期间在设置页改出未保存的模型名；放行后弹「放弃未保存的修改？」，点「放弃修改」：第 4 章自动弹出的写作弹层还开着、焦点在弹层里，弹层打开后焦点没有落到弹层外。`measured.log` 是页面里按时间记下的弹层开合与焦点移动 | 写作弹层 | 是 |
| `rdx3-write-after-discard-sheet` | 同上，但放弃确认弹出前点过运行侧页的「历史」页签：确认关掉后的还焦点不抢走写作弹层的焦点。两者先后不定，只断言「历史」若拿到焦点是在弹层打开之前 | 写作弹层 | 是 |
| `rdx3-prompt-over-exit` | 设定里改出未保存的输入后只勾蓝图清除生成内容，主进程扣住 `db:project-clear-generated-data`（原处理在 `after` 里放回）；期间从主进程关窗弹出退出确认，再放行一个失败：「清除失败」提示画在退出确认之上（`isTopmost`），退出确认露在提示外的上沿命中提示的遮罩、截图亮度比提示纸面暗至少 10（`exposedEdge`，无重影），「确定」点得到，确定后退出确认还在且在最上层 | 退出确认 | 否 |
| `rdx3-exit-over-prompt` | 同上但反过来：先放行一个说明很长的失败，「清除失败」提示比退出确认高；提示开着时关窗，退出确认在最上层、焦点在它里面，提示露在外的上下沿命中退出确认的遮罩并被压暗；取消退出确认后提示在最上层、「确定」点得到 | 退出确认 | 否 |
| `rdx3-candidates-en` | 夹具模型的角色提取只回一张卡；从「角色」粘贴一张角色卡，运行侧页出确认卡后在设置的外观页把界面语言切成英文，确认卡写「1 character candidate」（不是 candidates）；`after` 切回中文，再等批次就绪、把守塔人按新建确认，走完这次待确认的运行，退出时不再弹「创作任务仍在运行」 | 运行侧页 | 是 |
| `rdx3-prose-keys` | 打开第 4 章草稿（新外壳单章视图或旧外壳草稿编辑器，`--shell` 选），末尾输入「※※※」「——他说，钟声提前了。」「◇◆◇」三段：新外壳纸面上两行分节符不缩进、对白缩进 36px（旧外壳编辑器本来不缩进，不查）；Tab 插两个 em 空格，Esc 后停 2.5 秒再按 Tab 焦点移出编辑区、不插空格，Esc 后按了方向键 Tab 又插空格。两种外壳各跑一次 | 焦点移出编辑区后 | 否 |
| `rdx3-hover-focus` | 书房里鼠标停在「新建作品」卡上再按 Tab 聚焦它，`box-shadow` 是焦点环（悬停样式不盖掉它）；打开作品后键盘打开作品菜单，首项、方向键下一项、End 末项的 `box-shadow` 都是菜单自己的 2px 内侧环，不是外壳的外圈；中途拍 `-start`、`-menu-first`、`-menu-last` | 菜单末项聚焦 | 否 |

## 切换默认外壳（RD-10）

场景在 `scripts/redesign/rd10-scenarios.mjs`，对应计划 RD-10 的实机 lane 与功能保全矩阵的验证截图。被测构建是 RD-10 之后的纸墨外壳，`--app-root` 指向最终安装包的构建树。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应计划 |
|---|---|---|---|---|
| `rd10-keyboard` | 只用键盘：Ctrl K 去蓝图，Tab 到下一章的「写第 N 章」（样例里是第 3 章）回车开写，写完 Tab 进正文补一句、Ctrl S 保存，再按 Esc、Tab 离开编辑区。每一步记下焦点落点与焦点环（`:focus-visible` 且 box-shadow 或 outline 含强调色；正文编辑区以插入点为标记），`measured.missingRing` 为空 | 保存后离开编辑区 | 是 | lane 7 |
| `rd10-esc-after-typing` | 第 4 章正文里分别用逐键按键、insertText、CDP 模拟的输入法组字（imeSetComposition 再 insertText）各打几个字，每次打完立刻按 Esc、Tab：焦点离开编辑区，正文里不多出全角空格（`measured.results` 三项都 `left: true`、`emSpacesAdded: 0`） | 最后一次 Tab 之后 | 否 | lane 7 |
| `rd10-en` | 界面语言切成英文后走书房、四个阶段、角色名单、第 3 章与第 1 章、运行侧页、三个作品资料页、导出与清除对话框、设置各页；每页的可见文字与可访问名称去掉作品内容后不剩汉字，`measured.untranslated` 为空 | 设置的外观页 | 否 | lane 6 |
| `rd10-widths` | 1280×900 与 1920×1080 下依次截第 3 章、角色名单、蓝图、书房（`rd10-widths-<宽>-<页>`），文档与外壳都没有横向溢出。浅色、深色各跑一次（`--theme`） | 1920 宽的书房 | 否 | lane 10 |
| `rd10-knowledge-narrow` | 1280×900 下打开知识库再展开运行侧页（资料栏只剩约 200px），中文、英文各一次：资料栏里每个按钮留在所在的框里、文字不伸出按钮，分段两项不折行，资料栏没有横向溢出（`measured.<语言>.problems` 为空） | 英文界面的窄资料栏 | 否 | lane 10、F27 |
| `rd10-tab-menu` | 打开设定与蓝图共三个标签，展开「标签操作」：已打开的页面与关闭当前、其他、右侧、全部四个动作 | 标签操作菜单 | 否 | F-183、F-184 |
| `rd10-tab-overflow` | 1280×900 下开着运行侧页，打开作品资料各页与几章直到标签条横向滚动，最后打开的标签在最右端激活：「标签操作」按钮中心那一点上是按钮本身，在那里真实点一下打开菜单，标签一个不少 | 打开的标签菜单 | 否 | F-183、F-184 |
| `rd10-candidate-page` | 运行侧页可恢复的正文候选「继续编辑」打开纸墨正文页，候选正文在纸面上 | 恢复候选正文页 | 否 | F-072 |
| `rd10-tour` | 评审视频（配 `--video`，约 45 秒）：书房概览、打开作品走四个阶段与角色名单、正文第 3 章，设置的外观只有浅色与深色两套（没有皮肤与界面布局），切到深色再切回，回书房 | 书房 | 否 | Review gate |

## 说明文字对比度（#382）

场景在 `scripts/redesign/contrast-scenarios.mjs`。浅色、深色各跑一次（`--theme dark`）。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `caption-contrast` | 依次停在第 3 章外壳、写下一章时的运行侧页（进行中、完成、历史）、架构、角色名单、设置的 AI 模型与外观、书房与预览，每处收集颜色等于 `--ink-3` 的全部文字，按类名留最低的对比度写进 `measured`（底色沿祖先叠加求出）；普通字号不低于 4.5:1，24px 起或 18.66px 起粗体不低于 3:1，禁用控件豁免。量完再断言，失败信息里带全部数值；每处截一张 `caption-<位置>` | 书房预览 | 是 | #382 |
