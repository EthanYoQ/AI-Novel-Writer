import {
  writableChapterNumbers,
  type AuthoritativeChapterSequence,
  type ChapterGap,
} from '../shared/chapter-sequence'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { ipc } from './ipc-client'

/** 同一章有多行定稿时，下一章无从确定。 */
export class AuthoritativeChapterSequenceError extends Error {
  readonly code = 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID' as const

  constructor(
    readonly sequence: AuthoritativeChapterSequence,
    locale: WritingLanguage,
  ) {
    const duplicates = sequence.duplicateChapterNumbers
    super(locale === 'en-US'
      ? `Finalized authority has duplicate records for Chapters ${duplicates.join(', ')}. Repair or remove the conflicting finalized chapters before continuing.`
      : `权威定稿的第 ${duplicates.join('、')} 章存在重复记录。请先修复或移除冲突定稿，再继续创作。`)
    this.name = 'AuthoritativeChapterSequenceError'
  }
}

export interface WritableChapters {
  /** 追加类入口（批量、新建章节、蓝图生成、导入）从这一章往后接，不往缺口里填。 */
  next: number
  gaps: ChapterGap[]
  /** 现在能开写的章号，从小到大：每段缺口的第一章，加上 next。 */
  writable: number[]
}

/** 渲染端读取定稿序列的唯一入口。缺口是合法状态；只有重复定稿时抛 AuthoritativeChapterSequenceError。 */
export async function readWritableChapters(
  projectSession: ProjectSessionContext,
  locale: WritingLanguage,
): Promise<WritableChapters> {
  const sequence = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-authority-sequence',
    projectSession.projectPath,
  )
  if (sequence.status === 'invalid') throw new AuthoritativeChapterSequenceError(sequence, locale)
  return { next: sequence.nextChapterNumber, gaps: sequence.gaps, writable: writableChapterNumbers(sequence) }
}
