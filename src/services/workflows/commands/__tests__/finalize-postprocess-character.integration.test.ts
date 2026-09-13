import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../../../../electron/database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../../../test/helpers/canonical-project-fixture'
import { CharacterRepository } from '../../../../../electron/repositories/character-repository'
import { CharacterRosterRepository, commitCharacterIdentities, refreshCharacterIdentityProjection } from '../../../../../electron/repositories/character-roster-repository'
import { PostProcessRepository } from '../../../../../electron/repositories/post-process-repository'
import { ProjectCoreRepository } from '../../../../../electron/repositories/project-core-repository'
import {
  invalidateContinuityProjectionFrom,
  freezeFinalizedCharacterSnapshot,
  SummaryRepository,
} from '../../../../../electron/repositories/summary-repository'
import type {
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from '../../../../shared/finalized-continuity'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../../../shared/finalized-continuity'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'
import type { CharacterRosterCommitRequest } from '../../../../shared/character-roster'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { RunFinalizePostProcessCommand } from '../finalize-chapter.command'
import { GenerateDraftCommand } from '../generate-draft.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

let projectPath = ''
let cardResponse = '{"updates":[]}'
let workflowContext: WorkflowContext
let observedCharacterPrompt = ''
let observedChapterNotesPrompt = ''
let characterId = ''
let runtimeSequence = 0
const contexts = new Map<string, FinalizedCharacterContext>()
const artifacts = new Map<string, string>()
const selections: unknown[] = []
const commitRequests: unknown[] = []
let commitFailures = 0
let changeFieldBeforeCommit = false
const mainRuntimeDependencies: WorkflowGenerationRuntimeDependencies = {
  async createRuntime(options, main) {
    if (!main) throw new Error('fixture main selection required')
    const runtime = await workflowRuntimeDependencies.createRuntime(options)
    const select = (selection: unknown) => {
      selections.push(selection)
      const handle = { projectId: 'test', epoch: 'lease-test', rootActionId: 'fixture-root', runId: 'fixture-run-' + (++runtimeSequence) }
      main.context.mainGenerationRunHandle = handle
      main.context.mainGenerationRootHandle = handle
    }
    select(main.selection)
    return { mainOwned: true, advance: async (selection: unknown) => { select(selection) }, close: () => runtime.close(),
      execute: operation => runtime.execute(({ session }) => operation({ session: { budget: session.budget,
        complete: async (task, options) => {
          const outcome = await session.complete(task, options)
          const artifactId = 'fixture-artifact-' + (++runtimeSequence)
          artifacts.set(artifactId, outcome.content)
          return { ...outcome, receipt: { ...outcome.receipt, visibleArtifact: { artifactId, attemptId: artifactId,
            revision: 1, textHash: createHash('sha256').update(outcome.content).digest('hex') } } }
        },
      } })),
    }
  },
}
// The deterministic model double explicitly emits the seeded ID and UTF-16 evidence.
// The production parser is never allowed to infer this mapping from a name.
function modelFixtureResponse(content: string) {
  let parsed: { updates?: Array<Record<string, unknown>> }
  try { parsed = JSON.parse(content) } catch { return content }
  if (!Array.isArray(parsed.updates)) return content
  const source = SummaryRepository.readFinalizedSource(7)
  if (source.status !== 'valid') throw new Error('fixture source missing')
  return JSON.stringify({ ...parsed, updates: parsed.updates.map(update => ({ ...update,
    ...(typeof update.name === 'string' && update.name.trim().toLowerCase() === 'lin lan' ? { characterId } : {}),
    evidence: { start: 0, end: source.snapshot.content.length, text: source.snapshot.content },
  })) })
}

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function initialRosterRequest(): CharacterRosterCommitRequest {
  return {
    operationId: 'initial-roster',
    expectedRevision: 0,
    schemaVersion: 1,
    entries: [{
      name: 'Lin Lan',
      role: 'protagonist',
      gender: 'female',
      age: '29',
      appearance: 'author-written silver coat',
      personality: 'careful',
      background: 'author-written courier history',
      abilities: 'navigation',
      motivation: 'protect the archive',
      relationships: [],
      arc: 'learns to delegate',
      notes: 'author static note',
      currentState: {
        location: 'old station',
        powerLevel: 'ordinary',
        physicalState: 'tired',
        mentalState: 'alert',
        keyItems: 'brass key',
        recentEvents: 'found the sealed map',
        updatedAtChapter: 1,
        provenance: {
          location: {
            kind: 'derived',
            source: {
              draftId: 1,
              finalizationId: 'finalization-1',
              chapterNumber: 1,
              contentHash: '1'.repeat(64),
            },
          },
          recentEvents: {
            kind: 'derived',
            source: {
              draftId: 1,
              finalizationId: 'finalization-1',
              chapterNumber: 1,
              contentHash: '1'.repeat(64),
            },
          },
          keyItems: { kind: 'author', chapterNumber: 1 },
        },
      },
    }],
  }
}

function insertFinalizedDraft(
  draftId: number,
  chapterNumber: number,
  content = `Chapter ${chapterNumber} finalized content`,
): void {
  const db = getProjectDb()!
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
  const existing = db.prepare('SELECT content_id AS contentId FROM drafts WHERE id = ?')
    .get(draftId) as { contentId: number } | undefined
  if (existing) {
    db.prepare('UPDATE contents SET body = ? WHERE id = ?').run(content, existing.contentId)
    db.prepare(`
      UPDATE finalization_outbox
      SET content_hash = ?, content_snapshot = ?
      WHERE draft_id = ?
    `).run(contentHash, content, draftId)
    return
  }
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)')
    .run(draftId, content)
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
    VALUES (?, ?, 1, 'finalized', ?, 0)
  `).run(draftId, chapterNumber, draftId)
  db.prepare(`
    INSERT INTO finalization_outbox (
      finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, content_snapshot, target_file_name, publication_status
    ) VALUES (?, ?, ?, '', ?, 0, ?, ?, 'published')
  `).run(`finalization-${draftId}`, draftId, chapterNumber, contentHash, content, `chapter-${chapterNumber}.txt`)
}

function installRealRepositoryIpc(): void {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: async (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'finalized-character:read-context': {
            const draftId = (args[0] as { draftId: number }).draftId
            const context = SummaryRepository.readFinalizedCharacterContext(draftId, { projectId: 'test', epoch: 'lease-test' })
            const contextId = 'fixture-context-' + (contexts.size + 1)
            contexts.set(contextId, context)
            return { contextId, context }
          }
          case 'finalized-character:commit': {
            commitRequests.push(structuredClone(args[0]))
            if (commitFailures-- > 0) throw new Error('network error: synthetic temporary commit failure')
            if (changeFieldBeforeCommit) {
              changeFieldBeforeCommit = false
              getProjectDb()!.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后来设置', characterId)
            }
            const request = args[0] as { contextId: string; artifact: { artifactId: string; textHash: string } }
            const context = contexts.get(request.contextId)!, content = artifacts.get(request.artifact.artifactId)!
            if (createHash('sha256').update(content).digest('hex') !== request.artifact.textHash) throw new Error('fixture artifact changed')
            const parsed = parseFinalizedCharacterStateResponse(content, context)
            return { ...SummaryRepository.commitFinalizedCharacterStates(context, parsed), unresolved: parsed.unresolved,
              ...(parsed.unresolved.length ? { proposalBatchId: 'fixture-pending-proposal' } : {}) }
          }
          case 'prompt:load-global':
            return { templates: [], diagnostics: [] }
          case 'fs:check-exists':
            return false
          case 'db:draft-get-latest':
            return null
          case 'kb:import-text':
            return { success: true, chunkCount: 1, docId: 'doc-1' }
          case 'db:finalization-link-knowledge-document':
            return { success: true }
          case 'db:continuity-save-finalized':
            try {
              SummaryRepository.saveFinalizedContinuity(args[0] as SaveFinalizedContinuityRequest)
              return { success: true }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:continuity-save-character-state-candidates':
            try {
              SummaryRepository.saveFinalizedCharacterStateCandidates(
                args[0] as SaveFinalizedCharacterStateCandidatesRequest,
              )
              return { success: true }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:continuity-read-source':
            return SummaryRepository.readFinalizedSource(Number(args[0]))
          case 'db:blueprint-update-notes':
            return { success: true, updated: false }
          case 'db:project-core-get':
            return ProjectCoreRepository.get()
          case 'db:character-get-all':
            return CharacterRepository.getAll()
          case 'fs:list-dir':
          case 'db:blueprint-get-all':
          case 'db:narrative-thread-list-relevant':
            return []
          case 'db:continuity-list-before':
            return SummaryRepository.listFinalizedContinuityBefore(Number(args[0]))
          case 'kb:search-writing-context':
            return { success: true, value: [] }
          case 'db:blueprint-get':
            return null
          case 'db:draft-get-finalized':
            return getProjectDb()?.prepare(`
              SELECT id FROM drafts
              WHERE chapter_number = ? AND status = 'finalized'
              ORDER BY version DESC, id DESC LIMIT 1
            `).get(Number(args[0])) ?? null
          case 'db:character-roster-read':
            return CharacterRosterRepository.read()
          case 'db:character-roster-commit':
            try {
              return {
                success: true,
                receipt: CharacterRosterRepository.commit(args[0] as CharacterRosterCommitRequest),
              }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:post-process-get-latest-run':
            return PostProcessRepository.getLatestRun(String(args[0]), String(args[1]))
          case 'db:post-process-create-run':
            return {
              success: true,
              id: PostProcessRepository.createRun(args[0] as Parameters<typeof PostProcessRepository.createRun>[0]),
            }
          case 'db:post-process-get-steps':
            return PostProcessRepository.getSteps(String(args[0]))
          case 'db:post-process-mark-step-ok':
            PostProcessRepository.markStepOk(String(args[0]), String(args[1]))
            return { success: true }
          case 'db:post-process-mark-step-failed':
            PostProcessRepository.markStepFailed(String(args[0]), String(args[1]), String(args[2]))
            return { success: true }
          default:
            throw new Error(`unexpected IPC: ${channel}`)
        }
      },
    },
  })
}

function installModel(): void {
  useLLMStore.setState({
    defaultModelId: 'test-model',
    generateStream: vi.fn(async (messages, streamCallbacks) => {
      const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
      if (system.includes('character records') || system.includes('角色档案')) {
        observedCharacterPrompt = messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? ''
        streamCallbacks.onDone?.(modelFixtureResponse(cardResponse), undefined, 'stop')
      } else {
        observedChapterNotesPrompt = messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? ''
        streamCallbacks.onDone?.('Lin Lan hands the brass key to Zhou Yan.', undefined, 'stop')
      }
      return `request-${Date.now()}`
    }),
  })
}

function command(draftContent: string, overrides: { onlyFailed?: boolean; stepKey?: string } = {}) {
  insertFinalizedDraft(7, 2, draftContent)
  const db = getProjectDb()!
  if (!db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get('fcs:finalization-7')) {
    db.transaction(() => freezeFinalizedCharacterSnapshot(db, { draftId: 7, finalizationId: 'finalization-7', chapterNumber: 2,
      contentHash: createHash('sha256').update(draftContent).digest('hex') }))()
  }
  return new RunFinalizePostProcessCommand({
    project: { path: projectPath },
    chapterNumber: 2,
    chapterTitle: 'The Handoff',
    draftContent,
    draftId: 7,
    finalizedSource: {
      draftId: 7,
      finalizationId: 'finalization-7',
      chapterNumber: 2,
      contentHash: createHash('sha256').update(draftContent, 'utf8').digest('hex'),
    },
    sourceLabel: 'Chapter 2 finalization',
    ...overrides,
  }, mainRuntimeDependencies)
}

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/s09b-finalize-consumer')
  fs.mkdirSync(cache, { recursive: true })
  projectPath = fs.mkdtempSync(path.join(cache, 'case-'))
  contexts.clear(); artifacts.clear(); selections.length = 0; commitRequests.length = 0; runtimeSequence = 0; commitFailures = 0; changeFieldBeforeCommit = false
  initProjectDatabase(projectPath)
  const db = CharacterRosterRepository.read()
  expect(db.status).toBe('empty')
  const projectDb = getProjectDb()
  projectDb?.prepare("INSERT OR IGNORE INTO project_core (id, project_name, writing_language) VALUES ('main', 'Test', 'en-US')").run()
  const entry = initialRosterRequest().entries[0]
  const { currentState, relationships: _relationships, ...fields } = entry
  void _relationships
  const receipt = commitCharacterIdentities(projectDb!, { approval: { operationId: 'initial-roster', expectedRevision: 0,
    action: 'author-edit', source: { kind: 'author', source: { projectId: 'test', epoch: 'lease-test', sourceId: 'author-fixture', revision: 0, contentHash: 'a'.repeat(64) } } },
    creations: [{ selectionKey: 'initial', fields }], changes: [], retireIds: [], relationships: [], resolutions: [] }, () => true)
  characterId = receipt.created[0].characterId
  const provenance = Object.fromEntries(Object.entries(currentState!.provenance!).map(([field, source]) => [field,
    { ...source, revision: 1, ...(source.kind === 'derived' ? { sourceOrder: { continuityEpoch: 'test:0', chapterNumber: 1, authoritativeFinalizationRevision: 1 } } : {}) }]))
  projectDb!.prepare('UPDATE characters SET cs_location=?,cs_power_level=?,cs_physical_state=?,cs_mental_state=?,cs_key_items=?,cs_recent_events=?,cs_updated_at_chapter=?,cs_provenance=? WHERE character_id=?')
    .run(currentState!.location,currentState!.powerLevel,currentState!.physicalState,currentState!.mentalState,currentState!.keyItems,currentState!.recentEvents,1,JSON.stringify(provenance),characterId)
  projectDb!.transaction(() => refreshCharacterIdentityProjection(projectDb!))()
  workflowContext = {
    runId: 'finalize-character-run',
    projectPath,
    projectSession: { projectId: 'test', leaseId: 'lease-test', projectPath },
    writingLanguage: 'en-US',
    uiLocale: 'en-US',
    data: {},
    cancelled: false,
  }
  useProjectStore.setState({
    currentProject: {
      id: 'test',
      sessionLease: 'lease-test',
      name: 'Test',
      path: projectPath,
      novelConfig: { writingLanguage: 'en-US', wordsPerChapter: 3000 },
    } as never,
  })
  cardResponse = '{"updates":[]}'
  observedCharacterPrompt = ''
  observedChapterNotesPrompt = ''
  installRealRepositoryIpc()
  installModel()
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: null })
})

describe('RunFinalizePostProcessCommand character-state persistence', () => {
  it('rejects a later-chapter summary whose frozen generation changed during the model call', async () => {
    const content = 'Chapter 2 finalized content'
    insertFinalizedDraft(7, 2, content)
    const initialSource = SummaryRepository.readFinalizedSource(7)
    if (initialSource.status !== 'valid') throw new Error('expected valid finalized source')
    SummaryRepository.saveFinalizedContinuity({
      draftId: 7,
      chapterNumber: 2,
      chapterNotes: 'Existing projection remains available only as stale material.',
      facts: [],
      projectionGeneration: initialSource.snapshot.projectionGeneration,
      source: initialSource.snapshot.source,
    })

    let invalidatedDuringNotes = false
    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        if (!invalidatedDuringNotes) {
          invalidateContinuityProjectionFrom(getProjectDb()!, 1)
          invalidatedDuringNotes = true
          streamCallbacks.onDone?.('Stale in-flight notes must not be saved.', undefined, 'stop')
        } else {
          streamCallbacks.onDone?.('{"updates":[]}', undefined, 'stop')
        }
        return 'request-stale-generation'
      }),
    })

    const staleRun = await command(content).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })
    expect(invalidatedDuringNotes).toBe(true)
    expect(staleRun.steps.chapter_notes).toMatchObject({
      ok: false,
      error: expect.stringContaining('失效水位已推进'),
    })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: 'Existing projection remains available only as stale material.',
      sourceStatus: 'stale',
    })

    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('Fresh notes use the advanced generation.', undefined, 'stop')
        return 'request-fresh-generation'
      }),
    })
    const freshRun = await command(content, {
      onlyFailed: true,
      stepKey: 'chapter_notes',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(freshRun.steps.chapter_notes).toMatchObject({ ok: true })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: 'Fresh notes use the advanced generation.',
      sourceStatus: 'current',
    })
  })

  it.each([
    ['missing updates', '{}', 'UPDATES'],
    ['non-array updates', '{"updates":{}}', 'UPDATES'],
    ['invalid member state', '{"updates":[{"name":"Lin Lan","currentState":{"location":7}}]}', 'FIELD'],
    ['duplicate identity', '{"updates":[{"name":"Lin Lan","currentState":{"location":"harbor"}},{"name":" lin lan ","currentState":{"location":"station"}}]}', 'DUPLICATE_ID'],
  ])('records %s as a retryable failed step without changing the real roster', async (_label, response, errorFragment) => {
    cardResponse = response

    const status = await command('A complete finalized chapter.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({
      ok: false,
      attemptCount: 1,
      error: expect.stringContaining(errorFragment),
    })
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '2')).not.toBeNull()
    expect(PostProcessRepository.getSteps(
      PostProcessRepository.getLatestRun('chapter_finalize', '2')!.id,
    ).find(step => step.stepKey === 'character_cards')).toMatchObject({ ok: false, attemptCount: 1 })
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 1,
      entries: [expect.objectContaining({
        name: 'Lin Lan',
        currentState: expect.objectContaining({ keyItems: 'brass key' }),
      })],
    })
  })

  it('covers the full finalized source and atomically persists one valid state change', async () => {
    insertFinalizedDraft(7, 2)
    const draftContent = Array.from({ length: 2350 }, (_, index) => {
      if (index === 0) return 'HEAD_FACT'
      if (index === 1175) return 'MIDDLE_ONLY_HANDOFF_FACT_LIN_LAN_GIVES_BRASS_KEY_TO_ZHOU_YAN'
      if (index === 2349) return 'TAIL_FACT'
      return `word${index}`
    }).join(' ')
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          location: 'harbor',
          keyItems: '',
          recentEvents: 'handed the brass key to Zhou Yan',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command(draftContent).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(observedCharacterPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(
      'an explicitly stated cause, location, witness, or source of knowledge',
    )
    expect(observedChapterNotesPrompt).toContain(
      'Do not infer missing details or require every note to contain all of these elements',
    )
    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(selections).toMatchObject([
      { operation: 'finalized-chapter-notes', selectedFinalizedDraftIds: [7], selectedDraftIds: [] },
      { operation: 'finalized-character-state', selectedFinalizedDraftIds: [7], selectedDraftIds: [], output: 'structured-data',
        finalizedCharacterContextId: 'fixture-context-2',
        authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(contexts.get('fixture-context-2')) }] },
    ])
    expect(commitRequests).toEqual([{ contextId: 'fixture-context-2',
      handle: { projectId: 'test', epoch: 'lease-test', rootActionId: 'fixture-root', runId: 'fixture-run-3' },
      artifact: { artifactId: 'fixture-artifact-4', revision: 1, textHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }])
    expect(CharacterRepository.getById(characterId)).toMatchObject({
      appearance: 'author-written silver coat',
      notes: 'author static note',
      currentState: {
        location: 'harbor',
        powerLevel: 'ordinary',
        physicalState: 'tired',
        mentalState: 'alert',
        keyItems: 'brass key',
        recentEvents: 'handed the brass key to Zhou Yan',
        updatedAtChapter: 2,
      },
    })
    expect(CharacterRosterRepository.read().revision).toBe(2)

    let nextChapterPrompt = ''
    const draftDependencies = {
      createRuntime: async () => ({
        execute: async (operation: (scope: { session: unknown }) => Promise<unknown>) => operation({
          session: {
            budget: {},
            complete: async (task: { messages: Array<{ role: string; content: string }> }) => {
              nextChapterPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
              throw new Error('next-chapter-prompt-captured')
            },
          },
        }),
        close: async () => {},
      }),
    }
    await expect(new GenerateDraftCommand({
      projectPath,
      chapterNumber: 3,
      title: 'After the Handoff',
      role: 'development',
      purpose: 'continue after the handoff',
      keyEvents: 'Zhou Yan leaves with the key',
      characters: ['Lin Lan'],
      userGuidance: '',
      wordsTarget: 100,
    }, { dependencies: draftDependencies as never }).execute({
      step: {},
      context: { ...workflowContext, runId: 'next-chapter-probe' },
      callbacks: { ...callbacks(), replaceText: vi.fn() },
    })).rejects.toThrow('next-chapter-prompt-captured')
    expect(nextChapterPrompt).toContain('Lin Lan (protagonist)')
    expect(nextChapterPrompt).toContain('keyItems@chapter1: brass key')
    expect(nextChapterPrompt).not.toContain('handed the brass key to Zhou Yan')
  })

  it('keeps protected author and legacy state while retaining source-only lookup candidates', async () => {
    const draftContent = [
      'Lin Lan places the brass key in Zhou Yan\'s palm at New Harbor.',
      '',
      'She checks the tide ledger before dawn.',
    ].join('\n')
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          keyItems: '',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command(draftContent).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(CharacterRepository.getById(characterId)?.currentState).toMatchObject({
      keyItems: 'brass key',
    })
    expect(CharacterRosterRepository.read().revision).toBe(1)
    const frozenSource = SummaryRepository.readFinalizedSource(7)
    if (frozenSource.status !== 'valid') throw new Error('expected valid finalized source')
    SummaryRepository.saveFinalizedContinuity({
      draftId: 7,
      chapterNumber: 2,
      chapterNotes: 'The locator candidate remains separate from confirmed continuity facts.',
      facts: [],
      projectionGeneration: frozenSource.snapshot.projectionGeneration,
      source: frozenSource.snapshot.source,
    })
    const projection = SummaryRepository.listFinalizedContinuityBefore(3)[0]!
    expect(projection.facts).toEqual([])
    expect(projection.characterStateCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        characterName: 'Lin Lan',
        field: 'keyItems',
        value: '',
      }),
    ]))
    insertFinalizedDraft(8, 3, 'Chapter 3 ends with Lin Lan opening the tide ledger before dawn.')

    let nextChapterPrompt = ''
    const draftDependencies = {
      createRuntime: async () => ({
        execute: async (operation: (scope: { session: unknown }) => Promise<unknown>) => operation({
          session: {
            budget: {},
            complete: async (task: { messages: Array<{ role: string; content: string }> }) => {
              nextChapterPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
              throw new Error('candidate-source-prompt-captured')
            },
          },
        }),
        close: async () => {},
      }),
    }
    await expect(new GenerateDraftCommand({
      projectPath,
      chapterNumber: 4,
      title: 'Before Dawn',
      role: 'development',
      purpose: 'continue the tide investigation',
      keyEvents: 'Lin Lan reads the ledger two chapters after the handoff',
      characters: ['Lin Lan'],
      userGuidance: '',
      wordsTarget: 100,
    }, { dependencies: draftDependencies as never }).execute({
      step: {},
      context: { ...workflowContext, runId: 'candidate-source-probe' },
      callbacks: { ...callbacks(), replaceText: vi.fn() },
    })).rejects.toThrow('candidate-source-prompt-captured')
    expect(nextChapterPrompt).toContain('Lin Lan places the brass key in Zhou Yan\'s palm at New Harbor.')
    expect(nextChapterPrompt).toContain('keyItems@chapter1: brass key')
    expect(nextChapterPrompt).not.toContain('"field":"keyItems"')
    expect(nextChapterPrompt).not.toContain('finalized#2:evidence-not-locatable')
  })

  it('rejects an older Chinese chapter retry after a newer character state is committed', async () => {
    workflowContext.writingLanguage = 'zh-CN'
    insertFinalizedDraft(7, 2)
    insertFinalizedDraft(8, 3)
    const chapterThreeDb = getProjectDb()!
    chapterThreeDb.transaction(() => freezeFinalizedCharacterSnapshot(chapterThreeDb, { draftId: 8, finalizationId: 'finalization-8', chapterNumber: 3,
      contentHash: createHash('sha256').update('Chapter 3 finalized content').digest('hex') }))()
    const contextThree = SummaryRepository.readFinalizedCharacterContext(8, { projectId: 'test', epoch: 'lease-test' })
    SummaryRepository.commitFinalizedCharacterStates(contextThree, { updates: [{ characterId, currentState: { location: '新港', recentEvents: '第三章已经交出黄铜钥匙' },
      evidence: { start: 0, end: contextThree.content.length, text: contextThree.content } }], unresolved: [] })
    const chapterThree = { snapshot: CharacterRosterRepository.read() }
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          location: '旧站',
          keyItems: '黄铜钥匙',
          recentEvents: '第二章准备交出钥匙',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command('第二章定稿：林岚准备交出黄铜钥匙。', {
      onlyFailed: true,
      stepKey: 'character_cards',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(status.steps.character_cards).toMatchObject({
      ok: false,
      error: expect.stringContaining('SOURCE_CONFLICT'),
    })
    expect(CharacterRosterRepository.read()).toEqual(chapterThree.snapshot)
    expect(CharacterRepository.getById(characterId)?.currentState).toMatchObject({
      location: '新港',
      keyItems: 'brass key',
      recentEvents: '第三章已经交出黄铜钥匙',
      updatedAtChapter: 3,
    })
  })

  it('keeps a legal empty update successful without creating a roster revision', async () => {
    const chineseChapter = [
      '头部事实：林岚抵达旧站。',
      '雨水冲刷石阶。'.repeat(1200),
      '中段事实：林岚检查封印但没有改变角色状态。',
      '列车穿过山谷。'.repeat(1200),
      '尾部事实：林岚仍在旧站。',
    ].join('\n')
    const status = await command(chineseChapter).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(observedCharacterPrompt).toContain(chineseChapter)
    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })

  it('retains unknown character output for explicit approval without creating or merging a character', async () => {
    cardResponse = JSON.stringify({ updates: [{ name: 'Zhou Yan', currentState: { location: 'harbor' } }] })
    const before = CharacterRosterRepository.read()
    const status = await command('Zhou Yan reaches the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(workflowContext.data.characterProposalBatchId).toBe('fixture-pending-proposal')
    expect(CharacterRosterRepository.read()).toEqual(before)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(1)
    expect(commitRequests).toHaveLength(1)
  })

  it('reuses the exact durable artifact when an automatic retry repairs only persistence', async () => {
    commitFailures = 1
    cardResponse = JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })
    const status = await command('Lin Lan arrives at the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(commitRequests).toHaveLength(2)
    expect(commitRequests[1]).toEqual(commitRequests[0])
    expect(selections).toHaveLength(2)
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(2)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
  })

  it('keeps a permanent field conflict attached to the original artifact instead of regenerating against the edit', async () => {
    changeFieldBeforeCommit = true
    cardResponse = JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })
    const status = await command('Lin Lan arrives at the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(status.steps.character_cards).toMatchObject({ ok: false, error: expect.stringContaining('FIELD_CONFLICT') })
    expect(commitRequests).toHaveLength(3)
    expect(commitRequests.every(request => JSON.stringify(request) === JSON.stringify(commitRequests[0]))).toBe(true)
    expect(selections).toHaveLength(2)
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(2)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('作者后来设置')
  })

  it('generates a fresh artifact after malformed structured output without caching the invalid request', async () => {
    let stateCalls = 0
    useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
      const isCharacter = messages.some((message: { role: string; content: string }) => message.role === 'system' && message.content.includes('character records'))
      const content = !isCharacter ? 'Lin Lan arrives at the harbor.' : ++stateCalls === 1 ? '{"updates":{}}'
        : modelFixtureResponse(JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] }))
      streamCallbacks.onDone?.(content, undefined, 'stop')
      return 'synthetic-request'
    }) })
    const status = await command('Lin Lan arrives at the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(stateCalls).toBe(2)
    expect(commitRequests).toHaveLength(1)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
  })

  it('cancels before commit and safely retries only the unfinished post-process step', async () => {
    insertFinalizedDraft(7, 2)
    let cancelledOnce = false
    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
        if (system.includes('character records')) {
          if (!cancelledOnce) {
            cancelledOnce = true
            workflowContext.cancelled = true
          }
          streamCallbacks.onDone?.(JSON.stringify({
            updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
          }), undefined, 'stop')
        } else {
          streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
        }
        return 'request-cancellation'
      }),
    })

    await expect(command('The brass key changes hands.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })).rejects.toThrow(/cancelled/i)
    expect(CharacterRosterRepository.read().revision).toBe(1)
    const interruptedRun = PostProcessRepository.getLatestRun('chapter_finalize', '2')
    expect(interruptedRun).not.toBeNull()
    expect(PostProcessRepository.getSteps(interruptedRun!.id)
      .find(step => step.stepKey === 'character_cards')).toMatchObject({ ok: false, attemptCount: 0 })

    workflowContext.cancelled = false
    cardResponse = JSON.stringify({
      updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
    })
    installModel()
    const status = await command('The brass key changes hands.', { onlyFailed: true }).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 2,
      entries: [expect.objectContaining({
        currentState: expect.objectContaining({ location: 'harbor', keyItems: 'brass key' }),
      })],
    })
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '2')?.id).toBe(interruptedRun!.id)
  })

  it('retries one selected failed step without invoking successful steps again', async () => {
    insertFinalizedDraft(7, 2)
    cardResponse = '{}'
    const initial = await command('The brass key changes hands.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })
    expect(initial.steps.character_cards.ok).toBe(false)
    expect(initial.steps.kb_import.ok).toBe(true)
    expect(initial.steps.chapter_notes.ok).toBe(true)

    cardResponse = JSON.stringify({
      updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
    })
    const generateStream = useLLMStore.getState().generateStream as ReturnType<typeof vi.fn>
    generateStream.mockClear()

    const repaired = await command('The brass key changes hands.', {
      onlyFailed: true,
      stepKey: 'character_cards',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(generateStream).toHaveBeenCalledOnce()
    const messages = generateStream.mock.calls[0]?.[0] as Array<{ role: string; content: string }>
    expect(messages.find(message => message.role === 'system')?.content).toMatch(/character records|角色档案/)
    expect(repaired.steps.character_cards.ok).toBe(true)
    expect(repaired.steps.kb_import.ok).toBe(true)
    expect(repaired.steps.chapter_notes.ok).toBe(true)
  })
})
