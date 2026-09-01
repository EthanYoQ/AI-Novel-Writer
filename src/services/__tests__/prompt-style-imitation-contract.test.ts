import { describe, expect, it } from 'vitest'

import { getPromptTemplate } from '../prompt-templates'

describe('reference style imitation prompt contract', () => {
  it('turns imported novel samples into actionable imitation constraints', () => {
    const template = getPromptTemplate('analyze_writing_style')

    expect(template?.content).toContain('风格档案')
    expect(template?.content).toContain('仿写指南')
    expect(template?.content).toContain('句式')
    expect(template?.content).toContain('场景推进')
    expect(template?.content).not.toMatch(/Qwen|量化模型/i)
    expect(template?.content).toContain('禁止复述')
    expect(template?.content).toContain('不要复制')
  })
})
