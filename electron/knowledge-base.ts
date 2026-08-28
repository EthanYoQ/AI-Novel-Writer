/**
 * Vela 知识库管理 — 主进程使用
 *
 * 管理文档导入、向量化和检索
 * 底层存储已从 vectors.json 迁移至 LanceDB（{projectPath}/.vela/lancedb/）
 *
 * 检索模式：
 * - 默认：BM25 全文检索（FTS），零配置即可用
 * - 增强：FTS + 向量近邻混合检索（需配置 Embedding 模型）
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chunkText, generateEmbeddings } from './embedding'
import { normalizeEmbeddingOptions, type EmbeddingOptions } from '../src/shared/embedding-options'
import { EmbeddingResponseValidationError } from './services/embedding-response-error'
import {
  LEGACY_VECTOR_MIGRATION_BLOCKED,
  LegacyVectorMigrationBlockedError,
} from './services/knowledge-base-migration-error'
import {
  addChunks,
  removeDocument as removeDocFromStore,
  clearAll as clearKnowledgeStore,
  searchWithScope as storeSearchWithScope,
  listDocuments as storeListDocuments,
  getStats as storeGetStats,
  resolveDocumentIdByExactContent as storeResolveDocumentIdByExactContent,
  migrateFromJSON,
  getChunksWithoutVectors as storeGetChunksWithoutVectors,
  getCanonicalChunksForEmbeddingRebuild,
  planEmbeddingRebuild,
  activatePlannedEmbeddingSpace,
  rebuildPlannedEmbeddingSpace,
  type EmbeddingSpaceIdentity,
} from './vector-store'

// ===== 迁移状态跟踪 =====

/** 已执行过迁移检查的项目路径集合 */
const migratedProjects = new Set<string>()
const migrationChecksInFlight = new Map<string, Promise<void>>()

export { LEGACY_VECTOR_MIGRATION_BLOCKED, LegacyVectorMigrationBlockedError }

/** 确保旧数据已迁移 */
async function ensureMigration(projectPath: string): Promise<void> {
  const key = path.resolve(projectPath)
  if (migratedProjects.has(key)) return
  const existing = migrationChecksInFlight.get(key)
  if (existing) return await existing

  const attempt = (async () => {
    const jsonPath = path.join(projectPath, '.vela', 'vectors.json')
    if (fs.existsSync(jsonPath)) {
      const result = await migrateFromJSON(projectPath)
      if (!result.success) {
        const error = result.error ?? '旧 vectors.json 无法安全迁移'
        console.warn('[Vela KB] 旧向量迁移已阻断知识库操作:', error)
        throw new LegacyVectorMigrationBlockedError(error)
      }
    }
    migratedProjects.add(key)
  })()
  migrationChecksInFlight.set(key, attempt)
  try {
    await attempt
  } finally {
    if (migrationChecksInFlight.get(key) === attempt) {
      migrationChecksInFlight.delete(key)
    }
  }
}

function migrationFailureDetails(error: unknown): { error: string; errorCode?: typeof LEGACY_VECTOR_MIGRATION_BLOCKED } {
  if (error instanceof LegacyVectorMigrationBlockedError) {
    return { error: error.message, errorCode: error.code }
  }
  // IPC callers display this value directly. Preserve an Error's user-facing
  // message rather than leaking the JavaScript-only "Error:" wrapper; unknown
  // throwables still have a deterministic fallback.
  return { error: error instanceof Error ? error.message : String(error) }
}

function embeddingSpaceFor(
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; modelName?: string },
): EmbeddingSpaceIdentity {
  // 只持久化可公开比较的模型身份，绝不写入 API key。
  return {
    modelFingerprint: `${protocol}|${model.baseUrl.trim().replace(/\/+$/, '')}|${model.modelName?.trim() || 'default'}`,
    distanceMetric: 'l2',
  }
}

// ===== 导出函数（保持旧签名，IPC 层零改动） =====

/**
 * 导入文档到知识库（单文件，从磁盘读取）
 * 始终建立 FTS 索引；有 Embedding 配置时额外生成向量
 */
export async function importDocument(
  filePath: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions },
  onProgress?: (progress: number, message: string) => void,
): Promise<{ success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: typeof LEGACY_VECTOR_MIGRATION_BLOCKED }> {
  try {
    await ensureMigration(projectPath)

    // 1. 读取文件
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).toLowerCase()
    if (!['.txt', '.md', '.markdown'].includes(ext)) {
      return { success: false, error: `不支持的文件类型: ${ext}，仅支持 .txt / .md` }
    }

    onProgress?.(5, `正在读取 ${fileName}...`)
    const content = fs.readFileSync(filePath, 'utf-8')
    if (!content.trim()) {
      return { success: false, error: '文件内容为空' }
    }

    // 2. 分块
    onProgress?.(10, '正在分块...')
    const embeddingOptions = normalizeEmbeddingOptions(model.embeddingOptions)
    const chunks = chunkText(content, embeddingOptions.chunkSize, embeddingOptions.chunkOverlap)
    const docId = randomUUID()

    // 3. 可选：生成向量（如果有 Embedding 配置）
    let vectors: number[][] | undefined
    if (model.apiKey) {
      try {
        onProgress?.(20, `正在向量化 ${chunks.length} 个块...`)
        vectors = await generateEmbeddings(chunks, protocol, model, model.embeddingOptions?.batchSize)
      } catch (e) {
        if (e instanceof EmbeddingResponseValidationError) throw e
        console.warn('[Vela KB] Embedding 调用失败，降级为 FTS-only:', e)
        // 不影响导入，仅 FTS
      }
    }

    // 4. 写入 LanceDB（text + 元数据 + 可选向量）
    onProgress?.(80, '正在保存...')
    const result = await addChunks(
      projectPath,
      docId,
      fileName,
      chunks,
      vectors,
      filePath,
      undefined,
      embeddingSpaceFor(protocol, model),
    )

    if (!result.success) {
      return { success: false, error: result.error }
    }

    onProgress?.(100, `✅ 已导入 ${fileName}（${chunks.length} 个块）`)
    return { success: true, docId, chunkCount: chunks.length }
  } catch (error) {
    return { success: false, ...migrationFailureDetails(error) }
  }
}

/**
 * 检索知识库
 * 有 Embedding 配置时 → 混合检索（FTS + 向量）
 * 无 Embedding 配置时 → 纯 FTS 检索
 */
export async function searchKnowledge(
  query: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions },
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<Array<{ text: string; score: number; fileName: string }>> {
  await ensureMigration(projectPath)

  // 可选：生成查询向量
  let queryVector: number[] | undefined
  if (model.apiKey && query.trim()) {
    try {
      const [vec] = await generateEmbeddings([query], protocol, model, model.embeddingOptions?.batchSize)
      if (vec && vec.length > 0) {
        queryVector = vec
      }
    } catch {
      // Embedding 不可用，降级为 FTS
    }
  }

  return storeSearchWithScope(
    projectPath,
    query,
    queryVector,
    topK,
    chapterScope,
    embeddingSpaceFor(protocol, model),
  )
}

/**
 * 列出已导入文档
 */
export function listDocuments(projectPath: string) {
  return ensureMigration(projectPath).then(() => storeListDocuments(projectPath))
}

export async function resolveFinalizedDocumentId(
  projectPath: string,
  fileName: string,
  content: string,
) {
  await ensureMigration(projectPath)
  return storeResolveDocumentIdByExactContent(projectPath, fileName, content)
}

/**
 * 删除文档
 */
export async function removeDocument(docId: string, projectPath: string): Promise<boolean> {
  await ensureMigration(projectPath)
  return removeDocFromStore(projectPath, docId)
}

/**
 * 清空项目知识库。
 */
export async function clearKnowledgeBase(projectPath: string): Promise<boolean> {
  await ensureMigration(projectPath)
  return clearKnowledgeStore(projectPath)
}

/**
 * 获取知识库统计
 */
export async function getKnowledgeStats(projectPath: string): Promise<{
  documentCount: number
  totalChunks: number
  vectorDimension: number
}> {
  await ensureMigration(projectPath)
  const stats = await storeGetStats(projectPath)
  return {
    documentCount: stats.documentCount,
    totalChunks: stats.totalChunks,
    vectorDimension: stats.vectorDimension,
  }
}

/**
 * 批量导入文件夹到知识库（递归扫描所有 .txt / .md 文件）
 */
export async function importFolder(
  folderPath: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions },
  onProgress?: (current: number, total: number, fileName: string) => void,
): Promise<{
  success: boolean
  importedCount: number
  failedFiles: string[]
  error?: string
  errorCode?: typeof LEGACY_VECTOR_MIGRATION_BLOCKED
}> {
  try {
    await ensureMigration(projectPath)
    // 递归收集所有 .txt / .md 文件。文件夹授权在入口处已完成一次
    // canonical 校验；这里仍要跳过 symlink/junction，避免递归期间逃逸。
    const rootPath = fs.realpathSync.native(folderPath)
    const isContainedInRoot = (candidate: string): boolean => {
      const relative = path.relative(rootPath, candidate)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    }
    const collectFiles = (dir: string): string[] => {
      const result: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          const canonicalChild = fs.realpathSync.native(fullPath)
          if (!isContainedInRoot(canonicalChild)) continue
          result.push(...collectFiles(canonicalChild))
        } else if (/\.(txt|md|markdown)$/i.test(entry.name)) {
          const canonicalFile = fs.realpathSync.native(fullPath)
          if (isContainedInRoot(canonicalFile) && fs.statSync(canonicalFile).isFile()) {
            result.push(canonicalFile)
          }
        }
      }
      return result
    }

    const files = collectFiles(folderPath)
    if (files.length === 0) return { success: true, importedCount: 0, failedFiles: [] }

    const failedFiles: string[] = []
    let importedCount = 0

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]
      const fileName = path.basename(filePath)
      onProgress?.(i + 1, files.length, fileName)

      const result = await importDocument(filePath, projectPath, protocol, model)
      if (result.success) {
        importedCount++
      } else {
        failedFiles.push(fileName)
      }
    }

    return { success: true, importedCount, failedFiles }
  } catch (error) {
    return { success: false, importedCount: 0, failedFiles: [], ...migrationFailureDetails(error) }
  }
}

/**
 * 直接将文本字符串内容导入知识库
 * 用于定稿后自动导入、按章推演等无文件场景
 */
/**
 * 从文件名解析章节元数据
 * 支持格式：第{N}章 {title} xxx.md
 */
function parseChapterMetaFromFileName(fileName: string): { chapterNumber?: number; chapterTitle?: string } | undefined {
  const match = fileName.match(/^第(\d+)章\s+(.+?)\s+(正文|要点|蓝图)\.md$/)
  if (match) {
    return {
      chapterNumber: parseInt(match[1]),
      chapterTitle: match[2],
    }
  }
  return undefined
}

export async function importText(
  text: string,
  fileName: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions },
): Promise<{ success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: typeof LEGACY_VECTOR_MIGRATION_BLOCKED }> {
  try {
    if (!text.trim()) return { success: false, error: '文本内容为空' }

    await ensureMigration(projectPath)

    // 分块
    const embeddingOptions = normalizeEmbeddingOptions(model.embeddingOptions)
    const chunks = chunkText(text, embeddingOptions.chunkSize, embeddingOptions.chunkOverlap)
    const docId = randomUUID()

    // 解析章节元数据（从文件名提取）
    const chapterMeta = parseChapterMetaFromFileName(fileName)

    // 可选：生成向量
    let vectors: number[][] | undefined
    if (model.apiKey) {
      try {
        vectors = await generateEmbeddings(chunks, protocol, model, model.embeddingOptions?.batchSize)
      } catch (e) {
        if (e instanceof EmbeddingResponseValidationError) throw e
        console.warn('[Vela KB] importText Embedding 失败，降级 FTS-only:', e)
      }
    }

    // 记录同名旧文档，但绝不能在 addChunks 的空间兼容性检查之前删除它。
    // 否则新模型返回 reindex_required 时会损坏仍可用的旧代际。
    const existingDocs = await storeListDocuments(projectPath)
    const existingDoc = existingDocs.find(d => d.fileName === fileName)

    const result = await addChunks(
      projectPath,
      docId,
      fileName,
      chunks,
      vectors,
      undefined,
      chapterMeta,
      embeddingSpaceFor(protocol, model),
    )
    if (!result.success) {
      return { success: false, error: result.error }
    }
    if (existingDoc) {
      await removeDocFromStore(projectPath, existingDoc.id)
    }

    return { success: true, docId, chunkCount: chunks.length }
  } catch (error) {
    return { success: false, ...migrationFailureDetails(error) }
  }
}

// ===== 向量回填相关 =====

/**
 * 获取缺少向量的块数量
 */
export async function getVectorlessCount(projectPath: string): Promise<{ count: number }> {
  await ensureMigration(projectPath)
  return storeGetChunksWithoutVectors(projectPath)
}

/**
 * 批量回填向量（为无向量的块生成 Embedding 并写回）
 * 单次全量加载→生成→写回，避免循环中的 schema 状态问题
 */
export async function backfillVectors(
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions },
): Promise<{
  success: boolean
  processed: number
  failed: number
  error?: string
  errorCode?: typeof LEGACY_VECTOR_MIGRATION_BLOCKED
}> {
  try {
    await ensureMigration(projectPath)
    if (!model.apiKey.trim() || !model.baseUrl.trim()) {
      return { success: false, processed: 0, failed: 0, error: '未配置 Embedding 模型' }
    }
    const space = embeddingSpaceFor(protocol, model)
    const canonical = await getCanonicalChunksForEmbeddingRebuild(projectPath)
    if (canonical.length === 0) {
      return { success: true, processed: 0, failed: 0 }
    }

    // Do not select a generation from fingerprint/metric alone.  A real
    // response for one canonical row establishes the only safe dimension for
    // this operation before any table or registry write may happen.
    const probeVectors = await generateEmbeddings(
      [canonical[0].text],
      protocol,
      model,
      model.embeddingOptions?.batchSize,
    )
    if (probeVectors.length !== 1) {
      return {
        success: false,
        processed: 0,
        failed: canonical.length,
        error: `Embedding 探测返回数量不匹配：期望 1，实际 ${probeVectors.length}`,
      }
    }
    const planned = await planEmbeddingRebuild(projectPath, space, probeVectors[0])
    if (!planned.success) {
      return { success: false, processed: 0, failed: canonical.length, error: planned.error }
    }

    const { plan } = planned
    if (plan.mode === 'up-to-date') {
      return { success: true, processed: 0, failed: 0 }
    }
    if (plan.mode === 'activate') {
      const activated = await activatePlannedEmbeddingSpace(projectPath, plan)
      return activated.success
        ? { success: true, processed: 0, failed: 0 }
        : { success: false, processed: 0, failed: 0, error: activated.error }
    }

    const vectorsById = new Map<string, number[]>()
    const probeTarget = plan.chunks.find(chunk => chunk.id === canonical[0].id)
    if (probeTarget) vectorsById.set(probeTarget.id, probeVectors[0])
    const remaining = plan.chunks.filter(chunk => !vectorsById.has(chunk.id))
    if (remaining.length > 0) {
      const vectors = await generateEmbeddings(
        remaining.map(chunk => chunk.text),
        protocol,
        model,
        model.embeddingOptions?.batchSize,
      )
      if (vectors.length !== remaining.length) {
        return {
          success: false,
          processed: 0,
          failed: plan.chunks.length,
          error: `Embedding 返回数量不匹配：期望 ${remaining.length}，实际 ${vectors.length}`,
        }
      }
      for (const [index, vector] of vectors.entries()) vectorsById.set(remaining[index].id, vector)
    }

    const result = await rebuildPlannedEmbeddingSpace(
      projectPath,
      plan,
      plan.chunks.map(chunk => ({ id: chunk.id, vector: vectorsById.get(chunk.id)! })),
    )
    if (!result.success) {
      return { success: false, processed: 0, failed: plan.chunks.length, error: result.error }
    }
    return {
      success: true,
      processed: result.count,
      failed: 0,
    }
  } catch (error) {
    console.error('[Vela KB] 向量回填异常:', error)
    return {
      success: false,
      processed: 0,
      failed: 0,
      ...migrationFailureDetails(error),
    }
  }
}

/**
 * FTS-only 检索（不需要 Embedding 配置）
 * 用于 IPC 层在无 Embedding 模型时直接调用
 */
export async function searchKnowledgeFTS(
  query: string,
  projectPath: string,
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<Array<{ text: string; score: number; fileName: string }>> {
  await ensureMigration(projectPath)
  return storeSearchWithScope(projectPath, query, undefined, topK, chapterScope)
}
