# 「墨纸书斋」新界面衔接说明（v2 外壳阶段）

> 分支：`feat/ui-redesign`　基点：`master`（`250ec66`）
> 首次提交：`f2552e1`　状态：**外壳阶段已完成并验证通过**

---

## 一、这次做了什么

把 `AI小说家-Demo/novel-app-demo-relation-avatars.html` 的界面，**只换皮、不动业务**地接进了原软件。

| 层 | 处理方式 |
|---|---|
| 业务真相（store / IPC / 数据库 / 工作流） | **一行未动** |
| 外壳（顶栏 / 书脊 / 侧栏框 / 编辑区框 / 助手框 / 状态栏） | 已换成 demo 的墨纸书斋 |
| 外壳内含的业务组件 | 原样嵌入（`Sidebar` / `EditorArea` / `AIPanel` / `AIOutputPanel` / `BottomPanel`） |
| 面板内部视觉 | **尚未迁移**（见「六、待办」） |

**只改动了 3 个既有文件**：`src/App.tsx`、`src/components/layout/StatusBar.tsx`、`src/main.tsx`。
其余 19 个文件全是新增 —— 这是刻意的：回滚成本越低，越敢往前推。

---

## 二、怎么用（含回滚）

### 切换界面版本
1. **设置 → 外观 → 界面版本**，二选一：`墨纸书斋`（新）/ `经典界面`（原）。
2. 切换**立即生效**，不影响项目数据、不会中断运行中的创作任务。
3. 默认值为 `v2`（新界面）。选择持久化在 `localStorage` 的 `ai-novel-writer-ui-version`。

### 三条回滚路径
| 场景 | 做法 |
|---|---|
| 新界面某个角落不对，但软件能开 | 设置 → 外观 → 切回「经典界面」 |
| 软件打不开或界面崩了 | 控制台执行 `localStorage.setItem('ai-novel-writer-ui-version','v1')` 后刷新 |
| 整块改动都不要 | `git revert f2552e1`（v1 未被删除，只被条件包裹） |

---

## 三、文件地图

```
src/styles/redesign/
├── shell.css          demo 六个 <style> 片段的原样搬运（约 1250 行），已做作用域收拢并归入 @layer components
├── v2-themes.css      demo 四套配色（浅色/星空/纸质/黑夜）转成纯 CSS 属性选择器
└── v2-overrides.css   接线补充：拖拽区、窗口控制、底层面板容器、任务胶囊皮肤

src/components/layout/
├── AITaskCapsule.tsx  从 StatusBar 抽出，v1/v2 共用（原先的 127 行重复实现已删）
├── exit-guard.tsx     退出守卫（未保存内容 + 运行中任务），v1/v2 共用
├── theme-cycle.ts     主题循环 + View Transition 扩散，v1/v2 共用
├── v2-theme.ts        产品主题 → demo 主题索引映射
└── v2/
    ├── ShellV2.tsx       外壳骨架与分栏拖拽
    ├── TitleBarV2.tsx    顶栏（印章 / 书名 / 保存态 / 六道工序 / 模型胶囊 / 命令区 / 窗口控制）
    ├── SpineNav.tsx      书脊导航（功能一项不减：书架·目录·人物·知识库·世界·伏笔·蓝图 + 任务/日志/模型/设置）
    ├── StatusBarV2.tsx   状态栏
    ├── FlowStages.tsx    六道工序条（纯展示，可脱离 store 单测）
    ├── useCreationStage.ts  由既有 WorkflowType 派生当前工序
    └── GripHandle.tsx    分栏拖拽手柄（照 demo 自研实现，非面板库）

src/stores/ui-version-store.ts   界面版本开关（工厂式 + 依赖注入，与项目其它 store 同构）

public/brand/seal-44.png          印章 logo（来自 demo）
public/fonts/YiShanBeiZhuanTi.ttf 篆体字体（来自 demo，供 --zhuan 使用）
```

---

## 四、四个关键决策（附理由）

### 1. v2 走新文件，不覆盖 v1
`visual-fidelity-contract.test.ts` 对 `TitleBar.tsx` / `StatusBar.tsx` / `LeftToolWindowBar.tsx` 等 11 个文件做了**结构断言**（必须含 `writer-topbar`、不得出现内联 `<svg>` 与 emoji 伪图标）。与其改动 v1 去迎合新皮肤，不如让 v2 完全独立 —— 换壳与回滚互不干扰。

### 2. 样式归入 `@layer components`
`index.css` 头部写得很明确：无层样式会覆盖 Tailwind 工具类，导致 `px-3/py-1` 全部失效。`shell.css` 是 demo 原样搬运（无层），所以整体包进 `@layer components`，让 Tailwind 的 `@layer utilities` 仍然能赢。**嵌入式业务组件的既有 Tailwind 类因此完全不受影响。**

### 3. CSS 变量留在 `:root`，其余选择器收拢进 `[data-ui="v2"]`
- 元素级 reset、伪元素、滚动条一律限定在 `[data-ui="v2"]` 子树内；
- 变量仍定义在 `:root` —— 因为产品用 Radix，对话框会 Portal 到 `body`，变量若限定在子树内，弹窗会瞬间失去全部配色。
- 前提是**已实测零冲突**：demo 61 个变量 vs 产品 151 个变量，交集为空；类名交集同样为空。

### 4. 共享逻辑抽出来，两套外壳共用
任务胶囊、退出守卫、主题循环这三块是**产品行为**而不是皮肤。抽到 `src/components/layout/` 下供 v1/v2 共用；v1 的 `StatusBar.tsx` 已同步接入，删掉 127 行重复实现。这样"换壳"不会变成"两套逻辑各自漂移"。

---

## 五、验证证据（均为实测，非推断）

| 检查项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ exit 0 |
| `pnpm run check:i18n` | ✅ 通过 |
| `vite build` | ✅ exit 0 |
| 构建产物 | `[data-ui=v2]` 37 处、`[data-v2-theme="0..3"]` 各 1 处、`@layer` 分层保留、字体走相对路径 `../fonts/` |
| `vitest run src` | 1410 通过 / 11 失败 |
| 布局契约测试（含 `visual-fidelity-contract`） | ✅ 全部通过 |
| 设置 + 布局测试 | ✅ 20 通过 / 0 失败 |

### 关于那 11 个失败
**与本次改动无关，且不是回归**：失败文件只有两个（`export-service-integration`、`finalize-postprocess-character.integration`），原因是原生模块环境问题 ——

```
better_sqlite3.node was compiled against a different Node.js version
using NODE_MODULE_VERSION 145. This version of Node.js requires NODE_MODULE_VERSION 127.
```

即 `better-sqlite3` 是为 Electron 编译的，直接用系统 Node 跑 vitest 加载不了。全量跑时共有 47 个文件、313 个用例因此失败，全部落在 `electron/`、`scripts/` 等依赖原生模块的目录。

**需要全绿时**：先 `pnpm run prepare:native-node` 为 Node 重编译；回到 Electron 开发前再 `pnpm run rebuild:electron`。这是产品原有的工作流，不是本次新增的负担。

### 冲突扫描（迁移前做的安全验证）
| 维度 | demo | 产品 | 交集 |
|---|---|---|---|
| CSS 变量 | 61 | 151 | **0** |
| CSS 类名 | 399 | 96 | 4（`active`/`light`/`paper`/`ttf`，均无害） |
| TSX 实际用类 | — | 551 | **0** |
| `@keyframes` | 7 | 23 | **0** |

---

## 六、已知问题与待办

### 必须处理
1. **面板内部仍是旧视觉。** 侧栏、编辑区、助手对话框、设置页 9 个分页、各类对话框都还是 v1 皮肤。当前是"新外壳 + 旧内胆"的中间态，属计划内第二阶段。
2. **篆体字体授权未登记。** `YiShanBeiZhuanTi.ttf` 已放进 `public/fonts/`，但**尚未**写入 `public/fonts/THIRD_PARTY_NOTICES.md` 与 `licenses/`。产品对字体授权有明确登记规范，上架前必须补齐或换字。
3. **demo 关系图的 7 个贴图资源缺失。** `shell.css` 引用了 `relationship_assets/frame_*.png`，demo 自身也没有这些文件。构建时会报 7 条 "didn't resolve" 警告，运行时 404。迁移关系图面板时需补素材。

### 已知取舍
4. **顶栏的「章节进度」「全书字数」没有实现。** demo 有这两块，但产品当前没有可靠的实时数据源（章节总数要经 IPC 读项目配置，字数需要统计）。宁可留空也不摆假数字。
5. **demo 的「星空」主题暂未启用。** 产品 `galaxy` 是深蓝底（`#0A1628`），而 demo 的"星空"是浅冷调（纸底 `#E8EDF2`），两者明度相反、只是名字相近。当前映射为 `galaxy → 黑夜`，星空配色完整保留在 `v2-themes.css` 中，随时可改映射启用。
6. **六道工序条只在有运行时点亮。** 阶段由 `WorkflowType` 与步骤名派生；空闲状态整条置灰，而不是猜一个阶段。若需要"根据项目当前进度点亮"，要另接架构/蓝图/草稿/审稿/定稿的存在性判定（多次 IPC）。

---

## 七、下一步：面板迁移的推荐顺序

按「耦合浅 → 耦合深」推进，每步都能独立验收、独立回滚：

1. **设置页（9 个分页）** —— demo 里最完整、与业务耦合最浅，适合打样整条链路（含视图模型适配层）。
2. **侧栏六个视图**（书架 / 目录 / 人物 / 世界 / 伏笔 / 知识库）—— demo 的 `renderSidebar()` 已有对应结构，逐个把 mock 换成 store 数据。
3. **助手面板**（AI 对话 + AI 输出）—— 结构基本同构，主要是皮。
4. **编辑器与对话框** —— 耦合最深（CodeMirror/Monaco、脏状态、项目会话），放最后。

### 每一步的固定手法
1. **先写视图模型**：`use*ViewModel()` 把真实 store 组装成 demo 期望的形状，组件几乎不用改；
2. **再换皮**：保留语义角色与文案，让现有 `*.browser.tsx` 行为测试继续当回归网；
3. **补 Storybook**：项目已配好 Storybook，逐件做视觉对照；
4. **同时补空态/加载态/错误态** —— demo 是演示态（假数据、短文本），真实数据会撑破它；英文文案也更长，这是最容易翻车的地方。

---

## 八、给先生的三个提醒

1. **先跑一遍看看**：`pnpm run dev`，进设置 → 外观切两次界面版本，确认两套都能正常起。
2. **字体授权**这件事请先生定：继续用 demo 的篆体（需登记授权），还是换成已有的 `LXGW WenKai` / `Noto Serif SC`。
3. **面板迁移是第二阶段**，工作量比外壳大得多。建议先做设置页打样，确认「视图模型 → 换皮 → 行为测试」这套手法跑得通，再铺开。
