import { describe, expect, it } from 'vitest'

import { presentWorkflowFailure } from '../ai-output-failure-presentation'

const promptBudgetReport = (sectionName: string) => ({
  totalUtf8Bytes: 13_000,
  limitUtf8Bytes: 12_000,
  reservedOutputTokens: 8_192,
  sections: [
    { sectionName, utf8Bytes: 12_000 },
    { sectionName: 'prompt-overhead', utf8Bytes: 1_000 },
  ],
  modelId: 'model-a',
  errorCode: 'PROMPT_BUDGET_EXHAUSTED' as const,
})

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

  it('offers Novel configuration only for a project-configuration contributor', () => {
    expect(presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'en-US',
      false,
      promptBudgetReport('global-guidance'),
    )).toMatchObject({
      action: 'open-novel-config',
      guidance: 'Shorten the listed project configuration fields in Novel configuration, then try again.',
    })
  })

  it('keeps a step-guidance overflow away from the unrelated Novel configuration action', () => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'zh-CN',
      false,
      promptBudgetReport('step-guidance'),
    )

    expect(presentation).toMatchObject({
      guidance: '请返回该生成步骤，缩短步骤指导后重试。',
    })
    expect(presentation).not.toHaveProperty('action')
  })

  it.each([
    ['architecture', 'Shorten the related story-architecture content or reduce this generation scope, then try again.'],
    ['validated-prefix', 'Reduce this structured batch and try again; validated content will not be silently truncated.'],
    ['repair-contract', 'The structured repair contract cannot be safely edited in the interface. Reduce this task scope; if the problem persists, report the result code.'],
    ['repair-candidate', 'Shorten the structured content being repaired, or split this import or generation into smaller batches, then try again.'],
  ])('provides safe non-configuration guidance for %s without an unrelated action', (sectionName, guidance) => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'en-US',
      false,
      promptBudgetReport(sectionName),
    )

    expect(presentation.guidance).toBe(guidance)
    expect(presentation).not.toHaveProperty('action')
  })
})
