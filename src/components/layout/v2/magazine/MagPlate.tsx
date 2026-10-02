import type { ReactNode } from 'react'
import { SECTIONS, type SectionKey } from '../../../../shared/section-opener'
import SectionSigil from './SectionSigil'

/**
 * 栏目铭牌（Mag Plate）—— v3「时尚杂志」的**通用页面版式**
 *
 * ── 它解决的问题 ────────────────────────────────────────────────────────────
 * 先生 2026-09-16：
 *   「其他板块不也还是和之前差不多吗？」
 *   「连 CAST · 人物档案 / 布兰·史塔克 / 主角 · 最近更新：第 2 章
 *     这种标头都还是一直在沿用我们之前的设计风格和思路。」
 *
 * 旧的 `.pagehead` 骨架是**三行文字**（小字眉标 → 大字标题 → 小字说明 + 右侧按钮）。
 * 那是「标题行」的思路，换字体换字号都改不掉骨架。铭牌换的是**思路**：
 *
 *   ① **竖排栏目名**（SHELF / CONTENTS / CAST …）钉在左缘 —— 一眼知道这是哪一栏
 *   ② **栏目徽记**：七栏目各一个手绘 SVG（见 SectionSigil），不是图标库
 *   ③ **数据图形槽 `figure`**：各页把自己最关键的一件事**画出来** ——
 *      配置给完成度条、设定集给词条刻度、伏笔给待收线、知识库给文献量
 *   ④ **期刊化读数 `metric`**：右侧一枚大数字（章号 / 条目数），像刊物的页码
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 * 页面级页头一律走 `PagePlate`（它在 v2 下自动换成旧的 `PageHead`）。
 * 一个页面只需要想清楚一件事：**这一页最该被看见的那个数字，画成什么形状。**
 */
export interface MagPlateMetric {
  /** 大数字下方的竖排小标签 */
  label: string
  value: string
  unit?: string
}

export interface MagPlateProps {
  /** 栏目键：决定徽记形状与竖排英文名；工具类页面传 null（徽记回落到「人物」的网） */
  section: SectionKey | null
  /** 眉标：中英混排，如 `SETTING · 设定集` */
  kicker: string
  /** 大标题 */
  title: string
  /** 定位句（原来叫 description）—— 铭牌里它是标题下那一行衬线小字 */
  lede?: ReactNode
  /** 数据图形：各页自绘的 SVG */
  figure?: ReactNode
  /** 图形旁边/下方的事实读数（小字，可含强调） */
  facts?: ReactNode
  /** 右侧期刊化大数字 */
  metric?: MagPlateMetric
  /** 操作组 */
  actions?: ReactNode
  /** 眉标与标题之间的附加内容（如状态徽标） */
  children?: ReactNode
}

export default function MagPlate({
  section,
  kicker,
  title,
  lede,
  figure,
  facts,
  metric,
  actions,
  children,
}: MagPlateProps) {
  const spine = section ? SECTIONS[section].en.toUpperCase() : ''

  return (
    <div className="mag-plate">
      {/* 竖排栏目名：与书脊上的栏目名同一套排法 */}
      {spine && <span className="mp-spine">{spine}</span>}

      <div className="mp-main">
        <div className="mp-row">
          <span className="mp-sigil">
            <SectionSigil section={section} />
          </span>

          <div className="mp-titles">
            <div className="mp-kicker">{kicker}</div>
            <h1 className="mp-name">{title}</h1>
            {children}
          </div>
        </div>

        {lede && <p className="mp-lede">{lede}</p>}

        {(figure || facts) && (
          <div className="mp-data">
            {figure && <figure className="mp-net">{figure}</figure>}
            {facts && <div className="mp-facts-block">{facts}</div>}
          </div>
        )}
      </div>

      {/*
        「期刊化读数」与「操作组」合成右侧一列（2026-09-17 三改）。

        先生拿着标注图说：「装饰的 | 人物 7 右边移动，按钮右移动」——
        原先读数挂在标题行末尾、按钮挂在整块铭牌末尾，两者一前一后错开，
        看着是两处零碎。现在它们收在同一个右侧列里，一起贴住版心右缘。
      */}
      {(metric || actions) && (
        <div className="mp-aside">
          {metric && (
            <div className="mp-chapter">
              <span className="mp-chapter-label">{metric.label}</span>
              <span className="mp-chapter-no">{metric.value}</span>
              {metric.unit && <span className="mp-chapter-unit">{metric.unit}</span>}
            </div>
          )}
          {actions && <div className="mp-actions">{actions}</div>}
        </div>
      )}
    </div>
  )
}
