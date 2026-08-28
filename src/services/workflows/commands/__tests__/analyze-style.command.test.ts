import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { AnalyzeWritingStyleCommand as RuntimeAnalyzeWritingStyleCommand } from '../analyze-style.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class AnalyzeWritingStyleCommand extends RuntimeAnalyzeWritingStyleCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeAnalyzeWritingStyleCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const context: WorkflowContext = {
  runId: 'test-run',
  projectPath: 'C:\\tmp\\vela-style-test',
  projectSession: { projectId: 'project-1', leaseId: 'lease-project-1', projectPath: 'C:\\tmp\\vela-style-test' },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

function stubIpcInvoke(updateResult: { success: boolean; error?: string } = { success: true }) {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'prompt:load-global') return Promise.resolve({ templates: [], diagnostics: [] })
    if (channel === 'db:project-core-update') return Promise.resolve(updateResult)
    return Promise.resolve(null)
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
  vi.clearAllMocks()
  useProjectStore.setState({
    currentProject: {
      id: 'project-1',
      name: '导入项目',
      path: 'C:\\tmp\\vela-style-test',
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 1,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '',
        worldSetting: '',
        goldenFinger: '',
        protagonistProfile: '',
        globalGuidance: '',
        writingStyle: '',
      },
      characterStates: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('AnalyzeWritingStyleCommand with imported samples', () => {
  it('writes analyzed sample text style to DB and novelConfig', async () => {
    const invoke = stubIpcInvoke()
    const command = new AnalyzeWritingStyleCommand({
      sampleTexts: ['短句密集，动作推进快，对话有压迫感。'],
    })
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM').mockResolvedValue(
      '节奏偏快，动作描写密集，对话短促有压迫感。',
    )

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toBe('节奏偏快，动作描写密集，对话短促有压迫感。')
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe(result)
    expect(invoke).toHaveBeenCalledWith(
      'db:project-core-update',
      { writingStyle: result },
      context.projectPath,
      context.projectSession,
    )
  })

  it('keeps visible analysis logs in the frozen English UI locale', async () => {
    stubIpcInvoke()
    const englishContext: WorkflowContext = {
      ...context,
      writingLanguage: 'zh-CN',
      uiLocale: 'en-US',
    }
    const command = new AnalyzeWritingStyleCommand({ sampleTexts: ['夜航 Café 的雨声很急。'] })
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValue('Tight pacing with rain-soaked imagery.')

    await command.execute({ step: {}, context: englishContext, callbacks })

    const logs = vi.mocked(callbacks.log).mock.calls.map(([message]) => message)
    expect(logs).toContain('Analyzing 1 imported text sample...')
    expect(logs).toContain('Running AI writing-style analysis...')
    expect(logs).toContain('Writing-style profile saved to the novel configuration')
    expect(logs.join('\n')).not.toMatch(/正在|文风特征已保存/u)
  })

  it('uses imported chapters as style samples without reading finalized drafts', async () => {
    const invoke = stubIpcInvoke()
    const command = new AnalyzeWritingStyleCommand({
      chapters: [
        {
          number: 1,
          title: '启程',
          content: '雨声很急。主角推门而入，所有人同时沉默。',
          wordCount: 24,
        },
      ],
    })
    const callLLM = vi
      .spyOn(command as unknown as { callLLM: (prompt: string) => Promise<string> }, 'callLLM')
      .mockResolvedValue('冷峻紧凑，场景切换迅速。')

    await command.execute({ step: {}, context, callbacks })

    expect(callLLM.mock.calls[0][0]).toContain('雨声很急')
    expect(invoke).not.toHaveBeenCalledWith('db:draft-get-max-finalized-chapter')
  })

  it('does not update in-memory writing style when DB persistence fails', async () => {
    stubIpcInvoke({ success: false, error: '项目数据库未打开' })
    const command = new AnalyzeWritingStyleCommand({
      sampleTexts: ['短句密集，动作推进快，对话有压迫感。'],
    })
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM').mockResolvedValue(
      '节奏偏快，动作描写密集，对话短促有压迫感。',
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('项目数据库未打开')
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle).toBe('')
  })

  it('does not apply the persisted result to a newly switched project', async () => {
    let resolveSave: ((value: { success: boolean }) => void) | undefined
    const invoke = vi.fn((channel: string) => {
      if (channel === 'prompt:load-global') return Promise.resolve({ templates: [], diagnostics: [] })
      if (channel === 'db:project-core-update') {
        return new Promise<{ success: boolean }>((resolve) => { resolveSave = resolve })
      }
      return Promise.resolve(null)
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
    const command = new AnalyzeWritingStyleCommand({
      sampleTexts: ['短句密集，动作推进快。'],
    })
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValue('旧项目分析出的文风')

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    useProjectStore.setState({
      currentProject: {
        ...useProjectStore.getState().currentProject!,
        id: 'project-2',
        path: 'C:\\tmp\\other-project',
        novelConfig: {
          ...useProjectStore.getState().currentProject!.novelConfig,
          writingStyle: '新项目原有文风',
        },
      },
    })
    resolveSave!({ success: true })

    await expect(execution).rejects.toThrow('当前项目已切换')
    expect(useProjectStore.getState().currentProject?.novelConfig.writingStyle)
      .toBe('新项目原有文风')
  })
})
