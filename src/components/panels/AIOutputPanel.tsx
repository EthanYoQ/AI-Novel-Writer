import { useEffect, useMemo, useRef, useState } from 'react'
import type { GenerationBatchProgress, GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import type { MainGenerationRunView } from '../../services/generation/generation-runtime'
import { createDraftRecoveryWorkflow, createBatchRecoveryWorkflow } from '../../services/workflows/draft-recovery-workflow'
import { CheckCircle2, Loader2, Circle, Sparkles, X, ChevronRight, StopCircle, AlertTriangle, SlidersHorizontal, Copy, Pencil, Trash2 } from 'lucide-react'
import {
  useWorkflowStore,
  type WorkflowFailureCode,
  type WorkflowRun,
  type WorkflowStep,
} from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { RecoveryCandidate } from '../../shared/recovery-candidate'
import type { PromptBudgetReport } from '../../services/generation/generation-harness'
import MarkdownContent from '../ui/MarkdownContent'
import { presentWorkflowFailure } from './ai-output-failure-presentation'
import { useLocaleStore } from '../../stores/locale-store'
import type { Locale } from '../../i18n/types'
import { ipc } from '../../services/ipc-client'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { PLOT_OUTLINE_RESUME_ERROR_CODE } from '../../services/workflows/commands/architecture.command'
import { toast } from '../ui/Toast'

function runText(locale: Locale, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

/**
 * 右侧面板「AI 输出」视图
 * 参考 Cursor Agent 风格：扁平化、极简文字驱动、可折叠思考区
 */
export default function AIOutputPanel() {
  // 使用 selector 精确订阅，避免 globalLogs 高频更新导致整个面板重渲染
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const history = useWorkflowStore(s => s.history)
  const getActiveStreamingRun = useWorkflowStore(s => s.getActiveStreamingRun)
  const activeRun = getActiveStreamingRun()
  const activeRunId = activeRun?.id
  const currentLocale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const mainSession = useMemo(() => projectSessionContextFromProject(currentProject), [currentProject])
  const [viewRunId, setViewRunId] = useState<string | null>(null)
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryCandidate[]>([])
  const [recoveryError, setRecoveryError] = useState('')

  console.log('[AIOutputPanel] render: viewRunId=', viewRunId, 'activeRun=', activeRun?.id, activeRun?.status, 'activeRuns.len=', activeRuns.length)

  // 自动跟随最新活跃任务
  useEffect(() => {
    if (!activeRunId) return
    // 异步安排状态同步，避免在 effect 提交阶段触发级联渲染。
    const syncTimer = window.setTimeout(() => {
      setViewRunId(previousRunId => previousRunId === activeRunId ? previousRunId : activeRunId)
    }, 0)
    return () => window.clearTimeout(syncTimer)
  }, [activeRunId])

  useEffect(() => {
    const projectSession = projectSessionContextFromProject(currentProject)
    if (!projectSession || !currentProject) {
      const clearTimer = window.setTimeout(() => {
        setRecoveryCandidates([])
        setRecoveryError('')
      }, 0)
      return () => window.clearTimeout(clearTimer)
    }
    let active = true
    void ipc.invokeWithProjectSession(
      projectSession,
      'db:recovery-candidate-list',
      currentProject.path,
    ).then(candidates => {
      if (!active) return
      const latestProject = useProjectStore.getState().currentProject
      if (!sameProjectSessionContext(projectSession, projectSessionContextFromProject(latestProject))) return
      setRecoveryCandidates(candidates)
      setRecoveryError('')
    }).catch(error => {
      if (!active) return
      setRecoveryCandidates([])
      setRecoveryError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [currentProject])

  const continueRecoveryCandidate = async (candidate: RecoveryCandidate) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = projectSessionContextFromProject(project)
    if (
      !project
      || !sameProjectPathKey(project.path, currentProject?.path)
      || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(currentProject))
      || !candidate.sourceCurrent
    ) return
    const result = await ipc.invokeWithProjectSession(
      projectSession!,
      'db:recovery-candidate-update',
      candidate.candidateId,
      candidate.visibleText,
      project.path,
    )
    if (!result.success || !result.candidate) {
      setRecoveryError(result.error || runText(currentLocale, '恢复候选操作失败', 'Recovery candidate action failed'))
      return
    }
    const currentCandidate = result.candidate
    useEditorStore.getState().openFile({
      id: `recovery:${currentCandidate.candidateId}`,
      name: runText(
        currentLocale,
        `恢复候选 · 第${currentCandidate.chapterNumber}章 ${currentCandidate.chapterTitle}`,
        `Recovery candidate · Chapter ${currentCandidate.chapterNumber} ${currentCandidate.chapterTitle}`,
      ),
      type: 'chapter',
      filePath: `ai-novel://recovery/${currentCandidate.candidateId}`,
      content: currentCandidate.visibleText,
      savedContent: currentCandidate.visibleText,
      dirty: false,
      projectKey: project.path,
      projectSessionLease: projectSession!.leaseId,
    })
    setRecoveryCandidates(items => items.filter(item => item.candidateId !== candidate.candidateId))
    setRecoveryError('')
  }

  const discardRecoveryCandidate = async (candidate: RecoveryCandidate) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = projectSessionContextFromProject(project)
    if (
      !project
      || !sameProjectPathKey(project.path, currentProject?.path)
      || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(currentProject))
    ) return
    const result = await ipc.invokeWithProjectSession(
      projectSession!,
      'db:recovery-candidate-resolve',
      candidate.candidateId,
      'discarded',
      project.path,
    )
    if (!result.success) {
      setRecoveryError(result.error || runText(currentLocale, '恢复候选操作失败', 'Recovery candidate action failed'))
      return
    }
    setRecoveryCandidates(items => items.filter(item => item.candidateId !== candidate.candidateId))
    setRecoveryError('')
  }

  const copyRecoveryCandidate = async (candidate: RecoveryCandidate) => {
    const latestProject = useProjectStore.getState().currentProject
    if (!sameProjectSessionContext(
      projectSessionContextFromProject(latestProject),
      projectSessionContextFromProject(currentProject),
    )) return
    try {
      await navigator.clipboard.writeText(candidate.visibleText)
      setRecoveryError('')
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error))
    }
  }

  const viewRun: WorkflowRun | undefined =
    activeRuns.find(r => r.id === viewRunId) ||
    history.find(r => r.id === viewRunId) ||
    activeRun ||
    undefined

  // DEBUG: 面板切换时追踪状态
  if (viewRun?.status === 'failed' && viewRun.steps.some(s => s.status === 'pending' || s.status === 'running')) {
    console.log('[AIOutputPanel] viewRun out of sync! run.status=', viewRun.status, 'steps=', viewRun.steps.map(s => s.status))
  }

  const recentHistory = history.slice(0, 10)
  const visibleLocale = viewRun?.uiLocale ?? currentLocale

  return (
    <div
      className="writer-ai-panel flex flex-col h-full overflow-hidden"
    >
      {/* 面板头部 */}
      <div
        className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
        style={{
          height: 'var(--height-panel-header)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span
          className="text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {runText(visibleLocale, 'AI 输出', 'AI output')}
        </span>
        <button
          onClick={() => useLayoutStore.getState().setRightView('agent')}
          title={runText(visibleLocale, '切换回 Agent', 'Switch back to Agent')}
          className="icon-btn"
          style={{ width: 20, height: 20 }}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <MainDraftRecoverySection session={mainSession} locale={currentLocale} refreshKey={history.length} />
        {(recoveryCandidates.length > 0 || recoveryError) && (
          <RecoveryCandidateSection
            candidates={recoveryCandidates}
            error={recoveryError}
            locale={currentLocale}
            onCopy={copyRecoveryCandidate}
            onContinue={candidate => { void continueRecoveryCandidate(candidate) }}
            onDiscard={candidate => { void discardRecoveryCandidate(candidate) }}
          />
        )}
        <div className="flex-1 overflow-hidden">
          {viewRun ? (
            <ActiveRunView
              run={viewRun}
              activeRuns={activeRuns}
              onSwitchRun={setViewRunId}
            />
          ) : (
            <div className="h-full overflow-y-auto">
              {recentHistory.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="px-3 py-3">
                  <HistoryList items={recentHistory} onSelect={setViewRunId} locale={visibleLocale} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MainDraftRecoverySection({ session, locale, refreshKey }: {
  session: ProjectSessionContext | null; locale: Locale; refreshKey: number
}) {
  const [runs, setRuns] = useState<Array<{ view: MainGenerationRunView; recovery: GenerationRecoveryContext }>>([])
  const [batches, setBatches] = useState<GenerationBatchProgress[]>([])
  const [selection, setSelection] = useState<Record<string, string[]>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    if (!session) return
    void (async () => {
      const [views, progress] = await Promise.all([
        ipc.invokeWithProjectSession(session, 'generation:list'),
        ipc.invokeWithProjectSession(session, 'generation:list-batches'),
      ])
      const contexts = await Promise.all(views.map(async view => ({ view,
        recovery: await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: view.handle }),
      })))
      if (!active) return
      setRuns(contexts.filter(item => item.recovery.operation === 'chapter-draft' && !item.recovery.batchId
        && (item.recovery.composition || item.view.artifacts.length || item.view.candidates?.length || item.view.unsavedTails?.length)))
      setBatches(progress.filter(item => item.nextChapterNumber !== null))
      setError('')
    })().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [session, refreshKey])
  if (!session) return null
  const act = async (operation: () => Promise<void>) => {
    if (busy || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
    setBusy(true)
    try { await operation(); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const visibleRuns = runs.filter(item => item.view.handle.projectId === session.projectId)
  const visibleBatches = batches.filter(item => item.rootHandle.projectId === session.projectId)
  if (!visibleRuns.length && !visibleBatches.length && !error) return null
  return <section className="max-h-80 overflow-y-auto border-b p-3 text-xs" aria-label={runText(locale, '持久正文候选', 'Saved draft candidates')}>
    {error && <p role="alert">{error}</p>}
    {visibleBatches.map(batch => <article key={batch.batchId} className="mb-3">
      <p>{runText(locale, `批量正文：已保存 ${batch.completedChapters.length} 章，下一章 ${batch.nextChapterNumber}`,
        `Batch drafts: ${batch.completedChapters.length} saved; next chapter ${batch.nextChapterNumber}`)}</p>
      <button type="button" className="icon-btn px-2" disabled={busy} onClick={() => { void act(async () => {
        const workflow = await createBatchRecoveryWorkflow(session, batch.batchId)
        await useWorkflowStore.getState().startWorkflow(workflow)
      }) }}>{runText(locale, '继续此批次', 'Continue this batch')}</button>
    </article>)}
    {visibleRuns.map(({ view, recovery }) => {
      const artifacts = [...new Map([...view.artifacts, ...(view.candidates ?? [])].map(item => [item.artifactId, item])).values()]
      const picked = selection[view.handle.runId] ?? []
      return <article key={view.handle.runId} className="mb-3">
        <p>{runText(locale, `第${recovery.chapterNumber}章候选`, `Chapter ${recovery.chapterNumber} candidate`)}</p>
        {view.ledger && <p>{runText(locale, `已用 ${view.ledger.physicalRequests} 次请求`, `${view.ledger.physicalRequests} requests used`)}</p>}
        {artifacts.map(artifact => <label key={artifact.artifactId} className="block">
          <input type="checkbox" checked={picked.includes(artifact.artifactId)} disabled={busy || artifact.compositionEligible !== true}
            onChange={event => setSelection(previous => ({ ...previous, [view.handle.runId]: event.target.checked
              ? [...picked, artifact.artifactId] : picked.filter(id => id !== artifact.artifactId) }))} />
          <span className="whitespace-pre-wrap">{artifact.text.slice(0, 180)}</span>
          <button type="button" className="icon-btn px-2" onClick={() => { void act(() => navigator.clipboard.writeText(artifact.text)) }}>{runText(locale, '复制', 'Copy')}</button>
        </label>)}
        {view.unsavedTails?.map(tail => <div key={tail.attemptId}>
          <p>{runText(locale, '尚未落盘的正文，可先复制保留：', 'Text not yet saved; copy it to preserve it:')}</p>
          <span className="whitespace-pre-wrap">{tail.text.slice(0, 180)}</span>
          <button type="button" className="icon-btn px-2" onClick={() => { void act(() => navigator.clipboard.writeText(tail.text)) }}>{runText(locale, '复制', 'Copy')}</button>
        </div>)}
        <p>{runText(locale, '勾选顺序决定续接顺序；未完成或来源冲突的片段仍可复制。', 'Selection order determines continuation order. Incomplete or conflicted text can still be copied.')}</p>
        <button type="button" className="icon-btn px-2" disabled={busy || (!picked.length && !recovery.composition)} onClick={() => { void act(async () => {
          const workflow = await createDraftRecoveryWorkflow(session, view.handle, picked.length ? [...picked] : undefined)
          await useWorkflowStore.getState().startWorkflow(workflow)
        }) }}>{runText(locale, '确认继续已选正文', 'Confirm selected draft continuation')}</button>
      </article>
    })}
  </section>
}

function RecoveryCandidateSection({
  candidates,
  error,
  locale,
  onCopy,
  onContinue,
  onDiscard,
}: {
  candidates: RecoveryCandidate[]
  error: string
  locale: Locale
  onCopy: (candidate: RecoveryCandidate) => void
  onContinue: (candidate: RecoveryCandidate) => void
  onDiscard: (candidate: RecoveryCandidate) => void
}) {
  return (
    <section className="max-h-[45%] overflow-y-auto border-b px-3 py-2" style={{ borderColor: 'var(--color-border)' }}>
      <div className="mb-2 text-xs font-medium" style={{ color: 'var(--color-text)' }}>
        {runText(locale, '恢复候选', 'Recovery candidates')}
      </div>
      {error && <p role="alert" className="mb-2 text-xs" style={{ color: 'var(--color-error-text)' }}>{error}</p>}
      {candidates.map(candidate => (
        <article key={candidate.candidateId} className="mb-2 rounded-md border p-2 text-xs" style={{ borderColor: 'var(--color-border)' }}>
          <div className="font-medium" style={{ color: 'var(--color-text)' }}>
            {runText(
              locale,
              `${candidate.replacesCandidateId ? '替代候选' : '原始候选'} · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
              `${candidate.replacesCandidateId ? 'Replacement candidate' : 'Original candidate'} · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`,
            )}
          </div>
          {!candidate.sourceCurrent && (
            <p className="mt-1" style={{ color: 'var(--color-warning-text)' }}>
              {runText(locale, '源章节已变化；可复制或放弃，但不能直接继续。', 'The source chapter changed. You can copy or discard this candidate, but cannot continue it directly.')}
            </p>
          )}
          <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
            {candidate.visibleText}
          </div>
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="icon-btn px-2" onClick={() => onCopy(candidate)}><Copy size={12} />{runText(locale, '复制', 'Copy')}</button>
            <button type="button" className="icon-btn px-2" disabled={!candidate.sourceCurrent} onClick={() => onContinue(candidate)}><Pencil size={12} />{runText(locale, '继续编辑', 'Continue editing')}</button>
            <button type="button" className="icon-btn px-2" onClick={() => onDiscard(candidate)}><Trash2 size={12} />{runText(locale, '放弃', 'Discard')}</button>
          </div>
        </article>
      ))}
    </section>
  )
}


// ===== 空状态 =====

function EmptyState() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 px-6" style={{ color: 'var(--color-text-muted)' }}>
      <Sparkles size={20} style={{ opacity: 0.2 }} />
      <span className="text-xs opacity-60">{text('暂无输出', 'No output')}</span>
    </div>
  )
}


// ===== 活跃任务视图（Cursor 风格） =====

function ActiveRunView({
  run,
  activeRuns,
  onSwitchRun,
}: {
  run: WorkflowRun
  activeRuns: WorkflowRun[]
  onSwitchRun: (id: string) => void
}) {
  const locale = run.uiLocale
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const isActive = run.status === 'running' || run.status === 'waiting' || run.status === 'paused' || run.status === 'cancelling'
  const canCancel = run.status !== 'cancelling'
  const cancelWorkflow = useWorkflowStore.getState().cancelWorkflow
  const prevLenRef = useRef(0)

  // 情节大纲断点续写：错误码匹配且有可用的项目会话
  const failedStep = run.steps.find(s => s.status === 'failed')
  const resumeSynopsisAvailable = run.errorCode === PLOT_OUTLINE_RESUME_ERROR_CODE
    || failedStep?.errorCode === PLOT_OUTLINE_RESUME_ERROR_CODE
  const [resumingSynopsis, setResumingSynopsis] = useState(false)
  const resumePlotOutline = async () => {
    if (resumingSynopsis || !resumeSynopsisAvailable || !run.projectSession) return
    const project = useProjectStore.getState().currentProject
    if (
      !project
      || !sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(project))
    ) return
    setResumingSynopsis(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
      }, run.projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(runText(locale, `续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setResumingSynopsis(false)
    }
  }

  // 提取当前步骤 + 内容
  const currentStep = run.steps[run.currentStepIndex] || run.steps[0]
  const rawText = currentStep?.result || ''

  let content = rawText
  const segments = rawText.split(/<think>/)
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1]
    const end = lastSegment.indexOf('</think>')
    if (end !== -1) {
      content = lastSegment.substring(end + 8)
    } else {
      content = ''
    }
  }

  // 节流自动滚动：仅在正文内容长度变化时触发，思考区不自动滚动
  const contentLen = content.length
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    if (contentLen !== prevLenRef.current) {
      prevLenRef.current = contentLen
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [contentLen, autoScroll, run.currentStepIndex])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  // 整体进度百分比
  const completedCount = run.steps.filter(s => s.status === 'completed').length
  const overallProgress = run.steps.length > 0
    ? Math.round(((completedCount + (currentStep?.progress || 0) / 100) / run.steps.length) * 100)
    : 0

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      {/* 多任务切换（多于1个任务时显示） */}
      {activeRuns.length > 1 && (
        <div
          className="flex items-center gap-1 px-2 py-1.5 flex-shrink-0 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          {activeRuns.map(r => (
            <button
              key={r.id}
              onClick={() => onSwitchRun(r.id)}
              className="text-[0.68rem] px-2 py-0.5 rounded transition-all flex-shrink-0"
              style={{
                backgroundColor: r.id === run.id ? 'var(--color-hover)' : 'transparent',
                color: r.id === run.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              }}
            >
              {r.title.replace(/^[^\s]+\s/, '')}
            </button>
          ))}
        </div>
      )}

      {/* 整体进度条（细线） */}
      <div className="flex-shrink-0" style={{ height: 2, backgroundColor: 'var(--color-border)' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.max(isActive ? 3 : 0, overallProgress)}%`,
            backgroundColor: run.status === 'completed' ? 'var(--color-success)' : 'var(--color-accent)',
            borderRadius: 1,
            transition: 'width 0.6s ease',
          }}
        />
      </div>

      {/* 滚动内容区 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {/* 步骤进度区及独立输出流 */}
        <div className="px-2 pt-2 pb-4">
          {run.steps.map((step, i) => (
            <StepOutputBlock
              key={step.id}
              step={step}
              index={i}
              total={run.steps.length}
              isActiveRun={isActive}
              isCurrentStep={i === run.currentStepIndex}
              locale={locale}
            />
          ))}

          {run.status === 'failed' && (
            <WorkflowFailureNotice
              failureCode={run.failureCode ?? currentStep?.failureCode}
              error={run.error || currentStep?.error}
              promptBudgetReport={run.promptBudgetReport ?? currentStep?.promptBudgetReport}
              projectPath={run.projectPath}
              projectSession={run.projectSession}
              isUnpersistedChapterDraft={
                run.type === 'chapter_creation'
                && run.chapterWordsTarget !== undefined
                && !(currentStep?.result || '').trim()
              }
              locale={locale}
              resumeSynopsisAvailable={resumeSynopsisAvailable}
              resumingSynopsis={resumingSynopsis}
              onResumeSynopsis={() => { void resumePlotOutline() }}
            />
          )}

          {/* 全局完成状态（所有步骤走完之后展示） */}
          {!isActive && run.status === 'completed' && (
            <div
              className="flex items-center justify-center gap-1.5 pt-4 pb-2 mb-2 text-xs"
              style={{ color: 'var(--color-success-text)', borderTop: '1px dashed var(--color-border)' }}
            >
              <CheckCircle2 size={12} />
              {runText(locale, '整个工作流已全部完成', 'The workflow is complete')}
            </div>
          )}
        </div>

        {/* 底部操作占位符，避免滚动到底部被遮挡 */}
        {isActive && <div className="h-10 w-full flex-shrink-0" />}
      </div>

      {/* 固定在底部的操作悬浮区 */}
      {isActive && canCancel && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={() => cancelWorkflow(run.id)}
            className="flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-full transition-all shadow-md backdrop-blur-md"
            style={{
              color: 'var(--color-text)',
              backgroundColor: 'var(--color-hover)',
              border: '1px solid var(--color-border)'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = '#fff'
              e.currentTarget.style.backgroundColor = 'var(--color-error)'
              e.currentTarget.style.borderColor = 'var(--color-error)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'var(--color-text)'
              e.currentTarget.style.backgroundColor = 'var(--color-hover)'
              e.currentTarget.style.borderColor = 'var(--color-border)'
            }}
          >
            <StopCircle size={13} />
            <span className="font-medium tracking-wide">{runText(locale, '中止生成', 'Stop generation')}</span>
          </button>
        </div>
      )}
    </div>
  )
}


// ===== 新版渲染单步结果（支持查看所有历史步骤数据） =====
function StepOutputBlock({ step, index, total, isActiveRun, isCurrentStep, locale }: { step: WorkflowStep; index: number; total: number; isActiveRun: boolean; isCurrentStep: boolean; locale: Locale }) {
  const isRunning = step.status === 'running'
  const isCompleted = step.status === 'completed'
  const isFailed = step.status === 'failed'

  // 防御：step.result 可能不是字符串（如 Command 返回了数组/对象），强制转为字符串
  const rawText = typeof step.result === 'string' ? step.result : (step.result ? JSON.stringify(step.result) : '')
  let thinking = ''
  let content = rawText

  const segments = rawText.split(/<think>/)
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1]
    const end = lastSegment.indexOf('</think>')
    if (end !== -1) {
      thinking = lastSegment.substring(0, end)
      content = lastSegment.substring(end + 8)
    } else {
      thinking = lastSegment
      content = ''
    }
  }

  // 当前激活的步骤默认展开，过去/未来的默认折叠（只有产生了内容的步骤才允许展开）
  const [expanded, setExpanded] = useState(isCurrentStep)

  // 监听如果步骤被激活，则自动展开
  useEffect(() => {
    let mounted = true
    if (isCurrentStep) {
      Promise.resolve().then(() => {
        if (mounted) setExpanded(true)
      })
    }
    return () => { mounted = false }
  }, [isCurrentStep])

  return (
    <div className="mb-1.5">
      {/* 头部摘要项，点击折叠/展开 */}
      <div
        onClick={() => { if (rawText) setExpanded(!expanded) }}
        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors"
        style={{
          cursor: rawText ? 'pointer' : 'default',
          backgroundColor: isRunning ? 'var(--color-hover)' : 'transparent',
          color: isRunning ? 'var(--color-text)' :
                 isCompleted ? 'var(--color-text-secondary)' :
                 isFailed ? 'var(--color-error-text)' :
                 'var(--color-text-muted)',
        }}
        title={rawText ? runText(locale, '点击查看该步骤的历史输出', 'View output history for this step') : undefined}
      >
        {/* 状态图标 */}
        <span className="flex-shrink-0 w-4 flex justify-center">
          {isCompleted && <CheckCircle2 size={11} style={{ color: 'var(--color-success)' }} />}
          {isRunning && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--color-accent)' }} />}
          {isFailed && <Circle size={11} style={{ color: 'var(--color-error)', fill: 'var(--color-error)' }} />}
          {(step.status === 'pending' || step.status === 'skipped') && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: 'var(--color-border)' }}
            />
          )}
        </span>

        {/* 步骤名 */}
        <span className="truncate flex-1" style={{ fontWeight: isRunning ? 500 : 400 }}>
          {step.name}
        </span>

        {/* 进度 */}
        {isRunning && step.progress !== undefined && (
          <span className="font-mono text-[0.62rem] flex-shrink-0 opacity-60">
            {step.progress}%
          </span>
        )}

        {/* 展开角标或序号 */}
        {(rawText && !isRunning) ? (
          <ChevronRight
            size={11}
            style={{
              transition: 'transform 0.2s',
              transform: expanded ? 'rotate(90deg)' : 'none',
              opacity: 0.4,
            }}
          />
        ) : (
          <span className="font-mono text-[0.6rem] flex-shrink-0 opacity-30">
            {index + 1}/{total}
          </span>
        )}
      </div>

      {/* 展开的对应输出数据 */}
      {expanded && rawText && (
        <div className="pl-[4px] pr-1 pt-1 pb-3 text-xs w-full max-w-full break-words">
          {/* 思维链区域 */}
          {thinking && (
            <ThinkingBlock
              thinking={thinking}
              showCursor={isRunning && isActiveRun && !content}
              hasContent={!!content}
              locale={locale}
            />
          )}
          
          {/* 实际正文区域 */}
          {content && (
            <div className="mt-1">
              <MarkdownContent content={content} streaming={isRunning && isActiveRun} />
            </div>
          )}
        </div>
      )}

      {/* 如果是单一正在执行等待，则显示一个等待骨架 */}
      {!rawText && isRunning && isActiveRun && (
        <div className="pl-[4px] pr-1 pt-1 pb-3 text-xs text-center" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
          {runText(locale, '等待指令响应...', 'Waiting for the workflow step...')}
        </div>
      )}
    </div>
  )
}

function WorkflowFailureNotice({
  failureCode,
  error,
  promptBudgetReport,
  projectPath,
  projectSession,
  isUnpersistedChapterDraft,
  locale,
  resumeSynopsisAvailable = false,
  resumingSynopsis = false,
  onResumeSynopsis,
}: {
  failureCode?: WorkflowFailureCode
  error?: string
  promptBudgetReport?: PromptBudgetReport
  projectPath: string
  projectSession: ProjectSessionContext | null
  isUnpersistedChapterDraft: boolean
  locale: 'zh-CN' | 'en-US'
  /** 情节大纲生成被截断且已完成部分已保存 → 可断点续写。 */
  resumeSynopsisAvailable?: boolean
  resumingSynopsis?: boolean
  onResumeSynopsis?: () => void
}) {
  const currentProject = useProjectStore(s => s.currentProject)
  const presentation = presentWorkflowFailure(
    failureCode,
    error,
    locale,
    isUnpersistedChapterDraft,
    promptBudgetReport,
  )
  const matchesCurrentProject = sameProjectPathKey(projectPath, currentProject?.path)
    && sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(currentProject),
    )
  const openNovelConfiguration = () => {
    const project = useProjectStore.getState().currentProject
    if (
      !sameProjectPathKey(projectPath, project?.path)
      || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))
    ) return
    useEditorStore.getState().openFile({
      id: 'config',
      name: locale === 'zh-CN' ? '小说配置' : 'Novel configuration',
      type: 'config',
      projectKey: projectPath,
    })
  }

  return (
    <div
      role="alert"
      className="mt-3 mx-2 flex gap-2 rounded-md px-2.5 py-2 text-xs leading-relaxed"
      style={{
        color: 'var(--color-error-text)',
        backgroundColor: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-error) 35%, transparent)',
      }}
    >
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium m-0">
          {presentation.heading}
        </p>
        <p className="m-0 mt-0.5 break-words">{presentation.reason}</p>
        {presentation.persistence && <p className="m-0 mt-1">{presentation.persistence}</p>}
        {presentation.guidance && <p className="m-0 mt-1">{presentation.guidance}</p>}
        {presentation.action === 'open-novel-config' && presentation.actionLabel && (
          <button
            type="button"
            onClick={openNovelConfiguration}
            disabled={!matchesCurrentProject}
            className="mt-2 inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors"
            style={{
              color: 'var(--color-text)',
              backgroundColor: 'var(--color-hover)',
              border: '1px solid var(--color-border)',
              opacity: matchesCurrentProject ? 1 : 0.55,
              cursor: matchesCurrentProject ? 'pointer' : 'not-allowed',
            }}
          >
            <SlidersHorizontal size={12} aria-hidden="true" />
            {presentation.actionLabel}
          </button>
        )}
        {presentation.action === 'open-novel-config' && !matchesCurrentProject && (
          <p className="m-0 mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {locale === 'zh-CN'
              ? '此结果属于另一项目会话。请切回该项目后再打开小说配置。'
              : 'This result belongs to another project session. Switch back to that project before opening Novel configuration.'}
          </p>
        )}

        {/* 断点续写：已完成部分已自动保存，点击后 AI 接着往下写 */}
        {resumeSynopsisAvailable && (
          <div className="mt-2">
            <button
              type="button"
              onClick={onResumeSynopsis}
              disabled={!matchesCurrentProject || resumingSynopsis}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-sm transition-colors"
              style={{
                color: '#fff',
                backgroundColor: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                opacity: matchesCurrentProject ? 1 : 0.5,
                cursor: matchesCurrentProject ? 'pointer' : 'not-allowed',
              }}
            >
              {resumingSynopsis
                ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                : <Sparkles size={12} aria-hidden="true" />}
              {resumingSynopsis
                ? runText(locale, '正在从断点续写...', 'Resuming from the break point...')
                : runText(locale, '继续生成情节大纲（断点续写）', 'Continue plot outline (resume)')}
            </button>
            <p className="m-0 mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
              {runText(
                locale,
                '已完成的部分已保存为不完整大纲，不会被覆盖；本次将让 AI 接着上次的末尾继续写。',
                'The completed part is already saved as an incomplete outline and will not be lost; the AI will continue from where it stopped.',
              )}
            </p>
            {!matchesCurrentProject && (
              <p className="m-0 mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {runText(
                  locale,
                  '此结果属于另一项目会话。请切回该项目后再续写。',
                  'This result belongs to another project session. Switch back to that project before continuing.',
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


// ===== 思考区块（Cursor "Worked for" 风格） =====

function ThinkingBlock({ thinking, showCursor, hasContent, locale }: { thinking: string; showCursor: boolean; hasContent: boolean; locale: Locale }) {
  // 正文未开始时默认展开，正文开始后默认关闭
  const [expanded, setExpanded] = useState(!hasContent)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    if (hasContent) {
      Promise.resolve().then(() => {
        if (mounted) setExpanded(false)
      })
    }
    return () => { mounted = false }
  }, [hasContent])

  useEffect(() => {
    if (expanded && scrollRef.current) {
      const el = scrollRef.current
      // 只有在用户没有往上滚拉太多时，才自动贴近底部
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        // 使用 requestAnimationFrame 确保在 DOM 更新后执行
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }
        })
      }
    }
  }, [thinking, expanded])

  return (
    <div className="mb-0.5">
      {/* 可折叠标题按钮 — 参考 Cursor 的 "Worked for Xm" */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="group flex items-center gap-1.5 w-full text-left text-xs min-h-6 py-1 select-none transition-colors"
        style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-text)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
      >
        <ChevronRight
          size={12}
          style={{
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(90deg)' : 'none',
          }}
        />
        <span>
          {showCursor
            ? runText(locale, '思考中...', 'Thinking...')
            : runText(locale, '思考过程', 'Thinking process')}
        </span>
        {showCursor && !expanded && (
          <span className="ai-stream-cursor" style={{ height: 11, width: 3 }} />
        )}
      </button>

      {/* 展开的思考内容 */}
      {expanded && (
        <div
          ref={scrollRef}
          className="ml-0.5 pl-3 border-l-2 py-0.5 mb-2 mt-1 text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
            maxHeight: 250,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            lineHeight: 1.6,
          }}
        >
          {thinking}
          {showCursor && <span className="ai-stream-cursor" style={{ height: 12, width: 3 }} />}
        </div>
      )}
    </div>
  )
}


// ===== 历史列表 =====

function HistoryList({ items, onSelect, locale }: { items: WorkflowRun[]; onSelect: (id: string) => void; locale: Locale }) {
  return (
    <div>
      <p
        className="text-[0.68rem] font-medium mb-2 px-1 uppercase tracking-widest"
        style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}
      >
        {runText(locale, '历史', 'History')}
      </p>
      <div className="flex flex-col gap-0.5">
        {items.map(run => (
          <button
            key={run.id}
            onClick={() => onSelect(run.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors"
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--color-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
          >
            {run.status === 'completed'
              ? <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0, opacity: 0.6 }} />
              : <Circle size={10} style={{ color: 'var(--color-error)', flexShrink: 0, opacity: 0.6 }} />
            }
            <span className="text-xs truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
              {run.title.replace(/^[^\s]+\s/, '')}
            </span>
            <span className="text-[0.6rem] flex-shrink-0 font-mono opacity-30">
              {new Date(run.createdAt).toLocaleTimeString(run.uiLocale, { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
