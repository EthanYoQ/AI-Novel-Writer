import { describe, expect, it } from 'vitest'

import { presentWorkflowFailure } from '../ai-output-failure-presentation'

describe('AI output failure presentation', () => {
  it('maps a structured content-filter code to a clear Chinese chapter-draft failure', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', 'zh-CN', true)).toEqual({
      heading: '正文生成被内容策略拦截',
      reason: '模型的内容安全策略拦截了这次输出。',
      persistence: '本次未保存草稿或正文章节。请调整章节要求，或选择符合预期内容政策的模型后重试。',
    })
  })

  it('maps a structured content-filter code to an English explanation instead of exposing it as prose', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', 'en-US', true)).toEqual({
      heading: 'Draft generation was blocked by the content policy',
      reason: 'The model safety policy filtered this output.',
      persistence: 'No draft or manuscript chapter was saved. Adjust the chapter request, or choose a model whose policy fits your intended permitted content, then try again.',
    })
  })

  it('keeps a legacy machine-looking error generic when no structured code was supplied', () => {
    const presentation = presentWorkflowFailure(undefined, 'finish:content_filter', 'zh-CN', true)

    expect(presentation.reason).toBe('finish:content_filter')
    expect(presentation.heading).not.toBe('正文生成被内容策略拦截')
  })
})
