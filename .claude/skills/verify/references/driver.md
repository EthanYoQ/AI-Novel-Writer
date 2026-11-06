# 驱动、输出与只读诊断（完整说明）

正文只列常用部分。要查某个参数的细节、结果 JSON 的每个字段、会话结束时的三项检查，或者要改驱动和页面对象时，读这份。安装与构建命令以正文「启动前」为准（用 fnm 的 Node 22.23.1）。

驱动脚本是 `scripts/redesign/drive.mjs`。它用 Playwright 的 `_electron` 启动当前工作树的构建产物（`electron .`），每个会话（一次冷启动）一个全新的隔离目录，模型调用全部走本机假服务，不调用真实模型。单跑一个场景就是只含这个场景的会话。

应用窗口不出现在屏幕上。驱动用 `electron -r scripts/redesign/offscreen-window.cjs` 在应用主进程脚本之前挂上 `browser-window-created` 监听：窗口一创建就移到所有显示器右侧之外，去掉任务栏按钮，设为不可激活并交还焦点，不打扰正在用电脑的人。截图走页面视口，与窗口位置无关；页面焦点由 Playwright 的焦点模拟提供，`document.hasFocus()` 仍为 true。每次截图前断言 `document.visibilityState` 为 `visible`，防止屏幕外窗口被当作隐藏而停帧。

## 启动前

在要验证的工作树根目录依次运行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

驱动加载的是 `dist/` 与 `dist-electron/`，改了 `src/` 或 `electron/` 必须重新 `pnpm build`。`better-sqlite3` 是 Node-API 预编译包，vitest 与 Electron 共用同一份二进制，跑测试和驱动之间不用切换。

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
- `--app-root` 默认当前工作树。性能对照时指向 trunk 的工作树，用同一个驱动测两边；目标工作树也要先跑完上面两条命令，它加载的是自己的 `dist-electron/` 和 `better-sqlite3`。
- 退出码：0 全部通过；1 有场景失败、残留进程或隔离目录外写入；2 参数错误。

RD-10 删除旧外壳之后，场景分三类：

- 只走旧外壳的场景只对 trunk 跑（`--app-root`）：下面「场景」表的 8 个基线场景与 `baseline-all`、`nav-*`、`write-latency`、`settings-appearance`、`run-write-steps`、`legacy-no-chat`、`arch-legacy-sidebar`。对照时 head 一侧改跑对应的新外壳场景。
- 两种外壳都能跑的场景运行时按页面上有没有纸墨外壳选页面对象，head 与 trunk 用同一条命令：`startup-timing`、`idle-memory`、`chapter-switch`、`chapter-open`、`typing-latency`、`chapter-regression`、`blueprint-regression`、`blueprint-timing`、`refs-regression`、`refs-timing`、`new-project-files`。
- 其余声明了 `shell: 'stage'` 的场景只对 RD-3 及以后的构建跑。

## 输出

在 `--out` 目录下：

- `<场景>-<主题>.png`：场景截图，1440×900（`stage-1280` 为 1280×900）。
- `--video` 时另有 `<场景>-<主题>.mp4`，结果项的 `video` 字段指向它。
- `<场景>-<主题>.json`：本次运行的结果数组，每个截图点一项。`scenario`、`screenshot` 属于这个截图点；`session`（会话名，单跑时等于场景名）、`timing`、`shell`（外壳的 `data-shell-presentation`，`writer` 或 `stage`：`startup-timing` 取计时那次启动显示的外壳，其余场景取写好外观、重载之后的外壳，用来确认测的就是要测的外壳）、`externalRequests`、`residualProcesses`、`externalWrites`、`externalWritesIgnored`、`quit`、`isolationRoot` 属于整个会话，会话里每一项都抄一份；会话用了夹具模型时另含 `modelRequests`（整个会话里假服务收到的全部请求数，嵌入请求也计入，与 `--console` 里的 `[fake-model]` 行一一对应）。失败时含 `error`：截图点自己的失败写在该项；同一会话里排在失败点之后的截图点不再运行，`error` 写明是被哪个场景拖住；会话级失败（启动、外部请求、退出、进程枚举）写进该会话的每一项。
- 失败时额外写 `<失败场景>-<主题>.failure.png`、`.dom.html`、`.aria.yml` 和 `<会话>-<主题>.console.log`，隔离目录保留以便排查。

每个会话结束后，驱动检查三件事，任一不满足即退出码 1：

- `externalRequests` 为空。每个会话都在 Electron 启动后替换主进程的 `globalThis.fetch`：用夹具模型的会话只放行 `https://api.openai.com/v1/*` 并改道到本机假服务，其余会话一律不放行。被拒的请求记下来源并抛错。检查范围只有主进程 `fetch`，且从 `electron.launch` 返回后才生效；更早的请求、渲染进程的请求和 Electron `net` 模块的请求都不在内。
- `residualProcesses` 为空：应用关闭后，以 `--user-data-dir` 匹配不到存活进程。子进程退出需要时间，驱动最多查 10 次、间隔 300 ms。
- `externalWrites` 为空：`~/.vela`、`%APPDATA%\ai-novel-writer`、`%APPDATA%\AI小说作家` 里没有新增或删除的条目，文件的大小与修改时间也不变。列出的是变了的具体路径。
  - 这几个目录第一层的 `GPUCache`、`DawnWebGPUCache`、`DawnGraphiteCache` 不算：本机开着的书童会自己刷新里面文件的修改时间。它们的变化列进 `externalWritesIgnored`，不影响退出码。
  - 驱动真的写进真实配置目录时，Chromium 还会写 `Preferences`、`Local State`、`Local Storage` 等条目，这些照样报出来。
  - 一个目录超过 5 万个条目，或者有条目读不了（`ENOENT`、`ENOTDIR` 两种「不存在」除外）时，快照直接报错，不拿截断的快照判通过：运行前的快照出错时驱动在启动应用前退出，退出码 1；运行后的快照出错时原因写进 `error`。

枚举或结束进程本身失败时，原因写进该会话每一项的 `error`，结果 JSON 照常写出。

## 只读诊断

```bash
node scripts/redesign/drive.mjs --scenario open-sample --dump-dom --console --out <目录>
```

- `--dump-dom` 在每个截图点截图后写 `<场景>-<主题>.dom.html`（`page.content()`）和 `.aria.yml`（Playwright 无障碍快照）。改页面对象前先看 `.aria.yml`，选择器优先用其中的角色与可访问名称。
- `--console` 每个会话写一份 `<会话>-<主题>.console.log`（单跑时会话名就是场景名，`baseline-all` 为 `baseline-shelf`、`baseline-sample`）：渲染进程控制台、页面异常、主进程 stdout/stderr，以及假模型每次请求的分类（`[fake-model] prose|review|revision|character-state|embedding`）。

## 改外壳时

类名选择器只出现在 `scripts/redesign/pages/`，按任务域分文件：`shell`（启动、外壳就绪、标题栏、状态栏、左右栏与可收起面板）、`bookshelf`（旧外壳书房与两种外壳的新建作品）、`project`（项目树）、`chapter`（单章写作、审稿、修稿合并、定稿）、`run-panel`（运行面板）、`settings`（设置，含外观里切换界面布局）、`materials`（知识库与角色卡导入）、`stage`（新外壳：流程脊、章节列表、标签条、Ctrl K 与 Ctrl P、保存状态、沉浸写作、书房）、`run-sheet`（新外壳的运行侧页）。`shell.waitForShell` 对两种外壳都成立。外壳替换后只改这些页面对象，场景 `scripts/redesign/scenarios.mjs` 不动。

`/.claude/` 在 `.gitignore` 里，提交本文件的改动要用 `git add -f .claude/skills/verify/SKILL.md`（或 `git add -u`）。假模型在 `scripts/redesign/fake-model.mjs`，按提示词特征返回正文、短细纲（与正文同一段文字，但不参与定速流出）、审稿 JSON、修稿正文、角色状态 JSON 或角色提取 JSON。
