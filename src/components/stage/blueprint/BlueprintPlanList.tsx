import { memo } from 'react'
import { NotebookPen, Sparkle } from 'lucide-react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import type { ChapterRow } from '../../../stores/navigation/stage-progress'
import { useLocaleStore } from '../../../stores/locale-store'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT } from '../stage-text'
import { pluralEn } from '../../../shared/plural-en'

interface BlueprintPlanListProps {
  blueprints: readonly ChapterBlueprint[]
  rows: ReadonlyMap<number, ChapterRow>
  selectedIdx: number
  nextWriteChapter: number | null
  onSelect: (index: number) => void
}

interface PlanItemProps {
  blueprint: ChapterBlueprint
  row: ChapterRow | undefined
  index: number
  selected: boolean
  next: boolean
  onSelect: (index: number) => void
}

/** 单独记忆每一行：换章或改一章时，几百章的列表只重画变了的那几行。 */
const PlanItem = memo(function PlanItem({ blueprint, row, index, selected, next, onSelect }: PlanItemProps) {
  const text = useLocaleStore(s => s.text)
  const status = row?.running ? 'running' : row?.phase ?? 'todo'
  return (
    <li>
      <button type="button" className="stage-bp-plan-item" aria-current={selected ? 'true' : undefined} onClick={() => onSelect(index)}>
        <span className="stage-bp-plan-no">{blueprint.chapterNumber}</span>
        <span className="stage-bp-plan-name">{blueprint.title || text('未命名', 'Untitled')}</span>
        <span className="stage-bp-plan-marks">
          {blueprint.userGuidance && <NotebookPen size={13} role="img" aria-label={text('有作者指导', 'Has author guidance')} />}
          {blueprint.notes && <Sparkle size={13} role="img" aria-label={text('有章节要点', 'Has chapter notes')} />}
        </span>
        <span className="stage-bp-plan-status" data-status={status} data-next={next || undefined}>
          {text(...(row?.running ? CHAPTER_RUNNING_TEXT : CHAPTER_PHASE_TEXT[row?.phase ?? 'todo']))}
        </span>
      </button>
    </li>
  )
})

/** 章节规划列表：章号、标题、有作者指导与要点的标记、正文进度。 */
export default function BlueprintPlanList({ blueprints, rows, selectedIdx, nextWriteChapter, onSelect }: BlueprintPlanListProps) {
  const text = useLocaleStore(s => s.text)
  return (
    <aside className="stage-bp-plan" aria-label={text('章节规划', 'Chapter plan')}>
      <div className="stage-bp-plan-top">{text(`${blueprints.length} 章`, `${blueprints.length} ${pluralEn(blueprints.length, 'chapter')}`)}</div>
      <ol className="stage-bp-plan-list">
        {blueprints.map((blueprint, index) => (
          <PlanItem
            key={blueprint.chapterNumber}
            blueprint={blueprint}
            row={rows.get(blueprint.chapterNumber)}
            index={index}
            selected={index === selectedIdx}
            next={blueprint.chapterNumber === nextWriteChapter}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </aside>
  )
}
