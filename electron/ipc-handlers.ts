import { assertGlobalDataReady, getGlobalDataGeneration } from './services/app-data-locator'
import { getCurrentProjectPath, getProjectDb } from './database'

import { registerConfigController } from './controllers/config-controller'
import { registerProjectController } from './controllers/project-controller'
import { registerProjectArchiveController } from './controllers/project-archive-controller'
import { registerCloudBackupController } from './controllers/cloud-backup-controller'
import { registerFSController } from './controllers/fs-controller'
import { registerLLMController } from './controllers/llm-controller'
import { registerGenerationController } from './controllers/generation-controller'
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
import { registerCharacterAvatarController } from './controllers/character-avatar-controller'
import { skinService } from './services/skin-service'
import { CharacterAssetService } from './services/character-asset-service'
import { projectAccess } from './services/project-access'
import { getProjectDataRoot } from './services/project-data-locator'
import { CloudProjectBindingStore } from './services/cloud-project-binding-store'

/**
 * 注册所有 IPC 通道 — 在主进程启动时调用
 * (采用多控制器路由模式，解耦各个模块的庞大逻辑)
 */
export function registerIPCHandlers() {
  assertGlobalDataReady()
  skinService.getStartupSnapshot(getGlobalDataGeneration())
  registerSkinController()

  // 挂载控制器路由
  registerWindowController()
  registerOfficialHomepageController()
  registerModelProviderResourceController()
  registerConfigController()
  registerAppDataController()
  const cloudProjectBindings = new CloudProjectBindingStore()
  registerProjectController({
    removeDeletedProjectBinding: projectId => { cloudProjectBindings.removeDeletedProject(projectId) },
  })
  registerProjectArchiveController()
  registerCloudBackupController()
  registerFSController()
  registerExternalFileGrantController()
  registerGenerationController(registerLLMController())
  registerDatabaseController()
  registerCharacterAvatarController({
    resolveService(_event, context) {
      let active
      try {
        active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      } catch { return null }
      const database = getProjectDb()
      if (!database) return null
      const service = new CharacterAssetService({ projectId: context.projectId, sessionLease: context.leaseId,
        storageRoot: getProjectDataRoot(active.rootPath), database })
      service.recordReclaimableOrphans()
      return service
    },
  })
  registerFinalizationController()
  registerChapterLifecycleController()
  registerKBController()
  registerImportController()

  console.log('[AI Novel IPC] 所有 Controller 已注册完成')
}
