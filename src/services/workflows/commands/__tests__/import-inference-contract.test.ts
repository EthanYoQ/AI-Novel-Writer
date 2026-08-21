import { describe, expect, it } from 'vitest'

import type { CharacterRosterEntry } from '../../../../shared/character-roster'
import { StructuredContractDiagnostic } from '../../../../shared/structured-contract-diagnostic'
import { decodeImportInferenceJson } from '../import-inference-contract'

function validInference() {
  const card = (name: string, role: CharacterRosterEntry['role']) => ({
    name,
    role,
    gender: '未知',
    age: 18,
    appearance: '外貌明确',
    personality: '性格明确',
    background: '背景明确',
    abilities: '能力明确',
    motivation: '动机明确',
    relationships: [],
    arc: '角色弧光',
    notes: '待确认',
    currentState: {
      location: '城中',
      powerLevel: '普通',
      physicalState: '正常',
      mentalState: '警觉',
      keyItems: '无',
      recentEvents: '启程',
      updatedAtChapter: 1,
    },
  })
  return {
    novelConfig: {
      genre: '现实',
      subGenre: '讽刺',
      targetAudience: '通用',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '主角在冲突中逐步认识世界。',
      worldSetting: '现实社会。',
      goldenFinger: '无。',
      protagonistProfile: '敏感而倔强。',
      globalGuidance: '保持克制叙事。',
    },
    architectureFiles: {
      premise: '个人与环境持续冲突。',
      worldbuilding: '现实社会结构。',
      synopsis: '主角经历挫折并作出选择。',
    },
    characterCards: [
      card('陆舟', 'protagonist'),
      card('苏绾', 'supporting'),
      card('顾岩', 'antagonist'),
    ],
  }
}

function expectInvalidJson(content: string) {
  expect(() => decodeImportInferenceJson(content)).toThrow(StructuredContractDiagnostic)
  try {
    decodeImportInferenceJson(content)
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredContractDiagnostic)
    expect((error as StructuredContractDiagnostic).code).toBe('invalid_json')
    expect((error as StructuredContractDiagnostic).path).toBe('$')
  }
}

describe('decodeImportInferenceJson', () => {
  it('accepts one complete JSON object inside benign invisible and fenced wrappers', () => {
    const parsed = decodeImportInferenceJson(
      `\u200B\uFEFF\`\`\`json\n${JSON.stringify(validInference())}\n\`\`\`\u2060`,
    )

    expect(parsed.novelConfig.genre).toBe('现实')
    expect(parsed.characterCards.map(card => card.name)).toEqual(['陆舟', '苏绾', '顾岩'])
    expect(parsed.characterCards[0].age).toBe('18')
  })

  it('rejects multiple complete JSON objects as ambiguous output', () => {
    const json = JSON.stringify(validInference())

    expectInvalidJson(`${json}\n${json}`)
  })

  it('rejects a trailing truncated JSON object fragment after a complete object', () => {
    const json = JSON.stringify(validInference())

    expectInvalidJson(`${json}\n{"novelConfig":`)
  })

  it('rejects a non-object prefix before an otherwise valid object as ambiguous output', () => {
    const json = JSON.stringify(validInference())

    expectInvalidJson(`[]\n${json}`)
  })
})
