import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerationRecoveryContext } from '../../../shared/generation-owner-contract'
import type { StepCallbacks, WorkflowContext, WorkflowDefinition, WorkflowStep } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { createDraftRecoveryWorkflow } from '../draft-recovery-workflow'

const session = { projectId: 'recovery-fixture', leaseId: 'current-session', projectPath: 'C:/recovery-fixture' }
const handle = { projectId: session.projectId, epoch: 'original-session', rootActionId: 'original-root', runId: 'original-run' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const info = { chapterNumber: 2, title: '潮声', role: '发展', purpose: '寻找钟楼', characters: [], keyEvents: '亮灯' }
const content = '海潮拍岸，钟楼的灯再次亮起。'
const originalStore = useProjectStore.getState()

function recoveryFixture(): GenerationRecoveryContext {
  return { handle, operation: 'chapter-draft', chapterNumber: 2, modelId: 'synthetic-model',
    authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify(info) },
      { id: 'draft:author-config', text: '{}' }, { id: 'draft:target-units', text: '900' }],
    selectedDraftIds: [], selectedDrafts: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [2, 3, 4, 5, 6, 7],
    composition: { algorithm: 'draft-visible-v1', artifactIds: ['original-artifact'], text: content, textHash: hash(content), sources: [] },
    lastCompositionFinishReason: 'length', attemptedPurposes: ['chapter-draft'],
    knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '作者附加检索词 潮声 亮灯',
      topK: 5, canonicalRevision: null, documentsRevision: null, items: [] } }
}

function bridge(recovery: GenerationRecoveryContext) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:read-context') return structuredClone(recovery)
    if (channel === 'db:draft-list-all') return []
    if (channel === 'db:draft-get-latest') throw new Error('CONTEXT_READING_REACHED')
    throw new Error(`UNEXPECTED_CHANNEL:${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath,
    sessionLease: session.leaseId, name: '合成恢复测试', novelConfig: {} } as never,
    refreshFileTree: vi.fn().mockResolvedValue(undefined) })
  return invoke
}

function execute(workflow: WorkflowDefinition) {
  const context: WorkflowContext = { runId: 'workflow-fixture', projectSession: session, projectPath: session.projectPath,
    data: {}, cancelled: false, generationModelId: 'synthetic-model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN' }
  const callbacks: StepCallbacks = { log: vi.fn(), appendText: vi.fn(), replaceText: vi.fn(), setProgress: vi.fn() }
  const step: WorkflowStep = { id: 'recover', name: '继续正文', description: '', status: 'running', logs: [] }
  return { context, result: workflow.steps[0].executor(step, context, callbacks) }
}

afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState(originalStore, true) })

it('从原资料快照恢复附加检索词，不发起新的准备或检索', async () => {
  const invoke = bridge(recoveryFixture())
  const workflow = await createDraftRecoveryWorkflow(session, handle)
  await expect(execute(workflow).result).rejects.toThrow('CONTEXT_READING_REACHED')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'generation:read-context', 'generation:read-context', 'db:draft-get-latest',
  ])
})

it.each([false, true])('已保存回执不依赖被删除的前章，显式片段选择=%s', async selectArtifacts => {
  const recovery = recoveryFixture()
  recovery.selectedDraftIds = [41]
  delete recovery.selectedDrafts
  recovery.composition = null
  recovery.savedDraft = { success: true, id: 42, version: 1, content, contentHash: hash(content) }
  const invoke = bridge(recovery)
  const workflow = await createDraftRecoveryWorkflow(session, handle, selectArtifacts ? ['original-artifact'] : undefined)
  const execution = execute(workflow)
  await expect(execution.result).resolves.toBe(content)
  expect(execution.context.data).toMatchObject({ draftId: 42, draftVersion: 1, draftContent: content })
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'generation:read-context', 'generation:read-context', 'db:draft-list-all',
  ])
})

it('未保存候选缺少主进程来源证明时拒绝恢复，不回退读取旧稿', async () => {
  const recovery = recoveryFixture()
  recovery.selectedDraftIds = [41]
  delete recovery.selectedDrafts
  const invoke = bridge(recovery)
  await expect(createDraftRecoveryWorkflow(session, handle)).rejects.toThrow('GENERATION_DRAFT_RECOVERY_SOURCE_CHANGED')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['generation:read-context'])
})

it('未保存候选沿主进程确认的前章内容恢复，不重新选择前章', async () => {
  const recovery = recoveryFixture()
  recovery.selectedDraftIds = [41]
  recovery.selectedDrafts = [{ draftId: 41, chapterNumber: 1, version: 2, content, contentHash: hash(content) }]
  const invoke = bridge(recovery)
  await expect(createDraftRecoveryWorkflow(session, handle)).resolves.toMatchObject({ projectSession: session })
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['generation:read-context'])
})
