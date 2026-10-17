import { useId } from 'react'
import { RotateCcw, Sparkles } from 'lucide-react'
import { getBlueprintBatchAdvice } from '../../../services/workflows/blueprint-batch-policy'
import { resolveWritingLanguage } from '../../../shared/writing-language'
import { PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../../shared/plot-outline-contract'
import { useDirectoryConfigForm, type DirectoryConfigProps } from '../../dialogs/use-directory-config-form'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { InkDialog } from '../InkDialog'
import { pluralEn } from '../../../shared/plural-en'

const numberValue = (value: string): number | '' => value === '' ? '' : Number(value)

/** AI 生成蓝图：范围、每章目标、已有蓝图的处理方式与节奏指导。表单逻辑在 useDirectoryConfigForm。 */
export default function GenerateBlueprintsDialog(props: DirectoryConfigProps) {
  const form = useDirectoryConfigForm(props)
  const ids = { targetUnits: useId(), pacing: useId(), range: useId() }
  if (!form) return null
  const { text, total, appendStart, hasPriorAuthority } = form
  const busy = form.isConfirming || form.isRecovering
  // 指定范围只从接着的那一章往后补，从不覆盖已有蓝图，所以这时不给覆盖选项。
  const showExisting = (props.existingCount > 0 || hasPriorAuthority) && form.rangeMode !== 'range'
  const overwrite = showExisting && form.overwriteMode === 'full'
  const zh = resolveWritingLanguage(form.currentProject.novelConfig.writingLanguage) === 'zh-CN'

  const description = props.existingCount > 0
    ? text(`按情节大纲为章节生成蓝图。已有 ${props.existingCount} 章蓝图，默认保留不动。`, `Generate chapter blueprints from the plot outline. ${props.existingCount} existing ${pluralEn(props.existingCount, 'blueprint')} ${pluralEn(props.existingCount, 'is', 'are')} kept by default.`)
    : hasPriorAuthority
      ? text(`正文已定稿到第 ${appendStart - 1} 章，蓝图从第 ${appendStart} 章开始。`, `The manuscript is finalized through chapter ${appendStart - 1}; blueprints start at chapter ${appendStart}.`)
      : text(`按情节大纲为章节生成蓝图。作品共 ${total} 章。`, `Generate chapter blueprints from the plot outline. The book has ${total} ${pluralEn(total, 'chapter')}.`)

  return (
    <InkDialog
      open={props.isOpen}
      onOpenChange={open => { if (!open && !busy) props.onClose() }}
      title={text('AI 生成蓝图', 'Generate blueprints')}
      description={description}
      footer={(
        <>
          {overwrite && <span className="stage-bp-dialog-note">{text('已有蓝图会被覆盖，开始前再确认一次', 'Existing blueprints will be replaced; you will confirm once more')}</span>}
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || form.preferenceLoading || form.authorityLoading || Boolean(form.authorityError)}
            aria-busy={form.isConfirming || undefined}
            onClick={() => void form.handleConfirm()}
          >
            <Sparkles size={15} aria-hidden />
            {form.isConfirming ? text('启动中…', 'Starting…') : text('开始生成', 'Generate')}
          </Button>
        </>
      )}
    >
      <div className="stage-bp-dialog-body">
        {form.progressError && <p className="stage-dialog-error" role="alert">{form.progressError}</p>}
        {form.diagnostics.length > 0 && (
          <Notice tone="warn" title={text('旧的生成记录不能续接', 'Previous generation runs cannot continue')}>
            {[...new Set(form.diagnostics.map(item => item.code))].map(code => <span key={code} className="stage-bp-dialog-line">
              {code === 'GENERATION_BLUEPRINTS_CLEARED'
                ? text('蓝图已清空，旧生成记录不能续接。', 'Blueprints were cleared. Previous generation runs cannot continue.')
                : code === 'GENERATION_DIRECTORY_PROGRESS_INVALID'
                  ? text('旧蓝图生成进度校验失败，不能续接。', 'Previous blueprint generation progress failed validation and cannot continue.')
                  : text('旧蓝图作者保存记录校验失败，不能续接。', 'A previous author save record failed validation and cannot continue.')}
            </span>)}
            <span className="stage-bp-dialog-line">{text('旧恢复稿仍可编辑或复制，也可开始新的蓝图生成。', 'You can still edit or copy old recovery drafts, or start new blueprint generation.')}</span>
          </Notice>
        )}
        {form.progress.map(progress => (
          <Notice
            key={progress.operationId}
            title={text(`已保存第 ${progress.committedRange.startChapter}～${progress.committedRange.endChapter} 章蓝图`,
              `Blueprints for chapters ${progress.committedRange.startChapter}–${progress.committedRange.endChapter} are saved`)}
            actions={progress.remainingRange && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void form.continueOperation(progress.operationId)}>
                {text(`继续第 ${progress.remainingRange.startChapter}～${progress.remainingRange.endChapter} 章`,
                  `Continue chapters ${progress.remainingRange.startChapter}–${progress.remainingRange.endChapter}`)}
              </Button>
            )}
          >
            {progress.remainingRange
              ? text('上次生成中断，可以沿用原预算接着生成剩下的章节。', 'The last run stopped partway. You can continue the rest with the same budget.')
              : text('该范围已完成。', 'This range is complete.')}
          </Notice>
        ))}

        <fieldset className="stage-bp-dialog-field">
          <legend id={ids.range}>{text('生成范围', 'Range')}</legend>
          <label className="stage-bp-option">
            <input type="radio" name={ids.range} checked={form.rangeMode === 'front'} onChange={() => form.setRangeMode('front')} />
            {text('接着生成', 'Next')}
            <input
              type="number" className="pi-input stage-bp-num" min={1} max={PLANNING_ACTION_CHAPTER_LIMIT} step={1}
              aria-label={text('本次蓝图章数', 'Blueprint chapters in this action')}
              value={form.frontN} onChange={event => form.setFrontN(numberValue(event.target.value))}
              onFocus={() => form.setRangeMode('front')}
            />
            {text('章', 'chapters')}
          </label>
          <label className="stage-bp-option">
            <input type="radio" name={ids.range} checked={form.rangeMode === 'range'} onChange={() => form.setRangeMode('range')} />
            {text('第', 'Chapters')}
            <input
              type="number" className="pi-input stage-bp-num" min={1} max={total} step={1}
              aria-label={text('蓝图起始章', 'First blueprint chapter')}
              value={form.rangeStart} onChange={event => form.setRangeStart(numberValue(event.target.value))}
              onFocus={() => form.setRangeMode('range')}
            />
            {text('章至第', 'to')}
            <input
              type="number" className="pi-input stage-bp-num" min={1} max={total} step={1}
              aria-label={text('蓝图结束章', 'Last blueprint chapter')}
              value={form.rangeEnd} onChange={event => form.setRangeEnd(numberValue(event.target.value))}
              onFocus={() => form.setRangeMode('range')}
            />
            {text('章', '')}
          </label>
          <label className="stage-bp-option">
            <input type="radio" name={ids.range} checked={form.rangeMode === 'full'} onChange={() => form.setRangeMode('full')} />
            {text(`全部 ${total} 章`, `All ${total} ${pluralEn(total, 'chapter')}`)}
          </label>
          <p className="stage-bp-dialog-hint">
            {text(getBlueprintBatchAdvice('zh-CN', form.previewCost.chapterCount), getBlueprintBatchAdvice('en-US', form.previewCost.chapterCount))}
            {form.previewCost.exceedsHardLimit && text(
              ' 大范围可能耗尽本次预算；已验证的连续蓝图会保存，剩余范围保持未完成。',
              ' Large ranges may exhaust this action’s budget. Validated consecutive blueprints are saved; the rest remain incomplete.',
            )}
          </p>
        </fieldset>

        <div className="stage-bp-dialog-row">
          <div className="pi-field">
            <label htmlFor={ids.targetUnits}>{zh ? text('每章蓝图目标字数', 'Blueprint target characters per chapter') : text('每章蓝图目标词数', 'Blueprint target words per chapter')}</label>
            <input
              id={ids.targetUnits} type="number" className="pi-input" min={1} max={PLANNING_TARGET_UNITS_LIMIT} step={1}
              value={form.targetUnits} disabled={form.preferenceLoading} onChange={event => form.setTargetUnits(event.target.value)}
            />
          </div>
          {showExisting && (
            <div className="pi-field">
              <span>{text('已有蓝图的章节', 'Existing blueprints')}</span>
              <SegmentedControl
                label={text('已有蓝图的章节', 'Existing blueprints')}
                value={form.overwriteMode}
                onChange={form.setOverwriteMode}
                options={[
                  { value: 'append', label: text('保留，只补空缺', 'Keep, fill gaps') },
                  { value: 'full', label: text('覆盖', 'Overwrite') },
                ]}
              />
            </div>
          )}
        </div>

        <div className="pi-field">
          <label htmlFor={ids.pacing}>{text('节奏与风格指导', 'Pacing and style guidance')} <em>{text('可选', 'Optional')}</em></label>
          <textarea
            id={ids.pacing} className="pi-input stage-bp-dialog-textarea" rows={2} value={form.pacingGuidance}
            placeholder={text('比如：前 30 章快节奏，每章一个爽点；中期铺设伏笔与角色成长。', 'For example: keep the first 30 chapters fast-paced, then add foreshadowing and character growth.')}
            onChange={event => form.setPacingGuidance(event.target.value)}
          />
        </div>

        {(form.isRecoveryLoading || form.pendingCharacterSyncs.length > 0 || form.recoveryError) && (
          <Notice
            tone="warn"
            title={form.isRecoveryLoading
              ? text('正在检查角色同步待办…', 'Checking pending character syncs…')
              : form.pendingCharacterSyncs.length > 0
                ? text(`有 ${form.pendingCharacterSyncs.length} 次角色同步待修复`, `${form.pendingCharacterSyncs.length} character sync operation(s) need repair`)
                : text('角色同步检查失败', 'Character sync check failed')}
            actions={!form.isRecoveryLoading && (
              <Button variant="text" size="sm" disabled={form.isRecovering} onClick={() => void form.handleCharacterSyncRecovery()}>
                <RotateCcw size={13} aria-hidden />
                {form.isRecovering ? text('修复中…', 'Repairing…') : text('重试角色同步', 'Retry character sync')}
              </Button>
            )}
          >
            {form.pendingCharacterSyncs.length > 0
              ? text('蓝图已安全保存，无需重新生成。', 'The blueprints are already saved; no need to regenerate.')
              : form.recoveryError}
          </Notice>
        )}

        {form.launchError && <p className="stage-dialog-error stage-bp-prewrap" role="alert">{form.launchError}</p>}
        {form.authorityError && <p className="stage-dialog-error stage-bp-prewrap" role="alert">{form.authorityError}</p>}
      </div>
    </InkDialog>
  )
}
