import { ipcMain, BrowserWindow } from 'electron'
import {
  readJsonFile,
  tryReadJsonFile,
  writeJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import type { LLMFinishReason, LLMRequest, ModelProfile, GlobalConfig, TokenUsage } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { LLMFactory } from '../llm/llm-factory'
import { resolveGenerationParameters } from '../llm/generation-parameter-policy'
import { getCurrentProjectPath } from '../database'
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { projectAccess } from '../services/project-access'
import {
  ModelExecutionLeaseError,
  ModelExecutionLeaseRegistry,
} from '../services/model-execution-lease'

interface ActiveStream {
  controller: AbortController
  recordCancelled: () => void
}

const activeStreams = new Map<string, ActiveStream>()
const CONNECTION_TEST_MAX_TOKENS = 1024
const CLOSED_EXECUTION_LEASE_TOMBSTONE_TTL_MS = 5 * 60_000

function loadModelConfigs(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, models)
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
}

function applyProxyConfig() {
  try {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    if (config.proxy?.enabled && config.proxy.host) {
      const proxyUrl = config.proxy.type === 'socks5'
        ? `socks5://${config.proxy.host}:${config.proxy.port}`
        : `http://${config.proxy.host}:${config.proxy.port}`
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
    }
  } catch { /* 忽略 */ }
}

function recordProviderOutcome(
  request: LLMRequest,
  model: ModelProfile,
  startedAt: number,
  outcome: { success: boolean; usage?: TokenUsage; error?: string },
): void {
  if (!isProjectSessionContext(request.projectSession)) return
  try {
    projectAccess.assertCurrentProjectContext(request.projectSession, getCurrentProjectPath())
    LLMHistoryRepository.logCall({
      modelId: model.id,
      modelName: model.name || model.modelName,
      purpose: request.purpose?.trim() || 'generation',
      promptTokens: outcome.usage?.promptTokens ?? null,
      completionTokens: outcome.usage?.completionTokens ?? null,
      totalTokens: outcome.usage?.totalTokens ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
      success: outcome.success,
      errorMessage: outcome.error,
    })
  } catch (error) {
    // Statistics are diagnostic only and must never change generation outcome.
    console.warn('[AI Novel Writer] LLM call statistics were not recorded.', error)
  }
}

export function registerLLMController() {
  const modelExecutionLeases = new ModelExecutionLeaseRegistry({ loadModel: getModelConfig })
  const closedExecutionLeaseTombstones = new Map<string, number>()

  const pruneClosedExecutionLeaseTombstones = (now: number) => {
    for (const [leaseId, expiresAt] of closedExecutionLeaseTombstones) {
      if (expiresAt <= now) closedExecutionLeaseTombstones.delete(leaseId)
    }
  }

  ipcMain.handle('llm:begin-execution-lease', async (_event, modelId: string) => {
    try {
      return { success: true, lease: modelExecutionLeases.begin(modelId) }
    } catch (error) {
      if (error instanceof ModelExecutionLeaseError && error.code === 'MODEL_NOT_FOUND') {
        return {
          success: false,
          errorCode: 'MODEL_NOT_FOUND' as const,
          error: '指定的生成模型不存在或已被删除。',
        }
      }
      return {
        success: false,
        errorCode: 'LEASE_BEGIN_FAILED' as const,
        error: '无法创建模型执行租约。',
      }
    }
  })

  ipcMain.handle('llm:close-execution-lease', async (_event, leaseId: string) => {
    const now = Date.now()
    pruneClosedExecutionLeaseTombstones(now)
    if (modelExecutionLeases.close(leaseId)) {
      closedExecutionLeaseTombstones.set(
        leaseId,
        now + CLOSED_EXECUTION_LEASE_TOMBSTONE_TTL_MS,
      )
      return { success: true }
    }
    if (closedExecutionLeaseTombstones.has(leaseId)) return { success: true }
    return { success: false, error: '模型执行租约无效或已关闭' }
  })

  ipcMain.handle('llm:generate', async (_event, request: LLMRequest) => {
    const startedAt = Date.now()
    let model: ModelProfile | null = null
    try {
      applyProxyConfig()
      model = request.modelExecutionLeaseId
        ? modelExecutionLeases.resolve(request.modelExecutionLeaseId)
        : getModelConfig(request.modelId)
      if (!model) return { success: false, content: '', finishReason: 'error', error: '未找到模型配置' }

      const provider = LLMFactory.getProvider(model)
      const result = await provider.generate(
        model,
        request.messages,
        resolveGenerationParameters(model, request),
      )
      recordProviderOutcome(request, model, startedAt, result)
      return result
    } catch (error) {
      if (model) recordProviderOutcome(request, model, startedAt, { success: false, error: String(error) })
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  })

  ipcMain.handle('llm:generate-stream', async (event, requestId: string, request: LLMRequest) => {
    applyProxyConfig()
    let model: ModelProfile | null
    try {
      model = request.modelExecutionLeaseId
        ? modelExecutionLeases.resolve(request.modelExecutionLeaseId)
        : getModelConfig(request.modelId)
    } catch (error) {
      return { requestId, started: false, error: String(error) }
    }
    if (!model) return { requestId, started: false }
    const generationParameters = resolveGenerationParameters(model, request)

    const abortController = new AbortController()
    const startedAt = Date.now()
    let recorded = false
    const recordOnce = (outcome: { success: boolean; usage?: TokenUsage; error?: string }) => {
      if (recorded) return
      recorded = true
      recordProviderOutcome(request, model, startedAt, outcome)
    }
    activeStreams.set(requestId, {
      controller: abortController,
      recordCancelled: () => recordOnce({ success: false, error: 'cancelled' }),
    })
    const win = BrowserWindow.fromWebContents(event.sender)

    const provider = LLMFactory.getProvider(model)
    
    // We do not await this globally since it's streaming independently
    provider.generateStream(model, request.messages, {
      ...generationParameters,
      signal: abortController.signal,
      onChunk: (chunk: string) => win?.webContents.send('llm:stream-chunk', { requestId, chunk }),
      onDone: (fullText: string, usage?: TokenUsage, finishReason?: LLMFinishReason) => {
        const terminalReason: LLMFinishReason = finishReason ?? 'unknown'
        const success = terminalReason === 'stop'
        recordOnce({ success, usage, error: success ? undefined : `finish:${terminalReason}` })
        win?.webContents.send('llm:stream-done', {
          requestId,
          fullText,
          usage,
          finishReason: terminalReason,
        })
        activeStreams.delete(requestId)
      },
      onError: (error: string) => {
        recordOnce({ success: false, error })
        win?.webContents.send('llm:stream-error', { requestId, error })
        activeStreams.delete(requestId)
      },
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const stream = activeStreams.get(requestId)
    if (stream) {
      stream.recordCancelled()
      stream.controller.abort()
      activeStreams.delete(requestId)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('llm:list-models', async () => loadModelConfigs())

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      const models = loadModelConfigs()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = model
      else models.push(model)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    let originalConfig: GlobalConfig | undefined
    let configChanged = false
    try {
      const modelsRead = tryReadJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH)
      if (modelsRead.status === 'error') throw modelsRead.error
      const originalModels = modelsRead.status === 'ok' ? modelsRead.value : []
      const configRead = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
      if (configRead.status === 'error') throw configRead.error
      originalConfig = configRead.status === 'ok'
        ? configRead.value
        : { ...DEFAULT_GLOBAL_CONFIG }

      const nextConfig = { ...originalConfig }
      if (nextConfig.defaultModelId === modelId) {
        nextConfig.defaultModelId = null
        configChanged = true
      }
      if (nextConfig.defaultEmbeddingModelId === modelId) {
        nextConfig.defaultEmbeddingModelId = null
        configChanged = true
      }

      // 先清除引用，再删除被引用对象。若第二个文件写入失败，回滚配置；
      // 即使回滚也失败，配置中只会缺少默认值，不会悬空指向已删除模型。
      if (configChanged) writeJsonFile(GLOBAL_CONFIG_PATH, nextConfig)
      try {
        saveModelConfigs(originalModels.filter(model => model.id !== modelId))
      } catch (error) {
        if (configChanged) {
          try {
            writeJsonFile(GLOBAL_CONFIG_PATH, originalConfig)
          } catch (rollbackError) {
            throw new Error(`${String(error)}；恢复默认模型配置失败：${String(rollbackError)}`)
          }
        }
        throw error
      }
      return {
        success: true,
        defaultModelId: nextConfig.defaultModelId,
        defaultEmbeddingModelId: nextConfig.defaultEmbeddingModelId ?? null,
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  ipcMain.handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  ipcMain.handle('llm:test-connection', async (
    _event,
    model: ModelProfile,
    creativeStrategy: LLMRequest['creativeStrategy'] = 'auto',
  ) => {
    try {
      applyProxyConfig()
      
      const messages = [{ role: 'user', content: 'Say "hello" and nothing else.' }]
      const provider = LLMFactory.getProvider(model)
      
      let result = { success: true, error: undefined as undefined | string }
      if (model.purposes?.includes('embedding')) {
        const { generateEmbeddings } = await import('../embedding')
        await generateEmbeddings(['hello'], model.protocol, model)
      } else {
        const res = await provider.generate(
          model,
          messages,
          resolveGenerationParameters(model, {
            // 推理模型可能先消耗 reasoning tokens；预算过小会把可用连接误判为截断失败。
            maxTokens: CONNECTION_TEST_MAX_TOKENS,
            reasoningStage: 'general',
            creativeStrategy,
          }),
        )
        result = { success: res.success, error: res.error }
      }
      
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
