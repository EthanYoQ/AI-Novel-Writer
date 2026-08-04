import { describe, expect, it } from 'vitest'

import { createModelProfileDraft } from '../model-profile-draft'

describe('model profile drafts', () => {
  it('creates a complete SiliconFlow bge-m3 embedding profile without an API key', () => {
    const draft = createModelProfileDraft({
      id: 'new-embedding-profile',
      purposes: ['embedding'],
    })

    expect(draft).toMatchObject({
      id: 'new-embedding-profile',
      name: 'SiliconFlow BAAI/bge-m3',
      provider: 'siliconflow',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelName: 'BAAI/bge-m3',
      apiKey: '',
      purposes: ['embedding'],
      capabilities: {
        contextWindowTokens: 8192,
        maxOutputTokens: 0,
        reasoning: false,
        structuredOutput: false,
        usage: true,
      },
    })
  })
})
