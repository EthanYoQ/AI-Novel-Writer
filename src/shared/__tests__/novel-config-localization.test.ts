import { describe, expect, it } from 'vitest'

import { localizeNovelConfigFacts } from '../novel-config-localization'

describe('model-facing novel config facts', () => {
  it('localizes canonical Chinese values for English prompts without changing unknown author values', () => {
    expect(localizeNovelConfigFacts({
      genre: '科幻',
      targetAudience: '全龄',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
    }, 'en-US')).toEqual({
      genre: 'Science fiction',
      targetAudience: 'All ages',
      plotStructure: 'Three-act',
      narrativePOV: 'Third-person limited',
    })
    expect(localizeNovelConfigFacts({ genre: 'solarpunk noir' }, 'en-US').genre)
      .toBe('solarpunk noir')
  })

  it('preserves current Chinese prompt values', () => {
    expect(localizeNovelConfigFacts({
      genre: '科幻',
      targetAudience: '全龄',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
    }, 'zh-CN')).toEqual({
      genre: '科幻',
      targetAudience: '全龄',
      plotStructure: '三幕结构',
      narrativePOV: '第三人称有限',
    })
  })
})
