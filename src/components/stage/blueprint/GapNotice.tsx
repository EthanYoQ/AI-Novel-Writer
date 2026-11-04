import type { ReactNode } from 'react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import type { ChapterGap } from '../../../shared/chapter-sequence'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'

export default function GapNotice({ gap, blueprint, onWrite, onAddBlueprint, clearAction }: {
  gap: ChapterGap
  blueprint: ChapterBlueprint | null
  onWrite: (blueprint: ChapterBlueprint) => void
  onAddBlueprint: (chapterNumber: number) => void
  clearAction?: ReactNode
}) {
  const text = useLocaleStore(s => s.text)
  const head = gap.from
  const many = gap.to > gap.from
  const zhRange = many ? `第 ${gap.from}～${gap.to} 章` : `第 ${head} 章`
  const enRange = many ? `Chapters ${gap.from}–${gap.to}` : `Chapter ${head}`
  const writeLabel = text(`写第 ${head} 章`, `Write chapter ${head}`)
  const addLabel = text(`补上第 ${head} 章蓝图`, `Add chapter ${head} blueprint`)

  // 段内只有第一章能写：写作前置检查要求前一章已定稿。
  const order = many
    ? text(`要从第 ${head} 章起逐章写，前一章定稿后才能写下一章。`,
        `Write them one at a time from Chapter ${head}; each opens once the one before it is finalized. `)
    : ''
  const nextStep = order + (blueprint
    ? text(`点「${writeLabel}」在原位置重写。`, `Choose “${writeLabel}” to rewrite it in place.`)
    : text(
        `第 ${head} 章的蓝图也没有了，先点「${addLabel}」填好并保存，再写这一章。`,
        `Chapter ${head}’s blueprint is gone too. Choose “${addLabel}”, fill it in and save, then write it.`,
      ))

  const actions = (
    <>
      {blueprint
        ? <Button variant="secondary" size="sm" onClick={() => onWrite(blueprint)}>{writeLabel}</Button>
        : <Button variant="secondary" size="sm" onClick={() => onAddBlueprint(head)}>{addLabel}</Button>}
      {clearAction}
    </>
  )

  if (gap.cause === 'deleted') {
    return (
      <Notice tone="info" title={text(`${zhRange}的正文已删除`, `${enRange} ${many ? 'were' : 'was'} deleted`)} actions={actions}>
        {text(`后面的章节都还在，照常可写。删掉的正文找不回来，${nextStep}`,
          `Later chapters are untouched and stay writable. The deleted text cannot be recovered. ${nextStep}`)}
      </Notice>
    )
  }
  return (
    <Notice tone="warn" title={text(`${zhRange}还没写，后面却已有正文`, `${enRange} ${many ? 'are' : 'is'} unwritten, but later chapters have text`)} actions={actions}>
      {text(`后面的正文都还在，照常可写。这里没有删除记录，可能是旧版「小说拆解与仿写」误导入的参考原文。只是缺${many ? '这几章' : '这一章'}时，${nextStep}确认后面都是误导入的原文时，才用「清除误导入正文…」，它会清掉全书所有草稿和定稿。`,
        `Later text is untouched and stays writable. There is no deletion record here, so this may be reference text imported by mistake by the old “Novel breakdown & imitation”. If only ${many ? 'these chapters are' : 'this chapter is'} missing: ${nextStep} Use “Clear imported text…” only if the later text was imported by mistake; it clears every draft and finalized chapter in the book.`)}
    </Notice>
  )
}
