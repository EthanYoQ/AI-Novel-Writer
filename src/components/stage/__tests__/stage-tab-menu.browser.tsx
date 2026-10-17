import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import StageWorkspace from '../StageWorkspace'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const restores = [useProjectStore, useStageStore, useLocaleStore, useLayoutStore, useEditorStore]
  .map(store => { const state = (store as StoreApi<unknown>).getState(); return () => (store as StoreApi<unknown>).setState(state, true) })

const page = (id: string, dirty = false): EditorTab => ({ id, name: id, type: 'outline', projectKey: session.projectPath, content: id, dirty })

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke: vi.fn(async () => { throw new Error('不应读写') }), on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1280px; height: 800px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

async function render(tabs: EditorTab[], active: string) {
  useEditorStore.setState({ tabs, activeTabId: active })
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}
const openTabs = () => useEditorStore.getState().tabs.map(tab => tab.id)
async function choose(label: string) {
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="标签操作"]')!.click())
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(candidate => candidate.textContent === label)
  expect(item, label).toBeTruthy()
  await act(async () => item!.click())
}
const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(candidate => candidate.textContent === label)

describe('标签菜单', () => {
  it('列出已打开的页面并标出当前那页，点一页就切过去', async () => {
    await render([page('甲'), page('乙'), page('丙')], '甲')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="标签操作"]')!.click())
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent).slice(0, 3)).toEqual(['甲（当前）', '乙', '丙'])
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '丙')!.click())
    expect(useEditorStore.getState().activeTabId).toBe('丙')
  })

  it('关闭其他标签：没有修改的直接关，有修改的问一次；选继续编辑就留着', async () => {
    await render([page('甲'), page('乙', true), page('丙'), page('丁', true)], '甲')
    await choose('关闭其他标签')
    expect(openTabs()).toEqual(['甲', '乙', '丁'])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('有 2 个标签有未保存的修改')
    await act(async () => dialogButton('继续编辑')!.click())
    expect(openTabs()).toEqual(['甲', '乙', '丁'])

    await choose('关闭其他标签')
    await act(async () => dialogButton('放弃并关闭')!.click())
    expect(openTabs()).toEqual(['甲'])
  })

  it('关闭右侧标签只关当前标签右边的', async () => {
    await render([page('甲'), page('乙'), page('丙'), page('丁')], '乙')
    await choose('关闭右侧标签')
    expect(openTabs()).toEqual(['甲', '乙'])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('关闭全部时一个没修改一个有修改：没修改的关上后标签条收起，确认照样弹出，放弃才关上有修改的', async () => {
    await render([page('甲'), page('乙', true)], '甲')
    await choose('关闭全部标签')
    expect(openTabs()).toEqual(['乙'])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('有 1 个标签有未保存的修改')
    await act(async () => dialogButton('放弃并关闭')!.click())
    expect(openTabs()).toEqual([])
  })

  it('关掉标签后焦点交接排在下一帧；这一帧里已经又打开了标签菜单，就不抢走菜单的焦点', async () => {
    const frames: FrameRequestCallback[] = []
    await render([page('甲'), page('乙'), page('丙')], '乙')
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
    await choose('关闭右侧标签')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="标签操作"]')!.click())
    await act(async () => { for (const callback of frames.splice(0)) callback(performance.now()) })
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent).slice(0, 2)).toEqual(['甲', '乙（当前）'])
  })

  it('关闭全部标签后回到空的内容区', async () => {
    await render([page('甲'), page('乙')], '乙')
    await choose('关闭全部标签')
    expect(openTabs()).toEqual([])
    expect(document.body.textContent).toContain('从流程脊选一步开始')
  })
})
