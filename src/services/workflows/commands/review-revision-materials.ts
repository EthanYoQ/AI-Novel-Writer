import { reviewRevisionAiBrief, reviewRevisionAuthorMaterial, type ReviewRevisionContext } from '../../../shared/review-revision-generation'
import { hashAuthorText } from '../../../shared/source-ref'
import { promptLanguageText } from '../../prompt-language'
import { selectReviewRevisionMaterials, unknownReviewMaterialIdentity, type ChapterMaterialIdentity, type ReviewRevisionMaterial } from '../chapter-materials'

export function reviewHistoryMaterials(frozen: ReviewRevisionContext, current: ChapterMaterialIdentity): ReviewRevisionMaterial[] {
  const text = (zh: string, en: string) => promptLanguageText(frozen.writingLanguage, zh, en)
  return [...frozen.history, ...(frozen.predecessor ? [frozen.predecessor] : [])].map(item => ({
    identity: item.identity ?? unknownReviewMaterialIdentity(current),
    category: 'finalized-history',
    required: item.chapterNumber === frozen.source.chapterNumber - 1,
    text: [
      text(`【第${item.chapterNumber}章${item === frozen.predecessor ? '已选保存前驱｜可能含未解决问题，不覆盖作者设定' : '定稿历史'}】`,
        `[Chapter ${item.chapterNumber} ${item === frozen.predecessor ? 'selected saved predecessor | unresolved issues may remain; does not override author settings' : 'finalized history'}]`),
      item.content,
      ...(item.projection?.sourceStatus === 'current' ? (item.projection.facts ?? []).map(fact =>
        text(`- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
          `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`)) : []),
    ].join('\n'),
  }))
}

export async function selectFrozenReviewRevisionMaterials(frozen: ReviewRevisionContext, current: ChapterMaterialIdentity) {
  const author = reviewRevisionAuthorMaterial(frozen)
  const ai = reviewRevisionAiBrief(frozen)
  const materials: ReviewRevisionMaterial[] = [{ identity: { projectId: current.projectId,
    sourceId: 'author:required', revision: 1, contentHash: await hashAuthorText(author), provenance: 'author' },
  category: 'author', required: true, text: author }, ...reviewHistoryMaterials(frozen, current)]
  if (ai) materials.push({ identity: { projectId: current.projectId,
    sourceId: `review:confirmed:${frozen.confirmation!.reviewSourceId}`, revision: frozen.confirmation!.reviewSourceId,
    contentHash: await hashAuthorText(ai), provenance: 'derived' }, category: 'future-plan', required: true, text: ai })
  const blueprint = frozen.blueprints.find(item => item.chapterNumber === frozen.source.chapterNumber)
  return selectReviewRevisionMaterials({ current, writingLanguage: frozen.writingLanguage, materials,
    // Optional history keeps its local allowance; main admits the complete request including all required material.
    budgetChars: 8_000,
    relevanceTerms: [blueprint?.title ?? '', blueprint?.keyEvents ?? '', ...(blueprint?.characters ?? [])] })
}
