import { composeVisibleContinuation } from '../../../../shared/visible-continuation'
import { GenerateFieldCommand } from '../generate-field.command'
import { assertSemanticGenerationTask } from '../../../../../electron/services/main-generation-plan'
import { GenerateWorldBuildingCommand, GeneratePlotArchitectureCommand } from '../architecture.command'
import { afterEach, expect, it, vi } from 'vitest'
import { AnalyzeWritingStyleCommand } from '../analyze-style.command'
import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { WorkflowContext } from '../../../../stores/workflow-store'
import type { BeginGenerationRequest } from '../../../../shared/generation-owner-contract'
import type { MainGenerationRunView } from '../../../generation/generation-runtime'

const projectSession = { projectId: '合成项目', leaseId: '合成会话', projectPath: 'C:/合成项目' }
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const originalProject = useProjectStore.getState().currentProject
function fixture() {
  const context: WorkflowContext = { runId: '同一作者动作', projectPath: projectSession.projectPath, projectSession, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
  useProjectStore.setState({ currentProject: { id: projectSession.projectId, path: projectSession.projectPath, name: '合成小说', sessionLease: projectSession.leaseId, novelConfig: {} } as never })
  useLLMStore.setState({ defaultModelId: '合成模型' })
  const view: MainGenerationRunView = { handle: { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '主进程根', runId: '主进程运行' }, status: 'running', nonReplayable: false, artifacts: [], budget: { maxAttempts: 32, maxRequestedOutputTokens: 2097152, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 } }
  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (channel === 'generation:execute') assertSemanticGenerationTask((args[0] as { task: Parameters<typeof assertSemanticGenerationTask>[0] }).task)
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'generation:begin' || channel === 'generation:read') return structuredClone(view)
    if (channel === 'generation:execute') return { run: structuredClone(view), outcome: { status: 'completed', content: '以具体动作呈现人物，短句与长句交替，保留雨夜的细微感官线索。', finishReason: 'stop', receipt: { finishReason: 'stop' } } }
    if (channel === 'db:project-core-commit-generated' || channel === 'project:save') return { success: true }
    if (channel === 'db:draft-get-max-finalized-chapter') return 1
    if (channel === 'db:draft-get-finalized') return { id: 27 }
    if (channel === 'db:draft-get-full') return { id: 27, content: '  定稿原文字节。\r\n' }
    throw new Error(`Unexpected synthetic IPC: ${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}) } })
  return { context, invoke, callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() } }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); useProjectStore.setState({ currentProject: originalProject }); useLLMStore.setState({ defaultModelId: originalDefaultModelId }) })

it('style default path uses main owner and freezes provided sample bytes before execution', async () => {
  const f = fixture(), raw = '  雨夜，铜钥匙落在门前。\r\n'
  await new AnalyzeWritingStyleCommand({ sampleText: raw }).execute({ step: {}, ...f })
  const begin = f.invoke.mock.calls.find(([channel]) => channel === 'generation:begin') as unknown as [string, BeginGenerationRequest]
  expect(begin[1]).toMatchObject({ operation: 'analyze-writing-style', promptKeys: ['analyze_writing_style'], skillStages: [], authorInputs: [{ id: 'style:sample', text: raw }], selectedFinalizedDraftIds: [] })
  expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(1)
  expect(f.invoke.mock.calls.some(([channel]) => channel.startsWith('llm:'))).toBe(false)
})
it('style resolves actual finalized IDs before beginning instead of forging author inputs', async () => {
  const f = fixture()
  await new AnalyzeWritingStyleCommand().execute({ step: {}, ...f })
  const calls = f.invoke.mock.calls as unknown as [string, BeginGenerationRequest][]
  const beginIndex = calls.findIndex(([channel]) => channel === 'generation:begin')
  expect(calls.findIndex(([channel]) => channel === 'db:draft-get-full')).toBeLessThan(beginIndex)
  expect(calls[beginIndex][1]).toMatchObject({ selectedFinalizedDraftIds: [27], authorInputs: [] })
})


it('legacy recovery without a persistent handle never creates a replacement root', async () => {
  const f = fixture(), snapshot = { expectedProjectPath: projectSession.projectPath, novelConfig: {} } as never
  const commands = [new GenerateWorldBuildingCommand(snapshot, undefined, { resumeWorldBuilding: true }), new GeneratePlotArchitectureCommand(['synopsis'], snapshot, undefined, { resumeSynopsis: true })]
  for (const command of commands) await expect(command.execute({ step: {}, ...f })).rejects.toThrow('没有持久运行记录')
  expect(f.invoke.mock.calls.some(([channel]) => channel.startsWith('generation:'))).toBe(false)
})

it('camel-case field keys produce legal main semantic purposes without physical overrides', async () => {
  const f = fixture()
  await new GenerateFieldCommand('worldSetting').execute({ step: {}, ...f })
  const execute = f.invoke.mock.calls.find(([channel]) => channel === 'generation:execute')!
  expect(execute[1]).toMatchObject({ task: { purpose: 'generate-field-world-setting' } })
  expect(f.invoke.mock.calls.find(([channel]) => channel === 'db:project-core-commit-generated')?.[1]).toMatchObject({ generationRunHandle: f.context.mainGenerationRunHandle })
  expect(f.invoke.mock.calls.some(([channel]) => channel === 'project:save' || channel === 'db:project-core-update')).toBe(false)
})
it('world navigation is persisted before physical calls, and failed navigation blocks dispatch', async () => {
  const f = fixture(), original = f.invoke.getMockImplementation()!
  f.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'fs:read-json') return { success: true, data: {} }
    if (channel === 'fs:write-json') return { success: false, error: '导航写入失败' }
    return original(channel, ...args)
  })
  const snapshot = { expectedProjectPath: projectSession.projectPath, novelConfig: {} } as never
  await expect(new GenerateWorldBuildingCommand(snapshot).execute({ step: {}, ...f })).rejects.toThrow('导航写入失败')
  const write = f.invoke.mock.calls.find(([channel]) => channel === 'fs:write-json')!
  expect(write[2]).toEqual({ world_building_generation_handle: { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '主进程根', runId: '主进程运行' } })
  expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(0)
})


it.each([false, true])('world restart uses only acknowledged composition (available=%s)', async acknowledged => {
  const f = fixture(), original = f.invoke.getMockImplementation()!
  const handle = { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '主进程根', runId: '主进程运行' }
  let partial: Record<string, unknown> = {}
  let interrupted = true
  let composition: { text: string; textHash: string; artifactIds: string[] } | null = null
  const durableCandidate = '古城以记忆为税，沿岸聚落依照季节输送粮食与燃料。'
  const addition = '行会核对税册，王庭公开裁决争议，形成相互制衡的秩序。'
  const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
  const formalWrites: unknown[] = []
  f.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'db:project-core-get') return { premise: '测绘师追查记忆税令，保护沿岸聚落免于倒悬古城的灾难。'.repeat(4), worldbuilding: '作者确认的世界观。' }
    if (channel === 'fs:read-json') return { success: true, data: structuredClone(partial) }
    if (channel === 'fs:write-json') { partial = structuredClone(args[1] as Record<string, unknown>); return { success: true } }
    if (channel === 'generation:read-visible-composition') return composition
    if (channel === 'generation:compose-visible') {
      const text = composeVisibleContinuation(durableCandidate, addition)
      expect(args[1]).toEqual(['已确认候选', '恢复响应'])
      expect(args[2]).toBe(await hash(text))
      composition = { text, textHash: await hash(text), artifactIds: args[1] as string[] }
      return composition
    }
    if (channel === 'generation:execute') {
      if (interrupted) throw new Error('合成进程中断')
      return { run: await original('generation:read', handle), outcome: { status: 'completed', content: addition, finishReason: 'stop',
        receipt: { finishReason: 'stop', visibleArtifact: { artifactId: '恢复响应', attemptId: '恢复尝试', revision: 1, textHash: await hash(addition) } } } }
    }
    if (channel === 'db:project-core-commit-generated') { formalWrites.push(args[0]); return { success: true } }
    return original(channel, ...args)
  })
  const snapshot = { expectedProjectPath: projectSession.projectPath, novelConfig: {} } as never
  await expect(new GenerateWorldBuildingCommand(snapshot).execute({ step: {}, ...f })).rejects.toThrow('合成进程中断')
  expect(partial.world_building_generation_handle).toEqual(handle)
  expect(partial.world_building_partial_result).toBeUndefined()
  expect(formalWrites).toEqual([])
  interrupted = false
  if (acknowledged) composition = { text: durableCandidate, textHash: await hash(durableCandidate), artifactIds: ['已确认候选'] }
  const resumed = { ...f.context, runId: '重新打开的作者动作', data: {}, mainGenerationRootHandle: undefined, mainGenerationRunHandle: undefined }
  const requestCount = f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute').length
  const operation = new GenerateWorldBuildingCommand(snapshot, undefined, { resumeWorldBuilding: true, resumeHandle: handle }).execute({ step: {}, context: resumed, callbacks: f.callbacks })
  if (acknowledged) {
    await expect(operation).resolves.toBe(composeVisibleContinuation(durableCandidate, addition))
    expect(formalWrites).toHaveLength(1)
  } else {
    await expect(operation).rejects.toThrow('未找到可恢复的世界观候选')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(requestCount)
    expect(formalWrites).toEqual([])
  }
  expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')).toHaveLength(1)
})

it.each([false, true])('synopsis restart uses only acknowledged composition (available=%s)', async acknowledged => {
  const f = fixture(), original = f.invoke.getMockImplementation()!
  const handle = { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '主进程根', runId: '主进程运行' }
  let partial: Record<string, unknown> = {}
  let interrupted = true
  let composition: { text: string; textHash: string; artifactIds: string[] } | null = null
  const durableCandidate = '第1章：古城税册\n' + '测绘师发现粮仓税册的矛盾，决定追查伪造凭据的行会。'.repeat(15)
  const addition = '行会核对税册，王庭公开裁决争议，形成相互制衡的秩序。'
  const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
  const formalWrites: unknown[] = []
  f.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'db:project-core-get') return { premise: '测绘师追查记忆税令，保护沿岸聚落免于倒悬古城的灾难。'.repeat(4), charactersArch: '角色各自追求明确，行会与主角存在利益冲突。'.repeat(4), worldbuilding: '作者确认的世界观。'.repeat(10), synopsis: '' }
    if (channel === 'fs:read-json') return { success: true, data: structuredClone(partial) }
    if (channel === 'fs:write-json') { partial = structuredClone(args[1] as Record<string, unknown>); return { success: true } }
    if (channel === 'generation:read-visible-composition') return composition
    if (channel === 'generation:compose-visible') {
      const text = composeVisibleContinuation(durableCandidate, addition)
      expect(args[1]).toEqual(['已确认候选', '恢复响应'])
      expect(args[2]).toBe(await hash(text))
      composition = { text, textHash: await hash(text), artifactIds: args[1] as string[] }
      return composition
    }
    if (channel === 'generation:execute') {
      if (interrupted) throw new Error('合成进程中断')
      return { run: await original('generation:read', handle), outcome: { status: 'completed', content: addition, finishReason: 'stop',
        receipt: { finishReason: 'stop', visibleArtifact: { artifactId: '恢复响应', attemptId: '恢复尝试', revision: 1, textHash: await hash(addition) } } } }
    }
    if (channel === 'db:project-core-synopsis-commit') { formalWrites.push(args[0]); return { success: true } }
    return original(channel, ...args)
  })
  const snapshot = { expectedProjectPath: projectSession.projectPath, novelConfig: { totalChapters: 1, wordsPerChapter: 3000 } } as never
  await expect(new GeneratePlotArchitectureCommand(['synopsis'], snapshot).execute({ step: {}, ...f })).rejects.toThrow('合成进程中断')
  expect(partial.synopsis_generation_handle).toEqual(handle)
  expect(partial.synopsis_result).toBeUndefined()
  expect(formalWrites).toEqual([])
  interrupted = false
  if (acknowledged) composition = { text: durableCandidate, textHash: await hash(durableCandidate), artifactIds: ['已确认候选'] }
  const resumed = { ...f.context, runId: '重新打开的作者动作', data: {}, mainGenerationRootHandle: undefined, mainGenerationRunHandle: undefined }
  const requestCount = f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute').length
  const operation = new GeneratePlotArchitectureCommand(['synopsis'], snapshot, undefined, { resumeSynopsis: true, resumeHandle: handle }).execute({ step: {}, context: resumed, callbacks: f.callbacks })
  if (acknowledged) {
    await expect(operation).resolves.toBe(composeVisibleContinuation(durableCandidate, addition))
    expect(formalWrites).toHaveLength(1)
  } else {
    await expect(operation).rejects.toThrow('中断检查点内容过短')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(requestCount)
    expect(formalWrites).toEqual([])
  }
  expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')).toHaveLength(1)
})


it('field freezes the author config and refuses changed local drafts before any formal commit', async () => {
  const f = fixture(), original = f.invoke.getMockImplementation()!
  const project = useProjectStore.getState().currentProject!
  const originalConfig = { ...project.novelConfig, worldSetting: '  作者世界设定。\r\n' }
  useProjectStore.setState({ currentProject: { ...project, novelConfig: originalConfig } })
  f.invoke.mockImplementation(async (channel, ...args) => {
    const result = await original(channel, ...args)
    if (channel === 'generation:execute') useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...originalConfig, worldSetting: '作者正在编辑的新设定。' } } })
    return result
  })
  await expect(new GenerateFieldCommand('worldSetting').execute({ step: {}, ...f })).rejects.toThrow('GENERATION_AUTHOR_DRAFT_CHANGED')
  const begin = f.invoke.mock.calls.find(([channel]) => channel === 'generation:begin')!
  expect(begin[1]).toMatchObject({ authorInputs: [{ id: 'field:author-config', text: JSON.stringify(originalConfig) }] })
  expect(f.invoke.mock.calls.some(([channel]) => channel === 'db:project-core-commit-generated' || channel === 'project:save')).toBe(false)
  expect(useProjectStore.getState().currentProject?.novelConfig.worldSetting).toBe('作者正在编辑的新设定。')
})

it('main style import callback receives the owner handle without a second core write', async () => {
  const f = fixture(), persist = vi.fn(async () => {})
  await new AnalyzeWritingStyleCommand({ sampleText: '合成导入章节正文。' }, undefined, persist).execute({ step: {}, ...f })
  expect(persist).toHaveBeenCalledWith(expect.any(String), f.context.mainGenerationRunHandle)
  expect(f.invoke.mock.calls.some(([channel]) => channel === 'db:project-core-commit-generated' || channel === 'db:project-core-update')).toBe(false)
})
