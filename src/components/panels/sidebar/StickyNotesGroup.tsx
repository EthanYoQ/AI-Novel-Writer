/**
 * StickyNotesGroup — 侧栏「便利贴」折叠组（在「正文章节」下方）
 *
 * 形态照先生的话：「顶栏完全可以用草稿箱的模式」—— 所以标题行与 DraftBoxGroup /
 * ManuscriptGroup 同一套（.tree-item、paddingLeft 10、14px 常规字重、右侧计数）。
 *
 * 先生 2026-09-20 的四条定调（这一版按它们重排）：
 *   · **标题行右侧换成「待选箱」** —— 原来那颗「AI 灵感」与便利贴编辑器顶栏那颗重复了，
 *     而待选箱正需要一个入口（「有内容才出现」是先生 2026-09-21 补定的，见下方入口处）；
 *   · **新建摆在列表最上方** —— 便利贴一多，原来摆在末尾的新建要滚很久才够得着；
 *   · **新建一分为二**：便利贴 / 文件夹，文件夹的改名方式与便利贴完全一致（双击就地改）；
 *   · **便利贴可以拖进文件夹**（也能拖回根下）—— 攒多了要能收纳。
 *
 * 便利贴**不参与任何创作链路**：这里没有任何「送去写作」「同步设定」之类的入口。
 */
import { useMemo, useState, type CSSProperties } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Pencil,
  StickyNote,
  Trash2,
} from 'lucide-react'

import type { StickyFolder, StickyNote as StickyNoteRecord } from '../../../shared/sticky-note'
import { stickyTabPath } from '../../../shared/sticky-note'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useStickyNoteStore } from '../../../stores/sticky-note-store'
import { usePendingUnread } from '../../../stores/pending-badge-store'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import PendingDot from '../../ui/PendingDot'
import StickyTrayDialog from '../../dialogs/StickyTrayDialog'
// 被夹着的条目那根共用虚线（先生定的：「贴着夹子往下延申」）
import './tree-child-indent.css'
import { showSidebarMenu } from './sidebar-menu'
import { confirmCurrentProjectSession, openStickyNote } from './sidebar-file-openers'

/** 根下（不属于任何文件夹）的拖放标识。 */
const ROOT_DROP_ID = '__sticky_root__'

/**
 * 侧栏显示名。
 *
 * 没起名就取正文第一行非来源行的文字 —— 像笔记应用那样，写下去它就自己有名了，
 * 免得先生对着一列「未命名便利贴」发愣。
 */
function noteDisplayTitle(note: StickyNoteRecord, untitled: string): string {
  const title = note.title.trim()
  if (title) return title
  const firstLine = note.body
    .split('\n')
    .map(line => line.trim())
    // 点子块的第一行是来源行（「—— 灵感 · …」），它不是正文，跳过。
    .find(line => line && !line.startsWith('——'))
  if (!firstLine) return untitled
  return firstLine.length > 26 ? `${firstLine.slice(0, 26)}…` : firstLine
}

export default function StickyNotesGroup() {
  const text = useLocaleStore(s => s.text)
  const notes = useStickyNoteStore(s => s.notes)
  const folders = useStickyNoteStore(s => s.folders)
  const candidates = useStickyNoteStore(s => s.candidates)
  const currentProject = useProjectStore(s => s.currentProject)
  /**
   * 当前激活的编辑器页 —— 侧栏据此把「正在看的那一行」点亮。
   *
   * 先生：「我当前正在正文栏目查看那个项目下的内容，那么这个项目在项目结构下的
   * 标题入口就应该做一个背景变色？来提示用户。不然用户都不知道自己在看哪个地方的内容！」
   *
   * 样式不用另写：项目里本来就有 `.tree-item.active`（v2 白底朱砂竖条、
   * v3 用当前栏目色整行反白），只是**从来没有人给它加过这个类**。
   */
  const activeTabId = useEditorStore(s => s.activeTabId)
  const openTabs = useEditorStore(s => s.tabs)
  const activeFilePath = openTabs.find(tab => tab.id === activeTabId)?.filePath
  /** 这一页是不是便利贴 —— 组标题行据此点亮（见 sidebar-active-entry.ts 的口径）。 */
  const activeIsStickyNote = openTabs.find(tab => tab.id === activeTabId)?.type === 'sticky-note'

  // 先生：草稿箱 / 正文章节都默认收起，便利贴照办。
  const [open, setOpen] = useState(false)
  /** 正在原地改名的便利贴 / 文件夹（双击进入，回车或失焦即存，Esc 放弃）。 */
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderDraft, setEditingFolderDraft] = useState('')
  /** 被折叠起来的文件夹（默认都展开，点一下才收）。 */
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  /** 当前拖拽悬停的目标：文件夹 id 或 ROOT_DROP_ID。 */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [trayOpen, setTrayOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const untitled = text('未命名便利贴', 'Untitled note')
  const untitledFolder = text('未命名文件夹', 'Untitled folder')
  const rootNotes = notes.filter(note => !note.folderId)
  const notesOfFolder = (folderId: string) => notes.filter(note => note.folderId === folderId)

  /**
   * 「待选箱里有新的」小红点（先生 2026-09-21）。
   *
   * 箱子是**常驻**的（空了也留着位置），所以「有没有东西」靠数字表达；
   * 红点只表达「有没有**我没见过**的东西」—— 两者不是一回事。
   * 口径见 pending-badge-store。
   */
  const trayIds = useMemo(() => candidates.map(candidate => candidate.candidateId), [candidates])
  const { unread: hasUnreadTray, markSeen: markTraySeen } = usePendingUnread(
    currentProject?.path ?? null,
    'sticky-tray',
    trayIds,
  )

  // ===== 新建 =====

  const createNote = async (folderId: string | null = null) => {
    setBusy(true)
    try {
      const note = await useStickyNoteStore.getState().createNote('', folderId)
      if (!note) {
        toast.error(text('新建便利贴失败', 'Could not create the note'))
        return
      }
      setOpen(true)
      openStickyNote(note)
    } finally {
      setBusy(false)
    }
  }

  const createFolder = async () => {
    setBusy(true)
    try {
      const folder = await useStickyNoteStore.getState().createFolder('')
      if (!folder) {
        toast.error(text('新建文件夹失败', 'Could not create the folder'))
        return
      }
      setOpen(true)
      // 新建即就地对名 —— 空文件夹摆在列表里没有名字，先让作者给它起一个。
      setEditingFolderId(folder.folderId)
      setEditingFolderDraft('')
    } finally {
      setBusy(false)
    }
  }

  // ===== 改名（便利贴与文件夹同一套手势）=====

  const commitNoteRename = async (noteId: string) => {
    if (editingNoteId !== noteId) return
    const nextTitle = editingDraft
    setEditingNoteId(null)
    const current = useStickyNoteStore.getState().notes.find(note => note.noteId === noteId)
    if (!current || current.title === nextTitle) return

    setBusy(true)
    try {
      const renamed = await useStickyNoteStore.getState().renameNote(noteId, nextTitle)
      if (!renamed) {
        toast.error(text('重命名失败', 'Rename failed'))
        return
      }
      // 标签页上的名字也跟着换，否则侧栏和标签会各叫各的。
      const editor = useEditorStore.getState()
      const tab = editor.tabs.find(item => (
        item.type === 'sticky-note' && item.filePath === stickyTabPath(noteId)
      ))
      if (tab) {
        const name = renamed.title.trim() || untitled
        useEditorStore.setState(state => ({
          tabs: state.tabs.map(item => (item.id === tab.id ? { ...item, name } : item)),
        }))
      }
    } finally {
      setBusy(false)
    }
  }

  const commitFolderRename = async (folderId: string) => {
    if (editingFolderId !== folderId) return
    const nextName = editingFolderDraft
    setEditingFolderId(null)
    const current = useStickyNoteStore.getState().folders.find(folder => folder.folderId === folderId)
    if (!current || current.name === nextName) return
    setBusy(true)
    try {
      const renamed = await useStickyNoteStore.getState().renameFolder(folderId, nextName)
      if (!renamed) toast.error(text('重命名失败', 'Rename failed'))
    } finally {
      setBusy(false)
    }
  }

  // ===== 删除 =====

  const removeNote = async (note: StickyNoteRecord) => {
    const display = noteDisplayTitle(note, untitled)
    const projectSession = await confirmCurrentProjectSession(
      currentProject,
      () => confirm(
        text(
          `确认删除「${display}」？\n便利贴里的内容会一并删除，此操作不可撤销。`,
          `Delete “${display}”?\nIts content is removed with it. This cannot be undone.`,
        ),
        {
          title: text('删除便利贴', 'Delete note'),
          confirmText: text('删除', 'Delete'),
          danger: true,
        },
      ),
    )
    if (!projectSession) return
    const ok = await useStickyNoteStore.getState().deleteNote(note.noteId)
    if (!ok) {
      toast.error(text('删除便利贴失败', 'Could not delete the note'))
      return
    }
    const editor = useEditorStore.getState()
    const tab = editor.tabs.find(item => (
      item.type === 'sticky-note' && item.filePath === stickyTabPath(note.noteId)
    ))
    if (tab) editor.closeTab(tab.id)
    toast.success(text(`已删除「${display}」`, `Deleted “${display}”`))
  }

  /**
   * 删除文件夹。
   *
   * **里面的便利贴一条都不删** —— 它们回到根下。确认文案必须把这一点写死，
   * 否则作者会以为删夹子等于删内容而不敢点（或者反过来，以为安全而丢东西）。
   */
  const removeFolder = async (folder: StickyFolder) => {
    const inside = notesOfFolder(folder.folderId).length
    const display = folder.name.trim() || untitledFolder
    const projectSession = await confirmCurrentProjectSession(
      currentProject,
      () => confirm(
        text(
          `确认删除文件夹「${display}」？\n` + (inside > 0
            ? `里面的 ${inside} 张便利贴会回到便利贴列表里，**不会被删除**。`
            : '这个文件夹是空的。'),
          `Delete the folder “${display}”?\n` + (inside > 0
            ? `Its ${inside} notes move back to the note list; none of them are deleted.`
            : 'This folder is empty.'),
        ),
        {
          title: text('删除文件夹', 'Delete folder'),
          confirmText: text('删除文件夹', 'Delete folder'),
          danger: true,
        },
      ),
    )
    if (!projectSession) return
    const ok = await useStickyNoteStore.getState().deleteFolder(folder.folderId)
    if (!ok) {
      toast.error(text('删除文件夹失败', 'Could not delete the folder'))
      return
    }
    toast.success(text(`已删除文件夹「${display}」`, `Deleted the folder “${display}”`))
  }

  // ===== 拖拽收纳 =====

  const handleDrop = async (noteId: string, folderId: string | null) => {
    setDropTarget(null)
    const note = useStickyNoteStore.getState().notes.find(item => item.noteId === noteId)
    if (!note || (note.folderId ?? null) === folderId) return
    const moved = await useStickyNoteStore.getState().moveNote(noteId, folderId)
    if (!moved) {
      toast.error(text('移动失败，请重试', 'Could not move the note. Please try again.'))
      return
    }
    const target = folderId
      ? useStickyNoteStore.getState().folders.find(folder => folder.folderId === folderId)
      : null
    toast.success(target
      ? text(`已移入「${target.name.trim() || untitledFolder}」`, `Moved into “${target.name.trim() || untitledFolder}”`)
      : text('已移回便利贴列表', 'Moved back to the note list'))
  }

  // ===== 渲染 =====

  const renderNoteRow = (note: StickyNoteRecord) => {
    const display = noteDisplayTitle(note, untitled)
    /**
     * 层级（先生 2026-09-20，最终版）：
     *   「我的本意是让层级的结构和感觉和草稿箱完全保持一致……这样下来就整齐美观」
     *   「夹子里面的便利贴没有和草稿箱中章节夹子内的草稿标题对齐啊，现在夹子里的
     *     便利贴明显要靠右边很多」
     *
     * 所以这里**不再用 `.tree-item`**，改成与草稿行**逐字同构**的
     * `relative flex items-center gap-1.5`：`.tree-item` 带着 2px 左边框与 8px 间距，
     * 而草稿行是 6px 间距 —— 类名不同，padding 再怎么调都对不齐。
     *
     *   根下的便利贴 —— 26，与文件夹标题齐平；26 会命中基座那条虚线规则（画在 19px），
     *                   于是它和夹子**共用同一条线**：它摆在外面。
     *   夹子里的     —— **74 / 线 64**，与草稿行**一模一样**：
     *                   同样的数字，同样的类名，文字自然对齐。
     */
    const inFolder = Boolean(note.folderId)
    /** 这张便利贴正是当前打开的那一页？那就点亮它。 */
    const isActive = activeFilePath === stickyTabPath(note.noteId)
    return (
      <div
        key={note.noteId}
        data-level={3}
        className={`relative flex items-center gap-1.5 cursor-pointer hover:bg-[var(--color-hover)]${isActive ? ' active' : ''}`}
        style={{
          paddingLeft: inFolder ? 74 : 26,
          ...(inFolder ? { '--tree-child-line': '64px' } : {}),
          /** 选中色标跟着缩进走：夹内 74 → 64；根下 26 → 16。 */
          '--row-mark-x': inFolder ? '64px' : '16px',
          paddingRight: 8,
          paddingTop: 3,
          paddingBottom: 3,
        } as CSSProperties}
        {...(inFolder ? { 'data-tree-child': '1' } : {})}
        // 测试锚点：便利贴行不再带 .tree-item 类，量尺寸/拖拽的脚本要靠它定位
        data-sticky-note-row="1"
        onClick={() => openStickyNote(note)}
        onDoubleClick={(event) => {
          event.stopPropagation()
          setEditingNoteId(note.noteId)
          setEditingDraft(note.title)
        }}
        // 拖拽收纳：拖到文件夹上，或拖回列表空白处（根下）。
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('text/x-sticky-note', note.noteId)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onContextMenu={e => showSidebarMenu([
          {
            key: 'open',
            label: text('打开便利贴', 'Open note'),
            icon: <FolderOpen size={13} />,
            onClick: () => openStickyNote(note),
          },
          { key: 'div1', type: 'divider' as const },
          {
            key: 'rename',
            label: text('重命名', 'Rename'),
            icon: <Pencil size={13} />,
            onClick: () => {
              setEditingNoteId(note.noteId)
              setEditingDraft(note.title)
            },
          },
          { key: 'div2', type: 'divider' as const },
          {
            key: 'delete',
            label: text('删除便利贴', 'Delete note'),
            icon: <Trash2 size={13} />,
            danger: true,
            onClick: () => { void removeNote(note) },
          },
        ], e)}
        title={editingNoteId === note.noteId
          ? undefined
          : text(`${display}（双击改名，可拖进文件夹）`, `${display} (double-click to rename; drag into a folder)`)}
      >
        {/* 条目图标 10 —— 与草稿箱里那条「草稿_v1」的 FileText 同号（先生要的整齐） */}
        <StickyNote size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        {editingNoteId === note.noteId ? (
          <input
            autoFocus
            value={editingDraft}
            maxLength={60}
            placeholder={untitled}
            className="text-xs flex-1 min-w-0 bg-transparent border-0 outline-none"
            style={{
              color: 'var(--color-text)',
              borderBottom: '1px solid var(--color-accent)',
              padding: 0,
            }}
            onClick={event => event.stopPropagation()}
            onDoubleClick={event => event.stopPropagation()}
            onChange={event => setEditingDraft(event.target.value)}
            onBlur={() => { void commitNoteRename(note.noteId) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commitNoteRename(note.noteId)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditingNoteId(null)
              }
            }}
          />
        ) : (
          /**
           * 便利贴用 text-xs（与草稿箱里的草稿条目同号），文件夹用 text-sm ——
           * 先生说原先两者一样大，看着都像文件夹，分不清谁是夹子、谁是夹子里的本子。
           */
          <span className="text-xs truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
            {display}
          </span>
        )}
        {editingNoteId !== note.noteId && (
          <button
            type="button"
            className="opacity-70 hover:opacity-100 rounded p-0.5"
            title={text('删除便利贴', 'Delete note')}
            onClick={(e) => {
              e.stopPropagation()
              void removeNote(note)
            }}
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    )
  }

  const renderFolder = (folder: StickyFolder) => {
    const inside = notesOfFolder(folder.folderId)
    const collapsed = collapsedFolders.has(folder.folderId)
    const isDropTarget = dropTarget === folder.folderId
    const display = folder.name.trim() || untitledFolder
    /**
     * 这个夹子里有正在看的那一张吗？有就把**夹子这一行**点亮。
     *
     * 先生 2026-09-20：「便利贴的 2 级框体没起作用？我的文件夹前面感觉没啥变化」
     * —— 便利贴这一支本来就是三级：组（1）→ 夹子（2）→ 便利贴（3），
     * 而夹子这一行当时既没标层级、也没有选中态，于是打开夹内的便利贴时，
     * 中间那一级是断的（外面看着「没变化」）。
     */
    const holdsActiveNote = inside.some(note => stickyTabPath(note.noteId) === activeFilePath)
    return (
      <div key={folder.folderId}>
        <div
          data-level={2}
          className={`tree-item gap-1.5 cursor-pointer select-none${holdsActiveNote ? ' active' : ''}`}
          style={{
            // 与草稿箱的章节行同缩进（26）—— 两棵树看起来才是同一套层级。
            paddingLeft: 26,
            /** 选中色标跟着缩进走：缩进 26 → 色标落在 16（内容左缘再往左 10px）。 */
            '--row-mark-x': '16px',
            // 拖拽悬停时给整行一层淡底 —— 先生要能看出「松手会落进这里」。
            backgroundColor: isDropTarget ? 'var(--color-hover)' : undefined,
          } as CSSProperties}
          onClick={() => {
            setCollapsedFolders((prev) => {
              const next = new Set(prev)
              if (next.has(folder.folderId)) next.delete(folder.folderId)
              else next.add(folder.folderId)
              return next
            })
          }}
          onDoubleClick={(event) => {
            event.stopPropagation()
            setEditingFolderId(folder.folderId)
            setEditingFolderDraft(folder.name)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== folder.folderId) setDropTarget(folder.folderId)
          }}
          onDragLeave={() => {
            setDropTarget(prev => (prev === folder.folderId ? null : prev))
          }}
          onDrop={(event) => {
            event.preventDefault()
            const noteId = event.dataTransfer.getData('text/x-sticky-note')
            if (noteId) void handleDrop(noteId, folder.folderId)
          }}
          onContextMenu={e => showSidebarMenu([
            {
              key: 'rename',
              label: text('重命名文件夹', 'Rename folder'),
              icon: <Pencil size={13} />,
              onClick: () => {
                setEditingFolderId(folder.folderId)
                setEditingFolderDraft(folder.name)
              },
            },
            { key: 'div1', type: 'divider' as const },
            {
              key: 'delete',
              label: text('删除文件夹', 'Delete folder'),
              icon: <Trash2 size={13} />,
              danger: true,
              onClick: () => { void removeFolder(folder) },
            },
          ], e)}
          title={editingFolderId === folder.folderId
            ? undefined
            : text(`${display}（双击改名；把便利贴拖进来即可收纳）`, `${display} (double-click to rename; drag notes in)`)
          }
        >
          {/*
            折叠三角与图标一并照抄草稿箱的尺寸（三角 10 / 图标 10）。
            先生：「我的本意是让层级的结构和感觉和草稿箱完全保持一致。比如往下的三角的
            大小、logo 的占位、大小都保持一样，这样下来就整齐美观。」
          */}
          {collapsed
            ? <ChevronRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            : <ChevronDown size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />}
          <FolderOpen size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          {editingFolderId === folder.folderId ? (
            <input
              autoFocus
              value={editingFolderDraft}
              maxLength={60}
              placeholder={untitledFolder}
              className="text-sm flex-1 min-w-0 bg-transparent border-0 outline-none"
              style={{
                color: 'var(--color-text)',
                borderBottom: '1px solid var(--color-accent)',
                padding: 0,
              }}
              onClick={event => event.stopPropagation()}
              onDoubleClick={event => event.stopPropagation()}
              onChange={event => setEditingFolderDraft(event.target.value)}
              onBlur={() => { void commitFolderRename(folder.folderId) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitFolderRename(folder.folderId)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditingFolderId(null)
                }
              }}
            />
          ) : (
            <span className="text-sm truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
              {display}
            </span>
          )}
          {inside.length > 0 && (
            <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              {inside.length}
            </span>
          )}
          {/* 先生说文件夹也得能删 —— 不然建完就尴尬了。与便利贴同款那颗垃圾桶。 */}
          {editingFolderId !== folder.folderId && (
            <button
              type="button"
              className="opacity-70 hover:opacity-100 rounded p-0.5"
              title={text('删除文件夹（里面的便利贴会回到列表，不会被删）', 'Delete folder (its notes go back to the list, none are deleted)')}
              onClick={(event) => {
                event.stopPropagation()
                void removeFolder(folder)
              }}
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>

        {!collapsed && inside.map(renderNoteRow)}
      </div>
    )
  }

  const isEmpty = notes.length === 0 && folders.length === 0

  return (
    <div>
      {/* 便利贴标题行 —— 与草稿箱同款；右侧是待选箱入口（空箱子时整颗不渲染） */}
      <div
        data-level={1}
        className={`tree-item gap-1.5 cursor-pointer select-none${activeIsStickyNote ? ' active' : ''}`}
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        onContextMenu={e => showSidebarMenu([
          {
            key: 'new-note',
            label: text('新建便利贴', 'New note'),
            icon: <FilePlus size={13} />,
            onClick: () => { void createNote(null) },
          },
          {
            key: 'new-folder',
            label: text('新建文件夹', 'New folder'),
            icon: <FolderPlus size={13} />,
            onClick: () => { void createFolder() },
          },
        ], e)}
        title={text(
          '便利贴：自己攒灵感的地方，AI 写作时不会读到它',
          'Sticky notes: a private place for your own ideas. AI writing never reads it.',
        )}
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <StickyNote size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-[14px]" style={{ color: 'var(--color-text)', fontWeight: 400 }}>
          {text('便利贴', 'Sticky notes')}
        </span>
        {notes.length > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(`${notes.length} 张`, `${notes.length}`)}
          </span>
        )}
        {/*
          待选箱入口 —— 原来那颗「AI 灵感」与便利贴编辑器顶栏重复了，
          这里换成待选箱（它正需要一个入口）。

          先生 2026-09-21（本轮改的形态）：「待选箱 平时也隐藏起来，只有相关内容存在才出现。」
          与角色栏的「待确认」、设定集侧栏的「待确认 / 待裁决冲突」统一：
          **空箱子不占位置、不添噪音**，箱里一有落选的点子，它自己带着数字跳出来。
          （原先写的是「常驻显示、空了也留着位置」，先生看过实物后改成了现在这条。）

          未读小红点（同一天）：抽卡落选的条目进箱时是「新的」，作者点开待选箱即消点。
        */}
        {candidates.length > 0 && (
          <button
            type="button"
            className="relative flex-shrink-0 flex items-center gap-1 rounded px-1 py-0.5 text-[0.7rem]"
            style={{
              color: 'var(--color-text-secondary)',
              marginLeft: notes.length > 0 ? 6 : 'auto',
            }}
            title={text(
              hasUnreadTray
                ? `待选箱里有 ${candidates.length} 条落选的点子，可以找回（有新的）`
                : `待选箱里有 ${candidates.length} 条落选的点子，可以找回`,
              hasUnreadTray
                ? `${candidates.length} unselected ideas are waiting in the tray (new)`
                : `${candidates.length} unselected ideas are waiting in the tray`,
            )}
            onMouseEnter={event => { event.currentTarget.style.color = 'var(--color-accent)' }}
            onMouseLeave={event => { event.currentTarget.style.color = 'var(--color-text-secondary)' }}
            onClick={(event) => {
              // 整行已经绑了「点击 = 展开 / 折叠」—— 不拦住事件，点一下会把列表也开合一次。
              event.stopPropagation()
              // 打开即「看过了」：红点与「他确实看见了」是同一个动作（见 pending-badge-store）。
              markTraySeen()
              setTrayOpen(true)
            }}
          >
            <Archive size={11} />
            {text('待选箱', 'Tray')}
            <span className="tabular-nums">{candidates.length}</span>
            {hasUnreadTray && <PendingDot />}
          </button>
        )}
      </div>

      {open && (
        <div
          // 列表空白处 = 便利贴的「根下」：把便利贴拖到这里就移出文件夹。
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== ROOT_DROP_ID) setDropTarget(ROOT_DROP_ID)
          }}
          onDragLeave={() => setDropTarget(prev => (prev === ROOT_DROP_ID ? null : prev))}
          onDrop={(event) => {
            event.preventDefault()
            const noteId = event.dataTransfer.getData('text/x-sticky-note')
            if (noteId) void handleDrop(noteId, null)
          }}
          style={dropTarget === ROOT_DROP_ID
            ? { backgroundColor: 'var(--color-hover)' }
            : undefined}
        >
          {/*
            新建摆在**最上方**（先生）：便利贴一多，原来摆在末尾的新建要滚很久才够得着。
            两个按钮并排，各自写明建什么。
          */}
          <div className="flex items-center gap-1 pr-2" style={{ paddingLeft: 26, paddingTop: 2, paddingBottom: 2 }}>
            <button
              type="button"
              className="flex-1 flex items-center justify-center gap-1 rounded py-0.5 text-[0.7rem]"
              style={{ color: 'var(--color-text-muted)' }}
              disabled={busy}
              title={text('新建一张便利贴', 'Create a new note')}
              onMouseEnter={event => { event.currentTarget.style.color = 'var(--color-accent)' }}
              onMouseLeave={event => { event.currentTarget.style.color = 'var(--color-text-muted)' }}
              onClick={() => { if (!busy) void createNote(null) }}
            >
              <FilePlus size={11} />
              {text('+便利贴', '+Note')}
            </button>
            <span style={{ color: 'var(--color-border)' }}>|</span>
            <button
              type="button"
              className="flex-1 flex items-center justify-center gap-1 rounded py-0.5 text-[0.7rem]"
              style={{ color: 'var(--color-text-muted)' }}
              disabled={busy}
              title={text('新建一个文件夹，用来收纳便利贴', 'Create a folder to keep notes in')}
              onMouseEnter={event => { event.currentTarget.style.color = 'var(--color-accent)' }}
              onMouseLeave={event => { event.currentTarget.style.color = 'var(--color-text-muted)' }}
              onClick={() => { if (!busy) void createFolder() }}
            >
              <FolderPlus size={11} />
              {text('+文件夹', '+Folder')}
            </button>
          </div>

          {folders.map(renderFolder)}
          {rootNotes.map(renderNoteRow)}

          {isEmpty && (
            <div
              className="text-xs py-1"
              style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}
            >
              {text('还没有便利贴（点上面的「便利贴」新建一张）', 'No notes yet — use “Note” above to create one.')}
            </div>
          )}
        </div>
      )}

      {/* 待选箱：找回 / 清空。AI 灵感入口已在便利贴编辑器顶栏，侧栏不再重复。 */}
      <StickyTrayDialog open={trayOpen} onClose={() => setTrayOpen(false)} />
    </div>
  )
}
