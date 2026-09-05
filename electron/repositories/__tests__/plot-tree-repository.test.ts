import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { countDraftUnits } from '../../../src/shared/draft-units'
import type { PlotTreeSnapshot } from '../../../src/shared/plot-tree'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'
import { PlotTreeRepository } from '../plot-tree-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import { SummaryRepository } from '../summary-repository'

let projectRoot = ''
const testRoot = path.resolve('.runtime/.cache/plot-tree-repository-tests')

beforeAll(() => {
  fs.mkdirSync(testRoot, { recursive: true })
  fs.writeFileSync(path.join(testRoot, '.vibe-owner.json'), JSON.stringify({
    owner: 'plot-tree-repository.test.ts',
    sourceProject: process.cwd(),
    createdAt: new Date().toISOString(),
    ttlHours: 24,
    reason: 'Owned scratch for plot-tree repository tests and red-test browser artifacts',
    cleanupCommand: "Remove-Item -LiteralPath '.runtime/.cache/plot-tree-repository-tests' -Recurse -Force",
  }, null, 2))
})

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(testRoot, 'case-'))
  initProjectDatabase(projectRoot)
  ProjectCoreRepository.init('Plot tree novel', 'en-US')
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function seedFacts() {
  const db = getProjectDb()!
  ProjectCoreRepository.update({ synopsis: 'A courier discovers that the city map is being rewritten.' })
  db.prepare(`
    INSERT INTO blueprints (
      chapter_number, title, purpose, key_events, notes, notes_updated_at
    ) VALUES (1, 'The altered map', 'Start the investigation',
      'Mara finds a street missing from every official map.',
      'Mara keeps the altered map.', datetime('now'))
  `).run()

  const finalized = FinalizedDraftImportRepository.commit(projectRoot, {
    operationId: 'plot-tree-finalized-source',
    chapters: [{
      chapterNumber: 1,
      title: 'The altered map',
      content: 'Mara folds the altered map and hides it beneath her coat.',
      wordCount: countDraftUnits('Mara folds the altered map and hides it beneath her coat.'),
    }],
  })
  const draftId = finalized.drafts[0]!.draftId
  SummaryRepository.saveFinalizedContinuity({
    draftId,
    chapterNumber: 1,
    chapterNotes: 'Mara keeps the altered map and begins investigating the erased street.',
    facts: [],
  })

  const plan = NarrativeThreadRepository.createPlan({
    title: 'The erased street',
    type: 'mystery',
    targetStartChapter: 1,
    targetEndChapter: 6,
    authorIntent: 'Reveal who removed the street in chapter six.',
  })
  const event = NarrativeThreadRepository.confirmEvent({
    planId: plan.id,
    draftId,
    type: 'planted',
    evidence: 'Mara folds the altered map',
    reason: 'The finalized chapter plants the central mystery.',
  })
  return { draftId, planId: plan.id, eventId: event.id }
}

describe('PlotTreeRepository', () => {
  it('does not treat ordinary blueprint notes as a finalized summary without extraction time', () => {
    const db = getProjectDb()!
    db.prepare(`
      INSERT INTO blueprints (chapter_number, title, purpose, key_events, notes, notes_updated_at)
      VALUES (1, 'Legacy chapter', 'Open the story', 'A clue appears.', 'Planning-only note', '')
    `).run()
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'plot-tree-finalized-without-extracted-notes',
      chapters: [{ chapterNumber: 1, title: 'Legacy chapter', content: 'Finalized text.', wordCount: 2 }],
    })

    expect(PlotTreeRepository.read().finalizedChapters[0]?.summary).toBe('')
  })

  it('keeps extracted legacy blueprint notes as a finalized-summary fallback', () => {
    const db = getProjectDb()!
    db.prepare(`
      INSERT INTO blueprints (chapter_number, title, purpose, key_events, notes, notes_updated_at)
      VALUES (1, 'Legacy chapter', 'Open the story', 'A clue appears.',
        'Extracted finalized summary', datetime('now'))
    `).run()
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'plot-tree-finalized-with-extracted-notes',
      chapters: [{ chapterNumber: 1, title: 'Legacy chapter', content: 'Finalized text.', wordCount: 2 }],
    })

    expect(PlotTreeRepository.read().finalizedChapters[0]?.summary)
      .toBe('Extracted finalized summary')
  })

  it('clears only the derived plot-tree snapshot', () => {
    seedFacts()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: sources.sourceRevision,
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    PlotTreeRepository.save(snapshot, sources.sourceRevision)

    PlotTreeRepository.clear()

    expect(PlotTreeRepository.read()).toEqual({ ...sources, snapshot: null })
  })

  it('reads the authoritative plot sources and round-trips one validated snapshot', () => {
    const ids = seedFacts()
    const sources = PlotTreeRepository.read()

    expect(sources).toMatchObject({
      writingLanguage: 'en-US',
      synopsis: { content: 'A courier discovers that the city map is being rewritten.' },
      blueprints: [{
        chapterNumber: 1,
        title: 'The altered map',
        purpose: 'Start the investigation',
        keyEvents: 'Mara finds a street missing from every official map.',
      }],
      finalizedChapters: [{
        draftId: ids.draftId,
        chapterNumber: 1,
        title: 'The altered map',
        summary: 'Mara keeps the altered map and begins investigating the erased street.',
      }],
      narrativeThreads: [expect.objectContaining({
        id: ids.planId,
        events: [expect.objectContaining({ id: ids.eventId })],
      })],
      snapshot: null,
    })
    expect(sources.sourceRevision).toMatch(/^[a-f0-9]{64}$/u)

    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: sources.sourceRevision,
      tracks: [{
        id: 'main-investigation',
        title: 'The erased street investigation',
        role: 'main',
        startChapter: 1,
        endChapter: 6,
        summary: 'Mara follows the conspiracy behind the altered city map.',
        events: [
          {
            status: 'planned',
            chapterNumber: 1,
            summary: 'Mara notices the erased street.',
            sources: [{ type: 'blueprint', chapterNumber: 1 }],
          },
          {
            status: 'occurred',
            chapterNumber: 1,
            summary: 'Mara keeps the physical evidence.',
            sources: [{ type: 'finalized-chapter', draftId: ids.draftId, chapterNumber: 1 }],
          },
          {
            status: 'occurred',
            chapterNumber: 1,
            summary: 'The central mystery is planted.',
            sources: [{
              type: 'narrative-thread',
              planId: ids.planId,
              eventId: ids.eventId,
              chapterNumber: 1,
            }],
          },
        ],
      }],
    }

    expect(PlotTreeRepository.save(snapshot, sources.sourceRevision)).toEqual(snapshot)
    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    const reopened = PlotTreeRepository.read()
    expect(reopened.sourceRevision).toBe(sources.sourceRevision)
    expect(reopened.snapshot).toEqual(snapshot)
  })

  it('keeps a supported previous-language snapshot after the project language changes', () => {
    seedFacts()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: sources.sourceRevision,
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    PlotTreeRepository.save(snapshot, sources.sourceRevision)

    ProjectCoreRepository.update({ writingLanguage: 'zh-CN' })

    const changed = PlotTreeRepository.read()
    expect(changed.writingLanguage).toBe('zh-CN')
    expect(changed.sourceRevision).not.toBe(sources.sourceRevision)
    expect(changed.snapshot).toEqual(snapshot)
    expect(() => PlotTreeRepository.save(
      { ...snapshot, sourceRevision: changed.sourceRevision },
      changed.sourceRevision,
    )).toThrow(/写作语言与当前项目不匹配/u)

    getProjectDb()!.prepare(
      "UPDATE project_core SET plot_tree_snapshot = ? WHERE id = 'main'",
    ).run(JSON.stringify({ ...snapshot, writingLanguage: 'fr-FR' }))
    expect(PlotTreeRepository.read().snapshot).toBeNull()
  })

  it('retains a valid snapshot after its referenced source is deleted', () => {
    seedFacts()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2020-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    const versionedSnapshot = { ...snapshot, sourceRevision: sources.sourceRevision }
    PlotTreeRepository.save(versionedSnapshot, sources.sourceRevision)

    getProjectDb()!.prepare('DELETE FROM blueprints WHERE chapter_number = 1').run()

    const afterDeletion = PlotTreeRepository.read()
    expect(afterDeletion.snapshot).toEqual(versionedSnapshot)
    expect(afterDeletion.sourceRevision).not.toBe(sources.sourceRevision)
  })

  it('rejects changed source content when SQLite timestamps stay in the same second', () => {
    const db = getProjectDb()!
    ProjectCoreRepository.update({ synopsis: 'A courier follows the original map.' })
    db.prepare(`
      INSERT INTO blueprints (chapter_number, title, purpose, key_events)
      VALUES (1, 'The original map', 'Start the investigation', 'Mara follows the old route.')
    `).run()
    db.prepare("UPDATE project_core SET updated_at = '2030-01-02 03:04:05' WHERE id = 'main'").run()
    db.prepare("UPDATE blueprints SET updated_at = '2030-01-02 03:04:05' WHERE chapter_number = 1").run()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: sources.sourceRevision,
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }

    db.prepare(`
      UPDATE blueprints
      SET key_events = 'Mara takes the rewritten route.', updated_at = '2030-01-02 03:04:05'
      WHERE chapter_number = 1
    `).run()
    const changedSources = PlotTreeRepository.read()
    expect(changedSources.sourceRevision).not.toBe(sources.sourceRevision)

    expect(() => PlotTreeRepository.save(snapshot, sources.sourceRevision))
      .toThrow(/生成期间已更新/u)
  })

  it('rejects a hallucinated source without replacing the last valid snapshot', () => {
    seedFacts()
    const sourceRevision = PlotTreeRepository.read().sourceRevision
    const valid: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision,
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 2,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The verified opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    PlotTreeRepository.save(valid, sourceRevision)

    expect(() => PlotTreeRepository.save({
      ...valid,
      generatedAt: '2030-01-02T04:00:00.000Z',
      tracks: [{
        ...valid.tracks[0]!,
        events: [{
          status: 'planned', chapterNumber: 2, summary: 'Invented event.',
          sources: [{ type: 'blueprint', chapterNumber: 2 }],
        }],
      }],
    }, sourceRevision)).toThrow(/source|来源/u)
    expect(PlotTreeRepository.read().snapshot).toEqual(valid)
  })

  it('rejects stale generation inputs without replacing the last snapshot', () => {
    seedFacts()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: sources.sourceRevision,
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    ProjectCoreRepository.update({ synopsis: 'The source changed while generation was running.' })
    getProjectDb()!.prepare(
      "UPDATE project_core SET updated_at = '2031-01-01 00:00:00' WHERE id = 'main'",
    ).run()

    expect(() => PlotTreeRepository.save(snapshot, sources.sourceRevision)).toThrow(/生成期间已更新/u)
    expect(PlotTreeRepository.read().snapshot).toBeNull()
  })

  it('rejects a new snapshot whose embedded source revision is not current', () => {
    seedFacts()
    const sources = PlotTreeRepository.read()
    const snapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: '0'.repeat(64),
      tracks: [{
        id: 'main', title: 'Main plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'The verified main plot.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }

    expect(() => PlotTreeRepository.save(snapshot, sources.sourceRevision))
      .toThrow(/来源版本不匹配/u)
  })

  it('keeps a structurally valid legacy snapshot without a source revision', () => {
    const legacySnapshot: PlotTreeSnapshot = {
      version: 1,
      generatedAt: '2029-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      tracks: [{
        id: 'main', title: 'Legacy plot', role: 'main', startChapter: 1, endChapter: 1,
        summary: 'A legacy snapshot remains visible until refreshed.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'The old opening.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }
    getProjectDb()!.prepare(
      "UPDATE project_core SET plot_tree_snapshot = ? WHERE id = 'main'",
    ).run(JSON.stringify(legacySnapshot))

    expect(PlotTreeRepository.read().snapshot).toEqual(legacySnapshot)
  })

  it('returns null instead of exposing a corrupt legacy snapshot', () => {
    const db = getProjectDb()!
    db.prepare(
      "UPDATE project_core SET plot_tree_snapshot = '{not-json' WHERE id = 'main'",
    ).run()

    expect(PlotTreeRepository.read().snapshot).toBeNull()

    db.prepare('UPDATE project_core SET plot_tree_snapshot = ? WHERE id = \'main\'').run(JSON.stringify({
      version: 1,
      generatedAt: '2030-01-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      tracks: [{
        id: 'main', title: 'Broken plot', role: 'main', startChapter: 2, endChapter: 1,
        summary: 'The invalid structure must stay hidden.',
        events: [{
          status: 'planned', chapterNumber: 1, summary: 'Invalid range.',
          sources: [{ type: 'blueprint', chapterNumber: 1 }],
        }],
      }],
    }))
    expect(PlotTreeRepository.read().snapshot).toBeNull()
  })
})
