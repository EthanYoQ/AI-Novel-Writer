/**
 * 导出服务 — 将小说项目导出为多种格式
 *
 * 支持：
 * - 合并 Markdown（全书合并为单个 .md）
 * - 分章 Markdown（每章一个 .md）
 * - 纯文本 TXT
 */
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import { useWorkflowStore } from '../stores/workflow-store'
import { useLocaleStore } from '../stores/locale-store'
import type { Locale } from '../i18n/types'
import type { FileWriteCommitState, ProjectSessionContext } from '../shared/ipc-channels'
import type {
  FinalizedDraftExportAuthorityReceipt,
  FinalizedDraftExportSnapshot,
} from '../../electron/repositories/finalization-repository'
import {
  getActiveProjectSessionContext,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type { WritingLanguage } from '../shared/writing-language'
import { randomUUID } from '../utils/id'


export type ExportFormat = 'merged-md' | 'split-md' | 'txt'

interface ExportOptions {
  format: ExportFormat
  /** 由主进程选择目录后签发的受限授权，绝不是绝对路径。 */
  grantId: string
  includeOutline?: boolean
  includeCharacters?: boolean
}

/** 导出任务冻结的项目展示数据；项目路径本身绝不作为访问凭据。 */
export interface ExportProjectSnapshot {
  id: string
  sessionLease: string
  path: string
  name: string
  novelConfig: Readonly<{
    genre: string
    targetAudience: string
    writingLanguage: WritingLanguage
  }>
}

function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(projectSession, getActiveProjectSessionContext())
}

function isMatchingProjectSnapshot(
  project: ExportProjectSnapshot,
  projectSession: ProjectSessionContext,
): boolean {
  return project.id === projectSession.projectId
    && project.sessionLease === projectSession.leaseId
    && sameProjectPathKey(project.path, projectSession.projectPath)
}

function staleExportResult(locale: Locale): { success: false; error: string } {
  return {
    success: false,
    error: locale === 'en-US'
      ? 'The project session changed. This export was cancelled.'
      : '项目会话已变化，本次导出已取消',
  }
}

type ExportWriteFailureCommitState = Exclude<FileWriteCommitState, 'committed'>

function requireExportWriteSuccess(
  result: { success: boolean; commitState?: FileWriteCommitState; error?: string },
  action: string,
  fallbackMessage: string,
): void {
  try {
    requireIpcSuccess(result, action, fallbackMessage)
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        commitState: result.commitState === 'unknown'
          ? 'unknown'
          : 'not_committed',
      } satisfies { commitState: ExportWriteFailureCommitState },
    )
  }
}

function exportWriteFailureCommitState(error: unknown): ExportWriteFailureCommitState | undefined {
  if (!error || typeof error !== 'object' || !('commitState' in error)) return undefined
  const value = (error as { commitState?: unknown }).commitState
  return value === 'not_committed' || value === 'unknown' ? value : undefined
}

function splitWriteDetail(
  locale: Locale,
  confirmedWritten: readonly string[],
  possiblyWritten: readonly string[],
  definitelyFailed?: string,
): string {
  const none = locale === 'en-US' ? 'none' : '无'
  const detail = locale === 'en-US'
    ? `; confirmed written: ${confirmedWritten.join(', ') || none}; possibly written: ${possiblyWritten.join(', ') || none}; definitely failed: ${definitelyFailed || none}`
    : `；已确认写入: ${confirmedWritten.join(', ') || none}；可能已写入: ${possiblyWritten.join(', ') || none}；确定写入失败: ${definitelyFailed || none}`
  if (possiblyWritten.length === 0) return detail
  return `${detail}${locale === 'en-US'
    ? '; verify possibly written files before retrying; do not retry blindly'
    : '；请先核对可能已写入的文件，不要盲目重试'}`
}

function staleSplitExportResult(
  locale: Locale,
  confirmedWritten: readonly string[],
  possiblyWritten: readonly string[] = [],
  definitelyFailed?: string,
): { success: false; error: string } {
  const stale = staleExportResult(locale)
  return {
    ...stale,
    error: `${stale.error}${splitWriteDetail(
      locale,
      confirmedWritten,
      possiblyWritten,
      definitelyFailed,
    )}`,
  }
}

function unknownSingleWriteDetail(locale: Locale, relativePath: string): string {
  return locale === 'en-US'
    ? `; ${relativePath} may have been written; verify it before retrying and do not retry blindly`
    : `；${relativePath} 可能已写入；请先核对，不要盲目重试`
}

function staleCommittedSingleExportResult(locale: Locale, relativePath: string): { success: false; error: string } {
  const stale = staleExportResult(locale)
  return {
    ...stale,
    error: `${stale.error}${locale === 'en-US'
      ? `; the exported file was already written: ${relativePath}`
      : `；导出文件已确认写入: ${relativePath}`}`,
  }
}

function changedFinalizationResult(
  locale: Locale,
  confirmedWritten: readonly string[] = [],
): { success: false; error: string } {
  const error = locale === 'en-US'
    ? 'The finalized chapters changed. Review the latest versions and confirm the export again.'
    : '定稿章节已变化，请检查最新版本并重新确认导出'
  return {
    success: false,
    error: confirmedWritten.length > 0
      ? `${error}${splitWriteDetail(locale, confirmedWritten, [])}`
      : error,
  }
}

function requireFinalizedExportSnapshot(value: unknown): FinalizedDraftExportSnapshot[] {
  if (!Array.isArray(value)) throw new Error('定稿导出快照无效')
  const seenChapters = new Set<number>()
  const rows = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('定稿导出快照无效')
    const row = candidate as Partial<FinalizedDraftExportSnapshot>
    const { draftId, chapterNumber, version, title, content, finalizationId, contentHash } = row
    if (
      typeof draftId !== 'number' || !Number.isSafeInteger(draftId) || draftId < 1
      || typeof chapterNumber !== 'number' || !Number.isSafeInteger(chapterNumber) || chapterNumber < 1
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
      || typeof title !== 'string'
      || typeof content !== 'string'
      || content.trim().length === 0
      || !(finalizationId === null
        || (typeof finalizationId === 'string' && finalizationId.trim().length > 0))
      || typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(contentHash)
    ) throw new Error('定稿导出快照身份或正文无效')
    if (seenChapters.has(chapterNumber)) throw new Error(`第 ${chapterNumber} 章存在重复定稿`)
    seenChapters.add(chapterNumber)
    return Object.freeze({
      draftId,
      chapterNumber,
      version,
      title,
      content,
      finalizationId,
      contentHash,
    })
  })
  return rows.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

function exportAuthorityReceipt(
  drafts: readonly FinalizedDraftExportSnapshot[],
): FinalizedDraftExportAuthorityReceipt {
  return drafts.map(({
    draftId,
    chapterNumber,
    version,
    finalizationId,
    contentHash,
  }) => ({ draftId, chapterNumber, version, finalizationId, contentHash }))
}

function renderMarkdownChapter(
  chapterNumber: number,
  title: string,
  content: string,
  writingLanguage: WritingLanguage,
): string {
  const chapterTitle = writingLanguage === 'en-US'
    ? `Chapter ${chapterNumber}${title ? ` ${title}` : ''}`
    : `第${chapterNumber}章${title ? ` ${title}` : ''}`
  const heading = `# ${chapterTitle}`
  const firstLineEnd = content.indexOf('\n')
  const firstLine = content
    .slice(0, firstLineEnd === -1 ? content.length : firstLineEnd)
    .replace(/\r$/u, '')
  const firstAtxHeading = firstLine.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u)

  if (firstAtxHeading?.[1]?.trim() === chapterTitle) {
    return `${heading}${firstLineEnd === -1 ? '' : content.slice(firstLineEnd)}`
  }
  return `${heading}\n\n${content}`
}

/** 导出全书 */
export async function exportNovel(
  options: ExportOptions,
  project: ExportProjectSnapshot,
  projectSession: ProjectSessionContext,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const uiLocale = useLocaleStore.getState().locale
  const text = (zhCNText: string, enUSText: string) => uiLocale === 'en-US' ? enUSText : zhCNText
  const writtenSplitFiles: string[] = []
  let activeWritePath: string | undefined
  if (!isMatchingProjectSnapshot(project, projectSession) || !isProjectSessionCurrent(projectSession)) {
    return staleExportResult(uiLocale)
  }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', text(
    `开始导出（${formatLabel(options.format, uiLocale)}）...`,
    `Starting export (${formatLabel(options.format, uiLocale)})...`,
  ), uiLocale)

  try {
    const frozenDrafts = requireFinalizedExportSnapshot(await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-export-snapshot',
      projectSession.projectPath,
    ))
    const authorityReceipt = exportAuthorityReceipt(frozenDrafts)
    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    const chapterContents = frozenDrafts.map(draft => ({
      chapterNumber: draft.chapterNumber,
      title: draft.title.trim(),
      name: `chapter_${draft.chapterNumber}.md`,
      content: draft.content,
      markdownContent: renderMarkdownChapter(
        draft.chapterNumber,
        draft.title.trim(),
        draft.content,
        project.novelConfig.writingLanguage,
      ),
    }))

    if (chapterContents.length === 0) {
      return {
        success: false,
        error: text('无可导出的章节（无定稿章节）', 'There are no finalized chapters to export.'),
      }
    }

    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('info', text(
      `找到 ${chapterContents.length} 个已定稿章节`,
      `Found ${chapterContents.length} finalized chapters.`,
    ), uiLocale)

    let outputPath = ''
    const projectFileStem = exportFileStem(project.name)

    switch (options.format) {
      case 'merged-md': {
        // 合并为单个 Markdown
        let content = `# ${project.name}\n\n`
        content += `> ${project.novelConfig.genre} · ${project.novelConfig.targetAudience}\n\n---\n\n`

        // 可选：包含大纲
        if (options.includeOutline) {
          const core = await ipc.invokeWithProjectSession(
            projectSession,
            'db:project-core-get',
            projectSession.projectPath,
          )
          if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
          if (core?.synopsis) {
            content += core.synopsis + '\n\n---\n\n'
          }
        }

        // 章节内容
        for (const ch of chapterContents) {
          content += ch.markdownContent + '\n\n---\n\n'
        }

        outputPath = `${projectFileStem}.md`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        activeWritePath = outputPath
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        requireExportWriteSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        activeWritePath = undefined
        if (!isProjectSessionCurrent(projectSession)) {
          return staleCommittedSingleExportResult(uiLocale, outputPath)
        }
        break
      }

      case 'split-md': {
        // 每章一个 Markdown
        const splitDir = `${projectFileStem}-${randomUUID()}`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        const mkdirResult = await ipc.invoke('fs:grant-mkdir', options.grantId, splitDir)
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        requireIpcSuccess(
          mkdirResult,
          text('创建导出目录', 'Create export directory'),
          text('创建导出目录失败', 'Failed to create the export directory.'),
        )

        for (const ch of chapterContents) {
          const stillCurrent = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-export-authority-current',
            authorityReceipt,
            projectSession.projectPath,
          )
          if (!isProjectSessionCurrent(projectSession)) {
            return staleSplitExportResult(uiLocale, writtenSplitFiles)
          }
          if (!stillCurrent) return changedFinalizationResult(uiLocale, writtenSplitFiles)
          activeWritePath = `${splitDir}/${ch.name}`
          const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, activeWritePath, ch.markdownContent)
          requireExportWriteSuccess(
            writeResult,
            text(`导出章节 ${ch.name}`, `Export chapter ${ch.name}`),
            text(`导出章节 ${ch.name} 失败`, `Failed to export chapter ${ch.name}.`),
          )
          writtenSplitFiles.push(activeWritePath)
          activeWritePath = undefined
          if (!isProjectSessionCurrent(projectSession)) {
            return staleSplitExportResult(uiLocale, writtenSplitFiles)
          }
        }

        outputPath = splitDir
        break
      }

      case 'txt': {
        // 纯文本（去除 Markdown 格式）
        let content = `${project.name}\n${'='.repeat(project.name.length * 2)}\n\n`

        for (const ch of chapterContents) {
          const chapterHeading = project.novelConfig.writingLanguage === 'en-US'
            ? `Chapter ${ch.chapterNumber}${ch.title ? ` ${ch.title}` : ''}`
            : `第${ch.chapterNumber}章${ch.title ? ` ${ch.title}` : ''}`
          // 简单去除 Markdown 标记
          const plainText = ch.content
            .replace(/^#{1,6}\s+/gm, '')  // 去掉标题标记
            .replace(/\*\*(.*?)\*\*/g, '$1')  // 去掉加粗
            .replace(/\*(.*?)\*/g, '$1')  // 去掉斜体
            .replace(/`(.*?)`/g, '$1')  // 去掉代码标记
            .replace(/---+/g, '\n')  // 分隔线
            .trim()

          content += `${chapterHeading}\n\n${plainText}\n\n`
        }

        outputPath = `${projectFileStem}.txt`
        const authorityCurrent = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-export-authority-current',
          authorityReceipt,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (!authorityCurrent) return changedFinalizationResult(uiLocale)
        activeWritePath = outputPath
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        requireExportWriteSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        activeWritePath = undefined
        if (!isProjectSessionCurrent(projectSession)) {
          return staleCommittedSingleExportResult(uiLocale, outputPath)
        }
        break
      }
    }

    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('info', text(`导出完成: ${outputPath}`, `Export complete: ${outputPath}`), uiLocale)
    return { success: true, path: outputPath }
  } catch (error) {
    const commitState = activeWritePath
      ? exportWriteFailureCommitState(error)
      : undefined
    const possiblyWritten = activeWritePath && commitState === 'unknown'
      ? [activeWritePath]
      : []
    const definitelyFailed = activeWritePath && commitState === 'not_committed'
      ? activeWritePath
      : undefined
    if (!isProjectSessionCurrent(projectSession)) {
      if (options.format === 'split-md' && (writtenSplitFiles.length > 0 || activeWritePath)) {
        return staleSplitExportResult(
          uiLocale,
          writtenSplitFiles,
          possiblyWritten,
          definitelyFailed,
        )
      }
      const stale = staleExportResult(uiLocale)
      return activeWritePath && commitState === 'unknown'
        ? { ...stale, error: `${stale.error}${unknownSingleWriteDetail(uiLocale, activeWritePath)}` }
        : stale
    }
    const partialWriteDetail = options.format === 'split-md' && (writtenSplitFiles.length > 0 || activeWritePath)
      ? splitWriteDetail(uiLocale, writtenSplitFiles, possiblyWritten, definitelyFailed)
      : activeWritePath && commitState === 'unknown'
        ? unknownSingleWriteDetail(uiLocale, activeWritePath)
        : ''
    const errorMessage = `${String(error)}${partialWriteDetail}`
    addLog('error', text(`导出失败: ${errorMessage}`, `Export failed: ${errorMessage}`), uiLocale)
    return { success: false, error: errorMessage }
  }
}

/** Windows 与 POSIX 都安全的导出相对路径段，禁止项目名改变授权目录边界。 */
function exportFileStem(name: string): string {
  const normalized = Array.from(name, (character) => (
    character.charCodeAt(0) < 32 ? '_' : character
  )).join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return normalized || 'novel'
}

function formatLabel(format: ExportFormat, locale: Locale): string {
  const labels: Record<ExportFormat, readonly [string, string]> = {
    'merged-md': ['合并 Markdown', 'Merged Markdown'],
    'split-md': ['分章 Markdown', 'Split Markdown'],
    'txt': ['纯文本 TXT', 'Plain text (TXT)'],
  }
  return labels[format][locale === 'en-US' ? 1 : 0]
}
