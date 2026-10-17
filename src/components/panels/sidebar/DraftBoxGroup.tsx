/**
 * DraftBoxGroup — 草稿箱折叠组（含章节分组和单条草稿条目）
 */

import { useState, useEffect } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, Circle, FileText, FolderOpen, Copy, Trash2, FilePen, Plus } from 'lucide-react'
import type { DraftMeta } from '../../../stores/draft-store'
import { openDraftTab } from '../../../stores/open-draft-tab'
import { useEditorStore } from '../../../stores/editor-store'
import { confirm } from '../../ui/Confirm'
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../../shared/draft-status'
import { showSidebarMenu } from './sidebar-menu'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'
import { deleteFinalizedChapter } from './finalized-chapter-deletion'
import { deleteDraftVersion } from './draft-deletion'
import { pluralEn } from '../../../shared/plural-en'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { toast } from '../../ui/Toast'
import { countDraftUnits } from '../../../shared/draft-units'

const DRAFT_STATUS_EN: Record<string, string> = {
  draft: 'Draft', revising: 'Revising', reviewed: 'Reviewed', finalized: 'Finalized', archived: 'Archived',
}

// ===== 草稿箱折叠组 =====

export default function DraftBoxGroup({
  draftsByChapter,
  onRefresh,
}: {
  draftsByChapter: Record<number, DraftMeta[]>
  onRefresh?: () => void
}) {
  const [open, setOpen] = useState(true)
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  const [newChapterNumber, setNewChapterNumber] = useState('')
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const text = useLocaleStore(s => s.text)
  const projectKey = useProjectStore(s => s.currentProject?.path)
  const currentProject = useProjectStore(s => s.currentProject)
  if (!projectKey) return null

  // 所有章节号排序
  const chapterNums = Object.keys(draftsByChapter)
    .map(Number)
    .sort((a, b) => a - b)

  // 筛选出包含非保留（活跃）草稿的实际章节数
  const activeChapterCount = chapterNums.filter(n =>
    (draftsByChapter[n] || []).some(d => d.status !== 'archived')
  ).length

  const handleCreateDraft = async () => {
    const chapterNum = Number(newChapterNumber)
    if (!Number.isInteger(chapterNum) || chapterNum < 1) {
      toast.error(text('请输入有效的章节号（正整数）', 'Enter a valid chapter number (positive integer)'))
      return
    }
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    setCreating(true)
    try {
      const versionResult = await ipc.invokeWithProjectSession(projectSession, 'db:draft-next-version', chapterNum, projectKey)
      const version = typeof versionResult === 'number' ? versionResult : 1
      const wordCount = countDraftUnits(newContent)
      const result = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
        chapterNumber: chapterNum,
        version,
        source: 'write',
        content: newContent,
        wordCount,
      }, projectKey)
      if (!result.success) {
        toast.error(text(`创建草稿失败：${result.error}`, `Failed to create draft: ${result.error}`))
        return
      }
      toast.success(text('草稿已创建', 'Draft created'))
      setNewDraftOpen(false)
      setNewChapterNumber('')
      setNewContent('')
      onRefresh?.()
    } catch (error) {
      toast.error(text(`创建草稿失败：${String(error)}`, `Failed to create draft: ${String(error)}`))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      {/* 草稿箱标题行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        title={text('草稿箱：AI 生成后的章节草稿在此管理，定稿后进入正文章节', 'Draft box: manage AI-generated drafts here. Finalized drafts move to the manuscript.')}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <FilePen size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('草稿箱', 'Draft box')}</span>
        {activeChapterCount > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`${activeChapterCount} 章`, `${activeChapterCount} ${pluralEn(activeChapterCount, 'chapter')}`)}
          </span>
        )}
        <button
          type="button"
          className="ml-1 opacity-60 hover:opacity-100 rounded p-0.5"
          title={text('新建草稿', 'New draft')}
          onClick={(e) => {
            e.stopPropagation()
            setNewDraftOpen(true)
          }}
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus size={13} />
        </button>
      </div>

      {open && (
        <div>
          {chapterNums.length === 0 ? (
            <div
              className="text-xs py-1"
              style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}
            >
              {text('暂无草稿（点击右上角 + 手动新建，或从章节蓝图点击「写作此章」创作）', 'No drafts yet. Click + to create one manually, or use "Write chapter" from a blueprint.')}
            </div>
          ) : (
            chapterNums.map(chNum => (
              <DraftChapterGroup
                key={chNum}
                chapterNumber={chNum}
                drafts={draftsByChapter[chNum] || []}
                projectKey={projectKey}
              />
            ))
          )}
        </div>
      )}

      {/* 新建草稿弹窗 */}
      <Dialog open={newDraftOpen} onOpenChange={setNewDraftOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{text('新建草稿', 'New draft')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-1">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {text('章节号', 'Chapter number')}
              </label>
              <input
                type="number"
                min={1}
                value={newChapterNumber}
                onChange={e => setNewChapterNumber(e.target.value)}
                placeholder={text('例如：1', 'e.g. 1')}
                className="w-full rounded-md border px-3 py-1.5 text-sm"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'var(--surface)',
                  color: 'var(--color-text)',
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {text('正文内容', 'Content')}
              </label>
              <textarea
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                placeholder={text('在此输入章节正文…', 'Enter the chapter content here…')}
                rows={10}
                className="w-full rounded-md border px-3 py-2 text-sm resize-y"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'var(--surface)',
                  color: 'var(--color-text)',
                }}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setNewDraftOpen(false)}>
              {text('取消', 'Cancel')}
            </Button>
            <Button
              variant="default"
              onClick={handleCreateDraft}
              disabled={creating || !newChapterNumber.trim()}
            >
              {creating ? text('创建中…', 'Creating…') : text('创建', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ===== 单章草稿分组 =====

function DraftChapterGroup({
  chapterNumber,
  drafts,
  projectKey,
}: {
  chapterNumber: number
  drafts: DraftMeta[]
  projectKey: string
}) {
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  const [open, setOpen] = useState(true)

  // 将 archived 草稿折叠，只显示活跃草稿（非 archived）
  const activeDrafts = drafts.filter(d => d.status !== 'archived')
  const archivedDrafts = drafts.filter(d => d.status === 'archived')
  const [showArchived, setShowArchived] = useState(false)
  const [bpTitle, setBpTitle] = useState<{ projectKey: string; title: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', chapterNumber, projectKey).then(bp => {
      if (!cancelled && isProjectSessionCurrent(projectSession) && bp?.title) {
        setBpTitle({ projectKey, title: bp.title })
      }
    }).catch(() => { })
    return () => { cancelled = true }
  }, [chapterNumber, currentProject, projectKey])

  // 已定稿的草稿存在时，章节显示绿色标记
  const hasFinalized = drafts.some(d => d.status === 'finalized')
  const finalizedTitle = drafts.find(d => d.status === 'finalized' && d.chapterTitle?.trim())?.chapterTitle
  const scopedBlueprintTitle = bpTitle?.projectKey === projectKey ? bpTitle.title : ''
  const baseTitle = finalizedTitle || scopedBlueprintTitle || drafts[0]?.chapterTitle || ''
  const cleanTitle = baseTitle.startsWith(`第${chapterNumber}章`)
    ? baseTitle.replace(`第${chapterNumber}章`, '').trim()
    : baseTitle
  const displayTitle = text(
    cleanTitle ? `第${chapterNumber}章 ${cleanTitle}` : `第${chapterNumber}章`,
    cleanTitle ? `Chapter ${chapterNumber} ${cleanTitle}` : `Chapter ${chapterNumber}`
  )

  return (
    <div>
      {/* 章节行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 26 }}
        onClick={() => setOpen(v => !v)}
        title={displayTitle}
      >
        {open
          ? <ChevronDown size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        {hasFinalized
          ? <CheckCircle2 size={10} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
          : <Circle size={6} style={{ flexShrink: 0, fill: 'transparent', stroke: 'var(--color-text-muted)' }} />
        }
        <span className="text-sm flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
          {displayTitle}
        </span>
        <span className="ml-auto text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {text(`${activeDrafts.length} 稿`, `${activeDrafts.length} ${pluralEn(activeDrafts.length, 'draft')}`)}
        </span>
      </div>

      {/* 草稿列表 */}
      {open && (
        <div>
          {activeDrafts.map(draft => (
            <DraftItem
              key={draft.filePath}
              draft={draft}
              chapterTitleText={displayTitle}
              projectKey={projectKey}
            />
          ))}

          {/* 显示归档草稿的切换按钮 */}
          {archivedDrafts.length > 0 && (
            <div
              className="flex items-center gap-1 cursor-pointer select-none"
              style={{ paddingLeft: 54 }}
              onClick={() => setShowArchived(v => !v)}
            >
              <span className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                {showArchived ? <><ChevronDown size={10} className="inline" /> {text('隐藏', 'Hide')}</> : <><ChevronRight size={10} className="inline" /> {text(`${archivedDrafts.length} 个已归档`, `${archivedDrafts.length} archived`)}</>}
              </span>
            </div>
          )}
          {showArchived && archivedDrafts.map(draft => (
            <DraftItem
              key={draft.filePath}
              draft={draft}
              chapterTitleText={displayTitle}
              projectKey={projectKey}
              archived
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 单条草稿条目 =====

function DraftItem({
  draft,
  chapterTitleText,
  projectKey,
  archived = false,
}: {
  draft: DraftMeta
  chapterTitleText: string
  projectKey: string
  archived?: boolean
}) {
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  const statusLabel = text(DRAFT_STATUS_LABEL[draft.status] || draft.status, DRAFT_STATUS_EN[draft.status] || draft.status)
  /** 打开草稿到编辑器 */
  const openDraft = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    await openDraftTab(draft, `${chapterTitleText} v${draft.version}`, projectSession)
  }

  /** 删除草稿 */
  const deleteDraft = async () => {
    if (draft.status === 'finalized') {
      await deleteFinalizedChapter({
        project: currentProject,
        projectPath: projectKey,
        draftId: draft.id,
        chapterNumber: draft.chapterNumber,
        displayName: `${chapterTitleText} v${draft.version}`,
        tabFilePath: draft.filePath,
        surface: 'draft',
      })
      return
    }

    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const ok = await confirm(
      text(`确认删除 "${chapterTitleText} v${draft.version}"？\n此操作会删除该稿正文记录及关联的审稿/修稿产物，不可撤销。`, `Delete “${chapterTitleText} v${draft.version}”?\nThis permanently removes the draft and related review/revision artifacts.`),
      { title: text('删除这一稿', 'Delete draft'), confirmText: text('删除', 'Delete'), danger: true }
    )
    if (!ok || !isProjectSessionCurrent(projectSession)) return
    const displayName = `${chapterTitleText} v${draft.version}`
    if (!await deleteDraftVersion({ draft, displayName, projectKey, project: currentProject })) return
    const editor = useEditorStore.getState()
    const tab = editor.tabs.find(t =>
      t.projectKey === projectKey && (t.id === draft.filePath || t.filePath === draft.filePath)
    )
    if (tab) editor.closeTab(tab.id)
  }

  const isFinalized = draft.status === 'finalized'

  return (
    <div
      className="relative flex items-center gap-1.5 cursor-pointer hover:bg-[var(--color-hover)]"
      style={{
        paddingLeft: 50,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        opacity: archived ? 0.45 : 1,
      }}
      onClick={openDraft}
      onContextMenu={e => showSidebarMenu([
        {
          key: 'open',
          label: text('打开草稿', 'Open draft'),
          icon: <FolderOpen size={13} />,
          onClick: openDraft,
        },
        { key: 'div1', type: 'divider' as const },
        {
          key: 'copy-path',
          label: text('复制文件路径', 'Copy file path'),
          icon: <Copy size={13} />,
          onClick: () => navigator.clipboard.writeText(draft.filePath).catch(() => { }),
        },
        { key: 'div2', type: 'divider' as const },
        {
          key: 'delete',
          label: text('删除这一稿', 'Delete draft'),
          icon: <Trash2 size={13} />,
          danger: true,
          onClick: deleteDraft,
        },
      ], e)}
      title={text(`点击打开 — ${chapterTitleText} v${draft.version}（${DRAFT_STATUS_LABEL[draft.status] || draft.status}）`, `Open — ${chapterTitleText} v${draft.version} (${statusLabel})`)}
    >
      <FileText size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
      <span className="text-xs flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
        {text(`草稿_v${draft.version}`, `Draft_v${draft.version}`)}
      </span>
      {/* 状态标签（始终显示） */}
      <span
        className="text-[0.7rem] flex-shrink-0"
        style={{ color: DRAFT_STATUS_COLOR[draft.status] || 'var(--color-text-muted)' }}
      >
        {statusLabel}
      </span>
      {/* 已定稿图标 */}
      {isFinalized && (
        <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
      )}
      <button
        type="button"
        className="opacity-70 hover:opacity-100 rounded p-0.5"
        title={text('删除这一稿', 'Delete draft')}
        onClick={(e) => {
          e.stopPropagation()
          deleteDraft()
        }}
        style={{ color: 'var(--color-text-muted)' }}
      >
        <Trash2 size={10} />
      </button>
    </div>
  )
}
