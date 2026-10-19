/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { usePendingCharacterProposals } from '../use-pending-character-proposals'
import { usePendingStateCandidates } from '../use-pending-state-candidates'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LIST_CHANNELS = ['character-proposal:list-pending-finalized', 'finalized-character:list-state-candidates']
const previous: ProjectSessionContext = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '上一次打开' }
const current: ProjectSessionContext = { ...previous, leaseId: '这一次打开' }

let root: Root
let host: HTMLDivElement
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

function Pending({ session }: { session: ProjectSessionContext }) {
  const proposals = usePendingCharacterProposals(session)
  const states = usePendingStateCandidates(session)
  return <p>{proposals.error || states.error || 'ok'}</p>
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const listCalls = () => invoke.mock.calls.filter(([channel]) => LIST_CHANNELS.includes(channel))

beforeEach(() => {
  invoke = vi.fn(async () => [])
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setActiveProjectSessionContext(null)
})

it('does not send pending-list reads for a session that was replaced before they fired (#375)', async () => {
  setActiveProjectSessionContext(current)
  await act(async () => root.render(<Pending session={previous} />))
  await settle()
  expect(listCalls()).toEqual([])
  expect(host.textContent).toBe('ok')

  await act(async () => root.render(<Pending session={current} />))
  await settle()
  expect(listCalls().map(([channel]) => channel).sort()).toEqual([...LIST_CHANNELS].sort())
})
