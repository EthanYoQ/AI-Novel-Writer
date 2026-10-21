import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { LegacyRosterRecoveryPanel } from '../LegacyRosterRecoveryPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: 'lighthouse', path: 'C:/novels/lighthouse', sessionLease: 'lease-1' } as ProjectData
const rawCode = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u
const han = /\p{Script=Han}/u

let root: Root
let host: HTMLDivElement
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US' })
  useProjectStore.setState({ currentProject: project })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  const invoke = vi.fn(async (channel: string) => {
    throw new Error(`Error invoking remote method '${channel}': Error: GENERATION_PROJECT_SESSION_STALE`)
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
  useProjectStore.setState(originalProject, true)
  useLocaleStore.setState(originalLocale, true)
})

it('explains an unreadable recovery run in English without the raw main-process code (#474)', async () => {
  await act(async () => root.render(<LegacyRosterRecoveryPanel busy={false} onRecover={async () => {}} />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

  const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
  expect(alert).toMatch(/could not be read/iu)
  expect(alert).toMatch(/switched or reopened/iu)
  expect(alert).not.toMatch(rawCode)
  expect(alert).not.toMatch(han)
})
