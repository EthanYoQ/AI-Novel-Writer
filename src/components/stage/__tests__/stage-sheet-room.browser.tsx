import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { EMPTY_CARD, useCharacterStore } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import StageWorkspace from '../StageWorkspace'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useEditorStore, useCharacterStore, useLayoutStore]
  .map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:project-core-get') return { premise: '一座本该停用的灯塔仍在夜里报时。', worldbuilding: '', synopsis: '', totalChapters: 12, writingLanguage: 'zh-CN' }
    if (channel === 'fs:read-json') return { success: false, error: 'not found' }
    if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: 'ready', entries: [], renderedMarkdown: '林岚', projectionHash: 'p', factHash: 'f' }
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'db:get-llm-stats') return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, knownUsageCalls: 0, totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }
    if (/list|history/i.test(channel)) return []
    if (channel === 'generation:read-context' || channel === 'generation:read-visible-composition') return null
    if (channel === 'fs:check-exists') return false
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔',
    novelConfig: { totalChapters: 12, wordsPerChapter: 3000, genre: '悬疑', targetAudience: '成人', coreOutline: '雾钟', writingLanguage: 'zh-CN' } } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useCharacterStore.setState({ characters: [{ ...EMPTY_CARD, characterId: 'c1', name: '林岚' }], dataProjectKey: session.projectPath, loadingProjectKey: null, lastError: null })
  useLayoutStore.setState({ settingsOpen: false })
  useEditorStore.setState({ tabs: [{ id: 'world', type: 'world-building', name: '架构', projectKey: session.projectPath }], activeTabId: 'world' })
  useStageStore.setState({ sheet: { kind: 'run', tab: 'diagnostics' }, focus: false })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
  delete window.aiNovelAPI
})

/** 外壳里放工作区的那一栏宽 width：面板右缘留 10px，所以内容面板（侧页与内容区所在处）比它窄 10px。 */
async function renderAt(width: number) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = `width: ${width}px; height: 800px; display: flex`
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
  await vi.waitFor(() => expect(host!.querySelector('.arch-page:not([data-loading]):not([data-cast-loading]) .arch-title')).not.toBeNull())
  const box = (selector: string) => host!.querySelector(selector)!.getBoundingClientRect()
  return { body: box('.stage-body'), content: box('.stage-content'), sheet: box('.stage-sheet-slot > aside'), title: host!.querySelector<HTMLElement>('.arch-title')! }
}

/** 一段文字排成了几行。 */
function lineCount(element: Element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size
}

describe('运行侧页的诊断分页开着时，内容区不被挤窄', () => {
  it('并排放得下时内容区至少留 600px，架构页标题排在一行', async () => {
    const { body, content, sheet, title } = await renderAt(1010)
    expect(content.width).toBeGreaterThanOrEqual(600)
    expect(sheet.width).toBeGreaterThanOrEqual(380)
    expect(content.width + sheet.width).toBeLessThanOrEqual(body.width + 1)
    expect(lineCount(title)).toBe(1)
  })

  it('并排放不下时侧页浮在内容区上，内容区保持整个面板的宽度', async () => {
    const { body, content, sheet, title } = await renderAt(790)
    expect(content.width).toBe(body.width)
    expect(sheet.width).toBeGreaterThanOrEqual(380)
    expect(sheet.right).toBeLessThanOrEqual(body.right + 1)
    expect(lineCount(title)).toBe(1)
  })
})
