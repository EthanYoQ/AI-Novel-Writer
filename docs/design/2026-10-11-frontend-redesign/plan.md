# 前端重新设计实施计划

把渲染进程从 IDE 四区外壳换成「流程脊 + 内容区标签 + 按需侧页」的纸墨界面，面向写小说的作者。
规则只有一条：功能保全矩阵 `feature-matrix.md` 的 192 项可见功能一项不少，每项落到一个规范入口。
新外壳先挂在外观配置 `shellPreference` 后面并行开发，最后一个 PR 切换默认并删除旧外壳与皮肤。
PR 顺序为 RD-0 驱动与基线，RD-1 令牌与组件原语，RD-2 导航模型，RD-3 新外壳骨架，RD-4 运行侧页与隐藏聊天，RD-5 书房、设定与设置，RD-6 架构与角色，RD-7 蓝图与写作此章，RD-8 正文单章视图，RD-9 作品资料，RD-10 切换默认并删除旧外壳。
设计依据见同目录 `ia.md`、`design-system.md`、`prototype/` 与 ADR-0021。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. 每个 PR 由一个子 Agent 负责到 STACK-READY；主 Agent 只做拓扑与裁决，不合并。RD-0 至 RD-10 全部停在待审，由用户按栈自底向上合并。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, write this exact text into the standing orders and restate it in your todolist. 「计划 `docs/design/2026-10-11-frontend-redesign/plan.md`，PR 依次为 RD-0 至 RD-10，单个 PR 只有在单元、实机、性能三类方框都勾选后才算验证通过，用户按栈合并，全部 PR 进入已验证的线性栈且 RD-10 的 `pnpm build:win` 通过即为完成。」
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `.claude/skills/verify/SKILL.md`（RD-0 产出的项目驱动技能）
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/how/SKILL.md`、`skills/interrogate/SKILL.md`、`skills/show-me-your-work/SKILL.md`
- [ ] Arm the hourly audit tick as a real `/loop` in dynamic mode, which schedules its own wake-up rather than blocking on a sleep. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing objective. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. 每个负责人收到 `$ponytail full` 与 AGENTS.md「最小实现与开发收尾」的全部约束、目标行为、验收条件和文件所有权。
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] RD-0 首先开始，基于 `master`。
  - [ ] RD-1 与 RD-2 在 RD-0 之后，可并行，都以 RD-0 为父。栈顺序为 RD-1 在下。
  - [ ] RD-3 在 RD-1 与 RD-2 之后。
  - [ ] RD-4、RD-5、RD-6、RD-7、RD-9 在 RD-3 之后，可并行开发，按编号顺序入栈。
  - [ ] RD-8 在 RD-7 之后。
  - [ ] RD-10 在其余全部之后。
- [ ] Hold the file boundaries.
  - [ ] RD-0 只动 `.claude/skills/verify/**`、`scripts/redesign/**`、`package.json` 的脚本段。
  - [ ] RD-1 只动 `src/styles/paper-ink/**`、`src/components/ui/**`、`public/fonts/**`、`scripts/check-color-literals.mjs`、`.eslintrc.cjs`。
  - [ ] RD-2 只动 `src/stores/layout-store.ts`、`src/stores/navigation/**`、`src/stores/workflow-store.ts`、`src/stores/project-store.ts` 中的导航调用与对应测试。
  - [ ] RD-3 至 RD-9 只动 `src/components/stage/**` 及各自页面目录，旧组件只读复用；需要改旧组件内部时在 PR 正文说明。
  - [ ] RD-10 独占删除旧外壳、皮肤与外观迁移。
- [ ] Hold the review gate. RD-3 至 RD-10 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. 命令为 `pnpm lint`、`pnpm typecheck`、`pnpm check:i18n`。
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] 干净裁决后，主 Agent 按 autopilot-stack 第 5 至 7 步把 PR 追加到线性栈，记录 base、head 与 patch-id；任何 Agent 不合并、不开自动合并。用户自底向上合并。

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill path or exact commands recorded in this boot recipe.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] 安装与构建，依次运行 `pnpm install --frozen-lockfile --ignore-scripts`、`node node_modules/electron/install.js`、`pnpm rebuild:electron`、`pnpm build`。本机 Node 26 从源码编译 `better-sqlite3` 会失败（LNK1117），所以安装时跳过脚本，再单独装 Electron 并按 Electron ABI 重建。若 `pnpm add` 类操作卡住，改用全局较新的 pnpm（见项目记忆）。
- [ ] 驱动每次运行都用 `mkdtemp` 新建隔离目录，所以同一 PR 的实机 lane 可以共用主 Agent 预先构建好的 head 检出，各用独立的 `--out`。性能 lane 等其他 lane 全部结束后单独运行。
- [ ] 只通过 `.claude/skills/verify/SKILL.md` 的命令驱动应用，即 `node scripts/redesign/drive.mjs --scenario <名称> --theme <light|dark> --out <目录>`；它用隔离配置目录和临时项目启动 Electron。只读诊断用 `--dump-dom` 与 `--console`。
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## 建立实机驱动与旧外壳基线 (RD-0)

**Depends on.** None.

**Files.**

- [ ] Create `.claude/skills/verify/SKILL.md`，写明启动、场景、截图、只读诊断的命令。
- [ ] Create `scripts/redesign/drive.mjs`，基于现有 `scripts/renderer-surface-e2e.mjs` 的 `_electron` 启动方式。
- [ ] Create `scripts/redesign/pages/`，按任务域写页面对象，选择器优先用角色与可访问名称。
- [ ] Edit `package.json`，增加 `verify:drive` 脚本。

**Build.**

- [ ] `drive.mjs` 支持 `--scenario`，内置场景覆盖新建作品、打开示例作品、写作此章（模型调用替换为夹具）、审稿、修稿合并、定稿、打开运行面板、打开设置。
- [ ] 页面对象层把类名选择器集中到一处，使后续外壳替换只改页面对象，不改 34 个旅程脚本的断言。

**You see.**

- [ ] `pnpm verify:drive -- --scenario baseline-all --out shots/baseline` 在旧外壳上产出 8 张截图且退出码为 0。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/redesign/__tests__/drive-args.test.mjs` 覆盖参数解析与隔离目录创建。Run `pnpm vitest run scripts/redesign`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 上运行同一个 `renderer-surface-e2e` 旅程。Save `rd0-regression.png`. Pass when 两边都通过且截图一致。
- [ ] Lane 2. 新建作品场景。Save `rd0-new.png`. Pass when 截图显示小说配置页且隔离目录外无写入。
- [ ] Lane 3. 打开示例作品场景。Save `rd0-open.png`. Pass when 项目树显示示例章节。
- [ ] Lane 4. 写作此章场景（夹具模型）。Save `rd0-write.png`. Pass when 草稿标签打开且正文非空。
- [ ] Lane 5. 审稿场景。Save `rd0-review.png`. Pass when 审稿报告标签出现。
- [ ] Lane 6. 修稿合并场景。Save `rd0-merge.png`. Pass when 合并对话框出现并可完成。
- [ ] Lane 7. 定稿场景。Save `rd0-final.png`. Pass when 草稿变为只读并出现后处理状态。
- [ ] Lane 8. 运行面板场景。Save `rd0-run.png`. Pass when AI 输出面板显示一条运行。
- [ ] Lane 9. 设置场景，深色主题。Save `rd0-settings-dark.png`. Pass when 设置弹窗以深色渲染。
- [ ] Lane 10. 连续运行同一场景三次。Save `rd0-repeat.png`. Pass when 三次截图像素差小于 0.5% 且无残留进程。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 应用启动到首屏可交互的毫秒数（驱动脚本记录 `ready-to-show` 与首个可点击控件出现的时间差）。
- [ ] Probe. trunk 与 head 交替各运行 5 次 `--scenario startup-timing`。
- [ ] Baseline. Record the trunk 中位数 first.
- [ ] Rule. head 中位数不超过 trunk 的 105%；RD-0 不改产品代码，超出即说明测量不稳定，需先修驱动。

**Review gate.** None. RD-0 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-0 作为栈底追加，等待用户合并。

## 建立纸墨令牌与组件原语 (RD-1)

**Depends on.** RD-0.

**Files.**

- [ ] Create `src/styles/paper-ink/tokens.css`，色值取自 `design-system.md` 的「视觉基准」表（来源 `claude-design/Language.dc.html`），浅色与深色两套。
- [ ] Create `src/components/ui/` 下的 Sheet、Menu、Popover、SegmentedControl、Check、StatGrid、Notice、InlineConfirm、DangerConfirm、EmptyState、Lifecycle 原语。
- [ ] Edit `src/components/ui/Button.tsx`，按 `design-system.md` 收敛为主、次、幽灵、危险描边、危险实心与图标六种。
- [ ] Edit `public/fonts/`，增加 Instrument Serif（OFL）与授权说明。
- [ ] Create `scripts/check-color-literals.mjs`，在 `pnpm lint` 中运行。

**Build.**

- [ ] 原语只引用 `--frame`、`--ink`、`--accent` 等纸墨令牌，并在 `src/stories` 增加对应故事。
- [ ] 颜色字面量检查先以允许清单记录现有 25 个旧文件，新目录 `src/components/stage/**` 与 `src/components/ui/**` 零容忍。

**You see.**

- [ ] Storybook 的按钮故事并排显示六种按钮，危险按钮与主按钮外形不同。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/ui/__tests__/*.browser.tsx` 为每个原语断言键盘可达、焦点环可见与 `aria` 属性。Run `pnpm test:browser -- src/components/ui`.
- [ ] `scripts/__tests__/check-color-literals.test.mjs` 断言在新目录写入色值时检查失败。Run `pnpm vitest run scripts/__tests__/check-color-literals.test.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 运行 `baseline-all`。Save `rd1-regression.png`. Pass when 旧外壳截图与 trunk 像素差小于 0.5%。
- [ ] Lane 2. Storybook 按钮故事，浅色。Save `rd1-buttons-light.png`. Pass when 六种按钮齐全且主按钮为黛蓝。
- [ ] Lane 3. Storybook 按钮故事，深色。Save `rd1-buttons-dark.png`. Pass when 正文对比度不低于 4.5 比 1。
- [ ] Lane 4. 侧页原语打开与关闭。Save `rd1-sheet.png`. Pass when 滑入动画在减少动态效果设置下关闭。
- [ ] Lane 5. 菜单原语的危险分组。Save `rd1-menu.png`. Pass when 危险项与普通项之间有分隔且为危险色。
- [ ] Lane 6. 危险确认对话框，输入作品名才可确认。Save `rd1-danger.png`. Pass when 名称不符时确认按钮禁用。
- [ ] Lane 7. 弹层原语用键盘打开与关闭。Save `rd1-popover.png`. Pass when Esc 关闭且焦点回到触发按钮。
- [ ] Lane 8. 分段控件与开关。Save `rd1-seg.png`. Pass when 选中态与 `aria-pressed` 一致。
- [ ] Lane 9. 空状态原语。Save `rd1-empty.png`. Pass when 标题为衬线、包含一个动作按钮。
- [ ] Lane 10. 字体加载离线进行。Save `rd1-fonts.png`. Pass when 断网启动后标题仍为 Noto Serif SC，数字为 Instrument Serif。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 渲染进程构建产物大小（`dist` 下 js、css、字体总字节）与启动到可交互毫秒数。
- [ ] Probe. trunk 与 head 交替各构建一次并运行 5 次 `startup-timing`。
- [ ] Baseline. Record the trunk 产物字节与启动中位数 first.
- [ ] Rule. 启动中位数不超过 trunk 的 105%；新增字体字节不超过 2 MB 的绝对预算，其余产物增长不超过 3%。

**Review gate.** None. RD-1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-1 追加到 RD-0 之上，等待用户合并。

## 抽出导航意图模型 (RD-2)

**Depends on.** RD-0.

**Files.**

- [ ] Create `src/stores/navigation/navigation-intents.ts`，定义打开阶段、打开资料页、打开运行侧页、打开设置分组、打开章节五种意图。
- [ ] Edit `src/stores/layout-store.ts`，旧动作改为调用意图，字段保留供旧外壳读取。
- [ ] Edit `src/stores/workflow-store.ts:672` 与 `src/stores/project-store.ts:720-764`，改用意图。
- [ ] Edit `src/App.tsx:150` 的完成提示，改用意图。

**Build.**

- [ ] 意图是唯一的跨层导航入口；新外壳与旧外壳各自订阅，切换外壳不改调用方。

**You see.**

- [ ] 旧外壳下工作流启动仍自动打开 AI 输出，切换项目仍重置布局。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/stores/navigation/__tests__/navigation-intents.test.ts` 断言每种意图在旧外壳下映射到原字段组合。Run `pnpm vitest run src/stores/navigation`.
- [ ] 现有引用 `layout-store` 的 31 个测试保持通过。Run `pnpm vitest run src/stores src/components`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 运行写作此章场景。Save `rd2-regression.png`. Pass when 两边都在启动时打开 AI 输出。
- [ ] Lane 2. 切换项目。Save `rd2-switch.png`. Pass when 侧栏回到项目视图且沉浸状态清除。
- [ ] Lane 3. 工作流完成提示的「打开查看」。Save `rd2-toast.png`. Pass when 打开对应运行。
- [ ] Lane 4. 从状态栏打开任务进度。Save `rd2-status.png`. Pass when 行为与 trunk 一致。
- [ ] Lane 5. 打开设置的模型分组。Save `rd2-settings.png`. Pass when 落在请求的分组。
- [ ] Lane 6. 知识库导入后自动打开任务。Save `rd2-kb.png`. Pass when 底部任务面板打开。
- [ ] Lane 7. 角色卡导入后自动打开任务。Save `rd2-cards.png`. Pass when 底部任务面板打开。
- [ ] Lane 8. 批量创作启动。Save `rd2-batch.png`. Pass when 底部任务面板打开。
- [ ] Lane 9. 沉浸写作切换两次。Save `rd2-immersive.png`. Pass when 面板恢复到切换前状态。
- [ ] Lane 10. 首页时启动工作流。Save `rd2-home.png`. Pass when 先切到项目视图再打开 AI 输出。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 启动到可交互毫秒数，与点击写作此章到 AI 输出出现的毫秒数。
- [ ] Probe. trunk 与 head 交替各 5 次 `startup-timing` 与 `write-latency`。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 两项中位数都不超过 trunk 的 105%。

**Review gate.** None. RD-2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-2 追加到 RD-1 之上，等待用户合并。

## 搭建新外壳骨架 (RD-3)

**Depends on.** RD-1 与 RD-2.

**Files.**

- [ ] Create `src/components/stage/StageShell.tsx`，包含顶栏、流程脊、标签条、侧页宿主与运行胶囊。
- [ ] Create `src/components/stage/StageSpine.tsx`，阶段状态由项目数据派生（设定必填、架构确认数、蓝图章数、定稿章数）。
- [ ] Edit `src/App.tsx`，`shellPreference` 为 `stage` 时渲染新外壳，内容区沿用 `EditorArea` 的分发。
- [ ] Edit `src/shared/appearance-profile.ts`，`shellPreference` 增加 `stage` 取值并升级 schemaVersion，旧配置迁移时保持原值。

**Build.**

- [ ] 标签条复用 `editor-store` 的标签模型，只有一个标签时收起；⌘W 关闭当前标签，⌘P 查找章节，⌘S 对所有可编辑页生效。
- [ ] 流程脊在正文阶段展开章节列表，章节状态来自草稿与定稿数据。

**You see.**

- [ ] 在设置里切换为新外壳后，界面与 `claude-design/Main.dc.html` 的外壳部分一致（外框、悬浮面板、进度环流程脊、Ctrl K）。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/__tests__/stage-spine.browser.tsx` 断言四个阶段的状态派生与顺序。Run `pnpm test:browser -- src/components/stage`.
- [ ] `src/shared/__tests__/appearance-profile.test.ts` 新增旧版本配置迁移用例。Run `pnpm vitest run src/shared`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk 没有新外壳，记录这一事实；在 head 的旧外壳上运行 `baseline-all`。Save `rd3-regression.png`. Pass when 旧外壳与 trunk 像素差小于 0.5%，且新外壳能完成打开示例作品到看到正文。
- [ ] Lane 2. 新外壳打开示例作品，浅色。Save `rd3-shell-light.png`. Pass when 流程脊显示四个阶段与正确状态。
- [ ] Lane 3. 同上，深色。Save `rd3-shell-dark.png`. Pass when 文字对比度达标且无硬编码底色。
- [ ] Lane 4. 打开三个页面后关闭一个。Save `rd3-tabs.png`. Pass when 标签条出现并在只剩一个时收起。
- [ ] Lane 5. 有未保存修改时关闭标签。Save `rd3-dirty.png`. Pass when 出现确认且取消后内容保留。
- [ ] Lane 6. ⌘S 在小说配置页保存。Save `rd3-save.png`. Pass when 保存状态变为已保存。
- [ ] Lane 7. ⌘P 查找第 3 章。Save `rd3-find.png`. Pass when 打开第 3 章。
- [ ] Lane 8. 沉浸写作。Save `rd3-focus.png`. Pass when 只剩正文与章节动作条。
- [ ] Lane 9. 窗口宽度 1280。Save `rd3-1280.png`. Pass when 无横向滚动且无文字折断。
- [ ] Lane 10. 旧配置文件启动。Save `rd3-migrate.png`. Pass when 应用进入工作台，不出现启动阻塞。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 启动到可交互毫秒数；新外壳下切换章节到正文可见的毫秒数。
- [ ] Probe. trunk 旧外壳与 head 新外壳交替各 5 次 `startup-timing` 与 `chapter-switch`，两侧都先在同一隔离目录预启动一次写好外观再计时；另测 head 旧外壳对 trunk 旧外壳的启动，覆盖新外壳模块对旧外壳的加载代价。构建后先预热，机器空闲时测。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 启动中位数不超过 trunk 的 105%；章节切换中位数不超过 trunk 的 100%，绝对值不超过 150 毫秒。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、3、4 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-3 追加到 RD-2 之上，等待用户合并。

## 合并运行侧页并隐藏聊天 (RD-4)

**Depends on.** RD-3.

**Files.**

- [ ] Create `src/components/stage/run/RunSheet.tsx`，分页为进行中、历史、诊断。
- [ ] Edit `src/components/panels/AIOutputPanel.tsx` 与 `src/components/panels/BottomPanel.tsx`，拆出可复用的运行内容，删掉 Agent 恢复项与「切换回 Agent」。
- [ ] Edit `src/stores/layout-store.ts`，默认右侧视图改为运行。

**Build.**

- [ ] 运行侧页包含矩阵 F-126 至 F-147 的全部显示与操作；诊断分页用宽版侧页。
- [ ] 按 `docs/research/ux-audit-1.2.2-preview-20261011/req-hide-ai-chat.md` 隐藏聊天的四个入口；旧外壳同样生效。
- [ ] 清空日志、放弃恢复候选改为就地确认条。

**You see.**

- [ ] 写作此章后顶栏胶囊显示进度，点击展开运行侧页，聊天入口在任何位置都不可见。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/run/__tests__/run-sheet.browser.tsx` 断言三个分页、取消、暂停批量、确认继续、恢复候选的复制与放弃确认。Run `pnpm test:browser -- src/components/stage/run`.
- [ ] 断言聊天入口不存在的用例，中英文界面各一。Run `pnpm test:browser -- src/components/stage/run`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 运行写作此章场景。Save `rd4-regression.png`. Pass when 两边都显示同样的步骤与输出，head 不显示聊天。
- [ ] Lane 2. 运行侧页进行中分页。Save `rd4-running.png`. Pass when 步骤与实时输出持续更新。
- [ ] Lane 3. 取消运行。Save `rd4-cancel.png`. Pass when 运行停止且胶囊消失。
- [ ] Lane 4. 批量创作暂停与继续。Save `rd4-batch.png`. Pass when 暂停后不再开始新章，继续后恢复。
- [ ] Lane 5. 等待确认的角色候选。Save `rd4-confirm.png`. Pass when 选择后工作流继续。
- [ ] Lane 6. 恢复候选放弃。Save `rd4-discard.png`. Pass when 出现就地确认且确认后候选消失。
- [ ] Lane 7. 诊断分页。Save `rd4-diag.png`. Pass when 调用记录表与复制安全诊断可用，且不出现 token 字样。
- [ ] Lane 8. 英文界面。Save `rd4-en.png`. Pass when 无聊天入口且文案为英文。
- [ ] Lane 9. 旧外壳。Save `rd4-legacy.png`. Pass when 旧外壳也无聊天入口，AI 输出仍可打开。
- [ ] Lane 10. 有旧对话数据的项目。Save `rd4-olddata.png`. Pass when 打开不报错且磁盘上的对话文件未改动。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 生成过程中渲染进程每秒帧数与输出追加到界面的延迟。
- [ ] Probe. trunk 与 head 交替各 3 次 `write-stream`，夹具以固定速率输出 3000 字。
- [ ] Baseline. Record the trunk 帧数中位数与追加延迟 p95 first.
- [ ] Rule. 帧数不低于 trunk 的 95%，追加延迟 p95 不超过 trunk 的 110%。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、6、7 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-4 追加到 RD-3 之上，等待用户合并。

## 实现书房、设定与设置页 (RD-5)

**Depends on.** RD-3.

**Files.**

- [ ] Create `src/components/stage/library/`，对应 `prototype/library*.html`。
- [ ] Create `src/components/stage/setup/`，对应 `prototype/setup.html`，复用 `NovelConfigEditor` 的数据逻辑。
- [ ] Create `src/components/stage/settings/`，把 `SettingsModal` 的九个标签改为设置页三组分组。

**Build.**

- [ ] 书房提供新建、打开、导入、从最近项目移除（F-006）、删除作品（输入作品名确认）与更新卡（F-170、F-172）。
- [ ] 设定页把核心字段放首屏，「更多设定」与「高级」折叠，必填未齐时主按钮禁用并说明缺哪项。
- [ ] 设置页按分组打开，删除模型配置增加确认（F-160），缩放移入外观。

**You see.**

- [ ] 首次启动看到空书房，新建作品后进入设定页，与原型截图一致。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/library/__tests__/library.browser.tsx` 断言移除记录与删除作品的确认流程。Run `pnpm test:browser -- src/components/stage/library`.
- [ ] `src/components/stage/setup/__tests__/setup.browser.tsx` 断言必填校验与 AI 填充入口。Run `pnpm test:browser -- src/components/stage/setup`.
- [ ] `src/components/stage/settings/__tests__/settings.browser.tsx` 断言分组跳转与删除模型确认。Run `pnpm test:browser -- src/components/stage/settings`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 运行新建作品场景。Save `rd5-regression.png`. Pass when 两边都创建成功且项目文件一致。
- [ ] Lane 2. 空书房。Save `rd5-empty.png`. Pass when 唯一主按钮为新建作品。
- [ ] Lane 3. 书架预览一本书。Save `rd5-preview.png`. Pass when 概览显示阶段进度且不正式打开作品。
- [ ] Lane 4. 从最近项目移除。Save `rd5-remove.png`. Pass when 书从书架消失且项目目录仍在。
- [ ] Lane 5. 删除作品输入错误名称。Save `rd5-delete.png`. Pass when 确认按钮保持禁用。
- [ ] Lane 6. 设定页必填未齐。Save `rd5-setup.png`. Pass when 主按钮禁用并写明缺少目标读者。
- [ ] Lane 7. AI 填充配置（夹具模型）。Save `rd5-fill.png`. Pass when 字段被填充且可撤回编辑。
- [ ] Lane 8. 设置打开外观并切换深色。Save `rd5-dark.png`. Pass when 全局切换为深色且重启后保持。
- [ ] Lane 9. 删除模型配置。Save `rd5-model.png`. Pass when 出现危险确认。
- [ ] Lane 10. 更新卡下载（夹具更新源）。Save `rd5-update.png`. Pass when 有未保存修改时出现返回保存的拦截。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 书房首屏可交互毫秒数，20 本书时的书架渲染时间。
- [ ] Probe. trunk 首页与 head 书房交替各 5 次 `library-timing`，夹具含 20 个最近项目。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 两项都不超过 trunk 的 105%。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、3、6 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-5 按编号顺序追加，等待用户合并。

## 实现架构阶段与角色名单 (RD-6)

**Depends on.** RD-3.

**Files.**

- [ ] Create `src/components/stage/architecture/`，对应 `prototype/architecture*.html`，复用 `WorldBuildingEditor` 与 `ArchFileViewer` 的数据逻辑。
- [ ] Create `src/components/stage/characters/`，对应 `prototype/characters.html`，复用 `CharacterEditor` 与 `RelationshipGraph`。

**Build.**

- [ ] 四个分节就地编辑，架构确认对话框沿用 `ArchitectureConfirmDialog` 的数据，按新样式呈现覆盖与保留标记。实际做法：分节卡只显示状态与摘要，「编辑」打开该节的单节文档标签（`ArchFileViewer`），因为未保存提示、退出保存与 ⌘S 都绑在编辑器标签上，内嵌编辑会复制一套这样的保护。
- [ ] 大纲续写、恢复稿、角色名单修复与旧修复恢复（F-033 至 F-039）以提示条呈现。
- [ ] 角色建议与状态建议（F-117、F-118）合为一个提示条。

**You see.**

- [ ] 架构阶段显示四节状态，主按钮按状态在继续生成架构与下一步之间切换。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/architecture/__tests__/architecture.browser.tsx` 断言主按钮切换规则与清空此节确认。Run `pnpm test:browser -- src/components/stage/architecture`.
- [ ] `src/components/stage/characters/__tests__/characters.browser.tsx` 断言保存、删除确认与建议处理。Run `pnpm test:browser -- src/components/stage/characters`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 运行 AI 生成架构（夹具模型）。Save `rd6-regression.png`. Pass when 两边生成的四份文档内容一致。
- [ ] Lane 2. 架构阶段两节已确认。Save `rd6-partial.png`. Pass when 主按钮为继续生成架构。
- [ ] Lane 3. 四节全部确认。Save `rd6-done.png`. Pass when 主按钮为下一步章节蓝图。
- [ ] Lane 4. 架构确认对话框。Save `rd6-confirm.png`. Pass when 已生成项标出将覆盖或保留。
- [ ] Lane 5. 大纲续写第 17 至 24 章。Save `rd6-resume.png`. Pass when 续写只追加缺少的章节。
- [ ] Lane 6. 清空此节。Save `rd6-clear.png`. Pass when 出现危险确认且取消后内容不变。
- [ ] Lane 7. 角色名单编辑并保存。Save `rd6-char.png`. Pass when 名单与角色图谱投影同步。
- [ ] Lane 8. 关系图谱交互。Save `rd6-graph.png`. Pass when 缩放、拖拽、点节点打开档案都可用。
- [ ] Lane 9. 导入角色卡并处理建议。Save `rd6-cards.png`. Pass when 接受后角色出现在名单。
- [ ] Lane 10. 深色主题下的架构页。Save `rd6-dark.png`. Pass when 无硬编码底色且对比度达标。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 打开架构阶段到四节可交互的毫秒数；200 个角色时角色列表滚动帧数。
- [ ] Probe. trunk 故事架构标签与 head 架构阶段交替各 5 次 `arch-timing`，夹具含 200 个角色。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 打开时间不超过 trunk 的 105%，滚动帧数不低于 trunk 的 95%。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、4、7 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-6 按编号顺序追加，等待用户合并。

## 实现蓝图阶段与写作此章弹层 (RD-7)

**Depends on.** RD-3.

**Files.**

- [ ] Create `src/components/stage/blueprint/`，对应 `prototype/blueprint*.html`，复用 `ChapterCardEditor` 的数据逻辑。
- [ ] Create `src/components/stage/write/WriteChapterPopover.tsx`，取代 `ChapterCreationDialog` 中与蓝图重复的字段。

**Build.**

- [ ] 写作此章只问本次模型、作者微操指导与可选的检索关键词，其余参数直接取自蓝图；一致性预检（F-058）在弹层内呈现。
- [ ] 清空全部蓝图与删除此章进入危险分组并确认；生成蓝图与批量创作对话框按新样式呈现。

**You see.**

- [ ] 蓝图页主按钮为写第 N 章，点击下拉只出现一个小弹层，不再弹出大表单。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/write/__tests__/write-popover.browser.tsx` 断言提交的工作流参数与原对话框在同一蓝图下完全一致。Run `pnpm test:browser -- src/components/stage/write`.
- [ ] `src/components/stage/blueprint/__tests__/blueprint.browser.tsx` 断言危险操作确认与保存。Run `pnpm test:browser -- src/components/stage/blueprint`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 同一蓝图在 trunk 用对话框、在 head 用弹层启动写作（夹具模型）。Save `rd7-regression.png`. Pass when 两边发给工作流的参数完全一致。
- [ ] Lane 2. 蓝图页浅色。Save `rd7-light.png`. Pass when 与原型截图结构一致。
- [ ] Lane 3. 写作弹层。Save `rd7-popover.png`. Pass when 只含模型、指导与折叠的更多。
- [ ] Lane 4. 一致性预检提醒。Save `rd7-preflight.png`. Pass when 可保存安排或仅本次忽略。
- [ ] Lane 5. AI 生成蓝图覆盖模式。Save `rd7-overwrite.png`. Pass when 覆盖前二次确认。
- [ ] Lane 6. 批量创作 4 章。Save `rd7-batch.png`. Pass when 运行侧页出现批量卡。
- [ ] Lane 7. 清空全部蓝图。Save `rd7-clear.png`. Pass when 危险确认后列表为空且出现设计过的空状态。
- [ ] Lane 8. 蓝图恢复稿。Save `rd7-recover.png`. Pass when 提示条可编辑恢复稿并继续生成缺少的章节。
- [ ] Lane 9. 编辑字段后 ⌘S。Save `rd7-save.png`. Pass when 保存成功且只显示一处未保存提示。
- [ ] Lane 10. 深色主题。Save `rd7-dark.png`. Pass when 对比度达标。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 300 章蓝图时打开蓝图页与切换章节的毫秒数。
- [ ] Probe. trunk 与 head 交替各 5 次 `blueprint-timing`，夹具含 300 章蓝图。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 两项都不超过 trunk 的 105%。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、3、4 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-7 按编号顺序追加，等待用户合并。

## 实现正文单章视图 (RD-8)

**Depends on.** RD-7.

**Files.**

- [ ] Create `src/components/stage/chapter/ChapterView.tsx`，包含章节头、生命周期、章节动作条、版本切换器与纸面正文。
- [ ] Create `src/components/stage/chapter/ReviewSheet.tsx` 与 `MergeView.tsx`，复用 `ReviewReport` 与 `ThreeWayMerge` 的数据逻辑。
- [ ] Edit `src/components/editor/CodeMirrorEditor.tsx`，选区工具条改用新原语。

**Build.**

- [ ] 主按钮随状态依次为写作此章、AI 审稿（拆分按钮含检查维度）、按意见修稿、完成合并、定稿；直接修稿、删除这一稿、复制本章正文在更多菜单。
- [ ] 已归档草稿进入版本切换器；定稿后处理（F-090、F-091）与重新写入正文（F-089）在定稿视图。

**You see.**

- [ ] 一章从待写走到定稿，全程只在单章视图内完成，不需要打开项目树或其他标签。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/chapter/__tests__/chapter-lifecycle.browser.tsx` 断言五种状态下主按钮的文案与触发的工作流。Run `pnpm test:browser -- src/components/stage/chapter`.
- [ ] 合并视图断言逐段选择、全部用原稿、全部用修稿与完成合并后复验。Run `pnpm test:browser -- src/components/stage/chapter`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 同一章在 trunk 与 head 走完写作、审稿、修稿、合并、定稿（夹具模型）。Save `rd8-regression.png`. Pass when 两边定稿正文与后处理结果一致。
- [ ] Lane 2. 草稿状态。Save `rd8-draft.png`. Pass when 主按钮为 AI 审稿。
- [ ] Lane 3. 审稿报告侧页。Save `rd8-review.png`. Pass when 勾选数与主按钮文案同步。
- [ ] Lane 4. 添加作者意见。Save `rd8-manual.png`. Pass when 人工意见进入修稿输入。
- [ ] Lane 5. 合并视图逐段选择。Save `rd8-merge.png`. Pass when 合并结果与选择一致。
- [ ] Lane 6. 定稿确认。Save `rd8-finalize.png`. Pass when 定稿后正文只读并显示后处理四步。
- [ ] Lane 7. 后处理一步失败后重试（夹具注入失败）。Save `rd8-retry.png`. Pass when 只重试失败步骤。
- [ ] Lane 8. 选区工具条润色。Save `rd8-selection.png`. Pass when 预览后可替换或取消。
- [ ] Lane 9. 删除这一稿。Save `rd8-delete.png`. Pass when 危险确认后版本切换器不再列出该稿。
- [ ] Lane 10. 1280 宽度深色。Save `rd8-1280-dark.png`. Pass when 正文每行约 34 字且侧页不挤压正文到不可读。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 打开 1 万字章节到正文可滚动的毫秒数；输入时的按键到渲染延迟 p95。
- [ ] Probe. trunk 草稿标签与 head 单章视图交替各 5 次 `chapter-open` 与 `typing-latency`。
- [ ] Baseline. Record the trunk 两项指标 first.
- [ ] Rule. 打开时间不超过 trunk 的 105%；按键延迟 p95 不超过 trunk 的 105% 且绝对值不超过 16 毫秒。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、3、5、6 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-8 追加到 RD-7 之上，等待用户合并。

## 实现作品资料页 (RD-9)

**Depends on.** RD-3.

**Files.**

- [ ] Create `src/components/stage/plot/`，对应 `prototype/plot*.html`，复用 `NarrativeThreadEditor` 与 `PlotTreeView` 的数据逻辑。
- [ ] Create `src/components/stage/knowledge/`，对应 `prototype/knowledge.html`，复用 `KnowledgeOverview` 的数据逻辑。
- [ ] Create `src/components/stage/history/`，对应 `prototype/history.html`，复用 `VersionHistory`。

**Build.**

- [ ] 清除剧情树与删除线索计划增加确认（F-100、F-104）。
- [ ] 版本对比改为只读差异视图，不再复用修稿合并（F-094）；回退新建回滚草稿并说明。
- [ ] 知识库不出现实现术语，重建索引移到设置高级。

**You see.**

- [ ] 三个资料页与原型结构一致，资料页之间切换不丢失正文标签。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/components/stage/plot/__tests__/plot.browser.tsx` 断言两个危险操作的确认。Run `pnpm test:browser -- src/components/stage/plot`.
- [ ] `src/components/stage/history/__tests__/history.browser.tsx` 断言对比视图只读与回退新建草稿。Run `pnpm test:browser -- src/components/stage/history`.
- [ ] 文案扫描测试断言资料页不含 LanceDB、FTS、BM25、Embedding、向量、query。Run `pnpm test:browser -- src/components/stage/knowledge`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 与 head 生成剧情树（夹具模型）。Save `rd9-regression.png`. Pass when 两边快照内容一致。
- [ ] Lane 2. 剧情树。Save `rd9-plot.png`. Pass when 主线支线两轨显示且说明它不参与写作。
- [ ] Lane 3. 清除剧情树。Save `rd9-clear.png`. Pass when 出现确认。
- [ ] Lane 4. 伏笔线索确认定稿事件。Save `rd9-threads.png`. Pass when 确认后线索路线推进。
- [ ] Lane 5. 删除线索计划。Save `rd9-delete.png`. Pass when 出现确认。
- [ ] Lane 6. 知识库导入资料并检索。Save `rd9-kb.png`. Pass when 结果片段高亮且无实现术语。
- [ ] Lane 7. 知识库编辑项目副本未保存时切换资料。Save `rd9-kb-dirty.png`. Pass when 出现未保存确认。
- [ ] Lane 8. 版本历史对比。Save `rd9-diff.png`. Pass when 对比视图只读。
- [ ] Lane 9. 回退到 v1。Save `rd9-revert.png`. Pass when 新建 v3 回滚草稿且 v1、v2 保留。
- [ ] Lane 10. 深色主题下三页。Save `rd9-dark.png`. Pass when 对比度达标。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 100 章作品打开剧情树与版本历史的毫秒数。
- [ ] Probe. trunk 与 head 交替各 5 次 `refs-timing`，夹具含 100 章与每章 5 个版本。
- [ ] Baseline. Record the trunk 两项中位数 first.
- [ ] Rule. 两项都不超过 trunk 的 105%。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、6、8 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-9-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-9 按编号顺序追加，等待用户合并。

## 切换默认外壳并删除旧外壳与皮肤 (RD-10)

**Depends on.** RD-4、RD-5、RD-6、RD-8、RD-9.

**Files.**

- [ ] Delete `src/components/layout/LeftToolWindowBar.tsx`、`RightToolWindowBar.tsx`、`BottomToolWindowBar.tsx`、`StatusBar.tsx`、`layout/v2/ShellV2.tsx`、`src/styles/redesign/`。
- [ ] Delete 皮肤相关代码，包括 `src/stores/skin-store.ts`、`electron/services/skin-service.ts`、`electron/controllers/skin-controller.ts`、`public/skins/` 与 `index.css` 的皮肤与 galaxy、paper 主题。
- [ ] Edit `src/shared/appearance-profile.ts`、`src/shared/startup-contract.ts`、`electron/ipc-channels`，迁移外观配置并移除皮肤通道。
- [ ] Edit `scripts/check-i18n-coverage.mjs` 的 `rendererRoots`，以及 34 个 `_electron` 旅程脚本的页面对象。
- [ ] Edit `docs/adr/0021-stage-flow-replaces-ide-shell.md` 为已接受，并更新 `docs/product-domain.md`。

**Build.**

- [ ] 默认外壳改为新外壳；旧配置中的 galaxy 迁移为深色，paper 与 light 迁移为浅色，anime 与 custom 皮肤迁移为无皮肤，原值保留在旧键供回滚。
- [ ] 颜色字面量检查移除允许清单，`src/components` 全部零容忍。

**You see.**

- [ ] 全新安装与旧版本升级后都直接进入纸墨界面，设置里没有皮肤。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/shared/__tests__/appearance-profile.test.ts` 断言四种旧主题与三种旧皮肤的迁移结果。Run `pnpm vitest run src/shared`.
- [ ] 全量门禁 `pnpm typecheck`、`pnpm lint`、`pnpm check:i18n`、`pnpm test`、`pnpm test:browser` 全部通过；偶发失败的文件单独重跑并记录。Run `pnpm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 在 trunk 旧外壳与 head 新外壳上走完从新建作品到第 1 章定稿的完整旅程（夹具模型）。Save `rd10-regression.png`. Pass when 两边项目数据一致。
- [ ] Lane 2. 全新安装首次启动。Save `rd10-fresh.png`. Pass when 显示空书房。
- [ ] Lane 3. 用 galaxy 主题加动漫皮肤的旧配置启动。Save `rd10-migrate-galaxy.png`. Pass when 进入深色纸墨界面且不阻塞。
- [ ] Lane 4. 用 paper 主题加自定义皮肤的旧配置启动。Save `rd10-migrate-paper.png`. Pass when 进入浅色纸墨界面且不阻塞。
- [ ] Lane 5. 功能保全抽查，矩阵每个任务域随机 3 项。Save `rd10-matrix.png`. Pass when 每项都能从规范入口完成。
- [ ] Lane 6. 英文界面完整旅程。Save `rd10-en.png`. Pass when 无未翻译文案。
- [ ] Lane 7. 键盘完成写作一章。Save `rd10-keyboard.png`. Pass when 不用鼠标完成并且焦点环始终可见。
- [ ] Lane 8. Windows 安装包烟测 `pnpm build:win`。Save `rd10-buildwin.png`. Pass when 发布门禁全部通过。
- [ ] Lane 9. 34 个旅程脚本全部运行。Save `rd10-journeys.png`. Pass when 全部通过。
- [ ] Lane 10. 1280 与 1920 两种宽度浅深色各截一套。Save `rd10-widths.png`. Pass when 与原型截图结构一致且无溢出。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 启动到可交互毫秒数、渲染进程产物大小、空闲内存占用。
- [ ] Probe. trunk 与 head 交替各 5 次 `startup-timing` 与 `idle-memory`，并各构建一次统计产物。
- [ ] Baseline. Record the trunk 三项指标 first.
- [ ] Rule. 启动中位数不超过 trunk 的 105%，产物与空闲内存都不超过 trunk；删除旧外壳与皮肤后应当更小，变大即为失败。

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2、3、5、10 screenshots into `docs/design/2026-10-11-frontend-redesign/review/RD-10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `docs/design/2026-10-11-frontend-redesign/review/RD-10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] 主 Agent 把 RD-10 作为栈顶追加，等待用户合并。

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `feature-matrix.md` 增加「新位置」列，192 项可见功能每项写明规范入口与验证截图。
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

- 视觉方向。三个方向的原型与截图在 `directions/`，提交 `b97b61bf` 与 `f604a3fc`，用户于 2026-10-11 选定 A 纸墨。
- 完整原型。`prototype/` 共 33 屏，浅色与深色截图在 `prototype/shots/`，目录页为 `prototype/index.html`。
- 视觉基准。Claude Design 美化版 7 块画板在 `claude-design/`，用户于 2026-10-11 确认为最终视觉基准；色值、外壳、字体以它为准，`prototype/` 用于状态与功能覆盖。
- 已由原型回答的问题。章节列表嵌入流程脊可让正文在 1440 宽度下保持约 34 字一行；运行诊断需要宽版侧页；写作此章只需模型、指导与检索关键词三项。
- 尚未证明的问题。新外壳在 Electron 中的真实性能、旧配置迁移、34 个旅程脚本迁移的工作量，都要在 RD-0 与 RD-3 中实测。
- 原型与 `ia.md` 不一致的地方以 `ia.md` 为准。一是「AI 审稿」应为拆分按钮，下拉弹层勾选检查维度，`chapter-draft.html` 画成了普通按钮。二是书房的设置入口应在书房顶栏，`library.html` 画在右栏底部。三是顶栏作品名下拉菜单（回到书房、切换作品、导出、项目备份、清除生成内容）是 F-011、F-151、F-152、F-012 的规范入口，原型没有画出展开状态。
- 原型未覆盖、由对应 PR 负责人按 `design-system.md` 补设计的状态。未配置任何模型时的首次使用（各 AI 按钮的禁用说明与去设置的入口，归 RD-5），沉浸写作（F-173，外壳部分归 RD-3；`claude-design/Focus.dc.html` 的全出血深色纸面与底部字数进度条归 RD-8），角色名单修复与旧修复恢复（F-033 至 F-035，归 RD-6），删除此章与清除误导入正文（F-051、F-052，归 RD-7），定稿后的角色状态建议（F-118，归 RD-6），重建检索索引（F-124，归 RD-9），失败提示（F-134，归 RD-4），其余四种恢复类型（F-136 至 F-139，归 RD-4），设置中检索模型、网络代理、提示词模板、写作 Skills、关于与更新各页（F-163 至 F-171，归 RD-5）。

## Appendix B. Alternatives rejected

- 在现有外壳上换皮。前两次改版（paper-ink 主题、v3 杂志皮肤）都这样做，导航与多入口问题一个都没有消除。
- 方向 B 暗房与方向 C 格。B 白天长时间阅读较累且像开发工具；C 的大数字容易退化为装饰。
- 取消多标签编辑。用户 2026-10-11 明确保留。
- 一次性大 PR 替换。无法逐片验证，回滚成本高。

## Appendix C. Risks

- 34 个 `_electron` 旅程脚本与 85 个浏览器测试绑定旧类名。RD-0 先建页面对象，RD-10 统一迁移，负责人盯住失败数。
- `layout-store` 有非界面调用方。RD-2 先抽导航意图，负责人确认工作流启动与项目切换的行为不变。
- 外观配置校验严格，迁移失误会让老用户卡在启动检查。RD-3 与 RD-10 各有迁移用例与实机旧配置启动。
- 皮肤横跨主进程、启动契约与发布烟测 `release-skin-smoke`。RD-10 同步修改发布门禁，`pnpm build:win` 为必过项。
- 中文衬线字体体积大。RD-1 设字体预算，必要时只内置常用字子集。
- 原型里有子 Agent 编写的示例行为未经核实，包括导入原稿时的冲突处理、知识库保存后自动更新检索、清除对话框中「小说设定会保留」。相应 PR 的负责人对照真实代码核实，不以原型为准。
- 全量测试在并行负载下偶发失败。失败文件单独重跑并在 PR 中记录，不以一次全绿为唯一证据。

## Appendix D. Links and reading list

- 设计依据。`ia.md`、`design-system.md`、`feature-matrix.md`、`prototype/BRIEF.md`、ADR-0021、ADR-0008。
- 审核来源。`docs/research/ux-audit-1.2.2-preview-20261011/` 的三份文档。
- RD-2、RD-3、RD-8、RD-10 的负责人先读 `skills/how/SKILL.md` 做现状走查；RD-3 与 RD-10 合并前跑 `skills/interrogate/SKILL.md` 多模型对抗审查。
- 决策记录按 `skills/show-me-your-work/SKILL.md` 写在每个负责人的工作树内。
