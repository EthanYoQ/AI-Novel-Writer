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
import type {
  ImportNovelFileSelectionRequest,
  ImportPurpose,
  ImportRunChapterInput,
  ImportRunLocale,
  ImportSourceFileIdentity,
} from '../../src/shared/import-run'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { countDraftUnits } from '../../src/shared/draft-units'
import { getCurrentProjectPath, getProjectDb } from '../database'
import { projectAccess } from '../services/project-access'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'
import { ImportRunRepository } from '../repositories/import-run-repository'
import {
  EPUB_MAX_ARCHIVE_ENTRIES,
  EPUB_MAX_ENTRY_BYTES,
  EPUB_MAX_EXTRACTED_BYTES,
  extractEpubChapters,
} from '../services/epub-extraction-service'

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

function importText(locale: ImportRunLocale | undefined, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : locale === 'zh-CN' ? zhCNText : text(zhCNText, enUSText)
}

function importSelectionErrorMessage(
  error: unknown,
  locale: ImportRunLocale | undefined,
  limits: ImportResourceLimits,
): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'IMPORT_SOURCE_COUNT_EXCEEDED') {
    return importText(
      locale,
      `所选文件数量超过导入上限（最多 ${limits.maxSourceFiles} 个）。`,
      `The import source-file limit was exceeded (limit: ${limits.maxSourceFiles}).`,
    )
  }
  if (code === 'IMPORT_SOURCE_BYTES_EXCEEDED' || code === 'SECURE_FS_FILE_TOO_LARGE') {
    return importText(
      locale,
      `所选文件总大小超过导入上限（最多 ${limits.maxTotalBytes} 字节）。`,
      `The import source-size limit was exceeded (limit: ${limits.maxTotalBytes} bytes).`,
    )
  }
  if (code === 'IMPORT_CHAPTER_COUNT_EXCEEDED') {
    return importText(
      locale,
      `拆分后的章节数超过导入上限（最多 ${limits.maxChapters} 章）。`,
      `The import chapter limit was exceeded (limit: ${limits.maxChapters}).`,
    )
  }
  if (code === 'EPUB_DRM_UNSUPPORTED') {
    return importText(
      locale,
      '该 EPUB 受 DRM 或加密保护，无法导入。请使用无 DRM 的 EPUB 或文本文件。',
      'This EPUB is DRM-protected or encrypted and cannot be imported. Use a DRM-free EPUB or text file.',
    )
  }
  if (code === 'EPUB_EXPANSION_LIMIT') {
    return importText(
      locale,
      '该 EPUB 的条目数或解压后内容超过安全上限，无法导入。',
      'This EPUB exceeds the safe entry-count or expanded-content limit and cannot be imported.',
    )
  }
  if (code === 'EPUB_INVALID_ARCHIVE') {
    return importText(
      locale,
      'EPUB 文件已损坏，或缺少有效的 container.xml、OPF 与正文阅读顺序。',
      'The EPUB is damaged or lacks a valid container.xml, OPF package, or textual reading order.',
    )
  }
  return importText(
    locale,
    '无法读取所选文件；请重新选择后再试。',
    'Could not read the selected files. Please choose them again.',
  )
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
  const extension = path.extname(displayName).toLowerCase()
  if (extension === '.epub') return 'application/epub+zip'
  return extension === '.md' ? 'text/markdown' : 'text/plain'
}

/** 将单个文件内容拆分为章节数组 */
function splitSingleFileContent(content: string, maxChapters: number): ParsedChapter[] {
  const lines = content.split('\n')
  const chapters: ParsedChapter[] = []
  let currentChapter: { headerLine: string; lines: string[] } | null = null
  let autoNumber = 0

  const appendChapter = (chapter: ParsedChapter) => {
    if (chapters.length >= maxChapters) {
      throw new Error('IMPORT_CHAPTER_COUNT_EXCEEDED')
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
            wordCount: countDraftUnits(text),
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
        wordCount: countDraftUnits(text),
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
  ipcMain.handle('dialog:select-novel-files', async (
    event,
    request?: ImportPurpose | ImportNovelFileSelectionRequest,
    projectSession?: ProjectSessionContext,
  ) => {
    event.sender.once('destroyed', () => {
      grantService.revokeWebContents(event.sender.id)
      inspectionStore.revokeForWebContents(event.sender.id)
    })
    const structuredRequest = typeof request === 'object' && request !== null ? request : undefined
    const purpose: ImportPurpose = typeof request === 'string' ? request : (structuredRequest?.purpose ?? 'reference')
    let frozenProject: { rootPath: string; session: ProjectSessionContext } | undefined
    let responseLocale = structuredRequest?.locale
    const assertFrozenProject = () => {
      if (!frozenProject) return
      const active = projectAccess.assertCurrentProjectContext(
        frozenProject.session,
        getCurrentProjectPath(),
      )
      assertRequiredExpectedProjectPath(active.rootPath, frozenProject.rootPath)
    }
    try {
      if (purpose !== 'reference' && purpose !== 'author-manuscript') throw new Error('IMPORT_PURPOSE_INVALID')
      if (structuredRequest) {
        const active = projectAccess.assertCurrentProjectContext(projectSession, getCurrentProjectPath())
        assertRequiredExpectedProjectPath(active.rootPath, structuredRequest.expectedProjectPath)
        frozenProject = {
          rootPath: active.rootPath,
          session: Object.freeze({ ...projectSession }) as ProjectSessionContext,
        }
      }
      const result = await dialog.showOpenDialog({
        title: purpose === 'author-manuscript'
          ? text('选择作者原稿文件', 'Choose author manuscript files')
          : text('选择参考小说文件', 'Choose reference novel files'),
        filters: [
          { name: text('小说文件', 'Novel files'), extensions: ['txt', 'md', 'text', 'epub'] },
          { name: text('所有文件', 'All files'), extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      assertFrozenProject()
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
        return { filePath, identity, displayName: path.basename(filePath), selectedSize }
      }).sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN', { numeric: true }))
      const encodedIdentities = ImportSourceIdentityRepository.encodeSources(
        selected.map(source => source.identity),
        purpose,
        applicationSecret ?? loadApplicationImportSourceSecret(),
      )
      const parsingContext = structuredRequest?.purpose === 'reference'
        ? (() => {
            assertFrozenProject()
            const projectDb = getProjectDb()
            if (!projectDb) throw new Error('项目数据库未打开')
            return projectDb.transaction(() => {
              const resolvedIdentity = ImportSourceIdentityRepository.resolveEncodedSources(
                encodedIdentities,
                structuredRequest.purpose,
                applicationSecret ?? loadApplicationImportSourceSecret(),
              )
              const parsingRun = ImportRunRepository.beginParsing({
                runId: structuredRequest.runId,
                purpose: structuredRequest.purpose,
                sourceFingerprint: resolvedIdentity.sourceFingerprint,
                sourceIds: resolvedIdentity.sourceIds,
                sourceFingerprints: resolvedIdentity.sourceFingerprints,
                legacySourceFingerprints: resolvedIdentity.legacySourceFingerprints,
                legacyCollectionFingerprint: resolvedIdentity.legacyCollectionFingerprint,
                sourceDisplay: selected.map(source => ({
                  displayName: source.displayName,
                  mediaType: sourceMediaType(source.displayName),
                  size: source.selectedSize,
                })),
                locale: structuredRequest.locale,
              })
              if (parsingRun.totalContentSize > limits.maxTotalBytes - selectedBytes) {
                throw new Error('IMPORT_SOURCE_BYTES_EXCEEDED')
              }
              return { resolvedIdentity, parsingRun }
            })()
          })()
        : undefined
      const resolvedIdentity = parsingContext?.resolvedIdentity
      const parsingRun = parsingContext?.parsingRun
      // An ordinary selection may discover an unfinished run by source
      // identity even when the renderer supplied a fresh run id and a changed
      // UI locale. From this point onward, the durable run owns user-facing
      // parsing copy as well as persisted failures.
      responseLocale = parsingRun?.locale ?? responseLocale

      let chapterCount = parsingRun?.completedChapters ?? 0
      const sources: Array<{
        locationAliasDigest: string
        fileAliasDigest?: string
        displayName: string
        mediaType: string
        size: number
      }> = []
      let consumedBytes = parsingRun?.totalContentSize ?? 0

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
          throw new Error('IMPORT_CHAPTER_COUNT_EXCEEDED')
        }
        chapterCount += chapters.length
      }

      const inspectedChapters: Array<ParsedChapter & { sourceIndex: number; sourceChapterNumber: number }> = []
      let emptySourceFound = false
      let titleOnlySourceFound = false
      for (let sourceIndex = 0; sourceIndex < selected.length; sourceIndex++) {
        const source = selected[sourceIndex]
        const encoded = encodedIdentities[sourceIndex]
        const opaqueSourceId = resolvedIdentity?.sourceIds[sourceIndex]
        assertFrozenProject()
        if (parsingRun && opaqueSourceId
          && ImportRunRepository.parsedSourceStatus(parsingRun.id, opaqueSourceId) === 'completed') {
          continue
        }
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
          const sourceFileName = source.displayName
          const remainingBytes = limits.maxTotalBytes - consumedBytes
          const isEpub = path.extname(sourceFileName).toLowerCase() === '.epub'
          let parsed: ParsedChapter[]
          let contentBytes: number
          let content = ''
          if (isEpub) {
            const archive = await fileSystem.readBytes(capability, remainingBytes)
            assertFrozenProject()
            const extracted = await extractEpubChapters(archive, {
              maxEntries: EPUB_MAX_ARCHIVE_ENTRIES,
              maxEntryBytes: Math.min(EPUB_MAX_ENTRY_BYTES, remainingBytes),
              maxExtractedBytes: Math.min(EPUB_MAX_EXTRACTED_BYTES, remainingBytes),
            })
            contentBytes = reserveSourceBytes(extracted.map(chapter => chapter.content).join(''))
            parsed = extracted.flatMap((chapter, index) => {
              if (hasChapterHeadings(chapter.content)) {
                return splitSingleFileContent(
                  chapter.content,
                  limits.maxChapters - chapterCount,
                )
              }
              return [{
                number: index + 1,
                title: chapter.title,
                content: chapter.content,
                wordCount: countDraftUnits(chapter.content),
              }]
            })
          } else {
            content = await fileSystem.readText(capability, remainingBytes)
            assertFrozenProject()
            contentBytes = reserveSourceBytes(content)
            content = content.trim()
            if (!content) {
              emptySourceFound = true
              if (parsingRun && opaqueSourceId) {
                assertFrozenProject()
                ImportRunRepository.failParsedSource(
                  parsingRun.id,
                  opaqueSourceId,
                  importText(responseLocale, '所选来源文件为空', 'Selected source file is empty'),
                )
              }
              continue
            }
            parsed = hasChapterHeadings(content)
              ? splitSingleFileContent(content, limits.maxChapters - chapterCount)
              : [{
                  number: extractChapterNumber(path.basename(sourceFileName, path.extname(sourceFileName))) || 1,
                  title: path.basename(sourceFileName, path.extname(sourceFileName)),
                  content,
                  wordCount: countDraftUnits(content),
                }]
          }
          sources.push({
            ...encoded,
            displayName: sourceFileName,
            mediaType: sourceMediaType(sourceFileName),
            size: contentBytes,
          })
          if (parsed.length === 0) {
            titleOnlySourceFound = true
            if (parsingRun && opaqueSourceId) {
              assertFrozenProject()
              ImportRunRepository.failParsedSource(
                parsingRun.id,
                opaqueSourceId,
                importText(
                  responseLocale,
                  '所选来源文件只有章节标题，没有可导入的正文',
                  'The selected source file contains chapter headings but no body text',
                ),
              )
            }
            continue
          }
          appendChapters(parsed)
          const usedLocalNumbers = new Set<number>()
          let nextLocalNumber = 1
          const firstInspectedChapter = inspectedChapters.length
          for (const chapter of parsed) {
            let sourceChapterNumber = chapter.number
            if (!Number.isSafeInteger(sourceChapterNumber) || sourceChapterNumber < 1 || usedLocalNumbers.has(sourceChapterNumber)) {
              while (usedLocalNumbers.has(nextLocalNumber)) nextLocalNumber++
              sourceChapterNumber = nextLocalNumber
            }
            usedLocalNumbers.add(sourceChapterNumber)
            inspectedChapters.push({ ...chapter, sourceIndex, sourceChapterNumber })
          }
          if (parsingRun && opaqueSourceId) {
            const sourceChapters: ImportRunChapterInput[] = parsed.map((chapter, index) => {
              const persisted = inspectedChapters[firstInspectedChapter + index]
              const sourceChapterNumber = persisted?.sourceChapterNumber ?? chapter.number
              return {
                number: sourceChapterNumber,
                sourceChapterNumber,
                title: chapter.title,
                content: chapter.content,
                contentFingerprint: sha256(chapter.content),
                contentSize: Buffer.byteLength(chapter.content, 'utf8'),
              }
            })
            assertFrozenProject()
            ImportRunRepository.commitParsedSource(parsingRun.id, opaqueSourceId, sourceChapters)
          }
          content = ''
        } catch (error) {
          let projectStillCurrent = false
          try {
            assertFrozenProject()
            projectStillCurrent = true
          } catch {
            // A stale project session must not turn a read failure into a write
            // against the newly active project's database.
          }
          if (projectStillCurrent && parsingRun && opaqueSourceId
            && ImportRunRepository.parsedSourceStatus(parsingRun.id, opaqueSourceId) !== 'completed') {
            assertFrozenProject()
            ImportRunRepository.failParsedSource(
              parsingRun.id,
              opaqueSourceId,
              importSelectionErrorMessage(error, responseLocale, limits),
            )
          }
          throw error
        } finally {
          if (grantId) grantService.revoke(grantId)
        }
      }

      if (emptySourceFound) {
        const error = responseLocale === 'en-US'
          ? 'One or more selected files are empty. Add novel text and choose the unfinished files again.'
          : responseLocale === 'zh-CN'
            ? '一个或多个所选文件为空。请补充小说正文后，重新选择未完成的文件。'
            : text(
                '一个或多个所选文件为空。请补充小说正文后，重新选择未完成的文件。',
                'One or more selected files are empty. Add novel text and choose the unfinished files again.',
              )
        return { success: false, error }
      }

      if (titleOnlySourceFound) {
        return {
          success: false,
          error: importText(
            responseLocale,
            '一个或多个所选文件只有章节标题，没有可导入的正文。请补充小说正文后，重新选择未完成的文件。',
            'One or more selected files contain chapter headings but no body text. Add novel text and choose the unfinished files again.',
          ),
        }
      }

      if (parsingRun) {
        assertFrozenProject()
        return { success: true, preparation: ImportRunRepository.finalizeParsing(parsingRun.id) }
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
          : importSelectionErrorMessage(error, responseLocale, limits),
      }
    }
  })
}
