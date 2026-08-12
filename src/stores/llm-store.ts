import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { requireIpcSuccess } from '../services/ipc-result'
import { alertError } from '../components/ui/AlertDialog'
import type { LLMFinishReason, ModelProfile, LLMResponse, TokenUsage } from '../shared/ipc-channels'
import { projectSessionContextFromProject } from '../shared/project-session-context'
import { useProjectStore } from './project-store'

/** 流式生成的回调 */
interface StreamCallbacks {
  onChunk?: (chunk: string) => void
  onDone?: (fullText: string, usage: TokenUsage | undefined, finishReason: LLMFinishReason) => void
  onError?: (error: string) => void
}

interface LLMState {
  /** 已配置的模型列表 */
  models: ModelProfile[]
  /** 当前默认生成模型 ID */
  defaultModelId: string | null
  /** 当前默认向量模型 ID */
  defaultEmbeddingModelId: string | null
  /** 正在进行的活跃请求 */
  activeRequests: Map<string, { status: 'running' | 'done' | 'error'; text: string }>
  /** 是否已加载模型配置 */
  loaded: boolean

  // ===== Actions =====
  /** 初始化（加载模型列表 + 默认模型 ID） */
  init: () => Promise<void>
  /** 加载模型列表 */
  loadModels: () => Promise<void>
  /** 保存模型 */
  saveModel: (model: ModelProfile) => Promise<boolean>
  /** 删除模型 */
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => Promise<boolean>
  /** 设置默认向量模型（持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string) => Promise<boolean>
  /** 非流式生成 */
  generate: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    modelId?: string,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string; projectSession?: import('../shared/ipc-channels').ProjectSessionContext; modelExecutionLeaseId?: string }
  ) => Promise<LLMResponse>
  /** 流式生成 */
  generateStream: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string; projectSession?: import('../shared/ipc-channels').ProjectSessionContext; modelExecutionLeaseId?: string }
  ) => Promise<string>
  /** 取消生成 */
  cancelGeneration: (requestId: string) => Promise<void>
  /** 测试模型连接 */
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
}

let initializationFlight: Promise<void> | null = null

export const useLLMStore = create<LLMState>()((set, get) => ({
  models: [],
  defaultModelId: null,
  defaultEmbeddingModelId: null,
  activeRequests: new Map(),
  loaded: false,

  init: () => {
    if (get().loaded) return Promise.resolve()
    if (initializationFlight) return initializationFlight

    const flight = (async () => {
      if (!ipc.isElectron) {
        set({ loaded: true })
        return
      }
      const [models, defaultModelId, defaultEmbeddingModelId] = await Promise.all([
        ipc.invoke('llm:list-models'),
        ipc.invoke('llm:get-default-model'),
        ipc.invoke('llm:get-default-embedding-model'),
      ])
      set({
        models,
        defaultModelId,
        defaultEmbeddingModelId,
        loaded: true,
      })
    })().finally(() => {
      if (initializationFlight === flight) initializationFlight = null
    })
    initializationFlight = flight
    return flight
  },

  loadModels: async () => {
    if (!ipc.isElectron) return
    const models = await ipc.invoke('llm:list-models')
    set({ models })
  },

  saveModel: async (model) => {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await get().loadModels()
    } else {
      alertError('保存模型失败', { title: '模型设置保存失败' })
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (!result.success) {
      alertError(result.error || '删除模型失败', { title: '模型删除失败' })
      return false
    }
    await get().loadModels()
    set({
      defaultModelId: result.defaultModelId ?? null,
      defaultEmbeddingModelId: result.defaultEmbeddingModelId ?? null,
    })
    return true
  },

  setDefaultModel: async (modelId) => {
    try {
      requireIpcSuccess(await ipc.invoke('llm:set-default-model', modelId), '保存默认模型')
      set({ defaultModelId: modelId })
      return true
    } catch (error) {
      alertError(String(error), { title: '模型设置保存失败' })
      return false
    }
  },

  setDefaultEmbeddingModel: async (modelId) => {
    try {
      requireIpcSuccess(
        await ipc.invoke('llm:set-default-embedding-model', modelId),
        '保存默认向量模型',
      )
      set({ defaultEmbeddingModelId: modelId })
      return true
    } catch (error) {
      alertError(String(error), { title: '模型设置保存失败' })
      return false
    }
  },

  generate: async (messages, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) return { success: false, content: '', finishReason: 'error', error: '未配置默认模型' }
    const projectSession = options?.projectSession
      ?? projectSessionContextFromProject(useProjectStore.getState().currentProject)
      ?? undefined
    const response = await ipc.invoke('llm:generate', {
      modelId: mid,
      purpose: options?.purpose ?? 'generation',
      projectSession,
      modelExecutionLeaseId: options?.modelExecutionLeaseId,
      messages,
      responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
      thinking: options?.thinking,
      maxTokens: options?.maxTokens,
    })
    return requireIpcSuccess(response, '模型生成')
  },

  generateStream: async (messages, callbacks, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) {
      callbacks.onError?.('未配置默认模型')
      return ''
    }

    const requestId = crypto.randomUUID()
    const projectSession = options?.projectSession
      ?? projectSessionContextFromProject(useProjectStore.getState().currentProject)
      ?? undefined

    // 注册流式事件监听
    const unsubChunk = ipc.on('llm:stream-chunk', (data) => {
      if (data.requestId === requestId) {
        callbacks.onChunk?.(data.chunk)
      }
    })

    const unsubDone = ipc.on('llm:stream-done', (data) => {
      if (data.requestId === requestId) {
        callbacks.onDone?.(data.fullText, data.usage, data.finishReason ?? 'unknown')
        cleanup()
      }
    })

    const unsubError = ipc.on('llm:stream-error', (data) => {
      if (data.requestId === requestId) {
        callbacks.onError?.(data.error)
        cleanup()
      }
    })

    const cleanup = () => {
      unsubChunk()
      unsubDone()
      unsubError()
      const reqs = new Map(get().activeRequests)
      reqs.delete(requestId)
      set({ activeRequests: reqs })
    }

    // 标记活跃请求
    const reqs = new Map(get().activeRequests)
    reqs.set(requestId, { status: 'running', text: '' })
    set({ activeRequests: reqs })

    // 发起流式请求
    let started: { requestId: string; started: boolean; error?: string }
    try {
      started = await ipc.invoke('llm:generate-stream', requestId, {
        modelId: mid,
        purpose: options?.purpose ?? 'generation',
        projectSession,
        modelExecutionLeaseId: options?.modelExecutionLeaseId,
        messages,
        stream: true,
        responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
        thinking: options?.thinking,
        maxTokens: options?.maxTokens,
      })
    } catch (error) {
      cleanup()
      callbacks.onError?.(String(error))
      throw error
    }
    if (!started.started) {
      cleanup()
      const startError = started.error || '模型流式生成未能启动'
      callbacks.onError?.(startError)
      throw new Error(startError)
    }

    return requestId
  },

  cancelGeneration: async (requestId) => {
    await ipc.invoke('llm:cancel', requestId)
  },

  testConnection: async (model) => {
    return ipc.invoke('llm:test-connection', model)
  },
}))
