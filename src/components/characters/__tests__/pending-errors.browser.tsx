/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import type { PendingFinalizedCharacterStateCandidate } from '../../../shared/finalized-continuity'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { usePendingCharacterProposals } from '../use-pending-character-proposals'
import { usePendingStateCandidates } from '../use-pending-state-candidates'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: ProjectSessionContext = { projectId: 'lighthouse', projectPath: 'C:/novels/lighthouse', leaseId: 'lease-1' }
const batch = { proposalBatchId: 'cpb:1', revision: 3, status: 'pending-approval', source: { kind: 'import', operationId: 'op' }, items: [] } as unknown as CharacterProposalBatch
const candidate = {
  source: { draftId: 7 }, candidateKey: 'k', characterId: 'c1', field: 'location', expectedFieldRevision: 1, expectedFieldValueHash: 'h',
} as unknown as PendingFinalizedCharacterStateCandidate
const rejected = (channel: string, code: string) => new Error(`Error invoking remote method '${channel}': Error: ${code}`)
const rawCode = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u
const han = /\p{Script=Han}/u

let root: Root
let host: HTMLDivElement
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
const latest = {} as { proposals: ReturnType<typeof usePendingCharacterProposals>; states: ReturnType<typeof usePendingStateCandidates> }
const originalLocale = useLocaleStore.getState()

function Pending() {
  const proposals = usePendingCharacterProposals(session)
  const states = usePendingStateCandidates(session)
  useEffect(() => { latest.proposals = proposals; latest.states = states })
  return null
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US' })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-proposal:read-pending-finalized') return batch
    if (channel === 'finalized-character:read-state-candidate') return candidate
    if (channel === 'character-proposal:approve') throw rejected(channel, 'CHARACTER_ID_REVISION_CONFLICT')
    if (channel === 'finalized-character:decide-state-candidate') throw rejected(channel, 'FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
    return []
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocale, true)
})

it('explains a rejected proposal approval in English without the raw main-process code (#474)', async () => {
  await act(async () => root.render(<Pending />))
  await settle()
  await act(async () => { await latest.proposals.read({ proposalBatchId: 'cpb:1', revision: 3, importOperationId: 'op', itemCount: 1 }) })
  await act(async () => { await latest.proposals.decide('approve') })
  await settle()

  expect(latest.proposals.error).toMatch(/cast changed/iu)
  expect(latest.proposals.error).not.toMatch(rawCode)
  expect(latest.proposals.error).not.toMatch(han)
})

it('explains a rejected state suggestion in English without the raw main-process code (#474)', async () => {
  await act(async () => root.render(<Pending />))
  await settle()
  await act(async () => { await latest.states.read({ draftId: 7, candidateKey: 'k' } as never) })
  await act(async () => { await latest.states.decide('accept') })
  await settle()

  expect(latest.states.error).toMatch(/changed after this suggestion/iu)
  expect(latest.states.error).not.toMatch(rawCode)
  expect(latest.states.error).not.toMatch(han)
})

it('keeps a list failure readable in English when the code has no dedicated copy (#474)', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'character-proposal:list-pending-finalized') throw rejected(channel, 'GENERATION_PROJECT_SESSION_STALE')
    return []
  })
  await act(async () => root.render(<Pending />))
  await settle()

  expect(latest.proposals.error).toMatch(/switched or reopened/iu)
  expect(latest.proposals.error).not.toMatch(/Error invoking remote method/u)
})
