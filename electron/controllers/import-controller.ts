import { app, ipcMain, dialog } from 'electron'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import {
  ExternalFileGrantService,
  externalFileGrants,
} from '../services/external-file-grant-service'
import {
  ImportInspectionStore,
  importInspectionStore,
} from '../services/import-inspection-store'
import { ImportSourceIdentityRepository } from '../repositories/import-source-identity-repository'
import { loadApplicationImportSourceSecret } from '../services/import-source-identity-secret'
import { mainText } from '../i18n'
import {
  windowsSafeFileSystem,
  type WindowsSafeFileSystem,
} from '../security/windows-safe-file-system'
import {
  DEFAULT_IMPORT_RESOURCE_LIMITS,
  type ImportResourceLimits,
} from '../../src/shared/import-limits'
import type { ImportPurpose, ImportSourceFileIdentity } from '../../src/shared/import-run'

/**
 * 导入小说控制器 — 处理文件选择与章节拆分
 *
 * 拆章策略按优先级顺序尝试匹配：
 * 1. 中文标准格式："第X章 标题" / "第X章：标题"
 * 2. 英文标准格式："Chapter X: Title"
 * 3. Markdown 标题格式："# 第X章 标题"
 * 如果所有正则均不命中，则将整个文件视为单章。
 */

// ===== 拆章正则池 =====

/** 中文"第X章"格式（支持中文数字和阿拉伯数字，冒号可有可无） */
const RE_CN_CHAPTER = /^第[一二三四五六七八九十百千零\d]+章[\s：:·—-]*(.*)/

/** 英文 "Chapter X" 格式 */
const RE_EN_CHAPTER = /^Chapter\s+(\d+)[\s：:·—-]*(.*)/i

/** Markdown 标题格式："# 第X章" 或 "## Chapter X" */
const RE_MD_HEADING = /^#{1,3}\s+(?:第[一二三四五六七八九十百千零\d]+章|Chapter\s+\d+)[\s：:·—-]*(.*)/i

/** 所有候选正则 */
const CHAPTER_PATTERNS = [RE_CN_CHAPTER, RE_EN_CHAPTER, RE_MD_HEADING]

const IMPORT_GRANT_TTL_MS = 5 * 60 * 1000

export type ImportFileIdentityProvider = (filePath: string) => ImportSourceFileIdentity

/** Raw identities never leave main-process memory; project storage only receives a salted HMAC. */
function defaultFileIdentity(filePath: string): ImportSourceFileIdentity {
  const canonicalLocation = realpathSync.native(filePath)
  const stats = statSync(canonicalLocation, { bigint: true })
  return {
    canonicalLocation,
    ...(stats.ino === 0n
      ? {}
      : { fileIdentity: `dev:${stats.dev.toString()}:ino:${stats.ino.toString()}` }),
  }
}

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

/** 中文数字到阿拉伯数字的映射 */
function chineseNumToArabic(str: string): number {
  const map: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
    '十': 10, '百': 100, '千': 1000,
  }

  // 纯阿拉伯数字
  const n = parseInt(str)
  if (!isNaN(n)) return n

  // 中文数字解析（支持"一百二十三"等简单组合）
  let result = 0
  let current = 0
  for (const ch of str) {
    const val = map[ch]
    if (val === undefined) continue
    if (val >= 10) {
      if (current === 0) current = 1
      current *= val
      result += current
      current = 0
    } else {
      current = val
    }
  }
  return result + current
}

/** 从章节标题行提取章节号 */
function extractChapterNumber(line: string): number {
  // 尝试从"第X章"格式提取
  const cnMatch = line.match(/第([一二三四五六七八九十百千零\d]+)章/)
  if (cnMatch) return chineseNumToArabic(cnMatch[1])

  // 尝试从"Chapter X"格式提取
  const enMatch = line.match(/Chapter\s+(\d+)/i)
  if (enMatch) return parseInt(enMatch[1])

  return 0
}

/** 检测一行是否是章节标题 */
function isChapterHeading(line: string): boolean {
  const trimmed = line.trim()
  return CHAPTER_PATTERNS.some(re => re.test(trimmed))
}

/** 从章节标题行提取标题文字（去掉"第X章"前缀） */
function extractTitle(line: string): string {
  const trimmed = line.trim()
  for (const re of CHAPTER_PATTERNS) {
    const match = trimmed.match(re)
    if (match) {
      // 取最后一个捕获组（标题部分）
      const title = match[match.length - 1]?.trim()
      if (title) return title
      // 如果标题为空，返回完整行
      return trimmed
    }
  }
  return trimmed
}

interface ParsedChapter {
  number: number
  title: string
  content: string
  wordCount: number
  contentFingerprint?: string
  contentSize?: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sourceMediaType(displayName: string): string {
  return path.extname(displayName).toLowerCase() === '.md' ? 'text/markdown' : 'text/plain'
}

/** 将单个文件内容拆分为章节数组 */
function splitSingleFileContent(content: string, maxChapters: number): ParsedChapter[] {
  const lines = content.split('\n')
  const chapters: ParsedChapter[] = []
  let currentChapter: { headerLine: string; lines: string[] } | null = null
  let autoNumber = 0

  const appendChapter = (chapter: ParsedChapter) => {
    if (chapters.length >= maxChapters) {
      throw new Error(`导入章节数不能超过 ${maxChapters}`)
    }
    chapters.push(chapter)
  }

  for (const line of lines) {
    if (isChapterHeading(line)) {
      // 保存上一个章节
      if (currentChapter) {
        autoNumber++
        const num = extractChapterNumber(currentChapter.headerLine) || autoNumber
        const text = currentChapter.lines.join('\n').trim()
        if (text.length > 0) {
          appendChapter({
            number: num,
            title: extractTitle(currentChapter.headerLine),
            content: text,
            wordCount: text.length,
          })
        }
      }
      // 开始新章节
      currentChapter = { headerLine: line, lines: [] }
    } else if (currentChapter) {
      currentChapter.lines.push(line)
    } else {
      // 在第一个章节标题之前的内容 → 创建前言/序章
      if (!currentChapter) {
        currentChapter = { headerLine: line, lines: [] }
      }
    }
  }

  // 保存最后一个章节
  if (currentChapter) {
    autoNumber++
    const num = extractChapterNumber(currentChapter.headerLine) || autoNumber
    const text = currentChapter.lines.join('\n').trim()
    if (text.length > 0) {
      appendChapter({
        number: num,
        title: extractTitle(currentChapter.headerLine),
        content: text,
        wordCount: text.length,
      })
    }
  }

  return chapters
}

/** 如果内容中没有匹配到任何章节标题，则整文件视为一章 */
function hasChapterHeadings(content: string): boolean {
  const lines = content.split('\n')
  return lines.some(line => isChapterHeading(line))
}

export function registerImportController(
  fileSystem: WindowsSafeFileSystem = windowsSafeFileSystem,
  fileIdentity: ImportFileIdentityProvider = defaultFileIdentity,
  limitOverrides: Partial<ImportResourceLimits> = {},
  grantService: ExternalFileGrantService = externalFileGrants,
  inspectionStore: ImportInspectionStore = importInspectionStore,
  applicationSecret?: Buffer,
) {
  const limits: ImportResourceLimits = {
    ...DEFAULT_IMPORT_RESOURCE_LIMITS,
    ...limitOverrides,
  }
  for (const [key, value] of Object.entries(limits) as Array<[keyof ImportResourceLimits, number]>) {
    if (
      !Number.isSafeInteger(value)
      || value < 1
      || value > DEFAULT_IMPORT_RESOURCE_LIMITS[key]
    ) throw new Error(`导入资源限制 ${key} 无效`)
  }
  // Selection, bounded reading, and inspection are one main-process operation.
  // The renderer receives only the final inspection token and safe display facts.
  ipcMain.handle('dialog:select-novel-files', async (event, requestedPurpose?: ImportPurpose) => {
    event.sender.once('destroyed', () => {
      grantService.revokeWebContents(event.sender.id)
      inspectionStore.revokeForWebContents(event.sender.id)
    })
    try {
      const purpose: ImportPurpose = requestedPurpose ?? 'reference'
      if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('IMPORT_PURPOSE_INVALID')
      const result = await dialog.showOpenDialog({
        title: purpose === 'author-manuscript'
          ? text('选择作者原稿文件', 'Choose author manuscript files')
          : text('选择参考小说文件', 'Choose reference novel files'),
        filters: [
          { name: text('小说文本', 'Novel text'), extensions: ['txt', 'md', 'text'] },
          { name: text('所有文件', 'All files'), extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      inspectionStore.revokeForWebContents(event.sender.id)
      if (result.filePaths.length > limits.maxSourceFiles) {
        throw new Error('IMPORT_SOURCE_COUNT_EXCEEDED')
      }

      // Count, identity, stat, and aggregate-size preflight all complete before
      // the first capability is allocated.
      let selectedBytes = 0
      const selected = result.filePaths.map(filePath => {
        const identity = fileIdentity(filePath)
        const selectedSize = statSync(identity.canonicalLocation).size
        if (!Number.isSafeInteger(selectedSize) || selectedSize < 0) {
          throw new Error('IMPORT_SOURCE_SIZE_INVALID')
        }
        if (selectedSize > limits.maxTotalBytes - selectedBytes) {
          throw new Error('IMPORT_SOURCE_BYTES_EXCEEDED')
        }
        selectedBytes += selectedSize
        return { filePath, identity, displayName: path.basename(filePath) }
      }).sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN', { numeric: true }))
      const encodedIdentities = ImportSourceIdentityRepository.encodeSources(
        selected.map(source => source.identity),
        purpose,
        applicationSecret ?? loadApplicationImportSourceSecret(),
      )

      let chapterCount = 0
      const sources: Array<{
        locationAliasDigest: string
        fileAliasDigest?: string
        displayName: string
        mediaType: string
        size: number
      }> = []
      let consumedBytes = 0

      const reserveSourceBytes = (content: string): number => {
        const contentBytes = Buffer.byteLength(content, 'utf8')
        if (contentBytes > limits.maxTotalBytes - consumedBytes) {
          throw new Error('IMPORT_SOURCE_BYTES_EXCEEDED')
        }
        consumedBytes += contentBytes
        return contentBytes
      }

      const appendChapters = (chapters: ParsedChapter[]) => {
        if (chapters.length > limits.maxChapters - chapterCount) {
          throw new Error(`导入章节数不能超过 ${limits.maxChapters}`)
        }
        chapterCount += chapters.length
      }

      const inspectedChapters: Array<ParsedChapter & { sourceIndex: number; sourceChapterNumber: number }> = []
      for (let sourceIndex = 0; sourceIndex < selected.length; sourceIndex++) {
        const source = selected[sourceIndex]
        const encoded = encodedIdentities[sourceIndex]
        let grantId = ''
        try {
          const grant = grantService.issueFile({
            webContentsId: event.sender.id,
            filePath: source.filePath,
            operations: ['read'],
            ttlMs: IMPORT_GRANT_TTL_MS,
            maxUses: 1,
          })
          grantId = grant.grantId
          const capability = grantService.resolve({
            grantId,
            webContentsId: event.sender.id,
            operation: 'read',
          })
          let content = await fileSystem.readText(capability, limits.maxTotalBytes - consumedBytes)
          const contentBytes = reserveSourceBytes(content)
          const sourceFileName = source.displayName
          sources.push({
            ...encoded,
            displayName: sourceFileName,
            mediaType: sourceMediaType(sourceFileName),
            size: contentBytes,
          })
          content = content.trim()
          if (!content) continue
          const parsed = hasChapterHeadings(content)
            ? splitSingleFileContent(content, limits.maxChapters - chapterCount)
            : [{
                number: extractChapterNumber(path.basename(sourceFileName, path.extname(sourceFileName))) || 1,
                title: path.basename(sourceFileName, path.extname(sourceFileName)),
                content,
                wordCount: content.length,
              }]
          appendChapters(parsed)
          const usedLocalNumbers = new Set<number>()
          let nextLocalNumber = 1
          for (const chapter of parsed) {
            let sourceChapterNumber = chapter.number
            if (!Number.isSafeInteger(sourceChapterNumber) || sourceChapterNumber < 1 || usedLocalNumbers.has(sourceChapterNumber)) {
              while (usedLocalNumbers.has(nextLocalNumber)) nextLocalNumber++
              sourceChapterNumber = nextLocalNumber
            }
            usedLocalNumbers.add(sourceChapterNumber)
            inspectedChapters.push({ ...chapter, sourceIndex, sourceChapterNumber })
          }
          content = ''
        } finally {
          if (grantId) grantService.revoke(grantId)
        }
      }

      // Preview numbers are renderer-only. Stable global numbers are assigned
      // later from (opaque source id, source-local chapter number) in SQLite.
      const numbered = inspectedChapters.map((ch, idx) => ({
        ...ch,
        number: purpose === 'author-manuscript' ? ch.number : idx + 1,
        contentFingerprint: sha256(ch.content),
        contentSize: Buffer.byteLength(ch.content, 'utf8'),
      }))
      if (purpose === 'author-manuscript') {
        const seen = new Set<number>()
        for (const chapter of numbered) {
          if (!Number.isSafeInteger(chapter.number) || chapter.number < 1 || seen.has(chapter.number)) {
            throw new Error(`AUTHOR_MANUSCRIPT_DUPLICATE_CHAPTER:${chapter.number}`)
          }
          seen.add(chapter.number)
        }
      }

      return {
        success: true,
        inspection: inspectionStore.create({ webContentsId: event.sender.id, purpose, sources, chapters: numbered }),
      }
    } catch (error) {
      inspectionStore.revokeForWebContents(event.sender.id)
      const message = error instanceof Error ? error.message : String(error)
      const duplicateChapter = /^AUTHOR_MANUSCRIPT_DUPLICATE_CHAPTER:(\d+)$/u.exec(message)
      return {
        success: false,
        error: duplicateChapter
          ? text(
              `作者原稿包含重复的第 ${duplicateChapter[1]} 章；请修正章节号后重新选择。`,
              `The author manuscript contains duplicate Chapter ${duplicateChapter[1]}. Correct the chapter numbers and choose the files again.`,
            )
          : text('无法读取所选文件；请重新选择后再试。', 'Could not read the selected files. Please choose them again.'),
      }
    }
  })
}
