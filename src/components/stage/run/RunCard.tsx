import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, CircleCheck, CircleDashed, CircleX, Pause, Play } from 'lucide-react'
import { pluralEn } from '../../../shared/plural-en'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowReasoningStore } from '../../../stores/workflow-reasoning-store'
import { useWorkflowStore, type WorkflowRun, type WorkflowStep } from '../../../stores/workflow-store'
import { runProgress } from '../../../stores/navigation/stage-progress'
import { CharacterProposalSelectionPanel } from '../../characters/CharacterProposalSelectionPanel'
import { isCurrentSessionRun, openArchitectureFor, openNovelConfigurationFor, runFailure, useResumePlotOutline } from '../../run/run-failure'
import { ACTIVE_RUN_STATUSES, splitThinking } from '../../run/run-output'
import { useReviewWaitLines } from '../../run/use-review-wait'
import { useWorkflowConfirmation, type WorkflowConfirmation } from '../../run/use-workflow-confirmation'
import { Button } from '../../ui/Button'
import MarkdownContent from '../../ui/MarkdownContent'
import { Notice } from '../../ui/Notice'
import { ProgressRing } from '../ProgressRing'
import { ImportSuggestions } from './ImportSuggestions'
import { clockTime, stepDuration } from './run-format'

type Text = (zh: string, en: string) => string

const STATUS_TEXT: Record<WorkflowRun['status'], [string, string]> = {
  idle: ['未开始', 'Not started'],
  running: ['运行中', 'Running'],
  waiting: ['等你确认', 'Needs you'],
  paused: ['已暂停', 'Paused'],
  cancelling: ['正在取消，等当前操作退出', 'Cancelling; waiting for the current operation'],
  completed: ['已完成', 'Complete'],
  failed: ['失败', 'Failed'],
}

function runMeta(run: WorkflowRun, model: string | undefined, text: Text, locale: Parameters<typeof clockTime>[1]): string {
  const started = text(`${clockTime(run.createdAt, locale)} 开始`, `Started ${clockTime(run.createdAt, locale)}`)
  const percent = `${Math.round(runProgress(run) * 100)}%`
  const status = run.status === 'running' && run.pauseRequested ? text('本章写完后暂停', 'Pausing after this chapter')
    : run.status === 'running' || run.status === 'waiting' ? percent
      : text(...STATUS_TEXT[run.status])
  return [started, model, status].filter(Boolean).join(' · ')
}

/**
 * 运行侧页里的一次运行。进行中的运行默认展开当前步骤，实时输出持续追加；
 * 步骤日志不在这里重复，工作流把每条步骤日志同时写进了诊断分页的日志。
 * primary：侧页同一时刻只有一个主按钮，由侧页交给最需要作者处理的那张卡，其余卡的确认与续写是次按钮。
 */
export function RunCard({ run, caption, focused, primary = false }: { run: WorkflowRun; caption?: string; focused?: boolean; primary?: boolean }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const titleId = useId()
  const ref = useRef<HTMLElement>(null)
  const live = ACTIVE_RUN_STATUSES.has(run.status)
  const confirmation = useWorkflowConfirmation(run)
  const batch = run.type === 'batch_generate'
  const model = useLLMStore(s => s.models.find(candidate => candidate.id === run.generationModelId)?.name)

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const store = useWorkflowStore.getState
  return (
    <article ref={ref} className="run-card" data-state={run.status} aria-labelledby={titleId}>
      <header className="run-card-head">
        <div className="run-card-heading">
          {caption && <p className="run-card-kicker">{caption}</p>}
          <div className="run-card-titleline">
            {confirmation && <span className="run-badge" data-tone="accent">{text('等你确认', 'Needs you')}</span>}
            <h3 id={titleId} className="run-card-title">{run.title}</h3>
          </div>
          <p className="run-card-meta">{runMeta(run, model, text, locale)}</p>
        </div>
        {live && (
          <div className="run-card-actions">
            {batch && run.status === 'running' && !run.pauseRequested && (
              <Button variant="icon" size="sm" aria-label={text('暂停批量创作', 'Pause batch writing')}
                title={text('写完当前这一章后暂停', 'Pause after the current chapter')} onClick={() => store().pauseWorkflow(run.id)}>
                <Pause size={14} aria-hidden />
              </Button>
            )}
            {batch && run.status === 'paused' && (
              <Button variant="icon" size="sm" aria-label={text('继续批量创作', 'Resume batch writing')} onClick={() => store().resumeWorkflow(run.id)}>
                <Play size={14} aria-hidden />
              </Button>
            )}
            {run.status !== 'cancelling' && (
              <Button variant="text" size="sm" aria-label={text(`取消「${run.title}」`, `Cancel “${run.title}”`)} onClick={() => store().cancelWorkflow(run.id)}>
                {text('取消', 'Cancel')}
              </Button>
            )}
          </div>
        )}
      </header>
      {confirmation && <RunConfirmation confirmation={confirmation} primary={primary} text={text} />}
      <RunDetails run={run} primary={primary} />
    </article>
  )
}

/** 一次运行的步骤与失败提示；历史里一次只展开一条，展开的这条就是主操作所在。 */
export function RunDetails({ run, primary = true }: { run: WorkflowRun; primary?: boolean }) {
  const text = useLocaleStore(s => s.text)
  return (
    <>
      <RunSteps run={run} live={ACTIVE_RUN_STATUSES.has(run.status)} text={text} />
      {run.type === 'novel_import' && run.status === 'completed' && <ImportSuggestions run={run} />}
      {run.status === 'failed' && <RunFailureNotice run={run} primary={primary} />}
    </>
  )
}

function RunConfirmation({ confirmation, primary, text }: { confirmation: WorkflowConfirmation; primary: boolean; text: Text }) {
  const { proposal, blocked, ready, nextStepName } = confirmation
  return (
    <section className="run-confirm" aria-label={text('需要你确认', 'Needs your confirmation')}>
      {proposal && (
        <>
          <p className="run-confirm-summary">{text(`${proposal.batch.items.length} 个角色候选`, `${proposal.batch.items.length} character ${pluralEn(proposal.batch.items.length, 'candidate')}`)}</p>
          <div className="run-proposals">
            <CharacterProposalSelectionPanel batch={proposal.batch} choices={proposal.choices}
              identities={proposal.identities} disabled={!ready} onChange={proposal.onChange} />
          </div>
        </>
      )}
      {blocked && <p className="run-note" role="status">{blocked}</p>}
      <p className="run-confirm-next">{text('下一步：', 'Next: ')}{nextStepName}</p>
      <Button variant={primary ? 'primary' : 'secondary'} className="run-confirm-button" disabled={!ready} onClick={confirmation.confirm}>
        {confirmation.confirmLabel}
      </Button>
    </section>
  )
}

function RunSteps({ run, live, text }: { run: WorkflowRun; live: boolean; text: Text }) {
  const reasoning = useWorkflowReasoningStore(s => live ? s.entries[run.id]?.text ?? '' : '')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <ol className="run-steps" aria-label={text('步骤', 'Steps')}>
      {run.steps.map((step, index) => {
        const current = live && index === run.currentStepIndex
        const openByDefault = current && step.status === 'running'
        return (
          <RunStep
            key={step.id}
            step={step}
            live={live && step.status === 'running'}
            reasoning={current ? reasoning : ''}
            open={open[step.id] ?? openByDefault}
            onToggle={() => setOpen(previous => ({ ...previous, [step.id]: !(previous[step.id] ?? openByDefault) }))}
            text={text}
          />
        )
      })}
    </ol>
  )
}

function StepIcon({ step }: { step: WorkflowStep }) {
  switch (step.status) {
    case 'completed': return <CircleCheck className="run-step-icon" data-tone="ok" size={16} aria-hidden />
    case 'failed': return <CircleX className="run-step-icon" data-tone="danger" size={16} aria-hidden />
    case 'running': return <ProgressRing className="run-step-icon" size={16} stroke={2} ratio={Math.max(0.08, (step.progress ?? 0) / 100)} />
    default: return <CircleDashed className="run-step-icon" data-tone="todo" size={16} aria-hidden />
  }
}

function stepMeta(step: WorkflowStep, text: Text): string {
  if (step.status === 'completed') return stepDuration(step.startedAt, step.completedAt, text)
  if (step.status === 'skipped') return text('已跳过', 'Skipped')
  if (step.status === 'failed') return text('失败', 'Failed')
  if (step.status === 'running' && step.progress !== undefined && step.generationActivity?.operation !== 'review-chapter') return `${step.progress}%`
  return ''
}

function RunStep({ step, live, reasoning, open, onToggle, text }: {
  step: WorkflowStep
  /** 这一步正在运行：输出持续追加，自动滚到最新。 */
  live: boolean
  reasoning: string
  open: boolean
  onToggle: () => void
  text: Text
}) {
  const output = useMemo(() => splitThinking(step.result), [step.result])
  const thinking = reasoning || output.thinking
  const hasDetail = Boolean(output.raw || thinking || step.error)
  const expanded = hasDetail && open
  const reviewing = live && step.generationActivity?.operation === 'review-chapter'
  const row = (
    <>
      <StepIcon step={step} />
      <span className="run-step-name">{step.name}</span>
      <span className="run-step-meta">{stepMeta(step, text)}</span>
      {hasDetail && <ChevronRight className="run-step-chevron" size={14} aria-hidden />}
    </>
  )
  return (
    <li className="run-step" data-status={step.status}>
      {hasDetail
        ? <button type="button" className="run-step-row pi-focusable" aria-expanded={expanded} onClick={onToggle}>{row}</button>
        : <div className="run-step-row">{row}</div>}
      {reviewing && <ReviewWait step={step} />}
      {expanded && (
        <div className="run-step-detail">
          {thinking && (
            <details className="run-thinking" open={!output.content}>
              <summary>{live && !output.content ? text('思考中', 'Thinking') : text('思考过程', 'Thinking')}</summary>
              <p className="run-thinking-text">{thinking}</p>
            </details>
          )}
          {output.content && <StepOutput content={output.content} live={live} text={text} />}
          {step.error && <p className="run-step-error">{step.error}</p>}
        </div>
      )}
    </li>
  )
}

function ReviewWait({ step }: { step: WorkflowStep }) {
  const locale = useLocaleStore(s => s.locale)
  const lines = useReviewWaitLines(step, locale)
  return <div className="run-step-wait" role="status">{lines.map(line => <p key={line}>{line}</p>)}</div>
}

/** 输出框贴着底部时随新内容滚动；作者往上翻看时不打断。 */
function StepOutput({ content, live, text }: { content: string; live: boolean; text: Text }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const box = ref.current
    if (live && box && pinned.current) box.scrollTop = box.scrollHeight
  }, [content, live])
  return (
    <div className="run-output-frame">
      {live && <p className="run-output-label">{text('实时输出', 'Live output')}</p>}
      <div
        ref={ref}
        className="run-output"
        onScroll={event => {
          const box = event.currentTarget
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
        }}
      >
        <MarkdownContent content={content} streaming={live} />
      </div>
    </div>
  )
}

function RunFailureNotice({ run, primary }: { run: WorkflowRun; primary: boolean }) {
  const text = (zh: string, en: string) => run.uiLocale === 'en-US' ? en : zh
  const { presentation, errorCode, canResumeOutline, canRestartOutline } = runFailure(run)
  const current = useProjectStore(() => isCurrentSessionRun(run))
  const outline = useResumePlotOutline(run)
  const openConfig = presentation.action === 'open-novel-config' && presentation.actionLabel
  return (
    <Notice tone="danger" title={presentation.heading}>
      <p>{presentation.reason}</p>
      {errorCode && <p className="run-note">{text('错误码：', 'Error code: ')}{errorCode}</p>}
      {presentation.persistence && <p>{presentation.persistence}</p>}
      {presentation.guidance && <p>{presentation.guidance}</p>}
      {canResumeOutline && (
        <p>{text('已完成的部分已保存为不完整大纲，不会被覆盖；续写会让模型接着上次的末尾写。',
          'The completed part is saved as an incomplete outline and will not be lost; continuing picks up where it stopped.')}</p>
      )}
      {(openConfig || canResumeOutline || canRestartOutline) && (
        <div className="run-notice-actions">
          {canResumeOutline && (
            <Button variant={primary ? 'primary' : 'secondary'} size="sm" disabled={!current || outline.resuming} onClick={() => void outline.resume()}>
              {outline.resuming ? text('正在从断点续写…', 'Resuming…') : text('继续生成情节大纲', 'Continue the plot outline')}
            </Button>
          )}
          {canRestartOutline && (
            <Button variant={primary ? 'primary' : 'secondary'} size="sm" disabled={!current} onClick={() => openArchitectureFor(run)}>
              {text('打开架构页', 'Open Architecture')}
            </Button>
          )}
          {openConfig && (
            <Button variant="secondary" size="sm" disabled={!current} onClick={() => openNovelConfigurationFor(run)}>
              {presentation.actionLabel}
            </Button>
          )}
        </div>
      )}
      {(openConfig || canResumeOutline || canRestartOutline) && !current && (
        <p className="run-note">{text('这次运行属于另一次打开的作品，回到那部作品后才能继续。', 'This run belongs to another open session of the book. Switch back to it to continue.')}</p>
      )}
    </Notice>
  )
}
