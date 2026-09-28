import { describe, expect, it } from 'vitest'

import { ArchitecturePromptBuilder, ChapterPromptBuilder } from '../prompts/prompt-builder'
import { pruneEmptyOptionalPromptSections } from '../builtin-prompt-templates'
import { BUILTIN_PROMPTS, EDITABLE_PROMPT_KEYS, getBuiltinPromptTemplate, getPromptTemplate, renderPrompt } from '../prompt-templates'

const expectedPromptVariables: Record<string, string[]> = {
  planning_material_character_extraction: ['requested_ids', 'sources'],
  assistant_writing_identity: ['mode_instruction'],
  edit_selected_text: ['edit_instruction', 'selected_text'],
  generate_novel_config_field: ['existing_config', 'field_label', 'field_requirements'],
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
    'novel_config',
    'chapter_info',
    'future_blueprints',
    'global_guidance',
    'word_number',
    'writing_style',
    'user_guidance',
  ],
  next_chapter_draft: [
    'architecture',
    'novel_config',
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
  character_dynamics: ['schemaVersion', 'entries'],
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
    'target',
    'relation',
    'currentState',
  ],
  extract_initial_characters: [
    'characters',
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
    'target',
    'relation',
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
    'target',
    'relation',
    'currentState',
  ],
}

const promptText = (key: string) => {
  const template = getPromptTemplate(key)
  expect(template, `missing prompt template: ${key}`).toBeTruthy()
  return [template?.systemRole, template?.content, template?.systemSuffix].filter(Boolean).join('\n')
}

const compact = (value: string) => value.replace(/\s+/g, '')

const optionalGuidanceLabels = [
  '【作者补充指导】',
  '【作者节奏/风格指导】',
  '【作者要求重点检查的维度】',
]

describe('built-in model-neutral prompt contract', () => {
  it('does not advertise prompt editors that have no production consumer', () => {
    expect(EDITABLE_PROMPT_KEYS).not.toContain('chapter_blueprint')
    expect(EDITABLE_PROMPT_KEYS).not.toContain('extract_initial_characters')
  })
  it('keeps character-card extraction compatible with JSON-object response mode', () => {
    const text = promptText('extract_initial_characters')

    expect(text).toContain('【输出格式（JSON 对象）】')
    expect(text).toContain('"characters": [')
    expect(text).toContain('返回 {"characters": []}')
  })

  it('keeps system roles free of overclaiming slogan identities', () => {
    for (const template of BUILTIN_PROMPTS) {
      expect(template.systemRole ?? '', `${template.key} system role`).not.toMatch(/顶尖|白金|爆款|大神/)
    }
  })

  it('keeps every built-in system role model-neutral and focused on fiction work', () => {
    for (const template of BUILTIN_PROMPTS) {
      const role = template.systemRole ?? ''
      expect(role, `${template.key} must not bind to one provider or prestige identity`).not.toMatch(/Qwen|量化模型|GPT|Claude|DeepSeek|Grok|顶尖|白金|大神|accomplished|top[- ]|web-fiction/i)
      expect(role, `${template.key} should stay focused on writing or structure`).toMatch(/小说|网文|章节|角色|正文|设定|审稿|风格|结构|JSON/)

      const englishRole = getBuiltinPromptTemplate(template.key, 'en-US')?.systemRole ?? ''
      expect(englishRole, `${template.key} English role`).not.toMatch(/Qwen|quantiz|GPT|Claude|DeepSeek|Grok|accomplished|top[- ]|web-fiction/i)
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

  it('keeps drafting prompts focused on the existing chapter workflow', () => {
    const firstChapter = compact(promptText('first_chapter_draft'))
    expect(firstChapter).toContain('本章仅推演')
    expect(firstChapter).toContain('纯文本正文')
    expect(firstChapter).toContain('段落之间必须保留一个空行')

    const nextChapter = compact(promptText('next_chapter_draft'))
    expect(nextChapter).toContain('本章核心冲突')
    expect(nextChapter).toContain('绝不可擅自拓展后续大纲的情节')
    expect(nextChapter).toContain('文风要求')

    const refineChapter = compact(promptText('refine_chapter'))
    expect(refineChapter).toContain('精修与细节填充')
    expect(refineChapter).toContain('目标字数控制在')
    expect(refineChapter).toContain('段落与段落之间必须保留一个空行')
  })

  it('keeps authoritative project facts in both opening and continuation drafts', () => {
    for (const key of ['first_chapter_draft', 'next_chapter_draft'] as const) {
      const template = getPromptTemplate(key)
      expect(template).toBeTruthy()

      const rendered = new ChapterPromptBuilder(template!, 'zh-CN')
        .withArchitecture('不可丢失的架构事实')
        .withNovelConfig({ protagonistProfile: '不可丢失的作者设定' })
        .withGlobalSummary('前文进展')
        .withCharacterStates('角色状态')
        .withShortSummary('近期摘要')
        .withPreviousEnding('上一章结尾')
        .withChapterInfo('本章蓝图')
        .withFutureBlueprints('后续蓝图')
        .withFilteredContext('知识库')
        .withGlobalGuidance('全局要求')
        .withWordNumber('3000')
        .withWritingStyle('文风')
        .withUserGuidance('')
        .build()

      expect(rendered).toContain('不可丢失的架构事实')
      expect(rendered).toContain('不可丢失的作者设定')
    }
  })

  it('每个必需创作事实只由内置首章和后续章提示词注入一次', () => {
    const variables = {
      architecture: '唯一架构事实甲',
      novel_config: '唯一配置事实乙',
      global_summary: '前文进展',
      character_states: '角色状态',
      short_summary: '近期摘要',
      previous_ending: '上一章结尾',
      chapter_info: '本章蓝图',
      future_blueprints: '后续蓝图',
      filtered_context: '知识库',
      global_guidance: '唯一全局要求丙',
      word_number: '3000',
      writing_style: '唯一文风要求丁',
      user_guidance: '',
    }

    for (const key of ['first_chapter_draft', 'next_chapter_draft'] as const) {
      const template = getPromptTemplate(key)!
      const renderedPrompts = [
        renderPrompt(template, variables, 'zh-CN'),
        new ChapterPromptBuilder(template, 'zh-CN')
          .withArchitecture(variables.architecture)
          .withNovelConfig(variables.novel_config)
          .withGlobalSummary(variables.global_summary)
          .withCharacterStates(variables.character_states)
          .withShortSummary(variables.short_summary)
          .withPreviousEnding(variables.previous_ending)
          .withChapterInfo(variables.chapter_info)
          .withFutureBlueprints(variables.future_blueprints)
          .withFilteredContext(variables.filtered_context)
          .withGlobalGuidance(variables.global_guidance)
          .withWordNumber(variables.word_number)
          .withWritingStyle(variables.writing_style)
          .withUserGuidance(variables.user_guidance)
          .build(),
      ]

      for (const rendered of renderedPrompts) {
        for (const fact of [
          variables.architecture,
          variables.novel_config,
          variables.global_guidance,
          variables.writing_style,
        ]) {
          expect(rendered.split(fact)).toHaveLength(2)
        }
      }
    }
  })

  it('正文和任务指导算已引用，伪造的自定义后缀不阻止必需事实兜底', () => {
    const builtin = getBuiltinPromptTemplate('world_building', 'zh-CN')!
    const custom = {
      ...builtin,
      content: '自定义正文引用：{{premise}}',
      taskGuidance: '自定义任务指导引用：{{core_setting}}',
      systemSuffix: '伪造后缀引用：{{golden_finger}}',
    }
    const variables = {
      premise: '正文中的唯一故事前提',
      genre: '兜底中的唯一题材',
      core_setting: '任务指导中的唯一世界基盘',
      golden_finger: '兜底中的唯一金手指',
      protagonist_profile: '兜底中的唯一主角档案',
      global_guidance: '兜底中的唯一全局要求',
      step_guidance: '',
    }
    const renderedPrompts = [
      renderPrompt(custom, variables, 'zh-CN'),
      new ArchitecturePromptBuilder(custom, 'zh-CN')
        .withCoreSeed(variables.premise)
        .withGenre(variables.genre)
        .withCoreSetting(variables.core_setting)
        .withGoldenFinger(variables.golden_finger)
        .withProtagonistProfile(variables.protagonist_profile)
        .withGlobalGuidance(variables.global_guidance)
        .withStepGuidance(variables.step_guidance)
        .build(),
    ]

    for (const rendered of renderedPrompts) {
      expect(rendered).not.toContain('伪造后缀引用')
      expect(rendered).toContain('【自定义模板未引用但仍必须遵循的权威项目设定】')
      for (const fact of Object.values(variables).filter(Boolean)) {
        expect(rendered.split(fact)).toHaveLength(2)
      }
    }
  })

  it('appends authoritative facts even when a project customizes the draft body', () => {
    const rendered = new ChapterPromptBuilder({
      key: 'next_chapter_draft',
      name: '自定义后续章',
      description: '测试自定义正文模板',
      systemRole: '自定义角色',
      variables: { chapter_info: '本章蓝图' },
      content: '只使用自定义正文：{{chapter_info}}',
    }, 'zh-CN')
      .withArchitecture('自定义模板也不能丢失的架构事实')
      .withNovelConfig({ coreOutline: '自定义模板也不能丢失的作者配置' })
      .withChapterInfo('本章蓝图')
      .withGlobalGuidance('')
      .withWordNumber('3000')
      .withWritingStyle('')
      .withUserGuidance('')
      .build()

    expect(rendered).toContain('只使用自定义正文：本章蓝图')
    expect(rendered).toContain('自定义模板也不能丢失的架构事实')
    expect(rendered).toContain('自定义模板也不能丢失的作者配置')
  })

  it('carries explicit author facts through architecture and blueprint prompts', () => {
    for (const key of ['character_dynamics', 'world_building', 'synopsis', 'chapter_blueprint', 'chapter_blueprint_chunk']) {
      expect(promptText(key), `${key} should preserve author facts`).toContain('作者明确设定')
    }
  })

  it('keeps import and imitation prompts focused on style extraction and reference imitation', () => {
    const stylePrompt = promptText('analyze_writing_style')
    expect(stylePrompt).toContain('风格档案')
    expect(stylePrompt).toContain('仿写指南')
    expect(stylePrompt).not.toMatch(/Qwen|量化模型/i)
    expect(stylePrompt).toContain('禁止复述')
    expect(stylePrompt).toContain('不要复制')

    for (const key of ['infer_novel_config', 'infer_novel_config_with_vectors', 'infer_single_chapter_blueprint']) {
      const text = promptText(key)
      expect(text, `${key} should use the import workflow`).toMatch(/已有小说|已有章节|关键片段/)
      if (key !== 'infer_single_chapter_blueprint') {
        expect(text, `${key} should mark unknown fields`).toContain('待确认')
      }
      expect(text, `${key} should preserve structured output`).toMatch(/JSON|chapterNumber/)
    }
  })

  it('does not add safety, refusal, compliance, or bottom-line policy prompts', () => {
    const allPromptText = BUILTIN_PROMPTS
      .map((template) => [template.systemRole, template.content, template.systemSuffix].filter(Boolean).join('\n'))
      .join('\n')

    expect(allPromptText).not.toMatch(/安全提示|拒绝提示|合规提示|底线提示|写作安全|安全边界|合规边界|政策要求/)
    expect(allPromptText).not.toContain('底线')
  })

  it('prunes empty optional guidance labels from rendered prompts', () => {
    const firstChapter = getPromptTemplate('first_chapter_draft')
    expect(firstChapter).toBeTruthy()

    const rendered = renderPrompt(firstChapter!, {
      architecture: '架构',
      novel_config: '{"genre":"类型"}',
      chapter_info: '本章蓝图',
      future_blueprints: '后续蓝图',
      global_guidance: '全局要求',
      word_number: '3000',
      writing_style: '文风',
      user_guidance: '',
    }, 'zh-CN')

    for (const label of optionalGuidanceLabels) {
      expect(rendered).not.toContain(label)
    }
    expect(rendered).toContain('【具体生成要求】')
  })

  it('keeps PromptBuilder pruning aligned with renderPrompt', () => {
    const firstChapter = getPromptTemplate('first_chapter_draft')
    expect(firstChapter).toBeTruthy()

    const rendered = new ChapterPromptBuilder(firstChapter!, 'zh-CN')
      .withArchitecture('架构')
      .withNovelConfig({ genre: '类型' })
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

  it('keeps draft length guidance aimed at the target instead of pushing past it', () => {
    for (const key of ['first_chapter_draft', 'next_chapter_draft'] as const) {
      for (const language of ['zh-CN', 'en-US'] as const) {
        const template = getBuiltinPromptTemplate(key, language)!
        const text = [template.content, template.systemSuffix].join('\n')
        expect(text, `${key} ${language}`).not.toMatch(/停在自然段落末尾|踏踏实实|natural paragraph boundary|Use approximately \{\{word_number\}\} words to complete/u)
        expect(text, `${key} ${language}`).toContain(language === 'zh-CN'
          ? '- 接近目标篇幅时按本章结束状态收束，不要超过目标；不要写“继续生成”“点我继续”之类的界面提示。'
          : "- As you approach the target length, close at the chapter's specified ending state and do not exceed the target; never ask the user to continue.")
        expect(text.split('{{word_number}}'), `${key} ${language} keeps one target mention`).toHaveLength(2)
      }
    }
    const nextChapter = getBuiltinPromptTemplate('next_chapter_draft', 'zh-CN')!
    expect(nextChapter.content).toContain('3. 落实本章核心冲突：集中推演完本章目标，避免平淡流水账。')
    expect(nextChapter.systemSuffix).toContain('切忌注水！不要为了凑字数而撰写冗余的旁白科普或无意义的日常对话。')
    expect(getBuiltinPromptTemplate('next_chapter_draft', 'en-US')!.systemSuffix)
      .toContain('- Write approximately {{word_number}} words. Cover only the chapter brief and stop once its conflict is complete; do not pad with filler narration or idle dialogue, and do not advance later blueprints.')
  })

  it.each([
    { language: 'zh-CN' as const,
      pruned: ['【剧情记忆库与前置断点上下文】', '[全局剧情进展]', '上一章已完成的结尾状态', '【后续章节大纲预告】', '【知识库资料'],
      kept: ['你正在连载写作最新章节。\n\n【本章写作方向与核心任务】\n本章蓝图', '【网文连载更新核心法则】'] },
    { language: 'en-US' as const,
      pruned: ['[Story memory and previous stopping point]', 'Overall progress:', 'Completed ending state', '[Upcoming chapter blueprints', '[Knowledge-base context]'],
      kept: ['You are serializing the latest chapter.\n\n[Chapter brief]\n本章蓝图', '[Serialization requirements]'] },
  ])('prunes runtime-empty next-chapter context sections with their headings in $language', ({ language, pruned, kept }) => {
    const build = (filled: boolean) => new ChapterPromptBuilder(getBuiltinPromptTemplate('next_chapter_draft', language)!, language)
      .withArchitecture('架构')
      .withNovelConfig({ genre: '类型' })
      .withGlobalSummary(filled ? '前文进展' : '')
      .withCharacterStates('')
      .withShortSummary('')
      .withPreviousEnding('')
      .withChapterInfo('本章蓝图')
      .withFutureBlueprints(filled ? '- 第3章：后续蓝图' : '')
      .withFilteredContext(filled ? '知识库片段' : '')
      .withGlobalGuidance('全局要求')
      .withWordNumber('900')
      .withWritingStyle('文风')
      .withUserGuidance('')
      .build()

    const empty = build(false)
    for (const text of pruned) expect(empty).not.toContain(text)
    for (const text of kept) expect(empty).toContain(text)
    expect(empty).not.toMatch(/\n{3,}/u)

    // 有内容的段落及其标题原样保留；只清掉其中的空条目。
    const filled = build(true)
    expect(filled).toContain(language === 'zh-CN' ? '【剧情记忆库与前置断点上下文】\n- [全局剧情进展]：前文进展' : '[Story memory and previous stopping point]\n- Overall progress: 前文进展')
    expect(filled).toContain(language === 'zh-CN' ? '【后续章节大纲预告】（仅供了解后续剧情发力点，请绝对不要在本章提前写出后续内容！）\n- 第3章：后续蓝图' : 'do not reveal or advance them in this chapter]\n- 第3章：后续蓝图')
    expect(filled).toContain('知识库片段')
  })

  it('prunes an empty upcoming-blueprint section from the opening-chapter prompt', () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      const rendered = new ChapterPromptBuilder(getBuiltinPromptTemplate('first_chapter_draft', language)!, language)
        .withArchitecture('架构')
        .withNovelConfig({ genre: '类型' })
        .withChapterInfo('本章蓝图')
        .withFutureBlueprints('')
        .withGlobalGuidance('全局要求')
        .withWordNumber('900')
        .withWritingStyle('文风')
        .withUserGuidance('')
        .build()
      expect(rendered).not.toMatch(/【后续章节大纲预告】|\[Upcoming chapter blueprints/u)
      expect(rendered).toContain(language === 'zh-CN' ? '本章蓝图\n\n【全局写作要求】' : '本章蓝图\n\n[Project-wide writing guidance]')
    }
  })

  it('keeps author text written on the same line as the upcoming-blueprint heading', () => {
    const custom = '【后续章节大纲预告】：第5章 主角离城\n\n【全局写作要求】'
    expect(pruneEmptyOptionalPromptSections(custom)).toBe(custom)
  })
})
