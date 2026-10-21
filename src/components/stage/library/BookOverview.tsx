import type { CSSProperties, ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { StatGrid } from '../../ui/StatGrid'
import type { StageBar } from './shelf-progress'
import type { ShelfOverview } from './use-shelf-overview'

interface BookOverviewProps {
  mode: 'current' | 'preview'
  name: string
  meta: string
  overview: ShelfOverview
  bars: readonly StageBar[] | null
  primary: { label: string; onClick: () => void }
  secondary?: ReactNode
}

const count = (value: number, locale: string) => value.toLocaleString(locale)

function StageBars({ bars, label }: { bars: readonly StageBar[]; label: string }) {
  return (
    <ol className="stage-ov-bars" aria-label={label}>
      {bars.map(item => (
        <li key={item.stage} className="stage-ov-bar" data-state={item.state} data-stage={item.stage}>
          <span className="stage-ov-bar-track" aria-hidden="true">
            <span style={{ '--ratio': item.state === 'done' ? 1 : Math.max(item.state === 'active' ? 0.08 : 0, item.ratio) } as CSSProperties} />
          </span>
          <span className="stage-ov-bar-label">{item.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** 书房右侧的作品概览：阶段进度、统计、最近写下的段落与唯一的主操作。 */
export default function BookOverview({ mode, name, meta, overview, bars, primary, secondary }: BookOverviewProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const ready = overview.state === 'ready' ? overview : null
  return (
    <section className="stage-ov" aria-label={text(`《${name}》概览`, `“${name}” overview`)} aria-busy={overview.state === 'loading'}>
      <p className="stage-eyebrow">{mode === 'current' ? text('继续', 'Continue') : text('预览', 'Preview')}</p>
      <h2 className="stage-ov-title">{name}</h2>
      {meta && <p className="stage-ov-meta">{meta}</p>}
      {bars && <StageBars bars={bars} label={text('阶段进度', 'Stage progress')} />}
      {overview.state === 'loading' && <p className="stage-ov-status" role="status">{text('正在读取这部作品…', 'Reading this book…')}</p>}
      {overview.state === 'unavailable' && (
        <p className="stage-ov-status" role="status">{text('暂时读不到这部作品的概览，打开后就能看到。', 'This book cannot be previewed right now. Open it to see everything.')}</p>
      )}
      {ready && (
        <StatGrid
          label={text('统计', 'Statistics')}
          items={[
            { id: 'words', label: text('正文字数', 'Words'), value: count(ready.totalWords, locale) },
            { id: 'final', label: text('定稿章节', 'Final chapters'), value: count(ready.finalizedChapters, locale) },
            { id: 'characters', label: text('角色', 'Characters'), value: count(ready.characters, locale) },
          ]}
        />
      )}
      {ready?.excerpt && (
        <figure className="stage-ov-excerpt">
          <blockquote><p>{ready.excerpt}</p></blockquote>
          <figcaption>{text('最近写下的一段', 'The latest passage')}</figcaption>
        </figure>
      )}
      <Button variant="primary" size="lg" className="stage-ov-primary" onClick={primary.onClick}>
        {primary.label}
        <ArrowRight size={15} aria-hidden="true" />
      </Button>
      {secondary}
    </section>
  )
}
