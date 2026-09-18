import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import WorldBuildingEditor from '../WorldBuildingEditor'

const projectPath = 'C:\\novels\\世界观候选界面测试'
const projectSession = {
  projectId: 'world-ui-test',
  leaseId: 'world-ui-test-lease',
  projectPath,
}
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

let container: HTMLDivElement
let root: Root
let partialFile: Record<string, unknown>

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  partialFile = {}
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      sessionLease: projectSession.leaseId,
      name: '世界观候选界面测试',
      path: projectPath,
      novelConfig: {
        writingLanguage: 'zh-CN',
        genre: '东方奇幻',
        subGenre: '',
        targetAudience: '成年读者',
        totalChapters: 20,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '倒悬古城的记忆税危机。',
        worldSetting: '',
        goldenFinger: '',
        protagonistProfile: '',
        globalGuidance: '',
      },
    } as never,
  })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  setActiveProjectSessionContext(projectSession)

  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'db:project-core-get') {
          return { premise: '故事前提'.repeat(20), worldbuilding: '', synopsis: '', totalChapters: 20 }
        }
        if (channel === 'fs:read-json') return { success: true, data: structuredClone(partialFile) }
        if (channel === 'db:character-roster-read') {
          return { status: 'empty', revision: 0, entries: [], renderedMarkdown: '' }
        }
        throw new Error(`未预期的 IPC 通道：${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
  vi.restoreAllMocks()
})

describe('WorldBuildingEditor 世界观恢复候选', () => {
  it('已打开页面会在架构工作流失败终态后刷新并显示候选入口', async () => {
    await act(async () => root.render(<WorldBuildingEditor projectKey={projectPath} />))
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('世界观'))
    })
    expect(container.textContent).not.toContain('未完成候选 · 未写入正式内容')

    partialFile = {
      world_building_partial_result: '倒悬古城依靠记忆结晶运转，王庭通过税令控制流通。',
      world_building_incomplete: true,
      world_building_facts_fingerprint: 'facts',
      world_building_db_hash: 'db',
      world_building_step_guidance: '',
    }
    await act(async () => useWorkflowStore.setState({
      history: [{
        id: 'failed-world-run',
        type: 'architecture_generation',
        title: '生成故事架构',
        projectPath,
        projectSession,
        status: 'failed',
        steps: [],
        currentStepIndex: 0,
        logs: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        uiLocale: 'zh-CN',
      } as never],
    }))

    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('未完成候选 · 未写入正式内容'))
    })
    const viewButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('查看候选'))
    expect(viewButton).toBeTruthy()
    await act(async () => viewButton?.click())
    expect(container.textContent).toContain('不会自动写入正式世界观')
    expect(container.textContent).toContain('倒悬古城依靠记忆结晶运转')
  })
})
