import { useCallback, useEffect, useRef } from 'react'

export interface GripHandleProps {
  /** 拖拽方向：vertical 用于左右分栏（改宽度），horizontal 用于上下分栏（改高度）。 */
  orientation?: 'vertical' | 'horizontal'
  /** 每次鼠标移动的增量（像素）。调用方负责累加到既有 store 宽度上。 */
  onDelta: (delta: number) => void
  className?: string
  title?: string
}

/**
 * 分栏拖拽手柄。
 *
 * demo 用自研 grip 而非面板库，v2 外壳照此实现：拖拽期间在 document 上监听，
 * 避免鼠标移出手柄就丢失跟随；同时锁定光标与文本选择，手感与 demo 一致。
 */
export default function GripHandle({
  orientation = 'vertical',
  onDelta,
  className,
  title,
}: GripHandleProps) {
  const lastRef = useRef<number | null>(null)
  /**
   * onDelta 走 ref 转发（与 CodeMirrorEditor 的 updateHandlerRef 同一范式）：
   * window 上的监听只注册一次，不随调用方内联箭头函数的引用变化反复解绑重绑。
   *
   * 赋值放在 effect 里而非 render 期：render 期写 ref 在并发渲染 / StrictMode
   * 双调用下可能写入「已被丢弃的那一次渲染」的值。
   */
  const deltaRef = useRef(onDelta)
  useEffect(() => {
    deltaRef.current = onDelta
  })

  const stop = useCallback(() => {
    lastRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (lastRef.current === null) return
      const position = orientation === 'vertical' ? event.clientX : event.clientY
      const delta = position - lastRef.current
      lastRef.current = position
      if (delta !== 0) deltaRef.current(delta)
    }
    const handleUp = () => stop()

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      // 必须先回收 body 上的光标 / 禁止选择 —— 拖拽进行中组件被卸载
      // （一手拖手柄、一手点顶栏按钮）或在窗口外松手（Electron 收不到 mouseup）时，
      // 否则全局光标会永久停在 col-resize、整个应用无法选中任何文字。
      stop()
    }
  }, [orientation, stop])

  return (
    <div
      className={className ?? 'grip'}
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      title={title}
      onMouseDown={(event) => {
        event.preventDefault()
        lastRef.current = orientation === 'vertical' ? event.clientX : event.clientY
        document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
        document.body.style.userSelect = 'none'
      }}
    />
  )
}
