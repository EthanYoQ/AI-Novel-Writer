import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { launchCreativeWorkflow } from '../../../workflows/creative-workflow-launcher'
import { PROJECT_FACT_TARGETS } from '../../../project-fact-targets'
import { createAgentExecutionContext } from '../project-context'
import { startWorkflowTool } from '../start-workflow.tool'
import { writeFileTool } from '../write-file.tool'

const projectPath = 'C:\\novels\\issue-90'
const project = {
  id: 'issue-90',
  sessionLease: 'lease-issue-90',
  name: 'Issue 90 reproduction',
  path: projectPath,
  novelConfig: {
    genre: '奇幻',
    subGenre: '',
    targetAudience: '',
    totalChapters: 10,
    wordsPerChapter: 3000,
    plotStructure: 'three_act',
    narrativePOV: 'third_limited',
    coreOutline: '林舟必须在永夜吞没城市前找回太阳。',
    worldSetting: '',
    goldenFinger: '',
    protagonistProfile: '',
    globalGuidance: '',
  },
}

function stubWorkflowIpc(overrides: Partial<Record<string, unknown>> = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn((channel: string) => {
    if (channel in overrides) return Promise.resolve(overrides[channel])
    if (channel === 'db:project-core-get') {
      const longEnough = '完整架构信息'.repeat(20)
      return Promise.resolve({ premise: longEnough, charactersArch: longEnough, worldbuilding: longEnough, synopsis: longEnough })
    }
    if (channel === 'db:character-get-all') return Promise.resolve([{ name: '林舟' }])
    if (channel === 'db:blueprint-get-all') return Promise.resolve([{ chapterNumber: 1 }])
    if (channel === 'db:blueprint-get') {
      return Promise.resolve({
        chapterNumber: 1,
        title: '最后的灯',
        role: '开篇',
        purpose: '建立核心冲突',
        keyEvents: '林舟点亮灯塔',
        characters: ['林舟'],
        suspenseHook: '太阳去了哪里',
        userGuidance: '',
        notes: '',
        notesUpdatedAt: '',
      })
    }
    // Keep the real workflow registered while this launcher-seam test observes it.
    return new Promise(() => {})
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
  return invoke
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: project as never })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
})

describe('Issue #90 AI assistant project actions', () => {
  it.each([
    {
      label: 'architecture config',
      intent: { workflow: 'generate_architecture' } as const,
      prepare: () => useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, coreOutline: '', protagonistProfile: '', worldSetting: '' } } as never }),
      expected: '小说配置',
    },
    {
      label: 'directory prerequisites',
      intent: { workflow: 'generate_blueprint' } as const,
      prepare: () => stubWorkflowIpc({ 'db:project-core-get': { premise: '', charactersArch: '', worldbuilding: '', synopsis: '' } }),
      expected: '故事前提',
    },
    {
      label: 'draft character roster',
      intent: { workflow: 'generate_draft', chapterNumber: 1 } as const,
      prepare: () => stubWorkflowIpc({ 'db:character-get-all': [] }),
      expected: '角色卡',
    },
    {
      label: 'previous chapter finalization',
      intent: { workflow: 'generate_draft', chapterNumber: 2 } as const,
      prepare: () => stubWorkflowIpc({ 'db:draft-get-finalized': null }),
      expected: '第 1 章尚未定稿',
    },
    {
      label: 'previous chapter post-processing',
      intent: { workflow: 'generate_draft', chapterNumber: 2 } as const,
      prepare: () => stubWorkflowIpc({
        'db:draft-get-finalized': { id: 1 },
        'db:post-process-get-latest-run': {
          id: 'post-1', sourceLabel: '第1章定稿', createdAt: '', updatedAt: '', allCriticalPassed: false,
        },
        'db:post-process-get-steps': [{
          id: 1, runId: 'post-1', stepKey: 'chapter_notes', label: '章节要点', critical: true,
          ok: false, errorMsg: 'failed', attemptCount: 1, completedAt: '', lastAttemptAt: '',
        }],
      }),
      expected: '定稿后处理未完成',
    },
  ])('rejects failed canonical $label guard before registering a run', async ({ intent, prepare, expected }) => {
    prepare()
    const projectSession = createAgentExecutionContext().projectSession
    if (!projectSession) throw new Error('test project session missing')

    await expect(launchCreativeWorkflow(intent, projectSession)).rejects.toThrow(expected)
    expect(useWorkflowStore.getState().activeRuns).toEqual([])
    expect(useWorkflowStore.getState().history).toEqual([])
  })

  it('returns no workflow artifact when a canonical guard rejects the Agent action', async () => {
    stubWorkflowIpc({ 'db:character-get-all': [] })

    const result = await startWorkflowTool.execute({ workflow: 'generate_draft', chapter_number: 1 }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: false })
    expect('artifacts' in result).toBe(false)
    expect(useWorkflowStore.getState().activeRuns).toEqual([])
    expect(useWorkflowStore.getState().history).toEqual([])
  })

  it('launches through the public seam only after a real run is registered', async () => {
    stubWorkflowIpc()
    const projectSession = createAgentExecutionContext().projectSession
    if (!projectSession) throw new Error('test project session missing')

    const receipt = await launchCreativeWorkflow({
      workflow: 'generate_draft',
      chapterNumber: 1,
    }, projectSession)

    expect(receipt).toMatchObject({
      accepted: true,
      workflow: 'generate_draft',
      projectPath,
      runId: expect.any(String),
      status: 'running',
    })
    expect(useWorkflowStore.getState().activeRuns).toContainEqual(expect.objectContaining({
      id: receipt.runId,
      projectSession,
    }))
  })

  it.each([
    { workflow: 'generate_draft', chapter_number: 1 },
    { workflow: 'generate_architecture' },
    { workflow: 'generate_blueprint' },
  ])('returns a real launch receipt for $workflow', async (args) => {
    stubWorkflowIpc()

    const result = await startWorkflowTool.execute(args, createAgentExecutionContext())

    expect(result).toMatchObject({
      success: true,
      artifacts: [{
        type: 'workflow_started',
        projectPath,
        runId: expect.any(String),
        status: 'running',
      }],
    })
    const runId = result.artifacts?.[0]?.runId
    expect(useWorkflowStore.getState().activeRuns).toContainEqual(expect.objectContaining({
      id: runId,
      projectPath,
      status: 'running',
    }))
  })

  it.each(['review', 'refine', 'finalize'])('fails closed when %s lacks a draft identity', async (workflow) => {
    const result = await startWorkflowTool.execute({
      workflow,
      chapter_number: 1,
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('草稿')
  })

  it.each(PROJECT_FACT_TARGETS.flatMap(target => target.fileNames.map(fileName => [
    `nested/${fileName}`,
    target.workflow,
  ] as const)))('rejects reserved semantic target %s and names the domain workflow', async (filePath, workflow) => {
    const invoke = stubWorkflowIpc()

    const result = await writeFileTool.execute({
      file_path: filePath,
      content: '不应成为游离的项目事实',
    }, createAgentExecutionContext())

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain(workflow)
    expect(invoke).not.toHaveBeenCalled()
  })
})
