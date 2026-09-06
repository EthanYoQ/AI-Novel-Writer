import type { SourceDraftGuardErrorCode } from '../../shared/ipc-channels'
import type { Locale } from '../../i18n/types'

export const SOURCE_DRAFT_CHANGED: SourceDraftGuardErrorCode = 'SOURCE_DRAFT_CHANGED'

export class SourceDraftChangedError extends Error {
  readonly code = SOURCE_DRAFT_CHANGED

  constructor(message: string) {
    super(message)
    this.name = 'SourceDraftChangedError'
  }
}

export function throwIfSourceDraftChanged(
  result: { errorCode?: SourceDraftGuardErrorCode },
  uiLocale: Locale,
  operation: 'refine' | 'review',
): void {
  if (result.errorCode !== SOURCE_DRAFT_CHANGED) return
  if (uiLocale === 'zh-CN') {
    throw new SourceDraftChangedError(operation === 'refine'
      ? '源草稿在 AI 修稿期间已变化。修订未保存，请重新打开当前草稿后再次执行 AI 修稿。'
      : '源草稿在 AI 审稿期间已变化。审稿报告未保存，请重新打开当前草稿后再次执行 AI 审稿。')
  }
  throw new SourceDraftChangedError(operation === 'refine'
    ? 'The source draft changed during AI refinement. The revision was not saved. Reopen the current draft and run AI refinement again.'
    : 'The source draft changed during AI review. The review report was not saved. Reopen the current draft and run AI review again.')
}
