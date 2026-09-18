import { syntaxTree } from '@codemirror/language'
import { EditorState, Facet, Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/**
 * CodeMirror 实时预览 —— 把 markdown 源码编辑成「成书纸页」。
 *
 * 目标（先生的要求）：编辑正文时**不再看到 markdown 标记**，直接看到排版效果。
 *
 * 做法：借助 markdown 语法树，把纯标记字符（#、**、-、> 等）用 Decoration.replace
 * 从视图里抹掉，只留下渲染后的排版；同时给标题、引用、列表、强调打上语义类，
 * 由 CSS 呈现成书样式（楷体大标题、朱砂竖线引用、圆点列表…）。
 *
 * 两条重要的工程取舍：
 * 1. **光标所在行照常显示标记**。这是 Typora 一类的通行做法：若把标记全藏起来，
 *    作者就无法判断标题级别、也无法直接修改强调符号。"看不见标记"针对的是
 *    阅读态，而不是正在落笔的那一行。
 * 2. **只处理可视范围**（view.visibleRanges）。语法树遍历成本与文档长度相关，
 *    长篇小说动辄数十万字，全量遍历会拖垮输入响应。
 *
 * 隐藏区用 atomicRanges 声明，光标会整体跳过被隐藏的标记，不会停在标记中间。
 */

/** 纸页页眉数据：章节名 + 「书名 · 第 N 章」。 */
export interface PaperHead {
  title: string
  subtitle: string
}

/**
 * 纸页页眉用 Facet 递进扩展，避免把编辑器组件与项目 store 耦合在一起。
 * 未提供时页眉整体不渲染。
 */
export const paperHeadFacet = Facet.define<PaperHead | null, PaperHead | null>({
  combine: (values) => values.find((value) => value != null) ?? null,
})

/** 纯标记字符节点：整段抹掉，不留痕迹。 */
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

const strongMark = Decoration.mark({ class: 'cm-lp-strong' })
const emphasisMark = Decoration.mark({ class: 'cm-lp-em' })
const dropcapChar = Decoration.mark({ class: 'cm-lp-dropcap-char' })

function lineDecoration(className: string): Decoration {
  return Decoration.line({ class: className })
}

/**
 * 纸页页眉 widget —— 真实 DOM，因此能同时容纳两行不同字体的标题，
 * 并且随文档一起滚动（这正是伪元素方案做不到的）。
 */
class PaperHeadWidget extends WidgetType {
  constructor(readonly head: PaperHead) {
    super()
  }

  eq(other: PaperHeadWidget): boolean {
    return other.head.title === this.head.title && other.head.subtitle === this.head.subtitle
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-paperhead'
    const title = document.createElement('h2')
    title.textContent = this.head.title
    wrap.appendChild(title)
    if (this.head.subtitle) {
      const subtitle = document.createElement('div')
      subtitle.className = 'cm-lp-paperhead-sub'
      subtitle.textContent = this.head.subtitle
      wrap.appendChild(subtitle)
    }
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

interface PendingDecoration {
  from: number
  to: number
  deco: Decoration
}

/**
 * 全文第一个**正文段落**的行号：跳过标题、引用与列表行，
 * 让首字下沉正好落在页眉下方的第一段正文上（先生验收时指出的问题）。
 */
export function firstParagraphLine(doc: Text, minLine = 1): number | null {
  // minLine 由调用方给出：页眉 widget 占住文档第 1 行行首，
  // 若首字下沉落在同一行，::first-letter 取到的会是页眉里的章节名首字。
  for (let lineNo = minLine; lineNo <= doc.lines; lineNo += 1) {
    // 跳过标题 / 引用 / 列表行，让首字下沉落在标题下方的第一段正文上
    const text = doc.line(lineNo).text
    if (isPlainParagraph(text)) return lineNo
  }
  return null
}

/**
 * 该行是否像**章节标题**。
 *
 * 草稿的标题不一定带 `#`：实测正文首行常是「第 6 章 装敛疑云」这样的纯文本标题。
 * 若只认 markdown 标记，首字下沉就会落到标题上 —— 这正是先生两次验收
 * 都看到「标题第一个字是朱砂大字」的原因。
 */
function looksLikeHeading(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // markdown 标题
  if (/^#{1,6}\s/.test(trimmed)) return true
  // 「第 6 章 …」「第十二回 …」这类中文章回标题
  if (/^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷部篇]/.test(trimmed)) return true
  return false
}

/// 该行是否是普通正文段落（标题 / 引用 / 列表行都不算）。
function isPlainParagraph(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (looksLikeHeading(trimmed)) return false
  if (/^(>|[-*+]\s|\d+\.\s)/.test(trimmed)) return false
  return true
}

/**
 * 首字下沉的作用范围：该段第一个**可见实义字符**的区间。
 *
 * 单独抽成纯函数并导出，是为了能单测 —— 中文段落常以全角空格或 em 空格
 * 起笔（产品的 Tab 键插入两个 em 空格做缩进），落点必须跳过这些空白，
 * 否则朱砂会落在看不见的空格上。
 *
 * 先生的要求：段落若以标点起笔（「他说……」「（一）……」），标点不该被放大，
 * 要让第一个**非标点**的实义字符成为朱砂首字。因此这里连续跳过
 * 空白 → 标点/符号 → 空白，落在真正的第一个字上。
 */
export function resolveDropcapRange(
  doc: Text,
  minLine: number,
): { from: number; to: number } | null {
  const lineNo = firstParagraphLine(doc, minLine)
  if (lineNo === null) return null
  const line = doc.line(lineNo)
  const text = line.text

  // \p{P} 标点（含中文引号 、书名号、省略号）与 \p{S} 符号（含 ￥ ° ± 等）
  const isPunctuationOrSymbol = (char: string) => /[\p{P}\p{S}]/u.test(char)
  const isBlank = (char: string) => /\s|\u2003|\u3000/u.test(char)

  let index = 0
  // 前导空白 → 标点（可能夹着空白，如「  ——  」）→ 再空白，直到实义字符
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    if (!isBlank(char) && !isPunctuationOrSymbol(char)) break
    index += char.length
  }
  // 整行都是标点/空白时不做首字下沉，避免把标点或空白染成朱砂
  if (index >= text.length) return null

  const code = text.codePointAt(index) ?? 0
  const from = line.from + index
  const to = Math.min(from + (code > 0xffff ? 2 : 1), line.to)
  return { from, to }
}

function toDecorationSet(items: readonly PendingDecoration[]): DecorationSet {
  // Decoration.set(ranges, true) 会自行排序并合并，比 RangeSetBuilder 更能容忍
  //「同一位置既加行装饰又加标记装饰」的情况
  return Decoration.set(
    items.map((item) => item.deco.range(item.from, item.to)),
    true,
  )
}

/**
 * 先生（编辑器可用性事故）：光标无法选字、拖动变成拖整行。
 *
 * 根因就在 atomicRanges 的取值上 —— 它必须**只**包含被抹掉的 markdown 标记
 * （Decoration.replace），而不是全部装饰。此前把 decorations 整个塞进去，于是：
 *   · StrongEmphasis / Emphasis 的每个字都成了「不可跨越的原子块」，鼠标拖选
 *     经过强调文本时选区被整块吸附，选不中想选的字符；
 *   · 首字下沉的朱砂字同样不可选；
 *   · 行装饰（Decoration.line）的范围是零长度，作为原子范围会把光标/选区
 *     钉在行首，拖动直接表现为「整行位移」。
 * 这里把「视图装饰」与「原子范围」拆成两份集合：前者照旧承载排版，
 * 后者严格只装 hidden，恢复正常的选字、复制与拖动行为。
 */
function buildDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): { decorations: DecorationSet; atomic: DecorationSet } {
  const pending: PendingDecoration[] = []
  /** 只收被抹掉的标记，供 atomicRanges 使用。 */
  const hiddenRanges: PendingDecoration[] = []
  const cursorLine = state.doc.lineAt(state.selection.main.head).number
  const tree = syntaxTree(state)

  // ===== 纸页页眉：真实 DOM widget，随正文滚动 =====
  const head = state.facet(paperHeadFacet)
  if (head) {
    pending.push({
      from: 0,
      to: 0,
      deco: Decoration.widget({ widget: new PaperHeadWidget(head), side: -1 }),
    })
  }

  // ===== 首字下沉：只作用于全文第一个正文段落（与 demo 的 .dropcap 语义一致）=====
  // 页眉是读取渲染的内容，不参与朱砂首字；有页眉时从第 2 行起找正文段落
  // ===== 首字下沉：落在标题下方的第一个正文段落 =====
  // 刻意不用 ::first-letter —— 中文段落常以全角空格或 em 空格起笔（产品的
  // Tab 键就插入两个 em 空格做缩进），::first-letter 会把缩进空白当作
  // 「首字母」，朱砂于是落在空白上、肉眼看不见。这里直接定位该行第一个
  // **可见字符**给它打标记，从根上绕开这个问题。
  // 首字下沉：范围由 resolveDropcapRange 计算（已单测覆盖）
  // 从第 1 行找起：草稿正文里并不含标题行（标题由 meta.chapterTitle 提供、
  // 由页眉渲染），所以第一段就在第 1 行。此前为躲开行内的页眉 widget 而
  // 硬性从第 2 行起找，恰好把第一段整段跳过 —— 这正是先生看到的
  // 「第二段的字被渲染、第一段反而没有」。改用字符标记后已无需躲避。
  const dropcapRange = resolveDropcapRange(state.doc, 1)
  if (dropcapRange) {
    pending.push({ from: dropcapRange.from, to: dropcapRange.to, deco: dropcapChar })
  }

  // ===== 首行若是 markdown 标题，与纸页页眉重复，折叠掉 =====
  // 页眉已经呈现「章节名 + 书名 · 第 N 章」；正文里再出现一行
  // `# 第 6 章 装敛疑云` 等于同一件事说两遍。光标回到首行时照常显示，便于修改。
  const openingLine = state.doc.line(1)
  if (
    looksLikeHeading(openingLine.text)
    && state.doc.lineAt(state.selection.main.head).number !== 1
  ) {
    const spec = { from: openingLine.from, to: openingLine.to, deco: hidden }
    pending.push(spec)
    hiddenRanges.push(spec)
  }

  // ===== 可视范围内的标记隐藏与排版装饰 =====
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name
        const lineNumber = state.doc.lineAt(node.from).number
        const onCursorLine = lineNumber === cursorLine

        if (MARK_NODES.has(name)) {
          // 光标所在行保留标记，便于作者直接编辑语法
          if (!onCursorLine && node.to > node.from) {
            const spec = { from: node.from, to: node.to, deco: hidden }
            pending.push(spec)
            hiddenRanges.push(spec)
          }
          return
        }

        const heading = /^ATXHeading([1-6])$/.exec(name)
        if (heading) {
          pending.push({
            from: node.from,
            to: node.from,
            deco: lineDecoration(`cm-lp-h cm-lp-h${heading[1]}`),
          })
          return
        }

        if (name === 'StrongEmphasis') {
          pending.push({ from: node.from, to: node.to, deco: strongMark })
          return
        }

        if (name === 'Emphasis') {
          pending.push({ from: node.from, to: node.to, deco: emphasisMark })
          return
        }

        if (name === 'Blockquote') {
          let position = node.from
          while (position <= node.to) {
            const line = state.doc.lineAt(position)
            pending.push({ from: line.from, to: line.from, deco: lineDecoration('cm-lp-quote') })
            if (line.to >= node.to) break
            position = line.to + 1
          }
          return
        }

        if (name === 'ListItem') {
          const line = state.doc.lineAt(node.from)
          pending.push({ from: line.from, to: line.from, deco: lineDecoration('cm-lp-li') })
        }
      },
    })
  }

  // ===== 段首缩进字符：隐掉，缩进统一由 CSS 恒定提供 =====
  // 先生：段落要空两格，且打字时整行不能抖。CSS 已经无条件给了 text-indent:2em
  // （空行也给，这样敲下第一个字时不会跳变）。如果行内再用 Tab 敲出缩进字符，
  // 两份缩进会叠成四格 —— 所以这里把**行首的缩进空白字符**当标记一样隐藏掉，
  // 与 markdown 标记同等对待：留在文档里、不参与显示，光标落在该行时照常显示
  // 以便作者编辑（与上面 # 号的处理一致）。
  //
  // ⚠️ 但**空行必须除外**（先生：「enter 之后没正确落到位置，输入一下才到位」）。
  // 原因：空行没有缩进字符时会被渲染成 `<div class="cm-line"><br></div>`，
  // 而 CSS 的 `text-indent: 2em` 仍然把这一行推到缩进位 ——
  // 于是**光标停在行左缘，视觉内容却在缩进位**，两者差一整格（实测 112px vs 202px）。
  // 作者敲下第一个字时缩进字符才显示、光标才「跳到位」，体感就是「没落准」。
  // 而空行本来就没有可隐藏的 markdown 标记，隐藏它纯属副作用 —— 故直接跳过。
  //
  // 补充（先生第二次报同一句现象时查清）：上面只是横向那一半。真正的大头在纵向 ——
  //   CodeMirror 把光标锚在**内容盒（line box）的垂直中心**上，而 v2 皮肤曾用
  //   `line-height: 0.7` 压缩空行，内容盒跟着变矮，光标就浮到段间距当中（实测偏 13px）。
  //   已改为「内容盒保持正文行高、只压行块 height」，见 v2-editor.css 的空行规则。
  //   本文件这一条（空行不隐藏缩进）依然必要：它守的是横向落点。
  for (const range of ranges) {
    const firstLine = state.doc.lineAt(range.from).number
    const lastLine = state.doc.lineAt(range.to).number
    for (let lineNo = firstLine; lineNo <= lastLine; lineNo += 1) {
      const line = state.doc.line(lineNo)
      // 空行不参与隐藏：没有标记可藏，藏了只会让光标与视觉落点错位
      if (!line.text.trim()) continue
      if (!isPlainParagraph(line.text)) continue
      if (lineNo === cursorLine) continue
      const leading = /^[\s\u2003\u3000]+/.exec(line.text)?.[0].length ?? 0
      if (leading === 0) continue
      const spec = { from: line.from, to: line.from + leading, deco: hidden }
      pending.push(spec)
      hiddenRanges.push(spec)
    }
  }

  // ===== 光标所在的空行：提前展开成完整行高 =====
  // 先生（第三次报障）：「enter 之后光标位置对了，但一打字，下方文字段落又自动下沉 5px 左右。」
  // 根因：v2 皮肤把空行压到 1.2em（约 20px）、正文行 38px —— 在空行里敲下第一个字的那一刻，
  //   这一行由矮变高，**它下面的所有内容被整体推下去 18.1px**（实测）。
  // CSS 无从知道「光标在哪一行」，所以在这里按光标所在行打标，让这一行在光标落上去时就先展开：
  //   位移因此被提前到「光标落到这一行」（按 Enter、点进空行）那一刻 ——
  //   那本来就是作者主动插入内容的时刻，版面变化符合预期；而**打字时不再有任何位移**。
  // 对应的样式是 v2-editor.css 的 `.cm-line.cm-lp-caret-empty`。
  if (cursorLine <= state.doc.lines) {
    const caretLine = state.doc.line(cursorLine)
    if (!caretLine.text.trim()) {
      pending.push({
        from: caretLine.from,
        to: caretLine.from,
        deco: lineDecoration('cm-lp-caret-empty'),
      })
    }
  }

  return { decorations: toDecorationSet(pending), atomic: toDecorationSet(hiddenRanges) }
}

/** 实时预览扩展。未加载 markdown 语法树时语法树为空，本扩展自动退化为无操作。 */
export function livePreview() {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      /** 仅被抹掉的标记：原子范围只能收这个，否则会吃掉正常的选字与拖动。 */
      atomic: DecorationSet
      /** 上次构建时游标所在行：标记显隐以行为单位，只有换行才需要重算。 */
      cursorLine: number
      /** 输入法组合期间被推迟的重建。 */
      pendingRebuild: boolean

      constructor(view: EditorView) {
        const built = buildDecorations(view.state, view.visibleRanges)
        this.decorations = built.decorations
        this.atomic = built.atomic
        this.cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number
        this.pendingRebuild = false
      }

      update(update: ViewUpdate) {
        // 先生（标点重复上屏）：输入法组合期间绝不动 DOM。
        // 中文标点是在 composing 状态下上屏的，此时替换装饰会打断组合过程，
        // 一次按键可能落成多个标点。先记账，等组合结束后的那次 update 再补。
        if (update.view.composing) {
          this.pendingRebuild = true
          return
        }

        const nextCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number
        const cursorLineChanged = nextCursorLine !== this.cursorLine
        // selectionSet 不必次次重建：装饰只依赖「光标在第几行」，同一次敲字
        // 光标不换行时装饰完全一样。省掉这一趟能让长文打字明显更跟手。
        if (
          !update.docChanged
          && !update.viewportChanged
          && !cursorLineChanged
          && !this.pendingRebuild
        ) return

        const built = buildDecorations(update.state, update.view.visibleRanges)
        this.decorations = built.decorations
        this.atomic = built.atomic
        this.cursorLine = nextCursorLine
        this.pendingRebuild = false
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  )

  return [
    plugin,
    // 让光标整体跳过被隐藏的标记字符
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  ]
}
