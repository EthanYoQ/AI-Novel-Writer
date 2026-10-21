import { useEffect, useRef, type ReactNode } from 'react'
import { Check, CircleDashed, GitBranch, History, Library, Settings, type LucideIcon } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import type { ResourcePage, WorkStage } from '../../stores/navigation/navigation-intents'
import { chapterLabel } from '../../shared/chapter-label'
import type { ChapterRow, StageLocation, StageProgress, StageStatus } from '../../stores/navigation/stage-progress'
import { ProgressRing } from './ProgressRing'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT, RESOURCE_NAMES, STAGE_NAMES } from './stage-text'
import { pluralEn } from '../../shared/plural-en'

type Text = (zh: string, en: string) => string

const RESOURCE_ICONS: Record<ResourcePage, LucideIcon> = { plot: GitBranch, knowledge: Library, history: History }

/** 未开始时说明这一步做什么，开始后给出进度。 */
function stageMeta(status: StageStatus, text: Text): string {
  const todo = status.progress.state === 'todo'
  switch (status.stage) {
    case 'setup':
      return status.missing.length === 0 ? text('完成', 'Done') : text(`还差 ${status.missing.length} 项`, `${status.missing.length} left`)
    case 'architecture':
      return todo ? text('前提、角色、世界观、大纲', 'Premise, cast, world, outline') : `${status.filled} / ${status.total}`
    case 'blueprint':
      if (todo) return text('逐章规划', 'Plan each chapter')
      return status.total > status.planned
        ? text(`${status.planned} / ${status.total} 章`, `${status.planned} / ${status.total} ${pluralEn(status.total, 'chapter')}`)
        : text(`${status.planned} 章`, `${status.planned} ${pluralEn(status.planned, 'chapter')}`)
    case 'manuscript':
      if (todo) return text('写作、审稿、修稿、定稿', 'Write, review, revise, finalize')
      return status.total > 0
        ? text(`${status.finalized} / ${status.total} 定稿`, `${status.finalized} / ${status.total} final`)
        : text(`${status.finalized} 章定稿`, `${status.finalized} final`)
  }
}

export function StageMark({ progress }: { progress: StageProgress }) {
  if (progress.state === 'done') return <span className="stage-mark stage-mark--done"><Check size={13} strokeWidth={2.6} aria-hidden="true" /></span>
  if (progress.state === 'todo') return <CircleDashed className="stage-mark stage-mark--todo" size={22} strokeWidth={1.4} aria-hidden="true" />
  return <ProgressRing className="stage-mark" size={22} stroke={2.5} ratio={progress.ratio} />
}

function ChapterStatus({ row, text }: { row: ChapterRow; text: Text }) {
  if (row.running) return <span className="stage-chapter-status" data-tone="accent">{text(...CHAPTER_RUNNING_TEXT)}</span>
  if (row.phase === 'final') return <span className="stage-chapter-dot" role="img" aria-label={text(...CHAPTER_PHASE_TEXT.final)} />
  if (row.phase === 'todo') return null
  return <span className="stage-chapter-status">{text(...CHAPTER_PHASE_TEXT[row.phase])}</span>
}

interface StageSpineProps {
  stages: readonly StageStatus[]
  chapters: readonly ChapterRow[]
  location: StageLocation | null
  onStage: (stage: WorkStage) => void
  onChapter: (chapterNumber: number) => void
  onResource: (page: ResourcePage) => void
  /** 设置页开着时只有「设置」是当前位置。 */
  settingsOpen?: boolean
  onSettings: () => void
}

export default function StageSpine({ stages, chapters, location: activeLocation, settingsOpen, onStage, onChapter, onResource, onSettings }: StageSpineProps) {
  const location = settingsOpen ? null : activeLocation
  const text = useLocaleStore(s => s.text)
  const currentStage = location?.kind === 'stage' ? location.stage : null
  const currentChapter = location?.kind === 'stage' ? location.chapter : undefined
  const currentRow = useRef<HTMLButtonElement>(null)
  const chapterListShown = currentStage === 'manuscript' && chapters.length > 0

  // 章节列表可能晚于当前章出现（打开作品时草稿索引后到），列表出现时也要把当前章滚进来
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: 'nearest' })
  }, [currentChapter, chapterListShown])

  const row = (key: string, current: boolean, onClick: () => void, children: ReactNode, attributes: Record<string, string> = {}) => (
    <li key={key}>
      <button type="button" className="stage-row" aria-current={current ? 'page' : undefined} onClick={onClick} {...attributes}>
        {children}
      </button>
    </li>
  )

  return (
    <nav className="stage-spine" aria-label={text('创作流程', 'Writing flow')}>
      <div className="stage-spine-label" aria-hidden="true">{text('创作流程', 'Writing flow')}</div>
      <ol className="stage-stages">
        {stages.map(status => row(status.stage, currentStage === status.stage, () => onStage(status.stage), <>
          <StageMark progress={status.progress} />
          <span className="stage-row-name">{text(...STAGE_NAMES[status.stage])}</span>
          <span className="stage-row-meta">{stageMeta(status, text)}</span>
        </>, { 'data-state': status.progress.state, 'data-stage': status.stage }))}
      </ol>

      {chapterListShown && (
        <ol className="stage-chapters" aria-label={text('章节', 'Chapters')}>
          {chapters.map(chapter => {
            const current = chapter.number === currentChapter
            return (
              <li key={chapter.number}>
                <button
                  ref={current ? currentRow : undefined}
                  type="button"
                  className="stage-chapter"
                  data-phase={chapter.phase}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onChapter(chapter.number)}
                >
                  <span className="stage-chapter-no">{chapter.number}</span>
                  <span className="stage-chapter-title">{chapter.title || chapterLabel(chapter.number, text)}</span>
                  <ChapterStatus row={chapter} text={text} />
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <div className="stage-spine-label stage-spine-label--resources" aria-hidden="true">{text('作品资料', 'Reference')}</div>
      <ul className="stage-resources" aria-label={text('作品资料', 'Reference')}>
        {(Object.keys(RESOURCE_NAMES) as ResourcePage[]).map(page => {
          const Icon = RESOURCE_ICONS[page]
          return row(page, location?.kind === 'resource' && location.page === page, () => onResource(page), <>
            <Icon className="stage-row-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="stage-row-label">{text(...RESOURCE_NAMES[page])}</span>
          </>, { 'data-resource': page })
        })}
      </ul>

      <div className="stage-spine-foot">
        <button type="button" className="stage-row" aria-current={settingsOpen ? 'page' : undefined} onClick={onSettings}>
          <Settings className="stage-row-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="stage-row-label">{text('设置', 'Settings')}</span>
        </button>
      </div>
    </nav>
  )
}
