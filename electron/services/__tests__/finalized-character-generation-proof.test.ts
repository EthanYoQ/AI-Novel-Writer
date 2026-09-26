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

import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'
import type { MainGenerationExecuteReceipt } from '../../../src/services/generation/generation-runtime'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => '') }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进了北塔。'

function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/finalized-proof-tests')
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
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({ key, content: '合成冻结模板 {{chapter_content}} {{existing_cards_json}}' }) }
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
    const opened = owner.beginFinalizationGeneration({ slot: { source: prepared.context.source, stepKey: 'character_cards' }, modelId: model.id })
    const receipt = await owner.executeFinalizationGeneration({ handle: opened.view.handle })
    // Historical fixture only: public generic admission is intentionally closed.
    // Retain the actual persisted artifact, then remove dedicated metadata to
    // exercise the legacy proof's exact-epoch rules independently of admission.
    const binding = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(opened.view.handle.runId) as string)
    for (const key of Object.keys(binding.sourceManifest)) if (key.startsWith('finalizationGeneration')) delete binding.sourceManifest[key]
    db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), opened.view.handle.runId)
    return { handle: opened.view.handle, artifact: artifactOf(receipt), contextId: prepared.contextId }
  }
  return { owner, db, selection, prepared, characterId, dispatch: dispatchSpy, response, run, task, artifactOf, invalidate: () => { current = false } }
}

import { GenerationRunRepository } from '../../repositories/generation-run-repository'
import { proveFinalizedCharacterGeneration } from '../finalized-character-generation-proof'
import { proveCharacterProposal } from '../generation-character-proposal-proof'
import { CharacterProposalService, findCharacterProposalEvidence } from '../character-proposal-service'
import type { FinalizationGenerationContext } from '../../../src/shared/finalization-generation'
import type { CharacterProposalSource } from '../../../src/shared/character-proposal'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'

async function occurrence(dedicated = true) {
  const f = fixture(async (_request, options) => {
    options.onVisible({ kind: 'delta', text: JSON.stringify({ updates: [{ name: '林岚', currentState: { location: '北塔' }, evidence: { text: prose } }] }) })
    return { finishReason: 'stop', usage: null }
  })
  const request = await f.run(), runs = new GenerationRunRepository(() => f.db)
  const context: FinalizationGenerationContext = { slot: { source: f.prepared.context.source, stepKey: 'character_cards' },
    identity: f.prepared.context, chapterTitle: '北塔', chapterEntities: ['林岚'], writingLanguage: 'zh-CN',
    template: { key: 'character_state_update', name: '合成角色状态', description: '测试冻结模板', variables: {}, content: '合成冻结模板' },
    notesBaseline: { blueprint: { exists: true, notes: '' }, continuityHash: textHash('') } }
  // Simulate only the new main-issued manifest and stored resume identity. The owner admission/transition is tested separately.
  const updateBinding = (update: (binding: ReturnType<typeof runs.get>['binding']) => void) => {
    const binding = runs.get(request.handle.runId).binding
    update(binding)
    f.db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), request.handle.runId)
  }
  if (dedicated) updateBinding(binding => Object.assign(binding.sourceManifest, { finalizationGenerationContext: context,
    finalizationGenerationContextHash: textHash(JSON.stringify(context)), finalizationGenerationOriginEpoch: 'epoch' }))
  let activeEpoch = 'epoch', writable = true
  const currentHandle = (): MainGenerationRunHandle => ({ ...request.handle, epoch: runs.get(request.handle.runId).binding.epoch })
  const gate = vi.fn((handle: MainGenerationRunHandle) => {
    expect(handle).toEqual(currentHandle())
    if (!writable || handle.epoch !== activeEpoch) throw new Error('CURRENT_WRITE_AUTHORITY_REQUIRED')
  })
  const prove = (source: CharacterProposalSource, forWrite: boolean) => proveCharacterProposal(f.db, runs, 'project', source, forWrite, gate)
  const characters = new CharacterProposalService(f.db, 'project', prove)
  const source = (handle = request.handle): Extract<CharacterProposalSource, { kind: 'finalized-generation' }> => ({ kind: 'finalized-generation', handle, artifact: request.artifact })
  const resume = () => { updateBinding(binding => { binding.epoch = 'epoch-2' }); activeEpoch = 'epoch-2'; return currentHandle() }
  return { ...f, request, runs, context, updateBinding, characters, gate, prove, source, resume, currentHandle,
    blockWrites: () => { writable = false }, proof: (handle = request.handle) => proveFinalizedCharacterGeneration(f.db, runs, 'project', handle, request.artifact) }
}

describe('finalized proposal immutable evidence and live write authority', () => {
  it('rediscovers only pending finalized proposals after the service is reopened', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    const otherProof = { items: [], sourceHash: textHash('import'), provenance: null }
    const otherBatch = { proposalBatchId: 'import-batch', revision: batch.revision, status: 'pending-approval' as const,
      source: { kind: 'import' as const, operationId: 'import' }, items: [] }
    const otherEnvelope = JSON.stringify({ version: 1, projectId: 'project', proof: otherProof, batch: otherBatch })
    f.db.prepare('INSERT INTO character_identity_proposals(proposal_id,owner_character_id,source_key,source_hash,raw_value,candidate_ids_json) VALUES(?,NULL,?,?,?,?)')
      .run(otherBatch.proposalBatchId, 'character-proposal-v1:project', textHash(otherEnvelope), otherEnvelope, '[]')

    const reopened = new CharacterProposalService(f.db, 'project', source => source.kind === 'import' ? otherProof : f.prove(source, false))
    expect(reopened.listPendingFinalized()).toEqual([{ proposalBatchId: batch.proposalBatchId, revision: batch.revision,
      finalizationId: f.prepared.context.source.finalizationId }])
    expect(reopened.readPendingFinalized(batch.proposalBatchId)).toEqual(batch)
  })

  it('keeps same-name finalized occurrences unresolved until the author maps an explicit character ID', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    expect(batch.items[0]?.fields.name).toBe('林岚')
    expect(batch.items[0]?.resolution).toEqual({ status: 'unresolved', candidateIds: [] })
  })

  it('hides an old chapter finalization and rejects direct read, approve, and cancel without returning candidates', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    f.db.exec("INSERT INTO contents(id,body) VALUES(2,'新定稿'); INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'draft',2,3)")
    FinalizationRepository.commit({ finalizationId: 'finalized-2', draftId: 2, chapterNumber: 1, chapterTitle: '新北塔',
      content: '新定稿', contentHash: textHash('新定稿'), contentRevision: 1, targetFileName: '第一章-新版.txt' })
    const decision = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'stale-approve',
      selections: [{ selectionKey: batch.items[0]!.selectionKey, action: 'map' as const, characterId: f.characterId }] }

    expect(f.characters.listPendingFinalized()).toEqual([])
    expect(() => f.characters.readPendingFinalized(batch.proposalBatchId)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(() => f.characters.approve(decision)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    expect(() => f.characters.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision }))
      .toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
  })

  it('fails closed when the finalized outbox hash changes', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    f.db.prepare('UPDATE finalization_outbox SET content_hash=? WHERE finalization_id=?')
      .run('0'.repeat(64), f.prepared.context.source.finalizationId)
    expect(f.characters.listPendingFinalized()).toEqual([])
    expect(() => f.characters.readPendingFinalized(batch.proposalBatchId)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
  })

  it('normalizes a changed finalized generation source to the public stale-source error', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    f.updateBinding(binding => {
      const manifest = binding.sourceManifest as Record<string, unknown>
      const context = manifest.finalizationGenerationContext as FinalizationGenerationContext
      context.slot.source = { ...context.slot.source, contentHash: '0'.repeat(64) }
      manifest.finalizationGenerationContextHash = textHash(JSON.stringify(context))
    })
    expect(f.characters.listPendingFinalized()).toEqual([])
    expect(() => f.characters.readPendingFinalized(batch.proposalBatchId)).toThrow('CHARACTER_PROPOSAL_SOURCE_CHANGED')
  })

  it('cancels with revision CAS, replays exactly, and stays hidden after reopen', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source())
    expect(() => f.characters.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision + 1 }))
      .toThrow('CHARACTER_ID_REVISION_CONFLICT')
    const cancelled = f.characters.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision })
    expect(cancelled.status).toBe('cancelled')
    expect(f.characters.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision })).toEqual(cancelled)
    expect(() => f.characters.cancel({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision + 1 }))
      .toThrow('CHARACTER_ID_REVISION_CONFLICT')
    const reopened = new CharacterProposalService(f.db, 'project', f.prove)
    expect(reopened.listPendingFinalized()).toEqual([])
  })

  it('keeps the original context and provenance epoch while resolving the actual resumed run handle', async () => {
    const f = await occurrence(), original = JSON.stringify(f.prepared.context), current = f.resume()
    for (const handle of [f.request.handle, current]) {
      const proof = f.proof(handle)
      expect(JSON.stringify(proof.context)).toBe(original)
      expect(proof.sourceHandle).toEqual(f.request.handle)
      expect(proof.currentHandle).toEqual(current)
      expect(proof.stableFinalizationSource).toBe(true)
    }
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('retains the exact epoch requirement for the legacy branch', async () => {
    const f = await occurrence(false)
    expect(f.proof().stableFinalizationSource).toBe(false)
    const current = f.resume()
    expect(() => f.proof()).toThrow('CHARACTER_PROPOSAL_SOURCE_INVALID')
    expect(() => f.proof(current)).toThrow('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
  })

  it.each(['missing-context', 'hash', 'origin', 'slot', 'source', 'identity', 'field-scope'] as const)('rejects a dedicated %s mismatch without granting a write', async kind => {
    const f = await occurrence()
    f.updateBinding(binding => {
      const manifest = binding.sourceManifest as Record<string, unknown>, context = manifest.finalizationGenerationContext as FinalizationGenerationContext
      if (kind === 'missing-context') delete manifest.finalizationGenerationContext
      if (kind === 'hash') manifest.finalizationGenerationContextHash = '0'.repeat(64)
      if (kind === 'origin') manifest.finalizationGenerationOriginEpoch = 'forged-origin'
      if (kind === 'slot') context.slot.stepKey = 'chapter_notes'
      if (kind === 'source') context.slot.source = { ...context.slot.source, contentHash: '0'.repeat(64) }
      if (kind === 'identity') context.identity.epoch = 'forged-origin'
      if (kind === 'field-scope') {
        context.identity.characters[0]!.fields[0]!.epoch = 'other-scope'
        const serialized = JSON.stringify(context.identity)
        manifest.authorInputs = [{ id: 'finalized-character-context', text: serialized }]
        manifest.finalizedCharacterContextHash = textHash(serialized)
      }
      if (!['missing-context', 'hash'].includes(kind)) manifest.finalizationGenerationContextHash = textHash(JSON.stringify(context))
    })
    const before = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(() => f.characters.stage(f.source())).toThrow('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
    expect(f.gate).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
  })

  it.each(['projectId', 'epoch', 'rootActionId', 'runId'] as const)('rejects a forged %s instead of treating it as historical authority', async field => {
    const f = await occurrence(); f.resume()
    const before = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(() => f.characters.stage(f.source({ ...f.request.handle, [field]: 'forged' }))).toThrow()
    expect(f.gate).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
  })

  it('uses one stable proposal ID across resume and returns its historical ACK without a write gate', async () => {
    const f = await occurrence(), first = f.characters.stage(f.source()), current = f.resume()
    const calls = f.gate.mock.calls.length
    f.blockWrites()
    const before = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(f.characters.read(first.proposalBatchId)).toEqual(first)
    expect(f.characters.stage(f.source(current))).toEqual(first)
    expect(findCharacterProposalEvidence(f.db, f.source(current), (_projectId, source) => f.prove(source, false)))
      .toEqual(f.characters.evidence(first.proposalBatchId))
    expect(f.gate).toHaveBeenCalledTimes(calls)
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
    expect(f.db.prepare("SELECT COUNT(*) FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").pluck().get()).toBe(1)
    const envelope = JSON.parse(f.db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?').pluck().get(first.proposalBatchId) as string)
    expect(envelope.proof.provenance.source.epoch).toBe('epoch')
  })

  it('checks the actual current handle for new stage and pending approval', async () => {
    const f = await occurrence(), current = f.resume(), batch = f.characters.stage(f.source())
    expect(f.gate).toHaveBeenLastCalledWith(current)
    f.blockWrites()
    const before = f.db.prepare('SELECT total_changes()').pluck().get()
    expect(() => f.characters.approve({ proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: 'confirm', selections: [{ selectionKey: batch.items[0]!.selectionKey, action: 'map', characterId: f.characterId }] }))
      .toThrow('CURRENT_WRITE_AUTHORITY_REQUIRED')
    expect(f.gate).toHaveBeenLastCalledWith(current)
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
  })

  it('does not let an origin handle bypass current authority for a new proposal', async () => {
    const f = await occurrence(); f.resume(); f.blockWrites()
    expect(() => f.characters.stage(f.source())).toThrow('CURRENT_WRITE_AUTHORITY_REQUIRED')
    expect(f.db.prepare("SELECT COUNT(*) FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").pluck().get()).toBe(0)
  })

  it('keeps author names and replays an approved exact decision without current fact writes', async () => {
    const f = await occurrence(); f.resume()
    const batch = f.characters.stage(f.source())
    f.db.prepare('UPDATE characters SET name=? WHERE character_id=?').run('作者的新名字', f.characterId)
    const request = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision, operationId: 'confirm',
      selections: [{ selectionKey: batch.items[0]!.selectionKey, action: 'map' as const, characterId: f.characterId }] }
    expect(() => f.characters.approve({ ...request, expectedRevision: batch.revision + 1 }))
      .toThrow('CHARACTER_ID_REVISION_CONFLICT')
    const first = f.characters.approve(request)
    f.blockWrites(); f.db.prepare('UPDATE characters SET cs_location=? WHERE character_id=?').run('作者后改的位置', f.characterId)
    const before = f.db.prepare('SELECT total_changes()').pluck().get(), calls = f.gate.mock.calls.length
    expect(f.characters.approve(request)).toEqual(first)
    expect(() => f.characters.approve({ ...request, operationId: 'other-decision' })).toThrow('CHARACTER_APPROVAL_NONCE_CONFLICT')
    expect(f.gate).toHaveBeenCalledTimes(calls)
    expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
    expect(f.db.prepare('SELECT name,cs_location FROM characters WHERE character_id=?').get(f.characterId))
      .toEqual({ name: '作者的新名字', cs_location: '作者后改的位置' })
  })

  it('does not trust a historical envelope whose epoch was altered even with a recomputed row hash', async () => {
    const f = await occurrence(), batch = f.characters.stage(f.source()); f.resume()
    const envelope = JSON.parse(f.db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?').pluck().get(batch.proposalBatchId) as string)
    envelope.batch.source.handle.epoch = 'forged'
    const serialized = JSON.stringify(envelope)
    f.db.prepare('UPDATE character_identity_proposals SET raw_value=?,source_hash=? WHERE proposal_id=?').run(serialized, textHash(serialized), batch.proposalBatchId)
    expect(() => f.characters.read(batch.proposalBatchId)).toThrow('CHARACTER_PROPOSAL_SOURCE_INVALID')
  })

  it('keeps the existing stage write gate for an old finalized-generation source', async () => {
    const f = await occurrence(false); f.characters.stage(f.source()); f.blockWrites()
    expect(() => f.characters.stage(f.source())).toThrow('CURRENT_WRITE_AUTHORITY_REQUIRED')
  })
})
