import type {
  BlueprintCharacterSyncCompletionReceipt,
  BlueprintCharacterSyncOperation,
} from '../../../electron/repositories/blueprint-repository'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { ipc } from '../ipc-client'
import { syncBlueprintCharacterCandidates } from './blueprint-character-sync'

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
): Promise<DirectoryCharacterSyncReceipt> {
  const operation = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-character-sync-get',
    operationId,
    expectedProjectPath,
  )
  if (!operation) throw new Error('待重试的蓝图角色同步操作不存在')
  if (operation.status === 'completed') {
    if (!operation.completionReceipt) throw new Error('蓝图角色同步完成操作缺少回执')
    return operation.completionReceipt
  }

  await syncBlueprintCharacterCandidates(
    operation.characterSyncInput,
    expectedProjectPath,
    projectSession,
    operation.operationId,
  )
  // The renderer may execute the roster sync, but only the main process reads
  // authoritative operation/fact tables and derives the completion receipt.
  const completed = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-character-sync-complete',
    operation.operationId,
    expectedProjectPath,
  )
  if (!completed.success || completed.operation?.status !== 'completed') {
    throw new Error(completed.error || '蓝图角色同步已执行，但完成回执未能持久化')
  }
  if (!completed.operation.completionReceipt) {
    throw new Error('蓝图角色同步完成回执回读失败')
  }
  return completed.operation.completionReceipt
}

export async function retryAllPendingDirectoryCharacterSyncs(
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<DirectoryCharacterSyncReceipt[]> {
  const pending = await listPendingDirectoryCharacterSyncs(expectedProjectPath, projectSession)
  const receipts: DirectoryCharacterSyncReceipt[] = []
  for (const operation of pending) {
    receipts.push(await retryDirectoryCharacterSync(
      operation.operationId,
      expectedProjectPath,
      projectSession,
    ))
  }
  return receipts
}
