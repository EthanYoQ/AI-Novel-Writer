import { describe, expect, it } from 'vitest'
import { composePromptSystemRole, getBuiltinPromptTemplate, renderPrompt } from '../prompt-templates'
import { characterArchitecturePrompts } from '../prompt-language'
import { resolveWritingLanguage, writingLanguageText } from '../../shared/writing-language'
import { presentWorkflowFailure } from '../../components/panels/ai-output-failure-presentation'

describe('Traditional Chinese writing and output UI', () => {
  it('preserves the project writing language and translates built-in writing copy', () => {
    expect(resolveWritingLanguage('zh-TW')).toBe('zh-TW')
    expect(writingLanguageText('zh-TW', '小说章节与角色关系', '')).toBe('小說章節與角色關係')
  })

  it('uses Traditional Chinese templates and an explicit immutable output contract', () => {
    const template = getBuiltinPromptTemplate('first_chapter_draft', 'zh-TW')!
    expect(template.content).toContain('小說')
    const system = composePromptSystemRole(template, 'zh-TW')
    expect(system).toContain('必須使用繁體中文（臺灣用語）')
    expect(system).toContain('保留 JSON 鍵名')
    const rendered = renderPrompt({ ...template, content: '{{user_guidance}}' }, {
      user_guidance: '作者输入保留简体字',
    }, 'zh-TW')
    expect(rendered).toContain('作者输入保留简体字')
  })

  it('requires Traditional Chinese in structured character generation', () => {
    const prompts = characterArchitecturePrompts('zh-TW')
    expect(prompts.manifestSystem).toContain('必須使用繁體中文')
    expect(prompts.detailSystem).toContain('必須使用繁體中文')
    expect(prompts.detailContract).toContain('currentState')
  })

  it('localizes AI output failures while preserving supplied error details', () => {
    expect(presentWorkflowFailure('content_filter', undefined, 'zh-TW', true).heading)
      .toBe('正文生成被內容策略攔截')
    expect(presentWorkflowFailure(undefined, '用户提供的简体错误', 'zh-TW', false))
      .toMatchObject({ heading: '工作流未完成', reason: '用户提供的简体错误' })
  })
})
