import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  alertError: vi.fn(),
}))

vi.mock('../../../ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

import { openArtifactInEditor } from '../artifact-open'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'

const projectPath = 'C:\\novels\\same-project'

const originalLocale = useLocaleStore.getState().locale

function projectWithLease(leaseId: string) {
  return {
    id: 'same-project-id',
    sessionLease: leaseId,
    name: 'Same project',
    path: projectPath,
    novelConfig: {},
  } as never
}

beforeEach(() => {
  mocks.alertError.mockReset()
  useLocaleStore.setState({ locale: 'en-US' })
  useEditorStore.getState().clearTabs()
  useProjectStore.setState({ currentProject: projectWithLease('lease-B') })
  setActiveProjectSessionContext({
    projectId: 'same-project-id',
    leaseId: 'lease-B',
    projectPath,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useEditorStore.getState().clearTabs()
  useProjectStore.setState({ currentProject: null })
  setActiveProjectSessionContext(null)
  useLocaleStore.setState({ locale: originalLocale })
})

describe('agent artifact open session ownership', () => {
  it('presents artifact-open failures in the active application locale', async () => {
    await expect(openArtifactInEditor({
      type: 'file_modified',
      name: 'chapter_1.md',
      path: `${projectPath}\\manuscript\\chapter_1.md`,
    } as never)).resolves.toBe(false)

    expect(mocks.alertError).toHaveBeenCalledWith(
      'The artifact is missing source project information and cannot be opened safely.',
      { title: 'Cannot open artifact' },
    )
  })

  it('fails closed when a legacy artifact has no frozen project session', async () => {
    const invoke = vi.fn(async () => ({ success: true, content: 'should not be read' }))
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    await expect(openArtifactInEditor({
      type: 'file_modified',
      name: 'chapter_1.md',
      path: `${projectPath}\\manuscript\\chapter_1.md`,
      projectPath,
    } as never)).resolves.toBe(false)

    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(mocks.alertError).toHaveBeenCalledOnce()
  })

  it('fails closed for an artifact from an older lease of the same project path', async () => {
    const invoke = vi.fn(async () => ({ success: true, content: 'stale artifact' }))
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const result = await openArtifactInEditor({
      type: 'file_modified',
      name: 'chapter_1.md',
      path: `${projectPath}\\manuscript\\chapter_1.md`,
      projectPath,
      projectSession: {
        projectId: 'same-project-id',
        leaseId: 'lease-A',
        projectPath,
      },
    } as never)

    expect(result).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(mocks.alertError).toHaveBeenCalledOnce()
  })
})
