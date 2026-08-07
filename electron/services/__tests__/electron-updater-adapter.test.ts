import { describe, expect, it, vi } from 'vitest'

import {
  configureElectronUpdater,
  type ElectronUpdaterLike,
} from '../electron-updater-adapter'

describe('electron-updater adapter', () => {
  it('preserves the Builder-provided GitHub feed and prevents prerelease, downgrade, and quit-time installs', async () => {
    const updater: ElectronUpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      allowDowngrade: true,
      checkForUpdates: vi.fn(async () => ({
        updateInfo: { version: '0.2.6', releaseName: 'v0.2.6', releaseDate: '2026-07-26T00:00:00.000Z' },
      })),
      downloadUpdate: vi.fn(async () => ['C:/temp/update.exe']),
      quitAndInstall: vi.fn(),
      on: vi.fn(),
    }

    const backend = configureElectronUpdater(updater)
    const result = await backend.checkForUpdates()
    backend.quitAndInstall()

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(result).toEqual({
      updateInfo: { version: '0.2.6', releaseName: 'v0.2.6', releaseDate: '2026-07-26T00:00:00.000Z' },
    })
  })
})
