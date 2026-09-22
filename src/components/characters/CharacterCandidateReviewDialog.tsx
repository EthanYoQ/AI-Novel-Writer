/**
 * CharacterCandidateReviewDialog — 正文新角色的「待确认」队列。
 *
 * 先生 2026-09-21 定的形态：
 *   「定稿时把正文里出现、但名单里没有的重要具名角色存成 pending 候选，
 *     在角色页给个『待确认』入口，一键采纳即建档、忽略即丢弃。」
 *
 * 这些名字是**模型在定稿时提出来的**（`update_character_cards` 的 newCharacters
 * 一段，此前被解析器整段丢弃）。它们不是事实、也不进任何 AI 链路 —— 这里就是
 * 作者裁决的地方：采纳 = 真的建一张角色卡（走手工新建那条通道），忽略 = 从此
 * 不再提。两件都必须由人点，这是「新角色不许由正文后处理模型自由创建」的底线。
 *
 * 候选里除了名字，还带着模型在本章读到的**定位与当前状态**（提示词一直要求它随
 * `newCharacters` 返回）。采纳时它们会一并写进角色卡 —— 此前只传名字，建出来的
 * 新档除名字以外一片空白（先生报障）。下面把这块状态摆在「采纳并建档」旁边，
 * 作者点之前就能看见自己会得到什么。
 */
import { useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { getCharacterRoleLabels } from '../../shared/character-role'
import {
  CHARACTER_CANDIDATE_STATE_TEXT_FIELDS,
  hasCharacterCandidateState,
  type CharacterCandidateRecord,
  type CharacterCandidateStateField,
} from '../../shared/character-candidate'
import { useCharacterCandidateStore } from '../../stores/character-candidate-store'
import { useLocaleStore } from '../../stores/locale-store'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { Button } from '../ui/Button'
import PageHead from '../ui/PageHead'
import { toast } from '../ui/Toast'

interface CharacterCandidateReviewDialogProps {
  open: boolean
  onClose: () => void
  projectPath: string
  projectSession: ProjectSessionContext | null
}

/**
 * 状态字段的中文/英文标签 —— 与提示词里 `currentState` 的字段名逐项对应，不做任何改名，
 * 作者在角色档案里看到的也是这一套说法。
 */
const STATE_FIELD_LABELS: Record<CharacterCandidateStateField, readonly [string, string]> = {
  location: ['位置', 'Location'],
  powerLevel: ['境界', 'Power'],
  physicalState: ['身体', 'Physical'],
  mentalState: ['心理', 'Mental'],
  keyItems: ['持有', 'Items'],
  recentEvents: ['近事', 'Recent'],
}

export default function CharacterCandidateReviewDialog({
  open,
  onClose,
  projectPath,
  projectSession,
}: CharacterCandidateReviewDialogProps) {
  const text = useLocaleStore(s => s.text)
  const candidates = useCharacterCandidateStore(s => s.candidates)
  const adopt = useCharacterCandidateStore(s => s.adopt)
  const dismiss = useCharacterCandidateStore(s => s.dismiss)
  const [busyId, setBusyId] = useState<number | null>(null)

  const roleLabel = useMemo(() => (role: unknown) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }, [text])

  /**
   * 「采纳之后这张卡里会有什么」—— 把模型随提名一起交上来的当前状态陈列出来。
   *
   * 先生报障的正是「采纳建档之后新档只有名字」：那时这一块没有东西可显示，
   * 作者也分不清是候选压根没带状态、还是带了却没写进卡里。现在两件事都摆在明处。
   * 一个字段都没有时整块不渲染 —— 空盒子比没有更让人困惑。
   */
  const renderState = (candidate: CharacterCandidateRecord) => {
    if (!hasCharacterCandidateState(candidate.currentState)) return null
    const items = CHARACTER_CANDIDATE_STATE_TEXT_FIELDS.flatMap((field) => {
      const value = candidate.currentState[field]
      if (!value) return []
      const [zhCN, enUS] = STATE_FIELD_LABELS[field]
      return [{ field, label: text(zhCN, enUS), value }]
    })
    if (items.length === 0) return null
    return (
      <div
        className="mt-1.5 rounded px-2 py-1.5 space-y-0.5"
        style={{ backgroundColor: 'var(--color-hover)' }}
      >
        <div className="text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
          {text(
            `采纳后写进角色卡（第 ${candidate.currentState.updatedAtChapter} 章的状态）`,
            `Written into the card on accept (state at ch. ${candidate.currentState.updatedAtChapter})`,
          )}
        </div>
        {items.map(item => (
          <div key={item.field} className="text-[0.7rem] leading-relaxed flex gap-1.5">
            <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{item.label}</span>
            <span className="min-w-0" style={{ color: 'var(--color-text-secondary)' }}>{item.value}</span>
          </div>
        ))}
      </div>
    )
  }

  const handleAdopt = async (id: number) => {
    if (!projectSession || busyId !== null) return
    setBusyId(id)
    try {
      const ok = await adopt(id, projectPath, projectSession)
      if (ok) toast.success(text('已建档为角色卡', 'Added to the character roster'))
      else toast.error(text('建档失败，角色卡没有写入', 'Could not add this character to the roster'))
    } finally {
      setBusyId(null)
    }
  }

  const handleDismiss = async (id: number) => {
    if (!projectSession || busyId !== null) return
    setBusyId(id)
    try {
      const ok = await dismiss(id, projectPath, projectSession)
      if (!ok) toast.error(text('忽略失败，请重试', 'Could not dismiss this candidate'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogContent
        className="max-w-[620px]"
        // 同其它「装着可以找回来的东西」的弹窗：不靠点蒙版关闭，避免手一抖丢掉队列。
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('角色待确认', 'Characters pending review')}</DialogTitle>
          <PageHead
            kicker={text('CAST · 待确认', 'CAST · PENDING')}
            title={text('角色待确认', 'Characters pending review')}
            description={text(
              '定稿时在正文里发现、但角色名单里还没有的重要角色。采纳即建档，忽略即不再提。',
              'Important characters found in your finalized prose but missing from the roster. Accept to create them, dismiss to drop them.',
            )}
          />
        </DialogHeader>

        <div className="px-5 py-4 space-y-2 max-h-[52vh] overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="text-xs py-10 text-center" style={{ color: 'var(--color-text-muted)' }}>
              {text('队列是空的 —— 定稿时正文里冒出的新角色会出现在这里', 'Empty — new characters found at finalization land here.')}
            </div>
          ) : (
            candidates.map(candidate => (
              <div
                key={candidate.id}
                className="flex items-start gap-3 rounded-md px-3 py-2"
                style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                      {candidate.name}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {roleLabel(candidate.role)}
                      {' · '}
                      {text(`第${candidate.chapterNumber}章`, `Ch. ${candidate.chapterNumber}`)}
                    </span>
                  </div>
                  {candidate.evidence && (
                    <div
                      className="text-[11px] mt-1 leading-relaxed"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {candidate.evidence}
                    </div>
                  )}
                  {renderState(candidate)}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 pt-0.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => { void handleDismiss(candidate.id) }}
                    title={text('不再提这个名字', 'Never suggest this name again')}
                  >
                    <X size={12} />
                    {text('忽略', 'Dismiss')}
                  </Button>
                  <Button
                    variant="ai"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => { void handleAdopt(candidate.id) }}
                    title={text('按这个名字建一张角色卡', 'Create a character card with this name')}
                  >
                    <Check size={12} />
                    {text('采纳并建档', 'Accept')}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <DialogFooter className="sm:justify-between items-center">
          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            {text(
              '候选不会写进角色卡，也不会参与任何生成 —— 只有你点「采纳」才会建档。',
              'Candidates never touch the roster or generation — only your “Accept” creates a card.',
            )}
          </span>
          <Button variant="outline" onClick={onClose}>
            {text('关闭', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
