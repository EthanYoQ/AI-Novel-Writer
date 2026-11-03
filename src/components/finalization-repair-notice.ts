import type { DuplicateFinalizationRepair } from '../shared/finalization-repair'
import { pluralEn } from '../shared/plural-en'
import { useLocaleStore } from '../stores/locale-store'
import { openInkPrompt } from './ui/InkPrompt'

type Text = (zh: string, en: string) => string

export function finalizationRepairMessage(repair: DuplicateFinalizationRepair, text: Text): string {
  const chapters = repair.chapters.map(chapter => {
    const replaced = pluralEn(chapter.superseded.length, 'replaced final')
    const versions = chapter.superseded.map(item => `v${item.version}`).join(text('、', ', '))
    const files = chapter.superseded.map(item => item.targetFileName).filter(Boolean)
    const lines = [text(
      `第 ${chapter.chapterNumber} 章：保留 v${chapter.keptVersion} 作为定稿，${versions} 改为「已被替换的定稿」。`,
      `Chapter ${chapter.chapterNumber}: kept v${chapter.keptVersion} as the final version; ${versions} became ${chapter.superseded.length === 1 ? 'a ' : ''}${replaced}.`,
    )]
    if (chapter.superseded.some(item => item.knowledgeDocumentId)) {
      lines.push(text(
        '这一章旧定稿的内容还留在知识库里，目前不能单独删除。',
        `Text from this chapter's ${replaced} is still in the knowledge base and can't be removed on its own yet.`,
      ))
    }
    if (files.length > 0) {
      lines.push(text('旧定稿留下的实体稿：', `Manuscript ${pluralEn(files.length, 'file')} left by the ${replaced}: `) + files.join(text('；', '; ')))
    }
    return lines.join('\n')
  })
  return [
    text(
      '这部作品有章节存着不止一份定稿（旧版本「回退到此版本…」后再定稿留下的），后面的章节因此写不了。已经修好：',
      'Some chapters had more than one final version (left by refinalizing after “Revert to this version…” in an older release), which blocked writing later chapters. This is now fixed:',
    ),
    ...chapters,
    repair.chapters.some(chapter => chapter.superseded.some(item => item.targetFileName))
      ? text(
        '旧定稿的正文仍在版本历史里。它留下的实体稿没有自动删除，可以在正文目录里自行删除。',
        'The replaced text is still in version history. Its manuscript files were not deleted; you can delete them from the manuscript folder.',
      )
      : text('旧定稿的正文仍在版本历史里。', 'The replaced text is still in version history.'),
  ].join('\n\n')
}

export function showFinalizationRepairNotice(repair: DuplicateFinalizationRepair): void {
  if (repair.chapters.length === 0) return
  const text = useLocaleStore.getState().text
  void openInkPrompt({
    kind: 'notice',
    title: text('已修复重复的定稿', 'Duplicate final versions repaired'),
    message: finalizationRepairMessage(repair, text),
    confirmText: text('知道了', 'Got it'),
  })
}
