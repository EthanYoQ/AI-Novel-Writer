import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { PROJECT_CHANGED_ERROR } from '../project-context'
import { createAgentExecutionContext } from '../project-context'
import { updateConfigTool } from '../update-config.tool'

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'

function project(projectPath: string) {
  return {
    id: 'main',
    sessionLease: `lease-${projectPath === projectAPath ? 'A' : 'B'}`,
    name: projectPath,
    path: projectPath,
    novelConfig: { genre: 'fantasy' },
  }
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: project(projectAPath) as never })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
})

describe('update_config project ownership', () => {
  it('discards a successful write result when the active project changed in flight', async () => {
    let resolveWrite: ((value: { success: boolean }) => void) | undefined
    const invoke = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveWrite = resolve
    }))
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

    const execution = updateConfigTool.execute(
      { field: 'genre', value: 'mystery' },
      createAgentExecutionContext(),
    )
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'project:update-config',
      'main',
      expect.objectContaining({
        novelConfig: expect.objectContaining({ genre: 'mystery' }),
      }),
      projectAPath,
      expect.objectContaining({ leaseId: 'lease-A' }),
    ))
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    resolveWrite?.({ success: true })

    await expect(execution).rejects.toThrow(PROJECT_CHANGED_ERROR)
  })
})
