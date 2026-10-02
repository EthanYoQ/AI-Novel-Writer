/**
 * 子菜单页头。
 *
 * ── 两套版式，一个入口 ──────────────────────────────────────────────────────
 *   v2「墨纸书斋」：小字眉标 → 大字标题 → 小字说明，右侧操作组
 *   （demo 的 `.pagehead`，shell.css 261–266 行）
 *
 *   v3「时尚杂志」：**紧凑铭牌** —— 左缘一道 3px 栏目色竖条 + 眉标 + 标题 +
 *   说明 + 右侧操作组，底部一条细线收口。
 *
 * ── 为什么 v3 要在这里分家 ──────────────────────────────────────────────────
 * 页面级页头走 `PagePlate`（大版铭牌：竖排栏目名 + 自绘徽记 + 期刊化读数）。
 * 而**浮层里的页头**（对话框、侧栏面板）共 9 处直接挂本组件 —— 那里空间小，
 * 大版铭牌放不进去，于是给它们一个**同族但更轻**的紧凑版：
 *
 *   · 左缘色标代替徽记（省掉 26px 的宽度）
 *   · 标题 22px 高对比宋（不是 40px 超粗黑）
 *   · 没有竖排英文名、没有期刊化大数字、没有数据图形
 *   · 收口线 1px（页面级是 3px）——同一族，但轻一档
 *
 * 分家收在这一个文件里：`isMagazine(uiVersion)` 为真才走紧凑版，
 * v2 与 v1 逐像素走原路径。
 */
import type { ReactNode } from 'react'

import { useLocaleStore } from '../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'

export interface PageHeadProps {
  /** 朱砂小字眉标，中文界面建议写成「NOVEL CONFIG · 小说配置」这种中英混排 */
  kicker: string
  title: string
  /** 小字说明：这一页是干什么的 */
  description?: string
  /**
   * 需要**局部上色**的小字说明（与 description 二选一，本项优先）。
   *
   * 用途：先生要「CAST 标头里的角色名用主题色」，而纯字符串做不到局部着色。
   * 双语仍由本组件按 locale 选取，调用方只负责把中文 / 英文各自的节点拼好。
   */
  descriptionRich?: { zhCN: ReactNode; enUS: ReactNode }
  /** 右上角操作组 */
  actions?: ReactNode
  /** 眉标与标题之间的附加内容（例如状态徽标） */
  children?: ReactNode
}

export default function PageHead({
  kicker,
  title,
  description,
  descriptionRich,
  actions,
  children,
}: PageHeadProps) {
  const locale = useLocaleStore(s => s.locale)
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  const descNode = descriptionRich
    ? (locale === 'en-US' ? descriptionRich.enUS : descriptionRich.zhCN)
    : description

  /* v3「时尚杂志」：紧凑铭牌（浮层里用的那一版） */
  if (isMagazine(uiVersion)) {
    return (
      <div className="mag-plate is-compact">
        <div className="mp-main">
          <div className="mp-kicker">{kicker}</div>
          <h1 className="mp-name">{title}</h1>
          {children}
          {descNode && <p className="mp-lede">{descNode}</p>}
        </div>
        {actions && <div className="mp-actions">{actions}</div>}
      </div>
    )
  }

  /* v1「经典界面」：简单标题页头 —— 无眉标、无衬线大标题。
   * 上游原始版本（master）里页面页头就是 h2 标题 + 小字说明，不做「NOVEL CONFIG ·」
   * 这种中英混排眉标，也不套 .pagehead 三段式。 */
  if (uiVersion === 'v1') {
    return (
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>{title}</h2>
          {children}
          {descNode && <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>{descNode}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    )
  }

  /* v2「墨纸书斋」：原路径，一个字符都不变 */
  return (
    <div className="pagehead">
      <div className="ph-t">
        <div className="ph-k">{kicker}</div>
        <h1>{title}</h1>
        {children}
        {descNode && <div className="ph-d">{descNode}</div>}
      </div>
      {actions && <div className="ph-a">{actions}</div>}
    </div>
  )
}
