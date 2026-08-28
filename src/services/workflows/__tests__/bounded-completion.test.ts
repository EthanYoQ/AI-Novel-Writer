import { describe, expect, it, vi } from 'vitest'

import {
  appendVisibleTextContinuation,
  BoundedCompletionFailure,
  completeBoundedCompletion,
  redactVisibleCompletionText,
} from '../bounded-completion'

describe('bounded completion', () => {
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

    await expect(completeBoundedCompletion({
      initial: { content: '{"half":', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 2,
      originalPrompt: '返回 JSON',
      writingLanguage: 'zh-CN',
      requestContinuation,
    })).rejects.toThrow('已自动续写 2 次仍未完成')

    expect(requestContinuation).toHaveBeenCalledTimes(2)
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

  it.each([
    { label: 'declared 8k context', contextWindowTokens: 8_192 },
    { label: 'unknown context', contextWindowTokens: null },
  ])('bounds $label continuation prompts while preserving the task contract and visible reference', async ({ contextWindowTokens }) => {
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
      promptBudget: {
        contextWindowTokens,
        maxOutputTokens: 4_096,
        systemPromptChars: 0,
      },
      requestContinuation,
    })).resolves.toBe('{"chapters":[{"number":1}]}')

    const continuationPrompt = requestContinuation.mock.calls[0]?.[0] as string
    // 8,192 context - 4,096 output - 512 reserve, estimated at 1.5 chars/token.
    expect(continuationPrompt.length).toBeLessThanOrEqual(5_376)
    expect(continuationPrompt).toContain('任务合同开头')
    expect(continuationPrompt).toContain('任务合同结尾')
    expect(continuationPrompt).toContain('上一轮输出开头')
    expect(continuationPrompt).toContain('上一轮输出结尾')
  })

  it('fails closed before requesting continuation when the reserved context cannot hold a safe contract', async () => {
    const requestContinuation = vi.fn()

    await expect(completeBoundedCompletion({
      initial: { content: '{"half":', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 1,
      originalPrompt: '返回完整 JSON',
      writingLanguage: 'zh-CN',
      promptBudget: {
        contextWindowTokens: 4_096,
        maxOutputTokens: 4_096,
      },
      requestContinuation,
    })).rejects.toThrow('当前模型上下文预算不足以安全续写')

    expect(requestContinuation).not.toHaveBeenCalled()
  })

  it('does not fabricate an 8192 context window and pre-reject an unknown model with an 8192 output cap', async () => {
    const requestContinuation = vi.fn().mockResolvedValue({
      content: '{"chapters":[]}',
      finishReason: 'stop',
    })

    await expect(completeBoundedCompletion({
      initial: { content: '{"chapters":[', finishReason: 'length' },
      mode: 'replace-structured-output',
      maxContinuations: 1,
      originalPrompt: '返回完整 JSON',
      writingLanguage: 'zh-CN',
      promptBudget: {
        contextWindowTokens: null,
        maxOutputTokens: 8192,
      },
      requestContinuation,
    })).resolves.toBe('{"chapters":[]}')

    expect(requestContinuation).toHaveBeenCalledOnce()
  })
})
