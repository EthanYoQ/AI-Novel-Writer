// 真实模型模式（--real-model）：应用的生成与嵌入请求发往硅基流动，凭据只发往这一个端点。
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

export const REAL_KEY_ENV = 'SILICONFLOW_API_KEY'
export const REAL_ORIGIN = 'https://api.siliconflow.cn'
const REAL_BASE_URL = `${REAL_ORIGIN}/v1`
export const REAL_GENERATION_MODEL = 'deepseek-ai/DeepSeek-V4-Flash'
export const REAL_EMBEDDING_MODEL = 'BAAI/bge-m3'

/** 与设置页新建的硅基流动模型同形：生成模型按预设的输出上限，检索模型用预设的 bge-m3 与默认切块。 */
export function realModelProfiles(apiKey) {
  const common = { provider: 'siliconflow', protocol: 'openai', baseUrl: REAL_BASE_URL, apiKey, temperature: 0.7 }
  return {
    generation: { ...common, id: 'realtest-generation', name: '真实测试生成模型', modelName: REAL_GENERATION_MODEL,
      maxTokens: 16_384, purposes: ['generation'], reasoningOverride: 'auto' },
    embedding: { ...common, id: 'realtest-embedding', name: '真实测试检索模型', modelName: REAL_EMBEDDING_MODEL,
      maxTokens: 0, purposes: ['embedding'], embeddingOptions: { chunkSize: 500, chunkOverlap: 50, batchSize: 50 } },
  }
}

/**
 * 主进程 fetch 的去向：pass 原样发出，fake 改道本机假服务，refuse 拒绝。
 * 源码会被送进 Electron 主进程重建，函数体不能引用外部变量。
 */
export function fetchRoute(href, { fakePort, realOrigin }) {
  const url = new URL(href)
  if (fakePort !== null && url.origin === `http://127.0.0.1:${fakePort}`) return 'pass'
  if (realOrigin !== null) return url.origin === realOrigin && url.pathname.startsWith('/v1/') ? 'pass' : 'refuse'
  if (fakePort !== null && url.origin === 'https://api.openai.com' && url.pathname.startsWith('/v1/')) return 'fake'
  return 'refuse'
}

/** 模型请求日志的汇总：只有路径、状态与到响应头的毫秒数，没有请求内容。 */
export function summarizeModelRequests(log) {
  const byPath = {}
  for (const entry of log) {
    const row = byPath[entry.path] ??= { count: 0, failed: 0, maxMs: 0, totalMs: 0 }
    row.count++
    if (entry.status !== 200) row.failed++
    row.maxMs = Math.max(row.maxMs, entry.ms)
    row.totalMs += entry.ms
  }
  return { count: log.length, byPath, failures: log.filter(entry => entry.status !== 200) }
}

function filesUnder(target) {
  let stat
  try { stat = fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (!stat.isDirectory()) return stat.isFile() ? [target] : []
  return fs.readdirSync(target).flatMap(name => filesUnder(path.join(target, name)))
}

/** targets（文件或目录）下逐字节含 secret 的文件。 */
export function filesContaining(targets, secret) {
  if (!secret) throw new Error('要查找的密钥为空')
  const needle = Buffer.from(secret, 'utf8')
  const files = targets.flatMap(filesUnder)
  return { scanned: files.length, hits: files.filter(file => fs.readFileSync(file).includes(needle)) }
}

/** 应用把模型档案（含明文 Key）写在数据目录（含各代 generations/<id>/）的 models.json，写入时经同目录的临时文件。 */
export function removeModelConfigs(canonical) {
  const removed = filesUnder(canonical).filter(file => {
    const name = path.basename(file)
    return name === 'models.json' || name.startsWith('.models.json.')
  })
  for (const file of removed) fs.rmSync(file, { force: true })
  return removed
}
