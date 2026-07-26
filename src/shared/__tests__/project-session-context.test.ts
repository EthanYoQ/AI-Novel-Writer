import { describe, expect, it } from 'vitest'

import {
  isProjectSessionContext,
  projectPathKey,
  sameProjectPathKey,
} from '../project-session-context'

describe('renderer project path identity', () => {
  it('compares Windows project paths without casing, separator, dot-segment, or trailing-separator drift', () => {
    expect(projectPathKey('C:\\Novels\\Alpha\\')).toBe(projectPathKey('c:/novels/./ALPHA'))
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'c:/NOVELS/alpha/')).toBe(true)
    expect(sameProjectPathKey('C:\\Novels\\Alpha', 'C:\\Novels\\Beta')).toBe(false)
  })
})

describe('project session context runtime contract', () => {
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
