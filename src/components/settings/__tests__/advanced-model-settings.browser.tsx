import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { Locale } from '../../../i18n/types'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import SettingsModal from '../SettingsModal'

const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function model(): ModelProfile {
  return {
    id: 'advanced-grok',
    name: 'Advanced Grok',
    provider: 'xai',
    protocol: 'openai',
    modelName: 'grok-4.5',
    apiKey: 'browser-fixture-credential',
    baseUrl: 'https://api.x.ai/v1',
    temperature: 0.35,
    maxTokens: 6000,
    capabilities: {
      contextWindowTokens: 500_000,
      maxOutputTokens: 6000,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    },
    reasoningOverride: 'max',
    purposes: ['generation'],
  }
}

async function renderSettings(locale: Locale = 'zh-CN') {
  const saveModel = vi.fn(async (profile: ModelProfile) => {
    useLLMStore.setState(state => ({
      models: state.models.map(candidate => candidate.id === profile.id ? profile : candidate),
    }))
    return true
  })
  useLocaleStore.setState({ locale })
  useLayoutStore.setState({ settingsSection: 'llm' })
  useLLMStore.setState({
    models: [model()],
    loaded: true,
    defaultModelId: model().id,
    saveModel,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'advanced-project',
      name: 'Advanced project',
      path: 'C:\\novels\\advanced-project',
      sessionLease: 'advanced-project-lease',
      novelConfig: { creativeStrategy: 'deep-planning' },
    } as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<SettingsModal open onClose={() => {}} />))
  return { saveModel }
}

async function clickEdit(label = '编辑') {
  await act(async () => page.getByRole('button', { name: label, exact: true }).click())
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  vi.restoreAllMocks()
})

describe('advanced model settings', () => {
  it('edits, persists, reopens, and restores model-scoped defaults without changing project strategy', async () => {
    const { saveModel } = await renderSettings()
    await clickEdit()

    expect(document.querySelector('[aria-label="温度"]')).toBeNull()
    expect(document.querySelector('[aria-label="最大输出 Token"]')).toBeNull()
    await act(async () => page.getByRole('button', { name: '高级设置', exact: true }).click())

    const temperature = page.getByLabelText('温度')
    const maxOutputTokens = page.getByLabelText('最大输出 Token')
    await expect.element(temperature).toHaveValue(0.35)
    await expect.element(maxOutputTokens).toHaveValue(6000)
    expect(document.querySelector('[data-reasoning-status="capped"]')?.textContent).toContain('最高 → 高')

    await act(async () => {
      await temperature.fill('0.9')
      await maxOutputTokens.fill('7000')
      await page.getByLabelText('模型推理覆盖').selectOptions('low')
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledTimes(1))
    expect(useProjectStore.getState().currentProject?.novelConfig.creativeStrategy).toBe('deep-planning')

    await clickEdit()
    await act(async () => page.getByRole('button', { name: '高级设置', exact: true }).click())
    await expect.element(page.getByLabelText('温度')).toHaveValue(0.9)
    await expect.element(page.getByLabelText('最大输出 Token')).toHaveValue(7000)
    await expect.element(page.getByLabelText('模型推理覆盖')).toHaveValue('low')

    await act(async () => page.getByRole('button', { name: '恢复默认值', exact: true }).click())
    await expect.element(page.getByLabelText('温度')).toHaveValue(0.7)
    await expect.element(page.getByLabelText('最大输出 Token')).toHaveValue(8192)
    await expect.element(page.getByLabelText('模型推理覆盖')).toHaveValue('auto')
    await act(async () => page.getByRole('button', { name: '保存配置', exact: true }).click())

    await clickEdit()
    await act(async () => page.getByRole('button', { name: '高级设置', exact: true }).click())
    await expect.element(page.getByLabelText('温度')).toHaveValue(0.7)
    await expect.element(page.getByLabelText('最大输出 Token')).toHaveValue(8192)
    await expect.element(page.getByLabelText('模型推理覆盖')).toHaveValue('auto')
  })

  it('exposes the advanced entry and effective reasoning state in English', async () => {
    await renderSettings('en-US')
    await clickEdit('Edit')
    await expect.element(page.getByRole('button', { name: 'Advanced settings', exact: true })).toBeVisible()
    expect(document.querySelector('[aria-label="Temperature"]')).toBeNull()
    await act(async () => page.getByRole('button', { name: 'Advanced settings', exact: true }).click())
    await expect.element(page.getByLabelText('Temperature')).toBeVisible()
    await expect.element(page.getByLabelText('Max output tokens')).toBeVisible()
    await expect.element(page.getByLabelText('Model reasoning override')).toBeVisible()
    await expect.element(page.getByLabelText('Effective reasoning effort')).toBeVisible()
  })

  it('warns when the configured output consumes the context window without blocking save', async () => {
    const { saveModel } = await renderSettings('en-US')
    await clickEdit('Edit')
    await act(async () => {
      await page.getByLabelText('Context Window').fill('8192')
      await page.getByRole('button', { name: 'Advanced settings', exact: true }).click()
      await page.getByLabelText('Max output tokens').fill('8192')
    })

    await expect.element(page.getByRole('status')).toHaveTextContent(
      'Max output tokens leave no safe room for the prompt',
    )

    await act(async () => page.getByRole('button', { name: 'Save configuration', exact: true }).click())
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledTimes(1))
  })
})
