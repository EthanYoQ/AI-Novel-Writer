# 新 UI Demo ↔ 产品设计令牌映射表（token-map）

> 文档性质：可执行的迁移映射表（Design Token Mapping Spec）
> 创建日期：2026-02（本文件为新建，未改动任何源码）
> 上游来源（只读，未修改）：
> - 新 UI Demo：`AI小说家-Demo/novel-app-demo-relation-avatars.html`（3794 行；CSS 位于第 7–1261 行，共 6 个 `<style>` 块）
> - 产品现有样式：`AI-Novel-Writer-pr/src/index.css`（1785 行；`@theme`(L83–157) → `@layer base`(L163–605) → `@layer components`(L611–1101) → 无层样式(L1497–1785)）
> - 字体资产：`AI-Novel-Writer-pr/public/fonts/`、`src/stores/theme-store.ts`(FONT_OPTIONS L26–77)、`src/tokens/`
> 口径声明：本表所有「代表取值」一律取 **主题 0（浅色）** 的静态 `:root` 值；四个主题的完整镜像取值见 §2 表 2-1。

---

## 0. 开工前的事实校正（两处与任务简报不符，以源码为准）

| 简报说法 | 源码事实 | 影响 |
| --- | --- | --- |
| Demo 主题为 `data-theme="1\|2\|3\|4"` | 实际是 `data-theme="0\|1\|2\|3"`，由 `applyTheme()` 用 `String(i)` 写入（demo L2521），菜单四色块对应 0=浅色、1=星空、2=纸质、3=黑夜（demo L1263、L2500） | 迁移时主题索引按 0–3 处理，无第 4 号主题 |
| 主题通过 CSS 的 `html[data-theme=…]` 块定义 | **CSS 里只有 1 处用到 data-theme 选择器**（demo L819–820，黑夜下隐藏草稿/终稿文件图标）。其余全部主题色由 JS 数组 `THEME_COLORS`（demo L2501–2506）经 `applyTheme()` → `setThemeVars()` → `documentElement.style.setProperty`（demo L2510–2511）**以内联样式注入** | 主题色不可被产品 `data-skin` / `data-skin-readability` 覆盖层接管，且首屏存在 FOUC 风险；迁移必须把 JS 数组转成 CSS 主题块（见 §4 风险 R11） |
| Demo 变量「约 60 个」 | 精确 **64 个**自定义属性：全局 47 个（`:root` L15–36 = 44 个，第二 `:root` L508–511 = 2 个，另含 L46 之外的 1 个见下）+ 组件级局部 17 个 | 口径见 §1，逐行可追溯 |

> 全局 47 = 颜色 34 + 字体 5 + 尺寸 5 + 阴影 1 + 动效/其他 2。组件级 17 = 主题预览 1 + 书柜几何 12 + 图谱层级 4。
> 另：`--font-face 'YiShanZhuan'`（demo L37）已声明但**未被任何变量引用**，属死代码（详见 §3 表 3-1 注）。

---

## 1. 变量总表（64 行，全部给出「原值 → 目标值 + 依据」）

图例：
- ✅ **可直连**：语义与值都对应，直接换名即可
- ⚠️ **覆盖型**：能映射到现有令牌名，但**我方主题值必须重设**，否则语义偏移
- ➕ **需新增**：产品无对应令牌，给出建议新名（语义化命名，遵循产品 `--color-*` / `--font-*` / `--height-*` / `--width-*` 风格）
- ⛔ **不迁移**：组件私有运行时值，保留在组件作用域内

### 1-1 颜色类（34 个）

| Demo 变量（出处） | 分类 | 代表取值（主题0 浅色） | 原值 → 目标值 | 映射依据 / 处理建议 |
| --- | --- | --- | --- | --- |
| `--paper` (L16) | 颜色·表面 | `#F3EFE4` | `#F3EFE4` → ✅ `var(--color-bg)`（产品 `#F7F3E8`，L174） | 两边同为「最底层纸面/窗口底」。语义链一致：比坐面亮、比抬升面暗 |
| `--paper2` (L16) | 颜色·表面 | `#ECE5D3` | `#ECE5D3` → ➕ `--color-surface-sunken`（建议值 `#ECE5D3`） | demo 中它是**静态**次级纸面：body 底（L40）、tabbar 渐变端（L162）、禁用输入底（L259）。产品无「比 bg 更深的静态面」语义；复用 `--color-hover` 会把静态面与交互态混用 |
| `--panel` (L16) | 颜色·表面 | `#FAF7EE` | `#FAF7EE` → ✅ `var(--color-raised)`（产品 `#FCFAF3`，L175） | 编辑器底（L160）、卡片（L248）、模态（L280）、设置面板（L399）。**注意语义反转**：产品 `--color-panel`(L177 `#F0EADA`) 是比 bg 更暗的侧栏面，见 §4 风险 R1 |
| `--panel2` (L16) | 颜色·表面 | `#F6F1E3` | `#F6F1E3` → ➕ `--color-surface-card-muted`（备选 `var(--color-hover)` `#EAE3D2`） | 次级卡片面：`.paper-card`(L249)、`.settings-card`(L458)、`.theme-card`(L662)、`.resource-card`(L694)。它是「第二档卡片面」而非交互态，建议独立令牌 |
| `--manuscript` (L17) | 颜色·表面 | `#FCFAF2` | `#FCFAF2` → ✅ `var(--color-editor-bg)`（产品 `#FCFAF3`，L232） | 写作纸面：关系画布底（L863/L874/L1007/L1250）、边线文字描边（L883/L1016）。与产品 `--color-editor-bg` 几乎同值（差 1 个 B 通道） |
| `--ink` (L18) | 颜色·文字 | `#2A261E` | `#2A261E` → ✅ `var(--color-text)`（产品 `#2B2A26`，L184） | 正文主色，一一对应 |
| `--ink2` (L18) | 颜色·文字 | `#57513F` | `#57513F` → ✅ `var(--color-text-secondary)`（产品 `#6E6A5F`，L185） | 次级文字（树行 L122、按钮字 L229）。⚠️ 见 §4 风险 R2：产品 secondary(`#6E6A5F`) 比 muted(`#655F55`) 更亮，档位顺序反直觉 |
| `--muted` (L18) | 颜色·文字 | `#8F8876` | `#8F8876` → ✅ `var(--color-text-muted)`（产品 `#655F55`，L186） | 弱化文字（标签 L63、说明 L71/L265）。产品该令牌明度更低，迁移后弱化层级会「更弱」，需目视校准 |
| `--faint` (L18) | 颜色·文字 | `#B7AE99` | `#B7AE99` → ➕ `--color-text-faint` | demo 是**四档**文字层次（ink/ink2/muted/faint），产品只有**三档**；faint 大量用于小字标注（L119/L254/L271/L312/L417/L432/L441/L493）。压到 `--color-text-muted` 会让标注与正文说明失去层级 |
| `--line` (L19) | 颜色·边框 | `#E0D8C2` | `#E0D8C2` → ✅ `var(--color-border)`（产品 `#E3DCC9`，L189） | 一级边框/分隔，对应产品唯一边框令牌 |
| `--line2` (L19) | 颜色·边框 | `#D2C8AE` | `#D2C8AE` → ➕ `--color-border-strong` | demo 是**两级**边框：line2 用于输入框描边（L255/L319/L333/L476/L542）、模态边（L281）、次级分隔（L60/L76/L79/L139）。产品只有一级 `--color-border` |
| `--seal` (L20) | 颜色·强调 | `#A93226` | `#A93226` → ✅ `var(--color-accent)`（产品 `#B5402C`，L192） | 「朱砂/印章」= 产品「强调色」。改名映射（seal → accent），语义完全等价 |
| `--seal-hover` (L20) | 颜色·强调 | `#8C2A20` | `#8C2A20` → ✅ `var(--color-accent-hover)`（产品 `#9A3524`，L193） | 同上，悬停态 |
| `--seal-rgb` (L20) | 颜色·强调 | `169,50,38` | `169,50,38` → ✅ `var(--color-accent-rgb)`（产品 `181,64,44`，L194） | 用于半透明叠加。✅ 附带修复：产品每主题都重设 rgb 三元组，而 demo 的 `THEME_COLORS` **不含** rgb 字段，见 §4 风险 R9 |
| `--jade` (L21) | 颜色·表面 | `#33404F` | `#33404F` → ➕ `--color-surface-inverse` | 「黛蓝」深色块：AI 头像底（L185）、ink 按钮（L223）、关于页徽记（L739）。产品无「深色反相块」令牌，`--color-activity-bar` 在浅色主题是浅色（L179） |
| `--jade2` (L21) | 颜色·状态栏 | `#2B3642` | `#2B3642` → ⚠️ `var(--color-statusbar)`（产品浅色 `#FCFAF3`，L220） | 用途是状态栏底（L194）与书写进度胶囊（L205），**结构与产品同义**；但 demo 要的是深色状态栏、产品浅色主题是浅色状态栏 → 值必须重设，见 §4 风险 R4 |
| `--info` (L22) | 颜色·语义 | `#3D6E8F` | `#3D6E8F` → ⚠️ `var(--color-info)`（产品浅色 `#54666E`，L208） | **同名不同义**：产品浅色主题的 `--color-info` 被写成黛青（与 gold 同），demo 是靛蓝。星级/信息徽章（L246、L530）会串色，必须显式重设 |
| `--gold` (L23) | 颜色·装饰 | `#B9A34A` | `#B9A34A` → ⚠️ `var(--color-gold)`（产品浅色 `#54666E`，L197） | **同名不同义（最高危之一）**：产品注释明写「品牌金色 → 黛青（供残留渐变类取色）」(L196)，只有 galaxy/dark 才是真金 `#C9A76C`(L316/L460)。直接复用会把金色书签/进度渐变（L80、L240 边框、L665 悬停边）变黛青。见 §4 风险 R3 |
| `--gold2` (L23) | 颜色·装饰 | `#8C7A2E` | `#8C7A2E` → ➕ `--color-gold-strong` | 深金，用于进度渐变终色（L80）与主题缩略条，产品无深金档 |
| `--green` (L24) | 颜色·语义 | `#4E7A54` | `#4E7A54` → ✅ `var(--color-success)`（产品 `#527A5B`，L200） | 完成态圆点/连线（L72/L77/L155）、ok 按钮（L234） |
| `--greentx` (L24) | 颜色·语义 | `#3E6B47` | `#3E6B47` → ✅ `var(--color-success-text)`（产品 `#386042`，L201） | 绿色**文字**色，对应产品的 `-text` 后缀约定 |
| `--green-rgb` (L24) | 颜色·语义 | `78,122,84` | `78,122,84` → ➕ `--color-success-rgb` | demo 有 13 处硬编码 `rgba(78,122,84,…)`（如 L242/L530/L881/L934/L1014/L1040）依赖此三元组；产品只有 `--color-accent-rgb` |
| `--chrome1` (L25) | 颜色·表面 | `#F8F5EB` | `#F8F5EB` → ➕ `--color-chrome-top` | 顶栏渐变起点（`.titlebar` L52、`.edtool` L268）。产品顶栏是**单色** `--color-titlebar`(L178/L220)，无渐变令牌 |
| `--chrome2` (L25) | 颜色·表面 | `#F1ECDE` | `#F1ECDE` → ➕ `--color-chrome-bottom` | 顶栏渐变终点，同上 |
| `--white` (L25) | 颜色·表面 | `#FFFFFF` | `#FFFFFF` → ✅ `var(--color-raised)`（产品 `#FCFAF3`） | **语义是「抬升白面」而非白色**：hover 面（L84/L124/L230）、toggle 圆点（L707）。铁证是黑夜主题下它被覆盖为 `#3C4145`（demo L2505）——迁移时必须按语义改名，绝不能落到字面 `#FFFFFF` |
| `--soft-white` (L25) | 颜色·表面 | `#FFFDF7` | `#FFFDF7` → ✅ `var(--color-bg)`（产品 `#F7F3E8`） | 输入/文本域底（L255、L333、L542、L724/L732），与产品 `--writer-input-surface: var(--color-bg)`（L417）、`.config-input` 用 `--color-bg`（L904）完全同构 |
| `--spine1` (L25) | 颜色·导轨 | `#313C47` | `#313C47` → ➕ `--color-rail-gradient-start` | 左侧「书脊」导航渐变起点（L95）。产品活动栏 `--color-activity-bar` 浅色主题是 `#F0EADA`（L179），明度完全相反，不能直连 |
| `--spine2` (L25) | 颜色·导轨 | `#272F38` | `#272F38` → ➕ `--color-rail-gradient-end` | 同上，渐变终点 |
| `--red` (L26) | 颜色·语义 | `#C0392B` | `#C0392B` → ✅ `var(--color-error)`（产品 `#B5402C`，L205） | 危险徽章（L244） |
| `--redtx` (L26) | 颜色·语义 | `#A93226` | `#A93226` → ✅ `var(--color-error-text)`（产品 `#8F3020`，L206） | ⚠️ 注意 demo 浅色下 `--redtx` 与 `--seal` **同值**（都是 `#A93226`），说明 demo 未区分「错误文字」与「强调色」；产品已区分，迁移后热标记（L131）会与强调色脱钩，需目视确认 |
| `--red-rgb` (L26) | 颜色·语义 | `192,57,43` | `192,57,43` → ➕ `--color-error-rgb` | 5 处硬编码 `rgba(192,57,43,…)`（L244/L327） |
| `--warn` (L27) | 颜色·语义 | `#C08A2D` | `#C08A2D` → ✅ `var(--color-warning)`（产品 `#C68A3A`，L203） | 待修订圆点（L157）、警告徽章底色 |
| `--warntx` (L27) | 颜色·语义 | `#7A5414` | `#7A5414` → ✅ `var(--color-warning-text)`（产品 `#7A5414`，L204） | **完全同值**，最干净的一条映射 |
| `--warn-rgb` (L27) | 颜色·语义 | `192,138,45` | `192,138,45` → ➕ `--color-warning-rgb` | 5 处硬编码 `rgba(192,138,45,…)`（L243/L326） |

### 1-2 字体 / 尺寸 / 阴影 / 动效（13 个）

| Demo 变量（出处） | 分类 | 代表取值（主题0 浅色） | 原值 → 目标值 | 映射依据 / 处理建议 |
| --- | --- | --- | --- | --- |
| `--serif` (L28) | 字体 | `Georgia,"Songti SC","STSong","SimSun",serif` | → ✅ 产品家族 `'Noto Serif SC'`（`@font-face` L57–63），经令牌 `var(--font-writing)` 的**次选位**（L287） | 宋体/印刷感。用于标题、正文首字（L500–501）、图谱人名（L1022）。⚠️ 产品 `--font-writing` 首选是霞鹜文楷（楷），语义不完全等同，见 §4 风险 R6 |
| `--kai` (L29) | 字体 | `"Kaiti SC","STKaiti","KaiTi",serif` | → ✅ 产品家族 `'LXGW WenKai'`（`@font-face` L39–54），令牌 `var(--font-writing)` **首选位**（L287） | 楷体。用于 AI 头像字（L185）、图谱首字（L886/L1100）。产品「霞鹜文楷」正是楷体首选，推荐映射到 `--font-writing` |
| `--zhuan` (L30) | 字体 | `'Lanxi-游龙篆书','Lanxi-山北篆体','Lanxi-小篆','FZXiaoZhuanTi-S13S','STKaiti','KaiTi','SimSun',serif` | → ➕ `--font-seal-script`（需随包引入篆书字体文件） | 篆书装饰字：首页「续写」水印（L148）、关于页「墨纸书斋」（L738）。产品 4 个家族（Inter/LXGW WenKai/Noto Serif SC/Noto Sans SC）**无一为篆书**；demo 自己声明的 `'YiShanZhuan'`（L37）也未被该变量引用 |
| `--sans` (L31) | 字体 | `system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif` | → ✅ `var(--font-sans)`（产品 `'Noto Sans SC', system-ui,…`，L85/L285） | 界面默认字（body L40）。产品允许用户在 `FONT_OPTIONS`(theme-store L26–77) 切到 Inter/思源黑体/系统字体，接口是 `--font-sans` |
| `--mono` (L32) | 字体 | `ui-monospace,"Cascadia Code",Consolas,monospace` | → ✅ `var(--font-mono)`（产品 `'Fira Code', Consolas, ui-monospace`，L86/L286） | 版本号/标签（L271、L741、L799）。⚠️ 产品 `public/fonts/` **无 Fira Code 文件**，实际回退 Consolas，见 §3 表 3-2 |
| `--h-title` (L33) | 尺寸 | `56px` | `56px` → ✅ `var(--height-titlebar)`（产品 `40px`，L257） | 顶栏高。**值差 16px**，且产品自身存在 `--height-titlebar:40px`(L257) 与 `@theme --spacing-titlebar:36px`(L96) 两处冲突，见 §4 风险 R8 |
| `--h-status` (L33) | 尺寸 | `26px` | `26px` → ✅ `var(--height-statusbar)`（产品 `28px`，L258） | 状态栏高，差 2px |
| `--h-tab` (L33) | 尺寸 | `36px` | `36px` → ✅ `var(--height-tab)`（产品 `36px`，L259） | **完全同值**，唯一零成本直连的尺寸令牌 |
| `--h-tool` (L33) | 尺寸 | `42px` | `42px` → ➕ `--height-editor-toolbar` | 编辑器工具条高（L267）。产品只有 titlebar/statusbar/tab/panel-header 四种高度令牌，无工具条 |
| `--w-spine` (L34) | 尺寸 | `60px` | `60px` → ✅ `var(--width-left-bar)`（产品 `72px`，L261） | 左导轨宽。demo 60px < 产品 72px，迁移后导航图标列会变宽，需重排图标尺寸（demo `.sbtn` 50×47，L98） |
| `--shadow` (L35) | 阴影 | `0 1px 2px rgba(90,70,30,.05),0 12px 32px -20px rgba(90,70,30,.28)` | → ✅ `var(--shadow-md)`（产品 `0 4px 12px rgba(43,42,38,.07)`，L274）；备选 `--shadow-lg`(L275) | 卡片级低弥散阴影。⚠️ 两处差异需拍板：(1) demo 是 **暖棕** rgba(90,70,30)，产品是**中性墨色** rgba(43,42,38)；(2) 产品卡片实际用 `--shadow-sm`（`--writer-card-shadow` L416），比 demo 更收敛 |
| `--theme-transition-x` (L509) | 动效 | `calc(100vw - 28px)` | → ➕ `--theme-reveal-origin-x` | View Transition 圆形扩散圆心 X（JS 覆写于 L2522）。产品有同名机制的 keyframes（L1660–1675）但未把圆心暴露为变量，圆心硬写在 JS |
| `--theme-transition-y` (L510) | 动效 | `28px` | → ➕ `--theme-reveal-origin-y` | 同上，圆心 Y（覆写于 L2523） |

### 1-3 组件级局部变量（17 个）

| Demo 变量（出处） | 分类 | 代表取值 | 原值 → 目标值 | 映射依据 / 处理建议 |
| --- | --- | --- | --- | --- |
| `--tp` (L669–672) | 颜色·装饰 | `#A93226`（light）/`#7CB6D6`（starry）/`#8A6B3E`（paper）/`#D9B769`（night） | → ➕ `--color-theme-preview-bar` | 主题选择卡里的「色条」象征色，一个变量承载 4 组值。可直接取各主题的 `var(--color-accent)`，但星空卡要的是浅蓝而 galaxy 的 accent 恰好是 `#7EC8E3`，建议改为引用 `var(--color-accent)` 而不是新增 |
| `--x` (L349 + JS) | 尺位·运行时 | `0px` | → ⛔ 不迁移，保留组件私有（建议改名 `--shelf-offset-x`） | 书柜拖拽位移，纯运行时几何值，无主题语义 |
| `--height` (L352) | 尺寸·运行时 | `220px` | → ⛔ 不迁移（建议改名 `--shelf-book-height`） | 单本书高度，JS 按主题注入（L2930） |
| `--width` (L352) | 尺寸·运行时 | `24px` | → ⛔ 不迁移（建议改名 `--shelf-book-width`） | 书脊厚度 |
| `--depth` (L352) | 尺寸·运行时 | `10px` | → ⛔ 不迁移（建议改名 `--shelf-book-depth`） | 书脊纵深（3D） |
| `--rot` (L352) | 尺位·运行时 | `-.8deg` | → ⛔ 不迁移（建议改名 `--shelf-book-tilt`） | 倾倒角 |
| `--cover` (L352) | 颜色·运行时 | `#263241` | → ➕ `--color-book-cover` | 书封主色，JS 按主题注入（L2930）。属「书柜视觉」语义族，产品无对应 |
| `--edge` (L352) | 颜色·运行时 | `#18212d` | → ➕ `--color-book-cover-edge` | 书封暗边 |
| `--text` (L352) | 颜色·运行时 | `#eee5d5` | → ➕ `--color-book-cover-text`（**必须改名**） | **同名不同义高危**：demo 的 `--text` 是书脊烫印字色，产品的 `--color-text` 是全局正文色。形态近似，极易误写成 `var(--color-text)` 导致书脊黑字，见 §4 风险 R5 |
| `--foil` (L352) | 颜色·运行时 | `#c7a66d` | → ➕ `--color-book-cover-foil` | 书脊烫金线（L368/L373） |
| `--lift` (L354 引用 / L358–362 赋值 / L2930 JS) | 尺位·运行时 | `-5px` | → ⛔ 不迁移（建议改名 `--shelf-book-lift`） | 悬停抬升量，多状态覆盖（hover/hovered/pressed/held/selected） |
| `--yaw` (L354 / L358–362 / L2930) | 尺位·运行时 | `-8deg` | → ⛔ 不迁移（建议改名 `--shelf-book-yaw`） | 3D 偏转角 |
| `--nudge` (L363–364 / L2930 JS) | 尺位·运行时 | `0px` | → ⛔ 不迁移（建议改名 `--shelf-neighbor-nudge`） | 邻书避让位移 |
| `--rel-opacity` (L1144 / L3579 JS) | 动效·图谱 | `0.30`–`1` | → ➕ `--graph-node-opacity` | 关系远近决定节点透明度，按 `data-depth` 注入（L3579）。属图谱模块的可复用设计决策 |
| `--node-size` (L1150–1168) | 尺寸·图谱 | `82px`(main)/`66px`(important)/`54px`(normal)/`36px`(satellite)/`26px`(far) | → ➕ `--graph-node-size` | 五级亲疏层级尺寸。同一套值在 L1179–1184 又被 `!important` 覆盖成 104/82/50/30/15，**demo 内部已自相矛盾**（见 §4 风险 R10） |
| `--name-size` (L1151–1169) | 尺寸·图谱 | `16px`(main)/`14px`/`12px`/`9px`/`8px` | → ➕ `--graph-node-name-size` | 随层级缩放的姓名号 |
| `--role-size` (L1152–1159) | 尺寸·图谱 | `10px`(main)/`9px`/`8.5px` | → ➕ `--graph-node-role-size` | 身份小字 |

### 1-4 统计口径（与摘要口径一致）

| 处理方式 | 数量 | 说明 |
| --- | --- | --- |
| ✅ 可直连现有令牌 | 27 | 换名即可，值差异 < 10%（个别需目视校准明度） |
| ⚠️ 覆盖型（映射现有令牌 + 我方必须重设值） | 3 | `--gold`、`--info`、`--jade2` |
| ➕ 需新增令牌 | 26 | 颜色 13 · 字体 1 · 尺寸 1 · 动效 2 · 图谱 4 · 书柜 4 · 主题预览 1 |
| ⛔ 不迁移（组件私有运行时值） | 8 | 书柜几何值 8 个 |
| **合计** | **64** | 与 §1 逐行条数一致 |

---

## 2. 主题对应关系

### 2-1 四主题代表值对照（demo 值来自 `THEME_COLORS` L2501–2506，产品值来自 index.css）

| 主题位 | Demo 名称（L2500） | paper | panel | ink | seal/accent | 产品最接近者 |
| --- | --- | --- | --- | --- | --- | --- |
| `data-theme="0"` | 浅色 | `#F3EFE4` | `#FAF7EE` | `#2A261E` | `#A93226` | `light` / `paper`（产品二者同值，L168–171） |
| `data-theme="1"` | 星空 | `#E8EDF2` | `#F7F9FB` | `#24313C` | `#4B7EA6` | 无（与 `galaxy` **明度相反**） |
| `data-theme="2"` | 纸质 | `#EFE5D0` | `#FCF8EE` | `#2E281F` | `#8C6F3B` | 无（产品 `paper` 无独立值） |
| `data-theme="3"` | 黑夜 | `#25282B` | `#2E3337` | `#F2E8D8` | `#C88B3A` | `dark` |

产品候选侧取值：

| 产品主题 | 选择器（index.css） | bg | panel | text | accent |
| --- | --- | --- | --- | --- | --- |
| `light` | `:root, .paper, .light`（L168–288） | `#F7F3E8` | `#F0EADA` | `#2B2A26` | `#B5402C` |
| `paper` | 同上（**无独立值块**） | `#F7F3E8` | `#F0EADA` | `#2B2A26` | `#B5402C` |
| `galaxy` | `.galaxy`（L291–367） | `#0A1628` | `#0E1B30` | `#E0ECF4` | `#7EC8E3` |
| `dark` | `.dark`（L440–509） | `#1E1E1E` | `#252526` | `#D4D4D4` | `#0E639C` |

### 2-2 逐主题判定与推荐对应顺序

| Demo 主题 | 推荐对应产品主题 | 依据（具体取值对比） | 结论等级 |
| --- | --- | --- | --- |
| **0 浅色** | **`light`**（`paper` 亦可，二者同值） | paper `#F3EFE4` vs bg `#F7F3E8`（ΔE 极小，同为米纸）；ink `#2A261E` vs text `#2B2A26`；seal `#A93226` vs accent `#B5402C`（同为朱砂）。三档全对齐，是**唯一干净对应** | ✅ 直接对应 |
| **3 黑夜** | **`dark`** | 同为深底亮字：paper `#25282B` vs bg `#1E1E1E`（同为中性深灰，差 7 级明度）；ink `#F2E8D8` vs text `#D4D4D4`（都是亮字）。面板层级也同构（panel 比 bg 亮一档）。**差异在中性色温**：demo 是暖灰 + 金强调 `#C88B3A`，产品 dark 是中性灰 + VS Code 蓝 `#0E639C`。→ 采用 `dark` 的**结构**，但需重设 `--color-accent*` 与面值 | ⚠️ 对应但需重设值 |
| **1 星空** | **无干净对应**；名字对 `galaxy`，视觉相反 | demo 是**浅色冷调**（paper `#E8EDF2` 浅雾蓝、ink `#24313C` 深墨）；产品 `galaxy` 是**深色星空**（bg `#0A1628`、text `#E0ECF4`）。二者明度完全反转，只有「冰蓝 accent」一项相通（demo seal `#4B7EA6` vs galaxy accent `#7EC8E3`）。→ 若按名字硬套，等于把界面整体反色，等于重做 | ❌ 名字对应、语义不对应：**需新增浅色冷调主题**（建议命名 `mist` / `azure`，与 `paper`/`galaxy` 同一命名颗粒度）；或产品决策「星空改造为深色」并接受视觉推翻 |
| **2 纸质** | **无干净对应** | demo 纸质 = 暖黄纸 `#EFE5D0` + 棕金强调 `#8C6F3B`，与 `light` 的米纸 `#F3EFE4` + 朱砂 `#A93226` 是**两套不同色相体系**（黄 vs 红）。而产品 `paper` 与 `light` 共用同一组值（L169–171 是同一个选择器组），根本没有独立的纸质值块 | ❌ **需新增或合并**：方案 A（推荐）把 `.paper` 从 `:root, .paper, .light` 组里拆出独立值块；方案 B 直接废弃 demo 纸质主题合并进 `light` |

**推荐对应顺序（一句话总结）**：
`data-theme="0"（浅色）→ light[/paper]`（直连） · `data-theme="3"（黑夜）→ dark`（结构直连 + 强调色重设） · `data-theme="1"（星空）→ 需新增浅色冷调主题，不得并入 galaxy` · `data-theme="2"（纸质）→ 需为 paper 拆出独立值块，或合并进 light`。

**明确指出**：4 个 Demo 主题中只有 **2 个（浅色、黑夜）**能落到产品现有主题；**星空、纸质 2 个没有干净对应**，必须新增主题定义。此外产品 `light` 与 `paper` 目前是同一套值，因此 Demo 的「浅色 / 纸质」二分在产品侧无法表达，这是**产品令牌体系的既有缺口**，不是 Demo 的问题。

---

## 3. 字体族映射

### 3-1 变量 → 产品字体家族

| Demo 变量 | 原字体栈（demo 出处） | 产品 `@font-face` 家族（index.css 出处） | 产品令牌 | 依据 |
| --- | --- | --- | --- | --- |
| `--serif` (L28) | `Georgia,"Songti SC","STSong","SimSun",serif` | `'Noto Serif SC'`（L57–63，思源宋体可变字体 100–900） | `var(--font-writing)`（L287 次选位 / L87 首选项） | 宋体 / 印刷感，用于标题与正文 |
| `--kai` (L29) | `"Kaiti SC","STKaiti","KaiTi",serif` | `'LXGW WenKai'`（L39–45 Regular 400 / L48–54 Medium 500） | `var(--font-writing)`（L287 首选位） | 楷体，产品定位为「最适合中文小说写作」（theme-store L51） |
| `--zhuan` (L30) | `'Lanxi-游龙篆书','Lanxi-山北篆体','Lanxi-小篆','FZXiaoZhuanTi-S13S','STKaiti','KaiTi','SimSun',serif` | **无** | ➕ **需新增 `--font-seal-script`** | 产品 4 个家族（Inter / LXGW WenKai / Noto Serif SC / Noto Sans SC，L19–72）无篆书；`public/fonts/` 也无对应文件。且 demo 自己声明的 `@font-face 'YiShanZhuan'`(L37，源 `fonts/YiShanBeiZhuanTi.ttf`) 并未出现在该栈中 → 该声明为死代码，迁移时不要照抄 |
| `--sans` (L31) | `system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif` | `'Noto Sans SC'`（L66–72）+ `'Inter'`（L19–34，含斜体 L28–34） | `var(--font-sans)`（L85 / L285） | 界面正文；产品通过 `FONT_OPTIONS`(theme-store L26–77) 让用户在 Inter / 思源黑体 / 霞鹜文楷 / 思源宋体 / 系统字体间切换，接口即 `--font-sans`（`applyUiFont` L268–271 会 inline 覆写） |
| `--mono` (L32) | `ui-monospace,"Cascadia Code",Consolas,monospace` | **Fira Code 无字体文件**（L19–72 无该 `@font-face`，`public/fonts/` 亦无） | `var(--font-mono)`（L86 / L286） | 见下方 3-2 |

### 3-2 两条必须先解决的字体现状问题

| 编号 | 问题 | 证据 | 影响与建议 |
| --- | --- | --- | --- |
| F1 | `--font-mono` 首选 `'Fira Code'` 但**没有字体文件也没有 `@font-face`** | index.css L86/L286 声明 `'Fira Code', Consolas, ui-monospace, monospace`；L19–72 只声明 Inter / LXGW WenKai / Noto Serif SC / Noto Sans SC；`public/fonts/` 目录同样只有这 4 个家族 | Demo `--mono` 迁移过去后实际落到 Consolas（Windows）或 ui-monospace，跨平台表现不一致。建议：引入 Fira Code 或把首选改为已内置家族（产品决策，见 §5 Q7） |
| F2 | `--font-writing` **两处定义不一致** | `@theme`(L87)：`'Noto Serif SC'` 优先；`:root`(L287)：`'LXGW WenKai'` 优先 | 写作字体默认到底是谁没有唯一答案。Demo 的 `--serif` / `--kai` 两个变量想要分别对应宋体与楷体，产品却只有**一个** `--font-writing` 槽位 → 需产品决定：新增 `--font-serif` 令牌，还是让用户选项承担区分 |

---

## 4. 冲突与风险清单

| 编号 | 类型 | 冲突点 | 证据（两边原值） | 迁移处理建议 |
| --- | --- | --- | --- | --- |
| **R1** | 同名不同义 | 两边都有 `panel` 语义键，但**层级方向相反** | Demo：`--panel #FAF7EE` 是**比纸更亮**的抬升面（`--paper #F3EFE4` 之下更暗）。产品：`--color-panel #F0EADA` **比 `--color-bg #F7F3E8` 更暗**，是下沉的侧栏面；产品真正的抬升面叫 `--color-raised #FCFAF3` | 建立三档映射并写进迁移脚本：demo `paper→--color-bg`、`panel→--color-raised`、`panel2→新 --color-surface-card-muted`。**禁止**按名字把 `--panel` 写成 `var(--color-panel)`（会导致卡片变暗、层级翻转） |
| **R2** | 档位数量/顺序不匹配 | 文字层 4 档 vs 3 档，且产品的 secondary/muted 明度顺序反直觉 | Demo：`ink #2A261E` > `ink2 #57513F` > `muted #8F8876` > `faint #B7AE99`（严格递减）。产品：`text #2B2A26` > `text-secondary #6E6A5F` > `text-muted #655F55`（**secondary 比 muted 更亮**，L185–186） | 建立显式对照：`ink→text`、`ink2→text-secondary`、`muted→text-muted`、`faint→新增 --color-text-faint`。迁移后必须目视校正第三/第四档（Demo 的 muted `#8F8876` 比产品 muted `#655F55` 亮 30 级，直接换会发生「标注字变黑」） |
| **R3** | 同名不同义（最高危） | 两边都叫 `gold`，但产品浅色主题下 `gold` **已经不是金色** | 代码注释直说：`/* 品牌金色 → 黛青（供残留渐变类取色） */ --color-gold: #54666E;`（L196–197）；只有 `.galaxy` `#C9A76C`(L316) 与 `.dark` `#C9A76C`(L460) 是真金。Demo `--gold #B9A34A` 是真金 | Demo 的金色装饰（进度渐变 L80、卡片悬停描边 L240/L665、烫金线）若直接写 `var(--color-gold)`，浅色主题会变黛青。**必须**在新 UI 的 light/paper 主题里把 `--color-gold` 重设为真金，并把 L196–197 的黛青取色改走独立令牌 |
| **R4** | 同名同义、明度相反 | `jade2`（状态栏底）与产品 `--color-statusbar` 语义一致但明度相反 | Demo 状态栏 `#2B3642`（近黑），产品 light 状态栏 `#FCFAF3`（近白，L220），只有 galaxy `#071220`(L335) / dark `#181818`(L479) 是深色 | 结构上映射到 `var(--color-statusbar)`；视觉上需产品拍板：是让浅色主题也用深色状态栏（改产品），还是 Demo 改成浅色状态栏（改设计）。同类风险还有 `--spine1/2`（书脊渐变 `#313C47→#272F38`）对产品 `--color-activity-bar #F0EADA`（L179） |
| **R5** | 同名不同义 | Demo 的 `--text`（书脊烫印字色）与产品 `--color-text`（全局正文色）名字极近 | Demo：`.v6shelf .book{--text:#eee5d5}`（L352）；产品：`--color-text: #2B2A26`（L184） | 书柜族变量必须**重命名**后迁移（建议 `--color-book-cover-text`）。任何 `var(--text)` → `var(--color-text)` 的批量替换都会把书脊字变黑 |
| **R6** | 同义不同名 | 字体三类（宋/楷/篆）vs 产品两个槽位（sans/writing） | Demo 有 `--serif`/`--kai`/`--zhuan` 三个独立字体变量（L28–30）；产品只有 `--font-sans`/`--font-writing`/`--font-mono`（L85–87） | 需产品决策：是否新增 `--font-serif-print`（或直接开放 `--font-seal-script`），否则 Demo 的篆书装饰与宋体标题只能二选一落到 `--font-writing` |
| **R7** | 硬编码色值不随主题切换（Demo 侧真实缺陷） | Demo 有大量**字面量**颜色不引用变量，切到黑夜主题后仍是浅色系 | 统计：`rgba(169,50,38,…)` **35 处**、`rgba(78,122,84,…)` 13 处、`rgba(70,50,30,…)` 15 处、`rgba(40,30,10x,…)` 12 处、`rgba(185,163,74,…)` 8 处、`rgba(250,247,238,…)` 8 处、`rgba(192,138,45,…)` 5 处、`rgba(192,57,43,…)` 5 处、`#F3EFE4` 3 处、`#A93226` 5 处 | 迁移时逐处替换为 `rgba(var(--color-accent-rgb), .x)` 或 `color-mix(in srgb, var(--color-accent) 12%, transparent)`（产品已在 L1139–1145 使用 `color-mix`，风格可对齐）。**不做这一步，新 UI 的暗色主题会出现大面积浅色残影** |
| **R8** | 产品令牌内部不一致 | 同一种「顶栏高」在产品里有 2 个互相冲突的令牌 | `@layer base --height-titlebar: 40px`（L257） vs `@theme --spacing-titlebar: 36px`（L96）。Demo 第三个值 `--h-title: 56px`（L33） | 迁移前先收敛产品侧（建议保留 `--height-titlebar` 为单一来源，`@theme` 用 `var()` 引用），再决定采纳 40px 还是 56px（见 §5 Q5） |
| **R9** | 产品机制差异（迁移后自动修复） | Demo 的 rgb 三元组**不随主题更新** | `THEME_COLORS`（L2502–2505）每项都**没有** rgb 字段，而 `setThemeVars()` 只遍历数组键（L2511）；因此 `--seal-rgb`/`--green-rgb`/`--red-rgb`/`--warn-rgb` 永远停留在浅色值。产品则在**每个主题**都重设 `--color-accent-rgb`（L194/L313/L458） | 迁移到产品 `--color-accent-rgb` 后此缺陷自然消失；其他 `-rgb` 需按产品约定新增并**逐主题**定义（不能只在 `:root` 定义） |
| **R10** | 设计决策未收敛（Demo 内部矛盾） | 图谱层级尺寸有两套互相覆盖的 `!important` | 第一套（L1150–1170）：main 82 / important 66 / normal 54 / satellite 36 / far 26。第二套（L1179–1184）：main **104** / important **82** / normal **50** / satellite **30** / far **15**，全部 `!important`，覆盖前者 | 提升为 `--graph-node-size` 等令牌前，必须先定稿一套层级尺寸（否则令牌化会把矛盾固化进产品体系）。另：L1126–1141 还有第三套 54/76 的 `!important` 覆盖 |
| **R11** | 主题机制架构差异 | Demo 用 JS 内联注入主题，产品用 CSS 类 + `data-*` 组合 | Demo：`applyTheme()` 写 `documentElement.style.setProperty`（L2510–2528）。产品：`.light/.paper/.galaxy/.dark` 类块（L168/L291/L440）+ `.app-skin-root[data-theme='…'][data-skin='classic']`（L513/L518）+ `.app-skin-root[data-skin-readability='high-contrast']`（L1138–1258） | 迁移**必须**把 `THEME_COLORS` 转写成 CSS 主题块，保留命名令牌，让图片皮肤与可读性覆盖层（`--skin-*`）能接管。若保留 JS 注入，`data-skin-readability='high-contrast'` 将在部分属性上失效（内联样式优先级高于类选择器） |
| **R12** | 圆角体系冲突 | Demo 圆角普遍比产品大一档到两档 | Demo 硬编码：`7px`(L83/L121)、`8px`、`9px`、`12px`(L248/L662)、`14px`(L739)、`18px`(L398)。产品：`--radius-sm/md: 4px`、`lg: 6px`、`xl: 8px`、`2xl: 12px`（L266–270，注释「纸感收平」） | 直接套产品令牌会让新 UI 明显「变方」。需产品决定是推翻「纸感收平」策略，还是把 Demo 圆角压到 `--radius-*` 阶梯（见 §5 Q6） |
| **R13** | 阴影色温不匹配 | Demo 阴影带暖棕，产品为中性墨色 | Demo `--shadow` 与多处阴影用 `rgba(90,70,30,…)`/`rgba(40,30,15,…)`/`rgba(70,50,30,…)`；产品 `--shadow-*` 全部是 `rgba(43,42,38,…)`（L273–277），galaxy 是纯黑（L362–366） | 若保留 Demo 的暖调阴影，需新增暖调阴影令牌族；若归并到产品 `--shadow-*`，需接受卡片观感变化。另有一次性阴影（如 L401 `0 34px 96px -24px`）未令牌化，建议统一为 `--shadow-modal` |
| **R14** | 缺失的可读性对照 | Demo 无 `data-skin` / `data-skin-readability` 任何对应物 | Demo 全文只有 `html[data-theme="3"]`(L819–820) 一个主题属性选择器；产品有 3 个 skin（classic/anime/custom）× 4 主题 × 可读性层的覆盖矩阵 | 新 UI 是否继续支持图片皮肤与高对比可读性层需明确（见 §5 Q9）。若支持，Demo 的所有表面色都必须走令牌，不能再出现 `rgba(250,247,238,.86)` 这类写死半透明面（8 处） |

---

## 5. 待确认问题（需产品负责人拍板）

| 编号 | 问题 | 为什么代码里定不了 | 建议选项 |
| --- | --- | --- | --- |
| Q1 | Demo 的「星空」主题（浅色冷调 `#E8EDF2`/`#24313C`）与产品 `galaxy`（深色 `#0A1628`）明度相反，怎么处理？ | 二者只有名字和「冰蓝强调色」相通，无法从代码推断产品意图 | A. 新增浅色冷调主题（建议名 `mist`/`azure`）；B. 把星空改造为深色并入 galaxy，接受 Demo 视觉推翻 |
| Q2 | Demo 的「纸质」主题（暖黄 `#EFE5D0` + 棕金 `#8C6F3B`）是否值得为 `.paper` 拆出独立值块？ | 产品 light/paper 当前共用同一选择器组（L169–171），是既定设计还是历史遗留无法判断 | A. 拆分 `.paper` 独立值块（保留 4 主题）；B. 废弃纸质主题合并进 light（变 3 主题） |
| Q3 | 是否允许新增 Demo 专属语义令牌族？ | 产品现命名规范是 `--color-*` 语义名，但新增「反相面 / 书脊导轨 / 书封 / 主题预览」四族会扩大令牌表 | 建议按本表 §1 的 `--color-surface-inverse`、`--color-rail-gradient-*`、`--color-book-cover-*`、`--graph-*` 命名落地，需确认是否接受 |
| Q4 | 顶栏高度最终取多少：Demo 56px / 产品 `--height-titlebar` 40px / `@theme --spacing-titlebar` 36px？ | 产品自身两个令牌已冲突（L96 vs L257），无法裁决 | 先修产品内部一致性，再决定采纳值 |
| Q5 | 「纸感收平」圆角策略（4–12px）是否被新 UI（7–18px）推翻？ | 这是设计语言层面的取舍，代码只能显示两者不同 | A. 保持产品策略，Demo 圆角降档；B. 更新产品 radius 阶梯 |
| Q6 | 字号基准：Demo 正文 13px（L40）vs 产品 `html{font-size:14px}`（L530）+ 14px 基准缩放（theme-store `BASE_FONT_SIZE`） | 缩放体系绑定 14px 基准，改基准会影响用户缩放设置 | 建议保留产品 14px 基准，把 Demo 的 px 值按比例换算 |
| Q7 | `--font-mono` 的 `'Fira Code'` 是引入字体文件还是改用已内置家族？ | `public/fonts/` 无该文件（L19–72 也无 `@font-face`），属既有缺口 | A. 引入 Fira Code（需授权）；B. 改为 Consolas/ui-monospace 或已内置家族 |
| Q8 | 篆书字体（Demo 用 `Lanxi-*` 商业字族）是否有可用授权？ | 产品所有内置字体均为 OFL（`public/fonts/licenses/` 4 份 OFL），篆书字族授权不明 | 需确认授权后再决定是否新增 `--font-seal-script`；无授权则降级为「不用篆书」 |
| Q9 | 新 UI 是否继续支持 `data-skin`（classic/anime/custom）与 `data-skin-readability` 高对比层？ | Demo 完全没有对应实现，无法从代码判断 | A. 继续支持 → 所有表面色必须令牌化；B. 新 UI 移除图片皮肤 |
| Q10 | 图谱五级层级尺寸（26/36/54/66/82 还是 15/30/50/82/104）以哪套为准？ | Demo 内部三套 `!important` 互相覆盖（L1126–1184），代码本身无唯一答案 | 需设计定稿一套，再提升为 `--graph-node-*` 令牌 |
| Q11 | Demo 主题色由 JS 内联注入（L2510–2531），迁移时是否改为 CSS 主题块？ | 关乎图片皮肤与可读性层能否生效（R11），属架构选择 | 建议改 CSS 主题块；需确认是否允许改动主题注入实现 |
| Q12 | Demo 中 `--seal-rgb` 等 rgb 三元组不随主题更新（R9），迁移后是否补全每主题的 `-rgb` 令牌？ | 产品目前只有 `--color-accent-rgb`，其余 `-rgb` 缺失属产品缺口 | 建议按 `--color-{success,warning,error}-rgb` 补齐并逐主题定义 |

---

## 附录 A：迁移落地顺序建议（可直接排期）

| 阶段 | 事项 | 依据 |
| --- | --- | --- |
| 0 | 先收敛产品侧既有矛盾：`--height-titlebar` vs `--spacing-titlebar`（R8）、`--font-writing` 双定义（F2）、`--font-mono` 无文件（F1） | §3-2、§4 R8 |
| 1 | 建立主题值块：新增星空（浅冷）主题、拆分 `.paper` 独立值块；将 Demo `THEME_COLORS` 转写为 CSS 主题块（R11） | §2-2、§4 R11 |
| 2 | 落地 26 个新增令牌，并按「名字 → 令牌」建立映射脚本（尤其 `panel→--color-raised`、`gold` 覆盖、`text` 重命名） | §1-4、§4 R1/R3/R5 |
| 3 | 硬编码色值清剿：把 35 处 `rgba(169,50,38,…)` 等替换为 `rgba(var(--*-rgb),α)` / `color-mix()` | §4 R7 |
| 4 | 尺寸与圆角对齐（titlebar/toolbar/left-bar/radius 阶梯） | §1-2、§4 R12 |
| 5 | 图谱与书柜模块单独评审层级尺寸与书封色族（R10、Q3、Q10） | §1-3 |
