import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  CommitPlanningMaterialCharactersCommand,
  ExtractPlanningMaterialCharactersCommand as RuntimeCommand,
} from '../planning-material.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class ExtractPlanningMaterialCharactersCommand extends RuntimeCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const projectPath = 'C:\\novels\\A'
const projectSession = { projectId: 'project-1', leaseId: 'lease-1', projectPath }
const context: WorkflowContext = {
  runId: 'planning-import-run',
  projectPath,
  projectSession,
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId

describe('planning material character extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    context.data = {}
    context.cancelled = false
    useProjectStore.setState({
      currentProject: {
        id: projectSession.projectId,
        name: 'A',
        path: projectPath,
        sessionLease: projectSession.leaseId,
        novelConfig: { writingLanguage: 'zh-CN' },
      } as never,
    })
  })

  it('keeps extracted candidates uncommitted until the confirmation command runs', async () => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:character-roster-read') {
        return { status: 'ready', revision: 4, entries: [] }
      }
      if (channel === 'db:character-roster-commit') {
        const request = args[0] as { entries: unknown[] }
        return {
          success: true,
          receipt: { snapshot: { entries: request.entries, renderedMarkdown: '# 角色图谱' } },
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    const generateStream = vi.fn(async (_messages, streamCallbacks) => {
      streamCallbacks.onDone?.(JSON.stringify({
        results: [{
          sourceId: '1:1',
          characterCards: [{
            name: '周岚',
            role: 'supporting',
            age: '45',
            background: '守馆二十年',
            motivation: '保护幸存者',
          }],
        }],
      }), undefined, 'stop')
      return 'planning-material-request'
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream,
    })

    const preview = await new ExtractPlanningMaterialCharactersCommand([
      { fileName: '人物设定.md', text: '周岚45岁，守馆20年，动机是保护幸存者。' },
    ]).execute({ step: {}, context, callbacks })

    expect(preview).toContain('周岚')
    expect(preview).toContain('45')
    expect(preview).toContain('守馆二十年')
    expect(preview).toContain('保护幸存者')
    expect(invoke).not.toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )

    await new CommitPlanningMaterialCharactersCommand().execute({ step: {}, context, callbacks })

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'novel_import',
        entries: [expect.objectContaining({ name: '周岚', role: 'supporting' })],
      }),
      projectPath,
      projectSession,
    )
  })

  it('does not commit extracted candidates after confirmation is cancelled', async () => {
    const invoke = vi.fn()
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    const generateStream = vi.fn(async (_messages, streamCallbacks) => {
      streamCallbacks.onDone?.(JSON.stringify({
        results: [{
          sourceId: '1:1',
          characterCards: [{ name: '周岚', role: 'supporting' }],
        }],
      }), undefined, 'stop')
      return 'planning-material-request'
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream,
    })

    await new ExtractPlanningMaterialCharactersCommand([
      { fileName: '人物设定.md', text: '周岚是配角。' },
    ]).execute({ step: {}, context, callbacks })
    context.cancelled = true

    await expect(new CommitPlanningMaterialCharactersCommand().execute({ step: {}, context, callbacks }))
      .rejects.toThrow('工作流已取消')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useLLMStore.setState({
      defaultModelId: originalDefaultModelId,
      generateStream: originalGenerateStream,
    })
    useProjectStore.setState({ currentProject: null })
  })

  it.each(['bare JSON', 'one full JSON fence'] as const)(
    'accepts %s and stages normalized cards without committing them',
    async (responseFormat) => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:character-roster-read') {
        return { status: 'ready', revision: 4, entries: [] }
      }
      if (channel === 'db:character-roster-commit') {
        const request = args[0] as { entries: unknown[] }
        return {
          success: true,
          receipt: {
            snapshot: { entries: request.entries, renderedMarkdown: '# 角色图谱' },
          },
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    let observedPrompt = ''
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observedPrompt = messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? ''
        const json = JSON.stringify({
          results: [{
            sourceId: '1:1',
            characterCards: [{
              name: '林晓',
              role: 'protagonist',
              personality: '谨慎',
              relationships: [],
            }],
          }],
        })
        const content = responseFormat === 'one full JSON fence'
          ? `\`\`\`json\n${json}\n\`\`\``
          : json
        streamCallbacks.onDone?.(content, undefined, 'stop')
        return 'planning-material-request'
      }),
    })

    const command = new ExtractPlanningMaterialCharactersCommand([
      { fileName: '人物设定.md', text: '林晓是谨慎的主角，负责调查校园数据系统。' },
    ])
    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('林晓')

    expect(observedPrompt).toContain('林晓是谨慎的主角')
    expect(observedPrompt).toContain('只写入资料明确陈述的事实')
    expect(observedPrompt).not.toContain('已识别姓名')
    expect(observedPrompt).not.toContain('缺失信息使用空字符串')
    expect(observedPrompt).not.toContain('"currentState"')
    expect(invoke).not.toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    },
  )

  it.each([
    [
      'zh-CN',
      '周岚45岁，守馆20年，隐瞒历史事故，动机是保护幸存者。',
      '资料中明确陈述的每条角色事实都必须写入对应支持字段',
      '资料未明确给出的可选字段必须省略',
    ],
    [
      'en-US',
      'Zhou Lan is 45, has guarded the archive for 20 years, concealed a historic accident, and wants to protect the survivors.',
      'Every explicit character fact in the material must be included in the corresponding supported field',
      'Omit optional fields that are not explicitly stated',
    ],
  ] as const)(
    'lists the complete optional character-card contract for %s without requesting invented values',
    async (writingLanguage, material, factCoverageInstruction, omissionInstruction) => {
      let observedPrompt = ''
      useProjectStore.setState({
        currentProject: {
          id: projectSession.projectId,
          name: 'A',
          path: projectPath,
          sessionLease: projectSession.leaseId,
          novelConfig: { writingLanguage },
        } as never,
      })
      useLLMStore.setState({
        defaultModelId: 'model-1',
        generateStream: vi.fn(async (messages, streamCallbacks) => {
          observedPrompt = messages.find(
            (message: { role: string; content: string }) => message.role === 'user',
          )?.content ?? ''
          streamCallbacks.onDone?.(JSON.stringify({
            results: [{ sourceId: '1:1', characterCards: [] }],
          }), undefined, 'stop')
          return 'planning-material-request'
        }),
      })

      const command = new ExtractPlanningMaterialCharactersCommand([
        { fileName: 'characters.md', text: material },
      ])
      await command.execute({
        step: {},
        context: { ...context, writingLanguage, uiLocale: writingLanguage },
        callbacks,
      })

      for (const field of [
        'gender', 'age', 'appearance', 'personality', 'background', 'abilities',
        'motivation', 'relationships', 'arc', 'notes',
      ]) {
        expect(observedPrompt).toContain(`"${field}"`)
      }
      expect(observedPrompt).toContain(factCoverageInstruction)
      expect(observedPrompt).toContain(omissionInstruction)
      expect(observedPrompt).not.toContain('"currentState"')
    },
  )

  it('preserves complementary facts when one character appears in two material chunks', async () => {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:character-roster-read') {
        return { status: 'ready', revision: 4, entries: [] }
      }
      if (channel === 'db:character-roster-commit') {
        const request = args[0] as { entries: unknown[] }
        return {
          success: true,
          receipt: { snapshot: { entries: request.entries, renderedMarkdown: '# 角色图谱' } },
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    const generateStream = vi.fn(async (_messages, streamCallbacks) => {
      streamCallbacks.onDone?.(JSON.stringify({
        results: [
          {
            sourceId: '1:1',
            characterCards: [
              {
                name: '周岚',
                role: 'supporting',
                background: '守馆二十年',
                notes: '隐瞒历史事故',
                relationships: [
                  { target: '林晓', relation: '事故知情人' },
                  { target: '林晓', relation: '秘密保护' },
                ],
              },
              { name: '林晓', role: 'protagonist' },
            ],
          },
          {
            sourceId: '1:2',
            characterCards: [{
              name: '周岚',
              role: 'supporting',
              background: '曾负责事故善后',
              notes: '拒绝公开幸存者名单',
              relationships: [
                { target: '林晓', relation: '秘密保护' },
                { target: '林晓', relation: '共同守密' },
              ],
            }],
          },
        ],
      }), undefined, 'stop')
      return 'planning-material-request'
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const command = new ExtractPlanningMaterialCharactersCommand([{
      fileName: '人物设定.md',
      text: `${'设定'.repeat(5_950)}周岚守馆二十年并隐瞒历史事故。\n\n${'后续'.repeat(60)}周岚曾负责事故善后，并拒绝公开幸存者名单。`,
    }])
    const preview = await command.execute({ step: {}, context, callbacks })
    await new CommitPlanningMaterialCharactersCommand().execute({ step: {}, context, callbacks })

    const commitRequest = invoke.mock.calls.find(([channel]) => channel === 'db:character-roster-commit')?.[1] as {
      entries: Array<{
        name: string
        background: string
        notes: string
        relationships: Array<{ target: string; relation: string }>
      }>
    }
    const zhouLan = commitRequest.entries.filter(character => character.name === '周岚')
    expect(preview).toContain('守馆二十年；曾负责事故善后')
    expect(preview).toContain('隐瞒历史事故；拒绝公开幸存者名单')
    expect(zhouLan).toEqual([expect.objectContaining({
      background: '守馆二十年；曾负责事故善后',
      notes: '隐瞒历史事故；拒绝公开幸存者名单',
      relationships: [
        { target: '林晓', relation: '事故知情人' },
        { target: '林晓', relation: '秘密保护' },
        { target: '林晓', relation: '共同守密' },
      ],
    })])
    expect(generateStream).toHaveBeenCalledTimes(1)
  })

  it.each(['non-JSON', 'prose around one fence', 'multiple fences'] as const)(
    'reports a safe structured failure for %s',
    async (invalidFormat) => {
    useProjectStore.setState({
      currentProject: {
        id: projectSession.projectId,
        name: 'A',
        path: projectPath,
        sessionLease: projectSession.leaseId,
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        const json = JSON.stringify({
          results: [{ sourceId: '1:1', characterCards: [{ name: 'Lin', role: 'protagonist' }] }],
        })
        const content = invalidFormat === 'prose around one fence'
          ? `PRIVATE_PROSE\n\`\`\`json\n${json}\n\`\`\`\nPRIVATE_TRAILING_PROSE`
          : invalidFormat === 'multiple fences'
            ? `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``
            : 'PRIVATE_INVALID_OUTPUT'
        streamCallbacks.onDone?.(content, undefined, 'stop')
        return 'planning-material-request'
      }),
    })

    const command = new ExtractPlanningMaterialCharactersCommand([
      { fileName: 'characters.md', text: 'Lin is the protagonist.' },
    ])
    let failure: unknown
    try {
      await command.execute({
        step: {},
        context: { ...context, writingLanguage: 'en-US', uiLocale: 'en-US' },
        callbacks,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Character-card extraction failed (code=invalid_output; reason=invalid_item).',
    )
    expect((failure as Error).message).not.toContain('PRIVATE_INVALID_OUTPUT')
    expect((failure as Error).message).not.toContain('PRIVATE_PROSE')
    expect((failure as Error).message).not.toContain('PRIVATE_TRAILING_PROSE')
    expect((failure as Error).message).not.toMatch(/[\u3400-\u9fff]/u)
    },
  )

  it.each([
    ['missing', { name: '林晓' }],
    ['unsupported', { name: '林晓', role: 'mentor' }],
  ] as const)('rejects a %s character role before committing the roster', async (_case, card) => {
    const invoke = vi.fn()
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify({
          results: [{
            sourceId: '1:1',
            characterCards: [card],
          }],
        }), undefined, 'stop')
        return 'planning-material-request'
      }),
    })

    const command = new ExtractPlanningMaterialCharactersCommand([
      { fileName: '人物设定.md', text: '林晓负责指导调查。' },
    ])

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(
      '角色卡提取失败（code=invalid_output；reason=invalid_item）。',
    )
    expect(invoke).not.toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('starts the next material chunk at a nearby paragraph boundary', async () => {
    const paragraph = `新段落开始，${'铺垫'.repeat(80)}林晓是主角。`
    const observedPrompts: string[] = []
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observedPrompts.push(
          messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? '',
        )
        streamCallbacks.onDone?.(JSON.stringify({
          results: [
            { sourceId: '1:1', characterCards: [] },
            { sourceId: '1:2', characterCards: [] },
          ],
        }), undefined, 'stop')
        return 'planning-material-request'
      }),
    })

    const command = new ExtractPlanningMaterialCharactersCommand([
      { fileName: '长篇设定.md', text: `${'前'.repeat(11_950)}\n\n${paragraph}` },
    ])
    await command.execute({ step: {}, context, callbacks })

    expect(observedPrompts).toHaveLength(1)
    expect(observedPrompts[0]).toContain(`【资料 1:2｜长篇设定.md】\n${paragraph}`)
  })

  it('keeps a surrogate pair intact at a hard material chunk boundary', async () => {
    let observedPrompt = ''
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observedPrompt = messages.find(
          (message: { role: string; content: string }) => message.role === 'user',
        )?.content ?? ''
        streamCallbacks.onDone?.(JSON.stringify({
          results: [
            { sourceId: '1:1', characterCards: [] },
            { sourceId: '1:2', characterCards: [] },
          ],
        }), undefined, 'stop')
        return 'planning-material-request'
      }),
    })

    const command = new ExtractPlanningMaterialCharactersCommand([{
      fileName: 'emoji.txt',
      text: `${'a'.repeat(11_999)}😀${'b'.repeat(10)}`,
    }])
    await command.execute({ step: {}, context, callbacks })

    const firstMarker = '【资料 1:1｜emoji.txt】\n'
    const secondMarker = '\n\n【资料 1:2｜emoji.txt】\n'
    const firstStart = observedPrompt.indexOf(firstMarker) + firstMarker.length
    const secondMarkerStart = observedPrompt.indexOf(secondMarker)
    const secondStart = secondMarkerStart + secondMarker.length
    expect(observedPrompt.slice(firstStart, secondMarkerStart)).toHaveLength(11_999)
    expect(observedPrompt.slice(secondStart)).toBe(`😀${'b'.repeat(10)}`)
  })
})
