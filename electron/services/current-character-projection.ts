import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { isFinalizedSourceIdentity } from '../../src/shared/source-ref'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from '../../src/shared/character-roster'
import type { FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const stable = (value: unknown) => JSON.stringify(value)
const without = (row: Record<string, unknown>, excluded: readonly string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.includes(key)))

const characterStateColumns: Record<CharacterStateTextField, string> = {
    location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
    mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events',
};
export function currentCharacterProjection(db: Database.Database, projectId: string, originProjectId?: string): Record<string, unknown>[] {
    const watermark = db.prepare("SELECT generation,stale_from_chapter AS staleFromChapter FROM continuity_projection_meta WHERE id='main'").get() as {
        generation: number; staleFromChapter: number | null;
    };
    const currentSources = new Map((db.prepare(`
      SELECT d.id AS draftId,d.chapter_number AS chapterNumber,d.version AS draftVersion,c.body,
             o.finalization_id AS finalizationId,o.content_hash AS contentHash,o.content_snapshot AS contentSnapshot,
             s.projection_generation AS projectionGeneration
      FROM drafts d JOIN contents c ON c.id=d.content_id JOIN finalization_outbox o ON o.draft_id=d.id
      JOIN summary_snapshots s ON s.draft_id=d.id AND s.chapter_number=d.chapter_number
        AND s.source_finalization_id=o.finalization_id AND s.source_content_hash=o.content_hash
      WHERE d.status='finalized' AND NOT EXISTS (
        SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status='finalized'
          AND (newer.version>d.version OR (newer.version=d.version AND newer.id>d.id))
      )
    `).all() as Array<FinalizedSourceIdentity & {
        body: string; contentSnapshot: string; draftVersion: number; projectionGeneration: number;
    }>).filter(row => typeof row.body === 'string' && typeof row.contentSnapshot === 'string'
        && typeof row.finalizationId === 'string' && typeof row.contentHash === 'string'
        && row.body === row.contentSnapshot && hash(row.body) === row.contentHash
        && Number.isSafeInteger(row.draftVersion) && row.draftVersion > 0
        && Number.isSafeInteger(row.projectionGeneration) && row.projectionGeneration >= 0
        && row.projectionGeneration <= watermark.generation).map(row => [
        stable([row.draftId, row.finalizationId, row.chapterNumber, row.contentHash]),
        { draftVersion: row.draftVersion, projectionGeneration: row.projectionGeneration },
    ] as const));
    const currentProjects = [projectId, originProjectId].filter((value): value is string => Boolean(value));
    return (db.prepare('SELECT * FROM characters ORDER BY character_id').all() as Record<string, unknown>[]).map(raw => {
        const row = without(raw, ['created_at', 'updated_at']);
        let provenance: Record<string, unknown> = {};
        try {
            const parsed = JSON.parse(String(row.cs_provenance || '{}')) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) provenance = parsed as Record<string, unknown>;
        } catch { /* Unproved dynamic fields are omitted from this prompt projection. */ }
        const projectedProvenance: Record<string, unknown> = {};
        for (const field of CHARACTER_STATE_TEXT_FIELDS) {
            const entry = provenance[field];
            let trusted = false;
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                const value = entry as Record<string, unknown>;
                const keys = Object.keys(value).sort();
                const safeRevision = value.revision === undefined
                    || Number.isSafeInteger(value.revision) && Number(value.revision) >= 0;
                if (value.kind === 'author') trusted = (keys.join() === 'chapterNumber,kind' || keys.join() === 'chapterNumber,kind,revision')
                    && Number.isSafeInteger(value.chapterNumber) && Number(value.chapterNumber) >= 0 && safeRevision;
                else if (value.kind === 'legacy') trusted = (keys.join() === 'kind' || keys.join() === 'kind,revision') && safeRevision;
                else if (value.kind === 'derived') {
                    const source = value.source;
                    const order = value.sourceOrder;
                    const validSource = Boolean(source && typeof source === 'object' && !Array.isArray(source)
                        && typeof (source as { finalizationId?: unknown }).finalizationId === 'string'
                        && isFinalizedSourceIdentity(source as FinalizedSourceIdentity));
                    const proof = validSource ? currentSources.get(stable([
                        (source as FinalizedSourceIdentity).draftId, (source as FinalizedSourceIdentity).finalizationId,
                        (source as FinalizedSourceIdentity).chapterNumber, (source as FinalizedSourceIdentity).contentHash,
                    ])) : undefined;
                    trusted = keys.join() === 'kind,revision,source,sourceOrder' && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
                        && Boolean(proof && order && typeof order === 'object' && !Array.isArray(order)
                            && Object.keys(order).sort().join() === 'authoritativeFinalizationRevision,chapterNumber,continuityEpoch'
                            && (order as Record<string, unknown>).chapterNumber === (source as FinalizedSourceIdentity).chapterNumber
                            && (order as Record<string, unknown>).authoritativeFinalizationRevision === proof!.draftVersion
                            && currentProjects.some(current => (order as Record<string, unknown>).continuityEpoch === `${current}:${proof!.projectionGeneration}`)
                            && !(watermark.staleFromChapter !== null
                                && (source as FinalizedSourceIdentity).chapterNumber >= watermark.staleFromChapter
                                && proof!.projectionGeneration < watermark.generation));
                }
            }
            trusted = trusted && typeof row[characterStateColumns[field]] === 'string';
            if (trusted) projectedProvenance[field] = entry;
            else delete row[characterStateColumns[field]];
        }
        if (Object.keys(projectedProvenance).length) row.cs_provenance = JSON.stringify(projectedProvenance);
        else {
            delete row.cs_provenance;
            delete row.cs_updated_at_chapter;
        }
        return row;
    });
}

/** Display-only field grant derived from the same source proof used for drafting. */
export function currentDerivedCharacterFields(db: Database.Database, projectId: string, originProjectId?: string): Record<string, CharacterStateTextField[]> {
    return Object.fromEntries(currentCharacterProjection(db, projectId, originProjectId).map(row => {
        const provenance = JSON.parse(String(row.cs_provenance || '{}')) as Record<string, { kind?: string }>;
        return [String(row.character_id), CHARACTER_STATE_TEXT_FIELDS.filter(field => provenance[field]?.kind === 'derived')];
    }));
}
