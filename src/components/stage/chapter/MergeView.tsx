import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { pluralEn } from '../../../shared/plural-en'
import { useLocaleStore } from '../../../stores/locale-store'
import { useMergeSegments, type HunkPick } from '../../editor/merge-segments'
import type { MergeData } from '../../editor/use-draft-actions'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { SegmentedControl } from '../../ui/SegmentedControl'

/** 一个未改动片段在合并视图里只占一行说明；空行锚点不显示。 */
function sameLabel(lines: readonly string[] | undefined): boolean {
  return Boolean(lines?.some(line => line.trim()))
}

/**
 * 修稿合并（ThreeWayMerge 的数据逻辑）：每处改动选用原稿、用修稿或手动编辑，也可以全部用原稿、全部用修稿。
 * 完成合并交出的正文就是按选择拼出的文字；稍后再合并只收起视图，修稿仍待合并。
 */
export default function MergeView({ data, versionLabel, recheck, onComplete, onLater }: {
  data: MergeData
  versionLabel: string
  /** 按审稿意见修出的稿合并后会自动复验；直接修稿没有复验。 */
  recheck: boolean
  onComplete: (mergedText: string) => Promise<boolean>
  onLater: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const merge = useMergeSegments(data.originalContent, data.modifiedContent)
  const [busy, setBusy] = useState(false)
  const pickOf = (index: number): HunkPick => merge.picks[index] ?? 'original'
  const revisedCount = merge.hunks.filter(hunk => pickOf(hunk.index) === 'revised').length
  const editedCount = merge.hunks.filter(hunk => pickOf(hunk.index) === 'edit').length
  const paragraphs = useMemo(() => {
    let count = 0
    return merge.segments.map(segment => segment.type === 'hunk' || sameLabel(segment.lines) ? ++count : 0)
  }, [merge.segments])

  const complete = async () => {
    setBusy(true)
    try {
      await onComplete(merge.mergedText())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stage-ch-merge" aria-label={text('修稿合并', 'Revision merge')}>
      <div className="stage-ch-actions">
        <Button variant="primary" disabled={busy || Boolean(data.staleReason)} onClick={() => void complete()}>
          <Check size={15} aria-hidden />{text('完成合并', 'Finish merge')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => merge.chooseAll('original')}>{text('全部用原稿', 'Use all original')}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => merge.chooseAll('revised')}>{text('全部用修稿', 'Use all revision')}</Button>
        <Button variant="text" disabled={busy} onClick={onLater}>{text('稍后再合并', 'Merge later')}</Button>
        <span className="stage-ch-hint" role="status">
          {text(
            `${merge.hunks.length} 处改动：已选 ${revisedCount} 处用修稿，${editedCount} 处手动编辑`,
            `${merge.hunks.length} ${pluralEn(merge.hunks.length, 'change')}: ${revisedCount} from the revision, ${editedCount} edited by hand`,
          )}
        </span>
      </div>
      {data.staleReason && <Notice tone="warn" title={text('这份修稿不能合并', 'This revision cannot be merged')}>{data.staleReason}</Notice>}
      <div className="stage-ch-merge-legend">
        <span><i className="stage-ch-swatch" data-kind="original" />{text(`原稿 · ${versionLabel}`, `Original · ${versionLabel}`)}</span>
        <span><i className="stage-ch-swatch" data-kind="revised" />{text('修稿', 'Revision')}</span>
      </div>
      <div className="stage-ch-hunks">
        {merge.segments.map((segment, index) => {
          if (segment.type === 'same') {
            if (!paragraphs[index]) return null
            return <div key={index} className="stage-ch-same">{text(`第 ${paragraphs[index]} 段未改动`, `Paragraph ${paragraphs[index]} unchanged`)}</div>
          }
          const hunk = segment.hunk!
          const paragraph = paragraphs[index]
          const pick = pickOf(hunk.index)
          const name = text(`第 ${paragraph} 段`, `Paragraph ${paragraph}`)
          return (
            <section key={index} className="stage-ch-hunk" data-pick={pick} aria-label={name}>
              <div className="stage-ch-hunk-head">
                <b>{name}</b>
                <SegmentedControl
                  label={text(`${name}用哪一版`, `Which version for ${name}`)}
                  value={pick}
                  onChange={next => merge.choose(hunk.index, next)}
                  options={[
                    { value: 'original', label: text('用原稿', 'Original') },
                    { value: 'revised', label: text('用修稿', 'Revision') },
                    { value: 'edit', label: text('手动编辑', 'Edit') },
                  ]}
                />
              </div>
              <div className="stage-ch-hunk-cols">
                <div className="stage-ch-hunk-col" data-kind="original" data-chosen={pick === 'original'}>
                  {hunk.originalLines.join('\n') || text('（修稿新增的段落）', '(added in the revision)')}
                </div>
                <div className="stage-ch-hunk-col" data-kind="revised" data-chosen={pick === 'revised'}>
                  {hunk.modifiedLines.join('\n') || text('（修稿删去了这一段）', '(removed in the revision)')}
                </div>
              </div>
              {pick === 'edit' && (
                <textarea
                  className="pi-input stage-ch-textarea stage-ch-hunk-edit"
                  aria-label={text(`${name}的合并文字`, `Merged text for ${name}`)}
                  rows={4}
                  value={merge.segTexts[index] ?? ''}
                  onChange={event => merge.editSegment(index, event.target.value)}
                />
              )}
            </section>
          )
        })}
      </div>
      {recheck && <p className="stage-ch-merge-note">
        {text(
          '完成合并后，会自动复验这些意见是否已经解决，结果写回审稿报告；复验没完成时，审稿报告里会出现「重试合并后复验」。',
          'After the merge, a recheck verifies whether the notes were resolved and writes the result to the review report. If it does not finish, the report offers “Retry post-merge recheck”.',
        )}
      </p>}
    </section>
  )
}
