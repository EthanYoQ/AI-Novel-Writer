import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { PostProcessStatusPanel } from './PostProcessStatusPanel'

const PROJECT_PATH = 'C:\\novels\\post-process-status'
const PROJECT_SESSION = Object.freeze({
  projectId: 'post-process-status-project',
  leaseId: 'post-process-status-lease',
  projectPath: PROJECT_PATH,
})

const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>

function project(): ProjectData {
  return {
    id: PROJECT_SESSION.projectId,
    sessionLease: PROJECT_SESSION.leaseId,
    name: '后处理状态测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '奇幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 5,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '完整的故事构想',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function installIpc(steps: Array<Record<string, unknown>>) {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:post-process-get-latest-run') {
      return {
        id: 'run-1',
        sourceLabel: '第1章定稿',
        allCriticalPassed: false,
        createdAt: '2026-08-22T09:59:35.000Z',
        updatedAt: '2026-08-22T09:59:36.000Z',
      }
    }
    if (channel === 'db:post-process-get-steps') return steps
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
}

async function renderPanel(onStatusLoad: (hasFailure: boolean) => void) {
  await act(async () => {
    root?.render(
      <PostProcessStatusPanel
        scope="chapter_1_finalize"
        defaultExpanded
        onRetry={vi.fn()}
        onStatusLoad={onStatusLoad}
      />,
    )
  })
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext(PROJECT_SESSION)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProjectState)
})

describe('PostProcessStatusPanel', () => {
  it('renders database-default unfinished steps as in progress, not as failed post-processing', async () => {
    installIpc([
      {
        id: 1, runId: 'run-1', stepKey: 'kb_import', label: '导入知识库', critical: true,
        ok: true, errorMsg: '', attemptCount: 1,
        completedAt: '2026-08-22T09:59:36.000Z', lastAttemptAt: '2026-08-22T09:59:36.000Z',
      },
      {
        id: 2, runId: 'run-1', stepKey: 'chapter_notes', label: '章节剧情要点', critical: true,
        ok: false, errorMsg: '', attemptCount: 0, completedAt: '', lastAttemptAt: '',
      },
      {
        id: 3, runId: 'run-1', stepKey: 'character_cards', label: '角色状态更新', critical: false,
        ok: false, errorMsg: '', attemptCount: 0, completedAt: '', lastAttemptAt: '',
      },
    ])
    const onStatusLoad = vi.fn()

    await renderPanel(onStatusLoad)
    await vi.waitFor(() => expect(container?.textContent).toContain('第1章定稿 正在处理（1/3）'))

    expect(container?.textContent).not.toContain('步骤失败')
    expect(container?.textContent).not.toContain('重试失败步骤')
    expect(onStatusLoad).toHaveBeenLastCalledWith(false)
  })

  it('continues to expose a persisted post-processing failure for repair', async () => {
    installIpc([
      {
        id: 1, runId: 'run-1', stepKey: 'kb_import', label: '导入知识库', critical: true,
        ok: true, errorMsg: '', attemptCount: 1,
        completedAt: '2026-08-22T09:59:36.000Z', lastAttemptAt: '2026-08-22T09:59:36.000Z',
      },
      {
        id: 2, runId: 'run-1', stepKey: 'chapter_notes', label: '章节剧情要点', critical: true,
        ok: false, errorMsg: '模型响应超时', attemptCount: 1,
        completedAt: '', lastAttemptAt: '2026-08-22T09:59:42.000Z',
      },
      {
        id: 3, runId: 'run-1', stepKey: 'character_cards', label: '角色状态更新', critical: false,
        ok: true, errorMsg: '', attemptCount: 1,
        completedAt: '2026-08-22T10:00:00.000Z', lastAttemptAt: '2026-08-22T10:00:00.000Z',
      },
    ])
    const onStatusLoad = vi.fn()

    await renderPanel(onStatusLoad)
    await vi.waitFor(() => expect(container?.textContent).toContain('第1章定稿 — 1 个步骤失败'))

    expect(container?.textContent).toContain('模型响应超时')
    expect(container?.textContent).toContain('重试失败步骤')
    expect(onStatusLoad).toHaveBeenLastCalledWith(true)
  })
})
