import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('config-utils', () => {
  it('uses an explicit AI_NOVEL_VELA_HOME only when a controlled environment provides one', async () => {
    vi.stubEnv('AI_NOVEL_VELA_HOME', 'C:/temp/isolated-vela-home')
    const configUtils = await import('../config-utils')

    expect(configUtils.VELA_HOME).toBe('C:/temp/isolated-vela-home')
  })
})
