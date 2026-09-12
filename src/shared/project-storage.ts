import { isContentHash, isFinalizedSourceIdentity, sameProjectEpoch, type ProjectEpoch } from './source-ref'
import type { FinalizedSourceIdentity } from './finalized-continuity'

/** Business IDs only. Numeric PRAGMA versions belong to electron/migrations/registry. */
export const MIGRATION_IDS = ['M00', 'M01', 'M02', 'M03', 'M04', 'M05'] as const
export type MigrationId = typeof MIGRATION_IDS[number]
export const PROJECT_MIGRATION_JOURNAL = '.ai-novel-migration/journal.json'
export const STORAGE_ENVIRONMENT = {
  legacySource: 'AI_NOVEL_LEGACY_SOURCE_HOME', legacySourceCompatibility: 'AI_NOVEL_VELA_HOME',
  canonicalTarget: 'AI_NOVEL_APP_DATA_HOME',
} as const
export type MigrationPhysicalPhase = 'prepared' | 'verified' | 'legacy-isolated' | 'target-installed' | 'switched'
export interface StorageRootProof {
  canonicalRealPath: string; platform: 'win32' | 'darwin' | 'linux'
  reparseFree: boolean; authorized: boolean
}
export interface GlobalStorageLocators {
  legacySource: StorageRootProof; canonicalTarget: StorageRootProof; userData: StorageRootProof
}
/** Proofs must come from main's realpath/reparse/capability probe, never renderer assertions. */
export function assertDistinctStorageRoots(roots: readonly StorageRootProof[]): void {
  const paths = roots.map(root => {
    if (!root.authorized || !root.reparseFree || !root.canonicalRealPath) throw new Error('STORAGE_ROOT_UNPROVEN')
    const canonical = root.canonicalRealPath.replace(/\\/gu, '/').replace(/\/$/u, '')
    return root.platform === 'win32' ? canonical.toLowerCase() : canonical
  })
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i] === paths[j] || paths[i]!.startsWith(paths[j]! + '/') || paths[j]!.startsWith(paths[i]! + '/')) throw new Error('STORAGE_ROOT_INTERSECTION')
  }
}
export type MainReady = { state: 'pending' | 'blocked' } | { state: 'ready'; globalGeneration: string; skinRevision: number }
export interface AppearanceProfile {
  revision: number; shellPreference: 'unset' | 'classic' | 'writer'
  colorTheme: string; zoom: number; writingFont: string; uiFont: string
  origin: 'legacy-import' | 'author'; legacyImportCompleted: boolean
}
export interface AppearanceSnapshot { profile: AppearanceProfile; skinRevision: number; backgroundSkin: string }
/** No cross-process atomic generation claim: main skin and renderer appearance retain distinct writers. */
export function mayHydrateAppearance(ready: MainReady): boolean { return ready.state === 'ready' && Boolean(ready.globalGeneration) && Number.isSafeInteger(ready.skinRevision) && ready.skinRevision >= 0 }
export interface TransferReadableAuthority {
  transferId: string; origin: ProjectEpoch; target: ProjectEpoch; snapshotGeneration: string
  domainId: string; source: FinalizedSourceIdentity; provenance: 'author' | 'derived'
  /** Exact allowed content source revalidated from restored assets, not an old execution receipt. */
  sourceCurrent: boolean; sourceUnambiguous: boolean; restoredContentHash: string
  nonReplayable: true
}
export function mayReadTransferredAuthority(receipt: TransferReadableAuthority, target: ProjectEpoch): boolean {
  return Boolean(receipt.transferId && receipt.snapshotGeneration && receipt.domainId)
    && Boolean(receipt.origin.projectId && receipt.origin.epoch) && isFinalizedSourceIdentity(receipt.source)
    && receipt.origin.projectId !== receipt.target.projectId && receipt.origin.epoch !== receipt.target.epoch
    && sameProjectEpoch(receipt.target, target) && receipt.nonReplayable === true
    && receipt.sourceCurrent && receipt.sourceUnambiguous && ['author', 'derived'].includes(receipt.provenance)
    && isContentHash(receipt.restoredContentHash) && receipt.restoredContentHash === receipt.source.contentHash
}
export interface PortableExecutionHistory {
  nonReplayable: true; originalRootActionId: string
  status: 'settled' | 'unknown' | 'pending' | 'inflight' | 'candidate'
  presentation: 'visible-history' | 'awaiting-explicit-adoption'
  /** Unknown dispatch retains its old liability; restore never releases or resends it. */
  reservedTokens: number
}
export interface PortableReceiptProjection {
  redactedProjection: Readonly<Record<string, string | number | boolean | null>>
  projectionHash: string; excludedFieldNames: readonly string[]; nonReplayable: true
  integrityScope: 'projection-only'
}
/** Imported history is not a model, formal-commit, outbox, import or publication capability. */
export function mayReplayTransferredExecution(history: PortableExecutionHistory): false {
  // Every imported execution remains non-replayable, regardless of its recorded status.
  void history
  return false
}
