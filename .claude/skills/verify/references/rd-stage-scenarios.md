# 纸墨外壳场景（RD-3 至 RD-9）

按页面查场景：流程脊、运行侧页、书房与设置、架构与角色、蓝图与写作弹层、正文单章、作品资料页。

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
| `stage-revert-after-final` | 第 1 章定稿后重新打开，重开稿换成回退的内容（定稿章上「回退到此版本」的效果，ADR-0024）：第 1 章回到草稿，但最后一章在写的仍是第 4 章，打开作品落在第 4 章；章节列表里第 1 章按草稿显示，点它打开的是重开稿 | 第 1 章重开稿 | 否 | 第 7 条 |
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
| `blueprint-null-field` | 示例作品的蓝图行不写悬念钩子、作者微操指导与章节要点（库里是 NULL），只给第 5 章填上。先看第 5 章（确认显示它自己的值）再切到第 6 章：三个文本框为空，切回再切、重新加载、重启后都一样。依次直接离开、改标题按 Ctrl S、退出确认里「保存并退出」（主进程收到放行时不关窗，之后取消退出），每次用 `node:sqlite` 只读打开项目库读第 6 章原始行，都没有第 5 章的文字；再在第 6 章作者微操指导与章节要点里各打几个字保存，库里只有打的字。`measured` 是每一步看到的值与读到的行 | 第 6 章蓝图的作者微操指导 | 否 | 蓝图作者字段 NULL |

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
| `chapter-recheck-digest` | 第 4 章审稿（带正文证据的本章目标意见）、按意见修稿、全部用修稿合并，`fake.replyReview` 传函数让合并后的复验回一份合法复核 JSON：运行侧页的复验候选显示结论、条数与「待核实」要点，不显示原始 JSON；切到英文重开后显示「1 item」与「Needs verification」；中途拍 `chapter-recheck-digest-zh` | 英文的复验摘要 | 是 | #484 |
| `run-usage-en` | 同 `chapter-rereview-legacy` 重新审稿后切到英文重开：只请求一次的审稿候选写「1 request used」，不写成复数 | 英文运行侧页 | 是 | #484 |
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
| `refs-timing` | 100 章，第 1、2 章是定稿、各 1 稿（定稿章不能新建稿），其余每章 5 稿，用夹具模型整理好剧情树并停在剧情树页；计时从点版本历史到第 100 章出现在章节列表（`historyOpenMs`），再从点剧情树到第 1 章事件出现在表格里（`plotOpenMs`），渲染进程内按帧计时 | 剧情树 | 是 | perf |

perf：trunk 与 head 交替各跑 5 次，取两项各自的中位数。trunk 早于 #562（定稿重开）时，它的第 1、2 章也各建 5 稿，夹具比 head 多 8 稿，对照时注明。head 加 `--shell stage`，trunk 用旧外壳的左栏「历史」「剧情」进入。

```bash
node scripts/redesign/drive.mjs --scenario refs-timing --app-root <trunk 工作树> --out <目录>
node scripts/redesign/drive.mjs --scenario refs-timing --shell stage --out <目录>
```
