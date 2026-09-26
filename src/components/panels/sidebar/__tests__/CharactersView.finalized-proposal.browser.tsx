import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterProposalBatch } from '../../../../shared/character-proposal'
import type { PendingFinalizedCharacterStateCandidate } from '../../../../shared/finalized-continuity'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import CharactersView from '../CharactersView'

const project = { id: 'proposal-project', path: 'C:\\novels\\proposal-project', sessionLease: 'proposal-lease' } as ProjectData
const identity = { characterId: 'character-author', name: '作者角色', role: 'protagonist', gender: '', age: '', appearance: '',
  personality: '', background: '作者静态字段', abilities: '', motivation: '', relationships: '', arc: '', notes: '' } satisfies CharacterCard
const batch: CharacterProposalBatch = { proposalBatchId: 'cpb:pending-finalized', revision: 4, status: 'pending-approval',
  source: { kind: 'finalized-generation', handle: { projectId: project.id, epoch: project.sessionLease!, rootActionId: 'root', runId: 'run' },
    artifact: { artifactId: 'artifact', revision: 1, textHash: 'a'.repeat(64) } },
  items: [{ selectionKey: 'unknown-1', sourceId: 'finalization-1:artifact:unknown-1', fields: { name: '生成候选', background: '不得泄露到 stale UI' },
    relationships: [], resolution: { status: 'unresolved', candidateIds: [] } }] }
const originals = { character: useCharacterStore.getState(), locale: useLocaleStore.getState(), project: useProjectStore.getState() }
let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let loadCharacters: ReturnType<typeof vi.fn<ReturnType<typeof useCharacterStore.getState>['load']>>
let pending = true
let statePending = true
const stateCandidate: PendingFinalizedCharacterStateCandidate = {
  candidateKey: 'fcs-state:pending-location', characterId: identity.characterId!, characterName: identity.name,
  displayName: identity.name, selectionKey: `state:${identity.characterId}:location`, field: 'location', value: '北塔',
  reason: 'author-protected', expectedFieldRevision: 3, expectedFieldValueHash: 'b'.repeat(64),
  source: { draftId: 7, finalizationId: 'finalization-state-7', chapterNumber: 7, contentHash: 'c'.repeat(64) },
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  pending = true
  statePending = true
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-proposal:list-pending-finalized') return pending
      ? [{ proposalBatchId: batch.proposalBatchId, revision: batch.revision, finalizationId: 'finalization-1' }] : []
    if (channel === 'character-proposal:read-pending-finalized') return batch
    if (channel === 'character-proposal:approve') { pending = false; return { batch: { ...batch, status: 'approved' }, created: [] } }
    if (channel === 'character-proposal:cancel') { pending = false; return { ...batch, status: 'cancelled' } }
    if (channel === 'finalized-character:list-state-candidates') return statePending ? [{ draftId: 7,
      candidateKey: stateCandidate.candidateKey, finalizationId: stateCandidate.source.finalizationId,
      characterId: stateCandidate.characterId, characterName: stateCandidate.characterName, field: stateCandidate.field }] : []
    if (channel === 'finalized-character:read-state-candidate') return stateCandidate
    if (channel === 'finalized-character:decide-state-candidate') { statePending = false; return { candidateKey: stateCandidate.candidateKey,
      operationId: 'decision', payloadHash: 'd'.repeat(64), decision: 'accept', source: stateCandidate.source, idempotent: false } }
    return null
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  useLocaleStore.setState({ ...originals.locale, locale: 'en-US', initialized: true })
  useProjectStore.setState({ ...originals.project, currentProject: project })
  loadCharacters = vi.fn<ReturnType<typeof useCharacterStore.getState>['load']>().mockResolvedValue(undefined)
  useCharacterStore.setState({ ...originals.character, characters: [identity], dataProjectKey: project.path,
    loadingProjectKey: null, lastError: null, identityBusy: false, load: loadCharacters })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<CharactersView />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useCharacterStore.setState(originals.character)
  useLocaleStore.setState(originals.locale)
  useProjectStore.setState(originals.project)
})

describe('CharactersView finalized proposal recovery', () => {
  it('reopens a protected state suggestion and accepts it through the source-bound decision IPC', async () => {
    await vi.waitFor(() => expect(container.textContent).toContain('Pending state suggestions (1)'))
    await act(async () => page.getByRole('button', { name: 'Review finalized state suggestion' }).click())
    await vi.waitFor(() => expect(container.textContent).toContain('北塔'))
    await act(async () => page.getByRole('button', { name: 'Accept state suggestion' }).click())
    await vi.waitFor(() => expect(container.textContent).not.toContain('Pending state suggestions (1)'))
    expect(invoke).toHaveBeenCalledWith('finalized-character:read-state-candidate', {
      draftId: 7, candidateKey: stateCandidate.candidateKey,
    }, expect.objectContaining({ leaseId: project.sessionLease }))
    expect(invoke).toHaveBeenCalledWith('finalized-character:decide-state-candidate', expect.objectContaining({
      draftId: 7, candidateKey: stateCandidate.candidateKey, characterId: stateCandidate.characterId, field: 'location',
      expectedFieldRevision: 3, expectedFieldValueHash: stateCandidate.expectedFieldValueHash, decision: 'accept',
    }), expect.objectContaining({ leaseId: project.sessionLease }))
    expect(loadCharacters).toHaveBeenCalledWith(project.path, expect.objectContaining({ leaseId: project.sessionLease }))
  })

  it('lists after reopen, reads by ID, maps by characterId, approves, and refreshes the list through IPC', async () => {
    await vi.waitFor(() => expect(container.textContent).toContain('Pending finalized character decisions (1)'))
    await act(async () => page.getByRole('button', { name: 'Review finalized character decision' }).click())
    await vi.waitFor(() => expect(container.textContent).toContain('生成候选'))
    await act(async () => page.getByRole('combobox', { name: /Adoption:/ }).selectOptions(`map:${identity.characterId}`))
    await act(async () => page.getByRole('button', { name: 'Accept decisions' }).click())
    await vi.waitFor(() => expect(container.textContent).not.toContain('Pending finalized character decisions (1)'))
    expect(invoke).toHaveBeenCalledWith('character-proposal:read-pending-finalized',
      { proposalBatchId: batch.proposalBatchId }, expect.objectContaining({ leaseId: project.sessionLease }))
    expect(invoke).toHaveBeenCalledWith('character-proposal:approve', expect.objectContaining({
      proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: `finalized-character-adoption:${batch.proposalBatchId}`,
      selections: [{ selectionKey: 'unknown-1', action: 'map', characterId: identity.characterId }],
    }), expect.objectContaining({ leaseId: project.sessionLease }))
    expect(loadCharacters).toHaveBeenCalledWith(project.path, expect.objectContaining({ leaseId: project.sessionLease }))
  })

  it('shows a failed stale read without leaking candidate fields', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'character-proposal:list-pending-finalized') return [{ proposalBatchId: batch.proposalBatchId,
        revision: batch.revision, finalizationId: 'finalization-1' }]
      if (channel === 'character-proposal:read-pending-finalized') throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
      return null
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Pending finalized character decisions (1)'))
    await act(async () => page.getByRole('button', { name: 'Review finalized character decision' }).click())
    await vi.waitFor(() => expect(container.textContent).toContain('CHARACTER_PROPOSAL_SOURCE_CHANGED'))
    expect(container.textContent).not.toContain('生成候选')
    expect(container.textContent).not.toContain('不得泄露到 stale UI')
  })

  it('cancels with revision CAS and refreshes the pending list', async () => {
    await vi.waitFor(() => expect(container.textContent).toContain('Pending finalized character decisions (1)'))
    await act(async () => page.getByRole('button', { name: 'Review finalized character decision' }).click())
    await vi.waitFor(() => expect(container.textContent).toContain('生成候选'))
    await act(async () => page.getByRole('button', { name: 'Reject decisions' }).click())
    await vi.waitFor(() => expect(container.textContent).not.toContain('Pending finalized character decisions (1)'))
    expect(invoke).toHaveBeenCalledWith('character-proposal:cancel', {
      proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
    }, expect.objectContaining({ leaseId: project.sessionLease }))
  })
})
