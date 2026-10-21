import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

const indented = Decoration.line({ class: 'cm-indent' })
/**
 * 分节线与 # 标题行不是段落：整行只有分节符号与空白、符号至少 3 个（---、* * *、＊＊＊、※※※、◇◆◇、———、·····、～～～ 一类）。
 * 「——他说」这样以符号开头的正文仍是段落。
 */
const NOT_PARAGRAPH = /^(?:#{1,6}\s|(?:[-*_＊※◇◆○●—·~～]\s*){3,}$)/

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position)
      if (/^\S/.test(line.text) && !NOT_PARAGRAPH.test(line.text)) builder.add(line.from, line.from, indented)
      position = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * 段落首行缩进两字只是显示：给以文字开头的行加 cm-indent，由样式缩进，正文内容不变。
 * 已经以空格开头的行（作者用 Tab 插入了 em 空格，F-188）不再叠加一次；分节线与标题行不缩进。
 */
export const paragraphIndent = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = build(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
  }
}, { decorations: plugin => plugin.decorations })
