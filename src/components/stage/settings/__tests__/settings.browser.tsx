/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { registerEditorExitSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { navigate } from '../../../../stores/navigation/navigation-intents'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useThemeStore } from '../../../../stores/theme-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { IS_MAC } from '../../shortcut-keys'
import { useStageShortcuts } from '../../use-stage-shortcuts'
import StageSettings from '../StageSettings'

const COMMAND = IS_MAC ? { metaKey: true } : { ctrlKey: true }

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void }
const win = window as unknown as { aiNovelAPI?: Api }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useStageStore), snapshot(useLLMStore), snapshot(useThemeStore), snapshot(useProjectStore), snapshot(useEditorStore), snapshot(useWorkflowStore)]

const MODEL = { id: 'flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'k', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] } as ModelProfile
const LOCAL = { ...MODEL, id: 'local', name: '本机 Ollama', provider: 'ollama', modelName: 'qwen3:14b' } as ModelProfile

let root: Root | undefined
let host: HTMLDivElement | undefined

/** 与 StageShell 同样接线：外壳的快捷键先于设置页注册，沉浸写作读 stage-store。 */
function Shortcuts({ library }: { library: boolean }) {
  useStageShortcuts({ library, focus: useStageStore(s => s.focus) })
  return null
}

async function mount(library = false) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 860px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<><Shortcuts library={library} /><StageSettings library={library} /></>))
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const byName = (name: string) => buttons().find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name)
const heading = () => host!.querySelector('h1')?.textContent

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function key(name: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })) })
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const input = (placeholder: string) => host!.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!
const discardDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === '放弃未保存的修改？')
const dialogButton = (name: string) => [...discardDialog()!.querySelectorAll('button')].find(button => button.textContent === name)

beforeEach(() => {
  win.aiNovelAPI = {
    invoke: async channel => channel === 'config:get' ? {} : channel === 'update:get-state' ? { status: 'disabled', currentVersion: '1.2.2', isReminderDeferred: false } : undefined,
    on: () => () => undefined,
  }
  useLLMStore.setState({ loaded: true, models: [MODEL, LOCAL], defaultModelId: 'flash', defaultEmbeddingModelId: null, deleteModel: vi.fn(async () => true) })
  useLayoutStore.setState({ settingsOpen: true, settingsSection: 'llm' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('设置页', () => {
  it('按常用、高级、其他三组排列，按参数打开对应分组', async () => {
    useLayoutStore.setState({ settingsSection: 'backup' })
    await mount()
    const groups = [...host!.querySelectorAll('nav [role="group"]')].map(group => ({
      group: group.getAttribute('aria-label'),
      pages: [...group.querySelectorAll('.stage-set-link-name')].map(name => name.textContent),
    }))
    expect(groups).toEqual([
      { group: '常用', pages: ['AI 模型', '检索模型', '外观'] },
      { group: '高级', pages: ['网络代理', '提示词模板', '写作 Skills'] },
      { group: '其他', pages: ['项目备份', '关于与更新'] },
    ])
    expect(heading()).toBe('项目备份')
    expect(host!.querySelector('[aria-current="page"]')?.textContent).toBe('项目备份')

    await click(byName('关于与更新'))
    expect(useLayoutStore.getState().settingsSection).toBe('about')
    expect(heading()).toBe('关于与更新')
  })

  it('AI 模型与检索模型标为必需，没配默认模型时导航和页头都标「未配置」', async () => {
    await mount()
    const mark = (name: string) => [...host!.querySelectorAll('.stage-set-link')]
      .find(link => link.querySelector('.stage-set-link-name')?.textContent === name)
      ?.querySelector('.stage-set-required')?.textContent ?? null
    expect(mark('AI 模型')).toBe('必需')
    expect(mark('检索模型')).toBe('未配置')
    expect(mark('外观')).toBeNull()
    expect(host!.querySelector('.stage-set-head .stage-set-required')?.textContent).toBe('必需')

    await act(async () => useLLMStore.setState({ defaultModelId: null }))
    expect(mark('AI 模型')).toBe('未配置')
    expect(host!.querySelector('.stage-set-head .stage-set-required')?.textContent).toBe('未配置')

    await act(async () => useLLMStore.setState({ defaultModelId: 'flash', defaultEmbeddingModelId: 'local' }))
    expect(mark('检索模型')).toBe('必需')
  })

  it('检索模型页带当前作品的检索索引检查与重建', async () => {
    useLayoutStore.setState({ settingsSection: 'embedding' })
    await mount()
    expect(heading()).toBe('检索模型')
    expect(host!.querySelector('[aria-label="当前作品的检索索引"]')?.textContent).toContain('打开一部作品后，可以在这里检查它的检索索引。')
  })

  it('同一页里配好检索模型后，索引区重新检查，出现补全按钮；删掉后又回到未配置', async () => {
    const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
    let configured = false
    win.aiNovelAPI!.invoke = async channel => channel === 'kb:get-vector-rebuild-status'
      ? { embeddingConfigured: configured, canRebuild: configured, totalChunks: 9, vectorlessCount: 4, activeVectorDimension: 0 }
      : channel === 'config:get' ? {} : undefined
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
    setActiveProjectSessionContext(session)
    useLayoutStore.setState({ settingsSection: 'embedding' })
    await mount()
    const index = () => host!.querySelector('[aria-label="当前作品的检索索引"]')?.textContent ?? ''
    await vi.waitFor(() => expect(index()).toContain('配置并启用检索模型后'))

    const embedding = { ...LOCAL, id: 'embed', name: '本机向量', purposes: ['embedding'] } as ModelProfile
    configured = true
    await act(async () => useLLMStore.setState({ models: [MODEL, LOCAL, embedding], defaultEmbeddingModelId: 'embed' }))
    await vi.waitFor(() => expect(byName('检查并重建向量索引')).toBeTruthy())
    expect(index()).toContain('当前作品有 4 段资料还没有按检索模型建立索引')

    configured = false
    await act(async () => useLLMStore.setState({ models: [MODEL, LOCAL], defaultEmbeddingModelId: null }))
    await vi.waitFor(() => expect(index()).toContain('配置并启用检索模型后'))
    expect(byName('检查并重建向量索引')).toBeUndefined()
  })

  it('设置页开着时 Ctrl S 不保存藏在后面的标签', async () => {
    const save = vi.fn(async () => undefined)
    const off = registerEditorExitSaveHandler({ tabId: 'config-tab', type: 'config', save })
    try {
      useEditorStore.setState({ tabs: [{ id: 'config-tab', name: '设定', type: 'config', dirty: true }], activeTabId: 'config-tab' })
      await mount()
      await key('s', window, COMMAND)
      expect(save).not.toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('删除模型先出现危险确认，写明后果；取消不删，确认才删', async () => {
    await mount()
    expect([...host!.querySelectorAll('[aria-label="AI 模型"] li')].map(item => item.querySelector('.stage-set-model-name')?.textContent))
      .toEqual(['DeepSeek V4 Flash默认', '本机 Ollama'])

    await click(byName('「DeepSeek V4 Flash」更多操作'))
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除模型…')
    await click(menuItem)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('删除「DeepSeek V4 Flash」？')
    expect(dialog.textContent).toContain('它是默认模型。删除后要先另选一个默认模型')
    await click([...dialog.querySelectorAll('button')].find(button => button.textContent === '取消'))
    expect(useLLMStore.getState().deleteModel).not.toHaveBeenCalled()

    await click(byName('「本机 Ollama」更多操作'))
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除模型…'))
    const second = document.querySelector('[role="dialog"]')!
    expect(second.textContent).toContain('名称、接口地址和密钥会从本机删除')
    await click([...second.querySelectorAll('button')].find(button => button.textContent === '删除模型'))
    expect(useLLMStore.getState().deleteModel).toHaveBeenCalledWith('local')
  })

  it('保存模型时主进程出错：弹出错误，保存按钮恢复可点，编辑表单留着', async () => {
    useLLMStore.setState({ saveModel: vi.fn(async () => { throw new Error('llm:save-model 不可用') }) })
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await click(byName('保存配置'))

    const alert = document.querySelector('[role="alertdialog"]')
    expect(alert?.textContent).toContain('模型设置保存失败')
    expect(alert?.textContent).toContain('llm:save-model 不可用')
    expect(byName('保存配置')?.disabled).toBe(false)
    await click([...alert!.querySelectorAll('button')].find(button => button.textContent === '确定'))
    await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('有生成正在用这个模型时，保存前先提示：等它结束再保存就不保存、表单留着；仍然保存才保存；没在用的模型直接保存', async () => {
    const saveModel = vi.fn(async () => true)
    useLLMStore.setState({ saveModel })
    // 架构生成没有单独选模型，用的是默认模型 flash。
    useWorkflowStore.setState({ activeRuns: [{ id: '运行', title: '生成故事架构', type: 'architecture_generation', status: 'running' } as never] })
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await click(byName('保存配置'))
    const prompt = () => document.querySelector('[role="dialog"]')
    await expect.poll(() => prompt()?.textContent).toContain('保存后这次生成会在下一章停下')
    expect(prompt()!.textContent).toContain('生成故事架构')
    await click([...prompt()!.querySelectorAll('button')].find(button => button.textContent === '等生成结束再保存'))
    await expect.poll(() => prompt()).toBeNull()
    expect(saveModel).not.toHaveBeenCalled()
    expect(byName('保存配置')?.disabled).toBe(false)

    await click(byName('保存配置'))
    await expect.poll(() => prompt()?.textContent).toContain('保存后这次生成会在下一章停下')
    await click([...prompt()!.querySelectorAll('button')].find(button => button.textContent === '仍然保存'))
    await expect.poll(() => saveModel.mock.calls.length).toBe(1)
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'flash' }))

    await expect.poll(() => byName('编辑「本机 Ollama」')).toBeTruthy()
    await click(byName('编辑「本机 Ollama」'))
    await click(byName('保存配置'))
    await expect.poll(() => saveModel.mock.calls.length).toBe(2)
    expect(prompt()).toBeNull()
  })

  it('没有模型时是空状态，唯一的主按钮是添加模型', async () => {
    useLLMStore.setState({ models: [], defaultModelId: null })
    await mount()
    expect(host!.textContent).toContain('还没有添加模型')
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(button => button.textContent)).toEqual(['添加模型'])
  })

  it('缩放在外观里：放大、缩小、还原', async () => {
    const zoomIn = vi.fn()
    const zoomOut = vi.fn()
    const zoomReset = vi.fn()
    useThemeStore.setState({ zoom: 1.1, zoomIn, zoomOut, zoomReset })
    useLayoutStore.setState({ settingsSection: 'appearance' })
    await mount()
    const group = host!.querySelector('[role="group"][aria-label="界面缩放"]')!
    expect(group.querySelector('output')?.textContent).toBe('110%')
    await click(byName('放大'))
    await click(byName('缩小'))
    await click(byName('还原'))
    expect([zoomIn.mock.calls.length, zoomOut.mock.calls.length, zoomReset.mock.calls.length]).toEqual([1, 1, 1])
  })

  it('主题单选组只占一个 Tab 停靠点，方向键换主题并移动焦点，带修饰键时不动', async () => {
    const setTheme = vi.fn((theme: string) => useThemeStore.setState({ theme } as never))
    useThemeStore.setState({ theme: 'light', setTheme } as never)
    useLayoutStore.setState({ settingsSection: 'appearance' })
    await mount()
    const radios = () => [...host!.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="主题"] [role="radio"]')]
    expect(radios().map(radio => [radio.textContent, radio.getAttribute('aria-checked'), radio.tabIndex]))
      .toEqual([['浅色纸面与墨色', 'true', 0], ['深色夜里写作', 'false', -1]])

    radios()[0].focus()
    await key('ArrowRight', radios()[0], { altKey: true })
    expect(setTheme).not.toHaveBeenCalled()
    await key('ArrowRight', radios()[0])
    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(document.activeElement).toBe(radios()[1])
    expect(radios().map(radio => radio.tabIndex)).toEqual([-1, 0])
  })

  it('返回或 Esc 关闭设置页；书房里写「返回书房」', async () => {
    await mount(true)
    expect(byName('返回书房')).toBeTruthy()
    await key('Escape')
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => useLayoutStore.setState({ settingsOpen: true }))
    await click(byName('返回书房'))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })

  it('沉浸写作里打开设置页：Esc 收起设置页，仍在沉浸写作；再按 Esc 才退出沉浸', async () => {
    useStageStore.setState({ focus: true })
    await mount()
    await key('Escape')
    expect([useLayoutStore.getState().settingsOpen, useStageStore.getState().focus]).toEqual([false, true])
    await key('Escape')
    expect(useStageStore.getState().focus).toBe(false)
  })

  it('输入框里按 Esc 不关闭设置页', async () => {
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    const name = input('如：DeepSeek 主力 / GPT-4o 备用')
    name.focus()
    await key('Escape', name)
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
  })

  it('下拉框、复选框、单选上的 Esc 照常关闭设置页；有没保存的输入时先确认', async () => {
    useLayoutStore.setState({ settingsSection: 'appearance' })
    await mount()
    const language = host!.querySelector<HTMLSelectElement>('select')!
    language.focus()
    await key('Escape', language)
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    for (const type of ['checkbox', 'radio']) {
      await act(async () => useLayoutStore.setState({ settingsOpen: true }))
      const box = document.createElement('input')
      box.type = type
      host!.querySelector('.stage-set-body')!.append(box)
      await key('Escape', box)
      expect(useLayoutStore.getState().settingsOpen, type).toBe(false)
      box.remove()
    }

    await act(async () => useLayoutStore.setState({ settingsOpen: true }))
    await click(byName('网络代理'))
    await click(host!.querySelector<HTMLElement>('[role="switch"]')!)
    const proxyType = host!.querySelector<HTMLSelectElement>('select')!
    await key('Escape', proxyType)
    expect(discardDialog()).toBeTruthy()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
  })

  it('模型改了没保存：Esc、返回、Ctrl W 先确认；继续编辑留着修改，放弃才关闭', async () => {
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await key('Escape')
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => root!.unmount())
    host!.remove()
    useLayoutStore.setState({ settingsOpen: true })
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await type(input('如：DeepSeek 主力 / GPT-4o 备用'), '主力模型')
    await key('Escape')
    expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。')
    await click(dialogButton('继续编辑'))
    expect(discardDialog()).toBeUndefined()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(input('如：DeepSeek 主力 / GPT-4o 备用').value).toBe('主力模型')

    await key('w', window, { ...COMMAND, code: 'KeyW' })
    expect(discardDialog()).toBeTruthy()
    await click(dialogButton('继续编辑'))

    await click(byName('返回作品'))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    await click(dialogButton('放弃修改'))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })

  it('代理与写作 Skills 有没保存的输入时，切到别的设置页也先确认', async () => {
    useLayoutStore.setState({ settingsSection: 'skills' })
    await mount(true)
    await type(host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!, 'https://github.com/owner/skill')
    await click(byName('外观'))
    expect(useLayoutStore.getState().settingsSection).toBe('skills')
    await click(dialogButton('放弃修改'))
    expect(useLayoutStore.getState().settingsSection).toBe('appearance')

    await click(byName('网络代理'))
    await click(host!.querySelector<HTMLElement>('[role="switch"]')!)
    await click(byName('返回书房'))
    expect(discardDialog()).toBeTruthy()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
  })

  it('有没保存的输入时，顶栏设置、命令面板项目备份这类设置入口换到别的分区也先确认；同一分区不问', async () => {
    useLayoutStore.setState({ settingsSection: 'skills' })
    await mount(true)
    const skillUrl = () => host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!
    await type(skillUrl(), 'https://github.com/owner/skill')

    await act(async () => navigate({ kind: 'settings', section: 'llm' }))
    expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。')
    await click(dialogButton('继续编辑'))
    expect(useLayoutStore.getState().settingsSection).toBe('skills')
    expect(skillUrl().value).toBe('https://github.com/owner/skill')

    await act(async () => navigate({ kind: 'settings', section: 'skills' }))
    expect(discardDialog()).toBeUndefined()

    await act(async () => navigate({ kind: 'settings', section: 'backup' }))
    await click(dialogButton('放弃修改'))
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'backup' })
  })

  it('打开作品途中的默认落点不收起设置页；去具体的阶段才收起', async () => {
    setActiveProjectSessionContext({ projectId: 'p', leaseId: 'l', projectPath: 'C:\\novels\\p' })
    useProjectStore.setState({ currentProject: { id: 'p', sessionLease: 'l', name: '灯塔', path: 'C:\\novels\\p', novelConfig: {} } as unknown as ProjectData })
    useEditorStore.setState({ tabs: [], activeTabId: null })
    navigate({ kind: 'settings', section: 'llm' })
    navigate({ kind: 'stage' })
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    navigate({ kind: 'stage', stage: 'setup' })
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })

  it('有没保存的输入时，去别的阶段、章节或资料页先确认：继续编辑不走、输入还在；放弃才收起并打开去处', async () => {
    setActiveProjectSessionContext({ projectId: 'p', leaseId: 'l', projectPath: 'C:\\novels\\p' })
    useProjectStore.setState({ currentProject: { id: 'p', sessionLease: 'l', name: '灯塔', path: 'C:\\novels\\p', novelConfig: {} } as unknown as ProjectData })
    useEditorStore.setState({ tabs: [], activeTabId: null })
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await type(input('如：DeepSeek 主力 / GPT-4o 备用'), '主力模型')

    await act(async () => navigate({ kind: 'stage', stage: 'architecture' }))
    expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。')
    await click(dialogButton('继续编辑'))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(input('如：DeepSeek 主力 / GPT-4o 备用').value).toBe('主力模型')

    await act(async () => navigate({ kind: 'chapter', chapterNumber: 3 }))
    await click(dialogButton('继续编辑'))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)

    const write = { title: '夜雨', role: '发展', purpose: '交代来信', keyEvents: '收到密信', characters: '林岚', userGuidance: '' }
    await act(async () => navigate({ kind: 'chapter', chapterNumber: 3, write }))
    expect(discardDialog()).toBeTruthy()
    await click(dialogButton('继续编辑'))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useStageStore.getState().writeRequest).toBeNull()

    await act(async () => navigate({ kind: 'run', facet: 'output' }))
    expect(discardDialog()).toBeUndefined()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)

    await act(async () => navigate({ kind: 'resource', page: 'plot' }))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    await click(dialogButton('放弃修改'))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
    expect(useEditorStore.getState().tabs.map(tab => tab.name)).toEqual(['剧情树与叙事线索'])
  })

  it('书房里的设置页有没保存的输入时，回到作品、打开运行侧页这类会离开书房的导航也先确认', async () => {
    setActiveProjectSessionContext({ projectId: 'p', leaseId: 'l', projectPath: 'C:\\novels\\p' })
    useProjectStore.setState({ currentProject: { id: 'p', sessionLease: 'l', name: '灯塔', path: 'C:\\novels\\p', novelConfig: {} } as unknown as ProjectData })
    useLayoutStore.setState({ sidebarView: 'home' })
    await mount(true)
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await type(input('如：DeepSeek 主力 / GPT-4o 备用'), '主力模型')

    for (const intent of [{ kind: 'stage' }, { kind: 'run', facet: 'output' }] as const) {
      await act(async () => navigate(intent))
      expect(discardDialog(), intent.kind).toBeTruthy()
      await click(dialogButton('继续编辑'))
      expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'home', settingsOpen: true })
    }
    await act(async () => navigate({ kind: 'stage' }))
    await click(dialogButton('放弃修改'))
    expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'project', settingsOpen: false })
  })
})
