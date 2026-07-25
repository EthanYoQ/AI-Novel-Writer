import { describe, expect, it } from 'vitest'

import {
  UpdateService,
  type UpdateBackend,
  type UpdateCheckResult,
  type UpdatePreferences,
  type UpdatePreferencesStore,
  type UpdateState,
} from '../update-service'

class FakeUpdater implements UpdateBackend {
  checkCalls = 0
  downloadCalls = 0
  quitCalls = 0
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
  checkError?: Error
  downloadError?: Error
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(private result: UpdateCheckResult | null = null) {}

  setResult(result: UpdateCheckResult | null): void {
    this.result = result
  }

  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    this.checkCalls += 1
    if (this.checkError) throw this.checkError
    return this.result
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1
    if (this.downloadError) throw this.downloadError
    if (this.progress) this.emit('download-progress', this.progress)
    return []
  }

  quitAndInstall(): void {
    this.quitCalls += 1
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function createPreferencesStore(initial: UpdatePreferences = {}): UpdatePreferencesStore {
  let preferences = initial
  return {
    read: () => preferences,
    write: (next) => {
      preferences = next
      return true
    },
  }
}

function createFailingPreferencesStore(): UpdatePreferencesStore {
  return {
    read: () => { throw new Error('preferences are locked') },
    write: () => { throw new Error('preferences are locked') },
  }
}

function createNonPersistingPreferencesStore(): UpdatePreferencesStore {
  return { read: () => ({}), write: () => false }
}

describe('UpdateService', () => {
  it('does not contact the update backend from an unpackaged development runtime', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: false,
      preferences: createPreferencesStore(),
    })

    await service.checkAutomatically()
    await service.checkManually()

    expect(updater.checkCalls).toBe(0)
    expect(service.getState()).toMatchObject({ status: 'disabled' })
  })

  it('checks at most once per calendar day automatically while manual checks remain forceable', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkAutomatically()
    await service.checkAutomatically()
    await service.checkManually()

    expect(updater.checkCalls).toBe(2)
  })

  it('downloads a newer stable update and exposes its downloaded state', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6', releaseName: 'v0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()

    expect(updater.downloadCalls).toBe(1)
    expect(service.getState()).toMatchObject({
      status: 'downloaded',
      availableVersion: '0.2.6',
      releaseName: 'v0.2.6',
    })
  })

  it('persists an available release before download so a later run can safely recover it', async () => {
    const preferences = createPreferencesStore()
    const service = new UpdateService({
      updater: new FakeUpdater({
        updateInfo: {
          version: '0.2.6',
          releaseName: 'v0.2.6',
          releaseNotes: 'Safe updater release',
        },
      }),
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences,
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()

    expect(preferences.read()).toMatchObject({
      availableUpdate: {
        version: '0.2.6',
        releaseName: 'v0.2.6',
        releaseNotes: 'Safe updater release',
      },
    })
  })

  it('recovers a remembered release without pretending the prior-process installer is ready', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const preferences = createPreferencesStore({
      lastAutomaticCheckDate: '2026-07-25',
      availableUpdate: { version: '0.2.6', releaseName: 'v0.2.6' },
    })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences,
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    expect(service.getState()).toMatchObject({
      status: 'available',
      availableVersion: '0.2.6',
    })
    expect(await service.requestInstall()).toMatchObject({
      success: false,
      error: { code: 'INSTALL_NOT_READY' },
    })

    await service.checkAutomatically()
    expect(updater.checkCalls).toBe(0)

    await service.checkManually()
    expect(updater.checkCalls).toBe(1)
    expect(service.getState()).toMatchObject({ status: 'downloaded' })
  })

  it('keeps a remembered available update visible after an automatic network failure', async () => {
    const updater = new FakeUpdater()
    updater.checkError = new Error('offline')
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore({
        availableUpdate: { version: '0.2.6', releaseName: 'v0.2.6' },
      }),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    const result = await service.checkAutomatically()

    expect(result.error).toBeUndefined()
    expect(service.getState()).toMatchObject({
      status: 'available',
      availableVersion: '0.2.6',
    })
  })

  it('rejects prerelease versions even when their numeric portion is newer', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.3.0-beta.1' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    const result = await service.checkManually()

    expect(result).toMatchObject({ success: true, updateAvailable: false })
    expect(updater.downloadCalls).toBe(0)
    expect(service.getState()).toMatchObject({ status: 'not-available' })
  })

  it('defers the current available update for seven days without permanently ignoring it', async () => {
    const service = new UpdateService({
      updater: new FakeUpdater({ updateInfo: { version: '0.2.6' } }),
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()
    await service.deferReminder(7)

    expect(service.getState()).toMatchObject({
      availableVersion: '0.2.6',
      reminderUntil: '2026-08-01T01:00:00.000Z',
      isReminderDeferred: true,
    })
  })

  it('clears a deferred reminder from state when the release is no longer available', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()
    await service.deferReminder(30)
    updater.setResult(null)
    await service.checkManually()

    expect(service.getState()).toMatchObject({
      status: 'not-available',
      isReminderDeferred: false,
    })
    expect(service.getState().reminderUntil).toBeUndefined()
  })

  it('does not allow an invalid persisted reminder date to hide an available update forever', () => {
    const service = new UpdateService({
      updater: new FakeUpdater(),
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore({
        availableUpdate: { version: '0.2.6' },
        reminder: { version: '0.2.6', until: 'not-a-real-date' },
      }),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    expect(service.getState()).toMatchObject({
      status: 'available',
      availableVersion: '0.2.6',
      isReminderDeferred: false,
    })
  })

  it('publishes safe download progress and installs only after a downloaded update', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    updater.progress = { percent: 42, transferred: 420, total: 1000, bytesPerSecond: 100 }
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })
    const states: UpdateState[] = []
    service.subscribe((state) => states.push(state))

    await service.checkManually()

    expect(states).toContainEqual(expect.objectContaining({
      status: 'downloading',
      downloadProgress: { percent: 42, transferred: 420, total: 1000, bytesPerSecond: 100 },
    }))
    expect(await service.requestInstall()).toMatchObject({ success: true })
    expect(updater.quitCalls).toBe(1)
  })

  it('returns a safe error for a manual failure while automatic failure remains silent', async () => {
    const manualUpdater = new FakeUpdater()
    manualUpdater.checkError = new Error('network details must not reach the renderer')
    const automaticUpdater = new FakeUpdater()
    automaticUpdater.checkError = new Error('network details must not reach the renderer')
    const options = {
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    }
    const manualService = new UpdateService({ ...options, updater: manualUpdater })
    const automaticService = new UpdateService({ ...options, updater: automaticUpdater })

    const manualResult = await manualService.checkManually()
    const automaticResult = await automaticService.checkAutomatically()

    expect(manualResult).toMatchObject({ success: false, error: { code: 'CHECK_FAILED' } })
    expect(JSON.stringify(manualResult)).not.toContain('network details')
    expect(automaticResult.error).toBeUndefined()
    expect(automaticService.getState()).toMatchObject({ status: 'idle' })
  })

  it('does not reject or bypass the daily automatic-check limit when update preferences cannot be read or written', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createFailingPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await expect(service.checkAutomatically()).resolves.toMatchObject({ success: false, checked: false })
    expect(updater.checkCalls).toBe(0)
  })

  it('skips automatic networking when a readable config refuses the safe preference write, while manual checks remain available', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createNonPersistingPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await expect(service.checkAutomatically()).resolves.toMatchObject({ success: false, checked: false })
    expect(updater.checkCalls).toBe(0)
    await expect(service.checkManually()).resolves.toMatchObject({ success: true, checked: true })
    expect(updater.checkCalls).toBe(1)
  })

  it('reports a download-specific safe error for a manual download failure', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    updater.downloadError = new Error('download URL must not reach the renderer')
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    const result = await service.checkManually()

    expect(result).toMatchObject({ success: false, error: { code: 'DOWNLOAD_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('download URL')
  })
})
