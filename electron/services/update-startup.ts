import {
  UpdateService,
  type UpdateBackend,
  type UpdatePreferencesStore,
  type UpdateServiceOptions,
} from './update-service'

export interface UpdateStartupDependencies {
  updateRuntimeEnabled: boolean
  currentVersion: string
  createBackend(): UpdateBackend
  createPreferences(): UpdatePreferencesStore
  registerController(service: UpdateService): void
  reportFailure(operation: string, error: unknown): void
  createService?(options: UpdateServiceOptions): UpdateService
}

function createDisabledUpdateBackend(): UpdateBackend {
  return {
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => {},
  }
}

/**
 * 启动更新功能，但绝不让更新器成为应用启动的前置条件。
 *
 * Electron 的窗口已先创建；这里任何依赖加载、配置读取或自动检查失败都会降级为
 * 更新功能不可用，而不是中断作者继续使用本地工作区。
 */
export function startUpdateRuntime(dependencies: UpdateStartupDependencies): void {
  let updater = createDisabledUpdateBackend()
  let isPackagedRuntime = false

  if (dependencies.updateRuntimeEnabled) {
    try {
      updater = dependencies.createBackend()
      isPackagedRuntime = true
    } catch (error) {
      dependencies.reportFailure('初始化更新器', error)
    }
  }

  let service: UpdateService
  try {
    const options: UpdateServiceOptions = {
      updater,
      currentVersion: dependencies.currentVersion,
      isPackaged: isPackagedRuntime,
      preferences: dependencies.createPreferences(),
    }
    service = dependencies.createService?.(options) ?? new UpdateService(options)
    dependencies.registerController(service)
  } catch (error) {
    dependencies.reportFailure('初始化更新服务', error)
    return
  }

  if (!isPackagedRuntime) return

  void service.checkAutomatically().catch((error: unknown) => {
    dependencies.reportFailure('自动检查更新', error)
  })
}
