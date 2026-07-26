/**
 * IPC 频道定义 — 渲染进程与主进程的类型安全通信契约
 * 所有 IPC 调用都通过此文件定义频道名和参数/返回值类型
 */
import type { Locale } from '../i18n/types'
import type { EmbeddingOptions } from './embedding-options'
import type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdatePreferences,
  UpdateReminderDelay,
  UpdateState,
} from './update-types'

// ===== 全局配置 =====
export interface ConfigChannels {
  'config:get': {
    args: []
    return: GlobalConfig
  }
  'config:set': {
    args: [config: Partial<GlobalConfig>]
    return: { success: boolean; error?: string }
  }
}

// ===== 应用更新 =====
export interface UpdateChannels {
  'update:get-state': {
    args: []
    return: UpdateState
  }
  'update:check': {
    args: []
    return: UpdateCheckResponse
  }
  'update:defer-reminder': {
    args: [days: UpdateReminderDelay]
    return: UpdateActionResponse
  }
  'update:quit-and-install': {
    args: []
    return: UpdateActionResponse
  }
}

export interface UpdateStateEvents {
  'update:state': UpdateState
}

// ===== 窗口控制 =====
export interface WindowChannels {
  'window:minimize': {
    args: []
    return: { success: boolean }
  }
  'window:toggle-maximize': {
    args: []
    return: { success: boolean; maximized?: boolean }
  }
  'window:close': {
    args: []
    return: { success: boolean }
  }
}

// ===== 固定官方主页 =====
export interface OfficialHomepageChannels {
  'official-homepage:open': {
    args: []
    return: { success: boolean; error?: string }
  }
}

export interface GlobalConfig {
  theme: string
  locale?: Locale
  defaultModelId: string | null
  defaultEmbeddingModelId?: string | null
  /** 定稿与后处理成功后，打开下一章的创作窗口（默认关闭）。 */
  autoOpenNextChapterAfterFinalize?: boolean
  editorFontSize: number
  editorFontFamily: string
  autoSaveInterval: number
  /** 更新检查和提醒延后的本机偏好，持久化到 ~/.vela/config.json。 */
  updatePreferences?: UpdatePreferences
  proxy?: {
    enabled: boolean
    type: 'http' | 'socks5'
    host: string
    port: number
  }
}

export type AppErrorCode =
  | 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
  | 'LEGACY_VECTOR_MIGRATION_BLOCKED'
  | 'PROJECT_NOT_OPEN'
  | 'EMBEDDING_MODEL_NOT_CONFIGURED'

export interface AppFailure {
  success: false
  errorCode: AppErrorCode
  error?: string
}

export type AppResult<T> = T | AppFailure

/**
 * 一次打开项目时由主进程签发并冻结的跨进程会话身份。
 * projectPath 仅用于主进程的规范根目录校验，不能单独授予访问权限。
 */
export interface ProjectSessionContext {
  projectId: string
  leaseId: string
  projectPath: string
}

// ===== 项目管理 =====
export interface ProjectChannels {
  'project:get-runtime-context': {
    args: []
    return: {
      activeProjectPath: string | null
      dbReady: boolean
    }
  }
  'project:create': {
    args: [
      config: { name: string; path: string; genre: string; targetAudience: string },
      requestToken: string,
      rendererProjectPath: string | null,
    ]
    return: {
      success: boolean
      projectId: string
      projectPath?: string
      requestToken: string
      activeProjectPath: string | null
      databaseRestored: boolean
      dbReady: boolean
      stale?: boolean
      error?: string
    }
  }
  'project:open': {
    args: [projectPath: string, requestToken: string, rendererProjectPath: string | null]
    return: {
      success: boolean
      project: ProjectData | null
      requestToken: string
      activeProjectPath: string | null
      databaseRestored: boolean
      dbReady: boolean
      stale?: boolean
      error?: string
    }
  }
  'project:save': {
    args: [projectId: string, data: Partial<ProjectData>, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'project:update-config': {
    args: [projectId: string, data: Partial<ProjectData>, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'project:recent-list': {
    args: []
    return: Array<{ name: string; path: string; updatedAt: string }>
  }
  'project:delete': {
    args: [projectPath: string, projectId: string, sessionLease: string]
    return: {
      success: boolean
      directoryDeleted: boolean
      databaseRestored: boolean
      error?: string
      warning?: string
    }
  }
  'project:smoke-open-request': {
    args: []
    return: { projectPath: string; markerPath: string } | null
  }
  'project:smoke-open-confirm': {
    args: [projectPath: string]
    return: { success: boolean; error?: string }
  }
  'dialog:select-folder': {
    args: []
    return: string | null
  }
}

// ===== 文件系统 =====
export interface FileChannels {
  'fs:read-file': {
    args: [filePath: string, expectedProjectPath: string]
    return: { success: boolean; content: string; error?: string }
  }
  'fs:write-file': {
    args: [filePath: string, content: string, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'fs:list-dir': {
    args: [dirPath: string, expectedProjectPath: string]
    return: FileNode[]
  }
  'fs:mkdir': {
    args: [dirPath: string, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'fs:check-exists': {
    args: [filePath: string, expectedProjectPath: string]
    return: boolean
  }
  'fs:read-json': {
    args: [filePath: string, expectedProjectPath: string]
    return: { success: boolean; data: unknown; error?: string }
  }
  'fs:write-json': {
    args: [filePath: string, data: unknown, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  /** 用户选择后签发的授权；渲染进程仅能携带 grantId 与受限相对路径。 */
  'fs:grant-read-file': {
    args: [grantId: string, relativePath?: string]
    return: { success: boolean; content: string; error?: string }
  }
  'fs:grant-write-file': {
    args: [grantId: string, relativePath: string, content: string]
    return: { success: boolean; error?: string }
  }
  'fs:grant-mkdir': {
    args: [grantId: string, relativePath: string]
    return: { success: boolean; error?: string }
  }
  'dialog:select-export-directory': {
    args: []
    return: ExternalDirectoryGrant | null
  }
}

// ===== LLM 调用 =====
export interface LLMChannels {
  'llm:generate': {
    args: [request: LLMRequest]
    return: LLMResponse
  }
  'llm:generate-stream': {
    args: [requestId: string, request: LLMRequest]
    return: { requestId: string; started: boolean }
  }
  'llm:cancel': {
    args: [requestId: string]
    return: { success: boolean }
  }
  'llm:list-models': {
    args: []
    return: ModelProfile[]
  }
  'llm:save-model': {
    args: [model: ModelProfile]
    return: { success: boolean }
  }
  'llm:delete-model': {
    args: [modelId: string]
    return: {
      success: boolean
      error?: string
      defaultModelId?: string | null
      defaultEmbeddingModelId?: string | null
    }
  }
  'llm:set-default-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-model': {
    args: []
    return: string | null
  }
  'llm:set-default-embedding-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-embedding-model': {
    args: []
    return: string | null
  }
  'llm:test-connection': {
    args: [model: ModelProfile]
    return: { success: boolean; error?: string }
  }
}

export interface LLMStreamEvents {
  'llm:stream-chunk': { requestId: string; chunk: string }
  'llm:stream-done': {
    requestId: string
    fullText: string
    usage?: TokenUsage
    /** Provider-normalized completion state. Missing values from older peers are treated as `stop`. */
    finishReason?: LLMFinishReason
  }
  'llm:stream-error': { requestId: string; error: string }
}

// ===== 公共数据类型 =====
export interface ProjectData {
  id: string
  name: string
  path: string
  /** 主进程签发；仅与 id 组合为会话凭据，path 不是授权。 */
  sessionLease?: string
  novelConfig: NovelConfig
  characterStates: string
  createdAt: string
  updatedAt: string
}

export interface NovelConfig {
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  plotStructure: 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform'
  narrativePOV: 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov'
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  writingStyle?: string
  referenceWorks?: string
}

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

/** 只携带用户可展示名称和不透明能力标识；不暴露外部绝对路径。 */
export interface ExternalFileGrant {
  grantId: string
  displayName: string
}

export type ExternalDirectoryGrant = ExternalFileGrant

/** 固定 app-data 服务使用的提示词数据；文件位置不由渲染进程决定。 */
export interface AppPromptTemplate {
  key: string
  [key: string]: unknown
}

export interface AppDataChannels {
  'prompt:load-global': { args: []; return: AppPromptTemplate[] }
  'prompt:save-global': { args: [template: AppPromptTemplate]; return: { success: boolean; error?: string } }
  'prompt:delete-global': { args: [key: string]; return: { success: boolean; error?: string } }
  'skills:list-user': {
    args: []
    return: Array<{ name: string; content: string; baseDir: string; filePath: string }>
  }
}

export interface LLMRequest {
  modelId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
  stream?: boolean
  responseFormat?: { type: 'json_object' | 'text' }
  thinking?: boolean
}

export interface LLMResponse {
  success: boolean
  content: string
  usage?: TokenUsage
  error?: string
  /** Structured end state, including incomplete but inspectable partial text. */
  finishReason?: LLMFinishReason
}

/**
 * Provider-neutral end state for generated text. `stop` is the only state
 * that downstream workflows and the Agent may treat as a complete response.
 */
export type LLMFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'cancelled'
  | 'error'
  | 'unknown'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ModelProfile {
  id: string
  name: string
  provider: 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'bigmodel' | 'novelai' | 'custom'
  protocol: 'openai' | 'gemini'
  modelName: string
  apiKey: string
  baseUrl: string
  temperature: number
  maxTokens: number
  purposes: Array<'generation' | 'refinement' | 'summary' | 'embedding'>
  /** 仅用于 Embedding 模型；旧配置省略时沿用原有默认行为。 */
  embeddingOptions?: EmbeddingOptions
}

export interface ProjectClearOptions {
  creativeFields?: boolean
  blueprints?: boolean
  generatedText?: boolean
}

export type ProjectClearScope = 'creativeFields' | 'blueprints' | 'generatedText'

// ===== 引入 DB 类型 =====
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'
import type { BlueprintData } from '../../electron/repositories/blueprint-repository'
import type {
  CharacterData,
  CharacterRenameData,
  CharacterStateData,
} from '../../electron/repositories/character-repository'
import type { DraftMeta, DraftFull } from '../../electron/repositories/draft-repository'
import type { RevisionMeta, RevisionFull } from '../../electron/repositories/revision-repository'
import type { ReviewMeta, ReviewFull } from '../../electron/repositories/review-repository'
import type { PostProcessRunData, PostProcessStepData } from '../../electron/repositories/post-process-repository'

// ===== 数据库操作 =====
export interface DatabaseChannels {
  'db:close': { args: [expectedProjectPath: string]; return: { success: boolean } }

  // 1. project_core
  'db:project-core-get': {
    args: [expectedProjectPath: string]
    return: ProjectCoreData | null
  }
  'db:project-core-update': {
    args: [data: Partial<ProjectCoreData>, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:project-clear-generated-data': { args: [options: ProjectClearOptions, expectedProjectPath: string]; return: { success: boolean; cleared?: ProjectClearScope[]; physicalFilesDeleted?: number; error?: string } }

  // 2. blueprints
  'db:blueprint-get-all': { args: [expectedProjectPath: string]; return: BlueprintData[] }
  'db:blueprint-get': { args: [chapterNumber: number, expectedProjectPath: string]; return: BlueprintData | null }
  'db:blueprint-upsert': { args: [data: BlueprintData, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-upsert-many': { args: [items: BlueprintData[], expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-update-notes': { args: [chapterNumber: number, notes: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-delete': { args: [chapterNumber: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-clear-all': { args: [expectedProjectPath: string]; return: { success: boolean; error?: string } }

  // 3. characters
  'db:character-get-all': { args: [expectedProjectPath: string]; return: CharacterData[] }
  'db:character-upsert': { args: [data: CharacterData, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:character-save-all': {
    args: [items: CharacterData[], renames: CharacterRenameData[] | undefined, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:character-delete': { args: [name: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:character-update-state': { args: [name: string, state: CharacterStateData, expectedProjectPath: string]; return: { success: boolean; error?: string } }

  // 4. drafts
  'db:draft-create': { args: [params: { chapterNumber: number; version: number; source: 'write' | 'rewrite'; content: string; wordCount: number }, expectedProjectPath: string]; return: { success: boolean; id?: number; error?: string } }
  'db:draft-list': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta[] }
  'db:draft-get-meta': { args: [id: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-full': { args: [id: number, expectedProjectPath: string]; return: DraftFull | null }
  'db:draft-get-latest': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-finalized': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-max-finalized-chapter': { args: [expectedProjectPath: string]; return: number }
  'db:draft-next-version': { args: [chapterNumber: number, expectedProjectPath: string]; return: number }
  'db:draft-update-status': { args: [id: number, status: string, wordCount: number | undefined, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-update-content': { args: [id: number, content: string, wordCount: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-delete': { args: [id: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }

  // 5. revisions
  'db:revision-create': { args: [params: { baseDraftId: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number }, expectedProjectPath: string]; return: { success: boolean; id?: number; revisionIndex?: number; error?: string } }
  'db:revision-list': { args: [baseDraftId: number, expectedProjectPath: string]; return: RevisionMeta[] }
  'db:revision-get-pending': { args: [baseDraftId: number, expectedProjectPath: string]; return: RevisionMeta[] }
  'db:revision-get-full': { args: [id: number, expectedProjectPath: string]; return: RevisionFull | null }
  'db:revision-next-index': { args: [baseDraftId: number, expectedProjectPath: string]; return: number }
  'db:revision-mark-merged': { args: [id: number, mergedToDraftId: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:revision-mark-discarded': { args: [id: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }

  // 6. reviews
  'db:review-create': { args: [params: { baseDraftId: number; reviewIndex: number; content: string }, expectedProjectPath: string]; return: { success: boolean; id?: number; error?: string } }
  'db:review-list': { args: [baseDraftId: number, expectedProjectPath: string]; return: ReviewMeta[] }
  'db:review-get-latest': { args: [baseDraftId: number, expectedProjectPath: string]; return: ReviewFull | null }
  'db:review-get-full': { args: [id: number, expectedProjectPath: string]; return: ReviewFull | null }
  'db:review-next-index': { args: [baseDraftId: number, expectedProjectPath: string]; return: number }

  // 7. post_process
  'db:post-process-create-run': { args: [params: { triggerSourceType: string; triggerSourceId: string; sourceLabel: string; steps: Array<{ key: string; label: string; critical: boolean }> }, expectedProjectPath: string]; return: { success: boolean; id?: string; error?: string } }
  'db:post-process-get-latest-run': { args: [sourceType: string, sourceId: string, expectedProjectPath: string]; return: PostProcessRunData | null }
  'db:post-process-get-steps': { args: [runId: string, expectedProjectPath: string]; return: PostProcessStepData[] }
  'db:post-process-mark-step-ok': { args: [runId: string, stepKey: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:post-process-mark-step-failed': { args: [runId: string, stepKey: string, errorMsg: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:post-process-is-all-passed': { args: [sourceType: string, sourceId: string, expectedProjectPath: string]; return: boolean }

  // 沿用旧表
  'db:log-llm-call': { args: [call: Record<string, unknown>, expectedProjectPath: string]; return: { success: boolean } }
  'db:get-llm-stats': { args: [expectedProjectPath: string]; return: { totalCalls: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number } }
  'db:get-llm-history': { args: [limit: number | undefined, expectedProjectPath: string]; return: unknown[] }
  'db:save-summary-snapshot': { args: [chapterNumber: number, characterStates: string, expectedProjectPath: string]; return: { success: boolean } }
  'db:get-latest-summary': { args: [expectedProjectPath: string]; return: { characterStates: string; chapterNumber: number } | null }
}

// ===== 知识库频道 =====
export interface KnowledgeBaseChannels {
  'kb:import-document': { args: [grantId: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode } }
  'kb:import-folder': { args: [grantId: string, expectedProjectPath: string]; return: { success: boolean; importedCount: number; failedFiles: string[]; error?: string; errorCode?: AppErrorCode } }
  'kb:import-text': { args: [text: string, fileName: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode } }
  'kb:search': { args: [query: string, topK: number | undefined, expectedProjectPath: string]; return: AppResult<Array<{ text: string; score: number; fileName: string }>> }
  'kb:search-with-scope': { args: [query: string, fromChapter: number, toChapter: number, topK: number | undefined, expectedProjectPath: string]; return: AppResult<Array<{ text: string; score: number; fileName: string }>> }
  'kb:list-documents': { args: [expectedProjectPath: string]; return: AppResult<Array<{ id: string; fileName: string; importedAt: string; chunkCount: number; filePath: string }>> }
  'kb:remove-document': { args: [docId: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'kb:clear-all': { args: [expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'kb:stats': { args: [expectedProjectPath: string]; return: AppResult<{ documentCount: number; totalChunks: number; vectorDimension: number }> }
  'dialog:select-knowledge-files': { args: []; return: ExternalFileGrant[] | null }
  'dialog:select-knowledge-folder': { args: []; return: ExternalDirectoryGrant | null }
  'kb:get-vectorless-count': { args: [expectedProjectPath: string]; return: AppResult<{ count: number }> }
  /**
   * This is a local status read only. It never sends text to an embedding
   * provider; the renderer uses it to decide whether it may offer a rebuild.
   */
  'kb:get-vector-rebuild-status': {
    args: [expectedProjectPath: string]
    return: AppResult<{
      embeddingConfigured: boolean
      canRebuild: boolean
      totalChunks: number
      vectorlessCount: number
      activeVectorDimension: number
    }>
  }
  'kb:backfill-vectors': { args: [expectedProjectPath: string]; return: { success: boolean; processed: number; failed: number; error?: string; errorCode?: AppErrorCode } }
}

// ===== 导入小说 =====
export interface ImportChannels {
  'dialog:select-novel-files': { args: []; return: ExternalFileGrant[] | null }
  'import:split-chapters': {
    args: [grantIds: string[], options?: { separator?: string }]
    return: {
      success: boolean
      chapters: Array<{ number: number; title: string; content: string; wordCount: number }>
      totalWords: number
      error?: string
    }
  }
}

// ===== MCP =====
export interface MCPChannels {
  'mcp:load-config': { args: [configPath?: string]; return: { success: boolean; configs: unknown[]; error?: string } }
  'mcp:connect': { args: [config: Record<string, unknown>]; return: { success: boolean; error?: string } }
  'mcp:disconnect': { args: [serverId: string]; return: { success: boolean; error?: string } }
  'mcp:disconnect-all': { args: []; return: { success: boolean; error?: string } }
  'mcp:list-tools': { args: []; return: unknown[] }
  'mcp:list-resources': { args: []; return: unknown[] }
  'mcp:call-tool': { args: [serverId: string, toolName: string, args: Record<string, unknown>]; return: { success: boolean; content: string; error?: string } }
  'mcp:get-servers-status': { args: []; return: unknown[] }
  'mcp:get-config-path': { args: []; return: string }
}

// ===== 合并所有频道 =====
export type AllInvokeChannels = WindowChannels & OfficialHomepageChannels & ConfigChannels & UpdateChannels & ProjectChannels & FileChannels & AppDataChannels & LLMChannels & DatabaseChannels & KnowledgeBaseChannels & ImportChannels & MCPChannels
export type AllEventChannels = LLMStreamEvents & UpdateStateEvents

/** 提取 invoke 频道名 */
export type InvokeChannel = keyof AllInvokeChannels

/** 提取 event 频道名 */
export type EventChannel = keyof AllEventChannels
