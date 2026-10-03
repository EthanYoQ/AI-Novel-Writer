import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { ModelDiscoveryResult, ModelProfile } from '../../../shared/ipc-channels'
import type { Locale } from '../../../i18n/types'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import SettingsModal from '../SettingsModal'

const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

function savedProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'saved-discovery-profile',
    name: 'Discovery profile',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'manual-model',
    apiKey: `credential-${crypto.randomUUID()}`,
    baseUrl: 'https://provider.invalid/v1',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

function discoveryRequest(model: ModelProfile) {
  return {
    provider: model.provider,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

async function renderSettings(
  model: ModelProfile,
  discoverModels: ReturnType<typeof useLLMStore.getState>['discoverModels'],
  locale: Locale = 'zh-CN',
  additionalModels: ModelProfile[] = [],
  onClose = vi.fn(),
  persisted = true,
) {
  const saveModel = vi.fn<(model: ModelProfile) => Promise<boolean>>(async () => true)
  const setDefaultModel = vi.fn(async () => true)
  useLayoutStore.setState({ settingsSection: 'llm' })
  useLocaleStore.setState({ locale })
  useLLMStore.setState({
    models: persisted ? [model, ...additionalModels] : additionalModels,
    loaded: true,
    defaultModelId: model.id,
    saveModel,
    setDefaultModel,
    discoverModels,
  })
  ;(window as unknown as { aiNovelAPI: TestVelaApi }).aiNovelAPI = {
    invoke: vi.fn(),
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SettingsModal open onClose={onClose} />)
  })
  return { saveModel, setDefaultModel, onClose }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  delete (window as unknown as { aiNovelAPI?: TestVelaApi }).aiNovelAPI
  vi.restoreAllMocks()
})

describe('model discovery settings flow', () => {
  it('previews and preserves separate Qwen thinking budgets after saving and reopening', async () => {
    const model = savedProfile({ baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B',
      maxTokens: 16384, reasoningOverride: 'medium' })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.textContent).toContain('数字预算是应用映射')
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=true; thinking_budget=16384')
    const mapping = { adapter: 'openai-thinking-budget', supportedEfforts: ['off', 'medium'], providerValues: { off: 0, medium: 4096 } }
    await act(async () => {
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: mapping, reasoningOverride: 'medium', maxTokens: 16384 }))
    const saved = saveModel.mock.calls[0][0]
    await act(async () => { useLLMStore.setState({ models: [JSON.parse(JSON.stringify(saved))] }) })
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=true; thinking_budget=4096')
    await act(async () => { await page.getByLabelText('模型推理覆盖').selectOptions('off') })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=false')
  })

  it.each([
    { baseUrl: 'https://api.x.ai/v1', value: 'grok-4.5', declared: undefined, context: 500000, output: 8192 },
    { baseUrl: 'https://new.test/v1', value: 'unlisted', declared: { contextWindowTokens: 64000, maxOutputTokens: 12000, reasoning: true }, context: 64000, output: 12000 },
  ])('applies endpoint selection metadata and preserves the author limit: $value', async ({ baseUrl, value, declared, context, output }) => {
    const model = savedProfile({ baseUrl, maxTokens: 2048 })
    const discoverModels = vi.fn(async () => ({ success: true as const,
      models: [{ id: value, name: value, value, capabilities: declared }] }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
      await page.getByLabelText('端点模型列表').selectOptions(value)
      await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(context)
      await page.getByLabelText('上下文窗口', { exact: true }).fill('32000')
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByLabelText('最大输出 Token', { exact: true }).fill('1024')
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    expect(saveModel).not.toHaveBeenCalled()
    await expect.element(page.getByLabelText('最大输出 Token', { exact: true })).toHaveValue(1024)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: value, maxTokens: 1024,
      capabilities: expect.objectContaining({ contextWindowTokens: 32000, maxOutputTokens: output, reasoning: true }),
      capabilitySources: expect.objectContaining({ contextWindowTokens: 'manual', maxOutputTokens: declared ? 'endpoint' : 'preset' }) }))
    const saved = saveModel.mock.calls[0][0] as unknown as ModelProfile
    await act(async () => { useLLMStore.setState({ models: [JSON.parse(JSON.stringify(saved))] }) })
    await act(async () => { await page.getByRole('button', { name: '编辑', exact: true }).click() })
    expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain('上下文：手动设置')
    expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain(declared ? '模型输出容量：接口取得' : '模型输出容量：资料匹配')
  })

  it('applies, rejects and clears an advanced mapping before saving', async () => {
    const { saveModel } = await renderSettings(savedProfile(), vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill('{broken')
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
    })
    await expect.element(page.getByRole('alert')).toHaveTextContent('映射无效')
    const mapping = { adapter: 'openai-reasoning-effort', supportedEfforts: ['xhigh'], providerValues: { xhigh: 'Extra' } }
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByLabelText('模型推理覆盖').selectOptions('xhigh')
    })
    expect(container?.textContent).toContain('reasoning_effort=Extra')
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify({ adapter: 'deepseek-v4-thinking',
        supportedEfforts: ['off', 'high'], providerValues: { off: 'disabled', high: 'enabled' } }))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
    })
    expect(container?.textContent).toContain('仅支持思考开关')
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill('')
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByLabelText('模型推理覆盖').selectOptions('off')
    })
    expect(container?.textContent).toContain('未发送 / 供应商默认')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: undefined, reasoningOverride: 'off' }))
  })
  it('does not discover when settings opens and refreshes explicitly with the current form configuration', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [
        { id: 'provider/model-a', name: 'Model A', value: 'provider/model-a' },
      ],
    }))
    await renderSettings(model, discoverModels)

    expect(discoverModels).not.toHaveBeenCalled()
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
    })
    expect(discoverModels).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model)))
    expect(discoverModels.mock.calls[0]).toEqual([discoveryRequest(model)])
    await expect.element(page.getByLabelText('端点模型列表')).toBeVisible()
  })

  it('refreshes models from a new unsaved endpoint and credentials', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [{ id: 'fresh-model', name: 'Fresh model', value: 'fresh-model' }],
    }))
    await renderSettings(model, discoverModels, 'zh-CN', [], vi.fn(), false)
    await act(async () => {
      await page.getByRole('button', { name: '添加第一个生成模型', exact: true }).click()
    })

    const editedBaseUrl = 'https://edited-provider.invalid/v1'
    const editedApiKey = `edited-${crypto.randomUUID()}`
    const baseUrlInput = Array.from(document.querySelectorAll('input'))
      .find(candidate => candidate.value === 'https://api.openai.com')
    const apiKeyInput = document.querySelector('input[placeholder="sk-..."]')
    if (!(baseUrlInput instanceof HTMLInputElement)) throw new Error('Missing base URL input')
    if (!(apiKeyInput instanceof HTMLInputElement)) throw new Error('Missing API key input')
    for (const [input, nextValue] of [
      [baseUrlInput, editedBaseUrl],
      [apiKeyInput, editedApiKey],
    ] as const) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, nextValue)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith({
      provider: 'openai',
      protocol: 'openai',
      baseUrl: editedBaseUrl,
      apiKey: editedApiKey,
    }))
    await expect.element(page.getByLabelText('端点模型列表')).toBeVisible()
  })

  it('keeps configuration open on backdrop clicks and closes only from the explicit close button', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn()
    const { onClose } = await renderSettings(model, discoverModels)
    const backdrop = container?.firstElementChild
    if (!(backdrop instanceof HTMLDivElement)) throw new Error('Missing settings backdrop')

    await act(async () => backdrop.click())
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('allows saving a complete manual configuration without a display name', async () => {
    const model = savedProfile({ name: '' })
    const discoverModels = vi.fn()
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
    })

    await expect.element(page.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled()
    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledWith(model))
  })

  it('clears stale capabilities for an unknown selected id and saves only after confirmation', async () => {
    const model = savedProfile({
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4096,
        reasoning: false,
        structuredOutput: false,
        usage: false,
      },
      reasoningOverride: 'off',
    })
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [
        { id: 'provider/model-a', name: 'Model A', value: 'provider/model-a' },
        { id: 'provider/model-b', name: 'Model B', value: 'provider/model-b' },
      ],
    }))
    const { saveModel, setDefaultModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    const discoveredSelect = document.querySelector('select[aria-label="端点模型列表"]')
    if (!(discoveredSelect instanceof HTMLSelectElement)) throw new Error('Missing discovered model selector')
    await act(async () => {
      discoveredSelect.value = 'provider/model-b'
      discoveredSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(saveModel).not.toHaveBeenCalled()
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(useLLMStore.getState().defaultModelId).toBe(model.id)
    const manualModelInput = Array.from(document.querySelectorAll('input'))
      .find(input => input.value === 'provider/model-b')
    expect(manualModelInput).toBeInstanceOf(HTMLInputElement)

    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledTimes(1))
    expect(saveModel).toHaveBeenCalledWith({
      ...model,
      modelName: 'provider/model-b',
      capabilities: undefined,
      capabilitySources: { contextWindowTokens: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown', structuredOutput: 'unknown', usage: 'unknown' },
      reasoningOverride: 'auto',
    })
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(useLLMStore.getState().defaultModelId).toBe(model.id)
  })

  it('keeps manual model input available after discovery fails', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: false as const,
      errorCode: 'unsupported' as const,
    }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await expect.element(page.getByText('该端点不支持标准模型列表接口。请继续手工填写模型 ID。', { exact: true })).toBeVisible()
    const manualModelInput = Array.from(document.querySelectorAll('input'))
      .find(input => input.value === model.modelName)
    if (!(manualModelInput instanceof HTMLInputElement)) throw new Error('Missing manual model input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(manualModelInput, 'manual-fallback-model')
      manualModelInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(saveModel).not.toHaveBeenCalled()
    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledWith({
      ...model,
      modelName: 'manual-fallback-model',
      capabilities: undefined,
      capabilitySources: { contextWindowTokens: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown', structuredOutput: 'unknown', usage: 'unknown' },
      reasoningOverride: 'auto',
    }))
  })

  it('ignores a pending discovery after its endpoint configuration is edited', async () => {
    const model = savedProfile()
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))

    const endpointInput = Array.from(document.querySelectorAll('input'))
      .find(candidate => candidate.value === model.baseUrl)
    if (!(endpointInput instanceof HTMLInputElement)) throw new Error('Missing endpoint input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(endpointInput, 'https://edited-provider.invalid/v1')
      endpointInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
    expect(discoverModels).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-model', name: 'Stale model', value: 'stale-model' }],
      })
      await pendingDiscovery
    })

    expect(document.querySelector('select[aria-label="端点模型列表"]')).toBeNull()
  })

  it('ignores a pending discovery after switching to another saved profile', async () => {
    const first = savedProfile({ id: 'first-profile', name: 'First profile' })
    const second = savedProfile({ id: 'second-profile', name: 'Second profile', modelName: 'second-manual-model' })
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(first, discoverModels, 'zh-CN', [second])

    const clickEditButton = async (index: number) => {
      const buttons = Array.from(document.querySelectorAll('button[title="编辑"]'))
      const button = buttons[index]
      if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing edit button ${index}`)
      await act(async () => button.click())
    }

    await clickEditButton(0)
    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(first)))
    await act(async () => {
      await page.getByRole('button', { name: '取消', exact: true }).click()
    })
    await clickEditButton(1)

    await act(async () => {
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-first-model', name: 'Stale first model', value: 'stale-first-model' }],
      })
      await pendingDiscovery
    })

    expect(document.querySelector('select[aria-label="端点模型列表"]')).toBeNull()
    expect(Array.from(document.querySelectorAll('input')).some(input => input.value === second.modelName)).toBe(true)
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it('ignores a pending discovery after settings is closed and reopened', async () => {
    const model = savedProfile()
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))

    await act(async () => {
      root?.render(<SettingsModal open={false} onClose={() => {}} />)
    })
    await act(async () => {
      root?.render(<SettingsModal open onClose={() => {}} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-closed-model', name: 'Stale closed model', value: 'stale-closed-model' }],
      })
      await pendingDiscovery
    })

    expect(document.querySelector('select[aria-label="端点模型列表"]')).toBeNull()
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it.each([
    {
      errorCode: 'auth' as const,
      locale: 'zh-CN' as const,
      expected: '鉴权失败：请检查 API Key。手工模型 ID 仍可使用。',
    },
    {
      errorCode: 'auth' as const,
      locale: 'en-US' as const,
      expected: 'Authentication failed. Check the API key. Manual model IDs remain available.',
    },
    {
      errorCode: 'unsupported' as const,
      locale: 'zh-CN' as const,
      expected: '该端点不支持标准模型列表接口。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'unsupported' as const,
      locale: 'en-US' as const,
      expected: 'This endpoint does not support the standard model-list API. Continue with a manual model ID.',
    },
    {
      errorCode: 'network' as const,
      locale: 'zh-CN' as const,
      expected: '网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。',
    },
    {
      errorCode: 'network' as const,
      locale: 'en-US' as const,
      expected: 'The network request failed. Check the endpoint or network and retry. Manual model IDs remain available.',
    },
    {
      errorCode: 'invalid_response' as const,
      locale: 'zh-CN' as const,
      expected: '端点返回了无法识别的模型列表。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'invalid_response' as const,
      locale: 'en-US' as const,
      expected: 'The endpoint returned an invalid model list. Continue with a manual model ID.',
    },
    {
      errorCode: 'empty' as const,
      locale: 'zh-CN' as const,
      expected: '端点返回了空模型列表。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'empty' as const,
      locale: 'en-US' as const,
      expected: 'The endpoint returned an empty model list. Continue with a manual model ID.',
    },
  ])('renders $locale $errorCode guidance', async ({ errorCode, locale, expected }) => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({ success: false as const, errorCode }))
    await renderSettings(model, discoverModels, locale)
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? '编辑' : 'Edit', exact: true }).click()
      await page.getByRole('button', { name: locale === 'zh-CN' ? '获取模型列表' : 'Refresh model list', exact: true }).click()
    })
    await expect.element(page.getByText(expected, { exact: true })).toBeVisible()
  })

  it('reduces an IPC rejection to generic network guidance and re-enables refresh', async () => {
    const model = savedProfile()
    const sensitiveDetail = `ipc-${model.apiKey}-${model.baseUrl}`
    const discoverModels = vi.fn(async () => {
      throw new Error(sensitiveDetail)
    })
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await expect.element(page.getByText('网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。', { exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain(sensitiveDetail)
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })
})
