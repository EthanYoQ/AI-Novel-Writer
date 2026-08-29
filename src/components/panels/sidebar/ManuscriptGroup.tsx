/**
 * ManuscriptGroup — 正文章节折叠组（已定稿章节列表）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, ChevronDown, FileText, FolderOpen, Copy, PenTool, RotateCcw, Trash2 } from 'lucide-react'
import type { FileNode, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ChapterDeletionOperation } from '../../../shared/chapter-deletion'
import { ipc } from '../../../services/ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import { globalEventBus } from '../../../shared/event-bus'
import { useLocaleStore } from '../../../stores/locale-store'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'

import { openChapterFile } from './sidebar-file-openers'
import { showSidebarMenu } from './sidebar-menu'
import { chapterTitleCache, chapterTitleCacheKey } from './manuscript-title-cache'
import {
  confirmLegacyKnowledgeAbsentAndContinue,
  deleteFinalizedChapter,
} from './finalized-chapter-deletion'

type ManuscriptFileNode = FileNode & { chapterTitle?: string }

/**
 * 已定稿 metadata 优先；旧定稿再 fallback 到蓝图和文件首行。
 *
 * @param filePath    manuscript 文件路径
 * @param fallback    兜底显示名（如 "第1章"）
 * @param chapterNumber 章节号（用于定位蓝图文件）
 */
async function readChapterTitle(
  filePath: string,
  fallback: string,
  projectSession: ProjectSessionContext,
  chapterNumber?: number,
  authoritativeTitle?: string,
): Promise<string | null> {
  if (!isProjectSessionCurrent(projectSession)) return null
  const cacheKey = chapterTitleCacheKey(projectSession.projectPath, filePath)
  if (chapterNumber && authoritativeTitle?.trim()) {
    const prefix = `第${chapterNumber}章`
    const title = authoritativeTitle.trim().startsWith(prefix)
      ? authoritativeTitle.trim().slice(prefix.length).trim()
      : authoritativeTitle.trim()
    const display = title ? `${fallback} ${title}` : fallback
    chapterTitleCache.set(cacheKey, display)
    return display
  }
  if (chapterTitleCache.has(cacheKey)) return chapterTitleCache.get(cacheKey)!

  // 旧定稿没有 outbox 标题时，沿用蓝图 fallback。
  if (chapterNumber) {
    try {
      const bpResult = await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-get',
        chapterNumber,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return null
      if (bpResult) {
        const display = `第${chapterNumber}章 ${bpResult.title}`
        chapterTitleCache.set(cacheKey, display)
        return display
      }
    } catch { /* 蓝图读取失败时 fallback 到文件首行 */ }
  }

  // fallback: 读取正文首行
  let fileContent = ''
  if (filePath.startsWith('vela://')) {
    const { readVelaContent } = await import('../../../services/vela-protocol')
    fileContent = await readVelaContent(filePath, projectSession)
  } else {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-file',
      filePath,
      projectSession.projectPath,
    )
    if (result.success) fileContent = result.content
  }

  if (!isProjectSessionCurrent(projectSession)) return null

  if (!fileContent) return fallback
  const firstLine = fileContent.split('\n').find((l: string) => l.trim())
  if (!firstLine) return fallback
  const title = firstLine.replace(/^#+\s*/, '').trim()
  const display = title || fallback
  chapterTitleCache.set(cacheKey, display)
  return display
}

// ===== 正文章节组件 =====

export default function ManuscriptGroup({ files, projectPath }: { files: ManuscriptFileNode[]; projectPath: string }) {
  const [open, setOpen] = useState(true)
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  const [deletionState, setDeletionState] = useState<{
    projectPath: string
    operations: ChapterDeletionOperation[]
  }>({ projectPath: '', operations: [] })
  const incompleteDeletions = deletionState.projectPath === projectPath
    ? deletionState.operations
    : []
  const deletionLoadSequence = useRef(0)
  // 文件路径 → 显示名称的映射（异步加载）
  const [titleMap, setTitleMap] = useState<Record<string, string>>({})

  // 每次 files 变化时异步读取各文件标题（命中缓存的路径直接跳过 IPC）
  const filesDep = files.map(f => `${f.path}\u0000${f.chapterTitle ?? ''}`).join(',')
  useEffect(() => {
    if (files.length === 0) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectPath)) return
    let cancelled = false
    const load = async () => {
      // 只读取当前 state 中还没有的路径（增量更新，避免重复 IPC 调用）
      const missing = files.filter(f => (
        !f.name.includes('_notes')
        && !titleMap[chapterTitleCacheKey(projectPath, f.path)]
      ))
      if (missing.length === 0) return
      const entries: Record<string, string> = {}
      await Promise.all(
        missing.map(async (f) => {
          const rawName = f.name.replace(/\.[^.]+$/, '')
          const chMatch = rawName.match(/^chapter_(\d+)$/)
          const fallback = chMatch ? text(`第${parseInt(chMatch[1], 10)}章`, `Chapter ${parseInt(chMatch[1], 10)}`) : rawName
          const chNum = chMatch ? parseInt(chMatch[1], 10) : undefined
          try {
            const title = await readChapterTitle(f.path, fallback, projectSession, chNum, f.chapterTitle)
            if (title !== null) entries[chapterTitleCacheKey(projectPath, f.path)] = title
          } catch {
            // 读取失败时保留界面上的兜底名称；不把失败当成空正文或缓存结果。
          }
        })
      )
      if (!cancelled && isProjectSessionCurrent(projectSession)) {
        setTitleMap(prev => ({ ...prev, ...entries }))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [files, filesDep, projectPath, titleMap, text, currentProject])

  const getDisplay = (f: ManuscriptFileNode) => {
    const rawName = f.name.replace(/\.[^.]+$/, '')
    const chMatch = rawName.match(/^chapter_(\d+)$/)
    const chapterNumber = chMatch ? parseInt(chMatch[1], 10) : undefined
    const fallback = chapterNumber
      ? text(`第${chapterNumber}章`, `Chapter ${chapterNumber}`)
      : rawName
    if (chapterNumber && f.chapterTitle?.trim()) {
      const prefix = `第${chapterNumber}章`
      const title = f.chapterTitle.trim().startsWith(prefix)
        ? f.chapterTitle.trim().slice(prefix.length).trim()
        : f.chapterTitle.trim()
      return title ? `${fallback} ${title}` : fallback
    }
    return titleMap[chapterTitleCacheKey(projectPath, f.path)] ?? fallback
  }

  // 只显示正文章节（过滤掉旧的 _notes 文件）
  const chapterFiles = files.filter(f => !f.name.includes('_notes'))

  const fetchIncompleteDeletions = useCallback(async (projectSession: ProjectSessionContext) => {
    const requestId = ++deletionLoadSequence.current
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'chapter:list-incomplete-deletions',
      projectPath,
    )
    if (
      requestId !== deletionLoadSequence.current
      || !isProjectSessionCurrent(projectSession)
    ) return null
    return result.success ? result.operations ?? [] : []
  }, [projectPath])

  const loadIncompleteDeletions = useCallback(async (projectSession: ProjectSessionContext) => {
    const operations = await fetchIncompleteDeletions(projectSession)
    if (operations === null) return
    setDeletionState({
      projectPath,
      operations,
    })
  }, [fetchIncompleteDeletions, projectPath])

  useEffect(() => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectPath)) return
    void fetchIncompleteDeletions(projectSession).then(operations => {
      if (operations === null) return
      setDeletionState({ projectPath, operations })
    })
  }, [currentProject, fetchIncompleteDeletions, projectPath])

  useEffect(() => globalEventBus.on('CHAPTER_DELETION_UPDATED', payload => {
    if (
      !isProjectSessionPath(payload.projectSession, projectPath)
      || !isProjectSessionCurrent(payload.projectSession)
    ) return
    void loadIncompleteDeletions(payload.projectSession)
  }), [loadIncompleteDeletions, projectPath])

  const deleteManuscriptChapter = async (
    filePath: string,
    displayName: string,
    chapterNumber: number | undefined,
  ) => {
    const match = filePath.match(/^vela:\/\/manuscript\/(\d+)$/)
    if (!match || chapterNumber === undefined) {
      toast.error(text('当前章节路径不支持直接删除', 'This chapter path cannot be deleted directly.'))
      return
    }
    await deleteFinalizedChapter({
      project: currentProject,
      projectPath,
      draftId: Number(match[1]),
      chapterNumber,
      displayName,
      tabFilePath: filePath,
      surface: 'manuscript',
    })
  }

  const retryDeletion = async (operation: ChapterDeletionOperation) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectPath)) return
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'chapter:retry-deletion',
      operation.operationId,
      projectPath,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    await loadIncompleteDeletions(projectSession)
    if (result.success) {
      globalEventBus.emit('REFRESH_RESOURCE', {
        resources: ['drafts', 'fileTree'],
        projectPath,
        projectSession,
      })
      toast.success(text(`第${operation.chapterNumber}章派生投影清理完成`, `Chapter ${operation.chapterNumber} projection cleanup completed.`))
    } else {
      toast.error(text(
        `重试清理失败\n\n${result.error ?? '未知错误'}`,
        `Cleanup retry failed\n\n${result.error ?? 'Unknown error'}`,
      ))
    }
  }

  const confirmLegacyDeletion = async (operation: ChapterDeletionOperation) => {
    const displayName = operation.chapterTitle
      ? text(`第${operation.chapterNumber}章 ${operation.chapterTitle}`, `Chapter ${operation.chapterNumber} ${operation.chapterTitle}`)
      : text(`第${operation.chapterNumber}章`, `Chapter ${operation.chapterNumber}`)
    await confirmLegacyKnowledgeAbsentAndContinue({
      project: currentProject,
      projectPath,
      draftId: operation.draftId,
      chapterNumber: operation.chapterNumber,
      displayName,
      tabFilePath: `vela://manuscript/${operation.draftId}`,
      surface: 'manuscript',
    }, operation.operationId)
  }

  return (
    <div>
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <PenTool size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('正文章节', 'Manuscript chapters')}</span>
        {chapterFiles.length > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`${chapterFiles.length} 章`, `${chapterFiles.length} chapters`)}
          </span>
        )}
      </div>
      {open && (
        <div>
          {incompleteDeletions.map(operation => {
            const requiresLegacyConfirmation = operation.legacyKnowledgeAuthorization === 'required'
            const details = [
              operation.manuscriptStatus === 'failed' ? operation.manuscriptError : '',
              operation.knowledgeStatus === 'failed' ? operation.knowledgeError : '',
              requiresLegacyConfirmation
                ? text('旧定稿缺少可验证的知识文档身份，需要人工核对', 'Legacy finalization needs manual knowledge-projection verification')
                : '',
            ].filter(Boolean).join('；')
            return (
              <div
                key={operation.operationId}
                className="flex items-center gap-1.5 py-1 pr-2"
                style={{ paddingLeft: 30, color: 'var(--color-warning)' }}
                title={details}
              >
                <AlertTriangle size={11} style={{ flexShrink: 0 }} />
                <span className="text-xs flex-1 truncate">
                  {requiresLegacyConfirmation
                    ? text(`第${operation.chapterNumber}章待人工确认知识投影`, `Chapter ${operation.chapterNumber} awaits knowledge-projection confirmation`)
                    : text(`第${operation.chapterNumber}章清理${operation.status === 'failed' ? '失败' : '待完成'}`, `Chapter ${operation.chapterNumber} cleanup ${operation.status === 'failed' ? 'failed' : 'pending'}`)}
                </span>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7rem] hover:bg-[var(--color-hover)]"
                  title={requiresLegacyConfirmation
                    ? text('确认人工核对并继续', 'Confirm manual review and continue')
                    : text('重试清理', 'Retry cleanup')}
                  onClick={() => void (requiresLegacyConfirmation
                    ? confirmLegacyDeletion(operation)
                    : retryDeletion(operation))}
                >
                  <RotateCcw size={10} />
                  {requiresLegacyConfirmation
                    ? text('确认人工核对并继续', 'Confirm and continue')
                    : text('重试清理', 'Retry cleanup')}
                </button>
              </div>
            )
          })}
          {chapterFiles.length === 0 ? (
            <div className="text-xs py-1" style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}>
              {text('暂无定稿章节', 'No finalized chapters')}
            </div>
          ) : (
            chapterFiles.map(f => {
              const displayName = getDisplay(f)
              const chapterMatch = f.name.replace(/\.[^.]+$/, '').match(/^chapter_(\d+)$/)
              const chapterNumber = chapterMatch ? Number(chapterMatch[1]) : undefined
              return (
                <div
                  key={f.path}
                  className="tree-item gap-1.5 cursor-pointer"
                  style={{ paddingLeft: 30 }}
                  onClick={() => openChapterFile(f.path, displayName)}
                  onContextMenu={e => showSidebarMenu([
                    {
                      key: 'open',
                      label: text('打开章节', 'Open chapter'),
                      icon: <FolderOpen size={13} />,
                      onClick: () => openChapterFile(f.path, displayName),
                    },
                    { key: 'div1', type: 'divider' as const },
                    {
                      key: 'copy-path',
                      label: text('复制文件路径', 'Copy file path'),
                      icon: <Copy size={13} />,
                      onClick: () => navigator.clipboard.writeText(f.path).catch(() => { }),
                    },
                    { key: 'div2', type: 'divider' as const },
                    {
                      key: 'delete',
                      label: text('删除正文', 'Delete manuscript'),
                      icon: <Trash2 size={13} />,
                      danger: true,
                      onClick: () => deleteManuscriptChapter(f.path, displayName, chapterNumber),
                    },
                  ], e)}
                  title={text(`点击打开 — ${displayName}`, `Open — ${displayName}`)}
                >
                  <FileText size={11} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                  <span className="text-sm truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
                    {displayName}
                  </span>
                  <button
                    type="button"
                    className="opacity-70 hover:opacity-100 rounded p-0.5"
                    title={text('删除正文', 'Delete manuscript')}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteManuscriptChapter(f.path, displayName, chapterNumber)
                    }}
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
