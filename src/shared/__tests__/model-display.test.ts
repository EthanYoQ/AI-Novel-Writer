import { describe, expect, it } from 'vitest'

import { modelDisplayName } from '../model-display'

describe('model display name', () => {
  it('prefers the alias the author gave the model', () => {
    expect(modelDisplayName({
      name: '备用',
      modelName: 'deepseek-v4-flash',
      provider: 'deepseek',
    })).toBe('备用')
  })

  it('falls back to the model identifier when the alias is blank', () => {
    // 这就是顶栏模型胶囊变空白的真实场景：模型没有别名，只有 modelName。
    expect(modelDisplayName({
      name: '',
      modelName: 'deepseek-v4-flash',
      provider: 'deepseek',
    })).toBe('deepseek-v4-flash')
    expect(modelDisplayName({
      name: '   ',
      modelName: 'deepseek-v4-flash',
      provider: 'deepseek',
    })).toBe('deepseek-v4-flash')
  })

  it('falls back to the provider when alias and identifier are both blank', () => {
    expect(modelDisplayName({ name: '', modelName: '', provider: 'deepseek' })).toBe('deepseek')
  })

  it('returns an empty label only when there is nothing to show', () => {
    expect(modelDisplayName(null)).toBe('')
    expect(modelDisplayName(undefined)).toBe('')
    expect(modelDisplayName({ name: '', modelName: '', provider: '' })).toBe('')
  })
})
