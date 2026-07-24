import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { GlobalConfig } from '../../src/shared/ipc-channels'

export const VELA_HOME = path.join(os.homedir(), '.vela')

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

export function writeJsonFile(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
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
