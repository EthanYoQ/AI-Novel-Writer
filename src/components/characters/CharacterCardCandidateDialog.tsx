/**
 * CharacterCardCandidateDialog — AI 提取出的角色卡候选预览与入库。
 *
 * 先预览再入库：提取出来的角色卡**不直接写名单**，作者逐条过目、勾选后才落盘，
 * 未勾选的直接丢弃。
 *
 * 为什么这一层不可省（而不是「工作流跑完自动导入」）：
 * AI 从资料里读出的角色事实可能有误读、串行或过度推断，直接合并进名单等于让模型
 * 替作者决定作品设定。每行给出姓名、角色定位与全部非空事实字段，作者据此一眼就能
 * 否掉不想要的那几条。
 *
 * 健壮性约定：
 *   · 默认全选（作者多半全要，反勾比全勾快），每次打开都重建勾选集合；
 *   · 提交中整体禁用，杜绝重复写入；
 *   · 提交失败的原因**就地显示**并保留候选，作者改完外部条件可以原地重试 ——
 *     绝不吞掉错误、绝不把候选悄悄丢掉。
 */
import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import { useLocaleStore } from '../../stores/locale-store'
import { CHARACTER_ROLE_LABELS } from '../../shared/character-role'
import { characterRosterIdentityKey, type CharacterRosterEntry } from '../../shared/character-roster'
import CharacterCardMergeDialog from './CharacterCardMergeDialog'

interface Props {
  open: boolean
  candidates: CharacterRosterEntry[]
  /** 当前项目已有角色卡：用于识别同名，并作为合并窗口的左栏。 */
  existingEntries: CharacterRosterEntry[]
  /** 提交中：整个面板禁用，防止重复写入。 */
  busy: boolean
  /** 提交失败的可读原因；就地展示。 */
  error: string
  onClose: () => void
  onConfirm: (selected: CharacterRosterEntry[], overwriteExisting: boolean) => void
}

/**
 * 同名候选的处理方式：保留原卡（默认，最安全）/ 直接覆盖 / 逐项合并。
 * 作者没做选择时按「保留原卡」处理 —— 与旧行为一致，不会悄悄改掉既有设定。
 */
type SameNameResolution =
  | { mode: 'keep' }
  | { mode: 'overwrite' }
  | { mode: 'merged'; merged: CharacterRosterEntry }

/** 展示顺序与提取合同（MATERIAL_CHARACTER_TEXT_FIELDS）一致。 */
const FACT_FIELDS = [
  ['gender', '性别', 'Gender'],
  ['age', '年龄', 'Age'],
  ['appearance', '外貌', 'Appearance'],
  ['personality', '性格', 'Personality'],
  ['background', '背景', 'Background'],
  ['abilities', '能力', 'Abilities'],
  ['motivation', '动机', 'Motivation'],
  ['arc', '角色弧光', 'Arc'],
  ['notes', '其他事实', 'Other facts'],
] as const

export default function CharacterCardCandidateDialog({
  open,
  candidates,
  existingEntries,
  busy,
  error,
  onClose,
  onConfirm,
}: Props) {
  const { locale, text } = useLocaleStore()
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [resolutions, setResolutions] = useState<Record<number, SameNameResolution>>({})
  const [mergingIndex, setMergingIndex] = useState<number | null>(null)

  // 每次打开重建默认全选集合。勾选是作者可随手改的交互状态，无法用派生表达式
  // 表达「打开那一刻的默认值」，因此必须在这里整份重建。
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 打开时重建默认全选集合（用户之后可任意反勾） */
    if (open) {
      setChecked(new Set(candidates.map((_, index) => index)))
      setResolutions({})
      setMergingIndex(null)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, candidates])

  const toggle = (index: number) => {
    setChecked(previous => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const existingByName = useMemo(
    () => new Map(existingEntries.map(entry => [characterRosterIdentityKey(entry.name), entry])),
    [existingEntries],
  )

  /**
   * 提交预览：同名且选择「保留原卡」的条目**不提交** —— 它已经存在于名单里，
   * 不提交就是原样保留；其余按作者的选择写入。
   */
  const submission = useMemo(() => {
    const entries: CharacterRosterEntry[] = []
    let overwriteExisting = false
    candidates.forEach((candidate, index) => {
      if (!checked.has(index)) return
      const existing = existingByName.get(characterRosterIdentityKey(candidate.name))
      if (!existing) {
        entries.push(candidate)
        return
      }
      const resolution = resolutions[index]
      if (resolution?.mode === 'overwrite') {
        entries.push(candidate)
        overwriteExisting = true
      } else if (resolution?.mode === 'merged' && resolution.merged) {
        entries.push(resolution.merged)
        overwriteExisting = true
      }
    })
    return { entries, overwriteExisting }
  }, [candidates, checked, existingByName, resolutions])

  const selectedCount = submission.entries.length

  return (
    <>
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose() }}>
      <DialogContent
        className="max-w-[560px]"
        /* 先生：只认明确的关闭动作。候选是等了几分钟才生成出来的，作者还常常要
           切屏去补设定才能判断该不该选 —— 误点蒙版就让它消失，等于白等一场。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('待确认的角色卡', 'Character cards awaiting confirmation')}</DialogTitle>
          <PageHead
            kicker={text('CAST · 角色卡候选', 'CAST · CANDIDATES')}
            title={text('待确认的角色卡', 'Character cards awaiting confirmation')}
            description={text(
              '以下候选尚未写入角色名单。勾选后才会落盘；与现有角色同名的会标出「同名」，可逐条选择保留原卡、覆盖或逐项合并。未勾选的直接丢弃，粘贴与文件都还在。',
              'These candidates have not been saved yet. Only checked ones are written; cards sharing a name with an existing character are labelled and can be kept, overwritten or merged row by row. Unchecked ones are discarded, and your pasted text and files are kept.',
            )}
          />
        </DialogHeader>

        {error && (
          <p
            role="alert"
            className="px-5 pt-3 text-xs"
            style={{ color: 'var(--color-error-text)' }}
          >
            {text('未能写入：', 'Could not save: ')}{error}
          </p>
        )}

        {candidates.length > 0 && candidates.every(candidate => (
          candidate.relationships.length === 0 && !candidate.relationshipNotes?.trim()
        )) && (
          <p className="cc-candidate-note px-5 pt-3">
            {text(
              '这批候选里没有出现任何角色关系。如果资料里确实写了关系，可以先导入角色卡，再到角色档案里补充；也可以把关系写进资料后重新提取一次。',
              'These candidates contain no relationships. If the material did describe relationships, import the cards and fill them in from the character profile later, or add the relationships to the material and extract again.',
            )}
          </p>
        )}

        <div className="flex flex-col gap-2 max-h-[52vh] overflow-y-auto px-5 py-4">
          {candidates.length === 0 && (
            <p className="py-6 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {text('这批候选已不在，请重新提取。', 'These candidates are no longer available. Run the extraction again.')}
            </p>
          )}
          {candidates.map((candidate, index) => {
            const roleLabels = CHARACTER_ROLE_LABELS[candidate.role]
            const existing = existingByName.get(characterRosterIdentityKey(candidate.name))
            const resolution = resolutions[index]?.mode ?? 'keep'
            const facts = FACT_FIELDS.flatMap(([field, zhCN, enUS]) => {
              const value = candidate[field]
              return typeof value === 'string' && value.trim()
                ? [{ key: field, label: text(zhCN, enUS), value }]
                : []
            })
            return (
              <label className="cc-candidate-row" key={`${candidate.name}-${index}`}>
                <input
                  type="checkbox"
                  checked={checked.has(index)}
                  disabled={busy}
                  onChange={() => toggle(index)}
                  aria-label={candidate.name}
                />
                <span className="cc-candidate-main">
                  <span className="cc-candidate-name">
                    {candidate.name}
                    <span className="cc-candidate-tag">
                      {locale === 'en-US' ? roleLabels.enUS : roleLabels.zhCN}
                    </span>
                    {existing && (
                      <span
                        className="cc-candidate-tag"
                        style={{ backgroundColor: 'var(--color-warning)', color: 'var(--color-bg)' }}
                      >
                        {text('同名', 'Same name')}
                      </span>
                    )}
                  </span>
                  {/* 同名角色必须先让作者看见：默认保留原卡，另可覆盖或逐项合并。 */}
                  {existing && (
                    <span className="cc-candidate-fact">
                      <b>{text('已有同名角色', 'A character with this name exists')}</b>
                      <span
                        className="flex items-center gap-1 pt-1"
                        onClick={event => { event.preventDefault(); event.stopPropagation() }}
                      >
                        {([
                          ['keep', text('保留原卡', 'Keep existing')],
                          ['overwrite', text('覆盖', 'Overwrite')],
                          ['merged', text('合并…', 'Merge…')],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            className={`btn ${resolution === mode ? 'primary' : 'ghost'} sm`}
                            disabled={busy}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              if (mode === 'merged') {
                                setMergingIndex(index)
                                return
                              }
                              setResolutions(previous => ({ ...previous, [index]: { mode } }))
                            }}
                          >
                            {mode === 'merged' && resolutions[index]?.mode === 'merged'
                              ? text('已合并', 'Merged')
                              : label}
                          </button>
                        ))}
                      </span>
                    </span>
                  )}
                  {facts.map(fact => (
                    <span className="cc-candidate-fact" key={fact.key}>
                      <b>{fact.label}</b>{fact.value}
                    </span>
                  ))}
                  {candidate.relationships.length > 0 && (
                    <span className="cc-candidate-fact">
                      <b>{text('关系', 'Relationships')}</b>
                      {candidate.relationships
                        .map(relationship => `${relationship.target}：${relationship.relation}`)
                        .join(text('；', '; '))}
                    </span>
                  )}
                  {candidate.relationshipNotes?.trim() && (
                    <span className="cc-candidate-fact">
                      <b>{text('关系备注', 'Relationship notes')}</b>
                      {candidate.relationshipNotes}
                    </span>
                  )}
                  {facts.length === 0
                    && candidate.relationships.length === 0
                    && !candidate.relationshipNotes?.trim() && (
                    <span className="cc-candidate-note">
                      {text('资料里只有这个角色的名字，没有更多明确事实。', 'The source only gave this name, with no further explicit facts.')}
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>

        <DialogFooter>
          <button className="btn ghost sm" type="button" onClick={onClose} disabled={busy}>
            {text('丢弃这批候选', 'Discard these candidates')}
          </button>
          <button
            className="btn primary sm"
            type="button"
            onClick={() => onConfirm(submission.entries, submission.overwriteExisting)}
            disabled={busy || selectedCount === 0}
          >
            <Check size={11} /> {busy
              ? text('写入中…', 'Saving…')
              : text(`写入所选的 ${selectedCount} 张角色卡`, `Add ${selectedCount} selected`)}
          </button>
        </DialogFooter>
        {selectedCount < checked.size && (
          <p className="px-5 pb-3 text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {text(
              `还有 ${checked.size - selectedCount} 张同名卡选择了「保留原卡」，本次不会写入。`,
              `${checked.size - selectedCount} checked card(s) are set to “keep existing” and will not be written.`,
            )}
          </p>
        )}
      </DialogContent>
    </Dialog>
    {mergingIndex !== null && (() => {
      const candidate = candidates[mergingIndex]
      const existing = candidate
        ? existingByName.get(characterRosterIdentityKey(candidate.name))
        : undefined
      if (!candidate || !existing) return null
      return (
        <CharacterCardMergeDialog
          open
          existing={existing}
          incoming={candidate}
          onCancel={() => setMergingIndex(null)}
          onConfirm={(merged) => {
            setResolutions(previous => ({ ...previous, [mergingIndex]: { mode: 'merged', merged } }))
            setChecked(previous => new Set(previous).add(mergingIndex))
            setMergingIndex(null)
          }}
        />
      )
    })()}
    </>
  )
}
