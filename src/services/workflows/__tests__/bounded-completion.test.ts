import { composeVisibleContinuation, CONTINUATION_VISIBLE_TAIL_CHARS, VISIBLE_CONTINUATION_VERSION } from '../../../shared/visible-continuation'
import { assertMechanicallyCompleteVisibleText } from '../../../shared/visible-text-integrity'
import { describe, expect, it, vi } from 'vitest'
import { createGenerationHarness } from '../../generation/generation-harness'

import {
  appendVisibleTextContinuation,
  BoundedCompletionFailure,
  completeBoundedCompletion,
  createBoundedCompletionError,
  redactVisibleCompletionText,
} from '../bounded-completion'

describe('bounded completion', () => {
  it.each(['zh-CN', 'en-US'] as const)('preserves the full original append task and bounds only the visible tail (%s)', async writingLanguage => {
    const middleRule = 'AUTHOR_MIDDLE_RULE：主角不得使用魔法。'
    const originalPrompt = `AUTHOR_BEGIN\n${'前置作者材料。'.repeat(1_000)}\n${middleRule}\n${'后置作者材料。'.repeat(1_000)}\nAUTHOR_END`
    const partial = `EARLY_VISIBLE_TEXT\n${'已有世界观规则。'.repeat(800)}\nLATEST_VISIBLE_TEXT`
    const requestContinuation = vi.fn().mockResolvedValue({ content: '新的正文完成了世界观规则。', finishReason: 'stop' })

    const result = await completeBoundedCompletion({
      initial: { content: partial, finishReason: 'length' },
      mode: 'append-visible-text', maxContinuations: 1, originalPrompt, writingLanguage,
      requestContinuation,
    })

    const prompt = requestContinuation.mock.calls[0]?.[0] as string
    expect(prompt).toContain(middleRule)
    expect(prompt).toContain(originalPrompt)
    expect(prompt).toContain(partial.slice(-CONTINUATION_VISIBLE_TAIL_CHARS))
    expect(prompt).not.toContain('EARLY_VISIBLE_TEXT')
    expect(result).toContain(partial)
  })

  describe.each([
    'Here is the truth: I never left the island. Everyone who said otherwise was lying.',
    '以下是我从父亲遗物中找到的最后一份内容。它改变了我们所有人的命运。',
    'Below is the valley where my brother disappeared. I had returned to find him.',
  ])('narrative opening: %s', content => {
    it('passes the shared mechanical integrity gate', () => {
      expect(() => assertMechanicallyCompleteVisibleText(content, 'zh-CN')).not.toThrow()
    })

    it('returns the complete prose unchanged without a continuation', async () => {
      const requestContinuation = vi.fn()
      await expect(completeBoundedCompletion({
        initial: { content, finishReason: 'stop' }, mode: 'append-visible-text', maxContinuations: 3,
        originalPrompt: '输出完整正文', writingLanguage: 'zh-CN', requestContinuation,
      })).resolves.toBe(content)
      expect(requestContinuation).not.toHaveBeenCalled()
    })
  })

  it.each([
    {
      mode: 'replace-structured-output' as const,
      initial: '{"chapters":[',
      continuation: '{"chapters":[]}',
      expectedInstruction: 'The previous structured output stopped at the length limit',
    },
    {
      mode: 'append-visible-text' as const,
      initial: 'The aircraft door opened beside the 夜航 Café sign.',
      continuation: 'The aircraft door opened beside the 夜航 Café sign.\n\nMara stepped onto the wet tarmac.',
      expectedInstruction: 'The previous text stopped at the length limit',
    },
  ])('builds an English $mode continuation while preserving the original UTF-8 task', async ({
    mode,
    initial,
    continuation,
    expectedInstruction,
  }) => {
    const originalPrompt = 'Continue from the sign “夜航 Café”; preserve café exactly.'
    const requestContinuation = vi.fn().mockResolvedValue({
      content: continuation,
      finishReason: 'stop',
    })

    await completeBoundedCompletion({
      initial: { content: initial, finishReason: 'length' },
      mode,
      maxContinuations: 1,
      originalPrompt,
      writingLanguage: 'en-US',
      requestContinuation,
    })

    const continuationPrompt = requestContinuation.mock.calls[0]?.[0] as string
    expect(continuationPrompt).toContain(expectedInstruction)
    expect(continuationPrompt).toContain(originalPrompt)
    expect(continuationPrompt).not.toContain('上一轮')
  })

  it('replaces a partial structured response only after a complete replacement arrives', async () => {
    const requestContinuation = vi.fn()
      .mockResolvedValueOnce({ content: '{"chapters":[', finishReason: 'length' })
      .mockResolvedValueOnce({ content: '{"chapters":[{"number":1}]}', finishReason: 'stop' })

    await expect(completeBoundedCompletion({
      initial: { content: '<think>hidden</think>{"chapters":[', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 2,
      originalPrompt: '返回章节 JSON',
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).resolves.toBe('{"chapters":[{"number":1}]}')

    expect(requestContinuation).toHaveBeenCalledTimes(2)
    expect(requestContinuation.mock.calls[0]?.[0]).toContain('返回完整 JSON，从头重建，不要只补后缀')
    expect(requestContinuation.mock.calls[0]?.[0]).toContain('返回章节 JSON')
    expect(requestContinuation.mock.calls[0]?.[0]).not.toContain('<think>')
  })

  it('does not apply visible-prose completeness rules to structured replacement output', async () => {
    const fencedJson = '```json\n{"complete":true}\n```'

    await expect(completeBoundedCompletion({
      initial: { content: fencedJson, finishReason: 'stop' },
      mode: 'replace-structured-output',
      maxContinuations: 2,
      originalPrompt: '返回 JSON',
      writingLanguage: 'zh-CN',
      requestContinuation: vi.fn(),
    })).resolves.toBe(fencedJson)
  })

  it('fails closed after the configured structured continuation limit', async () => {
    const requestContinuation = vi.fn().mockResolvedValue({ content: '{"half":', finishReason: 'length' })

    const completion = completeBoundedCompletion({
      initial: { content: '{"half":', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 2,
      originalPrompt: '返回 JSON',
      writingLanguage: 'zh-CN',
      requestContinuation,
    })

    await expect(completion).rejects.toThrow(
      'AI 输出连续达到本次请求长度限制，已自动续写 2 次，尚未完整生成。',
    )
    await expect(completion).rejects.not.toThrow(/模型最大长度|结果未被保存/)

    expect(requestContinuation).toHaveBeenCalledTimes(2)
  })

  it('describes provider length as this request limit and retains the failure code', () => {
    const error = createBoundedCompletionError('length')

    expect(error).toMatchObject({
      failureCode: 'length',
      message: 'AI 输出达到本次请求长度限制，尚未完整生成。请缩短本次任务或拆分为更小批次后重试。',
    })
    expect(error.message).not.toMatch(/模型最大长度|结果未被保存/)
  })

  it('localizes terminal errors by UI locale without changing the writing-language prompt', async () => {
    const requestContinuation = vi.fn().mockResolvedValue({
      content: '{"chapters":[',
      finishReason: 'length',
    })

    await expect(completeBoundedCompletion({
      initial: { content: '{"chapters":[', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 1,
      originalPrompt: '返回章节 JSON',
      writingLanguage: 'zh-CN',
      uiLocale: 'en-US',
      requestContinuation,
    })).rejects.toThrow(
      'Automatic continuation ran 1 time, but the output is not yet complete',
    )

    expect(requestContinuation).toHaveBeenCalledOnce()
    expect(requestContinuation.mock.calls[0]?.[0]).toContain('上一轮结构化输出因长度限制而中断')
    expect(requestContinuation.mock.calls[0]?.[0]).not.toContain('The previous structured output')
  })

  it.each(['content_filter', 'cancelled', 'error', 'unknown'] as const)(
    'fails closed without continuing a %s completion',
    async (finishReason) => {
      const requestContinuation = vi.fn()

      await expect(completeBoundedCompletion({
        initial: { content: '不可保存的输出', finishReason },
        mode: 'append-visible-text',
        maxContinuations: 3,
        originalPrompt: '写一段正文',
        writingLanguage: 'zh-CN',
        requestContinuation,
      })).rejects.toThrow(/结果未被保存/)

      expect(requestContinuation).not.toHaveBeenCalled()
    },
  )

  it('retains a content-filter terminal reason as structured failure metadata', async () => {
    const requestContinuation = vi.fn()

    try {
      await completeBoundedCompletion({
        initial: { content: '不可保存的输出', finishReason: 'content_filter' },
        mode: 'append-visible-text',
        maxContinuations: 3,
        originalPrompt: '写一段正文',
        writingLanguage: 'zh-CN',
        requestContinuation,
      })
      throw new Error('expected a bounded completion failure')
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedCompletionFailure)
      expect(error).toMatchObject({
        failureCode: 'content_filter',
        message: 'AI 输出因内容限制而未完成，结果未被保存。',
      })
    }

    expect(requestContinuation).not.toHaveBeenCalled()
  })

  it('checks cancellation before requesting a continuation', async () => {
    const requestContinuation = vi.fn()

    await expect(completeBoundedCompletion({
      initial: { content: '半截正文', finishReason: 'length' },
      mode: 'append-visible-text',
      maxContinuations: 3,
      originalPrompt: '写一段正文',
      writingLanguage: 'zh-CN',
      requestContinuation,
      isCancelled: () => true,
    })).rejects.toThrow('工作流已取消')

    expect(requestContinuation).not.toHaveBeenCalled()
  })

  it('overlap-merges an ordinary visible text continuation', async () => {
    const repeatedTail = '林岚推开办公室的门，屏幕上的航班编号仍在闪烁。'.repeat(3)
    const text = await completeBoundedCompletion({
      initial: { content: `开头。\n\n${repeatedTail}`, finishReason: 'length' },
      mode: 'append-visible-text',
      maxContinuations: 3,
      originalPrompt: '续写正文',
      writingLanguage: 'zh-CN',
      requestContinuation: vi.fn().mockResolvedValue({
        content: `${repeatedTail}\n\n周砚把监控画面停在三点十七分。`,
        finishReason: 'stop',
      }),
    })

    expect(text).toContain('周砚把监控画面停在三点十七分')
    expect(text.match(/林岚推开办公室的门/g)).toHaveLength(3)
    expect(appendVisibleTextContinuation('甲'.repeat(60), `${'甲'.repeat(60)}乙`)).toBe(`${'甲'.repeat(60)}\n\n乙`)
  })

  it.each([
    ['no visible prose', '<think>finished internally</think>'],
    ['only the already generated prose', '半截修稿正文。'.repeat(20)],
  ])('fails closed when a stop continuation adds %s', async (_label, continuationContent) => {
    const partial = '半截修稿正文。'.repeat(20)

    await expect(completeBoundedCompletion({
      initial: { content: partial, finishReason: 'length' },
      mode: 'append-visible-text',
      maxContinuations: 3,
      originalPrompt: '输出完整修稿',
      writingLanguage: 'zh-CN',
      requestContinuation: vi.fn().mockResolvedValue({
        content: continuationContent,
        finishReason: 'stop',
      }),
    })).rejects.toThrow('续写未增加新的可见正文')
  })

  it.each([
    ['a code fence', `\`\`\`markdown\n${'完整正文。'.repeat(40)}\n\`\`\``, '代码围栏'],
    ['opening meta-talk', `以下是根据您的要求修订后的完整章节。\n\n${'完整正文。'.repeat(40)}`, '首段元话术'],
    ['single-line opening meta-talk', `以下是根据您的要求修订后的完整章节。\n${'完整正文。'.repeat(40)}`, '首段元话术'],
    ...['以下是修订后的完整正文：', '以下是修订后的完整章节正文：', 'Here is the revised chapter:', 'Below is the complete text:']
      .map(opening => ['explicit output introduction', `${opening}\n\n${'完整正文。'.repeat(40)}`, '首段元话术']),
    ['a truncation marker', `${'完整正文。'.repeat(40)}\n\n…[内容已按上下文预算截断]…`, '截断标记'],
    ['an orphan think fragment', `${'完整正文。'.repeat(40)}\n\n</think`, 'think 标签残片'],
    ['an obvious repeated paragraph', `${'重复段落内容。'.repeat(20)}\n\n${'重复段落内容。'.repeat(20)}`, '重复段落'],
    ['an obvious repeated single-line block', `${'重复段落内容。'.repeat(20)}\n${'重复段落内容。'.repeat(20)}`, '重复段落'],
  ])('fails closed when completed visible text contains %s', async (_label, content, message) => {
    const requestContinuation = vi.fn()

    await expect(completeBoundedCompletion({
      initial: { content, finishReason: 'stop' },
      mode: 'append-visible-text',
      maxContinuations: 3,
      originalPrompt: '输出完整修稿',
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).rejects.toThrow(message)

    expect(requestContinuation).not.toHaveBeenCalled()
  })

  it('removes a malformed closing think tag together with a hidden prefix longer than 300 characters', () => {
    const hiddenReasoning = `推理过程：${'隐藏步骤。'.repeat(61)}`
    const normalTextBeforeAnOrphanTag = '林岚已经写下第一段正文。'.repeat(61)

    expect(redactVisibleCompletionText(`${hiddenReasoning}</think>{"complete":true}`))
      .toBe('{"complete":true}')
    expect(redactVisibleCompletionText('没有任何思考标签的正常正文')).toBe('没有任何思考标签的正常正文')
    expect(redactVisibleCompletionText(`${normalTextBeforeAnOrphanTag}</think>周砚推门进来。`))
      .toBe(`${normalTextBeforeAnOrphanTag}周砚推门进来。`)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 8])(
    'rejects an invalid continuation limit before accepting a completion (%s)',
    async (maxContinuations) => {
      const requestContinuation = vi.fn()

      await expect(completeBoundedCompletion({
        initial: { content: '完整输出', finishReason: 'stop' },
        mode: 'append-visible-text',
        maxContinuations,
        originalPrompt: '写一段正文',
        writingLanguage: 'zh-CN',
        requestContinuation,
      })).rejects.toThrow('自动续写次数必须是 0 到 7 的整数')

      expect(requestContinuation).not.toHaveBeenCalled()
    },
  )

  it.each([
    { mode: 'replace-structured-output' as const, maxContinuations: 3, expectedLimit: 2 },
    { mode: 'append-visible-text' as const, maxContinuations: 4, expectedLimit: 3 },
  ])('enforces the $expectedLimit-round $mode policy', async ({ mode, maxContinuations, expectedLimit }) => {
    const requestContinuation = vi.fn()

    await expect(completeBoundedCompletion({
      initial: { content: '完整输出', finishReason: 'stop' },
      mode,
      maxContinuations,
      originalPrompt: '写一段正文',
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).rejects.toThrow(`当前输出类型最多自动续写 ${expectedLimit} 次`)

    expect(requestContinuation).not.toHaveBeenCalled()
  })

  it('preserves the complete structured task and visible reference', async () => {
    const originalPrompt = `任务合同开头：必须返回完整章节 JSON。\n${'原始任务内容'.repeat(1_500)}\n任务合同结尾：不得只补后缀。`
    const partial = `上一轮输出开头：{"chapters":[\n${'不完整可见 JSON'.repeat(1_500)}\n上一轮输出结尾：{"number":1}`
    const requestContinuation = vi.fn().mockResolvedValue({
      content: '{"chapters":[{"number":1}]}',
      finishReason: 'stop',
    })

    await expect(completeBoundedCompletion({
      initial: { content: partial, finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 1,
      originalPrompt,
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).resolves.toBe('{"chapters":[{"number":1}]}')

    const continuationPrompt = requestContinuation.mock.calls[0]?.[0] as string
    expect(continuationPrompt).toContain(originalPrompt)
    expect(continuationPrompt).toContain(partial)
    expect(continuationPrompt).not.toContain('内容已按上下文预算截断')
  })

  it('delegates structured replacement fit to the generation session without truncating the contract', async () => {
    const originalPrompt = '返回完整 JSON'
    const partial = '{"half":'
    const requestContinuation = vi.fn().mockResolvedValue({
      content: '{"complete":true}',
      finishReason: 'stop',
    })

    await expect(completeBoundedCompletion({
      initial: { content: partial, finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 1,
      originalPrompt,
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).resolves.toBe('{"complete":true}')

    const continuationPrompt = requestContinuation.mock.calls[0]?.[0] as string
    expect(continuationPrompt).toContain(originalPrompt)
    expect(continuationPrompt).toContain(partial)
  })

  it.each([
    { code: 'CONTEXT_BUDGET_EXHAUSTED', contextWindowTokens: 2_500, maxAttempts: 8, maxRequestedOutputTokens: 65_536 },
    { code: 'ATTEMPT_BUDGET_EXHAUSTED', contextWindowTokens: null, maxAttempts: 1, maxRequestedOutputTokens: 65_536 },
    { code: 'REQUESTED_TOKEN_BUDGET_EXHAUSTED', contextWindowTokens: null, maxAttempts: 8, maxRequestedOutputTokens: 8192 },
  ])('retains the partial without dispatch when the generation session rejects $code', async ({
    code, contextWindowTokens, maxAttempts, maxRequestedOutputTokens,
  }) => {
    const partial = '先前已经生成的世界观内容。'.repeat(400)
    const originalPrompt = '完整作者材料。'.repeat(150)
    const complete = vi.fn().mockResolvedValue({ content: partial, finishReason: 'length' })
    const session = createGenerationHarness({
      modelSource: { snapshotDefaultModel: () => ({
        model: { id: 'bounded-model', provider: 'custom', protocol: 'openai', modelName: 'bounded-model',
          baseUrl: 'https://provider.example/v1', maxTokens: 8192 },
        revision: 'bounded-model-revision', modelExecutionLeaseId: 'bounded-model-lease',
        resolvedCapabilities: { contextWindowTokens, maxOutputTokens: 8192, reasoning: null, structuredOutput: null, usage: null,
          source: { contextWindowTokens: contextWindowTokens === null ? 'unknown' : 'user-operational-cap',
            maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' } },
      }) },
      completionPort: { complete },
      policy: { maxAttempts, maxRequestedOutputTokens, maxRequestedOutputTokensPerAttempt: 8192, deadlineMs: 60_000 },
    }).openSession()
    const task = (prompt: string) => ({
      purpose: 'generate-world-building', output: 'visible-text' as const,
      messages: [{ role: 'user' as const, content: prompt }],
    })
    const initial = await session.complete(task(originalPrompt))
    const onInterrupted = vi.fn()
    const requestContinuation = vi.fn((prompt: string) => session.complete(task(prompt)))

    await expect(completeBoundedCompletion({
      initial, mode: 'append-visible-text', maxContinuations: 3, originalPrompt,
      writingLanguage: 'zh-CN', requestContinuation, onInterrupted,
    })).rejects.toMatchObject({ code })

    expect(requestContinuation).toHaveBeenCalledOnce()
    expect(requestContinuation.mock.calls[0]?.[0]).toContain(originalPrompt)
    expect(complete).toHaveBeenCalledOnce()
    expect(onInterrupted).toHaveBeenCalledExactlyOnceWith(partial)
  })
})


it('pure visible-append-v1 retains original UTF16 overlap and whitespace behavior', () => {
  expect(VISIBLE_CONTINUATION_VERSION).toBe('visible-append-v1')
  const cases: Array<[string, string, string]> = [
    ['甲'.repeat(47), '甲'.repeat(47) + '乙', '甲'.repeat(47) + '\n\n' + '甲'.repeat(47) + '乙'],
    ['甲'.repeat(48), '甲 '.repeat(48) + '\n  乙', '甲'.repeat(48) + '\n\n乙'],
    ['开头' + '甲'.repeat(1600), '甲'.repeat(1600) + '尾声', '开头' + '甲'.repeat(1600) + '\n\n尾声'],
    ['', '  雨夜\r\n', '雨夜'],
    ['雨夜', '', '雨夜'],
    ['甲'.repeat(48), '甲'.repeat(48), '甲'.repeat(48)],
    ['𠮷'.repeat(24), '𠮷'.repeat(24) + '乙', '𠮷'.repeat(24) + '\n\n乙'],
  ]
  for (const [existing, addition, expected] of cases) {
    expect(composeVisibleContinuation(existing, addition)).toBe(expected)
    expect(appendVisibleTextContinuation(existing, addition)).toBe(expected)
  }
  expect(appendVisibleTextContinuation('<think>隐藏</think>雨夜', '<think>隐藏</think>来信')).toBe('雨夜\n\n来信')
})
