import type { Locale } from '../../i18n/types'
import type { GenerationBudgetDiagnostic } from '../../services/generation/task-budget-planner'
import { formatGenerationBudgetDiagnostic } from '../../services/generation/prompt-budget-failure'

export interface GenerationBudgetDiagnosticsProps {
  diagnostics: readonly GenerationBudgetDiagnostic[] | undefined
  locale: Locale
}

/** Read-only, secret-free projection of receipts already settled by the main owner. */
export default function GenerationBudgetDiagnostics({
  diagnostics,
  locale,
}: GenerationBudgetDiagnosticsProps) {
  if (!diagnostics?.length) return null
  return (
    <details className="my-1 rounded border border-[var(--color-border)] px-2 py-1">
      <summary className="cursor-pointer text-[0.7rem] font-medium text-[var(--color-text-secondary)]">
        {locale === 'zh-CN' ? '预算诊断' : 'Budget diagnostics'}
      </summary>
      <div className="mt-1 space-y-1">
        {diagnostics.map((diagnostic, index) => (
          <p
            key={diagnostic.attemptId}
            className="text-[0.68rem] leading-relaxed text-[var(--color-text-muted)]"
            data-actual-state={diagnostic.actualState}
            data-planner-version={diagnostic.plannerVersion ?? 'legacy'}
          >
            <span className="font-medium text-[var(--color-text-secondary)]">
              {locale === 'zh-CN' ? `请求 ${index + 1}` : `Request ${index + 1}`}
            </span>
            {' · '}
            {formatGenerationBudgetDiagnostic(diagnostic, locale)}
          </p>
        ))}
      </div>
    </details>
  )
}
