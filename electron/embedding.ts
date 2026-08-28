/**
 * Vela 嵌入服务 — 主进程使用
 *
 * 提供文本向量化能力（调用远程 Embedding API）
 * 支持 OpenAI 和 Gemini 两种 Embedding API
 *
 * 注意：向量存储和检索能力已迁移至 vector-store.ts (LanceDB)
 * 本模块仅保留 Embedding API 调用和文本分块功能
 */

import { normalizeEmbeddingOptions } from '../src/shared/embedding-options'
import { EmbeddingResponseValidationError } from './services/embedding-response-error'

const RELEASE_SMOKE_BASE_URL_PREFIX = 'vela-release-smoke://'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function invalidEmbeddingResponse(provider: 'OpenAI' | 'Gemini', details: string): never {
  throw new EmbeddingResponseValidationError(provider, details)
}

async function parseEmbeddingJsonResponse(
  provider: 'OpenAI' | 'Gemini',
  res: Response,
): Promise<unknown> {
  try {
    return await res.json() as unknown
  } catch {
    invalidEmbeddingResponse(
      provider,
      `服务端返回非 JSON 响应（HTTP ${res.status}；响应体无法解析为 JSON）。请检查 Base URL、网关或鉴权页。`,
    )
  }
}

function embeddingHttpError(provider: 'OpenAI' | 'Gemini', status: number): never {
  throw new Error(
    `${provider} Embedding 调用失败（HTTP ${status}）。请检查 Base URL、网关或鉴权。`,
  )
}

function validateEmbeddingVectors(
  provider: 'OpenAI' | 'Gemini',
  vectors: readonly unknown[],
): number[][] {
  let expectedDimension: number | undefined
  const validated: number[][] = []

  for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
    const vector = vectors[vectorIndex]
    if (!Array.isArray(vector) || vector.length === 0) {
      invalidEmbeddingResponse(provider, `第 ${vectorIndex + 1} 个向量为空或不是数组`)
    }
    if (expectedDimension === undefined) {
      expectedDimension = vector.length
    } else if (vector.length !== expectedDimension) {
      invalidEmbeddingResponse(
        provider,
        `第 ${vectorIndex + 1} 个向量为 ${vector.length} 维，期望 ${expectedDimension} 维`,
      )
    }

    const values: number[] = []
    for (let valueIndex = 0; valueIndex < vector.length; valueIndex += 1) {
      const value = vector[valueIndex]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalidEmbeddingResponse(
          provider,
          `第 ${vectorIndex + 1} 个向量的第 ${valueIndex + 1} 个值不是有限数字（收到 ${String(value)}）`,
        )
      }
      values.push(value)
    }
    validated.push(values)
  }

  return validated
}

function validateOpenAIEmbeddings(data: unknown, batchLength: number): number[][] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    invalidEmbeddingResponse('OpenAI', 'data 不是数组')
  }

  const responseItems = data.data
  const errors: string[] = []
  if (responseItems.length !== batchLength) {
    errors.push(`数量 ${responseItems.length}，期望 ${batchLength}`)
  }

  const seenIndexes = new Set<number>()
  const embeddingsByIndex: Array<number[] | undefined> = Array.from({ length: batchLength })
  for (const item of responseItems) {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      errors.push('data 项缺少 embedding 数组')
      continue
    }

    const rawIndex = item.index
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex)) {
      errors.push(`index ${String(rawIndex)} 不是整数`)
      continue
    }
    const index = rawIndex
    if (index < 0 || index >= batchLength) {
      errors.push(`index ${index} 超出范围 0..${Math.max(batchLength - 1, 0)}`)
      continue
    }
    if (seenIndexes.has(index)) {
      errors.push(`index ${index} 重复`)
      continue
    }

    seenIndexes.add(index)
    embeddingsByIndex[index] = item.embedding as number[]
  }

  const missingIndexes = Array.from({ length: batchLength }, (_value, index) => index)
    .filter(index => !seenIndexes.has(index))
  if (missingIndexes.length > 0) {
    errors.push(`index 覆盖不完整，缺少 ${missingIndexes.join(', ')}`)
  }
  if (errors.length > 0) {
    invalidEmbeddingResponse('OpenAI', errors.join('；'))
  }

  return validateEmbeddingVectors('OpenAI', embeddingsByIndex)
}

function validateGeminiEmbeddings(data: unknown, batchLength: number): number[][] {
  if (!isRecord(data) || !Array.isArray(data.embeddings)) {
    invalidEmbeddingResponse('Gemini', 'embeddings 不是数组')
  }

  const responseItems = data.embeddings
  const errors: string[] = []
  if (responseItems.length !== batchLength) {
    errors.push(`数量 ${responseItems.length}，期望 ${batchLength}`)
  }

  const embeddings: number[][] = []
  for (const item of responseItems) {
    if (!isRecord(item) || !Array.isArray(item.values)) {
      errors.push('embeddings 项缺少 values 数组')
      continue
    }
    embeddings.push(item.values as number[])
  }
  if (errors.length > 0) {
    invalidEmbeddingResponse('Gemini', errors.join('；'))
  }

  return validateEmbeddingVectors('Gemini', embeddings)
}

/**
 * This is deliberately not a user-selectable embedding provider. It exists
 * solely for the installed-package qualification process, which requires both
 * a launch-time environment gate and a matching one-time token in the model.
 */
function releaseSmokeEmbeddings(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string; releaseSmokeDimension?: 768 | 1536 },
): number[][] | undefined {
  const token = process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN
  const commandArgument = token ? `--ai-novel-release-smoke=${token}` : ''
  const dimension = model.releaseSmokeDimension ?? Number(/^release-smoke-(768|1536)$/.exec(model.modelName ?? '')?.[1])
  if (
    process.env.AI_NOVEL_RELEASE_SMOKE !== '1'
    || !token
    || !/^[a-f0-9]{32,128}$/i.test(token)
    || process.argv.filter(argument => argument === commandArgument).length !== 1
    || model.apiKey !== token
    || model.baseUrl !== `${RELEASE_SMOKE_BASE_URL_PREFIX}${token}`
    || (dimension !== 768 && dimension !== 1536)
  ) {
    return undefined
  }

  const size = dimension
  return texts.map((text) => {
    let state = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      state = Math.imul(state ^ text.charCodeAt(index), 16777619) >>> 0
    }
    return Array.from({ length: size }, (_value, index) => {
      state = Math.imul(state ^ (index + 1), 16777619) >>> 0
      return (state / 0xffffffff) * 2 - 1
    })
  })
}

// ===== Embedding API 调用 =====

const KNOWN_OPENAI_COMPATIBLE_ROOTS = new Set([
  'https://api.openai.com',
  'https://api.deepseek.com',
  'http://localhost:11434',
  'http://127.0.0.1:11434',
])

const OLLAMA_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

function ollamaOpenAIEmbeddingBaseUrl(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    if (
      parsed.protocol !== 'http:'
      || parsed.port !== '11434'
      || !OLLAMA_LOCAL_HOSTS.has(parsed.hostname.toLowerCase())
      || pathname !== '/api'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return undefined
    }
    return `${parsed.protocol}//${parsed.host}/v1`
  } catch {
    return undefined
  }
}

function buildOpenAIEmbeddingUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/embeddings')) {
    return base
  }
  if (/\/v\d+(?:[a-z0-9.-]*)$/i.test(base)) {
    return `${base}/embeddings`
  }
  if (KNOWN_OPENAI_COMPATIBLE_ROOTS.has(base.toLowerCase())) {
    return `${base}/v1/embeddings`
  }
  // A user-provided /api path is not an inferred OpenAI-compatible root.
  return `${base}/embeddings`
}

/** OpenAI Embedding API */
export async function embedOpenAI(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
): Promise<number[][]> {
  const ollamaCompatibleBaseUrl = ollamaOpenAIEmbeddingBaseUrl(model.baseUrl)
  if (ollamaCompatibleBaseUrl) {
    throw new Error(
      'Ollama 原生 /api 地址不兼容：'
      + `本应用使用 OpenAI-compatible Embedding API，请将 Base URL 改为 ${ollamaCompatibleBaseUrl}。 `
      + `This app uses the OpenAI-compatible Embedding API; change the Base URL to ${ollamaCompatibleBaseUrl}.`,
    )
  }
  const embeddingModel = model.modelName || 'text-embedding-3-small'
  const url = buildOpenAIEmbeddingUrl(model.baseUrl)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
    }),
  })

  if (!res.ok) {
    embeddingHttpError('OpenAI', res.status)
  }

  const data = await parseEmbeddingJsonResponse('OpenAI', res)
  return validateOpenAIEmbeddings(data, texts.length)
}

/** Gemini Embedding API */
export async function embedGemini(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
): Promise<number[][]> {
  const embeddingModel = model.modelName || 'text-embedding-004'
  const baseUrl = model.baseUrl.replace(/\/$/, '')

  // Gemini batchEmbedContents 支持批量
  const url = `${baseUrl}/v1beta/models/${embeddingModel}:batchEmbedContents`
  const requests = texts.map((text) => ({
    model: `models/${embeddingModel}`,
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
  }))

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': model.apiKey,
    },
    body: JSON.stringify({ requests }),
  })

  if (!res.ok) {
    embeddingHttpError('Gemini', res.status)
  }

  const data = await parseEmbeddingJsonResponse('Gemini', res)
  return validateGeminiEmbeddings(data, texts.length)
}

/** 统一的 Embedding 调用接口 */
export async function generateEmbeddings(
  texts: string[],
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string },
  configuredBatchSize?: number,
  assertActive?: () => void,
): Promise<number[][]> {
  // 空文本处理
  if (texts.length === 0) return []
  const smokeEmbeddings = releaseSmokeEmbeddings(texts, model)
  if (smokeEmbeddings) return smokeEmbeddings

  // 批量限制：每次最多 50 条
  // 旧配置未提供 batchSize 时保持原有协议默认值，避免升级后意外改变云端调用。
  const batchSize = configuredBatchSize === undefined
    ? (protocol === 'gemini' ? 100 : 50)
    : normalizeEmbeddingOptions({ batchSize: configuredBatchSize }).batchSize
  const results: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    assertActive?.()
    const batch = texts.slice(i, i + batchSize)
    const embeddings = protocol === 'gemini'
      ? await embedGemini(batch, model)
      : await embedOpenAI(batch, model)
    assertActive?.()
    results.push(...embeddings)
  }

  return validateEmbeddingVectors(protocol === 'gemini' ? 'Gemini' : 'OpenAI', results)
}

// ===== 文本分块 =====

/** 将文本按段落分块，每块约 maxChars 字符 */
export function chunkText(
  text: string,
  maxChars: number = 500,
  overlap: number = 50,
): string[] {
  // 先按段落分割
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  const chunks: string[] = []
  const pushWithinLimit = (value: string) => {
    const normalized = value.trim()
    if (!normalized) return
    if (normalized.length <= maxChars) {
      chunks.push(normalized)
      return
    }

    // 单句可能远超分块上限；强制切分，防止本地模型仍收到超长输入。
    let start = 0
    while (start < normalized.length) {
      const end = Math.min(start + maxChars, normalized.length)
      chunks.push(normalized.slice(start, end))
      if (end === normalized.length) break
      start = Math.max(start + 1, end - overlap)
    }
  }
  let currentChunk = ''

  for (const para of paragraphs) {
    // 如果段落本身就超过 maxChars，按句号分割
    if (para.length > maxChars) {
      if (currentChunk) {
        pushWithinLimit(currentChunk)
        currentChunk = ''
      }
      // 按句号分割长段落
      const sentences = para.split(/(?<=[。！？.!?])\s*/)
      let sentenceChunk = ''
      for (const sentence of sentences) {
        if (sentenceChunk.length + sentence.length > maxChars && sentenceChunk.length > 0) {
          pushWithinLimit(sentenceChunk)
          // 保留 overlap
          sentenceChunk = sentenceChunk.slice(-overlap) + sentence
        } else {
          sentenceChunk += sentence
        }
      }
      if (sentenceChunk.trim()) {
        currentChunk = sentenceChunk
      }
      continue
    }

    // 累积段落
    if (currentChunk.length + para.length > maxChars && currentChunk.length > 0) {
      pushWithinLimit(currentChunk)
      // 保留 overlap
      currentChunk = currentChunk.slice(-overlap) + '\n\n' + para
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para
    }
  }

  if (currentChunk.trim()) {
    pushWithinLimit(currentChunk)
  }

  return chunks.length > 0 ? chunks : [text.trim()]
}
