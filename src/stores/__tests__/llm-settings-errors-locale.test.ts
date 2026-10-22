import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Locale } from '../../i18n/types'
import { useLocaleStore } from '../locale-store'
import { useLLMStore } from '../llm-store'

const { invoke, alertError } = vi.hoisted(() => ({ invoke: vi.fn(), alertError: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke, get isElectron() { return true } },
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError }))

const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  useLocaleStore.setState({ locale: originalLocale })
})

async function shownError(locale: Locale, run: () => Promise<unknown>): Promise<string> {
  useLocaleStore.setState({ locale })
  alertError.mockClear()
  await run()
  expect(alertError).toHaveBeenCalledOnce()
  return String(alertError.mock.calls[0]![0])
}

describe('model settings refusals from the main process (#474 B6)', () => {
  it.each([
    ['setDefaultModel', 'llm:set-default-model'],
    ['setDefaultEmbeddingModel', 'llm:set-default-embedding-model'],
  ] as const)('explains a damaged settings file from %s in the interface language', async (action, channel) => {
    // llm-controller 的 catch 用 String(error) 交出 "Error: 码"。
    invoke.mockImplementation(async (called: string) => (
      called === channel ? { success: false, error: 'Error: LLM_GLOBAL_CONFIG_CORRUPT' } : undefined
    ))

    const english = await shownError('en-US', () => useLLMStore.getState()[action]('model-1'))
    expect(english).toContain('The model settings file is damaged')
    expect(english).not.toMatch(/LLM_|\p{Script=Han}/u)

    const chinese = await shownError('zh-CN', () => useLLMStore.getState()[action]('model-1'))
    expect(chinese).toContain('模型设置文件已损坏')
    expect(chinese).not.toContain('LLM_')
  })

  it.each([
    ['Error: LLM_DEFAULT_MODEL_ROLLBACK_FAILED', 'The model was not deleted', '模型没有删除'],
    ['Error: LLM_MODEL_CONFIG_CORRUPT', 'The model settings file is damaged', '模型设置文件已损坏'],
  ])('explains a refused model deletion (%s) in the interface language', async (error, english, chinese) => {
    invoke.mockImplementation(async (called: string) => (called === 'llm:delete-model' ? { success: false, error } : undefined))

    const shownEnglish = await shownError('en-US', () => useLLMStore.getState().deleteModel('model-1'))
    expect(shownEnglish).toContain(english)
    expect(shownEnglish).not.toMatch(/LLM_|\p{Script=Han}/u)

    const shownChinese = await shownError('zh-CN', () => useLLMStore.getState().deleteModel('model-1'))
    expect(shownChinese).toContain(chinese)
    expect(shownChinese).not.toContain('LLM_')
  })

  it('keeps an unregistered deletion failure as the main process reported it, without the class-name prefix', async () => {
    invoke.mockImplementation(async (called: string) => (called === 'llm:delete-model' ? { success: false, error: 'Error: EBUSY: models.json' } : undefined))
    await expect(shownError('en-US', () => useLLMStore.getState().deleteModel('model-1'))).resolves.toBe('EBUSY: models.json')
  })
})
