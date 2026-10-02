import { useEffect, useRef, useState } from 'react'
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
      filePath: `vela://recovery/${currentCandidate.candidateId}`,
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
      className="writer-ai-panel ai-output-view flex flex-col h-full overflow-hidden"
    >
      {/* 面板头部（demo .ai-output-head：标题 + 副题 + 返回 AI 助手） */}
      <div className="ai-output-head no-select">
        <b>{runText(visibleLocale, 'AI 输出', 'AI output')}</b>
        <span className="sub">{runText(visibleLocale, 'Agent 工作记录', 'Agent work log')}</span>
        <button
          type="button"
          onClick={() => useLayoutStore.getState().setRightView('agent')}
          title={runText(visibleLocale, '切换回 Agent', 'Switch back to Agent')}
          className="icobtn"
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* 恢复候选：仍常驻在滚动区之上，只换成 demo 的 entry 版式 */}
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

      {viewRun ? (
        <ActiveRunView
          run={viewRun}
          activeRuns={activeRuns}
          onSwitchRun={setViewRunId}
        />
      ) : (
        /* demo .ai-output-body：空态与历史记录都直接落在滚动区里 */
        <div className="ai-output-body">
          {recentHistory.length === 0 ? (
            <EmptyState />
          ) : (
            <HistoryList items={recentHistory} onSelect={setViewRunId} locale={visibleLocale} />
          )}
        </div>
      )}
    </div>
  )
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
    <section
      className="ai-output-entry max-h-[45%] overflow-y-auto flex-shrink-0"
      style={{ padding: '15px 15px 0' }}
    >
      {/* demo .ai-output-meta：状态点 + 标题 + 右侧标签 */}
      <div className="ai-output-meta">
        <span className="ai-output-dot" style={{ backgroundColor: 'var(--seal)' }} />
        <span className="ai-output-title">
          {runText(locale, '恢复候选', 'Recovery candidates')}
        </span>
        <span className="ai-output-tag">{candidates.length}</span>
      </div>
      {error && <p role="alert" className="mb-2 text-xs" style={{ color: 'var(--color-error-text)' }}>{error}</p>}
      {candidates.map(candidate => (
        <article key={candidate.candidateId} className="ai-output-entry">
          <div className="ai-output-meta">
            <span
              className="ai-output-dot"
              style={{ backgroundColor: candidate.sourceCurrent ? 'var(--seal)' : 'var(--color-warning)' }}
            />
            <span className="ai-output-title">
              {runText(
                locale,
                `${candidate.replacesCandidateId ? '替代候选' : '原始候选'} · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
                `${candidate.replacesCandidateId ? 'Replacement candidate' : 'Original candidate'} · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`,
              )}
            </span>
            <span className="ai-output-tag">{candidate.failureCode || 'CANDIDATE'}</span>
          </div>
          {!candidate.sourceCurrent && (
            <p className="mt-1 mb-1 text-xs" style={{ color: 'var(--color-warning-text)' }}>
              {runText(locale, '源章节已变化；可复制或放弃，但不能直接继续。', 'The source chapter changed. You can copy or discard this candidate, but cannot continue it directly.')}
            </p>
          )}
          <div
            className="ai-output-text max-h-24 overflow-y-auto"
            style={{ color: 'var(--color-text-secondary)' }}
          >
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
    /* demo .ai-output-empty：主行 + 弱化副行 */
    <div className="ai-output-empty">
      <Sparkles size={20} style={{ opacity: 0.2, display: 'block', margin: '0 auto 8px' }} />
      <div>{text('暂无输出', 'No output')}</div>
      <span style={{ fontSize: 10, color: 'var(--faint)' }}>
        {text(
          '当 AI 执行生成、检索、审稿或修稿任务时，工作结果会显示在这里。',
          'When the AI runs a generation, retrieval, review, or revision task, its results appear here.',
        )}
      </span>
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
    /* demo .ai-output-body：多任务切换 / 进度线固定在顶部，只有记录区滚动 */
    <div
      className="ai-output-body relative flex flex-col"
      style={{ padding: 0, overflow: 'hidden' }}
    >
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

      {/* 滚动内容区：每条记录都是 demo 的 .ai-output-entry */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ padding: '15px 15px 20px' }}
      >
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
          <section className="ai-output-entry">
            <div className="ai-output-meta" style={{ justifyContent: 'center' }}>
              <span className="ai-output-dot" style={{ backgroundColor: 'var(--color-success)' }} />
              <span className="ai-output-title" style={{ color: 'var(--color-success-text)' }}>
                {runText(locale, '整个工作流已全部完成', 'The workflow is complete')}
              </span>
              <span className="ai-output-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <CheckCircle2 size={12} style={{ color: 'var(--color-success)' }} />
              </span>
            </div>
          </section>
        )}

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

  // 状态点 / 标题颜色沿用原有的状态分支，只是换成 demo 的圆点与标题层级
  const dotColor =
    isCompleted ? 'var(--color-success)' :
    isFailed ? 'var(--color-error)' :
    isRunning ? 'var(--color-accent)' :
    'var(--color-border)'
  const titleColor =
    isRunning ? 'var(--color-text)' :
    isCompleted ? 'var(--color-text-secondary)' :
    isFailed ? 'var(--color-error-text)' :
    'var(--color-text-muted)'

  return (
    <section className="ai-output-entry">
      {/* demo .ai-output-meta：状态点 + 步骤名 + 右侧状态徽标/进度/展开角标 */}
      <div
        onClick={() => { if (rawText) setExpanded(!expanded) }}
        className="ai-output-meta"
        style={{
          cursor: rawText ? 'pointer' : 'default',
          padding: '2px 4px',
          margin: '0 -4px 5px',
          borderRadius: 4,
          backgroundColor: isRunning ? 'var(--color-hover)' : 'transparent',
        }}
        title={rawText ? runText(locale, '点击查看该步骤的历史输出', 'View output history for this step') : undefined}
      >
        <span className="ai-output-dot" style={{ backgroundColor: dotColor }} />

        {/* 步骤名 */}
        <span className="ai-output-title truncate flex-1" style={{ color: titleColor, fontWeight: isRunning ? 500 : 400 }}>
          {step.name}
        </span>

        <span className="ai-output-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {/* 状态图标 */}
          {isCompleted && <CheckCircle2 size={11} style={{ color: 'var(--color-success)' }} />}
          {isRunning && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--color-accent)' }} />}
          {isFailed && <Circle size={11} style={{ color: 'var(--color-error)', fill: 'var(--color-error)' }} />}
          {(step.status === 'pending' || step.status === 'skipped') && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: 'var(--color-border)' }}
            />
          )}

          {/* 进度 */}
          {isRunning && step.progress !== undefined && (
            <span style={{ opacity: 0.75 }}>
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
                flexShrink: 0,
              }}
            />
          ) : (
            <span style={{ opacity: 0.45 }}>
              {index + 1}/{total}
            </span>
          )}
        </span>
      </div>

      {/* 展开的对应输出数据（demo .ai-output-text：本条记录的正文） */}
      {expanded && rawText && (
        <div className="ai-output-text w-full max-w-full break-words">
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
        <div className="ai-output-text" style={{ color: 'var(--color-text-muted)', textAlign: 'center', opacity: 0.7 }}>
          {runText(locale, '等待指令响应...', 'Waiting for the workflow step...')}
        </div>
      )}
    </section>
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
    /* demo .ai-output-entry：失败也是一条记录，标题在 meta，正文与操作在下方告警块内 */
    <section className="ai-output-entry" role="alert">
      <div className="ai-output-meta">
        <span className="ai-output-dot" style={{ backgroundColor: 'var(--color-error)' }} />
        <span className="ai-output-title" style={{ color: 'var(--color-error-text)' }}>
          {presentation.heading}
        </span>
        <span className="ai-output-tag">{failureCode ?? runText(locale, '失败', 'FAILED')}</span>
      </div>
      <div
        className="flex gap-2 rounded-md px-2.5 py-2 text-xs leading-relaxed"
        style={{
          color: 'var(--color-error-text)',
          backgroundColor: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--color-error) 35%, transparent)',
        }}
      >
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          {/* 标题已在 meta 行（demo 的 .ai-output-title），这里不再重复 */}
          <p className="font-medium m-0 break-words">{presentation.reason}</p>
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

          {/* 上游 1.1.0 新增：情节大纲断点续写（已完成部分已自动保存，点击后 AI 接着往下写） */}
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
    </section>
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


// ===== 历史列表（demo 里同样是 .ai-output-entry 记录流） =====

/** 历史记录的状态副行文案（沿用原有「已完成 / 未完成」二分支，再区分暂停与进行中）。 */
function runStatusLabel(locale: Locale, status: WorkflowRun['status']): string {
  switch (status) {
    case 'completed':
      return runText(locale, '已完成', 'Completed')
    case 'failed':
      return runText(locale, '失败', 'Failed')
    case 'paused':
      return runText(locale, '已暂停', 'Paused')
    case 'running':
    case 'cancelling':
    case 'waiting':
      return runText(locale, '进行中', 'In progress')
    default:
      return runText(locale, '未开始', 'Idle')
  }
}

function HistoryList({ items, onSelect, locale }: { items: WorkflowRun[]; onSelect: (id: string) => void; locale: Locale }) {
  return (
    <div>
      <p
        className="ai-output-meta"
        style={{ color: 'var(--color-text-muted)', opacity: 0.7, letterSpacing: '0.14em', textTransform: 'uppercase' }}
      >
        {runText(locale, '历史', 'History')}
      </p>
      <div className="flex flex-col">
        {items.map(run => (
          <section className="ai-output-entry" key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              className="ai-output-meta"
              style={{
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--color-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent' }}
            >
              <span
                className="ai-output-dot"
                style={{ backgroundColor: run.status === 'completed' ? 'var(--color-success)' : 'var(--color-error)' }}
              />
              <span className="ai-output-title truncate flex-1">
                {run.title.replace(/^[^\s]+\s/, '')}
              </span>
              <span className="ai-output-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {run.status === 'completed'
                  ? <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0, opacity: 0.6 }} />
                  : <Circle size={10} style={{ color: 'var(--color-error)', flexShrink: 0, opacity: 0.6 }} />
                }
                <span>{new Date(run.createdAt).toLocaleTimeString(run.uiLocale, { hour: '2-digit', minute: '2-digit' })}</span>
              </span>
            </button>
            <div className="ai-output-text" style={{ color: 'var(--color-text-muted)', fontSize: '10.5px' }}>
              {runStatusLabel(locale, run.status)}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
