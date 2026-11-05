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

/**
 * 包住主进程的 fetch：按 route 的去向放行、改道或拒绝，拒绝的源记进 sink.externalRequests。
 * 真实模式不跟随重定向，遇到 3xx 记下目标源并拒绝：模型输入与凭据只发往确认过的端点。
 * 源码会被送进 Electron 主进程重建，函数体不能引用外部变量。
 */
export function guardFetch(originalFetch, route, policy, sink) {
  return async (input, options) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const decision = route(url.href, policy)
    if (decision === 'refuse') {
      sink.externalRequests.push(url.origin)
      throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
    }
    if (decision === 'fake') return originalFetch(`http://127.0.0.1:${policy.fakePort}${url.pathname}`, options)
    if (policy.realOrigin === null) return originalFetch(input, options)
    const started = Date.now()
    const record = status => sink.modelRequests.push({ path: url.pathname, status, ms: Date.now() - started })
    let response
    try {
      response = await originalFetch(input, { ...options, redirect: 'manual' })
    } catch (error) {
      record(String(error?.name ?? 'error'))
      throw error
    }
    record(response.status)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      sink.externalRequests.push(location ? new URL(location, url).origin : `${url.origin}（重定向没有 Location）`)
      throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
    }
    return response
  }
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

const reasonOf = error => error?.code ?? error?.name ?? 'error'

/** 目录下的全部文件。给了 problems 时，读不了的路径记进去并跳过，不抛。 */
function filesUnder(target, problems = null) {
  try {
    const stat = fs.lstatSync(target)
    if (!stat.isDirectory()) return stat.isFile() ? [target] : []
    return fs.readdirSync(target).flatMap(name => filesUnder(path.join(target, name), problems))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    if (!problems) throw error
    problems.push({ file: target, reason: reasonOf(error) })
    return []
  }
}

// 读不了的文件记为 null：与运行前的记录不同，算作本次改过，交给扫描去记下读不了的原因。
const stamp = file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}` } catch { return null } }

/** 目录下各文件的修改时间与大小，运行前取一次，交给 changedFiles。 */
export function fileStamps(target) {
  return new Map(filesUnder(target).map(file => [file, stamp(file)]))
}

/** 运行后新建或改过的文件。事先就有且没动过的文件不归本次运行，不查也不删。遍历不了的路径记进 problems，由调用方判扫描不完整。 */
export function changedFiles(target, before, problems = []) {
  return filesUnder(target, problems).filter(file => before.get(file) !== stamp(file))
}

/** 结果里出现 secret 就把它整体换成占位文字，redacted 标出来，由调用方判失败。 */
export function redactSecret(value, secret) {
  const text = JSON.stringify(value)
  const escaped = JSON.stringify(secret).slice(1, -1)
  if (!text.includes(escaped)) return { value, redacted: false }
  return { value: JSON.parse(text.split(escaped).join('[已遮蔽]')), redacted: true }
}

/** targets（文件或目录）下逐字节含 secret 的文件。读不了的文件逐个记进 unreadable，其余照查；调用方据此判扫描不完整。 */
export function filesContaining(targets, secret, read = fs.readFileSync) {
  if (!secret) throw new Error('要查找的密钥为空')
  const needle = Buffer.from(secret, 'utf8')
  const unreadable = []
  const files = targets.flatMap(target => filesUnder(target, unreadable))
  const hits = []
  for (const file of files) {
    try {
      if (read(file).includes(needle)) hits.push(file)
    } catch (error) {
      if (error.code !== 'ENOENT') unreadable.push({ file, reason: reasonOf(error) })
    }
  }
  return { scanned: files.length, hits, unreadable }
}

/**
 * 驱动里所有删除都走这里：带有限重试，应对 Windows 上短暂占用的 EBUSY、EPERM（maxRetries 只在 recursive 为 true 时生效）。
 * 失败返回错误码，不抛：清理失败不能打断后面的结果写出与密钥扫描。
 */
export function removePath(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return null
  } catch (error) { return reasonOf(error) }
}

/** 应用把模型档案（含明文 Key）写在数据目录（含各代 generations/<id>/）的 models.json，写入时经同目录的临时文件。 */
export function removeModelConfigs(canonical, remove = removePath) {
  const removed = []
  const failures = []
  for (const file of filesUnder(canonical)) {
    const name = path.basename(file)
    if (name !== 'models.json' && !name.startsWith('.models.json.')) continue
    const reason = remove(file)
    if (reason) failures.push({ file, reason })
    else removed.push(file)
  }
  return { removed, failures }
}
