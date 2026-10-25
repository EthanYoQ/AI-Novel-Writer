import { RefreshCw } from 'lucide-react'
import { getChapterFinalizeScope } from '../../../services/workflows/workflow-utils'
import { describeFinalizationStepError, planFinalizationRetry } from '../../../shared/finalization-step-error'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { usePostProcessStatus } from '../../ui/use-post-process-status'

type Text = (zhCNText: string, enUSText: string) => string

function stepDetail(presentation: 'success' | 'pending' | 'failed' | 'retired', error: string | undefined, text: Text): string {
  if (presentation === 'success') return text('完成', 'Done')
  if (presentation === 'retired') return text('这一步来自旧版本，现在的定稿流程已不再运行它，无需处理。', 'This step is from an earlier version and is no longer part of finalization. Nothing to do here.')
  if (presentation === 'pending') return text('处理中', 'In progress')
  return error ? describeFinalizationStepError(error, text) : text('失败', 'Failed')
}

/**
 * 定稿视图里的后处理（F-090、F-091）：正文文件与后处理流水线逐步列出完成、处理中或失败。
 * 重试有用的失败步骤各自可以重试，「重试失败步骤」只在至少有一步能重试时出现，重跑哪些由修复工作流按同一份安排选。
 * 正文文件写入失败时重试的是已提交的发布（F-089），不重新定稿。
 * 正文文件这一步只有本次打开期间定稿过才知道结果，否则不列出。
 * 旧版本跑批里留下、现在流程已没有的步骤照常列出，不论当时成败都说明它已不再运行，不摆重试，也不算进完成数。
 */
export default function PostProcessSteps({ chapterNumber, publication, busy, onRetryStep, onRetryFailed, onRetryPublication }: {
  chapterNumber: number
  publication: 'pending' | 'published' | undefined
  busy: boolean
  onRetryStep: (stepKey: string) => void
  onRetryFailed: () => void
  onRetryPublication: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const { status, loading, steps } = usePostProcessStatus(getChapterFinalizeScope(chapterNumber), busy)
  if (loading && !publication) return null

  const plan = planFinalizationRetry(status?.steps ?? {})
  const rows = [
    ...(publication ? [{
      key: 'publication',
      label: text('正文文件', 'Manuscript file'),
      presentation: publication === 'published' ? 'success' as const : 'failed' as const,
      detail: publication === 'published'
        ? text('已写入项目目录', 'Written to the project folder')
        : text('定稿已提交，正文文件还没写入', 'Finalization is committed; the manuscript file is not written yet'),
      retry: onRetryPublication,
      retryable: true,
      retryLabel: text('重新写入正文', 'Write again'),
    }] : []),
    ...steps.map(({ key, step, presentation: shown }) => {
      const presentation = plan.retired.has(key) ? 'retired' as const : shown
      return {
        key,
        label: step.label,
        presentation,
        detail: stepDetail(presentation, step.error, text),
        retry: () => onRetryStep(key),
        retryable: plan.rows.has(key),
        retryLabel: text('重试', 'Retry'),
      }
    }),
  ]
  if (rows.length === 0) return null
  const done = rows.filter(row => row.presentation === 'success').length
  const total = rows.filter(row => row.presentation !== 'retired').length
  const cardRetry = steps.some(row => row.presentation === 'failed' && plan.card.includes(row.key))

  return (
    <section className="stage-ch-post" aria-label={text('定稿后处理', 'Post-finalization steps')}>
      <div className="stage-ch-post-head">
        <h2 className="stage-ch-post-title">
          {text('定稿后处理', 'After finalization')}
          <small>{text(`${done} / ${total} 完成`, `${done} / ${total} done`)}</small>
        </h2>
        {cardRetry && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onRetryFailed}>
            <RefreshCw size={13} aria-hidden />{text('重试失败步骤', 'Retry failed steps')}
          </Button>
        )}
      </div>
      <ol className="stage-ch-post-steps">
        {rows.map(row => (
          <li key={row.key} className="stage-ch-post-step" data-state={row.presentation}>
            <b>{row.label}</b>
            <span className="stage-ch-post-detail">{row.detail}</span>
            {row.presentation === 'failed' && row.retryable && (
              <Button variant="text" size="sm" disabled={busy} onClick={row.retry}>{row.retryLabel}</Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
