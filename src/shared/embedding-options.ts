export interface EmbeddingOptions {
  /** 每个向量块最多包含的字符数。 */
  chunkSize: number
  /** 相邻向量块之间保留的重叠字符数。 */
  chunkOverlap: number
  /** 单次发送到 Embedding API 的文本块数量。 */
  batchSize: number
}

export const DEFAULT_EMBEDDING_OPTIONS: EmbeddingOptions = {
  chunkSize: 500,
  chunkOverlap: 50,
  batchSize: 50,
}

/** 适合低显存本地 OpenAI 兼容 Embedding 服务的保守起点。 */
export const LOW_VRAM_EMBEDDING_OPTIONS: EmbeddingOptions = {
  chunkSize: 300,
  chunkOverlap: 30,
  batchSize: 4,
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** 将历史配置和手动编辑收敛为 API 可安全执行的范围。 */
export function normalizeEmbeddingOptions(options?: Partial<EmbeddingOptions> | null): EmbeddingOptions {
  const chunkSize = Math.min(4000, Math.max(100, readInteger(options?.chunkSize, DEFAULT_EMBEDDING_OPTIONS.chunkSize)))
  const chunkOverlap = Math.min(chunkSize - 1, Math.max(0, readInteger(options?.chunkOverlap, DEFAULT_EMBEDDING_OPTIONS.chunkOverlap)))
  const batchSize = Math.min(50, Math.max(1, readInteger(options?.batchSize, DEFAULT_EMBEDDING_OPTIONS.batchSize)))

  return { chunkSize, chunkOverlap, batchSize }
}
