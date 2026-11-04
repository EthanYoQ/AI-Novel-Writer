/**
 * 定稿序列：哪些章已定稿、中间缺了哪些、下一章是几、现在能写哪几章。
 * 主进程按定稿行算序列，渲染端按序列算可写章号，都用这里的纯函数。
 */

/** 缺口的来历。deleted：段内有章留着删除收据，是作者删掉的；unexplained：没有删除记录，多半是旧版误导入。 */
export type ChapterGapCause = 'deleted' | 'unexplained'

/** 连续缺失的一段章号，from 到 to 都没有定稿。 */
export interface ChapterGap {
  from: number
  to: number
  cause: ChapterGapCause
}

/**
 * 缺口是合法状态：作者删掉中间一章后，原位置可以重写，后面照常可写。
 * 只有同一章有多行定稿才是 invalid，这时不给下一章。
 */
export type ChapterSequence =
  | { status: 'empty'; lastChapterNumber: 0; nextChapterNumber: 1; gaps: []; duplicateChapterNumbers: [] }
  | { status: 'continuous' | 'gapped'; lastChapterNumber: number; nextChapterNumber: number; gaps: ChapterGap[]; duplicateChapterNumbers: [] }
  | { status: 'invalid'; lastChapterNumber: number; gaps: ChapterGap[]; duplicateChapterNumbers: number[] }

/** 主进程经 IPC 交给渲染端的序列，带上定稿事实的指纹，导入提交时用它判断预览是否过期。 */
export type AuthoritativeChapterSequence = ChapterSequence & { authorityFingerprint: string }

/**
 * finalizedChapterNumbers 是每一行定稿的章号（同一章多行就出现多次）；
 * deletedChapterNumbers 是留有删除收据的章号。
 */
export function chapterSequenceFrom(
  finalizedChapterNumbers: readonly number[],
  deletedChapterNumbers: ReadonlySet<number>,
): ChapterSequence {
  if (finalizedChapterNumbers.length === 0) {
    return { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, gaps: [], duplicateChapterNumbers: [] }
  }
  const counts = new Map<number, number>()
  for (const chapterNumber of finalizedChapterNumbers) counts.set(chapterNumber, (counts.get(chapterNumber) ?? 0) + 1)
  const lastChapterNumber = Math.max(...counts.keys())
  const gaps: ChapterGap[] = []
  for (let chapterNumber = 1; chapterNumber < lastChapterNumber; chapterNumber += 1) {
    if (counts.has(chapterNumber)) continue
    const open = gaps.at(-1)
    const cause: ChapterGapCause = deletedChapterNumbers.has(chapterNumber) ? 'deleted' : 'unexplained'
    if (open && open.to === chapterNumber - 1) {
      open.to = chapterNumber
      if (cause === 'deleted') open.cause = 'deleted'
    } else {
      gaps.push({ from: chapterNumber, to: chapterNumber, cause })
    }
  }
  const duplicateChapterNumbers = [...counts].filter(([, count]) => count > 1).map(([chapterNumber]) => chapterNumber)
    .sort((left, right) => left - right)
  if (duplicateChapterNumbers.length > 0) {
    return { status: 'invalid', lastChapterNumber, gaps, duplicateChapterNumbers }
  }
  return {
    status: gaps.length > 0 ? 'gapped' : 'continuous',
    lastChapterNumber,
    nextChapterNumber: lastChapterNumber + 1,
    gaps,
    duplicateChapterNumbers: [],
  }
}

/**
 * 现在能开写的章号，从小到大：每段缺口的第一章，加上下一章。
 * 段内其余章写不了：写作前置检查要求前一章已定稿（workflow-guards 的 guardChapterWriting）。
 */
export function writableChapterNumbers(sequence: Exclude<ChapterSequence, { status: 'invalid' }>): number[] {
  return [...sequence.gaps.map(gap => gap.from), sequence.nextChapterNumber]
}
