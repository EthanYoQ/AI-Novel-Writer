import { describe, expect, it } from 'vitest'

import { getBuiltinPromptTemplate, getPromptTemplate } from '../prompt-templates'

describe('reference style imitation prompt contract', () => {
  it('turns imported novel samples into actionable imitation guidance', () => {
    const template = getPromptTemplate('analyze_writing_style')

    expect(template?.content).toContain('风格档案')
    expect(template?.content).toContain('仿写指南')
    expect(template?.content).toContain('句式')
    expect(template?.content).toContain('场景推进')
    expect(template?.content).not.toMatch(/Qwen|量化模型/i)
    expect(template?.content).toContain('禁止复述')
    expect(template?.content).toContain('不要复制')
  })

  it('extracts only a small set of optional transferable techniques in both writing languages', () => {
    const zhCN = getBuiltinPromptTemplate('analyze_writing_style', 'zh-CN')
    const enUS = getBuiltinPromptTemplate('analyze_writing_style', 'en-US')

    expect(`${zhCN?.systemRole}\n${zhCN?.content}`).toContain('少量、简短、可选')
    expect(zhCN?.content).toContain('样本缺点')
    expect(zhCN?.content).toContain('动作或物件的出现次数')
    expect(zhCN?.content).toContain('样本文长')
    expect(zhCN?.content).not.toContain('每项 2-4 条')
    expect(zhCN?.content).not.toContain('适合注入 Prompt 的硬性约束')

    expect(`${enUS?.systemRole}\n${enUS?.content}`).toContain('small set of concise, optional')
    expect(enUS?.content).toContain('sample flaws')
    expect(enUS?.content).toContain('action or object quotas')
    expect(enUS?.content).toContain('sample length')
    expect(enUS?.content).not.toContain('two to four concise items per field')
    expect(enUS?.content).not.toContain('Hard constraints for drafting prompts')
  })

  it.each(['first_chapter_draft', 'next_chapter_draft', 'refine_chapter'] as const)(
    'keeps writing style subordinate to story truth in the %s prompt',
    (key) => {
      const zhCN = getBuiltinPromptTemplate(key, 'zh-CN')
      const enUS = getBuiltinPromptTemplate(key, 'en-US')

      expect(zhCN?.systemSuffix).toContain('文风仅用于选择表达方式')
      expect(zhCN?.systemSuffix).toContain('作者明确事实与指导、实际前文、本章关键因果和本章篇幅优先')
      expect(zhCN?.systemSuffix).toContain('不得把作者明确事实或要求降格为推测')
      expect(enUS?.systemSuffix).toContain('Writing style selects expression only')
      expect(enUS?.systemSuffix).toContain('actual prior prose')
      expect(enUS?.systemSuffix).toContain('relabel explicit author facts or requirements as guesses')
    },
  )
})
