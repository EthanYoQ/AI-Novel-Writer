import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as legacyRuntime from '../../services/generation/generation-runtime'
import { AgentHostFixture } from '../../services/agent/__tests__/agent-generation.fixture'
import { useLLMStore } from '../llm-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useEditorStore } from '../editor-store'
import { toolRegistry } from '../../services/agent/tool-registry'
import { skillRegistry } from '../../services/agent/skill-registry'
import { promptCatalog } from '../../services/prompt-templates'
import { ipcPromptPersistence } from '../../services/prompt-catalog'
import { useAgentStore } from '../agent-store'

const session = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:/synthetic/agent-a' }
const project = { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, name: '合成项目',
  characterStates: '', createdAt: '', updatedAt: '', novelConfig: { writingLanguage: 'zh-CN' as const, genre: '奇幻', subGenre: '',
    targetAudience: '', totalChapters: 10, wordsPerChapter: 3000, plotStructure: 'three_act' as const, narrativePOV: 'third_limited' as const,
    coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' } }
let fixture: AgentHostFixture
const lastMessage = () => useAgentStore.getState().getActiveConversation()?.messages.at(-1)
const calls = (channel: string) => fixture.invoke.mock.calls.filter(call => call[0] === channel)

describe('Agent GenerationRuntime boundary', () => {
  beforeEach(() => {
    useAgentStore.setState({ conversations: [], activeConversationId: null, generating: false, activeRequestId: null, toolsInitialized: true })
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    useLLMStore.setState({ defaultModelId: 'model-a' })
    useProjectStore.setState({ currentProject: structuredClone(project) })
    useEditorStore.setState({ tabs: [], activeTabId: null })
    fixture = new AgentHostFixture(session).install()
    vi.spyOn(legacyRuntime, 'createGenerationRuntime').mockRejectedValue(new Error('Legacy provider fallback forbidden'))
  })
  afterEach(() => {
    useProjectStore.setState({ currentProject: null })
    promptCatalog.clearProject()
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('freezes the selected conversation model and reuses one session across tool-loop turns', async () => {
    fixture.response = vi.fn(async index => {
      useLLMStore.setState({ defaultModelId: 'model-b' })
      return index === 0 ? '<tool_call>{"name":"missing_probe","arguments":{}}</tool_call>' : '最终回复'
    })
    useAgentStore.getState().createConversation()
    useAgentStore.getState().setModelId('model-a')
    await useAgentStore.getState().sendMessage('检查项目')
    expect(calls('agent-generation:begin')).toHaveLength(1)
    expect(calls('agent-generation:begin')[0][1]).toMatchObject({ modelId: 'model-a', input: { userMessage: '检查项目' } })
    expect(calls('agent-generation:round')).toHaveLength(2)
    for (const call of calls('agent-generation:round')) {
      expect(Object.keys(call[1] as object).sort()).toEqual(['handle', 'index'])
      expect(call[1]).toMatchObject({ handle: { rootActionId: 'agent-root', projectId: session.projectId } })
    }
    expect(fixture.recovery.modelId).toBe('model-a')
    expect(calls('generation:cancel')).toHaveLength(0)
    expect(legacyRuntime.createGenerationRuntime).not.toHaveBeenCalled()
    expect(lastMessage()?.content).toBe('最终回复')
    expect(lastMessage()?.mainGenerationHandle).toEqual(fixture.recovery.handle)
  })

  it('creates the default conversation and /help response entirely in the frozen English UI locale', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await useAgentStore.getState().sendMessage('/help')
    expect(useAgentStore.getState().getActiveConversation()?.title).toBe('New conversation')
    expect(lastMessage()?.content).toContain('### Available commands')
    expect(lastMessage()?.content).toContain('Show available commands and features')
    expect(lastMessage()?.content).not.toMatch(/[\u3400-\u9fff]/u)
    expect(calls('agent-generation:begin')).toHaveLength(0)
  })

  it('does not expose a runtime failure in the English conversation', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    fixture.beginError = new Error('provider-secret-runtime-failure')
    await useAgentStore.getState().sendMessage('Please inspect the project')
    expect(lastMessage()?.content).toBe('Generation failed. Please try again.')
    expect(lastMessage()?.content).not.toContain('provider-secret-runtime-failure')
  })

  it('keeps cancellation copy in the locale frozen when the turn started', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    let resolve!: (text: string) => void
    fixture.response = vi.fn(() => new Promise<string>(done => { resolve = done }))
    const send = useAgentStore.getState().sendMessage('Keep writing')
    await vi.waitFor(() => expect(fixture.response).toHaveBeenCalledOnce())
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    await useAgentStore.getState().cancelGeneration()
    expect(lastMessage()?.content).toContain('_(Generation stopped)_')
    expect(calls('generation:cancel')[0][1]).toMatchObject({ rootActionId: 'agent-root' })
    resolve('ignored after cancellation'); await send
    expect(lastMessage()?.content).toContain('_(Generation stopped)_')
    expect(lastMessage()?.content).not.toContain('ignored after cancellation')
  })

  it('builds Skill and mention prefetch instructions in the frozen project writing language', async () => {
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingLanguage: 'en-US' } } })
    fixture.writingLanguage = 'en-US'
    vi.spyOn(ipcPromptPersistence, 'loadProject').mockResolvedValue({ templates: [], diagnostics: [] })
    await skillRegistry.loadAll()
    const prefetchExecute = vi.fn(async (_args, executionContext) => {
      useLocaleStore.setState({ locale: 'en-US' })
      expect(executionContext).toMatchObject({ uiLocale: 'zh-CN', writingLanguage: 'en-US' })
      return { success: true, content: 'Architecture facts' }
    })
    vi.spyOn(toolRegistry, 'get').mockImplementation(name => name === 'read_architecture'
      ? { name, description: 'Read architecture', inputSchema: { type: 'object', properties: {} },
          source: 'builtin', execute: prefetchExecute, isReadOnly: true, requiresConfirmation: false } : undefined)
    await useAgentStore.getState().sendMessage('/review-chapter Review chapter 1 with @architecture')
    const payload = fixture.recovery.context.input.userMessage
    expect(payload).toContain('[The user invoked Skill: Chapter Review]')
    expect(payload).toContain('User input: Review chapter 1 with @architecture')
    expect(payload).toContain('# Chapter Review')
    expect(payload).toContain('[Prefetched context @read_architecture]')
    expect(payload).toContain('The following context was requested with @ and fetched automatically:')
    expect(fixture.recovery.context.initialMessages.map(message => message.content).join('\n')).not.toMatch(/[\u3400-\u9fff]/u)
    expect(prefetchExecute).toHaveBeenCalledOnce()
  })

  it('keeps project A runtime identity and policy when mention prefetch switches to project B', async () => {
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingLanguage: 'en-US', creativeStrategy: 'consistency-first' } } })
    const execute = vi.fn(async () => {
      useProjectStore.setState({ currentProject: { ...project, id: 'project-b', path: 'C:/synthetic/agent-b', sessionLease: 'lease-b' } })
      return { success: true, content: 'Project A architecture' }
    })
    vi.spyOn(toolRegistry, 'get').mockImplementation(name => name === 'read_architecture'
      ? { name, description: '', source: 'builtin', inputSchema: { type: 'object', properties: {} }, execute, isReadOnly: true, requiresConfirmation: false } : undefined)
    await useAgentStore.getState().sendMessage('Check @architecture')
    expect(useProjectStore.getState().currentProject?.id).toBe('project-b')
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ projectSession: session, selectedModelId: 'model-a', writingLanguage: 'en-US' }))
    expect(calls('agent-generation:begin')).toHaveLength(0)
    expect(legacyRuntime.createGenerationRuntime).not.toHaveBeenCalled()
  })

  it('requires an open project and never falls back to a global provider session', async () => {
    useProjectStore.setState({ currentProject: null })
    await useAgentStore.getState().sendMessage('请写故事')
    expect(lastMessage()?.content).toBe('请先打开项目，再使用 AI 助手。')
    expect(calls('agent-generation:begin')).toHaveLength(0)
    expect(legacyRuntime.createGenerationRuntime).not.toHaveBeenCalled()
  })

  it('freezes history without duplicating the current author message', async () => {
    await useAgentStore.getState().sendMessage('前一条指令')
    await useAgentStore.getState().sendMessage('当前指令')
    expect(fixture.recovery.context.input.historyMessages).toEqual([{ role: 'user', content: '前一条指令' }, { role: 'assistant', content: '完成。' }])
    expect(fixture.recovery.context.initialMessages.filter(message => message.content === '当前指令')).toHaveLength(1)
  })

  it('cancels a late begin receipt before any round and retains its navigation', async () => {
    const original = fixture.invoke.getMockImplementation()!
    let release!: () => void
    fixture.invoke.mockImplementationOnce(async (channel, ...args) => {
      await new Promise<void>(resolve => { release = resolve })
      return original(channel, ...args)
    })
    const send = useAgentStore.getState().sendMessage('检查项目')
    await vi.waitFor(() => expect(calls('agent-generation:begin')).toHaveLength(1))
    await useAgentStore.getState().cancelGeneration()
    release(); await send
    expect(calls('agent-generation:round')).toHaveLength(0)
    expect(calls('generation:cancel')).toHaveLength(1)
    expect(lastMessage()?.mainGenerationHandle).toEqual(fixture.recovery.handle)
  })

  it('reopens a completed reply after renderer state is gone without begin, resume, or a new model round', async () => {
    await useAgentStore.getState().sendMessage('检查项目')
    const handle = fixture.recovery.handle
    useAgentStore.getState().clearAll(); fixture.invoke.mockClear()
    await useAgentStore.getState().resumeGeneration(handle)
    expect(lastMessage()?.content).toBe('完成。')
    expect(lastMessage()?.mainGenerationHandle).toEqual(handle)
    expect(calls('agent-generation:read')).toHaveLength(1)
    expect(calls('agent-generation:begin')).toHaveLength(0)
    expect(calls('agent-generation:resume')).toHaveLength(0)
    expect(calls('agent-generation:round')).toHaveLength(0)
    expect(calls('generation:cancel')).toHaveLength(0)
  })

  it('shows the original candidate on source conflict without executing or claiming actions', async () => {
    await useAgentStore.getState().sendMessage('检查项目')
    fixture.recovery.sourceStatus = 'conflict'
    const handle = fixture.recovery.handle
    useAgentStore.getState().clearAll(); fixture.invoke.mockClear()
    await useAgentStore.getState().resumeGeneration(handle)
    expect(lastMessage()?.content).toContain('完成。')
    expect(lastMessage()?.content).toContain('来源已变化')
    expect(calls('agent-generation:round')).toHaveLength(0)
    expect(calls('agent-generation:claim-tool')).toHaveLength(0)
    expect(calls('agent-generation:resume')).toHaveLength(0)
  })

  it('keeps an unknown invocation non-replayable after renderer recovery', async () => {
    fixture.response = vi.fn(async () => ({ status: 'unknown' as const }))
    await useAgentStore.getState().sendMessage('检查项目')
    const handle = fixture.recovery.handle
    useAgentStore.getState().clearAll(); fixture.invoke.mockClear()
    await useAgentStore.getState().resumeGeneration(handle)
    expect(lastMessage()?.mainGenerationHandle).toEqual(handle)
    expect(calls('agent-generation:round')).toHaveLength(0)
    expect(calls('agent-generation:begin')).toHaveLength(0)
    expect(calls('agent-generation:resume')).toHaveLength(0)
    expect(fixture.response).toHaveBeenCalledOnce()
  })

  it('retains main-projected interrupted text and its original handle without retrying the model', async () => {
    fixture.response = async () => ({ status: 'incomplete', text: '可见的原始候选' })
    await useAgentStore.getState().sendMessage('继续')
    const handle = lastMessage()!.mainGenerationHandle!
    expect(lastMessage()?.content).toContain('可见的原始候选')
    expect(lastMessage()?.content).toContain('原候选已保留')
    useAgentStore.getState().clearAll()
    await useAgentStore.getState().resumeGeneration(handle)
    expect(lastMessage()?.content).toContain('可见的原始候选')
    expect(lastMessage()?.mainGenerationHandle?.rootActionId).toBe(handle.rootActionId)
    expect(calls('agent-generation:round')).toHaveLength(1)
    expect(calls('agent-generation:resume')).toHaveLength(0)
  })
})
