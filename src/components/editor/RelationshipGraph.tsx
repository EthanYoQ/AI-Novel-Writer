import { useRef, useEffect, useMemo, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { parseRelationshipEdges } from '../../shared/relationship-presentation'
import { useLocaleStore } from '../../stores/locale-store'

interface CharacterNode {
  name: string
  role: string
  x: number
  y: number
  vx: number
  vy: number
}

interface RelationshipGraphEdge {
  from: string
  to: string
  label: string
}

interface RelationshipGraphProps {
  characters: Array<{
    name: string
    role: string
    relationships: string
  }>
}

/** 角色关系网 Canvas 可视化 */
export default function RelationshipGraph({ characters }: RelationshipGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<CharacterNode[]>([])
  const animRef = useRef<number>(0)
  const drawRef = useRef<(() => void) | null>(null)
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 })
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const text = useLocaleStore(state => state.text)

  const edges = useMemo<RelationshipGraphEdge[]>(() => {
    const knownNames = characters.map((character) => character.name)
    return characters.flatMap((character) => (
      parseRelationshipEdges(character.relationships, {
        knownNames,
        selfName: character.name,
      }).map((edge) => ({
        from: character.name,
        to: edge.target,
        label: edge.relation,
      }))
    ))
  }, [characters])

  // 初始化节点布局
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const w = canvas.offsetWidth
    const h = canvas.offsetHeight
    canvas.width = w * 2
    canvas.height = h * 2

    const centerX = w
    const centerY = h
    const radius = Math.min(w, h) * 0.6

    // 环形初始布局
    nodesRef.current = characters.map((c, i) => {
      const angle = (i / characters.length) * Math.PI * 2 - Math.PI / 2
      return {
        name: c.name,
        role: c.role,
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
        vx: 0,
        vy: 0,
      }
    })

    // 启动力导向模拟
    let iteration = 0
    const maxIterations = 120

    const drawFrame = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const canvasStyles = getComputedStyle(canvas)
      const readableTextColor = canvasStyles.color
      const relationshipLabelColor = canvasStyles.getPropertyValue('--color-text-secondary').trim()

      const nodes = nodesRef.current

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      const view = viewRef.current
      ctx.translate(view.offsetX, view.offsetY)
      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.scale(view.scale, view.scale)
      ctx.translate(-canvas.width / 2, -canvas.height / 2)

      // 绘制连线
      ctx.lineWidth = 1.5
      for (const edge of edges) {
        const a = nodes.find((n) => n.name === edge.from)
        const b = nodes.find((n) => n.name === edge.to)
        if (!a || !b) continue

        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.strokeStyle = 'rgba(148,163,184,0.3)'
        ctx.stroke()

        // 关系标签
        if (edge.label) {
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          ctx.font = '18px system-ui'
          ctx.fillStyle = relationshipLabelColor
          ctx.textAlign = 'center'
          ctx.fillText(edge.label, mx, my - 4)
        }
      }

      // 绘制节点
      for (const node of nodes) {
        const role = ['protagonist', 'antagonist', 'supporting', 'minor'].includes(node.role)
          ? node.role
          : 'minor'
        const color = canvasStyles.getPropertyValue(`--color-role-${role}`).trim()
          || canvasStyles.getPropertyValue('--color-text-secondary').trim()

        // 光晕
        ctx.beginPath()
        ctx.arc(node.x, node.y, 28, 0, Math.PI * 2)
        ctx.fillStyle = color + '25'
        ctx.fill()

        // 节点
        ctx.beginPath()
        ctx.arc(node.x, node.y, 20, 0, Math.PI * 2)
        ctx.fillStyle = color + '40'
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()

        // 名字
        ctx.font = 'bold 22px system-ui'
        ctx.fillStyle = readableTextColor
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(node.name, node.x, node.y + 36)
      }
      ctx.restore()
    }
    drawRef.current = drawFrame

    const themeObserver = new MutationObserver(drawFrame)
    const skinRoot = canvas.closest<HTMLElement>('.app-skin-root')
    const observedThemeRoots = new Set<HTMLElement>([
      document.documentElement,
      ...(skinRoot ? [skinRoot] : []),
    ])
    for (const themeRoot of observedThemeRoots) themeObserver.observe(themeRoot, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-skin', 'data-skin-readability'],
    })

    const simulate = () => {
      const nodes = nodesRef.current
      if (iteration >= maxIterations) {
        drawFrame()
        return
      }

      // 斥力（节点间）
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
          const force = 8000 / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          nodes[i].vx -= fx
          nodes[i].vy -= fy
          nodes[j].vx += fx
          nodes[j].vy += fy
        }
      }

      // 引力（连线间）
      for (const edge of edges) {
        const a = nodes.find((n) => n.name === edge.from)
        const b = nodes.find((n) => n.name === edge.to)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        const force = (dist - 150) * 0.01
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }

      // 向心力
      for (const node of nodes) {
        node.vx += (centerX - node.x) * 0.002
        node.vy += (centerY - node.y) * 0.002
      }

      // 应用速度 + 阻尼
      const damping = 0.85
      for (const node of nodes) {
        node.vx *= damping
        node.vy *= damping
        node.x += node.vx
        node.y += node.vy
        // 边界约束
        node.x = Math.max(40, Math.min(w * 2 - 40, node.x))
        node.y = Math.max(40, Math.min(h * 2 - 40, node.y))
      }

      iteration++
      drawFrame()
      animRef.current = requestAnimationFrame(simulate)
    }

    simulate()

    return () => {
      themeObserver.disconnect()
      cancelAnimationFrame(animRef.current)
      drawRef.current = null
    }
  }, [characters, edges])

  const updateZoom = (nextScale: number) => {
    const scale = Math.min(2, Math.max(0.5, Math.round(nextScale * 10) / 10))
    viewRef.current.scale = scale
    setZoomPercent(Math.round(scale * 100))
    drawRef.current?.()
  }

  const fitView = () => {
    viewRef.current = { scale: 1, offsetX: 0, offsetY: 0 }
    setZoomPercent(100)
    drawRef.current?.()
  }

  if (characters.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-muted)]">
        暂无角色数据
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div
        className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border px-1 py-1"
        style={{
          borderColor: 'var(--color-border)',
          backgroundColor: 'var(--color-panel)',
          color: 'var(--color-text)',
        }}
      >
        <button
          type="button"
          className="rounded p-1 hover:bg-[var(--color-hover)]"
          aria-label={text('缩小关系图谱', 'Zoom out of character graph')}
          onClick={() => updateZoom(viewRef.current.scale - 0.1)}
        >
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <span className="min-w-10 text-center text-[11px] tabular-nums">{zoomPercent}%</span>
        <button
          type="button"
          className="rounded p-1 hover:bg-[var(--color-hover)]"
          aria-label={text('放大关系图谱', 'Zoom in to character graph')}
          onClick={() => updateZoom(viewRef.current.scale + 0.1)}
        >
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rounded p-1 hover:bg-[var(--color-hover)]"
          aria-label={text('适合视图', 'Fit character graph to view')}
          onClick={fitView}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{ background: 'transparent', color: 'var(--color-text)' }}
        onWheel={(event) => {
          event.preventDefault()
          updateZoom(viewRef.current.scale + (event.deltaY < 0 ? 0.1 : -0.1))
        }}
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag) return
          const pixelRatio = event.currentTarget.width / Math.max(event.currentTarget.clientWidth, 1)
          viewRef.current.offsetX += (event.clientX - drag.x) * pixelRatio
          viewRef.current.offsetY += (event.clientY - drag.y) * pixelRatio
          dragRef.current = { x: event.clientX, y: event.clientY }
          drawRef.current?.()
        }}
        onPointerUp={(event) => {
          dragRef.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { dragRef.current = null }}
      />
    </div>
  )
}
