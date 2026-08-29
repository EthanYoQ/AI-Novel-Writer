import type { AuthoritativeChapterSequence } from '../shared/author-manuscript-import'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { ipc } from './ipc-client'

export class AuthoritativeChapterSequenceError extends Error {
  readonly code = 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID' as const

  constructor(
    readonly sequence: AuthoritativeChapterSequence,
    locale: WritingLanguage,
  ) {
    const gap = sequence.firstGapChapterNumber
    const duplicates = sequence.duplicateChapterNumbers
    const details = locale === 'en-US'
      ? [
          gap === undefined ? '' : `Chapter ${gap} is missing from finalized manuscript authority.`,
          duplicates.length === 0
            ? ''
            : `Finalized authority has duplicate records for Chapters ${duplicates.join(', ')}.`,
        ].filter(Boolean).join(' ')
      : [
          gap === undefined ? '' : `权威定稿缺少第 ${gap} 章。`,
          duplicates.length === 0
            ? ''
            : `权威定稿的第 ${duplicates.join('、')} 章存在重复记录。`,
        ].filter(Boolean).join('')
    super(locale === 'en-US'
      ? `${details || 'Finalized manuscript authority is inconsistent.'} Repair or remove the conflicting finalized chapters before continuing.`
      : `${details || '权威定稿状态不一致。'}请先修复或移除冲突定稿，再继续创作。`)
    this.name = 'AuthoritativeChapterSequenceError'
  }
}

/** Renderer-side single source for the next chapter after immutable finalized authority. */
export async function readAuthoritativeNextChapter(
  projectSession: ProjectSessionContext,
  locale: WritingLanguage,
): Promise<number> {
  const sequence = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-authority-sequence',
    projectSession.projectPath,
  )
  if (
    sequence.status === 'invalid'
    || !Number.isSafeInteger(sequence.nextChapterNumber)
    || (sequence.nextChapterNumber ?? 0) < 1
  ) {
    throw new AuthoritativeChapterSequenceError(sequence, locale)
  }
  return sequence.nextChapterNumber!
}
