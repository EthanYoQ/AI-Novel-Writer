import { describe, expect, it } from 'vitest'

import {
  decodeBlueprintSemanticPayload,
  validateBlueprintSemanticItem,
} from '../blueprint-semantic-contract'

function validBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapterNumber: 1,
    title: '雨夜来信',
    role: '开篇建置',
    purpose: '让主角接下无法回避的委托',
    keyEvents: '主角收到失踪多年的兄长寄来的密信，并在信封夹层发现追踪器。',
    characters: ['林岚', '周砚'],
    relationships: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
    suspenseHook: '追踪器忽然亮起，显示信件刚从屋内发出。',
    ...overrides,
  }
}

describe('blueprint semantic contract', () => {
  it('decodes one complete blueprint and preserves its structured relationship facts', () => {
    expect(decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint()] },
      [1],
    )).toEqual([{
      chapterNumber: 1,
      title: '雨夜来信',
      role: '开篇建置',
      purpose: '让主角接下无法回避的委托',
      keyEvents: '主角收到失踪多年的兄长寄来的密信，并在信封夹层发现追踪器。',
      characters: ['林岚', '周砚'],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
      suspenseHook: '追踪器忽然亮起，显示信件刚从屋内发出。',
    }])
  })

  it.each([
    ['title', '标题'],
    ['role', '章节功能'],
    ['purpose', '核心目的'],
    ['keyEvents', '关键事件'],
    ['characters', '出场角色'],
    ['relationships', '角色关系'],
    ['suspenseHook', '悬念钩子'],
  ])('rejects a missing %s field instead of synthesizing a default', (field, label) => {
    const incomplete = validBlueprint()
    delete incomplete[field]

    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [incomplete] },
      [1],
    )).toThrow(label)
  })

  it('requires at least one valid, unique character name', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: [] })))
      .toMatch(/出场角色/u)
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: ['林岚', ' 林岚 '] })))
      .toMatch(/重复/u)
  })

  it('accepts an explicit empty relationship list but rejects malformed or dangling relationships', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ relationships: [] }))).toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '未出场者', relation: '追踪' }],
    }))).toMatch(/出场角色/u)
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '周砚', relation: '' }],
    }))).toMatch(/关系说明/u)
  })

  it('requires exact chapter coverage with no missing, extra, or duplicate chapter', () => {
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint({ chapterNumber: 3 })] },
      [1, 2],
    )).toThrow(/非目标章节：第 3 章/u)
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint()] },
      [1],
    )).toThrow(/重复章节/u)
  })
})
