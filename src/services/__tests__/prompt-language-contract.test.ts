import { describe, expect, it } from 'vitest'

import { BUILTIN_PROMPTS, getBuiltinPromptTemplate } from '../prompt-templates'
import {
  characterArchitecturePrompts,
  CORE_LOCALIZED_BUILTIN_PROMPT_KEYS,
  EN_US_BUILTIN_PROMPTS,
} from '../prompt-language'

const REQUIRED_CORE_KEYS = [
  'generate_global_config',
  'premise',
  'character_dynamics',
  'world_building',
  'synopsis',
  'chapter_blueprint',
  'chapter_blueprint_chunk',
  'first_chapter_draft',
  'next_chapter_draft',
  'refine_chapter',
  'consistency_check',
  'refine_from_review',
  'generate_chapter_notes',
  'update_character_cards',
  'analyze_writing_style',
  'infer_novel_config',
  'infer_novel_config_with_vectors',
  'infer_single_chapter_blueprint',
] as const

function placeholders(value: string): string[] {
  return [...new Set(
    [...value.matchAll(/\{\{([a-z0-9_]+)\}\}/giu)].map(match => match[1]!),
  )].sort()
}

describe('core model prompt language contract', () => {
  it('enumerates every #155 forward-writing built-in and requires an English overlay', () => {
    expect(CORE_LOCALIZED_BUILTIN_PROMPT_KEYS).toEqual(REQUIRED_CORE_KEYS)
    const builtinKeys = new Set(BUILTIN_PROMPTS.map(template => template.key))

    for (const key of CORE_LOCALIZED_BUILTIN_PROMPT_KEYS) {
      expect(builtinKeys.has(key), `${key} must remain a registered built-in prompt`).toBe(true)
      expect(
        Object.hasOwn(EN_US_BUILTIN_PROMPTS, key),
        `${key} must not silently fall back to Chinese for an English project`,
      ).toBe(true)
    }
  })

  it.each(REQUIRED_CORE_KEYS)('preserves the %s variable contract across zh-CN and en-US', (key) => {
    const zhCN = getBuiltinPromptTemplate(key, 'zh-CN')
    const enUS = getBuiltinPromptTemplate(key, 'en-US')

    expect(zhCN).toBeDefined()
    expect(enUS).toBeDefined()
    expect(enUS?.systemRole).not.toBe(zhCN?.systemRole)
    expect(enUS?.content).not.toBe(zhCN?.content)
    expect(`${enUS?.systemRole ?? ''}\n${enUS?.content ?? ''}\n${enUS?.systemSuffix ?? ''}`)
      .not.toMatch(/[\u3400-\u9fff]/u)
    expect(placeholders(`${enUS?.content ?? ''}\n${enUS?.systemSuffix ?? ''}`)).toEqual(
      placeholders(`${zhCN?.content ?? ''}\n${zhCN?.systemSuffix ?? ''}`),
    )
  })

  it('provides distinct bilingual role-graph instructions outside the editable template catalog', () => {
    const zhCN = characterArchitecturePrompts('zh-CN')
    const enUS = characterArchitecturePrompts('en-US')

    expect(zhCN.manifestSystem).toContain('角色身份规划器')
    expect(enUS.manifestSystem).toContain('character identities')
    expect(enUS.manifestSystem).not.toMatch(/[\u3400-\u9fff]/u)
    expect(enUS.detailContract).toContain('Immutable character-detail JSON contract')
  })
})
