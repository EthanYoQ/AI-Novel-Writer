import { afterEach, describe, expect, it } from 'vitest'

import {
  getActiveProjectSessionContext,
  isProjectSessionContext,
  projectPathKey,
  sameProjectPathKey,
  setActiveProjectSessionContext,
} from '../project-session-context'

afterEach(() => setActiveProjectSessionContext(null))

describe('renderer project path identity', () => {
  it('compares Windows project paths without casing, separator, dot-segment, or trailing-separator drift', () => {
    expect(projectPathKey('C:\\Novels\\Alpha\\')).toBe(projectPathKey('c:/novels/./ALPHA'))
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'c:/NOVELS/alpha/')).toBe(true)
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'C:\\Novels\\Beta')).toBe(false)
  })
})

describe('project session context runtime contract', () => {
  it('keeps the frozen active context reference across identical session registrations', () => {
    const session = { projectId: 'project-1', leaseId: 'lease-1', projectPath: 'C:\\Novel' }
    setActiveProjectSessionContext(session)
    const active = getActiveProjectSessionContext()
    expect(active).not.toBe(session)
    expect(Object.isFrozen(active)).toBe(true)

    setActiveProjectSessionContext({ ...session })
    expect(getActiveProjectSessionContext()).toBe(active)

    setActiveProjectSessionContext({ ...session, leaseId: 'lease-2' })
    const nextLease = getActiveProjectSessionContext()
    expect(nextLease).not.toBe(active)
    expect(nextLease?.leaseId).toBe('lease-2')

    setActiveProjectSessionContext({ ...session, leaseId: 'lease-2', projectPath: 'C:\\Another' })
    expect(getActiveProjectSessionContext()).not.toBe(nextLease)
    expect(getActiveProjectSessionContext()?.projectPath).toBe('C:\\Another')
  })

  it('accepts the existing three-string session shape without imposing extra policy', () => {
    expect(isProjectSessionContext({
      projectId: '',
      leaseId: '',
      projectPath: '',
      futureMetadata: 'accepted by the runtime shape guard',
    })).toBe(true)
  })

  it.each([
    null,
    undefined,
    'project-session',
    42,
    [],
    {},
    { projectId: 'project-1', leaseId: 'lease-1' },
    { projectId: 'project-1', leaseId: 'lease-1', projectPath: 42 },
    { projectId: 'project-1', leaseId: false, projectPath: 'C:\\Novel' },
    { projectId: ['project-1'], leaseId: 'lease-1', projectPath: 'C:\\Novel' },
  ])('rejects an invalid project session candidate: %j', (candidate) => {
    expect(isProjectSessionContext(candidate)).toBe(false)
  })
})
