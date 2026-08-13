import { translate } from './core'
import type { Locale } from './types'
import type { AppErrorCode } from '../shared/ipc-channels'

const ERROR_KEYS = {
  KNOWLEDGE_BASE_NATIVE_UNAVAILABLE: 'error.knowledgeBaseNativeUnavailable',
  LEGACY_VECTOR_MIGRATION_BLOCKED: 'error.legacyVectorMigrationBlocked',
  PROJECT_NOT_OPEN: 'error.projectNotOpen',
  EMBEDDING_MODEL_NOT_CONFIGURED: 'error.embeddingModelNotConfigured',
  PROJECT_STORAGE_PATH_UNSUPPORTED: 'error.projectStoragePathUnsupported',
} as const

function readCode(error: unknown): AppErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = 'code' in error
    ? error.code
    : 'errorCode' in error
      ? error.errorCode
      : undefined
  return typeof code === 'string' && code in ERROR_KEYS ? code as AppErrorCode : undefined
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function appErrorMessage(locale: Locale, error: unknown): string {
  const code = readCode(error)
  if (code) return translate(locale, ERROR_KEYS[code])
  return translate(locale, 'error.unknown', { message: readMessage(error) })
}
