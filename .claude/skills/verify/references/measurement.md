# 截图可重复性与性能测量

比较截图是否稳定，或者测启动耗时、空闲内存、页面内计时时读。本文的 `node` 命令都省略了 `fnm exec --using=22.23.1 --` 前缀，运行时照正文「命令」补上。

## 截图可重复性

同一场景连续跑三次再比较：

```bash
for i in 1 2 3; do node scripts/redesign/drive.mjs --scenario review --out shots/r$i; done
node scripts/redesign/pixel-diff.mjs shots/r1/review-light.png shots/r2/review-light.png shots/r3/review-light.png
```

上面是历史写法（RD-10 之前），`review` 是旧外壳基线场景，在当前构建上不能照抄。当前构建用纸墨外壳场景，并且任一次驱动退出码非 0 就停下；每次比较用新的输出目录，免得 `pixel-diff.mjs` 比到上一轮留下的旧图：

```bash
out=$(mktemp -d)
(for i in 1 2 3; do node scripts/redesign/drive.mjs --scenario stage-open-sample --out "$out/r$i" || exit 1; done
node scripts/redesign/pixel-diff.mjs "$out/r1/stage-open-sample-light.png" "$out/r2/stage-open-sample-light.png" "$out/r3/stage-open-sample-light.png")
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

## 页面内计时

计时会话（`startup-timing`、`library-timing`）启动时设环境变量 `DRIVE_RENDER_TIMING`，`offscreen-window.cjs` 据此给默认会话注册页面预加载 `render-timing-preload.cjs`：它在页面脚本之前装好 MutationObserver，把「新建作品」与书架上的书第一次进入 DOM 的时刻（`performance.now()`）写在 `<html>` 的 `data-drive-interactive`、`data-drive-shelf` 上，驱动启动后读出，写进 `timing.renderInteractiveMs`、`timing.renderShelfMs`。它们没有 Playwright 轮询的量化误差。其他场景不注册这个预加载。
