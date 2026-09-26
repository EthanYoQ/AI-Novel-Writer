import type { FinalizedCharacterContext, FinalizedContinuityFact, FinalizedContinuityFactCategory } from './finalized-continuity'

const CONTINUITY_FACT_LIMIT = 12
const CONTINUITY_STATEMENT_LIMIT = 280
const CONTINUITY_EVIDENCE_LIMIT = 240

function factCategory(statement: string): FinalizedContinuityFactCategory {
  if (/(?:角色|状态|持有|受伤|位于|死亡|身亡|牺牲|去世|character|holds?|injur|location|dead|died|deceased)/iu.test(statement)) return 'character-state'
  if (/(?:时间|当日|翌日|多年|之前|之后|timeline|before|after|years?)/iu.test(statement)) return 'timeline'
  if (/(?:伏笔|悬念|承诺|未解|线索|promise|unresolved|clue|mystery)/iu.test(statement)) return 'open-thread'
  return 'plot'
}

function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(groups.flatMap((group) => {
    const characters = [...group]
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
  }))
}

function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  const factEntities = entities.filter(entity => statement.includes(entity))
  const statementWithoutEntities = [...factEntities]
    .sort((left, right) => right.length - left.length)
    .reduce((text, entity) => text.split(entity).join(' '), statement)
  const signals = textBigrams(statementWithoutEntities)
  const signalList = [...signals]
  const candidates = factEntities.length > 0
    ? sentences.filter(sentence => factEntities.some(entity => sentence.includes(entity)))
    : sentences
  const ranked = candidates
    .map((sentence) => {
      const sentenceSignals = textBigrams(sentence)
      const matchedIndexes = signalList
        .map((signal, index) => sentenceSignals.has(signal) ? index : -1)
        .filter(index => index >= 0)
      const independentlySupported = matchedIndexes.some((index, matchIndex) => (
        matchIndex > 0 && index - matchedIndexes[matchIndex - 1] > 1
      ))
      return {
        sentence,
        score: matchedIndexes.length,
        supported: matchedIndexes.length === signalList.length || independentlySupported,
      }
    })
    .sort((left, right) => right.score - left.score)
  const minimumScore = factEntities.length > 0 ? 1 : 2
  const matched = ranked.find(candidate => candidate.score >= minimumScore && candidate.supported)?.sentence
  return (matched ?? '').slice(0, CONTINUITY_EVIDENCE_LIMIT).trim()
}

export function buildFinalizedContinuityFacts(
  chapterNumber: number,
  chapterNotes: string,
  finalizedContent: string,
  chapterEntities: readonly string[] = [],
  identityContext?: FinalizedCharacterContext,
): FinalizedContinuityFact[] {
  const entities = [...new Set([...chapterEntities, ...(identityContext?.characters.map(item => item.displayNameSnapshot) ?? [])].map(entity => entity.trim()).filter(Boolean))].slice(0, 8)
  const statements = chapterNotes
    .split(/\n+|(?<=[。！？.!?])\s*/u)
    .map(statement => statement.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim())
    .filter(Boolean)
  return statements.flatMap(statement => {
    const factEntities = entities.filter(entity => statement.includes(entity))
    const evidence = evidenceExcerpt(finalizedContent, statement, factEntities)
    const characterRefs = identityContext ? factEntities.flatMap(entity => {
      const candidates = identityContext.characters.filter(item => item.displayNameSnapshot === entity)
      return candidates.length === 1 ? [{ characterId: candidates[0].characterId, displayNameSnapshot: candidates[0].displayNameSnapshot }] : []
    }) : undefined
    if (identityContext && factEntities.some(entity => identityContext.characters.filter(item => item.displayNameSnapshot === entity).length > 1)) return []
    return evidence
      ? [{
          category: factCategory(statement),
          entities: factEntities,
          statement: statement.slice(0, CONTINUITY_STATEMENT_LIMIT),
          sourceChapter: chapterNumber,
          evidence,
          ...(characterRefs ? { characterRefs } : {}),
        }]
      : []
  }).slice(0, CONTINUITY_FACT_LIMIT)
}
