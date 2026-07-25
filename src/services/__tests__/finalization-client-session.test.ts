import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { retryFinalizationPublication } from '../finalization-client'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'

const invoke = vi.fn()
const frozenSession = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath: 'C:\\NovelA',
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ success: true, committed: true })
  vi.stubGlobal('window', { velaAPI: { invoke } })
  setActiveProjectSessionContext(frozenSession)
})

afterEach(() => {
  setActiveProjectSessionContext(null)
  vi.unstubAllGlobals()
})

describe('retryFinalizationPublication', () => {
  it('sends the caller-frozen session instead of recapturing one later', async () => {
    await retryFinalizationPublication('finalization-1', frozenSession)

    expect(invoke).toHaveBeenCalledWith(
      'finalization:retry',
      'finalization-1',
      frozenSession,
    )
  })

  it('rejects a retry after the same path is reopened under a new lease', async () => {
    setActiveProjectSessionContext({
      ...frozenSession,
      leaseId: 'lease-b',
      projectPath: 'c:/NovelA/.',
    })

    await expect(retryFinalizationPublication('finalization-1', frozenSession))
      .rejects.toThrow('项目会话已变化')
    expect(invoke).not.toHaveBeenCalled()
  })
})
