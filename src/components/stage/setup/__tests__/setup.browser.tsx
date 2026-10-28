/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { userEvent } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'

import type { NovelConfig, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { IS_MAC } from '../../shortcut-keys'
import { useStageShortcuts } from '../../use-stage-shortcuts'
import StageSetup from '../StageSetup'

const COMMAND = IS_MAC ? { metaKey: true } : { ctrlKey: true }

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useProjectStore), snapshot(useLLMStore), snapshot(useEditorStore), snapshot(useWorkflowStore)]

const PATH = 'C:\\novels\\island'
const SESSION = { projectId: 'island', leaseId: 'lease-1', projectPath: PATH }
const BLANK: Partial<NovelConfig> = {
  coreOutline: '', genre: '', subGenre: '', targetAudience: '', totalChapters: 24, wordsPerChapter: 3000,
  worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '', writingStyle: '', referenceWorks: '',
  narrativePOV: 'third_limited', plotStructure: 'three_act', writingLanguage: 'zh-CN',
}

let root: Root | undefined
let host: HTMLDivElement | undefined

function project(config: Partial<NovelConfig>) {
  setActiveProjectSessionContext(SESSION)
  useProjectStore.setState({ currentProject: { id: 'island', sessionLease: 'lease-1', name: '雾岛', path: PATH, novelConfig: { ...BLANK, ...config } } as unknown as ProjectData })
}

function Shortcuts() {
  useStageShortcuts({ library: false, focus: false })
  return null
}

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<><Shortcuts /><StageSetup projectKey={PATH} /></>))
}

const alertText = () => [...host!.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' | ')
const dirtyConfigTab = () => useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: PATH, dirty: true }] as never, activeTabId: 'config' })
const SAVE_FAILED = '没能保存。设定还在这一页，没有丢，可以再保存一次。'

const byName = (name: string | RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => {
    const label = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })
const next = () => byName(/^下一步：故事架构/)!
const hint = () => host!.querySelector('.stage-setup-foot [role="status"]')!.textContent
const field = (label: RegExp) => [...host!.querySelectorAll<HTMLSelectElement | HTMLTextAreaElement>('select, textarea')]
  .find(control => label.test(control.labels?.[0]?.textContent ?? ''))!

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function write(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  useWorkflowStore.setState({ startWorkflow: vi.fn(async () => undefined), getResourceConflict: () => null } as never)
  useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({ saveProject: vi.fn(async () => true) } as never)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('设定页', () => {
  it('必填未齐时下一步不可用，提示写明还缺哪几项；补齐后才能往下走', async () => {
    project({})
    await mount()
    expect(next().disabled).toBe(true)
    expect(hint()).toBe('还差 3 项：核心大纲、类型、目标读者')
    expect(next().getAttribute('aria-describedby')).toBe(host!.querySelector('.stage-setup-foot [role="status"]')!.id)

    await write(field(/^核心大纲/) as HTMLTextAreaElement, '一个收到匿名信的年轻人登上末班车。')
    await choose(field(/^类型/) as HTMLSelectElement, '悬疑')
    expect(hint()).toBe('选好目标读者就能继续')
    expect(next().disabled).toBe(true)
    expect(host!.querySelector('[data-missing]')?.textContent).toBe('目标读者 · 必填')

    await choose(field(/^目标读者/) as HTMLSelectElement, '全龄')
    expect(hint()).toBe('设定已齐，可以往下走')
    expect(next().disabled).toBe(false)
    expect([...host!.querySelectorAll('.pi-btn--primary')]).toHaveLength(1)
  })

  it('下一步先保存设定再去架构', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: PATH, dirty: true }] as never, activeTabId: 'config' })
    await mount()
    await click(next())
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toContain('world-building')
  })

  describe('下一步的保存还没返回时作者已经离开，保存完成后不把作者拉去架构', () => {
    let finishSave: (saved: boolean) => void = () => {}
    async function clickNextWithSlowSave() {
      project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
      dirtyConfigTab()
      useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
      await mount()
      await click(next())
    }

    it('回到了书房', async () => {
      await clickNextWithSlowSave()
      await act(async () => useLayoutStore.getState().setSidebarView('home'))
      await act(async () => finishSave(true))
      expect(useLayoutStore.getState().sidebarView).toBe('home')
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
    })

    it('打开了设置页', async () => {
      await clickNextWithSlowSave()
      await act(async () => useLayoutStore.setState({ settingsOpen: true, settingsSection: 'llm' }))
      await act(async () => finishSave(true))
      expect(useLayoutStore.getState().settingsOpen).toBe(true)
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
    })

    it('换到了这部作品的另一个标签', async () => {
      await clickNextWithSlowSave()
      await act(async () => useEditorStore.setState(state => ({
        tabs: [...state.tabs, { id: 'kb', name: '知识库', type: 'knowledge-base', projectKey: PATH, dirty: false } as never],
        activeTabId: 'kb',
      })))
      await act(async () => finishSave(true))
      expect(useEditorStore.getState().activeTabId).toBe('kb')
      expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config', 'knowledge-base'])
    })

    // 换作品时会话先失效，save 返回 false 就停了，走不到位置比较。
    it('打开了另一部作品', async () => {
      await clickNextWithSlowSave()
      const other = { projectId: 'harbor', leaseId: 'lease-2', projectPath: 'C:\\novels\\harbor' }
      setActiveProjectSessionContext(other)
      await act(async () => useProjectStore.setState({ currentProject: { id: 'harbor', sessionLease: 'lease-2', name: '港口', path: other.projectPath, novelConfig: { ...BLANK } } as unknown as ProjectData }))
      await act(async () => finishSave(true))
      expect(useEditorStore.getState().tabs.filter(tab => tab.projectKey === other.projectPath)).toEqual([])
    })
  })

  it('Ctrl S 的保存还没返回时下一步不可点，返回后可点并去架构', async () => {
    let finishSave: (saved: boolean) => void = () => {}
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
    await mount()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    expect(next().disabled).toBe(true)
    await act(async () => {
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, dirty: false })) }))
      finishSave(true)
    })
    expect(next().disabled).toBe(false)
    await click(next())
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toContain('world-building')
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
  })

  it('新作品三项必填先用中性的「必填」；离开空着的一项或只差最后一项时才标红', async () => {
    project({})
    await mount()
    const labels = () => [...host!.querySelectorAll('.stage-setup-label')].slice(0, 4).map(label => [label.textContent, label.hasAttribute('data-missing')])
    expect(labels()).toEqual([['核心大纲 · 必填', false], ['类型 · 必填', false], ['篇幅', false], ['目标读者 · 必填', false]])

    const outline = field(/^核心大纲/) as HTMLTextAreaElement
    await act(async () => { outline.focus(); outline.blur() })
    expect(labels()[0]).toEqual(['核心大纲 · 必填', true])
    expect(labels()[1]).toEqual(['类型 · 必填', false])
  })

  it('篇幅没填全时，焦点离开篇幅也标红，与其他必填项同一时机', async () => {
    project({ wordsPerChapter: 0 })
    await mount()
    const length = () => [...host!.querySelectorAll('.stage-setup-label')][2]
    expect([length().textContent, length().hasAttribute('data-missing')]).toEqual(['篇幅 · 必填', false])

    const chapters = host!.querySelector<HTMLInputElement>('input[aria-label="总章数"]')!
    await act(async () => { chapters.focus(); chapters.blur() })
    expect([length().textContent, length().hasAttribute('data-missing')]).toEqual(['篇幅 · 必填', true])
  })

  it('篇幅超出安全整数时仍算没填全，与预览卡（主进程按安全整数判断）一致', async () => {
    project({ totalChapters: 2 ** 53 })
    await mount()
    expect([...host!.querySelectorAll('.stage-setup-label')][2].textContent).toBe('篇幅 · 必填')
  })

  it('点开一项更多设定：面板滚进视野，焦点落在面板的输入框里', async () => {
    project({})
    await mount()
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    await click(byName(/^世界观/))
    const panel = host!.querySelector('[aria-label="世界观"]')!
    expect(scrolled.mock.contexts).toContain(panel)
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(panel.querySelector('textarea'))
  })

  it('AI 按钮不可用时读屏能听到原因', async () => {
    useLLMStore.setState({ loaded: true, defaultModelId: null })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    const reason = (button: HTMLButtonElement | undefined) => document.getElementById(button!.getAttribute('aria-describedby') ?? '')?.textContent
    expect(reason(byName('AI 补全其余设定'))).toBe('先在设置里添加 AI 模型')
    expect(reason(byName('AI 生成「核心大纲」'))).toBe('先在设置里添加 AI 模型')
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
    project({})
    await mount()
    expect(reason(byName('AI 补全其余设定'))).toBe('先写核心大纲，AI 按它补全其余设定')
    expect(byName('AI 生成「核心大纲」')?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('AI 按钮按规划环节实际能用的模型判断，和点下去时的门槛一致', async () => {
    const reason = (button: HTMLButtonElement | undefined) => document.getElementById(button!.getAttribute('aria-describedby') ?? '')?.textContent
    useLLMStore.setState({ loaded: true, models: [{ id: 'model', purposes: ['refinement'] }] as never, defaultModelId: 'model', stageModelIds: {} })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(reason(byName('AI 生成「核心大纲」'))).toBe('先在设置里添加 AI 模型')
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, models: [{ id: 'planner', purposes: ['generation'] }] as never, defaultModelId: null, stageModelIds: { planning: 'planner' } })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(byName('AI 生成「核心大纲」')?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('保存失败时页面写明设定还在、可以再保存；点保存、Ctrl S 都一样', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(async () => false) } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    expect(alertText()).toBe('')

    await click(byName(/^保存/))
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(byName(/^保存/)?.disabled).toBe(false)

    await write(field(/^核心大纲/) as HTMLTextAreaElement, '雾钟提前两刻响起。')
    expect(alertText()).toBe('')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(2)
  })

  it('下一步保存失败时留在设定页并写明原因', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(async () => { throw new Error('磁盘已满') }) } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    await click(next())
    await expect.poll(alertText).toBe(SAVE_FAILED)
    expect(useEditorStore.getState().tabs.map(tab => tab.type)).toEqual(['config'])
  })

  it('单项 AI 生成失败时在那一项下面写明原因', async () => {
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    await click(byName('AI 生成「核心大纲」'))
    await expect.poll(alertText).toBe('「核心大纲」没有生成：桌面接口 aiNovelAPI 未就绪，请重新启动应用。原来的内容没有改动。')
    expect(host!.querySelector('.stage-setup-outline [role="alert"]')).not.toBeNull()
    expect((field(/^核心大纲/) as HTMLTextAreaElement).value).toBe('雾钟提前一刻响起。')

    await choose(field(/^类型/) as HTMLSelectElement, '悬疑')
    expect(alertText()).not.toBe('')
    await write(field(/^核心大纲/) as HTMLTextAreaElement, '雾钟提前两刻响起。')
    expect(alertText()).toBe('')
  })

  it('AI 补全以核心大纲为脑洞启动；已有作者内容时先确认扩写', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', worldSetting: '旧港以潮汐计时。' })
    await mount()
    await click(byName('AI 补全其余设定'))
    const startWorkflow = useWorkflowStore.getState().startWorkflow
    expect(startWorkflow).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('扩写已有的设定？')
    expect([...dialog.querySelectorAll('li')].map(item => item.textContent)).toEqual(['核心大纲', '世界观设定'])

    await click(byName('继续扩写'))
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ type: 'config_generation', projectPath: PATH, projectSession: SESSION }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('另一个任务占着设定时 AI 补全不启动，扩写确认留着', async () => {
    project({ coreOutline: '雾钟提前一刻响起。', worldSetting: '旧港以潮汐计时。' })
    useWorkflowStore.setState({ getResourceConflict: () => ({ title: '生成架构' }) } as never)
    await mount()
    await click(byName('AI 补全其余设定'))
    await click(byName('继续扩写'))
    expect(useWorkflowStore.getState().startWorkflow).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('扩写已有的设定？')
  })

  it('没有核心大纲时 AI 补全不可用；没有模型时所有 AI 按钮不可用并给出添加模型的入口', async () => {
    project({})
    await mount()
    expect(byName('AI 补全其余设定')?.disabled).toBe(true)
    await act(async () => root!.unmount())
    host!.remove()

    useLLMStore.setState({ loaded: true, defaultModelId: null })
    project({ coreOutline: '雾钟提前一刻响起。' })
    await mount()
    expect(byName('AI 补全其余设定')?.disabled).toBe(true)
    expect(byName('AI 生成「核心大纲」')?.disabled).toBe(true)
    expect(host!.textContent).toContain('还没有连接 AI 模型')
    await click(byName('添加模型'))
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  })

  it('更多设定点开才出现，每项可以单独收起', async () => {
    project({ subGenre: '海港悬疑' })
    await mount()
    const chip = byName(/^细分类型/)!
    expect(chip.textContent).toBe('细分类型 · 海港悬疑')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(host!.querySelector('[aria-label="细分类型"]')).toBeNull()

    await click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(host!.querySelector<HTMLInputElement>('[aria-label="细分类型"] input')?.value).toBe('海港悬疑')
    await click(byName('收起「细分类型」'))
    expect(host!.querySelector('[aria-label="细分类型"]')).toBeNull()
  })

  it('伏笔沉寂提醒清空后重新输入：退格删掉 5 再输 7 得 7，不是 17；空着离开回到默认的 3 章', async () => {
    project({ narrativeThreadDormantChapterThreshold: 5 })
    await mount()
    await click(byName(/^高级/))
    const input = host!.querySelector<HTMLInputElement>('.stage-setup-adv-ctl input')!
    // 上一条用例留下的提示会挡住指针，直接聚焦后用键盘输入。
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('7')
    expect(input.value).toBe('7')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('3')
  })
})

describe('设定页的保存跨切标签', () => {
  it('Ctrl S 的保存还没返回时切到别的标签再切回：下一步仍不可点，再按 Ctrl S 也不重发，保存只发 1 次', async () => {
    let finishSave: (saved: boolean) => void = () => {}
    project({ coreOutline: '雾钟提前一刻响起。', genre: '悬疑', targetAudience: '全龄' })
    dirtyConfigTab()
    useProjectStore.setState({ saveProject: vi.fn(() => new Promise<boolean>(resolve => { finishSave = resolve })) } as never)
    await mount()
    const ctrlS = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ...COMMAND, bubbles: true, cancelable: true })) })
    await ctrlS()
    await act(async () => root!.render(<Shortcuts />))
    await act(async () => root!.render(<><Shortcuts /><StageSetup projectKey={PATH} /></>))
    expect(next().disabled).toBe(true)
    await click(next())
    await ctrlS()
    expect(useProjectStore.getState().saveProject).toHaveBeenCalledTimes(1)
    await act(async () => {
      useEditorStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, dirty: false })) }))
      finishSave(true)
    })
    expect(next().disabled).toBe(false)
  })
})
