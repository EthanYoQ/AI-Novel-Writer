import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type Database from 'better-sqlite3'
import type { GenerationOwnerChannels } from '../../src/shared/generation-owner-contract'
import type { CharacterProposalChannels } from '../../src/shared/character-proposal'
import type { FinalizedCharacterGenerationChannels } from '../../src/shared/finalized-character-generation'
import { generationOutputContract } from '../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { getBuiltinPromptTemplate } from '../../src/services/builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../src/shared/builtin-writing-skills'
import { getProjectDb, getCurrentProjectPath, onProjectDatabaseBeforeClose } from '../database'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { getProjectDataRoot } from '../services/project-data-locator'
import { projectAccess } from '../services/project-access'
import { ModelExecutionLeaseRegistry } from '../services/model-execution-lease'
import { createMainGenerationOwner } from '../services/main-generation-owner'
import { MAIN_GENERATION_POLICY } from '../services/main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../services/generation-source-binding'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { BlueprintRangeCommitReceipt } from '../repositories/blueprint-repository'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import { withKnowledgeSourceGate } from '../services/knowledge-source-gate'
import { knowledgeBaseLoader } from '../services/knowledge-base-loader'
import { getEmbeddingConfig } from './kb-controller'

type Owner = ReturnType<typeof createMainGenerationOwner>
type OwnerChannels = GenerationOwnerChannels & CharacterProposalChannels & FinalizedCharacterGenerationChannels
const owners = new Map<Database.Database, { owner: Owner; session: ProjectSessionContext; subscribers: Set<WebContents> }>()
const ownerSessions = new WeakMap<Owner, ProjectSessionContext>()
/** Called synchronously inside the same SQLite transaction as the formal effect. */
export function assertGenerationSourcesCurrent(handle: MainGenerationRunHandle, blueprintRange?: { startChapter: number; endChapter: number }): void {
  const database = getProjectDb()
  const entry = database && owners.get(database)
  if (!entry) throw new Error('GENERATION_OWNER_REQUIRED')
  entry.owner.assertSourcesCurrent(handle, blueprintRange)
}
export function recordGenerationDirectoryCommit(handle: MainGenerationRunHandle, requestedRange: { startChapter: number; endChapter: number }, receipt: BlueprintRangeCommitReceipt) {
  const database = getProjectDb(), entry = database && owners.get(database)
  if (!entry || !database?.inTransaction) throw new Error('GENERATION_DIRECTORY_TRANSACTION_REQUIRED')
  return entry.owner.recordDirectoryCommit(handle, requestedRange, receipt)
}

export function registerGenerationController(options: {
  modelExecutionLeases: ModelExecutionLeaseRegistry
  loadModel: (id: string) => ModelProfile | null
  applyProxyConfig: () => void
}) {
  onProjectDatabaseBeforeClose(({ database }) => {
    const entry = owners.get(database)
    if (entry) { entry.owner.suspendForProjectClose(); owners.delete(database) }
  })
  const authorizedOwner = (session: ProjectSessionContext, event: IpcMainInvokeEvent) => {
    projectAccess.assertCurrentProjectContext(session, getCurrentProjectPath())
    const database = getProjectDb()
    if (!database) throw new Error('GENERATION_DATABASE_NOT_READY')
    let entry = owners.get(database)
    if (entry && (entry.session.projectId !== session.projectId || entry.session.leaseId !== session.leaseId)) {
      entry.owner.suspendForProjectClose()
      owners.delete(database)
      entry = undefined
    }
    if (!entry) {
      const captured = Object.freeze({ ...session })
      const subscribers = new Set<WebContents>()
      const sourceDependencies = { db: database, projectStorageRoot: getProjectDataRoot(captured.projectPath),
        globalDataRoot: getGlobalDataRoot(), readBuiltinSkill: readBuiltinWritingSkill,
        readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => {
          const template = getBuiltinPromptTemplate(key, language)
          if (!template) throw new Error('GENERATION_BUILTIN_PROMPT_MISSING')
          return JSON.stringify(template)
        } }
      const owner = createMainGenerationOwner({ database, projectId: captured.projectId, epoch: captured.leaseId,
        assertCurrent: () => { projectAccess.assertCurrentProjectContext(captured, getCurrentProjectPath());
          if (getProjectDb() !== database) throw new Error('GENERATION_DATABASE_CHANGED') },
        leases: options.modelExecutionLeases, loadModel: options.loadModel, beforeDispatch: options.applyProxyConfig,
        buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(sourceDependencies, { ...selection,
          projectId: captured.projectId, epoch: captured.leaseId, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
        rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDependencies, previous, captured.leaseId,
          modelReceipt, MAIN_GENERATION_POLICY).binding,
        onSnapshot: snapshot => { for (const subscriber of subscribers) {
          if (subscriber.isDestroyed()) subscribers.delete(subscriber)
          else subscriber.send('generation:snapshot', snapshot)
        } },
      })
      entry = { owner, session: captured, subscribers }
      ownerSessions.set(owner, captured)
      owners.set(database, entry)
    }
    entry.subscribers.add(event.sender)
    return entry.owner
  }
  const guardKnowledge = async <T>(owner: Owner, snapshot: GenerationKnowledgeSnapshot | undefined, operation: () => T | Promise<T>): Promise<T> => {
    if (!snapshot) return operation()
    const session = ownerSessions.get(owner)!
    const projectStorageRoot = getProjectDataRoot(session.projectPath)
    return withKnowledgeSourceGate(projectStorageRoot, async () => {
      const { verifyGenerationKnowledge } = await import('../services/generation-knowledge-source')
      await verifyGenerationKnowledge({ projectStorageRoot, snapshot })
      projectAccess.assertCurrentProjectContext(session, getCurrentProjectPath())
      return operation()
    })
  }
  function register<C extends keyof OwnerChannels>(channel: C, arity: number,
    handler: (owner: Owner, ...args: OwnerChannels[C]['args']) => OwnerChannels[C]['return'] | Promise<OwnerChannels[C]['return']>) {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      try {
        const session = raw.pop()
        if (!isProjectSessionContext(session) || raw.length !== arity && !(channel === 'generation:compose-visible' && raw.length === 3)) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
        const result = await handler(authorizedOwner(session, event), ...raw as OwnerChannels[C]['args'])
        projectAccess.assertCurrentProjectContext(session, getCurrentProjectPath())
        return result
      } catch (error) {
        const code = error instanceof Error && /^(?:GENERATION|ROOT_BUDGET|ARTIFACT|MAIN|CHARACTER|FINALIZED_CHARACTER)_[A-Z_]+$/u.test(error.message)
          ? error.message : 'GENERATION_REQUEST_FAILED'
        throw new Error(code)
      }
    })
  }
  register('generation:prepare-draft-context', 1, async (owner, request) => {
    const baseline = owner.draftPreparationBinding(request)
    const session = ownerSessions.get(owner)!
    const kb = await knowledgeBaseLoader.load()
    const knowledge = await kb.captureWritingKnowledgeSnapshot(request.query, session.projectPath, getEmbeddingConfig())
    return guardKnowledge(owner, knowledge, () => owner.prepareDraftContext(request, knowledge, baseline))
  })
  register('generation:begin', 1, (owner, request) => {
    if (request.operation === 'chapter-draft' && !request.preparationId) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    return guardKnowledge(owner, request.preparationId ? owner.preparedKnowledge(request.preparationId) : undefined, () => owner.begin(request))
  })
  register('character-proposal:stage', 1, (owner, request) => owner.characterProposals.stage(request.source))
  register('character-proposal:read', 1, (owner, request) => owner.characterProposals.read(request.proposalBatchId))
  register('character-proposal:approve', 1, (owner, request) => owner.characterProposals.approve(request))
  register('character-proposal:cancel', 1, (owner, request) => owner.characterProposals.cancel(request.proposalBatchId))
  register('character-identity:read', 0, owner => owner.characterProposals.identitySnapshot())
  register('finalized-character:read-context', 1, (owner, request) => owner.readFinalizedCharacterContext(request.draftId))
  register('finalized-character:commit', 1, (owner, request) => owner.commitFinalizedCharacterStates(request))
  register('generation:execute', 1, async (owner, request) => {
    const context = owner.readContext(request.handle)
    // Release the short KB guard after dispatch starts; author edits during generation remain possible.
    const started = await guardKnowledge(owner, context.knowledgeSnapshot, () => ({ result: owner.execute(request) }))
    return started.result
  })
  register('generation:read', 1, (owner, handle) => owner.read(handle))
  register('generation:compose-visible', 4, (owner, handle, ids, hash, algorithm) => owner.composeVisible(handle, ids, hash, algorithm))
  register('generation:commit-draft', 1, (owner, request) => {
    const context = owner.readContext(request.handle)
    return guardKnowledge(owner, context.savedDraft ? undefined : context.knowledgeSnapshot, () => owner.commitDraft(request))
  })
  register('generation:read-context', 1, (owner, request) => owner.readContext(request.handle))
  register('generation:begin-batch', 1, (owner, request) => owner.beginBatch(request))
  register('generation:read-batch', 1, (owner, request) => owner.readBatch(request.batchId))
  register('generation:list-batches', 0, owner => owner.listBatches())
  register('generation:confirm-batch-finalization', 1, (owner, request) => owner.confirmBatchFinalization(request))
  register('generation:read-visible-composition', 1, (owner, handle) => owner.readVisibleComposition(handle))
  register('generation:list', 0, owner => owner.list())
  register('generation:list-directory-progress', 0, owner => owner.listDirectoryProgress())
  register('generation:pause', 1, (owner, handle) => owner.pause(handle))
  register('generation:cancel', 1, (owner, handle) => owner.cancel(handle))
  register('generation:resume', 1, (owner, handle) => guardKnowledge(owner, owner.readContext(handle).knowledgeSnapshot, () => owner.resume(handle)))
  register('generation:restart', 2, (owner, handle, request) => {
    if (request.operation === 'chapter-draft' && !request.preparationId) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    return guardKnowledge(owner, request.preparationId ? owner.preparedKnowledge(request.preparationId) : undefined, () => owner.restart(handle, request))
  })
  register('generation:discard-candidate', 2, (owner, handle, artifactId) => owner.discardCandidate(handle, artifactId))
}
