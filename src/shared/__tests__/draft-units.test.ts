import { describe, expect, it } from 'vitest'

import {
  DRAFT_UNIT_ALGORITHM_VERSION,
  countDraftUnits,
  countLegacyDraftUnitsV1,
} from '../draft-units'

describe('draft unit counting', () => {
  it('versions the persisted count contract', () => {
    expect(DRAFT_UNIT_ALGORITHM_VERSION).toBe(3)
  })

  it('counts mixed Chinese and English with one shared generation metric', () => {
    expect(countDraftUnits('林岚 walked into the room.')).toBe(6)
  })

  it('keeps accented and decomposed Unicode words whole', () => {
    expect(countDraftUnits('Café naïve résumé déjà vu')).toBe(5)
    expect(countDraftUnits('Cafe\u0301')).toBe(1)
  })

  it('counts non-BMP Han characters by code point rather than UTF-16 units', () => {
    expect(countDraftUnits('𠀀𠮷')).toBe(2)
  })

  it('preserves the historical per-code-point count for digits', () => {
    expect(countDraftUnits('2026')).toBe(4)
  })

  it('does not treat punctuation, whitespace, or emoji as prose units', () => {
    expect(countDraftUnits('... ！😀 🚀')).toBe(0)
  })

  it('retains the v0.9.0 algorithm only for durable replay compatibility', () => {
    expect(countLegacyDraftUnitsV1('Café')).toBe(2)
    expect(countDraftUnits('Café')).toBe(1)
  })
})
