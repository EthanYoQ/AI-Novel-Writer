import { useLocaleStore } from '../../../stores/locale-store'
import { BookOpen, FolderOpen, Plus } from 'lucide-react'
import type { ReactNode } from 'react'

export interface WriterOverview {
  state: 'loading' | 'empty' | 'unavailable' | 'ready'
  name?: string
  totalWords?: number | null
  finalizedChapters?: number | null
  characters?: number | null
  excerpt?: string
  stages?: readonly { id: string; label: string; status: 'unknown' | 'not-started' | 'in-progress' | 'completed'; count?: number | null }[]
}
export interface WelcomePageV2Props {
  overview: WriterOverview
  recentProjects: readonly { id: string; name: string; onPreview: () => void; onOpen: () => void }[]
  onNewProject: () => void
  onOpenProject: () => void
  onImportNovel: () => void
  onContinue?: () => void
  backup: ReactNode
  updates?: ReactNode
}

const count = (value: number | null | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : null

/** The caller supplies authorized, current facts. No cache, IO, model or persistence lives here. */
export default function WelcomePageV2({ overview, recentProjects, onNewProject, onOpenProject, onImportNovel, onContinue, backup, updates }: WelcomePageV2Props) {
  const text = useLocaleStore(state => state.text)
  const stageLabels = { unknown: text('待读取', 'Unknown'), 'not-started': text('未开始', 'Not started'), 'in-progress': text('进行中', 'In progress'), completed: text('已完成', 'Completed') }
  const displayCount = (value: number | null | undefined) => count(value) ?? text('待读取', 'Unknown')
  return <div className="writer-welcome">
    <header className="writer-welcome-heading"><BookOpen size={30} strokeWidth={1.4} /><p>{text('写作书房', 'Writing room')}</p><h1>{overview.name || text('写下你的下一段故事', 'Write the next part of your story')}</h1></header>
    <div className="writer-welcome-actions">
      <button type="button" onClick={onNewProject}><Plus size={17} />{text('新建作品', 'New project')}</button>
      <button type="button" onClick={onOpenProject}><FolderOpen size={17} />{text('打开作品', 'Open project')}</button>
      <button type="button" onClick={onImportNovel}>{text('小说拆解', 'Novel deconstruction')}</button>
    </div>
    <section className="writer-overview" aria-label={text('作品概览', 'Project overview')} aria-busy={overview.state === 'loading'}>
      {overview.state !== 'ready' ? <p role="status">{{ loading: text('正在读取作品信息…', 'Loading project information…'), empty: text('尚未打开作品，选择一本书或开始新的故事。', 'Choose a book or start a new story.'), unavailable: text('暂时无法读取这部作品，请正式打开后查看。', 'Preview is unavailable. Open the project to view it.') }[overview.state]}</p> : <>
        <dl className="writer-statistics"><div><dt>{text('正文字数', 'Manuscript words')}</dt><dd>{displayCount(overview.totalWords)}</dd></div><div><dt>{text('已定稿章节', 'Finalized chapters')}</dt><dd>{displayCount(overview.finalizedChapters)}</dd></div><div><dt>{text('人物', 'Characters')}</dt><dd>{displayCount(overview.characters)}</dd></div></dl>
        {overview.excerpt && <blockquote>{overview.excerpt}</blockquote>}
        {overview.stages && <ol className="writer-stage-list">{overview.stages.map(stage => <li key={stage.id}><strong>{stage.label}</strong><span>{stageLabels[stage.status]}</span>{stage.count != null && <small>{displayCount(stage.count)}</small>}</li>)}</ol>}
        {onContinue && <button type="button" onClick={onContinue}>{text('继续写作', 'Continue writing')}</button>}
      </>}
    </section>
    <section aria-label={text('最近作品', 'Recent projects')} className="writer-shelf"><h2>{text('书架', 'Shelf')}</h2>{recentProjects.length === 0 ? <p>{text('书架还空着，新故事值得期待。', 'Your shelf is empty. Start a new story.')}</p> : <ul>{recentProjects.map(project => <li key={project.id}><button type="button" onClick={project.onPreview} aria-label={text(`预览《${project.name}》`, `Preview ${project.name}`)}><BookOpen size={21} /><strong>{project.name}</strong></button><button type="button" onClick={project.onOpen} aria-label={text(`打开《${project.name}》`, `Open ${project.name}`)}>{text('进入作品', 'Enter project')}</button></li>)}</ul>}</section>
    <section aria-label={text('项目存档', 'Project archives')}>{backup}</section>{updates}
  </div>
}
