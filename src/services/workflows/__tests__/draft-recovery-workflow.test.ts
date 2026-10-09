import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerationRecoveryContext } from '../../../shared/generation-owner-contract'
import { DRAFT_VISIBLE_TEXT_VERSION, composeDraftVisibleContinuation, type DraftVisibleTextVersion } from '../../../shared/draft-visible-text'
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
  return { handle, operation: 'chapter-draft', chapterNumber: 2, modelId: 'synthetic-model', draftSave: { kind: 'absent' },
    authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify(info) },
      { id: 'draft:author-config', text: '{}' }, { id: 'draft:target-units', text: '900' }],
    selectedDraftIds: [], selectedDrafts: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [2, 3, 4, 5, 6, 7],
    composition: { algorithm: DRAFT_VISIBLE_TEXT_VERSION, artifactIds: ['original-artifact'], text: content, textHash: hash(content), sources: [] },
    lastCompositionFinishReason: 'length', attemptedPurposes: ['chapter-draft'],
    knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '作者附加检索词 潮声 亮灯',
      topK: 5, canonicalRevision: null, documentsRevision: null, items: [] } }
}

function bridge(recovery: GenerationRecoveryContext) {
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
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

it.each(['failed', 'completed'] as const)('没有正文时可从原入口恢复细纲：%s', async state => {
  const recovery = recoveryFixture()
  recovery.composition = null
  recovery.lastCompositionFinishReason = null
  recovery.attemptedPurposes = ['chapter-draft-short-outline']
  recovery.draftShortOutline = { artifactIds: ['outline'], promptHash: 'a'.repeat(64),
    completedOutput: state === 'completed' ? '完整细纲' : null,
    retry: state === 'failed' ? { kind: 'available', failedAttemptId: 'failed' } : { kind: 'unavailable' } }
  const invoke = bridge(recovery)
  await expect(createDraftRecoveryWorkflow(session, handle)).resolves.toMatchObject({ generationModelId: 'synthetic-model' })
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['generation:read-context'])
})

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
  recovery.draftSave = { kind: 'current', receipt: { success: true, id: 42, version: 1, content, contentHash: hash(content) } }
  const invoke = bridge(recovery)
  const workflow = await createDraftRecoveryWorkflow(session, handle, selectArtifacts ? ['original-artifact'] : undefined)
  const execution = execute(workflow)
  await expect(execution.result).resolves.toBe(content)
  expect(execution.context.data).toMatchObject({ draftId: 42, draftVersion: 1, draftContent: content })
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'generation:read-context', 'generation:read-context', 'db:draft-list-all',
  ])
})

it.each([false, true])('正文已变化时拒绝创建恢复工作流，显式片段选择=%s', async selectArtifacts => {
  const recovery = recoveryFixture()
  recovery.draftSave = { kind: 'changed' }
  const invoke = bridge(recovery)
  await expect(createDraftRecoveryWorkflow(session, handle, selectArtifacts ? ['original-artifact'] : undefined))
    .rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['generation:read-context'])
})

it('工作流创建后正文发生变化时拒绝发布旧生成正文', async () => {
  const recovery = recoveryFixture()
  const invoke = bridge(recovery)
  const workflow = await createDraftRecoveryWorkflow(session, handle)
  recovery.draftSave = { kind: 'changed' }
  const execution = execute(workflow)
  await expect(execution.result).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
  expect(execution.context.data).toEqual({})
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['generation:read-context', 'generation:read-context'])
})

it('重选候选后的读取发现正文已变化时拒绝创建恢复工作流', async () => {
  const recovery = recoveryFixture()
  const invoke = bridge(recovery), original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'generation:resume') return { handle: { ...handle, epoch: session.leaseId },
      artifacts: [{ artifactId: 'original-artifact', text: content, compositionEligible: true }] }
    if (channel === 'generation:compose-visible') { recovery.draftSave = { kind: 'changed' }; return recovery.composition }
    return original(channel)
  })
  await expect(createDraftRecoveryWorkflow(session, handle, ['original-artifact'])).rejects.toThrow('GENERATION_DRAFT_RECEIPT_INVALID')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'generation:read-context', 'generation:resume', 'generation:compose-visible', 'generation:read-context',
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

it.each(['draft-visible-v1', DRAFT_VISIBLE_TEXT_VERSION, null] as const)(
  '显式选择原始片段沿用已有算法，无组合时使用新算法：%s', async storedAlgorithm => {
    const recovery = recoveryFixture()
    const refrain = '海上的钟声穿过二十年前的雨夜，他重新读出刻在石碑上的誓言：无论谁来到门前，我们都将为他留下一盏灯。'
    const raw = `少年时。\n\n${refrain}\n\n二十年后。\n\n${refrain}`
    const algorithm: DraftVisibleTextVersion = storedAlgorithm ?? DRAFT_VISIBLE_TEXT_VERSION
    const expected = composeDraftVisibleContinuation('', raw, algorithm)
    if (storedAlgorithm) recovery.composition = { ...recovery.composition!, algorithm: storedAlgorithm, text: expected, textHash: hash(expected) }
    else recovery.composition = null
    const invoke = bridge(recovery)
    const original = invoke.getMockImplementation()!
    const resumedHandle = { ...handle, epoch: session.leaseId }
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'generation:resume') return { handle: resumedHandle, artifacts: [
        { artifactId: 'original-artifact', text: raw, compositionEligible: true },
      ] }
      if (channel === 'generation:compose-visible') {
        expect(args.slice(0, 4)).toEqual([resumedHandle, ['original-artifact'], storedAlgorithm ? hash(expected) : undefined, algorithm])
        recovery.composition = { algorithm, text: expected, textHash: hash(expected), artifactIds: ['original-artifact'], sources: [] }
        return recovery.composition
      }
      return original(channel)
    })
    await expect(createDraftRecoveryWorkflow(session, handle, ['original-artifact'])).resolves.toMatchObject({ projectSession: session })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('generation:execute')
  },
)
