import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'

import { clearProjectData, type ClearProjectDataOptions } from '../../services/project-clear-service'
import { alertError } from '../ui/AlertDialog'
import { Button } from '../ui/Button'
import { Check } from '../ui/Check'
import { useDialogFocusReturn } from '../ui/focus-return'
import { keepToastStackClickable } from '../ui/ToastStack'
import { usePaperInkRoot } from '../ui/use-paper-ink-root'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { useProjectStore } from '../../stores/project-store'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { pluralEn } from '../../shared/plural-en'

interface ClearProjectDataDialogProps {
  open: boolean
  onClose: () => void
  onCleared?: () => void | Promise<void>
}

type ClearKey = keyof ClearProjectDataOptions

const OPTIONS: Array<{
  key: ClearKey
  labelZh: string
  labelEn: string
  descZh: string
  descEn: string
}> = [
  {
    key: 'creativeFields',
    labelZh: '故事架构与大纲',
    labelEn: 'Story architecture and outline',
    descZh: '清空前提、世界观、角色卡与角色架构、情节大纲、文风分析与全局创作指导。',
    descEn: 'Clear premise, world building, character cards and architecture, plot outline, style analysis, and global guidance.',
  },
  {
    key: 'blueprints',
    labelZh: '章节蓝图',
    labelEn: 'Chapter blueprints',
    descZh: '清空所有章节蓝图与章节级规划，后续可重新生成。',
    descEn: 'Clear every chapter blueprint and chapter-level plan. You can generate them again later.',
  },
  {
    key: 'generatedText',
    labelZh: '草稿、定稿与审稿产物',
    labelEn: 'Drafts, manuscripts, and reviews',
    descZh: '清空草稿、定稿正文、修订、审稿报告、后处理记录与全局摘要快照。',
    descEn: 'Clear drafts, final manuscript text, revisions, review reports, post-processing records, and summary snapshots.',
  },
]

export default function ClearProjectDataDialog({
  open,
  onClose,
  onCleared,
}: ClearProjectDataDialogProps) {
  if (!open) return null

  return <ClearProjectDataDialogContents onClose={onClose} onCleared={onCleared} />
}

function ClearProjectDataDialogContents({
  onClose,
  onCleared,
}: Omit<ClearProjectDataDialogProps, 'open'>) {
  const [selected, setSelected] = useState<Record<ClearKey, boolean>>({
    creativeFields: true,
    blueprints: true,
    generatedText: true,
  })
  const currentProject = useProjectStore(s => s.currentProject)
  const [clearingSession, setClearingSession] = useState<ProjectSessionContext | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const sentinelRef = useRef<HTMLSpanElement>(null)
  // 挂在外壳的 .paper-ink 下，走标准危险确认
  const inkRoot = usePaperInkRoot(sentinelRef)
  const focusReturn = useDialogFocusReturn()
  const text = useLocaleStore(s => s.text)

  const selectedCount = useMemo(
    () => OPTIONS.filter(option => selected[option.key]).length,
    [selected],
  )
  const clearing = !!clearingSession && isProjectSessionCurrent(clearingSession)

  useEffect(() => {
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [])


  const handleClear = async () => {
    if (selectedCount === 0) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return

    setClearingSession(projectSession)
    try {
      await clearProjectData(selected, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      await onCleared?.()
      if (!isProjectSessionCurrent(projectSession)) return
      setClearingSession(null)
      onClose()
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      await alertError(displayedErrorMessage(useLocaleStore.getState().locale, error), { title: text('清除失败', 'Clear failed') })
      if (!isProjectSessionCurrent(projectSession)) return
      setClearingSession(null)
    }
  }

  if (!inkRoot) return <span ref={sentinelRef} hidden />

  const chosen = OPTIONS.filter(option => selected[option.key]).map(option => text(option.labelZh, option.labelEn))
  return (
    <DialogPrimitive.Root open onOpenChange={next => { if (!next && !clearing) onClose() }}>
      <DialogPrimitive.Portal container={inkRoot}>
        <DialogPrimitive.Overlay className="pi-scrim" />
        <DialogPrimitive.Content
          className="pi-dialog pi-dialog--marked"
          onPointerDownOutside={keepToastStackClickable}
          onOpenAutoFocus={event => {
            focusReturn.remember()
            event.preventDefault()
            cancelRef.current?.focus()
          }}
          onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        >
          <div className="pi-dialog-head">
            <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>
            <div className="pi-dialog-heading">
              <DialogPrimitive.Title className="pi-dialog-title">{text('清除项目生成内容', 'Clear generated project data')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="pi-dialog-sub">
                {text('此操作只清除所选数据，不删除项目目录或模型配置。', 'Only the selected data will be removed. The project folder and model settings are preserved.')}
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="pi-dialog-body">
            <div className="pi-check-list" role="group" aria-label={text('要清除的内容', 'Data to clear')}>
              {OPTIONS.map(({ key, labelZh, labelEn, descZh, descEn }) => (
                <div key={key} className="pi-check-row">
                  <Check
                    checked={selected[key]}
                    disabled={clearing}
                    onChange={checked => setSelected(current => ({ ...current, [key]: checked }))}
                    label={(
                      <>
                        <span className="pi-check-title">{text(labelZh, labelEn)}</span>
                        <span className="pi-check-desc">{text(descZh, descEn)}</span>
                      </>
                    )}
                  />
                </div>
              ))}
            </div>
            <div className="pi-dialog-consequence">
              <p>
                {selectedCount === 0
                  ? text('请至少选择一类内容。', 'Select at least one kind of data.')
                  : text(`将清除 ${selectedCount} 类内容：${chosen.join('、')}。`, `Clears ${selectedCount} ${pluralEn(selectedCount, 'kind')} of data: ${chosen.join(', ')}.`)}
              </p>
              <p className="pi-dialog-recover">{text('清除后不会自动恢复。', 'Cleared data is not restored automatically.')}</p>
              <p>{text('若需要保留当前内容，请先复制到外部文件或导出项目备份。', 'To keep the current content, copy it elsewhere or export a project backup first.')}</p>
            </div>
          </div>
          <div className="pi-dialog-foot">
            <Button ref={cancelRef} variant="secondary" disabled={clearing} onClick={onClose}>{text('取消', 'Cancel')}</Button>
            <Button
              variant="danger-solid"
              disabled={clearing || selectedCount === 0}
              aria-busy={clearing || undefined}
              onClick={handleClear}
            >
              {clearing ? text('清除中…', 'Clearing…') : text('清除所选', 'Clear selected')}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
