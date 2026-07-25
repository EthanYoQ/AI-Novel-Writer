import { describe, expect, it } from 'vitest'

import { getUpdateRetryAction } from '../update-retry-action'

describe('update retry action', () => {
  it('retries only the failed operation represented by the error code', () => {
    expect(getUpdateRetryAction('INSTALL_FAILED')).toBe('install')
    expect(getUpdateRetryAction('REMINDER_SAVE_FAILED')).toBe('defer')
    expect(getUpdateRetryAction('CHECK_FAILED')).toBe('check')
    expect(getUpdateRetryAction('DOWNLOAD_FAILED')).toBe('check')
  })
})
