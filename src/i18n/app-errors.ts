import { localize, translate } from './core'
import type { Locale } from './types'

/**
 * 稳定错误码 → 界面文案键。新增可读错误码只在这里登记一行，并在两份语言资源里补文案。
 * 代码里出现的每个 GENERATION_* 码（以及该测试 COVERED_PREFIXES 列出的其他前缀的码）要么登记在这里，
 * 要么在 generation-error-codes.test.ts 里写明不登记的理由。
 */
const ERROR_KEYS = {
  KNOWLEDGE_BASE_NATIVE_UNAVAILABLE: 'error.knowledgeBaseNativeUnavailable',
  LEGACY_VECTOR_MIGRATION_BLOCKED: 'error.legacyVectorMigrationBlocked',
  PROJECT_NOT_OPEN: 'error.projectNotOpen',
  EMBEDDING_MODEL_NOT_CONFIGURED: 'error.embeddingModelNotConfigured',
  PROJECT_STORAGE_PATH_UNSUPPORTED: 'error.projectStoragePathUnsupported',
  PROJECT_ROOT_REQUIRED: 'error.projectRootRequired',
  PROJECT_LEGACY_IMPORT_REQUIRED: 'error.projectLegacyImportRequired',
  // 项目会话与外部文件授权（#474 B4）：主进程的会话守卫、项目路径守卫与打开、创建、删除项目时的拒绝原因。
  PROJECT_SESSION_REQUIRED: 'error.projectSessionRequired',
  PROJECT_CONTEXT_REQUIRED: 'error.projectSessionRequired',
  PROJECT_SESSION_STALE: 'error.projectSessionStale',
  PROJECT_SESSION_ROOT_MISMATCH: 'error.projectSessionStale',
  PROJECT_SESSION_DATABASE_MISMATCH: 'error.projectSessionStale',
  PROJECT_SESSION_IDENTITY_MISMATCH: 'error.projectSessionStale',
  PROJECT_CONTEXT_CHANGED: 'error.projectSessionStale',
  PROJECT_FILE_OUTSIDE_PROJECT: 'error.projectFileOutsideProject',
  PROJECT_DIRECTORY_EXISTS: 'error.projectDirectoryExists',
  PROJECT_DIRECTORY_MISSING: 'error.projectDirectoryMissing',
  PROJECT_DIRECTORY_NOT_FOLDER: 'error.projectDirectoryMissing',
  PROJECT_DIRECTORY_DRIVE_ROOT: 'error.projectDirectoryReserved',
  PROJECT_DIRECTORY_HOME: 'error.projectDirectoryReserved',
  PROJECT_DIRECTORY_UNSAFE: 'error.projectDirectoryUnsafe',
  PROJECT_DIRECTORY_MANIFEST_UNREADABLE: 'error.projectManifestInvalid',
  PROJECT_DIRECTORY_MANIFEST_INVALID: 'error.projectManifestInvalid',
  PROJECT_MANIFEST_INVALID: 'error.projectManifestInvalid',
  PROJECT_OPEN_GRANT_REQUIRED: 'error.projectOpenGrantRequired',
  PROJECT_OPEN_RECENT_IDENTITY_CHANGED: 'error.projectRecentIdentityChanged',
  PROJECT_MIGRATION_NOT_QUALIFIED: 'error.projectMigrationNotQualified',
  PROJECT_MIGRATION_DUAL_ROOT: 'error.projectMigrationNotQualified',
  PROJECT_MIGRATION_RECOVERY_REQUIRED: 'error.projectMigrationNotQualified',
  UNRECOGNIZED_SCHEMA: 'error.projectSchemaUnrecognized',
  CORRUPT_SCHEMA: 'error.projectSchemaCorrupt',
  NEWER_SCHEMA_READ_ONLY: 'error.projectSchemaNewer',
  LEGACY_IMPORT_UNSUPPORTED_SOURCE: 'error.legacyImportUnsupportedSource',
  PROJECT_DELETE_FAILED: 'error.projectDeleteFailed',
  PROJECT_RECENT_LIST_UPDATE_FAILED: 'error.projectRecentListUpdateFailed',
  PROJECT_ARCHIVE_TARGET_EXISTS: 'error.projectArchiveTargetExists',
  // 选择文件或文件夹后授权已过期、用尽或被撤销（例如选完很久才确认）。
  EXTERNAL_FILE_GRANT_NOT_FOUND: 'error.externalFileGrantExpired',
  EXTERNAL_FILE_GRANT_EXPIRED: 'error.externalFileGrantExpired',
  EXTERNAL_FILE_GRANT_EXHAUSTED: 'error.externalFileGrantExpired',
  // 新建、打开项目时，所选文件夹在选择之后被移动、改名或替换：project-controller 经 String(error) 原样转给界面。
  EXTERNAL_FILE_GRANT_TARGET_CHANGED: 'error.externalFileGrantExpired',
  GENERATION_REQUEST_FAILED: 'error.generationRequestFailed',
  GENERATION_PROJECT_SESSION_STALE: 'error.generationProjectSessionStale',
  GENERATION_PROJECT_SESSION_REQUIRED: 'error.generationProjectSessionRequired',
  GENERATION_DRAFT_NOT_CURRENT: 'error.generationDraftNotCurrent',
  GENERATION_REVIEW_LINEAGE_UNPROVEN: 'error.generationReviewLineageUnproven',
  GENERATION_DRAFT_DEPENDENCY_STALE: 'error.generationDraftDependencyStale',
  GENERATION_DRAFT_DEPENDENCY_INVALID: 'error.generationDraftDependencyInvalid',
  GENERATION_SOURCE_CHANGED: 'error.generationSourceChanged',
  // 生成期间作者改了设定、蓝图、前文或输入，或删掉了所选的来源：各环节的复核码都按「依据变了」解释。
  GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT: 'error.generationSourceChanged',
  GENERATION_ASSET_CHANGED_DURING_SNAPSHOT: 'error.generationSourceChanged',
  GENERATION_SOURCE_MISSING: 'error.generationSourceChanged',
  GENERATION_CHAPTER_MISSING: 'error.generationSourceChanged',
  GENERATION_AUTHOR_DRAFT_CHANGED: 'error.generationSourceChanged',
  GENERATION_AGENT_SOURCE_CHANGED: 'error.generationSourceChanged',
  GENERATION_AGENT_TOOL_STALE: 'error.generationSourceChanged',
  GENERATION_DRAFT_SOURCE_CHANGED: 'error.generationSourceChanged',
  GENERATION_DRAFT_PREPARATION_CHANGED: 'error.generationSourceChanged',
  GENERATION_DRAFT_AUTHOR_CONFIG_CHANGED: 'error.generationSourceChanged',
  GENERATION_DRAFT_RECOVERY_SOURCE_CHANGED: 'error.generationSourceChanged',
  GENERATION_DRAFT_RECOVERY_SOURCE_SELECTION_CHANGED: 'error.generationSourceChanged',
  GENERATION_DRAFT_RECOVERY_AUTHOR_INPUT_CHANGED: 'error.generationSourceChanged',
  GENERATION_REVIEW_CONTEXT_CHANGED: 'error.generationSourceChanged',
  GENERATION_REVIEW_HISTORY_CHANGED: 'error.generationSourceChanged',
  GENERATION_REVIEW_CONFIRMATION_CHANGED: 'error.generationSourceChanged',
  GENERATION_REVIEW_RECHECK_NOT_REQUIRED: 'error.generationSourceChanged',
  GENERATION_CHARACTER_CONTEXT_CHANGED: 'error.generationSourceChanged',
  GENERATION_FINALIZATION_SOURCE_CHANGED: 'error.generationSourceChanged',
  GENERATION_FINALIZATION_NOTES_CHANGED: 'error.generationSourceChanged',
  GENERATION_BATCH_SAVED_DRAFT_CHANGED: 'error.generationSourceChanged',
  GENERATION_BATCH_PREDECESSOR_CHANGED: 'error.generationSourceChanged',
  GENERATION_BATCH_DRAFT_REPLACED: 'error.generationSourceChanged',
  GENERATION_BATCH_AUTHOR_INPUT_CHANGED: 'error.generationSourceChanged',
  GENERATION_DIRECTORY_AUTHOR_INPUT_CHANGED: 'error.generationSourceChanged',
  GENERATION_DIRECTORY_CONTINUATION_RANGE_CHANGED: 'error.generationSourceChanged',
  GENERATION_PLANNING_CONTINUATION_RANGE_CHANGED: 'error.generationSourceChanged',
  GENERATION_PLANNING_TARGET_CHANGED: 'error.generationSourceChanged',
  GENERATION_PLANNING_INTENT_CHANGED: 'error.generationSourceChanged',
  GENERATION_PLOT_OUTLINE_GUIDANCE_CHANGED: 'error.generationSourceChanged',
  GENERATION_GRAPH_TARGET_CHANGED: 'error.generationSourceChanged',
  GENERATION_IMPORT_CHECKPOINT_CHANGED: 'error.generationSourceChanged',
  GENERATION_REVIEW_SOURCE_CHANGED: 'error.sourceDraftChanged',
  GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT: 'error.generationSavedWithNewerAuthorDraft',
  GENERATION_PLOT_OUTLINE_AUTHOR_SAVED: 'error.generationPlotOutlineAuthorSaved',
  // 生成途中关闭或切换了作品。
  GENERATION_PROJECT_CLOSED: 'error.generationProjectSessionStale',
  GENERATION_OWNER_CLOSED: 'error.generationProjectSessionStale',
  GENERATION_DATABASE_CHANGED: 'error.generationProjectSessionStale',
  GENERATION_EPOCH_STALE: 'error.generationProjectSessionStale',
  GENERATION_DATABASE_NOT_READY: 'error.projectNotOpen',
  GENERATION_CANCELLED: 'error.generationCancelled',
  GENERATION_ACTION_CANCELLED: 'error.generationCancelled',
  GENERATION_WORKFLOW_CANCELLED: 'error.generationCancelled',
  GENERATION_AGENT_CANCELLED: 'error.generationCancelled',
  GENERATION_PROVIDER_FAILED: 'error.generationProviderFailed',
  GENERATION_STREAM_INVALID: 'error.generationProviderFailed',
  GENERATION_CONTEXT_LENGTH_EXCEEDED: 'error.generationContextLengthExceeded',
  GENERATION_FAILED: 'error.generationRequestFailed',
  GENERATION_AGENT_ACTION_LIMIT: 'error.generationRequestFailed',
  GENERATION_REVIEW_REPLACEMENT_LIMIT: 'error.generationRequestFailed',
  GENERATION_DRAFT_SHORT_OUTLINE_FAILED: 'error.generationDraftIncomplete',
  GENERATION_STORAGE_FAILED: 'error.generationStorageFailed',
  GENERATION_MODEL_MISSING: 'error.generationModelMissing',
  GENERATION_MODEL_REQUIRED: 'error.generationModelMissing',
  GENERATION_AGENT_MODEL_REQUIRED: 'error.generationModelMissing',
  GENERATION_DISPATCH_BLOCKED: 'error.generationStopped',
  GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE: 'error.generationFinalizationRecoveryUnavailable',
  GENERATION_AGENT_ACTION_BLOCKED: 'error.generationStopped',
  GENERATION_DIRECTORY_CONTINUATION_BLOCKED: 'error.generationStopped',
  GENERATION_IMPORT_EXECUTION_STALE: 'error.generationStopped',
  GENERATION_WORKFLOW_SESSION_BUSY: 'error.generationBusy',
  GENERATION_PLOT_OUTLINE_AUTHOR_IN_FLIGHT: 'error.generationBusy',
  GENERATION_KNOWLEDGE_BUSY: 'error.generationKnowledgeBusy',
  GENERATION_AUTHOR_INPUT_TOO_LARGE: 'error.generationInputTooLarge',
  GENERATION_IMPORT_CONTEXT_LIMIT: 'error.generationInputTooLarge',
  GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED: 'error.generationInputTooLarge',
  GENERATION_COMPOSITION_NO_PROGRESS: 'error.generationNoProgress',
  GENERATION_REVIEW_REVISION_EMPTY: 'error.generationRevisionUnchanged',
  GENERATION_REVIEW_REVISION_NOOP: 'error.generationRevisionUnchanged',
  GENERATION_SKILL_MISSING: 'error.generationSkillUnavailable',
  GENERATION_SKILL_INCOMPATIBLE: 'error.generationSkillUnavailable',
  GENERATION_SKILL_BUNDLE_DAMAGED: 'error.generationSkillBundleDamaged',
  // 途中保存了模型设置：续跑情节大纲时主进程抛前者，#453 的分派复核抛后者（#441）。
  GENERATION_MODEL_CHANGED: 'error.generationModelChanged',
  GENERATION_IMPORT_MODEL_CHANGED: 'error.generationModelChanged',
  GENERATION_SOURCE_CHANGED_MODEL: 'error.generationModelChanged',
  GENERATION_FINALIZED_SOURCE_NOT_CURRENT: 'error.generationFinalizedSourceNotCurrent',
  GENERATION_DRAFT_INCOMPLETE: 'error.generationDraftIncomplete',
  SOURCE_DRAFT_CHANGED: 'error.sourceDraftChanged',
  // 以下前缀不是 GENERATION_，但同样会进工作流失败面板（#471）。
  LEGACY_ROSTER_GENERATION_CANCELLED: 'error.generationCancelled',
  CHARACTER_PROPOSAL_CANCELLED: 'error.generationCancelled',
  LEGACY_ROSTER_GENERATION_SOURCE_CONFLICT: 'error.generationSourceChanged',
  LEGACY_ROSTER_ADOPTION_SOURCE_CHANGED: 'error.generationSourceChanged',
  CHARACTER_PROPOSAL_SOURCE_CHANGED: 'error.generationSourceChanged',
  CHARACTER_PROPOSAL_CHOICES_STALE: 'error.generationSourceChanged',
  FINALIZED_CHARACTER_SOURCE_CHANGED: 'error.generationSourceChanged',
  FINALIZED_CHARACTER_STATE_SOURCE_CHANGED: 'error.generationSourceChanged',
  FINALIZED_CHARACTER_CONTEXT_CHANGED: 'error.generationSourceChanged',
  // 定稿后处理途中作者删掉了这个角色。
  FINALIZED_CHARACTER_ID_RETIRED: 'error.generationSourceChanged',
  LEGACY_ROSTER_GENERATION_ALREADY_OPEN: 'error.generationBusy',
  LEGACY_ROSTER_GENERATION_DETACHED: 'error.generationStopped',
  // 调用额度、截止时间或用量预留用完：失败面板先按结构化失败原因说明，这里是没带失败原因时的兜底。
  ROOT_BUDGET_EXHAUSTED: 'error.generationStopped',
  ATTEMPT_BUDGET_EXHAUSTED: 'error.generationStopped',
  DEADLINE_EXHAUSTED: 'error.generationStopped',
  USAGE_EXCEEDED_RESERVATION: 'error.generationStopped',
  // 只有这一个是旧版本在发送前按估算拒绝时留下的码（ADR-0023 后不再产生），旧运行记录读回时仍给出说明。
  TASK_BUDGET_CAPACITY_CONFLICT: 'error.generationInputTooLarge',
  TASK_BUDGET_SPLIT_REQUIRED: 'error.generationInputTooLarge',
  TASK_BUDGET_SCOPE_SPLIT_REQUIRED: 'error.generationInputTooLarge',
  MODEL_NOT_FOUND: 'error.generationModelMissing',
  NO_DEFAULT_MODEL: 'error.generationModelMissing',
  LEASE_BEGIN_FAILED: 'error.generationRequestFailed',
  // 角色建议页（待批准的角色提议、定稿角色状态建议）的决策请求被主进程拒绝（#474）。
  CHARACTER_PROPOSAL_ALREADY_APPROVED: 'error.characterProposalAlreadyDecided',
  CHARACTER_PROPOSAL_NOT_PENDING_FINALIZED: 'error.characterProposalAlreadyDecided',
  CHARACTER_APPROVAL_NONCE_CONFLICT: 'error.characterProposalAlreadyDecided',
  CHARACTER_ID_REVISION_CONFLICT: 'error.characterRosterChanged',
  CHARACTER_ID_UNKNOWN: 'error.characterRosterChanged',
  CHARACTER_AUTHOR_ROSTER_NOT_READY: 'error.characterRosterNotReady',
  FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND: 'error.characterSuggestionGone',
  FINALIZED_CHARACTER_STATE_FIELD_CONFLICT: 'error.characterStateChanged',
  // 定稿后处理提交角色状态时，字段已由更晚章节写过或来源对不上（#491）。
  FINALIZED_CHARACTER_SOURCE_CONFLICT: 'error.characterStateSourceConflict',
  // 定稿后处理提交角色状态时，字段在生成期间已被改动（#484）。
  FINALIZED_CHARACTER_FIELD_CONFLICT: 'error.characterStateFieldConflict',
  FINALIZED_CHARACTER_STATE_OPERATION_CONFLICT: 'error.characterStateChanged',
  // 角色名单、蓝图与剧情资料（#474 B2）：作者在角色页手工编辑、生成或修复名单时能照着处理的拒绝原因。
  CHARACTER_ROSTER_NAME_REQUIRED: 'error.characterRosterNameRequired',
  CHARACTER_ROSTER_NAME_DUPLICATE: 'error.characterRosterNameDuplicate',
  CHARACTER_ROSTER_RELATIONSHIP_TARGET_REQUIRED: 'error.characterRosterRelationshipInvalid',
  CHARACTER_ROSTER_RELATIONSHIP_DESCRIPTION_REQUIRED: 'error.characterRosterRelationshipInvalid',
  CHARACTER_ROSTER_RELATIONSHIP_SELF: 'error.characterRosterRelationshipInvalid',
  CHARACTER_ROSTER_RELATIONSHIP_DUPLICATE: 'error.characterRosterRelationshipInvalid',
  CHARACTER_ROSTER_RELATIONSHIP_TARGET_UNKNOWN: 'error.characterRosterRelationshipInvalid',
  CHARACTER_ROSTER_REVISION_STALE: 'error.characterRosterChanged',
  CHARACTER_ROSTER_RENAME_SOURCE_MISSING: 'error.characterRosterChanged',
  CHARACTER_ROSTER_LEGACY_REPAIR_NOT_NEEDED: 'error.characterRosterChanged',
  CHARACTER_ROSTER_LEGACY_ADOPTION_UNAVAILABLE: 'error.characterRosterChanged',
  BLUEPRINT_CHARACTER_SYNC_FACTS_CHANGED: 'error.characterRosterChanged',
  CHARACTER_ROSTER_LEGACY_REPAIR_REQUIRED: 'error.characterRosterNeedsRepair',
  CHARACTER_ROSTER_EXISTING_PROTECTED: 'error.characterRosterNeedsRepair',
  BLUEPRINT_CHARACTER_SYNC_ROSTER_NOT_READY: 'error.characterRosterNeedsRepair',
  CHARACTER_ROSTER_FINALIZED_SOURCE_STALE: 'error.generationSourceChanged',
  CHARACTER_ROSTER_LEGACY_SOURCE_CHANGED: 'error.generationSourceChanged',
  CHARACTER_ROSTER_STATE_NEWER_CHAPTER: 'error.characterRosterNewerChapter',
  // 生成情节大纲途中项目数据被改动，主进程拒绝覆盖。
  PROJECT_CORE_SYNOPSIS_CHANGED: 'error.generationSourceChanged',
  NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE: 'error.narrativeThreadEvidenceNotInSource',
  DRAFT_NOT_FOUND: 'error.draftNotFound',
  DRAFT_FINALIZED_READ_ONLY: 'error.draftFinalizedReadOnly',
  // 删除已定稿的这一章（#474 B5）：删除与清理重试时作者能照着处理的拒绝原因。
  CHAPTER_DELETE_OPERATION_NOT_FOUND: 'error.chapterDeleteOperationNotFound',
  CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED: 'error.chapterDeleteLegacyConfirmationConsumed',
  CHAPTER_DELETE_SOURCE_CHANGED: 'error.chapterDeleteSourceChanged',
  CHAPTER_DELETE_KNOWLEDGE_NOT_REMOVED: 'error.chapterDeleteKnowledgeNotRemoved',
  CHAPTER_DELETE_LEGACY_KNOWLEDGE_CHECK_REQUIRED: 'error.chapterDeleteLegacyKnowledgeCheckRequired',
  CHAPTER_DELETE_LEGACY_OPERATION_FROZEN: 'error.chapterDeleteLegacyOperationFrozen',
  // 拼进「正文已删除，但派生投影仍待清理：……」与「重试清理失败」，所以文案不带句末标点；逐项原因在删除清理提示里。
  CHAPTER_DELETE_CLEANUP_INCOMPLETE: 'error.chapterDeleteCleanupIncomplete',
  // 定稿提交与实体稿发布（#474 B5）。
  FINALIZATION_COMMIT_CONFLICT: 'error.finalizationCommitConflict',
  FINALIZATION_COMMIT_NOT_FOUND: 'error.finalizationCommitNotFound',
  MANUSCRIPT_TARGET_CONFLICT: 'error.manuscriptTargetConflict',
  MANUSCRIPT_TARGET_COLLISIONS: 'error.manuscriptTargetCollisions',
  // 合并、丢弃审稿修订稿（#474 B5）。
  REVISION_NOT_FOUND: 'error.revisionNotFound',
  REVISION_NOT_PENDING: 'error.revisionAlreadyHandled',
  REVISION_ALREADY_MERGED: 'error.revisionAlreadyMerged',
  REVISION_TARGET_NOT_EDITABLE: 'error.revisionTargetNotEditable',
  REVISION_TARGET_CHANGED: 'error.revisionTargetChanged',
  REVISION_SOURCE_MISSING: 'error.revisionSourceMissing',
  REVISION_SOURCE_MISMATCH: 'error.revisionSourceMismatch',
  // 运行恢复稿、一致性豁免与定稿后处理（#474 B5）。
  RECOVERY_CANDIDATE_NOT_PENDING: 'error.recoveryCandidateAlreadyHandled',
  RECOVERY_CANDIDATE_SOURCE_CHANGED: 'error.recoveryCandidateSourceChanged',
  RECOVERY_CANDIDATE_TEXT_EMPTY: 'error.recoveryCandidateTextEmpty',
  CONSISTENCY_EXEMPTION_REASON_INVALID: 'error.consistencyExemptionReasonInvalid',
  POST_PROCESS_FINALIZATION_SOURCE_CHANGED: 'error.postProcessSourceChanged',
  // 知识库与检索索引（#474 B3）：知识库页、设置里的检索索引检查、导入创作资料与定稿收入知识库按码说明。
  EMBEDDING_REQUEST_FAILED: 'error.embeddingRequestFailed',
  EMBEDDING_OLLAMA_NATIVE_URL: 'error.embeddingOllamaNativeUrl',
  EMBEDDING_RESPONSE_INVALID: 'error.embeddingResponseInvalid',
  EMBEDDING_SPACE_REGISTRY_INVALID: 'error.knowledgeIndexDamaged',
  EMBEDDING_SPACE_UNREGISTERED_DATA: 'error.knowledgeIndexDamaged',
  EMBEDDING_SPACE_BUSY: 'error.knowledgeIndexBusy',
  EMBEDDING_SPACE_CHANGED: 'error.knowledgeIndexChanged',
  EMBEDDING_SPACE_REINDEX_REQUIRED: 'error.knowledgeIndexReindexRequired',
  KNOWLEDGE_BASE_COPY_UNAVAILABLE: 'error.knowledgeCopyUnavailable',
  KNOWLEDGE_BASE_COPY_CHANGED: 'error.knowledgeCopyChanged',
  KNOWLEDGE_BASE_COPY_EMPTY: 'error.knowledgeCopyEmpty',
  KNOWLEDGE_BASE_TEXT_EMPTY: 'error.knowledgeTextEmpty',
  // 模型调用与设置（#474 B6）：保存或删除模型、设默认模型，以及按模型设置建执行租约时作者能照着改的原因。
  LLM_MODEL_CONFIG_CORRUPT: 'error.modelSettingsFileDamaged',
  LLM_GLOBAL_CONFIG_CORRUPT: 'error.modelSettingsFileDamaged',
  LLM_DEFAULT_MODEL_ROLLBACK_FAILED: 'error.defaultModelRollbackFailed',
  LLM_STAGE_MODEL_UNAVAILABLE: 'error.stageModelUnavailable',
  LLM_STAGE_MODEL_REQUEST_INVALID: 'error.stageModelRequestInvalid',
  MODEL_ENDPOINT_INVALID: 'error.modelEndpointInvalid',
  MODEL_OUTPUT_LIMIT_INVALID: 'error.modelOutputLimitInvalid',
  // 生成与连接测试都会按模型设置组请求参数，Kimi 官方接口的温度超出范围时在发请求前拒绝。
  GENERATION_KIMI_TEMPERATURE_INVALID: 'error.kimiTemperatureInvalid',
  // MCP 服务器（#474 B6）：读取配置、连接服务器与调用工具时的失败。
  MCP_CONFIG_INVALID: 'error.mcpConfigInvalid',
  MCP_CONNECT_FAILED: 'error.mcpConnectFailed',
  MCP_REQUEST_TIMEOUT: 'error.mcpRequestTimeout',
  MCP_SERVER_NOT_CONNECTED: 'error.mcpServerNotConnected',
  // 导入运行与导入回执（#474 B1）：导入对话框、导入运行卡片与可继续的导入列表里作者能照着处理的原因。
  // 主进程在导入通道的 IPC 边界按导入运行的语言把这些码写成说明，原码放在 errorCode。
  IMPORT_RUN_EXECUTION_STALE: 'error.importRunExecutionStale',
  IMPORT_RUN_EXECUTOR_BUSY: 'error.importRunExecutorBusy',
  IMPORT_RUN_ANOTHER_RUNNING: 'error.importRunAnotherRunning',
  IMPORT_RUN_NOT_STARTABLE: 'error.importRunNotStartable',
  IMPORT_RUN_NOT_RESTARTABLE: 'error.importRunNotRestartable',
  IMPORT_RUN_AUTHOR_RESTART_FORBIDDEN: 'error.importRunAuthorRestartForbidden',
  IMPORT_RUN_NOT_CANCELLABLE: 'error.importRunNotCancellable',
  IMPORT_RUN_PARSING_INCOMPLETE: 'error.importRunParsingIncomplete',
  IMPORT_RUN_REAUTHORIZE_UNAVAILABLE: 'error.importRunReauthorizeUnavailable',
  IMPORT_RUN_REAUTHORIZE_SOURCES_MISMATCH: 'error.importRunReauthorizeSourcesMismatch',
  IMPORT_RUN_REAUTHORIZE_CONTENT_CHANGED: 'error.importRunReauthorizeContentChanged',
  IMPORT_RUN_EFFECT_HISTORY_UNKNOWN: 'error.importRunEffectHistoryUnknown',
  IMPORT_INSPECTION_EXPIRED: 'error.importInspectionExpired',
  IMPORT_INSPECTION_LIMIT: 'error.importInspectionLimit',
  FINALIZED_IMPORT_PREVIEW_STALE: 'error.finalizedImportPreviewStale',
} as const

type KnownErrorCode = keyof typeof ERROR_KEYS

function isKnownCode(code: unknown): code is KnownErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code)
}

/**
 * 主进程只返回错误码；Electron 会在前面加上调用通道，`String(error)` 还会加 "Error: "。
 * 带名字的错误类（ProjectSessionStaleError）加的是自己的类名。
 */
const WRAPPED_CODE = /^(?:Error invoking remote method '[^']+': )?(?:[A-Za-z]*Error: )?([A-Z][A-Z0-9_]*)$/u

function readCode(error: unknown): KnownErrorCode | undefined {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined
  if (message !== undefined) {
    const code = WRAPPED_CODE.exec(message.trim())?.[1]
    if (isKnownCode(code)) return code
  }
  if (typeof error !== 'object' || error === null) return undefined
  const code = 'code' in error
    ? error.code
    : 'errorCode' in error
      ? error.errorCode
      : undefined
  return isKnownCode(code) ? code : undefined
}

/** Electron 在主进程报错前加的调用通道前缀对作者没有意义，兜底说明里去掉。 */
const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/u

function readMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(IPC_PREFIX, '')
}

/** 已登记错误码的可读文案；未登记时返回 undefined，由调用方保留原有说明。 */
export function knownAppErrorMessage(locale: Locale, error: unknown): string | undefined {
  const code = readCode(error)
  return code ? translate(locale, ERROR_KEYS[code]) : undefined
}

export function appErrorMessage(locale: Locale, error: unknown): string {
  return knownAppErrorMessage(locale, error)
    ?? translate(locale, 'error.unknown', { message: readMessage(error) })
}

/** 显示处去掉的前缀：Electron 的调用通道，以及 "Error: "、"TypeError: " 这类类名。 */
const DISPLAY_PREFIX = /^(?:Error invoking remote method '[^']+': )?(?:[A-Za-z]*Error: )?/u

/**
 * 把报错交给作者看的统一入口（toast、提示框、内联提示）：主进程的 result.error、IPC 抛出的错误
 * 与渲染端按界面语言写好的说明都可以直接传进来。登记过的码按界面语言说明；认不出的去掉通道与类名前缀后
 * 保留原文，不吞掉信息；完全没有内容时用该处的兜底说明（调用方用 text(zh, en) 写好）。
 */
export function displayedErrorMessage(locale: Locale, error: unknown, fallback?: string): string {
  const known = knownAppErrorMessage(locale, error)
  if (known) return known
  return displayedRaw(error).trim().replace(DISPLAY_PREFIX, '') || fallback || localize(locale, '未知错误', 'Unknown error')
}

/** 报错里能给作者看的原文：字符串本身、Error 或普通对象的字符串 message；别的对象没有可读内容，交给兜底。 */
function displayedRaw(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return error == null ? '' : String(error)
}

/** 文字里有没有汉字，含扩展区与兼容区；判断原因能否拼进英文句子都用它。 */
export function containsHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value)
}

/** 英文句子后附上原因；原因里仍有汉字（主进程未登记的中文原文）时只给英文概述，不把中文拼进英文句子。 */
export function englishWithReason(summary: string, reason: string, separator = ' '): string {
  return !reason.trim() || containsHan(reason) ? summary : `${summary}${separator}${reason}`
}
