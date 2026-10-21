import { app, ipcMain, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, MODELS_CONFIG_PATH } from '../utils/config-utils'
import { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { EmbeddingOptions } from '../../src/shared/embedding-options'
import type { ImportRunExecutionAuthority } from '../../src/shared/import-run'
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
import { ImportRunRepository } from '../repositories/import-run-repository'
import { explainImportRunFailure, importRunLocale } from './import-run-failure'
import { FinalizationRepository } from '../repositories/finalization-repository'

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function invalidExternalGrantText(): string {
  return text('外部文件授权无效或已失效，请重新选择。', 'The external file grant is invalid or has expired. Please choose again.')
}

const MAX_SECURE_KNOWLEDGE_IMPORT_FILES = 16_384
const MAX_SECURE_KNOWLEDGE_IMPORT_DEPTH = 64
const MAX_REFERENCE_IMPORT_DISPLAY_CHARACTERS = 160

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
}

function referenceImportDisplayName(binding: { chapterNumber: number; title: string }): string {
  if (!Number.isSafeInteger(binding.chapterNumber) || binding.chapterNumber < 1) {
    throw new Error(text('参照章节展示名的章号无效', 'The reference chapter display name has an invalid chapter number.'))
  }
  const prefix = `第${binding.chapterNumber}章 `
  const suffix = '.txt'
  const titleBudget = MAX_REFERENCE_IMPORT_DISPLAY_CHARACTERS
    - Array.from(prefix).length
    - Array.from(suffix).length
  const safeTitle = Array.from(binding.title)
    .filter(character => !isControlCharacter(character))
    .join('')
    .trim() || '无标题'
  const boundedTitle = Array.from(safeTitle).slice(0, Math.max(0, titleBudget)).join('')
  return `${prefix}${boundedTitle}${suffix}`
}

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

/**
 * 参照导入的运行卡片原样显示 result.error（#474）。作者能照做的知识库错误码按导入运行的界面语言说明，
 * 与 src/i18n/messages 里同名码的文案一致；其余码原样留着供反馈定位。
 */
const INDEX_DAMAGED = [
  '当前作品的检索索引记录已损坏，现有资料没有改动。请从备份恢复作品，或清空知识库后重新导入资料。',
  'The search index records of this book are damaged. Your material was not changed. Restore the book from a backup, or clear the knowledge base and import the material again.',
] as const
const REFERENCE_IMPORT_FAILURES: Readonly<Record<string, readonly [zhCN: string, enUS: string]>> = {
  PROJECT_NOT_OPEN: ['请先打开项目。', 'Open a project first.'],
  KNOWLEDGE_BASE_TEXT_EMPTY: ['资料内容是空的，没有可导入的文字。', 'The material is empty; there is no text to import.'],
  EMBEDDING_RESPONSE_INVALID: [
    '检索模型返回的结果不合格（条数、维度或数值不对），本次没有写入。请检查检索模型的 Base URL，或换一个检索模型。',
    'The retrieval model returned an unusable result (wrong count, size, or values), so nothing was written. Check the retrieval model’s Base URL or choose another retrieval model.',
  ],
  EMBEDDING_SPACE_REINDEX_REQUIRED: [
    '当前检索模型与已建好的检索索引不一致。请先在设置的「检索模型」页检查并重建索引，再导入。',
    'The current retrieval model does not match the search index already built. Check and rebuild the index on the Retrieval model page in Settings, then import again.',
  ],
  EMBEDDING_SPACE_REGISTRY_INVALID: INDEX_DAMAGED,
  EMBEDDING_SPACE_UNREGISTERED_DATA: INDEX_DAMAGED,
  EMBEDDING_SPACE_BUSY: ['检索索引正在建立，请稍后再试。', 'The search index is being built. Try again in a moment.'],
}

/** 参照导入的幂等收据与完整性校验：没有作者能照做的建议，给按运行语言的说明并附上码供反馈定位。 */
function referenceIntegrityFailure(code: string): readonly [zhCN: string, enUS: string] | undefined {
  if (!code.startsWith('KNOWLEDGE_BASE_REFERENCE_')) return undefined
  return [
    `参照章节未能写入知识库（校验未通过：${code}）。`,
    `The reference chapter could not be written to the knowledge base (check failed: ${code}).`,
  ]
}

function explainReferenceImportFailure<T extends { success: boolean; error?: string }>(result: T, runId: string): T | (T & { errorCode: string }) {
  const code = !result.success ? result.error : undefined
  const explained = code ? REFERENCE_IMPORT_FAILURES[code] ?? referenceIntegrityFailure(code) : undefined
  if (!code) return result
  if (!explained) {
    // 导入运行的授权与收据校验（#474 B1）按同一套说明写。
    const importFailure = explainImportRunFailure(code, () => importRunLocale(runId))
    return importFailure ? { ...result, ...importFailure } : result
  }
  return { ...result, errorCode: code, error: importRunLocale(runId) === 'en-US' ? explained[1] : explained[0] }
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

export function getEmbeddingConfig(): { protocol: 'openai' | 'gemini'; model: { baseUrl: string; apiKey: string; modelName: string; embeddingOptions?: EmbeddingOptions } } | null {
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
      // Directory enumeration alone is not authority to read every discovered
      // file. Validate the separate read operation before the one-use list
      // capability is consumed and deleted.
      const readableFolder = externalFileGrants.revalidate({
        grantId,
        webContentsId: event.sender.id,
        operation: 'read',
      })
      externalFileGrants.resolve({
        grantId,
        webContentsId: event.sender.id,
        operation: 'list',
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

  ipcMain.handle('kb:import-planning-text', async (_event, text: string, fileName: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return knowledgeBaseLoader.run((kb) => kb.importText(
      text,
      fileName,
      projectPath,
      protocol,
      model,
      { mode: 'fts-only' },
    ))
  })

  ipcMain.handle('kb:import-reference-text', async (
    _event,
    chapterNumber: number,
    runId: string,
    executionAuthority: ImportRunExecutionAuthority,
  ) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) throw new Error(text('项目数据库未打开', 'The project database is not open.'))
    try {
      const binding = ImportRunRepository.resolveReferenceImportAuthority(runId, executionAuthority, chapterNumber)
      const fileName = referenceImportDisplayName(binding)
      const embConfig = getEmbeddingConfig()
      const protocol = embConfig?.protocol ?? 'openai'
      const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
      return await knowledgeBaseLoader.run(async (kb) => {
        const result = await kb.importReferenceText(
          binding.content,
          fileName,
          binding.stableKey,
          chapterNumber,
          runId,
          executionAuthority,
          projectPath,
          protocol,
          model,
        )
        if (result.success && result.docId) {
          ImportRunRepository.commitReferenceImportReceipt(
            runId, executionAuthority, chapterNumber, result.docId,
          )
        }
        return explainReferenceImportFailure(result, runId)
      })
    } catch (error) {
      // 运行卡片原样显示这条通道的报错：导入运行的授权与收据校验按导入运行的语言写成说明（#474 B1）。
      const importFailure = explainImportRunFailure(error, () => importRunLocale(runId))
      if (importFailure) return { success: false as const, ...importFailure }
      throw error
    }
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

  ipcMain.handle('kb:search-writing-context', async (_event, query: string, topK: number | undefined, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    const embConfig = getEmbeddingConfig()

    return knowledgeBaseLoader.run((kb) => {
      if (embConfig) {
        return kb.searchKnowledge(
          query,
          projectPath,
          embConfig.protocol,
          embConfig.model,
          topK ?? 5,
          undefined,
          ['reference'],
        )
      }
      return kb.searchKnowledgeFTS(query, projectPath, topK ?? 5, undefined, ['reference'])
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
    return knowledgeBaseLoader.run(async (kb) => {
      const documents = await kb.listDocuments(projectPath)
      const chapters = FinalizationRepository.knowledgeDocumentChapters()
      return documents.map(document => {
        const finalizedChapter = chapters.get(document.id)
        return finalizedChapter === undefined ? document : { ...document, finalizedChapter }
      })
    })
  })

  ipcMain.handle('kb:read-document-copy', async (_event, docId: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.readDocumentCopy(docId, projectPath))
  })

  ipcMain.handle('kb:save-document-copy', async (_event, docId: string, content: string,
    expectedContentHash: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.saveDocumentCopy(docId, content, expectedContentHash, projectPath))
  })

  ipcMain.handle('kb:reindex-document-copy', async (_event, docId: string, expectedProjectPath: string) => {
    const projectPath = requireProjectPath(expectedProjectPath)
    return knowledgeBaseLoader.run((kb) => kb.reindexDocumentCopy(docId, projectPath))
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
