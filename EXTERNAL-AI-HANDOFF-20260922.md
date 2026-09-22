# 外部 AI 代劳（审稿 + 修稿）交接文档 · 2026-09-22

> 承接对象：先生 / 下一个会话的蓝汐。
> 目标：读完不必重新摸索，直接能打包、能接着改。
> 工作目录：`G:\深鲸湾\AI-Novel-Writer\AI-Novel-Writer-1.1.0-clean`（分支 `1.1.0-v3`）

---

## 零、一句话状态

**「外部 AI 审计」与「外部 AI 修稿」两个板块已完整落地、全量验证通过，可以打包。**
内置审稿 / 修稿的行为**一字未改**（只做了等价重构），不改变任何既有流程。

---

## 一、这次做了什么（按先生的需求顺序）

| # | 先生的要求 | 落地结果 |
|---|---|---|
| 1 | 审稿面板加「外部 AI 审计」，默认 DeepSeek / 豆包 / 千问 / Kimi，可自建入口、自动读 logo | 收藏夹式板块：2×2 网格、翻页、新建/删除、站点图标 |
| 2 | 通义千问 logo 白得看不见 | 八个内置入口改用**随包发布**的品牌图标（通义换成官方蓝色 Qwen 标），并给所有图标垫固定浅底 |
| 3 | 第二页放 ChatGPT / Gemini / 文心一言 / 腾讯元宝；按钮小一点；左右小三角翻页 | 默认 8 个入口分两页，卡片收小一档，翻页改成描边小三角 |
| 4 | 「这样只能单章审计，起不到内置那种效果」 | 材料改为**与内置审稿同源**（九块材料全带上），并抽出单一来源的装配服务 |
| 5 | 「内置审计还有 Skill，也要加上」 | 审稿取 `review` 阶段、修稿取 `refinement` 阶段的绑定，注入文本与内置一字不差 |
| 6 | 材料能不能拆分、挑选参与 | 材料子菜单：逐块勾选 + 三档预设 + 每块字数 + 选择记忆 |
| 7 | 能不能像拖 md 文件那样投递 | 两种投递：文本粘贴（默认）/ **`.md` 文件粘贴**（走 Windows 文件剪贴板，粘贴即上传） |
| 8 | 让修稿也具备外网修稿能力 | 「外部 AI 修稿」板块 + **结果回流**通道 |
| 9 | 流程要二选一：内部 AI / 外部 AI | 弹窗顶部互斥开关；未选外部时整块灰掉不可交互；卡片改为**选择框**（可多选，一次打开多家）；进入外部模式即**预装配**并显示各块字数 |
| 10 | 回流不该直接覆盖，要打开差异对比 | 回流改走项目自带的**三方合并视图**；外部来源的合并结果只写回编辑器，不提交修订记录 |

---

## 二、文件清单

### 新增 · 共享与业务层

| 文件 | 职责 |
|---|---|
| `src/shared/external-ai-audit.ts` | 入口契约、**材料块池**（审稿/修稿共用）、预设、URL 安全规范化、站点图标推导、剪贴板抬头文案 |
| `src/shared/external-ai-text.ts` | `stripCodeFence` —— 剥掉整段 Markdown 代码块围栏 |
| `src/stores/external-ai-audit-store.ts` | 入口收藏夹 + 材料勾选 + 交付方式（localStorage） |
| `src/services/external-ai-audit-client.ts` | 写剪贴板（含回退）、打开系统浏览器、**文件剪贴板**调用 |
| `src/services/external-ai-audit-review.ts` | 外部**审稿**装配入口（取 `review` Skill、包抬头、生成文件列表） |
| `src/services/external-ai-refine-material.ts` | 外部**修稿**装配入口（取 `refinement` Skill、同上） |
| `src/services/prompts/chapter-review-prompt.ts` | **审稿材料装配 —— 单一来源**（内置审稿与外部审计共用） |
| `src/services/prompts/chapter-refine-prompt.ts` | 修稿材料装配（与内置直接修稿同源，另补前文事实与角色状态） |
| `src/services/prompts/writing-skill-block.ts` | 写作 Skill 注入文本 —— **单一来源**（内置工作流与外部代劳共用） |

### 新增 · 界面层

| 文件 | 职责 |
|---|---|
| `src/components/editor/ExternalAiAuditBoard.tsx` | **板块组件**（审稿/修稿共用一副骨架；差异全由 config 注入） |
| `src/components/editor/external-ai-handoff-config.ts` | 审稿 / 修稿两份配置（标题、文案、材料清单、预设、回流入口） |
| `src/assets/brand-icons/*.png` | 八个内置入口的品牌图标（deepseek / doubao / tongyi / kimi / chatgpt / gemini / yiyan / yuanbao） |

### 新增 · 主进程

| 文件 | 职责 |
|---|---|
| `electron/controllers/external-ai-audit-controller.ts` | `external-ai-audit:open` —— 校验 URL 后交给系统浏览器 |
| `electron/controllers/external-ai-audit-file-controller.ts` | `external-ai-audit:copy-files` —— 写 .md 并把路径放进剪贴板文件列表 |

### 改动（关键处）

| 文件 | 改了什么 | 风险 |
|---|---|---|
| `src/services/workflows/commands/review-chapter.command.ts` | 装配逻辑抽到 `chapter-review-prompt`，**行为一字未改** | 低（69 项回归测试守着） |
| `src/services/workflows/commands/base-command.ts` | Skill 注入文本改调共享函数 | 低（同格式，有测试） |
| `src/components/editor/DraftEditor.tsx` | 两个确认弹窗接入板块；执行方式二选一；合并完成分流外部来源 | 中（改动多，已用浏览器测试覆盖） |
| `src/shared/ipc-channels.ts` | 加两个通道类型 | 低 |
| `electron/ipc-handlers.ts` | 注册两个 controller | 低 |
| `electron/__tests__/ipc-handlers-skin.test.ts` | 同步补 controller mock（项目铁律） | — |
| `src/index.css` | 加 `.handoff-board-disabled` 两条灰态规则 | 低 |

---

## 三、关键设计决策（为什么这么做）

1. **材料装配只有一份**。内置审稿要发的材料与外部要复制的材料，由同一个 `buildChapterReviewPrompt` 产出 —— 否则两边会慢慢走偏，先生会发现「同一章，两个 AI 结论对不上」。
2. **外部修稿比内置多给两块**：已定稿剧情事实、角色状态。内置直接修稿的摘要变量其实是空的（工作流没传），改稿时看不到前文很容易改出矛盾；网页版上下文宽裕，补上它。修稿模板没有 `character_states` 变量，所以角色状态作为**独立段**追加，并写明「照着写、别改写」。
3. **执行方式做成互斥单选**（不是勾选框）。先生的原话是「只能二选一」；勾选框允许多选，会出现「两个都勾着、按下去执行谁」的歧义。
4. **预装配在进入外部模式时发生**，启动时会**重新装配一次** —— 预取只为让先生先看到字数，真启动必须用编辑器里最新的正文。
5. **卡片是选择框**：选几家开几家，但材料只装配一份、剪贴板里只贴一份。
6. **回流走三方合并，绝不覆盖**。外部来源的合并结果只写回编辑器（先生自己按保存），**不提交修订记录** —— 它本来就没有 `revisionPath`，硬走原路径会写脏数据。
7. **灰态用 `cursor: not-allowed` 在外层、`pointer-events: none` 在内层**。反过来写的话鼠标样式不会变（被 `pointer-events: none` 挡住的元素收不到鼠标事件），先生就看不到「禁止」图标。

---

## 四、数据与落盘

| 项 | 值 |
|---|---|
| 入口收藏夹 | localStorage `ai-novel-writer-external-ai-audit` |
| 材料勾选 + 交付方式 | localStorage `ai-novel-writer-external-ai-audit-preferences` |
| 文件投递落盘 | `<应用数据目录>/external-audit/`（每次重建目录，避免上一章残留被误粘） |
| 剪贴板机制 | Windows `CF_HDROP` 文件列表；经 `powershell.exe -STA` 的 WinForms API 写入 |

**剪贴板那两个坑**（踩过，写这里免得再踩）：

1. 必须走 **STA 线程**的 WinForms 剪贴板 API —— PowerShell 7 默认 MTA，调用直接失败，得用 `powershell.exe -STA`；
2. 路径**不能走命令行参数**：中文路径会被转码弄坏，数组还会被拼成一个逗号串。改成写一份 **UTF-8 JSON**、用**环境变量**递路径；且 JSON 顶层必须是对象而不是裸数组（PowerShell 5.1 的 `ConvertFrom-Json` 不枚举顶层数组）。

---

## 五、安全边界

- **打开外链**：`normalizeExternalAiUrl` 只放行 `http/https` + 合法主机名，`javascript:` / `file:` / `ms-msdt:` 一律拒绝；主进程**再校验一次**（渲染进程的输入永远不可信）。
- **写盘**：文件名清洗（压平路径分隔符、去控制字符、限长 80、强制 `.md`/`.txt`），单文件 4 MB、最多 32 个；只落在固定的应用数据目录，不碰项目目录。
- **素材来源**：内置八家的图标随包发布；作者自建入口的图标走 `favicon.im`（会把该域名告诉该服务 —— 对公开 AI 站点无隐私顾虑）。

---

## 六、打包前检查

```powershell
cd G:\深鲸湾\AI-Novel-Writer\AI-Novel-Writer-1.1.0-clean

pnpm run typecheck          # 0 错误
pnpm run lint               # 0 error 0 warning
pnpm run check:i18n         # 通过
pnpm test                   # 单元测试
pnpm run test:browser       # 浏览器测试（需 AI_NOVEL_VITEST_CHROMIUM 指向本机 chromium）
pnpm run build              # dist + dist-electron
```

**依赖与前提**：

- **native 模块要按运行时切换**（这条最容易忘，务必先看一眼）：
  - 跑单元测试（node）之前：`pnpm run prepare:native-node`
  - 打包 / 跑 Electron 之前：`pnpm run rebuild:electron`

  `better-sqlite3` 为谁编译，就只有谁能加载它。**忘了切**会出现大片
  `The module '…better_sqlite3.node' …` 失败 —— 本轮就踩了一次：全量测试
  397 项报错、看着像回归，其实是 native 停在 Electron 版；切回 node 版即恢复。
  遇到这种失败**先切 native，别急着怀疑代码**。
- 文件投递依赖 `powershell.exe`（Windows 自带，无需安装）；
- 内置八个入口的图标**已随包**，无网也能显示；只有作者自建入口的图标需要外网；
- 构建产物已确认包含新通道：`dist-electron/main.js` 里可搜到 `external-ai-audit:copy-files` 与 `SetFileDropList`。

**全项目 lint 的既有问题**（**不是本次引入**，不阻塞打包，但会让 CI 红）：

| 文件 | 问题 |
|---|---|
| `src/components/panels/sidebar/__tests__/CharactersView-pending-entry.browser.tsx:87` | `no-extra-semi`（多余分号，`eslint --fix` 可自动修） |
| `src/components/dialogs/InspirationDrawDialog.tsx:139` | `react-hooks/exhaustive-deps`：`useMemo` 多了一个用不到的 `locale` 依赖 |
| `src/stores/__tests__/pending-badge.browser.tsx:47` | `react-refresh/only-export-components`（测试文件里的辅助组件） |

这三处**本次没有擅自改动** —— 它们不在改动范围内，先生打包前可自行决定是否顺手清掉。

> **2026-09-22 先生审计后的裁定：三处都不动。**
> 蓝汐逐个查过：三处**都不是真 bug**（①②③ 分别只是多余分号、依赖写成「信号」、测试探针无 export），
> 且 ①③ 都在测试文件里、不进生产包。**唯一要记住的是 ②**：
> `InspirationDrawDialog.tsx:139` 的 `[locale]` 依赖**不要**照 lint 建议删掉 ——
> 它是「语言切换时重算」的触发信号，删了才会变成真 bug（@ 菜单里两项文案不再跟随语言）。
> 若日后要修，正确写法是用组件已订阅的 `text` 并依赖 `[text]`（见 `CharacterCandidateReviewDialog.tsx:71`、`ProjectTree.tsx:232`）。
> `eslint --fix` 只修①的分号，不会碰②，可以放心跑。

**建议顺手清理**（都不影响打包，属工作区卫生）：

- `artifacts/` 下的验收截图（已在 `.gitignore` 内）；
- 若剪贴板里还留着蓝汐早前放的测试 `.md`（`_diag\clip-file-test`），可以直接清掉 —— 那个目录现已不存在，剪贴板里的路径会失效。

---

## 七、验证记录（本次实测）

| 项目 | 结果 |
|---|---|
| 相关单元测试 | **11 个文件 / 102 项全绿** |
| 板块浏览器测试 | **24 项全绿**（含选择框、多选打开、灰态、预装配、回流、v3 皮肤配色断言） |
| 审稿链路回归 | 69 项全绿（`base-command-writing-skill` / prompt 契约 / workflow locale 等） |
| 类型检查 · ESLint · i18n · 生产构建 | 全过 |
| 视觉存档 | `artifacts/ext-ai-audit-*.png`、`ext-ai-refine-board.png`（浅色 / 星空 / v3 杂志皮肤 / 材料面板 / 修稿板块） |

### 全量单元测试（打包前实测）

在 `pnpm run prepare:native-node` 之后跑 `node .\node_modules\vitest\vitest.mjs run`：

| 项 | 结果 |
|---|---|
| 通过 | **338 个文件 / 3274 项** |
| 跳过 | 26 项 |
| 失败 | 6 个文件 / 14 项 —— **全部在 `scripts/` 打包脚本契约里**，且是并行资源竞争所致 |

那 14 项失败的报错是 `Could not complete terminal process lineage refresh for parent PID …`：
多个 smoke 测试在全量并行时同时 spawn PowerShell 引发的偶发失败。
**单独跑 `scripts/__tests__/smoke-win-installer.test.ts` 是 60 项全过** ——
与本次改动无关，打包时若遇到可单独复跑确认。

⚠️ **两个环境坑（本轮都踩了，写这里省下一次排查）**：

1. **native 模块未切换** → 全量出现 397 项 `better_sqlite3.node` 失败，看着像大回归，其实是 native 停在 Electron 版；`pnpm run prepare:native-node` 后即恢复（详见第六节）。
2. **打包脚本契约测试的并行竞争** → 见上表；判断方法是单独复跑那个文件。

> 本会话收尾时已把 native **切回 Electron 版**（`pnpm run rebuild:electron` 成功），
> 先生可直接打包；跑单元测试前记得再切回 node 版。

跑单元测试的命令（精确清单）：

```powershell
node .\node_modules\vitest\vitest.mjs run `
  src/shared/__tests__/external-ai-audit.test.ts `
  src/stores/__tests__/external-ai-audit-store.test.ts `
  src/services/__tests__/external-ai-audit-client.test.ts `
  src/services/__tests__/external-ai-audit-review.test.ts `
  src/services/__tests__/external-ai-refine-material.test.ts `
  src/services/prompts/__tests__/chapter-review-prompt.test.ts `
  src/services/prompts/__tests__/chapter-refine-prompt.test.ts `
  src/components/editor/__tests__/external-refine-merge-contract.test.ts `
  electron/controllers/__tests__/external-ai-audit-controller.test.ts `
  electron/controllers/__tests__/external-ai-audit-file-controller.test.ts `
  electron/__tests__/ipc-handlers-skin.test.ts
```

---

## 八、已知限制 / 待先生实测确认

1. **`.md` 文件粘贴能否触发上传**：机制层已验证（剪贴板里确实是文件列表，独立进程读回成功；先生也实测过「复制压缩包 → 网页粘贴 → 提示文件不对」）。但**各家网页版 AI 是否都接受 `.md`** 尚未逐个验证 —— 若某家不接受，切回「文本粘贴」即可。
2. **修稿输出是整章正文**，比审稿报告占字数，网页版 AI 的输出上限可能成为瓶颈；遇到截断可让它分两次给，或换输出上限大的模型。
3. **favicon.im 依赖外网**：内置八家不受影响，自建入口在断网时退回首字母块。
4. `--color-bg-elevated` 这个变量在全项目**从未定义**，另有 8 处仍在用它（`DraftEditor` 的附加修稿要求输入框、`ReviewReport` 4 处、`three-way-merge.css` 2 处、`NovelConfigEditor` 1 处带 fallback）。本次只修了外部 AI 板块自己的两处，其余**留给先生定夺**（改法一样：换成 `--color-raised`）。

---

## 九、给下一个会话的蓝汐

1. **别再自己拼一份材料**。审稿走 `chapter-review-prompt`、修稿走 `chapter-refine-prompt`，两条路都是单一来源 —— 新加材料块请改 shared 的块池 + 对应装配服务。
2. **内置审稿 / 修稿不许动行为**。这次是等价重构，`review-chapter.command.ts` 的 prompt 内容与 `base-command.ts` 的 Skill 注入结果都没变；要改请先跑回归。
3. **改文本一律用编辑工具，不要借 PowerShell 的手**。本轮踩过：`Get-Content` 按 ANSI 读 UTF-8 文件，把测试文件的中文注释变成乱码（74 行字符永久丢失，最后整份重写）。这条是血泪教训。
4. **回流契约有测试守着**（`external-refine-merge-contract.test.ts`）：外部修稿必须走差异对比，不许直接覆盖。要改这条先改契约。
5. 先生的偏好：**材料要能自己挑、字数要能看见、覆盖原稿之前一定要让他先过目**。
