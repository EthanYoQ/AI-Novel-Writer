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
import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  getActiveProjectSessionContext,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type { WritingLanguage } from '../shared/writing-language'


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

/** 导出全书 */
export async function exportNovel(
  options: ExportOptions,
  project: ExportProjectSnapshot,
  projectSession: ProjectSessionContext,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const uiLocale = useLocaleStore.getState().locale
  const text = (zhCNText: string, enUSText: string) => uiLocale === 'en-US' ? enUSText : zhCNText
  if (!isMatchingProjectSnapshot(project, projectSession) || !isProjectSessionCurrent(projectSession)) {
    return staleExportResult(uiLocale)
  }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', text(
    `开始导出（${formatLabel(options.format, uiLocale)}）...`,
    `Starting export (${formatLabel(options.format, uiLocale)})...`,
  ), uiLocale)

  try {
    // 遍历所有章节蓝图，取定稿内容
    const chapterContents: Array<{ chapterNumber: number; title: string; name: string; content: string }> = []
    const blueprints = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-get-all',
      projectSession.projectPath,
    ) as unknown as Array<Record<string, unknown>>
    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    const sortedBps = blueprints ? blueprints.sort((a, b) => (a.chapterNumber as number) - (b.chapterNumber as number)) : []

    for (const bp of sortedBps) {
      const meta = await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-get-finalized',
        bp.chapterNumber as number,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
      if (meta && (meta as { id: number }).id !== undefined) {
        const full = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-full',
          (meta as { id: number }).id,
          projectSession.projectPath,
        )
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        if (full && (full as { content?: string }).content) {
          chapterContents.push({
            chapterNumber: bp.chapterNumber as number,
            title: typeof bp.title === 'string' ? bp.title.trim() : '',
            name: `chapter_${bp.chapterNumber}.md`,
            content: (full as { content: string }).content,
          })
        }
      }
    }

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
          content += ch.content + '\n\n---\n\n'
        }

        outputPath = `${projectFileStem}.md`
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        requireIpcSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        break
      }

      case 'split-md': {
        // 每章一个 Markdown
        const splitDir = projectFileStem
        const mkdirResult = await ipc.invoke('fs:grant-mkdir', options.grantId, splitDir)
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        requireIpcSuccess(
          mkdirResult,
          text('创建导出目录', 'Create export directory'),
          text('创建导出目录失败', 'Failed to create the export directory.'),
        )

        for (const ch of chapterContents) {
          const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, `${splitDir}/${ch.name}`, ch.content)
          if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
          requireIpcSuccess(
            writeResult,
            text(`导出章节 ${ch.name}`, `Export chapter ${ch.name}`),
            text(`导出章节 ${ch.name} 失败`, `Failed to export chapter ${ch.name}.`),
          )
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
        const writeResult = await ipc.invoke('fs:grant-write-file', options.grantId, outputPath, content)
        if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
        requireIpcSuccess(
          writeResult,
          text('写入导出文件', 'Write export file'),
          text('写入导出文件失败', 'Failed to write the exported file.'),
        )
        break
      }
    }

    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('info', text(`导出完成: ${outputPath}`, `Export complete: ${outputPath}`), uiLocale)
    return { success: true, path: outputPath }
  } catch (error) {
    if (!isProjectSessionCurrent(projectSession)) return staleExportResult(uiLocale)
    addLog('error', text(`导出失败: ${error}`, `Export failed: ${error}`), uiLocale)
    return { success: false, error: String(error) }
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
