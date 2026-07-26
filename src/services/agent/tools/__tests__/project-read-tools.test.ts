import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { readArchitectureTool } from '../read-architecture.tool'
import { readFileTool } from '../read-file.tool'
import { createAgentExecutionContext } from '../project-context'

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
})

describe('agent project read tools', () => {
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
