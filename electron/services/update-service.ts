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
  UpdateErrorPhase,
  UpdateErrorReason,
  UpdatePreferences,
  UpdateReleaseInfo,
  UpdateReminder,
  UpdateReminderDelay,
  UpdateState,
  UpdateStatus,
  SafeUpdateTechnicalDetails,
} from '../../src/shared/update-types'

export type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateError,
  UpdateErrorCode,
  UpdateErrorPhase,
  UpdateErrorReason,
  UpdatePreferences,
  UpdateReleaseInfo,
  UpdateReminder,
  UpdateReminderDelay,
  UpdateState,
  UpdateStatus,
  SafeUpdateTechnicalDetails,
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
  /** A packaged test/unpacked build may lack Electron Builder's app-update.yml. */
  updateConfiguration?: 'available' | 'missing'
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

function makeUpdateError(
  code: UpdateErrorCode,
  phase: UpdateErrorPhase,
  reason: UpdateErrorReason,
  retryable: boolean,
  safeTechnicalDetails: SafeUpdateTechnicalDetails,
): UpdateError {
  return { code, phase, reason, retryable, safeTechnicalDetails }
}

function updateConfigurationMissingError(): UpdateError {
  return makeUpdateError(
    'UPDATE_CONFIGURATION_MISSING',
    'configuration',
    'configuration-missing',
    false,
    'UPDATE_CONFIGURATION_MISSING',
  )
}

function updaterErrorHints(error: unknown): string {
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.name, error.message)
  } else if (typeof error === 'string') {
    parts.push(error)
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['code', 'name', 'message', 'status', 'statusCode']) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
    }
  }
  return parts.join(' ').toLowerCase()
}

function updaterHttpStatus(error: unknown, hints: string): number | undefined {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['status', 'statusCode']) {
      const value = record[key]
      if (typeof value === 'number' && Number.isInteger(value)) return value
      if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value)
    }
  }
  const match = /\b(?:http\s*)?(403|404|429)\b/.exec(hints)
  return match ? Number(match[1]) : undefined
}

/** Maps unsafe updater failures to a fixed, renderer-safe classification. */
function classifyUpdateFailure(phase: Extract<UpdateErrorPhase, 'check' | 'download'>, error: unknown): UpdateError {
  const hints = updaterErrorHints(error)
  const status = updaterHttpStatus(error, hints)
  const code: UpdateErrorCode = phase === 'download' ? 'DOWNLOAD_FAILED' : 'CHECK_FAILED'

  if (/app-update\.ya?ml|update(?:r)? configuration|updater config/.test(hints)) {
    return updateConfigurationMissingError()
  }
  if (phase === 'download' && (status === 404 || /(?:asset|installer|update file).*(?:missing|not found|404)/.test(hints))) {
    return makeUpdateError(code, phase, 'asset-missing', false, 'UPDATE_ASSET_MISSING')
  }
  if (/(?:invalid|malformed|parse).*(?:latest\.ya?ml|metadata|update)|(?:latest\.ya?ml|metadata).*(?:invalid|malformed|parse)/.test(hints)) {
    return makeUpdateError(code, phase, 'metadata-invalid', false, 'UPDATE_METADATA_INVALID')
  }
  if (status === 403) return makeUpdateError(code, phase, 'http-forbidden', false, 'HTTP_403')
  if (status === 404) return makeUpdateError(code, phase, 'http-not-found', false, 'HTTP_404')
  if (status === 429) return makeUpdateError(code, phase, 'http-rate-limited', true, 'HTTP_429')
  if (/proxy|tunnel/.test(hints)) return makeUpdateError(code, phase, 'proxy', true, 'PROXY_CONNECT_FAILED')
  if (/cert|tls|ssl|self signed|unable to verify/.test(hints)) return makeUpdateError(code, phase, 'tls', true, 'TLS_HANDSHAKE_FAILED')
  if (/enotfound|eai_again|enetunreach|econnrefused|econnreset|etimedout|enotconn|offline|network/.test(hints)) {
    return makeUpdateError(code, phase, 'network', true, 'DNS_OR_OFFLINE')
  }
  return makeUpdateError(code, phase, 'unknown', true, 'UPDATE_OPERATION_FAILED')
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
  private downloadedVersion?: string
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private checkQueue: Promise<void> = Promise.resolve()

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
    if (this.options.updateConfiguration === 'missing') {
      return this.handleFailure(
        'automatic',
        updateConfigurationMissingError(),
        this.state.availableVersion ? 'available' : 'idle',
        false,
      )
    }
    if (this.downloadedVersion) {
      return this.response({ success: true, checked: false, updateAvailable: true })
    }

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
    return this.enqueueCheck(() => this.performCheck('automatic', now))
  }

  async checkManually(): Promise<UpdateCheckResponse> {
    if (!this.options.isPackaged) return this.disabledResponse()
    if (this.options.updateConfiguration === 'missing') {
      return this.handleFailure(
        'manual',
        updateConfigurationMissingError(),
        this.state.availableVersion ? 'available' : 'idle',
        false,
      )
    }
    if (this.downloadedVersion) {
      return this.response({ success: true, checked: false, updateAvailable: true })
    }

    const now = this.now()
    const preferences = this.readPreferences() ?? {}
    this.writePreferences({
      ...preferences,
      lastCheckedAt: now.toISOString(),
    })
    return this.enqueueCheck(() => this.performCheck('manual', now))
  }

  private enqueueCheck(operation: () => Promise<UpdateCheckResponse>): Promise<UpdateCheckResponse> {
    const queued = this.checkQueue.then(operation, operation)
    this.checkQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async performCheck(mode: 'automatic' | 'manual', now: Date): Promise<UpdateCheckResponse> {
    // Re-check inside the serialized queue: an earlier queued check may have
    // completed the download after this operation passed its public guard.
    if (this.downloadedVersion) {
      return this.response({ success: true, checked: false, updateAvailable: true })
    }
    this.setState({
      ...this.state,
      status: 'checking',
      lastCheckedAt: now.toISOString(),
      error: undefined,
    })

    let result: UpdateCheckResult | null
    try {
      result = await this.options.updater.checkForUpdates()
    } catch (error) {
      return this.handleFailure(mode, classifyUpdateFailure('check', error), this.state.availableVersion ? 'available' : 'idle')
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
    } catch (error) {
      return this.handleFailure(mode, classifyUpdateFailure('download', error), 'available')
    }
    this.downloadedVersion = update.version
    this.setState({ ...this.state, status: 'downloaded' })
    return this.response({ success: true, checked: true, updateAvailable: true })
  }

  async deferReminder(days: UpdateReminderDelay): Promise<UpdateActionResponse> {
    if (!this.options.isPackaged) {
      return this.actionResponse(false, makeUpdateError('UPDATES_DISABLED', 'configuration', 'not-installed', false, 'UPDATES_DISABLED'))
    }
    if (days !== 7 && days !== 30) {
      return this.actionResponse(false, makeUpdateError('INVALID_REMINDER_DELAY', 'reminder', 'invalid-reminder-delay', false, 'INVALID_REMINDER_DELAY'))
    }
    if (!this.state.availableVersion) {
      return this.actionResponse(false, makeUpdateError('REMINDER_NOT_AVAILABLE', 'reminder', 'reminder-unavailable', false, 'REMINDER_NOT_AVAILABLE'))
    }

    const until = new Date(this.now().getTime() + days * 24 * 60 * 60 * 1000).toISOString()
    const reminder = { version: this.state.availableVersion, until }
    const preferences = this.readPreferences() ?? {}
    if (!this.writePreferences({ ...preferences, reminder })) {
      return this.actionResponse(false, makeUpdateError('REMINDER_SAVE_FAILED', 'reminder', 'reminder-save-failed', true, 'REMINDER_SAVE_FAILED'))
    }
    this.reminder = reminder
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
      return this.actionResponse(false, makeUpdateError('UPDATES_DISABLED', 'configuration', 'not-installed', false, 'UPDATES_DISABLED'))
    }
    if (
      !this.downloadedVersion
      || this.state.availableVersion !== this.downloadedVersion
    ) {
      return this.actionResponse(false, makeUpdateError('INSTALL_NOT_READY', 'install', 'not-ready', true, 'INSTALL_NOT_READY'))
    }

    try {
      this.options.updater.quitAndInstall()
      return this.actionResponse(true)
    } catch {
      return this.actionResponse(false, makeUpdateError('INSTALL_FAILED', 'install', 'install-failed', true, 'INSTALL_FAILED'))
    }
  }

  private disabledResponse(): UpdateCheckResponse {
    this.setState({ ...this.state, status: 'disabled' })
    return this.response({
      success: false,
      checked: false,
      error: makeUpdateError('UPDATES_DISABLED', 'configuration', 'not-installed', false, 'UPDATES_DISABLED'),
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
    error: UpdateError,
    automaticStatus: Extract<UpdateStatus, 'idle' | 'available'>,
    checked = true,
  ): UpdateCheckResponse {
    if (mode === 'manual') {
      this.setState({ ...this.state, status: 'error', error })
      return this.response({ success: false, checked, error })
    }

    // 自动检查与后台下载的失败只留在主进程；不向渲染进程提供打扰性错误状态。
    this.setState({ ...this.state, status: automaticStatus, error: undefined })
    return this.response({ success: false, checked })
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
