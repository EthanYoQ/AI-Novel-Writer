import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rm: vi.fn(async () => undefined),
}))

vi.mock('node:fs/promises', () => ({ default: { rm: mocks.rm } }))

import { removeDirectoryWithWindowsRetry } from '../remove-directory'

describe('removeDirectoryWithWindowsRetry', () => {
  beforeEach(() => mocks.rm.mockClear())

  it('delegates Windows transient directory failures to one finite asynchronous retry policy', async () => {
    await removeDirectoryWithWindowsRetry('C:\\projects\\example')

    expect(mocks.rm).toHaveBeenCalledWith('C:\\projects\\example', {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })

  it('propagates a terminal deletion failure after the bounded policy is exhausted', async () => {
    mocks.rm.mockRejectedValueOnce(Object.assign(new Error('still locked'), { code: 'EPERM' }))

    await expect(removeDirectoryWithWindowsRetry('C:\\projects\\locked'))
      .rejects.toMatchObject({ code: 'EPERM' })
  })
})
