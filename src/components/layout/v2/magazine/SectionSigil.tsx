import type { ReactNode } from 'react'
import type { SectionKey } from '../../../../shared/section-opener'

/**
 * 栏目徽记（Section Sigil）—— 七个自绘 SVG，一个栏目一个。
 *
 * ── 为什么自己画 ────────────────────────────────────────────────────────────
 * 先生 2026-09-16：
 *   「都不敢自己做点 SVG 效果。」
 * 对。此前「图标」一律是 Lucide 的现成线条，把线宽调到 1.7 就当作换过了。
 * 这里七个徽记全部手绘，共用一套几何语言：
 *
 *   · 只用**方点**与**直线** —— 与全站的方形印签、方形色标、直角控件同源
 *   · 每个 26×26，笔画 1，方点 5–6px，在 14px 与 26px 两种尺寸下都立得住
 *   · 取色一律 `var(--mag-sec)`（当前栏目色），所以徽记与它所在的版面同色
 *
 * 语义（照栏目本身，不照图标库）：
 *   书架 = 三本书脊 · 目录 = 条目的方点与引线 · 人物 = 三点成网
 *   设定 = 同心方框（世界与其规则） · 伏笔 = 分叉的线（埋下的与收回的）
 *   蓝图 = 方格骨架 · 知识库 = 并排的两本书
 */

/** 徽记的设计基准边长 —— 图形坐标都写在这个 26 视框里，缩放靠 size 参数。 */
const SIZE = 26

export interface SectionSigilProps {
  section: SectionKey | null
  /**
   * 边长（px）。默认 26 —— 页面铭牌里的标准尺寸。
   * 2026-09-17 第十五轮新增：侧栏空态（「请先打开项目」上方那个图标）要 36px，
   * 需要比铭牌大一档，而图形坐标不动（viewBox 恒为 26）。
   */
  size?: number
}

export default function SectionSigil({ section, size = SIZE }: SectionSigilProps) {
  return (
    <svg
      className="mag-sigil"
      width={size}
      height={size}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden="true"
    >
      {shapes(section)}
    </svg>
  )
}

function shapes(section: SectionKey | null): ReactNode {
  switch (section) {
    /* 书架：三本书脊，高矮不一，站在同一条地线上 */
    case 'home':
      return (
        <>
          <rect className="mp-sigil-node" x="3" y="4" width="5" height="18" />
          <rect className="mp-sigil-node is-lead" x="10.5" y="8" width="5" height="14" />
          <rect className="mp-sigil-node" x="18" y="3" width="5" height="19" />
        </>
      )

    /* 目录：三个条目的方点 + 引线（条目就是「一条一条」） */
    case 'project':
      return (
        <>
          <rect className="mp-sigil-node" x="2" y="4.5" width="5" height="5" />
          <rect className="mp-sigil-node is-lead" x="2" y="10.5" width="5" height="5" />
          <rect className="mp-sigil-node" x="2" y="16.5" width="5" height="5" />
          <line className="mp-sigil-link" x1="9.5" y1="7" x2="24" y2="7" />
          <line className="mp-sigil-link" x1="9.5" y1="13" x2="24" y2="13" />
          <line className="mp-sigil-link" x1="9.5" y1="19" x2="24" y2="19" />
        </>
      )

    /* 人物：三点成网 —— 人，与人与人 */
    case 'characters':
    default:
      return (
        <>
          <line className="mp-sigil-link" x1="13" y1="6" x2="5.5" y2="19.5" />
          <line className="mp-sigil-link" x1="13" y1="6" x2="20.5" y2="19.5" />
          <line className="mp-sigil-link" x1="5.5" y1="19.5" x2="20.5" y2="19.5" />
          <rect className="mp-sigil-node is-lead" x="10" y="3" width="6" height="6" />
          <rect className="mp-sigil-node" x="2.5" y="16.5" width="6" height="6" />
          <rect className="mp-sigil-node" x="17.5" y="16.5" width="6" height="6" />
        </>
      )

    /* 设定：同心方框 —— 世界，以及世界的规则 */
    case 'world':
      return (
        <>
          <rect className="mp-sigil-frame" x="2.5" y="2.5" width="21" height="21" />
          <rect className="mp-sigil-node is-lead" x="9" y="9" width="8" height="8" />
          <line className="mp-sigil-link" x1="13" y1="2.5" x2="13" y2="6" />
          <line className="mp-sigil-link" x1="13" y1="20" x2="13" y2="23.5" />
        </>
      )

    /* 伏笔：一条主线分叉到两个端点 —— 埋下的与收回的 */
    case 'plot-tree':
      return (
        <>
          <line className="mp-sigil-link" x1="13" y1="23" x2="13" y2="11" />
          <line className="mp-sigil-link" x1="13" y1="11" x2="5" y2="4" />
          <line className="mp-sigil-link" x1="13" y1="11" x2="21" y2="4" />
          <rect className="mp-sigil-node is-lead" x="10" y="17" width="6" height="6" />
          <rect className="mp-sigil-node" x="2" y="2" width="5" height="5" />
          <rect className="mp-sigil-node" x="19" y="2" width="5" height="5" />
        </>
      )

    /* 蓝图：方格骨架 —— 落笔之前的结构 */
    case 'blueprint':
      return (
        <>
          <rect className="mp-sigil-frame" x="2.5" y="2.5" width="21" height="21" />
          <line className="mp-sigil-link" x1="2.5" y1="13" x2="23.5" y2="13" />
          <line className="mp-sigil-link" x1="13" y1="2.5" x2="13" y2="23.5" />
          <rect className="mp-sigil-node is-lead" x="6" y="6" width="5" height="5" />
        </>
      )

    /* 知识库：并排的两本书 */
    case 'knowledge':
      return (
        <>
          <rect className="mp-sigil-frame" x="2.5" y="5" width="9.5" height="16" />
          <rect className="mp-sigil-frame" x="14" y="5" width="9.5" height="16" />
          <line className="mp-sigil-link" x1="7.25" y1="9" x2="7.25" y2="17" />
          <line className="mp-sigil-link" x1="18.75" y1="9" x2="18.75" y2="17" />
        </>
      )
  }
}
