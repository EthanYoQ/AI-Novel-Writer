import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { ARCH_STEP_NAMES } from '../../../services/architecture-step-selection'
import { resolveWritingLanguage } from '../../../shared/writing-language'
import { PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../../shared/plot-outline-contract'
import { useLocaleStore } from '../../../stores/locale-store'
import { useArchitectureConfirmForm, type ArchitectureConfirmFormOptions } from '../../dialogs/use-architecture-confirm-form'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { Notice } from '../../ui/Notice'
import { InkDialog } from '../InkDialog'
import { SECTION_ORDER } from './architecture-sections'
import { pluralEn } from '../../../shared/plural-en'

/** 生成架构的确认对话框。表单与校验沿用 ArchitectureConfirmDialog 的 useArchitectureConfirmForm，这里只换成纸墨样式。 */
export default function ArchitectureGenerateDialog(props: ArchitectureConfirmFormOptions) {
  const text = useLocaleStore(s => s.text)
  const form = useArchitectureConfirmForm(props)
  const { config, checked, selectedSteps, totalChapters } = form
  if (!config) return null
  const allChecked = selectedSteps.length === SECTION_ORDER.length
  const unit = resolveWritingLanguage(config.writingLanguage) === 'zh-CN' ? text('字', 'characters') : text('词', 'words')
  const overwritingCast = form.stepMark('characters') === 'overwrite'

  return (
    <InkDialog
      open={props.isOpen}
      onOpenChange={form.handleOpenChange}
      title={text('生成架构', 'Generate architecture')}
      description={text('勾选要交给 AI 的部分。已确认的内容默认保留；勾选已确认的节会覆盖它，并在右侧标出。', 'Choose the sections for AI. Confirmed sections are kept unless you tick them; ticked confirmed sections are overwritten and marked on the right.')}
      footer={(
        <>
          {overwritingCast && <p className="arch-dialog-warning">{text('角色名单会被重写，现有角色档案的改动将丢失。', 'The cast will be rewritten and edits to existing profiles will be lost.')}</p>}
          <Button variant="secondary" onClick={props.onClose} disabled={form.isConfirming}>{text('取消', 'Cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => { void form.handleConfirm() }}
            disabled={form.noneSelected || form.isConfirming || form.synopsisRangeIssue !== null || (checked.synopsis && form.preferenceLoading)}
          >
            <Sparkles size={14} aria-hidden />
            {form.isConfirming ? text('校验中…', 'Checking…') : text(`开始生成 ${selectedSteps.length} 项`, `Generate ${selectedSteps.length}`)}
          </Button>
        </>
      )}
    >
      <div className="arch-dialog">
        <div className="arch-steps" role="group" aria-label={text('要生成的节', 'Sections to generate')}>
          <div className="arch-step arch-step-all">
            <Check checked={allChecked} onChange={form.setAll} label={text('全选', 'Select all')} />
            <span className="arch-step-count">{text(`已选 ${selectedSteps.length} / ${SECTION_ORDER.length}`, `${selectedSteps.length} / ${SECTION_ORDER.length} selected`)}</span>
          </div>
          {SECTION_ORDER.map(key => {
            const mark = form.stepMark(key)
            return (
              <div key={key} className="arch-step" data-step={key}>
                <div className="arch-step-row">
                  <Check
                    checked={checked[key]}
                    onChange={() => form.toggleStep(key)}
                    label={<>{text(...ARCH_STEP_NAMES[key])}<span className="arch-step-status">{form.statusLabel(key)}</span></>}
                  />
                  <span className="arch-mark" data-mark={mark}>{form.markLabel(key)}</span>
                </div>
                {key === 'synopsis' && checked.synopsis && totalChapters > 0 && (
                  <div className="arch-range">
                    <label className="arch-range-field">
                      {text('章节范围 第', 'Chapters')}
                      <input className="pi-input" type="number" min={1} max={totalChapters} value={form.synopsisFrom}
                        aria-label={text('本次生成范围的起始章', 'First chapter of this batch')}
                        onChange={event => form.setSynopsisFrom(event.target.value)} />
                    </label>
                    <label className="arch-range-field">
                      {text('章至第', 'to')}
                      <input className="pi-input" type="number" min={1} max={totalChapters} value={form.synopsisTo}
                        aria-label={text('本次生成范围的结束章', 'Last chapter of this batch')}
                        onChange={event => form.setSynopsisTo(event.target.value)} />
                    </label>
                    <label className="arch-range-field">
                      {text('每章大纲约', 'About')}
                      <input className="pi-input" type="number" min={1} max={PLANNING_TARGET_UNITS_LIMIT} step={1} value={form.targetUnits}
                        disabled={form.preferenceLoading} aria-label={text(`每章大纲目标${unit}数`, `Outline target ${unit} per chapter`)}
                        onChange={event => form.setTargetUnits(event.target.value)} />
                      {unit}
                    </label>
                    <p className="arch-range-note">
                      {text(`全书 ${totalChapters} 章，每次最多 ${PLANNING_ACTION_CHAPTER_LIMIT} 章；目标字数只作参考。`, `${totalChapters} ${pluralEn(totalChapters, 'chapter')} in all, up to ${PLANNING_ACTION_CHAPTER_LIMIT} per run; the target is a guide.`)}
                    </p>
                    {form.synopsisEffectNote && <p className="arch-range-effect">{form.synopsisEffectNote}</p>}
                    {form.synopsisRangeIssue && <p className="arch-range-issue" role="alert">{form.synopsisRangeIssue}</p>}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {selectedSteps.length > 0 && (
          <div className="arch-guidance">
            <Button variant="text" size="sm" aria-expanded={form.showGuidance} onClick={() => form.setShowGuidance(!form.showGuidance)}>
              {form.showGuidance ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {text('作者指导', 'Author guidance')}
              <span className="arch-guidance-hint">{text('可选，会和设定一起交给 AI', 'Optional, sent to AI with the setup')}</span>
            </Button>
            {form.showGuidance && SECTION_ORDER.filter(key => checked[key]).map(key => (
              <label key={key} className="pi-field">
                {text(...ARCH_STEP_NAMES[key])}
                <textarea
                  className="pi-input arch-guidance-input"
                  rows={2}
                  value={form.stepGuidance[key] || ''}
                  onChange={event => form.setStepGuidance(key, event.target.value)}
                />
              </label>
            ))}
          </div>
        )}

        {form.noneSelected && <Notice tone="warn" title={text('请至少勾选一节', 'Select at least one section.')} />}
        {form.guardError && <Notice tone="warn" title={text('还不能开始生成', 'Cannot start yet')}><span className="arch-guard">{form.guardError}</span></Notice>}
      </div>
    </InkDialog>
  )
}
