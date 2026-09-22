import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StatusBarV2 from '../StatusBarV2'

/**
 * 先生反馈：「顶栏的当前模型怎么不显示了」。
 *
 * 真实原因不是模型丢了：`config.json` 的 defaultModelId 指向的模型存在，
 * 但那个模型**没有别名**（别名允许为空，见 model-profile-draft.ts），
 * 而界面只渲染 `model.name` —— 于是渲染出一片空白，看着就像模型不见了。
 *
 * 这里用先生机器上的真实数据形状（name 为空、modelName 有值）锁住回退行为。
 */
const originalLLMState = useLLMStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function model(name: string) {
  return {
    id: '2164cc65-5895-499b-85f4-34ea577866dc',
    name,
    modelName: 'deepseek-v4-flash',
    provider: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    purposes: ['generation'],
  } as never
}

beforeEach(async () => {
  await page.viewport(1200, 700)
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ ...originalProjectState, currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  container = document.createElement('div')
  container.style.width = '1200px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLLMStore.setState(originalLLMState)
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

async function renderStatusBar(currentName: string): Promise<void> {
  useLLMStore.setState({
    models: [model(currentName)],
    defaultModelId: '2164cc65-5895-499b-85f4-34ea577866dc',
    defaultEmbeddingModelId: null,
    loaded: true,
  } as never)
  await act(async () => root.render(<StatusBarV2 />))
}

describe('status bar current model label', () => {
  it('shows the model identifier when the model has no alias', async () => {
    await renderStatusBar('')

    expect(container.textContent).toContain('deepseek-v4-flash')
    expect(container.textContent).not.toContain('未配置模型')
  })

  it('still prefers the alias when the author gave one', async () => {
    await renderStatusBar('主力模型')

    expect(container.textContent).toContain('主力模型')
  })

  it('says "no model configured" only when there really is no matching model', async () => {
    useLLMStore.setState({
      models: [model('')],
      defaultModelId: 'some-other-id',
      defaultEmbeddingModelId: null,
      loaded: true,
    } as never)
    await act(async () => root.render(<StatusBarV2 />))

    expect(container.textContent).toContain('未配置模型')
  })
})
