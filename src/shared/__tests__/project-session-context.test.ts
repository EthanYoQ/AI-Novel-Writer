import { describe, expect, it } from 'vitest'

import {
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
