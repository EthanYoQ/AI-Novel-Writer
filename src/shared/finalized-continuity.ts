import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from './character-roster'
import type { CharacterFieldSnapshot, DerivedSourceOrder } from './character-identity'
import type { ProjectEpoch } from './source-ref'

export type FinalizedContinuityFactCategory =
  | 'character-state'
  | 'timeline'
  | 'open-thread'
  | 'plot'

/** Existing finalization receipt fields needed to bind derived material to immutable prose. */
export interface FinalizedSourceIdentity {
  draftId: number
  finalizationId: string
  chapterNumber: number
  contentHash: string
}

export type FinalizedProjectionStatus = 'current' | 'stale' | 'legacy'

export interface FinalizedSourceSnapshot {
  source: FinalizedSourceIdentity
  chapterTitle: string
  content: string
  /** Project continuity watermark frozen before semantic extraction starts. */
  projectionGeneration: number
}

export type FinalizedSourceReadResult =
  | { status: 'valid'; snapshot: FinalizedSourceSnapshot }
  | {
      status: 'legacy'
      draftId: number
      chapterNumber: number
      chapterTitle: string
      content: string
    }
  | { status: 'invalid' }

export interface FinalizedContinuityFact {
  category: FinalizedContinuityFactCategory
  entities: string[]
  statement: string
  sourceChapter: number
  evidence: string
  /** Display labels remain readable; only these proven IDs are identity references. */
  characterRefs?: FinalizedCharacterReference[]
}

export interface FinalizedCharacterReference {
  characterId: string
  displayNameSnapshot: string
}

/** A machine-derived locator only; it never becomes an author-confirmed fact. */
export interface FinalizedCharacterStateCandidate {
  /** Absent only on preserved legacy locators, never sufficient for a new write. */
  characterId?: string
  characterName: string
  field: CharacterStateTextField
  value: string
  evidence?: FinalizedCharacterEvidence
  selectionKey?: string
  displayName?: string
  rawValue?: unknown
  reason?: 'author-protected' | 'legacy-protected'
}

/** Offsets count JS UTF-16 code units in the immutable, unnormalized prose. */
export interface FinalizedCharacterEvidence { start: number; end: number; text: string }
export interface FinalizedCharacterContext extends ProjectEpoch {
  source: FinalizedSourceIdentity
  content: string
  projectionGeneration: number
  identityRevision: number
  identityStatus: 'bound' | 'legacy'
  sourceOrder: DerivedSourceOrder
  characters: Array<FinalizedCharacterReference & {
    aliases: string[]
    fields: CharacterFieldSnapshot[]
  }>
}
export type FinalizedCharacterStateValues = Partial<Record<CharacterStateTextField, string>>
export interface FinalizedCharacterStateUpdate {
  characterId: string
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
}
/** A model occurrence requiring an explicit identity decision, never an automatic merge. */
export interface FinalizedCharacterStateOccurrence {
  selectionKey: string
  displayName: string
  originalText: string
  candidateIds: string[]
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
  rawValue: unknown
  reason: 'name-only' | 'unknown-id' | 'ambiguous' | 'legacy'
}
export interface FinalizedCharacterStateResponse {
  updates: FinalizedCharacterStateUpdate[]
  unresolved: FinalizedCharacterStateOccurrence[]
}
export interface FinalizedCharacterStateCommitReceipt {
  applied: number
  unchanged: number
  candidates: FinalizedCharacterStateCandidate[]
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Main re-parses the settled artifact with its own frozen context before domain commit. */
export function parseFinalizedCharacterStateResponse(content: string, context: FinalizedCharacterContext): FinalizedCharacterStateResponse {
  const text = content.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const parsed: unknown = JSON.parse(text)
  if (!record(parsed) || !Array.isArray(parsed.updates) || parsed.updates.length > 1_000) throw new Error('FINALIZED_CHARACTER_UPDATES_INVALID')
  const result: FinalizedCharacterStateResponse = { updates: [], unresolved: [] }
  const seen = new Set<string>()
  for (const [index, input] of parsed.updates.entries()) {
    if (!record(input) || !record(input.currentState) || !record(input.evidence)) throw new Error('FINALIZED_CHARACTER_UPDATE_INVALID')
    const evidence = input.evidence
    let start = evidence.start, end = evidence.end
    if (!Object.hasOwn(evidence, 'start') && !Object.hasOwn(evidence, 'end') && typeof evidence.text === 'string' && evidence.text.length > 0) {
      const located = context.content.indexOf(evidence.text)
      if (located < 0 || context.content.indexOf(evidence.text, located + 1) !== -1) throw new Error('FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE')
      start = located; end = located + evidence.text.length
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
      || (end as number) <= (start as number) || (end as number) > context.content.length
      || typeof evidence.text !== 'string' || context.content.slice(start as number, end as number) !== evidence.text) {
      throw new Error('FINALIZED_CHARACTER_EVIDENCE_INVALID')
    }
    const currentState: FinalizedCharacterStateValues = {}
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      if (!Object.hasOwn(input.currentState, field)) continue
      if (typeof input.currentState[field] !== 'string') throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
      currentState[field] = input.currentState[field]
    }
    if (!Object.keys(currentState).length || Object.hasOwn(input.currentState, 'updatedAtChapter') && input.currentState.updatedAtChapter !== context.source.chapterNumber) {
      throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
    }
    const characterId = typeof input.characterId === 'string' ? input.characterId : ''
    const originalText = typeof input.name === 'string' ? input.name : ''
    const character = context.identityStatus === 'bound' ? context.characters.find(item => item.characterId === characterId) : undefined
    const exactEvidence = { start: start as number, end: end as number, text: evidence.text }
    // Even an explicit model ID cannot disambiguate two source characters with
    // the same frozen display label. Preserve the occurrence for author approval.
    const sharedLabel = character && context.characters.filter(item => item.displayNameSnapshot === character.displayNameSnapshot).length > 1
    if (!character || sharedLabel) {
      if (!originalText.trim() && !characterId) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      result.unresolved.push({ selectionKey: `update:${index}`, displayName: originalText.trim() ? originalText : character?.displayNameSnapshot ?? originalText, originalText,
        candidateIds: context.characters.filter(item => item.characterId === characterId || sharedLabel && item.displayNameSnapshot === character?.displayNameSnapshot
          || item.displayNameSnapshot === originalText || item.aliases.includes(originalText)).map(item => item.characterId),
        currentState, evidence: exactEvidence, rawValue: structuredClone(input),
        reason: context.identityStatus === 'legacy' ? 'legacy' : sharedLabel ? 'ambiguous' : characterId ? 'unknown-id' : 'name-only' })
      continue
    }
    if (seen.has(characterId)) throw new Error('FINALIZED_CHARACTER_DUPLICATE_ID')
    seen.add(characterId)
    result.updates.push({ characterId, currentState, evidence: exactEvidence })
  }
  return result
}

export interface FinalizedContinuityProjection {
  draftId: number
  chapterNumber: number
  chapterTitle: string
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Used only to locate the bound finalized prose, never rendered as a fact. */
  characterStateCandidates?: FinalizedCharacterStateCandidate[]
  /** Missing only for pre-v2 rows whose source cannot be safely reconstructed. */
  source?: FinalizedSourceIdentity
  /** Missing legacy callers must be treated exactly like `legacy`, never current. */
  sourceStatus?: FinalizedProjectionStatus
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}

export interface SaveFinalizedCharacterStateCandidatesRequest {
  draftId: number
  chapterNumber: number
  candidates: FinalizedCharacterStateCandidate[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}
