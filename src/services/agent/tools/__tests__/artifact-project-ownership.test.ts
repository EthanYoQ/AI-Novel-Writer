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
})
