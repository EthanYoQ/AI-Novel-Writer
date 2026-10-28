import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { createBatchRecoveryWorkflow, createDraftRecoveryWorkflow } from '../../services/workflows/draft-recovery-workflow'
import { createReviewRevisionRecoveryWorkflow } from '../../services/workflows/review-revision-recovery-workflow'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { openPlanningRecoveryDraft, useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowDefinition } from '../../stores/workflow-store'
import {
  buildRecoveryEntries, EMPTY_RECOVERY_SOURCES, planningTitle,
  type BatchEntry, type CandidateEntry, type DraftEntry, type EditorEntry, type PlanningEntry, type RecoveryEntry, type RecoverySources, type ReviewEntry,
} from './run-recovery'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { hideRecovery, readHiddenRecovery } from './hidden-recovery'
import { projectRuns } from './run-output'
import type { GenerationRecoveryList } from '../../shared/generation-owner-contract'

/** 这部作品有工作流正在发生成请求；暂停与等确认的不算。 */
function workflowWriting(projectPath: string | undefined, runs = useWorkflowStore.getState().activeRuns): boolean {
  return projectRuns(runs, projectPath).some(run => run.status === 'running' || run.status === 'cancelling')
}

function currentSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

/** 读到的数据连同读取时的会话一起保存；换了会话，旧数据就不再显示也不能被操作。 */
interface Loaded<T> {
  session: ProjectSessionContext | null
  value: T
}

export interface RunRecovery {
  entries: RecoveryEntry[]
  /** 旧恢复候选表的读取或操作失败。 */
  candidateError: string
  /** 中断运行的读取或操作失败。 */
  generationError: string
  busy: boolean
  picked: (entry: DraftEntry) => readonly string[]
  togglePick: (entry: DraftEntry, artifactId: string, checked: boolean) => void
  /** 复制一段生成文字；失败写进 generationError。 */
  copy: (text: string) => void
  copyCandidate: (entry: CandidateEntry) => void
  continueCandidate: (entry: CandidateEntry) => void
  discardCandidate: (entry: CandidateEntry) => void
  openPlanning: (entry: PlanningEntry) => void
  continueEditor: (entry: EditorEntry) => void
  resumeReview: (entry: ReviewEntry) => void
  resumeBatch: (entry: BatchEntry) => void
  resumeDraft: (entry: DraftEntry) => void
  /** 这张候选卡在这部作品里不再显示；生成记录不动。 */
  hideDraft: (entry: DraftEntry) => void
}

/**
 * 运行侧页的恢复区：数据与动作。每个动作开始前确认仍是读取时的那次项目会话，
 * 换了作品或重开过就什么也不做，不把旧会话的恢复写进新会话。
 */
export function useRunRecovery(): RunRecovery {
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const session = useMemo(() => projectSessionContextFromProject(project), [project])
  /** 最近结束的那次运行：历史最多留 50 条，满了以后条数不再变，只能看最前面那条。 */
  const lastEnded = useWorkflowStore(s => s.history[0] ? `${s.history[0].id}:${s.history[0].completedAt ?? ''}` : '')
  const [candidateList, setCandidates] = useState<Loaded<RecoverySources['candidates']>>({ session: null, value: [] })
  const [candidateError, setCandidateError] = useState('')
  const [generationList, setGeneration] = useState<Loaded<GenerationRecoveryList>>({ session: null, value: { ...EMPTY_RECOVERY_SOURCES, partial: false } })
  const [generationError, setGenerationError] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)
  const writing = useWorkflowStore(s => workflowWriting(session?.projectPath, s.activeRuns))
  const missedWhileWriting = useRef(false)
  const [selection, setSelection] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const projectId = session?.projectId
  const hiddenEarlier = useMemo(() => projectId ? readHiddenRecovery(projectId) : new Set<string>(), [projectId])
  const [hiddenNow, setHiddenNow] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!session) {
      const clear = window.setTimeout(() => setCandidateError(''), 0)
      return () => window.clearTimeout(clear)
    }
    let active = true
    void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-list', session.projectPath).then(list => {
      if (!active || !sameProjectSessionContext(session, currentSession())) return
      setCandidates({ session, value: list })
      setCandidateError('')
    }).catch(error => {
      if (!active) return
      setCandidates({ session, value: [] })
      setCandidateError(displayedErrorMessage(useLocaleStore.getState().locale, error))
    })
    return () => { active = false }
  }, [session])

  /**
   * 工作流之外的生成（选区建议）结束时没有运行历史可看，靠它的最后一次快照触发重读。
   * 这部作品有工作流正在写时只记下来：批量写作每次尝试都会结束一次，逐次重读又回到整表重算；
   * 等工作流停下（暂停、等确认或结束）时补读一次。
   */
  useEffect(() => {
    if (!session) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = ipc.on('generation:snapshot', snapshot => {
      if (snapshot.projectId !== session.projectId || snapshot.epoch !== session.leaseId || snapshot.status === 'running') return
      if (workflowWriting(session.projectPath)) { missedWhileWriting.current = true; return }
      clearTimeout(timer)
      timer = setTimeout(() => setRefreshTick(value => value + 1), 100)
    })
    return () => { detach(); clearTimeout(timer) }
  }, [session])

  /** 侧页打开、运行结束或恢复动作之后重读；工作流写作中的每次尝试快照不触发，主进程不必反复整表重算。 */
  useEffect(() => {
    if (!session) return
    let active = true
    missedWhileWriting.current = false
    void ipc.invokeWithProjectSession(session, 'generation:list-recovery').then(list => {
      if (!active) return
      setGeneration({ session, value: list })
      setGenerationError('')
    }).catch(reason => { if (active) setGenerationError(displayedErrorMessage(useLocaleStore.getState().locale, reason)) })
    return () => { active = false }
  }, [session, lastEnded, refreshTick])

  useEffect(() => {
    if (writing || !missedWhileWriting.current) return
    missedWhileWriting.current = false
    setRefreshTick(value => value + 1)
  }, [writing])

  const entries = useMemo(() => {
    if (!session) return []
    const ofSession = <T,>(loaded: Loaded<T>, empty: T) => sameProjectSessionContext(loaded.session, session) ? loaded.value : empty
    return buildRecoveryEntries({ ...ofSession(generationList, { ...EMPTY_RECOVERY_SOURCES, partial: false }), candidates: ofSession(candidateList, []) }, locale)
      .filter(entry => entry.kind !== 'draft' || !hiddenEarlier.has(entry.key) && !hiddenNow.has(entry.key))
  }, [session, generationList, candidateList, locale, hiddenEarlier, hiddenNow])

  const stillCurrent = useCallback(() => session !== null && sameProjectSessionContext(session, currentSession()), [session])

  const act = useCallback(async (operation: (session: ProjectSessionContext) => Promise<void>) => {
    if (busy || !session || !stillCurrent()) return
    setBusy(true)
    try { await operation(session); setGenerationError('') } catch (reason) { setGenerationError(displayedErrorMessage(useLocaleStore.getState().locale, reason)) }
    finally { setBusy(false) }
  }, [busy, session, stillCurrent])

  const showGenerationFailure = useCallback((reason: unknown) => {
    if (stillCurrent()) setGenerationError(displayedErrorMessage(useLocaleStore.getState().locale, reason))
  }, [stillCurrent])

  /** startWorkflow 要等整个工作流结束才返回；只等定义建好，不让恢复区在运行期间一直忙。 */
  const startRecovery = useCallback((create: (session: ProjectSessionContext) => Promise<WorkflowDefinition>) =>
    void act(async current => {
      const definition = await create(current)
      if (stillCurrent()) useWorkflowStore.getState().startWorkflow(definition).catch(showGenerationFailure)
    }), [act, stillCurrent, showGenerationFailure])

  const dropCandidate = (candidateId: string) => {
    setCandidates(loaded => ({ ...loaded, value: loaded.value.filter(item => item.candidateId !== candidateId) }))
    setCandidateError('')
  }

  /** 结果晚到时界面语言可能已切换，按显示这一刻的语言写。 */
  const failCandidate = useCallback((error: unknown) => {
    if (!stillCurrent()) return
    const { locale: shown, text } = useLocaleStore.getState()
    setCandidateError(displayedErrorMessage(shown, error, text('恢复候选操作失败', 'Recovery candidate action failed')))
  }, [stillCurrent])

  return {
    entries,
    candidateError,
    generationError: generationError || (sameProjectSessionContext(generationList.session, session) && generationList.value.partial ? (locale === 'en-US' ? 'Some tasks could not be loaded; the other candidates remain available.' : '部分任务暂时无法读取，其他候选仍可恢复。') : ''),
    busy,
    picked: entry => selection[entry.key] ?? [],
    togglePick: (entry, artifactId, checked) => setSelection(previous => {
      const current = previous[entry.key] ?? []
      return { ...previous, [entry.key]: checked ? [...current, artifactId] : current.filter(id => id !== artifactId) }
    }),
    copy: text => {
      if (stillCurrent()) navigator.clipboard.writeText(text).catch(showGenerationFailure)
    },
    copyCandidate: entry => {
      if (!stillCurrent()) return
      navigator.clipboard.writeText(entry.text).then(() => setCandidateError(''),
        error => setCandidateError(displayedErrorMessage(useLocaleStore.getState().locale, error)))
    },
    continueCandidate: entry => {
      if (!session || !stillCurrent() || !entry.canContinue) return
      void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-update', entry.candidate.candidateId, entry.candidate.visibleText, session.projectPath)
        .then(result => {
          if (!stillCurrent()) return
          if (!result.success || !result.candidate) return failCandidate(result.error)
          const candidate = result.candidate
          useEditorStore.getState().openFile({
            id: `recovery:${candidate.candidateId}`,
            name: useLocaleStore.getState().text(
              `恢复候选 · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
              `Recovery candidate · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`,
            ),
            type: 'chapter',
            filePath: `ai-novel://recovery/${candidate.candidateId}`,
            content: candidate.visibleText,
            savedContent: candidate.visibleText,
            dirty: false,
            projectKey: session.projectPath,
            projectSessionLease: session.leaseId,
          })
          dropCandidate(entry.key)
        }, failCandidate)
    },
    discardCandidate: entry => {
      if (!session || !stillCurrent()) return
      void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-resolve', entry.candidate.candidateId, 'discarded', session.projectPath)
        .then(result => {
          if (!stillCurrent()) return
          if (!result.success) return failCandidate(result.error)
          dropCandidate(entry.key)
        }, failCandidate)
    },
    openPlanning: entry => void act(async current => {
      const fresh = await ipc.invokeWithProjectSession(current, 'generation:read-context', { handle: entry.recovery.handle })
      if (!stillCurrent()) return
      openPlanningRecoveryDraft(fresh, current.projectPath, planningTitle(fresh, useLocaleStore.getState().locale))
    }),
    continueEditor: entry => void act(async current => {
      await ipc.invokeWithProjectSession(current, 'editor-inline:execute', { handle: entry.recovery.view.handle })
      if (stillCurrent()) setRefreshTick(value => value + 1)
    }),
    resumeReview: entry => startRecovery(current => createReviewRevisionRecoveryWorkflow(current, entry.view.handle)),
    resumeBatch: entry => startRecovery(current => createBatchRecoveryWorkflow(current, entry.batchId)),
    resumeDraft: entry => {
      const picked = selection[entry.key] ?? []
      startRecovery(current => createDraftRecoveryWorkflow(current, entry.view.handle, picked.length ? [...picked] : undefined))
    },
    hideDraft: entry => {
      if (!session || !stillCurrent()) return
      hideRecovery(session.projectId, entry.view.handle.runId)
      setHiddenNow(previous => new Set(previous).add(entry.view.handle.runId))
    },
  }
}
