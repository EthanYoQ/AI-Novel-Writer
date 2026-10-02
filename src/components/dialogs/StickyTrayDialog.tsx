/**
 * StickyTrayDialog — 便利贴的「待选箱」
 *
 * 抽卡时没被选中的点子落在这里，随时可以找回。先生定的规矩（2026-09-20）：
 *   · 找回 = 把这条点子**追加进当前的便利贴**（与「选中」是同一个动作），
 *     而不是另建一张新便利贴 —— 否则反复找回会堆出一串重复的本子；
 *   · 清空待选箱是一次**物理删除**，清完不再找回。所以它必须二次确认、
 *     并写明不可撤销，绝不做成「顺手一点」。
 *
 * 每条点子都带着它那次抽卡的存档（引用了什么、当时要了几张），
 * 所以隔两周再打开，作者仍看得出这张卡是在什么前提下抽出来的。
 */
import { useState } from 'react'
import { Archive, CornerUpLeft, Trash2 } from 'lucide-react'

import type { StickyNote } from '../../shared/sticky-note'
import { mergeStickyAppendedBlocks, stickyNoteIdFromTabPath } from '../../shared/sticky-note'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { useStickyNoteStore } from '../../stores/sticky-note-store'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import { Button } from '../ui/Button'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'

interface Props {
  open: boolean
  onClose: () => void
}

export default function StickyTrayDialog({ open, onClose }: Props) {
  const text = useLocaleStore(s => s.text)
  const candidates = useStickyNoteStore(s => s.candidates)
  const notes = useStickyNoteStore(s => s.notes)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const [busy, setBusy] = useState(false)
  // v3「时尚杂志」是发丝直角，v2 保持原圆角（铁律三：显式分家，不许渗漏）。
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  const frameRadius = isMagazine(uiVersion) ? 2 : 'var(--radius-md)'

  /** 找回的目标：当前打开的那张便利贴优先，否则本子里的最后一张。 */
  const resolveTarget = (): StickyNote | null => {
    const activeTab = tabs.find(tab => tab.id === activeTabId)
    const activeNoteId = activeTab?.type === 'sticky-note'
      ? stickyNoteIdFromTabPath(activeTab.filePath)
      : null
    return notes.find(note => note.noteId === activeNoteId) ?? notes[notes.length - 1] ?? null
  }

  const recall = async (candidateId: string) => {
    if (busy) return
    setBusy(true)
    try {
      let target = resolveTarget()
      if (!target) {
        target = await useStickyNoteStore.getState().createNote('')
        if (!target) {
          toast.error(text('新建便利贴失败，无法找回', 'Could not create a note to recall into.'))
          return
        }
      }
      /**
       * 找回前先记下这张便利贴原来的正文。
       *
       * 追加是**纯接在末尾**的（appendStickyBlock），所以回来之后
       * 「新正文去掉旧前缀」就是这次新增的那一段 —— 作者手里若有未保存的改动，
       * 就靠它把新段落接上去（同 InspirationDrawDialog 的处理）。
       */
      const bodyBefore = useStickyNoteStore.getState().notes
        .find(note => note.noteId === target.noteId)?.body ?? ''
      const note = await useStickyNoteStore.getState().useCandidate(candidateId, target.noteId)
      if (!note) {
        toast.error(text('找回失败，请重试', 'Could not recall that idea. Please try again.'))
        return
      }
      const appendedBlock = note.body.startsWith(bodyBefore)
        ? note.body.slice(bodyBefore.length).replace(/^\s+/, '')
        : ''
      const editor = useEditorStore.getState()
      const tab = editor.tabs.find(item => (
        item.type === 'sticky-note' && stickyNoteIdFromTabPath(item.filePath) === note.noteId
      ))
      if (tab) {
        if (!tab.dirty) {
          editor.syncTabContent(tab.id, note.body)
          editor.markTabSaved(tab.id, note.body)
        } else if (appendedBlock) {
          // 作者手里还有没保存的改动：把找回的那一段接上去，绝不覆盖他在写的东西。
          editor.updateTabContent(tab.id, mergeStickyAppendedBlocks(tab.content ?? '', [appendedBlock]))
        }
      }
      toast.success(text('已找回，接在便利贴末尾', 'Recalled and appended to the note'))
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (busy || candidates.length === 0) return
    const ok = await confirm(
      text(
        `确认清空待选箱里的 ${candidates.length} 条点子？\n清空后不能再找回，此操作不可撤销。`,
        `Clear all ${candidates.length} ideas in the tray?\nThey cannot be recalled afterwards. This cannot be undone.`,
      ),
      {
        title: text('清空待选箱', 'Clear the tray'),
        confirmText: text('清空', 'Clear'),
        danger: true,
      },
    )
    if (!ok) return
    setBusy(true)
    try {
      const cleared = await useStickyNoteStore.getState().clearCandidates()
      if (cleared === null) {
        toast.error(text('清空失败，请重试', 'Could not clear the tray. Please try again.'))
        return
      }
      toast.success(text(`已清空 ${cleared} 条`, `Cleared ${cleared}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      // 同 InspirationDrawDialog：待选箱里也要能正常点、正常滚，
      // 而模态弹窗会锁焦点、锁指针、锁滚动，对 Portal 到 body 的浮层一律误伤。
      modal={false}
      onOpenChange={value => { if (!value) onClose() }}
    >
      <DialogContent
        className="max-w-[520px]"
        // 装着「可以找回来的东西」，误点蒙版关掉只是关窗、不会丢内容；
        // 但仍然按先生对参数窗的一贯要求：不靠点蒙版关闭。
        onPointerDownOutside={(event) => event.preventDefault()}
        // 失焦也不关 —— 与 InspirationDrawDialog 同因同治：Radix 的 DismissableLayer
        // 把「焦点落到层外」同样当作点到了外面，一样会自己收窗（2026-09-21 修）。
        onFocusOutside={(event) => event.preventDefault()}
      >
        {/* 同 InspirationDrawDialog：标头统一走 PageHead（朱砂眉标 → 衬线标题 → 次要色说明） */}
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('待选箱', 'Idea tray')}</DialogTitle>
          <PageHead
            kicker={text('IDEA TRAY · 待选箱', 'IDEA TRAY')}
            title={text('待选箱', 'Idea tray')}
            description={text(
              '抽卡时没选中的点子都留在这儿；「找回」会把它们接到便利贴末尾，清空之后就不再找得回来了。',
              'Ideas you did not pick stay here. “Recall” appends one to the end of your note; clearing is permanent.',
            )}
          />
        </DialogHeader>

        <div className="px-5 py-4">
          {candidates.length === 0 ? (
            <div className="text-xs py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
              {text('箱子是空的 —— 抽卡时没选中的点子会落在这里', 'Empty — unselected ideas from a draw land here.')}
            </div>
          ) : (
            <>
              <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
                {text(
                  `${candidates.length} 条待选 —— 找回会把它们接在便利贴末尾`,
                  `${candidates.length} kept — recalling appends them to your note`,
                )}
              </div>
              <div className="space-y-2" style={{ maxHeight: 380, overflowY: 'auto' }}>
                {candidates.map(candidate => (
                  <div
                    key={candidate.candidateId}
                    className="flex items-start gap-2"
                    style={{
                      padding: '8px 10px',
                      border: '1px solid var(--color-border)',
                      borderRadius: frameRadius,
                      backgroundColor: 'var(--color-panel)',
                    }}
                  >
                    <span className="text-xs whitespace-pre-wrap flex-1" style={{ color: 'var(--color-text)' }}>
                      {candidate.content}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => { void recall(candidate.candidateId) }}
                      title={text('找回：接在当前便利贴末尾', 'Recall: append to the current note')}
                    >
                      <CornerUpLeft size={11} />
                      {text('找回', 'Recall')}
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between items-center">
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {candidates.length > 0
              ? text('清空后不可找回', 'Clearing is permanent')
              : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              <Archive size={12} />
              {text('关闭', 'Close')}
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={busy || candidates.length === 0}
              onClick={() => { void clearAll() }}
            >
              <Trash2 size={13} />
              {text('清空待选箱', 'Clear tray')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
