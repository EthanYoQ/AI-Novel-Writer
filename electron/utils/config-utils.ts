import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { GlobalConfig } from '../../src/shared/ipc-channels'

/** 测试和受控迁移可提供隔离目录；普通用户始终沿用 ~/.vela。 */
export const VELA_HOME = process.env.AI_NOVEL_VELA_HOME?.trim() || path.join(os.homedir(), '.vela')

export function ensureVelaHome() {
  const dirs = [
    VELA_HOME,
    path.join(VELA_HOME, 'prompts'),
    path.join(VELA_HOME, 'logs'),
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

export type JsonFileReadResult<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'error'; error: unknown }

/**
 * 区分“文件不存在”与“文件存在但不可读取/不可解析”。
 * 对全局配置做增量写入的调用方必须在 error 时拒绝覆盖原文件。
 */
export function tryReadJsonFile<T>(filePath: string): JsonFileReadResult<T> {
  if (!fs.existsSync(filePath)) return { status: 'missing' }
  try {
    return { status: 'ok', value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T }
  } catch (error) {
    return { status: 'error', error }
  }
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  const result = tryReadJsonFile<T>(filePath)
  if (result.status === 'ok') return result.value
  if (result.status === 'error') {
    console.warn(`[Vela] 读取 ${filePath} 失败:`, result.error)
  }
  return fallback
}

const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const
const WINDOWS_REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

function waitSynchronously(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(signal, 0, 0, milliseconds)
}

function replaceFileWithRetry(temporaryPath: string, filePath: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const delay = WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]
      if (
        process.platform !== 'win32'
        || !code
        || !WINDOWS_REPLACE_RETRY_CODES.has(code)
        || delay === undefined
      ) {
        throw error
      }
      // Windows Defender / 索引服务可能短暂占用刚写完的配置文件。
      waitSynchronously(delay)
    }
  }
}

export function writeJsonFile(filePath: string, data: unknown) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let temporaryFile: number | undefined

  fs.mkdirSync(directory, { recursive: true })

  try {
    // 同目录临时文件保证 rename 不会跨卷；wx 避免意外覆盖其他进程的临时文件。
    temporaryFile = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf-8')
    fs.fsyncSync(temporaryFile)
    fs.closeSync(temporaryFile)
    temporaryFile = undefined

    // Windows Defender / 索引服务可能短暂阻止替换；只重试典型占用错误。
    // 若最终仍失败，原文件保持原样，finally 只清理尚未安装的临时文件。
    replaceFileWithRetry(temporaryPath, filePath)
  } finally {
    if (temporaryFile !== undefined) {
      try {
        fs.closeSync(temporaryFile)
      } catch {
        // 保留原始写入异常；下面仍会尝试清理临时文件。
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn(`[Vela] 清理配置临时文件 ${temporaryPath} 失败:`, error)
      }
    }
  }
}

export const GLOBAL_CONFIG_PATH = path.join(VELA_HOME, 'config.json')
export const MODELS_CONFIG_PATH = path.join(VELA_HOME, 'models.json')
export const RECENT_PROJECTS_PATH = path.join(VELA_HOME, 'recent-projects.json')

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  theme: 'dark',
  defaultModelId: null,
  autoOpenNextChapterAfterFinalize: false,
  editorFontSize: 16,
  editorFontFamily: 'Noto Serif SC',
  autoSaveInterval: 30,
  proxy: {
    enabled: false,
    type: 'http',
    host: '',
    port: 7890,
  },
}
