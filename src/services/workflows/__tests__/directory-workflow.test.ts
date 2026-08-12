import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertBlueprintCoverage,
  commitDirectoryBlueprintRange,
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
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'

const blueprint: ChapterBlueprint = {
  chapterNumber: 1,
  title: '启程',
  role: '建置',
  purpose: '引出主角目标',
  keyEvents: '主角发现异常',
  characters: ['主角'],
  relationshipHints: [],
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
            relationships: [],
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
          purpose: '让主角发现反派留下的暗线',
          key_events: '反派留下线索',
          characters: ['主角'],
          relationships: [],
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
        '{"chapterNumber":3,"title":"交锋","role":"高潮","purpose":"迫使主角正面抉择","keyEvents":"主角正面迎敌","characters":["主角"],"relationships":[],"suspenseHook":"敌人揭下面具"}',
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

  it('rejects repeated chapters instead of choosing one model answer', () => {
    const result = parseTextBlueprints(
      JSON.stringify({
        blueprints: [
          { ...blueprint, chapterNumber: 1, title: '第一版', relationships: [] },
          { ...blueprint, chapterNumber: 1, title: '第二版', relationships: [] },
          { ...blueprint, chapterNumber: 2, title: '第二章', relationships: [] },
        ],
      }),
      1,
      3,
    )

    expect(result).toEqual([])
  })

  it('filters chapters outside the requested range', () => {
    const result = parseTextBlueprints(
      JSON.stringify([
        { ...blueprint, chapterNumber: 1, title: '范围外', relationships: [] },
        { ...blueprint, chapterNumber: 2, title: '范围内', relationships: [] },
        { ...blueprint, chapterNumber: 4, title: '范围外', relationships: [] },
      ]),
      2,
      3,
    )

    expect(result.map((item) => item.chapterNumber)).toEqual([2])
  })

  it('returns an empty array when no chapters survive filtering', () => {
    expect(parseTextBlueprints(JSON.stringify([{ ...blueprint, chapterNumber: 9, relationships: [] }]), 1, 3)).toEqual([])
  })
})

describe('parseTextBlueprintsStrict', () => {
  it('returns parsed blueprints for valid array input', () => {
    const result = parseTextBlueprintsStrict(JSON.stringify([{ ...blueprint, relationships: [] }]), 1, 1)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('启程')
  })

  it('throws when JSON is malformed', () => {
    try {
      parseTextBlueprintsStrict('{not json', 1, 3)
      expect.unreachable('expected typed structured diagnostic')
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredContractDiagnostic)
      expect(error).toMatchObject({ code: 'invalid_json', path: '$', field: '$' })
    }
  })

  it('rejects an out-of-range chapter instead of silently filtering it', () => {
    expect(() => parseTextBlueprintsStrict(
      JSON.stringify([{ ...blueprint, chapterNumber: 9, relationships: [] }]),
      1,
      3,
    )).toThrow('结构化合同诊断 code=unexpected_item path=blueprints field=blueprints')
  })

  it('rejects duplicate chapter numbers instead of hiding them during normalization', () => {
    expect(() => parseTextBlueprintsStrict(
      JSON.stringify([
        { ...blueprint, chapterNumber: 1, title: '第一次', relationships: [] },
        { ...blueprint, chapterNumber: 1, title: '第二次', relationships: [] },
      ]),
      1,
      1,
    )).toThrow('结构化合同诊断 code=duplicate_item path=blueprints field=blueprints')
  })

  it('rejects a structurally valid JSON blueprint when required semantic facts are missing', () => {
    const incomplete = { ...blueprint } as Record<string, unknown>
    delete incomplete.relationshipHints

    expect(() => parseTextBlueprintsStrict(JSON.stringify([incomplete]), 1, 1))
      .toThrow('结构化合同诊断 code=missing_field path=blueprints[0].relationships field=relationships')
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

  it('returns the atomic range-commit receipt from the main-process seam', async () => {
    const receipt = {
      mode: 'replace-range',
      operationId: 'directory-run-1',
      payloadHash: 'a'.repeat(64),
      idempotent: false,
      startChapter: 1,
      endChapter: 1,
      chapterNumbers: [1],
      snapshot: [blueprint],
      characterSyncInput: [blueprint],
    }
    const invoke = stubIpcInvoke({ success: true, receipt })

    await expect(commitDirectoryBlueprintRange(
      [blueprint],
      'C:/NovelA',
      { mode: 'replace-range', startChapter: 1, endChapter: 1 },
      'directory-run-1',
      session,
    )).resolves.toEqual(receipt)
    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-commit-range',
      {
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 1,
        blueprints: [blueprint],
      },
      'C:/NovelA',
      session,
    )
  })
})

describe('directory workflow project context', () => {
  it('freezes the launch project and does not schedule a duplicate post-command save step', async () => {
    const projectA = project('C:\\novels\\A')
    useProjectStore.setState({ currentProject: projectA })
    const invoke = stubIpcInvoke({ success: true })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:project-core-get') {
        return {
          premise: '故事前提'.repeat(30),
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        }
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

    expect(workflow.steps.map(step => step.name)).toEqual(['读取架构', '生成蓝图'])
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })
})
