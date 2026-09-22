import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { ipcMain } from 'electron'

import { VELA_HOME } from '../utils/config-utils'

/**
 * 把审稿材料当作「文件」放进剪贴板。
 *
 * 为什么需要它：先生实测过 —— 从资源管理器复制文件、到网页版 AI 的输入框粘贴，
 * 浏览器会把它当成「粘贴了几个文件」并触发上传。我们照抄这个机制：
 * 把材料各写成 .md，再用 Windows 的文件剪贴板格式（CF_HDROP）投递，
 * 作者一次 Ctrl+V 就等于把这几个文件一起上传了。
 *
 * 两个 Windows 上的坑（都踩过，写在这里免得再踩）：
 *  1. 投递必须走 **STA 线程**的 WinForms 剪贴板 API —— PowerShell 5.1 的
 *     `-STA` 正好提供；pwsh(7) 默认 MTA，调用会直接失败。
 *  2. 文件路径**不能走命令行参数**：中文路径会被转码弄坏，数组还会被拼成一个
 *     逗号串。所以改成写一份 UTF-8 JSON、用环境变量把路径递给脚本。
 *     同理，JSON 顶层必须是对象而不是裸数组 —— PowerShell 5.1 的
 *     ConvertFrom-Json 不会枚举顶层数组，整份列表会变成一个拼接字符串。
 */

/** 单个文件大小上限：足够放下任何一章正文，同时挡住异常输入。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILE_COUNT = 32

export interface ExternalAiAuditClipboardFile {
  name: string
  content: string
}

export interface ExternalAiAuditFileControllerOptions {
  /** 可注入：测试里不真的去启动 PowerShell。 */
  setClipboardFiles?: (paths: string[]) => Promise<void>
  /** 文件落地目录；默认落在应用数据目录下。 */
  directory?: string
  ipc?: Pick<typeof ipcMain, 'handle'>
}

/** 文件名清洗：只留基名，挡掉路径穿越与非法字符。 */
function safeFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // \p{Cc} 是 Unicode 的「控制字符」类别：比手写 \u0000-\u001f 更准，也不会
  // 触发 no-control-regex（那条规则针对的是正则里内联控制字符范围）。
  const base = raw.trim().replace(/[\\/]+/g, '-').replace(/[\p{Cc}<>:"|?*]/gu, '').trim()
  if (!base || base === '.' || base === '..') return null
  if (base.length > 80) return null
  return /\.(md|txt)$/iu.test(base) ? base : `${base}.md`
}

function normalizeFiles(raw: unknown): ExternalAiAuditClipboardFile[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILE_COUNT) return null
  const files: ExternalAiAuditClipboardFile[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') return null
    const record = candidate as Record<string, unknown>
    const name = safeFileName(record.name)
    const content = record.content
    if (!name || typeof content !== 'string') return null
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return null
    files.push({ name, content })
  }
  return files
}

/** 默认投递：写一份 JSON，再用 STA 的 PowerShell 把它设成剪贴板文件列表。 */
function defaultSetClipboardFiles(jsonPath: string): Promise<void> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$payload = Get-Content -Path $env:AI_NOVEL_AUDIT_JSON -Raw -Encoding UTF8 | ConvertFrom-Json',
    '$collection = New-Object System.Collections.Specialized.StringCollection',
    'foreach ($file in $payload.files) { [void]$collection.Add([string]$file) }',
    '[System.Windows.Forms.Clipboard]::SetFileDropList($collection)',
  ].join('; ')

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-STA', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        // 路径走环境变量：命令行参数会把中文路径弄坏
        env: { ...process.env, AI_NOVEL_AUDIT_JSON: jsonPath },
        windowsHide: true,
        stdio: 'ignore',
      },
    )
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`PowerShell exited with code ${code}`))
    })
  })
}

export function registerExternalAiAuditFileController({
  setClipboardFiles,
  directory = path.join(VELA_HOME, 'external-audit'),
  ipc = ipcMain,
}: ExternalAiAuditFileControllerOptions = {}) {
  ipc.handle('external-ai-audit:copy-files', async (_event, rawFiles: unknown) => {
    const files = normalizeFiles(rawFiles)
    if (!files) {
      return { success: false, error: 'Unsupported review material payload.' }
    }

    try {
      // 每次重建目录：上一次切分的残留文件若混进剪贴板，作者会粘到过期的章节。
      rmSync(directory, { recursive: true, force: true })
      mkdirSync(directory, { recursive: true })

      const paths: string[] = []
      for (const file of files) {
        const target = path.join(directory, file.name)
        writeFileSync(target, file.content, 'utf8')
        paths.push(target)
      }

      if (setClipboardFiles) {
        await setClipboardFiles(paths)
      } else {
        // 默认实现需要一份 JSON 清单，放在同一个目录里
        const jsonPath = path.join(directory, 'file-list.json')
        writeFileSync(jsonPath, JSON.stringify({ files: paths }), 'utf8')
        await defaultSetClipboardFiles(jsonPath)
      }

      return { success: true, directory, fileCount: paths.length }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to place review material on the clipboard.', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unable to copy the review files.',
      }
    }
  })
}

/** 供测试与排查使用：列出上一次落下的材料文件。 */
export function listExternalAiAuditFiles(directory = path.join(VELA_HOME, 'external-audit')): string[] {
  try {
    return readdirSync(directory).filter(name => /\.(md|txt)$/iu.test(name))
  } catch {
    return []
  }
}
