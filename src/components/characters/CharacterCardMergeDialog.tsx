/**
 * CharacterCardMergeDialog — 同名角色卡的逐项合并确认。
 *
 * 先生定的交互：**左＝原角色卡、中＝处理方式、右＝新角色卡**，从上到下一项
 * 一项确认，最后保存。
 *
 * 三条设计约定（都是先生实测提的）：
 *   · 只列出**有差异**的字段 —— 两侧一样的栏目没什么可确认的，堆在列表里只会
 *     让作者找不到真正要动的那几行；相同项默认收起，可一键展开查看。
 *   · 处理方式按钮沿用主题的按钮体系（未选中是描边、选中是主题实心），作者一眼
 *     看得出自己点在哪一项上。
 *   · 「追加」只给**可累积**的字段：性格 / 外貌 / 背景 / 能力 / 动机 / 弧光 /
 *     其他事实 / 关系 / 关系备注。定位、性别、年龄是单一事实，追加只会拼出
 *     「18；25」这种没有意义的结果，所以它们只有保留与采用两种选择。
 */
import { useMemo, useState } from 'react'

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import { Button } from '../ui/Button'
import { useLocaleStore } from '../../stores/locale-store'
import { CHARACTER_ROLE_LABELS, normalizeCharacterRole } from '../../shared/character-role'
import type { CharacterRosterEntry } from '../../shared/character-roster'
import { appendFieldText, appendRelationshipEdges } from '../../shared/character-card-merge'

type MergePick = 'existing' | 'incoming' | 'append'

/** 逐项确认的字段表：顺序与角色档案的展示顺序一致，末位标记能否追加。 */
const MERGE_FIELDS = [
  ['role', '定位', 'Role', false],
  ['gender', '性别', 'Gender', false],
  ['age', '年龄', 'Age', false],
  ['appearance', '外貌', 'Appearance', true],
  ['personality', '性格', 'Personality', true],
  ['background', '背景', 'Background', true],
  ['abilities', '能力', 'Abilities', true],
  ['motivation', '动机', 'Motivation', true],
  ['arc', '角色弧光', 'Arc', true],
  ['notes', '其他事实', 'Other facts', true],
] as const

type MergeField = typeof MERGE_FIELDS[number][0]

interface MergeRow {
  key: string
  label: string
  before: string
  after: string
  appendable: boolean
}

interface Props {
  open: boolean
  existing: CharacterRosterEntry
  incoming: CharacterRosterEntry
  onCancel: () => void
  /** 作者逐项确认后的最终条目（名字沿用原角色卡，章节状态保持不动）。 */
  onConfirm: (merged: CharacterRosterEntry) => void
}

function fieldText(entry: CharacterRosterEntry, field: MergeField): string {
  if (field === 'role') {
    return CHARACTER_ROLE_LABELS[normalizeCharacterRole(entry.role)].zhCN
  }
  const value = entry[field]
  return typeof value === 'string' ? value.trim() : ''
}

function relationshipText(entry: CharacterRosterEntry): string {
  return entry.relationships.map(edge => `${edge.target}：${edge.relation}`).join('；')
}

export default function CharacterCardMergeDialog({
  open,
  existing,
  incoming,
  onCancel,
  onConfirm,
}: Props) {
  const { text } = useLocaleStore()
  const [picks, setPicks] = useState<Record<string, MergePick>>({})
  const [showUnchanged, setShowUnchanged] = useState(false)

  const rows = useMemo<MergeRow[]>(() => {
    const base: MergeRow[] = MERGE_FIELDS.flatMap(([field, zhCN, enUS, appendable]) => {
      const before = fieldText(existing, field)
      const after = fieldText(incoming, field)
      return before || after
        ? [{ key: field as string, label: text(zhCN, enUS), before, after, appendable }]
        : []
    })
    const beforeRelationships = relationshipText(existing)
    const afterRelationships = relationshipText(incoming)
    if (beforeRelationships || afterRelationships) {
      base.push({
        key: 'relationships',
        label: text('关系', 'Relationships'),
        before: beforeRelationships,
        after: afterRelationships,
        appendable: true,
      })
    }
    const beforeNotes = existing.relationshipNotes?.trim() ?? ''
    const afterNotes = incoming.relationshipNotes?.trim() ?? ''
    if (beforeNotes || afterNotes) {
      base.push({
        key: 'relationshipNotes',
        label: text('关系备注', 'Relationship notes'),
        before: beforeNotes,
        after: afterNotes,
        appendable: true,
      })
    }
    return base
  }, [existing, incoming, text])

  const changedRows = useMemo(() => rows.filter(row => row.before !== row.after), [rows])
  const unchangedRows = useMemo(() => rows.filter(row => row.before === row.after), [rows])
  const visibleRows = showUnchanged ? rows : changedRows

  // 默认：原值优先，原值为空才采用新值 —— 不改动是安全的默认。
  const pickFor = (key: string, before: string): MergePick => (
    picks[key] ?? (before ? 'existing' : 'incoming')
  )

  const applyAll = (pick: MergePick) => {
    setPicks(Object.fromEntries(changedRows.map(row => [row.key, pick])))
  }

  const handleConfirm = () => {
    const merged: CharacterRosterEntry = { ...existing, name: existing.name }
    for (const [field] of MERGE_FIELDS) {
      const before = fieldText(existing, field)
      const after = fieldText(incoming, field)
      if (!before && !after) continue
      const pick = pickFor(field, before)
      if (pick === 'append') Object.assign(merged, { [field]: appendFieldText(before, after) })
      else if (pick === 'incoming') Object.assign(merged, { [field]: incoming[field] })
      else Object.assign(merged, { [field]: existing[field] })
    }
    const beforeRelationships = relationshipText(existing)
    const afterRelationships = relationshipText(incoming)
    if (beforeRelationships || afterRelationships) {
      const pick = pickFor('relationships', beforeRelationships)
      merged.relationships = pick === 'append'
        ? appendRelationshipEdges(existing.relationships, incoming.relationships)
        : pick === 'incoming'
          ? incoming.relationships
          : existing.relationships
    }
    const beforeNotes = existing.relationshipNotes?.trim() ?? ''
    const afterNotes = incoming.relationshipNotes?.trim() ?? ''
    if (beforeNotes || afterNotes) {
      const pick = pickFor('relationshipNotes', beforeNotes)
      const notes = pick === 'append'
        ? appendFieldText(beforeNotes, afterNotes)
        : pick === 'incoming'
          ? afterNotes
          : beforeNotes
      if (notes) merged.relationshipNotes = notes
      else delete merged.relationshipNotes
    }
    onConfirm(merged)
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel() }}>
      <DialogContent className="max-w-[780px]" onPointerDownOutside={(event) => event.preventDefault()}>
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('合并角色卡', 'Merge character cards')}</DialogTitle>
          <PageHead
            kicker={text('CAST · 合并角色卡', 'CAST · MERGE')}
            title={text(`合并「${existing.name}」`, `Merge “${existing.name}”`)}
            description={text(
              '左侧是原有角色卡，右侧是本次导入的新卡。只列出两侧不同的栏目，逐行选择保留、采用还是追加。',
              'The original card is on the left, the incoming card on the right. Only differing fields are listed; choose keep, use or append per row.',
            )}
          />
        </DialogHeader>

        <div className="px-5 pt-3 flex items-center justify-between gap-2 text-xs">
          <span style={{ color: 'var(--color-text-muted)' }}>
            {text(
              `${changedRows.length} 项有差异${unchangedRows.length > 0 ? ` · ${unchangedRows.length} 项两侧相同` : ''}`,
              `${changedRows.length} changed${unchangedRows.length > 0 ? ` · ${unchangedRows.length} identical` : ''}`,
            )}
          </span>
          <span className="flex items-center gap-2">
            {unchangedRows.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setShowUnchanged(previous => !previous)}>
                {showUnchanged
                  ? text('收起相同项', 'Hide identical')
                  : text(`显示相同项（${unchangedRows.length}）`, `Show identical (${unchangedRows.length})`)}
              </Button>
            )}
            {changedRows.length > 0 && (
              <>
                <Button variant="ghost" size="sm" onClick={() => applyAll('existing')}>
                  {text('全部保留原值', 'Keep all original')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => applyAll('incoming')}>
                  {text('全部采用新值', 'Use all incoming')}
                </Button>
              </>
            )}
          </span>
        </div>

        <div className="px-5 py-3" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {visibleRows.length === 0 ? (
            <p className="py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text(
                '两张卡没有差异，保存后原卡保持不变。',
                'Nothing differs; saving keeps the original card unchanged.',
              )}
            </p>
          ) : (
            <>
              <div
                className="grid text-[0.7rem] pb-2"
                style={{
                  gridTemplateColumns: '1fr 132px 1fr',
                  gap: '6px 12px',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <span className="px-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {text('原角色卡', 'Original')}
                </span>
                <span className="text-center" style={{ color: 'var(--color-text-muted)' }}>
                  {text('处理方式', 'Choice')}
                </span>
                {/* 新导入的一侧用主题色标出：合到一半时靠颜色就能分清左右。 */}
                <span className="px-2 font-medium" style={{ color: 'var(--color-accent)' }}>
                  {text('新角色卡（本次导入）', 'Incoming (this import)')}
                </span>
              </div>
              {visibleRows.map((row) => {
                const changed = row.before !== row.after
                const pick = pickFor(row.key, row.before)
                const selectedStyle = (active: boolean) => (active
                  ? { borderColor: 'var(--color-accent)' }
                  : undefined)
                return (
                  <div
                    key={row.key}
                    className="grid items-start py-2"
                    style={{
                      gridTemplateColumns: '1fr 132px 1fr',
                      gap: '6px 12px',
                      borderBottom: '1px solid var(--color-border)',
                    }}
                  >
                    <div
                      className="text-xs min-w-0 rounded-md px-2 py-2"
                      style={{ border: '1px solid var(--color-border)' }}
                    >
                      <div style={{ color: 'var(--color-text-muted)' }}>{row.label}</div>
                      <div
                        className="break-words whitespace-pre-wrap"
                        style={{ color: !changed || pick === 'existing' ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                      >
                        {row.before || text('（空）', '(empty)')}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1 pt-3">
                      {!changed ? (
                        <span className="text-center text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                          {text('两侧相同', 'Identical')}
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`btn ${pick === 'existing' ? 'primary' : 'outline'} sm`}
                            style={selectedStyle(pick === 'existing')}
                            onClick={() => setPicks(previous => ({ ...previous, [row.key]: 'existing' }))}
                          >
                            {text('保留原值', 'Keep original')}
                          </button>
                          <button
                            type="button"
                            className={`btn ${pick === 'incoming' ? 'primary' : 'outline'} sm`}
                            style={selectedStyle(pick === 'incoming')}
                            onClick={() => setPicks(previous => ({ ...previous, [row.key]: 'incoming' }))}
                          >
                            {text('采用新值', 'Use incoming')}
                          </button>
                          {row.appendable && (
                            <button
                              type="button"
                              className={`btn ${pick === 'append' ? 'primary' : 'outline'} sm`}
                              style={selectedStyle(pick === 'append')}
                              title={text('把新内容接在原内容后面', 'Append the incoming text after the original')}
                              onClick={() => setPicks(previous => ({ ...previous, [row.key]: 'append' }))}
                            >
                              {text('追加', 'Append')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    <div
                      className="text-xs min-w-0 rounded-md px-2 py-2"
                      style={{
                        // 新导入的一侧套主题红描边：往下合十几项也不会认错左右。
                        border: '1px solid var(--color-accent)',
                        backgroundColor: 'color-mix(in srgb, var(--color-accent) 5%, transparent)',
                      }}
                    >
                      <div style={{ color: 'var(--color-text-muted)' }}>{row.label}</div>
                      <div
                        className="break-words whitespace-pre-wrap"
                        style={{ color: !changed || pick === 'incoming' ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                      >
                        {row.after || text('（空）', '(empty)')}
                      </div>
                      {changed && pick === 'append' && (
                        <div className="pt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                          {text('保存后＝原内容 + 换行 + 新内容', 'Saved as original + new line + incoming')}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{text('取消', 'Cancel')}</Button>
          <Button onClick={handleConfirm}>{text('保存合并结果', 'Save merged card')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
