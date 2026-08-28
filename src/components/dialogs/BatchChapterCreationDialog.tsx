import { useState } from 'react'
import { AlertCircle, AlertTriangle, BookOpen, Loader2, Play } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import {
  createBatchChapterWorkflow,
  MAX_BATCH_CHAPTERS,
  MIN_BATCH_CHAPTERS,
  normalizeBatchChapterCount,
  type BatchChapterCompletionMode,
} from '../../services/workflows/batch-chapter-workflow'
import { guardChapterWriting } from '../../services/workflow-guards'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import type { ModelProfile } from '../../shared/ipc-channels'

interface Props {
  isOpen: boolean
  startChapterNumber: number | null
  onClose: () => void
}

function isGenerationModel(model: ModelProfile): boolean {
  return model.purposes.includes('generation')
}

function availableGenerationModelId(
  models: ModelProfile[],
  modelId: string | null | undefined,
): string | null {
  return modelId && models.some(model => model.id === modelId && isGenerationModel(model))
    ? modelId
    : null
}

function preferredGenerationModelId(models: ModelProfile[], defaultModelId: string | null): string | null {
  return availableGenerationModelId(models, defaultModelId)
    ?? models.find(isGenerationModel)?.id
    ?? null
}

/** 配置并启动受控批量创作任务（最多十章）。 */
export default function BatchChapterCreationDialog(props: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : 'inactive'

  // Fresh closed/open instances prevent a previous run's local model choice
  // from leaking into a later run, while still separating reopened leases.
  return <BatchChapterCreationDialogSession key={`${sessionKey}:${props.isOpen ? 'open' : 'closed'}`} {...props} />
}

function BatchChapterCreationDialogSession({ isOpen, startChapterNumber, onClose }: Props) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const isBatchRunning = useWorkflowStore(s => s.isTypeRunning('batch_generate'))
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const addLog = useWorkflowStore.getState().addLog
  const [chapterCount, setChapterCount] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [completionMode, setCompletionMode] = useState<BatchChapterCompletionMode>('draft_review')
  const [confirmingAutoFinalize, setConfirmingAutoFinalize] = useState(false)
  const [generationModelId, setGenerationModelId] = useState<string | null>(() => (
    preferredGenerationModelId(models, defaultModelId)
  ))

  const normalizedCount = normalizeBatchChapterCount(chapterCount)
  const start = startChapterNumber ?? 1
  const end = start + normalizedCount - 1
  const generationModels = models.filter(isGenerationModel)
  const fallbackGenerationModelId = preferredGenerationModelId(models, defaultModelId)
  const selectedGenerationModelId = generationModelId ?? fallbackGenerationModelId
  const selectedGenerationModel = generationModels.find(model => model.id === selectedGenerationModelId)
  const modelSelectionError = generationModels.length === 0
    ? text(
      '没有已配置且可用于文本生成的模型。请在设置中添加或启用一项生成模型。',
      'No configured model can generate text. Add or enable a generation model in Settings.',
    )
    : !selectedGenerationModel
      ? text(
        '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
        'The selected writing model is no longer available. Select a compatible generation model and try again.',
      )
      : null

  const handleStart = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const projectPath = projectSession.projectPath
    if (completionMode === 'auto_finalize' && !confirmingAutoFinalize) {
      setConfirmingAutoFinalize(true)
      setError(null)
      return
    }
    if (modelSelectionError || !selectedGenerationModel) {
      setError(modelSelectionError ?? text(
        '请选择一项可用于文本生成的模型。',
        'Select a compatible generation model before starting.',
      ))
      return
    }
    if (isBatchRunning) {
      setError(text('已有批量创作任务正在执行。', 'A batch writing task is already running.'))
      return
    }

    setStarting(true)
    try {
      const frozenCompletionMode = completionMode
      const frozenLocale = locale
      const frozenStart = start
      const frozenChapterCount = normalizedCount
      const frozenEnd = end
      const frozenSelectedGenerationModelId = selectedGenerationModelId
      const chapterNumbers = Array.from({ length: frozenChapterCount }, (_, index) => frozenStart + index)
      const blueprints = await Promise.all(
        chapterNumbers.map((chapterNumber) => ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-get',
          chapterNumber,
          projectPath,
        )),
      )
      if (!isProjectSessionCurrent(projectSession)) return
      const missingChapter = blueprints.findIndex((blueprint) => !blueprint)
      if (missingChapter >= 0) {
        const chapterNumber = chapterNumbers[missingChapter]
        setError(text(
          `未找到第${chapterNumber}章蓝图。请先补齐连续蓝图后再启动批量创作。`,
          `No blueprint was found for chapter ${chapterNumber}. Complete the consecutive blueprints first.`,
        ))
        return
      }

      if (!isProjectSessionCurrent(projectSession)) return
      const guard = await guardChapterWriting(frozenStart, projectPath, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!guard.ok) {
        setError(frozenLocale === 'en-US'
          ? 'Writing prerequisites are not met. Complete the project setup and previous finalized chapter before starting.'
          : guard.message || '前置条件未满足。')
        return
      }

      const frozenGenerationModelId = availableGenerationModelId(
        useLLMStore.getState().models,
        frozenSelectedGenerationModelId,
      )
      if (!frozenGenerationModelId) {
        setError(text(
          '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
          'The selected writing model is no longer available. Select a compatible generation model and try again.',
        ))
        return
      }
      startWorkflow(createBatchChapterWorkflow({
        projectPath,
        projectSession,
        startChapterNumber: frozenStart,
        chapterCount: frozenChapterCount,
        locale: frozenLocale,
        generationModelId: frozenGenerationModelId,
        completionMode: frozenCompletionMode,
      }))
      useLayoutStore.getState().openBottomTab('tasks')
      addLog('info', frozenCompletionMode === 'draft_review'
        ? (frozenLocale === 'en-US'
          ? `Batch review drafts started: chapters ${frozenStart}–${frozenEnd} (${frozenChapterCount} total).`
          : `已启动批量草稿待审：第${frozenStart}–${frozenEnd}章（共${frozenChapterCount}章）`)
        : (frozenLocale === 'en-US'
          ? `Batch auto-finalize started: chapters ${frozenStart}–${frozenEnd} (${frozenChapterCount} total).`
          : `已启动批量自动定稿：第${frozenStart}–${frozenEnd}章（共${frozenChapterCount}章）`))
      onClose()
    } catch (cause) {
      if (!isProjectSessionCurrent(projectSession)) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
    } finally {
      if (isProjectSessionCurrent(projectSession)) setStarting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && !starting) {
        setError(null)
        onClose()
      }
    }}>
      <DialogContent className="max-h-[90vh] max-w-[520px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen size={16} className="text-[var(--color-accent)]" />
            {text('批量创作任务', 'Batch writing task')}
          </DialogTitle>
          <DialogDescription>
            {text(
              '按章节蓝图连续生成内容，并选择保留可编辑草稿或自动定稿。',
              'Generate consecutive chapters from their blueprints, then keep editable drafts or finalize them automatically.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{text('起始章节', 'Starting chapter')}</Label>
              <div className="h-9 flex items-center px-3 rounded-md border text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
                {text(`第${start}章`, `Chapter ${start}`)}
              </div>
            </div>
            <div>
              <Label htmlFor="batch-chapter-count">{text('本次章节数', 'Chapters this run')}</Label>
              <Input
                id="batch-chapter-count"
                type="number"
                min={MIN_BATCH_CHAPTERS}
                max={MAX_BATCH_CHAPTERS}
                value={chapterCount}
                disabled={starting}
                onChange={(event) => {
                  setChapterCount(Number(event.target.value) || MIN_BATCH_CHAPTERS)
                  setConfirmingAutoFinalize(false)
                }}
                onBlur={() => setChapterCount(normalizeBatchChapterCount(chapterCount))}
              />
            </div>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-xs font-medium" style={{ color: 'var(--color-text)' }}>
              {text('完成模式', 'Completion mode')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: completionMode === 'draft_review' ? 'var(--color-accent)' : 'var(--color-border)', backgroundColor: completionMode === 'draft_review' ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent' }}>
                <input
                  type="radio"
                  name="batch-completion-mode"
                  value="draft_review"
                  checked={completionMode === 'draft_review'}
                  onChange={() => {
                    setCompletionMode('draft_review')
                    setConfirmingAutoFinalize(false)
                    setError(null)
                  }}
                  disabled={starting}
                />
                <span>
                  <span className="block font-medium">{text('生成草稿待审', 'Generate review drafts')}</span>
                  <span className="mt-0.5 block" style={{ color: 'var(--color-text-muted)' }}>
                    {text('保留可编辑草稿，继续审稿与修稿。', 'Keep editable drafts for review and revision.')}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: completionMode === 'auto_finalize' ? 'var(--color-warning)' : 'var(--color-border)', backgroundColor: completionMode === 'auto_finalize' ? 'color-mix(in srgb, var(--color-warning) 8%, transparent)' : 'transparent' }}>
                <input
                  type="radio"
                  name="batch-completion-mode"
                  value="auto_finalize"
                  checked={completionMode === 'auto_finalize'}
                  onChange={() => {
                    setCompletionMode('auto_finalize')
                    setConfirmingAutoFinalize(false)
                    setError(null)
                  }}
                  disabled={starting}
                />
                <span>
                  <span className="block font-medium">{text('自动定稿', 'Auto-finalize')}</span>
                  <span className="mt-0.5 block" style={{ color: 'var(--color-text-muted)' }}>
                    {text('立即定稿并运行全部后处理。', 'Finalize immediately and run all post-processing.')}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <div>
            <Label htmlFor="batch-writing-model">{text('本次创作模型', 'Writing model for this run')}</Label>
            <NativeSelect
              id="batch-writing-model"
              value={selectedGenerationModelId ?? ''}
              onChange={(event) => {
                setGenerationModelId(event.target.value || null)
                setConfirmingAutoFinalize(false)
                setError(null)
              }}
              disabled={starting || generationModels.length === 0}
            >
              <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
              {generationModels.map(model => (
                <option key={model.id} value={model.id}>{model.name || model.modelName}</option>
              ))}
            </NativeSelect>
            <p className="mt-1 text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
              {text('仅用于本次创作，不会更改默认模型。', 'Used for this run only; it does not change the default model.')}
            </p>
          </div>

          <div className="rounded-md px-3 py-2 text-xs space-y-1.5" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}>
            <div>{text(`范围：第${start}–${end}章（共${normalizedCount}章，最高${MAX_BATCH_CHAPTERS}章）`, `Range: chapters ${start}–${end} (${normalizedCount} total; maximum ${MAX_BATCH_CHAPTERS}).`)}</div>
            <div>{text('暂停会在当前章节安全完成后生效；取消会阻止下一章启动。', 'Pause takes effect after the current chapter reaches a safe boundary; cancel prevents the next chapter from starting.')}</div>
            <div>{completionMode === 'draft_review'
              ? text('完成后可从草稿箱进入 AI 审稿、人工确认和修稿闭环。', 'After completion, continue from Drafts into AI review, author confirmation, and revision.')
              : text('任一后处理步骤最终失败时，任务立即停止，方便先修复数据再继续。', 'The task stops immediately when any post-processing step ultimately fails, so you can repair the data before continuing.')}</div>
          </div>

          {completionMode === 'auto_finalize' && (
            <div className="flex items-start gap-2 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'color-mix(in srgb, var(--color-warning) 12%, transparent)', color: 'var(--color-text)' }}>
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-warning)' }} aria-hidden="true" />
              <div className="space-y-1">
                <p>{text(
                  '自动定稿会跳过逐章审稿确认，并把章节提交为只读正文；同时发布实体稿并运行角色与连续性后处理。',
                  'Auto-finalize skips chapter-by-chapter review confirmation, commits read-only chapters, publishes manuscript files, and runs character and continuity post-processing.',
                )}</p>
                {confirmingAutoFinalize && (
                  <p className="font-medium">{text(
                    `即将自动定稿第${start}–${end}章（共${normalizedCount}章）。完成后章节只读，不能直接编辑。`,
                    `You are about to auto-finalize Chapters ${start}–${end} (${normalizedCount} total). Completed chapters are read-only and cannot be edited directly.`,
                  )}</p>
                )}
              </div>
            </div>
          )}

          {(modelSelectionError ?? error) && (
            <div className="flex items-start gap-2 rounded-md px-3 py-2 text-xs" style={{ backgroundColor: 'color-mix(in srgb, var(--color-error) 12%, transparent)', color: 'var(--color-error-text)' }}>
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{modelSelectionError ?? error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={starting}>
            {text('取消', 'Cancel')}
          </Button>
          <Button variant="ai" onClick={handleStart} disabled={starting || isBatchRunning || startChapterNumber === null || !!modelSelectionError}>
            {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {completionMode === 'draft_review'
              ? text('启动批量创作', 'Start batch writing')
              : confirmingAutoFinalize
                ? text('确认自动定稿并启动', 'Confirm auto-finalize and start')
                : text('继续确认自动定稿', 'Review auto-finalize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
