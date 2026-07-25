/**
 * 主进程中的更新检查服务。
 *
 * 该文件只依赖一个可替换的更新后端；Electron 的 autoUpdater 适配器位于单独文件，
 * 从而避免把更新器对象或其错误直接暴露给渲染进程。
 */

import type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateError,
  UpdateErrorCode,
  UpdatePreferences,
  UpdateReleaseInfo,
  UpdateReminder,
  UpdateReminderDelay,
  UpdateState,
  UpdateStatus,
} from '../../src/shared/update-types'

export type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateError,
  UpdateErrorCode,
  UpdatePreferences,
  UpdateReleaseInfo,
  UpdateReminder,
  UpdateReminderDelay,
  UpdateState,
  UpdateStatus,
} from '../../src/shared/update-types'

export interface UpdateBackend {
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(): void
  on?(_event: string, _listener: (...args: unknown[]) => void): void
}

export interface UpdatePreferencesStore {
  read(): UpdatePreferences
  /** 返回 false 表示偏好未能被安全持久化。 */
  write(preferences: UpdatePreferences): boolean
}

export interface UpdateServiceOptions {
  updater: UpdateBackend
  currentVersion: string
  isPackaged: boolean
  preferences: UpdatePreferencesStore
  now?: () => Date
}

function localCalendarDate(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function stableVersionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function normalizeProgress(value: unknown): UpdateDownloadProgress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const number = (key: string) => typeof input[key] === 'number' && Number.isFinite(input[key])
    ? Math.max(0, input[key] as number)
    : 0
  return {
    percent: Math.min(100, number('percent')),
    transferred: number('transferred'),
    total: number('total'),
    bytesPerSecond: number('bytesPerSecond'),
  }
}

/** 预发布版本和非 SemVer 版本不属于可用更新。 */
export function isHigherStableVersion(candidate: string, current: string): boolean {
  const candidateParts = stableVersionParts(candidate)
  const currentParts = stableVersionParts(current)
  if (!candidateParts || !currentParts) return false

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index]
    }
  }
  return false
}

/**
 * 更新服务的最小公共行为：在已打包的应用中，自动检查每天最多一次；
 * 用户手动检查始终可以绕过该频率限制。
 */
export class UpdateService {
  private readonly now: () => Date
  private state: UpdateState
  private reminder?: UpdateReminder
  private readonly listeners = new Set<(state: UpdateState) => void>()

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? (() => new Date())
    const preferences = this.readPreferences() ?? {}
    this.reminder = preferences.reminder
    const availableUpdate = preferences.availableUpdate
      && isHigherStableVersion(preferences.availableUpdate.version, options.currentVersion)
      ? preferences.availableUpdate
      : undefined
    const reminderState = availableUpdate
      ? this.reminderStateFor(availableUpdate.version)
      : { reminderUntil: undefined, isReminderDeferred: false }
    this.state = {
      status: options.isPackaged ? (availableUpdate ? 'available' : 'idle') : 'disabled',
      currentVersion: options.currentVersion,
      ...(availableUpdate ? {
        availableVersion: availableUpdate.version,
        releaseName: availableUpdate.releaseName,
        releaseNotes: availableUpdate.releaseNotes,
        releaseDate: availableUpdate.releaseDate,
      } : {}),
      ...(preferences.lastCheckedAt ? { lastCheckedAt: preferences.lastCheckedAt } : {}),
      ...reminderState,
    }
    this.bindUpdaterEvents()
  }

  getState(): UpdateState {
    if (!this.state.availableVersion) return { ...this.state }
    const reminder = this.reminderFor(this.state.availableVersion)
    return {
      ...this.state,
      reminderUntil: reminder?.until,
      isReminderDeferred: Boolean(reminder),
    }
  }

  /** 订阅经过净化的更新状态；回调不会接触 autoUpdater 或原始错误对象。 */
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  async checkAutomatically(): Promise<UpdateCheckResponse> {
    if (!this.options.isPackaged) return this.disabledResponse()

    const now = this.now()
    const today = localCalendarDate(now)
    const preferences = this.readPreferences()
    // 无法读取或保存检查日期时，不自动联网，避免每次重启都绕过“每天一次”的上限。
    if (!preferences) return this.response({ success: false, checked: false })
    if (preferences.lastAutomaticCheckDate === today) {
      return this.response({ success: true, checked: false })
    }

    if (!this.writePreferences({
      ...preferences,
      lastCheckedAt: now.toISOString(),
      lastAutomaticCheckDate: today,
    })) {
      return this.response({ success: false, checked: false })
    }
    return this.performCheck('automatic', now)
  }

  async checkManually(): Promise<UpdateCheckResponse> {
    if (!this.options.isPackaged) return this.disabledResponse()

    const now = this.now()
    const preferences = this.readPreferences() ?? {}
    this.writePreferences({
      ...preferences,
      lastCheckedAt: now.toISOString(),
    })
    return this.performCheck('manual', now)
  }

  private async performCheck(mode: 'automatic' | 'manual', now: Date): Promise<UpdateCheckResponse> {
    this.setState({
      ...this.state,
      status: 'checking',
      lastCheckedAt: now.toISOString(),
      error: undefined,
    })

    let result: UpdateCheckResult | null
    try {
      result = await this.options.updater.checkForUpdates()
    } catch {
      return this.handleFailure(mode, 'CHECK_FAILED', this.state.availableVersion ? 'available' : 'idle')
    }

    const update = result?.updateInfo
    if (!update || !isHigherStableVersion(update.version, this.options.currentVersion)) {
      this.forgetAvailableUpdate()
      this.setState({
        ...this.state,
        status: 'not-available',
        availableVersion: undefined,
        releaseName: undefined,
        releaseNotes: undefined,
        releaseDate: undefined,
        downloadProgress: undefined,
        reminderUntil: undefined,
        isReminderDeferred: false,
      })
      return this.response({ success: true, checked: true })
    }

    this.rememberAvailableUpdate(update)
    this.setState({
      ...this.state,
      status: 'downloading',
      availableVersion: update.version,
      releaseName: update.releaseName,
      releaseNotes: update.releaseNotes,
      releaseDate: update.releaseDate,
      ...this.reminderStateFor(update.version),
      downloadProgress: undefined,
    })
    try {
      await this.options.updater.downloadUpdate()
    } catch {
      return this.handleFailure(mode, 'DOWNLOAD_FAILED', 'available')
    }
    this.setState({ ...this.state, status: 'downloaded' })
    return this.response({ success: true, checked: true, updateAvailable: true })
  }

  async deferReminder(days: UpdateReminderDelay): Promise<UpdateActionResponse> {
    if (!this.options.isPackaged) {
      return this.actionResponse(false, { code: 'UPDATES_DISABLED' })
    }
    if (days !== 7 && days !== 30) {
      return this.actionResponse(false, { code: 'INVALID_REMINDER_DELAY' })
    }
    if (!this.state.availableVersion) {
      return this.actionResponse(false, { code: 'REMINDER_NOT_AVAILABLE' })
    }

    const until = new Date(this.now().getTime() + days * 24 * 60 * 60 * 1000).toISOString()
    this.reminder = { version: this.state.availableVersion, until }
    const preferences = this.readPreferences() ?? {}
    this.writePreferences({ ...preferences, reminder: this.reminder })
    this.setState({
      ...this.state,
      reminderUntil: until,
      isReminderDeferred: true,
    })
    return this.actionResponse(true)
  }

  /** 只响应渲染进程明确发出的安装请求。 */
  async requestInstall(): Promise<UpdateActionResponse> {
    if (!this.options.isPackaged) {
      return this.actionResponse(false, { code: 'UPDATES_DISABLED' })
    }
    if (this.state.status !== 'downloaded') {
      return this.actionResponse(false, { code: 'INSTALL_NOT_READY' })
    }

    try {
      this.options.updater.quitAndInstall()
      return this.actionResponse(true)
    } catch {
      return this.actionResponse(false, { code: 'INSTALL_FAILED' })
    }
  }

  private disabledResponse(): UpdateCheckResponse {
    this.setState({ ...this.state, status: 'disabled' })
    return this.response({
      success: false,
      checked: false,
      error: { code: 'UPDATES_DISABLED' },
    })
  }

  private reminderFor(version: string): UpdateReminder | undefined {
    if (!this.reminder || this.reminder.version !== version) return undefined
    const reminderUntil = Date.parse(this.reminder.until)
    if (!Number.isFinite(reminderUntil) || reminderUntil <= this.now().getTime()) return undefined
    return this.reminder
  }

  private rememberAvailableUpdate(update: UpdateReleaseInfo): void {
    const preferences = this.readPreferences() ?? {}
    this.writePreferences({ ...preferences, availableUpdate: update })
  }

  private forgetAvailableUpdate(): void {
    const preferences = this.readPreferences() ?? {}
    if (!preferences.availableUpdate) return
    const withoutAvailableUpdate = { ...preferences }
    delete withoutAvailableUpdate.availableUpdate
    this.writePreferences(withoutAvailableUpdate)
  }

  private readPreferences(): UpdatePreferences | undefined {
    try {
      return this.options.preferences.read()
    } catch (error) {
      console.warn('[Vela Update] 无法读取更新偏好，当前会话将使用安全默认值。', error)
      return undefined
    }
  }

  private writePreferences(preferences: UpdatePreferences): boolean {
    try {
      return this.options.preferences.write(preferences)
    } catch (error) {
      // 写入失败不能让后台更新或手动检查演变为未处理异常。
      console.warn('[Vela Update] 无法保存更新偏好，已继续本次安全更新操作。', error)
      return false
    }
  }

  private reminderStateFor(version: string): Pick<UpdateState, 'reminderUntil' | 'isReminderDeferred'> {
    const reminder = this.reminderFor(version)
    return {
      reminderUntil: reminder?.until,
      isReminderDeferred: Boolean(reminder),
    }
  }

  private actionResponse(success: boolean, error?: UpdateError): UpdateActionResponse {
    return {
      success,
      state: this.getState(),
      ...(error ? { error } : {}),
    }
  }

  private handleFailure(
    mode: 'automatic' | 'manual',
    code: Extract<UpdateErrorCode, 'CHECK_FAILED' | 'DOWNLOAD_FAILED'>,
    automaticStatus: Extract<UpdateStatus, 'idle' | 'available'>,
  ): UpdateCheckResponse {
    const error: UpdateError = { code }
    if (mode === 'manual') {
      this.setState({ ...this.state, status: 'error', error })
      return this.response({ success: false, checked: true, error })
    }

    // 自动检查与后台下载的失败只留在主进程；不向渲染进程提供打扰性错误状态。
    this.setState({ ...this.state, status: automaticStatus, error: undefined })
    return this.response({ success: false, checked: true })
  }

  private bindUpdaterEvents(): void {
    this.options.updater.on?.('download-progress', (progress: unknown) => {
      const safeProgress = normalizeProgress(progress)
      if (!safeProgress) return
      this.setState({
        ...this.state,
        status: this.state.status === 'downloaded' ? 'downloaded' : 'downloading',
        downloadProgress: safeProgress,
      })
    })
  }

  private setState(next: UpdateState): void {
    this.state = next
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('[Vela Update] 状态监听器处理失败:', error)
      }
    }
  }

  private response(input: Pick<UpdateCheckResponse, 'success' | 'checked'> & Partial<Pick<UpdateCheckResponse, 'updateAvailable' | 'error'>>): UpdateCheckResponse {
    return {
      success: input.success,
      checked: input.checked,
      updateAvailable: input.updateAvailable ?? Boolean(this.state.availableVersion),
      state: this.getState(),
      ...(input.error ? { error: input.error } : {}),
    }
  }
}
