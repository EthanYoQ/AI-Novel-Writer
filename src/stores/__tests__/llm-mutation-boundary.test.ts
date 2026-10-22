import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    get isElectron() { return true },
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

import { useLLMStore } from '../llm-store'
import { useLocaleStore } from '../locale-store'

const originalLocale = useLocaleStore.getState().locale

beforeEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState({
    models: [],
    defaultModelId: 'old-model',
    defaultEmbeddingModelId: 'old-embedding',
    activeRequests: new Map(),
    loaded: true,
  })
})

describe('LLM settings mutation boundaries', () => {
  it('keeps the previous default model when persistence fails', async () => {
    mocks.invoke.mockResolvedValue({ success: false, error: 'disk full' })

    await expect(useLLMStore.getState().setDefaultModel('new-model')).resolves.toBe(false)

    expect(useLLMStore.getState().defaultModelId).toBe('old-model')
    expect(mocks.alertError).toHaveBeenCalled()
  })

  it('publishes the default embedding model only after persistence succeeds', async () => {
    mocks.invoke.mockResolvedValue({ success: true })

    await expect(useLLMStore.getState().setDefaultEmbeddingModel('new-embedding')).resolves.toBe(true)

    expect(useLLMStore.getState().defaultEmbeddingModelId).toBe('new-embedding')
  })

  it('uses the atomic delete result without issuing separate default-model writes', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'llm:delete-model') {
        return {
          success: true,
          defaultModelId: null,
          defaultEmbeddingModelId: 'old-embedding',
        }
      }
      if (channel === 'llm:list-models') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useLLMStore.getState().deleteModel('old-model')).resolves.toBe(true)

    expect(useLLMStore.getState()).toMatchObject({
      models: [],
      defaultModelId: null,
      defaultEmbeddingModelId: 'old-embedding',
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith('llm:set-default-model', null)
    expect(mocks.invoke).not.toHaveBeenCalledWith('llm:set-default-embedding-model', null)
  })
})

describe('模型设置失败时给作者看的说明', () => {
  afterEach(() => { useLocaleStore.setState({ locale: originalLocale }) })

  it.each([
    ['zh-CN', '项目已切换或重新打开', '模型删除失败', '删除模型失败'],
    ['en-US', 'The project was switched or reopened', 'Could not delete the model', 'Could not delete the model.'],
  ] as const)('%s 界面：删除模型被会话守卫拒绝时显示登记的说明，未登记的原文保留，没有原因时用兜底', async (locale, stale, title, fallback) => {
    useLocaleStore.setState({ locale })
    for (const [error, shown] of [
      ['PROJECT_SESSION_STALE', expect.stringContaining(stale)],
      ['SOMETHING_NEW_FROM_MAIN', 'SOMETHING_NEW_FROM_MAIN'],
      [undefined, fallback],
    ] as const) {
      mocks.alertError.mockClear()
      mocks.invoke.mockResolvedValue({ success: false, error })
      await expect(useLLMStore.getState().deleteModel('old-model')).resolves.toBe(false)
      expect(mocks.alertError).toHaveBeenCalledWith(shown, { title })
    }
  })

  it('默认模型保存失败时不把错误码或 "Error: " 前缀交给作者', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    mocks.invoke.mockResolvedValue({ success: false, error: 'PROJECT_SESSION_STALE' })
    await expect(useLLMStore.getState().setDefaultModel('new-model')).resolves.toBe(false)
    const [message, options] = mocks.alertError.mock.calls[0]
    expect(message).toMatch(/^The project was switched or reopened/u)
    expect(options).toEqual({ title: 'Model settings could not be saved' })
  })
})
