import { afterEach, expect, it, vi } from 'vitest'
import { AnalyzeWritingStyleCommand } from '../analyze-style.command'
import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'

const originalProject = useProjectStore.getState().currentProject
const originalModel = useLLMStore.getState().defaultModelId
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: originalProject }); useLLMStore.setState({ defaultModelId: originalModel }) })

it.each([
  ['普通文风', false, 'generation'], ['导入文风', true, 'generation'],
  ['普通文风', false, 'effect'], ['导入文风', true, 'effect'],
] as const)('%s 在 %s 作者编辑期间保留新草稿且只执行唯一保存', async (_name, custom, stage) => {
  const session = { projectId: '文风项目', leaseId: '文风会话', projectPath: 'C:/文风合成项目' }
  const project = { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, novelConfig: { writingStyle: '作者原始文风' } }
  const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: '文风根', runId: '文风运行' }
  const view = { handle, status: 'running', nonReplayable: false, artifacts: [],
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 } }
  useProjectStore.setState({ currentProject: project as never })
  useLLMStore.setState({ defaultModelId: '合成模型' })
  const authorEdit = () => useProjectStore.setState({ currentProject: { ...project, novelConfig: { writingStyle: '作者正在写的新文风' } } as never })
  const effect = vi.fn(async () => { if (stage === 'effect') { await Promise.resolve(); authorEdit() } })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'generation:begin' || channel === 'generation:read') return view
    if (channel === 'generation:execute') {
      if (stage === 'generation') authorEdit()
      return { run: view, outcome: { status: 'completed', content: '模型生成文风', finishReason: 'stop', receipt: { finishReason: 'stop' } } }
    }
    if (channel === 'db:project-core-commit-generated') { await effect(); return { success: true } }
    throw new Error('禁止普通保存或额外调用：' + channel)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  await expect(new AnalyzeWritingStyleCommand({ sampleText: '  作者样本。\r\n' }, undefined, custom ? effect : undefined).execute({
    step: {}, context: { runId: '文风动作', projectPath: session.projectPath, projectSession: session, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false },
    callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() },
  })).rejects.toThrow(stage === 'generation' ? 'GENERATION_AUTHOR_DRAFT_CHANGED' : 'GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
  expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('作者正在写的新文风')
  expect(effect).toHaveBeenCalledTimes(stage === 'generation' ? 0 : 1)
  expect(invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-commit-generated')).toHaveLength(!custom && stage === 'effect' ? 1 : 0)
  if (custom && stage === 'effect') expect(effect).toHaveBeenCalledWith('模型生成文风', handle)
})
