import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { userEvent } from 'vitest/browser'
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
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: [] }
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'db:get-llm-stats') return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, knownUsageCalls: 0, totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }
    if (channel === 'generation:list-recovery') return { planning: [], editors: [], reviews: [], batches: [], drafts: [], partial: false }
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
async function renderAt(width: number, tab: 'world-building' | 'character' = 'world-building') {
  useEditorStore.setState({ tabs: [{ id: tab, type: tab, name: tab, projectKey: session.projectPath }], activeTabId: tab })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = `width: ${width}px; height: 800px; display: flex`
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
  await vi.waitFor(() => expect(host!.querySelector(tab === 'character'
    ? '.cast-view-switch button'
    : '.arch-page:not([data-loading]):not([data-cast-loading]) .arch-title')).not.toBeNull())
  const box = (selector: string) => host!.querySelector(selector)!.getBoundingClientRect()
  return { body: box('.stage-body'), content: box('.stage-content'), sheet: box('.stage-sheet-slot'), title: host!.querySelector<HTMLElement>('.arch-title') }
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
    expect(lineCount(title!)).toBe(1)
  })

  it('并排放不下时侧页浮在内容区上，内容区保持整个面板的宽度', async () => {
    const { body, content, sheet, title } = await renderAt(790)
    expect(content.width).toBe(body.width)
    expect(sheet.width).toBeGreaterThanOrEqual(380)
    expect(sheet.right).toBeLessThanOrEqual(body.right + 1)
    expect(lineCount(title!)).toBe(1)
  })
})

/** 元素整个落在侧页的横向范围里：侧页浮起时它被完全盖住。 */
const coveredBy = (sheet: DOMRect) => (element: Element) => {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.left >= sheet.left - 1 && rect.right <= sheet.right + 1
}
const tabbable = (root: Element) => [...root.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
const sheetOpen = () => host!.querySelector('.stage-sheet-slot') !== null

describe('运行侧页开着普通分页时，架构页页头只在真放不下时换行', () => {
  // 夹具里页头动作约 344px 宽：内容区 710px 时标题还有约 246px，放得下「故事的骨架」，动作应与标题同一行并靠右（与 master 一致）
  it('标题旁放得下动作时，动作与标题同一行、靠右', async () => {
    useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } })
    const { content, title } = await renderAt(1100)
    const box = (selector: string) => host!.querySelector(selector)!.getBoundingClientRect()
    expect(content.width).toBe(710)
    expect(box('.arch-header-actions').left).toBeGreaterThanOrEqual(box('.arch-heading').right)
    expect(Math.round(box('.arch-header-actions').right)).toBe(Math.round(box('.arch-header').right))
    expect(lineCount(title!)).toBe(1)
  })

  it('标题旁放不下时动作换到下一行，标题不被挤断', async () => {
    useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } })
    const { title } = await renderAt(1004)
    expect(lineCount(title!)).toBe(1)
  })
})

describe('运行侧页浮起时盖在内容区上面，被它盖住的东西点不到也走不到', () => {
  it('关系图谱的工具条不画在侧页上面，侧页区域里的点都属于侧页', async () => {
    const { sheet } = await renderAt(790, 'character')
    const graphView = host!.querySelectorAll<HTMLButtonElement>('.cast-view-switch button')[2]
    await act(async () => graphView.click())
    await vi.waitFor(() => expect(host!.querySelector('.cast-graph canvas')).not.toBeNull())
    const toolbarButtons = [...host!.querySelectorAll<HTMLElement>('.cast-graph button')].filter(coveredBy(sheet))
    expect(toolbarButtons.length).toBeGreaterThan(0)
    const slot = host!.querySelector('.stage-sheet-slot')!
    for (const button of toolbarButtons) {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      expect(slot.contains(hit), button.getAttribute('aria-label') ?? '').toBe(true)
    }
  })

  it('焦点在内容区时按 Esc 也关掉浮起的侧页', async () => {
    await renderAt(790)
    host!.querySelector<HTMLElement>('.stage-content')!.focus()
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(sheetOpen()).toBe(false)
  })

  it('浮起时在输入框里或输入法组字中按 Esc 不关侧页', async () => {
    await renderAt(790)
    const content = host!.querySelector<HTMLElement>('.stage-content')!
    const input = document.createElement('input')
    content.prepend(input)
    input.focus()
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(sheetOpen()).toBe(true)
    content.focus()
    await act(async () => { content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true })) })
    expect(sheetOpen()).toBe(true)
    input.remove()
  })

  it('并排（不浮起）时焦点在内容区按 Esc 不关侧页，与原来一样', async () => {
    await renderAt(1010)
    host!.querySelector<HTMLElement>('.stage-content button')!.focus()
    await act(async () => userEvent.keyboard('{Escape}'))
    expect(sheetOpen()).toBe(true)
  })

  it('Tab 从内容区走到侧页，一路不落在被侧页盖住的控件上', async () => {
    const { sheet } = await renderAt(790)
    const slot = host!.querySelector('.stage-sheet-slot')!
    const content = host!.querySelector<HTMLElement>('.stage-content')!
    const covered = tabbable(content).filter(coveredBy(sheet))
    expect(covered.length).toBeGreaterThan(0)
    content.focus()
    const visited: Element[] = []
    for (let step = 0; step < 60 && !slot.contains(document.activeElement); step++) {
      await userEvent.keyboard('{Tab}')
      if (content.contains(document.activeElement)) visited.push(document.activeElement!)
    }
    expect(slot.contains(document.activeElement)).toBe(true)
    expect(visited.filter(element => covered.includes(element as HTMLElement)).map(element => element.textContent || element.getAttribute('aria-label'))).toEqual([])
  })

  it('设置页开着时 Tab 走到侧页，一路不落在被侧页盖住的设置控件上', async () => {
    useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } })
    useLayoutStore.setState({ settingsOpen: true, settingsSection: 'appearance' })
    const { sheet } = await renderAt(790)
    const slot = host!.querySelector('.stage-sheet-slot')!
    await vi.waitFor(() => expect(host!.querySelector('.stage-settings')).not.toBeNull())
    const settings = host!.querySelector<HTMLElement>('.stage-settings')!
    await vi.waitFor(() => expect(tabbable(settings).filter(coveredBy(sheet)).length).toBeGreaterThan(0))
    const covered = tabbable(settings).filter(coveredBy(sheet))
    tabbable(settings)[0].focus()
    const visited: Element[] = []
    for (let step = 0; step < 60 && !slot.contains(document.activeElement); step++) {
      await userEvent.keyboard('{Tab}')
      if (settings.contains(document.activeElement)) visited.push(document.activeElement!)
    }
    expect(slot.contains(document.activeElement)).toBe(true)
    expect(visited.filter(element => covered.includes(element as HTMLElement)).map(element => element.textContent || element.getAttribute('aria-label'))).toEqual([])
  })

  it('方向键把焦点移到被侧页盖住的分段按钮时，焦点不留在被盖住的内容区控件上', async () => {
    useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } })
    const { sheet } = await renderAt(790, 'character')
    const segments = [...host!.querySelectorAll<HTMLButtonElement>('.cast-view-switch button')]
    expect(coveredBy(sheet)(segments.at(-1)!)).toBe(true)
    segments[0].focus()
    await userEvent.keyboard('{End}')
    await vi.waitFor(() => expect(segments.at(-1)!.getAttribute('aria-pressed')).toBe('true'))
    const landed = document.activeElement!
    expect(host!.querySelector('.stage-content')!.contains(landed) && coveredBy(sheet)(landed), landed.textContent ?? '').toBe(false)
  })

  it('焦点停在内容区右侧时窗口变窄、侧页浮起盖住它，焦点移开', async () => {
    await renderAt(1400)
    const content = host!.querySelector<HTMLElement>('.stage-content')!
    const rightmost = tabbable(content).filter(element => element.getBoundingClientRect().width > 0)
      .reduce((best, element) => element.getBoundingClientRect().right > best.getBoundingClientRect().right ? element : best)
    rightmost.focus()
    expect(document.activeElement).toBe(rightmost)
    host!.style.width = '790px'
    const slot = host!.querySelector<HTMLElement>('.stage-sheet-slot')!
    await vi.waitFor(() => expect(getComputedStyle(slot).position).toBe('absolute'))
    const sheet = slot.getBoundingClientRect()
    expect(coveredBy(sheet)(rightmost), '变窄后原来的焦点控件被侧页盖住').toBe(true)
    await vi.waitFor(() => expect(document.activeElement).not.toBe(rightmost))
    const landed = document.activeElement!
    expect(content.contains(landed) && coveredBy(sheet)(landed), landed.textContent ?? '').toBe(false)
  })

  it('Shift+Tab 从侧页回到内容区时落在看得见的控件上', async () => {
    const { sheet } = await renderAt(790)
    const slot = host!.querySelector('.stage-sheet-slot')!
    tabbable(slot)[0].focus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    const landed = document.activeElement!
    expect(host!.querySelector('.stage-content')!.contains(landed)).toBe(true)
    expect(coveredBy(sheet)(landed)).toBe(false)
  })
})
