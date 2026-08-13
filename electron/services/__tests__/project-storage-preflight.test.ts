import { describe, expect, it } from 'vitest'

import {
  isProjectStoragePreflightError,
  projectStoragePreflightFailure,
  ProjectStoragePreflightError,
} from '../project-storage-preflight'

describe('project storage preflight failure seam', () => {
  it('maps the typed preflight error to one sanitized AppFailure contract', () => {
    const error = new ProjectStoragePreflightError(250, 120, 'knowledge-base')

    expect(isProjectStoragePreflightError(error)).toBe(true)
    expect(projectStoragePreflightFailure(error)).toEqual({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      error: error.message,
    })
  })

  it('accepts a cross-realm Error carrying the exact stable code but rejects plain duck-typed objects', () => {
    const serializedError = Object.assign(new Error('move the project'), {
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
    })

    expect(projectStoragePreflightFailure(serializedError)).toEqual({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      error: 'move the project',
    })
    expect(isProjectStoragePreflightError({
      code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      message: 'forged object',
    })).toBe(false)
    expect(projectStoragePreflightFailure(new Error('ordinary failure'))).toBeUndefined()
  })
})
