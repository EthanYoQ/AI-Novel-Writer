import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import VersionHistory from '../VersionHistory'

const PROJECT_PATH = 'C:\\novels\\version-history-locale'
const PROJECT_SESSION = Object.freeze({
  projectId: 'version-history-locale',
  leaseId: 'version-history-locale-lease',
  projectPath: PROJECT_PATH,
})
const createdAt = '2026-09-05T10:15:00.000Z'
const dateOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
} as const

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({
    currentProject: {
      id: PROJECT_SESSION.projectId,
      name: 'Version history locale',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: {},
    } as never,
  })
  setActiveProjectSessionContext(PROJECT_SESSION)
  invoke = vi.fn()
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  vi.restoreAllMocks()
})

describe('VersionHistory locale', () => {
  it('renders loading, versions, actions, counts, dates, and both reachable empty states in English', async () => {
    let resolveBlueprints: ((value: Array<{ chapterNumber: number; title: string }>) => void) | undefined
    const blueprints = new Promise<Array<{ chapterNumber: number; title: string }>>((resolve) => {
      resolveBlueprints = resolve
    })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-get-all') return blueprints
      if (channel === 'db:draft-list') {
        return args[0] === 2
          ? [
              { id: 21, version: 1, status: 'draft', wordCount: 1234, createdAt },
              { id: 22, version: 2, status: 'revised', wordCount: 1250, createdAt },
              { id: 23, version: 3, status: 'finalized', wordCount: 1300, createdAt },
            ]
          : []
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await act(async () => root.render(<VersionHistory projectKey={PROJECT_PATH} />))
    expect(container.textContent).toContain('Loading...')

    await act(async () => resolveBlueprints?.([
      { chapterNumber: 2, title: '' },
      { chapterNumber: 3, title: 'No Versions' },
    ]))
    await vi.waitFor(() => expect(container.textContent).toContain('Chapter list'))
    expect(container.textContent).toContain('Chapter 2')
    expect(container.textContent).toContain('Select a chapter')

    const chapterRows = Array.from(container.querySelectorAll<HTMLElement>('.cursor-pointer'))
    await act(async () => chapterRows[0]?.click())
    await vi.waitFor(() => expect(container.textContent).toContain('Version history'))

    expect(container.textContent).toContain('Draft')
    expect(container.textContent).toContain('Revised')
    expect(container.textContent).toContain('Final')
    expect(container.textContent).toContain('1,234 words')
    expect(container.textContent).toContain(new Date(createdAt).toLocaleString('en-US', dateOptions))
    expect(container.querySelector('[title="Compare with current version"]')).not.toBeNull()
    expect(container.querySelector('[title="Revert to this version"]')).not.toBeNull()

    await act(async () => chapterRows[1]?.click())
    await vi.waitFor(() => expect(container.textContent).toContain('No version history'))
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('renders the chapter-list empty state in English', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:blueprint-get-all') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await act(async () => root.render(<VersionHistory projectKey={PROJECT_PATH} />))

    await vi.waitFor(() => expect(container.textContent).toContain('No chapters yet'))
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})
