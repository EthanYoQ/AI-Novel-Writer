import { translate } from './core'
import type { Locale } from './types'

/** 稳定错误码 → 界面文案键。新增可读错误码只在这里登记一行，并在两份语言资源里补文案。 */
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
  // 途中保存了模型设置：续跑情节大纲时主进程抛前者，#453 的分派复核抛后者（#441）。
  GENERATION_MODEL_CHANGED: 'error.generationModelChanged',
  GENERATION_IMPORT_MODEL_CHANGED: 'error.generationModelChanged',
  GENERATION_SOURCE_CHANGED_MODEL: 'error.generationModelChanged',
  GENERATION_FINALIZED_SOURCE_NOT_CURRENT: 'error.generationFinalizedSourceNotCurrent',
  GENERATION_DRAFT_INCOMPLETE: 'error.generationDraftIncomplete',
  SOURCE_DRAFT_CHANGED: 'error.sourceDraftChanged',
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
