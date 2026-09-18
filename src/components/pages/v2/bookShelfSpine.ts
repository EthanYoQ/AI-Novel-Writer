/**
 * 书脊的类型与尺寸换算 —— 从 BookShelf.tsx 拆出来的纯模块。
 *
 * 为什么要拆：react-refresh 只有在一个文件「只导出组件」时才能做组件级热替换；
 * BookShelf.tsx 原本还导出 spineDimensions 这个纯函数，于是整页刷新。
 * 把它（连同它用到的两个类型）移到这里，组件文件的 HMR 才不会被拖累。
 */

/** 书脊纹理，对应 shell.css 里的 .texture-* 规则。 */
export type BookTexture =
  | 'texture-cloth'
  | 'texture-leather'
  | 'texture-lacquer'
  | 'texture-paper'
  | 'texture-old'
  | 'texture-metal'

export interface ShelfBook {
  id: string
  /** 书名，显示在书脊竖排文字上。 */
  title: string
  /** 作者名；产品没有作者概念时留空即可，留空则不渲染。 */
  author?: string
  /** 状态标签（写作中 / 蓝图 / 草稿 / 已定稿…），同时决定排序。 */
  status?: string
  /** 章节数与每章字数只用于换算书脊厚度，缺失时按默认体量。 */
  chapters?: number
  wordsPerChapter?: number
  cover?: string
  edge?: string
  text?: string
  foil?: string
  texture?: BookTexture
}

import { isMagazine, type UiVersion } from '../../../stores/ui-version-store'

/**
 * 书脊书名的竖排排布 —— 2026-09-17 第十五轮新增。
 *
 * 先生：「书籍现在有些名字特别长的，书架上书脊会显示不全或者特别难看，
 * 帮我记住，这种长名字的书，就可以把书变宽一点，或者书名字小点，
 * 让他名字能显示全且美观。」
 *
 * 查证（量 dist 的 computed 值 + Range 的实际绘制盒）：书名是竖排
 * （`writing-mode: vertical-rl`），一列**放得下 12 个字**（22px 上边距 +
 * 20px 下边距之后可用 161px，每字 12px + 0.5px 字距 = 12.5px）。
 * 第 13 个字起浏览器会自动折出**第二列**，而书脊只有 25–31px 宽 ——
 * 一列就占 17px，第二列直接被 `overflow: hidden` 削掉一半：
 * 量出来两列的左右缘各自越界 2.5px，这就是「显示不全」。
 *
 * 于是这里按书名长度分三档，**先缩字号、再动书宽**（顺序是先生给的：
 * 「把书变宽一点，或者书名字小点」）：
 *   ① ≤1 列（12–13 字）→ 原样：12px 单列，书宽不动
 *   ② 单列放不下但 11px 能放（14 字）→ 只降字号，**不加宽**（宁可字小一点，也不要折列）
 *   ③ 15–28 字 → 11px **两列**，书脊加宽到恰好容下两列（约 38px）
 *   ④ 更长的（>28 字）→ 10px 三列，书宽再宽一档
 * 三档都以「竖排的实际度量」为准，不靠眼估。
 */
const TITLE_TOP = 22
const TITLE_BOTTOM = 20
/** `.title` 上的 letter-spacing，竖排时它加在**字前进方向**上。 */
const TITLE_TRACK = 0.5
/** 书脊里给多列竖排留的左右边距（3px 金线 + 1px 余量）。 */
const TITLE_SIDE = 8

/** 某个字号下：一列能放几个字、这本书要折几列。 */
function titleColumns(chars: number, avail: number, px: number) {
  const perColumn = Math.max(1, Math.floor(avail / (px + TITLE_TRACK)))
  return { perColumn, columns: Math.ceil(chars / perColumn) }
}

/** 多列竖排需要的书脊宽度：列步进 × (列数 - 1) + 列宽 + 左右边距。 */
function titleSpan(px: number, columns: number) {
  const step = px * 1.25
  const columnWidth = px + 5
  return Math.ceil((columns - 1) * step + columnWidth + TITLE_SIDE)
}

function planSpineTitle(title: string, h: number) {
  const chars = Math.max(1, [...title].length)
  const avail = Math.max(40, h - TITLE_TOP - TITLE_BOTTOM)

  // ① 12px 单列放得下 —— 先生定的标准字号，短名一律用它
  if (titleColumns(chars, avail, 12).columns === 1) return { px: 12, columns: 1, span: 0 }

  // ② 11px：单列放得下就仍然单列（只降字号，不动书宽）
  const at11 = titleColumns(chars, avail, 11)
  if (at11.columns === 1) return { px: 11, columns: 1, span: 0 }
  if (at11.columns === 2) return { px: 11, columns: 2, span: titleSpan(11, 2) }

  // ③ 极长书名：10px、最多三列；书名宽到这一步已属罕见
  const columns = Math.min(3, titleColumns(chars, avail, 10).columns)
  return { px: 10, columns, span: titleSpan(10, columns) }
}

/**
 * 书脊尺寸换算 —— 与 demo 的 mountShelf6().dims() 同一套算法：
 * 总字数 → 页数 → 书脊厚度（毫米）→ 像素，高度随体量轻微变化。
 *
 * 2026-09-16 **按界面版本分家**（先生定调：版本各自分家，美化不得互相影响）：
 *   · v2「墨纸书斋」：demo 原值（宽 10–30px、高 208+、厚 6+），逐像素不变
 *   · v3「时尚杂志」：整体刻度收到约六成 —— 先生说的「书又宽又厚」，
 *     一排书因此站得更薄、更挺、间隙更利落，接近时装刊的版面节奏
 * 厚度语义（字数越多书越厚）两个版本都保留，只是刻度不同。
 */
export function spineDimensions(book: ShelfBook, uiVersion: UiVersion = 'v2') {
  const total = Math.max(1, (book.chapters ?? 80) * (book.wordsPerChapter ?? 2500))
  const pages = Math.max(48, Math.round(total / 500))
  const spineMm = pages * 0.061 + 2.2

  /* ── v1 / v2：demo 原样 ── */
  if (!isMagazine(uiVersion)) {
    return {
      h: 208 + Math.min(18, Math.round(Math.sqrt(pages) * 0.55)),
      w: Math.max(10, Math.min(30, Math.round(spineMm * 0.92))),
      depth: 6 + Math.min(5, Math.round(spineMm / 8)),
      tenThousandWords: (total / 10000).toFixed(1),
      /* v1/v2 的书名不走这套竖排自适应（v2 的书脊足够宽），恒为原值。 */
      titlePx: 12,
      titleColumns: 1,
    }
  }

  /* ── v3：书脊 ──
   * 先生四轮回合的要求都记在这儿（每一轮都只动一处，别再加戏）：
   *   · 「宽度起码在现在的基础上要减少一半才行，现在还是一个个大胖子特别难看」
   *   · 「现在书不胖了，但是变得太瘦！宽度放大到现在的一倍。」
   *   · 「书籍感觉还需要整体大 3px 左右」← 基准宽度的定稿
   *   · 「名字特别长的书……可以把书变宽一点，或者书名字小点」（第十五轮，
   *     → `planSpineTitle()`：**只有长名字的书**才加宽，短名一律 29–35px 不动）
   *   · 「书籍再高 3px、胖 4px，现在太袖珍」（2026-09-17，两轮）：高 194→197、
   *     基准宽 +4，夹在 **29–35px**
   * 于是：v2 同族的 `spineMm × 0.9` 之后再 +7px，夹在 **29–35px**；
   * 长书名在此基础上按需要的列数加宽（38px / 48px 两档）。
   * 注：先前几轮把 94px 的「大胖子」误判成尺寸问题 —— 真凶是 v2 基座那条裸
   * `.spine { width: var(--w-spine) }` 被 v3 的 `--w-spine: 94px` 顶起来，
   * 外加一条污染了选择器的注释残骸（见 HANDOFF 3.19）。尺寸那时根本没生效。 */
  const h = 197 + Math.min(14, Math.round(Math.sqrt(pages) * 0.46))
  const baseW = Math.max(29, Math.min(35, Math.round(spineMm * 0.9) + 7))
  const title = planSpineTitle(book.title ?? '', h)
  return {
    h,
    w: Math.max(baseW, title.span),
    depth: 3 + Math.min(2, Math.round(spineMm / 26)),
    tenThousandWords: (total / 10000).toFixed(1),
    titlePx: title.px,
    titleColumns: title.columns,
  }
}
