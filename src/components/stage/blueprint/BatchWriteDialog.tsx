import { useId } from 'react'
import {
  MAX_BATCH_CHAPTERS,
  MIN_BATCH_CHAPTERS,
  normalizeBatchChapterCount,
} from '../../../services/workflows/batch-chapter-workflow'
import { CHAPTER_WORDS_TARGET_MAX, CHAPTER_WORDS_TARGET_MIN, normalizeChapterWordsTarget } from '../../../services/workflows/chapter-creation-parameters'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { useBatchChapterForm, type BatchChapterProps } from '../../dialogs/use-batch-chapter-form'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { InkDialog } from '../InkDialog'
import WritePreflight from '../write/WritePreflight'

/** 批量创作：按蓝图连续写几章。每次打开都是新的实例，上一次选的模型不会带到下一次。 */
export default function BatchWriteDialog(props: BatchChapterProps) {
  const session = captureProjectSession(useProjectStore(s => s.currentProject))
  const sessionKey = session ? `${session.projectId}:${session.leaseId}` : 'inactive'
  return <BatchWriteDialogSession key={`${sessionKey}:${props.isOpen ? 'open' : 'closed'}`} {...props} />
}

function BatchWriteDialogSession(props: BatchChapterProps) {
  const form = useBatchChapterForm(props)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const ids = { count: useId(), words: useId(), model: useId(), mode: useId() }
  const { text, start, end, normalizedCount, starting, completionMode } = form
  const auto = completionMode === 'auto_finalize'
  const message = form.modelSelectionError ?? form.authorityError ?? form.error
  const showPreflight = form.consistencyPreflight
    && (form.consistencyPreflight.findings.length > 0 || form.consistencyPreflight.exemptions.some(item => !item.revoked))
  const changed = () => form.setConfirmingAutoFinalize(false)

  return (
    <InkDialog
      open={props.isOpen}
      onOpenChange={open => {
        if (open || starting) return
        form.setError(null)
        props.onClose()
      }}
      title={text('批量创作', 'Batch write')}
      description={text(`按蓝图连续写几章，一次最多 ${MAX_BATCH_CHAPTERS} 章。`, `Write consecutive chapters from their blueprints, up to ${MAX_BATCH_CHAPTERS} at a time.`)}
      footer={(
        <>
          <span className="stage-bp-dialog-note">{text('进度在顶栏「运行」里查看', 'Follow progress from Run in the top bar')}</span>
          <Button variant="secondary" disabled={starting} onClick={props.onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            variant="primary"
            disabled={starting || form.authorityLoading || Boolean(form.authorityError) || Boolean(form.modelSelectionError)}
            onClick={() => void form.handleStart(false)}
          >
            {!auto
              ? text(`开始写 ${normalizedCount} 章`, `Write ${normalizedCount} ${normalizedCount === 1 ? 'chapter' : 'chapters'}`)
              : form.confirmingAutoFinalize
                ? text('确认自动定稿并开始', 'Confirm auto-finalize and start')
                : text('继续确认自动定稿', 'Review auto-finalize')}
          </Button>
        </>
      )}
    >
      <div className="stage-bp-dialog-body">
        <div className="stage-bp-dialog-row stage-bp-dialog-row-3">
          <div className="pi-field">
            <span>{text('从第几章开始', 'Starting chapter')}</span>
            <span className="stage-bp-readonly">{text(`第 ${start} 章`, `Chapter ${start}`)}</span>
          </div>
          <div className="pi-field">
            <label htmlFor={ids.count}>{text('写几章', 'Chapters')} <em>{text(`最多 ${MAX_BATCH_CHAPTERS}`, `Max ${MAX_BATCH_CHAPTERS}`)}</em></label>
            <input
              id={ids.count} type="number" className="pi-input" min={MIN_BATCH_CHAPTERS} max={MAX_BATCH_CHAPTERS}
              value={form.chapterCount} disabled={starting}
              onChange={event => { form.setChapterCount(event.target.value === '' ? '' : Number(event.target.value)); changed() }}
              onBlur={() => form.setChapterCount(normalizeBatchChapterCount(form.chapterCount))}
            />
          </div>
          <div className="pi-field">
            <label htmlFor={ids.words}>{text('每章目标字数', 'Target words')}</label>
            <input
              id={ids.words} type="number" className="pi-input" min={CHAPTER_WORDS_TARGET_MIN} max={CHAPTER_WORDS_TARGET_MAX}
              value={form.chapterWordsTarget} disabled={starting}
              onChange={event => { form.setChapterWordsTarget(event.target.value === '' ? '' : Number(event.target.value)); changed() }}
              onBlur={() => form.setChapterWordsTarget(normalizeChapterWordsTarget(form.chapterWordsTarget, form.currentProject?.novelConfig.wordsPerChapter))}
            />
          </div>
        </div>

        <div className="pi-field">
          <label htmlFor={ids.model}>{text('本次模型', 'Model for this run')} <em>{text('只用于这一次', 'This run only')}</em></label>
          <select
            id={ids.model} className="pi-input" value={form.selectedGenerationModelId ?? ''}
            disabled={starting || form.generationModels.length === 0}
            onChange={event => { form.setGenerationModelId(event.target.value || null); changed(); form.setError(null) }}
          >
            <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
            {form.generationModels.map(model => (
              <option key={model.id} value={model.id}>
                {model.name || model.modelName}{model.id === defaultModelId ? text('（默认）', ' (default)') : ''}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="stage-bp-dialog-field">
          <legend>{text('写完之后', 'When each chapter is done')}</legend>
          <div className="stage-bp-modes">
            {([
              ['draft_review', text('留作草稿，等我审稿', 'Keep as drafts for my review'), text('每章停在草稿，你逐章审稿、修稿、定稿。', 'Each chapter stops at a draft; you review, revise and finalize it.')],
              ['auto_finalize', text('自动定稿', 'Finalize automatically'), text('不经你确认直接定稿并跑完后处理，开始前会再问一次。', 'Finalizes without your review and runs post-processing; you will be asked once more.')],
            ] as const).map(([value, title, detail]) => (
              <label key={value} className="stage-bp-mode" data-tone={value === 'auto_finalize' ? 'warn' : undefined}>
                <input
                  type="radio" name={ids.mode} value={value} checked={completionMode === value} disabled={starting}
                  onChange={() => { form.setCompletionMode(value); changed(); form.setError(null) }}
                />
                <span><b>{title}</b><small>{detail}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="stage-bp-dialog-hint">
          {text(`将写第 ${start}～${end} 章，共 ${normalizedCount} 章。暂停会在当前章写完后生效，取消会阻止下一章开始。`,
            `Chapters ${start}–${end} (${normalizedCount}). Pausing takes effect after the current chapter; cancelling stops the next one from starting.`)}
        </p>

        {auto && (
          <Notice tone="warn" title={form.confirmingAutoFinalize
            ? text(`即将自动定稿第 ${start}～${end} 章`, `About to auto-finalize chapters ${start}–${end}`)
            : text('自动定稿跳过逐章审稿', 'Auto-finalize skips chapter-by-chapter review')}
          >
            {text('章节会提交为只读正文，同时发布实体稿并运行角色与连续性后处理；任一后处理最终失败时任务立即停止。',
              'Chapters are committed as read-only manuscript, published, and run through character and continuity post-processing. The task stops as soon as any step ultimately fails.')}
          </Notice>
        )}

        {showPreflight && form.consistencyPreflight && (
          <WritePreflight
            preflight={form.consistencyPreflight}
            busy={starting}
            onIgnoreOnce={() => void form.handleStart(true)}
            onRerun={() => void form.handleStart(false)}
            onSave={(key, reason) => void form.saveArrangement(key, reason)}
            onRevoke={key => void form.revokeArrangement(key)}
          />
        )}

        {message && <p className="stage-dialog-error stage-bp-prewrap" role="alert">{message}</p>}
      </div>
    </InkDialog>
  )
}
