/** Host entry and public domain exports for the AI novel bundle. */

export { openNovelProject } from './novel-project.ts'
export type { NovelProjectOptions } from './novel-project.ts'
export { NovelProjectError } from './types.ts'
export type {
  AssetRef,
  CommitReceipt,
  CreativeStrategy,
  NovelApplyRequest,
  NovelAssetReadResult,
  NovelInitializeRequest,
  NovelProject,
  NovelProjectErrorCode,
  NovelProjectId,
  NovelQueryMatch,
  NovelQueryResult,
  NovelReadRequest,
  NovelReadResult,
  NovelReplaceRequest,
  NovelWorkingSetResult,
  Revision,
} from './types.ts'

/** Stable Host plugin name used by Cordis diagnostics. */
export const name = 'dsh-ai-novel-writer'

/**
 * Register the bundle's Host entry. The current Host entry has no runtime services.
 *
 * @returns Nothing.
 */
export function apply(): void {}
