import { describe, expect, it, vi } from 'vitest'

import {
  UpdateService,
  type UpdateBackend,
  type UpdateCheckResult,
  type UpdatePreferences,
  type UpdatePreferencesStore,
  type UpdateState,
} from '../update-service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

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

  it('does not contact the backend when a packaged test or unpacked build lacks app-update.yml', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      updateConfiguration: 'missing',
      preferences: createPreferencesStore(),
    })

    const automatic = await service.checkAutomatically()
    const manual = await service.checkManually()

    expect(updater.checkCalls).toBe(0)
    expect(automatic).toMatchObject({ success: false, checked: false })
    expect(automatic.error).toBeUndefined()
    expect(manual).toMatchObject({
      success: false,
      checked: false,
      error: {
        code: 'UPDATE_CONFIGURATION_MISSING',
        phase: 'configuration',
        reason: 'configuration-missing',
        retryable: false,
        safeTechnicalDetails: 'UPDATE_CONFIGURATION_MISSING',
      },
    })
    expect(service.getState()).toMatchObject({ status: 'error' })
  })

  it('records at most one successful automatic check per calendar day while manual checks remain forceable', async () => {
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

  it('retries on the next startup when the earlier automatic check failed', async () => {
    const updater = new FakeUpdater()
    const preferences = createPreferencesStore()
    const options = {
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences,
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    }
    updater.checkError = new Error('offline')

    await new UpdateService(options).checkAutomatically()
    updater.checkError = undefined
    await new UpdateService(options).checkAutomatically()

    expect(updater.checkCalls).toBe(2)
  })

  it('serializes automatic and manual checks without joining the manual check', async () => {
    const automaticCheck = deferred<UpdateCheckResult | null>()
    const manualCheck = deferred<UpdateCheckResult | null>()
    const checks = [automaticCheck, manualCheck]
    const events: string[] = []
    let activeOperations = 0
    let maxConcurrency = 0
    let checkIndex = 0
    const updater: UpdateBackend = {
      checkForUpdates: async () => {
        const currentIndex = checkIndex
        checkIndex += 1
        events.push(`check-${currentIndex + 1}-start`)
        activeOperations += 1
        maxConcurrency = Math.max(maxConcurrency, activeOperations)
        const result = await checks[currentIndex].promise
        activeOperations -= 1
        events.push(`check-${currentIndex + 1}-end`)
        return result
      },
      downloadUpdate: async () => {
        throw new Error('download must require an explicit action')
      },
      quitAndInstall: () => undefined,
    }
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    const automaticResult = service.checkAutomatically()
    const manualResult = service.checkManually()
    await Promise.resolve()
    expect(events).toEqual(['check-1-start'])
    expect(maxConcurrency).toBe(1)

    automaticCheck.resolve(null)
    await automaticResult
    await Promise.resolve()
    expect(events).toEqual(['check-1-start', 'check-1-end', 'check-2-start'])

    manualCheck.resolve({ updateInfo: { version: '0.2.6' } })
    await expect(manualResult).resolves.toMatchObject({
      success: true,
      checked: true,
      updateAvailable: true,
    })
    expect(events).toEqual([
      'check-1-start',
      'check-1-end',
      'check-2-start',
      'check-2-end',
    ])
    expect(checkIndex).toBe(2)
    expect(maxConcurrency).toBe(1)
    expect(service.getState()).toMatchObject({
      status: 'available',
      availableVersion: '0.2.6',
    })
  })

  it('waits for an explicit download request after finding a newer stable update', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6', releaseName: 'v0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()

    expect(updater.downloadCalls).toBe(0)
    expect(service.getState()).toMatchObject({
      status: 'available',
      availableVersion: '0.2.6',
      releaseName: 'v0.2.6',
    })

    await service.downloadUpdate()

    expect(updater.downloadCalls).toBe(1)
    expect(service.getState()).toMatchObject({ status: 'downloaded' })
  })

  it('rejects a concurrent download request without starting a second backend download or rolling back success', async () => {
    const pendingDownload = deferred<string[]>()
    const downloadUpdate = vi.fn(() => pendingDownload.promise)
    const service = new UpdateService({
      updater: {
        checkForUpdates: async () => ({ updateInfo: { version: '0.2.6' } }),
        downloadUpdate,
        quitAndInstall: () => undefined,
      },
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
    })
    await service.checkManually()

    const first = service.downloadUpdate()
    const concurrent = service.downloadUpdate()

    expect(downloadUpdate).toHaveBeenCalledOnce()
    await expect(concurrent).resolves.toMatchObject({
      success: false,
      error: { code: 'DOWNLOAD_NOT_READY' },
      state: { status: 'downloading' },
    })
    pendingDownload.resolve([])
    await expect(first).resolves.toMatchObject({ success: true, state: { status: 'downloaded' } })
    expect(downloadUpdate).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({ status: 'downloaded' })
  })

  it('opens the injected release page instead of downloading on macOS reminder mode', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const openRelease = vi.fn(async () => undefined)
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      updateAction: 'open-release',
      openRelease,
      preferences: createPreferencesStore(),
    })

    await service.checkManually()

    expect(service.getState()).toMatchObject({ status: 'available', updateAction: 'open-release' })
    await expect(service.downloadUpdate()).resolves.toMatchObject({ success: false })
    await expect(service.openRelease()).resolves.toMatchObject({ success: true })
    expect(updater.downloadCalls).toBe(0)
    expect(openRelease).toHaveBeenCalledOnce()
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
    await service.downloadUpdate()
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

  it('does not claim a reminder was deferred when preferences cannot be persisted', async () => {
    const service = new UpdateService({
      updater: new FakeUpdater({ updateInfo: { version: '0.2.6' } }),
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createNonPersistingPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()
    const result = await service.deferReminder(7)

    expect(result).toMatchObject({
      success: false,
      error: { code: 'REMINDER_SAVE_FAILED' },
      state: { isReminderDeferred: false },
    })
    expect(service.getState().reminderUntil).toBeUndefined()
  })

  it('clears a deferred reminder from state when the release is no longer available', async () => {
    const updater = new FakeUpdater(null)
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore({
        availableUpdate: { version: '0.2.6' },
      }),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.deferReminder(30)
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
    await service.downloadUpdate()

    expect(states).toContainEqual(expect.objectContaining({
      status: 'downloading',
      downloadProgress: { percent: 42, transferred: 420, total: 1000, bytesPerSecond: 100 },
    }))
    expect(await service.requestInstall()).toMatchObject({ success: true })
    expect(updater.quitCalls).toBe(1)
  })

  it('keeps an already downloaded update installable and skips redundant network checks', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
      now: () => new Date('2026-07-25T09:00:00+08:00'),
    })

    await service.checkManually()
    await service.downloadUpdate()
    updater.checkError = new Error('offline after download')
    const redundantCheck = await service.checkManually()

    expect(redundantCheck).toMatchObject({
      success: true,
      checked: false,
      state: { status: 'downloaded', availableVersion: '0.2.6' },
    })
    expect(updater.checkCalls).toBe(1)
    await expect(service.requestInstall()).resolves.toMatchObject({ success: true })
    expect(updater.quitCalls).toBe(1)
  })

  it('downloads only once after overlapping checks discover the same release', async () => {
    const firstCheck = deferred<UpdateCheckResult | null>()
    let checkCalls = 0
    let downloadCalls = 0
    const updater: UpdateBackend = {
      checkForUpdates: async () => {
        checkCalls += 1
        if (checkCalls === 1) return firstCheck.promise
        return { updateInfo: { version: '0.2.6' } }
      },
      downloadUpdate: async () => {
        downloadCalls += 1
        return []
      },
      quitAndInstall: () => undefined,
      on: () => undefined,
    }
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
    })

    const automatic = service.checkAutomatically()
    const manual = service.checkManually()
    firstCheck.resolve({ updateInfo: { version: '0.2.6' } })

    await expect(automatic).resolves.toMatchObject({ success: true, updateAvailable: true })
    await expect(manual).resolves.toMatchObject({ success: true, checked: true, updateAvailable: true })
    expect(checkCalls).toBe(2)
    expect(downloadCalls).toBe(0)
    await service.downloadUpdate()
    await service.downloadUpdate()
    expect(downloadCalls).toBe(1)
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

  it.each([
    ['DNS/offline', new Error('getaddrinfo ENOTFOUND api.github.com token=secret C:\\Users\\private'), 'network', true, 'DNS_OR_OFFLINE'],
    ['proxy', new Error('proxy tunnel rejected http://user:secret@proxy.example'), 'proxy', true, 'PROXY_CONNECT_FAILED'],
    ['TLS', new Error('self signed certificate in certificate chain'), 'tls', true, 'TLS_HANDSHAKE_FAILED'],
    ['HTTP 403', new Error('HTTP 403 Bearer secret-token'), 'http-forbidden', false, 'HTTP_403'],
    ['HTTP 404', new Error('HTTP 404 latest.yml'), 'http-not-found', false, 'HTTP_404'],
    ['HTTP 429', new Error('HTTP 429 too many requests'), 'http-rate-limited', true, 'HTTP_429'],
    ['invalid metadata', new Error('Invalid latest.yml metadata at C:\\Users\\private'), 'metadata-invalid', false, 'UPDATE_METADATA_INVALID'],
  ] as const)('classifies manual %s check failures without exposing raw diagnostics', async (_name, checkError, reason, retryable, safeTechnicalDetails) => {
    const updater = new FakeUpdater()
    updater.checkError = checkError
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
    })

    const result = await service.checkManually()

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'CHECK_FAILED',
        phase: 'check',
        reason,
        retryable,
        safeTechnicalDetails,
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\private')
  })

  it('classifies a missing downloaded installer asset without exposing the asset URL', async () => {
    const updater = new FakeUpdater({ updateInfo: { version: '0.2.6' } })
    updater.downloadError = new Error('HTTP 404 installer asset https://token@example.invalid/update.exe')
    const service = new UpdateService({
      updater,
      currentVersion: '0.2.5',
      isPackaged: true,
      preferences: createPreferencesStore(),
    })

    await service.checkManually()
    const result = await service.downloadUpdate()

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'DOWNLOAD_FAILED',
        phase: 'download',
        reason: 'asset-missing',
        retryable: false,
        safeTechnicalDetails: 'UPDATE_ASSET_MISSING',
      },
    })
    expect(JSON.stringify(result)).not.toContain('example.invalid')
    expect(JSON.stringify(result)).not.toContain('token')
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

    await service.checkManually()
    const result = await service.downloadUpdate()

    expect(result).toMatchObject({ success: false, error: { code: 'DOWNLOAD_FAILED' } })
    expect(JSON.stringify(result)).not.toContain('download URL')
  })
})
