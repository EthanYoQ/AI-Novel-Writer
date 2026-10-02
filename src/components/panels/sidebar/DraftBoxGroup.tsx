/**
 * DraftBoxGroup — 草稿箱折叠组（含章节分组和单条草稿条目）
 */

import { useState, useEffect, type CSSProperties } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, Circle, FileText, FolderOpen, Copy, Trash2, FilePen } from 'lucide-react'
import type { DraftMeta } from '../../../stores/draft-store'
import { useDraftStore, readDraftBody } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { confirm } from '../../ui/Confirm'
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../../shared/draft-status'
import { showSidebarMenu } from './sidebar-menu'
import { ipc } from '../../../services/ipc-client'
import { toast } from '../../ui/Toast'
import { globalEventBus } from '../../../shared/event-bus'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'
import { deleteFinalizedChapter } from './finalized-chapter-deletion'
import { useActiveManuscriptSurface, useActiveTabFilePath } from './sidebar-active-entry'
// 子项那根「贴着所属章节往下延申」的共用虚线
import './tree-child-indent.css'

const DRAFT_STATUS_EN: Record<string, string> = {
  draft: 'Draft', revising: 'Revising', reviewed: 'Reviewed', finalized: 'Finalized', archived: 'Archived',
}

// ===== 草稿箱折叠组 =====

export default function DraftBoxGroup({
  draftsByChapter,
}: {
  draftsByChapter: Record<number, DraftMeta[]>
}) {
  // 先生：草稿箱不要一打开就把内容全摊开 —— 太乱，默认收起，用户要看了再点开。
  const [open, setOpen] = useState(false)
  const text = useLocaleStore(s => s.text)
  const projectKey = useProjectStore(s => s.currentProject?.path)
  /**
   * 「正在看的那一行」的统一依据（见 sidebar-active-entry.ts）。
   *
   * 先生 2026-09-20：「1级的草稿箱、2级章节……这些是没反应」——
   * 查证：草稿箱这一整条链（组行 + 章节分组行）当时**都没有选中态代码**，
   * 只有最底下那一稿（DraftItem）挂了 `.active`。
   */
  const activeFilePath = useActiveTabFilePath()
  const activeSurface = useActiveManuscriptSurface()
  if (!projectKey) return null

  // 所有章节号排序
  const chapterNums = Object.keys(draftsByChapter)
    .map(Number)
    .sort((a, b) => a - b)

  // 筛选出包含非保留（活跃）草稿的实际章节数
  const activeChapterCount = chapterNums.filter(n =>
    (draftsByChapter[n] || []).some(d => d.status !== 'archived')
  ).length

  return (
    <div>
      {/* 草稿箱标题行 —— 正文栏正看着某一稿时它也要亮（折叠着同样亮） */}
      <div
        data-level={1}
        className={`tree-item gap-1.5 cursor-pointer select-none${activeSurface === 'draft' ? ' active' : ''}`}
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        title={text('草稿箱：AI 生成后的章节草稿在此管理，定稿后进入正文章节', 'Draft box: manage AI-generated drafts here. Finalized drafts move to the manuscript.')}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <FilePen size={14} style={{ color: 'var(--color-text-muted)' }} />
        {/* 先生：草稿箱不是最重要的项，不必加黑 —— 常规字重即可 */}
        <span className="text-[14px]" style={{ color: 'var(--color-text)', fontWeight: 400 }}>{text('草稿箱', 'Draft box')}</span>
        {activeChapterCount > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`${activeChapterCount} 章`, `${activeChapterCount} chapters`)}
          </span>
        )}
      </div>

      {open && (
        <div>
          {chapterNums.length === 0 ? (
            <div
              className="text-xs py-1"
              style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}
            >
              {text('暂无草稿（从章节蓝图点击「写作此章」创作）', 'No drafts. Use “Write chapter” from a chapter blueprint.')}
            </div>
          ) : (
            chapterNums.map(chNum => (
              <DraftChapterGroup
                key={chNum}
                chapterNumber={chNum}
                drafts={draftsByChapter[chNum] || []}
                projectKey={projectKey}
                activeFilePath={activeSurface === 'draft' ? activeFilePath : undefined}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ===== 单章草稿分组 =====

function DraftChapterGroup({
  chapterNumber,
  drafts,
  projectKey,
  activeFilePath,
}: {
  chapterNumber: number
  drafts: DraftMeta[]
  projectKey: string
  /** 正文栏正看着的那一稿的路径 —— 落在本章里就把本行的章节点亮。 */
  activeFilePath?: string
}) {
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  // 先生：草稿箱展开后只该看到「章节名」，具体草稿要再点进这一章才看得见 —— 默认收起。
  const [open, setOpen] = useState(false)

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
      {/* 章节行 —— 本章的某一稿正在看，这一行也亮（折叠着同样亮） */}
      <div
        data-level={2}
        className={`tree-item gap-1.5 cursor-pointer select-none${activeFilePath !== undefined && drafts.some(d => d.filePath === activeFilePath) ? ' active' : ''}`}
        /** 选中色标跟着缩进走：缩进 26 → 色标落在 16（内容左缘再往左 10px）。 */
        style={{ paddingLeft: 26, '--row-mark-x': '16px' } as CSSProperties}
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
          {text(`${activeDrafts.length} 稿`, `${activeDrafts.length} drafts`)}
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
    const content = await readDraftBody(draft.filePath, projectKey, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    useEditorStore.getState().openFile({
      id: draft.filePath,
      name: `${chapterTitleText} v${draft.version}`,
      type: 'chapter',
      filePath: draft.filePath,
      content,
      savedContent: content,
      draftId: draft.id,
      chapterNumber: draft.chapterNumber,
      draftStatus: draft.status,
      projectKey,
      projectSessionLease: projectSession.leaseId,
    })
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
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-delete',
      draft.id,
      projectKey,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    if (result.errorCode === 'FINALIZED_DRAFT_DELETE_REQUIRED') {
      await useDraftStore.getState().loadChapterDrafts(
        draft.chapterNumber,
        projectKey,
        projectSession,
      )
      if (!isProjectSessionCurrent(projectSession)) return
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
    if (!result.success) {
      toast.error(text(`删除失败\n\n${result.error ?? '未知错误'}`, `Delete failed\n\n${result.error ?? 'Unknown error'}`))
      return
    }
    const editor = useEditorStore.getState()
    const tab = editor.tabs.find(t =>
      t.projectKey === projectKey && (t.id === draft.filePath || t.filePath === draft.filePath)
    )
    if (tab) editor.closeTab(tab.id)
    await useDraftStore.getState().loadChapterDrafts(
      draft.chapterNumber,
      projectKey,
      projectSession,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['drafts', 'fileTree'],
      projectPath: projectKey,
      projectSession,
    })
    toast.success(text(`已删除 ${chapterTitleText} v${draft.version}`, `Deleted ${chapterTitleText} v${draft.version}`))
  }

  const isFinalized = draft.status === 'finalized'
  /**
   * 这一稿正是当前打开的那一页？点亮它。
   *
   * 先生：「用户都不知道自己在看哪个地方的内容！」—— 侧栏得把「正在看的那个」
   * 标出来。选择器直接返回 boolean，zustand 按值比较，不会每次都触发重渲染。
   */
  const isActive = useEditorStore(s => (
    s.tabs.find(tab => tab.id === s.activeTabId)?.filePath === draft.filePath
  ))

  return (
    <div
      data-level={3}
      className={`relative flex items-center gap-1.5 cursor-pointer hover:bg-[var(--color-hover)]${isActive ? ' active' : ''}`}
      /**
       * 先生 2026-09-20：「如果一个便利贴没进夹子，那它本身就是和夹子共线的。
       * 而夹子里的……应该从夹子的标题文字的最左边的位置算起，再往右边缩进去
       * 10px 放置自己。然后这些夹子中便利贴共享夹子内的虚线。」
       *
       * 草稿的「夹子」是上面那一行章节：它的标题文字左缘在行内 64px
       * （padding-left 26 + 折叠箭头 + 状态点 + 两处间距），于是
       *   · 这一稿缩进 **74**（= 64 + 10）；
       *   · 虚线另起一条画在 **64**，同一章的各稿共用它 —— 那就是「这一章往下延申」。
       */
      data-tree-child="1"
      style={{
        paddingLeft: 74,
        '--tree-child-line': '64px',
        /** 选中色标跟着缩进走：缩进 74 → 色标落在 64。 */
        '--row-mark-x': '64px',
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        opacity: archived ? 0.45 : 1,
      } as CSSProperties}
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
      {/* 删除这一稿：悬停转朱砂并加一层淡底（.draft-trash）。
          旧的写法只留 opacity 与固定浅灰，整行 hover 的亮底会把它吞掉 ——
          鼠标一移上去图标反而「消失」了。 */}
      <button
        type="button"
        className="draft-trash"
        title={text('删除这一稿', 'Delete draft')}
        aria-label={text('删除这一稿', 'Delete draft')}
        onClick={(e) => {
          e.stopPropagation()
          deleteDraft()
        }}
      >
        <Trash2 size={10} />
      </button>
    </div>
  )
}
