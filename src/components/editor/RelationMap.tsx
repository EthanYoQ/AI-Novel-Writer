import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ChevronRight, Maximize2, Minus, Plus, RotateCcw, Trash2, X } from 'lucide-react'

import { parseRelationshipEdges } from '../../shared/relationship-presentation'
import {
  buildRelationshipGraph,
  type RelationEdge,
  type RelationNode,
} from '../../shared/relationship-graph'
import { getCharacterRoleLabels } from '../../shared/character-role'
import { useLocaleStore } from '../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'
import PagePlate from '../layout/v2/magazine/PagePlate'
import { forceImportant } from '../layout/v2/magazine/force-important'
import { useCharacterAvatars } from './use-character-avatars'

/* ============================================================================
 * 人物关系图谱 · 视角权重化画布 + 右侧人物简介面板
 *
 * 结构与交互整体移植自设计 demo（AI小说家-Demo/novel-app-demo-relation-avatars.html）：
 *   · 版式与类名   relationView()（3544–3601 行）与 .relation-* 样式
 *   · 权重算法     relationDistances / relationImportance / relationTier
 *                  （见 shared/relationship-graph.ts）
 *   · 交互         bindRelationGraph / bindRelationWheel / relationZoom（3672–3790 行）
 *
 * 与 demo 的差异（都是产品化必需，不是取舍）：
 *   1. 空白处按住可拖动整个图谱 —— demo 只能缩放，先生要求能抓空白移动画布。
 *   2. 右侧简介面板可收起 / 展开 —— 收起后画布占满，顶栏留一个恢复入口。
 *   3. 头像来自产品自己的角色头像（character-avatar:read），没上传就用姓名首字 + 色调区分。
 * ========================================================================== */

/** 角色没有自定义头像时的默认底色：矿物颜料调色板，按名单顺序取色，同屏互不撞色。 */
const DEFAULT_AVATAR_COLORS = [
  '#C0712F', '#4A6B8A', '#6A7280', '#7B6A56', '#9B6C7E', '#6C6A74',
  '#6B5540', '#5B5F66', '#8A6A56', '#586A67', '#6C6257', '#5F6A70',
] as const

/** demo 3724–3725 行：拖动节点时的百分比夹取范围，与自动布局共享同一套边界。 */
const NODE_X_MIN = 7
const NODE_X_MAX = 93
const NODE_Y_MIN = 10
const NODE_Y_MAX = 91

/** demo relationZoom（3771–3778）：±0.10 一档，钳在 65%–155%。 */
const ZOOM_MIN = 0.65
const ZOOM_MAX = 1.55
const ZOOM_STEP = 0.1

/** 按下与松手之间超过这个像素就判定为「拖动」而不是「点击」。 */
const CLICK_SLOP = 5

/** 连线上的关系标签要短 —— 长句会把画布糊住，完整说法留给无障碍描述与右侧面板。 */
const EDGE_LABEL_MAX_CHARACTERS = 10

/** demo 3561–3563 行的标签截断思路（旧实现 compactOverviewLabel），按码点截断以免切开代理对。 */
function compactLabel(value: string): string {
  const characters = Array.from(value.trim())
  return characters.length > EDGE_LABEL_MAX_CHARACTERS
    ? `${characters.slice(0, EDGE_LABEL_MAX_CHARACTERS).join('')}…`
    : characters.join('')
}

export interface RelationMapCharacter {
  name: string
  role: string
  relationships: string
  age?: string
  background?: string
  personality?: string
}

export interface RelationMapProps {
  /** 全员角色卡 —— 图谱是角色名单的投影 */
  characters: readonly RelationMapCharacter[]
  /** 当前主视角人物 */
  center: string
  /** 点击某个圈圈：立刻切到他的视角 */
  onSelectCenter: (name: string) => void
  /** 「查看详细档案」：回到人物档案页 */
  onOpenProfile: (name: string) => void
  /** 清空全部角色与关系（产品的既有动作，不因换皮而消失） */
  onDeleteAll: () => void
  deleteAllDisabled: boolean
}

interface NodePosition {
  x: number
  y: number
}

type NodeDragState = {
  name: string
  pointerId: number
  rect: DOMRect
  startX: number
  startY: number
  baseX: number
  baseY: number
  moved: boolean
  pendingX: number
  pendingY: number
  frame: number
}

type CanvasPanState = {
  pointerId: number
  startX: number
  startY: number
  baseX: number
  baseY: number
}

/**
 * demo edgePathFor（3678–3685）：带一点弧度的二次贝塞尔，避免多条边叠成直线。 */
function edgeGeometry(from: NodePosition, to: NodePosition) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(8, Math.hypot(dx, dy))
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const bend = Math.min(3.2, Math.max(1.7, length * 0.045))
  const controlX = midX - (dy / length) * bend
  const controlY = midY + (dx / length) * bend
  return {
    d: `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`,
    labelX: controlX,
    labelY: controlY - 1.2,
  }
}

/** demo 3561–3562 行：连线透明度 —— 越贴近主视角越实。 */
function edgeOpacity(distanceA: number, distanceB: number): number {
  const nearest = Math.min(distanceA, distanceB)
  if (nearest === 0) return 1
  if (nearest === 1) return distanceA === 0 || distanceB === 0 ? 0.72 : 0.34
  if (nearest === 2) return 0.18
  return 0.07
}

/** demo 3572–3573 行：关系标签透明度，比连线更收敛一档。 */
function edgeLabelOpacity(distanceA: number, distanceB: number): number {
  const nearest = Math.min(distanceA, distanceB)
  if (nearest === 0) return 1
  if (nearest === 1) return 0.72
  if (nearest === 2) return 0.22
  return 0.06
}

/**
 * 连线样式：与主视角直接相连且属「家人 / 爱人 / 宿敌」这一档 → 朱砂实线；
 * 其余直接关系 → 黛绿；两端都在外圈（主视角看不见的隐线）→ 虚线。
 * 对应 demo 手工标注的 strong / soft / dash 三态。
 */
function edgeClass(edge: RelationEdge, nodes: Map<string, RelationNode>, center: string): string {
  const touchesCenter = edge.from === center || edge.to === center
  if (!touchesCenter) return 'dash'
  const other = edge.from === center ? nodes.get(edge.to) : nodes.get(edge.from)
  return other?.tier === 'important' ? 'strong' : 'soft'
}

export default function RelationMap({
  characters,
  center,
  onSelectCenter,
  onOpenProfile,
  onDeleteAll,
  deleteAllDisabled,
}: RelationMapProps) {
  const text = useLocaleStore((state) => state.text)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<NodeDragState | null>(null)
  const panRef = useRef<CanvasPanState | null>(null)

  const [sideOpen, setSideOpen] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [focusName, setFocusName] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, NodePosition>>({})
  const [draggingName, setDraggingName] = useState<string | null>(null)

  const characterByName = useMemo(() => {
    const index = new Map<string, RelationMapCharacter>()
    for (const character of characters) index.set(character.name, character)
    return index
  }, [characters])
  const rosterNames = useMemo(
    () => characters.map((character) => character.name),
    [characters],
  )

  /** 全员头像：复用 character-avatar:read，不新增任何主进程通道。 */
  const { avatarUrls } = useCharacterAvatars(rosterNames, true)

  /** 视角模型：BFS 距离 → 层级 / 透明度 / 坐标。 */
  const model = useMemo(
    () => buildRelationshipGraph(characters, center, parseRelationshipEdges),
    [characters, center],
  )

  // 换视角 / 换名单时重新排版（demo 的 layoutRelationGraph 每次换人都会重跑）。
  // 这里不能用派生替代：positions 是拖动后会被就地改写的命令式视图状态，且换视角
  // 必须同时把 zoom / pan / 焦点动画一起归位（原子重置），派生表达式做不到。
  useEffect(() => {
    const next: Record<string, NodePosition> = {}
    for (const node of model.nodes.values()) next[node.name] = { x: node.x, y: node.y }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 换视角/换名单时按新布局原子重置画布状态（见上）
    setPositions(next)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    if (!model.center) return undefined
    setFocusName(model.center)
    const timer = window.setTimeout(() => setFocusName(null), 600)
    return () => window.clearTimeout(timer)
  }, [model])

  const positionOf = useCallback(
    (name: string): NodePosition => {
      const stored = positions[name]
      if (stored) return stored
      const node = model.nodes.get(name)
      return node ? { x: node.x, y: node.y } : { x: 50, y: 50 }
    },
    [model, positions],
  )

  const roleLabelOf = useCallback(
    (role: string): string => {
      const labels = getCharacterRoleLabels(role)
      return text(labels.zhCN, labels.enUS)
    },
    [text],
  )

  const colorOf = useCallback((index: number) => (
    DEFAULT_AVATAR_COLORS[Math.max(0, index) % DEFAULT_AVATAR_COLORS.length]
  ), [])

  /* ---------------- 缩放 ---------------- */

  const applyZoomDelta = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return
    setZoom((current) => {
      const next = current + delta
      return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100))
    })
  }, [])

  // demo bindRelationWheel（3765–3768）：滚轮缩放必须 preventDefault，
  // 而 React 的合成 wheel 是被动监听，所以这里手动绑原生事件。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      applyZoomDelta(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [applyZoomDelta])

  /* ---------------- 节点拖动 ---------------- */

  const handleNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, name: string) => {
      if (event.button !== 0) return
      const canvas = canvasRef.current
      if (!canvas) return
      event.preventDefault()
      event.stopPropagation()

      const base = positionOf(name)
      dragRef.current = {
        name,
        pointerId: event.pointerId,
        rect: canvas.getBoundingClientRect(),
        startX: event.clientX,
        startY: event.clientY,
        baseX: base.x,
        baseY: base.y,
        moved: false,
        pendingX: base.x,
        pendingY: base.y,
        frame: 0,
      }
      setDraggingName(name)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 指针捕获失败时仍可拖动，只是离开元素会丢事件。
      }
    },
    [positionOf],
  )

  const handleNodePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const zoomNow = zoom || 1
    const dx = ((event.clientX - drag.startX) / Math.max(1, drag.rect.width)) * 100 / zoomNow
    const dy = ((event.clientY - drag.startY) / Math.max(1, drag.rect.height)) * 100 / zoomNow
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > CLICK_SLOP) {
      drag.moved = true
    }

    drag.pendingX = Math.max(NODE_X_MIN, Math.min(NODE_X_MAX, drag.baseX + dx))
    drag.pendingY = Math.max(NODE_Y_MIN, Math.min(NODE_Y_MAX, drag.baseY + dy))
    const name = drag.name
    if (drag.frame) return
    // 一个动画帧只写一次状态：连线与标签跟着走，但不会让 React 掉帧。
    drag.frame = window.requestAnimationFrame(() => {
      const active = dragRef.current
      if (!active || active.name !== name) return
      active.frame = 0
      setPositions((current) => ({
        ...current,
        [name]: { x: active.pendingX, y: active.pendingY },
      }))
    })
  }, [zoom])

  const endNodeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.frame) window.cancelAnimationFrame(drag.frame)
    const name = drag.name
    const wasClick = !drag.moved
    const settled = { x: drag.pendingX, y: drag.pendingY }
    dragRef.current = null
    setDraggingName(null)
    setPositions((current) => ({ ...current, [name]: settled }))
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 未捕获成功时无需释放。
    }
    if (wasClick) {
      // demo relationSelectNode（3657–3671）：点一下就是换视角。
      onSelectCenter(name)
      setFocusName(name)
      window.setTimeout(() => setFocusName(null), 600)
    }
  }, [onSelectCenter])

  const cancelNodeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.frame) window.cancelAnimationFrame(drag.frame)
    dragRef.current = null
    setDraggingName(null)
  }, [])

  /* ---------------- 空白处平移整个图谱 ---------------- */

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.relation-node')) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: pan.x,
      baseY: pan.y,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 同上：捕获失败不影响拖动。
    }
  }, [pan.x, pan.y])

  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panning = panRef.current
    if (!panning || panning.pointerId !== event.pointerId) return
    setPan({
      x: panning.baseX + (event.clientX - panning.startX),
      y: panning.baseY + (event.clientY - panning.startY),
    })
  }, [])

  const endCanvasPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const panning = panRef.current
    if (!panning || panning.pointerId !== event.pointerId) return
    panRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 忽略。
    }
  }, [])

  /* ---------------- 工具条动作 ---------------- */

  /** demo resetRelationGraph（3769）：重新排版 + 视图归位。 */
  const resetGraph = useCallback(() => {
    const next: Record<string, NodePosition> = {}
    for (const node of model.nodes.values()) next[node.name] = { x: node.x, y: node.y }
    setPositions(next)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    if (model.center) {
      setFocusName(model.center)
      window.setTimeout(() => setFocusName(null), 600)
    }
  }, [model])

  /** demo fitRelationGraph（3770）：只把视图恢复成 100%，尊重作者摆好的位置。 */
  const fitGraph = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  /* ---------------- 右侧面板数据 ---------------- */

  const selected = characterByName.get(model.center) ?? null
  const directRelations = useMemo(
    () => (selected
      ? parseRelationshipEdges(selected.relationships, {
        knownNames: rosterNames,
        selfName: selected.name,
      })
      : []),
    [rosterNames, selected],
  )
  const directCount = useMemo(
    () => Array.from(model.nodes.values()).filter((node) => node.dist === 1).length,
    [model],
  )
  /**
   * 界面版本（v3 关系图谱的「无感背景」与方形头像走内联样式）。
   *
   * 为什么这一页要用内联样式、而不是 mag 层的 CSS：
   * v2 的图谱装帧当年为了压过 demo 基座，**大量使用 `!important` + 深层选择器**。
   * 实测在 mag 层写 `!important`、写更长的选择器、甚至换成 v3 自己的类名（`mg-*`）
   * **都压不过它** —— `.relation-canvas` 的背景、`.portrait` 的圆角都栽在这里。
   * 内联样式是这条赛道上唯一确定有效的手段，而且天然分家：
   * v2 拿到的是 `undefined`，一个字都不变。
   */
  const uiVersion = useUiVersionStore((s) => s.uiVersion)
  const magazine = isMagazine(uiVersion)
  const selectedAvatar = selected ? avatarUrls[selected.name] : undefined
  const selectedColor = colorOf(rosterNames.indexOf(model.center))

  if (characters.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
        {text('暂无角色数据', 'No character data')}
      </div>
    )
  }

  const relationshipSummary = model.edges
    .map(edge => text(
      `${edge.from} 对 ${edge.to}：${edge.relation}`,
      `${edge.from} to ${edge.to}: ${edge.relation}`,
    ))
    .join(text('；', '; '))
  const canvasLabel = relationshipSummary
    ? text(
      `角色关系图谱。完整关系：${relationshipSummary}`,
      `Character relationship graph. Full relationships: ${relationshipSummary}`,
    )
    : text('角色关系图谱', 'Character relationship graph')

  const stageStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
  }

  return (
    <div className={sideOpen ? 'relation-view' : 'relation-view relation-view-full'}>
      {/* 页头与「人物档案」等子菜单同源：同一个 PageHead 组件 + 同一个 .pagehead-strip
          容器，所以眉标 / 标题 / 说明的字体、字号、字重、位置天然一致；按钮也换成
          产品统一的 .btn，Y 轴高度由 .pagehead-strip 统一拉平。
          它横跨画布与右侧简介两列（grid-area: head，见 v2-relation.css）。 */}
      <div className="pagehead-strip">
        <PagePlate
          section="characters"
          /* 期刊化读数：这一栏里已建档的人数；下面一行是关系的实际规模 */
          metric={{ label: text('人物', 'CAST'), value: String(model.nodes.size) }}
          facts={text(
            `${model.edges.length} 条关系 · 直接相连 ${directCount} 位`,
            `${model.edges.length} links · ${directCount} directly connected`,
          )}
          kicker={text('CAST · 人物关系图谱', 'CAST · RELATIONSHIP MAP')}
          title={text('人物关系图谱', 'Character relationship graph')}
          /* 先生：标头里被当作中心的那个人名要用**主题色**（默认主题即朱砂红）。
             颜色走 --seal，换主题自动跟随；不用 text() 是因为要局部上色，
             而 text() 只能返回整串文本。 */
          descriptionRich={{
            zhCN: (
              <>
                以「<span className="ph-em">{model.center}</span>」为中心 · 关系越重要，人物越接近、越清晰
              </>
            ),
            enUS: (
              <>
                Centred on &quot;<span className="ph-em">{model.center}</span>&quot; · the closer the bond, the nearer and clearer the circle
              </>
            ),
          }}
          actions={(
            /* 按钮一律用 demo 的 .relation-tools / .relation-tool（无边框浅色文字按钮，
               悬浮转朱砂）—— 先生：这几个按钮就该是 demo 的样子，不要换成产品的
               .btn。位置仍守在画布列内，不越过右侧简介栏。 */
            <div className="relation-tools">
              {!sideOpen && (
                <button
                  type="button"
                  className="relation-tool"
                  onClick={() => setSideOpen(true)}
                  title={text('展开人物简介', 'Show the character panel')}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                  {text('人物简介', 'Character panel')}
                </button>
              )}
              <button
                type="button"
                className="relation-tool"
                onClick={resetGraph}
                title={text('重新排版并把视图归位', 'Re-layout and reset the view')}
              >
                <RotateCcw size={12} aria-hidden="true" />
                {text('重置', 'Reset')}
              </button>
              <button
                type="button"
                className="relation-tool"
                onClick={fitGraph}
                title={text('缩放恢复到 100%，保留你摆好的位置', 'Restore 100% zoom and keep your layout')}
              >
                <Maximize2 size={12} aria-hidden="true" />
                {text('适应', 'Fit')}
              </button>
              <button
                type="button"
                className="relation-tool is-danger"
                onClick={onDeleteAll}
                disabled={deleteAllDisabled}
                title={text('清空图谱会删除作为事实源的全部角色', 'Clearing the graph deletes every character in the source roster')}
              >
                <Trash2 size={12} aria-hidden="true" />
                {/* 文案走 v3 分支：v2「墨纸书斋」与 v1 经典界面仍是原来那句长的
                    （先生的原则：不要因为 v3 的需要去改 v2/v1 的东西） */}
                {magazine
                  ? text('清空图谱', 'Clear graph')
                  : text('删除全部角色与关系', 'Delete all characters and relationships')}
              </button>
            </div>
          )}
        />
      </div>

      <main className="relation-main">
        <div
          className="relation-canvas mg-graph-canvas"
          /* 无感背景：与页面同底（v2 的金色光晕 + 四角暗角 + 内缩红框全部让位）。
             这里与画布自己的 ref 合并成一个回调 —— 一个元素只能有一个 ref。
             v2 那条背景带 !important，而 React 的 style 对象不支持 !important，
             所以只能走 `setProperty(..., 'important')`（见 forceImportant 的说明）。 */
          ref={(element) => {
            canvasRef.current = element
            if (magazine && element) {
              element.style.setProperty('background', 'transparent', 'important')
            }
          }}
          role="img"
          aria-label={canvasLabel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
        >
          <div className="relation-stage" style={stageStyle}>
            <svg className="relation-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {model.edges.map((edge) => {
                const geometry = edgeGeometry(positionOf(edge.from), positionOf(edge.to))
                return (
                  <path
                    key={`${edge.from}|${edge.to}`}
                    className={`relation-edge ${edgeClass(edge, model.nodes, model.center)}`}
                    d={geometry.d}
                    style={{
                      opacity: edgeOpacity(
                        model.nodes.get(edge.from)?.dist ?? 99,
                        model.nodes.get(edge.to)?.dist ?? 99,
                      ),
                    }}
                  />
                )
              })}
            </svg>

            {model.edges.map((edge) => {
              const geometry = edgeGeometry(positionOf(edge.from), positionOf(edge.to))
              return (
                <div
                  key={`label-${edge.from}|${edge.to}`}
                  className="relation-edge-label-html"
                  style={{
                    left: `${geometry.labelX}%`,
                    top: `${geometry.labelY}%`,
                    opacity: edgeLabelOpacity(
                      model.nodes.get(edge.from)?.dist ?? 99,
                      model.nodes.get(edge.to)?.dist ?? 99,
                    ),
                  }}
                >
                  {compactLabel(edge.relation)}
                </div>
              )
            })}

            {model.names.map((name, index) => {
              const node = model.nodes.get(name)
              if (!node) return null
              const position = positionOf(name)
              const character = characterByName.get(name)
              const isMain = node.tier === 'main'
              const roleName = roleLabelOf(character?.role ?? '')
              const subtitle = isMain
                ? text(`主视角 · ${roleName}`, `Viewport · ${roleName}`)
                : roleName
              const avatarUrl = avatarUrls[name]
              const classNames = [
                'relation-node',
                /**
                 * v3 专属类名（2026-09-17）。
                 *
                 * 为什么不用 `.relation-node` 在 mag 层覆盖：
                 * v2 的图谱装帧当年为了压过 demo 基座，**大量使用 !important + 深层选择器**，
                 * 且真正的规则藏在打包后的级联里 —— 实测「mag 层写了 !important 也压不过」
                 * （`.portrait` 的圆角、`.relation-canvas` 的背景都栽在这里）。
                 * 与其在特异性上无休止地比下去，不如给 v3 一个自己的记号：
                 * 类名只增不改，v2 的 CSS 根本不认识它，两边从此不相干。
                 */
                'mg-graph-node',
                isMain ? 'main' : '',
                name === model.center ? 'selected' : '',
                draggingName === name ? 'dragging' : '',
                focusName === name ? 'relation-focus-in' : '',
              ].filter(Boolean).join(' ')

              return (
                <div
                  key={name}
                  className={classNames}
                  data-node={name}
                  data-depth={node.dist}
                  data-tier={node.tier}
                  style={{
                    left: `${position.x}%`,
                    top: `${position.y}%`,
                    '--rel-opacity': String(node.opacity),
                  } as CSSProperties}
                  onPointerDown={(event) => handleNodePointerDown(event, name)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={cancelNodeDrag}
                >
                  <div
                    className="portrait mg-node-portrait"
                    /* 印刷品是方的（见 forceImportant 的说明） */
                    ref={magazine ? forceImportant({
                      'border-radius': '0',
                      border: '2px solid var(--ink)',
                      background: 'var(--panel2)',
                      'box-shadow': 'none',
                    }) : undefined}
                  >
                    {avatarUrl
                      ? <img src={avatarUrl} alt="" draggable={false} />
                      : (
                        <span
                          className="mg-node-mark"
                          style={{ background: colorOf(index) }}
                          ref={magazine ? forceImportant({
                            'border-radius': '0',
                            'font-family': 'var(--mag-font-display)',
                            background: colorOf(index),
                            color: '#FFFFFF',
                          }) : undefined}
                        >
                          {(name.trim().slice(0, 1) || '?')}
                        </span>
                      )}
                  </div>
                  <div className="name">{name}</div>
                  <div className="role">{subtitle}</div>
                </div>
              )
            })}
          </div>

          {/*
            底部一条「页脚带」：左边图例、右边操作提示。
            先生（2026-09-17）：「核心/高亲密—重要关系—一般关系—隐线/远并…这些注释
            也互相拥挤，很难看。」原因是三样东西各自绝对定位在底部（图例左下、
            提示居中、缩放在右下），窄一点的窗口就会叠在一起。
            现在合成一条带子：图例靠左、提示靠右，缩放浮在带子上方 —— 三者不再抢位置。
          */}
          <div className="relation-foot">
            <div className="relation-legend">
              <span><i className="red" />{text('核心 / 高亲密', 'Core / closest')}</span>
              <span><i className="green" />{text('重要关系', 'Important tie')}</span>
              <span><i />{text('一般关系', 'Ordinary tie')}</span>
              <span><i className="dash" />{text('隐线 / 远关系', 'Hidden / distant')}</span>
            </div>

            <div className="relation-hint mg-graph-hint">
              {text(
                '人物越大关系越近 · 拖动人物整理 · 拖动空白移动 · 滚轮缩放',
                'Bigger means closer · drag a character to arrange · drag empty space to pan · scroll to zoom',
              )}
            </div>
          </div>

          <div
            className="relation-zoom"
            /* 缩放控件：直角 + 细线（v2 的圆角同样是 !important 锁着的）。
               再用 overflow: hidden 兜住里面几个按钮的圆角 —— 容器裁一刀，比逐个去压省事。 */
            ref={magazine ? forceImportant({
              'border-radius': '0',
              overflow: 'hidden',
              border: '1px solid var(--line2)',
              background: 'var(--paper)',
            }) : undefined}
          >
            <button
              type="button"
              onClick={() => applyZoomDelta(-ZOOM_STEP)}
              title={text('缩小', 'Zoom out')}
              aria-label={text('缩小关系图谱', 'Zoom out of character graph')}
            >
              <Minus size={12} aria-hidden="true" />
            </button>
            <button type="button" title={text('当前缩放', 'Current zoom')}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => applyZoomDelta(ZOOM_STEP)}
              title={text('放大', 'Zoom in')}
              aria-label={text('放大关系图谱', 'Zoom in to character graph')}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={fitGraph}
              title={text('重置缩放', 'Reset zoom')}
              aria-label={text('重置关系图谱缩放', 'Reset character graph zoom')}
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      </main>

      {sideOpen && (
        <aside className="relation-side">
          <div className="relation-character-panel">
            <div className="relation-character-top">
              <button
                type="button"
                className="rct-btn"
                onClick={() => setSideOpen(false)}
                title={text('收起人物简介', 'Hide the character panel')}
                aria-label={text('收起人物简介', 'Hide the character panel')}
              >
                <ChevronRight size={13} aria-hidden="true" />
              </button>
              <h2>{model.center}</h2>
              <button
                type="button"
                className="rct-btn"
                onClick={() => setSideOpen(false)}
                title={text('收起人物简介', 'Hide the character panel')}
                aria-label={text('收起人物简介', 'Hide the character panel')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>

            <div className="relation-character-body">
              <div className="relation-visual-head">
                <div
                  className="relation-visual-avatar mg-side-avatar"
                  /* 先生点名的两处问题：展开的副栏头像不该还是 v2 的圆、也不该是个光秃秃的方框。
                     现在它是一枚**肖像框**：直角 + 2px 墨线 + 右下角一枚栏目色角标
                     （与人物档案里的肖像框同一套语言）。
                     用 `forceImportant` 而不是 style 对象 —— v2 的圆角带 !important，
                     而 React 的 style 对象**不支持** !important（实测：写了等于没写）。 */
                  ref={magazine ? forceImportant({
                    'border-radius': '0',
                    border: '2px solid var(--ink)',
                  }) : undefined}
                >
                  {selectedAvatar
                    ? <img src={selectedAvatar} alt="" draggable={false} />
                    : (
                      <span
                        className="mg-avatar-initial"
                        style={{ background: selectedColor }}
                        ref={magazine ? forceImportant({
                          'border-radius': '0',
                          'font-family': 'var(--mag-font-display)',
                          color: '#FFFFFF',
                          background: selectedColor,
                        }) : undefined}
                      >
                        {(model.center.trim().slice(0, 1) || '?')}
                      </span>
                    )}
                  {magazine && <span className="mg-avatar-corner" aria-hidden="true" />}
                </div>
                <div className="relation-visual-meta">
                  <div className="identity">
                    {selected ? roleLabelOf(selected.role) : text('角色', 'Character')}
                  </div>
                  {selected?.personality?.trim()
                    ? <div className="quote">{selected.personality}</div>
                    : null}
                </div>
              </div>

              <section className="relation-panel-section">
                <h3>{text('基础信息', 'Basics')}</h3>
                <dl className="relation-info-grid">
                  <dt>{text('姓名', 'Name')}</dt>
                  <dd>{model.center}</dd>
                  <dt>{text('定位', 'Role')}</dt>
                  <dd>{selected ? roleLabelOf(selected.role) : text('角色', 'Character')}</dd>
                  <dt>{text('年龄', 'Age')}</dt>
                  <dd>{selected?.age?.trim() || '—'}</dd>
                  <dt>{text('关系', 'Ties')}</dt>
                  <dd>{text(`${directCount} 人`, `${directCount}`)}</dd>
                </dl>
              </section>

              <section className="relation-panel-section">
                <h3>{text('角色定位', 'Narrative position')}</h3>
                <p className="relation-role-copy">
                  {selected?.background?.trim()
                    || selected?.personality?.trim()
                    || text(
                      '此角色在故事中承担重要叙事位置，与主线和支线人物形成交织关系。',
                      'This character holds a narrative position woven through the main and side threads.',
                    )}
                </p>
              </section>

              <section className="relation-panel-section">
                <h3>{text('关键关系', 'Key relationships')}</h3>
                <div className="relation-key-list">
                  {directRelations.length === 0
                    ? <p className="relation-key-empty">{text('暂无明确关系记录', 'No recorded relationships yet')}</p>
                    : directRelations.map(relation => (
                      <div className="relation-key-item" key={`${relation.target}|${relation.relation}`}>
                        <div>
                          <b>{relation.target}</b> <span>{relation.relation}</span>
                        </div>
                      </div>
                    ))}
                </div>
              </section>

              <button
                type="button"
                className="relation-detail-btn"
                onClick={() => onOpenProfile(model.center)}
              >
                <span>{text('查看详细档案', 'Open full profile')}</span>
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}
