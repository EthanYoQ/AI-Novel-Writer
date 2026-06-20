import { describe, expect, it } from 'vitest'

import { ChapterPromptBuilder } from '../prompts/prompt-builder'
import { BUILTIN_PROMPTS, getPromptTemplate, renderPrompt, type PromptTemplate } from '../prompt-templates'

const expectedPromptVariables: Record<string, string[]> = {
  generate_global_config: ['user_idea', 'number_of_chapters', 'word_number'],
  premise: [
    'genre',
    'sub_genre',
    'topic',
    'target_audience',
    'number_of_chapters',
    'word_number',
    'core_setting',
    'golden_finger',
    'protagonist_profile',
    'global_guidance',
    'step_guidance',
    'reference_works',
  ],
  character_dynamics: [
    'premise',
    'genre',
    'protagonist_profile',
    'golden_finger',
    'world_building',
    'number_of_chapters',
    'global_guidance',
    'step_guidance',
    'reference_works',
  ],
  world_building: [
    'premise',
    'genre',
    'core_setting',
    'golden_finger',
    'protagonist_profile',
    'global_guidance',
    'step_guidance',
  ],
  synopsis: [
    'premise',
    'character_dynamics',
    'world_building',
    'genre',
    'number_of_chapters',
    'word_number',
    'plot_structure_guide',
    'narrative_pov',
    'global_guidance',
    'step_guidance',
  ],
  chapter_blueprint: ['novel_architecture', 'number_of_chapters', 'global_guidance', 'genre', 'pacing_guidance'],
  chapter_blueprint_chunk: [
    'novel_architecture',
    'chapter_list',
    'number_of_chapters',
    'n',
    'm',
    'global_guidance',
    'genre',
    'pacing_guidance',
  ],
  first_chapter_draft: [
    'architecture',
    'chapter_info',
    'future_blueprints',
    'global_guidance',
    'word_number',
    'writing_style',
    'user_guidance',
  ],
  next_chapter_draft: [
    'global_summary',
    'character_states',
    'short_summary',
    'previous_ending',
    'chapter_info',
    'future_blueprints',
    'user_guidance',
    'filtered_context',
    'global_guidance',
    'word_number',
    'writing_style',
  ],
  refine_chapter: [
    'draft_content',
    'chapter_info',
    'global_guidance',
    'global_summary',
    'short_summary',
    'word_number',
    'user_refine_prompt',
    'writing_style',
  ],
  consistency_check: ['chapter_content', 'character_states', 'global_summary', 'world_building', 'review_focus'],
  analyze_writing_style: ['sample_text'],
  refine_from_review: ['review_report', 'draft_content', 'global_guidance', 'user_refine_prompt'],
  generate_chapter_notes: ['chapter_content', 'chapter_number', 'chapter_title'],
  update_character_cards: ['chapter_content', 'chapter_number', 'existing_cards_json'],
  infer_novel_config: ['sample_content'],
  extract_initial_characters: ['character_dynamics', 'genre'],
  infer_single_chapter_blueprint: ['chapter_content', 'chapter_number', 'chapter_title', 'novel_config_summary'],
  infer_novel_config_with_vectors: [
    'sampled_worldview',
    'sampled_protagonist',
    'sampled_conflict',
    'sampled_style',
    'first_chapter',
    'latest_chapter',
    'total_chapters',
  ],
}

const expectedJsonFields: Record<string, string[]> = {
  generate_global_config: [
    'genre',
    'targetAudience',
    'subGenre',
    'plotStructure',
    'narrativePOV',
    'coreOutline',
    'worldSetting',
    'goldenFinger',
    'protagonistProfile',
    'globalGuidance',
    'writingStyle',
  ],
  chapter_blueprint: ['blueprints', 'chapterNumber', 'title', 'purpose', 'characters', 'keyEvents', 'suspenseHook'],
  chapter_blueprint_chunk: ['blueprints', 'chapterNumber', 'title', 'purpose', 'characters', 'keyEvents', 'suspenseHook'],
  consistency_check: ['items', 'category', 'severity', 'quote', 'description', 'summary'],
  update_character_cards: [
    'updates',
    'newCharacters',
    'currentState',
    'location',
    'powerLevel',
    'physicalState',
    'mentalState',
    'keyItems',
    'recentEvents',
    'updatedAtChapter',
  ],
  infer_novel_config: [
    'novelConfig',
    'architectureFiles',
    'characterCards',
    'genre',
    'targetAudience',
    'subGenre',
    'coreOutline',
    'worldSetting',
    'goldenFinger',
    'protagonistProfile',
    'globalGuidance',
    'premise',
    'characters',
    'worldbuilding',
    'synopsis',
    'currentState',
  ],
  extract_initial_characters: [
    'name',
    'role',
    'gender',
    'age',
    'appearance',
    'personality',
    'background',
    'abilities',
    'motivation',
    'relationships',
    'arc',
    'notes',
    'currentState',
  ],
  infer_single_chapter_blueprint: ['chapterNumber', 'title', 'role', 'purpose', 'characters', 'keyEvents', 'suspenseHook'],
  infer_novel_config_with_vectors: [
    'novelConfig',
    'architectureFiles',
    'characterCards',
    'plotStructure',
    'narrativePOV',
    'genre',
    'targetAudience',
    'subGenre',
    'coreOutline',
    'worldSetting',
    'goldenFinger',
    'protagonistProfile',
    'globalGuidance',
    'premise',
    'characters',
    'worldbuilding',
    'synopsis',
    'currentState',
  ],
}

const promptText = (key: string) => {
  const template = getPromptTemplate(key)
  expect(template, `missing prompt template: ${key}`).toBeTruthy()
  return [template?.systemRole, template?.content, template?.systemSuffix].filter(Boolean).join('\n')
}

const fullTemplateText = (template: PromptTemplate) =>
  [template.systemRole, template.content, template.systemSuffix].filter(Boolean).join('\n')

const compact = (value: string) => value.replace(/\s+/g, '')

const optionalGuidanceLabels = [
  '【作者补充指导】',
  '【作者节奏/风格指导】',
  '【作者要求重点检查的维度】',
]

describe('built-in prompt contract for local Qwen generation', () => {
  it('keeps all built-in prompt text free of slogan claims', () => {
    for (const template of BUILTIN_PROMPTS) {
      expect(fullTemplateText(template), `${template.key} prompt text`).not.toMatch(/顶尖|白金|爆款|大神/)
    }
  })

  it('documents local Qwen3 14B Q4 constraints on every built-in prompt', () => {
    for (const template of BUILTIN_PROMPTS) {
      const text = fullTemplateText(template)
      expect(text, `${template.key} should mention Qwen3 14B Q4 or local quantized model`).toMatch(/Qwen3 14B Q4|本地量化模型/)
      expect(text, `${template.key} should prefer short instructions`).toContain('短句')
      expect(text, `${template.key} should require concrete output`).toContain('具体')
    }
  })

  it('preserves all built-in prompt keys and variable contracts', () => {
    expect(BUILTIN_PROMPTS.map((template) => template.key)).toEqual(Object.keys(expectedPromptVariables))

    for (const template of BUILTIN_PROMPTS) {
      expect(Object.keys(template.variables), `${template.key} variables`).toEqual(expectedPromptVariables[template.key])
    }
  })

  it('preserves JSON output field contracts for structured prompts', () => {
    for (const [key, fields] of Object.entries(expectedJsonFields)) {
      const text = promptText(key)
      for (const field of fields) {
        expect(text, `${key} should preserve JSON field ${field}`).toContain(field)
      }
    }
  })

  it('keeps drafting prompts constrained to the current chapter body', () => {
    for (const key of ['first_chapter_draft', 'next_chapter_draft', 'refine_chapter']) {
      const text = compact(promptText(key))
      expect(text, `${key} should avoid future chapter spillover`).toContain('不提前写后续')
      expect(text, `${key} should avoid plot summaries`).toContain('不要总结')
      expect(text, `${key} should avoid repeated wording`).toContain('避免重复')
      expect(text, `${key} should require blank lines between paragraphs`).toContain('段落空行')
      expect(text, `${key} should output body text only`).toContain('纯文本正文')
      expect(text, `${key} should preserve configured writing style`).toContain('尊重writing_style')
    }
  })

  it('keeps import and imitation prompts evidence-bound', () => {
    const stylePrompt = promptText('analyze_writing_style')
    expect(stylePrompt).toContain('风格档案')
    expect(stylePrompt).toContain('仿写指南')
    expect(stylePrompt).toContain('Qwen3 14B Q4')
    expect(stylePrompt).toContain('禁止复述')
    expect(stylePrompt).toContain('不要复制')

    for (const key of ['infer_novel_config', 'infer_novel_config_with_vectors', 'infer_single_chapter_blueprint']) {
      const text = promptText(key)
      expect(text, `${key} should only extract verifiable facts`).toContain('只提取可验证信息')
      expect(text, `${key} should mark unknown fields`).toContain('待确认')
      expect(text, `${key} should avoid invention`).toContain('不要臆造')
    }
  })

  it('does not add safety, refusal, or compliance policy prompts', () => {
    const allPromptText = BUILTIN_PROMPTS
      .map((template) => [template.systemRole, template.content, template.systemSuffix].filter(Boolean).join('\n'))
      .join('\n')

    expect(allPromptText).not.toMatch(/安全提示|拒绝提示|合规提示|底线提示/)
  })

  it('prunes empty optional guidance labels from rendered prompts', () => {
    const firstChapter = getPromptTemplate('first_chapter_draft')
    expect(firstChapter).toBeTruthy()

    const rendered = renderPrompt(firstChapter!, {
      architecture: '架构',
      chapter_info: '本章蓝图',
      future_blueprints: '后续蓝图',
      global_guidance: '全局要求',
      word_number: '3000',
      writing_style: '文风',
      user_guidance: '',
    })

    for (const label of optionalGuidanceLabels) {
      expect(rendered).not.toContain(label)
    }
    expect(rendered).toContain('【具体生成要求】')
  })

  it('keeps PromptBuilder pruning aligned with renderPrompt', () => {
    const firstChapter = getPromptTemplate('first_chapter_draft')
    expect(firstChapter).toBeTruthy()

    const rendered = new ChapterPromptBuilder(firstChapter!)
      .withArchitecture('架构')
      .withChapterInfo('本章蓝图')
      .withFutureBlueprints('后续蓝图')
      .withGlobalGuidance('全局要求')
      .withWordNumber('3000')
      .withWritingStyle('文风')
      .withUserGuidance('')
      .build()

    for (const label of optionalGuidanceLabels) {
      expect(rendered).not.toContain(label)
    }
    expect(rendered).toContain('【具体生成要求】')
  })
})
