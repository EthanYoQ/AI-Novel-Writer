import type { ReplacementImpact } from '../../../shared/chapter-reopen'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { useReplacementImpacts } from './use-replacement-impacts'

type Text = (zh: string, en: string) => string

/** 章号列成区间：3、5、6、7 → 3、5–7。 */
function ranges(chapters: readonly number[]): string[] {
  const parts: string[] = []
  for (let start = 0; start < chapters.length;) {
    let end = start
    while (end + 1 < chapters.length && chapters[end + 1] === chapters[end]! + 1) end++
    parts.push(start === end ? String(chapters[start]) : `${chapters[start]}–${chapters[end]}`)
    start = end + 1
  }
  return parts
}

const chaptersText = (chapters: readonly number[], text: Text) => text(
  `第 ${ranges(chapters).join('、')} 章`,
  `${chapters.length === 1 ? 'Chapter' : 'Chapters'} ${ranges(chapters).join(', ')}`,
)

const hasImpact = (impact: ReplacementImpact) => impact.laterChapters.length > 0 || impact.blueprintOnlyChapters.length > 0
  || impact.characters.length > 0 || impact.unmovedConfirmations.length > 0

/** 替换对后续内容的影响：受影响的章、状态来自后续章的角色、不再计入线索进度的确认。定稿确认框的预览与定稿后的提示共用。 */
export function ReplacementImpactSummary({ impact }: { impact: ReplacementImpact }) {
  const text = useLocaleStore(s => s.text)
  const { laterChapters: later, blueprintOnlyChapters: planned, characters, unmovedConfirmations: unmoved } = impact
  const chapterParts = [
    later.length > 0 && text(`${chaptersText(later, text)}写于这次修改之前`, `${chaptersText(later, text)} ${later.length === 1 ? 'was' : 'were'} written before this change`),
    planned.length > 0 && text(`${chaptersText(planned, text)}只有蓝图`, `${chaptersText(planned, text)} ${planned.length === 1 ? 'only has a blueprint' : 'only have blueprints'}`),
  ].filter(Boolean)
  return (
    <>
      {chapterParts.length > 0 && (
        <p>{text(`${chapterParts.join('，')}，可能和新内容不符，不会自动修改。`, `${chapterParts.join('. ')}. They may not match the new text and are not changed automatically.`)}</p>
      )}
      {characters.length > 0 && (
        <p>{text(`${characters.join('、')}的当前状态来自后续章节，没有按新内容重算。`, `The current state of ${characters.join(', ')} comes from later chapters and was not recalculated from the new text.`)}</p>
      )}
      {unmoved.length > 0 && (
        <>
          <p>{text('这些线索确认的证据已不在新正文里，不再计入线索进度：', 'The evidence for these thread confirmations is no longer in the new text, so they no longer count toward thread progress:')}</p>
          {unmoved.map((confirmation, index) => (
            <p key={index}>{text(`「${confirmation.threadTitle}」：${confirmation.evidence}`, `“${confirmation.threadTitle}”: ${confirmation.evidence}`)}</p>
          ))}
        </>
      )}
    </>
  )
}

/** 定稿确认框里的影响预览；后面没有受影响的内容时不显示。 */
export function ReplacementImpactPreview({ impact }: { impact: ReplacementImpact | null }) {
  const text = useLocaleStore(s => s.text)
  if (!impact || !hasImpact(impact)) return null
  return (
    <Notice tone="warn" title={text('后面的内容不会跟着改', 'Later content is not changed')}>
      <ReplacementImpactSummary impact={impact} />
    </Notice>
  )
}

/**
 * 替换影响提示（ADR-0024）。showOwn 时，这一章的当前定稿是重开稿替换来的，顶部提示「第 N 章已修改」并列出影响；
 * 这一章写于更早一章修改之前时，显示一行「写于第 N 章修改之前」，链回那一章。点了「知道了」两处一起不再显示。
 */
export default function ReplacementImpactNotices({ projectKey, chapterNumber, showOwn }: { projectKey: string; chapterNumber: number; showOwn: boolean }) {
  const text = useLocaleStore(s => s.text)
  const { impacts, acknowledge } = useReplacementImpacts(projectKey)
  const own = showOwn ? impacts.find(impact => impact.chapterNumber === chapterNumber) : undefined
  const earlier = impacts.filter(impact => impact.laterChapters.includes(chapterNumber) || impact.blueprintOnlyChapters.includes(chapterNumber))
  const firstLater = own?.laterChapters[0]
  return (
    <>
      {own && (
        <Notice
          tone="warn"
          title={text(`第 ${chapterNumber} 章已修改`, `Chapter ${chapterNumber} was changed`)}
          actions={(
            <>
              <Button variant="secondary" size="sm" onClick={() => acknowledge(own.finalizationId!)}>{text('知道了', 'Got it')}</Button>
              {firstLater !== undefined && (
                <Button variant="text" size="sm" onClick={() => navigate({ kind: 'chapter', chapterNumber: firstLater })}>
                  {text(`打开第 ${firstLater} 章`, `Open chapter ${firstLater}`)}
                </Button>
              )}
            </>
          )}
        >
          <ReplacementImpactSummary impact={own} />
        </Notice>
      )}
      {earlier.map(impact => {
        const planned = impact.blueprintOnlyChapters.includes(chapterNumber)
        return (
          <Notice
            key={impact.finalizationId}
            tone="info"
            title={planned
              ? text(`蓝图写于第 ${impact.chapterNumber} 章修改之前`, `Blueprint written before chapter ${impact.chapterNumber} was changed`)
              : text(`写于第 ${impact.chapterNumber} 章修改之前`, `Written before chapter ${impact.chapterNumber} was changed`)}
            actions={(
              <Button variant="text" size="sm" onClick={() => navigate({ kind: 'chapter', chapterNumber: impact.chapterNumber })}>
                {text(`打开第 ${impact.chapterNumber} 章`, `Open chapter ${impact.chapterNumber}`)}
              </Button>
            )}
          >
            {planned
              ? text(`第 ${impact.chapterNumber} 章后来改过，这一章的蓝图可能和它不符，不会自动修改。`, `Chapter ${impact.chapterNumber} changed afterwards, so this chapter's blueprint may not match it. It is not changed automatically.`)
              : text(`第 ${impact.chapterNumber} 章后来改过，这一章可能和它不符，不会自动修改。`, `Chapter ${impact.chapterNumber} changed afterwards, so this chapter may not match it. Nothing here is changed automatically.`)}
          </Notice>
        )
      })}
    </>
  )
}
