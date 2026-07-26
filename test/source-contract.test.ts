import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { normalizeSourceEol } from './source-contract'

describe('source contract normalization', () => {
  it('treats LF, CRLF, and CR source text as the same source contract', () => {
    const lf = 'first line\nsecond line\nthird line\n'
    const crlf = 'first line\r\nsecond line\r\nthird line\r\n'
    const cr = 'first line\rsecond line\rthird line\r'

    expect(normalizeSourceEol(crlf)).toBe(lf)
    expect(normalizeSourceEol(cr)).toBe(lf)
    expect(createHash('sha256').update(normalizeSourceEol(crlf)).digest('hex'))
      .toBe(createHash('sha256').update(normalizeSourceEol(lf)).digest('hex'))
  })
})
