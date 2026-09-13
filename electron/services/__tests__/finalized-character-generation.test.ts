import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { MAIN_GENERATION_POLICY } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { commitCharacterIdentities } from '../../repositories/character-roster-repository'
import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { MainGenerationExecuteReceipt } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进了北塔。'

function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s09b-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  const db = new Database(':memory:')
  vi.mocked(getProjectDb).mockReturnValue(db)
  initializeLegacyBaselineSchema(db)
  db.exec("INSERT INTO characters(name,cs_provenance) VALUES('林岚','{}')")
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name) VALUES('main','合成定稿'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔'); INSERT INTO contents(id,body) VALUES(1,'旧稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,2)")
  FinalizationRepository.commit({ finalizationId: 'finalized-1', draftId: 1, chapterNumber: 1, chapterTitle: '北塔',
    content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: '第一章.txt' })
  const characterId = db.prepare("SELECT character_id FROM characters WHERE name='林岚'").pluck().get() as string
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
    apiKey: 'synthetic-fixture-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
    capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const response = (updates = [{ characterId, currentState: { location: '北塔' }, evidence: { start: 0, end: prose.length, text: prose } }]) => JSON.stringify({ updates })
  const dispatchSpy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => {
    options.onVisible({ kind: 'delta', text: response() }); return { finishReason: 'stop', usage: null }
  }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: () => '{"prompt":"合成冻结模板"}' }
  let current = true
  const owner = createMainGenerationOwner({ database: db, projectId: 'project', epoch: 'epoch',
    assertCurrent: () => { if (!current) throw new Error('GENERATION_EPOCH_STALE') },
    leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: dispatchSpy,
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch: 'epoch',
      modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, 'epoch', modelReceipt, MAIN_GENERATION_POLICY).binding,
  })
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const prepared = owner.readFinalizedCharacterContext(1)
  const selection: BeginGenerationRequest = { operation: 'finalized-character-state', uiActionNonce: 'extract', modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [], selectedFinalizedDraftIds: [1], promptKeys: ['character_state_update'], skillStages: [], output: 'structured-data',
    finalizedCharacterContextId: prepared.contextId, authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }] }
  const task = { purpose: 'finalized-character-state', output: 'structured-data' as const, messages: [{ role: 'user' as const, content: '从冻结正文和角色 ID 提取状态。' }] }
  const artifactOf = (receipt: MainGenerationExecuteReceipt) => {
    const artifact = receipt.run.artifacts.at(-1)!
    return { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }
  }
  const run = async () => {
    const view = owner.begin(selection)
    const receipt = await owner.execute({ handle: view.handle, invocationNonce: 'extract-1', task })
    return { handle: view.handle, artifact: artifactOf(receipt), contextId: prepared.contextId }
  }
  return { owner, db, selection, prepared, characterId, dispatch: dispatchSpy, response, run, task, artifactOf, invalidate: () => { current = false } }
}

describe('finalized character extraction through the main owner', () => {
  it('requires the actual opaque context before any dispatch and rejects renderer admission hashes', () => {
    const f = fixture()
    expect(f.prepared.context.identityStatus).toBe('bound')
    expect(() => f.owner.begin({ ...f.selection, finalizedCharacterContextId: undefined })).toThrow('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    expect(() => f.owner.begin({ ...f.selection, finalizedCharacterContextHash: textHash('forged') } as BeginGenerationRequest)).toThrow('GENERATION_BEGIN_INVALID')
    expect(() => f.owner.begin({ ...f.selection, authorInputs: [{ id: 'finalized-character-context', text: '{}' }] })).toThrow('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('keeps immutable finalized identity snapshots outside generic legacy proposal resolution', () => {
    const f = fixture()
    const row = f.db.prepare("SELECT proposal_id,raw_value FROM character_identity_proposals WHERE source_key='finalized-character-snapshot:v1'").get() as { proposal_id: string; raw_value: string }
    expect(() => commitCharacterIdentities(f.db, {
      approval: { operationId: 'forged-resolution', expectedRevision: 0, action: 'confirm-identity',
        source: { kind: 'author', source: { projectId: 'project', epoch: 'epoch', sourceId: 'author-action', revision: 1, contentHash: textHash('确认身份') } } },
      changes: [], creations: [], retireIds: [], relationships: [], resolutions: [{ proposalId: row.proposal_id, characterId: f.characterId }],
    }, () => true)).toThrow('CHARACTER_PROPOSAL_KIND_INVALID')
    expect(f.db.prepare('SELECT raw_value,resolved_character_id,approval_id FROM character_identity_proposals WHERE proposal_id=?').get(row.proposal_id))
      .toEqual({ raw_value: row.raw_value, resolved_character_id: null, approval_id: null })
    expect(f.db.prepare("SELECT COUNT(*) FROM character_identity_approvals WHERE operation_id='forged-resolution'").pluck().get()).toBe(0)
  })
  it('commits only the durable artifact by ID, preserves provenance and replays without another request', async () => {
    const f = fixture(), request = await f.run()
    const staticProjection = f.db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get()
    expect(f.owner.commitFinalizedCharacterStates(request)).toMatchObject({ applied: 1, unchanged: 0, unresolved: [] })
    const row = f.db.prepare('SELECT cs_location,cs_provenance FROM characters WHERE character_id=?').get(f.characterId) as { cs_location: string; cs_provenance: string }
    expect(row.cs_location).toBe('北塔')
    expect(JSON.parse(row.cs_provenance).location).toMatchObject({ kind: 'derived', source: f.prepared.context.source })
    expect(f.owner.commitFinalizedCharacterStates(request)).toMatchObject({ applied: 0, unchanged: 1 })
    expect(f.db.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(prose)
    expect(f.db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get()).toBe(staticProjection)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects a field edit made after context preparation and leaves its author value intact', () => {
    const f = fixture()
    f.db.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后来设置', f.characterId)
    expect(() => f.owner.begin(f.selection)).toThrow('GENERATION_CHARACTER_CONTEXT_CHANGED')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('keeps a late field-conflicting artifact as a candidate without replacing author text', async () => {
    const f = fixture(), request = await f.run()
    f.db.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后来设置', f.characterId)
    expect(() => f.owner.commitFinalizedCharacterStates(request)).toThrow('FINALIZED_CHARACTER_FIELD_CONFLICT')
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者后来设置')
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('rejects mismatching artifact references and contexts without changing a field', async () => {
    const f = fixture(), request = await f.run()
    expect(() => f.owner.commitFinalizedCharacterStates({ ...request, artifact: { ...request.artifact, textHash: 'a'.repeat(64) } })).toThrow('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
    expect(() => f.owner.commitFinalizedCharacterStates({ ...request, contextId: 'not-issued' })).toThrow('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    expect(() => f.owner.commitFinalizedCharacterStates({ ...request, handle: { ...request.handle, epoch: 'other' } })).toThrow('GENERATION_CHARACTER_CONTEXT_REQUIRED')
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('')
  })
  it('refuses cancelled or superseded source output and retains its durable candidate', async () => {
    const f = fixture(), request = await f.run()
    f.owner.cancel(request.handle)
    expect(() => f.owner.commitFinalizedCharacterStates(request)).toThrow('GENERATION_ACTION_CANCELLED')
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('refuses changed finalized prose with no derived write', async () => {
    const f = fixture(), request = await f.run()
    f.db.prepare('UPDATE contents SET body=? WHERE id=1').run('作者后改定稿')
    expect(() => f.owner.commitFinalizedCharacterStates(request)).toThrow('GENERATION_FINALIZED_SOURCE_NOT_CURRENT')
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('')
  })
  it('rolls back state and provenance when storage rejects an update', async () => {
    const f = fixture(), request = await f.run()
    f.db.exec("CREATE TRIGGER reject_state BEFORE UPDATE OF cs_provenance ON characters BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STORAGE_FAILURE'); END")
    expect(() => f.owner.commitFinalizedCharacterStates(request)).toThrow('SYNTHETIC_STORAGE_FAILURE')
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('')
    expect(f.owner.read(request.handle).candidates).toHaveLength(1)
  })
  it('stages a name-only occurrence with derived provenance and leaves every state unchanged', async () => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: JSON.stringify({ updates: [{ name: '林岚', currentState: { location: '北塔' }, evidence: { start: 0, end: prose.length, text: prose } }] }) })
      return { finishReason: 'stop', usage: null }
    })
    const request = await f.run(), receipt = f.owner.commitFinalizedCharacterStates(request)
    expect(receipt).toMatchObject({ applied: 0, unresolved: [{ originalText: '林岚', reason: 'name-only' }] })
    const batch = f.owner.characterProposals.read(receipt.proposalBatchId!)
    expect(batch).toMatchObject({ status: 'pending-approval', source: { kind: 'finalized-generation' }, items: [{ fields: { name: '林岚' } }] })
    const envelope = JSON.parse(f.db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?').pluck().get(batch.proposalBatchId) as string)
    expect(envelope.proof.provenance.kind).toBe('derived')
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('')
    // Explicit identity confirmation must not write the historical label back over a later author rename.
    f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('作者的新名', f.characterId)
    const approved = f.owner.characterProposals.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: 'confirm-occurrence', selections: [{ selectionKey: batch.items[0]!.selectionKey, action: 'map', characterId: f.characterId }] })
    expect(approved.batch.status).toBe('approved')
    expect(f.db.prepare('SELECT name FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('作者的新名')
  })
  it.each(['length', 'bad-json'] as const)('does not turn %s output into a state update', async kind => {
    const f = fixture(async (_request, options) => {
      options.onVisible({ kind: 'delta', text: kind === 'bad-json' ? '{' : '{"updates":[]}' })
      return { finishReason: kind === 'length' ? 'length' : 'stop', usage: null }
    })
    const request = await f.run()
    expect(() => f.owner.commitFinalizedCharacterStates(request)).toThrow()
    expect(f.db.prepare('SELECT cs_location FROM characters WHERE character_id=?').pluck().get(f.characterId)).toBe('')
  })
})
