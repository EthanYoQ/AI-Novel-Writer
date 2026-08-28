import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportNovel } from '../export-service'
import { ipc } from '../ipc-client'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

vi.mock('../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

const addLog = vi.fn()
const projectPath = 'C:/novels/project-a'
const projectSession: ProjectSessionContext = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}
const projectSnapshot = {
  id: projectSession.projectId,
  sessionLease: projectSession.leaseId,
  path: projectPath,
  name: 'Project A',
  novelConfig: {
    genre: 'fantasy',
    targetAudience: 'general',
  },
}

vi.mock('../../stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: projectSnapshot })),
  },
}))

vi.mock('../../stores/workflow-store', () => ({
  useWorkflowStore: {
    getState: vi.fn(() => ({ addLog })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  setActiveProjectSessionContext(projectSession)
  vi.mocked(ipc.invoke).mockResolvedValue({ success: true } as never)
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1 }] as never
    if (channel === 'db:draft-get-finalized') return { id: 1 } as never
    if (channel === 'db:draft-get-full') return { content: 'Final chapter' } as never
    if (channel === 'db:project-core-get') return { synopsis: 'Synopsis' } as never
    throw new Error(`Unexpected channel: ${channel}`)
  }) as never)
})

afterEach(() => {
  setActiveProjectSessionContext(null)
})

describe('exportNovel project session ownership', () => {
  it('reads project data through the frozen session and writes only through the granted directory capability', async () => {
    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant', includeOutline: true },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({ success: true, path: 'Project A.md' })

    expect(ipc.invoke).toHaveBeenCalledWith(
      'fs:grant-write-file',
      'export-grant',
      'Project A.md',
      expect.stringContaining('Final chapter'),
    )
    expect(ipc.invokeWithProjectSession).toHaveBeenNthCalledWith(
      1,
      projectSession,
      'db:blueprint-get-all',
      projectPath,
    )
    expect(ipc.invokeWithProjectSession).toHaveBeenNthCalledWith(
      2,
      projectSession,
      'db:draft-get-finalized',
      1,
      projectPath,
    )
    expect(ipc.invokeWithProjectSession).toHaveBeenNthCalledWith(
      3,
      projectSession,
      'db:draft-get-full',
      1,
      projectPath,
    )
  })

  it('passes mixed UTF-8 finalized prose to the export capability without transcoding', async () => {
    const finalizedContent = 'The sign reads “夜航 Café” — déjà vu.'
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
      if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1 }] as never
      if (channel === 'db:draft-get-finalized') return { id: 1 } as never
      if (channel === 'db:draft-get-full') return { content: finalizedContent } as never
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    await expect(exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )).resolves.toEqual({ success: true, path: 'Project A.md' })

    const writeCall = vi.mocked(ipc.invoke).mock.calls.find(([channel]) => channel === 'fs:grant-write-file')
    const exportedContent = writeCall?.[3]
    expect(exportedContent).toEqual(expect.stringContaining(finalizedContent))
    const exportedFact = (exportedContent as string).slice(
      (exportedContent as string).indexOf(finalizedContent),
      (exportedContent as string).indexOf(finalizedContent) + finalizedContent.length,
    )
    expect(new TextEncoder().encode(exportedFact)).toEqual(new TextEncoder().encode(finalizedContent))
  })

  it('stops after the directory-selection export becomes stale on a same-path reopen', async () => {
    let resolveBlueprints: ((value: Array<{ chapterNumber: number }>) => void) | undefined
    vi.mocked(ipc.invokeWithProjectSession).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveBlueprints = resolve }),
    )

    const exporting = exportNovel(
      { format: 'merged-md', grantId: 'export-grant' },
      projectSnapshot,
      projectSession,
    )
    await vi.waitFor(() => expect(resolveBlueprints).toBeTypeOf('function'))
    setActiveProjectSessionContext({ ...projectSession, leaseId: 'lease-b' })
    resolveBlueprints!([])

    await expect(exporting).resolves.toEqual({
      success: false,
      error: expect.stringContaining('项目会话'),
    })
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledOnce()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})
