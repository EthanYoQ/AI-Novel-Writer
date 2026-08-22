import { useState } from 'react'
import { AlertCircle, BookOpen, Loader2, Play } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import { createBatchChapterWorkflow, MAX_BATCH_CHAPTERS, MIN_BATCH_CHAPTERS, normalizeBatchChapterCount } from '../../services/workflows/batch-chapter-workflow'
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
      const guard = await guardChapterWriting(start, projectPath, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      const guardedGenerationModelId = availableGenerationModelId(
        useLLMStore.getState().models,
        selectedGenerationModelId,
      )
      if (!guardedGenerationModelId) {
        setError(text(
          '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
          'The selected writing model is no longer available. Select a compatible generation model and try again.',
        ))
        return
      }
      if (!guard.ok) {
        setError(guard.message || text('前置条件未满足。', 'Prerequisites are not met.'))
        return
      }

      const chapterNumbers = Array.from({ length: normalizedCount }, (_, index) => start + index)
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
      const frozenGenerationModelId = availableGenerationModelId(
        useLLMStore.getState().models,
        selectedGenerationModelId,
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
        startChapterNumber: start,
        chapterCount: normalizedCount,
        locale,
        generationModelId: frozenGenerationModelId,
      }))
      useLayoutStore.getState().openBottomTab('tasks')
      addLog('info', text(
        `已启动批量创作：第${start}–${end}章（共${normalizedCount}章）`,
        `Batch writing started: chapters ${start}–${end} (${normalizedCount} total).`,
      ))
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
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen size={16} className="text-[var(--color-accent)]" />
            {text('批量创作任务', 'Batch writing task')}
          </DialogTitle>
          <DialogDescription>
            {text(
              '按章节蓝图依次生成、自动定稿并完成后处理；不创建无限运行的全书任务。',
              'Creates chapters from their blueprints, finalizes them, and completes post-processing in order; it never starts an unbounded whole-book job.',
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
              <Label>{text('本次章节数', 'Chapters this run')}</Label>
              <Input
                type="number"
                min={MIN_BATCH_CHAPTERS}
                max={MAX_BATCH_CHAPTERS}
                value={chapterCount}
                onChange={(event) => setChapterCount(Number(event.target.value) || MIN_BATCH_CHAPTERS)}
                onBlur={() => setChapterCount(normalizeBatchChapterCount(chapterCount))}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="batch-writing-model">{text('本次创作模型', 'Writing model for this run')}</Label>
            <NativeSelect
              id="batch-writing-model"
              value={selectedGenerationModelId ?? ''}
              onChange={(event) => {
                setGenerationModelId(event.target.value || null)
                setError(null)
              }}
              disabled={generationModels.length === 0}
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
            <div>{text('任一后处理步骤最终失败时，任务立即停止，方便先修复数据再继续。', 'The task stops immediately when any post-processing step ultimately fails, so you can repair the data before continuing.')}</div>
          </div>

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
            {text('启动批量创作', 'Start batch writing')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
