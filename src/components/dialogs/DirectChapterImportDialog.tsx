import { useState, useEffect, useRef, useMemo } from 'react'
import { FilePlus2, AlertCircle } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import {
  useWorkflowStore,
  workflowResourceKey,
  workflowResourceConflictMessage,
} from '../../stores/workflow-store'
import { readAuthoritativeNextChapter } from '../../services/authoritative-chapter-sequence'
import { createPastedDraft } from '../../services/direct-draft-creation'
import { countDraftUnits } from '../../shared/draft-units'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { useLocaleStore } from '../../stores/locale-store'
import { toast } from '../ui/Toast'
import { ChapterCreationLoadGate } from './chapter-creation-load-gate'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'

interface Props {
  isOpen: boolean
  onClose: () => void
}

/** 直接新增章节对话框 — 粘贴别处写好的正文，直接存为可编辑草稿 */
export default function DirectChapterImportDialog(props: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : 'inactive'

  // 每次打开重挂载内层，保证状态快照干净（与 ChapterCreationDialog 一致）
  return <DirectChapterImportDialogSession key={`${sessionKey}:${props.isOpen ? 'open' : 'closed'}`} {...props} />
}

function DirectChapterImportDialogSession({ isOpen, onClose }: Props) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const [chapterNumber, setChapterNumber] = useState<number | ''>(1)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [guardError, setGuardError] = useState<string | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  const [authorityLoading, setAuthorityLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const loadGate = useRef(new ChapterCreationLoadGate())
  const wordCount = useMemo(() => countDraftUnits(content), [content])

  // 打开时以权威定稿事实源确定默认章节号
  useEffect(() => {
    if (!isOpen || !currentProject) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const gate = loadGate.current
    const requestToken = gate.begin(projectSession.projectPath)
    const isCurrentRequest = () => gate.isCurrent(
      requestToken,
      useProjectStore.getState().currentProject?.path,
    ) && isProjectSessionCurrent(projectSession)
    const initialize = async () => {
      setAuthorityLoading(true)
      let nextChapterNumber: number
      try {
        nextChapterNumber = await readAuthoritativeNextChapter(projectSession, locale)
      } catch (error) {
        if (!isCurrentRequest()) return
        setAuthorityError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        if (isCurrentRequest()) setAuthorityLoading(false)
      }
      if (!isCurrentRequest()) return
      setAuthorityError(null)
      setChapterNumber(nextChapterNumber)
    }
    void initialize()
    return () => {
      gate.invalidate(requestToken)
    }
  }, [isOpen, currentProject, locale])

  const handleSubmit = async () => {
    const targetChapter = Number(chapterNumber)
    if (!Number.isSafeInteger(targetChapter) || targetChapter < 1) {
      setGuardError(text('章节号必须是正整数。', 'The chapter number must be a positive integer.'))
      return
    }
    if (!content.trim()) {
      setGuardError(text('正文不能为空：请粘贴章节内容后再保存。', 'The chapter body is empty. Paste the chapter text before saving.'))
      return
    }
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const projectPath = projectSession.projectPath
    setGuardError(null)
    setSubmitting(true)
    try {
      // 同步冲突检查：同章已有 AI 工作流占用时阻断
      const resourceConflict = useWorkflowStore.getState().getResourceConflict({
        projectPath,
        resourceKeys: [workflowResourceKey('chapter', targetChapter)],
        readResourceKeys: [],
      })
      if (resourceConflict) {
        setGuardError(workflowResourceConflictMessage(locale, resourceConflict.title))
        return
      }

      // 提交前重读权威序，防止对话框打开期间定稿状态变化
      let authoritativeNextChapter: number
      try {
        authoritativeNextChapter = await readAuthoritativeNextChapter(projectSession, locale)
      } catch (error) {
        if (!isProjectSessionCurrent(projectSession)) return
        setAuthorityError(error instanceof Error ? error.message : String(error))
        return
      }
      if (!isProjectSessionCurrent(projectSession)) return
      setAuthorityError(null)
      if (targetChapter !== authoritativeNextChapter) {
        setGuardError(text(
          `当前权威定稿之后只能新增第 ${authoritativeNextChapter} 章。请先完成此前章节的定稿，或修改章节号。`,
          `Only Chapter ${authoritativeNextChapter} can be added after the current finalized authority. Finalize earlier chapters first, or change the chapter number.`,
        ))
        return
      }

      const result = await createPastedDraft({
        projectSession,
        chapterNumber: targetChapter,
        title,
        content,
      })
      if (!isProjectSessionCurrent(projectSession)) return
      if (!result) return
      toast.success(text(
        `已保存 第${targetChapter}章 草稿 v${result.version}，可在编辑器中继续修改与定稿。`,
        `Saved Chapter ${targetChapter} draft v${result.version}. Continue editing and finalize in the editor.`,
      ))
      onClose()
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePlus2 size={16} className="text-[var(--color-accent)]" />
            {text('直接新增章节', 'Paste a new chapter')}
          </DialogTitle>
          <DialogDescription>
            {text('粘贴在别处写好的章节正文，保存为可编辑草稿；定稿仍走编辑器中的正常流程。', 'Paste a chapter written elsewhere and save it as an editable draft. Finalization still follows the normal editor flow.')}
          </DialogDescription>
        </DialogHeader>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{text('章节号', 'Chapter number')}</Label>
              <Input
                type="number"
                value={chapterNumber}
                onChange={(e) => setChapterNumber(e.target.value === '' ? '' : parseInt(e.target.value))}
                onBlur={() => {
                  const v = Number(chapterNumber)
                  if (!v || v < 1) setChapterNumber(1)
                }}
                placeholder="1"
                min={1}
              />
            </div>
            <div>
              <Label>{text('章节标题', 'Chapter title')} <span className="text-[0.7rem] opacity-50">{text('（可选）', '(optional)')}</span></Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={text('如：风起云涌', 'e.g. Winds Rise')} />
            </div>
          </div>

          <div>
            <Label>{text('章节正文', 'Chapter body')}</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={text('粘贴本章完整正文...', 'Paste the full chapter text here...')}
              rows={14}
            />
            <p className="mt-1 text-[0.7rem] text-right" style={{ color: 'var(--color-text-muted)' }}>
              {text(`当前 ${wordCount} 字`, `${wordCount} units`)}
            </p>
          </div>
        </div>

        <DialogFooter className="sm:justify-between items-center">
          <span className="text-xs mt-2 sm:mt-0" style={{ color: 'var(--color-text-muted)' }}>
            {text('保存为草稿：不经过 AI 生成，可继续编辑后定稿。', 'Saved as a draft: no AI generation; edit and finalize later.')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>{text('取消', 'Cancel')}</Button>
            <Button variant="ai" size="lg" onClick={() => void handleSubmit()} disabled={authorityLoading || submitting || !!authorityError}>
              <span className="flex items-center gap-2">
                <FilePlus2 size={13} />
                {text('保存为草稿', 'Save draft')}
              </span>
            </Button>
          </div>
        </DialogFooter>
        {/* 校验失败提示（呈现在 Footer 下方） */}
        {(authorityError ?? guardError) && (
          <div className="mx-5 mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs bg-yellow-500/10 border border-yellow-500/30 text-[var(--color-warning-text)]">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5 text-[var(--color-warning)]" />
            <span className="whitespace-pre-line">{authorityError ?? guardError}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
