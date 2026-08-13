import { useState, useEffect, useCallback } from 'react'
import { History, RotateCcw, ArrowLeftRight, RefreshCw } from 'lucide-react'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { Button } from '../ui/Button'
import { cn } from '../../lib/utils'
import type { VersionRecord } from '../../services/version-service'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

/** 章节元数据 */
interface ChapterMeta {
  id: string
  chapter_number: number
  title: string
  status: string
}

/** 版本历史面板 — 查看章节版本并与当前内容对比 */
export default function VersionHistory({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [selectedChapter, setSelectedChapter] = useState<string | null>(null)
  const [versions, setVersions] = useState<VersionRecord[]>([])
  const [loading, setLoading] = useState(true)

  const loadChapters = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setLoading(true)
    try {
      const blueprints = await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-get-all',
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      setChapters(blueprints.map(c => ({
        id: String(c.chapterNumber),
        chapter_number: c.chapterNumber,
        title: c.title || `第 ${c.chapterNumber} 章`,
        status: 'draft',
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setChapters([])
    } finally {
      if (isProjectSessionCurrent(projectSession)) setLoading(false)
    }
  }, [currentProject, projectKey])

  // 加载章节列表
  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) loadChapters() })
    return () => { mounted = false }
  }, [currentProject, loadChapters])

  // 加载版本列表
  const loadVersions = useCallback(async (chapterId: string) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      const chapterNumber = Number.parseInt(chapterId, 10)
      if (!Number.isFinite(chapterNumber)) return
      const drafts = await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-list',
        chapterNumber,
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      setVersions(drafts.map(draft => ({
        id: draft.id,
        version: draft.version,
        type: draft.status === 'finalized' ? 'final' : (draft.status === 'revised' ? 'refined' : 'draft'),
        word_count: draft.wordCount || 0,
        created_at: draft.createdAt,
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setVersions([])
    }
  }, [projectKey])

  useEffect(() => {
    if (!selectedChapter) return
    let mounted = true
    Promise.resolve().then(() => { if (mounted) loadVersions(selectedChapter) })
    return () => { mounted = false }
  }, [loadVersions, selectedChapter])

  /** 查看版本内容（Diff 对比） */
  const handleDiff = async (versionId: number, versionLabel: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || !selectedChapter) return
    const chapter = chapters.find((candidate) => candidate.id === selectedChapter)
    if (!chapter) return

    const oldContent = (await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-full',
      versionId,
      projectSession.projectPath,
    ))?.content
    if (!isProjectSessionCurrent(projectSession)) return
    if (!oldContent) return

    // 获取最新草稿内容进行比对
    const latestDraft = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-latest',
      chapter.chapter_number,
      projectSession.projectPath,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    const latestContent = latestDraft?.id === undefined
      ? null
      : await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-full',
          latestDraft.id,
          projectSession.projectPath,
        )
    if (!isProjectSessionCurrent(projectSession)) return
    const currentContent = latestDraft?.id === undefined
      ? '（章节尚无内容）'
      : (latestContent?.content || '（内容被错误截断）')

    useEditorStore.getState().openFile({
      id: `diff-version-${versionId}`,
      name: `${versionLabel} vs 当前`,
      type: 'diff',
      originalContent: oldContent,
      content: currentContent,
      filePath: `vela://draft/ch${chapter.chapter_number}`, // 不再指向实体文件
      projectKey,
    })
  }

  /** 回退到历史版本 */
  const handleRevert = async (versionId: number) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || !selectedChapter) return
    const chapter = chapters.find((candidate) => candidate.id === selectedChapter)
    if (!chapter) return

    const content = (await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-full',
      versionId,
      projectSession.projectPath,
    ))?.content
    if (!isProjectSessionCurrent(projectSession)) return
    if (!content) return

    const nextVersion = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-next-version',
      chapter.chapter_number,
      projectSession.projectPath,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    requireIpcSuccess(await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-create',
      {
        chapterNumber: chapter.chapter_number,
        version: nextVersion,
        source: 'rewrite',
        content,
        wordCount: content.length,
      },
      projectSession.projectPath,
    ), '创建回滚草稿')
    if (!isProjectSessionCurrent(projectSession)) return

    // 重新加载版本列表以显示新生成的回滚草稿
    await loadVersions(selectedChapter)
  }

  const TYPE_LABELS: Record<string, string> = {
    draft: '草稿', refined: '修稿', reviewed: '审稿', final: '终稿',
  }

  const TYPE_COLORS: Record<string, string> = {
    draft: 'bg-blue-500/20 text-[var(--color-category-progress-text)]',
    refined: 'bg-yellow-500/20 text-[var(--color-warning-text)]',
    reviewed: 'bg-purple-500/20 text-[var(--color-category-review-text)]',
    final: 'bg-green-500/20 text-[var(--color-success-text)]',
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-[var(--color-text-muted)]">
        <RefreshCw size={16} className="animate-spin" /> 加载中...
      </div>
    )
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* 左侧章节列表 */}
      <div className="flex flex-col flex-shrink-0 w-[200px] border-r border-[var(--color-border)] bg-[var(--color-sidebar)]">
        <div className="flex items-center px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
          <span className="text-xs font-medium text-[var(--color-text)]">
            <History size={13} className="inline mr-1" />
            章节列表
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {chapters.length === 0 ? (
            <div className="text-center text-xs text-[var(--color-text-muted)] py-4">
              暂无章节数据
            </div>
          ) : (
            chapters.map((ch) => (
              <div
                key={ch.id}
                className={cn(
                  'px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-0.5 transition-colors',
                  selectedChapter === ch.id
                    ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                )}
                onClick={() => setSelectedChapter(ch.id)}
              >
                <span className="font-mono text-[0.7rem] opacity-50 mr-1">
                  {ch.chapter_number}
                </span>
                {ch.title || '未命名'}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 右侧版本列表 */}
      <div className="flex-1 overflow-y-auto">
        {selectedChapter ? (
          <div className="max-w-xl mx-auto px-6 py-4">
            <h3 className="text-sm font-bold text-[var(--color-text)] mb-3">
              版本历史
            </h3>
            {versions.length === 0 ? (
              <div className="text-center text-xs text-[var(--color-text-muted)] py-8">
                暂无版本记录
              </div>
            ) : (
              <div className="space-y-2">
                {versions.map((ver) => (
                  <div
                    key={ver.id}
                    className="flex items-center justify-between px-3 py-2.5 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-hover)] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-[0.7rem] px-1.5 py-0.5 rounded font-medium',
                        TYPE_COLORS[ver.type] || 'bg-[var(--color-hover)]'
                      )}>
                        {TYPE_LABELS[ver.type] || ver.type}
                      </span>
                      <span className="text-xs text-[var(--color-text)]">
                        v{ver.version}
                      </span>
                      <span className="text-[0.7rem] text-[var(--color-text-muted)]">
                        {ver.word_count} 字
                      </span>
                      <span className="text-[0.7rem] text-[var(--color-text-muted)]">
                        {new Date(ver.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline" size="sm"
                        onClick={() => handleDiff(ver.id, `v${ver.version} ${TYPE_LABELS[ver.type] || ''}`)}
                        title="与当前版本对比"
                      >
                        <ArrowLeftRight size={12} /> 对比
                      </Button>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => handleRevert(ver.id)}
                        title="回退到此版本"
                      >
                        <RotateCcw size={12} /> 回退
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 opacity-30">
            <History size={36} />
            <span className="text-sm">选择一个章节</span>
          </div>
        )}
      </div>
    </div>
  )
}
