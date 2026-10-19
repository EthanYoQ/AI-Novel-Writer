import { afterEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { ModelForm } from '../ModelForm'
import { createProviderCatalog } from '../../../shared/provider-presets'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'

const originalLocale = useLocaleStore.getState()
const originalLLM = useLLMStore.getState()
let root: Root | undefined
let container: HTMLDivElement | undefined
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  useLocaleStore.setState(originalLocale)
  useLLMStore.setState(originalLLM)
})

it('connects, discovers and saves a ChatGPT subscription model without an API key', async () => {
  useLocaleStore.setState({ locale: 'en-US' })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'llm:chatgpt-status') return { success: true, connected: false, sharing: false }
    if (channel === 'llm:chatgpt-sign-in') return { success: true, connected: true, sharing: true, email: 'test@example.invalid' }
    return { success: true }
  })
  const previousAPI = window.aiNovelAPI
  window.aiNovelAPI = { ...previousAPI, invoke } as typeof window.aiNovelAPI
  const discoverModels = vi.fn().mockResolvedValue({ success: true, models: [{ id: 'account-model', value: 'account-model', name: 'Account model' }] })
  useLLMStore.setState({ discoverModels })
  const save = vi.fn()
  function Form() {
    const [model, setModel] = useState<ModelProfile>({
      id: 'new-model', name: 'ChatGPT', provider: 'openai', protocol: 'openai', modelName: '',
      apiKey: '', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
    })
    return <ModelForm model={model} onChange={setModel} onSave={() => save(model)} onCancel={() => {}}
      saving={false} purposeOptions={['generation']} presets={createProviderCatalog()} />
  }
  try {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<Form />))
    const provider = container.querySelector('select')!
    await act(async () => {
      provider.value = 'chatgpt-plan'
      provider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('input[placeholder="sk-..."]')).toBeNull()
    await act(async () => { await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click() })
    await expect.element(page.getByText('Connected to ChatGPT: test@example.invalid', { exact: true })).toBeVisible()
    await act(async () => { await page.getByRole('button', { name: 'Refresh model list', exact: true }).click() })
    expect(discoverModels).toHaveBeenCalledWith({ provider: 'chatgpt-plan', protocol: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1' })
    const picker = container.querySelector('select[aria-label="Endpoint model list"]') as HTMLSelectElement
    await act(async () => {
      picker.value = 'account-model'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await page.getByRole('button', { name: 'Save configuration', exact: true }).click() })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider: 'chatgpt-plan', modelName: 'account-model', apiKey: '' }))
    await act(async () => { await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click() })
    expect(invoke).toHaveBeenCalledWith('llm:chatgpt-disconnect')
  } finally { window.aiNovelAPI = previousAPI }
})
