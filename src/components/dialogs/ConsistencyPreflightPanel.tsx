import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'

import type { ConsistencyExemption, ConsistencyFinding } from '../../shared/consistency-preflight'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

interface Props {
  findings: ConsistencyFinding[]
  exemptions: ConsistencyExemption[]
  disabled?: boolean
  onIgnoreOnce: () => void
  onFixAndRerun: () => void
  onSave: (stableFactKey: string, reason: string) => Promise<void>
  onRevoke: (stableFactKey: string) => Promise<void>
}

export default function ConsistencyPreflightPanel({
  findings, exemptions, disabled, onIgnoreOnce, onFixAndRerun, onSave, onRevoke,
}: Props) {
  const locale = useLocaleStore(state => state.locale)
  const text = useLocaleStore(state => state.text)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const activeExemptions = exemptions.filter(exemption => !exemption.revoked)

  return (
    <section aria-label={text('一致性预检', 'Consistency preflight')} className="rounded-md border px-3 py-3 space-y-3" style={{ borderColor: 'var(--color-warning)' }}>
      {findings.length > 0 && <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-warning)' }} aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">{text('发现可核对的一致性线索', 'Continuity findings to review')}</p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{text('这些是证据提示，不会阻止创作，也不会自动改写内容。', 'These are evidence prompts. They never block writing or edit content automatically.')}</p>
        </div>
      </div>}
      {findings.map(finding => (
        <div key={finding.stableFactKey} className="rounded-md px-2 py-2 text-xs space-y-2" style={{ backgroundColor: 'var(--color-hover)' }}>
          <p>{locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN}</p>
          <p style={{ color: 'var(--color-text-muted)' }}>{text(`来源：第${finding.sourceChapter}章 · ${finding.evidence}`, `Source: Chapter ${finding.sourceChapter} · ${finding.evidence}`)}</p>
          <p>{locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN}</p>
          <div className="flex gap-2">
            <Input
              aria-label={text('豁免原因', 'Exemption reason')}
              value={reasons[finding.stableFactKey] ?? ''}
              placeholder={text('说明为何属于刻意安排', 'Explain why this is intentional')}
              onChange={event => setReasons(current => ({ ...current, [finding.stableFactKey]: event.target.value }))}
            />
            <Button variant="outline" disabled={disabled || !(reasons[finding.stableFactKey] ?? '').trim()} onClick={() => void onSave(finding.stableFactKey, reasons[finding.stableFactKey] ?? '')}>
              {text('保存安排', 'Save arrangement')}
            </Button>
          </div>
        </div>
      ))}
      {activeExemptions.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs">{text(`已保存安排（${activeExemptions.length}）`, `Saved arrangements (${activeExemptions.length})`)}</summary>
          {activeExemptions.map(exemption => (
            <div key={exemption.stableFactKey} className="mt-2 flex items-center justify-between gap-2 text-xs">
              <span>{exemption.reason}</span>
              <Button variant="ghost" disabled={disabled} onClick={() => void onRevoke(exemption.stableFactKey)}>
                <RotateCcw size={13} aria-hidden="true" />{text('撤销', 'Revoke')}
              </Button>
            </div>
          ))}
        </details>
      )}
      {findings.length > 0 && <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={disabled} onClick={onFixAndRerun}>{text('修改后重检', 'Fix and rerun')}</Button>
        <Button variant="ai" disabled={disabled} onClick={onIgnoreOnce}>{text('仅本次忽略并继续', 'Ignore once and continue')}</Button>
      </div>}
    </section>
  )
}
