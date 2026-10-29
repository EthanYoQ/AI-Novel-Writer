import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6
/** 浮层与视口边缘至少留的距离。 */
const MARGIN = 8
const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]'

/** 浏览器按 Tab 会停的控件：折叠的 <details> 里、display:none 与 visibility:hidden 的控件不算。 */
const tabbablesIn = (layer: HTMLElement) =>
  [...layer.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => element.tabIndex >= 0 && element.checkVisibility({ visibilityProperty: true }))

/**
 * Menu 与 Popover 共用：浮层 Portal 到最近的 .paper-ink 根，按触发按钮位置 fixed 定位，
 * 不被侧页等滚动容器裁切。下方放不下且上方更宽裕时向上展开，高度不超过所在一侧的视口空间，再多就在浮层内部滚动。
 * 点击外部、焦点移到外部、触发按钮被滚动带走、改变窗口大小时关闭；
 * Esc 关闭并把焦点还给触发按钮；Tab 离开浮层时先回到触发按钮，再由浏览器继续移动焦点。
 */
export function useAnchoredLayer(align: 'start' | 'end'): {
  open: boolean
  layerId: string
  anchorRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  layerRef: RefObject<HTMLDivElement | null>
  renderLayer: (layer: ReactNode) => ReactNode
  show: () => void
  toggle: () => void
  close: (returnFocus: boolean) => void
} {
  const [open, setOpen] = useState(false)
  const layerId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  /** 定位时外层锚点的位置，滚动时与它比。量锚点不量按钮：按钮展开后有下沉 1px 的过渡，会被误当成被滚动带走。 */
  const placedAt = useRef<DOMRect | null>(null)
  // 打开时才找 Portal 的根：书架上每本书都有一个菜单，挂载时逐个查找会让每个菜单多渲染一次。
  const [root, setRoot] = useState<Element | null>(null)
  const findRoot = useCallback(() => setRoot(anchorRef.current?.closest('.paper-ink') ?? null), [])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const layer = layerRef.current
    const trigger = triggerRef.current
    if (!open || !layer || !trigger) return
    const rect = trigger.getBoundingClientRect()
    placedAt.current = anchorRef.current?.getBoundingClientRect() ?? null
    const { clientWidth, clientHeight } = document.documentElement
    const below = clientHeight - rect.bottom - GAP - MARGIN
    const above = rect.top - GAP - MARGIN
    const upward = layer.offsetHeight > below && above > below
    layer.style.maxHeight = `${upward ? above : below}px`
    layer.toggleAttribute('data-upward', upward)
    if (upward) layer.style.bottom = `${clientHeight - rect.top + GAP}px`
    else layer.style.top = `${rect.bottom + GAP}px`
    const widest = clientWidth - layer.offsetWidth - MARGIN
    if (align === 'end') layer.style.right = `${Math.min(Math.max(MARGIN, clientWidth - rect.right), widest)}px`
    else layer.style.left = `${Math.min(Math.max(MARGIN, rect.left), widest)}px`
  }, [open, align])

  useEffect(() => {
    const layer = layerRef.current
    const anchor = anchorRef.current
    if (!open || !layer || !anchor) return
    const inside = (target: EventTarget | null) => target instanceof Node && (anchor.contains(target) || layer.contains(target))
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false)
    }
    // 鼠标打开时焦点留在触发按钮上，Tab 会直接走到页面下一项，浮层不能还开着
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) close(false)
    }
    // 只看外层锚点动没动：别处的滚动区（跟到最新一行的运行日志）滚动时浮层不必关
    const onScroll = () => {
      const now = anchor.getBoundingClientRect()
      if (now.top !== placedAt.current?.top || now.left !== placedAt.current?.left) close(false)
    }
    const onResize = () => close(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
      }
    }
    const onLayerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const tabbables = tabbablesIn(layer)
      const active = document.activeElement
      if (event.shiftKey && (tabbables.length === 0 || active === layer || active === tabbables[0])) {
        event.preventDefault()
        close(true)
      } else if (!event.shiftKey && (tabbables.length === 0 || active === tabbables[tabbables.length - 1])) {
        close(true)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    anchor.addEventListener('keydown', onKeyDown)
    layer.addEventListener('keydown', onKeyDown)
    layer.addEventListener('keydown', onLayerKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      anchor.removeEventListener('keydown', onKeyDown)
      layer.removeEventListener('keydown', onKeyDown)
      layer.removeEventListener('keydown', onLayerKeyDown)
    }
  }, [open, close])

  return {
    open,
    layerId,
    anchorRef,
    triggerRef,
    layerRef,
    renderLayer: (layer) => (root ? createPortal(layer, root) : layer),
    show: useCallback(() => {
      findRoot()
      setOpen(true)
    }, [findRoot]),
    toggle: useCallback(() => {
      findRoot()
      setOpen((value) => !value)
    }, [findRoot]),
    close,
  }
}
