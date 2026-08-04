/**
 * 可跨主进程、预加载与渲染进程传递的应用更新数据契约。
 *
 * 此文件不能依赖 Electron 或任何主进程服务，避免渲染进程类型定义反向依赖主进程实现。
 */
export interface UpdateReleaseInfo {
  version: string
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
}

export interface UpdateCheckResult {
  updateInfo?: UpdateReleaseInfo
}

export interface UpdatePreferences {
  /** 最近一次检查的时间，供界面显示。 */
  lastCheckedAt?: string
  /** 最近一次自动检查对应的本地日历日，限制为每天最多一次。 */
  lastAutomaticCheckDate?: string
  /** 已确认高于当前版本的正式更新；重启后只恢复“可继续准备”，不伪造已下载状态。 */
  availableUpdate?: UpdateReleaseInfo
  /** 仅延后当前版本的提示；不会永久忽略更新。 */
  reminder?: UpdateReminder
}

export interface UpdateReminder {
  version: string
  until: string
}

export type UpdateReminderDelay = 7 | 30

export type UpdateStatus = 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled'

export type UpdateErrorCode = 'UPDATES_DISABLED' | 'UPDATE_CONFIGURATION_MISSING' | 'CHECK_FAILED' | 'DOWNLOAD_FAILED' | 'INSTALL_NOT_READY' | 'INSTALL_FAILED' | 'REMINDER_NOT_AVAILABLE' | 'REMINDER_SAVE_FAILED' | 'INVALID_REMINDER_DELAY'

/** Which safe, user-facing update operation produced the error. */
export type UpdateErrorPhase = 'configuration' | 'check' | 'download' | 'install' | 'reminder'

/** Stable classifications; raw updater/network errors never cross the IPC boundary. */
export type UpdateErrorReason =
  | 'not-installed'
  | 'configuration-missing'
  | 'network'
  | 'proxy'
  | 'tls'
  | 'http-forbidden'
  | 'http-not-found'
  | 'http-rate-limited'
  | 'metadata-invalid'
  | 'asset-missing'
  | 'not-ready'
  | 'reminder-unavailable'
  | 'reminder-save-failed'
  | 'invalid-reminder-delay'
  | 'install-failed'
  | 'unknown'

/** Allowlisted diagnostics that are safe to retain and render without credentials or paths. */
export type SafeUpdateTechnicalDetails =
  | 'UPDATES_DISABLED'
  | 'UPDATE_CONFIGURATION_MISSING'
  | 'DNS_OR_OFFLINE'
  | 'PROXY_CONNECT_FAILED'
  | 'TLS_HANDSHAKE_FAILED'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'UPDATE_METADATA_INVALID'
  | 'UPDATE_ASSET_MISSING'
  | 'UPDATE_OPERATION_FAILED'
  | 'INSTALL_NOT_READY'
  | 'INSTALL_FAILED'
  | 'REMINDER_NOT_AVAILABLE'
  | 'REMINDER_SAVE_FAILED'
  | 'INVALID_REMINDER_DELAY'

export interface UpdateError {
  code: UpdateErrorCode
  phase: UpdateErrorPhase
  reason: UpdateErrorReason
  retryable: boolean
  safeTechnicalDetails: SafeUpdateTechnicalDetails
}

export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 只包含可安全发送至渲染进程的值，不携带 Error 或更新器对象。 */
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
  lastCheckedAt?: string
  reminderUntil?: string
  isReminderDeferred: boolean
  downloadProgress?: UpdateDownloadProgress
  error?: UpdateError
}

export interface UpdateCheckResponse {
  success: boolean
  checked: boolean
  updateAvailable: boolean
  state: UpdateState
  error?: UpdateError
}

export interface UpdateActionResponse {
  success: boolean
  state: UpdateState
  error?: UpdateError
}
