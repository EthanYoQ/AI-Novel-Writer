import { syntaxTree } from '@codemirror/language'
import { EditorState, Facet, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

export type PaperHead = {
  title: string
  subtitle?: string
}

export const paperHeadFacet = Facet.define<PaperHead | null, PaperHead | null>({
  combine: values => values.find(value => value !== null) ?? null,
})

const MARK_NODES = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'ListMark',
  'QuoteMark',
  'LinkMark',
  'StrikethroughMark',
])

const hidden = Decoration.replace({})
const strong = Decoration.mark({ class: 'cm-lp-strong' })
const emphasis = Decoration.mark({ class: 'cm-lp-em' })
const dropcap = Decoration.mark({ class: 'cm-lp-dropcap-char' })
const DROPCAP_PREFIX_LIMIT = 16_384

class PaperHeadWidget extends WidgetType {
  constructor(readonly head: PaperHead) {
    super()
  }

  eq(other: PaperHeadWidget): boolean {
    return other.head.title === this.head.title && other.head.subtitle === this.head.subtitle
  }

  toDOM(): HTMLElement {
    const element = document.createElement('header')
    element.className = 'cm-lp-paperhead'
    const title = document.createElement('h2')
    title.textContent = this.head.title
    element.append(title)
    if (this.head.subtitle) {
      const subtitle = document.createElement('div')
      subtitle.className = 'cm-lp-paperhead-sub'
      subtitle.textContent = this.head.subtitle
      element.append(subtitle)
    }
    return element
  }

  ignoreEvent(): boolean {
    return false
  }
}

type PendingDecoration = {
  from: number
  to: number
  decoration: Decoration
}

function decorationSet(items: readonly PendingDecoration[]): DecorationSet {
  return Decoration.set(items.map(item => item.decoration.range(item.from, item.to)), true)
}

function isBodyParagraph(text: string): boolean {
  const value = text.trim()
  return value.length > 0
    && !/^#{1,6}\s/.test(value)
    && !/^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷部篇]/.test(value)
    && !/^(>|[-*+]\s|\d+\.\s)/.test(value)
}

function dropcapRange(doc: Text): { from: number; to: number } | null {
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber)
    if (line.from >= DROPCAP_PREFIX_LIMIT) break
    const text = doc.sliceString(line.from, Math.min(line.to, DROPCAP_PREFIX_LIMIT))
    if (!isBodyParagraph(text)) continue
    let offset = 0
    const limit = text.length
    while (offset < limit) {
      const character = String.fromCodePoint(text.codePointAt(offset) ?? 0)
      if (!/[\s\p{P}\p{S}]/u.test(character)) {
        return { from: line.from + offset, to: line.from + offset + character.length }
      }
      offset += character.length
    }
  }
  return null
}

function buildDecorations(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
  firstBodyCharacter: { from: number; to: number } | null,
): { visible: DecorationSet; atomic: DecorationSet } {
  const pending: PendingDecoration[] = []
  const atomic: PendingDecoration[] = []
  const activeLine = state.doc.lineAt(state.selection.main.head).number
  const head = state.facet(paperHeadFacet)

  if (head) {
    pending.push({
      from: 0,
      to: 0,
      decoration: Decoration.widget({ widget: new PaperHeadWidget(head), side: -1 }),
    })
  }

  if (firstBodyCharacter) {
    pending.push({ ...firstBodyCharacter, decoration: dropcap })
  }

  const tree = syntaxTree(state)
  for (const range of visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: node => {
        const lineNumber = state.doc.lineAt(node.from).number
        if (MARK_NODES.has(node.name)) {
          if (lineNumber !== activeLine && node.to > node.from) {
            const item = { from: node.from, to: node.to, decoration: hidden }
            pending.push(item)
            atomic.push(item)
          }
          return
        }

        const heading = /^ATXHeading([1-6])$/.exec(node.name)
        if (heading) {
          pending.push({
            from: node.from,
            to: node.from,
            decoration: Decoration.line({ class: `cm-lp-h cm-lp-h${heading[1]}` }),
          })
        } else if (node.name === 'StrongEmphasis') {
          pending.push({ from: node.from, to: node.to, decoration: strong })
        } else if (node.name === 'Emphasis') {
          pending.push({ from: node.from, to: node.to, decoration: emphasis })
        }
      },
    })
  }

  return { visible: decorationSet(pending), atomic: decorationSet(atomic) }
}

export function livePreview() {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet
    atomic: DecorationSet
    activeLine: number
    pendingRebuild = false
    firstBodyCharacter: { from: number; to: number } | null

    constructor(view: EditorView) {
      this.firstBodyCharacter = dropcapRange(view.state.doc)
      const built = buildDecorations(view.state, view.visibleRanges, this.firstBodyCharacter)
      this.decorations = built.visible
      this.atomic = built.atomic
      this.activeLine = view.state.doc.lineAt(view.state.selection.main.head).number
    }

    update(update: ViewUpdate) {
      if (update.view.composing) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes)
          this.atomic = this.atomic.map(update.changes)
          if (this.firstBodyCharacter) {
            this.firstBodyCharacter = {
              from: update.changes.mapPos(this.firstBodyCharacter.from),
              to: update.changes.mapPos(this.firstBodyCharacter.to),
            }
          }
        }
        this.pendingRebuild = true
        return
      }

      const nextActiveLine = update.state.doc.lineAt(update.state.selection.main.head).number
      if (
        !update.docChanged
        && !update.viewportChanged
        && nextActiveLine === this.activeLine
        && !this.pendingRebuild
      ) return

      if (this.pendingRebuild && !update.docChanged) {
        this.firstBodyCharacter = dropcapRange(update.state.doc)
      }
      if (update.docChanged) {
        let invalidated = false
        const watchedTo = this.firstBodyCharacter?.to ?? Math.min(update.startState.doc.length, DROPCAP_PREFIX_LIMIT)
        update.changes.iterChangedRanges((fromA) => {
          if (fromA <= watchedTo) invalidated = true
        })
        if (invalidated) {
          // ponytail: only the opening 16 KiB participates in the page drop cap.
          this.firstBodyCharacter = dropcapRange(update.state.doc)
        } else if (this.firstBodyCharacter) {
          this.firstBodyCharacter = {
            from: update.changes.mapPos(this.firstBodyCharacter.from),
            to: update.changes.mapPos(this.firstBodyCharacter.to),
          }
        }
      }

      const built = buildDecorations(update.state, update.view.visibleRanges, this.firstBodyCharacter)
      this.decorations = built.visible
      this.atomic = built.atomic
      this.activeLine = nextActiveLine
      this.pendingRebuild = false
    }
  }, {
    decorations: value => value.decorations,
  })

  return [
    plugin,
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? Decoration.none),
    EditorView.domEventHandlers({
      compositionend: (_event, view) => {
        queueMicrotask(() => {
          if (view.dom.isConnected) view.dispatch({})
        })
        return false
      },
    }),
  ]
}
