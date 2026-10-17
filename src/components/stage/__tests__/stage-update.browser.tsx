import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { UpdateState } from '../../../services/update-presentation'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore, type WorkflowStatus } from '../../../stores/workflow-store'
import { LibraryUpdateCard, UpdateSettings } from '../StageUpdate'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void }
const win = window as unknown as { aiNovelAPI?: Api }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useEditorStore), snapshot(useWorkflowStore), snapshot(useLocaleStore)]
const DOWNLOADED: UpdateState = { status: 'downloaded', currentVersion: '1.2.2', availableVersion: '1.2.3', updateAction: 'download', isReminderDeferred: false }
const AVAILABLE: UpdateState = { ...DOWNLOADED, status: 'available' }

let root: Root | undefined
let host: HTMLDivElement | undefined
let state: UpdateState
let homepageFails: boolean
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

async function mount(node: ReactNode = <LibraryUpdateCard />) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(candidate => candidate.textContent === name || candidate.getAttribute('aria-label') === name)
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === name)
const dialogTitle = () => document.querySelector('[role="dialog"] h2')?.textContent ?? null
const calls = (channel: string) => invoke.mock.calls.filter(([called]) => called === channel)
const dirtyTab = () => useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: 'p', dirty: true }] } as never)
const activeRun = (status: WorkflowStatus) => useWorkflowStore.setState({ activeRuns: [{ id: `run-${status}`, status }] as never })

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

beforeEach(() => {
  state = DOWNLOADED
  homepageFails = false
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'update:get-state') return state
    if (channel === 'update:quit-and-install' || channel === 'update:download' || channel === 'update:open-release') return { success: true, state }
    if (channel === 'update:defer-reminder') return { success: true, state: { ...state, isReminderDeferred: true } }
    if (channel === 'official-homepage:open') return homepageFails ? { success: false, error: 'blocked' } : { success: true }
    return undefined
  })
  win.aiNovelAPI = { invoke, on: () => () => undefined }
  useEditorStore.setState({ tabs: [], draftLedgers: {} } as never)
  useWorkflowStore.setState({ activeRuns: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  for (const restore of restores) restore()
})

describe('书房的更新提示', () => {
  it('有未保存修改时拦下重启，「返回保存」不安装', async () => {
    dirtyTab()
    await mount()
    await click(button('立即重启更新'))
    expect(dialogTitle()).toBe('请先处理未保存的修改')
    await click(button('返回保存'))
    expect(dialogTitle()).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('update:quit-and-install')
  })

  it('放弃修改并重启：先丢掉未保存的修改，再安装', async () => {
    dirtyTab()
    await mount()
    await click(button('立即重启更新'))
    await click(button('放弃修改并重启更新'))
    await vi.waitFor(() => expect(calls('update:quit-and-install')).toHaveLength(1))
    expect(useEditorStore.getState().tabs.some(tab => tab.dirty)).toBe(false)
  })

  it.each(['running', 'paused', 'waiting', 'completed', 'failed'] as const)('有 %s 的创作任务时只能返回处理任务，不先问未保存修改', async status => {
    dirtyTab()
    activeRun(status)
    await mount()
    await click(button('立即重启更新'))
    expect(dialogTitle()).toBe('创作任务尚未结束，暂不能更新')
    expect(document.body.textContent).toContain('结果可能尚未完整写入作品')
    await click(button('知道了，返回处理任务'))
    expect(invoke).not.toHaveBeenCalledWith('update:quit-and-install')
  })

  it('放弃修改的确认开着时开始了任务：确认放弃后再查一次，拦下安装', async () => {
    dirtyTab()
    await mount()
    await click(button('立即重启更新'))
    expect(dialogTitle()).toBe('请先处理未保存的修改')
    activeRun('running')
    await click(button('放弃修改并重启更新'))
    expect(dialogTitle()).toBe('创作任务尚未结束，暂不能更新')
    expect(invoke).not.toHaveBeenCalledWith('update:quit-and-install')
  })

  it('没有未保存修改与任务时直接重启安装；主操作不用强调色按钮', async () => {
    await mount()
    expect(host!.querySelector('.pi-btn--primary')).toBeNull()
    await click(button('立即重启更新'))
    expect(invoke).toHaveBeenCalledWith('update:quit-and-install')
  })

  it.each([[7, '7 天后提醒'], [30, '30 天后提醒']] as const)('已下载的更新：「稍后提醒」里选 %i 天，只延后提醒，不重新检查，卡片收起', async (days, label) => {
    await mount()
    await click(button('稍后提醒'))
    await click(menuItem(label))
    await vi.waitFor(() => expect(calls('update:defer-reminder')).toEqual([['update:defer-reminder', days]]))
    expect(calls('update:check')).toHaveLength(0)
    expect(host!.querySelector('.stage-update')).toBeNull()
  })

  it('Windows 上的新版本：点「下载更新」才下载，不安装', async () => {
    state = AVAILABLE
    await mount()
    await click(button('下载更新'))
    await vi.waitFor(() => expect(calls('update:download')).toHaveLength(1))
    expect(calls('update:quit-and-install')).toHaveLength(0)
  })

  it('macOS 上的新版本：打开固定的下载页，不在应用里下载', async () => {
    state = { ...AVAILABLE, updateAction: 'open-release' }
    await mount()
    expect(button('下载更新')).toBeUndefined()
    await click(button('打开下载页'))
    await vi.waitFor(() => expect(calls('update:open-release')).toHaveLength(1))
    expect(calls('update:download')).toHaveLength(0)
  })
})

describe('设置里的关于与更新', () => {
  it('官方主页在检查更新左边、同一行；点了只发不带参数的固定请求', async () => {
    await mount(<UpdateSettings />)
    const controls = host!.querySelector('.stage-set-row-ctl')!
    const [homepage, check] = [...controls.querySelectorAll('button')]
    expect([homepage.textContent, check.textContent]).toEqual(['官方主页', '检查更新'])
    const [homeBox, checkBox] = [homepage.getBoundingClientRect(), check.getBoundingClientRect()]
    expect(homeBox.right).toBeLessThanOrEqual(checkBox.left)
    expect(Math.abs(homeBox.top - checkBox.top)).toBeLessThan(1)
    await click(homepage)
    await vi.waitFor(() => expect(calls('official-homepage:open')).toEqual([['official-homepage:open']]))
  })

  it('更新已下载待重启时不再提供检查更新', async () => {
    await mount(<UpdateSettings />)
    await vi.waitFor(() => expect(button('立即重启更新')).toBeTruthy())
    expect(button('检查更新')?.disabled).toBe(true)
  })

  it('英文界面：官方主页用英文，打不开时给出英文错误', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    homepageFails = true
    await mount(<UpdateSettings />)
    await click(button('Official website'))
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')?.textContent).toBe('Unable to open the official homepage. Please try again later.'))
  })
})
