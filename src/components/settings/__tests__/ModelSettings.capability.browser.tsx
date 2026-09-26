import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { ModelProfile } from '../../../shared/ipc-channels'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import ModelSettings from '../ModelSettings'

const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function model(baseUrl: string): ModelProfile {
  return {
    id: 'grok-budget-fixture',
    name: 'Grok budget fixture',
    provider: baseUrl.includes('api.x.ai') ? 'xai' : 'custom',
    protocol: 'openai',
    modelName: 'grok-4.5',
    apiKey: 'browser-fixture-only',
    baseUrl,
    temperature: 0.7,
    maxTokens: 131_072,
    capabilities: {
      contextWindowTokens: 131_072,
      maxOutputTokens: 131_072,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    },
    purposes: ['generation'],
  }
}

async function render(profile: ModelProfile, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  useLocaleStore.setState({ locale })
  useLLMStore.setState({
    models: [profile],
    loaded: true,
    defaultModelId: profile.id,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<ModelSettings />))
  const edit = container.querySelector<HTMLButtonElement>(`button[title="${locale === 'zh-CN' ? '编辑' : 'Edit'}"]`)
  expect(edit).not.toBeNull()
  await act(async () => edit?.click())
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
})

describe('ModelSettings capability evidence', () => {
  it('shows verified provider limits separately from a larger user setting', async () => {
    await render(model('https://api.x.ai/v1'))

    const evidence = container?.querySelector('[data-capability-evidence="verified-provider-preset"]')
    expect(evidence?.textContent).toContain('已验证服务商能力')
    expect(evidence?.textContent).toContain('上下文 500,000 tokens')
    expect(evidence?.textContent).toContain('最大输出 8,192 tokens')
    expect(evidence?.textContent).toContain('已验证能力、用户设置和父任务剩余额度中的较小值')
  })

  it('warns that values on an unverified endpoint are operational limits only', async () => {
    await render(model('https://proxy.example.test/v1'))

    const evidence = container?.querySelector('[data-capability-evidence="unknown"]')
    expect(evidence?.textContent).toContain('模型能力尚未验证')
    expect(evidence?.textContent).toContain('不能证明服务商支持该容量')
    expect(evidence?.textContent).toContain('发送前说明并停止')
  })

  it('renders the evidence explanation in English', async () => {
    await render(model('https://api.x.ai/v1'), 'en-US')

    const evidence = container?.querySelector('[aria-label="Model capability evidence"]')
    expect(evidence?.textContent).toContain('Verified provider capability')
    expect(evidence?.textContent).toContain('parent task remainder')
  })
})
