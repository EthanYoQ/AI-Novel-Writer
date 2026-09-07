import { useEffect, useRef, useState } from 'react'
import { Wand2, AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { guardArchitectureGeneration, guardCharacterRegeneration } from '../../services/workflow-guards'
import { createDefaultArchitectureSelection } from '../../services/architecture-step-selection'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Textarea } from '../ui/Textarea'
import { useLocaleStore } from '../../stores/locale-store'
import { AUDIENCE_EN, GENRE_EN } from '../editor/novel-config-labels'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  label: string
  labelEn: string
  iconName: string
  desc: string
  descEn: string
}> = [
  { key: 'premise', fileName: 'premise.md', label: '故事前提', labelEn: 'Premise', iconName: 'target', desc: 'Logline、核心冲突、金手指定位', descEn: 'Logline, core conflict, and protagonist advantage' },
  { key: 'characters', fileName: 'characters.md', label: '角色图谱', labelEn: 'Characters', iconName: 'users', desc: '角色弧光、关系网、矛盾交织', descEn: 'Character arcs, relationships, and conflicts' },
  { key: 'worldbuilding', fileName: 'worldbuilding.md', label: '世界观', labelEn: 'World building', iconName: 'globe', desc: '核心规则、阶层断层、深层危机', descEn: 'Core rules, social fault lines, and hidden crises' },
  { key: 'synopsis', fileName: 'synopsis.md', label: '情节大纲', labelEn: 'Synopsis', iconName: 'map', desc: '三幕式情节骨架', descEn: 'Three-act plot structure' },
]

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 各架构文件的生成状态 */
  archStatus: Record<string, boolean>
  /** 预先选中的步骤（单文件生成时传入） */
  initialSelectedSteps?: ArchStepKey[]
  /** 打开时预填的情节大纲续批范围（从已确认的下一章开始；to 可在弹窗内调整）。 */
  initialSynopsisRange?: { from: number; to: number } | null
  onConfirm: (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
  ) => Promise<void>
}

/** 默认视作「全书一口气生成」的章数阈值，超过时提示分批。 */
const SCOPE_WARNING_THRESHOLD = 20

/** 生成架构确认弹框（含步骤勾选） */
export default function ArchitectureConfirmDialog({
  isOpen, onClose, archStatus, initialSelectedSteps, initialSynopsisRange = null, onConfirm,
}: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)

  // 默认：未生成的全部勾选；或使用 initialSelectedSteps 覆盖
  const [checked, setChecked] = useState<Record<ArchStepKey, boolean>>(() => {
    return createDefaultArchitectureSelection(archStatus, initialSelectedSteps)
  })
  const wasOpen = useRef(false)

  // 每步的补充指导
  const [stepGuidance, setStepGuidance] = useState<Record<string, string>>({})
  // 是否展开指导输入区
  const [showGuidance, setShowGuidance] = useState(false)
  // 情节大纲本次生成范围（起章/止章；空 = 1..total 全书）
  const [synopsisFrom, setSynopsisFrom] = useState('')
  const [synopsisTo, setSynopsisTo] = useState('')

  // 每次弹窗打开时重置选中状态；续批入口会预填起止章并勾选情节大纲
  const resetChecked = () => {
    const defaults = createDefaultArchitectureSelection(archStatus, initialSelectedSteps)
    if (initialSynopsisRange) {
      defaults.synopsis = true
      setSynopsisFrom(String(initialSynopsisRange.from))
      setSynopsisTo(String(initialSynopsisRange.to))
    } else {
      setSynopsisFrom('')
      setSynopsisTo('')
    }
    setChecked(defaults)
  }

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      resetChecked()
    }
    wasOpen.current = isOpen
  }, [archStatus, initialSelectedSteps, isOpen, initialSynopsisRange])

  const [isConfirming, setIsConfirming] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)

  if (!currentProject) return null
  const config = currentProject.novelConfig
  const genre = [text(config.genre, GENRE_EN[config.genre] ?? config.genre), config.subGenre]
    .filter(Boolean)
    .join(' · ')
  const audience = text(config.targetAudience, AUDIENCE_EN[config.targetAudience] ?? config.targetAudience)

  const toggleStep = (key: ArchStepKey) =>
    setChecked(prev => ({ ...prev, [key]: !prev[key] }))

  const selectedSteps = (Object.keys(checked) as ArchStepKey[]).filter(k => checked[k])
  const noneSelected = selectedSteps.length === 0

  // 情节大纲本次生成范围：空值回落到 1 / totalChapters（全书）。
  const totalChapters = Number(config.totalChapters) > 0 ? Number(config.totalChapters) : 0
  const resolveSynopsisRange = (): { ok: true; range?: { from: number; to: number } } | { ok: false } => {
    if (!checked.synopsis || totalChapters <= 0) return { ok: true }
    const parseBound = (value: string): number | null => {
      if (!value.trim()) return null
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
    }
    const from = parseBound(synopsisFrom) ?? 1
    const to = parseBound(synopsisTo) ?? totalChapters
    if (from > totalChapters || to > totalChapters || from > to) return { ok: false }
    return from === 1 && to === totalChapters
      ? { ok: true }
      : { ok: true, range: { from, to } }
  }

  const handleConfirm = async () => {
    if (noneSelected) return
    setIsConfirming(true)
    try {
      // 前置校验 1：小说配置是否填写
      const configGuard = guardArchitectureGeneration()
      if (!configGuard.ok) {
        setGuardError(configGuard.message || text('配置校验失败', 'Configuration validation failed.'))
        return
      }

      // 范围合法性（超出总章数或起大于止）
      const resolution = resolveSynopsisRange()
      if (!resolution.ok) {
        setGuardError(text(
          `情节大纲范围无效：应在第 1–${totalChapters} 章之间且起始章 ≤ 结束章。`,
          `Invalid plot-outline range: it must stay within chapters 1-${totalChapters} with from ≤ to.`,
        ))
        return
      }

      // 前置校验 2：如果勾选了角色图谱（意味着将重新生成角色卡），则必须确保蓝图为空
      if (selectedSteps.includes('characters') && archStatus.characters) {
        const charGuard = await guardCharacterRegeneration(undefined, locale)
        if (!charGuard.ok) {
          setGuardError(charGuard.message || text('角色卡不可重新生成', 'Character cards cannot be regenerated.'))
          return
        }
      }

      setGuardError(null)
      await onConfirm(selectedSteps, stepGuidance, resolution.range)
      onClose()
      const stepNames = selectedSteps.map(k => {
        const item = ARCH_FILES.find(f => f.key === k)
        return item ? text(item.label, item.labelEn) : ''
      }).filter(Boolean).join(text('、', ', '))
      toast.info(text(`已提交：正在生成${stepNames}...`, `Submitted: generating ${stepNames}...`))
    } catch (error) {
      setGuardError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsConfirming(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose()
    } else {
      resetChecked()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[460px]">
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
              <ConfigRow label={text('每章字数', 'Words/chapter')} value={text(`${config.wordsPerChapter} 字`, `${config.wordsPerChapter} words`)} />
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
                onClick={() => setChecked({ premise: true, characters: true, worldbuilding: true, synopsis: true })}
                className="text-xs underline"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {text('全选', 'Select all')}
              </button>
            </div>

            {ARCH_FILES.map(f => {
              const exists = archStatus[f.key]
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
                    {text(f.label, f.labelEn)}
                    <span className="ml-1 text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                      — {text(f.desc, f.descEn)}
                    </span>
                  </span>

                  {/* 状态标签 */}
                  <span
                    className={`text-[0.7rem] px-1.5 py-0.5 rounded flex-shrink-0 ${
                      exists
                        ? isChecked
                          ? 'bg-yellow-500/15 text-[var(--color-warning-text)]'
                          : 'bg-green-500/10 text-[var(--color-success-text)]'
                        : 'bg-[rgba(var(--color-accent-rgb),0.1)] text-[var(--color-accent)]'
                    }`}
                  >
                    {exists ? (isChecked ? text('将覆盖', 'Overwrite') : text('保留', 'Keep')) : text('待生成', 'New')}
                  </span>
                </label>
              )
            })}
          </div>

          {/* 情节大纲 —— 本次生成范围（警示 + 起止章输入；仅总章数较多时提示分批） */}
          {checked.synopsis && totalChapters > SCOPE_WARNING_THRESHOLD && (
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
                  {text(
                    `全书共 ${totalChapters} 章。若一口气生成全部章节大纲，等待时间会明显变长，且单次输出过长容易被模型输出上限截断、导致大纲质量下降。建议分块：本次只填写一个较小的范围（如第 1–20 章）；本批完成后，可在架构页点击「续写剩余章节」或再次打开本框生成下一批（第 21 章起），已生成的部分不会被覆盖。`,
                    `The book spans ${totalChapters} chapters. Generating the full outline in one pass takes much longer, and an oversized single output tends to be cut off by the model output limit and lose quality. Generate it in blocks: fill a smaller range for this batch (e.g. chapters 1-20); after the batch completes, use “Continue remaining chapters” on the architecture page or reopen this dialog for the next batch (from chapter 21) — confirmed parts are never overwritten.`,
                  )}
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
                    {text('章（留空起始=1、结束=全书）', 'chapter (leave empty: from 1 / to the whole book)')}
                  </span>
                </div>
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
                        {text(f.label, f.labelEn)}
                      </label>
                      <Textarea
                        value={stepGuidance[f.key] || ''}
                        onChange={e => setStepGuidance(prev => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={text(`对「${f.label}」生成的特殊要求，如：“多强调金手指的限制”`, `Special requirements for “${f.labelEn}”, such as limitations on the protagonist advantage`)}
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
          <Button variant="default" onClick={handleConfirm} disabled={noneSelected || isConfirming}>
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
