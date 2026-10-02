/**
 * WorldSettingCandidateDialog — AI 生成候选的预览与入库
 *
 * 先生定的规矩：**先预览再入库**。生成出来的东西不直接写库，
 * 作者逐条过目、勾选后才落盘；未勾选的直接丢弃。
 *
 * 每行给出三样判断依据：名称（含归属分类与重要度）、一句话摘要、以及
 * AI 自述的「为什么它与剧情强相关」——作者据此一眼就能否掉凑数的东西。
 */
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import { useLocaleStore } from '../../stores/locale-store'
import {
  getWorldSettingCategoryLabels,
  getWorldSettingImportanceLabels,
} from '../../shared/world-setting'
import type { WorldSettingCategoryRecord } from '../../shared/world-setting'
import type { WorldSettingCandidate } from '../../services/workflows/commands/generate-world-setting.command'

interface Props {
  open: boolean
  candidates: WorldSettingCandidate[]
  categories: WorldSettingCategoryRecord[]
  /**
   * 生成时作者所在的栏目。候选**默认写进这里**，而不是模型建议的分类 ——
   * 作者是在这一栏里主动点的「AI 生成」，他当然要它们落在这一栏。
   * （模型建议的分类仍然显示出来，作者想换随时可以换。）
   */
  defaultCategory: string
  busy: boolean
  onClose: () => void
  onConfirm: (selected: WorldSettingCandidate[]) => void
}

export default function WorldSettingCandidateDialog({
  open,
  candidates,
  categories,
  defaultCategory,
  busy,
  onClose,
  onConfirm,
}: Props) {
  const text = useLocaleStore(s => s.text)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  /** 作者逐条改过的归属分类；没有条目 = 用 defaultCategory。 */
  const [categoryByIndex, setCategoryByIndex] = useState<Record<number, string>>({})

  // 每次打开默认全选：作者多半是全要，想删的反勾更快。
  // checked 是用户可随手改的勾选集合，只能整份重建，无法用派生表达式表达
  // 「打开那一刻的默认值」；重置必须发生在渲染出候选列表之前，故留在 effect 里。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 对话框打开时重建默认全选集合（用户之后可任意反勾，属交互状态）
    if (open) setChecked(new Set(candidates.map((_, index) => index)))
    // 分类选择同样清回「默认 = 生成时所在栏目」。这一行不会触发 set-state-in-effect
    // （写进去的是常量对象，不是从渲染结果派生的新值），因此不需要 disable 指令。
    if (open) setCategoryByIndex({})
  }, [open, candidates])

  const toggle = (index: number) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const selectedCount = candidates.reduce((total, _, index) => total + (checked.has(index) ? 1 : 0), 0)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        className="max-w-[560px]"
        /* 先生：只认明确的关闭动作。候选是等了几分钟才生成出来的，作者还常常要
           切屏去查设定才能判断该不该选 —— 误点蒙版就让它消失，等于白等一场。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('AI 生成的设定候选', 'AI-generated candidates')}</DialogTitle>
          <PageHead
            kicker={text('WORLD · AI 候选', 'WORLD · AI CANDIDATES')}
            title={text('AI 生成的设定候选', 'AI-generated candidates')}
            description={text(
              '勾选的条目会写入设定库（来源标记为 AI），默认落进你当前所在的分类，需要的话可以逐行改；未勾选的直接丢弃。',
              'Checked entries are written to the library (marked as AI), into the category you are viewing by default — change it per row if you like. Unchecked ones are discarded.',
            )}
          />
        </DialogHeader>

        <div className="flex flex-col gap-2 max-h-[52vh] overflow-y-auto px-5 py-4">
          {candidates.map((candidate, index) => {
            const importanceLabels = getWorldSettingImportanceLabels(candidate.importance)
            const targetKey = categoryByIndex[index] ?? defaultCategory
            const suggestedLabels = getWorldSettingCategoryLabels(candidate.category, categories)
            return (
              <label className="ws-candidate-row" key={`${candidate.name}-${index}`}>
                <input
                  type="checkbox"
                  checked={checked.has(index)}
                  onChange={() => toggle(index)}
                  aria-label={candidate.name}
                />
                <span className="ws-candidate-main">
                  <span className="ws-candidate-name">
                    {candidate.name}
                    {/* 归属分类默认 = 生成时所在的栏目。改成下拉是为了保留模型的分栏建议
                        （显示在 title 上），但不让它替作者决定条目落在哪里。
                        preventDefault 必须留着：这一行外层是 label，不拦住的话
                        点一下下拉就会顺手把勾选状态也翻掉。 */}
                    <select
                      className="ws-candidate-category"
                      value={targetKey}
                      onClick={event => event.preventDefault()}
                      onChange={event => setCategoryByIndex(prev => ({ ...prev, [index]: event.target.value }))}
                      aria-label={text('归属分类', 'Category')}
                      title={candidate.category && candidate.category !== targetKey
                        ? text(`AI 建议归入「${suggestedLabels.zhCN}」`, `AI suggested “${suggestedLabels.enUS}”`)
                        : text('写入哪个分类', 'Which category to write into')}
                      style={{
                        marginLeft: 6,
                        fontSize: '0.66rem',
                        padding: '1px 3px',
                        borderRadius: 4,
                        border: '1px solid var(--color-border)',
                        background: 'var(--color-panel)',
                        color: 'var(--color-text-secondary)',
                        cursor: 'pointer',
                      }}
                    >
                      {categories.map(category => (
                        <option key={category.key} value={category.key}>
                          {text(category.zhCN, category.enUS)}
                        </option>
                      ))}
                    </select>
                    <span className="ws-candidate-tag ws-candidate-importance">
                      {text(importanceLabels.zhCN, importanceLabels.enUS)}
                    </span>
                  </span>
                  {candidate.summary && <span className="ws-candidate-summary">{candidate.summary}</span>}
                  {candidate.reason && (
                    <span className="ws-candidate-reason">
                      {text('与剧情的关系：', 'Story relevance: ')}{candidate.reason}
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>

        <DialogFooter>
          <button className="btn ghost sm" type="button" onClick={onClose} disabled={busy}>
            {text('取消', 'Cancel')}
          </button>
          <button
            className="btn primary sm"
            type="button"
            onClick={() => onConfirm(
              candidates
                .map((candidate, index) => ({ candidate, index }))
                .filter(({ index }) => checked.has(index))
                // 归属分类以作者在预览里选定的为准（默认就是生成时所在的栏目）。
                .map(({ candidate, index }) => ({
                  ...candidate,
                  category: categoryByIndex[index] ?? defaultCategory,
                })),
            )}
            disabled={busy || selectedCount === 0}
          >
            <Check size={11} /> {text(`写入所选的 ${selectedCount} 条`, `Add ${selectedCount} selected`)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
