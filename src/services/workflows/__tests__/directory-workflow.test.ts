import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertBlueprintCoverage,
  parseTextBlueprints,
  parseTextBlueprintsStrict,
  createDirectoryWorkflow,
  saveAllBlueprints,
  saveChapterBlueprint,
  verifyBlueprintsPersisted,
  type ChapterBlueprint,
} from '../directory-workflow'
import { useProjectStore } from '../../../stores/project-store'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'

const blueprint: ChapterBlueprint = {
  chapterNumber: 1,
  title: '启程',
  role: '建置',
  purpose: '引出主角目标',
  keyEvents: '主角发现异常',
  characters: ['主角'],
  suspenseHook: '门外传来敲门声',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

function stubIpcInvoke(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result)
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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

function project(path: string): ProjectData {
  return {
    id: path,
    name: path,
    path,
    sessionLease: `lease-${path}`,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 3,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function workflowStep(name: string) {
  return {
    id: name,
    name,
    description: name,
    status: 'running' as const,
    logs: [],
  }
}

describe('parseTextBlueprints', () => {
  it('parses object responses with a blueprints array', () => {
    const result = parseTextBlueprints(
      JSON.stringify({
        blueprints: [
          {
            chapterNumber: 1,
            title: '启程',
            role: '建置',
            purpose: '引出主角目标',
            keyEvents: '主角发现异常',
            characters: ['主角'],
            suspenseHook: '门外传来敲门声',
          },
        ],
      }),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 1,
      title: '启程',
      role: '建置',
      purpose: '引出主角目标',
      keyEvents: '主角发现异常',
      characters: ['主角'],
      suspenseHook: '门外传来敲门声',
    })
  })

  it('parses bare array responses', () => {
    const result = parseTextBlueprints(
      JSON.stringify([
        {
          chapter_number: 2,
          title: '暗线',
          role: '铺垫',
          key_events: '反派留下线索',
          suspense_hook: '线索指向故人',
        },
      ]),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 2,
      title: '暗线',
      role: '铺垫',
      keyEvents: '反派留下线索',
      suspenseHook: '线索指向故人',
    })
  })

  it('parses fenced JSON responses', () => {
    const result = parseTextBlueprints(
      [
        '```json',
        '[',
        '{"chapterNumber":3,"title":"交锋","keyEvents":"主角正面迎敌"}',
        ']',
        '```',
      ].join('\n'),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 3,
      title: '交锋',
      keyEvents: '主角正面迎敌',
    })
  })

  it('returns an empty array for bad JSON in non-strict parsing', () => {
    expect(parseTextBlueprints('{not json', 1, 3)).toEqual([])
  })

  it('deduplicates repeated chapters by keeping the first parsed chapter', () => {
    const result = parseTextBlueprints(
      JSON.stringify({
        blueprints: [
          { chapterNumber: 1, title: '第一版' },
          { chapterNumber: 1, title: '第二版' },
          { chapterNumber: 2, title: '第二章' },
        ],
      }),
      1,
      3,
    )

    expect(result.map((item) => item.chapterNumber)).toEqual([1, 2])
    expect(result[0].title).toBe('第一版')
  })

  it('filters chapters outside the requested range', () => {
    const result = parseTextBlueprints(
      JSON.stringify([
        { chapterNumber: 1, title: '范围外' },
        { chapterNumber: 2, title: '范围内' },
        { chapterNumber: 4, title: '范围外' },
      ]),
      2,
      3,
    )

    expect(result.map((item) => item.chapterNumber)).toEqual([2])
  })

  it('returns an empty array when no chapters survive filtering', () => {
    expect(parseTextBlueprints('[{"chapterNumber": 9, "title": "太远"}]', 1, 3)).toEqual([])
  })
})

describe('parseTextBlueprintsStrict', () => {
  it('returns parsed blueprints for valid array input', () => {
    const result = parseTextBlueprintsStrict('[{"chapterNumber": 1, "title": "有效"}]', 1, 3)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('有效')
  })

  it('throws when JSON is malformed', () => {
    expect(() => parseTextBlueprintsStrict('{not json', 1, 3)).toThrow(/蓝图 JSON/)
  })

  it('throws when the parsed result is empty', () => {
    expect(() => parseTextBlueprintsStrict('[{"chapterNumber": 9, "title": "太远"}]', 1, 3)).toThrow(/未解析到/)
  })
})

describe('assertBlueprintCoverage', () => {
  it('throws when the generated result skips a chapter inside the target range', () => {
    expect(() => assertBlueprintCoverage([{ ...blueprint, chapterNumber: 3 }], 1, 3)).toThrow(/缺少目标章节/)
  })
})

describe('blueprint persistence helpers', () => {
  const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

  it('throws when saving one blueprint returns an IPC failure', async () => {
    stubIpcInvoke({ success: false, error: 'DB 未打开' })

    await expect(saveChapterBlueprint(blueprint, 'C:/NovelA', session)).rejects.toThrow('DB 未打开')
  })

  it('throws when saving many blueprints returns an IPC failure', async () => {
    stubIpcInvoke({ success: false, error: '写入失败' })

    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session)).rejects.toThrow('写入失败')
  })

  it('resolves when the IPC save succeeds', async () => {
    const invoke = stubIpcInvoke({ success: true })

    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session)).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('db:blueprint-upsert-many', [blueprint], 'C:/NovelA', session)
  })

  it('throws when persisted blueprint content does not match the generated result', async () => {
    stubIpcInvoke({ ...blueprint, title: '旧标题' })

    await expect(verifyBlueprintsPersisted(
      [blueprint],
      'C:/NovelA',
      { startChapter: 1, endChapter: 1 },
      session,
    )).rejects.toThrow(/内容与本次生成结果不一致/)
  })
})

describe('directory workflow project context', () => {
  it('freezes the launch project and lets the main-process guard reject a later cross-project save', async () => {
    const projectA = project('C:\\novels\\A')
    const projectB = project('C:\\novels\\B')
    useProjectStore.setState({ currentProject: projectA })
    const invoke = stubIpcInvoke({ success: true })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:project-core-get') {
        return {
          premise: '故事前提'.repeat(30),
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        }
      }
      if (channel === 'db:blueprint-upsert-many') {
        return useProjectStore.getState().currentProject?.path === args[1]
          ? { success: true }
          : { success: false, error: '项目上下文已切换' }
      }
      return []
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    })
    const context: WorkflowContext = {
      runId: 'test-run',
      projectPath: projectA.path,
      projectSession: {
        projectId: projectA.id,
        leaseId: projectA.sessionLease!,
        projectPath: projectA.path,
      },
      data: {
        newBlueprints: [blueprint],
        existingBlueprints: [],
      },
      cancelled: false,
    }
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }

    await expect(workflow.steps[0].executor(workflowStep('读取架构'), context, callbacks))
      .resolves.toContain('架构加载完成')
    expect(invoke).toHaveBeenCalledWith('db:project-core-get', projectA.path, context.projectSession)

    useProjectStore.setState({ currentProject: projectB })
    await expect(workflow.steps[2].executor(workflowStep('保存蓝图'), context, callbacks))
      .rejects.toThrow(/项目上下文已切换/)
    expect(invoke).toHaveBeenCalledWith('db:blueprint-upsert-many', [blueprint], projectA.path, context.projectSession)
    expect(invoke.mock.calls.some(([, ...args]) => args.includes(projectB.path))).toBe(false)
  })
})
