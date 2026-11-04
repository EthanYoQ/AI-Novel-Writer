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

  const nextStep = blueprint
    ? text(
        many
          ? `点「${writeLabel}」在原位置重写，定稿后再接着写下一章。`
          : `点「${writeLabel}」在原位置重写。`,
        many
          ? `Choose “${writeLabel}” to rewrite it in place, then continue with the next one after finalizing.`
          : `Choose “${writeLabel}” to rewrite it in place.`,
      )
    : text(
        `这一章的蓝图也没有了，先点「${addLabel}」填好并保存，再写这一章。`,
        `Its blueprint is gone too. Choose “${addLabel}”, fill it in and save, then write the chapter.`,
      )

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
      {text(`后面的正文都还在，照常可写。这里没有删除记录，可能是旧版「小说拆解与仿写」误导入的参考原文。只是缺这一章时，${nextStep}确认后面都是误导入的原文时，才用「清除误导入正文…」，它会清掉全书所有草稿和定稿。`,
        `Later text is untouched and stays writable. There is no deletion record here, so this may be reference text imported by mistake by the old “Novel breakdown & imitation”. If only this chapter is missing: ${nextStep} Use “Clear imported text…” only if the later text was imported by mistake; it clears every draft and finalized chapter in the book.`)}
    </Notice>
  )
}
