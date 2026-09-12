import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  GenerateWorldBuildingCommand,
  WorldBuildingResumeAvailableError,
  recoverableWorldBuildingCandidate,
  type ArchitectureProjectSnapshot,
} from '../architecture.command'
import { createWorkflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import { clearProjectCustomPrompts } from '../../../prompt-templates'

const projectPath = 'C:\\novels\\世界观恢复测试'
const otherProjectPath = 'C:\\novels\\另一本书'
const projectSession = Object.freeze({
  projectId: 'world-recovery',
  leaseId: 'lease-world-recovery',
  projectPath,
})
const premise = '群山围绕的盆地每逢冬至会浮现倒悬古城，年轻测绘师必须查明记忆税令的真相，同时保护沿岸聚落。'.repeat(2)
const novelConfig: ArchitectureProjectSnapshot['novelConfig'] = {
  writingLanguage: 'zh-CN',
  genre: '东方奇幻',
  subGenre: '',
  targetAudience: '成年读者',
  totalChapters: 36,
  wordsPerChapter: 3000,
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: premise,
  worldSetting: '记忆可以被固化、征税和走私。',
  goldenFinger: '主角能看见记忆实体的原始归属，但会付出代价。',
  protagonistProfile: '主角谨慎、善于测绘，坚持不牺牲无辜者。',
  globalGuidance: '保持规则、资源和权力结构之间的因果闭环。',
}
const snapshot: ArchitectureProjectSnapshot = {
  expectedProjectPath: projectPath,
  novelConfig,
}
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId

interface ResponseItem {
  content?: string
  finishReason?: 'stop' | 'length'
  error?: string
  beforeResponse?: () => void
}

function context(): WorkflowContext {
  return {
    runId: 'world-recovery-run',
    projectPath,
    projectSession,
    generationModelId: 'world-recovery-model',
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: { stepGuidance: { worldbuilding: '只写世界观正文，保持因果闭环。' } },
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
    setPromptBudgetReport: vi.fn(),
  }
}

function installResponses(items: readonly ResponseItem[], writesAtRequestStart: number[] = []) {
  let index = 0
  const generateStream = vi.fn(async (_messages, streamCallbacks) => {
    writesAtRequestStart.push(partialWriteCount)
    const item = items[index++]
    if (!item) throw new Error(`出现未计划的第 ${index} 次模型请求`)
    item.beforeResponse?.()
    if (item.error) {
      streamCallbacks.onError?.(item.error)
    } else {
      const content = item.content ?? ''
      streamCallbacks.onChunk?.(content)
      streamCallbacks.onDone?.(content, undefined, item.finishReason ?? 'stop')
    }
    return `世界观请求-${index}`
  })
  useLLMStore.setState({ defaultModelId: 'world-recovery-model', generateStream })
  return generateStream
}

let partialFile: Record<string, unknown>
let currentPremise: string
let formalWorldbuilding: string
let formalWrites: string[]
let partialWriteCount: number

function installIpc(): void {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        if (channel === 'fs:check-exists') return false
        if (channel === 'db:project-core-get') {
          return { premise: currentPremise, worldbuilding: formalWorldbuilding }
        }
        if (channel === 'fs:read-json') {
          expect(args[0]).toBe(`${projectPath}/.ai-novel/partial_arch.json`)
          return { success: true, data: structuredClone(partialFile) }
        }
        if (channel === 'fs:write-json') {
          expect(args[0]).toBe(`${projectPath}/.ai-novel/partial_arch.json`)
          partialWriteCount += 1
          partialFile = structuredClone(args[1] as Record<string, unknown>)
          return { success: true }
        }
        if (channel === 'db:project-core-update') {
          const update = args[0] as { worldbuilding?: string }
          if (typeof update.worldbuilding === 'string') {
            formalWorldbuilding = update.worldbuilding
            formalWrites.push(update.worldbuilding)
          }
          return { success: true }
        }
        throw new Error(`未预期的 IPC 通道：${channel}`)
      }),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  partialFile = {}
  currentPremise = premise
  formalWorldbuilding = '# 世界观\n\n作者已经确认的完整世界观。'
  formalWrites = []
  partialWriteCount = 0
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      name: '世界观恢复测试',
      path: projectPath,
      sessionLease: projectSession.leaseId,
      novelConfig,
    } as never,
  })
  installIpc()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
  useProjectStore.setState({ currentProject: null })
  clearProjectCustomPrompts()
})

describe('GenerateWorldBuildingCommand 截断恢复', () => {
  it('正常 stop 只请求一次并直接保存正式世界观', async () => {
    const generateStream = installResponses([{ content: '新世界遵循明确的资源与权力规则。', finishReason: 'stop' }])

    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .resolves.toBe('新世界遵循明确的资源与权力规则。')

    expect(generateStream).toHaveBeenCalledTimes(1)
    expect(formalWrites).toEqual(['# 世界观\n\n新世界遵循明确的资源与权力规则。'])
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('')
  })

  it('length 后先保存候选，再自动续写一次并在 stop 后提交完整结果', async () => {
    const requestStartWrites: number[] = []
    const generateStream = installResponses([
      { content: '古城以记忆作为税收与燃料，', finishReason: 'length' },
      { content: '王庭与行会因此形成相互制衡的权力结构。', finishReason: 'stop' },
    ], requestStartWrites)

    const result = await new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(requestStartWrites).toEqual([0, 1])
    expect(result).toContain('古城以记忆作为税收与燃料')
    expect(result).toContain('王庭与行会因此形成相互制衡')
    expect(formalWrites).toHaveLength(1)
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('')
  })

  it('连续两次 length 只请求两次，保存合并候选且不覆盖正式世界观', async () => {
    const original = formalWorldbuilding
    const generateStream = installResponses([
      { content: '第一部分建立记忆税的来源与代价。', finishReason: 'length' },
      { content: '第二部分建立行会、王庭与港口之间的冲突。', finishReason: 'length' },
    ])

    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toBeInstanceOf(WorldBuildingResumeAvailableError)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(formalWrites).toHaveLength(0)
    expect(formalWorldbuilding).toBe(original)
    expect(recoverableWorldBuildingCandidate(partialFile)).toContain('第一部分建立记忆税')
    expect(recoverableWorldBuildingCandidate(partialFile)).toContain('第二部分建立行会')
  })

  it('续写请求网络失败时，首段候选已先保存且正式世界观不变', async () => {
    const requestStartWrites: number[] = []
    const original = formalWorldbuilding
    installResponses([
      { content: '已收到的世界观首段。', finishReason: 'length' },
      { error: '网络连接中断' },
    ], requestStartWrites)

    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toThrow('模型请求失败')

    expect(requestStartWrites).toEqual([0, 1])
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('已收到的世界观首段。')
    expect(formalWorldbuilding).toBe(original)
    expect(formalWrites).toHaveLength(0)
  })

  it('新工作流上下文可从持久化候选恢复并在成功后清除候选', async () => {
    installResponses([
      { content: '倒悬古城以记忆结晶维持运转。', finishReason: 'length' },
      { content: '港口行会控制结晶流通。', finishReason: 'length' },
    ])
    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toBeInstanceOf(WorldBuildingResumeAvailableError)

    const persistedCandidate = recoverableWorldBuildingCandidate(partialFile)
    const resumeCalls = installResponses([
      { content: '王庭通过税令制衡行会，冲突由此持续升级。', finishReason: 'stop' },
    ])
    const reopenedContext = context()
    reopenedContext.data = {}
    const result = await new GenerateWorldBuildingCommand(
      snapshot,
      createWorkflowRuntimeDependencies(),
      { resumeWorldBuilding: true },
    ).execute({ step: {}, context: reopenedContext, callbacks: callbacks() })

    expect(resumeCalls).toHaveBeenCalledTimes(1)
    expect(result).toContain(persistedCandidate)
    expect(result).toContain('王庭通过税令制衡行会')
    expect(formalWrites).toHaveLength(1)
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('')
  })

  it('正式写入前发现作者修改时不覆盖新内容，并保留本次生成候选', async () => {
    const authorEdit = '# 世界观\n\n作者在生成期间补充的新规则。'
    installResponses([{
      content: '模型生成的完整世界观候选。',
      finishReason: 'stop',
      beforeResponse: () => { formalWorldbuilding = authorEdit },
    }])

    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toBeInstanceOf(WorldBuildingResumeAvailableError)

    expect(formalWorldbuilding).toBe(authorEdit)
    expect(formalWrites).toHaveLength(0)
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('模型生成的完整世界观候选。')
  })

  it('模型响应前故事前提与小说配置变化时只保留候选，不写正式世界观', async () => {
    const original = formalWorldbuilding
    installResponses([{
      content: '基于旧前提与旧配置生成的世界观。',
      finishReason: 'stop',
      beforeResponse: () => {
        currentPremise = '作者在生成期间改写后的故事前提。'.repeat(4)
        const currentProject = useProjectStore.getState().currentProject!
        useProjectStore.setState({
          currentProject: {
            ...currentProject,
            novelConfig: {
              ...currentProject.novelConfig,
              worldSetting: '作者在生成期间修改后的世界底层规则。',
            },
          },
        })
      },
    }])

    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toThrow('故事前提、小说配置或模板已变化')

    expect(formalWorldbuilding).toBe(original)
    expect(formalWrites).toHaveLength(0)
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe('基于旧前提与旧配置生成的世界观。')
  })

  it('重新打开后源事实变化会拒绝续写，并保留候选供查看复制', async () => {
    installResponses([
      { content: '旧规则下的世界观首段。', finishReason: 'length' },
      { content: '旧规则下的世界观续段。', finishReason: 'length' },
    ])
    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toBeInstanceOf(WorldBuildingResumeAvailableError)
    const savedCandidate = recoverableWorldBuildingCandidate(partialFile)

    const resumeCalls = installResponses([{ content: '不应发出的续写。', finishReason: 'stop' }])
    const changedSnapshot: ArchitectureProjectSnapshot = {
      ...snapshot,
      novelConfig: { ...novelConfig, worldSetting: '作者已经改变世界底层规则。' },
    }
    await expect(new GenerateWorldBuildingCommand(
      changedSnapshot,
      createWorkflowRuntimeDependencies(),
      { resumeWorldBuilding: true },
    ).execute({ step: {}, context: { ...context(), data: {} }, callbacks: callbacks() }))
      .rejects.toThrow('旧候选不能续到新上下文')

    expect(resumeCalls).not.toHaveBeenCalled()
    expect(recoverableWorldBuildingCandidate(partialFile)).toBe(savedCandidate)
    expect(formalWrites).toHaveLength(0)
  })

  it('取消或项目切换时不保存候选，也不写正式世界观', async () => {
    const cancelledContext = context()
    installResponses([{
      content: '取消后的输出不得保存。',
      finishReason: 'length',
      beforeResponse: () => { cancelledContext.cancelled = true },
    }])
    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: cancelledContext, callbacks: callbacks() }))
      .rejects.toThrow('工作流已取消')
    expect(partialWriteCount).toBe(0)
    expect(formalWrites).toHaveLength(0)

    installResponses([{
      content: '项目切换后的输出不得保存。',
      finishReason: 'length',
      beforeResponse: () => useProjectStore.setState({
        currentProject: {
          id: 'other',
          name: '另一本书',
          path: otherProjectPath,
          sessionLease: 'lease-other',
          novelConfig,
        } as never,
      }),
    }])
    await expect(new GenerateWorldBuildingCommand(snapshot, createWorkflowRuntimeDependencies())
      .execute({ step: {}, context: context(), callbacks: callbacks() }))
      .rejects.toThrow('当前项目已切换')
    expect(partialWriteCount).toBe(0)
    expect(formalWrites).toHaveLength(0)
  })
})
