import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleCheck, CircleX } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore, type RunSheetTab, type StageSheet } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { projectRuns } from '../../run/run-output'
import { useRunRecovery, type RunRecovery } from '../../run/use-run-recovery'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Sheet } from '../../ui/Sheet'
import { RunCard, RunDetails } from './RunCard'
import { RunDiagnostics } from './RunDiagnostics'
import { RunRecoveryList } from './RunRecoveryList'
import { clockTime } from './run-format'

type Text = (zh: string, en: string) => string

const TABS: { id: RunSheetTab; label: [string, string] }[] = [
  { id: 'active', label: ['进行中', 'In progress'] },
  { id: 'history', label: ['历史', 'History'] },
  { id: 'diagnostics', label: ['诊断', 'Diagnostics'] },
]

/** 等你确认的排最前，其次运行中、已暂停、正在取消。 */
const ATTENTION: Partial<Record<WorkflowRun['status'], number>> = { waiting: 0, running: 1, paused: 2, cancelling: 3 }

const close = () => useStageStore.setState({ sheet: null })

/**
 * 运行侧页：AI 输出、任务与进度在一处。进行中看步骤、实时输出、等确认与可恢复的内容；
 * 历史看结束的运行；诊断是宽版，放日志与 AI 调用记录。要看的运行已经结束时，「进行中」自动换成「历史」并展开它。
 */
export default function RunSheet({ sheet }: { sheet: Extract<StageSheet, { kind: 'run' }> }) {
  const text = useLocaleStore(s => s.text)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const active = projectRuns(useWorkflowStore(s => s.activeRuns), projectPath)
  const history = projectRuns(useWorkflowStore(s => s.history), projectPath)
  const recovery = useRunRecovery()
  const ended = sheet.runId !== undefined && !active.some(run => run.id === sheet.runId) && history.some(run => run.id === sheet.runId)
  const tab: RunSheetTab = sheet.tab === 'active' && ended ? 'history' : sheet.tab

  return (
    <Sheet
      open
      title={text('运行', 'Run')}
      closeLabel={text('收起运行侧页', 'Close run sheet')}
      onClose={close}
      wide={tab === 'diagnostics'}
      tabs={{
        items: TABS.map(item => ({ id: item.id, label: text(...item.label) })),
        active: tab,
        onChange: id => useStageStore.setState({ sheet: { kind: 'run', tab: id as RunSheetTab } }),
        style: 'segmented',
      }}
    >
      {tab === 'active' && <ActiveRuns runs={active} last={history[0]} recovery={recovery} focusRunId={sheet.runId} hasHistory={history.length > 0} text={text} />}
      {tab === 'history' && <RunHistory key={sheet.runId} runs={history} focusRunId={sheet.runId} text={text} />}
      {tab === 'diagnostics' && <RunDiagnostics />}
    </Sheet>
  )
}

function ActiveRuns({ runs, last, recovery, focusRunId, hasHistory, text }: {
  runs: WorkflowRun[]
  last: WorkflowRun | undefined
  recovery: RunRecovery
  focusRunId: string | undefined
  hasHistory: boolean
  text: Text
}) {
  const ordered = [...runs].sort((a, b) => (ATTENTION[a.status] ?? 9) - (ATTENTION[b.status] ?? 9))
  const showLast = ordered.length === 0 && last !== undefined
  const primaryId = ordered[0]?.status === 'waiting' ? ordered[0].id : undefined
  const nothing = ordered.length === 0 && !showLast && !recovery.entries.length && !recovery.generationError && !recovery.candidateError
  if (nothing) {
    return (
      <EmptyState
        heading={text('没有进行中的运行', 'Nothing is running')}
        description={text('写作此章、AI 审稿等操作开始后，步骤与实时输出会出现在这里。', 'When you write a chapter or run an AI review, its steps and live output appear here.')}
        action={hasHistory
          ? <Button variant="secondary" size="sm" onClick={() => useStageStore.setState({ sheet: { kind: 'run', tab: 'history' } })}>{text('查看历史', 'View history')}</Button>
          : <Button variant="text" size="sm" onClick={close}>{text('收起运行侧页', 'Close run sheet')}</Button>}
      />
    )
  }
  return (
    <div className="run-list">
      {ordered.map(run => <RunCard key={run.id} run={run} focused={run.id === focusRunId} primary={run.id === primaryId} />)}
      {showLast && <RunCard run={last} caption={text('上一次运行', 'Last run')} primary />}
      <RunRecoveryList recovery={recovery} liveRuns={runs} />
    </div>
  )
}

function HistoryIcon({ status }: { status: WorkflowRun['status'] }) {
  return status === 'completed'
    ? <CircleCheck className="run-step-icon" data-tone="ok" size={16} aria-hidden />
    : <CircleX className="run-step-icon" data-tone="danger" size={16} aria-hidden />
}

function RunHistory({ runs, focusRunId, text }: { runs: WorkflowRun[]; focusRunId: string | undefined; text: Text }) {
  const locale = useLocaleStore(s => s.locale)
  const [openId, setOpenId] = useState<string | undefined>(focusRunId)
  const focused = useRef<HTMLLIElement>(null)

  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest' })
  }, [openId])

  if (runs.length === 0) {
    return (
      <EmptyState
        heading={text('还没有运行记录', 'No runs yet')}
        description={text('运行结束后会记在这里，可以展开看每一步的输出。', 'Finished runs are listed here. Expand one to read each step’s output.')}
        action={<Button variant="text" size="sm" onClick={close}>{text('收起运行侧页', 'Close run sheet')}</Button>}
      />
    )
  }
  return (
    <ol className="run-history" aria-label={text('运行历史', 'Run history')}>
      {runs.map(run => {
        const open = run.id === openId
        const done = run.steps.filter(step => step.status === 'completed').length
        return (
          <li key={run.id} ref={open ? focused : undefined} className="run-history-item" data-open={open || undefined}>
            <button type="button" className="run-history-row pi-focusable" aria-expanded={open} onClick={() => setOpenId(open ? undefined : run.id)}>
              <HistoryIcon status={run.status} />
              <span className="run-history-title">{run.title}</span>
              <span className="run-history-meta">
                <span className="run-visually-hidden">{run.status === 'completed' ? text('已完成，', 'Complete, ') : text('未完成，', 'Did not finish, ')}</span>
                {done}/{run.steps.length} · {clockTime(run.createdAt, locale)}
              </span>
              <ChevronRight className="run-step-chevron" size={14} aria-hidden />
            </button>
            {open && <div className="run-history-detail"><RunDetails run={run} /></div>}
          </li>
        )
      })}
    </ol>
  )
}
