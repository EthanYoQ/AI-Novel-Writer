import { app, ipcMain, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, MODELS_CONFIG_PATH } from '../utils/config-utils'
import { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { EmbeddingOptions } from '../../src/shared/embedding-options'
import { knowledgeBaseLoader } from '../services/knowledge-base-loader'
import { mainText } from '../i18n'
import { getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'
import { externalFileGrants } from '../services/external-file-grant-service'
import {
  windowsSafeFileSystem,
  type SecureFileCapability,
  type WindowsSafeFileSystem,
} from '../security/windows-safe-file-system'
import { childFileCapability } from '../security/file-capability'
import {
  LEGACY_VECTOR_MIGRATION_BLOCKED,
  LegacyVectorMigrationBlockedError,
} from '../services/knowledge-base-migration-error'
import {
  assertKnowledgeBaseStoragePathSupported,
  projectStoragePreflightFailure,
} from '../services/project-storage-preflight'

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function invalidExternalGrantText(): string {
  return text('外部文件授权无效或已失效，请重新选择。', 'The external file grant is invalid or has expired. Please choose again.')
}

const MAX_SECURE_KNOWLEDGE_IMPORT_FILES = 16_384
const MAX_SECURE_KNOWLEDGE_IMPORT_DEPTH = 64

async function readGrantedKnowledgeFolder(
  fileSystem: WindowsSafeFileSystem,
  root: SecureFileCapability,
): Promise<Array<{ fileName: string; content: string }>> {
  const imported: Array<{ fileName: string; content: string }> = []
  const visit = async (directory: SecureFileCapability, depth: number): Promise<void> => {
    if (depth > MAX_SECURE_KNOWLEDGE_IMPORT_DEPTH) {
      throw new Error('SECURE_FS_DIRECTORY_TOO_DEEP')
    }
    const entries = await fileSystem.listDirectory(directory)
    for (const entry of entries) {
      const child = childFileCapability(directory, entry.name)
      if (entry.isDirectory) {
        await visit(child, depth + 1)
        continue
      }
      if (!/\.(txt|md|markdown)$/i.test(entry.name)) continue
      if (imported.length >= MAX_SECURE_KNOWLEDGE_IMPORT_FILES) {
        throw new Error('SECURE_FS_DIRECTORY_TOO_LARGE')
      }
      imported.push({
        fileName: path.basename(entry.name),
        content: await fileSystem.readText(child),
      })
    }
  }
  await visit(root, 0)
  return imported
}

function legacyMigrationBlockedFailure() {
  return {
    success: false as const,
    errorCode: LEGACY_VECTOR_MIGRATION_BLOCKED,
    error: text(
      '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
      'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.',
    ),
  }
}

function isLegacyMigrationBlockedError(error: unknown): boolean {
  return error instanceof LegacyVectorMigrationBlockedError
    || (!!error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === LEGACY_VECTOR_MIGRATION_BLOCKED)
}

function isLegacyMigrationBlockedResult(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && 'success' in value
    && (value as { success?: unknown }).success === false
    && 'errorCode' in value
    && (value as { errorCode?: unknown }).errorCode === LEGACY_VECTOR_MIGRATION_BLOCKED
}

function getEmbeddingConfig(): { protocol: 'openai' | 'gemini'; model: { baseUrl: string; apiKey: string; modelName: string; embeddingOptions?: EmbeddingOptions } } | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const targetModelId = config.defaultEmbeddingModelId || config.defaultModelId
  if (!targetModelId) return null

  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  const model = models.find((m) => m.id === targetModelId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName, embeddingOptions: model.embeddingOptions },
  }
}

function hasUsableEmbeddingConfig(
  config: ReturnType<typeof getEmbeddingConfig>,
): config is NonNullable<ReturnType<typeof getEmbeddingConfig>> {
  return !!config && !!config.model.baseUrl.trim() && !!config.model.apiKey.trim()
}

function requireProjectPath(expectedProjectPath: string): string {
  assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
  return expectedProjectPath
}

type KnowledgeBaseHandler<Args extends unknown[] = unknown[]> = (
  event: IpcMainInvokeEvent,
  ...args: Args
) => unknown

const KNOWLEDGE_BASE_GRANT_TTL_MS = 10 * 60 * 1000

function registerKnowledgeBaseHandler<Args extends unknown[]>(
  channel: string,
  handler: KnowledgeBaseHandler<Args>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!channel.startsWith('kb:')) return handler(event, ...(args as Args))
    const candidate = args.at(-1)
    const context = isProjectSessionContext(candidate) ? candidate : undefined
    if (context) args.pop()
    const projectSession = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
    try {
      assertKnowledgeBaseStoragePathSupported(projectSession.rootPath)
      const result = await handler(event, ...(args as Args))
      return isLegacyMigrationBlockedResult(result) ? legacyMigrationBlockedFailure() : result
    } catch (error) {
      if (isLegacyMigrationBlockedError(error)) return legacyMigrationBlockedFailure()
      const storageFailure = projectStoragePreflightFailure(error)
      if (storageFailure) return storageFailure
      throw error
    }
  })
}

export function registerKBController(
  fileSystem: WindowsSafeFileSystem = windowsSafeFileSystem,
) {
  // 所有 kb:* 操作需携带同一冻结会话；选择文件/目录仍是外部授权能力。
  const ipcMain = { handle: registerKnowledgeBaseHandler }
  ipcMain.handle('kb:import-document', async (event, grantId: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    let importedFile: { fileName: string; content: string }
    try {
      const file = externalFileGrants.resolve({
        grantId,
        webContentsId: event.sender.id,
        operation: 'read',
      })
      importedFile = {
        fileName: path.basename(file.relativePath),
        content: await fileSystem.readText(file),
      }
    } catch {
      return { success: false, error: invalidExternalGrantText() }
    }
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return knowledgeBaseLoader.run((kb) => kb.importText(
      importedFile.content,
      importedFile.fileName,
      projectPath,
      protocol,
      model,
    ))
  })

  ipcMain.handle('kb:import-folder', async (event, grantId: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    let importedFiles: Array<{ fileName: string; content: string }>
    try {
      externalFileGrants.resolve({
        grantId,
        webContentsId: event.sender.id,
        operation: 'list',
      })
      // Directory enumeration alone is not authority to read every discovered
      // file. Revalidate the separate read operation without consuming another
      // renderer use before handing root-relative children to the helper.
      const readableFolder = externalFileGrants.revalidate({
        grantId,
        webContentsId: event.sender.id,
        operation: 'read',
      })
      importedFiles = await readGrantedKnowledgeFolder(fileSystem, readableFolder)
    } catch {
      return { success: false, importedCount: 0, failedFiles: [], error: invalidExternalGrantText() }
    }
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return knowledgeBaseLoader.run(async (kb) => {
      const failedFiles: string[] = []
      let importedCount = 0
      for (const importedFile of importedFiles) {
        const result = await kb.importText(
          importedFile.content,
          importedFile.fileName,
          projectPath,
          protocol,
          model,
        )
        if (result.success) {
          importedCount++
        } else {
          failedFiles.push(importedFile.fileName)
        }
      }
      return { success: true, importedCount, failedFiles }
    })
  })

  ipcMain.handle('kb:import-text', async (_event, text: string, fileName: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return knowledgeBaseLoader.run((kb) => kb.importText(text, fileName, projectPath, protocol, model))
  })

  ipcMain.handle('kb:import-reference-text', async (
    _event,
    text: string,
    fileName: string,
    idempotencyKey: string,
    expectedProjectPath: string,
  ) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return knowledgeBaseLoader.run((kb) => kb.importReferenceText(
      text,
      fileName,
      idempotencyKey,
      projectPath,
      protocol,
      model,
    ))
  })

  ipcMain.handle('kb:search', async (_event, query: string, topK: number | undefined, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()

    return knowledgeBaseLoader.run((kb) => {
      if (embConfig) {
        return kb.searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5)
      }
      return kb.searchKnowledgeFTS(query, projectPath, topK ?? 5)
    })
  })

  ipcMain.handle('kb:search-with-scope', async (_event, query: string, fromChapter: number, toChapter: number, topK: number | undefined, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()

    const scope: [number, number] = [fromChapter, toChapter]
    return knowledgeBaseLoader.run((kb) => {
      if (embConfig) {
        return kb.searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5, scope)
      }
      return kb.searchKnowledgeFTS(query, projectPath, topK ?? 5, scope)
    })
  })

  ipcMain.handle('kb:list-documents', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.listDocuments(projectPath))
  })

  ipcMain.handle('kb:remove-document', async (_event, docId: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run(async (kb) => {
      try {
        const success = await kb.removeDocument(docId, projectPath)
        return success
          ? { success: true }
          : { success: false, error: text('删除知识库文档失败', 'Could not remove the knowledge-base document') }
      } catch (error) {
        // Preserve the controller-wide migration barrier and convert every
        // ordinary async deletion rejection into a stable public IPC result.
        if (isLegacyMigrationBlockedError(error)) throw error
        return { success: false, error: text('删除知识库文档失败', 'Could not remove the knowledge-base document') }
      }
    })
  })

  ipcMain.handle('kb:clear-all', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run(async (kb) => {
      const success = await kb.clearKnowledgeBase(projectPath)
      return success ? { success: true } : { success: false, error: text('清空知识库失败', 'Could not clear the knowledge base') }
    })
  })

  ipcMain.handle('kb:stats', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.getKnowledgeStats(projectPath))
  })

  ipcMain.handle('kb:get-vectorless-count', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.getVectorlessCount(projectPath))
  })

  ipcMain.handle('kb:get-vector-rebuild-status', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()
    // Do not cause a provider request, or even offer the action, until the
    // user has configured a usable embedding model.
    if (!hasUsableEmbeddingConfig(embConfig)) {
      return {
        embeddingConfigured: false,
        canRebuild: false,
        totalChunks: 0,
        vectorlessCount: 0,
        activeVectorDimension: 0,
      }
    }
    return knowledgeBaseLoader.run(async (kb) => {
      const [stats, vectorless] = await Promise.all([
        kb.getKnowledgeStats(projectPath),
        kb.getVectorlessCount(projectPath),
      ])
      return {
        embeddingConfigured: true,
        canRebuild: stats.totalChunks > 0,
        totalChunks: stats.totalChunks,
        vectorlessCount: vectorless.count,
        activeVectorDimension: stats.vectorDimension,
      }
    })
  })

  ipcMain.handle('kb:backfill-vectors', async (_event, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()
    if (!hasUsableEmbeddingConfig(embConfig)) return { success: false, processed: 0, failed: 0, errorCode: 'EMBEDDING_MODEL_NOT_CONFIGURED', error: text('未配置 Embedding 模型', 'No embedding model is configured') }
    return knowledgeBaseLoader.run((kb) => kb.backfillVectors(projectPath, embConfig.protocol, embConfig.model))
  })

  ipcMain.handle('dialog:select-knowledge-files', async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: text('选择要导入的文档', 'Choose documents to import'),
      filters: [{ name: text('文本文件', 'Text files'), extensions: ['txt', 'md', 'markdown'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths.map((filePath) => {
      const grant = externalFileGrants.issueFile({
        webContentsId: event.sender.id,
        filePath,
        operations: ['read'],
        ttlMs: KNOWLEDGE_BASE_GRANT_TTL_MS,
        maxUses: 1,
      })
      event.sender.once('destroyed', () => externalFileGrants.revoke(grant.grantId))
      return { grantId: grant.grantId, displayName: filePath.split(/[\\/]/).pop() || filePath }
    })
  })

  ipcMain.handle('dialog:select-knowledge-folder', async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: text('选择要批量导入的文件夹', 'Choose a folder to import'),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]
    const grant = externalFileGrants.issueDirectory({
      webContentsId: event.sender.id,
      directoryPath: folderPath,
      operations: ['list', 'read'],
      ttlMs: KNOWLEDGE_BASE_GRANT_TTL_MS,
      maxUses: 1,
    })
    event.sender.once('destroyed', () => externalFileGrants.revoke(grant.grantId))
    return { grantId: grant.grantId, displayName: folderPath.split(/[\\/]/).pop() || folderPath }
  })
}
