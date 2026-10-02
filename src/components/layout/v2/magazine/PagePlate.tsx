import type { ReactNode } from 'react'
import PageHead from '../../../ui/PageHead'
import MagPlate, { type MagPlateMetric } from './MagPlate'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../../../stores/ui-version-store'
import type { SectionKey } from '../../../../shared/section-opener'

/**
 * 页面铭牌（Page Plate）—— 页面级页头的**总入口**，分家在这里发生。
 *
 * ── 为什么要有这一层壳 ──────────────────────────────────────────────────────
 * 全站约 12 处页面级页头此前都直接挂 `PageHead`（三行文字的老版式）。
 * 要一页一页换成铭牌，就得一页一页改结构 —— 那样太慢，而且每页都会长得不一样。
 *
 * 这一层壳把「分家」收进一个文件：
 *   · v2「墨纸书斋」→ 原样渲染旧的 `PageHead`（**逐像素不变**）
 *   · v3「时尚杂志」→ 渲染 `MagPlate`（竖排栏目名 + 自绘栏目徽记 + 数据图形槽）
 *
 * 于是各页面要做的只有两件事：
 *   ① `<PageHead` 换成 `<PagePlate`（props 形状完全兼容）
 *   ② 想清楚「这一页最该被看见的那个数字，画成什么形状」，传进 `figure`
 *
 * 没传 `figure` 也不会退回老样子：版式已经是铭牌（横排标题 + 徽记 + 竖排栏目名），
 * 图形是**加厚**，不是开关。
 */
export interface PagePlateProps {
  /** 眉标：中文界面建议写成「NOVEL CONFIG · 小说配置」这种中英混排 */
  kicker: string
  title: string
  /** 小字说明（与 descriptionRich 二选一，后者优先） */
  description?: string
  /** 需要局部上色的小字说明 */
  descriptionRich?: { zhCN: ReactNode; enUS: ReactNode }
  /** 右上角操作组 */
  actions?: ReactNode
  /** 眉标与标题之间的附加内容 */
  children?: ReactNode

  /* ---- 以下仅 v3 铭牌使用 ---- */
  /** 栏目键：决定徽记形状与左缘竖排英文名 */
  section?: SectionKey | null
  /** 数据图形：各页自绘的 SVG（这一页最该被看见的那件事） */
  figure?: ReactNode
  /** 图形旁边的事实读数 */
  facts?: ReactNode
  /** 右侧期刊化大数字 */
  metric?: MagPlateMetric
}

export default function PagePlate({
  kicker,
  title,
  description,
  descriptionRich,
  actions,
  children,
  section = null,
  figure,
  facts,
  metric,
}: PagePlateProps) {
  const uiVersion = useUiVersionStore((s) => s.uiVersion)
  const locale = useLocaleStore((s) => s.locale)

  // v2 与 v1：原路径，一个字符都不变
  if (!isMagazine(uiVersion)) {
    return (
      <PageHead
        kicker={kicker}
        title={title}
        description={description}
        descriptionRich={descriptionRich}
        actions={actions}
      >
        {children}
      </PageHead>
    )
  }

  const lede = descriptionRich
    ? (locale === 'en-US' ? descriptionRich.enUS : descriptionRich.zhCN)
    : description

  return (
    <MagPlate
      section={section}
      kicker={kicker}
      title={title}
      lede={lede}
      figure={figure}
      facts={facts}
      metric={metric}
      actions={actions}
    >
      {children}
    </MagPlate>
  )
}
