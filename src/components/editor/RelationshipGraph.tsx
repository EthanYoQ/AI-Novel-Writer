import { useRef, useEffect, useMemo } from 'react'
import { parseRelationshipEdges } from '../../shared/relationship-presentation'

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
    }

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
    }
  }, [characters, edges])

  if (characters.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-muted)]">
        暂无角色数据
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: 'transparent', color: 'var(--color-text)' }}
    />
  )
}
