import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { guardArchitectureGeneration, guardCharacterRegeneration } from '../../services/workflow-guards'
import { ARCH_STEP_NAMES, createDefaultArchitectureSelection, type ArchStepKey } from '../../services/architecture-step-selection'
import { toast } from '../ui/Toast'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import { assertPlanningActionRange, DEFAULT_PLANNING_ACTION_CHAPTERS, DEFAULT_PLANNING_TARGET_UNITS, parsePlanningTargetUnits, PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT, plotOutlineLastChapter, plotOutlineNextChapter, plotOutlineRangeEffect, type PlotOutlineRangeEffect, type PlotOutlineRangeSource } from '../../shared/plot-outline-contract'
import { displayedErrorMessage } from '../../i18n/app-errors'

/**
 * 每节在本次生成里的结果：已有内容且勾选为覆盖，未勾选为保留，还没有内容为新生成。
 * 情节大纲按主进程的判定（plotOutlineRangeEffect）：替换已有的章为覆盖，紧接已有章节往后写为续写，后台会拒绝的范围为无效。
 */
export type ArchStepMark = 'overwrite' | 'keep' | 'new' | 'continue' | 'invalid'

const MARK_TEXT: Record<ArchStepMark, readonly [string, string]> = {
  overwrite: ['将覆盖', 'Overwrite'],
  keep: ['保留', 'Keep'],
  new: ['新生成', 'New'],
  continue: ['续写', 'Continue'],
  invalid: ['范围无效', 'Invalid range'],
}

export interface ArchitectureConfirmFormOptions {
  isOpen: boolean
  onClose: () => void
  /** 每节是否已有内容：决定覆盖还是新生成、角色名单是否要重新生成角色卡。 */
  archStatus: Record<string, boolean>
  /** 每节是否已确认（与架构页徽标同一判定）：决定状态文字与默认勾选；不传时按 archStatus。 */
  confirmed?: Record<string, boolean>
  initialSelectedSteps?: ArchStepKey[]
  initialSynopsisRange?: { from: number; to: number } | null
  /** 数据库里的正式大纲，主进程开跑时拿它判定范围；未保存的编辑不算。 */
  synopsisSource: PlotOutlineRangeSource
  onConfirm: (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
    targetUnits?: number,
  ) => Promise<void>
}

/** 架构确认对话框的表单：步骤勾选、大纲范围、每章目标字数、作者指导与提交前校验。架构阶段与架构文档页的生成对话框共用。 */
export function useArchitectureConfirmForm({
  isOpen, onClose, archStatus, confirmed = archStatus, initialSelectedSteps, initialSynopsisRange = null, synopsisSource, onConfirm,
}: ArchitectureConfirmFormOptions) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)

  // 默认：未确认的全部勾选；或使用 initialSelectedSteps 覆盖
  const [checked, setChecked] = useState<Record<ArchStepKey, boolean>>(() => {
    return createDefaultArchitectureSelection(confirmed, initialSelectedSteps)
  })
  const wasOpen = useRef(false)

  const [stepGuidance, setStepGuidance] = useState<Record<string, string>>({})
  const [showGuidance, setShowGuidance] = useState(false)
  const [synopsisFrom, setSynopsisFrom] = useState('')
  const [synopsisTo, setSynopsisTo] = useState('')
  const [targetUnits, setTargetUnits] = useState(String(DEFAULT_PLANNING_TARGET_UNITS))
  const [preferenceLoading, setPreferenceLoading] = useState(true)
  const [isConfirming, setIsConfirming] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let disposed = false
    void ipc.invoke('config:get').then(config => {
      if (!disposed) setTargetUnits(String(parsePlanningTargetUnits(config.outlineTargetUnits)))
    }).catch(error => {
      if (!disposed) setGuardError(displayedErrorMessage(useLocaleStore.getState().locale, error))
    }).finally(() => { if (!disposed) setPreferenceLoading(false) })
    return () => { disposed = true; setPreferenceLoading(true) }
  }, [isOpen])

  // 每次弹窗打开时重置选中状态；续批入口只勾情节大纲并预填起止章：同批再生成别的节会改变大纲的源事实，续批会被后台拒绝。
  // 其余入口的大纲范围默认接着已有大纲往后写，接不上时从第 1 章起
  const resetChecked = useCallback(() => {
    const defaults = initialSynopsisRange
      ? { premise: false, characters: false, worldbuilding: false, synopsis: true }
      : createDefaultArchitectureSelection(confirmed, initialSelectedSteps)
    if (initialSynopsisRange) {
      setSynopsisFrom(String(initialSynopsisRange.from))
      setSynopsisTo(String(Math.min(initialSynopsisRange.to, initialSynopsisRange.from + PLANNING_ACTION_CHAPTER_LIMIT - 1)))
    } else {
      const total = Number(currentProject?.novelConfig.totalChapters) || 0
      const next = plotOutlineNextChapter(synopsisSource)
      setSynopsisFrom(String(next))
      setSynopsisTo(String(Math.min(total, next + DEFAULT_PLANNING_ACTION_CHAPTERS - 1)))
    }
    setChecked(defaults)
  }, [confirmed, currentProject?.novelConfig.totalChapters, initialSelectedSteps, initialSynopsisRange, synopsisSource])

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      resetChecked()
    }
    wasOpen.current = isOpen
  }, [isOpen, resetChecked])

  const toggleStep = (key: ArchStepKey) =>
    setChecked(prev => ({ ...prev, [key]: !prev[key] }))
  const setAll = (value: boolean) => setChecked({ premise: value, characters: value, worldbuilding: value, synopsis: value })

  const selectedSteps = (Object.keys(checked) as ArchStepKey[]).filter(k => checked[k])
  const noneSelected = selectedSteps.length === 0
  const config = currentProject?.novelConfig
  const totalChapters = Number(config?.totalChapters) > 0 ? Number(config?.totalChapters) : 0
  const from = Number(synopsisFrom)
  const to = Number(synopsisTo)

  const rangeFilled = Boolean(checked.synopsis && synopsisFrom.trim() && synopsisTo.trim()
    && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from)
  // 超过单批上限或全书章数的范围，主进程开跑前就会拒绝，对话框里直接判无效。
  const outOfBounds = rangeFilled && (to - from + 1 > PLANNING_ACTION_CHAPTER_LIMIT || (totalChapters > 0 && to > totalChapters))
  const boundsIssue = text(
    `情节大纲范围无效。请选择第 1–${totalChapters} 章内连续的 1–${PLANNING_ACTION_CHAPTER_LIMIT} 章。`,
    `Invalid plot-outline range. Select 1-${PLANNING_ACTION_CHAPTER_LIMIT} consecutive chapters within chapters 1-${totalChapters}.`,
  )

  /** 这一批交给主进程会怎样；范围本身不完整或越界时为 null，由提交时的范围校验报错。 */
  const synopsisEffect: PlotOutlineRangeEffect | null = rangeFilled && !outOfBounds
    ? plotOutlineRangeEffect(synopsisSource, { from, to })
    : null

  /** 选定范围为什么会被主进程拒绝；能开跑时为 null。 */
  const synopsisRangeIssueText = (): string | null => {
    if (outOfBounds) return boundsIssue
    if (synopsisEffect?.kind !== 'invalid') return null
    if (!synopsisSource.synopsis.trim()) return text('还没有情节大纲，请从第 1 章起生成。', 'There is no plot outline yet. Start from chapter 1.')
    if (!synopsisEffect.hasEntries) return text('已有大纲没有按章的标题，只能从第 1 章起整份重写。', 'The existing outline has no chapter headings, so it can only be rewritten whole from chapter 1.')
    const { orderIssue, lastChapter } = synopsisEffect
    if (!orderIssue && lastChapter < 1) return text(`已有大纲只有序章，不能跳到第 ${from} 章开始。请从第 1 章起生成，序章会原样保留。`,
      `The outline only has a prologue, so it cannot skip to chapter ${from}. Start from chapter 1; the prologue stays as it is.`)
    if (orderIssue?.kind === 'duplicate') return text(`已有大纲里第 ${orderIssue.chapter} 章出现了不止一次，按范围重写会打乱或丢掉其他章，后台会拒绝。请先删掉或改正重复的那一章。`,
      `Chapter ${orderIssue.chapter} appears more than once in the existing outline, so rewriting a range would scramble or drop other chapters and would be rejected. Remove or correct the duplicate first.`)
    if (orderIssue) return text('已有大纲的章节没有按章号顺序排列，按范围重写会打乱或丢掉其他章，后台会拒绝。请先把大纲里的章节按章号排好。', 'The chapters in the existing outline are out of order, so rewriting a range would scramble or drop other chapters and would be rejected. Put the outline chapters in order first.')
    if (from > lastChapter + 1) return text(`已有大纲写到第 ${lastChapter} 章，不能跳到第 ${from} 章开始。请从第 ${lastChapter + 1} 章续写，或从第 1–${lastChapter} 章中的某一章起重写。`,
      `The outline reaches chapter ${lastChapter}, so it cannot skip to chapter ${from}. Continue from chapter ${lastChapter + 1}, or rewrite from a chapter between 1 and ${lastChapter}.`)
    return text('这个范围会切开已有的章节条目，或已有大纲末尾的分批说明与正文对不上，后台会拒绝。请换一个起止章。', 'This range splits an existing chapter entry, or the batch note at the end of the outline does not match its text, so it would be rejected. Choose other chapters.')
  }
  const synopsisRangeIssue = synopsisRangeIssueText()

  /** 选定范围的说明：覆盖哪几章、哪几章原样保留；续写接在哪一章之后。 */
  const synopsisEffectNote = (): string | null => {
    if (!synopsisEffect) return null
    if (synopsisEffect.kind === 'continue' && synopsisEffect.after === 0) return text(`接在序章之后写第 ${from}–${to} 章，序章不动。`, `Chapters ${from}–${to} follow the prologue; the prologue stays as it is.`)
    if (synopsisEffect.kind === 'continue') return text(`接在第 ${synopsisEffect.after} 章之后写第 ${from}–${to} 章，已有章节不动。`, `Chapters ${from}–${to} follow chapter ${synopsisEffect.after}; existing chapters stay as they are.`)
    if (synopsisEffect.kind !== 'overwrite') return null
    if (synopsisEffect.whole) return text('已有大纲没有按章的标题，整份按本次结果替换。', 'The existing outline has no chapter headings, so it is replaced whole.')
    const chapters = [
      ...(synopsisEffect.from > 1 ? [`1–${synopsisEffect.from - 1}`] : []),
      ...(synopsisEffect.lastChapter > synopsisEffect.to ? [`${synopsisEffect.to + 1}–${synopsisEffect.lastChapter}`] : []),
    ]
    const replaced = text(`第 ${synopsisEffect.from}–${synopsisEffect.to} 章按本次结果替换`, `Chapters ${synopsisEffect.from}–${synopsisEffect.to} are replaced`)
    const keptChapters = chapters.length ? text(`第 ${chapters.join('、')} 章`, `chapters ${chapters.join(', ')}`) : ''
    if (synopsisEffect.prologue) {
      return keptChapters
        ? text(`${replaced}，序章与${keptChapters}原样保留。`, `${replaced}; the prologue and ${keptChapters} stay as they are.`)
        : text(`${replaced}，序章原样保留。`, `${replaced}; the prologue stays as it is.`)
    }
    return keptChapters
      ? text(`${replaced}，${keptChapters}原样保留。`, `${replaced}; ${keptChapters} stay as they are.`)
      : text(`${replaced}。`, `${replaced}.`)
  }

  const stepMark = (key: ArchStepKey): ArchStepMark => {
    if (!checked[key]) return archStatus[key] ? 'keep' : 'new'
    if (key !== 'synopsis') return archStatus[key] ? 'overwrite' : 'new'
    if (!synopsisEffect) return outOfBounds ? 'invalid' : archStatus.synopsis ? 'overwrite' : 'new'
    return synopsisEffect.kind
  }

  /** 标记文字；情节大纲覆盖的是部分章节时写明是哪几章。 */
  const markLabel = (key: ArchStepKey): string => {
    const mark = stepMark(key)
    if (key === 'synopsis' && mark === 'overwrite' && synopsisEffect?.kind === 'overwrite' && !synopsisEffect.whole) {
      return text(`将覆盖第 ${synopsisEffect.from}–${synopsisEffect.to} 章`, `Overwrite ch. ${synopsisEffect.from}–${synopsisEffect.to}`)
    }
    return text(...MARK_TEXT[mark])
  }

  /** 状态文字：已确认；有内容但未确认（大纲没写完或被打断、名单待修复）为不完整，与架构页徽标同一叫法；没有内容或大纲只有序章为待生成。 */
  const statusLabel = (key: ArchStepKey): string => {
    if (confirmed[key]) return text('已确认', 'Confirmed')
    const prologueOnly = key === 'synopsis' && plotOutlineLastChapter(synopsisSource.synopsis) === 0
    return archStatus[key] && !prologueOnly ? text('不完整', 'Incomplete') : text('待生成', 'Not started')
  }

  const resolveSynopsisRange = (): { ok: true; range?: { from: number; to: number } } | { ok: false; message?: string } => {
    if (!checked.synopsis) return { ok: true }
    if (synopsisRangeIssue) return { ok: false, message: synopsisRangeIssue }
    const range = { from, to }
    try { assertPlanningActionRange(range) } catch { return { ok: false } }
    return range.to <= totalChapters ? { ok: true, range } : { ok: false }
  }

  const handleConfirm = async () => {
    if (noneSelected) return
    setIsConfirming(true)
    try {
      // 前置校验 1：小说配置是否填写
      const configGuard = guardArchitectureGeneration()
      if (!configGuard.ok) {
        setGuardError(displayedErrorMessage(locale, configGuard.message, text('配置校验失败', 'Configuration validation failed.')))
        return
      }

      // 范围合法性（超出总章数或起大于止）
      const resolution = resolveSynopsisRange()
      if (!resolution.ok) {
        setGuardError(displayedErrorMessage(locale, resolution.message, boundsIssue))
        return
      }

      // 前置校验 2：如果勾选了角色名单（意味着将重新生成角色卡），则必须确保蓝图为空
      if (selectedSteps.includes('characters') && archStatus.characters) {
        const charGuard = await guardCharacterRegeneration()
        if (!charGuard.ok) {
          setGuardError(displayedErrorMessage(useLocaleStore.getState().locale, charGuard.message, text('角色卡不可重新生成', 'Character cards cannot be regenerated.')))
          return
        }
      }

      setGuardError(null)
      let target: number | undefined
      if (checked.synopsis) {
        try { target = parsePlanningTargetUnits(Number(targetUnits)) } catch {
          setGuardError(text(`每章大纲目标须为 1–${PLANNING_TARGET_UNITS_LIMIT} 的整数。`, `The outline target must be an integer from 1 to ${PLANNING_TARGET_UNITS_LIMIT}.`))
          return
        }
        try {
          const saved = await ipc.invoke('config:set', { outlineTargetUnits: target })
          if (!saved.success) throw new Error(saved.error)
        } catch {
          setGuardError(text('目标字数偏好保存失败。请重试，输入已保留。', 'Could not save the target preference. Your input is retained. Please retry.'))
          return
        }
      }
      await onConfirm(selectedSteps, stepGuidance, resolution.range, target)
      onClose()
      const stepNames = selectedSteps.map(k => text(...ARCH_STEP_NAMES[k])).join(text('、', ', '))
      toast.info(text(`已提交：正在生成${stepNames}...`, `Submitted: generating ${stepNames}...`))
    } catch (error) {
      setGuardError(displayedErrorMessage(useLocaleStore.getState().locale, error))
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

  return {
    config,
    checked,
    toggleStep,
    setAll,
    selectedSteps,
    noneSelected,
    stepMark,
    markLabel,
    statusLabel,
    synopsisRangeIssue,
    synopsisEffectNote: synopsisEffectNote(),
    stepGuidance,
    setStepGuidance: (key: ArchStepKey, value: string) => setStepGuidance(prev => ({ ...prev, [key]: value })),
    showGuidance,
    setShowGuidance,
    synopsisFrom,
    setSynopsisFrom,
    synopsisTo,
    setSynopsisTo,
    targetUnits,
    setTargetUnits,
    preferenceLoading,
    isConfirming,
    guardError,
    totalChapters,
    handleConfirm,
    handleOpenChange,
  }
}
