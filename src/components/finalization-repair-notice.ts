import type { DuplicateFinalizationRepair } from '../shared/finalization-repair'
import { useLocaleStore } from '../stores/locale-store'
import { openInkPrompt } from './ui/InkPrompt'

type Text = (zh: string, en: string) => string

export function finalizationRepairMessage(repair: DuplicateFinalizationRepair, text: Text): string {
  const chapters = repair.chapters.map(chapter => {
    const versions = chapter.superseded.map(item => `v${item.version}`).join(text('、', ', '))
    const leftovers = chapter.superseded.flatMap(item => [
      ...(item.knowledgeDocumentId ? [text(`知识库文档 ${item.knowledgeDocumentId}`, `knowledge document ${item.knowledgeDocumentId}`)] : []),
      ...(item.targetFileName ? [text(`实体稿 ${item.targetFileName}`, `manuscript file ${item.targetFileName}`)] : []),
    ])
    const head = text(
      `第 ${chapter.chapterNumber} 章：保留 v${chapter.keptVersion} 作为定稿，${versions} 改为「已被替换的定稿」。`,
      `Chapter ${chapter.chapterNumber}: kept v${chapter.keptVersion} as the final version; ${versions} became replaced finals.`,
    )
    return leftovers.length === 0
      ? head
      : `${head}\n${text('旧定稿留下的文件：', 'Files left by the replaced finals: ')}${leftovers.join(text('；', '; '))}`
  })
  return [
    text(
      '这部作品有章节存着不止一份定稿（旧版本「回退到此版本」后再定稿留下的），后面的章节因此写不了。已经修好：',
      'Some chapters had more than one final version (left by refinalizing after “Restore this version” in an older release), which blocked writing later chapters. This is now fixed:',
    ),
    ...chapters,
    text(
      '旧定稿的正文仍在版本历史里。它留下的知识库文档和实体稿没有自动删除，可以在知识库与正文目录里自行清理。',
      'The replaced text is still in version history. Its knowledge documents and manuscript files were not deleted; you can remove them from the knowledge base and manuscript folder.',
    ),
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
