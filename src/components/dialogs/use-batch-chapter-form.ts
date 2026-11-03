import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import {
  createBatchChapterWorkflow,
  normalizeBatchChapterCount,
  type BatchChapterCompletionMode,
} from '../../services/workflows/batch-chapter-workflow'
import { guardChapterWriting } from '../../services/workflow-guards'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { routeStageModel } from '../../shared/model-stage-routing'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import { readAuthoritativeNextChapter } from '../../services/authoritative-chapter-sequence'
import { readConsistencyPreflight, type ConsistencyPreflightResult } from '../../services/consistency-preflight'
import { requireIpcSuccess } from '../../services/ipc-result'
import { normalizeChapterWordsTarget } from '../../services/workflows/chapter-creation-parameters'
import {
  availableGenerationModelId,
  generationModelError,
  isGenerationModel,
  preferredGenerationModelId,
} from '../../services/workflows/chapter-write-launch'
import { displayedErrorMessage } from '../../i18n/app-errors'

export interface BatchChapterProps {
  isOpen: boolean
  startChapterNumber: number | null
  onClose: () => void
}

/**
 * 批量创作对话框的表单：起始章、章数、每章目标、完成模式（自动定稿要再确认一次）、本次模型与一致性预检。
 * 批量写稿对话框用它；每次打开都应是新的实例，见对话框的会话包装。
 */
export function useBatchChapterForm({ isOpen, startChapterNumber, onClose }: BatchChapterProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const models = useLLMStore(s => s.models)
  const draftingModelId = useLLMStore(s => routeStageModel('drafting', s).modelId)
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const addLog = useWorkflowStore.getState().addLog
  // 允许暂时为空：清空后重新输入时不被立刻填回 1；失焦时与开始写时再规整。
  const [chapterCount, setChapterCount] = useState<number | ''>(1)
  const [chapterWordsTarget, setChapterWordsTarget] = useState<number | ''>(() => (
    normalizeChapterWordsTarget(currentProject?.novelConfig.wordsPerChapter)
  ))
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [completionMode, setCompletionMode] = useState<BatchChapterCompletionMode>('draft_review')
  const [confirmingAutoFinalize, setConfirmingAutoFinalize] = useState(false)
  const [authoritativeStart, setAuthoritativeStart] = useState<number | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  const [authorityLoading, setAuthorityLoading] = useState(false)
  const [consistencyPreflight, setConsistencyPreflight] = useState<ConsistencyPreflightResult | null>(null)
  const [generationModelId, setGenerationModelId] = useState<string | null>(() => (
    preferredGenerationModelId(models, draftingModelId)
  ))

  const normalizedCount = normalizeBatchChapterCount(chapterCount)
  const start = authoritativeStart ?? startChapterNumber ?? 1
  const end = start + normalizedCount - 1
  const generationModels = models.filter(isGenerationModel)
  const fallbackGenerationModelId = preferredGenerationModelId(models, draftingModelId)
  const selectedGenerationModelId = generationModelId ?? fallbackGenerationModelId
  const selectedGenerationModel = generationModels.find(model => model.id === selectedGenerationModelId)
  const modelSelectionError = generationModelError(models, selectedGenerationModelId, text)

  useEffect(() => {
    if (!isOpen) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    let disposed = false
    const loadAuthority = async () => {
      setAuthorityLoading(true)
      try {
        const nextChapter = await readAuthoritativeNextChapter(projectSession, locale)
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeStart(nextChapter)
        setAuthorityError(null)
      } catch (cause) {
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeStart(null)
        setAuthorityError(displayedErrorMessage(useLocaleStore.getState().locale, cause))
      } finally {
        if (!disposed && isProjectSessionCurrent(projectSession)) setAuthorityLoading(false)
      }
    }
    void loadAuthority()
    return () => { disposed = true }
  }, [currentProject, isOpen, locale])

  useEffect(() => {
    if (!isOpen) return
    const session = captureProjectSession(currentProject)
    if (!session) return
    void ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath)
      .then(exemptions => {
        if (isProjectSessionCurrent(session) && exemptions.some(item => !item.revoked)) {
          setConsistencyPreflight({ findings: [], exemptions })
        }
      })
  }, [currentProject, isOpen])

  const handleStart = async (ignoreFindingsOnce = false) => {
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
    setStarting(true)
    try {
      const frozenStart = await readAuthoritativeNextChapter(projectSession, locale)
      if (!isProjectSessionCurrent(projectSession)) return
      setAuthoritativeStart(frozenStart)
      setAuthorityError(null)
      const frozenCompletionMode = completionMode
      const frozenLocale = locale
      const frozenChapterCount = normalizedCount
      const frozenChapterWordsTarget = normalizeChapterWordsTarget(
        chapterWordsTarget,
        currentProject?.novelConfig.wordsPerChapter,
      )
      const frozenEnd = frozenStart + frozenChapterCount - 1
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

      if (!ignoreFindingsOnce) {
        try {
          const preflight = await readConsistencyPreflight(
            projectSession,
            blueprints.filter((blueprint): blueprint is NonNullable<typeof blueprint> => !!blueprint),
          )
          if (!isProjectSessionCurrent(projectSession)) return
          setConsistencyPreflight(preflight)
          if (preflight.findings.length > 0) return
        } catch {
          if (!isProjectSessionCurrent(projectSession)) return
          addLog('info', text(
            '一致性证据暂时不可用；本次批量创作仍会继续。',
            'Continuity evidence is temporarily unavailable; batch writing will continue.',
          ))
        }
      }
      setConsistencyPreflight(null)

      if (!isProjectSessionCurrent(projectSession)) return
      const guard = await guardChapterWriting(frozenStart, projectPath, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!guard.ok) {
        setError(frozenLocale === 'en-US'
          ? 'Writing prerequisites are not met. Complete the project setup and previous finalized chapter before starting.'
          : displayedErrorMessage(frozenLocale, guard.message, '前置条件未满足。'))
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
      const workflow = createBatchChapterWorkflow({
        projectPath,
        projectSession,
        startChapterNumber: frozenStart,
        chapterCount: frozenChapterCount,
        locale: frozenLocale,
        generationModelId: frozenGenerationModelId,
        chapterWordsTarget: frozenChapterWordsTarget,
        completionMode: frozenCompletionMode,
      })
      const conflict = useWorkflowStore.getState().getResourceConflict(workflow)
      if (conflict) {
        setError(workflowResourceConflictMessage(frozenLocale, conflict.title))
        return
      }
      void startWorkflow(workflow)
      navigate({ kind: 'run', facet: 'tasks' })
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
      const message = displayedErrorMessage(useLocaleStore.getState().locale, cause)
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID') {
        setAuthorityError(message)
      } else {
        setError(message)
      }
    } finally {
      if (isProjectSessionCurrent(projectSession)) setStarting(false)
    }
  }

  /** 保存或撤销一致性安排：进行中按钮不可再点，失败时在对话框里写明原因。返回是否成功。 */
  const changeArrangement = async (action: string, call: (session: ProjectSessionContext) => Promise<{ success: boolean; error?: string }>) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || starting) return false
    setStarting(true)
    setError(null)
    try {
      requireIpcSuccess(await call(session), action)
      return true
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(displayedErrorMessage(useLocaleStore.getState().locale, cause))
      return false
    } finally {
      setStarting(false)
    }
  }

  const saveArrangement = async (stableFactKey: string, reason: string) => {
    const saved = await changeArrangement(text('保存一致性安排', 'Save consistency arrangement'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-save', stableFactKey, reason, session.projectPath))
    if (saved) await handleStart(false)
  }

  const revokeArrangement = async (stableFactKey: string) => {
    const revoked = await changeArrangement(text('撤销一致性安排', 'Revoke consistency arrangement'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', stableFactKey, session.projectPath))
    if (!revoked) return
    setConsistencyPreflight(current => current ? {
      ...current,
      exemptions: current.exemptions.map(item => item.stableFactKey === stableFactKey ? { ...item, revoked: true } : item),
    } : null)
  }

  return {
    text, currentProject, chapterCount, setChapterCount, chapterWordsTarget, setChapterWordsTarget, error, setError, starting,
    completionMode, setCompletionMode, confirmingAutoFinalize, setConfirmingAutoFinalize, authorityError, authorityLoading,
    consistencyPreflight, generationModels, selectedGenerationModelId, setGenerationModelId, modelSelectionError,
    normalizedCount, start, end, handleStart, saveArrangement, revokeArrangement,
  }
}
