import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { ensureElectronNativeBinding } from '../prepare-native-for-electron.mjs'

describe('prepare native dependencies for Electron development', () => {
  it('runs the Electron ABI check before the development server', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(packageJson.scripts.predev).toBe('node scripts/prepare-native-for-electron.mjs')
  })

  it('returns immediately when better-sqlite3 already loads in Electron', async () => {
    const probe = vi.fn().mockReturnValue({ ok: true, diagnostic: '' })
    const rebuild = vi.fn()

    await expect(ensureElectronNativeBinding({ probe, rebuild })).resolves.toEqual({
      repaired: false,
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('rebuilds only after an Electron ABI mismatch and verifies the repaired binding', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({
        ok: false,
        diagnostic: 'NODE_MODULE_VERSION 141. This version requires NODE_MODULE_VERSION 145.',
      })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })
    const rebuild = vi.fn().mockResolvedValue(undefined)

    await expect(ensureElectronNativeBinding({ probe, rebuild })).resolves.toEqual({
      repaired: true,
    })
    expect(rebuild).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('stops before Vite when the rebuilt binding still cannot load in Electron', async () => {
    const probe = vi.fn().mockReturnValue({
      ok: false,
      diagnostic: 'ERR_DLOPEN_FAILED',
    })

    await expect(ensureElectronNativeBinding({
      probe,
      rebuild: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('ERR_DLOPEN_FAILED')
  })
})
