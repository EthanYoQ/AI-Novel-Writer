import { describe, expect, it } from 'vitest'

import {
  decodeBlueprintSemanticPayload,
  blueprintSemanticGenerationContract,
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../blueprint-semantic-contract'
import { StructuredContractDiagnostic } from '../structured-contract-diagnostic'

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
      newCharacterCandidates: [],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
      suspenseHook: '追踪器忽然亮起，显示信件刚从屋内发出。',
    }])
  })

  it('accepts one direct or fenced JSON root but rejects narrative prefix extraction', () => {
    const payload = JSON.stringify({ blueprints: [validBlueprint()] })
    expect(parseBlueprintSemanticResponseText(payload, [1])).toHaveLength(1)
    expect(parseBlueprintSemanticResponseText(`\`\`\`json\n${payload}\n\`\`\``, [1])).toHaveLength(1)
    expect(() => parseBlueprintSemanticResponseText(`以下是结果：\n${payload}`, [1]))
      .toThrow(/code=invalid_envelope path=\$/u)
    expect(() => parseBlueprintSemanticResponseText(`${payload}\n补充说明`, [1]))
      .toThrow(/code=invalid_json path=\$/u)
  })

  it.each([
    ['title', '标题'],
    ['role', '章节功能'],
    ['purpose', '核心目的'],
    ['keyEvents', '关键事件'],
    ['characters', '出场角色'],
    ['relationships', '角色关系'],
    ['suspenseHook', '悬念钩子'],
  ])('rejects a missing %s field instead of synthesizing a default', (field) => {
    const incomplete = validBlueprint()
    delete incomplete[field]

    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [incomplete] },
      [1],
    )).toThrow(`code=missing_field path=blueprints[0].${field}`)
  })

  it.each([
    ['relationships', undefined, 'missing_field', 'blueprints[0].relationships'],
    ['characters', '林岚、周砚', 'invalid_type', 'blueprints[0].characters'],
    ['role', { label: '发展' }, 'invalid_type', 'blueprints[0].role'],
    ['keyEvents', ' ', 'empty_value', 'blueprints[0].keyEvents'],
    ['keyEvents', '事'.repeat(1_201), 'value_too_long', 'blueprints[0].keyEvents'],
    ['suspenseHook', undefined, 'missing_field', 'blueprints[0].suspenseHook'],
  ])('reports a sanitized typed diagnostic for likely model shape at %s', (field, value, code, path) => {
    const candidate = validBlueprint()
    if (value === undefined) delete candidate[field]
    else candidate[field] = value

    const failure = (() => {
      try {
        decodeBlueprintSemanticPayload({ blueprints: [candidate] }, [1])
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(StructuredContractDiagnostic)
    expect(failure).toMatchObject({ code, path, field })
    if (code === 'value_too_long') {
      expect(failure).toMatchObject({ actualCharacters: 1_201, maxCharacters: 1_200 })
    }
    expect((failure as Error).message).not.toContain(JSON.stringify(value))
  })

  it('requires at least one valid, unique character name', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: [] })))
      .toContain('code=invalid_value path=blueprint.characters')
    expect(validateBlueprintSemanticItem(validBlueprint({ characters: ['林岚', ' 林岚 '] })))
      .toContain('code=duplicate_item path=blueprint.characters')
  })

  it('rejects semantically unbounded prose and lists even when the JSON shape is valid', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ role: 'r'.repeat(120) })))
      .toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({ role: 'r'.repeat(121) })))
      .toContain('code=value_too_long path=blueprint.role')
    expect(validateBlueprintSemanticItem(validBlueprint({ purpose: 'p'.repeat(240) })))
      .toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({ purpose: 'p'.repeat(241) })))
      .toContain('code=value_too_long path=blueprint.purpose')
    expect(validateBlueprintSemanticItem(validBlueprint({ keyEvents: '事'.repeat(1_200) })))
      .toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({ keyEvents: '事'.repeat(1_201) })))
      .toContain('code=value_too_long path=blueprint.keyEvents field=keyEvents actualCharacters=1201 maxCharacters=1200')
    expect(validateBlueprintSemanticItem(validBlueprint({
      characters: Array.from({ length: 13 }, (_, index) => `角色${index}`),
      relationships: [],
    }))).toContain('code=invalid_value path=blueprint.characters')
    expect(validateBlueprintSemanticItem(validBlueprint({
      characters: ['林岚', '周砚'],
      relationships: Array.from({ length: 9 }, () => ({
        from: '林岚',
        to: '周砚',
        relation: '不同事件中的临时盟友',
      })),
    }))).toContain('code=invalid_value path=blueprint.relationships')
  })

  it('accepts an explicit empty relationship list but rejects malformed or dangling relationships', () => {
    expect(validateBlueprintSemanticItem(validBlueprint({ relationships: [] }))).toBeUndefined()
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '未出场者', relation: '追踪' }],
    }))).toContain('code=relationship_endpoint_not_in_characters path=blueprint.relationships[0]')
    expect(validateBlueprintSemanticItem(validBlueprint({
      relationships: [{ from: '林岚', to: '周砚', relation: '' }],
    }))).toContain('code=empty_value path=blueprint.relationships[0].relation')
  })

  it('defaults omitted candidates and validates explicit recurring candidates', () => {
    expect(decodeBlueprintSemanticPayload({ blueprints: [validBlueprint()] }, [1])[0]
      .newCharacterCandidates).toEqual([])
    expect(decodeBlueprintSemanticPayload({
      blueprints: [validBlueprint({
        newCharacterCandidates: [{ name: '周砚', role: 'supporting' }],
      })],
    }, [1])[0].newCharacterCandidates).toEqual([{ name: '周砚', role: 'supporting' }])
    expect(validateBlueprintSemanticItem(validBlueprint({
      newCharacterCandidates: [{ name: '未出场者', role: 'supporting' }],
    }))).toContain('code=invalid_value path=blueprint.newCharacterCandidates[0].name')
    expect(validateBlueprintSemanticItem(validBlueprint({
      newCharacterCandidates: [{ name: '周砚', role: 'guest-star' }],
    }))).toContain('code=invalid_value path=blueprint.newCharacterCandidates[0].role')
    expect(blueprintSemanticGenerationContract('zh-CN')).toContain('一次性路人不得声明为候选')
    expect(blueprintSemanticGenerationContract('en-US')).toContain('never include incidental figures')
  })

  it.each([
    [
      { from: '林岚', to: '林岚', relation: '内心冲突' },
      'relationship_self_reference',
    ],
    [
      { from: '林岚', to: '周砚（化名）', relation: '追踪' },
      'relationship_endpoint_not_in_characters',
    ],
  ])('reports a stable sanitized relationship diagnostic without normalizing endpoints', (relationship, code) => {
    const failure = (() => {
      try {
        decodeBlueprintSemanticPayload({
          blueprints: [validBlueprint({ relationships: [relationship] })],
        }, [1])
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(StructuredContractDiagnostic)
    expect(failure).toMatchObject({
      code,
      path: 'blueprints[0].relationships[0]',
      field: 'relationships',
    })
    expect((failure as Error).message).not.toContain(relationship.to)
  })

  it('tells generators to copy exact character endpoints and omit unsupported relations', () => {
    const contract = blueprintSemanticGenerationContract('zh-CN')
    expect(contract).toContain('from/to 必须逐字复制同一项 characters 中的完整字符串')
    expect(contract).toContain('任一端点不在 characters 时，删除该关系或使用 []')
    expect(contract).toContain('不得发明别名')
  })

  it('requires generators to emit a concrete suspense hook even without a mystery', () => {
    expect(blueprintSemanticGenerationContract('en-US'))
      .toContain('suspenseHook is always required')
    expect(blueprintSemanticGenerationContract('zh-CN'))
      .toContain('suspenseHook 始终必填')
  })

  it('gives key events a concise target below the hard maximum in both languages', () => {
    expect(blueprintSemanticGenerationContract('en-US'))
      .toContain('Keep keyEvents concise; aim for no more than 900 characters and never exceed the hard maximum of 1,200.')
    expect(blueprintSemanticGenerationContract('zh-CN'))
      .toContain('keyEvents 保持精炼，目标为 100–150 字符，绝不得超过 1200 字符硬上限。')
  })

  it('requires exact chapter coverage with no missing, extra, or duplicate chapter', () => {
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint({ chapterNumber: 3 })] },
      [1, 2],
    )).toThrow(/code=unexpected_item path=blueprints/u)
    expect(() => decodeBlueprintSemanticPayload(
      { blueprints: [validBlueprint(), validBlueprint()] },
      [1],
    )).toThrow(/code=duplicate_item path=blueprints/u)
  })
})
