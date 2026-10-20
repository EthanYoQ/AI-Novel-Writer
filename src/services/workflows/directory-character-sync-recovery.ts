import type {
  BlueprintCharacterSyncCompletionReceipt,
  BlueprintCharacterSyncOperation,
} from '../../../electron/repositories/blueprint-repository'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { localize } from '../../i18n/core'
import type { Locale } from '../../i18n/types'
import { ipc } from '../ipc-client'
import { syncBlueprintCharacterCandidates } from './blueprint-character-sync'
import { workflowMainProcessError } from './workflow-project-session'

export type DirectoryCharacterSyncReceipt = BlueprintCharacterSyncCompletionReceipt

export async function listPendingDirectoryCharacterSyncs(
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<BlueprintCharacterSyncOperation[]> {
  return ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-character-sync-list-pending',
    expectedProjectPath,
  )
}

/**
 * Replays one durable post-commit operation. The frozen input always comes
 * from SQLite, so a renderer/app restart cannot lose or silently alter it.
 */
export async function retryDirectoryCharacterSync(
  operationId: string,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
  uiLocale: Locale,
): Promise<DirectoryCharacterSyncReceipt> {
  const operation = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-character-sync-get',
    operationId,
    expectedProjectPath,
  )
  if (!operation) {
    throw new Error(localize(uiLocale, '待重试的蓝图角色提议操作不存在', 'The pending blueprint character-proposal operation no longer exists.'))
  }
  if (operation.status === 'completed') {
    if (!operation.completionReceipt) {
      throw new Error(localize(uiLocale, '蓝图角色提议完成操作缺少回执', 'The completed blueprint character-proposal operation has no receipt.'))
    }
    return operation.completionReceipt
  }

  await syncBlueprintCharacterCandidates(
    operation.characterSyncInput,
    expectedProjectPath,
    projectSession,
    operation.operationId,
  )
  // Completion means the proposal has been durably staged, not adopted into the roster.
  // Main derives the receipt from the operation and proposal ledger.
  const completed = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-character-sync-complete',
    operation.operationId,
    expectedProjectPath,
  )
  if (!completed.success || completed.operation?.status !== 'completed') {
    throw workflowMainProcessError(
      { uiLocale },
      completed.error,
      '蓝图角色提议已保存，但回执未能持久化',
      'The blueprint character proposals were saved, but their receipt could not be stored.',
    )
  }
  if (!completed.operation.completionReceipt) {
    throw new Error(localize(uiLocale, '蓝图角色提议回执回读失败', 'Could not read back the blueprint character-proposal receipt.'))
  }
  return completed.operation.completionReceipt
}

export async function retryAllPendingDirectoryCharacterSyncs(
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
  uiLocale: Locale,
): Promise<DirectoryCharacterSyncReceipt[]> {
  const pending = await listPendingDirectoryCharacterSyncs(expectedProjectPath, projectSession)
  const receipts: DirectoryCharacterSyncReceipt[] = []
  for (const operation of pending) {
    receipts.push(await retryDirectoryCharacterSync(
      operation.operationId,
      expectedProjectPath,
      projectSession,
      uiLocale,
    ))
  }
  return receipts
}
