---
name: verify
description: 在真实 Electron 里驱动书童做实机验证：截图、复现界面缺陷、跑 redesign 场景、测启动耗时与内存、读只读诊断。Use for real-app verification of Pagekin (书童) - screenshots, reproducing UI bugs, running redesign scenarios, startup timing, idle memory, read-only DOM and console diagnostics.
---

# verify

驱动脚本是 `scripts/redesign/drive.mjs`。它用 Playwright 的 `_electron` 启动当前工作树的构建产物（`electron .`），每个会话（一次冷启动）一个全新的隔离目录，模型调用默认走本机假服务，不调用真实模型；只有带 `--real-model` 跑 `real-*` 场景时，请求发往硅基流动 `https://api.siliconflow.cn/v1/`。单跑一个场景就是只含这个场景的会话。

窗口开在屏幕外，不抢焦点，不打扰正在用电脑的人。不碰 `%APPDATA%\ai-novel-writer`，也不碰维护者正在运行的书童。

## 启动前

在要验证的工作树根目录依次运行。Windows 用 Git Bash（Bash 工具）。`cmd //c` 是 Git Bash 的写法，在 PowerShell 里它只打开一个提示符、不执行命令；在 PowerShell 里要写成 `cmd /c`。

```bash
fnm exec --using=22.23.1 -- cmd //c pnpm install --frozen-lockfile --ignore-scripts
fnm exec --using=22.23.1 -- node node_modules/electron/install.js
fnm exec --using=22.23.1 -- cmd //c pnpm build
```

macOS 没有 `cmd`，在终端里直接调 `pnpm`：

```bash
fnm exec --using=22.23.1 -- pnpm install --frozen-lockfile --ignore-scripts
fnm exec --using=22.23.1 -- node node_modules/electron/install.js
fnm exec --using=22.23.1 -- pnpm build
```

- 驱动直接 import 应用里的 `.ts`，要 Node 自带的类型剥离。本机默认 Node 不一定满足，统一用 fnm 的 22.23.1 跑驱动。版本不对时驱动报错并给出这条命令。
- 驱动加载的是 `dist/` 与 `dist-electron/`，改了 `src/` 或 `electron/` 必须重新 `pnpm build`。没构建时驱动退出码 2，并提示先构建。
- `better-sqlite3` 是 Node-API 预编译包，vitest 与 Electron 共用同一份二进制，跑测试和驱动之间不用切换。

## 命令

```bash
fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs --scenario <名称> [--theme light|dark] [--out <目录>] [--dump-dom] [--console] [--video] [--app-root <目录>] [--shell writer|stage] [--real-model]
```

- 参考文件里的 `node …`、`pnpm verify:drive …` 命令都省略了 `fnm exec --using=22.23.1 --` 前缀，运行时照上面这条补上。
- 不带参数运行会打印全部场景名，退出码 2。场景定义在 `scripts/redesign/*-scenarios.mjs`。
- `--theme` 默认 `light`（浅色），`dark` 为深色。界面类改动浅色、深色各截一次。
- `--out` 默认 `.runtime/redesign-baseline/`。batch 线按任务书指定的截图目录传。
- `--dump-dom` 在每个截图点另写 `.dom.html` 与 `.aria.yml`。`--console` 写渲染进程、主进程与假模型的日志。排查时两个一起开。
- `--video` 录屏，要本机有 `ffmpeg`。
- `--app-root` 指向另一个已构建的工作树，用同一个驱动测 trunk 与 head。
- `--shell` 只对 RD-10 之前的 trunk 有意义。当前构建只有纸墨外壳，不要传。
- `--real-model` 只用于 `real-*` 场景，密钥从环境变量 `SILICONFLOW_API_KEY` 读，不要打印。

## 输出

在 `--out` 目录下：

- `<场景>-<主题>.png`：截图，1440×900。
- `<场景>-<主题>.json`：结果数组，每个截图点一项。`measured` 是场景自己的断言值，`error` 写失败原因。
- 失败时另有 `<失败场景>-<主题>.failure.png`、`.dom.html`、`.aria.yml` 和 `<会话>-<主题>.console.log`，隔离目录保留以便排查。

## 退出码

- 0：全部通过。
- 1：有场景失败，或会话结束检查没过。检查三项：主进程没有放出外部请求（`externalRequests`），应用关闭后没有残留进程（`residualProcesses`），真实配置目录没有新写入（`externalWrites`）。
- 2：参数错误、场景名不对，或目标工作树没构建。

退出码 1 先看结果 JSON 的 `error`，再看 `.failure.png` 和 `.console.log`。不要只凭退出码 0 宣称验证通过，还要看截图。

## 截图规则

- 每张截图都用 Read 工具亲自看，不只看退出码和 `measured`。
- 截图说明逐项写出画面上每个动态值的期望值，并和同屏其他值互相核对。动态值指时间、计数、章号、字数、进度这类会随数据变化的值。
  - 反例：batch10 #600 的一屏里有两个时间，相差 8 小时。验收只看了文案长短，没有核对两个时间是否一致，缺陷被放行了。
  - 写法：「<位置 A> 的 <值>：期望 X，实际 X；与 <位置 B> 的同一值 X 一致」。同一事件在两处显示的时间、同一计数在标题和列表里的数目、当前章号在各处的显示，都要两两对上。
- 改界面的 PR，浅色、深色各一张。宽度敏感的改动加跑 1280 宽的场景（见 `references/rd-review-scenarios.md` 的 `rd10-widths`）。
- 比较前后截图，先确认同一场景连续跑稳定，再谈差异。做法见 `references/measurement.md`。

## 什么时候读哪份参考

| 要做的事 | 读 |
|---|---|
| 查参数细节、结果 JSON 每个字段、会话结束检查的范围、只读诊断、改页面对象或假模型 | `references/driver.md` |
| 找纸墨外壳某一页的现成场景（流程脊、运行侧页、书房、设置、架构、角色、蓝图、正文、作品资料页） | `references/rd-stage-scenarios.md` |
| 键盘、英文界面、宽度、对比度、标签菜单这类横跨页面的场景 | `references/rd-review-scenarios.md` |
| 某个已修 issue 的回归场景（#382 起） | `references/issue-scenarios.md` |
| 截图可重复性、启动耗时、空闲内存、页面内计时 | `references/measurement.md` |
| RD-10 之前的旧外壳基线场景，只对 trunk 跑 | `references/baseline-scenarios.md` |

参考里没写到的场景，以 `scripts/redesign/*-scenarios.mjs` 的源码为准。新加场景时，在对应参考文件里补一行。

## 提交本 skill 的改动

`.claude/` 在 `.gitignore` 里，提交要用 `git add -f .claude/skills/verify`。
