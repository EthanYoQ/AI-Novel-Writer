import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { LegacyRosterGenerationContext } from '../../src/shared/legacy-roster-generation'
import { buildLegacyRosterTask } from '../../src/shared/legacy-roster-generation-pure'
import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { captureLegacyRosterContext } from './legacy-roster-source'

export function captureLegacyRosterGenerationContext(db: Database.Database, scope: { projectId: string; epoch: string }, key: string,
  previous?: LegacyRosterGenerationContext): LegacyRosterGenerationContext {
  if (!key || !scope.projectId || !scope.epoch || previous && (previous.projectId !== scope.projectId || previous.key !== key || !previous.originEpoch || !previous.createdAt)) throw new Error('GENERATION_LEGACY_CONTEXT_INVALID')
  return { projectId: scope.projectId, originEpoch: previous?.originEpoch ?? scope.epoch, key,
    createdAt: previous?.createdAt ?? new Date().toISOString(), source: captureLegacyRosterContext(db) }
}
export function legacyRosterGenerationTask(context: LegacyRosterGenerationContext) {
  return buildLegacyRosterTask({ legacyMarkdown: context.source.rawLegacy, genre: context.source.genre })
}
export function readLegacyRosterGenerationContext(run: DurableGenerationRun): LegacyRosterGenerationContext {
  const manifest = run.binding.sourceManifest, context = manifest.legacyRosterContext as LegacyRosterGenerationContext | undefined
  if (!context || context.projectId !== run.binding.projectId || !context.key || !context.createdAt || !context.originEpoch
    || manifest.operation !== 'legacy-character-roster-repair' || manifest.legacyRosterKey !== context.key || manifest.legacyRosterOriginEpoch !== context.originEpoch
    || manifest.legacyRosterContextHash !== textHash(JSON.stringify(context)) || !context.source || context.source.legacyHash !== textHash(context.source.rawLegacy)
    || context.source.snapshot.migrationState !== 'legacy_markdown_pending' || context.source.snapshot.status !== 'legacy_repair_required'
    || context.source.activeIds.length || context.source.snapshot.entries.length || context.source.snapshot.legacyMarkdown !== context.source.rawLegacy) throw new Error('GENERATION_LEGACY_CONTEXT_INVALID')
  if (!isDeepStrictEqual(manifest.legacyRosterTask, legacyRosterGenerationTask(context))
    || manifest.legacyRosterTaskHash !== textHash(JSON.stringify(manifest.legacyRosterTask))) throw new Error('GENERATION_LEGACY_TASK_INVALID')
  return structuredClone(context)
}
