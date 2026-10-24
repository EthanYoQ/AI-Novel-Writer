import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'

import type { ModelDiscoveryResult, ModelProfile } from '../../../shared/ipc-channels'
import type { Locale } from '../../../i18n/types'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import StageSettings from '../../stage/settings/StageSettings'

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
    purposes: model.purposes,
  }
}

const suggestionOptions = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const suggestionValues = () => suggestionOptions().map(option => option.querySelector('span')?.textContent ?? '')
const recommendedValues = () => suggestionOptions()
  .filter(option => /推荐|Recommended/u.test(option.textContent ?? ''))
  .map(option => option.querySelector('span')?.textContent ?? '')
const modelNameInput = () => {
  const input = document.querySelector('input[role="combobox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing model name combobox')
  return input
}

async function openSuggestions(locale: Locale = 'zh-CN') {
  if (modelNameInput().getAttribute('aria-expanded') === 'true') {
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? '收起候选模型' : 'Hide model suggestions', exact: true }).click()
    })
  }
  await act(async () => {
    await page.getByRole('button', { name: locale === 'zh-CN' ? '展开候选模型' : 'Show model suggestions', exact: true }).click()
  })
}

async function chooseSuggestion(value: string) {
  const option = suggestionOptions().find(candidate => candidate.querySelector('span')?.textContent === value)
  if (!option) throw new Error(`Missing suggestion ${value}`)
  await act(async () => option.click())
}

async function typeInto(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

let root: Root | undefined
let container: HTMLDivElement | undefined

async function renderSettings(
  model: ModelProfile,
  discoverModels: ReturnType<typeof useLLMStore.getState>['discoverModels'],
  locale: Locale = 'zh-CN',
  additionalModels: ModelProfile[] = [],
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
    root?.render(<StageSettings library={false} />)
  })
  return { saveModel, setDefaultModel }
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(suggestionValues()).toContain(value))
    await chooseSuggestion(value)
    await act(async () => {
      await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(context)
      await page.getByLabelText('上下文窗口', { exact: true }).fill('32000')
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByLabelText('最大输出 Tokens', { exact: true }).fill('1024')
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    expect(saveModel).not.toHaveBeenCalled()
    await expect.element(page.getByLabelText('最大输出 Tokens', { exact: true })).toHaveValue(1024)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: value, maxTokens: 1024,
      capabilities: expect.objectContaining({ contextWindowTokens: 32000, maxOutputTokens: output, reasoning: true }),
      capabilitySources: expect.objectContaining({ contextWindowTokens: 'manual', maxOutputTokens: declared ? 'endpoint' : 'preset' }) }))
    const saved = saveModel.mock.calls[0][0] as unknown as ModelProfile
    await act(async () => { useLLMStore.setState({ models: [JSON.parse(JSON.stringify(saved))] }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain('上下文：手动设置')
    expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain(declared ? '模型输出容量：接口取得' : '模型输出容量：资料匹配')
  })

  it('previews the Gemini 3 thinking level and accepts a thinking-level mapping on the Gemini protocol', async () => {
    const model = savedProfile({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-3.8-flash', reasoningOverride: 'high' })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('thinking_level=high')
    const mapping = { adapter: 'gemini-thinking-level', supportedEfforts: ['high'], providerValues: { high: 'medium' } }
    await act(async () => {
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: mapping }))
  })

  it.each([
    ['zh-CN', '关闭 → 低', 'Gemini 3 无法完全关闭思考'],
    ['en-US', 'Off → Low', 'Gemini 3 cannot turn thinking fully off'],
  ] as const)('explains in %s that turning thinking off on Gemini 3 sends its lowest level', async (locale, outcome, note) => {
    const model = savedProfile({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-3.1-pro-preview', reasoningOverride: 'off' })
    await renderSettings(model, vi.fn(), locale)
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? /^编辑「/ : /^Edit “/ }).click()
      await page.getByRole('button', { name: locale === 'zh-CN' ? '高级设置' : 'Advanced settings', exact: true }).click()
    })
    const settings = container?.querySelector('[data-model-reasoning-override-settings]')?.textContent ?? ''
    expect(settings).toContain(outcome)
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('thinking_level=low')
    expect(settings).toContain(note)
  })

  it('does not show the Gemini 3 thinking note for other models', async () => {
    await renderSettings(savedProfile({ reasoningOverride: 'off' }), vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-model-reasoning-override-settings]')?.textContent).not.toContain('Gemini 3')
  })

  it('applies, rejects and clears an advanced mapping before saving', async () => {
    const { saveModel } = await renderSettings(savedProfile(), vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
    })
    expect(discoverModels).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model)))
    expect(discoverModels.mock.calls[0]).toEqual([discoveryRequest(model)])
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['provider/model-a']))
  })

  it('refreshes models from a new unsaved endpoint and credentials', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [{ id: 'fresh-model', name: 'Fresh model', value: 'fresh-model' }],
    }))
    await renderSettings(model, discoverModels, 'zh-CN', [], false)
    await act(async () => {
      await page.getByRole('button', { name: '添加模型', exact: true }).click()
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
      purposes: ['generation', 'refinement', 'summary'],
    }))
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh-model']))
  })

  it('allows saving a complete manual configuration without a display name', async () => {
    const model = savedProfile({ name: '' })
    const discoverModels = vi.fn()
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(suggestionValues()).toEqual(['provider/model-a', 'provider/model-b']))
    await chooseSuggestion('provider/model-b')

    expect(saveModel).not.toHaveBeenCalled()
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(useLLMStore.getState().defaultModelId).toBe(model.id)
    expect(modelNameInput().value).toBe('provider/model-b')
    expect(suggestionOptions()).toHaveLength(0)

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
      await page.getByRole('button', { name: /^编辑「/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
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

    expect(suggestionValues()).not.toContain('stale-model')
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
      const buttons = Array.from(document.querySelectorAll('button[aria-label^="编辑「"]'))
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

    discoverModels.mockImplementation(async () => ({ success: true as const, models: [{ id: 'fresh', name: 'fresh', value: 'fresh' }] }))
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh']))
    expect(modelNameInput().value).toBe(second.modelName)
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))

    await act(async () => {
      root?.render(<></>)
    })
    await act(async () => {
      root?.render(<StageSettings library={false} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-closed-model', name: 'Stale closed model', value: 'stale-closed-model' }],
      })
      await pendingDiscovery
    })

    discoverModels.mockImplementation(async () => ({ success: true as const, models: [{ id: 'fresh', name: 'fresh', value: 'fresh' }] }))
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh']))
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
      errorCode: 'no_models' as const,
      locale: 'zh-CN' as const,
      expected: '端点没有返回任何模型。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'no_models' as const,
      locale: 'en-US' as const,
      expected: 'The endpoint returned no models. Continue with a manual model ID.',
    },
    {
      errorCode: 'no_suitable_models' as const,
      locale: 'zh-CN' as const,
      expected: '端点返回的模型都不适合当前用途。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'no_suitable_models' as const,
      locale: 'en-US' as const,
      expected: 'None of the endpoint models fit this purpose. Continue with a manual model ID.',
    },
  ])('renders $locale $errorCode guidance', async ({ errorCode, locale, expected }) => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({ success: false as const, errorCode }))
    await renderSettings(model, discoverModels, locale)
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? /^编辑「/ : /^Edit “/ }).click()
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
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await expect.element(page.getByText('网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。', { exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain(sensitiveDetail)
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it.each([
    { locale: 'zh-CN' as const, add: '添加模型', badge: '推荐' },
    { locale: 'en-US' as const, add: 'Add model', badge: 'Recommended' },
  ])('shows the provider presets as $locale recommendations without requesting the endpoint when no key is filled', async ({ locale, add, badge }) => {
    const discoverModels = vi.fn()
    await renderSettings(savedProfile(), discoverModels, locale, [], false)
    await act(async () => { await page.getByRole('button', { name: add, exact: true }).click() })
    await openSuggestions(locale)

    const openaiPresets = ['gpt-4.1', 'gpt-4.1-2025-04-14', 'o3', 'gpt-4o']
    expect(suggestionValues().slice(0, openaiPresets.length)).toEqual(openaiPresets)
    expect(recommendedValues()).toEqual([])
    expect(suggestionOptions()[0].textContent).not.toContain(badge)
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(locale === 'zh-CN' ? /^候选为推荐模型。/u : /^Showing recommended models\./u)
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('asks for the endpoint and key before the model name, so a new configuration fetches on the first open', async () => {
    const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'gpt-5.5-mini', name: 'gpt-5.5-mini', value: 'gpt-5.5-mini' }] }))
    await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    const form = modelNameInput().closest('.rounded-xl')
    const labels = Array.from(form?.querySelectorAll('label') ?? []).map(label => label.textContent?.trim())
    const order = ['服务商', '调用协议', 'base_url', 'API Key', 'model（模型名称）'].map(label => labels.indexOf(label))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))

    await typeInto(form!.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-new-key')
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toContain('gpt-5.5-mini'))
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('fetches once when the list is first opened and replaces the presets with the endpoint list', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    const discoverModels = vi.fn(async () => ({ success: true as const, models: [
      { id: 'deepseek-chat-next', name: 'deepseek-chat-next', value: 'deepseek-chat-next' },
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', value: 'deepseek-v4-flash' },
    ] }))
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(discoverModels).not.toHaveBeenCalled()

    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-v4-flash', 'deepseek-chat-next']))
    expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model))
    expect(recommendedValues()).toEqual(['deepseek-v4-flash'])
    await expect.element(page.getByText('已从端点获取 2 个模型。', { exact: true })).toBeVisible()

    await openSuggestions()
    await openSuggestions()
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('keeps the endpoint capability declaration of a recommended model served by a gateway', async () => {
    const model = savedProfile({ provider: 'openai', baseUrl: 'https://gateway.example/v1', modelName: 'manual-model', maxTokens: 65_536 })
    const discoverModels = vi.fn(async () => ({ success: true as const, models: [
      { id: 'gpt-4.1', name: 'gpt-4.1', value: 'gpt-4.1', capabilities: { contextWindowTokens: 16_000, maxOutputTokens: 8_000 } },
    ] }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['gpt-4.1']))
    await chooseSuggestion('gpt-4.1')
    await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(16_000)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'gpt-4.1',
      capabilities: expect.objectContaining({ contextWindowTokens: 16_000, maxOutputTokens: 8_000 }) }))
  })

  it('keeps the list in place while a press on a control below it completes, so the click is not lost', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    const input = modelNameInput()
    await act(async () => { input.focus() })
    const cancel = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消')
    if (!cancel) throw new Error('Missing cancel button')
    const pressedAt = cancel.getBoundingClientRect().top

    // 浏览器的顺序：pointerdown，按下的默认动作让输入框失焦，pointerup，再 click。
    await act(async () => {
      cancel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      cancel.focus({ preventScroll: true })
    })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(cancel.getBoundingClientRect().top).toBe(pressedAt)
    await act(async () => {
      cancel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('starts ArrowUp at the last suggestion after typing, and leaves Enter to the IME while composing', async () => {
    const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const input = modelNameInput()
    await act(async () => { input.focus() })
    await typeInto(input, 'LLAMA')
    await act(async () => { await userEvent.keyboard('{ArrowUp}') })
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.querySelector('span')?.textContent
    expect(active()).toBe('llama3.2')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
    })
    expect(input.value).toBe('LLAMA')
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  it('drops a stale highlight when a refresh replaces the suggestions', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    let settle!: (result: ModelDiscoveryResult) => void
    const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { settle = resolve }))
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const input = modelNameInput()
    await act(async () => { input.focus() })
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    expect(document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.querySelector('span')?.textContent).toBe('deepseek-v4-pro')

    await act(async () => settle({ success: true, models: [
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', value: 'deepseek-v4-flash' },
      { id: 'endpoint-only', name: 'endpoint-only', value: 'endpoint-only' },
    ] }))
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-v4-flash', 'endpoint-only']))
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    await act(async () => { await userEvent.keyboard('{Enter}') })
    expect(input.value).toBe('deepseek-v4-flash')
  })

  it('tells Ollama users to refresh instead of asking for an API key', async () => {
    const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe('候选为推荐模型。点刷新按钮可获取本机已安装的模型。')
  })

  it('collapses the list when focus leaves it with the keyboard', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await act(async () => { modelNameInput().focus() })
    await act(async () => { await userEvent.keyboard('{Tab}') })
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('true')
    await act(async () => { await userEvent.keyboard('{Tab}') })
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('false')
  })

  it('filters suggestions while typing and keeps any typed model name', async () => {
    const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })

    await typeInto(modelNameInput(), 'LLAMA3')
    expect(suggestionValues()).toEqual(['llama3.3', 'llama3.2'])
    await typeInto(modelNameInput(), 'my-private-model')
    expect(suggestionOptions()).toHaveLength(0)
    await expect.element(page.getByText('没有匹配的候选，将使用输入的名称。', { exact: true })).toBeVisible()
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'my-private-model' }))
  })

  it('chooses a suggestion with the arrow keys and Enter, and Escape only closes the list', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const input = modelNameInput()
    await act(async () => { input.focus() })

    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    const active = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
    expect(active?.querySelector('span')?.textContent).toBe('deepseek-v4-pro')
    await act(async () => { await userEvent.keyboard('{Enter}') })
    expect(input.value).toBe('deepseek-v4-pro')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    await act(async () => { await userEvent.keyboard('{Escape}') })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('deepseek-v4-pro')
    expect(document.activeElement).toBe(input)
    await expect.element(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible()
  })

  it('links the model name to a status line between the input and the list that also reads out empty results', async () => {
    const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const status = () => document.getElementById(modelNameInput().getAttribute('aria-describedby') ?? '')
    expect(status()?.getAttribute('role')).toBe('status')
    expect(status()?.textContent).toBe('候选为推荐模型。点刷新按钮可获取本机已安装的模型。')

    await openSuggestions()
    const listbox = document.querySelector('[role="listbox"]')!
    expect(status()!.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await typeInto(modelNameInput(), 'my-private-model')
    expect(status()?.textContent).toContain('没有匹配的候选，将使用输入的名称。')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('false')
    expect(modelNameInput().hasAttribute('aria-controls')).toBe(false)
  })

  it('does not claim there are no suggestions while the endpoint list is still loading', async () => {
    const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(() => {}))
    await renderSettings(savedProfile(), discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    const status = document.getElementById(modelNameInput().getAttribute('aria-describedby') ?? '')?.textContent
    expect(status).toBe('正在获取端点模型列表…')
  })

  it('reads out that a provider without presets has no suggestions yet', async () => {
    await renderSettings(savedProfile({ apiKey: '' }), vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    expect(suggestionOptions()).toHaveLength(0)
    expect(document.getElementById(modelNameInput().getAttribute('aria-describedby') ?? '')?.textContent)
      .toContain('暂无候选模型，可直接输入模型名称。')
  })

  it('marks only the current model with a check', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-pro', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    const checked = suggestionOptions().filter(option => option.querySelector('svg[aria-hidden="true"]'))
    expect(checked.map(option => option.querySelector('span')?.textContent)).toEqual(['deepseek-v4-pro'])
    expect(checked[0].getAttribute('aria-selected')).toBe('true')
  })

  it('does not tell a user without a key to press refresh', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe('候选为推荐模型。填写 API Key 后展开会自动获取端点模型列表。')
  })

  it('ignores clicks on suggestions while a refresh is about to replace them', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    let settle!: (result: ModelDiscoveryResult) => void
    const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { settle = resolve }))
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    expect(suggestionOptions().every(option => option.getAttribute('aria-disabled') === 'true')).toBe(true)
    await chooseSuggestion('deepseek-v4-pro')
    expect(modelNameInput().value).toBe('deepseek-v4-flash')

    await act(async () => settle({ success: true, models: [
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', value: 'deepseek-v4-flash' },
      { id: 'endpoint-only', name: 'endpoint-only', value: 'endpoint-only' },
    ] }))
    await chooseSuggestion('endpoint-only')
    expect(modelNameInput().value).toBe('endpoint-only')
  })

  it('drops the fetched list after switching provider and fetches again for the new provider', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    const discoverModels = vi.fn<(request: { provider: string }) => Promise<ModelDiscoveryResult>>(async () => ({
      success: true, models: [{ id: 'deepseek-only', name: 'deepseek-only', value: 'deepseek-only' }],
    }))
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-only']))

    const providerSelect = Array.from(document.querySelectorAll('select')).find(select => select.value === 'deepseek')
    if (!providerSelect) throw new Error('Missing provider select')
    let settle!: () => void
    discoverModels.mockImplementationOnce(() => new Promise(resolve => {
      settle = () => resolve({ success: true, models: [{ id: 'models/gemini-3.8-flash', name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' }] })
    }))
    await typeInto(providerSelect, 'gemini')
    await openSuggestions()
    expect(suggestionValues()).not.toContain('deepseek-only')
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2))
    expect(discoverModels.mock.calls[1][0]).toMatchObject({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' })
    await act(async () => settle())
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['gemini-3.8-flash']))
  })
})
