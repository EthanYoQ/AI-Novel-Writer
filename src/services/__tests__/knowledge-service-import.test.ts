import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, invokeWithProjectSession } = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeWithProjectSession: vi.fn(),
}))

vi.mock('../ipc-client', () => ({
  ipc: { invoke, invokeWithProjectSession },
}))

import {
  importPlanningMaterial,
  selectPlanningMaterials,
} from '../knowledge-service'

const projectSession = {
  projectId: 'project-1',
  leaseId: 'lease-1',
  projectPath: 'C:\\novels\\A',
}

describe('planning material knowledge import', () => {
  beforeEach(() => {
    invoke.mockReset()
    invokeWithProjectSession.mockReset()
  })

  it('reads only files explicitly granted by the file picker', async () => {
    invoke
      .mockResolvedValueOnce([{ grantId: 'grant-1', displayName: '设定.md' }])
      .mockResolvedValueOnce({ success: true, content: '# 角色\n林晓：主角' })

    await expect(selectPlanningMaterials()).resolves.toEqual([
      { fileName: '设定.md', text: '# 角色\n林晓：主角' },
    ])
    expect(invoke).toHaveBeenNthCalledWith(1, 'dialog:select-knowledge-files')
    expect(invoke).toHaveBeenNthCalledWith(2, 'fs:grant-read-file', 'grant-1')
  })

  it('imports text through the frozen project session', async () => {
    invokeWithProjectSession.mockResolvedValue({ success: true, docId: 'doc-1', chunkCount: 2 })

    await expect(importPlanningMaterial(
      projectSession,
      { fileName: 'world.md', text: '作者的世界观事实' },
    )).resolves.toMatchObject({ success: true, docId: 'doc-1' })
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'kb:import-planning-text',
      '作者的世界观事实',
      'world.md',
      projectSession.projectPath,
    )
  })
})
