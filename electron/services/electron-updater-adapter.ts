import { createRequire } from 'node:module'

import type { UpdateBackend, UpdateCheckResult, UpdateReleaseInfo } from './update-service'

const nodeRequire = createRequire(import.meta.url)

interface NativeUpdateCheckResult {
  updateInfo?: unknown
}

/** 仅描述本项目实际使用的 electron-updater 表面，便于在单测中替换。 */
export interface ElectronUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<NativeUpdateCheckResult | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

function mapReleaseInfo(value: unknown): UpdateReleaseInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const info = value as Record<string, unknown>
  if (typeof info.version !== 'string') return undefined

  return {
    version: info.version,
    ...(typeof info.releaseName === 'string' ? { releaseName: info.releaseName } : {}),
    ...(typeof info.releaseNotes === 'string' ? { releaseNotes: info.releaseNotes } : {}),
    ...(typeof info.releaseDate === 'string' ? { releaseDate: info.releaseDate } : {}),
  }
}

/**
 * 配置 GitHub 正式版更新器。
 * 更新源由 Electron Builder 写入 app-update.yml；下载由 UpdateService 显式驱动，
 * 安装只允许由 `requestInstall` 调用。
 */
export function configureElectronUpdater(updater: ElectronUpdaterLike): UpdateBackend {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false

  return {
    async checkForUpdates(): Promise<UpdateCheckResult | null> {
      const result = await updater.checkForUpdates()
      const updateInfo = mapReleaseInfo(result?.updateInfo)
      return updateInfo ? { updateInfo } : null
    },
    downloadUpdate: () => updater.downloadUpdate(),
    quitAndInstall: () => updater.quitAndInstall(),
    on: (event, listener) => {
      updater.on(event, listener)
    },
  }
}

/**
 * 仅由已安装的 Electron 主进程调用。
 * electron-updater 保持为 package.json 中的真实运行时依赖；这里的 createRequire
 * 只是让纯服务单测不加载 Electron 运行时。
 */
export function createElectronUpdaterBackend(): UpdateBackend {
  const { autoUpdater } = nodeRequire('electron-updater') as { autoUpdater: ElectronUpdaterLike }
  return configureElectronUpdater(autoUpdater)
}
