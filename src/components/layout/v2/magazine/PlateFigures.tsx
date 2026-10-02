import type { ReactNode } from 'react'

/**
 * 铭牌的数据图形（Plate Figures）—— 把页面里最关键的一件事**画出来**。
 *
 * ── 它们是什么，不是什么 ────────────────────────────────────────────────────
 * 不是把数字换个好看的样子，也不是装饰：每个图形的形状都直接对应它在那一页的**语义**。
 *
 *   PlateTicks    一排竖刻线，高度即数量   → 「哪一类最多」一眼可数（设定集的分类分布、审稿的问题分布）
 *   PlateChecks   一排方格，已定的填实     → 「还差哪几项没定」（小说配置的字段完成度）
 *   PlateThreads  一条线 + 方点，线型即状态 → 「伏笔都到哪一步了」（埋下 / 推进 / 已收 / 计划 / 弃置）
 *
 * ── 共同的纪律 ──────────────────────────────────────────────────────────────
 * · 只用**方点与直线**，与七栏目徽记、书脊索引块同一套几何语言
 * · 尺寸统一 168×66，与档案铭牌里的关系缩略网同高 —— 数据行因此横向对齐
 * · 颜色只取 `var(--mag-sec)`（当前栏目色）与墨阶，不引入第五种颜色
 * · **数据诚实**：没数据就画空态（一条基线 + 说明文字），不画假的块
 */

/** 图形画布尺寸：与关系缩略网同高，数据行横向对齐 */
export const FIGURE_WIDTH = 168
export const FIGURE_HEIGHT = 66

/* ==========================================================================
 * 一排竖刻线：高度即数量
 * ======================================================================== */

export interface PlateTicksProps {
  items: Array<{ label: string; value: number }>
  /** 最多画几根；超出取前几名，其余靠 facts 文字交代 */
  limit?: number
}

export function PlateTicks({ items, limit = 14 }: PlateTicksProps) {
  const shown = items.filter((item) => item.value > 0).slice(0, limit)
  const max = Math.max(1, ...shown.map((item) => item.value))
  const slot = FIGURE_WIDTH / Math.max(1, shown.length)
  const barWidth = Math.min(8, Math.max(3, slot - 5))

  return (
    <svg
      width={FIGURE_WIDTH}
      height={FIGURE_HEIGHT}
      viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`}
      role="img"
      aria-label={shown.map((item) => `${item.label} ${item.value}`).join('，') || '暂无数据'}
    >
      {/* 基线：所有刻线站在同一条线上 */}
      <line className="mp-fig-base" x1="0" y1={FIGURE_HEIGHT - 6} x2={FIGURE_WIDTH} y2={FIGURE_HEIGHT - 6} />
      {shown.map((item, index) => {
        const height = Math.max(3, Math.round((item.value / max) * (FIGURE_HEIGHT - 16)))
        const x = index * slot + (slot - barWidth) / 2
        return (
          <rect
            key={item.label}
            className={item.value === max ? 'mp-fig-tick is-peak' : 'mp-fig-tick'}
            x={x}
            y={FIGURE_HEIGHT - 6 - height}
            width={barWidth}
            height={height}
          >
            <title>{`${item.label} · ${item.value}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/* ==========================================================================
 * 一排方格：已定的填实，未定的留空
 * ======================================================================== */

export interface PlateChecksProps {
  items: Array<{ label: string; done: boolean }>
}

export function PlateChecks({ items }: PlateChecksProps) {
  const cell = 11
  const gap = 5
  const perRow = Math.max(1, Math.floor((FIGURE_WIDTH + gap) / (cell + gap)))
  const done = items.filter((item) => item.done).length

  return (
    <svg
      width={FIGURE_WIDTH}
      height={FIGURE_HEIGHT}
      viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`}
      role="img"
      aria-label={`已定 ${done} 项，共 ${items.length} 项`}
    >
      {items.map((item, index) => {
        const row = Math.floor(index / perRow)
        const column = index % perRow
        return (
          <rect
            key={item.label}
            className={item.done ? 'mp-fig-check is-done' : 'mp-fig-check'}
            x={column * (cell + gap)}
            y={10 + row * (cell + gap)}
            width={cell}
            height={cell}
          >
            <title>{`${item.label}${item.done ? '' : ' · 未定'}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/* ==========================================================================
 * 一条线 + 一排方点：线型即状态
 * ======================================================================== */

export type PlateThreadState = 'resolved' | 'progressing' | 'planted' | 'planned' | 'abandoned'

export interface PlateThreadsProps {
  threads: Array<{ label: string; state: PlateThreadState }>
  limit?: number
}

export function PlateThreads({ threads, limit = 12 }: PlateThreadsProps) {
  const shown = threads.slice(0, limit)
  const y = 33
  const step = shown.length > 1 ? (FIGURE_WIDTH - 12) / (shown.length - 1) : 0

  return (
    <svg
      width={FIGURE_WIDTH}
      height={FIGURE_HEIGHT}
      viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`}
      role="img"
      aria-label={shown.map((thread) => `${thread.label} ${thread.state}`).join('，') || '暂无伏笔'}
    >
      {/* 主线：伏笔就是一条线，从左（埋下）到右（回收） */}
      <line className="mp-fig-thread-line" x1="0" y1={y} x2={FIGURE_WIDTH} y2={y} />
      {shown.map((thread, index) => {
        const x = shown.length > 1 ? 6 + index * step : FIGURE_WIDTH / 2
        return (
          <rect
            key={`${thread.label}-${index}`}
            className={`mp-fig-thread is-${thread.state}`}
            x={x - 3}
            y={y - 3}
            width="6"
            height="6"
          >
            <title>{thread.label}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/* ==========================================================================
 * 文档 → 切片：知识库的两级结构
 * ======================================================================== */

export interface PlateLibraryProps {
  /** 库里有多少份资料 */
  documents: number
  /** 它们被切成了多少片（语义块） */
  chunks: number
  /** 每行最多画几个方块 / 几根刻线（其余靠读数交代） */
  documentLimit?: number
  chunkLimit?: number
}

/**
 * 知识库的「文献结构」—— 上半是资料，下半是切片，中间一条引线说明「被切开了」。
 *
 * 形状本身就是这一页最该被看见的事：**投进去的是几份资料，AI 拿到的是几千个语义块**。
 * 切片一律等高 —— 它们本来就被切成等长，画成高低起伏是骗人（数据诚实）。
 */
export function PlateLibrary({
  documents,
  chunks,
  documentLimit = 6,
  chunkLimit = 26,
}: PlateLibraryProps) {
  const docShown = Math.max(0, Math.min(documents, documentLimit))
  const chunkShown = Math.max(0, Math.min(chunks, chunkLimit))
  const docCell = 16
  const chunkCell = 5.5

  return (
    <svg
      width={FIGURE_WIDTH}
      height={FIGURE_HEIGHT}
      viewBox={`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`}
      role="img"
      aria-label={`${documents} 份资料切成 ${chunks} 个语义切片`}
    >
      {/* 上：资料。一份一个方块，排不满就少画几个（不凑数） */}
      {Array.from({ length: docShown }, (_, index) => (
        <rect
          key={`doc-${index}`}
          className="mp-fig-doc"
          x={index * docCell}
          y={6}
          width={11}
          height={14}
        />
      ))}
      {documents > documentLimit && (
        <text className="mp-fig-more" x={docShown * docCell + 3} y={17}>
          {`+${documents - documentLimit}`}
        </text>
      )}

      {/* 中：一条引线 —— 「被切开了」 */}
      <line className="mp-fig-base" x1="0" y1={28} x2={FIGURE_WIDTH} y2={28} />

      {/* 下：切片。等长、等距，一根一个语义块 */}
      {Array.from({ length: chunkShown }, (_, index) => (
        <rect
          key={`chunk-${index}`}
          className="mp-fig-chunk"
          x={index * chunkCell}
          y={38}
          width={3}
          height={22}
        />
      ))}
      {chunks > chunkLimit && (
        <text className="mp-fig-more" x={chunkShown * chunkCell + 3} y={55}>
          {`+${chunks - chunkLimit}`}
        </text>
      )}
    </svg>
  )
}

/* ==========================================================================
 * 图形的公共外壳：把 SVG 与它的一行读数绑在一起
 * ======================================================================== */

export interface PlateFigureProps {
  caption: ReactNode
  children: ReactNode
}

export function PlateFigure({ caption, children }: PlateFigureProps) {
  return (
    <>
      {children}
      <figcaption className="mp-net-caption">{caption}</figcaption>
    </>
  )
}
