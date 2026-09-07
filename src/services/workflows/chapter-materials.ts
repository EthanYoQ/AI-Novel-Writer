import type { WritingLanguage } from '../../shared/writing-language'
import { promptLanguageText } from '../prompt-language'

export interface SelectedCandidateDraft {
  chapterNumber: number
  draftId: number
  version: number
  content: string
}

export interface FinalizedMaterialSource {
  chapterNumber: number
  draftId: number
  title: string
  content: string
  evidence: readonly string[]
  includeEnding?: boolean
  sourceStatus?: 'current' | 'stale' | 'legacy' | 'invalid'
  sourceIdentity?:
    | { kind: 'finalized'; finalizationId: string; contentHash: string }
    | { kind: 'legacy-finalized' }
}

export interface ChapterMaterialOmission {
  source: 'finalized' | 'candidate' | 'reference'
  chapterNumber?: number
  reason: 'evidence-not-locatable' | 'source-invalid' | 'no-relevant-passage' | 'budget'
}

export interface ChapterMaterialReference {
  readonly text: string
  readonly rendered: string
  readonly deduplicateAgainstFinalized?: boolean
}

export interface ChapterMaterialBundle {
  text: string
  previousEnding: string
  includedFinalizedFacts: number
  consumedFinalizedSources: FinalizedMaterialSource[]
  omissions: ChapterMaterialOmission[]
}

const MATERIAL_BUDGET_CHARS = 6_000
const PREVIOUS_ENDING_MAX_CHARS = 1_000

function paragraphs(content: string): string[] {
  return content.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(Boolean)
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const window of windows.sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1)
    if (!previous || window[0] > previous[1] + 1) {
      merged.push([...window])
    } else {
      previous[1] = Math.max(previous[1], window[1])
    }
  }
  return merged
}

/** Keep the hit paragraph plus one complete neighbour on each side. */
export function adjacentEvidencePassages(
  content: string,
  evidence: readonly string[],
  includeEnding = false,
): { passages: string[]; locatedEvidence: number } {
  const sourceParagraphs = paragraphs(content)
  const windows: Array<[number, number]> = []
  let locatedEvidence = 0
  for (const quote of evidence.map(value => value.trim()).filter(Boolean)) {
    const index = sourceParagraphs.findIndex(paragraph => paragraph.includes(quote))
    if (index < 0) continue
    locatedEvidence += 1
    windows.push([Math.max(0, index - 1), Math.min(sourceParagraphs.length - 1, index + 1)])
  }
  if (includeEnding && sourceParagraphs.length > 0) {
    windows.push([Math.max(0, sourceParagraphs.length - 2), sourceParagraphs.length - 1])
  }
  return {
    passages: mergeWindows(windows).map(([start, end]) => sourceParagraphs.slice(start, end + 1).join('\n\n')),
    locatedEvidence,
  }
}

export function previousChapterEnding(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= PREVIOUS_ENDING_MAX_CHARS) return trimmed

  const tail = trimmed.slice(-PREVIOUS_ENDING_MAX_CHARS)
  const firstBoundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail)
  return firstBoundary
    ? tail.slice(firstBoundary.index + firstBoundary[0].length).trim() || tail.trim()
    : tail.trim()
}

function relevantPassages(content: string, terms: readonly string[]): string[] {
  const sourceParagraphs = paragraphs(content)
  const normalizedTerms = terms.map(term => term.trim().toLocaleLowerCase()).filter(term => term.length >= 2)
  const windows: Array<[number, number]> = []
  for (let index = 0; index < sourceParagraphs.length; index += 1) {
    const value = sourceParagraphs[index].toLocaleLowerCase()
    if (normalizedTerms.some(term => value.includes(term))) {
      windows.push([Math.max(0, index - 1), Math.min(sourceParagraphs.length - 1, index + 1)])
    }
  }
  return mergeWindows(windows).slice(-2).map(([start, end]) => sourceParagraphs.slice(start, end + 1).join('\n\n'))
}

function removeContainedPassages(passages: readonly string[]): string[] {
  return passages.filter((passage, index) => !passages.some((other, otherIndex) => (
    otherIndex !== index
    && other.includes(passage)
    && (other.length > passage.length || otherIndex < index)
  )))
}

export function assembleChapterMaterials(input: {
  writingLanguage: WritingLanguage
  authorProjectFacts: readonly string[]
  characterProfiles: string
  futurePlans: string
  references: readonly ChapterMaterialReference[]
  finalized: readonly FinalizedMaterialSource[]
  candidates: readonly SelectedCandidateDraft[]
  relevanceTerms: readonly string[]
  budgetChars?: number
}): ChapterMaterialBundle {
  const omissions: ChapterMaterialOmission[] = []
  const optionalBlocks: string[] = []
  const consumedFinalizedSources: FinalizedMaterialSource[] = []
  const includedFinalizedPassages: string[] = []
  let remaining = input.budgetChars ?? MATERIAL_BUDGET_CHARS
  let includedFinalizedFacts = 0

  const includeOptional = (block: string, omission: ChapterMaterialOmission) => {
    if (!block) return false
    if (block.length > remaining) {
      omissions.push({ ...omission, reason: 'budget' })
      return false
    }
    optionalBlocks.push(block)
    remaining -= block.length
    return true
  }

  for (const source of [...input.finalized].sort((left, right) => right.chapterNumber - left.chapterNumber)) {
    if (source.sourceStatus === 'invalid') {
      omissions.push({
        source: 'finalized',
        chapterNumber: source.chapterNumber,
        reason: 'source-invalid',
      })
      continue
    }
    const passages = adjacentEvidencePassages(source.content, source.evidence, source.includeEnding)
    const expectedEvidence = source.evidence.filter(value => value.trim()).length
    let selectedPassages = passages.passages
    if (passages.locatedEvidence < expectedEvidence) {
      omissions.push({
        source: 'finalized',
        chapterNumber: source.chapterNumber,
        reason: 'evidence-not-locatable',
      })
      // A stale locator is only an index failure. Recover nearby immutable prose
      // from the same readable source using the existing deterministic term
      // matcher, while keeping the warning and never injecting the old statement.
      selectedPassages = [
        ...selectedPassages,
        ...relevantPassages(source.content, input.relevanceTerms),
      ]
    }
    selectedPassages = removeContainedPassages(selectedPassages)
    if (selectedPassages.length === 0) continue
    const included = includeOptional(promptLanguageText(
      input.writingLanguage,
      `【定稿原文 · 第${source.chapterNumber}章 · draft ${source.draftId} · 定位索引${source.sourceStatus ?? 'legacy'}】\n${selectedPassages.join('\n\n')}`,
      `[Finalized manuscript · Chapter ${source.chapterNumber} · draft ${source.draftId} · locator ${source.sourceStatus ?? 'legacy'}]\n${selectedPassages.join('\n\n')}`,
    ), { source: 'finalized', chapterNumber: source.chapterNumber, reason: 'budget' })
    if (included) {
      includedFinalizedFacts += passages.locatedEvidence
      consumedFinalizedSources.push(source)
      includedFinalizedPassages.push(...selectedPassages)
    }
  }
  // Keep newest-first budget selection, then present only the selected finalized blocks chronologically.
  optionalBlocks.reverse()

  const orderedCandidates = [...input.candidates].sort((left, right) => left.chapterNumber - right.chapterNumber)
  const latestCandidate = orderedCandidates.at(-1)
  for (const candidate of orderedCandidates) {
    const passages = candidate === latestCandidate
      ? [previousChapterEnding(candidate.content)]
      : relevantPassages(candidate.content, input.relevanceTerms)
    if (passages.length === 0) {
      omissions.push({ source: 'candidate', chapterNumber: candidate.chapterNumber, reason: 'no-relevant-passage' })
      continue
    }
    includeOptional(promptLanguageText(
      input.writingLanguage,
      `【未定稿候选 · 第${candidate.chapterNumber}章 · draft ${candidate.draftId} · v${candidate.version}】\n${passages.join('\n\n')}`,
      `[Unfinalized candidate · Chapter ${candidate.chapterNumber} · draft ${candidate.draftId} · v${candidate.version}]\n${passages.join('\n\n')}`,
    ), { source: 'candidate', chapterNumber: candidate.chapterNumber, reason: 'budget' })
  }

  for (const reference of input.references) {
    if (
      reference.deduplicateAgainstFinalized
      && reference.text.length > 0
      && includedFinalizedPassages.some(passage => passage.includes(reference.text))
    ) continue
    includeOptional(reference.rendered, { source: 'reference', reason: 'budget' })
  }

  const authorFacts = [...new Set(input.authorProjectFacts.map(value => value.trim()).filter(Boolean))]
  const required = promptLanguageText(
    input.writingLanguage,
    `【作者资料（保留原文；人物状态具有时点，不是永久约束）】\n${[...authorFacts, input.characterProfiles].filter(Boolean).join('\n\n') || '（无补充作者资料）'}\n\n【后续计划边界（只约束当前章，不是当前章任务）】\n以下保留作者后续计划原文，只用于防止本章提前执行。明确安排在后续章节的知情变化、物品转交、行动和完成状态不得前移；允许不改变这些时点的铺垫。\n${input.futurePlans}`,
    `[Author material (verbatim; character state is time-bound, not permanent)]\n${[...authorFacts, input.characterProfiles].filter(Boolean).join('\n\n') || '(no additional author material)'}\n\n[Future-plan boundary (constrains the current chapter; not a current-chapter task)]\nThe author's future plans are preserved verbatim below and only prevent premature execution in this chapter. Knowledge changes, item transfers, actions, and completed states explicitly assigned to later chapters must not be moved earlier; foreshadowing that does not change those timings is allowed.\n${input.futurePlans}`,
  )
  const sourced = promptLanguageText(
    input.writingLanguage,
    '【有来源的历史与候选】\n以下定稿原文只证明原文直接写明的内容；索引、摘要和 currentState 都不是作者事实。候选正文尚未确认，不得冒充定稿。',
    '[Sourced history and candidates]\nFinalized excerpts establish only their exact text; indexes, summaries, and currentState are not author facts. Candidate prose is unconfirmed and is not finalized history.',
  )
  const gap = omissions.length > 0
    ? promptLanguageText(
        input.writingLanguage,
        `【可选材料覆盖缺口】${omissions.map(item => `${item.source}${item.chapterNumber ? `#${item.chapterNumber}` : ''}:${item.reason}`).join('；')}`,
        `[Optional material coverage gaps] ${omissions.map(item => `${item.source}${item.chapterNumber ? `#${item.chapterNumber}` : ''}:${item.reason}`).join('; ')}`,
      )
    : ''

  const endingSource = latestCandidate
    ? undefined
    : input.finalized.find(source => source.includeEnding && source.content.trim())
  if (endingSource && !consumedFinalizedSources.some(source => source.draftId === endingSource.draftId)) {
    // The ending also affects replay rejection even when its prompt block exceeded the budget.
    consumedFinalizedSources.push(endingSource)
  }

  return {
    text: [required, sourced, ...optionalBlocks, gap].filter(Boolean).join('\n\n'),
    previousEnding: latestCandidate
      ? previousChapterEnding(latestCandidate.content)
      : previousChapterEnding(input.finalized.find(source => source.includeEnding)?.content ?? ''),
    includedFinalizedFacts,
    consumedFinalizedSources,
    omissions,
  }
}
