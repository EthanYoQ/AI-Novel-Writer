import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { Locale } from '../../../i18n/types'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { ModelForm } from '../ModelForm'

const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

const model: ModelProfile = {
  id: 'form-model',
  name: 'Form model',
  provider: 'openai',
  protocol: 'openai',
  modelName: 'gpt-test',
  apiKey: 'browser-fixture-credential',
  baseUrl: 'http://127.0.0.1:9/v1',
  temperature: 0.7,
  maxTokens: 4000,
  purposes: ['generation'],
}

async function renderFailedTest(locale: Locale, error: string) {
  useLocaleStore.setState({ locale })
  useLLMStore.setState({ testConnection: vi.fn(async () => ({ success: false, error })) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(
    <ModelForm
      model={model}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      saving={false}
      purposeOptions={['generation']}
      presets={BUILTIN_PRESETS}
    />,
  ))
  await act(async () => page.getByRole('button', { name: locale === 'en-US' ? 'Test connection' : '测试连接' }).click())
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLLMStore.setState(originalLLMState, true)
  useLocaleStore.setState(originalLocaleState, true)
})

describe('model connection test result (#484)', () => {
  it.each([
    ['zh-CN', '连接失败：模型的最大输出 Tokens 无效。请在设置里为这个模型填一个正整数后重试。'],
    ['en-US', 'Connection failed: The model’s max output tokens setting is invalid. Enter a positive whole number for this model in Settings, then try again.'],
  ] as const)('explains a registered failure code in %s instead of showing the bare code', async (locale, expected) => {
    await renderFailedTest(locale, 'MODEL_OUTPUT_LIMIT_INVALID')

    await expect.element(page.getByText(expected, { exact: true })).toBeVisible()
    expect(container?.textContent).not.toContain('MODEL_OUTPUT_LIMIT_INVALID')
  })

  it('keeps Chinese provider text out of the English result', async () => {
    await renderFailedTest('en-US', '模型请求失败（HTTP 401）。')

    await expect.element(page.getByText('Connection failed', { exact: true })).toBeVisible()
    expect(container?.textContent).not.toMatch(/\p{Script=Han}/u)
  })
})
