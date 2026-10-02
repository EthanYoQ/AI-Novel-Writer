import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { isMagazine, useUiVersionStore } from '../../../stores/ui-version-store'
// 书脊的类型与尺寸换算拆到独立模块：本文件只导出组件，react-refresh 才能做组件级
// 热替换（既导出组件又导出普通函数/常量的文件只能退回整页刷新）。
import { spineDimensions, type BookTexture, type ShelfBook } from './bookShelfSpine'

// 对外 API 不变：使用方仍可从 './BookShelf' 取到这两个类型。
export type { BookTexture, ShelfBook }

export interface BookShelfProps {
  books: ShelfBook[]
  /** 点击「新书」虚线卡。 */
  onNewBook?: () => void
  /** 单击选中后再击一次进入该书。 */
  onOpenBook?: (book: ShelfBook) => void
  /** 单击选中（第一下）：让上方的项目卡切成这本书的进度预览。 */
  onSelectBook?: (book: ShelfBook) => void
}

/** 书封配色的形状 —— 两个界面版本共用这个类型，但各有各的一套值。 */
type BookPalette = Pick<ShelfBook, 'cover' | 'edge' | 'text' | 'foil' | 'texture'>

/**
 * 书封配色 —— **两个界面版本各一套**（2026-09-16 分家）。
 *
 * 先生定调：界面版本各自分家，一个版本的美化**绝不能影响另一个版本**。
 * 所以这里不能只留一套常量：v2 继续用 demo 的传统精装色（藏青 / 棕皮 /
 * 墨绿 + 烫金），v3 才用与书脊同源的栏目七色。
 */

/** v2「墨纸书斋」：demo 原样，逐像素不变。 */
const CLASSIC_PALETTE: BookPalette[] = [
  { cover: '#2E3A48', edge: '#202A34', text: '#EFE3CC', foil: '#C9A86A', texture: 'texture-cloth' },
  { cover: '#7A5A3A', edge: '#563E27', text: '#F1E3C9', foil: '#D8BE8E', texture: 'texture-leather' },
  { cover: '#3E5A4E', edge: '#2A4035', text: '#E6ECDD', foil: '#C6CFC0', texture: 'texture-lacquer' },
  { cover: '#566878', edge: '#3D4A58', text: '#EAEEF1', foil: '#CFD6DC', texture: 'texture-paper' },
  { cover: '#4A3A4E', edge: '#32263A', text: '#EFE4EE', foil: '#C9A9C4', texture: 'texture-old' },
  { cover: '#3B4A5A', edge: '#28323E', text: '#E4EAF0', foil: '#AFC0CE', texture: 'texture-metal' },
]

/** v3「时尚杂志」：与刊头彩带、书脊色条用的是同一组颜色 —— 整站只有一套颜色语言。 */
const MAGAZINE_PALETTE: BookPalette[] = [
  { cover: '#C8564A', edge: '#A03F35', text: '#FFF4F1', foil: '#FFD6CC', texture: 'texture-paper' },
  { cover: '#27407A', edge: '#1A2D5C', text: '#EDF2FF', foil: '#A8C1F2', texture: 'texture-cloth' },
  { cover: '#A8842F', edge: '#836522', text: '#FFF8EA', foil: '#F2DFA6', texture: 'texture-lacquer' },
  { cover: '#2E5C4C', edge: '#1F4236', text: '#ECF7F1', foil: '#A6D8C2', texture: 'texture-cloth' },
  { cover: '#7A5B7E', edge: '#573E5B', text: '#F8F0F8', foil: '#DDB9D8', texture: 'texture-old' },
  { cover: '#2F5F6E', edge: '#1F4553', text: '#EAF5F8', foil: '#A6D1DA', texture: 'texture-metal' },
  { cover: '#7A5136', edge: '#573922', text: '#FBF1E8', foil: '#E2BE9A', texture: 'texture-leather' },
]

/** 状态排序：完成度高的靠左，未动笔的靠右。 */
const STATUS_RANK: Record<string, number> = { 已定稿: 0, 写作中: 1, 草稿: 2, 蓝图: 3 }

/**
 * V6 拟真书柜。
 *
 * 完整移植 demo 的伪物理手感：按住空白左右拖动（带惯性）、按住书脊可把书从架上
 * 拿起（相邻书会跟着倾斜）、单击书脊轻抬查看、再击进入该书。
 * 拖拽期间一律直接写 CSS 变量，不触发 React 重渲染，保证手感与 demo 一致。
 */
export default function BookShelf({ books, onNewBook, onOpenBook, onSelectBook }: BookShelfProps) {
  const text = useLocaleStore((s) => s.text)
  /** 界面版本决定书封配色与书脊尺寸 —— 两个版本各自一套，互不影响。 */
  const uiVersion = useUiVersionStore((s) => s.uiVersion)
  const paletteSet = isMagazine(uiVersion) ? MAGAZINE_PALETTE : CLASSIC_PALETTE
  const shelfRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [held, setHeld] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const motion = useRef({
    x: 0, minX: 0, maxX: 0, velocity: 0, raf: 0,
    down: false, lastX: 0, startX: 0, downTime: 0, moved: false, dragIndex: -1,
  })

  const sorted = [...books].sort(
    (a, b) => (STATUS_RANK[a.status ?? ''] ?? 9) - (STATUS_RANK[b.status ?? ''] ?? 9),
  )

  const applyTransform = useCallback(() => {
    trackRef.current?.style.setProperty('--x', `${motion.current.x}px`)
  }, [])

  const clampBounds = useCallback(() => {
    const shelf = shelfRef.current
    const track = trackRef.current
    if (!shelf || !track) return
    const m = motion.current
    m.maxX = 0
    m.minX = Math.min(0, shelf.clientWidth - track.scrollWidth)
    m.x = Math.max(m.minX, Math.min(m.maxX, m.x))
    applyTransform()
  }, [applyTransform])

  // 惯性滑动：速度衰减到阈值以下即停
  const runInertia = useCallback(() => {
    /**
     * 续帧函数声明在 useCallback 内部，由 rAF 直接引用自身。
     * 原来让 useCallback 的返回值递归调用自己，React 的 lint 会判为
     * 「在声明前访问 runInertia」，而且自引用的 useCallback 依赖数组也失去意义。
     */
    const step = () => {
      const m = motion.current
      m.velocity *= 0.94
      if (Math.abs(m.velocity) < 0.08) {
        m.velocity = 0
        return
      }
      m.x += m.velocity
      if (m.x > m.maxX) { m.x = m.maxX; m.velocity *= 0.35 }
      if (m.x < m.minX) { m.x = m.minX; m.velocity *= 0.35 }
      applyTransform()
      m.raf = requestAnimationFrame(step)
    }
    step()
  }, [applyTransform])

  useEffect(() => {
    const handleResize = () => clampBounds()
    window.addEventListener('resize', handleResize)
    // 句柄必须自己存下来：这个 rAF 只是「首帧排版」，不保存就没法在卸载时取消，
    // 卸载后回调仍会跑一次并去动已经脱离文档的节点。
    const initialRaf = requestAnimationFrame(clampBounds)
    // motion 是组件级 ref 对象（整个生命周期都是同一个对象），这里取一份快照给
    // 清理函数用：清理函数在「之后的某个时刻」执行，届时直接读 motion.current
    // 会被 lint 判为「值可能已变」，取快照既消除告警也不改变行为。
    const motionSnapshot = motion.current
    return () => {
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(initialRaf)
      cancelAnimationFrame(motionSnapshot.raf)
    }
  }, [clampBounds])

  useEffect(() => {
    const raf = requestAnimationFrame(clampBounds)
    return () => cancelAnimationFrame(raf)
  }, [books.length, clampBounds])

  const stopMotion = () => {
    cancelAnimationFrame(motion.current.raf)
    motion.current.velocity = 0
  }

  const handlePointerDown = (event: React.PointerEvent, index: number) => {
    if (event.button !== 0) return
    stopMotion()
    const m = motion.current
    m.down = true
    m.moved = false
    m.dragIndex = index
    // 用事件自带的时间戳而不是 performance.now()：两者同属 performance 时间基准
    // （Chromium 的 DOMHighResTimeStamp），而事件时间戳记的是「事件发生时刻」，
    // 比在处理器里取当前时刻更准；也避免在事件处理器里调用 impure 函数。
    m.downTime = event.timeStamp
    m.lastX = event.clientX
    m.startX = event.clientX
    setDragging(true)
    if (index >= 0) setHeld(index)
    ;(index >= 0 ? event.currentTarget : shelfRef.current)?.setPointerCapture?.(event.pointerId)
    if (index >= 0) event.stopPropagation()
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    const m = motion.current
    if (!m.down) return
    const dx = event.clientX - m.lastX
    m.lastX = event.clientX
    // 判定「已拖动」的时间阈值与 pointerdown 同源：两边都用事件自带时间戳
    // （同属 performance 时间基准），跨基准相减会把长按判定带偏。
    if (Math.abs(event.clientX - m.startX) > 3 || event.timeStamp - m.downTime > 180) m.moved = true
    m.velocity = m.velocity * 0.55 + dx * 0.45
    m.x += dx
    if (m.x > m.maxX) { m.x = m.maxX; m.velocity *= 0.18 }
    if (m.x < m.minX) { m.x = m.minX; m.velocity *= 0.18 }
    applyTransform()
    // 拖动起书时，被拿起的那本跟着指针走，两侧邻居顺势倾斜
    if (m.moved && m.dragIndex >= 0) {
      const nodes = trackRef.current?.querySelectorAll<HTMLElement>('.book')
      nodes?.forEach((node, i) => {
        if (i === m.dragIndex) {
          node.style.setProperty('--nudge', '0px')
          return
        }
        const distance = Math.abs(i - m.dragIndex)
        if (distance > 2) {
          node.classList.remove('neighbor-left', 'neighbor-right')
          node.style.setProperty('--nudge', '0px')
          return
        }
        node.classList.add(i < m.dragIndex ? 'neighbor-left' : 'neighbor-right')
        node.style.setProperty('--nudge', i < m.dragIndex ? '-9px' : '9px')
      })
    }
  }

  const handlePointerUp = (_event: React.PointerEvent, index: number) => {
    const m = motion.current
    if (!m.down) return
    m.down = false
    setDragging(false)
    setHeld(null)
    trackRef.current?.querySelectorAll<HTMLElement>('.book').forEach((node) => {
      node.classList.remove('neighbor-left', 'neighbor-right')
      node.style.setProperty('--nudge', '0px')
    })
    if (m.moved) {
      if (Math.abs(m.velocity) > 0.6) m.raf = requestAnimationFrame(runInertia)
      return
    }
    // 未拖动即视为点击：第一次选中轻抬，再击进入
    const clicked = index >= 0 ? index : m.dragIndex
    if (clicked < 0) {
      setSelected(null)
      return
    }
    if (selected === clicked) {
      const book = sorted[clicked]
      if (book) onOpenBook?.(book)
      return
    }
    setSelected(clicked)
    // 第一下点击 = 选中：顺便让上方的项目卡切成这本书的进度
    const picked = sorted[clicked]
    if (picked) onSelectBook?.(picked)
  }

  return (
    <div className="v6shelf">
      <div
        ref={shelfRef}
        className={`shelf${dragging ? ' dragging' : ''}${held !== null ? ' grabbing-book' : ''}`}
        onPointerDown={(event) => handlePointerDown(event, -1)}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => handlePointerUp(event, -1)}
        onPointerCancel={(event) => handlePointerUp(event, -1)}
      >
        <div ref={trackRef} className="track">
          {sorted.map((book, index) => {
            const palette = paletteSet[index % paletteSet.length]
            const dim = spineDimensions(book, uiVersion)
            /**
             * 书名字号交给 CSS 变量（第十五轮）——
             * 长书名的书由 `spineDimensions()` 决定「降字号 / 折列 / 加宽书脊」，
             * 结果通过 `--mag-title-px` 递给 `mag-pages.css` 的 `.v6shelf .title`。
             * **只有 v3 才写**：v2 的 `.v6shelf .title` 走 v2-shelf.css 自己的字号，
             * 拿到这个变量也没人读，但按「分家」的规矩，v2 下连写都不写。
             */
            const magTitleStyle = isMagazine(uiVersion)
              ? ({ ['--mag-title-px' as string]: `${dim.titlePx}px` } as React.CSSProperties)
              : undefined
            const active = selected === index
            const classes = [
              'book',
              book.texture ?? palette.texture,
              active ? 'selected' : '',
              held === index ? 'held' : '',
            ].filter(Boolean).join(' ')
            return (
              <div key={book.id} className="book-space" style={{ width: dim.w }}>
                <article
                  className={classes}
                  style={{
                    ['--height' as string]: `${dim.h}px`,
                    ['--width' as string]: `${dim.w}px`,
                    ['--depth' as string]: `${dim.depth}px`,
                    ['--rot' as string]: `${((index % 5) - 2) * 0.55}deg`,
                    ['--cover' as string]: book.cover ?? palette.cover,
                    ['--edge' as string]: book.edge ?? palette.edge,
                    ['--text' as string]: book.text ?? palette.text,
                    ['--foil' as string]: book.foil ?? palette.foil,
                    ['--lift' as string]: '0px',
                    ['--yaw' as string]: '-8deg',
                    ['--nudge' as string]: '0px',
                    ...magTitleStyle,
                  } as React.CSSProperties}
                  onPointerDown={(event) => handlePointerDown(event, index)}
                  onPointerUp={(event) => handlePointerUp(event, index)}
                  title={book.title}
                >
                  <div className="spine">
                    <span className="gold-line l" />
                    <span className="gold-line r" />
                    {book.status && <span className="genre">{book.status}</span>}
                    <span className="title">{book.title}</span>
                    {book.author && <span className="author">{book.author}</span>}
                  </div>
                  <span className="book-meta">
                    {book.title} · {dim.tenThousandWords} {text('万字', '×10k words')}
                  </span>
                </article>
              </div>
            )
          })}

          <div
            className="new"
            onPointerDown={(event) => { event.stopPropagation() }}
            onClick={() => onNewBook?.()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === 'Enter') onNewBook?.() }}
          >
            <span className="plus">+</span>
            <span>{text('新书', 'New')}</span>
          </div>
        </div>
      </div>
      <div className="v6tip">
        {text(
          '按住空白左右拖动 · 单击书脊轻抬查看 · 再击进入该书 · 按住书脊可把书从架上拿起',
          'Drag the shelf to browse · click a spine to lift it · click again to open · hold a spine to pull it off the shelf',
        )}
      </div>
    </div>
  )
}
