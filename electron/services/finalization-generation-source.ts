import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { FinalizationGenerationContext, FinalizationGenerationSlot } from '../../src/shared/finalization-generation'
import type { FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import { composePromptSystemRole, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import { renderPrompt } from '../../src/shared/render-prompt'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { SummaryRepository } from '../repositories/summary-repository'
import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'

export function finalizationSlotKey(slot: FinalizationGenerationSlot): string {
  if (!slot || Object.keys(slot).some(key => !['source', 'stepKey'].includes(key)) || !['chapter_notes', 'character_cards'].includes(slot.stepKey)
    || !slot.source || Object.keys(slot.source).some(key => !['draftId', 'chapterNumber', 'finalizationId', 'contentHash'].includes(key))
    || !Number.isSafeInteger(slot.source.draftId) || slot.source.draftId < 1 || !Number.isSafeInteger(slot.source.chapterNumber) || slot.source.chapterNumber < 1
    || typeof slot.source.finalizationId !== 'string' || !slot.source.finalizationId.trim() || !/^[a-f0-9]{64}$/.test(slot.source.contentHash)) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
  return textHash(JSON.stringify([slot.source.draftId, slot.source.finalizationId, slot.source.chapterNumber, slot.source.contentHash, slot.stepKey]))
}
export function finalizationNotesBaseline(db: Database.Database, slot: FinalizationGenerationSlot): FinalizationGenerationContext['notesBaseline'] {
  const blueprint = db.prepare('SELECT notes FROM blueprints WHERE chapter_number=?').get(slot.source.chapterNumber) as { notes: string } | undefined
  const rows = db.prepare('SELECT chapter_number,chapter_notes,continuity_facts,source_finalization_id,source_content_hash,projection_generation FROM summary_snapshots WHERE draft_id=? ORDER BY id').all(slot.source.draftId)
  return { blueprint: { exists: !!blueprint, notes: blueprint?.notes ?? '' }, continuityHash: textHash(JSON.stringify(rows)) }
}
const immutableIdentity = (context: FinalizedCharacterContext) => ({ ...context, characters: context.characters.map(({ fields: _fields, ...identity }) => { void _fields; return identity }) })

export function captureFinalizationGenerationContext(db: Database.Database, slot: FinalizationGenerationSlot, scope: { projectId: string; epoch: string },
  writingLanguage: WritingLanguage, template: PromptTemplate, frozen?: FinalizationGenerationContext): FinalizationGenerationContext {
  finalizationSlotKey(slot)
  const identity = SummaryRepository.readFinalizedCharacterContext(slot.source.draftId, frozen?.identity ?? scope, db)
  if (!isDeepStrictEqual(identity.source, slot.source)) throw new Error('GENERATION_FINALIZATION_SOURCE_CHANGED')
  if (frozen && (!isDeepStrictEqual(slot, frozen.slot) || !isDeepStrictEqual(immutableIdentity(identity), immutableIdentity(frozen.identity)))) throw new Error('GENERATION_FINALIZATION_IDENTITY_CHANGED')
  const row = db.prepare('SELECT chapter_title FROM finalization_outbox WHERE draft_id=?').get(slot.source.draftId) as { chapter_title: string }
  const blueprint = db.prepare('SELECT characters FROM blueprints WHERE chapter_number=?').get(slot.source.chapterNumber) as { characters: string } | undefined
  return { slot: structuredClone(slot), identity: structuredClone(frozen?.identity ?? identity), chapterTitle: row.chapter_title,
    chapterEntities: JSON.parse(blueprint?.characters ?? '[]'), writingLanguage, template: structuredClone(template),
    notesBaseline: frozen?.notesBaseline ?? finalizationNotesBaseline(db, slot) }
}
export function readFinalizationGenerationContext(run: DurableGenerationRun): FinalizationGenerationContext {
  const manifest = run.binding.sourceManifest, context = manifest.finalizationGenerationContext as FinalizationGenerationContext | undefined
  if (!context || textHash(JSON.stringify(context)) !== manifest.finalizationGenerationContextHash
    || finalizationSlotKey(context.slot) !== manifest.finalizationGenerationSlotKey
    || context.identity.projectId !== run.binding.projectId || context.identity.epoch !== manifest.finalizationGenerationOriginEpoch
    || !isDeepStrictEqual(context.slot.source, context.identity.source) || textHash(context.identity.content) !== context.slot.source.contentHash
    || manifest.operation !== (context.slot.stepKey === 'chapter_notes' ? 'finalized-chapter-notes' : 'finalized-character-state')) throw new Error('GENERATION_FINALIZATION_CONTEXT_INVALID')
  return structuredClone(context)
}
export function finalizationGenerationTask(context: FinalizationGenerationContext): GenerationTask {
  const characters = context.slot.stepKey === 'character_cards'
  const contract = context.writingLanguage === 'en-US'
    ? 'Return one JSON object: {"updates":[{"characterId":"exact frozen ID","currentState":{"location":"value"},"evidence":{"text":"exact source quote"}}]}. Copy a quote that occurs exactly once in the unmodified chapter; its offsets will be calculated. If you supply start/end, they must be exact JS UTF-16 offsets. Only supplied dynamic fields are proposed. Do not infer identity from a name. Unknown or ambiguous people use name without characterId and remain proposals. Do not return static character facts or author provenance.'
    : '只返回一个 JSON 对象：{"updates":[{"characterId":"冻结名单中的精确ID","currentState":{"location":"状态值"},"evidence":{"text":"原文精确引用"}}]}。引用必须在未改写正文中仅出现一次，位置由程序精确计算；若提供 start/end，必须是准确的 JS UTF-16 位置。只提议明确返回的动态字段；不可凭名字推断身份。未知或歧义人物只返回 name、不填 characterId，保留为待确认提议。不得输出静态角色事实或作者来源。'
  const cards = context.identity.characters.map(character => ({ characterId: character.characterId, name: character.displayNameSnapshot, aliases: character.aliases,
    fields: character.fields.map(field => ({ field: field.field, value: field.value, provenance: field.provenance })) }))
  const prompt = renderPrompt(context.template, { chapter_content: context.identity.content, chapter_number: String(context.slot.source.chapterNumber), chapter_title: context.chapterTitle,
    existing_cards_json: JSON.stringify(cards, null, 2) }, context.writingLanguage)
  return { purpose: characters ? 'finalized-character-state' : 'finalized-chapter-notes', reasoningStage: 'review', output: characters ? 'structured-data' : 'visible-text',
    messages: [{ role: 'system', content: composePromptSystemRole(context.template, context.writingLanguage) }, { role: 'user', content: characters ? `${prompt}\n\n${contract}` : prompt }] }
}
