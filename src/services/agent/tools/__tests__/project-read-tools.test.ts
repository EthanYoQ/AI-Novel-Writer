import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useDraftStore } from '../../../../stores/draft-store'
import { readArchitectureTool } from '../read-architecture.tool'
import { readFileTool } from '../read-file.tool'
import { searchKnowledgeTool } from '../search-knowledge.tool'
import { createAgentExecutionContext } from '../project-context'
import { builtinTools } from '..'

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'

function project(path: string) {
  return {
    id: 'main',
    sessionLease: `lease-${path === projectAPath ? 'A' : 'B'}`,
    name: path,
    path,
    novelConfig: {},
  }
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: project(projectAPath) as never })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useDraftStore.setState({
    dataProjectKey: null,
    loadingProjectKey: null,
    draftsByChapter: {},
  })
})

describe('agent project read tools', () => {
  it('keeps app-generated English results free of Chinese across every built-in tool', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    useDraftStore.setState({
      dataProjectKey: projectAPath,
      loadingProjectKey: null,
      draftsByChapter: {},
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:project-core-get' || channel === 'db:blueprint-get') return null
      if (channel === 'db:blueprint-get-all' || channel === 'db:character-get-all' || channel === 'db:draft-list') return []
      throw new Error(`Unexpected IPC channel: ${channel}`)
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
    const argsByTool: Record<string, Record<string, unknown>> = {
      read_file: { file_path: '../outside.txt' },
      search_knowledge: {},
      read_architecture: {},
      read_blueprint: { chapter_number: 1 },
      read_characters: {},
      read_project_state: {},
      read_drafts: { chapter_number: 1 },
      list_chapters: {},
      inspect_writing_skill: {},
      write_file: {},
      open_editor: {},
      start_workflow: {},
      propose_novel_config: { changes: {} },
      propose_chapter_blueprint: { chapter_number: 0, changes: {} },
      install_writing_skill: {},
      bind_writing_skill: {},
    }
    const context = createAgentExecutionContext()

    for (const tool of builtinTools) {
      const result = await tool.execute(argsByTool[tool.name] ?? {}, context)
      expect(`${result.content}\n${result.error ?? ''}`, tool.name).not.toMatch(/[\u3400-\u9fff]/u)
    }
  })

  it('directs architecture reads to the database-backed read_architecture tool', () => {
    expect(readFileTool.description).toContain('read_architecture')
    expect(readFileTool.description).not.toContain('架构文件、蓝图')
    expect(readFileTool.inputSchema.properties.file_path.description).toContain('read_architecture')
    expect(readFileTool.inputSchema.properties.file_path.description).not.toContain('02_architecture')
  })

  it('keeps a missing project file failure actionable without retrying or creating a file', async () => {
    const missingFileError = '项目文件不存在。请检查文件路径；故事架构保存在项目数据中，请使用 read_architecture 工具读取。'
    const invoke = vi.fn().mockResolvedValue({
      success: false,
      content: '',
      error: missingFileError,
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

    await expect(readFileTool.execute(
      { file_path: '02_architecture/世界观.md' },
      createAgentExecutionContext(),
    )).resolves.toEqual({
      success: false,
      content: '',
      error: missingFileError,
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('does not expose Chinese backend failures to an English agent', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'fs:read-file') {
        return { success: false, content: '', error: '主进程读取文件失败' }
      }
      if (channel === 'db:project-core-get') throw new Error('数据库读取失败')
      throw new Error(`Unexpected IPC channel: ${channel}`)
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
    const context = createAgentExecutionContext()

    await expect(readFileTool.execute({ file_path: 'notes.md' }, context)).resolves.toEqual({
      success: false,
      content: '',
      error: 'Could not read the file',
    })
    await expect(readArchitectureTool.execute({}, context)).resolves.toEqual({
      success: false,
      content: '',
      error: 'Could not read the architecture',
    })
  })

  it('uses the frozen Agent language for knowledge-search failures', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    const invoke = vi.fn()
      .mockResolvedValueOnce({ success: false, errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: '旧版知识库数据需要先修复' })
      .mockResolvedValueOnce({ success: false, errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: 'Legacy knowledge-base data must be repaired' })
      .mockResolvedValueOnce({ success: false, errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: '旧版知识库数据需要先修复' })
    vi.stubGlobal('window', { velaAPI: { invoke } })
    const context = createAgentExecutionContext()

    await expect(searchKnowledgeTool.execute({ query: 'campus' }, context)).resolves.toMatchObject({
      success: false,
      error: 'Could not search the knowledge base',
    })
    await expect(searchKnowledgeTool.execute({ query: 'campus' }, context)).resolves.toMatchObject({
      success: false,
      error: 'Legacy knowledge-base data must be repaired',
    })
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig: { writingLanguage: 'zh-CN' },
      } as never,
    })
    await expect(searchKnowledgeTool.execute(
      { query: '校园' },
      createAgentExecutionContext(),
    )).resolves.toMatchObject({
      success: false,
      error: '旧版知识库数据需要先修复',
    })
  })

  it('passes the frozen project path and discards an async result after project switch', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    const invoke = vi.fn(() => new Promise<unknown>((resolve) => { resolveRead = resolve }))
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

    const execution = readArchitectureTool.execute({}, createAgentExecutionContext())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'db:project-core-get',
      projectAPath,
      expect.objectContaining({ leaseId: 'lease-A' }),
    ))
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    resolveRead?.({
      premise: 'A project premise',
      charactersArch: '',
      worldbuilding: '',
      synopsis: '',
    })

    await expect(execution).resolves.toMatchObject({
      success: false,
      content: '',
      error: expect.stringContaining('当前项目已切换，本次工具结果已丢弃'),
    })
  })
})
