import { ensureVelaHome, VELA_HOME } from './utils/config-utils'

import { registerConfigController } from './controllers/config-controller'
import { registerProjectController } from './controllers/project-controller'
import { registerFSController } from './controllers/fs-controller'
import { registerLLMController } from './controllers/llm-controller'
import { registerDatabaseController } from './controllers/db-controller'
import { registerKBController } from './controllers/kb-controller'
import { registerImportController } from './controllers/import-controller'
import { registerWindowController } from './controllers/window-controller'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import { registerModelProviderResourceController } from './controllers/model-provider-resource-controller'
import { registerFinalizationController } from './controllers/finalization-controller'
import { registerChapterLifecycleController } from './controllers/chapter-lifecycle-controller'
import { registerExternalFileGrantController } from './controllers/external-file-grant-controller'
import { registerAppDataController } from './controllers/app-data-controller'
import { registerSkinController } from './controllers/skin-controller'
import { skinService } from './services/skin-service'

/**
 * 注册所有 IPC 通道 — 在主进程启动时调用
 * (采用多控制器路由模式，解耦各个模块的庞大逻辑)
 */
export function registerIPCHandlers() {
  // 确保全局配置目录结构存在
  ensureVelaHome()

  // 皮肤存储损坏或不可用时必须降级为经典皮肤，不能阻断其余 IPC 注册。
  try {
    skinService.initialize()
  } catch (error) {
    console.warn('[Vela Skin] 皮肤服务初始化失败，已降级并继续启动应用。', error)
  }
  registerSkinController()

  // 挂载控制器路由
  registerWindowController()
  registerOfficialHomepageController()
  registerModelProviderResourceController()
  registerConfigController()
  registerAppDataController()
  registerProjectController()
  registerFSController()
  registerExternalFileGrantController()
  registerLLMController()
  registerDatabaseController()
  registerFinalizationController()
  registerChapterLifecycleController()
  registerKBController()
  registerImportController()

  console.log(`[Vela IPC] 所有 Controller 已注册完成 | 全局工作区: ${VELA_HOME}`)
}
