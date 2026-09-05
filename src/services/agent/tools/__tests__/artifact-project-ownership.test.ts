import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { writeFileTool } from '../write-file.tool'

const projectAPath = 'C:\\novels\\A'

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: 'A',
      sessionLease: 'lease-A',
      name: 'A',
      path: projectAPath,
      novelConfig: {},
    } as never,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
})

describe('tool artifact project ownership', () => {
  it('freezes the tool-time project identity into every created artifact', async () => {
    const invoke = vi.fn(async () => ({ success: true }))
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

    const result = await writeFileTool.execute({
      file_path: 'chapters/1.md',
      content: 'chapter one',
    }, createAgentExecutionContext())

    expect(invoke).toHaveBeenCalledWith(
      'fs:write-file',
      `${projectAPath}/chapters/1.md`,
      'chapter one',
      projectAPath,
      expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
    )
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        type: 'file_modified',
        projectPath: projectAPath,
        projectSession: expect.objectContaining({
          projectId: 'A',
          leaseId: 'lease-A',
          projectPath: projectAPath,
        }),
      }),
    ])
    expect(Object.isFrozen(result.artifacts?.[0])).toBe(true)
    expect(Object.isFrozen(result.artifacts?.[0].projectSession)).toBe(true)
  })

  it('refuses an aborted write before invoking the authoritative filesystem boundary', async () => {
    const invoke = vi.fn(async () => ({ success: true }))
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    const controller = new AbortController()
    controller.abort()

    await expect(writeFileTool.execute({
      file_path: 'chapters/1.md',
      content: 'must not be written',
    }, {
      ...createAgentExecutionContext(),
      abortSignal: controller.signal,
    })).rejects.toThrow(/取消|cancel/u)

    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports the original write receipt after the response is delayed across a project switch', async () => {
    let finishWrite: (() => void) | undefined
    let commits = 0
    const invoke = vi.fn(async () => {
      commits++
      await new Promise<void>(resolve => { finishWrite = resolve })
      return { success: true }
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    const executionContext = createAgentExecutionContext()
    const resultPromise = writeFileTool.execute({
      file_path: 'chapters/1.md',
      content: 'committed once',
    }, executionContext)
    await vi.waitFor(() => expect(commits).toBe(1))

    useProjectStore.setState({
      currentProject: {
        id: 'B', sessionLease: 'lease-B', name: 'B', path: 'C:\\novels\\B', novelConfig: {},
      } as never,
    })
    finishWrite?.()

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      artifacts: [expect.objectContaining({
        projectPath: projectAPath,
        projectSession: expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
      })],
    })
    expect(commits).toBe(1)
  })
})
