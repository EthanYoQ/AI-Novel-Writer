import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile } from '../../../../shared/ipc-channels'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import StageSettings from '../StageSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
const win = window as unknown as { aiNovelAPI?: { invoke: Invoke; on: () => () => void } }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useLLMStore), snapshot(useLocaleStore)]

const FLASH = { id: 'flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'k', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] } as ModelProfile
const GLM = { ...FLASH, id: 'glm', name: 'GLM 审稿', provider: 'bigmodel', modelName: 'glm-4.6' } as ModelProfile
const BGE = { ...FLASH, id: 'bge', name: 'BGE M3', modelName: 'bge-m3', purposes: ['embedding'] } as ModelProfile

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<Invoke>>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 860px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageSettings library={false} />))
}

const row = (stage: string) => host!.querySelector<HTMLElement>(`[data-stage="${stage}"]`)!
const select = (stage: string) => row(stage).querySelector('select')!
const optionLabels = (stage: string) => [...select(stage).options].map(option => option.textContent)
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === name)

async function choose(stage: string, value: string) {
  await act(async () => {
    const element = select(stage)
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { await Promise.resolve() })
}

function savedAssignment(request: unknown) {
  const { stage, modelId } = request as { stage: string; modelId: string | null }
  return { success: true, stageModelIds: modelId ? { [stage]: modelId } : {} }
}

beforeEach(() => {
  invoke = vi.fn<Invoke>(async (channel, request) => channel === 'llm:set-stage-model' ? savedAssignment(request) : undefined)
  win.aiNovelAPI = { invoke, on: () => () => undefined }
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [FLASH, GLM, BGE], defaultModelId: 'flash', defaultEmbeddingModelId: 'bge', stageModelIds: {} })
  useLayoutStore.setState({ settingsOpen: true, settingsSection: 'stage-models' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  for (const restore of restores) restore()
})

describe('分工模型设置页', () => {
  it('五个环节各一行，第一项跟随默认并写出默认模型，只列生成模型', async () => {
    await mount()
    expect(host!.querySelector('h1')?.textContent).toBe('分工模型')
    expect([...host!.querySelectorAll('[data-stage] .stage-set-row-title')].map(title => title.textContent)).toEqual(['规划', '写稿', '审稿', '修稿', '定稿后处理'])
    expect(optionLabels('review')).toEqual(['跟随默认（DeepSeek V4 Flash）', 'DeepSeek V4 Flash', 'GLM 审稿'])
    expect(row('finalization').textContent).toContain('批量写作的自动定稿')
  })

  it('选中即保存，保存后显示新的指定；改回跟随默认时删掉指定', async () => {
    await mount()
    await choose('review', 'glm')
    expect(invoke).toHaveBeenCalledWith('llm:set-stage-model', { stage: 'review', modelId: 'glm' })
    expect(useLLMStore.getState().stageModelIds).toEqual({ review: 'glm' })
    expect(select('review').value).toBe('glm')

    await choose('review', '')
    expect(invoke).toHaveBeenLastCalledWith('llm:set-stage-model', { stage: 'review', modelId: null })
    expect(select('review').value).toBe('')
  })

  it('保存失败时提示原因，下拉回到原来的选择', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'glm' } })
    invoke.mockImplementation(async channel => channel === 'llm:set-stage-model' ? { success: false, error: 'Error: LLM_STAGE_MODEL_UNAVAILABLE' } : undefined)
    await mount()
    await choose('review', 'flash')
    expect(select('review').value).toBe('glm')
    expect(document.body.textContent).toContain('分工设置没有保存')
    expect(document.body.textContent).toContain('不能用于文本生成')
    await act(async () => button('确定')?.click())
  })

  it('指定的模型已删除或不再是生成模型时提示按默认运行，可以一键改回跟随默认', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'gone', planning: 'bge' } })
    await mount()
    expect(row('review').textContent).toContain('现按默认模型运行')
    expect(row('planning').textContent).toContain('现按默认模型运行')
    expect(row('drafting').textContent).not.toContain('现按默认模型运行')
    expect(select('review').value).toBe('')
    await act(async () => row('review').querySelector<HTMLButtonElement>('.stage-set-stale button')!.click())
    expect(invoke).toHaveBeenCalledWith('llm:set-stage-model', { stage: 'review', modelId: null })
  })

  it('没有生成模型时是空状态，按钮去「AI 模型」', async () => {
    useLLMStore.setState({ models: [BGE], defaultModelId: null })
    await mount()
    expect(host!.querySelector('[data-stage]')).toBeNull()
    expect(host!.textContent).toContain('还没有生成模型')
    await act(async () => button('去添加模型')!.click())
    expect(useLayoutStore.getState().settingsSection).toBe('llm')
  })

  it('只有一个生成模型时说明各环节都用它，下拉不可选', async () => {
    useLLMStore.setState({ models: [FLASH, BGE] })
    await mount()
    expect(host!.textContent).toContain('只有一个生成模型时，各环节都用它')
    expect([...host!.querySelectorAll<HTMLSelectElement>('[data-stage] select')].every(element => element.disabled)).toBe(true)
  })

  it('「AI 模型」页在有环节另有指定时显示一行提示，点击去分工模型', async () => {
    useLayoutStore.setState({ settingsSection: 'llm' })
    await mount()
    expect(host!.textContent).not.toContain('部分环节在「分工模型」里另有指定')
    await act(async () => useLLMStore.setState({ stageModelIds: { review: 'glm' } }))
    expect(host!.textContent).toContain('部分环节在「分工模型」里另有指定')
    await act(async () => button('去分工模型')!.click())
    expect(useLayoutStore.getState().settingsSection).toBe('stage-models')
    expect(host!.querySelector('h1')?.textContent).toBe('分工模型')
  })

  it('英文界面', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await mount()
    expect(host!.querySelector('h1')?.textContent).toBe('Models by stage')
    expect([...host!.querySelectorAll('[data-stage] .stage-set-row-title')].map(title => title.textContent)).toEqual(['Planning', 'Drafting', 'Review', 'Revision', 'After finalizing'])
    expect(optionLabels('planning')[0]).toBe('Default (DeepSeek V4 Flash)')
  })
})
