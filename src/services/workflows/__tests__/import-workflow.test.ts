import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createImportWorkflow } from '../import-workflow'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'

const styleMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}))
const postProcessMocks = vi.hoisted(() => ({
  loadCharacters: vi.fn(),
  loadAllDrafts: vi.fn(),
}))

vi.mock('../commands/analyze-style.command', () => ({
  AnalyzeWritingStyleCommand: vi.fn(function AnalyzeWritingStyleCommandMock() {
    return {
    execute: styleMocks.execute,
    }
  }),
}))
vi.mock('../../../stores/character-store', () => ({
  useCharacterStore: {
    getState: () => ({ loadCharacters: postProcessMocks.loadCharacters }),
  },
}))
vi.mock('../../../stores/draft-store', () => ({
  useDraftStore: {
    getState: () => ({ loadAllDrafts: postProcessMocks.loadAllDrafts }),
  },
}))

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const context: WorkflowContext = {
  runId: 'test-run',
  projectPath: 'C:/NovelA',
  projectSession: { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' },
  data: {},
  cancelled: false,
}

const importProjectSession = {
  projectId: 'test-project',
  leaseId: 'lease-test-project',
  projectPath: 'C:\\test-project',
}
const originalRefreshFileTree = useProjectStore.getState().refreshFileTree

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '\\uFE0F',
].join('|'), 'u')

beforeEach(() => {
  vi.clearAllMocks()
  postProcessMocks.loadCharacters.mockResolvedValue(undefined)
  postProcessMocks.loadAllDrafts.mockResolvedValue(undefined)
  useProjectStore.setState({
    currentProject: {
      id: 'test-project',
      sessionLease: 'lease-test-project',
      name: '测试项目',
      path: 'C:\\test-project',
      novelConfig: {} as never,
      characterStates: '',
      createdAt: '',
      updatedAt: '',
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  useProjectStore.setState({ currentProject: null, refreshFileTree: originalRefreshFileTree })
})

describe('createImportWorkflow', () => {
  it('extracts writing style from imported chapters before inferring blueprints', () => {
    const workflow = createImportWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: importProjectSession,
      chapters: [
        {
          number: 1,
          title: '启程',
          content: '雨声很急。主角推门而入。',
          wordCount: 13,
        },
      ],
    })

    const stepNames = workflow.steps.map((step) => step.name)

    expect(workflow.projectSession).toMatchObject({
      projectId: 'test-project',
      leaseId: 'lease-test-project',
    })
    expect(stepNames).toContain('AI 拆解文风与仿写指南')
    expect(stepNames.indexOf('AI 拆解文风与仿写指南')).toBeLessThan(stepNames.indexOf('AI 逐章推演蓝图'))
    expect(workflow.steps[0]).toMatchObject({
      name: '提交定稿事实与构建知识库',
      description: expect.stringContaining('数据库定稿事实（实体稿待发布）'),
    })
    expect(workflow.steps[0].description).not.toContain('写入 manuscript/')
  })

  it('fails the workflow when style imitation extraction fails', async () => {
    styleMocks.execute.mockRejectedValue(new Error('style failed'))
    const workflow = createImportWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: importProjectSession,
      chapters: [{ number: 1, title: '启程', content: '雨声很急。', wordCount: 5 }],
    })

    const step = workflow.steps.find(item => item.name === 'AI 拆解文风与仿写指南')
    await expect(step?.executor({} as never, context, callbacks)).rejects.toThrow('style failed')
  })

  it('fails the workflow when style imitation extraction returns empty output', async () => {
    styleMocks.execute.mockResolvedValue('')
    const workflow = createImportWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: importProjectSession,
      chapters: [{ number: 1, title: '启程', content: '雨声很急。', wordCount: 5 }],
    })

    const step = workflow.steps.find(item => item.name === 'AI 拆解文风与仿写指南')
    await expect(step?.executor({} as never, context, callbacks)).rejects.toThrow('未提取到可用')
  })

  it('keeps the import and imitation workflow free of pseudo icon text', () => {
    const combined = [
      'src/services/workflows/import-workflow.ts',
      'src/services/workflows/commands/analyze-style.command.ts',
      'src/services/workflows/commands/import-novel.command.ts',
    ].map(source).join('\n')

    expect(combined).not.toMatch(pseudoIconPattern)
  })

  it('continues post-processing when the derived file-tree refresh is pending', async () => {
    vi.useFakeTimers()
    const refreshFileTree = vi.fn(() => new Promise<void>(() => {}))
    useProjectStore.setState({ refreshFileTree })
    const workflow = createImportWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: importProjectSession,
      chapters: [{ number: 1, title: '启程', content: '雨声很急。', wordCount: 5 }],
    })
    const step = workflow.steps.find(item => item.name === '完成后处理')
    let settled = false
    let failure: unknown

    void step?.executor({} as never, context, callbacks).then(
      () => { settled = true },
      error => {
        settled = true
        failure = error
      },
    )

    await vi.advanceTimersByTimeAsync(5_000)

    expect(settled).toBe(true)
    expect(failure).toBeUndefined()
    expect(refreshFileTree).toHaveBeenCalledOnce()
    expect(postProcessMocks.loadCharacters).toHaveBeenCalledOnce()
    expect(postProcessMocks.loadAllDrafts).toHaveBeenCalledOnce()
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
    expect(callbacks.log).toHaveBeenCalledWith('小说拆解与仿写准备完成，结构化数据已就位。')
    expect(callbacks.setProgress).toHaveBeenCalledWith(100)
  })

  it('continues post-processing when the derived file-tree refresh rejects', async () => {
    const refreshFileTree = vi.fn(() => Promise.reject(new Error('refresh failed')))
    useProjectStore.setState({ refreshFileTree })
    const workflow = createImportWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: importProjectSession,
      chapters: [{ number: 1, title: '启程', content: '雨声很急。', wordCount: 5 }],
    })
    const step = workflow.steps.find(item => item.name === '完成后处理')

    await expect(step?.executor({} as never, context, callbacks)).resolves.toBeUndefined()

    expect(refreshFileTree).toHaveBeenCalledOnce()
    expect(postProcessMocks.loadCharacters).toHaveBeenCalledOnce()
    expect(postProcessMocks.loadAllDrafts).toHaveBeenCalledOnce()
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
    expect(callbacks.log).toHaveBeenCalledWith('小说拆解与仿写准备完成，结构化数据已就位。')
    expect(callbacks.setProgress).toHaveBeenCalledWith(100)
  })
})
