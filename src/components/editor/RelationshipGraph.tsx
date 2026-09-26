import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, Crosshair, Maximize2, PanelRightClose,
  PanelRightOpen, RotateCcw, Search, ZoomIn, ZoomOut,
} from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useCharacterAvatars } from './use-character-avatars'
import {
  GRAPH_NODE_LIMIT, layoutRelationshipWindow, type GraphCharacter, type GraphNode,
} from './relationship-graph-layout'

type DragState =
  | { kind: 'view'; x: number; y: number }
  | { kind: 'node'; characterId: string; offsetX: number; offsetY: number; startX: number; startY: number; moved: boolean }

interface RelationshipGraphProps {
  characters: GraphCharacter[]
  selectedCharacterId?: string | null
  onOpenCharacter?: (characterId: string) => void
}

const NODE_LABEL_MAX_CHARACTERS = 8
const RELATIONSHIP_LABEL_MAX_CHARACTERS = 6
const SIDEBAR_PAGE_SIZE = 50

function compactOverviewLabel(value: string, maxCharacters: number): string {
  const characters = Array.from(value.trim())
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters).join('')}…`
    : characters.join('')
}

function pointerWorldPosition(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  view: { scale: number; offsetX: number; offsetY: number },
) {
  const bounds = canvas.getBoundingClientRect()
  const pixelX = (clientX - bounds.left) * canvas.width / (bounds.width || canvas.clientWidth || 1)
  const pixelY = (clientY - bounds.top) * canvas.height / (bounds.height || canvas.clientHeight || 1)
  return {
    x: canvas.width / 2 + (pixelX - view.offsetX - canvas.width / 2) / view.scale,
    y: canvas.height / 2 + (pixelY - view.offsetY - canvas.height / 2) / view.scale,
  }
}

function nodeRadius(node: GraphNode): number { return 14 + node.importance * 2 }

/** Stable-ID, bounded relationship projection. Layout state never leaves this component. */
export default function RelationshipGraph({ characters, selectedCharacterId, onOpenCharacter }: RelationshipGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const drawRef = useRef<(() => void) | null>(null)
  const avatarImagesRef = useRef(new Map<string, HTMLImageElement>())
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 })
  const dragRef = useRef<DragState | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [centerId, setCenterId] = useState<string | null>(
    selectedCharacterId ?? characters.find(character => character.characterId)?.characterId ?? null,
  )
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 })
  const text = useLocaleStore(state => state.text)
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const character of characters) counts.set(character.name, (counts.get(character.name) ?? 0) + 1)
    return new Set(Array.from(counts).flatMap(([name, count]) => count > 1 ? [name] : []))
  }, [characters])

  const actualCenterId = centerId && characters.some(character => character.characterId === centerId)
    ? centerId
    : selectedCharacterId && characters.some(character => character.characterId === selectedCharacterId)
      ? selectedCharacterId
      : characters.find(character => character.characterId)?.characterId ?? null
  const graph = useMemo(() => layoutRelationshipWindow(
    characters, actualCenterId, canvasSize.width, canvasSize.height, GRAPH_NODE_LIMIT,
  ), [characters, actualCenterId, canvasSize])
  const avatarIds = useMemo(() => graph.nodes.map(node => node.characterId), [graph.nodes])
  const { avatarUrls } = useCharacterAvatars(avatarIds, avatarIds.length > 0)

  useEffect(() => {
    const next = new Map<string, HTMLImageElement>()
    for (const [characterId, url] of Object.entries(avatarUrls)) {
      const image = new Image()
      image.onload = () => drawRef.current?.()
      image.src = url
      next.set(characterId, image)
    }
    avatarImagesRef.current = next
    drawRef.current?.()
  }, [avatarUrls])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = Math.max(canvas.offsetWidth, 400) * 2
    const height = Math.max(canvas.offsetHeight, 300) * 2
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      setCanvasSize({ width, height })
      return
    }
    nodesRef.current = graph.nodes.map(node => ({ ...node }))
    const drawFrame = () => {
      const context = canvas.getContext('2d')
      if (!context) return
      const canvasStyles = getComputedStyle(canvas)
      const readableTextColor = canvasStyles.color
      const relationshipLabelColor = canvasStyles.getPropertyValue('--color-text-secondary').trim()
      const nodes = new Map(nodesRef.current.map(node => [node.characterId, node]))
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.save()
      const view = viewRef.current
      context.translate(view.offsetX, view.offsetY)
      context.translate(canvas.width / 2, canvas.height / 2)
      context.scale(view.scale, view.scale)
      context.translate(-canvas.width / 2, -canvas.height / 2)

      context.lineWidth = 1.5
      for (const edge of graph.edges) {
        const from = nodes.get(edge.from)
        const to = nodes.get(edge.to)
        if (!from || !to) continue
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(to.x, to.y)
        context.strokeStyle = 'rgba(148,163,184,0.3)'
        context.stroke()
        const firstRelation = edge.relations[0]?.label
        if (firstRelation) {
          const compactLabel = compactOverviewLabel(firstRelation, RELATIONSHIP_LABEL_MAX_CHARACTERS)
          const additionalCount = edge.relations.length - 1
          context.font = '18px system-ui'
          context.fillStyle = relationshipLabelColor
          context.textAlign = 'center'
          context.fillText(
            additionalCount > 0 ? `${compactLabel} +${additionalCount}` : compactLabel,
            (from.x + to.x) / 2,
            (from.y + to.y) / 2 - 4,
          )
        }
      }

      for (const node of nodesRef.current) {
        const role = ['protagonist', 'antagonist', 'supporting', 'minor'].includes(node.role) ? node.role : 'minor'
        const color = canvasStyles.getPropertyValue(`--color-role-${role}`).trim()
          || canvasStyles.getPropertyValue('--color-text-secondary').trim()
        const radius = nodeRadius(node)
        context.beginPath()
        context.arc(node.x, node.y, radius + 8, 0, Math.PI * 2)
        context.fillStyle = color + '25'
        context.fill()
        context.beginPath()
        context.arc(node.x, node.y, radius, 0, Math.PI * 2)
        context.fillStyle = color + '40'
        context.fill()
        const avatar = avatarImagesRef.current.get(node.characterId)
        if (avatar?.complete) {
          context.save()
          context.beginPath()
          context.arc(node.x, node.y, radius - 2, 0, Math.PI * 2)
          context.clip()
          context.drawImage(avatar, node.x - radius, node.y - radius, radius * 2, radius * 2)
          context.restore()
        }
        context.beginPath()
        context.arc(node.x, node.y, radius, 0, Math.PI * 2)
        context.strokeStyle = color
        context.lineWidth = node.characterId === graph.centerId ? 4 : 2
        context.stroke()
        context.font = 'bold 22px system-ui'
        context.fillStyle = readableTextColor
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(compactOverviewLabel(node.name, NODE_LABEL_MAX_CHARACTERS), node.x, node.y + radius + 16)
        if (duplicateNames.has(node.name)) {
          context.font = '10px sans-serif'
          context.fillText(node.characterId.slice(-8), node.x, node.y + radius + 29)
        }
      }
      context.restore()
    }
    drawRef.current = drawFrame
    drawFrame()

    const themeObserver = new MutationObserver(drawFrame)
    const skinRoot = canvas.closest<HTMLElement>('.app-skin-root')
    for (const root of new Set<HTMLElement>([document.documentElement, ...(skinRoot ? [skinRoot] : [])])) {
      themeObserver.observe(root, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-skin', 'data-skin-readability'],
      })
    }
    return () => { themeObserver.disconnect(); drawRef.current = null }
  }, [characters, duplicateNames, graph, canvasSize])

  const updateZoom = (nextScale: number) => {
    const scale = Math.min(2, Math.max(0.5, Math.round(nextScale * 10) / 10))
    viewRef.current.scale = scale
    setZoomPercent(Math.round(scale * 100))
    drawRef.current?.()
  }
  const fitView = () => {
    const canvas = canvasRef.current
    const nodes = nodesRef.current
    if (!canvas || nodes.length === 0) return
    const padding = 40
    const bounds = nodes.reduce((result, node) => {
      const extent = nodeRadius(node) + 8
      return {
        minX: Math.min(result.minX, node.x - extent),
        maxX: Math.max(result.maxX, node.x + extent),
        minY: Math.min(result.minY, node.y - extent),
        maxY: Math.max(result.maxY, node.y + extent),
      }
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
    const scale = Math.min(2, Math.max(0.1, Math.min(
      (canvas.width - padding * 2) / Math.max(1, bounds.maxX - bounds.minX),
      (canvas.height - padding * 2) / Math.max(1, bounds.maxY - bounds.minY))))
    viewRef.current = {
      scale,
      offsetX: scale * (canvas.width / 2 - (bounds.minX + bounds.maxX) / 2),
      offsetY: scale * (canvas.height / 2 - (bounds.minY + bounds.maxY) / 2),
    }
    setZoomPercent(Math.round(scale * 100))
    drawRef.current?.()
  }
  const resetLayout = () => {
    nodesRef.current = graph.nodes.map(node => ({ ...node }))
    fitView()
  }

  if (characters.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">{text('暂无角色数据', 'No character data')}</div>
  }

  const characterById = new Map(characters.flatMap(character => (
    character.characterId ? [[character.characterId, character] as const] : []
  )))
  const labelFor = (id: string) => {
    const character = characterById.get(id)
    return character ? `${character.name}${duplicateNames.has(character.name) ? ` · ${id.slice(-8)}` : ''}` : ''
  }
  const relationshipDetails = graph.edges.flatMap(edge => edge.relations).map(relation => text(
    `${labelFor(relation.from)} 对 ${labelFor(relation.to)}：${relation.label}`,
    `${labelFor(relation.from)} to ${labelFor(relation.to)}: ${relation.label}`,
  )).join(text('；', '; '))
  const graphLabel = relationshipDetails
    ? text(`角色关系图谱。完整关系：${relationshipDetails}`, `Character relationship graph. Full relationships: ${relationshipDetails}`)
    : text('角色关系图谱', 'Character relationship graph')

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredCharacters = characters.filter(character => (
    character.characterId && (!normalizedQuery || character.name.toLocaleLowerCase().includes(normalizedQuery))
  ))
  const pageCount = Math.max(1, Math.ceil(filteredCharacters.length / SIDEBAR_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageCharacters = filteredCharacters.slice(safePage * SIDEBAR_PAGE_SIZE, (safePage + 1) * SIDEBAR_PAGE_SIZE)
  const centerName = graph.centerId ? characterById.get(graph.centerId)?.name : undefined

  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border px-1 py-1" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel)', color: 'var(--color-text)' }}>
          <span className="max-w-32 truncate px-1 text-[11px]" title={centerName}>{text('中心', 'Center')}: {centerName}</span>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-hover)]" aria-label={text('缩小关系图谱', 'Zoom out of character graph')} onClick={() => updateZoom(viewRef.current.scale - 0.1)}><ZoomOut size={14} aria-hidden="true" /></button>
          <span className="min-w-10 text-center text-[11px] tabular-nums">{zoomPercent}%</span>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-hover)]" aria-label={text('放大关系图谱', 'Zoom in to character graph')} onClick={() => updateZoom(viewRef.current.scale + 0.1)}><ZoomIn size={14} aria-hidden="true" /></button>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-hover)]" aria-label={text('适合视图', 'Fit character graph to view')} onClick={fitView}><Maximize2 size={14} aria-hidden="true" /></button>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-hover)]" aria-label={text('重置图谱布局', 'Reset character graph layout')} onClick={resetLayout}><RotateCcw size={14} aria-hidden="true" /></button>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-hover)]" aria-label={text(sidebarOpen ? '折叠人物侧栏' : '展开人物侧栏', sidebarOpen ? 'Collapse character sidebar' : 'Expand character sidebar')} onClick={() => setSidebarOpen(open => !open)}>{sidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}</button>
        </div>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={graphLabel}
          data-rendered-node-count={graph.nodes.length}
          className="h-full w-full cursor-grab active:cursor-grabbing"
          style={{ background: 'transparent', color: 'var(--color-text)' }}
          onWheel={(event) => { event.preventDefault(); updateZoom(viewRef.current.scale + (event.deltaY < 0 ? 0.1 : -0.1)) }}
          onPointerDown={(event) => {
            const point = pointerWorldPosition(event.currentTarget, event.clientX, event.clientY, viewRef.current)
            const node = nodesRef.current.find(candidate => (
              (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2 <= (nodeRadius(candidate) + 8) ** 2
            ))
            dragRef.current = node
              ? { kind: 'node', characterId: node.characterId, offsetX: node.x - point.x, offsetY: node.y - point.y, startX: event.clientX, startY: event.clientY, moved: false }
              : { kind: 'view', x: event.clientX, y: event.clientY }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag) return
            if (drag.kind === 'node') {
              const node = nodesRef.current.find(candidate => candidate.characterId === drag.characterId)
              if (!node) return
              const point = pointerWorldPosition(event.currentTarget, event.clientX, event.clientY, viewRef.current)
              node.x = Math.max(40, Math.min(event.currentTarget.width - 40, point.x + drag.offsetX))
              node.y = Math.max(40, Math.min(event.currentTarget.height - 40, point.y + drag.offsetY))
              drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3
              drawRef.current?.()
              return
            }
            const pixelRatio = event.currentTarget.width / Math.max(event.currentTarget.clientWidth, 1)
            viewRef.current.offsetX += (event.clientX - drag.x) * pixelRatio
            viewRef.current.offsetY += (event.clientY - drag.y) * pixelRatio
            dragRef.current = { kind: 'view', x: event.clientX, y: event.clientY }
            drawRef.current?.()
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current
            dragRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
            if (drag?.kind === 'node' && !drag.moved) onOpenCharacter?.(drag.characterId)
          }}
          onPointerCancel={() => { dragRef.current = null }}
        />
      </div>
      {sidebarOpen && (
        <aside className="flex w-56 flex-shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)]" aria-label={text('图谱人物侧栏', 'Graph character sidebar')}>
          <div className="relative border-b border-[var(--color-border)] p-2">
            <Search size={12} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setPage(0) }} aria-label={text('搜索图谱人物', 'Search graph characters')} placeholder={text('搜索人物', 'Search characters')} className="h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] pl-7 pr-2 text-xs text-[var(--color-text)]" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {pageCharacters.map(character => (
              <div key={character.characterId} className="mb-0.5 flex items-center gap-1 rounded hover:bg-[var(--color-hover)]">
                <button type="button" className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-[var(--color-text)]" data-graph-character-id={character.characterId} onClick={() => onOpenCharacter?.(character.characterId!)}>{character.name || text('未命名', 'Untitled')}{duplicateNames.has(character.name) ? ` · ${character.characterId?.slice(-8)}` : ''}</button>
                <button type="button" className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-active)]" aria-label={text(`以${character.name}为中心`, `Center graph on ${character.name}`)} onClick={() => { setCenterId(character.characterId!); fitView() }}><Crosshair size={13} /></button>
              </div>
            ))}
            {pageCharacters.length === 0 && <div className="p-3 text-center text-xs text-[var(--color-text-muted)]">{text('没有匹配的人物', 'No matching characters')}</div>}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--color-border)] p-1 text-[11px] text-[var(--color-text-secondary)]">
            <button type="button" className="rounded p-1 disabled:opacity-30" aria-label={text('上一页人物', 'Previous character page')} disabled={safePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={14} /></button>
            <span>{safePage + 1} / {pageCount} · {filteredCharacters.length}</span>
            <button type="button" className="rounded p-1 disabled:opacity-30" aria-label={text('下一页人物', 'Next character page')} disabled={safePage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}><ChevronRight size={14} /></button>
          </div>
        </aside>
      )}
    </div>
  )
}
