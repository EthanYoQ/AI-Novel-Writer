import { parseRelationshipEdges } from '../../shared/relationship-presentation'

export interface GraphCharacter {
  characterId?: string
  name: string
  role: string
  relationships: string
}

export interface GraphRelation {
  from: string
  to: string
  label: string
}

export interface GraphEdge {
  from: string
  to: string
  relations: GraphRelation[]
}

export interface GraphNode {
  characterId: string
  name: string
  role: string
  importance: 1 | 2 | 3 | 4 | 5
  x: number
  y: number
}

export const GRAPH_NODE_LIMIT = 80

export function buildRelationshipGraph(characters: readonly GraphCharacter[]) {
  const byId = new Map(characters.flatMap(character => (
    character.characterId ? [[character.characterId, character] as const] : []
  )))
  const idsByName = new Map<string, string[]>()
  for (const [id, character] of byId) {
    const ids = idsByName.get(character.name) ?? []
    ids.push(id)
    idsByName.set(character.name, ids)
  }

  const adjacency = new Map(Array.from(byId.keys(), id => [id, new Set<string>()]))
  const grouped = new Map<string, GraphEdge>()
  const relationKeys = new Set<string>()
  for (const [sourceId, character] of byId) {
    for (const relation of parseRelationshipEdges(character.relationships)) {
      const targetId = relation.targetCharacterId && byId.has(relation.targetCharacterId)
        ? relation.targetCharacterId
        : idsByName.get(relation.target)?.length === 1
          ? idsByName.get(relation.target)![0]
          : undefined
      if (!targetId || targetId === sourceId) continue
      adjacency.get(sourceId)!.add(targetId)
      adjacency.get(targetId)!.add(sourceId)
      const key = [sourceId, targetId].sort().join('\u0000')
      const edge = grouped.get(key) ?? { from: sourceId, to: targetId, relations: [] }
      const relationKey = `${sourceId}\u0000${targetId}\u0000${relation.relation}`
      if (!relationKeys.has(relationKey)) {
        relationKeys.add(relationKey)
        edge.relations.push({ from: sourceId, to: targetId, label: relation.relation })
      }
      grouped.set(key, edge)
    }
  }
  return { byId, adjacency, edges: Array.from(grouped.values()), idsByName }
}

export function layoutRelationshipWindow(
  characters: readonly GraphCharacter[],
  centerId: string | null,
  width: number,
  height: number,
  limit = GRAPH_NODE_LIMIT,
): { nodes: GraphNode[]; edges: GraphEdge[]; centerId: string | null } {
  const graph = buildRelationshipGraph(characters)
  const firstId = graph.byId.keys().next().value as string | undefined
  const actualCenter = centerId && graph.byId.has(centerId) ? centerId : firstId ?? null
  if (!actualCenter) return { nodes: [], edges: [], centerId: null }

  const distances = new Map([[actualCenter, 0]])
  const queue = [actualCenter]
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!
    for (const neighbour of graph.adjacency.get(id) ?? []) {
      if (distances.has(neighbour)) continue
      distances.set(neighbour, distances.get(id)! + 1)
      queue.push(neighbour)
    }
  }

  const orderedIds = [...queue]
  for (const id of graph.byId.keys()) if (!distances.has(id)) orderedIds.push(id)
  orderedIds.length = Math.min(orderedIds.length, Math.max(1, limit))

  const tiers = new Map<number, string[]>()
  for (const id of orderedIds) {
    const tier = Math.min(4, distances.get(id) ?? 4)
    const ids = tiers.get(tier) ?? []
    ids.push(id)
    tiers.set(tier, ids)
  }
  const centerX = width / 2
  const centerY = height / 2
  const radiusStep = Math.max(80, Math.min(width, height) / 10)
  const nodes: GraphNode[] = []
  let ring = 0
  for (let tier = 0; tier < 5; tier += 1) {
    const ids = tiers.get(tier) ?? []
    if (tier === 0) {
      const character = graph.byId.get(ids[0]!)!
      nodes.push({ characterId: ids[0]!, name: character.name, role: character.role,
        importance: 5, x: centerX, y: centerY })
      continue
    }
    for (let offset = 0; offset < ids.length;) {
      ring += 1
      const radius = ring * radiusStep
      const count = Math.min(ids.length - offset, Math.max(6, Math.floor(2 * Math.PI * radius / 90)))
      for (let index = 0; index < count; index += 1) {
        const id = ids[offset + index]!
        const character = graph.byId.get(id)!
        const angle = count === 1 ? -Math.PI / 2 : (index / count) * Math.PI * 2 - Math.PI / 2
        nodes.push({ characterId: id, name: character.name, role: character.role,
          importance: (5 - tier) as GraphNode['importance'],
          x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) })
      }
      offset += count
    }
  }
  const visible = new Set(orderedIds)
  return {
    nodes,
    edges: graph.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to)),
    centerId: actualCenter,
  }
}
