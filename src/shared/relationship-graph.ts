/**
 * 关系图谱的几何与权重算法（纯函数，无 DOM、无 React）。
 *
 * 来源：设计 demo `AI小说家-Demo/novel-app-demo-relation-avatars.html` 的
 *       relationDistances / relationRelevance / relationImportance / relationTier /
 *       layoutRelationGraph（第 3358–3399、3612–3631 行）。
 *
 * 移植原则：
 *   · 「视角权重化」是这套图谱的灵魂 —— 以当前主视角人物为中心，按关系距离
 *     决定远近与透明度，而不是把所有人平均铺开。
 *   · 算法与 demo 逐条对齐，只做两处有据可依的适配（见下方「与 demo 的差异」）。
 *
 * 与 demo 的差异：
 *   1. 关系标签的关键词表补齐英文（产品是双语界面），中文表原样保留。
 *   2. 「宿敌 / 敌对 / 仇敌」一类对抗性关系由 demo 的中等档提升到次大圈圈：
 *      先生明确指出「和他关系密切的家人、爱人、宿敌等是次大圈圈」，
 *      宿敌在叙事上确实是主线级关系，收成中等圈会读不出张力。
 */

import type { RelationshipEdge } from './relationship-presentation'

/** 图谱内部使用的无向边：一条边 = 一对人物 + 一个关系标签。 */
export interface RelationEdge {
  from: string
  to: string
  relation: string
}

/** 节点在关系图谱里的亲疏层级（对应 demo 的 data-tier）。 */
export type RelationTier = 'main' | 'important' | 'normal' | 'satellite' | 'far'

export interface RelationNode {
  name: string
  /** 画布宽度百分比（0–100） */
  x: number
  /** 画布高度百分比（0–100） */
  y: number
  /** 与主视角人物的关系距离（0 = 本人，99 = 不可达） */
  dist: number
  tier: RelationTier
  /** 该距离对应的显示透明度 */
  opacity: number
  /** 与主视角人物的关系标签（主视角本人为空串） */
  label: string
}

export interface RelationshipGraphModel {
  /** 主视角人物（数据里不存在时回落到第一个角色） */
  center: string
  names: string[]
  /** 归一后的无向边（同一对人只留一条） */
  edges: RelationEdge[]
  nodes: Map<string, RelationNode>
}

/** demo relationRelevance（3373–3380）：越远越淡，但永不彻底消失。 */
export function relationOpacityForDistance(dist: number): number {
  if (dist === 0) return 1
  if (dist === 1) return 1
  if (dist === 2) return 0.48
  if (dist === 3) return 0.2
  return 0.09
}

/**
 * demo relationDistances（3358–3371）：从中心人物出发的 BFS 距离。
 * 不可达的人物不出现在结果里，调用方按「无穷远」处理。
 */
export function relationDistances(
  center: string,
  edges: readonly RelationEdge[],
): Map<string, number> {
  const distances = new Map<string, number>()
  if (!center) return distances

  distances.set(center, 0)
  const queue: string[] = [center]

  while (queue.length > 0) {
    const current = queue.shift() as string
    const currentDistance = distances.get(current) ?? 0
    for (const edge of edges) {
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : null
      if (!next || distances.has(next)) continue
      distances.set(next, currentDistance + 1)
      queue.push(next)
    }
  }

  return distances
}

/**
 * 关系重要度评分（demo relationImportance 3381–3392）。
 *
 * 关键词顺序即优先级：越早命中越「重」。同一段文本可能同时含「夫妻」与「利用」，
 * 家人 / 爱人优先 —— 与 demo 的 else-if 链完全一致。
 */
const FAMILY_RELATION = /父女|母女|父子|母子|兄妹|兄弟|姐妹|夫妻|夫妇|祖孙|堂表|叔侄|姑侄|舅甥|亲属|家人|亲人|father|mother|parent|sister|brother|sibling|spouse|husband|wife|daughter|son|cousin|family/i
const INTIMATE_RELATION = /好朋友|挚友|好友|挚爱|暗恋|爱慕|恋人|心上人|喜欢|结缘|并肩作战|守护|依赖|深厚|青梅竹马|lover|beloved|best friend|close friend|ally|devoted|trusted/i
const HOSTILE_RELATION = /敌对|宿敌|死敌|仇敌|妒恨|嫉妒|利用|同谋|纠缠|觊觎|宿命对手|对手|enemy|nemesis|rival|hostile|jealous|hatred|manipulat|exploit/i
const PARTNER_RELATION = /搭档|同学|同事|同行|师生|师长|师门|队友|队长|带学|partner|classmate|colleague|teammate|teacher|student|mentor|fellow/i
const DISTANT_RELATION = /后勤|家务|帮佣|司机|一般|同场|关联|未知|servant|maid|butler|driver|acquaintance|unknown|passing/i

/** 达到这个分数才算「次大圈圈」（demo 原本是 88）。 */
export const RELATION_IMPORTANCE_THRESHOLD = 88

export function relationImportance(label: string): number {
  if (!label) return 45
  if (FAMILY_RELATION.test(label)) return 94
  if (INTIMATE_RELATION.test(label)) return 95
  if (HOSTILE_RELATION.test(label)) return 88
  if (PARTNER_RELATION.test(label)) return 72
  if (DISTANT_RELATION.test(label)) return 44
  return 45
}

/**
 * demo relationTier（3393–3399）：只有「直接相连」才谈得上亲疏，
 * 距离 2 一律收束为小头像，更远则退成点。
 */
export function relationTier(
  center: string,
  name: string,
  dist: number,
  label: string,
): RelationTier {
  if (name === center) return 'main'
  if (dist === 1) {
    return relationImportance(label) >= RELATION_IMPORTANCE_THRESHOLD ? 'important' : 'normal'
  }
  return dist === 2 ? 'satellite' : 'far'
}

/**
 * 关系标签归一成无向边。
 *
 * 产品的存储是「每个角色各自记一份关系」，A→B 与 B→A 常常同时存在且文案不同，
 * 而图谱只需要一条连线 + 一个标签（demo 的 REL_EDGES 就是这个形态）。
 * 冲突时优先保留**主视角人物**的说法 —— 屏幕上讲的是他的关系网络。
 */
export function buildRelationEdges(
  center: string,
  characters: readonly { name: string; relationships: string }[],
  parseEdges: (
    value: string,
    options: { knownNames: string[]; selfName: string },
  ) => RelationshipEdge[],
): RelationEdge[] {
  const names = characters.map((character) => character.name)
  const byPair = new Map<string, RelationEdge & { centered: boolean }>()

  for (const character of characters) {
    for (const edge of parseEdges(character.relationships, {
      knownNames: names,
      selfName: character.name,
    })) {
      const key = [character.name, edge.target].sort().join('\u0000')
      const candidate = {
        from: character.name,
        to: edge.target,
        relation: edge.relation,
        centered: character.name === center,
      }
      const existing = byPair.get(key)
      // 已经记着主视角的说法就不再被别人的说法顶掉。
      if (existing && (existing.centered || !candidate.centered)) continue
      byPair.set(key, candidate)
    }
  }

  return Array.from(byPair.values()).map(({ from, to, relation }) => ({ from, to, relation }))
}

/**
 * demo layoutRelationGraph（3612–3631）：中心居中，直接关系绕内环，
 * 其余人物沿外弧收束。环形半径随人数微调，保证首屏稀疏可读。
 *
 * 坐标落在画布中部（内环半径 ≤ 34%、外环 ≤ 43%），因此拖动时的夹取范围
 * 与自动布局共享同一套边界，不会出现「一重排就跑出视野」的怪相。
 */
export function layoutRelationGraph(
  names: readonly string[],
  edges: readonly RelationEdge[],
  center: string,
): Map<string, RelationNode> {
  const known = names.filter(Boolean)
  const resolvedCenter = known.includes(center) ? center : (known[0] ?? '')
  const nodes = new Map<string, RelationNode>()
  if (!resolvedCenter) return nodes

  const distances = relationDistances(resolvedCenter, edges)
  const labelFor = (name: string): string => {
    if (name === resolvedCenter) return ''
    const edge = edges.find((candidate) => (
      (candidate.from === resolvedCenter && candidate.to === name)
      || (candidate.to === resolvedCenter && candidate.from === name)
    ))
    return edge?.relation ?? ''
  }

  const register = (name: string, x: number, y: number): void => {
    const dist = distances.get(name) ?? 99
    nodes.set(name, {
      name,
      x,
      y,
      dist,
      tier: relationTier(resolvedCenter, name, dist, labelFor(name)),
      opacity: relationOpacityForDistance(dist),
      label: labelFor(name),
    })
  }

  register(resolvedCenter, 50, 50)

  const neighbors = known.filter((name) => name !== resolvedCenter && distances.get(name) === 1)
  const outer = known.filter((name) => name !== resolvedCenter && distances.get(name) !== 1)

  const innerRadius = neighbors.length <= 4 ? 27 : neighbors.length <= 7 ? 30 : 34
  neighbors.forEach((name, index) => {
    const angle = ((-90 + index * (360 / Math.max(1, neighbors.length))) * Math.PI) / 180
    register(
      name,
      50 + innerRadius * Math.cos(angle),
      50 + innerRadius * 0.72 * Math.sin(angle),
    )
  })

  const outerRadius = neighbors.length <= 5 ? 41 : 43
  outer.forEach((name, index) => {
    const angle = ((-70 + index * (280 / Math.max(1, outer.length))) * Math.PI) / 180
    register(
      name,
      50 + outerRadius * Math.cos(angle),
      50 + outerRadius * 0.68 * Math.sin(angle),
    )
  })

  return nodes
}

/** 一次算好渲染所需的一切。 */
export function buildRelationshipGraph(
  characters: readonly { name: string; relationships: string }[],
  center: string,
  parseEdges: (
    value: string,
    options: { knownNames: string[]; selfName: string },
  ) => RelationshipEdge[],
): RelationshipGraphModel {
  const names = characters.map((character) => character.name).filter(Boolean)
  const resolvedCenter = names.includes(center) ? center : (names[0] ?? '')
  const edges = buildRelationEdges(resolvedCenter, characters, parseEdges)
  return {
    center: resolvedCenter,
    names,
    edges,
    nodes: layoutRelationGraph(names, edges, resolvedCenter),
  }
}
