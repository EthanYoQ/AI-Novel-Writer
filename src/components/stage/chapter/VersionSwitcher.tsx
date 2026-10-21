import { useEffect, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DraftMeta } from '../../../services/draft-index'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import { sqliteTime } from '../../../shared/sqlite-time'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { useAnchoredLayer } from '../../ui/use-anchored-layer'
import { InkDialog } from '../InkDialog'
import { openDraftInChapterView, swapChapterTab } from './chapter-tab-routing'
import { pluralEn } from '../../../shared/plural-en'

type Text = (zh: string, en: string) => string

function versionName(draft: DraftMeta, text: Text): string {
  if (draft.status === 'finalized') return text(`定稿 v${draft.version}`, `Final v${draft.version}`)
  if (draft.status === 'archived') return text(`已归档 v${draft.version}`, `Archived v${draft.version}`)
  if (draft.status === 'revised') return text(`修稿已合并 v${draft.version}`, `Revised v${draft.version}`)
  return text(`草稿 v${draft.version}`, `Draft v${draft.version}`)
}

/**
 * 章节标题旁的版本切换器：列出这一章的各稿，已归档的收在「显示已归档」后面。
 * 选中另一稿时在当前标签的位置换上那一稿；这一稿有未保存的修改时先问作者保存还是放弃，不会静默丢掉。
 */
export default function VersionSwitcher({ tab, current, label, title, onSave }: {
  tab: EditorTab
  current: DraftMeta
  label: string
  title: string
  /** 保存这一稿的修改；失败时抛出，切换随之取消。 */
  onSave: () => Promise<void>
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const draftSession = useDraftStore(s => s.dataProjectSession)
  const chapterDrafts = useDraftStore(s => s.draftsByChapter[current.chapterNumber])
  const { open, layerId, anchorRef, triggerRef, layerRef, renderLayer, toggle, close } = useAnchoredLayer('end')
  const [showArchived, setShowArchived] = useState(current.status === 'archived')
  const [pending, setPending] = useState<DraftMeta | null>(null)
  const [busy, setBusy] = useState(false)

  const session = captureProjectSession(project)
  const drafts = session && sameProjectSessionContext(draftSession, session) && chapterDrafts ? chapterDrafts : [current]
  const sorted = [...drafts].sort((a, b) => b.version - a.version)
  const active = sorted.filter(draft => draft.status !== 'archived')
  const archived = sorted.filter(draft => draft.status === 'archived')
  const shown = showArchived ? [...active, ...archived] : active

  useEffect(() => {
    if (open) layerRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [open, layerRef])

  const swapTo = async (draft: DraftMeta) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) return
    await swapChapterTab(tab.id, () => openDraftInChapterView(draft, title, projectSession))
  }

  const choose = (draft: DraftMeta) => {
    close(true)
    if (draft.filePath === tab.filePath) return
    const editor = useEditorStore.getState()
    const opened = editor.tabs.find(candidate => candidate.type === 'chapter' && candidate.projectKey === tab.projectKey && candidate.filePath === draft.filePath)
    if (opened) {
      editor.setActiveTab(opened.id)
      return
    }
    const latest = editor.tabs.find(candidate => candidate.id === tab.id)
    if (latest?.dirty) setPending(draft)
    else void swapTo(draft)
  }

  const settle = async (save: boolean) => {
    const draft = pending
    if (!draft) return
    setBusy(true)
    try {
      if (save) {
        await onSave()
        // 保存期间又有输入，或保存被会话守卫跳过：修改还没落盘，不切换。
        if (useEditorStore.getState().tabs.find(candidate => candidate.id === tab.id)?.dirty) return
      }
      setPending(null)
      await swapTo(draft)
    } catch {
      // 保存失败的原因已由保存提示给出；留在这一稿，修改还在。
    } finally {
      setBusy(false)
    }
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(layerRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length]
      : event.key === 'ArrowUp' ? items[(index - 1 + items.length) % items.length] : undefined
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }

  const row = (draft: DraftMeta) => (
    <button
      key={draft.id}
      type="button"
      role="menuitemradio"
      aria-checked={draft.id === current.id}
      className="pi-menu-item stage-ch-version-item"
      tabIndex={-1}
      onClick={() => choose(draft)}
    >
      <span>{versionName(draft, text)}{draft.id === current.id ? text(' · 当前', ' · open') : ''}</span>
      <small>
        {draft.wordCount !== undefined ? text(`${draft.wordCount.toLocaleString(locale)} 字 · `, `${draft.wordCount.toLocaleString(locale)} ${pluralEn(draft.wordCount, 'word')} · `) : ''}
        {sqliteTime(draft.updatedAt ?? draft.createdAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </small>
    </button>
  )

  return (
    <div className="pi-anchor" ref={anchorRef}>
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        className="stage-ch-version"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? layerId : undefined}
        aria-label={text(`本章版本：${label}`, `Chapter versions: ${label}`)}
        onClick={toggle}
      >
        {label}<ChevronDown size={13} aria-hidden />
      </Button>
      {open && renderLayer(
        <div id={layerId} ref={layerRef} role="menu" aria-label={text('本章版本', 'Chapter versions')} className="pi-menu stage-ch-versions" onKeyDown={moveFocus}>
          <div className="pi-menu-label" aria-hidden>{text('本章版本', 'Chapter versions')}</div>
          {shown.map(row)}
          {archived.length > 0 && (
            <>
              <div role="separator" className="pi-menu-sep" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showArchived}
                className="pi-menu-item"
                tabIndex={-1}
                onClick={() => setShowArchived(value => !value)}
              >
                {text(`显示已归档（${archived.length}）`, `Show archived (${archived.length})`)}
              </button>
            </>
          )}
        </div>,
      )}
      <InkDialog
        open={pending !== null}
        onOpenChange={next => { if (!next && !busy) setPending(null) }}
        title={text('切换前保存修改？', 'Save changes before switching?')}
        description={text(
          `「${label}」有未保存的修改。保存后再打开${pending ? versionName(pending, text) : ''}，或放弃这些修改。`,
          `“${label}” has unsaved changes. Save them before opening ${pending ? versionName(pending, text) : ''}, or discard them.`,
        )}
        footer={(
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>{text('继续编辑', 'Keep editing')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void settle(false)}>{text('放弃修改并切换', 'Discard and switch')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void settle(true)}>{text('保存并切换', 'Save and switch')}</Button>
          </>
        )}
      />
    </div>
  )
}
