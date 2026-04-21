/**
 * DraftBoxGroup — 草稿箱折叠组（含章节分组和单条草稿条目）
 */

import { useState, useEffect } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, Circle, FileText, FolderOpen, Copy, Trash2, FilePen } from 'lucide-react'
import type { DraftMeta } from '../../../stores/draft-store'
import { useDraftStore, readDraftBody } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { confirm } from '../../ui/Confirm'
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../../shared/draft-status'
import { showSidebarMenu } from './SidebarShared'
import { ipc } from '../../../services/ipc-client'

// ===== 草稿箱折叠组 =====

export default function DraftBoxGroup({
  draftsByChapter,
}: {
  draftsByChapter: Record<number, DraftMeta[]>
}) {
  const [open, setOpen] = useState(true)

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
      {/* 草稿箱标题行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        title="草稿箱：AI 生成后的章节草稿在此管理，定稿后进入正文章节"
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <FilePen size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>草稿箱</span>
        {activeChapterCount > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {activeChapterCount} 章
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
              暂无草稿（从章节蓝图点击「写作此章」创作）
            </div>
          ) : (
            chapterNums.map(chNum => (
              <DraftChapterGroup
                key={chNum}
                chapterNumber={chNum}
                drafts={draftsByChapter[chNum] || []}
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
}: {
  chapterNumber: number
  drafts: DraftMeta[]
}) {
  const [open, setOpen] = useState(true)

  // 将 archived 草稿折叠，只显示活跃草稿（非 archived）
  const activeDrafts = drafts.filter(d => d.status !== 'archived')
  const archivedDrafts = drafts.filter(d => d.status === 'archived')
  const [showArchived, setShowArchived] = useState(false)
  const [bpTitle, setBpTitle] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    ipc.invoke('db:blueprint-get', chapterNumber).then(bp => {
      if (!cancelled && bp?.title) {
        setBpTitle(bp.title)
      }
    }).catch(() => { })
    return () => { cancelled = true }
  }, [chapterNumber])

  // 已定稿的草稿存在时，章节显示绿色标记
  const hasFinalized = drafts.some(d => d.status === 'finalized')
  const baseTitle = bpTitle || drafts[0]?.chapterTitle || ''
  const displayTitle = baseTitle.startsWith(`第${chapterNumber}章`) ? baseTitle : (baseTitle ? `第${chapterNumber}章 ${baseTitle}` : `第${chapterNumber}章`)

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
          {activeDrafts.length} 稿
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
                {showArchived ? '▲ 隐藏' : `▼ ${archivedDrafts.length} 个已归档`}
              </span>
            </div>
          )}
          {showArchived && archivedDrafts.map(draft => (
            <DraftItem
              key={draft.filePath}
              draft={draft}
              chapterTitleText={displayTitle}
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
  archived = false,
}: {
  draft: DraftMeta
  chapterTitleText: string
  archived?: boolean
}) {
  /** 打开草稿到编辑器 */
  const openDraft = async () => {
    const content = await readDraftBody(draft.filePath)
    useEditorStore.getState().openFile({
      id: draft.filePath,
      name: `${chapterTitleText} v${draft.version}`,
      type: 'chapter',
      filePath: draft.filePath,
      content,
    })
  }

  /** 将草稿标记为归档（软删除） */
  const deleteDraft = async () => {
    if (isFinalized) return
    const ok = await confirm(
      `归档草稿 "${chapterTitleText} v${draft.version}" 后可在草稿管理列表中展开已归档列表查看。`,
      { title: '归档草稿', confirmText: '归档', danger: true }
    )
    if (!ok) return
    await useDraftStore.getState().markDraftStatus(draft.filePath, draft.chapterNumber, 'archived')
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
          label: '打开草稿',
          icon: <FolderOpen size={13} />,
          onClick: openDraft,
        },
        { key: 'div1', type: 'divider' as const },
        {
          key: 'copy-path',
          label: '复制文件路径',
          icon: <Copy size={13} />,
          onClick: () => navigator.clipboard.writeText(draft.filePath).catch(() => { }),
        },
        { key: 'div2', type: 'divider' as const },
        {
          key: 'delete',
          label: '删除草稿',
          icon: <Trash2 size={13} />,
          danger: true,
          disabled: isFinalized,
          onClick: deleteDraft,
        },
      ], e)}
      title={`点击打开 — ${chapterTitleText} v${draft.version}（${DRAFT_STATUS_LABEL[draft.status] || draft.status}）`}
    >
      <FileText size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
      <span className="text-xs flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
        草稿_v{draft.version}
      </span>
      {/* 状态标签（始终显示） */}
      <span
        className="text-[0.7rem] flex-shrink-0"
        style={{ color: DRAFT_STATUS_COLOR[draft.status] || 'var(--color-text-muted)' }}
      >
        {DRAFT_STATUS_LABEL[draft.status] || draft.status}
      </span>
      {/* 已定稿图标 */}
      {isFinalized && (
        <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
      )}
    </div>
  )
}
