import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import StageShell from '../StageShell'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useEditorStore, useLayoutStore, useLLMStore, useLocaleStore, useStageStore, useProjectStore]
  .map(store => snapshot(store as StoreApi<unknown>))

const han = /\p{Script=Han}/u
/** 作者与读屏读到的文字：去掉 aria-hidden 的装饰（顶栏的「墨」字印章在两种语言里一样）。 */
function readableText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement
  copy.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
  return copy.textContent ?? ''
}
const UPDATE = { status: 'available', currentVersion: '1.2.2', availableVersion: '1.2.3', updateAction: 'download', isReminderDeferred: false }

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:set') return { success: true }
    if (channel === 'update:get-state') return UPDATE
    return channel.endsWith('-list') || channel.endsWith('get-all') ? [] : undefined
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useProjectStore.setState({ currentProject: null, recentProjects: [], recentProjectsLoaded: true })
  useLayoutStore.setState({ sidebarView: 'home', settingsOpen: false })
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageShell theme="light" />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('界面语言', () => {
  it('切到英文后，已经显示着的书房与更新卡立即换成英文，不留中文', async () => {
    await vi.waitFor(() => expect(host!.querySelector('.stage-update')).not.toBeNull())
    expect(readableText(host!)).toMatch(han)

    await act(async () => useLocaleStore.getState().setLocale('en-US'))

    expect(useLocaleStore.getState().locale).toBe('en-US')
    expect(host!.querySelector('.stage-update')?.textContent).toContain('1.2.3')
    expect(readableText(host!)).not.toMatch(han)
  })
})
