import { describe, expect, it } from 'vitest'

import { parseRelationshipEdges } from '../relationship-presentation'
import {
  buildRelationEdges,
  buildRelationshipGraph,
  layoutRelationGraph,
  relationDistances,
  relationImportance,
  relationOpacityForDistance,
  relationTier,
  type RelationEdge,
} from '../relationship-graph'

const edges: RelationEdge[] = [
  { from: '李莉莉', to: '林青檀', relation: '同学→好朋友' },
  { from: '李莉莉', to: '李子瞻', relation: '兄妹' },
  { from: '林青檀', to: '陈家旺', relation: '师徒' },
  { from: '陈家旺', to: '何川', relation: '旧识' },
]

describe('relation distances', () => {
  it('walks the graph breadth-first from the centre', () => {
    const distances = relationDistances('李莉莉', edges)
    expect(distances.get('李莉莉')).toBe(0)
    expect(distances.get('林青檀')).toBe(1)
    expect(distances.get('李子瞻')).toBe(1)
    expect(distances.get('陈家旺')).toBe(2)
    expect(distances.get('何川')).toBe(3)
  })

  it('omits characters that are not connected to the centre', () => {
    expect(relationDistances('李莉莉', edges).has('余思雨')).toBe(false)
    expect(relationDistances('', edges).size).toBe(0)
  })
})

describe('relation relevance', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 0.48],
    [3, 0.2],
    [9, 0.09],
  ])('maps distance %i to opacity %f', (dist, opacity) => {
    expect(relationOpacityForDistance(dist)).toBe(opacity)
  })
})

describe('relation importance', () => {
  it.each([
    ['父女', 94],
    ['母女 / 相依为命', 94],
    ['恋人', 95],
    ['青梅竹马 · 并肩作战', 95],
    ['宿敌', 88],
    ['嫉妒 / 仇敌', 88],
    ['几十年搭档 · 同学', 72],
    ['师生 / 保护', 72],
    ['家中帮佣', 44],
    ['一般同场', 44],
    ['说不上来的关系', 45],
    ['', 45],
  ])('scores “%s” as %i', (label, score) => {
    expect(relationImportance(label)).toBe(score)
  })

  it('scores family above hostility and hostility above servants', () => {
    expect(relationImportance('夫妻')).toBeGreaterThan(relationImportance('敌对'))
    expect(relationImportance('敌对')).toBeGreaterThan(relationImportance('家中帮佣'))
  })
})

describe('relation tiers', () => {
  it('always treats the viewport character as the main node', () => {
    expect(relationTier('李莉莉', '李莉莉', 0, '')).toBe('main')
  })

  it('promotes direct family, lovers, and nemeses to the second ring', () => {
    expect(relationTier('李莉莉', '李子瞻', 1, '兄妹')).toBe('important')
    expect(relationTier('李莉莉', '余思雨', 1, '宿敌')).toBe('important')
  })

  it('keeps ordinary direct ties as medium circles', () => {
    expect(relationTier('李莉莉', '郑素', 1, '堂表姐妹')).toBe('important')
    expect(relationTier('李莉莉', '王德海', 1, '小姐 / 司机 / 接送')).toBe('normal')
  })

  it('collapses everyone further away into satellites and dots', () => {
    expect(relationTier('李莉莉', '陈家旺', 2, '师徒')).toBe('satellite')
    expect(relationTier('李莉莉', '何川', 3, '旧识')).toBe('far')
    expect(relationTier('李莉莉', '余思雨', 99, '')).toBe('far')
  })
})

describe('layout', () => {
  const names = ['李莉莉', '林青檀', '李子瞻', '陈家旺', '何川', '余思雨']

  it('pins the viewport character to the canvas centre', () => {
    const nodes = layoutRelationGraph(names, edges, '李莉莉')
    expect(nodes.get('李莉莉')).toMatchObject({ x: 50, y: 50, tier: 'main', dist: 0 })
  })

  it('places direct relations inside the outer arc', () => {
    const nodes = layoutRelationGraph(names, edges, '李莉莉')
    const radiusOf = (name: string) => {
      const node = nodes.get(name)
      if (!node) throw new Error(`${name} missing`)
      return Math.hypot(node.x - 50, node.y - 50)
    }
    expect(radiusOf('林青檀')).toBeLessThan(radiusOf('陈家旺'))
    expect(radiusOf('陈家旺')).toBeLessThan(radiusOf('何川'))
  })

  it('falls back to the first character when the centre is unknown', () => {
    const nodes = layoutRelationGraph(names, edges, '查无此人')
    expect(nodes.get('李莉莉')).toMatchObject({ x: 50, y: 50, tier: 'main' })
  })

  it('keeps every node inside the draggable canvas bounds', () => {
    const many = Array.from({ length: 18 }, (_value, index) => `角色${index}`)
    const fanEdges: RelationEdge[] = many.slice(1).map(name => ({
      from: '角色0',
      to: name,
      relation: '同学',
    }))
    const nodes = layoutRelationGraph(many, fanEdges, '角色0')
    for (const node of nodes.values()) {
      expect(node.x).toBeGreaterThanOrEqual(7)
      expect(node.x).toBeLessThanOrEqual(93)
      expect(node.y).toBeGreaterThanOrEqual(9)
      expect(node.y).toBeLessThanOrEqual(91)
    }
  })

  it('returns nothing for an empty roster', () => {
    expect(layoutRelationGraph([], [], '').size).toBe(0)
  })
})

describe('undirected edges', () => {
  it('keeps one edge per pair and prefers the viewport character phrasing', () => {
    const result = buildRelationEdges('林墨', [
      {
        name: '林墨',
        relationships: JSON.stringify([{ target: '周砧', relation: '共同追查真相' }]),
      },
      {
        name: '周砧',
        relationships: JSON.stringify([{ target: '林墨', relation: '尊重她追查真相的勇气' }]),
      },
    ], parseRelationshipEdges)

    expect(result).toEqual([{ from: '林墨', to: '周砧', relation: '共同追查真相' }])
  })

  it('keeps the other side wording when the viewport character says nothing', () => {
    const result = buildRelationEdges('周砧', [
      { name: '林墨', relationships: JSON.stringify([{ target: '周砧', relation: '并肩作战' }]) },
      { name: '周砧', relationships: '' },
    ], parseRelationshipEdges)

    expect(result).toEqual([{ from: '林墨', to: '周砧', relation: '并肩作战' }])
  })

  it('ignores dangling targets and self references', () => {
    const result = buildRelationEdges('林墨', [
      {
        name: '林墨',
        relationships: JSON.stringify([
          { target: '林墨', relation: '自指' },
          { target: '不存在的人', relation: '悬空' },
        ]),
      },
    ], parseRelationshipEdges)

    expect(result).toEqual([])
  })
})

describe('graph model', () => {
  it('reports the resolved centre, roster, and node tier for the active viewport', () => {
    const model = buildRelationshipGraph([
      { name: '李莉莉', relationships: JSON.stringify([{ target: '李子瞻', relation: '兄妹' }]) },
      { name: '李子瞻', relationships: '' },
      { name: '王德海', relationships: JSON.stringify([{ target: '李莉莉', relation: '小姐 / 司机' }]) },
    ], '李莉莉', parseRelationshipEdges)

    expect(model.center).toBe('李莉莉')
    expect(model.names).toEqual(['李莉莉', '李子瞻', '王德海'])
    expect(model.nodes.get('李子瞻')?.tier).toBe('important')
    expect(model.nodes.get('王德海')?.tier).toBe('normal')
  })

  it('resolves an unknown centre to the first roster entry', () => {
    const model = buildRelationshipGraph([
      { name: '甲', relationships: '' },
      { name: '乙', relationships: '' },
    ], '丙', parseRelationshipEdges)

    expect(model.center).toBe('甲')
    expect(model.nodes.get('乙')?.tier).toBe('far')
  })

  it('handles a roster with no relationships at all', () => {
    const model = buildRelationshipGraph([
      { name: '甲', relationships: '' },
      { name: '乙', relationships: '' },
    ], '甲', parseRelationshipEdges)

    expect(model.edges).toEqual([])
    expect(model.nodes.get('甲')?.tier).toBe('main')
    expect(model.nodes.get('乙')).toMatchObject({ dist: 99, opacity: 0.09, tier: 'far' })
  })
})
