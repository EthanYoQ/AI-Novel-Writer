import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile } from '../../../shared/ipc-channels'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import SettingsModal from '../SettingsModal'

const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const configuredEmbedding: ModelProfile = {
  id: 'configured-embedding',
  name: 'Existing embedding',
  provider: 'siliconflow',
  protocol: 'openai',
  modelName: 'BAAI/bge-m3',
  apiKey: 'test-key',
  baseUrl: 'https://api.siliconflow.cn/v1',
  temperature: 0.7,
  maxTokens: 0,
  purposes: ['embedding'],
}

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>

async function renderEmbeddingSettings(models: ModelProfile[]) {
  useLayoutStore.setState({ settingsSection: 'embedding' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ models, loaded: true })

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  await act(async () => {
    root?.render(<SettingsModal open onClose={() => {}} />)
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
})

describe('embedding registration entry', () => {
  it.each([
    { name: 'with no configured embedding model', models: [] },
    { name: 'with one configured embedding model', models: [configuredEmbedding] },
  ])('shows the free registration entry $name', async ({ models }) => {
    invoke = vi.fn().mockResolvedValue({ success: true })
    ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
      invoke,
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    await renderEmbeddingSettings(models)

    await expect.element(page.getByRole('button', { name: '免费模型注册链接', exact: true })).toBeVisible()
  })

  it('opens the fixed SiliconFlow registration resource through IPC', async () => {
    invoke = vi.fn().mockResolvedValue({ success: true })
    ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
      invoke,
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    await renderEmbeddingSettings([])
    await act(async () => {
      await page.getByRole('button', { name: '免费模型注册链接', exact: true }).click()
    })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('model-provider-resource:open', 'siliconflow-invite')
    })
  })

  it('hides the recommendation after the user enters the add-embedding form', async () => {
    invoke = vi.fn().mockResolvedValue({ success: true })
    ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
      invoke,
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    await renderEmbeddingSettings([])
    await act(async () => {
      await page.getByRole('button', { name: '添加向量模型', exact: true }).click()
    })

    await expect.element(page.getByText('向量化高级参数', { exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain('免费模型注册链接')
  })
})
