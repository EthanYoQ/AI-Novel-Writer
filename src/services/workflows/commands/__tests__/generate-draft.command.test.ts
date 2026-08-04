import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  GenerateDraftCommand,
  countDraftUnits,
  resolveDraftModelLimits,
  sanitizeDraftText,
} from '../generate-draft.command'

describe('generate draft command text cleanup', () => {
  it('removes thinking residue and continue UI prompts from draft text', () => {
    const text = sanitizeDraftText(`<think>分析过程</think>

点我继续生成后续内容

林岚推开办公室的门，屏幕上的航班编号仍在闪烁。`)

    expect(text).not.toContain('<think>')
    expect(text).not.toContain('点我继续')
    expect(text).toContain('林岚推开办公室的门')
  })

  it('deduplicates repeated long paragraphs while keeping distinct paragraphs', () => {
    const repeated = '林岚握紧手中的U盘，屏幕蓝光映在她的指节上，走廊尽头传来压低的脚步声，她没有回头，只把那串航班编号重新敲进检索框。'
    const unique = '周砚没有立刻回答，只把监控画面停在三点十七分。'
    const text = sanitizeDraftText(`${repeated}

${unique}

${repeated}`)

    expect(text.match(/林岚握紧手中的U盘/g)).toHaveLength(1)
    expect(text).toContain(unique)
  })

  it('counts Chinese characters and English words for auto-continue thresholds', () => {
    expect(countDraftUnits('林岚\n\n 推门')).toBe(4)
    expect(countDraftUnits('林岚 walked into the room.')).toBe(6)
  })

  it('does not delete previous manuscript when a later continuation contains dangling think residue', () => {
    const previous = '林岚已经写下第一段正文。'.repeat(80)
    const text = sanitizeDraftText(`${previous}

碎片
</think>

周砚推门走进监控室。`)

    expect(text).toContain('林岚已经写下第一段正文')
    expect(text).toContain('周砚推门走进监控室')
    expect(text).not.toContain('</think>')
  })
})

describe('GenerateDraftCommand cancellation boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
  })

  it('does not query a version or persist a draft after the main LLM request is cancelled', async () => {
    const projectPath = 'C:\\novels\\A'
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      void args
      if (channel === 'db:project-core-get') {
        return { premise: '故事前提', charactersArch: '', worldbuilding: '', synopsis: '' }
      }
      if (channel === 'fs:list-dir' || channel === 'db:character-get-all' || channel === 'db:blueprint-get-all') {
        return []
      }
      throw new Error(`unexpected IPC write/read: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })
    useProjectStore.setState({
      currentProject: {
        id: 'main',
        name: 'A',
        path: projectPath,
        sessionLease: 'lease-main',
        novelConfig: {
          totalChapters: 10,
          wordsPerChapter: 3000,
        },
      } as never,
    })
    const context: WorkflowContext = {
      runId: 'draft-cancel',
      projectPath,
      projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath },
      data: {},
      cancelled: false,
    }
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }
    let resolveLlm: ((value: { content: string; finishReason: 'stop' }) => void) | undefined
    const command = new GenerateDraftCommand({
      projectPath,
      chapterNumber: 1,
      title: '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '开端',
      characters: [],
    })
    vi.spyOn(
      command as unknown as { callLLMResultWithBuilder: () => Promise<{ content: string; finishReason: 'stop' }> },
      'callLLMResultWithBuilder',
    ).mockImplementation(() => new Promise<{ content: string; finishReason: 'stop' }>((resolve) => { resolveLlm = resolve }))

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveLlm).toBeTypeOf('function'))
    context.cancelled = true
    resolveLlm!({ content: '不应保存的正文', finishReason: 'stop' })

    await expect(execution).rejects.toThrow('工作流已取消')
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })
})

describe('GenerateDraftCommand truncation boundary', () => {
  const projectPath = 'C:\\novels\\truncation'

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
    useLLMStore.setState({ defaultModelId: null, models: [] })
  })

  function setup(
    wordsPerChapter: number,
    wordsTarget?: number,
    defaultModelMaxTokens?: number,
    options: {
      capabilities?: { contextWindowTokens?: number | null; maxOutputTokens?: number | null; reasoning?: boolean }
      premise?: string
    } = {},
  ) {
    useLLMStore.setState(defaultModelMaxTokens === undefined
      ? { defaultModelId: 'missing-draft-model', models: [] }
      : {
          defaultModelId: 'draft-model',
          models: [{
            id: 'draft-model',
            name: 'Draft model',
            provider: 'openai',
            protocol: 'openai',
            modelName: 'draft-model',
            apiKey: '',
            baseUrl: 'https://example.invalid',
            temperature: 0.88,
            maxTokens: defaultModelMaxTokens,
            capabilities: options.capabilities as never,
            purposes: ['generation'],
          }] as never,
        })
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      void args
      if (channel === 'db:project-core-get') {
        return { premise: options.premise ?? '故事前提', charactersArch: '', worldbuilding: '', synopsis: '' }
      }
      if (channel === 'fs:list-dir' || channel === 'db:character-get-all') return []
      if (channel === 'db:draft-next-version') return 1
      if (channel === 'db:draft-create') return { success: true, id: 'draft-1' }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })
    useProjectStore.setState({
      currentProject: {
        id: 'truncation',
        name: 'truncation',
        path: projectPath,
        sessionLease: 'lease-truncation',
        novelConfig: { totalChapters: 10, wordsPerChapter },
      } as never,
      refreshFileTree: vi.fn().mockResolvedValue(undefined),
    })
    const context: WorkflowContext = {
      runId: 'draft-truncation',
      projectPath,
      projectSession: { projectId: 'truncation', leaseId: 'lease-truncation', projectPath },
      data: {},
      cancelled: false,
    }
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }
    const command = new GenerateDraftCommand({
      projectPath,
      chapterNumber: 1,
      title: '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '开端',
      characters: [],
      wordsTarget,
    })
    return { invoke, context, callbacks, command }
  }

  it('uses the chapter target for the prompt, output budget, and bounded persisted draft', async () => {
    const { invoke, context, callbacks, command } = setup(6000, 3000)
    const overlongDraft = Array.from(
      { length: 20 },
      (_, index) => `第${index + 1}段${'甲'.repeat(195)}。`,
    ).join('\n\n')
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: overlongDraft, finishReason: 'stop' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: '不应续写。', finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBeTruthy()

    const builder = initial.mock.calls[0]?.[0] as { build: () => string }
    expect(builder.build()).toContain('大约 3000 字左右')
    expect(initial.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 2240 })
    expect(continuation).not.toHaveBeenCalled()
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedContent = (persisted?.[1] as { content: string } | undefined)?.content
    expect(persistedContent).toBeDefined()
    expect(countDraftUnits(persistedContent!)).toBeLessThanOrEqual(3360)
    expect(persistedContent).toMatch(/[。！？]$/)
  })

  it('caps an overlong first English paragraph at a .?! sentence boundary', async () => {
    const { invoke, context, callbacks, command } = setup(3000, 3000)
    const overlongEnglishDraft = Array.from(
      { length: 40 },
      (_, index) => `Sentence ${index + 1} ${'word '.repeat(100).trim()}${['.', '?', '!'][index % 3]}`,
    ).join(' ')
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: overlongEnglishDraft, finishReason: 'stop' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: 'This should not be requested.', finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBeTruthy()

    expect(initial).toHaveBeenCalledTimes(1)
    expect(continuation).not.toHaveBeenCalled()
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedContent = (persisted?.[1] as { content: string } | undefined)?.content
    expect(persistedContent).toBeTruthy()
    expect(countDraftUnits(persistedContent!)).toBeLessThanOrEqual(3360)
    expect(persistedContent).toMatch(/[.?!]$/)
  })

  it('continues a large draft only below the target lower bound and with the remaining target budget', async () => {
    const { invoke, context, callbacks, command } = setup(6000)
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '初'.repeat(4500), finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: `${'续'.repeat(1000)}。`, finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(continuation).toHaveBeenCalledTimes(1)
    expect(initial.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 4096 })
    expect(continuation.mock.calls[0]?.[0]).toContain('剩余约 1500 字')
    expect(continuation.mock.calls[0]?.[3]).toMatchObject({ maxTokens: 1480 })
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect(persisted?.[1]).toMatchObject({ content: expect.stringContaining('续') })
  })

  it('does not let a length finish bypass the target lower bound', async () => {
    const { invoke, context, callbacks, command } = setup(6000)
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: `${'初'.repeat(5000)}。`, finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: '不应续写。', finishReason: 'length' })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('AI 输出达到模型最大长度，结果不完整')

    expect(initial.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 4096 })
    expect(continuation).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })

  it('does not persist a content-filtered response even when it reaches the target lower bound', async () => {
    const { invoke, context, callbacks, command } = setup(3000)
    vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'content_filter' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: `${'初'.repeat(3000)}。`, finishReason: 'content_filter' })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('AI 输出因内容限制而未完成')

    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })

  it('caps every large-chapter request at the configured default model maximum', async () => {
    const { context, callbacks, command } = setup(20_000, 20_000, 1024)
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '初'.repeat(1000), finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: `${'续'.repeat(16_000)}。`, finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(initial.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 1024 })
    expect(continuation).toHaveBeenCalledTimes(1)
    expect(continuation.mock.calls[0]?.[3]).toMatchObject({ maxTokens: 1024 })
  })

  it('uses capability output limits while preserving legacy maxTokens and unknown context', () => {
    expect(resolveDraftModelLimits({
      maxTokens: 1024,
      capabilities: {
        contextWindowTokens: null,
        maxOutputTokens: 4096,
      },
    })).toEqual({
      contextWindowTokens: null,
      maxOutputTokens: 4096,
      reasoning: false,
    })

    expect(resolveDraftModelLimits({
      maxTokens: 1536,
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: null,
      },
    })).toEqual({
      contextWindowTokens: 32_768,
      maxOutputTokens: 1536,
      reasoning: false,
    })
  })

  it('fails before the first network call when a declared context window cannot fit the prompt and output budget', async () => {
    const { invoke, context, callbacks, command } = setup(3000, 3000, 512, {
      capabilities: { contextWindowTokens: 256, maxOutputTokens: 512 },
    })
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '不应联网。', finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('输入上下文预算')

    expect(initial).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })

  it('uses a conservative safety budget instead of claiming an unknown context window is sufficient', async () => {
    const { invoke, context, callbacks, command } = setup(3000, 3000, 1024, {
      capabilities: { contextWindowTokens: null, maxOutputTokens: 1024 },
      premise: '设定'.repeat(13_000),
    })
    const initial = vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '不应联网。', finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('未声明上下文窗口')

    expect(initial).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })

  it('fails with a reasoning-specific action when hidden reasoning exhausts output before visible prose', async () => {
    const { invoke, context, callbacks, command } = setup(3000, 3000, 1024, {
      capabilities: { contextWindowTokens: 32_768, maxOutputTokens: 1024, reasoning: true },
    })
    vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '<think>推理耗尽</think>', finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as { callLLMResult: (...args: unknown[]) => Promise<never> },
      'callLLMResult',
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('无法安全续接隐藏推理过程')
    expect(continuation).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })

  it('only continues an incomplete draft after a length finish', async () => {
    const { context, callbacks, command } = setup(3000, 3000)
    vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '初'.repeat(200), finishReason: 'stop' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: '不应续写。', finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('明显未达到章节目标')

    expect(continuation).not.toHaveBeenCalled()
  })

  it('continues with visible text only and removes an overlapping repeated tail', async () => {
    const { invoke, context, callbacks, command } = setup(3000, 3000)
    const tail = '尾'.repeat(100)
    const initialDraft = `${'初'.repeat(1000)}<think>不应进入续写上下文</think>${tail}`
    vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: initialDraft, finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'stop' }>
      },
      'callLLMResult',
    ).mockResolvedValue({ content: `${tail}${'续'.repeat(1600)}。`, finishReason: 'stop' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    const continuationPrompt = continuation.mock.calls[0]?.[0] ?? ''
    expect(continuationPrompt).not.toContain('<think>')
    expect(continuationPrompt).not.toContain('不应进入续写上下文')
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedContent = (persisted?.[1] as { content: string } | undefined)?.content ?? ''
    expect(persistedContent.match(/尾/g)).toHaveLength(100)
  })

  it('stops after a bounded number of length continuations and never persists a still-truncated draft', async () => {
    const { invoke, context, callbacks, command } = setup(20_000, 20_000, 1024)
    vi.spyOn(
      command as unknown as {
        callLLMResultWithBuilder: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResultWithBuilder',
    ).mockResolvedValue({ content: '初'.repeat(1000), finishReason: 'length' })
    const continuation = vi.spyOn(
      command as unknown as {
        callLLMResult: (...args: unknown[]) => Promise<{ content: string; finishReason: 'length' }>
      },
      'callLLMResult',
    ).mockImplementation(async () => ({
      content: `第${continuation.mock.calls.length}段${'续'.repeat(1000)}。`,
      finishReason: 'length' as const,
    }))

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('AI 输出达到模型最大长度，结果不完整')

    expect(continuation).toHaveBeenCalledTimes(7)
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })
})
