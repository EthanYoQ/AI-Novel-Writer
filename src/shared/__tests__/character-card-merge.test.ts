/**
 * 「追加」语义的边界测试。
 *
 * 先生要的是「往原设定里加新内容」，不是换掉原来的 —— 所以追加必须既能合并，
 * 又不会在反复合并时把同一段话堆成好几份。
 */
import { describe, expect, it } from 'vitest'

import { appendFieldText, appendRelationshipEdges } from '../character-card-merge'

describe('appendFieldText', () => {
  it('把新内容接在原内容后面，用换行隔开', () => {
    expect(appendFieldText('清冷孤傲', '对创造者极度忠诚')).toBe('清冷孤傲\n对创造者极度忠诚')
  })

  it('原内容为空时直接采用新内容', () => {
    expect(appendFieldText('', '新设定')).toBe('新设定')
    expect(appendFieldText('原设定', '')).toBe('原设定')
  })

  it('已经包含新内容时不重复堆叠', () => {
    const merged = appendFieldText('清冷孤傲\n对创造者极度忠诚', '对创造者极度忠诚')

    expect(merged).toBe('清冷孤傲\n对创造者极度忠诚')
  })

  it('反复追加同一张卡不会越堆越长', () => {
    const once = appendFieldText('甲', '乙')
    const twice = appendFieldText(once, '乙')
    const thrice = appendFieldText(twice, '乙')

    expect(twice).toBe('甲\n乙')
    expect(thrice).toBe('甲\n乙')
  })

  it('新内容覆盖了原内容时取更完整的一侧', () => {
    expect(appendFieldText('旧设定', '旧设定，另有新增的补充')).toBe('旧设定，另有新增的补充')
  })
})

describe('appendRelationshipEdges', () => {
  it('合并两侧关系并去掉完全重复的边', () => {
    const before = [{ target: '岛崎刹那', relation: '创造者' }]
    const after = [
      { target: '岛崎刹那', relation: '创造者' },
      { target: '席利乌斯', relation: '宿敌' },
    ]

    expect(appendRelationshipEdges(before, after)).toEqual([
      { target: '岛崎刹那', relation: '创造者' },
      { target: '席利乌斯', relation: '宿敌' },
    ])
  })

  it('同目标但关系说明不同时两条都保留', () => {
    const before = [{ target: '岛崎刹那', relation: '创造者' }]
    const after = [{ target: '岛崎刹那', relation: '唯一的牵挂' }]

    expect(appendRelationshipEdges(before, after)).toHaveLength(2)
  })
})
