import { afterEach, expect, it, vi } from 'vitest'

import type { MainGenerationRunView } from '../../generation/generation-runtime'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { GeneratePlotArchitectureCommand, PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE } from '../commands/architecture.command'
import { PLOT_OUTLINE_CONTENT, PLOT_OUTLINE_PROTOCOL, type PlotOutlineProgress } from '../../../shared/plot-outline-contract'
import type { NovelConfig } from '../../../shared/ipc-channels'

const originalDefaultModelId = useLLMStore.getState().defaultModelId
afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: originalDefaultModelId })
  vi.unstubAllGlobals()
})

/** 与用户现场一致：第 6–10 章一批，第 6 章已接受，正要请求第 7 章时主进程拒绝。 */
function arrangeOutlineRejectedAtChapter7(rejection: string) {
  const projectSession = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/失乐园' }
  const novelConfig = { totalChapters: 20, wordsPerChapter: 3000, genre: '悬疑' } as NovelConfig
  useProjectStore.setState({ currentProject: { id: projectSession.projectId, path: projectSession.projectPath,
    sessionLease: projectSession.leaseId, name: '失乐园', novelConfig, characterStates: '', createdAt: '', updatedAt: '' } })
  useLLMStore.setState({ defaultModelId: 'model' })
  const handle = { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '大纲根', runId: '大纲运行' }
  const sourceExpected = { synopsis: '## 第1章：起\n……\n## 第5章：转\n……', premise: '前提', charactersArch: '角色', worldbuilding: '世界',
    genre: '悬疑', totalChapters: 20, wordsPerChapter: 3000, writingLanguage: 'zh-CN' as const, plotStructure: 'three_act',
    narrativePov: 'third_limited', globalGuidance: '' }
  const plotOutline: PlotOutlineProgress = { protocol: PLOT_OUTLINE_PROTOCOL, content: PLOT_OUTLINE_CONTENT, range: { from: 6, to: 10 },
    targetUnits: 300, cursor: { kind: 'request', chapterNumber: 7, attempt: 'normal' }, sourceExpected,
    confirmedPrefix: sourceExpected.synopsis,
    composition: { artifactIds: ['第6章'], text: '## 第6章：雨夜\n林岚确认证词。', textHash: 'a'.repeat(64), revision: 1 } as PlotOutlineProgress['composition'] }
  const view = { handle, status: 'running', operation: 'generate-plot-outline', nonReplayable: false, artifacts: [], plotOutline,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2097152, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 } } as MainGenerationRunView
  const execute = vi.fn(async () => { throw new Error(`Error invoking remote method 'generation:execute': Error: ${rejection}`) })
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'generation:begin' || channel === 'generation:read') return structuredClone(view)
    if (channel === 'generation:read-context') return { handle, modelId: 'model', operation: 'generate-plot-outline', plotOutline: structuredClone(plotOutline),
      authorInputs: [{ id: 'architecture:author-config', text: JSON.stringify(novelConfig) }] }
    if (channel === 'generation:execute') return execute()
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'fs:read-json') return { success: true, data: {} }
    if (channel === 'fs:write-file' || channel === 'fs:write-json') return { success: true }
    throw new Error(`unexpected IPC ${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  const command = new GeneratePlotArchitectureCommand(['synopsis'], { expectedProjectPath: projectSession.projectPath, novelConfig }, undefined,
    { synopsisRange: { from: 6, to: 10 } })
  const context = { runId: 'architecture-run', projectPath: projectSession.projectPath, projectSession,
    writingLanguage: 'zh-CN' as const, uiLocale: 'zh-CN' as const, data: {}, cancelled: false }
  const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
  return { run: () => command.execute({ step: {}, context, callbacks }), execute }
}

async function failure(run: () => Promise<unknown>) {
  const error = await run().then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  return error as Error & { code?: string }
}

it('途中改了模型设置：说清楚停在第 7 章、第 6 章还在恢复稿、正式大纲没动，并给出去架构页重新生成的入口', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_SOURCE_CHANGED_MODEL')
  const error = await failure(journey.run)
  expect(journey.execute).toHaveBeenCalledTimes(1)
  expect(error.code).toBe(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE)
  expect(error.message).not.toContain('GENERATION_SOURCE_CHANGED')
  expect(error.message).toContain('模型设置')
  expect(error.message).toContain('第 7 章')
  expect(error.message).toContain('第 6 章')
  expect(error.message).toContain('正式大纲未被改动')
  expect(error.message).toContain('从第 6 章')
})

it('途中改了作品设定：同样可读，并说是作品设定或模板变了而不是模型', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_SOURCE_CHANGED')
  const error = await failure(journey.run)
  expect(error.code).toBe(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE)
  expect(error.message).not.toContain('GENERATION_SOURCE_CHANGED')
  expect(error.message).not.toContain('模型设置')
  expect(error.message).toContain('作品设定')
  expect(error.message).toContain('第 7 章')
})

it('与来源无关的失败照原样抛出，不被误报成来源变化', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_PROVIDER_FAILED')
  const error = await failure(journey.run)
  expect(error.code).not.toBe(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE)
  expect(error.message).toContain('GENERATION_PROVIDER_FAILED')
})
