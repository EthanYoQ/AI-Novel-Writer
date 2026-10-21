import type { ReactNode } from 'react'
import { chapterLabel } from '../../../shared/chapter-label'
import { getChapterRoleLabels } from '../../../shared/chapter-role'
import { useLocaleStore } from '../../../stores/locale-store'
import { Lifecycle } from '../../ui/Lifecycle'

/** 章节头：大号章号、「第 N 章 · 定位」、标题与右侧的版本切换器，下面是生命周期条。沉浸写作时只留标题。 */
export default function ChapterHead({ chapterNumber, role, title, version, step, focus }: {
  chapterNumber: number
  role?: string
  title: string
  version: ReactNode
  step: number | null
  focus: boolean
}) {
  const text = useLocaleStore(s => s.text)
  const roleLabels = getChapterRoleLabels(role)
  const roleText = roleLabels ? text(roleLabels.zhCN, roleLabels.enUS) : role
  return (
    <header className="stage-ch-head">
      {!focus && (
        <div className="stage-ch-kicker">
          <span className="stage-ch-numeral" aria-hidden="true">{chapterNumber}</span>
          <span className="stage-ch-eyebrow">{roleText ? `${chapterLabel(chapterNumber, text)} · ${roleText}` : chapterLabel(chapterNumber, text)}</span>
        </div>
      )}
      <div className="stage-ch-titlerow">
        <h1 className="stage-ch-title">{title || chapterLabel(chapterNumber, text)}</h1>
        {version}
      </div>
      {!focus && step !== null && (
        <Lifecycle label={text(`第 ${chapterNumber} 章进度`, `Chapter ${chapterNumber} progress`)} steps={[text('写作', 'Write'), text('审稿', 'Review'), text('修稿', 'Revise'), text('定稿', 'Finalize')]} current={step} />
      )}
    </header>
  )
}

