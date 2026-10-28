import { createMainGenerationOwner } from '../../../../../electron/services/main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../../../../../electron/services/model-execution-lease'
import { readMainGenerationPolicy } from '../../../../../electron/services/main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../../../../../electron/services/generation-source-binding'
import { generationOutputContract } from '../../../../shared/generation-owner-contract'
import { getBuiltinPromptTemplate } from '../../../builtin-prompt-templates'
import type { ModelProfile } from '../../../../shared/ipc-channels'
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
import type { CharacterRosterCommitRequest } from '../../../../shared/character-roster'
import { useWorkflowStore, type StepCallbacks, type WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { RunFinalizePostProcessCommand } from '../finalize-chapter.command'
import { globalEventBus } from '../../../../shared/event-bus'
import { GenerateDraftCommand } from '../generate-draft.command'
import { createWorkflowMainGenerationRuntime } from '../../workflow-main-generation'
import type { MainGenerationRunView } from '../../../generation/generation-runtime'
type ModelMessages = Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0]

let projectPath = ''
let cardResponse = '{"updates":[]}'
let workflowContext: WorkflowContext
let observedCharacterPrompt = ''
let observedChapterNotesPrompt = ''
let characterId = ''
const selections: unknown[] = []
const commitRequests: unknown[] = []
let commitFailures = 0
let characterExecuteFailures = 0
let changeFieldBeforeCommit = false
/** 每次提交前按步骤与第几次提交调用，用来制造提交失败或生成期间的数据变化。 */
let onCommit: ((stepKey: string | undefined, nth: number) => void) | undefined
const commitsByStep = new Map<string | undefined, number>()
let actualOwner: ReturnType<typeof createMainGenerationOwner> | undefined
const stageByRun = new Map<string, string>()
function owner() {
  if (actualOwner) return actualOwner
  const db = getProjectDb()!
  const model: ModelProfile = { id: 'test-model', name: 'Synthetic', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-only', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'] }
  const deps = { db, projectStorageRoot: projectPath, globalDataRoot: projectPath,
    readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)) }
  actualOwner = createMainGenerationOwner({ database: db, projectId: 'test', epoch: 'lease-test', assertCurrent: () => {},
    leases: new ModelExecutionLeaseRegistry({ loadModel: id => id === 'post-model' ? { ...model, id } : model }), loadModel: id => id === 'post-model' ? { ...model, id } : model,
    dispatch: (request, options) => new Promise((resolve, reject) => {
      void useLLMStore.getState().generateStream((request as { task: { messages: ModelMessages } }).task.messages, {
        onDone: (content, _usage, finishReason) => { options.onVisible({ kind: 'delta', text: content }); resolve({ finishReason, usage: null }) },
        onError: error => reject(new Error(error)),
      }, model.id).catch(reject)
    }),
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'test', epoch: 'lease-test', modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, 'lease-test', modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding,
  })
  return actualOwner
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
    ) VALUES (?, ?, ?, '', ?, 1, ?, ?, 'published')
  `).run(`finalization-${draftId}`, draftId, chapterNumber, contentHash, content, `chapter-${chapterNumber}.txt`)
}

function installRealRepositoryIpc(): void {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: async (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'finalization-generation:read': {
            const value = owner().readFinalizationGeneration(args[0] as Parameters<ReturnType<typeof owner>['readFinalizationGeneration']>[0])
            if (value) stageByRun.set(value.view.handle.runId, value.context.slot.stepKey)
            return value
          }
          case 'finalization-generation:begin': {
            selections.push(structuredClone(args[0]))
            const value = owner().beginFinalizationGeneration(args[0] as Parameters<ReturnType<typeof owner>['beginFinalizationGeneration']>[0])
            stageByRun.set(value.view.handle.runId, value.context.slot.stepKey)
            return value
          }
          case 'finalization-generation:execute': {
            const request = args[0] as Parameters<ReturnType<typeof owner>['executeFinalizationGeneration']>[0]
            if (stageByRun.get(request.handle.runId) === 'character_cards' && characterExecuteFailures-- > 0) throw new Error('network error: synthetic lost execute')
            return owner().executeFinalizationGeneration(request)
          }
          case 'finalization-generation:cancel': return owner().cancelFinalizationGeneration(args[0] as Parameters<ReturnType<typeof owner>['cancelFinalizationGeneration']>[0])
          case 'finalization-generation:commit': {
            const request = args[0] as Parameters<ReturnType<typeof owner>['commitFinalizationGeneration']>[0]
            const stage = stageByRun.get(request.handle.runId), nth = (commitsByStep.get(stage) ?? 0) + 1
            commitsByStep.set(stage, nth)
            onCommit?.(stage, nth)
            if (stage === 'character_cards') {
              commitRequests.push(structuredClone(request))
              if (commitFailures-- > 0) throw new Error('network error: synthetic temporary commit failure')
              if (changeFieldBeforeCommit) { changeFieldBeforeCommit = false; getProjectDb()!.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后来设置', characterId) }
            }
            return owner().commitFinalizationGeneration(request)
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

function command(draftContent: string, overrides: { onlyFailed?: boolean; stepKeys?: readonly string[]; retryInvalidResult?: boolean; stopOnFailure?: boolean } = {},
  { draftId, chapterNumber }: { draftId: number; chapterNumber: number } = { draftId: 7, chapterNumber: 2 }) {
  insertFinalizedDraft(draftId, chapterNumber, draftContent)
  const db = getProjectDb()!
  const finalizationId = `finalization-${draftId}`
  if (!db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get(`fcs:${finalizationId}`)) {
    db.transaction(() => freezeFinalizedCharacterSnapshot(db, { draftId, finalizationId, chapterNumber,
      contentHash: createHash('sha256').update(draftContent).digest('hex') }))()
  }
  return new RunFinalizePostProcessCommand({
    project: { path: projectPath },
    chapterNumber,
    chapterTitle: 'The Handoff',
    draftContent,
    draftId,
    finalizedSource: {
      draftId,
      finalizationId,
      chapterNumber,
      contentHash: createHash('sha256').update(draftContent, 'utf8').digest('hex'),
    },
    sourceLabel: `Chapter ${chapterNumber} finalization`,
    ...overrides,
  })
}

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/s09b-finalize-consumer')
  fs.mkdirSync(cache, { recursive: true })
  projectPath = fs.mkdtempSync(path.join(cache, 'case-'))
  actualOwner = undefined; stageByRun.clear(); selections.length = 0; commitRequests.length = 0; commitFailures = 0; characterExecuteFailures = 0; changeFieldBeforeCommit = false; onCommit = undefined; commitsByStep.clear()
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
  actualOwner?.suspendForProjectClose()
  closeProjectDatabase()
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ models: [], stageModelIds: {}, defaultModelId: null })
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
      error: 'FINALIZATION_GENERATION_SOURCE_CHANGED',
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
      stepKeys: ['chapter_notes'],
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(freshRun.steps.chapter_notes).toMatchObject({ ok: false })
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: 'Existing projection remains available only as stale material.',
      sourceStatus: 'stale',
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

  it.each([
    ['a single-chapter finalize asks for the finalization stage model', undefined, 'post-model'],
    ['a batch or import context keeps the model it already froze', 'batch-model', 'batch-model'],
  ])('%s', async (_label, frozenModelId, expected) => {
    insertFinalizedDraft(7, 2)
    useLLMStore.setState({ models: [{ id: 'test-model', purposes: ['generation'] }, { id: 'post-model', purposes: ['generation'] }] as never,
      stageModelIds: { finalization: 'post-model', drafting: 'test-model' } })
    await command('Chapter 2 finalized content').execute({
      step: {}, context: { ...workflowContext, ...(frozenModelId ? { generationModelId: frozenModelId } : {}) }, callbacks: callbacks(),
    })
    expect(selections.map(selection => (selection as { modelId: string }).modelId)).toEqual([expected, expected])
  })

  it('records the finalization stage model on the run so editing that model warns about it', async () => {
    insertFinalizedDraft(7, 2)
    useLLMStore.setState({ models: [{ id: 'test-model', purposes: ['generation'] }, { id: 'post-model', purposes: ['generation'] }] as never,
      defaultModelId: 'test-model', stageModelIds: { finalization: 'post-model' } })
    useWorkflowStore.setState({ activeRuns: [{ id: workflowContext.runId, status: 'running' }] as never })
    await command('Chapter 2 finalized content').execute({ step: {}, context: { ...workflowContext }, callbacks: callbacks() })
    expect(useWorkflowStore.getState().activeRuns[0]?.generationModelId).toBe('post-model')
    useWorkflowStore.setState({ activeRuns: [] })
  })

  it('keeps the later inference stages of an author import on the planning model after post-processing ran on the finalization model', async () => {
    useLLMStore.setState({ models: ['test-model', 'post-model', 'plan-model'].map(id => ({ id, purposes: ['generation'] })) as never,
      defaultModelId: 'test-model', stageModelIds: { finalization: 'post-model', planning: 'plan-model' } })
    const importContext: WorkflowContext = { ...workflowContext, data: {} }
    const recordedModel = () => useWorkflowStore.getState().activeRuns[0]?.generationModelId
    useWorkflowStore.setState({ activeRuns: [{ id: workflowContext.runId, status: 'running' }] as never })
    await command('Chapter 2 finalized content').execute({ step: {}, context: importContext, callbacks: callbacks() })
    expect(recordedModel()).toBe('post-model')
    useLLMStore.setState({ stageModelIds: { finalization: 'test-model', planning: 'plan-model' } })
    await command('Chapter 3 finalized content', {}, { draftId: 8, chapterNumber: 3 }).execute({ step: {}, context: importContext, callbacks: callbacks() })
    const handle = { projectId: 'test', epoch: 'lease-test', rootActionId: 'import-root', runId: 'import-generation' }
    const view: MainGenerationRunView = { handle, budget: { maxAttempts: 1, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 100, deadlineAt: 1000 }, status: 'running', nonReplayable: false, artifacts: [] }
    const begin = vi.fn<(session: unknown, request: { modelId: string }) => Promise<MainGenerationRunView>>(async () => view)
    const transport = { begin, pause: vi.fn(async () => view), read: vi.fn(async () => view), subscribe: vi.fn(() => () => {}) } as unknown as Parameters<typeof createWorkflowMainGenerationRuntime>[1]
    for (const operation of ['import-global-facts', 'analyze-writing-style', 'import-blueprints'] as const) {
      const runtime = await createWorkflowMainGenerationRuntime({ context: importContext, callbacks: callbacks(),
        selection: { operation, promptKeys: [], skillStages: [], output: 'structured-data' } }, transport)
      await runtime.close()
    }
    expect(selections.map(selection => (selection as { modelId: string }).modelId)).toEqual(['post-model', 'post-model', 'post-model', 'post-model'])
    expect(begin.mock.calls.map(([, request]) => request.modelId)).toEqual(['plan-model', 'plan-model', 'plan-model'])
    expect(recordedModel()).toBe('plan-model')
    useWorkflowStore.setState({ activeRuns: [] })
  })

  it('records the model main actually inherits from a finished sibling step, not the newly assigned one', async () => {
    useLLMStore.setState({ models: [{ id: 'test-model', purposes: ['generation'] }, { id: 'post-model', purposes: ['generation'] }] as never,
      defaultModelId: 'test-model', stageModelIds: { finalization: 'post-model' } })
    await command('Chapter 2 finalized content', { stepKeys: ['chapter_notes'] }).execute({ step: {}, context: { ...workflowContext }, callbacks: callbacks() })
    useLLMStore.setState({ stageModelIds: {} })
    useWorkflowStore.setState({ activeRuns: [{ id: 'continue-run', status: 'running' }] as never })
    await command('Chapter 2 finalized content', { stepKeys: ['character_cards'] }).execute({
      step: {}, context: { ...workflowContext, runId: 'continue-run' }, callbacks: callbacks(),
    })
    expect(useWorkflowStore.getState().activeRuns[0]?.generationModelId).toBe('post-model')
    useWorkflowStore.setState({ activeRuns: [] })
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

    expect(status.steps.chapter_notes.ok, JSON.stringify(status.steps)).toBe(true)
    expect(observedCharacterPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(
      'an explicitly stated cause, location, witness, or source of knowledge',
    )
    expect(observedChapterNotesPrompt).toContain(
      'Do not infer missing details or require every note to contain all of these elements',
    )
    expect(observedChapterNotesPrompt).toContain(
      "preserve the affected character's last correction and current conditions in Character Dynamics or Foreshadowing and Hooks",
    )
    expect(observedChapterNotesPrompt).toContain(
      'Do not substitute a more prominent earlier event for the current plan or describe a plan as executed',
    )
    expect(status.steps).toMatchObject({ chapter_notes: { ok: true }, character_cards: { ok: true, attemptCount: 1 } })
    expect(selections).toMatchObject([{ slot: { stepKey: 'chapter_notes', source: { draftId: 7 } } }, { slot: { stepKey: 'character_cards', source: { draftId: 7 } } }])
    expect(commitRequests).toEqual([expect.objectContaining({ handle: expect.objectContaining({ projectId: 'test', epoch: 'lease-test' }), artifact: expect.objectContaining({ textHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) })])
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
      stepKeys: ['character_cards'],
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
    expect(status.steps).toMatchObject({ chapter_notes: { ok: true }, character_cards: { ok: true, attemptCount: 1 } })
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })

  it('retains unknown character output for explicit approval without creating or merging a character', async () => {
    cardResponse = JSON.stringify({ updates: [{ name: 'Zhou Yan', currentState: { location: 'harbor' } }] })
    const before = CharacterRosterRepository.read()
    const status = await command('Zhou Yan reaches the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(owner().characterProposals.read(workflowContext.data.characterProposalBatchId as string)).toMatchObject({
      status: 'pending-approval',
      items: [expect.objectContaining({ fields: expect.objectContaining({ name: 'Zhou Yan' }) })],
    })
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
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(2)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('作者后来设置')
  })

  it('repairs malformed structured output within the original durable slot and commits only the valid candidate', async () => {
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
    expect(selections).toHaveLength(2)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
  })

  it('cancels before commit, keeps the cancelled run, and lets an explicit retry start a fresh attempt', async () => {
    insertFinalizedDraft(7, 2)
    const before = CharacterRosterRepository.read()
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

    const finalizationRunCount = () => getProjectDb()!.prepare("SELECT COUNT(*) FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.finalizationGenerationSlotKey') IS NOT NULL").pluck().get() as number
    const runsBeforeRetry = finalizationRunCount()
    workflowContext.cancelled = false
    cardResponse = JSON.stringify({
      updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
    })
    installModel()
    const status = await command('The brass key changes hands.', { onlyFailed: true }).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps).toMatchObject({ chapter_notes: { ok: true }, character_cards: { ok: true } })
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(1)
    expect(commitRequests).toHaveLength(1)
    expect(CharacterRosterRepository.read().revision).toBe(before.revision + 1)
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '2')?.id).toBe(interruptedRun!.id)
    expect(finalizationRunCount()).toBe(runsBeforeRetry + 1)
  })

  it('retries only the selected failed effect using its original candidate without invoking any model again', async () => {
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
      stepKeys: ['character_cards'],
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(generateStream).not.toHaveBeenCalled()
    expect(commitRequests).toHaveLength(6)
    expect(commitRequests.every(request => JSON.stringify(request) === JSON.stringify(commitRequests[0]))).toBe(true)
    expect(repaired.steps.character_cards.ok).toBe(false)
    expect(CharacterRosterRepository.read().revision).toBe(1)
    expect(repaired.steps.kb_import.ok).toBe(true)
    expect(repaired.steps.chapter_notes.ok).toBe(true)
  })
})

it('一次显式修复固定失败目标，withRetry 不得把第四份坏结果升级为第五次请求', async () => {
 const content = 'Lin Lan says: the inspection is still pending.'
 let calls = 0
 let correct = false
 useLLMStore.setState({ generateStream: vi.fn(async (_messages, streamCallbacks) => {
  calls++
  streamCallbacks.onDone?.(JSON.stringify({ updates: [{ characterId, currentState: { recentEvents: 'The inspection is pending.' },
   evidence: { text: correct ? content : 'Lin Lan says, the inspection is still pending.' } }] }), undefined, 'stop')
  return 'synthetic-request'
 }) })
 const execute = (retryInvalidResult = false) => command(content, { onlyFailed: true, stepKeys: ['character_cards'], retryInvalidResult })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect((await execute()).steps.character_cards.ok).toBe(false)
 expect(calls).toBe(3)
 expect((await execute()).steps.character_cards.ok).toBe(false)
 expect(calls).toBe(3)
 const failed = await execute(true)
 expect(failed.steps.character_cards.ok).toBe(false)
 expect(calls).toBe(4)
 expect(commitRequests.slice(-3).every(value => JSON.stringify(value) === JSON.stringify(commitRequests.at(-1)))).toBe(true)
 correct = true
 expect((await execute(true)).steps.character_cards.ok).toBe(true)
 expect(calls).toBe(5)
 const db = getProjectDb()!
 expect(db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(1)
 expect(db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get()).toBe(1)
})
it('#420 角色状态断流后，用户重试每次只发一次新请求，失败记下错误码，成功后只写一次', async () => {
 insertFinalizedDraft(7, 2)
 let characterCalls = 0
 let failures = 2
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (!system.includes('character records')) { streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop'); return 'notes' }
  characterCalls++
  if (failures-- > 0) { streamCallbacks.onError?.('synthetic stream interrupted'); return 'interrupted' }
  streamCallbacks.onDone?.(modelFixtureResponse(JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })), undefined, 'stop')
  return 'recovered'
 }) })
 const run = (repair: boolean) => command('The brass key changes hands.', repair ? { onlyFailed: true, retryInvalidResult: true } : {})
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 const before = CharacterRosterRepository.read().revision
 const initial = await run(false)
 expect(initial.steps).toMatchObject({ chapter_notes: { ok: true }, character_cards: { ok: false } })
 expect(characterCalls).toBe(1)
 expect(initial.steps.character_cards.error).toBe('FINALIZATION_GENERATION_ARTIFACT_REQUIRED')
 const failedAgain = await run(true)
 expect(failedAgain.steps.character_cards.ok).toBe(false)
 expect(failedAgain.steps.character_cards.error).toBe('FINALIZATION_GENERATION_INCOMPLETE')
 expect(characterCalls).toBe(2)
 const repaired = await run(true)
 expect(repaired.steps.character_cards.ok).toBe(true)
 expect(characterCalls).toBe(3)
 expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
 expect(CharacterRosterRepository.read().revision).toBe(before + 1)
 expect((await run(true)).steps.character_cards.ok).toBe(true)
 expect(characterCalls).toBe(3)
 expect(CharacterRosterRepository.read().revision).toBe(before + 1)
})

it('#420 模型正常结束但返回空文本：步骤记结果不可用（不说没发请求），自动重试不再计费，作者重试发一次新请求后成功', async () => {
 insertFinalizedDraft(7, 2)
 let notesCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (system.includes('character records')) { streamCallbacks.onDone?.(modelFixtureResponse('{"updates":[]}'), undefined, 'stop'); return 'characters' }
  if (++notesCalls === 1) { streamCallbacks.onDone?.('', undefined, 'stop'); return '' }
  streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
  return 'notes'
 }) })
 const initial = await command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(initial.steps.chapter_notes).toMatchObject({ ok: false, error: 'FINALIZATION_GENERATION_RESULT_UNUSABLE' })
 expect(notesCalls).toBe(1)
 const repaired = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(repaired.steps.chapter_notes).toMatchObject({ ok: true })
 expect(notesCalls).toBe(2)
})

it('#420 运行中取消后，界面的重试（retryInvalidResult）在新运行里重新请求，不被旧运行的失败引用卡住', async () => {
 insertFinalizedDraft(7, 2)
 let characterCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (!system.includes('character records')) { streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop'); return 'notes' }
  if (++characterCalls === 1) workflowContext.cancelled = true
  streamCallbacks.onDone?.(modelFixtureResponse(JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })), undefined, 'stop')
  return 'character'
 }) })
 await expect(command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })).rejects.toThrow(/cancelled/i)
 const runs = () => getProjectDb()!.prepare("SELECT COUNT(*) FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.finalizationGenerationSlotKey') IS NOT NULL").pluck().get() as number
 const before = runs()
 workflowContext.cancelled = false
 const status = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(status.steps.character_cards).toMatchObject({ ok: true })
 expect(characterCalls).toBe(2)
 expect(runs()).toBe(before + 1)
 expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
})

it('#420 章节要点断流后作者改了本章蓝图要点，重试在新开的运行里重新请求并成功', async () => {
 insertFinalizedDraft(7, 2)
 let notesCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (system.includes('character records')) { streamCallbacks.onDone?.(modelFixtureResponse('{"updates":[]}'), undefined, 'stop'); return 'characters' }
  if (++notesCalls === 1) { streamCallbacks.onError?.('synthetic stream interrupted'); return 'interrupted' }
  streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
  return 'notes'
 }) })
 const initial = await command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(initial.steps.chapter_notes.ok).toBe(false)
 expect(notesCalls).toBe(1)
 getProjectDb()!.prepare("INSERT INTO blueprints (chapter_number, title, notes) VALUES (2, 'The Handoff', 'Author-edited notes')").run()
 const repaired = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(repaired.steps.chapter_notes).toMatchObject({ ok: true })
 expect(repaired.steps.character_cards).toMatchObject({ ok: true })
 expect(notesCalls).toBe(2)
})

it('#420 角色状态运行已开始但还没发请求，重试按本运行的状态发出请求，不被章节要点的尝试卡住', async () => {
 insertFinalizedDraft(7, 2)
 let characterCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (!system.includes('character records')) { streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop'); return 'notes' }
  characterCalls++
  streamCallbacks.onDone?.(modelFixtureResponse(JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })), undefined, 'stop')
  return 'characters'
 }) })
 characterExecuteFailures = 3
 const initial = await command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(initial.steps).toMatchObject({ chapter_notes: { ok: true }, character_cards: { ok: false } })
 expect(characterCalls).toBe(0)
 const repaired = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(repaired.steps.character_cards).toMatchObject({ ok: true })
 expect(characterCalls).toBe(1)
 expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
})

it('#420 生成根被超时阻断后，重试记下额度用完的错误码，不再请求模型', async () => {
 insertFinalizedDraft(7, 2)
 let characterCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (!system.includes('character records')) { streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop'); return 'notes' }
  characterCalls++
  streamCallbacks.onError?.('synthetic stream interrupted')
  return 'interrupted'
 }) })
 const initial = await command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(initial.steps.character_cards.ok).toBe(false)
 getProjectDb()!.prepare("UPDATE generation_roots SET blocked_code='ROOT_BUDGET_EXHAUSTED'").run()
 const retried = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(retried.steps.character_cards).toMatchObject({ ok: false, error: 'ROOT_BUDGET_EXHAUSTED' })
 expect(characterCalls).toBe(1)
})

it('#420 断流后重试拿到坏 JSON 时，同一次点击里自动修正一次并成功', async () => {
 insertFinalizedDraft(7, 2)
 const replies = ['interrupted', 'not json', JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })]
 let characterCalls = 0
 useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
  const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
  if (!system.includes('character records')) { streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop'); return 'notes' }
  const reply = replies[characterCalls++]
  if (reply === 'interrupted') streamCallbacks.onError?.('synthetic stream interrupted')
  else streamCallbacks.onDone?.(modelFixtureResponse(reply), undefined, 'stop')
  return reply
 }) })
 const initial = await command('The brass key changes hands.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(initial.steps.character_cards.ok).toBe(false)
 const repaired = await command('The brass key changes hands.', { onlyFailed: true, retryInvalidResult: true })
  .execute({ step: {}, context: workflowContext, callbacks: callbacks() })
 expect(repaired.steps.character_cards).toMatchObject({ ok: true })
 expect(characterCalls).toBe(3)
 expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('harbor')
})

describe('cast refresh after the character-state step', () => {
  const harbor = JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] })
  let refreshes: Array<{ resources: string[]; projectSession: unknown; storedLocation?: string }> = []
  let stopListening = () => {}
  beforeEach(() => {
    refreshes = []
    stopListening = globalEventBus.on('REFRESH_RESOURCE', ({ resources, projectSession }) => refreshes.push({
      resources, projectSession, storedLocation: CharacterRosterRepository.read().entries[0]?.currentState?.location,
    }))
  })
  afterEach(() => stopListening())

  it.each([
    ['a single-chapter finalization', {}],
    ['a batch-creation chapter', { stopOnFailure: true }],
  ])('asks the open cast to reload once %s has written the new state', async (_path, overrides) => {
    cardResponse = harbor
    const status = await command('Lin Lan arrives at the harbor.', overrides).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(refreshes).toEqual([{ resources: ['characterCards'], projectSession: workflowContext.projectSession, storedLocation: 'harbor' }])
  })

  it('asks the cast to reload after a retried character step succeeds and never after it fails', async () => {
    let interrupted = false
    useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
      const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
      if (!system.includes('character records')) streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
      else if (!interrupted) { interrupted = true; streamCallbacks.onError?.('synthetic stream interrupted') }
      else streamCallbacks.onDone?.(modelFixtureResponse(harbor), undefined, 'stop')
      return 'synthetic-request'
    }) })
    const initial = await command('Lin Lan arrives at the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(initial.steps.character_cards.ok).toBe(false)
    expect(refreshes).toEqual([])

    const retried = await command('Lin Lan arrives at the harbor.', { onlyFailed: true, stepKeys: ['character_cards'], retryInvalidResult: true })
      .execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(retried.steps.character_cards).toMatchObject({ ok: true })
    expect(refreshes).toEqual([{ resources: ['characterCards'], projectSession: workflowContext.projectSession, storedLocation: 'harbor' }])
  })

  it('#502 a step key the current version no longer has does not block retrying the steps that still exist', async () => {
    let interrupted = false
    useLLMStore.setState({ defaultModelId: 'test-model', generateStream: vi.fn(async (messages, streamCallbacks) => {
      const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
      if (!system.includes('character records')) streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
      else if (!interrupted) { interrupted = true; streamCallbacks.onError?.('synthetic stream interrupted') }
      else streamCallbacks.onDone?.(modelFixtureResponse(harbor), undefined, 'stop')
      return 'synthetic-request'
    }) })
    expect((await command('Lin Lan arrives at the harbor.').execute({ step: {}, context: workflowContext, callbacks: callbacks() })).steps.character_cards.ok).toBe(false)

    const retried = await command('Lin Lan arrives at the harbor.', { onlyFailed: true, stepKeys: ['style_analysis', 'character_cards'], retryInvalidResult: true })
      .execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(retried.steps.character_cards).toMatchObject({ ok: true })
    await expect(command('Lin Lan arrives at the harbor.', { onlyFailed: true, stepKeys: ['style_analysis'] })
      .execute({ step: {}, context: workflowContext, callbacks: callbacks() })).rejects.toThrow('style_analysis')
  })

  it('#502 an empty step selection runs nothing instead of reporting success', async () => {
    const generateStream = vi.fn()
    useLLMStore.setState({ defaultModelId: 'test-model', generateStream })
    await expect(command('Lin Lan arrives at the harbor.', { stepKeys: [] })
      .execute({ step: {}, context: workflowContext, callbacks: callbacks() })).rejects.toThrow()
    expect(generateStream).not.toHaveBeenCalled()
  })
})

describe('#512 自动重试的最后一次提交时项目状态已变：作者再点重试会怎样', () => {
  const content = 'Lin Lan arrives at the harbor.'
  /** 前两次提交断线，第三次（自动重试的最后一次）提交前发生 change。 */
  const lastAutomaticCommit = (stepKey: string, change: () => void) => {
    onCommit = (stage, nth) => {
      if (stage !== stepKey) return
      if (nth <= 2) throw new Error('network error: synthetic temporary commit failure')
      if (nth === 3) change()
    }
  }
  const finalize = () => command(content).execute({ step: {}, context: workflowContext, callbacks: callbacks() })
  /** 与卡片上的重试同一套参数。 */
  const retry = (stepKeys: readonly string[]) => command(content, { onlyFailed: true, retryInvalidResult: true, stepKeys })
    .execute({ step: {}, context: workflowContext, callbacks: callbacks() })

  beforeEach(() => { cardResponse = JSON.stringify({ updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }] }) })

  it('章节要点生成期间作者改了本章要点：重试在新运行里重新生成并写入，替换作者改的要点', async () => {
    getProjectDb()!.prepare("INSERT INTO blueprints (chapter_number, title, notes) VALUES (2, 'The Handoff', '')").run()
    lastAutomaticCommit('chapter_notes', () => getProjectDb()!.prepare('UPDATE blueprints SET notes=? WHERE chapter_number=2').run('Author-edited notes'))
    const initial = await finalize()
    expect(initial.steps.chapter_notes).toMatchObject({ ok: false, error: 'GENERATION_FINALIZATION_NOTES_CHANGED' })
    expect(initial.steps.character_cards).toMatchObject({ ok: false, error: 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED' })

    const retried = await retry(['chapter_notes', 'character_cards'])
    expect(retried.steps.chapter_notes).toMatchObject({ ok: true })
    expect(retried.steps.character_cards).toMatchObject({ ok: true })
    expect(getProjectDb()!.prepare('SELECT notes FROM blueprints WHERE chapter_number=2').pluck().get()).toBe('Lin Lan hands the brass key to Zhou Yan.')
  })

  // FINALIZED_CHARACTER_CONTEXT_CHANGED 比对的字段，提交前的来源校验已经整组比过，同一条件在这里先以 IDENTITY_CHANGED 拒写。
  it.each(['chapter_notes', 'character_cards'])('%s 生成期间别的章节重新定稿或被删除：重试过不去，角色卡保持原样', async stepKey => {
    lastAutomaticCommit(stepKey, () => invalidateContinuityProjectionFrom(getProjectDb()!, 1))
    const initial = await finalize()
    expect(initial.steps[stepKey]).toMatchObject({ ok: false, error: 'GENERATION_FINALIZATION_IDENTITY_CHANGED' })

    const retried = await retry(stepKey === 'chapter_notes' ? ['chapter_notes', 'character_cards'] : ['character_cards'])
    expect(retried.steps[stepKey]).toMatchObject({ ok: false, error: 'FINALIZATION_GENERATION_SOURCE_CHANGED' })
    expect(CharacterRepository.getById(characterId)?.currentState?.location).toBe('old station')
  })

  it.each(['chapter_notes', 'character_cards'])('%s 生成期间作者删掉了本章定稿时在场的角色：重试过不去', async stepKey => {
    const db = getProjectDb()!
    lastAutomaticCommit(stepKey, () => {
      const revision = db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number
      commitCharacterIdentities(db, { approval: { operationId: 'retire-lin-lan', expectedRevision: revision, action: 'author-edit',
        source: { kind: 'author', source: { projectId: 'test', epoch: 'lease-test', sourceId: 'retire-fixture', revision, contentHash: 'b'.repeat(64) } } },
      creations: [], changes: [], retireIds: [characterId], relationships: [], resolutions: [] }, () => true)
    })
    const initial = await finalize()
    expect(initial.steps[stepKey]).toMatchObject({ ok: false, error: 'FINALIZED_CHARACTER_ID_RETIRED' })

    const retried = await retry(stepKey === 'chapter_notes' ? ['chapter_notes', 'character_cards'] : ['character_cards'])
    expect(retried.steps[stepKey]).toMatchObject({ ok: false, error: 'FINALIZATION_GENERATION_SOURCE_CHANGED' })
  })
})
