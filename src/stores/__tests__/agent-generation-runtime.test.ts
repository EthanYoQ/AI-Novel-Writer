import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerationRuntime } from '../../services/generation/generation-runtime'
import type { GenerationSession } from '../../services/generation/generation-harness'
import { useLLMStore } from '../llm-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { toolRegistry } from '../../services/agent/tool-registry'
import { skillRegistry } from '../../services/agent/skill-registry'
import { promptCatalog } from '../../services/prompt-templates'
import { ipcPromptPersistence } from '../../services/prompt-catalog'
import {
  AGENT_GENERATION_BUDGET,
  useAgentStore,
} from '../agent-store'

const generationRuntime = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('../../services/generation/generation-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/generation/generation-runtime')>(),
  createGenerationRuntime: generationRuntime.create,
}))

function completed(content: string, attempt: number) {
  return {
    status: 'completed' as const,
    content,
    finishReason: 'stop' as const,
    receipt: {
      model: { id: 'model-a', configurationRevision: 'r1', endpointFingerprint: 'f1' },
      capabilities: {
        contextWindowTokens: null,
        maxOutputTokens: 2048,
        reasoning: null,
        structuredOutput: null,
        usage: null,
        source: {
          contextWindowTokens: 'unknown' as const,
          maxOutputTokens: 'user-operational-cap' as const,
          featureFlags: 'unknown' as const,
        },
      },
      budget: {
        attempt,
        maxAttempts: 8,
        requestedOutputTokens: 2048,
        cumulativeRequestedOutputTokens: attempt * 2048,
        maxRequestedOutputTokens: 65_536,
        maxRequestedOutputTokensPerAttempt: 8192,
        deadlineAt: Date.now() + 60_000,
      },
      finishReason: 'stop' as const,
    },
  }
}

describe('Agent GenerationRuntime boundary', () => {
  beforeEach(() => {
    useAgentStore.setState({
      conversations: [],
      activeConversationId: null,
      generating: false,
      activeRequestId: null,
      toolsInitialized: true,
    })
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useLLMStore.setState({ defaultModelId: 'model-a' })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid') })
  })

  afterEach(() => {
    useProjectStore.setState({ currentProject: null })
    promptCatalog.clearProject()
    generationRuntime.create.mockReset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('freezes the selected conversation model and reuses one session across tool-loop turns', async () => {
    const complete = vi.fn<GenerationSession['complete']>()
      .mockImplementationOnce(async () => {
        useLLMStore.setState({ defaultModelId: 'model-b' })
        return completed('<tool_call>{"name":"missing_probe","arguments":{}}</tool_call>', 1)
      })
      .mockResolvedValueOnce(completed('最终回复', 2))
    const close = vi.fn(async () => {})
    const runtime: GenerationRuntime = {
      execute: async operation => {
        try {
          return await operation({
            session: {
              complete,
              budget: {
                maxAttempts: AGENT_GENERATION_BUDGET.maxAttempts,
                maxRequestedOutputTokens: AGENT_GENERATION_BUDGET.maxRequestedOutputTokens,
                maxRequestedOutputTokensPerAttempt: AGENT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
                deadlineAt: Date.now() + AGENT_GENERATION_BUDGET.deadlineMs,
              },
            },
          })
        } finally {
          await close()
        }
      },
      close,
    }
    const createRuntime = vi.fn(async () => runtime)
    generationRuntime.create.mockImplementation(createRuntime)
    const conversation = useAgentStore.getState().createConversation()
    useAgentStore.getState().setModelId('model-a')

    await useAgentStore.getState().sendMessage('检查项目')

    expect(createRuntime).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledWith({
      modelId: 'model-a',
      budget: AGENT_GENERATION_BUDGET,
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    const updated = useAgentStore.getState().conversations.find(item => item.id === conversation.id)
    expect(updated?.messages.at(-1)?.content).toBe('最终回复')
  })

  it('creates the default conversation and /help response entirely in the frozen English UI locale', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })

    await useAgentStore.getState().sendMessage('/help')

    const conversation = useAgentStore.getState().getActiveConversation()
    expect(conversation?.title).toBe('New conversation')
    expect(conversation?.messages.at(-1)?.content).toContain('### Available commands')
    expect(conversation?.messages.at(-1)?.content).toContain('Show available commands and features')
    expect(conversation?.messages.at(-1)?.content).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('does not expose a runtime failure in the English conversation', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    generationRuntime.create.mockRejectedValue(new Error('provider-secret-runtime-failure'))

    await useAgentStore.getState().sendMessage('Please inspect the project')

    const content = useAgentStore.getState().getActiveConversation()?.messages.at(-1)?.content ?? ''
    expect(content).toBe('Generation failed. Please try again.')
    expect(content).not.toContain('provider-secret-runtime-failure')
  })

  it('keeps cancellation copy in the locale frozen when the turn started', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    let resolveCompletion: ((value: ReturnType<typeof completed>) => void) | undefined
    const complete = vi.fn<GenerationSession['complete']>(() => new Promise(resolve => {
      resolveCompletion = resolve
    }))
    const runtime: GenerationRuntime = {
      execute: async operation => operation({
        session: {
          complete,
          budget: {
            maxAttempts: AGENT_GENERATION_BUDGET.maxAttempts,
            maxRequestedOutputTokens: AGENT_GENERATION_BUDGET.maxRequestedOutputTokens,
            maxRequestedOutputTokensPerAttempt: AGENT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
            deadlineAt: Date.now() + AGENT_GENERATION_BUDGET.deadlineMs,
          },
        },
      }),
      close: vi.fn(async () => {}),
    }
    generationRuntime.create.mockResolvedValue(runtime)

    const send = useAgentStore.getState().sendMessage('Keep writing')
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    await useAgentStore.getState().cancelGeneration()

    expect(useAgentStore.getState().getActiveConversation()?.messages.at(-1)?.content)
      .toContain('_(Generation stopped)_')
    resolveCompletion?.(completed('ignored after cancellation', 1))
    await send
    expect(useAgentStore.getState().getActiveConversation()?.messages.at(-1)?.content)
      .toContain('_(Generation stopped)_')
  })

  it('builds Skill and mention prefetch instructions in the frozen project writing language', async () => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useProjectStore.setState({
      currentProject: {
        id: 'project-a',
        sessionLease: 'lease-a',
        path: 'C:/novels/project-a',
        name: 'Project A',
        characterStates: '',
        createdAt: '',
        updatedAt: '',
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    promptCatalog.clearProject()
    vi.spyOn(ipcPromptPersistence, 'loadProject').mockResolvedValue({ templates: [], diagnostics: [] })
    await skillRegistry.loadAll()
    const prefetchExecute = vi.fn(async (_args, executionContext) => {
      useLocaleStore.setState({ locale: 'en-US' })
      expect(executionContext).toMatchObject({
        uiLocale: 'zh-CN',
        writingLanguage: 'en-US',
      })
      return { success: true, content: 'Architecture facts' }
    })
    vi.spyOn(toolRegistry, 'get').mockImplementation(name => name === 'read_architecture'
      ? {
          name,
          description: 'Read architecture',
          parameters: { type: 'object', properties: {} },
          source: 'builtin',
          execute: prefetchExecute,
        } as never
      : undefined)
    const complete = vi.fn<GenerationSession['complete']>()
      .mockResolvedValue(completed('Done', 1))
    const runtime: GenerationRuntime = {
      execute: async operation => operation({
        session: {
          complete,
          budget: {
            maxAttempts: AGENT_GENERATION_BUDGET.maxAttempts,
            maxRequestedOutputTokens: AGENT_GENERATION_BUDGET.maxRequestedOutputTokens,
            maxRequestedOutputTokensPerAttempt: AGENT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
            deadlineAt: Date.now() + AGENT_GENERATION_BUDGET.deadlineMs,
          },
        },
      }),
      close: vi.fn(async () => {}),
    }
    generationRuntime.create.mockResolvedValue(runtime)
    useAgentStore.getState().createConversation()

    await useAgentStore.getState().sendMessage('/review-chapter Review chapter 1 with @architecture')

    const task = complete.mock.calls[0]?.[0]
    const userPayload = [...(task?.messages ?? [])].reverse().find(message => message.role === 'user')?.content ?? ''
    const modelPayload = (task?.messages ?? [])
      .filter(message => message.role === 'system' || message.role === 'user')
      .map(message => message.content)
      .join('\n')
    expect(userPayload).toContain('[The user invoked Skill: Chapter Review]')
    expect(userPayload).toContain('User input: Review chapter 1 with @architecture')
    expect(userPayload).toContain('# Chapter Review')
    expect(userPayload).toContain('[Prefetched context @read_architecture]')
    expect(userPayload).toContain('The following context was requested with @ and fetched automatically:')
    expect(modelPayload).not.toMatch(/[\u3400-\u9fff]/u)
    expect(prefetchExecute).toHaveBeenCalledOnce()
  })

  it('keeps project A runtime identity and policy when mention prefetch switches to project B', async () => {
    const projectA = {
      id: 'project-a',
      sessionLease: 'lease-a',
      path: 'C:/novels/project-a',
      name: 'Project A',
      characterStates: '',
      createdAt: '',
      updatedAt: '',
      novelConfig: { writingLanguage: 'en-US', creativeStrategy: 'consistency-first' },
    }
    const projectB = {
      ...projectA,
      id: 'project-b',
      sessionLease: 'lease-b',
      path: 'C:/novels/project-b',
      name: 'Project B',
      novelConfig: { writingLanguage: 'zh-CN', creativeStrategy: 'fluent-drafting' },
    }
    useProjectStore.setState({ currentProject: projectA as never })
    promptCatalog.clearProject()
    vi.spyOn(ipcPromptPersistence, 'loadProject').mockResolvedValue({ templates: [], diagnostics: [] })
    vi.spyOn(toolRegistry, 'get').mockImplementation(name => name === 'read_architecture'
      ? {
          name,
          description: 'Read architecture',
          parameters: { type: 'object', properties: {} },
          source: 'builtin',
          execute: vi.fn(async () => {
            useProjectStore.setState({ currentProject: projectB as never })
            return { success: true, content: 'Project A architecture' }
          }),
        } as never
      : undefined)
    generationRuntime.create.mockRejectedValue(new Error('stop after capturing runtime options'))
    useAgentStore.getState().createConversation()
    useAgentStore.getState().setModelId('model-a')

    await useAgentStore.getState().sendMessage('Check @architecture')

    expect(useProjectStore.getState().currentProject?.id).toBe('project-b')
    expect(generationRuntime.create).toHaveBeenCalledWith({
      modelId: 'model-a',
      projectSession: {
        projectId: 'project-a',
        leaseId: 'lease-a',
        projectPath: 'C:/novels/project-a',
      },
      creativeStrategy: 'consistency-first',
      budget: AGENT_GENERATION_BUDGET,
    })
  })
})
