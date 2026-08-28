/**
 * IPC 频道定义 — 渲染进程与主进程的类型安全通信契约
 * 所有 IPC 调用都通过此文件定义频道名和参数/返回值类型
 */
import type { Locale } from '../i18n/types'
import type {
  CreativeStrategy,
  GenerationReasoningStage,
  ReasoningOverride,
} from './reasoning-types'
import type { EmbeddingOptions } from './embedding-options'
import type { ModelCapabilities } from './provider-presets'
import type { ModelProviderResourceId } from './model-provider-resources'
import type { WritingLanguage } from './writing-language'
import type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdatePreferences,
  UpdateReminderDelay,
  UpdateState,
} from './update-types'
import type {
  SkinCommand,
  SkinExecuteResponse,
  SkinReadCustomAssetResponse,
  SkinState,
} from './skin-types'
import type {
  ChapterDeletionOperation,
  ChapterDeletionResult,
  DeleteFinalizedChapterRequest,
} from './chapter-deletion'
import type {
  ImportRunChapterSnapshot,
  ImportRunEffectCommitResult,
  ImportRunEffectReceipt,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportInspectionSummary,
  ImportPurpose,
  ImportNovelFileSelectionRequest,
  ImportRunPreparationResult,
  ImportRunPrepareFromInspectionRequest,
  ImportRunPrepareEffectReceiptRequest,
  ImportRunSnapshot,
  ImportRunStartResult,
  ImportRunStage,
} from './import-run'

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

// ===== 图片皮肤 =====
export interface SkinChannels {
  'skin:get-state': {
    args: []
    return: SkinState
  }
  'skin:execute': {
    args: [command: SkinCommand]
    return: SkinExecuteResponse
  }
  'skin:read-custom-asset': {
    args: []
    return: SkinReadCustomAssetResponse
  }
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

// ===== 固定模型服务商外链 =====
export interface ModelProviderResourceChannels {
  /** 只接受受信任资源 ID，由主进程映射为固定 HTTPS URL。 */
  'model-provider-resource:open': {
    args: [resource: ModelProviderResourceId]
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
  | 'PROJECT_STORAGE_PATH_UNSUPPORTED'

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
export interface CreateProjectConfig {
  name: string
  path: string
  genre: string
  targetAudience: string
  writingLanguage?: WritingLanguage
}

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
      config: CreateProjectConfig,
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
      errorCode?: AppErrorCode
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
      errorCode?: AppErrorCode
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
  'llm:begin-execution-lease': {
    args: [modelId: string]
    return: {
      success: boolean
      lease?: ModelExecutionLeaseReceipt
      errorCode?: 'MODEL_NOT_FOUND' | 'LEASE_BEGIN_FAILED'
      error?: string
    }
  }
  'llm:close-execution-lease': {
    args: [leaseId: string]
    return: { success: boolean; error?: string }
  }
  'llm:generate': {
    args: [request: LLMRequest]
    return: LLMResponse
  }
  'llm:generate-stream': {
    args: [requestId: string, request: LLMRequest]
    return: { requestId: string; started: boolean; error?: string }
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
    args: [model: ModelProfile, creativeStrategy?: CreativeStrategy]
    return: { success: boolean; error?: string }
  }
}

export interface LLMStreamEvents {
  'llm:stream-chunk': { requestId: string; chunk: string }
  'llm:stream-done': {
    requestId: string
    fullText: string
    usage?: TokenUsage
    /** Main-process-normalized completion state. Missing provider values become `unknown`. */
    finishReason: LLMFinishReason
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
  /**
   * Project content language; independent from the application UI locale.
   * Missing only while reading pre-language renderer drafts; project open normalizes it.
   */
  writingLanguage?: WritingLanguage
  /** Project-scoped writing intent; independent from the selected model. */
  creativeStrategy?: CreativeStrategy
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

export interface PromptLoadDiagnostic {
  /** Derived from the owned filename when possible; absent means the whole scope is unreadable. */
  key?: string
  path: string
  error: string
}

export interface AppPromptLoadReceipt {
  templates: AppPromptTemplate[]
  diagnostics: PromptLoadDiagnostic[]
}

export interface AppDataChannels {
  'prompt:load-global': { args: []; return: AppPromptLoadReceipt }
  'prompt:save-global': { args: [template: AppPromptTemplate]; return: { success: boolean; error?: string } }
  'prompt:delete-global': { args: [key: string]; return: { success: boolean; error?: string } }
  'skills:list-user': {
    args: []
    return: Array<{ name: string; content: string; baseDir: string; filePath: string }>
  }
}

export interface LLMRequest {
  modelId: string
  /** Optional frozen main-process model snapshot; when present it is authoritative. */
  modelExecutionLeaseId?: string
  /** Stable attribution for per-project call history. */
  purpose?: string
  /** Project-scoped product intent captured by the renderer for this request. */
  creativeStrategy?: CreativeStrategy
  /** Controlled semantic stage; never inferred from the diagnostic purpose label. */
  reasoningStage?: GenerationReasoningStage
  /** Frozen project lease. Missing/stale leases are never written to project statistics. */
  projectSession?: ProjectSessionContext
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  stream?: boolean
  responseFormat?: { type: 'json_object' | 'text' }
}

export type ModelExecutionCapabilityEvidenceSource =
  | 'verified-provider-preset'
  | 'user-operational-cap'
  | 'legacy-profile'
  | 'unknown'

export interface ModelExecutionCapabilityEvidence {
  source: {
    contextWindowTokens: ModelExecutionCapabilityEvidenceSource
    maxOutputTokens: ModelExecutionCapabilityEvidenceSource
    featureFlags: ModelExecutionCapabilityEvidenceSource
  }
  subjectFingerprint: string
  contextWindowTokens: number | null
  maxOutputTokens: number
  reasoning: boolean | null
  structuredOutput: boolean | null
  usage: boolean | null
}

/** Non-secret evidence for a complete ModelProfile snapshot retained only in the main process. */
export interface ModelExecutionLeaseReceipt {
  leaseId: string
  modelId: string
  provider: ModelProfile['provider']
  protocol: ModelProfile['protocol']
  modelName: string
  modelRevision: string
  endpointFingerprint: string
  capabilityEvidence: ModelExecutionCapabilityEvidence
  createdAt: number
  expiresAt: number
}

interface LLMResponseBase {
  content: string
  usage?: TokenUsage
  error?: string
}

/** Every non-stream response carries explicit terminal evidence. */
export type LLMResponse =
  | (LLMResponseBase & { success: true; finishReason: 'stop' })
  | (LLMResponseBase & {
      success: false
      finishReason: Exclude<LLMFinishReason, 'stop'>
    })

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
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

export interface ModelProfile {
  id: string
  name: string
  provider: 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'bigmodel' | 'novelai' | 'xai' | 'siliconflow' | 'custom'
  protocol: 'openai' | 'gemini'
  modelName: string
  apiKey: string
  baseUrl: string
  temperature: number
  /** 新配置使用的端点能力；旧配置缺失时继续使用 maxTokens。 */
  capabilities?: ModelCapabilities
  /** 旧配置和当前执行路径使用的输出 token 上限，保持兼容。 */
  maxTokens: number
  purposes: Array<'generation' | 'refinement' | 'summary' | 'embedding'>
  /** Profile-scoped advanced request; `auto` defers to project strategy and purpose. */
  reasoningOverride?: ReasoningOverride
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
import type {
  BlueprintCharacterSyncOperation,
  BlueprintData,
  BlueprintRangeCommitReceipt,
  BlueprintRangeCommitRequest,
} from '../../electron/repositories/blueprint-repository'
import type {
  CharacterData,
} from '../../electron/repositories/character-repository'
import type { DraftMeta, DraftFull } from '../../electron/repositories/draft-repository'
import type { RevisionMeta, RevisionFull } from '../../electron/repositories/revision-repository'
import type { ReviewMeta, ReviewFull } from '../../electron/repositories/review-repository'
import type { PostProcessRunData, PostProcessStepData } from '../../electron/repositories/post-process-repository'
import type {
  CharacterRosterCommitReceipt,
  CharacterRosterCommitRequest,
  CharacterRosterSnapshot,
} from './character-roster'
import type {
  FinalizedDraftImportReceipt,
  FinalizedDraftImportRequest,
} from './finalized-draft-import'
import type {
  AuthorManuscriptImportPreview,
  AuthoritativeChapterSequence,
} from './author-manuscript-import'
import type {
  ImportGlobalFactsReceipt,
  ImportGlobalFactsRequest,
} from './import-global-facts'

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
  'db:import-global-facts-commit': {
    args: [request: ImportGlobalFactsRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: ImportGlobalFactsReceipt; error?: string }
  }
  'db:project-clear-generated-data': { args: [options: ProjectClearOptions, expectedProjectPath: string]; return: { success: boolean; cleared?: ProjectClearScope[]; physicalFilesDeleted?: number; error?: string } }
  'db:import-run-prepare-inspection': {
    args: [request: ImportRunPrepareFromInspectionRequest, expectedProjectPath: string]
    return: { success: boolean; preparation?: ImportRunPreparationResult; error?: string }
  }
  'db:import-run-author-preview': {
    args: [inspectionId: string, expectedProjectPath: string]
    return: AuthorManuscriptImportPreview
  }
  'db:import-run-finalize-parsing': {
    args: [runId: string, expectedProjectPath: string]
    return: { success: boolean; preparation?: ImportRunPreparationResult; error?: string }
  }
  'db:import-run-get': { args: [runId: string, expectedProjectPath: string]; return: ImportRunSnapshot | null }
  'db:import-run-list-resumable': { args: [expectedProjectPath: string]; return: ImportRunSnapshot[] }
  'db:import-run-list-chapters': {
    args: [runId: string, afterChapterNumber: number, limit: number, expectedProjectPath: string]
    return: ImportRunChapterSnapshot[]
  }
  'db:import-run-effect-receipt-get': {
    args: [runId: string, stage: ImportRunStage, batchId: string, expectedProjectPath: string]
    return: ImportRunEffectReceipt | null
  }
  'db:import-run-effect-receipt-prepare': {
    args: [request: ImportRunPrepareEffectReceiptRequest, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; receipt?: ImportRunEffectReceipt; error?: string }
  }
  'db:import-run-effect-receipt-commit': {
    args: [runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; result?: ImportRunEffectCommitResult; error?: string }
  }
  'db:import-run-start-resume': { args: [runId: string, owner: string, expectedProjectPath: string]; return: { success: boolean; start?: ImportRunStartResult; error?: string } }
  'db:import-run-renew-execution': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; execution?: ImportRunExecutionLease; error?: string } }
  'db:import-run-restart': { args: [runId: string, nextRunId: string, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-request-cancel': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-cancel-at-boundary': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-complete-batch': {
    args: [runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; newlyCompleted?: boolean; cancelApplied?: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-advance-stage': {
    args: [runId: string, completedStage: ImportRunStage, nextStage: ImportRunStage, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-fail': {
    args: [runId: string, stage: ImportRunStage, errorMessage: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-complete': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }

  // 2. blueprints
  'db:blueprint-get-all': { args: [expectedProjectPath: string]; return: BlueprintData[] }
  'db:blueprint-get': { args: [chapterNumber: number, expectedProjectPath: string]; return: BlueprintData | null }
  'db:blueprint-upsert': { args: [data: BlueprintData, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-upsert-many': { args: [items: BlueprintData[], expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-commit-range': {
    args: [request: BlueprintRangeCommitRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: BlueprintRangeCommitReceipt; error?: string }
  }
  'db:blueprint-character-sync-list-pending': {
    args: [expectedProjectPath: string]
    return: BlueprintCharacterSyncOperation[]
  }
  'db:blueprint-character-sync-get': {
    args: [operationId: string, expectedProjectPath: string]
    return: BlueprintCharacterSyncOperation | null
  }
  'db:blueprint-character-sync-complete': {
    args: [
      operationId: string,
      expectedProjectPath: string,
    ]
    return: { success: boolean; operation?: BlueprintCharacterSyncOperation; error?: string }
  }
  'db:blueprint-update-notes': { args: [chapterNumber: number, notes: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-delete': { args: [chapterNumber: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-clear-all': { args: [expectedProjectPath: string]; return: { success: boolean; error?: string } }

  // 3. characters
  'db:character-get-all': { args: [expectedProjectPath: string]; return: CharacterData[] }
  /**
   * 结构化角色名单的唯一提交 seam。角色条目仍持久化于 characters 表；
   * 返回的快照经过主进程事务内 read-back 验证。
   */
  'db:character-roster-read': {
    args: [expectedProjectPath: string]
    return: CharacterRosterSnapshot
  }
  'db:character-roster-commit': {
    args: [request: CharacterRosterCommitRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: CharacterRosterCommitReceipt; error?: string }
  }

  // 4. drafts
  'db:draft-import-finalized-batch': {
    args: [request: FinalizedDraftImportRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: FinalizedDraftImportReceipt; error?: string }
  }
  'db:draft-create': { args: [params: { chapterNumber: number; version: number; source: 'write' | 'rewrite'; content: string; wordCount: number }, expectedProjectPath: string]; return: { success: boolean; id?: number; error?: string } }
  'db:draft-list': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta[] }
  'db:draft-get-meta': { args: [id: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-full': { args: [id: number, expectedProjectPath: string]; return: DraftFull | null }
  'db:draft-get-latest': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-finalized': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-max-finalized-chapter': { args: [expectedProjectPath: string]; return: number }
  'db:draft-authority-sequence': { args: [expectedProjectPath: string]; return: AuthoritativeChapterSequence }
  'db:draft-next-version': { args: [chapterNumber: number, expectedProjectPath: string]; return: number }
  'db:draft-update-status': { args: [id: number, status: string, wordCount: number | undefined, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-update-content': { args: [id: number, content: string, wordCount: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-delete': { args: [id: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:finalization-link-knowledge-document': {
    args: [draftId: number, documentId: string, expectedProjectPath: string]
    return: { success: boolean; finalization?: { knowledgeDocumentId: string }; error?: string }
  }

  // 5. revisions
  'db:revision-create': { args: [params: { baseDraftId: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number }, expectedProjectPath: string]; return: { success: boolean; id?: number; revisionIndex?: number; error?: string } }
  'db:revision-replace-pending': { args: [params: { baseDraftId: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number }, expectedProjectPath: string]; return: { success: boolean; id?: number; revisionIndex?: number; error?: string } }
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
  'db:get-llm-stats': {
    args: [expectedProjectPath: string]
    return: {
      totalCalls: number
      successfulCalls: number
      failedCalls: number
      knownUsageCalls: number
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }
  }
  'db:get-llm-history': { args: [limit: number | undefined, expectedProjectPath: string]; return: unknown[] }
  'db:save-summary-snapshot': { args: [chapterNumber: number, characterStates: string, expectedProjectPath: string]; return: { success: boolean } }
  'db:get-latest-summary': { args: [expectedProjectPath: string]; return: { characterStates: string; chapterNumber: number } | null }
}

// ===== 知识库频道 =====
export interface KnowledgeBaseChannels {
  'kb:import-document': { args: [grantId: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode } }
  'kb:import-folder': { args: [grantId: string, expectedProjectPath: string]; return: { success: boolean; importedCount: number; failedFiles: string[]; error?: string; errorCode?: AppErrorCode } }
  'kb:import-text': { args: [text: string, fileName: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode } }
  'kb:import-reference-text': {
    args: [
      chapterNumber: number,
      runId: string,
      executionAuthority: ImportRunExecutionAuthority,
    ]
    return: { success: boolean; docId?: string; chunkCount?: number; idempotent?: boolean; error?: string; errorCode?: AppErrorCode }
  }
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
  'dialog:select-novel-files': {
    args: [request?: ImportPurpose | ImportNovelFileSelectionRequest, projectSession?: ProjectSessionContext]
    return: {
      success: boolean
      inspection?: ImportInspectionSummary
      preparation?: ImportRunPreparationResult
      error?: string
    } | null
  }
}

// ===== 章节生命周期 =====
export interface ChapterLifecycleChannels {
  'chapter:delete-finalized': {
    args: [request: DeleteFinalizedChapterRequest, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:retry-deletion': {
    args: [operationId: string, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:confirm-legacy-knowledge-absent': {
    args: [operationId: string, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:list-incomplete-deletions': {
    args: [expectedProjectPath: string]
    return: { success: boolean; operations?: ChapterDeletionOperation[]; error?: string }
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
export type AllInvokeChannels = WindowChannels & OfficialHomepageChannels & ModelProviderResourceChannels & ConfigChannels & UpdateChannels & SkinChannels & ProjectChannels & FileChannels & AppDataChannels & LLMChannels & DatabaseChannels & KnowledgeBaseChannels & ChapterLifecycleChannels & ImportChannels & MCPChannels
export type AllEventChannels = LLMStreamEvents & UpdateStateEvents

/** 提取 invoke 频道名 */
export type InvokeChannel = keyof AllInvokeChannels

/** 提取 event 频道名 */
export type EventChannel = keyof AllEventChannels
