import { afterEach, describe, expect, it } from 'vitest'

import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import {
  getActiveProjectSessionContext,
  setActiveProjectSessionContext,
} from '../../shared/project-session-context'

const project = {
  id: 'project-a',
  path: 'C:\\NovelA',
  sessionLease: 'lease-a',
}

afterEach(() => {
  setActiveProjectSessionContext(null)
})

describe('component project session gate', () => {
  it('rejects a completion from an old lease after reopening the same canonical path', () => {
    setActiveProjectSessionContext({
      projectId: project.id,
      leaseId: project.sessionLease,
      projectPath: project.path,
    })
    const frozen = captureProjectSession(project)

    expect(frozen).toEqual({
      projectId: 'project-a',
      leaseId: 'lease-a',
      projectPath: 'C:\\NovelA',
    })
    expect(isProjectSessionCurrent(frozen)).toBe(true)

    // Same project root, but a new open must invalidate all prior async work.
    setActiveProjectSessionContext({
      projectId: project.id,
      leaseId: 'lease-b',
      projectPath: 'c:/NovelA/.',
    })

    expect(getActiveProjectSessionContext()?.projectPath).toBe('c:/NovelA/.')
    expect(isProjectSessionCurrent(frozen)).toBe(false)
  })

  it('fails closed when the rendered project no longer owns the active session', () => {
    setActiveProjectSessionContext({
      projectId: project.id,
      leaseId: 'lease-b',
      projectPath: 'C:\\NovelA',
    })

    expect(captureProjectSession(project)).toBeNull()
  })
})
