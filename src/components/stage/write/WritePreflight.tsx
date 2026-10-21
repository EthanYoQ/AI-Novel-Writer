import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'

interface WritePreflightProps {
  preflight: ConsistencyPreflightResult
  busy: boolean
  onIgnoreOnce: () => void
  onRerun: () => void
  onSave: (stableFactKey: string, reason: string) => void
  onRevoke: (stableFactKey: string) => void
}

/** 写作弹层里的一致性预检：线索提醒只作提示，作者可以保存为刻意安排、仅本次忽略，或改蓝图后重检；已保存的安排可以撤销。 */
export default function WritePreflight({ preflight, busy, onIgnoreOnce, onRerun, onSave, onRevoke }: WritePreflightProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const { findings } = preflight
  const saved = preflight.exemptions.filter(exemption => !exemption.revoked)

  return (
    <section className="stage-preflight" aria-label={text('一致性预检', 'Consistency preflight')}>
      {findings.length > 0 && (
        <p className="stage-preflight-head">
          <ShieldAlert size={14} aria-hidden />
          {text(`一致性预检 · ${findings.length} 条线索提醒`, `Consistency preflight · ${findings.length} continuity ${findings.length === 1 ? 'finding' : 'findings'}`)}
        </p>
      )}
      {findings.length > 0 && (
        <p className="stage-preflight-note">{text('这些是证据提示，不会阻止创作，也不会自动改写内容。', 'These are evidence prompts. They never block writing or edit content automatically.')}</p>
      )}
      {findings.map(finding => {
        const reason = reasons[finding.stableFactKey] ?? ''
        return (
          <div key={finding.stableFactKey} className="stage-preflight-item">
            <p>{locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN}</p>
            <p className="stage-preflight-source">{text(`来源：第${finding.sourceChapter}章 · ${finding.evidence}`, `Source: Chapter ${finding.sourceChapter} · ${finding.evidence}`)}</p>
            <p>{locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN}</p>
            <div className="stage-preflight-save">
              <input
                className="pi-input"
                aria-label={text('安排说明', 'Why this is intentional')}
                value={reason}
                placeholder={text('说明为何属于刻意安排', 'Explain why this is intentional')}
                onChange={event => setReasons(current => ({ ...current, [finding.stableFactKey]: event.target.value }))}
              />
              <Button variant="secondary" size="sm" disabled={busy || !reason.trim()} onClick={() => onSave(finding.stableFactKey, reason)}>
                {text('保存安排', 'Save arrangement')}
              </Button>
            </div>
          </div>
        )
      })}
      {findings.length > 0 && (
        <div className="stage-preflight-actions">
          <Button variant="text" size="sm" disabled={busy} onClick={onIgnoreOnce}>{text('仅本次忽略', 'Ignore this time')}</Button>
          <Button variant="text" size="sm" disabled={busy} onClick={onRerun}>{text('改蓝图后重检', 'Recheck after editing')}</Button>
        </div>
      )}
      {saved.length > 0 && (
        <details className="stage-preflight-saved">
          <summary>{text(`已保存安排（${saved.length}）`, `Saved arrangements (${saved.length})`)}</summary>
          {saved.map(exemption => (
            <div key={exemption.stableFactKey} className="stage-preflight-exemption">
              <span>{exemption.reason}</span>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onRevoke(exemption.stableFactKey)}>
                <RotateCcw size={13} aria-hidden />{text('撤销', 'Revoke')}
              </Button>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
