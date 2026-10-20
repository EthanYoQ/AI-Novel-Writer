import { translate } from './core'
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
  TASK_BUDGET_CAPACITY_CONFLICT: 'error.generationInputTooLarge',
  TASK_BUDGET_SPLIT_REQUIRED: 'error.generationInputTooLarge',
  TASK_BUDGET_SCOPE_SPLIT_REQUIRED: 'error.generationInputTooLarge',
  MODEL_NOT_FOUND: 'error.generationModelMissing',
  NO_DEFAULT_MODEL: 'error.generationModelMissing',
  LEASE_BEGIN_FAILED: 'error.generationRequestFailed',
} as const

type KnownErrorCode = keyof typeof ERROR_KEYS

function isKnownCode(code: unknown): code is KnownErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code)
}

/** 主进程只返回错误码；Electron 会在前面加上调用通道，`String(error)` 还会加 "Error: "。 */
const WRAPPED_CODE = /^(?:Error invoking remote method '[^']+': )?(?:Error: )?([A-Z][A-Z0-9_]*)$/u

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

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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
