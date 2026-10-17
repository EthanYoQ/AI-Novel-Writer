import { Wand2, AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { ARCH_STEP_NAMES, type ArchStepKey } from '../../services/architecture-step-selection'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'
import { useLocaleStore } from '../../stores/locale-store'
import { AUDIENCE_EN, GENRE_EN } from '../editor/novel-config-labels'
import { resolveWritingLanguage } from '../../shared/writing-language'
import { PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../shared/plot-outline-contract'
import { useArchitectureConfirmForm, type ArchitectureConfirmFormOptions } from './use-architecture-confirm-form'
import { pluralEn } from '../../shared/plural-en'

/** 四节的说明；名字取 ARCH_STEP_NAMES。 */
const ARCH_FILES: Array<{ key: ArchStepKey; desc: string; descEn: string }> = [
  { key: 'premise', desc: 'Logline、核心冲突、金手指定位', descEn: 'Logline, core conflict, and protagonist advantage' },
  { key: 'characters', desc: '角色弧光、关系网、矛盾交织', descEn: 'Character arcs, relationships, and conflicts' },
  { key: 'worldbuilding', desc: '核心规则、阶层断层、深层危机', descEn: 'Core rules, social fault lines, and hidden crises' },
  { key: 'synopsis', desc: '三幕式情节骨架', descEn: 'Three-act plot structure' },
]

/** 生成架构确认弹框（含步骤勾选） */
export default function ArchitectureConfirmDialog(props: ArchitectureConfirmFormOptions) {
  const { isOpen, onClose } = props
  const text = useLocaleStore(s => s.text)
  const form = useArchitectureConfirmForm(props)
  const {
    config, checked, toggleStep, setAll, selectedSteps, noneSelected, stepGuidance, showGuidance, setShowGuidance,
    synopsisFrom, setSynopsisFrom, synopsisTo, setSynopsisTo, targetUnits, setTargetUnits, preferenceLoading,
    isConfirming, guardError, totalChapters, handleConfirm, handleOpenChange,
  } = form

  if (!config) return null
  const genre = [text(config.genre, GENRE_EN[config.genre] ?? config.genre), config.subGenre]
    .filter(Boolean)
    .join(' · ')
  const audience = text(config.targetAudience, AUDIENCE_EN[config.targetAudience] ?? config.targetAudience)

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[460px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 size={16} className="text-[var(--color-accent)]" />
            {text('AI 生成故事架构', 'Generate story architecture with AI')}
          </DialogTitle>
          <DialogDescription>
            {text('勾选要生成的步骤，未勾选的步骤将保留已有内容', 'Select the sections to generate. Unselected sections keep their existing content.')}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 space-y-4">
          {/* 配置预览 */}
          <div
            className="rounded-lg p-3 space-y-1.5 text-xs"
            style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
          >
            <p className="font-medium text-[0.7rem] mb-2" style={{ color: 'var(--color-text-muted)' }}>
              {text('当前配置预览', 'Current configuration')}
            </p>
            <div className="grid grid-cols-2 gap-1">
              <ConfigRow label={text('类型', 'Genre')} value={genre} />
              <ConfigRow label={text('受众', 'Audience')} value={audience} />
              <ConfigRow label={text('总章数', 'Chapters')} value={text(`${config.totalChapters} 章`, `${config.totalChapters}`)} />
              <ConfigRow label={text('每章字数', 'Words/chapter')} value={text(`${config.wordsPerChapter} 字`, `${config.wordsPerChapter} ${pluralEn(config.wordsPerChapter, 'word')}`)} />
            </div>
            {config.coreOutline && (
              <p
                className="mt-1.5 pt-1.5 text-xs"
                style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
              >
                {config.coreOutline.slice(0, 80)}{config.coreOutline.length > 80 ? '...' : ''}
              </p>
            )}
          </div>

          {/* 步骤勾选列表 */}
          <div
            className="rounded-lg p-3 space-y-2.5"
            style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
          >
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {text('勾选要生成的步骤', 'Sections to generate')}
              </p>
              <button
                onClick={() => setAll(true)}
                className="text-xs underline"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {text('全选', 'Select all')}
              </button>
            </div>

            {ARCH_FILES.map(f => {
              const mark = form.stepMark(f.key)
              const isChecked = checked[f.key]
              return (
                <label
                  key={f.key}
                  className="flex items-center gap-2.5 cursor-pointer select-none"
                  onClick={() => toggleStep(f.key)}
                >
                  {/* 复选框 */}
                  <div
                    className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all"
                    style={{
                      backgroundColor: isChecked ? 'var(--color-accent)' : 'transparent',
                      border: `1.5px solid ${isChecked ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    }}
                  >
                    {isChecked && (
                      <Check size={10} strokeWidth={2} />
                    )}
                  </div>

                  {/* 步骤名 */}
                  <span className="text-xs flex-1" style={{ color: isChecked ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                    {text(...ARCH_STEP_NAMES[f.key])}
                    <span className="ml-1 text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                      — {text(f.desc, f.descEn)}
                    </span>
                  </span>

                  {/* 状态标签 */}
                  <span
                    data-mark={mark}
                    className={`text-[0.7rem] px-1.5 py-0.5 rounded flex-shrink-0 ${
                      mark === 'overwrite' || mark === 'invalid'
                        ? 'bg-yellow-500/15 text-[var(--color-warning-text)]'
                        : mark === 'keep'
                          ? 'bg-green-500/10 text-[var(--color-success-text)]'
                          : 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]'
                    }`}
                  >
                    {form.markLabel(f.key)}
                  </span>
                </label>
              )
            })}
          </div>

          {checked.synopsis && totalChapters > 0 && (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--color-warning-text)' }}>
                <AlertTriangle size={13} />
                {text('情节大纲 · 本次生成范围', 'Plot outline · batch scope')}
              </div>
              <p
                role="note"
                className="text-xs leading-relaxed m-0"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                  {text(`全书共 ${totalChapters} 章，每次最多生成 ${PLANNING_ACTION_CHAPTER_LIMIT} 章。完成后可继续下一批。`, `The book has ${totalChapters} ${pluralEn(totalChapters, 'chapter')}. Generate up to ${PLANNING_ACTION_CHAPTER_LIMIT} ${pluralEn(PLANNING_ACTION_CHAPTER_LIMIT, 'chapter')} per action, then continue with the next batch.`)}
                </p>
                <div className="flex items-center gap-1.5 text-xs">
                  <span style={{ color: 'var(--color-text-muted)' }}>{text('第', 'From ch.')}</span>
                  <input
                    type="number"
                    min={1}
                    max={totalChapters}
                    value={synopsisFrom}
                    onChange={e => setSynopsisFrom(e.target.value)}
                    placeholder="1"
                    aria-label={text('本次生成范围的起始章', 'First chapter of this batch')}
                    className="w-16 rounded-md px-2 py-1.5 text-xs outline-none transition-colors"
                    style={{
                      color: 'var(--color-text)',
                      backgroundColor: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <span style={{ color: 'var(--color-text-muted)' }}>{text('章 到第', 'to ch.')}</span>
                  <input
                    type="number"
                    min={1}
                    max={totalChapters}
                    value={synopsisTo}
                    onChange={e => setSynopsisTo(e.target.value)}
                    placeholder={String(totalChapters)}
                    aria-label={text('本次生成范围的结束章', 'Last chapter of this batch')}
                    className="w-16 rounded-md px-2 py-1.5 text-xs outline-none transition-colors"
                    style={{
                      color: 'var(--color-text)',
                      backgroundColor: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <span className="text-xs flex-1" style={{ color: 'var(--color-text-muted)' }}>
                    {text('章', 'chapter')}
                  </span>
                </div>
                <label className="block text-xs">
                  {resolveWritingLanguage(config.writingLanguage) === 'zh-CN'
                    ? text('每章大纲目标字数', 'Outline target characters per chapter')
                    : text('每章大纲目标词数', 'Outline target words per chapter')}
                  <input
                    type="number" min={1} max={PLANNING_TARGET_UNITS_LIMIT} step={1}
                    value={targetUnits} disabled={preferenceLoading}
                    onChange={event => setTargetUnits(event.target.value)}
                    className="ml-2 w-20 rounded-md border px-2 py-1.5 bg-[var(--color-bg)]"
                  />
                </label>
                <p className="text-xs text-[var(--color-text-muted)]">{text('仅作生成目标，实际内容可多可少。', 'A generation target. Actual content may be longer or shorter.')}</p>
                {form.synopsisEffectNote && <p className="text-xs m-0" style={{ color: 'var(--color-text-secondary)' }}>{form.synopsisEffectNote}</p>}
                {form.synopsisRangeIssue && <p role="alert" className="text-xs m-0 text-[var(--color-warning-text)]">{form.synopsisRangeIssue}</p>}
            </div>
          )}

          {/* 逐步指导区域（可折叠） */}
          {selectedSteps.length > 0 && (
            <div
              className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--color-border)' }}
            >
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium cursor-pointer"
                style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-panel)' }}
                onClick={() => setShowGuidance(!showGuidance)}
              >
                {showGuidance ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {text('为每个步骤添加补充指导（可选）', 'Add guidance for each section (optional)')}
              </button>
              {showGuidance && (
                <div className="px-3 pb-3 space-y-3" style={{ backgroundColor: 'var(--color-panel)' }}>
                  {ARCH_FILES.filter(f => checked[f.key]).map(f => (
                    <div key={f.key}>
                      <label className="text-[0.7rem] font-medium mb-1 block" style={{ color: 'var(--color-text-muted)' }}>
                        {text(...ARCH_STEP_NAMES[f.key])}
                      </label>
                      <Textarea
                        value={stepGuidance[f.key] || ''}
                        onChange={e => form.setStepGuidance(f.key, e.target.value)}
                        placeholder={text(`对「${ARCH_STEP_NAMES[f.key][0]}」生成的特殊要求，如：“多强调金手指的限制”`, `Special requirements for “${ARCH_STEP_NAMES[f.key][1]}”, such as limitations on the protagonist advantage`)}
                        rows={2}
                        className="text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {noneSelected && (
            <p className="text-xs px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[var(--color-error-text)]">
              <AlertTriangle size={13} className="inline mr-1" />
              {text('请至少勾选一个步骤', 'Select at least one section.')}
            </p>
          )}
          {/* 前置校验失败提示 */}
          {guardError && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs bg-yellow-500/10 border border-yellow-500/30 text-[var(--color-warning-text)]">
              <AlertCircle size={13} className="flex-shrink-0 mt-0.5 text-[var(--color-warning)]" />
              <span className="whitespace-pre-line">{guardError}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isConfirming}>{text('取消', 'Cancel')}</Button>
          <Button variant="default" onClick={handleConfirm} disabled={noneSelected || isConfirming || form.synopsisRangeIssue !== null || (checked.synopsis && preferenceLoading)}>
            <Wand2 size={13} />
            {isConfirming ? text('校验中...', 'Validating...') : text(`确认生成（${selectedSteps.length}/4）`, `Generate (${selectedSteps.length}/4)`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="flex items-center gap-1 text-xs">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}：</span>
      <span style={{ color: 'var(--color-text)' }}>{value || text('未填写', 'Not set')}</span>
    </div>
  )
}
