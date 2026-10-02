# V2「墨纸书斋」结构基线 · 冻结于 2026-09-16

> 目的：把 V2 的地基固化下来。**此文件冻结之后，V2 视为只读基线**——
> 后续所有「大改 V3」的动作，只要不违反第四节的三条铁律，就绝对不会碰到 V2。
> 这份文档是给未来动手改 V3 的人（包括我自己）看的：先读它，再动手。

---

## 一、属性契约（谁在哪儿挂什么）

`App.tsx` 的 `AppSkinRoot` 把三个属性**同时挂在两处**：`<html>` 与 `<div class="app-skin-root">`
（后者由 `App.tsx` 的 `useEffect` 同步到 `<html>`，是为了让 Radix Portal 出去的对话框/菜单也吃到皮肤）。

| 属性 | `<html>` | `<div class="app-skin-root">` | V1 | V2 | V3 |
|---|---|---|---|---|---|
| `data-ui` | ✅ | ✅ | 无 | `v2` | `v2` |
| `data-v2-theme` | ✅ | ✅ | 无 | `0`–`3` | `0`–`3` |
| `data-mag` | ✅ | ✅ | 无 | **无** | `1` |

**关键事实：V3 复用 V2 的 `data-ui='v2'` 基座，靠 `data-mag` 这一层做开关。**
`data-mag` 不存在时，mag 层的每一条规则都不匹配 —— 这就是 V2/V1 的天然免疫。

---

## 二、样式加载顺序（顺序即层叠意图）

```
1. src/index.css                        Tailwind + @font-face + app-skin 基础（50KB）
2. src/styles/redesign/v2-index.css     V2 基座：18 个文件、约 20 万字节
3. src/styles/magazine/mag-index.css    V3 覆盖层：7 个文件
                                        （tokens → fonts → palette → type → shell
                                          → controls → surfaces → pages）
```

同为无层样式时**源码在后者胜**，因此 mag 层天然压过 v2 基座。

---

## 三、V2 的外观锚点（这些值就是 V2 本身，禁止改动）

### 3.1 四套主题（`v2-themes.css`，位于 `@layer components` 内）

| 主题 | `--paper2` 应用底 | `--paper` | `--panel` | `--line` |
|---|---|---|---|---|
| 0 浅色 | **`#ECE5D3`** 米黄 | `#F3EFE4` | `#FAF7EE` | `#E0D8C2` |
| 1 星汉 | `#050B14` 深空蓝 | `#07101C` | … | … |
| 2 纸质 | `#E3D5B8` | … | … | … |
| 3 黑夜 | `#1F2326` | … | … | … |

### 3.2 首帧 body 底色（`index.html` 内联脚本，硬编码）

```js
CLASSIC_BG = { light: '#F7F3E8', galaxy: '#050B14', paper: '#F7F3E8', dark: '#1E1E1E' }
```

> ⚠️ 注意 `#F7F3E8` 与 3.1 的 `#ECE5D3` **并不相等** —— 首帧色与稳定色本来就是两回事。
> **不要试图"统一"它们**，那会改变 V2 的首帧观感。

### 3.3 书架

- **书封配色**：`BookShelf.tsx` 的 `CLASSIC_PALETTE`（6 套传统精装：藏青/棕皮/墨绿/灰蓝/紫/蓝灰 + 烫金 foil）
- **书脊尺寸**：`spineDimensions(book, 'v2')` → 宽 10–30px、高 208+、厚 6+
- **书架首页背景**：腊梅水墨（`brand/plum-blossom-1920.jpg`）+ 星空主题走 `brand/xingkong.png`

### 3.4 其他

- **印章 LOGO**：`seal-44.png`（顶栏）/ `seal-100.png`（首页 Hero）
- **界面字体**：Georgia + 宋体系（`--serif`），跟随「设置 → 界面字体」

---

## 四、V3 改动的三条铁律

> 这三条是从 2026-09-16 那场「怎么改都还是米黄」的排查里换来的，逐条都有血。

### 铁律一：任何 CSS 规则必须带 `[data-mag]`

```css
/* ✅ 对 */
html[data-ui='v2'][data-mag] .some-class { … }

/* ❌ 错：会渗到 V2 */
html[data-ui='v2'] .some-class { … }
```

### 铁律二：「定义令牌」的规则**不得带 `html` 前缀**；「子元素规则」必须带

```css
/* ✅ 令牌定义：不带 html，才能同时覆盖 <html> 与 .app-skin-root */
[data-ui='v2'][data-mag][data-v2-theme='0'] { --paper2: #FBFBFC; }

/* ✅ 子元素规则：带 html，特异性更高（子元素在 .app-skin-root 内也能被命中） */
html[data-ui='v2'][data-mag] .pagehead h1 { … }
```

**为什么**：`v2-themes.css` 的色板选择器 `[data-ui='v2'][data-v2-theme='0']` **不带 `html` 前缀**，
所以它同时命中 `<html>` 和 `.app-skin-root`；若 mag 层只写 `html[...]`，就只命中 `<html>`，
而真正承载界面的 `.app-skin-root` 会掉回 V2 的老值 —— 「改什么都还是米黄」正是此因。

### 铁律三：任何 TS/TSX 改动必须走 `isMagazine(uiVersion)` 分支，V2 走原路径

```ts
// ✅ 两套并列，各取所需
const paletteSet = isMagazine(uiVersion) ? MAGAZINE_PALETTE : CLASSIC_PALETTE
const dim = spineDimensions(book, uiVersion)          // v2 走原值
const uiVersion 判断后再决定要不要动内联样式
```

**反例**：无条件执行 `document.body.style.backgroundColor = 'var(--color-bg)'` ——
看似无害，但 V2 的首帧色 `#F7F3E8` 与 V2 的 `--paper2 #ECE5D3` 不同，V2 的底色就被换掉了。

---

## 五、已知陷阱（排查手册）

| 症状 | 真因 | 解法 |
|---|---|---|
| v3 里改什么都是旧色 | `index.html` 的首帧硬编码底色写在 **`document.body.style`**（内联样式优先级高于一切样式表） | 在 v3 分支里把它改写成 `var(--color-bg)` 交班给 CSS |
| mag 层令牌不生效 | 令牌定义写了 `html` 前缀，只命中 `<html>`，没命中 `.app-skin-root` | 去掉 `html` 前缀（铁律二） |
| 新规则明明写了却不生效 | 去掉 `html` 前缀后特异性从 4 掉到 3，输给原有规则 | 子元素规则补回 `html` 前缀 |
| 对话框里的样式压不过 | Radix Portal 到 `body`，复合令牌在该子树取值不稳 | 用简单令牌；必要时 `!important` 定音 |
| 英文界面导航栏撑爆 | `text-orientation: upright` 强迫拉丁字母直立 | 改 `mixed`（西文旋转 90° 横躺） |

---

## 六、验证 V3 未污染 V2 的方法（三件套）

```powershell
# ① 构建
node node_modules\vite\bin\vite.js build

# ② 类型检查
node node_modules\typescript\bin\tsc --noEmit

# ③ Electron 实跑 dist 探测（脚手架：_probe.mjs）
#    它会输出：令牌值、暖色背景元素列表（v3 下必须为空）、
#    字体加载实况、书脊竖排参数、设置面板结构
node_modules\.pnpm\electron@41.10.7\node_modules\electron\dist\electron.exe _probe.mjs "<项目根>"
```

**判据**：v3 下「暖色背景元素」列表必须为空；令牌 `--paper2` = `#FBFBFC`；
v2 下（不设 `ai-novel-writer-ui-version`）`--paper2` = `#ECE5D3`。

---

## 七、V2 冻结声明

自本文件建立之日起：

- `src/styles/redesign/**` —— **只读**，不再改动
- `src/index.css` —— **只读**（新增 v3 字体可放在 `public/fonts/v3/` 与 mag 层）
- `index.html` —— **只读**（其脚本已按界面版本分支；如需扩展只许新增分支，不许改动 `CLASSIC_BG`）
- 业务组件中凡是 V2 也走的路径 —— **只读**；要改就加 `isMagazine(uiVersion)` 分支

V2 的外观锚点见第三节，逐条比对即可确认未被触碰。
